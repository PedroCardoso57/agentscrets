import * as THREE from 'three';
import { CORREDOR_X } from './escritorio.js';

// Vida no escritório: quem fica sem trabalho um tempo levanta e faz uma pausa —
// pega água ou café (às vezes chamando um colega para conversar), senta no sofá,
// olha a janela, folheia um livro na estante ou senta à mesa de reunião com
// outros. Chegou trabalho? Volta na hora para a mesa.

const MAX_FORA = 3;               // no máximo três pessoas em pausa ao mesmo tempo
// segundos parado na mesa antes de pensar em levantar (?pausas=rapido na URL encurta, para ver logo)
const RAPIDO = typeof location !== 'undefined' && new URLSearchParams(location.search).has('pausas');
const OCIOSO_MIN = RAPIDO ? 2 : 25;
const OCIOSO_MAX = RAPIDO ? 5 : 80;

const ATIVIDADES = [
  // ponto da sala, gesto lá, quantos vão, peso (chance), copo na mão
  { nome: 'água', ponto: 'copa', gesto: 'beber', pessoas: [1, 2], peso: 3, copo: true },
  { nome: 'café', ponto: 'cafe', gesto: 'beber', pessoas: [1, 2], peso: 3, copo: true, depois: 'mesaAlta' },
  { nome: 'sofá', ponto: 'sofa', gesto: 'relaxar', pessoas: [1, 2], peso: 2 },
  { nome: 'janela', ponto: 'janela', gesto: 'olhar', pessoas: [1, 1], peso: 1 },
  { nome: 'estante', ponto: 'estante', gesto: 'folhear', pessoas: [1, 1], peso: 1 },
  { nome: 'reunião', ponto: 'reuniao', gesto: 'conversar', pessoas: [2, 3], peso: 2 },
];

const PAPO = [
  'Café?', 'Bora!', 'Viu o deploy de ontem?', 'O QA achou mais um bug 😅', 'Esse cliente pediu mais uma tela…',
  'Já subiu pra produção?', 'Qual stack você usaria?', 'Preciso de 5 minutos', 'Reunião às 15h?', 'Tá rodando liso',
  'Testou no celular?', 'Hoje o Tech Lead tá inspirado', 'Faltou só o README', 'Vou refatorar aquilo', 'Que calor hoje',
];

export class Vida {
  constructor({ estacoes, falar }) {
    this.estacoes = estacoes; // id → { grupo, boneco, estado, agente }
    this.falar = falar;       // (id, texto) → mostra no balão do agente
    this.pontos = null;       // pontos da sala (no mundo)
    this.agentes = new Map(); // id → { fase, ocioso, limite, rotaMundo, atividade, ate, falaEm, grupo }
  }

  definirSala(sala) {
    this.pontos = sala.pontos;
    this.agentes.clear(); // a sala foi refeita: todo mundo começa na mesa
  }

  estado(id) {
    if (!this.agentes.has(id)) this.agentes.set(id, { fase: 'mesa', ocioso: 0, limite: this.sorteio(OCIOSO_MIN, OCIOSO_MAX) });
    return this.agentes.get(id);
  }

  sorteio(a, b) { return a + Math.random() * (b - a); }

  // Caminho (no mundo) da cadeira até um ponto, sem atravessar as mesas:
  // sai por trás da cadeira, vai até o corredor lateral e segue até o destino.
  caminho(e, destino) {
    const atras = e.grupo.localToWorld(new THREE.Vector3(0, 0, -0.95));
    const lado = destino.x >= 0 ? CORREDOR_X : -CORREDOR_X;
    return [atras, new THREE.Vector3(lado, 0, atras.z), new THREE.Vector3(lado, 0, destino.z), destino.clone()];
  }

  local(e, pontos) { return pontos.map((v) => e.grupo.worldToLocal(v.clone())); }

  sair(id, atividade, vaga, grupo) {
    const e = this.estacoes.get(id);
    const s = this.estado(id);
    s.rotaMundo = this.caminho(e, vaga.pos);
    e.boneco.sentarNoDestino = Boolean(vaga.sentar);
    e.boneco.irPor(this.local(e, s.rotaMundo), vaga.rot - e.grupo.rotation.y);
    e.boneco.comCopo = false;
    Object.assign(s, { fase: 'indo', atividade, vaga, grupo, ate: 0, falaEm: 0 });
  }

  voltar(id) {
    const e = this.estacoes.get(id);
    const s = this.estado(id);
    if (!e || s.fase === 'mesa' || s.fase === 'voltando') return;
    e.boneco.gesto = null;
    e.boneco.sentarNoDestino = false;
    const volta = [...s.rotaMundo].reverse().slice(1); // do ponto atual de volta para trás da cadeira
    e.boneco.irPor([...this.local(e, volta), new THREE.Vector3()], null);
    s.fase = 'voltando';
  }

