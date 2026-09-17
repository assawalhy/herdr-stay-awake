const { maxHoldSeconds } = require('../config');
const { startPidBacked, stopPidBacked } = require('../util');

function macosStart() {
  return startPidBacked('caffeinate', ['-d', '-i', '-s', '-t', String(maxHoldSeconds())]);
}
function macosStop(handle) { return stopPidBacked(handle); }

module.exports = { macosStart, macosStop };