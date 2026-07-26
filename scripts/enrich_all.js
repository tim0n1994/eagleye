require('dotenv').config();
const { getDB } = require('./server/db/connection');
const { enrichItems } = require('./server/services/llm');
const db = getDB();

async function run() {
  let round = 0;
  while (true) {
    round++;
    const remaining = db.prepare("SELECT COUNT(*) as c FROM information_items WHERE id NOT IN (SELECT item_id FROM ai_summaries)").get().c;
    if (remaining === 0) { console.log('All items enriched!'); break; }
    if (round > 150) { console.log('Max rounds reached'); break; }
    console.log(`Round ${round}: ${remaining} items remaining`);
    const result = await enrichItems(20);
    console.log(`  Enriched: ${result.enriched}`);
    if (result.enriched === 0) { console.log('No more items enriched, stopping'); break; }
  }
  const final = db.prepare('SELECT COUNT(*) as c FROM ai_summaries').get().c;
  console.log(`Done. Total summaries: ${final}`);
}
run().catch(err => { console.error('Error:', err); process.exit(1); });