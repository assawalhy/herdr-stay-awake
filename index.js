#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || '.';
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || STATE_DIR;
const WORKING_FILE = path.join(STATE_DIR, 'working-panes.json');
const INHIBIT_FILE = path.join(STATE_DIR, 'inhibitor.json');
const LOG_FILE = path.join(STATE_DIR, 'stay-awake.log');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSION_FILE = path.join(STATE_DIR, 'session.json');
const LAST_PAYLOAD_FILE = path.join(STATE_DIR, 'last-payload.json');
const MARKER = 'herdr-stay-awake-inhibitor-marker';

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) { log(`write ${file} failed: ${e.message}`); }
}
function hasCommand(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}
function isAlive(pid) {
  if (!pid) return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.includes(') Z') || stat.includes(') X')) return false;
  } catch {}
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function detectPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  try {
    const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    if (v.includes('microsoft')) return 'wsl';
  } catch {}
  if (process.env.WSL_DISTRO_NAME) return 'wsl';
  return 'linux';
}
function socketHash() {
  const s = process.env.HERDR_SOCKET_PATH || 'default';
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}
function defaultConfig() {
  return { enabled: true, grace_enabled: true, start_grace_seconds: 5, stop_grace_seconds: 30 };
}
function loadGlobalConfig() {
  const c = readJson(CONFIG_FILE, null);
  if (!c || typeof c.enabled !== 'boolean') return defaultConfig();
  return {
    enabled: c.enabled,
    grace_enabled: !!c.grace_enabled,
    start_grace_seconds: Number(c.start_grace_seconds) || 5,
    stop_grace_seconds: Number(c.stop_grace_seconds) || 30,
  };
}
function saveGlobalConfig(c) { writeJsonAtomic(CONFIG_FILE, c); }
function loadSessionMap() {
  const m = readJson(SESSION_FILE, null);
  if (!m || typeof m !== 'object') return {};
  return m;
}
function saveSessionMap(m) { writeJsonAtomic(SESSION_FILE, m); }
function effectiveEnabled() {
  const g = loadGlobalConfig();
  if (!g.enabled) return { enabled: false, global: g, sessionEnabled: false, hash: socketHash() };
  const map = loadSessionMap();
  const h = socketHash();
  const sess = map[h];
  const sessionEnabled = sess == null ? true : !!sess.enabled;
  return { enabled: sessionEnabled, global: g, sessionEnabled, hash: h, map };
}
function setGlobalEnabled(v) {
  const c = loadGlobalConfig();
  c.enabled = !!v;
  saveGlobalConfig(c);
}
function setSessionEnabled(v) {
  const map = loadSessionMap();
  const h = socketHash();
  map[h] = { enabled: !!v, updatedAt: new Date().toISOString() };
  saveSessionMap(map);
}

