#!/usr/bin/env node
/** Explicit ThinkPad routing recovery. Dry run by default; credentials never leave memory. */
const { TASKS } = require('../server/services/llm-pool-config');

function buildPolicy(current) {
  const next = structuredClone(current);
  const primary = next?.endpoints?.find(e => e.id === 'configured-model-10');
  const fallback = next?.endpoints?.find(e => e.id === 'lane-3');
  if (primary?.model !== 'configured-model-8' || fallback?.model !== 'configured-model-6'
      || primary.protocol !== 'openai' || fallback.protocol !== 'openai') {
    throw new Error('configured-model-3');
  }
  const known = new Set(['configured-model-10', 'lane-3', 'lane-2', 'lane-1', 'configured-model-11']);
  if (next.endpoints.some(e => e.enabled && !known.has(e.id))) {
    throw new Error('Unexpected active route; refusing to override a newer routing policy');
  }
  next.enabled = true;
  next.global_concurrency = 4;
  next.max_attempts = 2;
  for (const endpoint of next.endpoints) {
    if (known.has(endpoint.id)) endpoint.enabled = ['configured-model-10', 'lane-3'].includes(endpoint.id);
  }
  // Match primary capacity to global capacity: normal parallel work must not
  // overflow onto a reasoning model with a different output-token budget.
  Object.assign(primary, { enabled: true, priority: 0, concurrency: 4, tasks: [...TASKS],
    label: 'configured-model-4', quota_group: 'configured-model-10' });
  Object.assign(fallback, { enabled: true, priority: 3, concurrency: 1, tasks: [...TASKS],
    label: 'configured-model-1', quota_group: 'configured-model-7' });
  // lane-2 used the same DeepSeek model/credential as lane-3, so it was not
  // independent redundancy. Preserve its config, but disable the duplicate.
  return next;
}

async function main() {
  const { parseArgs } = require('node:util');
  const { values } = parseArgs({ options: { db: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values.db) throw new Error('Usage: node scripts/apply-thinkpad-llm-policy.js --db /absolute/eagleye.db [--apply]');
  const { hostname, homedir } = require('node:os');
  const { realpathSync } = require('node:fs');
  const { join } = require('node:path');
  if (hostname() !== 'application-host'
      || realpathSync(values.db) !== realpathSync(join(homedir(), 'projects/eagleye/eagleye.db'))) {
    throw new Error('This installer targets the live ThinkPad database only, not a backup or another host');
  }
  const Database = require('better-sqlite3');
  const db = new Database(values.db, { readonly: true, fileMustExist: true });
  try {
    const credential = db.prepare(`SELECT k.key FROM api_keys k JOIN users u ON u.id=k.user_id
      WHERE k.active=1 AND u.status='active' AND u.role='admin'
      AND (k.expires_at IS NULL OR datetime(k.expires_at)>datetime('now')) LIMIT 1`).get();
    if (!credential) throw new Error('No active administrative API credential');
    const request = async (method, config) => {
      const response = await fetch('http://192.0.2.1:3019/api/settings/llm/pool', {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${credential.key}`, 'Content-Type': 'application/json' },
        ...(config ? { body: JSON.stringify({ config }) } : {}),
      });
      if (!response.ok) throw new Error(`Pool configuration API returned HTTP ${response.status}`);
      return (await response.json()).config;
    };
    const current = await request('GET');
    const desired = buildPolicy(current);
    const changed = JSON.stringify(current) !== JSON.stringify(desired);
    console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'dry-run', changed,
      routes: desired.endpoints.filter(e => e.enabled).map(({ id, model, tasks, concurrency }) => ({ id, model, tasks, concurrency })) }));
    if (values.apply && changed) {
      const active = db.prepare("SELECT count(*) AS n FROM background_jobs WHERE status IN ('running','queued')").get().n;
      if (active) throw new Error('Wait for active jobs to finish before changing task routing');
      // Use the application's validator/redaction/cache invalidation, never raw
      // SQL writes. Masked keys round-trip to the existing private credentials.
      const saved = await request('PUT', desired);
      if (JSON.stringify(saved) !== JSON.stringify(buildPolicy(saved))) throw new Error('Unexpected saved routing state');
      console.log('APPLIED: verify real translation, digest and hierarchy jobs separately');
    }
  } finally { db.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildPolicy };
