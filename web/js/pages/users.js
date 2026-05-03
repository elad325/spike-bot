import {
  listUsers,
  updateUser,
  deleteUser,
  subscribePending,
  listBotLinks,
  unlinkBotLink,
} from '../api.js';
import {
  toast,
  escapeHtml,
  formatRelative,
  formatPhone,
  confirmDialog,
  emptyState,
} from '../ui.js';

const STATUS_LABELS = {
  pending: { text: 'ממתין', cls: 'tag-warning' },
  approved: { text: 'מאושר', cls: 'tag-success' },
  denied: { text: 'נדחה', cls: 'tag-danger' },
};

const ROLE_LABELS = {
  user: { text: 'משתמש', cls: '' },
  admin: { text: 'מנהל', cls: 'tag-primary' },
};

const PLATFORM_META = {
  whatsapp: { icon: '🟢', label: 'WhatsApp' },
  telegram: { icon: '✈️', label: 'Telegram' },
};

export async function renderUsersPage(container) {
  let activeTab = 'pending';
  let activePlatform = 'all'; // 'all' | 'whatsapp' | 'telegram'

  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">משתמשים</h1>
          <p class="page-subtitle">ניהול הרשאות גישה (וואטסאפ + טלגרם)</p>
        </div>
      </div>
      <div class="card">
        <div class="filter-bar" style="margin-bottom:1.25rem;flex-wrap:wrap;gap:.75rem">
          <div style="display:flex;gap:.25rem;background:var(--bg-hover);padding:.25rem;border-radius:var(--radius);flex-wrap:wrap">
            <button class="btn btn-sm btn-ghost tab" data-tab="pending">ממתינים <span id="cnt-pending" class="badge" style="background:var(--warning);margin-inline-start:.25rem;display:none"></span></button>
            <button class="btn btn-sm btn-ghost tab" data-tab="approved">מאושרים</button>
            <button class="btn btn-sm btn-ghost tab" data-tab="denied">נדחו</button>
            <button class="btn btn-sm btn-ghost tab" data-tab="all">הכל</button>
          </div>
          <div style="display:flex;gap:.25rem;background:var(--bg-hover);padding:.25rem;border-radius:var(--radius);flex-wrap:wrap">
            <button class="btn btn-sm btn-ghost ptab" data-platform="all">🌐 כל הפלטפורמות</button>
            <button class="btn btn-sm btn-ghost ptab" data-platform="whatsapp">🟢 WhatsApp</button>
            <button class="btn btn-sm btn-ghost ptab" data-platform="telegram">✈️ Telegram</button>
          </div>
          <input type="search" id="user-search" placeholder="חפש לפי שם / מספר / @handle..." style="max-width:280px" />
        </div>
        <div id="users-table"></div>
      </div>
    </div>
  `;

  const tableEl = container.querySelector('#users-table');
  const searchEl = container.querySelector('#user-search');

  // Cache of bot_links so we can decorate rows with their linked counterpart
  // without an extra fetch on every refresh. Realtime triggers refetch on
  // any whatsapp_users / telegram_users change, which is the right cadence
  // for links too — they only ever change when one of the two tables does.
  let linksByWa = new Map();
  let linksByTg = new Map();

  async function refreshLinks() {
    try {
      const links = await listBotLinks();
      linksByWa = new Map(links.map((l) => [l.whatsapp_user_id, l]));
      linksByTg = new Map(links.map((l) => [l.telegram_user_id, l]));
    } catch {
      linksByWa = new Map();
      linksByTg = new Map();
    }
  }

  async function refresh() {
    let users = await listUsers();
    await refreshLinks();
    const search = searchEl.value.trim().toLowerCase();

    let filtered = users;
    if (activeTab !== 'all') filtered = filtered.filter((u) => u.status === activeTab);
    if (activePlatform !== 'all')
      filtered = filtered.filter((u) => u.platform === activePlatform);
    if (search) {
      filtered = filtered.filter((u) => userMatchesSearch(u, search));
    }

    const pendingCount = users.filter((u) => u.status === 'pending').length;
    const cntEl = container.querySelector('#cnt-pending');
    if (pendingCount > 0) {
      cntEl.textContent = pendingCount;
      cntEl.style.display = '';
    } else {
      cntEl.style.display = 'none';
    }

    if (filtered.length === 0) {
      const messages = {
        pending: { icon: '✅', title: 'אין משתמשים ממתינים', desc: 'כשמישהו חדש יכתוב לבוט - הוא יופיע כאן' },
        approved: { icon: '👥', title: 'אין משתמשים מאושרים', desc: 'אשר משתמשים מהטאב "ממתינים"' },
        denied: { icon: '🚫', title: 'אין משתמשים נדחו', desc: '' },
        all: { icon: '👤', title: 'אין משתמשים עדיין', desc: 'משתמשים יופיעו כאן ברגע שמישהו יכתוב לבוט' },
      };
      const e = messages[activeTab];
      tableEl.innerHTML = emptyState(e.icon, e.title, e.desc);
      return;
    }

    tableEl.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>פלטפורמה</th>
              <th>שם</th>
              <th>זיהוי</th>
              <th>סטטוס</th>
              <th>תפקיד</th>
              <th>קישור</th>
              <th>הצטרף</th>
              <th>הודעה אחרונה</th>
              <th style="text-align:end">פעולות</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map((u) => renderRow(u)).join('')}
          </tbody>
        </table>
      </div>
    `;

    tableEl.querySelectorAll('[data-action]').forEach((btn) =>
      btn.addEventListener('click', () =>
        handleAction(btn.dataset.action, btn.dataset.platform, btn.dataset.id)
      )
    );
  }

  function userMatchesSearch(u, q) {
    if (u.platform === 'whatsapp') {
      return (
        (u.whatsapp_name || '').toLowerCase().includes(q) ||
        (u.phone_number || '').includes(q)
      );
    }
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').toLowerCase();
    return (
      fullName.includes(q) ||
      (u.username || '').toLowerCase().includes(q) ||
      String(u.telegram_user_id).includes(q)
    );
  }

  function userIdentity(u) {
    if (u.platform === 'whatsapp') {
      return {
        displayName: u.whatsapp_name || formatPhone(u.phone_number),
        identifier: formatPhone(u.phone_number),
        identifierLtr: true,
        initial: (u.whatsapp_name || u.phone_number || '?')[0].toUpperCase(),
      };
    }
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ');
    const display =
      fullName || (u.username ? `@${u.username}` : `id ${u.telegram_user_id}`);
    return {
      displayName: display,
      identifier: u.username
        ? `@${u.username}`
        : `id: ${u.telegram_user_id}`,
      identifierLtr: true,
      initial: (fullName || u.username || String(u.telegram_user_id))[0].toUpperCase(),
    };
  }

  function linkedTag(u) {
    const link = u.platform === 'whatsapp' ? linksByWa.get(u.id) : linksByTg.get(u.id);
    if (!link) return '<span style="color:var(--text-muted)">—</span>';
    const otherIcon = u.platform === 'whatsapp' ? '✈️' : '🟢';
    return `<span class="tag tag-primary" title="קושר ב-${formatRelative(link.created_at)}" data-link-id="${link.id}">${otherIcon} מקושר</span>`;
  }

  function renderRow(u) {
    const platMeta = PLATFORM_META[u.platform];
    const status = STATUS_LABELS[u.status];
    const role = ROLE_LABELS[u.role];
    const id = userIdentity(u);

    const actions = [];
    if (u.status === 'pending') {
      actions.push(actionBtn('approve', u, '✅ אשר', 'btn-success'));
      actions.push(actionBtn('deny', u, '❌ דחה', 'btn-danger'));
      actions.push(actionBtn('promote', u, '👑 מנהל', 'btn-outline'));
    } else if (u.status === 'approved') {
      if (u.role === 'admin') {
        actions.push(actionBtn('demote', u, '⬇️ הסר מנהל', 'btn-outline'));
      } else {
        actions.push(actionBtn('promote', u, '👑 הפוך למנהל', 'btn-outline'));
      }
      actions.push(
        actionBtn('deny', u, '🚫 חסום', 'btn-ghost', 'style="color:var(--danger)"')
      );
    } else if (u.status === 'denied') {
      actions.push(actionBtn('approve', u, '✅ אשר מחדש', 'btn-success'));
    }
    // Unlink only when actually linked.
    const isLinked =
      u.platform === 'whatsapp' ? linksByWa.has(u.id) : linksByTg.has(u.id);
    if (isLinked) {
      actions.push(actionBtn('unlink', u, '🔗 בטל קישור', 'btn-ghost'));
    }
    actions.push(
      actionBtn('delete', u, '🗑️', 'btn-ghost', 'style="color:var(--danger)"')
    );

    return `
      <tr>
        <td data-label="פלטפורמה"><span class="tag" title="${platMeta.label}">${platMeta.icon} ${platMeta.label}</span></td>
        <td data-label="שם"><div style="display:flex;align-items:center;gap:.6rem"><div style="width:32px;height:32px;border-radius:50%;background:${u.platform === 'telegram' ? 'var(--accent)' : 'var(--primary)'};color:white;display:flex;align-items:center;justify-content:center;font-weight:600;flex-shrink:0">${escapeHtml(id.initial)}</div><span>${escapeHtml(id.displayName)}</span></div></td>
        <td data-label="זיהוי" style="${id.identifierLtr ? 'direction:ltr;text-align:right' : ''}">${escapeHtml(id.identifier)}</td>
        <td data-label="סטטוס"><span class="tag ${status.cls}">${status.text}</span></td>
        <td data-label="תפקיד"><span class="tag ${role.cls}">${role.text}</span></td>
        <td data-label="קישור">${linkedTag(u)}</td>
        <td data-label="הצטרף" style="color:var(--text-muted);font-size:.85rem">${formatRelative(u.created_at)}</td>
        <td data-label="הודעה אחרונה" style="color:var(--text-muted);font-size:.85rem">${u.last_message_at ? formatRelative(u.last_message_at) : '-'}</td>
        <td style="text-align:end"><div style="display:inline-flex;gap:.25rem;flex-wrap:wrap;justify-content:flex-end">${actions.join('')}</div></td>
      </tr>
    `;
  }

  function actionBtn(action, u, label, cls, extra = '') {
    return `<button class="btn btn-sm ${cls}" data-action="${action}" data-platform="${u.platform}" data-id="${u.id}" ${extra}>${label}</button>`;
  }

  async function handleAction(action, platform, id) {
    try {
      if (action === 'approve') {
        await updateUser(platform, id, { status: 'approved', role: 'user' });
        toast('המשתמש אושר', 'success');
      } else if (action === 'deny') {
        // Mirror bot-side semantics: deny always strips admin role.
        await updateUser(platform, id, { status: 'denied', role: 'user' });
        toast('המשתמש נחסם', 'success');
      } else if (action === 'promote') {
        await updateUser(platform, id, { status: 'approved', role: 'admin' });
        toast('המשתמש הוגדר כמנהל', 'success');
      } else if (action === 'demote') {
        await updateUser(platform, id, { role: 'user' });
        toast('הרשאות מנהל הוסרו', 'success');
      } else if (action === 'unlink') {
        const link =
          platform === 'whatsapp' ? linksByWa.get(id) : linksByTg.get(id);
        if (!link) return;
        const ok = await confirmDialog({
          title: 'ביטול קישור',
          message:
            'לבטל את הקישור בין חשבון WhatsApp לחשבון Telegram? המשתמש יישאר בכל פלטפורמה בנפרד.',
          danger: true,
          confirmText: 'בטל קישור',
        });
        if (!ok) return;
        await unlinkBotLink(link.id);
        toast('הקישור בוטל', 'success');
      } else if (action === 'delete') {
        const ok = await confirmDialog({
          title: 'מחיקת משתמש',
          message:
            'למחוק את המשתמש לצמיתות? כל היסטוריית ההודעות שלו תימחק. (אם הוא מקושר לפלטפורמה אחרת, החשבון השני יישאר.)',
          danger: true,
          confirmText: 'מחק',
        });
        if (!ok) return;
        await deleteUser(platform, id);
        toast('המשתמש נמחק', 'success');
      }
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Status tab clicks
  container.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      paintTabs();
      refresh();
    });
  });
  // Platform tab clicks
  container.querySelectorAll('.ptab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activePlatform = btn.dataset.platform;
      paintTabs();
      refresh();
    });
  });

  function paintTabs() {
    container.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('btn-primary', b.dataset.tab === activeTab);
      b.classList.toggle('btn-ghost', b.dataset.tab !== activeTab);
    });
    container.querySelectorAll('.ptab').forEach((b) => {
      b.classList.toggle('btn-primary', b.dataset.platform === activePlatform);
      b.classList.toggle('btn-ghost', b.dataset.platform !== activePlatform);
    });
  }
  paintTabs();

  let searchT;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(refresh, 200);
  });

  // Realtime updates — listens to both whatsapp_users and telegram_users
  // (subscribePending was widened in api.js for exactly this).
  const channel = subscribePending(refresh);

  await refresh();

  return {
    teardown: () => {
      channel?.unsubscribe();
    },
  };
}
