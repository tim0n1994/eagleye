from __future__ import annotations

import sqlite3

from .config import EXTRACTOR_VERSION
from .text import content_hash


FEATURE_INPUTS = ("title", "original_summary", "content_text", "canonical_url",
                  "author", "language", "source_payload", "normalized_payload", "score", "source_slug")


def hash_inputs(*parts: object) -> str:
    return content_hash(*(part.decode("utf-8", errors="replace") if isinstance(part, bytes) else part for part in parts))


def feature_hash(item: sqlite3.Row) -> str:
    return hash_inputs(*(item[key] for key in FEATURE_INPUTS), EXTRACTOR_VERSION)


def resolve_sources(conn: sqlite3.Connection, sources: list[str] | None) -> list[str]:
    if sources is not None:
        return list(dict.fromkeys(sources))
    return [row[0] for row in conn.execute("SELECT slug FROM sources WHERE is_active = 1 ORDER BY slug")]


def fair_items(conn: sqlite3.Connection, sources: list[str], limit: int,
               join: str = "", pending: str = "1=1", params: tuple = (),
               completed: str = "0", extra_columns: str = "") -> list[sqlite3.Row]:
    if not sources or limit <= 0:
        return []
    placeholders = ",".join("?" for _ in sources)
    return conn.execute(f"""
        WITH candidates AS (
          SELECT i.id, s.slug AS source_slug,
                 {completed} AS completed_count,
                 ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY
                   i.score DESC, COALESCE(i.published_at, i.created_at) DESC, i.id) AS source_rank
          FROM information_items i JOIN sources s ON s.id = i.source_id
          {join}
          WHERE s.slug IN ({placeholders}) AND ({pending})
        ), selected AS MATERIALIZED (
          SELECT id, ROW_NUMBER() OVER (ORDER BY source_rank, completed_count,
            CASE source_slug WHEN 'x-following' THEN 0 WHEN 'hacker-news' THEN 1
              WHEN 'github-trending' THEN 2 WHEN 'hugging-face' THEN 3
              WHEN 'product-hunt' THEN 4 ELSE 99 END, source_slug) AS selection_order
          FROM candidates ORDER BY selection_order LIMIT ?
        )
        SELECT i.*, s.slug AS source_slug, s.label AS source_label {extra_columns}
        FROM selected chosen JOIN information_items i ON i.id = chosen.id
        JOIN sources s ON s.id = i.source_id {join}
        ORDER BY chosen.selection_order
    """, (*sources, *params, limit)).fetchall()
