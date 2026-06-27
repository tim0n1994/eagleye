const { spawn } = require('child_process');
const path = require('path');

const KG_PROJECT_DIR = path.resolve(__dirname, '..', '..', 'kg-worker');
const DB_PATH = path.resolve(__dirname, '..', '..', 'eagleye.db');

function tail(text, length = 2000) {
  return String(text || '').slice(-length);
}

function parseKGOutput(stdout, stderr) {
  const lines = String(stdout || '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Progress output may contain several JSON lines; the final parseable line is the result.
    }
  }
  return { stdout: tail(stdout), stderr: tail(stderr) };
}

function runKGCommand(args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('uv', ['run', '--project', KG_PROJECT_DIR, 'eagleye-kg', '--db', DB_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', code => {
      if (code === 0) {
        resolve(parseKGOutput(stdout, stderr));
      } else {
        reject(new Error(`KG worker exit ${code}: ${tail(stderr, 2500) || tail(stdout, 2500)}`));
      }
    });

    proc.on('error', reject);
  });
}

async function runKGExtract(sources = null, limit = 200) {
  const args = ['extract', '--limit', String(limit)];
  if (sources) args.push('--sources', Array.isArray(sources) ? sources.join(',') : sources);
  return runKGCommand(args);
}

async function runKGEmbed(sources = null, limit = 500, batchSize = 64) {
  const backend = process.env.KG_EMBED_BACKEND || 'hash';
  const args = ['embed', '--limit', String(limit), '--batch-size', String(batchSize), '--backend', backend];
  if (sources) args.push('--sources', Array.isArray(sources) ? sources.join(',') : sources);
  return runKGCommand(args, 600000);
}

async function runKGTopics(sources = null, limit = 5000, minItems = 5) {
  const args = ['topics', '--limit', String(limit), '--min-items', String(minItems)];
  if (sources) args.push('--sources', Array.isArray(sources) ? sources.join(',') : sources);
  return runKGCommand(args, 600000);
}

async function runKGFullPipeline(sources = null) {
  const results = {};

  const ext = await runKGExtract(sources, 200);
  results.extract = ext;

  const emb = await runKGEmbed(sources, 500, 64);
  results.embed = emb;

  const top = await runKGTopics(sources, 5000, 5);
  results.topics = top;

  return results;
}

module.exports = { runKGExtract, runKGEmbed, runKGTopics, runKGFullPipeline };
