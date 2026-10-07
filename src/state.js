const { spawn } = require('node:child_process');

const fs = require('node:fs');

const { WORKING_FILE, INHIBIT_FILE, WATCHDOG_PID_FILE } = require('./constants');
const { log, readJson, writeJsonAtomic, detectPlatform } = require('./util');
const { effectiveEnabled, maxHoldSeconds } = require('./config');
const { osVerifyInhibitor } = require('./verify');
const { startInhibitor, stopInhibitor } = require('./inhibitor');
const { logindIdleState, osBlockHeld, suspendNudge } = require('./backends/linux');
const { ensureWatchdog, stopWatchdog, readWatchdogPid, writeWatchdogPid, WATCHDOG_INTERVAL_MS, NUDGE_INTERVAL_MS, NUDGE_QUIET_MS } = require('./watchdog');

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

  // Opt-in (sleep_while_working_minutes, default 0): let the machine sleep even
  // though panes are working, once the session has been idle that long. S3 freezes
  // the agents rather than killing them, so this trades progress for sleep. The
  // watchdog is deliberately left running — it will re-acquire if a pane goes
  // working again, and its linger phase performs the actual suspend.
  if (shouldBeActive && inhibitor.active && cfg.sleep_while_working_minutes > 0) {
    const idle = logindIdleState();
    if (idle.idle && idle.idleForMs >= cfg.sleep_while_working_minutes * 60000) {
      log(`sleep_while_working_minutes=${cfg.sleep_while_working_minutes}: session idle ${Math.round(idle.idleForMs / 60000)}m, releasing despite ${working.size} working pane(s)`);
      stopInhibitor(inhibitor.platform || platform, inhibitor.handle);
      writeJsonAtomic(INHIBIT_FILE, { active: false, handle: null, platform, backend: null, firstActiveTime: null, lastInactiveTime: null });
      return;
    }
  }

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

// Phase 1 — hold the block. Returns as soon as the inhibitor is gone for any
// reason (reconcile, max hold, herdr gone, agent list unreadable).
async function holdPhase() {
  const deadline = Date.now() + maxHoldSeconds() * 1000;
  const maxFailures = 5;
  let failures = 0;
  for (;;) {
    if (!loadInhibitor().active) return 'released';
    if (Date.now() >= deadline) { log('watchdog: max hold reached, releasing'); releaseInhibitor(); return 'max-hold'; }
    if (herdrSocketGone()) { log('watchdog: herdr socket gone, releasing'); releaseInhibitor(); return 'socket-gone'; }
    const { syncFromAgentList } = require('./herdr'); // lazy: avoids a require cycle
    const ok = syncFromAgentList();
    failures = ok ? 0 : failures + 1;
    if (failures >= maxFailures) { log(`watchdog: herdr agent list failed ${failures}x, releasing`); releaseInhibitor(); return 'agent-list-failed'; }
    reconcile();
    if (!loadInhibitor().active) return 'released-by-reconcile';
    await new Promise((r) => setTimeout(r, WATCHDOG_INTERVAL_MS));
  }
}

// Phase 2 — linger after the release and re-arm the OS sleep request.
//
// The desktop takes exactly one sleep shot per idle period. If a block inhibitor
// was standing when that timer expired, GNOME logs `BlockedByInhibitorLock` and
// never asks again — the machine then stays awake until the user touches it, even
// though nothing is holding the block any more. We are the only component that
// knows the block is gone, so we re-issue the request ourselves (through logind, so
// it is still refused while any inhibitor stands).
//
// Returns true if a block was re-acquired while lingering — the caller then resumes
// holding instead of exiting.
async function lingerPhase() {
  const eff0 = effectiveEnabled();
  if (!eff0.enabled) { log('watchdog: plugin disabled, no linger'); return false; }
  if (!(eff0.global.sleep_after_idle_minutes > 0)) { log('watchdog: sleep_after_idle_minutes=0, no linger'); return false; }
  const until = Date.now() + eff0.global.nudge_linger_minutes * 60000;
  log(`watchdog: linger ${eff0.global.nudge_linger_minutes}m to re-arm a refused suspend (margin ${eff0.global.sleep_after_idle_minutes}m, quiet ${Math.round(NUDGE_QUIET_MS / 1000)}s)`);
  let quietSince = null;
  for (;;) {
    if (loadInhibitor().active) return true;
    const eff = effectiveEnabled();
    if (!eff.enabled) { log('watchdog: disabled during linger, exiting'); return false; }
    if (!(eff.global.sleep_after_idle_minutes > 0)) return false;
    if (herdrSocketGone()) { log('watchdog: herdr socket gone during linger, exiting'); return false; }
    if (Date.now() >= until) { log('watchdog: linger expired, exiting'); return false; }
    const idleState = logindIdleState();
    if (!idleState.idle) { log('watchdog: session active again, ending linger'); return false; }
    const working = loadWorking().size;
    if (working > 0) {
      quietSince = null;
    } else {
      if (quietSince == null) { quietSince = Date.now(); log('watchdog: idle with no working pane, qualifying for a nudge'); }
      const r = suspendNudge({
        idleState,
        inhibitorHeldOs: osBlockHeld(),
        workingCount: working,
        minIdleMs: eff.global.sleep_after_idle_minutes * 60000,
        minQuietMs: NUDGE_QUIET_MS,
        quietMs: Date.now() - quietSince,
        dryRun: !!process.env.HERDR_STAY_AWAKE_NUDGE_DRYRUN,
      });
      log(`watchdog: nudge ${r.ran ? (r.ok ? 'sent' : 'refused') : r.dryRun ? 'dry-run' : 'skip'} — ${r.reason}`);
      // Only a *successful* request ends the linger. A refusal means something else
      // still blocks (another inhibitor, lid, polkit); staying here lets the next
      // tick succeed once it clears, instead of leaving the desktop disarmed again.
      if (r.ran && r.ok) return false;
    }
    await new Promise((r) => setTimeout(r, NUDGE_INTERVAL_MS));
  }
}

// Detached, single-instance watchdog entrypoint (`node index.js __watchdog`).
// Re-syncs from `herdr agent list` so a missed event cannot pin the block until
// the 12h hold cap, then lingers to re-arm a suspend the desktop already gave up
// on. The watchdog exits as soon as the inhibitor is no longer active and there is
// nothing left to re-arm.
async function watchdogLoop() {
  const me = process.pid;
  writeWatchdogPid(me);
  log(`watchdog: loop start pid ${me} interval ${WATCHDOG_INTERVAL_MS}ms maxHold ${maxHoldSeconds()}s`);
  try {
    for (;;) {
      const why = await holdPhase();
      log(`watchdog: hold phase ended (${why})`);
      if (!await lingerPhase()) break;
      log('watchdog: inhibitor re-acquired during linger, resuming hold');
      await new Promise((r) => setTimeout(r, WATCHDOG_INTERVAL_MS));
    }
  } finally {
    try { const cur = readWatchdogPid(); if (cur === me || cur == null) fs.unlinkSync(WATCHDOG_PID_FILE); } catch {}
    log('watchdog: loop end');
  }
}

module.exports = { loadWorking, saveWorking, loadInhibitor, reconcile, releaseInhibitor, watchdogLoop };