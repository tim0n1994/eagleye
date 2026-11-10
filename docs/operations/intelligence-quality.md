# Topic yield and evidence events (rules v1)

The three industry pages display a collapsible quality table and link to
`/discover?industry=physical|education|neuroscience&days=30&sort=sources`.
`GET /api/intelligence-quality?industry=education&days=30` uses the existing
API authentication. No new network or model calls occur on page reads.

## Metric contract

The denominator is indexed, stored information records within the selected
publication window, across sources (including disabled sources' retained data).
Missing publication dates fall back to collection time and are counted in
inferred_dates. Counts describe stored coverage, not everything a publisher
published or everything rejected during collection.

Raw title/summary and source rules classify each record independently for all
three industries. Education reuses its existing education classifier; embodied
AI reuses its robotics classifier; neuroscience uses curated neuroscience
sources and explicit neuroscience keywords. Curated education tool releases
also qualify. Generated source-title prefixes are removed before classification.
No LLM score is presented as ground truth.

Matched counts are rule matches. Effective counts are distinct matched events
with usable titles/URLs and no duplicate marker. Effective rate = effective /
indexed records. Source rows deduplicate within a source; the total deduplicates
across sources, so source effective counts do not sum to the global count.
Redundancy/ineligible rate = (matched - effective) / matched; zero denominators
are null. It is not an editorial quality or factual-correctness score.
During backfill, pending/partial explicitly identifies incomplete coverage.

## Grouping contract

Strong keys: normalized canonical URL, explicit DOI or arXiv identifier in the
canonical URL/paper metadata. Functional URL queries stay intact; only tracking
parameters, fragments and Xiaohongshu transport tokens are removed. Different
release tag paths remain different events. Same paper identifiers group study
coverage, not distinct scientific claims or independent corroboration.

Near-title matching: at least six shared tokens, Jaccard >= 0.95, within +/-
three days of the original anchor, with identical number/negation signatures.
An inverted key index provides at most six lookups, forty candidates each;
there is no corpus-wide pairwise scan or transitive fuzzy union. Token matching
is conservative; cross-language paraphrases without a shared identifier can
remain separate. Ambiguous material remains separate rather than invoking a
model. Event ids persist, original records and links are never deleted, and
evidence reports url/doi/arxiv/title_similarity/standalone reasons.

The discovery page groups material by event before pagination. Industry pages
retain their original article feed and provide an explicit merged-event view.
The existing discovery reader retains its 6000-record window bound, shows
partial coverage when hit, and exposes only evidence in that read window.

## Runtime

Migration 056 creates a durable insert-trigger queue and seeds existing items.
A dedicated worker drains 200 records per SQLite transaction, yields 100ms
between nonempty batches and polls every 5s when idle. A two-second lock timeout
leaves the queue intact on failure. Matching/classification never blocks the
HTTP JavaScript thread. Analytics queries run in the existing read worker;
quality responses cache for 60s and radar snapshots for 5 minutes.

No model costs are added. Rule v1 classifies ingestion-time raw content; later
LLM enrichment does not continuously reclassify the corpus. A future rule
revision can requeue affected ids explicitly. Deletion cascades remove queued
and indexed item facts; immutable event anchor metadata may remain.

Nature Neuroscience uses curl's existing host-proxy/redirect path, capped at
25 seconds and 4MiB per response with cancellation and shared host limits. It
still uses the same parser, post-save validators, deduplication and source
health ledger. Other RSS sources keep their existing transport.

Rollback: restore the previous application release. Migration 056 is additive;
leave its tables/queue intact for a later resume. Do not restore the full DB or
delete source articles to undo an event association.
