/**
 * D6 X_FOLLOWING_TWEETS_PER_USER default 10 -> 5 (Round 1 decisions, ops scope).
 *
 * Contract under test:
 *   server/connectors/x-following.js fetch() resolves the per-user tweet
 *   count via envInt('X_FOLLOWING_TWEETS_PER_USER', <default>, 1, 40) and
 *   forwards it as the `count` argument of reach.twitterUserPosts().
 *
 *   CTO 裁决（2026-10-23）：旧逐账号路径只能通过精确显式
 *   X_FOLLOWING_MODE=per-user 进入；这些用例固定使用该 legacy escape hatch。
 *
 *   RED: with the env var unset, the default forwarded per user must be 5
 *        (D6 lowers it from 10). On the unfixed code the connector forwards
 *        10, so the assertion fails.
 *   GUARD: an explicit env value keeps priority (no env pinning exists on the
 *        deployment side, so the code default is the effective value).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const X_FOLLOWING_PATH = path.resolve(import.meta.dirname, '../../connectors/x-following.js');

// Hermetic fixture (§7 Q7 裁决 A, 2026-10-20: EAGLEYE_DB_PATH + mkdtemp 形态，
// 取代 8e9f068 的 null-connection 桩). The connector under test extends the
// REAL BaseConnector, whose getSourceId() calls the real ../db/connection
// getDB() — which lazily auto-opens eagleye.db at the process cwd. In the
// main checkout that file is the production database (has the sources
// table), so the suite passed there; in a fresh worktree getDB()
// auto-creates an EMPTY database and getSourceId() throws
// `no such table: sources` (pristine d4a8e9b baseline fails identically,
// see /tmp/r11-baseline-full.log:104-105). Instead of stubbing the
// connection, point the REAL connection at a throwaway database under a
// mkdtemp directory and create the minimal `sources` table getSourceId()
// probes (`SELECT id FROM sources WHERE slug = ?`; no matching row → ''
// via the documented degrade path, so test-case behavior is unchanged and
// assertions are untouched). Same shape as database-path.test.js /
// runtime-switches-routes.test.js / content-sufficiency.test.js.
const previousDbPath = process.env.EAGLEYE_DB_PATH;
const previousMode = process.env.X_FOLLOWING_MODE;
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-x-following-'));
process.env.EAGLEYE_DB_PATH = path.join(fixtureDir, 'x-following.sqlite');
const { getDB, closeDB } = require('../../db/connection');
getDB().exec('CREATE TABLE sources (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL)');

const TWEETS = Array.from({ length: 20 }, (_, i) => ({
  id: String(1000 + i),
  text: `fixture tweet ${i}`,
  createdAtISO: '2026-10-19T10:00:00Z',
  metrics: { views: 100, likes: 10, retweets: 1, replies: 1, bookmarks: 0 },
  author: { screenName: 'testuser' },
  lang: 'en',
}));

function compileXFollowingConnector(twitterUserPosts) {
  const subject = new Module(X_FOLLOWING_PATH, module);
  subject.filename = X_FOLLOWING_PATH;
  subject.require = (id) => {
    if (id === '../services/agent-reach') {
      return { isReachReady: vi.fn(async () => true), twitterUserPosts };
    }
    if (id === '../services/utils') return { fetchURL: vi.fn(async () => '') };
    if (id === '../services/x-following-config') {
      return { readXFollowingConfig: () => ({ users: ['testuser'], path: 'fixture', exists: true }) };
    }
    return require(id.startsWith('.') ? path.resolve(path.dirname(X_FOLLOWING_PATH), id) : id);
  };
  subject._compile(fs.readFileSync(X_FOLLOWING_PATH, 'utf8'), X_FOLLOWING_PATH);
  return subject.exports;
}

describe('D6 X_FOLLOWING_TWEETS_PER_USER default', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.X_FOLLOWING_MODE = 'per-user';
    delete process.env.X_FOLLOWING_TWEETS_PER_USER;
    delete process.env.X_FOLLOWING_CONCURRENCY;
    delete process.env.X_FOLLOWING_BATCH_DELAY_MS;
    delete process.env.X_FOLLOWING_USERS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.X_FOLLOWING_MODE;
    delete process.env.X_FOLLOWING_TWEETS_PER_USER;
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.X_FOLLOWING_MODE;
    else process.env.X_FOLLOWING_MODE = previousMode;
    delete process.env.X_FOLLOWING_TWEETS_PER_USER;
    delete process.env.X_FOLLOWING_CONCURRENCY;
    delete process.env.X_FOLLOWING_BATCH_DELAY_MS;
    delete process.env.X_FOLLOWING_USERS;
    closeDB();
    if (previousDbPath === undefined) delete process.env.EAGLEYE_DB_PATH;
    else process.env.EAGLEYE_DB_PATH = previousDbPath;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('defaults to 5 tweets per user when the env var is unset', async () => {
    const twitterUserPosts = vi.fn(async () => ({ ok: true, data: TWEETS }));
    const { XFollowingConnector } = compileXFollowingConnector(twitterUserPosts);
    const connector = new XFollowingConnector();

    const items = await connector.fetch('20261020');

    expect(Array.isArray(items)).toBe(true);
    expect(twitterUserPosts).toHaveBeenCalledWith('testuser', 5, expect.anything());
  });

  it('guard: an explicit env value still overrides the default', async () => {
    process.env.X_FOLLOWING_TWEETS_PER_USER = '7';
    const twitterUserPosts = vi.fn(async () => ({ ok: true, data: TWEETS }));
    const { XFollowingConnector } = compileXFollowingConnector(twitterUserPosts);
    const connector = new XFollowingConnector();

    await connector.fetch('20261020');

    expect(twitterUserPosts).toHaveBeenCalledWith('testuser', 7, expect.anything());
  });
});
