-- Eagleye Schema Migration 004: Skills Table
-- Phase 5: Persist skills data in the database instead of in-memory.
-- The skills table stores the 40+ built-in Claude Code Skills with
-- categories, tags, GitHub stats, and installation metadata.

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',       -- JSON array of tag strings
  repo_url TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  forks INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  install_command TEXT,
  installs TEXT NOT NULL DEFAULT '0/week',
  source TEXT NOT NULL DEFAULT 'builtin', -- builtin | github | awesome-list | registry
  last_updated TEXT,                     -- ISO date string
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
CREATE INDEX IF NOT EXISTS idx_skills_slug ON skills(slug);
CREATE INDEX IF NOT EXISTS idx_skills_stars ON skills(stars DESC);
