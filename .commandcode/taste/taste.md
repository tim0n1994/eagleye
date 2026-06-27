# webui-layout
- For eagleye WebUI: Display feed items in 3-column card layout, never single-column. Confidence: 0.90
- Feed item cards should show 2-3 lines of LLM-generated summary without truncation. Confidence: 0.85

# source-ordering
- Source order: X (𝕏) first, then Hacker News, GitHub Trend, Hugging Face, Product Hunt, then others. Confidence: 0.90
- Source ordering must be consistent between source list page and news page. Confidence: 0.90

# llm-processing
See [llm-processing/taste.md](llm-processing/taste.md)
# deep-research
- Each 🔍 (deep research) click must open a new independent page/tab for that specific feed item. Confidence: 0.85
- Deep research pages must include a chat window for user-LLM interaction. Confidence: 0.85

# performance
- Prefer maximum parallel processing for AI summaries and feed enrichment, not small batches. Confidence: 0.85
- Optimize the entire feed pipeline (aggregation → classification → LLM summarization → translation) for extreme performance. Confidence: 0.85

# ports
- Eagleye runs on port 3019 (NOT 3001 — 3001 is taken by Salon9's ws-proxy). Configure DEFAULT_APP_PORT in server/config.js, comment in server.js, and `start` script in package.json. Confidence: 0.90
- Eagleye server.js PID is tracked in server.pid; start with `nohup node server.js > server.log 2>&1 &` and `echo $! > server.pid`. Use `lsof -nP -iTCP:3019 -sTCP:LISTEN` to verify it's alive. Confidence: 0.85
- Never kill processes belonging to other projects (e.g., Salon9's ws-proxy on 3001) to free up ports. If a port is occupied by another project's process, ask the user before taking action. Confidence: 0.90

# ui-cleanup
- Remove top navigation items: 📅 yearly archive, ⚖️, and 对比 (compare) — and their associated code. Confidence: 0.85

# knowledge-graph
See [knowledge-graph/taste.md](knowledge-graph/taste.md)
# architecture
- Prioritize modifying/leveraging ClawFeed as a foundation rather than building from scratch. Confidence: 0.75
- When adding a new parameterized API route (e.g., /api/tags/:slug), register it in both server/routes/api.js (handler) AND server.js paramRoutes array (regex pattern), and always decodeURIComponent on matched path segments to handle Chinese/unicode slugs. Confidence: 0.80

# communication
- When wrapping up work, provide a concise summary of key achievements rather than listing every file touched. Confidence: 0.75
