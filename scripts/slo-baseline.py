#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Eagleye R3 收敛层 SLO 基准测量（确定性输出、只读生产库）。

用法:
    python3 /home/user/projects/eagleye-r3-wt/scripts/slo-baseline.py

SLO（CTO Round-3 验收口径 + R3.1 裁决 B/Q5 判定域扩容）与判定:
    R3.0 判定域 = 非 dup 行（BACKLOG_REAL 口径）: 四个 pending 计数
    （BACKLOG/EMBED_PENDING/EXTRACT_PENDING/TOPIC_PENDING）与 P95 判定人口
    一律排除 duplicate_of IS NOT NULL 的软标记重复行 — 否则 32,446 行 dup
    会让 SLO 永远红、追平推算永远虚高。排除不是放宽阈值: 真实（非 dup）
    积压 =500 仍然违约。
    稳态  BACKLOG          积压 < 500
         （口径 = information_items 中在 item_vectors 无任何行的条数，即 CTO 事实①
          的 11,812 口径；>= 500 违约）
    稳态  EXTRACT_PENDING  features 积压 < 500（无 item_features 行的条数；>= 500 违约）
    稳态  TOPIC_PENDING    topics 积压 < 500（无 item_topic_assignments 行的条数；>= 500 违约）
         （R3.1 新纳入退出码；阈值与 TH_BACKLOG 同为 500，裁决 A 的 backlog_features>500
          同量级；CTO 另定数值时改 TH_EXTRACT / TH_TOPIC 常量）
    稳态  P95_LATENCY_H    入库→出向量 p95 < 6h（口径见下）
    追平  CATCHUP_H        features 与 embed 两条 lane **都**在 48h 内清零（口径见下；
         两 lane 都豁免 → NA 不判；任一 lane 推算 > 48h 违约）
    资源  LOAD1            1 分钟负载 <= 3.0（drainer 运行时约束的快照；读不到 → NA 不判）

伴随指标（R3.1 裁决 Q4；每轮必出、只输出不判定、缺源 → NA，绝不因此 exit 2）:
    LOAD1=         默认 os.getloadavg()；设 EAGLEYE_SLO_LOADAVG=<path> 则改读该文件
                   首个字段（/proc/loadavg 格式，裁决 A「可注入路径 mock」口径）。
    GEAR=          drainer 当前档位 = 最近一条可解析、含非空 mode 的已完成 kg-drain
                   background_jobs.result 的 mode（steady/catchup/slow，见
                   server/services/kg-drainer.js DRAIN_CAPS；jobs.js 把 runKGDrain 的
                   {mode,...} JSON.stringify 进 result）。无表/无记录/全不可解析 → NA。
                   直接读 drainer 自己写的 mode，不在 SLO 侧复刻其滞后状态机。
    SALON9_COUNT=  `docker logs --since 15m salon9-asr-agent-1` 中匹配
                   received|active|final|partial（忽略大小写）的行数；设
                   EAGLEYE_SLO_SALON9_LOG=<path> 则改读该 fixture 文件（确定性钩子）；
                   EAGLEYE_SLO_SALON9_UNIT / EAGLEYE_SLO_SALON9_SINCE 可覆盖容器名与窗口。

p95 口径（P95_LATENCY_H）:
    - 人群: information_items.created_at ∈ [now-48h, now-6h]（入库不足 6h 不参评；
      48h 窗口保证每日一批的进料节拍下窗口非空）;
    - 时间基准: 库内时间戳为 UTC（datetime('now')，见 R3 阶段1诊断），故 now 取
      datetime.utcnow()——若用本地时区（CST=UTC+8）会使窗口/min-age 全部偏移 8h，
      入库 0-2h 的新条目被误计入 censored;
    - 延迟 = 该条目 (vector_type='semantic-hash', model_name='eagleye-hash-v1')
      向量行的 created_at − 条目 created_at（当前在产向量后端 = hash, kg-worker.js:87）;
    - 窗口内无该向量的条目按 +INF 计入样本（censored）; nearest-rank 第 95 百分位;
    - 窗口为空（48h 无入库）→ NA，不判（如实报，不视作违约）。

