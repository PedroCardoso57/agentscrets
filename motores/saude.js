// Monitor de IAs: fica de olho em quais IAs da equipe estão funcionando.
//
// - De tempos em tempos (SAUDE_INTERVALO_MIN, padrão 15 min) confere cada IA usada
//   pela equipe: a chave existe? o provedor aceita a chave? o modelo escolhido existe?
//   Essa conferência só lista os modelos: não gasta tokens.
// - Também aprende com o uso de verdade: se uma tarefa falha por falta de crédito,
//   limite de uso ou chave recusada, a IA é marcada na hora; se responde, volta a ok.
// - IA marcada como sem crédito ou com limite: de tempos em tempos manda um "oi" bem
//   curto (poucos tokens) para saber se já voltou.
// - Mudou de estado: avisa no registro de erros e no Telegram. Quando volta, as tarefas
//   paradas dos agentes que usam essa IA são retomadas na hora.
// - IA sem crédito, sem chave, com chave recusada ou modelo inexistente: o agente
//   vai direto para a IA reserva dele (ver chamarIA), sem perder tempo tentando.

import { PROVEDORES, listarModelos, observarIA, NOMES } from './provedores.js';

const INTERVALO_MS = (Number(process.env.SAUDE_INTERVALO_MIN) || 15) * 60000;
const REPROVA_MS = (Number(process.env.SAUDE_REPROVA_MIN) || 15) * 60000; // "oi" de teste numa IA marcada com problema
const CHAVES = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

export const ESTADOS = {
  verificando: '⏳ verificando',
  ok: '🟢 funcionando',
  limite: '🟡 limite de uso atingido',
  'sem-credito': '🔴 sem crédito',
  chave: '🔴 chave recusada',
  'sem-chave': '🔴 sem chave no .env',
  modelo: '🔴 modelo não existe',
  fora: '🟠 fora do ar',
  erro: '🟠 com erro',
  externo: '⚪ motor externo (webhook)',
};
// com esses, nem adianta tentar: vai direto para a reserva
const BLOQUEANTES = new Set(['sem-credito', 'chave', 'sem-chave', 'modelo']);

export const chaveIA = (c) => [c.provedor, c.modelo || '', c.baseUrl || '', c.chaveEnv || ''].join('|');

// Traduz a mensagem de erro de qualquer provedor num estado
export function classificar(mensagem) {
  const m = String(mensagem || '');
  if (/falta a chave/i.test(m)) return 'sem-chave';
  if (/credit balance|insufficient_quota|billing|payment required|HTTP 402/i.test(m)) return 'sem-credito';
  if (/^\s*40[13]\b|HTTP 401|HTTP 403|invalid.?(x-)?api.?key|authentication_error|unauthorized|permission_denied|API key not valid|API_KEY_INVALID/i.test(m)) return 'chave';
  if (/^\s*404\b|HTTP 404|not_found_error|model[^.]{0,40}(not found|does not exist|not supported)/i.test(m)) return 'modelo';
  if (/^\s*429\b|HTTP 429|rate.?limit|quota|RESOURCE_EXHAUSTED|too many requests|limite de uso/i.test(m)) return 'limite';
  if (/^\s*5\d\d\b|HTTP 5\d\d|overloaded|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|timeout|aborted|socket/i.test(m)) return 'fora';
  return 'erro';
}

// como o estado aparece numa frase: "a IA X está sem crédito"
const FRASE = {
  limite: 'no limite de uso', 'sem-credito': 'sem crédito', chave: 'com a chave recusada', 'sem-chave': 'sem chave no .env',
  modelo: 'com um modelo que não existe', fora: 'fora do ar', erro: 'com erro',
};
// tira o essencial de erros que vêm em JSON ({"error":{"message":"..."}})
const limparMensagem = (m) => String(m || '').match(/"message"\s*:\s*"([^"]{3,})"/)?.[1] || String(m || '').replace(/^Erro:\s*/, '');

const rotuloIA = (c) => `${NOMES[c.provedor] || c.provedor}${c.modelo ? ` · ${c.modelo}` : ''}`;

