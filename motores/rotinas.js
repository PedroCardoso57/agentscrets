// Rotinas: ordens que saem sozinhas num horário (ex.: toda segunda às 8h, grade
// da semana). Ficam em DADOS_DIR/rotinas.json; o relógio confere a cada 20 s.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FUSO = process.env.TZ || 'America/Sao_Paulo';
export const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// Agora no fuso do escritório: { data: 'AAAA-MM-DD', hora: 'HH:MM', diaSemana: 0-6, diaMes: 1-31 }
function agora(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return {
    data: `${p.year}-${p.month}-${p.day}`,
    hora: `${p.hour}:${p.minute}`,
    diaSemana: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    diaMes: Number(p.day),
  };
}

// A rotina deve rodar neste dia? (semanal: dias da semana; mensal: dia do mês)
function cai(r, a) {
  return r.tipo === 'mensal' ? r.diaMes === a.diaMes : r.dias.includes(a.diaSemana);
}

// Data de ontem no fuso do escritório ('AAAA-MM-DD').
export function ontem() {
  return agora(new Date(Date.now() - 24 * 3600 * 1000)).data;
}

export function descreverQuando(r) {
  if (r.tipo === 'mensal') return `todo dia ${r.diaMes} às ${r.hora}`;
  if (r.dias.length === 7) return `todo dia às ${r.hora}`;
  if (r.dias.join() === '1,2,3,4,5') return `de segunda a sexta às ${r.hora}`;
  return `${r.dias.map((d) => DIAS[d]).join(', ')} às ${r.hora}`;
}

export function criarRotinas({ dadosDir, disparar }) {
  const arquivo = join(dadosDir, 'rotinas.json');
  let rotinas = [];
  let relogio = null;

  async function carregar() {
    try { rotinas = JSON.parse(await readFile(arquivo, 'utf8')); } catch { rotinas = []; }
  }

  async function gravar() {
    await mkdir(dadosDir, { recursive: true });
    await writeFile(`${arquivo}.tmp`, JSON.stringify(rotinas, null, 2));
    await rename(`${arquivo}.tmp`, arquivo);
  }

  function validar(dados) {
    const r = {
      nome: typeof dados.nome === 'string' ? dados.nome.trim().slice(0, 80) : '',
      texto: typeof dados.texto === 'string' ? dados.texto.trim().slice(0, 2000) : '',
      para: typeof dados.para === 'string' && dados.para ? dados.para : 'auto',
      cliente: typeof dados.cliente === 'string' && dados.cliente ? dados.cliente : '',
      tipo: dados.tipo === 'mensal' ? 'mensal' : 'semanal',
      hora: typeof dados.hora === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(dados.hora) ? dados.hora : null,
      ativa: dados.ativa !== false,
      resumoOntem: Boolean(dados.resumoOntem), // junta o que a equipe fez ontem e manda junto
    };
    if (!r.texto) throw new Error('escreva a ordem da rotina');
    if (!r.hora) throw new Error('hora inválida (use HH:MM)');
    if (r.tipo === 'mensal') {
      r.diaMes = Number(dados.diaMes);
      if (!Number.isInteger(r.diaMes) || r.diaMes < 1 || r.diaMes > 28) throw new Error('dia do mês deve ser de 1 a 28');
    } else {
      r.dias = [...new Set((Array.isArray(dados.dias) ? dados.dias : []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
      if (!r.dias.length) throw new Error('escolha pelo menos um dia da semana');
    }
    if (!r.nome) r.nome = r.texto.slice(0, 50);
    return r;
  }

  const listar = () => rotinas.map((r) => ({ ...r, quando: descreverQuando(r) }));

  async function salvar(id, dados) {
    const r = validar(dados);
    if (id) {
      const i = rotinas.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('rotina não encontrada');
      rotinas[i] = { ...rotinas[i], ...r, dias: r.dias, diaMes: r.diaMes };
    } else {
      rotinas.push({ id: randomUUID().slice(0, 8), criadaEm: new Date().toISOString(), ...r });
    }
    await gravar();
    return listar().find((x) => x.id === (id || rotinas.at(-1).id));
  }

  async function remover(id) {
    const antes = rotinas.length;
    rotinas = rotinas.filter((r) => r.id !== id);
    if (rotinas.length !== antes) await gravar();
    return rotinas.length !== antes;
  }

  async function rodar(r, a = agora()) {
    r.ultimaEm = `${a.data} ${a.hora}`;
    await gravar();
    try {
      const ordem = await disparar(r);
      r.ultimaOrdem = ordem?.id;
      r.ultimoErro = undefined;
    } catch (erro) {
      r.ultimoErro = erro.message.slice(0, 200);
      console.error(`[rotina ${r.nome}]`, erro.message);
    }
    await gravar();
  }

  async function rodarAgora(id) {
    const r = rotinas.find((x) => x.id === id);
    if (!r) throw new Error('rotina não encontrada');
    await rodar(r);
    return listar().find((x) => x.id === id);
  }

  // Confere o relógio: roda cada rotina no minuto marcado (uma vez por dia, mesmo se o servidor reiniciar).
  function conferir() {
    const a = agora();
    for (const r of rotinas) {
      if (!r.ativa || r.hora !== a.hora || !cai(r, a) || r.ultimaEm === `${a.data} ${a.hora}`) continue;
      rodar(r, a);
    }
  }

  function iniciar() {
    relogio ??= setInterval(conferir, 20000);
    relogio.unref?.();
  }

  // O time mudou de ids (ex.: redator → documentador): as rotinas acompanham.
  async function renomearAgentes(mapa) {
    let mudou = false;
    for (const r of rotinas) if (mapa[r.para]) { r.para = mapa[r.para]; mudou = true; }
    if (mudou) await gravar();
  }

  return { carregar, listar, salvar, remover, rodarAgora, iniciar, conferir, renomearAgentes };
}
