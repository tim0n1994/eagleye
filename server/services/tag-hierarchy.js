/**
 * Eagleye — Tag Hierarchy Builder
 *
 * Two-round LLM pipeline that builds a four-level knowledge tree:
 *   Domain → Topic → SubTopic → Tag
 *
 * Round 1: Clusters 100 top Chinese tags into 20-30 SubTopics with meaningful names.
 * Round 2: Clusters SubTopics into 6-10 Topics, then 3-5 Domains.
 *
 * Writes results to knowledge_domains and tag_hierarchy tables.
 */

const { getDB } = require('../db/connection');
const { getProvider, extractJSON } = require('./llm-provider');
const { taskContext, abortableDelay } = require('./llm-shared');
const crypto = require('crypto');

const DEFAULT_MAX_TAGS = Math.max(30, parseInt(process.env.TAG_HIERARCHY_MAX_TAGS || '240', 10));
const ROUND1_CHUNK_SIZE = Math.max(50, parseInt(process.env.TAG_HIERARCHY_CHUNK_SIZE || '60', 10));
const ROUND1_MAX_TOKENS = Math.max(8192, parseInt(process.env.TAG_HIERARCHY_ROUND1_MAX_TOKENS || '16384', 10));
const ROUND2_MAX_TOKENS = Math.max(8192, parseInt(process.env.TAG_HIERARCHY_ROUND2_MAX_TOKENS || '16384', 10));

const WEAK_TAG_RE = /(推文|社交媒体|X平台|用户动态|技术动态|AI动态|待确认|非技术内容|个人动态|动态更新|信息不足|无实质内容)/i;

const ROUND1_PROMPT = `/no_think
你是中文技术知识图谱架构师。下面是一组从技术资讯 Feed 中提取出来的中文标签，请将它们组织成可扩展的"概念簇 (SubTopic)"。

核心原则：
1. 这不是单父树，而是概念 DAG。一个标签可以放入 1-3 个 SubTopic。
2. 每个标签必须至少有一个 primary 归属；如果它确实跨领域，可额外给 secondary 归属。
3. SubTopic 必须是可继续向下展开的技术概念，不要用"技术动态""社交媒体"这类信息源元标签做主干。
4. 父子概念不能同名或近同名。不要生成"AI应用与工具"这种过宽又重复的节点。
5. 不要创造新的标签，只能引用输入标签；但可以创造更好的 SubTopic 名称。
6. 低信号标签（推文、社交媒体、用户动态、待确认、非技术内容等）只能放入"低信号元信息"或作为 secondary，不要污染核心技术簇。

输入标签列表：
{{tag_list}}

输出严格 JSON：
{
  "sub_topics": [
    {
      "name_zh": "大模型架构与训练",
      "slug": "llm-architecture",
      "tags": ["大语言模型", "Transformer", "预训练", "微调"],
      "secondary_tags": ["推理加速"],
      "description_zh": "包含大语言模型的架构设计、训练方法和优化技术"
    }
  ]
}
要求：所有标签必须至少出现在 tags 或 secondary_tags 中一次，不要遗漏。slug 使用英文简写。`;

const ROUND2_PROMPT = `/no_think
你是中文技术知识图谱架构师。下面是一组已经局部聚类好的"子方向 (SubTopic)"及其包含的技术标签。

请把它们重排成一个可扩展的概念 DAG 的可视化骨架：
1. 先生成 12-28 个"方向 (Topic)"。Topic 是可继续展开的概念节点，不是固定分类桶。
2. 再生成 4-7 个"领域 (Domain)"。Domain 少而稳定，用于 3D 图谱锚点。
3. 一个 SubTopic 可以挂到 1-3 个 Topic 下；一个 Topic 只选一个最主要 Domain。
4. 不允许 Topic 和 SubTopic 同名嵌套，不允许空泛重复词。
5. 横跨多个方向的概念应通过多父归属表达，不要强行二选一。
6. 低信号/来源元信息必须边缘化，不能成为 Domain 或核心 Topic。

输入子方向：
{{sub_topics_json}}

输出严格 JSON：
{
  "domains": [
    {
      "name_zh": "人工智能",
      "slug": "artificial-intelligence",
      "description_zh": "涵盖AI模型、算法、应用和安全",
      "topics": ["AI基础模型"]
    }
  ],
  "topics": [
    {
      "name_zh": "AI基础模型",
      "slug": "ai-foundation-models",
      "description_zh": "大模型架构、训练与推理优化",
      "domain": "人工智能",
      "sub_topics": ["大模型架构与训练", "推理加速与优化", "多模态模型"]
    }
  ]
}
要求：所有子方向必须被分配到某个 Topic，所有 Topic 必须被分配到某个 Domain。
domain 和 topics 数组必须覆盖全部输入。`;

