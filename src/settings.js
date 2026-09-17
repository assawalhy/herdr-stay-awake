const { INHIBIT_FILE } = require('./constants');
const { detectPlatform, socketHash, writeJsonAtomic } = require('./util');
const { loadGlobalConfig, saveGlobalConfig, loadSessionMap, saveSessionMap } = require('./config');
const { reconcile, loadInhibitor } = require('./state');
const { stopInhibitor } = require('./inhibitor');
const { healthCheck, actionDoctor } = require('./status');

function settingsPane() {
  const readline = require('node:readline');
  function render() {
    console.clear();
    const h = healthCheck();
    const s = h.status;
    console.log('Stay Awake — Settings (q quit, r refresh, g toggle global, s toggle session, d doctor, t toggle grace)\n');
    console.log(`Platform: ${s.platform}  Backend: ${s.backend}`);
    console.log(`Working: ${s.workingCount}  Inhibitor: ${s.inhibitor.active ? 'ACTIVE' : 'inactive'}  OS: ${s.osVerified.osActive ? 'awake' : 'not awake'}`);
    console.log(`  ${s.osVerified.detail}`);
    console.log(`\nEnabled: effective=${s.enabled ? 'YES' : 'NO'}  global=${s.globalEnabled ? 'on' : 'off'}  session(${s.sessionHash})=${s.sessionEnabled ? 'on' : 'off'}`);
    console.log(`Grace: ${s.grace.enabled ? `on ${s.grace.startGrace}s/${s.grace.stopGrace}s` : 'off'}`);
    if (h.issues.length) { console.log(`\nIssues:`); h.issues.forEach(i => console.log(`  - ${i}`)); } else console.log(`\nHealth: ${h.healthy ? 'OK' : 'see issues'}`);
    console.log(`\nKeys: [g] toggle global  [s] toggle session  [t] toggle grace  [d] doctor  [r] refresh  [q] quit`);
  }
  render();
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) { process.exit(0); }
    if (key.name === 'r') { render(); }
    if (key.name === 'g') { const c = loadGlobalConfig(); c.enabled = !c.enabled; saveGlobalConfig(c); if (!c.enabled) { const inh = loadInhibitor(); if (inh.active) { stopInhibitor(inh.platform || detectPlatform(), inh.handle); writeJsonAtomic(INHIBIT_FILE, { active: false, handle: null, platform: detectPlatform(), backend: null, firstActiveTime: null, lastInactiveTime: null }); } } else reconcile(); render(); }
    if (key.name === 's') { const m = loadSessionMap(); const h = socketHash(); const cur = m[h] ? !!m[h].enabled : true; m[h] = { enabled: !cur, updatedAt: new Date().toISOString() }; saveSessionMap(m); if (!m[h].enabled) { const inh = loadInhibitor(); if (inh.active) { stopInhibitor(inh.platform || detectPlatform(), inh.handle); writeJsonAtomic(INHIBIT_FILE, { active: false, handle: null, platform: detectPlatform(), backend: null, firstActiveTime: null, lastInactiveTime: null }); } } else reconcile(); render(); }
    if (key.name === 't') { const c = loadGlobalConfig(); c.grace_enabled = !c.grace_enabled; saveGlobalConfig(c); render(); }
    if (key.name === 'd') { console.clear(); actionDoctor({ probe: false }); console.log('\npress r to return'); }
  });
}

module.exports = { settingsPane };