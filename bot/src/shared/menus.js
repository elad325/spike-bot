/**
 * Pure menu lookups against the DB. No platform knowledge.
 *
 * Both the WhatsApp and Telegram handlers call into these functions and then
 * decide on their own how to render the result (numbered text vs. inline
 * keyboards). The single source of truth for the menu tree lives in the
 * `menus` and `menu_items` tables — change a label in the dashboard and
 * both bots pick it up on the next message.
 */
import { supabase } from '../supabase.js';

export async function getRootMenu() {
  const { data } = await supabase
    .from('menus')
    .select('*')
    .eq('is_root', true)
    .maybeSingle();
  return data;
}

export async function getMenu(menuId) {
  if (!menuId) return null;
  const { data } = await supabase
    .from('menus')
    .select('*')
    .eq('id', menuId)
    .maybeSingle();
  return data;
}

export async function getMenuItems(menuId) {
  if (!menuId) return [];
  const { data } = await supabase
    .from('menu_items')
    .select('*')
    .eq('menu_id', menuId)
    .order('display_order', { ascending: true });
  return data || [];
}

export async function getItem(itemId) {
  if (!itemId) return null;
  const { data } = await supabase
    .from('menu_items')
    .select('*')
    .eq('id', itemId)
    .maybeSingle();
  return data;
}

/**
 * Find the parent menu of a given menu — i.e. any menu whose items reference
 * `menuId` as their target. There can be more than one parent (the same
 * submenu can be linked from multiple places); we return the first by
 * insertion order, which matches what the user most likely expects from a
 * "back" gesture.
 */
export async function findParentMenuId(menuId) {
  if (!menuId) return null;
  const { data } = await supabase
    .from('menu_items')
    .select('menu_id')
    .eq('target_menu_id', menuId)
    .limit(1)
    .maybeSingle();
  return data?.menu_id ?? null;
}
