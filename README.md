# Eagleye

> An evidence-linked intelligence pipeline for turning noisy sources into inspectable signals, graph edges, and briefs.

[![CI](https://github.com/tim0n1994/eagleye/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tim0n1994/eagleye/actions/workflows/ci.yml?query=branch%3Amain)
[![Latest release](https://img.shields.io/github/v/release/tim0n1994/eagleye?label=release)](https://github.com/tim0n1994/eagleye/releases)
[![License](https://img.shields.io/github/license/tim0n1994/eagleye)](LICENSE)
[![Security policy](https://img.shields.io/badge/security-policy-blue)](SECURITY.md)

A scraper stops at documents. A chatbot stops at prose. **Eagleye keeps the chain between source and brief inspectable.**

It collects signals, preserves their provenance, enriches them, connects them into a knowledge graph, and produces operator-facing briefs without pretending that an unverified output is an observed fact.

## The pipeline

```text
 source adapters
       │
       ▼
 ingest ledger ───────► provenance · health · retry state
       │
       ├───────────────► enrichment · translation
       │                              │
       │                              ▼
       └───────────────► API / MCP ─► knowledge graph ─► briefs
```

Eagleye is a dataflow with memory:

- **Collect** from replaceable source adapters.
- **Normalize** incoming material into durable, inspectable records.
- **Enrich** with translation, classification, extraction, and derived metadata.
- **Connect** records into graph entities and relationships.
- **Brief** only after the evidence path is still available.
- **Report health** when a feed cools down, fails, or loses convergence.

## Design rules

### Evidence before interpretation

Every derived item should be traceable to the source material that produced it. A brief is a view over evidence, not a replacement for it.

### State before optimism

Cooldowns, authentication failures, retries, cancellation, and partial convergence are first-class states. The pipeline records what did not happen as carefully as what did.

### Runtime is an input

The repository contains the system that processes a corpus. It does not contain the corpus, credentials, cookies, user accounts, model settings, or dependency caches required by a particular deployment.

### Boundaries are part of the product

Collectors, workers, API routes, MCP tools, storage, and deployment templates have different failure modes. Keeping those boundaries explicit makes the system debuggable and the release surface reviewable.

## What lives here

| Surface | Responsibility |
| --- | --- |
| `server/` | ingestion, source adapters, enrichment, API, and persistence |
| `kg-worker/` | graph extraction and knowledge graph jobs |
| `mcp/` | model-facing tools with an explicit protocol boundary |
| `scripts/` | repeatable checks, maintenance, and operator utilities |
| `deploy/` | deployment templates and environment contracts |
| `docs/` | design notes, runbooks, and release evidence |

The code is designed to run with a separate test database and a separately managed runtime environment. Do not point tests, restore commands, or collector jobs at production data.

## Development

Requirements:

- Node.js 22.21+ or 24+
- Python 3.12
- [`uv`](https://docs.astral.sh/uv/)

```sh
cp .env.example .env

npm ci
npm run lint
npm test
npm run test:pipeline

uv sync --locked --project kg-worker
uv run --project kg-worker python -m unittest discover -s kg-worker/tests
```

Set `EAGLEYE_DB_PATH` to a disposable local database before starting the
server. The default server listens on port `3019`:

```sh
EAGLEYE_DB_PATH=./eagleye.db node server.js 3019
```

Credentials, authenticated source sessions, model gateway configuration, and
production databases are intentionally absent from this repository. Use
`.env.example` as the configuration inventory and keep real values in `.env`
or the host's secret manager.

The useful contract is small and deliberate:

- `npm run lint` catches JavaScript and repository hygiene errors.
- `npm test` exercises the application test suite.
- `npm run test:pipeline` checks cross-language pipeline behavior.
- The `kg-worker` command runs the graph worker's Python tests against its locked environment.

## Deployment and readback

The repository includes Docker templates in `deploy/` and the ThinkPad
systemd runbook in [`deploy/thinkpad/README.md`](deploy/thinkpad/README.md).
The public release contains deployment instructions and service contracts; a
production deployment still requires a separately managed database, secrets,
source sessions, egress policy, and host service units.

After a deployment, verify the process, the authenticated business path, and
the pipeline state separately:

```sh
systemctl --user is-active argus-eagleye.service
curl --fail http://127.0.0.1:3019/
node scripts/restore-verify.js --backup /path/to/verified-backup.db
```

Do not treat an HTTP health response or a running process as proof that source
authentication, digest generation, Outbox dispatch, or knowledge graph
convergence is working. The ThinkPad runbook documents the bounded production
readback and rollback sequence.

## Release line

The current stable code line is [`v1.1.0`](https://github.com/tim0n1994/eagleye/releases/tag/v1.1.0). The main branch is continuously checked by [GitHub Actions](https://github.com/tim0n1994/eagleye/actions/workflows/ci.yml). Dependency updates are proposed by [Dependabot](https://github.com/tim0n1994/eagleye/security/dependabot), and every release tag runs the release verification workflow.

A release packages code. It does not package the live intelligence corpus, external accounts, credentials, or a production host.

## Public repository status

Eagleye is released under the [ISC License](LICENSE). The public repository is
the reproducible application code and its operational contracts. Live data,
credentials, authenticated sessions, model access, and host-specific runtime
state remain outside Git. See the [security policy](SECURITY.md) before
reporting a vulnerability.
