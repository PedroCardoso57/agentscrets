#!/usr/bin/env node
// Servidor do escritório: serve a página, recebe status dos seus motores e
// entrega a eles as ordens que você dá pelo seu bonequinho de chefe.
// Sem dependências — só Node 18+.
//
//   node servidor.js            → http://localhost:8787
//   PORTA=3000 node servidor.js     (também lê PORT, usado por Render/Railway/Fly)
//   HOST=0.0.0.0 ESCRITORIO_SENHA=... node servidor.js   (na rede/internet: senha obrigatória)
//
// Variáveis para rodar 24h num servidor (veja "Deixando no ar 24h" no README):
//   ESCRITORIO_SENHA  senha da página (o navegador pede; qualquer usuário)
//   ESCRITORIO_TOKEN  token dos motores (Authorization: Bearer ...); padrão = a senha
//   DADOS_DIR         pasta onde status e ordens são salvos (padrão ./dados)
//   MOTORES_JSON      conteúdo do motores.json, para hospedagens sem arquivo local
//   MOTORES_ARQUIVO   caminho do motores.json (padrão ./motores.json)
//   DOCUMENTADOR      agente que mantém a documentação viva (padrão: documentador); DOC_INTERVALO_MIN (padrão 3)
//   LAYA_URL          servidor do Laya, que decide o agente das ordens "Automático" (ex.: http://laya:8000)
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY   chaves das IAs dos motores embutidos
//
// Status (motor → escritório):
//   POST /api/status                 {"id":"backend","status":"trabalhando","tarefa":"..."}
//
// Ordens (chefe → motor):
//   POST /api/ordens                 {"para":"backend" | "todos","texto":"..."}      (a página usa)
//   GET  /api/ordens/pendentes?agente=redator   → ordens novas para o motor (marca como entregues)
//   POST /api/ordens/:id/resposta    {"agente":"backend","texto":"Feito!","status":"concluido"}
//   ou configure o agente em motores.json (veja motores.exemplo.json): o próprio
//   servidor chama a IA dele (Claude, OpenAI, Gemini, API compatível) ou um webhook.

import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { criarMotores } from './motores/index.js';
import { criarDecisor } from './motores/decisor.js';
import { criarDocumentacao } from './motores/documentacao.js';
import { criarEntregas } from './motores/entregas.js';
import { criarTelegram } from './motores/telegram.js';
import { criarClientes } from './motores/clientes.js';
import { criarRotinas, ontem } from './motores/rotinas.js';
import { criarSupervisor } from './motores/supervisor.js';
import { criarAutopiloto } from './motores/autopiloto.js';
import { criarRepositorios } from './motores/repositorios.js';
import { criarSaude } from './motores/saude.js';
import { criarTesteIas } from './motores/teste-ias.js';

const RAIZ = fileURLToPath(new URL('.', import.meta.url));
const PORTA = Number(process.env.PORTA || process.env.PORT || 8787);
// em hospedagens (que definem PORT) escuta em todas as interfaces; em casa, só nesta máquina
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const SENHA = process.env.ESCRITORIO_SENHA || '';
const TOKEN = process.env.ESCRITORIO_TOKEN || SENHA;
const DADOS_DIR = process.env.DADOS_DIR || join(RAIZ, 'dados');
const ARQUIVO_DADOS = join(DADOS_DIR, 'escritorio.json');
const SO_LOCAL = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

if (!SO_LOCAL && !SENHA) {
  console.error(`Recusando abrir em ${HOST} sem senha: qualquer pessoa poderia dar ordens às suas IAs.`);
  console.error('Defina ESCRITORIO_SENHA (e, se quiser, ESCRITORIO_TOKEN para os motores).');
  process.exit(1);
}
const STATUS_VALIDOS = ['ocioso', 'trabalhando', 'aguardando', 'concluido', 'erro'];
const MAX_ORDENS = 2000; // ~ semanas de histórico para o relatório
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };

const estado = new Map(); // id → último status recebido
const ordens = [];        // histórico, da mais antiga para a mais nova
const conexoes = new Set(); // páginas abertas recebendo eventos ao vivo

// ---------- acesso ----------

