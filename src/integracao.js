// Ponte entre o escritório e os seus motores/agentes reais.
//
// Formas de enviar status (todas usam o mesmo formato):
//   { id: 'redator', status: 'trabalhando', tarefa: 'Escrevendo post do blog' }
//
// 1. Servidor local (recomendado): `node servidor.js` e os motores fazem
//    POST http://localhost:8787/api/status com o JSON acima. A página recebe
//    em tempo real via Server-Sent Events.
// 2. WebSocket próprio: abra a página com ?ws=ws://host:porta
// 3. JavaScript na mesma página: window.Escritorio.atualizar('redator', {...})
// 4. iframe: parent.postMessage({ escritorio: {...} }, '*') para dentro do iframe
// Sem nenhuma fonte conectada, roda uma simulação (modo demo).
//
// Ordens do chefe (você) seguem o caminho inverso: a página faz
// POST api/ordens e o servidor entrega ao motor (consulta ou webhook).
// A resposta do motor volta como evento "ordem" e aparece no painel.

import { STATUS } from './agentes.js';

const TAREFAS_DEMO = {
  orquestrador: ['Distribuindo tarefas da sprint', 'Revisando prioridades', 'Montando plano da semana'],
  pesquisador: ['Lendo relatórios de mercado', 'Coletando referências', 'Pesquisando concorrentes'],
  redator: ['Escrevendo legenda do post', 'Rascunhando e-mail', 'Criando roteiro de Reels'],
  designer: ['Desenhando carrossel', 'Ajustando paleta de cores', 'Criando thumbnail'],
  analista: ['Analisando métricas de anúncios', 'Montando dashboard', 'Comparando CTR por campanha'],
  programador: ['Integrando API', 'Corrigindo bug na automação', 'Escrevendo testes'],
  atendimento: ['Atendendo cliente #1042', 'Respondendo dúvidas no WhatsApp', 'Retornando ligação'],
  revisor: ['Revisando texto do blog', 'Conferindo peça do designer', 'Aprovando entrega'],
};

