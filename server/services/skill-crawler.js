/**
 * Eagleye — Skill Crawler Service
 *
 * Fetches and catalogs Claude Code Skills from:
 * - GitHub repos with SKILL.md or skill manifest
 * - Awesome lists
 * - User-configured registries
 *
 * Returns normalized skill records with metadata, categories, tags.
 *
 * Data is persisted in the `skills` database table (migration 004).
 * On first access, built-in skills are auto-seeded into the DB.
 * Falls back to in-memory data if the DB is not available.
 */

const { getDB } = require('../db/connection');
// ─── Skill Data Structure ──────────────────────────────────────────────

/**
 * @typedef {Object} Skill
 * @property {string} id
 * @property {string} name - Skill name
 * @property {string} slug - URL-friendly identifier
 * @property {string} description - Short description
 * @property {string} category - Primary category (e.g. "Frontend", "AI")
 * @property {string[]} tags - Classification tags
 * @property {string} repo_url - GitHub repository URL
 * @property {string} repo_owner - Repository owner
 * @property {string} repo_name - Repository name
 * @property {number} stars - GitHub stars
 * @property {number} forks - GitHub forks
 * @property {string} author - Skill author
 * @property {string} install_command - Installation command
 * @property {string} installs - Weekly installs count (string for display)
 * @property {string} last_updated - Last commit date
 * @property {string} source - Data source (github, awesome-list, registry)
 */

// ─── Module State ─────────────────────────────────────────────────────

let seeded = false;

// ─── Helpers ───────────────────────────────────────────────────────────

/** Convert a skill name to a URL-safe slug. */
function nameToSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/** Parse tags JSON column, falling back to empty array. */
function parseTags(raw) {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

function parseInstallCount(value) {
  const raw = String(value || '0').toLowerCase().trim();
  const match = raw.match(/([\d.]+)/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num)) return 0;
  if (raw.includes('m')) return Math.round(num * 1000000);
  if (raw.includes('k')) return Math.round(num * 1000);
  return Math.round(num);
}

function formatInstallCount(value) {
  const n = typeof value === 'number' ? value : parseInstallCount(value);
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M/wk`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K/wk`;
  return `${n}/wk`;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function normalizeSkillRow(skill, rank = null) {
  const tags = Array.isArray(skill.tags) ? skill.tags : parseTags(skill.tags);
  const installs_num = parseInstallCount(skill.installs);
  return {
    ...skill,
    tags,
    installs_num,
    installs_display: formatInstallCount(installs_num),
    rank,
  };
}

// ─── Database Seeding ─────────────────────────────────────────────────

function ensureSeed() {
  if (seeded) return;
  const db = getDB();
  if (!db) return;
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM skills').get();
    if (!row || row.c === 0) {
      seedSkills(db);
    }
    seeded = true;
  } catch (e) {
    // skills table doesn't exist yet — migration hasn't run
    console.warn('  ⚠  skills table not available, using in-memory fallback:', e.message);
  }
}

