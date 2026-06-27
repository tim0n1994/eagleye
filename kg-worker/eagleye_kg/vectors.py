from __future__ import annotations

import json
import hashlib
import math
import re
import sqlite3
import time

from .config import EXTRACTOR_VERSION, PRIORITY_SOURCES
from .pipeline import create_run, finish_run, load_items
from .text import content_hash, tokenize


HASH_VECTOR_DIM = 256
HASH_VECTOR_MODEL = "eagleye-hash-v1"
FASTEMBED_MODEL = "BAAI/bge-small-en-v1.5"
FASTEMBED_VECTOR_TYPE = "semantic-fastembed"
HASH_EMBED_VECTOR_TYPE = "semantic-hash"


def feature_terms(text: str, extra_terms: list[str] | None = None) -> list[str]:
    terms = [term.lower() for term in tokenize(text, limit=80)]
    for term in extra_terms or []:
        clean = str(term or "").lower().strip()
        if clean:
            terms.append(clean[:80])
    return terms


def hash_vector(terms: list[str], dimension: int = HASH_VECTOR_DIM) -> list[float]:
    values = [0.0] * dimension
    for term in terms:
        if not term:
            continue
        digest = hashlib.blake2b(term.encode("utf-8", errors="ignore"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "big") % dimension
        sign = 1.0 if digest[4] & 1 else -1.0
        weight = 1.35 if re.search(r"[\u4e00-\u9fff]", term) else 1.0
        values[bucket] += sign * weight
    norm = math.sqrt(sum(value * value for value in values))
    if norm <= 0:
        return values
    return [round(value / norm, 6) for value in values]


def item_embedding_text(item: sqlite3.Row, max_chars: int = 1200) -> str:
    parts = [
        f"source: {item['source_slug']}",
        item["title"] or "",
        item["original_summary"] or "",
        item["content_text"] or "",
        item["canonical_url"] or "",
    ]
    text = "\n".join(part for part in parts if part).strip()
    return text[:max_chars]


def upsert_dense_vector(
    conn: sqlite3.Connection,
    item_id: str,
    vector_type: str,
    model_name: str,
    vector: list[float],
    content_hash_value: str,
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO item_vectors
          (item_id, vector_type, model_name, dimension, vector_json, content_hash)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            item_id,
            vector_type,
            model_name,
            len(vector),
            json.dumps([round(float(value), 6) for value in vector], separators=(",", ":")),
            content_hash_value,
        ),
    )


