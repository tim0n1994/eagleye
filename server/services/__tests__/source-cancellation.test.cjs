const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

function load(file, mocks = {}, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8'), {
    module, require: name => name in mocks ? mocks[name] : require(name),
    process: { env }, console: { log() {}, warn() {}, error() {} },
    AbortController, URL, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename: file });
  return module.exports;
}

function registry(fetch, env = {}) {
  const calls = { saved: 0, fetched: 0, signals: [] };
  class Connector {
    fetch(date, opts) {
      calls.fetched++;
      calls.signals.push(opts.signal);
      return fetch(date, opts);
    }
    saveItems(items) { calls.saved++; return items; }
  }
  const code = fs.readFileSync(path.resolve(__dirname, '../../connectors/index.js'), 'utf8');
  const mocks = Object.fromEntries([...code.matchAll(/require\('(\.\/[^']+)'\)/g)]
    .map(([, name]) => [name, new Proxy({}, { get: () => Connector })]));
  mocks['./base'] = { parseItemLimit: value => value };
  mocks['../services/date-contract'] = { compactDigestDate: value => value };
  // CTO 03:40 retry patch: connectors/index.js now requires the shared utils
  // for runWithFetchContext (per-source stats/signal propagation). The real
  // module is used so the ALS wrapper runs inside these cancellation cases;
  // the Proxy connectors never call fetchURL, so no network is involved.
  mocks['../services/utils'] = require('../utils');
  mocks['../db/connection'] = { getDB: () => ({ prepare: () => ({ all: () => [{ slug: 'hacker-news' }, { slug: 'x-following' }] }) }) };
  return { ...load('connectors/index.js', mocks, env), calls };
}

test('deadline rejects and a signal-ignoring late return never saves', async () => {
  let release;
  const h = registry(() => new Promise(resolve => { release = resolve; }), { SOURCE_TIMEOUT_MS: '15' });
  await assert.rejects(h.fetchSource('hacker-news', '20261016'), { name: 'TimeoutError' });
  assert.equal(h.calls.signals[0].aborted, true);
  release([{}]);
  await sleep(10);
  assert.equal(h.calls.saved, 0);
});

test('preabort starts no connector; midflight cancellation prevents late save', async () => {
  let release;
  const h = registry(() => new Promise(resolve => { release = resolve; }));
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(h.fetchSource('hacker-news', '', { signal: pre.signal }), { name: 'AbortError' });
  assert.equal(h.calls.fetched, 0);
  const controller = new AbortController();
  const pending = h.fetchSource('hacker-news', '', { signal: controller.signal });
  await sleep(0);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  release([{}]);
  await sleep(0);
  assert.equal(h.calls.saved, 0);
  assert.equal(h.calls.signals[0].aborted, true);
});

test('X override is independent of generic source deadline in full fetch', async () => {
  const h = registry(async () => { await sleep(40); return [{}]; }, {
    SOURCE_TIMEOUT_MS: '10', SOURCE_TIMEOUT_X_FOLLOWING_MS: '200',
  });
  const results = await h.fetchAllSources('20261016');
  assert.match(results.find(r => r.source === 'hacker-news').error, /10ms budget/);
  assert.equal(results.find(r => r.source === 'x-following').items, 1);
  assert.equal(h.calls.saved, 1);
});

test('synchronous overrun cannot outrun the deadline timer and save', async () => {
  const h = registry(() => {
    const until = Date.now() + 20;
    while (Date.now() < until) { /* Block the event loop past the deadline to exercise the pre-save guard. */ }
    return [{}];
  }, { SOURCE_TIMEOUT_MS: '5' });
  await assert.rejects(h.fetchSource('hacker-news', ''), { name: 'TimeoutError' });
  assert.equal(h.calls.saved, 0);
});

test('browser collection uses its source budget without extending other sources', async () => {
  const h = registry(async () => { await sleep(30); return [{}]; }, {
    SOURCE_TIMEOUT_MS: '5', SOURCE_TIMEOUT_XIAOHONGSHU_MS: '200',
  });
  await assert.rejects(h.fetchSource('hacker-news', ''), { name: 'TimeoutError' });
  assert.equal((await h.fetchSource('xiaohongshu', '')).length, 1);
  assert.equal(h.calls.saved, 1);
});

test('sync full and single source pass cancellation through registry and skip enrichment', async () => {
  for (const single of [false, true]) {
    const h = registry(async () => { await sleep(30); return [{}]; });
    let enrichCalls = 0;
    const sync = load('services/sync.js', {
      '../connectors/index': h,
      './llm': { enrichItems: () => { enrichCalls++; } },
      './jobs': { isJobCancelled: () => false },
      './date-contract': { normalizeDigestDate: value => value, todayDigestDate: () => '20261016' },
    });
    const controller = new AbortController();
    const pending = single ? sync.syncSource('hacker-news', '', { signal: controller.signal })
      : sync.syncAllSources({ signal: controller.signal });
    await sleep(0);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await sleep(40);
    assert.equal(h.calls.saved, 0);
    assert.equal(enrichCalls, 0);
    assert.ok(h.calls.signals.every(signal => signal.aborted));
  }
});

function xConnector(reach, fetchURL, env = {}) {
  class BaseConnector { normalize(raw) { return raw; } }
  const { XFollowingConnector } = load('connectors/x-following.js', {
    './base': { BaseConnector }, '../services/utils': { fetchURL },
    '../services/x-following-config': { readXFollowingConfig: () => ({ users: [] }) },
    '../services/agent-reach': reach,
    // Round 2 ①: feed is now the default. These cancellation and breaker
    // cases target the explicit per-user legacy lane, so pin its mode rather
    // than relying on the obsolete default.
    '../db/user-data': { getValue: () => null, setValue: () => {}, GLOBAL_SCOPE: '' },
  }, {
    X_FOLLOWING_MODE: 'per-user',
    X_FOLLOWING_CONCURRENCY: '1',
    X_FOLLOWING_CIRCUIT_FAILURES: '3',
    ...env,
  });
  const connector = new XFollowingConnector();
  connector.loadUserList = () => ['one', 'two', 'three', 'four', 'five'];
  return connector;
}

test('twitter breaker actually fetches remaining users via Jina', async () => {
  const urls = [];
  const x = xConnector({ isReachReady: async () => true, twitterUserPosts: async () => ({ ok: true, data: [] }) },
    async url => { urls.push(url); return 'x'.repeat(120); });
  x.parseJinaMarkdown = () => [{ id: '1', text: 'post', likes: 0, retweets: 0, views: 0 }];
  const items = await x.fetch('20261016');
  assert.equal(items.length, 2);
  assert.deepEqual(urls.map(url => url.split('/').at(-1)), ['four', 'five']);
  assert.ok(items.every(item => item.sourcePayload.backend === 'jina'));
});

test('X preabort avoids readiness; Jina midflight abort is not swallowed', async () => {
  let readiness = 0;
  const x = xConnector({ isReachReady: async () => { readiness++; return false; } },
    async (_url, { signal }) => { await sleep(10000, undefined, { signal }); });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(x.fetch('', { signal: pre.signal }), { name: 'AbortError' });
  assert.equal(readiness, 0);
  const controller = new AbortController();
  const pending = x.fetch('', { signal: controller.signal });
  await sleep(5);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('Jina retry wait and X batch delay are cancellable', async () => {
  for (const retry of [true, false]) {
    let requests = 0;
    const x = xConnector({ isReachReady: async () => false }, async () => {
      requests++;
      if (retry) throw new Error('Upstream 429');
      return '';
    }, { X_FOLLOWING_BATCH_DELAY_MS: '60000' });
    const controller = new AbortController();
    const pending = x.fetch('', { signal: controller.signal });
    await sleep(10);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(requests, 1);
  }
});

test('X propagates cancellation through readiness and twitter probe', async () => {
  for (const probe of [false, true]) {
    const wait = async (_name, optionsOrCount, options) => {
      const { signal } = options || optionsOrCount;
      await sleep(10000, undefined, { signal });
    };
    const x = xConnector({ isReachReady: probe ? async () => true : wait, twitterUserPosts: wait });
    const controller = new AbortController();
    const pending = x.fetch('', { signal: controller.signal });
    await sleep(5);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  }
});

test('explicit Twitter credentials reach the live probe without the conservative doctor gate', async () => {
  let spawned = 0;
  const reach = load('services/agent-reach.js', { child_process: { spawn: () => { spawned++; throw Error('doctor must not run'); } } },
    { TWITTER_AUTH_TOKEN: 'fixture-token', TWITTER_CT0: 'fixture-csrf' });
  assert.equal(await reach.isReachReady('twitter'), true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reach.isReachReady('twitter', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(spawned, 0);
});

test('fetchURL preabort sends no request and midflight abort closes HTTP', async () => {
  const utils = load('services/utils.js');
  let requests = 0;
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(200);
    res.write('partial');
    req.on('close', disconnected);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(utils.fetchURL(url, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(requests, 0);
    const active = new AbortController();
    const incoming = once(server, 'request');
    const pending = utils.fetchURL(url, { signal: active.signal });
    await incoming;
    active.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await closed;
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('runReach preabort spawns nothing; twitter abort kills the actual child; rdt mapping works', async () => {
  let child;
  let spawned = 0;
  const reach = load('services/agent-reach.js', { child_process: {
    spawn(bin, _args, opts) {
      spawned++;
      child = spawn(bin, ['-e', 'setInterval(() => {}, 1000)'], opts);
      return child;
    },
  } }, { AGENT_REACH_TWITTER_BIN: process.execPath, AGENT_REACH_RDT_BIN: process.execPath });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(reach.twitterUserPosts('one', 1, { signal: pre.signal }), { name: 'AbortError' });
  assert.equal(spawned, 0);
  for (const twitter of [true, false]) {
    const controller = new AbortController();
    const pending = twitter ? reach.twitterUserPosts('one', 1, { signal: controller.signal })
      : reach.runReach('rdt', [], { signal: controller.signal });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    await once(child, 'spawn');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal((await exited).signal, 'SIGKILL');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  }
});
