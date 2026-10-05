import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { caixa, mat, texturaTexto, posicaoChefe } from './escritorio.js';

// Crânio: a sala de vidro do Laya, o decisor do escritório. Fica no canto da
// frente, ao lado da mesa do chefe. O cérebro holográfico acende quando o Laya
// está no ar, pulsa quando decide e manda um feixe de luz até o agente escolhido.

const LARGURA = 2.4;
const ROXO = '#a77bff';

// Cérebro: icosaedro com dobras feitas por ruído nos vértices
function criarCerebro() {
  const geo = new THREE.IcosahedronGeometry(0.42, 4);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const dobras = 1 + 0.07 * Math.sin(v.x * 18 + Math.cos(v.y * 14)) * Math.cos(v.z * 16 + v.y * 6);
    const sulco = 1 - 0.18 * Math.exp(-((v.x / 0.06) ** 2)); // separa os dois hemisférios
    v.multiplyScalar(dobras * sulco);
    v.y *= 0.82;
    v.z *= 1.12;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: '#d9c7ff', emissive: ROXO, emissiveIntensity: 0.9, roughness: 0.35, transparent: true, opacity: 0.92,
  });
  const cerebro = new THREE.Mesh(geo, material);
  const malha = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#efe6ff', wireframe: true, transparent: true, opacity: 0.18 }));
  cerebro.add(malha);
  return cerebro;
}

