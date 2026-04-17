/**
 * Get phone number from a WhatsApp JID (e.g. "972501234567@s.whatsapp.net" → "972501234567")
 */
export function phoneFromJid(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0];
}

/**
 * Build a WhatsApp JID from a phone number.
 */
export function jidFromPhone(phone) {
  return `${phone}@s.whatsapp.net`;
}

/**
 * Format phone for display (e.g. "972501234567" → "+972 50-123-4567")
 */
export function formatPhoneDisplay(phone) {
  if (!phone) return '';
  if (phone.startsWith('972') && phone.length === 12) {
    return `+972 ${phone.slice(3, 5)}-${phone.slice(5, 8)}-${phone.slice(8)}`;
  }
  return `+${phone}`;
}

/**
 * Number to emoji digits (for menu numbering)
 */
export function numberToEmoji(n) {
  const map = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  return map[n] || `${n}.`;
}

/**
 * Parse a numeric reply from text (handles emoji digits, hebrew/arabic numerals)
 */
export function parseNumericReply(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // Emoji digit
  const emojiMap = { '0️⃣': 0, '1️⃣': 1, '2️⃣': 2, '3️⃣': 3, '4️⃣': 4, '5️⃣': 5, '6️⃣': 6, '7️⃣': 7, '8️⃣': 8, '9️⃣': 9, '🔟': 10 };
  if (emojiMap[trimmed] !== undefined) return emojiMap[trimmed];

  // Plain number
  const n = parseInt(trimmed, 10);
  if (!isNaN(n) && String(n) === trimmed) return n;

  return null;
}
