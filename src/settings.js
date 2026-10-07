const { INHIBIT_FILE } = require('./constants');
const { detectPlatform, socketHash, writeJsonAtomic } = require('./util');
const { loadGlobalConfig, saveGlobalConfig, loadSessionMap, saveSessionMap } = require('./config');
const { reconcile, loadInhibitor } = require('./state');
const { stopInhibitor } = require('./inhibitor');
const { healthCheck, actionDoctor } = require('./status');

// Next value in a preset list; unknown values restart at the first entry.
function cycle(list, cur) { return list[(list.indexOf(cur) + 1) % list.length]; }

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
    console.log(`Idle: ${!s.idle ? '(not probed — no block held)' : s.idle.available === false ? '(logind unavailable)' : s.idle.idle ? `${Math.round(s.idle.idleForMs / 60000)}m — desktop will not retry its refused sleep` : 'no (session active)'}`);
    console.log(`Sleep nudge: ${s.sleep.afterIdleMinutes > 0 ? `suspend ${s.sleep.afterIdleMinutes}m after release (linger ${s.sleep.lingerMinutes}m)` : 'off'}   Sleep while working: ${s.sleep.whileWorkingMinutes > 0 ? `${s.sleep.whileWorkingMinutes}m idle` : 'off'}`);
    if (h.issues.length) { console.log(`\nIssues:`); h.issues.forEach(i => console.log(`  - ${i}`)); } else console.log(`\nHealth: ${h.healthy ? 'OK' : 'see issues'}`);
    console.log(`\nKeys: [g] toggle global  [s] toggle session  [t] toggle grace  [n] nudge margin  [w] sleep-while-working  [d] doctor  [r] refresh  [q] quit`);
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
    if (key.name === 'n') { const c = loadGlobalConfig(); c.sleep_after_idle_minutes = cycle([0, 15, 30, 60, 120], c.sleep_after_idle_minutes); saveGlobalConfig(c); render(); }
    if (key.name === 'w') { const c = loadGlobalConfig(); c.sleep_while_working_minutes = cycle([0, 20, 45, 90], c.sleep_while_working_minutes); saveGlobalConfig(c); render(); }
    if (key.name === 'd') { console.clear(); actionDoctor({ probe: false }); console.log('\npress r to return'); }
  });
}

module.exports = { settingsPane };