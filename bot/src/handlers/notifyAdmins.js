import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { jidFromPhone, formatPhoneDisplay } from '../utils/format.js';

async function getAdmins() {
  const { data } = await supabase
    .from('whatsapp_users')
    .select('*')
    .eq('role', 'admin')
    .eq('status', 'approved');
  return data || [];
}

async function logAdminMessage(admin, type, body) {
  await supabase.from('messages').insert({
    user_id: admin.id,
    phone_number: admin.phone_number,
    whatsapp_name: admin.whatsapp_name,
    direction: 'outgoing',
    message_type: type,
    body,
  });
}

/**
 * Notify all admins that the bot is back online (after restart).
 */
export async function notifyAdminsBotOnline(sock) {
  const admins = await getAdmins();
  if (admins.length === 0) {
    log.info('No admins to notify on startup.');
    return;
  }

  const text = `✅ *SPIKE Bot חזר לפעולה*\n\n🤖 הבוט מחובר ומוכן לקבל הודעות.\n🕐 ${new Date().toLocaleString('he-IL')}`;

  for (const admin of admins) {
    try {
      await sock.sendMessage(jidFromPhone(admin.phone_number), { text });
      await logAdminMessage(admin, 'text', text);
    } catch (err) {
      log.error(`Failed to notify admin ${admin.phone_number}:`, err.message);
    }
  }
  log.success(`Notified ${admins.length} admin(s) that bot is online.`);
}

/**
 * Notify admins of a new pending user with action buttons.
 */
export async function notifyAdminsNewUser(sock, newUser, firstMessage) {
  const admins = await getAdmins();
  if (admins.length === 0) {
    log.warn('No admins to notify about new user. Add an admin via the dashboard!');
    return;
  }

  const phone = newUser.phone_number;
  const display = formatPhoneDisplay(phone);
  const truncMsg = firstMessage.length > 200 ? firstMessage.slice(0, 200) + '...' : firstMessage;

  const text =
    `🔔 *משתמש חדש מבקש גישה*\n\n` +
    `👤 *שם:* ${newUser.whatsapp_name}\n` +
    `📱 *מספר:* ${display}\n` +
    `💬 *הודעה ראשונה:*\n_${truncMsg}_\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `לפעולה (אם הכפתורים לא מוצגים):\n` +
    `✅ \`/אשר ${phone}\`\n` +
    `❌ \`/דחה ${phone}\`\n` +
    `👑 \`/מנהל ${phone}\``;

  for (const admin of admins) {
    const adminJid = jidFromPhone(admin.phone_number);
    let sent = false;

    // Try buttons first
    try {
      await sock.sendMessage(adminJid, {
        text,
        footer: 'בחר פעולה:',
        buttons: [
          { buttonId: `approve_${phone}`, buttonText: { displayText: '✅ אשר' }, type: 1 },
          { buttonId: `deny_${phone}`, buttonText: { displayText: '❌ דחה' }, type: 1 },
          { buttonId: `promote_${phone}`, buttonText: { displayText: '👑 מנהל' }, type: 1 },
        ],
        headerType: 1,
      });
      sent = true;
    } catch (err) {
      log.debug('Buttons failed for admin notification:', err.message);
    }

    if (!sent) {
      try {
        await sock.sendMessage(adminJid, { text });
        sent = true;
      } catch (err) {
        log.error(`Failed to notify admin ${admin.phone_number}:`, err.message);
      }
    }

    if (sent) await logAdminMessage(admin, 'text', text);
  }

  log.info(`Notified ${admins.length} admin(s) about new user ${phone}`);
}

/**
 * Notify admins that a Drive file is missing.
 */
export async function notifyAdminsFileMissing(sock, item) {
  const admins = await getAdmins();
  if (admins.length === 0) return;

  const text =
    `⚠️ *קובץ חסר בדרייב*\n\n` +
    `📄 פריט: *${item.label}*\n` +
    `📁 שם קובץ: ${item.drive_file_name || '-'}\n` +
    `🆔 file_id: \`${item.drive_file_id}\`\n\n` +
    `הקובץ נמחק/הועבר. עדכן את הפריט בממשק הניהול.`;

  for (const admin of admins) {
    try {
      await sock.sendMessage(jidFromPhone(admin.phone_number), { text });
      await logAdminMessage(admin, 'text', text);
    } catch (err) {
      log.error(`Failed to notify admin about missing file:`, err.message);
    }
  }
}

/**
 * Reply to an admin after performing an approval/deny/promote action.
 */
export async function sendApprovalResult(sock, adminJid, text) {
  await sock.sendMessage(adminJid, { text });
}
