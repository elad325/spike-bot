/**
 * Top-level router for any update coming from the Telegram bot.
 *
 * Responsibilities, in order:
 *   1. Resolve / create the telegram_users row, sync display fields if they
 *      changed (username, first_name, etc.).
 *   2. Log the incoming message into the shared `messages` table so the
 *      dashboard sees both platforms in one place.
 *   3. Status routing (pending → notify admins, denied → silent, approved
 *      → menu / admin flow).
 *   4. For approved admins, hand off to adminMenu when the admin is in a
 *      flow or just typed an entry command.
 *   5. For everyone else, hand off to menuHandler.
 *
 * Inline button presses arrive as `callback_query` updates; those go through
 * `handleTelegramCallback` instead and follow a parallel routing path.
 */
import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { keyboardForUser, reservedKeyboardCommand } from './keyboards.js';
import {
  sendMenu,
  sendRootMenu,
  sendText,
  goBack,
  handleItemSelection,
} from './menuHandler.js';
import {
  enterAdminMenu,
  isAdminEntryCommand,
  isInAdminFlow,
  handleAdminInput,
  handleAdminCallback,
} from './adminMenu.js';
import { notifyAdminsNewUser } from '../notifyAdmins.js';
import { redeemLinkToken, issueLinkToken } from '../../shared/users.js';

const RESET_COMMANDS = ['/menu', '/start', 'תפריט', 'היי', 'שלום'];
const HELP_COMMANDS = ['/help', 'עזרה'];

// ─── Public entrypoints ────────────────────────────────────────────────

export async function handleTelegramUpdate(ctx) {
  if (!ctx.from || ctx.from.is_bot) return;

  const { user, isNew } = await getOrCreateUser(ctx);
  if (!user) return;

  const content = extractContent(ctx);
  if (!content) return;

  await logIncoming(user, content);

  // Bump last_message_at *before* routing so downstream code that reads
  // the user row (e.g. inactivity reset) sees fresh data on its second
  // hop. Inactivity reset itself is computed against the previous value
  // captured here.
  const previousLastMsg = user.last_message_at
    ? new Date(user.last_message_at).getTime()
    : 0;
  const now = Date.now();
  await supabase
    .from('telegram_users')
    .update({ last_message_at: new Date(now).toISOString() })
    .eq('id', user.id);

  // /start with a link token comes in regardless of user status — a fresh
  // Telegram user needs to be able to redeem a token to become an admin.
  if (content.type === 'text' && content.text) {
    const linkPayload = parseLinkPayload(content.text);
    if (linkPayload) {
      await handleStartLink(ctx, user, linkPayload);
      return;
    }
  }

  // Status routing
  if (user.status === 'denied') {
    return; // silent
  }

  if (user.status === 'pending') {
    await handlePending(ctx, user, content);
    return;
  }

  // === Approved user ===
  await routeApproved(ctx, user, content, previousLastMsg, now);
}

/**
 * Handle inline-button presses. Routes to admin flow if the user is in one,
 * otherwise to standard menu navigation.
 */
export async function handleTelegramCallback(ctx) {
  if (!ctx.from || ctx.from.is_bot) return;

  const { user } = await getOrCreateUser(ctx);
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'שגיאה — נסה שוב', show_alert: false });
    return;
  }

  const data = ctx.callbackQuery?.data || '';

  if (user.status !== 'approved') {
    await ctx.answerCallbackQuery({
      text: user.status === 'pending'
        ? '⏳ הבקשה שלך עדיין ממתינה לאישור'
        : 'אין לך גישה',
      show_alert: true,
    });
    return;
  }

  // Admin callbacks are namespaced with `admin_` so we route them first.
  if (data.startsWith('admin_')) {
    await ctx.answerCallbackQuery();
    await handleAdminCallback(ctx, user, data);
    return;
  }

  // Standard menu navigation — clear the spinner immediately so the UI
  // feels snappy regardless of how long the rest takes.
  await ctx.answerCallbackQuery();

  if (data === 'home') {
    await sendRootMenu(ctx, user, { editFromCallback: true });
    return;
  }
  if (data === 'back') {
    await goBack(ctx, user, { editFromCallback: true });
    return;
  }
  if (data.startsWith('item_')) {
    await handleItemSelection(ctx, user, data.slice(5), { editFromCallback: true });
    return;
  }
  // Unknown callback — resend current menu
  if (user.current_menu_id) {
    await sendMenu(ctx, user, user.current_menu_id, { editFromCallback: true });
  } else {
    await sendRootMenu(ctx, user, { editFromCallback: true });
  }
}

