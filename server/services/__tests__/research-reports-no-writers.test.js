/**
 * Research module sunset — research_reports has no writers (static assertion).
 *
 * Sunset decision ③: the research_reports table (2602 historical rows) is
 * KEPT read-only — mcp/research.js and the system stats COUNT()s still read
 * it, and row retention is R5's call — but nothing may write to it anymore.
 * 58650a7 already removed services/research.js (the only INSERT/UPDATE site);
 * this test pins that removal so a partial revert or a new code path cannot
 * silently resume writes (which would resurrect growth on a retired feature).
 *
 * This is a source-scan test: it walks the live code tree (server/, mcp/,
 * scripts/, kg-worker/, root scripts) and asserts no scanned file contains a
 * write statement against research_reports. Read-only references (SELECT /
 * COUNT) are explicitly allowed.
 *
 * Scope notes:
 * - server/migrations is excluded: migrations are one-shot deploy DDL/fixups;
 *   the R5 retention/zombie-row work may legitimately land there.
 * - Test files are excluded: they may quote the forbidden SQL while asserting
 *   its absence (this file itself would self-match).
 * - Only code extensions are read; DB snapshots and .bak-* copies are skipped.
 *
 * At the pre-sunset HEAD this passes already (58650a7 removed the writers);
 * it is a regression guard for the sunset, not a RED gate. The RED gates are
 * the UI and 410-route tests.
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..');

const SCANNED_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.py', '.sh', '.sql']);
const SKIP_DIRS = new Set(['node_modules', '.git', '__tests__', 'tests', 'coverage', 'migrations']);

function isSkippedFile(name) {
  return (
    /\.test\./.test(name) ||
    /\.spec\./.test(name) ||
    /\.bak/.test(name) ||
    /\.db/.test(name) ||
    /\.lock/.test(name) ||
    name === 'package-lock.json'
  );
}

function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listSourceFiles(path.join(dir, entry.name), out);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name)) && !isSkippedFile(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// SQLite write statement shapes (table name optionally quoted). These are the
// forms services/research.js historically used (INSERT INTO research_reports /
// UPDATE research_reports SET ...), plus the obvious variants.
const WRITER_PATTERNS = [
  { label: 'INSERT', re: /\binsert\s+(?:or\s+(?:replace|ignore|rollback|abort|fail)\s+)?into\s+[`"'[]?research_reports\b/i },
  { label: 'UPDATE', re: /\bupdate\s+[`"'[]?research_reports\b/i },
  { label: 'DELETE', re: /\bdelete\s+from\s+[`"'[]?research_reports\b/i },
  { label: 'REPLACE', re: /\breplace\s+into\s+[`"'[]?research_reports\b/i },
];

const files = listSourceFiles(REPO_ROOT);
const relativeFiles = files.map(file => path.relative(REPO_ROOT, file));

describe('research_reports write paths are removed', () => {
  it('scans the live code tree (walker sanity)', () => {
    // If the walker ever silently matches nothing, these bounds fail instead
    // of the writer scan vacuously passing on an empty file set.
    expect(files.length).toBeGreaterThan(60);
    expect(relativeFiles).toContain(path.join('server', 'routes', 'items.js'));
    expect(relativeFiles).toContain(path.join('server', 'services', 'system-stats.js'));
    expect(relativeFiles).toContain(path.join('mcp', 'queries.js'));
  });

  it('no scanned source file contains a write statement against research_reports', () => {
    const offenders = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { label, re } of WRITER_PATTERNS) {
        const match = text.match(re);
        if (match) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(`${path.relative(REPO_ROOT, file)}:${line} [${label}] ${text.split('\n')[line - 1].trim()}`);
        }
      }
    }
    expect(
      offenders,
      `research_reports writers must stay removed (table is read-only after the sunset):\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
