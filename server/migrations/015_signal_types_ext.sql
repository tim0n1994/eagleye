-- 015: Extend signal taxonomy with two new types.
--   supply_chain — hardware / supply chain / industry dynamics
--     (rescues physical-ai-cn-photonics and similar industry feeds)
--   agent_signal — AI agent / MCP / tool-use / autonomous proxy progress
-- Frontend is data-driven (/api/signal-types), so no UI changes needed.
-- INSERT OR IGNORE keeps this idempotent and safe to re-run.

INSERT OR IGNORE INTO signal_types (slug, name, name_zh, description, sort_order, icon) VALUES
  ('supply_chain', 'Supply Chain', '供应链信号', '硬件/供应链/产业动态', 13, '⚙️'),
  ('agent_signal', 'Agent Signal', '智能体信号', 'AI agent/智能体/MCP进展', 14, '🤖');
