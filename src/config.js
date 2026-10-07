const { CONFIG_FILE, SESSION_FILE } = require('./constants');
const { readJson, writeJsonAtomic, socketHash } = require('./util');

function defaultConfig() {
  // sleep_after_idle_minutes: after the block is released, re-issue the OS sleep
  // request once the session has been idle this long (0 = never). Keep it above
  // GNOME's own sleep-inactive-*-timeout (20 min AC / 15 min battery here) so we
  // never race the desktop's own timer.
  // nudge_linger_minutes: how long the watchdog stays alive after release to do it.
  // sleep_while_working_minutes: opt-in — release the block even though panes are
  // working once the session has been idle this long (0 = off, current behaviour).
  return {
    enabled: true,
    grace_enabled: true,
    start_grace_seconds: 5,
    stop_grace_seconds: 30,
    max_hold_seconds: 43200,
    sleep_after_idle_minutes: 30,
    nudge_linger_minutes: 90,
    sleep_while_working_minutes: 0,
  };
}
function minutes(v, dflt, min) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : dflt;
}
function loadGlobalConfig() {
  const c = readJson(CONFIG_FILE, null);
  if (!c || typeof c.enabled !== 'boolean') return defaultConfig();
  return {
    enabled: c.enabled,
    grace_enabled: !!c.grace_enabled,
    start_grace_seconds: Number(c.start_grace_seconds) || 5,
    stop_grace_seconds: Number(c.stop_grace_seconds) || 30,
    max_hold_seconds: Number(c.max_hold_seconds) || 43200,
    sleep_after_idle_minutes: minutes(c.sleep_after_idle_minutes, 30, 0),
    nudge_linger_minutes: minutes(c.nudge_linger_minutes, 90, 1),
    sleep_while_working_minutes: minutes(c.sleep_while_working_minutes, 0, 0),
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
function maxHoldSeconds() {
  const m = Number(loadGlobalConfig().max_hold_seconds);
  return Number.isFinite(m) && m >= 60 ? m : 43200;
}

module.exports = { defaultConfig, loadGlobalConfig, saveGlobalConfig, loadSessionMap, saveSessionMap, effectiveEnabled, setGlobalEnabled, setSessionEnabled, maxHoldSeconds };