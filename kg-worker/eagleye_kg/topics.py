from __future__ import annotations

import json
import sqlite3
import time
from collections import Counter, defaultdict

from .config import EXTRACTOR_VERSION, PRIORITY_SOURCES
from .features import upsert_edge
from .pipeline import create_run, finish_run, source_clause
from .text import content_hash, slugify, stable_id
from .vectors import HASH_VECTOR_DIM, HASH_VECTOR_MODEL, feature_terms, hash_vector


DYNAMIC_TOPIC_VERSION = "dynamic-topic-lite-0.1"
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


def load_items_for_topics(conn: sqlite3.Connection, sources: list[str] | None, limit: int) -> list[sqlite3.Row]:
    clause, params = source_clause(sources)
    return conn.execute(
        f"""
        SELECT i.id, i.title, i.original_summary, i.content_text, i.canonical_url,
               i.source_payload, i.normalized_payload, i.score,
               s.slug AS source_slug,
               f.keyword_candidates,
               f.source_features,
               tax.topic_id AS taxonomy_topic_id
        FROM information_items i
        JOIN sources s ON s.id = i.source_id
        LEFT JOIN item_features f ON f.item_id = i.id
        LEFT JOIN (
          SELECT item_id, topic_id
          FROM item_topic_assignments
          WHERE topic_kind = 'taxonomy' AND assigned_by = 'deterministic'
        ) tax ON tax.item_id = i.id
        WHERE 1 = 1
          {clause}
        ORDER BY CASE s.slug
          WHEN 'x-following' THEN 0
          WHEN 'hacker-news' THEN 1
          WHEN 'github-trending' THEN 2
          WHEN 'hugging-face' THEN 3
          WHEN 'product-hunt' THEN 4
          ELSE 99
        END,
        i.score DESC,
        COALESCE(i.published_at, i.created_at) DESC
        LIMIT ?
        """,
        [*params, limit],
    ).fetchall()


def item_tags(conn: sqlite3.Connection, item_ids: list[str]) -> dict[str, list[sqlite3.Row]]:
    if not item_ids:
        return {}
    placeholders = ",".join("?" for _ in item_ids)
    rows = conn.execute(
        f"""
        SELECT a.item_id, t.label, t.type, a.confidence
        FROM item_tag_assignments a
        JOIN kg_tags t ON t.id = a.tag_id
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


def reset_semantic_lite_topics(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        DELETE FROM item_topic_assignments
        WHERE topic_kind = 'dynamic' AND assigned_by = 'semantic-lite'
        """
    )
    conn.execute(
        """
        DELETE FROM kg_edges
        WHERE edge_type = 'item_belongs_dynamic_topic' AND extractor = 'semantic-lite'
        """
    )
    conn.execute(
        """
        DELETE FROM dynamic_topics
        WHERE discovery_method = 'semantic-lite'
        """
    )
    conn.commit()


def discover_topics(conn: sqlite3.Connection, sources: list[str] | None = None, limit: int = 5000, min_items: int = 5) -> dict:
    chosen_sources = sources or PRIORITY_SOURCES
    run_id = create_run(
        conn,
        "dynamic-topic",
        ",".join(chosen_sources),
        {"sources": chosen_sources, "limit": limit, "min_items": min_items, "model": HASH_VECTOR_MODEL},
    )
    start = time.time()
    metrics = {"run_id": run_id, "processed": 0, "vectors": 0, "dynamic_topics": 0, "assignments": 0, "edges": 0, "total": 0}
    try:
        reset_semantic_lite_topics(conn)
        items = load_items_for_topics(conn, chosen_sources, limit)
        item_ids = [str(item["id"]) for item in items]
        tags_by_item = item_tags(conn, item_ids)
        entities_by_item = item_entities(conn, item_ids)
        groups: dict[str, dict] = {}
        metrics["total"] = len(items)

        for item in items:
            tags = tags_by_item.get(item["id"], [])
            entities = entities_by_item.get(item["id"], [])
            try:
                parsed_keywords = json.loads(item["keyword_candidates"] or "[]")
            except Exception:
                parsed_keywords = []
            extra_terms = [str(row["label"]) for row in tags[:12]] + [str(row["canonical_name"]) for row in entities[:8]]
            terms = feature_terms("\n".join([item["title"] or "", item["original_summary"] or "", item["content_text"] or ""]), [*parsed_keywords[:20], *extra_terms])
            upsert_item_vector(conn, item, terms)
            metrics["vectors"] += 1
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

            if metrics["processed"] % 250 == 0:
                conn.commit()

        for key, group in groups.items():
            item_count = len(group["items"])
            if not should_keep_group(group, min_items):
                continue
            parent_topic_id = group["topic_counter"].most_common(1)[0][0] if group["topic_counter"] else None
            keywords = [term for term, _ in group["keywords"].most_common(20)]
            confidence = min((group["confidence"] / max(item_count, 1)) * min(1.0, 0.55 + item_count / 20), 0.96)
            topic_id = upsert_dynamic_topic(conn, key, group["label"], group["kind"], group["items"], parent_topic_id, keywords, confidence)
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

        conn.commit()
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
