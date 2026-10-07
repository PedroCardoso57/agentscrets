import * as THREE from 'three';

// ---------- utilitários ----------

const matCache = new Map();
export function mat(cor, opts = {}) {
  const chave = cor + JSON.stringify(opts);
  if (!matCache.has(chave)) matCache.set(chave, new THREE.MeshStandardMaterial({ color: cor, roughness: 0.75, ...opts }));
  return matCache.get(chave);
}

export function caixa(l, a, p, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(l, a, p), material);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function cilindro(rt, rb, a, material, x = 0, y = 0, z = 0, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, a, seg), material);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

// ---------- layout ----------

export const COLUNAS = 4;
const ESPACO_X = 2.7;
const ESPACO_POD = 7.5;
const DIST_FILEIRA = 1.45; // distância da cadeira ao centro do "pod" de mesas

// Posição/rotação da estação de cada agente. Mesas ficam em pares frente a frente.
export function posicaoEstacao(indice) {
  const porPod = COLUNAS * 2;
  const pod = Math.floor(indice / porPod);
  const resto = indice % porPod;
  const fileira = Math.floor(resto / COLUNAS);
  const coluna = resto % COLUNAS;
  const x = (coluna - (COLUNAS - 1) / 2) * ESPACO_X;
  const zPod = pod * ESPACO_POD;
  return fileira === 0
    ? { x, z: zPod - DIST_FILEIRA, rot: 0 }        // olha para +z
    : { x, z: zPod + DIST_FILEIRA, rot: Math.PI }; // olha para -z
}

// Mesa do chefe: de frente para a equipe, na parte da frente da sala.
export function posicaoChefe(totalAgentes) {
  const pods = Math.max(1, Math.ceil(totalAgentes / (COLUNAS * 2)));
  return { x: 0, z: (pods - 1) * ESPACO_POD + 4.7, rot: Math.PI };
}

// Corredores por onde o chefe anda sem atravessar as mesas.
export const CORREDOR_X = (COLUNAS * ESPACO_X) / 2 + 0.95;

// ---------- ambiente: marca, mural, relógio e dia/noite ----------
// A sala é recriada quando a equipe muda; o que precisa sobreviver fica aqui.

const AMBIENTE = {
  marca: { nome: 'agentscrets', cor: '#e11d2a' },
  clientes: [],
  logo: null, mural: null, relogio: null,
  vidros: [], pendentes: [], leds: [],
};
const FONTE = 'Montserrat, system-ui, sans-serif';

// placa da marca: bloco na cor da marca com o nome em branco
function pintarLogo() {
  const { logo, marca } = AMBIENTE;
  if (!logo) return;
  const c = logo.userData.canvas;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = marca.cor;
  ctx.beginPath(); ctx.roundRect(8, 8, c.width - 16, c.height - 16, 26); ctx.fill();
  ctx.fillStyle = '#fff';
  let px = 92;
  ctx.font = `800 ${px}px ${FONTE}`;
  while (ctx.measureText(marca.nome).width > c.width - 80 && px > 30) { px -= 4; ctx.font = `800 ${px}px ${FONTE}`; }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(marca.nome, c.width / 2, c.height / 2 + 4);
  logo.material.map.needsUpdate = true;
}

export function definirMarcaSala(nome, cor) {
  AMBIENTE.marca = { nome: nome || AMBIENTE.marca.nome, cor: cor || AMBIENTE.marca.cor };
  pintarLogo();
  // a fonte da marca pode chegar depois: repinta quando carregar
  document.fonts?.load(`800 64px ${FONTE}`).then(pintarLogo, () => {});
}

// mural de cortiça com os clientes em post-its
function pintarMural() {
  const { mural, clientes } = AMBIENTE;
  if (!mural) return;
  const c = mural.userData.canvas;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3b2a1f'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#b98a5a'; ctx.fillRect(14, 14, c.width - 28, c.height - 28);
  for (let i = 0; i < 400; i++) { // textura de cortiça
    ctx.fillStyle = `rgba(80, 50, 25, ${Math.random() * 0.25})`;
    ctx.fillRect(14 + Math.random() * (c.width - 28), 14 + Math.random() * (c.height - 28), 3, 3);
  }
  ctx.fillStyle = AMBIENTE.marca.cor;
  ctx.font = `800 30px ${FONTE}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('CLIENTES', 34, 26);
  const notas = clientes.length ? clientes.slice(0, 8) : ['Cadastre seus', 'clientes no', 'menu Clientes'];
  const cores = ['#fde68a', '#fbcfe8', '#bfdbfe', '#bbf7d0'];
  notas.forEach((nome, i) => {
    const col = i % 4; const lin = Math.floor(i / 4);
    const x = 34 + col * 118; const y = 76 + lin * 100;
    ctx.save();
    ctx.translate(x + 52, y + 42); ctx.rotate(((i * 37) % 9 - 4) * 0.015);
    ctx.fillStyle = '#0003'; ctx.fillRect(-48, -36, 104, 84);
    ctx.fillStyle = cores[i % cores.length]; ctx.fillRect(-52, -40, 104, 84);
    ctx.fillStyle = '#e11d2a'; ctx.beginPath(); ctx.arc(0, -32, 5, 0, Math.PI * 2); ctx.fill(); // tachinha
    ctx.fillStyle = '#1f2937'; ctx.font = `700 15px ${FONTE}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // quebra o nome em até 3 linhas
    const palavras = String(nome).split(' '); const linhas = [''];
    for (const p of palavras) { const t = linhas.at(-1) ? `${linhas.at(-1)} ${p}` : p; if (ctx.measureText(t).width > 92 && linhas.at(-1)) linhas.push(p); else linhas[linhas.length - 1] = t; }
    linhas.slice(0, 3).forEach((l, k) => ctx.fillText(l, 0, -4 + (k - (Math.min(linhas.length, 3) - 1) / 2) * 18));
    ctx.restore();
  });
  mural.material.map.needsUpdate = true;
}

