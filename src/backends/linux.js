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

module.exports = { systemdStart, systemdStop, dbusCall, gnomeStart, gnomeStop, freedesktopStart, freedesktopStop, xdgStart, xdgStop, detectLinuxBackend, linuxInhibitStart, linuxInhibitStop };