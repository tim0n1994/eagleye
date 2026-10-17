/**
 * Eagleye — Transactional Outbox (R0-07)
 *
 * At-least-once delivery for post-commit side effects (search indexing,
 * pending-signal counters, future Elasticsearch fan-out).
 *
 * Producer contract: registerEvent() runs inside the same transaction as the
 * business writes it describes, so committed data and its pending event land
 * atomically (§7.4: the collection checkpoint only advances when both are
 * durable).
 *
 * Consumer contract: drainOutbox() runs the handler first and marks the event
 * dispatched afterwards; a crash in between causes redelivery, so handlers
 * MUST dedup by business identity (uniqueKey). Failures increment attempts
 * and record last_error; at attempts >= maxAttempts the event stops being
 * dispatched and stays queryable as a dead letter.
 *
 * @typedef {Object} OutboxEventInput
 * @property {string} type
 * @property {Object} [payload]
 * @property {string|null} [uniqueKey] Idempotency identity consumed by dedup.
 * @property {string|null} [id]
 */

const { randomUUID } = require('node:crypto');

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function assertPositiveInteger(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer >= 1`);
  }
  return value;
}

/**
 * @param {{ prepare: Function }} db
 * @param {string} caller
 * @returns {void}
 */
function assertDatabase(db, caller) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError(`${caller} requires a better-sqlite3 database handle`);
  }
}

/**
 * Register a pending delivery event inside the caller's transaction. Returns
 * true when a new row was inserted, false when the unique_key was already
 * registered (absorbed by the UNIQUE constraint).
 *
 * @param {{ prepare: Function }} db
 * @param {OutboxEventInput} event
 * @returns {boolean}
 */
function registerEvent(db, event) {
  assertDatabase(db, 'registerEvent');
  const { type, payload, uniqueKey = null, id = null } = event || {};
  if (!type) throw new TypeError('registerEvent requires an event type');
  const info = db.prepare(`
    INSERT INTO outbox (id, event_type, payload, unique_key)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(unique_key) DO NOTHING
  `).run(id || randomUUID(), String(type), JSON.stringify(payload ?? {}), uniqueKey);
  return info.changes > 0;
}

/**
 * Dispatch pending events (dispatched_at IS NULL, attempts < maxAttempts)
 * oldest first. Each event runs the (possibly async) handler, then a short
 * transaction marks it dispatched; a handler failure records
 * attempts + last_error in its own short transaction and is retried on the
 * next drain until it exceeds maxAttempts.
 *
 * @param {{ prepare: Function }} db
 * @param {(event: { id: string, type: string, payload: Object, uniqueKey: string|null }) => unknown} handler
 * @param {{ limit?: number, maxAttempts?: number }} [options]
 * @returns {Promise<{ dispatched: string[], failed: Array<{id: string, type: string, attempts: number, dead: boolean, error: string}> }>}
 */
async function drainOutbox(db, handler, { limit = DEFAULT_LIMIT, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  assertDatabase(db, 'drainOutbox');
  assertPositiveInteger(limit, 'limit');
  assertPositiveInteger(maxAttempts, 'maxAttempts');

  const pending = db.prepare(`
    SELECT id, event_type, payload, unique_key, attempts
    FROM outbox
    WHERE dispatched_at IS NULL AND attempts < ?
    ORDER BY created_at, rowid
    LIMIT ?
  `);
  const markDispatched = db.prepare(
    "UPDATE outbox SET dispatched_at = datetime('now'), last_error = NULL WHERE id = ?"
  );
  const recordFailure = db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?');

  const dispatched = [];
  const failed = [];
  for (const event of pending.all(maxAttempts, limit)) {
    try {
      await handler({
        id: event.id,
        type: event.event_type,
        payload: JSON.parse(event.payload),
        uniqueKey: event.unique_key,
      });
    } catch (err) {
      const attempts = event.attempts + 1;
      const message = err && err.message ? err.message : String(err);
      recordFailure.run(message, event.id);
      failed.push({ id: event.id, type: event.event_type, attempts, dead: attempts >= maxAttempts, error: message });
      continue;
    }
    markDispatched.run(event.id);
    dispatched.push(event.id);
  }
  return { dispatched, failed };
}

module.exports = { registerEvent, drainOutbox };
