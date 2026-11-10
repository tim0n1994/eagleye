'use strict';

// Runs only in a read worker. Bounded input, batched associations, no model calls.
const { createHash } = require('node:crypto');
const MAX_ITEMS = 6000;
const shiftDay = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

function readSnapshot(db, { date, days, industry }) {
  const industryColumn = {physical:'physical',education:'education',neuroscience:'neuroscience'}[industry];
  const industryFilter = industryColumn ? `AND EXISTS (SELECT 1 FROM intelligence_items a WHERE a.item_id=information_items.id AND a.${industryColumn}=1)` : '';
  const start = shiftDay(date, 1 - days);
  const previousStart = shiftDay(start, -days);
  const previousEnd = shiftDay(start, -1);
  const statement = db.prepare(`SELECT id, source_id, canonical_url, title, title_zh,
    substr(original_summary,1,600) AS original_summary, published_at, digest_date
    FROM information_items INDEXED BY idx_items_digest_date WHERE digest_date >= ? AND digest_date <= ? AND duplicate_of IS NULL ${industryFilter}
    ORDER BY digest_date DESC, rowid DESC LIMIT ?`);
  const current = statement.all(start, date, MAX_ITEMS + 1);
  const previous = statement.all(previousStart, previousEnd, MAX_ITEMS + 1);
  const partial = current.length > MAX_ITEMS || previous.length > MAX_ITEMS;
  const currentPartial = current.length > MAX_ITEMS;
  const previousPartial = previous.length > MAX_ITEMS;
  current.length = Math.min(current.length, MAX_ITEMS);
  previous.length = Math.min(previous.length, MAX_ITEMS);
  const all = [...current, ...previous];
  const byId = new Map(all.map(i => [i.id, { ...i, topics: [], entities: [] }]));
  const sources = new Map(db.prepare('SELECT id,slug,label FROM sources').all().map(s => [s.id, s]));
  // Stable taxonomy is primary; legacy slugs remain valid and contribute evidence.
  const taxonomy = db.prepare("SELECT id,slug,name,name_zh,description,description_zh,parent_topic_id FROM topic_taxonomy WHERE status='active'").all();
  const legacy = db.prepare("SELECT id,slug,name,name_zh,description,description_zh,parent_topic_id FROM topics WHERE status='active'").all();
  const topics = new Map();
  const taxonomyIds = new Map(taxonomy.map(t => [t.id, t.slug]));
  const legacyIds = new Map(legacy.map(t => [t.id, t.slug]));
  for (const t of [...legacy, ...taxonomy]) topics.set(t.slug, { ...t, parent_slug: taxonomyIds.get(t.parent_topic_id) || legacyIds.get(t.parent_topic_id) || null });
  const ids = [...byId.keys()];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const ph = batch.map(() => '?').join(',');
    for (const fact of db.prepare(`SELECT item_id,event_id,match_reason,confidence,physical,education,neuroscience FROM intelligence_items WHERE item_id IN (${ph})`).all(...batch)) Object.assign(byId.get(fact.item_id), fact);
    const assignments = db.prepare(`SELECT DISTINCT item_id,topic_id FROM item_topic_assignments WHERE item_id IN (${ph}) AND topic_kind='taxonomy'`).all(...batch);
    const oldAssignments = db.prepare(`SELECT item_id,topic_id FROM item_topics WHERE item_id IN (${ph})`).all(...batch);
    for (const [rows, mapping] of [[assignments, taxonomyIds], [oldAssignments, legacyIds]]) {
      for (const row of rows) {
        const slug = mapping.get(row.topic_id), item = byId.get(row.item_id);
        if (slug && topics.has(slug) && !item.topics.includes(slug)) item.topics.push(slug);
      }
    }
    const entities = db.prepare(`SELECT DISTINCT em.item_id, ce.canonical_slug AS slug,ce.canonical_name AS name,ce.entity_type AS type
      FROM entity_mentions em JOIN entity_links el ON el.mention_id=em.id
      JOIN canonical_entities ce ON ce.id=el.entity_id WHERE em.item_id IN (${ph})`).all(...batch);
    for (const e of entities) byId.get(e.item_id).entities.push({ slug: e.slug, name: e.name, type: e.type });
    const scores = db.prepare(`SELECT item_id,alpha_score,signal_type FROM signal_scores WHERE item_id IN (${ph})`).all(...batch);
    for (const s of scores) Object.assign(byId.get(s.item_id), s);
    // Latest summary only; avoid multiplying rows when an item was re-enriched.
    const summaries = db.prepare(`SELECT item_id,substr(one_liner_zh,1,600) AS one_liner_zh,substr(one_liner,1,600) AS one_liner
      FROM ai_summaries WHERE item_id IN (${ph}) ORDER BY created_at ASC,rowid ASC`).all(...batch);
    for (const s of summaries) Object.assign(byId.get(s.item_id), s);
  }
  for (const item of byId.values()) {
    const source = sources.get(item.source_id);
    item.source_slug = source?.slug || '';
    item.source_label = source?.label || '';
  }
  const currentItems = current.map(i => byId.get(i.id));
  const previousItems = previous.map(i => byId.get(i.id));
  return {
    meta: { date, days, start, previous_start: previousStart, previous_end: previousEnd,
      generated_at: new Date().toISOString(), partial, current_partial: currentPartial, previous_partial: previousPartial,
      current_items: currentItems.length, previous_items: previousItems.length, limit_per_period: MAX_ITEMS,
      index_pending: db.prepare('SELECT count(*) n FROM intelligence_queue').get().n,
      date_basis: 'digest_date', grouping: 'incremental_evidence_events_v1' },
    topics: [...topics.values()], current: currentItems, previous: previousItems,
  };
}

