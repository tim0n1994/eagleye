# RC title-only correction: prepared, not executed

Target database ONLY: `~/.codex/tmp/eagleye-1.1-acceptance.sqlite`.
Do not import the application's DB connection before setting this exact path.
The parent executor owns execution and summary replacement. This document and
`title-only-repair-before.json` were generated using a SQLite `mode=ro` connection.

## Observed scope

All three summaries still have trace `ebc86058-4840-4f75-a2ec-1a2f7e2461d0`.
All three items have empty `original_summary` and `content_text`.

| Table | Target rows | Action |
| --- | ---: | --- |
| ai_summaries | 3 | Parent replaces using corrected pure helper |
| item_tags | 15 | Delete only these item links, created 2026-09-09 03:57:13 |
| item_topics | 4 | Delete only these `assigned_by='llm'` links, same timestamp |
| graph_edges | 23 | Delete these item-origin edges: 15 tag, 4 topic, 4 entity |
| signal_scores | 3 | Invalidate; recompute after summary/tag correction |
| item_features | 3 | Preserve: based on original input, not AI summaries |
| item_tag_assignments | 21 | Preserve: 15 keyword and 6 source-rule assignments |
| item_topic_assignments | 3 | Preserve: deterministic taxonomy only; dynamic count 0 |
| entity_mentions / entity_links | 3 / 3 | Preserve: deterministic canonical-domain extraction |
| kg_edges | 27 | Preserve: 21 tags, 3 taxonomy, 3 canonical-domain entity edges |
| item_vectors / vector_index_refs | 0 / 0 | No action |

There were no indirect v1 or v2 edges whose evidence arrays mention these three
items. The four v1 entities are existing global definitions (WebGPU, OpenAI,
Anthropic, and Harvard); never delete those definitions. Keep all global tags,
topics, canonical entities, KG tags, extraction runs and request-event audit rows.

The v1 item-tag and graph-edge tables have no per-run extractor/trace field. The
trace guard, exact target IDs, creation timestamp, expected row counts and saved
row keys together constrain this one-time repair. Do not generalize it into an
automatic cleanup rule based only on `tags.type='llm-extracted'`.

## Transaction integration

Execute with a driver that catches every error and rolls back. Before running,
resolve the opened connection's `PRAGMA database_list` path to the exact target
above and re-export the affected rows. The JSON backup contains complete rows and
`PRAGMA table_info` column/primary-key metadata for each affected/preserved table.
Use the parent's existing connection and transaction around this sequence:

```sql
BEGIN IMMEDIATE;
CREATE TEMP TABLE rc_title_only_targets (id TEXT PRIMARY KEY);
INSERT INTO rc_title_only_targets VALUES
 ('63b5b8eb-19e1-40c6-aeee-187912db160f'),
 ('7f7a5e29-5310-4f7d-a523-6b934b1e349f'),
 ('98677b4a-b353-4bed-a8e1-d43c16f45e9b');

-- Driver must assert this result is 3 BEFORE replacing summaries or deleting.
SELECT COUNT(*) AS expected_three FROM information_items i
JOIN ai_summaries a ON a.item_id=i.id
WHERE i.id IN (SELECT id FROM rc_title_only_targets)
  AND COALESCE(i.original_summary,'')='' AND COALESCE(i.content_text,'')=''
  AND json_extract(a.llm_metadata,'$.trace_id')=
      'ebc86058-4840-4f75-a2ec-1a2f7e2461d0';

DELETE FROM item_tags
WHERE item_id IN (SELECT id FROM rc_title_only_targets)
  AND created_at='2026-09-09 03:57:13';
-- Assert changes() = 15, otherwise roll back.

DELETE FROM item_topics
WHERE item_id IN (SELECT id FROM rc_title_only_targets)
  AND assigned_by='llm' AND created_at='2026-09-09 03:57:13';
-- Assert changes() = 4, otherwise roll back.

DELETE FROM graph_edges
WHERE from_type='item' AND from_id IN (SELECT id FROM rc_title_only_targets)
  AND created_at='2026-09-09 03:57:13'
  AND ((to_type='tag' AND edge_type='item_has_tag')
    OR (to_type='topic' AND edge_type='item_belongs_topic')
    OR (to_type='entity' AND edge_type='item_mentions_entity'));
-- Assert changes() = 23, otherwise roll back.

DELETE FROM signal_scores WHERE item_id IN (SELECT id FROM rc_title_only_targets);
-- Assert changes() = 3, otherwise roll back.

-- Parent: update the three ai_summaries here using the corrected pure helper.
-- Preserve original request trace as historical evidence in repair metadata.
-- Assert zero remaining item_tags/item_topics and v1 item-origin edges for
-- these IDs; assert all preserved KG row keys/values equal the backup.
-- Only after every assertion succeeds:
DROP TABLE rc_title_only_targets;
COMMIT;
```

Do not feed this block blindly into sqlite3: the driver assertions and summary
updates shown as comments must be implemented by the parent executor.

## Recompute and rollback

KG extraction does not consume `ai_summaries`, `item_tags`, `item_topics` or
`graph_edges`: `features.py:380` composes title/original_summary/content_text, and
`selection.py:9` lists its complete original-input hash fields. Therefore a
summary-only repair does not require deleting or rerunning these valid KG rows.
If extraction is nevertheless desired for verification, invoke `extract_item`
with an explicit SELECT of only these IDs; the source/limit CLI is not an exact
ID selection contract. Do not run topics or embeddings for this repair.

`scoreSignals(items, opts)` can take only these three selected items, but it has
no complete no-LLM option: `llmSkipRuleMatched` may still classify unmatched items,
and `noRetry` disables only its second classification pass. The parent should
use an explicitly controlled scoring path; never call it assuming those flags
prohibit all model requests. `autoResearch` must remain false. Until recomputed,
the three scores remain absent rather than presenting stale results.

Rollback before commit is ordinary ROLLBACK. For an after-commit rollback, open
only this RC database; assert there were no subsequent edits to target-derived
rows; restore the three ai_summaries by primary key using all original columns;
insert the saved 15 item_tags, 4 item_topics, 23 graph_edges and 3 signal_scores
using explicit column names. If corrected rows already exist, replace only
matching saved primary keys inside the rollback transaction. Do not restore
whole tables, global definitions, user rows, raw information_items or valid KG
rows. The backup contains those preserved raw/KG rows for verification only.
