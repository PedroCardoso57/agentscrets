// Provedores de IA que um agente pode usar. Cada um recebe as instruções do
// agente (o "papel" dele) e o pedido, e devolve o texto da resposta.
// As chaves vêm de variáveis de ambiente, nunca do motores.json.

import Anthropic from '@anthropic-ai/sdk';

const TEMPO_MAXIMO = 10 * 60 * 1000; // uma tarefa pode levar alguns minutos

function chave(nomeVariavel, provedor) {
  const valor = process.env[nomeVariavel];
  if (!valor) throw new Error(`falta a chave de API do ${provedor}: defina a variável ${nomeVariavel} no servidor`);
  return valor;
}

async function postarJSON(url, cabecalhos, corpo) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabecalhos },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(TEMPO_MAXIMO),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 300)}`);
  return JSON.parse(texto);
}

// ---------- Claude (Anthropic) ----------

let clienteAnthropic = null;
// modelos que aceitam o fallback automático do servidor quando a IA recusa um pedido
const COM_FALLBACK = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// Lista "Fontes:" no fim da resposta (sem repetir endereços).
function comFontes(texto, fontes) {
  const vistas = new Map();
  for (const f of fontes) if (f.url && !vistas.has(f.url)) vistas.set(f.url, f.titulo || f.url);
  if (!vistas.size) return texto;
  return `${texto}\n\nFontes:\n${[...vistas].slice(0, 8).map(([url, titulo]) => `- ${titulo}: ${url}`).join('\n')}`;
}

// a busca com filtragem dinâmica só existe nos modelos mais novos; os outros usam a básica
const BUSCA_ANTIGA = /^claude-(haiku|3|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0)/;

async function anthropic({ modelo = 'claude-opus-5-5', instrucoes, pedido, esforco = 'medium', maxTokens = 32000, internet = false }) {
  clienteAnthropic ??= new Anthropic({ apiKey: chave('ANTHROPIC_API_KEY', 'Claude'), timeout: TEMPO_MAXIMO });
  const params = {
    model: modelo,
    max_tokens: maxTokens,
    system: instrucoes,
    messages: [{ role: 'user', content: pedido }],
  };
  if (!modelo.startsWith('claude-haiku')) params.output_config = { effort: esforco };
  if (COM_FALLBACK.has(modelo)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  if (internet) params.tools = [{ type: BUSCA_ANTIGA.test(modelo) ? 'web_search_20250305' : 'web_search_20260209', name: 'web_search', max_uses: 5 }];
  // streaming evita estourar o tempo de requisição em respostas longas
  let msg = await clienteAnthropic.beta.messages.stream(params).finalMessage();
  const blocos = [...msg.content];
  // com busca, o servidor pode pausar a vez (pause_turn): reenvia o que veio e ele continua de onde parou
  for (let i = 0; msg.stop_reason === 'pause_turn' && i < 4; i++) {
    params.messages = [params.messages[0], { role: 'assistant', content: blocos.slice() }];
    msg = await clienteAnthropic.beta.messages.stream(params).finalMessage();
    blocos.push(...msg.content);
  }
  if (msg.stop_reason === 'refusal') throw new Error('a IA recusou esta tarefa');
  const texto = blocos.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  // fontes: primeiro as citadas no texto; se não houver, as encontradas na busca
  const citadas = blocos.flatMap((b) => (b.type === 'text' && b.citations) || []).map((c) => ({ url: c.url, titulo: c.title }));
  const achadas = blocos.filter((b) => b.type === 'web_search_tool_result' && Array.isArray(b.content))
    .flatMap((b) => b.content).map((r) => ({ url: r.url, titulo: r.title }));
  const final = comFontes(texto, citadas.length ? citadas : achadas.slice(0, 5));
  if (msg.stop_reason === 'max_tokens') return `${final}\n\n[resposta cortada: limite de tamanho atingido]`;
  return final;
}

// ---------- OpenAI e APIs compatíveis (OpenRouter, DeepSeek, Groq, Ollama…) ----------

async function chatCompletions({ baseUrl, chaveApi, modelo, instrucoes, pedido }) {
  if (!modelo) throw new Error('informe "modelo" no motores.json');
  const dados = await postarJSON(`${baseUrl.replace(/\/$/, '')}/chat/completions`, chaveApi ? { Authorization: `Bearer ${chaveApi}` } : {}, {
    model: modelo,
    messages: [{ role: 'system', content: instrucoes }, { role: 'user', content: pedido }],
  });
  return (dados.choices?.[0]?.message?.content || '').trim();
}

const openai = (cfg) => chatCompletions({ ...cfg, baseUrl: 'https://api.openai.com/v1', chaveApi: chave('OPENAI_API_KEY', 'OpenAI') });

// cfg.baseUrl: endereço da API; cfg.chaveEnv: nome da variável com a chave (opcional, ex.: Ollama local não usa)
const compativel = (cfg) => {
  if (!cfg.baseUrl) throw new Error('informe "baseUrl" no motores.json');
  return chatCompletions({ ...cfg, chaveApi: cfg.chaveEnv ? chave(cfg.chaveEnv, cfg.baseUrl) : undefined });
};

// ---------- Gemini (Google) ----------

async function gemini({ modelo, instrucoes, pedido, internet = false }) {
  if (!modelo) throw new Error('informe "modelo" no motores.json');
  const dados = await postarJSON(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`,
    { 'x-goog-api-key': chave('GEMINI_API_KEY', 'Gemini') },
    {
      systemInstruction: { parts: [{ text: instrucoes }] },
      contents: [{ role: 'user', parts: [{ text: pedido }] }],
      ...(internet ? { tools: [{ google_search: {} }] } : {}), // busca no Google (grátis dentro do limite do plano)
    },
  );
  const partes = dados.candidates?.[0]?.content?.parts || [];
  const texto = partes.map((p) => p.text || '').join('').trim();
  if (!texto) throw new Error(`o Gemini não respondeu (${dados.candidates?.[0]?.finishReason || 'sem motivo'})`);
  const fontes = (dados.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map((c) => ({ url: c.web?.uri, titulo: c.web?.title }));
  return comFontes(texto, fontes);
}

