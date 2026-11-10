# Independent collection and processing

Enable `COLLECTION_SCHEDULE_ENABLED=1` in the private application environment
and keep scheduler_config enabled. Set its daily task to `digest` (01:00 local)
to stop running the full analysis pipeline on every collection. Manual full
pipelines remain available. Reverting to task=pipeline and disabling the env
flag restores daily orchestration without removing data or checkpoints.

Default cadence (overridable by sources.expected_interval_hours): news 6h,
release feeds 12h, papers and Xiaohongshu 24h, Startup Archive 168h. X remains
owned by its existing independent 2h timer. source_collection_state persists
next_due_at, last request/parse/commit, outcome and latest counts. Failures retry
after 30m with exponential backoff capped at the source interval. Manual partial
samples retry after 5m and do not advance the full-feed commit checkpoint.

Shared connector admission: 4 source rounds, 1 per source, 2 requests per host,
500ms spacing per host. Tune COLLECTION_CONCURRENCY,
COLLECTION_HOST_CONCURRENCY and COLLECTION_HOST_SPACING_MS. Host limits apply
to shared HTTP/RSS transports; browser/CLI adapters retain their own pacing.
These are process-local limits, not distributed locks.

RSS validators use a new v2 key and commit only after successful parsing and
storage of the complete returned set. Old early-written validators are ignored
once so retained feed entries can be recovered. Feed entries are no longer
truncated by a 36h cutoff or release/archive slice. Intentional relevance filters
still apply. API connectors using the shared date-window contract expand their
lookback from last successful commit with 24h overlap (initial 7d, max 30d).
Publisher feed retention and API pagination limits still bound recoverable
history: this is not a complete historical archive.

Successful empty and 304 rounds refresh availability, but do not invent new
content timestamps. /api/sources includes the collection object; source cards
show latest outcome, inserted/duplicate counts and next due time.

Raw saved items are immediately readable. Existing bounded enrichment and KG
queue drainers stay enabled; translations have an independent hourly batch of
50 and yield to active enrichment. Summaries prioritize the three specialist
source families. Daily digest also refreshes cheap source profiles/entity
statistics. Topic graph and tag hierarchy run separately weekly when idle;
the first run is scheduled a week after enabling. No new model or broker is
required. Cross-publication semantic event merging remains a separate feature;
URL/content deduplication and source quality profiles continue to be used.

Verification: syntax/lint, production migration/startup, authenticated source
API and one real feed round. No synthetic tests or load benchmark are required
for this delivery; content acceptance belongs to the operator.
