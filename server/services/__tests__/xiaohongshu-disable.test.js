/**
 * D5 xiaohongshu disable (Round 1 decisions, ops scope).
 *
 * Contract under test:
 *
 * RED (fixture on the repo config file):
 *   The xiaohongshu collector is disabled in Round 1 (login state at the
 *   collection backend is dead). Besides the operational
 *   `UPDATE sources SET is_active=0 WHERE slug='xiaohongshu'`, the in-repo
 *   soft-disable must be visible in config/xiaohongshu-keywords.txt — either
 *   every keyword is commented out (connector then returns zero items, see
 *   xiaohongshu.js "no keywords configured" early return) or the file carries
 *   a disable note in a comment. On the unfixed code the file still has four
 *   active keywords and no disable note, so this assertion fails.
 *
 * GUARD (existing behavior that the disable relies on — must stay green):
 *   - a config file whose lines are all comments parses to zero keywords;
 *   - with zero keywords the connector's fetch() returns [] without touching
 *     any collection backend (agent-reach or the MCP server collector);
 *   - fetchAllSources() only schedules sources with is_active = 1, so the
 *     is_active=0 UPDATE (the primary disable switch) keeps the source out
 *     of the daily pipeline while the connector code stays registered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const { readXiaohongshuConfig, REPO_CONFIG_PATH } = require('../../services/xiaohongshu-config.js');

const XHS_PATH = path.resolve(import.meta.dirname, '../../connectors/xiaohongshu.js');
const INDEX_PATH = path.resolve(import.meta.dirname, '../../connectors/index.js');

function loadThrough(baseDir, id) {
  return require(id.startsWith('.') ? path.resolve(baseDir, id) : id);
}

/** Compile a connector file with selected requires replaced by stubs. */
function compileModule(filename, stubs) {
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.require = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return loadThrough(path.dirname(filename), id);
  };
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

describe('D5 xiaohongshu disable', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.XIAOHONGSHU_KEYWORDS;
    delete process.env.XIAOHONGSHU_CONFIG_PATH;
    delete process.env.EAGLEYE_XHS_MCP_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.XIAOHONGSHU_KEYWORDS;
    delete process.env.XIAOHONGSHU_CONFIG_PATH;
    delete process.env.EAGLEYE_XHS_MCP_URL;
  });

  it('repo keyword config is soft-disabled: all keywords commented out or a disable note present', () => {
    const raw = fs.readFileSync(REPO_CONFIG_PATH, 'utf8');
    const { keywords } = readXiaohongshuConfig();
    const hasDisableNote = /^#.*(停用|disabled?|deprecat|inactive)/im.test(raw);
    expect(
      keywords.length === 0 || hasDisableNote,
      'config/xiaohongshu-keywords.txt still yields active keywords with no disable note; ' +
      'D5 requires the xiaohongshu source to be disabled (comment out the keywords or add a disable note)',
    ).toBe(true);
  });

  it('guard: a fully commented keyword file parses to zero keywords', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-xhs-cfg-'));
    try {
      const cfgPath = path.join(tmp, 'xiaohongshu-keywords.txt');
      fs.writeFileSync(cfgPath, '# D5 disabled: collection backend login expired\n# AI\n# 大模型\n');
      process.env.XIAOHONGSHU_CONFIG_PATH = cfgPath;
      expect(readXiaohongshuConfig().keywords).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('guard: with zero keywords the connector fetch returns [] and never calls a collection backend', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-xhs-conn-'));
    try {
      const cfgPath = path.join(tmp, 'xiaohongshu-keywords.txt');
      fs.writeFileSync(cfgPath, '# D5 disabled\n');
      process.env.XIAOHONGSHU_CONFIG_PATH = cfgPath;

      const reachStub = {
        isReachReady: vi.fn(async () => true),
        xiaohongshuSearch: vi.fn(),
      };
      const collectorsStub = { xiaohongshuSearch: vi.fn() };
      const { XiaoHongShuConnector } = compileModule(XHS_PATH, {
        '../services/agent-reach': reachStub,
        '../services/server-collectors': collectorsStub,
      });

      const items = await new XiaoHongShuConnector().fetch('20261020');
      expect(items).toEqual([]);
      expect(reachStub.xiaohongshuSearch).not.toHaveBeenCalled();
      expect(collectorsStub.xiaohongshuSearch).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('guard: fetchAllSources schedules only is_active=1 sources (the is_active=0 disable switch)', async () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE sources (id INTEGER PRIMARY KEY, slug TEXT, is_active INTEGER)');
    db.prepare('INSERT INTO sources (slug, is_active) VALUES (?, 1)').run('still-active-source');
    db.prepare('INSERT INTO sources (slug, is_active) VALUES (?, 0)').run('disabled-source');

    // Stub every connector module so the real registry is not loaded.
    class StubConnector {
      constructor(slug) { this.slug = slug; }
      async fetch() { return []; }
      async saveItems() { return []; }
    }
    const stubConnectorModule = new Proxy({}, {
      get: (_target, prop) => (prop === '__esModule' ? false : StubConnector),
    });

    const { fetchAllSources } = compileModule(INDEX_PATH, {
      '../db/connection': { getDB: () => db },
      './base': { BaseConnector: StubConnector, parseItemLimit: () => undefined },
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
      './x-following': stubConnectorModule,
      './reddit': stubConnectorModule,
      './xiaohongshu': stubConnectorModule,
    });

    const attempted = [];
    await fetchAllSources('20261020', {
      onProgress: (p) => { if (p.current_source) attempted.push(p.current_source); },
    });

    expect(attempted).toContain('still-active-source');
    expect(attempted).not.toContain('disabled-source');
    db.close();
  });
});
