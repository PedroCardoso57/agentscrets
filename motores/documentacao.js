// Documentação viva, uma por projeto, mantida por um agente (o Documentador).
// O escritório anota "eventos" (entregas, decisões, avaliações…) já marcados com
// o projeto (cliente) a que pertencem, e de tempos em tempos o documentador
// reescreve o documento de cada projeto que teve novidades — só com o que é dele.
//
//   dados/documentacao.md               documentação geral (o escritório, a equipe, o que não é de cliente)
//   dados/documentacao/<cliente>.md     documentação de cada projeto/cliente
//
//   DOCUMENTADOR=documentador   agente responsável (precisa estar no motores.json)
//   DOC_INTERVALO_MIN=3         de quantos em quantos minutos atualiza, se houver novidades

import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chamarIA } from './provedores.js';

const MAX_EVENTOS = 600;
const MAX_DOC = 40000; // acima disso, o documentador é instruído a condensar o histórico
export const GERAL = 'geral';

const SECOES_GERAL = ['Visão geral', 'Equipe e IAs', 'Projetos', 'Decisões', 'Entregas recentes', 'Pendências e próximos passos', 'Histórico'];
const SECOES_PROJETO = ['Visão geral do projeto', 'Escopo e módulos', 'Arquitetura e stack', 'Regras de negócio', 'Decisões', 'Entregas', 'Pendências e próximos passos', 'Histórico'];

function docInicial(titulo, secoes) {
  return `# ${titulo}\n\n${secoes.map((s) => `## ${s}\n${s === 'Histórico' ? '' : '(ainda não documentado)\n'}`).join('\n')}`;
}

