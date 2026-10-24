// @vitest-environment node
/* global describe, it, expect, beforeEach, afterEach, vi */

/**
 * D2 日期契约（时间窗判新）— 共享 helper 契约测试（RED 先行）。
 *
 * 契约：server/services/date-contract.js 必须导出
 *
 *   isWithinFetchWindow(published, options?) -> boolean
 *
 *   published: epoch 毫秒数，或 'YYYYMMDD' 压缩串（决策 D2 指定两种输入形态；
 *              额外接受 'YYYY-MM-DD' / Date 实例不禁止，但不在本契约测试范围内）
 *   options.now?:          epoch 毫秒，缺省取 Date.now()
 *   options.lookbackHours?: 回看窗口小时数，默认 36
 *   options.futureHours?:   未来容差小时数，默认 1
 *
 *   判新规则（闭区间）：now - lookbackHours*3600e3 <= published <= now + futureHours*3600e3
 *   published 缺失 / 无法解析 → 一律 false（窗外）。
 *
 * 环境变量可配置 LOOKBACK（默认 36h，命名随仓库惯例）不在本测试固定名称，
 * 由实现方自选；本测试通过 options.lookbackHours 验证可配置性。
 *
 * 时间基准：伪造 now = 2026-10-20 01:00 Asia/Shanghai（= 2026-10-19 17:00 UTC），
 * 即每日 01:00 CST 调度时刻。全程不依赖真实时间。
 */

process.env.TZ = 'Asia/Shanghai';

const { vi } = globalThis; // globals: true（vitest 4 的 CJS 测试不可 require('vitest')）
const dateContract = require('../date-contract');

const HOUR = 3600e3;
// 01:00 CST 边界样例基准时刻：本地 2026-10-20 01:00（digest 日期 2026-10-20）
const NOW = Date.UTC(2026, 9, 19, 17, 0, 0);

/** RED 守卫：先断言 helper 存在，保证未修复代码上的失败是断言失败而非 TypeError。 */
function helper() {
  expect(
    typeof dateContract.isWithinFetchWindow,
    "date-contract.js 必须导出共享时间窗 helper isWithinFetchWindow(published, options)（D2）"
  ).toBe('function');
  return dateContract.isWithinFetchWindow;
}

describe('D2 fetch time-window contract (isWithinFetchWindow)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports the shared helper from date-contract.js', () => {
    expect(typeof dateContract.isWithinFetchWindow).toBe('function');
  });

  it('01:00 CST boundary sample 1: cross-UTC-day item published 7h ago is inside the 36h window', () => {
    // 条目发布于 2026-10-19T10:00:00Z（= now − 7h，UTC 日期 2026-10-19 ≠ 本地 digest 日期 2026-10-20）。
    // 旧的“本地 digest 日期 == 条目 UTC 日期”严格相等过滤会错杀它；时间窗必须放行。
    expect(helper()(NOW - 7 * HOUR, { now: NOW })).toBe(true);
  });

  it('01:00 CST boundary sample 2: item published 40h ago is excluded', () => {
    // 2026-10-17T01:00:00Z = now − 40h，超出 36h 回看窗口。
    expect(helper()(NOW - 40 * HOUR, { now: NOW })).toBe(false);
  });

  it('01:00 CST boundary sample 3: timestamps after now + 1h are excluded', () => {
    expect(helper()(NOW + 2 * HOUR, { now: NOW })).toBe(false);
    expect(helper()(NOW + 7 * HOUR, { now: NOW })).toBe(false); // UTC 日期恰为 digest 日期也一样排除
  });

  it('window edges are inclusive: exactly now-36h and now+1h pass, one tick beyond fails', () => {
    const fn = helper();
    expect(fn(NOW - 36 * HOUR, { now: NOW })).toBe(true);
    expect(fn(NOW - 36 * HOUR - 1, { now: NOW })).toBe(false);
    expect(fn(NOW + 1 * HOUR, { now: NOW })).toBe(true);
    expect(fn(NOW + 1 * HOUR + 1, { now: NOW })).toBe(false);
  });

  it('accepts compact YYYYMMDD input (midnight-of-day resolution)', () => {
    const fn = helper();
    // now = 2026-10-19T17:00Z：'20261019'（当天，无论按 UTC 还是本地零点解析都远在 36h 内）→ 通过
    expect(fn('20261019', { now: NOW })).toBe(true);
    // '20261016' 距 now ≥ 65h（两种零点解析皆然）→ 排除
    expect(fn('20261016', { now: NOW })).toBe(false);
    // 未来日期 → 排除
    expect(fn('20261021', { now: NOW })).toBe(false);
  });

  it('lookbackHours / futureHours are configurable via options', () => {
    const fn = helper();
    expect(fn(NOW - 7 * HOUR, { now: NOW, lookbackHours: 6 })).toBe(false);
    expect(fn(NOW - 40 * HOUR, { now: NOW, lookbackHours: 48 })).toBe(true);
    expect(fn(NOW + 2 * HOUR, { now: NOW, futureHours: 3 })).toBe(true);
  });

  it('defaults now to Date.now() (verified with a faked clock)', () => {
    const fn = helper();
    expect(fn(NOW - 7 * HOUR)).toBe(true);
    expect(fn(NOW - 40 * HOUR)).toBe(false);
  });

  it('missing or unparseable input is always outside the window', () => {
    const fn = helper();
    expect(fn(null, { now: NOW })).toBe(false);
    expect(fn(undefined, { now: NOW })).toBe(false);
    expect(fn(NaN, { now: NOW })).toBe(false);
    expect(fn('not-a-date', { now: NOW })).toBe(false);
  });
});
