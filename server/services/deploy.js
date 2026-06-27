/**
 * Eagleye — Deploy Service (§10)
 *
 * One-click deploy analysis and deployment plan generation.
 *
 * - §10.1: Eligibility detection (stars >= 5000, deployable repo)
 * - §10.2: Tech stack detection from README, package files, Docker
 * - §10.3: Deployment plan generation prompt
 * - Detection: Node, Python, Go, Rust, Docker, static site, etc.
 */

const { getProvider } = require('./llm-provider');
const { getDB } = require('../db/connection');
const { fetchURL, generateId } = require('./utils');

// ─── Deploy Eligibility Detection (§10.1) ───────────────────────────────

/**
 * Determine deploy eligibility for a GitHub repo.
 * @param {Object} payload - source_payload from information_items
 * @returns {{ eligibility: string, reason: string, detected_stack: Object }}
 */
function detectEligibility(payload) {
  const stars = payload.stars || 0;
  const hasDockerfile = payload.has_dockerfile || false;
  const hasPackageJson = payload.has_package_json || false;
  const hasRequirements = payload.has_requirements || false;
  const hasPyproject = payload.has_pyproject || false;
  const hasDockerCompose = payload.has_docker_compose || false;

  // Detect tech stack
  const stack = detectStack(payload);

  // Eligibility rules
  if (stars >= 5000 && (hasDockerfile || stack.deployable === true)) {
    return { eligibility: 'deployable', reason: 'High stars + deployable entry', detected_stack: stack };
  }

  // Featured GitHub Trending project with deployable entry
  if (hasPackageJson || hasDockerfile || hasDockerCompose || hasRequirements || hasPyproject) {
    if (stars >= 1000) {
      return { eligibility: 'maybe', reason: 'Has deployable config but may need manual setup', detected_stack: stack };
    }
    return { eligibility: 'maybe', reason: 'Detected potential deployment files, but stars below 1000', detected_stack: stack };
  }

  if (stars >= 5000) {
    return { eligibility: 'maybe', reason: 'High stars but no deployable config detected', detected_stack: stack };
  }

  return { eligibility: 'no', reason: 'Stars below threshold and no deployable config', detected_stack: stack };
}

// ─── Tech Stack Detection (§10.2) ──────────────────────────────────────

/**
 * Detect tech stack from payload indicators.
 */
function detectStack(payload) {
  const language = (payload.language || '').toLowerCase();
  const stack = {
    type: 'unknown',
    frameworks: [],
    package_manager: null,
    deployable: false,
    suggested_platforms: [],
  };

  if (payload.has_package_json) {
    stack.type = 'node';
    stack.package_manager = 'npm';
    stack.frameworks.push('Node.js');
    stack.deployable = true;
    stack.suggested_platforms = ['Vercel', 'Railway', 'Fly.io', 'Render'];
  }

  if (payload.has_dockerfile) {
    stack.deployable = true;
    stack.suggested_platforms = [...stack.suggested_platforms, 'Railway', 'Fly.io', 'Render', 'AWS ECS'];
  }

  if (payload.has_docker_compose) {
    stack.deployable = true;
    stack.suggested_platforms = [...stack.suggested_platforms, 'Railway', 'Fly.io'];
  }

  if (payload.has_requirements || payload.has_pyproject) {
    stack.type = stack.type === 'unknown' ? 'python' : stack.type;
    stack.package_manager = payload.has_pyproject ? 'poetry/pip' : 'pip';
    if (!stack.frameworks.includes('Python')) stack.frameworks.push('Python');
    stack.deployable = true;
    stack.suggested_platforms = [...stack.suggested_platforms, 'Railway', 'Fly.io', 'Render'];
  }

  if (payload.has_go_mod) {
    stack.type = stack.type === 'unknown' ? 'go' : stack.type;
    stack.frameworks.push('Go');
    stack.deployable = true;
    stack.suggested_platforms = [...stack.suggested_platforms, 'Fly.io', 'Render', 'Railway'];
  }

  if (payload.has_cargo) {
    stack.type = stack.type === 'unknown' ? 'rust' : stack.type;
    stack.frameworks.push('Rust');
    stack.deployable = true;
    stack.suggested_platforms = [...stack.suggested_platforms, 'Railway', 'Fly.io', 'Shuttle'];
  }

  if (language === 'typescript' || language === 'javascript') {
    if (stack.type === 'unknown') {
      stack.type = 'node';
      stack.package_manager = 'npm';
      stack.frameworks.push('Node.js/JS');
      stack.deployable = true;
      stack.suggested_platforms = ['Vercel', 'Netlify', 'Railway'];
    }
  }

  if (language === 'python' && stack.type === 'unknown') {
    stack.type = 'python';
    stack.package_manager = 'pip';
    stack.frameworks.push('Python');
    stack.deployable = false;
    stack.suggested_platforms = ['Railway', 'Render'];
  }

  if (language === 'go') {
    stack.type = 'go';
    stack.frameworks.push('Go');
    stack.deployable = true;
    stack.suggested_platforms = ['Fly.io', 'Render'];
  }

  if (language === 'rust') {
    stack.type = 'rust';
    stack.frameworks.push('Rust');
    stack.deployable = true;
    stack.suggested_platforms = ['Railway', 'Shuttle'];
  }

  if (language === 'java' || language === 'kotlin') {
    stack.type = 'jvm';
    stack.frameworks.push(language === 'java' ? 'Java' : 'Kotlin');
    stack.deployable = true;
    stack.suggested_platforms = ['Railway', 'Fly.io'];
  }

  return stack;
}

