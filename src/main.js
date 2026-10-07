import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { AGENTES, CHEFE, STATUS } from './agentes.js';
import { MESA, criarSala, criarEstacao, posicaoEstacao, desenharTela, desenharQuadro, definirMarcaSala, definirClientesMural, atualizarRelogio, fatorDia, aplicarDiaNoite, definirPainelTV, animarAmbiente } from './escritorio.js';
import { Boneco } from './boneco.js';
import { Chefe } from './chefe.js';
import { Cranio } from './cranio.js';
import { criarIntegracao } from './integracao.js';
import { criarConfiguracao } from './configuracao.js';
import { criarJanelaDocumentacao } from './documentacao.js';
import { criarJanelaEntregas } from './entregas.js';
import { criarGestao } from './gestao.js';
import { criarInterface } from './interface.js';
import { Efeitos } from './efeitos.js';
import { Vida } from './vida.js';
import { criarRegistroErros } from './erros.js';
import { retratosDa } from './retratos.js';
import { criarMonitorIas } from './monitor-ias.js';

// ---------- renderização ----------

const container = document.getElementById('cena');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // cores mais suaves nas luzes fortes
renderer.toneMappingExposure = 1.12;
container.appendChild(renderer.domElement);

const rotulos = new CSS2DRenderer();
rotulos.setSize(innerWidth, innerHeight);
Object.assign(rotulos.domElement.style, { position: 'absolute', top: '0', pointerEvents: 'none' });
container.appendChild(rotulos.domElement);

const cena = new THREE.Scene();
cena.background = new THREE.Color('#1d2230');
cena.fog = new THREE.Fog('#1d2230', 30, 60);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 200);
const controles = new OrbitControls(camera, renderer.domElement);
controles.enableDamping = true;
controles.maxPolarAngle = Math.PI * 0.47;
controles.minDistance = 2.5;
controles.maxDistance = 35;

const hemi = new THREE.HemisphereLight('#fff6e8', '#4a4a55', 1.1);
cena.add(hemi);
const sol = new THREE.DirectionalLight('#fff1d6', 1.6);
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
sol.shadow.bias = -0.0004;
sol.shadow.normalBias = 0.02;
sol.shadow.radius = 4;
cena.add(sol, sol.target);

// ---------- interface em volta da cena ----------

let cenaPausada = false; // modo lista: não desenha o 3D (economiza bateria no celular)
const ui = criarInterface({
  aoVisaoGeral: () => { if (sala) enquadrarTudo(); },
  aoMudarModo: (lista) => { cenaPausada = lista; },
});

const efeitos = new Efeitos(cena);



// pontos de onde saem e chegam as folhas de entrega
const mesaDe = (id) => estacoes.get(id)?.grupo.localToWorld(new THREE.Vector3(0.35, MESA.altura + 0.12, MESA.zCentro - 0.1));
const mesaDoChefe = () => chefe.grupo.localToWorld(new THREE.Vector3(-0.35, MESA.altura + 0.06, MESA.zCentro - 0.1));
const revisorDaCena = () => (estacoes.has('qa') ? 'qa' : 'revisor');

// marca do .env no topo e na placa da parede
ui.carregarMarca().then((m) => { if (m) definirMarcaSala(m.nome, m.cor); });

// dia e noite pelo horário de Brasília (luzes, janelas e relógio de parede)
function atualizarHorario() {
  aplicarDiaNoite(fatorDia(), { cena, hemi, sol });
  atualizarRelogio();
}

// ---------- montagem do escritório ----------

const agentes = AGENTES.map((a) => ({ ...a }));
const estacoes = new Map(); // id → { agente, boneco, estacao, estado, tarefa, etiqueta, item }

// pausas: quem fica sem trabalho levanta, pega água/café, conversa, senta no sofá…
const vida = new Vida({
  estacoes,
  nomeDe: (id) => estacoes.get(id)?.agente.nome || id,
  // assuntos do trabalho real: clientes cadastrados e o que cada um entregou nas últimas horas
  contexto() {
    const recentes = {};
    const limite = Date.now() - 4 * 3600 * 1000;
    for (const o of todasOrdens()) {
      for (const r of o.respostas) {
        if (r.erro || /^(Erro:|Interrompida:)/.test(r.texto) || Date.parse(r.em) < limite || o.origem?.revisaoPR) continue;
        const pedido = o.texto.split('\n')[0].replace(/^[^\wÀ-ú]+/, '').slice(0, 48);
        recentes[r.agente] = pedido.charAt(0).toLowerCase() + pedido.slice(1) + (o.texto.length > 48 ? '…' : '');
      }
    }
    return { clientes: listaClientes.map((c) => c.nome), recentes };
  },
  falar(id, texto) {
    const e = estacoes.get(id);
    if (!e || e.estado !== 'ocioso') return;
    const balao = e.etiqueta.element.querySelector('.balao');
    balao.textContent = texto;
    balao.classList.add('visivel', 'fala');
    clearTimeout(e.timerPapo);
    e.timerPapo = setTimeout(() => { if (e.estado === 'ocioso') balao.classList.remove('visivel', 'fala'); }, 3800);
  },
});
let sala = null;

// o seu bonequinho de chefe
const chefe = new Chefe(CHEFE);
cena.add(chefe.grupo);
const etiquetaChefe = criarEtiqueta(`★ ${CHEFE.nome}`, 'chefe');
chefe.boneco.raiz.add(etiquetaChefe);
etiquetaChefe.element.querySelector('.placa i').style.background = '#f4d35e';

// o Crânio: bola de cristal do Laya, o decisor, na mesa do chefe (só aparece com o Laya configurado)
const cranio = new Cranio();
cranio.grupo.visible = false;
cranio.anexar(chefe.grupo);

function criarEtiqueta(nome, classe = '') {
  const el = document.createElement('div');
  el.className = `etiqueta ${classe}`;
  el.innerHTML = '<div class="balao"></div><div class="placa"><i></i><span></span></div>';
  el.querySelector('.placa span').textContent = nome; // textContent: nomes podem vir dos motores
  const etiqueta = new CSS2DObject(el);
  etiqueta.position.set(0, 2.05, 0);
  return etiqueta;
}

function montar() {
  if (sala) cena.remove(sala.grupo);
  for (const e of estacoes.values()) { cena.remove(e.grupo); e.etiqueta.element.remove(); }
  const anteriores = new Map([...estacoes].map(([id, e]) => [id, { estado: e.estado, tarefa: e.tarefa }]));
  estacoes.clear();

  sala = criarSala(agentes.length);
  cena.add(sala.grupo);
  vida.definirSala(sala);
  const { largura, profundidade, centro } = sala;
  sol.position.set(centro.x + 8, 14, centro.z + 10);
  sol.target.position.copy(centro);
  const s = Math.max(largura, profundidade) / 2 + 2;
  Object.assign(sol.shadow.camera, { left: -s, right: s, top: s, bottom: -s, far: 50 });
  sol.shadow.camera.updateProjectionMatrix();
  chefe.posicionar(agentes.length);

  efeitos.limparAneis();
  agentes.forEach((agente, i) => {
    const { x, z, rot } = posicaoEstacao(i);
    const grupo = new THREE.Group();
    grupo.position.set(x, 0, z);
    grupo.rotation.y = rot;
    grupo.userData.agenteId = agente.id;
    const estacao = criarEstacao(agente);
    const boneco = new Boneco(agente);
    grupo.add(estacao.grupo, boneco.raiz);
    cena.add(grupo);

    efeitos.criarAnel(agente.id, grupo, agente.cor);
    const etiqueta = criarEtiqueta(agente.nome);
    boneco.raiz.add(etiqueta);

    const anterior = anteriores.get(agente.id) || { estado: 'ocioso', tarefa: '' };
    estacoes.set(agente.id, { agente, grupo, estacao, boneco, etiqueta, ...anterior });
  });

  fotos = retratosDa(agentes); // fotinhas 3x4 de cada um (antes do painel, que já usa)
  montarPainel();
  renderizarOrdens();
  for (const id of estacoes.keys()) mostrarStatus(id);
  atualizarHorario();
}

// ---------- painel lateral ----------

const lista = document.getElementById('lista-agentes');
const destinatario = document.getElementById('destinatario');
const clienteOrdem = document.getElementById('cliente-ordem');
let listaClientes = [];
const nomeCliente = (id) => listaClientes.find((c) => c.id === id)?.nome || id;

