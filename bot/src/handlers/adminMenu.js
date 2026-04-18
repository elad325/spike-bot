import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { formatPhoneDisplay, jidFromPhone, numberToEmoji, parseNumericReply } from '../utils/format.js';
import { sendText, sendRootMenu } from './menuHandler.js';
import { uploadDriveFile, markFileFound } from '../googleDrive.js';

/**
 * Admin-menu state machine.
 *
 * The state lives on `whatsapp_users.pending_action` (jsonb). When
 * `pending_action.scope === 'admin'`, every incoming message from this admin
 * is routed through `handleAdminInput` below instead of the regular menu.
 *
 * Steps:
 *   { scope:'admin', step:'root' }                                     - main admin menu
 *   { scope:'admin', step:'files_list' }                               - picking a file to replace
 *   { scope:'admin', step:'awaiting_file', menu_item_id, file_label }  - waiting for upload
 *   { scope:'admin', step:'users_list' }                               - picking a user to manage
 *   { scope:'admin', step:'user_actions', target_user_id }             - choosing action for user
 */

const ADMIN_ENTRY_COMMANDS = [
  'תפריט מנהלים',
  '/admin',
  '/מנהלים',
  '/adminmenu',
];

export function isAdminEntryCommand(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return ADMIN_ENTRY_COMMANDS.some((c) => c.toLowerCase() === t);
}

export function isInAdminFlow(user) {
  return user?.pending_action?.scope === 'admin';
}

async function setState(user, state) {
  await supabase.from('whatsapp_users').update({ pending_action: state }).eq('id', user.id);
  user.pending_action = state;
}

async function clearState(user) {
  await supabase.from('whatsapp_users').update({ pending_action: null }).eq('id', user.id);
  user.pending_action = null;
}

async function logOutgoing(user, type, body) {
  await supabase.from('messages').insert({
    user_id: user?.id || null,
    phone_number: user?.phone_number,
    whatsapp_name: user?.whatsapp_name,
    direction: 'outgoing',
    message_type: type,
    body,
  });
}

// ─────────────────────────── Entry ────────────────────────────

export async function enterAdminMenu(sock, jid, user) {
  await setState(user, { scope: 'admin', step: 'root' });
  await sendAdminRoot(sock, jid, user);
}

