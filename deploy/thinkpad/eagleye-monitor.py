#!/usr/bin/env python3
"""Bounded, read-only Eagleye checks. No backup, ingestion, or remediation."""
import argparse
import ast
from contextlib import closing
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import urllib.parse
import urllib.request

UTC = dt.timezone.utc
TIMERS = ("argus-eagleye-drain.timer", "argus-eagleye-outbox-drain.timer",
          "argus-eagleye-kg-drain.timer", "argus-eagleye-x-following.timer")
KG_SQL = """
SELECT COUNT(*) FROM information_items i JOIN sources s ON s.id=i.source_id
WHERE s.is_active=1 AND i.duplicate_of IS NULL AND (
 NOT EXISTS(SELECT 1 FROM item_features f WHERE f.item_id=i.id) OR
 NOT EXISTS(SELECT 1 FROM item_vectors v WHERE v.item_id=i.id
   AND v.vector_type='semantic-hash' AND v.model_name='eagleye-hash-v1') OR
 NOT EXISTS(SELECT 1 FROM item_vectors v WHERE v.item_id=i.id
   AND v.vector_type='semantic-lite' AND v.model_name='eagleye-hash-v1') OR
 NOT EXISTS(SELECT 1 FROM item_topic_assignments a WHERE a.item_id=i.id
   AND a.topic_kind='dynamic'))
"""


def epoch(value):
    if not value:
        return 0
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=UTC).timestamp() if parsed.tzinfo is None else parsed.timestamp()


def pipeline_stage_metrics(result):
    stages = (result or {}).get("stages") or []
    failed_stages = (result or {}).get("failed_stages") or []
    degraded = []
    for stage in stages:
        if stage.get("status") != "degraded":
            continue
        detail = stage.get("detail") or {}
        degraded.append({
            "stage": stage.get("key") or stage.get("label") or "unknown",
            "warning": detail.get("warning") or detail.get("error") or "",
        })
    return {
        # Degraded is an accepted terminal state for partial source/translation
        # failures. It stays separate from failed_stages so visibility does not
        # turn a deliberately resumed pipeline into a false completion alarm.
        "pipeline_stages_complete": bool(stages) and all(
            stage.get("status") in ("completed", "skipped", "degraded") for stage in stages),
        "pipeline_failed_stages": len(failed_stages),
        "pipeline_degraded_stages": degraded,
    }


def pipeline_degraded_warnings(metrics):
    warnings = []
    for item in metrics.get("pipeline_degraded_stages") or []:
        warning = item.get("warning")
        text = "pipeline_degraded:" + str(item.get("stage") or "unknown")
        if warning:
            text += ": " + str(warning)
        warnings.append(text)
    return warnings


def config(path):
    result = {}
    for node in ast.parse(Path(path).read_text()).body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in ("DB", "BASE", "VALID", "THRESHOLD"):
                    result[target.id] = ast.literal_eval(node.value)
    if set(result) != {"DB", "BASE", "VALID", "THRESHOLD"}:
        raise ValueError("Missing drainer constants")
    return result


def connect_ro(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    deadline = time.monotonic() + 25
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    return db


def unit_property(unit, prop):
    result = subprocess.run(["systemctl", "--user", "show", unit, "--property=" + prop,
                             "--value"], capture_output=True, text=True, timeout=8, check=True)
    return result.stdout.strip()


def health(base, key):
    request = urllib.request.Request(base.rstrip("/") + "/api/health",
                                     headers={"Authorization": "Bearer " + key})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=12) as response:
        data = json.load(response)
        return response.status == 200 and data.get("status") == "ok" and data.get("database") == "connected"


