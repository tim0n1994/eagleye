#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dup-backfill.py — R3.0 历史跨天重复治理：information_items.duplicate_of 软标记回填（幂等）。

用法:
    python3 scripts/dup-backfill.py --help
    python3 scripts/dup-backfill.py --db <sqlite>                 # 回填（幂等，重复跑零变更）
    python3 scripts/dup-backfill.py --db <sqlite> --lock <path>   # 指定 flock 互斥文件

前置: 迁移 044_information_items_duplicate_of.sql 已应用（脚本启动时校验列存在）。

回填语义（与诊断 DUP_DIAG 同口径，组键 (source_id, canonical_url)；canonical_url
NOT NULL、生产 0 个 NULL source_id —— 诊断已验证 grouping clean）:
    每组保留 ORDER BY created_at ASC, id ASC 的首行（id 是 PK → 全序 → 确定性；
    生产 dup_tie_groups=1 的 created_at 平局由 id 决胜），其余行 duplicate_of = 首行 id。
    只写 duplicate_of 一列，不动其他列。

幂等: 期望态 diff 写入 —— 本次只 UPDATE 与期望态不一致的行；重跑零变更（ALREADY）。
    ALREADY 是 DB 状态判定而非账本判定：整列置空（回滚语义）后重跑会重新标记满额。

输出（stdout，行首锚定 KEY=VALUE，行尾允许附加字段）:
    DUP_BACKFILL_OK marked=<n> cleared=<c> groups=<g> dup_rows=<t>
        本次实际写入 <n> 行（首跑 / 回滚后重跑）；<c> = 本次清掉的错标行；<g> = 重复组数；
        <t> = 回填后 duplicate_of IS NOT NULL 总行数（诊断对账值：生产应为 32446）
    DUP_BACKFILL_ALREADY marked=0 ...    零变更（幂等重跑）
    BACKLOG_REAL vectors=<v> features=<f>
        新口径积压: duplicate_of IS NULL 且无 item_vectors / item_features 行
        （两种成功跑都输出；生产预期 vectors=4614 features=5095，见 DUP_DIAG）

退出码:
    0 = 成功（含 ALREADY）; 2 = 错误（库不存在/缺表/缺 duplicate_of 列/写失败等）→
    stderr 行首 "ERROR"，stdout 绝不出现 OK/ALREADY 标记（退出码+stdout 双拦截）。

并发与锁:
    默认对 per-DB sidecar 锁（/tmp/eagleye-dup-backfill-<db路径哈希>.lock）flock 排他，
    防同一库被并发回填；生产部署按 checklist 纪律另用 --lock <repo>/heavy.lock
    （或 env EAGLEYE_HEAVY_LOCK）与其他 heavy 任务互斥。busy_timeout 30s 兼容 live WAL。

生产执行示例（部署时才执行，R3.0 上线窗口 10-22 白天）:
    python3 /home/jc/projects/eagleye/scripts/dup-backfill.py \\
        --db /home/jc/projects/eagleye/eagleye.db \\
        --lock /home/jc/projects/eagleye/heavy.lock

注意: UPDATE 会触发 items_fts_au 触发器（FTS 影子行重写，内容不变），生产首跑约写
32,446 行 —— 属预期的重操作，请在部署窗口执行。
"""
import argparse
import fcntl
import hashlib
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

SCRIPT_VERSION = "r3.0-dup-backfill.1"
BUSY_TIMEOUT_MS = 30_000
REQUIRED_TABLES = ("information_items", "item_vectors", "item_features")

# 期望态：组键 (source_id, canonical_url)，首行 = (created_at, id) 全序最小行。
# (created_at, id) 因 id 是 PK 构成全序 → 每组首行唯一确定（确定性，平局由 id 决胜）。
RANK_SQL = """
    SELECT id, first_id FROM (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY source_id, canonical_url
                                ORDER BY created_at ASC, id ASC) AS rn,
             FIRST_VALUE(id) OVER (PARTITION BY source_id, canonical_url
                                   ORDER BY created_at ASC, id ASC) AS first_id
      FROM information_items
    ) WHERE rn > 1
"""

# 幂等核心：只写与期望态不一致的行（IS NOT 为 NULL 安全比较，SQLite 语义）。
SET_SQL = """
    UPDATE information_items
       SET duplicate_of = (SELECT t.first_id FROM dup_first t WHERE t.id = information_items.id)
     WHERE EXISTS (SELECT 1 FROM dup_first t WHERE t.id = information_items.id)
       AND duplicate_of IS NOT (SELECT t.first_id FROM dup_first t WHERE t.id = information_items.id)
"""
CLEAR_SQL = """
    UPDATE information_items
       SET duplicate_of = NULL
     WHERE duplicate_of IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dup_first t WHERE t.id = information_items.id)
