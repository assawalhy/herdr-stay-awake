# Epic 03 — Split index.js into src/ modules

## Goal

Turn the single 897-line `index.js` into a thin root entry + cohesive `src/`
modules. Pure refactor: zero behavior change, all CLI/action/event entrypoints
keep working, `herdr-plugin.toml` untouched.

## Approach

- `index.js` stays the root entry (so `herdr-plugin.toml`'s `node index.js`
  and every README command stay valid), but becomes a thin shim that calls
  `main()` from `src/main.js`.
- Split along the existing section boundaries (utils, config, platform
  backends, verify, state/reconcile, herdr bridge, status/doctor, actions,
  settings, selftest, dispatch).
- Replace `__filename` in the two re-spawn sites (grace retry, selftest) with
  `require.main.filename` so they still target the root entry after the split.
- Verify: `node index.js selftest`, `node index.js doctor --probe`,
  `node index.js status` (help path), `node --check` on every file, git diff
  reviewed as pure moves.

## Decisions

- Keep root `index.js` shim instead of moving the entry to `src/`: toml has 9
  hardcoded `node index.js` references and README documents it; a shim makes
  the split invisible to the host.
- One module per section, not one module per function: matches the file's
  natural seams and keeps the split reviewable.
- Backends grouped per platform (macos / linux / windows) because that's how
  the code itself is organized (macOS vs Linux native vs Windows/WSL).
- `require.main.filename` over `__filename` in re-spawns: `__filename` would
  become a src/ module path, which `node <that-path> __grace_retry` cannot run
  as the dispatch entry.
- No package.json / build step introduced: plugin stays zero-build, plain
  CommonJS `require`s.

## Milestones

- M1: src skeleton — util.js (log/readJson/writeJsonAtomic/hasCommand/isAlive/
  detectPlatform/socketHash), constants
- M2: config.js (config + session map + effectiveEnabled + maxHoldSeconds)
- M3: backends — macos.js, linux.js, windows.js
- M4: verify.js (osVerifyInhibitor), inhibitor.js (start/stop dispatch)
- M5: state.js (working set, inhibitor file, reconcile) with re-spawn fix
- M6: herdr.js (runHerdr, extract, sync, handleEvent)
- M7: status.js (collectStatus/healthCheck/actionStatus/actionDoctor),
  actions.js, settings.js, selftest.js
- M8: main.js dispatch + thin index.js shim
- M9: verification (selftest, doctor --probe, help path, node --check, diff review)

## Risks

- Re-spawn correctness: grace retry + selftest must still hit the root entry —
  mitigated via `require.main.filename` and M9 verification.
- Cross-module circular requires: architecture avoids them (leaf modules only
  require util/config; backends only require util/config; state requires
  backends+verify; actions require state+status; main requires all).
- Silent behavior drift during extraction: mitigated by node --check per file
  and selftest + doctor --probe at the end.