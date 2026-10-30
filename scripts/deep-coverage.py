#!/usr/bin/env python3
"""Eagleye Round 2 — deep following-feed coverage measurement (READ-ONLY, no DB).

Follow-up to scripts/shadow-coverage.py, per CTO retrospective: the previous
single 200-item feed pull only densely covered the most recent 1-2h, so a
direct 24h baseline comparison was invalid (measured 0%).

Findings baked into this version (all measured this session):
  - `twitter feed -t following -n 3000 --json` returns 200 items in 11.5s —
    the CLI caps per-call items at rateLimit.maxCount (default 200;
    client.py:148) with absolute cap 500 (client.py:72 _ABSOLUTE_MAX_COUNT).
  - With a temp-CWD config.yaml {rateLimit: {maxCount: 500}}, `-n 500`
    returns 500 items in 18.6s (feed-n500-max.json) — the deepest single
    call the CLI can make. -n 3000 is unreachable; single-call 24h coverage
    is impossible → incremental cadence is the only viable feed path.
  - 6 of the 7 "error" accounts from last round have VALID payloads in their
    saved raw files (ok=true, 40 items) — the previous runner discarded them
    on exit-code-1 (non-fatal ClientTransaction warning on stderr). Only
    zhijianliu_ truly failed; --refetch-errors re-pulls just that one.

Method (fixed window, fixed sample — same as previous round):
  window [2026-10-19T13:16:13.688033Z, 2026-10-20T13:16:13.688033Z],
  30 accounts sampled with seed 20261020 from config/x-following.txt.
  Baseline = union of per-account user-posts canonical URLs in-window
  (parity with shadow-coverage.py: match key '<lower handle>/status/<id>').

Coverage models (all numbers printed with constant prefixes):
  DIRECT       |baseline ∩ snapshot_window_keys| / |baseline| — single-pull
               lower bound; the snapshot's oldest item is an injected/pinned
               2024 tweet, so raw oldest-age does NOT mean 24h reach.
  REPLAY       cadence simulation by replaying per-pull budgets over the
               single 500-item snapshot (pull at t captures first n snapshot
               items with ts <= t). Lower bound only: the snapshot itself
               cannot see tweets ranked out before 14:16.
  CADENCE      density-bounded catch model (primary): for each cadence
               interval, a baseline tweet is caught if (a) it is in the
               snapshot (rank survived >=1h past window end — assumption R1:
               rank positions only worsen with age), or (b) it is
               timeline-eligible (not a reply) and the per-pull budget n
               covers the observed max rolling cadence-window load L_c
               (assumption R2: load bound from the snapshot histogram;
               p = min(1, n / (L_c + margin))). Replies (leading @mention)
               are treated as never shown by the following timeline.
  CURSOR       design warning: rank position of ancient (<7d) items in the
               snapshot order — pure "page until cursor" stops would truncate
               pulls early if pinned/ancient items rank above fresh content.
  RT_OFF       feed-side RTs excluded (X_FOLLOWING_INCLUDE_RT default off).

Usage:
  python3 scripts/deep-coverage.py --selftest
  python3 scripts/deep-coverage.py --refetch-errors   # only truly-missing accounts, <=35 calls
  python3 scripts/deep-coverage.py --analyze          # zero CLI calls
"""

import argparse
import datetime as dt
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# ── Constants (fixed for reproducibility) ──────────────────────────────────
SEED = 20261020                # same sample as previous round
SAMPLE_N = 30
WINDOW_H = 24
WINDOW_END_ISO = "2026-10-20T13:16:13.688033+00:00"   # /tmp/shadow-coverage-run.out WINDOW line
RAW_DIR = "/tmp/shadow-coverage-raw-1792502162"
DEEP_FEED = RAW_DIR + "/feed-n500-max.json"           # 500 items, maxCount config
DEEP_N3000 = RAW_DIR + "/feed-n3000.json"             # 200 items (default cap)
DEEP_REQUESTED = 500                                   # CLI absolute max (client.py:72)

CADENCES_H = [1, 2]
N_CHOICES = [200, 500]        # 200 = default cap, 500 = config-raised absolute cap
INJECTION_MARGIN = 15         # sparse old/pinned items ranked into any pull
COVERAGE_GATE_PCT = 95.0
ANCIENT_CUTOFF_DAYS = 7

