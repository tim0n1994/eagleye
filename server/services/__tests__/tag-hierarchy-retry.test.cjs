const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const QUEUE_TIMEOUT = 'LLM request failed (QUEUE_TIMEOUT)';

function makeTags(count = 30) {
  return Array.from({ length: count }, (_, index) => ({
    id: 'tag-' + index,
    slug: 'tag-' + String(index + 1).padStart(2, '0'),
    name: '标签' + String(index + 1).padStart(2, '0'),
    item_count: count - index,
  }));
}

function makeDb(tagRows) {
  return {
    prepare(sql) {
      return {
        all() {
          if (sql.includes('FROM tags t')) return tagRows;
          return [];
        },
        get() {
          if (sql.includes('COUNT(')) return { cnt: 1 };
          return {};
        },
        run() {
          return { changes: 1 };
        },
      };
    },
    transaction(fn) {
      return () => fn();
    },
  };
}

function makeProvider({ round1Attempts, round2Attempts }) {
  const calls = [];
  const round1 = JSON.stringify({
    sub_topics: [{
      name_zh: '模型训练',
      slug: 'model-training',
      tags: ['标签01'],
    }],
  });
  const round2 = JSON.stringify({
    domains: [{ name_zh: '人工智能', slug: 'ai', topics: ['基础模型'] }],
    topics: [{
      name_zh: '基础模型',
      slug: 'foundation-models',
      domain: '人工智能',
      sub_topics: ['模型训练'],
    }],
  });

  return {
    calls,
    isPool: true,
    async call(prompt) {
      const round = prompt.includes('概念簇') ? 'round1' : 'round2';
      calls.push(round);
      if (round === 'round1') {
        if (calls.filter(item => item === 'round1').length < round1Attempts) throw new Error(QUEUE_TIMEOUT);
        return round1;
      }
      if (calls.filter(item => item === 'round2').length < round2Attempts) throw new Error(QUEUE_TIMEOUT);
      return round2;
    },
  };
}

function loadIsolatedHierarchy({ db, provider }) {
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function patchedRequire(name, ...rest) {
    if (name === '../db/connection') return { getDB: () => db };
    if (name === './llm-provider') {
      return { getProvider: () => provider, extractJSON: text => JSON.parse(text) };
    }
    if (name === './llm-shared') {
      return {
        taskContext: () => ({ check: () => {}, signal: undefined }),
        abortableDelay: async () => {},
      };
    }
    return originalRequire.call(this, name, ...rest);
  };

  const subjectPath = require.resolve('../tag-hierarchy');
  delete require.cache[subjectPath];
  try {
    return require('../tag-hierarchy');
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[subjectPath];
  }
}

test('public entry retries transient queue timeouts in both rounds', async () => {
  const provider = makeProvider({ round1Attempts: 2, round2Attempts: 2 });
  const subject = loadIsolatedHierarchy({ db: makeDb(makeTags()), provider });
  const result = await subject.buildTagHierarchy();

  assert.deepEqual(provider.calls, ['round1', 'round1', 'round2', 'round2']);
  assert.equal(result.selectedTags, 30);
  assert.equal(result.domains, 1);
  assert.equal(result.topics, 1);
  assert.equal(result.subTopics, 1);
  assert.equal(result.uniqueTags, 1);
});

test('public entry still reports failure after three exhausted Round 1 attempts', async () => {
  const provider = makeProvider({ round1Attempts: 4, round2Attempts: 1 });
  const subject = loadIsolatedHierarchy({ db: makeDb(makeTags()), provider });

  await assert.rejects(
    () => subject.buildTagHierarchy(),
    /Round 1 chunk 1 failed: .*QUEUE_TIMEOUT/,
  );
  assert.deepEqual(provider.calls, ['round1', 'round1', 'round1']);
});

test('public entry still reports failure after three exhausted Round 2 attempts', async () => {
  const provider = makeProvider({ round1Attempts: 1, round2Attempts: 4 });
  const subject = loadIsolatedHierarchy({ db: makeDb(makeTags()), provider });

  await assert.rejects(
    () => subject.buildTagHierarchy(),
    /Round 2 failed: .*QUEUE_TIMEOUT/,
  );
  assert.deepEqual(provider.calls, ['round1', 'round2', 'round2', 'round2']);
});

test('internal round runners are not part of the production API', () => {
  const provider = makeProvider({ round1Attempts: 1, round2Attempts: 1 });
  const subject = loadIsolatedHierarchy({ db: makeDb(makeTags()), provider });

  assert.deepEqual(Object.keys(subject), ['buildTagHierarchy']);
});