function startPidBacked(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { kind: 'pid', pid: child.pid, cmd, args };
}
function stopPidBacked(handle) {
  if (!handle || handle.pid == null) return;
  try { process.kill(-handle.pid, 'SIGTERM'); } catch {
    try { process.kill(handle.pid, 'SIGTERM'); } catch {}
  }
}
function macosStart() {
  return startPidBacked('caffeinate', ['-d', '-i', '-s', '-w', String(process.pid)]);
}
function macosStop(handle) { return stopPidBacked(handle); }
function systemdStart() {
  return startPidBacked('systemd-inhibit', [
    '--what=sleep:idle', '--who=herdr-stay-awake', '--why=herdr agent is working', '--mode=block', 'sleep', 'infinity',
  ]);
}
function systemdStop(handle) { return stopPidBacked(handle); }
function dbusCall(args) {
  if (hasCommand('gdbus')) {
    const r = spawnSync('gdbus', args, { encoding: 'utf8', timeout: 5000 });
    return r;
  }
  if (hasCommand('dbus-send')) {
    const bus = args.includes('--session') ? '--session' : '--session';
    const destIdx = args.indexOf('--dest');
    const dest = destIdx !== -1 ? args[destIdx + 1] : '';
    const pathIdx = args.indexOf('--object-path');
    const obj = pathIdx !== -1 ? args[pathIdx + 1] : '';
    const methodIdx = args.indexOf('--method');
    const method = methodIdx !== -1 ? args[methodIdx + 1] : '';
    const extra = args.slice(methodIdx + 2);
    const sendArgs = [bus, `--dest=${dest}`, obj, method, ...extra];
    const r = spawnSync('dbus-send', sendArgs, { encoding: 'utf8', timeout: 5000 });
    return r;
  }
  return null;
}
function gnomeStart() {
  const r = dbusCall(['call', '--session', '--dest', 'org.gnome.SessionManager', '--object-path', '/org/gnome/SessionManager', '--method', 'org.gnome.SessionManager.Inhibit', 'herdr-stay-awake', '0', 'herdr agent working', '8']);
  if (!r || r.status !== 0) return null;
  const m = r.stdout.match(/\(uint32 (\d+),?\)/) || r.stdout.match(/(\d+)/);
  if (!m) return null;
  const cookie = parseInt(m[1], 10);
  return { kind: 'dbus', backend: 'gnome', cookie };
}
function gnomeStop(handle) {
  if (!handle || handle.cookie == null) return;
  dbusCall(['call', '--session', '--dest', 'org.gnome.SessionManager', '--object-path', '/org/gnome/SessionManager', '--method', 'org.gnome.SessionManager.Uninhibit', String(handle.cookie)]);
}
function freedesktopStart() {
  const r = dbusCall(['call', '--session', '--dest', 'org.freedesktop.ScreenSaver', '--object-path', '/org/freedesktop/ScreenSaver', '--method', 'org.freedesktop.ScreenSaver.Inhibit', 'herdr-stay-awake', 'herdr agent working']);
  if (!r || r.status !== 0) return null;
  const m = r.stdout.match(/\(uint32 (\d+),?\)/) || r.stdout.match(/(\d+)/);
  if (!m) return null;
  const cookie = parseInt(m[1], 10);
  return { kind: 'dbus', backend: 'freedesktop', cookie };
}
function freedesktopStop(handle) {
  if (!handle || handle.cookie == null) return;
  dbusCall(['call', '--session', '--dest', 'org.freedesktop.ScreenSaver', '--object-path', '/org/freedesktop/ScreenSaver', '--method', 'org.freedesktop.ScreenSaver.UnInhibit', String(handle.cookie)]);
}
function xdgStart() {
  const r = spawnSync('xdg-screensaver', ['suspend', ':0'], { stdio: 'ignore', timeout: 3000 });
  if (r.status === 0) return { kind: 'xdg', backend: 'xdg-screensaver' };
  return null;
}
function xdgStop() {
  spawnSync('xdg-screensaver', ['resume', ':0'], { stdio: 'ignore', timeout: 3000 });
}
function detectLinuxBackend() {
  if (hasCommand('systemd-inhibit')) {
    const r = spawnSync('systemd-inhibit', ['--list'], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 || r.stdout) return 'systemd-inhibit';
  }
  if (hasCommand('gdbus') || hasCommand('dbus-send')) {
    const testGnome = dbusCall(['call', '--session', '--dest', 'org.gnome.SessionManager', '--object-path', '/org/gnome/SessionManager', '--method', 'org.freedesktop.DBus.Introspectable.Introspect']);
    if (testGnome && testGnome.status === 0) return 'gnome';
    const testFd = dbusCall(['call', '--session', '--dest', 'org.freedesktop.ScreenSaver', '--object-path', '/org/freedesktop/ScreenSaver', '--method', 'org.freedesktop.DBus.Introspectable.Introspect']);
    if (testFd && testFd.status === 0) return 'freedesktop';
    return 'dbus';
  }
  if (hasCommand('xdg-screensaver')) return 'xdg-screensaver';
  if (hasCommand('xset')) return 'xset';
  return 'none';
}
function powershellScript() {
  return [
    '$sig = @"',
    '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);',
    '"@',
    'Add-Type -MemberDefinition $sig -Name Power -Namespace Herdr | Out-Null',
    `# ${MARKER}`,
    '[Herdr.Power]::SetThreadExecutionState(0x80000001) | Out-Null',
    'while ($true) { Start-Sleep -Seconds 60 }',
  ].join('\n');
}
function wslScriptPaths() {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'echo $env:TEMP'], { encoding: 'utf8', timeout: 3000 });
    const winTemp = (r.stdout || '').trim().replace(/\r/g, '');
    if (winTemp) {
      const wsl = spawnSync('wslpath', ['-u', winTemp], { encoding: 'utf8', timeout: 2000 });
      const wslTemp = (wsl.stdout || '').trim() || winTemp.replace(/^C:/, '/mnt/c').replace(/\\/g, '/');
      return { win: winTemp, wsl: wslTemp };
    }
  } catch {}
  return { win: 'C:\\Users\\A\\AppData\\Local\\Temp', wsl: '/mnt/c/Users/A/AppData/Local/Temp' };
}
function windowsLikeStart() {
  const plat = detectPlatform();
  let scriptPathWin, scriptPathWsl;
  if (plat === 'wsl') {
    const p = wslScriptPaths();
    scriptPathWin = `${p.win}\\stay-awake-${MARKER}.ps1`;
    scriptPathWsl = `${p.wsl}/stay-awake-${MARKER}.ps1`;
    try { fs.mkdirSync(p.wsl, { recursive: true }); } catch {}
    try { fs.writeFileSync(scriptPathWsl, powershellScript()); } catch (e) { log(`wsl write failed ${e.message}`); }
  } else {
    scriptPathWin = path.join(STATE_DIR, `stay-awake-${MARKER}.ps1`);
    try { fs.writeFileSync(scriptPathWin, powershellScript()); } catch {}
  }
  const fileArg = scriptPathWin;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', fileArg], { detached: true, stdio: 'ignore' });
  child.unref();
  return { kind: 'marker', backend: 'powershell', scriptPath: fileArg };
}
function windowsLikeStop() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-File*${MARKER}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore', timeout: 8000 });
  if (result.error) log(`windowsLikeStop error: ${result.error.message}`);
  try {
    const plat = detectPlatform();
    if (plat === 'wsl') {
      const p = wslScriptPaths();
      try { fs.unlinkSync(`${p.wsl}/stay-awake-${MARKER}.ps1`); } catch {}
    } else {
      try { fs.unlinkSync(path.join(STATE_DIR, `stay-awake-${MARKER}.ps1`)); } catch {}
    }
  } catch {}
}

