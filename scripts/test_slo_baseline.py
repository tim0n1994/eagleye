#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""slo-baseline.py 单元 + 端到端 fixture 测试（不连生产库、不参与 RED 门）。

- 纯逻辑: 时间戳解析 / 百分位 / 追平推算（含 R3.1 双 lane 合成）/ 格式化 /
  Salon9 日志计数;
- 端到端: 临时 fixture 库（sqlite3 建最小 schema）跑 main()，验证标记行、
  判定与退出码语义（0=达标 / 1=SLO 违约 / 2=测量错误）。
  R3.1 行为契约（EXTRACT/TOPIC 判定、双 lane 48h、伴随指标注入）的 RED 门在
  server/services/__tests__/slo-baseline-r31.test.js（vitest，子进程 + env 注入）。

运行:
    python3 /home/jc/projects/eagleye-r3-wt/scripts/test_slo_baseline.py
"""
import importlib.util
import io
import math
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timedelta
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "slo_baseline", os.path.join(HERE, "slo-baseline.py"))
slo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(slo)


class ParseTsTest(unittest.TestCase):
    def test_db_format_space_iso(self):
        self.assertEqual(slo.parse_ts("2026-10-20 08:12:50"),
                         datetime(2026, 10, 20, 8, 12, 50))

    def test_t_separator_z_suffix_fraction(self):
        self.assertEqual(slo.parse_ts("2026-10-20T08:12:50.123Z"),
                         datetime(2026, 10, 20, 8, 12, 50))

    def test_none_and_empty(self):
        self.assertIsNone(slo.parse_ts(None))
        self.assertIsNone(slo.parse_ts(""))

    def test_epoch_returns_datetime(self):
        self.assertIsInstance(slo.parse_ts(1760000000), datetime)


class Pct95Test(unittest.TestCase):
    def test_nearest_rank_basic(self):
        self.assertEqual(slo.pct95([1.0, 2.0, 3.0, 4.0, 5.0]), 5.0)

    def test_censored_below_5pct_uses_real_value(self):
        # 19 个真实样本 + 1 个 INF（5% censored）→ idx=ceil(19)-1=18 → 真实样本 18.0
        samples = [float(x) for x in range(19)] + [math.inf]
        self.assertEqual(slo.pct95(samples), 18.0)

    def test_censored_above_5pct_is_inf(self):
        # 18 个真实样本 + 2 个 INF（10% censored）→ idx=18 → INF
        samples = [float(x) for x in range(18)] + [math.inf] * 2
        self.assertEqual(slo.pct95(samples), math.inf)

    def test_empty_is_none(self):
        self.assertIsNone(slo.pct95([]))


class CatchupHoursTest(unittest.TestCase):
    def test_waived_when_backlog_at_or_below_threshold(self):
        self.assertIsNone(slo.catchup_hours(500, 1000.0))
        self.assertIsNone(slo.catchup_hours(0, 0.0))

    def test_inf_when_no_throughput(self):
        self.assertEqual(slo.catchup_hours(11812, 0.0), math.inf)

    def test_projection_matches_caliber(self):
        # 11,812 积压 @ 4,906.7 vec/天（2026-10-21 实测口径）≈ 57.8h
        self.assertAlmostEqual(slo.catchup_hours(11812, 4906.7), 57.77, delta=0.05)

    def test_healthy_rate_drains_fast(self):
        self.assertLess(slo.catchup_hours(600, 4906.7), 6.0)


class R31CatchupLanesTest(unittest.TestCase):
    """R3.1: 48h 口径 = features 与 embed 两 lane 都清零（取最慢 lane）。"""

    def test_lane_waived_at_or_below_threshold(self):
        self.assertIsNone(slo.lane_catchup_hours(500, 100.0, slo.TH_EXTRACT))
        self.assertIsNone(slo.lane_catchup_hours(0, 0.0, slo.TH_EXTRACT))

    def test_lane_inf_when_engaged_without_throughput(self):
        self.assertEqual(slo.lane_catchup_hours(605, 0.0, slo.TH_EXTRACT), math.inf)

    def test_lane_projection(self):
        # 600 积压 @ 3000/7 条/天 → 600/(3000/7/24) = 33.60h
        self.assertAlmostEqual(slo.lane_catchup_hours(600, 3000 / 7.0, slo.TH_EXTRACT),
                               33.60, places=2)

    def test_combine_takes_slowest_engaged_lane(self):
        self.assertEqual(slo.combine_catchup(28.0, 33.6), 33.6)
        self.assertEqual(slo.combine_catchup(None, 33.6), 33.6)
        self.assertEqual(slo.combine_catchup(math.inf, None), math.inf)
        self.assertIsNone(slo.combine_catchup(None, None))


class Salon9CountTest(unittest.TestCase):
    def test_counts_received_active_final_partial_case_insensitive(self):
        text = "\n".join([
            "asr-agent received chunk seq=41",
            "asr-agent ACTIVE session=room9",
            "heartbeat ok",
            "asr-agent Partial transcript len=812",
            "asr-agent final transcript len=2048",
            "metrics flush cpu=0.02",
        ])
        self.assertEqual(slo.count_salon9_lines(text), 4)

    def test_empty_text_is_zero(self):
        self.assertEqual(slo.count_salon9_lines(""), 0)


class FmtHTest(unittest.TestCase):
    def test_na_inf_decimal(self):
        self.assertEqual(slo.fmt_h(None), "NA")
        self.assertEqual(slo.fmt_h(math.inf), "INF")
        self.assertEqual(slo.fmt_h(2.5), "2.50")


# ---------------------------------------------------------------- 端到端 fixture

UTC_NOW = datetime.utcnow()  # 库时间戳口径 = UTC（与生产 datetime('now') 一致）

# item_features 按生产 006 migration 带 updated_at（R3.1 features lane 吞吐口径）。
SCHEMA = """
CREATE TABLE information_items (id INTEGER PRIMARY KEY, created_at TEXT);
ALTER TABLE information_items ADD COLUMN duplicate_of TEXT; -- R3.0: 生产由新迁移提供
CREATE TABLE item_vectors (
    item_id INTEGER, vector_type TEXT, model_name TEXT, created_at TEXT,
    PRIMARY KEY (item_id, vector_type, model_name));
