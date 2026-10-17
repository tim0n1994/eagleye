from __future__ import annotations

import json
import sqlite3
import time
from collections import Counter
from .config import EXTRACTOR_VERSION
from .features import extract_item, load_taxonomy
from .text import stable_id
from .selection import fair_items, resolve_sources, FEATURE_INPUTS, hash_inputs


def source_clause(sources: list[str] | None) -> tuple[str, list[str]]:
    if not sources:
        return "", []
    placeholders = ",".join("?" for _ in sources)
    return f"AND s.slug IN ({placeholders})", sources


def create_run(conn: sqlite3.Connection, scope: str, scope_value: str, params: dict) -> str:
    run_id = "kgr_" + stable_id(scope, scope_value, str(time.time()))[:24]
    conn.execute(
        """
        INSERT INTO kg_extraction_runs
          (id, scope, scope_value, status, extractor_version, params, started_at)
        VALUES (?, ?, ?, 'running', ?, ?, datetime('now'))
        """,
        (run_id, scope, scope_value, EXTRACTOR_VERSION, json.dumps(params, ensure_ascii=False)),
    )
    conn.commit()
    return run_id


def finish_run(conn: sqlite3.Connection, run_id: str, status: str, metrics: dict, error: str | None = None) -> None:
    conn.execute(
        """
        UPDATE kg_extraction_runs
        SET status = ?, metrics = ?, error = ?, completed_at = datetime('now')
        WHERE id = ?
        """,
        (status, json.dumps(metrics, ensure_ascii=False), error, run_id),
    )
    conn.commit()


def load_items(conn: sqlite3.Connection, sources: list[str] | None, limit: int) -> list[sqlite3.Row]:
    conn.create_function("kg_feature_hash", len(FEATURE_INPUTS),
                         lambda *parts: hash_inputs(*parts, EXTRACTOR_VERSION), deterministic=True)
    completed_by_source = dict(conn.execute("SELECT source_slug, COUNT(*) FROM item_features GROUP BY source_slug"))
    conn.create_function("kg_features_done", 1, lambda slug: completed_by_source.get(slug, 0), deterministic=True)
    fields = ",".join("s.slug" if key == "source_slug" else "i.score" if key == "score"
                      else f"CAST(i.{key} AS BLOB)" for key in FEATURE_INPUTS)
    return fair_items(conn, resolve_sources(conn, sources), limit,
                      join="LEFT JOIN item_features f ON f.item_id = i.id",
                      pending=f"f.item_id IS NULL OR f.content_hash IS NOT kg_feature_hash({fields})",
                      completed="kg_features_done(s.slug)")


def extract(conn: sqlite3.Connection, sources: list[str] | None = None, limit: int = 100) -> dict:
    chosen_sources = resolve_sources(conn, sources)
    run_id = create_run(conn, "source", ",".join(chosen_sources), {"sources": chosen_sources, "limit": limit})
    start = time.time()
    metrics = {"run_id": run_id, "processed": 0, "tags": 0, "topics": 0, "entities": 0, "edges": 0, "total": 0}
    try:
        taxonomy = load_taxonomy(conn)
        items = load_items(conn, chosen_sources, limit)
        metrics["total"] = len(items)
        metrics["selection"] = "source-balanced-pending"
        metrics["by_source"] = dict(Counter(item["source_slug"] for item in items))
        for item in items:
            result = extract_item(conn, item, taxonomy, run_id)
            metrics["processed"] += 1
            metrics["tags"] += result["tags"]
            metrics["topics"] += result["topic"]
            metrics["entities"] += result["entities"]
            metrics["edges"] += result["edges"]
            if metrics["processed"] % 100 == 0:
                conn.commit()
                emit({"phase": "extract", **metrics, "items_per_sec": round(metrics["processed"] / max(time.time() - start, 0.001), 2)})
        conn.commit()
        metrics["seconds"] = round(time.time() - start, 3)
        metrics["items_per_sec"] = round(metrics["processed"] / max(time.time() - start, 0.001), 2)
        finish_run(conn, run_id, "completed", metrics)
        emit({"phase": "done", **metrics})
        return metrics
    except Exception as exc:
        conn.rollback()
        metrics["seconds"] = round(time.time() - start, 3)
        finish_run(conn, run_id, "failed", metrics, str(exc))
        raise


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)
