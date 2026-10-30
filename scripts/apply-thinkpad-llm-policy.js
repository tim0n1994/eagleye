#!/usr/bin/env node
/** Explicit ThinkPad routing recovery. Dry run by default; credentials never leave memory. */
const { TASKS } = require('../server/services/llm-pool-config');

function buildPolicy(current, selection) {
  if (selection?.disabled_endpoint_ids !== undefined && !Array.isArray(selection.disabled_endpoint_ids)) {
    throw new Error('Retired endpoint identities must be an array in private configuration');
  }
  const ids = [selection?.primary?.id, selection?.fallback?.id, ...(selection?.disabled_endpoint_ids || [])];
  if (!selection?.primary?.model || !selection?.fallback?.model
      || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('Private configuration must identify two distinct verified routes and any retired endpoints');
  }
  const next = structuredClone(current);
  const primary = next?.endpoints?.find(e => e.id === selection.primary.id);
  const fallback = next?.endpoints?.find(e => e.id === selection.fallback.id);
  if (primary?.model !== selection.primary.model || fallback?.model !== selection.fallback.model
      || primary?.protocol !== 'openai' || fallback?.protocol !== 'openai') {
    throw new Error('Verified route identities changed; inspect private configuration before applying');
  }
  const known = new Set(ids);
  if (next.endpoints.some(e => e.enabled && !known.has(e.id))) {
    throw new Error('Unexpected active route; refusing to override a newer routing policy');
  }
  next.enabled = true;
  next.global_concurrency = 4;
  next.max_attempts = 2;
  for (const endpoint of next.endpoints) {
    if (known.has(endpoint.id)) endpoint.enabled = [primary.id, fallback.id].includes(endpoint.id);
  }
  // Match primary capacity to global capacity: normal parallel work must not
  // overflow onto a reasoning model with a different output-token budget.
  Object.assign(primary, { enabled: true, priority: 0, concurrency: 4, tasks: [...TASKS],
    label: 'Primary — all tasks' });
  Object.assign(fallback, { enabled: true, priority: 3, concurrency: 1, tasks: [...TASKS],
    label: 'Fallback — all tasks' });
  // Explicitly retired routes retain their private config for rollback.
  return next;
}

function validateTarget(deployment, actualHostname, databasePath, localAddresses) {
  const { realpathSync } = require('node:fs');
  if (!deployment?.hostname || actualHostname !== deployment.hostname
      || !deployment.database_path || realpathSync(databasePath) !== realpathSync(deployment.database_path)) {
    throw new Error('Host or live database does not match the private deployment configuration');
  }
  const base = new URL(deployment.api_base_url);
  const address = base.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || base.search || base.hash || base.pathname !== '/'
      || !['127.0.0.1', '::1', ...localAddresses].includes(address)) {
    throw new Error('API must use a local interface without URL credentials, query or path');
  }
  return base.origin;
}

async function main() {
  const { parseArgs } = require('node:util');
  const { values } = parseArgs({ options: { db: { type: 'string' }, config: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values.db || !values.config) throw new Error('Usage: node scripts/apply-thinkpad-llm-policy.js --db /absolute/eagleye.db --config /private/deployment.json [--apply]');
  const { hostname, networkInterfaces } = require('node:os');
  const { readFileSync, statSync } = require('node:fs');
  const configStat = statSync(values.config);
  if ((configStat.mode & 0o077) !== 0 || (process.getuid && configStat.uid !== process.getuid())) {
    throw new Error('Private deployment configuration must be owned by this user with mode 600');
  }
  const deployment = JSON.parse(readFileSync(values.config, 'utf8'));
  const localAddresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(entry => entry.address);
  const apiBase = validateTarget(deployment, hostname(), values.db, localAddresses);
  const Database = require('better-sqlite3');
  const db = new Database(values.db, { readonly: true, fileMustExist: true });
  try {
    const credential = db.prepare(`SELECT k.key FROM api_keys k JOIN users u ON u.id=k.user_id
      WHERE k.active=1 AND u.status='active' AND u.role='admin'
      AND (k.expires_at IS NULL OR datetime(k.expires_at)>datetime('now')) LIMIT 1`).get();
    if (!credential) throw new Error('No active administrative API credential');
    const request = async (method, config) => {
      const response = await fetch(`${apiBase}/api/settings/llm/pool`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${credential.key}`, 'Content-Type': 'application/json' },
        ...(config ? { body: JSON.stringify({ config }) } : {}),
      });
      if (!response.ok) throw new Error(`Pool configuration API returned HTTP ${response.status}`);
      return (await response.json()).config;
    };
    const current = await request('GET');
    const desired = buildPolicy(current, deployment.routes);
    const changed = JSON.stringify(current) !== JSON.stringify(desired);
    console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'dry-run', changed,
      routes: desired.endpoints.filter(e => e.enabled).map(({ tasks, concurrency }) => ({ tasks, concurrency })) }));
    if (values.apply && changed) {
      const active = db.prepare("SELECT count(*) AS n FROM background_jobs WHERE status IN ('running','queued')").get().n;
      if (active) throw new Error('Wait for active jobs to finish before changing task routing');
      // Use the application's validator/redaction/cache invalidation, never raw
      // SQL writes. Masked keys round-trip to the existing private credentials.
      const saved = await request('PUT', desired);
      if (JSON.stringify(saved) !== JSON.stringify(buildPolicy(saved, deployment.routes))) throw new Error('Unexpected saved routing state');
      console.log('APPLIED: verify real translation, digest and hierarchy jobs separately');
    }
  } finally { db.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildPolicy, validateTarget };
