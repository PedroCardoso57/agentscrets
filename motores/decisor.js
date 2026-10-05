// Decisor: o Laya (modelo de decisão open source, Apache 2.0) escolhe qual
// agente deve cumprir uma ordem mandada para "Automático" e quão urgente ela é.
// O Laya não escreve texto: ele escolhe entre opções e diz a certeza, em
// milissegundos, rodando no seu próprio servidor (sem custo por uso).
//
// Liga com LAYA_URL no .env (ex.: http://laya:8000, o serviço do docker-compose).
// Fala o protocolo do servidor oficial `laya-serve`: POST /v1/systemone.

const URGENCIAS = ['pode esperar', 'esta semana', 'hoje', 'urgente, agora'];
const DESCRICAO_ORQUESTRADOR = 'pedidos grandes, campanhas, projetos ou planos que precisam de vários especialistas trabalhando juntos';

export function criarDecisor() {
  const url = () => (process.env.LAYA_URL || '').replace(/\/$/, '');
  // abaixo desta certeza, o pedido vai para o Orquestrador em vez de arriscar o agente errado
  const confiancaMinima = () => Number(process.env.LAYA_CONFIANCA_MINIMA || 0.35);

  const ativo = () => Boolean(url());

  async function perguntar(texto, questions) {
    const r = await fetch(`${url()}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.LAYA_API_KEY && { Authorization: `Bearer ${process.env.LAYA_API_KEY}` }) },
      // o checkpoint multilíngue entende português
      body: JSON.stringify({ state: texto, questions, model: 'multilingual' }),
      signal: AbortSignal.timeout(120000), // a primeira chamada pode carregar o modelo na memória
    });
    const corpo = await r.text();
    if (!r.ok) throw new Error(`Laya respondeu HTTP ${r.status}: ${corpo.slice(0, 200)}`);
    return JSON.parse(corpo);
  }

  // equipe: { id: { funcao } } dos agentes que podem receber a ordem
  async function decidir(texto, equipe) {
    if (!ativo()) throw new Error('o Laya não está configurado (defina LAYA_URL no .env)');
    const criterios = {};
    for (const [id, c] of Object.entries(equipe)) {
      criterios[id] = id === 'orquestrador' || c.delegar ? DESCRICAO_ORQUESTRADOR : c.funcao || id;
    }
    if (Object.keys(criterios).length < 2) throw new Error('o Laya precisa de pelo menos dois agentes com função para escolher');

    const inicio = Date.now();
    const resultado = await perguntar(texto, {
      agente: { type: 'choice', instructions: 'Qual membro da equipe deve cuidar deste pedido?', criteria: criterios },
      urgencia: { type: 'score', instructions: 'Quão urgente é este pedido?', criteria: URGENCIAS },
    });
    const agente = resultado.answers?.agente;
    const urgencia = resultado.answers?.urgencia;
    if (!agente?.choice) throw new Error('o Laya não devolveu uma escolha');

    const confianca = agente.answer_confidence ?? agente.probabilities?.[agente.choice] ?? 0;
    const temOrquestrador = Object.keys(equipe).find((id) => id === 'orquestrador' || equipe[id].delegar);
    const incerto = confianca < confiancaMinima() && temOrquestrador && agente.choice !== temOrquestrador;
    return {
      por: 'Laya',
      agente: incerto ? temOrquestrador : agente.choice,
      escolhaOriginal: agente.choice,
      confianca: Math.round(confianca * 100) / 100,
      incerto: Boolean(incerto),
      urgencia: urgencia ? URGENCIAS[Math.min(URGENCIAS.length - 1, Math.round(urgencia.score))] : null,
      ms: Date.now() - inicio,
    };
  }

  // O Laya está respondendo agora? (guardado por 20 s para não consultar a cada clique)
  let ultimaChecagem = { em: 0, online: false };
  async function online() {
    if (!ativo()) return false;
    if (Date.now() - ultimaChecagem.em < 20000) return ultimaChecagem.online;
    let ok = false;
    try { ok = (await fetch(`${url()}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { ok = false; }
    ultimaChecagem = { em: Date.now(), online: ok };
    return ok;
  }

  async function verificar() {
    if (!ativo()) return;
    try {
      const r = await fetch(`${url()}/health`, { signal: AbortSignal.timeout(5000) });
      console.log(`Decisor Laya em ${url()}: ${r.ok ? 'no ar' : `HTTP ${r.status}`}`);
    } catch (erro) {
      console.warn(`Decisor Laya em ${url()} ainda não respondeu (${erro.message}); ele pode estar baixando o modelo.`);
    }
  }

  return { ativo, online, decidir, verificar };
}
