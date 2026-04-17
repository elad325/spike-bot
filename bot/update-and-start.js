/**
 * Wrapper that pulls the latest Baileys, then launches the bot.
 *
 * Used by both PM2 (ecosystem.config.cjs) and start-bot.bat so that every
 * restart - manual or automatic - picks up the latest WhatsApp library.
 *
 * If the update fails (offline, registry down, etc.) we log and start anyway
 * with whatever version is currently installed.
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('[update] Pulling latest @whiskeysockets/baileys...');
try {
  execSync('npm install @whiskeysockets/baileys@latest --no-audit --no-fund --silent', {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('[update] Baileys updated.');
} catch (err) {
  console.warn(`[update] Could not pull latest Baileys (${err.message?.split('\n')[0] || 'unknown'}). Continuing with installed version.`);
}

console.log('[update] Refreshing other packages within semver...');
try {
  execSync('npm update --no-audit --no-fund --silent', {
    stdio: 'inherit',
    cwd: __dirname,
  });
} catch (err) {
  console.warn(`[update] npm update reported issues: ${err.message?.split('\n')[0] || 'unknown'}`);
}

console.log('[update] Launching bot...');
await import('./src/index.js');
