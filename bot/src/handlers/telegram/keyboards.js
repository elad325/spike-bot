/**
 * Reply-keyboard helpers — the persistent keyboard that sits in place of the
 * device keyboard. Inline keyboards (the ones attached to a specific message)
 * live in menuHandler.js.
 *
 * Layout principle:
 *   - All approved users get "📋 תפריט" and "❓ עזרה" — the two things they
 *     need most often, one tap away.
 *   - Admins get an additional row with admin-only entries. The reply
 *     keyboard is the right place for those because they're "modes" the
 *     admin enters from anywhere, not "actions on the current screen".
 */

const REGULAR_KEYBOARD = {
  keyboard: [
    [{ text: '📋 תפריט' }, { text: '❓ עזרה' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: '📋 תפריט' }, { text: '❓ עזרה' }],
    [{ text: '🛠 תפריט מנהלים' }, { text: '🔗 קשר חשבון' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const NO_KEYBOARD = { remove_keyboard: true };

/**
 * Pick the right reply keyboard for a given user. Pending/denied users see
 * no keyboard — they don't have anything actionable to do until they're
 * approved.
 */
export function keyboardForUser(user) {
  if (!user || user.status !== 'approved') return NO_KEYBOARD;
  if (user.role === 'admin') return ADMIN_KEYBOARD;
  return REGULAR_KEYBOARD;
}

/**
 * Map the Hebrew button labels back to the canonical command text.
 * Returns null for anything that isn't a keyboard button.
 */
export function reservedKeyboardCommand(text) {
  if (!text) return null;
  const t = text.trim();
  switch (t) {
    case '📋 תפריט':       return '/menu';
    case '❓ עזרה':         return '/help';
    case '🛠 תפריט מנהלים': return '/admin';
    case '🔗 קשר חשבון':    return '/link';
    default: return null;
  }
}
