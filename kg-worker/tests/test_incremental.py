from __future__ import annotations

import contextlib
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from eagleye_kg.pipeline import extract, load_items
from eagleye_kg.selection import resolve_sources
from eagleye_kg.topics import discover_topics, load_items_for_topics, item_tags
from eagleye_kg.vectors import embed_hash, load_vector_items, HASH_VECTOR_MODEL, HASH_EMBED_VECTOR_TYPE


class IncrementalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.text_factory = lambda value: value.decode("utf-8", errors="replace")
        self.conn.execute("PRAGMA foreign_keys=ON")
        root = Path(__file__).resolve().parents[2]
        for migration in ("001_initial_schema.sql", "006_kg_v2.sql", "030_kg_item_topic_lookup.sql"):
            self.conn.executescript((root / "server/migrations" / migration).read_text())
        self.conn.execute("DELETE FROM sources")
        self.sources = ["x-following", "hacker-news", "reddit"]
        for slug in self.sources + ["inactive"]:
            self.conn.execute("INSERT INTO sources(id,slug,label,is_active) VALUES(?,?,?,?)",
                              (slug, slug, slug, int(slug != "inactive")))
            for index in range(20 if slug == "x-following" else 2):
                item_id = f"{slug}-{index}"
                self.conn.execute("""INSERT INTO information_items
                    (id,source_id,title,canonical_url,digest_date,score,source_payload)
                    VALUES(?,?,?,?,?,?,?)""", (item_id, slug, "OpenAI robotics release",
                    f"https://example.com/{item_id}", "2026-09-08", 100 - index, '{}'))
        self.conn.commit()
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()

    def tearDown(self) -> None:
        self.output.__exit__(None, None, None)
        self.conn.close()

    def test_extract_fair_progress_with_single_item_budget(self) -> None:
        for _ in range(3):
            self.assertEqual(extract(self.conn, limit=1)["processed"], 1)
        self.assertEqual({r[0] for r in self.conn.execute("SELECT source_slug FROM item_features")}, set(self.sources))
        first = {r[0] for r in self.conn.execute("SELECT item_id FROM item_features")}
        self.assertFalse(first.intersection(row["id"] for row in load_items(self.conn, None, 3)))
        extract(self.conn, limit=100)
        self.assertEqual(extract(self.conn, limit=100)["processed"], 0)
        self.assertEqual(resolve_sources(self.conn, []), [])
        self.assertEqual(load_items(self.conn, [], 100), [])

    def test_extract_reprocesses_content_payload_and_old_version_hash(self) -> None:
        extract(self.conn, limit=100)
        for field, value in (("title", "A changed research paper"), ("source_payload", '{"handle":"new_handle"}')):
            self.conn.execute(f"UPDATE information_items SET {field} = ? WHERE id = ?", (value, "x-following-0"))
            self.conn.commit()
            self.assertEqual([r["id"] for r in load_items(self.conn, None, 2)], ["x-following-0"])
            self.assertEqual(extract(self.conn, limit=2)["processed"], 1)
        self.conn.execute("UPDATE item_features SET content_hash = 'old-version' WHERE item_id = 'reddit-0'")
        self.conn.commit()
        self.assertEqual([r["id"] for r in load_items(self.conn, None, 2)], ["reddit-0"])
        self.conn.execute("UPDATE item_features SET content_hash = NULL WHERE item_id = 'reddit-1'")
        self.assertEqual({r["id"] for r in load_items(self.conn, None, 2)}, {"reddit-0", "reddit-1"})

    def test_embedding_budget_counts_target_model_gaps(self) -> None:
        for _ in range(3):
            self.assertEqual(embed_hash(self.conn, limit=1)["vectors"], 1)
        sources = {r[0] for r in self.conn.execute("SELECT DISTINCT i.source_id FROM item_vectors v JOIN information_items i ON i.id=v.item_id")}
        self.assertEqual(sources, set(self.sources))
        embed_hash(self.conn, limit=100)
        self.assertEqual(embed_hash(self.conn, limit=3)["total"], 0)
        self.assertEqual(len(load_vector_items(self.conn, self.sources, 3, "another-model", "another-type", 1200, False)), 3)
        self.conn.execute("UPDATE information_items SET content_text = 'changed' WHERE id = 'reddit-0'")
        self.conn.commit()
        self.assertEqual(embed_hash(self.conn, limit=1)["vectors"], 1)
        self.assertEqual(embed_hash(self.conn, limit=3)["total"], 0)
        self.assertEqual(len(load_vector_items(self.conn, self.sources, 3, HASH_VECTOR_MODEL, HASH_EMBED_VECTOR_TYPE, 600, False)), 3)

    def test_invalid_utf8_existing_content_can_be_selected_and_skipped(self) -> None:
        self.conn.execute("UPDATE information_items SET content_text = CAST(X'666fff' AS TEXT) WHERE id = 'reddit-0'")
        self.conn.commit()
        extract(self.conn, limit=100)
        embed_hash(self.conn, limit=100)
        self.assertEqual(load_items(self.conn, None, 100), [])
        self.assertEqual(embed_hash(self.conn, limit=100)["total"], 0)

    def topic_candidates(self, item: sqlite3.Row, *_args: object) -> list:
        return [("shared", "OpenAI", "company", 0.9),
                (item["source_slug"], "Robotics", "technology", 0.8)]

    def build_topics(self, sources: list[str] | None = None, limit: int = 100) -> dict:
        with patch("eagleye_kg.topics.candidate_keys", side_effect=self.topic_candidates), patch("eagleye_kg.topics.should_keep_group", return_value=True):
            return discover_topics(self.conn, sources=sources, limit=limit, min_items=1)

    def graph_snapshot(self) -> dict:
        return {table: [tuple(row) for row in self.conn.execute(f"SELECT * FROM {table} ORDER BY 1,2,3")]
                for table in ("dynamic_topics", "item_topic_assignments", "kg_edges", "item_vectors")}

    def test_topic_sample_covers_all_sources(self) -> None:
        self.assertEqual({row["source_slug"] for row in load_items_for_topics(self.conn, None, 3)}, set(self.sources))
        result = self.build_topics(limit=3)
        self.assertEqual(result["replacement_scope"], "selected-items-only")
        self.assertEqual(result["by_source"], dict.fromkeys(self.sources, 1))

    def test_tag_lookup_work_is_bounded_by_selected_items(self) -> None:
        extract(self.conn, limit=3)
        self.conn.executemany("INSERT INTO kg_tags(id,slug,label,type) VALUES(?,?,?,'keyword')",
                              [(f"unused-{i}", f"unused-{i}", f"unused-{i}") for i in range(3000)])
        self.conn.commit()
        progress_calls = 0

        def budget() -> int:
            nonlocal progress_calls
            progress_calls += 1
            return int(progress_calls > 250)

        self.conn.set_progress_handler(budget, 1000)
        try:
            result = item_tags(self.conn, ["x-following-0"] + [f"missing-{i}" for i in range(999)])
            self.assertTrue(result["x-following-0"])
        finally:
            self.conn.set_progress_handler(None, 0)

    def test_partial_topics_preserve_unsampled_items_and_shared_counts(self) -> None:
        self.build_topics()
        before = self.graph_snapshot()
        self.build_topics(["reddit"], limit=1)
        after = self.graph_snapshot()
        for table, item_column in (("item_topic_assignments", 0), ("kg_edges", 2)):
            self.assertEqual([row for row in before[table] if row[item_column] != 'reddit-0'],
                             [row for row in after[table] if row[item_column] != 'reddit-0'])
        shared = self.conn.execute("SELECT item_count, source_diversity FROM dynamic_topics WHERE slug='shared'").fetchone()
        self.assertEqual(tuple(shared), (24, 3))

    def test_topic_failure_rolls_back_deletion_vectors_and_partial_work(self) -> None:
        self.build_topics()
        before = self.graph_snapshot()
        with patch("eagleye_kg.topics.refresh_topic_counts", side_effect=RuntimeError("simulated topic failure")):
            with self.assertRaisesRegex(RuntimeError, "simulated"):
                discover_topics(self.conn, sources=["reddit"], limit=2)
        self.assertEqual(self.graph_snapshot(), before)
        self.assertEqual(self.conn.execute("SELECT status FROM kg_extraction_runs ORDER BY rowid DESC LIMIT 1").fetchone()[0], "failed")

    def test_topic_reads_and_grouping_do_not_hold_writer_transaction(self) -> None:
        def candidates(item: sqlite3.Row, *_args: object) -> list:
            self.assertFalse(self.conn.in_transaction)
            return self.topic_candidates(item)
        with patch("eagleye_kg.topics.candidate_keys", side_effect=candidates):
            discover_topics(self.conn, limit=10, min_items=1)

    def test_external_input_change_aborts_but_unrelated_commit_does_not(self) -> None:
        self.build_topics()
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "concurrent.sqlite")
            replacement = sqlite3.connect(database)
            self.conn.backup(replacement)
            self.conn.close()
            self.conn = replacement
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA foreign_keys=ON")
            other = sqlite3.connect(database)
            try:
                for relevant in (True, False):
                    before = self.graph_snapshot()
                    changed = False

                    def candidates(item: sqlite3.Row, *_args: object) -> list:
                        nonlocal changed
                        if not changed:
                            if relevant:
                                other.execute("UPDATE information_items SET title = title || ' changed' WHERE id = ?", (item["id"],))
                            else:
                                other.execute("CREATE TABLE unrelated_session_write(id TEXT)")
                            other.commit()
                            changed = True
                        return self.topic_candidates(item)

                    with patch("eagleye_kg.topics.candidate_keys", side_effect=candidates):
                        if relevant:
                            with self.assertRaisesRegex(RuntimeError, "inputs changed.*retry"):
                                discover_topics(self.conn, limit=10, min_items=1)
                            self.assertEqual(self.graph_snapshot(), before)
                        else:
                            result = discover_topics(self.conn, limit=10, min_items=1)
                            self.assertTrue(result["inputs_revalidated"])
                            self.assertNotIn("retryable", result)
            finally:
                other.close()

    def test_empty_topic_scope_keeps_graph(self) -> None:
        self.build_topics()
        before = self.graph_snapshot()
        self.assertEqual(self.build_topics([], limit=3)["total"], 0)
        self.assertEqual(self.graph_snapshot(), before)


if __name__ == "__main__":
    unittest.main()
