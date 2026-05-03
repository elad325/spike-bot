import { CONFIG } from './config.js';

const createClient = window.__supabase_createClient;
if (!createClient) {
  throw new Error('Supabase client not loaded');
}

export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

// ============================================
// Auth
// ============================================
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

// ============================================
// App Settings
// ============================================
export async function getSettings() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .limit(1)
    .single();
  if (error) throw error;
  return data;
}

export async function updateSettings(patch) {
  const settings = await getSettings();
  const { error } = await supabase.from('app_settings').update(patch).eq('id', settings.id);
  if (error) throw error;
}

// ============================================
// Menus
// ============================================
export async function listMenus() {
  const { data, error } = await supabase
    .from('menus')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function createMenu(name, isRoot = false) {
  if (isRoot) {
    // Unset existing root first
    await supabase.from('menus').update({ is_root: false }).eq('is_root', true);
  }
  const { data, error } = await supabase
    .from('menus')
    .insert({ name, is_root: isRoot })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateMenu(id, patch) {
  if (patch.is_root) {
    await supabase.from('menus').update({ is_root: false }).eq('is_root', true);
  }
  const { error } = await supabase.from('menus').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteMenu(id) {
  const { error } = await supabase.from('menus').delete().eq('id', id);
  if (error) throw error;
}

// ============================================
// Menu Items
// ============================================
export async function listMenuItems(menuId) {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*')
    .eq('menu_id', menuId)
    .order('display_order', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * Fetch every menu_item in the system in a single round-trip — used by the
 * tree view to render the whole structure at once instead of N+1-querying
 * per menu when the user expands.
 */
export async function listAllMenuItems() {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return data;
}

export async function createMenuItem(item) {
  const { data, error } = await supabase
    .from('menu_items')
    .insert(item)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateMenuItem(id, patch) {
  const { error } = await supabase.from('menu_items').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteMenuItem(id) {
  const { error } = await supabase.from('menu_items').delete().eq('id', id);
  if (error) throw error;
}

export async function reorderMenuItems(orderedIds) {
  const updates = orderedIds.map((id, i) =>
    supabase.from('menu_items').update({ display_order: i }).eq('id', id)
  );
  await Promise.all(updates);
}

// ============================================
// Bot Users (WhatsApp + Telegram, unified surface)
// ============================================
//
// Each "user" returned here carries a `platform` discriminator so the UI
// can render and dispatch correctly without caring which underlying table
// the row came from. All cross-table consistency (linking, mirroring of
// status/role) lives in the DB layer (mirror_user_status_role trigger),
// so callers here just write to the right table and the other side
// follows along automatically.

export async function listUsers(filter = {}) {
  // Fetch both platforms in parallel, then merge + sort.
  const [waResult, tgResult] = await Promise.all([
    listWhatsappUsersRaw(filter),
    listTelegramUsersRaw(filter),
  ]);
  const merged = [
    ...waResult.map((u) => ({ ...u, platform: 'whatsapp' })),
    ...tgResult.map((u) => ({ ...u, platform: 'telegram' })),
  ];
  merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return merged;
}

async function listWhatsappUsersRaw(filter) {
  let q = supabase.from('whatsapp_users').select('*');
  if (filter.status) q = q.eq('status', filter.status);
  if (filter.role) q = q.eq('role', filter.role);
  q = q.order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function listTelegramUsersRaw(filter) {
  let q = supabase.from('telegram_users').select('*');
  if (filter.status) q = q.eq('status', filter.status);
  if (filter.role) q = q.eq('role', filter.role);
  q = q.order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function countPendingUsers() {
  const [{ count: waCount }, { count: tgCount }] = await Promise.all([
    supabase
      .from('whatsapp_users')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase
      .from('telegram_users')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
  ]);
  return (waCount || 0) + (tgCount || 0);
}

export async function updateUser(platform, id, patch) {
  const table = platformTable(platform);
  const { error } = await supabase.from(table).update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteUser(platform, id) {
  const table = platformTable(platform);
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) throw error;
}

function platformTable(platform) {
  if (platform === 'telegram') return 'telegram_users';
  return 'whatsapp_users'; // default
}

// ============================================
// Bot account links
// ============================================
//
// Returns rows with both sides expanded so the UI can show "linked to <X>"
// without an extra round-trip per user.
export async function listBotLinks() {
  const { data, error } = await supabase
    .from('bot_links')
    .select(
      'id, created_at, whatsapp_user_id, telegram_user_id'
    );
  if (error) throw error;
  return data || [];
}

export async function unlinkBotLink(id) {
  const { error } = await supabase.from('bot_links').delete().eq('id', id);
  if (error) throw error;
}

// ============================================
// Messages
// ============================================
// PostgREST `or=` parses commas / parens / dots as filter delimiters, so any
// of those inside a user search term breaks the whole query (or, worse,
// matches unintended things). Wrap each value in double-quotes and escape
// embedded `"` and `\` per PostgREST's quoting rules.
function escapeOrFilterValue(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function listMessages({
  search = '',
  phone = null,
  platform = null,
  limit = 200,
} = {}) {
  let q = supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (phone) q = q.eq('phone_number', phone);
  if (platform) q = q.eq('platform', platform);
  if (search) {
    const v = escapeOrFilterValue(`%${search}%`);
    q = q.or(`body.ilike.${v},whatsapp_name.ilike.${v},phone_number.ilike.${v}`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// ============================================
// Realtime
// ============================================
let channelCounter = 0;

export function subscribePending(cb) {
  // One channel, two table subscriptions — pending count needs to refresh
  // on changes to either platform's user table.
  const channel = supabase
    .channel(`pending-users-${++channelCounter}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'whatsapp_users' },
      () => cb()
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'telegram_users' },
      () => cb()
    )
    .subscribe();
  return {
    unsubscribe: () => supabase.removeChannel(channel),
  };
}

export function subscribeMessages(cb) {
  const channel = supabase
    .channel(`messages-stream-${++channelCounter}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) =>
      cb(payload.new)
    )
    .subscribe();
  return {
    unsubscribe: () => supabase.removeChannel(channel),
  };
}
