// Motores embutidos: o próprio servidor chama a IA de cada agente quando chega
// uma ordem para ele, conforme o motores.json (veja motores.exemplo.json).
//
//   {
//     "redator":      { "provedor": "anthropic", "modelo": "claude-opus-5-5", "funcao": "...", "instrucoes": "..." },
//     "analista":     { "provedor": "openai", "modelo": "...", "instrucoes": "..." },
//     "orquestrador": { "provedor": "anthropic", "delegar": true, "instrucoes": "..." },
//     "designer":     { "webhook": "https://seu-n8n/webhook/designer" }
//   }
//
// Agentes fora do motores.json continuam recebendo ordens pela consulta
// (GET /api/ordens/pendentes), como antes.

import { readFileSync, existsSync } from 'node:fs';
import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PROVEDORES, NOMES, listarModelos } from './provedores.js';

const VOLTAR_AO_OCIOSO = 8000;

const PROVEDORES_VALIDOS = Object.keys(PROVEDORES);
const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
// chaves que a tela de configuração mostra como "configurada / falta"
const CHAVES_CONHECIDAS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'MISTRAL_API_KEY'];

export function criarMotores({ raiz, dadosDir, ordens, registrarStatus, marcarEntregue, registrarResposta, atualizarOrdem, criarOrdem }) {
  const arquivo = process.env.MOTORES_ARQUIVO || join(raiz, 'motores.json');
  // o que você muda pela tela fica na pasta de dados (o motores.json original vira só o ponto de partida)
  const arquivoEditado = join(dadosDir, 'motores.json');
  const filas = new Map(); // agente → promessa da tarefa em andamento (uma por vez)
  let avisado = '';

  // Relido a cada ordem: dá para editar o motores.json sem reiniciar.
  function lerBruto() {
    try {
      if (existsSync(arquivoEditado)) return JSON.parse(readFileSync(arquivoEditado, 'utf8'));
      return JSON.parse(process.env.MOTORES_JSON || readFileSync(arquivo, 'utf8'));
    } catch (erro) {
      if (erro.code !== 'ENOENT' && avisado !== erro.message) console.error(`motores.json inválido: ${(avisado = erro.message)}`);
      return {};
    }
  }

  function configuracao() {
    const bruto = lerBruto();
    const cfg = {};
    for (const [id, c] of Object.entries(bruto)) {
      if (id.startsWith('_') || !c || typeof c !== 'object') continue; // "_comentario" etc.
      const provedor = c.provedor || (c.webhook ? 'webhook' : null);
      if (!PROVEDORES[provedor]) { console.warn(`motores.json: "${id}" tem provedor desconhecido "${c.provedor}"`); continue; }
      cfg[id] = { ...c, provedor };
    }
    return cfg;
  }

  function rotulo(c) {
    let nome = NOMES[c.provedor];
    if (c.provedor === 'compativel' && c.baseUrl) {
      // mostra o serviço de verdade em vez de "API compatível"
      const host = new URL(c.baseUrl).host;
      nome = /groq/.test(host) ? 'Groq' : /openrouter/.test(host) ? 'OpenRouter' : /nvidia/.test(host) ? 'NVIDIA' : /mistral/.test(host) ? 'Mistral' : /cloudflare/.test(host) ? 'Cloudflare' : /:11434$/.test(host) ? 'Ollama' : /deepseek/.test(host) ? 'DeepSeek' : host;
    }
    return c.modelo ? `${nome} · ${c.modelo}` : nome;
  }

  function instrucoesDe(id, c, cfg, podeDelegar) {
    let texto = c.instrucoes || `Você é o agente "${id}" de um escritório de IA${c.funcao ? `, responsável por: ${c.funcao}` : ''}. Cumpra a tarefa do chefe com qualidade e responda em português.`;
    if (podeDelegar) {
      const equipe = Object.entries(cfg).filter(([outro, o]) => outro !== id && !o.delegar)
        .map(([outro, o]) => `- ${outro}: ${o.funcao || 'sem descrição'}`).join('\n');
      texto += `\n\nVocê coordena esta equipe:\n${equipe}\n\nResponda SOMENTE com um objeto JSON, sem texto fora dele, no formato:\n{"resposta": "o que você vai fazer, em poucas linhas, para o chefe", "tarefas": [{"para": "<id da lista>", "texto": "tarefa clara e completa para esse agente"}]}\nUse apenas ids da lista. Se der para resolver sem a equipe, responda com "tarefas": [].`;
    }
    return texto;
  }

  function pedidoDe(ordem) {
    return ordem.contexto ? `${ordem.texto}\n\nContexto: ${ordem.contexto}` : ordem.texto;
  }

  function lerPlano(texto) {
    const limpo = texto.replace(/```(?:json)?/g, '');
    const inicio = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (inicio < 0 || fim < inicio) return null;
    try { return JSON.parse(limpo.slice(inicio, fim + 1)); } catch { return null; }
  }

  // ---------- configuração pela tela ----------

  function url(valor, campo) {
    try {
      const u = new URL(valor);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      return u.toString().replace(/\/$/, '');
    } catch { throw new Error(`"${campo}" precisa ser um endereço http(s) válido`); }
  }

  function texto(valor, max) {
    return typeof valor === 'string' ? valor.trim().slice(0, max) : '';
  }

  // Limpa e valida o que veio da tela. Lança erro com mensagem amigável.
  function validar(dados) {
    const provedor = dados.provedor;
    if (!PROVEDORES_VALIDOS.includes(provedor)) throw new Error(`provedor deve ser um de: ${PROVEDORES_VALIDOS.join(', ')}`);
    const c = { provedor };
    if (provedor === 'webhook') {
      c.webhook = url(dados.webhook, 'webhook');
    } else {
      c.modelo = texto(dados.modelo, 120);
      if (!c.modelo) throw new Error('informe o modelo');
    }
    if (provedor === 'compativel') {
      c.baseUrl = url(dados.baseUrl, 'baseUrl');
      const chaveEnv = texto(dados.chaveEnv, 60);
      // só variáveis de chave de API: impede apontar para a senha do escritório, por exemplo
      if (chaveEnv && !/^[A-Z][A-Z0-9_]*_API_KEY$/.test(chaveEnv)) throw new Error('chaveEnv deve ser o nome de uma variável terminada em _API_KEY (ex.: GROQ_API_KEY)');
      if (chaveEnv) c.chaveEnv = chaveEnv;
    }
    if (provedor === 'anthropic' && dados.esforco) {
      if (!ESFORCOS.includes(dados.esforco)) throw new Error(`esforço deve ser um de: ${ESFORCOS.join(', ')}`);
      c.esforco = dados.esforco;
    }
    if (dados.delegar) c.delegar = true;
    const funcao = texto(dados.funcao, 200);
    const instrucoes = texto(dados.instrucoes, 8000);
    if (funcao) c.funcao = funcao;
    if (instrucoes) c.instrucoes = instrucoes;
    return c;
  }

  async function salvarAgente(id, dados) {
    if (!/^[\w-]{1,40}$/.test(id)) throw new Error('id do agente inválido');
    const c = validar(dados);
    const bruto = lerBruto();
    bruto[id] = c;
    await mkdir(dadosDir, { recursive: true });
    await writeFile(`${arquivoEditado}.tmp`, JSON.stringify(bruto, null, 2));
    await rename(`${arquivoEditado}.tmp`, arquivoEditado);
    registrarStatus({ id, motor: rotulo(c) });
    return c;
  }

  // Modelos que a chave consegue usar no provedor escolhido (sem exigir modelo preenchido).
  async function modelos(dados) {
    const c = validar({ ...dados, modelo: dados.modelo || 'qualquer', webhook: dados.webhook || 'https://x.invalid' });
    return listarModelos(c);
  }

  // Faz uma pergunta curtinha com a configuração dada, para conferir modelo e chave antes de salvar.
  async function testar(id, dados) {
    const c = validar(dados);
    const inicio = Date.now();
    try {
      const resposta = await PROVEDORES[c.provedor]({
        ...c,
        instrucoes: 'Você está sendo testado. Responda apenas com uma frase curta em português dizendo que está funcionando.',
        pedido: 'Teste de conexão do escritório.',
        maxTokens: 2000,
        ordem: { id: 'teste', para: id, texto: 'Teste de conexão do escritório.' },
        agente: id,
      });
      return { ok: true, ms: Date.now() - inicio, resposta: resposta ?? '(webhook aceitou; a resposta vem depois)' };
    } catch (erro) {
      return { ok: false, ms: Date.now() - inicio, erro: erro.message };
    }
  }

  // Descarta as mudanças feitas pela tela e volta a usar o motores.json do servidor.
  async function restaurar() {
    await rm(arquivoEditado, { force: true });
    for (const [id, c] of Object.entries(configuracao())) registrarStatus({ id, motor: rotulo(c) });
  }

  function listar() {
    const cfg = configuracao();
    const nomes = new Set(CHAVES_CONHECIDAS);
    for (const c of Object.values(cfg)) if (c.chaveEnv) nomes.add(c.chaveEnv);
    const chaves = Object.fromEntries([...nomes].map((n) => [n, Boolean(process.env[n])]));
    const rotulos = Object.fromEntries(Object.entries(cfg).map(([id, c]) => [id, rotulo(c)]));
    return { agentes: cfg, rotulos, chaves, provedores: PROVEDORES_VALIDOS, editadoPelaTela: existsSync(arquivoEditado) };
  }

  async function executar(id, ordem) {
    const cfg = configuracao();
    const c = cfg[id];
    if (!c) return;
    const podeDelegar = Boolean(c.delegar) && (!ordem.de || ordem.de === 'chefe'); // tarefas delegadas não são re-delegadas
    registrarStatus({ id, status: 'trabalhando', tarefa: ordem.texto.slice(0, 140), motor: rotulo(c) });
    const inicio = Date.now();
    const meta = () => ({ motor: rotulo(c), ms: Date.now() - inicio }); // para o relatório comparar IAs
    try {
      let resposta = await PROVEDORES[c.provedor]({ ...c, instrucoes: instrucoesDe(id, c, cfg, podeDelegar), pedido: pedidoDe(ordem), ordem, agente: id });
      if (resposta === null) { // webhook: entregue, o motor responde depois
        registrarStatus({ id, status: 'aguardando', tarefa: 'Enviado ao motor externo' });
        return;
      }
      if (podeDelegar) {
        const plano = lerPlano(resposta);
        if (plano) {
          const tarefas = (Array.isArray(plano.tarefas) ? plano.tarefas : [])
            .filter((t) => t && cfg[t.para] && t.para !== id && typeof t.texto === 'string' && t.texto.trim());
          for (const t of tarefas) criarOrdem({ para: t.para, texto: t.texto, de: id, contexto: `pedido original do chefe: "${ordem.texto}"` });
          resposta = (plano.resposta || 'Plano montado.') + (tarefas.length ? `\n\nDistribuí: ${tarefas.map((t) => `${t.para} → ${t.texto}`).join(' · ')}` : '');
        }
      }
      registrarResposta(ordem, id, resposta || '(resposta vazia)', meta());
      atualizarOrdem(ordem);
      registrarStatus({ id, status: 'concluido', tarefa: 'Ordem cumprida' });
    } catch (erro) {
      console.error(`[${id}] ordem ${ordem.id}: ${erro.message}`);
      registrarResposta(ordem, id, `Erro: ${erro.message}`, { ...meta(), erro: true });
      atualizarOrdem(ordem);
      registrarStatus({ id, status: 'erro', tarefa: erro.message.slice(0, 140) });
      return;
    }
    setTimeout(() => registrarStatus({ id, status: 'ocioso', tarefa: '' }), VOLTAR_AO_OCIOSO);
  }

  function enfileirar(id, ordem) {
    const anterior = filas.get(id) || Promise.resolve();
    const atual = anterior.then(() => executar(id, ordem)).catch((erro) => console.error(erro));
    filas.set(id, atual);
  }

  // Entrega a ordem a todos os agentes com motor embutido a que ela se destina.
  function despachar(ordem) {
    const cfg = configuracao();
    const alvos = ordem.para === 'todos' ? Object.keys(cfg) : cfg[ordem.para] ? [ordem.para] : [];
    for (const id of alvos) {
      if (ordem.entregue.includes(id)) continue;
      marcarEntregue(ordem, id);
      enfileirar(id, ordem);
    }
    if (alvos.length) atualizarOrdem(ordem);
  }

  // Ao ligar: mostra quais agentes têm motor e trata ordens que ficaram para trás.
  function iniciar(estado) {
    const cfg = configuracao();
    for (const [id, c] of Object.entries(cfg)) {
      const atual = estado.get(id);
      registrarStatus({ id, motor: rotulo(c), ...(!atual || atual.status === 'trabalhando' ? { status: 'ocioso', tarefa: '' } : {}) });
    }
    for (const ordem of ordens) {
      if (ordem.estado === 'pendente') { despachar(ordem); continue; }
      // em andamento quando o servidor caiu: avisa em vez de repetir (e pagar de novo) sem você saber
      const interrompidos = ordem.entregue.filter((id) => cfg[id] && cfg[id].provedor !== 'webhook' && !ordem.respostas.some((r) => r.agente === id));
      for (const id of interrompidos) registrarResposta(ordem, id, 'Interrompida: o servidor reiniciou durante a tarefa. Envie a ordem de novo.');
      if (interrompidos.length) atualizarOrdem(ordem);
    }
    if (existsSync(arquivoEditado)) console.log(`Usando a equipe editada pela tela (${arquivoEditado}). Para voltar ao motores.json, use "Voltar ao arquivo do servidor" na tela Equipe.`);
    const n = Object.keys(cfg).length;
    console.log(n ? `Motores embutidos: ${Object.entries(cfg).map(([id, c]) => `${id} (${rotulo(c)})`).join(', ')}` : 'Nenhum motor embutido (motores.json ausente).');
  }

  // Agentes que o Decisor pode escolher: os que têm IA configurada (com a função de cada um).
  function equipe() {
    return configuracao();
  }

  return { despachar, iniciar, listar, salvarAgente, testar, restaurar, equipe, modelos };
}