function seedSkills(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO skills
    (id, name, slug, description, category, tags, repo_url, repo_owner, repo_name, stars, forks, author, install_command, installs, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const insertMany = db.transaction((skills) => {
    for (const s of skills) {
      const slug = nameToSlug(s.name);
      const repoUrl = (s.repo_owner && s.repo_name)
        ? `https://github.com/${s.repo_owner}/${s.repo_name}`
        : null;
      insert.run(
        s.id, s.name, slug, s.description, s.category,
        JSON.stringify(s.tags),
        repoUrl,
        s.repo_owner || null, s.repo_name || null,
        s.stars || 0, s.forks || 0,
        s.author || null, s.install_command || null,
        s.installs || '0/week',
        s.source || 'builtin'
      );
    }
  });

  insertMany(getBuiltinSkills());
}

// ─── Built-in Skills (seed data) ──────────────────────────────────────

function getBuiltinSkills() {
  return [
    // Frontend
    { id: 'sk-fe-001', name: 'React Component Generator', description: 'Generates production-ready React components with TypeScript, tests, and Storybook stories', category: 'Frontend', tags: ['react', 'typescript', 'components', 'storybook'], repo_owner: 'example', repo_name: 'react-component-gen', stars: 12400, forks: 890, author: 'sarah_dev', install_command: 'claude add react-component-gen', installs: '12.4k/week', source: 'builtin' },
    { id: 'sk-fe-002', name: 'Tailwind CSS Expert', description: 'Expert-level Tailwind CSS class selection, responsive design, and custom config generation', category: 'Frontend', tags: ['tailwind', 'css', 'responsive', 'design'], repo_owner: 'example', repo_name: 'tailwind-expert', stars: 8700, forks: 560, author: 'design_coder', install_command: 'claude add tailwind-expert', installs: '8.7k/week', source: 'builtin' },
    { id: 'sk-fe-003', name: 'Next.js App Router Guide', description: 'Guides through Next.js 13+ App Router patterns, server components, and data fetching', category: 'Frontend', tags: ['nextjs', 'react', 'server-components', 'app-router'], repo_owner: 'example', repo_name: 'nextjs-app-guide', stars: 15300, forks: 1200, author: 'next_expert', install_command: 'claude add nextjs-app-guide', installs: '15.3k/week', source: 'builtin' },
    { id: 'sk-fe-004', name: 'CSS Animations Pro', description: 'Creates smooth CSS animations, transitions, and keyframe sequences with performance optimization', category: 'Frontend', tags: ['css', 'animations', 'performance', 'keyframes'], repo_owner: 'example', repo_name: 'css-animations', stars: 5600, forks: 340, author: 'anim_master', install_command: 'claude add css-animations', installs: '5.6k/week', source: 'builtin' },
    { id: 'sk-fe-005', name: 'Accessibility Auditor', description: 'Audits web components for WCAG 2.2 compliance and suggests fixes', category: 'Frontend', tags: ['a11y', 'wcag', 'accessibility', 'compliance'], repo_owner: 'example', repo_name: 'a11y-auditor', stars: 4200, forks: 280, author: 'a11y_advocate', install_command: 'claude add a11y-auditor', installs: '4.2k/week', source: 'builtin' },

    // Backend
    { id: 'sk-be-001', name: 'Node.js API Builder', description: 'Builds RESTful and GraphQL APIs with Express, Fastify, or Hono following best practices', category: 'Backend', tags: ['nodejs', 'api', 'rest', 'graphql', 'express'], repo_owner: 'example', repo_name: 'node-api-builder', stars: 18900, forks: 2100, author: 'api_master', install_command: 'claude add node-api-builder', installs: '18.9k/week', source: 'builtin' },
    { id: 'sk-be-002', name: 'Go Service Generator', description: 'Scaffolds Go microservices with proper project layout, middleware, and testing', category: 'Backend', tags: ['go', 'microservices', 'scaffold', 'testing'], repo_owner: 'example', repo_name: 'go-service-gen', stars: 7200, forks: 480, author: 'go_gopher', install_command: 'claude add go-service-gen', installs: '7.2k/week', source: 'builtin' },
    { id: 'sk-be-003', name: 'Python FastAPI Starter', description: 'Creates FastAPI applications with SQLAlchemy, Pydantic, and Alembic migrations', category: 'Backend', tags: ['python', 'fastapi', 'sqlalchemy', 'alembic'], repo_owner: 'example', repo_name: 'fastapi-starter', stars: 9800, forks: 760, author: 'pythonista', install_command: 'claude add fastapi-starter', installs: '9.8k/week', source: 'builtin' },
    { id: 'sk-be-004', name: 'Database Schema Designer', description: 'Designs normalized database schemas with migrations, indexes, and query optimization', category: 'Backend', tags: ['database', 'sql', 'schema', 'migrations', 'optimization'], repo_owner: 'example', repo_name: 'db-schema-designer', stars: 6300, forks: 410, author: 'data_architect', install_command: 'claude add db-schema-designer', installs: '6.3k/week', source: 'builtin' },

    // AI & ML
    { id: 'sk-ai-001', name: 'Prompt Engineer Pro', description: 'Designs, tests, and optimizes LLM prompts with systematic evaluation frameworks', category: 'AI & Machine Learning', tags: ['prompts', 'llm', 'evaluation', 'optimization'], repo_owner: 'example', repo_name: 'prompt-engineer', stars: 22100, forks: 3100, author: 'prompt_wizard', install_command: 'claude add prompt-engineer', installs: '22.1k/week', source: 'builtin' },
    { id: 'sk-ai-002', name: 'ML Pipeline Builder', description: 'Builds end-to-end ML pipelines with scikit-learn, PyTorch, or TensorFlow', category: 'AI & Machine Learning', tags: ['ml', 'pytorch', 'tensorflow', 'pipeline', 'scikit-learn'], repo_owner: 'example', repo_name: 'ml-pipeline', stars: 14100, forks: 1800, author: 'ml_engineer', install_command: 'claude add ml-pipeline', installs: '14.1k/week', source: 'builtin' },
    { id: 'sk-ai-003', name: 'RAG System Architect', description: 'Designs retrieval-augmented generation systems with vector databases and embedding pipelines', category: 'AI & Machine Learning', tags: ['rag', 'vector-db', 'embeddings', 'retrieval'], repo_owner: 'example', repo_name: 'rag-architect', stars: 16800, forks: 2200, author: 'rag_expert', install_command: 'claude add rag-architect', installs: '16.8k/week', source: 'builtin' },
    { id: 'sk-ai-004', name: 'Agent Framework Builder', description: 'Creates AI agent systems with tool use, planning, and memory management', category: 'AI & Machine Learning', tags: ['agents', 'tools', 'planning', 'memory'], repo_owner: 'example', repo_name: 'agent-builder', stars: 19200, forks: 2500, author: 'agent_master', install_command: 'claude add agent-builder', installs: '19.2k/week', source: 'builtin' },

    // DevOps
    { id: 'sk-do-001', name: 'Docker Compose Expert', description: 'Generates optimized Docker Compose files for multi-service applications', category: 'DevOps', tags: ['docker', 'compose', 'containers', 'orchestration'], repo_owner: 'example', repo_name: 'docker-compose-pro', stars: 8100, forks: 620, author: 'docker_pro', install_command: 'claude add docker-compose-pro', installs: '8.1k/week', source: 'builtin' },
    { id: 'sk-do-002', name: 'Kubernetes Manifest Generator', description: 'Creates Kubernetes manifests with best practices for security, scaling, and monitoring', category: 'DevOps', tags: ['kubernetes', 'k8s', 'manifests', 'helm'], repo_owner: 'example', repo_name: 'k8s-manifest-gen', stars: 9400, forks: 710, author: 'k8s_admin', install_command: 'claude add k8s-manifest-gen', installs: '9.4k/week', source: 'builtin' },
    { id: 'sk-do-003', name: 'CI/CD Pipeline Designer', description: 'Designs CI/CD pipelines for GitHub Actions, GitLab CI, and Jenkins', category: 'DevOps', tags: ['ci-cd', 'github-actions', 'gitlab', 'jenkins'], repo_owner: 'example', repo_name: 'cicd-designer', stars: 7300, forks: 520, author: 'devops_guru', install_command: 'claude add cicd-designer', installs: '7.3k/week', source: 'builtin' },

    // Security
    { id: 'sk-sec-001', name: 'Security Auditor', description: 'Audits code for OWASP Top 10 vulnerabilities and suggests fixes', category: 'Security', tags: ['owasp', 'security', 'audit', 'vulnerabilities'], repo_owner: 'example', repo_name: 'security-auditor', stars: 11200, forks: 900, author: 'security_expert', install_command: 'claude add security-auditor', installs: '11.2k/week', source: 'builtin' },
    { id: 'sk-sec-002', name: 'Auth Flow Builder', description: 'Implements authentication flows (OAuth2, JWT, SAML, WebAuthn) securely', category: 'Security', tags: ['auth', 'oauth2', 'jwt', 'webauthn', 'saml'], repo_owner: 'example', repo_name: 'auth-flow-builder', stars: 6500, forks: 430, author: 'auth_specialist', install_command: 'claude add auth-flow-builder', installs: '6.5k/week', source: 'builtin' },

    // Testing
    { id: 'sk-tst-001', name: 'Test Suite Generator', description: 'Generates comprehensive test suites with unit, integration, and E2E tests', category: 'Testing', tags: ['testing', 'unit', 'integration', 'e2e', 'jest', 'playwright'], repo_owner: 'example', repo_name: 'test-suite-gen', stars: 10100, forks: 780, author: 'test_engineer', install_command: 'claude add test-suite-gen', installs: '10.1k/week', source: 'builtin' },
    { id: 'sk-tst-002', name: 'Playwright Test Writer', description: 'Writes Playwright E2E tests with page objects, fixtures, and visual regression', category: 'Testing', tags: ['playwright', 'e2e', 'visual-regression', 'page-objects'], repo_owner: 'example', repo_name: 'playwright-tests', stars: 5800, forks: 390, author: 'e2e_master', install_command: 'claude add playwright-tests', installs: '5.8k/week', source: 'builtin' },

    // Data
    { id: 'sk-dt-001', name: 'SQL Query Optimizer', description: 'Optimizes SQL queries with index suggestions, explain plans, and rewrite recommendations', category: 'Data', tags: ['sql', 'optimization', 'indexes', 'queries'], repo_owner: 'example', repo_name: 'sql-optimizer', stars: 4700, forks: 310, author: 'sql_ninja', install_command: 'claude add sql-optimizer', installs: '4.7k/week', source: 'builtin' },
    { id: 'sk-dt-002', name: 'Data Pipeline Builder', description: 'Designs ETL/ELT pipelines with dbt, Airflow, or Spark', category: 'Data', tags: ['etl', 'dbt', 'airflow', 'spark', 'pipeline'], repo_owner: 'example', repo_name: 'data-pipeline', stars: 6900, forks: 470, author: 'data_engineer', install_command: 'claude add data-pipeline', installs: '6.9k/week', source: 'builtin' },

    // API & Integration
    { id: 'sk-api-001', name: 'OpenAPI Spec Generator', description: 'Creates OpenAPI 3.1 specs from code or descriptions with examples and schemas', category: 'API', tags: ['openapi', 'api-spec', 'rest', 'documentation'], repo_owner: 'example', repo_name: 'openapi-gen', stars: 5400, forks: 360, author: 'api_designer', install_command: 'claude add openapi-gen', installs: '5.4k/week', source: 'builtin' },
    { id: 'sk-api-002', name: 'Webhook Handler Builder', description: 'Builds secure webhook handlers with signature verification and retry logic', category: 'API', tags: ['webhooks', 'events', 'security', 'retry'], repo_owner: 'example', repo_name: 'webhook-builder', stars: 3800, forks: 250, author: 'webhook_pro', install_command: 'claude add webhook-builder', installs: '3.8k/week', source: 'builtin' },

    // CLI Tools
    { id: 'sk-cli-001', name: 'CLI App Scaffolder', description: 'Scaffolds CLI applications with argument parsing, colors, and progress bars', category: 'CLI Tools', tags: ['cli', 'scaffold', 'terminal', 'commander'], repo_owner: 'example', repo_name: 'cli-scaffolder', stars: 4400, forks: 290, author: 'cli_master', install_command: 'claude add cli-scaffolder', installs: '4.4k/week', source: 'builtin' },
    { id: 'sk-cli-002', name: 'Bash Script Pro', description: 'Writes production-grade bash scripts with error handling and logging', category: 'CLI Tools', tags: ['bash', 'shell', 'scripts', 'automation'], repo_owner: 'example', repo_name: 'bash-script-pro', stars: 6100, forks: 400, author: 'bash_wizard', install_command: 'claude add bash-script-pro', installs: '6.1k/week', source: 'builtin' },

    // Performance
    { id: 'sk-perf-001', name: 'Performance Profiler', description: 'Profiles web app performance with Lighthouse, Web Vitals, and bundle analysis', category: 'Performance', tags: ['performance', 'lighthouse', 'web-vitals', 'bundle'], repo_owner: 'example', repo_name: 'perf-profiler', stars: 3600, forks: 220, author: 'perf_engineer', install_command: 'claude add perf-profiler', installs: '3.6k/week', source: 'builtin' },

    // Mobile
    { id: 'sk-mob-001', name: 'React Native Starter', description: 'Scaffolds React Native apps with navigation, state management, and theming', category: 'Mobile', tags: ['react-native', 'mobile', 'scaffold', 'navigation'], repo_owner: 'example', repo_name: 'rn-starter', stars: 7800, forks: 540, author: 'rn_dev', install_command: 'claude add rn-starter', installs: '7.8k/week', source: 'builtin' },
    { id: 'sk-mob-002', name: 'Expo Config Expert', description: 'Configures Expo projects with plugins, EAS builds, and app stores', category: 'Mobile', tags: ['expo', 'react-native', 'eas', 'app-store'], repo_owner: 'example', repo_name: 'expo-config', stars: 3200, forks: 190, author: 'expo_master', install_command: 'claude add expo-config', installs: '3.2k/week', source: 'builtin' },

    // Cloud
    { id: 'sk-cld-001', name: 'AWS Infrastructure Builder', description: 'Designs AWS infrastructure with CDK, CloudFormation, or Terraform', category: 'Cloud', tags: ['aws', 'cdk', 'cloudformation', 'terraform', 'infrastructure'], repo_owner: 'example', repo_name: 'aws-infra-builder', stars: 8500, forks: 610, author: 'cloud_architect', install_command: 'claude add aws-infra-builder', installs: '8.5k/week', source: 'builtin' },

    // Architecture
    { id: 'sk-arch-001', name: 'System Design Guide', description: 'Guides through system design interviews and architecture decisions', category: 'Architecture', tags: ['system-design', 'architecture', 'scalability', 'interviews'], repo_owner: 'example', repo_name: 'system-design', stars: 14500, forks: 1900, author: 'arch_master', install_command: 'claude add system-design', installs: '14.5k/week', source: 'builtin' },
    { id: 'sk-arch-002', name: 'Microservices Splitter', description: 'Analyzes monoliths and suggests microservice boundaries with event-driven design', category: 'Architecture', tags: ['microservices', 'monolith', 'events', 'boundaries'], repo_owner: 'example', repo_name: 'microservice-splitter', stars: 5100, forks: 340, author: 'arch_advisor', install_command: 'claude add microservice-splitter', installs: '5.1k/week', source: 'builtin' },

    // Documentation
    { id: 'sk-doc-001', name: 'Technical Writer Pro', description: 'Writes clear technical documentation, API references, and tutorials', category: 'Documentation', tags: ['docs', 'technical-writing', 'api-docs', 'tutorials'], repo_owner: 'example', repo_name: 'tech-writer', stars: 4800, forks: 310, author: 'doc_expert', install_command: 'claude add tech-writer', installs: '4.8k/week', source: 'builtin' },
    { id: 'sk-doc-002', name: 'README Generator', description: 'Generates comprehensive README files with badges, installation, and usage', category: 'Documentation', tags: ['readme', 'badges', 'documentation', 'onboarding'], repo_owner: 'example', repo_name: 'readme-gen', stars: 6700, forks: 450, author: 'readme_master', install_command: 'claude add readme-gen', installs: '6.7k/week', source: 'builtin' },

    // Automation
    { id: 'sk-auto-001', name: 'Workflow Automator', description: 'Automates repetitive tasks with scripts, GitHub Actions, and cron jobs', category: 'Automation', tags: ['automation', 'scripts', 'github-actions', 'cron'], repo_owner: 'example', repo_name: 'workflow-automator', stars: 3900, forks: 260, author: 'auto_master', install_command: 'claude add workflow-automator', installs: '3.9k/week', source: 'builtin' },

    // Database
    { id: 'sk-db-001', name: 'PostgreSQL Expert', description: 'Designs PostgreSQL schemas, queries, indexes, and migration strategies', category: 'Database', tags: ['postgresql', 'sql', 'indexes', 'migrations'], repo_owner: 'example', repo_name: 'postgres-expert', stars: 7600, forks: 510, author: 'pg_master', install_command: 'claude add postgres-expert', installs: '7.6k/week', source: 'builtin' },
    { id: 'sk-db-002', name: 'MongoDB Schema Designer', description: 'Designs MongoDB document schemas with indexing and aggregation pipelines', category: 'Database', tags: ['mongodb', 'nosql', 'schema', 'aggregation'], repo_owner: 'example', repo_name: 'mongodb-designer', stars: 4100, forks: 280, author: 'mongo_expert', install_command: 'claude add mongodb-designer', installs: '4.1k/week', source: 'builtin' },

    // Design Systems
    { id: 'sk-ds-001', name: 'Design System Architect', description: 'Creates design systems with Theme UI, styled-components, or CSS custom properties', category: 'Design Systems', tags: ['design-systems', 'theming', 'ui', 'components'], repo_owner: 'example', repo_name: 'design-system', stars: 5500, forks: 370, author: 'design_systems_pro', install_command: 'claude add design-system', installs: '5.5k/week', source: 'builtin' },

    // Research & Content
    { id: 'sk-rs-001', name: 'Research Paper Analyzer', description: 'Analyzes and summarizes academic papers with methodology critique', category: 'Research', tags: ['research', 'papers', 'analysis', 'academic'], repo_owner: 'example', repo_name: 'paper-analyzer', stars: 3400, forks: 210, author: 'research_scientist', install_command: 'claude add paper-analyzer', installs: '3.4k/week', source: 'builtin' },
    { id: 'sk-ct-001', name: 'Content Strategist', description: 'Plans content strategy, outlines articles, and optimizes for SEO', category: 'Content', tags: ['content', 'seo', 'strategy', 'writing'], repo_owner: 'example', repo_name: 'content-strategist', stars: 2900, forks: 180, author: 'content_pro', install_command: 'claude add content-strategist', installs: '2.9k/week', source: 'builtin' },
  ];
}

// ─── DB-Backed Skills API ─────────────────────────────────────────────

/**
 * Get all skills with optional filtering and sorting.
 * Reads from DB (with auto-seed), falls back to in-memory.
 */
function getSkills(options = {}) {
  const db = getDB();
  ensureSeed();

  if (db) {
    try {
      return querySkillsFromDB(db, options);
    } catch (_e) {
      console.warn('  ⚠  DB skills query failed, using in-memory:', _e.message);
    }
  }

  return querySkillsFromMemory(options);
}

/** Query skills from the database with filtering, sorting, and pagination. */
function querySkillsFromDB(db, options = {}) {
  const conditions = [];
  const params = [];

  if (options.category && options.category !== 'All') {
    conditions.push('LOWER(category) = LOWER(?)');
    params.push(options.category);
  }

  if (options.search) {
    const q = `%${options.search.toLowerCase()}%`;
    conditions.push('(LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(author) LIKE ?)');
    params.push(q, q, q);
  }

  if (options.source) {
    conditions.push('source = ?');
    params.push(options.source);
  }

  if (options.tag) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)');
    params.push(options.tag.toLowerCase());
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Total count (pre-filtering)
  const countRow = db.prepare(`SELECT COUNT(*) as total FROM skills ${where}`).get(...params);
  const total = countRow.total;

  // Determine sort strategy — 'installs' sorting must happen in JS because the field is a string
  const sortByInstalls = !options.sort || options.sort === 'installs';
  let orderClause;
  switch (options.sort) {
    case 'stars':  orderClause = 'stars DESC'; break;
    case 'name':   orderClause = 'name ASC'; break;
    case 'category': orderClause = 'category ASC, stars DESC'; break;
    default:       orderClause = 'stars DESC'; break; // fallback for installs (re-sorted below)
  }

  const limit = Math.min(parseInt(options.limit || '50', 10), 200);
  const offset = parseInt(options.offset || '0', 10);

  let rows;
  if (sortByInstalls) {
    // Fetch all matching, sort by numeric installs in JS
    rows = db.prepare(`SELECT * FROM skills ${where} ORDER BY stars DESC`).all(...params);
    rows.sort((a, b) => {
      const aNum = parseInt((a.installs || '0').replace(/[^0-9]/g, ''), 10);
      const bNum = parseInt((b.installs || '0').replace(/[^0-9]/g, ''), 10);
      return bNum - aNum;
    });
    rows = rows.slice(offset, offset + limit);
  } else {
    rows = db.prepare(`SELECT * FROM skills ${where} ORDER BY ${orderClause} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  }

  // Parse tags JSON for each row
  const skills = rows.map(s => ({
    ...s,
    tags: parseTags(s.tags),
  }));

  return {
    skills,
    total,
    page: Math.floor(offset / limit) + 1,
    total_pages: Math.ceil(total / limit),
    limit,
    offset,
    categories: getCategories(),
  };
}

/** Fallback: filter/sort/paginate from built-in in-memory data. */
function querySkillsFromMemory(options = {}) {
  const allSkills = getBuiltinSkills();
  let filtered = [...allSkills];

  if (options.category && options.category !== 'All') {
    filtered = filtered.filter(s =>
      s.category.toLowerCase() === options.category.toLowerCase()
    );
  }

  if (options.search) {
    const q = options.search.toLowerCase();
    filtered = filtered.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some(t => t.toLowerCase().includes(q)) ||
      s.author.toLowerCase().includes(q)
    );
  }

  if (options.source) {
    filtered = filtered.filter(s => s.source === options.source);
  }

  if (options.tag) {
    const tag = options.tag.toLowerCase();
    filtered = filtered.filter(s => s.tags.some(t => t.toLowerCase() === tag));
  }

  switch (options.sort) {
    case 'stars':
      filtered.sort((a, b) => b.stars - a.stars);
      break;
    case 'name':
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'category':
      filtered.sort((a, b) => a.category.localeCompare(b.category) || b.stars - a.stars);
      break;
    case 'installs':
    default:
      filtered.sort((a, b) => {
        const aNum = parseInt((a.installs || '0').replace(/[^0-9]/g, ''), 10);
        const bNum = parseInt((b.installs || '0').replace(/[^0-9]/g, ''), 10);
        return bNum - aNum;
      });
      break;
  }

  const limit = Math.min(parseInt(options.limit || '50', 10), 200);
  const offset = parseInt(options.offset || '0', 10);
  const paginated = filtered.slice(offset, offset + limit);

  return {
    skills: paginated,
    total: filtered.length,
    page: Math.floor(offset / limit) + 1,
    total_pages: Math.ceil(filtered.length / limit),
    limit,
    offset,
    categories: getCategories(),
  };
}

/**
 * Get a single skill by ID.
 */
function getSkillById(skillId) {
  const db = getDB();
  ensureSeed();
  if (db) {
    try {
      const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
      if (row) return { ...row, tags: parseTags(row.tags) };
    } catch { /* fall through */ }
  }
  return getBuiltinSkills().find(s => s.id === skillId) || null;
}

/**
 * Get all unique skill categories.
 */
function getCategories() {
  const db = getDB();
  ensureSeed();
  if (db) {
    try {
      return db.prepare('SELECT DISTINCT category FROM skills ORDER BY category').all().map(r => r.category);
    } catch { /* fall through */ }
  }
  const cats = [...new Set(getBuiltinSkills().map(s => s.category))];
  return cats.sort();
}

/**
 * Get skill stats for the /skills page header.
 */
function getSkillStats() {
  const db = getDB();
  ensureSeed();

  let allSkills;
  if (db) {
    try {
      allSkills = db.prepare('SELECT * FROM skills').all();
      allSkills.forEach(s => { s.tags = parseTags(s.tags); });
    } catch {
      allSkills = getBuiltinSkills();
    }
  } else {
    allSkills = getBuiltinSkills();
  }

  return {
    total_skills: allSkills.length,
    total_categories: [...new Set(allSkills.map(s => s.category))].length,
    total_tags: [...new Set(allSkills.flatMap(s => s.tags))].length,
    top_skills: [...allSkills]
      .sort((a, b) => {
        const aNum = parseInt((a.installs || '0').replace(/[^0-9]/g, '0'), 10);
        const bNum = parseInt((b.installs || '0').replace(/[^0-9]/g, '0'), 10);
        return bNum - aNum;
      })
      .slice(0, 10),
  };
}

module.exports = {
  getSkills,
  getSkillById,
  getSkillStats,
};
