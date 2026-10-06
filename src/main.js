import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { AGENTES, CHEFE, STATUS } from './agentes.js';
import { MESA, criarSala, criarEstacao, posicaoEstacao, desenharTela, desenharQuadro, definirMarcaSala, definirClientesMural, atualizarRelogio, fatorDia, aplicarDiaNoite } from './escritorio.js';
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

// ---------- renderização ----------

const container = document.getElementById('cena');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // cores mais suaves nas luzes fortes
renderer.toneMappingExposure = 1.05;
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
sol.shadow.bias = -0.0005;
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

  montarPainel();
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
    li.innerHTML = '<span class="bolinha"></span><span class="nome"><span></span> <small></small></span><span class="tarefa"></span>';
    li.querySelector('.nome span').textContent = e.agente.nome;
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

function atualizarSubtitulo(e) {
  const partes = [e.agente.funcao, e.agente.motor].filter(Boolean);
  e.item.querySelector('.nome small').textContent = partes.length ? `· ${partes.join(' · ')}` : '';
}

// Seleciona o agente para a próxima ordem e foca a câmera nele.
function selecionar(id) {
  destinatario.value = id;
  focar(id);
  textoOrdem.focus({ preventScroll: true });
}

function mostrarStatus(id) {
  const e = estacoes.get(id);
  const { cor, rotulo } = STATUS[e.estado];
  const balao = e.etiqueta.element.querySelector('.balao');
  const respondendo = e.resposta && performance.now() < e.respostaAte;
  balao.textContent = respondendo ? `💬 ${e.resposta}` : e.tarefa || '';
  balao.classList.toggle('visivel', respondendo || (Boolean(e.tarefa) && e.estado !== 'ocioso'));
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
  ui.atualizarKpis({ ordens, trabalhando: [...estacoes.values()].filter((x) => x.estado === 'trabalhando').length });
  ui.contador('ordens', ordens.filter((o) => o.estado !== 'respondida').length);
}

// ---------- câmera ----------

