import * as THREE from 'three';
import { mat } from './escritorio.js';

// Bonequinho feito de primitivas. Olha para +z; a mão direita fica em -x.
// A cada quadro calculamos uma pose-alvo (ângulos das juntas) a partir do
// estado e da atividade do agente, e as juntas seguem essa pose suavemente.

const ALT_SENTADO = 0.52;
const ALT_EM_PE = 0.92;
const POS_QUADRO = new THREE.Vector3(0, 0, -0.98);

function capsula(raio, comp, material) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(raio, comp, 6, 12), material);
  m.castShadow = true;
  return m;
}

function membro(raio, comp, material) {
  // pivô no topo, membro pendurado para baixo (-y)
  const pivo = new THREE.Group();
  const m = capsula(raio, comp, material);
  m.position.y = -comp / 2 - raio * 0.3;
  pivo.add(m);
  return pivo;
}

export class Boneco {
  constructor(agente) {
    this.agente = agente;
    this.semente = Math.random() * 100;
    this.emPe = 0;
    this.tempoNoEstado = 0;
    this.estadoAnterior = null;
    this.rota = [];        // pontos (no espaço do pai) para andar, em ordem
    this.rotFinal = null;  // para onde olhar ao chegar (null = padrão da mesa)
    this.posto = null;     // onde ficar depois da rota (null = cadeira ou quadro)
    this.velocidade = 1.4; // metros por segundo
    this.gesto = null;     // 'apontar' | 'anunciar' — usado pelo chefe ao dar ordens
    this.atencaoAte = 0;   // até quando fica virado ouvindo o chefe
    this.atencaoGiro = 0;

    const camisa = mat(agente.cor, { roughness: 0.9 });
    const pele = mat(agente.pele || '#f1c27d', { roughness: 0.6 });
    const calca = mat('#2f3646');
    const sapato = mat('#1b1d22');
    const cabeloMat = mat(agente.cabelo || '#2b1d14', { roughness: 0.95 });

    this.raiz = new THREE.Group();
    this.quadril = new THREE.Group();
    this.quadril.position.y = ALT_SENTADO;
    this.raiz.add(this.quadril);

    // pernas
    this.pernas = [-1, 1].map((lado) => {
      const coxa = membro(0.075, 0.32, calca);
      coxa.position.x = lado * 0.1;
      const joelho = membro(0.065, 0.32, calca);
      joelho.position.y = -0.44;
      const pe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.2), sapato);
      pe.position.set(0, -0.44, 0.05);
      pe.castShadow = true;
      joelho.add(pe);
      coxa.add(joelho);
      this.quadril.add(coxa);
      return { coxa, joelho };
    });

    // tronco
    this.tronco = new THREE.Group();
    this.quadril.add(this.tronco);
    const corpo = capsula(0.18, 0.3, camisa);
    corpo.position.y = 0.3;
    corpo.scale.set(1, 1, 0.75);
    this.tronco.add(corpo);

    // braços: ombro → cotovelo → mão
    this.bracos = {};
    for (const [nome, lado] of [['esq', 1], ['dir', -1]]) {
      const ombro = membro(0.055, 0.2, camisa);
      ombro.position.set(lado * 0.24, 0.5, 0);
      const cotovelo = membro(0.05, 0.2, pele);
      cotovelo.position.y = -0.3;
      const mao = new THREE.Group();
      mao.position.y = -0.3;
      const punho = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), pele);
      punho.castShadow = true;
      mao.add(punho);
      cotovelo.add(mao);
      ombro.add(cotovelo);
      this.tronco.add(ombro);
      this.bracos[nome] = { ombro, cotovelo, mao, lado };
    }

    // cabeça
    this.pescoco = new THREE.Group();
    this.pescoco.position.y = 0.6;
    this.tronco.add(this.pescoco);
    const cabeca = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 16), pele);
    cabeca.position.y = 0.16;
    cabeca.castShadow = true;
    this.pescoco.add(cabeca);
    const cabelo = new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), cabeloMat);
    cabelo.position.set(0, 0.18, -0.015);
    cabelo.rotation.x = -0.35;
    this.pescoco.add(cabelo);
    const olho = mat('#1b1d22');
    for (const lado of [-1, 1]) {
      const o = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), olho);
      o.position.set(lado * 0.06, 0.18, 0.155);
      this.pescoco.add(o);
    }
    this.boca = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 12, Math.PI), mat('#7a2f2f'));
    this.boca.position.set(0, 0.1, 0.16);
    this.boca.rotation.z = Math.PI;
    this.pescoco.add(this.boca);

    if (agente.chefe) {
      // gravata
      const gravata = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.3, 4), mat('#c8102e'));
      gravata.position.set(0, 0.36, 0.14);
      gravata.rotation.set(-0.12, Math.PI / 4, Math.PI);
      this.tronco.add(gravata);
    }

    this.criarAderecos(agente.atividade);
  }

  criarAderecos(atividade) {
    const mao = this.bracos.dir.mao;
    this.aderecos = {};
    if (atividade === 'telefone') {
      const fone = new THREE.Group();
      fone.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.05), mat('#2a2d35')));
      fone.position.set(0.02, -0.04, 0.02);
      mao.add(fone);
      this.aderecos.telefone = fone;
    }
    if (atividade === 'ler') {
      const papel = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.005, 0.22), mat('#f4f1ea'));
      papel.position.set(0.2, -0.05, 0.04);
      mao.add(papel);
      this.aderecos.papel = papel;
    }
    if (atividade === 'desenhar' || atividade === 'quadro') {
      const caneta = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.008, 0.16, 8), mat(atividade === 'quadro' ? '#e5484d' : '#ffffff'));
      caneta.position.set(0, -0.06, 0.03);
      caneta.rotation.x = 0.6;
      mao.add(caneta);
      this.aderecos.caneta = caneta;
    }
  }

  // Pose-alvo a partir de estado/atividade. Ângulos em radianos.
  // ombroX negativo = levanta o braço para frente; abertura positiva = afasta do corpo.
  pose(estado, t) {
    const atv = this.agente.atividade;
    const p = {
      troncoX: 0.05, troncoY: 0, cabecaX: 0, cabecaY: 0,
      esq: { x: -0.5, abre: 0.05, cot: -0.7 },
      dir: { x: -0.5, abre: 0.05, cot: -0.7 },
      emPe: 0, local: 'mesa', boca: 0,
    };
    const ts = this.tempoNoEstado;

    if (estado === 'trabalhando') {
      if (atv === 'digitar') {
        p.troncoX = 0.14; p.cabecaX = 0.12;
        p.esq = { x: -0.62 + Math.sin(t * 17) * 0.05, abre: -0.12, cot: -1.0 };
        p.dir = { x: -0.62 + Math.sin(t * 17 + 2) * 0.05, abre: -0.12, cot: -1.0 };
        p.cabecaY = Math.sin(t * 0.7) * 0.08;
      } else if (atv === 'analisar') {
        p.troncoX = 0.1;
        p.dir = { x: -0.62 + Math.sin(t * 2.3) * 0.04, abre: 0.25 + Math.sin(t * 3.1) * 0.05, cot: -1.0 };
        // de tempos em tempos coça o queixo pensando
        const pensando = Math.sin(t * 0.4 + this.semente) > 0.6;
        p.esq = pensando ? { x: -1.0, abre: -0.35, cot: -2.2 } : { x: -0.55, abre: -0.1, cot: -1.0 };
        p.cabecaX = pensando ? 0.05 : 0.0;
        p.cabecaY = Math.sin(t * 0.9) * 0.15;
      } else if (atv === 'ler') {
        p.troncoX = 0.08; p.cabecaX = 0.4;
        p.dir = { x: -0.95, abre: -0.3, cot: -0.9 };
        const virando = (t + this.semente) % 5 < 0.6;
        p.esq = virando ? { x: -1.1, abre: -0.6, cot: -1.0 } : { x: -0.95, abre: -0.3, cot: -0.9 };
        p.cabecaY = Math.sin(t * 1.2) * 0.12;
      } else if (atv === 'telefone') {
        p.troncoY = Math.sin(t * 0.6) * 0.25;
        p.dir = { x: -1.4, abre: 0.15, cot: -2.4 };
        p.esq = { x: -0.7 + Math.sin(t * 2.5) * 0.25, abre: 0.15, cot: -0.9 + Math.sin(t * 3) * 0.3 };
        p.cabecaX = Math.sin(t * 3) * 0.06; p.cabecaY = -0.25;
        p.boca = Math.abs(Math.sin(t * 9));
      } else if (atv === 'desenhar') {
        p.troncoX = 0.16; p.cabecaX = 0.3;
        p.dir = { x: -0.62 + Math.sin(t * 3) * 0.07, abre: 0.0 + Math.cos(t * 3) * 0.07, cot: -1.0 };
        p.esq = { x: -0.5, abre: -0.15, cot: -1.0 };
      } else if (atv === 'quadro') {
        p.emPe = 1; p.local = 'quadro';
        p.troncoX = 0; p.cabecaX = -0.05;
        p.dir = { x: -2.0 + Math.sin(t * 4) * 0.12, abre: 0.25 + Math.cos(t * 2.3) * 0.15, cot: -0.5 };
        p.esq = { x: 0.05, abre: 0.08, cot: -0.2 };
        p.cabecaY = Math.sin(t * 2.3) * 0.15;
      }
    } else if (estado === 'aguardando') {
      // mão no queixo, batucando a mesa com a outra
      p.troncoX = 0.12; p.cabecaX = -0.05;
      p.dir = { x: -1.0, abre: -0.4, cot: -2.15 };
      p.esq = { x: -0.62 + Math.max(0, Math.sin(t * 8)) * 0.08, abre: -0.1, cot: -1.0 };
      p.cabecaY = Math.sin(t * 0.5) * 0.3;
    } else if (estado === 'erro') {
      // mãos no rosto, balançando a cabeça
      p.troncoX = 0.1;
      p.esq = { x: -1.4, abre: -0.25, cot: -2.0 };
      p.dir = { x: -1.4, abre: -0.25, cot: -2.0 };
      p.cabecaY = Math.sin(t * 6) * 0.3;
      p.boca = 1;
    } else if (estado === 'concluido') {
      if (ts < 3) {
        // comemora com os braços para cima
        const pulo = Math.abs(Math.sin(t * 8));
        p.troncoX = -0.1 * pulo;
        p.esq = { x: -2.9, abre: 0.35 + pulo * 0.2, cot: -0.2 };
        p.dir = { x: -2.9, abre: 0.35 + pulo * 0.2, cot: -0.2 };
      } else {
        // relaxa com as mãos atrás da cabeça
        p.troncoX = -0.18; p.cabecaX = -0.15;
        p.esq = { x: -2.6, abre: 0.9, cot: -2.3 };
        p.dir = { x: -2.6, abre: 0.9, cot: -2.3 };
      }
    } else {
      // ocioso: encosta, olha em volta e de vez em quando se espreguiça
      p.troncoX = -0.12;
      p.cabecaY = Math.sin(t * 0.3 + this.semente) * 0.6;
      p.esq = { x: -0.45, abre: -0.05, cot: -0.6 };
      p.dir = { x: -0.45, abre: -0.05, cot: -0.6 };
      if ((t + this.semente * 3) % 14 < 2) {
        p.esq = { x: -3.0, abre: 0.2, cot: 0 };
        p.dir = { x: -3.0, abre: 0.2, cot: 0 };
        p.cabecaX = -0.25;
      }
    }
    // gestos e atenção têm prioridade sobre a pose do estado
    if (this.gesto === 'apontar') {
      p.emPe = 1;
      p.dir = { x: -1.45 + Math.sin(t * 5) * 0.12, abre: 0.15, cot: -0.15 };
      p.esq = { x: -0.5 + Math.sin(t * 3) * 0.2, abre: 0.2, cot: -1.2 };
      p.troncoX = 0.02; p.cabecaX = 0.1; p.cabecaY = 0;
      p.boca = Math.abs(Math.sin(t * 9));
    } else if (this.gesto === 'anunciar') {
      p.emPe = 1;
      const g = Math.sin(t * 4);
      p.esq = { x: -2.2 + g * 0.3, abre: 0.6, cot: -0.4 };
      p.dir = { x: -2.2 - g * 0.3, abre: 0.6, cot: -0.4 };
      p.troncoX = -0.05; p.cabecaX = -0.1; p.cabecaY = Math.sin(t * 1.5) * 0.4;
      p.boca = Math.abs(Math.sin(t * 9));
    } else if (t < this.atencaoAte && !p.emPe) {
      // vira na cadeira para ouvir o chefe
      p.troncoY = this.atencaoGiro; p.cabecaY = this.atencaoGiro * 0.4; p.cabecaX = -0.2;
      p.esq = { x: -0.45, abre: -0.05, cot: -0.6 };
      p.dir = { x: -0.45, abre: -0.05, cot: -0.6 };
      if (t > this.atencaoAte - 1) { p.dir = { x: -1.6, abre: 0.3, cot: -1.6 }; } // "positivo!"
    }
    return p;
  }

  // Anda pelos pontos dados e, ao chegar, olha para `rotFinal`.
  irPor(pontos, rotFinal = null) {
    this.rota = pontos.map((v) => v.clone());
    this.posto = this.rota.length ? this.rota[this.rota.length - 1].clone() : null; // onde fica ao terminar
    this.rotFinal = rotFinal;
  }

  chegou() { return this.rota.length === 0 && this.parado; }

  atualizar(dt, t, estado) {
    if (estado !== this.estadoAnterior) { this.estadoAnterior = estado; this.tempoNoEstado = 0; }
    this.tempoNoEstado += dt;

    const p = this.pose(estado, t);
    const k = 1 - Math.exp(-dt * 9);
    const L = (a, b) => a + (b - a) * k;

    // deslocamento: levanta, anda pela rota (ou até o quadro), gira e senta ao voltar
    const naRota = this.rota.length > 0;
    const destino = naRota ? this.rota[0] : this.posto ?? (p.local === 'quadro' ? POS_QUADRO : new THREE.Vector3());
    const dist = this.raiz.position.distanceTo(destino);
    if (naRota && dist < 0.05) this.rota.shift();
    const andando = dist > 0.03;
    this.parado = !andando;
    const querEmPe = p.emPe || andando || this.rota.length || this.rotFinal !== null ? 1 : 0;
    this.emPe = L(this.emPe, querEmPe);
    let rotAlvo = this.rotFinal ?? (p.local === 'quadro' ? Math.PI : 0);
    if (this.emPe > 0.85 && andando) {
      const dir = destino.clone().sub(this.raiz.position).normalize();
      this.raiz.position.add(dir.multiplyScalar(Math.min(dist, dt * this.velocidade)));
      if (dist > 0.25) rotAlvo = Math.atan2(dir.x, dir.z); // olha para onde anda
    }
    if (this.emPe > 0.5) {
      // gira pelo caminho mais curto
      let d = rotAlvo - this.raiz.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.raiz.rotation.y += d * k;
    }

    this.quadril.position.y = ALT_SENTADO + (ALT_EM_PE - ALT_SENTADO) * this.emPe;
    const balanco = andando && this.emPe > 0.85 ? Math.sin(t * 9) : 0;
    this.pernas.forEach(({ coxa, joelho }, i) => {
      const lado = i ? 1 : -1;
      const coxaAlvo = -Math.PI / 2 * (1 - this.emPe) + balanco * 0.45 * lado;
      const joelhoAlvo = Math.PI / 2 * (1 - this.emPe) + Math.max(0, -balanco * lado) * 0.6;
      coxa.rotation.x = L(coxa.rotation.x, coxaAlvo);
      joelho.rotation.x = L(joelho.rotation.x, joelhoAlvo);
    });

    if (balanco) {
      p.esq = { x: balanco * 0.4, abre: 0.08, cot: -0.2 };
      p.dir = { x: -balanco * 0.4, abre: 0.08, cot: -0.2 };
      p.troncoX = 0.03;
    }

    this.tronco.rotation.x = L(this.tronco.rotation.x, p.troncoX);
    this.tronco.rotation.y = L(this.tronco.rotation.y, p.troncoY);
    this.pescoco.rotation.x = L(this.pescoco.rotation.x, p.cabecaX);
    this.pescoco.rotation.y = L(this.pescoco.rotation.y, p.cabecaY);
    for (const nome of ['esq', 'dir']) {
      const b = this.bracos[nome];
      const alvo = p[nome];
      b.ombro.rotation.x = L(b.ombro.rotation.x, alvo.x);
      b.ombro.rotation.z = L(b.ombro.rotation.z, alvo.abre * b.lado);
      b.cotovelo.rotation.x = L(b.cotovelo.rotation.x, alvo.cot);
    }
    this.boca.scale.y = L(this.boca.scale.y, 1 + p.boca * 0.6);
    this.boca.rotation.z = estado === 'erro' ? 0 : Math.PI; // sorriso ↔ boca triste

    const trabalhando = estado === 'trabalhando';
    for (const [nome, obj] of Object.entries(this.aderecos)) {
      obj.visible = trabalhando || (nome === 'caneta' && this.agente.atividade === 'desenhar');
    }
    return { escrevendoNoQuadro: trabalhando && p.local === 'quadro' && !andando };
  }
}
