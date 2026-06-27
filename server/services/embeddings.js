/**
 * Eagleye — Embedding Service
 *
 * Generates text embeddings using the configured LLM provider's embedding API.
 * Stores embeddings as JSON arrays and computes cosine similarity for
 * topic matching and clustering.
 *
 * Providers:
 *  - Gemini: text-embedding-004 (768 dimensions)
 *  - OpenAI: text-embedding-3-small (1536 dimensions)
 *  - Fallback: LLM-based semantic fingerprints when no embedding API key
 */

const https = require('https');

// ─── Configuration ──────────────────────────────────────────────────────

const GEMINI_EMBED_MODEL = 'text-embedding-004';
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';

// ─── Embedding Generation ───────────────────────────────────────────────

/**
 * Generate an embedding vector for a text string.
 * Returns an array of floats (embedding vector) or null on failure.
 * Supports Gemini and OpenAI embedding APIs.
 */
async function generateEmbedding(text) {
  if (!text || text.length === 0) return null;

  // Truncate very long text
  const input = text.slice(0, 8000);

  if (process.env.ENABLE_REMOTE_EMBEDDINGS !== 'true') {
    return semanticFingerprint(input);
  }

  const geminiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Prefer Gemini embedding API
  if (geminiKey) {
    return generateGeminiEmbedding(input, geminiKey);
  }

  // Fall back to OpenAI embedding API
  if (openaiKey) {
    return generateOpenAIEmbedding(input, openaiKey);
  }

  // No embedding API available — return null
  return null;
}

/**
 * Generate embedding via Gemini text-embedding-004 API.
 * Returns a 768-dimensional vector.
 */
async function generateGeminiEmbedding(text, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${apiKey}`;
  const payload = {
    model: `models/${GEMINI_EMBED_MODEL}`,
    content: { parts: [{ text }] },
  };

  try {
    const body = await _postJSON(url, payload);
    if (!body) return null;
    const data = JSON.parse(body);
    return data.embedding?.values || null;    } catch (_err) {
      console.error(`  ⚠  Gemini embedding failed:`, _err.message);
      return null;
    }
}

/**
 * Generate embedding via OpenAI embedding API.
 * Returns a 1536-dimensional vector.
 */
async function generateOpenAIEmbedding(text, apiKey) {
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const url = `${baseUrl}/embeddings`;
  const payload = {
    model: OPENAI_EMBED_MODEL,
    input: text,
  };

  try {
    const body = await _postJSON(url, payload, {
      'Authorization': `Bearer ${apiKey}`,
    });
    if (!body) return null;
    const data = JSON.parse(body);
    return data.data?.[0]?.embedding || null;    } catch (_err) {
      console.error(`  ⚠  OpenAI embedding failed:`, _err.message);
      return null;
    }
}

// ─── POST Helper ────────────────────────────────────────────────────────

function _postJSON(url, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          console.error(`  ⚠  Embedding API HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Embedding request timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Vector Math ────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Compute mean (centroid) of multiple embedding vectors.
 */
function centroidOf(vectors) {
  if (!vectors || vectors.length === 0) return null;
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] += v[i];
    }
  }
  return sum.map(s => s / vectors.length);
}

// ─── Embedding Storage ──────────────────────────────────────────────────

const VECTOR_TYPE = 'semantic';
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';

function saveItemEmbedding(db, itemId, embedding) {
  if (!db || !itemId || !embedding) return;
  const vectorJson = JSON.stringify(embedding);
  db.prepare(`
    INSERT OR REPLACE INTO item_vectors (item_id, vector_type, model_name, dimension, vector_json, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(itemId, VECTOR_TYPE, EMBED_MODEL, embedding.length, vectorJson, String(itemId));
}

function getItemEmbedding(db, itemId) {
  if (!db || !itemId) return null;
  const row = db.prepare(
    'SELECT vector_json FROM item_vectors WHERE item_id = ? AND vector_type = ? ORDER BY created_at DESC LIMIT 1'
  ).get(itemId, VECTOR_TYPE);
  if (!row) return null;
  try { return JSON.parse(row.vector_json); } catch { return null; }
}

/**
 * Store a topic's centroid embedding in the topics table.
 * We store it as a JSON string in a dedicated column or metadata.
 * Since centroid_embedding is not a real column in SQLite, we store
 * it as a JSON string in a separate key-value table or inline.
 *
 * For simplicity, we store it in a new table: topic_embeddings
 * We'll create this table in a migration.
 */
function saveTopicCentroid(db, topicId, embedding) {
  if (!db || !topicId || !embedding) return;
  db.prepare(`
    INSERT OR REPLACE INTO topic_embeddings (topic_id, embedding, dimension, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(topicId, JSON.stringify(embedding), embedding.length);
}/**
 * Get all topics with their centroid embeddings.
 * Only returns topics that have embeddings.
 */
function getAllTopicCentroids(db) {
  if (!db) return [];
  return db.prepare(`
    SELECT t.id, t.slug, t.name, te.embedding
    FROM topics t
    JOIN topic_embeddings te ON t.id = te.topic_id
    WHERE te.embedding IS NOT NULL
  `).all().map(row => {
    try {
      return { ...row, embedding: JSON.parse(row.embedding) };    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ─── Semantic Fingerprint (Fallback) ───────────────────────────────────

/**
 * Generate a simple semantic fingerprint using word hashing when no
 * embedding API is available. This is a rough approximation — useful
 * for basic similarity but not as accurate as real embeddings.
 */
function semanticFingerprint(text) {
  if (!text) return [];
  
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Count word frequencies
  const freq = {};
  for (const word of words) {
    freq[word] = (freq[word] || 0) + 1;
  }

  // Create a fixed-size vector from top words
  const topWords = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 256);

  const vector = new Array(256).fill(0);
  topWords.forEach(([_word, count], i) => {
    vector[i] = count / words.length; // Normalized frequency
  });

  return vector;
}

module.exports = {
  generateEmbedding,
  cosineSimilarity,
  centroidOf,
  saveItemEmbedding,
  getItemEmbedding,
  saveTopicCentroid,

  getAllTopicCentroids,
  semanticFingerprint,
};
