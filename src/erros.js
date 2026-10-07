// Central de notificações: um lugar só com tudo o que o escritório avisa.
// Junta os avisos do servidor (GitHub, monitor de IAs, supervisor, piloto) e os
// erros dos agentes (respostas que falharam). Para não virar uma enxurrada:
//  - as notificações do mesmo PR viram UMA linha, com o estado mais recente do PR
//    e o histórico ao clicar (5 avisos do PR #9 = 1 linha);
//  - filtros: Todas · Problemas · PRs · IAs · Agentes, e por projeto;
//  - "Problemas" mostra só o que ainda está com problema (PR em conflito que depois
//    foi resolvido sai da lista). CI que falha não é problema: fica só no histórico;
//  - o sino conta só os problemas que você ainda não viu.
// Abre pelo sino da barra lateral ou pelo "erros" da faixa Hoje.

const falhou = (r) => r.erro || /^(Erro:|Interrompida:)/.test(r.texto);
const hora = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const hoje = (iso) => new Date(iso).toDateString() === new Date().toDateString();

const CATEGORIAS = {
  todas: { rotulo: 'Todas' },
  problemas: { rotulo: 'Problemas', icone: '⚠️' },
  github: { rotulo: 'PRs', icone: '🔀' },
  ia: { rotulo: 'IAs', icone: '🧠' },
  agentes: { rotulo: 'Agentes', icone: '🤖' },
};
const ESTADO_PR = {
  testando: '🧪 testando', revisando: '🔍 em revisão', corrigindo: '🔧 corrigindo', conflito: '🔀 em conflito',
  falhou: '⏸ parado (não passou)', mesclado: '✅ mesclado', fechado: '🚫 fechado', cancelado: '🚫 cancelado',
};
const MEMORIA = 'notificacoes-lidas-ate';
const MEMORIA_RESOLVIDAS = 'notificacoes-resolvidas'; // chave → data da última notificação quando você marcou
const lerMemoria = (k, padrao) => { try { return localStorage.getItem(k) || padrao; } catch { return padrao; } };
const gravarMemoria = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } };

// Avisos antigos (de antes da central) não têm categoria: deduz pelo texto
function normalizar(a) {
  const n = { ...a, nivel: a.nivel || 'problema' };
  if (!n.categoria) {
    const url = a.texto.match(/https:\/\/github\.com\/[^\s)]+\/pull\/(\d+)/);
    if (url) n.pr = { url: url[0], numero: Number(url[1]) };
    n.categoria = url || /GitHub|Netlify|\bPR\b/.test(a.texto) ? 'github' : /\bA IA\b/.test(a.texto) ? 'ia' : 'agentes';
    // CI que falhou/parou não muda nada no projeto: não conta como problema (conflito conta)
    if (n.categoria === 'github' && /\bCI\b|testes do|terminou como/.test(a.texto) && !/conflito/i.test(a.texto)) n.nivel = 'info';
  }
  // as da mesma IA também ficam juntas (caiu → voltou)
  if (n.categoria === 'ia' && !n.ia) n.ia = a.texto.match(/A IA (.+?) (?:está|voltou)/)?.[1];
  return n;
}

