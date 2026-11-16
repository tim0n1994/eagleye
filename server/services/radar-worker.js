'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const { readSnapshot, present } = require('./radar-reader');
const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 2000 });
db.pragma('query_only = ON');
const cache = new Map();
const qualityCache = new Map();
parentPort.on('message', ({ id, query }) => {
  try {
    if (query.view === 'stats') {
      const data = db.transaction(() => require('./system-stats').getSystemStats(db, { dbPath: workerData.dbPath }))();
      data.computed_at = new Date().toISOString();
      parentPort.postMessage({ id, data });
      return;
    }
    if (query.view === 'quality') {
      const key = `quality:${query.industry}:${query.days}`;
      let entry = qualityCache.get(key);
      if (!entry || Date.now()-entry.at>60000) {
        entry = {at:Date.now(),data:db.transaction(() => require('./intelligence-index').quality(db,query))()};
        if (qualityCache.size>=8) qualityCache.delete(qualityCache.keys().next().value);
        qualityCache.set(key,entry);
      }
      parentPort.postMessage({id,data:entry.data});
      return;
    }
    const key = `${query.date}:${query.days}:${query.industry || ''}`;
    let entry = cache.get(key);
    if (!entry || Date.now() - entry.at > 300000) {
      const snapshot = db.transaction(() => readSnapshot(db, query))();
      entry = { at: Date.now(),snapshot };
      cache.delete(key);
      // Bound retained snapshots and their association lists.
      if (cache.size >= 3) cache.delete(cache.keys().next().value);
      cache.set(key,entry);
    }
    parentPort.postMessage({ id,data: present(entry.snapshot,query) });
  } catch (error) {
    parentPort.postMessage({ id,error: error.message,status: error.status || 500 });
  }
});