def embed_hash(
    conn: sqlite3.Connection,
    sources: list[str] | None = None,
    limit: int = 100,
    batch_size: int = 64,
    force: bool = False,
    max_chars: int = 1200,
    fallback_reason: str | None = None,
) -> dict:
    chosen_sources = sources or PRIORITY_SOURCES
    run_id = create_run(
        conn,
        "embedding",
        ",".join(chosen_sources),
        {
            "sources": chosen_sources,
            "limit": limit,
            "batch_size": batch_size,
            "backend": "hash",
            "model": HASH_VECTOR_MODEL,
            "force": force,
            "max_chars": max_chars,
            "fallback_reason": fallback_reason,
        },
    )
    start = time.time()
    metrics = {
        "run_id": run_id,
        "processed": 0,
        "vectors": 0,
        "skipped": 0,
        "total": 0,
        "backend": "hash",
        "model": HASH_VECTOR_MODEL,
        "vector_type": HASH_EMBED_VECTOR_TYPE,
    }
    if fallback_reason:
        metrics["fallback_reason"] = fallback_reason[:500]

    try:
        items = load_items(conn, chosen_sources, limit)
        metrics["total"] = len(items)
        for index in range(0, len(items), batch_size):
            batch = items[index : index + batch_size]
            for item in batch:
                text = item_embedding_text(item, max_chars=max_chars)
                chash = content_hash(
                    item["title"],
                    item["original_summary"],
                    item["content_text"],
                    item["canonical_url"],
                    HASH_VECTOR_MODEL,
                    str(max_chars),
                )
                if not force:
                    existing = conn.execute(
                        """
                        SELECT 1
                        FROM item_vectors
                        WHERE item_id = ? AND vector_type = ? AND model_name = ? AND content_hash = ?
                        """,
                        (item["id"], HASH_EMBED_VECTOR_TYPE, HASH_VECTOR_MODEL, chash),
                    ).fetchone()
                    if existing:
                        metrics["processed"] += 1
                        metrics["skipped"] += 1
                        continue
                upsert_dense_vector(
                    conn,
                    str(item["id"]),
                    HASH_EMBED_VECTOR_TYPE,
                    HASH_VECTOR_MODEL,
                    hash_vector(feature_terms(text)),
                    chash,
                )
                metrics["processed"] += 1
                metrics["vectors"] += 1
            conn.commit()
            print(
                json.dumps(
                    {
                        "phase": "embed",
                        **metrics,
                        "items_per_sec": round(metrics["processed"] / max(time.time() - start, 0.001), 2),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

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


def embed_fastembed(
    conn: sqlite3.Connection,
    sources: list[str] | None = None,
    limit: int = 100,
    batch_size: int = 64,
    model_name: str = FASTEMBED_MODEL,
    threads: int | None = None,
    parallel: int | None = None,
    force: bool = False,
    max_chars: int = 1200,
    backend: str = "auto",
) -> dict:
    if backend == "hash":
        return embed_hash(conn, sources, limit, batch_size, force, max_chars)

    try:
        from fastembed import TextEmbedding
    except Exception as exc:
        if backend == "auto":
            return embed_hash(conn, sources, limit, batch_size, force, max_chars, f"fastembed import failed: {exc}")
        raise RuntimeError("fastembed is not installed; run `uv sync --project kg-worker` first") from exc

    chosen_sources = sources or PRIORITY_SOURCES
    run_id = create_run(
        conn,
        "embedding",
        ",".join(chosen_sources),
        {
            "sources": chosen_sources,
            "limit": limit,
            "batch_size": batch_size,
            "model": model_name,
            "threads": threads,
            "parallel": parallel,
            "force": force,
            "max_chars": max_chars,
            "backend": backend,
        },
    )
    start = time.time()
    metrics = {"run_id": run_id, "processed": 0, "vectors": 0, "skipped": 0, "total": 0, "model": model_name}
    try:
        items = load_items(conn, chosen_sources, limit)
        metrics["total"] = len(items)
        try:
            model = TextEmbedding(model_name=model_name, threads=threads)
        except Exception as exc:
            if backend == "auto":
                finish_run(conn, run_id, "failed", metrics, str(exc))
                print(
                    json.dumps(
                        {
                            "phase": "embed_fallback",
                            "from_backend": "fastembed",
                            "to_backend": "hash",
                            "reason": str(exc)[:500],
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                return embed_hash(conn, sources, limit, batch_size, force, max_chars, str(exc))
            raise

        for index in range(0, len(items), batch_size):
            batch = items[index : index + batch_size]
            to_embed: list[tuple[sqlite3.Row, str, str]] = []
            for item in batch:
                chash = content_hash(
                    item["title"],
                    item["original_summary"],
                    item["content_text"],
                    item["canonical_url"],
                    model_name,
                    str(max_chars),
                )
                if not force:
                    existing = conn.execute(
                        """
                        SELECT 1
                        FROM item_vectors
                        WHERE item_id = ? AND vector_type = ? AND model_name = ? AND content_hash = ?
                        """,
                        (item["id"], FASTEMBED_VECTOR_TYPE, model_name, chash),
                    ).fetchone()
                    if existing:
                        metrics["processed"] += 1
                        metrics["skipped"] += 1
                        continue
                to_embed.append((item, item_embedding_text(item, max_chars=max_chars), chash))

            try:
                vectors = list(model.embed([text for _, text, _ in to_embed], batch_size=batch_size, parallel=parallel)) if to_embed else []
            except Exception as exc:
                if backend == "auto":
                    finish_run(conn, run_id, "failed", metrics, str(exc))
                    print(
                        json.dumps(
                            {
                                "phase": "embed_fallback",
                                "from_backend": "fastembed",
                                "to_backend": "hash",
                                "reason": str(exc)[:500],
                            },
                            ensure_ascii=False,
                        ),
                        flush=True,
                    )
                    return embed_hash(conn, sources, limit, batch_size, force, max_chars, str(exc))
                raise
            for (item, _, chash), vector in zip(to_embed, vectors):
                upsert_dense_vector(
                    conn,
                    str(item["id"]),
                    FASTEMBED_VECTOR_TYPE,
                    model_name,
                    [float(value) for value in vector],
                    chash,
                )
                metrics["processed"] += 1
                metrics["vectors"] += 1
            conn.commit()
            print(
                json.dumps(
                    {
                        "phase": "embed",
                        **metrics,
                        "items_per_sec": round(metrics["processed"] / max(time.time() - start, 0.001), 2),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

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
