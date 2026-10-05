// Janelas "Equipe" (escolher a IA de cada agente, pela tela) e "Relatório"
// (como cada agente e cada IA está se saindo). Só funcionam com o servidor.

const NOMES_PROVEDOR = {
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI (GPT)',
  gemini: 'Gemini (Google)',
  compativel: 'Groq / OpenRouter / outra compatível',
  webhook: 'Webhook (n8n, Make…)',
};

const SUGESTOES = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
  gemini: ['gemini-3-flash-preview'],
  openai: [],
  compativel: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openrouter/free'],
};

// atalhos para preencher endereço e chave das APIs compatíveis mais comuns
const PRESETS = {
  Groq: { baseUrl: 'https://api.groq.com/openai/v1', chaveEnv: 'GROQ_API_KEY', modelo: 'openai/gpt-oss-120b' },
  OpenRouter: { baseUrl: 'https://openrouter.ai/api/v1', chaveEnv: 'OPENROUTER_API_KEY', modelo: 'openrouter/free' },
  Ollama: { baseUrl: 'http://localhost:11434/v1', chaveEnv: '', modelo: '' },
};

const CHAVE_DO_PROVEDOR = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

async function api(caminho, corpo) {
  const r = await fetch(caminho, corpo === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`);
  return dados;
}

function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) if (f !== null && f !== undefined) e.append(f); // textos viram nós de texto (seguro)
  return e;
}

export function criarConfiguracao({ agentesVisiveis, nomeDe, servidorAtivo }) {
  const dlgEquipe = document.getElementById('dlg-equipe');
  const dlgRelatorio = document.getElementById('dlg-relatorio');
  for (const d of [dlgEquipe, dlgRelatorio]) {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); }); // clicar fora fecha
  }

  // ---------- Equipe ----------

  let estado = null;
  let selecionado = null;

  async function abrirEquipe(id) {
    if (!servidorAtivo()) return alert('A configuração da equipe precisa do servidor (node servidor.js ou o VPS).');
    dlgEquipe.showModal();
    corpoEquipe().replaceChildren(el('p', { class: 'suave' }, 'Carregando…'));
    try {
      estado = await api('api/motores');
    } catch (erro) {
      corpoEquipe().replaceChildren(el('p', { class: 'erro' }, `Não consegui carregar: ${erro.message}`));
      return;
    }
    selecionado = id || selecionado || agentesVisiveis()[0];
    desenharEquipe();
  }

  const corpoEquipe = () => dlgEquipe.querySelector('.corpo');

  function desenharEquipe() {
    const ids = [...new Set([...agentesVisiveis(), ...Object.keys(estado.agentes)])];
    const lista = el('ul', { class: 'cfg-lista' }, ids.map((id) => {
      const c = estado.agentes[id];
      return el('li', { class: id === selecionado ? 'ativo' : '', onclick: () => { selecionado = id; desenharEquipe(); } },
        el('b', {}, nomeDe(id)),
        el('small', {}, c ? estado.rotulos[id] : 'sem IA (só motor externo)'));
    }));
    const rodape = estado.editadoPelaTela
      ? el('p', { class: 'suave' }, 'A equipe está usando a configuração salva pela tela. ',
        el('button', { type: 'button', class: 'link', onclick: restaurar }, 'Voltar ao motores.json do servidor'))
      : el('p', { class: 'suave' }, 'Mudanças valem já na próxima ordem, sem reiniciar.');
    corpoEquipe().replaceChildren(el('div', { class: 'cfg-grade' }, lista, formulario(selecionado)), rodape);
  }

  function formulario(id) {
    const atual = estado.agentes[id] || { provedor: 'gemini', modelo: 'gemini-3-flash-preview' };
    const f = el('form', { class: 'cfg-form', onsubmit: (ev) => { ev.preventDefault(); salvar(); } });
    const campo = (rotulo, input, dica) => el('label', {}, el('span', {}, rotulo), input, dica ? el('small', { class: 'suave' }, dica) : null);

    const provedor = el('select', { name: 'provedor' }, Object.entries(NOMES_PROVEDOR).map(([v, n]) => el('option', { value: v, selected: v === atual.provedor }, n)));
    const modelo = el('input', { name: 'modelo', list: 'sugestoes-modelo', value: atual.modelo || '', placeholder: 'nome do modelo' });
    const datalist = el('datalist', { id: 'sugestoes-modelo' });
    const baseUrl = el('input', { name: 'baseUrl', value: atual.baseUrl || '', placeholder: 'https://api.groq.com/openai/v1' });
    const chaveEnv = el('input', { name: 'chaveEnv', value: atual.chaveEnv || '', placeholder: 'GROQ_API_KEY' });
    const webhook = el('input', { name: 'webhook', value: atual.webhook || '', placeholder: 'https://seu-n8n.com/webhook/agente' });
    const esforco = el('select', { name: 'esforco' }, ['low', 'medium', 'high', 'xhigh', 'max'].map((v) => el('option', { value: v, selected: v === (atual.esforco || 'medium') }, v)));
    const delegar = el('input', { type: 'checkbox', name: 'delegar', checked: Boolean(atual.delegar) });
    const funcao = el('input', { name: 'funcao', value: atual.funcao || '', placeholder: 'ex.: Escreve legendas e roteiros' });
    const instrucoes = el('textarea', { name: 'instrucoes', rows: 7, placeholder: 'Você é o … da agência. …' }, atual.instrucoes || '');
    const statusChave = el('p', { class: 'chave' });
    const resultado = el('div', { class: 'resultado' });

    const presets = el('div', { class: 'presets' }, 'Atalhos: ', Object.keys(PRESETS).map((nome) => el('button', {
      type: 'button', class: 'link', onclick: () => {
        const p = PRESETS[nome];
        baseUrl.value = p.baseUrl; chaveEnv.value = p.chaveEnv; if (p.modelo) modelo.value = p.modelo;
        atualizar();
      },
    }, nome)));

    const grupos = {
      modelo: campo('Modelo', el('span', {}, modelo, datalist), 'Escolha uma sugestão ou digite o nome exato do painel do provedor.'),
      compat: el('div', {}, presets, campo('Endereço da API (baseUrl)', baseUrl), campo('Variável da chave no .env', chaveEnv, 'Deixe vazio se a API não pede chave (ex.: Ollama).')),
      webhook: campo('URL do webhook', webhook),
      esforco: campo('Esforço (Claude)', esforco, 'Mais esforço = respostas mais caprichadas, mais lentas e mais caras.'),
    };

    function atualizar() {
      const p = provedor.value;
      grupos.modelo.hidden = p === 'webhook';
      grupos.compat.hidden = p !== 'compativel';
      grupos.webhook.hidden = p !== 'webhook';
      grupos.esforco.hidden = p !== 'anthropic';
      datalist.replaceChildren(...(SUGESTOES[p] || []).map((m) => el('option', { value: m })));
      const nomeChave = p === 'compativel' ? chaveEnv.value.trim() : CHAVE_DO_PROVEDOR[p];
      if (!nomeChave) { statusChave.textContent = p === 'webhook' ? '' : 'Sem chave de API.'; statusChave.className = 'chave'; return; }
      if (!(nomeChave in estado.chaves)) { statusChave.textContent = `Use "Testar" para conferir se ${nomeChave} está no .env do servidor.`; statusChave.className = 'chave'; return; }
      const tem = estado.chaves[nomeChave];
      statusChave.textContent = tem ? `✓ ${nomeChave} configurada no servidor` : `✗ falta ${nomeChave} no .env do servidor (depois: docker compose restart)`;
      statusChave.className = `chave ${tem ? 'ok' : 'falta'}`;
    }
    provedor.addEventListener('change', () => {
      if (SUGESTOES[provedor.value]?.length && !SUGESTOES[provedor.value].includes(modelo.value)) modelo.value = SUGESTOES[provedor.value][0];
      atualizar();
    });
    chaveEnv.addEventListener('input', atualizar);

    function dados() {
      return {
        provedor: provedor.value, modelo: modelo.value, baseUrl: baseUrl.value, chaveEnv: chaveEnv.value, webhook: webhook.value,
        esforco: esforco.value, delegar: delegar.checked, funcao: funcao.value, instrucoes: instrucoes.value,
      };
    }

    async function testar() {
      resultado.className = 'resultado'; resultado.textContent = 'Testando…';
      try {
        const r = await api(`api/motores/${encodeURIComponent(id)}/testar`, dados());
        resultado.className = `resultado ${r.ok ? 'ok' : 'falha'}`;
        resultado.textContent = r.ok ? `✓ Funcionou em ${(r.ms / 1000).toFixed(1)} s: "${r.resposta.slice(0, 200)}"` : `✗ ${r.erro}`;
      } catch (erro) {
        resultado.className = 'resultado falha'; resultado.textContent = `✗ ${erro.message}`;
      }
    }

    async function salvar() {
      resultado.className = 'resultado'; resultado.textContent = 'Salvando…';
      try {
        await api(`api/motores/${encodeURIComponent(id)}`, dados());
        estado = await api('api/motores');
        desenharEquipe();
        const novo = corpoEquipe().querySelector('.resultado');
        novo.className = 'resultado ok'; novo.textContent = '✓ Salvo. Vale a partir da próxima ordem.';
      } catch (erro) {
        resultado.className = 'resultado falha'; resultado.textContent = `✗ ${erro.message}`;
      }
    }

    f.append(
      el('h3', {}, nomeDe(id)),
      campo('IA', provedor),
      grupos.modelo, grupos.compat, grupos.webhook, statusChave, grupos.esforco,
      campo('Função (o Orquestrador lê isto para decidir a quem passar cada tarefa)', funcao),
      campo('Instruções (o papel e o jeito de trabalhar deste agente)', instrucoes),
      el('label', { class: 'linha' }, delegar, el('span', {}, 'Pode delegar tarefas para a equipe (Orquestrador)')),
      el('div', { class: 'acoes' },
        el('button', { type: 'button', class: 'secundario', onclick: testar }, 'Testar'),
        el('button', { type: 'submit' }, 'Salvar')),
      resultado,
    );
    atualizar();
    return f;
  }

  async function restaurar() {
    if (!confirm('Descartar o que foi mudado pela tela e voltar a usar o motores.json do servidor?')) return;
    try { estado = await api('api/motores/restaurar', {}); desenharEquipe(); } catch (erro) { alert(erro.message); }
  }

  // ---------- Relatório ----------

  async function abrirRelatorio() {
    if (!servidorAtivo()) return alert('O relatório precisa do servidor (node servidor.js ou o VPS).');
    dlgRelatorio.showModal();
    const corpo = dlgRelatorio.querySelector('.corpo');
    const dias = dlgRelatorio.querySelector('select[name=dias]');
    corpo.replaceChildren(el('p', { class: 'suave' }, 'Carregando…'));
    let rel;
    try { rel = await api(`api/relatorio?dias=${dias.value}`); } catch (erro) {
      corpo.replaceChildren(el('p', { class: 'erro' }, `Não consegui carregar: ${erro.message}`));
      return;
    }
    const ids = Object.keys(rel);
    if (!ids.length) {
      corpo.replaceChildren(el('p', { class: 'suave' }, 'Ainda não há respostas neste período. Dê algumas ordens e avalie as respostas com 👍 / 👎 no painel de Ordens.'));
      return;
    }
    const pct = (x) => (x.boas + x.ruins ? `${Math.round((100 * x.boas) / (x.boas + x.ruins))}%` : '—');
    const seg = (ms) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
    const linha = (rotulo, x, classe) => el('tr', { class: classe || '' },
      el('td', {}, rotulo), el('td', {}, String(x.respostas)), el('td', {}, `${x.boas} / ${x.ruins}`), el('td', {}, pct(x)), el('td', {}, String(x.erros)), el('td', {}, seg(x.msMedio)));
    const tabela = el('table', {},
      el('thead', {}, el('tr', {}, ['Agente / IA', 'Respostas', '👍 / 👎', 'Aprovação', 'Erros', 'Tempo médio'].map((t) => el('th', {}, t)))),
      el('tbody', {}, ids.sort((a, b) => rel[b].respostas - rel[a].respostas).flatMap((id) => {
        const a = rel[id];
        const motoresUsados = Object.entries(a.porMotor);
        return [
          linha(nomeDe(id), a, 'agente'),
          ...(motoresUsados.length > 1 ? motoresUsados.map(([m, x]) => linha(`↳ ${m}`, x, 'motor')) : [linha(`↳ ${motoresUsados[0][0]}`, motoresUsados[0][1], 'motor')]),
        ];
      })));
    const comentarios = ids.flatMap((id) => rel[id].comentarios.map((c) => ({ ...c, id })));
    corpo.replaceChildren(
      tabela,
      comentarios.length ? el('div', { class: 'comentarios' }, el('h3', {}, 'Comentários recentes'),
        el('ul', {}, comentarios.slice(-15).reverse().map((c) => el('li', {},
          el('b', {}, `${c.nota === 1 ? '👍' : '👎'} ${nomeDe(c.id)}`), ` (${c.motor || 'externo'}) em "${c.ordem}": `, c.texto)))) : null,
      el('p', { class: 'suave' }, 'Dica: para comparar duas IAs no mesmo papel, troque o modelo do agente em ⚙ Equipe no meio da semana. O relatório separa as respostas por IA.'),
    );
  }

  dlgRelatorio.querySelector('select[name=dias]').addEventListener('change', abrirRelatorio);
  for (const d of [dlgEquipe, dlgRelatorio]) d.querySelector('.fechar').addEventListener('click', () => d.close());
  document.getElementById('abrir-equipe').addEventListener('click', () => abrirEquipe());
  document.getElementById('abrir-relatorio').addEventListener('click', abrirRelatorio);

  return { abrirEquipe };
}
