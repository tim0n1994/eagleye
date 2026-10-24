/**
 * Eagleye transactional outbox consumer.
 *
 * The current producer event is item_index_pending. SQLite FTS5 is maintained
 * synchronously for new/updated items, so the consumer is deliberately
 * idempotent: it verifies the FTS row and repairs it only when the row is
 * genuinely missing before acknowledging the event.
 */

const { drainOutbox } = require('./outbox');

const INDEX_EVENT = 'item_index_pending';

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'shadow') AND name = ?"
  ).get(name));
}

function readItem(db, itemId) {
  return db.prepare(`
    SELECT rowid, id, title, title_zh, original_summary
    FROM information_items
    WHERE id = ?
  `).get(itemId);
}

/**
 * Verify or repair one index event. Throwing leaves the event pending and
 * increments its retry count in drainOutbox; an orphan event is never
 * silently acknowledged.
 */
function consumeIndexEvent(db, event) {
  if (event.type !== INDEX_EVENT) {
    throw new Error(`unsupported outbox event type: ${event.type}`);
  }
  const itemId = event.payload?.item_id;
  if (!itemId) throw new Error('item_index_pending payload missing item_id');
  if (!tableExists(db, 'items_fts')) throw new Error('items_fts table is unavailable');

  const item = readItem(db, itemId);
  if (!item) throw new Error(`information item not found: ${itemId}`);

  const existing = db.prepare('SELECT 1 FROM items_fts WHERE rowid = ?').get(item.rowid);
  if (existing) return { item_id: itemId, repaired: false };

  db.prepare(`
    INSERT INTO items_fts(rowid, title, title_zh, summary)
    VALUES (?, ?, COALESCE(?, ''), COALESCE(?, ''))
  `).run(item.rowid, item.title, item.title_zh, item.original_summary);
  return { item_id: itemId, repaired: true };
}

async function drainIndexOutbox(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('drainIndexOutbox requires a better-sqlite3 database handle');
  }
  return drainOutbox(db, event => consumeIndexEvent(db, event), options);
}

module.exports = { INDEX_EVENT, consumeIndexEvent, drainIndexOutbox };
