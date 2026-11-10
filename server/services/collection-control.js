'use strict';

// Shared process-wide admission control for scheduled and manual collections.
const { setTimeout: delay } = require('node:timers/promises');
const gates = new Map();
function boundedEnv(key, fallback, max) {
  const n = Number(process.env[key]);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
async function gated(key, capacity, signal, work, spacing = 0) {
  let gate = gates.get(key);
  if (!gate) gates.set(key, gate = { active: 0, waiters: [], next: 0 });
  signal?.throwIfAborted();
  if (gate.active >= capacity) {
    await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); } };
      const abort = () => {
        const i = gate.waiters.indexOf(waiter);
        if (i >= 0) gate.waiters.splice(i, 1);
        reject(signal.reason);
      };
      gate.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  } else gate.active++;
  try {
    signal?.throwIfAborted();
    const wait = Math.max(0, gate.next - Date.now());
    gate.next = Date.now() + wait + spacing;
    if (wait) await delay(wait, undefined, { signal });
    signal?.throwIfAborted();
    return await work();
  } finally {
    const next = gate.waiters.shift();
    if (next) next.resolve();
    else gate.active--;
  }
}
function withSourceSlot(slug, signal, work) {
  return gated(`source:${slug}`, 1, signal, () =>
    gated('sources', boundedEnv('COLLECTION_CONCURRENCY', 4, 16), signal, work));
}
function withHostSlot(url, signal, work) {
  let host;
  try { host = new URL(url).hostname; } catch { return work(); }
  return gated(`host:${host}`, boundedEnv('COLLECTION_HOST_CONCURRENCY', 2, 8), signal,
    work, boundedEnv('COLLECTION_HOST_SPACING_MS', 500, 10000));
}
function intervalHours(source) {
  if (Number(source.expected_interval_hours) > 0) return Number(source.expected_interval_hours);
  if (source.slug === 'startup-archive') return 168;
  if (/arxiv|neuroscience-nature|neuroscience-elife/.test(source.slug)) return 24;
  if (source.slug === 'xiaohongshu') return 24;
  if (/lerobot|isaaclab|oatutor|deeptutor|mne|pynwb|brainflow/.test(source.slug)) return 12;
  return 6;
}
function recordCollection(slug, data) {
  const db = require('../db/connection').getDB();
  if (!db) return;
  const source = db.prepare('SELECT * FROM sources WHERE slug = ?').get(slug);
  if (!source) return;
  const previous = db.prepare('SELECT * FROM source_collection_state WHERE slug = ?').get(slug);
  const failures = data.error ? (previous?.failures || 0) + 1 : 0;
  const hours = data.partial ? 1 / 12 : data.error ? Math.min(intervalHours(source), 0.5 * 2 ** Math.min(failures - 1, 5)) : intervalHours(source);
  const now = new Date().toISOString();
  const outcome = data.error ? 'failed' : data.notModified ? 'not_modified' : data.inserted > 0 ? 'stored' : data.fetched > 0 ? 'unchanged' : 'empty';
  db.prepare(`INSERT INTO source_collection_state
    (slug, last_attempt_at, last_request_success_at, last_parse_success_at, last_commit_at, next_due_at,
     outcome, fetched, inserted, duplicates, skipped, failures, error_class)
    VALUES (@slug,@now,@request,@parsed,@committed,@due,@outcome,@fetched,@inserted,@duplicates,@skipped,@failures,@error)
    ON CONFLICT(slug) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
      last_request_success_at=COALESCE(excluded.last_request_success_at,last_request_success_at),
      last_parse_success_at=COALESCE(excluded.last_parse_success_at,last_parse_success_at),
      last_commit_at=COALESCE(excluded.last_commit_at,last_commit_at), next_due_at=excluded.next_due_at,
      outcome=excluded.outcome,fetched=excluded.fetched,inserted=excluded.inserted,
      duplicates=excluded.duplicates,skipped=excluded.skipped,failures=excluded.failures,error_class=excluded.error_class`)
    .run({ slug, now, request: data.requestSucceeded ? now : null,
      parsed: data.parsed ? now : null, committed: data.error || data.partial ? null : now,
      due: new Date(Date.now() + hours * 3600000).toISOString(), outcome,
      fetched: data.fetched || 0, inserted: data.inserted || 0, duplicates: data.duplicates || 0,
      skipped: data.skipped || 0, failures, error: data.error || null });
}
function lookbackHours(slug) {
  const db = require('../db/connection').getDB();
  const row = db?.prepare('SELECT last_commit_at FROM source_collection_state WHERE slug = ?').get(slug);
  const last = Date.parse(row?.last_commit_at || '');
  // Bound catch-up to 30 days; a feed/API cannot recover data its publisher removed.
  return Number.isFinite(last) ? Math.min(720, Math.max(36, (Date.now() - last) / 3600000 + 24)) : 168;
}
module.exports = { lookbackHours, withSourceSlot, withHostSlot, intervalHours, recordCollection };
