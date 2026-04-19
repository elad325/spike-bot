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
// WhatsApp Users
// ============================================
export async function listUsers(filter = {}) {
  let q = supabase.from('whatsapp_users').select('*');
  if (filter.status) q = q.eq('status', filter.status);
  if (filter.role) q = q.eq('role', filter.role);
  q = q.order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function countPendingUsers() {
  const { count, error } = await supabase
    .from('whatsapp_users')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) return 0;
  return count || 0;
}

export async function updateUser(id, patch) {
  const { error } = await supabase.from('whatsapp_users').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteUser(id) {
  const { error } = await supabase.from('whatsapp_users').delete().eq('id', id);
  if (error) throw error;
}

// ============================================
// Messages
// ============================================
export async function listMessages({ search = '', phone = null, limit = 200 } = {}) {
  let q = supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (phone) q = q.eq('phone_number', phone);
  if (search) q = q.or(`body.ilike.%${search}%,whatsapp_name.ilike.%${search}%,phone_number.ilike.%${search}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// ============================================
// Realtime
// ============================================
let channelCounter = 0;

export function subscribePending(cb) {
  const channel = supabase
    .channel(`pending-users-${++channelCounter}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'whatsapp_users' },
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
