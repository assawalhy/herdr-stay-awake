const { spawnSync } = require('node:child_process');

const { INHIBIT_FILE } = require('./constants');
const { log, detectPlatform, writeJsonAtomic } = require('./util');
const { setGlobalEnabled, setSessionEnabled, effectiveEnabled } = require('./config');
const { reconcile, loadInhibitor } = require('./state');
const { stopInhibitor } = require('./inhibitor');
const { actionStatus } = require('./status');
const { settingsPane } = require('./settings');

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
function actionOpenSettings() {
  const bin = process.env.HERDR_BIN_PATH || 'herdr';
  const r = spawnSync(bin, ['plugin', 'pane', 'open', '--plugin', 'assawalhy.stay-awake', '--entrypoint', 'settings'], { stdio: 'inherit', timeout: 5000 });
  if (r.error) {
    log(`open-settings failed: ${r.error.message}`);
    settingsPane();
  } else if (r.status !== 0) {
    log(`open-settings pane open failed ${r.status}`);
    settingsPane();
  }
}

module.exports = { parseArgsEnable, actionEnable, actionDisable, actionToggle, actionOpenSettings };