// ─── Per-status routing ────────────────────────────────────────────────

async function handlePending(ctx, user, content) {
  // Mirror the WhatsApp behaviour: notify admins exactly once on the first
  // incoming message from this pending user.
  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('platform', 'telegram')
    .eq('telegram_user_id', user.telegram_user_id)
    .eq('direction', 'incoming');

  if (count === 1) {
    const { data: settings } = await supabase
      .from('app_settings')
      .select('pending_message')
      .limit(1)
      .single();

    await notifyAdminsNewUser({
      platform: 'telegram',
      user,
      firstMessage: content.text || `(${content.type})`,
    });

    const text = settings?.pending_message || 'הבקשה שלך הועברה לאישור.';
    await ctx.reply(text);
    await logOutgoing(user, 'text', text);
  }
}

async function routeApproved(ctx, user, content, previousLastMsg, now) {
  // Inactivity reset — same semantics as WhatsApp. Pulls timeout from
  // app_settings so it stays unified across platforms.
  const inactivityMs = await getInactivityTimeoutMs();
  if (previousLastMsg > 0 && now - previousLastMsg > inactivityMs) {
    log.info(`Telegram user @${user.username || user.telegram_user_id} inactive — resetting`);
    await supabase
      .from('telegram_users')
      .update({ current_menu_id: null })
      .eq('id', user.id);
    user.current_menu_id = null;
  }

  // Translate keyboard taps into canonical commands. The reply keyboard
  // emits literal Hebrew strings; map them to /menu, /help, /admin, /link.
  let text = content.type === 'text' ? content.text?.trim() : null;
  if (text) {
    const mapped = reservedKeyboardCommand(text);
    if (mapped) text = mapped;
  }

  // Cross-platform linking — admins only.
  if (text === '/link' && user.role === 'admin') {
    await issueAndShowLinkInstructions(ctx, user);
    return;
  }
  // Anyone redeeming a paste-in token (alternative to deep-link) goes here.
  if (text?.startsWith('/קשר ') || text?.startsWith('/link ')) {
    const token = text.split(/\s+/)[1];
    if (token) {
      await tryRedeemFromText(ctx, user, token);
      return;
    }
  }

  // Help
  if (text && HELP_COMMANDS.includes(text.toLowerCase())) {
    await sendHelp(ctx, user);
    return;
  }

  // Admin entry & in-flow handling
  if (user.role === 'admin') {
    if (text && isAdminEntryCommand(text)) {
      await enterAdminMenu(ctx, user);
      return;
    }
    if (isInAdminFlow(user)) {
      const handled = await handleAdminInput(ctx, user, content);
      if (handled) return;
    }
  }

  // Reset commands → root
  if (text && RESET_COMMANDS.includes(text.toLowerCase())) {
    await sendRootMenu(ctx, user);
    return;
  }

  // Anything else from an approved user → resend current menu (or root)
  if (user.current_menu_id) {
    await sendMenu(ctx, user, user.current_menu_id);
  } else {
    await sendRootMenu(ctx, user);
  }
}

