const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { STATE_DIR, CONFIG_FILE, SESSION_FILE, INHIBIT_FILE, WORKING_FILE, LAST_PAYLOAD_FILE } = require('./constants');
const { readJson, hasCommand, detectPlatform } = require('./util');
const { effectiveEnabled } = require('./config');
const { loadWorking, loadInhibitor } = require('./state');
const { osVerifyInhibitor } = require('./verify');
const { startInhibitor, stopInhibitor } = require('./inhibitor');
const { detectLinuxBackend } = require('./backends/linux');
const { probeWindowsKeeper, windowsApiProbe, windowsBatteryInfo } = require('./backends/windows');

function collectStatus() {
  const platform = detectPlatform();
  const working = loadWorking();
  const inhibitor = loadInhibitor();
  const eff = effectiveEnabled();
  let backend = inhibitor.backend || inhibitor.platform || null;
  if (!backend) {
    if (platform === 'linux') backend = detectLinuxBackend();
    else if (platform === 'wsl' || platform === 'windows') backend = 'powershell';
    else backend = platform;
  }
  const os = inhibitor.active ? osVerifyInhibitor(inhibitor.platform || platform, inhibitor.backend, inhibitor.handle) : { osActive: false, detail: 'inhibitor not active' };
  const cfg = eff.global;
  return {
    platform,
    backend,
    enabled: eff.enabled,
    globalEnabled: cfg.enabled,
    sessionEnabled: eff.sessionEnabled,
    sessionHash: eff.hash,
    workingCount: working.size,
    inhibitor: { active: !!inhibitor.active, handle: inhibitor.handle, platform: inhibitor.platform, backend: inhibitor.backend },
    osVerified: os,
    grace: { enabled: !!cfg.grace_enabled, startGrace: cfg.start_grace_seconds, stopGrace: cfg.stop_grace_seconds },
    maxHoldSeconds: cfg.max_hold_seconds,
    socketPath: process.env.HERDR_SOCKET_PATH || null,
    configPath: CONFIG_FILE,
    stateDir: STATE_DIR,
    lastPayload: readJson(LAST_PAYLOAD_FILE, null),
  };
}
function healthCheck() {
  const s = collectStatus();
  const issues = [];
  if (!s.enabled) issues.push('disabled (global or session)');
  if (s.backend === 'none') issues.push('no inhibitor backend available');
  if (s.inhibitor.active && !s.osVerified.osActive) issues.push(`inhibitor marked active but OS says inactive: ${s.osVerified.detail}`);
  if (!s.inhibitor.active && s.workingCount > 0 && s.enabled) issues.push('working but inhibitor not active');
  if (s.inhibitor.active && s.workingCount === 0) issues.push('inhibitor active but no working panes');
  const herdrOk = s.socketPath ? fs.existsSync(s.socketPath) || !!process.env.HERDR_BIN_PATH : true;
  if (!herdrOk) issues.push('herdr socket not found');
  return { status: s, issues, healthy: issues.length === 0 && s.enabled };
}
function actionStatus() {
  const h = healthCheck();
  const s = h.status;
  const lines = [];
  lines.push(`Stay Awake — ${h.healthy ? 'HEALTHY' : 'ISSUES'}`);
  lines.push(`  platform: ${s.platform} (backend: ${s.backend})`);
  lines.push(`  enabled: ${s.enabled ? 'yes' : 'no'} (global=${s.globalEnabled} session=${s.sessionEnabled} hash=${s.sessionHash})`);
  lines.push(`  working: ${s.workingCount} pane(s)`);
  lines.push(`  inhibitor: ${s.inhibitor.active ? 'active' : 'inactive'}${s.inhibitor.active ? ` (${JSON.stringify(s.inhibitor.handle)})` : ''}`);
  lines.push(`  OS verified: ${s.osVerified.osActive ? 'awake' : 'not awake'} — ${s.osVerified.detail}`);
  lines.push(`  grace: ${s.grace.enabled ? `on (${s.grace.startGrace}s/${s.grace.stopGrace}s)` : 'off'}`);
  lines.push(`  max hold: ${s.maxHoldSeconds}s`);
  if (h.issues.length) { lines.push(`  issues:`); h.issues.forEach(i => lines.push(`    - ${i}`)); }
  lines.push(`  config: ${s.configPath}`);
  lines.push(`  state: ${s.stateDir}`);
  const text = lines.join('\n');
  console.log(text);
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(h, null, 2));
}
function actionDoctor(opts) {
  const h = healthCheck();
  const s = h.status;
  console.log('=== Stay Awake Doctor ===');
  console.log(`platform: ${s.platform}`);
  console.log(`backend probe: ${s.backend}`);
  console.log(`  has systemd-inhibit: ${hasCommand('systemd-inhibit')}`);
  console.log(`  has gdbus: ${hasCommand('gdbus')}  dbus-send: ${hasCommand('dbus-send')}  qdbus: ${hasCommand('qdbus')}`);
  console.log(`  has xdg-screensaver: ${hasCommand('xdg-screensaver')}  xset: ${hasCommand('xset')}`);
  console.log(`  has caffeinate: ${hasCommand('caffeinate')}  powershell.exe: ${hasCommand('powershell.exe')}`);
  console.log(`enabled: global=${s.globalEnabled} session=${s.sessionEnabled} effective=${s.enabled} (hash ${s.sessionHash})`);
  console.log(`workingCount: ${s.workingCount}`);
  console.log(`inhibitor: ${JSON.stringify(s.inhibitor, null, 2)}`);
  console.log(`osVerified: ${JSON.stringify(s.osVerified, null, 2)}`);
  if (s.platform === 'windows' || s.platform === 'wsl') {
    const hbPath = s.inhibitor.handle && s.inhibitor.handle.heartbeatPath;
    console.log(`keeper script: ${s.inhibitor.handle && s.inhibitor.handle.scriptPath || '(n/a)'}`);
    console.log(`heartbeat: ${hbPath || '(n/a)'} exists=${hbPath ? fs.existsSync(hbPath) : 'n/a'}`);
    console.log(`max hold: ${s.maxHoldSeconds}s (config max_hold_seconds)`);
    console.log(`battery: ${JSON.stringify(windowsBatteryInfo())}`);
    console.log(`limits: ES cannot prevent lid-close, power-button, or battery-critical sleep; hibernate-after and WSL-freeze are outside control`);
  }
  console.log(`herdr socket: ${s.socketPath || '(none)'} exists=${s.socketPath ? fs.existsSync(s.socketPath) : 'n/a'}`);
  console.log(`herdr bin: ${process.env.HERDR_BIN_PATH || 'herdr (PATH)'}`);
  console.log(`config: ${s.configPath} exists=${fs.existsSync(s.configPath)}`);
  console.log(`session: ${SESSION_FILE} exists=${fs.existsSync(SESSION_FILE)}`);
  console.log(`inhibitor file: ${INHIBIT_FILE} exists=${fs.existsSync(INHIBIT_FILE)}`);
  console.log(`working file: ${WORKING_FILE} exists=${fs.existsSync(WORKING_FILE)}`);
  console.log(`last payload: ${JSON.stringify(s.lastPayload, null, 2)}`);
  if (h.issues.length) { console.log(`issues:`); h.issues.forEach(i => console.log(`  - ${i}`)); } else console.log('issues: none');
  console.log(`healthy: ${h.healthy}`);

  if (opts.probe) {
    const plat = detectPlatform();
    if (plat === 'windows' || plat === 'wsl') {
      console.log('\n--- probe: windows keeper round-trip + API probe ---');
      const k = probeWindowsKeeper();
      console.log(`probe: keeper ${JSON.stringify(k)}`);
      const a = windowsApiProbe();
      console.log(`probe: api ${JSON.stringify(a)}`);
      console.log(`probe: ${k.pass && a.pass ? 'PASS' : 'FAIL'}`);
    } else {
      console.log('\n--- probe: 1-sec spawn round-trip ---');
      const tmpDir = fs.mkdtempSync(path.join('/tmp', 'herdr-stay-awake-probe-'));
      const origState = process.env.HERDR_PLUGIN_STATE_DIR;
      process.env.HERDR_PLUGIN_STATE_DIR = tmpDir;
      try {
        const handle = startInhibitor(plat);
        if (!handle) { console.log('probe: no inhibitor started (degraded or no backend)'); }
        else {
          const v = osVerifyInhibitor(plat, handle.backend || handle.kind, handle);
          console.log(`probe: started ${JSON.stringify(handle)} osVerified=${JSON.stringify(v)}`);
          stopInhibitor(plat, handle);
          const v2 = osVerifyInhibitor(plat, handle.backend || handle.kind, handle);
          console.log(`probe: after stop osVerified=${JSON.stringify(v2)} (should be inactive)`);
          console.log(`probe: ${!v2.osActive ? 'PASS' : 'FAIL'}`);
        }
      } finally {
        process.env.HERDR_PLUGIN_STATE_DIR = origState;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }
  }
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(h, null, 2));
}

module.exports = { collectStatus, healthCheck, actionStatus, actionDoctor };