function osVerifyInhibitor(platform, backend, handle) {
  try {
    if (platform === 'macos') {
      if (!handle || handle.pid == null) return { osActive: false, detail: 'no handle' };
      if (!isAlive(handle.pid)) return { osActive: false, detail: `pid ${handle.pid} dead` };
      const r = spawnSync('pmset', ['-g', 'assertions'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0 && r.stdout.includes('caffeinate')) return { osActive: true, detail: `caffeinate pid ${handle.pid} alive + pmset shows caffeinate` };
      return { osActive: true, detail: `pid ${handle.pid} alive (pmset unavailable)` };
    }
    if (platform === 'linux') {
      if (!handle) return { osActive: false, detail: 'no handle' };
      if (handle.kind === 'pid') {
        if (!isAlive(handle.pid)) return { osActive: false, detail: `pid ${handle.pid} dead` };
        const r = spawnSync('systemd-inhibit', ['--list'], { encoding: 'utf8', timeout: 3000 });
        if (r.status === 0 && r.stdout.includes('herdr-stay-awake')) return { osActive: true, detail: `pid ${handle.pid} alive + systemd-inhibit lists us` };
        return { osActive: true, detail: `pid ${handle.pid} alive` };
      }
      if (handle.kind === 'dbus') {
        return { osActive: true, detail: `dbus cookie ${handle.cookie} backend ${handle.backend} (session bus)` };
      }
      if (handle.kind === 'xdg') return { osActive: true, detail: 'xdg-screensaver suspend active' };
      return { osActive: !!handle, detail: `handle ${JSON.stringify(handle)}` };
    }
    if (platform === 'windows' || platform === 'wsl') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-File*${MARKER}*' } | Measure-Object | Select-Object -ExpandProperty Count`], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) {
        const count = parseInt((r.stdout || '').trim(), 10);
        if (!isNaN(count) && count > 0) return { osActive: true, detail: `marker process count ${count}` };
        return { osActive: false, detail: 'no marker process' };
      }
      return { osActive: false, detail: 'powershell query failed' };
    }
  } catch (e) { return { osActive: false, detail: `verify error: ${e.message}` }; }
  return { osActive: false, detail: 'unknown platform' };
}

