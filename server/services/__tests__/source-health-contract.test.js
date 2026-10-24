// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */

/**
 * Source-health reconciliation contract.
 *
 * These tests pin the observable behavior that makes stored health useful:
 * a fresh success is healthy only after its prior error is cleared, auth and
 * caller cancellation are distinct error classes, dup-only rounds clear the
 * prior error, fetchAllSources reconciles health after a terminal round, and
 * Startup Archive propagates upstream failures instead of reporting a clean
 * empty round.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');

const { evaluateHealth } = require('../source-health');
const { classifyFetchError } = require('../../connectors/base');

function compileServerModule(relativePath, resolveRequire) {
  const filename = path.resolve(__dirname, '../..', relativePath);
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = (id) => {
    const overridden = resolveRequire?.(id, path.dirname(filename));
    if (overridden !== undefined) return overridden;
    return require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

function loadMigrator(rawDb) {
  return compileServerModule('db/migrate.js', (id) => {
    if (id === './connection') return { getDB: () => rawDb };
    return undefined;
  });
}

describe('source health classification and reconciliation', () => {
  describe('evaluateHealth', () => {
    const now = new Date('2026-10-23T02:00:00Z');

    it('treats a fresh success with no unresolved error as healthy', () => {
      expect(evaluateHealth({
        lastSuccessAt: '2026-10-23T01:00:00Z',
        lastNewContentAt: null,
        lastErrorClass: null,
        now,
      })).toMatchObject({ status: 'healthy' });
    });

    it('keeps a fresh success stale while its last error is unresolved', () => {
      expect(evaluateHealth({
        lastSuccessAt: '2026-10-23T01:00:00Z',
        lastNewContentAt: null,
        lastErrorClass: 'auth',
        now,
      })).toMatchObject({ status: 'stale', reason: expect.stringContaining('unresolved last error auth') });
    });
  });

  describe('classifyFetchError', () => {
    it('separates auth, cancellation, timeout, and unclassified failures', () => {
      expect(classifyFetchError(Object.assign(new Error('authentication rejected'), {
        code: 'AUTH_REQUIRED',
      }))).toBe('auth');
      expect(classifyFetchError(Object.assign(new Error('upstream denied'), { status: 401 }))).toBe('auth');
      expect(classifyFetchError(Object.assign(new Error('upstream denied'), { upstreamStatus: 403 }))).toBe('auth');

      const cancelled = new Error('caller cancelled');
      cancelled.name = 'CancelledError';
      expect(classifyFetchError(cancelled)).toBe('cancelled');

      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      abort.code = 'ABORT_ERR';
      expect(classifyFetchError(abort)).toBe('timeout');

      expect(classifyFetchError(new Error('unexpected shape'))).toBe('unknown');
    });
  });

  describe('dup-only bookkeeping', () => {
    let db;
    let BaseConnector;
    let sourceId;

    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      loadMigrator(db).runMigrations();
      sourceId = db.prepare("SELECT id FROM sources WHERE slug = 'hacker-news'").get().id;
      db.prepare('UPDATE sources SET is_active = 1 WHERE id = ?').run(sourceId);
      db.prepare(`
        UPDATE sources SET
          last_success_at = '2026-10-01 00:00:00',
          last_new_content_at = '2026-10-01 00:00:00',
          last_error_class = 'http_503',
          health_status = 'failing',
          consecutive_empty = 2
        WHERE id = ?
      `).run(sourceId);

      BaseConnector = compileServerModule('connectors/base.js', (id) => {
        if (id === '../db/connection') return { getDB: () => db };
        if (id === '../services/utils') return require('../utils');
        if (id === '../services/date-contract') return require('../date-contract');
        if (id === '../services/x-following-config') return { readBlocklist: () => new Set(), isBlocked: () => false };
        if (id === '../services/outbox') return require('../outbox');
        return undefined;
      }).BaseConnector;
    });

    afterEach(() => {
      db.close();
    });

    it('clears the prior error and refreshes success without changing the empty streak', () => {
      db.prepare(`
        INSERT INTO information_items
          (id, source_id, canonical_url, title, digest_date, content_hash)
        VALUES ('prior-item', ?, 'https://example.com/repeat', 'Prior', '2026-10-22', 'prior-hash')
      `).run(sourceId);

      class TestConnector extends BaseConnector {
        constructor() { super('hacker-news'); }
      }
      const connector = new TestConnector();
      const item = connector.normalize({
        title: 'Repeated',
        url: 'https://example.com/repeat',
        publishedAt: '2026-10-23T01:00:00Z',
      });
      item.digest_date = '2026-10-23';
      item.content_hash = 'new-hash';

      const result = connector.saveItems([item], { returnDetails: true });
      expect(result).toMatchObject({ inserted: 0, existing: 0, duplicates: 1, failed: 0 });

      const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
      expect(row.last_error_class).toBeNull();
      expect(row.last_success_at).toBeTruthy();
      expect(Date.parse(row.last_success_at.replace(' ', 'T') + 'Z')).toBeGreaterThan(
        Date.parse('2026-10-01T00:00:00Z'),
      );
      expect(row.last_new_content_at).toBe('2026-10-01 00:00:00');
      expect(row.consecutive_empty).toBe(2);
    });
  });

  describe('fetchAllSources terminal reconciliation', () => {
    let db;

    beforeEach(() => {
      db = new Database(':memory:');
      db.exec(`
        CREATE TABLE sources (
          id INTEGER PRIMARY KEY,
          slug TEXT UNIQUE,
          is_active INTEGER NOT NULL,
          refresh_cron TEXT,
          last_attempt_at TEXT,
          last_success_at TEXT,
          last_new_content_at TEXT,
          last_error_class TEXT,
          health_status TEXT,
          consecutive_empty INTEGER DEFAULT 0
        )
      `);
      const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
      db.prepare(`
        INSERT INTO sources
          (slug, is_active, refresh_cron, last_success_at, last_error_class, health_status)
        VALUES ('hacker-news', 1, '0 1 * * *', ?, NULL, 'stale')
      `).run(nowSql);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
      db.close();
    });

    it('recomputes stored health after the fetch round is terminal', async () => {
      class ProbeConnector {
        async fetch() { return []; }
        saveItems() {
          return { items: [], inserted: 0, existing: 0, duplicates: 0, skipped: 0, failed: 0 };
        }
      }
      const connectorModule = new Proxy({}, {
        get(_target, prop) {
          if (prop === '__esModule') return false;
          return typeof prop === 'string' ? ProbeConnector : undefined;
        },
      });
      const { fetchAllSources } = compileServerModule('connectors/index.js', (id) => {
        if (id === '../db/connection') return { getDB: () => db };
        if (id === './base') return require('../../connectors/base');
        if (id.startsWith('./')) return connectorModule;
        return undefined;
      });

      const rows = await fetchAllSources('2026-10-23');
      expect(rows).toEqual([expect.objectContaining({
        source: 'hacker-news',
        items: 0,
        duplicates: 0,
        duration_ms: expect.any(Number),
        retries: 0,
        notModified: 0,
      })]);
      expect(db.prepare('SELECT health_status FROM sources WHERE slug = ?').get('hacker-news'))
        .toEqual({ health_status: 'healthy' });
    });
  });

  describe('Startup Archive failure propagation', () => {
    it('rejects instead of turning an upstream failure into an empty array', async () => {
      const { StartupArchiveConnector } = compileServerModule('connectors/startup-archive.js', (id) => {
        if (id === './base') return require('../../connectors/base');
        if (id === '../services/utils') {
          return {
            ...require('../utils'),
            fetchURL: async () => { throw new Error('archive upstream failed'); },
          };
        }
        if (id === '../services/date-contract') return require('../date-contract');
        return undefined;
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(new StartupArchiveConnector().fetch('2026-10-23'))
          .rejects.toThrow('archive upstream failed');
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
