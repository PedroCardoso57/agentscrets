import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { AGENTES, STATUS } from './agentes.js';
import { criarSala, criarEstacao, posicaoEstacao, desenharTela, desenharQuadro } from './escritorio.js';
import { Boneco } from './boneco.js';
import { criarIntegracao } from './integracao.js';

// ---------- renderização ----------

const container = document.getElementById('cena');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

cena.add(new THREE.HemisphereLight('#fff6e8', '#5a6070', 1.1));
const sol = new THREE.DirectionalLight('#fff1d6', 1.6);
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
sol.shadow.bias = -0.0005;
cena.add(sol, sol.target);

// ---------- montagem do escritório ----------

const agentes = AGENTES.map((a) => ({ ...a }));
const estacoes = new Map(); // id → { agente, boneco, estacao, estado, tarefa, etiqueta, item }
let sala = null;

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

  agentes.forEach((agente, i) => {
    const { x, z, rot } = posicaoEstacao(i);
    const grupo = new THREE.Group();
    grupo.position.set(x, 0, z);
    grupo.rotation.y = rot;
    const estacao = criarEstacao(agente);
    const boneco = new Boneco(agente);
    grupo.add(estacao.grupo, boneco.raiz);
    cena.add(grupo);

    const el = document.createElement('div');
    el.className = 'etiqueta';
    el.innerHTML = `<div class="balao"></div><div class="placa"><i></i>${agente.nome}</div>`;
    const etiqueta = new CSS2DObject(el);
    etiqueta.position.set(0, 2.05, 0);
    boneco.raiz.add(etiqueta);

    const anterior = anteriores.get(agente.id) || { estado: 'ocioso', tarefa: '' };
    estacoes.set(agente.id, { agente, grupo, estacao, boneco, etiqueta, ...anterior });
  });

  montarPainel();
  for (const id of estacoes.keys()) mostrarStatus(id);
}

// ---------- painel lateral ----------

const lista = document.getElementById('lista-agentes');
function montarPainel() {
  lista.innerHTML = '';
  for (const [id, e] of estacoes) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="bolinha"></span><span class="nome">${e.agente.nome} <small>· ${e.agente.funcao || ''}</small></span><span class="tarefa"></span>`;
    li.onclick = () => focar(id);
    lista.appendChild(li);
    e.item = li;
  }
}

function mostrarStatus(id) {
  const e = estacoes.get(id);
  const { cor, rotulo } = STATUS[e.estado];
  const balao = e.etiqueta.element.querySelector('.balao');
  balao.textContent = e.tarefa || '';
  balao.classList.toggle('visivel', Boolean(e.tarefa) && e.estado !== 'ocioso');
  balao.classList.toggle('erro', e.estado === 'erro');
  e.etiqueta.element.querySelector('.placa i').style.background = cor;
  e.item.querySelector('.bolinha').style.background = cor;
  e.item.querySelector('.tarefa').textContent = e.tarefa ? `${rotulo} — ${e.tarefa}` : rotulo;
  e.estacao.lampada.material.color.set(cor);
  e.estacao.lampada.material.emissive.set(cor);
  e.estacao.luz.color.set(cor);
}

// ---------- câmera ----------

let animacaoCamera = null;
function enquadrarTudo() {
  const { centro, largura, profundidade } = sala;
  irPara(new THREE.Vector3(centro.x - 1, 0.8, centro.z), new THREE.Vector3(centro.x + largura * 0.35, Math.max(largura, profundidade) * 0.62, centro.z + profundidade * 0.85));
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

// ---------- integração ----------

montar();
enquadrarTudo();

const conexao = document.getElementById('conexao');
criarIntegracao({
  ids: () => [...estacoes.keys()],
  aoAtualizar(id, dados) {
    const e = estacoes.get(id);
    if (!e) return false;
    if (dados.status) e.estado = dados.status;
    if ('tarefa' in dados) e.tarefa = dados.tarefa || '';
    mostrarStatus(id);
    return true;
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
    if (dados.status && STATUS[dados.status]) e.estado = dados.status;
    e.tarefa = dados.tarefa || '';
    mostrarStatus(dados.id);
  },
  aoConexao(texto, online) {
    conexao.textContent = `● ${texto}`;
    conexao.classList.toggle('online', online);
  },
});

// ---------- loop ----------

camera.position.copy(animacaoCamera.posicao).add(new THREE.Vector3(6, 6, 6));
controles.target.copy(animacaoCamera.alvo);

const relogio = new THREE.Clock();
let acumTela = 0;
function quadro() {
  const dt = Math.min(relogio.getDelta(), 0.05);
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