function linuxInhibitStart() {
  const backend = detectLinuxBackend();
  log(`linux backend detected: ${backend}`);
  if (backend === 'systemd-inhibit') {
    const h = systemdStart();
    if (h) { h.backend = 'systemd-inhibit'; return h; }
  }
  if (backend === 'gnome' || backend === 'dbus') {
    const h = gnomeStart();
    if (h) return h;
  }
  if (backend === 'freedesktop' || backend === 'dbus') {
    const h = freedesktopStart();
    if (h) return h;
  }
  if (backend === 'gnome' || backend === 'freedesktop' || backend === 'dbus') {
    const h1 = gnomeStart(); if (h1) return h1;
    const h2 = freedesktopStart(); if (h2) return h2;
  }
  if (hasCommand('xdg-screensaver')) {
    const h = xdgStart();
    if (h) return h;
  }
  if (hasCommand('xset')) {
    spawnSync('xset', ['s', 'off', '-dpms'], { stdio: 'ignore', timeout: 2000 });
    return { kind: 'xset', backend: 'xset' };
  }
  log('no linux inhibitor available, degraded');
  return null;
}
function linuxInhibitStop(handle) {
  if (!handle) return;
  if (handle.kind === 'pid') return systemdStop(handle);
  if (handle.kind === 'dbus') {
    if (handle.backend === 'gnome') return gnomeStop(handle);
    if (handle.backend === 'freedesktop') return freedesktopStop(handle);
    gnomeStop(handle); freedesktopStop(handle);
    return;
  }
  if (handle.kind === 'xdg') return xdgStop();
  if (handle.kind === 'xset') { spawnSync('xset', ['s', 'on', '+dpms'], { stdio: 'ignore', timeout: 2000 }); return; }
}

function startInhibitor(platform) {
  switch (platform) {
    case 'macos': return macosStart();
    case 'linux': return linuxInhibitStart();
    case 'windows':
    case 'wsl': return windowsLikeStart();
    default: log(`unknown platform "${platform}"`); return null;
  }
}
function stopInhibitor(platform, handle) {
  switch (platform) {
    case 'macos': return macosStop(handle);
    case 'linux': return linuxInhibitStop(handle);
    case 'windows':
    case 'wsl': return windowsLikeStop();
  }
}

function loadWorking() { return new Set(readJson(WORKING_FILE, [])); }
function saveWorking(set) { writeJsonAtomic(WORKING_FILE, [...set]); }
function loadInhibitor() { return readJson(INHIBIT_FILE, { active: false, handle: null, platform: null, backend: null, firstActiveTime: null, lastInactiveTime: null }); }

