#!/usr/bin/env node
'use strict';

// Eagleye — minimal backup tool (R0-09)
//
// Uses the better-sqlite3 online backup API, which produces a WAL-consistent
// snapshot of a live database without stopping the server. NEVER copy a
// running eagleye.db with cp/rsync — that can tear WAL state.
//
// Usage:
//   node scripts/backup-eagleye.js --db <source.db> --out <dest.db | destDir> [--force]
//
// Source defaults to $EAGLEYE_DB_PATH when --db is omitted; there is NO silent
// fallback to the repo-root production database. The source is opened
// read-only. A sidecar "<dest>.manifest.json" records integrity_check and
// per-table row counts for scripts/restore-verify.js.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return args;
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

function quotedIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/backup-eagleye.js --db <src> --out <dest.db|dir> [--force]');
    process.exit(0);
  }

  const src = args.db || process.env.EAGLEYE_DB_PATH;
  if (!src || !src.trim()) {
    console.error('backup: no source DB — pass --db or set EAGLEYE_DB_PATH');
    process.exit(2);
  }
  const srcPath = path.resolve(src.trim());
  if (!fs.existsSync(srcPath)) {
    console.error('backup: source DB not found: ' + srcPath);
    process.exit(2);
  }
  if (!args.out) {
    console.error('backup: --out <dest.db|destDir> is required');
    process.exit(2);
  }

  let dest = path.resolve(args.out);
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      dest = path.join(dest, 'eagleye-' + stamp + '.db');
    }
  } catch {
    // stat failed -> treat --out as a file path
  }
  if (fs.existsSync(dest) && !args.force) {
    console.error('backup: destination already exists: ' + dest + ' (pass --force to overwrite)');
    process.exit(3);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const source = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(dest); // online backup API: WAL-consistent snapshot
  } finally {
    source.close();
  }

  // Inspect the snapshot read-only and emit a manifest for restore-verify.js.
  const snapshot = new Database(dest, { readonly: true });
  const manifest = {
    source: srcPath,
    created_at: new Date().toISOString(),
    dest,
    page_count: null,
    page_size: null,
    integrity_check: null,
    tables: {},
  };
  try {
    manifest.page_count = snapshot.pragma('page_count', { simple: true });
    manifest.page_size = snapshot.pragma('page_size', { simple: true });
    manifest.integrity_check = snapshot.pragma('integrity_check', { simple: true });
    for (const name of tableNames(snapshot)) {
      try {
        manifest.tables[name] = snapshot.prepare('SELECT COUNT(*) AS c FROM ' + quotedIdent(name)).get().c;
      } catch (err) {
        manifest.tables[name] = null; // counted as skipped by restore-verify
        manifest['table_error:' + name] = String((err && err.message) || err);
      }
    }
  } finally {
    snapshot.close();
  }

  const manifestPath = dest + '.manifest.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({
    ok: true,
    dest,
    manifest: manifestPath,
    integrity_check: manifest.integrity_check,
    tables: Object.keys(manifest.tables).length,
  }));
}

main().catch((err) => {
  console.error('backup failed:', (err && err.message) || err);
  process.exit(1);
});