"""

# 新口径积压：非 dup（duplicate_of IS NULL）且缺向量/特征行
BACKLOG_SQL = """
    SELECT COUNT(*) FROM information_items i
     WHERE i.duplicate_of IS NULL
       AND NOT EXISTS (SELECT 1 FROM {tbl} x WHERE x.item_id = i.id)
"""


def fail(msg):
    print("ERROR: {}".format(msg), file=sys.stderr)
    raise SystemExit(2)


def open_db(db_path):
    db_path = Path(db_path)
    if not db_path.is_file():
        fail("database not found: {}（--db 必须指向已存在的 sqlite 库，本脚本绝不新建）".format(db_path))
    # URI mode=rw：已存在的库才打开，杜绝误建空库；isolation_level=None → 显式事务控制
    uri = "file:{}?mode=rw".format(quote(str(db_path.resolve())))
    conn = sqlite3.connect(uri, uri=True, timeout=BUSY_TIMEOUT_MS / 1000.0,
                           isolation_level=None)
    conn.execute("PRAGMA busy_timeout={}".format(BUSY_TIMEOUT_MS))
    return conn


def validate_schema(conn):
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    missing = [t for t in REQUIRED_TABLES if t not in tables]
    if missing:
        fail("missing required table(s): {} — --db 必须指向应用过完整迁移的 eagleye 库".format(
            ", ".join(missing)))
    cols = [r[1] for r in conn.execute("PRAGMA table_info(information_items)")]
    if "duplicate_of" not in cols:
        fail("information_items.duplicate_of column missing — 先应用迁移 "
             "044_information_items_duplicate_of.sql 再回填")


def default_lock_path(db_path):
    env = os.environ.get("EAGLEYE_HEAVY_LOCK")
    if env:
        return Path(env)
    digest = hashlib.sha256(str(Path(db_path).resolve()).encode("utf-8")).hexdigest()[:12]
    return Path(tempfile.gettempdir()) / "eagleye-dup-backfill-{}.lock".format(digest)


def acquire_lock(lock_path):
    try:
        f = open(lock_path, "a+")
    except OSError as exc:
        fail("cannot open lock file {}: {}".format(lock_path, exc))
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("waiting for lock: {}".format(lock_path), file=sys.stderr)
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
    return f  # 持有到进程退出


def run_backfill(conn):
    """单事务执行回填；返回 (marked, cleared, groups)。marked=本次置非 NULL 的行数。"""
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("CREATE TEMP TABLE dup_first (id TEXT PRIMARY KEY, first_id TEXT NOT NULL)")
        conn.execute("INSERT INTO dup_first (id, first_id)" + RANK_SQL)
        groups = conn.execute("SELECT COUNT(DISTINCT first_id) FROM dup_first").fetchone()[0]
        marked = conn.execute(SET_SQL).rowcount
        cleared = conn.execute(CLEAR_SQL).rowcount
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return marked, cleared, groups


def main():
    ap = argparse.ArgumentParser(
        prog="dup-backfill.py",
        description="R3.0 duplicate_of 软标记回填（幂等）。语义: 按 (source_id, canonical_url) "
                    "分组，保留每组 ORDER BY created_at ASC, id ASC 的首行，其余行 "
                    "duplicate_of=首行 id；只写该列。回滚 = 整列置空后重跑可重新标记。")
    ap.add_argument("--db", required=True,
                    help="eagleye sqlite 库路径（必须已存在；绝不新建）")
    ap.add_argument("--lock", default=None,
                    help="flock 互斥文件（checklist heavy 纪律）。默认: $EAGLEYE_HEAVY_LOCK "
                         "或 /tmp 下按库路径派生的 sidecar 锁；生产建议传 <repo>/heavy.lock")
    ap.add_argument("--version", action="version", version=SCRIPT_VERSION)
    args = ap.parse_args()

    lock_path = Path(args.lock) if args.lock else default_lock_path(args.db)
    lock_file = acquire_lock(lock_path)
    conn = open_db(args.db)
    try:
        validate_schema(conn)
        marked, cleared, groups = run_backfill(conn)
        dup_rows = conn.execute(
            "SELECT COUNT(*) FROM information_items WHERE duplicate_of IS NOT NULL"
        ).fetchone()[0]
        vectors = conn.execute(BACKLOG_SQL.format(tbl="item_vectors")).fetchone()[0]
        features = conn.execute(BACKLOG_SQL.format(tbl="item_features")).fetchone()[0]
    finally:
        conn.close()
        lock_file.close()

    marker = "DUP_BACKFILL_OK" if (marked + cleared) > 0 else "DUP_BACKFILL_ALREADY"
    print("{} marked={} cleared={} groups={} dup_rows={}".format(
        marker, marked, cleared, groups, dup_rows))
    print("BACKLOG_REAL vectors={} features={}".format(vectors, features))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # 任何未预期错误 → rc2 + stderr ERROR，绝不伪装成 OK
        print("ERROR: {}: {}".format(type(exc).__name__, exc), file=sys.stderr)
        sys.exit(2)
