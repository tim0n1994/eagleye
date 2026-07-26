#!/usr/bin/env node
'use strict';

/**
 * Full-corpus signal rescoring — CLI entry point.
 *
 * Promotes every information_item to a signal_score using the current
 * taxonomy, filling the backlog that the daily pipeline (which only scores
 * the current day) leaves behind. The heavy lifting lives in
 * server/services/signal-rescore.js; this is the standalone wrapper, also
 * reachable via the RESCORE_ALL background job (POST /api/signals/rescore?all=true).
 *
 * Usage:
 *   node scripts/rescore-signals.js [--concurrency N]
 *
 * Run after taxonomy/keyword/prompt changes, or whenever signal_scores
 * coverage falls well below information_items (the script reports the ratio).
 */

require('dotenv').config();
const { rescoreAllSignals } = require('../server/services/signal-rescore');
const { getDB } = require('../server/db/connection');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--concurrency' && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) out.concurrency = n;
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  getDB(); // initialize the shared connection used by rescoreAllSignals
  const summary = await rescoreAllSignals(opts);
  console.log('[rescore] summary:', JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error('[rescore] top-level error:', err);
  process.exit(1);
});
