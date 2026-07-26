-- 025_non_tech_signal_type.sql — Add 'non_tech' signal type for noise classification
--
-- Problem: items with non-tech content (esports, sports, memes, politics) can't
-- map to any of the tech-focused signal types, so they all fall into 'uncategorized'.
-- This pollutes the radar with noise that looks like "unclassified signal".
--
-- Fix: add 'non_tech' as an explicit signal type so noise is clearly labeled and
-- can be excluded from signal views (getSignals excludeUncategorized now filters
-- both 'uncategorized' AND 'non_tech').

INSERT OR IGNORE INTO signal_types (slug, name, name_zh, description, sort_order, icon)
VALUES ('non_tech', 'Non-tech', '非技术噪音', '非技术内容（电竞/体育/社交媒体等噪音）', 98, '🔇');
