#!/usr/bin/env python3
"""Install the SSD policy explicitly with --apply; default is read-only inspection."""
import argparse
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess


SCHEDULE = {'enabled': True, 'time': '01:00', 'task': 'pipeline'}


def scheduler(db_path, apply=False):
    # mode=rw/ro requires an existing database; never create an empty production DB.
    with sqlite3.connect(db_path.resolve().as_uri() + ('?mode=rw' if apply else '?mode=ro'), uri=True) as db:
        if apply:
            db.execute('BEGIN IMMEDIATE')
        row = db.execute("SELECT value FROM user_data WHERE key='scheduler_config' AND user_id='' ").fetchone()
        config = json.loads(row[0]) if row else {}
        if not isinstance(config, dict):
            raise ValueError('scheduler_config must be an object')
        changed = any(config.get(k) != v for k, v in SCHEDULE.items())
        if apply and changed:
            config.update(SCHEDULE) # Keep lastRun, job IDs and retry receipts: never enqueue twice.
            db.execute("INSERT INTO user_data(key,user_id,value) VALUES('scheduler_config','',?) "
                       "ON CONFLICT(key,user_id) DO UPDATE SET value=excluded.value", (json.dumps(config),))
        return {'configured': {k: config.get(k) for k in SCHEDULE}, 'change_needed': changed}


def systemctl(*args):
    subprocess.run(['systemctl', '--user', *args], check=True)


def install(home):
    source = Path(__file__).resolve().parent
    units = home / '.config/systemd/user'
    binaries = home / '.local/bin'
    units.mkdir(parents=True, exist_ok=True)
    binaries.mkdir(parents=True, exist_ok=True)
    # Keep the old tiny timer definition for audit, then mask it persistently.
    # Re-enabling a masked timer cannot silently restore daily full DB copies.
    timer = units / 'eagleye-snapshot.timer'
    if timer.exists() and not (timer.is_symlink() and timer.readlink() == Path('/dev/null')):
        saved = units / 'eagleye-snapshot.timer.disabled'
        if saved.exists() and saved.read_bytes() != timer.read_bytes():
            raise RuntimeError('different saved snapshot timer exists; refusing overwrite')
        systemctl('disable', '--now', 'eagleye-snapshot.timer')
        timer.replace(saved)
    systemctl('mask', '--now', 'eagleye-snapshot.timer')
    for name in ('eagleye-backup-prune.sh', 'eagleye-growth-report.py'):
        shutil.copyfile(source / name, binaries / name)
        (binaries / name).chmod(0o755)
    for stem in ('eagleye-backup-prune', 'eagleye-growth-report'):
        for suffix in ('.service', '.timer'):
            shutil.copyfile(source / (stem + suffix), units / (stem + suffix))
    systemctl('daemon-reload')
    systemctl('enable', '--now', 'eagleye-backup-prune.timer', 'eagleye-growth-report.timer')
    # Timers account/prune only. No backup creation or pipeline execution here.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    home = Path.home()
    db_path = home / 'projects/eagleye/eagleye.db'
    print(json.dumps(scheduler(db_path))) # Preflight before touching units.
    if args.apply:
        install(home)
        print(json.dumps(scheduler(db_path, apply=True)))
    else:
        print('DRY_RUN: mask daily snapshot timer; keep one deployment backup; record growth at 04:15 CST')


if __name__ == '__main__':
    main()
