const { spawn } = require('node:child_process');

const { WORKING_FILE, INHIBIT_FILE } = require('./constants');
const { log, readJson, writeJsonAtomic, detectPlatform } = require('./util');
const { effectiveEnabled } = require('./config');
const { osVerifyInhibitor } = require('./verify');
const { startInhibitor, stopInhibitor } = require('./inhibitor');

function loadWorking() { return new Set(readJson(WORKING_FILE, [])); }
function saveWorking(set) { writeJsonAtomic(WORKING_FILE, [...set]); }
function loadInhibitor() { return readJson(INHIBIT_FILE, { active: false, handle: null, platform: null, backend: null, firstActiveTime: null, lastInactiveTime: null }); }

function reconcile() {
  const platform = detectPlatform();
  const working = loadWorking();
  const eff = effectiveEnabled();
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
        const remaining = cfg.start_grace_seconds * 1000 - elapsed;
        log(`grace: waiting start ${elapsed}ms < ${cfg.start_grace_seconds}s, retry in ${remaining}ms`);
        const secs = Math.ceil(remaining / 1000);
        try { spawn('sh', ['-c', `sleep ${secs} && "${process.execPath}" "${require.main.filename}" __grace_retry`], { detached: true, stdio: 'ignore', env: process.env }).unref(); } catch {}
        return;
      }
    } else if (!rawShouldBeActive && inhibitor.active) {
      const last = inhibitor.lastInactiveTime || now;
      if (!inhibitor.lastInactiveTime) { inhibitor.lastInactiveTime = last; inhibitor.firstActiveTime = null; writeJsonAtomic(INHIBIT_FILE, inhibitor); }
      const elapsed = now - last;
      if (elapsed < cfg.stop_grace_seconds * 1000) {
        const remaining = cfg.stop_grace_seconds * 1000 - elapsed;
        log(`grace: waiting stop ${elapsed}ms < ${cfg.stop_grace_seconds}s, retry in ${remaining}ms`);
        const secs = Math.ceil(remaining / 1000);
        try { spawn('sh', ['-c', `sleep ${secs} && "${process.execPath}" "${require.main.filename}" __grace_retry`], { detached: true, stdio: 'ignore', env: process.env }).unref(); } catch {}
        return;
      }
    } else {
      inhibitor.firstActiveTime = null;
      inhibitor.lastInactiveTime = null;
      writeJsonAtomic(INHIBIT_FILE, inhibitor);
    }
  } else {
    inhibitor.firstActiveTime = null;
    inhibitor.lastInactiveTime = null;
    writeJsonAtomic(INHIBIT_FILE, inhibitor);
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

module.exports = { loadWorking, saveWorking, loadInhibitor, reconcile };