import { API } from './api.js';
import { UI } from './ui.js';
import { $, escapeHtml } from './utils.js';
import { router } from './router.js';
import { KnowledgeGraph } from './graph-viz.js';
import { t, getLanguage, toggleLanguage, onLanguageChange, applyI18n } from './i18n.js';
import {
  renderHome, renderDigest, renderDigestDate,
  renderSources, renderSourceDetail,
  renderResearchPage,
  renderSignals, renderSignalDetail,
  renderPapers,
  renderPhysicalAI, renderIntelligence, renderIndustryMetrics,
  renderTools, renderToolDetail,
  renderSkills, renderSkillDetail,
  renderSettings, renderTopics, renderTopicDetailPage,
  renderTags, renderTagDetail
} from './pages.js';
import { renderKG3D } from './kg3d.js';

const NAV_LINKS = [
  { path: '/',             i18n: 'nav.news',        icon: '📰' },
  { path: '/papers',       i18n: 'nav.papers',      icon: '📄' },
  { path: '/signals',      i18n: 'nav.signals',     icon: '📡' },
  { path: '/digest',       i18n: 'nav.digest',      icon: '📋' },
  { path: '/sources',      i18n: 'nav.sources',     icon: '🔗' },
  { path: '/tools',        i18n: 'nav.tools',       icon: '🛠️' },
  { path: '/skills',       i18n: 'nav.skills',      icon: '⚡' },
  { path: '/kg3d',        i18n: 'nav.kg3d',        icon: '🧠' },
  { path: '/physical-ai',  i18n: 'nav.physical_ai', icon: '🤖' },
  { path: '/intelligence', i18n: 'nav.intelligence',icon: '📊' },
  { path: '/industry-metrics', i18n: 'nav.industry',icon: '📈' },
];

function renderNav() {
  const nav = $('#mainNav');
  if (!nav) return;
  const currentPath = window.location.pathname;
  nav.innerHTML = NAV_LINKS.map(link => `
    <a href="${link.path}" class="nav-link ${currentPath === link.path || (link.path !== '/' && currentPath.startsWith(link.path)) ? 'active' : ''}">
      <span class="nav-icon">${link.icon}</span>
      <span class="nav-label">${t(link.i18n)}</span>
    </a>
  `).join('');
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
        <a href="/sources">${t('nav.sources')}</a>
      </div>
      <div class="footer-group">
        <h4>${t('footer.make')}</h4>
        <a href="/tools">${t('nav.tools')}</a>
        <a href="/skills">${t('nav.skills')}</a>
        <a href="#" id="savedLink">${t('footer.saved')}</a>
      </div>
      <div class="footer-group">
        <h4>${t('footer.company')}</h4>
        <a href="#">${t('footer.about')}</a>
        <a href="#">${t('footer.faq')}</a>
        <a href="#">${t('footer.privacy')}</a>
        <a href="#">${t('footer.terms')}</a>
      </div>
      <div class="footer-group">
        <h4>${t('footer.follow')}</h4>
        <a href="https://github.com" target="_blank" rel="noopener">GitHub</a>
        <a href="/feed.xml">RSS</a>
        <a href="/feed.json">JSON Feed</a>
      </div>
      <div class="footer-brand">
        <span class="footer-logo">🦅 Eagleye</span>
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
      localStorage.setItem('eagleye-theme', newTheme);
      const svg = themeToggle.querySelector('svg');
      if (newTheme === 'dark') {
        svg.innerHTML = `<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>`;
      } else {
        svg.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
      }
    });
  }

  const langToggle = $('#langToggle');
  if (langToggle) {
    langToggle.addEventListener('click', () => {
      toggleLanguage();
    });
  }

  onLanguageChange(() => {
    updateLangButton();
    renderNav();
    renderFooter();
    applyI18n(document);
    UI.dom.lastUpdated.textContent = t('system.online');
    UI.log(t('system.ready'), 'system');
    document.title = `${t('brand.tagline')} — Eagleye`;
    router.rerenderCurrentRoute();
  });
  document.title = `${t('brand.tagline')} — Eagleye`;

  router.register('/', renderHome);
  router.register('/news', renderHome);
  router.register(/^\/news\/(\d{8})$/, renderHome);
  router.register('/digest', renderDigest);
  router.register(/^\/digest\/(\d{8})$/, renderDigestDate);
  router.register('/sources', renderSources);
  router.register(/^\/sources\/(.+)$/, renderSourceDetail);
  router.register(/^\/research\/(.+)$/, renderResearchPage);
  router.register('/topics', renderTopics);
  router.register(/^\/topics\/(.+)$/, renderTopicDetailPage);
  router.register('/signals', renderSignals);
  router.register(/^\/signals\/(.+)$/, renderSignalDetail);
  router.register('/papers', renderPapers);
  router.register('/physical-ai', renderPhysicalAI);
  router.register('/intelligence', renderIntelligence);
  router.register('/industry-metrics', renderIndustryMetrics);
  router.register('/tools', renderTools);
  router.register(/^\/tools\/(.+)$/, renderToolDetail);
  router.register('/skills', renderSkills);
  router.register(/^\/skills\/(.+)$/, renderSkillDetail);
  router.register('/settings', renderSettings);
  router.register('/kg3d', renderKG3D);
  router.register('/tags', renderTags);
  router.register(/^\/tags\/(.+)$/, renderTagDetail);

  router.beforeEach(() => {
    renderNav();
    const pageContent = $('#pageContent');
    const itemsGrid = $('#itemsGrid');
    const statusBar = $('#statusBar');
    if (pageContent) pageContent.style.display = 'block';
    if (itemsGrid) itemsGrid.style.display = 'none';
    if (statusBar) statusBar.style.display = 'none';
  });

  (/** @type {any} */ (window)).__router = router;
  router.init();

  wireLegacyInteractions();
}

