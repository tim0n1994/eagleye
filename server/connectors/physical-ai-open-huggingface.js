/**
 * Eagleye — Physical AI Open Hugging Face Connector
 *
 * Collects openly licensed robotics / embodied-AI models and datasets from
 * the official Hugging Face Hub search APIs (/api/models, /api/datasets).
 *
 * Round contract:
 * - A resource only passes when the SAME robotics-evidence rule the server
 *   classifier applies (repo name + real description + tags; services/
 *   physical-ai-classifier.js hasPhysicalRobotics, which also screens
 *   chatbot/RPA false positives) passes on the hub metadata. Author or org
 *   names that merely contain robot never count as evidence, so a chat
 *   model uploaded by `digi-the-robot` is rejected.
 * - private=false AND gated=false must both be explicitly reported by the
 *   hub; missing fields are treated as unverifiable and rejected.
 * - The license (license:* tag or cardData.license) must be on the SAME
 *   known-open allowlist the server classifier uses
 *   (services/physical-ai-classifier.js OPEN_LICENSES); unknown / other /
 *   missing / NC / community licenses are rejected.
 * - source_payload.description and original_summary carry the resource
 *   real hub text — the dataset card description, else the model-card
 *   summary — collapsed and truncated, never invented.
 * - publishedAt is the hub real createdAt — resources without a parseable
 *   timestamp are dropped, never backfilled with a fake date.
 * - Anti-flood is deterministic: newest-first sorted with a repo-id
 *   tie-break, at most MAX_PER_AUTHOR_PER_KIND resources per author per
 *   resource kind, and a hard MAX_PER_KIND ceiling per round.
 * - /api/models and /api/datasets are independent upstream sources: any
 *   failure rejects the whole round with the offending endpoint named. A
 *   partially failing round is never reported as a silent success.
 */

const { BaseConnector } = require('./base');
const { fetchURL, currentFetchDeadline } = require('../services/utils');
const { compactDigestDate, todayDigestDate } = require('../services/date-contract');
// Single source of truth for open-license and robotics-evidence judgment:
// the connector pre-filters with the same rule the server classifier
// applies, so nothing is collected that the page would never display.
const { OPEN_LICENSES, hasPhysicalRobotics } = require('../services/physical-ai-classifier');

const HF_BASE_URL = 'https://huggingface.co';
// Two focused queries per endpoint, merged and deduped locally. The query
// order is part of the round contract: any single failed query fails its
// endpoint, and a failed endpoint fails the round.
const SEARCH_QUERIES = ['robotics', 'robot'];
const API_LIMIT_PER_QUERY = 50; // inside the hub 100-per-search ceiling
const REQUEST_TIMEOUT_MS = 12000;
// Leave one request timeout of slack inside the source-level budget so the
// remaining endpoints can still run, mirroring the appstore connector.
const DEADLINE_SLACK_MS = 15000;

const MODEL_EXPAND_FIELDS = ['tags', 'createdAt', 'gated', 'private', 'downloads', 'likes', 'pipeline_tag', 'library_name', 'cardData'];
// The hub models API has no description expand field (verified against the
// live API); model descriptions come from cardData.summary when a card
// provides one. Dataset cards expose the real description text.
const DATASET_EXPAND_FIELDS = ['tags', 'createdAt', 'gated', 'private', 'downloads', 'likes', 'cardData', 'description'];

// Anti-flood: at most 2 resources per author per kind, hard ceiling per
// kind per round. Applied AFTER the deterministic newest-first sort so the
// same input always yields the same output.
const MAX_PER_AUTHOR_PER_KIND = 2;
const MAX_PER_KIND = 12;

// Budget for the real hub text carried in source_payload.description and
// original_summary: whitespace-collapsed, truncated rather than paraphrased.
const DESCRIPTION_MAX_CHARS = 1200;

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function buildSearchUrl(endpoint, query, expandFields) {
  const params = new URLSearchParams();
  params.set('search', query);
  params.set('limit', String(API_LIMIT_PER_QUERY));
  params.set('sort', 'createdAt');
  params.set('direction', '-1');
  for (const field of expandFields) params.append('expand[]', field);
  return `${HF_BASE_URL}/api/${endpoint}?${params.toString()}`;
}

function extractLicense(raw) {
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.toLowerCase().startsWith('license:')) {
      return tag.slice('license:'.length).trim().toLowerCase();
    }
  }
  const cardLicense = plainObject(raw.cardData).license;
  if (typeof cardLicense === 'string' && cardLicense.trim()) return cardLicense.trim().toLowerCase();
  if (Array.isArray(cardLicense) && cardLicense.length && typeof cardLicense[0] === 'string') {
    return cardLicense[0].trim().toLowerCase();
  }
  return '';
}

