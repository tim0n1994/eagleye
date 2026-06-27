#!/usr/bin/env node
/**
 * Fast parallel enrichment — 4 concurrent workers for local LLM
 */

require('dotenv').config();
const { getDB } = require('./server/db/connection');
const { runMigrations } = require('./server/db/migrate');
const { enrichItems } = require('./server/services/llm');

runMigrations();

const CONCURRENCY = 4;
const BATCH = 10;

async function worker(id) {
  const db = getDB();
  let total = 0;
  while (true) {
    const remaining = db.prepare("SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)").get().c;
    if (remaining === 0) break;
    try {
      const result = await enrichItems(BATCH);
      total += result.enriched;
      if (result.enriched === 0) break;
      const rem = db.prepare("SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)").get().c;
      console.log(`[W${id}] enriched ${total}, remaining ${rem}`);
    } catch (err) {
      console.error(`[W${id}] error:`, err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log(`[W${id}] done. Total: ${total}`);
  return total;
}

async function main() {
  const db = getDB();
  const initial = db.prepare("SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)").get().c;
  console.log(`Starting ${CONCURRENCY} workers, ${initial} items to enrich`);
  
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker(i));
    await new Promise(r => setTimeout(r, 300));
  }
  
  const results = await Promise.all(workers);
  const total = results.reduce((a, b) => a + b, 0);
  console.log(`All done. Total enriched: ${total}`);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