CATCHUP 口径（R3.1: 48h 以 features 与 embed 两个 lane 都清零为准）:
    RATE_7D_PER_DAY          = 近 7 天 semantic-hash 向量新增行数 / 7（embed lane 吞吐）
    （注意: 当前窗口含 2026-10-17 的 32,347 条一次性回填尖峰，吞吐被高估，如实计入）;
    RATE_FEATURES_7D_PER_DAY = 近 7 天 item_features.updated_at 新增行数 / 7
                               （features lane 吞吐；生产 006 migration 有该列）;
    CATCHUP_EMBED_H    = EMBED_PENDING   / (RATE_7D_PER_DAY / 24)
    CATCHUP_FEATURES_H = EXTRACT_PENDING / (RATE_FEATURES_7D_PER_DAY / 24)
    单 lane 积压 <= 500 → 该 lane 豁免（NA）; 积压 > 500 且 RATE = 0 → INF;
    CATCHUP_H = 非 NA lane 的最大值（都 NA → NA 不判）; CATCHUP_H > 48 → 违约。

输出: 每指标一行 KEY=VALUE 标记行（BACKLOG= 与 P95_LATENCY_H= 为必打标记；
      LOAD1= / GEAR= / SALON9_COUNT= 伴随指标每轮必打），
      违约时追加大写 FAIL 行，末行 RESULT=FAIL/PASS 汇总。
退出码: 0 = 全部达标; 1 = SLO 违约（RED）; 2 = 测量错误（库不可读等，不算 RED）。
       伴随指标缺源只会得到 NA，绝不触发退出码 2。
只读: file:...?mode=ro + PRAGMA query_only，不写库、不拷贝库、无网络请求
      （SALON9 生产源仅执行本机 `docker logs` 只读查询）。
"""
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone

DB_PATH = os.environ.get("EAGLEYE_SLO_DB", "/home/user/projects/eagleye/eagleye.db")

TH_BACKLOG = 500      # SLO: 积压 < 500（>= 500 违约）
TH_EXTRACT = 500      # SLO: features 积压 EXTRACT_PENDING < 500（>= 500 违约; R3.1）
TH_TOPIC = 500        # SLO: topics 积压 TOPIC_PENDING < 500（>= 500 违约; R3.1）
TH_P95_H = 6.0        # SLO: p95 < 6h（>= 6h 违约）
TH_CATCHUP_H = 48.0   # SLO: 追平 <= 48h（> 48h 违约; 单 lane 积压<=500 该 lane 豁免）
TH_LOAD1 = 3.0        # SLO: 1 分钟负载 <= 3.0（> 3.0 违约）
P95_WINDOW_H = 48     # p95 观测窗口
P95_MIN_AGE_H = 6     # 入库后至少 6h 才参评
RATE_WINDOW_H = 168   # 吞吐观测窗口（7 天）

# 伴随指标注入钩子（env）: 缺源 → NA，绝不 exit 2。
ENV_LOADAVG = "EAGLEYE_SLO_LOADAVG"          # /proc/loadavg 格式文件路径
ENV_SALON9_LOG = "EAGLEYE_SLO_SALON9_LOG"    # docker logs 文本 fixture 路径
ENV_SALON9_UNIT = "EAGLEYE_SLO_SALON9_UNIT"  # 容器名，默认 salon9-asr-agent-1
ENV_SALON9_SINCE = "EAGLEYE_SLO_SALON9_SINCE"  # docker logs --since，默认 15m
SALON9_UNIT_DEFAULT = "salon9-asr-agent-1"
SALON9_SINCE_DEFAULT = "15m"
SALON9_TIMEOUT_S = 20
SALON9_PATTERN = re.compile(r"received|active|final|partial", re.IGNORECASE)
GEAR_SQL = ("SELECT result FROM background_jobs "
            "WHERE job_type = 'kg-drain' AND status = 'completed' "
            "ORDER BY created_at DESC, rowid DESC")

HASH_VEC_ON = ("v.item_id = i.id AND v.vector_type = 'semantic-hash' "
               "AND v.model_name = 'eagleye-hash-v1'")


def parse_ts(value):
    """时间戳解析（本库实测格式 'YYYY-MM-DD HH:MM:SS' TEXT）。

    容错: 'T' 分隔 / 'Z' 后缀 / 小数秒 / epoch int-float。不可解析返回 None。
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value))
    s = str(value).strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1]
    if "T" in s:
        s = s.replace("T", " ", 1)
    if "." in s:
        s = s.split(".", 1)[0]
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def fmt_h(value):
    """小时值格式化: NA / INF / 两位小数。"""
    if value is None:
        return "NA"
    if isinstance(value, float) and math.isinf(value):
        return "INF"
    return "%.2f" % value


