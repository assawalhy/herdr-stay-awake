# TODO

- [x] M1: `logindIdleState()` in `src/backends/linux.js` — read `IdleHint` + `IdleSinceHint`
      from logind via `busctl` (ms → ISO), `{ idle:false, idleSince:null }` on any failure
      — verified live: `{"available":true,"idle":false,...}`, `osBlockHeld(): true`
- [x] M2a: config keys in `src/config.js` + `defaultConfig()`:
      `sleep_after_idle_minutes: 30`, `nudge_linger_minutes: 90`,
      `sleep_while_working_minutes: 0` (off) — `0` round-trips as `0`, garbage → default
- [x] M2b: `suspendNudge()` in `src/backends/linux.js` — guards (no block, `IdleHint`,
      idle ≥ margin, no working pane, ≥2 min quiet, `HERDR_STAY_AWAKE_NUDGE_DRYRUN` honoured)
      then `loginctl suspend`; log every decision and every refusal
      — all 7 branches exercised incl. dry-run log line
- [x] M2c: `watchdogLoop()` in `src/state.js` — split into `holdPhase()` +
      `lingerPhase()`; exit only when no block AND (session active OR linger expired OR
      nudge sent); refused nudges keep retrying; re-acquired block resumes hold
      — end-to-end dry-run vs a faked logind (idle 40 m, 0 panes): hold→release→linger→
      13 dry-run nudges→linger expiry→pidfile removed; fixed `Number(x) || dflt` making
      `QUIET_MS=0` unreachable; `stopWatchdog()` no longer unlinks the pidfile the
      watchdog itself owns
- [x] M3: opt-in release-while-blocked-if-idle in `reconcile()` — only when
      `sleep_while_working_minutes > 0`; log loudly when it fires
      — 3 cases vs a faked logind: knob off/idle 60 m ⇒ held; knob 20/idle 60 m ⇒ released
      with the log line; knob 45/idle 10 m ⇒ held
- [x] M4: `status`/`doctor` line `idle: 42m (system idle — auto-sleep blocked while the
      inhibitor is held)` + settings-pane row for the three new keys; README.md + README.ar.md
      — live `status` verified against the running block; `healthCheck` raises an issue when
      held while idle ≥20 m; settings keys `n` (0/15/30/60/120) and `w` (0/20/45/90) cycle right
- [x] M5: selftest coverage — 7 nudge-decision branches + config key/default assertions, in
      the isolated tmp state dir; no suspend path reachable — `selftest PASS`
- [x] verify: `node --check` all 17 files ok, `node index.js selftest` PASS,
      `node index.js doctor --probe` PASS ×3, `node index.js` prints help, diff reviewed.
      Fixed a pre-existing false `FAIL` found here: `doctor --probe` verified the stop
      before SIGTERM had landed (baseline at HEAD fails 3/3; now PASS 3/3).