  // Escolhe uma pausa para quem está parado há tempo (e chama colegas, se for em grupo).
  comecarPausa(id, livres) {
    const fora = [...this.agentes.values()].filter((s) => s.fase !== 'mesa').length;
    if (fora >= MAX_FORA) return false;
    const opcoes = ATIVIDADES.filter((a) => this.pontos[a.ponto]?.length);
    let sorteio = Math.random() * opcoes.reduce((t, a) => t + a.peso, 0);
    const atividade = opcoes.find((a) => (sorteio -= a.peso) < 0) || opcoes[0];
    const [min, max] = atividade.pessoas;
    const vagas = this.pontos[atividade.ponto];
    const quantos = Math.min(max, vagas.length, MAX_FORA - fora, 1 + livres.length);
    if (quantos < min) return false;
    const grupo = [id, ...livres.sort(() => Math.random() - 0.5).slice(0, quantos - 1)];
    // a vaga de cada um (em reunião, cadeiras aleatórias; na copa, lado a lado)
    const ordemVagas = atividade.ponto === 'reuniao' ? [...vagas].sort(() => Math.random() - 0.5) : vagas;
    grupo.forEach((membro, i) => this.sair(membro, atividade, ordemVagas[i], grupo));
    return true;
  }

  atualizar(dt, t, pausado) {
    if (!this.pontos || pausado) return;
    const livres = [];
    for (const [id, e] of this.estacoes) {
      const s = this.estado(id);
      if (s.fase === 'mesa' && e.estado === 'ocioso' && !e.boneco.rota.length) {
        s.ocioso += dt;
        if (s.ocioso > (RAPIDO ? 1 : 10)) livres.push(id);
      } else if (s.fase === 'mesa') {
        s.ocioso = 0;
      }
    }

    for (const [id, e] of this.estacoes) {
      const s = this.estado(id);
      // chegou trabalho: larga tudo e volta para a mesa
      if (s.fase !== 'mesa' && s.fase !== 'voltando' && e.estado !== 'ocioso') { this.voltar(id); continue; }

      if (s.fase === 'mesa') {
        if (s.ocioso > s.limite && livres.includes(id)) {
          s.limite = this.sorteio(OCIOSO_MIN, OCIOSO_MAX);
          s.ocioso = 0;
          this.comecarPausa(id, livres.filter((x) => x !== id && this.estado(x).fase === 'mesa'));
        }
      } else if (s.fase === 'indo' && e.boneco.chegou()) {
        // chegou: faz a pausa por um tempo (em grupo, conversam)
        s.fase = 'pausa';
        s.ate = t + this.sorteio(14, 30);
        const emGrupo = s.grupo.length > 1;
        e.boneco.comCopo = Boolean(s.atividade.copo);
        e.boneco.gesto = emGrupo && s.atividade.gesto !== 'relaxar' ? 'conversar' : s.atividade.gesto;
        s.falaEm = t + this.sorteio(1, 4);
      } else if (s.fase === 'pausa') {
        if (s.grupo.length > 1 && t > s.falaEm) {
          this.falar(id, PAPO[Math.floor(Math.random() * PAPO.length)]);
          s.falaEm = t + this.sorteio(5, 11);
        }
        if (t > s.ate) {
          // café tomado: às vezes vão para a mesa alta continuar a conversa
          if (s.atividade.depois && s.grupo[0] === id && Math.random() < 0.6) {
            const vagas = this.pontos[s.atividade.depois];
            const proxima = { ...s.atividade, ponto: s.atividade.depois, depois: null };
            s.grupo.forEach((membro, i) => {
              const m = this.estado(membro);
              const em = this.estacoes.get(membro);
              if (m.fase !== 'pausa' || !vagas[i]) return;
              em.boneco.gesto = null;
              m.rotaMundo = [...m.rotaMundo, vagas[i].pos.clone()];
              em.boneco.irPor([vagas[i].pos].map((v) => em.grupo.worldToLocal(v.clone())), vagas[i].rot - em.grupo.rotation.y);
              Object.assign(m, { fase: 'indo', atividade: proxima, vaga: vagas[i] });
            });
          } else {
            for (const membro of s.grupo) if (this.estado(membro).fase === 'pausa') this.voltar(membro);
          }
        }
      } else if (s.fase === 'voltando' && e.boneco.chegou()) {
        e.boneco.posto = null; // senta na cadeira (ou vai ao quadro, se for trabalhar)
        e.boneco.comCopo = false;
        s.fase = 'mesa';
        s.ocioso = 0;
      }
    }
  }
}
