# Epic 01 — Stay Awake Plus (non-systemd + status + settings)

## Goal
Make `herdr-stay-awake` reliable on every Linux variant (not just systemd), surface its live state via `status`/`doctor`, and give users a first-class place in Herdr to enable/disable it and verify health — while keeping the plugin a single Node script with no Rust toolchain.

## Approach
- Keep event-driven core (`pane.agent_status_changed` + `startup` sync from `herdr agent list`), but add opt-in grace periods (5s acquire / 30s release, like herdr-wakeup) to debounce flaps and tolerate crash-restart gaps; disabled by default, enabled via config — cheap no-op when not needed.
- Add Linux inhibitor chain using only system binaries: try `systemd-inhibit` → D-Bus `org.gnome.SessionManager` / `org.freedesktop.ScreenSaver` via `gdbus`/`dbus-send` → `xdg-screensaver` / `xset` → log warning + degraded status if none available. Detect once at reconcile, re-check on `doctor`.
- OS-verified health: `status`/`doctor` must query the OS, not just our JSON — `systemd-inhibit --list`, `ps` for `caffeinate`/`systemd-inhibit` child, `Get-CimInstance Win32_Process` for marker, and D-Bus `IsInhibited` where applicable. Show working count only (not per-pane IDs) per user ask.
- Add plugin actions: `status`, `doctor`, `enable`, `disable`, `toggle` (all Node, via `HERDR_BIN_PATH`). Add one interactive pane `settings` (`placement=popup`, 80%×20, global + per-session toggle + live OS-verified health) invoked by `herdr plugin pane open --plugin assawalhy.stay-awake --entrypoint settings`.
- Persist two-level config: global `HERDR_PLUGIN_CONFIG_DIR/config.json` (`enabled:true`, grace values, backend override) and per-session override keyed by `HERDR_SOCKET_PATH` hash in `HERDR_PLUGIN_STATE_DIR/session.json` — effective = global && sessionEnabled. Both hot-reloaded on every event; disable kills active inhibitor and restores OS state (does NOT `herdr plugin disable` the plugin itself).
- Make inhibitors process-bound so crash = auto-release: macOS `caffeinate -w <pid>`, Linux `systemd-inhibit` watchdog or D-Bus cookie tied to our pid, Windows marker process — no orphan locks; `doctor --probe` does a 1-sec spawn round-trip like herdr-awake selftest to prove it.

## Decisions
- Node-only, only system binaries (user-confirmed) — because vendoring Rust `wakeup` adds release-matrix + provenance; Node + existing OS tools cover 95% via D-Bus fallback. Rejected: bundling Rust `wakeup` (herdr-wakeup way) — heavier build, toolchain required per docs/plugins [[build]].
- D-Bus via `gdbus`/`dbus-send`/`qdbus` not Python — because most non-systemd desktops already ship one; avoids Python dep. Rejected: pure `xdg-screensaver` only (too narrow, GNOME/KDE prefer SessionManager Inhibit).
- `[[actions]]` + `[[panes]]` not `[[startup]]` daemon — because docs/plugins says startup hooks are one-shot, not supervised; state in `HERDR_PLUGIN_STATE_DIR` JSON + event triggers avoids orphan daemon ppid tracking (herdr-awake workaround). Rejected: long-lived daemon — pid-file races.
- Config file (global + per-session) over `herdr plugin enable/disable` — because `herdr plugin disable` removes settings pane too, making re-enable impossible; our disable only kills inhibitor and restores OS, keeping actions/pane alive. Rejected: using Herdr's plugin disable for awake toggle.
- Two-level config (global `config.json` + per-session `session.json` keyed by socket hash) — because plugins are global per docs/plugins but user wants per-session override visible in settings pane. Rejected: global-only toggle.
- OS-verified health (query `systemd-inhibit --list` / `ps` / `Get-CimInstance` / D-Bus) — because file-only check lies if process died without cleanup; count-only display per user ask. Rejected: trusting `inhibitor.json` alone.
- Process-bound inhibitors (`caffeinate -w`, systemd watchdog, D-Bus cookie, marker tied to pid) — because `herdr` is one server but crash can leave stale lock; process death = auto-release. Rejected: file-lock only.
- Grace periods (5s/30s) configurable, off by default — because user noted locking risk; grace debounces flaps and survives short crash gap. Rejected: always-on grace (adds latency when not needed).

## Milestones
- M1: Non-systemd Linux fallback chain + detection + tests
- M2: Config toggle (enable/disable/toggle) + gate in reconcile + persistence
- M3: Actions `status` / `doctor` (+ probe) with JSON + human output
- M4: Interactive `settings` pane (popup) with enable/disable + live health
- M5: Docs + selftest + marketplace topic

## Risks
- D-Bus API variance across GNOME/KDE/XFCE/Budgie — mitigate by probing at runtime and falling through chain, logging which backend was chosen.
- `event` + grace timer double-trigger could race on `working-panes.json` — mitigate with atomic write (tmp+rename) and in-process debounce.
- WSL detection fragile if `powershell.exe` not on PATH (interop disabled) — `doctor` reports it explicitly, `status` shows degraded.
- Herdr event payload shape still undocumented — keep `extractPaneAndStatus` fallbacks and surface raw payload in `doctor` for user to fix.
- Stale lock if server killed mid-inhibit — mitigated by process-bound inhibitors + grace timers; `doctor` OS-query catches drift and offers manual release.
- Popup pane UX on small terminals — clamp dimensions, fallback to overlay if popup too small.
- Per-session key via `HERDR_SOCKET_PATH` may not survive `herdr server` restarts — fall back to global config when session key missing, log which level is active.
