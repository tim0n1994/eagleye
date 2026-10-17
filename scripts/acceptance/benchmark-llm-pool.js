const fs = require('node:fs');
const path = require('node:path');
const { createPoolService } = require('../../server/services/llm-pool');
const { validatePoolConfig } = require('../../server/services/llm-pool-config');

const USAGE = 'Usage: node scripts/acceptance/benchmark-llm-pool.js --config <private-endpoints.json> --output <new-report.json>\nThe config path may instead come from EAGLEYE_LLM_ENDPOINTS_FILE. Existing reports are never overwritten.';
const SAMPLE_COUNT = 10;
const POLICY = { schema_version: 1, enabled: true, queue_limit: 30, queue_timeout_ms: 120000, request_timeout_ms: 120000, max_attempts: 2 };

function parseArgs(args, environment = process.env) {
  const options = { config: environment.EAGLEYE_LLM_ENDPOINTS_FILE || null, output: null, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!['--config', '--output'].includes(flag) || seen.has(flag)) throw new Error('Unknown or duplicate command-line option');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Each option requires a path');
    options[flag.slice(2)] = value;
    seen.add(flag);
  }
  if (!options.help && (!options.config || !options.output)) throw new Error('Private config and explicit output paths are required');
  if (!options.help && path.resolve(options.config) === path.resolve(options.output)) throw new Error('Input and output paths must differ');
  return options;
}

function makeSamples() {
  return Array.from({ length: SAMPLE_COUNT }, (_, index) => {
    const kind = index % 3;
    return { id: `sample-${index}`, entity: `ExampleProject${index}`,
      category: ['research', 'new_tool', 'funding'][kind],
      fact: [
        'published a paper describing a new sorting algorithm; no independent replication was supplied',
        'released an MIT-licensed Python JSON-validation library with tests; no benchmark was supplied',
        'announced a seed funding round; the amount and investors were not disclosed',
      ][kind] };
  });
}

function validateSample(sample, value) {
  if (!value || Array.isArray(value) || value.id !== sample.id || value.category !== sample.category) return false;
  if (typeof value.summary !== 'string' || !value.summary.includes(sample.entity) || !value.summary.trim()) return false;
  if (!Array.isArray(value.unknowns) || !value.unknowns.length || value.unknowns.some(entry => typeof entry !== 'string' || !entry.trim())) return false;
  const unknowns = value.unknowns.join(' ').toLowerCase();
  if (sample.category === 'research' && !/replicat|reproduc/.test(unknowns)) return false;
  if (sample.category === 'new_tool' && !/benchmark|performance/.test(unknowns)) return false;
  if (sample.category === 'funding' && (!/amount|size|sum|valuation/.test(unknowns) || !/investor|identit|backer/.test(unknowns))) return false;
  return true;
}

function groupConfig(endpoints, globalConcurrency) {
  return validatePoolConfig({ ...POLICY, global_concurrency: globalConcurrency,
    endpoints: endpoints.map(endpoint => ({ ...endpoint, enabled: true, concurrency: 1, tasks: ['classify'] })) });
}

