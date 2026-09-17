const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { LOG_FILE } = require('./constants');

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function writeJsonAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) { log(`write ${file} failed: ${e.message}`); }
}
function hasCommand(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}
function isAlive(pid) {
  if (!pid) return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.includes(') Z') || stat.includes(') X')) return false;
  } catch {}
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function detectPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  try {
    const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    if (v.includes('microsoft')) return 'wsl';
  } catch {}
  if (process.env.WSL_DISTRO_NAME) return 'wsl';
  return 'linux';
}
function socketHash() {
  const s = process.env.HERDR_SOCKET_PATH || 'default';
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}
function startPidBacked(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { kind: 'pid', pid: child.pid, cmd, args };
}
function stopPidBacked(handle) {
  if (!handle || handle.pid == null) return;
  try { process.kill(-handle.pid, 'SIGTERM'); } catch {
    try { process.kill(handle.pid, 'SIGTERM'); } catch {}
  }
}

module.exports = { log, readJson, writeJsonAtomic, hasCommand, isAlive, detectPlatform, socketHash, startPidBacked, stopPidBacked };