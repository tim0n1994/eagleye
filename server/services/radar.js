'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { getDBPath } = require('../config');
let worker = null;
let sequence = 0;
const pending = new Map();
const flights = new Map();
// Keep completed responses on the HTTP thread: a synchronous worker refresh
// must not make readers wait behind it, even when the worker snapshot expired.
const responses = new Map();
const MAX_RESPONSES = 48;
const MAX_STALE_MS = 10 * 60000;
let warmTimer = null;
function cacheTTL(query) { return ['stats', 'quality'].includes(query.view) ? 60000 : 300000; }
function failure(message,status = 503) { return Object.assign(new Error(message),{status}); }
function stop(error) {
  const old = worker;
  worker = null;
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
  pending.clear();
  if (old) old.terminate().catch(() => {});
}
function ensureWorker() {
  if (worker) return worker;
  const next = new Worker(path.join(__dirname,'radar-worker.js'),{ workerData: { dbPath: getDBPath() } });
  worker = next;
  next.on('message',message => {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (!pending.size) next.unref();
    if (message.error) task.reject(failure(message.error,message.status));
    else task.resolve(message.data);
  });
  next.on('error',error => { if (worker === next) stop(error); });
  next.on('exit',code => { if (worker === next) stop(failure(`Radar reader exited (${code})`)); });
  next.unref();
  return next;
}
function refresh(query, key) {
  // Subscription list is part of the key; private responses never share a key
  // across differing interests. Nothing private is cached in the worker.
  if (flights.has(key)) return flights.get(key);
  if (pending.size >= 12) return Promise.reject(failure('Reader busy; please retry shortly',429));
  const promise = new Promise((resolve,reject) => {
    const reader = ensureWorker();
    const id = ++sequence;
    const timer = setTimeout(() => stop(failure('Reader timed out; please retry')),20000);
    pending.set(id,{ resolve,reject,timer });
    reader.ref();
    reader.postMessage({ id,query });
  }).then(data => {
    if (query.view !== 'following') {
      responses.delete(key);
      if (responses.size >= MAX_RESPONSES) responses.delete(responses.keys().next().value);
      const generated = Date.parse(data.computed_at || data.meta?.generated_at || '');
      responses.set(key, { data, at: Number.isFinite(generated) ? generated : Date.now(), retryAt: 0 });
    }
    return data;
  }).finally(() => flights.delete(key));
  flights.set(key,promise);
  return promise;
}
function readRadar(query) {
  const key = JSON.stringify(query);
  const entry = responses.get(key);
  if (entry && Date.now() - entry.at < MAX_STALE_MS) {
    responses.delete(key);
    responses.set(key, entry);
    if (Date.now() - entry.at >= cacheTTL(query) && Date.now() >= entry.retryAt) {
      entry.retryAt = Date.now() + 15000;
      refresh(query, key).catch(error => console.warn('[analytics refresh]', error.message));
    }
    return Promise.resolve(entry.data);
  }
  return refresh(query, key);
}
function startRadar() {
  if (warmTimer) return;
  const warm = () => {
    const date = require('./date-contract').todayDigestDate();
    // The ordinary landing view and settings statistics are ready before a
    // visitor needs them; other filters populate on demand and then refresh.
    for (const query of [
      { date, days: 7, offset: 0, view: 'discover', topic: '', entity: '', industry: '', kind: 'entity', sort: 'recent' },
      { view: 'stats' },
    ]) readRadar(query).catch(error => console.warn('[analytics warmup]', error.message));
  };
  warmTimer = setInterval(warm, 60000);
  warmTimer.unref();
  warm();
}
function stopRadar() {
  clearInterval(warmTimer);
  warmTimer = null;
  responses.clear();
  stop(failure('Server stopping'));
}
module.exports = { readRadar, startRadar, stopRadar };
