const { CONFIG_FILE, SESSION_FILE } = require('./constants');
const { readJson, writeJsonAtomic, socketHash } = require('./util');

function defaultConfig() {
  return { enabled: true, grace_enabled: true, start_grace_seconds: 5, stop_grace_seconds: 30, max_hold_seconds: 43200 };
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