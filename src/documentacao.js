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
  let atual = null;

  function mostrar(r) {
    atual = r;
    corpo.innerHTML = markdownParaHtml(r.texto || ''); // seguro: markdownParaHtml escapa o texto
    const quando = r.atualizadoEm ? new Date(r.atualizadoEm).toLocaleString('pt-BR') : 'ainda não atualizada';
    meta.textContent = !r.ativo
      ? `Documentador (${nomeDe(r.documentador)}) sem IA configurada: escolha uma IA para ele em ⚙ Equipe.`
      : `Mantida por ${nomeDe(r.por || r.documentador)} · ${quando} · ${r.pendentes ? `${r.pendentes} novidade(s) entram na próxima atualização (a cada ${r.intervaloMin} min)` : 'em dia'}`;
    botaoTopo.classList.toggle('novidade', Boolean(r.pendentes) && !dlg.open);
  }

  async function abrir() {
    if (!servidorAtivo()) return alert('A documentação precisa do servidor (node servidor.js ou o VPS).');
    dlg.showModal();
    botaoTopo.classList.remove('novidade');
    if (!atual) corpo.textContent = 'Carregando…';
    try { mostrar(await (await fetch('api/documentacao', { cache: 'no-store' })).json()); } catch (erro) { corpo.textContent = `Não consegui carregar: ${erro.message}`; }
  }

  botaoAtualizar.addEventListener('click', async () => {
    botaoAtualizar.disabled = true;
    botaoAtualizar.textContent = 'Atualizando…';
    try { mostrar(await (await fetch('api/documentacao/atualizar', { method: 'POST' })).json()); } finally {
      botaoAtualizar.disabled = false;
      botaoAtualizar.textContent = 'Atualizar agora';
    }
  });

  dlg.querySelector('.baixar-doc').addEventListener('click', () => {
    const blob = new Blob([atual?.texto || ''], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'documentacao-do-projeto.md';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  dlg.querySelector('.fechar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  botaoTopo.addEventListener('click', abrir);

  // chamado pelo evento em tempo real do servidor
  return { aoAtualizar: mostrar };
}
