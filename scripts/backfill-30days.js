#!/usr/bin/env node
/**
 * Eagleye — 30-Day Backfill Script
 *
 * Fetches historical data from all available sources for the past 30 days.
 * - HN: Uses Algolia API for date-specific history
 * - GitHub: Search API for repos created in rolling windows
 * - Others: Run live sync (RSS/API current data)
 */

const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'eagleye.db');
const { getDB } = require('../server/db/connection');

const HN_SOURCE_ID = 'hn-source-id'; // Will be resolved from DB
const DAYS = 30;
const HN_HITS_PER_PAGE = 50;
const HN_MIN_POINTS = 20;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, (res) => {
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

async function backfillHN(db, sourceId, numDays) {
  console.log(`\n🔴 HN Algolia Backfill: ${numDays} days`);
  const now = Math.floor(Date.now() / 1000);
  let totalSaved = 0;

  for (let d = 1; d <= numDays; d++) {
    const dayEnd = now - (d - 1) * 86400;
    const dayStart = now - d * 86400;
    const dateStr = new Date(dayStart * 1000).toISOString().slice(0, 10).replace(/-/g, '');
    
    try {
      const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=created_at_i>${dayStart},created_at_i<${dayEnd},points>=${HN_MIN_POINTS}&hitsPerPage=${HN_HITS_PER_PAGE}`;
      const body = await httpGet(url);
      const data = JSON.parse(body);
      const hits = data.hits || [];

      if (hits.length === 0) continue;

      let daySaved = 0;
      for (const hit of hits) {
        if (!hit.title || hit.deleted) continue;
        
        const canonicalUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
        const existingCheck = 'SELECT id FROM information_items WHERE canonical_url = ? AND digest_date = ?';
        const existing = db.prepare(existingCheck).get(canonicalUrl, dateStr);
        if (existing) continue;

        const item = {
          id: crypto.randomUUID(),
          source_id: sourceId,
          canonical_url: canonicalUrl,
          title: hit.title,
          original_summary: hit.story_text || '',
          content_text: '',
          language: 'en',
          author: hit.author || '',
          published_at: hit.created_at || new Date(hit.created_at_i * 1000).toISOString(),
          fetched_at: new Date().toISOString(),
          digest_date: dateStr,
          source_payload: JSON.stringify({
            hnId: hit.objectID,
            hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
            points: hit.points || 0,
            comments: hit.num_comments || 0,
            domain: hit.url ? (() => { try { return new URL(hit.url).hostname.replace(/^www\./, ''); } catch { return ''; } })() : 'news.ycombinator.com',
            by: hit.author || '',
            type: 'story',
          }),
          normalized_payload: '{}',
          score: Math.log2(1 + (hit.points || 0)) * (1 + Math.log(1 + (hit.num_comments || 1))) / 5,
          popularity: JSON.stringify({ points: hit.points || 0, comments: hit.num_comments || 0 }),
          created_at: new Date().toISOString(),
        };

        db.prepare(`INSERT OR IGNORE INTO information_items (id, source_id, canonical_url, title, original_summary, content_text, language, author, published_at, fetched_at, digest_date, source_payload, normalized_payload, score, popularity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.id, item.source_id, item.canonical_url, item.title, item.original_summary, item.content_text, item.language, item.author, item.published_at, item.fetched_at, item.digest_date, item.source_payload, item.normalized_payload, item.score, item.popularity, item.created_at);
        daySaved++;
      }

      totalSaved += daySaved;
      console.log(`  ${dateStr}: ${hits.length} hits, ${daySaved} new`);
    } catch (err) {
      console.error(`  ${dateStr} failed:`, err.message);
    }
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  console.log(`HN total new: ${totalSaved}`);
  return totalSaved;
}

async function backfillGitHub(db, sourceId, numDays) {
  console.log(`\n🐙 GitHub Backfill: ${numDays} days`);
  let totalSaved = 0;
  
  for (let d = 0; d < numDays; d += 7) {
    const endDate = new Date(Date.now() - d * 86400000);
    const startDate = new Date(Date.now() - (d + 7) * 86400000);
    const startStr = startDate.toISOString().split('T')[0];

    try {
      const url = `https://api.github.com/search/repositories?q=created:>${startStr}+stars:>100&sort=stars&order=desc&per_page=30`;
      const body = await httpGet(url);
      const data = JSON.parse(body);
      const repos = data.items || [];
      
      for (const repo of repos) {
        const dateStr = (repo.created_at || '').slice(0, 10).replace(/-/g, '');
        if (!dateStr) continue;
        
        const canonicalUrl = repo.html_url;
        const existing = db.prepare('SELECT id FROM information_items WHERE canonical_url = ?').get(canonicalUrl);
        if (existing) continue;

        const item = {
          id: crypto.randomUUID(),
          source_id: sourceId,
          canonical_url: canonicalUrl,
          title: `${repo.full_name}: ${repo.description || ''}`,
          original_summary: repo.description || '',
          content_text: '',
          language: 'en',
          author: repo.owner?.login || '',
          published_at: repo.created_at,
          fetched_at: new Date().toISOString(),
          digest_date: dateStr,
          source_payload: JSON.stringify({
            repo_name: repo.full_name,
            owner: repo.owner?.login || '',
            repo: repo.name,
            stars: repo.stargazers_count || 0,
            forks: repo.forks_count || 0,
            language: repo.language || '',
            license: repo.license?.spdx_id || repo.license?.key || '',
            topics: repo.topics || [],
            open_issues: repo.open_issues_count || 0,
            watchers: repo.watchers_count || 0,
          }),
          normalized_payload: '{}',
          score: Math.log2(1 + (repo.stargazers_count || 0)),
          popularity: JSON.stringify({ stars: repo.stargazers_count || 0, forks: repo.forks_count || 0, stars_today: 0 }),
          created_at: new Date().toISOString(),
        };

        db.prepare(`INSERT OR IGNORE INTO information_items (id, source_id, canonical_url, title, original_summary, content_text, language, author, published_at, fetched_at, digest_date, source_payload, normalized_payload, score, popularity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.id, item.source_id, item.canonical_url, item.title, item.original_summary, item.content_text, item.language, item.author, item.published_at, item.fetched_at, item.digest_date, item.source_payload, item.normalized_payload, item.score, item.popularity, item.created_at);
        totalSaved++;
      }
      
      const lastPage = repos.length > 0 ? `saved ${repos.length > 30 ? 30 : repos.length} total` : '';
      console.log(`  week ending ${startStr}: ${repos.length} repos, ${lastPage}`);
    } catch (err) {
      console.error(`  GitHub API error:`, err.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`GitHub total new: ${totalSaved}`);
  return totalSaved;
}

async function runBackfill() {
  console.log('🚀 Starting 30-day backfill...');
  
  const db = getDB();
  if (!db) {
    console.error('Database not available!');
    process.exit(1);
  }

  // Resolve source IDs
  const sources = db.prepare('SELECT id, slug FROM sources WHERE is_active = 1').all();
  const sourceMap = {};
  sources.forEach(s => { sourceMap[s.slug] = s.id; });

  console.log(`Sources: ${Object.keys(sourceMap).length} active`);
  console.log(`Date range: last ${DAYS} days`);

  // HN backfill
  const hnId = sourceMap['hacker-news'];
  if (hnId) {
    await backfillHN(db, hnId, DAYS);
  } else {
    console.warn('HN source not found');
  }

  // GitHub backfill
  const ghId = sourceMap['github-trending'];
  if (ghId) {
    await backfillGitHub(db, ghId, DAYS);
  } else {
    console.warn('GitHub source not found');
  }

  // Live sync for current day
  console.log('\n📡 Running live sync for today...');
  const { fetchAllSources } = require('../server/connectors');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const syncResults = await fetchAllSources(today);
  syncResults.forEach(r => {
    if (r.error) console.log(`  ❌ ${r.source}: ${r.error}`);
    else if (r.items > 0) console.log(`  ✅ ${r.source}: ${r.items} items`);
  });

  // Final stats
  const total = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
  const enriched = db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c;
  console.log(`\n📊 Final stats:`);
  console.log(`  Total items: ${total}`);
  console.log(`  With AI summary: ${enriched}`);
  console.log(`  Without: ${total - enriched}`);
  
  const dates = db.prepare('SELECT digest_date, COUNT(*) as cnt FROM information_items GROUP BY digest_date ORDER BY digest_date DESC LIMIT 35').all();
  console.log(`\n📅 Date coverage (${dates.length} dates):`);
  dates.forEach(d => console.log(`  ${d.digest_date}: ${d.cnt}`));
}

runBackfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
