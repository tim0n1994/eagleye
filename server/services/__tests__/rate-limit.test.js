/* global describe, it, expect */
// Server tests run under Vitest with `globals: true`, so describe/it/expect are
// ambient. Using require keeps this file CommonJS, matching the rest of server/.
const { clientKey, hit, reset } = require('../rate-limit.js');

describe('clientKey', () => {
  it('prefers CF-Connecting-IP so tunnelled callers are distinguished', () => {
    // Every tunnelled request arrives from 127.0.0.1; without the header the
    // limiter would be global and one attacker could lock out everyone.
    const req = {
      headers: { 'cf-connecting-ip': '203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    expect(clientKey(req)).toBe('203.0.113.9');
  });

  it('falls back to the socket address for direct local hits', () => {
    expect(clientKey({ headers: {}, socket: { remoteAddress: '127.0.0.1' } })).toBe('127.0.0.1');
  });

  it('returns a stable placeholder when neither is present', () => {
    expect(clientKey({})).toBe('unknown');
  });
});

describe('hit', () => {
  const opts = { windowMs: 1000, max: 3 };

  it('allows attempts up to the limit, then blocks', () => {
    const store = new Map();
    expect(hit(store, 'a', 0, opts).limited).toBe(false);
    expect(hit(store, 'a', 10, opts).limited).toBe(false);
    expect(hit(store, 'a', 20, opts).limited).toBe(false);
    expect(hit(store, 'a', 30, opts).limited).toBe(true);
  });

  it('counts down remaining budget', () => {
    const store = new Map();
    expect(hit(store, 'a', 0, opts).remaining).toBe(2);
    expect(hit(store, 'a', 1, opts).remaining).toBe(1);
    expect(hit(store, 'a', 2, opts).remaining).toBe(0);
  });

  it('tracks each key independently', () => {
    const store = new Map();
    hit(store, 'a', 0, opts);
    hit(store, 'a', 1, opts);
    hit(store, 'a', 2, opts);
    expect(hit(store, 'a', 3, opts).limited).toBe(true);
    expect(hit(store, 'b', 3, opts).limited).toBe(false);
  });

  it('lets attempts through again once the window slides past', () => {
    const store = new Map();
    hit(store, 'a', 0, opts);
    hit(store, 'a', 1, opts);
    hit(store, 'a', 2, opts);
    expect(hit(store, 'a', 3, opts).limited).toBe(true);
    // All three attempts are now older than windowMs.
    expect(hit(store, 'a', 1500, opts).limited).toBe(false);
  });

  it('reports how long to wait while blocked', () => {
    const store = new Map();
    hit(store, 'a', 0, opts);
    hit(store, 'a', 0, opts);
    hit(store, 'a', 0, opts);
    expect(hit(store, 'a', 400, opts).retryAfterSec).toBe(1);
  });

  it('does not consume budget while blocked', () => {
    const store = new Map();
    for (let i = 0; i < 3; i++) hit(store, 'a', i, opts);
    hit(store, 'a', 50, opts);
    hit(store, 'a', 60, opts);
    // Still exactly the 3 original attempts — blocked calls must not extend
    // the window, or an attacker could never age out.
    expect(store.get('a')).toHaveLength(3);
  });
});

describe('reset', () => {
  it('clears the budget so a successful login is not punished', () => {
    const store = new Map();
    const opts = { windowMs: 1000, max: 3 };
    for (let i = 0; i < 3; i++) hit(store, 'a', i, opts);
    expect(hit(store, 'a', 4, opts).limited).toBe(true);
    reset(store, 'a');
    expect(hit(store, 'a', 5, opts).limited).toBe(false);
  });
});
