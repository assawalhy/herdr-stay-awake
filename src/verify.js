const { spawnSync } = require('node:child_process');

const { isAlive, readJson } = require('./util');
const { markerProcessCount } = require('./backends/windows');

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
      const hbPath = handle && handle.heartbeatPath;
      const hb = hbPath ? readJson(hbPath, null) : null;
      if (!hb || typeof hb.assertedAt !== 'number') return { osActive: false, detail: `heartbeat missing (marker procs ${markerProcessCount()})` };
      const age = Date.now() - hb.assertedAt;
      if (age > 90000) return { osActive: false, detail: `heartbeat stale ${Math.round(age / 1000)}s (marker procs ${markerProcessCount()})` };
      if (hb.lastError) return { osActive: false, detail: `keeper error: ${hb.lastError}` };
      return { osActive: true, detail: `ES held since ${new Date(hb.firstAt).toISOString()}, last assert ${Math.round(age / 1000)}s ago, retval ${hb.lastRetval}` };
    }
  } catch (e) { return { osActive: false, detail: `verify error: ${e.message}` }; }
  return { osActive: false, detail: 'unknown platform' };
}

module.exports = { osVerifyInhibitor };