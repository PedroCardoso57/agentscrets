// Arquivo de entregas: cada resposta de agente vira um arquivo .md em
// DADOS_DIR/entregas/AAAA-MM-DD/, e um índice permite buscar e filtrar tudo,
// inclusive o que já saiu do histórico de ordens (que guarda só as últimas 2000).

import { gravarArquivo } from './gravar.js';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

const POR_PAGINA = 50;
const FUSO = process.env.TZ || 'America/Sao_Paulo';

function slug(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'entrega';
}

const ehEntrega = (r) => r && !r.erro && !r.simulada && !/^(Erro:|Interrompida:)/.test(r.texto);

// aoNova(item, conteudo): chamada só para entregas novas (não no arquivamento das antigas nem ao regravar)
export function criarEntregas({ dadosDir, nomeIA = (r) => r.motor || 'externo', nomeCliente = (id) => id, aoNova = () => {} }) {
  const pasta = join(dadosDir, 'entregas');
  const arquivoIndice = join(pasta, 'indice.json');
  let indice = []; // { chave, ordemId, indice, agente, de, para, motor, ms, em, pedido, trecho, nota, arquivo }
  let salvarTimer = null;

  async function carregar(ordens) {
    try { indice = JSON.parse(await readFile(arquivoIndice, 'utf8')); } catch { indice = []; }
    // entregas antigas que ainda não viraram arquivo (ex.: feitas antes desta versão)
    const conhecidas = new Set(indice.map((e) => e.chave));
    for (const o of ordens) {
      for (const [i, r] of o.respostas.entries()) {
        if (ehEntrega(r) && !conhecidas.has(`${o.id}:${i}`)) await registrar(o, i, { salvarJa: false });
      }
    }
    await salvarIndice();
  }

  function agendarIndice() {
    clearTimeout(salvarTimer);
    salvarTimer = setTimeout(() => salvarIndice().catch((e) => console.error('[entregas]', e.message)), 1000);
  }

  async function salvarIndice() {
    await mkdir(pasta, { recursive: true });
    await gravarArquivo(arquivoIndice, JSON.stringify(indice));
  }

  function markdown(ordem, r) {
    const d = ordem.decisao;
    const linhas = [
      `# ${ordem.texto.split('\n')[0].slice(0, 120)}`,
      '',
      ordem.cliente ? `- **Cliente:** ${nomeCliente(ordem.cliente)}` : null,
      `- **Agente:** ${r.agente}`,
      `- **IA:** ${nomeIA(r)}`,
      `- **Data:** ${new Date(r.em).toLocaleString('pt-BR', { timeZone: FUSO })}`,
      `- **Pedido de:** ${ordem.de && ordem.de !== 'chefe' ? ordem.de : 'chefe'}`,
      typeof r.ms === 'number' ? `- **Tempo:** ${(r.ms / 1000).toFixed(1)} s` : null,
      d ? `- **Crânio:** ${d.modo || 'escolheu'} ${d.agente} (${Math.round((d.confianca || 0) * 100)}%)${d.urgencia ? `, urgência ${d.urgencia}` : ''}` : null,
      r.nota ? `- **Avaliação:** ${r.nota === 1 ? '👍 boa' : '👎 ruim'}${r.comentario ? ` — ${r.comentario}` : ''}` : null,
      r.revisao ? `- **Revisão:** ${r.revisao.erro ? `o ${r.revisao.por} não conseguiu revisar (${r.revisao.erro})` : `revisado por ${r.revisao.por} (${r.revisao.motor})`}` : null,
      ordem.ajuste ? `- **Ajuste de:** ordem ${ordem.ajuste.ordemId}` : null,
      `- **Ordem:** ${ordem.id}`,
      '',
      '## Pedido',
      '',
      ordem.ajuste ? `${ordem.ajuste.original}\n\n**Ajuste pedido:** ${ordem.texto}` : ordem.texto,
      ordem.contexto ? `\n> ${ordem.contexto}` : null,
      '',
      '## Entrega',
      '',
      r.texto,
      '',
      r.revisao?.observacoes ? `## Observações do Revisor\n\n${r.revisao.observacoes}\n` : null,
    ];
    return linhas.filter((l) => l !== null).join('\n');
  }

  // Grava (ou regrava, ex.: depois de uma avaliação) o arquivo da resposta `i` da ordem.
  async function registrar(ordem, i, { salvarJa = true } = {}) {
    const r = ordem.respostas[i];
    if (!ehEntrega(r)) return;
    const chave = `${ordem.id}:${i}`;
    let item = indice.find((e) => e.chave === chave);
    const nova = !item;
    if (!item) {
      // data e hora no fuso do escritório (sv-SE dá "AAAA-MM-DD HH:MM")
      const [dia, hm] = new Date(r.em).toLocaleString('sv-SE', { timeZone: FUSO, hour12: false }).split(' ');
      const hora = hm.slice(0, 5).replace(':', '');
      item = { chave, ordemId: ordem.id, indice: i, arquivo: `${dia}/${hora}-${slug(r.agente)}-${slug(ordem.texto)}-${ordem.id}-${i}.md` };
      indice.push(item);
    }
    Object.assign(item, {
      agente: r.agente, de: ordem.de || 'chefe', motor: nomeIA(r), ms: r.ms, em: r.em,
      cliente: ordem.cliente || '', ajuste: Boolean(ordem.ajuste), revisado: Boolean(r.revisao && !r.revisao.erro),
      pedido: (ordem.ajuste ? `${ordem.ajuste.original.split('\n')[0].slice(0, 200)} (ajuste: ${ordem.texto})` : ordem.texto).slice(0, 300),
      trecho: r.texto.slice(0, 1500), nota: r.nota || 0,
    });
    const caminho = join(pasta, item.arquivo);
    await mkdir(join(caminho, '..'), { recursive: true });
    const conteudo = markdown(ordem, r);
    await writeFile(caminho, conteudo);
    if (salvarJa) agendarIndice();
    if (nova && salvarJa) aoNova({ ...item, texto: r.texto }, conteudo);
  }

  function filtrar({ q = '', agente = '', cliente = '' } = {}) {
    const termo = q.trim().toLowerCase();
    return indice
      .filter((e) => (!agente || e.agente === agente) && (!cliente || e.cliente === cliente) && (!termo || `${e.pedido}\n${e.trecho}\n${e.agente}\n${e.motor}\n${e.cliente ? nomeCliente(e.cliente) : ''}`.toLowerCase().includes(termo)))
      .sort((a, b) => (a.em < b.em ? 1 : -1)); // mais nova primeiro
  }

  function listar({ q, agente, cliente, pagina = 1 }) {
    const todos = filtrar({ q, agente, cliente });
    const p = Math.max(1, Number(pagina) || 1);
    return {
      total: todos.length,
      pagina: p,
      paginas: Math.max(1, Math.ceil(todos.length / POR_PAGINA)),
      agentes: [...new Set(indice.map((e) => e.agente))].sort(),
      clientes: [...new Set(indice.map((e) => e.cliente).filter(Boolean))].map((id) => ({ id, nome: nomeCliente(id) })),
      itens: todos.slice((p - 1) * POR_PAGINA, p * POR_PAGINA).map(({ trecho, ...e }) => ({ ...e, resumo: trecho.slice(0, 160) })),
    };
  }

  function caminhoSeguro(arquivo) {
    const caminho = normalize(join(pasta, String(arquivo || '')));
    if (!caminho.startsWith(pasta + sep) || !caminho.endsWith('.md')) throw new Error('arquivo inválido');
    return caminho;
  }

  async function ler(arquivo) {
    return readFile(caminhoSeguro(arquivo), 'utf8');
  }

  // Junta as entregas filtradas num único .md para baixar.
  async function exportar(filtro) {
    const partes = [];
    for (const e of filtrar(filtro)) {
      try { partes.push(await readFile(join(pasta, e.arquivo), 'utf8')); } catch { /* arquivo removido à mão */ }
    }
    return partes.join('\n\n---\n\n');
  }

  // Entregas de um dia ('AAAA-MM-DD' no fuso do escritório), da mais antiga para a mais nova.
  function doDia(data) {
    return indice.filter((e) => new Date(e.em).toLocaleString('sv-SE', { timeZone: FUSO }).startsWith(data))
      .sort((a, b) => (a.em < b.em ? -1 : 1));
  }

  return { carregar, registrar, listar, ler, exportar, doDia };
}

