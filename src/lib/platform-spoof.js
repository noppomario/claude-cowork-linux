/**
 * Platform/arch spoofing
 *
 * Stack-based spoofing: app code sees darwin/arm64, while Node internals
 * and system code see the real platform. isSystemCall() inspects the call
 * stack to determine the caller context.
 */

'use strict';

const os = require('os');

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;

function isSystemCall(stack) {
  const caller = (stack.split('\n')[2] || '');
  return caller.includes('node:') ||
         caller.includes('electron/js2c') ||
         caller.includes('electron.asar') ||
         caller.includes('linux-loader.js') ||
         caller.includes('frame-fix-wrapper');
}

Object.defineProperty(process, 'platform', {
  get() {
    return isSystemCall(new Error().stack || '') ? REAL_PLATFORM : 'darwin';
  },
  configurable: true,
});

Object.defineProperty(process, 'arch', {
  get() {
    return isSystemCall(new Error().stack || '') ? REAL_ARCH : 'arm64';
  },
  configurable: true,
});

const originalOsPlatform = os.platform;
const originalOsArch = os.arch;
os.platform = function() {
  return isSystemCall(new Error().stack || '') ? originalOsPlatform.call(os) : 'darwin';
};
os.arch = function() {
  return isSystemCall(new Error().stack || '') ? originalOsArch.call(os) : 'arm64';
};
process.getSystemVersion = () => '14.0.0';

console.log('[Platform] Spoofing: darwin/arm64 macOS 14.0');

module.exports = { isSystemCall };
