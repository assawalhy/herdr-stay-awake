const path = require('node:path');

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || '.';
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || STATE_DIR;
const WORKING_FILE = path.join(STATE_DIR, 'working-panes.json');
const INHIBIT_FILE = path.join(STATE_DIR, 'inhibitor.json');
const LOG_FILE = path.join(STATE_DIR, 'stay-awake.log');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSION_FILE = path.join(STATE_DIR, 'session.json');
const LAST_PAYLOAD_FILE = path.join(STATE_DIR, 'last-payload.json');
const MARKER = 'herdr-stay-awake-inhibitor-marker';

module.exports = { STATE_DIR, CONFIG_DIR, WORKING_FILE, INHIBIT_FILE, LOG_FILE, CONFIG_FILE, SESSION_FILE, LAST_PAYLOAD_FILE, MARKER };