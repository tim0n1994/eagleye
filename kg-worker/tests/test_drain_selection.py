from __future__ import annotations

import contextlib
import inspect
import io
import sqlite3
import unittest
from pathlib import Path

from eagleye_kg.cli import build_parser
from eagleye_kg.pipeline import load_items
from eagleye_kg.topics import discover_topics, load_items_for_topics
from eagleye_kg.vectors import HASH_VECTOR_MODEL


class DrainSelectionTests(unittest.TestCase):
    """R3 EAGLEYE_R3_DRAINER — converging selection predicates for the 2h KG drainer.

    Stage-1 diagnosis: the topics stage cannot clear the 60,028-item
    dynamic-topic backlog by raising --limit alone, because
    load_items_for_topics calls fair_items with the default pending="1=1"
    (topics.py:146-153) and re-picks the top-score window every run, then
    reset+re-inserts semantic-lite assignments for the selected items only.
    The drainer needs:

      * a CONVERGING pending predicate for topics. The stage writes two
        outputs per selected item — the semantic-lite vector
        (upsert_item_vector runs unconditionally) and a dynamic-topic
        assignment (only for groups that pass should_keep_group) — and an
        item is done only when it has BOTH. R3.1 ruling C (Q5) moved the done
        marker here from "has the lite vector" alone, which starved the
        lite_but_no_dynamic caliber (15,216 items: vector written, group
        never reached min_items, never re-selected). Done items are never
        re-selected, so the pending set is monotone non-increasing modulo
        intake. The caliber-level contract (three populations, no
        regression of the first two) lives in
        test_topics_lite_but_no_dynamic.py; this file pins the drained ⇒
        excluded and all-drained ⇒ zero-work edges;
      * --order newest-first / oldest-first on the selection commands so the
        2h drain favors fresh intake (入库→出向量 p95 < 6h) while idle
        windows chew the old backlog oldest-first.

    Defaults must stay byte-identical (switch OFF = today's behavior):
    pending defaults to falsy and order defaults to None (score-ordered
    selection), pinned by the characteristic tests below.
    """

    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.text_factory = lambda value: value.decode("utf-8", errors="replace")
        self.conn.execute("PRAGMA foreign_keys=ON")
        root = Path(__file__).resolve().parents[2]
        for migration in ("001_initial_schema.sql", "006_kg_v2.sql", "030_kg_item_topic_lookup.sql"):
            self.conn.executescript((root / "server/migrations" / migration).read_text())
        # R3.0: 生产由新迁移提供 duplicate_of 列（与 test_dup_exclusion.py 同款 ALTER）。
        self.conn.execute("ALTER TABLE information_items ADD COLUMN duplicate_of TEXT")
        self.conn.execute("DELETE FROM sources")
        self.conn.execute(
            "INSERT INTO sources(id,slug,label,is_active) VALUES('x-following','x-following','x-following',1)"
        )
        # 6 items: score descends 96→91 while published_at ascends, so the
        # score-first and recency-first orderings are distinguishable.
        for index in range(6):
            self.conn.execute(
                """INSERT INTO information_items
                   (id,source_id,title,canonical_url,digest_date,score,published_at,source_payload)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (
                    f"xf-{index}",
                    "x-following",
                    "Drain fixture item",
                    f"https://example.com/xf-{index}",
                    "2026-10-20",
                    96 - index,
                    f"2026-10-{10 + index:02d}T00:00:00Z",
                    "{}",
                ),
            )
        self.conn.commit()
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()

    def tearDown(self) -> None:
        self.output.__exit__(None, None, None)
        self.conn.close()

    def _require_param(self, func, name: str, hint: str) -> None:
        if name not in inspect.signature(func).parameters:
            self.fail(f"{func.__name__} must accept `{name}` for the R3 drainer ({hint})")

    def _parse(self, *argv):
        try:
            return build_parser().parse_args(list(argv))
        except SystemExit:
            self.fail(f"eagleye-kg CLI must accept: {' '.join(argv)}")

    def _mark_lite_only(self, item_id: str) -> None:
        """Simulate a prior topics run that vectorized the item but whose group
        never reached min_items — the lite_but_no_dynamic caliber. NOT done."""
        self.conn.execute(
            """INSERT INTO item_vectors (item_id, vector_type, model_name, dimension, vector_json, content_hash)
               VALUES (?, 'semantic-lite', ?, 256, '[]', 'fixture')""",
            (item_id, HASH_VECTOR_MODEL),
        )
        self.conn.commit()

    def _mark_drained(self, item_id: str) -> None:
        """Simulate a prior topics run having processed the item to completion:
        lite vector AND dynamic-topic assignment (the R3.1 C done marker)."""
        self._mark_lite_only(item_id)
        self.conn.execute(
            """INSERT OR IGNORE INTO dynamic_topics
                 (id, slug, name, status, discovery_method, topic_model_version, item_count)
               VALUES ('kdt_fixture', 'fixture-topic', 'Fixture topic', 'active', 'semantic-lite',
                       'dynamic-topic-lite-0.1', 0)"""
        )
        self.conn.execute(
            """INSERT INTO item_topic_assignments (item_id, topic_kind, topic_id, relevance, assigned_by, reason)
               VALUES (?, 'dynamic', 'kdt_fixture', 0.8, 'semantic-lite', 'fixture')""",
            (item_id,),
        )
        self.conn.commit()

    def test_topics_pending_excludes_items_that_already_have_lite_vectors_and_dynamic_topics(self) -> None:
        self._require_param(load_items_for_topics, "pending", "converging drain selection")
        for index in range(2):  # the two highest-score items are fully drained (vector + dynamic topic)
            self._mark_drained(f"xf-{index}")
        # R3.1 C: a lite vector alone is NOT the done marker — xf-2 must stay pending.
        self._mark_lite_only("xf-2")
        rows = load_items_for_topics(self.conn, ["x-following"], 10, pending=True)
        self.assertEqual(sorted(row["id"] for row in rows), ["xf-2", "xf-3", "xf-4", "xf-5"])

    def test_characteristic_topics_default_selection_is_unchanged_without_pending(self) -> None:
        for index in range(3):
            self._mark_drained(f"xf-{index}")
        rows = load_items_for_topics(self.conn, ["x-following"], 10)
        # Default re-picks the whole top-score window including drained items.
        self.assertEqual([row["id"] for row in rows], [f"xf-{index}" for index in range(6)])

    def test_discover_topics_pending_converges_to_zero_work(self) -> None:
        self._require_param(discover_topics, "pending", "drain mode must skip already-vectorized items")
        for index in range(6):  # every item fully drained: vector + dynamic topic
            self._mark_drained(f"xf-{index}")
        metrics = discover_topics(self.conn, ["x-following"], 10, 5, pending=True)
        self.assertEqual(metrics["total"], 0)
        self.assertEqual(metrics["processed"], 0)
        self.assertEqual(metrics["vectors"], 0)

    def test_extract_order_prefers_recency_when_requested(self) -> None:
        self._require_param(load_items, "order", "newest-first / oldest-first drain ordering")
        # Default: score-first (byte-identical selection).
        self.assertEqual([row["id"] for row in load_items(self.conn, ["x-following"], 1)], ["xf-0"])
        # Drain orderings.
        self.assertEqual(
            [row["id"] for row in load_items(self.conn, ["x-following"], 1, order="newest-first")], ["xf-5"]
        )
        self.assertEqual(
            [row["id"] for row in load_items(self.conn, ["x-following"], 1, order="oldest-first")], ["xf-0"]
        )

    def test_cli_accepts_pending_and_order_flags(self) -> None:
        topics = self._parse("topics", "--limit", "1000", "--pending", "--order", "oldest-first")
        self.assertTrue(topics.pending)
        self.assertEqual(topics.order, "oldest-first")
        extract = self._parse("extract", "--order", "newest-first")
        self.assertEqual(extract.order, "newest-first")
        embed = self._parse("embed", "--order", "newest-first")
        self.assertEqual(embed.order, "newest-first")

    def test_characteristic_cli_defaults_keep_current_behavior(self) -> None:
        topics = self._parse("topics", "--limit", "1000")
        self.assertFalse(getattr(topics, "pending", False))
        self.assertIsNone(getattr(topics, "order", None))
        extract = self._parse("extract")
        self.assertIsNone(getattr(extract, "order", None))


if __name__ == "__main__":
    unittest.main()
