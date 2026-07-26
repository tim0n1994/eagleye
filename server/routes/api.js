/**
 * Eagleye — API Routes
 *
 * All /api/* route handlers.
 */

const { getDB } = require('../db/connection');
const { getValue, setValue } = require('../db/user-data');
const { runFullPipeline } = require('../services/sync');
const { generateDailyDigest, enrichItems } = require('../services/llm');
const { getProvider, getProviderInfo } = require('../services/llm-provider');
const { generateItemResearch, generateTopicResearch, getResearchReport, answerItemResearchChat } = require('../services/research');
const { generateDeployPlan, checkDeployEligibility } = require('../services/deploy');
const { getSkills, getSkillById, getSkillStats } = require('../services/skill-crawler');
const { generateId, escapeXML } = require('../services/utils');
const { getJob, getRecentJobs, runJob, cancelJob, JOB_TYPES } = require('../services/jobs');
const { getTopicTimeline, getTopicGraphNeighborhood, getFullGraph, getKG3DData } = require('../services/topic-graph');
const { translateItems, translateItem } = require('../services/translate');
const {
  getLLMConfig,
  saveLLMConfig,
  clearLLMConfig,
  parsePastedLLMConfig,
  maskSecret,
  testLLMConfig,
} = require('../services/llm-provider');
const { getSignals, getTodaySignals, getSignalById, getSignalTypes, getEntityMomentum, getRadarAudiences, getEntityItems, getEntitySeries, compareEntitySeries, getEntityCoOccurrence } = require('../services/signals');
const { esAvailable, esHealth, esSearch, esReindex, esIncrementalSync, esRequest, ES_HOST, ES_INDEX } = require('../services/elasticsearch');
const { ragChat } = require('../services/es-rag');
const { setupAI, checkAIReady, AI_INFERENCE_IDS } = require('../services/es-ai-setup');
const auth = require('../services/auth');
const { checkAuthAttempt, resetAuthAttempts } = require('../services/rate-limit');

// The clean feed aliases in server.js (/watchlist/feed.xml etc.) are rewritten
// before the /api/ auth gate runs, so handlers they reach cannot assume req.user
// exists. Personal feeds resolve their owner here instead: session cookie for a
// browser, ?key=<api key> for an RSS reader, which cannot send cookies.
function resolveFeedUser(req, parsed) {
  if (req.user) return req.user;
  const viaSession = auth.getSessionUser(req);
  if (viaSession) return viaSession;
  const key = parsed?.query?.key || '';
  return key ? auth.getApiKeyOwner(key) : null;
}

// Admin guard for routes that live outside the /api/admin/ prefix (which
// server.js gates by path). Returns true when it has already answered.
function requireAdmin(req, res) {
  if (req.user?.role === 'admin') return false;
  sendError(res, 403, 'Admin access required');
  return true;
}

// Guard for the unauthenticated /api/auth/* endpoints. Returns true (and has
// already answered the request) when the caller is over budget.
function authThrottled(req, res) {
  const { limited, retryAfterSec } = checkAuthAttempt(req);
  if (!limited) return false;
  res.setHeader('Retry-After', String(retryAfterSec));
  sendError(res, 429, `Too many attempts. Try again in ${retryAfterSec}s.`);
  return true;
}

