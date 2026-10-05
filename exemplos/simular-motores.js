#!/usr/bin/env node
// Exemplo de "motor" falando com o escritório. Simula cada agente pegando
// uma tarefa, trabalhando e entregando — troque pela chamada real do seu motor.
//
//   node servidor.js                     (em um terminal)
//   node exemplos/simular-motores.js     (em outro)

const URL_ESCRITORIO = process.env.ESCRITORIO_URL || 'http://localhost:8787';

async function avisar(id, status, tarefa = '') {
  const r = await fetch(`${URL_ESCRITORIO}/api/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status, tarefa }),
  });
  if (!r.ok) console.error(`[${id}]`, await r.text());
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const sortear = (lista) => lista[Math.floor(Math.random() * lista.length)];

// Envolve qualquer função assíncrona do seu motor e reporta o andamento.
async function executar(id, tarefa, trabalho) {
  await avisar(id, 'trabalhando', tarefa);
  try {
    await trabalho();
    await avisar(id, 'concluido', `${tarefa} ✓`);
  } catch (erro) {
    await avisar(id, 'erro', erro.message);
  }
  await esperar(3000);
  await avisar(id, 'ocioso');
}

const TAREFAS = {
  orquestrador: ['Planejando a sprint', 'Distribuindo demandas'],
  pesquisador: ['Pesquisando concorrentes', 'Lendo artigos do nicho'],
  redator: ['Escrevendo legenda', 'Roteiro de Reels'],
  designer: ['Criando carrossel', 'Editando thumbnail'],
  analista: ['Relatório de anúncios', 'Calculando ROI'],
  programador: ['Integrando webhook', 'Corrigindo automação'],
  atendimento: ['Respondendo WhatsApp', 'Retornando cliente'],
  revisor: ['Revisando legenda', 'Aprovando peças'],
};

async function cicloDoAgente(id) {
  await esperar(Math.random() * 4000);
  for (;;) {
    await executar(id, sortear(TAREFAS[id]), async () => {
      await esperar(5000 + Math.random() * 8000);
      if (Math.random() < 0.1) throw new Error('Timeout na API externa');
    });
    await esperar(2000 + Math.random() * 6000);
  }
}

console.log(`Enviando status para ${URL_ESCRITORIO} — Ctrl+C para parar`);
Object.keys(TAREFAS).forEach(cicloDoAgente);
