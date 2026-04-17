import { listUsers, updateUser, deleteUser, subscribePending } from '../api.js';
import { toast, escapeHtml, formatRelative, formatPhone, confirmDialog, emptyState } from '../ui.js';

const STATUS_LABELS = {
  pending: { text: 'ממתין', cls: 'tag-warning' },
  approved: { text: 'מאושר', cls: 'tag-success' },
  denied: { text: 'נדחה', cls: 'tag-danger' },
};

const ROLE_LABELS = {
  user: { text: 'משתמש', cls: '' },
  admin: { text: 'מנהל', cls: 'tag-primary' },
};

export async function renderUsersPage(container) {
  let activeTab = 'pending';

  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">משתמשים</h1>
          <p class="page-subtitle">ניהול הרשאות גישה לבוט וואטסאפ</p>
        </div>
      </div>
      <div class="card">
        <div class="filter-bar" style="margin-bottom:1.25rem">
          <div style="display:flex;gap:.25rem;background:var(--bg-hover);padding:.25rem;border-radius:var(--radius);flex-wrap:wrap">
            <button class="btn btn-sm btn-ghost tab" data-tab="pending">ממתינים <span id="cnt-pending" class="badge" style="background:var(--warning);margin-inline-start:.25rem;display:none"></span></button>
            <button class="btn btn-sm btn-ghost tab" data-tab="approved">מאושרים</button>
            <button class="btn btn-sm btn-ghost tab" data-tab="denied">נדחו</button>
            <button class="btn btn-sm btn-ghost tab" data-tab="all">הכל</button>
          </div>
          <input type="search" id="user-search" placeholder="חפש לפי שם / מספר..." style="max-width:300px" />
        </div>
        <div id="users-table"></div>
      </div>
    </div>
  `;

  const tableEl = container.querySelector('#users-table');
  const searchEl = container.querySelector('#user-search');

  async function refresh() {
    let users = await listUsers();
    const search = searchEl.value.trim().toLowerCase();

    let filtered = users;
    if (activeTab !== 'all') filtered = users.filter((u) => u.status === activeTab);
    if (search) {
      filtered = filtered.filter(
        (u) =>
          (u.whatsapp_name || '').toLowerCase().includes(search) ||
          u.phone_number.includes(search)
      );
    }

    // Update pending counter
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
              <th>שם</th>
              <th>מספר</th>
              <th>סטטוס</th>
              <th>תפקיד</th>
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
      btn.addEventListener('click', () => handleAction(btn.dataset.action, btn.dataset.id))
    );
  }

  function renderRow(u) {
    const status = STATUS_LABELS[u.status];
    const role = ROLE_LABELS[u.role];
    const initial = (u.whatsapp_name || '?')[0].toUpperCase();

    let actions = [];
    if (u.status === 'pending') {
      actions.push('<button class="btn btn-sm btn-success" data-action="approve" data-id="' + u.id + '">✅ אשר</button>');
      actions.push('<button class="btn btn-sm btn-danger" data-action="deny" data-id="' + u.id + '">❌ דחה</button>');
      actions.push('<button class="btn btn-sm btn-outline" data-action="promote" data-id="' + u.id + '">👑 מנהל</button>');
    } else if (u.status === 'approved') {
      if (u.role === 'admin') {
        actions.push('<button class="btn btn-sm btn-outline" data-action="demote" data-id="' + u.id + '">⬇️ הסר מנהל</button>');
      } else {
        actions.push('<button class="btn btn-sm btn-outline" data-action="promote" data-id="' + u.id + '">👑 הפוך למנהל</button>');
      }
      actions.push('<button class="btn btn-sm btn-ghost" data-action="deny" data-id="' + u.id + '" style="color:var(--danger)">🚫 חסום</button>');
    } else if (u.status === 'denied') {
      actions.push('<button class="btn btn-sm btn-success" data-action="approve" data-id="' + u.id + '">✅ אשר מחדש</button>');
    }
    actions.push('<button class="btn btn-sm btn-ghost" data-action="delete" data-id="' + u.id + '" style="color:var(--danger)">🗑️</button>');

    return `
      <tr>
        <td><div style="display:flex;align-items:center;gap:.6rem"><div style="width:32px;height:32px;border-radius:50%;background:var(--primary);color:white;display:flex;align-items:center;justify-content:center;font-weight:600">${initial}</div>${escapeHtml(u.whatsapp_name || '-')}</div></td>
        <td style="direction:ltr;text-align:right">${formatPhone(u.phone_number)}</td>
        <td><span class="tag ${status.cls}">${status.text}</span></td>
        <td><span class="tag ${role.cls}">${role.text}</span></td>
        <td style="color:var(--text-muted);font-size:.85rem">${formatRelative(u.created_at)}</td>
        <td style="color:var(--text-muted);font-size:.85rem">${u.last_message_at ? formatRelative(u.last_message_at) : '-'}</td>
        <td style="text-align:end"><div style="display:inline-flex;gap:.25rem">${actions.join('')}</div></td>
      </tr>
    `;
  }

  async function handleAction(action, id) {
    try {
      if (action === 'approve') {
        await updateUser(id, { status: 'approved', role: 'user' });
        toast('המשתמש אושר', 'success');
      } else if (action === 'deny') {
        await updateUser(id, { status: 'denied' });
        toast('המשתמש נחסם', 'success');
      } else if (action === 'promote') {
        await updateUser(id, { status: 'approved', role: 'admin' });
        toast('המשתמש הוגדר כמנהל', 'success');
      } else if (action === 'demote') {
        await updateUser(id, { role: 'user' });
        toast('הרשאות מנהל הוסרו', 'success');
      } else if (action === 'delete') {
        const ok = await confirmDialog({
          title: 'מחיקת משתמש',
          message: 'למחוק את המשתמש לצמיתות? כל היסטוריית ההודעות שלו תימחק.',
          danger: true,
          confirmText: 'מחק',
        });
        if (!ok) return;
        await deleteUser(id);
        toast('המשתמש נמחק', 'success');
      }
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Tab clicks
  container.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab').forEach((b) => {
        b.classList.toggle('btn-primary', b.dataset.tab === activeTab);
        b.classList.toggle('btn-ghost', b.dataset.tab !== activeTab);
      });
      refresh();
    });
  });
  container.querySelector(`.tab[data-tab="${activeTab}"]`).classList.add('btn-primary');
  container.querySelector(`.tab[data-tab="${activeTab}"]`).classList.remove('btn-ghost');

  let searchT;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(refresh, 200);
  });

  // Realtime updates
  const channel = subscribePending(refresh);

  await refresh();

  return {
    teardown: () => {
      channel?.unsubscribe();
    },
  };
}