// seletor de cliente na barra de ordens (só aparece quando há clientes cadastrados)
function atualizarClientes(lista) {
  listaClientes = lista;
  definirClientesMural(lista.map((c) => c.nome));
  const atual = clienteOrdem.value;
  clienteOrdem.replaceChildren(new Option('Sem cliente', ''), ...lista.map((c) => new Option(`👤 ${c.nome}`, c.id)));
  clienteOrdem.value = lista.some((c) => c.id === atual) ? atual : '';
  clienteOrdem.hidden = !lista.length;
  renderizarOrdens();
}
function montarPainel() {
  lista.innerHTML = '';
  const selecionado = destinatario.value;
  destinatario.innerHTML = '<option value="todos">Para: todos</option>';
  if (decisorAtivo) destinatario.prepend(new Option('🔮 Crânio decide (Laya)', 'auto'));
  for (const [id, e] of estacoes) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="avatar"><i class="bolinha"></i></span><span class="nome"><span></span> <small></small></span><span class="tarefa"></span>';
    li.querySelector('.nome span').textContent = e.agente.nome;
    const avatarEquipe = li.querySelector('.avatar');
    const bolinha = avatarEquipe.querySelector('.bolinha');
    pintarAvatar(avatarEquipe, id);
    avatarEquipe.appendChild(bolinha); // pintarAvatar limpa o texto; a bolinha de status volta
    li.style.setProperty('--cor', e.agente.cor);
    e.item = li;
    atualizarSubtitulo(e);
    li.onclick = () => selecionar(id);
    const engrenagem = document.createElement('button');
    engrenagem.type = 'button';
    engrenagem.className = 'engrenagem';
    engrenagem.textContent = '⚙ trocar IA';
    engrenagem.onclick = (ev) => { ev.stopPropagation(); configuracao?.abrirEquipe(id); };
    li.appendChild(engrenagem);
    lista.appendChild(li);
    destinatario.add(new Option(`Para: ${e.agente.nome}`, id));
  }
  destinatario.value = estacoes.has(selecionado) || (selecionado === 'auto' && decisorAtivo) ? selecionado : decisorAtivo ? 'auto' : 'todos';
  ui.contador('equipe', estacoes.size);
}

// ---------- status das IAs (monitor do servidor) ----------
const estadoIas = { ias: [], agentes: {} };
const resumoIas = document.createElement('div');
resumoIas.className = 'resumo-ias';
resumoIas.hidden = true;
lista.before(resumoIas);
let carregandoIas = null;
function carregarIas(forcar = false) {
  if (!integracao?.servidorAtivo()) return;
  clearTimeout(carregandoIas);
  carregandoIas = setTimeout(async () => {
    try {
      const r = await fetch(forcar ? 'api/ias/verificar' : 'api/ias', { method: forcar ? 'POST' : 'GET' });
      if (!r.ok) return;
      Object.assign(estadoIas, await r.json());
      desenharIas();
    } catch { /* sem servidor */ }
  }, forcar ? 0 : 300);
}
function desenharIas() {
  const { ias } = estadoIas;
  resumoIas.hidden = !ias.length;
  const problemas = ias.filter((ia) => !['ok', 'verificando', 'externo'].includes(ia.estado));
  resumoIas.classList.toggle('alerta', problemas.length > 0);
  resumoIas.innerHTML = '<div class="topo-ias"><b></b><button type="button" class="abrir-monitor">monitor</button><button type="button" class="verificar">verificar agora</button></div><ul></ul>';
  resumoIas.querySelector('.abrir-monitor').onclick = () => monitorIas.abrir();
  resumoIas.querySelector('b').textContent = problemas.length
    ? `IAs: ${problemas.length} com problema · ${ias.length - problemas.length} ok`
    : `IAs: todas funcionando (${ias.filter((ia) => ia.estado === 'ok').length})`;
  const botao = resumoIas.querySelector('.verificar');
  botao.onclick = async () => { botao.disabled = true; botao.textContent = 'verificando…'; await carregarIas(true); };
  const ul = resumoIas.querySelector('ul');
  for (const ia of [...problemas, ...ias.filter((x) => !problemas.includes(x))]) {
    const li = document.createElement('li');
    li.className = `ia ${ia.estado}`;
    li.innerHTML = '<span class="estado-ia"></span><span class="nome-ia"></span><small></small>';
    li.querySelector('.estado-ia').textContent = ia.descricao;
    li.querySelector('.nome-ia').textContent = ia.rotulo;
    const usos = [ia.agentes.length ? `usada por ${ia.agentes.map(nomeDe).join(', ')}` : '', ia.reservaDe.length ? `reserva de ${ia.reservaDe.map(nomeDe).join(', ')}` : ''].filter(Boolean).join(' · ');
    li.querySelector('small').textContent = [usos, ia.verificadoEm ? `conferida às ${new Date(ia.verificadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''].filter(Boolean).join(' · ');
    if (ia.mensagem) li.title = ia.mensagem;
    ul.appendChild(li);
  }
  for (const e of estacoes.values()) if (e.item) atualizarSubtitulo(e);
}

function atualizarSubtitulo(e) {
  const partes = [e.agente.funcao, e.agente.motor].filter(Boolean);
  e.item.querySelector('.nome small').textContent = partes.length ? `· ${partes.join(' · ')}` : '';
  // situação da IA do agente (do monitor): só aparece quando há problema
  const ia = estadoIas.agentes[e.agente.id];
  let selo = e.item.querySelector('.selo-ia');
  if (ia && !['ok', 'verificando', 'externo'].includes(ia.estado)) {
    if (!selo) { selo = Object.assign(document.createElement('span'), { className: 'selo-ia' }); e.item.querySelector('.nome').after(selo); }
    selo.textContent = `IA: ${ia.descricao}`;
    selo.title = ia.mensagem || '';
  } else selo?.remove();
}

// Seleciona o agente para a próxima ordem e foca a câmera nele.
function selecionar(id) {
  destinatario.value = id;
  focar(id);
  textoOrdem.focus({ preventScroll: true });
}

// Balão curto: a primeira frase, sem blocos de código
function resumoFala(texto, max = 90) {
  const limpo = String(texto).split('```')[0].split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '';
  return limpo.length > max ? `${limpo.slice(0, max - 1).trimEnd()}…` : limpo;
}

function mostrarStatus(id) {
  const e = estacoes.get(id);
  const { cor, rotulo } = STATUS[e.estado];
  const balao = e.etiqueta.element.querySelector('.balao');
  const respondendo = e.resposta && performance.now() < e.respostaAte;
  balao.textContent = respondendo ? `💬 ${resumoFala(e.resposta)}` : resumoFala(e.tarefa || '', 70);
  balao.classList.toggle('visivel', respondendo || (Boolean(e.tarefa) && e.estado !== 'ocioso'));
  balao.classList.toggle('fala', Boolean(respondendo)); // falas aparecem mesmo de longe
  balao.classList.toggle('erro', e.estado === 'erro');
  e.etiqueta.element.querySelector('.placa i').style.background = cor;
  e.item.querySelector('.bolinha').style.background = cor;
  e.item.querySelector('.tarefa').textContent = e.tarefa ? `${rotulo} — ${e.tarefa}` : rotulo;
  e.estacao.lampada.material.color.set(cor);
  e.estacao.lampada.material.emissive.set(cor);
  e.estacao.luz.color.set(cor);
  atualizarHoje();
}

// faixa "Hoje" e contador de ordens em andamento
function atualizarHoje() {
  const ordens = [...ordensVistas.values()].map((v) => v.ordem);
  ui.atualizarKpis({ ordens, trabalhando: [...estacoes.values()].filter((x) => x.estado === 'trabalhando').length, avisosHoje: registroErros?.avisosHoje() || 0 });
  registroErros?.atualizar();
  // a TV da sala de reunião mostra os mesmos números
  const kpi = (n) => document.querySelector(`[data-kpi="${n}"]`)?.textContent || '0';
  definirPainelTV({ entregas: kpi('entregas'), trabalhando: kpi('trabalhando'), erros: kpi('erros'), projetos: listaClientes.length, proxima: `${kpi('rotina')} ${kpi('rotina-nome') === 'próxima rotina' ? '' : kpi('rotina-nome')}`.trim() });
}

// ---------- câmera ----------

let animacaoCamera = null;
function enquadrarTudo() {
  const { centro, largura, profundidade } = sala;
  // mira um pouco à direita do centro: a copa e a área de reunião (onde a equipe faz as pausas) ficam desse lado
  irPara(new THREE.Vector3(centro.x - 0.3, 0.3, centro.z + 0.1), new THREE.Vector3(centro.x + largura * 0.22, Math.max(largura, profundidade) * 0.66, centro.z + profundidade * 1.02));
}

// câmera na mesa do chefe, de frente para a bola de cristal
function focarCranio() {
  for (const x of estacoes.values()) x.item.classList.remove('foco');
  const alvo = cranio.posicaoMundo().add(new THREE.Vector3(0, 0.15, 0));
  irPara(alvo, alvo.clone().add(new THREE.Vector3(-1.5, 1.0, 0.5))); // pelo lado da bola, por cima: o monitor não tapa
}

function focar(id) {
  const e = estacoes.get(id);
  for (const x of estacoes.values()) x.item.classList.toggle('foco', x === e);
  const giro = e.grupo.rotation.y;
  const eixoY = new THREE.Vector3(0, 1, 0);
  // mira entre o bonequinho e a mesa; câmera por cima do ombro direito, para ver ele e a tela
  const alvo = e.boneco.raiz.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.0, 0.35).applyAxisAngle(eixoY, giro));
  irPara(alvo, alvo.clone().add(new THREE.Vector3(-1.6, 1.3, -2.1).applyAxisAngle(eixoY, giro)));
}

