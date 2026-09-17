const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { detectPlatform } = require('./util');
const { saveWorking, loadWorking } = require('./state');
const { extractPaneAndStatus } = require('./herdr');
const { startInhibitor, stopInhibitor } = require('./inhibitor');
const { osVerifyInhibitor } = require('./verify');
const { detectLinuxBackend } = require('./backends/linux');
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