function iguais(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Página: senha via HTTP Basic (o navegador pede uma vez e reaproveita).
// Motores: "Authorization: Bearer <token>" (ou Basic com a senha).
function autorizado(req) {
  if (!SENHA) return true;
  const [tipo, valor = ''] = (req.headers.authorization || '').split(' ');
  if (tipo === 'Bearer') return iguais(valor, TOKEN);
  if (tipo === 'Basic') {
    const decodificado = Buffer.from(valor, 'base64').toString();
    return iguais(decodificado.slice(decodificado.indexOf(':') + 1), SENHA);
  }
  return false;
}

// ---------- dados salvos em disco ----------

let salvarTimer = null;
function agendarSalvar() {
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(salvar, 1000);
}

async function salvar() {
  clearTimeout(salvarTimer);
  try {
    await mkdir(DADOS_DIR, { recursive: true });
    const tmp = `${ARQUIVO_DADOS}.tmp`;
    await writeFile(tmp, JSON.stringify({ estado: [...estado.values()], ordens }));
    await rename(tmp, ARQUIVO_DADOS); // troca atômica: não corrompe se cair no meio
  } catch (erro) {
    console.error('Não consegui salvar os dados:', erro.message);
  }
}

async function carregar() {
  try {
    const dados = JSON.parse(await readFile(ARQUIVO_DADOS, 'utf8'));
    for (const s of dados.estado || []) estado.set(s.id, s);
    ordens.push(...(dados.ordens || []).slice(-MAX_ORDENS));
    console.log(`Dados carregados: ${estado.size} agentes, ${ordens.length} ordens.`);
  } catch (erro) {
    if (erro.code !== 'ENOENT') console.error('Não consegui ler os dados salvos:', erro.message);
  }
}

function enviarJSON(res, codigo, dados) {
  res.writeHead(codigo, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(dados));
}

async function lerCorpo(req) {
  let corpo = '';
  for await (const parte of req) {
    corpo += parte;
    if (corpo.length > 1e6) throw new Error('corpo muito grande');
  }
  return JSON.parse(corpo || '{}');
}

function transmitir(evento, dados) {
  agendarSalvar(); // tudo que é transmitido mudou o estado
  transmitirSemSalvar(evento, dados);
}

// Registro de erros: avisos do supervisor, do GitHub etc. (os erros dos agentes ficam nas próprias ordens)
const avisos = [];
const ARQUIVO_AVISOS = join(DADOS_DIR, 'avisos.json');
readFile(ARQUIVO_AVISOS, 'utf8').then((t) => avisos.push(...JSON.parse(t).slice(-300))).catch(() => {});
function registrarAviso(texto) {
  const aviso = { em: new Date().toISOString(), texto: String(texto).slice(0, 2000) };
  avisos.push(aviso);
  if (avisos.length > 300) avisos.splice(0, avisos.length - 300);
  mkdir(DADOS_DIR, { recursive: true }).then(() => writeFile(ARQUIVO_AVISOS, JSON.stringify(avisos))).catch(() => {});
  transmitirSemSalvar('aviso', aviso);
}

function transmitirSemSalvar(evento, dados) {
  const linha = (evento ? `event: ${evento}\n` : '') + `data: ${JSON.stringify(dados)}\n\n`;
  for (const c of conexoes) c.write(linha);
}

function registrarStatus(item) {
  const novo = { ...estado.get(item.id), ...item, atualizadoEm: new Date().toISOString() };
  estado.set(item.id, novo);
  transmitir(null, novo);
}

// ---------- ordens ----------

const respostaFalhou = (r) => r.erro || /^(Erro:|Interrompida:)/.test(r.texto);

function atualizarOrdem(ordem) {
  if (ordem.cancelada) { ordem.estado = 'cancelada'; transmitir('ordem', ordem); return; }
  // 'falhou': algum destinatário está com a última resposta em erro (o supervisor tenta de novo)
  const comErro = ordem.entregue.some((a) => {
    const dele = ordem.respostas.filter((r) => r.agente === a);
    return dele.length && !dele.some((r) => !respostaFalhou(r));
  });
  ordem.estado = ordem.reexecutando?.length ? 'entregue'
    : comErro ? 'falhou'
      : ordem.respostas.length ? 'respondida' : ordem.entregue.length ? 'entregue' : 'pendente';
  transmitir('ordem', ordem);
}

// Cancelar: o chefe não quer mais a tarefa. Para ela e tudo o que ela gerou (tarefas do
// plano, entrega final, ajustes e revisões de PR): ninguém tenta de novo, nada sobe ao GitHub.
// Quem já estava no meio da resposta termina, mas a resposta só fica guardada.
function cancelarOrdem(id) {
  const raiz = ordens.find((o) => o.id === id);
  if (!raiz) throw new Error('ordem não encontrada');
  const familia = new Set([raiz]);
  for (let mudou = true; mudou;) {
    mudou = false;
    for (const o of ordens) {
      if (familia.has(o)) continue;
      const urls = new Set([...familia].flatMap((f) => f.respostas.map((r) => r.repo?.url).filter(Boolean)));
      const ligada = [...familia].some((f) => o.pai === f.id || o.consolidacao === f.id || o.ajuste?.ordemId === f.id)
        || (o.origem?.revisaoPR && urls.has(o.origem.revisaoPR.url));
      if (ligada) { familia.add(o); mudou = true; }
    }
  }
  const em = new Date().toISOString();
  for (const o of familia) {
    if (o.cancelada) continue;
    Object.assign(o, { cancelada: em, desistida: true, motivoDesistencia: 'cancelada pelo chefe' });
    for (const t of Object.values(o.tentativas || {})) t.proxima = null;
    atualizarOrdem(o);
  }
  // agentes que estavam só na fila dessa ordem voltam a ficar livres na tela
  for (const o of familia) for (const id of o.entregue) if (estado.get(id)?.status !== 'trabalhando' && estado.get(id)?.tarefa === o.texto.slice(0, 140)) registrarStatus({ id, status: 'ocioso', tarefa: '' });
  documentacao?.registrar(`Ordem cancelada pelo chefe: "${raiz.texto.slice(0, 200)}"${familia.size > 1 ? ` (e ${familia.size - 1} tarefa(s) ligadas a ela)` : ''}`, raiz.cliente);
  console.log(`[ordens] ${raiz.id} cancelada pelo chefe (${familia.size} ordem(ns))`);
  return { cancelada: raiz, total: familia.size };
}

function marcarEntregue(ordem, agente) {
  if (!ordem.entregue.includes(agente)) ordem.entregue.push(agente);
}

// extra: { motor, ms, erro } — de qual IA veio e quanto demorou, para o relatório
function registrarResposta(ordem, agente, texto, extra = {}) {
  ordem.respostas.push({ agente, texto: String(texto).slice(0, 20000), em: new Date().toISOString(), ...extra });
  if (ordem.reexecutando) ordem.reexecutando = ordem.reexecutando.filter((a) => a !== agente);
  // vira arquivo .md no arquivo de entregas
  entregas.registrar(ordem, ordem.respostas.length - 1).catch((erro) => console.error('[entregas]', erro.message));
  // código entregue num projeto com repositório vira commit + pull request
  if (!ordem.cancelada) repositorios?.publicarEntrega(ordem, ordem.respostas.length - 1);
  // vira evento da documentação viva (o trecho basta para o documentador resumir)
  documentacao?.registrar(`Ordem "${ordem.texto.slice(0, 200)}" (${ordem.de && ordem.de !== 'chefe' ? `delegada por ${ordem.de}` : 'do chefe'} para ${ordem.para}) — ${agente} respondeu${extra.erro ? ' com ERRO' : ''}${extra.motor ? ` usando ${extra.motor}` : ''}: ${String(texto).slice(0, 1500)}`, ordem.cliente);
}

// Cria uma ordem (do chefe pela página, ou de um agente que delega) e despacha.
function criarOrdem({ para, texto, de = 'chefe', contexto, decisao, origem, cliente, ajuste, anexo, pai, consolidacao }) {
  const ordem = { id: randomUUID().slice(0, 8), para, de, texto: texto.trim().slice(0, 4000), criadaEm: new Date().toISOString(), estado: 'pendente', entregue: [], respostas: [] };
  if (contexto) ordem.contexto = contexto.slice(0, 4000);
  if (anexo) ordem.anexo = anexo.slice(0, 60000); // material longo para o agente (ex.: o que foi feito ontem)
  if (origem) ordem.origem = origem; // ex.: { telegram: { chat, msg } } para responder no mesmo lugar
  if (cliente && clientes.existe(cliente)) ordem.cliente = cliente; // a ficha do cliente vai junto para o agente
  if (ajuste) ordem.ajuste = ajuste; // refazer uma entrega: { ordemId, indice, original, anterior }
  if (pai) ordem.pai = pai; // tarefa de um plano do Orquestrador (o supervisor acompanha até o fim)
  if (consolidacao) ordem.consolidacao = consolidacao; // entrega final que junta o plano da ordem indicada
  if (decisao) {
    ordem.decisao = decisao; // como o Crânio (Laya) decidiu, com que certeza e urgência
    documentacao?.registrar(`Crânio: ${descreverDecisao(decisao, ordem)}`, ordem.cliente);
  }
  ordens.push(ordem);
  if (ordens.length > MAX_ORDENS) ordens.shift();
  transmitir('ordem', ordem);
  motores.despachar(ordem);
  return ordem;
}

const decisor = criarDecisor();

function descreverDecisao(d, ordem) {
  const pedido = `"${ordem.texto.slice(0, 200)}"`;
  const certeza = `${Math.round((d.confianca || 0) * 100)}%`;
  const urg = d.urgencia ? `, urgência ${d.urgencia}` : '';
  if (d.modo === 'indisponivel') return `fora do ar; ${pedido} seguiu direto para ${ordem.para} (${d.motivo})`;
  if (d.modo === 'confirmou') return `confirmou ${ordem.para} para ${pedido} (${certeza}${urg})`;
  if (d.modo === 'alertou') return `o chefe escolheu ${ordem.para} para ${pedido}; o Crânio indicaria ${d.escolhaOriginal} (${certeza}${urg})`;
  if (d.modo === 'redirecionou') return `redirecionou ${pedido} de ${d.sugerido} para ${ordem.para} (${certeza}${urg})`;
  return `escolheu ${ordem.para} para ${pedido} (${certeza}${urg}${d.incerto ? `; em dúvida com ${d.escolhaOriginal}` : ''})`;
}

// Toda decisão passa pelo Crânio: ordens com agente indicado (pelo chefe ou por
// quem delega) são avaliadas por ele antes de existir. Sem o Laya, seguem direto.
async function encaminhar({ para, texto, de = 'chefe', contexto, origem, cliente, anexo, pai }) {
  if (!decisor.ativo() || para === 'todos') return criarOrdem({ para, texto, de, contexto, origem, cliente, anexo, pai });
  let decisao;
  try {
    decisao = await decisor.avaliar(texto, motores.equipe(), para, de);
  } catch (erro) {
    console.warn(`[crânio] ${erro.message}`);
    decisao = { por: 'Laya', modo: 'indisponivel', motivo: erro.message.slice(0, 120), agente: para };
  }
  return criarOrdem({ para: decisao.agente, texto, de, contexto, decisao, origem, cliente, anexo, pai });
}

// Ordem do chefe (pela página ou pelo Telegram). para = id do agente, "todos" ou "auto" (o Laya escolhe).
async function ordemDoChefe({ para, texto, origem, cliente, anexo }) {
  texto = texto.slice(0, 2000);
  if (cliente && !clientes.existe(cliente)) throw new Error(`cliente "${cliente}" não cadastrado`);
  // sem cliente escolhido: reconhece pelo texto do pedido (nome, apelidos do projeto…)
  let reconhecido = false;
  if (!cliente) { cliente = clientes.detectar(texto) || ''; reconhecido = Boolean(cliente); }
  // "auto" sem o Laya: vai para o Orquestrador (ou para todos, se não houver)
  if (para === 'auto' && !decisor.ativo()) para = motores.equipe().orquestrador ? 'orquestrador' : 'todos';
  const marcar = (ordem) => { if (reconhecido && ordem.cliente) { ordem.clienteReconhecido = true; transmitir('ordem', ordem); } return ordem; };
  if (para !== 'auto') return marcar(await encaminhar({ para, texto, origem, cliente, anexo }));
  const decisao = await decisor.decidir(texto, motores.equipe());
  return marcar(criarOrdem({ para: decisao.agente, texto, decisao, origem, cliente, anexo }));
}

// Ajuste: o mesmo agente refaz uma entrega dele, vendo o pedido original e o que entregou.
function pedirAjuste({ ordemId, indice, texto, origem }) {
  const anterior = ordens.find((o) => o.id === ordemId);
  const r = anterior?.respostas[Number(indice)];
  if (!r || r.erro || r.simulada) throw new Error('entrega não encontrada');
  if (!motores.equipe()[r.agente]) throw new Error(`${r.agente} não está mais na equipe`);
  texto = String(texto || '').trim().slice(0, 2000);
  if (!texto) throw new Error('diga o que ajustar');
  return criarOrdem({
    para: r.agente, texto, cliente: anterior.cliente, origem: origem || anterior.origem,
    ajuste: { ordemId, indice: Number(indice), original: (anterior.ajuste?.original || anterior.texto).slice(0, 4000), anterior: r.texto.slice(0, 12000) },
  });
}
let documentacao = null; // criada logo abaixo, depois dos motores
const clientes = criarClientes({ dadosDir: DADOS_DIR });
let repositorios = null; // criado logo abaixo (precisa do pedirAjuste)
// lista de clientes para a página, com o endereço do repositório de cada projeto
const clientesComRepo = () => clientes.listar().map((c) => ({ ...c, repo: repositorios?.repoDe(c.id)?.url || null, producao: repositorios?.repoDe(c.id)?.producao || null }));
const rotinas = criarRotinas({
  dadosDir: DADOS_DIR,
  disparar: (r) => ordemDoChefe({ para: r.para, texto: r.texto, cliente: r.cliente, origem: { rotina: r.id }, anexo: r.resumoOntem ? materialDoDia(ontem()) : undefined }),
});

// Tudo o que a equipe fez num dia, para o resumo diário: entregas (com trecho), avaliações, erros e o que ficou pendente.
function materialDoDia(data) {
  const doDia = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: process.env.TZ || 'America/Sao_Paulo' }).startsWith(data);
  const feitas = entregas.doDia(data);
  const ordensDoDia = ordens.filter((o) => doDia(o.criadaEm));
  const erros = ordens.flatMap((o) => o.respostas.filter((r) => r.erro && doDia(r.em)).map((r) => `- ${r.agente} em "${o.texto.slice(0, 120)}": ${r.texto.slice(0, 200)}`));
  const pendentes = ordensDoDia.filter((o) => o.estado !== 'respondida').map((o) => `- ${o.para}: "${o.texto.slice(0, 150)}" (${o.estado})`);
  const [a, m, d] = data.split('-');
  const linhas = [
    `Dia ${d}/${m}/${a}: ${ordensDoDia.length} ordem(ns), ${feitas.length} entrega(s), ${erros.length} erro(s).`,
    '',
    '## Entregas',
    ...(feitas.length ? feitas.map((e, i) => [
      `### ${i + 1}. ${e.agente}${e.cliente ? ` · cliente ${clientes.nomeDe(e.cliente)}` : ''}${e.de !== 'chefe' ? ` · pedido de ${e.de}` : ''}${e.ajuste ? ' · ajuste' : ''}${e.revisado ? ' · revisado' : ''}${e.nota === 1 ? ' · 👍 aprovada pelo chefe' : e.nota === -1 ? ' · 👎 reprovada pelo chefe' : ''}`,
      `Pedido: ${e.pedido}`,
      `Entrega (trecho): ${e.trecho.slice(0, 1200)}`,
      `Arquivo: dados/entregas/${e.arquivo}`,
    ].join('\n')) : ['Nenhuma entrega neste dia.']),
    '',
    '## Erros',
    ...(erros.length ? erros : ['Nenhum.']),
    '',
    '## Ordens sem resposta',
    ...(pendentes.length ? pendentes : ['Nenhuma.']),
  ];
  return linhas.join('\n');
}
const telegram = criarTelegram({
  dadosDir: DADOS_DIR,
  nomeDe: (id) => id.charAt(0).toUpperCase() + id.slice(1),
  equipe: () => Object.keys(motores.equipe()),
  status: (id) => estado.get(id),
  cranioAtivo: () => decisor.ativo(),
  aoOrdem: (dados) => ordemDoChefe(dados),
  aoAjuste: (dados) => pedirAjuste(dados),
  clientes,
  rotinas: () => rotinas.listar(),
});
const entregas = criarEntregas({ dadosDir: DADOS_DIR, nomeCliente: (id) => clientes.nomeDe(id), aoNova: (e, conteudo) => ordens.find((o) => o.id === e.ordemId)?.origem?.revisaoPR ? null : telegram.enviarEntrega({ ...e, conteudo, origem: ordens.find((o) => o.id === e.ordemId)?.origem }) });
repositorios = criarRepositorios({
  dadosDir: DADOS_DIR,
  ordens,
  clientes,
  mudou: (ordem) => (ordem ? transmitir('ordem', ordem) : transmitirSemSalvar('clientes', clientesComRepo())),
  pedirCorrecao: (dados) => pedirAjuste(dados), // CI falhou ou a revisão pediu mudanças: o mesmo agente corrige no mesmo PR
  // CI verde: o QA (ou GITHUB_REVISOR) revisa o diff antes do merge
  pedirRevisao: ({ cliente, agente, numero, url, texto, anexo }) => {
    const cfg = motores.equipe();
    const rev = process.env.GITHUB_REVISOR || process.env.REVISOR || (cfg.qa ? 'qa' : 'revisor');
    if (!cfg[rev] || cfg[rev].provedor === 'webhook') return null;
    return criarOrdem({ para: rev, de: 'chefe', cliente, texto, anexo, origem: { revisaoPR: { numero, url, agente } } });
  },
  avisar: (texto) => { registrarAviso(texto); telegram.avisar(texto); },
  informar: (texto) => telegram.avisar(texto),
});