// Helper: read JSON body from a POST request (shared by auth routes)
function readBody(req, maxLen = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > maxLen) { req.destroy(); reject(new Error('Body too large')); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

// ─── Lightweight in-memory cache for read-heavy endpoints ──────────────
// Reduces DB load on repeated calls. Each entry has a TTL; mutation endpoints
// (POST/PUT/DELETE) should call cacheInvalidate() to bust relevant keys.
const _apiCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 1 minute default

function cacheGet(key) {
  const entry = _apiCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { _apiCache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data, ttlMs = CACHE_TTL_MS) {
  _apiCache.set(key, { data, expires: Date.now() + ttlMs });
}

function cacheInvalidate(prefix) {
  if (!prefix) { _apiCache.clear(); return; }
  for (const key of _apiCache.keys()) { if (key.startsWith(prefix)) _apiCache.delete(key); }
}

/**
 * Register all API routes on the provided router.
 * The router is just a map from pathname -> handler function.
 */
function registerRoutes(routes) {
  // ─── Auth Routes ──────────────────────────────────────────────────────

  // POST /api/auth/register — create unverified user + send verification code
  routes['/api/auth/register'] = async (req, res, parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (authThrottled(req, res)) return;
    try {
      const { email, password } = await readBody(req);
      if (!email || !password) return sendError(res, 400, 'Email and password required');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, 'Invalid email');
      if (password.length < 6) return sendError(res, 400, 'Password must be at least 6 characters');

      const existing = auth.getUserByEmail(email);
      if (existing) return sendError(res, 409, 'Email already registered');

      const hash = await auth.hashPassword(password);
      const user = auth.createUser(email, hash);
      const code = auth.storeVerificationCode(email, 'register');

      try {
        await auth.sendVerificationEmail(email, code);
      } catch (e) {
        console.warn('  ⚠  Failed to send verification email:', e.message);
        // Continue — user can still see the code in server logs (dev mode)
      }

      sendJSON(res, 200, { status: 'ok', message: 'Verification code sent', email, isFirstUser: user.isFirstUser });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  };

  // POST /api/auth/verify — verify email code + activate account + create session
  routes['/api/auth/verify'] = async (req, res, parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    // A 6-digit code is only 10^6 wide; without a brake it is brute-forceable.
    if (authThrottled(req, res)) return;
    try {
      const { email, code } = await readBody(req);
      if (!email || !code) return sendError(res, 400, 'Email and code required');

      const valid = auth.verifyCode(email, String(code).trim(), 'register');
      if (!valid) return sendError(res, 400, 'Invalid or expired verification code');

      const user = auth.getUserByEmail(email);
      if (!user) return sendError(res, 404, 'User not found');
      if (user.status !== 'active') return sendError(res, 403, 'Account disabled');

      // Mark email as verified
      const { getDB } = require('../db/connection');
      getDB().prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);

      auth.createSession(res, user.id);
      sendJSON(res, 200, {
        status: 'ok',
        user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name },
      });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  };

  // POST /api/auth/login — verify password + create session
  routes['/api/auth/login'] = async (req, res, parsed) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (authThrottled(req, res)) return;
    try {
      const { email, password } = await readBody(req);
      if (!email || !password) return sendError(res, 400, 'Email and password required');

      const user = auth.getUserByEmail(email);
      if (!user) return sendError(res, 401, 'Invalid email or password');

      const valid = await auth.verifyPassword(password, user.password_hash);
      if (!valid) return sendError(res, 401, 'Invalid email or password');
      if (user.status !== 'active') return sendError(res, 403, 'Account disabled');
      if (!user.email_verified) return sendError(res, 403, 'Email not verified');

      resetAuthAttempts(req);
      auth.createSession(res, user.id);
      sendJSON(res, 200, {
        status: 'ok',
        user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name },
      });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  };

  // POST /api/auth/logout — clear session
  routes['/api/auth/logout'] = async (req, res, parsed) => {
    const cookieHeader = req.headers?.cookie || '';
    const match = cookieHeader.match(/(?:^|;\s*)session=([a-f0-9]+)/);
    auth.clearSession(res, match?.[1]);
    sendJSON(res, 200, { status: 'ok' });
  };

  // GET /api/auth/me — current user info
  routes['/api/auth/me'] = (req, res, parsed) => {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 200, { user: null });
    sendJSON(res, 200, { user });
  };

  // ─── Admin Routes ─────────────────────────────────────────────────────

  // GET /api/admin/users — list all users (admin only; enforced by auth gate)
  routes['/api/admin/users'] = (req, res, parsed) => {
    const users = auth.getAllUsers();
    sendJSON(res, 200, { status: 'ok', users });
  };

  // Param routes for user actions — matched by the router's param patterns
  // POST /api/admin/users/:id/role
  routes['/api/admin/users/:id/role'] = async (req, res, parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    try {
      const { role } = await readBody(req);
      if (!['admin', 'user'].includes(role)) return sendError(res, 400, 'Invalid role');
      auth.updateUserRole(params.id, role);
      sendJSON(res, 200, { status: 'ok' });
    } catch (err) { sendError(res, 500, err.message); }
  };

  // POST /api/admin/users/:id/disable
  routes['/api/admin/users/:id/disable'] = async (req, res, parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    // Prevent self-disable
    if (req.user?.id === params.id) return sendError(res, 400, 'Cannot disable yourself');
    auth.updateUserStatus(params.id, 'disabled');
    sendJSON(res, 200, { status: 'ok' });
  };

  // POST /api/admin/users/:id/enable
  routes['/api/admin/users/:id/enable'] = async (req, res, parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    auth.updateUserStatus(params.id, 'active');
    sendJSON(res, 200, { status: 'ok' });
  };

  // ─── API Key Management (for the current user) ────────────────────────

  // GET /api/auth/keys — list current user's API keys
  // POST /api/auth/keys — create a new API key { name }
  routes['/api/auth/keys'] = async (req, res, parsed) => {
    if (!req.user) return sendError(res, 401, 'Authentication required');
    if (req.method === 'POST') {
      try {
        const { name } = await readBody(req);
        const key = auth.createApiKey(name || 'default', req.user.id);
        sendJSON(res, 200, { status: 'ok', key });
      } catch (err) { sendError(res, 500, err.message); }
    } else {
      const keys = auth.listApiKeys(req.user.id);
      sendJSON(res, 200, { status: 'ok', keys });
    }
  };

  // DELETE /api/auth/keys/:key — revoke an API key
  routes['/api/auth/keys/:key'] = async (req, res, parsed, params) => {
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
    // Revoking is destructive, so it must be your own key (or you an admin).
    // Without this any account could disable a key belonging to anyone else.
    const owned = auth.listApiKeys(req.user.id).some(k => k.key === params.key);
    if (!owned && req.user.role !== 'admin') return sendError(res, 404, 'Key not found');
    auth.revokeApiKey(params.key);
    sendJSON(res, 200, { status: 'ok' });
  };

  // --- Items API ---
  routes['/api/items'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const category = parsed.query.category;
    const source = parsed.query.source;
    const date = parsed.query.date;
    const limit = parseInt(parsed.query.limit || '50', 10);
    const offset = parseInt(parsed.query.offset || '0', 10);

    let sql = `SELECT i.*, s.label as source_label, s.slug as source_slug FROM information_items i JOIN sources s ON i.source_id = s.id WHERE 1=1`;
    const params = [];

    // Build the WHERE clause once so we can reuse it for the COUNT.
    let whereSql = '';
    if (category && category !== 'All') {
      whereSql += ` AND i.id IN (SELECT it.item_id FROM item_topics it JOIN topics t ON it.topic_id = t.id WHERE t.slug = ?)`;
      params.push(category);
    }
    if (source) {
      whereSql += ` AND s.slug = ?`;
      params.push(source);
    }
    if (date) {
      whereSql += ` AND i.digest_date = ?`;
      params.push(date);
    }
    sql += whereSql;

    // True total count for the matching set (independent of limit/offset).
    // Previously returned page length, so the UI couldn't show "showing 50 of 843".
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM information_items i JOIN sources s ON i.source_id = s.id WHERE 1=1${whereSql}`).get(...params);

    sql += ` ORDER BY i.score DESC, i.published_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const items = db.prepare(sql).all(...params);

    // Attach summaries if available
    const getSummary = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?');
    const getTopics = db.prepare(`
      SELECT t.slug, t.name, it.relevance FROM item_topics it 
      JOIN topics t ON it.topic_id = t.id 
      WHERE it.item_id = ?
    `);
    const getTags = db.prepare(`
      SELECT tg.slug, tg.name, itg.confidence FROM item_tags itg
      JOIN tags tg ON itg.tag_id = tg.id
      WHERE itg.item_id = ?
    `);

    // Attach story-cluster info so cards can show "+N sources" dedup badges
    // (§16 duplicate-group UX). Cached lookup; no-op if no clusters for this date.
    let clusterMap = null;
    if (date) {
      try {
        const { getItemClusterMap } = require('../services/story-clusters');
        clusterMap = getItemClusterMap({ date, sinceDays: 1 });
      } catch { /* story-clusters absent → no badges */ }
    }

    // Batch-fetch summaries/topics/tags to avoid N+1 queries (was 150 round-trips
    // per 50-item page; now 3 batch queries using IN clauses).
    const itemIds = items.map(i => i.id);
    const idList = itemIds.length > 0 ? `'${itemIds.map(id => String(id).replace(/'/g, "''")).join("','")}'` : 'NULL';
    const summaryMap = new Map();
    const topicMap = new Map();
    const tagMap = new Map();
    try {
      db.prepare(`SELECT * FROM ai_summaries WHERE item_id IN (${idList})`).all().forEach(s => summaryMap.set(s.item_id, s));
      db.prepare(`SELECT it.item_id, t.slug, t.name, it.relevance FROM item_topics it JOIN topics t ON it.topic_id = t.id WHERE it.item_id IN (${idList})`).all().forEach(r => {
        if (!topicMap.has(r.item_id)) topicMap.set(r.item_id, []);
        topicMap.get(r.item_id).push({ slug: r.slug, name: r.name, relevance: r.relevance });
      });
      db.prepare(`SELECT itg.item_id, tg.slug, tg.name, itg.confidence FROM item_tags itg JOIN tags tg ON itg.tag_id = tg.id WHERE itg.item_id IN (${idList})`).all().forEach(r => {
        if (!tagMap.has(r.item_id)) tagMap.set(r.item_id, []);
        tagMap.get(r.item_id).push({ slug: r.slug, name: r.name, confidence: r.confidence });
      });
    } catch { /* fall back to per-item below if batch fails */ }

    const enriched = items.map(item => {
      // Use batch maps if populated; fall back to per-item query for safety.
      const summary = summaryMap.size > 0 ? summaryMap.get(item.id) : getSummary.get(item.id);
      const topics = topicMap.size > 0 ? (topicMap.get(item.id) || []) : getTopics.all(item.id);
      const tags = tagMap.size > 0 ? (tagMap.get(item.id) || []) : getTags.all(item.id);
      try {
        item.source_payload = JSON.parse(item.source_payload || '{}');
        item.normalized_payload = JSON.parse(item.normalized_payload || '{}');
        item.popularity = JSON.parse(item.popularity || '{}');
      } catch {}
      return {
        ...item,
        ai_summary: summary || null,
        topics: topics || [],
        tags: tags || [],
        story_cluster: clusterMap?.get(item.id) || null,
      };
    });

    sendJSON(res, 200, { status: 'ok', items: enriched, total: countRow.c, page_count: enriched.length });
  };

  // --- Papers API ---
  routes['/api/papers'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const source = parsed.query.source || 'all';
    const limit = Math.min(parseInt(parsed.query.limit || '60', 10) || 60, 120);
    const offset = parseInt(parsed.query.offset || '0', 10) || 0;
    const params = [];
    let sourceFilter = '';
    if (source && source !== 'all') {
      sourceFilter = 'AND s.slug = ?';
      params.push(source);
    }

    const rows = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug,
             pm.paper_id, pm.provider, pm.arxiv_id, pm.doi, pm.abstract,
             pm.authors_json, pm.categories_json, pm.pdf_url, pm.landing_url,
             pm.code_url, pm.tasks_json, pm.venue,
             ais.ai_title_zh, ais.one_liner_zh, ais.short_summary_zh, ais.confidence
      FROM information_items i
      JOIN sources s ON s.id = i.source_id
      LEFT JOIN paper_metadata pm ON pm.item_id = i.id
      LEFT JOIN ai_summaries ais ON ais.item_id = i.id
      WHERE (
        pm.item_id IS NOT NULL
        OR s.slug IN ('hugging-face', 'arxiv-ai', 'physical-ai-arxiv')
      )
      ${sourceFilter}
      ORDER BY i.published_at DESC, i.score DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const getTags = db.prepare(`
      SELECT tg.slug, tg.name, itg.confidence FROM item_tags itg
      JOIN tags tg ON itg.tag_id = tg.id
      WHERE itg.item_id = ?
      ORDER BY itg.confidence DESC, tg.name ASC
    `);

    const parseJSON = (value, fallback) => {
      try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
    };

    const papers = rows.map(row => ({
      id: row.id,
      title: row.title,
      title_zh: row.ai_title_zh || '',
      one_liner_zh: row.one_liner_zh || '',
      short_summary_zh: row.short_summary_zh || '',
      abstract: row.abstract || row.original_summary || '',
      source_label: row.source_label,
      source_slug: row.source_slug,
      canonical_url: row.landing_url || row.canonical_url,
      pdf_url: row.pdf_url || '',
      code_url: row.code_url || '',
      paper_id: row.paper_id || row.external_id || '',
      provider: row.provider || row.source_slug,
      arxiv_id: row.arxiv_id || '',
      doi: row.doi || '',
      authors: parseJSON(row.authors_json, []),
      categories: parseJSON(row.categories_json, []),
      tasks: parseJSON(row.tasks_json, []),
      venue: row.venue || '',
      published_at: row.published_at,
      confidence: row.confidence || null,
      tags: getTags.all(row.id),
    }));

    const sources = db.prepare(`
      SELECT s.slug, s.label, COUNT(i.id) as count
      FROM sources s
      JOIN information_items i ON i.source_id = s.id
      LEFT JOIN paper_metadata pm ON pm.item_id = i.id
      WHERE pm.item_id IS NOT NULL OR s.slug IN ('hugging-face', 'arxiv-ai', 'physical-ai-arxiv')
      GROUP BY s.slug
      ORDER BY count DESC, s.slug ASC
    `).all();

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN pm.pdf_url IS NOT NULL AND pm.pdf_url != '' THEN 1 ELSE 0 END) as with_pdf,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id = i.id) THEN 1 ELSE 0 END) as tagged
      FROM information_items i
      JOIN sources s ON s.id = i.source_id
      LEFT JOIN paper_metadata pm ON pm.item_id = i.id
      WHERE pm.item_id IS NOT NULL OR s.slug IN ('hugging-face', 'arxiv-ai', 'physical-ai-arxiv')
    `).get();

    sendJSON(res, 200, { status: 'ok', papers, sources, stats, offset, limit });
  };

  // --- Legacy items API (backward compat) ---
  routes['/api/items-legacy'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const category = parsed.query.category;
    let items;
    if (category && category !== 'All') {
      items = db.prepare('SELECT * FROM items WHERE category = ? ORDER BY created_at DESC LIMIT 100').all(category);
    } else {
      items = db.prepare('SELECT * FROM items ORDER BY created_at DESC LIMIT 100').all();
    }
    items.forEach(it => {
      try { it.tags = JSON.parse(it.tags || '[]'); } catch { it.tags = []; }
    });
    sendJSON(res, 200, { status: 'ok', items });
  };

  // --- Categories API ---
  routes['/api/categories'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const categories = db.prepare('SELECT category, COUNT(*) as count FROM items GROUP BY category').all();
    sendJSON(res, 200, { status: 'ok', categories });
  };

  // --- Topics API ---
  routes['/api/topics'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const topics = db.prepare(`SELECT t.*, 
      (SELECT COUNT(*) FROM item_topics WHERE topic_id = t.id) as item_count
      FROM topics t ORDER BY t.growth_score DESC, t.name`).all();

    // Get edge counts for each topic
    const edgeCount = db.prepare(`SELECT COUNT(*) as count FROM graph_edges WHERE 
      (from_type = 'topic' AND from_id = ?) OR (to_type = 'topic' AND to_id = ?)`);

    const enriched = topics.map(t => ({
      ...t,
      edge_count: edgeCount.get(t.id, t.id)?.count || 0,
    }));

    sendJSON(res, 200, { status: 'ok', topics: enriched });
  };

  // --- Single Topic API ---
  routes['/api/topics/:slug'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || parsed.query.slug;
    const topic = db.prepare(`SELECT t.*, 
      (SELECT COUNT(*) FROM item_topics WHERE topic_id = t.id) as item_count,
      (SELECT COUNT(*) FROM topics WHERE parent_topic_id = t.id) as child_count
      FROM topics t WHERE t.slug = ?`).get(slug);

    if (!topic) return sendError(res, 404, 'Topic not found');

    // Get top items for this topic
    const items = db.prepare(`
      SELECT i.*, s.label as source_label, it.relevance 
      FROM information_items i 
      JOIN item_topics it ON i.id = it.item_id 
      JOIN sources s ON i.source_id = s.id
      WHERE it.topic_id = ? 
      ORDER BY it.relevance DESC, i.score DESC 
      LIMIT 20
    `).all(topic.id);

    // Get graph neighbors
    const neighbors = db.prepare(`
      SELECT * FROM graph_edges 
      WHERE (from_type = 'topic' AND from_id = ?) OR (to_type = 'topic' AND to_id = ?)
      LIMIT 50
    `).all(topic.id, topic.id);

    sendJSON(res, 200, { status: 'ok', topic, items, neighbors });
  };

  // --- Sources API ---
  routes['/api/sources'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const sources = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM information_items WHERE source_id = s.id) as total_items,
        (SELECT COUNT(*) FROM information_items WHERE source_id = s.id AND digest_date = ?) as today_items,
        sp.source_type, sp.early_signal_rate, sp.noise_rate,
        sp.originality_rate, sp.last_30d_alpha_hits
      FROM sources s
      LEFT JOIN source_profiles sp ON sp.source_slug = s.slug
      WHERE s.is_active = 1
      ORDER BY CASE s.slug
        WHEN 'x-following' THEN 0
        WHEN 'hacker-news' THEN 1
        WHEN 'github-trending' THEN 2
        WHEN 'hugging-face' THEN 3
        WHEN 'product-hunt' THEN 4
        ELSE 99
      END, s.label
    `).all(new Date().toISOString().slice(0, 10).replace(/-/g, ''));

    // Per-source 7-day trend: item count per day per source (for mini sparkline).
    const since7 = (() => {
      const d = new Date(); d.setDate(d.getDate() - 7);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    })();
    const trendRows = db.prepare(`
      SELECT s.slug, i.digest_date, COUNT(*) AS cnt
      FROM information_items i JOIN sources s ON i.source_id = s.id
      WHERE i.digest_date >= ?
      GROUP BY s.slug, i.digest_date
    `).all(since7);
    const trendMap = {};
    for (const r of trendRows) {
      if (!trendMap[r.slug]) trendMap[r.slug] = [];
      trendMap[r.slug].push({ date: r.digest_date, count: r.cnt });
    }
    for (const s of sources) s.trend = trendMap[s.slug] || [];

    sendJSON(res, 200, { status: 'ok', sources });
  };
  routes['/api/source/:slug'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || parsed.query.slug;
    const date = parsed.query.date;

    const source = db.prepare('SELECT * FROM sources WHERE slug = ?').get(slug);
    if (!source) return sendError(res, 404, 'Source not found');

    let items;
    if (date) {
      items = db.prepare(`
        SELECT i.*, s.label as source_label 
        FROM information_items i 
        JOIN sources s ON i.source_id = s.id 
        WHERE s.slug = ? AND i.digest_date = ?
        ORDER BY i.score DESC
        LIMIT 50
      `).all(slug, date);
    } else {
      items = db.prepare(`
        SELECT i.*, s.label as source_label 
        FROM information_items i 
        JOIN sources s ON i.source_id = s.id 
        WHERE s.slug = ?
        ORDER BY i.published_at DESC
        LIMIT 50
      `).all(slug);
    }

    const getTopics = db.prepare(`
      SELECT t.name, t.slug FROM topics t 
      JOIN item_topics it ON t.id = it.topic_id 
      WHERE it.item_id = ?
    `);
    items = items.map(item => ({
      ...item,
      topics: getTopics.all(item.id) || []
    }));

    // Per-source signal-type distribution (last 30d) for the detail page.
    const signalDist = db.prepare(`
      SELECT ss.signal_type, COUNT(*) AS count
      FROM signal_scores ss
      JOIN information_items i ON i.id = ss.item_id
      JOIN sources s ON i.source_id = s.id
      WHERE s.slug = ? AND i.digest_date >= ?
      GROUP BY ss.signal_type ORDER BY count DESC
    `).all(slug, (() => {
      const d = new Date(); d.setDate(d.getDate() - 30);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    })());

    sendJSON(res, 200, { exists: true, source, items, total: items.length, signal_dist: signalDist });
  };

  // --- Research API ---
  routes['/api/research'] = async (req, res, parsed) => {
    const itemId = parsed.query.item_id || parsed.query.url;
    const itemUrl = parsed.query.url;
    if (!itemId && !itemUrl) return sendError(res, 400, 'item_id or url required');

    const db = getDB();

    // Check cached research
    if (itemId) {
      const cached = db?.prepare('SELECT * FROM research_reports WHERE item_id = ? AND status = ?').get(itemId, 'completed');
      if (cached) {
        return sendJSON(res, 200, { status: 'ok', content: cached.report_markdown, id: cached.id });
      }
    }

    // Check legacy research table
    if (itemUrl) {
      const cached = db?.prepare('SELECT content FROM research WHERE url = ?').get(itemUrl);
      if (cached) {
        return sendJSON(res, 200, { status: 'ok', content: cached.content });
      }
    }

    // Generate new research
    const item = itemId ? db?.prepare(`
      SELECT i.*, s.label as source_label FROM information_items i 
      JOIN sources s ON i.source_id = s.id WHERE i.id = ?
    `).get(itemId) : null;

    // Get topics
    let topics = [];
    let relatedItems = [];
    if (item) {
      topics = db?.prepare(`
        SELECT t.name FROM item_topics it JOIN topics t ON it.topic_id = t.id WHERE it.item_id = ?
      `).all(item.id).map(r => r.name) || [];
      
      relatedItems = db?.prepare(`
        SELECT i.title FROM information_items i 
        WHERE i.id != ? AND i.source_id = ? 
        ORDER BY i.published_at DESC LIMIT 5
      `).all(item.id, item.source_id).map(r => r.title) || [];
    }

    const provider = getProvider();
    let report = null;
    if (provider) {
      try {
        const researchPrompt = `Generate a comprehensive research report about the following item.

Title: ${item?.title || itemUrl}
Source: ${item?.source_label || 'N/A'}
URL: ${item?.canonical_url || 'N/A'}
Topics: ${(topics || []).join(', ')}
Related: ${(relatedItems || []).slice(0, 3).join(', ')}

Write in Markdown: Executive Summary, Technical Analysis, Market Impact, Key Takeaways, Recommendations.`;
        report = await provider.call(researchPrompt, { temperature: 0.3, maxTokens: 4096 });
      } catch (err) {
        console.error('Research report failed:', err.message);
      }
    }
    const reportId = generateId();

    if (db && itemId) {
      db.prepare(`
        INSERT INTO research_reports (id, item_id, status, prompt, report_markdown, model_provider, model_name, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(reportId, itemId, 'completed', '', report || '', 'gemini', 'gemini-2.0-flash');
    }

    // Cache in legacy table too
    if (db && itemUrl) {
      db.prepare('INSERT OR REPLACE INTO research (url, content) VALUES (?, ?)').run(itemUrl, report || '');
    }

    sendJSON(res, 200, { status: 'ok', content: report || 'Research failed to generate.', id: reportId });
  };

  // --- Graph API ---
  routes['/api/graph'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    // Get entities (legacy)
    const entities = db.prepare('SELECT * FROM entities').all();
    
    // Get links from item_entities (legacy)
    const links = db.prepare(`
      SELECT ie.entity_id as source, ie.item_id as target, i.title, i.category
      FROM item_entities ie
      JOIN items i ON ie.item_id = i.id
    `).all();

    // Build entity co-occurrence links
    const entityLinks = [];
    const itemToEntities = {};
    links.forEach(l => {
      if (!itemToEntities[l.target]) itemToEntities[l.target] = [];
      itemToEntities[l.target].push(l.source);
    });
    
    Object.values(itemToEntities).forEach(ents => {
      for (let i = 0; i < ents.length; i++) {
        for (let j = i + 1; j < ents.length; j++) {
          entityLinks.push({ source: ents[i], target: ents[j] });
        }
      }
    });

    // New graph data
    const topics = db.prepare('SELECT id, name as title FROM topics LIMIT 20').all();
    const graphEdges = db.prepare('SELECT * FROM graph_edges ORDER BY weight DESC LIMIT 100').all();

    sendJSON(res, 200, { 
      status: 'ok', 
      nodes: entities, 
      links: entityLinks,
      topics,
      graph_edges: graphEdges,
    });
  };

  // --- Sync API ---
  routes['/api/sync'] = async (req, res, _parsed) => {
    const jobId = await runJob(JOB_TYPES.FETCH_ALL, {});
    sendJSON(res, 200, { status: 'queued', job_id: jobId, message: 'Sync queued' });
  };

  // --- Sync Get API ---
  routes['/api/sync/get'] = (req, res, _parsed) => {
    const bookmarks = getValue('bookmarks', req.user.id) || [];
    const read = getValue('read', req.user.id) || [];
    const customRss = getValue('custom-rss', req.user.id) || [];
    sendJSON(res, 200, { bookmarks, read, customRss });
  };

  // --- Sync Set API ---
  routes['/api/sync/set'] = (req, res, _parsed) => {
    let body = '';
    // Unbounded body: readBody's cap applies here too.
    req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.bookmarks) setValue('bookmarks', data.bookmarks, req.user.id);
        if (data.read) setValue('read', data.read, req.user.id);
        if (data.customRss) setValue('custom-rss', data.customRss, req.user.id);
        sendJSON(res, 200, { status: 'ok' });
      } catch {
        sendError(res, 400, 'Invalid JSON');
      }
    });
  };

  // --- Health API ---
  routes['/api/health'] = (req, res, _parsed) => {
    const db = getDB();
    const dbStatus = db ? 'connected' : 'disconnected';
    const itemCount = db ? db.prepare('SELECT COUNT(*) as count FROM information_items').get().count : 0;
    const legacyCount = db ? db.prepare('SELECT COUNT(*) as count FROM items').get().count : 0;
    
    sendJSON(res, 200, { 
      status: 'ok', 
      time: new Date().toISOString(),
      database: dbStatus,
      items: { information_items: itemCount, legacy_items: legacyCount },
      apiKey: process.env.GEMINI_API_KEY ? 'configured' : 'not set',
    });
  };

  // --- Digest API ---
  routes['/api/digest'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const date = parsed.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    
    // Get digest from daily_digests table or build on the fly
    const digest = db.prepare('SELECT * FROM daily_digests WHERE digest_date = ?').get(date);
    
    // Get items for this date
    const items = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug
      FROM information_items i 
      JOIN sources s ON i.source_id = s.id 
      WHERE i.digest_date = ?
      ORDER BY s.label, i.score DESC
      LIMIT 100
    `).all(date);

    // Attach summaries and topics
    const getSummary = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?');
    const getTopics = db.prepare(`
      SELECT t.name, t.slug FROM topics t 
      JOIN item_topics it ON t.id = it.topic_id 
      WHERE it.item_id = ?
    `);
    const enriched = items.map(item => {
      const summary = getSummary.get(item.id);
      const itemTopics = getTopics.all(item.id) || [];
      try {
        item.source_payload = JSON.parse(item.source_payload || '{}');
        item.popularity = JSON.parse(item.popularity || '{}');
      } catch {}
      return { ...item, ai_summary: summary || null, topics: itemTopics };
    });

    // Group by source
    const bySource = {};
    for (const item of enriched) {
      const src = item.source_label || 'Other';
      if (!bySource[src]) bySource[src] = [];
      bySource[src].push(item);
    }

    sendJSON(res, 200, {
      status: 'ok',
      date,
      digest: digest || null,
      by_source: bySource,
      total: enriched.length,
    });
  };

  // --- Digest Coverage API (daily counts for last 30 days) ---
  routes['/api/digest/coverage'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const coverage = db.prepare(`
      SELECT digest_date, COUNT(*) as count
      FROM information_items
      GROUP BY digest_date
      ORDER BY digest_date DESC
      LIMIT 30
    `).all();

    const coverageMap = {};
    coverage.forEach(row => {
      coverageMap[row.digest_date] = row.count;
    });

    sendJSON(res, 200, { status: 'ok', coverage: coverageMap });
  };

  // --- System Stats: enrichment/translation backlog, coverage, DB size ---
  routes['/api/system/stats'] = (_req, res) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM information_items) AS total_items,
        (SELECT COUNT(*) FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries) AND enrichment_attempts < 3) AS enrichment_backlog,
        (SELECT COUNT(*) FROM information_items WHERE enrichment_attempts >= 3) AS poisoned_items,
        (SELECT COUNT(*) FROM ai_summaries) AS summaries,
        (SELECT COUNT(*) FROM ai_summaries WHERE translation_status != 'translated') AS translation_backlog,
        (SELECT COUNT(*) FROM signal_scores) AS scored,
        (SELECT COUNT(*) FROM signal_scores WHERE signal_type = 'uncategorized') AS uncategorized,
        (SELECT COUNT(*) FROM research_reports WHERE status = 'completed') AS research_reports,
        (SELECT COUNT(*) FROM saved_items) AS saved_items,
        (SELECT COUNT(*) FROM seen_items) AS seen_items,
        (SELECT COUNT(*) FROM canonical_entities) AS entities,
        (SELECT COUNT(*) FROM dynamic_topics) AS dynamic_topics
    `).get();
    // DB file size
    try {
      const fs = require('fs');
      const dbPath = require('path').join(__dirname, '..', '..', 'eagleye.db');
      stats.db_size_mb = Math.round(fs.statSync(dbPath).size / 1048576);
    } catch { stats.db_size_mb = null; }
    // Connector health: per-source last 7d item counts + last_fetched_at.
    stats.connectors = db.prepare(`
      SELECT s.slug, s.label, s.last_fetched_at,
        (SELECT COUNT(*) FROM information_items i WHERE i.source_id = s.id AND i.digest_date >= ?) AS items_7d,
        (SELECT COUNT(*) FROM information_items i WHERE i.source_id = s.id) AS total_items
      FROM sources s WHERE s.is_active = 1 ORDER BY items_7d DESC
    `).all(((() => {
      const d = new Date(); d.setDate(d.getDate() - 7);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    })()));
    sendJSON(res, 200, { status: 'ok', stats });
  };

  // --- Graph V2 API (new knowledge graph) ---
  routes['/api/graph/v2'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const topicId = parsed.query.topic_id;
    
    let nodes;
    let edges;

    if (topicId) {
      // Get neighborhood for a specific topic
      nodes = db.prepare(`
        SELECT id, name as label, 'topic' as type, status FROM topics WHERE id = ? OR parent_topic_id = ?
      `).all(topicId, topicId);
      
      edges = db.prepare(`
        SELECT * FROM graph_edges 
        WHERE (from_type = 'topic' AND from_id = ?) OR (to_type = 'topic' AND to_id = ?)
        LIMIT 100
      `).all(topicId, topicId);
    } else {
      // Get all topics as nodes
      const topics = db.prepare('SELECT id, name as label, \'topic\' as type, status FROM topics LIMIT 50').all();
      const tags = db.prepare('SELECT id, name as label, \'tag\' as type FROM tags LIMIT 50').all();
      nodes = [...topics, ...tags];
      edges = db.prepare('SELECT * FROM graph_edges ORDER BY weight DESC LIMIT 200').all();
    }

    sendJSON(res, 200, { status: 'ok', nodes, edges });
  };

  // --- KG v2 Metrics API ---
  routes['/api/kg/metrics'] = (_req, res) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    const coverageBySource = db.prepare(`
      SELECT s.slug,
             COALESCE(s.label_zh, s.label) AS label,
             COUNT(i.id) AS items,
             SUM(CASE WHEN f.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_features,
             SUM(CASE WHEN tags.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_tags,
             SUM(CASE WHEN topics.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_topics,
             SUM(CASE WHEN mentions.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_entities,
             SUM(CASE WHEN vectors.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_vectors
      FROM sources s
      LEFT JOIN information_items i ON i.source_id = s.id
      LEFT JOIN item_features f ON f.item_id = i.id
      LEFT JOIN (SELECT DISTINCT item_id FROM item_tag_assignments) tags ON tags.item_id = i.id
      LEFT JOIN (SELECT DISTINCT item_id FROM item_topic_assignments) topics ON topics.item_id = i.id
      LEFT JOIN (SELECT DISTINCT item_id FROM entity_mentions) mentions ON mentions.item_id = i.id
      LEFT JOIN (SELECT DISTINCT item_id FROM item_vectors) vectors ON vectors.item_id = i.id
      GROUP BY s.slug
      ORDER BY CASE s.slug
        WHEN 'x-following' THEN 0
        WHEN 'hacker-news' THEN 1
        WHEN 'github-trending' THEN 2
        WHEN 'hugging-face' THEN 3
        WHEN 'product-hunt' THEN 4
        ELSE 99
      END, s.slug
    `).all().map(row => {
      const items = Number(row.items || 0);
      const pct = (value) => items ? Math.round((Number(value || 0) / items) * 1000) / 10 : 0;
      return {
        ...row,
        feature_coverage_pct: pct(row.with_features),
        tag_coverage_pct: pct(row.with_tags),
        topic_coverage_pct: pct(row.with_topics),
        entity_coverage_pct: pct(row.with_entities),
        vector_coverage_pct: pct(row.with_vectors),
      };
    });

    const recentRuns = db.prepare(`
      SELECT id, scope, scope_value, status, extractor_version, metrics, error, created_at, completed_at
      FROM kg_extraction_runs
      ORDER BY created_at DESC
      LIMIT 10
    `).all().map(row => {
      try { row.metrics = JSON.parse(row.metrics || '{}'); } catch {}
      return row;
    });

    const vectorModels = db.prepare(`
      SELECT vector_type, model_name, dimension, COUNT(*) AS items
      FROM item_vectors
      GROUP BY vector_type, model_name, dimension
      ORDER BY items DESC, vector_type, model_name
    `).all();

    sendJSON(res, 200, {
      status: 'ok',
      tables: {
        information_items: count('information_items'),
        topic_taxonomy: count('topic_taxonomy'),
        dynamic_topics: count('dynamic_topics'),
        item_features: count('item_features'),
        kg_tags: count('kg_tags'),
        item_tag_assignments: count('item_tag_assignments'),
        entity_mentions: count('entity_mentions'),
        canonical_entities: count('canonical_entities'),
        item_topic_assignments: count('item_topic_assignments'),
        item_vectors: count('item_vectors'),
        kg_edges: count('kg_edges'),
      },
      coverage_by_source: coverageBySource,
      vector_models: vectorModels,
      recent_runs: recentRuns,
    });
  };

  // --- Deploy Plan API ---
  routes['/api/deployment-plans/:id'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    
    const plan = db.prepare('SELECT * FROM deployment_plans WHERE id = ?').get(params?.id || '');
    if (!plan) return sendError(res, 404, 'Plan not found');
    
    try {
      plan.commands = JSON.parse(plan.commands || '[]');
      plan.env_vars = JSON.parse(plan.env_vars || '{}');
      plan.detected_stack = JSON.parse(plan.detected_stack || '{}');
      plan.risk_notes = JSON.parse(plan.risk_notes || '[]');
    } catch {}
    
    sendJSON(res, 200, { status: 'ok', plan });
  };

  // --- Enrich API: Trigger AI summary enrichment ---
  routes['/api/enrich'] = async (req, res, parsed) => {
    const batchSize = parseInt(parsed.query.batch || process.env.JOB_ENRICH_BATCH_SIZE || '1600', 10);
    const background = parsed.query.background !== 'false';
    const priorityOnly = parsed.query.priority_only === 'true' || parsed.query.priority_only === '1';
    const resetAttempts = parsed.query.reset_attempts === 'true' || parsed.query.reset_attempts === '1';

    if (background) {
      const jobId = await runJob(JOB_TYPES.ENRICH_ITEMS, { batchSize, priorityOnly, resetAttempts });
      sendJSON(res, 200, {
        status: 'ok',
        job_id: jobId,
        message: `Priority enrichment queued (batch: ${batchSize}${priorityOnly ? ', priority sources only' : ''}${resetAttempts ? ', reset attempts' : ''})`,
      });
    } else {
      try {
        const result = await enrichItems(batchSize, { priorityOnly, resetAttempts });
        sendJSON(res, 200, { status: 'ok', result });
      } catch (err) {
        sendError(res, 500, `Enrichment failed: ${err.message}`);
      }
    }
  };

  // --- Full Re-enrich: clear all existing enrichment + re-process ---
  routes['/api/enrich/reenrich'] = async (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const batchSize = parseInt(parsed.query.batch || '0', 10) || 5000;

    try {
      const clearedSummaries = db.prepare('DELETE FROM ai_summaries').run().changes;
      const clearedItemTags = db.prepare('DELETE FROM item_tags').run().changes;
      const clearedGraphEdges = db.prepare("DELETE FROM graph_edges WHERE edge_type IN ('item_has_tag','item_belongs_topic','item_mentions_entity')").run().changes;
      const clearedItemTopics = db.prepare("DELETE FROM item_topics WHERE assigned_by = 'keyword'").run().changes;

      const result = await enrichItems(batchSize, { priorityOnly: false });

      sendJSON(res, 200, {
        status: 'ok',
        cleared: { summaries: clearedSummaries, item_tags: clearedItemTags, graph_edges: clearedGraphEdges, item_topics: clearedItemTopics },
        enriched: result,
      });
    } catch (err) {
      sendError(res, 500, `Re-enrichment failed: ${err.message}`);
    }
  };

  // --- Digest API: Build or get digest for a date ---
  routes['/api/digest/build'] = async (req, res, parsed) => {
    const date = parsed.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const background = parsed.query.background !== 'false';

    if (background) {
      const jobId = await runJob(JOB_TYPES.BUILD_DIGEST, { date });
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: `Digest build queued for ${date}` });
    } else {
      try {
        const digest = await generateDailyDigest(date);
        sendJSON(res, 200, { status: 'ok', digest, date });
      } catch (err) {
        sendError(res, 500, `Digest build failed: ${err.message}`);
      }
    }
  };

  // --- Pipeline API: Run full fetch → enrich → digest pipeline ---
  routes['/api/pipeline'] = async (req, res, _parsed) => {
    try {
      const jobId = await runFullPipeline();
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: 'Full pipeline started' });
    } catch (err) {
      sendError(res, 500, `Pipeline failed: ${err.message}`);
    }
  };

  // --- Jobs API: List recent jobs ---
  routes['/api/jobs'] = (req, res, parsed) => {
    const jobs = getRecentJobs(parseInt(parsed.query.limit || '20', 10));
    sendJSON(res, 200, { status: 'ok', jobs });
  };

  // --- Single Job API ---
  routes['/api/jobs/:id'] = (req, res, parsed, params) => {
    const jobId = params?.id || parsed.query.id;
    if (!jobId) return sendError(res, 400, 'Job ID required');
    const job = getJob(jobId);
    if (!job) return sendError(res, 404, 'Job not found');
    sendJSON(res, 200, { status: 'ok', job });
  };

  // --- Cancel Job API: POST /api/jobs/:id/cancel ---
  routes['/api/jobs/:id/cancel'] = (req, res, parsed, params) => {
    const jobId = params?.id;
    if (!jobId) return sendError(res, 400, 'Job ID required');
    const ok = cancelJob(jobId);
    if (!ok) {
      const job = getJob(jobId);
      return sendError(res, 409, `Job is already ${job?.status || 'unknown'}`);
    }
    sendJSON(res, 200, { status: 'ok', job_id: jobId, cancelled: true });
  };

  // --- Translation Backfill API: POST /api/translate/backfill?batch_size=50&force=false&background=true ---
  routes['/api/translate/backfill'] = async (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const all = parsed.query.all === 'true' || parsed.query.all === '1';
    const batchSize = all
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Math.min(parseInt(parsed.query.batch_size || '50', 10), 500));
    const force = parsed.query.force === 'true' || parsed.query.force === '1';
    const background = parsed.query.background !== 'false';
    const sourceSlug = String(parsed.query.source || '').trim();

    if (background) {
      // Use the job system so this is cancellable and visible in /api/jobs
      const jobId = await runJob(JOB_TYPES.TRANSLATE_BACKFILL, { batchSize, force, all, sourceSlug });
      const translatedRow = db.prepare(`
        SELECT COUNT(*) as c FROM information_items WHERE title_zh IS NOT NULL AND title_zh != ''
      `).get();
      return sendJSON(res, 200, {
        status: 'queued',
        job_id: jobId,
        message: `Backfill queued (${sourceSlug || 'all-sources'}, ${all ? 'all pending' : `batch: ${batchSize}`}, force: ${force}). Cancel via POST /api/jobs/${jobId}/cancel.`,
        total_translated: translatedRow.c,
        batch_size: all ? 'all' : batchSize,
        all,
        source: sourceSlug || null,
      });
    }

    const pendingRow = db.prepare(`
      SELECT COUNT(DISTINCT i.id) as c
      FROM information_items i
      JOIN sources src ON src.id = i.source_id
      LEFT JOIN ai_summaries s ON s.item_id = i.id
      WHERE (
        i.title_zh IS NULL OR i.title_zh = '' OR i.title_zh_status = 'pending'
        OR (
          s.item_id IS NOT NULL AND (
            s.ai_title_zh IS NULL OR s.ai_title_zh = ''
            OR s.one_liner_zh IS NULL OR s.one_liner_zh = ''
            OR s.short_summary_zh IS NULL OR s.short_summary_zh = ''
            OR s.translation_status = 'pending'
          )
        )
      )
      ${sourceSlug ? 'AND src.slug = ?' : ''}
    `).get(...(sourceSlug ? [sourceSlug] : []));
    const totalPending = pendingRow.c;
    const translatedRow = db.prepare(`
      SELECT COUNT(*) as c FROM information_items WHERE title_zh IS NOT NULL AND title_zh != ''
    `).get();
    const totalTranslated = translatedRow.c;

    if (totalPending === 0 && !force) {
      return sendJSON(res, 200, {
        status: 'complete',
        translated: 0,
        failed: 0,
        total_processed: 0,
        total_pending: 0,
        total_translated: totalTranslated,
        message: 'All items already translated.',
      });
    }

    const result = await translateItems({ batchSize, force, sourceSlug });

    const updatedTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM information_items WHERE title_zh IS NOT NULL AND title_zh != ''
    `).get().c;

    sendJSON(res, 200, {
      status: 'ok',
      batch_size: batchSize,
      all,
      force,
      source: sourceSlug || null,
      ...result,
      total_translated: updatedTranslated,
    });
  };

  // --- Translation Status API: GET /api/translate/status ---
  routes['/api/translate/status'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const itemsTotal = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
    const itemsTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM information_items WHERE title_zh IS NOT NULL AND title_zh != ''
    `).get().c;
    const itemsPending = itemsTotal - itemsTranslated;

    const summariesTotal = db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c;
    const summariesTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM ai_summaries
      WHERE ai_title_zh IS NOT NULL AND ai_title_zh != ''
        AND one_liner_zh IS NOT NULL AND one_liner_zh != ''
        AND short_summary_zh IS NOT NULL AND short_summary_zh != ''
    `).get().c;
    const summariesPending = summariesTotal - summariesTranslated;

    const sourcesTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM sources WHERE label_zh IS NOT NULL AND label_zh != ''
    `).get().c;
    const sourcesTotal = db.prepare('SELECT COUNT(*) as c FROM sources').get().c;

    const topicsTranslated = db.prepare(`
      SELECT COUNT(*) as c FROM topics WHERE name_zh IS NOT NULL AND name_zh != ''
    `).get().c;
    const topicsTotal = db.prepare('SELECT COUNT(*) as c FROM topics').get().c;

    sendJSON(res, 200, {
      status: 'ok',
      items: { total: itemsTotal, translated: itemsTranslated, pending: itemsPending },
      summaries: { total: summariesTotal, translated: summariesTranslated, pending: summariesPending },
      sources: { translated: sourcesTranslated, total: sourcesTotal },
      topics: { translated: topicsTranslated, total: topicsTotal },
      progress: itemsTotal > 0 ? Math.round((itemsTranslated / itemsTotal) * 100) : 0,
    });
  };

  // --- Topic Timeline API ---
  routes['/api/topics/:slug/timeline'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || '';
    const granularity = parsed.query.granularity || 'day';
    const topic = db.prepare('SELECT id FROM topics WHERE slug = ?').get(slug);
    if (!topic) return sendError(res, 404, 'Topic not found');

    const timeline = getTopicTimeline(topic.id, granularity);
    sendJSON(res, 200, { status: 'ok', timeline, granularity });
  };

  // --- Topic Graph Neighborhood API ---
  routes['/api/topics/:slug/graph'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || '';
    const topic = db.prepare('SELECT id FROM topics WHERE slug = ?').get(slug);
    if (!topic) return sendError(res, 404, 'Topic not found');

    const neighborhood = getTopicGraphNeighborhood(topic.id);
    sendJSON(res, 200, { status: 'ok', ...neighborhood });
  };

  // --- Full Knowledge Graph API ---
  routes['/api/graph/full'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const graph = getFullGraph();
    sendJSON(res, 200, { status: 'ok', ...graph });
  };

  // --- 3D Knowledge Graph (tag aggregation) ---
  routes['/api/kg3d'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const data = getKG3DData(db);
    sendJSON(res, 200, { status: 'ok', nodes: data.nodes, edges: data.edges, tagItems: data.tagItems });
  };

  // --- Tag List API ---
  routes['/api/tags'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const tags = db.prepare(`
      SELECT t.id, t.slug, t.name, t.name as name_zh, t.type,
             COUNT(it.item_id) as item_count
      FROM tags t
      JOIN item_tags it ON it.tag_id = t.id
      WHERE t.type IN ('llm-extracted', 'general')
      GROUP BY t.id
      ORDER BY item_count DESC
      LIMIT 200
    `).all();

    sendJSON(res, 200, { status: 'ok', tags });
  };

  // --- Tag Detail API ---
  routes['/api/tags/:slug'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || '';
    const offset = parseInt(parsed.query.offset || '0', 10) || 0;
    const limit = Math.min(parseInt(parsed.query.limit || '30', 10) || 30, 100);

    const tag = db.prepare(`
      SELECT t.id, t.slug, t.name, t.name as name_zh, t.type,
             COUNT(it.item_id) as item_count
      FROM tags t
      JOIN item_tags it ON it.tag_id = t.id
      WHERE t.slug = ? OR t.name = ?
      GROUP BY t.id
    `).get(slug, slug);

    if (!tag) return sendError(res, 404, 'Tag not found');

    const items = db.prepare(`
      SELECT ii.*, s.label as source_label, s.slug as source_slug,
             ais.ai_title_zh, ais.short_summary_zh, ais.one_liner_zh, ais.confidence
      FROM information_items ii
      JOIN item_tags it ON it.item_id = ii.id
      LEFT JOIN sources s ON s.id = ii.source_id
      LEFT JOIN ai_summaries ais ON ais.item_id = ii.id
      WHERE it.tag_id = ?
      ORDER BY ii.published_at DESC
      LIMIT ? OFFSET ?
    `).all(tag.id, limit, offset);

    const getTopics = db.prepare(`
      SELECT t.slug, t.name, t.name_zh, it.relevance
      FROM item_topics it
      JOIN topics t ON t.id = it.topic_id
      WHERE it.item_id = ?
      ORDER BY it.relevance DESC
      LIMIT 5
    `);
    const getTags = db.prepare(`
      SELECT tg.slug, tg.name, itg.confidence
      FROM item_tags itg
      JOIN tags tg ON tg.id = itg.tag_id
      WHERE itg.item_id = ?
      ORDER BY itg.confidence DESC, tg.name ASC
      LIMIT 8
    `);
    const enrichedItems = items.map(item => {
      try {
        item.source_payload = JSON.parse(item.source_payload || '{}');
        item.normalized_payload = JSON.parse(item.normalized_payload || '{}');
        item.popularity = JSON.parse(item.popularity || '{}');
      } catch {}
      return {
        ...item,
        ai_summary: {
          ai_title_zh: item.ai_title_zh || '',
          short_summary_zh: item.short_summary_zh || '',
          one_liner_zh: item.one_liner_zh || '',
          confidence: item.confidence || null,
        },
        topics: getTopics.all(item.id),
        tags: getTags.all(item.id),
      };
    });

    const conceptRun = db.prepare(`
      SELECT id FROM kg_concept_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC, created_at DESC
      LIMIT 1
    `).get();
    let graph = null;
    const related = db.prepare(`
      SELECT other.name as label_zh, other.slug, COUNT(*) as shared_items
      FROM item_tags a
      JOIN item_tags b ON b.item_id = a.item_id AND b.tag_id != a.tag_id
      JOIN tags other ON other.id = b.tag_id
      WHERE a.tag_id = ?
      GROUP BY other.id
      ORDER BY shared_items DESC, other.name ASC
      LIMIT 12
    `).all(tag.id);
    if (conceptRun?.id) {
      const tagNode = db.prepare(`
        SELECT id, label_zh, description_zh, slug
        FROM kg_concept_nodes
        WHERE run_id = ? AND kind = 'tag' AND source_tag_id = ?
        LIMIT 1
      `).get(conceptRun.id, tag.id);
      if (tagNode?.id) {
        const parents = db.prepare(`
          SELECT p.id, p.kind, p.label_zh, p.slug, e.edge_type, e.confidence, e.weight, e.is_primary
          FROM kg_concept_edges e
          JOIN kg_concept_nodes p ON p.id = e.to_node_id
          WHERE e.run_id = ? AND e.from_node_id = ?
            AND e.edge_type IN ('primary_parent', 'secondary_parent', 'contains')
          ORDER BY e.is_primary DESC, e.confidence DESC, p.kind ASC
        `).all(conceptRun.id, tagNode.id);
        graph = { runId: conceptRun.id, node: tagNode, parents, related };
      }
    }
    if (!graph) {
      graph = {
        runId: conceptRun?.id || null,
        node: { id: tag.id, label_zh: tag.name, slug: tag.slug },
        parents: [],
        related,
      };
    }

    sendJSON(res, 200, { status: 'ok', tag, items: enrichedItems, graph, offset, limit });
  };

  // --- Build Tag Hierarchy (LLM clustering) ---
  routes['/api/tags/build-hierarchy'] = async (req, res, parsed) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    if (req.method !== 'POST') {
      return sendError(res, 405, 'Method not allowed. Use POST to build tag hierarchy.');
    }
    const background = parsed.query.background !== 'false';
    if (background) {
      const jobId = await runJob(JOB_TYPES.BUILD_TAG_HIERARCHY, {});
      return sendJSON(res, 200, { status: 'ok', job_id: jobId, message: 'Tag hierarchy build queued' });
    }
    try {
      const { buildTagHierarchy } = require('../services/tag-hierarchy');
      const result = await buildTagHierarchy();
      sendJSON(res, 200, { status: 'ok', result });
    } catch (err) {
      sendError(res, 500, `Hierarchy build failed: ${err.message}`);
    }
  };

  // --- Domains API ---
  routes['/api/domains'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const domains = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM tag_hierarchy th WHERE th.domain_id = d.id AND th.level = 1) as topic_count,
        (SELECT COUNT(*) FROM tag_hierarchy th WHERE th.domain_id = d.id AND th.level = 3) as tag_count
      FROM knowledge_domains d
      ORDER BY d.display_order
    `).all();
    sendJSON(res, 200, { status: 'ok', domains });
  };

  // --- Build Topic Graph (trigger) ---
  routes['/api/topics/build'] = async (req, res, parsed) => {
    const date = parsed.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const background = parsed.query.background !== 'false';
    const deep = parsed.query.deep === 'true' || parsed.query.deep === '1';

    if (background) {
      const jobId = await runJob(JOB_TYPES.BUILD_TOPIC_GRAPH, { date, deep });
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: `Topic graph build queued for ${date}` });
    } else {
      try {
        const { buildTopicGraph } = require('../services/topic-graph');
        const result = await buildTopicGraph(date, { deep });
        sendJSON(res, 200, { status: 'ok', result, date });
      } catch (err) {
        sendError(res, 500, `Topic graph build failed: ${err.message}`);
      }
    }
  };

  // --- Topic Deep Research (§9.2): POST /api/topics/:slug/research ---
  routes['/api/topics/:slug/research'] = async (req, res, _parsed, params) => {
    const slug = params?.slug || '';
    if (!slug) return sendError(res, 400, 'Topic slug required');
    try {
      const result = await generateTopicResearch(slug);
      if (!result) return sendError(res, 404, 'Topic not found or LLM unavailable');
      if (result.error) return sendError(res, 500, result.error);
      sendJSON(res, 200, { status: 'ok', report_id: result.id, topic: result.topic });
    } catch (err) {
      sendError(res, 500, `Topic research failed: ${err.message}`);
    }
  };

  // --- X Following Config: GET / PUT ---
  const { readXFollowingConfig, writeXFollowingConfig, getBlocklistArray, writeBlocklist, readBlocklist } = require('../services/x-following-config');

  routes['/api/settings/x-following'] = (req, res, _parsed) => {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && requireAdmin(req, res)) return;
    if (method === 'GET') {
      const cfg = readXFollowingConfig();
      // Also report seed list from env if no file exists
      const envUsers = (process.env.X_FOLLOWING_USERS || '').split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
      return sendJSON(res, 200, {
        status: 'ok',
        config: cfg,
        env_users: envUsers,
        blocklist: getBlocklistArray(),
      });
    }
    if (method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const result = { status: 'ok' };
          if (Array.isArray(data.users)) {
            const saved = writeXFollowingConfig(data.users);
            result.saved = saved.users.length;
            result.path = saved.path;
          }
          if (Array.isArray(data.blocked_users)) {
            const savedBl = writeBlocklist(data.blocked_users);
            result.blocked_saved = savedBl.users.length;
            result.blocklist_path = savedBl.path;
          }
          sendJSON(res, 200, result);
        } catch (err) {
          sendError(res, 400, `Invalid JSON: ${err.message}`);
        }
      });
      return;
    }
    sendError(res, 405, 'Method not allowed');
  };

  // --- X Following Cleanup: POST /api/settings/x-following/cleanup ---
  // Removes signal_scores rows for items whose author is in the blocklist,
  // so blocked content disappears from /signals. information_items are kept
  // for audit/recovery. Returns the number of purged signal scores.
  routes['/api/settings/x-following/cleanup'] = (req, res, _parsed) => {
    if (req.method.toUpperCase() !== 'POST') return sendError(res, 405, 'Method not allowed');
    if (requireAdmin(req, res)) return;
    const blocklist = readBlocklist();
    if (blocklist.size === 0) {
      return sendJSON(res, 200, { status: 'ok', purged: 0, message: 'Blocklist is empty — nothing to clean.' });
    }
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    // Build LIKE patterns for blocked handles stored as '@handle' in author.
    const handles = [...blocklist];
    const purged = db.transaction((hs) => {
      let total = 0;
      for (const h of hs) {
        const likeAuthor = `@${h}%`;
        const r = db.prepare(`
          DELETE FROM signal_scores WHERE item_id IN (
            SELECT id FROM information_items WHERE author LIKE ?
          )
        `).run(likeAuthor);
        total += r.changes;
      }
      return total;
    })(handles);
    console.log(`  🧹 Cleaned ${purged} signal_scores for ${handles.length} blocked handles`);
    sendJSON(res, 200, { status: 'ok', purged, blocked_handles: handles.length });
  };

  // --- X Following Sync: POST /api/x-following/sync?background=true ---
  routes['/api/x-following/sync'] = async (req, res, parsed) => {
    const background = parsed.query.background !== 'false';
    if (background) {
      const jobId = await runJob(JOB_TYPES.X_FOLLOWING_SYNC, {});
      return sendJSON(res, 200, { status: 'ok', job_id: jobId, message: 'X following sync queued' });
    }
    try {
      const { syncXFollowing } = require('../services/x-following');
      const result = await syncXFollowing();
      sendJSON(res, 200, { status: 'ok', result });
    } catch (err) {
      sendError(res, 500, `X sync failed: ${err.message}`);
    }
  };

  // --- LLM Provider Info API ---
  routes['/api/llm'] = (req, res, _parsed) => {
    const info = getProviderInfo();
    sendJSON(res, 200, { status: 'ok', ...info });
  };

  // --- LLM Settings: GET current config / PUT new / DELETE reset ---
  // The current server dispatches by pathname only, so we branch on method.
  routes['/api/settings/llm'] = (req, res, _parsed) => {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && requireAdmin(req, res)) return;

    if (method === 'GET') {
      try {
        const cfg = getLLMConfig() || {};
        const info = getProviderInfo();
        sendJSON(res, 200, {
          status: 'ok',
          config: {
            provider: cfg.provider || '',
            model: cfg.model || info.model || '',
            base_url: cfg.base_url || (info.base_url || ''),
            api_key: maskSecret(cfg.api_key),
            source: cfg.source || 'env',
            updated_at: cfg.updated_at || '',
          },
          active: {
            provider: info.provider,
            model: info.model,
            key_configured: info.key_configured,
            base_url: info.base_url || (cfg.provider === 'openai' ? (cfg.base_url || process.env.OPENAI_BASE_URL || '') : ''),
          },
        });
      } catch (err) {
        sendError(res, 500, `Failed to read LLM settings: ${err.message}`);
      }
      return;
    }

    if (method === 'PUT' || method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
      req.on('end', () => {
        let payload;
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          return sendError(res, 400, 'Invalid JSON body');
        }

        try {
          let next = null;
          if (typeof payload.pasted === 'string' && payload.pasted.trim()) {
            const parsed = parsePastedLLMConfig(payload.pasted);
            if (parsed.error) return sendError(res, 400, parsed.error);
            next = parsed;
          } else if (payload.config && typeof payload.config === 'object') {
            const { provider, api_key, base_url, model } = payload.config;
            if (!provider) return sendError(res, 400, 'provider required');
            if (!api_key) return sendError(res, 400, 'api_key required');
            if (!base_url) return sendError(res, 400, 'base_url required');
            if (!model) return sendError(res, 400, 'model required');
            next = { provider, api_key, base_url, model };
          } else {
            return sendError(res, 400, 'Provide either { pasted: "..." } or { config: { provider, api_key, base_url, model } }');
          }

          next.source = payload.config?.source || (payload.pasted ? 'user-pasted' : 'manual');
          saveLLMConfig(next);

          sendJSON(res, 200, {
            status: 'ok',
            message: 'LLM config saved. Provider reloaded.',
            config: {
              ...next,
              api_key: maskSecret(next.api_key),
            },
            active: getProviderInfo(),
          });
        } catch (err) {
          sendError(res, 500, `Failed to save LLM settings: ${err.message}`);
        }
      });
      return;
    }

    if (method === 'DELETE') {
      try {
        clearLLMConfig();
        sendJSON(res, 200, { status: 'ok', message: 'LLM config reset to .env defaults.', active: getProviderInfo() });
      } catch (err) {
        sendError(res, 500, `Failed to reset: ${err.message}`);
      }
      return;
    }

    sendError(res, 405, 'Method not allowed');
  };

  // --- LLM Settings: POST /api/settings/llm/test — ping the endpoint ---
  routes['/api/settings/llm/test'] = async (req, res, _parsed) => {
    try {
      const result = await testLLMConfig();
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      sendError(res, 500, `LLM test failed: ${err.message}`);
    }
  };

  // --- LLM Settings: POST /api/settings/llm/parse — dry-run parse, no save ---
  routes['/api/settings/llm/parse'] = (req, res, _parsed) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
    req.on('end', () => {
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        return sendError(res, 400, 'Invalid JSON body');
      }
      const text = (payload.pasted || '').toString();
      if (!text.trim()) return sendError(res, 400, 'pasted text required');
      const result = parsePastedLLMConfig(text);
      if (result.error) {
        sendJSON(res, 200, { status: 'parse_error', error: result.error });
        return;
      }
      sendJSON(res, 200, {
        status: 'ok',
        ...result,
        masked: { ...result, api_key: maskSecret(result.api_key || '') },
      });
    });
  };

  // ────────────────────────────────────────────────────────────────────────
  // §13: Missing API Endpoints
  // ────────────────────────────────────────────────────────────────────────

  // --- Single Item API (§13: GET /api/items/:id) ---
  routes['/api/items/:id'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const itemId = params?.id || '';
    const item = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      WHERE i.id = ?
    `).get(itemId);

    if (!item) return sendError(res, 404, 'Item not found');

    try {
      item.source_payload = JSON.parse(item.source_payload || '{}');
      item.normalized_payload = JSON.parse(item.normalized_payload || '{}');
      item.popularity = JSON.parse(item.popularity || '{}');
    } catch {}

    // Get summary
    const summary = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?').get(itemId);

    // Get topics
    const topics = db.prepare(`
      SELECT t.slug, t.name, it.relevance FROM item_topics it
      JOIN topics t ON it.topic_id = t.id
      WHERE it.item_id = ? ORDER BY it.relevance DESC
    `).all(itemId);

    // Get tags
    const tags = db.prepare(`
      SELECT tg.slug, tg.name, itg.confidence FROM item_tags itg
      JOIN tags tg ON itg.tag_id = tg.id
      WHERE itg.item_id = ?
    `).all(itemId);

    // Get deploy eligibility
    const deployInfo = checkDeployEligibility(itemId);

    sendJSON(res, 200, {
      status: 'ok',
      item: { ...item, ai_summary: summary, topics, tags },
      deploy: deployInfo,
    });
  };

  // --- Item Summary API (§13: GET /api/items/:id/summary) ---
  routes['/api/items/:id/summary'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const itemId = params?.id || '';
    const summary = db.prepare('SELECT * FROM ai_summaries WHERE item_id = ?').get(itemId);
    if (!summary) return sendError(res, 404, 'Summary not found for this item');

    sendJSON(res, 200, { status: 'ok', summary });
  };

  // --- Trigger Research API (§13: POST /api/items/:id/research) ---
  routes['/api/items/:id/research'] = async (req, res, _parsed, params) => {
    const itemId = params?.id || '';
    if (!itemId) return sendError(res, 400, 'Item ID required');
    const force = _parsed?.query?.force === 'true' || _parsed?.query?.force === '1';

    // Check for existing completed research
    const db = getDB();
    const existing = !force
      ? db?.prepare('SELECT * FROM research_reports WHERE item_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(itemId, 'completed')
      : null;
    if (existing) {
      return sendJSON(res, 200, { status: 'ok', report: existing, cached: true });
    }

    // Generate new research
    try {
      const result = await generateItemResearch(itemId);
      if (result.error) return sendError(res, 500, result.error);
      const report = getResearchReport(result.id);
      sendJSON(res, 200, { status: 'ok', report, cached: false });
    } catch (err) {
      sendError(res, 500, `Research failed: ${err.message}`);
    }
  };

  // --- Research Chat API (§13: POST /api/items/:id/research/chat) ---
  routes['/api/items/:id/research/chat'] = (req, res, _parsed, params) => {
    const itemId = params?.id || '';
    if (!itemId) return sendError(res, 400, 'Item ID required');

    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1048576) req.destroy(); });
    req.on('end', async () => {
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        return sendError(res, 400, 'Invalid JSON body');
      }

      try {
        const result = await answerItemResearchChat(itemId, payload.message, payload.history || []);
        if (result?.error) return sendError(res, 400, result.error);
        sendJSON(res, 200, { status: 'ok', ...result });
      } catch (err) {
        sendError(res, 500, `Research chat failed: ${err.message}`);
      }
    });
  };

  // --- Get Research Report API (§13: GET /api/research/:id) ---
  routes['/api/research/:id'] = (req, res, _parsed, params) => {
    const reportId = params?.id || '';
    if (!reportId) return sendError(res, 400, 'Report ID required');

    const report = getResearchReport(reportId);
    if (!report) return sendError(res, 404, 'Report not found');

    sendJSON(res, 200, { status: 'ok', report });
  };

  // --- Research Reports list: GET /api/reports ---
  routes['/api/reports'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const limit = Math.min(parseInt(parsed.query.limit || '50', 10), 200);
    const status = parsed.query.status || '';
    const statusFilter = status ? `WHERE status = ?` : '';
    const reports = db.prepare(`
      SELECT id, item_id, status, model_name, created_at, completed_at,
             substr(report_markdown, 1, 200) AS excerpt, error
      FROM research_reports
      ${statusFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...(status ? [status] : []), limit);
    sendJSON(res, 200, { status: 'ok', reports, total: reports.length });
  };

  // --- Trigger Deployment Plan API (§13: POST /api/items/:id/deployment-plan) ---
  routes['/api/items/:id/deployment-plan'] = async (req, res, _parsed, params) => {
    const itemId = params?.id || '';
    if (!itemId) return sendError(res, 400, 'Item ID required');

    try {
      const result = await generateDeployPlan(itemId);
      if (result.error) return sendError(res, 500, result.error);
      sendJSON(res, 200, { status: 'ok', plan_id: result.id, eligibility: result.eligibility, plan: result.plan });
    } catch (err) {
      sendError(res, 500, `Deploy plan failed: ${err.message}`);
    }
  };

  // --- Source Feed API (§13: GET /api/feed/:source) ---
  routes['/api/feed/:source'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const sourceSlug = params?.source || '';
    const source = db.prepare('SELECT * FROM sources WHERE slug = ?').get(sourceSlug);
    if (!source) return sendError(res, 404, 'Source not found');

    const format = parsed.query.format || 'json';
    const limit = parseInt(parsed.query.limit || '20', 10);

    const items = db.prepare(`
      SELECT i.*, s.label as source_label
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      WHERE s.slug = ?
      ORDER BY i.published_at DESC
      LIMIT ?
    `).all(sourceSlug, limit);

    if (format === 'xml' || format === 'atom') {
      // Return Atom XML feed
      let atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXML(source.label)} — Eagleye</title>
  <link href="/feed/${sourceSlug}"/>
  <link rel="self" href="/feed/${sourceSlug}?format=atom"/>
  <updated>${escapeXML(new Date().toISOString())}</updated>
  <id>urn:eagleye:source:${escapeXML(sourceSlug)}</id>`;
      for (const item of items) {
        atom += `
  <entry>
    <id>${escapeXML(item.canonical_url || item.id)}</id>
    <title>${escapeXML(item.title)}</title>
    <link href="${escapeXML(item.canonical_url || '')}"/>
    <updated>${escapeXML(item.published_at || item.created_at)}</updated>
    <summary>${escapeXML(item.original_summary || '')}</summary>
  </entry>`;
      }
      atom += '\n</feed>';
      res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
      res.end(atom);
    } else {
      // Return JSON
      sendJSON(res, 200, { status: 'ok', source, items, total: items.length });
    }
  };

  // --- Topic Feed API (§13: GET /api/topics/:slug/feed.xml) ---
  routes['/api/topics/:slug/feed.xml'] = (req, res, _parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const slug = params?.slug || '';
    const topic = db.prepare('SELECT * FROM topics WHERE slug = ?').get(slug);
    if (!topic) return sendError(res, 404, 'Topic not found');

    const items = db.prepare(`
      SELECT i.*, s.label as source_label
      FROM information_items i
      JOIN item_topics it ON i.id = it.item_id
      JOIN sources s ON i.source_id = s.id
      WHERE it.topic_id = ?
      ORDER BY i.published_at DESC
      LIMIT 20
    `).all(topic.id);

    const summaries = db.prepare('SELECT item_id, one_liner, short_summary FROM ai_summaries');
    const summaryMap = {};
    summaries.all().forEach(s => { summaryMap[s.item_id] = s; });

    let atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXML(topic.name)} — Eagleye Topics</title>
  <link href="/topics/${escapeXML(slug)}"/>
  <link rel="self" href="/topics/${escapeXML(slug)}/feed.xml"/>
  <updated>${escapeXML(new Date().toISOString())}</updated>
  <id>urn:eagleye:topic:${escapeXML(slug)}</id>`;

    for (const item of items) {
      const summary = summaryMap[item.id] || {};
      atom += `
  <entry>
    <id>${escapeXML(item.canonical_url || item.id)}</id>
    <title>${escapeXML(item.title)}</title>
    <link href="${escapeXML(item.canonical_url || '')}"/>
    <published>${escapeXML(item.published_at || item.created_at)}</published>
    <updated>${escapeXML(item.published_at || item.created_at)}</updated>
    <summary type="text">${escapeXML(summary.one_liner || summary.short_summary || '')}</summary>
    <category term="${escapeXML(topic.slug)}"/>
  </entry>`;
    }
    atom += '\n</feed>';

    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    res.end(atom);
  };

  // --- Fetch Source Job API (§13: POST /api/jobs/fetch-source) ---
  routes['/api/jobs/fetch-source'] = async (req, res, parsed) => {
    const slug = parsed.query.slug || '';
    const date = parsed.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (!slug) return sendError(res, 400, 'Source slug required');

    try {
      const jobId = await runJob(JOB_TYPES.FETCH_SOURCE, { slug, date });
      sendJSON(res, 200, { status: 'ok', job_id: jobId, message: `Fetch queued for ${slug}` });
    } catch (err) {
      sendError(res, 500, `Failed to queue fetch: ${err.message}`);
    }
  };

  // --- Skills API (§13: GET /api/skills) ---
  routes['/api/skills'] = (req, res, parsed) => {
    const options = {
      category: parsed.query.category || '',
      search: parsed.query.search || '',
      sort: parsed.query.sort || 'installs',
      source: parsed.query.source || '',
      tag: parsed.query.tag || '',
      limit: parsed.query.limit || '50',
      offset: parsed.query.offset || '0',
    };

    const result = getSkills(options);
    const stats = getSkillStats();

    sendJSON(res, 200, { status: 'ok', ...result, stats });
  };

  // --- Single Skill API (§13: GET /api/skills/:id) ---
  routes['/api/skills/:id'] = (req, res, _parsed, params) => {
    const skillId = params?.id || '';
    const skill = getSkillById(skillId);
    if (!skill) return sendError(res, 404, 'Skill not found');
    sendJSON(res, 200, { status: 'ok', skill });
  };

  // --- Save Item API ---
  routes['/api/items/:id/save'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const itemId = params?.id || '';
    const note = parsed.query.note || '';

    if (!itemId) return sendError(res, 400, 'Item ID required');

    // Check if already saved
    const userId = req.user.id;
    const existing = db.prepare('SELECT * FROM saved_items WHERE user_id = ? AND item_id = ?').get(userId, itemId);
    if (existing) {
      // Unsave if already saved
      db.prepare('DELETE FROM saved_items WHERE user_id = ? AND item_id = ?').run(userId, itemId);
      // A save/unsave changes the user interest profile — invalidate the
      // relevance cache so For-You picks up the new signal immediately.
      try { require('../services/relevance').invalidateProfile(userId); } catch { /* relevance absent */ }
      return sendJSON(res, 200, { status: 'ok', saved: false, message: 'Item unsaved' });
    }

    db.prepare('INSERT OR IGNORE INTO saved_items (user_id, item_id, note) VALUES (?, ?, ?)')
      .run(userId, itemId, note);
    try { require('../services/relevance').invalidateProfile(userId); } catch { /* relevance absent */ }
    sendJSON(res, 200, { status: 'ok', saved: true, message: 'Item saved' });
  };

  // --- Get Saved Items API ---
  routes['/api/saved'] = (req, res, _parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const items = db.prepare(`
      SELECT i.*, s.label as source_label, s.slug as source_slug, sv.note, sv.created_at as saved_at
      FROM saved_items sv
      JOIN information_items i ON sv.item_id = i.id
      JOIN sources s ON i.source_id = s.id
      WHERE sv.user_id = ?
      ORDER BY sv.created_at DESC
      LIMIT 100
    `).all(req.user.id);

    sendJSON(res, 200, { status: 'ok', items, total: items.length });
  };

  // --- Signal Types API ---
  routes['/api/signal-types'] = (req, res, _parsed) => {
    const types = getSignalTypes();
    sendJSON(res, 200, { status: 'ok', types });
  };

  // --- Personal filter (Batch B6) ---
  // POST /api/items/:id/seen   → mark item seen (idempotent), invalidate profile
  // GET  /api/profile          → derived user interest profile
  // GET  /api/for-you          → personalised feed (alpha × relevance, unseen-first)
  routes['/api/items/:id/seen'] = (req, res, _parsed, params) => {
    const relevance = require('../services/relevance');
    const itemId = params?.id || '';
    if (!itemId) return sendError(res, 400, 'Item ID required');
    relevance.markSeen(itemId, req.user.id);
    sendJSON(res, 200, { status: 'ok', seen: true });
  };

  // POST /api/seen/batch — mark multiple items as seen ("mark all as read")
  routes['/api/seen/batch'] = (req, res) => {
    const relevance = require('../services/relevance');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 32768) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const ids = Array.isArray(data.item_ids) ? data.item_ids : [];
        const count = relevance.markManySeen(ids, req.user.id);
        sendJSON(res, 200, { status: 'ok', marked: count });
      } catch (err) {
        sendError(res, 400, 'Invalid JSON: ' + err.message);
      }
    });
  };

  routes['/api/profile'] = (req, res) => {
    const relevance = require('../services/relevance');
    const profile = relevance.getCachedProfile(req.user.id);
    // Project entities Set → array for JSON.
    sendJSON(res, 200, {
      status: 'ok',
      profile: {
        types: profile.types,
        entities: [...profile.entities],
        sources: profile.sources,
        has_signal: profile.has_signal,
      },
    });
  };

  routes['/api/for-you'] = (req, res, parsed) => {
    const relevance = require('../services/relevance');
    const result = relevance.getForYou({
      sinceDays: parseInt(parsed.query.sinceDays || '3', 10),
      limit: Math.min(parseInt(parsed.query.limit || '60', 10), 200),
      userId: req.user.id,
    });
    sendJSON(res, 200, { status: 'ok', ...result });
  };

  // --- Signals API ---
  // ?audience=developer|researcher|investor re-ranks by that lens (Phase 2):
  // the base alpha_score is preserved as alpha_score_base and a reweighted
  // alpha_score_audience is returned + used for ORDER BY.
  routes['/api/signals'] = (req, res, parsed) => {
    const signalType = parsed.query.type || 'all';
    const date = parsed.query.date || '';
    const sinceDays = parsed.query.sinceDays ? parseInt(parsed.query.sinceDays, 10) : null;
    const sortBy = parsed.query.sort || 'alpha_score';
    const audience = parsed.query.audience || '';
    const limit = parseInt(parsed.query.limit || '50', 10);
    const offset = parseInt(parsed.query.offset || '0', 10);
    // ?lens=mine (PRD-5): apply the user's saved personal lens to re-rank. The
    // lens takes precedence over any audience param — the user's explicit choice
    // wins over a preset. Invalid/empty lens degrades to the audience path.
    let lens = null;
    if (parsed.query.lens === 'mine') {
      lens = (getValue('personal_lens', req.user.id) || {}).types || null;
    }

    const signals = getSignals({ signalType, date, sinceDays, sortBy, audience, limit, offset, lens });
    sendJSON(res, 200, { status: 'ok', signals, audience: audience || null, lens_active: !!lens });
  };

  // --- Personal Alpha Lens (PRD-5): user-defined signal-type weighting ---
  // GET  /api/lens       → { lens: { types: {...} } | null }
  // POST /api/lens       body { types: {<signal_type>: <0.5-1.5>} } → save
  // DELETE /api/lens     → clear (revert to audience/preset ranking)
  const handleLens = (req, res) => {
    if (req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', lens: getValue('personal_lens', req.user.id) || null });
    }
    if (req.method === 'DELETE') {
      setValue('personal_lens', null, req.user.id);
      return sendJSON(res, 200, { status: 'ok', cleared: true });
    }
    // POST: parse body
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const types = data.types || data;
        if (!types || typeof types !== 'object') {
          return sendError(res, 400, 'Expected { types: { signal_type: multiplier } }');
        }
        // Validate against the canonical signal type set + clamp multipliers.
        const validTypes = new Set(getSignalTypes().map(t => t.slug));
        const cleaned = {};
        for (const [k, v] of Object.entries(types)) {
          if (validTypes.has(k) && Number.isFinite(Number(v))) {
            cleaned[k] = Math.max(0.5, Math.min(1.5, Number(v)));
          }
        }
        setValue('personal_lens', { types: cleaned, updated_at: new Date().toISOString() }, req.user.id);
        sendJSON(res, 200, { status: 'ok', lens: { types: cleaned } });
      } catch (err) {
        sendError(res, 400, 'Invalid JSON: ' + err.message);
      }
    });
  };
  routes['/api/lens'] = handleLens;

  // --- Radar audiences: weight definitions for the /signals lens switcher ---
  routes['/api/radar/audiences'] = (req, res, _parsed) => {
    sendJSON(res, 200, { status: 'ok', audiences: getRadarAudiences() });
  };

  // --- Today's Top Signals ---
  routes['/api/signals/today'] = (req, res, parsed) => {
    const limit = parseInt(parsed.query.limit || '50', 10);
    const result = getTodaySignals(limit);
    sendJSON(res, 200, { status: 'ok', ...result });
  };

  // --- Rescore Signals: POST /api/signals/rescore[?all=true][&date=YYYYMMDD][&limit=500]
  //   ?all=true           → RESCORE_ALL: re-classify the FULL corpus (all
  //                         digest_dates), filling the backlog the daily
  //                         pipeline leaves behind. Long-running; singleton job.
  //   ?date=YYYYMMDD      → SCORE_SIGNALS: re-classify one date only (default today).
  //   ?limit=N            → cap per-date item count (single-date mode only).
  routes['/api/signals/rescore'] = async (req, res, parsed) => {
    const all = parsed.query.all === 'true' || parsed.query.all === '1';
    if (all) {
      const jobId = await runJob(JOB_TYPES.RESCORE_ALL, { concurrency: parseInt(parsed.query.concurrency || '0', 10) || undefined });
      return sendJSON(res, 200, {
        status: 'ok',
        job_id: jobId,
        mode: 'rescore-all',
        message: `Full-corpus rescore queued. Poll /api/jobs/${jobId}.`,
      });
    }
    const date = parsed.query.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const limit = parseInt(parsed.query.limit || '500', 10);
    const jobId = await runJob(JOB_TYPES.SCORE_SIGNALS, { date, limit });
    sendJSON(res, 200, {
      status: 'ok',
      job_id: jobId,
      mode: 'score-date',
      message: `Signal rescore queued for ${date} (up to ${limit} items). Poll /api/jobs/${jobId}.`,
    });
  };

  // --- Entity Momentum Leaderboard ---
  // ?sort=zscore|acceleration|growth|burst — Phase 1/2 ranking lens.
  routes['/api/entities/momentum'] = (req, res, parsed) => {
    const window = parsed.query.window || '7d';
    const sort = parsed.query.sort || 'zscore';
    const limit = Math.min(parseInt(parsed.query.limit || '20', 10), 100);
    const entities = getEntityMomentum(window, limit, sort);
    sendJSON(res, 200, { status: 'ok', window, sort, entities });
  };

  // --- Entity detail (Phase 3.C): JSON for an entity + its recent items ---
  routes['/api/entities/:slug'] = (req, res, parsed, params) => {
    const slug = params?.slug || '';
    const limit = Math.min(parseInt(parsed.query.limit || '20', 10), 100);
    const data = getEntityItems(slug, limit);
    if (!data) return sendError(res, 404, 'Entity not found');
    sendJSON(res, 200, { status: 'ok', ...data });
  };

  // --- Entity 30-day trajectory series (PRD-1): sparkline + burst highlight ---
  routes['/api/entities/:slug/series'] = (req, res, _parsed, params) => {
    const slug = params?.slug || '';
    const data = getEntitySeries(slug);
    if (!data) return sendError(res, 404, 'Entity not found');
    sendJSON(res, 200, { status: 'ok', ...data });
  };

  // --- Compare multiple entity trajectories (PRD-1 extension) ---
  // GET /api/entities/compare?slugs=slug1,slug2,slug3
  routes['/api/entities/compare'] = (req, res, parsed) => {
    const slugs = (parsed.query.slugs || '').split(',').map(s => s.trim()).filter(Boolean);
    if (slugs.length < 2) return sendError(res, 400, 'Provide at least 2 slugs (comma-separated)');
    const data = compareEntitySeries(slugs);
    sendJSON(res, 200, { status: 'ok', ...data });
  };

  // --- Entity co-occurrence matrix: which entities appear together ---
  routes['/api/entities/cooccurrence'] = (req, res, parsed) => {
    const limit = Math.min(parseInt(parsed.query.limit || '20', 10), 100);
    const pairs = getEntityCoOccurrence(limit);
    sendJSON(res, 200, { status: 'ok', pairs, total: pairs.length });
  };

  // --- Entity Atom feed (Phase 3.C): subscribe to a rising entity ---
  routes['/api/entities/:slug/feed.xml'] = (req, res, _parsed, params) => {
    const slug = params?.slug || '';
    const data = getEntityItems(slug, 20);
    if (!data) return sendError(res, 404, 'Entity not found');
    const { entity, items } = data;

    let atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXML(entity.canonical_name)} — Eagleye Entity</title>
  <link href="/entities/${escapeXML(slug)}"/>
  <link rel="self" href="/api/entities/${escapeXML(slug)}/feed.xml"/>
  <updated>${escapeXML(new Date().toISOString())}</updated>
  <id>urn:eagleye:entity:${escapeXML(slug)}</id>`;

    for (const item of items) {
      atom += `
  <entry>
    <id>${escapeXML(item.canonical_url || item.id)}</id>
    <title>${escapeXML(item.title)}</title>
    <link href="${escapeXML(item.canonical_url || '')}"/>
    <published>${escapeXML(item.published_at || '')}</published>
    <updated>${escapeXML(item.published_at || '')}</updated>
    <summary type="text">${escapeXML(item.one_liner || item.short_summary || '')}</summary>
    <category term="${escapeXML(entity.entity_type || '')}"/>
  </entry>`;
    }
    atom += '\n</feed>';

    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    res.end(atom);
  };

  // --- Single Signal Detail ---
  routes['/api/signals/:id'] = (req, res, _parsed, params) => {
    const itemId = params?.id || '';
    const signal = getSignalById(itemId);
    if (!signal) return sendError(res, 404, 'Signal not found');
    sendJSON(res, 200, { status: 'ok', signal });
  };

  // --- Industry Metrics: pure aggregation for the dashboard (no new tables) ---
  routes['/api/metrics/industry'] = (_req, res) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');

    const since30 = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().slice(0, 10).replace(/-/g, '');
    })();

    const corpus = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM information_items) AS items,
        (SELECT COUNT(*) FROM signal_scores) AS scored,
        (SELECT COUNT(*) FROM ai_summaries) AS summaries,
        (SELECT COUNT(*) FROM research_reports) AS reports,
        (SELECT COUNT(*) FROM signal_types) AS signalTypes,
        (SELECT COUNT(*) FROM canonical_entities) AS entities
    `).get();

    // Source diversity: per-source 30d item volume + source_profiles trust/noise.
    const sources = db.prepare(`
      SELECT s.label,
        (SELECT COUNT(*) FROM information_items i WHERE i.source_id = s.id AND i.digest_date >= ?) AS items_30d,
        sp.source_type AS trust, sp.noise_rate
      FROM sources s
      LEFT JOIN source_profiles sp ON sp.source_slug = s.slug
      WHERE s.is_active = 1
      ORDER BY items_30d DESC
      LIMIT 20
    `).all(since30);

    // Signal-type distribution over the trailing 30 days.
    const signalTypes = db.prepare(`
      SELECT COALESCE(ss.signal_type, 'uncategorized') AS type,
             COUNT(*) AS count
      FROM signal_scores ss
      JOIN information_items i ON i.id = ss.item_id
      WHERE i.digest_date >= ?
      GROUP BY type
      ORDER BY count DESC
    `).all(since30).map(r => ({
      type: r.type,
      label: r.type === 'uncategorized' ? 'uncategorized' : r.type.replace(/_/g, ' '),
      count: r.count,
    }));

    const kg = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM item_features) AS features,
        (SELECT COUNT(*) FROM kg_tags) AS tags,
        (SELECT COUNT(*) FROM dynamic_topics) AS topics
    `).get();

    sendJSON(res, 200, { status: 'ok', corpus, sources, signalTypes, kg });
  };

  // --- Stories: cross-source clusters of the same event (PRD-3) ---
  // GET /api/stories[?date=YYYYMMDD][&sinceDays=N][&limit=100]
  // Returns clusters of items that describe the same story across sources,
  // ranked cross-source-first. Pure query-time aggregation (no writes).
  routes['/api/stories'] = (req, res, parsed) => {
    const { getStories } = require('../services/story-clusters');
    const stories = getStories({
      date: parsed.query.date || '',
      sinceDays: parseInt(parsed.query.sinceDays || '7', 10),
      limit: Math.min(parseInt(parsed.query.limit || '100', 10), 500),
    });
    sendJSON(res, 200, {
      status: 'ok',
      stories,
      total: stories.length,
      cross_source_count: stories.filter(s => s.cross_source).length,
    });
  };

  // --- Watchlist (PRD-4): subscribe to entities / signal types ---
  // GET  /api/watchlist        → { subs }
  // GET  /api/watchlist/feed   → aggregated items matching any subscription
  // POST /api/watchlist        body {kind, value, label, add?} → toggle
  routes['/api/watchlist'] = (req, res, parsed) => {
    const wl = require('../services/watchlist');
    if (req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', ...wl.getAll(req.user.id) });
    }
    // POST: parse body
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const add = data.add === true ? true : data.add === false ? false : undefined;
        const result = wl.toggle(data.kind, data.value, data.label, add, req.user.id);
        sendJSON(res, 200, { status: 'ok', subs: result.subs, added: result.added });
      } catch (err) {
        sendError(res, 400, err.message);
      }
    });
  };

  routes['/api/watchlist/feed'] = (req, res, parsed) => {
    const wl = require('../services/watchlist');
    const items = wl.getFeed({
      sinceDays: parseInt(parsed.query.sinceDays || '7', 10),
      limit: Math.min(parseInt(parsed.query.limit || '100', 10), 500),
      userId: req.user.id,
    });
    sendJSON(res, 200, { status: 'ok', items, total: items.length });
  };

  // --- Watchlist Atom feed: subscribe to all watched entities/types in one feed ---
  routes['/api/watchlist/feed.xml'] = (req, res, parsed) => {
    const wl = require('../services/watchlist');
    // A watchlist is personal data. Unlike the topic/entity/source feeds, which
    // publish already-public aggregate content, this one names what one account
    // chose to track, so it requires that account.
    const owner = resolveFeedUser(req, parsed);
    if (!owner) return sendError(res, 401, 'Authentication required (use ?key=<api key> for RSS readers)');
    const items = wl.getFeed({ sinceDays: 7, limit: 50, userId: owner.id });
    let atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Eagleye Watchlist</title>
  <link href="/watchlist"/>
  <link rel="self" href="/api/watchlist/feed.xml"/>
  <updated>${escapeXML(new Date().toISOString())}</updated>
  <id>urn:eagleye:watchlist</id>`;
    for (const item of items) {
      atom += `
  <entry>
    <id>${escapeXML(item.canonical_url || item.id)}</id>
    <title>${escapeXML(item.title)}</title>
    <link href="${escapeXML(item.canonical_url || '')}"/>
    <published>${escapeXML(item.published_at || '')}</published>
    <updated>${escapeXML(item.published_at || '')}</updated>
    <summary>${escapeXML((item.signal_type || '') + ' — ' + (item.source_label || ''))}</summary>
  </entry>`;
    }
    atom += '\n</feed>';
    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    res.end(atom);
  };

  // --- Scheduler: read/update the built-in daily pipeline schedule ---
  // GET  → current config ({enabled, time, task, lastRun})
  // PUT  → update {enabled?, time?, task?} (validated, persisted to user_data)
  // POST → same as PUT (some clients prefer POST for state changes)
  const handleScheduler = (req, res, _parsed, _params) => {
    const scheduler = require('../services/scheduler');
    if (req.method === 'GET') {
      return sendJSON(res, 200, { status: 'ok', config: scheduler.getConfig() });
    }
    if (requireAdmin(req, res)) return;
    // PUT / POST: parse body
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const patch = {};
        if (typeof data.enabled === 'boolean') patch.enabled = data.enabled;
        if (typeof data.time === 'string') {
          if (!/^\d{1,2}:\d{2}$/.test(data.time)) {
            return sendError(res, 400, 'Invalid time (use HH:MM)');
          }
          const [h, m] = data.time.split(':').map(Number);
          if (h < 0 || h > 23 || m < 0 || m > 59) {
            return sendError(res, 400, 'Invalid time (use HH:MM)');
          }
          patch.time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
        if (data.task === 'pipeline' || data.task === 'rescore') patch.task = data.task;
        const next = scheduler.saveConfig(patch);
        sendJSON(res, 200, { status: 'ok', config: next });
      } catch (err) {
        sendError(res, 400, 'Invalid JSON: ' + err.message);
      }
    });
  };
  routes['/api/scheduler'] = handleScheduler;

  // --- By Year archive (§7.8) ---
  // GET /api/year          → list of years with item counts
  // GET /api/year/:year    → year detail: by-month, by-source, top topics, top items
  routes['/api/year'] = (_req, res) => {
    const cached = cacheGet('year:list');
    if (cached) return sendJSON(res, 200, cached);
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const years = db.prepare(`
      SELECT substr(digest_date, 1, 4) AS year, COUNT(*) AS items,
             COUNT(DISTINCT source_id) AS sources,
             COUNT(DISTINCT ss.item_id) AS scored
      FROM information_items i
      LEFT JOIN signal_scores ss ON ss.item_id = i.id
      GROUP BY year ORDER BY year DESC
    `).all();
    const data = { status: 'ok', years };
    cacheSet('year:list', data, 5 * 60 * 1000); // 5min — year list rarely changes
    sendJSON(res, 200, data);
  };

  routes['/api/year/:year'] = (req, res, parsed, params) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const year = String(params?.year || '').replace(/[^0-9]/g, '').slice(0, 4);
    if (!year) return sendError(res, 400, 'Year required');
    const from = year + '0101';
    const to = year + '1231';

    const byMonth = db.prepare(`
      SELECT substr(digest_date, 5, 2) AS month, COUNT(*) AS items
      FROM information_items WHERE digest_date >= ? AND digest_date <= ?
      GROUP BY month ORDER BY month
    `).all(from, to);

    const bySource = db.prepare(`
      SELECT s.slug, s.label, COUNT(*) AS items,
             SUM(CASE WHEN ss.alpha_score >= 0.7 THEN 1 ELSE 0 END) AS high_alpha
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      LEFT JOIN signal_scores ss ON ss.item_id = i.id
      WHERE i.digest_date >= ? AND i.digest_date <= ?
      GROUP BY s.id ORDER BY items DESC LIMIT 20
    `).all(from, to);

    // Top signal types
    const topTypes = db.prepare(`
      SELECT ss.signal_type, COUNT(*) AS count
      FROM signal_scores ss
      JOIN information_items i ON i.id = ss.item_id
      WHERE i.digest_date >= ? AND i.digest_date <= ? AND ss.signal_type != 'uncategorized'
      GROUP BY ss.signal_type ORDER BY count DESC LIMIT 10
    `).all(from, to);

    // Top items by alpha
    const topItems = db.prepare(`
      SELECT i.id, i.title, i.canonical_url, i.digest_date,
             s.label AS source_label, ss.alpha_score, ss.signal_type
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      JOIN signal_scores ss ON ss.item_id = i.id
      WHERE i.digest_date >= ? AND i.digest_date <= ?
      ORDER BY ss.alpha_score DESC LIMIT 20
    `).all(from, to);

    const total = bySource.reduce((s, r) => s + r.items, 0);
    sendJSON(res, 200, {
      status: 'ok',
      year,
      total,
      by_month: byMonth,
      by_source: bySource,
      top_types: topTypes,
      top_items: topItems,
    });
  };

  // --- Compare (§7.9) ---
  // GET /api/compare           → feature matrix + persona matrix
  // GET /api/compare/:competitor → side-by-side comparison data
  routes['/api/compare'] = (_req, res) => {
    const cached = cacheGet('compare:matrix');
    if (cached) return sendJSON(res, 200, cached);
    // Static decision matrix — the competitive positioning doesn't come from
    // the DB; it's a curated product definition (§7.9 spec).
    const dimensions = [
      { key: 'sources', label: 'Source coverage', eagleye: '19 sources incl. Reddit/XiaoHongShu', hackertab: '~15', feedly: 'user RSS', techmeme: '~20 curated', dailydev: '~12 dev' },
      { key: 'ai_summary', label: 'AI summary per item', eagleye: '✓ Chinese knowledge card', hackertab: '—', feedly: '—', techmeme: 'editor summary', dailydev: '—' },
      { key: 'alpha_score', label: 'Multi-dim alpha scoring', eagleye: '✓ 6-dim + 3 audiences', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'personalization', label: 'Personal filter + watchlist', eagleye: '✓ For-You + lens', hackertab: '—', feedly: '✓ ML', techmeme: '—', dailydev: '✓ basic' },
      { key: 'stories', label: 'Cross-source story clustering', eagleye: '✓', hackertab: '—', feedly: 'partial', techmeme: '✓ editorial', dailydev: '—' },
      { key: 'knowledge_graph', label: 'Live knowledge graph', eagleye: '✓ KG v2 + 3D', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'deep_research', label: 'Deep research action', eagleye: '✓ per-item + topic', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'deploy', label: '1-click deploy analysis', eagleye: '✓ GitHub repos', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'language', label: 'Chinese-first', eagleye: '✓', hackertab: '—', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'self_hosted', label: 'Self-hosted / local', eagleye: '✓', hackertab: '✓ ext', feedly: '—', techmeme: '—', dailydev: '—' },
      { key: 'signup', label: 'Sign-up friction', eagleye: 'none', hackertab: 'none', feedly: 'account', techmeme: 'none', dailydev: 'account' },
    ];
    const personas = [
      { key: 'solo_dev', label: 'Solo developer', best: 'eagleye', why: 'AI cards + deploy + deep research' },
      { key: 'ai_researcher', label: 'AI researcher', best: 'eagleye', why: 'arXiv + HF papers + topic graph + trajectories' },
      { key: 'indie_hacker', label: 'Indie hacker', best: 'eagleye', why: 'Product Hunt + funding signals + alpha radar' },
      { key: 'founder_vc', label: 'Founder / VC', best: 'eagleye', why: 'Investor lens + entity momentum + stories' },
      { key: 'casual', label: 'Casual reader', best: 'dailydev', why: 'Lowest friction, dev-community focus' },
      { key: 'enterprise', label: 'Enterprise team', best: 'feedly', why: 'Mature multi-user, MFA, integrations' },
    ];
    const data = { status: 'ok', dimensions, personas };
    cacheSet('compare:matrix', data, 60 * 60 * 1000); // 1h — fully static
    sendJSON(res, 200, data);
  };

  // --- Global Search (missing) ---
  // GET /api/search?q=...&limit=N
  // Searches item titles + AI summaries via FTS5 (trigram tokenizer, bilingual).
  // Ranked by BM25 relevance blended with alpha score.
  routes['/api/search'] = (req, res, parsed) => {
    const db = getDB();
    if (!db) return sendError(res, 500, 'Database not available');
    const q = (parsed.query.q || '').trim();
    if (q.length < 2) return sendJSON(res, 200, { status: 'ok', items: [], total: 0, q });
    const limit = Math.min(parseInt(parsed.query.limit || '50', 10), 200);

    // Sanitize for FTS5 MATCH: wrap in double-quotes to treat as a phrase,
    // escaping any embedded double-quotes. The trigram tokenizer handles
    // substring matching for both English and Chinese.
    const safeQ = q.replace(/"/g, '""');
    try {
      const items = db.prepare(`
        SELECT i.id, i.title, i.title_zh, i.canonical_url, i.digest_date, i.published_at,
               s.label AS source_label, s.slug AS source_slug,
               a.one_liner_zh, a.short_summary_zh,
               ss.alpha_score, ss.signal_type,
               rank AS fts_rank
        FROM items_fts f
        JOIN information_items i ON i.rowid = f.rowid
        JOIN sources s ON i.source_id = s.id
        LEFT JOIN ai_summaries a ON a.item_id = i.id
        LEFT JOIN signal_scores ss ON ss.item_id = i.id
        WHERE items_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `).all(`"${safeQ}"`, limit);

      sendJSON(res, 200, { status: 'ok', items, total: items.length, q, engine: 'fts5' });
    } catch (err) {
      // FTS5 table may not exist (pre-migration) — fall back to LIKE.
      const like = `%${q.replace(/[%_]/g, c => '\\' + c)}%`;
      const items = db.prepare(`
        SELECT i.id, i.title, i.title_zh, i.canonical_url, i.digest_date, i.published_at,
               s.label AS source_label, s.slug AS source_slug,
               a.one_liner_zh, a.short_summary_zh, ss.alpha_score, ss.signal_type, 0 AS fts_rank
        FROM information_items i
        JOIN sources s ON i.source_id = s.id
        LEFT JOIN ai_summaries a ON a.item_id = i.id
        LEFT JOIN signal_scores ss ON ss.item_id = i.id
        WHERE i.title LIKE ? ESCAPE '\\' OR i.title_zh LIKE ? ESCAPE '\\'
           OR a.one_liner_zh LIKE ? ESCAPE '\\' OR a.short_summary_zh LIKE ? ESCAPE '\\'
        ORDER BY COALESCE(ss.alpha_score, 0) DESC LIMIT ?
      `).all(like, like, like, like, limit);
      sendJSON(res, 200, { status: 'ok', items, total: items.length, q, engine: 'like-fallback' });
    }
  };

  // --- Elasticsearch: Health ---
  // GET /api/es/health
  routes['/api/es/health'] = async (req, res) => {
    try {
      if (!ES_HOST) { sendJSON(res, 200, { connected: false, configured: false }); return; }
      const data = await esHealth();
      sendJSON(res, 200, { status: 'ok', ...data });
    } catch (err) {
      sendJSON(res, 200, { connected: false, configured: true, error: err.message });
    }
  };

  // --- Elasticsearch: Aggregation Search ---
  // GET /api/es/search?q=...&mode=bm25|knn|rrf&source=...&language=...&dateFrom=...&size=20
  routes['/api/es/search'] = async (req, res, parsed) => {
    const q = (parsed.query.q || '').trim();
    const mode = parsed.query.mode || 'bm25';
    const { source, language, dateFrom } = parsed.query;
    const size = parsed.query.size || '20';

    // ES not configured or unavailable → graceful degradation to FTS5
    if (!ES_HOST || !(await esAvailable())) {
      const ftsResult = ftsSearch(getDB(), q, Math.min(parseInt(size, 10) || 30, 50));
      sendJSON(res, 200, { status: 'ok', ...ftsResult, mode, engine: 'fts5-fallback', es_down: true });
      return;
    }

    try {
      const result = await esSearch({ q, mode, source, language, dateFrom, size });
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      // ES query error → degrade to FTS5
      const ftsResult = ftsSearch(getDB(), q, Math.min(parseInt(size, 10) || 30, 50));
      sendJSON(res, 200, { status: 'ok', ...ftsResult, mode, engine: 'fts5-fallback', es_error: err.message });
    }
  };

  // --- Elasticsearch: Reindex (admin) ---
  // POST /api/es/reindex
  routes['/api/es/reindex'] = async (req, res) => {
    if (requireAdmin(req, res)) return;
    try {
      const result = await esReindex();
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      sendError(res, 500, `Reindex failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: Incremental Sync ---
  // POST /api/es/sync — only sync items updated since last sync
  routes['/api/es/sync'] = async (req, res) => {
    if (requireAdmin(req, res)) return;
    try {
      const result = await esIncrementalSync();
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      sendError(res, 500, `Sync failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: AI Setup (initialize inference endpoints + pipelines) ---
  // POST /api/es/setup-ai
  routes['/api/es/setup-ai'] = async (req, res) => {
    if (requireAdmin(req, res)) return;
    try {
      const result = await setupAI();
      sendJSON(res, 200, { status: 'ok', ...result });
    } catch (err) {
      sendError(res, 500, `AI setup failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: AI Status ---
  // GET /api/es/ai-status
  routes['/api/es/ai-status'] = async (req, res) => {
    try {
      const ready = await checkAIReady();
      sendJSON(res, 200, { status: 'ok', ready, inference_ids: AI_INFERENCE_IDS });
    } catch (err) {
      sendError(res, 500, `AI status check failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: RAG Chat (AI Builder) ---
  // POST /api/es/chat  body: { question, mode?, source?, language?, dateFrom? }
  routes['/api/es/chat'] = async (req, res, parsed) => {
    // Parse JSON body
    // readBody caps the payload; the hand-rolled loop this replaced had no
    // size limit, so a large body could be buffered without bound.
    let body;
    try { body = await readBody(req, 65536); } catch { body = {}; }

    const question = (body.question || '').trim();
    if (question.length < 2) {
      sendJSON(res, 200, { status: 'ok', answer: '问题太短了，请详细一点。', sources: [], total_found: 0 });
      return;
    }

    try {
      const result = await ragChat(question, {
        mode: body.mode || 'rrf',
        source: body.source,
        language: body.language,
        dateFrom: body.dateFrom,
      });
      sendJSON(res, 200, { status: 'ok', ...result, question });
    } catch (err) {
      sendError(res, 500, `RAG failed: ${err.message}`);
    }
  };

  // --- Elasticsearch: Search Suggestions ---
  // GET /api/es/suggest?q=...
  routes['/api/es/suggest'] = async (req, res, parsed) => {
    const q = (parsed.query.q || '').trim();
    if (q.length < 1) { sendJSON(res, 200, { suggestions: [] }); return; }

    if (!ES_HOST || !(await esAvailable().catch(() => false))) {
      sendJSON(res, 200, { suggestions: [], es_down: true });
      return;
    }

    try {
      // Use completion suggester on title + terms aggregation as fallback
      const result = await esRequest('POST', `/${ES_INDEX}/_search`, {
        size: 0,
        suggest: {
          title_suggest: {
            prefix: q,
            completion: { field: 'title.keyword', size: 8, skip_duplicates: true },
          },
        },
      });
      const options = result.suggest?.title_suggest?.[0]?.options || [];
      const suggestions = options.map(o => ({
        text: o._source.title || o.text,
        source: o._source.source_label,
      }));
      sendJSON(res, 200, { status: 'ok', suggestions });
    } catch (err) {
      // Fallback: simple terms aggregation
      try {
        const result = await esRequest('POST', `/${ES_INDEX}/_search`, {
          size: 0,
          query: { prefix: { 'title.keyword': q } },
          aggs: { titles: { terms: { field: 'title.keyword', size: 8 } } },
        });
        const suggestions = (result.aggregations?.titles?.buckets || []).map(b => ({ text: b.key }));
        sendJSON(res, 200, { status: 'ok', suggestions });
      } catch (e2) {
        sendJSON(res, 200, { suggestions: [] });
      }
    }
  };

  // --- Elasticsearch: Trend Comparison ---
  // GET /api/es/trend?q=...  — compares this week vs last week for a query
  routes['/api/es/trend'] = async (req, res, parsed) => {
    if (!ES_HOST || !(await esAvailable().catch(() => false))) {
      sendJSON(res, 200, { es_down: true });
      return;
    }
    const q = (parsed.query.q || '').trim();
    if (q.length < 2) { sendJSON(res, 200, { error: 'query too short' }); return; }

    try {
      const now = Date.now();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const thisWeekStart = now - weekMs;
      const lastWeekStart = now - 2 * weekMs;

      const result = await esRequest('POST', `/${ES_INDEX}/_search`, {
        size: 0,
        query: {
          multi_match: { query: q, fields: ['title^3', 'title_zh^3', 'ai_title^2', 'short_summary_zh^2', 'content'], type: 'best_fields', analyzer: 'ik_synonym_search' },
        },
        aggs: {
          this_week: {
            filter: { range: { published_at: { gte: thisWeekStart } } },
            aggs: {
              count: { value_count: { field: 'published_at' } },
              avg_alpha: { avg: { field: 'sig_alpha' } },
              top_sources: { terms: { field: 'source_label', size: 3 } },
            },
          },
          last_week: {
            filter: { range: { published_at: { gte: lastWeekStart, lt: thisWeekStart } } },
            aggs: {
              count: { value_count: { field: 'published_at' } },
              avg_alpha: { avg: { field: 'sig_alpha' } },
              top_sources: { terms: { field: 'source_label', size: 3 } },
            },
          },
          weekly: {
            date_histogram: { field: 'published_at', calendar_interval: 'week', min_doc_count: 1 },
            aggs: { avg_alpha: { avg: { field: 'sig_alpha' } } },
          },
        },
      });

      const a = result.aggregations;
      const tw = a.this_week, lw = a.last_week;
      const thisCount = tw.doc_count, lastCount = lw.doc_count;
      const growth = lastCount > 0 ? Math.round((thisCount - lastCount) / lastCount * 100) : (thisCount > 0 ? 100 : 0);

      sendJSON(res, 200, {
        status: 'ok',
        q,
        this_week: { count: thisCount, avg_alpha: tw.avg_alpha.value, sources: tw.top_sources.buckets },
        last_week: { count: lastCount, avg_alpha: lw.avg_alpha.value, sources: lw.top_sources.buckets },
        growth_pct: growth,
        weekly: a.weekly.buckets.map(b => ({
          week: new Date(b.key).toISOString().slice(0, 10),
          count: b.doc_count,
          alpha: b.avg_alpha.value,
        })),
      });
    } catch (err) {
      sendJSON(res, 200, { error: err.message.slice(0, 200) });
    }
  };

  // --- Elasticsearch: Saved Searches (CRUD via user_data) ---
  // GET /api/es/saved — list saved searches
  // POST /api/es/saved — { query, mode, filters } create
  // DELETE /api/es/saved/:id — remove
  routes['/api/es/saved'] = async (req, res, parsed) => {
    const db = getDB();
    if (!db) { sendError(res, 500, 'DB not available'); return; }
    const key = 'es_saved_searches';
    const method = req.method || 'GET';

    if (method === 'GET') {
      sendJSON(res, 200, { status: 'ok', searches: getValue(key, req.user.id) || [] });
      return;
    }

    if (method === 'POST') {
      let body;
      try { body = await readBody(req, 65536); } catch { body = {}; }
      const searches = getValue(key, req.user.id) || [];
      const entry = {
        id: Date.now().toString(36),
        query: body.query || '',
        mode: body.mode || 'auto',
        filters: body.filters || {},
        created_at: new Date().toISOString(),
      };
      searches.unshift(entry);
      setValue(key, searches, req.user.id);
      sendJSON(res, 200, { status: 'ok', ...entry });
      return;
    }

    sendError(res, 405, 'Method not allowed');
  };

  // --- Elasticsearch: Saved search delete ---
  routes['/api/es/saved/delete'] = async (req, res, parsed) => {
    const id = parsed.query.id;
    if (!id) { sendError(res, 400, 'id required'); return; }
    let searches = getValue('es_saved_searches', req.user.id) || [];
    searches = searches.filter(s => s.id !== id);
    setValue('es_saved_searches', searches, req.user.id);
    sendJSON(res, 200, { status: 'ok' });
  };

  // --- Elasticsearch: New items since last check (for alerts) ---
  // GET /api/es/alerts?q=...&since=ISO_DATE — count of new matching items
  routes['/api/es/alerts'] = async (req, res, parsed) => {
    if (!ES_HOST || !(await esAvailable().catch(() => false))) {
      sendJSON(res, 200, { es_down: true, new_count: 0 });
      return;
    }
    const q = (parsed.query.q || '').trim();
    const since = parsed.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (q.length < 2) { sendJSON(res, 200, { new_count: 0 }); return; }

    try {
      const result = await esRequest('POST', `/${ES_INDEX}/_search`, {
        size: 5,
        _source: ['title', 'title_zh', 'source_label', 'short_summary_zh', 'published_at', 'url', 'sig_alpha'],
        query: {
          bool: {
            must: [{ multi_match: { query: q, fields: ['title^3', 'title_zh^3', 'ai_title^2', 'short_summary_zh^2', 'content'], type: 'best_fields' } }],
            filter: [{ range: { published_at: { gte: since } } }],
          },
        },
        sort: [{ published_at: 'desc' }],
      });
      const hits = (result.hits?.hits || []).map(h => h._source);
      sendJSON(res, 200, { status: 'ok', new_count: result.hits?.total?.value || 0, items: hits, since });
    } catch (err) {
      sendJSON(res, 200, { new_count: 0, error: err.message.slice(0, 100) });
    }
  };
}

/**
 * FTS5 fallback search (used when ES is unavailable).
 * Returns the same shape as esSearch but without aggregations.
 */
function ftsSearch(db, q, limit) {
  if (!db) return { hits: [], total: 0, aggs: null };
  if (q.length < 2) return { hits: [], total: 0, aggs: null };
  const safeQ = q.replace(/"/g, '""');
  try {
    const items = db.prepare(`
      SELECT i.id AS item_id, i.canonical_url AS url, i.title, i.title_zh,
             s.label AS source_label, s.slug AS source_slug,
             a.short_summary_zh, a.one_liner, a.ai_title,
             i.language, i.author, i.published_at, i.score,
             ss.alpha_score AS sig_alpha, ss.novelty_score AS sig_novelty,
             rank AS _score, NULL AS highlight
      FROM items_fts f
      JOIN information_items i ON i.rowid = f.rowid
      JOIN sources s ON i.source_id = s.id
      LEFT JOIN ai_summaries a ON a.item_id = i.id
      LEFT JOIN signal_scores ss ON ss.item_id = i.id
      WHERE items_fts MATCH ?
      ORDER BY rank ASC LIMIT ?
    `).all(`"${safeQ}"`, limit);
    return { hits: items, total: items.length, aggs: null };
  } catch {
    const like = `%${q.replace(/[%_]/g, c => '\\' + c)}%`;
    const items = db.prepare(`
      SELECT i.id AS item_id, i.canonical_url AS url, i.title, i.title_zh,
             s.label AS source_label, s.slug AS source_slug,
             a.short_summary_zh, a.one_liner, a.ai_title,
             i.language, i.author, i.published_at, i.score,
             ss.alpha_score AS sig_alpha, ss.novelty_score AS sig_novelty,
             0 AS _score, NULL AS highlight
      FROM information_items i
      JOIN sources s ON i.source_id = s.id
      LEFT JOIN ai_summaries a ON a.item_id = i.id
      LEFT JOIN signal_scores ss ON ss.item_id = i.id
      WHERE i.title LIKE ? ESCAPE '\\' OR i.title_zh LIKE ? ESCAPE '\\'
         OR a.one_liner LIKE ? ESCAPE '\\'
      ORDER BY COALESCE(ss.alpha_score, 0) DESC LIMIT ?
    `).all(like, like, like, limit);
    return { hits: items, total: items.length, aggs: null };
  }
}

module.exports = { sendJSON, sendError, registerRoutes };
