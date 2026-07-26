'use strict';

/**
 * Kleinberg-style burst detection for discrete count series.
 *
 * Used by the Alpha Radar "velocity" layer (Phase 1.2). The classic Kleinberg
 * model (Kleinberg 2002, "Bursty and Hierarchical Structure in Streams") is a
 * hidden-state automaton over event arrival rates; we use the standard
 * Poisson-count generalization with a 2-state (baseline / burst) automaton,
 * which is what production "burst detection" libraries (e.g. Marinsek's
 * `burst_detection`) reduce to in practice.
 *
 * Given a per-bin count series (e.g. an entity's daily mention counts, zero-
 * filled across the window), we find the Viterbi-optimal state path and report
 * a single burst_score: the cumulative "excess" mass of the burst segment that
 * reaches the most recent bin, or 0 if the recent stretch is baseline. This
 * rewards entities spiking *right now* rather than ones that spiked and faded.
 *
 * Pure & side-effect free so it can be unit-tested in isolation.
 */

// State 0 = baseline (rate μ), state 1 = burst (rate s·μ).
// Defaults: a bin must reach roughly double the mean rate to be worth entering
// burst (s=2), and entering costs ~2 nats so a single borderline day won't trip.
const DEFAULTS = { s: 2.0, entryCost: 2.0, eps: 1e-9 };

/**
 * Poisson log-likelihood cost of observing count `n` under rate `lambda`,
 * dropping terms constant across states (the n! term cancels in comparison).
 *   cost = lambda - n * ln(lambda)
 * @returns {number} cost in nats (lower = more likely under this rate)
 */
function poissonCost(n, lambda, eps) {
  const rate = Math.max(lambda, eps);
  return rate - n * Math.log(rate);
}

/**
 * Run 2-state Viterbi over a count series and return the optimal state path.
 *
 * @param {number[]} counts  per-bin counts (zero-filled, chronological)
 * @param {object} [opts]    { s, entryCost }
 * @returns {number[]}       array of 0/1 per bin (1 = burst state)
 */
function viterbiPath(counts, opts = {}) {
  const { s, entryCost, eps } = { ...DEFAULTS, ...opts };
  const n = counts.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  // Baseline rate = mean count per bin. Guard against all-zero series.
  const total = counts.reduce((a, b) => a + b, 0);
  const mu = total / n;
  if (mu <= eps) return counts.map(() => 0);

  const lambda = [mu, s * mu];
  // cost[i][state] = best cumulative cost ending at bin i in `state`.
  // Transitions: staying costs 0; entering burst (0→1) costs entryCost;
  // leaving burst (1→0) costs 0 (classic asymmetric).
  const cost = [
    [poissonCost(counts[0], lambda[0], eps), poissonCost(counts[0], lambda[1], eps) + entryCost],
  ];
  const back = [[-1, -1]]; // predecessor state for each state at bin 0 is none

  for (let i = 1; i < n; i++) {
    const emit0 = poissonCost(counts[i], lambda[0], eps);
    const emit1 = poissonCost(counts[i], lambda[1], eps);
    // To state 0 at bin i: came from 0 (free) or 1 (free)
    const from0_to0 = cost[i - 1][0];
    const from1_to0 = cost[i - 1][1];
    const bestTo0 = from0_to0 <= from1_to0 ? [from0_to0 + emit0, 0] : [from1_to0 + emit0, 1];
    // To state 1 at bin i: came from 0 (entryCost) or 1 (free)
    const from0_to1 = cost[i - 1][0] + entryCost;
    const from1_to1 = cost[i - 1][1];
    const bestTo1 = from0_to1 <= from1_to1 ? [from0_to1 + emit1, 0] : [from1_to1 + emit1, 1];
    cost.push([bestTo0[0], bestTo1[0]]);
    back.push([bestTo0[1], bestTo1[1]]);
  }

  // Backtrack from the cheaper final state.
  let state = cost[n - 1][0] <= cost[n - 1][1] ? 0 : 1;
  const path = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    path[i] = state;
    if (i > 0) state = back[i][state];
  }
  return path;
}

/**
 * Compute a single burst_score for a count series.
 *
 * burst_score = 0 if the most recent bin is NOT in a burst state.
 * Otherwise it is the cumulative excess of the current burst segment:
 *   Σ (over burst bins in the final burst run) [ n_t * ln(s) ]  −  entryCost
 * i.e. how much probability mass the burst state explains over baseline,
 * minus the cost of having entered it. Positive only for genuine spikes.
 *
 * ADAPTIVE s (Phase 1.2b): when `adaptive` is truthy, the burst-rate multiple
 * `s` is lowered for low-volume entities (those whose peak bin barely exceeds
 * the mean). The classic s=2 requires a bin to reach ~2× the mean rate, which
 * rare-but-rising entities (a niche repo/model) never achieve on sparse series,
 * so velocity stays silently on the day-volume fallback for everything. With
 * adaptive s, a genuinely accelerating series with a low absolute count still
 * trips the burst state, while all-zero / flat series remain baseline (guarded
 * by viterbiPath's mean check). We never raise s above the default, only lower.
 *
 * @param {number[]} counts  per-bin counts (chronological, zero-filled)
 * @param {object} [opts]    { s, entryCost, adaptive }
 * @returns {number} burst_score (>= 0)
 */
function burstScore(counts, opts = {}) {
  const n = counts.length;
  if (n === 0) return 0;
  // Start from resolved defaults so the non-adaptive path is byte-identical to
  // the original behaviour (opts may be {} and must not yield undefined s).
  const effectiveOpts = { ...DEFAULTS, ...opts };
  if (opts.adaptive) {
    const total = counts.reduce((a, b) => a + b, 0);
    const mean = total / n;
    const maxC = counts.length ? Math.max(...counts) : 0;
    // maxC/mean == 1 for a flat series (no burst possible), == s for a series
    // whose peak exactly reaches the default burst rate. If the peak is below
    // the default threshold but still >1× mean, relax s to just above peak/mean
    // so a rising sparse entity can register. Never go below 1.3 (noisy).
    if (mean > 0 && maxC > mean) {
      const ratio = maxC / mean;
      effectiveOpts.s = Math.min(effectiveOpts.s, Math.max(1.3, ratio - 0.05));
    }
    // Sparse series (low total volume) can't amortise the default 2-nat entry
    // cost in a single late spike, so viterbi keeps them in baseline forever.
    // Scale entryCost down with total volume: a 2-mention series gets a ~0.5
    // cost, a 30-mention series keeps the full 2.0. Floor at 0.5 to avoid
    // trivial one-off blips registering as sustained bursts.
    effectiveOpts.entryCost = Math.max(0.5, effectiveOpts.entryCost * Math.min(1, total / 30));
  }
  const path = viterbiPath(counts, effectiveOpts);
  if (path[n - 1] !== 1) return 0; // recent stretch is baseline → not "rising now"

  // Walk back through the contiguous final burst run and sum its excess.
  const lnS = Math.log(effectiveOpts.s);
  let excess = 0;
  for (let t = n - 1; t >= 0 && path[t] === 1; t--) {
    excess += counts[t] * lnS;
  }
  return Math.max(0, excess - effectiveOpts.entryCost);
}

module.exports = { burstScore, viterbiPath, poissonCost, DEFAULTS };
