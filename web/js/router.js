const routes = {};
let currentRoute = null;
let mountEl = null;

export function defineRoute(name, renderFn) {
  routes[name] = renderFn;
}

export function setMount(el) {
  mountEl = el;
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  return h || 'menus';
}

export async function navigate(name) {
  if (location.hash !== `#/${name}`) {
    location.hash = `#/${name}`;
    return; // hashchange will trigger render
  }
  await render(name);
}

async function render(name) {
  if (!mountEl) return;
  const fn = routes[name] || routes.menus;
  if (!fn) {
    mountEl.innerHTML = '<div class="page"><h2>404</h2></div>';
    return;
  }

  // Cleanup previous route if it returned a teardown
  if (currentRoute?.teardown) {
    try { currentRoute.teardown(); } catch {}
  }

  mountEl.innerHTML = '';
  try {
    const result = await fn(mountEl);
    currentRoute = { name, teardown: result?.teardown };
  } catch (err) {
    console.error('Route render error:', err);
    mountEl.innerHTML = `<div class="page"><div class="empty-state"><div class="icon">😵</div><h3>שגיאה בטעינה</h3><p>${err.message}</p></div></div>`;
  }

  // Update active nav
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === name);
  });
  // Close mobile sidebar
  document.getElementById('sidebar')?.classList.remove('open');
}

export function startRouter() {
  window.addEventListener('hashchange', () => render(parseHash()));
  render(parseHash());
}
