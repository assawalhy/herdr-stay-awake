const { log, detectPlatform } = require('./util');
const { macosStart, macosStop } = require('./backends/macos');
const { linuxInhibitStart, linuxInhibitStop } = require('./backends/linux');
const { windowsLikeStart, windowsLikeStop } = require('./backends/windows');

function startInhibitor(platform) {
  switch (platform) {
    case 'macos': return macosStart();
    case 'linux': return linuxInhibitStart();
    case 'windows':
    case 'wsl': return windowsLikeStart();
    default: log(`unknown platform "${platform}"`); return null;
  }
}
function stopInhibitor(platform, handle) {
  switch (platform) {
    case 'macos': return macosStop(handle);
    case 'linux': return linuxInhibitStop(handle);
    case 'windows':
    case 'wsl': return windowsLikeStop();
  }
}

module.exports = { startInhibitor, stopInhibitor };