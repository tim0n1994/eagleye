'use strict';
const { createHash } = require('node:crypto');
const { classifyPhysicalAi, relevantCandidate } = require('./physical-ai-classifier');
const { classifyEducation } = require('./education-feed');
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const STOP = new Set('a an the and or for from with into on in of to is are as by at new ai how why this that it its'.split(' '));
function normalizedUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|xsec_token|xsec_source)$/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.hostname + u.pathname.replace(/\/$/, '') + u.search;
  } catch { return ''; }
}
function features(row) {
  let payload = {};
  try { payload = JSON.parse(row.source_payload || '{}') || {}; } catch { /* raw title remains authoritative */ }
  const title = String(payload.original_title || row.title || '').normalize('NFKC').toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = title.match(/[a-z0-9]+|[\u3400-\u9fff]+/g) || [];
  const tokens = [...new Set(words.flatMap(w => /[\u3400-\u9fff]/.test(w) ? Array.from({length:Math.max(0,w.length-1)}, (_,i) => w.slice(i,i+2)) : w.length > 2 && !STOP.has(w) ? [w] : []))].sort();
  const numbers = (title.match(/\d+(?:\.\d+)*/g) || []).join(',') + '|' + (title.match(/\b(?:not|no|never|fails?|denies?|without)\b|未|不|否认|失败/g) || []).join(',');
  const url = normalizedUrl(row.canonical_url);
  const strong = url ? ['url:' + url] : [];
  // Only explicit identifiers count; broad homepages/project names are not event anchors.
  const paperText = `${row.canonical_url || ''} ${row.doi || ''} ${row.arxiv_id ? 'arxiv:' + row.arxiv_id : ''}`;
  const doi = paperText.match(/10\.\d{4,9}\/[a-z0-9._;()/:-]+/i)?.[0]?.replace(/[).,;]+$/, '').toLowerCase();
  const arxiv = paperText.match(/(?:arxiv(?:\.org\/(?:abs|pdf|html)\/|:))([0-9]{4}\.[0-9]{4,5})(?:v\d+)?/i)?.[1];
  if (doi) strong.push('doi:' + doi);
  if (arxiv) strong.push('arxiv:' + arxiv);
  const blocks = [];
  if (tokens.length >= 6 && title.length >= 35) {
    // At most six inverted-index lookups, each with a bounded candidate list.
    for (let i=0;i<3;i++) {
      for (let j=i+1;j<4;j++) blocks.push('block:' + hash(tokens[i] + '|' + tokens[j]));
    }
  }
  return { title, tokens, numbers, strong, blocks };
}
function validContent(row) {
  return normalizedUrl(row.canonical_url) !== '' && String(row.title || '').trim().length >= 8
    && !/^(?:\[no title\]|untitled|无标题)$/i.test(String(row.title || '').trim()) && !row.duplicate_of;
}
function flags(row) {
  const text = `${row.title || ''} ${row.title_zh || ''} ${row.original_summary || ''}`;
  return {
    physical: +(!!classifyPhysicalAi(row) || relevantCandidate(row.title, row.title_zh, row.original_summary)),
    education: +(!!classifyEducation(row) || /^education-(oatutor|deeptutor)$/.test(row.source_slug) && /github\.com\/.+\/releases\/tag\//.test(row.canonical_url)),
    neuroscience: +(row.source_slug.startsWith('neuroscience-') || /\b(?:neuroscien\w*|brain.computer interface|neuroimaging|neuroprosthe\w*|electroencephalo\w*)\b|脑科学|神经科学|脑机接口|脑成像|脑电/i.test(text)),
  };
}
function drainBatch(db, limit = 200) {
  const rows = db.prepare(`SELECT i.id,i.source_id,i.title,i.title_zh,i.canonical_url,
    substr(i.original_summary,1,2000) original_summary,substr(i.source_payload,1,12000) source_payload,
    i.duplicate_of,i.published_at,i.created_at,s.slug source_slug,pm.doi,pm.arxiv_id,pm.venue
    FROM intelligence_queue q JOIN information_items i ON i.id=q.item_id JOIN sources s ON s.id=i.source_id
    LEFT JOIN paper_metadata pm ON pm.item_id=i.id ORDER BY q.rowid LIMIT ?`).all(limit);
  const candidates = db.prepare(`SELECT e.* FROM intelligence_event_keys k JOIN intelligence_events e ON e.id=k.event_id
    WHERE k.key=? AND e.event_time BETWEEN ? AND ? ORDER BY e.event_time DESC,e.id LIMIT 40`);
  const exact = db.prepare(`SELECT e.* FROM intelligence_event_keys k JOIN intelligence_events e ON e.id=k.event_id WHERE k.key=? ORDER BY e.id LIMIT 1`);
  const addEvent = db.prepare('INSERT INTO intelligence_events(id,anchor_id,title,tokens,numbers,event_time) VALUES(?,?,?,?,?,?)');
  const addKey = db.prepare('INSERT OR IGNORE INTO intelligence_event_keys(key,event_id) VALUES(?,?)');
  const addItem = db.prepare(`INSERT OR REPLACE INTO intelligence_items(item_id,source_id,event_id,match_reason,confidence,physical,education,neuroscience,eligible,content_time,date_inferred)
    VALUES(@id,@source_id,@event_id,@reason,@confidence,@physical,@education,@neuroscience,@eligible,@time,@inferred)`);
  const remove = db.prepare('DELETE FROM intelligence_queue WHERE item_id=?');
  db.transaction(() => {
    for (const row of rows) {
      const f = features(row);
      const parsed = Date.parse(row.published_at || '');
      const time = Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(row.created_at.replace(' ', 'T') + (row.created_at.endsWith('Z') ? '' : 'Z')).toISOString();
      let event, reason = 'standalone', confidence = 1;
      // Identifier matches take priority over lexical title similarity.
      for (const key of f.strong) {
        event = exact.get(key);
        if (event) { reason = key.split(':')[0]; break; }
      }
      if (!event && f.blocks.length && validContent(row)) {
        const min = new Date(Date.parse(time)-3*86400000).toISOString();
        const max = new Date(Date.parse(time)+3*86400000).toISOString();
        const seen = new Set();
        let best = 0;
        for (const key of f.blocks) for (const candidate of candidates.all(key,min,max)) {
          if (seen.has(candidate.id)) continue;
          seen.add(candidate.id);
          if (candidate.numbers !== f.numbers) continue;
          const other = new Set(JSON.parse(candidate.tokens));
          const overlap = f.tokens.filter(t => other.has(t)).length;
          const score = overlap/(f.tokens.length+other.size-overlap);
          if (score >= 0.95 && overlap >= 6 && score > best) {
            event = candidate; best = score; reason = 'title_similarity'; confidence = score;
          }
        }
      }
      if (!event) {
        event = { id:hash('event:' + row.id) };
        addEvent.run(event.id,row.id,f.title,JSON.stringify(f.tokens),f.numbers,time);
        // Only anchor keys are indexed: no transitive fuzzy chains.
        for (const key of [...f.strong,...f.blocks]) addKey.run(key,event.id);
      } else if (reason !== 'title_similarity') {
        for (const key of f.strong) addKey.run(key,event.id);
      }
      addItem.run({ ...row,...flags({...row,title:f.title,title_zh:''}), event_id:event.id,reason,confidence,
        eligible:+validContent(row),time,inferred:+!Number.isFinite(parsed) });
      remove.run(row.id);
    }
  })();
  return rows.length;
}
function quality(db, { industry, days }) {
  const column = {physical:'physical',education:'education',neuroscience:'neuroscience'}[industry];
  if (!column) throw new Error('Unknown industry');
  const cutoff = new Date(Date.now()-days*86400000).toISOString();
  const rows = db.prepare(`SELECT s.slug,s.label,count(*) scanned,sum(a.${column}) matched,
    count(DISTINCT CASE WHEN a.${column}=1 AND a.eligible=1 THEN a.event_id END) effective,
    sum(a.date_inferred) inferred_dates
    FROM intelligence_items a JOIN sources s ON s.id=a.source_id WHERE a.content_time>=?
    GROUP BY a.source_id ORDER BY effective DESC,scanned DESC`).all(cutoff);
  for (const r of rows) {
    r.match_rate = r.scanned ? r.matched/r.scanned : null;
    r.effective_rate = r.scanned ? r.effective/r.scanned : null;
    r.redundancy_rate = r.matched ? (r.matched-r.effective)/r.matched : null;
  }
  const totals = db.prepare(`SELECT count(*) scanned,sum(${column}) matched,
    count(DISTINCT CASE WHEN ${column}=1 AND eligible=1 THEN event_id END) effective,
    max(indexed_at) updated_at FROM intelligence_items WHERE content_time>=?`).get(cutoff);
  const pending = db.prepare('SELECT count(*) n FROM intelligence_queue').get().n;
  return {industry,days,rows,totals,pending,partial:pending>0,rule_version:1,
    definition:'effective = distinct rule-matched events with valid title/URL and no duplicate marker; denominator = indexed ingested records; not expert quality or publisher independence',
    date_basis:'published_at; missing dates use created_at'};
}
module.exports = { drainBatch, quality, normalizedUrl };
