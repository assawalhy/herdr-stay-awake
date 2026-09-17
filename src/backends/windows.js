const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { STATE_DIR, MARKER } = require('../constants');
const { log, readJson, detectPlatform } = require('../util');
const { maxHoldSeconds } = require('../config');

function powershellScript(maxHoldMs, hbPath) {
  return [
    '$ErrorActionPreference = "Stop"',
    '$sig = @"',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint esFlags);',
    '"@',
    `# ${MARKER}`,
    '$addTypeError = $null',
    'try { Add-Type -MemberDefinition $sig -Name Power -Namespace Herdr | Out-Null } catch { $addTypeError = $_.Exception.Message }',
    '$ES_CONTINUOUS = [uint32]"0x80000000"',
    '$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"',
    '$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED',
    `$hbPath = '${hbPath.replace(/'/g, "''")}'`,
    `$maxHoldMs = ${maxHoldMs}`,
    '$firstAt = $null',
    'while ($true) {',
    '  $ret = $null',
    '  $err = $addTypeError',
    '  if (-not $addTypeError) {',
    '    $ret = [Herdr.Power]::SetThreadExecutionState($flags)',
    '    if ($ret -eq 0) { $e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error(); if ($e -ne 0) { $err = "Win32 error " + $e } }',
    '  }',
    '  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '  if (-not $firstAt) { $firstAt = $now }',
    '  try { (@{ pid = $PID; assertedAt = $now; firstAt = $firstAt; lastRetval = $ret; lastError = $err } | ConvertTo-Json -Compress) | Out-File -Encoding utf8 -FilePath $hbPath } catch {}',
    '  if ($now - $firstAt -gt $maxHoldMs) { break }',
    '  Start-Sleep -Seconds 30',
    '}',
    'try { Remove-Item $hbPath -ErrorAction SilentlyContinue } catch {}',
  ].join('\n');
}
function wslScriptPaths() {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'echo $env:TEMP'], { encoding: 'utf8', timeout: 3000 });
    const winTemp = (r.stdout || '').trim().replace(/\r/g, '');
    if (winTemp) {
      const wsl = spawnSync('wslpath', ['-u', winTemp], { encoding: 'utf8', timeout: 2000 });
      const wslTemp = (wsl.stdout || '').trim() || winTemp.replace(/^C:/, '/mnt/c').replace(/\\/g, '/');
      return { win: winTemp, wsl: wslTemp };
    }
  } catch {}
  return { win: 'C:\\Users\\A\\AppData\\Local\\Temp', wsl: '/mnt/c/Users/A/AppData/Local/Temp' };
}
function waitForHeartbeat(hbPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hb = readJson(hbPath, null);
    if (hb && hb.assertedAt && !hb.lastError) return true;
    if (hb && hb.lastError) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return false;
}
function markerProcessCount() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-File*${MARKER}*' } | Measure-Object | Select-Object -ExpandProperty Count`], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return -1;
  const n = Number.parseInt((r.stdout || '').trim(), 10);
  return Number.isNaN(n) ? -1 : n;
}
function windowsKillMarkers() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-File*${MARKER}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore', timeout: 8000 });
  if (result.error) log(`windowsKillMarkers error: ${result.error.message}`);
}
function acquireStartLock() {
  const lockPath = path.join(STATE_DIR, 'windows-start.lock');
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try { return fs.openSync(lockPath, 'wx'); } catch {}
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs > 60000) {
      try { fs.rmSync(lockPath, { force: true }); } catch {}
      return fs.openSync(lockPath, 'wx');
    }
  } catch {}
  return null;
}
function releaseStartLock(lock) {
  try { fs.closeSync(lock); } catch {}
  try { fs.rmSync(path.join(STATE_DIR, 'windows-start.lock'), { force: true }); } catch {}
}
function windowsLikeStart() {
  const plat = detectPlatform();
  const maxHoldMs = maxHoldSeconds() * 1000;
  let scriptPathWin, scriptPathWsl, hbPathWin, hbPathNode;
  if (plat === 'wsl') {
    const p = wslScriptPaths();
    scriptPathWin = `${p.win}\\stay-awake-${MARKER}.ps1`;
    scriptPathWsl = `${p.wsl}/stay-awake-${MARKER}.ps1`;
    hbPathWin = `${p.win}\\stay-awake-${MARKER}-heartbeat.json`;
    hbPathNode = `${p.wsl}/stay-awake-${MARKER}-heartbeat.json`;
    try { fs.mkdirSync(p.wsl, { recursive: true }); } catch {}
    try { fs.writeFileSync(scriptPathWsl, powershellScript(maxHoldMs, hbPathWin)); } catch (e) { log(`wsl write failed ${e.message}`); }
  } else {
    scriptPathWin = path.join(STATE_DIR, `stay-awake-${MARKER}.ps1`);
    hbPathNode = path.join(STATE_DIR, `stay-awake-${MARKER}-heartbeat.json`);
    try { fs.writeFileSync(scriptPathWin, powershellScript(maxHoldMs, hbPathNode)); } catch (e) { log(`native write failed ${e.message}`); }
  }
  const lock = acquireStartLock();
  if (!lock) {
    log('windows start lock busy, assuming another keeper is starting');
    return { kind: 'marker', backend: 'powershell', scriptPath: scriptPathWin, heartbeatPath: hbPathNode, startVerified: waitForHeartbeat(hbPathNode, 8000) };
  }
  try {
    windowsKillMarkers();
    try { fs.rmSync(hbPathNode, { force: true }); } catch {}
    let stderrFd;
    try { stderrFd = fs.openSync(path.join(STATE_DIR, 'stay-awake-keeper.log'), 'a'); } catch {}
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPathWin], { detached: true, stdio: ['ignore', 'ignore', stderrFd || 'ignore'] });
    child.unref();
    const startVerified = waitForHeartbeat(hbPathNode, 8000);
    if (!startVerified) log('keeper started but heartbeat not seen within 8s');
    return { kind: 'marker', backend: 'powershell', scriptPath: scriptPathWin, heartbeatPath: hbPathNode, startVerified };
  } finally {
    releaseStartLock(lock);
  }
}
function windowsLikeStop() {
  windowsKillMarkers();
  try {
    const plat = detectPlatform();
    if (plat === 'wsl') {
      const p = wslScriptPaths();
      try { fs.unlinkSync(`${p.wsl}/stay-awake-${MARKER}.ps1`); } catch {}
      try { fs.unlinkSync(`${p.wsl}/stay-awake-${MARKER}-heartbeat.json`); } catch {}
    } else {
      try { fs.unlinkSync(path.join(STATE_DIR, `stay-awake-${MARKER}.ps1`)); } catch {}
      try { fs.unlinkSync(path.join(STATE_DIR, `stay-awake-${MARKER}-heartbeat.json`)); } catch {}
    }
  } catch {}
}
function windowsApiProbe() {
  const cmd = [
    "$sig = '[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern uint SetThreadExecutionState(uint esFlags);'",
    'Add-Type -MemberDefinition $sig -Name Power -Namespace HerdrProbe | Out-Null',
    '$ES_CONTINUOUS = [uint32]"0x80000000"',
    '$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"',
    '$d = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED',
    '$r1 = [HerdrProbe.Power]::SetThreadExecutionState($d)',
    '$r2 = [HerdrProbe.Power]::SetThreadExecutionState($ES_CONTINUOUS)',
    '"set=$r1 prev=$r2"',
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return { pass: false, detail: `probe exited ${r.status}: ${r.stderr}` };
  const m = r.stdout.match(/set=(\d+) prev=(\d+)/);
  if (!m) return { pass: false, detail: `unexpected output: ${r.stdout.trim()}` };
  const prev = Number(m[2]);
  const pass = prev === 2147483649;
  return { pass, detail: `set=${m[1]} prev=${m[2]} (${pass ? 'ES_SYSTEM_REQUIRED held' : 'no ES request'})` };
}
function probeWindowsKeeper() {
  const plat = detectPlatform();
  let winTemp, nodeTemp;
  if (plat === 'wsl') {
    const p = wslScriptPaths();
    winTemp = p.win; nodeTemp = p.wsl;
  } else {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'echo $env:TEMP'], { encoding: 'utf8', timeout: 3000 });
    winTemp = (r.stdout || '').trim().replace(/\r/g, '');
    nodeTemp = winTemp;
  }
  if (!winTemp) return { pass: false, detail: 'no TEMP' };
  const name = `stay-awake-${MARKER}-probe`;
  const sep = plat === 'wsl' ? '/' : '\\';
  const scriptWin = `${winTemp}\\${name}.ps1`;
  const hbWin = `${winTemp}\\${name}-heartbeat.json`;
  const hbNode = `${nodeTemp}${sep}${name}-heartbeat.json`;
  try { fs.writeFileSync(`${nodeTemp}${sep}${name}.ps1`, powershellScript(60000, hbWin)); } catch (e) { return { pass: false, detail: `write failed ${e.message}` }; }
  try { fs.rmSync(hbNode, { force: true }); } catch {}
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptWin], { detached: true, stdio: 'ignore' });
  child.unref();
  const seen = waitForHeartbeat(hbNode, 8000);
  const hb = readJson(hbNode, null);
  const pass = seen && hb && !hb.lastError;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${name}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore', timeout: 8000 });
  try { fs.rmSync(`${nodeTemp}${sep}${name}.ps1`, { force: true }); fs.rmSync(hbNode, { force: true }); } catch {}
  return { pass, detail: pass ? `keeper heartbeat retval ${hb.lastRetval} (ES held)` : `heartbeat ${seen ? 'broken' : 'missing'}${hb && hb.lastError ? ' err=' + hb.lastError : ''}` };
}
function windowsBatteryInfo() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 8000 });
  if (r.status !== 0 || !r.stdout.trim()) return { present: false };
  try {
    const j = JSON.parse(r.stdout.trim());
    const b = Array.isArray(j) ? j[0] : j;
    const status = Number(b.BatteryStatus);
    return { present: true, charge: b.EstimatedChargeRemaining, status: status === 1 ? 'discharging' : status === 2 ? 'on AC' : `code ${status}` };
  } catch { return { present: true }; }
}

module.exports = { powershellScript, wslScriptPaths, waitForHeartbeat, markerProcessCount, windowsKillMarkers, acquireStartLock, releaseStartLock, windowsLikeStart, windowsLikeStop, windowsApiProbe, probeWindowsKeeper, windowsBatteryInfo };