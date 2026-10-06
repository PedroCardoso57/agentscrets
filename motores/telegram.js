// Telegram: o chefe manda ordens por mensagem e recebe cada entrega de volta,
// com um resumo e o .md anexado.
//
// Configuração (.env): TELEGRAM_BOT_TOKEN (do @BotFather). O chat é descoberto
// sozinho: mande /start para o bot e o primeiro chat que falar com ele fica
// gravado em DADOS_DIR/telegram.json (depois disso, só ele dá ordens e recebe
// entregas; os outros são ignorados). Para fixar o chat à mão: TELEGRAM_CHAT_ID.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const API = process.env.TELEGRAM_API || 'https://api.telegram.org'; // trocável só para testes
const LIMITE_LEGENDA = 1024;
const LIMITE_MENSAGEM = 4096;

const ICONE_STATUS = { ocioso: '⚪', trabalhando: '🟢', aguardando: '🟡', concluido: '🔵', erro: '🔴' };

export function criarTelegram({ dadosDir, nomeDe = (id) => id, equipe = () => [], status = () => null, cranioAtivo = () => false, aoOrdem, aoAjuste, clientes, rotinas = () => [] }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const arquivo = join(dadosDir, 'telegram.json');
  let chatId = process.env.TELEGRAM_CHAT_ID || null;
  let fila = Promise.resolve();
  let ouvindo = null;
  let conexao = {}; // o que fica em telegram.json
  const mensagensDeEntrega = new Map(); // id da mensagem no Telegram → { ordemId, indice } (para pedir ajuste respondendo)
  const MAX_LEMBRADAS = 500;

  async function gravarConexao() {
    conexao.chatId = chatId;
    conexao.entregas = Object.fromEntries([...mensagensDeEntrega].slice(-MAX_LEMBRADAS));
    await mkdir(dadosDir, { recursive: true });
    await writeFile(arquivo, JSON.stringify(conexao));
  }

  const ativo = () => Boolean(token);

  async function chamar(metodo, corpo) {
    const r = await fetch(`${API}/bot${token}/${metodo}`, corpo instanceof FormData
      ? { method: 'POST', body: corpo }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    const dados = await r.json().catch(() => ({}));
    if (!dados.ok) throw new Error(`Telegram ${metodo}: ${dados.description || `HTTP ${r.status}`}`);
    return dados.result;
  }

  // Mensagens passam pela mesma fila das entregas (o Telegram limita ~1 por segundo por chat).
  function enfileirar(trabalho) {
    fila = fila.then(async () => {
      await trabalho();
      await new Promise((r) => setTimeout(r, 1100));
    }).catch((erro) => console.error('[telegram]', erro.message));
    return fila;
  }

  const responder = (chat, texto, emResposta) => enfileirar(() => chamar('sendMessage', {
    chat_id: chat,
    text: texto.slice(0, LIMITE_MENSAGEM),
    ...(emResposta ? { reply_parameters: { message_id: emResposta, allow_sending_without_reply: true } } : {}),
  }));

  function ajuda() {
    const ids = equipe();
    const exemplo = ids.includes('redator') ? 'redator' : ids[0] || 'agente';
    return [
      'Como mandar ordens:',
      `• Só escreva o pedido: ${cranioAtivo() ? 'o 🔮 Crânio escolhe quem faz' : ids.includes('orquestrador') ? 'vai para o Orquestrador, que distribui' : 'vai para toda a equipe'}.`,
      `• Para alguém específico: /${exemplo} escreva 3 legendas para o post de segunda`,
      '• Para todos: /todos reunião às 15h',
      '• Para um cliente: comece com #cliente (ex.: #padaria /redator legenda de natal)',
      '• Para ajustar uma entrega: responda à mensagem dela dizendo o que mudar',
      '',
      '/equipe — quem está fazendo o quê',
      '/clientes — clientes cadastrados',
      '/rotinas — ordens agendadas',
      '/ajuda — esta mensagem',
      '',
      `Equipe: ${ids.map((id) => `/${id}`).join(' ')}`,
    ].join('\n');
  }

  function textoEquipe() {
    const linhas = equipe().map((id) => {
      const s = status(id) || {};
      return `${ICONE_STATUS[s.status] || '⚪'} ${nomeDe(id)}${s.tarefa ? ` — ${s.tarefa}` : ''}`;
    });
    return linhas.length ? linhas.join('\n') : 'Nenhum agente configurado.';
  }

  function textoClientes() {
    const lista = clientes?.listar() || [];
    if (!lista.length) return 'Nenhum cliente cadastrado. Cadastre em 📇 Clientes, no escritório.';
    return `Clientes (use #id no começo da ordem):\n${lista.map((c) => `• #${c.id} — ${c.nome}${c.nicho ? ` (${c.nicho})` : ''}`).join('\n')}`;
  }

  function textoRotinas() {
    const lista = rotinas();
    if (!lista.length) return 'Nenhuma rotina agendada. Crie em 🗓 Rotinas, no escritório.';
    return lista.map((r) => `${r.ativa ? '🟢' : '⏸'} ${r.nome} — ${r.quando}${r.cliente ? ` · #${r.cliente}` : ''}`).join('\n');
  }

  // "#cliente /redator texto", "/redator #cliente texto", "@redator texto", "/todos texto" ou só o texto.
  function interpretar(textoOriginal) {
    let texto = textoOriginal;
    let cliente = '';
    const tag = texto.match(/(^|\s)#([\w-]+)/);
    if (tag && !/^\/(start|ajuda|help|equipe|status|clientes|rotinas)\b/i.test(texto)) {
      cliente = clientes?.achar(tag[2]) || null;
      if (!cliente) return { clienteDesconhecido: tag[2] };
      texto = texto.replace(tag[0], ' ').trim();
    }
    const comando = interpretarAlvo(texto);
    return cliente ? { ...comando, cliente } : comando;
  }

  function interpretarAlvo(texto) {
    const m = texto.match(/^[/@]([\w-]+)(?:@\w+)?\s*([\s\S]*)$/);
    if (!m) return { pedido: texto };
    const alvo = m[1].toLowerCase();
    if (alvo === 'start') return { comando: 'start' };
    if (alvo === 'ajuda' || alvo === 'help') return { comando: 'ajuda' };
    if (alvo === 'equipe' || alvo === 'status') return { comando: 'equipe' };
    if (alvo === 'clientes' || alvo === 'rotinas') return { comando: alvo };
    if (alvo === 'todos' || equipe().includes(alvo)) return { para: alvo, pedido: m[2].trim() };
    return { desconhecido: alvo };
  }

  function padrao() {
    if (cranioAtivo()) return 'auto';
    return equipe().includes('orquestrador') ? 'orquestrador' : 'todos';
  }

  async function conectar(chat) {
    chatId = String(chat.id);
    conexao = { nome: chat.first_name || chat.title || '', em: new Date().toISOString() };
    await gravarConexao();
    console.log(`[telegram] conectado ao chat ${chatId}`);
  }

  async function receber(msg) {
    const chat = msg.chat;
    const texto = (msg.text || '').trim();
    if (!chat?.id || !texto) return;
    const comando = interpretar(texto);

    if (!chatId) {
      if (comando.comando !== 'start') return;
      await conectar(chat);
      return responder(chatId, `✅ Escritório conectado! As entregas da equipe vão chegar aqui, e você pode mandar ordens por este chat.\n\n${ajuda()}`);
    }
    if (String(chat.id) !== chatId) {
      // outro chat: só avisa no /start, para não virar porta de entrada
      if (comando.comando === 'start') responder(chat.id, 'Este escritório já está conectado a outro chat.');
      return;
    }

    if (comando.comando === 'start' || comando.comando === 'ajuda') return responder(chatId, ajuda());
    if (comando.comando === 'equipe') return responder(chatId, textoEquipe());
    if (comando.comando === 'clientes') return responder(chatId, textoClientes());
    if (comando.comando === 'rotinas') return responder(chatId, textoRotinas());

    // respondeu a uma entrega: é um pedido de ajuste para o mesmo agente
    const entrega = msg.reply_to_message && mensagensDeEntrega.get(String(msg.reply_to_message.message_id));
    if (entrega && !comando.comando) {
      try {
        const ordem = aoAjuste({ ...entrega, texto, origem: { telegram: { chat: chatId, msg: msg.message_id } } });
        return responder(chatId, `↩ ${nomeDe(ordem.para)} vai ajustar. A nova versão chega aqui.`, msg.message_id);
      } catch (erro) {
        return responder(chatId, `⚠️ Não consegui pedir o ajuste: ${erro.message}`, msg.message_id);
      }
    }

    if (comando.clienteDesconhecido) return responder(chatId, `Não conheço o cliente "#${comando.clienteDesconhecido}".\n\n${textoClientes()}`, msg.message_id);
    if (comando.desconhecido) return responder(chatId, `Não conheço "${comando.desconhecido}" na equipe.\n\n${ajuda()}`, msg.message_id);
    if (!comando.pedido) return responder(chatId, `Escreva o pedido depois do nome. Ex.: /${comando.para} ...`, msg.message_id);

    try {
      const ordem = await aoOrdem({ para: comando.para || padrao(), texto: comando.pedido, cliente: comando.cliente, origem: { telegram: { chat: chatId, msg: msg.message_id } } });
      const d = ordem.decisao;
      const quem = ordem.para === 'todos' ? 'toda a equipe' : nomeDe(ordem.para);
      const cranio = d && d.modo !== 'indisponivel' ? ` 🔮 Crânio: ${Math.round((d.confianca || 0) * 100)}%${d.modo === 'redirecionou' ? ` (redirecionou de ${nomeDe(d.sugerido)})` : ''}` : '';
      const paraQuem = ordem.cliente ? ` · cliente ${clientes.nomeDe(ordem.cliente)}` : '';
      responder(chatId, `📨 Ordem enviada para ${quem}${paraQuem}.${cranio}\nA entrega chega aqui quando ficar pronta. Para ajustar, responda à entrega.`, msg.message_id);
    } catch (erro) {
      responder(chatId, `⚠️ Não consegui passar a ordem: ${erro.message}`, msg.message_id);
    }
  }

  // Escuta o bot o tempo todo (long polling: não precisa abrir porta nem webhook).
  async function ouvir() {
    let offset = 0;
    for (;;) {
      try {
        const updates = await chamar('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.message) await receber(u.message).catch((erro) => console.error('[telegram]', erro.message));
        }
      } catch (erro) {
        console.error('[telegram]', erro.message);
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
  }

  async function iniciar() {
    if (!ativo()) return;
    if (!chatId) {
      try { conexao = JSON.parse(await readFile(arquivo, 'utf8')); chatId = conexao.chatId || null; } catch { /* ainda não conectado */ }
    } else {
      try { conexao = JSON.parse(await readFile(arquivo, 'utf8')); } catch { /* sem histórico */ }
    }
    for (const [msgId, alvo] of Object.entries(conexao.entregas || {})) mensagensDeEntrega.set(msgId, alvo);
    try {
      const bot = await chamar('getMe');
      console.log(chatId ? `[telegram] @${bot.username} conectado: ordens e entregas pelo chat` : `[telegram] mande /start para @${bot.username} para conectar`);
    } catch (erro) {
      return console.error('[telegram] token inválido?', erro.message);
    }
    ouvindo ??= ouvir();
  }

  // Envia uma entrega; se a ordem veio do Telegram, chega como resposta à mensagem dela.
  function enviarEntrega({ agente, de, motor, pedido, texto, arquivo: nomeArquivo, conteudo, origem, ordemId, indice, cliente, revisado, ajuste }) {
    if (!ativo() || !chatId) return;
    const emResposta = origem?.telegram?.chat === chatId ? origem.telegram.msg : null;
    enfileirar(async () => {
      const marcas = [cliente ? `👤 ${clientes?.nomeDe(cliente) || cliente}` : null, ajuste ? '↩ ajuste' : null, revisado ? '✅ revisado' : null].filter(Boolean).join(' · ');
      const cabecalho = `📦 ${nomeDe(agente)}${de && de !== 'chefe' ? ` (pedido de ${nomeDe(de)})` : ''}${marcas ? `\n${marcas}` : ''}\n📝 ${pedido.split('\n')[0].slice(0, 150)}\n🤖 ${motor}\n\n`;
      const legenda = (cabecalho + texto).slice(0, LIMITE_LEGENDA - 1) + (cabecalho.length + texto.length >= LIMITE_LEGENDA ? '…' : '');
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', legenda);
      if (emResposta) form.append('reply_parameters', JSON.stringify({ message_id: emResposta, allow_sending_without_reply: true }));
      form.append('document', new Blob([conteudo], { type: 'text/markdown' }), nomeArquivo.split('/').pop());
      const enviada = await chamar('sendDocument', form);
      if (enviada?.message_id && ordemId) {
        mensagensDeEntrega.set(String(enviada.message_id), { ordemId, indice });
        await gravarConexao();
      }
    });
  }

  // Aviso solto para o chefe (ex.: uma tarefa que não deu certo).
  function avisar(texto) {
    if (ativo() && chatId) responder(chatId, texto);
  }

  return { iniciar, enviarEntrega, avisar, ativo, conectado: () => Boolean(chatId) };
}