let animacaoCamera = null;
function enquadrarTudo() {
  const { centro, largura, profundidade } = sala;
  irPara(new THREE.Vector3(centro.x - 1, 0.8, centro.z), new THREE.Vector3(centro.x + largura * 0.35, Math.max(largura, profundidade) * 0.62, centro.z + profundidade * 0.85));
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

const ROTULO_ORDEM = { pendente: 'aguardando motor', entregue: 'entregue ao motor', respondida: 'respondida', falhou: 'com erro' };

const expandidas = new Set(); // respostas abertas com "ver mais"
const todasOrdens = () => [...ordensVistas.values()].map((v) => v.ordem);
const corDe = (id) => estacoes.get(id)?.agente.cor || 'var(--marca)';
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

function renderizarOrdens() {
  const todas = [...ordensVistas.values()].map((v) => v.ordem).reverse().slice(0, 20);
  if (!todas.length) return;
  listaOrdens.innerHTML = '';
  for (const o of todas) {
    const li = document.createElement('li');
    li.dataset.ordem = o.id;
    li.style.setProperty('--cor', corDe(o.para));
    li.innerHTML = '<div class="cab"><b></b><span class="hora"></span><span class="chip"></span></div><div class="texto"></div>';
    li.querySelector('.hora').textContent = horaCurta(o.criadaEm);
    // ordens delegadas por um agente (ex.: Orquestrador) mostram quem mandou
    li.querySelector('.cab b').textContent = o.de && o.de !== 'chefe' ? `${nomeDe(o.de)} → ${nomeDe(o.para)}` : `Você → ${nomeDe(o.para)}`;
    const chip = li.querySelector('.chip');
    const simulada = o.local || o.respostas.some((r) => r.simulada);
    chip.textContent = simulada && o.estado !== 'respondida' ? 'simulação' : ROTULO_ORDEM[o.estado] || o.estado;
    chip.classList.add(o.estado);
    li.querySelector('.texto').textContent = o.texto;
    // de onde veio a ordem: cliente, ajuste de uma entrega, rotina agendada, Telegram
    const marcas = [
      o.cliente ? `👤 ${nomeCliente(o.cliente)}${o.clienteReconhecido ? ' (reconhecido no pedido)' : ''}` : null,
      o.ajuste ? '↩ ajuste' : null,
      o.consolidacao ? '🏁 entrega final' : null,
      o.texto.startsWith('Replanejar:') ? '🔀 replanejamento' : null,
      o.origem?.rotina ? '🗓 rotina' : null,
      o.origem?.telegram ? '✈ Telegram' : null,
    ].filter(Boolean);
    if (marcas.length) li.querySelector('.cab').after(Object.assign(document.createElement('div'), { className: 'marcas', textContent: marcas.join(' · ') }));
    // plano do Orquestrador: quantas tarefas já estão prontas
    const filhos = todasOrdens().filter((f) => f.pai === o.id);
    if (filhos.length) {
      const prontas = filhos.filter((f) => f.desistida || f.estado === 'respondida').length;
      const plano = document.createElement('div');
      plano.className = 'plano';
      plano.textContent = prontas === filhos.length ? `📋 plano: ${filhos.length}/${filhos.length} prontas${o.consolidada ? ' · entrega final pedida' : ''}` : `📋 plano: ${prontas}/${filhos.length} prontas · o Orquestrador está acompanhando`;
      li.appendChild(plano);
    }
    // supervisor: tentativas, próxima vez e "tentar agora"
    for (const [agente, t] of Object.entries(o.tentativas || {})) {
      if (o.estado !== 'falhou' && !o.desistida) continue;
      const linha = document.createElement('div');
      linha.className = 'supervisor';
      const quando = t.proxima ? new Date(t.proxima).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
      linha.textContent = o.desistida
        ? `🔀 ${nomeDe(agente)} não conseguiu: ${o.motivoDesistencia || 'erro'}`
        : `🔁 ${nomeDe(agente)}: ${t.n ? `${t.n}ª tentativa falhou` : 'falhou'}${quando ? ` · tenta de novo às ${quando}` : ''}${t.ultimoErro ? ` · ${t.ultimoErro.slice(0, 90)}` : ''}`;
      if (!o.local) {
        const botao = Object.assign(document.createElement('button'), { type: 'button', textContent: '↻ Tentar agora' });
        botao.onclick = async () => {
          botao.disabled = true;
          try { await integracao.tentarDeNovo(o.id, agente); } catch (erro) { avisar(`Não consegui tentar de novo: ${erro.message}`, true); botao.disabled = false; }
        };
        linha.appendChild(botao);
      }
      li.appendChild(linha);
    }
    if (o.decisao) {
      // quem decidiu o agente (o Laya), com que certeza e a urgência
      const d = document.createElement('div');
      d.className = 'decisao';
      d.textContent = textoDecisao(o.decisao);
      if (o.decisao.ranking) d.title = `Como o Crânio pesou: ${o.decisao.ranking.map((x) => `${nomeDe(x.id)} ${Math.round(x.p * 100)}%`).join(' · ')}`;
      d.classList.toggle('alerta', ['alertou', 'redirecionou', 'indisponivel'].includes(o.decisao.modo));
      li.appendChild(d);
    }
    o.respostas.forEach((r, indice) => {
      const resp = document.createElement('div');
      resp.className = 'resp';
      resp.innerHTML = '<b></b><div class="corpo-resp"></div>';
      resp.querySelector('b').textContent = nomeDe(r.agente);
      const corpoResp = resp.querySelector('.corpo-resp');
      corpoResp.textContent = r.texto + (r.simulada ? ' (simulação)' : '');
      // respostas longas ficam recolhidas, com "ver mais"
      const chaveResp = `${o.id}:${indice}`;
      if (r.texto.length > 280) {
        const aberta = expandidas.has(chaveResp);
        corpoResp.classList.toggle('recolhida', !aberta);
        const verMais = Object.assign(document.createElement('button'), { type: 'button', className: 'ver-mais', textContent: aberta ? 'ver menos' : 'ver mais' });
        verMais.onclick = () => { if (expandidas.has(chaveResp)) expandidas.delete(chaveResp); else expandidas.add(chaveResp); renderizarOrdens(); };
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
      if (!r.simulada && !o.local) resp.appendChild(barraAvaliacao(o, r, indice));
      li.appendChild(resp);
    });
    listaOrdens.appendChild(li);
  }
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
      icone: erro ? '⚠️' : r.revisao && !r.revisao.erro ? '✅' : '📦',
      titulo: erro ? `${nomeDe(r.agente)} teve um erro` : `${nomeDe(r.agente)} entregou${ordem.cliente ? ` · ${nomeCliente(ordem.cliente)}` : ''}`,
      texto: r.texto.split('\n').find((l) => l.trim()) || '',
      cor: corDe(r.agente),
      acoes: [
        { rotulo: 'Ver', principal: true, fn: () => ui.destacarOrdem(ordem.id) },
        ...(erro ? [] : [{ rotulo: '↩ Ajustar', fn: () => pedirAjusteDe(ordem, indice, r.agente) }]),
      ],
    });
  });
  if (nova && vista === undefined && (ordem.origem?.rotina || ordem.origem?.telegram) && (!ordem.de || ordem.de === 'chefe')) {
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
  aoAviso: ({ texto }) => ui.avisar({ icone: '⚠️', titulo: 'Supervisor', texto, cor: 'var(--erro)', duracao: 15000 }),
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
      cabelo: dados.cabelo, pele: dados.pele,
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
    if (online && gestao && !clientesCarregados && integracao?.servidorAtivo()) { clientesCarregados = true; gestao?.carregarClientes(); }
  },
});

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
  requestAnimationFrame(quadro);
}
quadro();
setInterval(atualizarHorario, 30000);

// Em telas largas, desloca o centro da imagem para a esquerda do painel lateral.
function ajustarEnquadramento() {
  camera.aspect = innerWidth / innerHeight;
  if (innerWidth > 640) camera.setViewOffset(innerWidth, innerHeight, 150, 0, innerWidth, innerHeight);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
ajustarEnquadramento();

addEventListener('resize', () => {
  ajustarEnquadramento();
  renderer.setSize(innerWidth, innerHeight);
  rotulos.setSize(innerWidth, innerHeight);
});
