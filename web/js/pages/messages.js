import { listMessages, subscribeMessages } from '../api.js';
import { escapeHtml, formatDate, formatPhone, emptyState } from '../ui.js';

export async function renderMessagesPage(container) {
  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">היסטוריית הודעות</h1>
          <p class="page-subtitle">כל ההודעות (וואטסאפ + טלגרם)</p>
        </div>
      </div>
      <div class="filter-bar">
        <input type="search" id="msg-search" placeholder="חפש בתוכן הודעות / שם / מספר / @handle..." />
        <select id="msg-direction">
          <option value="">כל ההודעות</option>
          <option value="incoming">נכנסות בלבד</option>
          <option value="outgoing">יוצאות בלבד</option>
        </select>
        <select id="msg-platform">
          <option value="">כל הפלטפורמות</option>
          <option value="whatsapp">🟢 WhatsApp בלבד</option>
          <option value="telegram">✈️ Telegram בלבד</option>
        </select>
      </div>
      <div id="messages-list" class="messages-list"></div>
    </div>
  `;

  const listEl = container.querySelector('#messages-list');
  const searchEl = container.querySelector('#msg-search');
  const directionEl = container.querySelector('#msg-direction');
  const platformEl = container.querySelector('#msg-platform');

  let allMessages = [];

  async function load() {
    const search = searchEl.value.trim();
    const platform = platformEl.value || null;
    allMessages = await listMessages({ search, platform, limit: 300 });
    render();
  }

  function render() {
    const direction = directionEl.value;
    const messages = direction
      ? allMessages.filter((m) => m.direction === direction)
      : allMessages;

    if (messages.length === 0) {
      listEl.innerHTML = emptyState('💬', 'אין הודעות', 'הודעות יופיעו כאן ברגע שמישהו יתחיל לכתוב לבוט');
      return;
    }

    listEl.innerHTML = messages.map((m) => renderMessage(m)).join('');
  }

  function renderMessage(m) {
    const isOut = m.direction === 'outgoing';
    const isTelegram = m.platform === 'telegram';

    // Identifier shown next to the message — phone for WA, "@handle" or
    // numeric id for Telegram. The phone_number column for Telegram rows
    // is a synthetic placeholder (`telegram:<id>`) so we don't pass it
    // through formatPhone — render the username/id instead.
    const identifier = isTelegram
      ? telegramIdentifier(m)
      : formatPhone(m.phone_number);
    const senderName = m.whatsapp_name || identifier;
    const initial = (m.whatsapp_name || identifier || '?')[0].toUpperCase();

    const typeBadge =
      m.message_type !== 'text'
        ? `<span class="tag" style="font-size:.65rem;padding:.05rem .4rem">${escapeHtml(m.message_type)}</span>`
        : '';
    const platformBadge = `<span class="tag" style="font-size:.65rem;padding:.05rem .4rem" title="${isTelegram ? 'Telegram' : 'WhatsApp'}">${isTelegram ? '✈️' : '🟢'}</span>`;
    const directionIcon = isOut ? '⬅️' : '➡️';
    const body = m.body || `(${m.message_type})`;

    return `
      <div class="message-row ${isOut ? 'outgoing' : ''}">
        <div class="avatar" style="background:${isOut ? 'var(--accent)' : isTelegram ? '#0088cc' : 'var(--primary)'}">${isOut ? '🤖' : escapeHtml(initial)}</div>
        <div class="content">
          <div class="header">
            <span class="name" style="${m.whatsapp_name ? '' : 'direction:ltr;unicode-bidi:embed'}">${isOut ? 'SPIKE' : escapeHtml(senderName)}</span>
            <span class="meta">${directionIcon} ${escapeHtml(identifier)}</span>
            ${platformBadge}
            ${typeBadge}
            <span class="meta" style="margin-inline-start:auto">${formatDate(m.created_at)}</span>
          </div>
          <div class="body">${escapeHtml(body)}</div>
        </div>
      </div>
    `;
  }

  // Pretty-print a Telegram message's sender. Prefer the cached display name
  // already on the row, then a synthetic `@<id>` token so the admin still
  // has something LTR-stable to copy.
  function telegramIdentifier(m) {
    if (m.telegram_user_id) return `tg:${m.telegram_user_id}`;
    // phone_number for legacy rows that pre-date the platform column would
    // already be a real phone; keep formatting it.
    return formatPhone(m.phone_number);
  }

  let searchT;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(load, 250);
  });
  directionEl.addEventListener('change', render);
  // Platform is server-side so we re-fetch on change, not just re-render.
  platformEl.addEventListener('change', load);

  // Realtime
  const channel = subscribeMessages((newMsg) => {
    allMessages.unshift(newMsg);
    if (allMessages.length > 300) allMessages.pop();
    render();
  });

  await load();

  return {
    teardown: () => channel?.unsubscribe(),
  };
}
