# Eagleye KG Worker

Python worker for Eagleye KG v2.

Phase 2 starts with deterministic extraction only:

- item features
- source tags
- keyword tags
- taxonomy assignment
- KG metrics

Later phases add FastEmbed, GLiNER, BERTopic, and optional Qdrant.

## Commands

```bash
uv run --project kg-worker eagleye-kg status
uv run --project kg-worker eagleye-kg extract --sources x-following,hacker-news,github-trending,hugging-face --limit 100
```

## Incremental processing

Omitting `--sources` selects every active source in the database. An explicit
source list restricts the run to that list. The Node pipeline passes the database
path from `getDBPath()` (`EAGLEYE_DB_PATH` or the repository default) to the CLI.
For isolated verification, always pass `--db /absolute/path/to/a/test.db` before
the subcommand. Extraction and hash embedding need no model service.

`extract --limit N` selects at most N missing or changed feature records. The
fingerprint includes content, source metadata, quality inputs, and extractor
version. Existing fingerprints predate this contract and are refreshed once.
Candidates are interleaved by source; if N is smaller than the source count,
sources with fewer processed records go first. Repeated runs therefore advance
the backlog instead of repeatedly selecting the highest-priority source. An
updated item replaces this worker's earlier evidence while retaining other
extractors' assignments.

`embed --limit N --backend hash` selects gaps for the exact vector type, model,
content hash, and text-length setting. Already-current vectors do not consume N.
The same selection applies to FastEmbed, which remains opt-in and may download
models. `--force` deliberately selects existing records too.

`topics --limit N` is a **source-balanced sample**, not a full-corpus topic
rebuild. It replaces semantic-lite assignments and edges only for the selected
items, including when `--sources` is supplied. Unsampled items retain their
associations. Shared-topic counts and representative items are recomputed from
the retained and new associations. All graph changes and the successful run
record commit together; exceptions roll back to the previous graph. An empty
selection is a no-op. Small samples can miss groups below `--min-items`, and the
reported `by_source`, `selection`, and `replacement_scope` describe that limit.
Hash vectors and co-occurrence topics do not establish semantic model quality.
The automatic Node pipeline uses a bounded 1,000-item topic sample. Reads and
grouping occur before the writer transaction; `timings` separates selection,
tag/entity loading, grouping, and the atomic write phase. Migration 030 provides
the per-item taxonomy lookup index; apply normal application migrations before
running the worker directly against an existing database.
The tag query starts from selected item assignments and then looks up each tag
by primary key. Reordering that join to start from all active tags multiplies
work by the sample size; the regression suite enforces a SQLite instruction
budget with thousands of unrelated active tags.
If another connection commits during preparation, the worker rechecks the
selected inputs after acquiring its write lock. Changed content, tags, or entity
inputs cause a retryable failure before any graph replacement. Unrelated writes
such as login sessions pass that check and do not cancel the topic run.

## Offline regression tests

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=kg-worker python3 -m unittest discover -s kg-worker/tests -v
npm test -- server/services/__tests__/kg-worker.test.js
```

Python tests create fresh in-memory SQLite databases from the schema migrations;
Node tests capture subprocess arguments against a temporary database path. They
do not open the repository database, invoke the worker, or call model services.
