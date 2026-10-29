"""Growth accounting regression fixtures; no production DB access."""
from datetime import datetime, timedelta, timezone
import fcntl
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('growth', Path(__file__).resolve().parents[1] /
                                             'deploy/thinkpad/eagleye-growth-report.py')
growth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(growth)


class GrowthReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root / 'test.db'
        self.log = self.root / 'observations.jsonl'
        self.now = datetime(2026, 10, 29, 10, tzinfo=timezone.utc)
        with sqlite3.connect(self.db) as con:
            con.executescript('''CREATE TABLE information_items(created_at TEXT);
                CREATE TABLE ai_summaries(id INTEGER);
                CREATE TABLE dynamic_topics(id INTEGER);
                CREATE TABLE outbox(dispatched_at TEXT);
                INSERT INTO outbox VALUES(NULL), ('2026-10-29 09:00:00');''')
            con.executemany('INSERT INTO information_items VALUES(?)', [
                ('2026-10-28 11:00:00',), ('2026-10-29T17:00:00+08:00',),
                ('2026-10-28 09:59:59',), ('2026-10-28T12:00:00+08:00',),
                ('2026-10-30 01:00:00',)])

    def test_utc_window_offsets_and_no_database_mutation(self):
        before = self.db.read_bytes()
        row = growth.report(self.db, self.log, self.now)
        self.assertEqual(row['items_created_24h'], 2)
        self.assertEqual(row['information_items'], 5)
        self.assertEqual(row['outbox_pending'], 1)
        self.assertEqual(row['wal_bytes'], 0)
        self.assertIsNone(row['elapsed_seconds'])
        self.assertEqual(self.db.read_bytes(), before)
        self.assertEqual(self.log.stat().st_mode & 0o777, 0o600)

    def test_legacy_history_and_partial_interval(self):
        previous = {'observed_at': '2026-10-29T17:00:00+08:00',
                    'db_bytes': self.db.stat().st_size + 4096, 'information_items': 3}
        self.log.write_text(json.dumps(previous) + '\n')
        row = growth.report(self.db, self.log, self.now)
        self.assertEqual(row['elapsed_seconds'], 3600)
        self.assertEqual(row['items_delta'], 2)
        self.assertEqual(row['db_delta_bytes'], -4096)
        self.assertEqual(json.loads(self.log.read_text().splitlines()[0]), previous)

    def test_retention_is_bounded(self):
        rows = [{'observed_at': (self.now - timedelta(days=i)).isoformat(),
                 'db_bytes': 1, 'information_items': 1} for i in range(370, 0, -1)]
        self.log.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        growth.report(self.db, self.log, self.now)
        self.assertEqual(len(self.log.read_text().splitlines()), 365)

    def test_corrupt_history_is_preserved(self):
        self.log.write_text('{broken\n')
        with self.assertRaises(ValueError):
            growth.report(self.db, self.log, self.now)
        self.assertEqual(self.log.read_text(), '{broken\n')

    def test_missing_database_is_not_created(self):
        missing = self.root / 'absent.db'
        with self.assertRaises(sqlite3.OperationalError):
            growth.report(missing, self.log, self.now)
        self.assertFalse(missing.exists())
        self.assertFalse(self.log.exists())

    def test_simultaneous_writer_cannot_replace_history(self):
        growth.report(self.db, self.log, self.now)
        before = self.log.read_bytes()
        with Path(str(self.log) + '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                growth.report(self.db, self.log, self.now + timedelta(hours=1))
        self.assertEqual(self.log.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
