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


# R3 drainer (EAGLEYE_R3_DRAINER) — drain orderings for the 2h convergence
# drainer. None keeps the byte-identical score-first selection the nightly
# pipeline uses; the explicit orderings only arrive via --order from the
# drainer lane (newest-first keeps 入库→出向量 p95 low, oldest-first chews
# the old backlog in idle windows). Whitelisted constants — never spliced
# from raw CLI input.
DRAIN_ORDERINGS = {
    None: "i.score DESC, COALESCE(i.published_at, i.created_at) DESC, i.id",
    "newest-first": "COALESCE(i.published_at, i.created_at) DESC, i.score DESC, i.id",
    "oldest-first": "COALESCE(i.published_at, i.created_at) ASC, i.score DESC, i.id",
}


# R3.0 跨天重复治理: 所有积压选取 lane 的基础 WHERE 一律排除软标记 dup 行
# （information_items.duplicate_of IS NOT NULL, 回填后指向组内首行 id）。
# 放在基础 WHERE 而非各 pending 字符串: features/vectors/topics 三条 lane 与
# 三种 drain 排序共用同一排除语义, 且与 done-marker 收敛正交（积压只缩不胀）。
# 列由 R3.0 迁移提供（既有测试 fixture 以 ALTER 同步, 见 test_dup_exclusion.py）。
def fair_items(conn: sqlite3.Connection, sources: list[str], limit: int,
               join: str = "", pending: str = "1=1", params: tuple = (),
               completed: str = "0", extra_columns: str = "",
               order: str | None = None) -> list[sqlite3.Row]:
    if order not in DRAIN_ORDERINGS:
        raise ValueError(f"unsupported drain order: {order!r}")
    if not sources or limit <= 0:
        return []
    placeholders = ",".join("?" for _ in sources)
    return conn.execute(f"""
        WITH candidates AS (
          SELECT i.id, s.slug AS source_slug,
                 {completed} AS completed_count,
                 ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY {DRAIN_ORDERINGS[order]}) AS source_rank
          FROM information_items i JOIN sources s ON s.id = i.source_id
          {join}
          WHERE i.duplicate_of IS NULL
            AND s.slug IN ({placeholders}) AND ({pending})
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
