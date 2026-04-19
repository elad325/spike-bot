import {
  listMenus,
  createMenu,
  updateMenu,
  deleteMenu,
  listAllMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  reorderMenuItems,
} from '../api.js';
import {
  toast,
  escapeHtml,
  openModal,
  closeModal,
  confirmDialog,
} from '../ui.js';
import { pickPdfFromDrive, isGoogleConfigured } from '../google.js';

/**
 * Menu builder — single-tree view.
 *
 * The page renders the *entire* bot menu structure as one expandable tree
 * rooted at the is_root menu. This replaces the older two-pane (sidebar +
 * detail) UI which made hierarchy invisible: you'd see a flat list of menus
 * and have to mentally reconstruct who-points-to-who.
 *
 * Data model:
 *   menus           - rows in `menus` table; one is is_root=true
 *   menu_items      - rows in `menu_items`; either type='file' (drive_file_id)
 *                     or type='submenu' (target_menu_id pointing to a `menu`)
 *
 * Key tree-rendering rules:
 *   - Root menu is always shown expanded
 *   - Other submenus toggle via a chevron; expansion state is persisted in
 *     sessionStorage so refresh / nav-back doesn't collapse everything
 *   - Cycles (A → B → A) are detected by tracking ancestor menuIds in the
 *     recursive call; the cycling node renders with a "↻ לולאה" tag instead
 *     of recursing infinitely
 *   - Menus that aren't reachable from the root via any submenu chain are
 *     surfaced separately as "orphans" so the admin can delete or relink them
 */
