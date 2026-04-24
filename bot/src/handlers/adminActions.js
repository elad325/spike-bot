import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { formatPhoneDisplay, deliverableJid } from '../utils/format.js';
import { sendText, sendRootMenu } from './menuHandler.js';
import { sendApprovalResult } from './notifyAdmins.js';

const ADMIN_COMMAND_RE = /^\/(אשר|דחה|מנהל|approve|deny|promote)\s+(\S+)$/i;

const COMMAND_MAP = {
  'אשר': 'approve',
  'approve': 'approve',
  'דחה': 'deny',
  'deny': 'deny',
  'מנהל': 'promote',
  'promote': 'promote',
};

export function isAdminCommand(text) {
  if (!text) return false;
  return ADMIN_COMMAND_RE.test(text.trim());
}

export function parseAdminCommand(text) {
  if (!text) return null;
  const m = text.trim().match(ADMIN_COMMAND_RE);
  if (!m) return null;
  const action = COMMAND_MAP[m[1].toLowerCase()];
  if (!action) return null;
  return { action, target: m[2] };
}

/**
 * Handle an admin action (approve/deny/promote a user).
 * @param {string} action - 'approve' | 'deny' | 'promote'
 * @param {string} target - phone number of target user
 */
export async function handleAdminAction(sock, { action, target }, admin) {
  const adminJid = deliverableJid(admin);

  // Look up target user
  const { data: targetUser } = await supabase
    .from('whatsapp_users')
    .select('*')
    .eq('phone_number', target)
    .maybeSingle();

  if (!targetUser) {
    await sendApprovalResult(sock, adminJid, `❌ לא נמצא משתמש עם מספר ${formatPhoneDisplay(target)}`);
    return;
  }

  if (targetUser.role === 'admin' && action !== 'deny') {
    await sendApprovalResult(sock, adminJid, `ℹ️ המשתמש כבר מנהל.`);
    return;
  }

  switch (action) {
    case 'approve':
      await approveUser(sock, targetUser, admin, false);
      break;
    case 'deny':
      await denyUser(sock, targetUser, admin);
      break;
    case 'promote':
      await approveUser(sock, targetUser, admin, true);
      break;
  }
}

async function approveUser(sock, targetUser, admin, asAdmin) {
  const adminJid = deliverableJid(admin);
  const targetJid = deliverableJid(targetUser);

  await supabase
    .from('whatsapp_users')
    .update({
      status: 'approved',
      role: asAdmin ? 'admin' : 'user',
    })
    .eq('id', targetUser.id);

  log.success(
    `Admin ${formatPhoneDisplay(admin.phone_number)} ${asAdmin ? 'promoted' : 'approved'} ${formatPhoneDisplay(targetUser.phone_number)}`
  );

  // Notify admin
  await sendApprovalResult(
    sock,
    adminJid,
    asAdmin
      ? `👑 ${targetUser.whatsapp_name} (${formatPhoneDisplay(targetUser.phone_number)}) הוגדר כמנהל.`
      : `✅ ${targetUser.whatsapp_name} (${formatPhoneDisplay(targetUser.phone_number)}) אושר.`
  );

  // Notify the user
  const { data: settings } = await supabase
    .from('app_settings')
    .select('welcome_message')
    .limit(1)
    .single();

  const welcome = asAdmin
    ? `👑 ברוך הבא! קיבלת הרשאות *מנהל*. השתמש בתפריט להלן:`
    : settings?.welcome_message || 'ברוכים הבאים!';

  try {
    await sock.sendMessage(targetJid, { text: welcome });
    const updated = { ...targetUser, status: 'approved', role: asAdmin ? 'admin' : 'user', current_menu_id: null };
    await sendRootMenu(sock, targetJid, updated);
  } catch (err) {
    log.error(`Failed to send welcome to ${formatPhoneDisplay(targetUser.phone_number)}:`, err.message);
  }
}

async function denyUser(sock, targetUser, admin) {
  const adminJid = deliverableJid(admin);

  await supabase
    .from('whatsapp_users')
    .update({ status: 'denied', role: 'user' })
    .eq('id', targetUser.id);

  log.info(`Admin ${formatPhoneDisplay(admin.phone_number)} denied ${formatPhoneDisplay(targetUser.phone_number)}`);

  await sendApprovalResult(
    sock,
    adminJid,
    `❌ ${targetUser.whatsapp_name} (${formatPhoneDisplay(targetUser.phone_number)}) נדחה.`
  );
  // Don't notify the denied user (silent)
}
