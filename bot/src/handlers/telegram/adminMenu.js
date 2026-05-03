/**
 * Telegram admin flow.
 *
 * Modeled after the WhatsApp adminMenu but using inline keyboards and
 * callback_data instead of numeric text replies. State machine still lives
 * on `telegram_users.pending_action` (jsonb).
 *
 * Callback grammar (single namespace, scoped with `admin_`):
 *   admin_root                          - redraw the admin home screen
 *   admin_exit                          - leave admin mode
 *   admin_files[_p<N>]                  - file-replace list, page N (0-based)
 *   admin_replace_<itemId>              - pick a file to replace; arms upload
 *   admin_cancel_replace                - cancel an awaiting-file state
 *   admin_users_<plat>[_p<N>]           - user list for plat=wa|tg, page N
 *   admin_user_<plat>_<userId>          - drill into a single user
 *   admin_apply_<plat>_<userId>_<act>   - apply approve|promote|demote|deny
 *
 * Pagination: 8 items per page is the sweet spot — fits on phones without
 * scrolling and leaves room for nav buttons.
 */
import { InlineKeyboard, InputFile } from 'grammy';
import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { uploadDriveFile, markFileFound } from '../../googleDrive.js';
import { applyLinkedUpdate } from '../../shared/users.js';
import { sendText, sendRootMenu } from './menuHandler.js';
import { keyboardForUser } from './keyboards.js';

const ENTRY_COMMANDS = [
  '/admin',
  '/adminmenu',
  '/מנהלים',
  'תפריט מנהלים',
];

const PAGE_SIZE = 8;

const STATUS_LABEL = {
  pending: '⏳ ממתין',
  approved: '✅ מאושר',
  denied: '❌ נדחה',
};

const ACTION_LABEL = {
  approve: '✅ אשר',
  promote: '👑 קדם למנהל',
  demote: '⬇️ הסר מנהל',
  deny: '❌ דחה / חסום',
};

// ─── Public API ────────────────────────────────────────────────────────

export function isAdminEntryCommand(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return ENTRY_COMMANDS.some((c) => c.toLowerCase() === t);
}

export function isInAdminFlow(user) {
  return user?.pending_action?.scope === 'admin';
}

export async function enterAdminMenu(ctx, user) {
  await setState(user, { scope: 'admin', step: 'root' });
  await sendAdminRoot(ctx, user);
}

/**
 * Plain-message router (file uploads, cancellations). Returns true if
 * handled. Inline-button presses go through handleAdminCallback instead.
 */
export async function handleAdminInput(ctx, user, content) {
  const state = user.pending_action;
  if (!state || state.scope !== 'admin') return false;

  // Universal exit phrases — work from any admin step.
  const text = content?.type === 'text' ? content.text?.trim() : null;
  if (text && ['/exit', 'יציאה', '/יציאה'].includes(text.toLowerCase())) {
    await leaveAdminMode(ctx, user);
    return true;
  }

  if (state.step === 'awaiting_file') {
    return handleAwaitingFileMessage(ctx, user, content);
  }

  // Any other text inside admin mode just redraws the current view.
  if (text) {
    await sendAdminRoot(ctx, user);
    return true;
  }

  return false;
}

/**
 * Inline-button router. Called for every callback_query whose data starts
 * with `admin_`. Returns void — caller has already cleared the spinner.
 */
