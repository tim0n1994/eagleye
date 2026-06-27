#!/usr/bin/env node
/**
 * Eagleye — Mass AI Summary Generation
 *
 * Processes all items without summaries using concurrent LLM calls.
 * Uses FCM Router / Qwen 3.7Max via OpenAI-compatible endpoint.
 */

require('dotenv').config();
const { getDB } = require('../server/db/connection');
const { enrichItems } = require('../server/services/llm');

const BATCH = 50;         // process 50 items per batch (enrichItems uses sequential)
const PAUSE_MS = 800;     // ms between individual items
const MAX_BATCHES = 200;  // max batches before stopping

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runMassEnrichment() {
  const db = getDB();
  if (!db) {
    console.error('DB unavailable!');
    process.exit(1);
  }

  let run = 0;
  let totalEnriched = 0;
  let startTime = Date.now();
  
  while (run < MAX_BATCHES) {
    // Check how many remain un-enriched
    const remaining = db.prepare(`
      SELECT COUNT(*) as c FROM information_items 
      WHERE id NOT IN (SELECT DISTINCT item_id FROM ai_summaries)
    `).get().c;

    if (remaining === 0) {
      console.log(`\n🎉 All items enriched! (${totalEnriched} total)`);
      break;
    }

    const batchNo = run + 1;
    const total = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
    const totalEnrichedNow = total - remaining;
    const pct = ((totalEnrichedNow / total) * 100).toFixed(1);

    console.log(`\n[Batch ${batchNo}] Remaining: ${remaining} / ${total} | Done: ${pct}% | Total enriched: ${totalEnrichedNow}`);
    
    try {
      const result = await enrichItems(BATCH);
      totalEnriched += result.enriched;
      console.log(`  Batch ${batchNo}: ${result.enriched}/${result.total} enriched`);
    } catch (err) {
      console.error(`  Batch ${batchNo} failed:`, err.message);
    }

    run++;

    if (run % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      const rate = (totalEnriched / (elapsed / 60)).toFixed(1);
      console.log(`\n📊 Progress: ${totalEnrichedNow + totalEnriched} total, ${rate} items/min, ${elapsed} min elapsed`);
    }

    await sleep(PAUSE_MS);
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  const finalRemaining = db.prepare(`SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT DISTINCT item_id FROM ai_summaries)`).get().c;
  const finalTotal = db.prepare('SELECT COUNT(*) as c FROM information_items').get().c;
  
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`✅ Enrichment run complete in ${elapsed} min`);
  console.log(`📊 Total enriched: ${finalTotal - finalRemaining} / ${finalTotal}`);
  console.log(`⚠  Remaining: ${finalRemaining}`);
  console.log(`══════════════════════════════════════════════`);
}

runMassEnrichment().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