function irPara(alvo, posicao) {
  animacaoCamera = { de: { alvo: controles.target.clone(), pos: camera.position.clone() }, alvo, posicao, t: 0 };
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { enquadrarTudo(); for (const x of estacoes.values()) x.item.classList.remove('foco'); }
});

// clicar num bonequinho ou mesa na cena seleciona o agente
const raycaster = new THREE.Raycaster();
let toqueInicio = null;
renderer.domElement.addEventListener('pointerdown', (ev) => { toqueInicio = [ev.clientX, ev.clientY]; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!toqueInicio || Math.hypot(ev.clientX - toqueInicio[0], ev.clientY - toqueInicio[1]) > 5) return;
  const ponteiro = new THREE.Vector2((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ponteiro, camera);
  const alvos = [...estacoes.values()].map((e) => e.grupo);
  if (cranio.grupo.visible) alvos.push(cranio.grupo);
  const [acerto] = raycaster.intersectObjects(alvos, true);
  for (let o = acerto?.object; o; o = o.parent) {
    if (o.userData.agenteId) return selecionar(o.userData.agenteId);
    if (o === cranio.grupo) { destinatario.value = 'auto'; focarCranio(); return; }
  }
});

// ---------- ordens do chefe ----------

const form = document.getElementById('comando');
const textoOrdem = document.getElementById('texto-ordem');
const aviso = document.getElementById('aviso-ordem');
const listaOrdens = document.getElementById('lista-ordens');
const ordensVistas = new Map(); // id → nº de respostas já mostradas
let integracao = null;
let decisorAtivo = false;
let configuracao = null;
let janelaDoc = null;
let gestao = null;
let clientesCarregados = false;

function avisar(texto, erro = false) {
  aviso.textContent = texto;
  aviso.classList.toggle('erro', erro);
}

// enquanto você digita, o seu bonequinho digita também
let parouDeDigitar = null;
textoOrdem.addEventListener('input', () => {
  chefe.digitando = true;
  clearTimeout(parouDeDigitar);
  parouDeDigitar = setTimeout(() => { chefe.digitando = false; }, 1500);
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  let texto = textoOrdem.value.trim();
  let para = destinatario.value;
  // atalho: "@redator escreva..." escolhe o destinatário pelo id ou nome
  const mencao = texto.match(/^@(\S+)\s+([\s\S]+)/);
  if (mencao) {
    const chave = mencao[1].toLowerCase();
    const achado = chave === 'todos' ? 'todos' : [...estacoes.values()].find((e) => e.agente.id.toLowerCase() === chave || e.agente.nome.toLowerCase() === chave)?.agente.id;
    if (achado) { para = achado; texto = mencao[2]; destinatario.value = achado; }
  }
  if (!texto) return;
  const botao = form.querySelector('button');
  botao.disabled = true;
  try {
    await integracao.enviarOrdem(para, texto, clienteOrdem.value);
    textoOrdem.value = '';
    chefe.digitando = false;
  } catch (erro) {
    avisar(`Não foi possível enviar: ${erro.message}`, true);
  } finally {
    botao.disabled = false;
  }
});

function nomeDe(id) {
  return id === 'todos' ? 'todos' : estacoes.get(id)?.agente.nome || id;
}


