from __future__ import annotations

import contextlib
import io
import sqlite3
import unittest
from pathlib import Path

from eagleye_kg.topics import discover_topics, load_items_for_topics
from eagleye_kg.vectors import HASH_VECTOR_MODEL


# R3.1 ruling C (Q5) — the three populations (三口径人口) measured on the
# 2026-10-20 production snapshot:
#
#   no_semantic_lite     44,891   no semantic-lite vector for the live hash model
#   no_dynamic           60,107   no dynamic-topic assignment at all
#   lite_but_no_dynamic  15,216   has the lite vector, has no dynamic topic
#
# 44,891 + 15,216 = 60,107: no_semantic_lite ⊂ no_dynamic, and the two pending
# groups are disjoint. The predicates below are the fixture's definition of each
# caliber; they use the same `i` alias as fair_items() (selection.py:49-56).
NO_SEMANTIC_LITE = """NOT EXISTS (SELECT 1 FROM item_vectors v WHERE v.item_id = i.id
    AND v.vector_type = 'semantic-lite' AND v.model_name = ?)"""
NO_DYNAMIC = """NOT EXISTS (SELECT 1 FROM item_topic_assignments a WHERE a.item_id = i.id
    AND a.topic_kind = 'dynamic')"""
LITE_BUT_NO_DYNAMIC = f"NOT ({NO_SEMANTIC_LITE}) AND {NO_DYNAMIC}"

STALE_LITE_MODEL = "eagleye-hash-v0"  # a retired model name: not the live HASH_VECTOR_MODEL
DRAIN_ORDERS = (None, "newest-first", "oldest-first")  # kg-drainer.js:52-54 lanes


