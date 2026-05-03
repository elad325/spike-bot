import { Bot } from 'grammy';
import { log } from './utils/logger.js';
import { handleTelegramUpdate, handleTelegramCallback } from './handlers/telegram/messageHandler.js';

let bot = null;
let botUsername = null;

export function getTelegramBot() {
  return bot;
}

export function getTelegramBotUsername() {
  return botUsername;
}

/**
 * Boot the Telegram bot. Quietly skipped if TELEGRAM_BOT_TOKEN is unset, so
 * developers can run the WhatsApp side standalone without forcing a token
 * into .env. Polling is good enough for this use case (single instance,
 * Telegram pushes updates at us within seconds).
 */
export async function startTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.info('ℹ️  TELEGRAM_BOT_TOKEN not set — Telegram channel disabled');
    return;
  }

  bot = new Bot(token);

  // Any text/media message from a user.
  bot.on('message', async (ctx) => {
    try {
      await handleTelegramUpdate(ctx);
    } catch (err) {
      log.error('Telegram message handler:', err);
    }
  });

  // Inline-button presses come as callback_query, separate event from messages.
  bot.on('callback_query', async (ctx) => {
    try {
      await handleTelegramCallback(ctx);
    } catch (err) {
      log.error('Telegram callback handler:', err);
      // Always answer the callback so the spinner clears even on error.
      try {
        await ctx.answerCallbackQuery({ text: 'שגיאה — נסה שוב', show_alert: false });
      } catch {}
    }
  });

  // Surface anything grammy didn't recognise — useful while iterating.
  bot.catch((err) => log.error('Telegram bot error:', err));

  // bot.start() blocks until the bot is stopped, so we don't await it; we
  // kick off polling and let the rest of main() continue.
  bot
    .start({
      onStart: (info) => {
        botUsername = info.username;
        log.success(`✅ Telegram bot @${info.username} connected`);
      },
      // Drop any backlog from while the bot was offline. Old menu presses
      // would race with the latest state and confuse users; better to just
      // silently swallow them and let people re-open.
      drop_pending_updates: true,
    })
    .catch((err) => log.error('Telegram polling failed:', err));
}

export async function stopTelegram() {
  if (bot) {
    try {
      await bot.stop();
    } catch (err) {
      log.warn('Telegram stop error (ignored):', err.message);
    }
    bot = null;
  }
}
