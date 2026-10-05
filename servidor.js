#!/usr/bin/env node
// Servidor do escritório: serve a página, recebe status dos seus motores e
// entrega a eles as ordens que você dá pelo seu bonequinho de chefe.
// Sem dependências — só Node 18+.
//
//   node servidor.js            → http://localhost:8787
//   PORTA=3000 node servidor.js
//   HOST=0.0.0.0 node servidor.js   (expõe na rede; por padrão só esta máquina acessa)
//
// Status (motor → escritório):
//   POST /api/status                 {"id":"redator","status":"trabalhando","tarefa":"..."}
//
// Ordens (chefe → motor):
//   POST /api/ordens                 {"para":"redator" | "todos","texto":"..."}      (a página usa)
//   GET  /api/ordens/pendentes?agente=redator   → ordens novas para o motor (marca como entregues)
//   POST /api/ordens/:id/resposta    {"agente":"redator","texto":"Feito!","status":"concluido"}
//   ou, em vez de consultar, configure um webhook por agente em motores.json
//   (veja motores.exemplo.json) e o servidor faz POST da ordem para o seu motor.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const RAIZ = fileURLToPath(new URL('.', import.meta.url));
const PORTA = Number(process.env.PORTA || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const STATUS_VALIDOS = ['ocioso', 'trabalhando', 'aguardando', 'concluido', 'erro'];
const MAX_ORDENS = 200;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png' };

const estado = new Map(); // id → último status recebido
const ordens = [];        // histórico, da mais antiga para a mais nova
const clientes = new Set();

function enviarJSON(res, codigo, dados) {
  res.writeHead(codigo, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(dados));
}

async function lerCorpo(req) {
  let corpo = '';
  for await (const parte of req) {
    corpo += parte;
    if (corpo.length > 1e6) throw new Error('corpo muito grande');
  }
  return JSON.parse(corpo || '{}');
}

function transmitir(evento, dados) {
  const linha = (evento ? `event: ${evento}\n` : '') + `data: ${JSON.stringify(dados)}\n\n`;
  for (const c of clientes) c.write(linha);
}

function registrarStatus(item) {
  const novo = { ...estado.get(item.id), ...item, atualizadoEm: new Date().toISOString() };
  estado.set(item.id, novo);
  transmitir(null, novo);
}

// ---------- ordens ----------

function atualizarOrdem(ordem) {
  ordem.estado = ordem.respostas.length ? 'respondida' : ordem.entregue.length ? 'entregue' : 'pendente';
  transmitir('ordem', ordem);
}

function marcarEntregue(ordem, agente) {
  if (!ordem.entregue.includes(agente)) ordem.entregue.push(agente);
}

function registrarResposta(ordem, agente, texto) {
  ordem.respostas.push({ agente, texto: String(texto).slice(0, 2000), em: new Date().toISOString() });
}

async function lerWebhooks() {
  try { return JSON.parse(await readFile(join(RAIZ, 'motores.json'), 'utf8')); } catch { return {}; }
}

// Se o agente tiver webhook em motores.json, entrega a ordem na hora.
async function entregarPorWebhook(ordem) {
  const motores = await lerWebhooks();
  const alvos = ordem.para === 'todos' ? Object.keys(motores) : [ordem.para];
  for (const agente of alvos) {
    const url = motores[agente]?.webhook;
    if (!url) continue;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ordem: { id: ordem.id, para: ordem.para, texto: ordem.texto, criadaEm: ordem.criadaEm }, agente }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      marcarEntregue(ordem, agente);
      // o motor pode responder na hora: {"resposta": "..."}
      const corpo = await r.json().catch(() => null);
      if (corpo && typeof corpo.resposta === 'string') registrarResposta(ordem, agente, corpo.resposta);
    } catch (erro) {
      console.warn(`[ordem ${ordem.id}] webhook de "${agente}" falhou: ${erro.message}`);
    }
  }
  atualizarOrdem(ordem);
}

