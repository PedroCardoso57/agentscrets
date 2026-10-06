// Janelas "Clientes" (fichas de marca que vão junto com as ordens) e "Rotinas"
// (ordens que saem sozinhas num horário). Só funcionam com o servidor.

import { api, el } from './configuracao.js';

const CAMPOS = [
  ['nome', 'Nome', 'input', 'Ex.: Padaria do Zé'],
  ['nicho', 'Nicho / segmento', 'input', 'Ex.: padaria artesanal de bairro'],
  ['publico', 'Público', 'textarea', 'Quem compra, idade, região, o que valoriza'],
  ['tom', 'Tom de voz', 'textarea', 'Ex.: acolhedor, com humor leve, sem gírias'],
  ['produtos', 'Produtos e serviços', 'textarea', 'Carro-chefe, preços se puder citar, diferenciais'],
  ['evitar', 'O que evitar', 'textarea', 'Ex.: não falar de concorrentes, não prometer entrega'],
  ['exemplos', 'Exemplos que deram certo', 'textarea', 'Cole posts ou textos que funcionaram'],
  ['observacoes', 'Outras informações', 'textarea', 'Datas importantes, @ das redes, site…'],
];
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

async function apagar(caminho) {
  const r = await fetch(caminho, { method: 'DELETE' });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`);
  return dados;
}

export function criarGestao({ servidorAtivo, nomeDe, agentesVisiveis, aoMudarClientes }) {
  const dlgClientes = document.getElementById('dlg-clientes');
  const dlgRotinas = document.getElementById('dlg-rotinas');
  let clientes = [];
  let selecionado = null; // id do cliente aberto ('' = novo)

  for (const d of [dlgClientes, dlgRotinas]) {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
    d.querySelector('.fechar').addEventListener('click', () => d.close());
  }

  function definirClientes(lista) {
    clientes = lista;
    aoMudarClientes(clientes);
    if (dlgClientes.open) desenharClientes();
  }

  async function carregarClientes() {
    try { definirClientes(await api('api/clientes')); } catch { /* sem servidor */ }
  }

  // ---------- Clientes ----------

  function desenharClientes() {
    const corpo = dlgClientes.querySelector('.corpo');
    if (selecionado === null) selecionado = clientes[0]?.id ?? '';
    const lista = el('ul', { class: 'cfg-lista' },
      el('li', { class: selecionado === '' ? 'ativo' : '', onclick: () => { selecionado = ''; desenharClientes(); } }, el('b', {}, '+ Novo cliente')),
      clientes.map((c) => el('li', { class: c.id === selecionado ? 'ativo' : '', onclick: () => { selecionado = c.id; desenharClientes(); } },
        el('b', {}, c.nome), el('small', {}, `#${c.id}${c.nicho ? ` · ${c.nicho}` : ''}`))));
    corpo.replaceChildren(el('div', { class: 'cfg-grade' }, lista, formularioCliente(clientes.find((c) => c.id === selecionado))),
      el('p', { class: 'suave' }, 'A ficha vai junto com toda ordem do cliente: escolha o cliente na barra de ordens ou, no Telegram, comece com #id.'));
  }

  function formularioCliente(c) {
    const f = el('form', { class: 'cfg-form' });
    const campos = {};
    const resultado = el('p', { class: 'resultado', role: 'status' });
    f.append(el('h3', {}, c ? c.nome : 'Novo cliente'));
    for (const [nome, rotulo, tipo, dica] of CAMPOS) {
      const input = tipo === 'input'
        ? el('input', { name: nome, value: c?.[nome] || '', placeholder: dica, maxlength: nome === 'nome' ? 80 : 200 })
        : el('textarea', { name: nome, rows: nome === 'exemplos' ? 4 : 2, placeholder: dica });
      if (tipo === 'textarea') input.value = c?.[nome] || '';
      campos[nome] = input;
      f.append(el('label', {}, el('span', {}, rotulo), input));
    }
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      resultado.className = 'resultado'; resultado.textContent = 'Salvando…';
      try {
        const dados = Object.fromEntries(Object.entries(campos).map(([k, i]) => [k, i.value]));
        const salvo = await api(c ? `api/clientes/${encodeURIComponent(c.id)}` : 'api/clientes', dados);
        selecionado = salvo.id;
        definirClientes(await api('api/clientes'));
        desenharClientes();
        const novo = dlgClientes.querySelector('.resultado');
        novo.className = 'resultado ok'; novo.textContent = `✓ Salvo. No Telegram: #${salvo.id}`;
      } catch (erro) { resultado.className = 'resultado falha'; resultado.textContent = `✗ ${erro.message}`; }
    });
    const remover = async () => {
      if (!confirm(`Apagar a ficha de ${c.nome}? As entregas antigas continuam guardadas.`)) return;
      try { selecionado = null; definirClientes(await apagar(`api/clientes/${encodeURIComponent(c.id)}`)); desenharClientes(); } catch (erro) { alert(erro.message); }
    };
    f.append(el('div', { class: 'acoes' },
      el('button', { type: 'submit' }, c ? 'Salvar' : 'Criar cliente'),
      c ? el('button', { type: 'button', class: 'perigo', onclick: remover }, 'Apagar') : null), resultado);
    return f;
  }

  // ---------- Rotinas ----------

  let rotinas = [];
  let editando = null; // rotina aberta no formulário (null = nova)

  async function desenharRotinas() {
    const corpo = dlgRotinas.querySelector('.corpo');
    try { rotinas = await api('api/rotinas'); } catch (erro) { corpo.replaceChildren(el('p', { class: 'erro' }, erro.message)); return; }
    const itens = rotinas.length ? rotinas.map((r) => {
      const acao = (rotulo, titulo, fn, classe) => el('button', { type: 'button', class: classe || 'secundario', title: titulo, onclick: async () => {
        try { await fn(); await desenharRotinas(); } catch (erro) { alert(erro.message); }
      } }, rotulo);
      return el('li', { class: r.ativa ? '' : 'pausada' },
        el('div', { class: 'topo-rotina' }, el('b', {}, r.nome), el('span', { class: 'quando' }, `🗓 ${r.quando}`)),
        el('div', { class: 'suave' }, `${r.para === 'auto' ? '🔮 Crânio decide' : `Para: ${nomeDe(r.para)}`}${r.cliente ? ` · cliente ${clientes.find((c) => c.id === r.cliente)?.nome || r.cliente}` : ''}`),
        el('div', { class: 'texto-rotina' }, r.texto),
        el('div', { class: 'suave' }, r.ultimoErro ? `⚠️ última vez falhou: ${r.ultimoErro}` : r.ultimaEm ? `Última vez: ${r.ultimaEm.split(' ').reverse().join(' de ')}` : 'Ainda não rodou'),
        el('div', { class: 'acoes-rotina' },
          acao('▶ Rodar agora', 'Manda a ordem agora, sem esperar o horário', () => api(`api/rotinas/${r.id}/rodar`, {})),
          acao(r.ativa ? '⏸ Pausar' : '▶ Ativar', '', () => api(`api/rotinas/${r.id}`, { ...r, ativa: !r.ativa })),
          el('button', { type: 'button', class: 'secundario', onclick: () => { editando = r; desenharRotinas(); } }, 'Editar'),
          acao('Apagar', '', async () => { if (confirm(`Apagar a rotina "${r.nome}"?`)) await apagar(`api/rotinas/${r.id}`); }, 'perigo')));
    }) : [el('li', { class: 'vazio' }, 'Nenhuma rotina ainda. Crie a primeira ao lado.')];
    corpo.replaceChildren(el('div', { class: 'cfg-grade rotinas' }, el('ul', { class: 'lista-rotinas' }, itens), formularioRotina(editando)),
      el('p', { class: 'suave' }, 'As entregas das rotinas aparecem no painel, em 📦 Entregas e no Telegram (se estiver conectado).'));
  }

  function formularioRotina(r) {
    const f = el('form', { class: 'cfg-form' });
    const resultado = el('p', { class: 'resultado', role: 'status' });
    const nome = el('input', { name: 'nome', value: r?.nome || '', placeholder: 'Ex.: Grade da semana', maxlength: 80 });
    const texto = el('textarea', { name: 'texto', rows: 3, placeholder: 'Ex.: monte a grade de posts da semana com 5 ideias e legendas' });
    texto.value = r?.texto || '';
    const para = el('select', { name: 'para' },
      el('option', { value: 'auto', selected: !r || r.para === 'auto' }, '🔮 Crânio decide (ou o Orquestrador)'),
      el('option', { value: 'todos', selected: r?.para === 'todos' }, 'Todos'),
      agentesVisiveis().map((id) => el('option', { value: id, selected: r?.para === id }, nomeDe(id))));
    const cliente = el('select', { name: 'cliente' }, el('option', { value: '' }, 'Sem cliente'),
      clientes.map((c) => el('option', { value: c.id, selected: r?.cliente === c.id }, c.nome)));
    const tipo = el('select', { name: 'tipo' },
      el('option', { value: 'semanal', selected: r?.tipo !== 'mensal' }, 'Nos dias da semana'),
      el('option', { value: 'mensal', selected: r?.tipo === 'mensal' }, 'Uma vez por mês'));
    const dias = DIAS.map((d, i) => el('label', { class: 'dia' }, el('input', { type: 'checkbox', value: i, checked: r ? r.dias?.includes(i) : i === 1 }), el('span', {}, d)));
    const grupoDias = el('div', { class: 'dias' }, dias);
    const diaMes = el('input', { name: 'diaMes', type: 'number', min: 1, max: 28, value: r?.diaMes || 1 });
    const grupoMes = el('label', {}, el('span', {}, 'Dia do mês (1 a 28)'), diaMes);
    const hora = el('input', { name: 'hora', type: 'time', value: r?.hora || '08:00', required: true });
    const mostrar = () => { grupoDias.hidden = tipo.value === 'mensal'; grupoMes.hidden = tipo.value !== 'mensal'; };
    tipo.addEventListener('change', mostrar);
    mostrar();

    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      resultado.className = 'resultado'; resultado.textContent = 'Salvando…';
      try {
        await api(r ? `api/rotinas/${r.id}` : 'api/rotinas', {
          nome: nome.value, texto: texto.value, para: para.value, cliente: cliente.value, tipo: tipo.value, hora: hora.value,
          diaMes: Number(diaMes.value), dias: dias.map((d) => d.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value)),
          ativa: r ? r.ativa : true,
        });
        editando = null;
        await desenharRotinas();
      } catch (erro) { resultado.className = 'resultado falha'; resultado.textContent = `✗ ${erro.message}`; }
    });
    f.append(
      el('h3', {}, r ? `Editar: ${r.nome}` : 'Nova rotina'),
      el('label', {}, el('span', {}, 'Nome'), nome),
      el('label', {}, el('span', {}, 'Ordem'), texto),
      el('label', {}, el('span', {}, 'Para'), para),
      el('label', {}, el('span', {}, 'Cliente'), cliente),
      el('label', {}, el('span', {}, 'Repetir'), tipo),
      grupoDias, grupoMes,
      el('label', {}, el('span', {}, 'Horário (Brasília)'), hora),
      el('div', { class: 'acoes' },
        el('button', { type: 'submit' }, r ? 'Salvar' : 'Criar rotina'),
        r ? el('button', { type: 'button', class: 'secundario', onclick: () => { editando = null; desenharRotinas(); } }, 'Cancelar') : null),
      resultado);
    return f;
  }

  // ---------- botões ----------

  document.getElementById('abrir-clientes').addEventListener('click', () => {
    if (!servidorAtivo()) return alert('Os clientes ficam no servidor (node servidor.js ou o VPS).');
    dlgClientes.showModal();
    desenharClientes();
  });
  document.getElementById('abrir-rotinas').addEventListener('click', () => {
    if (!servidorAtivo()) return alert('As rotinas ficam no servidor (node servidor.js ou o VPS).');
    editando = null;
    dlgRotinas.showModal();
    dlgRotinas.querySelector('.corpo').replaceChildren(el('p', { class: 'suave' }, 'Carregando…'));
    desenharRotinas();
  });

  return { carregarClientes, definirClientes, clientes: () => clientes };
}
