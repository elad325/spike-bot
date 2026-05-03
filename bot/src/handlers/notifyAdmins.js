/**
 * Cross-platform admin notifications.
 *
 * Every alert (new user pending, file missing, bot online) fans out to
 * every approved admin on BOTH platforms. The platform of the user who
 * triggered the alert is shown as a tag (🟢 WA / ✈️ TG) so the admin can
 * tell at a glance where to act, and the action commands include the
 * source platform so cross-platform admin actions work.
 */
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { formatPhoneDisplay, deliverableJid } from '../utils/format.js';
import { getAllApprovedAdmins } from '../shared/users.js';
import { getSock } from '../whatsapp.js';
import { getTelegramBot } from '../telegram.js';

const PLATFORM_TAG = {
  whatsapp: '🟢 WA',
  telegram: '✈️ TG',
};

// ─── Send primitives ──────────────────────────────────────────────────

async function sendToAdmin(adminEntry, payload) {
  const { platform, user } = adminEntry;
  if (platform === 'whatsapp') {
    return sendWhatsAppToAdmin(user, payload);
  }
  return sendTelegramToAdmin(user, payload);
}

async function sendWhatsAppToAdmin(admin, payload) {
  const sock = getSock();
  if (!sock) return false;
  try {
    if (payload.kind === 'pending_user') {
      // Try buttons for fast actions; fall back to plain text if WhatsApp
      // refuses the interactive payload (older clients, group chats, etc).
      const phone = payload.target.phone || payload.target.id;
      try {
        await sock.sendMessage(deliverableJid(admin), {
          text: payload.text,
          footer: 'בחר פעולה:',
          buttons: payload.waButtons || [],
          headerType: 1,
        });
      } catch {
        await sock.sendMessage(deliverableJid(admin), { text: payload.text });
      }
    } else {
      await sock.sendMessage(deliverableJid(admin), { text: payload.text });
    }
    await logAdminMessage('whatsapp', admin, payload.text);
    return true;
  } catch (err) {
    log.error(`WA notify ${formatPhoneDisplay(admin.phone_number)} failed:`, err.message);
    return false;
  }
}

async function sendTelegramToAdmin(admin, payload) {
  const tg = getTelegramBot();
  if (!tg) return false;
  try {
    if (payload.kind === 'pending_user' && payload.tgKeyboard) {
      await tg.api.sendMessage(admin.chat_id, payload.text, {
        parse_mode: 'Markdown',
        reply_markup: payload.tgKeyboard,
      });
    } else {
      await tg.api.sendMessage(admin.chat_id, payload.text, { parse_mode: 'Markdown' });
    }
    await logAdminMessage('telegram', admin, payload.text);
    return true;
  } catch (err) {
    log.error(`TG notify @${admin.username || admin.telegram_user_id} failed:`, err.message);
    return false;
  }
}

