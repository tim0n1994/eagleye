#!/usr/bin/env node
/**
 * Eagleye — Full Pipeline Monitor
 * 
 * 1. Enrich ALL remaining items with AI summaries
 * 2. Build topic graphs for all dates
 * 3. Build daily digests for last 9 days
 * 4. Retry on 503 errors with exponential backoff
 * 5. Report final stats
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDB } = require('../server/db/connection');
const { runMigrations } = require('../server/db/migrate');

const CONCURRENCY = 1;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 5000;
const POLL_INTERVAL_MS = 15000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function monitor() {
  console.log('\n  🦅 EAGLEYE FULL PIPELINE MONITOR\n');
  runMigrations();
  try { require('../server/migrations/002_migrate_legacy').run(); } catch {}

  const db = getDB();
  if (!db) { console.error('❌ No DB'); process.exit(1); }

  const totalItems = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
  const totalSummaries = db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c;
  console.log(`  Total items: ${totalItems}`);
  console.log(`  Have AI summaries: ${totalSummaries}`);
  console.log(`  Need enrichment: ${totalItems - totalSummaries}`);
  console.log('');

  const { enrichItems } = require('../server/services/llm');
  const { buildTopicGraph } = require('../server/services/topic-graph');
  const { generateDailyDigest } = require('../server/services/llm');

  // STEP 1: Continue enrichment until done
  console.log('📡 STEP 1: Enriching remaining items...\n');
  let remaining = totalItems - totalSummaries;
  let totalEnriched = 0;
  let consecutiveFailures = 0;
  let backoffMs = INITIAL_BACKOFF_MS;

  while (remaining > 0) {
    // Wait a bit before each attempt to avoid rate limits
    await sleep(10000);

    try {
      const result = await enrichItems(1);
      if (result.enriched > 0) {
        totalEnriched += result.enriched;
        consecutiveFailures = 0;
        backoffMs = Math.max(INITIAL_BACKOFF_MS, backoffMs / 2);
        remaining = totalItems - db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c;
        const pct = ((totalSummaries + totalEnriched) / totalItems * 100).toFixed(1);
        process.stdout.write(`\r  [${new Date().toISOString().slice(11, 19)}] +${result.enriched} | Total: ${totalSummaries + totalEnriched} | Remaining: ${remaining} (${pct}%) `);
      } else {
        consecutiveFailures++;
        if (consecutiveFailures > MAX_RETRIES) {
          console.log(`\n  ⚠  ${MAX_RETRIES} consecutive failures. Pausing for 60s...`);
          await sleep(60000);
          consecutiveFailures = 0;
        } else {
          backoffMs = Math.min(backoffMs * 2, 30000);
        }
      }
    } catch (e) {
      console.log(`\n  ⚠  Error: ${e.message}`);
      consecutiveFailures++;
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
  console.log('\n  ✅ Enrichment complete!\n');

  // STEP 2: Build topic graphs for last 9 days
  console.log('🔗 STEP 2: Building topic graphs...\n');
  const dates = [];
  for (let i = 0; i < 9; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  for (const date of dates) {
    try {
      const result = await buildTopicGraph(date);
      console.log(`    ✅ ${date}: ${result.new_topics || 0} topics, ${result.new_edges || 0} edges`);
    } catch (e) { console.log(`    ⚠  ${date}: ${e.message}`); }
    await sleep(500);
  }

  // STEP 3: Build daily digests for last 9 days
  console.log('\n📋 STEP 3: Building daily digests...\n');
  for (const date of dates) {
    // Retry with backoff on 503
    let digestRetries = 0;
    let digestResult = null;
    while (digestRetries < 3) {
      try {
        digestResult = await generateDailyDigest(date);
        break;
      } catch (e) {
        if (e.message?.includes('503') || e.message?.includes('all models failed')) {
          digestRetries++;
          console.log(`    ⚠  503 error for ${date}, retry ${digestRetries}/3...`);
          await sleep(digestRetries * 5000);
        } else {
          console.log(`    ⚠  ${date}: ${e.message}`);
          break;
        }
      }
    }
    if (digestResult) {
      console.log(`    ✅ ${date}: ${digestResult.top_signals?.length || 0} signals`);
    }
    await sleep(2000);
  }

  // Final stats
  const final = {
    items: db.prepare('SELECT COUNT(*) as c FROM information_items').get().c,
    summaries: db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c,
    topics: db.prepare('SELECT COUNT(*) as c FROM topics').get().c,
    edges: db.prepare('SELECT COUNT(*) as c FROM graph_edges').get().c,
    digests: db.prepare('SELECT COUNT(*) as c FROM daily_digests').get().c,
    entities: db.prepare('SELECT COUNT(*) as c FROM entities').get().c,
  };
  console.log('\n═══════════════════════════════════');
  console.log(`  Items:        ${final.items}`);
  console.log(`  Summaries:    ${final.summaries} (${(final.summaries / final.items * 100).toFixed(1)}%)`);
  console.log(`  Topics:       ${final.topics}`);
  console.log(`  Edges:        ${final.edges}`);
  console.log(`  Digests:      ${final.digests}`);
  console.log(`  Entities:     ${final.entities}`);
  console.log('═══════════════════════════════════\n');
}

monitor().catch(e => { console.error('FATAL:', e); process.exit(1); });
