// Janela "Documentação": mostra o documento vivo que o Redator mantém,
// atualizado na tela quando ele termina uma rodada.

function escapar(t) {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Markdown simples e seguro: escapa tudo antes e só depois aplica a formatação.
function inline(t) {
  return escapar(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

export function markdownParaHtml(md) {
  const linhas = md.replace(/\r/g, '').split('\n');
  const html = [];
  let lista = null; // 'ul' | 'ol'
  let codigo = null;
  const fecharLista = () => { if (lista) { html.push(`</${lista}>`); lista = null; } };
  for (const linha of linhas) {
    if (codigo !== null) {
      if (/^```/.test(linha)) { html.push(`<pre><code>${escapar(codigo.join('\n'))}</code></pre>`); codigo = null; } else codigo.push(linha);
      continue;
    }
    if (/^```/.test(linha)) { fecharLista(); codigo = []; continue; }
    const titulo = linha.match(/^(#{1,4})\s+(.*)$/);
    const item = linha.match(/^\s*[-*]\s+(.*)$/);
    const numerado = linha.match(/^\s*\d+[.)]\s+(.*)$/);
    if (titulo) { fecharLista(); html.push(`<h${titulo[1].length}>${inline(titulo[2])}</h${titulo[1].length}>`); } else if (item || numerado) {
      const tipo = item ? 'ul' : 'ol';
      if (lista !== tipo) { fecharLista(); html.push(`<${tipo}>`); lista = tipo; }
      html.push(`<li>${inline((item || numerado)[1])}</li>`);
    } else if (!linha.trim()) { fecharLista(); } else { fecharLista(); html.push(`<p>${inline(linha)}</p>`); }
  }
  if (codigo !== null) html.push(`<pre><code>${escapar(codigo.join('\n'))}</code></pre>`);
  fecharLista();
  return html.join('\n');
}

export function criarJanelaDocumentacao({ servidorAtivo, nomeDe }) {
  const dlg = document.getElementById('dlg-documentacao');
  const botaoTopo = document.getElementById('abrir-documentacao');
  const corpo = dlg.querySelector('.corpo');
  const meta = dlg.querySelector('.meta-doc');
  const botaoAtualizar = dlg.querySelector('.atualizar-doc');
  const seletor = dlg.querySelector('select[name=projeto]');
  let atual = null;
  let projeto = 'geral'; // documento aberto: geral ou o id de um cliente

  // um documento por projeto: o seletor lista o geral e cada cliente (com novidades pendentes)
  function montarSeletor(lista = []) {
    seletor.replaceChildren(...lista.map((p) => new Option(`${p.id === 'geral' ? '🏢' : '👤'} ${p.nome}${p.pendentes ? ` (${p.pendentes} nova${p.pendentes > 1 ? 's' : ''})` : ''}`, p.id)));
    seletor.value = lista.some((p) => p.id === projeto) ? projeto : 'geral';
  }

  function mostrar(r) {
    // evento ao vivo de outro projeto: só atualiza a lista e a bolinha de novidade
    if (r.projeto && r.projeto !== projeto && dlg.open) { montarSeletor(r.projetos); return; }
    if (r.projeto && r.projeto !== projeto) { botaoTopo.classList.toggle('novidade', Boolean(r.pendentesTotal)); return; }
    atual = r;
    montarSeletor(r.projetos);
    corpo.innerHTML = markdownParaHtml(r.texto || ''); // seguro: markdownParaHtml escapa o texto
    const quando = r.atualizadoEm ? new Date(r.atualizadoEm).toLocaleString('pt-BR') : 'ainda não atualizada';
    meta.textContent = !r.ativo
      ? `Documentador (${nomeDe(r.documentador)}) sem IA configurada: escolha uma IA para ele em ⚙ Equipe.`
      : `${r.nome} · mantida por ${nomeDe(r.por || r.documentador)} · ${quando} · ${r.pendentes ? `${r.pendentes} novidade(s) entram na próxima atualização (a cada ${r.intervaloMin} min)` : 'em dia'}`;
    botaoTopo.classList.toggle('novidade', Boolean(r.pendentesTotal ?? r.pendentes) && !dlg.open);
  }

  async function abrir() {
    if (!servidorAtivo()) return alert('A documentação precisa do servidor (node servidor.js ou o VPS).');
    dlg.showModal();
    botaoTopo.classList.remove('novidade');
    if (!atual) corpo.textContent = 'Carregando…';
    await carregarProjeto();
  }

  async function carregarProjeto() {
    try { mostrar(await (await fetch(`api/documentacao?projeto=${encodeURIComponent(projeto)}`, { cache: 'no-store' })).json()); } catch (erro) { corpo.textContent = `Não consegui carregar: ${erro.message}`; }
  }
  seletor.addEventListener('change', () => { projeto = seletor.value; corpo.textContent = 'Carregando…'; carregarProjeto(); });

  botaoAtualizar.addEventListener('click', async () => {
    botaoAtualizar.disabled = true;
    botaoAtualizar.textContent = 'Atualizando…';
    try { mostrar(await (await fetch(`api/documentacao/atualizar?projeto=${encodeURIComponent(projeto)}`, { method: 'POST' })).json()); } finally {
      botaoAtualizar.disabled = false;
      botaoAtualizar.textContent = 'Atualizar agora';
    }
  });

  dlg.querySelector('.baixar-doc').addEventListener('click', () => {
    const blob = new Blob([atual?.texto || ''], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `documentacao-${projeto}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  dlg.querySelector('.fechar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  botaoTopo.addEventListener('click', abrir);

  // chamado pelo evento em tempo real do servidor
  return { aoAtualizar: mostrar };
}