// projetos: { existe(id), nomeDe(id), ficha(id), listar() → [{id, nome}] }
export function criarDocumentacao({ dadosDir, equipe, rotulo, naFila, registrarStatus, transmitir, projetos }) {
  const pasta = join(dadosDir, 'documentacao');
  const estadoArquivo = join(dadosDir, 'documentacao.json');
  const arquivoDe = (projeto) => (projeto === GERAL ? join(dadosDir, 'documentacao.md') : join(pasta, `${projeto}.md`));
  const docs = new Map(); // projeto → { texto, atualizadoEm, por }
  let eventos = []; // ainda não incorporados: { em, texto, projeto }
  let rodando = false;
  let ultimaRodada = 0;

  // quem mantém a documentação: DOCUMENTADOR no .env, senão o Documentador (ou o Redator do time antigo)
  const documentador = () => process.env.DOCUMENTADOR || (equipe().documentador ? 'documentador' : 'redator');
  const intervaloMs = () => Math.max(1, Number(process.env.DOC_INTERVALO_MIN || 3)) * 60000;
  const valido = (projeto) => (projeto && projeto !== GERAL && projetos.existe(projeto) ? projeto : GERAL);
  const tituloDe = (projeto) => (projeto === GERAL ? 'Documentação geral' : `${projetos.nomeDe(projeto)} — documentação do projeto`);

  function doc(projeto) {
    if (!docs.has(projeto)) docs.set(projeto, { texto: docInicial(tituloDe(projeto), projeto === GERAL ? SECOES_GERAL : SECOES_PROJETO), atualizadoEm: null, por: null });
    return docs.get(projeto);
  }

  async function carregar() {
    let salvo = {};
    try { salvo = JSON.parse(await readFile(estadoArquivo, 'utf8')); } catch { /* sem estado salvo */ }
    // formato antigo (um documento só): vira a documentação geral
    if (!salvo.docs && (salvo.atualizadoEm || salvo.eventos)) salvo = { docs: { [GERAL]: { atualizadoEm: salvo.atualizadoEm, por: salvo.por } }, eventos: salvo.eventos || [] };
    eventos = (salvo.eventos || []).map((e) => ({ ...e, projeto: e.projeto || GERAL }));
    const ids = new Set([GERAL, ...Object.keys(salvo.docs || {})]);
    try { for (const f of await readdir(pasta)) if (f.endsWith('.md')) ids.add(f.slice(0, -3)); } catch { /* pasta ainda não existe */ }
    for (const id of ids) {
      const d = doc(id);
      Object.assign(d, salvo.docs?.[id] || {});
      try { d.texto = await readFile(arquivoDe(id), 'utf8'); } catch { /* ainda não escrito */ }
    }
  }

  async function salvarEstado() {
    await mkdir(dadosDir, { recursive: true });
    const meta = Object.fromEntries([...docs].map(([id, d]) => [id, { atualizadoEm: d.atualizadoEm, por: d.por }]));
    await writeFile(`${estadoArquivo}.tmp`, JSON.stringify({ docs: meta, eventos }));
    await rename(`${estadoArquivo}.tmp`, estadoArquivo);
  }

  // Anota algo que aconteceu para entrar na próxima atualização do documento do projeto.
  function registrar(descricao, projeto = GERAL) {
    const p = valido(projeto);
    doc(p);
    eventos.push({ em: new Date().toISOString(), texto: String(descricao).slice(0, 2500), projeto: p });
    if (eventos.length > MAX_EVENTOS) eventos = eventos.slice(-MAX_EVENTOS);
    salvarEstado().catch(() => {});
    transmitir('documentacao', resumo(p));
  }

  // Lista de documentos (geral + projetos de clientes cadastrados ou que já têm documento).
  function lista() {
    const ids = new Set([GERAL, ...projetos.listar().map((c) => c.id), ...docs.keys()]);
    return [...ids].map((id) => ({
      id,
      nome: id === GERAL ? 'Geral' : projetos.nomeDe(id),
      atualizadoEm: docs.get(id)?.atualizadoEm || null,
      pendentes: eventos.filter((e) => e.projeto === id).length,
    }));
  }

  function resumo(projeto = GERAL) {
    const p = docs.has(projeto) || projetos.existe(projeto) ? projeto : GERAL;
    const d = doc(p);
    const cfg = equipe()[documentador()];
    return {
      projeto: p,
      nome: p === GERAL ? 'Geral' : projetos.nomeDe(p),
      texto: d.texto, atualizadoEm: d.atualizadoEm, por: d.por,
      pendentes: eventos.filter((e) => e.projeto === p).length,
      pendentesTotal: eventos.length,
      projetos: lista(),
      documentador: documentador(),
      ativo: Boolean(cfg && cfg.provedor !== 'webhook'),
      intervaloMin: intervaloMs() / 60000,
    };
  }

  function instrucoes(nome, cfg, projeto, texto) {
    const regrasComuns = `- "## Histórico": uma linha por evento, no formato "- AAAA-MM-DD HH:MM — o que aconteceu", mais novo no fim.
- Seja objetivo, em português do Brasil. Não invente fatos que não estejam no documento, na ficha ou nos eventos.
- ${texto.length > MAX_DOC ? 'O documento está grande: condense o histórico antigo em poucas linhas por semana e enxugue as entregas antigas.' : 'Mantenha o documento enxuto.'}
- Responda SOMENTE com o documento completo em Markdown, sem comentários antes ou depois.`;
    if (projeto === GERAL) {
      const time = Object.entries(cfg).map(([id, c]) => `- ${id}: ${rotulo(c)}${c.funcao ? ` — ${c.funcao}` : ''}`).join('\n');
      const clientes = projetos.listar().map((c) => `- ${c.nome}`).join('\n') || '(nenhum cadastrado)';
      return `Você é o agente "${nome}" e mantém a DOCUMENTAÇÃO GERAL do escritório: uma software house de agentes de IA que cria sistemas (ERP, CRM) e sites.
Este documento é sobre o escritório como um todo: a equipe e as IAs, a lista de projetos, decisões gerais e trabalhos que não são de nenhum cliente. Cada cliente tem a SUA documentação separada: aqui, sobre um projeto de cliente, só uma linha na seção "Projetos" apontando que ele existe.

Regras:
- Mantenha estas seções, nesta ordem: "# Documentação geral", ${SECOES_GERAL.map((s) => `"## ${s}"`).join(', ')}.
- "## Equipe e IAs" deve refletir a equipe atual (abaixo); "## Projetos", os clientes abaixo.
${regrasComuns}

Equipe atual:
${time}

Clientes/projetos:
${clientes}`;
    }
    return `Você é o agente "${nome}" e mantém a DOCUMENTAÇÃO DO PROJETO de um cliente: ${projetos.nomeDe(projeto)}.
Este documento é só deste projeto. Se algum evento claramente for de outro cliente, ignore-o. Documente o que o time construiu: escopo e módulos, arquitetura e stack, regras de negócio, decisões, entregas (o que foi feito e onde está), pendências.

Regras:
- Mantenha estas seções, nesta ordem: "# ${tituloDe(projeto)}", ${SECOES_PROJETO.map((s) => `"## ${s}"`).join(', ')}.
- Use a ficha do cliente (abaixo) como ponto de partida para visão geral, escopo, stack e regras; os eventos mostram o que foi sendo feito.
${regrasComuns}

Ficha do cliente:
${projetos.ficha(projeto) || '(sem ficha)'}`;
  }

  async function atualizarProjeto(projeto, { forcar = false } = {}) {
    const lote = eventos.filter((e) => e.projeto === projeto);
    if (!lote.length && !forcar) return;
    const cfgTodos = equipe();
    const id = documentador();
    const c = cfgTodos[id];
    if (!c || c.provedor === 'webhook') return; // sem documentador com IA própria
    const d = doc(projeto);
    await naFila(id, async () => {
      registrarStatus({ id, status: 'trabalhando', tarefa: `Documentando: ${projeto === GERAL ? 'geral' : projetos.nomeDe(projeto)}` });
      const pedido = `DOCUMENTO ATUAL:\n\n${d.texto}\n\nEVENTOS NOVOS (${lote.length}):\n${lote.map((e) => `- ${e.em.slice(0, 16).replace('T', ' ')} — ${e.texto}`).join('\n') || '(nenhum: revise e melhore o documento)'}`;
      let { texto: novo } = await chamarIA(c, { instrucoes: instrucoes(id, cfgTodos, projeto, d.texto), pedido, maxTokens: 32000 }, { cfg: cfgTodos });
      novo = String(novo || '').replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim();
      if (novo.length < 80 || !novo.includes('#')) throw new Error('a IA devolveu um documento vazio ou fora do formato');
      const arquivo = arquivoDe(projeto);
      await mkdir(projeto === GERAL ? dadosDir : pasta, { recursive: true });
      await writeFile(`${arquivo}.anterior`, d.texto).catch(() => {}); // guarda a versão anterior
      await writeFile(`${arquivo}.tmp`, novo);
      await rename(`${arquivo}.tmp`, arquivo);
      Object.assign(d, { texto: novo, atualizadoEm: new Date().toISOString(), por: id });
      const entraram = new Set(lote);
      eventos = eventos.filter((e) => !entraram.has(e)); // só tira os que entraram nesta rodada
      await salvarEstado();
    });
  }

  // Atualiza um projeto (ou todos os que têm novidades, um de cada vez).
  async function atualizar({ forcar = false, projeto } = {}) {
    if (rodando) return resumo(projeto);
    const id = documentador();
    const alvos = projeto ? [valido(projeto)] : [...new Set(eventos.map((e) => e.projeto))];
    if (!alvos.length) return resumo(projeto);
    rodando = true;
    let falhou = null;
    try {
      for (const p of alvos) {
        try { await atualizarProjeto(p, { forcar }); } catch (erro) { falhou = erro; console.error(`[documentação ${p}] ${erro.message}`); }
        transmitir('documentacao', resumo(p));
      }
      if (falhou) registrarStatus({ id, status: 'erro', tarefa: `Documentação: ${falhou.message}`.slice(0, 140) });
      else {
        registrarStatus({ id, status: 'concluido', tarefa: 'Documentação atualizada' });
        setTimeout(() => registrarStatus({ id, status: 'ocioso', tarefa: '' }), 8000);
      }
    } finally {
      rodando = false;
      ultimaRodada = Date.now();
    }
    return resumo(projeto);
  }

  // a cada 30 s confere se já passou o intervalo e há novidades
  setInterval(() => {
    if (eventos.length && Date.now() - ultimaRodada >= intervaloMs()) atualizar();
  }, 30000).unref();

  return { carregar, registrar, atualizar, resumo };
}
