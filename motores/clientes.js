// Fichas de clientes: o que os agentes precisam saber do projeto para acertar de
// primeira (escopo, usuários, stack, integrações, regras de negócio). Ficam em
// DADOS_DIR/clientes.json e vão junto nas instruções de toda ordem do cliente.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const CAMPOS_CLIENTE = {
  nome: { rotulo: 'Cliente', max: 80 },
  nicho: { rotulo: 'Segmento', max: 200 },
  produtos: { rotulo: 'Escopo e módulos', max: 2000 },
  publico: { rotulo: 'Usuários do sistema', max: 1000 },
  tom: { rotulo: 'Stack e padrões técnicos', max: 1000 },
  observacoes: { rotulo: 'Integrações e infraestrutura', max: 2000 },
  evitar: { rotulo: 'Regras de negócio e restrições', max: 1000 },
  exemplos: { rotulo: 'Referências', max: 4000 },
};

export function slugCliente(texto) {
  return String(texto).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export function criarClientes({ dadosDir }) {
  const arquivo = join(dadosDir, 'clientes.json');
  let clientes = {}; // id → ficha

  async function carregar() {
    try { clientes = JSON.parse(await readFile(arquivo, 'utf8')); } catch { clientes = {}; }
  }

  async function gravar() {
    await mkdir(dadosDir, { recursive: true });
    await writeFile(`${arquivo}.tmp`, JSON.stringify(clientes, null, 2));
    await rename(`${arquivo}.tmp`, arquivo);
  }

  function listar() {
    return Object.entries(clientes).map(([id, c]) => ({ id, ...c })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  const existe = (id) => Boolean(id && clientes[id]);
  const nomeDe = (id) => clientes[id]?.nome || id;

  // Cria (sem id) ou atualiza (com id). O id nasce do nome e não muda depois.
  async function salvar(id, dados) {
    const ficha = {};
    for (const [campo, { max }] of Object.entries(CAMPOS_CLIENTE)) {
      const valor = typeof dados[campo] === 'string' ? dados[campo].trim().slice(0, max) : '';
      if (valor) ficha[campo] = valor;
    }
    if (!ficha.nome) throw new Error('informe o nome do cliente');
    if (!id) {
      id = slugCliente(ficha.nome);
      if (!id) throw new Error('nome inválido');
      if (clientes[id]) throw new Error(`já existe um cliente "${clientes[id].nome}"`);
    } else if (!clientes[id]) throw new Error('cliente não encontrado');
    clientes[id] = { ...ficha, atualizadoEm: new Date().toISOString() };
    await gravar();
    return { id, ...clientes[id] };
  }

  async function remover(id) {
    if (!clientes[id]) return false;
    delete clientes[id];
    await gravar();
    return true;
  }

  // Texto da ficha para as instruções do agente.
  function ficha(id) {
    const c = clientes[id];
    if (!c) return '';
    return Object.entries(CAMPOS_CLIENTE)
      .filter(([campo]) => c[campo])
      .map(([campo, { rotulo }]) => (c[campo].includes('\n') ? `${rotulo}:\n${c[campo]}` : `${rotulo}: ${c[campo]}`))
      .join('\n');
  }

  // Acha o cliente por id ou pelo nome escrito de qualquer jeito ("Padaria do Zé", "padaria-do-ze").
  function achar(texto) {
    const s = slugCliente(texto);
    return clientes[s] ? s : Object.keys(clientes).find((id) => slugCliente(clientes[id].nome) === s) || null;
  }

  return { carregar, listar, salvar, remover, ficha, existe, nomeDe, achar };
}
