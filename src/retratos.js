import * as THREE from 'three';
import { Boneco } from './boneco.js';

// Fotos 3x4 da equipe: cada bonequinho é "fotografado" de frente, do peito para
// cima, num fundo de estúdio na cor dele. Usadas nos cartões, na lista da
// equipe e nos avisos. Feitas uma vez (e de novo só se o agente mudar de cor).

const TAMANHO = 192;
const cache = new Map(); // chave (id + cores) → data URL
let estudio = null;

function montarEstudio() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(TAMANHO, TAMANHO, false);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const cena = new THREE.Scene();
  cena.add(new THREE.HemisphereLight('#fff8ee', '#3a3a48', 1.3));
  const chave = new THREE.DirectionalLight('#fff1d6', 2.2);
  chave.position.set(-1.2, 2.2, 2.4);
  const recorte = new THREE.DirectionalLight('#b9c8ff', 1.1);
  recorte.position.set(1.6, 1.8, -1.2);
  cena.add(chave, recorte);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 10);
  camera.position.set(0.28, 1.36, 1.25);
  camera.lookAt(0, 1.22, 0);
  return { renderer, cena, camera };
}

// Fundo de estúdio: degradê na cor do agente, mais claro atrás da cabeça
function fundo(ctx, cor) {
  const c = new THREE.Color(cor);
  const claro = c.clone().lerp(new THREE.Color('#ffffff'), 0.35).getStyle();
  const escuro = c.clone().lerp(new THREE.Color('#0c0c0f'), 0.55).getStyle();
  const g = ctx.createRadialGradient(TAMANHO * 0.45, TAMANHO * 0.35, TAMANHO * 0.05, TAMANHO / 2, TAMANHO / 2, TAMANHO * 0.75);
  g.addColorStop(0, claro);
  g.addColorStop(1, escuro);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TAMANHO, TAMANHO);
}

export function retratoDe(agente) {
  const chave = [agente.id, agente.cor, agente.cabelo, agente.pele].join('|');
  if (cache.has(chave)) return cache.get(chave);
  try {
    estudio ??= montarEstudio();
    const { renderer, cena, camera } = estudio;
    const boneco = new Boneco(agente);
    boneco.raiz.rotation.y = -0.18; // um leve três-quartos, como numa foto
    cena.add(boneco.raiz);
    renderer.render(cena, camera);
    cena.remove(boneco.raiz);
    const tela = document.createElement('canvas');
    tela.width = tela.height = TAMANHO;
    const ctx = tela.getContext('2d');
    fundo(ctx, agente.cor);
    ctx.drawImage(renderer.domElement, 0, 0);
    const url = tela.toDataURL('image/png');
    cache.set(chave, url);
    return url;
  } catch {
    return null; // sem WebGL: fica com as iniciais
  }
}

// Gera as fotos de todos e libera o "estúdio" (um contexto WebGL a menos).
export function retratosDa(equipe) {
  const fotos = new Map(equipe.map((a) => [a.id, retratoDe(a)]));
  if (estudio) {
    estudio.renderer.dispose();
    estudio.renderer.forceContextLoss?.();
    estudio = null;
  }
  return fotos;
}
