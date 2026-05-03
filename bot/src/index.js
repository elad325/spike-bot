import 'dotenv/config';
import { startWhatsApp } from './whatsapp.js';
import { startTelegram } from './telegram.js';
import { startHeartbeat } from './heartbeat.js';
import { log } from './utils/logger.js';

async function main() {
  log.info('🚀 Starting SPIKE bot...');
  log.info(`Node version: ${process.version}`);
  log.info(`Working dir: ${process.cwd()}`);

  startHeartbeat();

  // Start both transports in parallel. allSettled so a failure on one
  // doesn't tank the other — common case is "TELEGRAM_BOT_TOKEN not set"
  // which startTelegram handles by skipping silently.
  const results = await Promise.allSettled([
    startWhatsApp(),
    startTelegram(),
  ]);

  for (const [i, r] of results.entries()) {
    const name = i === 0 ? 'WhatsApp' : 'Telegram';
    if (r.status === 'rejected') {
      log.error(`${name} failed to start:`, r.reason?.message || r.reason);
    }
  }

  // If both failed, there's nothing for the bot to do — exit so PM2 can restart.
  if (results.every((r) => r.status === 'rejected')) {
    log.error('Both transports failed — exiting so PM2 will restart us.');
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});

main();
