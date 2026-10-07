// Motores embutidos: o próprio servidor chama a IA de cada agente quando chega
// uma ordem para ele, conforme o motores.json (veja motores.exemplo.json).
//
//   {
//     "backend":      { "provedor": "anthropic", "modelo": "claude-opus-5-5", "funcao": "...", "instrucoes": "..." },
//     "revisor":      { "provedor": "openai", "modelo": "...", "instrucoes": "..." },
//     "orquestrador": { "provedor": "anthropic", "delegar": true, "instrucoes": "..." },
//     "designer":     { "webhook": "https://seu-n8n/webhook/designer" }
//   }
//
// Agentes fora do motores.json continuam recebendo ordens pela consulta
// (GET /api/ordens/pendentes), como antes.

import { readFileSync, existsSync } from 'node:fs';
import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PROVEDORES, chamarIA, NOMES, listarModelos } from './provedores.js';
import { migrarConfiguracao, IDS_ANTIGOS } from './time-dev.js';

const VOLTAR_AO_OCIOSO = 8000;

const PROVEDORES_VALIDOS = Object.keys(PROVEDORES);
const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
const COM_INTERNET = ['anthropic', 'gemini'];
// quem revisa as entregas dos agentes com "revisar": REVISOR no .env, senão o QA (ou o Revisor do time antigo)
const revisorDe = (cfg) => process.env.REVISOR || (cfg.qa ? 'qa' : 'revisor');
// chaves que a tela de configuração mostra como "configurada / falta"
const CHAVES_CONHECIDAS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'MISTRAL_API_KEY'];

