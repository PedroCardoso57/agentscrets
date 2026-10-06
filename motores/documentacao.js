// Documentação viva do projeto, mantida por um agente (o Redator, por padrão).
// O escritório anota "eventos" (entregas, decisões, mudanças na equipe,
// avaliações) e, de tempos em tempos, o documentador reescreve o documento
// incorporando o que aconteceu. Fica em DADOS_DIR/documentacao.md.
//
//   DOCUMENTADOR=documentador   agente responsável (precisa estar no motores.json)
//   DOC_INTERVALO_MIN=3         de quantos em quantos minutos atualiza, se houver novidades

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chamarIA } from './provedores.js';

const MAX_EVENTOS = 300;
const MAX_DOC = 40000; // acima disso, o documentador é instruído a condensar o histórico

const DOC_INICIAL = `# Documentação do projeto

## Visão geral
Escritório 3D de agentes de IA: o chefe dá ordens, o Crânio (Laya) decide quem faz, o Orquestrador distribui e cada agente trabalha com a sua IA.

## Equipe e IAs
(ainda não documentado)

## Decisões
(nenhuma ainda)

## Entregas recentes
(nenhuma ainda)

## Pendências e próximos passos
(nenhuma ainda)

## Histórico
`;

export function criarDocumentacao({ dadosDir, equipe, rotulo, naFila, registrarStatus, transmitir }) {
  const arquivo = join(dadosDir, 'documentacao.md');
  const estadoArquivo = join(dadosDir, 'documentacao.json');
  let texto = DOC_INICIAL;
  let atualizadoEm = null;
  let por = null;
  let eventos = []; // ainda não incorporados ao documento
  let rodando = false;
  let ultimaRodada = 0;

  // quem mantém a documentação: DOCUMENTADOR no .env, senão o Documentador (ou o Redator do time antigo)
  const documentador = () => process.env.DOCUMENTADOR || (equipe().documentador ? 'documentador' : 'redator');
  const intervaloMs = () => Math.max(1, Number(process.env.DOC_INTERVALO_MIN || 3)) * 60000;

  async function carregar() {
    try { texto = await readFile(arquivo, 'utf8'); } catch { /* primeira vez: documento inicial */ }
    try {
      const salvo = JSON.parse(await readFile(estadoArquivo, 'utf8'));
      ({ atualizadoEm = null, por = null, eventos = [] } = salvo);
    } catch { /* sem estado salvo */ }
  }

  async function salvarEstado() {
    await mkdir(dadosDir, { recursive: true });
    await writeFile(`${estadoArquivo}.tmp`, JSON.stringify({ atualizadoEm, por, eventos }));
    await rename(`${estadoArquivo}.tmp`, estadoArquivo);
  }

  // Anota algo que aconteceu para entrar na próxima atualização.
  function registrar(descricao) {
    eventos.push({ em: new Date().toISOString(), texto: String(descricao).slice(0, 2500) });
    if (eventos.length > MAX_EVENTOS) eventos = eventos.slice(-MAX_EVENTOS);
    salvarEstado().catch(() => {});
    transmitir('documentacao', resumo());
  }

  function resumo() {
    const cfg = equipe()[documentador()];
    return {
      texto, atualizadoEm, por,
      pendentes: eventos.length,
      documentador: documentador(),
      ativo: Boolean(cfg && cfg.provedor !== 'webhook'),
      intervaloMin: intervaloMs() / 60000,
    };
  }

  function instrucoes(nome, cfg) {
    const time = Object.entries(cfg).map(([id, c]) => `- ${id}: ${rotulo(c)}${c.funcao ? ` — ${c.funcao}` : ''}`).join('\n');
    return `Você é o agente "${nome}" e mantém a DOCUMENTAÇÃO VIVA do projeto do chefe: um escritório de agentes de IA.
Você recebe o documento atual e os eventos novos. Atualize o documento incorporando os eventos:
registre entregas, decisões, mudanças na equipe e nas IAs, avaliações do chefe e pendências.

Regras:
- Mantenha estas seções, nesta ordem: "# Documentação do projeto", "## Visão geral", "## Equipe e IAs", "## Decisões", "## Entregas recentes", "## Pendências e próximos passos", "## Histórico".
- "## Equipe e IAs" deve refletir a equipe atual (abaixo).
- "## Histórico": uma linha por evento, no formato "- AAAA-MM-DD HH:MM — o que aconteceu", mais novo no fim.
- Seja objetivo, em português do Brasil. Não invente fatos que não estejam no documento ou nos eventos.
- ${texto.length > MAX_DOC ? 'O documento está grande: condense o histórico antigo em poucas linhas por semana e enxugue as entregas antigas.' : 'Mantenha o documento enxuto.'}
- Responda SOMENTE com o documento completo em Markdown, sem comentários antes ou depois.

Equipe atual:
${time}`;
  }

  async function atualizar({ forcar = false } = {}) {
    if (rodando || (!eventos.length && !forcar)) return resumo();
    const cfgTodos = equipe();
    const id = documentador();
    const c = cfgTodos[id];
    if (!c || c.provedor === 'webhook') return resumo(); // sem documentador com IA própria
    rodando = true;
    const lote = eventos.slice();
    try {
      await naFila(id, async () => {
        registrarStatus({ id, status: 'trabalhando', tarefa: 'Atualizando a documentação do projeto' });
        const pedido = `DOCUMENTO ATUAL:\n\n${texto}\n\nEVENTOS NOVOS (${lote.length}):\n${lote.map((e) => `- ${e.em.slice(0, 16).replace('T', ' ')} — ${e.texto}`).join('\n') || '(nenhum: revise e melhore o documento)'}`;
        let { texto: novo } = await chamarIA(c, { instrucoes: instrucoes(id, cfgTodos), pedido, maxTokens: 32000 }, { cfg: cfgTodos });
        novo = String(novo || '').replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim();
        if (novo.length < 80 || !novo.includes('#')) throw new Error('a IA devolveu um documento vazio ou fora do formato');
        await mkdir(dadosDir, { recursive: true });
        await writeFile(`${arquivo}.anterior`, texto).catch(() => {}); // guarda a versão anterior
        await writeFile(`${arquivo}.tmp`, novo);
        await rename(`${arquivo}.tmp`, arquivo);
        texto = novo;
        atualizadoEm = new Date().toISOString();
        por = id;
        eventos = eventos.slice(lote.length); // só tira os que entraram nesta rodada
        await salvarEstado();
        registrarStatus({ id, status: 'concluido', tarefa: 'Documentação atualizada' });
        setTimeout(() => registrarStatus({ id, status: 'ocioso', tarefa: '' }), 8000);
      });
    } catch (erro) {
      console.error(`[documentação] ${erro.message}`);
      registrarStatus({ id, status: 'erro', tarefa: `Documentação: ${erro.message}`.slice(0, 140) });
    } finally {
      rodando = false;
      ultimaRodada = Date.now();
      transmitir('documentacao', resumo());
    }
    return resumo();
  }

  // a cada 30 s confere se já passou o intervalo e há novidades
  setInterval(() => {
    if (eventos.length && Date.now() - ultimaRodada >= intervaloMs()) atualizar();
  }, 30000).unref();

  return { carregar, registrar, atualizar, resumo };
}
