// Supervisor: ninguém larga tarefa pela metade.
//
// - Tarefa com erro ou interrompida (ex.: limite da IA, chave errada, servidor
//   reiniciou) é tentada de novo sozinha, com espera crescente.
// - Consertou o agente em ⚙ Equipe? As tarefas paradas dele voltam na hora.
// - Esgotou as tentativas, ou o agente saiu da equipe: o Orquestrador recebe a
//   tarefa de volta para passar a outro agente (ou o chefe é avisado, se a
//   ordem era dele e direta).
// - O Orquestrador acompanha o plano até o fim e, quando todas as tarefas
//   ficam prontas, junta tudo numa entrega final para o chefe.

const ESPERAS_MIN = [1, 3, 10, 30, 60]; // espera antes de cada nova tentativa
// só para testes: encurta as esperas (ex.: 0.05) e o intervalo de conferência
const ESCALA = Number(process.env.SUPERVISOR_ESCALA) || 1;
const INTERVALO_MS = Number(process.env.SUPERVISOR_INTERVALO_MS) || 20000;
const MAX_TENTATIVAS = ESPERAS_MIN.length;
const CONSOLIDAR = process.env.ORQUESTRADOR_CONSOLIDAR !== '0';
const JANELA_MS = 12 * 3600 * 1000; // ordens antigas do histórico não são retomadas

const falhou = (r) => r && (r.erro || /^(Erro:|Interrompida:)/.test(r.texto));

