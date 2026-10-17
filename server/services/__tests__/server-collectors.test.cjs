const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(file, mocks, env = {}, fetch) {
  const filename = path.resolve(__dirname, '..', file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), process: { env }, console,
    require: name => name in mocks ? mocks[name] : require(name), fetch, URL,
  }, { filename });
  return module.exports;
}

test('Reddit adapter invocation preserves signal and rejects errors/schema', async () => {
  const signal = new AbortController().signal;
  let result = { ok: true, data: [{ id: 'abc', url: 'https://reddit.com/r/test/comments/abc/' }] };
  const helper = load('server-collectors.js', { './agent-reach': { runReach: async (cmd, args, opts) => {
    assert.equal(cmd, 'rdt'); assert.ok(args[0].endsWith('/scripts/reddit-collector.py'));
    assert.equal(JSON.stringify(args.slice(1)), JSON.stringify(['test', '--sort', 'hot', '--limit', '3']));
    assert.equal(opts.signal, signal); assert.equal(opts.jsonMode, 'cli-json'); return result;
  } } });
  assert.equal((await helper.redditSubreddit('test', { limit: 3, signal })).data.length, 1);
  for (const bad of [{ ok: false, code: 'AUTH_REQUIRED' }, { ok: true, data: [{}] }, { ok: true, data: null }]) {
    result = bad; await assert.rejects(helper.redditSubreddit('test', { limit: 3, signal }));
  }
});

test('XHS REST maps synthetic schema and rejects auth/malformed payloads', async () => {
  const signal = new AbortController().signal;
  let body = { success: true, data: { feeds: [{ id: 'note1', xsecToken: 'token+/=', noteCard: { displayTitle: 'fixture', user: { nickname: 'author', userId: 'u1' }, interactInfo: { likedCount: '12' } } }] } };
  const helper = load('server-collectors.js', { './agent-reach': {} }, { EAGLEYE_XHS_MCP_URL: 'http://127.0.0.1:18060' }, async (url, opts) => {
    if (url.pathname === '/api/v1/login/status') {
      assert.equal(opts.method, 'GET'); assert.equal(opts.signal, signal);
      return { ok: true, json: async () => ({ success: true, data: { is_logged_in: true } }) };
    }
    assert.equal(url.href, 'http://127.0.0.1:18060/api/v1/feeds/search');
    assert.equal(opts.method, 'POST'); assert.equal(opts.body, '{"keyword":"AI"}'); assert.equal(opts.signal, signal);
    return { ok: true, json: async () => body };
  });
  const note = (await helper.xiaohongshuSearch('AI', { signal })).data[0];
  assert.equal(new URL(note.url).searchParams.get('xsec_token'), 'token+/=');
  assert.equal(note.author, 'author'); assert.equal(note.likes, '12');
  for (const bad of [{ success: false }, { success: true, data: {} }, { success: true, data: { feeds: [{}] } }, { success: true, error: 'expired', data: { feeds: [] } }]) {
    body = bad; await assert.rejects(helper.xiaohongshuSearch('AI', { signal }));
  }
  body = { success: true, data: { feeds: [] } };
  assert.equal((await helper.xiaohongshuSearch('AI', { signal })).data.length, 0);
});

test('XHS logged-out or unknown login status prevents every search request', async () => {
  for (const [body, expected] of [
    [{ success: true, data: { is_logged_in: false } }, /AUTH_REQUIRED/],
    [{ success: true, data: {} }, /LOGIN_STATUS_ERROR/],
    [{ success: false, data: { is_logged_in: true } }, /LOGIN_STATUS_ERROR/],
  ]) {
    const requests = [];
    const signal = new AbortController().signal;
    const helper = load('server-collectors.js', { './agent-reach': {} }, { EAGLEYE_XHS_MCP_URL: 'http://127.0.0.1:18060' }, async (url, opts) => {
      requests.push(url.pathname);
      assert.equal(opts.signal, signal);
      return { ok: true, json: async () => body };
    });
    await assert.rejects(helper.xiaohongshuSearch('AI', { signal }), expected);
    assert.deepEqual(requests, ['/api/v1/login/status']);
  }
});

for (const [name, klass, method, config, key, envFlag] of [
  ['reddit', 'RedditConnector', 'redditSubreddit', 'readRedditConfig', 'subreddits', 'AGENT_REACH_RDT_BIN'],
  ['xiaohongshu', 'XiaoHongShuConnector', 'xiaohongshuSearch', 'readXiaohongshuConfig', 'keywords', 'EAGLEYE_XHS_MCP_URL'],
]) {
  test(`${name} selects backend; forwards signal; failures throw; preabort makes zero calls`, async () => {
    for (const server of [false, true]) {
      let calls = 0;
      let fail = false;
      const signal = new AbortController().signal;
      const selected = { [method]: async (_, opts) => { calls++; assert.equal(opts.signal, signal); return fail ? { ok: false, code: 'AUTH_REQUIRED' } : { ok: true, data: [] }; } };
      const wrong = { [method]: () => { throw Error('wrong backend'); } };
      const reach = { ...(server ? wrong : selected), isReachReady: async (_, opts) => { assert.equal(opts.signal, signal); return true; } };
      const Connector = load(`../connectors/${name}.js`, {
        './base': { BaseConnector: class {} }, '../services/agent-reach': reach,
        '../services/server-collectors': server ? selected : wrong,
        [`../services/${name}-config`]: { [config]: () => ({ [key]: ['fixture'] }) },
      }, server ? { [envFlag]: 'configured' } : {})[klass];
      const connector = new Connector();
      assert.equal((await connector.fetch('', { signal })).length, 0);
      fail = true; await assert.rejects(connector.fetch('', { signal }), /AUTH_REQUIRED/);
      const pre = new AbortController(); pre.abort();
      await assert.rejects(connector.fetch('', { signal: pre.signal }), { name: 'AbortError' });
      assert.equal(calls, 2);
      if (!server) { reach.isReachReady = async () => false; await assert.rejects(connector.fetch('', { signal }), /BACKEND_NOT_READY/); }
    }
  });
}
