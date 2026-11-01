# X Following 2h incremental (feed / hybrid lane) — install / rollback

Files (installed at deploy time only, never by the app itself):

| worktree file | installs to |
|---|---|
| `deploy/thinkpad/eagleye-x-following.py` | `~/.local/bin/eagleye-x-following.py` (chmod +x) |
| `deploy/thinkpad/argus-eagleye-x-following.service` | `~/.config/systemd/user/argus-eagleye-x-following.service` |
| `deploy/thinkpad/argus-eagleye-x-following.timer` | `~/.config/systemd/user/argus-eagleye-x-following.timer` |

## Mode semantics (code default since the feed-default ruling)

`X_FOLLOWING_MODE` resolution lives in `server/connectors/x-following.js`
(`resolveMode()`):

- unset (or any value other than the two below) → **feed** — the connector
  default. The 01:00 pipeline stage skips x-following (zero twitter-cli
  calls there); the 2h lane owns X.
- `feed` — same as unset: strict incremental following-timeline paging. A
  failed feed round is terminal for that tick (failure ledger
  `x_following_failure`, 30min retry cooldown); it never expands into a
  per-user scan.
- `hybrid` — feed-first, with ONE bounded degradation: an outright feed
  failure degrades the same tick to the legacy per-user scan at most once
  per `X_FOLLOWING_FULL_FALLBACK_COOLDOWN_MS` (default 24h), so the 2h
  timer can never repeat the full scan tick after tick. Fallback results
  do not move the feed cursor; a later healthy feed run resumes from the
  last checkpoint and dedup absorbs the overlap. A cooldown-suppressed
  tick (`FEED_COOLDOWN`) is a no-op, never a scan.
- `per-user` — explicit legacy escape hatch: the 01:00 pipeline scans X
  per-account again and the 2h trigger self-skips.

The trigger script (`eagleye-x-following.py`) mirrors this resolution:
effective mode = explicit env pin, else `feed`. It fires for `feed` and
`hybrid`; any other explicit value skips the tick (logged, not a storm).

## Install (2h lane — required under the feed default)

Because the pipeline skips X under the feed default, the timer IS the X
coverage once the service runs the new code. Install order (safe in any
order; a tick before the service restart just hits the old behavior):

```sh
# 1. (optional) pin the mode in the service EnvironmentFile — unset is feed;
#    X_FOLLOWING_MODE=hybrid opts into the bounded fallback lane.
#    Set EAGLEYE_DB_PATH and EAGLEYE_API_BASE_URL in
#    $HOME/.config/argus/eagleye-pipeline.env if the database or API binding
#    differs from the local defaults. Do not commit that file.
# 2. install the trigger (files above)
cp deploy/thinkpad/eagleye-x-following.py ~/.local/bin/ && chmod +x ~/.local/bin/eagleye-x-following.py
cp deploy/thinkpad/argus-eagleye-x-following.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
# 3. restart the service (picks up env + code), then arm the timer
systemctl --user restart argus-eagleye.service
systemctl --user enable --now argus-eagleye-x-following.timer
systemctl --user list-timers 'argus-eagleye-x-following*'   # verify next tick
journalctl --user -u argus-eagleye-x-following.service -n 5 # verify first run / {"fired": ...}
```

The first feed run has no cursor and establishes the watermark; subsequent
ticks page only down to the cursor (`user_data` global key
`x_following_cursor`). The trigger defers while a full-pipeline/fetch-all
job is queued or running (overlap guard, read-only sqlite).

## Rollback (per-switch, independent)

Rolling the 2h lane back to the legacy pipeline scan: order matters — while
the timer is enabled AND the mode is feed/hybrid, disable the timer first,
then pin `X_FOLLOWING_MODE=per-user` and restart. A botched order degrades
to a skipped tick (logged), never a double scan: the pipeline skips X in
feed/hybrid, and the trigger skips in per-user.

| switch | default | to enable | to roll back |
|---|---|---|---|
| `X_FOLLOWING_MODE=feed\|hybrid\|per-user` | `feed` (unset) — pipeline skips X, 2h lane owns it | set `hybrid` in `~/.config/argus/eagleye-pipeline.env` (service `EnvironmentFile`) + restart service for the bounded fallback | pin `per-user` (removing the pin returns to feed, NOT per-user): **Step 1** `systemctl --user disable --now argus-eagleye-x-following.timer`; **Step 2** set `X_FOLLOWING_MODE=per-user` + restart service → pipeline re-includes X with the legacy per-account path |
| 2h trigger timer | not installed → no X coverage under the feed default | `systemctl --user enable --now argus-eagleye-x-following.timer` | `systemctl --user disable --now argus-eagleye-x-following.timer` (pipeline still skips X until per-user is pinned) |
| `X_FOLLOWING_FULL_FALLBACK_COOLDOWN_MS` (hybrid only: min spacing between full per-user fallbacks after outright feed failures) | `86400000` (24h) | lower it to degrade more often | `0` disables the spacing guard (a persistent feed failure would then repeat the full scan every 2h tick — CLI red line) |
| `X_FOLLOWING_INCLUDE_RT=1` keeps retweets | unset (filtered) | set the env var | unset the env var |
| `X_FOLLOWING_CURSOR_CONFIRM_RUN` (watermark confirmation run; lone injected old tweets are scanned past) | `8` | — | `1` restores first-hit cursor stop (not recommended — field data shows injected old tweets mid-page) |
| cursor watermark | maintained by feed/hybrid runs; hybrid fallback reads do not move it | — | harmless to keep; to force a full re-pull: `DELETE FROM user_data WHERE key='x_following_cursor'` (global row, `user_id=''`) |

Code-level rollback is `git revert` of the feed-lane commits — the per-user
path was kept verbatim, so revert restores the pre-Round-2 behavior exactly.
Hybrid (R2.1) is implemented as an explicit opt-in mode: feed semantics
unchanged by default, fallback frequency capped by the 24h ledger
(`last_full_fallback_at` in the same `x_following_failure` ledger).
Coverage context (2026-10-21 correction): the old "89 feed + 353 per-user"
split came from the truncation artifact; per the manual-export cross-check
it would be 439 feed + 3 per-user.
