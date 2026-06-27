-- Eagleye Schema Migration 002: i18n Translation Fields
-- Adds Chinese (_zh) translations for items, summaries, sources, topics.

ALTER TABLE information_items ADD COLUMN title_zh TEXT;

ALTER TABLE ai_summaries ADD COLUMN ai_title_zh TEXT;
ALTER TABLE ai_summaries ADD COLUMN one_liner_zh TEXT;
ALTER TABLE ai_summaries ADD COLUMN short_summary_zh TEXT;
ALTER TABLE ai_summaries ADD COLUMN key_points_zh TEXT;
ALTER TABLE ai_summaries ADD COLUMN why_it_matters_zh TEXT;

ALTER TABLE sources ADD COLUMN label_zh TEXT;
ALTER TABLE sources ADD COLUMN description_zh TEXT;

ALTER TABLE topics ADD COLUMN name_zh TEXT;
ALTER TABLE topics ADD COLUMN description_zh TEXT;

-- Translation status tracking (pending | translated | failed | n/a)
ALTER TABLE information_items ADD COLUMN title_zh_status TEXT DEFAULT 'pending';
ALTER TABLE ai_summaries ADD COLUMN translation_status TEXT DEFAULT 'pending';
ALTER TABLE sources ADD COLUMN translation_status TEXT DEFAULT 'pending';
ALTER TABLE topics ADD COLUMN translation_status TEXT DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_items_title_zh ON information_items(id) WHERE title_zh IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_summaries_translation_status ON ai_summaries(translation_status);
CREATE INDEX IF NOT EXISTS idx_items_title_zh_status ON information_items(title_zh_status);
