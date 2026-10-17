# Eagleye

Private intelligence collection, enrichment, translation, knowledge graph and
briefing service. The canonical runtime and development host is `application-host`.
The Mac is a remote client; production does not require a Mac process or disk.

## Runtime

- Ubuntu 24.04 LTS, Node.js 24 (22.21+ is also supported), Python 3.12 and uv.
- Production checkout: `/home/user/projects/eagleye` on the Toshiba SSD.
- Production SQLite database: `/home/user/projects/eagleye/eagleye.db`.
- API and frontend: `https://eagleye.udify.fun/`.
- MCP: `https://eagleye-mcp.udify.fun/mcp` (authentication required).
- User services: `argus-eagleye`, `argus-eagleye-mcp`,
  `argus-eagleye-mcp-proxy`, and `argus-eagleye-xhs`.
- Cloudflare ingress is host infrastructure, managed separately from this repo.

See [the ThinkPad runbook](deploy/thinkpad/README.md) for remote development,
backup, recovery and service checks. Existing Docker and macOS deployment files
are historical alternatives; they are not the validated ThinkPad deployment.

## Development

```sh
export PATH="$HOME/.local/bin:$PATH"
npm ci
npm run lint
npm test
npm run test:pipeline
uv sync --locked --project kg-worker
uv run --project kg-worker python -m unittest discover -s kg-worker/tests
```

Use a separate worktree and test database for development. Never run test or
restore commands against the production database. Verify the scripts and their
targets before invoking a collector, pipeline or deployment.

## Repository boundaries

Source, migrations, dependency locks, tests and deployment templates belong in
Git. Databases, credentials, cookies, local agent state and dependency caches do
not. A clone restores code; it does not restore the intelligence corpus, user
accounts, model settings or external authentication.

The repository remains private. Opening the source is a separate decision that
requires reviewing data, credentials, dependencies and licensing first.
