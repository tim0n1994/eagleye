#!/usr/bin/env bash
# Only deployment DB backups; migration archives, live DB and snapshots are outside scope.
set -euo pipefail
KEEP=1
DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  '') ;;
  *) echo 'usage: eagleye-backup-prune.sh [--dry-run]' >&2; exit 1 ;;
esac
DIRS=("${EAGLEYE_DEPLOY_BACKUPS:-$HOME/.local/share/argus/eagleye-backups}" "${EAGLEYE_LEGACY_BACKUPS:-$HOME/projects/eagleye-backups}")
command -v fuser >/dev/null # Fail closed if the in-use check is unavailable.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/eagleye-backup-prune-$UID.lock"
flock -n 9 || { echo PRUNE_BUSY; exit 1; }
is_sqlite() { [ "$(head -c 15 "$1" 2>/dev/null)" = 'SQLite format 3' ]; }
mapfile -t files < <(
  for d in "${DIRS[@]}"; do
    if [ -d "$d" ]; then
      find "$d" -type f -size +104857600c ! -name '*-wal' ! -name '*-shm' -printf '%T@\t%p\n'
    fi
  done | sort -rn | cut -f2-
)
n=0; deleted=0; kept=0
for f in "${files[@]}"; do
  is_sqlite "$f" || continue
  n=$((n+1))
  if [ "$n" -le "$KEEP" ]; then
    # An interrupted copy must never displace the last verified recovery point.
    python3 - "$f" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
m = json.loads(pathlib.Path(str(p) + '.manifest.json').read_text())
assert m['integrity_check'] == 'ok', 'newest backup is not verified'
assert p.stat().st_size == m['page_count'] * m['page_size'], 'backup size mismatch'
PY
    echo "KEEP $f"; kept=$((kept+1)); continue
  fi
  if fuser "$f" "$f-wal" "$f-shm" >/dev/null 2>&1; then
    echo "IN_USE_SKIP $f"; continue
  fi
  if [ "$DRY" -eq 1 ]; then echo "WOULD_DELETE $f"; continue; fi
  rm -- "$f"
  for sidecar in "$f-wal" "$f-shm" "$f.manifest.json"; do
    [ ! -e "$sidecar" ] || rm -- "$sidecar"
  done
  echo "DELETED $f"; deleted=$((deleted+1))
done
echo "PRUNE_DONE keep=$KEEP kept=$kept deleted=$deleted dry_run=$DRY"
