# TODO — Epic 03: Split index.js into src/ modules

- [x] M1: create src/util.js (log, readJson, writeJsonAtomic, hasCommand, isAlive, detectPlatform, socketHash) + src/constants.js (paths, MARKER)
- [x] M2: create src/config.js (defaultConfig, load/save global, load/save session map, effectiveEnabled, setGlobalEnabled, setSessionEnabled, maxHoldSeconds)
- [x] M3: create src/backends/macos.js (macosStart/macosStop), linux.js (systemd/dbus/gnome/freedesktop/xdg/xset + detectLinuxBackend + linuxInhibitStart/Stop), windows.js (powershell script, wsl paths, keeper, probes, battery)
- [x] M4: create src/verify.js (osVerifyInhibitor) and src/inhibitor.js (startInhibitor/stopInhibitor dispatch)
- [x] M5: create src/state.js (loadWorking/saveWorking/loadInhibitor/reconcile) — grace-retry spawn uses require.main.filename
- [x] M6: create src/herdr.js (runHerdr, extractAgents, syncFromAgentList, extractPaneAndStatus, handleEvent)
- [x] M7: create src/status.js (collectStatus, healthCheck, actionStatus, actionDoctor), src/actions.js (enable/disable/toggle/open-settings), src/settings.js (settingsPane), src/selftest.js (selftest via require.main.filename)
- [x] M8: create src/main.js (dispatch) and rewrite index.js as thin shim
- [x] M9: verify — `node index.js selftest` passes, `node index.js doctor --probe` sane, `node index.js` (no env) prints help, `node --check` all files, git diff reviewed as pure moves