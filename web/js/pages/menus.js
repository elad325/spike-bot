import {
  listMenus,
  createMenu,
  updateMenu,
  deleteMenu,
  listMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  reorderMenuItems,
} from '../api.js';
import { toast, escapeHtml, openModal, closeModal, confirmDialog, emptyState, formatDate } from '../ui.js';
import { pickPdfFromDrive, isGoogleConfigured } from '../google.js';

export async function renderMenusPage(container) {
  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">תפריטים</h1>
          <p class="page-subtitle">בנה את מבנה התפריטים שהבוט יציג למשתמשים</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="add-menu-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
            תפריט חדש
          </button>
        </div>
      </div>
      <div id="root-warning"></div>
      <div class="menu-builder">
        <div class="card" id="menus-sidebar">
          <div class="card-header">
            <div class="card-title">כל התפריטים</div>
          </div>
          <div id="menus-list"></div>
        </div>
        <div class="card" id="menu-detail">
          <div class="empty-state">
            <div class="icon">📋</div>
            <h3>בחר תפריט</h3>
            <p>בחר תפריט מהרשימה כדי לערוך אותו</p>
          </div>
        </div>
      </div>
    </div>
  `;

  let menus = [];
  let selectedMenuId = null;

  const sidebar = container.querySelector('#menus-list');
  const detail = container.querySelector('#menu-detail');
  const warningHost = container.querySelector('#root-warning');

  async function refresh() {
    menus = await listMenus();
    renderSidebar();
    renderRootWarning();
    if (selectedMenuId && !menus.find((m) => m.id === selectedMenuId)) {
      selectedMenuId = null;
    }
    if (selectedMenuId) await renderDetail(selectedMenuId);
    else renderEmptyDetail();
  }

  // Show a prominent banner if there are menus but none is the root menu —
  // without a root, the bot replies "הבוט עדיין לא הוגדר" to every message.
  function renderRootWarning() {
    const hasRoot = menus.some((m) => m.is_root);
    if (menus.length === 0 || hasRoot) {
      warningHost.innerHTML = '';
      return;
    }
    const options = menus
      .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
      .join('');
    warningHost.innerHTML = `
      <div class="card" style="border:1px solid var(--warning);background:rgba(251,191,36,.06);margin-bottom:1rem">
        <div style="display:flex;align-items:center;gap:.85rem;flex-wrap:wrap">
          <div style="font-size:1.5rem">⚠️</div>
          <div style="flex:1;min-width:240px">
            <div style="font-weight:600;color:var(--warning)">אין תפריט ראשי מוגדר</div>
            <div style="color:var(--text-muted);font-size:.9rem;margin-top:.15rem">
              ללא תפריט ראשי הבוט יענה "הבוט עדיין לא הוגדר" לכל הודעה. בחר איזה תפריט ישמש כראשי:
            </div>
          </div>
          <select id="root-picker" style="min-width:180px">${options}</select>
          <button class="btn btn-primary btn-sm" id="root-apply">הגדר כראשי</button>
        </div>
      </div>`;
    warningHost.querySelector('#root-apply').addEventListener('click', async () => {
      const id = warningHost.querySelector('#root-picker').value;
      try {
        await updateMenu(id, { is_root: true });
        toast('תפריט ראשי הוגדר', 'success');
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function renderSidebar() {
    if (menus.length === 0) {
      sidebar.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:1rem;font-size:.9rem">אין תפריטים עדיין.<br>צור תפריט ראשון.</p>`;
      return;
    }
    sidebar.innerHTML = `<div class="menu-list">${menus
      .map(
        (m) => `
        <div class="menu-list-item ${m.id === selectedMenuId ? 'active' : ''}" data-id="${m.id}">
          <span class="name">${escapeHtml(m.name)}</span>
          ${m.is_root ? '<span class="root-badge">ראשי</span>' : ''}
        </div>`
      )
      .join('')}</div>`;
    sidebar.querySelectorAll('.menu-list-item').forEach((el) =>
      el.addEventListener('click', () => {
        selectedMenuId = el.dataset.id;
        renderSidebar();
        renderDetail(selectedMenuId);
      })
    );
  }

  function renderEmptyDetail() {
    detail.innerHTML = `
      <div class="empty-state">
        <div class="icon">📋</div>
        <h3>בחר תפריט</h3>
        <p>בחר תפריט מהרשימה כדי לערוך אותו</p>
      </div>`;
  }

  async function renderDetail(menuId) {
    const menu = menus.find((m) => m.id === menuId);
    if (!menu) return renderEmptyDetail();
    const items = await listMenuItems(menuId);

    detail.innerHTML = `
      <div class="card-header">
        <div>
          <div class="card-title">${escapeHtml(menu.name)} ${menu.is_root ? '<span class="tag tag-warning" style="margin-inline-start:.5rem">תפריט ראשי</span>' : ''}</div>
          <div style="font-size:.8rem;color:var(--text-muted);margin-top:.25rem">${items.length} פריטים</div>
        </div>
        <div style="display:flex;gap:.25rem">
          <button class="btn btn-sm btn-outline" id="edit-menu">עריכה</button>
          <button class="btn btn-sm btn-ghost" id="delete-menu" style="color:var(--danger)">מחיקה</button>
        </div>
      </div>
      <div class="page-actions" style="margin-bottom:1rem">
        <button class="btn btn-primary btn-sm" id="add-submenu">📂 הוסף תת-תפריט</button>
        <button class="btn btn-primary btn-sm" id="add-file">📄 הוסף קובץ</button>
      </div>
      <div class="menu-items-area" id="items-area"></div>
    `;

    const area = detail.querySelector('#items-area');
    if (items.length === 0) {
      area.innerHTML = `<div class="empty-state" style="padding:2rem 1rem"><div class="icon" style="font-size:2.5rem">📭</div><p>אין פריטים בתפריט עדיין</p></div>`;
    } else {
      area.innerHTML = items.map((item) => renderItem(item)).join('');
      area.querySelectorAll('[data-edit]').forEach((b) =>
        b.addEventListener('click', () => editItemDialog(menu, items.find((i) => i.id === b.dataset.edit)))
      );
      area.querySelectorAll('[data-delete]').forEach((b) =>
        b.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'מחיקת פריט',
            message: 'האם למחוק את הפריט?',
            danger: true,
            confirmText: 'מחק',
          });
          if (!ok) return;
          await deleteMenuItem(b.dataset.delete);
          toast('הפריט נמחק', 'success');
          renderDetail(selectedMenuId);
        })
      );
      area.querySelectorAll('[data-up]').forEach((b) =>
        b.addEventListener('click', async () => {
          const idx = items.findIndex((i) => i.id === b.dataset.up);
          if (idx <= 0) return;
          const ids = items.map((i) => i.id);
          [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
          await reorderMenuItems(ids);
          renderDetail(selectedMenuId);
        })
      );
      area.querySelectorAll('[data-down]').forEach((b) =>
        b.addEventListener('click', async () => {
          const idx = items.findIndex((i) => i.id === b.dataset.down);
          if (idx >= items.length - 1) return;
          const ids = items.map((i) => i.id);
          [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
          await reorderMenuItems(ids);
          renderDetail(selectedMenuId);
        })
      );
    }

    detail.querySelector('#edit-menu').addEventListener('click', () => editMenuDialog(menu));
    detail.querySelector('#delete-menu').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'מחיקת תפריט',
        message: `למחוק את "${menu.name}"? פעולה זו תמחק גם את כל הפריטים שבו.`,
        danger: true,
        confirmText: 'מחק',
      });
      if (!ok) return;
      await deleteMenu(menu.id);
      toast('התפריט נמחק', 'success');
      selectedMenuId = null;
      refresh();
    });
    detail.querySelector('#add-submenu').addEventListener('click', () => addSubmenuDialog(menu));
    detail.querySelector('#add-file').addEventListener('click', () => addFileDialog(menu));
  }

  function renderItem(item) {
    const icon = item.type === 'submenu' ? '📂' : '📄';
    const target = item.type === 'submenu'
      ? menus.find((m) => m.id === item.target_menu_id)?.name || '(תפריט נמחק)'
      : item.drive_file_name || '(ללא שם)';
    const missing = item.drive_file_missing
      ? '<span class="tag tag-danger" style="margin-inline-start:.5rem">קובץ חסר!</span>'
      : '';
    return `
      <div class="menu-item-row" data-id="${item.id}">
        <div style="display:flex;flex-direction:column;gap:.1rem">
          <button class="icon-btn" data-up="${item.id}" style="height:18px" title="העלה">▲</button>
          <button class="icon-btn" data-down="${item.id}" style="height:18px" title="הורד">▼</button>
        </div>
        <div class="item-icon">${icon}</div>
        <div class="item-info">
          <div class="label">${escapeHtml(item.label)} ${missing}</div>
          <div class="meta">${item.type === 'submenu' ? '↳ ' : ''}${escapeHtml(target)}</div>
        </div>
        <div class="item-actions">
          <button class="btn btn-sm btn-ghost" data-edit="${item.id}">עריכה</button>
          <button class="btn btn-sm btn-ghost" data-delete="${item.id}" style="color:var(--danger)">מחק</button>
        </div>
      </div>`;
  }

  // === Menu CRUD dialogs ===
  function newMenuDialog() {
    // Pre-check is_root when no root exists yet — this is almost always what
    // the user wants for their first menu, and avoids the "bot not configured"
    // trap. They can untick it for non-root menus.
    const noRootYet = !menus.some((m) => m.is_root);
    const body = `
      <label><span>שם התפריט</span>
        <input type="text" id="new-menu-name" placeholder="לדוגמה: תפריט ראשי" autofocus />
      </label>
      <label style="margin-top:.85rem;flex-direction:row;align-items:center;gap:.5rem">
        <input type="checkbox" id="new-menu-root" style="width:auto" ${noRootYet ? 'checked' : ''} />
        <span>תפריט ראשי (זה התפריט שיוצג כשמשתמש כותב לבוט)</span>
      </label>
      ${noRootYet ? '<p style="margin-top:.5rem;color:var(--text-muted);font-size:.85rem">💡 סומן אוטומטית כי אין עדיין תפריט ראשי. בטל סימון אם זה תפריט משנה.</p>' : ''}
    `;
    const footer = `<button class="btn btn-ghost" data-modal-close>ביטול</button>
      <button class="btn btn-primary" id="save-new-menu">צור</button>`;
    const m = openModal({ title: 'תפריט חדש', body, footer, size: 'sm' });
    m.box.querySelector('#save-new-menu').addEventListener('click', async () => {
      const name = m.box.querySelector('#new-menu-name').value.trim();
      const isRoot = m.box.querySelector('#new-menu-root').checked;
      if (!name) {
        toast('שם התפריט חובה', 'error');
        return;
      }
      try {
        const created = await createMenu(name, isRoot);
        closeModal();
        toast('התפריט נוצר', 'success');
        selectedMenuId = created.id;
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function editMenuDialog(menu) {
    const body = `
      <label><span>שם התפריט</span>
        <input type="text" id="edit-menu-name" value="${escapeHtml(menu.name)}" />
      </label>
      <label style="margin-top:.85rem;flex-direction:row;align-items:center;gap:.5rem">
        <input type="checkbox" id="edit-menu-root" ${menu.is_root ? 'checked' : ''} style="width:auto" />
        <span>הגדר כתפריט ראשי</span>
      </label>
    `;
    const footer = `<button class="btn btn-ghost" data-modal-close>ביטול</button>
      <button class="btn btn-primary" id="save-edit-menu">שמור</button>`;
    const m = openModal({ title: 'עריכת תפריט', body, footer, size: 'sm' });
    m.box.querySelector('#save-edit-menu').addEventListener('click', async () => {
      const name = m.box.querySelector('#edit-menu-name').value.trim();
      const isRoot = m.box.querySelector('#edit-menu-root').checked;
      if (!name) {
        toast('שם חובה', 'error');
        return;
      }
      try {
        await updateMenu(menu.id, { name, is_root: isRoot });
        closeModal();
        toast('נשמר', 'success');
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function addSubmenuDialog(parentMenu) {
    const otherMenus = menus.filter((m) => m.id !== parentMenu.id);
    const body = `
      <label><span>טקסט הכפתור</span>
        <input type="text" id="item-label" placeholder="לדוגמה: הזמנת תור" autofocus />
      </label>
      <label style="margin-top:.85rem"><span>בחר תפריט יעד</span>
        <select id="target-menu">
          <option value="">-- בחר תפריט --</option>
          ${otherMenus.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}
        </select>
      </label>
      <p style="margin-top:.75rem;color:var(--text-muted);font-size:.85rem">
        💡 אם התפריט שאתה רוצה לא קיים, סגור את החלון, צור אותו, ואז חזור לכאן.
      </p>
    `;
    const footer = `<button class="btn btn-ghost" data-modal-close>ביטול</button>
      <button class="btn btn-primary" id="save-item">הוסף</button>`;
    const m = openModal({ title: 'הוספת תת-תפריט', body, footer, size: 'sm' });
    m.box.querySelector('#save-item').addEventListener('click', async () => {
      const label = m.box.querySelector('#item-label').value.trim();
      const target = m.box.querySelector('#target-menu').value;
      if (!label || !target) {
        toast('יש למלא את כל השדות', 'error');
        return;
      }
      try {
        const items = await listMenuItems(parentMenu.id);
        await createMenuItem({
          menu_id: parentMenu.id,
          label,
          type: 'submenu',
          target_menu_id: target,
          display_order: items.length,
        });
        closeModal();
        toast('הפריט נוסף', 'success');
        renderDetail(selectedMenuId);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  async function addFileDialog(parentMenu) {
    if (!isGoogleConfigured()) {
      toast('יש להגדיר Google Client ID + API Key בהגדרות תחילה', 'error');
      return;
    }
    let picked = null;

    const body = `
      <label><span>טקסט הכפתור</span>
        <input type="text" id="item-label" placeholder="לדוגמה: תפריט מסעדה" autofocus />
      </label>
      <div style="margin-top:.85rem">
        <label><span>קובץ נבחר</span></label>
        <div id="picked-file" style="padding:.75rem;background:var(--bg-hover);border-radius:var(--radius);color:var(--text-muted);font-size:.9rem">
          לא נבחר קובץ
        </div>
        <button class="btn btn-outline btn-sm" id="pick-file" style="margin-top:.5rem">
          📁 בחר קובץ מ-Google Drive
        </button>
      </div>
    `;
    const footer = `<button class="btn btn-ghost" data-modal-close>ביטול</button>
      <button class="btn btn-primary" id="save-file-item">הוסף</button>`;
    const m = openModal({ title: 'הוספת קובץ', body, footer, size: 'sm' });

    m.box.querySelector('#pick-file').addEventListener('click', async () => {
      try {
        const result = await pickPdfFromDrive();
        if (!result) return;
        picked = result;
        m.box.querySelector('#picked-file').innerHTML = `📄 <strong>${escapeHtml(result.name)}</strong>`;
        const labelInput = m.box.querySelector('#item-label');
        if (!labelInput.value) labelInput.value = result.name.replace(/\.pdf$/i, '');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    m.box.querySelector('#save-file-item').addEventListener('click', async () => {
      const label = m.box.querySelector('#item-label').value.trim();
      if (!label || !picked) {
        toast('יש למלא טקסט ולבחור קובץ', 'error');
        return;
      }
      try {
        const items = await listMenuItems(parentMenu.id);
        await createMenuItem({
          menu_id: parentMenu.id,
          label,
          type: 'file',
          drive_file_id: picked.id,
          drive_file_name: picked.name,
          display_order: items.length,
        });
        closeModal();
        toast('הקובץ נוסף', 'success');
        renderDetail(selectedMenuId);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  async function editItemDialog(parentMenu, item) {
    if (item.type === 'submenu') {
      const otherMenus = menus.filter((m) => m.id !== parentMenu.id);
      const body = `
        <label><span>טקסט הכפתור</span>
          <input type="text" id="item-label" value="${escapeHtml(item.label)}" autofocus />
        </label>
        <label style="margin-top:.85rem"><span>תפריט יעד</span>
          <select id="target-menu">
            ${otherMenus.map((m) => `<option value="${m.id}" ${m.id === item.target_menu_id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
          </select>
        </label>
      `;
      const footer = `<button class="btn btn-ghost" data-modal-close>ביטול</button>
        <button class="btn btn-primary" id="save-edit-item">שמור</button>`;
      const m = openModal({ title: 'עריכת תת-תפריט', body, footer, size: 'sm' });
      m.box.querySelector('#save-edit-item').addEventListener('click', async () => {
        const label = m.box.querySelector('#item-label').value.trim();
        const target = m.box.querySelector('#target-menu').value;
        if (!label) return toast('שם חובה', 'error');
        await updateMenuItem(item.id, { label, target_menu_id: target });
        closeModal();
        toast('נשמר', 'success');
        renderDetail(selectedMenuId);
      });
    } else {
      let picked = { id: item.drive_file_id, name: item.drive_file_name };
      const body = `
        <label><span>טקסט הכפתור</span>
          <input type="text" id="item-label" value="${escapeHtml(item.label)}" autofocus />
        </label>
        <div style="margin-top:.85rem">
          <label><span>קובץ נבחר</span></label>
          <div id="picked-file" style="padding:.75rem;background:var(--bg-hover);border-radius:var(--radius);font-size:.9rem">
            📄 <strong>${escapeHtml(picked.name || '(ללא שם)')}</strong>
          </div>
          <button class="btn btn-outline btn-sm" id="pick-file" style="margin-top:.5rem">
            📁 החלף קובץ
          </button>
        </div>
      `;
      const footer = `<button class="btn btn-ghost" data-modal-close>ביטול</button>
        <button class="btn btn-primary" id="save-edit-item">שמור</button>`;
      const m = openModal({ title: 'עריכת קובץ', body, footer, size: 'sm' });

      m.box.querySelector('#pick-file').addEventListener('click', async () => {
        try {
          const result = await pickPdfFromDrive();
          if (!result) return;
          picked = result;
          m.box.querySelector('#picked-file').innerHTML = `📄 <strong>${escapeHtml(result.name)}</strong>`;
        } catch (err) {
          toast(err.message, 'error');
        }
      });

      m.box.querySelector('#save-edit-item').addEventListener('click', async () => {
        const label = m.box.querySelector('#item-label').value.trim();
        if (!label) return toast('שם חובה', 'error');
        await updateMenuItem(item.id, {
          label,
          drive_file_id: picked.id,
          drive_file_name: picked.name,
          drive_file_missing: false,
        });
        closeModal();
        toast('נשמר', 'success');
        renderDetail(selectedMenuId);
      });
    }
  }

  container.querySelector('#add-menu-btn').addEventListener('click', newMenuDialog);

  await refresh();
}
