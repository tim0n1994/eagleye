'use strict';

const { normalizeDigestDate } = require('./date-contract');

const WINDOW_DAYS = 7;
const SCORE_SOURCE_CAP = 10;
const TRACKING_PARAMS = /^(utm_.+|fbclid|gclid|dclid|msclkid)$/i;

// Deliberately narrower than story-clusters: query IDs, subdomains, versions,
// fragments and path case may identify different resources. A homepage alone
// is not evidence of the same story. False negatives are preferable here.
function resourceKey(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname === '/' && !url.search && !url.hash) return '';
    return `${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch { return ''; }
}

function shiftDate(date, days) {
  const canonical = normalizeDigestDate(typeof date === 'string' ? date : '');
  if (!canonical) return null;
  const parsed = new Date(`${canonical}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== canonical) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function emptyEvidence(date, key = '') {
  return {
    method: 'same_resource_v1', score: 0, resource_key: key || null,
    since: shiftDate(date, -(WINDOW_DAYS - 1)), through: shiftDate(date, 0),
    sources: [], capped: false,
  };
}

/**
 * Build evidence once for a scoring batch, using persisted item identities.
 * Merge overlapping date windows so rows are read at most once. Hash buckets
 * keep one representative per source/day/resource, capped at 11 sources: even
 * after excluding the subject's source, 10 remain to saturate the score.
 * For R candidate rows and B batch items: O(R + B log B + B * 7 * 11), excluding
 * SQLite's ordering; memory O(B + resource/day buckets * 11). No item-pair scan.
 */
function buildCrossSourceEvidence(db, items) {
  const subjects = [];
  const ids = [...new Set(items.map(item => item.id).filter(Boolean))];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    subjects.push(...db.prepare(`SELECT id, source_id, canonical_url, digest_date
      FROM information_items WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  const evidence = new Map(items.map(item => [item.id, emptyEvidence(item.digest_date)]));
  const keys = new Set();
  const dates = new Set();
  for (const item of subjects) {
    item.key = resourceKey(item.canonical_url);
    const subjectDate = shiftDate(item.digest_date, 0);
    evidence.set(item.id, emptyEvidence(item.digest_date, item.key));
    if (item.key && item.source_id !== null && subjectDate) {
      keys.add(item.key);
      dates.add(subjectDate);
    }
  }
  const ranges = [];
  for (const date of [...dates].sort()) {
    const since = shiftDate(date, -(WINDOW_DAYS - 1));
    const last = ranges[ranges.length - 1];
    if (last && since <= last.through) last.through = date;
    else ranges.push({ since, through: date });
  }
  const index = new Map();
  const select = db.prepare(`SELECT id, source_id, canonical_url, digest_date
    FROM information_items WHERE digest_date >= ? AND digest_date <= ?
    ORDER BY digest_date, id`);
  for (const range of ranges) {
    for (const row of select.iterate(range.since, range.through)) {
      const rowDate = shiftDate(row.digest_date, 0);
      if (!rowDate) continue;
      const key = resourceKey(row.canonical_url);
      if (!keys.has(key) || row.source_id === null) continue;
      if (!index.has(key)) index.set(key, new Map());
      const days = index.get(key);
      if (!days.has(rowDate)) days.set(rowDate, new Map());
      const sources = days.get(rowDate);
      if (sources.size < SCORE_SOURCE_CAP + 1 && !sources.has(row.source_id)) {
        sources.set(row.source_id, { source_id: row.source_id, item_id: row.id, digest_date: rowDate });
      }
    }
  }
  for (const item of subjects) {
    const result = evidence.get(item.id);
    if (!result.since || item.source_id === null || !index.has(item.key)) continue;
    const sources = new Map();
    for (let age = 0; age < WINDOW_DAYS && sources.size < SCORE_SOURCE_CAP; age++) {
      const day = index.get(item.key).get(shiftDate(item.digest_date, -age));
      if (!day) continue;
      for (const [source, representative] of day) {
        if (source !== item.source_id && !sources.has(source)) sources.set(source, representative);
        if (sources.size === SCORE_SOURCE_CAP) break;
      }
    }
    result.sources = [...sources.values()];
    result.capped = sources.size === SCORE_SOURCE_CAP;
    result.score = sources.size / SCORE_SOURCE_CAP;
  }
  return evidence;
}

function describeEvidence(evidence) {
  const references = evidence.sources.map(s => `${s.source_id}:${s.item_id}@${s.digest_date}`).join(', ');
  return `跨源覆盖 same_resource_v1：${evidence.capped ? '至少' : ''}${evidence.sources.length} 个其他来源；`
    + `窗口 ${evidence.since || '未知'}–${evidence.through || '未知'}；`
    + `同资源 ${evidence.resource_key || '无可用资源标识'}；证据 ${references || '无'}；`
    + '按其他来源数/10计分，上限1；仅表示同资源覆盖，不证明来源独立或内容真实；Alpha 为启发式排序分。';
}

module.exports = { buildCrossSourceEvidence, describeEvidence, resourceKey };
