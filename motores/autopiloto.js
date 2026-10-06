// Piloto automático do Tech Lead: você não precisa ficar dando ordens.
//
// De tempos em tempos, para cada projeto (cliente cadastrado), o Tech Lead
// recebe a ficha, a documentação do projeto, as últimas entregas e o que está
// pendente, e decide sozinho o próximo passo: cria o plano e o time executa
// (o supervisor acompanha até a entrega final). Ele não age num projeto quando:
//   - já há trabalho em andamento nele;
//   - da última vez disse que não havia o que fazer e nada novo aconteceu desde então;
//   - o limite de planos do dia foi atingido, ou está fora do horário escolhido.
// Fica em DADOS_DIR/autopiloto.json e liga/desliga na janela 🗓 Rotinas.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const FUSO = process.env.TZ || 'America/Sao_Paulo';
const PADRAO = { ativo: true, intervaloMin: 60, maxPlanosDia: 8, inicio: 8, fim: 20 };
const ESPERA_SEM_NADA_MS = 24 * 3600 * 1000; // "nada a fazer": olha de novo em 1 dia mesmo sem novidade

const horaLocal = () => Number(new Date().toLocaleString('en-GB', { timeZone: FUSO, hour: '2-digit', hour12: false }));
const diaLocal = () => new Date().toLocaleDateString('sv-SE', { timeZone: FUSO });

