# X Following 2h incremental (Round 2 ①) — install / rollback

Files (installed at deploy time only, never by the app itself):

| worktree file | installs to |
|---|---|
| `deploy/thinkpad/eagleye-x-following.py` | `~/.local/bin/eagleye-x-following.py` (chmod +x) |
| `deploy/thinkpad/argus-eagleye-x-following.service` | `~/.config/systemd/user/argus-eagleye-x-following.service` |
| `deploy/thinkpad/argus-eagleye-x-following.timer` | `~/.config/systemd/user/argus-eagleye-x-following.timer` |

## Install (feed mode is OPT-IN — CTO ruling 2026-10-20)

Default behavior needs NOTHING installed: X_FOLLOWING_MODE defaults to
per-user, the 01:00 pipeline scans X per-account exactly as before Round 2,
and this timer/trigger pair is inert (the trigger script self-skips unless
the env file explicitly pins X_FOLLOWING_MODE=feed).

To enable feed mode (incremental timeline):

```sh
# 1. pin the mode in the service EnvironmentFile
echo 'X_FOLLOWING_MODE=feed' >> /home/jc/.config/argus/eagleye-pipeline.env
# 2. install the trigger (files above)
cp deploy/thinkpad/eagleye-x-following.py ~/.local/bin/ && chmod +x ~/.local/bin/eagleye-x-following.py
cp deploy/thinkpad/argus-eagleye-x-following.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
# 3. restart the service (picks up the env), then arm the timer
systemctl --user restart argus-eagleye.service
systemctl --user enable --now argus-eagleye-x-following.timer
systemctl --user list-timers 'argus-eagleye-x-following*'   # verify next tick
journalctl --user -u argus-eagleye-x-following.service -n 5 # verify first run / {"fired": ...}
```

In feed mode the pipeline stage skips x-following (zero twitter-cli calls
there); the first feed run has no cursor and establishes the watermark;
subsequent ticks page only down to the cursor (`user_data` global key
`x_following_cursor`). Ordering note: enabling feed has no storm risk in
either order (the trigger only fires on the explicit env pin, and feed mode
has no full-scan path), but restarting before arming the timer avoids a
first tick that skips.

## Rollback (per-switch, independent)

Rolling feed BACK to per-user: order matters — while the timer is enabled
AND the env still pins feed, disable the timer first, then remove/unset the
env var and restart. (The trigger script also self-guards on mode, so a
botched order degrades to a skipped tick, logged, not a storm.)

| switch | default | to enable | to roll back |
|---|---|---|---|
| `X_FOLLOWING_MODE=feed\|per-user` | `per-user` (CTO ruling 2026-10-20, amended 2026-10-21: literal shadow coverage 0.0/4.29/5.71/21.43 < 95%; CADENCE 100% is a model value not admissible — the ruling stands on the literal coverage gate alone. The earlier "only 89/551 session-followed accounts are in the configured 442" was a list_fetched=200 truncation artifact; the manual-export cross-check shows 439/442 configured accounts ARE followed, and programs must never pull the following list via the JC account — twitter following/whoami forbidden, list checks read the static export /home/jc/.config/argus/x-following-set.json, counts only) | set `X_FOLLOWING_MODE=feed` in `/home/jc/.config/argus/eagleye-pipeline.env` (service `EnvironmentFile`, per `systemctl --user cat argus-eagleye.service`) + restart service | **Step 1**: `systemctl --user disable --now argus-eagleye-x-following.timer`; **Step 2**: remove/unset the env var + restart → pipeline re-includes X with the legacy per-account path. |
| 2h trigger timer | inert by default (trigger self-skips off-feed) | `systemctl --user enable --now argus-eagleye-x-following.timer` (after pinning feed) | `systemctl --user disable --now argus-eagleye-x-following.timer` |
| `X_FOLLOWING_INCLUDE_RT=1` keeps retweets | unset (filtered) | set the env var | unset the env var |
| `X_FOLLOWING_CURSOR_CONFIRM_RUN` (watermark confirmation run; lone injected old tweets are scanned past) | `8` | — | `1` restores first-hit cursor stop (not recommended — field data shows injected old tweets mid-page) |
| `X_FOLLOWING_FULL_FALLBACK_COOLDOWN_MS` (min spacing between full per-user fallbacks after outright feed failures) | `86400000` (24h) | — | `0` disables the cooldown (old behavior — a persistent feed failure would then repeat the full scan every 2h tick; CLI red line) |
| cursor watermark | maintained while feed mode is active | — | harmless to keep; to force a full re-pull: `DELETE FROM user_data WHERE key='x_following_cursor'` (global row, `user_id=''`) |

Code-level rollback is `git revert` of the round2 ① commits — the per-user
path was kept verbatim, so revert restores the pre-Round-2 behavior exactly.
Hybrid feed+per-user is R2.1, pending CTO review (2026-10-21 correction:
the old "89 feed + 353 per-user" split came from the truncation artifact;
per the manual-export cross-check it would be 439 feed + 3 per-user).
