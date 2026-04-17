import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baileysLogger, log } from './utils/logger.js';
import { handleMessage } from './handlers/messageHandler.js';
import { notifyAdminsBotOnline } from './handlers/notifyAdmins.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FOLDER = path.resolve(__dirname, '..', 'auth');

let sock = null;
let isFreshStart = true;
let reconnectTimer = null;

export function getSock() {
  return sock;
}

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  log.info(`📱 WhatsApp Web v${version.join('.')} (isLatest: ${isLatest})`);

  sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: state,
    browser: Browsers.macOS('SPIKE'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log.info('📷 Scan this QR code with WhatsApp on your phone:');
      log.info('   (WhatsApp → Settings → Linked Devices → Link a Device)');
      console.log('');
      qrcode.generate(qr, { small: true });
      console.log('');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'unknown';
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      log.warn(`🔌 Connection closed (${reason}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          log.info('🔄 Reconnecting...');
          startWhatsApp().catch((err) => log.error('Reconnect failed:', err));
        }, 3000);
      } else {
        log.error('❌ Logged out from WhatsApp. Delete bot/auth/ folder and restart to re-link.');
        process.exit(1);
      }
    } else if (connection === 'open') {
      log.success('✅ Connected to WhatsApp!');

      if (isFreshStart) {
        isFreshStart = false;
        try {
          await notifyAdminsBotOnline(sock);
        } catch (err) {
          log.error('Failed to notify admins on startup:', err);
        }
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        log.error('Error handling message:', err);
      }
    }
  });
}
