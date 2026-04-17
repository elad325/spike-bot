import 'dotenv/config';
import { startWhatsApp } from './whatsapp.js';
import { startHeartbeat } from './heartbeat.js';
import { log } from './utils/logger.js';

async function main() {
  log.info('🚀 Starting SPIKE bot...');
  log.info(`Node version: ${process.version}`);
  log.info(`Working dir: ${process.cwd()}`);

  startHeartbeat();

  try {
    await startWhatsApp();
  } catch (err) {
    log.error('Fatal error during startup:', err);
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
