# Epic 02 — Make the Windows/WSL inhibitor actually hold (and stop lying about it)

## Goal

`herdr-stay-awake` must genuinely prevent idle sleep on Windows and WSL while any
agent is `working`, and `status`/`doctor` must prove the OS request exists — not
that a process exists. Ship as v0.2.0.

## Confirmed failure (this machine, WSL2 Ubuntu / Windows 11, S3 laptop)

The overnight incident at ~23:15 and ~01:29 (sleep reason **System Idle**) happened
while a marker "inhibitor" process was alive. Root cause, reproduced locally:

```
powershellScript() emits:  [Herdr.Power]::SetThreadExecutionState(0x80000001)
PowerShell 5.1 parses 0x80000001 as Int32 -> -2147483647
Cannot convert argument "esFlags", with value: "-2147483647", to type "System.UInt32"
=> the Win32 call is NEVER made; script falls into `while ($true) { Start-Sleep 60 }`
=> osVerifyInhibitor counts marker processes -> reports "awake" forever
```

Verified fix path on the same machine:

```
$ES_CONTINUOUS = [uint32]"0x80000000"; $ES_SYSTEM_REQUIRED = [uint32]"0x00000001"
$d = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED      # type=UInt32 val=2147483649
SetThreadExecutionState($d)                       # retval=2147483648 (non-zero = ok)
SetThreadExecutionState([uint32]"0x80000000")     # previous flags = 0x80000001  <-- proof
```

## Approach

- Replace "spawn a script that sits there" with a **keeper script that owns the
  assertion**: correct `[uint32]` flags, re-assert every 30s, and write a
  heartbeat file (`assertedAt`, `firstAt`, `lastRetval`) each pass. Node never
  claims awake without a fresh heartbeat.
- Heartbeat is the honest, **admin-free** OS verification. `powercfg /requests`
  needs elevation, so it stays a documented manual cross-check, not a code path.
- Re-asserting every 30s also covers the two documented gaps: ES requests are
  per-thread (cleared when the process dies) and the loop survives a resume, so
  the machine self-heals after any sleep instead of staying broken until the next
  agent event (the log shows **zero plugin invocations between 20:49Z and 03:37Z**
  while agents were mid-turn — event-driven checks alone are blind).
- Same class of bug on macOS: `caffeinate -w <pid>` waits on the **transient**
  plugin invocation pid (<1s), so it exits immediately. Drop `-w`, use a detached
  long-lived `caffeinate -dis`, verified with `pmset -g assertions`.
- Keep Linux native untouched (`systemd-inhibit … sleep infinity` is already
  long-lived and verifiable via `systemd-inhibit --list`).
- Fix the grace-timer bookkeeping bug: the reset branch mutates the object without
  writing the file, leaving `lastInactiveTime` stale forever.

## Decisions

- `[uint32]"0x80000000"` string-cast + `-bor` — because a bare `0x80000001` hex
  literal is Int32-negative in PS 5.1 and silently kills the call. Rejected:
  decimal `[uint32]2147483649` (opaque), `int`-typed extern with negative value
  (works, unreadable), C# `[Flags] enum` in the signature (more surface to test).
- Heartbeat-file verification — because the current "marker process exists" check
  is what let v0.1.0 ship broken and report HEALTHY. Rejected: `powercfg /requests`
  (admin prompt), `Get-WinEvent` post-hoc (too late, not actionable).
- Keeper re-asserts on a loop instead of trusting `ES_CONTINUOUS` stickiness —
  cheap, survives resume, and makes a dead keeper visible as a stale heartbeat.
  Rejected: assert once and rely on stickiness (that is the current bug class).
- Keeper holds until node kills it (release path) but self-exits after
  `max_hold_seconds` (default 12h, configurable) — bounded orphan risk. Rejected:
  unbounded hold (stale `working-panes.json` could keep a laptop awake forever).
- `-ExecutionPolicy Bypass` on the `-File` launch and log the child's stderr to
  `stay-awake.log` — because a Restricted policy today fails silently into
  `stdio: 'ignore'`. Rejected: `-EncodedCommand` (hides the marker from
  `Win32_Process` matching, breaks the release path).
- Dedupe before start: `windowsLikeStop()` then start, under a best-effort state
  lock — because the log shows 3 racing "stopping inhibitor" lines and 2 live
  marker processes (double-start race on near-simultaneous events).
  Rejected: pid-based handle for Windows (WSL cannot see the Windows pid).
- `max_hold` + heartbeat age surfaced in `status`/`doctor`, plus a DC/battery
  warning — because this box unplugged at 01:17 and idle-sleeps after 10 min on
  DC; battery-critical sleep is something the plugin cannot prevent and must say
  so instead of silently failing.
  Rejected: editing the user's power scheme (`powercfg /setdcvalueindex`) — invasive.

## What this still cannot do (must be in the README, not implied)

- Lid close and power/sleep button: `SetThreadExecutionState` "cannot be used to
  prevent the user from putting the computer to sleep" (MS docs).
- Battery-critical forced sleep/hibernate.
- `Hibernate after` timeouts beyond the sleep path, screen-saver/lock screen.
- Anything while the OS is already asleep: the WSL VM is frozen, so the plugin
  itself sleeps with it — only the Windows-side keeper survives.

## Milestones

- M1: Windows/WSL keeper — correct flags, re-assert loop, heartbeat, launch fixes,
  start verification, dedupe.
- M2: Honest verification — heartbeat-gated `osVerifyInhibitor`, `status`/`doctor`
  output, admin-free `--probe` using the previous-flags trick.
- M3: macOS long-lived `caffeinate` + `pmset` verification.
- M4: Grace-timer persistence fix + battery/DC reporting.
- M5: selftest/README/version 0.2.0 + on-device overnight proof.

## Risks

- Over-awake orphan if `working-panes.json` goes stale and no event ever arrives →
  mitigated by `max_hold_seconds` + `disable`.
- Heartbeat write to `%TEMP%` from the keeper could fail (profile quirks, AV) →
  keeper logs to its own sidecar file; `doctor` shows heartbeat path + last error.
- Two keepers from races → dedupe + heartbeat namespacing; worst case is one
  redundant assertion, not a sleep.
- macOS change is unverified here (no macOS host available) — keep it minimal and
  verifiable through `pmset -g assertions`; call it out in release notes.
- `Add-Type` needs the in-box C# compiler; a machine without it would break the
  keeper → keep stderr captured so `doctor` reports it rather than lying.
- Herdr fires no events during long turns → the design must not depend on events
  for liveness (hence the keeper loop).
