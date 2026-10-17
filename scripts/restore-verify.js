#!/usr/bin/env node
'use strict';

// Eagleye — restore verification (R0-09)
//
// Verifies a backup produced by scripts/backup-eagleye.js on a THROWAWAY COPY;
// the backup file itself is never opened for writing:
//   1. PRAGMA integrity_check on the copy
//   2. per-table row counts vs the backup manifest (exact match required)
//   3. readability sampling: SELECT the first N rows of each counted table
//
// Usage:
//   node scripts/restore-verify.js --backup <backup.db>
//        [--manifest <manifest.json>] [--sample 20] [--keep-workdir]

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = { sample: 20, keepWorkdir: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--backup') args.backup = argv[++i];
    else if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--sample') args.sample = Number(argv[++i]);
    else if (a === '--keep-workdir') args.keepWorkdir = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return args;
}

function quotedIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/restore-verify.js --backup <backup.db> [--manifest <m.json>] [--sample 20]');
    process.exit(args.help ? 0 : 2);
  }
  if (!args.backup) {
    console.error('restore-verify: --backup <backup.db> is required');
    process.exit(2);
  }
  const backupPath = path.resolve(args.backup);
  if (!fs.existsSync(backupPath)) {
    console.error('restore-verify: backup not found: ' + backupPath);
    process.exit(2);
  }
  const manifestPath = args.manifest
    ? path.resolve(args.manifest)
    : backupPath + '.manifest.json';

  // Work on a copy so the verification can never damage the backup itself.
  const workdir = path.join(os.tmpdir(), 'eagleye-restore-verify-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(workdir, { recursive: true });
  const copyPath = path.join(workdir, path.basename(backupPath));
  fs.copyFileSync(backupPath, copyPath);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(backupPath + suffix)) fs.copyFileSync(backupPath + suffix, copyPath + suffix);
  }

  const result = {
    ok: true,
    backup: backupPath,
    copy: copyPath,
    manifest: null,
    integrity_check: null,
    tables: {},
    sampled: {},
    mismatches: [],
  };

  const db = new Database(copyPath);
  try {
    try {
      result.integrity_check = db.pragma('integrity_check', { simple: true });
      if (result.integrity_check !== 'ok') result.ok = false;
    } catch (err) {
      result.integrity_check = 'error: ' + String((err && err.message) || err);
      result.ok = false;
    }

    const sample = Number.isFinite(args.sample) && args.sample >= 0 ? Math.floor(args.sample) : 20;

    if (fs.existsSync(manifestPath)) {
      result.manifest = manifestPath;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const [table, expected] of Object.entries(manifest.tables || {})) {
        if (expected === null || expected === undefined) {
          result.tables[table] = 'skipped (null in manifest)';
          continue;
        }
        let actual = null;
        try {
          actual = db.prepare('SELECT COUNT(*) AS c FROM ' + quotedIdent(table)).get().c;
          if (sample > 0) {
            const rows = db.prepare('SELECT * FROM ' + quotedIdent(table) + ' LIMIT ?').all(sample);
            result.sampled[table] = rows.length;
          }
        } catch (err) {
          result.tables[table] = 'error: ' + String((err && err.message) || err);
          result.ok = false;
          result.mismatches.push({ table, expected, actual: null });
          continue;
        }
        result.tables[table] = actual;
        if (actual !== expected) {
          result.ok = false;
          result.mismatches.push({ table, expected, actual });
        }
      }
    } else {
      result.manifest = null;
      result.note = 'no manifest found; integrity check only';
    }
  } finally {
    db.close();
  }

  console.log(JSON.stringify(result, null, 2));
  try {
    if (!args.keepWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
  } catch { /* temp cleanup is best-effort */ }
  process.exit(result.ok ? 0 : 1);
}

main();
