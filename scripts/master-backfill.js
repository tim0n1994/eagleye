#!/usr/bin/env node
/**
 * Eagleye — Master Backfill & Enrichment Script
 *
 * Runs the complete pipeline for the last 9 days:
 * 1. Fetch ALL sources for each day (including previously empty ones)
 * 2. Enrich ALL items without AI summaries
 * 3. Build topic graphs for each day
 * 4. Build daily digests for each day
 * 5. Rebuild entity co-occurrence and update growth scores
 */

const path = require('path');

// Boot the project normally
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDB } = require('../server/db/connection');
const { runMigrations } = require('../server/db/migrate');

const DAYS = 9;
const BATCH_SIZE = 10; // Items per enrichment batch

// Helper HTTP GET
const https = require('https');
const http = require('http');
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 20000, headers: { 'User-Agent': 'Eagleye/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function generateDateRange(n) {
  const dates = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return dates;
}

async function main() {
  console.log('');
  console.log('  🦅 EAGLEYE MASTER BACKFILL');
  console.log('  ──────────────────────────');
  console.log('');

  // Init DB + migrations
  runMigrations();

  // Migrate legacy data
  try {
    const { run: migrateLegacy } = require('../server/migrations/002_migrate_legacy');
    migrateLegacy();
  } catch {}

  const db = getDB();
  if (!db) {
    console.error('  ❌ Database not available');
    process.exit(1);
  }

  // ============================================================
  // STEP 1: Fetch all sources for 9 days
  // ============================================================
  console.log('  📡 STEP 1: Fetching sources for 9 days...');
  console.log('');

  const dates = generateDateRange(DAYS);
  const { fetchAllSources } = require('../server/connectors');

  for (const date of dates) {
    console.log(`  ── Day: ${date} ──`);
    try {
      const results = await fetchAllSources(date);
      for (const r of results) {
        if (r.error) console.log(`    ❌ ${r.source}: ${r.error}`);
        else if (r.items > 0) console.log(`    ✅ ${r.source}: ${r.items} items`);
        else console.log(`    ⚠  ${r.source}: 0 items`);
      }
    } catch (err) {
      console.error(`    ❌ Day ${date} fetch failed:`, err.message);
    }
    await sleep(1000);
  }

  // ============================================================
  // STEP 1b: Fix Product Hunt — try HTML scraping specifically
  // ============================================================
  console.log('');
  console.log('  📡 STEP 1b: Special fetch for Product Hunt & Startup Archive...');

  // Product Hunt: try with browser-like UA
  try {
    const phHtml = await httpGet('https://www.producthunt.com/');
    const phSource = db.prepare('SELECT id FROM sources WHERE slug = ?').get('product-hunt');
    if (phSource && phHtml.length > 5000) {
      // Try finding JSON-LD or __NEXT_DATA__
      const nextDataMatch = phHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextDataMatch) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          const posts = [];
          const props = nextData?.props?.pageProps || {};
          const feed = props?.feed || props?.posts || props?.featuredPosts || [];
          const arr = Array.isArray(feed) ? feed : (feed.edges || feed.nodes || []);
          for (const item of arr) {
            const node = item.node || item;
            if (node.name) {
              const now = new Date();
              const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
              posts.push({
                id: require('crypto').randomUUID(),
                source_id: phSource.id,
                canonical_url: node.url || node.website || `https://www.producthunt.com/posts/${node.slug || node.id}`,
                title: `${node.name}: ${node.tagline || ''}`,
                original_summary: node.description || node.tagline || '',
                content_text: '',
                language: 'en',
                author: '',
                published_at: node.createdAt || now.toISOString(),
                fetched_at: new Date().toISOString(),
                digest_date: dateStr,
                source_payload: JSON.stringify({
                  name: node.name,
                  tagline: node.tagline || '',
                  votes: node.votesCount || node.votes || 0,
                  icon_url: node.thumbnail?.url || '',
                  website: node.website || '',
                }),
                normalized_payload: '{}',
                score: node.votesCount ? Math.log2(1 + node.votesCount) : 0,
                popularity: JSON.stringify({ votes: node.votesCount || 0 }),
              });
            }
          }
          let saved = 0;
          const insertStmt = db.prepare(`INSERT OR IGNORE INTO information_items (id, source_id, canonical_url, title, original_summary, content_text, language, author, published_at, fetched_at, digest_date, source_payload, normalized_payload, score, popularity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const post of posts) {
            const existing = db.prepare('SELECT id FROM information_items WHERE source_id = ? AND canonical_url = ? AND digest_date = ?').get(post.source_id, post.canonical_url, post.digest_date);
            if (!existing) {
              insertStmt.run(post.id, post.source_id, post.canonical_url, post.title, post.original_summary, post.content_text, post.language, post.author, post.published_at, post.fetched_at, post.digest_date, post.source_payload, post.normalized_payload, post.score, post.popularity);
              saved++;
            }
          }
          console.log(`    ✅ product-hunt: ${saved} new items (from __NEXT_DATA__)`);
        } catch {}
      }
    }
  } catch (err) {
    console.log(`    ⚠  product-hunt special fetch: ${err.message}`);
  }

  // Startup Archive: try with better regex
  try {
    const saHtml = await httpGet('https://www.startuparchive.org/');
    const saSource = db.prepare('SELECT id FROM sources WHERE slug = ?').get('startup-archive');
    if (saSource && saHtml.length > 1000) {
      // Try simpler extraction: find all date+Y-combinator/startup patterns
      const lines = saHtml.replace(/<[^>]*>/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
      let saved = 0;
      const insertStmt = db.prepare(`INSERT OR IGNORE INTO information_items (id, source_id, canonical_url, title, original_summary, content_text, language, author, published_at, fetched_at, digest_date, source_payload, normalized_payload, score, popularity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (let i = 0; i < lines.length - 1; i++) {
        const dateMatch = lines[i].match(/([A-Z][a-z]{2,}\s+\d{1,2},?\s+\d{4})/);
        if (dateMatch && lines[i + 1] && lines[i + 1].length > 30) {
          try {
            const d = new Date(dateMatch[1]);
            if (isNaN(d.getTime())) continue;
            const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
            const title = lines[i + 1].slice(0, 200);
            const existing = db.prepare('SELECT id FROM information_items WHERE source_id = ? AND title = ?').get(saSource.id, title);
            if (!existing) {
              insertStmt.run(require('crypto').randomUUID(), saSource.id, 'https://www.startuparchive.org/', title, title, '', 'en', '', d.toISOString(), new Date().toISOString(), dateStr, JSON.stringify({person: '', insight: title}), '{}', 0, '{}');
              saved++;
            }
          } catch {}
        }
      }
      console.log(`    ✅ startup-archive: ${saved} new items`);
    }
  } catch (err) {
    console.log(`    ⚠  startup-archive special fetch: ${err.message}`);
  }

  // ============================================================
  // STEP 2: Fix missing physical-ai-arxiv items
  // ============================================================
  console.log('');
  console.log('  📡 STEP 1c: Fix Physical AI sources...');

  try {
    const arxivSource = db.prepare('SELECT id FROM sources WHERE slug = ?').get('physical-ai-arxiv');
    if (arxivSource) {
      const arxivHtml = await httpGet('http://export.arxiv.org/api/query?search_query=all:physical+AI+OR+all:embodied+AI+OR+all:humanoid+OR+all:VLA&sortBy=submittedDate&sortOrder=descending&max_results=50');
      if (arxivHtml.length > 500) {
        const entries = arxivHtml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
        let saved = 0;
        const insertStmt = db.prepare(`INSERT OR IGNORE INTO information_items (id, source_id, canonical_url, title, original_summary, content_text, language, author, published_at, fetched_at, digest_date, source_payload, normalized_payload, score, popularity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const entry of entries) {
          const getTag = (tag) => {
            const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
            return m ? m[1].trim() : '';
          };
          const getAuthor = () => {
            const authors = [];
            const am = entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi);
            for (const a of am) authors.push(a[1].trim());
            return authors.join(', ');
          };
          const title = getTag('title').replace(/\s+/g, ' ').trim();
          const url = (entry.match(/<id>([^<]*)<\/id>/) || [])[1] || '';
          const summary = getTag('summary').replace(/\s+/g, ' ').trim().slice(0, 2000);
          const published = getTag('published');
          const author = getAuthor();
          if (!title || !url) continue;
          const d = new Date(published);
          const dateStr = isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10).replace(/-/g, '') : d.toISOString().slice(0, 10).replace(/-/g, '');
          const existing = db.prepare('SELECT id FROM information_items WHERE source_id = ? AND canonical_url = ?').get(arxivSource.id, url);
          if (!existing) {
            insertStmt.run(require('crypto').randomUUID(), arxivSource.id, url, title, summary, summary, 'en', author, published || new Date().toISOString(), new Date().toISOString(), dateStr, JSON.stringify({paperUrl: url}), '{}', 1, '{}');
            saved++;
          }
        }
        console.log(`    ✅ physical-ai-arxiv: ${saved} new items`);
      }
    }
  } catch (err) {
    console.log(`    ⚠  physical-ai-arxiv fix: ${err.message}`);
  }

  // ============================================================
  // STEP 3: Enrich all items without AI summaries
  // ============================================================
  console.log('');
  console.log('  🤖 STEP 2: Enriching all un-summarized items...');

  const { enrichItems } = require('../server/services/llm');

  let totalUnenriched = db.prepare('SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)').get().c;
  let enrichedTotal = 0;

  console.log(`  Need to enrich: ${totalUnenriched} items`);

  while (totalUnenriched > 0) {
    try {
      const result = await enrichItems(BATCH_SIZE);
      enrichedTotal += result.enriched;
      if (result.enriched === 0 && result.total === 0) break;
    } catch (err) {
      console.error(`  ❌ Enrichment batch error:`, err.message);
    }
    totalUnenriched = db.prepare('SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)').get().c;
    console.log(`  Remaining: ${totalUnenriched}`);
    // Rate limit
    await sleep(2000);
  }

  console.log(`  ✅ Total enriched: ${enrichedTotal}`);

  // ============================================================
  // STEP 4: Build topic graphs for all dates
  // ============================================================
  console.log('');
  console.log('  🔗 STEP 3: Building topic graphs...');

  const { buildTopicGraph } = require('../server/services/topic-graph');

  for (const date of dates) {
    try {
      const result = await buildTopicGraph(date);
      console.log(`  ✅ ${date}:`, JSON.stringify(result));
    } catch (err) {
      console.error(`  ❌ ${date} topic graph:`, err.message);
    }
    await sleep(500);
  }

  // ============================================================
  // STEP 5: Build daily digests for all dates
  // ============================================================
  console.log('');
  console.log('  📋 STEP 4: Building daily digests...');

  const { generateDailyDigest } = require('../server/services/llm');

  for (const date of dates) {
    try {
      const result = await generateDailyDigest(date);
      if (result) {
        console.log(`  ✅ ${date}: digest created (${result.top_signals?.length || 0} signals)`);
      } else {
        console.log(`  ⚠  ${date}: no digest (insufficient data)`);
      }
    } catch (err) {
      console.error(`  ❌ ${date} digest:`, err.message);
    }
    await sleep(2000);
  }

  // ============================================================
  // STEP 6: Update growth scores for all topics
  // ============================================================
  console.log('');
  console.log('  📊 STEP 5: Final stats...');

  const totalItems = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
  const totalSummaries = db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c;
  const totalTopics = db.prepare('SELECT COUNT(*) as c FROM topics').get().c;
  const totalEdges = db.prepare('SELECT COUNT(*) as c FROM graph_edges').get().c;
  const totalDigests = db.prepare('SELECT COUNT(*) as c FROM daily_digests').get().c;
  const totalEntities = db.prepare('SELECT COUNT(*) as c FROM entities').get().c;

  console.log('');
  console.log('  ─── FINAL STATS ───');
  console.log(`  Items:      ${totalItems}`);
  console.log(`  Summaries:  ${totalSummaries} (${(totalSummaries / totalItems * 100).toFixed(1)}%)`);
  console.log(`  Topics:     ${totalTopics}`);
  console.log(`  Edges:      ${totalEdges}`);
  console.log(`  Digests:    ${totalDigests}`);
  console.log(`  Entities:   ${totalEntities}`);
  console.log('');

  const perSource = db.prepare('SELECT s.slug, s.label, COUNT(i.id) as cnt FROM sources s LEFT JOIN information_items i ON s.id = i.source_id GROUP BY s.slug ORDER BY cnt DESC').all();
  console.log('  ─── Per Source ───');
  for (const s of perSource) {
    console.log(`  ${s.label.padEnd(30)} ${s.cnt}`);
  }

  // Show date coverage
  const perDate = db.prepare('SELECT digest_date, COUNT(*) as cnt FROM information_items GROUP BY digest_date ORDER BY digest_date DESC LIMIT 15').all();
  console.log('');
  console.log('  ─── Date Coverage ───');
  for (const d of perDate) {
    console.log(`  ${d.digest_date}: ${d.cnt} items`);
  }

  console.log('');
  console.log('  🦅 Master backfill complete!');
}

main().catch(err => {
  console.error('Master backfill failed:', err);
  process.exit(1);
});