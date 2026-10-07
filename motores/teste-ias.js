// Teste de todas as IAs: para cada provedor com chave configurada, lista os modelos
// que a chave enxerga e manda um "ok" bem curto para cada modelo de conversa.
// Mostra quais respondem, em quanto tempo, e o motivo real de quem falha.
// Cada teste usa poucos tokens (pedido de uma palavra, resposta limitada).

import Anthropic from '@anthropic-ai/sdk';
import { listarModelos, NOMES } from './provedores.js';
import { classificar, ESTADOS } from './saude.js';

const TEMPO_TESTE = 45000;
const PARALELO = 3;
const MAX_COMPATIVEL = 20; // APIs compatíveis (ex.: OpenRouter) listam centenas: testa as da equipe + até 20
const CHAVES = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

// Só modelos de conversa (não testa embeddings, voz, imagem, moderação…)
const NAO_CONVERSA = /embed|tts|transcri|whisper|audio|realtime|speech|image|imagen|dall-e|moderation|aqa|veo|lyria|native-audio|live|computer-use|search-preview|babbage|davinci|codex-mini/i;
function ehConversa(provedor, id) {
  if (NAO_CONVERSA.test(id)) return false;
  if (provedor === 'openai') return /^(gpt-|o\d|chatgpt)/.test(id) && !/instruct/i.test(id); // *-instruct não é de conversa na OpenAI
  if (provedor === 'gemini') return /^(gemini|gemma)/.test(id);
  return true;
}

// tira o essencial de erros que vêm em JSON
const limpar = (m) => String(m || '').match(/"message"\s*:\s*"([^"]{3,})"/)?.[1] || String(m || '');