export function criarIntegracao({ ids, aoAtualizar, aoNovoAgente, aoConexao, aoOrdem }) {
  const params = new URLSearchParams(location.search);
  let demo = null;
  let servidorAtivo = false;
  let socket = null;
  const ordens = new Map();
  const ocupados = new Set(); // agentes cumprindo ordem na simulação
  let contadorLocal = 0;

  function aplicar(msg) {
    if (!msg || !msg.id) return;
    if (msg.status && !STATUS[msg.status]) {
      console.warn(`[escritorio] status desconhecido "${msg.status}". Use: ${Object.keys(STATUS).join(', ')}`);
      return;
    }
    if (!aoAtualizar(msg.id, msg)) aoNovoAgente(msg);
  }

  function processar(dados) {
    if (Array.isArray(dados)) dados.forEach(aplicar);
    else aplicar(dados);
  }

  // ao sair da simulação, zera os estados falsos para não confundir com status reais
  function pararDemo() {
    if (!demo) return;
    clearInterval(demo);
    demo = null;
    ids().forEach((id) => aoAtualizar(id, { status: 'ocioso', tarefa: '' }));
  }

  // ---------- ordens ----------

  function receberOrdem(ordem, historico = false) {
    const nova = !ordens.has(ordem.id);
    ordens.set(ordem.id, ordem);
    // na simulação, os agentes ficam reservados até o chefe entregar a ordem
    if (nova && !historico && demo) alvosDe(ordem).forEach((id) => ocupados.add(id));
    aoOrdem(ordem, { nova: nova && !historico });
  }

  function alvosDe(ordem) {
    return ordem.para === 'todos' ? ids() : [ordem.para];
  }

  async function enviarOrdem(para, texto) {
    texto = texto.trim();
    if (!texto) return;
    if (servidorAtivo) {
      const r = await fetch('api/ordens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ para, texto }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || `HTTP ${r.status}`);
      receberOrdem(await r.json());
      return;
    }
    const ordem = { id: `local-${++contadorLocal}`, para, texto, criadaEm: new Date().toISOString(), estado: 'pendente', entregue: [], respostas: [], local: !socket };
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ tipo: 'ordem', ordem }));
    receberOrdem(ordem);
  }

  // Na simulação, os agentes cumprem a ordem e respondem. Chamado quando o
  // chefe termina de falar a ordem (ou na hora, se ninguém tem mesa para ela).
  function cumprirNaSimulacao(ordem) {
    if (!demo) return;
    alvosDe(ordem).forEach((id, i) => {
      ocupados.add(id);
      const inicio = 600 + i * 400;
      const fim = inicio + 6000 + Math.random() * 5000;
      setTimeout(() => demo && aplicar({ id, status: 'trabalhando', tarefa: ordem.texto }), inicio);
      setTimeout(() => {
        if (!demo) return;
        aplicar({ id, status: 'concluido', tarefa: 'Ordem cumprida!' });
        ordem.respostas.push({ agente: id, texto: `Feito: ${ordem.texto}`, em: new Date().toISOString(), simulada: true });
        ordem.estado = 'respondida';
        aoOrdem(ordem, { nova: false });
      }, fim);
      setTimeout(() => ocupados.delete(id), fim + 4000);
    });
  }

  // API global
  window.Escritorio = {
    atualizar: (id, dados = {}) => { pararDemo(); aplicar({ ...dados, id }); },
    adicionarAgente: (agente) => aoNovoAgente(agente),
    ordem: (para, texto) => enviarOrdem(para, texto),
    demo: (ligar = true) => (ligar ? iniciarDemo() : pararDemo()),
  };

  window.addEventListener('message', (e) => {
    if (e.data && e.data.escritorio) { pararDemo(); processar(e.data.escritorio); }
    if (e.data && e.data.ordem && e.data.ordem.id) receberOrdem(e.data.ordem); // resposta vinda de fora do iframe
  });

  function iniciarDemo() {
    pararDemo();
    const lista = ids();
    aoConexao('demo', false);
    const proximo = {};
    const agora = () => performance.now() / 1000;
    lista.forEach((id, i) => { proximo[id] = agora() + 1 + i * 0.7; });
    demo = setInterval(() => {
      for (const id of lista) {
        if (agora() < proximo[id] || ocupados.has(id)) continue;
        const r = Math.random();
        const tarefas = TAREFAS_DEMO[id] || ['Processando tarefa'];
        let msg;
        if (r < 0.55) msg = { status: 'trabalhando', tarefa: tarefas[Math.floor(Math.random() * tarefas.length)] };
        else if (r < 0.68) msg = { status: 'aguardando', tarefa: 'Aguardando retorno…' };
        else if (r < 0.82) msg = { status: 'concluido', tarefa: 'Tarefa entregue!' };
        else if (r < 0.95) msg = { status: 'ocioso', tarefa: '' };
        else msg = { status: 'erro', tarefa: 'Falha ao acessar a API' };
        aplicar({ id, ...msg });
        proximo[id] = agora() + (msg.status === 'trabalhando' ? 8 + Math.random() * 10 : 4 + Math.random() * 5);
      }
    }, 500);
  }

  function conectarWebSocket(url) {
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => { pararDemo(); aoConexao('websocket', true); };
    ws.onmessage = (e) => {
      let dados;
      try { dados = JSON.parse(e.data); } catch { return console.warn('[escritorio] mensagem inválida', e.data); }
      if (dados.tipo === 'ordem' && dados.ordem) receberOrdem(dados.ordem); // {tipo:'ordem', ordem:{id, respostas...}}
      else processar(dados);
    };
    ws.onclose = () => { aoConexao('websocket desconectado', false); setTimeout(() => conectarWebSocket(url), 3000); };
  }

  async function conectarServidor() {
    let atual;
    try {
      const r = await fetch('api/estado', { cache: 'no-store' });
      if (!r.ok) return false;
      atual = await r.json();
    } catch { return false; }
    servidorAtivo = true;
    processar(atual);
    fetch('api/ordens', { cache: 'no-store' }).then((r) => r.json()).then((lista) => lista.forEach((o) => receberOrdem(o, true))).catch(() => {});
    // nenhum motor falou ainda: simula até chegar o primeiro status real
    const simulando = atual.length === 0 && params.get('demo') !== '0';
    if (simulando) iniciarDemo();
    const fonte = new EventSource('api/eventos');
    fonte.onopen = () => aoConexao(demo ? 'servidor · demo até chegar status' : 'servidor conectado', true);
    fonte.onmessage = (e) => {
      try { const dados = JSON.parse(e.data); pararDemo(); aoConexao('servidor conectado', true); processar(dados); } catch { /* ignora */ }
    };
    fonte.addEventListener('ordem', (e) => { try { receberOrdem(JSON.parse(e.data)); } catch { /* ignora */ } });
    fonte.onerror = () => aoConexao('reconectando…', false);
    return true;
  }

  (async () => {
    if (params.get('demo') === '1') return iniciarDemo();
    if (params.get('ws')) return conectarWebSocket(params.get('ws'));
    if (await conectarServidor()) return;
    if (params.get('demo') !== '0') iniciarDemo();
    else aoConexao('aguardando status', false);
  })();

  return { enviarOrdem, cumprirNaSimulacao, servidorAtivo: () => servidorAtivo };
}
