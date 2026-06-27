# Uncategorized
- When running full-pipeline rescores across many digest_date batches, add `llmSkipRuleMatched` (or equivalent) option to skip LLM calls for items already classified by source-overrides or keyword rules. Cuts LLM token usage ~30-40% and total runtime dramatically (10919 items dropped from 30min to 3.5min). Confidence: 0.85
- For Eagleye background jobs (signal rescoring, etc.), use 6 concurrent digest_date workers when running through a local LLM proxy that supports many parallel sockets (max 64). This saturates the proxy without overwhelming it. Confidence: 0.75
