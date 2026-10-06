import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { mat, MESA } from './escritorio.js';

// Crânio: a bola de cristal do Laya, o decisor do escritório, em cima da mesa
// do chefe. Brilha quando o Laya está no ar; toda decisão passa por ela: o
// chefe consulta a bola, ela pulsa e manda um feixe de luz até o agente.

const ROXO = '#a77bff';
const RAIO = 0.14;
// posição na mesa do chefe (coordenadas locais da estação: o chefe olha para +z)
const NA_MESA = new THREE.Vector3(0.55, MESA.altura + 0.025, MESA.zCentro - 0.05);

// pequeno cérebro dentro da bola: icosaedro com dobras feitas por ruído
function criarCerebro() {
  const geo = new THREE.IcosahedronGeometry(0.055, 3);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const dobras = 1 + 0.08 * Math.sin(v.x * 140 + Math.cos(v.y * 110)) * Math.cos(v.z * 120 + v.y * 50);
    v.multiplyScalar(dobras);
    v.y *= 0.85;
    v.z *= 1.12;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#e6dcff', emissive: ROXO, emissiveIntensity: 1, roughness: 0.4 }));
}

export class Cranio {
  constructor() {
    this.grupo = new THREE.Group();
    this.grupo.position.copy(NA_MESA);
    this.online = false;
    this.pulso = 0;
    this.feixes = [];
    const g = this.grupo;

    // suporte dourado
    const ouro = mat('#c9a14a', { metalness: 0.8, roughness: 0.3 });
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.03, 24), mat('#2b1d38', { roughness: 0.5 })).translateY(0.015));
    const anel = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.012, 8, 32), ouro);
    anel.rotation.x = Math.PI / 2;
    anel.position.y = 0.04;
    g.add(anel);
    for (let i = 0; i < 3; i++) {
      const garra = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.07, 6), ouro);
      const a = (i / 3) * Math.PI * 2;
      garra.position.set(Math.cos(a) * 0.08, 0.07, Math.sin(a) * 0.08);
      garra.rotation.z = Math.cos(a) * 0.5;
      garra.rotation.x = -Math.sin(a) * 0.5;
      g.add(garra);
    }

    // a bola de cristal
    this.bola = new THREE.Mesh(
      new THREE.SphereGeometry(RAIO, 40, 28),
      new THREE.MeshStandardMaterial({ color: '#cbb8ff', emissive: '#5b3fa8', emissiveIntensity: 0.4, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.1, depthWrite: false }),
    );
    this.bola.position.y = 0.05 + RAIO;
    g.add(this.bola);
    // brilho na borda
    const halo = new THREE.Mesh(new THREE.SphereGeometry(RAIO * 1.08, 32, 20), new THREE.MeshBasicMaterial({ color: ROXO, transparent: true, opacity: 0.12, side: THREE.BackSide, depthWrite: false }));
    this.bola.add(halo);
    this.halo = halo;

    // dentro: o cérebro e uma névoa de partículas girando
    this.cerebro = criarCerebro();
    this.bola.add(this.cerebro);
    const n = 160;
    const pontos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = RAIO * (0.35 + Math.random() * 0.55);
      const t = Math.random() * Math.PI * 2;
      const f = Math.acos(2 * Math.random() - 1);
      pontos.set([r * Math.sin(f) * Math.cos(t), r * Math.cos(f) * 0.7, r * Math.sin(f) * Math.sin(t)], i * 3);
    }
    const geoNevoa = new THREE.BufferGeometry();
    geoNevoa.setAttribute('position', new THREE.BufferAttribute(pontos, 3));
    this.nevoa = new THREE.Points(geoNevoa, new THREE.PointsMaterial({ color: '#e6dcff', size: 0.008, transparent: true, opacity: 0.8, depthWrite: false }));
    this.bola.add(this.nevoa);

    this.luz = new THREE.PointLight(ROXO, 0.8, 1.6);
    this.luz.position.y = this.bola.position.y;
    g.add(this.luz);

    // etiqueta com o nome e o balão da decisão
    const el = document.createElement('div');
    el.className = 'etiqueta cranio';
    el.innerHTML = '<div class="balao"></div><div class="placa"><i></i><span>🔮 Crânio · Laya</span></div>';
    this.etiqueta = new CSS2DObject(el);
    this.etiqueta.position.set(0, 0.55, 0);
    g.add(this.etiqueta);
    this.balao = el.querySelector('.balao');
    this.marcador = el.querySelector('.placa i');
    this.definirOnline(false);
  }

  // A bola fica na mesa do chefe: entra no grupo da estação dele.
  anexar(grupoDoChefe) {
    grupoDoChefe.add(this.grupo);
  }

  // O chefe consulta a bola sem sair do lugar: levanta na cadeira e olha para ela.
  parada(grupoDoChefe) {
    const pos = grupoDoChefe.localToWorld(new THREE.Vector3(0, 0, 0));
    const bola = this.bola.getWorldPosition(new THREE.Vector3());
    return { pos, via: null, olhar: Math.atan2(bola.x - pos.x, bola.z - pos.z), gesto: 'consultar' };
  }

  posicaoMundo() {
    return this.bola.getWorldPosition(new THREE.Vector3());
  }

  definirOnline(online) {
    this.online = online;
    this.marcador.style.background = online ? ROXO : '#8e99ad';
    this.marcador.title = online ? 'Laya no ar' : 'Laya desligado';
  }

  // Animação da decisão: a bola pulsa, um feixe vai até o agente e o balão mostra o resultado.
  decidir(destinoMundo, texto) {
    this.pulso = 1;
    this.balao.textContent = texto;
    this.balao.classList.add('visivel');
    clearTimeout(this.timerBalao);
    this.timerBalao = setTimeout(() => this.balao.classList.remove('visivel'), 7000);
    if (!destinoMundo) return;
    const cena = this.grupo.parent?.parent;
    if (!cena) return;
    const inicio = this.posicaoMundo();
    const fim = destinoMundo.clone().add(new THREE.Vector3(0, 1.3, 0));
    const meio = inicio.clone().lerp(fim, 0.5).add(new THREE.Vector3(0, 2.2, 0));
    const curva = new THREE.QuadraticBezierCurve3(inicio, meio, fim);
    const linha = new THREE.Mesh(
      new THREE.TubeGeometry(curva, 48, 0.02, 6, false),
      new THREE.MeshBasicMaterial({ color: '#cdb6ff', transparent: true, opacity: 0, depthWrite: false }),
    );
    const bola = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshBasicMaterial({ color: '#f3ecff' }));
    bola.add(new THREE.PointLight(ROXO, 2, 2.5));
    cena.add(linha, bola);
    this.feixes.push({ curva, linha, bola, t: 0 });
  }

  atualizar(dt, t) {
    const vivo = this.online ? 1 : 0.15;
    this.pulso = Math.max(0, this.pulso - dt * 0.8);
    const batida = 0.5 + 0.5 * Math.sin(t * 2.2);
    this.bola.material.emissiveIntensity = (0.2 + 0.4 * batida) * vivo + this.pulso * 2;
    this.bola.material.opacity = 0.3 + 0.1 * vivo + this.pulso * 0.2;
    this.halo.material.opacity = 0.05 + 0.12 * vivo * batida + this.pulso * 0.3;
    this.cerebro.material.emissiveIntensity = (0.4 + 0.6 * batida) * vivo + this.pulso * 3;
    this.cerebro.material.color.set(this.online ? '#e6dcff' : '#8a8799');
    this.cerebro.rotation.y += dt * (0.6 + this.pulso * 5) * (this.online ? 1 : 0.2);
    this.nevoa.rotation.y -= dt * (0.4 + this.pulso * 6) * (this.online ? 1 : 0.1);
    this.nevoa.material.opacity = 0.2 + 0.6 * vivo;
    this.bola.scale.setScalar(1 + this.pulso * 0.12);
    this.luz.intensity = (0.3 + 0.5 * batida) * vivo + this.pulso * 3;

    // feixes: a bolinha de luz viaja pela curva até o agente e o rastro some
    for (const f of this.feixes) {
      f.t += dt / 1.4;
      const p = Math.min(1, f.t);
      f.bola.position.copy(f.curva.getPoint(p));
      f.linha.material.opacity = f.t < 1 ? 0.55 * p : Math.max(0, 0.55 - (f.t - 1) * 0.8);
      f.bola.visible = f.t < 1.05;
    }
    for (const f of this.feixes.filter((x) => x.t > 1.8)) {
      f.linha.removeFromParent(); f.bola.removeFromParent();
      f.linha.geometry.dispose();
    }
    this.feixes = this.feixes.filter((x) => x.t <= 1.8);
  }
}
