// Avisos no Telegram: cada entrega nova chega como mensagem, com o .md anexado.
//
// Configuração (.env): TELEGRAM_BOT_TOKEN (do @BotFather). O chat é descoberto
// sozinho: mande /start para o bot e o primeiro chat que falar com ele fica
// gravado em DADOS_DIR/telegram.json (depois disso, ninguém mais entra).
// Para fixar o chat à mão: TELEGRAM_CHAT_ID.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const API = process.env.TELEGRAM_API || 'https://api.telegram.org'; // trocável só para testes
const LIMITE_LEGENDA = 1024;

export function criarTelegram({ dadosDir, nomeDe = (id) => id }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const arquivo = join(dadosDir, 'telegram.json');
  let chatId = process.env.TELEGRAM_CHAT_ID || null;
  let fila = Promise.resolve();
  let procurando = null;

  const ativo = () => Boolean(token);

  async function chamar(metodo, corpo) {
    const r = await fetch(`${API}/bot${token}/${metodo}`, corpo instanceof FormData
      ? { method: 'POST', body: corpo }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    const dados = await r.json().catch(() => ({}));
    if (!dados.ok) throw new Error(`Telegram ${metodo}: ${dados.description || `HTTP ${r.status}`}`);
    return dados.result;
  }

  // Espera alguém mandar /start para o bot e grava esse chat como o do chefe.
  async function procurarChat() {
    let offset = 0;
    while (!chatId) {
      try {
        const updates = await chamar('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!chatId && msg?.chat?.id && /^\/start\b/.test(msg.text || '')) {
            chatId = String(msg.chat.id);
            await mkdir(dadosDir, { recursive: true });
            await writeFile(arquivo, JSON.stringify({ chatId, nome: msg.chat.first_name || msg.chat.title || '', em: new Date().toISOString() }));
            console.log(`[telegram] conectado ao chat ${chatId}`);
            await chamar('sendMessage', { chat_id: chatId, text: '✅ Escritório conectado! As entregas da equipe vão chegar aqui.' });
          }
        }
        if (updates.length) await chamar('getUpdates', { offset, timeout: 0 }); // confirma as lidas
      } catch (erro) {
        console.error('[telegram]', erro.message);
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
  }

  async function iniciar() {
    if (!ativo()) return;
    if (!chatId) {
      try { chatId = JSON.parse(await readFile(arquivo, 'utf8')).chatId || null; } catch { /* ainda não conectado */ }
    }
    if (chatId) return console.log('[telegram] entregas serão enviadas ao chat configurado');
    try {
      const bot = await chamar('getMe');
      console.log(`[telegram] mande /start para @${bot.username} para receber as entregas`);
    } catch (erro) {
      return console.error('[telegram] token inválido?', erro.message);
    }
    procurando ??= procurarChat();
  }

  // Envia uma entrega (em fila, para respeitar o limite de mensagens do Telegram).
  function enviarEntrega({ agente, de, motor, pedido, texto, arquivo: nomeArquivo, conteudo }) {
    if (!ativo() || !chatId) return;
    fila = fila.then(async () => {
      const cabecalho = `📦 ${nomeDe(agente)}${de && de !== 'chefe' ? ` (pedido de ${nomeDe(de)})` : ''}\n📝 ${pedido.split('\n')[0].slice(0, 150)}\n🤖 ${motor}\n\n`;
      const legenda = (cabecalho + texto).slice(0, LIMITE_LEGENDA - 1) + (cabecalho.length + texto.length >= LIMITE_LEGENDA ? '…' : '');
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', legenda);
      form.append('document', new Blob([conteudo], { type: 'text/markdown' }), nomeArquivo.split('/').pop());
      await chamar('sendDocument', form);
      await new Promise((r) => setTimeout(r, 1100));
    }).catch((erro) => console.error('[telegram]', erro.message));
  }

  return { iniciar, enviarEntrega, ativo, conectado: () => Boolean(chatId) };
}