// TV da área de reunião: os números do dia, no estilo do painel
let dadosTV = { entregas: 0, trabalhando: 0, erros: 0, proxima: '—', projetos: 0 };
function pintarTV() {
  const tv = AMBIENTE.tv;
  if (!tv) return;
  const c = tv.userData.canvas;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0c0f'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = AMBIENTE.marca.cor; ctx.fillRect(0, 0, c.width, 8);
  ctx.fillStyle = '#f4f4f5'; ctx.font = `800 26px ${FONTE}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('HOJE', 24, 24);
  ctx.fillStyle = '#a1a1aa'; ctx.font = `600 16px ${FONTE}`;
  ctx.fillText(new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', timeZone: 'America/Sao_Paulo' }), 100, 32);
  const kpis = [['entregas', dadosTV.entregas, '#3fb27f'], ['trabalhando', dadosTV.trabalhando, '#4c8dff'], ['erros', dadosTV.erros, dadosTV.erros ? '#ff4d57' : '#a1a1aa'], ['projetos', dadosTV.projetos, '#e0b23c']];
  kpis.forEach(([rotulo, valor, cor], i) => {
    const x = 24 + i * 122;
    ctx.fillStyle = '#18181b'; ctx.fillRect(x, 78, 110, 110);
    ctx.fillStyle = cor; ctx.font = `800 52px ${FONTE}`; ctx.textAlign = 'center';
    ctx.fillText(String(valor), x + 55, 92);
    ctx.fillStyle = '#a1a1aa'; ctx.font = `600 14px ${FONTE}`;
    ctx.fillText(rotulo, x + 55, 158);
  });
  ctx.textAlign = 'left'; ctx.fillStyle = '#a1a1aa'; ctx.font = `600 15px ${FONTE}`;
  ctx.fillText('Próxima rotina', 24, 214);
  ctx.fillStyle = '#f4f4f5'; ctx.font = `700 20px ${FONTE}`;
  ctx.fillText(String(dadosTV.proxima).slice(0, 40), 24, 238);
  tv.material.map.needsUpdate = true;
}

export function definirPainelTV(dados) {
  const novo = { ...dadosTV, ...dados };
  if (JSON.stringify(novo) === JSON.stringify(dadosTV)) return;
  dadosTV = novo;
  pintarTV();
}

// vapor subindo da cafeteira e LEDs do servidor do DevOps
export function animarAmbiente(dt, t) {
  for (const led of AMBIENTE.leds) {
    if (!led.parent) continue;
    const ligado = Math.sin(t * led.userData.vel + led.userData.fase) > led.userData.limiar;
    led.material.emissiveIntensity = ligado ? 2.2 : 0.15;
  }
  const v = AMBIENTE.vapor;
  if (!v) return;
  for (const bolha of v.children) {
    const f = (t * 0.35 + bolha.userData.fase) % 1;
    bolha.position.set(Math.sin((f + bolha.userData.fase) * 9) * 0.03, f * 0.4, 0);
    bolha.scale.setScalar(0.6 + f * 1.6);
    bolha.material.opacity = 0.3 * (1 - f);
  }
}

export function definirClientesMural(nomes) {
  AMBIENTE.clientes = nomes;
  pintarMural();
}

// relógio de parede no horário de Brasília
let ultimoMinuto = -1;
export function atualizarRelogio(data = new Date()) {
  const { relogio } = AMBIENTE;
  if (!relogio) return;
  const [h, m] = data.toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  if (m === ultimoMinuto) return;
  ultimoMinuto = m;
  const c = relogio.userData.canvas;
  const ctx = c.getContext('2d');
  const r = c.width / 2;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(r, r, r - 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f5f5f4'; ctx.beginPath(); ctx.arc(r, r, r - 14, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#111';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.lineWidth = i % 3 ? 3 : 7;
    ctx.beginPath(); ctx.moveTo(r + Math.sin(a) * (r - 26), r - Math.cos(a) * (r - 26)); ctx.lineTo(r + Math.sin(a) * (r - 40), r - Math.cos(a) * (r - 40)); ctx.stroke();
  }
  const ponteiro = (ang, comp, larg, cor) => {
    ctx.strokeStyle = cor; ctx.lineWidth = larg; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(r, r); ctx.lineTo(r + Math.sin(ang) * comp, r - Math.cos(ang) * comp); ctx.stroke();
  };
  ponteiro(((h % 12) + m / 60) / 12 * Math.PI * 2, r * 0.45, 9, '#111');
  ponteiro(m / 60 * Math.PI * 2, r * 0.68, 6, '#111');
  ctx.fillStyle = AMBIENTE.marca.cor; ctx.beginPath(); ctx.arc(r, r, 9, 0, Math.PI * 2); ctx.fill();
  relogio.material.map.needsUpdate = true;
}

// Quanto é dia agora (0 = noite, 1 = dia), pelo horário de Brasília. ?hora=22 na URL força um horário.
export function fatorDia(data = new Date()) {
  const forcada = Number(new URLSearchParams(location.search).get('hora'));
  const [h, m] = data.toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  const hora = Number.isFinite(forcada) && new URLSearchParams(location.search).has('hora') ? forcada : h + m / 60;
  const suave = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return suave(5.5, 7.5, hora) * (1 - suave(17.5, 19.5, hora));
}

const COR_DIA = new THREE.Color('#ffffff');
const COR_NOITE = new THREE.Color('#26304d');
// Ajusta luzes, fundo e janelas ao horário. k: 0 = noite, 1 = dia.
export function aplicarDiaNoite(k, { cena, hemi, sol }) {
  if (!AMBIENTE.fundo) {
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = 256;
    AMBIENTE.fundo = new THREE.CanvasTexture(canvas);
    AMBIENTE.fundo.colorSpace = THREE.SRGBColorSpace;
  }
  const cima = new THREE.Color('#141824').lerp(new THREE.Color('#2a2f3d'), k);
  const baixo = new THREE.Color('#050507').lerp(new THREE.Color('#0e0e12'), k);
  pintarFundo(`#${cima.getHexString()}`, `#${baixo.getHexString()}`);
  cena.background = AMBIENTE.fundo;
  cena.fog.color.copy(baixo);
  hemi.intensity = 0.45 + 0.75 * k;
  hemi.color.set('#9fb0ff').lerp(new THREE.Color('#fff6e8'), k);
  sol.intensity = 0.35 + 1.25 * k;
  sol.color.set('#9fb4ff').lerp(new THREE.Color('#fff1d6'), k);
  for (const v of AMBIENTE.vidros) v.color.copy(COR_NOITE).lerp(COR_DIA, k);
  for (const p of AMBIENTE.pendentes) {
    p.luz.intensity = 1.5 + 7.5 * (1 - k);
    p.lampada.material.emissiveIntensity = 0.8 + 2.2 * (1 - k);
  }
}

function canvasPlano(largura, altura, w, h, { transparente = false, basico = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  const material = basico ? new THREE.MeshBasicMaterial({ map: textura, transparent: transparente }) : new THREE.MeshStandardMaterial({ map: textura, roughness: 0.9, transparent: transparente });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(largura, altura), material);
  m.userData.canvas = canvas;
  return m;
}

// luminária pendente: fio, cúpula preta e lâmpada (a luz fica mais forte à noite)
function pendente(x, z, altura = 3.0) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.add(cilindro(0.008, 0.008, 3.6 - altura, mat('#111'), 0, altura + (3.6 - altura) / 2, 0, 6));
  const cupula = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.26, 24, 1, true), mat('#15151a', { side: THREE.DoubleSide, metalness: 0.3, roughness: 0.5 }));
  cupula.position.y = altura - 0.1;
  g.add(cupula);
  const lampada = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), new THREE.MeshStandardMaterial({ color: '#fff3d6', emissive: '#ffd9a0', emissiveIntensity: 1 }));
  lampada.position.y = altura - 0.2;
  g.add(lampada);
  const luz = new THREE.PointLight('#ffd9a0', 1, 9, 1.2);
  luz.position.y = altura - 0.3;
  g.add(luz);
  AMBIENTE.pendentes.push({ luz, lampada });
  return g;
}

