const { syncFromAgentList, handleEvent } = require('./herdr');
const { reconcile } = require('./state');
const { actionStatus, actionDoctor } = require('./status');
const { actionEnable, actionDisable, actionToggle, actionOpenSettings } = require('./actions');
const { settingsPane } = require('./settings');
const { selftest, selftestInner } = require('./selftest');

function main() {
  const entry = process.env.HERDR_PLUGIN_ENTRYPOINT_ID;
  const action = process.env.HERDR_PLUGIN_ACTION_ID;
  const argv = process.argv.slice(2);

  if (argv.includes('__grace_retry')) { reconcile(); return; }
  if (argv.includes('selftest')) return selftest();
  if (argv.includes('__selftest')) return selftestInner();
  if (entry === 'settings' || argv.includes('settings')) return settingsPane();

  if (action) {
    const id = action.includes('.') ? action.split('.').pop() : action;
    const probe = argv.includes('--probe');
    if (id === 'status') return actionStatus();
    if (id === 'doctor') return actionDoctor({ probe });
    if (id === 'enable') return actionEnable();
    if (id === 'disable') return actionDisable();
    if (id === 'toggle') return actionToggle();
    if (id === 'open-settings' || id === 'open_settings' || id === 'settings') return actionOpenSettings();
    const a = argv[0];
    if (a === 'status') return actionStatus();
    if (a === 'doctor') return actionDoctor({ probe });
    if (a === 'enable') return actionEnable();
    if (a === 'disable') return actionDisable();
    if (a === 'toggle') return actionToggle();
    if (a === 'open-settings' || a === 'open_settings' || a === 'settings') return actionOpenSettings();
    console.log(`unknown action ${action} argv ${argv}`);
    return;
  }

  if (argv[0] && ['status', 'doctor', 'enable', 'disable', 'toggle', 'settings', 'open-settings', 'open_settings'].includes(argv[0])) {
    if (argv[0] === 'status') return actionStatus();
    if (argv[0] === 'doctor') return actionDoctor({ probe: argv.includes('--probe') });
    if (argv[0] === 'enable') return actionEnable();
    if (argv[0] === 'disable') return actionDisable();
    if (argv[0] === 'toggle') return actionToggle();
    if (argv[0] === 'settings' || argv[0] === 'open-settings' || argv[0] === 'open_settings') return actionOpenSettings();
  }

  const event = process.env.HERDR_PLUGIN_EVENT;
  if (event === 'startup') syncFromAgentList();
  else if (event) handleEvent();
  else if (!process.env.HERDR_PLUGIN_STATE_DIR && !process.env.HERDR_PLUGIN_CONFIG_DIR) {
    console.log('Stay Awake — run via herdr plugin actions or events. Commands: status, doctor --probe, enable, disable, toggle, open-settings, settings, selftest');
    return;
  }
  reconcile();
}

module.exports = { main };