# ThinkPad operations

## Remote development

In Codex Desktop select `application-host` and open `/home/user/projects/eagleye`.
Shell access from the Mac uses the existing SSH identity:

```sh
ssh -F ~/.local/share/argus/ssh/thinkpad-ssh.conf application-host
export PATH="$HOME/.local/bin:$PATH"
cd /home/user/projects/eagleye
```

The API is pinned to the validated release directory via a systemd drop-in.
Inspect `systemctl --user show argus-eagleye.service -p WorkingDirectory -p ExecStart`
instead of treating the development checkout as the running release. The live
database remains `/home/user/projects/eagleye/eagleye.db`. Make feature changes in
a separate worktree, with an isolated database and port; merge and deploy after checks.
Do not restart the API while a collection or backfill job is active.

```sh
git worktree add -b codex/my-change /home/user/worktrees/eagleye-my-change main
```

Code, jobs, dependencies and data stay on the ThinkPad SSD. Historical WDC HDD
mounts remain read-only and must not be used for new backups or runtime state.

## Service checks

```sh
systemctl --user is-active argus-eagleye.service argus-eagleye-mcp.service argus-eagleye-mcp-proxy.service argus-eagleye-xhs.service
loginctl show-user jc -p Linger
curl --fail http://192.0.2.1:3019/ -o /dev/null
curl --fail http://127.0.0.1:3020/health
```

Cloudflare, model gateways and network egress are host infrastructure outside
this repository. Do not stop a shared tunnel based on an application name.
Check the active host ingress unit rather than assuming a historical unit name.

## SSD policy and daily incremental collection

The ThinkPad policy is daily **incremental collection at 01:00 Asia/Shanghai**
through the application's existing scheduler (`pipeline`, enabled). Collection
deduplicates incoming items; it is not a database backup. Keep the existing
Outbox, enrichment and KG drain jobs. Do not add a second daily pipeline timer.
The public application's default scheduler remains disabled at 04:00; the host
policy explicitly configures the global `scheduler_config` database setting.

Daily full-database snapshots are **disabled and masked**. Reapplying this policy
preserves the mask, so enabling timers during deployment cannot silently restore
daily database copies. The installer preserves an old timer definition as a
small `.timer.disabled` file. It does not delete the existing recovery snapshot.
There is no daily database-copy task or automated business-data deletion.

Deployment backups are created only when required by a deployment/migration;
the daily 04:45 retention task creates no backups and keeps the newest one.
It fails closed if that backup lacks a valid integrity manifest or its size does
not match the manifest. In-use backups and historical migration/relocation
archives remain protected. The two deployment backup roots are
`~/.local/share/argus/eagleye-backups` and `~/projects/eagleye-backups`.

At 04:15, a read-only growth report records UTC-window 24-hour ingestion, DB/WAL
sizes, free SSD space and queue counts. It keeps only 365 small JSONL observations
in `~/.local/share/argus/eagleye-growth/observations.jsonl`. Deltas are between
observations; use `elapsed_seconds` before treating a partial interval as a day.
No database copies are made. Backfills and old business-record retention require
a separate bounded plan; avoid replacing new-data collection with history replay.

Apply the tracked policy from the checkout containing these files:

```sh
python3 -B deploy/thinkpad/install-storage-policy.py          # read-only preflight
python3 -B deploy/thinkpad/install-storage-policy.py --apply  # install/enable accounting and retention
systemctl --user is-enabled eagleye-snapshot.timer           # must print masked (nonzero exit)
systemctl --user is-active eagleye-snapshot.service          # must print inactive
systemctl --user start eagleye-growth-report.service         # read-only DB metrics
~/.local/bin/eagleye-backup-prune.sh --dry-run
```

The installer requires an existing migrated DB, preserves scheduler run IDs and
retry receipts, and does not run or restart the API/pipeline. Restore collector
sessions and other credentials separately; they must never be committed.
The API process uses the host's Asia/Shanghai timezone for its 01:00 schedule.
Storage timers specify Asia/Shanghai explicitly.

## On-demand backup and restore verification

The existing backup utility uses SQLite's online backup API. It captures WAL
changes consistently while the production service continues running.

```sh
umask 077
mkdir -p "$HOME/.local/share/argus/eagleye-backups"
node scripts/backup-eagleye.js --db /home/user/projects/eagleye/eagleye.db --out "$HOME/.local/share/argus/eagleye-backups"
node scripts/restore-verify.js --backup "$HOME/.local/share/argus/eagleye-backups/CHOSEN-BACKUP.db"
sha256sum "$HOME/.local/share/argus/eagleye-backups/CHOSEN-BACKUP.db"
```

Require an integrity result of `ok`, a present manifest, exact table-count
matches and no mismatches. Verification works on a disposable copy and does not
replace the live database. A successful restore check is not authorization to
overwrite production. Preserve newer data and arrange a maintenance window
before a real replacement.

Local SSD backups protect against accidental edits; they do not protect against
loss of the SSD. Keep an encrypted copy on a separately chosen device or storage
service. Never upload the database or credentials into the Git repository.

## Rebuild on another Linux host

1. Clone the repository and select the validated commit.
2. Install a supported Node release, Python 3.12 and uv; run `npm ci` and
   `uv sync --locked --project kg-worker`.
3. Restore a verified database snapshot to the intended SSD path. Check that the
   file exists and is nonempty before starting any service; an omitted database
   path can otherwise create an empty database.
4. Restore external configuration through the private administrative channel.
   Required categories include application authentication, model gateway access,
   MCP credentials, collector sessions, Cloudflare credentials and service unit
   configuration. These are intentionally absent from Git.
5. Adapt the existing systemd user units to the new user's paths. Set an explicit
   Node/uv PATH and database path, enable user lingering, then enable the API,
   MCP, proxy and collector services.
   Apply `deploy/thinkpad/install-storage-policy.py --apply` after restoring the
   database. Do not enable daily snapshot jobs. Inspect that the scheduler is
   enabled for 01:00 and that the snapshot timer remains masked.
6. Validate authenticated business reads, a bounded real pipeline job, persisted
   graph/briefing output, the scheduler and the public hostnames. Keep HTTP,
   automated tests and real pipeline acceptance as separate results.

## Historical backlog

Backfill state is outside Git in
`/home/user/.local/share/argus/eagleye-backfill/20261016/`.
Inspect the current job and persisted request ID before resuming it; never
create a duplicate job after an unknown response. The daily scheduler is paused
during backlog processing and is restored by the controller on successful
completion. Inspect actual database gaps and stage receipts before declaring
completion. A model label in a state file does not prove which endpoint handled
the requests.

Historical graph data includes previously identified dangling entity relations.
The endpoint-generation fix prevents new malformed links; it does not repair
every historical relation automatically.
