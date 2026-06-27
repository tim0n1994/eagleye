#!/usr/bin/env node
/**
 * Enrichment-only script — processes items without AI summaries.
 * Uses parallel processing (3 concurrent items) for speed.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDB } = require('../server/db/connection');
const { runMigrations } = require('../server/db/migrate');

const CONCURRENCY = 5;
const DELAY_BETWEEN_BATCHES_MS = 300;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n  🤖 EAGLEYE ENRICHMENT PIPELINE\n');
  runMigrations();
  try { require('../server/migrations/002_migrate_legacy').run(); } catch {}

  const db = getDB();
  if (!db) { console.error('❌ No DB'); process.exit(1); }

  const { enrichItems } = require('../server/services/llm');
  const { buildTopicGraph } = require('../server/services/topic-graph');
  const { generateDailyDigest } = require('../server/services/llm');

  // Count totals
  let remaining = db.prepare('SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)').get().c;
  const totalBefore = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
  console.log(`  Total items: ${totalBefore}`);
  console.log(`  Already enriched: ${totalBefore - remaining}`);
  console.log(`  Remaining to enrich: ${remaining}`);
  console.log(`  Parallel workers: ${CONCURRENCY}\n`);

  // STEP 1: Enrich items using parallel batches
  let enrichedTotal = 0;
  let batchNum = 0;
  while (remaining > 0) {
    batchNum++;
    // Run parallel enrichment using multiple promises
    const promises = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      promises.push(enrichItems(5).catch(e => { console.error('Batch error:', e.message); return { enriched: 0, total: 0 }; }));
    }
    const results = await Promise.all(promises);
    const batchEnriched = results.reduce((sum, r) => sum + (r.enriched || 0), 0);
    enrichedTotal += batchEnriched;
    remaining = db.prepare('SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)').get().c;
    const pct = ((enrichedTotal + (totalBefore - remaining - enrichedTotal)) / totalBefore * 100).toFixed(1);
    if (batchNum % 5 === 0 || remaining === 0) {
      console.log(`  [Batch ${batchNum}] +${batchEnriched} | Total enriched: ${enrichedTotal} | Remaining: ${remaining} (~${pct}%)`);
    }
    if (batchEnriched === 0) {
      console.log('  ⚠  No items enriched in this batch. Waiting 5s then retrying...');
      await sleep(5000);
      // Try one more time with a small batch
      const retry = await enrichItems(3).catch(() => ({ enriched: 0 }));
      if (retry.enriched === 0) {
        console.log('  ❌ Retry also failed. Stopping enrichment.');
        break;
      }
    } else {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  const afterSummaries = db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c;
  console.log(`\n  ✅ Enrichment done: ${afterSummaries}/${totalBefore} items have AI summaries`);

  // STEP 2: Build topic graphs for last 9 days
  console.log('\n  🔗 Building topic graphs for last 9 days...');
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
    await sleep(300);
  }

  // STEP 3: Build daily digests
  console.log('\n  📋 Building daily digests for last 9 days...');
  for (const date of dates) {
    try {
      const result = await generateDailyDigest(date);
      if (result) console.log(`    ✅ ${date}: ${result.top_signals?.length || 0} signals`);
      else console.log(`    ⚠  ${date}: no data or failed`);
    } catch (e) { console.log(`    ⚠  ${date}: ${e.message}`); }
    await sleep(1500);
  }

  // Final stats
  const finalStats = {
    items: db.prepare('SELECT COUNT(*) as c FROM information_items').get().c,
    summaries: db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c,
    topics: db.prepare('SELECT COUNT(*) as c FROM topics').get().c,
    edges: db.prepare('SELECT COUNT(*) as c FROM graph_edges').get().c,
    digests: db.prepare('SELECT COUNT(*) as c FROM daily_digests').get().c,
    entities: db.prepare('SELECT COUNT(*) as c FROM entities').get().c,
  };
  console.log('\n  ─── FINAL STATS ───');
  Object.entries(finalStats).forEach(([k, v]) => console.log(`  ${k.padEnd(12)} ${v}`));
  console.log('');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