export async function handleAdminCallback(ctx, user, data) {
  // Anyone can land here even outside an active admin flow (e.g. tapping
  // an old admin message). Re-enter the flow on demand if they're an admin.
  if (user.role !== 'admin') return;

  if (data === 'admin_root') {
    await setState(user, { scope: 'admin', step: 'root' });
    return sendAdminRoot(ctx, user, { editFromCallback: true });
  }
  if (data === 'admin_exit') {
    await leaveAdminMode(ctx, user, { editFromCallback: true });
    return;
  }

  // Files list (paginated)
  let m = data.match(/^admin_files(?:_p(\d+))?$/);
  if (m) {
    const page = m[1] ? parseInt(m[1], 10) : 0;
    return sendFilesList(ctx, user, page, { editFromCallback: true });
  }

  m = data.match(/^admin_replace_(.+)$/);
  if (m) {
    return promptReplaceFile(ctx, user, m[1]);
  }

  if (data === 'admin_cancel_replace') {
    await setState(user, { scope: 'admin', step: 'root' });
    await sendText(ctx, '↩️ ההחלפה בוטלה.');
    return sendAdminRoot(ctx, user);
  }

  // User lists (per platform, paginated)
  m = data.match(/^admin_users_(wa|tg)(?:_p(\d+))?$/);
  if (m) {
    const platform = m[1] === 'wa' ? 'whatsapp' : 'telegram';
    const page = m[2] ? parseInt(m[2], 10) : 0;
    return sendUsersList(ctx, user, platform, page, { editFromCallback: true });
  }

  m = data.match(/^admin_user_(wa|tg)_(.+)$/);
  if (m) {
    const platform = m[1] === 'wa' ? 'whatsapp' : 'telegram';
    return sendUserActions(ctx, user, platform, m[2], { editFromCallback: true });
  }

  m = data.match(/^admin_apply_(wa|tg)_([a-f0-9-]+)_(approve|promote|demote|deny)$/);
  if (m) {
    const platform = m[1] === 'wa' ? 'whatsapp' : 'telegram';
    return applyAction(ctx, user, platform, m[2], m[3]);
  }

  log.debug(`Unrecognised admin callback: ${data}`);
}

// ─── Admin home ────────────────────────────────────────────────────────

async function sendAdminRoot(ctx, user, opts = {}) {
  const text = '🛠 *תפריט מנהלים*\n\nבחר פעולה:';
  const kb = new InlineKeyboard()
    .text('📄 החלפת קובץ', 'admin_files').row()
    .text('🟢 ניהול משתמשי WhatsApp', 'admin_users_wa').row()
    .text('✈️ ניהול משתמשי Telegram', 'admin_users_tg').row()
    .text('🚪 יציאה', 'admin_exit');

  await renderAdmin(ctx, user, text, kb, opts);
}

async function leaveAdminMode(ctx, user, opts = {}) {
  await clearState(user);
  if (opts.editFromCallback && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText('🚪 יצאת מתפריט המנהלים.', { reply_markup: undefined });
    } catch {}
  } else {
    await ctx.reply('🚪 יצאת מתפריט המנהלים.', { reply_markup: keyboardForUser(user) });
  }
  await sendRootMenu(ctx, user);
}

// ─── File replacement ─────────────────────────────────────────────────