function wireLegacyInteractions() {
  document.addEventListener('click', async (e) => {
    const btn = (/** @type {Element} */ (e.target)).closest('.research-btn');
    if (!btn) return;

    const itemId = (/** @type {HTMLElement} */ (btn)).dataset.itemId;
    if (!itemId) return;
    UI.log(`Open research page: ${itemId}`, 'agent');
    window.open(`/research/${encodeURIComponent(itemId)}`, '_blank', 'noopener');
  });

  document.addEventListener('click', async (e) => {
    const btn = (/** @type {Element} */ (e.target)).closest('.deploy-btn');
    if (!btn) return;

    const itemId = (/** @type {HTMLElement} */ (btn)).dataset.itemId;
    if (!itemId) {
      alert(t('common.deploy_unavailable'));
      return;
    }

    UI.dom.researchTitle.textContent = t('common.deploy_generating');
    UI.dom.researchBody.innerHTML = `<div class="spinner"></div><p style="text-align:center; font-family:var(--font-mono);">${t('common.deploy_feasibility')}</p>`;
    UI.dom.researchModal.style.display = 'block';

    try {
      const res = await fetch(`/api/items/${encodeURIComponent(itemId)}/deployment-plan`, { method: 'POST' });
      const data = await res.json();

      if (data.error) {
        UI.dom.researchBody.innerHTML = `<p style="color:red">${escapeHtml(data.error)}</p>`;
        return;
      }

      const plan = data.plan || 'No plan generated.';
      const eligibility = data.eligibility || {};

      UI.dom.researchBody.innerHTML = `
        <div style="padding: 20px; max-width: 720px; margin: 0 auto;">
          <div style="margin-bottom: 16px; display:flex; gap:12px; align-items:center;">
            <span style="padding:4px 12px; border-radius:4px; font-size:12px; font-family:var(--font-mono);
              background:${eligibility.eligibility === 'deployable' ? 'var(--accent)' : '#666'};
              color:${eligibility.eligibility === 'deployable' ? '#000' : '#fff'};">
              ${(eligibility.eligibility || 'unknown').toUpperCase()}
            </span>
            <span style="color:var(--fg-mute); font-size:13px;">${escapeHtml(eligibility.reason || '')}</span>
          </div>
          <div class="markdown-body">${formatDeployPlan(plan)}</div>
        </div>
      `;
    } catch (_err) {
      UI.dom.researchBody.innerHTML = `<p style="color:red">${t('common.error')}: ${_err.message}</p>`;
    }
  });

  $('.close-modal')?.addEventListener('click', () => {
    UI.dom.researchModal.style.display = 'none';
  });

  window.addEventListener('click', (e) => {
    if (e.target === UI.dom.researchModal) {
      UI.dom.researchModal.style.display = 'none';
    }
  });

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
        canvas.innerHTML = `<p style="color:red; text-align:center; padding-top:100px;">${t('common.graph_error', { msg: err.message })}</p>`;
      }
    });
  }

  if (closeGraph) {
    closeGraph.addEventListener('click', () => {
      graphOverlay.style.display = 'none';
    });
  }
}

function formatDeployPlan(md) {
  if (!md) return `<p>${t('common.empty')}</p>`;

  const html = md
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .trim();

  return '<p>' + html + '</p>';
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
        fullGraphInstance.init(fullData);

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
  fullGraphInstance.init(data);

  fullGraphInstance.setOnNodeClick((node) => {
    if (node.type === 'topic' && node.slug) {
      (/** @type {any} */ (window)).__router?.navigate(`/topics/${node.slug}`);
      document.getElementById('graphOverlay').style.display = 'none';
    }
  });
}