def database_metrics(db, valid):
    def count(sql):
        return db.execute(sql).fetchone()[0]
    metrics = {
        "items_total": count("SELECT COUNT(*) FROM information_items"),
        "latest_item": count("SELECT MAX(created_at) FROM information_items"),
        "items_24h": count("SELECT COUNT(*) FROM information_items WHERE created_at>=datetime('now','-24 hours')"),
        "valid_items_24h": count("SELECT COUNT(*) FROM information_items i WHERE i.created_at>=datetime('now','-24 hours') "
                                "AND EXISTS(SELECT 1 FROM ai_summaries s WHERE s.item_id=i.id AND " + valid + ")"),
        "summaries_total": count("SELECT COUNT(*) FROM ai_summaries s WHERE " + valid),
        "enrich_pending": count("SELECT COUNT(*) FROM information_items i WHERE COALESCE(i.enrichment_attempts,0)<3 "
                                "AND NOT EXISTS(SELECT 1 FROM ai_summaries s WHERE s.item_id=i.id AND " + valid + ")"),
        "enrich_exhausted_24h": count("SELECT COUNT(*) FROM information_items i WHERE i.created_at>=datetime('now','-24 hours') "
                                    "AND COALESCE(i.enrichment_attempts,0)>=3 AND NOT EXISTS"
                                    "(SELECT 1 FROM ai_summaries s WHERE s.item_id=i.id AND " + valid + ")"),
        "outbox_pending": count("SELECT COUNT(*) FROM outbox WHERE dispatched_at IS NULL"),
        "outbox_oldest": count("SELECT MIN(created_at) FROM outbox WHERE dispatched_at IS NULL"),
        "kg_pending": count(KG_SQL),
        "active_jobs": count("SELECT COUNT(*) FROM background_jobs WHERE status IN ('running','queued','pending')"),
        "jobs_stuck_6h": count("SELECT COUNT(*) FROM background_jobs WHERE status IN ('running','queued','pending') "
                               "AND COALESCE(started_at,created_at)<datetime('now','-6 hours')"),
    }
    row = db.execute("SELECT completed_at,result FROM background_jobs WHERE job_type='full-pipeline' "
                     "AND status='completed' ORDER BY completed_at DESC LIMIT 1").fetchone()
    metrics["pipeline_completed_at"] = row["completed_at"] if row else None
    result = json.loads(row["result"] or "{}") if row else {}
    metrics.update(pipeline_stage_metrics(result))
    row = db.execute("SELECT MAX(completed_at) FROM background_jobs "
                     "WHERE job_type='full-pipeline' AND status='failed'").fetchone()
    metrics["pipeline_failed_at"] = row[0]
    row = db.execute("SELECT value FROM user_data WHERE key='scheduler_config' AND user_id=''").fetchone()
    schedule = json.loads(row[0] or "{}") if row else {}
    metrics["scheduler_enabled"] = schedule.get("enabled", False)
    metrics["scheduler_task"] = schedule.get("task", "pipeline")
    metrics["digest_completed_at"] = count("SELECT MAX(completed_at) FROM background_jobs "
                                           "WHERE job_type='build-digest' AND status='completed'")
    metrics["collection_errors"] = [dict(r) for r in db.execute(
        "SELECT slug,last_error_class FROM sources WHERE is_active=1 AND last_error_class IS NOT NULL")]
    metrics["collection_overdue"] = [r[0] for r in db.execute(
        "SELECT s.slug FROM sources s LEFT JOIN source_collection_state c ON c.slug=s.slug "
        "WHERE s.is_active=1 AND s.slug!='x-following' AND "
        "(c.slug IS NULL OR datetime(c.next_due_at)<datetime('now','-2 hours'))")]
    metrics["sources"] = {r["slug"]: {"active": bool(r["is_active"]),
                                     "last_success": r["last_success_at"]}
                          for r in db.execute("SELECT slug,is_active,last_success_at FROM sources "
                                              "WHERE slug IN ('reddit','x-following')")}
    row = db.execute("SELECT result FROM background_jobs WHERE job_type='enrich-items' "
                     "AND status='completed' ORDER BY completed_at DESC LIMIT 1").fetchone()
    result = json.loads(row[0] or "{}") if row else {}
    metrics["last_enrich"] = {key: result.get(key) for key in ("enriched", "failed", "deferred", "total")}
    return metrics