// estante com livros coloridos
function estante(x, z) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = Math.PI / 2;
  const madeira = mat('#2a2a30');
  g.add(caixa(1.6, 1.9, 0.04, madeira, 0, 0.95, -0.17));
  for (const sx of [-1, 1]) g.add(caixa(0.04, 1.9, 0.36, madeira, sx * 0.78, 0.95, 0));
  const coresLivro = ['#e11d2a', '#f4f4f5', '#3f3f46', '#fbbf24', '#60a5fa', '#a1a1aa'];
  for (let n = 0; n < 4; n++) {
    const y = 0.05 + n * 0.46;
    g.add(caixa(1.56, 0.03, 0.34, madeira, 0, y, 0));
    let px = -0.7;
    let i = n * 3;
    while (px < 0.6) {
      const larg = 0.05 + ((i * 7) % 4) * 0.012;
      const alt = 0.26 + ((i * 5) % 5) * 0.025;
      g.add(caixa(larg, alt, 0.24, mat(coresLivro[i % coresLivro.length]), px + larg / 2, y + 0.015 + alt / 2, 0));
      px += larg + 0.008;
      i++;
      if (i % 7 === 0) px += 0.12; // espaço vazio
    }
  }
  return g;
}

// ---------- sala ----------

export function criarSala(totalAgentes) {
  AMBIENTE.vidros = [];
  AMBIENTE.pendentes = [];
  AMBIENTE.leds = AMBIENTE.leds.filter((l) => l.parent); // as estações são refeitas logo depois
  const sala = new THREE.Group();
  const pods = Math.max(1, Math.ceil(totalAgentes / (COLUNAS * 2)));
  const largura = COLUNAS * ESPACO_X + 9;
  const profundidade = (pods - 1) * ESPACO_POD + 12;
  const cx = 1.5; // espaço extra à direita para a copa
  const cz = ((pods - 1) * ESPACO_POD) / 2 + 1; // +1: espaço na frente para a mesa do chefe

  // piso de madeira com tábuas
  const piso = new THREE.Mesh(new THREE.PlaneGeometry(largura, profundidade), new THREE.MeshStandardMaterial({ map: texturaPiso(), roughness: 0.85 }));
  piso.rotation.x = -Math.PI / 2;
  piso.position.set(cx, 0, cz);
  piso.receiveShadow = true;
  piso.material.map.repeat.set(largura / 4, profundidade / 4);
  sala.add(piso);

  // tapete sob as mesas
  for (let p = 0; p < pods; p++) {
    // tapete de lã cinza, sóbrio
    const tapete = new THREE.Mesh(new THREE.PlaneGeometry(COLUNAS * ESPACO_X + 0.8, 5.6), new THREE.MeshStandardMaterial({ map: texturaTapete(), roughness: 1 }));
    tapete.rotation.x = -Math.PI / 2;
    tapete.position.set(0, 0.006, p * ESPACO_POD);
    tapete.receiveShadow = true;
    sala.add(tapete);
    // pendentes sobre as mesas
    sala.add(pendente(-ESPACO_X, p * ESPACO_POD));
    sala.add(pendente(ESPACO_X, p * ESPACO_POD));
  }

  // paredes (só fundo e esquerda, estilo "casa de bonecas")
  // fundo claro (concreto) e parede da marca grafite
  const xEsq = cx - largura / 2;
  const zFundo = cz - profundidade / 2;
  sala.add(caixa(largura, 3.2, 0.2, mat('#dcd8d1'), cx, 1.6, zFundo));
  sala.add(caixa(0.2, 3.2, profundidade, mat('#232328'), xEsq, 1.6, cz));
  sala.add(caixa(largura, 0.12, 0.06, mat('#18181b'), cx, 0.06, zFundo + 0.12)); // rodapé
  sala.add(caixa(0.06, 0.12, profundidade, mat('#18181b'), xEsq + 0.12, 0.06, cz));

  // janelas no fundo
  // o começo da parede fica para o mural de clientes e o relógio
  const inicioJanelas = xEsq + 5.6;
  const nJanelas = Math.floor((largura - 5.6) / 3.2);
  for (let i = 0; i < nJanelas; i++) {
    const x = inicioJanelas + 1.0 + i * (largura - 5.6 - 2.0) / Math.max(1, nJanelas - 1);
    sala.add(janela(x, zFundo + 0.11));
  }

  // placa da marca na parede grafite
  const logo = canvasPlano(3.2, 0.8, 1024, 256, { transparente: true });
  logo.rotation.y = Math.PI / 2;
  logo.position.set(xEsq + 0.115, 2.25, cz);
  sala.add(logo);
  AMBIENTE.logo = logo;
  pintarLogo();

  // mural de clientes e relógio na parede do fundo
  const mural = canvasPlano(2.2, 1.24, 512, 288, { basico: false });
  mural.position.set(xEsq + 2.6, 1.65, zFundo + 0.115);
  sala.add(mural);
  AMBIENTE.mural = mural;
  pintarMural();
  const relogio = canvasPlano(0.62, 0.62, 256, 256, { transparente: true });
  relogio.position.set(xEsq + 4.45, 2.2, zFundo + 0.115);
  sala.add(relogio);
  AMBIENTE.relogio = relogio;
  ultimoMinuto = -1;
  atualizarRelogio();

  // quadros: dois na parede da marca (dos lados da placa) e um no fundo, entre o relógio e as janelas
  const quadros = [[xEsq + 0.13, 1.75, cz - 3.0, Math.PI / 2, 1.0, 1.3, 0], [xEsq + 0.13, 1.75, cz + 3.0, Math.PI / 2, 1.0, 1.3, 1]];
  for (const [x, y, z, rot, l, a, estilo] of quadros) {
    const q = quadroParede(l, a, estilo);
    q.position.set(x, y, z);
    q.rotation.y = rot;
    sala.add(q);
  }
  // prateleira com plantinhas e o quadro </> na parede da marca, perto do sofá
  const prateleira = new THREE.Group();
  prateleira.position.set(xEsq + 0.25, 2.2, zFundo + 2.6);
  prateleira.add(caixa(0.26, 0.04, 1.6, mat('#2a2a30'), 0, 0, 0));
  for (const dz of [-0.55, 0.1, 0.6]) {
    prateleira.add(cilindro(0.07, 0.06, 0.12, mat(dz > 0 ? '#e7e5e4' : '#c4683e'), 0, 0.08, dz, 12));
    const folhas = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), mat('#3d8b4f'));
    folhas.position.set(0, 0.21, dz);
    folhas.scale.set(1, 0.8, 1);
    prateleira.add(folhas);
  }
  sala.add(prateleira);
  const codigoQuadro = quadroParede(0.7, 0.9, 2);
  codigoQuadro.position.set(xEsq + 0.13, 1.4, zFundo + 4.4);
  codigoQuadro.rotation.y = Math.PI / 2;
  sala.add(codigoQuadro);

  // estante na parede da marca e pendente na copa
  sala.add(estante(xEsq + 0.3, cz + profundidade / 2 - 2.2));
  sala.add(pendente(cx + largura / 2 - 2.2, zFundo + 1.6, 3.1));

  const xDir = cx + largura / 2;
  const zFrente = cz + profundidade / 2;
  const V = (x, z) => new THREE.Vector3(x, 0, z);
  // pontos aonde os agentes vão nas pausas (no mundo): pos = onde ficar, rot = para onde olhar
  const pontos = { copa: [], cafe: [], mesaAlta: [], sofa: [], janela: [], reuniao: [], estante: [] };

  // ---- copa: balcão com cafeteira e pia, geladeira, bebedouro e mesa alta com banquetas ----
  const copa = new THREE.Group();
  copa.position.set(xDir - 2.3, 0, zFundo + 0.45);
  const armario = mat('#26262b', { roughness: 0.6 });
  copa.add(caixa(3.0, 0.88, 0.6, armario, 0, 0.44, 0)); // balcão
  copa.add(caixa(3.04, 0.05, 0.64, mat('#e7e5e4', { roughness: 0.35 }), 0, 0.905, 0)); // tampo claro
  for (let i = 0; i < 4; i++) copa.add(caixa(0.02, 0.5, 0.01, mat('#3f3f46'), -1.1 + i * 0.73, 0.5, 0.305)); // portas
  copa.add(caixa(3.0, 0.7, 0.3, armario, 0, 2.0, -0.15)); // armário alto
  // cafeteira (com vapor) e xícaras
  const cafeteira = new THREE.Group();
  cafeteira.position.set(-0.9, 0.93, -0.05);
  cafeteira.add(caixa(0.36, 0.45, 0.32, mat('#111', { metalness: 0.4, roughness: 0.4 }), 0, 0.225, 0));
  cafeteira.add(caixa(0.3, 0.06, 0.05, mat('#e11d2a', { roughness: 0.4 }), 0, 0.36, 0.17));
  cafeteira.add(cilindro(0.04, 0.035, 0.08, mat('#f5f5f4'), 0, 0.05, 0.12));
  copa.add(cafeteira);
  const vapor = new THREE.Group();
  vapor.position.set(-0.9, 1.2, 0.07);
  for (let i = 0; i < 4; i++) {
    const v = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.25, depthWrite: false }));
    v.userData.fase = i / 4;
    vapor.add(v);
  }
  copa.add(vapor);
  AMBIENTE.vapor = vapor;
  for (let i = 0; i < 3; i++) copa.add(cilindro(0.04, 0.035, 0.08, mat(['#f5f5f4', '#e11d2a', '#18181b'][i]), -0.45 + i * 0.12, 0.97, 0.12));
  // pia
  copa.add(caixa(0.55, 0.02, 0.4, mat('#a1a1aa', { metalness: 0.7, roughness: 0.3 }), 0.55, 0.935, 0));
  copa.add(cilindro(0.015, 0.015, 0.25, mat('#d4d4d8', { metalness: 0.8, roughness: 0.2 }), 0.55, 1.05, -0.15, 8));
  sala.add(copa);
  // geladeira
  sala.add(caixa(0.75, 1.85, 0.7, mat('#d4d4d8', { metalness: 0.3, roughness: 0.4 }), xDir - 0.45, 0.925, zFundo + 0.5));
  sala.add(caixa(0.03, 0.5, 0.04, mat('#52525b'), xDir - 0.75, 1.2, zFundo + 0.87));
  // bebedouro com galão
  const bebedouro = new THREE.Group();
  bebedouro.position.set(xDir - 4.3, 0, zFundo + 0.45);
  bebedouro.add(caixa(0.4, 1.0, 0.4, mat('#f4f4f5', { roughness: 0.5 }), 0, 0.5, 0));
  bebedouro.add(caixa(0.12, 0.06, 0.05, mat('#60a5fa'), 0, 0.85, 0.22));
  bebedouro.add(cilindro(0.17, 0.17, 0.42, mat('#7fc8ff', { transparent: true, opacity: 0.55, roughness: 0.1 }), 0, 1.22, 0));
  bebedouro.add(cilindro(0.06, 0.06, 0.05, mat('#7fc8ff', { transparent: true, opacity: 0.55 }), 0, 1.46, 0));
  sala.add(bebedouro);
  pontos.copa.push({ pos: V(xDir - 4.3, zFundo + 1.15), rot: Math.PI }, { pos: V(xDir - 3.6, zFundo + 1.5), rot: -Math.PI * 0.75 });
  pontos.cafe.push({ pos: V(xDir - 3.2, zFundo + 1.1), rot: Math.PI }, { pos: V(xDir - 2.5, zFundo + 1.3), rot: -Math.PI * 0.8 });
  // mesa alta (bistrô) com duas banquetas
  const mesaAlta = new THREE.Group();
  mesaAlta.position.set(xDir - 2.3, 0, zFundo + 2.6);
  mesaAlta.add(cilindro(0.38, 0.38, 0.04, mat('#e7e5e4', { roughness: 0.35 }), 0, 1.05, 0, 28));
  mesaAlta.add(cilindro(0.04, 0.04, 1.03, mat('#18181b', { metalness: 0.5 }), 0, 0.52, 0, 10));
  mesaAlta.add(cilindro(0.25, 0.25, 0.03, mat('#18181b', { metalness: 0.5 }), 0, 0.015, 0, 20));
  for (const sx of [-1, 1]) {
    mesaAlta.add(cilindro(0.17, 0.17, 0.05, mat('#e11d2a', { roughness: 0.6 }), sx * 0.62, 0.72, 0, 18));
    mesaAlta.add(cilindro(0.025, 0.025, 0.7, mat('#18181b', { metalness: 0.5 }), sx * 0.62, 0.35, 0, 8));
  }
  sala.add(mesaAlta);
  pontos.mesaAlta.push({ pos: V(xDir - 2.95, zFundo + 2.6), rot: Math.PI / 2 }, { pos: V(xDir - 1.65, zFundo + 2.6), rot: -Math.PI / 2 });

  // ---- sofá vinho (parede da marca) ----
  const sofa = new THREE.Group();
  sofa.position.set(xEsq + 1.0, 0, zFundo + 2.6);
  sofa.rotation.y = Math.PI / 2;
  const tecido = mat('#7a1c22', { roughness: 0.95 });
  sofa.add(caixa(2.2, 0.4, 0.8, tecido, 0, 0.3, 0));
  sofa.add(caixa(2.2, 0.6, 0.2, tecido, 0, 0.7, -0.3));
  sofa.add(caixa(0.2, 0.55, 0.8, tecido, -1.1, 0.45, 0));
  sofa.add(caixa(0.2, 0.55, 0.8, tecido, 1.1, 0.45, 0));
  for (const sx of [-0.55, 0.55]) sofa.add(caixa(0.95, 0.12, 0.6, mat('#8f2a31', { roughness: 0.95 }), sx, 0.55, 0.05)); // almofadas
  sala.add(sofa);
  pontos.sofa.push({ pos: V(xEsq + 1.05, zFundo + 2.05), rot: Math.PI / 2, sentar: true }, { pos: V(xEsq + 1.05, zFundo + 3.15), rot: Math.PI / 2, sentar: true });

  // ---- área de reunião: mesa redonda, cadeiras e TV com os números do dia ----
  const reuniao = new THREE.Group();
  const centroReuniao = V(xDir - 2.6, zFrente - 2.6);
  reuniao.position.copy(centroReuniao);
  reuniao.add(cilindro(0.75, 0.75, 0.05, mat('#e7e5e4', { roughness: 0.4 }), 0, 0.76, 0, 32));
  reuniao.add(cilindro(0.06, 0.06, 0.74, mat('#18181b', { metalness: 0.5 }), 0, 0.37, 0, 10));
  reuniao.add(cilindro(0.35, 0.35, 0.03, mat('#18181b', { metalness: 0.5 }), 0, 0.015, 0, 20));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const cadeira = new THREE.Group();
    cadeira.position.set(Math.sin(a) * 1.15, 0, Math.cos(a) * 1.15);
    cadeira.rotation.y = a + Math.PI; // de frente para a mesa
    cadeira.add(caixa(0.45, 0.06, 0.45, mat('#27272a'), 0, 0.46, 0));
    cadeira.add(caixa(0.45, 0.5, 0.06, mat('#27272a'), 0, 0.74, -0.22));
    cadeira.add(cilindro(0.03, 0.03, 0.44, mat('#18181b', { metalness: 0.5 }), 0, 0.22, 0, 8));
    reuniao.add(cadeira);
    pontos.reuniao.push({ pos: centroReuniao.clone().add(V(Math.sin(a) * 1.15, Math.cos(a) * 1.15)), rot: a + Math.PI, sentar: true });
  }
  sala.add(reuniao);
  // TV num pedestal, virada para a mesa
  const tv = new THREE.Group();
  tv.position.set(centroReuniao.x, 0, centroReuniao.z - 1.95); // atrás da mesa, virada para a sala
  tv.rotation.y = 0;
  tv.add(cilindro(0.04, 0.04, 1.3, mat('#18181b', { metalness: 0.6 }), 0, 0.65, 0, 8));
  tv.add(caixa(0.6, 0.04, 0.4, mat('#18181b', { metalness: 0.6 }), 0, 0.02, 0));
  tv.add(caixa(1.5, 0.88, 0.06, mat('#0a0a0c'), 0, 1.55, 0));
  const telaTV = canvasPlano(1.42, 0.8, 512, 288);
  telaTV.position.set(0, 1.55, 0.031);
  tv.add(telaTV);
  sala.add(tv);
  AMBIENTE.tv = telaTV;
  pintarTV();

  // janelas (olhar a vista) e estante (folhear um livro)
  for (const x of [-1.5, 1.5]) pontos.janela.push({ pos: V(cx + x, zFundo + 0.9), rot: Math.PI });
  pontos.estante.push({ pos: V(xEsq + 1.2, zFrente - 2.2), rot: -Math.PI / 2 });

  // plantas nos cantos
  sala.add(planta(xEsq + 0.6, zFundo + 0.6, 1.2));
  sala.add(planta(xDir - 0.6, zFundo + 2.0, 1.0));
  sala.add(planta(xDir - 0.6, zFrente - 0.8, 0.9));
  sala.add(planta(CORREDOR_X + 0.7, cz - 0.5, 0.8));
  sala.add(planta(xEsq + 0.6, zFrente - 0.6, 1.0));

  return { grupo: sala, centro: new THREE.Vector3(cx, 0, cz), largura, profundidade, pontos };
}

