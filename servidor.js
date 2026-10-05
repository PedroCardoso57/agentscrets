#!/usr/bin/env node
// Servidor do escritório: serve a página e recebe status dos seus motores.
// Sem dependências — só Node 18+.
//
//   node servidor.js            → http://localhost:8787
//   PORTA=3000 node servidor.js
//
// Motores enviam:
//   curl -X POST http://localhost:8787/api/status \
//        -H 'Content-Type: application/json' \
//        -d '{"id":"redator","status":"trabalhando","tarefa":"Escrevendo post"}'
//
// Também aceita uma lista: [{...}, {...}]. Um id novo cria uma mesa nova
// (campos opcionais: nome, funcao, atividade, cor).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('.', import.meta.url));
const PORTA = Number(process.env.PORTA || 8787);
const STATUS_VALIDOS = ['ocioso', 'trabalhando', 'aguardando', 'concluido', 'erro'];
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };

const estado = new Map(); // id → último status recebido
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

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (url.pathname === '/api/status' && req.method === 'POST') {
    let dados;
    try { dados = await lerCorpo(req); } catch { return enviarJSON(res, 400, { erro: 'JSON inválido' }); }
    const itens = Array.isArray(dados) ? dados : [dados];
    for (const item of itens) {
      if (!item || typeof item.id !== 'string') return enviarJSON(res, 400, { erro: 'campo "id" obrigatório' });
      if (item.status && !STATUS_VALIDOS.includes(item.status)) return enviarJSON(res, 400, { erro: `status deve ser um de: ${STATUS_VALIDOS.join(', ')}` });
    }
    for (const item of itens) {
      const novo = { ...estado.get(item.id), ...item, atualizadoEm: new Date().toISOString() };
      estado.set(item.id, novo);
      for (const c of clientes) c.write(`data: ${JSON.stringify(novo)}\n\n`);
    }
    return enviarJSON(res, 200, { ok: true, recebidos: itens.length });
  }

  if (url.pathname === '/api/estado') return enviarJSON(res, 200, [...estado.values()]);

  if (url.pathname === '/api/eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': conectado\n\n');
    clientes.add(res);
    const pulso = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(pulso); clientes.delete(res); });
    return;
  }

  // arquivos estáticos
  const caminho = normalize(join(RAIZ, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!caminho.startsWith(RAIZ)) { res.writeHead(403); return res.end(); }
  try {
    const conteudo = await readFile(caminho);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(caminho)] || 'application/octet-stream' });
    res.end(conteudo);
  } catch {
    res.writeHead(404); res.end('não encontrado');
  }
});

servidor.listen(PORTA, () => {
  console.log(`Escritório aberto em http://localhost:${PORTA}`);
  console.log(`Motores: POST http://localhost:${PORTA}/api/status  {"id","status","tarefa"}`);
});
