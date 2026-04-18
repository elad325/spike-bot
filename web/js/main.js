import { CONFIG } from './config.js';
import { signIn, signOut, getSession, onAuthChange, countPendingUsers, subscribePending, getSettings } from './api.js';
import { setMount, defineRoute, startRouter, navigate } from './router.js';
import { toast, setBtnLoading } from './ui.js';
import { renderMenusPage } from './pages/menus.js';
import { renderUsersPage } from './pages/users.js';
import { renderMessagesPage } from './pages/messages.js';
import { renderSettingsPage } from './pages/settings.js';

const bootLoader = document.getElementById('boot-loader');
const loginScreen = document.getElementById('login-screen');
const appShell = document.getElementById('app-shell');
const mainContent = document.getElementById('main-content');

// ============================================
// Theme
// ============================================
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('spike-theme', theme);
  document.getElementById('icon-moon').classList.toggle('hidden', theme === 'dark');
  document.getElementById('icon-sun').classList.toggle('hidden', theme !== 'dark');
}

function initTheme() {
  const stored = localStorage.getItem('spike-theme');
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(stored || prefers);
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================
// Login
// ============================================
const loginForm = document.getElementById('login-form');
const loginErrorEl = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginErrorEl.classList.add('hidden');
  setBtnLoading(loginBtn, true);
  try {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    await signIn(email, password);
    // Auth state change handler will switch screens
  } catch (err) {
    loginErrorEl.textContent = mapAuthError(err.message);
    loginErrorEl.classList.remove('hidden');
  } finally {
    setBtnLoading(loginBtn, false);
  }
});

function mapAuthError(msg) {
  if (/invalid login credentials/i.test(msg)) return 'אימייל או סיסמה שגויים.';
  if (/email not confirmed/i.test(msg)) return 'יש לאמת את האימייל קודם.';
  if (/too many requests/i.test(msg)) return 'יותר מדי ניסיונות. נסה שוב בעוד מספר דקות.';
  return msg;
}

// ============================================
// Logout
// ============================================
document.getElementById('logout-btn').addEventListener('click', async () => {
  await signOut();
});

// ============================================
// Sidebar toggle (mobile drawer)
// ============================================
const sidebarEl = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');

function setSidebarOpen(open) {
  sidebarEl.classList.toggle('open', open);
  sidebarBackdrop.classList.toggle('show', open);
  // Lock background scroll while drawer is open on mobile
  document.body.style.overflow = open ? 'hidden' : '';
}

document.getElementById('nav-toggle').addEventListener('click', () => {
  setSidebarOpen(!sidebarEl.classList.contains('open'));
});

// Tap the backdrop → close drawer
sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));

// Tapping any nav link should close the drawer (the click navigates first
// thanks to the hash router, so the close happens after the page swaps)
sidebarEl.querySelectorAll('.nav-item').forEach((link) =>
  link.addEventListener('click', () => setSidebarOpen(false))
);

// Escape closes the drawer
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebarEl.classList.contains('open')) setSidebarOpen(false);
});

// Resize back to desktop → drop the open state so styles apply cleanly
const desktopMQ = window.matchMedia('(min-width: 769px)');
desktopMQ.addEventListener('change', (e) => {
  if (e.matches) setSidebarOpen(false);
});

// ============================================
// Bot status indicator
// ============================================
async function updateBotStatus() {
  const el = document.getElementById('bot-status');
  const text = el.querySelector('.status-text');
  try {
    const settings = await getSettings();
    const lastSeen = settings.bot_last_seen_at ? new Date(settings.bot_last_seen_at) : null;
    const ageMs = lastSeen ? Date.now() - lastSeen.getTime() : Infinity;
    const online = ageMs < CONFIG.BOT_ONLINE_THRESHOLD_SECONDS * 1000;
    el.dataset.status = online ? 'online' : 'offline';
    text.textContent = online ? 'הבוט פעיל' : 'הבוט לא פעיל';
  } catch {
    el.dataset.status = 'offline';
    text.textContent = 'לא ידוע';
  }
}

// ============================================
// Pending users badge
// ============================================
async function updatePendingBadge() {
  const badge = document.getElementById('pending-badge');
  const count = await countPendingUsers();
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ============================================
// Boot
// ============================================
async function boot() {
  initTheme();

  setMount(mainContent);
  defineRoute('menus', renderMenusPage);
  defineRoute('users', renderUsersPage);
  defineRoute('messages', renderMessagesPage);
  defineRoute('settings', renderSettingsPage);

  const session = await getSession();
  if (session) {
    showApp();
  } else {
    showLogin();
  }

  bootLoader.classList.add('hidden');

  onAuthChange((session) => {
    if (session) showApp();
    else showLogin();
  });
}

let pendingChannel = null;
let badgeInterval = null;
let statusInterval = null;

function showLogin() {
  loginScreen.classList.remove('hidden');
  appShell.classList.add('hidden');
  if (pendingChannel) {
    pendingChannel.unsubscribe();
    pendingChannel = null;
  }
  if (badgeInterval) clearInterval(badgeInterval);
  if (statusInterval) clearInterval(statusInterval);
}

function showApp() {
  loginScreen.classList.add('hidden');
  appShell.classList.remove('hidden');

  if (!location.hash) {
    location.hash = '#/menus';
  }
  startRouter();

  updatePendingBadge();
  updateBotStatus();

  // Realtime: pending users
  pendingChannel = subscribePending(updatePendingBadge);

  // Periodic refresh
  badgeInterval = setInterval(updatePendingBadge, 30_000);
  statusInterval = setInterval(updateBotStatus, 30_000);
}

boot().catch((err) => {
  console.error('Boot failed:', err);
  bootLoader.innerHTML = `<div style="text-align:center"><p style="color:#ef4444">שגיאה בטעינת האפליקציה</p><p style="color:#94a3b8;margin-top:.5rem;font-size:.85rem">${err.message}</p></div>`;
});
