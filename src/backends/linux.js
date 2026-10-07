const { spawnSync } = require('node:child_process');

const { maxHoldSeconds } = require('../config');
const { log, hasCommand, startPidBacked, stopPidBacked } = require('../util');

function systemdStart() {
  return startPidBacked('systemd-inhibit', [
    '--what=sleep:idle', '--who=herdr-stay-awake', '--why=herdr agent is working', '--mode=block', 'sleep', String(maxHoldSeconds()),
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
// logind is the only thing that can tell us whether the OS *wanted* to sleep and
// was refused. `busctl get-property` prints one `t "value"` line per property.
function logindProps(props) {
  if (!hasCommand('busctl')) return null;
  const r = spawnSync('busctl', ['get-property', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', ...props], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0 || !r.stdout) return null;
  const lines = r.stdout.trim().split('\n');
  const out = {};
  props.forEach((p, i) => {
    // busctl prints `b false` / `t 1234`; some builds quote string values.
    const m = /^([bsitd])\s+(?:"([^"]*)"|(\S+))\s*$/.exec((lines[i] || '').trim());
    if (m) out[p] = { t: m[1], v: m[2] !== undefined ? m[2] : m[3] };
  });
  return Object.keys(out).length ? out : null;
}

// IdleHint/IdleSinceHint as the OS sees them. `idleSince` is epoch ms; idleForMs
// is how long the session has been idle. `available:false` means logind could not
// be asked — callers must treat that as "unknown", never as "idle".
function logindIdleState() {
  const p = logindProps(['IdleHint', 'IdleSinceHint']);
  if (!p || !p.IdleHint) return { available: false, idle: false, idleSince: null, idleForMs: 0 };
  const idleSinceMs = p.IdleSinceHint && p.IdleSinceHint.t === 't' ? Number(p.IdleSinceHint.v) / 1000 : NaN;
  const idle = p.IdleHint.v === 'true';
  const idleSince = Number.isFinite(idleSinceMs) && idleSinceMs > 0 ? Math.round(idleSinceMs) : null;
  return { available: true, idle, idleSince, idleForMs: idle && idleSince ? Date.now() - idleSince : 0 };
}

// True while an OS-level block inhibitor named herdr-stay-awake is registered,
// regardless of what our state file believes (the state file can be stale).
function osBlockHeld() {
  const r = spawnSync('systemd-inhibit', ['--list'], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0 || !r.stdout) return false;
  return r.stdout.includes('herdr-stay-awake');
}

// Pure decision: should we re-issue the OS sleep request right now? Kept separate
// from the call so the selftest can cover every branch without suspending anything.
//
// A refused `loginctl suspend` (our own block, or a lid/polkit refusal) is normal and
// must never be treated as an error — the watchdog just tries again on the next tick.
function nudgeDecision(ctx) {
  const { idleState, inhibitorHeldOs, workingCount, minIdleMs, quietMs } = ctx;
  if (inhibitorHeldOs) return { fire: false, reason: 'block still held' };
  if (workingCount > 0) return { fire: false, reason: `${workingCount} pane(s) working` };
  if (!idleState || !idleState.available) return { fire: false, reason: 'logind idle state unavailable' };
  if (!idleState.idle) return { fire: false, reason: 'session active' };
  if (idleState.idleForMs < minIdleMs) return { fire: false, reason: `idle ${Math.round(idleState.idleForMs / 1000)}s < margin ${Math.round(minIdleMs / 1000)}s` };
  if (quietMs < ctx.minQuietMs) return { fire: false, reason: `idle+quiet ${Math.round(quietMs / 1000)}s < ${Math.round(ctx.minQuietMs / 1000)}s (transient gap between turns?)` };
  return { fire: true, reason: `idle ${Math.round(idleState.idleForMs / 60000)}m >= margin, no working pane for ${Math.round(quietMs / 1000)}s` };
}

// Re-arms the sleep request GNOME gave up on. Goes through logind, so it is refused
// for as long as any block inhibitor stands — it never bypasses our own hold.
function suspendNudge(ctx) {
  const d = nudgeDecision(ctx);
  if (!d.fire) return Object.assign({}, d, { ran: false });
  if (ctx.dryRun) { log(`nudge: dry-run would suspend (${d.reason})`); return Object.assign({}, d, { ran: false, dryRun: true }); }
  const bin = hasCommand('loginctl') ? 'loginctl' : hasCommand('systemctl') ? 'systemctl' : null;
  if (!bin) { log('nudge: neither loginctl nor systemctl available'); return Object.assign({}, d, { ran: false }); }
  const r = spawnSync(bin, ['suspend'], { encoding: 'utf8', timeout: 20000 });
  const ok = r.status === 0;
  log(`nudge: ${bin} suspend -> ${ok ? 'sent' : `refused status=${r.status} ${(r.stderr || '').trim()}`} (${d.reason})`);
  return Object.assign({}, d, { ran: true, ok, status: r.status });
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

module.exports = { systemdStart, systemdStop, dbusCall, gnomeStart, gnomeStop, freedesktopStart, freedesktopStop, xdgStart, xdgStop, detectLinuxBackend, linuxInhibitStart, linuxInhibitStop, logindProps, logindIdleState, osBlockHeld, nudgeDecision, suspendNudge };