from __future__ import annotations

"""R3.0 跨天重复治理 — RED 规格: 三个 KG 积压选取谓词一律排除 dup 行.

背景（2026-10-21, worktree round3-convergence @ 1b8bc3f）:
  CTO 实测 10-19 入库 4,419 条中 3,638 条（82%）是跨天重插（同
  source+canonical_url 在更早日期已存在）; 全库 65,916 行中 32,446 行是
  dup（诊断 DUP_DIAG, /tmp 侧 mode=ro 只读实测）。根因是
  UNIQUE(source_id, canonical_url, digest_date) 允许同 URL 每天重插。

方案（软标记, 不做物理删除）:
  迁移新增 information_items.duplicate_of TEXT NULL（+ 索引）; 回填把重复组
  非首行指向首行 id（保留每组最早一行, (created_at,id) 全序确定性）; dup 行
  的判定 = duplicate_of IS NOT NULL。物理清理连依赖行放 R5 retention。

本文件钉的契约（实现方照此改谓词; 行为级断言, 不锁实现位置）:
  1. enrich 积压选取 — pipeline.load_items（features 阶段, 无条件走积压
     谓词）: duplicate_of IS NOT NULL 的行永不被选中, 三种 drain 排序
     （None / newest-first / oldest-first）一致。
  2. vectors 积压选取 — vectors.load_vector_items（embed 阶段）: 同上。
  3. kg 积压选取 — topics.load_items_for_topics(pending=True)（topics 阶段
     的 R3 收敛谓词 TOPICS_LITE_PENDING）: 同上。
  4. 组合语义 — dup 排除与既有 done-marker 收敛语义正交: 已 drained 的
     非 dup 行仍被排除, dup 行仍然一个都不选（积压集合只缩不胀）。

不钉的（避免过度约束）:
  * 排除条件写在哪一子句（fair_items 基础 WHERE 还是各 pending 字符串）
    由实现自定 — 测试只看「选没选出来」。
  * force=True 的 vectors 重算路径、topics 默认（pending=False）重扫窗口
    是否排除 dup: 不在本契约内。

fixture: 内存库 + 生产 migrations 001/006/030（与 test_drain_selection.py
同源）, 再 ALTER TABLE 加 duplicate_of 列（生产由新迁移提供）。绝不触
生产库 /home/jc/projects/eagleye/eagleye.db。

运行（与 kg-worker 既有套件同一入口）:
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=kg-worker python3 -m unittest \
      discover -s kg-worker/tests -v
"""

import contextlib
import io
import sqlite3
import unittest
from pathlib import Path

from eagleye_kg.pipeline import load_items
from eagleye_kg.topics import load_items_for_topics
from eagleye_kg.vectors import HASH_EMBED_VECTOR_TYPE, HASH_VECTOR_MODEL, load_vector_items

# kg-drainer.js DRAIN_CAPS 的三条 lane 排序; 谓词排除必须在每条排序下都成立。
DUP_ORDERS = (None, "newest-first", "oldest-first")


class DupExclusionSelectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.text_factory = lambda value: value.decode("utf-8", errors="replace")
        self.conn.execute("PRAGMA foreign_keys=ON")
        root = Path(__file__).resolve().parents[2]
        for migration in ("001_initial_schema.sql", "006_kg_v2.sql", "030_kg_item_topic_lookup.sql"):
            self.conn.executescript((root / "server/migrations" / migration).read_text())
        # R3.0 迁移在生产由新增 migration 提供; fixture 直接加列。回填语义:
        # dup 行 duplicate_of = 组内首行 id, 非 dup 行保持 NULL。
        self.conn.execute("ALTER TABLE information_items ADD COLUMN duplicate_of TEXT")
        self.conn.execute("DELETE FROM sources")
        self.conn.execute(
            "INSERT INTO sources(id,slug,label,is_active) VALUES('x-following','x-following','x-following',1)"
        )
        # 8 items: score 96→89。三条 dup（模拟同 URL 跨天重插, 回填后指向
        # 组内最早行 xf-0）。全部行都无 item_features/item_vectors 行 →
        # 三个阶段的积压谓词下全部 pending。
        for index in range(8):
            self.conn.execute(
                """INSERT INTO information_items
                   (id,source_id,title,canonical_url,digest_date,score,published_at,source_payload)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (
                    f"xf-{index}",
                    "x-following",
                    "Dup exclusion fixture item",
                    "https://example.com/xf-0" if index in (1, 3, 6) else f"https://example.com/xf-{index}",
                    f"2026-10-{10 + index:02d}",
                    96 - index,
                    f"2026-10-{10 + index:02d}T00:00:00Z",
                    "{}",
                ),
            )
        for dup_id in ("xf-1", "xf-3", "xf-6"):
            self.conn.execute(
                "UPDATE information_items SET duplicate_of = 'xf-0' WHERE id = ?", (dup_id,)
            )
        self.conn.commit()
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()

    def tearDown(self) -> None:
        self.output.__exit__(None, None, None)
        self.conn.close()

    # 非 dup 的全部行（三阶段共用期望集）。
    NON_DUP_IDS = ["xf-0", "xf-2", "xf-4", "xf-5", "xf-7"]

    def _ids(self, rows: list[sqlite3.Row]) -> list[str]:
        return sorted(row["id"] for row in rows)

    def _mark_topics_drained(self, item_id: str) -> None:
        """既有 done-marker（R3.1 ruling C）: lite 向量 + dynamic 指派双全。"""
        self.conn.execute(
            """INSERT INTO item_vectors (item_id, vector_type, model_name, dimension, vector_json, content_hash)
               VALUES (?, 'semantic-lite', ?, 256, '[]', 'fixture')""",
            (item_id, HASH_VECTOR_MODEL),
        )
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

    # ------------------------------------------------ 1. enrich (features)

    def test_extract_never_selects_duplicate_rows_in_any_drain_order(self) -> None:
        for order in DUP_ORDERS:
            with self.subTest(order=order):
                rows = load_items(self.conn, ["x-following"], 50, order=order)
                self.assertEqual(
                    self._ids(rows),
                    self.NON_DUP_IDS,
                    f"extract 选取必须排除 duplicate_of IS NOT NULL 的行（order={order!r}）",
                )

    # ------------------------------------------------ 2. vectors (embed)

    def test_embed_never_selects_duplicate_rows_in_any_drain_order(self) -> None:
        for order in DUP_ORDERS:
            with self.subTest(order=order):
                rows = load_vector_items(
                    self.conn, ["x-following"], 50, HASH_VECTOR_MODEL,
                    HASH_EMBED_VECTOR_TYPE, 1200, False, order=order,
                )
                self.assertEqual(
                    self._ids(rows),
                    self.NON_DUP_IDS,
                    f"embed 选取必须排除 duplicate_of IS NOT NULL 的行（order={order!r}）",
                )

    # ------------------------------------------------ 3. kg (topics)

    def test_topics_pending_never_selects_duplicate_rows(self) -> None:
        rows = load_items_for_topics(self.conn, ["x-following"], 50, pending=True)
        self.assertEqual(
            self._ids(rows),
            self.NON_DUP_IDS,
            "topics --pending 选取必须排除 duplicate_of IS NOT NULL 的行",
        )

    # ------------------------------------------------ 4. 组合语义

    def test_topics_dup_exclusion_composes_with_the_drained_done_marker(self) -> None:
        # 两个非 dup 行走完 R3.1 C 的 done-marker → 仍被收敛谓词排除;
        # dup 行一个都不选; 剩余 pending = 非 dup 且未 drained。
        self._mark_topics_drained("xf-0")
        self._mark_topics_drained("xf-4")
        rows = load_items_for_topics(self.conn, ["x-following"], 50, pending=True)
        self.assertEqual(self._ids(rows), ["xf-2", "xf-5", "xf-7"])

    def test_all_non_dup_drained_and_only_dups_left_yields_zero_work(self) -> None:
        # 真实积压清零后, 即便库里还有大量 dup 行（如回填后的 32,446 行）,
        # 三个阶段的选取都必须是空 — dup 行永远不会成为“剩余积压”。
        for item_id in self.NON_DUP_IDS:
            self._mark_topics_drained(item_id)
        self.assertEqual(load_items_for_topics(self.conn, ["x-following"], 50, pending=True), [])


if __name__ == "__main__":
    unittest.main()
