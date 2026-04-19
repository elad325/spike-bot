// ============================================
// Toast
// ============================================
export function toast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
  }[type] || 'ℹ️';
  el.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.2s';
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ============================================
// Modal
// ============================================
let activeModal = null;

export function openModal({ title, body, footer, onClose, size = 'md' }) {
  closeModal();
  const container = document.getElementById('modal-container');
  const box = document.getElementById('modal-box');

  if (size === 'lg') box.style.maxWidth = '720px';
  else if (size === 'sm') box.style.maxWidth = '420px';
  else box.style.maxWidth = '560px';

  box.innerHTML = `
    <div class="modal-header">
      <h3 class="modal-title">${escapeHtml(title)}</h3>
      <button class="icon-btn" data-modal-close title="סגור">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="modal-body">${typeof body === 'string' ? body : ''}</div>
    ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
  `;

  if (typeof body !== 'string') {
    box.querySelector('.modal-body').innerHTML = '';
    box.querySelector('.modal-body').appendChild(body);
  }

  container.classList.remove('hidden');
  container.querySelectorAll('[data-modal-close]').forEach((btn) =>
    btn.addEventListener('click', () => closeModal())
  );
  document.addEventListener('keydown', escListener);

  activeModal = { onClose, box };
  return { box, close: closeModal };
}

function escListener(e) {
  if (e.key === 'Escape') closeModal();
}

export function closeModal() {
  if (!activeModal) return;
  document.getElementById('modal-container').classList.add('hidden');
  document.removeEventListener('keydown', escListener);
  if (activeModal.onClose) activeModal.onClose();
  activeModal = null;
}

// ============================================
// Confirm dialog
// ============================================
export function confirmDialog({ title, message, confirmText = 'אישור', cancelText = 'ביטול', danger = false }) {
  return new Promise((resolve) => {
    const body = `<p style="color: var(--text-muted)">${escapeHtml(message)}</p>`;
    const footer = `
      <button class="btn btn-ghost" data-confirm-cancel>${escapeHtml(cancelText)}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm-ok>${escapeHtml(confirmText)}</button>
    `;
    const m = openModal({ title, body, footer, size: 'sm' });
    m.box.querySelector('[data-confirm-cancel]').addEventListener('click', () => {
      closeModal();
      resolve(false);
    });
    m.box.querySelector('[data-confirm-ok]').addEventListener('click', () => {
      closeModal();
      resolve(true);
    });
  });
}

// ============================================
// Helpers
// ============================================
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDate(date) {
  if (!date) return '-';
  const d = new Date(date);
  return d.toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(date) {
  if (!date) return '-';
  const d = new Date(date);
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return 'הרגע';
  if (sec < 60) return `לפני ${sec} שניות`;
  if (sec < 3600) return `לפני ${Math.floor(sec / 60)} דקות`;
  if (sec < 86400) return `לפני ${Math.floor(sec / 3600)} שעות`;
  if (sec < 604800) return `לפני ${Math.floor(sec / 86400)} ימים`;
  return formatDate(date);
}

/**
 * True if a string looks like a WhatsApp anonymous LID rather than a phone.
 *
 * WhatsApp's privacy-preserving @lid identifiers are 14-20 digit decimals
 * that look superficially like phones. Real E.164 phones max out at 15
 * digits but personal numbers almost never exceed 13. So: any pure-digit
 * string of 14+ digits is almost certainly a LID, and we want to render
 * those visually distinctly so the admin doesn't mistake them for some
 * obscure-country phone number.
 */
export function isLidNumber(phone) {
  if (!phone) return false;
  if (!/^\d+$/.test(phone)) return false;
  if (phone.length < 14) return false;
  // Don't false-positive on legitimately long international formats that
  // happen to start with a known country prefix
  if (phone.startsWith('972')) return false;
  return true;
}

export function formatPhone(phone) {
  if (!phone) return '';
  // Israeli mobile/landline: 972 + 8-9 digits
  if (phone.startsWith('972') && phone.length >= 11 && phone.length <= 13) {
    return `+972 ${phone.slice(3, 5)}-${phone.slice(5, 8)}-${phone.slice(8)}`;
  }
  if (isLidNumber(phone)) {
    // Render as a visually-distinct tag instead of a fake "+phone". The
    // admin can still see the full identifier and copy-paste it.
    return `🔒 LID·${phone}`;
  }
  return `+${phone}`;
}

/**
 * Render an empty-state placeholder.
 */
export function emptyState(icon, title, description, action = null) {
  const actionHtml = action ? `<div style="margin-top:1rem">${action}</div>` : '';
  return `
    <div class="empty-state">
      <div class="icon">${icon}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(description)}</p>
      ${actionHtml}
    </div>
  `;
}

export function setBtnLoading(btn, loading) {
  if (loading) {
    btn.disabled = true;
    btn.classList.add('loading');
  } else {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}