async function sendFilesList(ctx, user, page, opts = {}) {
  // Disambiguating FK hint: menu_items has TWO FKs to menus, and PostgREST
  // can't infer which one to embed. Without `!menu_items_menu_id_fkey` the
  // entire query silently returns null. (Same pitfall as the WhatsApp
  // admin menu — see commit ea556ff.)
  const { data: items, error } = await supabase
    .from('menu_items')
    .select('id, label, drive_file_name, menus!menu_items_menu_id_fkey(name)')
    .eq('type', 'file')
    .order('created_at', { ascending: true });

  if (error) {
    await sendText(ctx, `❌ שגיאה בטעינת הקבצים: ${error.message}`);
    return;
  }
  if (!items || items.length === 0) {
    await sendText(ctx, '📭 אין קבצים בשום תפריט.');
    return sendAdminRoot(ctx, user, opts);
  }

  const totalPages = Math.ceil(items.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = items.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const kb = new InlineKeyboard();
  for (const it of slice) {
    const menuName = it.menus?.name || '?';
    // Telegram caps button text at 64 chars; truncate gracefully.
    const label = truncate(`📄 ${it.label} (${menuName})`, 60);
    kb.text(label, `admin_replace_${it.id}`).row();
  }
  appendPagination(kb, 'admin_files', safePage, totalPages);
  kb.text('🔙 חזרה', 'admin_root');

  await setState(user, { scope: 'admin', step: 'files_list' });

  const header =
    `📄 *בחר קובץ להחלפה*\n` +
    `_עמוד ${safePage + 1} מתוך ${totalPages} (${items.length} קבצים)_`;
  await renderAdmin(ctx, user, header, kb, opts);
}

async function promptReplaceFile(ctx, user, itemId) {
  const { data: item } = await supabase
    .from('menu_items')
    .select('*')
    .eq('id', itemId)
    .maybeSingle();
  if (!item || item.type !== 'file') {
    await sendText(ctx, '❌ הפריט לא נמצא או שאינו קובץ.');
    return sendAdminRoot(ctx, user);
  }

  await setState(user, {
    scope: 'admin',
    step: 'awaiting_file',
    menu_item_id: item.id,
    file_label: item.label,
  });

  const text =
    `📤 *החלפת הקובץ "${item.label}"*\n\n` +
    'שלח עכשיו את הקובץ החדש בהודעה הבאה.\n' +
    '(PDF / מסמך / תמונה — כל סוג נתמך)';
  const kb = new InlineKeyboard().text('❌ ביטול', 'admin_cancel_replace');

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function handleAwaitingFileMessage(ctx, user, content) {
  // If the admin typed text instead of sending a file, remind them.
  if (content?.type === 'text') {
    await sendText(ctx, '⏳ ממתין לקובץ. שלח קובץ או לחץ ❌ ביטול.');
    return true;
  }

  if (!['document', 'image', 'video', 'audio'].includes(content?.type)) {
    await sendText(ctx, '❌ סוג קובץ לא נתמך. שלח document/image/video/audio.');
    return true;
  }

  const state = user.pending_action;
  if (!state?.menu_item_id) {
    await clearState(user);
    await sendText(ctx, '❌ שגיאת מצב. נסה שוב.');
    return true;
  }

  const { data: item } = await supabase
    .from('menu_items')
    .select('*')
    .eq('id', state.menu_item_id)
    .single();
  if (!item || item.type !== 'file' || !item.drive_file_id) {
    await clearState(user);
    await sendText(ctx, '❌ הפריט לא נמצא או שאינו קובץ.');
    return true;
  }

  await sendText(ctx, '⏳ מוריד את הקובץ ומעלה לדרייב...');

  // Pull the file bytes from Telegram. ctx.getFile resolves the file_id to
  // a path on Telegram's CDN; we then fetch that URL and buffer the body.
  let buffer;
  let mime = content.mediaInfo?.mimetype || 'application/octet-stream';
  let fileName = content.mediaInfo?.file_name || item.drive_file_name || `${item.label}`;

  try {
    const file = await ctx.getFile();
    const url = file.getUrl
      ? file.getUrl()
      : `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    buffer = Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    log.error('Failed to fetch Telegram file:', err);
    await sendText(ctx, '❌ לא הצלחתי להוריד את הקובץ מטלגרם. נסה שוב.');
    return true;
  }

  try {
    const created = await uploadDriveFile(buffer, fileName, mime);
    await supabase
      .from('menu_items')
      .update({
        drive_file_id: created.id,
        drive_file_name: created.name,
        drive_file_missing: false,
      })
      .eq('id', item.id);
    await markFileFound(item.id);

    // Bust the Telegram cache for the OLD drive_file_id so users get the
    // fresh file on their next request rather than the stale cached one.
    await supabase
      .from('telegram_file_cache')
      .delete()
      .eq('drive_file_id', item.drive_file_id);

    await sendText(
      ctx,
      `✅ הקובץ "${item.label}" עודכן בהצלחה.\n` +
        `📎 ${created.name} (${Math.round((created.size || buffer.length) / 1024)} KB)`
    );
  } catch (err) {
    log.error('Drive upload failed:', err);
    if (err.message?.includes('Google Drive not connected')) {
      await sendText(ctx, '❌ הבוט לא מחובר לדרייב. חבר אותו דרך הממשק.');
    } else {
      await sendText(ctx, `❌ שגיאה בהעלאת הקובץ: ${err.message}`);
    }
  }

  await setState(user, { scope: 'admin', step: 'root' });
  await sendAdminRoot(ctx, user);
  return true;
}

// ─── User management ──────────────────────────────────────────────────

async function sendUsersList(ctx, user, platform, page, opts = {}) {
  const table = platform === 'whatsapp' ? 'whatsapp_users' : 'telegram_users';
  const { data: usersAll } = await supabase
    .from(table)
    .select('*')
    .order('created_at', { ascending: false });

  if (!usersAll || usersAll.length === 0) {
    await sendText(ctx, '📭 אין משתמשים.');
    return sendAdminRoot(ctx, user, opts);
  }

  // Show pending first, then approved, then denied — matches the dashboard
  // and the WhatsApp admin menu's ordering.
  const sortKey = { pending: 0, approved: 1, denied: 2 };
  usersAll.sort((a, b) => (sortKey[a.status] ?? 9) - (sortKey[b.status] ?? 9));

  const totalPages = Math.ceil(usersAll.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = usersAll.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const kb = new InlineKeyboard();
  for (const u of slice) {
    const label = userListLabel(platform, u, user);
    const platCode = platform === 'whatsapp' ? 'wa' : 'tg';
    kb.text(truncate(label, 60), `admin_user_${platCode}_${u.id}`).row();
  }
  const platCode = platform === 'whatsapp' ? 'wa' : 'tg';
  appendPagination(kb, `admin_users_${platCode}`, safePage, totalPages);
  kb.text('🔙 חזרה', 'admin_root');

  await setState(user, { scope: 'admin', step: 'users_list', platform });

  const platLabel = platform === 'whatsapp' ? 'WhatsApp' : 'Telegram';
  const header =
    `👥 *ניהול משתמשי ${platLabel}*\n` +
    `_עמוד ${safePage + 1} מתוך ${totalPages} (${usersAll.length} משתמשים)_`;
  await renderAdmin(ctx, user, header, kb, opts);
}

function userListLabel(platform, target, viewer) {
  const status = STATUS_LABEL[target.status] || target.status;
  const role = target.role === 'admin' ? ' 👑' : '';
  const me = isSelf(platform, target, viewer) ? ' (אתה)' : '';
  if (platform === 'whatsapp') {
    const name = target.whatsapp_name || target.phone_number;
    return `${status} ${name}${role}${me}`;
  }
  const name =
    [target.first_name, target.last_name].filter(Boolean).join(' ') ||
    (target.username ? `@${target.username}` : String(target.telegram_user_id));
  return `${status} ${name}${role}${me}`;
}

function isSelf(platform, target, viewer) {
  // The viewer is always a Telegram admin (this is the Telegram admin menu).
  // They're "self" only if managing the Telegram users table on their own row.
  return platform === 'telegram' && target.id === viewer.id;
}

async function sendUserActions(ctx, user, platform, targetId, opts = {}) {
  const table = platform === 'whatsapp' ? 'whatsapp_users' : 'telegram_users';
  const { data: target } = await supabase
    .from(table)
    .select('*')
    .eq('id', targetId)
    .maybeSingle();

  if (!target) {
    await sendText(ctx, '❌ המשתמש לא נמצא.');
    return sendUsersList(ctx, user, platform, 0, opts);
  }

  const self = isSelf(platform, target, user);
  const lines = [];
  if (platform === 'whatsapp') {
    lines.push(`👤 *${target.whatsapp_name || target.phone_number}*`);
    lines.push(`📱 ${target.phone_number}`);
  } else {
    const name =
      [target.first_name, target.last_name].filter(Boolean).join(' ') ||
      (target.username ? `@${target.username}` : `id ${target.telegram_user_id}`);
    lines.push(`👤 *${name}*`);
    if (target.username) lines.push(`@${target.username}`);
    lines.push(`id: \`${target.telegram_user_id}\``);
  }
  lines.push(`סטטוס: ${STATUS_LABEL[target.status] || target.status}`);
  lines.push(`תפקיד: ${target.role === 'admin' ? '👑 מנהל' : '👤 משתמש'}`);
  lines.push('');
  lines.push('*בחר פעולה:*');

  const kb = new InlineKeyboard();
  const platCode = platform === 'whatsapp' ? 'wa' : 'tg';
  const actions = availableActions(target, self);
  if (actions.length === 0) {
    lines.push('_אין פעולות זמינות._');
  } else {
    for (const a of actions) {
      kb.text(ACTION_LABEL[a], `admin_apply_${platCode}_${target.id}_${a}`).row();
    }
  }
  kb.text('🔙 חזרה לרשימה', `admin_users_${platCode}`).text('🏠 ראשי', 'admin_root');

  await setState(user, {
    scope: 'admin',
    step: 'user_actions',
    platform,
    target_id: target.id,
  });

  await renderAdmin(ctx, user, lines.join('\n'), kb, opts);
}

function availableActions(target, isSelfRow) {
  const actions = [];
  // Don't offer "approve" on yourself — would silently demote the current
  // admin (status=approved, role=user). Same self-protect logic as the
  // WhatsApp admin menu.
  if (!isSelfRow && (target.status !== 'approved' || target.role !== 'user')) {
    actions.push('approve');
  }
  if (target.role !== 'admin') {
    actions.push('promote');
  } else if (!isSelfRow) {
    actions.push('demote');
  }
  if (target.status !== 'denied' && !isSelfRow) {
    actions.push('deny');
  }
  return actions;
}

async function applyAction(ctx, user, platform, targetId, action) {
  const table = platform === 'whatsapp' ? 'whatsapp_users' : 'telegram_users';
  const { data: target } = await supabase
    .from(table)
    .select('*')
    .eq('id', targetId)
    .maybeSingle();
  if (!target) {
    await sendText(ctx, '❌ המשתמש לא נמצא.');
    return sendUsersList(ctx, user, platform, 0);
  }

  const patch = patchForAction(action);
  if (!patch) {
    await sendText(ctx, '❌ פעולה לא תקפה.');
    return;
  }

  await applyLinkedUpdate(platform, target.id, patch);

  const platLabel = platform === 'whatsapp' ? 'WhatsApp' : 'Telegram';
  const targetName =
    platform === 'whatsapp'
      ? target.whatsapp_name || target.phone_number
      : [target.first_name, target.last_name].filter(Boolean).join(' ') ||
        target.username ||
        target.telegram_user_id;

  const summary = {
    approve: `✅ ${targetName} (${platLabel}) אושר.`,
    promote: `👑 ${targetName} (${platLabel}) קודם למנהל.`,
    demote: `⬇️ ${targetName} (${platLabel}) ירד למשתמש רגיל.`,
    deny: `❌ ${targetName} (${platLabel}) נחסם.`,
  }[action];
  await sendText(ctx, summary);

  // Welcome newly-approved users on whichever channel they're on.
  if (action === 'approve' || action === 'promote') {
    await welcomeAcrossChannels(target, platform, action);
  }

  // Back to the same list page so the admin can continue working.
  await sendUsersList(ctx, user, platform, 0);
}

function patchForAction(action) {
  switch (action) {
    case 'approve': return { status: 'approved', role: 'user' };
    case 'promote': return { status: 'approved', role: 'admin' };
    case 'demote':  return { role: 'user' };
    case 'deny':    return { status: 'denied', role: 'user' };
    default: return null;
  }
}

async function welcomeAcrossChannels(target, platform, action) {
  const welcomeText =
    action === 'promote'
      ? '👑 ברוך הבא! קיבלת הרשאות מנהל.'
      : '✅ ברוך הבא! חשבונך אושר.';

  if (platform === 'telegram') {
    try {
      const { getTelegramBot } = await import('../../telegram.js');
      const tg = getTelegramBot();
      if (tg) {
        await tg.api.sendMessage(target.chat_id, welcomeText);
      }
    } catch (err) {
      log.warn('Telegram welcome failed:', err.message);
    }
  } else {
    try {
      const { getSock } = await import('../../whatsapp.js');
      const { deliverableJid } = await import('../../utils/format.js');
      const sock = getSock();
      if (sock) {
        await sock.sendMessage(deliverableJid(target), { text: welcomeText });
      }
    } catch (err) {
      log.warn('WhatsApp welcome failed:', err.message);
    }
  }
}

// ─── State + rendering helpers ─────────────────────────────────────────

async function setState(user, state) {
  await supabase.from('telegram_users').update({ pending_action: state }).eq('id', user.id);
  user.pending_action = state;
}

async function clearState(user) {
  await supabase.from('telegram_users').update({ pending_action: null }).eq('id', user.id);
  user.pending_action = null;
}

async function renderAdmin(ctx, user, text, kb, opts = {}) {
  if (opts.editFromCallback && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: kb,
      });
      return;
    } catch (err) {
      if (!/message is not modified/i.test(err.description || err.message || '')) {
        log.debug('editMessageText admin failed:', err.description);
      } else {
        return;
      }
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

function appendPagination(kb, baseCallback, page, totalPages) {
  if (totalPages <= 1) return;
  const buttons = [];
  if (page > 0) buttons.push({ label: '⏪ הקודם', data: `${baseCallback}_p${page - 1}` });
  if (page < totalPages - 1) buttons.push({ label: 'הבא ⏩', data: `${baseCallback}_p${page + 1}` });
  if (buttons.length) {
    for (const b of buttons) kb.text(b.label, b.data);
    kb.row();
  }
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
