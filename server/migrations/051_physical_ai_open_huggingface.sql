-- Physical AI — Hugging Face open robotics/embodied models and datasets.
-- Official hub search APIs only (/api/models, /api/datasets); the connector
-- enforces public (private=false, gated=false), the shared known-open
-- license allowlist (services/physical-ai-classifier.js OPEN_LICENSES),
-- explicit robotics/embodied evidence in the resource itself, real
-- createdAt timestamps, and per-author anti-flood caps.
INSERT OR IGNORE INTO sources
  (id, slug, label, description, homepage_url, feed_url, connector_type, is_active)
VALUES
  ('s-physical-ai-open-huggingface', 'physical-ai-open-huggingface',
   'Physical AI — Hugging Face Open Models & Datasets',
   'Openly licensed robotics/embodied-AI models and datasets from the Hugging Face Hub',
   'https://huggingface.co', NULL, 'physical-ai-open-huggingface', 1);
