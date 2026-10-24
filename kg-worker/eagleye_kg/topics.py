from __future__ import annotations

import json
import sqlite3
import time
from collections import Counter, defaultdict

from .features import upsert_edge
from .pipeline import create_run, finish_run
from .selection import fair_items, resolve_sources
from .text import content_hash, slugify, stable_id
from .vectors import HASH_VECTOR_DIM, HASH_VECTOR_MODEL, feature_terms, hash_vector


DYNAMIC_TOPIC_VERSION = "dynamic-topic-lite-0.1"
# Terminal disposition for an item that was evaluated but did not form a
# stable group in the bounded window. The linked topic is inactive, so this
# marker converges the pending queue without creating a user-facing topic.
NO_STABLE_DYNAMIC_TOPIC_ID = "kdt_no_stable_dynamic_topic"
NO_STABLE_DYNAMIC_TOPIC_SLUG = "no-stable-dynamic-topic"
LOW_SIGNAL_TAG_TYPES = {"source"}
LOW_SIGNAL_ENTITY_TYPES = {"account"}
LOW_SIGNAL_DYNAMIC_LABELS = {
    "replying",
    "posted",
    "post",
    "does",
    "need",
    "archives",
    "today",
    "just",
    "like",
    "make",
    "made",
    "using",
    "use",
    "get",
    "got",
    "new",
    "more",
    "most",
    "one",
    "our",
    "out",
    "now",
    "don",
    "dont",
    "first",
    "show",
    "quote",
    "href",
    "x2f",
    "rel",
    "nofollow",
    "unavailable",
    "unavailable.",
    "introducing",
    "excited",
    "paper",
    "papers",
    "research",
    "model",
    "models",
    "language",
    "learning",
    "work",
    "share",
    "check",
    "good",
    "great",
    "really",
    "people",
    "think",
    "know",
    "here",
    "they",
    "after",
    "time",
    "data",
    "team",
    "built",
    "going",
    "best",
    "open",
    "some",
    "world",
    "announce",
    "released",
    "over",
    "over.",
    "than",
    "week",
    "large",
    "company",
    "company.",
    "update",
    "listed",
    "tracking",
    "sector",
    "technology",
    "technologies",
    "chinese",
}
SOURCE_PLATFORM_DOMAINS = {
    "apps.apple.com",
    "arxiv.org",
    "huggingface.co",
    "github.com",
    "google.com",
    "lobste.rs",
    "news.ycombinator.com",
    "producthunt.com",
    "solidot.org",
    "techmeme.com",
    "twitter.com",
    "v2ex.com",
    "x.com",
}
HIGH_SIGNAL_SHORT_LABELS = {"ai", "llm", "llms", "rag", "mcp", "gpu", "api", "sdk", "cli", "sql", "ui", "ux"}
KNOWN_DYNAMIC_LABELS = {
    "agent",
    "agents",
    "anthropic",
    "chatgpt",
    "claude",
    "codex",
    "cursor",
    "deepseek",
    "docker",
    "gemini",
    "google",
    "gpu",
    "javascript",
    "kubernetes",
    "llm",
    "llms",
    "mcp",
    "openai",
    "postgres",
    "python",
    "qwen",
    "rag",
    "react",
    "rust",
    "sqlite",
    "typescript",
    "vue",
}