async function postar(url, cabecalhos, corpo) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cabecalhos }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(TEMPO_TESTE) });
  const texto = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 600)}`);
  return JSON.parse(texto || '{}');
}

// Um pedido mínimo, sem recursos extras (para não falhar por parâmetro e sim por motivo real)
let clienteAnthropic = null;
async function testarModelo(alvo, modelo) {
  const pedido = 'Responda apenas com a palavra: ok';
  if (alvo.provedor === 'anthropic') {
    clienteAnthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: TEMPO_TESTE, maxRetries: 0 });
    const msg = await clienteAnthropic.messages.create({ model: modelo, max_tokens: 16, messages: [{ role: 'user', content: pedido }] });
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }
  if (alvo.provedor === 'gemini') {
    const dados = await postar(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, { 'x-goog-api-key': process.env.GEMINI_API_KEY }, {
      contents: [{ role: 'user', parts: [{ text: pedido }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
    if (dados.promptFeedback?.blockReason) throw new Error(`bloqueado: ${dados.promptFeedback.blockReason}`);
    return (dados.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  }
  // OpenAI e compatíveis
  const base = alvo.provedor === 'openai' ? 'https://api.openai.com/v1' : alvo.baseUrl.replace(/\/$/, '');
  const chave = alvo.provedor === 'openai' ? process.env.OPENAI_API_KEY : alvo.chaveEnv ? process.env[alvo.chaveEnv] : '';
  const limite = alvo.provedor === 'openai' ? { max_completion_tokens: 64 } : { max_tokens: 16 };
  const dados = await postar(`${base}/chat/completions`, chave ? { Authorization: `Bearer ${chave}` } : {}, { model: modelo, messages: [{ role: 'user', content: pedido }], ...limite });
  return (dados.choices?.[0]?.message?.content || '').trim();
}

export function criarTesteIas({ equipe, aoResultado = () => {} }) {
  let execucao = { rodando: false, inicio: null, fim: null, total: 0, feitos: 0, provedores: [], resultados: [] };

  // Provedores a testar: os de chave conhecida e as APIs compatíveis usadas pela equipe
  function alvos() {
    const cfg = equipe();
    const lista = Object.keys(CHAVES).map((provedor) => ({ provedor, nome: NOMES[provedor], chaveEnv: CHAVES[provedor] }));
    const vistos = new Set();
    for (const c of Object.values(cfg)) {
      if (c.provedor !== 'compativel' || !c.baseUrl || vistos.has(c.baseUrl)) continue;
      vistos.add(c.baseUrl);
      lista.push({ provedor: 'compativel', nome: `${NOMES.compativel} · ${c.baseUrl.replace(/^https?:\/\//, '').split('/')[0]}`, baseUrl: c.baseUrl, chaveEnv: c.chaveEnv });
    }
    return lista;
  }

  // quem da equipe usa cada modelo (e de quem é reserva)
  function usos(alvo, modelo) {
    const cfg = equipe();
    const mesmo = (c) => c && c.provedor === alvo.provedor && c.modelo === modelo && (alvo.provedor !== 'compativel' || c.baseUrl === alvo.baseUrl);
    return {
      usadoPor: Object.entries(cfg).filter(([, c]) => mesmo(c)).map(([id]) => id),
      reservaDe: Object.entries(cfg).filter(([, c]) => mesmo(cfg[c.reserva])).map(([id]) => id),
    };
  }

  async function rodar() {
    if (execucao.rodando) return ver();
    execucao = { rodando: true, inicio: new Date().toISOString(), fim: null, total: 0, feitos: 0, provedores: [], resultados: [] };
    const fila = [];
    for (const alvo of alvos()) {
      const p = { provedor: alvo.provedor, nome: alvo.nome, estado: 'ok', mensagem: '', modelos: 0 };
      execucao.provedores.push(p);
      if (alvo.chaveEnv && !process.env[alvo.chaveEnv]) {
        Object.assign(p, { estado: 'sem-chave', mensagem: `${alvo.chaveEnv} não está definida no .env do servidor` });
        continue;
      }
      let modelos;
      try {
        modelos = await listarModelos({ provedor: alvo.provedor, baseUrl: alvo.baseUrl, chaveEnv: alvo.chaveEnv });
      } catch (erro) {
        Object.assign(p, { estado: classificar(erro.message), mensagem: limpar(erro.message).slice(0, 500), bruto: erro.message.slice(0, 1500) });
        continue;
      }
      let conversa = modelos.filter((m) => ehConversa(alvo.provedor, m));
      // modelos da equipe que nem aparecem na lista também entram (e vão falhar com o motivo)
      const daEquipe = Object.values(equipe()).filter((c) => c.provedor === alvo.provedor && c.modelo && (alvo.provedor !== 'compativel' || c.baseUrl === alvo.baseUrl)).map((c) => c.modelo);
      if (alvo.provedor === 'compativel') conversa = [...new Set([...daEquipe, ...conversa.slice(0, MAX_COMPATIVEL)])];
      else conversa = [...new Set([...conversa, ...daEquipe])];
      p.modelos = conversa.length;
      for (const modelo of conversa) fila.push({ alvo, modelo });
    }
    execucao.total = fila.length;
    // testa em paralelo, alguns por vez
    const trabalhar = async () => {
      for (let item = fila.shift(); item; item = fila.shift()) {
        const { alvo, modelo } = item;
        const inicio = Date.now();
        const r = { provedor: alvo.provedor, nomeProvedor: alvo.nome, modelo, ...(alvo.provedor === 'compativel' ? { baseUrl: alvo.baseUrl, chaveEnv: alvo.chaveEnv || '' } : {}), ...usos(alvo, modelo) };
        try {
          const resposta = await Promise.race([testarModelo(alvo, modelo), new Promise((_, nao) => setTimeout(() => nao(new Error(`sem resposta em ${TEMPO_TESTE / 1000} s (timeout)`)), TEMPO_TESTE))]);
          Object.assign(r, { estado: 'ok', ms: Date.now() - inicio, resposta: String(resposta || '(resposta vazia, mas a IA atendeu)').slice(0, 80) });
          aoResultado({ provedor: alvo.provedor, modelo, baseUrl: alvo.baseUrl, chaveEnv: alvo.provedor === 'compativel' ? alvo.chaveEnv : undefined }, null);
        } catch (erro) {
          const estado = classificar(erro.message);
          Object.assign(r, { estado, ms: Date.now() - inicio, mensagem: limpar(erro.message).slice(0, 500), bruto: String(erro.message).slice(0, 1500) });
          if (r.usadoPor.length || r.reservaDe.length) aoResultado({ provedor: alvo.provedor, modelo, baseUrl: alvo.baseUrl, chaveEnv: alvo.provedor === 'compativel' ? alvo.chaveEnv : undefined }, erro);
        }
        execucao.resultados.push(r);
        execucao.feitos++;
      }
    };
    Promise.all(Array.from({ length: PARALELO }, trabalhar)).finally(() => {
      execucao.rodando = false;
      execucao.fim = new Date().toISOString();
      const ok = execucao.resultados.filter((x) => x.estado === 'ok').length;
      console.log(`[ias] teste de todas: ${ok} de ${execucao.total} modelos responderam`);
    });
    return ver();
  }

  function ver() {
    const ordem = (x) => (x.usadoPor.length || x.reservaDe.length ? 0 : 1) * 10 + (x.estado === 'ok' ? 0 : 1);
    return {
      ...execucao,
      estados: ESTADOS,
      resultados: [...execucao.resultados].sort((a, b) => a.provedor.localeCompare(b.provedor) || ordem(a) - ordem(b) || a.modelo.localeCompare(b.modelo)),
    };
  }

  return { rodar, ver };
}
