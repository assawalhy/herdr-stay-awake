const { spawn } = require('node:child_process');

const fs = require('node:fs');

const { WORKING_FILE, INHIBIT_FILE, WATCHDOG_PID_FILE } = require('./constants');
const { log, readJson, writeJsonAtomic, detectPlatform } = require('./util');
const { effectiveEnabled, maxHoldSeconds } = require('./config');
const { osVerifyInhibitor } = require('./verify');
const { startInhibitor, stopInhibitor } = require('./inhibitor');
const { ensureWatchdog, stopWatchdog, readWatchdogPid, writeWatchdogPid, WATCHDOG_INTERVAL_MS } = require('./watchdog');

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

  // The Linux block must not outlive the work it was taken for: keep a
  // liveness watchdog tied to the inhibitor's lifetime. Linux-only — the
  // Windows/WSL keeper and macOS caffeinate have their own liveness handling.
  if (platform === 'linux') { if (loadInhibitor().active) ensureWatchdog(); else stopWatchdog(); }
}

function releaseInhibitor() {
  const platform = detectPlatform();
  const inhibitor = loadInhibitor();
  if (!inhibitor.active) { stopWatchdog(); return false; }
  log(`releasing inhibitor (platform=${inhibitor.platform || platform})`);
  stopInhibitor(inhibitor.platform || platform, inhibitor.handle);
  writeJsonAtomic(INHIBIT_FILE, { active: false, handle: null, platform, backend: null, firstActiveTime: null, lastInactiveTime: null });
  return true;
}

function herdrSocketGone() {
  const sock = process.env.HERDR_SOCKET_PATH;
  if (!sock) return false;
  try { return !fs.existsSync(sock); } catch { return false; }
}

// Detached, single-instance watchdog entrypoint (`node index.js __watchdog`).
// Re-syncs from `herdr agent list` so a missed event cannot pin the block until
// the 12h hold cap. Exits as soon as the inhibitor is no longer active.
async function watchdogLoop() {
  const me = process.pid;
  writeWatchdogPid(me);
  const deadline = Date.now() + maxHoldSeconds() * 1000;
  const maxFailures = 5;
  let failures = 0;
  log(`watchdog: loop start pid ${me} interval ${WATCHDOG_INTERVAL_MS}ms maxHold ${maxHoldSeconds()}s`);
  for (;;) {
    if (!loadInhibitor().active) { log('watchdog: inhibitor not active, exiting'); break; }
    if (Date.now() >= deadline) { log('watchdog: max hold reached, releasing'); releaseInhibitor(); break; }
    if (herdrSocketGone()) { log('watchdog: herdr socket gone, releasing'); releaseInhibitor(); break; }
    const { syncFromAgentList } = require('./herdr'); // lazy: avoids a require cycle
    const ok = syncFromAgentList();
    failures = ok ? 0 : failures + 1;
    if (failures >= maxFailures) { log(`watchdog: herdr agent list failed ${failures}x, releasing`); releaseInhibitor(); break; }
    reconcile();
    if (!loadInhibitor().active) { log('watchdog: released by reconcile, exiting'); break; }
    await new Promise((r) => setTimeout(r, WATCHDOG_INTERVAL_MS));
  }
  try { const cur = readWatchdogPid(); if (cur === me || cur == null) fs.unlinkSync(WATCHDOG_PID_FILE); } catch {}
  log('watchdog: loop end');
}

module.exports = { loadWorking, saveWorking, loadInhibitor, reconcile, releaseInhibitor, watchdogLoop };