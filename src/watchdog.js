// Linux liveness watchdog.
//
// Release of the Linux `systemd-inhibit` block used to depend solely on herdr
// events. Herdr is silent during long turns (see .agents/plans/02), so a stale
// `working-panes.json` could hold the `sleep:idle` block for up to
// `max_hold_seconds` (12h) — keeping the laptop awake with nothing running.
//
// While the inhibitor is active we spawn a detached, single-instance watchdog
// that re-reads `herdr agent list` on an interval, reconciles, and releases as
// soon as no pane is working. It exits on its own once the inhibitor is gone,
// so it inherits the same process-bound lifetime as the inhibitor.
//
// This module must NOT require ./state (state requires this), to avoid a
// circular dependency.

const fs = require('node:fs');

const { WATCHDOG_PID_FILE } = require('./constants');
const { log, isAlive, startPidBacked, writeJsonAtomic } = require('./util');

// `Number(x) || dflt` would turn an explicit 0 into the default — these knobs are
// documented as "0 disables", so read them nullish.
function envNumber(raw, dflt, min) {
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

// Poll interval. Kept below the default stop-grace (30s) so a release is not
// unnecessarily delayed by a whole extra tick. Overridable for tests.
const WATCHDOG_INTERVAL_MS = Math.max(1000, Number(process.env.HERDR_STAY_AWAKE_WATCHDOG_MS) || 30000);
// Linger-phase poll: after the block is released we only re-check whether the OS
// *wants* to sleep, which cannot change faster than a minute.
const NUDGE_INTERVAL_MS = Math.max(5000, Number(process.env.HERDR_STAY_AWAKE_NUDGE_MS) || 60000);
// How long the session must be continuously idle with no working pane before we
// re-issue the sleep request. Guards against firing in the gap between two tool
// calls of a live turn. 0 disables the quiet requirement.
const NUDGE_QUIET_MS = envNumber(process.env.HERDR_STAY_AWAKE_NUDGE_QUIET_MS, 120000, 0);

function readWatchdogPid() {
  try {
    const j = JSON.parse(fs.readFileSync(WATCHDOG_PID_FILE, 'utf8'));
    const p = Number(j && j.pid);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

function writeWatchdogPid(pid) {
  writeJsonAtomic(WATCHDOG_PID_FILE, { pid, startedAt: Date.now() });
}

function ensureWatchdog() {
  const pid = readWatchdogPid();
  // A live pidfile means a watchdog already exists — including when this very
  // process *is* the watchdog (its reconcile would otherwise spawn a second).
  if (pid && isAlive(pid)) return false;
  if (pid) { try { fs.unlinkSync(WATCHDOG_PID_FILE); } catch {} } // clear stale pidfile
  const h = startPidBacked(process.execPath, [require.main.filename, '__watchdog']);
  if (h && h.pid) {
    writeWatchdogPid(h.pid);
    log(`watchdog started pid ${h.pid} (interval ${WATCHDOG_INTERVAL_MS}ms)`);
    return true;
  }
  log('watchdog start failed');
  return false;
}

function stopWatchdog() {
  const pid = readWatchdogPid();
  if (pid && pid !== process.pid && isAlive(pid)) {
    try { process.kill(-pid, 'SIGTERM'); } catch {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }
  // The watchdog owns its own pidfile until its loop ends: unlinking it here while
  // we *are* the watchdog would let a concurrent reconcile spawn a second one.
  if (pid === process.pid) return;
  try { fs.unlinkSync(WATCHDOG_PID_FILE); } catch {}
}

module.exports = { ensureWatchdog, stopWatchdog, readWatchdogPid, writeWatchdogPid, WATCHDOG_INTERVAL_MS, NUDGE_INTERVAL_MS, NUDGE_QUIET_MS };
