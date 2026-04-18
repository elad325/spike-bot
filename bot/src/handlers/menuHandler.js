import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { numberToEmoji } from '../utils/format.js';
import { downloadDriveFile, markFileMissing } from '../googleDrive.js';
import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';

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
 * Send a menu by ID. Tries the modern interactiveMessage / native-flow protocol
 * first (renders as native buttons or a list on supporting clients) and falls
 * back to plain numbered text if that fails for any reason.
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

  // Build text body — used both as the interactive body AND as the text
  // fallback if the recipient's client cannot render native flow buttons.
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

  const bodyText = lines.join('\n');

  let sent = false;
  try {
    await sendNativeFlowMenu(sock, jid, menu, items, bodyText);
    sent = true;
  } catch (err) {
    log.warn(`Native flow menu failed (will fallback to text): ${err.message}`);
  }

  if (!sent) {
    await sendText(sock, jid, bodyText);
  }

  await logOutgoing(user, user.phone_number, 'menu', `[${menu.name}]`);
}

/**
 * Render the menu as an interactive (native-flow) message.
 *  - ≤3 items → quick_reply buttons (renders as native tap-to-reply chips)
 *  - 4+ items → single_select list (renders as a dropdown selector)
 *
 * Selections come back as `interactiveResponseMessage` and are decoded by
 * `extractContent` in messageHandler.js — the `id` field matches what we set
 * here (e.g. `item_<uuid>`, `back`, `home`).
 */
async function sendNativeFlowMenu(sock, jid, menu, items, bodyText) {
  let nativeFlowButtons;

  if (items.length <= 3) {
    // Quick-reply chips. Append a "home" chip when not at root and we have
    // room for it.
    nativeFlowButtons = items.slice(0, 3).map((item, idx) => ({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: `${idx + 1}. ${item.label}`,
        id: `item_${item.id}`,
      }),
    }));

    if (!menu.is_root && nativeFlowButtons.length < 3) {
      nativeFlowButtons.push({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text: '🏠 תפריט ראשי', id: 'home' }),
      });
    }
  } else {
    // Single-select list (up to 10 rows per section).
    const rows = items.map((item, idx) => ({
      header: '',
      title: `${idx + 1}. ${item.label}`,
      description: item.type === 'submenu' ? '📂 תפריט משנה' : '📄 קובץ',
      id: `item_${item.id}`,
    }));

    if (!menu.is_root) {
      rows.push({ header: '', title: '🔙 חזרה', description: 'חזרה לתפריט הקודם', id: 'back' });
      rows.push({ header: '', title: '🏠 תפריט ראשי', description: 'חזרה להתחלה', id: 'home' });
    }

    nativeFlowButtons = [
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: '📋 הצג אפשרויות',
          sections: [{ title: menu.name, rows }],
        }),
      },
    ];
  }

  const interactiveMessage = proto.Message.InteractiveMessage.create({
    body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
    footer: proto.Message.InteractiveMessage.Footer.create({ text: 'SPIKE Bot' }),
    header: proto.Message.InteractiveMessage.Header.create({
      title: menu.name,
      subtitle: '',
      hasMediaAttachment: false,
    }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons: nativeFlowButtons,
      messageParamsJson: '',
    }),
  });

  const wam = generateWAMessageFromContent(
    jid,
    {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
          },
          interactiveMessage,
        },
      },
    },
    { userJid: sock.user?.id }
  );

  await sock.relayMessage(jid, wam.message, { messageId: wam.key.id });
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
