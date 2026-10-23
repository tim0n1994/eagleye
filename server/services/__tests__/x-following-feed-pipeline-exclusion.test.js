/**
 * Round 2 ① x-following feed 模式：01:00 pipeline 不再包含 X 抓取。
 *
 * Contract under test (CTO Round 2 方案 ①：「X 抓取移出 01:00 pipeline」，
 * X 改由每 2h 增量触发；触发机制（systemd timer / drain 式 oneshot）不在
 * 本文件范围):
 *
 *   fetchAllSources()（pipeline 的抓取阶段，server/connectors/index.js）在
 *   X_FOLLOWING_MODE=feed 下运行时，对 x-following 源不产生任何 twitter CLI
 *   调用（runReach feed / twitterUserPosts 均为 0），也不产出 X 条目；
 *   X_FOLLOWING_MODE=per-user 时 pipeline 仍包含 X（旧路径照常逐账号抓）。
 *
 *   断言刻意落在「可观测行为」上（零 CLI 调用、零条目），不规定实现位置：
 *   无论实现在 fetchAllSources 调度层跳过 x-following，还是 connector 在
 *   pipeline 上下文中空转（2h 增量 job 走 service 层单独触发 connector），
 *   都必须满足。
 *
 * RED（在未实现代码上）: 现有 connector 无视 X_FOLLOWING_MODE，一律走
 *   per-user 路径，pipeline 跑到 x-following 时必然调用 twitterUserPosts →
 *   「零 CLI 调用」断言以 expect 断言失败变红（非环境错误）。per-user
 *   GUARD 用例在旧代码上保持绿。
 *
 * CLI 全 mock（agent-reach stub）、DB 为临时库（EAGLEYE_DB_PATH），零真实
 * 网络/进程调用；TZ=Asia/Shanghai，时间不参与断言。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.TZ = 'Asia/Shanghai';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const X_FOLLOWING_PATH = path.resolve(import.meta.dirname, '../../connectors/x-following.js');
const INDEX_PATH = path.resolve(import.meta.dirname, '../../connectors/index.js');

const { getDB, closeDB } = require('../../db/connection');
const previousDbPath = process.env.EAGLEYE_DB_PATH;
let hermeticDbDir = null;

/** Compile a module file with selected requires replaced by stubs. */
function compileModule(filename, stubs) {
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

// 真实 x-following connector（外部依赖全 stub），其余 registry 源用空 stub。
async function runPipelineFetchAll() {
  const reach = {
    isReachReady: vi.fn(async () => true),
    twitterUserPosts: vi.fn(async () => ({ ok: true, data: [] })),
    runReach: vi.fn(async (cmd, args) => ({ ok: false, code: 'EXIT_1', message: `unexpected ${cmd} ${JSON.stringify(args)}`, stdout: '', stderr: '' })),
  };
  const ud = { getValue: vi.fn(() => null), setValue: vi.fn(), GLOBAL_SCOPE: '' };
  const cfg = {
    readXFollowingConfig: () => ({ users: ['alice', 'bob'], path: 'fixture', exists: true }),
    readBlocklist: () => new Set(),
  };
  const utils = { fetchURL: vi.fn(async () => { throw new Error('network disabled in test'); }) };

  const xFollowingModule = compileModule(X_FOLLOWING_PATH, {
    '../services/agent-reach': reach,
    '../services/utils': utils,
    '../services/x-following-config': cfg,
    '../db/user-data': ud,
    '../db/user-data.js': ud,
  });

  class StubConnector {
    constructor(slug) { this.slug = slug; }
    async fetch() { return []; }
    async saveItems() { return []; }
  }
  const stubConnectorModule = new Proxy({}, {
    get: (_target, prop) => (prop === '__esModule' ? false : StubConnector),
  });

  const { fetchAllSources } = compileModule(INDEX_PATH, {
    './x-following': xFollowingModule,
    './hn': stubConnectorModule,
    './github': stubConnectorModule,
    './rss': stubConnectorModule,
    './huggingface': stubConnectorModule,
    './arxiv': stubConnectorModule,
    './v2ex': stubConnectorModule,
    './lobsters': stubConnectorModule,
    './producthunt': stubConnectorModule,
    './startup-archive': stubConnectorModule,
    './appstore': stubConnectorModule,
    './sec-8k': stubConnectorModule,
    './humanoid': stubConnectorModule,
    './cn-photonics': stubConnectorModule,
    './reddit': stubConnectorModule,
    './xiaohongshu': stubConnectorModule,
  });

  const results = await fetchAllSources('20261020');
  return { results, reach };
}

describe('Round 2 ① pipeline 在 feed 模式下不含 X 抓取', () => {
  beforeAll(() => {
    hermeticDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-x-pipeline-'));
    process.env.EAGLEYE_DB_PATH = path.join(hermeticDbDir, 'hermetic.sqlite');
    const db = getDB();
    db.exec('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, slug TEXT UNIQUE, is_active INTEGER DEFAULT 1)');
    // x-following 保持 is_active=1：正因为它仍注册且激活，feed 模式的「跳过」
    // 才必须来自模式开关，而不是靠运营手段把源下线。lobsters 作对照源。
    db.prepare("INSERT OR REPLACE INTO sources (id, slug, is_active) VALUES ('src-x', 'x-following', 1)").run();
    db.prepare("INSERT OR REPLACE INTO sources (id, slug, is_active) VALUES ('src-lo', 'lobsters', 1)").run();
    closeDB();
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.X_FOLLOWING_MODE;
    delete process.env.X_FOLLOWING_INCLUDE_RT;
    delete process.env.X_FOLLOWING_USERS;
    delete process.env.X_FOLLOWING_TWEETS_PER_USER;
    delete process.env.X_FOLLOWING_CONCURRENCY;
    delete process.env.X_FOLLOWING_BATCH_DELAY_MS;
    delete process.env.X_FOLLOWING_BLOCKLIST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDB();
  });

  afterAll(() => {
    closeDB();
    if (previousDbPath === undefined) delete process.env.EAGLEYE_DB_PATH;
    else process.env.EAGLEYE_DB_PATH = previousDbPath;
    if (hermeticDbDir) fs.rmSync(hermeticDbDir, { recursive: true, force: true });
  });

  it('T8 X_FOLLOWING_MODE=feed：pipeline 抓取阶段对 X 零 CLI 调用、零条目', async () => {
    process.env.X_FOLLOWING_MODE = 'feed';
    const { results, reach } = await runPipelineFetchAll();

    const cliCalls = reach.runReach.mock.calls.length + reach.twitterUserPosts.mock.calls.length;
    expect(
      cliCalls,
      'feed 模式下 pipeline 对 x-following 不得产生任何 twitter CLI 调用（feed 与 user-posts 均不允许；X 由 2h 增量任务负责）',
    ).toBe(0);

    const xRow = results.find((r) => r.source === 'x-following');
    expect(
      xRow ? (xRow.items || 0) : 0,
      'pipeline 结果中 x-following 不得有条目（源被跳过时行可缺省，存在时必须为 0）',
    ).toBe(0);
    expect(xRow?.error, '跳过/空转不得以报错收场').toBeUndefined();
  });

  it('T8 GUARD X_FOLLOWING_MODE=per-user：pipeline 仍包含 X（旧路径照常抓）', async () => {
    process.env.X_FOLLOWING_MODE = 'per-user';
    const { reach } = await runPipelineFetchAll();

    const accounts = new Set(reach.twitterUserPosts.mock.calls.map((c) => String(c[0]).replace(/^@/, '')));
    expect(accounts.has('alice'), 'per-user 模式下 pipeline 必须照常逐账号抓 X').toBe(true);
  });
});
