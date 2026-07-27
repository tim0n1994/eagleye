/**
 * Eagleye — catalog page module
 *
 * Tool and Claude-Skill catalogues.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeAttr, escapeHtml } from '../utils.js';
import { renderToolBySlug } from '../tools.js';
import { getLanguage, t } from '../i18n.js';
import { showError, showLoader } from './shared.js';


// ─── Tools ─────────────────────────────────────────────────

export function renderTools(_params) {
  const container = $('#pageContent');

  const categories = [
    { name: 'Image Tools', icon: '🖼️', tools: ['Image Compressor', 'Image Resizer', 'Image Converter', 'HEIC to JPG', 'Image Cropper', 'Screenshot Beautify'] },
    { name: 'Video & Audio', icon: '🎬', tools: ['Video Compressor', 'Video to GIF', 'Audio Compressor', 'Media Converter', 'Audio Extractor', 'Voice Recorder'] },
    { name: 'Developer Tools', icon: '⚙️', tools: ['JSON Formatter', 'Code Minifier', 'Base64 Encoder', 'QR Generator', 'Color Picker'] },
    { name: 'Documents & Utility', icon: '📄', tools: ['PDF Compressor', 'Unit Converter', 'Timezone Converter', 'ZIP Creator', 'Markdown Preview', 'LaTeX Preview'] },
    { name: 'Finance', icon: '💰', tools: ['Mortgage Calculator', 'HELOC Calculator', 'Leverage Calculator'] },
    { name: 'More Tools', icon: '🔧', tools: ['Chronograph', '2FA Authenticator', 'Password Generator', 'App Stats', 'UTM Generator', 'IP Lookup', 'Peepbo'] },
  ];
  const totalTools = categories.reduce((s, c) => s + c.tools.length, 0);

  const html = `
    <section class="page-section">
      <div class="page-header">
        <h2 class="page-title">${t('tools.title')}</h2>
        <p class="page-description">${t('tools.subtitle')} · ${totalTools} ${getLanguage() === 'zh' ? '个工具' : 'tools'} · ${getLanguage() === 'zh' ? '全部本地运行' : 'all run locally'}</p>
      </div>
      <div class="tool-catalog">
        ${categories.map(cat => `
          <div class="tool-category">
            <h3 class="tool-category-title"><span class="tool-cat-icon">${cat.icon}</span> ${cat.name}</h3>
            <div class="tool-grid">
              ${cat.tools.map(tool => `
                <a href="/tools/${tool.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}" class="tool-card">
                  <span class="tool-name">${escapeHtml(tool)}</span>
                  <span class="tool-badge">LOCAL</span>
                </a>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  `;

  container.innerHTML = html;
}

// ─── Tool Detail ────────────────────────────────────────────

export function renderToolDetail(params) {
  const container = $('#pageContent');
  const slug = params?.slug || '';
  renderToolBySlug(slug, container);
}

// ─── Skill Detail ──────────────────────────────────────────

export async function renderSkillDetail(params) {
  const container = $('#pageContent');
  const skillId = params?.slug || params?.id || '';

  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING SKILL...' : t('common.loading'));

  try {
    let skillData = null;
    try {
      const res = await fetch('/api/skills/' + encodeURIComponent(skillId));
      const json = await res.json();
      skillData = json.skill;      } catch {
      // Fallback: try looking up by slug
    }

    if (!skillData) {
      const notFound = getLanguage() === 'zh' ? '未找到技能。' : 'Skill not found.';
      container.innerHTML = `<section class="page-section"><div class="page-header"><h2 class="page-title">${t('skills.title')}</h2><a href="/skills" class="nav-link">← ${t('skills.title')}</a></div><p>${notFound}</p></section>`;
      return;
    }

    const html = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('skills.title')} / ${escapeHtml(skillData.name)}</h2>
          <a href="/skills" class="nav-link">← ${t('skills.title')}</a>
        </div>
        <div class="skill-detail">
          <div class="skill-detail-header">
            <div class="skill-name-big">${escapeHtml(skillData.name)}</div>
            <div class="skill-meta">
              <span class="skill-category-tag">${escapeHtml(skillData.category)}</span>
              <span class="skill-stars">★ ${skillData.stars?.toLocaleString() || 0}</span>
              <span class="skill-installs">📦 ${skillData.installs || 'N/A'}</span>
              <span class="skill-author">👤 ${escapeHtml(skillData.author || t('skills.unknown_author'))}</span>
            </div>
            <p class="skill-description">${escapeHtml(skillData.description || '')}</p>
            <div class="skill-tags">
              ${(skillData.tags || []).map(t => `<span class="skill-tag">${escapeHtml(t)}</span>`).join('')}
            </div>
            <div class="skill-install-code">
              <code>${escapeHtml(skillData.install_command || 'claude add ' + skillData.slug || 'N/A')}</code>
              <button class="copy-btn" onclick="navigator.clipboard.writeText('${escapeAttr(skillData.install_command || '')}')">Copy</button>
            </div>
          </div>
          <div class="skill-detail-repo">
            ${skillData.repo_url ? `<p>Repository: <a href="${escapeAttr(skillData.repo_url)}" target="_blank" rel="noopener">${escapeHtml(skillData.repo_name || skillData.repo_url)}</a></p>` : ''}
            ${skillData.repo_owner ? `<p>Author: ${escapeHtml(skillData.repo_owner)}</p>` : ''}
          </div>
        </div>
      </section>
    `;

    container.innerHTML = html;
  } catch (err) {
    showError(container, err.message);
  }
}

// ─── Skills ────────────────────────────────────────────────

export async function renderSkills(params) {
  const container = $('#pageContent');
  showLoader(container, t('common.loading') === 'LOADING...' ? 'LOADING SKILLS...' : t('common.loading'));

  try {
    // Fetch skills from API
    const category = params?.cat || '';
    const url = '/api/skills?limit=200' + (category ? '&category=' + encodeURIComponent(category) : '');
    const data = await fetch(url).then(r => r.json());
    const skills = data.skills || [];
    const stats = data.stats || {};

    const allCategories = data.categories || [
      'Frontend', 'Backend', 'AI & Machine Learning', 'Automation', 'Architecture',
      'Testing', 'Security', 'DevOps', 'Data', 'API', 'CLI Tools', 'Documentation',
      'Performance', 'Code Quality', 'Mobile', 'Cloud', 'Database', 'Design Systems',
      'Content', 'Research', 'Media', 'Finance', 'Browser', 'Full Stack',
    ];

    const html = `
      <section class="page-section">
        <div class="page-header">
          <h2 class="page-title">${t('skills.title')}</h2>
          <p class="page-description">${t('skills.subtitle')}</p>
          <div class="skills-toolbar">
            <input type="text" class="search-input" id="skillsSearch" placeholder="${escapeAttr(t('skills.search_ph'))}" autocomplete="off">
            <div class="skills-sort">
              <select class="sort-select" id="skillsSort">
                <option value="installs">Weekly Installs</option>
                <option value="stars">GitHub Stars</option>
                <option value="name">Name</option>
                <option value="category">Category</option>
              </select>
            </div>
          </div>
        </div>
        <div class="skills-categories">
          <a href="/skills" class="skill-category-chip ${category === '' ? 'active' : ''}">${t('skills.all')}</a>
          ${allCategories.map(cat => `
            <a href="/skills?cat=${encodeURIComponent(cat)}" class="skill-category-chip ${category === cat ? 'active' : ''}">${escapeHtml(cat)}</a>
          `).join('')}
        </div>
        <div class="skills-grid">
          ${skills.map(skill => `
            <a href="/skills/${escapeAttr(skill.id)}" class="skill-card">
              <div class="skill-card-header">
                <span class="skill-card-name">${escapeHtml(skill.name)}</span>
                <span class="skill-card-category">${escapeHtml(skill.category)}</span>
              </div>
              <p class="skill-card-desc">${escapeHtml(skill.description || '').slice(0, 120)}</p>
              <div class="skill-card-footer">
                <span class="skill-card-stars">★ ${skill.stars?.toLocaleString() || 0}</span>
                <span class="skill-card-installs">📦 ${skill.installs || '0'}</span>
                <span class="skill-card-author">${escapeHtml(skill.author || '')}</span>
              </div>
              <div class="skill-card-tags">
                ${(skill.tags || []).slice(0, 3).map(t => `<span class="skill-tag-mini">${escapeHtml(t)}</span>`).join('')}
              </div>
            </a>
          `).join('')}
          ${skills.length === 0 ? `<p class="empty-state">${t('common.empty')}</p>` : ''}
        </div>
      </section>
    `;

    container.innerHTML = html;

    // Wire search
    const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('skillsSearch'));
    document.getElementById('skillsSort');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        if (q.length > 1) {
          window.location.href = '/skills?search=' + encodeURIComponent(q);
        }
      });
    }
  } catch (err) {
    showError(container, err.message);
  }
}