async function sendHelp(ctx, user) {
  const text =
    '*עזרה — SPIKE Bot* 🤖\n\n' +
    '📋 לחץ על *תפריט* (או שלח /menu) להציג את התפריט הראשי.\n' +
    '🔘 לחץ על הכפתורים שמתחת להודעות כדי לבחור.\n' +
    '🔙 כפתור "חזרה" חוזר תפריט אחד אחורה.\n' +
    '🏠 כפתור "ראשי" קופץ לתפריט הראשי.\n' +
    (user.role === 'admin'
      ? '\n*אדמין:*\n🛠 *תפריט מנהלים* — ניהול קבצים ומשתמשים.\n🔗 *קשר חשבון* — קישור לחשבון WhatsApp שלך.'
      : '');
  await ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: keyboardForUser(user),
  });
  await logOutgoing(user, 'text', text);
}

// ─── Linking ───────────────────────────────────────────────────────────

function parseLinkPayload(text) {
  // Telegram's deep-link `/start <payload>` arrives as a regular message
  // with the payload appended to /start. We accept both `link_<token>` and
  // `link-<token>` for robustness.
  const m = text.match(/^\/start(?:@\w+)?\s+link[_\-]([a-f0-9]{16,64})$/i);
  return m ? m[1] : null;
}

async function handleStartLink(ctx, user, token) {
  const result = await redeemLinkToken(token, 'telegram', user.id);
  if (!result.ok) {
    const msg = {
      invalid: 'קוד קישור לא תקף.',
      expired: 'קוד הקישור פג תוקף. צור חדש בבוט וואטסאפ.',
      consumed: 'הקוד כבר נוצל.',
      self: 'אי אפשר לקשר חשבון לעצמו.',
    }[result.reason] || 'לא הצלחתי לקשר את החשבון.';
    await ctx.reply(`❌ ${msg}`);
    await logOutgoing(user, 'text', msg);
    return;
  }

  // Refresh the user row — redeem may have promoted us to admin.
  const refreshed = await reloadUser(user.id);
  Object.assign(user, refreshed);

  const text =
    '✅ *החשבונות קושרו בהצלחה*\n\n' +
    `🟢 WhatsApp: \`${result.sourceUser.phone_number}\`\n` +
    `✈️ Telegram: @${user.username || user.telegram_user_id}\n\n` +
    `הסטטוס שלך כאן: *${prettyStatus(refreshed.status)}*` +
    (refreshed.role === 'admin' ? ' 👑' : '');
  await ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: keyboardForUser(refreshed),
  });
  await logOutgoing(user, 'text', text);

  // Drop them straight into the root menu since they're approved now.
  if (refreshed.status === 'approved') {
    await sendRootMenu(ctx, refreshed);
  }
}

async function issueAndShowLinkInstructions(ctx, user) {
  if (user.role !== 'admin') {
    await ctx.reply('אין לך הרשאה לפקודה זו.');
    return;
  }
  const { token, expiresAt } = await issueLinkToken('telegram', user.id);
  const minutesLeft = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000);

  const text =
    '🔗 *קישור חשבון Telegram ↔ WhatsApp*\n\n' +
    'מהבוט בוואטסאפ, שלח את הפקודה הבאה מהמספר שלך כאדמין:\n\n' +
    `\`/קשר ${token}\`\n\n` +
    `⏳ הקוד תקף ל-${minutesLeft} דקות.`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
  await logOutgoing(user, 'text', text);
}

async function tryRedeemFromText(ctx, user, token) {
  const result = await redeemLinkToken(token, 'telegram', user.id);
  if (!result.ok) {
    const msg = {
      invalid: 'קוד קישור לא תקף.',
      expired: 'הקוד פג תוקף.',
      consumed: 'הקוד כבר נוצל.',
      self: 'אי אפשר לקשר חשבון לעצמו.',
    }[result.reason] || 'הקישור נכשל.';
    await ctx.reply(`❌ ${msg}`);
    return;
  }
  const refreshed = await reloadUser(user.id);
  Object.assign(user, refreshed);
  await ctx.reply('✅ קישור החשבון בוצע בהצלחה.');
}

// ─── User lookup ───────────────────────────────────────────────────────

