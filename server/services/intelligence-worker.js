'use strict';
const { workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { drainBatch } = require('./intelligence-index');
const db = new Database(workerData.dbPath, { timeout: 2000 });
db.pragma('foreign_keys = ON');
function tick() {
  let count = 0;
  try { count = drainBatch(db, 200); }
  catch (error) { console.warn('[intelligence-index]', error.message); }
  // Yield between bounded transactions; never occupy the HTTP event loop.
  setTimeout(tick, count ? 100 : 5000);
}
tick();