function reconcile() {
  const platform = detectPlatform();
  const working = loadWorking();
  const eff = effectiveEnabled();
  // if disabled, force inactive
  const rawShouldBeActive = working.size > 0 && eff.enabled;
  let inhibitor = loadInhibitor();
  const cfg = eff.global;
  const now = Date.now();

  if (cfg.grace_enabled) {
    if (rawShouldBeActive && !inhibitor.active) {
      const first = inhibitor.firstActiveTime || now;
      if (!inhibitor.firstActiveTime) { inhibitor.firstActiveTime = first; inhibitor.lastInactiveTime = null; writeJsonAtomic(INHIBIT_FILE, inhibitor); }
      const elapsed = now - first;
      if (elapsed < cfg.start_grace_seconds * 1000) {
        log(`grace: waiting start ${elapsed}ms < ${cfg.start_grace_seconds}s`);
        return;
      }
    } else if (!rawShouldBeActive && inhibitor.active) {
      const last = inhibitor.lastInactiveTime || now;
      if (!inhibitor.lastInactiveTime) { inhibitor.lastInactiveTime = last; inhibitor.firstActiveTime = null; writeJsonAtomic(INHIBIT_FILE, inhibitor); }
      const elapsed = now - last;
      if (elapsed < cfg.stop_grace_seconds * 1000) {
        log(`grace: waiting stop ${elapsed}ms < ${cfg.stop_grace_seconds}s`);
        return;
      }
    } else {
      inhibitor.firstActiveTime = null;
      inhibitor.lastInactiveTime = null;
    }
  } else {
    inhibitor.firstActiveTime = null;
    inhibitor.lastInactiveTime = null;
  }

  inhibitor = loadInhibitor();
  const shouldBeActive = rawShouldBeActive;

  if (shouldBeActive && !inhibitor.active) {
    log(`starting inhibitor (platform=${platform}, backend probe, working=${working.size}, enabled=${eff.enabled})`);
    const handle = startInhibitor(platform);
    const backend = handle ? (handle.backend || handle.kind) : 'none';
    if (!handle) log(`inhibitor start failed or degraded (backend=${backend})`);
    writeJsonAtomic(INHIBIT_FILE, { active: !!handle, handle, platform, backend, firstActiveTime: null, lastInactiveTime: null });
  } else if (!shouldBeActive && inhibitor.active) {
    log(`stopping inhibitor (platform=${platform})`);
    stopInhibitor(inhibitor.platform || platform, inhibitor.handle);
    writeJsonAtomic(INHIBIT_FILE, { active: false, handle: null, platform, backend: null, firstActiveTime: null, lastInactiveTime: null });
  } else if (inhibitor.active) {
    const v = osVerifyInhibitor(inhibitor.platform || platform, inhibitor.backend, inhibitor.handle);
    if (!v.osActive) {
      log(`inhibitor handle dead but still marked active (${v.detail}), restarting`);
      stopInhibitor(inhibitor.platform || platform, inhibitor.handle);
      const handle = startInhibitor(platform);
      const backend = handle ? (handle.backend || handle.kind) : 'none';
      writeJsonAtomic(INHIBIT_FILE, { active: !!handle, handle, platform, backend, firstActiveTime: null, lastInactiveTime: null });
    }
  }
}

function runHerdr(args) {
  const bin = process.env.HERDR_BIN_PATH || 'herdr';
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000 });
  if (r.error) { log(`herdr ${args.join(' ')} failed: ${r.error.message}`); return null; }
  if (r.status !== 0) { log(`herdr ${args.join(' ')} exited ${r.status}: ${r.stderr}`); return null; }
  try { return JSON.parse(r.stdout); } catch { log(`herdr ${args.join(' ')} non-JSON: ${r.stdout}`); return null; }
}
function extractAgents(data) {
  if (!data) return [];
  if (Array.isArray(data.result)) return data.result;
  if (data.result && Array.isArray(data.result.agents)) return data.result.agents;
  if (Array.isArray(data.agents)) return data.agents;
  if (Array.isArray(data)) return data;
  return [];
}
function syncFromAgentList() {
  const data = runHerdr(['agent', 'list']);
  const working = new Set();
  for (const a of extractAgents(data)) {
    const status = a.status || a.agent_status;
    const paneId = a.pane_id || a.pane || a.paneId;
    if (status === 'working' && paneId) working.add(paneId);
  }
  saveWorking(working);
  log(`startup sync: ${working.size} pane(s) working`);
}
function extractPaneAndStatus(payload) {
  const paneId = payload.pane_id || payload.pane || payload.paneId;
  const status = payload.agent_status || payload.status;
  return { paneId, status };
}
function handleEvent() {
  let payload = {};
  try { payload = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || '{}'); } catch { log(`bad HERDR_PLUGIN_EVENT_JSON`); }
  try { writeJsonAtomic(LAST_PAYLOAD_FILE, payload); } catch {}
  const { paneId, status } = extractPaneAndStatus(payload);
  if (!paneId) { log(`event no pane id: ${JSON.stringify(payload)}`); return; }
  const working = loadWorking();
  if (status === 'working') working.add(paneId); else working.delete(paneId);
  saveWorking(working);
}

// status / doctor
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
    console.log('\n--- probe: 1-sec spawn round-trip ---');
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'herdr-stay-awake-probe-'));
    const origState = process.env.HERDR_PLUGIN_STATE_DIR;
    process.env.HERDR_PLUGIN_STATE_DIR = tmpDir;
    try {
      const plat = detectPlatform();
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
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(h, null, 2));
}