// ─── Deploy Plan Prompt (§10.3) ─────────────────────────────────────────

const DEPLOY_PROMPT = `你是 Eagleye 的部署工程师。请为下面的 GitHub 项目生成一个可执行、保守、安全的部署计划。

Repo：
- URL：{{repo_url}}
- stars：{{stars}}
- forks：{{forks}}
- language：{{language}}
- description：{{repo_description}}
- license：{{license}}
- README 摘要：{{readme_excerpt}}
- 检测到的文件：{{detected_files}}
- package/config 摘要：{{package_summaries}}

目标：
1. 判断它是否真的适合一键部署。
2. 识别技术栈和运行方式。
3. 给出本地运行命令。
4. 给出 Docker 部署方案；如果项目已有 Dockerfile，优先使用；没有则说明如何补。
5. 给出 Vercel/Render/Fly.io/Railway 中最合适的平台建议。
6. 列出必要环境变量。
7. 列出安全风险和资源成本风险。
8. 不要执行危险命令，不要要求用户粘贴密钥。

输出 Markdown：
# 部署可行性
## 结论
## 技术栈判断
## 本地运行
## Docker 方案
## 云平台部署
## 环境变量
## 风险
## 下一步`;

// ─── Plan Generation ───────────────────────────────────────────────────

/**
 * Generate a deployment plan for a GitHub repo item.
 * @param {string} itemId - The information_items id
 * @returns {Promise<Object>}
 */