// Conservative O(n) grouping. Keep functional URL query parameters; no fuzzy
// pairwise joins, so unrelated stories cannot collapse through transitive chains.
function evidenceKey(item) {
  try {
    const url = new URL(item.canonical_url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid scheme');
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch { return `item:${item.id}`; }
}
function groupEvents(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.event_id || evidenceKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([key, members]) => {
    members.sort((a,b) => b.digest_date.localeCompare(a.digest_date) || (b.alpha_score || 0) - (a.alpha_score || 0) || a.id.localeCompare(b.id));
    const representative = members[0];
    return { id: createHash('sha256').update(key).digest('hex').slice(0,24), representative,
      evidence_count: members.length, source_count: new Set(members.map(i => i.source_id)).size,
      sources: [...new Set(members.map(i => i.source_label))],
      topics: [...new Set(members.flatMap(i => i.topics))],
      entities: [...new Map(members.flatMap(i => i.entities).map(e => [e.slug,e])).values()],
      evidence: members.slice(0,12), evidence_truncated: members.length > 12 };
  });
}

function aggregate(items, kind) {
  const stats = new Map();
  for (const item of items) {
    const objects = kind === 'topic' ? item.topics.map(slug => ({ slug })) : item.entities;
    for (const object of objects) {
      if (!stats.has(object.slug)) stats.set(object.slug, { ...object, count: 0, sources: new Set(), days: new Map(), examples: [] });
      const row = stats.get(object.slug);
      row.count++;
      row.sources.add(item.source_id);
      row.days.set(item.digest_date, (row.days.get(item.digest_date) || 0) + 1);
      if (row.examples.length < 3) row.examples.push(item);
    }
  }
  return stats;
}

function trends(snapshot, kind) {
  const now = aggregate(snapshot.current, kind), before = aggregate(snapshot.previous, kind);
  const labels = new Map(snapshot.topics.map(t => [t.slug,t]));
  return [...new Set([...now.keys(), ...before.keys()])].map(slug => {
    const a = now.get(slug), b = before.get(slug);
    const current = a?.count || 0, previous = b?.count || 0;
    return { ...(kind === 'topic' ? labels.get(slug) : { name: (a || b).name,type: (a || b).type }), slug, count: current, previous,
      source_count: a?.sources.size || 0, previous_source_count: b?.sources.size || 0,
      delta: snapshot.meta.partial ? null : current - previous,
      growth: snapshot.meta.partial || previous === 0 ? null : (current - previous) / previous,
      first_in_window: !snapshot.meta.partial && current > 0 && previous === 0,
      timeline: Array.from({ length: snapshot.meta.days }, (_,i) => {
        const date = shiftDay(snapshot.meta.start,i);
        return { date,count: a?.days.get(date) || 0 };
      }), examples: a?.examples || [] };
  }).sort((a,b) => (b.delta ?? b.count) - (a.delta ?? a.count) || b.count-a.count);
}

function present(snapshot, query) {
  const meta = snapshot.meta;
  const topicMap = new Map(snapshot.topics.map(t => [t.slug,t]));
  let items = snapshot.current;
  if (query.industry) items = items.filter(i => i[query.industry] === 1);
  if (query.topic) items = items.filter(i => i.topics.includes(query.topic));
  if (query.entity) items = items.filter(i => i.entities.some(e => e.slug === query.entity));
  if (query.view === 'following') {
    const subs = query.subs || [];
    items = items.filter(i => subs.some(s => s.kind === 'topic' ? i.topics.includes(s.value) : s.kind === 'entity' ? i.entities.some(e => e.slug === s.value) : s.kind === 'type' && i.signal_type === s.value));
  }
  if (query.view === 'system') {
    const sources = new Map();
    for (const item of snapshot.current) {
      if (!sources.has(item.source_id)) sources.set(item.source_id,{ slug:item.source_slug,label:item.source_label,items:0,summaries:0,topics:0,entities:0 });
      const row = sources.get(item.source_id);row.items++;
      if (item.one_liner || item.one_liner_zh) row.summaries++;
      if (item.topics.length) row.topics++;
      if (item.entities.length) row.entities++;
    }
    return { meta,sources:[...sources.values()].sort((a,b) => b.items-a.items) };
  }
  snapshot.derived ||= {};
  const topicStats = snapshot.derived.topics ||= trends(snapshot, 'topic');
  if (query.view === 'topics') {
    const stats = new Map(topicStats.map(t => [t.slug,t]));
    return { meta, topics: snapshot.topics.map(t => ({ ...t, count: 0, previous: 0, source_count: 0, ...stats.get(t.slug) })).sort((a,b) => b.count-a.count) };
  }
  if (query.view === 'trends') {
    const rows = query.kind === 'topic' ? topicStats : (snapshot.derived.entities ||= trends(snapshot, 'entity'));
    return { meta, kind: query.kind, rows: rows.slice(query.offset,query.offset + 30), has_more: rows.length > query.offset + 30 };
  }
  const topic = query.topic ? topicMap.get(query.topic) : null;
  if (query.topic && !topic) { const err = new Error('Topic not found'); err.status = 404; throw err; }
  const events = groupEvents(items);
  events.sort((a,b) => query.sort === 'sources' ? b.source_count-a.source_count || b.representative.digest_date.localeCompare(a.representative.digest_date) : b.representative.digest_date.localeCompare(a.representative.digest_date) || (b.representative.alpha_score || 0)-(a.representative.alpha_score || 0));
  return { meta, topic, topic_stats: topic ? topicStats.find(t => t.slug === topic.slug) : null,
    related: topic ? snapshot.topics.filter(t => t.parent_slug === topic.slug || (topic.parent_slug && t.slug === topic.parent_slug)).slice(0,20) : [],
    topics: snapshot.topics.map(({slug,name,name_zh}) => ({slug,name,name_zh})),
    events: events.slice(query.offset,query.offset+30), total: events.length, has_more: events.length > query.offset+30,
    entities: query.topic ? trends({ ...snapshot,current: items,previous: snapshot.previous.filter(i => i.topics.includes(query.topic)) },'entity').slice(0,8) : [],
    subs: query.view === 'following' ? query.subs : undefined };
}

module.exports = { readSnapshot, present };
