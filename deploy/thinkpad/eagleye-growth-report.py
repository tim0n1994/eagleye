#!/usr/bin/env python3
"""Read-only ingestion/storage accounting; never copy or modify the database."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import tempfile


def observe(db_path, now):
    with sqlite3.connect(db_path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.execute('BEGIN')
        def count(sql, params=()):
            return db.execute(sql, params).fetchone()[0]
        record = {
            'observed_at': now.isoformat(timespec='seconds'),
            'window_timezone': 'UTC',
            'information_items': count('SELECT count(*) FROM information_items'),
            'items_created_24h': count(
                'SELECT count(*) FROM information_items WHERE julianday(created_at) >= julianday(?) - 1 '
                'AND julianday(created_at) <= julianday(?)', (now.isoformat(), now.isoformat())),
            'ai_summaries': count('SELECT count(*) FROM ai_summaries'),
            'outbox_total': count('SELECT count(*) FROM outbox'),
            'outbox_pending': count('SELECT count(*) FROM outbox WHERE dispatched_at IS NULL'),
            'dynamic_topics': count('SELECT count(*) FROM dynamic_topics'),
        }
        record['db_bytes'] = db_path.stat().st_size
        wal = Path(str(db_path) + '-wal')
        try:
            record['wal_bytes'] = wal.stat().st_size
        except FileNotFoundError:
            record['wal_bytes'] = 0
        st = os.statvfs(db_path)
        record['free_bytes'] = st.f_bavail * st.f_frsize
    return record


def report(db_path, log_path, now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError('observation time must have a timezone')
    now = now.astimezone(timezone.utc)
    log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(str(log_path) + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock, 'a') as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        history = []
        if log_path.exists():
            # Invalid history aborts before replacement; never silently discard evidence.
            for line in log_path.read_text().splitlines():
                row = json.loads(line)
                stamp = datetime.fromisoformat(row['observed_at'])
                if stamp.tzinfo is None:
                    raise ValueError('history time has no timezone')
                if not isinstance(row['db_bytes'], int) or not isinstance(row['information_items'], int):
                    raise ValueError('invalid historical counters')
                history.append(row)
        rec = observe(db_path, now)
        rec.update(db_delta_bytes=None, items_delta=None, elapsed_seconds=None)
        if history:
            prev = history[-1]
            seconds = (now - datetime.fromisoformat(prev['observed_at'])).total_seconds()
            if seconds <= 0:
                raise ValueError('observation time must advance')
            rec.update(db_delta_bytes=rec['db_bytes'] - prev['db_bytes'],
                       items_delta=rec['information_items'] - prev['information_items'],
                       elapsed_seconds=seconds)
        history = (history + [rec])[-365:]
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=log_path.parent, delete=False) as tmp:
                tmp_path = Path(tmp.name)
                for row in history:
                    tmp.write(json.dumps(row, separators=(',', ':')) + '\n')
                tmp.flush()
                os.fsync(tmp.fileno())
            tmp_path.replace(log_path)
        finally:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)
        return rec


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--log', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(report(args.db, args.log), indent=2))


if __name__ == '__main__':
    main()
