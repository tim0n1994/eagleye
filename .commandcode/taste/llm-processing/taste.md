# llm-processing
- All LLM calls must go through a local proxy endpoint; never call external cloud APIs directly. Confidence: 0.90
- All feed items must be processed through local LLM for Chinese translation, summarization, and knowledge card generation. Confidence: 0.90
- Every feed item title must be translated to Chinese by the local LLM. Confidence: 0.90
- X (Twitter) posts must be LLM-processed: replace empty/placeholder titles like "@user posted" with meaningful Chinese summaries. Confidence: 0.90
- Design LLM prompts that drive concise Chinese summarization (2-3 line knowledge cards) for each feed item. Confidence: 0.85
- The entire system must not use any mock/fake LLM responses; all LLM calls must go to a real LLM provider. Confidence: 0.85
- Tag-to-topic relationships in the knowledge graph must be many-to-many: a single tag can belong to multiple topics/sub-topics simultaneously (not strict tree hierarchy). Confidence: 0.85
- Internalize the LLM reasoning methodology for knowledge graph construction (hierarchy building, topic aggregation, tag clustering) as reusable prompt engineering / system instructions, so non-frontier LLMs can replicate the same quality. The "how to think" must be encoded in the system, not depend on a specific smart model. Confidence: 0.85
- During long-running full-pipeline jobs, show periodic numeric progress updates (items processed / total, percentage, current stage) rather than only a static "running" status. Users need to confirm the job is alive and see meaningful movement. Confidence: 0.90