UP_N = 40                      # per-account depth == connector max
INTERCALL_SLEEP_S = 5.0
RETRY_BACKOFF_S = [20, 60]
SUBPROCESS_TIMEOUT_S = 300
UP_CALL_BUDGET = 35

ARGUS_CONFIG_DIR = Path.home() / ".config" / "argus"
ENV_FILES = [
    ARGUS_CONFIG_DIR / "independent.env",
    ARGUS_CONFIG_DIR / "eagleye-twitter.credentials",
]

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "config" / "x-following.txt"
STATUS_RE = re.compile(r"^https?://(?:x|twitter)\.com/([A-Za-z0-9_]+)/status/(\d+)")
MENTION_RE = re.compile(r"^@[A-Za-z0-9_]+\s")


# ── Shared pure helpers (parity with shadow-coverage.py) ───────────────────
def load_env_files(paths, environ):
    for path in paths:
        p = Path(path)
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key == "PATH" or key in environ:
                continue
            environ[key] = val


def parse_iso(ts):
    if not ts:
        return None
    try:
        d = dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return d.replace(tzinfo=dt.timezone.utc) if d.tzinfo is None else d
    except ValueError:
        return None


def canonical_url(item, fallback_handle=""):
    handle = ((item or {}).get("author") or {}).get("screenName") or fallback_handle
    tid = str((item or {}).get("id") or "")
    return f"https://x.com/{handle}/status/{tid}" if tid else ""


def match_key(url):
    m = STATUS_RE.match(url or "")
    if m:
        return f"{m.group(1).lower()}/status/{m.group(2)}"
    return (url or "").lower().rstrip("/") or None


def item_key(item, fallback_handle=""):
    return match_key(canonical_url(item, fallback_handle))


def in_window(ts, ws, we):
    return ts is not None and ws <= ts <= we


def coverage(baseline, feed):
    matched = len(baseline & feed)
    pct = (100.0 * matched / len(baseline)) if baseline else None
    return matched, len(baseline), pct


def load_accounts(path):
    handles = []
    for line in Path(path).read_text().splitlines():
        s = line.strip().lstrip("@")
        if s and not s.startswith("#"):
            handles.append(s)
    return handles


def is_reply_item(item):
    """Leading @-mention ≈ reply (user-posts has no explicit reply field)."""
    return bool(MENTION_RE.match((item.get("text") or "").lstrip()))


def load_up_payload(raw_dir, idx, handle):
    """Return (items, source_tag). Prefer .retry.json over the original dump.

    Unlike the previous round's runner, a saved payload with ok=true and a
    data list is used EVEN IF the original process exited 1 (non-fatal
    ClientTransaction warning on stderr; data on stdout was valid).
    """
    for suffix, tag in [(".retry.json", "retry"), (".json", "orig")]:
        f = Path(raw_dir) / f"up-{idx:02d}-{handle}{suffix}"
        if not f.exists():
            continue
        try:
            env = json.loads(f.read_text())
        except json.JSONDecodeError:
            continue
        if env.get("ok") is True and isinstance(env.get("data"), list):
            return [x for x in env["data"] if isinstance(x, dict)], tag
    return None, "missing_or_invalid"


# ── Simulation helpers ──────────────────────────────────────────────────────
def pull_times(window_end, cadence_h):
    k = WINDOW_H // cadence_h
    return [window_end - dt.timedelta(hours=cadence_h * i) for i in range(k)]


def sim_budget_pull(ordered, t, n):
    """First n snapshot entries (snapshot order) with ts <= t."""
    out = []
    for e in ordered:
        if e["ts"] is not None and e["ts"] <= t:
            out.append(e)
            if len(out) >= n:
                break
    return out


def rolling_max_load(hist_by_hour, cadence_h):
    """Max items observed in any consecutive cadence_h hour buckets."""
    hours = sorted(hist_by_hour)
    best = 0
    for i, h in enumerate(hours):
        s = 0
        for j in range(i, min(i + cadence_h, len(hours))):
            s += hist_by_hour[hours[j]]
        best = max(best, s)
    return best


