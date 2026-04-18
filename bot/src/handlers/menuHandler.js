import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { numberToEmoji } from '../utils/format.js';
import { downloadDriveFile, markFileMissing } from '../googleDrive.js';

/**
 * Send a plain text message and log it.
 */
export async function sendText(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

async function logOutgoing(user, phone, type, body) {
  await supabase.from('messages').insert({
    user_id: user?.id || null,
    phone_number: phone,
    whatsapp_name: user?.whatsapp_name,
    direction: 'outgoing',
    message_type: type,
    body,
  });
}

/**
 * Get the root menu (the one marked is_root=true).
 */
async function getRootMenu() {
  const { data } = await supabase
    .from('menus')
    .select('*')
    .eq('is_root', true)
    .maybeSingle();
  return data;
}

export async function sendRootMenu(sock, jid, user) {
  const root = await getRootMenu();
  if (!root) {
    await sendText(sock, jid, '⚠️ הבוט עדיין לא הוגדר. נא לפנות למנהל המערכת.');
    return;
  }
  await sendMenu(sock, jid, user, root.id);
}

/**
 * Send a menu by ID as a plain numbered text message.
 *
 * We intentionally don't try interactiveMessage / nativeFlow / buttons /
 * listMessage here — WhatsApp silently drops those payloads on personal
 * accounts (they're accepted by the server but never delivered to the
 * recipient, so we can't even fall back). Numbered text is the only
 * format that works reliably end-to-end on a Baileys-linked account.
 */
export async function sendMenu(sock, jid, user, menuId) {
  const { data: menu } = await supabase
    .from('menus')
    .select('*')
    .eq('id', menuId)
    .single();

  if (!menu) {
    await sendText(sock, jid, '❌ התפריט לא נמצא.');
    return;
  }

  const { data: items } = await supabase
    .from('menu_items')
    .select('*')
    .eq('menu_id', menuId)
    .order('display_order', { ascending: true });

  if (!items || items.length === 0) {
    await sendText(sock, jid, `📭 התפריט "${menu.name}" ריק.`);
    return;
  }

  // Update user's current menu
  await supabase
    .from('whatsapp_users')
    .update({
      current_menu_id: menuId,
      last_menu_sent_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  // Build numbered text body
  const lines = [`*${menu.name}*`, ''];
  items.forEach((item, idx) => {
    const icon = item.type === 'submenu' ? '📂' : '📄';
    lines.push(`${numberToEmoji(idx + 1)} ${icon} ${item.label}`);
  });
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━');
  if (!menu.is_root) {
    lines.push('🔙 שלח *0* לחזרה');
    lines.push('🏠 שלח *#* לתפריט הראשי');
  }
  lines.push('💬 שלח את המספר של האפשרות הרצויה');

  await sendText(sock, jid, lines.join('\n'));
  await logOutgoing(user, user.phone_number, 'menu', `[${menu.name}]`);
}

/**
 * Send a PDF file from Google Drive.
 */
export async function sendFile(sock, jid, user, item) {
  if (item.drive_file_missing) {
    await sendText(sock, jid, `❌ הקובץ "${item.label}" לא זמין כרגע. הודענו למנהל.`);
    return;
  }

  await sendText(sock, jid, `⏳ טוען את הקובץ "${item.label}"...`);

  try {
    const file = await downloadDriveFile(item.drive_file_id);

    await sock.sendMessage(jid, {
      document: file.buffer,
      mimetype: file.mimeType || 'application/pdf',
      fileName: item.drive_file_name || file.name || `${item.label}.pdf`,
      caption: `📄 ${item.label}`,
    });

    await logOutgoing(user, user.phone_number, 'document', `[file: ${item.label}]`);
    log.success(`Sent file "${item.label}" to ${user.phone_number}`);

    // After sending, redisplay current menu (so they can pick another)
    if (user.current_menu_id) {
      const u = { ...user };
      await sendMenu(sock, jid, u, user.current_menu_id);
    }
  } catch (err) {
    log.error(`Failed to send file ${item.drive_file_id}:`, err.message);

    if (err.message === 'FILE_DELETED' || err.message?.includes('File not found') || err.code === 404) {
      await markFileMissing(item.id);
      await sendText(sock, jid, `❌ הקובץ "${item.label}" נמחק או הועבר. הודענו למנהל.`);
      // Notify admins
      const { notifyAdminsFileMissing } = await import('./notifyAdmins.js');
      await notifyAdminsFileMissing(sock, item);
    } else if (err.message?.includes('Google Drive not connected')) {
      await sendText(sock, jid, '❌ הבוט לא מחובר לדרייב. אנא פנה למנהל.');
    } else {
      await sendText(sock, jid, `❌ שגיאה בשליחת הקובץ. נסה שוב מאוחר יותר.`);
    }
  }
}
