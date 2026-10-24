const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// D2 window contract: pubDate must sit inside the 36h fetch window relative
// to the real clock (isWithinFetchWindow replaced digest-day == item-UTC-day
// equality filtering in rss.js).
const xml = `<rss><channel><item><title>Release</title><link>https://example.com/story</link><pubDate>${new Date(Date.now() - 7 * 3600e3).toUTCString()}</pubDate></item></channel></rss>`;

function connector(fetchURL, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../connectors/rss.js'), 'utf8'), {
    module, process: { env }, console: { warn() {} },
    require: name => ({ './base': { BaseConnector: class {
      constructor(slug) { this.slug = slug; }
      normalize(item) { return item; }
    } }, '../services/utils': { fetchURL }, '../db/connection': { getDB: () => null },
    '../services/date-contract': require('../date-contract'),
    // 案2 redaction lane: rss.js 新增此 require（写库前脱敏），真实模块透传。
    '../services/secret-redaction': require('../secret-redaction') })[name],
  });
  const subject = new module.exports.RSSConnector('solidot');
  subject.getFeedUrl = () => 'https://primary.example/feed';
  return subject;
}

test('primary RSS succeeds without fallback and preserves retrieval provenance', async () => {
  const calls = [];
  const subject = connector(async url => { calls.push(url); return xml; });
  const items = await subject.fetch('20261016');
  assert.equal(items.length, 1);
  assert.equal(items[0].sourcePayload.feedUrl, 'https://primary.example/feed');
  assert.equal(calls.length, 1);
});

test('configured fallback recovers primary failure and records the actual feed', async () => {
  const subject = connector(async url => {
    if (url.includes('primary')) throw new Error('TLS failed');
    return xml;
  }, { SOLIDOT_RSS_FALLBACK_URL: 'https://fallback.example/feed' });
  const items = await subject.fetch('20261016');
  assert.equal(items.length, 1);
  assert.equal(items[0].sourcePayload.feedUrl, 'https://fallback.example/feed');
});

test('unavailable or invalid feeds fail rather than returning a successful empty source', async () => {
  await assert.rejects(connector(async () => { throw new Error('offline'); }).fetch('20261016'), /offline/);
  await assert.rejects(connector(async () => '<html>blocked</html>').fetch('20261016'), /Invalid RSS/);
  await assert.rejects(connector(async () => { throw new Error('offline'); },
    { SOLIDOT_RSS_FALLBACK_URL: 'https://fallback.example/feed' }).fetch('20261016'), /offline/);
});

test('cancellation is propagated and never falls back', async () => {
  const controller = new AbortController();
  let calls = 0;
  const subject = connector(async (_url, { signal }) => {
    calls++;
    assert.equal(signal, controller.signal);
    controller.abort();
    throw controller.signal.reason;
  }, { SOLIDOT_RSS_FALLBACK_URL: 'https://fallback.example/feed' });
  await assert.rejects(subject.fetch('20261016', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
