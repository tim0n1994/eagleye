import { API } from './api.js';
import { UI } from './ui.js';
import { $, escapeHtml, escapeAttr } from './utils.js';
import { router } from './router.js';
import { KnowledgeGraph } from './graph-viz.js';
import { t, getLanguage, toggleLanguage, onLanguageChange, applyI18n } from './i18n.js';
import {
  renderHome, renderDigest, renderDigestDate,
  renderSources, renderSourceDetail,
  renderSignals, renderSignalDetail,
  renderPapers,
  renderPhysicalAI, renderEducation, renderIntelligence, renderIndustryMetrics,
  renderSettings, renderTopics, renderTopicDetailPage,
  renderTags, renderTagDetail, renderSaved, renderStories, renderEntityTrajectory, renderWatchlist, renderLens, renderForYou, markItemSeen,
  renderYearArchive, renderYearDetail, renderCompare, renderSearch, renderHelp, renderCompareEntities, renderDiscover,
  renderLogin, renderRegister,
} from './pages.js';
import { renderMarkdown } from './markdown.js';

  const NAV_LINKS = [
  { path: '/for-you',      i18n: 'nav.foryou' },
  { path: '/',             i18n: 'nav.news' },
  { path: '/physical-ai',  i18n: 'nav.physical_ai' },
  { path: '/ai-education', i18n: 'nav.ai_education' },
  { path: '/neuroscience', i18n: 'nav.neuroscience' },
  { path: '/papers',       i18n: 'nav.papers' },
  { path: '/signals',      i18n: 'nav.signals' },
  { path: '/digest',       i18n: 'nav.digest' },
  { path: '/sources',      i18n: 'nav.sources' },
  { path: '/discover',     i18n: 'nav.discover' },
  { path: '/topics',       i18n: 'nav.topics' },
  { path: '/trends',       i18n: 'nav.trends' },
  { path: '/watchlist',    i18n: 'nav.watchlist' },
];

function renderNav() {
  const nav = $('#mainNav');
  if (!nav) return;
  const currentPath = ({ '/kg3d': '/topics', '/intelligence': '/trends', '/industry-metrics': '/system-status' })[window.location.pathname] || window.location.pathname;
  const isActive = (link) => currentPath === link.path || (link.path !== '/' && currentPath.startsWith(link.path));

  nav.innerHTML = NAV_LINKS.map(link => `
    <a href="${link.path}" class="nav-link ${isActive(link) ? 'active' : ''}" ${isActive(link) ? 'aria-current="page"' : ''}>

      <span class="nav-label">${t(link.i18n)}</span>
    </a>
  `).join('');

  // The navigation scrolls horizontally on narrow screens. Keep the active
  // section visible when arriving by a deep link or browser history.
  requestAnimationFrame(() => {
    const active = nav.querySelector('.nav-link.active');
    if (!active) return;
    const bounds = nav.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right + 8;
    else if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left + 8;
  });

  // Async: fetch saved-items count and show a badge on the Saved footer link.
  fetch('/api/saved').then(r => r.json()).then(data => {
    const count = data.total || 0;
    if (count > 0) {
      const savedLink = document.getElementById('savedLink');
      if (savedLink) {
        const badge = document.createElement('span');
        badge.className = 'nav-badge';
        badge.textContent = String(count);
        savedLink.appendChild(badge);
      }
    }
  }).catch(() => {});
}