CREATE TABLE item_features (item_id INTEGER PRIMARY KEY, updated_at TEXT);
CREATE TABLE item_topic_assignments (item_id INTEGER, topic_kind TEXT);
"""


def build_db(items):
    """items: iterable of (id, created_utc, vec_created_utc|None) → db 路径。

    每条都带 item_features（updated_at = 入库 + 4h）与 topics 行，故 R3.1 新增的
    EXTRACT_PENDING / TOPIC_PENDING 判定在本套件恒为 0、不触发，既有场景的
    violations 计数不变。
    """
    path = os.path.join(tempfile.mkdtemp(prefix="slo-fixture-"), "fixture.db")
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    for item_id, created, vec_created in items:
        con.execute("INSERT INTO information_items (id, created_at) VALUES (?,?)",
                    (item_id, created.strftime("%Y-%m-%d %H:%M:%S")))
        con.execute("INSERT INTO item_features VALUES (?,?)",
                    (item_id, (created + timedelta(hours=4)).strftime("%Y-%m-%d %H:%M:%S")))
        con.execute("INSERT INTO item_topic_assignments VALUES (?, 'dynamic')", (item_id,))
        if vec_created is not None:
            con.execute("INSERT INTO item_vectors VALUES (?,?,?,?)",
                        (item_id, "semantic-hash", "eagleye-hash-v1",
                         vec_created.strftime("%Y-%m-%d %H:%M:%S")))
    con.commit()
    con.close()
    return path


@contextmanager
def run_main(db_path, load1=1.0):
    """调 slo.main()（patch DB_PATH 与 loadavg），yield (rc, stdout)。

    伴随指标钉死离线: 清掉 EAGLEYE_SLO_LOADAVG 使 os.getloadavg mock 生效；
    EAGLEYE_SLO_SALON9_LOG 指向不存在的路径 → SALON9_COUNT=NA（不执行 docker logs）。
    fixture 无 background_jobs 表 → GEAR=NA。
    """
    env = {slo.ENV_SALON9_LOG: os.path.join(os.path.dirname(db_path), "missing-salon9.log")}
    with mock.patch.dict(os.environ, env), \
            mock.patch.object(slo, "DB_PATH", db_path), \
            mock.patch("os.getloadavg", return_value=(load1, 1.0, 1.0)), \
            redirect_stdout(io.StringIO()) as out:
        os.environ.pop(slo.ENV_LOADAVG, None)
        rc = slo.main()
    yield rc, out.getvalue()


class EndToEndFixtureTest(unittest.TestCase):
    def fixture(self, items):
        db = build_db(items)
        self.addCleanup(shutil.rmtree, os.path.dirname(db), ignore_errors=True)
        return db

    def test_healthy_pass_exit_0(self):
        # 5 条 24h 前入库、20h 前出向量（延迟 4h < 6h）→ 全部达标
        db = self.fixture([(i, UTC_NOW - timedelta(hours=24),
                            UTC_NOW - timedelta(hours=20)) for i in range(1, 6)])
        with run_main(db) as (rc, out):
            self.assertEqual(rc, 0)
            self.assertIn("BACKLOG=0", out)
            self.assertIn("P95_LATENCY_H=4.00", out)
            self.assertIn("P95_POPULATION=5", out)
            self.assertIn("P95_CENSORED=0", out)
            # R3.1: 新判定不触发、双 lane 豁免、伴随指标三行齐全（离线 → NA）
            self.assertIn("EXTRACT_PENDING=0", out)
            self.assertIn("TOPIC_PENDING=0", out)
            self.assertIn("CATCHUP_FEATURES_H=NA", out)
            self.assertIn("CATCHUP_EMBED_H=NA", out)
            self.assertIn("CATCHUP_H=NA", out)
            self.assertIn("LOAD1=1.00", out)
            self.assertIn("GEAR=NA", out)
            self.assertIn("SALON9_COUNT=NA", out)
            self.assertIn("RESULT=PASS violations=0", out)
            self.assertNotIn("FAIL", out)

    def test_backlog_p95_catchup_violations_exit_1(self):
        # +600 条 30h 前入库无向量：BACKLOG≥500、censored 600/605 → P95=INF、
        # 吞吐 5 vec/7 天 → CATCHUP=600/(5/7/24)=20160h > 48h，三项违约
        items = [(i, UTC_NOW - timedelta(hours=24), UTC_NOW - timedelta(hours=20))
                 for i in range(1, 6)]
        items += [(1000 + i, UTC_NOW - timedelta(hours=30), None) for i in range(600)]
        db = self.fixture(items)
        with run_main(db) as (rc, out):
            self.assertEqual(rc, 1)
            self.assertIn("BACKLOG=600", out)
            self.assertIn("FAIL SLO_BACKLOG: BACKLOG=600 >= 500", out)
            self.assertIn("P95_LATENCY_H=INF", out)
            self.assertIn("P95_POPULATION=605", out)
            self.assertIn("P95_CENSORED=600", out)
            self.assertIn("FAIL SLO_P95_LATENCY", out)
            # R3.1 双 lane: embed lane 20160h（features lane 积压 0 → 豁免 NA）
            self.assertIn("CATCHUP_EMBED_H=20160.00", out)
            self.assertIn("CATCHUP_FEATURES_H=NA", out)
            self.assertIn("CATCHUP_H=20160.00", out)
            self.assertIn("FAIL SLO_CATCHUP_48H: CATCHUP_H=20160.00", out)
            self.assertIn("RESULT=FAIL violations=3", out)

    def test_min_age_utc_caliber(self):
        # 30h 前入库无向量 → 参评(censored)；3h 前入库(<6h) → 不参评。
        # 锁 UTC 基准: 若 main 误用本地时区（CST=UTC+8），min_age 平移 8h，
        # 30h 条目也被误排除 → population=0 → 本测试失败
        db = self.fixture([
            (1, UTC_NOW - timedelta(hours=30), None),
            (2, UTC_NOW - timedelta(hours=3), None),
        ])
        with run_main(db) as (rc, out):
            self.assertIn("P95_POPULATION=1", out)
            self.assertIn("P95_CENSORED=1", out)
            self.assertIn("P95_LATENCY_H=INF", out)
            self.assertIn("FAIL SLO_P95_LATENCY", out)
            # 仅 P95 一项违约（BACKLOG=1<500、catchup 豁免、load=1.0）
            self.assertIn("RESULT=FAIL violations=1", out)
            self.assertEqual(rc, 1)

    def test_empty_window_p95_na_not_judged(self):
        # 唯一条目在 48h 窗口外 → P95=NA 不判定 → PASS
        db = self.fixture([(1, UTC_NOW - timedelta(hours=100),
                            UTC_NOW - timedelta(hours=99))])
        with run_main(db) as (rc, out):
            self.assertEqual(rc, 0)
            self.assertIn("P95_LATENCY_H=NA", out)
            self.assertIn("NOTE p95_window_empty=1", out)
            self.assertIn("RESULT=PASS violations=0", out)

    def test_load1_violation_exit_1(self):
        db = self.fixture([(1, UTC_NOW - timedelta(hours=24),
                            UTC_NOW - timedelta(hours=20))])
        with run_main(db, load1=3.5) as (rc, out):
            self.assertEqual(rc, 1)
            self.assertIn("FAIL SLO_LOAD1: LOAD1=3.50 > 3.0", out)
            self.assertIn("RESULT=FAIL violations=1", out)

    def test_measurement_error_exit_2(self):
        # 库不可读 = 测量错误（exit 2），不得混入 RED（exit 1）
        proc = subprocess.run(
            [sys.executable, os.path.join(HERE, "slo-baseline.py")],
            env=dict(os.environ, EAGLEYE_SLO_DB="/nonexistent/eagleye.db"),
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("ERROR slo-baseline", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
