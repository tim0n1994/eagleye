#!/usr/bin/env python3
"""Eagleye X Following 2h incremental trigger (Round 2 feed mode, R2.1 hybrid).

Runs from a systemd timer (every 2h, offset from the enrich drainer's
00/2:40 and from the 01:00 pipeline). Fires the existing admin endpoint
POST /api/x-following/sync?background=true, which queues the singleton
x-following-sync job; with the connector default (X_FOLLOWING_MODE unset,
effective "feed") or an explicit hybrid pin, it does ONE cursor-bounded
following-feed pull — hybrid additionally degrades a failed feed round to
a per-user scan at most once per X_FOLLOWING_FULL_FALLBACK_COOLDOWN_MS
(default 24h) — instead of a 442-account per-user scan. Clones
eagleye-drain.py: read-only sqlite + one POST.

Mode guard: the effective mode follows the CONNECTOR default — unset means
"feed", so the 2h lane owns X and the 01:00 pipeline stage skips it. Only
an explicit X_FOLLOWING_MODE=per-user in the env file hands X back to the
pipeline and makes this trigger self-skip (a skipped tick is logged, not a
storm: feed has no full-scan path, and hybrid caps fallback frequency).

Overlap guard: X_FOLLOWING_SYNC and FULL_PIPELINE are DIFFERENT singleton
types, so the server would happily run both in parallel (executeJob is
fire-and-forget per type); when the 01:00 pipeline is still queued/running
this trigger defers to the next 2h tick. The job-lease recycler reaps stale
'running' rows server-side, so both guards are best-effort.

Idempotent — the server dedupes X_FOLLOWING_SYNC singleton jobs itself.
"""
import json, os, re, sqlite3, sys, urllib.request
from pathlib import Path

DB = os.environ.get('EAGLEYE_DB_PATH', str(Path.home() / 'projects/eagleye/eagleye.db'))
BASE = os.environ.get('EAGLEYE_API_BASE_URL', 'http://127.0.0.1:3019').rstrip('/')
ENV_FILE = os.environ.get('EAGLEYE_PIPELINE_ENV_FILE', str(Path.home() / '.config/argus/eagleye-pipeline.env'))

# Mode guard (see docstring): effective mode follows the connector default —
# unset -> feed. Only an explicit pin in the EnvironmentFile changes it;
# per-user hands X back to the 01:00 pipeline and keeps this lane inert.
mode = 'feed'
try:
    with open(ENV_FILE) as f:
        for line in f:
            m = re.match(r'\s*(?:export\s+)?X_FOLLOWING_MODE\s*=\s*["\']?([\w-]+)', line)
            if m:
                mode = m.group(1).strip().lower() or 'feed'
                break
except FileNotFoundError:
    pass  # no env file -> connector default feed -> 2h lane owns X
if mode not in ('feed', 'hybrid'):
    print(json.dumps({'skipped': True, 'mode': mode,
                      'reason': 'X_FOLLOWING_MODE=%s: X owned by the 01:00 pipeline '
                                '(legacy per-user); 2h lane stays inert' % mode}))
    sys.exit(0)

con = sqlite3.connect('file:' + DB + '?mode=ro', uri=True)
busy = con.execute(
    "SELECT id, job_type, status FROM background_jobs "
    "WHERE job_type IN ('full-pipeline','fetch-all') "
    "AND status IN ('queued','running') LIMIT 1").fetchone()
if busy:
    print(json.dumps({'skipped': True, 'reason': 'pipeline active',
                      'job': busy[0], 'type': busy[1], 'status': busy[2]}))
    sys.exit(0)
key = con.execute(
    "SELECT k.key FROM api_keys k JOIN users u ON u.id=k.user_id "
    "WHERE k.active=1 AND u.status='active' AND u.role='admin' "
    "AND (k.expires_at IS NULL OR datetime(k.expires_at)>datetime('now')) LIMIT 1").fetchone()
if not key:
    print(json.dumps({'error': 'no admin key'})); sys.exit(1)
req = urllib.request.Request(
    BASE + '/api/x-following/sync?background=true', data=b'', method='POST',
    headers={'Authorization': 'Bearer ' + key[0]})
result = json.load(urllib.request.urlopen(req, timeout=30))
print(json.dumps({'fired': result.get('job_id') or result}, ensure_ascii=False))
