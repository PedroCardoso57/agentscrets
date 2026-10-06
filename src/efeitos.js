import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/CSS2DRenderer.js';

// Efeitos que mostram o trabalho acontecendo: anel de progresso sobre quem está
// trabalhando, a folha da entrega voando até a mesa do chefe (passando pelo
// Revisor quando houve revisão), aviãozinho de papel nas ordens do Telegram e
// despertador quando uma rotina dispara.

const ALTURA_ANEL = 1.78;

function folha() {
  const g = new THREE.Group();
  const papel = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.004, 0.28), new THREE.MeshStandardMaterial({ color: '#fafafa', roughness: 0.7 }));
  papel.castShadow = true;
  g.add(papel);
  // linhas de "texto" na folha
  const linha = new THREE.MeshBasicMaterial({ color: '#9ca3af' });
  for (let i = 0; i < 5; i++) {
    const l = new THREE.Mesh(new THREE.PlaneGeometry(0.15 - (i === 4 ? 0.06 : 0), 0.012), linha);
    l.rotation.x = -Math.PI / 2;
    l.position.set(-(i === 4 ? 0.03 : 0), 0.0025, -0.09 + i * 0.045);
    g.add(l);
  }
  return g;
}

function aviaoDePapel() {
  // dobradura simples: duas asas triangulares e o corpo
  const forma = new THREE.BufferGeometry();
  forma.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0.3, -0.16, 0.02, -0.12, 0, 0, -0.08, // asa esquerda
    0, 0, 0.3, 0, 0, -0.08, 0.16, 0.02, -0.12, // asa direita
    0, 0, 0.3, 0, -0.06, -0.1, 0, 0, -0.08, // quilha
  ], 3));
  forma.computeVertexNormals();
  const m = new THREE.Mesh(forma, new THREE.MeshStandardMaterial({ color: '#f5f5f5', side: THREE.DoubleSide, roughness: 0.6 }));
  m.castShadow = true;
  return m;
}

export class Efeitos {
  constructor(cena) {
    this.cena = cena;
    this.voos = [];   // { objeto, trechos: [curva…], i, t, duracao, girar, aoChegar }
    this.avisos = []; // despertadores e afins (CSS2D) com prazo
    this.aneis = new Map(); // id do agente → anel
  }

  // anel de progresso sobre a cabeça (fica no grupo da estação; reconstruído junto com a sala)
  criarAnel(id, grupoEstacao, cor) {
    const anel = new THREE.Mesh(
      new THREE.RingGeometry(0.11, 0.145, 40, 1, 0, Math.PI * 1.45),
      new THREE.MeshBasicMaterial({ color: cor, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }),
    );
    const fundo = new THREE.Mesh(
      new THREE.RingGeometry(0.11, 0.145, 40),
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
    );
    const suporte = new THREE.Group();
    suporte.position.set(0, ALTURA_ANEL, 0);
    suporte.add(fundo, anel);
    suporte.visible = false;
    anel.userData.cor = cor;
    grupoEstacao.add(suporte);
    this.aneis.set(id, { suporte, anel });
  }

  limparAneis() { this.aneis.clear(); }

  // Faz um objeto voar por uma sequência de pontos (arcos), um trecho por vez.
  voar(objeto, pontos, { duracao = 1.1, altura = 1.2, pausa = 0.35, girar = true, aoChegar } = {}) {
    const trechos = [];
    for (let i = 0; i < pontos.length - 1; i++) {
      const [a, b] = [pontos[i], pontos[i + 1]];
      const meio = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, altura + a.distanceTo(b) * 0.15, 0));
      trechos.push(new THREE.QuadraticBezierCurve3(a, meio, b));
    }
    objeto.position.copy(pontos[0]);
    this.cena.add(objeto);
    this.voos.push({ objeto, trechos, i: 0, t: 0, espera: 0, duracao, pausa, girar, aoChegar });
  }

  // a folha da entrega: da mesa do agente (pelo Revisor, se revisada) até a mesa do chefe
  entrega(pontos, aoChegar) {
    this.voar(folha(), pontos, { aoChegar });
  }

  // aviãozinho de papel entrando pela janela até a mesa do chefe
  telegram(de, para) {
    const aviao = aviaoDePapel();
    this.voar(aviao, [de, para], { duracao: 2.2, altura: 0.6, girar: false });
  }

  // despertador tocando em cima de um ponto (CSS2D, some sozinho)
  despertador(posicao, texto) {
    const el = document.createElement('div');
    el.className = 'efeito-despertador';
    el.innerHTML = '<span class="sino">⏰</span><span class="rotulo"></span>';
    el.querySelector('.rotulo').textContent = texto;
    const obj = new CSS2DObject(el);
    obj.position.copy(posicao);
    this.cena.add(obj);
    this.avisos.push({ obj, ate: performance.now() + 4500 });
  }

  atualizar(dt, t, camera, estadoDe) {
    // anéis: aparecem enquanto o agente trabalha (amarelo esperando), viram para a câmera e giram
    for (const [id, { suporte, anel }] of this.aneis) {
      const estado = estadoDe(id);
      const ativo = estado === 'trabalhando' || estado === 'aguardando';
      suporte.visible = ativo;
      if (!ativo) continue;
      suporte.quaternion.copy(camera.quaternion);
      anel.rotation.z = -t * (estado === 'aguardando' ? 1.2 : 4);
      anel.material.color.set(estado === 'aguardando' ? '#e0b23c' : anel.userData.cor);
    }

    for (const v of this.voos) {
      if (v.espera > 0) { v.espera -= dt; continue; }
      v.t = Math.min(1, v.t + dt / v.duracao);
      const curva = v.trechos[v.i];
      const k = v.t * v.t * (3 - 2 * v.t);
      v.objeto.position.copy(curva.getPoint(k));
      if (v.girar) {
        v.objeto.rotation.y += dt * 5;
        v.objeto.rotation.z = Math.sin(t * 6) * 0.3;
      } else {
        // o avião aponta para onde vai
        const adiante = curva.getPoint(Math.min(1, k + 0.02));
        v.objeto.lookAt(adiante);
      }
      if (v.t >= 1) {
        v.i++;
        v.t = 0;
        v.espera = v.pausa; // pausa no meio do caminho (ex.: na mesa do Revisor)
        if (v.i >= v.trechos.length) v.fim = true;
      }
    }
    for (const v of this.voos.filter((x) => x.fim)) {
      v.objeto.removeFromParent();
      v.aoChegar?.();
    }
    this.voos = this.voos.filter((x) => !x.fim);

    const agora = performance.now();
    for (const a of this.avisos.filter((x) => x.ate < agora)) { a.obj.removeFromParent(); a.obj.element.remove(); }
    this.avisos = this.avisos.filter((x) => x.ate >= agora);
  }
}
