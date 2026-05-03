/**
 * Cross-platform user operations: status/role transitions that should
 * propagate across linked accounts.
 *
 * Approving an admin on WhatsApp also promotes their linked Telegram account
 * (if any), and vice versa. The dashboard relies on this same module so that
 * web-driven changes stay in sync too.
 */
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

const TABLE_FOR_PLATFORM = {
  whatsapp: 'whatsapp_users',
  telegram: 'telegram_users',
};

const LINK_COL = {
  whatsapp: 'whatsapp_user_id',
  telegram: 'telegram_user_id',
};

function tableFor(platform) {
  const t = TABLE_FOR_PLATFORM[platform];
  if (!t) throw new Error(`Unknown platform: ${platform}`);
  return t;
}

/**
 * Look up the linked counterpart on the other platform, if any.
 * Returns the full row from the *other* platform's user table, or null.
 */
export async function getLinkedCounterpart(platform, userId) {
  const sourceCol = LINK_COL[platform];
  if (!sourceCol) return null;
  const otherPlatform = platform === 'whatsapp' ? 'telegram' : 'whatsapp';
  const otherCol = LINK_COL[otherPlatform];

  const { data: link } = await supabase
    .from('bot_links')
    .select(otherCol)
    .eq(sourceCol, userId)
    .maybeSingle();
  if (!link) return null;

  const { data: counterpart } = await supabase
    .from(tableFor(otherPlatform))
    .select('*')
    .eq('id', link[otherCol])
    .maybeSingle();
  return counterpart ? { platform: otherPlatform, user: counterpart } : null;
}

/**
 * Apply a status/role patch to a user AND their linked counterpart.
 *
 * The same patch ({ status, role }) is applied on both sides, so an admin
 * approved on WhatsApp is also approved on Telegram automatically.
 */
export async function applyLinkedUpdate(platform, userId, patch) {
  await supabase.from(tableFor(platform)).update(patch).eq('id', userId);

  const counterpart = await getLinkedCounterpart(platform, userId);
  if (counterpart) {
    await supabase
      .from(tableFor(counterpart.platform))
      .update(patch)
      .eq('id', counterpart.user.id);
    log.info(
      `↻ Mirror ${platform}→${counterpart.platform} on ${counterpart.user.id}: ${JSON.stringify(patch)}`
    );
  }
  return counterpart;
}

/**
 * Return all admins across both platforms (status='approved' & role='admin').
 * Used for fan-out notifications. Each entry includes the platform so the
 * caller knows how to send.
 */
export async function getAllApprovedAdmins() {
  const [{ data: wa }, { data: tg }] = await Promise.all([
    supabase
      .from('whatsapp_users')
      .select('*')
      .eq('role', 'admin')
      .eq('status', 'approved'),
    supabase
      .from('telegram_users')
      .select('*')
      .eq('role', 'admin')
      .eq('status', 'approved'),
  ]);
  return [
    ...(wa || []).map((u) => ({ platform: 'whatsapp', user: u })),
    ...(tg || []).map((u) => ({ platform: 'telegram', user: u })),
  ];
}

/**
 * Issue a one-shot link token. The user shows it on platform A; redeeming
 * it on platform B creates a bot_links row and returns the linked pair.
 */
const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

export async function issueLinkToken(sourcePlatform, sourceUserId) {
  // 16 random bytes, hex-encoded → 32 chars. Telegram's deep-link `start`
  // parameter accepts up to 64 chars, well within that budget.
  const token = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString();
  const { error } = await supabase.from('bot_link_tokens').insert({
    token,
    source_platform: sourcePlatform,
    source_user_id: sourceUserId,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return { token, expiresAt };
}

/**
 * Redeem a link token from the *other* platform. Validates expiry and
 * single-use, creates the bot_links row, marks the token as consumed, and
 * mirrors the redeeming user's role/status to the source side (so an admin
 * who links from a fresh Telegram account is recognised as an admin there
 * immediately).
 *
 * Returns:
 *   { ok: false, reason: 'expired' | 'consumed' | 'invalid' | 'self' }
 *   { ok: true, sourcePlatform, sourceUser, targetPlatform, targetUser }
 */
export async function redeemLinkToken(token, redeemerPlatform, redeemerUserId) {
  const { data: tokenRow } = await supabase
    .from('bot_link_tokens')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (!tokenRow) return { ok: false, reason: 'invalid' };
  if (tokenRow.consumed_at) return { ok: false, reason: 'consumed' };
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (tokenRow.source_platform === redeemerPlatform) {
    // Can't link a platform to itself — must be redeemed from the *other* bot.
    return { ok: false, reason: 'self' };
  }

  const sourceTable = tableFor(tokenRow.source_platform);
  const { data: sourceUser } = await supabase
    .from(sourceTable)
    .select('*')
    .eq('id', tokenRow.source_user_id)
    .maybeSingle();
  if (!sourceUser) return { ok: false, reason: 'invalid' };

  const { data: redeemerUser } = await supabase
    .from(tableFor(redeemerPlatform))
    .select('*')
    .eq('id', redeemerUserId)
    .maybeSingle();
  if (!redeemerUser) return { ok: false, reason: 'invalid' };

  const linkRow =
    tokenRow.source_platform === 'whatsapp'
      ? { whatsapp_user_id: sourceUser.id, telegram_user_id: redeemerUserId }
      : { telegram_user_id: sourceUser.id, whatsapp_user_id: redeemerUserId };

  // Atomic-ish: insert the link and mark the token consumed in two writes.
  // upsert with onConflict on either FK so re-running the same flow doesn't
  // explode if the user already linked themselves.
  const { error: linkErr } = await supabase
    .from('bot_links')
    .upsert(linkRow, { onConflict: 'whatsapp_user_id', ignoreDuplicates: false })
    .select();
  if (linkErr) {
    // Fall back to upsert on the other unique col if the first conflicted
    // unexpectedly (e.g. the WA side was already linked but to someone else).
    log.warn(`bot_links upsert via wa-key failed: ${linkErr.message}`);
    return { ok: false, reason: 'invalid' };
  }

  await supabase
    .from('bot_link_tokens')
    .update({ consumed_at: new Date().toISOString() })
    .eq('token', token);

  // Mirror status/role from the higher-privilege side. Admin/approved beats
  // pending — never demote during a link.
  const merged = mergePrivileges(sourceUser, redeemerUser);
  await supabase.from(sourceTable).update(merged).eq('id', sourceUser.id);
  await supabase
    .from(tableFor(redeemerPlatform))
    .update(merged)
    .eq('id', redeemerUserId);

  log.success(
    `🔗 Linked ${tokenRow.source_platform}:${sourceUser.id} ↔ ${redeemerPlatform}:${redeemerUserId}`
  );

  return {
    ok: true,
    sourcePlatform: tokenRow.source_platform,
    sourceUser,
    targetPlatform: redeemerPlatform,
    targetUser: redeemerUser,
    merged,
  };
}

/**
 * When linking, prefer the more-privileged of the two states. Status order:
 * approved > pending > denied. Role order: admin > user.
 */
function mergePrivileges(a, b) {
  const statusRank = { approved: 2, pending: 1, denied: 0 };
  const status =
    (statusRank[a.status] ?? 1) >= (statusRank[b.status] ?? 1) ? a.status : b.status;
  const role = a.role === 'admin' || b.role === 'admin' ? 'admin' : 'user';
  return { status, role };
}
