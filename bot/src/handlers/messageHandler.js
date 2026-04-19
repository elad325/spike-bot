import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import {
  phoneFromJid,
  phoneFromMsgKey,
  isLidJid,
  formatPhoneDisplay,
  parseNumericReply,
} from '../utils/format.js';
import { sendMenu, sendRootMenu, sendFile, sendText } from './menuHandler.js';
import {
  notifyAdminsNewUser,
  sendApprovalResult,
} from './notifyAdmins.js';
import { handleAdminAction, isAdminCommand, parseAdminCommand } from './adminActions.js';
import {
  enterAdminMenu,
  isAdminEntryCommand,
  isInAdminFlow,
  handleAdminInput,
} from './adminMenu.js';

const RESET_COMMANDS = ['תפריט', '/תפריט', '/menu', '/start', 'start', 'היי', 'שלום'];
const HELP_COMMANDS = ['/עזרה', '/help', 'עזרה', 'help'];
const BACK_INPUTS = ['0', 'חזרה', '/חזרה', 'back', '/back'];
const HOME_INPUTS = ['*', '#', 'בית', '/בית', 'home', '/home'];

/**
 * Extract a normalized message representation from the Baileys message object.
 */
function extractContent(msg) {
  const m = msg.message;
  if (!m) return null;

  if (m.conversation) {
    return { type: 'text', text: m.conversation };
  }
  if (m.extendedTextMessage?.text) {
    return { type: 'text', text: m.extendedTextMessage.text };
  }
  if (m.buttonsResponseMessage) {
    return {
      type: 'button',
      buttonId: m.buttonsResponseMessage.selectedButtonId,
      text: m.buttonsResponseMessage.selectedDisplayText,
    };
  }
  if (m.listResponseMessage?.singleSelectReply) {
    return {
      type: 'list',
      rowId: m.listResponseMessage.singleSelectReply.selectedRowId,
      text: m.listResponseMessage.title,
    };
  }
  if (m.templateButtonReplyMessage) {
    return {
      type: 'button',
      buttonId: m.templateButtonReplyMessage.selectedId,
      text: m.templateButtonReplyMessage.selectedDisplayText,
    };
  }
  if (m.interactiveResponseMessage) {
    try {
      const params = JSON.parse(
        m.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson || '{}'
      );
      return { type: 'button', buttonId: params.id, text: '' };
    } catch {
      return { type: 'unknown' };
    }
  }
  if (m.imageMessage) return { type: 'image', text: m.imageMessage.caption || '', mediaInfo: { mimetype: m.imageMessage.mimetype } };
  if (m.videoMessage) return { type: 'video', text: m.videoMessage.caption || '', mediaInfo: { mimetype: m.videoMessage.mimetype } };
  if (m.audioMessage) return { type: 'audio', mediaInfo: { mimetype: m.audioMessage.mimetype } };
  if (m.documentMessage) return { type: 'document', text: m.documentMessage.fileName || '', mediaInfo: { mimetype: m.documentMessage.mimetype } };
  if (m.stickerMessage) return { type: 'sticker' };
  if (m.locationMessage) return { type: 'location' };
  if (m.contactMessage) return { type: 'contact' };

  return { type: 'unknown' };
}