function renderFooter() {
  const footer = $('#mainFooter');
  if (!footer) return;
  footer.innerHTML = `
    <div class="footer-inner">
      <div class="footer-group">
        <h4>${t('footer.read')}</h4>
        <a href="/">${t('nav.news')}</a>
        <a href="/digest">${t('nav.digest')}</a>
        <a href="/signals">${t('nav.signals')}</a>
        <a href="/stories">${t('nav.stories')}</a>
        <a href="/sources">${t('nav.sources')}</a>
        <a href="/year">${t('nav.year')}</a>
        <a href="/search">${t('nav.search')}</a>
      </div>
      <div class="footer-group">
        <h4>${t('footer.make')}</h4>
        <a href="/watchlist">${t('nav.watchlist')}</a>
        <a href="/compare">${t('nav.compare')}</a>
        <a href="/saved" id="savedLink">${t('footer.saved')}</a>
      </div>
      <div class="footer-group">
        <h4>${t('footer.company')}</h4>
        <a href="/system-status">${t('nav.system_status')}</a>
        <a href="/help">${t('footer.about')}</a>
        <a href="/help">${t('footer.faq')}</a>
        <a href="/help">${t('footer.privacy')}</a>
        <a href="/help">${t('footer.terms')}</a>
      </div>
      <div class="footer-group">
        <h4>${t('footer.follow')}</h4>
        <a href="https://github.com" target="_blank" rel="noopener">GitHub</a>
        <a href="/feed.xml">RSS</a>
        <a href="/feed.json">JSON Feed</a>
      </div>
      <div class="footer-group">
        <h4>${t('footer.shortcuts')}</h4>
        <span style="font-size:11px;color:var(--fg-mute);line-height:1.8">
          <kbd class="kbd">⌘K</kbd> ${t('footer.command_palette')}<br/>
          <kbd class="kbd">/</kbd> ${t('nav.search')}<br/>
          <kbd class="kbd">g</kbd>+${t('footer.navigate')}
        </span>
        <a href="/help" style="font-size:11px;display:block;margin-top:4px">${t('footer.all_shortcuts')}</a>
      </div>
      <div class="footer-brand">
        <span class="footer-logo">Eagleye</span>
        <span class="footer-tagline">${t('brand.tagline')}</span>
      </div>
    </div>
    <div class="footer-bottom">
      <span>${t('footer.copyright', { year: new Date().getFullYear() })}</span>
    </div>
  `;
}

function updateLangButton() {
  const btn = $('#langToggle');
  if (!btn) return;
  const label = btn.querySelector('.lang-btn-label');
  if (label) {
    label.textContent = getLanguage() === 'en' ? '中' : 'EN';
  }
  btn.setAttribute('title', t('lang.switchTo'));
  btn.setAttribute('aria-label', t('lang.switchTo'));
  btn.setAttribute('data-lang-active', getLanguage());
}

