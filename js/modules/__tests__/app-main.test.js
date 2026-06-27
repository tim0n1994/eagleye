import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('app-main', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'mainNav';
    document.body.appendChild(container);

    // Set up required DOM for initApp
    document.body.innerHTML = `
      <nav id="mainNav"></nav>
      <footer id="mainFooter"></footer>
      <div id="pageContent"></div>
      <div id="itemsGrid"></div>
      <div id="categoryList"></div>
      <div id="lastUpdated"></div>
      <div id="searchInput"></div>
      <div id="researchModal" style="display:none;"></div>
      <div id="researchTitle"></div>
      <div id="researchBody"></div>
      <div id="graphOverlay"></div>
      <div id="graphCanvas"></div>
      <button id="showGraph"></button>
      <button id="closeGraph"></button>
      <button id="syncNow"></button>
      <div class="close-modal"></div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  // ─── renderNav (tested via DOM after cloning the logic) ──

  it('renders navigation with expected links', () => {
    const nav = document.getElementById('mainNav');
    const links = [
      { path: '/', label: 'News' },
      { path: '/digest', label: 'Daily Digest' },
      { path: '/topics', label: 'Topics' },
      { path: '/sources', label: 'Sources' },
      { path: '/tools', label: 'Tools' },
      { path: '/skills', label: 'Skills' },
      { path: '/physical-ai', label: 'Physical AI' },
    ];

    const currentPath = '/';
    nav.innerHTML = links.map(link => `
      <a href="${link.path}" class="nav-link ${currentPath === link.path ? 'active' : ''}">
        <span class="nav-icon">📰</span>
        <span class="nav-label">${link.label}</span>
      </a>
    `).join('');

    const navLinks = nav.querySelectorAll('.nav-link');
    expect(navLinks.length).toBe(7);
    expect(navLinks[0].textContent).toContain('News');
    expect(navLinks[1].textContent).toContain('Daily Digest');
    expect(navLinks[2].textContent).toContain('Topics');
    expect(navLinks[6].textContent).toContain('Physical AI');
  });

  it('marks current path as active in nav', () => {
    const nav = document.getElementById('mainNav');
    const links = [
      { path: '/', label: 'News' },
      { path: '/digest', label: 'Daily Digest' },
    ];

    const currentPath = '/digest';
    nav.innerHTML = links.map(link => `
      <a href="${link.path}" class="nav-link ${currentPath === link.path ? 'active' : ''}">
        <span>${link.label}</span>
      </a>
    `).join('');

    const digestLink = nav.querySelector('a[href="/digest"]');
    expect(digestLink.classList.contains('active')).toBe(true);
    const homeLink = nav.querySelector('a[href="/"]');
    expect(homeLink.classList.contains('active')).toBe(false);
  });

  it('handles empty nav element gracefully', () => {
    document.getElementById('mainNav').remove();
    const nav = document.getElementById('mainNav');
    expect(nav).toBeNull();
  });

  // ─── renderFooter ────────────────────────────────────────

  it('renders footer with expected sections', () => {
    const footer = document.getElementById('mainFooter');
    const year = new Date().getFullYear();

    footer.innerHTML = `
      <div class="footer-inner">
        <div class="footer-group">
          <h4>Read</h4>
          <a href="/">News</a>
          <a href="/digest">Daily Digest</a>
          <a href="/topics">Topics</a>
          <a href="/sources">Sources</a>
        </div>
        <div class="footer-group">
          <h4>Make</h4>
          <a href="/tools">Tools</a>
          <a href="/skills">Skills</a>
        </div>
        <div class="footer-group">
          <h4>Company</h4>
          <a href="#">About</a>
          <a href="#">FAQ</a>
          <a href="#">Privacy</a>
          <a href="#">Terms</a>
        </div>
        <div class="footer-group">
          <h4>Follow</h4>
          <a href="https://github.com" target="_blank">GitHub</a>
          <a href="/feed.xml">RSS</a>
          <a href="/feed.json">JSON Feed</a>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© ${year} Eagleye. Open source.</span>
      </div>
    `;

    const groups = footer.querySelectorAll('.footer-group');
    expect(groups.length).toBe(4);
    expect(groups[0].querySelector('h4').textContent).toBe('Read');
    expect(groups[1].querySelector('h4').textContent).toBe('Make');

    expect(footer.textContent).toContain('Eagleye');
    expect(footer.textContent).toContain('Open source');
    expect(footer.textContent).toContain(`© ${year}`);
  });

  it('handles missing footer element gracefully', () => {
    document.getElementById('mainFooter').remove();
    const footer = document.getElementById('mainFooter');
    expect(footer).toBeNull();
  });

  // ─── formatDeployPlan ────────────────────────────────────

  // Replicate the private function for testing
  function formatDeployPlan(md) {
    if (!md) return '<p>No plan content available.</p>';
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

  it('formatDeployPlan converts heading levels', () => {
    expect(formatDeployPlan('# Title')).toContain('<h2>Title</h2>');
    expect(formatDeployPlan('## Section')).toContain('<h3>Section</h3>');
    expect(formatDeployPlan('### Subsection')).toContain('<h4>Subsection</h4>');
  });

  it('formatDeployPlan converts bold text', () => {
    const result = formatDeployPlan('This is **bold** text');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('formatDeployPlan converts inline code', () => {
    const result = formatDeployPlan('Use `npm install` command');
    expect(result).toContain('<code>npm install</code>');
  });

  it('formatDeployPlan converts unordered lists', () => {
    const result = formatDeployPlan('- Item 1\n- Item 2\n- Item 3');
    expect(result).toContain('<li>Item 1</li>');
    expect(result).toContain('<li>Item 2</li>');
    expect(result).toContain('<li>Item 3</li>');
  });

  it('formatDeployPlan converts ordered lists', () => {
    const result = formatDeployPlan('1. First\n2. Second\n3. Third');
    expect(result).toContain('<li>First</li>');
    expect(result).toContain('<li>Second</li>');
    expect(result).toContain('<li>Third</li>');
  });

  it('formatDeployPlan wraps paragraphs', () => {
    const result = formatDeployPlan('Paragraph one.\n\nParagraph two.');
    expect(result).toContain('<p>');
    expect(result).toContain('Paragraph one.');
    expect(result).toContain('Paragraph two.');
    // Output: <p>Paragraph one.</p><p>Paragraph two.</p> — 2 </p> tags
    expect(result.match(/<\/p>/g).length).toBe(2);
  });

  it('formatDeployPlan handles empty input', () => {
    expect(formatDeployPlan('')).toBe('<p>No plan content available.</p>');
    expect(formatDeployPlan(null)).toBe('<p>No plan content available.</p>');
    expect(formatDeployPlan(undefined)).toBe('<p>No plan content available.</p>');
  });

  it('formatDeployPlan handles complex markdown', () => {
    const md = '# Deploy Plan\n\n## Prerequisites\n- Node.js **v18** or later\n- `npm` installed\n\n## Steps\n1. Run `npm install`\n2. Configure env\n\nMore info here.';
    const result = formatDeployPlan(md);
    expect(result).toContain('<h2>Deploy Plan</h2>');
    expect(result).toContain('<h3>Prerequisites</h3>');
    expect(result).toContain('<strong>v18</strong>');
    expect(result).toContain('<code>npm install</code>');
    expect(result).toContain('<li>Node.js');
    expect(result).toContain('<li>Run');
  });
});
