/**
 * Eagleye — misc page module
 *
 * Help/FAQ, login and register.
 * Split out of pages.js; render functions are unchanged.
 */

import { $, escapeHtml } from '../utils.js';
import { getLanguage } from '../i18n.js';
import { API } from '../api.js';


// ─── Help / FAQ / Keyboard Shortcuts ────────────────────

export async function renderHelp(_params) {
  const container = $('#pageContent');
  const shortcuts = [
    { key: '/', desc: getLanguage() === 'zh' ? '聚焦搜索' : 'Focus search' },
    { key: 'g f', desc: getLanguage() === 'zh' ? '为你 (For You)' : 'For You' },
    { key: 'g n', desc: getLanguage() === 'zh' ? '新闻' : 'News' },
    { key: 'g p', desc: getLanguage() === 'zh' ? '论文' : 'Papers' },
    { key: 'g s', desc: getLanguage() === 'zh' ? '信号' : 'Signals' },
    { key: 'g d', desc: getLanguage() === 'zh' ? '每日简报' : 'Digest' },
    { key: 'g o', desc: getLanguage() === 'zh' ? '信息源' : 'Sources' },
    { key: 'g t', desc: getLanguage() === 'zh' ? '工具' : 'Tools' },
    { key: 'g w', desc: getLanguage() === 'zh' ? '关注列表' : 'Watchlist' },
    { key: 'g y', desc: getLanguage() === 'zh' ? '年度归档' : 'By Year' },
    { key: 'g c', desc: getLanguage() === 'zh' ? '对比' : 'Compare' },
    { key: 'g i', desc: getLanguage() === 'zh' ? '情报' : 'Intelligence' },
  ];
  const faqs = getLanguage() === 'zh' ? [
    { q: 'Eagleye 是什么？', a: '一个面向 AI、开发者、创业者的个人信息过滤引擎。从 19 个信息源抓取，用 LLM 生成中文知识卡片，多维 alpha 评分，跨源故事聚合，个性化过滤。' },
    { q: '如何个性化我的信息流？', a: '收藏条目（🔖）、订阅实体（🔔 在轨迹页）、设置信号类型权重（/lens）。系统会从你的行为派生兴趣画像，For-You 页面据此重排。' },
    { q: 'alpha 分数是什么？', a: '多维信号评分：0.25×论题匹配 + 0.20×新颖度 + 0.15×可行动性 + 0.15×跨源 + 0.10×源质量 + 0.10×速度。≥0.85 是顶层 standout。' },
    { q: '数据存在哪里？', a: '全部在本地 SQLite（eagleye.db）。不上传你的阅读/收藏行为到任何服务器。LLM 调用走你配置的端点。' },
    { q: '如何自动同步？', a: '在 设置 → 定时调度 开启，每天定时跑 FULL_PIPELINE（抓取→富集→评分→图谱→简报）。' },
    { q: '如何搜索？', a: '按 / 键或访问 /search。FTS5 全文搜索覆盖标题+摘要，中英文都支持。' },
  ] : [
    { q: 'What is Eagleye?', a: 'A personal information filtering engine for AI, developers, and founders. It scrapes 19 sources, generates Chinese knowledge cards via LLM, multi-dimensional alpha scoring, cross-source story clustering, and personalization.' },
    { q: 'How do I personalize my feed?', a: 'Save items (🔖), subscribe to entities (🔔 on trajectory pages), set signal-type weights (/lens). The system derives an interest profile from your behavior and re-ranks For-You accordingly.' },
    { q: 'What is the alpha score?', a: 'A multi-dimensional signal score: 0.25×thesis + 0.20×novelty + 0.15×actionability + 0.15×cross-source + 0.10×source-quality + 0.10×velocity. ≥0.85 is a top-tier standout.' },
    { q: 'Where is data stored?', a: 'Everything is local SQLite (eagleye.db). Your reading/saving behavior never leaves your machine. LLM calls go to your configured endpoint.' },
    { q: 'How do I auto-sync?', a: 'Enable it in Settings → Scheduler to run FULL_PIPELINE daily (fetch→enrich→score→graph→digest).' },
    { q: 'How do I search?', a: 'Press / or visit /search. FTS5 full-text search covers titles+summaries in both English and Chinese.' },
    { q: 'What is the Discover page?', a: '/discover lets you browse all tracked entities by type (company, model, repo, etc.) and sort by acceleration, growth, burst, or z-score.' },
    { q: 'How do entity trends work?', a: 'Visit /trajectory/:slug for any entity to see a 30-day mention sparkline with burst-day highlighting. Use /compare-entities to overlay multiple entities.' },
    { q: 'Can I export data?', a: 'Yes: Digest → Markdown export, Papers → BibTeX, Trajectory → CSV, Signals → JSON, Saved → JSON. Also /email/digest for an email-ready HTML template.' },
  ];

  container.innerHTML =
    `<section class="page-section">` +
    `<div class="page-header"><h2 class="page-title">${getLanguage() === 'zh' ? '帮助' : 'Help'}</h2>` +
    `<p class="page-description">${getLanguage() === 'zh' ? '键盘快捷键、常见问题、使用指南' : 'Keyboard shortcuts, FAQ, and usage guide'}</p></div>` +
    `<div class="metrics-block"><h3 class="metrics-block-title">${getLanguage() === 'zh' ? '键盘快捷键' : 'Keyboard Shortcuts'}</h3>` +
    `<table class="metrics-table"><tbody>` +
    shortcuts.map(s => `<tr><td class="compare-feature"><kbd class="kbd">${escapeHtml(s.key)}</kbd></td><td>${escapeHtml(s.desc)}</td></tr>`).join('') +
    `</tbody></table></div>` +
    `<div class="metrics-block"><h3 class="metrics-block-title">FAQ</h3>` +
    faqs.map(f => `<details class="faq-item"><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a)}</p></details>`).join('') +
    `</div></section>`;
}

