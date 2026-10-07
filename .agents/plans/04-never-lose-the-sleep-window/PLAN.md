# 04 — Never lose the sleep window

## Goal

When herdr-stay-awake releases the `sleep:idle` block, the machine must actually be
able to sleep — even if the OS's own sleep attempt was refused while we held the block.
Today one refusal costs hours of idle awake time.

## Findings (investigated 2026-10-03, from journal + plugin log + herdr + opencode db)

Local time (EEST = UTC+3), today:

| local  | event |
| --- | --- |
| 01:37 | plugin takes `systemd-inhibit --what=sleep:idle --mode=block sleep 43200` |
| 01:37–09:09 | overnight agent fleet: herdr reports 1→12→…→1 panes `working` (real turns) |
| 09:09–12:08 | exactly **1** pane `working`: opencode session `ses_f02d88ff` *Tabs for history and edits history* — 40/43/38 messages per hour at 06/07/08Z |
| 09:10:44 | gsd-power idle timer (20 min AC) fires → logind: `BlockedByInhibitorLock` |
| 09:10–13:06 | **no further suspend attempt, ever** — GNOME does not re-arm after a refusal |
| 12:08:41 | that session goes idle (`idle_outcome: succeeded`) → herdr event → stop grace |
| 12:09:11 | plugin releases the block |
| 12:09–13:06 | nothing blocking, still no sleep (GNOME's timer is disarmed) |

Two separate facts:

1. **The block was correct.** "Nothing is running" is not what herdr saw — a real
   agent turn ran 09:09→12:08, and 12 panes ran overnight. The plugin did its job.
2. **The real defect:** one refused suspend disarms auto-suspend for the rest of the
   idle period. `logind IdleAction=ignore`, so GNOME is the *only* auto-sleep path and
   it is one-shot. The plugin is the only component that knows the block was released,
   so it is the only component that can re-arm the attempt.

## Approach

```
GNOME one-shot suspend ──refused──▶ gsd-power gives up for this idle period
                                          │
 herdr block released ──▶ nudge loop ──────┘──▶ loginctl suspend  (≤60 s later)
                            guards: linux · no block · IdleHint · idle ≥ N min
                                   · no pane working
```

- **M1** show "block held while the system is idle" in `status`/`doctor`, so "why is my
  laptop awake" is answerable without reading the journal.
- **M2** the cure: the watchdog lingers after release instead of exiting, and re-issues
  the sleep request once the system is idle past the margin. Still goes through logind,
  so it never bypasses our own block.
- **M3** opt-in policy knob: release the block even while agents work if the machine has
  been idle that long. Off by default.
- **M4** README (en + ar), settings pane row, selftest coverage.

## Decisions

- Nudge lives in the existing watchdog process — no new daemon, no systemd unit. The gap
  only exists next to a release, which is exactly when the watchdog is already alive.
- Nudge call is `loginctl suspend` (logind-mediated, inhibitor-respecting). Rejected:
  `systemd-inhibit --mode=delay` (GNOME's explicit `Suspend()` ignores delay inhibitors →
  the machine would sleep mid-turn); restarting `gsd-power` (invasive, breaks backlight
  handling, not an API); synthetic input via `ydotool`/`wtype` (needs uinput, lies to the
  session); lowering `max_hold_seconds` (the 10.5 h hold was legitimate work); a
  system-wide systemd timer in dotfiles (invisible to the plugin, and would fight the
  block's intent on every machine).
- Exit condition becomes "nothing left to do": no block, no idle time owed, linger
  expired (default 90 min) or session no longer idle.
- Guards re-checked immediately before the call: no block, `herdr agent list` has no
  working pane, `IdleHint=true`, idle ≥ `sleep_after_idle_minutes` (default 30).
- Linux-only, like the watchdog. macOS `caffeinate` and the Windows keeper do not disarm
  the OS sleep path, so the gap does not exist there.
- Verification uses a dry-run env flag — a real drill would suspend the machine mid-session.

## Milestones

See `TODO.md`.

## Risks

- A nudge at 30 min idle can suspend while a fullscreen app emits no input. Same exposure
  as GNOME's own 20 min timer; margin is configurable.
- The watchdog lingers up to 90 min after a release (detached, one cheap poll/minute).
- `loginctl suspend` can fail (polkit, session type). Non-fatal: log, retry next tick.
- Not exercised against a real suspend in verification; the first real one is the next
  idle moment after install.