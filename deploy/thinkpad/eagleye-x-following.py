#!/usr/bin/env python3
"""Eagleye X Following 2h incremental trigger (Round 2 feed mode).

Runs from a systemd timer (every 2h, offset from the enrich drainer's
00/2:40 and from the 01:00 pipeline). Fires the existing admin endpoint
POST /api/x-following/sync?background=true, which queues the singleton
X_FOLLOWING_SYNC job; with an explicit X_FOLLOWING_MODE=feed the connector
then does ONE cursor-bounded following-feed pull instead of a 442-account
per-user scan. Clones eagleye-drain.py: read-only sqlite + one POST.

Mode guard (CTO ruling 2026-10-20): per-user is the DEFAULT and the 01:00
pipeline owns X. This trigger fires ONLY when the service env file pins
X_FOLLOWING_MODE=feed explicitly; unset or any other value skips (an unset
default plus a live timer would otherwise run a full 442-account scan every
2h on top of the pipeline's own scan — the CLI red-line storm).

Overlap guard: X_FOLLOWING_SYNC and FULL_PIPELINE are DIFFERENT singleton
types, so the server would happily run both in parallel (executeJob is
fire-and-forget per type); when the 01:00 pipeline is still queued/running
this trigger defers to the next 2h tick. The job-lease recycler reaps stale
'running' rows server-side, so both guards are best-effort.

Idempotent — the server dedupes X_FOLLOWING_SYNC singleton jobs itself.
"""
import json, re, sqlite3, sys, urllib.request

DB = '/home/jc/projects/eagleye/eagleye.db'
BASE = 'http://100.107.223.2:3019'
ENV_FILE = '/home/jc/.config/argus/eagleye-pipeline.env'  # service EnvironmentFile

# Mode guard (see docstring): fire only on an EXPLICIT X_FOLLOWING_MODE=feed
# in the service EnvironmentFile. Default (unset) is per-user per the CTO
# ruling — the 01:00 pipeline's own full scan owns X, and this trigger firing
# would add a second full 442-account scan every 2h (CLI red-line storm).
mode = None
try:
    with open(ENV_FILE) as f:
        for line in f:
            m = re.match(r'\s*(?:export\s+)?X_FOLLOWING_MODE\s*=\s*["\']?([\w-]+)', line)
            if m:
                mode = m.group(1).strip().lower()
                break
except FileNotFoundError:
    pass  # no env file → default per-user → skip below
if mode != 'feed':
    print(json.dumps({'skipped': True, 'mode': mode or 'unset',
                      'reason': 'X_FOLLOWING_MODE not explicitly "feed" (CTO ruling: '
                                'per-user default, 01:00 pipeline owns X)'}))
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
