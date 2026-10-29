"""Exercise policy changes on disposable files/SQLite only; never touch production."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
OPS = ROOT / 'deploy/thinkpad'
spec = importlib.util.spec_from_file_location('storage_policy', OPS / 'install-storage-policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class StoragePolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.backups = self.root / 'deploy'
        self.backups.mkdir()
        self.env = {**os.environ, 'EAGLEYE_DEPLOY_BACKUPS': str(self.backups),
                    'EAGLEYE_LEGACY_BACKUPS': str(self.root / 'legacy'),
                    'XDG_RUNTIME_DIR': str(self.root)}

    def backup(self, name, stamp, verified=True):
        p = self.backups / name
        p.parent.mkdir(exist_ok=True)
        with p.open('wb') as f:
            f.write(b'SQLite format 3\x00')
            f.truncate(104861696) # Sparse fixture, no large allocation.
        os.utime(p, (stamp, stamp))
        if verified:
            Path(str(p) + '.manifest.json').write_text(json.dumps({
                'integrity_check': 'ok', 'page_count': 25601, 'page_size': 4096}))
        return p

    def prune(self, *args):
        return subprocess.run(['bash', str(OPS / 'eagleye-backup-prune.sh'), *args],
                              env=self.env, text=True, capture_output=True)

    def test_dry_run_then_prune_keeps_newest_and_outside_scope(self):
        old = self.backup('old/backup.db', 1)
        newest = self.backup('extensionless-release', 3)
        middle = self.backup('middle.db', 2)
        sidecar = Path(str(old) + '-wal')
        sidecar.write_bytes(b'old sidecar')
        migration = self.root / 'migration.db'
        migration.write_bytes(b'protected history')
        result = self.prune('--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('WOULD_DELETE'), 2)
        self.assertTrue(old.exists())
        result = self.prune()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(newest.exists())
        self.assertFalse(old.exists())
        self.assertFalse(middle.exists())
        self.assertFalse(sidecar.exists())
        self.assertEqual(migration.read_bytes(), b'protected history')
        self.assertIn('deleted=0', self.prune().stdout)

    def test_incomplete_newest_cannot_displace_verified_backup(self):
        old = self.backup('old.db', 1)
        self.backup('new.db', 2, verified=False)
        self.assertNotEqual(self.prune().returncode, 0)
        self.assertTrue(old.exists())

    def test_bad_newest_size_stops_deletion(self):
        old = self.backup('old.db', 1)
        new = self.backup('new.db', 2)
        with new.open('ab') as f:
            f.write(b'incomplete')
        self.assertNotEqual(self.prune().returncode, 0)
        self.assertTrue(old.exists())

    def test_open_backup_is_skipped(self):
        old = self.backup('old.db', 1)
        self.backup('new.db', 2)
        with old.open('rb'):
            result = self.prune()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('IN_USE_SKIP', result.stdout)
        self.assertTrue(old.exists())

    def test_empty_directory_succeeds(self):
        self.assertEqual(self.prune().returncode, 0)

    def test_schedule_preserves_receipts_and_personal_rows(self):
        db = self.root / 'app.db'
        original = {'enabled': False, 'time': '04:00', 'task': 'pipeline',
                    'lastRun': '2026-10-29 01:00', 'last_job_id': 'existing', 'attempt_count': 1}
        with sqlite3.connect(db) as con:
            con.execute('CREATE TABLE user_data(key TEXT, user_id TEXT, value TEXT, PRIMARY KEY(key,user_id))')
            con.execute('INSERT INTO user_data VALUES(?,?,?)', ('scheduler_config', '', json.dumps(original)))
            con.execute('INSERT INTO user_data VALUES(?,?,?)', ('scheduler_config', 'personal', '{"enabled":false}'))
        self.assertTrue(policy.scheduler(db)['change_needed'])
        with sqlite3.connect(db) as con:
            self.assertEqual(json.loads(con.execute("SELECT value FROM user_data WHERE user_id='' ").fetchone()[0]), original)
        policy.scheduler(db, apply=True)
        self.assertFalse(policy.scheduler(db, apply=True)['change_needed'])
        with sqlite3.connect(db) as con:
            new = json.loads(con.execute("SELECT value FROM user_data WHERE user_id='' ").fetchone()[0])
            self.assertEqual(new, {**original, **policy.SCHEDULE})
            self.assertEqual(con.execute("SELECT value FROM user_data WHERE user_id='personal'").fetchone()[0], '{"enabled":false}')

    def test_missing_database_is_never_created(self):
        p = self.root / 'missing.db'
        for apply in (False, True):
            with self.assertRaises(sqlite3.OperationalError):
                policy.scheduler(p, apply=apply)
        self.assertFalse(p.exists())

    def test_installer_masks_snapshot_without_starting_backup_or_app(self):
        unit_dir = self.root / '.config/systemd/user'
        unit_dir.mkdir(parents=True)
        old = unit_dir / 'eagleye-snapshot.timer'
        old.write_text('[Timer]\nOnCalendar=daily\n')
        calls = []

        def systemctl(*args):
            calls.append(args)
            if args[0] == 'mask' and not old.is_symlink():
                old.symlink_to('/dev/null')

        with patch.object(policy, 'systemctl', systemctl):
            policy.install(self.root)
            policy.install(self.root)
        self.assertEqual(old.readlink(), Path('/dev/null'))
        self.assertIn('OnCalendar=daily', (unit_dir / 'eagleye-snapshot.timer.disabled').read_text())
        self.assertIn(('mask', '--now', 'eagleye-snapshot.timer'), calls)
        self.assertFalse(any('restart' in c or 'start' in c for c in calls))
        self.assertFalse(any('enable' in c and 'eagleye-snapshot.timer' in c for c in calls))


if __name__ == '__main__':
    unittest.main()
