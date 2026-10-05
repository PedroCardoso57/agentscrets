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

async function anthropic({ modelo = 'claude-opus-5-5', instrucoes, pedido, esforco = 'medium', maxTokens = 32000 }) {
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
  // streaming evita estourar o tempo de requisição em respostas longas
  const msg = await clienteAnthropic.beta.messages.stream(params).finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('a IA recusou esta tarefa');
  const texto = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (msg.stop_reason === 'max_tokens') return `${texto}\n\n[resposta cortada: limite de tamanho atingido]`;
  return texto;
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

async function gemini({ modelo, instrucoes, pedido }) {
  if (!modelo) throw new Error('informe "modelo" no motores.json');
  const dados = await postarJSON(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`,
    { 'x-goog-api-key': chave('GEMINI_API_KEY', 'Gemini') },
    {
      systemInstruction: { parts: [{ text: instrucoes }] },
      contents: [{ role: 'user', parts: [{ text: pedido }] }],
    },
  );
  const partes = dados.candidates?.[0]?.content?.parts || [];
  const texto = partes.map((p) => p.text || '').join('').trim();
  if (!texto) throw new Error(`o Gemini não respondeu (${dados.candidates?.[0]?.finishReason || 'sem motivo'})`);
  return texto;
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

export const NOMES = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', compativel: 'API compatível', webhook: 'webhook' };