function janela(x, z) {
  const g = new THREE.Group();
  const vidro = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.5), new THREE.MeshBasicMaterial({ map: texturaCeu() }));
  AMBIENTE.vidros.push(vidro.material); // escurece à noite
  vidro.position.set(x, 1.85, z + 0.005);
  g.add(vidro);
  const moldura = mat('#18181b');
  g.add(caixa(2.1, 0.08, 0.08, moldura, x, 2.62, z + 0.03));
  g.add(caixa(2.1, 0.08, 0.08, moldura, x, 1.08, z + 0.03));
  g.add(caixa(0.08, 1.6, 0.08, moldura, x - 1.03, 1.85, z + 0.03));
  g.add(caixa(0.08, 1.6, 0.08, moldura, x + 1.03, 1.85, z + 0.03));
  g.add(caixa(0.05, 1.5, 0.05, moldura, x, 1.85, z + 0.03));
  return g;
}

function planta(x, z, escala) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(escala);
  g.add(cilindro(0.22, 0.17, 0.4, mat('#c4683e'), 0, 0.2, 0));
  const folha = mat('#3d8b4f');
  for (let i = 0; i < 7; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), folha);
    const a = (i / 7) * Math.PI * 2;
    f.position.set(Math.cos(a) * 0.15, 0.6 + (i % 3) * 0.15, Math.sin(a) * 0.15);
    f.scale.set(1, 1.4, 1);
    f.castShadow = true;
    g.add(f);
  }
  return g;
}