let registroErros = null; // registro de erros (criado depois da integração)
const expandidas = new Set(); // respostas abertas com "ver mais"
const todasOrdens = () => [...ordensVistas.values()].map((v) => v.ordem);
const corDe = (id) => estacoes.get(id)?.agente.cor || 'var(--marca)';
// "Tech Lead" → TL, "Back-end" → BE, "DevOps" → DO, "Requisitos" → RE
// Fotinha do agente (retrato do bonequinho); sem foto, as iniciais na cor dele
let fotos = new Map();
function pintarAvatar(el, id) {
  const foto = fotos.get(id);
  el.style.background = corDe(id);
  if (foto) {
    el.textContent = '';
    el.style.backgroundImage = `url(${foto})`;
    el.classList.add('foto');
  } else {
    el.textContent = iniciais(nomeDe(id));
  }
  el.title = nomeDe(id);
}
function iniciais(nome) {
  const partes = String(nome).split(/[\s\-/]+/).filter(Boolean);
  if (partes.length >= 2) return (partes[0][0] + partes[1][0]).toUpperCase();
  const maiusculas = String(nome).replace(/[^A-ZÀ-Ý]/g, '');
  return (maiusculas.length >= 2 ? maiusculas : String(nome)).slice(0, 2).toUpperCase();
}
function horaCurta(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// Pede ao agente para refazer uma entrega (painel e avisos usam o mesmo caminho).
async function pedirAjusteDe(ordem, indice, agente) {
  const pedido = prompt(`O que ${nomeDe(agente)} deve mudar nesta entrega?`, '');
  if (!pedido?.trim()) return;
  try {
    await integracao.pedirAjuste(ordem.id, indice, pedido);
    avisar(`↩ ${nomeDe(agente)} vai ajustar a entrega.`);
  } catch (erro) {
    avisar(`Não consegui pedir o ajuste: ${erro.message}`, true);
  }
}

// ---------- lista de ordens ----------
// Cada ordem sua é um cartão. As tarefas que o Tech Lead passou ao time, a
// entrega final e as revisões de PR ficam dentro dele. A situação é contada do
// seu ponto de vista: só fica "concluída" quando tudo o que ela gerou terminou.

const SITUACAO = {
  fila: { rotulo: '⏳ aguardando', classe: 'fila' },
  andamento: { rotulo: '⚙️ em andamento', classe: 'andamento' },
  tentando: { rotulo: '🔁 tentando de novo', classe: 'tentando' },
  problema: { rotulo: '⚠️ precisa de você', classe: 'problema' },
  concluida: { rotulo: '✅ concluída', classe: 'concluida' },
  cancelada: { rotulo: '⛔ cancelada', classe: 'cancelada' },
};
const FILTROS = [
  ['novas', 'Novas'], ['andamento', 'Andamento'], ['problema', 'Atenção'], ['concluidas', 'Concluídas'], ['todas', 'Todas'],
];
const PR_ABERTO = ['testando', 'revisando', 'corrigindo'];
const PR_PROBLEMA = ['falhou', 'conflito'];
const respostaFalhou = (r) => r.erro || /^(Erro:|Interrompida:)/.test(r.texto);

// o que você já viu: { desde, vistas: { id: nº de respostas vistas } } (só neste navegador)
const memoria = (() => {
  let m = null;
  try { m = JSON.parse(localStorage.getItem('ordens-vistas')); } catch { /* sem armazenamento */ }
  if (!m?.desde) m = { desde: Date.now(), vistas: {}, filtro: 'todas' }; // primeira vez: o histórico já conta como visto
  return m;
})();
const guardarMemoria = () => { try { localStorage.setItem('ordens-vistas', JSON.stringify(memoria)); } catch { /* sem armazenamento */ } };
const abertasNaMao = new Map(); // id → true/false quando você abriu ou fechou o cartão

const filhasDe = (o) => todasOrdens().filter((f) => f.pai === o.id);
const finalDe = (o) => todasOrdens().find((f) => f.consolidacao === o.id);
const revisoesDe = (o) => todasOrdens().filter((f) => f.origem?.revisaoPR && o.respostas.some((r) => r.repo?.url && r.repo.url === f.origem.revisaoPR.url));
const ehCartao = (o) => !o.pai && !o.consolidacao && !o.origem?.revisaoPR;
// a ordem do topo (cartão) de uma ordem qualquer
function cartaoDe(o) {
  let atual = o;
  for (let i = 0; i < 10 && atual && !ehCartao(atual); i++) {
    const acima = todasOrdens().find((x) => x.id === (atual.pai || atual.consolidacao)) || (atual.origem?.revisaoPR && todasOrdens().find((x) => x.respostas.some((r) => r.repo?.url === atual.origem.revisaoPR.url)));
    atual = acima || null;
  }
  return atual || o;
}
// todas as ordens de um cartão (ele, as tarefas do plano em qualquer nível e a entrega final)
function familiaDe(o) {
  const lista = [o];
  for (const f of filhasDe(o)) lista.push(...familiaDe(f));
  const final = finalDe(o);
  if (final) lista.push(final);
  return lista;
}
const respostasDaFamilia = (o) => familiaDe(o).reduce((n, x) => n + x.respostas.length, 0);
const ultimaResposta = (o) => Math.max(0, ...familiaDe(o).flatMap((x) => x.respostas.map((r) => Date.parse(r.em) || 0)));

// Situação de uma ordem sozinha (sem olhar o plano)
function situacaoPropria(o) {
  if (o.cancelada) return 'cancelada';
  if (o.desistida) return o.pai ? 'concluida' : 'problema'; // tarefa de plano que não deu: o Tech Lead já replanejou
  const prs = o.respostas.map((r) => r.repo?.estado).filter(Boolean);
  if (o.estado === 'falhou') return Object.values(o.tentativas || {}).some((t) => t.proxima) ? 'tentando' : 'problema';
  if (prs.some((e) => PR_PROBLEMA.includes(e))) return 'problema';
  if (o.estado === 'pendente') return o.respostas.length ? 'andamento' : 'fila';
  if (o.estado === 'entregue') return 'andamento';
  if (prs.some((e) => PR_ABERTO.includes(e))) return 'andamento';
  return 'concluida';
}
// Situação do cartão inteiro: o pior estado da família manda
function situacaoDe(o) {
  const ordem = ['problema', 'tentando', 'andamento', 'fila', 'concluida'];
  if (o.cancelada) return 'cancelada';
  let pior = situacaoPropria(o);
  for (const x of familiaDe(o).slice(1)) {
    const s = x.cancelada ? 'concluida' : situacaoPropria(x); // tarefa cancelada não segura o plano
    if (ordem.indexOf(s) < ordem.indexOf(pior)) pior = s;
  }
  // plano montado e tarefas prontas, mas a entrega final ainda vai ser pedida
  if (pior === 'concluida' && filhasDe(o).length && !o.consolidada) pior = 'andamento';
  if (pior === 'fila' && familiaDe(o).length > 1) pior = 'andamento';
  return pior;
}
const ehNova = (o) => respostasDaFamilia(o) > (memoria.vistas[o.id] || 0) && ultimaResposta(o) > memoria.desde;
function marcarVista(o) {
  if (!ehNova(o)) return;
  memoria.vistas[o.id] = respostasDaFamilia(o);
  guardarMemoria();
}
function passaNoFiltro(o, f) {
  const s = situacaoDe(o);
  if (f === 'novas') return ehNova(o);
  if (f === 'andamento') return ['fila', 'andamento', 'tentando'].includes(s);
  if (f === 'problema') return s === 'problema';
  if (f === 'concluidas') return s === 'concluida' || s === 'cancelada';
  return true;
}

// Uma resposta de agente (texto, revisão, PR, avaliação)
function blocoResposta(o, r, indice) {
  const resp = document.createElement('div');
  resp.className = 'resp';
  if (respostaFalhou(r)) resp.classList.add('com-erro');
  resp.innerHTML = '<b></b><div class="corpo-resp"></div>';
  resp.querySelector('b').textContent = nomeDe(r.agente);
  const corpoResp = resp.querySelector('.corpo-resp');
  // código entregue: o texto mostra só a explicação, e os arquivos viram etiquetas ("ver código" mostra tudo)
  const chaveResp = `${o.id}:${indice}`;
  const blocos = [...r.texto.matchAll(/```[^\n]*\n[\s\S]*?```/g)];
  const verCodigo = expandidas.has(`${chaveResp}:codigo`);
  const explicacao = blocos.length && !verCodigo ? r.texto.replace(/```[^\n]*\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim() : r.texto;
  corpoResp.textContent = explicacao + (r.simulada ? ' (simulação)' : '');
  if (blocos.length) {
    const arquivos = document.createElement('div');
    arquivos.className = 'arquivos-resp';
    for (const b of blocos.slice(0, 12)) {
      const nome = (b[0].match(/(?:arquivo|file|caminho|path)\s*[:=]\s*([^\n`]+)/i)?.[1] || b[0].match(/^```(\w+)/)?.[1] || 'código').trim();
      arquivos.appendChild(Object.assign(document.createElement('span'), { className: 'arquivo', textContent: nome.split('/').pop(), title: nome }));
    }
    const alternar = Object.assign(document.createElement('button'), { type: 'button', className: 'ver-mais', textContent: verCodigo ? 'esconder código' : `ver código (${blocos.length})` });
    alternar.onclick = (ev) => { ev.stopPropagation(); const k = `${chaveResp}:codigo`; if (expandidas.has(k)) expandidas.delete(k); else expandidas.add(k); renderizarOrdens(); };
    arquivos.appendChild(alternar);
    corpoResp.after(arquivos);
  }
  // respostas longas ficam recolhidas, com "ver mais"
  if (explicacao.length > 280) {
    const aberta = expandidas.has(chaveResp);
    corpoResp.classList.toggle('recolhida', !aberta);
    const verMais = Object.assign(document.createElement('button'), { type: 'button', className: 'ver-mais', textContent: aberta ? 'ver menos' : 'ver mais' });
    verMais.onclick = (ev) => { ev.stopPropagation(); if (expandidas.has(chaveResp)) expandidas.delete(chaveResp); else expandidas.add(chaveResp); renderizarOrdens(); };
    corpoResp.after(verMais);
  }
  if (r.revisao?.observacoes) {
    const obs = document.createElement('details');
    obs.className = 'obs-revisor';
    obs.innerHTML = '<summary>✅ revisado pelo Revisor</summary><div></div>';
    obs.querySelector('div').textContent = r.revisao.observacoes;
    resp.appendChild(obs);
  } else if (r.revisao?.erro) {
    resp.appendChild(Object.assign(document.createElement('div'), { className: 'obs-revisor', textContent: `⚠️ sem revisão: ${r.revisao.erro}` }));
  }
  // código no GitHub: PR e estado do CI
  if (r.repo?.url) { // erro do GitHub vai só para o registro de erros
    const ESTADO_PR = { testando: '⏳ testando no CI', revisando: '🧐 QA revisando o código', corrigindo: '🔧 corrigindo (CI ou revisão)', mesclado: '✅ mesclado', aprovado: '✅ aprovado, esperando você mesclar', falhou: '❌ precisa de um olhar humano', conflito: '⚠️ conflito: precisa de um olhar humano', fechado: '🚫 PR fechado no GitHub', cancelado: '⛔ cancelado' };
    const linha = document.createElement('div');
    linha.className = 'pr-github';
    {
      const a = Object.assign(document.createElement('a'), { href: r.repo.url, target: '_blank', rel: 'noopener', textContent: `🔀 PR #${r.repo.pr}` });
      // testando: o que o CI ainda está esperando e há quanto tempo
      const ha = r.repo.desde ? Math.round((Date.now() - Date.parse(r.repo.desde)) / 60000) : null;
      const espera = r.repo.estado === 'testando' && (r.repo.aguardando || ha != null)
        ? `${r.repo.aguardando ? ` · esperando: ${r.repo.aguardando}` : ''}${ha != null ? ` · há ${ha < 60 ? `${ha} min` : `${Math.floor(ha / 60)} h`}` : ''}` : '';
      linha.append(a, ` · ${ESTADO_PR[r.repo.estado] || r.repo.estado || ''}${espera} · ${r.repo.arquivos?.length || 0} arquivo(s)`);
      if (r.repo.preview) linha.append(' · ', Object.assign(document.createElement('a'), { href: r.repo.preview, target: '_blank', rel: 'noopener', textContent: '🔎 ver preview' }));
    }
    resp.appendChild(linha);
  }
  if (r.repo?.erro) {
    // não subiu ao GitHub: o escritório tenta de novo sozinho (o erro fica no registro de erros)
    const proxima = r.repo.proxima ? new Date(r.repo.proxima).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
    resp.appendChild(Object.assign(document.createElement('div'), {
      className: 'pr-github pendente',
      textContent: r.repo.desistiu ? '⚠️ não subiu ao GitHub (peça um ↩ ajuste para tentar de novo)' : `⏳ ainda não subiu ao GitHub · tenta de novo${proxima ? ` às ${proxima}` : ' em instantes'}`,
      title: r.repo.erro,
    }));
  }
  if (!r.simulada && !o.local) resp.appendChild(barraAvaliacao(o, r, indice));
  return resp;
}