export function criarAutopiloto({ dadosDir, ordens, equipe, clientes, criarOrdem, docDe, entregasDe, planoAberto, avisar }) {
  const arquivo = join(dadosDir, 'autopiloto.json');
  let cfg = { ...PADRAO };
  let estado = { dia: '', planosHoje: 0, projetos: {} }; // projetos: id → { ultimaVez, ordemId }
  let relogio = null;

  async function carregar() {
    try {
      const salvo = JSON.parse(await readFile(arquivo, 'utf8'));
      cfg = { ...PADRAO, ...(salvo.cfg || {}) };
      estado = { ...estado, ...(salvo.estado || {}) };
    } catch { /* primeira vez: padrão (ligado) */ }
  }

  async function gravar() {
    await mkdir(dadosDir, { recursive: true });
    await writeFile(`${arquivo}.tmp`, JSON.stringify({ cfg, estado }, null, 2));
    await rename(`${arquivo}.tmp`, arquivo);
  }

  const tech = () => Object.entries(equipe()).find(([, c]) => c.delegar)?.[0] || null;
  const dentroDoHorario = () => {
    const h = horaLocal();
    return cfg.inicio <= cfg.fim ? h >= cfg.inicio && h < cfg.fim : h >= cfg.inicio || h < cfg.fim;
  };

  // Houve algo novo no projeto desde `desde`? (ordem nova que não é do piloto, entrega, ficha alterada)
  function novidadeDesde(projeto, desde) {
    const t = Date.parse(desde || 0);
    if (Date.parse(clientes.listar().find((c) => c.id === projeto)?.atualizadoEm || 0) > t) return true;
    return ordens.some((o) => o.cliente === projeto && !o.origem?.autopiloto && !o.pai && Date.parse(o.criadaEm) > t);
  }

  // Em que pé está o projeto: 'ocupado' (trabalho em andamento) | 'parado' (pode decidir) | 'esperando'
  function situacao(projeto) {
    // trabalho em andamento nas últimas 12 h (algo travado há mais tempo não segura o projeto para sempre)
    const recentes = ordens.filter((o) => o.cliente === projeto && Date.now() - Date.parse(o.criadaEm) < 12 * 3600 * 1000);
    if (recentes.some((o) => ['pendente', 'entregue', 'falhou'].includes(o.estado) && !o.desistida)) return 'ocupado';
    if (planoAberto(projeto)) return 'ocupado';
    const p = estado.projetos[projeto];
    if (!p) return 'parado';
    if (Date.now() - Date.parse(p.ultimaVez) < cfg.intervaloMin * 60000) return 'esperando';
    // da última vez não havia o que fazer: só volta com novidade (ou depois de um dia)
    const ultima = ordens.find((o) => o.id === p.ordemId);
    const semTarefas = ultima && ultima.estado === 'respondida' && !ordens.some((o) => o.pai === ultima.id);
    if (semTarefas && !novidadeDesde(projeto, p.ultimaVez) && Date.now() - Date.parse(p.ultimaVez) < ESPERA_SEM_NADA_MS) return 'esperando';
    return 'parado';
  }

  function material(projeto, nome) {
    const doc = docDe(projeto) || '(sem documentação ainda)';
    const ultimas = entregasDe(projeto).slice(0, 12)
      .map((e) => `- ${e.em.slice(0, 16).replace('T', ' ')} · ${e.agente}: ${e.pedido.slice(0, 160)} → ${String(e.trecho || e.resumo || '').slice(0, 300).replace(/\s+/g, ' ')}`).join('\n') || '(nenhuma entrega ainda)';
    const problemas = ordens.filter((o) => o.cliente === projeto && (o.desistida || o.estado === 'falhou'))
      .slice(-8).map((o) => `- "${o.texto.slice(0, 120)}" (${o.motivoDesistencia || 'com erro'})`).join('\n') || '(nenhum)';
    return `VOCÊ ESTÁ NO PILOTO AUTOMÁTICO. O chefe não vai dar ordens: decida sozinho, sem pedir permissão, o próximo passo do projeto "${nome}" e já distribua as tarefas.

Como decidir:
- Compare o escopo da ficha do cliente com o que já foi entregue e documentado. O objetivo é levar o projeto até ficar pronto para uso (requisitos, telas, front-end, back-end, testes, deploy e documentação).
- Crie no máximo 4 tarefas, as próximas na ordem certa (o que depende de outra coisa espera a próxima rodada). Cada tarefa precisa de todo o contexto para o especialista trabalhar sozinho.
- Não repita o que já foi entregue: continue de onde parou, corrija o que deu errado e o que o chefe avaliou mal.
- Se o projeto estiver pronto, ou se faltar uma informação que só o cliente pode dar, NÃO crie tarefas: na "resposta", diga em poucas linhas o que falta e o que precisa do chefe.

DOCUMENTAÇÃO DO PROJETO:
${doc.slice(0, 20000)}

ÚLTIMAS ENTREGAS:
${ultimas}

PROBLEMAS EM ABERTO:
${problemas}`;
  }

  function conferir() {
    if (!cfg.ativo || !dentroDoHorario()) return;
    const orq = tech();
    if (!orq) return;
    if (estado.dia !== diaLocal()) { estado.dia = diaLocal(); estado.planosHoje = 0; }
    for (const c of clientes.listar()) {
      if (estado.planosHoje >= cfg.maxPlanosDia) return;
      if (situacao(c.id) !== 'parado') continue;
      const ordem = criarOrdem({
        para: orq, de: 'chefe', cliente: c.id, origem: { autopiloto: true },
        texto: `🤖 Piloto automático: próximo passo do projeto ${c.nome}`,
        anexo: material(c.id, c.nome),
      });
      estado.projetos[c.id] = { ultimaVez: new Date().toISOString(), ordemId: ordem.id };
      estado.planosHoje++;
      console.log(`[piloto automático] ${c.nome}: o Tech Lead está decidindo o próximo passo (${estado.planosHoje}/${cfg.maxPlanosDia} hoje)`);
      if (estado.planosHoje === cfg.maxPlanosDia) avisar?.(`🤖 Piloto automático: limite de ${cfg.maxPlanosDia} planos por dia atingido. Volta amanhã (ou aumente o limite em 🗓 Rotinas).`);
      gravar().catch(() => {});
      return; // um projeto por vez: o próximo entra na próxima conferência
    }
  }

  function ver() {
    return {
      ...cfg,
      planosHoje: estado.dia === diaLocal() ? estado.planosHoje : 0,
      projetos: clientes.listar().map((c) => ({ id: c.id, nome: c.nome, situacao: situacao(c.id), ultimaVez: estado.projetos[c.id]?.ultimaVez || null })),
    };
  }

  async function configurar(dados) {
    const n = (v, min, max, padrao) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : padrao);
    cfg = {
      ativo: Boolean(dados.ativo),
      intervaloMin: n(dados.intervaloMin, 15, 24 * 60, cfg.intervaloMin),
      maxPlanosDia: n(dados.maxPlanosDia, 1, 100, cfg.maxPlanosDia),
      inicio: n(dados.inicio, 0, 23, cfg.inicio),
      fim: n(dados.fim, 0, 24, cfg.fim),
    };
    await gravar();
    return ver();
  }

  function iniciar() {
    relogio ??= setInterval(conferir, Number(process.env.AUTOPILOTO_INTERVALO_MS) || 60000);
    relogio.unref?.();
    setTimeout(conferir, 15000).unref?.(); // primeira olhada logo depois de subir
  }

  return { carregar, iniciar, conferir, ver, configurar };
}