// ---------- estação de trabalho ----------
// Coordenadas locais: cadeira na origem, mesa à frente (+z).

export const MESA = { altura: 0.78, zCentro: 0.68, largura: 1.7, profundidade: 0.8 };

export function criarEstacao(agente) {
  const g = new THREE.Group();
  const madeira = mat('#b78a5c');
  const metal = mat('#3a3f4a', { metalness: 0.4, roughness: 0.5 });
  const { altura, zCentro, largura, profundidade } = MESA;

  // mesa
  g.add(caixa(largura, 0.05, profundidade, madeira, 0, altura, zCentro));
  for (const sx of [-1, 1]) g.add(caixa(0.05, altura, profundidade - 0.1, metal, sx * (largura / 2 - 0.08), altura / 2, zCentro));
  // divisória entre as mesas frente a frente, na cor do agente
  g.add(caixa(largura, 0.35, 0.04, mat(agente.cor, { roughness: 0.9 }), 0, altura + 0.2, zCentro + profundidade / 2 + 0.02));

  // cadeira
  const cadeira = new THREE.Group();
  cadeira.add(cilindro(0.03, 0.03, 0.4, metal, 0, 0.22, 0));
  cadeira.add(cilindro(0.28, 0.28, 0.03, metal, 0, 0.03, 0, 5));
  cadeira.add(caixa(0.5, 0.08, 0.48, mat('#2b2f3a'), 0, 0.46, 0));
  cadeira.add(caixa(0.48, 0.55, 0.07, mat('#2b2f3a'), 0, 0.8, -0.24));
  g.add(cadeira);

  // monitor com tela dinâmica
  const tela = criarTela();
  const monitor = new THREE.Group();
  monitor.position.set(0, altura + 0.02, zCentro + 0.22);
  monitor.add(caixa(0.22, 0.02, 0.16, metal, 0, 0.01, 0));
  monitor.add(caixa(0.05, 0.25, 0.04, metal, 0, 0.14, 0.02));
  monitor.add(caixa(0.78, 0.48, 0.04, mat('#15171c'), 0, 0.5, 0));
  const painel = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.42), new THREE.MeshBasicMaterial({ map: tela.textura }));
  painel.position.set(0, 0.5, -0.021);
  painel.rotation.y = Math.PI;
  monitor.add(painel);
  g.add(monitor);

  // teclado e mouse (o agente olha para +z, então a mão direita fica em -x)
  g.add(caixa(0.5, 0.025, 0.16, mat('#2a2d35'), -0.02, altura + 0.035, zCentro - 0.2));
  const mouse = caixa(0.06, 0.03, 0.1, mat('#2a2d35'), -0.38, altura + 0.04, zCentro - 0.2);
  g.add(mouse);

  if (agente.chefe) {
    // encosto alto e plaquinha de chefe
    cadeira.add(caixa(0.5, 0.45, 0.07, mat('#3b2a20'), 0, 1.25, -0.25));
    const placa = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.1), new THREE.MeshBasicMaterial({ map: texturaTexto('CHEFE', '#f4d35e', '#2a2d35', 72) }));
    placa.position.set(0.45, altura + 0.08, zCentro - 0.3);
    placa.rotation.x = -0.5;
    g.add(placa);
  }

  // caneca e luminária de status
  if (!agente.chefe) g.add(cilindro(0.045, 0.04, 0.1, mat(agente.cor), 0.65, altura + 0.075, zCentro - 0.05)); // na mesa do chefe fica a bola de cristal
  const lampada = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshStandardMaterial({ color: '#8e99ad', emissive: '#8e99ad', emissiveIntensity: 1.2 }));
  lampada.position.set(-0.68, altura + 0.08, zCentro + 0.28);
  g.add(lampada);
  const luz = new THREE.PointLight('#8e99ad', 0.6, 1.6);
  luz.position.copy(lampada.position).add(new THREE.Vector3(0, 0.1, 0));
  g.add(luz);

  // adereços específicos da atividade
  const extras = {};
  if (agente.atividade === 'desenhar') {
    const mesaDigital = caixa(0.36, 0.015, 0.26, mat('#20232b'), -0.15, altura + 0.033, zCentro - 0.18);
    g.add(mesaDigital);
  }
  if (agente.atividade === 'telefone') {
    g.add(caixa(0.18, 0.06, 0.22, mat('#2a2d35'), -0.6, altura + 0.05, zCentro - 0.05));
  }
  if (agente.atividade === 'ler') {
    for (let i = 0; i < 3; i++) g.add(caixa(0.24, 0.012, 0.32, mat('#f4f1ea'), 0.55, altura + 0.035 + i * 0.013, zCentro + 0.1).rotateY(i * 0.08));
  }
  // adereços por função (pelo id do agente)
  if (['backend', 'frontend', 'programador'].includes(agente.id)) {
    // segundo monitor, virado de lado, com "código"
    const m2 = new THREE.Group();
    m2.position.set(0.62, altura + 0.02, zCentro + 0.12);
    m2.rotation.y = -0.45;
    m2.add(caixa(0.05, 0.22, 0.04, metal, 0, 0.12, 0.02));
    m2.add(caixa(0.5, 0.34, 0.035, mat('#15171c'), 0, 0.4, 0));
    const codigo = canvasPlano(0.46, 0.3, 128, 84);
    const ctx = codigo.userData.canvas.getContext('2d');
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, 128, 84);
    ['#7ee787', '#79c0ff', '#ff7b72', '#d2a8ff'].forEach((c, i) => { for (let l = i; l < 10; l += 4) { ctx.fillStyle = c; ctx.fillRect(6 + (l % 3) * 8, 6 + l * 7.5, 30 + ((l * 23) % 70), 3); } });
    codigo.material.map.needsUpdate = true;
    codigo.position.set(0, 0.4, -0.019);
    codigo.rotation.y = Math.PI;
    m2.add(codigo);
    g.add(m2);
  }
  if (['requisitos', 'pesquisador'].includes(agente.id)) {
    const coresLivro = ['#e11d2a', '#3f3f46', '#fbbf24', '#60a5fa'];
    coresLivro.forEach((c, i) => g.add(caixa(0.3 - i * 0.02, 0.05, 0.22, mat(c), -0.62, altura + 0.05 + i * 0.05, zCentro - 0.02).rotateY((i - 1.5) * 0.12)));
  }
  if (agente.id === 'designer') {
    // pote de lápis coloridos
    g.add(cilindro(0.05, 0.05, 0.12, mat('#18181b'), 0.42, altura + 0.085, zCentro + 0.12));
    ['#e11d2a', '#fbbf24', '#60a5fa', '#34d399'].forEach((c, i) => {
      const lapis = cilindro(0.008, 0.008, 0.2, mat(c), 0.42 + (i - 1.5) * 0.018, altura + 0.2, zCentro + 0.12 + ((i % 2) - 0.5) * 0.02, 6);
      lapis.rotation.z = (i - 1.5) * 0.12;
      g.add(lapis);
    });
  }
  if (['qa', 'revisor'].includes(agente.id)) {
    // carimbo de "aprovado"
    g.add(cilindro(0.035, 0.045, 0.05, mat('#e11d2a'), 0.5, altura + 0.05, zCentro - 0.25));
    g.add(cilindro(0.015, 0.015, 0.08, mat('#18181b'), 0.5, altura + 0.11, zCentro - 0.25));
  }

  if (agente.id === 'devops') {
    // mini rack de servidor com LEDs piscando, no chão ao lado da mesa
    const rack = new THREE.Group();
    rack.position.set(-1.12, 0, zCentro + 0.05);
    rack.add(caixa(0.36, 0.78, 0.5, mat('#17181d', { metalness: 0.5, roughness: 0.45 }), 0, 0.39, 0));
    for (let n = 0; n < 4; n++) {
      rack.add(caixa(0.3, 0.12, 0.01, mat('#24262d'), 0, 0.14 + n * 0.17, -0.255));
      for (let k = 0; k < 3; k++) {
        const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 4), new THREE.MeshStandardMaterial({ color: k === 2 ? '#f59e0b' : '#22c55e', emissive: k === 2 ? '#f59e0b' : '#22c55e', emissiveIntensity: 1 }));
        led.position.set(-0.1 + k * 0.035, 0.14 + n * 0.17, -0.262);
        led.userData = { vel: 3 + ((n * 3 + k) % 5) * 1.7, fase: n + k * 2.1, limiar: k === 2 ? 0.7 : -0.2 };
        AMBIENTE.leds.push(led);
        rack.add(led);
      }
    }
    g.add(rack);
    // adesivo de baleia (Docker) na caneca? um pequeno terminal verde na mesa
    g.add(caixa(0.22, 0.015, 0.16, mat('#14532d', { emissive: '#22c55e', emissiveIntensity: 0.25 }), 0.5, altura + 0.035, zCentro - 0.22));
  }
  if (agente.id === 'documentador') {
    // pilha de manuais e caderno aberto
    ['#f4f1ea', '#e7e5e4', '#fafaf9'].forEach((c, i) => g.add(caixa(0.26, 0.015, 0.34, mat(c), 0.55, altura + 0.035 + i * 0.016, zCentro + 0.08).rotateY(i * 0.1 - 0.1)));
    const caderno = new THREE.Group();
    caderno.position.set(-0.55, altura + 0.035, zCentro - 0.08);
    caderno.add(caixa(0.2, 0.012, 0.28, mat('#fafaf9'), -0.1, 0, 0).rotateZ(0.04));
    caderno.add(caixa(0.2, 0.012, 0.28, mat('#fafaf9'), 0.1, 0, 0).rotateZ(-0.04));
    caderno.add(caixa(0.012, 0.02, 0.28, mat(agente.cor), 0, 0.004, 0));
    g.add(caderno);
  }
  if (agente.id === 'frontend') {
    // celular num suporte mostrando a versão mobile
    const cel = new THREE.Group();
    cel.position.set(-0.55, altura + 0.03, zCentro + 0.12);
    cel.rotation.y = 0.35;
    cel.add(caixa(0.07, 0.02, 0.07, mat('#3a3f4a'), 0, 0.01, 0));
    cel.add(caixa(0.075, 0.15, 0.01, mat('#111'), 0, 0.09, 0.0).rotateX(-0.25));
    const telaCel = new THREE.Mesh(new THREE.PlaneGeometry(0.064, 0.13), new THREE.MeshBasicMaterial({ color: agente.cor }));
    telaCel.position.set(0, 0.09, -0.007);
    telaCel.rotation.set(0.25, Math.PI, 0);
    cel.add(telaCel);
    g.add(cel);
  }
  if (['requisitos', 'pesquisador'].includes(agente.id)) {
    // post-its na divisória
    ['#fde68a', '#fbcfe8', '#bfdbfe', '#bbf7d0', '#fde68a'].forEach((c, i) => {
      const nota = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), mat(c, { side: THREE.DoubleSide }));
      nota.position.set(-0.6 + i * 0.28, altura + 0.24 + ((i * 7) % 3) * 0.04, zCentro + profundidade / 2 - 0.001);
      nota.rotation.set(0, Math.PI, ((i * 13) % 5 - 2) * 0.06);
      g.add(nota);
    });
  }

  if (agente.atividade === 'quadro') {
    const quadro = criarQuadroBranco();
    quadro.grupo.position.set(0, 0, -1.55);
    g.add(quadro.grupo);
    extras.quadro = quadro;
  }

  return { grupo: g, tela, lampada, luz, mouse, extras };
}

