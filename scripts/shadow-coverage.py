#!/usr/bin/env python3
"""Eagleye Round 2 — shadow coverage comparison (READ-ONLY, no DB access).

Compares the planned `following-feed` crawl path against the current
per-account `user-posts` path over the same sliding 24h window, for a
reproducible random sample of 30 accounts from config/x-following.txt.

  feed side    : twitter feed -t following -n <FEED_N> --json   (1 call)
  baseline side: twitter user-posts @<handle> -n <UP_N> --json  (30 calls, serial)

Both sides are filtered to [window_start, window_end] where window_end is the
moment the feed call completed (so tweets posted during the serial user-posts
walk cannot bias the baseline). Match key is the project's canonical_url
(`https://x.com/<screenName>/status/<id>`, server/connectors/x-following.js:123,
server/connectors/base.js:47) normalised case-insensitively.

Baseline = union of per-account user-posts canonical URLs (this mirrors the
current connector, which ingests everything user-posts returns — no RT filter
on that path). Coverage = |baseline ∩ feed| / |baseline|.

CLI pacing: serial with INTERCALL_SLEEP_S between calls. The production
connector runs 4 concurrent workers with 0 batch delay (x-following.js:415),
so serial+sleep is strictly gentler. Total CLI calls: 31 vs the current
442 user-posts/day — same order of magnitude, far below.

Usage:
  python3 scripts/shadow-coverage.py --selftest   # pure-function tests, no CLI calls
  python3 scripts/shadow-coverage.py              # real run (needs twitter CLI env)

Env: sources (first-wins, PATH never overridden) at startup:
  /home/jc/.config/argus/independent.env          (HTTP(S)_PROXY to reach x.com)
  /home/jc/.config/argus/eagleye-twitter.credentials (TWITTER_AUTH_TOKEN/CT0)
Credential values are never printed or written anywhere.
Raw CLI responses are dumped under /tmp/shadow-coverage-raw-<epoch>/ for audit.
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
SEED = 20261020            # fixed random seed — same sample on every rerun
SAMPLE_N = 30              # accounts sampled from config/x-following.txt
WINDOW_H = 24              # comparison window length (hours)
FEED_N = 200               # feed page budget; observed density ~30 tweets/24h
UP_N = 40                  # per-account depth == connector max (X_FOLLOWING_TWEETS_PER_USER)
INTERCALL_SLEEP_S = 5.0    # serial pacing between CLI calls
SUBPROCESS_TIMEOUT_S = 300

ENV_FILES = [
    "/home/jc/.config/argus/independent.env",
    "/home/jc/.config/argus/eagleye-twitter.credentials",
]

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "config" / "x-following.txt"

STATUS_RE = re.compile(r"^https?://(?:x|twitter)\.com/([A-Za-z0-9_]+)/status/(\d+)")


# ── Env loading ─────────────────────────────────────────────────────────────
def load_env_files(paths, environ):
    """Apply KEY=VALUE lines from env files into `environ` (first-wins, PATH skipped).

    Mirrors systemd EnvironmentFile semantics for our purpose: a variable set
    by an earlier file is not overridden by a later one, and our own PATH
    (which must contain /home/jc/.local/bin) always wins.
    """
    applied = []
    for path in paths:
        p = Path(path)
        if not p.exists():
            applied.append(f"{path}:MISSING")
            continue
        n = 0
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key == "PATH" or key in environ:
                continue
            environ[key] = val
            n += 1
        applied.append(f"{path}:{n}vars")
    return applied


# ── Pure comparison helpers ─────────────────────────────────────────────────
def parse_iso(ts):
    """Parse createdAtISO ('2026-10-20T11:29:58+00:00') → aware datetime, else None."""
    if not ts:
        return None
    try:
        d = dt.datetime.fromisoformat(str(ts))
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d
    except ValueError:
        return None


def canonical_url(item, fallback_handle=""):
    """Mirror server/connectors/x-following.js:119-123 exactly."""
    handle = ((item or {}).get("author") or {}).get("screenName") or fallback_handle
    tid = str((item or {}).get("id") or "")
    return f"https://x.com/{handle}/status/{tid}" if tid else ""


def match_key(url):
    """Case-insensitive tweet identity: '<lower handle>/status/<id>'.

    canonical_url equality in the DB is exact-string; the only variance between
    the two CLI paths is handle case (config 'HeMuyu0327' vs screenName
    'HeMuYu0327'), and twitter.com/x.com host equivalence.
    """
    m = STATUS_RE.match(url or "")
    if m:
        return f"{m.group(1).lower()}/status/{m.group(2)}"
    return (url or "").lower().rstrip("/") or None


def in_window(ts, window_start, window_end):
    return ts is not None and window_start <= ts <= window_end


def coverage(baseline, feed):
    """Return (matched, baseline_n, pct or None)."""
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


# ── CLI plumbing ────────────────────────────────────────────────────────────
class TwitterCLI:
    def __init__(self, environ, raw_dir):
        self.env = dict(environ)
        self.raw_dir = raw_dir
        self.bin = shutil.which("twitter", path=self.env.get("PATH", "")) or shutil.which("twitter")
        self.calls = 0

    def _run(self, args, tag):
        if not self.bin:
            raise SystemExit("FATAL: twitter CLI not found on PATH (expected /home/jc/.local/bin/twitter)")
        self.calls += 1
        t0 = time.monotonic()
        proc = subprocess.run(
            [self.bin] + args,
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S, env=self.env,
        )
        dur = time.monotonic() - t0
        (self.raw_dir / f"{tag}.json").write_text(proc.stdout[:20_000_000])
        if proc.returncode != 0:
            return {"ok": False, "code": f"EXIT_{proc.returncode}",
                    "message": (proc.stderr or proc.stdout or "")[-400:], "dur_s": round(dur, 1)}
        try:
            env = json.loads(proc.stdout)
        except json.JSONDecodeError as e:
            return {"ok": False, "code": "PARSE_ERROR", "message": str(e), "dur_s": round(dur, 1)}
        if env.get("ok") is True:
            data = env.get("data")
            return {"ok": True, "data": data if isinstance(data, list) else [data],
                    "dur_s": round(dur, 1)}
        err = env.get("error") or {}
        return {"ok": False, "code": err.get("code", "ERROR"),
                "message": err.get("message", "ok:false"), "dur_s": round(dur, 1)}


def stats(items, window_start, window_end, fallback_handle=""):
    """Filter items to window; return (key_set, [(key, url)...], n_window, bad_ts, oldest_ts)."""
    keys, pairs, bad, oldest, n_win = set(), [], 0, None, 0
    for it in items:
        ts = parse_iso(it.get("createdAtISO"))
        if ts is None:
            bad += 1
            continue
        oldest = ts if oldest is None or ts < oldest else oldest
        if not in_window(ts, window_start, window_end):
            continue
        n_win += 1
        u = canonical_url(it, fallback_handle)
        k = match_key(u)
        if k:
            keys.add(k)
            pairs.append((k, u))
    return keys, pairs, n_win, bad, oldest


# ── Selftest (pure functions only, zero CLI calls) ─────────────────────────
def selftest():
    now = dt.datetime(2026, 10, 20, 12, 0, tzinfo=dt.timezone.utc)
    ws, we = now - dt.timedelta(hours=24), now

    # window filter
    items = [
        {"id": "1", "createdAtISO": "2026-10-20T11:00:00+00:00", "author": {"screenName": "A"}},
        {"id": "2", "createdAtISO": "2026-10-19T00:00:00+00:00", "author": {"screenName": "A"}},  # >24h old -> out
        {"id": "3", "createdAtISO": "2026-10-20T12:30:00+00:00", "author": {"screenName": "A"}},  # after window_end -> out
        {"id": "4", "createdAtISO": None, "author": {"screenName": "A"}},                            # unparseable -> bad
    ]
    keys, urls, n_win, bad, _ = stats(items, ws, we)
    assert n_win == 1 and bad == 1 and len(keys) == 1, (n_win, bad, keys)
    assert [u for _, u in urls] == ["https://x.com/A/status/1"], urls

    # canonicalisation + case-insensitive identity
    k1 = match_key("https://x.com/HeMuyu0327/status/123")
    k2 = match_key("https://twitter.com/hemuyu0327/status/123")
    k3 = match_key("https://x.com/Other/status/999")
    assert k1 == k2 == "hemuyu0327/status/123", (k1, k2)
    assert k1 != k3

    # connector-parity canonical_url (fallback handle when author missing)
    # Connector (x-following.js:120-123) with no author AND no fallback builds the
    # degenerate 'https://x.com//status/<id>' — mirror that behaviour exactly.
    assert canonical_url({"id": "7"}) == "https://x.com//status/7"
    assert canonical_url({"id": "7"}, fallback_handle="cfg") == "https://x.com/cfg/status/7"
    assert canonical_url({"id": "8", "author": {"screenName": "Real"}}) == "https://x.com/Real/status/8"

    # coverage math
    m, n, pct = coverage({"a/1", "a/2", "a/3"}, {"a/2", "a/3", "a/4"})
    assert (m, n, pct) == (2, 3, 200 / 3), (m, n, pct)
    assert coverage(set(), {"x"}) == (0, 0, None)

    # sampling determinism
    accs = [f"h{i}" for i in range(442)]
    s1 = random.Random(SEED).sample(accs, SAMPLE_N)
    s2 = random.Random(SEED).sample(accs, SAMPLE_N)
    assert s1 == s2 and len(set(s1)) == SAMPLE_N

    print("SELFTEST OK")
    return 0


# ── Recompute mode: re-evaluate an existing raw dump (no new user-posts calls) ──
def recompute(raw_dir, feed_file, window_end_iso, deep_tag):
    """Re-run the comparison over saved raw responses.

    Used when the live run's feed fetch hit its -n cap inside the window
    (fetched == FEED_N): fetch a deeper feed separately (e.g.
    `twitter feed -t following -n 600 --json`), save it as feed-deep.json in
    the raw dir, and recompute coverage against the SAME fixed window and the
    SAME per-account baselines. Zero additional user-posts calls.
    """
    raw_dir = Path(raw_dir)
    we = parse_iso(window_end_iso)
    if we is None:
        print("FATAL: bad --window-end ISO"); return 2
    ws = we - dt.timedelta(hours=WINDOW_H)
    accounts = load_accounts(CONFIG_PATH)
    cfg_lower = {a.lower() for a in accounts}
    sample = random.Random(SEED).sample(accounts, SAMPLE_N)

    feed = json.loads(Path(feed_file).read_text())
    feed_items = [x for x in (feed.get("data") or []) if isinstance(x, dict)]
    feed_keys_all, _, feed_n_win, feed_bad, feed_oldest = stats(feed_items, ws, we)
    feed_cfg_authors = {match_key(canonical_url(x)) for x in feed_items
                        if in_window(parse_iso(x.get("createdAtISO")), ws, we)
                        and ((x.get("author") or {}).get("screenName") or "").lower() in cfg_lower}
    oldest_age_h = (we - feed_oldest).total_seconds() / 3600 if feed_oldest else None
    print(f"RECOMPUTE feed={deep_tag} fetched={len(feed_items)} window_items={feed_n_win} bad_ts={feed_bad} "
          f"oldest_age_h={oldest_age_h and round(oldest_age_h, 1)} "
          f"window_reaches_start={feed_oldest is not None and feed_oldest <= ws}", flush=True)
    print(f"WINDOW start={ws.isoformat()} end={we.isoformat()}", flush=True)

    baseline_union, accounts_with_baseline = set(), 0
    error_accounts, truncated_accounts, miss_urls = [], [], []
    for i, h in enumerate(sample, 1):
        f = raw_dir / f"up-{i:02d}-{h}.json"
        if not f.exists():
            error_accounts.append(h)
            print(f"ACCOUNT {h} ERROR missing_raw_file", flush=True)
            continue
        try:
            data = json.loads(f.read_text()).get("data")
        except (json.JSONDecodeError, AttributeError):
            error_accounts.append(h)
            print(f"ACCOUNT {h} ERROR unparseable_raw (live-run CLI error)", flush=True)
            continue
        items = [x for x in (data or []) if isinstance(x, dict)]
        keys, pairs, n_win, bad, oldest = stats(items, ws, we, fallback_handle=h)
        trunc = len(items) >= UP_N and oldest is not None and oldest > ws
        if trunc:
            truncated_accounts.append(h)
        if keys:
            accounts_with_baseline += 1
            baseline_union |= keys
            miss_urls += [u for k, u in pairs if k not in feed_keys_all]
        print(f"ACCOUNT {h} fetched={len(items)} baseline={len(keys)} "
              f"matched={len(keys & feed_keys_all)} "
              f"coverage={(round(100.0 * len(keys & feed_keys_all) / len(keys), 2)) if keys else 'n/a'} "
              f"truncated={trunc} bad_ts={bad}", flush=True)

    matched_union, baseline_n, cov_pct = coverage(baseline_union, feed_keys_all)
    _, _, cov_pct_cfg = coverage(baseline_union, feed_cfg_authors)
    print("─" * 60, flush=True)
    print(f"AGGREGATE baseline_union={baseline_n} matched={matched_union} "
          f"coverage_pct={cov_pct and round(cov_pct, 2)} "
          f"coverage_pct_cfg_author_filter={cov_pct_cfg and round(cov_pct_cfg, 2)}", flush=True)
    (raw_dir / f"missing-urls-{deep_tag}.txt").write_text("\n".join(miss_urls))
    print(f"SUMMARY mode=recompute feed={deep_tag} sample={SAMPLE_N} seed={SEED} window_h={WINDOW_H} "
          f"accounts_with_baseline={accounts_with_baseline} baseline_total={baseline_n} "
          f"matched_total={matched_union} coverage_pct={round(cov_pct, 2) if cov_pct is not None else 'NA'} "
          f"errors={len(error_accounts)} baseline_truncated={len(truncated_accounts)} "
          f"raw_dir={raw_dir}", flush=True)
    if error_accounts:
        print(f"ERROR_ACCOUNTS {' '.join(error_accounts)}", flush=True)
    return 0


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--recompute", metavar="RAW_DIR",
                    help="re-evaluate a saved raw dump (no new user-posts calls)")
    ap.add_argument("--feed-file", default=None,
                    help="feed JSON to compare against in --recompute mode")
    ap.add_argument("--window-end", default=None,
                    help="window end ISO from the live run's WINDOW line (recompute mode)")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if args.recompute:
        if not args.feed_file or not args.window_end:
            print("FATAL: --recompute requires --feed-file and --window-end")
            return 2
        return recompute(args.recompute, args.feed_file, args.window_end,
                         Path(args.feed_file).stem)

    t_start = time.monotonic()
    environ = dict(os.environ)
    environ["PATH"] = "/home/jc/.local/bin:" + environ.get("PATH", "")
    env_report = load_env_files(ENV_FILES, environ)
    if not environ.get("TWITTER_AUTH_TOKEN") or not environ.get("TWITTER_CT0"):
        print("FATAL: TWITTER_AUTH_TOKEN/TWITTER_CT0 not present after loading env files")
        return 2

    accounts = load_accounts(CONFIG_PATH)
    cfg_lower = {a.lower() for a in accounts}
    if len(accounts) < SAMPLE_N:
        print(f"FATAL: need >= {SAMPLE_N} accounts, config has {len(accounts)}")
        return 2

    sample = random.Random(SEED).sample(accounts, SAMPLE_N)
    raw_dir = Path(f"/tmp/shadow-coverage-raw-{int(time.time())}")
    raw_dir.mkdir(parents=True, exist_ok=True)

    cli = TwitterCLI(environ, raw_dir)

    print(f"CONFIG accounts={len(accounts)} sample_n={SAMPLE_N} seed={SEED}", flush=True)
    print(f"SAMPLE {' '.join(sample)}", flush=True)
    print(f"ENV {'; '.join(env_report)}", flush=True)

    # 1) Feed side — one call, window anchored at its completion
    r = cli._run(["feed", "-t", "following", "-n", str(FEED_N), "--json"], "feed")
    if not r["ok"]:
        print(f"FATAL: feed call failed code={r['code']} msg={r['message'][:200]}", flush=True)
        return 2
    window_end = dt.datetime.now(dt.timezone.utc)
    window_start = window_end - dt.timedelta(hours=WINDOW_H)
    feed_items = [x for x in r["data"] if isinstance(x, dict)]
    feed_keys_all, _, feed_n_win, feed_bad, feed_oldest = stats(feed_items, window_start, window_end)
    feed_cfg_authors = {match_key(canonical_url(x)) for x in feed_items
                        if in_window(parse_iso(x.get("createdAtISO")), window_start, window_end)
                        and ((x.get("author") or {}).get("screenName") or "").lower() in cfg_lower}
    feed_rt = sum(1 for x in feed_items if x.get("isRetweet"))
    feed_rt_by = sum(1 for x in feed_items if x.get("retweetedBy"))
    oldest_age_h = (window_end - feed_oldest).total_seconds() / 3600 if feed_oldest else None
    feed_truncated = oldest_age_h is not None and feed_oldest > window_start  # didn't reach 24h back
    print(f"FEED fetched={len(feed_items)} window_items={feed_n_win} bad_ts={feed_bad} "
          f"oldest_age_h={oldest_age_h and round(oldest_age_h, 1)} truncated={feed_truncated} "
          f"is_retweet={feed_rt} retweeted_by={feed_rt_by} dur_s={r['dur_s']}", flush=True)
    print(f"WINDOW start={window_start.isoformat()} end={window_end.isoformat()}", flush=True)

    # 2) Baseline side — serial per-account user-posts
    baseline_union = set()
    accounts_with_baseline = 0
    error_accounts, truncated_accounts = [], []
    miss_urls = []
    for i, h in enumerate(sample, 1):
        time.sleep(INTERCALL_SLEEP_S)
        r = cli._run(["user-posts", f"@{h}", "-n", str(UP_N), "--json"], f"up-{i:02d}-{h}")
        if not r["ok"]:
            error_accounts.append(h)
            print(f"ACCOUNT {h} ERROR code={r['code']} msg={r['message'][:120]}", flush=True)
            continue
        items = [x for x in r["data"] if isinstance(x, dict)]
        keys, pairs, n_win, bad, oldest = stats(items, window_start, window_end, fallback_handle=h)
        trunc = len(items) >= UP_N and oldest is not None and oldest > window_start
        if trunc:
            truncated_accounts.append(h)
        if keys:
            accounts_with_baseline += 1
            baseline_union |= keys
            miss_urls += [u for k, u in pairs if k not in feed_keys_all]
        print(f"ACCOUNT {h} fetched={len(items)} baseline={len(keys)} "
              f"matched={len(keys & feed_keys_all)} "
              f"coverage={(round(100.0 * len(keys & feed_keys_all) / len(keys), 2)) if keys else 'n/a'} "
              f"truncated={trunc} bad_ts={bad} dur_s={r['dur_s']}", flush=True)

    # 3) Aggregate
    matched_union, baseline_n, cov_pct = coverage(baseline_union, feed_keys_all)
    _, _, cov_pct_cfg = coverage(baseline_union, feed_cfg_authors)
    elapsed = round(time.monotonic() - t_start, 1)
    print("─" * 60, flush=True)
    print(f"AGGREGATE baseline_union={baseline_n} matched={matched_union} "
          f"coverage_pct={cov_pct and round(cov_pct, 2)} "
          f"coverage_pct_cfg_author_filter={cov_pct_cfg and round(cov_pct_cfg, 2)}", flush=True)
    (raw_dir / "missing-urls.txt").write_text("\n".join(miss_urls))
    print(f"SUMMARY sample={SAMPLE_N} seed={SEED} window_h={WINDOW_H} "
          f"accounts_with_baseline={accounts_with_baseline} baseline_total={baseline_n} "
          f"matched_total={matched_union} coverage_pct={round(cov_pct, 2) if cov_pct is not None else 'NA'} "
          f"cli_calls={cli.calls} elapsed_sec={elapsed} errors={len(error_accounts)} "
          f"baseline_truncated={len(truncated_accounts)} feed_truncated={feed_truncated} "
          f"raw_dir={raw_dir}", flush=True)
    if error_accounts:
        print(f"ERROR_ACCOUNTS {' '.join(error_accounts)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