# R3 drainer (EAGLEYE_R3_DRAINER) — converging pending predicate for the
# topics stage. Without it the stage re-picks the same top-score window every
# run and the 60k old dynamic-topic backlog never drains.
#
# The stage produces two outputs per selected item, and an item is done only
# when it has BOTH:
#   * the semantic-lite vector for HASH_VECTOR_MODEL — written unconditionally
#     for every selected item (upsert_item_vector in discover_topics);
#   * a dynamic-topic assignment — written only for groups that pass
#     should_keep_group(min_items).
# R3.1 ruling C (Q5): the vector alone used to be the done marker, which
# starved the lite_but_no_dynamic caliber (15,216 items on the 2026-10-20
# snapshot) — an item whose candidate keys never reached min_items left the
# run with a vector and no topic, and the predicate then excluded it forever.
# Pending = missing either output. Done items are never re-selected, so the
# pending set is monotone non-increasing modulo new intake and shrinks each
# time a selected item's group clears min_items.
#
# Alias `i` is the information_items row inside fair_items(); the dynamic
# check is on topic_kind alone (any assigner), matching the no_dynamic
# caliber definition, and it binds no extra parameter.
TOPICS_LITE_PENDING = """(NOT EXISTS (SELECT 1 FROM item_vectors v WHERE v.item_id = i.id
                   AND v.vector_type = 'semantic-lite' AND v.model_name = ?)
                OR NOT EXISTS (SELECT 1 FROM item_topic_assignments a WHERE a.item_id = i.id
                   AND a.topic_kind = 'dynamic'))"""


def load_items_for_topics(conn: sqlite3.Connection, sources: list[str] | None, limit: int,
                          pending: bool = False, order: str | None = None) -> list[sqlite3.Row]:
    return fair_items(conn, resolve_sources(conn, sources), limit,
                      join="LEFT JOIN item_features f ON f.item_id = i.id",
                      pending=TOPICS_LITE_PENDING if pending else "1=1",
                      params=(HASH_VECTOR_MODEL,) if pending else (),
                      order=order,
                      extra_columns=""", f.keyword_candidates, f.source_features,
                        (SELECT a.topic_id FROM item_topic_assignments a
                         WHERE a.item_id = i.id AND a.topic_kind = 'taxonomy'
                           AND a.assigned_by = 'deterministic'
                         ORDER BY a.relevance DESC, a.topic_id LIMIT 1) AS taxonomy_topic_id""")


def item_tags(conn: sqlite3.Connection, item_ids: list[str]) -> dict[str, list[sqlite3.Row]]:
    if not item_ids:
        return {}
    placeholders = ",".join("?" for _ in item_ids)
    rows = conn.execute(
        f"""
        SELECT a.item_id, t.label, t.type, a.confidence
        FROM item_tag_assignments a
        CROSS JOIN kg_tags t ON t.id = a.tag_id
        WHERE a.item_id IN ({placeholders})
          AND t.status = 'active'
        ORDER BY a.confidence DESC
        """,
        item_ids,
    ).fetchall()
    grouped: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        grouped[row["item_id"]].append(row)
    return grouped


def item_entities(conn: sqlite3.Connection, item_ids: list[str]) -> dict[str, list[sqlite3.Row]]:
    if not item_ids:
        return {}
    placeholders = ",".join("?" for _ in item_ids)
    rows = conn.execute(
        f"""
        SELECT em.item_id, ce.canonical_name, ce.entity_type, el.link_confidence
        FROM entity_mentions em
        JOIN entity_links el ON el.mention_id = em.id
        JOIN canonical_entities ce ON ce.id = el.entity_id
        WHERE em.item_id IN ({placeholders})
        ORDER BY el.link_confidence DESC
        """,
        item_ids,
    ).fetchall()
    grouped: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        grouped[row["item_id"]].append(row)
    return grouped