async function getOrCreateUser(ctx) {
  const tgId = ctx.from?.id;
  if (!tgId) return { user: null, isNew: false };

  const chatId = ctx.chat?.id ?? tgId;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || null;
  const lastName = ctx.from.last_name || null;

  const { data: existing } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('telegram_user_id', tgId)
    .maybeSingle();

  if (existing) {
    const updates = {};
    if (chatId !== existing.chat_id) updates.chat_id = chatId;
    if (username !== existing.username) updates.username = username;
    if (firstName !== existing.first_name) updates.first_name = firstName;
    if (lastName !== existing.last_name) updates.last_name = lastName;
    if (Object.keys(updates).length) {
      await supabase.from('telegram_users').update(updates).eq('id', existing.id);
      Object.assign(existing, updates);
    }
    return { user: existing, isNew: false };
  }

  const { data: created, error } = await supabase
    .from('telegram_users')
    .insert({
      telegram_user_id: tgId,
      chat_id: chatId,
      username,
      first_name: firstName,
      last_name: lastName,
      status: 'pending',
      role: 'user',
    })
    .select()
    .single();

  if (error) {
    log.error('Failed to create telegram user:', error);
    return { user: null, isNew: false };
  }
  return { user: created, isNew: true };
}

async function reloadUser(id) {
  const { data } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('id', id)
    .single();
  return data;
}

// ─── Content extraction ────────────────────────────────────────────────

/**
 * Normalise a Telegram message to the same shape as the WhatsApp content
 * object: { type, text?, mediaInfo? }. The admin file-upload flow needs
 * access to the raw message for ctx.getFile, so callers grab that off ctx
 * directly.
 */
function extractContent(ctx) {
  const m = ctx.message;
  if (!m) return null;

  if (m.text) return { type: 'text', text: m.text };
  if (m.document) {
    return {
      type: 'document',
      text: m.caption || '',
      mediaInfo: { mimetype: m.document.mime_type, file_id: m.document.file_id, file_name: m.document.file_name },
    };
  }
  if (m.photo) {
    // Telegram sends an array of sizes; keep the largest.
    const largest = m.photo[m.photo.length - 1];
    return {
      type: 'image',
      text: m.caption || '',
      mediaInfo: { mimetype: 'image/jpeg', file_id: largest.file_id },
    };
  }
  if (m.video) {
    return {
      type: 'video',
      text: m.caption || '',
      mediaInfo: { mimetype: m.video.mime_type, file_id: m.video.file_id },
    };
  }
  if (m.audio) {
    return {
      type: 'audio',
      text: m.caption || '',
      mediaInfo: { mimetype: m.audio.mime_type, file_id: m.audio.file_id },
    };
  }
  if (m.voice) {
    return { type: 'audio', mediaInfo: { mimetype: m.voice.mime_type, file_id: m.voice.file_id } };
  }
  if (m.sticker) return { type: 'sticker' };
  if (m.location) return { type: 'location' };
  if (m.contact) return { type: 'contact' };

  return { type: 'unknown' };
}

// ─── Logging helpers ───────────────────────────────────────────────────

async function logIncoming(user, content) {
  await supabase.from('messages').insert({
    user_id: null, // messages.user_id FKs whatsapp_users only — leave null for telegram
    platform: 'telegram',
    telegram_user_id: user.telegram_user_id,
    phone_number: `telegram:${user.telegram_user_id}`,
    whatsapp_name: displayName(user),
    direction: 'incoming',
    message_type: content?.type || 'unknown',
    body: content?.text || null,
    media_metadata: content?.mediaInfo || null,
  });
}

async function logOutgoing(user, type, body) {
  await supabase.from('messages').insert({
    user_id: null,
    platform: 'telegram',
    telegram_user_id: user.telegram_user_id,
    phone_number: `telegram:${user.telegram_user_id}`,
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

function prettyStatus(s) {
  return { pending: 'ממתין', approved: 'מאושר', denied: 'נדחה' }[s] || s;
}

async function getInactivityTimeoutMs() {
  const { data } = await supabase
    .from('app_settings')
    .select('inactivity_timeout_minutes')
    .limit(1)
    .single();
  const minutes = data?.inactivity_timeout_minutes ?? 60;
  return minutes * 60 * 1000;
}