function parseArgsEnable() {
  const argv = process.argv.slice(2);
  const hasSession = argv.includes('--session') || argv.includes('--per-session');
  const hasGlobal = argv.includes('--global');
  return { hasSession, hasGlobal, argv };
}
function actionEnable() {
  const { hasSession, hasGlobal } = parseArgsEnable();
  if (hasSession) { setSessionEnabled(true); console.log('enabled for this session'); }
  else if (hasGlobal) { setGlobalEnabled(true); console.log('enabled globally'); }
  else { setGlobalEnabled(true); setSessionEnabled(true); console.log('enabled globally + session'); }
  reconcile();
  actionStatus();
}
function actionDisable() {
  const { hasSession, hasGlobal } = parseArgsEnable();
  if (hasSession) { setSessionEnabled(false); console.log('disabled for this session'); }
  else if (hasGlobal) { setGlobalEnabled(false); console.log('disabled globally'); }
  else { setGlobalEnabled(false); console.log('disabled globally (session follows global)'); }
  // disable must kill inhibitor and restore OS
  const inhibitor = loadInhibitor();
  if (inhibitor.active) {
    stopInhibitor(inhibitor.platform || detectPlatform(), inhibitor.handle);
    writeJsonAtomic(INHIBIT_FILE, { active: false, handle: null, platform: detectPlatform(), backend: null, firstActiveTime: null, lastInactiveTime: null });
  }
  actionStatus();
}
function actionToggle() {
  const eff = effectiveEnabled();
  if (eff.enabled) { actionDisable(); } else { actionEnable(); }
}

function settingsPane() {
  const readline = require('node:readline');
  function render() {
    console.clear();
    const h = healthCheck();
    const s = h.status;
    console.log('Stay Awake — Settings (q quit, r refresh, g toggle global, s toggle session, d doctor, t toggle grace)\n');
    console.log(`Platform: ${s.platform}  Backend: ${s.backend}`);
    console.log(`Working: ${s.workingCount}  Inhibitor: ${s.inhibitor.active ? 'ACTIVE' : 'inactive'}  OS: ${s.osVerified.osActive ? 'awake' : 'not awake'}`);
    console.log(`  ${s.osVerified.detail}`);
    console.log(`\nEnabled: effective=${s.enabled ? 'YES' : 'NO'}  global=${s.globalEnabled ? 'on' : 'off'}  session(${s.sessionHash})=${s.sessionEnabled ? 'on' : 'off'}`);
    console.log(`Grace: ${s.grace.enabled ? `on ${s.grace.startGrace}s/${s.grace.stopGrace}s` : 'off'}`);
    if (h.issues.length) { console.log(`\nIssues:`); h.issues.forEach(i => console.log(`  - ${i}`)); } else console.log(`\nHealth: ${h.healthy ? 'OK' : 'see issues'}`);
    console.log(`\nKeys: [g] toggle global  [s] toggle session  [t] toggle grace  [d] doctor  [r] refresh  [q] quit`);
  }
  render();
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) { process.exit(0); }
    if (key.name === 'r') { render(); }
    if (key.name === 'g') { const c = loadGlobalConfig(); c.enabled = !c.enabled; saveGlobalConfig(c); if (!c.enabled) { const inh = loadInhibitor(); if (inh.active) { stopInhibitor(inh.platform || detectPlatform(), inh.handle); writeJsonAtomic(INHIBIT_FILE, { active: false, handle: null, platform: detectPlatform(), backend: null, firstActiveTime: null, lastInactiveTime: null }); } } else reconcile(); render(); }
    if (key.name === 's') { const m = loadSessionMap(); const h = socketHash(); const cur = m[h] ? !!m[h].enabled : true; m[h] = { enabled: !cur, updatedAt: new Date().toISOString() }; saveSessionMap(m); if (!m[h].enabled) { const inh = loadInhibitor(); if (inh.active) { stopInhibitor(inh.platform || detectPlatform(), inh.handle); writeJsonAtomic(INHIBIT_FILE, { active: false, handle: null, platform: detectPlatform(), backend: null, firstActiveTime: null, lastInactiveTime: null }); } } else reconcile(); render(); }
    if (key.name === 't') { const c = loadGlobalConfig(); c.grace_enabled = !c.grace_enabled; saveGlobalConfig(c); render(); }
    if (key.name === 'd') { console.clear(); actionDoctor({ probe: false }); console.log('\npress r to return'); }
  });
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join('/tmp', 'herdr-stay-awake-selftest-'));
  console.log(`selftest tmp ${tmp}`);
  const origState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = tmp;
  let ok = true;
  try {
    // busy/idle extraction
    const fakeBusy = { agent_status: 'working', pane_id: 'p1' };
    const { paneId, status } = extractPaneAndStatus(fakeBusy);
    if (paneId !== 'p1' || status !== 'working') { console.log('FAIL extract busy'); ok = false; }
    const fakeIdle = { agent_status: 'idle', pane_id: 'p1' };
    const { status: s2 } = extractPaneAndStatus(fakeIdle);
    if (s2 !== 'idle') { console.log('FAIL extract idle'); ok = false; }
    // working set
    saveWorking(new Set(['a', 'b']));
    const ws = loadWorking();
    if (ws.size !== 2) { console.log('FAIL working set'); ok = false; }
    // inhibitor round-trip in tmp
    const plat = detectPlatform();
    console.log(`platform ${plat} backend ${detectLinuxBackend()}`);
    const h = startInhibitor(plat);
    if (h) {
      console.log(`probe handle ${JSON.stringify(h)}`);
      const v = osVerifyInhibitor(plat, h.backend || h.kind, h);
      console.log(`verify ${JSON.stringify(v)}`);
      stopInhibitor(plat, h);
      const v2 = osVerifyInhibitor(plat, h.backend || h.kind, h);
      console.log(`after stop verify ${JSON.stringify(v2)}`);
      if (v2.osActive) { console.log('FAIL inhibitor survived stop'); ok = false; }
    } else {
      console.log('no inhibitor started (degraded) — ok on headless');
    }
    console.log(ok ? 'selftest PASS' : 'selftest FAIL');
  } finally {
    process.env.HERDR_PLUGIN_STATE_DIR = origState;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  process.exit(ok ? 0 : 1);
}

