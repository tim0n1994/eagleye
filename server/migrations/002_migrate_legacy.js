/**
 * Eagleye Migration 002: Migrate Legacy Data
 *
 * Transfers records from the old `items` table (from the original server.js)
 * into the new `information_items`, `ai_summaries`, `item_topics` tables.
 *
 * This is a one-time JavaScript migration (not SQL) because it requires
 * UUID generation, source-lookup, and JSON construction logic.
 */

const { getDB } = require('../db/connection');
const crypto = require('crypto');

function generateId() {
  return crypto.randomUUID();
}

function generateContentHash(text) {
  if (!text) return '';
  return crypto.createHash('md5').update(String(text)).digest('hex');
}

function lookupSourceId(db, sourceName) {
  // Map legacy source names to source slugs
  const slugMap = {
    'HN': 'hacker-news',
    'Hacker News': 'hacker-news',
    'V2EX': 'v2ex',
    'Lobsters': 'lobsters',
    'lobste.rs': 'lobsters',
    'Lobste.rs': 'lobsters',
    'GitHub': 'github-trending',
    'github': 'github-trending',
    'Hugging Face': 'hugging-face',
    'huggingface': 'hugging-face',
    'Product Hunt': 'product-hunt',
    'producthunt': 'product-hunt',
    'Techmeme': 'techmeme',
    'Solidot': 'solidot',
    'solidot': 'solidot',
  };

  const slug = slugMap[sourceName] || null;
  if (!slug) return null;

  const row = db.prepare('SELECT id FROM sources WHERE slug = ?').get(slug);
  return row ? row.id : null;
}

function run() {
  const db = getDB();
  if (!db) {
    console.error('  ❌ No database available for legacy migration.');
    return;
  }

  // Check if already migrated
  const legacyCount = db.prepare('SELECT COUNT(*) as count FROM items').get().count;
  if (legacyCount === 0) {
    console.log('  📋 No legacy items to migrate.');
    return;
  }

  const newCount = db.prepare('SELECT COUNT(*) as count FROM information_items').get().count;
  if (newCount > 0) {
    console.log(`  ⏭  Legacy migration already done (${newCount} items in new table).`);
    return;
  }

  console.log(`  🔄 Migrating ${legacyCount} legacy items...`);

  const legacyItems = db.prepare('SELECT * FROM items ORDER BY id').all();
  let migrated = 0;
  let skipped = 0;

  // Category mapping
  const defaultTopicSlugs = {
    'LLMs & Generative AI': 'llms-generative-ai',
    'AI & Machine Learning': 'ai-machine-learning',
    'AI Coding Tools': 'ai-coding-tools',
    'Web Development': 'web-development',
    'DevOps & Infra': 'devops-infra',
    'Security': 'security',
    'Startups': 'startups',
    'Robotics': 'robotics',
    'Crypto & Web3': 'crypto-web3',
    'Design': 'design',
    'Tools': 'ai-coding-tools',
  };

  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO information_items
      (id, source_id, canonical_url, title, original_summary, content_text,
       published_at, fetched_at, digest_date, source_payload, normalized_payload,
       score, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertTopic = db.prepare(`
    INSERT OR IGNORE INTO item_topics (item_id, topic_id, relevance, assigned_by)
    VALUES (?, ?, ?, 'migration')
  `);

  const insertSummary = db.prepare(`
    INSERT OR IGNORE INTO ai_summaries
      (id, item_id, model_provider, model_name, prompt_version, one_liner, short_summary,
       key_points, created_at)
    VALUES (?, ?, 'legacy', 'legacy', 'v0', ?, ?, ?, datetime('now'))
  `);

  const transaction = db.transaction(() => {
    for (const item of legacyItems) {
      const sourceId = lookupSourceId(db, item.source);
      if (!sourceId) {
        skipped++;
        continue;
      }

      const itemId = generateId();

      // Parse digest date from pub_date or created_at
      let digestDate;
      if (item.pub_date) {
        digestDate = String(item.pub_date).replace(/-/g, '').slice(0, 8);
      } else if (item.created_at) {
        digestDate = String(item.created_at).replace(/-/g, '').slice(0, 8);
      } else {
        digestDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      }

      // Parse tags
      let tags;
      try {
        tags = JSON.parse(item.tags || '[]');
      } catch {
        tags = [];
      }

      // Build source payload
      const sourcePayload = {
        legacy_id: item.id,
        legacy_source: item.source,
        category: item.category,
        tags: tags,
      };

      // Normalize payload
      const normalizedPayload = {};

      // Parse score from importance (1-10 scale → 0-1)
      const score = item.importance ? Math.min(item.importance / 10, 1) : 0.5;

      // Content hash for dedup
      const hash = generateContentHash(item.title + (item.url || ''));

      insertItem.run(
        itemId,                    // id
        sourceId,                  // source_id
        item.url || '',            // canonical_url
        item.title,                // title
        item.summary || '',        // original_summary
        item.content_raw || '',    // content_text
        item.pub_date || null,     // published_at
        digestDate,                // digest_date
        JSON.stringify(sourcePayload),  // source_payload
        JSON.stringify(normalizedPayload), // normalized_payload
        score,                     // score
        hash,                      // content_hash
        item.created_at || null,   // created_at
      );

      // Create AI summary from legacy summary if available
      if (item.summary) {
        const summaryId = generateId();
        const keyPoints = [];
        if (item.category) {
          keyPoints.push(`Category: ${item.category}`);
        }
        insertSummary.run(
          summaryId,
          itemId,
          item.summary.slice(0, 200),  // one_liner
          item.summary,                 // short_summary
          JSON.stringify(keyPoints),
        );
      }

      // Map category to topic
      if (item.category && defaultTopicSlugs[item.category]) {
        const slug = defaultTopicSlugs[item.category];
        const topic = db.prepare('SELECT id FROM topics WHERE slug = ?').get(slug);
        if (topic) {
          insertTopic.run(itemId, topic.id, 0.8);
        }
      }

      migrated++;
    }
  });

  try {
    transaction();
    console.log(`  ✅ Migrated ${migrated} items, skipped ${skipped} (no source match).`);
  } catch (err) {
    console.error('  ❌ Migration failed:', err.message);
  }
}

// Allow running directly
if (require.main === module) {
  run();
  const { closeDB } = require('../db/connection');
  closeDB();
}

module.exports = { run };
