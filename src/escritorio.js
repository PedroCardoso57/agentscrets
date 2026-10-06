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

// ---------- sala ----------

export function criarSala(totalAgentes) {
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
    const tapete = new THREE.Mesh(new THREE.PlaneGeometry(COLUNAS * ESPACO_X + 0.6, 5.4), mat('#3a4560'));
    tapete.rotation.x = -Math.PI / 2;
    tapete.position.set(0, 0.005, p * ESPACO_POD);
    tapete.receiveShadow = true;
    sala.add(tapete);
  }

  // paredes (só fundo e esquerda, estilo "casa de bonecas")
  const parede = mat('#e9e4da');
  const xEsq = cx - largura / 2;
  const zFundo = cz - profundidade / 2;
  sala.add(caixa(largura, 3.2, 0.2, parede, cx, 1.6, zFundo));
  sala.add(caixa(0.2, 3.2, profundidade, parede, xEsq, 1.6, cz));
  sala.add(caixa(largura, 0.12, 0.06, mat('#c9c1b3'), cx, 0.06, zFundo + 0.12)); // rodapé
  sala.add(caixa(0.06, 0.12, profundidade, mat('#c9c1b3'), xEsq + 0.12, 0.06, cz));

  // janelas no fundo
  const nJanelas = Math.floor(largura / 3.2);
  for (let i = 0; i < nJanelas; i++) {
    const x = xEsq + 1.6 + i * (largura - 3.2) / Math.max(1, nJanelas - 1);
    sala.add(janela(x, zFundo + 0.11));
  }

  // logo na parede esquerda
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), new THREE.MeshBasicMaterial({ map: texturaTexto('agentscrets', '#1d2230', '#e9e4da', 64), transparent: true }));
  logo.rotation.y = Math.PI / 2;
  logo.position.set(xEsq + 0.11, 2.2, cz);
  sala.add(logo);

  // copa: mesa com cafeteira, bebedouro e sofá
  const copa = new THREE.Group();
  copa.position.set(cx + largura / 2 - 2.2, 0, zFundo + 1.2);
  copa.add(caixa(1.8, 0.9, 0.6, mat('#6b4f3a'), 0, 0.45, 0));
  copa.add(caixa(0.35, 0.45, 0.3, mat('#222'), -0.4, 1.12, 0));
  copa.add(cilindro(0.05, 0.04, 0.1, mat('#ffffff'), -0.1, 0.95, 0.1));
  copa.add(cilindro(0.05, 0.04, 0.1, mat('#e5484d'), 0.05, 0.95, 0.12));
  copa.add(cilindro(0.18, 0.18, 1.1, mat('#d8dde6'), 0.65, 1.45, 0));
  copa.add(cilindro(0.16, 0.16, 0.45, mat('#7fc8ff', { transparent: true, opacity: 0.7 }), 0.65, 2.2, 0));
  sala.add(copa);

  const sofa = new THREE.Group();
  sofa.position.set(xEsq + 1.0, 0, zFundo + 2.6);
  sofa.rotation.y = Math.PI / 2;
  const tecido = mat('#4b5b7a');
  sofa.add(caixa(2.2, 0.4, 0.8, tecido, 0, 0.3, 0));
  sofa.add(caixa(2.2, 0.6, 0.2, tecido, 0, 0.7, -0.3));
  sofa.add(caixa(0.2, 0.55, 0.8, tecido, -1.1, 0.45, 0));
  sofa.add(caixa(0.2, 0.55, 0.8, tecido, 1.1, 0.45, 0));
  sala.add(sofa);

  // plantas nos cantos
  sala.add(planta(xEsq + 0.6, zFundo + 0.6, 1.2));
  sala.add(planta(cx + largura / 2 - 0.6, zFundo + 2.4, 1.0));
  sala.add(planta(cx + largura / 2 - 0.6, cz + profundidade / 2 - 0.8, 0.9)); // o canto da frente à esquerda é do Crânio
  sala.add(planta(CORREDOR_X + 1.3, cz - 1, 0.8));

  return { grupo: sala, centro: new THREE.Vector3(cx, 0, cz), largura, profundidade };
}

function janela(x, z) {
  const g = new THREE.Group();
  const vidro = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.5), new THREE.MeshBasicMaterial({ map: texturaCeu() }));
  vidro.position.set(x, 1.85, z + 0.005);
  g.add(vidro);
  const moldura = mat('#ffffff');
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
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  for (let i = 0; i < 8; i++) {
    const tom = 150 + ((i * 37) % 30);
    ctx.fillStyle = `rgb(${tom}, ${tom * 0.72 | 0}, ${tom * 0.5 | 0})`;
    ctx.fillRect(0, i * 32, 256, 32);
    ctx.fillStyle = '#0002';
    ctx.fillRect(0, i * 32, 256, 2);
    ctx.fillRect(((i * 97) % 256), i * 32, 2, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
