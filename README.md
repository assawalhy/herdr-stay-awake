# herdr-stay-awake

A herdr plugin that holds a sleep inhibitor open for as long as any agent
pane is `working`, and releases it the moment every agent settles back to
`idle`, `done`, `blocked`, or `unknown`. Handles macOS, native Linux,
native Windows, and Linux-under-WSL as four distinct cases, because "keep
the PC awake" means something different on each.

## Install

```bash
herdr plugin install assawalhy/herdr-stay-awake
herdr plugin list
```

No build step — manifest plus one Node script. Uses only system binaries
(`systemd-inhibit`, `caffeinate`, `gdbus`/`dbus-send`, `xdg-screensaver`,
`powershell.exe` on WSL/Windows).

### Local development

```bash
herdr plugin link /path/to/herdr-stay-awake
herdr plugin list
herdr plugin action list --plugin assawalhy.stay-awake
```

## How it decides "still working"

- On plugin/server startup, it runs `herdr agent list` once to seed the
  working-set from whatever's already running (covers herdr restarts mid-task).
- After that, it reacts to `pane.agent_status_changed` events: add on `working`,
  remove on anything else.
- The inhibitor turns on when the working-set goes from empty to non-empty,
  and off when it goes back to empty. All inhibitors are **process-bound**
  (`caffeinate -w <pid>`, `systemd-inhibit` watchdog, D-Bus cookie, PowerShell
  marker) so a crash auto-releases — no stale locks.

Grace periods (`grace_enabled` in config, 5s acquire / 30s release)
debounce flaps and cover crash gaps; **on by default** (toggle with `t` in settings pane or `config.json`).

## Platform behavior

| Platform | Mechanism | Fallback chain |
| --- | --- | --- |
| macOS | `caffeinate -d -i -s -w <pid>`, killed to release | — |
| Linux (native) | `systemd-inhibit --what=sleep:idle … sleep infinity` | → `org.gnome.SessionManager.Inhibit` → `org.freedesktop.ScreenSaver.Inhibit` → `xdg-screensaver` → `xset` → degraded warning |
| Windows (native) | hidden PowerShell `SetThreadExecutionState` | marker `herdr-stay-awake-inhibitor-marker` in `-File` path |
| WSL | same PowerShell via interop (`powershell.exe` on `$PATH`, file written to Windows `%TEMP%` for visibility) | — |

Non-systemd Linux is auto-detected at runtime via `hasCommand` probing
(`gdbus`/`dbus-send`/`qdbus` → GNOME/Freedesktop, else `xdg-screensaver`/`xset`).
`doctor` shows which backend was chosen.

## Status, doctor & health

All actions are OS-verified (not just our JSON):

```bash
herdr plugin action invoke status --plugin assawalhy.stay-awake
herdr plugin action invoke doctor --plugin assawalhy.stay-awake
# with 1-sec spawn probe (like herdr-awake selftest)
node index.js doctor --probe
# or via herdr: herdr plugin action invoke doctor --plugin assawalhy.stay-awake  # then check log for probe
```

`status` shows (human + JSON): platform, backend, enabled (global + per-session),
working **count** (not per-pane IDs), inhibitor active, OS-verified `awake` detail
(`systemd-inhibit --list`, `pmset -g assertions`, `Get-CimInstance` marker, D-Bus),
grace config, and issues. `doctor` adds binary presence, config/state paths,
socket reachable, stale pid check, last payload, and healthy flag.

## Enable / disable (global + per-session)

Disabling **does not** call `herdr plugin disable` — the plugin stays registered
so you can re-enable from the settings pane. It kills any active inhibitor and
restores the OS to its preconfigured state.

```bash
# global (affects all sessions)
herdr plugin action invoke disable --plugin assawalhy.stay-awake
herdr plugin action invoke enable --plugin assawalhy.stay-awake
herdr plugin action invoke toggle --plugin assawalhy.stay-awake

# per-session (keyed by HERDR_SOCKET_PATH hash, visible in status)
node index.js disable --session   # or --per-session
node index.js enable --session
node index.js disable --global
```

Effective enabled = `global && session`. Both are hot-reloaded on every event.
Config lives at `$(herdr plugin config-dir assawalhy.stay-awake)/config.json`,
per-session overrides at `$(herdr plugin config-dir assawalhy.stay-awake | sed s/config/state/)/session.json`.

## Settings pane

A popup TUI with global + per-session toggles and live OS-verified health:

```bash
herdr plugin pane open --plugin assawalhy.stay-awake --entrypoint settings
# or directly: node index.js settings
```

Keys: `g` toggle global, `s` toggle session, `t` toggle grace, `d` doctor,
`r` refresh, `q` quit.

**Keybind to open settings (add to `~/.config/herdr/config.toml`):**

Herdr plugin manifests can't declare default keybinds for panes — add it to your user config. `prefix+a` → open settings (recommended):

```toml
# open settings popup
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "assawalhy.stay-awake.open-settings"
description = "Stay Awake settings"

# alternative: straight shell binding (no action needed)
# [[keys.command]]
# key = "prefix+a"
# type = "shell"
# command = "herdr plugin pane open --plugin assawalhy.stay-awake --entrypoint settings"
```

Also available: `assawalhy.stay-awake.toggle` for a plain toggle without UI. Press `prefix+?` to verify.

## Selftest

Validates busy/idle logic and does an OS-verified spawn round-trip in a temp state dir (never touches live pid files):

```bash
node index.js selftest
```

## Troubleshooting

- **WSL interop:** `powershell.exe` must work from WSL (`powershell.exe -c "echo hi"`).
  If blocked, Windows branch is degraded — `doctor` reports it.
- **Stale lock after kill:** inhibitors are process-bound; `status` OS-verifies and
  `reconcile` auto-restarts a dead handle. `disable` always restores OS.
- **Event payload shape:** herdr docs don't publish `pane.agent_status_changed` JSON.
  `index.js` tries `pane_id`/`agent_status` with fallbacks; check
  `herdr plugin log list --plugin assawalhy.stay-awake` and
  `cat "$(herdr plugin config-dir assawalhy.stay-awake | sed s/config/state/)/stay-awake.log"`
  plus `doctor`'s `lastPayload` to adjust `extractPaneAndStatus()` if needed.
- **Non-systemd:** `doctor` shows which fallback is active; if `none`, install
  `xdg-utils` or ensure a D-Bus session bus is running.