def candidate_keys(item: sqlite3.Row, tags: list[sqlite3.Row], entities: list[sqlite3.Row]) -> list[tuple[str, str, str, float]]:
    keys: list[tuple[str, str, str, float]] = []
    source = item["source_slug"]

    for entity in entities[:8]:
        entity_type = str(entity["entity_type"] or "")
        label = str(entity["canonical_name"] or "").strip()
        if not label or entity_type in LOW_SIGNAL_ENTITY_TYPES:
            continue
        if entity_type == "domain" and label.lower() in SOURCE_PLATFORM_DOMAINS:
            continue
        confidence = float(entity["link_confidence"] or 0.7)
        if entity_type in {"repo", "paper"}:
            keys.append((f"{source}:entity:{entity_type}:{label.lower()}", label, entity_type, min(confidence + 0.08, 0.98)))
        elif entity_type == "domain":
            keys.append((f"{source}:domain:{label.lower()}", label, "domain", confidence))
        elif entity_type == "person" and source == "hugging-face":
            keys.append((f"{source}:person:{label.lower()}", label, "person", max(confidence - 0.1, 0.5)))

    for tag in tags[:14]:
        tag_type = str(tag["type"] or "")
        label = str(tag["label"] or "").strip()
        if not label or tag_type in LOW_SIGNAL_TAG_TYPES:
            continue
        if label.lower() in LOW_SIGNAL_DYNAMIC_LABELS:
            continue
        if label.lower() in SOURCE_PLATFORM_DOMAINS:
            continue
        if tag_type not in {"technology", "repo", "domain", "keyword"}:
            continue
        if tag_type == "keyword" and len(label) < 3:
            continue
        confidence = float(tag["confidence"] or 0.55)
        keys.append((f"{source}:tag:{slugify(label)}", label, tag_type, confidence))

    unique: dict[str, tuple[str, str, str, float]] = {}
    for key, label, kind, confidence in keys:
        previous = unique.get(key)
        if not previous or confidence > previous[3]:
            unique[key] = (key, label, kind, confidence)
    return list(unique.values())[:10]


def should_keep_group(group: dict, min_items: int) -> bool:
    label = str(group["label"] or "").strip()
    label_lower = label.lower()
    item_count = len(group["items"])
    kind = str(group["kind"] or "")
    if item_count < min_items:
        return False
    if label_lower in LOW_SIGNAL_DYNAMIC_LABELS:
        return False
    if label_lower in SOURCE_PLATFORM_DOMAINS:
        return False
    if len(label_lower) <= 3 and label_lower not in HIGH_SIGNAL_SHORT_LABELS:
        return False
    if kind == "keyword" and item_count < max(min_items, 5):
        return False
    if kind == "keyword" and label_lower not in HIGH_SIGNAL_SHORT_LABELS:
        has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in label)
        has_signal_shape = any(ch in label for ch in ".-_/+#") or any(ch.isupper() for ch in label[1:])
        parent_topic_id = group["topic_counter"].most_common(1)[0][0] if group["topic_counter"] else ""
        parent_is_uncategorized = parent_topic_id == "kt999" or not parent_topic_id
        if parent_is_uncategorized and label_lower not in KNOWN_DYNAMIC_LABELS and not has_signal_shape:
            return False
        if not has_cjk and not has_signal_shape and item_count < 12:
            return False
    if kind == "person" and item_count < max(min_items, 4):
        return False
    if len(label) > 18 and item_count < 8:
        return False
    return True


def upsert_item_vector(conn: sqlite3.Connection, item: sqlite3.Row, terms: list[str]) -> None:
    vector = hash_vector(terms)
    chash = content_hash(item["title"], item["original_summary"], item["content_text"], item["canonical_url"], HASH_VECTOR_MODEL)
    conn.execute(
        """
        INSERT OR REPLACE INTO item_vectors
          (item_id, vector_type, model_name, dimension, vector_json, content_hash)
        VALUES (?, 'semantic-lite', ?, ?, ?, ?)
        """,
        (item["id"], HASH_VECTOR_MODEL, HASH_VECTOR_DIM, json.dumps(vector, separators=(",", ":")), chash),
    )


