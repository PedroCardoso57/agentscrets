import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { AGENTES, CHEFE, STATUS } from './agentes.js';
import { criarSala, criarEstacao, posicaoEstacao, desenharTela, desenharQuadro } from './escritorio.js';
import { Boneco } from './boneco.js';
import { Chefe } from './chefe.js';
import { Cranio } from './cranio.js';
import { criarIntegracao } from './integracao.js';
import { criarConfiguracao } from './configuracao.js';
import { criarJanelaDocumentacao } from './documentacao.js';

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

    const etiqueta = criarEtiqueta(agente.nome);
    boneco.raiz.add(etiqueta);

    const anterior = anteriores.get(agente.id) || { estado: 'ocioso', tarefa: '' };
    estacoes.set(agente.id, { agente, grupo, estacao, boneco, etiqueta, ...anterior });
  });

  montarPainel();
  for (const id of estacoes.keys()) mostrarStatus(id);
}

// ---------- painel lateral ----------

const lista = document.getElementById('lista-agentes');
const destinatario = document.getElementById('destinatario');
function montarPainel() {
  lista.innerHTML = '';
  const selecionado = destinatario.value;
  destinatario.innerHTML = '<option value="todos">Para: todos</option>';
  if (decisorAtivo) destinatario.prepend(new Option('🔮 Crânio decide (Laya)', 'auto'));
  for (const [id, e] of estacoes) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="bolinha"></span><span class="nome"><span></span> <small></small></span><span class="tarefa"></span>';
    li.querySelector('.nome span').textContent = e.agente.nome;
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
    await integracao.enviarOrdem(para, texto);
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

const ROTULO_ORDEM = { pendente: 'aguardando motor', entregue: 'entregue ao motor', respondida: 'respondida' };

function renderizarOrdens() {
  const todas = [...ordensVistas.values()].map((v) => v.ordem).reverse().slice(0, 20);
  if (!todas.length) return;
  listaOrdens.innerHTML = '';
  for (const o of todas) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="cab"><b></b><span class="chip"></span></div><div class="texto"></div>';
    // ordens delegadas por um agente (ex.: Orquestrador) mostram quem mandou
    li.querySelector('.cab b').textContent = o.de && o.de !== 'chefe' ? `${nomeDe(o.de)} → ${nomeDe(o.para)}` : `Você → ${nomeDe(o.para)}`;
    const chip = li.querySelector('.chip');
    const simulada = o.local || o.respostas.some((r) => r.simulada);
    chip.textContent = simulada && o.estado !== 'respondida' ? 'simulação' : ROTULO_ORDEM[o.estado] || o.estado;
    chip.classList.add(o.estado);
    li.querySelector('.texto').textContent = o.texto;
    if (o.decisao) {
      // quem decidiu o agente (o Laya), com que certeza e a urgência
      const d = document.createElement('div');
      d.className = 'decisao';
      d.textContent = textoDecisao(o.decisao);
      d.classList.toggle('alerta', ['alertou', 'redirecionou', 'indisponivel'].includes(o.decisao.modo));
      li.appendChild(d);
    }
    o.respostas.forEach((r, indice) => {
      const resp = document.createElement('div');
      resp.className = 'resp';
      resp.innerHTML = '<b></b><div class="corpo-resp"></div>';
      resp.querySelector('b').textContent = nomeDe(r.agente);
      resp.querySelector('.corpo-resp').textContent = r.texto + (r.simulada ? ' (simulação)' : '');
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

  // respostas novas aparecem no balão do agente por alguns segundos
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
  },
});

janelaDoc = criarJanelaDocumentacao({ servidorAtivo: () => integracao.servidorAtivo(), nomeDe });

configuracao = criarConfiguracao({
  agentesVisiveis: () => [...estacoes.keys()],
  nomeDe,
  servidorAtivo: () => integracao.servidorAtivo(),
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

  chefe.atualizar(dt, t);
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
