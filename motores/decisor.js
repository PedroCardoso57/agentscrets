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
  // Dois jeitos de perguntar ao Laya, combinados por padrão (LAYA_METODO = combinado | escolha | simnao):
  // - escolha: "qual destes agentes?", girando a lista k vezes para anular o viés de posição do Laya;
  // - simnao:  para cada agente, "este pedido é sobre <função>?" (sim/não), sem lista e sem posição.
  // Tudo vai numa única chamada ao Laya.
  // Calibração por contexto vazio: quanto o Laya prefere cada agente SEM pedido nenhum.
  // Essa preferência "de fábrica" é descontada das respostas reais. Guardada por configuração da equipe.
  const priores = new Map();
  async function prior(criterios, montar) {
    const chave = JSON.stringify(criterios);
    if (!priores.has(chave)) {
      const neutros = ['N/A', 'pedido', '[sem conteúdo]'];
      const leituras = [];
      for (const n of neutros) leituras.push(montar(await perguntar(n, montar.questions)));
      const media = (campo) => Object.fromEntries(Object.keys(criterios).map((id) => [id, leituras.reduce((a, l) => a + l[campo][id], 0) / leituras.length]));
      priores.set(chave, { escolha: media('escolha'), sim: media('sim') });
      if (priores.size > 20) priores.delete(priores.keys().next().value);
    }
    return priores.get(chave);
  }

  async function consultar(texto, equipe, { detalhes = false } = {}) {
    if (!ativo()) throw new Error('o Laya não está configurado (defina LAYA_URL no .env)');
    const criterios = {};
    for (const [id, c] of Object.entries(equipe)) {
      criterios[id] = id === 'orquestrador' || c.delegar ? DESCRICAO_ORQUESTRADOR : c.funcao || id;
    }
    const ids = Object.keys(criterios);
    const k = ids.length;
    if (k < 2) throw new Error('o Laya precisa de pelo menos dois agentes com função para escolher');
    const metodo = ['escolha', 'simnao'].includes(process.env.LAYA_METODO) ? process.env.LAYA_METODO : 'combinado';

    const inicio = Date.now();
    const perguntaAgente = { type: 'choice', instructions: 'Qual membro da equipe deve cuidar deste pedido?', criteria: criterios };
    const questions = { urgencia: { type: 'score', instructions: 'Quão urgente é este pedido?', criteria: URGENCIAS } };
    for (let r = 0; r < k; r++) questions[`agente${r}`] = { ...perguntaAgente, option_order: ids.map((_, i) => (i + r) % k) };
    ids.forEach((id, n) => { questions[`sim${n}`] = { type: 'noul', instructions: `Este pedido é trabalho de quem: ${criterios[id]}?` }; });
    // lê uma resposta do Laya: média das rotações (escolha) e P(sim) de cada agente
    const ler = (resultado) => {
      const ans = resultado.answers || {};
      const escolha = Object.fromEntries(ids.map((id) => [id, 0]));
      const porRotacao = [];
      for (let r = 0; r < k; r++) {
        const a = ans[`agente${r}`];
        if (!a?.probabilities) continue;
        porRotacao.push(a.choice);
        for (const id of ids) escolha[id] += (a.probabilities[id] || 0) / k;
      }
      const sim = Object.fromEntries(ids.map((id, n) => [id, Number(ans[`sim${n}`]?.noul ?? 0)]));
      return { escolha, sim, porRotacao, urgencia: ans.urgencia };
    };
    ler.questions = questions;

    const leitura = ler(await perguntar(texto, questions));
    if (!leitura.porRotacao.length && !Object.values(leitura.sim).some(Boolean)) throw new Error('o Laya não devolveu uma escolha');
    const base = await prior(criterios, ler);

    // desconta a preferência "de fábrica" e normaliza cada método para somar 1
    const calibrar = (atual, vazio) => {
      const bruto = Object.fromEntries(ids.map((id) => [id, atual[id] / Math.max(vazio[id], 0.01)]));
      const soma = Object.values(bruto).reduce((a, x) => a + x, 0) || 1;
      return Object.fromEntries(ids.map((id) => [id, bruto[id] / soma]));
    };
    const escolha = calibrar(leitura.escolha, base.escolha);
    const simNorm = calibrar(leitura.sim, base.sim);
    const porRotacao = leitura.porRotacao;
    const sim = leitura.sim;

    const final = Object.fromEntries(ids.map((id) => [id,
      metodo === 'escolha' ? escolha[id] : metodo === 'simnao' ? simNorm[id] : (escolha[id] + simNorm[id]) / 2]));
    const ranking = Object.entries(final).sort((a, b) => b[1] - a[1]);
    const urgencia = leitura.urgencia;
    const r2 = (x) => Math.round(x * 100) / 100;
    const saida = {
      escolha: ranking[0][0],
      confianca: r2(ranking[0][1]),
      // as 3 mais prováveis, para o chefe ver por que ele escolheu
      ranking: ranking.slice(0, 3).map(([id, p]) => ({ id, p: r2(p) })),
      urgencia: urgencia ? URGENCIAS[Math.min(URGENCIAS.length - 1, Math.round(urgencia.score))] : null,
      ms: Date.now() - inicio,
    };
    if (detalhes) {
      saida.diagnostico = {
        metodo,
        criterios,
        escolhaPorRotacao: porRotacao,
        semPedido: { escolha: Object.fromEntries(ids.map((id) => [id, r2(base.escolha[id])])), simNao: Object.fromEntries(ids.map((id) => [id, r2(base.sim[id])])) },
        comPedido: { escolha: Object.fromEntries(ids.map((id) => [id, r2(leitura.escolha[id])])), simNao: Object.fromEntries(ids.map((id) => [id, r2(sim[id])])) },
        calibrado: { escolha: Object.fromEntries(ids.map((id) => [id, r2(escolha[id])])), simNao: Object.fromEntries(ids.map((id) => [id, r2(simNorm[id])])) },
        final: Object.fromEntries(ranking.map(([id, p]) => [id, r2(p)])),
      };
    }
    return saida;
  }

  // Para a página de diagnóstico: o que o Crânio perguntou e como cada agente pontuou.
  async function diagnosticar(texto, equipe) {
    return consultar(texto, equipe, { detalhes: true });
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

  return { ativo, online, decidir, avaliar, diagnosticar, verificar };
}