// Tentativas do supervisor e "tentar agora"
function linhasSupervisor(o, destino) {
  const linkErro = () => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'link-erros', textContent: 'ver erro' });
    b.onclick = (ev) => { ev.stopPropagation(); registroErros?.abrir(); };
    return b;
  };
  let mostrou = false;
  for (const [agente, t] of Object.entries(o.tentativas || {})) {
    if (o.estado !== 'falhou' && !o.desistida) continue;
    const linha = document.createElement('div');
    linha.className = 'supervisor';
    const quando = t.proxima ? new Date(t.proxima).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
    // só a situação; a mensagem de erro fica no registro de erros
    linha.textContent = o.desistida
      ? `🔀 ${nomeDe(agente)} não conseguiu${o.pai ? ' · o Tech Lead passou para outro agente' : ' · confira a IA dele em ⚙ Equipe'}`
      : `🔁 ${nomeDe(agente)}: ${t.n ? `${t.n}ª tentativa falhou` : 'falhou'}${quando ? ` · tenta de novo às ${quando}` : ''}`;
    linha.appendChild(linkErro());
    if (!o.local && !o.desistida) {
      const botao = Object.assign(document.createElement('button'), { type: 'button', textContent: '↻ Tentar agora' });
      botao.onclick = async (ev) => {
        ev.stopPropagation();
        botao.disabled = true;
        try { await integracao.tentarDeNovo(o.id, agente); } catch (erro) { avisar(`Não consegui tentar de novo: ${erro.message}`, true); botao.disabled = false; }
      };
      linha.appendChild(botao);
    }
    destino.appendChild(linha);
    mostrou = true;
  }
  // erro sem supervisor (ex.: motor externo): só o aviso discreto
  if (!mostrou && o.estado === 'falhou') {
    const linha = Object.assign(document.createElement('div'), { className: 'supervisor', textContent: '⚠️ deu erro' });
    linha.appendChild(linkErro());
    destino.appendChild(linha);
  }
}

// Cancelar: o chefe não quer mais. Para a ordem e tudo o que ela gerou.
async function cancelarOrdem(o, ev) {
  ev?.stopPropagation();
  const filhas = filhasDe(o).filter((f) => !f.cancelada && situacaoDe(f) !== 'concluida').length;
  if (!confirm(`Cancelar "${o.texto.slice(0, 80)}"?${filhas ? `\n\nAs ${filhas} tarefa(s) do plano que ainda não terminaram também param.` : ''}\nNinguém tenta de novo e nada mais sobe ao GitHub.`)) return;
  try {
    const r = await fetch(`api/ordens/${encodeURIComponent(o.id)}/cancelar`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || `HTTP ${r.status}`);
    avisar('⛔ Ordem cancelada.');
  } catch (erro) {
    avisar(`Não consegui cancelar: ${erro.message}`, true);
  }
}
const podeCancelar = (o) => !o.local && !o.cancelada && ['fila', 'andamento', 'tentando', 'problema'].includes(situacaoDe(o));

// Tarefa do plano (ou entrega final / revisão) dentro do cartão: uma linha que abre as respostas
function blocoTarefa(f, rotulo) {
  const d = document.createElement('details');
  d.className = `tarefa-plano ${SITUACAO[situacaoDe(f)].classe}`;
  d.style.setProperty('--cor', corDe(f.para));
  d.open = abertasNaMao.get(`t:${f.id}`) ?? (f.consolidacao ? true : ['problema', 'tentando'].includes(situacaoDe(f)));
  d.addEventListener('toggle', () => abertasNaMao.set(`t:${f.id}`, d.open));
  const s = document.createElement('summary');
  s.innerHTML = '<span class="estado"></span><span class="avatar mini"></span><b></b><span class="txt"></span>';
  pintarAvatar(s.querySelector('.avatar'), f.para);
  s.querySelector('.estado').textContent = SITUACAO[situacaoDe(f)].rotulo.split(' ')[0];
  s.querySelector('.estado').title = SITUACAO[situacaoDe(f)].rotulo;
  s.querySelector('b').textContent = rotulo || nomeDe(f.para);
  s.querySelector('.txt').textContent = f.texto.split('\n')[0];
  if (podeCancelar(f) && !f.consolidacao) {
    const x = Object.assign(document.createElement('button'), { type: 'button', className: 'cancelar-tarefa', textContent: '✕', title: 'Cancelar esta tarefa' });
    x.onclick = (ev) => { ev.preventDefault(); cancelarOrdem(f, ev); };
    s.appendChild(x);
  }
  d.appendChild(s);
  linhasSupervisor(f, d);
  f.respostas.forEach((r, i) => { if (!respostaFalhou(r)) d.appendChild(blocoResposta(f, r, i)); });
  for (const neta of filhasDe(f)) d.appendChild(blocoTarefa(neta));
  if (!f.respostas.length && !filhasDe(f).length) d.appendChild(Object.assign(document.createElement('div'), { className: 'espera', textContent: f.estado === 'pendente' ? 'Na fila do agente.' : 'Trabalhando nisso…' }));
  return d;
}

let filtroOrdens = FILTROS.some(([f]) => f === memoria.filtro) ? memoria.filtro : 'todas';
const barraFiltros = document.createElement('div');
barraFiltros.className = 'filtros-ordens';
listaOrdens.before(barraFiltros);

function desenharFiltros(cartoes) {
  barraFiltros.innerHTML = '';
  for (const [f, nome] of FILTROS) {
    const n = f === 'todas' ? 0 : cartoes.filter((o) => passaNoFiltro(o, f)).length;
    if (f === 'problema' && !n && filtroOrdens !== 'problema') continue; // só aparece quando há algo
    const b = Object.assign(document.createElement('button'), { type: 'button', className: `filtro ${f}` });
    b.textContent = nome;
    if (n) b.appendChild(Object.assign(document.createElement('span'), { textContent: n }));
    b.classList.toggle('ativo', filtroOrdens === f);
    b.onclick = () => { filtroOrdens = f; memoria.filtro = f; guardarMemoria(); renderizarOrdens(); };
    barraFiltros.appendChild(b);
  }
  const acoes = Object.assign(document.createElement('span'), { className: 'acoes-filtros' });
  const reg = Object.assign(document.createElement('button'), { type: 'button', className: 'icone-filtro registro-erros', title: 'Registro de erros', ariaLabel: 'Registro de erros' });
  reg.innerHTML = '<svg class="icone" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
  reg.onclick = () => registroErros?.abrir();
  if (cartoes.some(ehNova)) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icone-filtro marcar-vistas', title: 'Marcar todas como vistas', ariaLabel: 'Marcar todas como vistas' });
    b.innerHTML = '<svg class="icone" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 7 17l-5-5M22 10l-7.5 7.5L13 16"/></svg>';
    b.onclick = () => { for (const o of cartoes) memoria.vistas[o.id] = respostasDaFamilia(o); guardarMemoria(); renderizarOrdens(); };
    acoes.appendChild(b);
  }
  acoes.appendChild(reg);
  const trilho = document.createElement('div');
  trilho.className = 'trilho-filtros';
  trilho.append(...barraFiltros.querySelectorAll('.filtro'));
  barraFiltros.append(trilho, acoes);
}