function getHierarchyPromptVersion() {
  return 'hierarchy-v2.0-concept-dag';
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeSlug(input, fallbackPrefix = 'node') {
  const raw = String(input || '').trim().toLowerCase();
  const slug = raw
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || `${fallbackPrefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function parseSubTopics(parsed) {
  if (parsed && Array.isArray(parsed.sub_topics)) return parsed.sub_topics;
  if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name_zh) return parsed;
  if (parsed && typeof parsed === 'object' && parsed[0] && parsed[0].name_zh) {
    return Object.values(parsed).filter(v => v && typeof v === 'object' && v.name_zh);
  }
  return null;
}

function normalizeSubTopics(rawSubTopics, allowedTags, chunkIndex) {
  const allowed = new Set(allowedTags.map(t => t.name));
  const assignedCounts = new Map();
  const normalized = [];
  let order = 0;

  for (const st of rawSubTopics || []) {
    const name = String(st?.name_zh || st?.name || '').trim();
    if (!name) continue;

    const primaryTags = Array.isArray(st.tags) ? st.tags : [];
    const secondaryTags = Array.isArray(st.secondary_tags) ? st.secondary_tags : [];
    const tags = [...primaryTags, ...secondaryTags]
      .map(t => typeof t === 'string' ? t : String(t?.name || t?.tag || '').trim())
      .filter(Boolean)
      .filter(t => allowed.has(t));
    const uniqueTags = [...new Set(tags)];

    if (uniqueTags.length === 0) continue;
    for (const tag of uniqueTags) {
      assignedCounts.set(tag, (assignedCounts.get(tag) || 0) + 1);
    }

    order++;
    normalized.push({
      name_zh: name,
      slug: normalizeSlug(st.slug || name, `subtopic-${chunkIndex}-${order}`),
      tags: uniqueTags,
      description_zh: String(st.description_zh || '').trim(),
    });
  }

  const missing = allowedTags.map(t => t.name).filter(name => !assignedCounts.has(name));
  if (missing.length > 0) {
    normalized.push({
      name_zh: `未归类技术标签${chunkIndex}`,
      slug: `uncategorized-technical-tags-${chunkIndex}`,
      tags: missing,
      description_zh: 'LLM 聚类遗漏后自动补全的技术标签，后续重跑可重新归类。',
    });
  }

  return normalized;
}

function mergeSubTopicsByName(subTopics) {
  const byName = new Map();
  for (const st of subTopics || []) {
    const name = String(st.name_zh || '').trim();
    if (!name) continue;
    const key = name.replace(/\s+/g, '').toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, { ...st, tags: [...new Set(st.tags || [])] });
      continue;
    }
    const existing = byName.get(key);
    existing.tags = [...new Set([...(existing.tags || []), ...(st.tags || [])])];
    if (!existing.description_zh && st.description_zh) existing.description_zh = st.description_zh;
  }
  return [...byName.values()];
}

function resolveChildConceptName(parentName, childName) {
  const parent = String(parentName || '').replace(/\s+/g, '');
  const child = String(childName || '').replace(/\s+/g, '');
  if (!parent || !child || parent !== child) return childName;
  return `${childName}细分概念`;
}

function normalizeConceptKey(label) {
  return String(label || '').replace(/\s+/g, '').toLowerCase();
}

function conceptSlugBase(kind, labelZh, slugBase) {
  if (['domain', 'topic', 'concept'].includes(kind)) return labelZh;
  if (kind === 'tag') return slugBase || labelZh;
  return slugBase || labelZh;
}

function scoreTagCandidate(tag) {
  const count = Number(tag.item_count || 0);
  let score = Math.log10(count + 1);
  if (WEAK_TAG_RE.test(tag.name)) score -= 2.5;
  if (tag.name.length <= 2) score -= 0.4;
  if (/^(AI|人工智能|技术|动态)$/.test(tag.name)) score -= 0.8;
  return score;
}

async function runRound1(provider, chunkTags, chunkIndex, task) {
  const tagList = chunkTags.map(t => t.name).join('\n');
  const r1Prompt = ROUND1_PROMPT.replace('{{tag_list}}', tagList);

  const maxAttempts = provider.isPool ? 1 : 5;
  const validate = parsed => {
    const groups = parseSubTopics(parsed);
    return Array.isArray(groups) && groups.length > 0 && groups.every(group =>
      group && typeof (group.name_zh || group.name) === 'string' && (group.name_zh || group.name).trim()
      && Array.isArray(group.tags) && group.tags.some(tag => chunkTags.some(allowed => allowed.name === (typeof tag === 'string' ? tag : tag?.name || tag?.tag))));
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      task.check();
      const text = await provider.call(r1Prompt, { task: 'graph', json: true, validate, temperature: 0.1, maxTokens: ROUND1_MAX_TOKENS, signal: task.signal });
      task.check();
      if (!text) throw new Error('LLM returned empty response');

      const parsed = extractJSON(text);
      if (!validate(parsed)) throw new Error('Round 1 returned invalid sub-topic assignments');
      const subTopics = parseSubTopics(parsed);
      if (subTopics && subTopics.length > 0) {
        return normalizeSubTopics(subTopics, chunkTags, chunkIndex);
      }
    } catch (err) {
      task.check();
      if (attempt >= maxAttempts) throw new Error(`Round 1 chunk ${chunkIndex} failed: ${err.message}`, { cause: err });
      const delayMs = Math.min(30000, 2000 * Math.pow(2, attempt));
      console.log(`  ❌ R1 chunk ${chunkIndex} attempt ${attempt} error: ${err.message} — retrying in ${Math.round(delayMs/1000)}s`);
      await abortableDelay(delayMs, task.signal);
    }
  }

  throw new Error(`Round 1 chunk ${chunkIndex} produced no sub-topics`);
}

function ensureHierarchyCoverage(hierarchy, subTopics) {
  const allSubTopicNames = new Set(subTopics.map(st => st.name_zh));
  const assignedSubTopicNames = new Set();

  for (const topic of hierarchy.topics || []) {
    for (const name of topic.sub_topics || []) {
      if (allSubTopicNames.has(name)) assignedSubTopicNames.add(name);
    }
  }

  const missingSubTopics = [...allSubTopicNames].filter(name => !assignedSubTopicNames.has(name));
  if (missingSubTopics.length > 0) {
    const fallbackTopic = {
      name_zh: '未归类技术方向',
      slug: 'uncategorized-technical-direction',
      description_zh: 'Round2 聚合遗漏后自动补全的子方向，后续重跑可重新归类。',
      domain: '技术观察',
      sub_topics: missingSubTopics,
    };
    hierarchy.topics = [...(hierarchy.topics || []), fallbackTopic];

    let fallbackDomain = (hierarchy.domains || []).find(d => d.name_zh === '技术观察');
    if (!fallbackDomain) {
      fallbackDomain = {
        name_zh: '技术观察',
        slug: 'technology-observation',
        description_zh: '自动补全的技术观察领域，用于承接暂未稳定归类的概念。',
        topics: [],
      };
      hierarchy.domains = [...(hierarchy.domains || []), fallbackDomain];
    }
    fallbackDomain.topics = [...new Set([...(fallbackDomain.topics || []), fallbackTopic.name_zh])];
  }

  const allTopicNames = new Set((hierarchy.topics || []).map(t => t.name_zh));
  const assignedTopicNames = new Set();
  for (const domain of hierarchy.domains || []) {
    for (const name of domain.topics || []) {
      if (allTopicNames.has(name)) assignedTopicNames.add(name);
    }
  }

  const missingTopics = [...allTopicNames].filter(name => !assignedTopicNames.has(name));
  if (missingTopics.length > 0) {
    let fallbackDomain = (hierarchy.domains || []).find(d => d.name_zh === '技术观察');
    if (!fallbackDomain) {
      fallbackDomain = {
        name_zh: '技术观察',
        slug: 'technology-observation',
        description_zh: '自动补全的技术观察领域，用于承接暂未稳定归类的概念。',
        topics: [],
      };
      hierarchy.domains = [...(hierarchy.domains || []), fallbackDomain];
    }
    fallbackDomain.topics = [...new Set([...(fallbackDomain.topics || []), ...missingTopics])];
  }

  return hierarchy;
}

function normalizeHierarchyOutput(hierarchy) {
  const domains = [];
  for (const domain of hierarchy.domains || []) {
    const name = String(domain?.name_zh || domain?.name || domain?.title || '').trim();
    if (!name) continue;
    domains.push({
      ...domain,
      name_zh: name,
      slug: domain.slug || name,
      topics: (domain.topics || [])
        .map(t => typeof t === 'string' ? t : String(t?.name_zh || t?.name || t?.title || '').trim())
        .filter(Boolean),
    });
  }

  const topics = [];
  for (const topic of hierarchy.topics || []) {
    const name = String(topic?.name_zh || topic?.name || topic?.title || '').trim();
    if (!name) continue;
    topics.push({
      ...topic,
      name_zh: name,
      slug: topic.slug || name,
      domain: typeof topic.domain === 'string'
        ? topic.domain
        : String(topic.domain?.name_zh || topic.domain?.name || topic.domain?.title || '').trim(),
      sub_topics: (topic.sub_topics || topic.subTopics || [])
        .map(st => typeof st === 'string' ? st : String(st?.name_zh || st?.name || st?.title || '').trim())
        .filter(Boolean),
    });
  }

  return { ...hierarchy, domains, topics };
}

async function buildTagHierarchy(opts = {}) {
  const task = taskContext(opts);
  task.check();
  const db = getDB();
  if (!db) throw new Error('Database not available');

  const provider = getProvider();
  if (!provider) throw new Error('No LLM provider configured');

  // ── Gather top Chinese tags ──
  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
  const tagRows = db.prepare(`
    SELECT t.id, t.slug, t.name, COUNT(it.item_id) as item_count
    FROM tags t
    JOIN item_tags it ON it.tag_id = t.id
    WHERE t.type IN ('llm-extracted', 'general')
    GROUP BY t.id
    ORDER BY item_count DESC
    LIMIT ?
  `).all(DEFAULT_MAX_TAGS * 2);

  const tags = tagRows
    .filter(t => CJK_RE.test(t.name))
    .map(t => ({ ...t, concept_score: scoreTagCandidate(t) }))
    .sort((a, b) => {
      if (b.concept_score !== a.concept_score) return b.concept_score - a.concept_score;
      return (b.item_count || 0) - (a.item_count || 0);
    })
    .slice(0, DEFAULT_MAX_TAGS);
  if (tags.length < 30) throw new Error('Not enough Chinese tags (need >= 30)');

  console.log(`  🏷️  Building hierarchy for ${tags.length} Chinese tags...`);

  // ── Round 1: Tag → SubTopic, batched to avoid JSON truncation ──
  const chunks = chunkArray(tags, ROUND1_CHUNK_SIZE);
  const subTopics = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkSubTopics = await runRound1(provider, chunks[i], i + 1, task);
    subTopics.push(...chunkSubTopics);
  }
  const mergedSubTopics = mergeSubTopicsByName(subTopics);

  if (!mergedSubTopics || mergedSubTopics.length === 0) throw new Error('Round 1 produced no sub-topics');
  console.log(`  📊 Round 1: ${mergedSubTopics.length} sub-topics from ${tags.length} tags (${subTopics.length} raw)`);

  // ── Round 2: SubTopic → Topic → Domain ──
  const r2Prompt = ROUND2_PROMPT.replace('{{sub_topics_json}}', JSON.stringify(mergedSubTopics, null, 2));

  let hierarchy;
  const maxAttempts = provider.isPool ? 1 : 5;
  const validate = parsed => Boolean(parsed && Array.isArray(parsed.domains) && parsed.domains.length > 0
    && Array.isArray(parsed.topics) && parsed.topics.length > 0
    && parsed.domains.every(domain => typeof domain?.name_zh === 'string' && domain.name_zh.trim() && Array.isArray(domain.topics))
    && parsed.topics.every(topic => typeof topic?.name_zh === 'string' && topic.name_zh.trim()
      && typeof topic.domain === 'string' && topic.domain.trim() && Array.isArray(topic.sub_topics)));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      task.check();
      const text = await provider.call(r2Prompt, { task: 'graph', json: true, validate, temperature: 0.1, maxTokens: ROUND2_MAX_TOKENS, signal: task.signal });
      task.check();
      if (!text) throw new Error('LLM returned empty response');
      const parsed = extractJSON(text);
      if (!validate(parsed)) throw new Error('Round 2 returned invalid domains/topics');
      if (parsed && parsed.domains && parsed.topics) {
        hierarchy = normalizeHierarchyOutput(ensureHierarchyCoverage(parsed, mergedSubTopics));
        break;
      }
    } catch (err) {
      task.check();
      if (attempt >= maxAttempts) throw new Error(`Round 2 failed: ${err.message}`, { cause: err });
      console.log(`  ❌ R2 attempt ${attempt} error: ${err.message}`);
      const delayMs = Math.min(15000, 1000 * Math.pow(2, attempt));
      await abortableDelay(delayMs, task.signal);
    }
  }

  if (!hierarchy || !hierarchy.domains || !hierarchy.topics) {
    throw new Error('Round 2 produced no hierarchy');
  }
  console.log(`  📊 Round 2: ${hierarchy.domains.length} domains, ${hierarchy.topics.length} topics`);

  // ── Write to DB ──
  const writeDb = db;
  const writeTransaction = writeDb.transaction(() => {
    task.check();
    // Clear existing hierarchy
    writeDb.prepare('DELETE FROM tag_hierarchy').run();
    writeDb.prepare('DELETE FROM knowledge_domains').run();
    writeDb.prepare("DELETE FROM graph_edges WHERE edge_type IN ('tag_belongs_subtopic','subtopic_belongs_topic','topic_belongs_domain')").run();

    const insertDomain = writeDb.prepare(`
      INSERT OR REPLACE INTO knowledge_domains (id, slug, name, name_zh, description_zh, display_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertHierarchy = writeDb.prepare(`
      INSERT OR REPLACE INTO tag_hierarchy (
        id, tag_id, parent_node_id, topic_name_zh, topic_slug, domain_id, level,
        confidence, assigned_by, prompt_version, relationship_type, rationale_zh, is_primary
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'llm', ?, ?, ?, ?)
    `);

    const insertEdge = writeDb.prepare(`
      INSERT OR REPLACE INTO graph_edges (id, from_type, from_id, to_type, to_id, edge_type, weight, evidence_item_ids, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', datetime('now'), datetime('now'))
    `);

    const promptVer = getHierarchyPromptVersion();
    const conceptRunId = makeId('kcgr');
    writeDb.prepare(`
      INSERT INTO kg_concept_runs (id, status, prompt_version, selected_tags, metrics)
      VALUES (?, 'running', ?, ?, ?)
    `).run(conceptRunId, promptVer, tags.length, JSON.stringify({ builder: 'tag-hierarchy', mode: 'concept-graph' }));

    const insertConceptNode = writeDb.prepare(`
      INSERT OR IGNORE INTO kg_concept_nodes (
        id, run_id, kind, slug, label, label_zh, description_zh, source_tag_id,
        depth_hint, prompt_version, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getConceptNodeBySlug = writeDb.prepare(`
      SELECT id FROM kg_concept_nodes WHERE run_id = ? AND kind = ? AND slug = ?
    `);
    const insertConceptEdge = writeDb.prepare(`
      INSERT OR IGNORE INTO kg_concept_edges (
        id, run_id, from_node_id, to_node_id, edge_type, weight, confidence,
        is_primary, rationale_zh, prompt_version, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getConceptParentEdge = writeDb.prepare(`
      SELECT id, edge_type, is_primary
      FROM kg_concept_edges
      WHERE run_id = ?
        AND from_node_id = ?
        AND to_node_id = ?
        AND edge_type IN ('primary_parent', 'secondary_parent', 'contains')
      LIMIT 1
    `);
    const upgradeConceptParentEdge = writeDb.prepare(`
      UPDATE kg_concept_edges
      SET edge_type = 'primary_parent',
          is_primary = 1,
          weight = MAX(weight, ?),
          confidence = MAX(confidence, ?),
          rationale_zh = CASE WHEN rationale_zh = '' THEN ? ELSE rationale_zh END
      WHERE id = ?
    `);

    const conceptNode = (kind, labelZh, slugBase, opts = {}) => {
      const slug = normalizeSlug(conceptSlugBase(kind, labelZh, slugBase), kind);
      const existing = getConceptNodeBySlug.get(conceptRunId, kind, slug);
      if (existing?.id) return existing.id;
      const id = makeId('kcn');
      const result = insertConceptNode.run(
        id,
        conceptRunId,
        kind,
        slug,
        labelZh,
        labelZh,
        opts.description_zh || '',
        opts.source_tag_id || null,
        opts.depth_hint || 0,
        promptVer,
        JSON.stringify(opts.metadata || {})
      );
      if (result.changes > 0) return id;
      const inserted = getConceptNodeBySlug.get(conceptRunId, kind, slug);
      if (inserted?.id) return inserted.id;
      throw new Error(`Failed to create concept node: ${kind}:${slug}`);
    };

    const conceptEdge = (fromId, toId, edgeType, opts = {}) => {
      if (!fromId || !toId || fromId === toId) return;
      if (['primary_parent', 'secondary_parent', 'contains'].includes(edgeType)) {
        const existing = getConceptParentEdge.get(conceptRunId, fromId, toId);
        if (existing?.id) {
          if (edgeType === 'primary_parent' && existing.edge_type === 'secondary_parent') {
            upgradeConceptParentEdge.run(opts.weight ?? 1, opts.confidence ?? 0.8, opts.rationale_zh || '', existing.id);
          }
          return;
        }
      }
      insertConceptEdge.run(
        makeId('kce'),
        conceptRunId,
        fromId,
        toId,
        edgeType,
        opts.weight ?? 1,
        opts.confidence ?? 0.8,
        opts.is_primary === false ? 0 : 1,
        opts.rationale_zh || '',
        promptVer,
        JSON.stringify(opts.metadata || {})
      );
    };

    let domainOrder = 0;
    const usedDomainSlugs = new Set();
    const domainConceptIds = new Map();
    const topicConceptIds = new Map();
    const subTopicConceptIds = new Map();
    const subTopicParentCounts = new Map();
    const tagConceptIds = new Map();
    const tagParentCounts = new Map();

    // Write domains (L1)
    for (const domain of (hierarchy.domains || [])) {
      domainOrder++;
      const domainId = makeId('kd');
      let domainSlug = normalizeSlug(domain.slug || domain.name_zh, `domain-${domainOrder}`);
      if (usedDomainSlugs.has(domainSlug)) domainSlug = `${domainSlug}-${domainOrder}`;
      usedDomainSlugs.add(domainSlug);
      insertDomain.run(domainId, domainSlug, domain.name_zh, domain.name_zh, domain.description_zh || '', domainOrder);
      const domainConceptId = conceptNode('domain', domain.name_zh, domainSlug, {
        description_zh: domain.description_zh || '',
        depth_hint: 0,
      });
      domainConceptIds.set(domain.name_zh, domainConceptId);

      // Write topics (L2) under this domain
      const domainTopicNames = domain.topics || [];
      for (const topic of (hierarchy.topics || [])) {
        if (!domainTopicNames.includes(topic.name_zh)) continue;

        const topicId = makeId('kht');
        insertHierarchy.run(topicId, null, null, topic.name_zh, normalizeSlug(topic.slug || topic.name_zh, 'topic'), domainId, 1, 0.9, promptVer, 'belongs_to', topic.description_zh || '', 1);
        const topicKey = `${domain.name_zh}:${normalizeConceptKey(topic.name_zh)}`;
        const topicConceptId = conceptNode('topic', topic.name_zh, `${domainSlug}-${topic.slug || topic.name_zh}`, {
          description_zh: topic.description_zh || '',
          depth_hint: 1,
          metadata: { domain: domain.name_zh },
        });
        topicConceptIds.set(topicKey, topicConceptId);
        conceptEdge(topicConceptId, domainConceptId, 'contains', {
          weight: 0.95,
          confidence: 0.9,
          rationale_zh: topic.description_zh || '',
        });

        insertEdge.run(
          makeId('kge'),
          'tag_hierarchy_node', topicId, 'knowledge_domain', domainId, 'topic_belongs_domain', 0.9
        );

        // Write sub-topics (L3) under this topic
        const topicSubTopicNames = topic.sub_topics || [];
        for (const st of (mergedSubTopics || [])) {
          if (!topicSubTopicNames.includes(st.name_zh)) continue;

          const subTopicName = resolveChildConceptName(topic.name_zh, st.name_zh);
          const subTopicId = makeId('kht');
          insertHierarchy.run(subTopicId, null, topicId, subTopicName, normalizeSlug(st.slug || subTopicName, 'subtopic'), domainId, 2, 0.85, promptVer, 'belongs_to', st.description_zh || '', 1);
          const subTopicKey = normalizeConceptKey(st.name_zh);
          let subTopicConceptId = subTopicConceptIds.get(subTopicKey);
          if (!subTopicConceptId) {
            subTopicConceptId = conceptNode('concept', st.name_zh, st.slug || st.name_zh, {
              description_zh: st.description_zh || '',
              depth_hint: 2,
              metadata: { raw_name_zh: st.name_zh },
            });
            subTopicConceptIds.set(subTopicKey, subTopicConceptId);
          }
          const subTopicParentCount = subTopicParentCounts.get(subTopicKey) || 0;
          subTopicParentCounts.set(subTopicKey, subTopicParentCount + 1);
          conceptEdge(subTopicConceptId, topicConceptId, subTopicParentCount > 0 ? 'secondary_parent' : 'primary_parent', {
            weight: 0.85,
            confidence: 0.85,
            is_primary: subTopicParentCount === 0,
            rationale_zh: st.description_zh || '',
          });

          insertEdge.run(
            makeId('kge'),
            'tag_hierarchy_node', subTopicId, 'tag_hierarchy_node', topicId, 'subtopic_belongs_topic', 0.85
          );

          // Write tags (L4) under this sub-topic
          const subTopicTags = st.tags || [];
          for (const tagName of subTopicTags) {
            const tagRow = tags.find(t => t.name === tagName);
            if (!tagRow) continue;

            const tagHierId = makeId('kht');
            insertHierarchy.run(tagHierId, tagRow.id, subTopicId, null, null, domainId, 3, 0.8, promptVer, WEAK_TAG_RE.test(tagRow.name) ? 'weak_signal' : 'belongs_to', '', 1);
            let tagConceptId = tagConceptIds.get(tagRow.id);
            if (!tagConceptId) {
              tagConceptId = conceptNode('tag', tagRow.name, tagRow.slug || tagRow.name, {
                source_tag_id: tagRow.id,
                depth_hint: 3,
                metadata: { item_count: tagRow.item_count || 0, weak_signal: WEAK_TAG_RE.test(tagRow.name) },
              });
              tagConceptIds.set(tagRow.id, tagConceptId);
            }
            const tagParentCount = tagParentCounts.get(tagRow.id) || 0;
            tagParentCounts.set(tagRow.id, tagParentCount + 1);
            conceptEdge(tagConceptId, subTopicConceptId, tagParentCount === 0 ? 'primary_parent' : 'secondary_parent', {
              weight: WEAK_TAG_RE.test(tagRow.name) ? 0.25 : 0.8,
              confidence: WEAK_TAG_RE.test(tagRow.name) ? 0.45 : 0.8,
              is_primary: tagParentCount === 0,
              rationale_zh: WEAK_TAG_RE.test(tagRow.name) ? '低信号或来源元信息，边缘化挂载。' : '',
            });

            insertEdge.run(
              makeId('kge'),
              'tag', tagRow.id, 'tag_hierarchy_node', subTopicId, 'tag_belongs_subtopic', 0.8
            );
          }
        }
      }
    }

    const conceptCounts = {
      nodes: writeDb.prepare('SELECT COUNT(*) as cnt FROM kg_concept_nodes WHERE run_id = ?').get(conceptRunId).cnt,
      edges: writeDb.prepare('SELECT COUNT(*) as cnt FROM kg_concept_edges WHERE run_id = ?').get(conceptRunId).cnt,
      uniqueTags: writeDb.prepare("SELECT COUNT(*) as cnt FROM kg_concept_nodes WHERE run_id = ? AND kind = 'tag'").get(conceptRunId).cnt,
      multiParentTags: writeDb.prepare(`
        SELECT COUNT(*) as cnt FROM (
          SELECT n.id
          FROM kg_concept_nodes n
          JOIN kg_concept_edges e ON e.from_node_id = n.id
          WHERE n.run_id = ? AND n.kind = 'tag' AND e.edge_type IN ('primary_parent', 'secondary_parent')
          GROUP BY n.id
          HAVING COUNT(*) > 1
        )
      `).get(conceptRunId).cnt,
    };
    writeDb.prepare(`
      UPDATE kg_concept_runs
      SET status = 'completed',
          unique_tags = ?,
          node_count = ?,
          edge_count = ?,
          metrics = ?,
          completed_at = datetime('now')
      WHERE id = ?
    `).run(conceptCounts.uniqueTags, conceptCounts.nodes, conceptCounts.edges, JSON.stringify(conceptCounts), conceptRunId);
  });

  writeTransaction();

  const counts = {
    domains: db.prepare('SELECT COUNT(*) as cnt FROM knowledge_domains').get().cnt,
    topics: db.prepare("SELECT COUNT(*) as cnt FROM tag_hierarchy WHERE level = 1").get().cnt,
    subTopics: db.prepare("SELECT COUNT(*) as cnt FROM tag_hierarchy WHERE level = 2").get().cnt,
    tags: db.prepare("SELECT COUNT(*) as cnt FROM tag_hierarchy WHERE level = 3").get().cnt,
    uniqueTags: db.prepare("SELECT COUNT(DISTINCT tag_id) as cnt FROM tag_hierarchy WHERE level = 3").get().cnt,
    selectedTags: tags.length,
  };
  counts.coverage = counts.selectedTags > 0 ? Number((counts.uniqueTags / counts.selectedTags).toFixed(3)) : 0;
  counts.multiParentTags = db.prepare(`
    SELECT COUNT(*) as cnt FROM (
      SELECT tag_id FROM tag_hierarchy WHERE level = 3 GROUP BY tag_id HAVING COUNT(*) > 1
    )
  `).get().cnt;

  console.log(`  ✅ Hierarchy built: ${counts.domains} domains → ${counts.topics} topics → ${counts.subTopics} sub-topics → ${counts.uniqueTags}/${counts.selectedTags} unique tags (${Math.round(counts.coverage * 100)}%), ${counts.multiParentTags} multi-parent`);
  return counts;
}

module.exports = { buildTagHierarchy };