export class Cranio {
  constructor() {
    this.grupo = new THREE.Group();
    this.online = false;
    this.pulso = 0;
    this.feixes = [];

    const g = this.grupo;
    const metade = LARGURA / 2;
    const vidro = new THREE.MeshStandardMaterial({ color: '#b9a3ff', transparent: true, opacity: 0.16, roughness: 0.1, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });
    const perfil = mat('#5b4a8a', { metalness: 0.5, roughness: 0.4 });

    // piso e paredes de vidro (a parede do fundo da cena é a parede esquerda da sala)
    g.add(caixa(LARGURA, 0.04, LARGURA, mat('#241d38', { roughness: 0.6 }), 0, 0.02, 0));
    const borda = new THREE.Mesh(new THREE.BoxGeometry(LARGURA + 0.04, 0.02, LARGURA + 0.04), new THREE.MeshBasicMaterial({ color: ROXO }));
    borda.position.y = 0.005;
    g.add(borda);
    const parede = (l, x, z, girar) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(l, 2.4), vidro);
      p.position.set(x, 1.2, z);
      if (girar) p.rotation.y = Math.PI / 2;
      g.add(p);
    };
    parede(LARGURA, 0, -metade, false); // frente (lado da equipe)
    parede(LARGURA, 0, metade, false); // fundo
    parede(0.85, metade, -metade + 0.425, true); // lado do chefe, com porta no meio
    parede(0.85, metade, metade - 0.425, true);
    for (const [x, z] of [[-metade, -metade], [metade, -metade], [-metade, metade], [metade, metade], [metade, -0.35], [metade, 0.35]]) {
      g.add(caixa(0.05, 2.4, 0.05, perfil, x, 1.2, z));
    }
    g.add(caixa(LARGURA, 0.06, 0.06, perfil, 0, 2.4, -metade));
    g.add(caixa(LARGURA, 0.06, 0.06, perfil, 0, 2.4, metade));
    g.add(caixa(0.06, 0.06, LARGURA, perfil, metade, 2.4, 0));

    // placa CRÂNIO sobre a porta e na frente
    for (const [x, z, rot] of [[metade + 0.01, 0, Math.PI / 2], [0, -metade - 0.01, Math.PI]]) {
      const placa = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.32), new THREE.MeshBasicMaterial({ map: texturaTexto('CRÂNIO', '#f3ecff', '#3b2a6b', 64), side: THREE.DoubleSide }));
      placa.position.set(x, 2.15, z);
      placa.rotation.y = rot;
      g.add(placa);
    }

    // pedestal e cérebro
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.4, 0.9, 24), mat('#2e2648', { metalness: 0.6, roughness: 0.3 })).translateY(0.45));
    const anelBase = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.015, 8, 48), new THREE.MeshBasicMaterial({ color: ROXO }));
    anelBase.rotation.x = Math.PI / 2;
    anelBase.position.y = 0.91;
    g.add(anelBase);
    this.cerebro = criarCerebro();
    this.cerebro.position.y = 1.45;
    g.add(this.cerebro);
    this.aneis = [0, 1].map((i) => {
      const a = new THREE.Mesh(new THREE.TorusGeometry(0.62 + i * 0.1, 0.008, 6, 64), new THREE.MeshBasicMaterial({ color: '#cdb6ff', transparent: true, opacity: 0.5 }));
      a.position.y = 1.45;
      a.rotation.x = Math.PI / 2 + (i ? 0.5 : -0.4);
      g.add(a);
      return a;
    });
    this.luz = new THREE.PointLight(ROXO, 1.5, 4);
    this.luz.position.y = 1.6;
    g.add(this.luz);

    // rack de servidor com LEDs piscando
    const rack = caixa(0.5, 1.5, 0.45, mat('#1b1d24', { metalness: 0.4 }), -metade + 0.35, 0.75, metade - 0.35);
    g.add(rack);
    this.leds = [];
    for (let i = 0; i < 8; i++) {
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.01), new THREE.MeshBasicMaterial({ color: i % 3 ? '#3fb27f' : ROXO }));
      led.position.set(-metade + 0.2 + (i % 2) * 0.12, 0.3 + Math.floor(i / 2) * 0.32, metade - 0.575);
      g.add(led);
      this.leds.push(led);
    }

    // etiqueta com o nome e o balão da decisão
    const el = document.createElement('div');
    el.className = 'etiqueta cranio';
    el.innerHTML = '<div class="balao"></div><div class="placa"><i></i><span>🧠 Crânio · Laya</span></div>';
    this.etiqueta = new CSS2DObject(el);
    this.etiqueta.position.set(0, 2.75, 0);
    g.add(this.etiqueta);
    this.balao = el.querySelector('.balao');
    this.marcador = el.querySelector('.placa i');
    this.definirOnline(false);
  }

  // canto da frente à esquerda, ao lado da mesa do chefe
  posicionar(totalAgentes) {
    const { z } = posicaoChefe(totalAgentes);
    this.grupo.position.set(-6.9, 0, z + 0.3);
    this.grupo.updateMatrixWorld(true);
  }

  // onde o chefe para para consultar o Crânio (do lado de fora da porta), e por onde passa
  parada() {
    const pos = this.grupo.localToWorld(new THREE.Vector3(LARGURA / 2 + 0.5, 0, 0));
    const via = this.grupo.localToWorld(new THREE.Vector3(5.3, 0, -1.8)); // na frente da mesa do chefe, sem atravessá-la
    return { pos, via, olhar: -Math.PI / 2 };
  }

  definirOnline(online) {
    this.online = online;
    this.marcador.style.background = online ? ROXO : '#8e99ad';
    this.marcador.title = online ? 'Laya no ar' : 'Laya desligado';
  }

  // Animação da decisão: pulso no cérebro, feixe até o agente e balão com o resultado.
  decidir(destinoMundo, texto) {
    this.pulso = 1;
    this.balao.textContent = texto;
    this.balao.classList.add('visivel');
    clearTimeout(this.timerBalao);
    this.timerBalao = setTimeout(() => this.balao.classList.remove('visivel'), 7000);
    if (!destinoMundo) return;
    const inicio = this.cerebro.getWorldPosition(new THREE.Vector3());
    const fim = destinoMundo.clone().add(new THREE.Vector3(0, 1.3, 0));
    const meio = inicio.clone().lerp(fim, 0.5).add(new THREE.Vector3(0, 2.5, 0));
    const curva = new THREE.QuadraticBezierCurve3(inicio, meio, fim);
    const linha = new THREE.Mesh(
      new THREE.TubeGeometry(curva, 48, 0.025, 6, false),
      new THREE.MeshBasicMaterial({ color: '#cdb6ff', transparent: true, opacity: 0, depthWrite: false }),
    );
    const bola = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), new THREE.MeshBasicMaterial({ color: '#f3ecff' }));
    const luz = new THREE.PointLight(ROXO, 2, 2.5);
    bola.add(luz);
    this.grupo.parent.add(linha, bola);
    this.feixes.push({ curva, linha, bola, t: 0 });
  }

  atualizar(dt, t) {
    const vivo = this.online ? 1 : 0.15;
    this.pulso = Math.max(0, this.pulso - dt * 0.8);
    const batida = 0.5 + 0.5 * Math.sin(t * 2.2);
    this.cerebro.material.emissiveIntensity = (0.35 + 0.45 * batida) * vivo + this.pulso * 2.5;
    this.cerebro.material.color.set(this.online ? '#d9c7ff' : '#8a8799');
    this.cerebro.rotation.y += dt * (0.3 + this.pulso * 4) * (this.online ? 1 : 0.2);
    this.cerebro.position.y = 1.45 + Math.sin(t * 1.3) * 0.04;
    this.cerebro.scale.setScalar(1 + this.pulso * 0.18);
    this.luz.intensity = (0.6 + 0.6 * batida) * vivo + this.pulso * 4;
    this.aneis.forEach((a, i) => {
      a.rotation.z += dt * (i ? -0.6 : 0.8) * (1 + this.pulso * 5);
      a.material.opacity = 0.15 + 0.4 * vivo;
    });
    this.leds.forEach((l, i) => { l.visible = this.online && Math.sin(t * (3 + i) + i * 1.7) > -0.2; });

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