// ---------- Webhook (n8n, Make, API própria) ----------

async function webhook({ webhook: url, pedido, ordem, agente }) {
  const dados = await postarJSON(url, {}, { ordem: { ...ordem, texto: pedido }, agente }).catch((erro) => {
    if (erro instanceof SyntaxError) return {}; // respondeu sem JSON: entregue, resposta virá depois
    throw erro;
  });
  return typeof dados.resposta === 'string' ? dados.resposta : null; // null = o motor responde depois pela API
}

export const PROVEDORES = { anthropic, openai, gemini, compativel, webhook };

// ---------- limite de uso (HTTP 429) e IA reserva ----------

const ehLimite = (erro) => erro?.status === 429 || /HTTP 429|rate.?limit|quota|RESOURCE_EXHAUSTED|too many requests/i.test(erro?.message || '');
// cota do dia acabou: não adianta esperar alguns segundos
const ehLimiteDiario = (erro) => /per.?day|PerDay|daily/i.test(erro?.message || '');
const ESPERA_MAXIMA = 45; // segundos

// Quanto a API pediu para esperar ("retryDelay": "23s", "retry in 23.5s", "try again in 1m2s")
function esperaPedida(erro) {
  const m = String(erro?.message || '');
  const s = m.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i) || m.match(/(?:retry|try again) in (\d+(?:\.\d+)?)\s*s/i);
  if (s) return Number(s[1]);
  const ms = m.match(/try again in (\d+)m(\d+(?:\.\d+)?)s/i);
  return ms ? Number(ms[1]) * 60 + Number(ms[2]) : 20;
}

/**
 * Chama a IA do agente. Se der limite de uso (429): espera e tenta de novo uma vez
 * (quando é limite por minuto) e, se continuar, usa a IA do agente reserva (c.reserva).
 * Devolve { texto, usado } — usado é a configuração que respondeu (a do agente ou a reserva).
 */
// O monitor de IAs (saude.js) observa cada chamada e pode dizer que uma IA está
// fora (sem crédito, chave recusada…): aí o agente vai direto para a reserva.
const observador = { aoResultado: () => {}, bloqueada: () => null };
export function observarIA({ aoResultado, bloqueada }) {
  if (aoResultado) observador.aoResultado = aoResultado;
  if (bloqueada) observador.bloqueada = bloqueada;
}