// O que os agentes recebem sobre o repositório do projeto: endereço, estrutura e como entregar arquivos.
async function contextoCodigo(cliente, ordem) {
  if (!repositorios.ativo() || ordem?.origem?.revisaoPR) return '';
  const repo = repositorios.repoDe(cliente);
  const estrutura = repo ? await repositorios.arvore(cliente) : '(repositório novo: será criado com a sua entrega)';
  return `Este projeto tem um repositório Git${repo ? ` (${repo.url})` : ''}. Tudo o que for arquivo do projeto (código, configuração, documentação), entregue COMPLETO, cada arquivo num bloco assim:
\`\`\`ts arquivo: caminho/relativo/do/arquivo.ts
conteúdo completo do arquivo
\`\`\`
Os arquivos viram um pull request, passam pelo CI (instalar, compilar e testar) e pela revisão de código do QA antes do merge: ao criar um projeto, inclua o package.json (ou requirements.txt) com scripts de build e test, e testes das regras principais. Nunca coloque senhas, chaves ou tokens no código: use variáveis de ambiente (e um .env.example). ${repo?.netlify ? `O projeto é publicado no Netlify (${repo.netlify.url}) e cada PR ganha um preview: o front-end precisa de "npm run build" gerando a pasta dist, ou de um netlify.toml na raiz com [build] command e publish certos (em monorepo, use base). Back-end com banco não roda no Netlify: use funções do Netlify ou deixe o back-end separado.` : 'Se o repositório estiver ligado a um serviço de deploy (Netlify, Cloudflare Pages), cada PR ganha um preview: mantenha o build funcionando (ex.: npm run build gerando a pasta de saída).'} Para alterar um arquivo existente, use o mesmo caminho e entregue o arquivo inteiro.

Estrutura atual do repositório:
${estrutura}`;
}

