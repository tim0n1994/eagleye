#!/usr/bin/env node
/**
 * reclassify-uncategorized.js — 一次性回填：消化 X 信号源中的 uncategorized
 *
 * 用 LLM-extracted tags 预分类：
 *   - 噪音 (non_tech)：电竞/体育/梗/社交媒体 → signal_type='non_tech'
 *   - 低信号 (low_signal)：信息缺失/待核实 → 保持 uncategorized 但降权 thesis_match
 *   - 其余：不改动（留给正常流水线的 LLM 信号分类器处理）
 *
 * 用法: node scripts/reclassify-uncategorized.js [--source x-following] [--dry-run]
 */
'use strict';
require('dotenv').config();

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'eagleye.db'));

const NOISE_TAG_RE = /体育|足球|篮球|电竞|游戏|使命召唤|赛事|社交媒体|非技术|无关内容|娱乐|明星|政治|军事|战争|情绪|搞笑|美食|旅游|时尚|宠物|健身|音乐|影视|彩票|赌博|黑色幽默|网络热梗|日常观察|个人生活|网红|段子/i;
const LOW_SIGNAL_TAG_RE = /信息缺失|信息不足|待核实|数据缺失|数据不完整|内容空白|内容缺失|无法分类|抓取失败|X平台|待确认|无实质内容/i;
const TECH_TAG_RE = /大模型|AI|LLM|开源|机器学习|深度学习|编程|代码|推理|训练|微调|向量|嵌入|agent|智能体|具身|机器人|云计算|数据库|前端|后端|API|芯片|GPU|量子|区块链|航天|SpaceX|半导体|Transformer|MoE|扩散模型|强化学习|神经网络|算法|框架|SDK|编译|分布式|微服务|容器|Kubernetes|Docker/i;

const sourceSlug = process.argv.includes('--source')
  ? process.argv[process.argv.indexOf('--source') + 1]
  : 'x-following';
const dryRun = process.argv.includes('--dry-run');

console.log(`\n🔍 Reclassifying uncategorized items for source: ${sourceSlug}${dryRun ? ' (DRY RUN)' : ''}\n`);

// Fetch all uncategorized signal_scores for this source, with their tags
const rows = db.prepare(`
  SELECT ss.item_id, ss.signal_type, i.author, i.title,
         GROUP_CONCAT(t.name, '||') as tag_names
  FROM signal_scores ss
  JOIN information_items i ON ss.item_id = i.id
  JOIN sources s ON i.source_id = s.id
  LEFT JOIN item_tags itag ON itag.item_id = i.id
  LEFT JOIN tags t ON t.id = itag.tag_id AND t.type = 'llm-extracted'
  WHERE ss.signal_type = 'uncategorized' AND s.slug = ?
  GROUP BY ss.item_id
  ORDER BY i.score DESC
`).all(sourceSlug);

console.log(`Found ${rows.length} uncategorized items\n`);

const updateStmt = db.prepare(`
  UPDATE signal_scores SET signal_type = ?, thesis_match_score = ? WHERE item_id = ?
`);

let noiseCount = 0;
let lowSignalCount = 0;
let techCount = 0;
let noTagsCount = 0;
let remainCount = 0;
const noiseAuthors = {};

for (const row of rows) {
  const tags = row.tag_names ? row.tag_names.split('||') : [];

  if (tags.length === 0) {
    noTagsCount++;
    remainCount++;
    continue;
  }

  const tagText = tags.join(' ');

  if (NOISE_TAG_RE.test(tagText) && !TECH_TAG_RE.test(tagText)) {
    noiseCount++;
    if (row.author) {
      noiseAuthors[row.author] = (noiseAuthors[row.author] || 0) + 1;
    }
    if (!dryRun) {
      try { updateStmt.run(row.item_id, 'non_tech', 0.1); } catch (e) { console.warn(`  ⚠ update failed for ${row.item_id.slice(0,8)}: ${e.message}`); }
    }
  } else if (LOW_SIGNAL_TAG_RE.test(tagText) && !TECH_TAG_RE.test(tagText)) {
    lowSignalCount++;
    if (!dryRun) {
      try { updateStmt.run(row.item_id, 'uncategorized', 0.1); } catch (e) { console.warn(`  ⚠ update failed for ${row.item_id.slice(0,8)}: ${e.message}`); }
    }
  } else if (TECH_TAG_RE.test(tagText)) {
    techCount++;
    remainCount++; // leave for LLM reclassification in pipeline
  } else {
    remainCount++;
  }
}

console.log('════════════════════════════════════════════');
console.log('分类结果汇总:');
console.log(`  🔇 non_tech (噪音)     : ${noiseCount}`);
console.log(`  📉 low_signal (信息不足) : ${lowSignalCount}`);
console.log(`  🔬 tech (留待重新分类)   : ${techCount}`);
console.log(`  ❓ no tags (无标签)     : ${noTagsCount}`);
console.log(`  ──────────────────────`);
console.log(`  总计                   : ${rows.length}`);
console.log(`  已处理(改动)            : ${dryRun ? '0 (dry run)' : (noiseCount + lowSignalCount)}`);
console.log(`  剩余 uncategorized      : ${remainCount}`);
console.log('════════════════════════════════════════════\n');

if (Object.keys(noiseAuthors).length > 0) {
  console.log('噪音 top authors (考虑加入 blocklist):');
  Object.entries(noiseAuthors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([author, count]) => console.log(`  ${author}: ${count}条`));
  console.log();
}

db.close();
