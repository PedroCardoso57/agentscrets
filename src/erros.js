// Registro de erros: um lugar escondido com todas as mensagens de erro.
// Junta os erros dos agentes (respostas que falharam), os erros do GitHub e os
// avisos do servidor (supervisor, CI, revisão). Abre clicando em "erros" na
// faixa Hoje ou no "registro de erros" do painel de ordens.

const falhou = (r) => r.erro || /^(Erro:|Interrompida:)/.test(r.texto);
const hora = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function criarRegistroErros({ ordens, nomeDe, nomeCliente, aoVerOrdem, servidorAtivo, aoMudar = () => {} }) {
  const dlg = document.getElementById('dlg-erros');
  const corpo = dlg.querySelector('.corpo');
  const filtro = dlg.querySelector('select[name="tipo"]');
  let avisos = [];

  async function carregarAvisos() {
    if (!servidorAtivo()) return;
    try { const r = await fetch('api/erros'); if (r.ok) { avisos = await r.json(); aoMudar(); } } catch { /* sem servidor */ }
  }

  function itens() {
    const lista = [];
    for (const o of ordens()) {
      o.respostas.forEach((r) => {
        if (falhou(r) && !r.simulada) lista.push({ tipo: 'agente', em: r.em, quem: nomeDe(r.agente), texto: r.texto.replace(/^Erro:\s*/, ''), ordem: o });
        if (r.repo?.erro) lista.push({ tipo: 'github', em: r.em, quem: 'GitHub', texto: r.repo.erro, ordem: o });
      });
    }
    for (const a of avisos) lista.push({ tipo: 'aviso', em: a.em, quem: 'Supervisor', texto: a.texto });
    return lista.sort((a, b) => Date.parse(b.em) - Date.parse(a.em));
  }

  const contagem = () => itens().length;

  function desenhar() {
    const tipo = filtro.value;
    const lista = itens().filter((x) => tipo === 'todos' || x.tipo === tipo).slice(0, 300);
    corpo.innerHTML = '';
    if (!lista.length) {
      corpo.appendChild(Object.assign(document.createElement('p'), { className: 'suave', textContent: 'Nenhum erro registrado. 🎉' }));
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'lista-erros';
    for (const x of lista) {
      const li = document.createElement('li');
      li.className = x.tipo;
      li.innerHTML = '<div class="cab"><b></b><span class="quando"></span></div><div class="pedido"></div><pre></pre>';
      li.querySelector('b').textContent = `${{ agente: '🤖', github: '🔀', aviso: '⚠️' }[x.tipo]} ${x.quem}`;
      li.querySelector('.quando').textContent = hora(x.em);
      if (x.ordem) {
        const p = li.querySelector('.pedido');
        p.textContent = `${x.ordem.cliente ? `👤 ${nomeCliente(x.ordem.cliente)} · ` : ''}${x.ordem.texto.split('\n')[0].slice(0, 160)}`;
        const ver = Object.assign(document.createElement('button'), { type: 'button', textContent: 'ver a ordem' });
        ver.onclick = () => { dlg.close(); aoVerOrdem(x.ordem.id); };
        p.append(' ', ver);
      } else li.querySelector('.pedido').remove();
      li.querySelector('pre').textContent = x.texto;
      ul.appendChild(li);
    }
    corpo.appendChild(ul);
  }

  async function abrir() {
    dlg.showModal();
    await carregarAvisos();
    desenhar();
  }

  function adicionarAviso(aviso) {
    avisos.unshift({ em: aviso.em || new Date().toISOString(), texto: aviso.texto });
    if (dlg.open) desenhar();
    aoMudar();
  }
  const hoje = (iso) => new Date(iso).toDateString() === new Date().toDateString();
  const avisosHoje = () => avisos.filter((a) => hoje(a.em)).length;

  filtro.addEventListener('change', desenhar);
  dlg.querySelector('.fechar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  carregarAvisos();

  return { abrir, adicionarAviso, contagem, avisosHoje, recarregar: carregarAvisos, atualizar: () => dlg.open && desenhar() };
}