function parseOutput(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function runGroup(label, config, samples, signal) {
  const service = createPoolService({ getDB: () => null, getValue: () => config, setValue: () => {} });
  const selected = service.getPoolProvider('classify');
  const started = Date.now();
  let results;
  try {
    results = await Promise.all(samples.map(async sample => {
      const itemStarted = Date.now();
      try {
        const response = await selected.callWithMetadata(
          `Use only these facts: ${sample.entity} ${sample.fact}. Return JSON only with keys id="${sample.id}", category (research/new_tool/funding), summary (one English sentence including the project name), unknowns (English array of the unavailable evidence). Do not invent numbers, performance or investors.`,
          { task: 'classify', json: true, maxTokens: 2048, temperature: 0, signal, validate: value => validateSample(sample, value) });
        return { id: sample.id, ok: true, elapsed_ms: Date.now() - itemStarted, metadata: response.metadata, output: parseOutput(response.text) };
      } catch (error) {
        return { id: sample.id, ok: false, elapsed_ms: Date.now() - itemStarted,
          error_code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'BENCHMARK_REQUEST_FAILED' };
      }
    }));
  } finally {
    await service.shutdownPool();
  }
  const successful = results.filter(result => result.ok).length;
  return { label, endpoint_ids: config.endpoints.map(endpoint => endpoint.id), global_concurrency: config.global_concurrency,
    endpoint_concurrency: 1, wall_ms: Date.now() - started, successful, total: samples.length, success_rate: successful / samples.length, results };
}

function comparison(single, pool) {
  const passed = single.total === SAMPLE_COUNT && pool.total === SAMPLE_COUNT && single.successful === SAMPLE_COUNT && pool.successful === SAMPLE_COUNT;
  return { passed, comparison: passed ? 'comparable' : 'not-comparable',
    valid_speedup: passed && pool.wall_ms > 0 ? single.wall_ms / pool.wall_ms : null };
}

function serializeReport(report, secrets) {
  const values = [...new Set(secrets)].filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length);
  function redact(value) {
    if (typeof value === 'string') {
      for (const secret of values) value = value.split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
    return value;
  }
  return JSON.stringify(redact(report), null, 2) + '\n';
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log(USAGE); return; }
  let privateConfig;
  try {
    if (fs.statSync(options.config).size > 1048576) throw new Error('Oversized config');
    privateConfig = JSON.parse(fs.readFileSync(options.config, 'utf8'));
  } catch { throw new Error('Cannot read a valid private endpoint configuration JSON file'); }
  if (!Array.isArray(privateConfig.endpoints) || privateConfig.endpoints.length !== 5) throw new Error('Private config must contain exactly five endpoints');
  const pooled = groupConfig(privateConfig.endpoints, 5);
  const lane5 = pooled.endpoints.filter(endpoint => endpoint.id === 'lane-5');
  if (lane5.length !== 1) throw new Error('Private config must contain endpoint id lane-5');
  const single = groupConfig(lane5, 1);
  const samples = makeSamples();
  const secrets = pooled.endpoints.map(endpoint => endpoint.api_key);
  const report = { observed_at: new Date().toISOString(), scope: 'One paired run of the same 10 synthetic grounded classification samples; not a production throughput or general quality guarantee',
    validator_scope: 'JSON shape, exact sample id/category, project name, and explicit missing-evidence categories; outputs retained for human grounding review',
    policy: { ...POLICY, max_tokens: 2048, temperature: 0 }, samples, status: 'running', single: null, pool: null,
    comparison: 'not-comparable', valid_speedup: null, passed: false };
  try { fs.writeFileSync(options.output, serializeReport(report, secrets), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('Output must be a new writable file in an existing directory'); }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    report.single = await runGroup('single-lane-5', single, samples, controller.signal);
    fs.writeFileSync(options.output, serializeReport(report, secrets));
    console.log(JSON.stringify({ phase: 'single', wall_ms: report.single.wall_ms, successful: report.single.successful, total: SAMPLE_COUNT }));
    report.pool = await runGroup('five-route-pool', pooled, samples, controller.signal);
    Object.assign(report, comparison(report.single, report.pool), { status: controller.signal.aborted ? 'cancelled' : 'finished', completed_at: new Date().toISOString() });
    fs.writeFileSync(options.output, serializeReport(report, secrets));
    console.log(JSON.stringify({ phase: 'pool', wall_ms: report.pool.wall_ms, successful: report.pool.successful, total: SAMPLE_COUNT,
      comparison: report.comparison, valid_speedup: report.valid_speedup, passed: report.passed }));
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error('Benchmark could not complete. Check CLI paths and configuration; no credentials are printed.\n' + USAGE);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, makeSamples, validateSample, groupConfig, comparison, serializeReport };