async function getOrCreateUser(phone, jid, name) {
  // Look up by phone first, then by JID. The JID lookup catches two cases:
  //   1. We previously stored this contact under their LID (because Baileys
  //      hadn't surfaced their phone yet) — now we know the real phone and
  //      want to migrate the row instead of creating a duplicate.
  //   2. The contact is LID-only and phone == LID anyway (no migration).
  const byPhone = await supabase
    .from('whatsapp_users')
    .select('*')
    .eq('phone_number', phone)
    .maybeSingle();

  let existing = byPhone.data;
  if (!existing && jid) {
    const byJid = await supabase
      .from('whatsapp_users')
      .select('*')
      .eq('jid', jid)
      .maybeSingle();
    existing = byJid.data;
  }

  if (existing) {
    const updates = {};
    if (name && name !== existing.whatsapp_name) updates.whatsapp_name = name;
    if (jid && jid !== existing.jid) updates.jid = jid;
    // Migration: if we found by JID and the stored phone_number is still the
    // old LID, replace it with the real phone we just discovered.
    let migratedFromPhone = null;
    if (phone && phone !== existing.phone_number) {
      updates.phone_number = phone;
      migratedFromPhone = existing.phone_number;
      log.info(`↻ Migrating user ${existing.id}: ${existing.phone_number} → ${phone}`);
    }
    if (Object.keys(updates).length) {
      await supabase.from('whatsapp_users').update(updates).eq('id', existing.id);
      Object.assign(existing, updates);
    }
    // When the phone migrates, retroactively rewrite the historical messages
    // table for this user so the dashboard's "history" view stops displaying
    // the old LID for past chats. One UPDATE handles arbitrarily many rows.
    if (migratedFromPhone) {
      const { error: updErr, count } = await supabase
        .from('messages')
        .update({ phone_number: phone }, { count: 'exact' })
        .eq('user_id', existing.id)
        .eq('phone_number', migratedFromPhone);
      if (updErr) log.warn(`Failed to backfill messages for ${existing.id}: ${updErr.message}`);
      else if (count) log.info(`  ↻ Backfilled ${count} historical messages → ${phone}`);
    }
    return { user: existing, isNew: false };
  }

  // Atomic upsert handles the race where two messages arrive nearly
  // simultaneously and both miss the existence check above.
  const { data: created, error } = await supabase
    .from('whatsapp_users')
    .upsert(
      {
        phone_number: phone,
        jid,
        whatsapp_name: name || phone,
        status: 'pending',
        role: 'user',
      },
      { onConflict: 'phone_number', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) {
    log.error('Failed to create user:', error);
    return { user: null, isNew: false };
  }

  const isNew = Date.now() - new Date(created.created_at).getTime() < 5000;
  return { user: created, isNew };
}

async function saveMessage({ user, phone, name, content, direction = 'incoming' }) {
  await supabase.from('messages').insert({
    user_id: user?.id || null,
    phone_number: phone,
    whatsapp_name: name,
    direction,
    message_type: content?.type || 'unknown',
    body: content?.text || null,
    media_metadata: content?.mediaInfo || null,
  });
}

/**
 * Get inactivity timeout from app_settings.
 */
async function getInactivityTimeoutMs() {
  const { data } = await supabase
    .from('app_settings')
    .select('inactivity_timeout_minutes')
    .limit(1)
    .single();
  const minutes = data?.inactivity_timeout_minutes ?? 60;
  return minutes * 60 * 1000;
}

export async function handleMessage(sock, msg) {
  // Skip own messages
  if (msg.key.fromMe) return;
  const jid = msg.key.remoteJid;
  if (!jid) return;

  // Accept both classic phone JIDs and WhatsApp's privacy-preserving @lid
  // format. Reject everything else (groups, broadcasts, status, newsletters).
  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return;

  // Real phone number: prefer remoteJidAlt (the PN that Baileys 7 surfaces
  // alongside an LID-addressed message). Falls back to the JID's user-part
  // when the phone is genuinely unknown — at worst this is the LID number,
  // matching the previous behavior.
  const phone = phoneFromMsgKey(msg.key);
  const botPhone = phoneFromJid(sock.user?.id);
  if (botPhone && phone === botPhone) return;

  const content = extractContent(msg);
  if (!content || content.type === 'unknown') return;

  const name = msg.pushName || phone;

  // Pretty-print the phone for the log (e.g. "+972 50-123-4567"); fall back
  // to a "(@lid <id>)" tag when we still only have the anonymous LID so the
  // operator can tell at a glance that no real phone was available.
  const phoneTag = isLidJid(jid) && phone === phoneFromJid(jid)
    ? `@lid ${phone}`
    : formatPhoneDisplay(phone);
  log.info(`📨 ${name} (${phoneTag}): [${content.type}] ${content.text || content.buttonId || content.rowId || ''}`);

  // Get or create user (store the original jid so replies go back via the
  // same address — LID-only contacts can't be reached via @s.whatsapp.net).
  const { user } = await getOrCreateUser(phone, jid, name);
  if (!user) return;

  const previousLastMsg = user.last_message_at ? new Date(user.last_message_at).getTime() : 0;
  const now = Date.now();

  // Update last_message_at
  await supabase
    .from('whatsapp_users')
    .update({ last_message_at: new Date(now).toISOString() })
    .eq('id', user.id);

  // Save the incoming message
  await saveMessage({ user, phone, name, content, direction: 'incoming' });

  // === Approval action from an admin ===
  // Buttons: approve_<phone> / deny_<phone> / promote_<phone>
  // Text:    /אשר <phone> / /דחה <phone> / /מנהל <phone>
  if (user.role === 'admin' && user.status === 'approved') {
    const action = parseApprovalInput(content);
    if (action) {
      await handleAdminAction(sock, action, user);
      return;
    }
    if (isAdminCommand(content.text)) {
      const cmd = parseAdminCommand(content.text);
      if (cmd) {
        await handleAdminAction(sock, cmd, user);
        return;
      }
    }

    // Admin-menu state machine: entry command opens it, otherwise route any
    // message (including media uploads) through the flow handler.
    if (isAdminEntryCommand(content.text)) {
      await enterAdminMenu(sock, jid, user);
      return;
    }
    if (isInAdminFlow(user)) {
      const handled = await handleAdminInput(sock, jid, user, content, msg);
      if (handled) return;
    }
  }

  // === Status routing ===
  if (user.status === 'denied') {
    return; // silent
  }

  if (user.status === 'pending') {
    // Count messages from this user
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('direction', 'incoming');

    if (count === 1) {
      // First-ever message - notify admins + tell user
      const { data: settings } = await supabase
        .from('app_settings')
        .select('pending_message')
        .limit(1)
        .single();

      await notifyAdminsNewUser(sock, user, content.text || `(${content.type})`);
      await sendText(sock, jid, settings?.pending_message || 'הבקשה שלך הועברה לאישור.');
      await saveMessage({
        user,
        phone,
        name,
        content: { type: 'text', text: settings?.pending_message },
        direction: 'outgoing',
      });
    }
    return;
  }

  // === Approved user ===
  await routeApprovedMessage(sock, jid, user, content, previousLastMsg, now);
}

/**
 * Parse approval-style button/list IDs.
 */
function parseApprovalInput(content) {
  const id = content.buttonId || content.rowId;
  if (!id) return null;
  if (id.startsWith('approve_')) return { action: 'approve', target: id.slice(8) };
  if (id.startsWith('deny_')) return { action: 'deny', target: id.slice(5) };
  if (id.startsWith('promote_')) return { action: 'promote', target: id.slice(8) };
  return null;
}

async function routeApprovedMessage(sock, jid, user, content, previousLastMsg, now) {
  const inactivityMs = await getInactivityTimeoutMs();
  const wasInactive = previousLastMsg > 0 && now - previousLastMsg > inactivityMs;

  // Reset to root if user has been inactive
  if (wasInactive) {
    log.info(`User ${formatPhoneDisplay(user.phone_number)} was inactive — resetting to root menu`);
    await supabase
      .from('whatsapp_users')
      .update({ current_menu_id: null })
      .eq('id', user.id);
    user.current_menu_id = null;
  }

  // Help command
  if (content.text && HELP_COMMANDS.includes(content.text.trim().toLowerCase())) {
    await sendText(
      sock,
      jid,
      '*עזרה - SPIKE Bot* 🤖\n\n' +
        '📋 שלח */תפריט* או *תפריט* כדי לראות את התפריט הראשי.\n' +
        '🔢 שלח את המספר של האפשרות הרצויה.\n' +
        '0️⃣ שלח *0* כדי לחזור אחורה.\n' +
        '🏠 שלח *#* כדי לחזור לתפריט הראשי.'
    );
    return;
  }

  // Reset commands → send root menu
  if (content.text && RESET_COMMANDS.includes(content.text.trim().toLowerCase())) {
    await sendRootMenu(sock, jid, user);
    return;
  }

  // Home shortcut
  if (content.text && HOME_INPUTS.includes(content.text.trim())) {
    await sendRootMenu(sock, jid, user);
    return;
  }

  // Button / list selection
  const id = content.buttonId || content.rowId;
  if (id) {
    await handleNavigationId(sock, jid, user, id);
    return;
  }

  // Back input
  if (content.text && BACK_INPUTS.includes(content.text.trim().toLowerCase())) {
    await goBack(sock, jid, user);
    return;
  }

  // Numeric reply → map to current menu item
  const num = content.text ? parseNumericReply(content.text) : null;
  if (num !== null && num > 0) {
    await handleNumericSelection(sock, jid, user, num);
    return;
  }

  // Anything else → resend current menu (or root)
  if (user.current_menu_id) {
    await sendMenu(sock, jid, user, user.current_menu_id);
  } else {
    await sendRootMenu(sock, jid, user);
  }
}

async function handleNavigationId(sock, jid, user, id) {
  if (id === 'home') {
    await sendRootMenu(sock, jid, user);
    return;
  }
  if (id === 'back') {
    await goBack(sock, jid, user);
    return;
  }
  if (id.startsWith('item_')) {
    const itemId = id.slice(5);
    await handleItemSelection(sock, jid, user, itemId);
    return;
  }
  if (id.startsWith('menu_')) {
    const menuId = id.slice(5);
    await sendMenu(sock, jid, user, menuId);
    return;
  }
  // Unknown → resend current menu
  if (user.current_menu_id) {
    await sendMenu(sock, jid, user, user.current_menu_id);
  } else {
    await sendRootMenu(sock, jid, user);
  }
}

async function handleNumericSelection(sock, jid, user, num) {
  const menuId = user.current_menu_id;
  if (!menuId) {
    // No current menu - send root and let user pick
    await sendRootMenu(sock, jid, user);
    return;
  }

  const { data: items } = await supabase
    .from('menu_items')
    .select('*')
    .eq('menu_id', menuId)
    .order('display_order', { ascending: true });

  if (!items || num > items.length) {
    await sendText(sock, jid, '❌ אופציה לא תקינה. נסה שוב:');
    await sendMenu(sock, jid, user, menuId);
    return;
  }

  const item = items[num - 1];
  await handleItemSelection(sock, jid, user, item.id);
}

async function handleItemSelection(sock, jid, user, itemId) {
  const { data: item } = await supabase
    .from('menu_items')
    .select('*')
    .eq('id', itemId)
    .single();

  if (!item) {
    await sendText(sock, jid, '❌ האפשרות לא נמצאה.');
    await sendRootMenu(sock, jid, user);
    return;
  }

  if (item.type === 'submenu') {
    await sendMenu(sock, jid, user, item.target_menu_id);
  } else if (item.type === 'file') {
    await sendFile(sock, jid, user, item);
  }
}

async function goBack(sock, jid, user) {
  if (!user.current_menu_id) {
    await sendRootMenu(sock, jid, user);
    return;
  }

  // Find parent menu - any menu containing an item that targets the current one
  const { data: parentItem } = await supabase
    .from('menu_items')
    .select('menu_id')
    .eq('target_menu_id', user.current_menu_id)
    .limit(1)
    .maybeSingle();

  if (!parentItem) {
    // Already at root or orphan - go home
    await sendRootMenu(sock, jid, user);
    return;
  }

  await sendMenu(sock, jid, user, parentItem.menu_id);
}