function main() {
  const entry = process.env.HERDR_PLUGIN_ENTRYPOINT_ID;
  const action = process.env.HERDR_PLUGIN_ACTION_ID;
  const argv = process.argv.slice(2);

  if (argv.includes('selftest')) return selftest();
  if (entry === 'settings' || argv.includes('settings')) return settingsPane();

  if (action) {
    const id = action.includes('.') ? action.split('.').pop() : action;
    const probe = argv.includes('--probe');
    if (id === 'status') return actionStatus();
    if (id === 'doctor') return actionDoctor({ probe });
    if (id === 'enable') return actionEnable();
    if (id === 'disable') return actionDisable();
    if (id === 'toggle') return actionToggle();
    // fallback: try argv[0]
    const a = argv[0];
    if (a === 'status') return actionStatus();
    if (a === 'doctor') return actionDoctor({ probe });
    if (a === 'enable') return actionEnable();
    if (a === 'disable') return actionDisable();
    if (a === 'toggle') return actionToggle();
    console.log(`unknown action ${action} argv ${argv}`);
    return;
  }

  if (argv[0] && ['status', 'doctor', 'enable', 'disable', 'toggle', 'settings'].includes(argv[0])) {
    if (argv[0] === 'status') return actionStatus();
    if (argv[0] === 'doctor') return actionDoctor({ probe: argv.includes('--probe') });
    if (argv[0] === 'enable') return actionEnable();
    if (argv[0] === 'disable') return actionDisable();
    if (argv[0] === 'toggle') return actionToggle();
    if (argv[0] === 'settings') return settingsPane();
  }

  const event = process.env.HERDR_PLUGIN_EVENT;
  if (event === 'startup') syncFromAgentList();
  else if (event) handleEvent();
  else if (!process.env.HERDR_PLUGIN_STATE_DIR && !process.env.HERDR_PLUGIN_CONFIG_DIR) {
    // no herdr env, show help
    console.log('Stay Awake — run via herdr plugin actions or events. Commands: status, doctor --probe, enable, disable, toggle, settings, selftest');
    return;
  }
  reconcile();
}
main();
