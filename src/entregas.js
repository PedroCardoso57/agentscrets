// Janela "Entregas": tudo o que os agentes já produziram, com busca, filtro por
// agente, leitura formatada e download (uma entrega ou todas as filtradas).

import { markdownParaHtml } from './documentacao.js';

export function criarJanelaEntregas({ servidorAtivo, nomeDe }) {
  const dlg = document.getElementById('dlg-entregas');
  const busca = dlg.querySelector('input[name=busca]');
  const filtroAgente = dlg.querySelector('select[name=agente]');
  const lista = dlg.querySelector('.lista-entregas');
  const leitura = dlg.querySelector('.leitura-entrega');
  const rodape = dlg.querySelector('.rodape-entregas');
  let pagina = 1;
  let timerBusca = null;

  const params = () => new URLSearchParams({ q: busca.value, agente: filtroAgente.value });

  async function carregar() {
    lista.replaceChildren(Object.assign(document.createElement('li'), { className: 'vazio', textContent: 'Carregando…' }));
    let dados;
    try {
      dados = await (await fetch(`api/entregas?${params()}&pagina=${pagina}`, { cache: 'no-store' })).json();
    } catch (erro) {
      lista.firstChild.textContent = `Não consegui carregar: ${erro.message}`;
      return;
    }
    // opções de agente (mantém a escolha atual)
    const atual = filtroAgente.value;
    filtroAgente.replaceChildren(new Option('Todos os agentes', ''), ...dados.agentes.map((a) => new Option(nomeDe(a), a)));
    filtroAgente.value = dados.agentes.includes(atual) ? atual : '';

    lista.replaceChildren();
    if (!dados.itens.length) {
      lista.append(Object.assign(document.createElement('li'), { className: 'vazio', textContent: busca.value || filtroAgente.value ? 'Nada encontrado com esse filtro.' : 'Nenhuma entrega ainda. Dê uma ordem para a equipe!' }));
    }
    for (const e of dados.itens) {
      const li = document.createElement('li');
      li.innerHTML = '<div class="topo-item"><b></b><span class="quando"></span></div><div class="pedido"></div><div class="resumo"></div><div class="info"></div>';
      li.querySelector('b').textContent = nomeDe(e.agente);
      li.querySelector('.quando').textContent = new Date(e.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
      li.querySelector('.pedido').textContent = e.pedido;
      li.querySelector('.resumo').textContent = e.resumo;
      li.querySelector('.info').textContent = [e.motor, e.nota === 1 ? '👍' : e.nota === -1 ? '👎' : null, e.de !== 'chefe' ? `delegada por ${nomeDe(e.de)}` : null].filter(Boolean).join(' · ');
      li.onclick = () => abrirEntrega(e, li);
      lista.append(li);
    }
    rodape.querySelector('.total').textContent = `${dados.total} entrega(s)${dados.paginas > 1 ? ` · página ${dados.pagina} de ${dados.paginas}` : ''}`;
    rodape.querySelector('.anterior').disabled = dados.pagina <= 1;
    rodape.querySelector('.proxima').disabled = dados.pagina >= dados.paginas;
  }

  async function abrirEntrega(e, li) {
    for (const x of lista.children) x.classList.toggle('ativo', x === li);
    leitura.replaceChildren(Object.assign(document.createElement('p'), { className: 'suave', textContent: 'Abrindo…' }));
    const r = await fetch(`api/entregas/arquivo?caminho=${encodeURIComponent(e.arquivo)}`, { cache: 'no-store' });
    const texto = r.ok ? await r.text() : 'Não encontrei o arquivo desta entrega.';
    const barra = document.createElement('div');
    barra.className = 'barra-entrega';
    const caminho = Object.assign(document.createElement('code'), { textContent: `dados/entregas/${e.arquivo}` });
    const baixar = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Baixar .md' });
    baixar.onclick = () => salvar(texto, e.arquivo.split('/').pop());
    const copiar = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Copiar texto' });
    copiar.onclick = async () => { await navigator.clipboard.writeText(texto); copiar.textContent = 'Copiado!'; setTimeout(() => { copiar.textContent = 'Copiar texto'; }, 1500); };
    barra.append(caminho, copiar, baixar);
    const corpo = document.createElement('article');
    corpo.className = 'doc';
    corpo.innerHTML = markdownParaHtml(texto); // seguro: markdownParaHtml escapa o texto
    leitura.replaceChildren(barra, corpo);
  }

  function salvar(texto, nome) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([texto], { type: 'text/markdown;charset=utf-8' }));
    a.download = nome;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  busca.addEventListener('input', () => { clearTimeout(timerBusca); timerBusca = setTimeout(() => { pagina = 1; carregar(); }, 300); });
  filtroAgente.addEventListener('change', () => { pagina = 1; carregar(); });
  rodape.querySelector('.anterior').addEventListener('click', () => { pagina--; carregar(); });
  rodape.querySelector('.proxima').addEventListener('click', () => { pagina++; carregar(); });
  rodape.querySelector('.baixar-todas').addEventListener('click', () => { window.location.href = `api/entregas/exportar?${params()}`; });
  dlg.querySelector('.fechar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  document.getElementById('abrir-entregas').addEventListener('click', () => {
    if (!servidorAtivo()) return alert('As entregas ficam no servidor (node servidor.js ou o VPS).');
    dlg.showModal();
    leitura.replaceChildren(Object.assign(document.createElement('p'), { className: 'suave', textContent: 'Escolha uma entrega à esquerda para ler.' }));
    carregar();
  });
}
