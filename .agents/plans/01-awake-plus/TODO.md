# TODO — 01 Awake Plus

- [x] Inventory current plugin: confirm herdr-plugin.toml id, Node entrypoints, state files vs docs/plugins contract
- [x] Research TODO (top): finalize D-Bus probe order using only system binaries (gdbus/dbus-send/qdbus) — block M1 until resolved
- [x] M1: refactor platform detect + add Linux inhibitor chain (systemd-inhibit → gnome SessionManager → freedesktop ScreenSaver → xdg-screensaver/xset → degraded) — no custom binary
- [x] M1: make all inhibitors process-bound (caffeinate -w, systemd watchdog, D-Bus cookie, marker tied to pid) so crash = auto-release; handle stale lock cleanup
- [x] M1: add backend probe + fallback logging to stay-awake.log
- [x] M2: add global config HERDR_PLUGIN_CONFIG_DIR/config.json + per-session override HERDR_PLUGIN_STATE_DIR/session.json (keyed by HERDR_SOCKET_PATH hash), effective = global && session, hot-reloaded each reconcile
- [x] M2: add actions enable/disable/toggle that flip correct level (global vs session via --session flag / HERDR_PLUGIN_CONTEXT_JSON), kill active inhibitor and restore OS state on disable — does NOT call herdr plugin disable
- [x] M2: add grace config (start_grace_seconds 5, stop_grace_seconds 30, disabled by default) + debounce timers in reconcile to handle crash-gap and flap
- [x] M3: add action `status` — human + JSON, OS-verified (systemd-inhibit --list / ps / Get-CimInstance / D-Bus IsInhibited), show count only, plus platform/backend/effective enabled/inhibitor alive/last error
- [x] M3: add action `doctor` — socket reachable, binary presence, config/state paths (global + session), stale pid check, raw last payload, optional --probe 1-sec spawn round-trip in tmp state dir
- [x] M3: wire HERDR_PLUGIN_ACTION_ID + HERDR_PLUGIN_CONTEXT_JSON routing for action invocations (keep existing event/startup paths)
- [x] M4: add [[panes]] settings entrypoint — Node TUI popup (80%×20, global toggle + per-session toggle + live OS-verified health, r to refresh, q to close)
- [x] M4: add keybinding example in README (prefix+a → settings pane)
- [x] M5: add selftest (busy/idle logic + OS-verified spawn round-trip) runnable via node index.js selftest in tmp state dir
- [x] M5: update README: Install/Usage for status/doctor/settings, non-systemd matrix, global vs per-session enable, troubleshooting (stale lock, WSL interop)
- [x] M5: verify `herdr plugin link` + `herdr plugin action list` + `herdr plugin pane open --plugin assawalhy.stay-awake --entrypoint settings` on Linux + WSL (`powershell.exe` on PATH)
- [x] fix: the plugin sees 0 working (event payload was nested under data, extract now handles envelope)