export async function initApp() {
  UI.cacheDom();
  document.documentElement.setAttribute('lang', getLanguage() === 'zh' ? 'zh-CN' : 'en');
  document.documentElement.setAttribute('data-lang', getLanguage());

  renderNav();
  renderFooter();
  updateLangButton();
  applyI18n(document);

  UI.dom.lastUpdated.textContent = t('system.online');
  UI.initBottomPanel();
  UI.log(t('system.ready'), 'system');

  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      try { localStorage.setItem('eagleye-theme', newTheme); } catch { /* Theme still applies when storage is blocked. */ }
      const svg = themeToggle.querySelector('svg');
      if (newTheme === 'dark') {
        svg.innerHTML = `<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>`;
      } else {
        svg.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
      }
    });
  }

  const menu = $('#navMenuToggle');
  menu?.addEventListener('click', () => {
    const expanded = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(expanded));
    document.querySelector('.header').classList.toggle('nav-open', expanded);
  });
  document.querySelector('.header')?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') {
      menu.setAttribute('aria-expanded', 'false');
      document.querySelector('.header').classList.remove('nav-open');
      menu.focus();
    }
  });

  const langToggle = $('#langToggle');
  if (langToggle) {
    langToggle.addEventListener('click', () => {
      toggleLanguage();
    });
  }

  // Header sync button — trigger FETCH_ALL and surface progress in the sidebar log.
  // Full per-stage progress remains on /settings; this is the one-click entry point.
  const syncNowBtn = UI.dom.syncBtn;
  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', async () => {
      syncNowBtn.disabled = true;
      UI.log(t('ops.running'), 'agent');
      try {
        const data = await API.triggerSync();
        const msg = data.message || data.job_id || 'ok';
        UI.log(t('ops.done', { msg }), 'success');
      } catch (err) {
        UI.log(t('ops.failed', { msg: err.message }), 'error');
      } finally {
        syncNowBtn.disabled = false;
      }
    });
  }

  onLanguageChange(async () => {
    const path = window.location.pathname + window.location.search;
    const scrollY = window.scrollY;
    const controls = [...document.querySelectorAll('#pageContent input[id], #pageContent select[id], #pageContent textarea[id]')]
      .filter(el => !['file', 'submit', 'button'].includes(el.type))
      .map(el => ({ id: el.id, value: el.value, checked: el.checked }));
    const openDetails = [...document.querySelectorAll('#pageContent details[id][open]')].map(el => el.id);
    updateUserButton();
    fullGraphInstance?.refreshLanguage();
    document.getElementById('commandPalette')?.remove();
    updateLangButton();
    renderNav();
    renderFooter();
    applyI18n(document);
    UI.dom.lastUpdated.textContent = t('system.online');
    UI.log(t('system.ready'), 'system');
    document.title = `${t('brand.tagline')} — Eagleye`;
    await router.rerenderCurrentRoute();
    if (path !== window.location.pathname + window.location.search) return;
    for (const saved of controls) {
      const el = document.getElementById(saved.id);
      if (!el) continue;
      el.value = saved.value;
      if ('checked' in el) el.checked = saved.checked;
      // Reapply text filtering without firing configuration writes.
      if (el.id === 'heroSearchInput' && saved.value) el.dispatchEvent(new Event('input'));
    }
    for (const id of openDetails) { const el = document.getElementById(id); if (el) el.open = true; }
    window.scrollTo({ top: scrollY, behavior: 'instant' });
  });
  document.title = `${t('brand.tagline')} — Eagleye`;

  router.register('/', renderHome);
  router.register('/for-you', renderForYou);
  router.register('/news', renderHome);
  router.register(/^\/news\/(\d{8})$/, renderHome);
  router.register('/digest', renderDigest);
  router.register(/^\/digest\/(\d{8})$/, renderDigestDate);
  router.register('/sources', renderSources);
  router.register(/^\/sources\/(.+)$/, renderSourceDetail);
  router.register('/topics', renderTopics);
  router.register(/^\/topics\/(.+)$/, renderTopicDetailPage);
  router.register('/signals', renderSignals);
  router.register(/^\/signals\/(.+)$/, renderSignalDetail);
  router.register('/papers', renderPapers);
  router.register('/physical-ai', renderPhysicalAI);
  router.register('/ai-education', renderEducation);
  router.register('/neuroscience', async () => {
    const { renderNeuroscience } = await import('./pages/neuroscience.js');
    return renderNeuroscience();
  });
  router.register('/trends', renderIntelligence);
  router.register('/intelligence', renderIntelligence);
  router.register('/system-status', renderIndustryMetrics);
  router.register('/industry-metrics', renderIndustryMetrics);
  router.register('/settings', renderSettings);
  router.register('/saved', renderSaved);
  router.register('/stories', renderStories);
  router.register(/^\/trajectory\/(.+)$/, renderEntityTrajectory);
  router.register('/watchlist', renderWatchlist);
  router.register('/lens', renderLens);
  router.register('/year', renderYearArchive);
  router.register(/^\/year\/(\d{4})$/, renderYearDetail);
  router.register('/compare', renderCompare);
  router.register('/search', renderSearch);
  router.register('/help', renderHelp);
  router.register('/compare-entities', renderCompareEntities);
  router.register('/discover', renderDiscover);
  router.register('/kg3d', renderTopics);
  router.register('/tags', renderTags);
  router.register(/^\/tags\/(.+)$/, renderTagDetail);
  // Auth routes
  router.register('/login', renderLogin);
  router.register('/register', renderRegister);
  for (const path of ['/pricing','/billing']) router.register(path,async()=>{ const page=await import('./pages/billing.js'); return page.renderBilling(); });
  for (const path of ['/forgot-password','/reset-password']) {
    router.register(path, async () => {
    const location = window.location.href;
    const module = await import('./pages/password-recovery.js');
    if (window.location.href === location) return module.renderPasswordRecovery();
    });
  }

  // ─── Auth state: check login on every route change ────────────────────
  let _currentUser = null;
  const AUTH_ROUTES = new Set(['/login', '/register', '/forgot-password', '/reset-password', '/pricing']);

  async function refreshAuthState() {
    try { _currentUser = await API.me(); } catch { _currentUser = null; }
    updateUserButton();
    return _currentUser;
  }

  function updateUserButton() {
    const btn = $('#userLink');
    if (!btn) return;
    if (_currentUser) {
      const name = _currentUser.display_name || _currentUser.email.split('@')[0];
      btn.innerHTML = `<span>${escapeHtml(name)}</span>`;
      btn.title = _currentUser.email;
      btn.href = '/billing';
    } else {
      btn.innerHTML = `<span>${getLanguage() === 'zh' ? '登录' : 'Sign In'}</span>`;
      btn.title = t('auth.signin');
      btn.href = '/login';
    }
  }

  router.beforeEach(async () => {
    // Auth guard: redirect to login if not authenticated (unless on auth page)
    const path = window.location.pathname;
    if (!_currentUser) {
      await refreshAuthState();
    }
    if (!_currentUser && !AUTH_ROUTES.has(path)) {
      window.location.href = '/login';
      return false;
    }
    if (_currentUser && !AUTH_ROUTES.has(path) && path!=='/billing') {
      await refreshAuthState();
      if (!_currentUser?.billing?.access) { window.location.href='/billing'; return false; }
      if (_currentUser.billing.plan!=='analyst' && /^\/(topics|trends|trajectory|graph|watchlist|discover|signals)(\/|$)/.test(path)) { window.location.href='/billing?upgrade=analyst'; return false; }
    }
    // If logged in and on auth page, redirect to home
    if (_currentUser && ['/login','/register'].includes(path)) {
      window.location.href = '/';
      return false;
    }

    renderNav();
    document.querySelector('.header').classList.remove('nav-open');
    menu?.setAttribute('aria-expanded', 'false');
    document.body.dataset.page = path === '/login' || path === '/register' ? 'auth' : 'workspace';
    const pageContent = $('#pageContent');
    const itemsGrid = $('#itemsGrid');
    const statusBar = $('#statusBar');
    if (pageContent) pageContent.style.display = 'block';
    if (itemsGrid) itemsGrid.style.display = 'none';
    if (statusBar) statusBar.style.display = 'none';

    // Hide chrome (header/sidebar/footer) on auth pages
    const isAuthPage = AUTH_ROUTES.has(path);
    document.body.classList.toggle('auth-page', isAuthPage);

    // Global loading bar
    let bar = document.getElementById('navProgress');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'navProgress';
      bar.style.cssText = 'position:fixed;top:0;left:0;height:2px;background:var(--accent);z-index:9998;width:100%;transform:scaleX(0);transform-origin:left;transition:transform 0.2s ease';
      document.body.appendChild(bar);
    }
    bar.style.transform = 'scaleX(.3)';
    bar.style.opacity = '1';
    requestAnimationFrame(() => { bar.style.transform = 'scaleX(.7)'; });
    setTimeout(() => { bar.style.transform = 'scaleX(1)'; setTimeout(() => { bar.style.opacity = '0'; bar.style.transform = 'scaleX(0)'; }, 200); }, 600);
  });

  // ─── Per-route document.title + screen-reader announcement ────────────
  // Before this, every one of the ~37 routes shared a single title set once
  // at boot, so the browser tab, history entries and bookmarks all read the
  // tagline regardless of page. Map each path to the i18n key it already uses
  // in the nav, falling back to the tagline. Detail (regex) routes reuse the
  // same label as their index page — good enough and stays in sync on edits.
  const ROUTE_TITLES = {
    '/': 'nav.news',
    '/news': 'nav.news',
    '/for-you': 'nav.foryou',
    '/digest': 'nav.digest',
    '/sources': 'nav.sources',
    '/topics': 'nav.topics',
    '/signals': 'nav.signals',
    '/papers': 'nav.papers',
    '/physical-ai': 'nav.physical_ai',
    '/ai-education': 'nav.ai_education',
    '/neuroscience': 'nav.neuroscience',
    '/trends': 'nav.trends',
    '/system-status': 'nav.system_status',
    '/intelligence': 'nav.trends',
    '/industry-metrics': 'nav.system_status',
    '/tags': 'nav.tags',
    '/trajectory': 'nav.tags',
    '/settings': 'nav.settings',
    '/saved': 'footer.saved',
    '/stories': 'nav.stories',
    '/watchlist': 'nav.watchlist',
    '/lens': 'nav.lens',
    '/year': 'nav.year',
    '/compare': 'nav.compare',
    '/compare-entities': 'nav.compare',
    '/search': 'nav.search',
    '/help': 'footer.about',
    '/discover': 'nav.discover',
    '/kg3d': 'nav.topics',
    '/login': 'auth.signin',
    '/register': 'auth.register',
  };

  /**
   * Resolve a human label + document.title for a path. Detail pages (e.g.
   * /sources/foo) match by their longest static prefix. Returns the resolved
   * i18n string, never a bare key — t() falls back to the key only on miss.
   */
  function resolveRouteTitle(path) {
    if (ROUTE_TITLES[path]) return t(ROUTE_TITLES[path]);
    // Longest-prefix match for detail routes (e.g. /sources/x -> 'nav.sources').
    let best = '';
    for (const key of Object.keys(ROUTE_TITLES)) {
      if (path.startsWith(key + '/') && key.length > best.length) best = key;
    }
    return best ? t(ROUTE_TITLES[best]) : t('brand.tagline');
  }

  router.afterEach((path) => {
    const label = resolveRouteTitle(path);
    document.title = `${label} — Eagleye`;
    // aria-live region: announce the new page so screen-reader users hear the
    // navigation even when focus move is suppressed or the heading is off-screen.
    const live = document.getElementById('srStatus');
    if (live) {
      live.textContent = '';
      // Re-set on next tick so the empty-then-fill re-triggers the announcement
      // for back-to-back navigations to routes with the same label.
      setTimeout(() => { if (live) live.textContent = label; }, 50);
    }
  });

  // Expose for logout button
  (/** @type {any} */ (window)).__logout = async () => {
    await API.logout();
    _currentUser = null;
    window.location.href = '/login';
  };
  (/** @type {any} */ (window)).__currentUser = () => _currentUser;

  (/** @type {any} */ (window)).__router = router;

  // Check auth before first render
  await refreshAuthState();
  if (!_currentUser && !AUTH_ROUTES.has(window.location.pathname)) {
    window.location.href = '/login';
    return;
  }

  router.init();

  wireLegacyInteractions();

  // Global: copy BibTeX citation to clipboard (used by paper cards).
  (/** @type {any} */ (window)).__copyBibtex = function(bibtex) {
    navigator.clipboard?.writeText(bibtex).then(() => {
      UI.log(t('export.bibtex_copied'), 'success');
    }).catch(() => {});
  };

  // Global: export a daily digest as a Markdown file download (§7.3).
  (/** @type {any} */ (window)).__exportDigest = function(digestJson, date) {
    let d;
    try { d = JSON.parse(digestJson); } catch { return; }
    const parseList = (field) => { try { const a = typeof field === 'string' ? JSON.parse(field) : field; return Array.isArray(a) ? a : []; } catch { return []; } };
    let md = `# ${t('export.digest')} / ${date}\n\n`;
    md += `**${d.headline || ''}**\n\n`;
    md += `${d.executive_summary || ''}\n\n`;
    const sections = [[t('export.top_signals'), 'top_signals', 'title'], [t('export.emerging_topics'), 'emerging_topics', 'topic'], [t('export.repo_watch'), 'repo_watch', 'repo'], [t('export.paper_watch'), 'paper_watch', 'paper'], [t('export.product_watch'), 'product_watch', 'product'], [t('export.risk_watch'), 'risk_watch', 'risk']];
    for (const [label, field, nameKey] of sections) {
      const items = parseList(d[field]);
      if (items.length) { md += `## ${label}\n`; for (const it of items) md += `- ${it[nameKey] || it.title || ''}${it.why || it.reason ? ` — ${it.why || it.reason}` : ''}\n`; md += '\n'; }
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `digest-${date}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Keyboard shortcuts: '/' focuses search, 'g'+letter navigates pages,
  // Ctrl/Cmd+K opens command palette.
  // Ignore when typing in an input/textarea (don't hijack text entry).
  let gKeyBuffer = '';
  let gKeyTimer = null;
  const navMap = {
    f: '/for-you', n: '/', p: '/papers', s: '/signals', d: '/digest',
    o: '/sources', y: '/year', c: '/compare',
    w: '/watchlist', l: '/lens', i: '/trends', h: '/help', e: '/compare-entities',
  };
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+K: open command palette (works even in inputs).
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      window.__openCommandPalette?.();
      return;
    }

    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === '/') {
      e.preventDefault();
      const searchInput = document.getElementById('globalSearchInput')
        || document.getElementById('heroSearchInput');
      if (searchInput) { searchInput.focus(); }
      else { router.navigate('/search'); }
      return;
    }
    // 'g' + letter: two-key navigation (GitHub-style).
    if (e.key === 'g') {
      gKeyBuffer = 'g';
      clearTimeout(gKeyTimer);
      gKeyTimer = setTimeout(() => { gKeyBuffer = ''; }, 800);
      return;
    }
    if (gKeyBuffer === 'g' && navMap[e.key]) {
      e.preventDefault();
      router.navigate(navMap[e.key]);
      gKeyBuffer = '';
    }
  });

  // Back-to-top button: appears on scroll, smooth-scrolls to top.
  if (!document.getElementById('backToTop')) {
    const btn = document.createElement('button');
    btn.id = 'backToTop';
    btn.innerHTML = '↑';
    btn.title = t('common.back_top');
    btn.setAttribute('data-i18n-attr', 'title|common.back_top;aria-label|common.back_top');
    btn.style.cssText = 'position:fixed;bottom:20px;right:20px;width:40px;height:40px;border-radius:50%;border:1px solid var(--rule);background:var(--bg-card);color:var(--accent);font-size:18px;cursor:pointer;display:none;z-index:999;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    document.body.appendChild(btn);
    btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
    window.addEventListener('scroll', () => {
      btn.style.display = window.scrollY > 600 ? 'block' : 'none';
    });
  }

  // Global toast notification system for ephemeral feedback (save/unsave/subscribe).
  (/** @type {any} */ (window)).__toast = function(msg, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.style.cssText = 'position:fixed;top:70px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    const colors = { success: 'var(--accent)', error: 'var(--color-error)', info: 'var(--fg-dim)' };
    toast.style.cssText = `background:var(--bg-card);border:1px solid ${colors[type] || colors.info};border-left:3px solid ${colors[type] || colors.info};border-radius:var(--radius);padding:10px 16px;font-size:13px;color:var(--fg);box-shadow:0 2px 12px rgba(0,0,0,0.3);max-width:320px;pointer-events:auto;opacity:0;transition:opacity 0.3s`;
    toast.textContent = msg;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  };

  // Command palette (Ctrl/Cmd+K): a quick-navigation overlay with fuzzy search.
  (/** @type {any} */ (window)).__openCommandPalette = function() {
    // Remove existing palette if open.
    const existing = document.getElementById('commandPalette');
    if (existing) { existing.remove(); return; }

    const commands = [
      ...NAV_LINKS.map(link => ({ label: t(link.i18n), url: link.path, kw: link.path })),
      ...[['/search', 'nav.search'], ['/saved', 'footer.saved'], ['/lens', 'nav.lens'],
        ['/year', 'nav.year'], ['/compare', 'nav.compare'], ['/compare-entities', 'nav.entity_compare'],
        ['/trends', 'nav.trends'], ['/system-status', 'nav.system_status'], ['/help', 'footer.about'],
        ['/settings', 'nav.settings'], ['/stories', 'nav.stories'], ['/tags', 'nav.tags']]
        .map(([url, key]) => ({ label: t(key), url, kw: url })),
    ].filter((command, index, list) => list.findIndex(item => item.url === command.url) === index);
    const opener = document.activeElement;
    const close = () => { overlay.remove(); if (opener?.isConnected) opener.focus(); };

    const overlay = document.createElement('div');
    overlay.id = 'commandPalette';
    overlay.className = 'command-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t('footer.command_palette'));
    overlay.innerHTML = `
      <div class="command-panel">
        <div class="command-search"><input type="search" id="cmdPaletteInput" aria-label="${escapeAttr(t('nav.search_commands'))}" placeholder="${escapeAttr(t('nav.search_commands'))}" autocomplete="off"/>
        <button type="button" class="icon-btn command-close" aria-label="${escapeAttr(t('common.close'))}">×</button></div>
        <div id="cmdPaletteResults"></div>
      </div>`;

    document.body.appendChild(overlay);
    const input = overlay.querySelector('#cmdPaletteInput');
    const resultsEl = overlay.querySelector('#cmdPaletteResults');

    const renderResults = (q) => {
      const ql = q.toLowerCase().trim();
      const filtered = ql ? commands.filter(c => c.label.toLowerCase().includes(ql) || c.kw.includes(ql)) : commands;
      resultsEl.innerHTML = filtered.length === 0 ? `<p class="command-empty">${t('nav.no_matches')}</p>` :
        filtered.map(c => `<a href="${c.url}" class="command-result" data-url="${c.url}"><span>${escapeHtml(c.label)}</span><span class="command-path">${escapeHtml(c.url)}</span></a>`).join('');
    };

    renderResults('');
    input.focus();

    input.addEventListener('input', () => renderResults(input.value));
    overlay.querySelector('.command-close').addEventListener('click', close);
    overlay.addEventListener('keydown', e => {
      const links = [...resultsEl.querySelectorAll('a[data-url]')];
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const current = links.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? current + 1 : current < 0 ? links.length - 1 : current - 1;
        (links[(next + links.length) % links.length] || input).focus();
      }
      if (e.key === 'Enter' && e.target === input && links[0]) { e.preventDefault(); links[0].click(); }
      if (e.key === 'Tab') {
        const focusable = [...overlay.querySelectorAll('input, button, a[href]')];
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close();
      const link = e.target.closest('a[data-url]');
      if (link) { e.preventDefault(); e.stopPropagation(); close(); router.navigate(link.dataset.url); }
    });
  };
}

function wireLegacyInteractions() {

  const showGraph = $('#showGraph');
  const closeGraph = $('#closeGraph');
  const graphOverlay = $('#graphOverlay');

  if (showGraph) {
    showGraph.addEventListener('click', async () => {
      graphOverlay.style.display = 'block';
      const canvas = $('#graphCanvas');
      if (!canvas) return;
      canvas.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; font-family:var(--font-mono);">${t('common.connecting_graph')}</div>`;

      try {
        const data = await API.fetchGraph();
        renderGraph(data);
      } catch (err) {
        canvas.innerHTML = `<p style="color:var(--color-error); text-align:center; padding-top:100px;">${t('common.graph_error', { msg: err.message })}</p>`;
      }
    });
  }

  if (closeGraph) {
    closeGraph.addEventListener('click', () => {
      graphOverlay.style.display = 'none';
    });
  }
}

