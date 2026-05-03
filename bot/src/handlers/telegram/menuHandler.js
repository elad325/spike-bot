/**
 * Telegram menu rendering. Each menu becomes a single message with an inline
 * keyboard underneath; tapping a row fires a callback_query with a stable id
 * that messageHandler routes back here.
 *
 * Why edit-in-place by default (`editMessageText`): chasing menu state is
 * easier when each navigation step rewrites the same message, so a long
 * session doesn't fill the chat with 30 menu cards. We fall back to
 * sending a fresh message when there's no message to edit (first menu of
 * the session, or after a file send).
 */
import { InlineKeyboard, InputFile } from 'grammy';
import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { downloadDriveFile, markFileMissing } from '../../googleDrive.js';
import { getRootMenu, getMenu, getMenuItems, findParentMenuId, getItem } from '../../shared/menus.js';

/**
 * Send (or edit) the menu identified by menuId.
 *
 * `opts.editFromCallback` — when true, we try to edit the message that
 * triggered the callback (smooth in-place navigation). When false (e.g.
 * after sending a file) we always send a fresh message instead.
 */
export async function sendMenu(ctx, user, menuId, opts = {}) {
  const editFromCallback = opts.editFromCallback === true;

  if (!menuId) {
    await sendText(ctx, '❌ התפריט לא נמצא — חוזרים לתפריט הראשי.');
    await clearCurrentMenu(user);
    return sendRootMenu(ctx, user);
  }

  const menu = await getMenu(menuId);
  if (!menu) {
    await sendText(ctx, '❌ התפריט לא נמצא — חוזרים לתפריט הראשי.');
    await clearCurrentMenu(user);
    return sendRootMenu(ctx, user);
  }

  const items = await getMenuItems(menuId);
  if (items.length === 0) {
    await sendText(ctx, `📭 התפריט "${menu.name}" ריק.`);
    return;
  }

  // One row per item — keeps long labels readable. Add a navigation row
  // (back/home) only on non-root menus.
  const kb = new InlineKeyboard();
  for (const item of items) {
    const icon = item.type === 'submenu' ? '📂' : '📄';
    const missing = item.drive_file_missing ? ' ⚠️' : '';
    kb.text(`${icon} ${item.label}${missing}`, `item_${item.id}`).row();
  }
  if (!menu.is_root) {
    kb.text('🔙 חזרה', 'back').text('🏠 ראשי', 'home');
  }

  await supabase
    .from('telegram_users')
    .update({
      current_menu_id: menuId,
      last_menu_sent_at: new Date().toISOString(),
    })
    .eq('id', user.id);
  user.current_menu_id = menuId;

  const text = `*${escapeMarkdown(menu.name)}*`;

  if (editFromCallback && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        reply_markup: kb,
      });
      await logOutgoing(user, 'menu', `[${menu.name}]`);
      return;
    } catch (err) {
      // Telegram refuses to edit a message into identical content. That's
      // fine — fall through to a fresh send only if it's a different error.
      if (!/message is not modified/i.test(err.description || err.message || '')) {
        log.debug('editMessageText failed, sending fresh:', err.description);
      } else {
        return;
      }
    }
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  await logOutgoing(user, 'menu', `[${menu.name}]`);
}

export async function sendRootMenu(ctx, user, opts = {}) {
  const root = await getRootMenu();
  if (!root) {
    await sendText(ctx, '⚠️ הבוט עדיין לא הוגדר. נא לפנות למנהל המערכת.');
    return;
  }
  await sendMenu(ctx, user, root.id, opts);
}

/**
 * Send a Drive file as a Telegram document. Uses the telegram_file_cache
 * to avoid re-downloading from Drive on every send: after the first upload,
 * we keep the Telegram file_id and reuse it forever (it's stable until we
 * change the underlying Drive file id).
 */
