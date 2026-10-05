import * as THREE from 'three';
import { criarEstacao, posicaoChefe, CORREDOR_X } from './escritorio.js';
import { Boneco } from './boneco.js';

// O seu bonequinho. Recebe ordens (da barra de comando ou da API), vai até a
// mesa do agente — ou para a frente da equipe, se a ordem for para todos —,
// fala a ordem, espera o "positivo" e volta para a mesa dele.

const TEMPO_FALANDO = 3.5;

export class Chefe {
  constructor(config) {
    this.agente = { ...config, atividade: 'digitar', chefe: true };
    this.grupo = new THREE.Group();
    this.estacao = criarEstacao(this.agente);
    this.boneco = new Boneco(this.agente);
    this.boneco.velocidade = 2.4; // chefe com pressa
    this.grupo.add(this.estacao.grupo, this.boneco.raiz);
    this.fila = [];
    this.atual = null;
    this.digitando = false;
  }

  posicionar(totalAgentes) {
    const { x, z, rot } = posicaoChefe(totalAgentes);
    this.grupo.position.set(x, 0, z);
    this.grupo.rotation.y = rot;
    this.grupo.updateMatrixWorld(true);
    this.boneco.raiz.position.set(0, 0, 0);
    this.boneco.raiz.rotation.y = 0;
    this.boneco.rota = [];
    this.boneco.posto = null;
    this.boneco.rotFinal = null;
    this.boneco.gesto = null;
    this.atual = null;
  }

  // alvos: lista de estações ({ grupo, boneco }) que vão ouvir a ordem.
  // todos: se true, o chefe faz um anúncio para a equipe inteira.
  // eventos: { aoFalar(texto), aoTerminar() }
  darOrdem({ texto, alvos, todos, ...eventos }) {
    this.fila.push({ texto, alvos, todos, eventos });
  }

  ocupado() { return Boolean(this.atual) || this.fila.length > 0; }

  // Pontos (no mundo) da cadeira do chefe até a frente da equipe.
  saida() {
    const p = (x, z) => this.grupo.localToWorld(new THREE.Vector3(x, 0, z));
    return [p(-1.3, 0), p(-1.3, 1.5)]; // contorna a mesa pela lateral
  }

  rotaAte(destino) {
    const pontos = this.saida();
    const frente = pontos[pontos.length - 1];
    // a fileira de frente para o chefe dá para alcançar em linha reta;
    // as outras, pelo corredor lateral, sem atravessar as mesas
    if (destino.z < frente.z - 1.2) {
      const lado = destino.x >= 0 ? CORREDOR_X : -CORREDOR_X;
      pontos.push(new THREE.Vector3(lado, 0, frente.z), new THREE.Vector3(lado, 0, destino.z));
    }
    pontos.push(destino);
    return pontos;
  }

  comecar(ordem) {
    this.atual = ordem;
    let destino, olhar;
    if (ordem.todos || ordem.alvos.length !== 1) {
      destino = this.grupo.localToWorld(new THREE.Vector3(0, 0, 1.7));
      olhar = this.grupo.rotation.y; // de frente para a equipe
    } else {
      const { grupo } = ordem.alvos[0];
      destino = grupo.localToWorld(new THREE.Vector3(-0.6, 0, -0.8)); // atrás e ao lado da cadeira
      const agente = grupo.localToWorld(new THREE.Vector3(0, 0, 0));
      olhar = Math.atan2(agente.x - destino.x, agente.z - destino.z);
    }
    ordem.rotaMundo = this.rotaAte(destino);
    ordem.destino = destino;
    this.boneco.irPor(ordem.rotaMundo.map((v) => this.grupo.worldToLocal(v.clone())), olhar - this.grupo.rotation.y);
    ordem.fase = 'indo';
  }

  atualizar(dt, t) {
    if (!this.atual && this.fila.length) this.comecar(this.fila.shift());
    const o = this.atual;
    if (o) {
      if (o.fase === 'indo' && this.boneco.chegou() && this.boneco.emPe > 0.9) {
        o.fase = 'falando';
        o.tempo = 0;
        this.boneco.gesto = o.todos || o.alvos.length !== 1 ? 'anunciar' : 'apontar';
        // os agentes viram para ouvir
        for (const alvo of o.alvos) {
          const local = alvo.grupo.worldToLocal(o.destino.clone());
          const giro = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -1.3, 1.3);
          alvo.boneco.atencaoAte = t + TEMPO_FALANDO + 0.5;
          alvo.boneco.atencaoGiro = giro;
        }
        o.eventos.aoFalar?.(o.texto);
      } else if (o.fase === 'falando') {
        o.tempo += dt;
        if (o.tempo > TEMPO_FALANDO) {
          this.boneco.gesto = null;
          const volta = o.rotaMundo.slice(0, -1).reverse().map((v) => this.grupo.worldToLocal(v.clone()));
          this.boneco.irPor([...volta, new THREE.Vector3()], null);
          o.fase = 'voltando';
          o.eventos.aoTerminar?.();
        }
      } else if (o.fase === 'voltando' && this.boneco.chegou()) {
        this.atual = null;
      }
    }
    const estado = !o && this.digitando ? 'trabalhando' : 'ocioso';
    this.boneco.atualizar(dt, t, estado);
  }
}