def collect(cfg):
    metrics, faults = {}, []
    for unit in ("argus-eagleye.service",) + TIMERS:
        try:
            if unit_property(unit, "ActiveState") != "active":
                faults.append("inactive:" + unit)
        except Exception:
            faults.append("unknown:" + unit)
    try:
        if unit_property("eagleye-snapshot.timer", "UnitFileState") != "masked":
            faults.append("snapshot_not_masked")
        if unit_property("eagleye-snapshot.timer", "ActiveState") != "inactive":
            faults.append("snapshot_timer_active")
    except Exception:
        faults.append("snapshot_state_unknown")
    metrics["free_gib"] = round(shutil.disk_usage(Path(cfg["DB"]).parent).free / 2**30, 2)
    with closing(connect_ro(cfg["DB"])) as db:
        try:
            key = db.execute("SELECT k.key FROM api_keys k JOIN users u ON u.id=k.user_id "
                             "WHERE k.active=1 AND u.status='active' AND u.role='admin' "
                             "AND (k.expires_at IS NULL OR datetime(k.expires_at)>datetime('now')) LIMIT 1").fetchone()
            if not key or not health(cfg["BASE"], key[0]):
                faults.append("authenticated_health_failed")
        except Exception:
            faults.append("authenticated_health_failed")
        metrics.update(database_metrics(db, cfg["VALID"]))
    pid = int(unit_property("argus-eagleye.service", "MainPID") or 0)
    # Read only the scheduling flag from the running service, never emit its environment.
    environment = Path("/proc", str(pid), "environ").read_bytes().split(b"\0") if pid else []
    metrics["independent_collection"] = b"COLLECTION_SCHEDULE_ENABLED=1" in environment
    return metrics, faults


def evaluate(metrics, previous, now, fire_floor):
    issues, progress = [], {}
    def age(value):
        return now - epoch(value)
    if metrics["free_gib"] < 10:
        issues.append("disk_free_below_10gib")
    independent = metrics.get("independent_collection", False)
    if independent:
        if not metrics.get("scheduler_enabled"):
            issues.append("collection_scheduler_disabled")
        issues.extend("collection_overdue:" + slug for slug in metrics.get("collection_overdue", []))
        issues.extend("source_error:" + row["slug"] + ":" + row["last_error_class"]
                      for row in metrics.get("collection_errors", []))
        if metrics.get("scheduler_task") == "digest" and age(metrics.get("digest_completed_at")) > 36 * 3600:
            issues.append("digest_no_completion_36h")
    if not independent or metrics.get("scheduler_task") == "pipeline":
        if age(metrics["pipeline_completed_at"]) > 36 * 3600:
            issues.append("pipeline_no_completion_36h")
        if not metrics["pipeline_stages_complete"] or metrics["pipeline_failed_stages"]:
            issues.append("pipeline_incomplete")
        if epoch(metrics["pipeline_failed_at"]) > epoch(metrics["pipeline_completed_at"]) and not metrics["active_jobs"]:
            issues.append("pipeline_failed_without_successful_resume")
    if age(metrics["latest_item"]) > 48 * 3600:
        issues.append("no_new_items_48h")
    if metrics["outbox_pending"] and age(metrics["outbox_oldest"]) > 2 * 3600:
        issues.append("outbox_undispatched_2h")
    if metrics["jobs_stuck_6h"]:
        issues.append("jobs_stuck_6h")
    for slug in ("reddit", "x-following"):
        source = metrics["sources"].get(slug)
        if not source:
            issues.append("source_missing:" + slug)
        elif source["active"] and age(source["last_success"]) > 48 * 3600:
            issues.append("source_no_success_48h:" + slug)
    old_metrics = previous.get("metrics", {})
    for kind, floor in (("enrich", fire_floor), ("kg", 200)):
        pending = metrics[kind + "_pending"]
        old_pending = old_metrics.get(kind + "_pending", pending)
        last_progress = previous.get("progress", {}).get(kind, now)
        if pending < floor or pending < old_pending:
            last_progress = now
        if kind == "enrich" and metrics["summaries_total"] > old_metrics.get("summaries_total", metrics["summaries_total"]):
            last_progress = now
        progress[kind] = last_progress
        if pending >= floor and now - last_progress >= 6 * 3600:
            issues.append(kind + "_backlog_stalled_6h")
    return issues, progress