// Real hub text only: the dataset card description, else the model-card
// summary. Whitespace is collapsed so classifier regexes see clean words;
// nothing is invented here.
function realDescription(raw, card) {
  const source = typeof raw.description === 'string' && raw.description.trim()
    ? raw.description
    : (typeof card.summary === 'string' ? card.summary : '');
  return source.replace(/\s+/g, ' ').trim();
}

function hasRoboticsEvidence(repoId, raw) {
  // Mirror of openResource evidence in services/physical-ai-classifier.js:
  // the tuple is [repo name (author namespace excluded), real description,
  // ...tags], separator-normalized, then the classifier robotics rule
  // decides. Running the identical rule at collection time keeps rows that
  // the briefing page would never display out of the database.
  const namePart = repoId.slice(repoId.indexOf('/') + 1);
  const tags = (Array.isArray(raw.tags) ? raw.tags : []).filter(tag => typeof tag === 'string');
  const evidence = [namePart, realDescription(raw, plainObject(raw.cardData)), ...tags].join(' ');
  return hasPhysicalRobotics(evidence.replace(/[_/.-]+/g, ' '));
}

class PhysicalAIOpenHuggingFaceConnector extends BaseConnector {
  constructor() {
    super('physical-ai-open-huggingface');
  }

  requestDeadline() {
    const sourceDeadline = typeof currentFetchDeadline === 'function' ? currentFetchDeadline() : null;
    const cap = Date.now() + REQUEST_TIMEOUT_MS;
    return sourceDeadline === null ? cap : Math.min(cap, sourceDeadline - DEADLINE_SLACK_MS);
  }

