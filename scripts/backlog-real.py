#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Eagleye R3.0 — BACKLOG_REAL 测量（软标记 dup 排除后的真实积压, 只读）。

用法:
    python3 scripts/backlog-real.py

口径（与 scripts/slo-baseline.py 的 BACKLOG lane 同 lane, 只差排除 dup 行）:
    BACKLOG_REAL = information_items 中 duplicate_of IS NULL 且无任何
    item_vectors 行的条数。

    诊断基线（2026-10-21, 生产库 mode=ro 实测）: vector 积压 12,092 =
    7,478 dup + 4,614 非 dup → 回填后本脚本应输出 BACKLOG_REAL=4614
    （CTO 的 ~2k 预期差值由 10-17 入库尖峰未排干解释: 非 dup 积压按日分布
    10-17:2,869 / 10-18:503 / 10-19:555 / 10-20:687, 全部为近 4 天行）。

输出: 整行标记 BACKLOG_REAL=<n>, 退出码 0。
      库路径优先级: EAGLEYE_BACKLOG_REAL_DB（单测/任务钩子）,
      EAGLEYE_DB_PATH（标准共享配置）, <repo>/eagleye.db。
      生产巡检只做 mode=ro 只读查询。
只读: file:...?mode=ro + PRAGMA query_only（slo-baseline.open_ro 同纪律）,
      不写库、不产生 -wal/-journal 副本。
测量错误: 库缺失/不可开 → stderr + 退出码 2; stdout 绝不打印 BACKLOG_REAL=
      行（没测到的数不冒充测到 — 退出码+stdout 双拦截）。
"""
import os
import sqlite3
import sys

DB_PATH = os.environ.get(
    "EAGLEYE_BACKLOG_REAL_DB",
    os.environ.get(
        "EAGLEYE_DB_PATH",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "eagleye.db"),
    ),
)

# 与 slo-baseline.py BACKLOG lane 同款（无任何 item_vectors 行口径）,
# 加上 R3.0 的软标记排除。
SQL = ("SELECT COUNT(*) FROM information_items i "
       "WHERE i.duplicate_of IS NULL "
       "AND NOT EXISTS (SELECT 1 FROM item_vectors v WHERE v.item_id = i.id)")


def open_ro(path):
    """mode=ro 只读连接（含 query_only 双保险）— slo-baseline.open_ro 同款。"""
    if not os.path.exists(path):
        raise FileNotFoundError("db not found: %s" % path)
    con = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=30)
    con.execute("PRAGMA query_only=1")
    return con


def main():
    con = open_ro(DB_PATH)
    try:
        backlog_real = con.execute(SQL).fetchone()[0]
    finally:
        con.close()
    print("BACKLOG_REAL_RUN db=%s caliber=non-dup" % DB_PATH)
    print("BACKLOG_REAL=%d" % backlog_real)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # 测量错误: 不打印任何 BACKLOG_REAL= 行
        sys.stderr.write("ERROR backlog-real: %s: %r\n" % (type(exc).__name__, exc))
        sys.exit(2)