def persist(directory, state, previous):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    encoded = json.dumps(state, ensure_ascii=False, sort_keys=True)
    if len(encoded.encode()) + 1 > 65536:
        raise ValueError("State exceeds size limit")
    temporary = directory / "latest.tmp"
    temporary.write_text(encoded + "\n")
    temporary.replace(directory / "latest.json")
    old, new = set(previous.get("issues", [])), set(state["issues"])
    if old == new:
        return None
    event = {"at": state["checked_at"], "new_issues": sorted(new-old),
             "resolved_issues": sorted(old-new), "issues": sorted(new)}
    record = json.dumps(event, ensure_ascii=False) + "\n"
    log = directory / "changes.jsonl"
    if log.exists() and log.stat().st_size + len(record.encode()) > 65536:
        log.replace(directory / "changes.previous.jsonl")
    with log.open("a") as output:
        output.write(record)
    return event


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--drainer", default=str(Path.home() / ".local/bin/eagleye-drain.py"))
    parser.add_argument("--state-dir", default=str(Path.home() / ".local/state/eagleye-monitor"))
    parser.add_argument("--print-status", action="store_true")
    args = parser.parse_args()
    directory = Path(args.state_dir)
    previous, issues, metrics, progress = {}, [], {}, {}
    warnings = []
    path = directory / "latest.json"
    if path.exists():
        try:
            if path.stat().st_size > 65536:
                raise ValueError("Oversized state")
            previous = json.loads(path.read_text())
            if not isinstance(previous, dict):
                raise ValueError("Invalid state")
            if not isinstance(previous.get("metrics", {}), dict) or not isinstance(previous.get("progress", {}), dict):
                raise ValueError("Invalid metrics or progress")
            if not isinstance(previous.get("issues", []), list) or not all(isinstance(x, str) for x in previous.get("issues", [])):
                raise ValueError("Invalid issues")
        except Exception:
            previous = {}
            issues.append("monitor_state_unreadable")
    progress = previous.get("progress", {}) if isinstance(previous.get("progress", {}), dict) else {}
    now = time.time()
    try:
        cfg = config(args.drainer)
        metrics, faults = collect(cfg)
        issues.extend(faults)
        if not metrics.get("independent_collection") or metrics.get("scheduler_task") == "pipeline":
            warnings.extend(pipeline_degraded_warnings(metrics))
        derived, progress = evaluate(metrics, previous, now, cfg["THRESHOLD"])
        issues.extend(derived)
    except Exception as error:
        # Never expose exceptions containing a URL, API key or database content.
        issues.append("monitor_check_failed:" + type(error).__name__)
    state = {"checked_at": dt.datetime.fromtimestamp(now, UTC).isoformat(),
             "issues": sorted(set(issues)), "warnings": warnings,
             "metrics": metrics, "progress": progress}
    try:
        event = persist(directory, state, previous)
    except Exception as error:
        # A failed state disk must still produce a visible, sanitized failure.
        print(json.dumps({"checked_at": state["checked_at"],
                          "issues": sorted(set(issues + ["monitor_state_write_failed:" + type(error).__name__]))}))
        return 1
    if args.print_status:
        print(json.dumps(state, ensure_ascii=False))
    elif event:
        print(json.dumps(event, ensure_ascii=False))
    return 1 if issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