function renderizarOrdens() {
  const cartoes = todasOrdens().filter(ehCartao).reverse();
  ui.contador('ordens', cartoes.filter((o) => ehNova(o) || situacaoDe(o) === 'problema').length || '');
  if (!todasOrdens().length) return;
  desenharFiltros(cartoes);
  const visiveis = cartoes.filter((o) => passaNoFiltro(o, filtroOrdens)).slice(0, 30);
  listaOrdens.innerHTML = '';
  if (!visiveis.length) {
    const vazio = { novas: 'Nenhuma resposta nova. Tudo visto!', andamento: 'Nada em andamento agora.', problema: 'Nada precisando de você.', concluidas: 'Nenhuma ordem concluída ainda.' }[filtroOrdens];
    listaOrdens.appendChild(Object.assign(document.createElement('li'), { className: 'vazio', textContent: vazio || 'Nenhuma ordem.' }));
  }
  for (const o of visiveis) {
    const situacao = situacaoDe(o);
    const nova = ehNova(o);
    const li = document.createElement('li');
    li.dataset.ordem = o.id;
    li.className = `sit-${SITUACAO[situacao].classe}${nova ? ' nova' : ''}`;
    li.style.setProperty('--cor', corDe(o.para));
    // aberto: o que você abriu; senão, o que ainda pede atenção
    const aberto = abertasNaMao.get(o.id) ?? (nova || !['concluida', 'cancelada'].includes(situacao));
    li.classList.toggle('recolhido', !aberto);
    li.innerHTML = '<div class="cab"><span class="avatar"></span><div class="quem-cab"><b></b><small></small></div><span class="chip"></span></div><div class="texto"></div>';
    pintarAvatar(li.querySelector('.avatar'), o.para);
    li.querySelector('.cab b').textContent = o.para === 'todos' ? 'Toda a equipe' : nomeDe(o.para);
    li.querySelector('.cab small').textContent = [o.de && o.de !== 'chefe' ? `de ${nomeDe(o.de)}` : 'sua ordem', horaCurta(o.criadaEm), o.cliente ? nomeCliente(o.cliente) : null].filter(Boolean).join(' · ');
    const chip = li.querySelector('.chip');
    const simulada = o.local || o.respostas.some((r) => r.simulada);
    chip.textContent = simulada && situacao !== 'concluida' ? 'simulação' : SITUACAO[situacao].rotulo;
    chip.classList.add(SITUACAO[situacao].classe);
    if (nova) li.querySelector('.cab b').append(Object.assign(document.createElement('span'), { className: 'selo-nova', textContent: 'NOVA' }));
    li.querySelector('.texto').textContent = o.texto;
    // clicar no cabeçalho abre/fecha e marca como visto
    li.querySelector('.cab').onclick = () => { abertasNaMao.set(o.id, !aberto); marcarVista(o); renderizarOrdens(); };
    li.querySelector('.texto').onclick = li.querySelector('.cab').onclick;

    // de onde veio a ordem
    const marcas = [
      o.cliente && o.clienteReconhecido ? `👤 cliente reconhecido no pedido` : null,
      o.ajuste ? '↩ ajuste' : null,
      o.texto.startsWith('Replanejar:') ? '🔀 replanejamento' : null,
      o.origem?.rotina ? '🗓 rotina' : null,
      o.origem?.autopiloto ? '🤖 piloto automático' : null,
      o.origem?.telegram ? '✈ Telegram' : null,
    ].filter(Boolean);
    if (marcas.length) li.querySelector('.cab').after(Object.assign(document.createElement('div'), { className: 'marcas', textContent: marcas.join(' · ') }));

    // plano: barra de progresso das tarefas (aparece mesmo recolhido)
    const filhas = filhasDe(o);
    if (filhas.length) {
      const prontas = filhas.filter((f) => situacaoDe(f) === 'concluida').length;
      const plano = document.createElement('div');
      plano.className = 'plano';
      const final = finalDe(o);
      plano.innerHTML = '<span class="trilho"><i></i></span><span class="rotulo"></span>';
      plano.querySelector('i').style.width = `${Math.round((prontas / filhas.length) * 100)}%`;
      plano.querySelector('.rotulo').textContent = prontas < filhas.length
        ? `${prontas} de ${filhas.length} tarefas prontas`
        : final ? (final.respostas.some((r) => !respostaFalhou(r)) ? `${filhas.length} tarefas prontas · entrega final pronta` : `${filhas.length} tarefas prontas · montando a entrega final`)
          : o.consolidada ? `${filhas.length} tarefas prontas` : `${filhas.length} tarefas prontas · juntando tudo`;
      li.appendChild(plano);
    }

    if (aberto) {
      linhasSupervisor(o, li);
      if (o.decisao) {
        const d = document.createElement('div');
        d.className = 'decisao';
        d.textContent = textoDecisao(o.decisao);
        if (o.decisao.ranking) d.title = `Como o Crânio pesou: ${o.decisao.ranking.map((x) => `${nomeDe(x.id)} ${Math.round(x.p * 100)}%`).join(' · ')}`;
        d.classList.toggle('alerta', ['alertou', 'redirecionou', 'indisponivel'].includes(o.decisao.modo));
        li.appendChild(d);
      }
      // a entrega final vem primeiro: é o resultado que importa
      const final = finalDe(o);
      if (final) li.appendChild(blocoTarefa(final, '🏁 Entrega final'));
      o.respostas.forEach((r, indice) => {
        if (respostaFalhou(r)) return; // erros ficam no registro de erros
        const bloco = blocoResposta(o, r, indice);
        if (filhas.length) bloco.classList.add('planejamento'); // a resposta do Tech Lead é o plano, não a entrega
        li.appendChild(bloco);
      });
      if (filhas.length) {
        const t = Object.assign(document.createElement('div'), { className: 'titulo-tarefas', textContent: 'Tarefas do time' });
        li.appendChild(t);
        for (const f of filhas) li.appendChild(blocoTarefa(f));
      }
      for (const rev of revisoesDe(o)) li.appendChild(blocoTarefa(rev, `🧐 Revisão do PR #${rev.origem.revisaoPR.numero}`));
      if (!o.respostas.length && !filhas.length) li.appendChild(Object.assign(document.createElement('div'), { className: 'espera', textContent: situacao === 'fila' ? `Na fila de ${nomeDe(o.para)}.` : `${nomeDe(o.para)} está trabalhando nisso…` }));
      if (podeCancelar(o)) {
        const rodape = Object.assign(document.createElement('div'), { className: 'rodape-cartao' });
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'cancelar-ordem', textContent: '⛔ Cancelar ordem', title: 'Não quero mais: para a ordem e as tarefas do plano dela' });
        b.onclick = (ev) => cancelarOrdem(o, ev);
        rodape.appendChild(b);
        li.appendChild(rodape);
      }
      if (o.cancelada) li.appendChild(Object.assign(document.createElement('div'), { className: 'espera', textContent: `Cancelada por você às ${new Date(o.cancelada).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.` }));
      if (nova) li.addEventListener('pointerenter', () => setTimeout(() => { if (li.matches(':hover')) { marcarVista(o); li.classList.remove('nova'); li.querySelector('.selo-nova')?.remove(); ui.contador('ordens', cartoes.filter((x) => ehNova(x) || situacaoDe(x) === 'problema').length || ''); } }, 1500), { once: true });
    }
    listaOrdens.appendChild(li);
  }
}

// "Ver" num aviso: abre o cartão da ordem (mesmo que a resposta seja de uma tarefa do plano)
function verOrdem(id) {
  const o = todasOrdens().find((x) => x.id === id);
  if (!o) return ui.destacarOrdem(id);
  const cartao = cartaoDe(o);
  abertasNaMao.set(cartao.id, true);
  if (cartao !== o) abertasNaMao.set(`t:${o.id}`, true);
  if (!passaNoFiltro(cartao, filtroOrdens)) { filtroOrdens = 'todas'; }
  marcarVista(cartao);
  renderizarOrdens();
  ui.destacarOrdem(cartao.id);
}

// Como o Crânio decidiu, em uma linha
function textoDecisao(dc) {
  const certeza = `${Math.round((dc.confianca || 0) * 100)}%`;
  let t;
  if (dc.modo === 'indisponivel') return '🔮 Crânio fora do ar: a ordem seguiu direto';
  if (dc.modo === 'confirmou') t = `🔮 Crânio confirmou ${nomeDe(dc.agente)} (${certeza})`;
  else if (dc.modo === 'alertou') t = `🔮 Você escolheu ${nomeDe(dc.agente)}; o Crânio indicaria ${nomeDe(dc.escolhaOriginal)} (${certeza})`;
  else if (dc.modo === 'redirecionou') t = `🔮 Crânio redirecionou de ${nomeDe(dc.sugerido)} para ${nomeDe(dc.agente)} (${certeza})`;
  else if (dc.incerto) t = `🔮 Crânio ficou em dúvida (${nomeDe(dc.escolhaOriginal)}, ${certeza}) e mandou para ${nomeDe(dc.agente)}`;
  else t = `🔮 Crânio escolheu ${nomeDe(dc.agente)} (${certeza} de certeza)`;
  return dc.urgencia ? `${t} · urgência: ${dc.urgencia}` : t;
}

function resumoCranio(dc) {
  if (dc.modo === 'alertou') return `${nomeDe(dc.agente)} (chefe) · eu indicaria ${nomeDe(dc.escolhaOriginal)}`;
  if (dc.modo === 'redirecionou') return `${nomeDe(dc.sugerido)} → ${nomeDe(dc.agente)} · ${Math.round((dc.confianca || 0) * 100)}%`;
  return `${nomeDe(dc.agente)} · ${Math.round((dc.confianca || 0) * 100)}%${dc.urgencia ? ` · ${dc.urgencia}` : ''}`;
}