def upsert_dynamic_topic(
    conn: sqlite3.Connection,
    group_key: str,
    label: str,
    kind: str,
    item_ids: list[str],
    parent_topic_id: str | None,
    keywords: list[str],
    confidence: float,
) -> str:
    topic_id = "kdt_" + stable_id(group_key, DYNAMIC_TOPIC_VERSION)[:24]
    slug = slugify(f"{group_key}", "dynamic-topic")[:180]
    now_expr = "datetime('now')"
    conn.execute(
        f"""
        INSERT INTO dynamic_topics
          (id, slug, name, name_zh, parent_taxonomy_id, status, discovery_method,
           topic_model_version, keywords, representative_item_ids, source_diversity,
           item_count, growth_score, confidence, first_seen_at, last_seen_at, updated_at)
        VALUES (?, ?, ?, '', ?, 'active', 'semantic-lite',
                ?, ?, ?, 1, ?, ?, ?, {now_expr}, {now_expr}, {now_expr})
        ON CONFLICT(slug) DO UPDATE SET
          name=excluded.name,
          parent_taxonomy_id=excluded.parent_taxonomy_id,
          status='active',
          topic_model_version=excluded.topic_model_version,
          keywords=excluded.keywords,
          representative_item_ids=excluded.representative_item_ids,
          item_count=excluded.item_count,
          growth_score=excluded.growth_score,
          confidence=excluded.confidence,
          last_seen_at={now_expr},
          updated_at={now_expr}
        """,
        (
            topic_id,
            slug,
            label[:220],
            parent_topic_id,
            DYNAMIC_TOPIC_VERSION,
            json.dumps(keywords[:20], ensure_ascii=False),
            json.dumps(item_ids[:12], ensure_ascii=False),
            len(item_ids),
            round(min(len(item_ids) / 25, 1), 3),
            round(confidence, 3),
        ),
    )
    row = conn.execute("SELECT id FROM dynamic_topics WHERE slug = ?", (slug,)).fetchone()
    return str(row["id"] if row else topic_id)


def reset_semantic_lite_topics(conn: sqlite3.Connection, item_ids: list[str]) -> set[str]:
    affected = set()
    for start in range(0, len(item_ids), 400):
        batch = item_ids[start:start + 400]
        placeholders = ",".join("?" for _ in batch)
        affected.update(row[0] for row in conn.execute(f"""
            SELECT topic_id FROM item_topic_assignments WHERE item_id IN ({placeholders})
            AND topic_kind = 'dynamic' AND assigned_by IN ('semantic-lite', 'semantic-lite-terminal')
        """, batch))
        conn.execute(f"""DELETE FROM item_topic_assignments WHERE item_id IN ({placeholders})
            AND topic_kind = 'dynamic' AND assigned_by IN ('semantic-lite', 'semantic-lite-terminal')""", batch)
        conn.execute(f"""DELETE FROM kg_edges WHERE from_kind = 'item' AND from_id IN ({placeholders})
            AND edge_type = 'item_belongs_dynamic_topic' AND extractor = 'semantic-lite'""", batch)
    return affected


def ensure_no_stable_dynamic_topic(conn: sqlite3.Connection) -> None:
    """Create the hidden terminal topic used for non-groupable items."""
    conn.execute(
        """
        INSERT INTO dynamic_topics
          (id, slug, name, name_zh, status, discovery_method,
           topic_model_version, keywords, representative_item_ids,
           source_diversity, item_count, growth_score, confidence,
           first_seen_at, last_seen_at, updated_at)
        VALUES (?, ?, 'No stable dynamic topic', '暂未形成稳定动态主题', 'inactive',
                'semantic-lite', ?, '[]', '[]', 0, 0, 0, 0,
                datetime('now'), datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          status = 'inactive',
          topic_model_version = excluded.topic_model_version,
          updated_at = datetime('now')
        """,
        (NO_STABLE_DYNAMIC_TOPIC_ID, NO_STABLE_DYNAMIC_TOPIC_SLUG, DYNAMIC_TOPIC_VERSION),
    )


def refresh_topic_counts(conn: sqlite3.Connection, topic_ids: set[str]) -> None:
    for topic_id in topic_ids:
        members = conn.execute("""
            SELECT DISTINCT i.id, i.source_id FROM item_topic_assignments a
            JOIN information_items i ON i.id = a.item_id
            WHERE a.topic_kind = 'dynamic' AND a.topic_id = ? ORDER BY i.id
        """, (topic_id,)).fetchall()
        if not members:
            conn.execute("DELETE FROM dynamic_topics WHERE id = ? AND discovery_method = 'semantic-lite'", (topic_id,))
            continue
        conn.execute("""UPDATE dynamic_topics SET item_count = ?, source_diversity = ?,
            representative_item_ids = ?, growth_score = ? WHERE id = ? AND discovery_method = 'semantic-lite'""",
            (len(members), len({row["source_id"] for row in members}),
             json.dumps([row["id"] for row in members[:12]]), round(min(len(members) / 25, 1), 3), topic_id))


