#!/usr/bin/env bash
# backup-prune.sh — keep only the latest 2 full-DB backups in a directory.
#
# Usage:
#   backup-prune.sh [--dry-run] <backup-dir>
#
# Behaviour:
#   * Considers top-level files (non-recursive) matching '*.db' or '*.db.bak*'
#     e.g. eagleye.db, eagleye.db.bak-lane-auto-20261017, pre-r11.db.bak
#     '*.db-wal' / '*.db-shm' are NOT standalone backups and are ignored;
#     '*.sqlite.bak*' is out of scope by spec.
#   * Sorts by mtime (newest first, ties broken deterministically), keeps the
#     newest KEEP=2, deletes the rest — listing each file (name + size)
#     immediately before deleting it.
#   * Idempotent: with <= KEEP backups prints NOTHING_TO_PRUNE, deletes
#     nothing, exits 0.  Safe to run repeatedly / from the deploy script.
#   * --dry-run: lists KEEP / WOULD_DELETE lines only; never deletes.
#   * Machine-readable stdout markers (PRUNE_DONE is always the last line):
#       NOTHING_TO_PRUNE kept=<n>
#       DRY_RUN would_delete=<n>
#       PRUNE_DONE kept=<n> deleted=<n>
#   * Exit codes:
#       0  ok (including nothing-to-prune and dry-run)
#       1  usage error
#       2  backup dir not found
#       3  a deletion failed
#
# Intended call site: deploy script, against ~/projects/eagleye-backups.

set -euo pipefail

KEEP=2
DRY_RUN=0
DIR=""

usage() {
    echo "usage: $0 [--dry-run] <backup-dir>" >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help)
            echo "usage: $0 [--dry-run] <backup-dir>"
            exit 0
            ;;
        -*)
            echo "unknown option: $1" >&2
            usage
            ;;
        *)
            if [ -n "$DIR" ]; then
                echo "unexpected extra argument: $1" >&2
                usage
            fi
            DIR="$1"
            ;;
    esac
    shift
done

[ -n "$DIR" ] || usage

if [ ! -d "$DIR" ]; then
    echo "ERROR: backup dir not found: $DIR" >&2
    exit 2
fi

# mtime in seconds since epoch — GNU stat first, BSD stat fallback (portable).
file_mtime() {
    stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

# Collect matching files, newest first: emit "<mtime>\t<basename>", numeric
# sort descending, then keep just the name.
backups=()
while IFS=$'\t' read -r _mtime name; do
    [ -n "$name" ] || continue
    backups+=("$name")
done < <(
    for f in "$DIR"/*.db "$DIR"/*.db.bak*; do
        [ -f "$f" ] || continue
        printf '%s\t%s\n' "$(file_mtime "$f")" "$(basename "$f")"
    done | sort -rn
)

total=${#backups[@]}
if [ "$total" -le "$KEEP" ]; then
    keep_n=$total
else
    keep_n=$KEEP
fi

echo "== backup dir          : $DIR"
echo "== full-DB backups found: $total (keeping newest $keep_n)"

deleted=0
would_delete=0
idx=0
for name in ${backups[@]+"${backups[@]}"}; do
    idx=$((idx + 1))
    path="$DIR/$name"
    size="$(du -h "$path" 2>/dev/null | cut -f1 || true)"
    if [ "$idx" -le "$keep_n" ]; then
        echo "KEEP         $name ($size)"
        continue
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "WOULD_DELETE $name ($size)"
        would_delete=$((would_delete + 1))
        continue
    fi
    echo "DELETE       $name ($size)"
    if ! rm -f -- "$path"; then
        echo "ERROR: failed to delete: $path" >&2
        echo "PRUNE_DONE kept=$keep_n deleted=$deleted"
        exit 3
    fi
    deleted=$((deleted + 1))
done

if [ "$total" -le "$KEEP" ]; then
    echo "NOTHING_TO_PRUNE kept=$total"
fi
if [ "$DRY_RUN" -eq 1 ] && [ "$would_delete" -gt 0 ]; then
    echo "DRY_RUN would_delete=$would_delete"
fi
echo "PRUNE_DONE kept=$keep_n deleted=$deleted"
exit 0
