const { spawnSync } = require('node:child_process');

const { LAST_PAYLOAD_FILE } = require('./constants');
const { log, writeJsonAtomic } = require('./util');
const { loadWorking, saveWorking } = require('./state');

function runHerdr(args) {
  const bin = process.env.HERDR_BIN_PATH || 'herdr';
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000 });
  if (r.error) { log(`herdr ${args.join(' ')} failed: ${r.error.message}`); return null; }
  if (r.status !== 0) { log(`herdr ${args.join(' ')} exited ${r.status}: ${r.stderr}`); return null; }
  try { return JSON.parse(r.stdout); } catch { log(`herdr ${args.join(' ')} non-JSON: ${r.stdout}`); return null; }
}
function extractAgents(data) {
  if (!data) return [];
  if (Array.isArray(data.result)) return data.result;
  if (data.result && Array.isArray(data.result.agents)) return data.result.agents;
  if (Array.isArray(data.agents)) return data.agents;
  if (Array.isArray(data)) return data;
  return [];
}
function syncFromAgentList() {
  const data = runHerdr(['agent', 'list']);
  const working = new Set();
  for (const a of extractAgents(data)) {
    const status = a.status || a.agent_status;
    const paneId = a.pane_id || a.pane || a.paneId;
    if (status === 'working' && paneId) working.add(paneId);
  }
  saveWorking(working);
  log(`startup sync: ${working.size} pane(s) working`);
}
function extractPaneAndStatus(payload) {
  const d = payload.data || payload;
  const paneId = d.pane_id || d.pane || d.paneId || payload.pane_id || payload.pane || payload.paneId;
  const status = d.agent_status || d.status || payload.agent_status || payload.status;
  return { paneId, status };
}
function handleEvent() {
  let payload = {};
  try { payload = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || '{}'); } catch { log(`bad HERDR_PLUGIN_EVENT_JSON`); }
  try { writeJsonAtomic(LAST_PAYLOAD_FILE, payload); } catch {}
  const { paneId, status } = extractPaneAndStatus(payload);
  if (!paneId) { log(`event no pane id: ${JSON.stringify(payload)}`); return; }
  const working = loadWorking();
  if (status === 'working') working.add(paneId); else working.delete(paneId);
  saveWorking(working);
}

module.exports = { runHerdr, extractAgents, syncFromAgentList, extractPaneAndStatus, handleEvent };