from __future__ import annotations

import argparse
import json

from .db import connect, table_count
from .pipeline import extract
from .topics import discover_topics
from .vectors import FASTEMBED_MODEL, embed_fastembed


def split_sources(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [part.strip() for part in value.split(",") if part.strip()]


def cmd_status(args: argparse.Namespace) -> int:
    conn = connect(args.db)
    tables = [
        "information_items",
        "ai_summaries",
        "topic_taxonomy",
        "item_features",
        "kg_tags",
        "item_tag_assignments",
        "entity_mentions",
        "canonical_entities",
        "dynamic_topics",
        "item_topic_assignments",
        "kg_edges",
    ]
    result = {table: table_count(conn, table) for table in tables}
    result["coverage_by_source"] = [
        dict(row)
        for row in conn.execute(
            """
            SELECT s.slug,
                   COUNT(i.id) AS items,
                   SUM(CASE WHEN f.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_features,
                   SUM(CASE WHEN ita.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_tags,
                   SUM(CASE WHEN top.item_id IS NOT NULL THEN 1 ELSE 0 END) AS with_topics
            FROM sources s
            LEFT JOIN information_items i ON i.source_id = s.id
            LEFT JOIN item_features f ON f.item_id = i.id
            LEFT JOIN (
              SELECT DISTINCT item_id FROM item_tag_assignments
            ) ita ON ita.item_id = i.id
            LEFT JOIN (
              SELECT DISTINCT item_id FROM item_topic_assignments
            ) top ON top.item_id = i.id
            GROUP BY s.slug
            ORDER BY CASE s.slug
              WHEN 'x-following' THEN 0
              WHEN 'hacker-news' THEN 1
              WHEN 'github-trending' THEN 2
              WHEN 'hugging-face' THEN 3
              WHEN 'product-hunt' THEN 4
              ELSE 99
            END, s.slug
            """
        )
    ]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_extract(args: argparse.Namespace) -> int:
    conn = connect(args.db)
    metrics = extract(conn, split_sources(args.sources), args.limit)
    print(json.dumps({"status": "ok", **metrics}, ensure_ascii=False, indent=2))
    return 0


def cmd_topics(args: argparse.Namespace) -> int:
    conn = connect(args.db)
    metrics = discover_topics(conn, split_sources(args.sources), args.limit, args.min_items)
    print(json.dumps({"status": "ok", **metrics}, ensure_ascii=False, indent=2))
    return 0


def cmd_embed(args: argparse.Namespace) -> int:
    conn = connect(args.db)
    metrics = embed_fastembed(
        conn,
        split_sources(args.sources),
        args.limit,
        args.batch_size,
        args.model,
        args.threads,
        args.parallel,
        args.force,
        args.max_chars,
        args.backend,
    )
    print(json.dumps({"status": "ok", **metrics}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="eagleye-kg")
    parser.add_argument("--db", default=None, help="Path to eagleye.db")
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", help="Show KG v2 status and coverage")
    status.set_defaults(func=cmd_status)

    extract_parser = sub.add_parser("extract", help="Run deterministic KG extraction")
    extract_parser.add_argument("--sources", default=None, help="Comma-separated source slugs")
    extract_parser.add_argument("--limit", type=int, default=100)
    extract_parser.set_defaults(func=cmd_extract)

    topics_parser = sub.add_parser("topics", help="Run semantic-lite vectorization and dynamic topic discovery")
    topics_parser.add_argument("--sources", default=None, help="Comma-separated source slugs")
    topics_parser.add_argument("--limit", type=int, default=5000)
    topics_parser.add_argument("--min-items", type=int, default=5)
    topics_parser.set_defaults(func=cmd_topics)

    embed_parser = sub.add_parser("embed", help="Generate dense item vectors")
    embed_parser.add_argument("--sources", default=None, help="Comma-separated source slugs")
    embed_parser.add_argument("--limit", type=int, default=100)
    embed_parser.add_argument("--batch-size", type=int, default=64)
    embed_parser.add_argument("--model", default=FASTEMBED_MODEL)
    embed_parser.add_argument(
        "--backend",
        choices=["auto", "fastembed", "hash"],
        default="auto",
        help="Embedding backend. auto tries FastEmbed and falls back to local hash vectors.",
    )
    embed_parser.add_argument("--threads", type=int, default=None)
    embed_parser.add_argument("--parallel", type=int, default=None)
    embed_parser.add_argument("--max-chars", type=int, default=1200)
    embed_parser.add_argument("--force", action="store_true", help="Recompute vectors even if content hash matches")
    embed_parser.set_defaults(func=cmd_embed)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