  async searchEndpoint(endpoint, opts = {}) {
    const expandFields = endpoint === 'models' ? MODEL_EXPAND_FIELDS : DATASET_EXPAND_FIELDS;
    const collected = [];
    for (const query of SEARCH_QUERIES) {
      const url = buildSearchUrl(endpoint, query, expandFields);
      const body = await fetchURL(url, {
        signal: opts.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        deadline: this.requestDeadline(),
      });
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new Error(`Hugging Face /api/${endpoint} search ${JSON.stringify(query)} returned invalid JSON (${err.message})`, { cause: err });
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`Hugging Face /api/${endpoint} search ${JSON.stringify(query)} returned a non-array payload`);
      }
      collected.push(...parsed.filter(entry => entry && typeof entry === 'object'));
    }
    return collected;
  }

  // Strict admission: every contract field must be explicitly reported and
  // pass. Rejected resources are counted by reason for the round log.
  admit(raw) {
    const repoIdRaw = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!repoIdRaw) return { ok: false, reason: 'missing-id' };
    const repoId = repoIdRaw.startsWith('datasets/') ? repoIdRaw.slice('datasets/'.length) : repoIdRaw;
    if (!repoId.includes('/')) return { ok: false, reason: 'invalid-id' };
    if (raw.private !== false) return { ok: false, reason: 'not-public:private' };
    if (raw.gated !== false) return { ok: false, reason: 'not-public:gated' };
    const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt.trim() : '';
    if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return { ok: false, reason: 'missing-timestamp' };
    const license = extractLicense(raw);
    if (!OPEN_LICENSES.has(license)) return { ok: false, reason: `license:${license || 'missing'}` };
    if (!hasRoboticsEvidence(repoId, raw)) return { ok: false, reason: 'no-robotics-evidence' };
    const author = repoId.slice(0, repoId.indexOf('/')).toLowerCase();
    return { ok: true, value: { repoId, author, license, createdAt, raw } };
  }

  // Deterministic selection: newest-first with a repo-id tie-break, then a
  // per-author cap, then a hard per-kind ceiling.
  selectHubResources(raws, kind, endpoint, digestDate) {
    const seen = new Set();
    const skipReasons = {};
    const admitted = [];
    for (const raw of Array.isArray(raws) ? raws : []) {
      const key = typeof raw?.id === 'string' ? raw.id.trim() : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const verdict = this.admit(raw);
      if (!verdict.ok) {
        skipReasons[verdict.reason] = (skipReasons[verdict.reason] || 0) + 1;
        continue;
      }
      admitted.push(verdict.value);
    }
    admitted.sort((a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt)
      || (a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0));
    const perAuthor = new Map();
    const kept = [];
    for (const entry of admitted) {
      if (kept.length >= MAX_PER_KIND) break;
      const count = perAuthor.get(entry.author) || 0;
      if (count >= MAX_PER_AUTHOR_PER_KIND) {
        skipReasons['author-cap'] = (skipReasons['author-cap'] || 0) + 1;
        continue;
      }
      perAuthor.set(entry.author, count + 1);
      kept.push(entry);
    }
    if (Object.keys(skipReasons).length > 0) {
      console.log(`[${this.slug}] ${kind}: kept ${kept.length} of ${(raws || []).length} hub results (skips: ${JSON.stringify(skipReasons)})`);
    }
    return kept.map(entry => this.toItem(entry, kind, endpoint, digestDate));
  }

  toItem(entry, kind, endpoint, digestDate) {
    const { repoId, author, license, createdAt, raw } = entry;
    const namePart = repoId.slice(repoId.indexOf('/') + 1);
    const url = kind === 'hf_model'
      ? `${HF_BASE_URL}/${repoId}`
      : `${HF_BASE_URL}/datasets/${repoId}`;
    const tags = (Array.isArray(raw.tags) ? raw.tags : []).filter(tag => typeof tag === 'string');
    const downloads = Number.isFinite(Number(raw.downloads)) ? Number(raw.downloads) : 0;
    const likes = Number.isFinite(Number(raw.likes)) ? Number(raw.likes) : 0;
    const card = plainObject(raw.cardData);
    const title = (typeof card.title === 'string' && card.title.trim()) || repoId;
    const tagSummary = tags.slice(0, 8).join(', ');
    const hubDescription = realDescription(raw, card);
    // Prefer the real hub text for the displayed summary; the license/tags
    // template is only the fallback for cards without any usable text.
    const description = hubDescription
      ? hubDescription.slice(0, DESCRIPTION_MAX_CHARS)
      : `${kind === 'hf_model' ? 'Model' : 'Dataset'} ${namePart} by ${author} on Hugging Face — license ${license}${tagSummary ? `; tags: ${tagSummary}` : ''}`;

    return {
      ...this.normalize({
        title,
        url,
        description,
        publishedAt: createdAt, // the hub real createdAt — never fabricated
        language: 'en',
        author,
        sourcePayload: {
          provider: 'huggingface',
          resource_kind: kind, // 'hf_model' | 'hf_dataset' for strict server-side classification
          repo_id: repoId,
          author,
          license,
          description: hubDescription.slice(0, DESCRIPTION_MAX_CHARS),
          private: false,
          gated: false,
          created_at: createdAt,
          url,
          pipeline_tag: typeof raw.pipeline_tag === 'string' ? raw.pipeline_tag : '',
          library_name: typeof raw.library_name === 'string' ? raw.library_name : '',
          downloads,
          likes,
          tags: tags.slice(0, 24),
          source_endpoint: `/api/${endpoint}`,
          search_queries: [...SEARCH_QUERIES],
        },
        popularity: { downloads, likes },
        score: Math.min(1, Math.log2(1 + likes) * 0.12 + Math.log2(1 + downloads) * 0.06),
      }),
      digest_date: digestDate,
    };
  }

  async fetch(date, opts = {}) {
    opts.signal?.throwIfAborted();
    const digestDate = date || compactDigestDate(todayDigestDate());
    const endpointErrors = [];
    const rawByKind = { hf_model: [], hf_dataset: [] };
    for (const [kind, endpoint] of [['hf_model', 'models'], ['hf_dataset', 'datasets']]) {
      try {
        rawByKind[kind] = await this.searchEndpoint(endpoint, opts);
      } catch (err) {
        // Cancellation is a caller decision — never repackaged as a source
        // failure and never swallowed into partial success.
        opts.signal?.throwIfAborted();
        endpointErrors.push({ endpoint, err });
      }
    }
    opts.signal?.throwIfAborted();
    if (endpointErrors.length > 0) {
      const detail = endpointErrors
        .map(({ endpoint, err }) => `/api/${endpoint}: ${err.message}`)
        .join(' | ');
      const failure = new Error(`[${this.slug}] Hugging Face search failure(s) — ${detail}`);
      const first = endpointErrors[0].err;
      if (first?.code) failure.code = first.code;
      const status = Number(first?.upstreamStatus ?? first?.status);
      if (Number.isInteger(status) && status > 0) failure.upstreamStatus = status;
      throw failure;
    }
    return [
      ...this.selectHubResources(rawByKind.hf_model, 'hf_model', 'models', digestDate),
      ...this.selectHubResources(rawByKind.hf_dataset, 'hf_dataset', 'datasets', digestDate),
    ];
  }
}

module.exports = {
  PhysicalAIOpenHuggingFaceConnector,
  SEARCH_QUERIES,
  MAX_PER_AUTHOR_PER_KIND,
  MAX_PER_KIND,
  DESCRIPTION_MAX_CHARS,
};
