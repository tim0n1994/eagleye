'use strict';

// Shared by the scheduler and operations counters. n/a is complete when the
// Chinese fields exist. Callers use i (item), s (summary), and src (source).
function pendingTranslationWhere({ retryBlocked = false } = {}) {
  return `(
    i.title_zh IS NULL OR i.title_zh = '' OR i.title_zh_status = 'pending'
    OR s.item_id IS NULL
    OR s.ai_title_zh IS NULL OR s.ai_title_zh = ''
    OR s.one_liner_zh IS NULL OR s.one_liner_zh = ''
    OR s.short_summary_zh IS NULL OR s.short_summary_zh = ''
    OR s.translation_status = 'pending'
  ) ${retryBlocked ? '' : "AND COALESCE(s.translation_status, '') != 'blocked'"}`;
}

function countPendingTranslations(db) {
  return db.prepare(`SELECT COUNT(DISTINCT i.id) AS count
    FROM information_items i JOIN sources src ON src.id = i.source_id
    LEFT JOIN ai_summaries s ON s.item_id = i.id
    WHERE ${pendingTranslationWhere()}`).get().count;
}

module.exports = { pendingTranslationWhere, countPendingTranslations };