function criarQuadroBranco() {
  const grupo = new THREE.Group();
  const metal = mat('#9aa3b2', { metalness: 0.5, roughness: 0.4 });
  for (const sx of [-1, 1]) {
    grupo.add(caixa(0.04, 1.9, 0.04, metal, sx * 0.75, 0.95, 0));
    grupo.add(caixa(0.04, 0.03, 0.5, metal, sx * 0.75, 0.02, 0));
  }
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 340;
  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  const placa = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 0.03), [
    mat('#d0d4dc'), mat('#d0d4dc'), mat('#d0d4dc'), mat('#d0d4dc'),
    new THREE.MeshStandardMaterial({ map: textura, roughness: 0.3 }), mat('#d0d4dc'),
  ]);
  placa.position.set(0, 1.35, 0);
  placa.castShadow = true;
  grupo.add(placa);
  return { grupo, canvas, textura, progresso: 0 };
}

// ---------- texturas desenhadas em canvas ----------

function criarTela() {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 150;
  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  return { canvas, ctx: canvas.getContext('2d'), textura, linhas: [], tempo: 0 };
}

const CORES_CODIGO = ['#7ee787', '#79c0ff', '#ff7b72', '#d2a8ff', '#e6edf3', '#ffa657'];

// Redesenha o monitor de acordo com a atividade e o estado do agente.
export function desenharTela(tela, agente, estado, t) {
  const { ctx, canvas } = tela;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = estado === 'erro' ? '#2a0d10' : '#0d1117';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = agente.cor;
  ctx.fillRect(0, 0, W, 12);
  ctx.fillStyle = '#0d1117';
  ctx.font = 'bold 9px sans-serif';
  ctx.fillText(agente.nome.toUpperCase(), 6, 9);

  if (estado === 'ocioso') {
    // proteção de tela
    const x = W / 2 + Math.sin(t * 0.7) * 70, y = H / 2 + Math.cos(t * 0.9) * 35;
    ctx.fillStyle = agente.cor;
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('zZz', x, y);
    ctx.textAlign = 'left';
  } else if (estado === 'erro') {
    ctx.fillStyle = '#e5484d';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.floor(t * 2) % 2 ? '⚠ ERRO' : '', W / 2, H / 2 + 8);
    ctx.textAlign = 'left';
  } else if (estado === 'concluido') {
    ctx.fillStyle = '#3fb27f';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✓', W / 2, H / 2 + 18);
    ctx.textAlign = 'left';
  } else if (estado === 'aguardando') {
    ctx.fillStyle = '#e0b23c';
    for (let i = 0; i < 3; i++) {
      const a = t * 4 - i * 0.6;
      ctx.globalAlpha = 0.3 + 0.7 * Math.max(0, Math.sin(a));
      ctx.beginPath(); ctx.arc(W / 2 - 24 + i * 24, H / 2 + 6, 7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else if (agente.atividade === 'analisar') {
    // gráfico de barras e linha que se movem
    for (let i = 0; i < 10; i++) {
      const h = 20 + 70 * (0.5 + 0.5 * Math.sin(t * 1.3 + i * 0.9));
      ctx.fillStyle = i % 2 ? '#4c8dff' : '#e0b23c';
      ctx.fillRect(12 + i * 23, H - 12 - h, 16, h);
    }
    ctx.strokeStyle = '#3fb27f'; ctx.lineWidth = 2; ctx.beginPath();
    for (let x = 0; x < W; x += 8) ctx.lineTo(x, 50 + 18 * Math.sin(t * 2 + x * 0.05));
    ctx.stroke();
  } else if (agente.atividade === 'desenhar') {
    // pincel desenhando curvas coloridas
    ctx.fillStyle = '#f4f1ea'; ctx.fillRect(10, 18, W - 20, H - 26);
    ctx.lineWidth = 4; ctx.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = ['#b05cf0', '#f07a3a', '#2ec4d6'][k];
      ctx.beginPath();
      const fim = ((t * 0.5 + k * 0.33) % 1) * 60;
      for (let i = 0; i < fim; i++) {
        const a = i * 0.1 + k * 2;
        ctx.lineTo(W / 2 + Math.cos(a) * (30 + k * 20) * Math.sin(a * 0.5), H / 2 + 6 + Math.sin(a) * (20 + k * 10));
      }
      ctx.stroke();
    }
  } else if (agente.atividade === 'telefone') {
    // lista de tickets/chat
    for (let i = 0; i < 5; i++) {
      const ativo = i === Math.floor(t) % 5;
      ctx.fillStyle = ativo ? agente.cor : '#21262d';
      ctx.fillRect(8, 20 + i * 25, W - 16, 20);
      ctx.fillStyle = ativo ? '#0d1117' : '#8b949e';
      ctx.font = '10px sans-serif';
      ctx.fillText(`Cliente #${1040 + i}  —  ${ativo ? 'em atendimento' : 'na fila'}`, 14, 34 + i * 25);
    }
  } else {
    // texto/código sendo digitado
    tela.tempo += 1;
    if (tela.tempo % 2 === 0) {
      const ultima = tela.linhas[tela.linhas.length - 1];
      if (!ultima || ultima.tam >= ultima.max) {
        tela.linhas.push({ recuo: Math.floor(Math.random() * 3) * 12, tam: 0, max: 30 + Math.random() * 150, cor: CORES_CODIGO[Math.floor(Math.random() * CORES_CODIGO.length)] });
        if (tela.linhas.length > 11) tela.linhas.shift();
      } else ultima.tam += 6 + Math.random() * 10;
    }
    tela.linhas.forEach((l, i) => {
      ctx.fillStyle = agente.atividade === 'ler' ? '#c9d1d9' : l.cor;
      ctx.fillRect(10 + l.recuo, 20 + i * 11, Math.min(l.tam, l.max), 6);
    });
  }
  tela.textura.needsUpdate = true;
}

// Escreve gradualmente rabiscos/post-its no quadro branco.
export function desenharQuadro(quadro, escrevendo, dt) {
  const ctx = quadro.canvas.getContext('2d');
  const W = quadro.canvas.width, H = quadro.canvas.height;
  if (escrevendo) quadro.progresso = Math.min(1, quadro.progresso + dt * 0.08);
  if (quadro.ultimo === Math.round(quadro.progresso * 200)) return;
  quadro.ultimo = Math.round(quadro.progresso * 200);
  ctx.fillStyle = '#fbfbfd'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1d2230'; ctx.font = 'bold 26px sans-serif';
  ctx.fillText('PLANO DA SEMANA', 20, 38);
  const notas = ['#ffe066', '#9be7a1', '#9cc7ff', '#ffb3c1', '#ffd6a5', '#cdb4ff'];
  const n = Math.floor(quadro.progresso * notas.length * 1.0001);
  for (let i = 0; i < n; i++) {
    const x = 20 + (i % 3) * 160, y = 60 + Math.floor(i / 3) * 130;
    ctx.fillStyle = notas[i]; ctx.fillRect(x, y, 140, 110);
    ctx.fillStyle = '#0006';
    for (let k = 0; k < 4; k++) ctx.fillRect(x + 10, y + 18 + k * 22, 60 + ((i * 37 + k * 23) % 60), 6);
  }
  // seta rabiscada
  ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(300, 30); ctx.lineTo(300 + 180 * quadro.progresso, 30); ctx.stroke();
  if (quadro.progresso >= 1) quadro.progresso = 0; // recomeça um novo plano
  quadro.textura.needsUpdate = true;
}

function texturaPiso() {
  // tábuas de carvalho: tons variados, emendas desencontradas e veios
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  const ALT = 512 / 8;
  let semente = 7;
  const aleatorio = () => ((semente = (semente * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 8; i++) {
    const y = i * ALT;
    let x = -aleatorio() * 300;
    while (x < 512) {
      const comp = 220 + aleatorio() * 200;
      const tom = 0.86 + aleatorio() * 0.2;
      ctx.fillStyle = `rgb(${196 * tom | 0}, ${152 * tom | 0}, ${108 * tom | 0})`;
      ctx.fillRect(x, y, comp, ALT);
      // veios
      for (let v = 0; v < 7; v++) {
        ctx.strokeStyle = `rgba(110, 70, 35, ${0.05 + aleatorio() * 0.08})`;
        ctx.lineWidth = 1 + aleatorio() * 1.5;
        const yv = y + 6 + aleatorio() * (ALT - 12);
        ctx.beginPath(); ctx.moveTo(x, yv);
        ctx.bezierCurveTo(x + comp * 0.3, yv + (aleatorio() - 0.5) * 8, x + comp * 0.7, yv + (aleatorio() - 0.5) * 8, x + comp, yv);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(40, 24, 10, 0.35)';
      ctx.fillRect(x, y, 2, ALT); // emenda
      x += comp;
    }
    ctx.fillStyle = 'rgba(40, 24, 10, 0.4)';
    ctx.fillRect(0, y, 512, 2);
    ctx.fillStyle = 'rgba(255, 240, 220, 0.08)';
    ctx.fillRect(0, y + 2, 512, 2); // brilho na borda da tábua
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// tapete de lã cinza com trama e borda discreta
function texturaTapete() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#4a4c53'; ctx.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(Math.random() * 512, Math.random() * 256, 2, 2);
  }
  ctx.strokeStyle = 'rgba(20, 20, 24, 0.55)'; ctx.lineWidth = 10; ctx.strokeRect(5, 5, 502, 246);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'; ctx.lineWidth = 2; ctx.strokeRect(20, 20, 472, 216);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// quadro de parede: arte abstrata na paleta do escritório
function quadroParede(largura, altura, estilo = 0) {
  const g = new THREE.Group();
  g.add(caixa(largura + 0.08, altura + 0.08, 0.04, mat('#18181b'), 0, 0, 0));
  const arte = canvasPlano(largura, altura, 256, Math.round(256 * altura / largura), { basico: false });
  const c = arte.userData.canvas; const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, W, H);
  const marca = AMBIENTE.marca.cor;
  if (estilo === 0) {
    ctx.fillStyle = marca; ctx.beginPath(); ctx.arc(W * 0.38, H * 0.42, W * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#18181b'; ctx.fillRect(W * 0.52, H * 0.3, W * 0.3, H * 0.5);
    ctx.fillStyle = '#e0b23c'; ctx.fillRect(W * 0.18, H * 0.72, W * 0.5, H * 0.06);
  } else if (estilo === 1) {
    for (let i = 0; i < 6; i++) { ctx.strokeStyle = i % 2 ? '#18181b' : marca; ctx.lineWidth = 9; ctx.beginPath(); ctx.arc(W / 2, H * 1.05, W * (0.12 + i * 0.1), Math.PI, 0); ctx.stroke(); }
  } else {
    ctx.fillStyle = '#18181b'; ctx.font = `800 ${W * 0.16}px ${FONTE}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('</>', W / 2, H * 0.45);
    ctx.fillStyle = marca; ctx.fillRect(W * 0.3, H * 0.66, W * 0.4, H * 0.04);
  }
  arte.material.map.needsUpdate = true;
  arte.position.z = 0.021;
  g.add(arte);
  return g;
}

// fundo da cena: degradê (mais claro no alto), refeito no dia/noite
function pintarFundo(cima, baixo) {
  const f = AMBIENTE.fundo;
  if (!f) return;
  const ctx = f.image.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, f.image.height);
  g.addColorStop(0, cima); g.addColorStop(1, baixo);
  ctx.fillStyle = g; ctx.fillRect(0, 0, f.image.width, f.image.height);
  f.needsUpdate = true;
}

function texturaCeu() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 96;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 96);
  g.addColorStop(0, '#7db7f0'); g.addColorStop(1, '#cfe6fb');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 96);
  ctx.fillStyle = '#8fa3bf';
  [[0, 40, 20], [22, 55, 16], [40, 30, 22], [64, 50, 18], [84, 38, 20], [106, 60, 22]].forEach(([x, h, w]) => ctx.fillRect(x, 96 - h, w, h));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function texturaTexto(texto, cor, fundo, px = 48) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  if (fundo) { ctx.fillStyle = fundo; ctx.fillRect(0, 0, 512, 128); }
  ctx.fillStyle = cor; ctx.font = `bold ${px}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(texto, 256, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
