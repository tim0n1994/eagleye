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