async function generateDeployPlan(itemId) {
  const db = getDB();
  if (!db) return { error: 'Database not available' };

  const provider = getProvider();
  if (!provider) return { error: 'No LLM provider configured' };

  const item = db.prepare(`
    SELECT i.*, s.label as source_label
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    WHERE i.id = ?
  `).get(itemId);

  if (!item) return { error: 'Item not found' };

  let payload = {};
  try { payload = JSON.parse(item.source_payload || '{}'); } catch { /* ignore */ }

  const repoUrl = item.canonical_url || payload.url || '';
  const stars = payload.stars || 0;
  const forks = payload.forks || 0;
  const language = payload.language || '';
  const description = payload.description || item.title || '';
  const license = payload.license || '';

  // Check eligibility
  const eligibility = detectEligibility(payload);

  // Build detected files and package summaries
  const detectedFiles = [];
  const packageSummaries = [];

  if (payload.has_package_json) {
    detectedFiles.push('package.json');
    packageSummaries.push('Node.js project with package.json');
  }
  if (payload.has_dockerfile) {
    detectedFiles.push('Dockerfile');
    packageSummaries.push('Has Dockerfile for containerization');
  }
  if (payload.has_docker_compose) {
    detectedFiles.push('docker-compose.yml');
    packageSummaries.push('Has docker-compose.yml for multi-service setup');
  }
  if (payload.has_requirements) {
    detectedFiles.push('requirements.txt');
    packageSummaries.push('Python project with requirements.txt');
  }
  if (payload.has_pyproject) {
    detectedFiles.push('pyproject.toml');
    packageSummaries.push('Python project with pyproject.toml');
  }
  if (payload.has_makefile) {
    detectedFiles.push('Makefile');
  }
  if (payload.has_go_mod) {
    detectedFiles.push('go.mod');
    packageSummaries.push('Go module');
  }
  if (payload.has_cargo) {
    detectedFiles.push('Cargo.toml');
    packageSummaries.push('Rust project with Cargo.toml');
  }

  // Fetch README for excerpt
  let readmeExcerpt = payload.readme_excerpt || '';
  if (!readmeExcerpt && repoUrl) {
    try {
      const readmeUrl = repoUrl.replace('github.com', 'raw.githubusercontent.com') + '/main/README.md';
      const readmeContent = await fetchURL(readmeUrl);
      readmeExcerpt = (readmeContent || '').slice(0, 2000);      } catch {
        // Try master branch
      try {
        const readmeUrl = repoUrl.replace('github.com', 'raw.githubusercontent.com') + '/master/README.md';
        const readmeContent = await fetchURL(readmeUrl);
        readmeExcerpt = (readmeContent || '').slice(0, 2000);
      } catch { /* no readme */ }
    }
  }

  const prompt = DEPLOY_PROMPT
    .replace('{{repo_url}}', repoUrl)
    .replace('{{stars}}', String(stars))
    .replace('{{forks}}', String(forks))
    .replace('{{language}}', language || 'Unknown')
    .replace('{{repo_description}}', (description || '').slice(0, 500))
    .replace('{{license}}', license || 'Unknown')
    .replace('{{readme_excerpt}}', (readmeExcerpt || 'README not available').slice(0, 2000))
    .replace('{{detected_files}}', detectedFiles.length > 0 ? detectedFiles.join(', ') : 'None detected')
    .replace('{{package_summaries}}', packageSummaries.length > 0 ? packageSummaries.join('; ') : 'None detected');

  // Create plan record
  const planId = generateId();
  db.prepare(`
    INSERT INTO deployment_plans (id, item_id, repo_url, repo_stars, status, eligibility, prompt, detected_stack)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
  `).run(planId, itemId, repoUrl, stars, eligibility.eligibility, prompt,
    JSON.stringify(eligibility.detected_stack));

  try {
    const text = await provider.call(prompt, { temperature: 0.3, maxTokens: 4096 });
    if (!text) throw new Error('LLM returned empty response');

    db.prepare(`
      UPDATE deployment_plans
      SET status = 'completed', plan_markdown = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(text, planId);

    return { id: planId, eligibility, plan: text };
  } catch (err) {
    db.prepare(`
      UPDATE deployment_plans SET status = 'failed', error = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(err.message, planId);

    return { id: planId, eligibility, error: err.message };
  }
}

/**
 * Check if a deploy plan exists and get quick eligibility.
 * Used for fast UI display (no LLM call).
 */
function checkDeployEligibility(itemId) {
  const db = getDB();
  if (!db) return null;

  const item = db.prepare(`
    SELECT i.*, s.label as source_label
    FROM information_items i
    JOIN sources s ON i.source_id = s.id
    WHERE i.id = ?
  `).get(itemId);

  if (!item) return null;

  let payload = {};
  try { payload = JSON.parse(item.source_payload || '{}'); } catch { /* ignore */ }

  // Check for existing plan
  const existing = db.prepare('SELECT * FROM deployment_plans WHERE item_id = ? ORDER BY created_at DESC LIMIT 1').get(itemId);
  if (existing) {
    let stack = {};
    try { stack = JSON.parse(existing.detected_stack || '{}'); } catch { /* ignore */ }
    return {
      has_plan: true,
      plan_id: existing.id,
      eligibility: existing.eligibility,
      status: existing.status,
      stack,
    };
  }

  const eligibility = detectEligibility(payload);
  return {
    has_plan: false,
    ...eligibility,
  };
}

module.exports = {
  generateDeployPlan,
  checkDeployEligibility,
};
