/**
 * Module interception
 *
 * Overrides Module._load to intercept:
 *   - swift_addon.node → SwiftAddonStub
 *   - electron → patched electron (after setPatchedElectron is called)
 */

'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');

const RESOURCES_DIR = path.join(__dirname, '..');
const STUB_PATH = path.join(RESOURCES_DIR, 'stubs', '@ant', 'claude-swift', 'js', 'index.js');

const originalLoad = Module._load;
let swiftStubCache = null;
let loadingStub = false;
let patchedElectron = null;

function loadSwiftStub() {
  if (swiftStubCache) return swiftStubCache;
  if (!fs.existsSync(STUB_PATH)) throw new Error(`Swift stub not found: ${STUB_PATH}`);
  loadingStub = true;
  try {
    delete require.cache[STUB_PATH];
    swiftStubCache = originalLoad.call(Module, STUB_PATH, module, false);
    console.log('[Module] Swift stub loaded');
  } finally {
    loadingStub = false;
  }
  return swiftStubCache;
}

Module._load = function(request, _parent, _isMain) {
  if (loadingStub) return originalLoad.apply(this, arguments);
  if (request.includes('swift_addon') && request.endsWith('.node')) {
    return loadSwiftStub();
  }
  if (request === 'electron' && patchedElectron) {
    return patchedElectron;
  }
  return originalLoad.apply(this, arguments);
};

function setPatchedElectron(electron) {
  patchedElectron = electron;
}

module.exports = { setPatchedElectron };