// fichaCliente(id) → texto da ficha do cliente (tom, público, o que evitar…) ou ''
// contextoCodigo(cliente) → texto com o repositório do projeto e a regra de entregar arquivos (ou '')
export function criarMotores({ raiz, dadosDir, ordens, registrarStatus, marcarEntregue, registrarResposta, atualizarOrdem, criarOrdem, fichaCliente = () => '', contextoCodigo = async () => '' }) {
  const arquivo = process.env.MOTORES_ARQUIVO || join(raiz, 'motores.json');
  // o que você muda pela tela fica na pasta de dados (o motores.json original vira só o ponto de partida)
  const arquivoEditado = join(dadosDir, 'motores.json');
  const filas = new Map(); // agente → promessa da tarefa em andamento (uma por vez)
  let avisado = '';

  // Relido a cada ordem: dá para editar o motores.json sem reiniciar.
  function lerBruto() {
    try {
      if (existsSync(arquivoEditado)) return JSON.parse(readFileSync(arquivoEditado, 'utf8'));
      return JSON.parse(process.env.MOTORES_JSON || readFileSync(arquivo, 'utf8'));
    } catch (erro) {
      if (erro.code !== 'ENOENT' && avisado !== erro.message) console.error(`motores.json inválido: ${(avisado = erro.message)}`);
      return {};
    }
  }

  function configuracao() {
    const bruto = lerBruto();
    const cfg = {};
    for (const [id, c] of Object.entries(bruto)) {
      if (id.startsWith('_') || !c || typeof c !== 'object') continue; // "_comentario" etc.
      const provedor = c.provedor || (c.webhook ? 'webhook' : null);
      if (!PROVEDORES[provedor]) { console.warn(`motores.json: "${id}" tem provedor desconhecido "${c.provedor}"`); continue; }
      cfg[id] = { ...c, provedor };
    }
    return cfg;
  }

  function rotulo(c) {
    let nome = NOMES[c.provedor];
    if (c.provedor === 'compativel' && c.baseUrl) {
      // mostra o serviço de verdade em vez de "API compatível"
      const host = new URL(c.baseUrl).host;
      nome = /groq/.test(host) ? 'Groq' : /openrouter/.test(host) ? 'OpenRouter' : /nvidia/.test(host) ? 'NVIDIA' : /mistral/.test(host) ? 'Mistral' : /cloudflare/.test(host) ? 'Cloudflare' : /:11434$/.test(host) ? 'Ollama' : /deepseek/.test(host) ? 'DeepSeek' : host;
    }
    return (c.modelo ? `${nome} · ${c.modelo}` : nome) + (c.reservaDe ? ' (reserva)' : '');
  }

  function instrucoesDe(id, c, cfg, podeDelegar, ordem, codigo = '') {
    let texto = c.instrucoes || `Você é o agente "${id}" de um escritório de IA${c.funcao ? `, responsável por: ${c.funcao}` : ''}. Cumpra a tarefa do chefe com qualidade e responda em português.`;
    const ficha = ordem?.cliente ? fichaCliente(ordem.cliente) : '';
    if (ficha) texto += `\n\nEsta tarefa é do projeto do cliente abaixo. Siga a ficha (escopo, stack, integrações, regras de negócio e restrições) em tudo o que entregar:\n\n${ficha}`;
    if (codigo && !podeDelegar) texto += `\n\n${codigo}`;
    if (c.internet) texto += '\n\nVocê pode pesquisar na internet: use a busca para trazer dados atuais e cite as fontes. Não invente números nem fontes.';
    if (podeDelegar) {
      const equipe = Object.entries(cfg).filter(([outro, o]) => outro !== id && !o.delegar)
        .map(([outro, o]) => `- ${outro}: ${o.funcao || 'sem descrição'}`).join('\n');
      texto += `\n\nVocê coordena esta equipe:\n${equipe}\n\nResponda SOMENTE com um objeto JSON, sem texto fora dele, no formato:\n{"resposta": "o que você vai fazer, em poucas linhas, para o chefe", "tarefas": [{"para": "<id da lista>", "texto": "tarefa clara e completa para esse agente"}]}\nUse apenas ids da lista. Se der para resolver sem a equipe, responda com "tarefas": [].`;
    }
    return texto;
  }

  function pedidoDe(ordem) {
    if (ordem.consolidacao) {
      return `${ordem.texto}\n\nA equipe terminou todas as tarefas do seu plano. Junte as entregas abaixo numa entrega final para o chefe: completa, organizada e pronta para usar. Mantenha o conteúdo de cada uma (não resuma demais), elimine repetições, aponte o que ainda falta decidir, e não invente nada que não esteja nas entregas.\n\nEntregas da equipe:\n<<<\n${ordem.anexo || ''}\n>>>`;
    }
    if (ordem.ajuste) {
      // pedido de ajuste: o agente vê o pedido original e o que ele mesmo entregou
      return `O chefe pediu um ajuste numa entrega sua.\n\nPedido original:\n${ordem.ajuste.original}\n\nSua entrega anterior:\n<<<\n${ordem.ajuste.anterior}\n>>>\n\nAjuste pedido pelo chefe: ${ordem.texto}\n\nDevolva a versão completa já ajustada (não só a parte que mudou).`;
    }
    const pedido = ordem.contexto ? `${ordem.texto}\n\nContexto: ${ordem.contexto}` : ordem.texto;
    return ordem.anexo ? `${pedido}\n\nMaterial:\n<<<\n${ordem.anexo}\n>>>` : pedido;
  }

  // O Revisor recebe a entrega e devolve a versão final + observações (na fila dele, uma por vez).
  const SEPARADOR_OBS = /^[ \t]*-{3,}[ \t]*OBSERVA[ÇC][ÕO]ES[ \t]*-{3,}[ \t]*$/im;
  function revisar(ordem, autor, rascunho) {
    const REVISOR = revisorDe(configuracao());
    return naFila(REVISOR, async () => {
      const cfg = configuracao();
      const c = cfg[REVISOR];
      registrarStatus({ id: REVISOR, status: 'trabalhando', tarefa: `Revisando a entrega de ${autor}`, motor: rotulo(c) });
      try {
        const pedido = `Revise a entrega abaixo, feita por "${autor}", antes de ela ir para o chefe.\n\nPedido:\n${ordem.ajuste ? `${ordem.ajuste.original}\n(ajuste pedido: ${ordem.texto})` : ordem.texto}\n\nEntrega:\n<<<\n${rascunho}\n>>>\n\nResponda neste formato, sem nada antes:\n1) a versão final revisada, completa e pronta para usar (mantenha o que já está bom; corrija erros, clareza e riscos);\n2) uma linha só com ---OBSERVAÇÕES---;\n3) em tópicos curtos, o que você mudou e por quê (ou "Nada a corrigir").`;
        const { texto: resposta, usado } = await chamarIA(c, { instrucoes: instrucoesDe(REVISOR, c, cfg, false, ordem), pedido, ordem, agente: REVISOR }, {
          cfg, aoEsperar: (tarefa) => registrarStatus({ id: REVISOR, status: 'aguardando', tarefa }),
        });
        const [final, obs] = String(resposta || '').split(SEPARADOR_OBS);
        registrarStatus({ id: REVISOR, status: 'concluido', tarefa: `Revisou a entrega de ${autor}` });
        setTimeout(() => registrarStatus({ id: REVISOR, status: 'ocioso', tarefa: '' }), VOLTAR_AO_OCIOSO);
        return { texto: final.trim() || rascunho, observacoes: (obs || '').trim(), motor: rotulo(usado) };
      } catch (erro) {
        registrarStatus({ id: REVISOR, status: 'erro', tarefa: erro.message.slice(0, 140) });
        throw erro;
      }
    });
  }

  const revisorDisponivel = (id, c, cfg) => { const rev = revisorDe(cfg); return c.revisar && id !== rev && cfg[rev] && cfg[rev].provedor !== 'webhook'; };

  function lerPlano(texto) {
    const limpo = texto.replace(/```(?:json)?/g, '');
    const inicio = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (inicio < 0 || fim < inicio) return null;
    try { return JSON.parse(limpo.slice(inicio, fim + 1)); } catch { return null; }
  }

  // ---------- configuração pela tela ----------

  function url(valor, campo) {
    try {
      const u = new URL(valor);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      return u.toString().replace(/\/$/, '');
    } catch { throw new Error(`"${campo}" precisa ser um endereço http(s) válido`); }
  }

  function texto(valor, max) {
    return typeof valor === 'string' ? valor.trim().slice(0, max) : '';
  }

  // Limpa e valida o que veio da tela. Lança erro com mensagem amigável.
  function validar(dados) {
    const provedor = dados.provedor;
    if (!PROVEDORES_VALIDOS.includes(provedor)) throw new Error(`provedor deve ser um de: ${PROVEDORES_VALIDOS.join(', ')}`);
    const c = { provedor };
    if (provedor === 'webhook') {
      c.webhook = url(dados.webhook, 'webhook');
    } else {
      c.modelo = texto(dados.modelo, 120);
      if (!c.modelo) throw new Error('informe o modelo');
    }
    if (provedor === 'compativel') {
      c.baseUrl = url(dados.baseUrl, 'baseUrl');
      const chaveEnv = texto(dados.chaveEnv, 60);
      // só variáveis de chave de API: impede apontar para a senha do escritório, por exemplo
      if (chaveEnv && !/^[A-Z][A-Z0-9_]*_API_KEY$/.test(chaveEnv)) throw new Error('chaveEnv deve ser o nome de uma variável terminada em _API_KEY (ex.: GROQ_API_KEY)');
      if (chaveEnv) c.chaveEnv = chaveEnv;
    }
    if (provedor === 'anthropic' && dados.esforco) {
      if (!ESFORCOS.includes(dados.esforco)) throw new Error(`esforço deve ser um de: ${ESFORCOS.join(', ')}`);
      c.esforco = dados.esforco;
    }
    if (dados.delegar) c.delegar = true;
    if (dados.revisar) c.revisar = true; // passa pelo Revisor antes de entregar
    // IA reserva: se esta der limite de uso, o agente usa a IA de outro agente
    if (typeof dados.reserva === 'string' && /^[\w-]{1,40}$/.test(dados.reserva)) c.reserva = dados.reserva;
    if (dados.internet) {
      if (!COM_INTERNET.includes(provedor)) throw new Error('pesquisa na internet só funciona com Claude ou Gemini');
      c.internet = true;
    }
    const funcao = texto(dados.funcao, 200);
    const instrucoes = texto(dados.instrucoes, 8000);
    if (funcao) c.funcao = funcao;
    if (instrucoes) c.instrucoes = instrucoes;
    return c;
  }

  async function salvarAgente(id, dados) {
    if (!/^[\w-]{1,40}$/.test(id)) throw new Error('id do agente inválido');
    const c = validar(dados);
    if (c.reserva === id) delete c.reserva; // reserva de si mesmo não ajuda
    const bruto = lerBruto();
    bruto[id] = c;
    await mkdir(dadosDir, { recursive: true });
    await writeFile(`${arquivoEditado}.tmp`, JSON.stringify(bruto, null, 2));
    await rename(`${arquivoEditado}.tmp`, arquivoEditado);
    registrarStatus({ id, motor: rotulo(c) });
    return c;
  }

  // Tira o agente da equipe (a configuração passa a ser a salva pela tela, como em salvarAgente).
  async function removerAgente(id) {
    const bruto = lerBruto();
    if (!(id in bruto)) return false;
    delete bruto[id];
    await mkdir(dadosDir, { recursive: true });
    await writeFile(`${arquivoEditado}.tmp`, JSON.stringify(bruto, null, 2));
    await rename(`${arquivoEditado}.tmp`, arquivoEditado);
    return true;
  }

  // Modelos que a chave consegue usar no provedor escolhido (sem exigir modelo preenchido).
  async function modelos(dados) {
    const c = validar({ ...dados, modelo: dados.modelo || 'qualquer', webhook: dados.webhook || 'https://x.invalid' });
    return listarModelos(c);
  }

  // Faz uma pergunta curtinha com a configuração dada, para conferir modelo e chave antes de salvar.
  async function testar(id, dados) {
    const c = validar(dados);
    const inicio = Date.now();
    try {
      const resposta = await PROVEDORES[c.provedor]({
        ...c,
        instrucoes: 'Você está sendo testado. Responda apenas com uma frase curta em português dizendo que está funcionando.',
        pedido: 'Teste de conexão do escritório.',
        maxTokens: 2000,
        ordem: { id: 'teste', para: id, texto: 'Teste de conexão do escritório.' },
        agente: id,
      });
      return { ok: true, ms: Date.now() - inicio, resposta: resposta ?? '(webhook aceitou; a resposta vem depois)' };
    } catch (erro) {
      return { ok: false, ms: Date.now() - inicio, erro: erro.message };
    }
  }

  // Descarta as mudanças feitas pela tela e volta a usar o motores.json do servidor.
  // Uma vez só: converte a equipe antiga (agência de marketing) para o time de desenvolvimento,
  // mantendo a IA escolhida para cada papel. Devolve o mapa de ids trocados (ou null).
  async function migrarTimeDev() {
    const novo = migrarConfiguracao(lerBruto());
    if (!novo) return null;
    await mkdir(dadosDir, { recursive: true });
    await writeFile(`${arquivoEditado}.tmp`, JSON.stringify(novo, null, 2));
    await rename(`${arquivoEditado}.tmp`, arquivoEditado);
    console.log(`Equipe convertida para o time de desenvolvimento: ${Object.keys(novo).filter((k) => !k.startsWith('_')).join(', ')}`);
    return IDS_ANTIGOS;
  }

  async function restaurar() {
    await rm(arquivoEditado, { force: true });
    for (const [id, c] of Object.entries(configuracao())) registrarStatus({ id, motor: rotulo(c) });
  }

  function listar() {
    const cfg = configuracao();
    const nomes = new Set(CHAVES_CONHECIDAS);
    for (const c of Object.values(cfg)) if (c.chaveEnv) nomes.add(c.chaveEnv);
    const chaves = Object.fromEntries([...nomes].map((n) => [n, Boolean(process.env[n])]));
    const rotulos = Object.fromEntries(Object.entries(cfg).map(([id, c]) => [id, rotulo(c)]));
    return { agentes: cfg, rotulos, chaves, provedores: PROVEDORES_VALIDOS, editadoPelaTela: existsSync(arquivoEditado) };
  }

  async function executar(id, ordem) {
    const cfg = configuracao();
    const c = cfg[id];
    if (!c) return;
    const podeDelegar = Boolean(c.delegar) && (!ordem.de || ordem.de === 'chefe') && !ordem.ajuste && !ordem.consolidacao; // delegadas, ajustes e entregas finais não são re-delegados
    registrarStatus({ id, status: 'trabalhando', tarefa: ordem.texto.slice(0, 140), motor: rotulo(c) });
    const inicio = Date.now();
    let usado = c; // muda se a IA reserva precisar entrar
    const meta = () => ({ motor: rotulo(usado), ms: Date.now() - inicio }); // para o relatório comparar IAs
    try {
      const codigo = ordem.cliente ? await contextoCodigo(ordem.cliente, ordem).catch(() => '') : '';
      const chamada = await chamarIA(c, { instrucoes: instrucoesDe(id, c, cfg, podeDelegar, ordem, codigo), pedido: pedidoDe(ordem), ordem, agente: id }, {
        cfg, aoEsperar: (tarefa) => registrarStatus({ id, status: 'aguardando', tarefa }),
      });
      usado = chamada.usado;
      let resposta = chamada.texto;
      if (resposta === null) { // webhook: entregue, o motor responde depois
        registrarStatus({ id, status: 'aguardando', tarefa: 'Enviado ao motor externo' });
        return;
      }
      if (podeDelegar) {
        const plano = lerPlano(resposta);
        if (plano) {
          const tarefas = (Array.isArray(plano.tarefas) ? plano.tarefas : [])
            .filter((t) => t && cfg[t.para] && t.para !== id && typeof t.texto === 'string' && t.texto.trim());
          for (const t of tarefas) criarOrdem({ para: t.para, texto: t.texto, de: id, contexto: `pedido original do chefe: "${ordem.texto}"`, cliente: ordem.cliente, origem: ordem.origem, pai: ordem.id });
          resposta = (plano.resposta || 'Plano montado.') + (tarefas.length ? `\n\nDistribuí: ${tarefas.map((t) => `${t.para} → ${t.texto}`).join(' · ')}` : '');
        }
      } else if (resposta && revisorDisponivel(id, c, cfg)) {
        // revisão automática: o agente fica livre e a entrega só sai depois que o Revisor aprovar
        const m = meta();
        registrarStatus({ id, status: 'concluido', tarefa: 'Entrega com o Revisor' });
        setTimeout(() => registrarStatus({ id, status: 'ocioso', tarefa: '' }), VOLTAR_AO_OCIOSO);
        revisar(ordem, id, resposta)
          .then((r) => registrarResposta(ordem, id, r.texto, { ...m, revisao: { por: revisorDe(cfg), motor: r.motor, observacoes: r.observacoes.slice(0, 4000) } }))
          .catch((erro) => registrarResposta(ordem, id, resposta, { ...m, revisao: { por: revisorDe(cfg), erro: erro.message.slice(0, 200) } }))
          .finally(() => atualizarOrdem(ordem));
        return;
      }
      registrarResposta(ordem, id, resposta || '(resposta vazia)', meta());
      atualizarOrdem(ordem);
      registrarStatus({ id, status: 'concluido', tarefa: 'Ordem cumprida' });
    } catch (erro) {
      console.error(`[${id}] ordem ${ordem.id}: ${erro.message}`);
      registrarResposta(ordem, id, `Erro: ${erro.message}`, { ...meta(), erro: true });
      atualizarOrdem(ordem);
      // status curto: de erros em JSON ({"error":{"message":"..."}}) fica só a mensagem
      registrarStatus({ id, status: 'erro', tarefa: (erro.message.match(/"message"\s*:\s*"([^"]{3,})"/)?.[1] || erro.message).slice(0, 140) });
      return;
    }
    setTimeout(() => registrarStatus({ id, status: 'ocioso', tarefa: '' }), VOLTAR_AO_OCIOSO);
  }

  function enfileirar(id, ordem) {
    naFila(id, () => executar(id, ordem)).catch((erro) => console.error(erro));
  }

  // Põe qualquer trabalho na fila do agente (ele faz uma coisa por vez). Devolve a promessa do trabalho.
  function naFila(id, trabalho) {
    const anterior = filas.get(id) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(trabalho);
    filas.set(id, atual.catch(() => {}));
    return atual;
  }

  // Entrega a ordem a todos os agentes com motor embutido a que ela se destina.
  function despachar(ordem) {
    const cfg = configuracao();
    const alvos = ordem.para === 'todos' ? Object.keys(cfg) : cfg[ordem.para] ? [ordem.para] : [];
    for (const id of alvos) {
      if (ordem.entregue.includes(id)) continue;
      marcarEntregue(ordem, id);
      enfileirar(id, ordem);
    }
    if (alvos.length) atualizarOrdem(ordem);
  }

  // Ao ligar: mostra quais agentes têm motor e trata ordens que ficaram para trás.
  function iniciar(estado) {
    const cfg = configuracao();
    for (const [id, c] of Object.entries(cfg)) {
      const atual = estado.get(id);
      registrarStatus({ id, motor: rotulo(c), ...(!atual || atual.status === 'trabalhando' ? { status: 'ocioso', tarefa: '' } : {}) });
    }
    for (const ordem of ordens) {
      if (ordem.estado === 'pendente') { despachar(ordem); continue; }
      // em andamento quando o servidor caiu: avisa em vez de repetir (e pagar de novo) sem você saber
      // (inclui quem estava tentando de novo: a tentativa se perdeu com o reinício)
      const interrompidos = ordem.entregue.filter((id) => cfg[id] && cfg[id].provedor !== 'webhook' && (!ordem.respostas.some((r) => r.agente === id) || ordem.reexecutando?.includes(id)));
      for (const id of interrompidos) registrarResposta(ordem, id, 'Interrompida: o servidor reiniciou durante a tarefa. O supervisor vai tentar de novo.');
      if (interrompidos.length) atualizarOrdem(ordem);
    }
    if (existsSync(arquivoEditado)) console.log(`Usando a equipe editada pela tela (${arquivoEditado}). Para voltar ao motores.json, use "Voltar ao arquivo do servidor" na tela Equipe.`);
    const n = Object.keys(cfg).length;
    console.log(n ? `Motores embutidos: ${Object.entries(cfg).map(([id, c]) => `${id} (${rotulo(c)})`).join(', ')}` : 'Nenhum motor embutido (motores.json ausente).');
  }

  // Agentes que o Decisor pode escolher: os que têm IA configurada (com a função de cada um).
  function equipe() {
    return configuracao();
  }

  return { despachar, iniciar, listar, salvarAgente, removerAgente, migrarTimeDev, testar, restaurar, equipe, modelos, naFila, rotulo };
}
