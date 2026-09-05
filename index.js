#!/usr/bin/env node
'use strict';

/**
 * herdr stay-awake plugin
 * ------------------------
 * Keeps track of which panes currently have a "working" agent, and
 * holds a platform-appropriate sleep inhibitor open for as long as
 * that set is non-empty.
 *
 * Entry point is invoked two ways (see herdr-plugin.toml):
 *   - [[startup]]: HERDR_PLUGIN_EVENT="startup" -> we resync from
 *     `herdr agent list` in case agents were already working when the
 *     server (re)started.
 *   - [[events]] on "pane.agent_status_changed": HERDR_PLUGIN_EVENT is
 *     the event name, HERDR_PLUGIN_EVENT_JSON is the payload.
 *
 * NOTE ON FIELD NAMES: herdr's docs don't publish the literal JSON
 * shape of pane.agent_status_changed. This code guesses the obvious
 * names (pane_id / agent_status) and falls back to a couple of
 * alternates. First time you wire this up, check what actually
 * arrives with:
 *   herdr plugin log list --plugin mabdullah.stay-awake
 * and adjust extractPaneAndStatus() below if needed.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || '.';
const WORKING_FILE = path.join(STATE_DIR, 'working-panes.json');
const INHIBIT_FILE = path.join(STATE_DIR, 'inhibitor.json');
const LOG_FILE = path.join(STATE_DIR, 'stay-awake.log');

// Unique-ish marker so we can find/kill our own Windows-side helper
// process by command line instead of relying on PID bookkeeping across
// the WSL/Windows interop boundary (which is flaky in both directions).
const MARKER = 'herdr-stay-awake-inhibitor-marker';

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {
    /* best-effort logging only */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

// ---------------------------------------------------------------------
// Platform detection. WSL reports as "linux" at the OS level, so we
// sniff /proc/version / $WSL_DISTRO_NAME to tell it apart from a real
// Linux box, since the sleep mechanism is completely different: a WSL2
// guest has no real "system sleep" of its own, the Windows host does.
// ---------------------------------------------------------------------
function detectPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  try {
    const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    if (version.includes('microsoft')) return 'wsl';
  } catch (_) {
    /* not linux, or /proc unavailable */
  }
  if (process.env.WSL_DISTRO_NAME) return 'wsl';
  return 'linux';
}

// ---------------------------------------------------------------------
// Inhibitor backends
// ---------------------------------------------------------------------

// macOS / native Linux: spawn a detached helper whose mere existence
// holds the inhibitor, and kill its process group to release it.
function startPidBacked(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { kind: 'pid', pid: child.pid };
}

function stopPidBacked(handle) {
  if (!handle || handle.pid == null) return;
  try {
    process.kill(-handle.pid, 'SIGTERM'); // whole process group
  } catch (_) {
    try {
      process.kill(handle.pid, 'SIGTERM');
    } catch (_) {
      /* already gone */
    }
  }
}

function macosStart() {
  // -d: prevent display sleep, -i: prevent idle sleep, -s: prevent
  // system sleep (AC power). Drop -d if you don't care about the
  // screen turning off, just the machine suspending.
  return startPidBacked('caffeinate', ['-d', '-i', '-s']);
}

function linuxStart() {
  // Requires systemd. If your distro doesn't run systemd, swap this
  // for whatever your DE/power daemon exposes (e.g. a dbus call to
  // org.freedesktop.PowerManagement, or xdg-screensaver-style tooling).
  return startPidBacked('systemd-inhibit', [
    '--what=sleep:idle',
    '--who=herdr-stay-awake',
    '--why=herdr agent is working',
    '--mode=block',
    'sleep',
    'infinity',
  ]);
}

// Windows native, and WSL via Windows interop (powershell.exe is on
// PATH from inside WSL when interop is enabled, which is the default).
// This is the part that actually matters for the WSL case: inhibiting
// sleep *inside* the WSL2 guest does nothing, because the guest has no
// real power state of its own -- only the Windows host does.
function powershellScript() {
  return [
    '$sig = @"',
    '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);',
    '"@',
    'Add-Type -MemberDefinition $sig -Name Power -Namespace Herdr | Out-Null',
    `# ${MARKER}`,
    '# ES_CONTINUOUS | ES_SYSTEM_REQUIRED = 0x80000001.',
    '# OR in ES_DISPLAY_REQUIRED (0x00000002) if you also want the',
    '# display to stay on, i.e. use 0x80000003 instead.',
    '[Herdr.Power]::SetThreadExecutionState(0x80000001) | Out-Null',
    'while ($true) { Start-Sleep -Seconds 60 }',
  ].join('\n');
}

