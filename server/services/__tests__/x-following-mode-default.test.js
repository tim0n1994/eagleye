/**
 * Round 2 CTO 裁决钉死：X_FOLLOWING_MODE 默认值语义（feed 是安全默认）。
 *
 * Contract under test (server/connectors/x-following.js):
 *   resolveXMode() 在调用时读取 process.env.X_FOLLOWING_MODE ——
 *     - 未设置（env 缺失）  → 'feed'（避免启动时隐式触发 442 账号扫描）
 *     - 显式 'feed'         → 'feed'
 *     - 精确显式 'per-user' → 'per-user'（旧逐账号路径必须显式选择）
 *   resolveXMode 是模块私有函数；公开静态缝隙是
 *   XFollowingConnector.resolveMode()（x-following.js:174-176，
 *   `static resolveMode() { return resolveXMode(); }`），本文件经该缝隙断言。
 *
 *
 * Hermetic fixture（§7 Q7 裁决 A，2026-10-20；与
 *   x-following-per-user-default.test.js:30-38 同形态）：EAGLEYE_DB_PATH
 *   指向 mkdtemp 临时库并建最小 sources 表，require 链路上的真实
 *   ../db/connection 绝不触碰 worktree/生产 eagleye.db。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ─── Hermetic DB（必须在 require connector 之前就位）────────────────────
const previousDbPath = process.env.EAGLEYE_DB_PATH;
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagleye-x-mode-'));
process.env.EAGLEYE_DB_PATH = path.join(fixtureDir, 'x-mode.sqlite');
const { getDB, closeDB } = require('../../db/connection');
getDB().exec('CREATE TABLE sources (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL)');

const { XFollowingConnector } = require('../../connectors/x-following.js');

const previousMode = process.env.X_FOLLOWING_MODE;

describe('CTO 裁决: X_FOLLOWING_MODE 默认 feed', () => {
  beforeEach(() => {
    delete process.env.X_FOLLOWING_MODE;
  });

  afterEach(() => {
    delete process.env.X_FOLLOWING_MODE;
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.X_FOLLOWING_MODE;
    else process.env.X_FOLLOWING_MODE = previousMode;
    closeDB();
    if (previousDbPath === undefined) delete process.env.EAGLEYE_DB_PATH;
    else process.env.EAGLEYE_DB_PATH = previousDbPath;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('未设置 X_FOLLOWING_MODE 时 resolveXMode() === "feed"', () => {
    // 前置：确证本轮 env 真的未设置（防外层注入导致测到别的语义）
    expect(Object.prototype.hasOwnProperty.call(process.env, 'X_FOLLOWING_MODE')).toBe(false);
    expect(XFollowingConnector.resolveMode()).toBe('feed');
  });

  it('GUARD 显式 X_FOLLOWING_MODE="feed" 时 resolveXMode() === "feed"', () => {
    process.env.X_FOLLOWING_MODE = 'feed';
    expect(XFollowingConnector.resolveMode()).toBe('feed');
  });

  it('GUARD 显式 X_FOLLOWING_MODE="per-user" 时 resolveXMode() === "per-user"', () => {
    process.env.X_FOLLOWING_MODE = 'per-user';
    expect(XFollowingConnector.resolveMode()).toBe('per-user');
  });

  it('GUARD 非 per-user 取值仍走 feed', () => {
    process.env.X_FOLLOWING_MODE = 'per_user';
    expect(XFollowingConnector.resolveMode()).toBe('feed');
  });
});
