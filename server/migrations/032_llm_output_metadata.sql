ALTER TABLE ai_summaries ADD COLUMN llm_metadata TEXT DEFAULT '{}';
ALTER TABLE daily_digests ADD COLUMN llm_metadata TEXT DEFAULT '{}';
ALTER TABLE research_reports ADD COLUMN llm_metadata TEXT DEFAULT '{}';