// ─── Auth Pages ───────────────────────────────────────────────────────────

export async function renderLogin(_params) {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';

  container.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">🦅</div>
        <h2 class="auth-title">Eagleye</h2>
        <p class="auth-subtitle">${zh ? '登录到你的账户' : 'Sign in to your account'}</p>
        <form id="loginForm" class="auth-form">
          <input type="email" id="loginEmail" class="auth-input" placeholder="${zh ? '邮箱' : 'Email'}" required autocomplete="email" />
          <input type="password" id="loginPassword" class="auth-input" placeholder="${zh ? '密码' : 'Password'}" required autocomplete="current-password" />
          <button type="submit" class="auth-btn">${zh ? '登录' : 'Sign In'}</button>
        </form>
        <p class="auth-switch">${zh ? '没有账户？' : 'No account?'} <a href="/register" class="auth-link">${zh ? '注册' : 'Register'}</a></p>
        <div id="authError" class="auth-error"></div>
      </div>
    </div>
  `;

  const form = $('#loginForm');
  const errEl = $('#authError');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    try {
      await API.login(email, password);
      window.location.href = '/';
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

export async function renderRegister(_params) {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';

  container.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">🦅</div>
        <h2 class="auth-title">Eagleye</h2>
        <p class="auth-subtitle">${zh ? '创建新账户' : 'Create a new account'}</p>
        <form id="registerForm" class="auth-form">
          <input type="email" id="regEmail" class="auth-input" placeholder="${zh ? '邮箱' : 'Email'}" required autocomplete="email" />
          <input type="password" id="regPassword" class="auth-input" placeholder="${zh ? '密码（至少6位）' : 'Password (min 6 chars)'}" required autocomplete="new-password" />
          <button type="submit" class="auth-btn">${zh ? '注册' : 'Register'}</button>
        </form>
        <div id="verifySection" style="display:none">
          <p class="auth-info">${zh ? '验证码已发送到你的邮箱，请输入收到的 6 位验证码：' : 'A verification code has been sent to your email. Enter the 6-digit code:'}</p>
          <form id="verifyForm" class="auth-form">
            <input type="text" id="verifyCode" class="auth-input" placeholder="${zh ? '6 位验证码' : '6-digit code'}" maxlength="6" pattern="[0-9]{6}" required />
            <button type="submit" class="auth-btn">${zh ? '验证' : 'Verify'}</button>
          </form>
        </div>
        <p class="auth-switch">${zh ? '已有账户？' : 'Already have an account?'} <a href="/login" class="auth-link">${zh ? '登录' : 'Sign In'}</a></p>
        <div id="authError" class="auth-error"></div>
      </div>
    </div>
  `;

  const errEl = $('#authError');

  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const email = $('#regEmail').value.trim();
    const password = $('#regPassword').value;
    try {
      const res = await API.register(email, password);
      // Show verification section
      $('#registerForm').style.display = 'none';
      $('#verifySection').style.display = 'block';
      $('#verifyCode').focus();
      window.__regEmail = email;
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  $('#verifyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const code = $('#verifyCode').value.trim();
    try {
      await API.verify(window.__regEmail, code);
      window.location.href = '/';
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}