function windowsLikeStart() {
  const scriptPath = path.join(STATE_DIR, 'stay-awake.ps1');
  fs.writeFileSync(scriptPath, powershellScript());
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', scriptPath],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  // Deliberately not tracking child.pid: on WSL that pid is the Linux
  // side of the interop process, and killing it doesn't reliably reap
  // the Windows-side powershell.exe. We find it by marker instead.
  return { kind: 'marker' };
}

function windowsLikeStop() {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${MARKER}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ],
    { stdio: 'ignore' }
  );
  if (result.error) log(`windowsLikeStop error: ${result.error.message}`);
}

function startInhibitor(platform) {
  switch (platform) {
    case 'macos':
      return macosStart();
    case 'linux':
      return linuxStart();
    case 'windows':
    case 'wsl':
      return windowsLikeStart();
    default:
      log(`unknown platform "${platform}", not inhibiting sleep`);
      return null;
  }
}

function stopInhibitor(platform, handle) {
  switch (platform) {
    case 'macos':
    case 'linux':
      return stopPidBacked(handle);
    case 'windows':
    case 'wsl':
      return windowsLikeStop();
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------
// Working-pane set + reconciliation
// ---------------------------------------------------------------------

function loadWorking() {
  return new Set(readJson(WORKING_FILE, []));
}

function saveWorking(set) {
  writeJson(WORKING_FILE, [...set]);
}

function reconcile() {
  const platform = detectPlatform();
  const working = loadWorking();
  const inhibitor = readJson(INHIBIT_FILE, { active: false, handle: null });

  const shouldBeActive = working.size > 0;

  if (shouldBeActive && !inhibitor.active) {
    log(`starting inhibitor (platform=${platform}, working=${working.size})`);
    const handle = startInhibitor(platform);
    writeJson(INHIBIT_FILE, { active: true, handle, platform });
  } else if (!shouldBeActive && inhibitor.active) {
    log(`stopping inhibitor (platform=${platform})`);
    stopInhibitor(inhibitor.platform || platform, inhibitor.handle);
    writeJson(INHIBIT_FILE, { active: false, handle: null, platform });
  }
}

// ---------------------------------------------------------------------
// Talking to herdr itself
// ---------------------------------------------------------------------

function runHerdr(args) {
  const bin = process.env.HERDR_BIN_PATH || 'herdr';
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.error) {
    log(`herdr ${args.join(' ')} failed: ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    log(`herdr ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (_) {
    log(`herdr ${args.join(' ')} did not return JSON: ${result.stdout}`);
    return null;
  }
}

// Best-effort extraction across a couple of plausible shapes, since the
// exact schema isn't published -- see the NOTE at the top of the file.
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
  for (const agent of extractAgents(data)) {
    const status = agent.status || agent.agent_status;
    const paneId = agent.pane_id || agent.pane || agent.paneId;
    if (status === 'working' && paneId) working.add(paneId);
  }
  saveWorking(working);
  log(`startup sync: ${working.size} pane(s) working`);
}

function extractPaneAndStatus(payload) {
  const paneId = payload.pane_id || payload.pane || payload.paneId;
  const status = payload.agent_status || payload.status;
  return { paneId, status };
}

function handleEvent() {
  let payload = {};
  try {
    payload = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || '{}');
  } catch (_) {
    log(`could not parse HERDR_PLUGIN_EVENT_JSON: ${process.env.HERDR_PLUGIN_EVENT_JSON}`);
  }

  const { paneId, status } = extractPaneAndStatus(payload);
  if (!paneId) {
    log(`event with no resolvable pane id: ${JSON.stringify(payload)}`);
    return;
  }

  const working = loadWorking();
  if (status === 'working') {
    working.add(paneId);
  } else {
    working.delete(paneId);
  }
  saveWorking(working);
}

// ---------------------------------------------------------------------

function main() {
  const event = process.env.HERDR_PLUGIN_EVENT;
  if (event === 'startup') {
    syncFromAgentList();
  } else {
    handleEvent();
  }
  reconcile();
}

main();
