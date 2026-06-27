#!/usr/bin/env node
/**
 * Fast Enrichment — optimized for local LLM (200ms delay)
 * Batch size 20, max 500 items per run
 */

require('dotenv').config();
const { getDB } = require('../server/db/connection');
const { generateItemSummary, enrichItems } = require('../server/services/llm');

const BATCH = 20;
const MAX_ITEMS = 500;

async function run() {
  const db = getDB();
  if (!db) { console.error('No DB'); process.exit(1); }

  const total = db.prepare('SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)').get().c;
  console.log(`Starting enrichment: ${total} items remaining, max ${MAX_ITEMS} this run`);

  let enrichedTotal = 0;
  const { enrichItems: doEnrich } = require('../server/services/llm');

  for (let i = 0; i < MAX_ITEMS / BATCH; i++) {
    const remaining = db.prepare('SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)').get().c;
    if (remaining === 0) break;

    try {
      const result = await doEnrich(BATCH);
      enrichedTotal += result.enriched;
      console.log(`Batch ${i + 1}: enriched ${result.enriched}/${result.total}, remaining: ${remaining - result.enriched}`);
    } catch (err) {
      console.error(`Batch ${i + 1} error:`, err.message);
    }

    // Shorter delay for local LLM
    await new Promise(r => setTimeout(r, 200));
  }

  const final = db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c;
  console.log(`Done. Total enriched this run: ${enrichedTotal}. Total in DB: ${final}`);
}

run().catch(err => {
  console.error('Enrichment failed:', err);
  process.exit(1);
});