def hour_bucket(ts):
    return ts.replace(minute=0, second=0, microsecond=0)


# ── Selftest (pure functions only, zero CLI calls) ─────────────────────────
def selftest():
    we = dt.datetime(2026, 10, 20, 13, 0, tzinfo=dt.timezone.utc)

    pt = pull_times(we, 2)
    assert len(pt) == 12 and pt[0] == we and pt[-1] == we - dt.timedelta(hours=22), pt
    assert len(pull_times(we, 1)) == 24

    k1 = match_key("https://x.com/HeMuyu0327/status/123")
    k2 = match_key("https://twitter.com/hemuyu0327/status/123")
    assert k1 == k2 == "hemuyu0327/status/123"
    assert canonical_url({"id": "7"}, fallback_handle="cfg") == "https://x.com/cfg/status/7"

    snap = [
        {"ts": we - dt.timedelta(minutes=5), "key": "d/1"},
        {"ts": we - dt.timedelta(minutes=10), "key": "a/1"},
        {"ts": we - dt.timedelta(hours=3), "key": "old/1"},
        {"ts": we - dt.timedelta(minutes=100), "key": "b/1"},
    ]
    assert {x["key"] for x in sim_budget_pull(snap, we, 2)} == {"d/1", "a/1"}
    assert {x["key"] for x in sim_budget_pull(snap, we - dt.timedelta(hours=2), 2)} == {"old/1"}
    assert {x["key"] for x in sim_budget_pull(snap, we, 4)} == {"d/1", "a/1", "old/1", "b/1"}

    hist = {we - dt.timedelta(hours=h): 5 + h for h in range(24)}  # 5..28 per hour
    assert rolling_max_load(hist, 1) == 28
    assert rolling_max_load(hist, 2) == 28 + 27, rolling_max_load(hist, 2)

    assert is_reply_item({"text": "@stateofai @arakharazian Join us"}) is True
    assert is_reply_item({"text": "hello world"}) is False
    assert is_reply_item({"text": "  @lead hi"}) is True

    m, n, pct = coverage({"a/1", "b/1"}, {"a/1"})
    assert (m, n, pct) == (1, 2, 50.0)

    accs = load_accounts(CONFIG_PATH) if CONFIG_PATH.exists() else [f"h{i}" for i in range(442)]
    s1 = random.Random(SEED).sample(accs, SAMPLE_N)
    s2 = random.Random(SEED).sample(accs, SAMPLE_N)
    assert s1 == s2 and len(set(s1)) == SAMPLE_N

    print("SELFTEST OK")
    return 0


# ── --refetch-errors: re-pull only truly-missing accounts ──────────────────
def refetch_errors():
    accounts = load_accounts(CONFIG_PATH)
    sample = random.Random(SEED).sample(accounts, SAMPLE_N)
    raw_dir = Path(RAW_DIR)

    environ = dict(os.environ)
    environ["PATH"] = str(Path.home() / ".local" / "bin") + os.pathsep + environ.get("PATH", "")
    load_env_files(ENV_FILES, environ)
    if not environ.get("TWITTER_AUTH_TOKEN") or not environ.get("TWITTER_CT0"):
        print("FATAL: credentials not loaded")
        return 2
    cli_bin = shutil.which("twitter", path=environ.get("PATH", "")) or shutil.which("twitter")

    todo, calls, ok_n, fail_n = [], 0, 0, 0
    for i, h in enumerate(sample, 1):
        items, tag = load_up_payload(raw_dir, i, h)
        if items is None:
            todo.append((i, h, tag))
    print(f"PLAN refetch_accounts={len(todo)} budget={UP_CALL_BUDGET} "
          f"reasons={sorted({t for _, _, t in todo})}", flush=True)

    for i, h, tag in todo:
        if calls >= UP_CALL_BUDGET:
            print(f"REFETCH_BUDGET_STOP used={calls}", flush=True)
            break
        time.sleep(INTERCALL_SLEEP_S)
        done = False
        for attempt in range(1, 2 + len(RETRY_BACKOFF_S)):
            calls += 1
            t0 = time.monotonic()
            proc = subprocess.run(
                [cli_bin, "user-posts", f"@{h}", "-n", str(UP_N), "--json"],
                capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S, env=environ,
            )
            dur = time.monotonic() - t0
            ok, n_items = False, 0
            if proc.returncode == 0:
                try:
                    env = json.loads(proc.stdout)
                    if env.get("ok") is True and isinstance(env.get("data"), list):
                        ok, n_items = True, len(env["data"])
                        (raw_dir / f"up-{i:02d}-{h}.retry.json").write_text(proc.stdout[:20_000_000])
                except json.JSONDecodeError:
                    pass
            print(f"REFETCH {h} attempt={attempt} ok={ok} items={n_items} "
                  f"dur_s={dur:.1f} exit={proc.returncode}", flush=True)
            if ok:
                done = True
                break
            if attempt <= len(RETRY_BACKOFF_S) and calls < UP_CALL_BUDGET:
                time.sleep(RETRY_BACKOFF_S[attempt - 1])
            else:
                break
        if done:
            ok_n += 1
        else:
            fail_n += 1
    print(f"REFETCH_SUMMARY ok={ok_n} failed={fail_n} cli_calls={calls} "
          f"budget={UP_CALL_BUDGET} budget_ok={calls <= UP_CALL_BUDGET}", flush=True)
    return 0 if fail_n == 0 else 1