// 👍 / 👎 em cada resposta, com a IA que respondeu e o tempo — base do relatório
function barraAvaliacao(ordem, r, indice) {
  const meta = document.createElement('div');
  meta.className = 'meta';
  const info = document.createElement('span');
  info.textContent = [r.motor, typeof r.ms === 'number' ? `${(r.ms / 1000).toFixed(1)} s` : null].filter(Boolean).join(' · ');
  for (const [nota, emoji, titulo] of [[1, '👍', 'Boa resposta'], [-1, '👎', 'Resposta ruim']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.title = titulo;
    b.classList.toggle('marcado', r.nota === nota);
    b.onclick = async () => {
      const nova = r.nota === nota ? 0 : nota; // clicar de novo desmarca
      let comentario;
      if (nova === -1) comentario = prompt('O que faltou nessa resposta? (opcional, ajuda a escolher a melhor IA)') ?? undefined;
      try {
        const r2 = await fetch(`api/ordens/${encodeURIComponent(ordem.id)}/avaliacao`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ indice, nota: nova, comentario }),
        });
        if (!r2.ok) throw new Error((await r2.json().catch(() => ({}))).erro || `HTTP ${r2.status}`);
        aoOrdem(await r2.json(), { nova: false });
      } catch (erro) {
        avisar(`Não consegui salvar a avaliação: ${erro.message}`, true);
      }
    };
    meta.appendChild(b);
  }
  if (!r.erro && !/^(Erro:|Interrompida:)/.test(r.texto)) {
    const ajustar = document.createElement('button');
    ajustar.type = 'button';
    ajustar.className = 'ajustar';
    ajustar.textContent = '↩ ajustar';
    ajustar.title = `Pedir para ${nomeDe(r.agente)} refazer esta entrega`;
    ajustar.onclick = () => pedirAjusteDe(ordem, indice, r.agente);
    meta.appendChild(ajustar);
  }
  meta.appendChild(info);
  if (r.comentario) {
    const c = document.createElement('div');
    c.className = 'coment';
    c.textContent = `“${r.comentario}”`;
    const box = document.createElement('div');
    box.append(meta, c);
    return box;
  }
  return meta;
}

function aoOrdem(ordem, { nova }) {
  const vista = ordensVistas.get(ordem.id);
  const respostasAntes = vista ? vista.respostas : 0;
  ordensVistas.set(ordem.id, { ordem, respostas: ordem.respostas.length });
  renderizarOrdens();
  atualizarHoje();

  // respostas novas aparecem no balão do agente por alguns segundos (e num aviso)
  ordem.respostas.slice(respostasAntes).forEach((r, i) => {
    if (!vista || r.simulada) return;
    if (r.erro || /^(Erro:|Interrompida:)/.test(r.texto)) return; // erros vão só para o registro de erros
    const indice = respostasAntes + i;
    const erro = r.erro || /^Erro:/.test(r.texto);
    // a folha sai da mesa do agente, passa pelo Revisor (se revisou) e pousa na mesa do chefe
    const origem = mesaDe(r.agente);
    if (!erro && origem && !cenaPausada) {
      const pontos = [origem];
      const rev = r.revisao?.por || revisorDaCena();
      if (r.revisao && !r.revisao.erro && r.agente !== rev && estacoes.has(rev)) pontos.push(mesaDe(rev));
      pontos.push(mesaDoChefe());
      efeitos.entrega(pontos);
    }
    ui.avisar({
      foto: fotos.get(r.agente),
      icone: erro ? '⚠️' : r.revisao && !r.revisao.erro ? '✅' : '📦',
      titulo: erro ? `${nomeDe(r.agente)} teve um erro` : `${nomeDe(r.agente)} entregou${ordem.cliente ? ` · ${nomeCliente(ordem.cliente)}` : ''}`,
      texto: r.texto.split('\n').find((l) => l.trim()) || '',
      cor: corDe(r.agente),
      acoes: [
        { rotulo: 'Ver', principal: true, fn: () => verOrdem(ordem.id) },
        ...(erro ? [] : [{ rotulo: '↩ Ajustar', fn: () => pedirAjusteDe(ordem, indice, r.agente) }]),
      ],
    });
  });
  if (nova && vista === undefined && ordem.origem?.autopiloto && !ordem.pai && !ordem.consolidacao) {
    ui.avisar({ icone: '🤖', titulo: 'Piloto automático', texto: `O Tech Lead está decidindo o próximo passo: ${nomeCliente(ordem.cliente)}`, cor: corDe(ordem.para), duracao: 6000 });
  } else if (nova && vista === undefined && (ordem.origem?.rotina || ordem.origem?.telegram) && (!ordem.de || ordem.de === 'chefe')) {
    ui.avisar({ icone: ordem.origem.rotina ? '⏰' : '✈️', titulo: ordem.origem.rotina ? 'Rotina disparou' : 'Ordem pelo Telegram', texto: `${nomeDe(ordem.para)}: ${ordem.texto}`, cor: corDe(ordem.para), duracao: 6000 });
    if (!cenaPausada && sala) {
      if (ordem.origem.rotina) efeitos.despertador(mesaDoChefe().add(new THREE.Vector3(0, 0.95, 0)), 'Rotina!');
      // o aviãozinho entra por uma janela do fundo e pousa na mesa do chefe
      else efeitos.telegram(new THREE.Vector3(sala.centro.x + 2, 2.1, sala.centro.z - sala.profundidade / 2 + 0.4), mesaDoChefe());
    }
  }
  for (const r of ordem.respostas.slice(respostasAntes)) {
    const e = estacoes.get(r.agente);
    if (!e || !vista) continue;
    e.resposta = r.texto;
    e.respostaAte = performance.now() + 7000;
    mostrarStatus(r.agente);
    setTimeout(() => estacoes.has(r.agente) && mostrarStatus(r.agente), 7100);
  }

  if (!nova) return;
  if (ordem.de && ordem.de !== 'chefe') {
    // delegada entre agentes: o seu bonequinho não vai, mas a decisão passa pelo Crânio (feixe até o agente)
    const e = estacoes.get(ordem.para);
    if (ordem.decisao && ordem.decisao.modo !== 'indisponivel' && cranio.grupo.visible && e) {
      cranio.decidir(e.boneco.raiz.getWorldPosition(new THREE.Vector3()), resumoCranio(ordem.decisao));
    }
    return;
  }
  if (ordem.local) avisar('Sem servidor, a ordem fica só na simulação. Rode "node servidor.js" para ela chegar aos seus motores.');
  else avisar(chefe.ocupado() ? 'Ordem na fila: o seu bonequinho entrega assim que terminar a anterior.' : '');
  const todos = ordem.para === 'todos';
  const alvos = todos ? [...estacoes.values()] : [estacoes.get(ordem.para)].filter(Boolean);
  if (!todos && !alvos.length) return integracao.cumprirNaSimulacao(ordem); // agente sem mesa
  const balao = etiquetaChefe.element.querySelector('.balao');
  // ordem decidida pelo Crânio: o bonequinho passa lá antes, e o Crânio mostra a decisão
  let parada;
  if (ordem.decisao && ordem.decisao.modo !== 'indisponivel' && cranio.grupo.visible && alvos.length === 1) {
    const resumo = resumoCranio(ordem.decisao);
    parada = {
      ...cranio.parada(chefe.grupo),
      tempo: 2.4,
      aoChegar: () => cranio.decidir(alvos[0].boneco.raiz.getWorldPosition(new THREE.Vector3()), resumo),
    };
  }
  chefe.darOrdem({
    texto: ordem.texto,
    alvos,
    todos,
    parada,
    aoFalar(texto) {
      balao.textContent = todos ? `Pessoal: ${texto}` : texto;
      balao.classList.add('visivel');
    },
    aoTerminar() {
      balao.classList.remove('visivel');
      integracao.cumprirNaSimulacao(ordem);
    },
  });
}

// ---------- integração ----------

montar();
enquadrarTudo();

