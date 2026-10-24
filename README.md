# Eagleye

> An evidence-linked intelligence pipeline for turning noisy sources into inspectable signals, graph edges, and briefs.

[![CI](https://github.com/tim0n1994/eagleye/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tim0n1994/eagleye/actions/workflows/ci.yml?query=branch%3Amain)
[![Latest internal release](https://img.shields.io/github/v/release/tim0n1994/eagleye?include_prereleases&label=release)](https://github.com/tim0n1994/eagleye/releases)

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
npm ci
npm run lint
npm test
npm run test:pipeline

uv sync --locked --project kg-worker
uv run --project kg-worker python -m unittest discover -s kg-worker/tests
```

The useful contract is small and deliberate:

- `npm run lint` catches JavaScript and repository hygiene errors.
- `npm test` exercises the application test suite.
- `npm run test:pipeline` checks cross-language pipeline behavior.
- The `kg-worker` command runs the graph worker's Python tests against its locked environment.

## Release line

The current verified code line is available as [`v1.1.0-internal.1`](https://github.com/tim0n1994/eagleye/releases/tag/v1.1.0-internal.1). The main branch is continuously checked by [GitHub Actions](https://github.com/tim0n1994/eagleye/actions/workflows/ci.yml).

A release packages code. It does not package the live intelligence corpus, external accounts, credentials, or a production host.

## Repository status

Eagleye is currently kept private while the repository completes a broader provenance, secret, dependency, and licensing review. The README is intentionally honest about that boundary: passing CI establishes a reproducible code line, not public-release clearance.