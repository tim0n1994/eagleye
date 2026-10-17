# ThinkPad operations

## Remote development

In Codex Desktop select `application-host` and open `/home/user/projects/eagleye`.
Shell access from the Mac uses the existing SSH identity:

```sh
ssh -F ~/.local/share/argus/ssh/thinkpad-ssh.conf application-host
export PATH="$HOME/.local/bin:$PATH"
cd /home/user/projects/eagleye
```

The service reads this checkout directly. Make feature changes in a separate
worktree, with an isolated database and port; merge and deploy after checks.
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

## Backup and restore verification

The existing backup utility uses SQLite's online backup API. It captures WAL
changes consistently while the production service continues running.

```sh
umask 077
node scripts/backup-eagleye.js --db /home/user/projects/eagleye/eagleye.db --out /home/user/backups/eagleye
node scripts/restore-verify.js --backup /home/user/backups/eagleye/CHOSEN-BACKUP.db
sha256sum /home/user/backups/eagleye/CHOSEN-BACKUP.db
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

1. Clone the private repository and select the validated commit.
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