export function criarRegistroErros({ ordens, nomeDe, nomeCliente, aoVerOrdem, servidorAtivo, aoMudar = () => {} }) {
  const dlg = document.getElementById('dlg-erros');
  const corpo = dlg.querySelector('.corpo');
  const abas = dlg.querySelector('.abas-notif');
  const projeto = dlg.querySelector('select[name="projeto"]');
  const telegram = dlg.querySelector('select[name="telegram"]');
  let avisos = [];
  let aba = 'todas';
  let mostrarResolvidos = false;
  let lidasAte = lerMemoria(MEMORIA, '');
  let resolvidas = {};
  try { resolvidas = JSON.parse(lerMemoria(MEMORIA_RESOLVIDAS, '{}')) || {}; } catch { /* memória corrompida */ }
  const abertos = new Set(); // PRs com o histórico aberto

  async function carregarAvisos() {
    if (!servidorAtivo()) return;
    try {
      const r = await fetch('api/notificacoes');
      if (!r.ok) return;
      const dados = await r.json();
      avisos = dados.itens.map(normalizar);
      if (dados.preferencias?.telegram) telegram.value = dados.preferencias.telegram;
      telegram.closest('label').hidden = false;
      aoMudar();
    } catch { /* sem servidor */ }
  }

  // tudo numa lista só: avisos do servidor + erros das respostas dos agentes
  function itens() {
    const lista = avisos.slice();
    for (const o of ordens()) {
      o.respostas.forEach((r, i) => {
        if (falhou(r) && !r.simulada) {
          lista.push({ id: `${o.id}:${i}`, em: r.em, categoria: 'agentes', nivel: o.cancelada ? 'info' : 'problema', quem: nomeDe(r.agente), texto: r.texto.replace(/^Erro:\s*/, ''), ordem: o, cliente: o.cliente });
        }
        if (r.repo?.erro) {
          lista.push({ id: `${o.id}:${i}:gh`, em: r.em, categoria: 'github', nivel: r.repo.desistiu ? 'problema' : 'info', quem: nomeDe(r.agente), texto: `${r.repo.desistiu ? 'Não subiu ao GitHub' : 'Ainda não subiu ao GitHub (tentando de novo sozinho)'}: ${r.repo.erro}`, ordem: o, cliente: o.cliente });
        }
      });
    }
    return lista.sort((a, b) => Date.parse(b.em) - Date.parse(a.em));
  }

  // as do mesmo PR viram um grupo; o estado do grupo é o da notificação mais recente
  function grupos(lista) {
    const porChave = new Map();
    const saida = [];
    for (const x of lista) {
      const chave = x.pr?.url ? `pr:${x.pr.url}` : x.ia ? `ia:${x.ia}` : null;
      if (!chave) { saida.push({ chave: x.id || `${x.em}${x.texto}`, itens: [x], ultimo: x }); continue; }
      if (!porChave.has(chave)) { const g = { chave, pr: x.pr, ia: x.ia, itens: [], ultimo: x }; porChave.set(chave, g); saida.push(g); }
      porChave.get(chave).itens.push(x);
    }
    for (const g of saida) {
      // "já resolvi": sai dos problemas até chegar uma notificação mais nova
      g.dispensado = g.ultimo.nivel === 'problema' && resolvidas[g.chave] >= g.ultimo.em;
      g.nivel = g.dispensado ? 'info' : g.ultimo.nivel;
      g.categoria = g.ultimo.categoria;
      g.cliente = g.itens.find((x) => x.cliente)?.cliente;
      g.estado = g.itens.find((x) => x.estado)?.estado;
      g.teveProblema = g.itens.some((x) => x.nivel === 'problema');
      g.novo = g.itens.some((x) => !lidasAte || x.em > lidasAte);
    }
    return saida;
  }

  const doProjeto = (g) => !projeto.value || g.cliente === projeto.value;
  const naAba = (g, a) => a === 'todas' || (a === 'problemas' ? g.nivel === 'problema' : g.categoria === a);

  function desenharAbas(todos) {
    abas.innerHTML = '';
    for (const [id, c] of Object.entries(CATEGORIAS)) {
      const n = todos.filter((g) => doProjeto(g) && naAba(g, id)).length;
      const b = Object.assign(document.createElement('button'), { type: 'button', className: `aba-notif${id === aba ? ' ativa' : ''}${id === 'problemas' && n ? ' tem' : ''}` });
      b.textContent = `${c.icone ? `${c.icone} ` : ''}${c.rotulo}${id === 'todas' ? '' : ` ${n}`}`;
      b.onclick = () => { aba = id; desenhar(); };
      abas.appendChild(b);
    }
  }

  function desenharProjetos(todos) {
    const atual = projeto.value;
    const ids = [...new Set(todos.map((g) => g.cliente).filter(Boolean))];
    projeto.innerHTML = '<option value="">Todos os projetos</option>';
    for (const id of ids) projeto.appendChild(Object.assign(document.createElement('option'), { value: id, textContent: nomeCliente(id) || id }));
    projeto.value = ids.includes(atual) ? atual : '';
    projeto.hidden = !ids.length;
  }

  function linha(x) {
    const li = document.createElement('li');
    li.className = `notif ${x.nivel}`;
    li.innerHTML = '<div class="cab"><b></b><span class="quando"></span></div><div class="pedido"></div><pre></pre>';
    li.querySelector('b').textContent = `${CATEGORIAS[x.categoria]?.icone || '•'} ${x.quem || CATEGORIAS[x.categoria]?.rotulo || ''}${x.cliente ? ` · ${nomeCliente(x.cliente)}` : ''}`;
    li.querySelector('.quando').textContent = hora(x.em);
    li.classList.toggle('nova', !lidasAte || x.em > lidasAte);
    if (x.ordem) {
      const p = li.querySelector('.pedido');
      p.textContent = x.ordem.texto.split('\n')[0].slice(0, 160);
      const ver = Object.assign(document.createElement('button'), { type: 'button', textContent: 'ver a ordem' });
      ver.onclick = () => { dlg.close(); aoVerOrdem(x.ordem.id); };
      p.append(' ', ver);
    } else li.querySelector('.pedido').remove();
    li.querySelector('pre').textContent = x.texto;
    botaoResolver(li.querySelector('.cab'), { chave: x.id || `${x.em}${x.texto}`, ultimo: x, nivel: x.nivel });
    return li;
  }

  function linhaPR(g) {
    const li = document.createElement('li');
    li.className = `notif pr ${g.nivel}${g.novo ? ' nova' : ''}`;
    li.innerHTML = '<div class="cab"><b></b><span class="estado-pr"></span><span class="quando"></span></div><pre></pre><div class="acoes-pr"></div>';
    li.querySelector('b').textContent = g.pr
      ? `🔀 PR #${g.pr.numero ?? '?'}${g.cliente ? ` · ${nomeCliente(g.cliente)}` : ''}${g.pr.agente ? ` · ${nomeDe(g.pr.agente)}` : ''}`
      : `🧠 ${g.ia}`;
    const est = li.querySelector('.estado-pr');
    est.textContent = g.pr ? ESTADO_PR[g.estado] || (g.nivel === 'problema' ? '⚠️ com problema' : '') : g.ultimo.nivel === 'problema' ? '🔴 com problema' : '🟢 funcionando';
    est.hidden = !est.textContent;
    li.querySelector('.quando').textContent = hora(g.ultimo.em);
    li.querySelector('pre').textContent = g.ultimo.texto;
    const acoes = li.querySelector('.acoes-pr');
    if (g.pr?.url) acoes.appendChild(Object.assign(document.createElement('a'), { href: g.pr.url, target: '_blank', rel: 'noopener', textContent: 'abrir no GitHub ↗' }));
    if (g.itens.length > 1) {
      const aberto = abertos.has(g.chave);
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: `${aberto ? '▾' : '▸'} histórico (${g.itens.length})` });
      b.onclick = () => { if (aberto) abertos.delete(g.chave); else abertos.add(g.chave); desenhar(); };
      acoes.appendChild(b);
      if (aberto) {
        const ol = document.createElement('ol');
        ol.className = 'historico-pr';
        for (const x of g.itens) {
          const item = document.createElement('li');
          item.className = x.nivel;
          item.innerHTML = '<span class="quando"></span> <span></span>';
          item.firstChild.textContent = hora(x.em);
          item.lastChild.textContent = x.texto;
          ol.appendChild(item);
        }
        li.appendChild(ol);
      }
    }
    botaoResolver(acoes, g);
    return li;
  }

  // problema que você já tratou: some de "Problemas" (volta se chegar notificação nova dele)
  function botaoResolver(onde, g) {
    if (g.nivel !== 'problema') return;
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'resolver', textContent: '✓ já resolvi', title: 'Tirar dos problemas (volta se acontecer de novo)' });
    b.onclick = () => {
      resolvidas[g.chave] = g.ultimo.em;
      const chaves = Object.keys(resolvidas);
      if (chaves.length > 500) for (const k of chaves.slice(0, chaves.length - 500)) delete resolvidas[k];
      gravarMemoria(MEMORIA_RESOLVIDAS, JSON.stringify(resolvidas));
      desenhar();
      aoMudar();
    };
    onde.appendChild(b);
  }

  function desenhar() {
    const todos = grupos(itens());
    desenharProjetos(todos);
    desenharAbas(todos);
    const visiveis = todos.filter((g) => doProjeto(g) && naAba(g, aba));
    corpo.innerHTML = '';
    // em Problemas, os que já se resolveram (ex.: CI falhou e depois o PR foi mesclado) ficam escondidos
    const resolvidos = aba === 'problemas' ? todos.filter((g) => doProjeto(g) && (g.teveProblema || g.dispensado) && g.nivel !== 'problema') : [];
    const lista = (mostrarResolvidos ? [...visiveis, ...resolvidos].sort((a, b) => Date.parse(b.ultimo.em) - Date.parse(a.ultimo.em)) : visiveis).slice(0, 300);
    if (!lista.length) {
      corpo.appendChild(Object.assign(document.createElement('p'), { className: 'suave', textContent: aba === 'problemas' ? 'Nenhum problema em aberto. 🎉' : 'Nada por aqui.' }));
    } else {
      const ul = document.createElement('ul');
      ul.className = 'lista-erros';
      for (const g of lista) ul.appendChild(g.pr || g.ia ? linhaPR(g) : linha({ ...g.ultimo, nivel: g.nivel }));
      corpo.appendChild(ul);
    }
    if (resolvidos.length) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ver-resolvidos', textContent: mostrarResolvidos ? 'esconder os já resolvidos' : `mostrar ${resolvidos.length} já resolvido(s)` });
      b.onclick = () => { mostrarResolvidos = !mostrarResolvidos; desenhar(); };
      corpo.appendChild(b);
    }
  }

  // problemas ainda em aberto que chegaram depois da última vez que a central foi aberta
  const naoLidas = () => grupos(itens()).filter((g) => g.nivel === 'problema' && g.novo).length;

  function marcarLidas() {
    lidasAte = new Date().toISOString();
    gravarMemoria(MEMORIA, lidasAte);
    aoMudar();
  }

  async function abrir(opcoes = {}) {
    if (opcoes.aba) aba = opcoes.aba;
    dlg.showModal();
    await carregarAvisos();
    desenhar();
  }

  function adicionarAviso(aviso) {
    avisos.unshift(normalizar({ ...aviso, em: aviso.em || new Date().toISOString() }));
    if (dlg.open) desenhar();
    aoMudar();
  }

  telegram.addEventListener('change', async () => {
    try {
      await fetch('api/notificacoes/preferencias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegram: telegram.value }) });
    } catch { /* sem servidor */ }
  });
  projeto.addEventListener('change', desenhar);
  dlg.addEventListener('close', marcarLidas); // o que você viu deixa de contar no sino
  dlg.querySelector('.fechar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  carregarAvisos();

  return {
    abrir,
    adicionarAviso,
    naoLidas,
    contagem: () => itens().length,
    avisosHoje: () => avisos.filter((a) => a.nivel === 'problema' && hoje(a.em)).length,
    recarregar: carregarAvisos,
    atualizar: () => dlg.open && desenhar(),
  };
}
