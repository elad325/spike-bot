/**
 * WhatsApp-side handlers for cross-platform account linking.
 *
 * Two entry points:
 *   /קשר טלגרם           - issue a token, reply with a Telegram deep link
 *   /קשר <token>         - redeem a token created on the Telegram side
 *
 * (English alias: /link-telegram, /link <token>.)
 *
 * The Telegram side has equivalent commands implemented in
 * handlers/telegram/messageHandler.js + adminMenu.js — together these two
 * halves form a complete two-way linking flow.
 */
import { issueLinkToken, redeemLinkToken } from '../shared/users.js';
import { getTelegramBotUsername } from '../telegram.js';
import { deliverableJid } from '../utils/format.js';

const ISSUE_RE = /^\/(?:קשר\s+טלגרם|link[-\s]telegram)\s*$/i;
const REDEEM_RE = /^\/(?:קשר|link)\s+([a-f0-9]{16,64})\s*$/i;

export function isLinkIssueCommand(text) {
  if (!text) return false;
  return ISSUE_RE.test(text.trim());
}

export function isLinkRedeemCommand(text) {
  if (!text) return false;
  return REDEEM_RE.test(text.trim());
}

export function parseLinkRedeemToken(text) {
  if (!text) return null;
  const m = text.trim().match(REDEEM_RE);
  return m ? m[1] : null;
}

export async function handleLinkIssue(sock, user) {
  if (user.role !== 'admin') {
    await sock.sendMessage(deliverableJid(user), {
      text: 'אין לך הרשאה לפקודה זו.',
    });
    return;
  }

  const { token, expiresAt } = await issueLinkToken('whatsapp', user.id);
  const minutesLeft = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000);
  const username = getTelegramBotUsername();

  // Telegram's `t.me/<bot>?start=<payload>` deep-link delivers `/start <payload>`
  // to the bot when opened. Prefer that over a paste-in if we know the bot's
  // username (we do, once startTelegram has finished its onStart callback).
  const lines = [];
  lines.push('🔗 *קישור חשבון WhatsApp ↔ Telegram*');
  lines.push('');
  if (username) {
    const url = `https://t.me/${username}?start=link_${token}`;
    lines.push('פתח את הלינק הבא בטלגרם מהחשבון שתרצה לקשר:');
    lines.push(url);
  } else {
    lines.push('בבוט הטלגרם, שלח את הפקודה:');
    lines.push(`\`/קשר ${token}\``);
  }
  lines.push('');
  lines.push(`⏳ הקוד תקף ל-${minutesLeft} דקות.`);

  await sock.sendMessage(deliverableJid(user), { text: lines.join('\n') });
}

export async function handleLinkRedeem(sock, user, token) {
  const result = await redeemLinkToken(token, 'whatsapp', user.id);
  if (!result.ok) {
    const msg = {
      invalid: 'קוד קישור לא תקף.',
      expired: 'הקוד פג תוקף.',
      consumed: 'הקוד כבר נוצל.',
      self: 'אי אפשר לקשר חשבון לעצמו (השתמש בקוד שיצרת מטלגרם).',
    }[result.reason] || 'הקישור נכשל.';
    await sock.sendMessage(deliverableJid(user), { text: `❌ ${msg}` });
    return;
  }

  const tg = result.sourceUser; // Telegram side that issued the token
  const tgIdentity =
    [tg.first_name, tg.last_name].filter(Boolean).join(' ') ||
    (tg.username ? `@${tg.username}` : `id ${tg.telegram_user_id}`);

  await sock.sendMessage(deliverableJid(user), {
    text:
      '✅ *החשבונות קושרו בהצלחה*\n\n' +
      `🟢 WhatsApp: ${user.phone_number}\n` +
      `✈️ Telegram: ${tgIdentity}`,
  });
}
