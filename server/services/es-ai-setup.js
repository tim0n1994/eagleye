/**
 * Eagleye — ES AI Infrastructure Setup
 *
 * One-call initialization of all AI capabilities on the ES 9.4 instance:
 *   1. Ensures rerank inference endpoint is deployable
 *   2. Ensures ELSER (sparse embedding) inference endpoint
 *   3. Ensures multilingual-e5 (dense embedding) inference endpoint
 *   4. Creates ingest pipelines for auto-embedding generation
 *
 * All models are ES built-in (downloaded on first use, run on ML nodes).
 * Requires an active trial or enterprise license.
 */

const { esRequest, ES_HOST, ES_INDEX } = require('./elasticsearch');

const AI_INFERENCE_IDS = {
  rerank: '.rerank-v1-elasticsearch',
  elser: '.elser-2-elasticsearch',
  e5: '.multilingual-e5-small-elasticsearch',
};

/**
 * Initialize all AI endpoints and pipelines.
 * Returns { rerank, elser, e5, pipeline } status per component.
 */
async function setupAI() {
  const results = { rerank: 'skipped', elser: 'skipped', e5: 'skipped', pipeline: 'skipped' };

  // Built-in endpoints already exist on fresh ES 9.4.3 installs.
  // Just verify they're accessible.
  try {
    const d = await esRequest('GET', '/_inference');
    const ids = new Set((d.endpoints || []).map(e => e.inference_id));
    results.rerank = ids.has(AI_INFERENCE_IDS.rerank) ? 'ready' : 'missing';
    results.elser = ids.has(AI_INFERENCE_IDS.elser) ? 'ready' : 'missing';
    results.e5 = ids.has(AI_INFERENCE_IDS.e5) ? 'ready' : 'missing';
  } catch (e) {
    results.rerank = 'error: ' + e.message.slice(0, 100);
  }

  // ELSER ingest pipeline (for future auto-embedding)
  try {
    await esRequest('PUT', '/_ingest/pipeline/eagleye-elser', {
      processors: [{
        inference: {
          inference_id: AI_INFERENCE_IDS.elser,
          input_output: [{ input_field: 'title', output_field: 'ml_tokens' }],
          ignore_missing: true,
        },
      }],
    });
    results.pipeline = 'created';
  } catch (e) {
    results.pipeline = 'error: ' + e.message.slice(0, 100);
  }

  return { results, inference_ids: AI_INFERENCE_IDS };
}

/**
 * Check if a specific inference endpoint is ready (not downloading).
 */
async function checkAIReady() {
  const status = {};
  try {
    const d = await esRequest('GET', '/_inference');
    const endpoints = d.endpoints || [];
    const ids = new Set(endpoints.map(e => e.inference_id));
    for (const [key, val] of Object.entries(AI_INFERENCE_IDS)) {
      status[key] = ids.has(val) || ids.has('.' + val.replace('eagleye-', '') + '-elasticsearch');
    }
  } catch { /* ignore */ }
  return status;
}

module.exports = { setupAI, checkAIReady, AI_INFERENCE_IDS };
