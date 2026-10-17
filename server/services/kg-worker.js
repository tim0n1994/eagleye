const { spawn } = require('child_process');
const path = require('path');
const { getDBPath } = require('../config');

const KG_PROJECT_DIR = path.resolve(__dirname, '..', '..', 'kg-worker');
const ownedWorkers = new Set();
let stopping = false;

/** @returns {{ stopped: number, errors: Error[] }} */
function stopKGWorkers() {
  stopping = true;
  let stopped = 0;
  const errors = [];
  for (const proc of ownedWorkers) {
    if (!Number.isInteger(proc.pid) || proc.pid <= 0) continue;
    try {
      if (process.platform === 'win32') {
        proc.kill('SIGTERM');
      } else {
        process.kill(-proc.pid, 'SIGTERM');
      }
      stopped += 1;
    } catch (error) {
      if (error.code !== 'ESRCH') errors.push(error);
    }
  }
  return { stopped, errors };
}

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
    if (stopping) {
      reject(new Error('KG workers are shutting down'));
      return;
    }
    const proc = spawn('uv', ['run', '--project', KG_PROJECT_DIR, 'eagleye-kg', '--db', getDBPath(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      detached: process.platform !== 'win32',
    });
    ownedWorkers.add(proc);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', code => {
      ownedWorkers.delete(proc);
      if (code === 0) {
        resolve(parseKGOutput(stdout, stderr));
      } else {
        reject(new Error(`KG worker exit ${code}: ${tail(stderr, 2500) || tail(stdout, 2500)}`));
      }
    });

    proc.on('error', error => {
      if (!proc.pid) ownedWorkers.delete(proc);
      reject(error);
    });
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

async function runKGTopics(sources = null, limit = 1000, minItems = 5) {
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

  const top = await runKGTopics(sources, 1000, 5);
  results.topics = top;

  return results;
}

module.exports = { runKGExtract, runKGEmbed, runKGTopics, runKGFullPipeline, stopKGWorkers };