# ── --analyze ───────────────────────────────────────────────────────────────
def analyze():
    we = parse_iso(WINDOW_END_ISO)
    ws = we - dt.timedelta(hours=WINDOW_H)
    accounts = load_accounts(CONFIG_PATH)
    cfg_lower = {a.lower() for a in accounts}
    sample = random.Random(SEED).sample(accounts, SAMPLE_N)
    raw_dir = Path(RAW_DIR)

    # ── Deep snapshot (snapshot order = fetch order) ──
    feed_env = json.loads(Path(DEEP_FEED).read_text())
    snap_raw = [x for x in (feed_env.get("data") or []) if isinstance(x, dict)]
    n3000_env = json.loads(Path(DEEP_N3000).read_text())
    n3000_raw = [x for x in (n3000_env.get("data") or []) if isinstance(x, dict)]
    snap = [{"ts": parse_iso(x.get("createdAtISO")), "item": x, "key": item_key(x)} for x in snap_raw]
    snap_ts = [s["ts"] for s in snap if s["ts"]]
    now = dt.datetime.now(dt.timezone.utc)
    oldest, newest = (min(snap_ts), max(snap_ts)) if snap_ts else (None, None)
    truncated = len(snap_raw) < DEEP_REQUESTED
    depth_h = (now - oldest).total_seconds() / 3600 if oldest else None
    # dense-reach: oldest item younger than the ancient cutoff
    recent = [t for t in snap_ts if (now - t).total_seconds() / 86400 <= ANCIENT_CUTOFF_DAYS]
    dense_oldest = min(recent) if recent else None
    dense_h = (now - dense_oldest).total_seconds() / 3600 if dense_oldest else None
    dup_ids = len(snap_raw) - len({str(x.get("id")) for x in snap_raw})
    print(f"DEEP_PULL file={Path(DEEP_FEED).name} requested={DEEP_REQUESTED} items={len(snap_raw)} "
          f"truncated={truncated} dup_ids={dup_ids} "
          f"is_rt={sum(1 for x in snap_raw if x.get('isRetweet'))}", flush=True)
    print(f"DEEP_PULL_N3000 file={Path(DEEP_N3000).name} items={len(n3000_raw)} "
          f"(default maxCount=200 cap; same timeline)", flush=True)
    print(f"DEEP_TIME newest={newest.isoformat() if newest else 'NA'} "
          f"oldest={oldest.isoformat() if oldest else 'NA'} "
          f"oldest_age_h={round(depth_h, 2) if depth_h else 'NA'} "
          f"dense_reach_age_h={round(dense_h, 2) if dense_h else 'NA'} "
          f"ancient_cutoff_days={ANCIENT_CUTOFF_DAYS} "
          f"snapshot_h_after_window_end={round((now - we).total_seconds() / 3600, 2)}", flush=True)
    print(f"WINDOW start={ws.isoformat()} end={we.isoformat()}", flush=True)

    # histogram + loads + ancient positions
    hist_all, hist_win = {}, {}
    for s in snap:
        if s["ts"] is None:
            continue
        b = hour_bucket(s["ts"])
        hist_all[b] = hist_all.get(b, 0) + 1
        if in_window(s["ts"], ws, we):
            hist_win[b] = hist_win.get(b, 0) + 1
    ancient_pos = [i + 1 for i, s in enumerate(snap)
                   if s["ts"] and (now - s["ts"]).total_seconds() / 86400 > ANCIENT_CUTOFF_DAYS]
    print(f"SNAPSHOT window_items={sum(hist_win.values())} "
          f"cfg_author_in_window="
          f"{sum(1 for s in snap if in_window(s['ts'], ws, we) and s['key'] and s['key'].split('/')[0] in cfg_lower)} "
          f"distinct_authors={len({s['key'].split('/')[0] for s in snap if s['key']})} "
          f"ancient_items={len(ancient_pos)} ancient_positions={ancient_pos[:10]}", flush=True)
    print("HISTOGRAM " + " ".join(f"{b.strftime('%m-%d-%H')}={n}" for b, n in sorted(hist_win.items())),
          flush=True)
    loads = {c: rolling_max_load(hist_win, c) for c in CADENCES_H}
    for c in CADENCES_H:
        print(f"LOAD cadence={c}h observed_max_rolling_items={loads[c]} "
              f"margin={INJECTION_MARGIN} effective={loads[c] + INJECTION_MARGIN}", flush=True)

    snap_keys = {s["key"] for s in snap if s["key"]}

    # ── Baseline: 30 fixed accounts ──
    baseline = []   # list of dicts: handle,key,ts,is_rt,is_reply
    err_accounts = []
    for i, h in enumerate(sample, 1):
        items, tag = load_up_payload(raw_dir, i, h)
        if items is None:
            err_accounts.append(h)
            print(f"ACCOUNT {h} ERROR {tag}", flush=True)
            continue
        n_win = 0
        for it in items:
            ts = parse_iso(it.get("createdAtISO"))
            if not in_window(ts, ws, we):
                continue
            k = item_key(it, h)
            if not k:
                continue
            n_win += 1
            baseline.append({"handle": h, "key": k, "ts": ts,
                             "is_rt": bool(it.get("isRetweet")),
                             "is_reply": is_reply_item(it)})
        print(f"ACCOUNT {h} src={tag} fetched={len(items)} baseline={n_win}", flush=True)

    base_keys = {b["key"] for b in baseline}
    base_rt = {b["key"] for b in baseline if b["is_rt"]}
    base_nonrt = base_keys - base_rt
    print(f"BASELINE accounts_ok={len(sample) - len(err_accounts)} errors={len(err_accounts)} "
          f"items={len(baseline)} union={len(base_keys)} rt={len(base_rt)} nonrt={len(base_nonrt)}",
          flush=True)
    if err_accounts:
        print(f"ERROR_ACCOUNTS {' '.join(err_accounts)}", flush=True)

    # ── DIRECT ──
    m, n, pct = coverage(base_keys, snap_keys)
    print(f"DIRECT matched={m} baseline={n} coverage_pct={round(pct, 2)}", flush=True)

    # ── REPLAY (single-snapshot lower bound) ──
    for c in CADENCES_H:
        pts = pull_times(we, c)
        for nb in N_CHOICES:
            keys = set()
            for t in pts:
                keys |= {e["key"] for e in sim_budget_pull(snap, t, nb) if e["key"]}
            m_c, n_c, p_c = coverage(base_keys, keys)
            print(f"REPLAY cadence={c}h n={nb} matched={m_c} coverage_pct="
                  f"{round(p_c, 2) if p_c is not None else 'NA'}", flush=True)

    # ── CADENCE (density-bounded catch model, primary) ──
    per_interval = {}
    for c in CADENCES_H:
        ivs = [(we - dt.timedelta(hours=c * (k + 1)), we - dt.timedelta(hours=c * k))
               for k in range(WINDOW_H // c)]
        per_interval[c] = []
        for a, b in ivs:
            blk = [x for x in baseline if a < x["ts"] <= b]
            per_interval[c].append({
                "span": f"{a.strftime('%m-%d %H:%M')}..{b.strftime('%m-%d %H:%M')}",
                "total": len(blk),
                "matched": sum(1 for x in blk if x["key"] in snap_keys),
                "elig_miss": sum(1 for x in blk if x["key"] not in snap_keys and not x["is_reply"]),
                "reply_miss": sum(1 for x in blk if x["key"] not in snap_keys and x["is_reply"]),
            })
    # key -> does any snapshot entry with this key carry isRetweet=False?
    def snap_has_nonrt(k):
        return any(not s["item"].get("isRetweet") for s in snap if s["key"] == k)

    best = {}
    for c in CADENCES_H:
        for nb in N_CHOICES:
            p = min(1.0, nb / (loads[c] + INJECTION_MARGIN))
            caught = sum(iv["matched"] + p * iv["elig_miss"] for iv in per_interval[c])
            pct_c = 100.0 * caught / len(base_keys) if base_keys else None
            # RT-off view: non-RT baseline items, caught only via non-RT feed entries
            rt_off_caught = sum(
                (1.0 if snap_has_nonrt(x["key"]) else 0.0)
                + (0.0 if x["key"] in snap_keys else p if not x["is_reply"] else 0.0)
                for x in baseline if not x["is_rt"])
            rt_off_total = len([x for x in baseline if not x["is_rt"]])
            pct_rt_off = 100.0 * rt_off_caught / rt_off_total if rt_off_total else None
            print(f"CADENCE cadence={c}h n={nb} catch_p={round(p, 3)} caught={round(caught, 1)} "
                  f"coverage_pct={round(pct_c, 2) if pct_c is not None else 'NA'} "
                  f"rt_off_coverage_pct={round(pct_rt_off, 2) if pct_rt_off is not None else 'NA'}",
                  flush=True)
            if pct_c is not None and (c not in best or pct_c > best[c][0]
                                      or (pct_c == best[c][0] and nb < best[c][1])):
                best[c] = (pct_c, nb)

    for c in CADENCES_H:
        for iv in per_interval[c]:
            print(f"INTERVAL cadence={c}h span={iv['span']} total={iv['total']} "
                  f"matched={iv['matched']} elig_miss={iv['elig_miss']} reply_miss={iv['reply_miss']}",
                  flush=True)
        print(f"CADENCE_SUMMARY cadence={c}h best_n={best[c][1]} "
              f"best_coverage_pct={round(best[c][0], 2)} pulls_per_24h={WINDOW_H // c}", flush=True)

    # ── CURSOR design warning ──
    if ancient_pos:
        print(f"CURSOR_WARNING ancient_items_rank_positions={ancient_pos[:10]} "
              f"min_rank={min(ancient_pos)} — pure cursor-stop would truncate pulls; "
              f"require a minimum page floor before honouring the cursor", flush=True)

    # ── Recommendation: cheapest (cadence↑, n↓) meeting the gate ──
    order = [(2, 200), (2, 500), (1, 200), (1, 500)]
    rec = None
    for c, nb in order:
        if c in best and best[c][1] <= nb and best[c][0] >= COVERAGE_GATE_PCT:
            rec = (c, nb, best[c][0])
            break
    if rec is None:
        c0 = max(best, key=lambda c: best[c][0])
        rec = (c0, best[c0][1], best[c0][0])
    coverage_ok = rec[2] >= COVERAGE_GATE_PCT
    print(f"RECOMMENDED cadence={rec[0]}h n={rec[1]} coverage_pct={round(rec[2], 2)} "
          f"coverage_ok={coverage_ok} gate={COVERAGE_GATE_PCT}", flush=True)
    print("LIMITATIONS single_snapshot_lower_bound=true rank_monotonicity_assumed=true "
          "load_bound_from_observed_histogram=true window_fixed_from_previous_run=true "
          "reply_classifier=leading_mention", flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--refetch-errors", action="store_true")
    ap.add_argument("--analyze", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if args.refetch_errors:
        return refetch_errors()
    if args.analyze:
        return analyze()
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