export async function renderMenusPage(container) {
  // ─── State ─────────────────────────────────────────────────────────
  let menus = [];
  let allItems = [];
  let itemsByMenu = new Map();
  let referencedMenuIds = new Set();
  // expanded: which submenus are currently open. Persisted across nav so
  // the admin doesn't lose their place when bouncing between pages.
  const expanded = new Set(
    JSON.parse(sessionStorage.getItem('menus_expanded_v2') || '[]')
  );
  const persistExpanded = () =>
    sessionStorage.setItem('menus_expanded_v2', JSON.stringify([...expanded]));

  // ─── Scaffolding ────────────────────────────────────────────────────
  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <div>
          <h1 class="page-title">תפריטים</h1>
          <p class="page-subtitle">העץ המלא של מה שהבוט מציג למשתמשים</p>
        </div>
      </div>
      <div id="root-warning"></div>
      <div id="tree-host"></div>
      <div id="orphans-section"></div>
    </div>
  `;

  const treeHost = container.querySelector('#tree-host');
  const warningHost = container.querySelector('#root-warning');
  const orphansHost = container.querySelector('#orphans-section');

  // ─── Data load ──────────────────────────────────────────────────────
  async function load() {
    const [m, items] = await Promise.all([listMenus(), listAllMenuItems()]);
    menus = m;
    allItems = items;
    itemsByMenu = new Map();
    for (const it of items) {
      if (!itemsByMenu.has(it.menu_id)) itemsByMenu.set(it.menu_id, []);
      itemsByMenu.get(it.menu_id).push(it);
    }
    referencedMenuIds = new Set(
      items
        .filter((i) => i.type === 'submenu' && i.target_menu_id)
        .map((i) => i.target_menu_id)
    );
    render();
  }

  function render() {
    renderRootWarning();
    renderTree();
    renderOrphans();
  }

  // ─── Root warning (no is_root menu set) ─────────────────────────────
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
      <div class="card root-warning-card">
        <div class="root-warning-row">
          <div style="font-size:1.5rem">⚠️</div>
          <div style="flex:1;min-width:240px">
            <div style="font-weight:600;color:var(--warning)">אין תפריט ראשי</div>
            <div style="color:var(--text-muted);font-size:.9rem;margin-top:.15rem">
              ללא ראשי, הבוט יענה "לא הוגדר" לכל הודעה. בחר מי מהתפריטים יהיה הראשי:
            </div>
          </div>
          <select id="root-picker" style="min-width:180px">${options}</select>
          <button class="btn btn-primary btn-sm" id="root-apply">הגדר כראשי</button>
        </div>
      </div>`;
    warningHost.querySelector('#root-apply').addEventListener('click', async () => {
      try {
        await updateMenu(warningHost.querySelector('#root-picker').value, { is_root: true });
        toast('תפריט ראשי הוגדר', 'success');
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // ─── Empty state (zero menus exist) ─────────────────────────────────
  function renderEmptyTree() {
    treeHost.innerHTML = `
      <div class="card">
        <div class="empty-state" style="padding:3rem 1.5rem">
          <div class="icon" style="font-size:3.5rem">🌱</div>
          <h3>בוא נתחיל</h3>
          <p>צור את התפריט הראשי - זה מה שהבוט יציג כל פעם שמישהו כותב לו.</p>
          <div style="margin-top:1.25rem">
            <button class="btn btn-primary" id="create-root-btn">+ צור תפריט ראשי</button>
          </div>
        </div>
      </div>
    `;
    treeHost.querySelector('#create-root-btn').addEventListener('click', () =>
      newMenuDialog({ asRoot: true })
    );
  }

  // ─── The tree ──────────────────────────────────────────────────────
  function renderTree() {
    const root = menus.find((m) => m.is_root);
    if (menus.length === 0) {
      renderEmptyTree();
      return;
    }
    if (!root) {
      // Banner above prompts the admin to choose one
      treeHost.innerHTML = `<div class="card"><p style="text-align:center;color:var(--text-muted);padding:1.5rem">בחר תפריט ראשי בבאנר למעלה כדי להתחיל לבנות.</p></div>`;
      return;
    }

    // The tree event listeners (click delegation + drag-and-drop) are
    // attached ONCE on initial mount via bindTreeListeners() at the bottom
    // of renderMenusPage. This function only updates innerHTML — adding
    // listeners every render would double them up.
    treeHost.innerHTML = `
      <div class="card menu-tree-card">
        ${renderRootHeader(root)}
        <div class="menu-tree" id="tree-root"></div>
      </div>
    `;

    const treeRoot = treeHost.querySelector('#tree-root');
    const items = itemsByMenu.get(root.id) || [];
    if (items.length === 0) {
      treeRoot.innerHTML = `
        <div class="tree-empty">
          <span>התפריט הראשי ריק.</span>
          <button class="btn btn-primary btn-sm" data-add-to="${root.id}">+ הוסף פריט ראשון</button>
        </div>`;
    } else {
      const ancestors = new Set([root.id]);
      treeRoot.innerHTML = items.map((it) => renderItem(it, 1, ancestors)).join('');
    }
  }

  function renderRootHeader(root) {
    const items = itemsByMenu.get(root.id) || [];
    return `
      <div class="tree-root-header">
        <div class="tree-root-title">
          <span class="tree-root-icon">🏠</span>
          <span class="tree-root-name">${escapeHtml(root.name)}</span>
          <span class="tag tag-warning" style="font-size:.65rem">תפריט ראשי</span>
          <span class="tree-meta-pill">${items.length} פריטים</span>
        </div>
        <div class="tree-root-actions">
          <button class="btn btn-primary btn-sm" data-add-to="${root.id}">+ פריט</button>
          <button class="btn btn-sm btn-ghost" data-edit-menu="${root.id}" title="ערוך שם / הגדרות">✏️</button>
        </div>
      </div>
    `;
  }

  function renderItem(item, depth, ancestorMenuIds) {
    const isSubmenu = item.type === 'submenu';
    const targetMenu = isSubmenu
      ? menus.find((m) => m.id === item.target_menu_id)
      : null;
    const isCycle = isSubmenu && targetMenu && ancestorMenuIds.has(targetMenu.id);
    const canExpand = !!targetMenu && !isCycle;
    const isExpanded = canExpand && expanded.has(targetMenu.id);

    const icon = isSubmenu ? '📂' : '📄';
    const targetText = isSubmenu
      ? targetMenu
        ? `↳ ${targetMenu.name}`
        : '⚠️ תפריט יעד נמחק'
      : item.drive_file_name || '(ללא שם)';
    const missingTag = item.drive_file_missing
      ? '<span class="tag tag-danger" style="margin-inline-start:.4rem;font-size:.6rem">קובץ חסר</span>'
      : '';
    const cycleTag = isCycle
      ? '<span class="tag tag-warning" style="margin-inline-start:.4rem;font-size:.6rem">↻ לולאה</span>'
      : '';

    const chevron = canExpand
      ? `<button class="tree-chevron ${isExpanded ? 'expanded' : ''}" data-toggle="${targetMenu.id}" title="${isExpanded ? 'כווץ' : 'הרחב'}">▶</button>`
      : `<span class="tree-chevron invisible">▶</span>`;

    let html = `
      <div class="tree-item">
        <div class="tree-row" data-item-id="${item.id}" data-parent-menu="${item.menu_id}" draggable="true">
          ${chevron}
          <span class="tree-grip" title="גרור לסידור מחדש">⋮⋮</span>
          <span class="tree-icon">${icon}</span>
          <div class="tree-info">
            <div class="tree-label">${escapeHtml(item.label)} ${missingTag}${cycleTag}</div>
            <div class="tree-meta">${escapeHtml(targetText)}</div>
          </div>
          <div class="tree-actions">
            ${
              isSubmenu && targetMenu
                ? `<button class="btn btn-sm btn-primary tree-add-btn" data-add-to="${targetMenu.id}" title="הוסף פריט בתוך תת-התפריט">+</button>`
                : ''
            }
            ${
              item.type === 'file'
                ? `<button class="btn btn-sm btn-outline" data-replace="${item.id}" title="החלף קובץ"><span class="tree-btn-text">↻ החלף</span><span class="tree-btn-icon">↻</span></button>`
                : ''
            }
            <button class="btn btn-sm btn-ghost" data-edit="${item.id}" title="ערוך">✏️</button>
            <div class="tree-arrow-stack">
              <button class="icon-btn tree-arrow" data-up="${item.id}" title="הזז למעלה">▲</button>
              <button class="icon-btn tree-arrow" data-down="${item.id}" title="הזז למטה">▼</button>
            </div>
            <button class="btn btn-sm btn-ghost tree-del-btn" data-delete="${item.id}" title="מחק">🗑</button>
          </div>
        </div>
    `;

    if (isExpanded && targetMenu) {
      const children = itemsByMenu.get(targetMenu.id) || [];
      const newAncestors = new Set(ancestorMenuIds);
      newAncestors.add(targetMenu.id);
      html += `<div class="tree-children" data-menu-id="${targetMenu.id}">`;
      if (children.length === 0) {
        html += `
          <div class="tree-empty">
            <span>תת-התפריט ריק.</span>
            <button class="btn btn-sm btn-primary" data-add-to="${targetMenu.id}">+ הוסף פריט</button>
          </div>`;
      } else {
        for (const child of children) {
          html += renderItem(child, depth + 1, newAncestors);
        }
      }
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  // ─── Orphans section (only when any orphans exist) ──────────────────
  function renderOrphans() {
    const orphans = menus.filter(
      (m) => !m.is_root && !referencedMenuIds.has(m.id)
    );
    if (orphans.length === 0) {
      orphansHost.innerHTML = '';
      return;
    }
    orphansHost.innerHTML = `
      <div class="card orphans-card">
        <div class="card-header">
          <div>
            <div class="card-title" style="color:var(--warning)">⚠️ תפריטים יתומים — ${orphans.length}</div>
            <p style="font-size:.85rem;color:var(--text-muted);margin-top:.25rem">
              תפריטים שאף אחד לא מקשר אליהם, אז משתמשים לא יכולים להגיע אליהם דרך הבוט.
            </p>
          </div>
        </div>
        <div class="orphan-list">
          ${orphans
            .map(
              (o) => `
            <div class="orphan-row">
              <span class="tree-icon">📂</span>
              <div class="tree-info">
                <div class="tree-label">${escapeHtml(o.name)}</div>
                <div class="tree-meta">${(itemsByMenu.get(o.id) || []).length} פריטים בפנים</div>
              </div>
              <div class="tree-actions">
                <button class="btn btn-sm btn-primary" data-link-orphan="${o.id}">קשר לתפריט</button>
                <button class="btn btn-sm btn-ghost" data-delete-menu="${o.id}" style="color:var(--danger)">🗑 מחק</button>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    `;
    orphansHost.querySelectorAll('[data-link-orphan]').forEach((b) =>
      b.addEventListener('click', () =>
        linkOrphanDialog(menus.find((m) => m.id === b.dataset.linkOrphan))
      )
    );
    orphansHost.querySelectorAll('[data-delete-menu]').forEach((b) =>
      b.addEventListener('click', () =>
        deleteMenuConfirm(menus.find((m) => m.id === b.dataset.deleteMenu))
      )
    );
  }

  // ─── Tree event delegation ──────────────────────────────────────────
  // Single delegated click listener on treeHost handles every interactive
  // element inside the tree (chevrons, add buttons, edit/delete, arrows).
  // Attached once on mount; survives all re-renders since events bubble.
  function onTreeClick(e) {
    const target = e.target;

    const toggle = target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.dataset.toggle;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      persistExpanded();
      render();
      return;
    }

    const addTo = target.closest('[data-add-to]');
    if (addTo) {
      const m = menus.find((mn) => mn.id === addTo.dataset.addTo);
      if (m) addItemDialog(m);
      return;
    }

    const editMenu = target.closest('[data-edit-menu]');
    if (editMenu) {
      const m = menus.find((mn) => mn.id === editMenu.dataset.editMenu);
      if (m) editMenuDialog(m);
      return;
    }

    const edit = target.closest('[data-edit]');
    if (edit) {
      const item = allItems.find((i) => i.id === edit.dataset.edit);
      if (!item) return;
      const parent = menus.find((m) => m.id === item.menu_id);
      if (parent) editItemDialog(parent, item);
      return;
    }

    const replace = target.closest('[data-replace]');
    if (replace) {
      const item = allItems.find((i) => i.id === replace.dataset.replace);
      if (item) quickReplaceFile(item);
      return;
    }

    const del = target.closest('[data-delete]');
    if (del) {
      const item = allItems.find((i) => i.id === del.dataset.delete);
      if (item) deleteItemConfirm(item);
      return;
    }

    const up = target.closest('[data-up]');
    if (up) {
      moveItem(up.dataset.up, -1);
      return;
    }

    const down = target.closest('[data-down]');
    if (down) {
      moveItem(down.dataset.down, +1);
      return;
    }
  }

  async function moveItem(itemId, dir) {
    const item = allItems.find((i) => i.id === itemId);
    if (!item) return;
    const siblings = (itemsByMenu.get(item.menu_id) || []).slice();
    const idx = siblings.findIndex((i) => i.id === itemId);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= siblings.length) return;
    [siblings[idx], siblings[newIdx]] = [siblings[newIdx], siblings[idx]];
    try {
      await reorderMenuItems(siblings.map((i) => i.id));
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ─── Drag & Drop (within same parent menu only) ─────────────────────
  function enableDragDrop(root) {
    let dragSrcId = null;
    let dragSrcParent = null;

    root.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.tree-row');
      if (!row) return;
      dragSrcId = row.dataset.itemId;
      dragSrcParent = row.dataset.parentMenu;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers require any data to be set on dragstart for drop to fire
      try {
        e.dataTransfer.setData('text/plain', dragSrcId);
      } catch {
        /* noop */
      }
    });

    root.addEventListener('dragend', () => {
      root.querySelectorAll('.dragging').forEach((el) =>
        el.classList.remove('dragging')
      );
      clearDropIndicators();
      dragSrcId = null;
      dragSrcParent = null;
    });

    function clearDropIndicators() {
      root.querySelectorAll('.drop-before, .drop-after').forEach((el) =>
        el.classList.remove('drop-before', 'drop-after')
      );
    }

    root.addEventListener('dragover', (e) => {
      const row = e.target.closest('.tree-row');
      if (!row || !dragSrcId) return;
      // Only same-parent reorder is supported. Cross-parent moves go via
      // the edit modal — keeps the gesture predictable.
      if (row.dataset.parentMenu !== dragSrcParent) return;
      if (row.dataset.itemId === dragSrcId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      clearDropIndicators();
      row.classList.add(after ? 'drop-after' : 'drop-before');
    });

    root.addEventListener('drop', async (e) => {
      const row = e.target.closest('.tree-row');
      if (!row || !dragSrcId) return;
      if (row.dataset.parentMenu !== dragSrcParent) return;
      if (row.dataset.itemId === dragSrcId) return;
      e.preventDefault();
      const targetId = row.dataset.itemId;
      const after = row.classList.contains('drop-after');
      const siblings = (itemsByMenu.get(dragSrcParent) || []).slice();
      const fromIdx = siblings.findIndex((i) => i.id === dragSrcId);
      if (fromIdx === -1) return;
      const [moved] = siblings.splice(fromIdx, 1);
      let toIdx = siblings.findIndex((i) => i.id === targetId);
      if (after) toIdx += 1;
      siblings.splice(toIdx, 0, moved);
      clearDropIndicators();
      try {
        await reorderMenuItems(siblings.map((i) => i.id));
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // ─── Dialogs ────────────────────────────────────────────────────────

  // Create a brand-new menu. Used only from the empty-state CTA (root) or
  // inline from the "add submenu" picker. There's no standalone "+ תפריט"
  // button in the header — that path reliably creates orphans.
  function newMenuDialog({ asRoot = false } = {}) {
    const body = `
      <label><span>שם התפריט</span>
        <input type="text" id="new-menu-name" placeholder="${asRoot ? 'לדוגמה: תפריט ראשי' : 'שם התפריט החדש'}" autofocus />
      </label>
      ${asRoot
        ? '<p style="margin-top:.5rem;color:var(--text-muted);font-size:.85rem">💡 התפריט הזה יוגדר אוטומטית כראשי - מה שהבוט מציג כל פעם שמישהו כותב לו.</p>'
        : ''}
    `;
    const footer = `<button class="btn btn-ghost" data-modal-close>ביטול</button>
      <button class="btn btn-primary" id="save-new-menu">צור</button>`;
    const m = openModal({ title: asRoot ? 'תפריט ראשי חדש' : 'תפריט חדש', body, footer, size: 'sm' });
    m.box.querySelector('#save-new-menu').addEventListener('click', async () => {
      const name = m.box.querySelector('#new-menu-name').value.trim();
      if (!name) return toast('שם התפריט חובה', 'error');
      try {
        await createMenu(name, asRoot);
        closeModal();
        toast('התפריט נוצר', 'success');
        await load();
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
      if (!name) return toast('שם חובה', 'error');
      try {
        await updateMenu(menu.id, { name, is_root: isRoot });
        closeModal();
        toast('נשמר', 'success');
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // Picker — the unified "+" button: file or submenu?
  function addItemDialog(parentMenu) {
    const body = `
      <p style="color:var(--text-muted);margin-bottom:.85rem">
        מה תרצה להוסיף ל"<strong>${escapeHtml(parentMenu.name)}</strong>"?
      </p>
      <div class="add-item-picker">
        <button class="add-item-card" data-pick="file">
          <span class="add-item-icon">📄</span>
          <span class="add-item-label">קובץ</span>
          <span class="add-item-desc">PDF / מסמך מ-Drive</span>
        </button>
        <button class="add-item-card" data-pick="submenu">
          <span class="add-item-icon">📂</span>
          <span class="add-item-label">תת-תפריט</span>
          <span class="add-item-desc">קבוצת פריטים</span>
        </button>
      </div>
    `;
    const m = openModal({
      title: 'הוסף פריט חדש',
      body,
      footer: '<button class="btn btn-ghost" data-modal-close>ביטול</button>',
      size: 'sm',
    });
    m.box.querySelector('[data-pick="file"]').addEventListener('click', () => {
      closeModal();
      addFileDialog(parentMenu);
    });
    m.box.querySelector('[data-pick="submenu"]').addEventListener('click', () => {
      closeModal();
      addSubmenuDialog(parentMenu);
    });
  }

  function addSubmenuDialog(parentMenu) {
    // Top-down: pick an existing menu OR create one inline. Inline create
    // avoids the "close → create → reopen → relink" ritual of the old UI.
    function renderOptions() {
      return menus
        .filter((m) => m.id !== parentMenu.id)
        .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
        .join('');
    }

    const body = `
      <label><span>טקסט הכפתור (מה שהמשתמש רואה)</span>
        <input type="text" id="item-label" placeholder="לדוגמה: הזמנת תור" autofocus />
      </label>
      <label style="margin-top:.85rem"><span>תפריט יעד</span>
        <div style="display:flex;gap:.5rem;align-items:stretch">
          <select id="target-menu" style="flex:1">
            <option value="">-- בחר תפריט קיים --</option>
            ${renderOptions()}
          </select>
          <button class="btn btn-outline btn-sm" id="create-target" type="button" style="white-space:nowrap">+ צור חדש</button>
        </div>
      </label>
      <div id="inline-create" class="hidden" style="margin-top:.75rem;padding:.75rem;background:var(--bg-hover);border-radius:var(--radius)">
        <label style="margin:0"><span style="font-size:.85rem">שם התפריט החדש</span>
          <input type="text" id="new-target-name" placeholder="לדוגמה: רשימת תורים" />
        </label>
        <div style="display:flex;gap:.5rem;margin-top:.5rem">
          <button class="btn btn-primary btn-sm" id="confirm-new-target" type="button">צור</button>
          <button class="btn btn-ghost btn-sm" id="cancel-new-target" type="button">ביטול</button>
        </div>
      </div>
    `;
    const footer = `<button class="btn btn-ghost" data-modal-close>ביטול</button>
      <button class="btn btn-primary" id="save-item">הוסף</button>`;
    const m = openModal({ title: 'הוספת תת-תפריט', body, footer, size: 'sm' });

    const inline = m.box.querySelector('#inline-create');
    const select = m.box.querySelector('#target-menu');

    m.box.querySelector('#create-target').addEventListener('click', () => {
      inline.classList.remove('hidden');
      m.box.querySelector('#new-target-name').focus();
    });
    m.box.querySelector('#cancel-new-target').addEventListener('click', () => {
      inline.classList.add('hidden');
      m.box.querySelector('#new-target-name').value = '';
    });
    m.box.querySelector('#confirm-new-target').addEventListener('click', async () => {
      const name = m.box.querySelector('#new-target-name').value.trim();
      if (!name) return toast('שם התפריט חובה', 'error');
      try {
        const created = await createMenu(name, false);
        menus = await listMenus();
        select.innerHTML = `<option value="">-- בחר תפריט קיים --</option>${renderOptions()}`;
        select.value = created.id;
        inline.classList.add('hidden');
        m.box.querySelector('#new-target-name').value = '';
        toast(`תפריט "${name}" נוצר`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    m.box.querySelector('#save-item').addEventListener('click', async () => {
      const label = m.box.querySelector('#item-label').value.trim();
      const target = select.value;
      if (!label || !target) return toast('יש למלא טקסט ולבחור/ליצור תפריט יעד', 'error');
      try {
        const siblings = itemsByMenu.get(parentMenu.id) || [];
        await createMenuItem({
          menu_id: parentMenu.id,
          label,
          type: 'submenu',
          target_menu_id: target,
          display_order: siblings.length,
        });
        // Auto-expand the parent so the user sees what they added without
        // having to click around looking for it
        expanded.add(parentMenu.id);
        // Also expand the new submenu so they can immediately add into it
        expanded.add(target);
        persistExpanded();
        closeModal();
        toast('הפריט נוסף', 'success');
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function addFileDialog(parentMenu) {
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
      if (!label || !picked) return toast('יש למלא טקסט ולבחור קובץ', 'error');
      try {
        const siblings = itemsByMenu.get(parentMenu.id) || [];
        await createMenuItem({
          menu_id: parentMenu.id,
          label,
          type: 'file',
          drive_file_id: picked.id,
          drive_file_name: picked.name,
          display_order: siblings.length,
        });
        expanded.add(parentMenu.id);
        persistExpanded();
        closeModal();
        toast('הקובץ נוסף', 'success');
        await load();
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
        try {
          await updateMenuItem(item.id, { label, target_menu_id: target });
          closeModal();
          toast('נשמר', 'success');
          await load();
        } catch (err) {
          toast(err.message, 'error');
        }
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
        try {
          await updateMenuItem(item.id, {
            label,
            drive_file_id: picked.id,
            drive_file_name: picked.name,
            drive_file_missing: false,
          });
          closeModal();
          toast('נשמר', 'success');
          await load();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  }

  async function quickReplaceFile(item) {
    if (!item || item.type !== 'file') return;
    if (!isGoogleConfigured()) {
      toast('יש להגדיר Google Client ID + API Key בהגדרות תחילה', 'error');
      return;
    }
    try {
      const result = await pickPdfFromDrive();
      if (!result) return;
      await updateMenuItem(item.id, {
        drive_file_id: result.id,
        drive_file_name: result.name,
        drive_file_missing: false,
      });
      toast(`הקובץ הוחלף ל-"${result.name}"`, 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteItemConfirm(item) {
    const isSubmenu = item.type === 'submenu';
    const targetMenu = isSubmenu ? menus.find((m) => m.id === item.target_menu_id) : null;
    const refCount = isSubmenu && targetMenu
      ? allItems.filter((i) => i.type === 'submenu' && i.target_menu_id === targetMenu.id).length
      : 0;
    let message = `למחוק את הפריט "${item.label}"?`;
    if (isSubmenu && targetMenu) {
      message += refCount === 1
        ? `\n\nהתפריט "${targetMenu.name}" יישאר במערכת אבל לא יהיה מקושר מאף מקום (יוצג בקטע "יתומים").`
        : `\n\nהתפריט "${targetMenu.name}" עדיין מקושר מ-${refCount - 1} מקומות נוספים.`;
    }
    const ok = await confirmDialog({
      title: 'מחיקת פריט',
      message,
      danger: true,
      confirmText: 'מחק',
    });
    if (!ok) return;
    try {
      await deleteMenuItem(item.id);
      toast('הפריט נמחק', 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteMenuConfirm(menu) {
    const itemCount = (itemsByMenu.get(menu.id) || []).length;
    const ok = await confirmDialog({
      title: 'מחיקת תפריט',
      message:
        `למחוק את "${menu.name}" לצמיתות?` +
        (itemCount > 0 ? `\n\n${itemCount} פריטים בתוכו יימחקו גם הם.` : ''),
      danger: true,
      confirmText: 'מחק',
    });
    if (!ok) return;
    try {
      await deleteMenu(menu.id);
      toast('התפריט נמחק', 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function linkOrphanDialog(orphan) {
    const candidates = menus.filter((m) => m.id !== orphan.id);
    const body = `
      <p style="color:var(--text-muted);margin-bottom:.85rem">
        קישור "<strong>${escapeHtml(orphan.name)}</strong>" כפריט בתפריט קיים:
      </p>
      <label><span>טקסט הכפתור (מה שהמשתמש רואה)</span>
        <input type="text" id="orphan-label" value="${escapeHtml(orphan.name)}" autofocus />
      </label>
      <label style="margin-top:.85rem"><span>תפריט הורה</span>
        <select id="orphan-parent">
          ${candidates
            .map((m) => `<option value="${m.id}" ${m.is_root ? 'selected' : ''}>${escapeHtml(m.name)}${m.is_root ? ' 🏠' : ''}</option>`)
            .join('')}
        </select>
      </label>
    `;
    const footer = `<button class="btn btn-ghost" data-modal-close>ביטול</button>
      <button class="btn btn-primary" id="save-orphan-link">קשר</button>`;
    const m = openModal({ title: 'קישור תפריט יתום', body, footer, size: 'sm' });
    m.box.querySelector('#save-orphan-link').addEventListener('click', async () => {
      const label = m.box.querySelector('#orphan-label').value.trim();
      const parentId = m.box.querySelector('#orphan-parent').value;
      if (!label) return toast('שם חובה', 'error');
      try {
        const siblings = itemsByMenu.get(parentId) || [];
        await createMenuItem({
          menu_id: parentId,
          label,
          type: 'submenu',
          target_menu_id: orphan.id,
          display_order: siblings.length,
        });
        expanded.add(parentId);
        persistExpanded();
        closeModal();
        toast(`"${orphan.name}" קושר`, 'success');
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // ─── Mount: attach tree listeners once, then load data ──────────────
  // Listeners use event delegation, so they don't need to be re-bound when
  // the inner HTML rerenders. This avoids the classic "click fires N times
  // after N renders" bug.
  treeHost.addEventListener('click', onTreeClick);
  enableDragDrop(treeHost);

  await load();
}
