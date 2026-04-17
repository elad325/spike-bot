import { listMessages, subscribeMessages } from '../api.js';
import { escapeHtml, formatDate, formatPhone, emptyState } from '../ui.js';

export async function renderMessagesPage(container) {
  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">היסטוריית הודעות</h1>
          <p class="page-subtitle">כל ההודעות מ-30 הימים האחרונים</p>
        </div>
      </div>
      <div class="filter-bar">
        <input type="search" id="msg-search" placeholder="חפש בתוכן הודעות / שם / מספר..." />
        <select id="msg-direction">
          <option value="">כל ההודעות</option>
          <option value="incoming">נכנסות בלבד</option>
          <option value="outgoing">יוצאות בלבד</option>
        </select>
      </div>
      <div id="messages-list" class="messages-list"></div>
    </div>
  `;

  const listEl = container.querySelector('#messages-list');
  const searchEl = container.querySelector('#msg-search');
  const directionEl = container.querySelector('#msg-direction');

  let allMessages = [];

  async function load() {
    const search = searchEl.value.trim();
    allMessages = await listMessages({ search, limit: 300 });
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
    const initial = (m.whatsapp_name || m.phone_number || '?')[0].toUpperCase();
    const typeBadge = m.message_type !== 'text' ? `<span class="tag" style="font-size:.65rem;padding:.05rem .4rem">${escapeHtml(m.message_type)}</span>` : '';
    const directionIcon = isOut ? '⬅️' : '➡️';
    const body = m.body || `(${m.message_type})`;

    return `
      <div class="message-row ${isOut ? 'outgoing' : ''}">
        <div class="avatar" style="background:${isOut ? 'var(--accent)' : 'var(--primary)'}">${isOut ? '🤖' : initial}</div>
        <div class="content">
          <div class="header">
            <span class="name">${isOut ? 'SPIKE' : escapeHtml(m.whatsapp_name || '-')}</span>
            <span class="meta">${directionIcon} ${formatPhone(m.phone_number)}</span>
            ${typeBadge}
            <span class="meta" style="margin-inline-start:auto">${formatDate(m.created_at)}</span>
          </div>
          <div class="body">${escapeHtml(body)}</div>
        </div>
      </div>
    `;
  }

  let searchT;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(load, 250);
  });
  directionEl.addEventListener('change', render);

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