// Deploy plans are LLM output built from scraped repo content, so they go
// through the shared sanitizing renderer rather than a raw regex pass.
export function formatDeployPlan(md) {
  return renderMarkdown(md, t('common.empty'));
}

let fullGraphInstance = null;

async function renderGraph(data) {
  const canvas = $('#graphCanvas');
  if (!canvas) return;

  canvas.innerHTML = '';

  if (!data.nodes || data.nodes.length === 0) {
    try {
      const fullData = await fetch('/api/graph/full').then(r => r.json());
      if (fullData.nodes && fullData.nodes.length > 0) {
        fullGraphInstance = new KnowledgeGraph('graphCanvas');
        await fullGraphInstance.init(fullData);

        fullGraphInstance.setOnNodeClick((node) => {
          if (node.type === 'topic' && node.slug) {
            (/** @type {any} */ (window)).__router?.navigate(`/topics/${node.slug}`);
            document.getElementById('graphOverlay').style.display = 'none';
          }
        });
        return;
      }
    } catch {
      // Fall through to empty state
    }
    canvas.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; opacity:0.5; font-family:var(--font-mono);">${t('common.graph_void')}</div>`;
    return;
  }

  fullGraphInstance = new KnowledgeGraph('graphCanvas');
  await fullGraphInstance.init(data);

  fullGraphInstance.setOnNodeClick((node) => {
    if (node.type === 'topic' && node.slug) {
      (/** @type {any} */ (window)).__router?.navigate(`/topics/${node.slug}`);
      document.getElementById('graphOverlay').style.display = 'none';
    }
  });
}