def topic_input_fingerprint(items: list[sqlite3.Row], tags: dict, entities: dict) -> str:
    fields = ("id", "title", "original_summary", "content_text", "canonical_url",
              "source_slug", "source_payload", "normalized_payload", "score",
              "keyword_candidates", "source_features", "taxonomy_topic_id")
    inputs = {
        "items": [[item[field] for field in fields] for item in items],
        "tags": {key: [tuple(row) for row in rows] for key, rows in tags.items()},
        "entities": {key: [tuple(row) for row in rows] for key, rows in entities.items()},
    }
    return content_hash(json.dumps(inputs, sort_keys=True, ensure_ascii=False))


def discover_topics(conn: sqlite3.Connection, sources: list[str] | None = None, limit: int = 5000,
                    min_items: int = 5, pending: bool = False, order: str | None = None) -> dict:
    chosen_sources = resolve_sources(conn, sources)
    run_id = create_run(
        conn,
        "dynamic-topic",
        ",".join(chosen_sources),
        {"sources": chosen_sources, "limit": limit, "min_items": min_items,
         "model": HASH_VECTOR_MODEL, "pending": bool(pending), "order": order},
    )
    start = time.time()
    metrics = {"run_id": run_id, "processed": 0, "vectors": 0, "dynamic_topics": 0, "assignments": 0, "edges": 0, "total": 0}
    try:
        prepared_version = conn.execute("PRAGMA data_version").fetchone()[0]
        phase_start = time.monotonic()
        items = load_items_for_topics(conn, chosen_sources, limit, pending=pending, order=order)
        item_ids = [str(item["id"]) for item in items]
        metrics["timings"] = {"select_seconds": round(time.monotonic() - phase_start, 3)}
        phase_start = time.monotonic()
        tags_by_item = item_tags(conn, item_ids)
        metrics["timings"]["tags_seconds"] = round(time.monotonic() - phase_start, 3)
        phase_start = time.monotonic()
        entities_by_item = item_entities(conn, item_ids)
        prepared_fingerprint = topic_input_fingerprint(items, tags_by_item, entities_by_item)
        metrics["timings"]["entities_seconds"] = round(time.monotonic() - phase_start, 3)
        phase_start = time.monotonic()
        groups: dict[str, dict] = {}
        prepared_vectors = []
        metrics["total"] = len(items)
        metrics["selection"] = "source-balanced-sample"
        metrics["replacement_scope"] = "selected-items-only"
        metrics["by_source"] = dict(Counter(item["source_slug"] for item in items))

        for item in items:
            tags = tags_by_item.get(item["id"], [])
            entities = entities_by_item.get(item["id"], [])
            try:
                parsed_keywords = json.loads(item["keyword_candidates"] or "[]")
            except Exception:
                parsed_keywords = []
            extra_terms = [str(row["label"]) for row in tags[:12]] + [str(row["canonical_name"]) for row in entities[:8]]
            terms = feature_terms("\n".join([item["title"] or "", item["original_summary"] or "", item["content_text"] or ""]), [*parsed_keywords[:20], *extra_terms])
            prepared_vectors.append((item, terms))
            metrics["processed"] += 1

            for key, label, kind, confidence in candidate_keys(item, tags, entities):
                group = groups.setdefault(
                    key,
                    {"label": label, "kind": kind, "items": [], "topic_counter": Counter(), "keywords": Counter(), "confidence": 0.0},
                )
                group["items"].append(str(item["id"]))
                if item["taxonomy_topic_id"]:
                    group["topic_counter"][str(item["taxonomy_topic_id"])] += 1
                for term in terms[:20]:
                    group["keywords"][term] += 1
                group["confidence"] += confidence

        metrics["timings"]["group_seconds"] = round(time.monotonic() - phase_start, 3)
        phase_start = time.monotonic()
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("PRAGMA data_version").fetchone()[0] != prepared_version:
            current_items = load_items_for_topics(conn, chosen_sources, limit, pending=pending, order=order)
            current_ids = [str(item["id"]) for item in current_items]
            current_fingerprint = topic_input_fingerprint(
                current_items, item_tags(conn, current_ids), item_entities(conn, current_ids))
            metrics["inputs_revalidated"] = True
            if current_fingerprint != prepared_fingerprint:
                metrics["retryable"] = True
                raise RuntimeError("KG topic inputs changed during preparation; retry this run")
        affected_topics = reset_semantic_lite_topics(conn, item_ids)
        ensure_no_stable_dynamic_topic(conn)
        assigned_item_ids: set[str] = set()
        for item, terms in prepared_vectors:
            upsert_item_vector(conn, item, terms)
            metrics["vectors"] += 1

        for key, group in groups.items():
            item_count = len(group["items"])
            if not should_keep_group(group, min_items):
                continue
            parent_topic_id = group["topic_counter"].most_common(1)[0][0] if group["topic_counter"] else None
            keywords = [term for term, _ in group["keywords"].most_common(20)]
            confidence = min((group["confidence"] / max(item_count, 1)) * min(1.0, 0.55 + item_count / 20), 0.96)
            topic_id = upsert_dynamic_topic(conn, key, group["label"], group["kind"], group["items"], parent_topic_id, keywords, confidence)
            affected_topics.add(topic_id)
            assigned_item_ids.update(group["items"])
            metrics["dynamic_topics"] += 1
            for item_id in group["items"]:
                relevance = round(confidence, 3)
                conn.execute(
                    """
                    INSERT OR REPLACE INTO item_topic_assignments
                      (item_id, topic_kind, topic_id, relevance, assigned_by, reason, run_id)
                    VALUES (?, 'dynamic', ?, ?, 'semantic-lite', ?, ?)
                    """,
                    (item_id, topic_id, relevance, f"co-occurrence group: {group['label']}", run_id),
                )
                upsert_edge(
                    conn,
                    "item",
                    item_id,
                    "dynamic_topic",
                    topic_id,
                    "item_belongs_dynamic_topic",
                    relevance,
                    "semantic-lite",
                    run_id,
                    {"item_id": item_id, "group_key": key, "label": group["label"]},
                )
                metrics["assignments"] += 1
                metrics["edges"] += 1

        # A selected item with no qualifying group has still been fully
        # evaluated. Record that terminal disposition so the next --pending
        # run does not select the same lite vector forever.
        terminal_ids = set(item_ids) - assigned_item_ids
        for item_id in terminal_ids:
            conn.execute(
                """
                INSERT OR REPLACE INTO item_topic_assignments
                  (item_id, topic_kind, topic_id, relevance, assigned_by, reason, run_id)
                VALUES (?, 'dynamic', ?, 0, 'semantic-lite-terminal',
                        'evaluated without a stable dynamic group', ?)
                """,
                (item_id, NO_STABLE_DYNAMIC_TOPIC_ID, run_id),
            )
            metrics["assignments"] += 1
        if terminal_ids:
            affected_topics.add(NO_STABLE_DYNAMIC_TOPIC_ID)

        refresh_topic_counts(conn, affected_topics)
        metrics["timings"]["write_seconds"] = round(time.monotonic() - phase_start, 3)
        metrics["seconds"] = round(time.time() - start, 3)
        metrics["items_per_sec"] = round(metrics["processed"] / max(time.time() - start, 0.001), 2)
        finish_run(conn, run_id, "completed", metrics)
        print(json.dumps({"phase": "done", **metrics}, ensure_ascii=False), flush=True)
        return metrics
    except Exception as exc:
        conn.rollback()
        metrics["seconds"] = round(time.time() - start, 3)
        finish_run(conn, run_id, "failed", metrics, str(exc))
        raise
