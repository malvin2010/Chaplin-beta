// Baileys' pairing-code generator (and some of its internals) call the global
// `crypto` object (Web Crypto API) directly, without importing it. Node.js only
// exposes that as a global automatically from v20+; on older Node runtimes
// (common on some hosts) it's undefined, causing "crypto is not defined"
// right when you try to generate a pairing code. This polyfill fixes that
// regardless of which Node version the host actually runs.
const nodeCrypto = require('crypto');
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = nodeCrypto.webcrypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');

const config = require('./config');
const store = require('./lib/store');
const pending = require('./lib/pending');
const { loadCommands } = require('./lib/loader');
const { startServer } = require('./lib/server');
const { generateReply } = require('./lib/aiReply');
const { styleContent } = require('./lib/style');
const ytdl = require('./lib/ytdl');
const fs = require('fs');

const { registry, categories } = loadCommands();
console.log(`✅ Loaded ${registry.size} command names across ${categories.size} categories.`);

const SESSION_DIR = path.join(__dirname, 'session');

let currentSock = null;
let isRegistered = false;
let reconnectAttempts = 0;
let reconnectPending = false;

function scheduleReconnect(reason) {
  if (reconnectPending) return; // never stack multiple reconnect timers
  reconnectPending = true;
  reconnectAttempts++;
  // Backoff: 2s, 4s, 6s... capped at 30s, so a bad connection can't hammer
  // WhatsApp's servers dozens of times a second (which risks a temporary block).
  const delay = Math.min(30000, 2000 * reconnectAttempts);
  console.log(`Connection closed (${reason}). Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
  setTimeout(() => {
    reconnectPending = false;
    startBot();
  }, delay);
}

let autoPairAttempted = false;

async function tryAutoPair(sock) {
  if (!config.PAIR_NUMBER || isRegistered || autoPairAttempted) return;
  autoPairAttempted = true;
  try {
    // Only ask WhatsApp for a pairing code once the socket has actually
    // reached the connecting state — asking before that reliably produces
    // a code that then fails to link, since the session isn't ready yet.
    await sock.waitForConnectionUpdate(u => u.connection === 'connecting' || !!u.qr);
    if (isRegistered) return; // became registered while we were waiting
    const raw = await sock.requestPairingCode(config.PAIR_NUMBER.trim());
    const code = raw.match(/.{1,4}/g).join('-');
    console.log('');
    console.log('=========================================');
    console.log(`   PAIRING CODE FOR ${config.PAIR_NUMBER}`);
    console.log(`   >>>  ${code}  <<<`);
    console.log('   WhatsApp > Linked Devices > Link a');
    console.log('   Device > Link with phone number');
    console.log('   instead — then enter this code.');
    console.log('   (expires quickly, pair right away)');
    console.log('=========================================');
    console.log('');
  } catch (e) {
    console.error('Auto-pair request failed:', e.message);
    autoPairAttempted = false; // allow a retry on the next reconnect
  }
}

async function requestPairingCodeFor(number) {
  if (!currentSock) throw new Error('Bot is still starting up, try again in a few seconds.');
  if (isRegistered) throw new Error('This bot instance is already paired to a number. Restart with a fresh session to re-pair.');
  // Same fix as tryAutoPair — must wait for the right connection state first.
  await currentSock.waitForConnectionUpdate(u => u.connection === 'connecting' || !!u.qr);
  const code = await currentSock.requestPairingCode(number.trim());
  return code.match(/.{1,4}/g).join('-');
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    // A recognized browser fingerprint is required for phone-number pairing
    // to actually work — a custom/arbitrary browser string is accepted for
    // generating the code, but WhatsApp then refuses to complete the link.
    browser: Browsers.macOS('Chrome'),
    // Prevents the pairing request from timing out prematurely while WhatsApp
    // completes the handshake — a known cause of "couldn't link device".
    defaultQueryTimeoutMs: undefined
  });

  currentSock = sock;
  isRegistered = !!sock.authState.creds.registered;
  tryAutoPair(sock); // fire-and-forget — logs the code to console when ready

  // Apply the small-caps font style to every outgoing message, everywhere,
  // by wrapping sendMessage once here. Every command (all 280+ of them) calls
  // sock.sendMessage under the hood, so this single wrap covers all of them.
  const rawSend = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, content, options) => rawSend(jid, styleContent(content), options);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      isRegistered = true;
      reconnectAttempts = 0; // fully connected — reset backoff for the next time it drops
      console.log(`✅ ${config.BOT_NAME} connected to WhatsApp.`);
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        scheduleReconnect(statusCode || 'unknown reason');
      } else {
        console.log('❌ Logged out. Delete the session folder and re-pair via the website.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const from = m.key.remoteJid;
    const sender = m.key.participant || m.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const text = m.message.conversation
      || m.message.extendedTextMessage?.text
      || m.message.imageMessage?.caption
      || '';
    const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;

    const isOwner = sender.replace(/\D/g, '').startsWith(config.OWNER_NUMBER) || sender === `${config.OWNER_NUMBER}@s.whatsapp.net`;

    // --- Handle pending "audio or document" choice for songs ---
    const pend = pending.get(from);
    if (pend && pend.type === 'song_choice' && /^[12]$/.test(text.trim())) {
      pending.clear(from);
      const wantsDoc = text.trim() === '2';
      try {
        const wait = await sock.sendMessage(from, { text: `⬇️ Downloading *${pend.title}*...` }, { quoted: m });
        const file = await ytdl.downloadAudio(pend.url);
        const sizeMB = fs.statSync(file).size / 1024 / 1024;
        if (sizeMB > config.MAX_AUDIO_MB) {
          fs.unlinkSync(file);
          return sock.sendMessage(from, { text: `❌ File too large to send (${sizeMB.toFixed(1)}MB).` }, { quoted: wait });
        }
        const buffer = fs.readFileSync(file);
        if (wantsDoc) {
          await sock.sendMessage(from, { document: buffer, mimetype: 'audio/mpeg', fileName: `${pend.title}.mp3` }, { quoted: wait });
        } else {
          await sock.sendMessage(from, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: wait });
        }
        fs.unlinkSync(file);
      } catch (e) {
        await sock.sendMessage(from, { text: `❌ Download failed: ${e.message}` }, { quoted: m });
      }
      return;
    }

    // --- Handle the .guessnumber game's pending guesses ---
    if (pend && pend.type === 'guess_number' && /^\d+$/.test(text.trim())) {
      const guess = parseInt(text.trim());
      pend.tries += 1;
      if (guess === pend.target) {
        pending.clear(from);
        await sock.sendMessage(from, { text: `🎉 Correct! It was ${pend.target}. You got it in ${pend.tries} ${pend.tries === 1 ? 'try' : 'tries'}!` }, { quoted: m });
      } else if (pend.tries >= 8) {
        pending.clear(from);
        await sock.sendMessage(from, { text: `❌ Out of tries! The number was ${pend.target}.` }, { quoted: m });
      } else {
        await sock.sendMessage(from, { text: guess < pend.target ? '📈 Higher!' : '📉 Lower!' }, { quoted: m });
      }
      return;
    }

    // --- Command handling ---
    if (text.startsWith(config.PREFIX)) {
      const [cmdRaw, ...args] = text.slice(config.PREFIX.length).trim().split(/ +/);
      const cmd = registry.get((cmdRaw || '').toLowerCase());
      if (cmd) {
        try {
          await cmd.execute({
            sock, m, from, sender, isGroup, args, text, quotedMsg,
            isOwner, config, store, categories, registry
          });
        } catch (e) {
          console.error(`Error in command ${cmd.name}:`, e);
          await sock.sendMessage(from, { text: `❌ Something went wrong running that command.` }, { quoted: m });
        }
      }
      return;
    }

    // --- Chatbot auto-reply: replies when the bot is tagged/mentioned and chatbot is ON for this chat ---
    const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const botJid = sock.user?.id?.split(':')[0];
    const wasTagged = mentioned.some(j => j.startsWith(botJid)) || (quotedMsg && m.message.extendedTextMessage?.contextInfo?.participant?.startsWith(botJid));

    if (store.isChatbotOn(from) && wasTagged && text) {
      const reply = generateReply(text);
      await sock.sendMessage(from, { text: reply }, { quoted: m });
    }
  });
}

startBot().catch(err => console.error('Fatal error starting bot:', err));
startServer(requestPairingCodeFor);
