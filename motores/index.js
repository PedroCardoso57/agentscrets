// Motores embutidos: o próprio servidor chama a IA de cada agente quando chega
// uma ordem para ele, conforme o motores.json (veja motores.exemplo.json).
//
//   {
//     "redator":      { "provedor": "anthropic", "modelo": "claude-opus-5-5", "funcao": "...", "instrucoes": "..." },
//     "analista":     { "provedor": "openai", "modelo": "...", "instrucoes": "..." },
//     "orquestrador": { "provedor": "anthropic", "delegar": true, "instrucoes": "..." },
//     "designer":     { "webhook": "https://seu-n8n/webhook/designer" }
//   }
//
// Agentes fora do motores.json continuam recebendo ordens pela consulta
// (GET /api/ordens/pendentes), como antes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVEDORES, NOMES } from './provedores.js';

const VOLTAR_AO_OCIOSO = 8000;

export function criarMotores({ raiz, ordens, registrarStatus, marcarEntregue, registrarResposta, atualizarOrdem, criarOrdem }) {
  const arquivo = process.env.MOTORES_ARQUIVO || join(raiz, 'motores.json');
  const filas = new Map(); // agente → promessa da tarefa em andamento (uma por vez)
  let avisado = '';

  // Relido a cada ordem: dá para editar o motores.json sem reiniciar.
  function configuracao() {
    let bruto;
    try {
      bruto = JSON.parse(process.env.MOTORES_JSON || readFileSync(arquivo, 'utf8'));
    } catch (erro) {
      if (erro.code !== 'ENOENT' && avisado !== erro.message) console.error(`motores.json inválido: ${(avisado = erro.message)}`);
      return {};
    }
    const cfg = {};
    for (const [id, c] of Object.entries(bruto)) {
      if (id.startsWith('_') || !c || typeof c !== 'object') continue; // "_comentario" etc.
      const provedor = c.provedor || (c.webhook ? 'webhook' : null);
      if (!PROVEDORES[provedor]) { console.warn(`motores.json: "${id}" tem provedor desconhecido "${c.provedor}"`); continue; }
      cfg[id] = { ...c, provedor };
    }
    return cfg;
  }

  function rotulo(c) {
    return c.modelo ? `${NOMES[c.provedor]} · ${c.modelo}` : NOMES[c.provedor];
  }

  function instrucoesDe(id, c, cfg, podeDelegar) {
    let texto = c.instrucoes || `Você é o agente "${id}" de um escritório de IA${c.funcao ? `, responsável por: ${c.funcao}` : ''}. Cumpra a tarefa do chefe com qualidade e responda em português.`;
    if (podeDelegar) {
      const equipe = Object.entries(cfg).filter(([outro, o]) => outro !== id && !o.delegar)
        .map(([outro, o]) => `- ${outro}: ${o.funcao || 'sem descrição'}`).join('\n');
      texto += `\n\nVocê coordena esta equipe:\n${equipe}\n\nResponda SOMENTE com um objeto JSON, sem texto fora dele, no formato:\n{"resposta": "o que você vai fazer, em poucas linhas, para o chefe", "tarefas": [{"para": "<id da lista>", "texto": "tarefa clara e completa para esse agente"}]}\nUse apenas ids da lista. Se der para resolver sem a equipe, responda com "tarefas": [].`;
    }
    return texto;
  }

  function pedidoDe(ordem) {
    return ordem.contexto ? `${ordem.texto}\n\nContexto: ${ordem.contexto}` : ordem.texto;
  }

  function lerPlano(texto) {
    const limpo = texto.replace(/```(?:json)?/g, '');
    const inicio = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (inicio < 0 || fim < inicio) return null;
    try { return JSON.parse(limpo.slice(inicio, fim + 1)); } catch { return null; }
  }

  async function executar(id, ordem) {
    const cfg = configuracao();
    const c = cfg[id];
    if (!c) return;
    const podeDelegar = Boolean(c.delegar) && (!ordem.de || ordem.de === 'chefe'); // tarefas delegadas não são re-delegadas
    registrarStatus({ id, status: 'trabalhando', tarefa: ordem.texto.slice(0, 140), motor: rotulo(c) });
    try {
      let resposta = await PROVEDORES[c.provedor]({ ...c, instrucoes: instrucoesDe(id, c, cfg, podeDelegar), pedido: pedidoDe(ordem), ordem, agente: id });
      if (resposta === null) { // webhook: entregue, o motor responde depois
        registrarStatus({ id, status: 'aguardando', tarefa: 'Enviado ao motor externo' });
        return;
      }
      if (podeDelegar) {
        const plano = lerPlano(resposta);
        if (plano) {
          const tarefas = (Array.isArray(plano.tarefas) ? plano.tarefas : [])
            .filter((t) => t && cfg[t.para] && t.para !== id && typeof t.texto === 'string' && t.texto.trim());
          for (const t of tarefas) criarOrdem({ para: t.para, texto: t.texto, de: id, contexto: `pedido original do chefe: "${ordem.texto}"` });
          resposta = (plano.resposta || 'Plano montado.') + (tarefas.length ? `\n\nDistribuí: ${tarefas.map((t) => `${t.para} → ${t.texto}`).join(' · ')}` : '');
        }
      }
      registrarResposta(ordem, id, resposta || '(resposta vazia)');
      atualizarOrdem(ordem);
      registrarStatus({ id, status: 'concluido', tarefa: 'Ordem cumprida' });
    } catch (erro) {
      console.error(`[${id}] ordem ${ordem.id}: ${erro.message}`);
      registrarResposta(ordem, id, `Erro: ${erro.message}`);
      atualizarOrdem(ordem);
      registrarStatus({ id, status: 'erro', tarefa: erro.message.slice(0, 140) });
      return;
    }
    setTimeout(() => registrarStatus({ id, status: 'ocioso', tarefa: '' }), VOLTAR_AO_OCIOSO);
  }

  function enfileirar(id, ordem) {
    const anterior = filas.get(id) || Promise.resolve();
    const atual = anterior.then(() => executar(id, ordem)).catch((erro) => console.error(erro));
    filas.set(id, atual);
  }

  // Entrega a ordem a todos os agentes com motor embutido a que ela se destina.
  function despachar(ordem) {
    const cfg = configuracao();
    const alvos = ordem.para === 'todos' ? Object.keys(cfg) : cfg[ordem.para] ? [ordem.para] : [];
    for (const id of alvos) {
      if (ordem.entregue.includes(id)) continue;
      marcarEntregue(ordem, id);
      enfileirar(id, ordem);
    }
    if (alvos.length) atualizarOrdem(ordem);
  }

  // Ao ligar: mostra quais agentes têm motor e trata ordens que ficaram para trás.
  function iniciar(estado) {
    const cfg = configuracao();
    for (const [id, c] of Object.entries(cfg)) {
      const atual = estado.get(id);
      registrarStatus({ id, motor: rotulo(c), ...(!atual || atual.status === 'trabalhando' ? { status: 'ocioso', tarefa: '' } : {}) });
    }
    for (const ordem of ordens) {
      if (ordem.estado === 'pendente') { despachar(ordem); continue; }
      // em andamento quando o servidor caiu: avisa em vez de repetir (e pagar de novo) sem você saber
      const interrompidos = ordem.entregue.filter((id) => cfg[id] && cfg[id].provedor !== 'webhook' && !ordem.respostas.some((r) => r.agente === id));
      for (const id of interrompidos) registrarResposta(ordem, id, 'Interrompida: o servidor reiniciou durante a tarefa. Envie a ordem de novo.');
      if (interrompidos.length) atualizarOrdem(ordem);
    }
    const n = Object.keys(cfg).length;
    console.log(n ? `Motores embutidos: ${Object.entries(cfg).map(([id, c]) => `${id} (${rotulo(c)})`).join(', ')}` : 'Nenhum motor embutido (motores.json ausente).');
  }

  return { despachar, iniciar };
}
