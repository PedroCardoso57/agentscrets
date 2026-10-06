#!/usr/bin/env node
// Exemplo de "motores" falando com o escritório. Cada agente:
//   1. consulta se o chefe mandou alguma ordem para ele;
//   2. avisa que está trabalhando, executa e responde a ordem;
//   3. sem ordens, de vez em quando pega uma tarefa própria.
// Troque `executarComIA` pela chamada real do seu motor.
//
//   node servidor.js                     (em um terminal)
//   node exemplos/simular-motores.js     (em outro)
//
// Escritório na nuvem com senha:
//   ESCRITORIO_URL=https://seu-escritorio.onrender.com ESCRITORIO_TOKEN=... node exemplos/simular-motores.js

const URL_ESCRITORIO = process.env.ESCRITORIO_URL || 'http://localhost:8787';
const TOKEN = process.env.ESCRITORIO_TOKEN; // necessário se o escritório tiver senha
const CABECALHOS = { 'Content-Type': 'application/json', ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }) };

async function api(caminho, corpo) {
  const r = await fetch(`${URL_ESCRITORIO}${caminho}`, corpo === undefined ? { headers: CABECALHOS } : {
    method: 'POST',
    headers: CABECALHOS,
    body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error(`${caminho}: ${await r.text()}`);
  return r.json();
}

const avisar = (id, status, tarefa = '') => api('/api/status', { id, status, tarefa });
const ordensPendentes = (id) => api(`/api/ordens/pendentes?agente=${encodeURIComponent(id)}`);
const responder = (ordemId, agente, texto, status) => api(`/api/ordens/${ordemId}/resposta`, { agente, texto, status });

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const sortear = (lista) => lista[Math.floor(Math.random() * lista.length)];

// Aqui entraria a sua IA (OpenAI, Claude, n8n, um script…). Devolve o texto da resposta.
async function executarComIA(id, pedido) {
  await esperar(5000 + Math.random() * 6000);
  if (Math.random() < 0.08) throw new Error('Timeout na API externa');
  return `Feito: ${pedido}`;
}

const TAREFAS = {
  orquestrador: ['Planejando a sprint', 'Distribuindo demandas'],
  pesquisador: ['Pesquisando concorrentes', 'Lendo artigos do nicho'],
  redator: ['Escrevendo legenda', 'Roteiro de Reels'],
  designer: ['Criando carrossel', 'Editando thumbnail'],
  programador: ['Integrando webhook', 'Corrigindo automação'],
  revisor: ['Revisando legenda', 'Aprovando peças'],
};

async function cumprirOrdem(id, ordem) {
  await avisar(id, 'trabalhando', ordem.texto);
  try {
    const resposta = await executarComIA(id, ordem.texto);
    await responder(ordem.id, id, resposta, 'concluido');
  } catch (erro) {
    await responder(ordem.id, id, `Não consegui: ${erro.message}`, 'erro');
  }
  await esperar(4000);
  await avisar(id, 'ocioso');
}

async function cicloDoAgente(id) {
  await esperar(Math.random() * 3000);
  await avisar(id, 'ocioso');
  let proximaTarefaPropria = Date.now() + 10000 + Math.random() * 20000;
  for (;;) {
    try {
      const ordens = await ordensPendentes(id);
      for (const ordem of ordens) await cumprirOrdem(id, ordem); // ordens do chefe têm prioridade
      if (!ordens.length && Date.now() > proximaTarefaPropria) {
        const tarefa = sortear(TAREFAS[id]);
        await avisar(id, 'trabalhando', tarefa);
        await esperar(5000 + Math.random() * 8000);
        await avisar(id, 'concluido', `${tarefa} ✓`);
        await esperar(3000);
        await avisar(id, 'ocioso');
        proximaTarefaPropria = Date.now() + 15000 + Math.random() * 30000;
      }
    } catch (erro) {
      console.error(`[${id}]`, erro.message);
    }
    await esperar(2000); // consulta ordens a cada 2 s
  }
}

console.log(`Motores conectados a ${URL_ESCRITORIO} — Ctrl+C para parar`);
Object.keys(TAREFAS).forEach(cicloDoAgente);
