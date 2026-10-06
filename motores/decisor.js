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
  const confiancaMinima = () => Number(process.env.LAYA_CONFIANCA_MINIMA || 0.25); // média entre vários agentes: a líder costuma ficar abaixo de 50%

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

  // Pergunta ao Laya qual agente combina com o pedido e qual a urgência.
  // equipe: { id: { funcao } } dos agentes que podem receber a ordem
  async function consultar(texto, equipe) {
    if (!ativo()) throw new Error('o Laya não está configurado (defina LAYA_URL no .env)');
    const criterios = {};
    for (const [id, c] of Object.entries(equipe)) {
      criterios[id] = id === 'orquestrador' || c.delegar ? DESCRICAO_ORQUESTRADOR : c.funcao || id;
    }
    if (Object.keys(criterios).length < 2) throw new Error('o Laya precisa de pelo menos dois agentes com função para escolher');

    const inicio = Date.now();
    // O Laya favorece opções pela POSIÇÃO na lista (documentado pelo projeto). Para anular isso,
    // a mesma pergunta vai girada k vezes, cada agente passando por todas as posições, e tiramos a
    // média (receita oficial do Laya). As k rotações vão na mesma chamada: custa quase nada a mais.
    const ids = Object.keys(criterios);
    const k = ids.length;
    const perguntaAgente = { type: 'choice', instructions: 'Qual membro da equipe deve cuidar deste pedido?', criteria: criterios };
    const questions = { urgencia: { type: 'score', instructions: 'Quão urgente é este pedido?', criteria: URGENCIAS } };
    for (let r = 0; r < k; r++) questions[`agente${r}`] = { ...perguntaAgente, option_order: ids.map((_, i) => (i + r) % k) };
    const resultado = await perguntar(texto, questions);

    const media = Object.fromEntries(ids.map((id) => [id, 0]));
    let respostas = 0;
    for (let r = 0; r < k; r++) {
      const probs = resultado.answers?.[`agente${r}`]?.probabilities;
      if (!probs) continue;
      respostas++;
      for (const id of ids) media[id] += (probs[id] || 0) / k;
    }
    if (!respostas) throw new Error('o Laya não devolveu uma escolha');
    const ranking = Object.entries(media).sort((a, b) => b[1] - a[1]);
    const urgencia = resultado.answers?.urgencia;
    return {
      escolha: ranking[0][0],
      confianca: Math.round(ranking[0][1] * 100) / 100,
      // as 3 mais prováveis, para o chefe ver por que ele escolheu
      ranking: ranking.slice(0, 3).map(([id, p]) => ({ id, p: Math.round(p * 100) / 100 })),
      urgencia: urgencia ? URGENCIAS[Math.min(URGENCIAS.length - 1, Math.round(urgencia.score))] : null,
      ms: Date.now() - inicio,
    };
  }

  const orquestradorDe = (equipe) => Object.keys(equipe).find((id) => id === 'orquestrador' || equipe[id].delegar);

  // Ordem "Crânio decide": o Crânio escolhe; na dúvida, manda para o Orquestrador.
  async function decidir(texto, equipe) {
    const r = await consultar(texto, equipe);
    const orq = orquestradorDe(equipe);
    const incerto = r.confianca < confiancaMinima() && orq && r.escolha !== orq;
    return {
      por: 'Laya', modo: 'escolheu', agente: incerto ? orq : r.escolha, escolhaOriginal: r.escolha,
      confianca: r.confianca, ranking: r.ranking, incerto: Boolean(incerto), urgencia: r.urgencia, ms: r.ms,
    };
  }

  // Ordem com agente já indicado (pelo chefe ou por um agente que delega): passa pelo Crânio.
  // - do chefe: a palavra do chefe vale; o Crânio confirma ou registra quem ele indicaria.
  // - de um agente: se o Crânio tiver certeza de que outro agente é mais adequado, redireciona.
  async function avaliar(texto, equipe, sugerido, de = 'chefe') {
    const r = await consultar(texto, equipe);
    const base = { por: 'Laya', sugerido, escolhaOriginal: r.escolha, confianca: r.confianca, ranking: r.ranking, urgencia: r.urgencia, ms: r.ms };
    if (r.escolha === sugerido || !equipe[r.escolha]) return { ...base, modo: 'confirmou', agente: sugerido };
    if (de === 'chefe') return { ...base, modo: 'alertou', agente: sugerido };
    const redireciona = r.confianca >= confiancaMinima() && r.escolha !== de; // nunca devolve a tarefa a quem delegou
    return { ...base, modo: redireciona ? 'redirecionou' : 'confirmou', agente: redireciona ? r.escolha : sugerido };
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

  return { ativo, online, decidir, avaliar, verificar };
}