export function criarSupervisor({ ordens, equipe, redespachar, criarOrdem, registrarStatus, estadoDe, avisarChefe, mudou }) {
  let relogio = null;
  let acompanhando = false; // o Orquestrador está com status "Acompanhando…"

  const alvosDe = (o) => (o.para === 'todos' ? o.entregue : [o.para]);
  const orquestrador = () => Object.entries(equipe()).find(([, c]) => c.delegar)?.[0] || null;
  const filhosDe = (o) => ordens.filter((x) => x.pai === o.id);

  // Situação de um agente numa ordem: 'ok' | 'falhou' | 'andamento'
  function situacao(o, agente) {
    const dele = o.respostas.filter((r) => r.agente === agente);
    if (dele.some((r) => !falhou(r))) return 'ok';
    if (dele.length && falhou(dele.at(-1))) return 'falhou';
    return 'andamento';
  }

  // Uma ordem está concluída quando cada destinatário entregou e as tarefas que
  // ela gerou (plano do Orquestrador) também estão concluídas.
  function concluida(o) {
    if (o.desistida) return true;
    if (!alvosDe(o).length || alvosDe(o).some((a) => situacao(o, a) !== 'ok')) return false;
    return filhosDe(o).every(concluida);
  }

  // Entregas finais de um plano (sem os textos de planejamento do Orquestrador).
  function entregasDe(o) {
    const filhos = filhosDe(o).filter((f) => !f.desistida);
    if (filhos.length) return filhos.flatMap(entregasDe);
    return o.respostas.filter((r) => !falhou(r)).map((r) => ({ agente: r.agente, pedido: o.texto, texto: r.texto }));
  }

  function agendar(o, agente, erro) {
    o.tentativas ??= {};
    const t = (o.tentativas[agente] ??= { n: 0 });
    if (t.aguardando === erro?.em) return t; // já agendado para esta falha
    t.aguardando = erro?.em;
    t.ultimoErro = String(erro?.texto || '').replace(/^Erro:\s*/, '').slice(0, 200);
    t.proxima = t.n < MAX_TENTATIVAS ? new Date(Date.now() + ESPERAS_MIN[t.n] * 60000 * ESCALA).toISOString() : null;
    mudou(o);
    return t;
  }

  function tentarDeNovo(o, agente) {
    const t = o.tentativas[agente];
    t.n++;
    t.proxima = null;
    t.aguardando = null;
    console.log(`[supervisor] ${agente}: nova tentativa (${t.n}/${MAX_TENTATIVAS}) da ordem ${o.id}`);
    redespachar(o, agente);
  }

  // Desistir de um agente: o Orquestrador replaneja (ou o chefe é avisado).
  function desistir(o, agente, motivo) {
    if (o.desistida) return;
    o.desistida = true;
    o.motivoDesistencia = motivo;
    mudou(o);
    const orq = orquestrador();
    const delegadaPeloOrquestrador = o.de && o.de !== 'chefe' && o.pai;
    if (orq && delegadaPeloOrquestrador && agente !== orq) {
      console.log(`[supervisor] ${agente} não conseguiu a ordem ${o.id}: o Orquestrador vai replanejar`);
      criarOrdem({
        para: orq, de: 'chefe', pai: o.pai, cliente: o.cliente, origem: o.origem,
        texto: `Replanejar: a tarefa "${o.texto.slice(0, 600)}" estava com ${agente} e não pôde ser concluída (${motivo}). Passe essa tarefa para outro agente da equipe que consiga fazê-la.`,
      });
    } else {
      avisarChefe(`⚠️ ${agente} não conseguiu concluir "${o.texto.slice(0, 120)}" depois de ${MAX_TENTATIVAS} tentativas (${motivo}). Confira a IA dele em ⚙ Equipe e mande de novo.`);
    }
  }

  function consolidar(o) {
    o.consolidada = true;
    mudou(o);
    const entregas = entregasDe(o);
    if (!CONSOLIDAR || entregas.length < 2) return; // com uma entrega só, ela já é o resultado
    const anexo = entregas.map((e, i) => `### ${i + 1}. ${e.agente} — ${e.pedido.slice(0, 200)}\n${e.texto.slice(0, 8000)}`).join('\n\n');
    criarOrdem({
      para: o.para, de: 'chefe', consolidacao: o.id, cliente: o.cliente, origem: o.origem,
      texto: `Entrega final do pedido: "${o.texto.slice(0, 600)}"`,
      anexo,
    });
  }

  function conferir() {
    const cfg = equipe();
    const agora = Date.now();
    let abertas = 0;
    for (const o of ordens) {
      if (o.desistida) continue;
      if (!o.tentativas && !o.pai && agora - Date.parse(o.criadaEm) > JANELA_MS && !filhosDe(o).length) continue;
      if (agora - Date.parse(o.criadaEm) > 7 * 24 * 3600 * 1000) continue; // nada com mais de uma semana
      // tarefas com falha: agenda e repete; sem jeito: desiste
      for (const agente of alvosDe(o)) {
        if (situacao(o, agente) !== 'falhou') continue;
        if (cfg[agente]?.provedor === 'webhook') continue; // motor externo: ele mesmo responde
        if (!cfg[agente]) { desistir(o, agente, `${agente} não está mais na equipe`); break; }
        const t = agendar(o, agente, o.respostas.filter((r) => r.agente === agente).at(-1));
        if (!t.proxima) { desistir(o, agente, t.ultimoErro || 'erro'); break; }
        if (Date.parse(t.proxima) <= agora && estadoDe(agente) !== 'trabalhando') tentarDeNovo(o, agente);
      }
      // planos do Orquestrador: acompanha até todas as tarefas ficarem prontas
      if (o.pai || o.consolidacao || o.consolidada || !filhosDe(o).length) continue;
      if (concluida(o)) consolidar(o);
      else abertas++;
    }
    // o Orquestrador mostra que está de olho no time
    const orq = orquestrador();
    if (orq && estadoDe(orq) !== 'trabalhando') {
      if (abertas) {
        registrarStatus({ id: orq, status: 'aguardando', tarefa: `Acompanhando ${abertas} plano(s) até a entrega final` });
        acompanhando = true;
      } else if (acompanhando) {
        registrarStatus({ id: orq, status: 'ocioso', tarefa: '' });
        acompanhando = false;
      }
    }
  }

  // Consertou o agente: o que estava parado com ele tenta de novo agora.
  function agenteMudou(id) {
    let n = 0;
    for (const o of ordens) {
      if (o.desistida || !alvosDe(o).includes(id) || situacao(o, id) !== 'falhou') continue;
      o.tentativas ??= {};
      o.tentativas[id] = { n: 0 }; // agente novo, contagem nova
      agendar(o, id, o.respostas.filter((r) => r.agente === id).at(-1));
      tentarDeNovo(o, id);
      n++;
    }
    if (n) console.log(`[supervisor] ${id} foi alterado: ${n} tarefa(s) retomada(s)`);
    return n;
  }

  // Tentar agora (botão na tela), sem esperar o próximo horário.
  function tentarAgora(o, agente) {
    if (situacao(o, agente) !== 'falhou') throw new Error('essa tarefa não está com falha');
    o.desistida = false;
    o.tentativas ??= {};
    o.tentativas[agente] ??= { n: 0 };
    tentarDeNovo(o, agente);
  }

  function iniciar() {
    conferir();
    relogio ??= setInterval(conferir, INTERVALO_MS);
    relogio.unref?.();
  }

  return { iniciar, conferir, agenteMudou, tentarAgora, concluida, falhou };
}