const conexao = document.getElementById('conexao');
integracao = criarIntegracao({
  aoDocumentacao: (r) => janelaDoc?.aoAtualizar(r),
  aoClientes: (lista) => gestao?.definirClientes(lista),
  aoAviso: (aviso) => registroErros?.adicionarAviso(aviso), // vai para o registro de erros (sem aviso na tela)
  aoAvisoOk: ({ texto }) => ui.avisar({ icone: '✅', titulo: 'IA de volta', texto: texto.replace(/^✅\s*/, ''), cor: 'var(--trabalhando)', duracao: 8000 }),
  aoIas: (porAgente) => { estadoIas.agentes = porAgente; carregarIas(); },
  aoDecisor({ ativo, online }) {
    cranio.grupo.visible = ativo;
    cranio.definirOnline(online);
    if (ativo === decisorAtivo) return;
    decisorAtivo = ativo;
    montarPainel();
    for (const id of estacoes.keys()) mostrarStatus(id);
  },
  aoOrdem,
  ids: () => [...estacoes.keys()],
  aoAtualizar(id, dados) {
    const e = estacoes.get(id);
    if (!e) return false;
    if (dados.status) e.estado = dados.status;
    if ('tarefa' in dados) e.tarefa = dados.tarefa || '';
    if (dados.motor && dados.motor !== e.agente.motor) {
      e.agente.motor = dados.motor; // qual IA move este agente
      atualizarSubtitulo(e);
    }
    mostrarStatus(id);
    return true;
  },
  aoRemovido(id) {
    const i = agentes.findIndex((a) => a.id === id);
    if (i < 0) return;
    agentes.splice(i, 1);
    montar();
    enquadrarTudo();
  },
  aoNovoAgente(dados) {
    if (estacoes.has(dados.id)) return;
    const cores = ['#e5484d', '#4c8dff', '#3fb27f', '#b05cf0', '#e0b23c', '#2ec4d6', '#f07a3a'];
    agentes.push({
      nome: dados.nome || dados.id,
      funcao: dados.funcao || '',
      atividade: dados.atividade || 'digitar',
      cor: dados.cor || cores[agentes.length % cores.length],
      cabelo: dados.cabelo, pele: dados.pele, estilo: dados.estilo, barba: dados.barba, feminina: Boolean(dados.feminina),
      id: dados.id,
    });
    montar();
    enquadrarTudo();
    const e = estacoes.get(dados.id);
    if (!e) return;
    if (dados.status && STATUS[dados.status]) e.estado = dados.status;
    e.tarefa = dados.tarefa || '';
    mostrarStatus(dados.id);
  },
  aoConexao(texto, online) {
    conexao.textContent = `● ${texto}`;
    conexao.classList.toggle('online', online);
    // ao conectar no servidor, busca os clientes (para o seletor da barra de ordens)
    if (online && gestao && !clientesCarregados && integracao?.servidorAtivo()) { clientesCarregados = true; gestao?.carregarClientes(); registroErros?.recarregar(); carregarIas(); }
  },
});

registroErros = criarRegistroErros({
  ordens: todasOrdens, nomeDe, nomeCliente, aoVerOrdem: (id) => verOrdem(id),
  servidorAtivo: () => integracao.servidorAtivo(), aoMudar: () => atualizarHoje(),
});
document.getElementById('abrir-erros').addEventListener('click', () => registroErros.abrir());
const monitorIas = criarMonitorIas({ servidorAtivo: () => integracao.servidorAtivo(), nomeDe, aoTerminar: () => carregarIas() });
document.getElementById('abrir-monitor-ias').addEventListener('click', () => monitorIas.abrir());

janelaDoc = criarJanelaDocumentacao({ servidorAtivo: () => integracao.servidorAtivo(), nomeDe });
criarJanelaEntregas({ servidorAtivo: () => integracao.servidorAtivo(), nomeDe, pedirAjuste: (...a) => integracao.pedirAjuste(...a) });
gestao = criarGestao({ servidorAtivo: () => integracao.servidorAtivo(), nomeDe, agentesVisiveis: () => [...estacoes.keys()], aoMudarClientes: atualizarClientes });

configuracao = criarConfiguracao({
  agentesVisiveis: () => [...estacoes.keys()],
  aoRemover: (id) => integracao.removerLocal(id),
  nomeDe,
  servidorAtivo: () => integracao.servidorAtivo(),
});

// ---------- loop ----------

// abre já enquadrado, com uma aproximação curta (antes ela partia de dentro da sala)
camera.position.copy(animacaoCamera.posicao).add(new THREE.Vector3(3, 3, 3));
controles.target.copy(animacaoCamera.alvo);
animacaoCamera.de = { alvo: controles.target.clone(), pos: camera.position.clone() };

// Em telas largas, o centro da imagem fica no meio do espaço livre entre a barra de ícones e o painel.
const painelLateral = document.getElementById('painel');
let deslocamentoAtual = null;
function ajustarEnquadramento(forcar = true) {
  const largo = innerWidth > 760 && !painelLateral.hidden;
  const desloc = largo ? Math.round((painelLateral.offsetWidth + 32 - 80) / 2) : 0;
  if (!forcar && desloc === deslocamentoAtual) return;
  deslocamentoAtual = desloc;
  camera.aspect = innerWidth / innerHeight;
  if (desloc) camera.setViewOffset(innerWidth, innerHeight, desloc, 0, innerWidth, innerHeight);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
ajustarEnquadramento();
setInterval(() => ajustarEnquadramento(false), 400); // o painel pode mudar de largura (arrastando a borda)

// Etiquetas sem se sobrepor: quem fica por trás sobe um pouco. E de longe só aparecem
// os nomes e as falas; o balão com a tarefa aparece quando a câmera chega perto.
const posEtiqueta = new THREE.Vector3();
function arrumarEtiquetas() {
  const itens = [];
  for (const e of estacoes.values()) {
    const el = e.etiqueta.element;
    e.etiqueta.getWorldPosition(posEtiqueta);
    el.classList.toggle('longe', camera.position.distanceTo(posEtiqueta) > 13);
    const placa = el.querySelector('.placa');
    const r = placa.getBoundingClientRect();
    if (!r.width) continue;
    const desvio = Number(el.dataset.desvio || 0);
    itens.push({ el, x1: r.left, x2: r.right, y1: r.top - desvio, y2: r.bottom - desvio, dist: camera.position.distanceTo(posEtiqueta) });
  }
  itens.sort((a, b) => a.dist - b.dist); // os mais perto ficam no lugar
  const colocados = [];
  for (const it of itens) {
    let y1 = it.y1, y2 = it.y2;
    for (let volta = 0; volta < 6; volta++) {
      const bate = colocados.find((c) => it.x1 < c.x2 + 4 && it.x2 > c.x1 - 4 && y1 < c.y2 + 2 && y2 > c.y1 - 2);
      if (!bate) break;
      const sobe = y2 - (bate.y1 - 3);
      y1 -= sobe; y2 -= sobe;
    }
    const desvio = Math.round(y1 - it.y1);
    if (Number(it.el.dataset.desvio || 0) !== desvio) {
      it.el.dataset.desvio = desvio;
      it.el.style.setProperty('--desvio', `${desvio}px`);
    }
    colocados.push({ x1: it.x1, x2: it.x2, y1, y2 });
  }
}
let acumEtiquetas = 0;

const relogio = new THREE.Clock();
let acumTela = 0;
function quadro() {
  const dt = Math.min(relogio.getDelta(), 0.05);
  if (cenaPausada) { requestAnimationFrame(quadro); return; }
  const t = relogio.elapsedTime;

  if (animacaoCamera) {
    const a = animacaoCamera;
    a.t = Math.min(1, a.t + dt / 1.2);
    const k = a.t * a.t * (3 - 2 * a.t);
    controles.target.lerpVectors(a.de.alvo, a.alvo, k);
    camera.position.lerpVectors(a.de.pos, a.posicao, k);
    if (a.t >= 1) animacaoCamera = null;
  }

  acumTela += dt;
  const redesenhar = acumTela > 0.12;
  if (redesenhar) acumTela = 0;

  chefe.atualizar(dt, t);
  efeitos.atualizar(dt, t, camera, (id) => estacoes.get(id)?.estado);
  vida.atualizar(dt, t, cenaPausada);
  animarAmbiente(dt, t);
  if (cranio.grupo.visible) cranio.atualizar(dt, t);
  if (redesenhar) desenharTela(chefe.estacao.tela, chefe.agente, chefe.digitando ? 'trabalhando' : 'ocioso', t);

  for (const e of estacoes.values()) {
    const { escrevendoNoQuadro } = e.boneco.atualizar(dt, t, e.estado);
    if (redesenhar) desenharTela(e.estacao.tela, e.agente, e.estado, t);
    if (e.estacao.extras.quadro) desenharQuadro(e.estacao.extras.quadro, escrevendoNoQuadro, dt);
    // luz de status pulsa enquanto trabalha
    e.estacao.luz.intensity = e.estado === 'trabalhando' ? 0.5 + Math.sin(t * 4) * 0.25 : e.estado === 'erro' ? (Math.sin(t * 10) > 0 ? 1 : 0.1) : 0.4;
  }

  controles.update();
  renderer.render(cena, camera);
  rotulos.render(cena, camera);
  acumEtiquetas += dt;
  if (acumEtiquetas > 0.15) { acumEtiquetas = 0; arrumarEtiquetas(); }
  requestAnimationFrame(quadro);
}
quadro();
setInterval(atualizarHorario, 30000);


addEventListener('resize', () => {
  ajustarEnquadramento();
  renderer.setSize(innerWidth, innerHeight);
  rotulos.setSize(innerWidth, innerHeight);
});