// ---------- rotas ----------

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rota = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (rota === '/api/status' && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    const itens = Array.isArray(dados) ? dados : [dados];
    for (const item of itens) {
      if (!item || typeof item.id !== 'string') return enviarJSON(res, 400, { erro: 'campo "id" obrigatório' });
      if (item.status && !STATUS_VALIDOS.includes(item.status)) return enviarJSON(res, 400, { erro: `status deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
    }
    itens.forEach(registrarStatus);
    return enviarJSON(res, 200, { ok: true, recebidos: itens.length });
  }

  if (rota === '/api/estado') return enviarJSON(res, 200, [...estado.values()]);

  if (rota === '/api/ordens' && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    const texto = typeof dados.texto === 'string' ? dados.texto.trim() : '';
    if (!texto) return enviarJSON(res, 400, { erro: 'campo "texto" obrigatório' });
    if (typeof dados.para !== 'string' || !dados.para) return enviarJSON(res, 400, { erro: 'campo "para" obrigatório (id do agente ou "todos")' });
    const ordem = { id: randomUUID().slice(0, 8), para: dados.para, texto: texto.slice(0, 2000), criadaEm: new Date().toISOString(), estado: 'pendente', entregue: [], respostas: [] };
    ordens.push(ordem);
    if (ordens.length > MAX_ORDENS) ordens.shift();
    transmitir('ordem', ordem);
    enviarJSON(res, 201, ordem);
    entregarPorWebhook(ordem);
    return;
  }

  if (rota === '/api/ordens' && req.method === 'GET') return enviarJSON(res, 200, ordens.slice(-50));

  if (rota === '/api/ordens/pendentes') {
    const agente = url.searchParams.get('agente');
    if (!agente) return enviarJSON(res, 400, { erro: 'informe ?agente=<id>' });
    const novas = ordens.filter((o) => (o.para === agente || o.para === 'todos') && !o.entregue.includes(agente));
    for (const o of novas) { marcarEntregue(o, agente); atualizarOrdem(o); }
    return enviarJSON(res, 200, novas.map(({ id, para, texto, criadaEm }) => ({ id, para, texto, criadaEm })));
  }

  const resposta = rota.match(/^\/api\/ordens\/([\w-]+)\/resposta$/);
  if (resposta && req.method === 'POST') {
    const ordem = ordens.find((o) => o.id === resposta[1]);
    if (!ordem) return enviarJSON(res, 404, { erro: 'ordem não encontrada' });
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    if (typeof dados.agente !== 'string' || typeof dados.texto !== 'string') return enviarJSON(res, 400, { erro: 'campos "agente" e "texto" obrigatórios' });
    if (dados.status && !STATUS_VALIDOS.includes(dados.status)) return enviarJSON(res, 400, { erro: `status deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
    marcarEntregue(ordem, dados.agente);
    registrarResposta(ordem, dados.agente, dados.texto);
    atualizarOrdem(ordem);
    if (dados.status) registrarStatus({ id: dados.agente, status: dados.status, tarefa: dados.texto });
    return enviarJSON(res, 200, ordem);
  }

  if (rota === '/api/eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': conectado\n\n');
    clientes.add(res);
    const pulso = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(pulso); clientes.delete(res); });
    return;
  }

  // arquivos estáticos
  // não expõe motores.json (URLs internas) nem arquivos ocultos como .git
  if (rota === '/motores.json' || rota.split('/').some((p) => p.startsWith('.'))) { res.writeHead(404); return res.end(); }
  const caminho = normalize(join(RAIZ, rota === '/' ? 'index.html' : decodeURIComponent(rota)));
  if (!caminho.startsWith(RAIZ)) { res.writeHead(403); return res.end(); }
  try {
    const conteudo = await readFile(caminho);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(caminho)] || 'application/octet-stream' });
    res.end(conteudo);
  } catch {
    res.writeHead(404); res.end('não encontrado');
  }
});

servidor.listen(PORTA, HOST, () => {
  console.log(`Escritório aberto em http://localhost:${PORTA}`);
  console.log(`Status:  POST /api/status  {"id","status","tarefa"}`);
  console.log(`Ordens:  GET  /api/ordens/pendentes?agente=<id>  ·  POST /api/ordens/<id>/resposta`);
});