const motores = criarMotores({ raiz: RAIZ, dadosDir: DADOS_DIR, ordens, registrarStatus, marcarEntregue, registrarResposta, atualizarOrdem, criarOrdem: (dados) => encaminhar(dados).catch((erro) => console.error(erro)), fichaCliente: (id) => clientes.ficha(id), contextoCodigo });
const supervisor = criarSupervisor({
  ordens,
  equipe: () => motores.equipe(),
  estadoDe: (id) => estado.get(id)?.status,
  registrarStatus,
  mudou: (ordem) => transmitir('ordem', ordem),
  criarOrdem, // direto, sem passar pelo Crânio: replanejar e consolidar são do Orquestrador
  redespachar(ordem, agente) {
    ordem.entregue = ordem.entregue.filter((a) => a !== agente);
    ordem.reexecutando = [...new Set([...(ordem.reexecutando || []), agente])];
    motores.despachar(ordem);
  },
  avisarChefe(texto) {
    registrarAviso(texto);
    telegram.avisar(texto);
    documentacao?.registrar(texto);
  },
  // IA do agente fora (sem crédito, chave recusada…) e sem reserva funcionando: espera o monitor avisar que voltou
  iaFora(agente) {
    const cfg = motores.equipe();
    const c = cfg[agente];
    if (!c || !saude.bloqueada(c)) return false;
    const r = c.reserva && cfg[c.reserva];
    return !r || r.provedor === 'webhook' || Boolean(saude.bloqueada(r));
  },
});
// Monitor de IAs: confere de tempos em tempos quais IAs da equipe estão funcionando
const saude = criarSaude({
  equipe: () => motores.equipe(),
  avisar(texto, tipo) {
    if (tipo === 'problema') registrarAviso(texto); // vai para o registro de erros
    else transmitirSemSalvar('aviso-ok', { texto });
    telegram.avisar(texto);
  },
  aoVoltar: (agentes) => { for (const id of agentes) supervisor.agenteMudou(id); }, // IA voltou: retoma o que estava parado
  mudou: () => transmitirSemSalvar('ias', saude.porAgente()),
});
// Painel "Monitor de IAs": testa todas as IAs que as chaves enxergam
const testeIas = criarTesteIas({ equipe: () => motores.equipe(), aoResultado: (conf, erro) => saude.registrarUso(conf, erro) });
const autopiloto = criarAutopiloto({
  dadosDir: DADOS_DIR,
  ordens,
  equipe: () => motores.equipe(),
  clientes,
  criarOrdem, // direto: o plano é do Tech Lead, sem passar pelo Crânio
  docDe: (projeto) => documentacao.resumo(projeto).texto,
  entregasDe: (projeto) => entregas.listar({ cliente: projeto }).itens,
  planoAberto: (projeto) => supervisor.planoAberto(projeto),
  avisar: (texto) => { registrarAviso(texto); telegram.avisar(texto); },
});
documentacao = criarDocumentacao({
  dadosDir: DADOS_DIR,
  equipe: () => motores.equipe(),
  rotulo: (c) => motores.rotulo(c),
  naFila: (id, trabalho) => motores.naFila(id, trabalho),
  registrarStatus,
  transmitir: (evento, dados) => transmitirSemSalvar(evento, dados),
  // cada cliente cadastrado tem a sua documentação separada
  projetos: {
    existe: (id) => clientes.existe(id),
    nomeDe: (id) => clientes.nomeDe(id),
    ficha: (id) => clientes.ficha(id),
    listar: () => clientes.listar(),
  },
});