export async function chamarIA(c, args, { cfg = {}, aoEsperar = () => {} } = {}) {
  const chamar = async (conf) => {
    if (conf.provedor === 'webhook') return PROVEDORES.webhook({ ...conf, ...args });
    try {
      const texto = await PROVEDORES[conf.provedor]({ ...conf, ...args });
      observador.aoResultado(conf, null);
      return texto;
    } catch (erro) {
      observador.aoResultado(conf, erro);
      throw erro;
    }
  };
  const reservaDe = () => {
    const r = c.reserva && cfg[c.reserva];
    if (!r || r.provedor === 'webhook') return null;
    // a reserva só empresta a IA (provedor, modelo, chave); o papel e as instruções continuam do agente
    return { provedor: r.provedor, modelo: r.modelo, baseUrl: r.baseUrl, chaveEnv: r.chaveEnv, esforco: r.esforco, internet: c.internet && ['anthropic', 'gemini'].includes(r.provedor) };
  };
  // a IA do agente está fora (pelo monitor) e há reserva funcionando: nem tenta, vai direto
  const motivo = observador.bloqueada(c);
  const reserva = motivo && reservaDe();
  if (reserva && !observador.bloqueada(reserva)) {
    aoEsperar(`IA principal ${motivo}: usando a reserva (${c.reserva})`);
    return { texto: await chamar(reserva), usado: { ...reserva, reservaDe: c.reserva } };
  }
  try {
    return { texto: await chamar(c), usado: c };
  } catch (erro) {
    if (!ehLimite(erro)) throw erro;
    let ultimo = erro;
    const espera = esperaPedida(erro);
    if (!ehLimiteDiario(erro) && espera <= ESPERA_MAXIMA) {
      aoEsperar(`Limite da IA: tentando de novo em ${Math.ceil(espera)} s`);
      await new Promise((r) => setTimeout(r, (espera + 1) * 1000));
      try { return { texto: await chamar(c), usado: c }; } catch (erro2) {
        if (!ehLimite(erro2)) throw erro2;
        ultimo = erro2;
      }
    }
    const conf = reservaDe();
    if (!conf) {
      throw new Error(`limite de uso da IA atingido${c.reserva ? '' : ' (dica: escolha uma IA reserva em ⚙ Equipe)'}: ${ultimo.message.slice(0, 300)}`);
    }
    aoEsperar(`Limite da IA: usando a reserva (${c.reserva})`);
    return { texto: await chamar(conf), usado: { ...conf, reservaDe: c.reserva } };
  }
}

// ---------- lista de modelos disponíveis (para a tela Equipe) ----------

async function pegarJSON(url, cabecalhos) {
  const r = await fetch(url, { headers: cabecalhos, signal: AbortSignal.timeout(20000) });
  const texto = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 200)}`);
  return JSON.parse(texto);
}

// Pergunta ao provedor quais modelos a sua chave pode usar. Devolve os nomes em ordem alfabética.
export async function listarModelos(cfg) {
  let ids = [];
  if (cfg.provedor === 'anthropic') {
    clienteAnthropic ??= new Anthropic({ apiKey: chave('ANTHROPIC_API_KEY', 'Claude'), timeout: TEMPO_MAXIMO });
    for await (const m of clienteAnthropic.models.list()) ids.push(m.id);
  } else if (cfg.provedor === 'gemini') {
    let pagina = '';
    do {
      const dados = await pegarJSON(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pagina ? `&pageToken=${encodeURIComponent(pagina)}` : ''}`,
        { 'x-goog-api-key': chave('GEMINI_API_KEY', 'Gemini') },
      );
      for (const m of dados.models || []) {
        if ((m.supportedGenerationMethods || []).includes('generateContent')) ids.push(m.name.replace(/^models\//, ''));
      }
      pagina = dados.nextPageToken;
    } while (pagina);
  } else if (cfg.provedor === 'openai' || cfg.provedor === 'compativel') {
    const base = cfg.provedor === 'openai' ? 'https://api.openai.com/v1' : cfg.baseUrl;
    if (!base) throw new Error('informe o endereço da API (baseUrl)');
    const chaveApi = cfg.provedor === 'openai' ? chave('OPENAI_API_KEY', 'OpenAI') : cfg.chaveEnv ? chave(cfg.chaveEnv, base) : null;
    const dados = await pegarJSON(`${base.replace(/\/$/, '')}/models`, chaveApi ? { Authorization: `Bearer ${chaveApi}` } : {});
    ids = (dados.data || dados.models || []).map((m) => m.id || m.name).filter(Boolean);
  } else {
    return [];
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export const NOMES = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', compativel: 'API compatível', webhook: 'webhook' };
