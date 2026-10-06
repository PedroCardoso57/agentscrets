// Interface em volta da cena: abas do painel, faixa "Hoje", avisos (toasts),
// modo lista (sem 3D) e a marca do escritório (nome e cor vindos do .env).

const ehHoje = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();
const CHAVE_MODO = 'escritorio.modoLista';

export function criarInterface({ aoVisaoGeral, aoMudarModo }) {
  // ---------- abas ----------
  const abas = [...document.querySelectorAll('#painel .aba')];
  function mostrarAba(nome) {
    for (const a of abas) {
      const ativa = a.dataset.aba === nome;
      a.classList.toggle('ativa', ativa);
      a.setAttribute('aria-selected', String(ativa));
    }
    for (const c of document.querySelectorAll('#painel .conteudo-aba')) c.hidden = c.dataset.conteudo !== nome;
  }
  for (const a of abas) a.addEventListener('click', () => mostrarAba(a.dataset.aba));

  function contador(nome, valor) {
    const el = document.querySelector(`[data-contador="${nome}"]`);
    if (el) el.textContent = valor ? String(valor) : '';
  }

  // ---------- faixa "Hoje" ----------
  const kpi = (nome) => document.querySelector(`[data-kpi="${nome}"]`);
  function atualizarKpis({ ordens = [], trabalhando = 0, avisosHoje = 0 } = {}) {
    let entregas = 0;
    let erros = avisosHoje;
    for (const o of ordens) {
      for (const r of o.respostas) {
        if (!ehHoje(r.em) || r.simulada) continue;
        if (r.erro || /^(Erro:|Interrompida:)/.test(r.texto)) erros++; else if (!/^Interrompida:/.test(r.texto)) entregas++;
      }
    }
    kpi('entregas').textContent = entregas;
    kpi('trabalhando').textContent = trabalhando;
    kpi('erros').textContent = erros;
    kpi('trabalhando').parentElement.classList.toggle('ativo', trabalhando > 0);
    kpi('erros').parentElement.classList.toggle('alerta', erros > 0);
  }

  // próxima rotina: calcula a próxima vez que cada rotina ativa roda (no horário do navegador)
  function proximaVez(r, agora = new Date()) {
    const [h, m] = r.hora.split(':').map(Number);
    for (let d = 0; d <= 31; d++) {
      const dia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + d, h, m);
      if (dia <= agora) continue;
      if (r.tipo === 'mensal' ? dia.getDate() === r.diaMes : r.dias?.includes(dia.getDay())) return dia;
    }
    return null;
  }
  async function atualizarRotina() {
    let rotinas;
    try { rotinas = await (await fetch('api/rotinas', { cache: 'no-store' })).json(); } catch { return; }
    if (!Array.isArray(rotinas)) return;
    const proximas = rotinas.filter((r) => r.ativa).map((r) => ({ r, quando: proximaVez(r) })).filter((x) => x.quando).sort((a, b) => a.quando - b.quando);
    const caixa = kpi('rotina').parentElement;
    caixa.hidden = !proximas.length;
    if (!proximas.length) return;
    const { r, quando } = proximas[0];
    const hoje = quando.toDateString() === new Date().toDateString();
    const amanha = quando.toDateString() === new Date(Date.now() + 864e5).toDateString();
    kpi('rotina').textContent = `${hoje ? '' : amanha ? 'amanhã ' : quando.toLocaleDateString('pt-BR', { weekday: 'short' }) + ' '}${r.hora}`;
    kpi('rotina-nome').textContent = r.nome;
    caixa.title = `Próxima rotina: ${r.nome} (${r.quando})`;
  }

  // ---------- avisos ----------
  const caixaAvisos = document.getElementById('avisos');
  function avisar({ icone = '📦', titulo, texto = '', cor, acoes = [], duracao = 9000 }) {
    const t = document.createElement('div');
    t.className = 'toast';
    if (cor) t.style.setProperty('--cor', cor);
    t.innerHTML = '<span class="icone"></span><b></b><p></p>';
    t.querySelector('.icone').textContent = icone;
    t.querySelector('b').textContent = titulo;
    t.querySelector('p').textContent = texto;
    const fechar = () => { t.classList.add('saindo'); setTimeout(() => t.remove(), 300); };
    if (acoes.length) {
      const barra = document.createElement('div');
      barra.className = 'acoes-toast';
      for (const a of acoes) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.rotulo;
        if (a.principal) b.className = 'principal';
        b.onclick = () => { fechar(); a.fn(); };
        barra.appendChild(b);
      }
      t.appendChild(barra);
    }
    caixaAvisos.prepend(t);
    while (caixaAvisos.children.length > 3) caixaAvisos.lastChild.remove();
    let timer = setTimeout(fechar, duracao);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { timer = setTimeout(fechar, 3000); });
  }

  // ---------- modo lista ----------
  const botaoModo = document.getElementById('alternar-modo');
  let modoLista;
  function definirModo(lista, salvar = true) {
    modoLista = lista;
    document.body.classList.toggle('modo-lista', lista);
    botaoModo.dataset.rotulo = lista ? 'Ver o escritório 3D' : 'Modo lista (mais leve)';
    botaoModo.querySelector('span').textContent = lista ? '🏢' : '☰';
    botaoModo.classList.toggle('ativo', lista);
    if (salvar) { try { localStorage.setItem(CHAVE_MODO, lista ? '1' : '0'); } catch { /* sem armazenamento */ } }
    aoMudarModo(lista);
  }
  botaoModo.addEventListener('click', () => definirModo(!modoLista));
  let salvo = null;
  try { salvo = localStorage.getItem(CHAVE_MODO); } catch { /* sem armazenamento */ }
  // no celular começa em modo lista (o 3D pesa); a escolha fica lembrada
  definirModo(salvo === null ? matchMedia('(max-width: 760px)').matches : salvo === '1', false);

  document.getElementById('visao-geral').addEventListener('click', () => {
    if (modoLista) definirModo(false);
    aoVisaoGeral();
  });

  // ---------- marca ----------
  async function carregarMarca() {
    let m;
    try { m = await (await fetch('api/marca', { cache: 'no-store' })).json(); } catch { return null; }
    if (!m?.nome) return null;
    document.querySelector('#topo .nome-marca').textContent = m.nome;
    document.querySelector('#topo .selo').textContent = m.nome.trim()[0] || 'a';
    if (m.subtitulo) document.querySelector('#topo .sub-marca').textContent = m.subtitulo;
    document.title = `${m.nome} — Escritório 3D`;
    if (/^#[0-9a-f]{6}$/i.test(m.cor || '')) {
      document.documentElement.style.setProperty('--marca', m.cor);
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(m.cor.slice(i, i + 2), 16));
      document.documentElement.style.setProperty('--marca-suave', `rgba(${r}, ${g}, ${b}, 0.16)`);
    }
    return m;
  }

  // destaca o cartão de uma ordem no painel
  function destacarOrdem(id) {
    mostrarAba('ordens');
    if (modoLista === undefined) return;
    const li = document.querySelector(`#lista-ordens > li[data-ordem="${CSS.escape(id)}"]`);
    if (!li) return;
    li.scrollIntoView({ behavior: 'smooth', block: 'center' });
    li.classList.add('destaque');
    setTimeout(() => li.classList.remove('destaque'), 2500);
  }

  atualizarRotina();
  setInterval(atualizarRotina, 60000);

  return { mostrarAba, contador, atualizarKpis, atualizarRotina, avisar, carregarMarca, destacarOrdem, modoLista: () => modoLista };
}