// ---------- rotas ----------

const servidor = http.createServer(async (req, res) => {
  try {
    await atender(req, res);
  } catch (erro) {
    // um erro numa requisição não pode derrubar o escritório
    console.error(`[${req.method} ${req.url}]`, erro);
    if (!res.headersSent) enviarJSON(res, 500, { erro: 'erro interno' });
    else res.end();
  }
});

async function atender(req, res) {
  const url = new URL(req.url, 'http://escritorio');
  const rota = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    return res.end();
  }

  // checagem de saúde para a hospedagem (sem senha, sem dados)
  if (rota === '/saude') return enviarJSON(res, 200, { ok: true, ligadoHa: Math.round(process.uptime()) });

  if (!autorizado(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="agentscrets", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Senha necessária.');
  }

  if (rota === '/api/status' && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    const itens = Array.isArray(dados) ? dados : [dados];
    for (const item of itens) {
      if (!item || typeof item.id !== 'string') return enviarJSON(res, 400, { erro: 'campo "id" obrigatório' });
      if (item.status && !STATUS_VALIDOS.includes(item.status)) return enviarJSON(res, 400, { erro: `status deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
    }
    itens.forEach(registrarStatus);
    return enviarJSON(res, 200, { ok: true, recebidos: itens.length });
  }

  if (rota === '/api/estado') return enviarJSON(res, 200, [...estado.values()]);
  // marca do escritório (topo da página e placa na parede)
  if (rota === '/api/erros') return enviarJSON(res, 200, avisos.slice().reverse());

  if (rota === '/api/marca') {
    return enviarJSON(res, 200, {
      nome: (process.env.MARCA_NOME || 'agentscrets').slice(0, 40),
      subtitulo: (process.env.MARCA_SUBTITULO || 'escritório de agentes de IA').slice(0, 80),
      cor: /^#[0-9a-f]{6}$/i.test(process.env.MARCA_COR || '') ? process.env.MARCA_COR : '#e11d2a',
    });
  }

  if (rota === '/api/ordens' && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    const texto = typeof dados.texto === 'string' ? dados.texto.trim() : '';
    if (!texto) return enviarJSON(res, 400, { erro: 'campo "texto" obrigatório' });
    if (typeof dados.para !== 'string' || !dados.para) return enviarJSON(res, 400, { erro: 'campo "para" obrigatório (id do agente ou "todos")' });
    try {
      return enviarJSON(res, 201, await ordemDoChefe({ para: dados.para, texto, cliente: typeof dados.cliente === 'string' ? dados.cliente : '' }));
    } catch (erro) {
      if (/cliente/.test(erro.message)) return enviarJSON(res, 400, { erro: erro.message });
      console.error('[decisor]', erro.message);
      return enviarJSON(res, 502, { erro: `o Laya não conseguiu decidir: ${erro.message}` });
    }
  }

  const tentar = rota.match(/^\/api\/ordens\/([\w-]+)\/tentar$/);
  if (tentar && req.method === 'POST') {
    const ordem = ordens.find((o) => o.id === tentar[1]);
    if (!ordem) return enviarJSON(res, 404, { erro: 'ordem não encontrada' });
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    try { supervisor.tentarAgora(ordem, dados.agente || ordem.para); return enviarJSON(res, 200, ordem); } catch (erro) { return enviarJSON(res, 400, { erro: erro.message }); }
  }

  const cancelar = rota.match(/^\/api\/ordens\/([\w-]+)\/cancelar$/);
  if (cancelar && req.method === 'POST') {
    try { return enviarJSON(res, 200, cancelarOrdem(cancelar[1])); } catch (erro) { return enviarJSON(res, 404, { erro: erro.message }); }
  }

  const ajuste = rota.match(/^\/api\/ordens\/([\w-]+)\/ajuste$/);
  if (ajuste && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    try { return enviarJSON(res, 201, pedirAjuste({ ordemId: ajuste[1], indice: dados.indice, texto: dados.texto })); } catch (erro) { return enviarJSON(res, 400, { erro: erro.message }); }
  }

  // ---------- clientes ----------
  if (rota === '/api/clientes' && req.method === 'GET') return enviarJSON(res, 200, clientesComRepo());
  const cliente = rota.match(/^\/api\/clientes(?:\/([\w-]{1,40}))?$/);
  if (cliente && (req.method === 'POST' || req.method === 'DELETE')) {
    try {
      if (req.method === 'DELETE') { await clientes.remover(cliente[1]); transmitirSemSalvar('clientes', clientesComRepo()); return enviarJSON(res, 200, clientesComRepo()); }
      const salvo = await clientes.salvar(cliente[1], await lerCorpo(req));
      documentacao.registrar(`Ficha do cliente ${cliente[1] ? 'atualizada' : 'criada'}: ${clientes.ficha(salvo.id).slice(0, 2000)}`, salvo.id);
      documentacao.registrar(`Clientes: projeto ${salvo.nome} ${cliente[1] ? 'atualizado' : 'cadastrado'}`);
      transmitirSemSalvar('clientes', clientesComRepo());
      return enviarJSON(res, 200, salvo);
    } catch (erro) { return enviarJSON(res, 400, { erro: erro.message }); }
  }

  // ---------- piloto automático do Tech Lead ----------
  if (rota === '/api/autopiloto' && req.method === 'GET') return enviarJSON(res, 200, autopiloto.ver());
  if (rota === '/api/autopiloto' && req.method === 'POST') {
    try { return enviarJSON(res, 200, await autopiloto.configurar(await lerCorpo(req))); } catch (erro) { return enviarJSON(res, 400, { erro: erro.message }); }
  }

  // ---------- rotinas ----------
  if (rota === '/api/rotinas' && req.method === 'GET') return enviarJSON(res, 200, rotinas.listar());
  const rotina = rota.match(/^\/api\/rotinas(?:\/([\w-]{1,40}))?(\/rodar)?$/);
  if (rotina && (req.method === 'POST' || req.method === 'DELETE')) {
    try {
      if (rotina[2]) return enviarJSON(res, 200, await rotinas.rodarAgora(rotina[1]));
      if (req.method === 'DELETE') { await rotinas.remover(rotina[1]); return enviarJSON(res, 200, rotinas.listar()); }
      const dados = await lerCorpo(req);
      if (dados.cliente && !clientes.existe(dados.cliente)) throw new Error('cliente não cadastrado');
      return enviarJSON(res, 200, await rotinas.salvar(rotina[1], dados));
    } catch (erro) { return enviarJSON(res, 400, { erro: erro.message }); }
  }

  // ---------- arquivo de entregas ----------
  if (rota === '/api/entregas') {
    return enviarJSON(res, 200, entregas.listar({ q: url.searchParams.get('q') || '', agente: url.searchParams.get('agente') || '', cliente: url.searchParams.get('cliente') || '', pagina: url.searchParams.get('pagina') }));
  }
  if (rota === '/api/entregas/arquivo') {
    try {
      const texto = await entregas.ler(url.searchParams.get('caminho'));
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      return res.end(texto);
    } catch { return enviarJSON(res, 404, { erro: 'entrega não encontrada' }); }
  }
  if (rota === '/api/entregas/exportar') {
    const texto = await entregas.exportar({ q: url.searchParams.get('q') || '', agente: url.searchParams.get('agente') || '', cliente: url.searchParams.get('cliente') || '' });
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="entregas.md"' });
    return res.end(texto);
  }

  // documentação: ?projeto=<id do cliente> (sem projeto = geral)
  if (rota === '/api/documentacao' && req.method === 'GET') return enviarJSON(res, 200, documentacao.resumo(url.searchParams.get('projeto') || 'geral'));
  if (rota === '/api/documentacao/atualizar' && req.method === 'POST') return enviarJSON(res, 200, await documentacao.atualizar({ forcar: true, projeto: url.searchParams.get('projeto') || 'geral' }));

  // diagnóstico do Crânio: GET /api/decisor/teste?texto=crie a tela de login
  if (rota === '/api/decisor/teste') {
    const texto = (url.searchParams.get('texto') || '').trim();
    if (!texto) return enviarJSON(res, 400, { erro: 'use ?texto=seu pedido' });
    try { return enviarJSON(res, 200, await decisor.diagnosticar(texto, motores.equipe())); } catch (erro) { return enviarJSON(res, 502, { erro: erro.message }); }
  }

  if (rota === '/api/decisor') return enviarJSON(res, 200, { ativo: decisor.ativo(), online: await decisor.online(), nome: 'Laya' });

  if (rota === '/api/ordens' && req.method === 'GET') return enviarJSON(res, 200, ordens.slice(-50));

  if (rota === '/api/ordens/pendentes') {
    const agente = url.searchParams.get('agente');
    if (!agente) return enviarJSON(res, 400, { erro: 'informe ?agente=<id>' });
    const novas = ordens.filter((o) => (o.para === agente || o.para === 'todos') && !o.entregue.includes(agente));
    for (const o of novas) { marcarEntregue(o, agente); atualizarOrdem(o); }
    return enviarJSON(res, 200, novas.map(({ id, para, de, texto, contexto, criadaEm }) => ({ id, para, de, texto, contexto, criadaEm })));
  }

  const resposta = rota.match(/^\/api\/ordens\/([\w-]+)\/resposta$/);
  if (resposta && req.method === 'POST') {
    const ordem = ordens.find((o) => o.id === resposta[1]);
    if (!ordem) return enviarJSON(res, 404, { erro: 'ordem não encontrada' });
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    if (typeof dados.agente !== 'string' || typeof dados.texto !== 'string') return enviarJSON(res, 400, { erro: 'campos "agente" e "texto" obrigatórios' });
    if (dados.status && !STATUS_VALIDOS.includes(dados.status)) return enviarJSON(res, 400, { erro: `status deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
    marcarEntregue(ordem, dados.agente);
    registrarResposta(ordem, dados.agente, dados.texto);
    atualizarOrdem(ordem);
    if (dados.status) registrarStatus({ id: dados.agente, status: dados.status, tarefa: dados.texto });
    return enviarJSON(res, 200, ordem);
  }

  // ---------- configuração da equipe pela tela ----------

  if (rota === '/api/motores' && req.method === 'GET') return enviarJSON(res, 200, motores.listar());
  if (rota === '/api/motores/modelos' && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    try { return enviarJSON(res, 200, { modelos: await motores.modelos(dados) }); } catch (erro) { return enviarJSON(res, 400, { erro: erro.message }); }
  }
  if (rota === '/api/ias' && req.method === 'GET') return enviarJSON(res, 200, { ias: saude.listar(), agentes: saude.porAgente() });
  if (rota === '/api/ias/teste' && req.method === 'GET') return enviarJSON(res, 200, testeIas.ver());
  if (rota === '/api/ias/teste' && req.method === 'POST') return enviarJSON(res, 200, await testeIas.rodar());
  if (rota === '/api/ias/verificar' && req.method === 'POST') return enviarJSON(res, 200, { ias: await saude.verificar(), agentes: saude.porAgente() });
  if (rota === '/api/motores/restaurar' && req.method === 'POST') { await motores.restaurar(); return enviarJSON(res, 200, motores.listar()); }

  const motor = rota.match(/^\/api\/motores\/([\w-]{1,40})(\/testar)?$/);
  if (motor && !motor[2] && req.method === 'DELETE') {
    if (motor[1] === 'chefe') return enviarJSON(res, 400, { erro: 'o chefe não sai' });
    await motores.removerAgente(motor[1]);
    estado.delete(motor[1]);
    transmitir('removido', { id: motor[1] });
    documentacao.registrar(`Equipe: ${motor[1]} saiu da equipe`);
    return enviarJSON(res, 200, motores.listar());
  }
  if (motor && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    try {
      if (motor[2]) return enviarJSON(res, 200, await motores.testar(motor[1], dados));
      const config = await motores.salvarAgente(motor[1], dados);
      supervisor.agenteMudou(motor[1]); // consertou o agente: o que estava parado com ele volta agora
      saude.verificar().catch(() => {}); // e confere a IA nova
      documentacao.registrar(`Equipe: ${motor[1]} agora usa ${motores.rotulo(config)}${config.funcao ? ` (função: ${config.funcao})` : ''}`);
      return enviarJSON(res, 200, { ok: true, config });
    } catch (erro) {
      return enviarJSON(res, 400, { erro: erro.message });
    }
  }

  // ---------- avaliação das respostas e relatório ----------

  const avaliacao = rota.match(/^\/api\/ordens\/([\w-]+)\/avaliacao$/);
  if (avaliacao && req.method === 'POST') {
    const ordem = ordens.find((o) => o.id === avaliacao[1]);
    if (!ordem) return enviarJSON(res, 404, { erro: 'ordem não encontrada' });
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    const resp = ordem.respostas[Number(dados.indice)];
    if (!resp) return enviarJSON(res, 400, { erro: 'resposta não encontrada' });
    if (![1, -1, 0].includes(dados.nota)) return enviarJSON(res, 400, { erro: 'nota deve ser 1 (bom), -1 (ruim) ou 0 (limpar)' });
    if (dados.nota === 0) { delete resp.nota; delete resp.comentario; } else {
      resp.nota = dados.nota;
      documentacao.registrar(`Avaliação do chefe: ${dados.nota === 1 ? '👍 boa' : '👎 ruim'} para a resposta de ${resp.agente} em "${ordem.texto.slice(0, 150)}"${typeof dados.comentario === 'string' && dados.comentario.trim() ? ` — comentário: ${dados.comentario.trim().slice(0, 300)}` : ''}`, ordem.cliente);
      resp.comentario = typeof dados.comentario === 'string' ? dados.comentario.trim().slice(0, 500) : resp.comentario;
      if (!resp.comentario) delete resp.comentario;
    }
    entregas.registrar(ordem, Number(dados.indice)).catch(() => {}); // regrava o .md com a avaliação
    transmitir('ordem', ordem);
    return enviarJSON(res, 200, ordem);
  }

  if (rota === '/api/relatorio') {
    const desde = Date.now() - Number(url.searchParams.get('dias') || 7) * 864e5;
    return enviarJSON(res, 200, montarRelatorio(desde));
  }

  if (rota === '/api/eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': conectado\n\n');
    conexoes.add(res);
    const pulso = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(pulso); conexoes.delete(res); });
    return;
  }

  // arquivos estáticos
  // não expõe motores.json (URLs internas), os dados salvos nem arquivos ocultos como .git
  const partes = rota.split('/');
  if (rota === '/motores.json' || ['dados', 'node_modules'].includes(partes[1]) || partes.some((p) => p.startsWith('.'))) { res.writeHead(404); return res.end(); }
  const caminho = normalize(join(RAIZ, rota === '/' ? 'index.html' : decodeURIComponent(rota)));
  if (!caminho.startsWith(RAIZ)) { res.writeHead(403); return res.end(); }
  try {
    const conteudo = await readFile(caminho);
    res.writeHead(200, {
      'Content-Type': TIPOS[extname(caminho)] || 'application/octet-stream',
      // a página sempre pega a versão nova depois de um deploy; só a biblioteca 3D (que não muda) fica em cache
      'Cache-Control': partes[1] === 'vendor' ? 'public, max-age=604800' : 'no-cache, no-store, must-revalidate',
    });
    res.end(conteudo);
  } catch {
    res.writeHead(404); res.end('não encontrado');
  }
}

// Resumo por agente e por IA: quantas ordens, aprovação, erros e tempo médio.
function montarRelatorio(desde) {
  const vazio = () => ({ respostas: 0, boas: 0, ruins: 0, erros: 0, msTotal: 0, comMs: 0 });
  const somar = (alvo, r) => {
    alvo.respostas++;
    if (r.erro || /^Erro:/.test(r.texto)) alvo.erros++;
    if (r.nota === 1) alvo.boas++;
    if (r.nota === -1) alvo.ruins++;
    if (typeof r.ms === 'number') { alvo.msTotal += r.ms; alvo.comMs++; }
  };
  const agentes = {};
  for (const o of ordens) {
    if (Date.parse(o.criadaEm) < desde) continue;
    for (const r of o.respostas) {
      const a = (agentes[r.agente] ??= { ...vazio(), recebidas: new Set(), porMotor: {}, comentarios: [] });
      somar(a, r);
      a.recebidas.add(o.id);
      somar((a.porMotor[r.motor || 'externo'] ??= vazio()), r);
      if (r.comentario) a.comentarios.push({ nota: r.nota, texto: r.comentario, ordem: o.texto.slice(0, 80), motor: r.motor });
    }
  }
  const fechar = (x) => ({ respostas: x.respostas, boas: x.boas, ruins: x.ruins, erros: x.erros, msMedio: x.comMs ? Math.round(x.msTotal / x.comMs) : null });
  return Object.fromEntries(Object.entries(agentes).map(([id, a]) => [id, {
    ...fechar(a),
    porMotor: Object.fromEntries(Object.entries(a.porMotor).map(([m, x]) => [m, fechar(x)])),
    comentarios: a.comentarios.slice(-10),
  }]));
}

// ao ser desligado (deploy, reinício), salva antes de sair
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, async () => {
    console.log(`Recebi ${sinal}, salvando e encerrando…`);
    await salvar();
    process.exit(0);
  });
}

await carregar();
await clientes.carregar(); // antes da documentação: cada cliente tem o seu documento
await documentacao.carregar();
await rotinas.carregar();
// time antigo (agência de marketing) → time de desenvolvimento, uma vez só
const idsTrocados = await motores.migrarTimeDev();
if (idsTrocados) await rotinas.renomearAgentes(idsTrocados);
// agentes que saíram da equipe (tinham IA embutida) somem do escritório
for (const [id, s] of estado) if (s.motor && !motores.equipe()[id]) estado.delete(id);
rotinas.iniciar();
await entregas.carregar(ordens);
telegram.iniciar();
motores.iniciar(estado);
supervisor.iniciar();
saude.iniciar();
await autopiloto.carregar();
autopiloto.iniciar();
await repositorios.carregar();
repositorios.iniciar();
decisor.verificar();
servidor.listen(PORTA, HOST, () => {
  console.log(`Escritório aberto em http://${SO_LOCAL ? 'localhost' : HOST}:${PORTA}${SENHA ? ' (com senha)' : ''}`);
  console.log(`Status:  POST /api/status  {"id","status","tarefa"}`);
  console.log(`Ordens:  GET  /api/ordens/pendentes?agente=<id>  ·  POST /api/ordens/<id>/resposta`);
});
