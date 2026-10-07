// Janela "Monitor de IAs": testa todas as IAs que as suas chaves enxergam
// (Claude, OpenAI, Gemini e APIs compatíveis da equipe) e mostra quais estão
// funcionando agora, o tempo de resposta e o motivo real de quem falha.

const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
const el = (tag, props = {}, ...filhos) => { const e = Object.assign(document.createElement(tag), props); e.append(...filhos.filter((f) => f != null)); return e; };

export function criarMonitorIas({ servidorAtivo, nomeDe, aoTerminar = () => {} }) {
  const dlg = document.getElementById('dlg-monitor-ias');
  const corpo = dlg.querySelector('.corpo');
  const botao = dlg.querySelector('.testar-todas');
  const filtro = dlg.querySelector('select[name="mostrar"]');
  let dados = null;
  let relogio = null;

  async function carregar(rodar = false) {
    if (!servidorAtivo()) { corpo.replaceChildren(el('p', { className: 'suave', textContent: 'O monitor precisa do servidor (node servidor.js ou o VPS).' })); return; }
    try {
      const r = await fetch('api/ias/teste', { method: rodar ? 'POST' : 'GET' });
      dados = await r.json();
    } catch (erro) {
      corpo.replaceChildren(el('p', { className: 'suave', textContent: `Não consegui falar com o servidor: ${erro.message}` }));
      return;
    }
    desenhar();
    clearTimeout(relogio);
    if (dados.rodando) relogio = setTimeout(() => carregar(), 1500);
    else if (rodar === false && dados.fim) aoTerminar();
  }

  function desenhar() {
    const { rodando, total, feitos, provedores = [], resultados = [], estados = {}, fim } = dados;
    botao.disabled = rodando;
    botao.textContent = rodando ? `Testando… ${feitos}/${total}` : 'Testar todas agora';
    corpo.innerHTML = '';
    if (!dados.inicio) {
      corpo.append(el('div', { className: 'vazio-monitor' },
        el('b', { textContent: 'Nenhum teste rodado ainda.' }),
        el('p', { textContent: 'Clique em "Testar todas agora": para cada provedor com chave no .env, o escritório lista os modelos que a sua chave enxerga e manda um "ok" bem curto para cada modelo de conversa (poucos tokens por modelo).' })));
      return;
    }
    const ok = resultados.filter((x) => x.estado === 'ok').length;
    const falhas = resultados.length - ok;
    const daEquipe = resultados.filter((x) => x.usadoPor.length || x.reservaDe.length);
    const equipeFalhando = daEquipe.filter((x) => x.estado !== 'ok').length;
    corpo.append(el('div', { className: 'resumo-monitor' },
      el('div', { className: 'kpi-monitor ok' }, el('b', { textContent: ok }), el('span', { textContent: 'funcionando' })),
      el('div', { className: `kpi-monitor ${falhas ? 'ruim' : ''}` }, el('b', { textContent: falhas }), el('span', { textContent: 'com problema' })),
      el('div', { className: `kpi-monitor ${equipeFalhando ? 'ruim' : 'ok'}` }, el('b', { textContent: `${daEquipe.length - equipeFalhando}/${daEquipe.length}` }), el('span', { textContent: 'da equipe ok' })),
      el('div', { className: 'quando-monitor', textContent: rodando ? `testando ${feitos} de ${total}…` : `último teste às ${hora(fim)}` }),
    ));
    if (rodando) corpo.append(el('div', { className: 'barra-monitor' }, el('i', { style: `width:${total ? Math.round((feitos / total) * 100) : 0}%` })));

    const mostrar = filtro.value;
    for (const p of provedores) {
      const linhas = resultados.filter((x) => x.provedor === p.provedor && (p.provedor !== 'compativel' || x.nomeProvedor === p.nome))
        .filter((x) => mostrar === 'todas' || (mostrar === 'equipe' ? x.usadoPor.length || x.reservaDe.length : x.estado !== 'ok'));
      const bloco = el('section', { className: 'provedor-monitor' });
      const okP = resultados.filter((x) => x.nomeProvedor === p.nome && x.estado === 'ok').length;
      const totalP = resultados.filter((x) => x.nomeProvedor === p.nome).length;
      bloco.append(el('header', {}, el('b', { textContent: p.nome }),
        el('span', { className: `estado-provedor ${p.estado === 'ok' ? 'ok' : 'ruim'}`, textContent: p.estado === 'ok' ? `${okP}/${totalP || p.modelos} respondendo` : estados[p.estado] || p.estado })));
      if (p.estado !== 'ok') {
        bloco.append(motivo(p.mensagem, p.bruto));
        corpo.append(bloco);
        continue;
      }
      if (!linhas.length) { bloco.append(el('p', { className: 'suave', textContent: totalP ? 'Nada para mostrar com este filtro.' : rodando ? 'Na fila…' : 'Nenhum modelo de conversa.' })); corpo.append(bloco); continue; }
      const tabela = el('ul', { className: 'modelos-monitor' });
      for (const x of linhas) {
        const usos = [...x.usadoPor.map((id) => el('span', { className: 'uso', textContent: nomeDe(id) })), ...x.reservaDe.map((id) => el('span', { className: 'uso reserva', textContent: `reserva de ${nomeDe(id)}` }))];
        const li = el('li', { className: x.estado === 'ok' ? 'ok' : 'ruim' },
          el('span', { className: 'ponto', title: estados[x.estado] || x.estado }),
          el('code', { textContent: x.modelo }),
          el('span', { className: 'usos' }, ...usos),
          el('span', { className: 'ms', textContent: x.estado === 'ok' ? `${(x.ms / 1000).toFixed(1)} s` : estados[x.estado] || x.estado }),
        );
        if (x.estado !== 'ok') li.append(motivo(x.mensagem, x.bruto));
        tabela.append(li);
      }
      bloco.append(tabela);
      corpo.append(bloco);
    }
  }

  // o motivo real: a mensagem do provedor (e o erro completo, se quiser ver)
  function motivo(mensagem, bruto) {
    const caixa = el('div', { className: 'motivo' }, el('span', { textContent: `Motivo: ${mensagem || 'sem detalhes'}` }));
    if (bruto && bruto !== mensagem) {
      const det = el('details', {}, el('summary', { textContent: 'erro completo' }), el('pre', { textContent: bruto }));
      caixa.append(det);
    }
    return caixa;
  }

  botao.addEventListener('click', () => carregar(true));
  filtro.addEventListener('change', () => dados && desenhar());
  dlg.querySelector('.fechar').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => clearTimeout(relogio));

  function abrir() {
    dlg.showModal();
    carregar();
  }
  return { abrir };
}
