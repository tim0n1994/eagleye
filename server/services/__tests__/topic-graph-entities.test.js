// @vitest-environment node
/* global it, expect */
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

it('connects co-occurring entity IDs and reuses the relation on the next build', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/001_initial_schema.sql'), 'utf8'));
    db.exec('CREATE TABLE dynamic_topics(id,slug,name,status)');
    db.exec("INSERT INTO entities(id,name) VALUES('entity-a','A'),('entity-b','B')");
    const insert = db.prepare(`INSERT INTO graph_edges(id,from_type,from_id,to_type,to_id,edge_type)
      VALUES(?,'item',?,'entity',?,'item_mentions_entity')`);
    for (const item of ['item-1', 'item-2']) {
      for (const entity of ['entity-a', 'entity-b']) insert.run(item + ':' + entity, item, entity);
    }
    const filename = path.resolve(__dirname, '../topic-graph.js');
    const subject = new Module(filename, module);
    subject.filename = filename;
    subject.require = id => {
      if (id === '../db/connection') return { getDB: () => db };
      if (id === './kg3d-data' || id === './embeddings') return {};
      if (id === './date-contract') return require('../date-contract');
      return require(id);
    };
    subject._compile(fs.readFileSync(filename, 'utf8'), filename);
    const { buildTopicGraph } = subject.exports;
    expect(await buildTopicGraph('2026-10-16', { deep: false })).toMatchObject({ mode: 'fast', edges_updated: 1 });
    expect(db.prepare("SELECT from_id,to_id FROM graph_edges WHERE edge_type='entity_related_entity'").all())
      .toEqual([{ from_id: 'entity-a', to_id: 'entity-b' }]);
    expect(await buildTopicGraph('2026-10-16', { deep: false })).toMatchObject({ mode: 'fast', edges_updated: 0 });
  } finally {
    db.close();
  }
});
