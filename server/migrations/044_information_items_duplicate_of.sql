-- 043_information_items_duplicate_of.sql — R3.0 历史跨天重复治理（软标记，不做物理删除）
--
-- 根因: 001_initial_schema 的 UNIQUE(source_id, canonical_url, digest_date) 允许同一
-- URL 每个 digest_date 重插一行。生产实测（DUP_DIAG，只读口径 2026-10-20）：65,916 行中
-- 32,446 行是 (source_id, canonical_url) 组内非首行（10,400 个重复组；10-19 单日
-- 3,638/4,419 = 82%，与 CTO 实测一致）。
--
-- 本迁移纯加法，只加列 + 索引；不回填、不动既有列、不削弱 UNIQUE 三元组（根因修复
-- 不在 R3.0 范围）：
--   duplicate_of = 组内首行 id —— 保留每组 ORDER BY created_at ASC, id ASC 的最早一行，
--   其余行指向首行。回填由 scripts/dup-backfill.py 独立执行（幂等，stdout 输出
--   DUP_BACKFILL_OK/ALREADY 标记），与部署分离，迁移保持轻量可逆。
-- 回滚 = UPDATE information_items SET duplicate_of = NULL（整列置空，完全可逆）；
-- 物理清理（连依赖行）放 R5 retention，不在本轮。
--
-- 列契约: TEXT / 可空 / 无默认 —— 存量行自动为 NULL；不感知该列的 INSERT 照常工作。
-- 下游消费: drainer/enrich/kg 积压选取谓词一律排除 duplicate_of IS NOT NULL；
-- digest/搜索/计数默认排除；R5 沿该列连依赖行 —— 全都要按这列扫，故需要索引。

ALTER TABLE information_items ADD COLUMN duplicate_of TEXT;

CREATE INDEX IF NOT EXISTS idx_items_duplicate_of ON information_items (duplicate_of);