def pct95(samples):
    """nearest-rank 第 95 百分位; censored 样本须以 +INF 传入。空列表 → None。"""
    if not samples:
        return None
    ordered = sorted(samples)
    idx = max(0, math.ceil(0.95 * len(ordered)) - 1)
    return ordered[idx]


def lane_catchup_hours(pending, rate_per_day, threshold):
    """单 lane 追平推算: pending<=threshold → None(豁免); rate<=0 → INF; 否则小时数。"""
    if pending <= threshold:
        return None
    if rate_per_day <= 0:
        return math.inf
    return pending / (rate_per_day / 24.0)


def catchup_hours(backlog, rate_per_day):
    """embed lane 追平推算（阈值 TH_BACKLOG）; 保留原签名供既有单测/调用方。"""
    return lane_catchup_hours(backlog, rate_per_day, TH_BACKLOG)


def combine_catchup(*lanes):
    """R3.1 48h 口径: 所有 lane 都清零才算追平 → 取非 NA lane 的最大值; 都 NA → None。"""
    engaged = [h for h in lanes if h is not None]
    return max(engaged) if engaged else None


def read_load1():
    """1 分钟负载: 设 EAGLEYE_SLO_LOADAVG 则读该文件首字段（/proc/loadavg 格式），
    否则 os.getloadavg()。任何读取/解析失败 → None（输出 NA，不判、不 exit 2）。"""
    path = os.environ.get(ENV_LOADAVG)
    if path:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return float(fh.read().split()[0])
        except (OSError, ValueError, IndexError):
            return None
    try:
        return os.getloadavg()[0]
    except (OSError, AttributeError):
        return None


def latest_drain_gear(con):
    """GEAR: 最近一条已完成 kg-drain job 的 result.mode（逐条 json.loads，取第一个
    解析为对象且含非空 mode 字符串的）。无表 / 无记录 / 全不可解析 / 查询出错 → None。"""
    try:
        has_table = con.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' "
                                "AND name = 'background_jobs'").fetchone()
        if not has_table:
            return None
        rows = con.execute(GEAR_SQL).fetchall()
    except sqlite3.Error:
        return None
    for (result,) in rows:
        try:
            obj = json.loads(result)
        except (TypeError, ValueError):
            continue
        if isinstance(obj, dict):
            mode = obj.get("mode")
            if isinstance(mode, str) and mode:
                return mode
    return None


def count_salon9_lines(text):
    """匹配 received|active|final|partial（忽略大小写）的行数。"""
    return sum(1 for line in text.splitlines() if SALON9_PATTERN.search(line))


def salon9_count():
    """SALON9_COUNT: 设 EAGLEYE_SLO_SALON9_LOG 则读该 fixture 文件计数（确定性），
    否则执行 `docker logs --since <SINCE> <UNIT>`（stdout+stderr 均为容器日志）。
    源不可读 / docker 失败 / 超时 → None（输出 NA，不判、不 exit 2）。"""
    log_path = os.environ.get(ENV_SALON9_LOG)
    if log_path:
        try:
            with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
                return count_salon9_lines(fh.read())
        except OSError:
            return None
    unit = os.environ.get(ENV_SALON9_UNIT, SALON9_UNIT_DEFAULT)
    since = os.environ.get(ENV_SALON9_SINCE, SALON9_SINCE_DEFAULT)
    try:
        proc = subprocess.run(["docker", "logs", "--since", since, unit],
                              capture_output=True, text=True, errors="replace",
                              timeout=SALON9_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return count_salon9_lines(proc.stdout) + count_salon9_lines(proc.stderr)


def open_ro(path):
    """mode=ro 只读连接（含 query_only 双保险）。"""
    if not os.path.exists(path):
        raise FileNotFoundError("db not found: %s" % path)
    con = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=30)
    con.execute("PRAGMA query_only=1")
    return con


