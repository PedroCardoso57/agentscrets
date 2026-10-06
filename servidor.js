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
//   DOCUMENTADOR      agente que mantém a documentação viva (padrão: redator); DOC_INTERVALO_MIN (padrão 3)
//   LAYA_URL          servidor do Laya, que decide o agente das ordens "Automático" (ex.: http://laya:8000)
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY   chaves das IAs dos motores embutidos
//
// Status (motor → escritório):
//   POST /api/status                 {"id":"redator","status":"trabalhando","tarefa":"..."}
//
// Ordens (chefe → motor):
//   POST /api/ordens                 {"para":"redator" | "todos","texto":"..."}      (a página usa)
//   GET  /api/ordens/pendentes?agente=redator   → ordens novas para o motor (marca como entregues)
//   POST /api/ordens/:id/resposta    {"agente":"redator","texto":"Feito!","status":"concluido"}
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
const clientes = new Set();

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

function transmitirSemSalvar(evento, dados) {
  const linha = (evento ? `event: ${evento}\n` : '') + `data: ${JSON.stringify(dados)}\n\n`;
  for (const c of clientes) c.write(linha);
}

function registrarStatus(item) {
  const novo = { ...estado.get(item.id), ...item, atualizadoEm: new Date().toISOString() };
  estado.set(item.id, novo);
  transmitir(null, novo);
}

// ---------- ordens ----------

function atualizarOrdem(ordem) {
  ordem.estado = ordem.respostas.length ? 'respondida' : ordem.entregue.length ? 'entregue' : 'pendente';
  transmitir('ordem', ordem);
}

function marcarEntregue(ordem, agente) {
  if (!ordem.entregue.includes(agente)) ordem.entregue.push(agente);
}

// extra: { motor, ms, erro } — de qual IA veio e quanto demorou, para o relatório
function registrarResposta(ordem, agente, texto, extra = {}) {
  ordem.respostas.push({ agente, texto: String(texto).slice(0, 20000), em: new Date().toISOString(), ...extra });
  // vira evento da documentação viva (o trecho basta para o documentador resumir)
  documentacao?.registrar(`Ordem "${ordem.texto.slice(0, 200)}" (${ordem.de && ordem.de !== 'chefe' ? `delegada por ${ordem.de}` : 'do chefe'} para ${ordem.para}) — ${agente} respondeu${extra.erro ? ' com ERRO' : ''}${extra.motor ? ` usando ${extra.motor}` : ''}: ${String(texto).slice(0, 1500)}`);
}

// Cria uma ordem (do chefe pela página, ou de um agente que delega) e despacha.
function criarOrdem({ para, texto, de = 'chefe', contexto, decisao }) {
  const ordem = { id: randomUUID().slice(0, 8), para, de, texto: texto.trim().slice(0, 4000), criadaEm: new Date().toISOString(), estado: 'pendente', entregue: [], respostas: [] };
  if (contexto) ordem.contexto = contexto.slice(0, 4000);
  if (decisao) {
    ordem.decisao = decisao; // como o Crânio (Laya) decidiu, com que certeza e urgência
    documentacao?.registrar(`Crânio: ${descreverDecisao(decisao, ordem)}`);
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
async function encaminhar({ para, texto, de = 'chefe', contexto }) {
  if (!decisor.ativo() || para === 'todos') return criarOrdem({ para, texto, de, contexto });
  let decisao;
  try {
    decisao = await decisor.avaliar(texto, motores.equipe(), para, de);
  } catch (erro) {
    console.warn(`[crânio] ${erro.message}`);
    decisao = { por: 'Laya', modo: 'indisponivel', motivo: erro.message.slice(0, 120), agente: para };
  }
  return criarOrdem({ para: decisao.agente, texto, de, contexto, decisao });
}
let documentacao = null; // criada logo abaixo, depois dos motores
const motores = criarMotores({ raiz: RAIZ, dadosDir: DADOS_DIR, ordens, registrarStatus, marcarEntregue, registrarResposta, atualizarOrdem, criarOrdem: (dados) => encaminhar(dados).catch((erro) => console.error(erro)) });
documentacao = criarDocumentacao({
  dadosDir: DADOS_DIR,
  equipe: () => motores.equipe(),
  rotulo: (c) => motores.rotulo(c),
  naFila: (id, trabalho) => motores.naFila(id, trabalho),
  registrarStatus,
  transmitir: (evento, dados) => transmitirSemSalvar(evento, dados),
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

  if (rota === '/api/ordens' && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    const texto = typeof dados.texto === 'string' ? dados.texto.trim() : '';
    if (!texto) return enviarJSON(res, 400, { erro: 'campo "texto" obrigatório' });
    if (typeof dados.para !== 'string' || !dados.para) return enviarJSON(res, 400, { erro: 'campo "para" obrigatório (id do agente ou "todos")' });
    if (dados.para !== 'auto') return enviarJSON(res, 201, await encaminhar({ para: dados.para, texto: texto.slice(0, 2000) }));
    // "Automático": o Laya decide qual agente cuida do pedido
    try {
      const decisao = await decisor.decidir(texto, motores.equipe());
      return enviarJSON(res, 201, criarOrdem({ para: decisao.agente, texto: texto.slice(0, 2000), decisao }));
    } catch (erro) {
      console.error('[decisor]', erro.message);
      return enviarJSON(res, 502, { erro: `o Laya não conseguiu decidir: ${erro.message}` });
    }
  }

  if (rota === '/api/documentacao' && req.method === 'GET') return enviarJSON(res, 200, documentacao.resumo());
  if (rota === '/api/documentacao/atualizar' && req.method === 'POST') return enviarJSON(res, 200, await documentacao.atualizar({ forcar: true }));

  // diagnóstico do Crânio: GET /api/decisor/teste?texto=escreva uma legenda
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
  if (rota === '/api/motores/restaurar' && req.method === 'POST') { await motores.restaurar(); return enviarJSON(res, 200, motores.listar()); }

  const motor = rota.match(/^\/api\/motores\/([\w-]{1,40})(\/testar)?$/);
  if (motor && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    try {
      if (motor[2]) return enviarJSON(res, 200, await motores.testar(motor[1], dados));
      const config = await motores.salvarAgente(motor[1], dados);
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
      documentacao.registrar(`Avaliação do chefe: ${dados.nota === 1 ? '👍 boa' : '👎 ruim'} para a resposta de ${resp.agente} em "${ordem.texto.slice(0, 150)}"${typeof dados.comentario === 'string' && dados.comentario.trim() ? ` — comentário: ${dados.comentario.trim().slice(0, 300)}` : ''}`);
      resp.comentario = typeof dados.comentario === 'string' ? dados.comentario.trim().slice(0, 500) : resp.comentario;
      if (!resp.comentario) delete resp.comentario;
    }
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
    clientes.add(res);
    const pulso = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(pulso); clientes.delete(res); });
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
    res.writeHead(200, { 'Content-Type': TIPOS[extname(caminho)] || 'application/octet-stream' });
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
await documentacao.carregar();
motores.iniciar(estado);
decisor.verificar();
servidor.listen(PORTA, HOST, () => {
  console.log(`Escritório aberto em http://${SO_LOCAL ? 'localhost' : HOST}:${PORTA}${SENHA ? ' (com senha)' : ''}`);
  console.log(`Status:  POST /api/status  {"id","status","tarefa"}`);
  console.log(`Ordens:  GET  /api/ordens/pendentes?agente=<id>  ·  POST /api/ordens/<id>/resposta`);
});