export async function sendFile(ctx, user, item) {
  if (item.drive_file_missing) {
    await sendText(ctx, `❌ הקובץ "${item.label}" לא זמין כרגע. הודענו למנהל.`);
    return;
  }

  // Cache lookup — if we've sent this Drive file from Telegram before, just
  // forward the cached file_id. This is the big ergonomic win over WhatsApp.
  const { data: cached } = await supabase
    .from('telegram_file_cache')
    .select('telegram_file_id, file_name')
    .eq('drive_file_id', item.drive_file_id)
    .maybeSingle();

  try {
    if (cached) {
      await ctx.replyWithDocument(cached.telegram_file_id, {
        caption: `📄 ${item.label}`,
      });
      await logOutgoing(user, 'document', `[file: ${item.label}] (cached)`);
    } else {
      await ctx.reply(`⏳ טוען את "${item.label}"...`);
      const file = await downloadDriveFile(item.drive_file_id);
      const fileName = item.drive_file_name || file.name || `${item.label}.pdf`;
      const sent = await ctx.replyWithDocument(new InputFile(file.buffer, fileName), {
        caption: `📄 ${item.label}`,
      });
      // Cache the Telegram file_id for next time.
      const tgFileId = sent?.document?.file_id;
      if (tgFileId) {
        await supabase
          .from('telegram_file_cache')
          .upsert(
            {
              drive_file_id: item.drive_file_id,
              telegram_file_id: tgFileId,
              file_name: fileName,
            },
            { onConflict: 'drive_file_id' }
          );
      }
      await logOutgoing(user, 'document', `[file: ${item.label}]`);
    }

    // Resend the menu so the user can keep navigating without re-tapping
    // anything. We never edit-in-place after a file because the previous
    // message they're looking at is the document, not the menu.
    if (user.current_menu_id) {
      await sendMenu(ctx, user, user.current_menu_id, { editFromCallback: false });
    }
  } catch (err) {
    log.error(`Failed to send file ${item.drive_file_id}:`, err.message || err);

    if (
      err.message === 'FILE_DELETED' ||
      err.message?.includes('File not found') ||
      err.code === 404
    ) {
      await markFileMissing(item.id);
      await sendText(ctx, `❌ הקובץ "${item.label}" נמחק או הועבר. הודענו למנהל.`);
      const { notifyAdminsFileMissing } = await import('../notifyAdmins.js');
      await notifyAdminsFileMissing(item);
    } else if (err.message?.includes('Google Drive not connected')) {
      await sendText(ctx, '❌ הבוט לא מחובר לדרייב. אנא פנה למנהל.');
    } else {
      await sendText(ctx, '❌ שגיאה בשליחת הקובץ. נסה שוב מאוחר יותר.');
    }
  }
}

export async function goBack(ctx, user, opts = {}) {
  if (!user.current_menu_id) {
    await sendRootMenu(ctx, user, opts);
    return;
  }
  const parentId = await findParentMenuId(user.current_menu_id);
  if (!parentId) {
    await sendRootMenu(ctx, user, opts);
    return;
  }
  await sendMenu(ctx, user, parentId, opts);
}

export async function handleItemSelection(ctx, user, itemId, opts = {}) {
  const item = await getItem(itemId);
  if (!item) {
    await sendText(ctx, '❌ האפשרות לא נמצאה.');
    await sendRootMenu(ctx, user);
    return;
  }
  if (item.type === 'submenu') {
    await sendMenu(ctx, user, item.target_menu_id, opts);
  } else if (item.type === 'file') {
    await sendFile(ctx, user, item);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export async function sendText(ctx, text, extra = {}) {
  await ctx.reply(text, extra);
}

async function clearCurrentMenu(user) {
  await supabase
    .from('telegram_users')
    .update({ current_menu_id: null })
    .eq('id', user.id);
  user.current_menu_id = null;
}

async function logOutgoing(user, type, body) {
  await supabase.from('messages').insert({
    user_id: null,
    platform: 'telegram',
    telegram_user_id: user?.telegram_user_id,
    phone_number: `telegram:${user?.telegram_user_id}`,
    whatsapp_name: displayName(user),
    direction: 'outgoing',
    message_type: type,
    body,
  });
}

function displayName(user) {
  if (!user) return null;
  if (user.first_name || user.last_name) {
    return [user.first_name, user.last_name].filter(Boolean).join(' ');
  }
  return user.username ? `@${user.username}` : String(user.telegram_user_id);
}

/**
 * MarkdownV2 reserves `_ * [ ] ( ) ~ \` > # + - = | { } . !` — escape any of
 * those that show up in user-provided menu names so the parser doesn't
 * choke. Without this, a menu name containing a "." breaks the whole send.
 */
function escapeMarkdown(s) {
  if (!s) return '';
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