def main():
    # 库时间戳为 UTC（datetime('now')，见 R3 阶段1诊断）; 本地 now 会偏移 8h。
    # 取 naive UTC（去 tzinfo）以与库内 TEXT 时间戳直接可比。
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    win_start = now - timedelta(hours=P95_WINDOW_H)
    rate_start = now - timedelta(hours=RATE_WINDOW_H)
    min_age = now - timedelta(hours=P95_MIN_AGE_H)
    win_start_s = win_start.strftime("%Y-%m-%d %H:%M:%S")
    rate_start_s = rate_start.strftime("%Y-%m-%d %H:%M:%S")

    con = open_ro(DB_PATH)
    try:
        q = con.execute
        total_items = q("SELECT COUNT(*) FROM information_items").fetchone()[0]
        backlog = q("SELECT COUNT(*) FROM information_items i WHERE i.duplicate_of IS NULL "
                    "AND NOT EXISTS (SELECT 1 FROM item_vectors v WHERE v.item_id = i.id)").fetchone()[0]
        embed_pending = q("SELECT COUNT(*) FROM information_items i WHERE i.duplicate_of IS NULL "
                          "AND NOT EXISTS (SELECT 1 FROM item_vectors v WHERE %s)" % HASH_VEC_ON).fetchone()[0]
        extract_pending = q("SELECT COUNT(*) FROM information_items i WHERE i.duplicate_of IS NULL "
                            "AND NOT EXISTS (SELECT 1 FROM item_features f WHERE f.item_id = i.id)").fetchone()[0]
        topic_pending = q("SELECT COUNT(*) FROM information_items i WHERE i.duplicate_of IS NULL "
                          "AND NOT EXISTS (SELECT 1 FROM item_topic_assignments t WHERE t.item_id = i.id)").fetchone()[0]
        vecs_7d = q("SELECT COUNT(*) FROM item_vectors WHERE vector_type = 'semantic-hash' "
                    "AND model_name = 'eagleye-hash-v1' AND created_at >= ?",
                    (rate_start_s,)).fetchone()[0]
        feats_7d = q("SELECT COUNT(*) FROM item_features WHERE updated_at >= ?",
                     (rate_start_s,)).fetchone()[0]
        ingest_7d = q("SELECT COUNT(*) FROM information_items WHERE created_at >= ?",
                      (rate_start_s,)).fetchone()[0]
        rows = q("SELECT i.created_at, v.created_at FROM information_items i "
                 "LEFT JOIN item_vectors v ON %s WHERE i.duplicate_of IS NULL AND i.created_at >= ?"
                 % HASH_VEC_ON, (win_start_s,)).fetchall()
        gear = latest_drain_gear(con)       # 伴随指标: 永不抛、缺源 → None
    finally:
        con.close()

    latencies = []
    censored = 0
    for item_ts, vec_ts in rows:
        it = parse_ts(item_ts)
        if it is None or it > min_age:      # 无入库时间或入库不足 6h → 不参评
            continue
        vt = parse_ts(vec_ts)
        if vt is None:                     # 无 semantic-hash 向量（或无时间戳）→ censored
            censored += 1
        else:
            latencies.append(max(0.0, (vt - it).total_seconds() / 3600.0))
    population = len(latencies) + censored
    p95 = pct95(latencies + [math.inf] * censored) if population else None

    rate_per_day = vecs_7d / float(RATE_WINDOW_H / 24)
    feats_rate_per_day = feats_7d / float(RATE_WINDOW_H / 24)
    # R3.1: 48h 追平 = features 与 embed 两 lane 都清零（取最慢 lane）。
    catchup_embed = catchup_hours(embed_pending, rate_per_day)
    catchup_features = lane_catchup_hours(extract_pending, feats_rate_per_day, TH_EXTRACT)
    catchup = combine_catchup(catchup_features, catchup_embed)

    load1 = read_load1()
    salon9 = salon9_count()

    fails = []
    if backlog >= TH_BACKLOG:
        fails.append("FAIL SLO_BACKLOG: BACKLOG=%d >= %d" % (backlog, TH_BACKLOG))
    if extract_pending >= TH_EXTRACT:
        fails.append("FAIL SLO_EXTRACT_PENDING: EXTRACT_PENDING=%d >= %d"
                     % (extract_pending, TH_EXTRACT))
    if topic_pending >= TH_TOPIC:
        fails.append("FAIL SLO_TOPIC_PENDING: TOPIC_PENDING=%d >= %d"
                     % (topic_pending, TH_TOPIC))
    if p95 is not None and p95 >= TH_P95_H:
        fails.append("FAIL SLO_P95_LATENCY: P95_LATENCY_H=%s >= %.1fh (censored %d/%d)"
                     % (fmt_h(p95), TH_P95_H, censored, population))
    if catchup is not None and catchup > TH_CATCHUP_H:
        fails.append("FAIL SLO_CATCHUP_48H: CATCHUP_H=%s > %.0fh (features=%s embed=%s)"
                     % (fmt_h(catchup), TH_CATCHUP_H, fmt_h(catchup_features),
                        fmt_h(catchup_embed)))
    if load1 is not None and load1 > TH_LOAD1:
        fails.append("FAIL SLO_LOAD1: LOAD1=%.2f > %.1f" % (load1, TH_LOAD1))

    print("SLO_BASELINE db=%s now=%s" % (DB_PATH, now.strftime("%Y-%m-%d %H:%M:%S")))
    print("META items=%d p95_window_h=%d p95_min_age_h=%d rate_window_h=%d"
          % (total_items, P95_WINDOW_H, P95_MIN_AGE_H, RATE_WINDOW_H))
    print("THRESHOLDS backlog<%d extract<%d topic<%d p95_h<%.1f catchup_h<=%.0f load1<=%.1f"
          % (TH_BACKLOG, TH_EXTRACT, TH_TOPIC, TH_P95_H, TH_CATCHUP_H, TH_LOAD1))
    print("BACKLOG=%d" % backlog)
    print("EMBED_PENDING=%d" % embed_pending)
    print("EXTRACT_PENDING=%d" % extract_pending)
    print("TOPIC_PENDING=%d" % topic_pending)
    print("P95_LATENCY_H=%s" % fmt_h(p95))
    print("P95_POPULATION=%d" % population)
    print("P95_CENSORED=%d" % censored)
    print("RATE_7D_PER_DAY=%.1f" % rate_per_day)
    print("RATE_FEATURES_7D_PER_DAY=%.1f" % feats_rate_per_day)
    print("INGEST_7D_PER_DAY=%.1f" % (ingest_7d / float(RATE_WINDOW_H / 24)))
    print("CATCHUP_FEATURES_H=%s" % fmt_h(catchup_features))
    print("CATCHUP_EMBED_H=%s" % fmt_h(catchup_embed))
    print("CATCHUP_H=%s" % fmt_h(catchup))
    # 伴随指标（Q4）: 每轮必出，只输出不判定（LOAD1 的判定在上面、口径不变）。
    print("LOAD1=%s" % ("NA" if load1 is None else "%.2f" % load1))
    print("GEAR=%s" % (gear if gear else "NA"))
    print("SALON9_COUNT=%s" % ("NA" if salon9 is None else "%d" % salon9))
    if p95 is None:
        print("NOTE p95_window_empty=1 (48h 内无可参评条目，P95 不判定)")
    if catchup is None:
        print("NOTE catchup_waived=1 (EXTRACT_PENDING <= %d and EMBED_PENDING <= %d)"
              % (TH_EXTRACT, TH_BACKLOG))
    for line in fails:
        print(line)
    if fails:
        print("RESULT=FAIL violations=%d" % len(fails))
        return 1
    print("RESULT=PASS violations=0")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # 测量错误 ≠ RED（退出码 2，不含 FAIL 断言行）
        sys.stderr.write("ERROR slo-baseline: %s: %r\n" % (type(exc).__name__, exc))
        sys.exit(2)
