const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { detectPlatform, isAlive } = require('./util');
const { saveWorking, loadWorking } = require('./state');
const { extractPaneAndStatus } = require('./herdr');
const { startInhibitor, stopInhibitor } = require('./inhibitor');
const { osVerifyInhibitor } = require('./verify');
const { detectLinuxBackend, nudgeDecision } = require('./backends/linux');
const { loadGlobalConfig } = require('./config');
const { probeWindowsKeeper, windowsApiProbe } = require('./backends/windows');

function selftest() {
  const tmp = fs.mkdtempSync(path.join('/tmp', 'herdr-stay-awake-selftest-'));
  console.log(`selftest tmp ${tmp}`);
  const r = spawnSync(process.execPath, [require.main.filename, '__selftest'], { env: { ...process.env, HERDR_PLUGIN_STATE_DIR: tmp, HERDR_PLUGIN_CONFIG_DIR: tmp }, stdio: 'inherit' });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(r.status === 0 ? 0 : 1);
}
function selftestInner() {
  let ok = true;
  try {
    const fakeBusy = { agent_status: 'working', pane_id: 'p1' };
    const { paneId, status } = extractPaneAndStatus(fakeBusy);
    if (paneId !== 'p1' || status !== 'working') { console.log('FAIL extract busy'); ok = false; }
    const fakeIdle = { agent_status: 'idle', pane_id: 'p1' };
    const { status: s2 } = extractPaneAndStatus(fakeIdle);
    if (s2 !== 'idle') { console.log('FAIL extract idle'); ok = false; }
    saveWorking(new Set(['a', 'b']));
    const ws = loadWorking();
    if (ws.size !== 2) { console.log('FAIL working set'); ok = false; }

    // Sleep-after-release nudge: pure decision logic, no suspend ever issued here.
    const idleFor = (ms) => ({ available: true, idle: true, idleSince: Date.now() - ms, idleForMs: ms });
    const nd = (o) => nudgeDecision(Object.assign({
      idleState: idleFor(40 * 60000), inhibitorHeldOs: false, workingCount: 0,
      minIdleMs: 30 * 60000, minQuietMs: 2 * 60000, quietMs: 5 * 60000,
    }, o));
    const cases = [
      ['idle past margin, nothing working, quiet', nd({}), true],
      ['block still held', nd({ inhibitorHeldOs: true }), false],
      ['a pane is working', nd({ workingCount: 1 }), false],
      ['session active', nd({ idleState: { available: true, idle: false, idleSince: null, idleForMs: 0 } }), false],
      ['idle below margin', nd({ idleState: idleFor(5 * 60000) }), false],
      ['idle but not quiet long enough', nd({ quietMs: 30 * 1000 }), false],
      ['logind unavailable', nd({ idleState: { available: false, idle: false, idleSince: null, idleForMs: 0 } }), false],
    ];
    for (const [name, d, want] of cases) {
      if (d.fire !== want) { console.log(`FAIL nudge decision: ${name} (fire=${d.fire} want=${want})`); ok = false; }
    }
    console.log(`nudge decisions ${cases.length} checked`);

    const cfg = loadGlobalConfig();
    for (const k of ['sleep_after_idle_minutes', 'nudge_linger_minutes', 'sleep_while_working_minutes']) {
      if (typeof cfg[k] !== 'number') { console.log(`FAIL config key ${k}`); ok = false; }
    }
    if (cfg.sleep_after_idle_minutes !== 30 || cfg.sleep_while_working_minutes !== 0) { console.log(`FAIL sleep defaults ${JSON.stringify(cfg)}`); ok = false; }

    const plat = detectPlatform();
    console.log(`platform ${plat} backend ${detectLinuxBackend()}`);
    if (plat === 'windows' || plat === 'wsl') {
      const k = probeWindowsKeeper();
      console.log(`probe keeper ${JSON.stringify(k)}`);
      if (!k.pass) { console.log('FAIL windows keeper probe'); ok = false; }
      const a = windowsApiProbe();
      console.log(`probe api ${JSON.stringify(a)}`);
      if (!a.pass) { console.log('FAIL windows api probe'); ok = false; }
    } else {
      const h = startInhibitor(plat);
      if (h) {
        console.log(`probe handle ${JSON.stringify(h)}`);
        const v = osVerifyInhibitor(plat, h.backend || h.kind, h);
        console.log(`verify ${JSON.stringify(v)}`);
        if (!v.osActive) { console.log('FAIL inhibitor not OS-verified'); ok = false; }
        stopInhibitor(plat, h);
        // Stop is async (SIGTERM): give the OS a moment to reflect it before asserting.
        for (let i = 0; i < 25 && h.pid != null && isAlive(h.pid); i++) spawnSync('sleep', ['0.2']);
        const v2 = osVerifyInhibitor(plat, h.backend || h.kind, h);
        console.log(`after stop verify ${JSON.stringify(v2)}`);
        if (v2.osActive) { console.log('FAIL inhibitor survived stop'); ok = false; }
      } else {
        console.log('no inhibitor started (degraded) — ok on headless');
      }
    }
    console.log(ok ? 'selftest PASS' : 'selftest FAIL');
  } catch (e) { console.log(`selftest error ${e.message}`); ok = false; }
  process.exit(ok ? 0 : 1);
}

module.exports = { selftest, selftestInner };