export function criarSaude({ equipe, avisar = () => {}, aoVoltar = () => {}, mudou = () => {} }) {
  const ias = new Map(); // chave → { chave, conf, rotulo, estado, mensagem, desde, verificadoEm, origem }
  let relogio = null;
  let rodando = false;

  // IAs usadas pela equipe (agentes e reservas), com quem usa cada uma
  function iasDaEquipe() {
    const cfg = equipe();
    const grupos = new Map();
    for (const [id, c] of Object.entries(cfg)) {
      const k = chaveIA(c);
      if (!grupos.has(k)) grupos.set(k, { conf: { provedor: c.provedor, modelo: c.modelo, baseUrl: c.baseUrl, chaveEnv: c.chaveEnv }, agentes: [], reservaDe: [] });
      grupos.get(k).agentes.push(id);
      if (c.reserva && cfg[c.reserva]) {
        const r = cfg[c.reserva];
        const kr = chaveIA(r);
        if (!grupos.has(kr)) grupos.set(kr, { conf: { provedor: r.provedor, modelo: r.modelo, baseUrl: r.baseUrl, chaveEnv: r.chaveEnv }, agentes: [], reservaDe: [] });
        grupos.get(kr).reservaDe.push(id);
      }
    }
    return grupos;
  }

  function registro(k, conf) {
    if (!ias.has(k)) ias.set(k, { chave: k, conf, rotulo: rotuloIA(conf), estado: conf.provedor === 'webhook' ? 'externo' : 'verificando', mensagem: '', desde: new Date().toISOString(), verificadoEm: null });
    return ias.get(k);
  }

  // Muda o estado de uma IA e avisa quando ela cai ou volta.
  function definir(conf, estado, mensagem = '', origem = 'verificação') {
    const k = chaveIA(conf);
    const ia = registro(k, conf);
    const antes = ia.estado;
    ia.verificadoEm = new Date().toISOString();
    ia.origem = origem;
    ia.mensagem = estado === 'ok' ? '' : limparMensagem(mensagem).slice(0, 400);
    if (antes === estado) return;
    ia.estado = estado;
    ia.desde = ia.verificadoEm;
    const quem = [...(iasDaEquipe().get(k)?.agentes || [])];
    const nomes = quem.length ? ` (usada por: ${quem.join(', ')})` : '';
    if (estado === 'ok' && antes !== 'verificando') {
      avisar(`✅ A IA ${ia.rotulo} voltou a funcionar${nomes}.`, 'ok');
      aoVoltar(quem);
    } else if (estado !== 'ok' && estado !== 'verificando' && estado !== 'externo') {
      const semReserva = quem.filter((id) => !equipe()[id]?.reserva);
      const dica = BLOQUEANTES.has(estado) || estado === 'limite'
        ? semReserva.length ? ` Sem IA reserva: ${semReserva.join(', ')} (escolha uma em ⚙ Equipe).` : ' Os agentes estão usando a IA reserva.'
        : '';
      avisar(`⚠️ A IA ${ia.rotulo} está ${FRASE[estado] || estado}${nomes}.${dica}${ia.mensagem ? ` Detalhe: ${ia.mensagem.slice(0, 160)}` : ''}`, 'problema');
    }
    console.log(`[ias] ${ia.rotulo}: ${ESTADOS[antes]} → ${ESTADOS[estado]}`);
    mudou();
  }

  // Uso real: cada resposta (ou erro) das IAs atualiza o estado na hora
  function aoResultado(conf, erro) {
    if (!conf?.provedor || conf.provedor === 'webhook') return;
    if (!erro) return definir(conf, 'ok', '', 'uso');
    const estado = classificar(erro.message);
    if (estado === 'erro') return; // erro do pedido (não da IA): não muda nada
    definir(conf, estado, erro.message, 'uso');
  }

  function bloqueada(conf) {
    const ia = ias.get(chaveIA(conf));
    return ia && BLOQUEANTES.has(ia.estado) ? ESTADOS[ia.estado].replace(/^\S+\s/, '') : null;
  }

  // Confere uma IA. A lista de modelos não gasta tokens; o "oi" só é usado quando a IA
  // está marcada com limite ou sem crédito (a lista de modelos não enxerga isso).
  async function conferir(conf) {
    const ia = registro(chaveIA(conf), conf);
    if (conf.provedor === 'webhook') return;
    const env = conf.chaveEnv || CHAVES[conf.provedor];
    if (env && !process.env[env] && conf.provedor !== 'compativel') return definir(conf, 'sem-chave', `defina ${env} no .env do servidor`);
    try {
      const modelos = await listarModelos(conf);
      if (conf.modelo && modelos.length && !modelos.some((m) => m === conf.modelo || m.startsWith(`${conf.modelo}-`))) {
        return definir(conf, 'modelo', `o modelo "${conf.modelo}" não aparece na lista da sua chave`);
      }
    } catch (erro) {
      const estado = classificar(erro.message);
      return definir(conf, estado === 'erro' ? 'fora' : estado, erro.message);
    }
    const recente = Date.now() - Date.parse(ia.verificadoEm || 0) < REPROVA_MS;
    if (['limite', 'sem-credito'].includes(ia.estado)) {
      if (recente && ia.origem === 'uso') return; // acabou de falhar de verdade: espera um pouco
      try {
        await PROVEDORES[conf.provedor]({ ...conf, instrucoes: 'Responda apenas: ok', pedido: 'ok', maxTokens: 16, esforco: 'low', internet: false });
        return definir(conf, 'ok', '', 'teste');
      } catch (erro) {
        const estado = classificar(erro.message);
        return definir(conf, estado === 'erro' ? ia.estado : estado, erro.message, 'teste');
      }
    }
    if (['verificando', 'chave', 'sem-chave', 'modelo', 'fora', 'erro'].includes(ia.estado)) definir(conf, 'ok');
    else ia.verificadoEm = new Date().toISOString();
  }

  async function verificar() {
    if (rodando) return listar();
    rodando = true;
    try {
      const grupos = iasDaEquipe();
      // IAs que ninguém usa mais saem da lista
      for (const k of ias.keys()) if (!grupos.has(k)) ias.delete(k);
      for (const { conf } of grupos.values()) await conferir(conf).catch((erro) => console.warn(`[ias] ${rotuloIA(conf)}: ${erro.message}`));
      mudou();
    } finally {
      rodando = false;
    }
    return listar();
  }

  function listar() {
    const grupos = iasDaEquipe();
    return [...grupos].map(([k, g]) => {
      const ia = registro(k, g.conf);
      return { chave: k, rotulo: ia.rotulo, provedor: g.conf.provedor, modelo: g.conf.modelo || '', estado: ia.estado, descricao: ESTADOS[ia.estado], mensagem: ia.mensagem, desde: ia.desde, verificadoEm: ia.verificadoEm, agentes: g.agentes, reservaDe: g.reservaDe };
    });
  }

  // estado da IA de cada agente (para a lista da equipe)
  function porAgente() {
    const cfg = equipe();
    return Object.fromEntries(Object.entries(cfg).map(([id, c]) => {
      const ia = ias.get(chaveIA(c));
      return [id, ia ? { estado: ia.estado, descricao: ESTADOS[ia.estado], mensagem: ia.mensagem } : null];
    }));
  }

  function iniciar() {
    observarIA({ aoResultado, bloqueada });
    if (process.env.SAUDE_IAS === '0') return;
    setTimeout(() => verificar().catch(() => {}), 4000).unref?.();
    relogio ??= setInterval(() => verificar().catch(() => {}), INTERVALO_MS);
    relogio.unref?.();
    console.log(`[ias] monitor ligado: confere as IAs da equipe a cada ${Math.round(INTERVALO_MS / 60000)} min`);
  }

  return { iniciar, verificar, listar, porAgente, bloqueada, registrarUso: aoResultado };
}
