'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { getDBPath } = require('../config');
let worker = null;
let sequence = 0;
const pending = new Map();
const flights = new Map();
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
function readRadar(query) {
  // Subscription list is part of the key; private responses never share a key
  // across differing interests. Nothing private is cached in the worker.
  const key = JSON.stringify(query);
  if (flights.has(key)) return flights.get(key);
  if (pending.size >= 12) return Promise.reject(failure('Reader busy; please retry shortly',429));
  const promise = new Promise((resolve,reject) => {
    const reader = ensureWorker();
    const id = ++sequence;
    const timer = setTimeout(() => stop(failure('Reader timed out; please retry')),20000);
    pending.set(id,{ resolve,reject,timer });
    reader.ref();
    reader.postMessage({ id,query });
  }).finally(() => flights.delete(key));
  flights.set(key,promise);
  return promise;
}
function stopRadar() { stop(failure('Server stopping')); }
module.exports = { readRadar, stopRadar };