async function logAdminMessage(platform, admin, body) {
  if (platform === 'whatsapp') {
    await supabase.from('messages').insert({
      user_id: admin.id,
      platform: 'whatsapp',
      phone_number: admin.phone_number,
      whatsapp_name: admin.whatsapp_name,
      direction: 'outgoing',
      message_type: 'text',
      body,
    });
  } else {
    await supabase.from('messages').insert({
      user_id: null,
      platform: 'telegram',
      telegram_user_id: admin.telegram_user_id,
      phone_number: `telegram:${admin.telegram_user_id}`,
      whatsapp_name: [admin.first_name, admin.last_name].filter(Boolean).join(' ') || admin.username,
      direction: 'outgoing',
      message_type: 'text',
      body,
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Notify all admins on both platforms that the bot just (re)started.
 * Kept tied to the WhatsApp side of the codebase (calls from whatsapp.js)
 * but fans out to Telegram admins too for visibility.
 */
export async function notifyAdminsBotOnline(_sock) {
  const admins = await getAllApprovedAdmins();
  if (admins.length === 0) {
    log.info('No admins to notify on startup.');
    return;
  }
  const text =
    '✅ *SPIKE Bot חזר לפעולה*\n\n' +
    `🤖 הבוט מחובר ומוכן לקבל הודעות.\n` +
    `🕐 ${new Date().toLocaleString('he-IL')}`;

  let sent = 0;
  for (const a of admins) {
    if (await sendToAdmin(a, { kind: 'plain', text })) sent++;
  }
  log.success(`Notified ${sent}/${admins.length} admin(s) bot is online.`);
}

/**
 * A new user wrote in for the first time. Fan out to every admin with the
 * right action affordances per platform:
 *   - WhatsApp admins get text-buttons (approve/deny/promote) with phone-
 *     scoped IDs that the existing adminActions handler already understands.
 *   - Telegram admins get inline-keyboard with the same actions, scoped to
 *     the user's id and platform so cross-platform admin actions work.
 *
 * @param {{platform: 'whatsapp'|'telegram', user: object, firstMessage: string}} args
 */
export async function notifyAdminsNewUser(args) {
  const { platform, user, firstMessage } = args;
  const admins = await getAllApprovedAdmins();
  if (admins.length === 0) {
    log.warn('No admins to notify about new user. Add one!');
    return;
  }

  const tag = PLATFORM_TAG[platform];
  const truncMsg =
    firstMessage && firstMessage.length > 200
      ? firstMessage.slice(0, 200) + '...'
      : firstMessage || '(ללא תוכן)';

  // Identity strings differ per source platform.
  const identity =
    platform === 'whatsapp'
      ? {
          name: user.whatsapp_name || user.phone_number,
          line: `📱 *מספר:* ${formatPhoneDisplay(user.phone_number)}`,
          phone: user.phone_number,
        }
      : {
          name:
            [user.first_name, user.last_name].filter(Boolean).join(' ') ||
            (user.username ? `@${user.username}` : `id ${user.telegram_user_id}`),
          line: user.username
            ? `✈️ *Telegram:* @${user.username}`
            : `✈️ *Telegram id:* \`${user.telegram_user_id}\``,
        };

  const text =
    `🔔 *משתמש חדש מבקש גישה* (${tag})\n\n` +
    `👤 *שם:* ${identity.name}\n` +
    `${identity.line}\n` +
    `💬 *הודעה ראשונה:*\n_${truncMsg}_`;

  // Build the WhatsApp interactive buttons only when source is WA — the
  // existing button-id handlers (`approve_<phone>` etc) are phone-scoped
  // and don't translate cleanly to Telegram-id targets.
  const waButtons =
    platform === 'whatsapp'
      ? [
          { buttonId: `approve_${identity.phone}`, buttonText: { displayText: '✅ אשר' }, type: 1 },
          { buttonId: `deny_${identity.phone}`, buttonText: { displayText: '❌ דחה' }, type: 1 },
          { buttonId: `promote_${identity.phone}`, buttonText: { displayText: '👑 מנהל' }, type: 1 },
        ]
      : null;

  // Telegram callbacks reuse the admin menu's `admin_apply_*` grammar so
  // the existing handler picks up the action without any new wiring.
  const platCode = platform === 'whatsapp' ? 'wa' : 'tg';
  const tgKeyboard = {
    inline_keyboard: [
      [
        { text: '✅ אשר', callback_data: `admin_apply_${platCode}_${user.id}_approve` },
        { text: '👑 מנהל', callback_data: `admin_apply_${platCode}_${user.id}_promote` },
      ],
      [{ text: '❌ דחה', callback_data: `admin_apply_${platCode}_${user.id}_deny` }],
    ],
  };

  let textWithFallback = text;
  if (platform === 'whatsapp') {
    // The text fallback for WhatsApp also needs the slash-commands so an
    // admin without working buttons can still act.
    textWithFallback +=
      `\n━━━━━━━━━━━━━━━\n` +
      `לפעולה (אם הכפתורים לא מוצגים):\n` +
      `✅ \`/אשר ${identity.phone}\`\n` +
      `❌ \`/דחה ${identity.phone}\`\n` +
      `👑 \`/מנהל ${identity.phone}\``;
  }

  let sent = 0;
  for (const a of admins) {
    const ok = await sendToAdmin(a, {
      kind: 'pending_user',
      text: a.platform === 'whatsapp' ? textWithFallback : text,
      target: { id: user.id, phone: identity.phone },
      waButtons,
      tgKeyboard,
    });
    if (ok) sent++;
  }
  log.info(`Notified ${sent}/${admins.length} admin(s) about new ${platform} user.`);
}

export async function notifyAdminsFileMissing(item) {
  const admins = await getAllApprovedAdmins();
  if (admins.length === 0) return;
  const text =
    '⚠️ *קובץ חסר בדרייב*\n\n' +
    `📄 פריט: *${item.label}*\n` +
    `📁 שם קובץ: ${item.drive_file_name || '-'}\n` +
    `🆔 file\\_id: \`${item.drive_file_id}\`\n\n` +
    'הקובץ נמחק/הועבר. עדכן את הפריט בממשק הניהול.';
  for (const a of admins) {
    await sendToAdmin(a, { kind: 'plain', text });
  }
}

/**
 * Reply to a WhatsApp admin after performing an approval/deny/promote.
 * Kept here for backwards compatibility with adminActions.js callers.
 */
export async function sendApprovalResult(sock, adminJid, text) {
  await sock.sendMessage(adminJid, { text });
}