async function sendAdminRoot(sock, jid, user) {
  const text =
    `🛠 *תפריט מנהלים*\n\n` +
    `${numberToEmoji(1)} 📄 החלפת קובץ\n` +
    `${numberToEmoji(2)} 👥 ניהול משתמשים\n` +
    `${numberToEmoji(3)} 🚪 יציאה לתפריט הרגיל\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `💬 שלח את המספר של האפשרות הרצויה`;
  await sendText(sock, jid, text);
  await logOutgoing(user, 'admin_menu', '[admin root]');
}

// ─────────────────────── File replacement ─────────────────────

async function sendFileReplaceList(sock, jid, user) {
  const { data: items } = await supabase
    .from('menu_items')
    .select('id, label, drive_file_id, drive_file_name, menu_id, menus!inner(name)')
    .eq('type', 'file')
    .order('created_at', { ascending: true });

  if (!items || items.length === 0) {
    await sendText(sock, jid, '📭 אין קבצים בשום תפריט.\nשלח */admin* כדי לחזור.');
    return;
  }

  const lines = ['📄 *בחר קובץ להחלפה*', ''];
  items.forEach((it, idx) => {
    const menuName = it.menus?.name || '?';
    lines.push(`${numberToEmoji(idx + 1)} *${it.label}* _(${menuName})_`);
    if (it.drive_file_name) lines.push(`     📎 ${it.drive_file_name}`);
  });
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━');
  lines.push('💬 שלח את המספר של הקובץ שתרצה להחליף');
  lines.push('🔙 שלח *0* לחזרה');

  await setState(user, { scope: 'admin', step: 'files_list' });
  await sendText(sock, jid, lines.join('\n'));
  await logOutgoing(user, 'admin_menu', '[files list]');
}

async function promptFileUpload(sock, jid, user, item) {
  await setState(user, {
    scope: 'admin',
    step: 'awaiting_file',
    menu_item_id: item.id,
    file_label: item.label,
  });
  const text =
    `📤 *החלפת הקובץ "${item.label}"*\n\n` +
    `שלח עכשיו את הקובץ החדש בהודעה הבאה.\n` +
    `(PDF, תמונה, וידאו, מסמך - כל סוג נתמך)\n\n` +
    `🔙 שלח *0* לביטול`;
  await sendText(sock, jid, text);
  await logOutgoing(user, 'admin_menu', `[awaiting upload for ${item.label}]`);
}

async function handleFileUpload(sock, jid, user, msg) {
  const state = user.pending_action;
  if (!state?.menu_item_id) {
    await sendText(sock, jid, '❌ שגיאת מצב. נסה שוב.');
    await clearState(user);
    return;
  }

  const { data: item } = await supabase
    .from('menu_items')
    .select('*')
    .eq('id', state.menu_item_id)
    .single();

  if (!item || item.type !== 'file' || !item.drive_file_id) {
    await sendText(sock, jid, '❌ הפריט לא נמצא או שאינו קובץ.');
    await clearState(user);
    return;
  }

  await sendText(sock, jid, '⏳ מוריד את הקובץ ומעלה לדרייב...');

  // Download the WhatsApp media into a buffer
  const docMsg = msg.message?.documentMessage
    || msg.message?.imageMessage
    || msg.message?.videoMessage
    || msg.message?.audioMessage;
  const mimeType = docMsg?.mimetype || 'application/octet-stream';
  const newName = docMsg?.fileName || item.drive_file_name || `${item.label}`;

  let buffer;
  try {
    buffer = await downloadMediaMessage(msg, 'buffer', {});
  } catch (err) {
    log.error('Failed to download WhatsApp media:', err);
    await sendText(sock, jid, '❌ לא הצלחתי להוריד את הקובץ מוואטסאפ. נסה שוב.');
    return;
  }

  // Upload as a NEW file in Drive (gets a new fileId), then swap the
  // menu_items reference to point at the new file. The old Drive file is
  // left untouched — we only "replace" the link in our DB.
  try {
    const created = await uploadDriveFile(buffer, newName, mimeType);
    await supabase
      .from('menu_items')
      .update({
        drive_file_id: created.id,
        drive_file_name: created.name,
        drive_file_missing: false,
      })
      .eq('id', item.id);
    await markFileFound(item.id);

    await sendText(
      sock,
      jid,
      `✅ הקובץ "${item.label}" עודכן בהצלחה.\n` +
        `📎 ${created.name} (${Math.round((created.size || buffer.length) / 1024)} KB)\n` +
        `_(הועלה כקובץ חדש בדרייב; הקובץ הישן לא נמחק.)_\n\n` +
        `חוזר לתפריט המנהלים...`
    );
    await logOutgoing(user, 'admin_menu', `[uploaded new file for: ${item.label}]`);
  } catch (err) {
    log.error('Drive upload failed:', err);
    if (err.message?.includes('Google Drive not connected')) {
      await sendText(sock, jid, '❌ הבוט לא מחובר לדרייב. חבר אותו דרך הממשק.');
    } else {
      await sendText(sock, jid, `❌ שגיאה בהעלאת הקובץ: ${err.message}`);
    }
  }

  // Back to admin root regardless of outcome
  await setState(user, { scope: 'admin', step: 'root' });
  await sendAdminRoot(sock, jid, user);
}

// ─────────────────────── User management ──────────────────────

const STATUS_LABEL = {
  pending: '⏳ ממתין',
  approved: '✅ מאושר',
  denied: '❌ נדחה',
};

async function sendUserManagementMenu(sock, jid, user) {
  const { data: users } = await supabase
    .from('whatsapp_users')
    .select('id, phone_number, whatsapp_name, role, status')
    .order('status', { ascending: true })
    .order('created_at', { ascending: false });

  if (!users || users.length === 0) {
    await sendText(sock, jid, '📭 אין משתמשים במערכת.');
    await sendAdminRoot(sock, jid, user);
    return;
  }

  const lines = ['👥 *ניהול משתמשים*', ''];
  // Sort: pending first, then approved, then denied
  const sortKey = { pending: 0, approved: 1, denied: 2 };
  users.sort((a, b) => (sortKey[a.status] ?? 9) - (sortKey[b.status] ?? 9));

  users.forEach((u, idx) => {
    const status = STATUS_LABEL[u.status] || u.status;
    const role = u.role === 'admin' ? ' 👑' : '';
    const me = u.id === user.id ? ' _(אתה)_' : '';
    lines.push(
      `${numberToEmoji(idx + 1)} *${u.whatsapp_name || u.phone_number}*${role}${me}\n` +
        `     📱 ${formatPhoneDisplay(u.phone_number)} • ${status}`
    );
  });
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━');
  lines.push('💬 שלח את המספר של המשתמש לפעולות');
  lines.push('🔙 שלח *0* לחזרה');

  await setState(user, { scope: 'admin', step: 'users_list' });
  await sendText(sock, jid, lines.join('\n'));
  await logOutgoing(user, 'admin_menu', '[users list]');
}

async function sendUserActionsMenu(sock, jid, user, targetUser) {
  const lines = [
    `👤 *${targetUser.whatsapp_name || targetUser.phone_number}*`,
    `📱 ${formatPhoneDisplay(targetUser.phone_number)}`,
    `סטטוס: ${STATUS_LABEL[targetUser.status] || targetUser.status}`,
    `תפקיד: ${targetUser.role === 'admin' ? '👑 מנהל' : '👤 משתמש'}`,
    '',
    '*בחר פעולה:*',
  ];

  const actions = [];
  if (targetUser.status !== 'approved' || targetUser.role !== 'user') {
    actions.push({ key: 'approve', label: '✅ אשר כמשתמש רגיל' });
  }
  if (targetUser.role !== 'admin') {
    actions.push({ key: 'promote', label: '👑 קדם למנהל' });
  } else if (targetUser.id !== user.id) {
    actions.push({ key: 'demote', label: '⬇️ הסר הרשאות מנהל' });
  }
  if (targetUser.status !== 'denied' && targetUser.id !== user.id) {
    actions.push({ key: 'deny', label: '❌ דחה / חסום' });
  }

  if (actions.length === 0) {
    lines.push('_אין פעולות זמינות עליך._');
  } else {
    actions.forEach((a, idx) => lines.push(`${numberToEmoji(idx + 1)} ${a.label}`));
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━');
  lines.push('🔙 שלח *0* לחזרה לרשימה');

  await setState(user, {
    scope: 'admin',
    step: 'user_actions',
    target_user_id: targetUser.id,
    actions: actions.map((a) => a.key),
  });
  await sendText(sock, jid, lines.join('\n'));
  await logOutgoing(user, 'admin_menu', `[user actions: ${targetUser.phone_number}]`);
}

async function applyUserAction(sock, jid, user, targetUser, actionKey) {
  const updates = {};
  let summary;
  switch (actionKey) {
    case 'approve':
      updates.status = 'approved';
      updates.role = 'user';
      summary = `✅ ${targetUser.whatsapp_name} אושר כמשתמש רגיל.`;
      break;
    case 'promote':
      updates.status = 'approved';
      updates.role = 'admin';
      summary = `👑 ${targetUser.whatsapp_name} קודם למנהל.`;
      break;
    case 'demote':
      updates.role = 'user';
      summary = `⬇️ ${targetUser.whatsapp_name} ירד למשתמש רגיל.`;
      break;
    case 'deny':
      updates.status = 'denied';
      updates.role = 'user';
      summary = `❌ ${targetUser.whatsapp_name} נדחה.`;
      break;
    default:
      await sendText(sock, jid, '❌ פעולה לא תקפה.');
      return;
  }

  await supabase.from('whatsapp_users').update(updates).eq('id', targetUser.id);
  log.success(`Admin ${user.phone_number} -> ${actionKey} -> ${targetUser.phone_number}`);
  await sendText(sock, jid, summary);

  // Notify newly-approved users so they get a welcome message
  if (actionKey === 'approve' || actionKey === 'promote') {
    try {
      const targetJid = targetUser.jid || jidFromPhone(targetUser.phone_number);
      const welcome = actionKey === 'promote'
        ? `👑 ברוך הבא! קיבלת הרשאות *מנהל*.`
        : `✅ ברוך הבא! חשבונך אושר.`;
      await sock.sendMessage(targetJid, { text: welcome });
      const updated = { ...targetUser, ...updates };
      await sendRootMenu(sock, targetJid, updated);
    } catch (err) {
      log.error(`Failed to welcome ${targetUser.phone_number}:`, err.message);
    }
  }

  // Back to user list
  await sendUserManagementMenu(sock, jid, user);
}

// ─────────────────────────── Router ────────────────────────────

/**
 * Main router for an admin who is currently inside the admin flow.
 * Returns true if the message was handled (caller should stop further routing).
 */
export async function handleAdminInput(sock, jid, user, content, msg) {
  const state = user.pending_action;
  if (!state || state.scope !== 'admin') return false;

  const text = content?.text?.trim();
  const num = parseNumericReply(text);

  // Universal "exit" — the regular reset commands also leave admin mode
  if (text && ['/exit', 'יציאה', '/יציאה'].includes(text.toLowerCase())) {
    await clearState(user);
    await sendText(sock, jid, '🚪 יצאת מתפריט המנהלים.');
    await sendRootMenu(sock, jid, user);
    return true;
  }

  switch (state.step) {
    case 'root': {
      if (num === 1) {
        await sendFileReplaceList(sock, jid, user);
      } else if (num === 2) {
        await sendUserManagementMenu(sock, jid, user);
      } else if (num === 3 || num === 0) {
        await clearState(user);
        await sendText(sock, jid, '🚪 יצאת מתפריט המנהלים.');
        await sendRootMenu(sock, jid, user);
      } else {
        await sendText(sock, jid, '❌ אופציה לא תקינה. שלח 1, 2 או 3.');
      }
      return true;
    }

    case 'files_list': {
      if (num === 0) {
        await setState(user, { scope: 'admin', step: 'root' });
        await sendAdminRoot(sock, jid, user);
        return true;
      }
      if (num === null || num < 1) {
        await sendText(sock, jid, '❌ שלח מספר של קובץ או 0 לחזרה.');
        return true;
      }
      const { data: items } = await supabase
        .from('menu_items')
        .select('*')
        .eq('type', 'file')
        .order('created_at', { ascending: true });
      const item = items?.[num - 1];
      if (!item) {
        await sendText(sock, jid, '❌ מספר לא תקין.');
        return true;
      }
      await promptFileUpload(sock, jid, user, item);
      return true;
    }

    case 'awaiting_file': {
      // Cancel
      if (text && (text === '0' || text.toLowerCase() === 'ביטול')) {
        await sendText(sock, jid, '↩️ ההחלפה בוטלה.');
        await setState(user, { scope: 'admin', step: 'root' });
        await sendAdminRoot(sock, jid, user);
        return true;
      }
      // Expecting a media upload
      if (['document', 'image', 'video', 'audio'].includes(content?.type)) {
        await handleFileUpload(sock, jid, user, msg);
      } else {
        await sendText(sock, jid, '⏳ ממתין לקובץ. שלח את הקובץ או *0* לביטול.');
      }
      return true;
    }

    case 'users_list': {
      if (num === 0) {
        await setState(user, { scope: 'admin', step: 'root' });
        await sendAdminRoot(sock, jid, user);
        return true;
      }
      if (num === null || num < 1) {
        await sendText(sock, jid, '❌ שלח מספר של משתמש או 0 לחזרה.');
        return true;
      }
      const { data: users } = await supabase
        .from('whatsapp_users')
        .select('*')
        .order('status', { ascending: true })
        .order('created_at', { ascending: false });
      const sortKey = { pending: 0, approved: 1, denied: 2 };
      users?.sort((a, b) => (sortKey[a.status] ?? 9) - (sortKey[b.status] ?? 9));
      const target = users?.[num - 1];
      if (!target) {
        await sendText(sock, jid, '❌ מספר לא תקין.');
        return true;
      }
      await sendUserActionsMenu(sock, jid, user, target);
      return true;
    }

    case 'user_actions': {
      if (num === 0) {
        await sendUserManagementMenu(sock, jid, user);
        return true;
      }
      const actions = state.actions || [];
      const action = actions[num - 1];
      if (!action) {
        await sendText(sock, jid, '❌ אופציה לא תקינה.');
        return true;
      }
      const { data: target } = await supabase
        .from('whatsapp_users')
        .select('*')
        .eq('id', state.target_user_id)
        .single();
      if (!target) {
        await sendText(sock, jid, '❌ המשתמש לא נמצא.');
        await sendUserManagementMenu(sock, jid, user);
        return true;
      }
      await applyUserAction(sock, jid, user, target, action);
      return true;
    }

    default: {
      await clearState(user);
      return false;
    }
  }
}
