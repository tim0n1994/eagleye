#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kg-cost-baseline.py — Eagleye R3.1 裁决 D（Q9）：KG 各泳道单条成本基准（可重复、只读、离线可测）。

用法:
    python3 scripts/kg-cost-baseline.py --help
    python3 scripts/kg-cost-baseline.py --db <sqlite> --dry-run [--limit N] [--json]
    python3 scripts/kg-cost-baseline.py --db /tmp/eagleye-r3-meas/eagleye.db        # 测量并追加台账

背景:
    Round 3 的成本数字来自一次性手测
    `/usr/bin/time -v nice -n 19 uv run --project kg-worker eagleye-kg --db <snapshot> extract|embed … --limit N`
    （/tmp/eagleye-r3-meas/*.time|*.out），日志删除后不可复跑。本脚本把同一类测量做成仓内可重复
    运行的基准：对积压条目跑**生产同款**纯计算路径并计时，输出确定性的 KEY=VALUE 行与行首标记。

测什么（每条积压 information_items；直接 import kg-worker/eagleye_kg 的生产函数，不复制算法，
以免基准与生产代码漂移）:
    embed    泳道: vectors.item_embedding_text → vectors.feature_terms(text.tokenize)
                   → vectors.hash_vector(blake2b, 256 维) + text.content_hash
                   （= vectors.embed_hash 单条热路径，去掉 DB 读写）
    features 泳道: text.tokenize → features.source_features / selection.feature_hash /
                   features.quality_score / tag_candidates / best_taxonomy / entity_candidates
                   + 写库前的 json.dumps（= features.extract_item 单条热路径，去掉 DB 读写）
    topics   泳道: 不测——topics.discover_topics 是跨条目聚类而非逐条纯函数；只报 pending_topics。
    cpu_s = time.process_time() 差值（本进程 user+sys），只计纯计算；读库耗时单列 load_s。
    注意: R3 手测含 sqlite 写入、uv/解释器启动与 nice 调度，不可与本 cpu_s 直接相减比较；
    本基准用于 **跨时间/跨提交** 比较同一口径的纯计算成本，以及估算清空积压的 CPU 量级。

样本与口径:
    sample = 在 embed 或 features 任一泳道积压的条目，ORDER BY i.id（确定性），--limit 截断
    （默认 2000；0 = 全部）。pending_* 口径与 scripts/slo-baseline.py 完全一致:
      pending_embed       无 (vector_type='semantic-hash', model_name='eagleye-hash-v1') 向量行
      pending_features    无 item_features 行
      pending_topics      无 item_topic_assignments 行
      backlog_any_vector  无任何 item_vectors 行（CTO 事实①的 BACKLOG 口径）
    drain_cpu_s_est = pending_<lane> × per_item_ms / 1000（清空该泳道积压所需纯计算 CPU 的估算）。
    sources / topic_taxonomy 表可缺（离线 fixture 只有 4 张表）：缺 sources 时 source_slug 取
    source_id；缺 taxonomy 时 best_taxonomy 以空分类表走回退分支（如实标注 taxonomy_rows=0）。

输出:
    KEY=VALUE 行（KG_COST_BASELINE / META / LANE / PROC / LOAD1 / NOTE），成功时倒数第二行为行首标记
        COST_BASELINE_OK items=<n> cpu_s=<x> wall_s=<y> per_item_ms=<z> lanes=embed,features
    （items = 本次实际测量的样本条数；cpu_s 为 embed+features 纯计算 CPU 秒，3 位小数）。
    设置 --max-per-item-ms 且超限时，标记改为 COST_BASELINE_RED …，并追加大写 FAIL 行；
    末行 RESULT=PASS violations=0 或 RESULT=FAIL violations=<k>。
退出码（沿 slo-baseline.py 语义）:
    0 = 测量成功且无违约; 1 = 阈值违约（RED，含 FAIL 行）;
    2 = 测量错误（库不存在/不可读/不是 sqlite/缺必需表/kg-worker 不可导入）→ stderr "ERROR …"，
        stdout 绝不出现 COST_BASELINE_OK（所有输出在测量完成后一次性打印）。
只读与副作用:
    file:…?mode=ro + PRAGMA query_only=1；不写库。rollback-journal 库（如测试 fixture）不留
    -wal/-shm/-journal；WAL 模式且当前无其他连接的库，只读连接按 SQLite 规则会创建 -shm 与 0 字节
    -wal（库内容不变；生产库在服务运行期间这两个文件本已存在，不会新增）。sys.dont_write_bytecode
    保证不在 kg-worker 下留 .pyc。--dry-run 不写任何文件；非 dry-run 仅向 --out 台账（JSONL）追加
    一行（默认 /tmp/eagleye-kg-cost-baseline.jsonl，env EAGLEYE_COST_BASELINE_OUT），绝不写库。
    夜间窗口（00:30-03:40）请只指向快照 /tmp/eagleye-r3-meas/eagleye.db 或离线 fixture——因此
    --db 为必填，无生产库默认值。
"""
import argparse
import json
import os
import platform
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

SCRIPT_VERSION = "r3.1-D-Q9.1"
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
DEFAULT_KG_WORKER = os.environ.get("EAGLEYE_KG_WORKER", str(REPO_ROOT / "kg-worker"))
DEFAULT_OUT = os.environ.get("EAGLEYE_COST_BASELINE_OUT", "/tmp/eagleye-kg-cost-baseline.jsonl")
DEFAULT_LIMIT = 2000
CHUNK_ROWS = 500          # 分块取行：内存有界，且读库耗时与纯计算耗时分开计
EMBED_MAX_CHARS = 1200    # vectors.embed_hash(max_chars=1200) 生产默认
LANES = ("embed", "features")

REQUIRED_TABLES = ("information_items", "item_vectors", "item_features", "item_topic_assignments")
HASH_VEC_ON = ("v.item_id = i.id AND v.vector_type = 'semantic-hash' "
               "AND v.model_name = 'eagleye-hash-v1'")   # 与 scripts/slo-baseline.py 同一常量
PENDING_EMBED = "NOT EXISTS (SELECT 1 FROM item_vectors v WHERE %s)" % HASH_VEC_ON
PENDING_FEATURES = "NOT EXISTS (SELECT 1 FROM item_features f WHERE f.item_id = i.id)"
PENDING_TOPICS = "NOT EXISTS (SELECT 1 FROM item_topic_assignments t WHERE t.item_id = i.id)"
BACKLOG_ANY_VECTOR = "NOT EXISTS (SELECT 1 FROM item_vectors v WHERE v.item_id = i.id)"
SAMPLE_COLUMNS = ("i.id, i.title, i.original_summary, i.content_text, i.canonical_url, "
                  "i.author, i.language, i.source_payload, i.normalized_payload, i.score")


class MeasurementError(Exception):
    """测量错误（rc=2）：库不可读 / 缺表 / kg-worker 不可导入。不是 RED。"""


class Parser(argparse.ArgumentParser):
    """用法错误也走统一的 `ERROR kg-cost-baseline:` 前缀 + rc=2。"""

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("ERROR kg-cost-baseline: %s\n" % message)
        sys.exit(2)


def build_parser():
    p = Parser(
        prog="kg-cost-baseline.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=(
            "Eagleye KG per-lane compute-cost baseline (repeatable, read-only, offline-testable).\n"
            "Imports the production kg-worker functions and times their pure-compute paths over\n"
            "pending information_items: embed lane (tokenize + blake2b hash vector + content hash)\n"
            "and features lane (tokenize / source rules / taxonomy match / entity candidates).\n"
            "Never writes to the database (mode=ro + query_only); --dry-run writes nothing at all."),
        epilog=(
            "marker (stdout, line-anchored):\n"
            "  COST_BASELINE_OK items=<n> cpu_s=<x> wall_s=<y> per_item_ms=<z> lanes=embed,features\n"
            "exit codes:\n"
            "  0  measured, no threshold violation\n"
            "  1  threshold violated (RED): FAIL line + RESULT=FAIL, marker becomes COST_BASELINE_RED\n"
            "  2  measurement error (db unreadable / not sqlite / missing table / kg-worker import):\n"
            "     stderr 'ERROR kg-cost-baseline: ...', no OK marker\n"
            "examples:\n"
            "  python3 scripts/kg-cost-baseline.py --db /tmp/eagleye-r3-meas/eagleye.db --dry-run\n"
            "  python3 scripts/kg-cost-baseline.py --db /tmp/eagleye-r3-meas/eagleye.db --limit 0 --json\n"
            "  python3 scripts/kg-cost-baseline.py --db fixture.db --dry-run --max-per-item-ms 5"))
    p.add_argument("--db", required=True, metavar="SQLITE",
                   help="sqlite database to measure, opened read-only (mode=ro). Required: no production "
                        "default on purpose; point at a snapshot or an offline fixture.")
    p.add_argument("--dry-run", action="store_true",
                   help="measure and print only; write nothing (no --out ledger append).")
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT, metavar="N",
                   help="sample cap: first N pending items ORDER BY id (0 = all pending). default %(default)s")
    p.add_argument("--out", default=DEFAULT_OUT, metavar="PATH",
                   help="JSONL ledger appended to when not --dry-run. default %(default)s "
                        "(env EAGLEYE_COST_BASELINE_OUT)")
    p.add_argument("--kg-worker", default=DEFAULT_KG_WORKER, metavar="DIR",
                   help="kg-worker directory whose eagleye_kg package is imported. default %(default)s "
                        "(env EAGLEYE_KG_WORKER)")
    p.add_argument("--max-per-item-ms", type=float, default=None, metavar="MS",
                   help="threshold on combined (embed+features) CPU ms per item; exceeding it is a FAIL "
                        "(rc 1). default: no threshold")
    p.add_argument("--nice", type=int, default=0, metavar="N",
                   help="os.nice increment before measuring (0 = unchanged; the R3 manual runs used 19)")
    p.add_argument("--json", action="store_true",
                   help="also print the full JSON record as one stdout line")
    return p


def import_kg_worker(kg_worker_dir):
    """import 生产 eagleye_kg（纯标准库包）；失败 → 测量错误。不落 .pyc。"""
    kgw = Path(kg_worker_dir).resolve()
    if not (kgw / "eagleye_kg" / "__init__.py").is_file():
        raise MeasurementError("kg-worker package not found: %s/eagleye_kg (set --kg-worker)" % kgw)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(kgw))
    try:
        from eagleye_kg import config, features, selection, text, vectors  # noqa: E402
    except Exception as exc:  # ImportError / SyntaxError / anything at import time
        raise MeasurementError("cannot import eagleye_kg from %s: %s: %s"
                               % (kgw, type(exc).__name__, exc))
    return {"path": str(kgw), "config": config, "features": features,
            "selection": selection, "text": text, "vectors": vectors}


def open_ro(path):
    """mode=ro 只读连接 + query_only 双保险（同 slo-baseline.py）。"""
    if not os.path.isfile(path):
        raise MeasurementError("db not found: %s" % path)
    if not os.access(path, os.R_OK):
        raise MeasurementError("db not readable: %s" % path)
    con = sqlite3.connect("file:%s?mode=ro" % quote(os.path.abspath(path)), uri=True, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA query_only=1")
    return con


def table_exists(con, name):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                       (name,)).fetchone() is not None


def count_items(con, where):
    return con.execute("SELECT COUNT(*) FROM information_items i WHERE %s" % where).fetchone()[0]


def git_head(repo):
    try:
        r = subprocess.run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
                           capture_output=True, text=True, timeout=5)
        return (r.stdout.strip() or "NA") if r.returncode == 0 else "NA"
    except Exception:
        return "NA"


def embed_cost(vectors, text, row):
    """= vectors.embed_hash 单条热路径去掉 DB：embedding 文本 → 词项 → 哈希向量 + 内容哈希。"""
    body = vectors.item_embedding_text(row, max_chars=EMBED_MAX_CHARS)
    terms = vectors.feature_terms(body)
    vector = vectors.hash_vector(terms)
    text.content_hash(row["title"], row["original_summary"], row["content_text"],
                      row["canonical_url"], vectors.HASH_VECTOR_MODEL, str(EMBED_MAX_CHARS))
    return len(terms), len(vector)


def features_cost(features, text, selection, row, taxonomy):
    """= features.extract_item 单条热路径去掉 DB：分词 / 规则特征 / 分类匹配 / 实体候选 / 序列化。"""
    body = "\n".join([row["title"] or "", row["original_summary"] or "", row["content_text"] or ""])
    keywords = text.tokenize(body)
    feats = features.source_features(row)
    selection.feature_hash(row)
    feats["extractor_version"] = features.EXTRACTOR_VERSION
    features.quality_score(row, keywords)
    title_tokens = text.tokenize(row["title"] or "")
    tags = features.tag_candidates(row, feats, keywords)
    topic_id, _relevance, _reason = features.best_taxonomy(row, keywords, taxonomy)
    entities = features.entity_candidates(row, feats)
    json.dumps(title_tokens, ensure_ascii=False)
    json.dumps(keywords, ensure_ascii=False)
    json.dumps(feats, ensure_ascii=False)
    return len(tags), len(entities), 1 if topic_id else 0


def f3(value):
    return "%.3f" % value


def per_item_ms(cpu_s, n):
    return (cpu_s / n) * 1000.0 if n > 0 else None


def fmt_opt(value, fmt="%.3f"):
    return "NA" if value is None else fmt % value


def est_drain(pending, pim):
    return None if pim is None else pending * pim / 1000.0


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.limit < 0:
        parser.error("--limit must be >= 0")
    try:
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

    notes = []
    if args.nice > 0:
        try:
            os.nice(args.nice)
        except OSError as exc:
            notes.append("nice_failed=1 (%s)" % exc)

    kgw = import_kg_worker(args.kg_worker)
    vectors, features, selection, text = kgw["vectors"], kgw["features"], kgw["selection"], kgw["text"]
    db_path = os.path.abspath(args.db)
    now_s = datetime.now(timezone.utc).replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")
    mode = "dry-run" if args.dry_run else "record"

    con = open_ro(db_path)
    try:
        missing = [t for t in REQUIRED_TABLES if not table_exists(con, t)]
        if missing:
            raise MeasurementError("schema: missing table(s) %s in %s" % (",".join(missing), db_path))
        has_sources = table_exists(con, "sources")
        has_taxonomy = table_exists(con, "topic_taxonomy")

        total_items = count_items(con, "1=1")
        pending_embed = count_items(con, PENDING_EMBED)
        pending_features = count_items(con, PENDING_FEATURES)
        pending_topics = count_items(con, PENDING_TOPICS)
        backlog_any_vector = count_items(con, BACKLOG_ANY_VECTOR)

        taxonomy = []
        if has_taxonomy:
            try:
                taxonomy = features.load_taxonomy(con)
            except sqlite3.Error as exc:
                notes.append("taxonomy_unreadable=1 (%s); best_taxonomy measured with empty taxonomy" % exc)
        else:
            notes.append("taxonomy_absent=1 (no topic_taxonomy table; best_taxonomy takes fallback branch)")
        if not has_sources:
            notes.append("sources_absent=1 (source_slug taken from information_items.source_id)")

        slug_expr = "COALESCE(s.slug, i.source_id, '')" if has_sources else "COALESCE(i.source_id, '')"
        join = "LEFT JOIN sources s ON s.id = i.source_id" if has_sources else ""
        sql = ("SELECT %s, %s AS source_slug FROM information_items i %s WHERE (%s) OR (%s) ORDER BY i.id"
               % (SAMPLE_COLUMNS, slug_expr, join, PENDING_EMBED, PENDING_FEATURES))
        params = ()
        if args.limit > 0:
            sql += " LIMIT ?"
            params = (args.limit,)

        sample_n = 0
        load_cpu = load_wall = 0.0
        emb_cpu = emb_wall = 0.0
        emb_terms = 0
        fea_cpu = fea_wall = 0.0
        fea_tags = fea_entities = fea_topics = 0

        cur = con.execute(sql, params)
        while True:
            c0, w0 = time.process_time(), time.perf_counter()
            rows = cur.fetchmany(CHUNK_ROWS)
            load_cpu += time.process_time() - c0
            load_wall += time.perf_counter() - w0
            if not rows:
                break
            sample_n += len(rows)

            c0, w0 = time.process_time(), time.perf_counter()
            for row in rows:
                n_terms, _dim = embed_cost(vectors, text, row)
                emb_terms += n_terms
            emb_cpu += time.process_time() - c0
            emb_wall += time.perf_counter() - w0

            c0, w0 = time.process_time(), time.perf_counter()
            for row in rows:
                n_tags, n_ent, n_topic = features_cost(features, text, selection, row, taxonomy)
                fea_tags += n_tags
                fea_entities += n_ent
                fea_topics += n_topic
            fea_cpu += time.process_time() - c0
            fea_wall += time.perf_counter() - w0
    finally:
        con.close()

    cpu_s = emb_cpu + fea_cpu
    wall_s = emb_wall + fea_wall
    pim_embed = per_item_ms(emb_cpu, sample_n)
    pim_features = per_item_ms(fea_cpu, sample_n)
    pim_total = per_item_ms(cpu_s, sample_n)
    drain_embed = est_drain(pending_embed, pim_embed)
    drain_features = est_drain(pending_features, pim_features)
    proc_cpu_s = time.process_time()
    try:
        import resource
        maxrss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if sys.platform == "darwin":
            maxrss_kb //= 1024
    except Exception:
        maxrss_kb = None
    try:
        load1 = os.getloadavg()[0]
    except (OSError, AttributeError):
        load1 = None
    if sample_n == 0:
        notes.append("sample_empty=1 (nothing pending in embed/features; per_item_ms=NA)")

    violations = []
    if args.max_per_item_ms is not None and pim_total is not None and pim_total > args.max_per_item_ms:
        violations.append("FAIL COST_PER_ITEM: per_item_ms=%s > %g (embed=%s features=%s, sample=%d)"
                          % (f3(pim_total), args.max_per_item_ms, fmt_opt(pim_embed),
                             fmt_opt(pim_features), sample_n))
    result = "FAIL" if violations else "PASS"

    record = {
        "schema": "eagleye.kg-cost-baseline/1",
        "script_version": SCRIPT_VERSION,
        "ts_utc": now_s,
        "db": db_path,
        "mode": mode,
        "git_head": git_head(REPO_ROOT),
        "python": platform.python_version(),
        "kg_worker": kgw["path"],
        "extractor_version": kgw["config"].EXTRACTOR_VERSION,
        "hash_model": vectors.HASH_VECTOR_MODEL,
        "hash_dim": vectors.HASH_VECTOR_DIM,
        "embed_max_chars": EMBED_MAX_CHARS,
        "total_items": total_items,
        "pending": {"embed": pending_embed, "features": pending_features,
                    "topics": pending_topics, "any_vector_backlog": backlog_any_vector},
        "sample": sample_n,
        "limit": args.limit,
        "chunk_rows": CHUNK_ROWS,
        "load_cpu_s": round(load_cpu, 6),
        "load_wall_s": round(load_wall, 6),
        "lanes": {
            "embed": {"items": sample_n, "cpu_s": round(emb_cpu, 6), "wall_s": round(emb_wall, 6),
                      "per_item_ms": None if pim_embed is None else round(pim_embed, 6),
                      "terms_total": emb_terms,
                      "drain_cpu_s_est": None if drain_embed is None else round(drain_embed, 3)},
            "features": {"items": sample_n, "cpu_s": round(fea_cpu, 6), "wall_s": round(fea_wall, 6),
                         "per_item_ms": None if pim_features is None else round(pim_features, 6),
                         "tags_total": fea_tags, "entities_total": fea_entities,
                         "taxonomy_hits": fea_topics, "taxonomy_rows": len(taxonomy),
                         "drain_cpu_s_est": None if drain_features is None else round(drain_features, 3)},
            "topics": {"measured": False, "pending": pending_topics,
                       "reason": "discover_topics is cross-item clustering, not a per-item pure function"},
        },
        "cpu_s": round(cpu_s, 6),
        "wall_s": round(wall_s, 6),
        "per_item_ms": None if pim_total is None else round(pim_total, 6),
        "proc_cpu_s": round(proc_cpu_s, 6),
        "maxrss_kb": maxrss_kb,
        "load1": None if load1 is None else round(load1, 2),
        "nice": args.nice,
        "threshold_max_per_item_ms": args.max_per_item_ms,
        "violations": violations,
        "result": result,
        "notes": notes,
    }

    lines = [
        "KG_COST_BASELINE db=%s mode=%s now=%s script=%s git_head=%s python=%s kg_worker=%s "
        "extractor_version=%s hash_model=%s dim=%d"
        % (db_path, mode, now_s, SCRIPT_VERSION, record["git_head"], record["python"], kgw["path"],
           record["extractor_version"], record["hash_model"], record["hash_dim"]),
        "META total_items=%d pending_embed=%d pending_features=%d pending_topics=%d backlog_any_vector=%d "
        "sample=%d limit=%s chunk=%d load_s=%s load_cpu_s=%s"
        % (total_items, pending_embed, pending_features, pending_topics, backlog_any_vector,
           sample_n, "all" if args.limit == 0 else str(args.limit), CHUNK_ROWS, f3(load_wall), f3(load_cpu)),
        "LANE embed items=%d cpu_s=%s wall_s=%s per_item_ms=%s terms_total=%d drain_cpu_s_est=%s"
        % (sample_n, f3(emb_cpu), f3(emb_wall), fmt_opt(pim_embed), emb_terms, fmt_opt(drain_embed, "%.1f")),
        "LANE features items=%d cpu_s=%s wall_s=%s per_item_ms=%s tags_total=%d entities_total=%d "
        "taxonomy_hits=%d taxonomy_rows=%d drain_cpu_s_est=%s"
        % (sample_n, f3(fea_cpu), f3(fea_wall), fmt_opt(pim_features), fea_tags, fea_entities,
           fea_topics, len(taxonomy), fmt_opt(drain_features, "%.1f")),
        "LANE topics items=0 cpu_s=NA measured=0 pending=%d (cross-item clustering; not a per-item cost)"
        % pending_topics,
        "PROC cpu_s=%s maxrss_kb=%s nice=%d" % (f3(proc_cpu_s), fmt_opt(maxrss_kb, "%d"), args.nice),
        "LOAD1=%s" % fmt_opt(load1, "%.2f"),
    ]
    lines.extend("NOTE %s" % n for n in notes)
    if args.json:
        lines.append(json.dumps(record, ensure_ascii=True, sort_keys=True))
    lines.extend(violations)
    marker = "COST_BASELINE_OK" if not violations else "COST_BASELINE_RED"
    lines.append("%s items=%d cpu_s=%s wall_s=%s per_item_ms=%s lanes=%s"
                 % (marker, sample_n, f3(cpu_s), f3(wall_s), fmt_opt(pim_total), ",".join(LANES)))

    if not args.dry_run:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        lines.append("RECORDED out=%s" % out)
    else:
        lines.append("NOTE dry_run=1 (nothing written)")
    lines.append("RESULT=%s violations=%d" % (result, len(violations)))

    # 一次性输出：测量错误发生时不会留下半截输出（尤其不会出现 OK 标记）。
    sys.stdout.write("\n".join(lines) + "\n")
    sys.stdout.flush()
    return 1 if violations else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.stderr.write("ERROR kg-cost-baseline: interrupted\n")
        sys.exit(130)
    except Exception as exc:  # 测量错误 ≠ RED：rc=2，stderr ERROR，stdout 无 OK 标记
        sys.stderr.write("ERROR kg-cost-baseline: %s: %s\n" % (type(exc).__name__, exc))
        sys.exit(2)