class TopicsLiteButNoDynamicTests(unittest.TestCase):
    """R3.1 C — widen the topics pending predicate so lite_but_no_dynamic items drain.

    Starvation mechanism (as of b745270):

      * TOPICS_LITE_PENDING (topics.py:152-153) treats "has no semantic-lite
        vector for HASH_VECTOR_MODEL" as the done marker of the topics stage.
      * discover_topics() writes that vector for EVERY selected item
        (upsert_item_vector, topics.py:464-466) but only emits dynamic-topic
        assignments for groups that pass should_keep_group(min_items)
        (topics.py:468-471). An item whose candidate keys never reach
        min_items leaves the run with a lite vector and no dynamic topic.
      * From then on the pending predicate excludes it forever. This is the
        15,216-item lite_but_no_dynamic caliber: it is the only one of the
        three populations that the drainer can never select. Measured
        evidence: /tmp/eagleye-r3-meas/top1.out — processed 50, vectors 50,
        dynamic_topics 0, assignments 0; topB.out — 1000 processed, 989
        assignments → 11 items starved per 1000.
      * The production drainer only ever runs topics with pending=True
        (server/services/kg-drainer.js:168, min_items 5), so the starved
        group has no other path back into the stage.

    Contract asserted here:

      1. 第三组不再饿死 — under pending=True every lite_but_no_dynamic item is
         selectable, with or without a taxonomy assignment, in all three drain
         orderings, and the stage entry discover_topics(pending=True) counts
         them as work.
      2. 前两组行为不回退 — every no_semantic_lite item (no vector, or a vector
         only for a retired model) stays selected; no_dynamic coverage never
         drops below today's floor and becomes complete.
      3. Convergence guard — items that already have BOTH the lite vector and
         a dynamic topic are never re-selected under pending=True, and the
         default (pending=False) selection stays byte-identical.

    Existing pins that encode the OLD done marker and will need to move to
    the new one when ruling C lands: test_drain_selection.py:96-101
    (lite vector alone ⇒ excluded) and :110-117 (lite vectors alone ⇒ zero
    work). This file does not modify them.
    """

    # Group 1 — no_semantic_lite caliber: nothing in item_vectors for the live model.
    NO_LITE_IDS = ("nolite-xf-0", "nolite-xf-1", "nolite-hn-0")
    STALE_LITE_IDS = ("stalelite-xf-0",)  # lite vector only for STALE_LITE_MODEL
    NO_SEMANTIC_LITE_IDS = NO_LITE_IDS + STALE_LITE_IDS
    # Group 3 — lite_but_no_dynamic caliber: live-model lite vector, no dynamic topic.
    # The *-1 items also carry a taxonomy assignment (deterministic extract output):
    # "no dynamic" must not be confused with "no assignment of any kind".
    LITE_NO_DYNAMIC_IDS = ("litenodyn-xf-0", "litenodyn-xf-1", "litenodyn-hn-0", "litenodyn-hn-1")
    TAXONOMY_ONLY_IDS = ("litenodyn-xf-1", "litenodyn-hn-1")
    # Group 2 — no_dynamic caliber = group 1 ⊔ group 3 (the 44,891 + 15,216 = 60,107 identity).
    NO_DYNAMIC_IDS = NO_SEMANTIC_LITE_IDS + LITE_NO_DYNAMIC_IDS
    # Control — done: live-model lite vector AND a semantic-lite dynamic assignment.
    DONE_IDS = ("done-xf-0", "done-hn-0")
    ALL_IDS = NO_DYNAMIC_IDS + DONE_IDS

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
        for slug in ("x-following", "hacker-news"):
            self.conn.execute("INSERT INTO sources(id,slug,label,is_active) VALUES(?,?,?,1)", (slug, slug, slug))
        for index, item_id in enumerate(self.ALL_IDS):
            self._add_item(item_id, score=100 - index, day=1 + index)
        for item_id in self.STALE_LITE_IDS:
            self._add_lite_vector(item_id, STALE_LITE_MODEL)
        for item_id in self.LITE_NO_DYNAMIC_IDS + self.DONE_IDS:
            self._add_lite_vector(item_id, HASH_VECTOR_MODEL)
        for item_id in self.TAXONOMY_ONLY_IDS:
            self._add_assignment(item_id, "taxonomy", "kt001", "deterministic")
        self.conn.execute(
            """INSERT INTO dynamic_topics (id, slug, name, status, discovery_method, topic_model_version, item_count)
               VALUES ('kdt_fixture', 'fixture-topic', 'Fixture topic', 'active', 'semantic-lite',
                       'dynamic-topic-lite-0.1', ?)""",
            (len(self.DONE_IDS),),
        )
        for item_id in self.DONE_IDS:
            self._add_assignment(item_id, "dynamic", "kdt_fixture", "semantic-lite")
        self.conn.commit()
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()

    def tearDown(self) -> None:
        self.output.__exit__(None, None, None)
        self.conn.close()

    # -- fixture helpers -----------------------------------------------------

    def _add_item(self, item_id: str, score: int, day: int) -> None:
        source = "x-following" if "-xf-" in item_id else "hacker-news"
        self.conn.execute(
            """INSERT INTO information_items
               (id,source_id,title,canonical_url,digest_date,score,published_at,source_payload)
               VALUES(?,?,?,?,?,?,?,?)""",
            (item_id, source, f"Fixture {item_id}", f"https://example.com/{item_id}", "2026-10-20",
             score, f"2026-10-{day:02d}T00:00:00Z", "{}"),
        )

    def _add_lite_vector(self, item_id: str, model_name: str) -> None:
        self.conn.execute(
            """INSERT INTO item_vectors (item_id, vector_type, model_name, dimension, vector_json, content_hash)
               VALUES (?, 'semantic-lite', ?, 256, '[]', 'fixture')""",
            (item_id, model_name),
        )

    def _add_assignment(self, item_id: str, topic_kind: str, topic_id: str, assigned_by: str) -> None:
        self.conn.execute(
            """INSERT INTO item_topic_assignments (item_id, topic_kind, topic_id, relevance, assigned_by, reason)
               VALUES (?, ?, ?, 0.8, ?, 'fixture')""",
            (item_id, topic_kind, topic_id, assigned_by),
        )

    def _caliber(self, predicate: str, params: tuple = ()) -> set[str]:
        return {row[0] for row in self.conn.execute(
            f"SELECT i.id FROM information_items i WHERE {predicate}", params)}

    def _pending_ids(self, order: str | None = None) -> set[str]:
        # sources=None, generous limit: the drainer's call shape (kg-drainer.js:168)
        # minus the cap, so the predicate alone decides membership.
        return {row["id"] for row in load_items_for_topics(self.conn, None, 100, pending=True, order=order)}

    # -- fixture self-check ----------------------------------------------------

    def test_fixture_reproduces_the_three_r3_calibers(self) -> None:
        no_semantic_lite = self._caliber(NO_SEMANTIC_LITE, (HASH_VECTOR_MODEL,))
        lite_but_no_dynamic = self._caliber(LITE_BUT_NO_DYNAMIC, (HASH_VECTOR_MODEL,))
        no_dynamic = self._caliber(NO_DYNAMIC)
        self.assertEqual(no_semantic_lite, set(self.NO_SEMANTIC_LITE_IDS))
        self.assertEqual(lite_but_no_dynamic, set(self.LITE_NO_DYNAMIC_IDS))
        # 44,891 + 15,216 = 60,107 — disjoint union, nothing else in no_dynamic.
        self.assertEqual(no_semantic_lite & lite_but_no_dynamic, set())
        self.assertEqual(no_dynamic, no_semantic_lite | lite_but_no_dynamic)
        self.assertEqual(set(self.DONE_IDS) & no_dynamic, set())

    # -- 前两组行为不回退 ------------------------------------------------------------

    def test_pending_still_selects_every_no_semantic_lite_item(self) -> None:
        for order in DRAIN_ORDERS:
            with self.subTest(order=order):
                missing = set(self.NO_SEMANTIC_LITE_IDS) - self._pending_ids(order)
                self.assertEqual(
                    sorted(missing), [],
                    f"regression: no_semantic_lite items dropped from pending=True (order={order!r}); "
                    "today's predicate selects every item without a live-model lite vector",
                )

    def test_pending_covers_the_whole_no_dynamic_caliber(self) -> None:
        no_dynamic = self._caliber(NO_DYNAMIC)
        selected = self._pending_ids()
        covered = no_dynamic & selected
        # Floor: today's predicate already covers the no_semantic_lite part — never fewer.
        self.assertGreaterEqual(
            len(covered), len(self.NO_SEMANTIC_LITE_IDS),
            f"regression: no_dynamic coverage {len(covered)}/{len(no_dynamic)} fell below today's "
            f"{len(self.NO_SEMANTIC_LITE_IDS)} (the no_semantic_lite subset)",
        )
        # Target: the whole no_dynamic caliber is selectable, not just its no_semantic_lite subset.
        self.assertEqual(
            sorted(no_dynamic - selected), [],
            f"no_dynamic coverage {len(covered)}/{len(no_dynamic)}: these items have no dynamic topic "
            "yet pending=True never selects them (they are the lite_but_no_dynamic caliber)",
        )

    # -- 第三组不再饿死 ----------------------------------------------------------------

    def test_pending_selects_lite_but_no_dynamic_items_instead_of_starving_them(self) -> None:
        for order in DRAIN_ORDERS:
            with self.subTest(order=order):
                missing = set(self.LITE_NO_DYNAMIC_IDS) - self._pending_ids(order)
                self.assertEqual(
                    sorted(missing), [],
                    f"lite_but_no_dynamic items starved under pending=True (order={order!r}): "
                    "TOPICS_LITE_PENDING (topics.py:152) uses the lite vector as the done marker, so an "
                    "item that got its vector but no dynamic topic is never re-selected",
                )

    def test_pending_selects_lite_but_no_dynamic_items_that_carry_a_taxonomy_assignment(self) -> None:
        # "no dynamic" ≠ "no assignment at all": deterministic taxonomy rows must not mask the gap.
        missing = set(self.TAXONOMY_ONLY_IDS) - self._pending_ids()
        self.assertEqual(
            sorted(missing), [],
            "lite_but_no_dynamic items with a taxonomy assignment (and no dynamic topic) are not selected "
            "under pending=True",
        )

    def test_discover_topics_pending_processes_lite_but_no_dynamic_items(self) -> None:
        # Stage entry used by `eagleye-kg topics --pending` (cli.py:75-80) and the
        # drainer (kg-drainer.js:168): the selected work must be the whole no_dynamic caliber.
        expected = self._caliber(NO_DYNAMIC)
        metrics = discover_topics(self.conn, None, 100, 5, pending=True)
        self.assertEqual(
            metrics["total"], len(expected),
            f"discover_topics(pending=True) selected {metrics['total']} items but the no_dynamic caliber "
            f"holds {len(expected)}: the {len(self.LITE_NO_DYNAMIC_IDS)} lite_but_no_dynamic items were "
            "excluded from the drain",
        )
        self.assertEqual(metrics["processed"], len(expected))
        self.assertEqual(metrics["vectors"], len(expected))

    def test_pending_run_converges_after_terminal_no_topic_dispositions(self) -> None:
        expected = len(self._caliber(NO_DYNAMIC))
        first = discover_topics(self.conn, None, 100, 5, pending=True)
        self.assertEqual(first["total"], expected)
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM item_topic_assignments WHERE topic_id = 'kdt_no_stable_dynamic_topic'"
            ).fetchone()[0],
            len(self.NO_DYNAMIC_IDS),
        )
        second = discover_topics(self.conn, None, 100, 5, pending=True)
        self.assertEqual(second["total"], 0)
        self.assertEqual(second["processed"], 0)

    # -- convergence guard ---------------------------------------------------------------

    def test_pending_never_reselects_items_that_have_both_lite_and_dynamic(self) -> None:
        for order in DRAIN_ORDERS:
            with self.subTest(order=order):
                reselected = set(self.DONE_IDS) & self._pending_ids(order)
                self.assertEqual(
                    sorted(reselected), [],
                    f"items with a live-model lite vector AND a dynamic topic were re-selected "
                    f"(order={order!r}); the widened predicate must still converge",
                )

    def test_pending_keeps_selecting_no_lite_items_that_already_have_a_dynamic_topic(self) -> None:
        # Monotonicity: today's predicate selects any item lacking the live-model lite
        # vector, dynamic topic or not. Widening must not drop that case.
        self._add_item("odd-xf-0", score=1, day=28)
        self._add_assignment("odd-xf-0", "dynamic", "kdt_fixture", "semantic-lite")
        self.conn.commit()
        self.assertIn(
            "odd-xf-0", self._pending_ids(),
            "regression: an item with a dynamic topic but no live-model lite vector is selected today "
            "and must stay selected",
        )

    def test_default_selection_without_pending_is_unchanged(self) -> None:
        # Switch OFF = today's behavior: without pending the stage re-picks the whole
        # score window, drained items included (test_drain_selection.py:103-108).
        rows = load_items_for_topics(self.conn, None, 100)
        self.assertEqual({row["id"] for row in rows}, set(self.ALL_IDS))


if __name__ == "__main__":
    unittest.main()
