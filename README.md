# herdr-stay-awake

A herdr plugin that holds a sleep inhibitor open for as long as any agent
pane is `working`, and releases it the moment every agent settles back to
`idle`, `done`, `blocked`, or `unknown`. Handles macOS, native Linux,
native Windows, and Linux-under-WSL as four distinct cases, because "keep
the PC awake" means something different on each.

## How it decides "still working"

- On plugin/server startup, it runs `herdr agent list` once to seed the
  working-set from whatever's already running (covers the case where
  herdr restarts mid-task).
- After that, it reacts to `pane.agent_status_changed` events: add the
  pane on `working`, remove it on anything else.
- The inhibitor turns on when the working-set goes from empty to
  non-empty, and off when it goes back to empty.

## Platform behavior

| Platform | Mechanism |
| --- | --- |
| macOS | `caffeinate -d -i -s`, killed to release |
| Linux (native) | `systemd-inhibit --what=sleep:idle ... sleep infinity`, killed to release |
| Windows (native) | hidden PowerShell process calling `SetThreadExecutionState`, matched and stopped by a marker string in its command line |
| WSL | same PowerShell approach, invoked through WSL's interop (`powershell.exe` is on `$PATH` from inside WSL when interop is enabled) |

The WSL case is the one worth double-checking on your machine: a WSL2
distro has no system sleep of its own, only the Windows host does, so
inhibiting sleep from inside the Linux guest (e.g. `systemd-inhibit`)
would do nothing. This plugin detects WSL via `/proc/version` /
`$WSL_DISTRO_NAME` and shells out to the Windows side instead.

## Before you trust this on your machine

1. **Verify the event payload shape.** herdr's docs don't publish the
   literal JSON for `pane.agent_status_changed`. `index.js` guesses
   `pane_id` / `agent_status` with a couple of fallbacks. After linking,
   start an agent, let it work for a bit, then check:
   ```
   herdr plugin log list --plugin mabdullah.stay-awake
   cat "$(herdr plugin config-dir mabdullah.stay-awake | sed 's/config/state/')/stay-awake.log"
   ```
   (or just tail the state dir's `stay-awake.log` directly) and confirm
   pane ids are actually landing in `working-panes.json`. Adjust
   `extractPaneAndStatus()` / `extractAgents()` if the field names differ.
2. **Confirm WSL interop is enabled** (`powershell.exe` should just work
   from a WSL shell prompt). If your org has interop disabled, the
   Windows/WSL branch needs a different transport (e.g. a small
   always-on Windows-side helper you talk to over a named pipe or TCP
   instead of spawning per-event).
3. **Non-systemd Linux**: `linuxStart()` assumes `systemd-inhibit`.
   Swap it for whatever your distro/DE exposes if you're not on
   systemd.

## Install

Local development (recommended while you're still verifying the event
shape above):

```
herdr plugin link /path/to/herdr-stay-awake
herdr plugin list
herdr plugin log list --plugin mabdullah.stay-awake
```

Once it's working, push it to its own repo, add the `herdr-plugin`
GitHub topic, and others can install it with:

```
herdr plugin install <you>/herdr-stay-awake
```

No build step -- it's a manifest plus one Node script.
