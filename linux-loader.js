#!/usr/bin/env node
/**
 * linux-loader.js - Claude Linux compatibility layer v3.0
 *
 * Loads the macOS-only Claude Desktop app on Linux by patching:
 *   0. TMPDIR + fs.rename (EXDEV cross-device rename)
 *   1. Platform/arch spoofing (darwin/arm64)
 *   2. Module interception (@ant/claude-swift, swift_addon.node)
 *   3. Electron API polyfills (systemPreferences, BrowserWindow, Menu)
 *   4. IPC handler pre-registration (Cowork, AutoUpdater, ClaudeVM, etc.)
 *   5. User-Agent + Anthropic request header injection
 *
 * NOTE: BrowserWindow.titleBarStyle cannot be patched at runtime because
 * Electron's module object has read-only properties. Instead, enable-cowork.py
 * strips titleBarStyle:"hidden" directly from the bundle at install time.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;
const RESOURCES_DIR = __dirname;
const STUB_PATH = path.join(RESOURCES_DIR, 'stubs', '@ant', 'claude-swift', 'js', 'index.js');

// ============================================================
// 0. TMPDIR FIX - MUST BE ABSOLUTELY FIRST
// ============================================================
const vmBundleDir = path.join(os.homedir(), '.config/Claude/vm_bundles');
const vmTmpDir = path.join(vmBundleDir, 'tmp');
const claudeVmBundle = path.join(vmBundleDir, 'claudevm.bundle');

try {
  fs.mkdirSync(vmTmpDir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = vmTmpDir;
  process.env.TMP = vmTmpDir;
  process.env.TEMP = vmTmpDir;
  os.tmpdir = () => vmTmpDir;

  // Pre-create VM bundle markers to skip download (we run native, no VM)
  fs.mkdirSync(claudeVmBundle, { recursive: true, mode: 0o755 });
  const markers = ['bundle_complete', 'rootfs.img', 'rootfs.img.zst', 'vmlinux', 'config.json'];
  for (const m of markers) {
    const p = path.join(claudeVmBundle, m);
    if (!fs.existsSync(p)) {
      const content = m === 'config.json'
        ? '{"version":"linux-native","skip_vm":true}'
        : 'linux-native-placeholder';
      fs.writeFileSync(p, content, { mode: 0o644 });
    }
  }
  fs.writeFileSync(path.join(claudeVmBundle, 'version'), '999.0.0-linux-native', { mode: 0o644 });
  console.log('[TMPDIR] Fixed:', vmTmpDir);
} catch (e) {
  console.error('[TMPDIR] Setup failed:', e.message);
}

// ============================================================
// 0b. PATCH fs.rename TO HANDLE EXDEV ERRORS
// ============================================================
const originalRename = fs.rename;
const originalRenameSync = fs.renameSync;

fs.rename = function(oldPath, newPath, callback) {
  originalRename(oldPath, newPath, (err) => {
    if (err && err.code === 'EXDEV') {
      const readStream = fs.createReadStream(oldPath);
      const writeStream = fs.createWriteStream(newPath);
      readStream.on('error', callback);
      writeStream.on('error', callback);
      writeStream.on('close', () => {
        fs.unlink(oldPath, () => callback(null));
      });
      readStream.pipe(writeStream);
    } else {
      callback(err);
    }
  });
};

fs.renameSync = function(oldPath, newPath) {
  try {
    return originalRenameSync(oldPath, newPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(oldPath, newPath);
      fs.unlinkSync(oldPath);
      return;
    }
    throw err;
  }
};

// ============================================================
// 1. PLATFORM/ARCH/VERSION SPOOFING
// ============================================================
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

// ============================================================
// 2. MODULE INTERCEPTION
// ============================================================
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

// ============================================================
// 3. ELECTRON PATCHING
// ============================================================
const electron = require('electron');
const { app, session, ipcMain } = electron;

// --- systemPreferences polyfills ---
const origSysPrefs = electron.systemPreferences || {};
const patchedSysPrefs = {
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: async () => true,
  getEffectiveAppearance: () => 'light',
  getAppearance: () => 'light',
  setAppearance: () => {},
  getAccentColor: () => '007AFF',
  getColor: () => '#007AFF',
  getUserDefault: () => null,
  setUserDefault: () => {},
  removeUserDefault: () => {},
  subscribeNotification: () => 0,
  unsubscribeNotification: () => {},
  subscribeWorkspaceNotification: () => 0,
  unsubscribeWorkspaceNotification: () => {},
  postNotification: () => {},
  postLocalNotification: () => {},
  isTrustedAccessibilityClient: () => true,
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  isAeroGlassEnabled: () => false,
  isHighContrastColorScheme: () => false,
  isReducedMotion: () => false,
  isInvertedColorScheme: () => false,
};
for (const [key, val] of Object.entries(patchedSysPrefs)) {
  origSysPrefs[key] = val;
}

// --- BrowserWindow prototype polyfills (macOS-only methods) ---
const OrigBrowserWindow = electron.BrowserWindow;
const macOSWindowMethods = {
  setWindowButtonPosition: () => {},
  getWindowButtonPosition: () => ({ x: 0, y: 0 }),
  setTrafficLightPosition: () => {},
  getTrafficLightPosition: () => ({ x: 0, y: 0 }),
  setWindowButtonVisibility: () => {},
  setVibrancy: () => {},
  setBackgroundMaterial: () => {},
  setRepresentedFilename: () => {},
  getRepresentedFilename: () => '',
  setDocumentEdited: () => {},
  isDocumentEdited: () => false,
  setTouchBar: () => {},
  setSheetOffset: () => {},
  setAutoHideCursor: () => {},
};
for (const [method, impl] of Object.entries(macOSWindowMethods)) {
  if (typeof OrigBrowserWindow.prototype[method] !== 'function') {
    OrigBrowserWindow.prototype[method] = impl;
  }
}

// --- Menu patching ---
const OrigMenu = electron.Menu;
const origSetApplicationMenu = OrigMenu.setApplicationMenu;
OrigMenu.setApplicationMenu = function(menu) {
  try {
    if (origSetApplicationMenu) return origSetApplicationMenu.call(OrigMenu, menu);
  } catch (e) {
    // Ignore macOS-specific menu errors on Linux
  }
};

const origBuildFromTemplate = OrigMenu.buildFromTemplate;
OrigMenu.buildFromTemplate = function(template) {
  const filtered = (template || []).map(item => {
    const f = { ...item };
    if (f.role === 'services' || f.role === 'recentDocuments') return null;
    if (f.submenu && Array.isArray(f.submenu)) {
      f.submenu = f.submenu.filter(sub =>
        sub && sub.role !== 'services' && sub.role !== 'recentDocuments'
      );
    }
    return f;
  }).filter(Boolean);
  return origBuildFromTemplate.call(OrigMenu, filtered);
};

patchedElectron = electron;
console.log('[Electron] Patched: systemPreferences, BrowserWindow.prototype, Menu');

// ============================================================
// 3.5. USER-AGENT SPOOFING
// ============================================================
if (app.userAgentFallback) {
  app.userAgentFallback = app.userAgentFallback
    .replace(/\(X11; Linux [^)]+\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
    .replace(/Linux/, 'Mac OS X');
}

app.whenReady().then(() => {
  try {
    const s = session.defaultSession;
    if (s) {
      s.setUserAgent(
        s.getUserAgent()
          .replace(/\(X11; Linux [^)]+\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
          .replace(/Linux/, 'Mac OS X')
      );
    }
  } catch (e) {
    console.error('[UserAgent] Failed:', e.message);
  }
});

// ============================================================
// 4. IPC WRAPPERS (logging + error suppression)
// ============================================================

// Prevent MaxListenersExceededWarning from AutoUpdater store subscriptions
ipcMain.setMaxListeners(50);

function shortChannelName(ch) {
  return ch.replace(/\$eipc_message\$_[0-9a-f-]+_\$_/, '').replace(/claude\.(web|hybrid|settings)_\$_/, '');
}

function describeResult(r) {
  if (r === undefined) return 'undefined';
  if (r === null) return 'null';
  if (Array.isArray(r)) return `Array(${r.length})`;
  if (typeof r === 'object') return `{${Object.keys(r).slice(0, 5).join(',')}}`;
  return `${typeof r}:${String(r).slice(0, 50)}`;
}

// --- ipcMain.handle wrapper ---
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function(channel, handler) {
  const wrapped = async (event, ...args) => {
    const name = shortChannelName(channel);
    try {
      const result = await handler(event, ...args);
      // Suppress noisy AutoUpdater logging
      if (!name.includes('AutoUpdater')) {
        console.log(`[IPC] ${name} => ${describeResult(result)}`);
      }
      return result;
    } catch (e) {
      console.error(`[IPC] ${name} => ERROR: ${e.message}`);
      throw e;
    }
  };
  try {
    return origHandle(channel, wrapped);
  } catch (e) {
    if (e.message && e.message.includes('already registered')) return;
    throw e;
  }
};

// --- ipcMain.on wrapper (sync IPC) ---
const origOn = ipcMain.on.bind(ipcMain);
ipcMain.on = function(channel, handler) {
  const wrapped = (event, ...args) => {
    const name = shortChannelName(channel);
    try {
      handler(event, ...args);
      // Fix #1: If bundle's getInitialLocale handler fails origin validation,
      // event.returnValue is left undefined. Provide a fallback.
      if (name.includes('getInitialLocale') && event.returnValue === undefined) {
        const locale = process.env.LANG?.split('.')[0]?.replace('_', '-') || 'en-US';
        event.returnValue = { result: { locale, messages: {} }, error: null };
      }
    } catch (e) {
      console.error(`[IPC SYNC] ${name} => ERROR: ${e.message}`);
    }
  };
  return origOn(channel, wrapped);
};

// ============================================================
// 5. IPC HANDLERS FOR COWORK/YUKONSILVER
// ============================================================

// Auto-detect EIPC UUID from the app bundle
let EIPC_UUID = 'c42e5915-d1f8-48a1-a373-fe793971fdbd';
try {
  const bundleIndex = path.join(__dirname, 'app', '.vite', 'build', 'index.js');
  const bundleHead = fs.readFileSync(bundleIndex, 'utf8').slice(0, 100000);
  const m = bundleHead.match(/\$eipc_message\$_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (m) {
    EIPC_UUID = m[1];
    console.log('[EIPC] UUID:', EIPC_UUID);
  }
} catch (e) {
  console.warn('[EIPC] Bundle read failed, using fallback UUID');
}

const EIPC_NAMESPACES = ['claude.web', 'claude.hybrid', 'claude.settings'];
const registeredHandlers = new Set();

function registerEipcHandler(handlerName, handler, isSync = false) {
  for (const ns of EIPC_NAMESPACES) {
    const channel = `$eipc_message$_${EIPC_UUID}_$_${ns}_$_${handlerName}`;
    if (registeredHandlers.has(channel)) continue;
    try {
      if (isSync) {
        ipcMain.on(channel, (event, ...args) => {
          try { event.returnValue = handler(event, ...args); }
          catch (e) { event.returnValue = { result: null, error: e.message }; }
        });
      } else {
        ipcMain.handle(channel, handler);
      }
      registeredHandlers.add(channel);
    } catch (e) {
      if (!e.message.includes('already registered')) {
        console.error(`[IPC] Failed to register ${handlerName}:`, e.message);
      }
    }
  }
}

// ----- AppFeatures -----
registerEipcHandler('AppFeatures_$_getSupportedFeatures', async () => ({
  localAgentMode: true, cowork: true, claudeCode: true, extensions: true,
  mcp: true, globalShortcuts: true, menuBar: true, startupOnLogin: true,
  autoUpdate: true, filePickers: true,
}));
registerEipcHandler('AppFeatures_$_getCoworkFeatureState', async () => ({
  enabled: true, status: 'supported', reason: null,
}));
registerEipcHandler('AppFeatures_$_getYukonSilverStatus', async () => ({ status: 'supported' }));
registerEipcHandler('AppFeatures_$_getFeatureFlags', async () => ({
  yukonSilver: true, cowork: true, localAgentMode: true,
}));

// ----- ClaudeVM -----
registerEipcHandler('ClaudeVM_$_download', async () => ({ status: 'ready', downloaded: true, progress: 100 }));
registerEipcHandler('ClaudeVM_$_getDownloadStatus', async () => ({
  status: 'ready', downloaded: true, progress: 100, version: 'linux-native-1.0.0',
}));
registerEipcHandler('ClaudeVM_$_getRunningStatus', async () => ({ running: true, connected: true, status: 'connected' }));
registerEipcHandler('ClaudeVM_$_start', async () => ({ started: true, status: 'running' }));
registerEipcHandler('ClaudeVM_$_stop', async () => ({ stopped: true }));
registerEipcHandler('ClaudeVM_$_getSupportStatus', async () => ({ status: 'supported' }));
registerEipcHandler('ClaudeVM_$_setYukonSilverConfig', async (_event, config) => {
  console.log('[YukonSilver] Config:', JSON.stringify(config).slice(0, 200));
  return { success: true };
});

// ----- LocalAgentMode / Cowork sessions -----
registerEipcHandler('LocalAgentModeSessions_$_getAll', async () => []);
registerEipcHandler('LocalAgentModeSessions_$_create', async (_event, data) => ({
  id: `session-${Date.now()}`, ...data,
}));
registerEipcHandler('LocalAgentModeSessions_$_get', async (_event, id) => ({ id, status: 'active' }));

// ----- AutoUpdater -----
registerEipcHandler('AutoUpdater_$_updaterState_$store$_getState', async () => ({
  updateAvailable: false, updateDownloaded: false, checking: false,
  error: null, version: null, progress: null,
}));
registerEipcHandler('AutoUpdater_$_updaterState_$store$_update', async () => ({ success: true }));

// ----- DesktopIntl (SYNC) -----
registerEipcHandler('DesktopIntl_$_getInitialLocale', () => {
  const locale = process.env.LANG?.split('.')[0]?.replace('_', '-') || 'en-US';
  return { result: { locale, messages: {} }, error: null };
}, true);
registerEipcHandler('DesktopIntl_$_requestLocaleChange', async () => ({ success: true }));

// ----- WindowControl -----
registerEipcHandler('WindowControl_$_setThemeMode', async () => ({ success: true }));
registerEipcHandler('WindowControl_$_setIncognitoMode', async () => ({ success: true }));
registerEipcHandler('WindowControl_$_getFullscreen', async () => false);

// ----- Misc -----
registerEipcHandler('LocalPlugins_$_getPlugins', async () => []);
registerEipcHandler('Account_$_setAccountDetails', async () => ({ success: true }));
registerEipcHandler('QuickEntry_$_setRecentChats', async () => ({ success: true }));

// NOTE: list-mcp-servers and connect-to-mcp-server are NOT pre-registered here.
// The bundle and frame-fix-wrapper.js register their own handlers. Pre-registering
// causes "Attempted to register a second handler" UnhandledPromiseRejection.

console.log('[IPC] Cowork handlers registered');

// ============================================================
// 6. ERROR HANDLING
// ============================================================
process.on('uncaughtException', (error) => {
  const msg = error.message || '';
  if (msg.includes('is not a function') ||
      msg.includes('No handler registered') ||
      msg.includes('second handler')) {
    console.error('[Error] Suppressed:', msg);
    return;
  }
  throw error;
});

process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason || '');
  if (msg.includes('second handler') || msg.includes('already registered')) {
    console.error('[Error] Suppressed rejection:', msg);
    return;
  }
  console.error('[Error] Unhandled rejection:', msg);
});

// ============================================================
// 7. ANTHROPIC DESKTOP HEADERS
// ============================================================
// The bundle's Eyt() sets these via onBeforeSendHeaders, but Electron only
// allows ONE listener. Our whenReady().then() runs after the bundle's sync
// registration and overrides it. Set the headers ourselves.

app.whenReady().then(() => {
  try {
    const appVersion = app.getVersion();
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders;
      try {
        const url = new URL(details.url);
        if (url.host === 'claude.ai' || url.host.endsWith('.claude.ai')) {
          headers['anthropic-client-platform'] = 'desktop_app';
          headers['anthropic-client-app'] = 'com.anthropic.claudefordesktop';
          headers['anthropic-client-version'] = appVersion;
          headers['anthropic-client-os-platform'] = 'darwin';
          headers['anthropic-client-os-version'] = '14.0';
          headers['anthropic-desktop-topbar'] = '1';
        }
      } catch (e) { /* URL parse error — pass through */ }
      callback({ requestHeaders: headers });
    });
    console.log('[Headers] Anthropic desktop headers configured');
  } catch (e) {
    console.error('[Headers] Failed:', e.message);
  }
});

// ============================================================
// 8. LOAD APPLICATION
// ============================================================
console.log('='.repeat(60));
console.log('Claude Linux Loader v3.0');
console.log('='.repeat(60));

require('./linux-app-extracted/frame-fix-entry.js');
