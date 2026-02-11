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
// 3.5. APP VERSION FIX + USER-AGENT SPOOFING
// ============================================================
// Electron reads version from package.json relative to the main script.
// Since linux-loader.js is in Resources/ (not Resources/app/), Electron
// can't find app/package.json and returns "0.0". The bundle captures
// app.getVersion() at init time for Anthropic-Client-Version headers.
let correctVersion = '0.14.10';
try {
  const appPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'app', 'package.json'), 'utf8'));
  correctVersion = appPkg.version || '0.14.10';
  app.getVersion = () => correctVersion;
  console.log('[Version] Fixed:', correctVersion, '| app.name:', app.getName());
} catch (e) {
  console.warn('[Version] Failed to read app version, using fallback');
  app.getVersion = () => correctVersion;
}

// User-Agent must contain "Claude/<version>" so the bundle's Spe() can replace
// it with "ClaudeNest/<version>". The web code from claude.ai checks for
// "ClaudeNest" in UA to determine desktop mode (vs web_claude_ai).
if (app.userAgentFallback) {
  app.userAgentFallback = app.userAgentFallback
    .replace(/\(X11; Linux [^)]+\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
    .replace(/Linux/, 'Mac OS X');
  if (!app.userAgentFallback.includes('Claude/')) {
    app.userAgentFallback = app.userAgentFallback.replace(
      /Electron\/(\S+)/,
      `Claude/${correctVersion} Electron/$1`
    );
  }
  console.log('[UA] userAgentFallback:', app.userAgentFallback);
}

app.whenReady().then(() => {
  try {
    const s = session.defaultSession;
    if (s) {
      let ua = s.getUserAgent()
        .replace(/\(X11; Linux [^)]+\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
        .replace(/Linux/, 'Mac OS X');
      if (!ua.includes('Claude/')) {
        ua = ua.replace(/Electron\/(\S+)/, `Claude/${correctVersion} Electron/$1`);
      }
      s.setUserAgent(ua);
      console.log('[UA] session UA:', ua.slice(0, 120));
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

// --- ipcMain.removeHandler wrapper ---
// Prevent the bundle from removing our pre-registered Cowork handlers.
// The bundle's EIPC init calls removeHandler before re-registering, but
// for getSupportedFeatures it only removes without re-registering, leaving
// no handler at all.
const origRemoveHandler = ipcMain.removeHandler.bind(ipcMain);
const removeHandlerWrapper = function(channel) {
  const name = shortChannelName(channel);
  console.log(`[IPC] removeHandler called: ${name}`);
  // Protect Cowork handlers that the bundle doesn't re-register.
  // NOTE: getSupportedFeatures is NOT blocked - the bundle removes then re-registers
  // its own handler with origin validation + Zod schema. The patched Fy/Yfe/Qfe
  // functions (via enable-cowork.py) ensure it returns {status:"supported"}.
  if (name.includes('ClaudeVM') ||
      name.includes('getCoworkFeatureState') || name.includes('getYukonSilverStatus') ||
      name.includes('getFeatureFlags') || name.includes('LocalAgentModeSessions')) {
    console.log(`[IPC] BLOCKED removeHandler: ${name}`);
    return;
  }
  return origRemoveHandler(channel);
};
ipcMain.removeHandler = removeHandlerWrapper;
// Also patch prototype to catch calls via Object.getPrototypeOf(ipcMain)
try {
  const proto = Object.getPrototypeOf(ipcMain);
  if (proto && typeof proto.removeHandler === 'function') {
    proto.removeHandler = removeHandlerWrapper;
  }
} catch (e) { /* prototype patch failed, wrapper on instance should suffice */ }

// --- ipcMain.handle wrapper ---
const origHandle = ipcMain.handle.bind(ipcMain);
const handleWrapper = function(channel, handler) {
  const name = shortChannelName(channel);
  if (name.includes('AppFeatures') || name.includes('ClaudeVM') || name.includes('LocalAgent')) {
    console.log(`[IPC] handle() registering: ${name}`);
  }
  const wrapped = async (event, ...args) => {
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
    if (e.message && e.message.includes('already registered')) {
      console.log(`[IPC] handle() SKIPPED (already registered): ${name}`);
      return;
    }
    throw e;
  }
};
ipcMain.handle = handleWrapper;
try {
  const proto = Object.getPrototypeOf(ipcMain);
  if (proto && typeof proto.handle === 'function') {
    proto.handle = handleWrapper;
  }
} catch (e) { /* prototype patch failed */ }

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

// Auto-detect EIPC UUID and getSupportedFeatures schema from the app bundle
let EIPC_UUID = 'c42e5915-d1f8-48a1-a373-fe793971fdbd';
let SUPPORTED_FEATURES_FIELDS = ['nativeQuickEntry', 'quickEntryDictation'];
try {
  const bundleIndex = path.join(__dirname, 'app', '.vite', 'build', 'index.js');
  const bundleContent = fs.readFileSync(bundleIndex, 'utf8');

  // Extract EIPC UUID (appears early in the bundle)
  const uuidMatch = bundleContent.match(/\$eipc_message\$_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (uuidMatch) {
    EIPC_UUID = uuidMatch[1];
    console.log('[EIPC] UUID:', EIPC_UUID);
  }

  // Extract getSupportedFeatures field names from the Zod schema.
  // Chain: function fJ(t){return rJ.safeParse(t).success}
  //     → ,rJ=Te({nativeQuickEntry:R4,quickEntryDictation:R4})
  // Step 1: Find the validator function for getSupportedFeatures
  const validatorMatch = bundleContent.match(/!(\w{2,3})\(i\)\)throw new Error\('Result from method "getSupportedFeatures"/);
  if (validatorMatch) {
    const validatorFn = validatorMatch[1]; // e.g. "fJ"
    // Step 2: Find which schema var the validator uses
    const schemaMatch = bundleContent.match(new RegExp(
      `function ${validatorFn}\\(t\\)\\{return (\\w+)\\.safeParse`
    ));
    if (schemaMatch) {
      const schemaVar = schemaMatch[1]; // e.g. "rJ"
      // Step 3: Find the Zod schema definition: rJ=Te({field1:type,field2:type})
      const defMatch = bundleContent.match(new RegExp(
        `[,;]${schemaVar}=\\w+\\(\\{([\\w:,]+)\\}\\)`
      ));
      if (defMatch) {
        const fields = defMatch[1].match(/(\w+):/g);
        if (fields?.length > 0) {
          SUPPORTED_FEATURES_FIELDS = fields.map(f => f.replace(':', ''));
        }
      }
    }
  }
  console.log('[EIPC] Feature fields:', SUPPORTED_FEATURES_FIELDS.join(', '));
} catch (e) {
  console.warn('[EIPC] Bundle read failed, using fallback UUID/fields');
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
registerEipcHandler('AppFeatures_$_getSupportedFeatures', async () => {
  const result = {};
  for (const field of SUPPORTED_FEATURES_FIELDS) {
    result[field] = { status: 'supported' };
  }
  return result;
});
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
// 7. ANTHROPIC DESKTOP HEADERS + DIAGNOSTICS
// ============================================================
// The bundle registers its own onBeforeSendHeaders (Spe function) which
// already sends correct Anthropic headers (our platform spoofing makes
// process.platform return 'darwin'). We intercept the method so we can:
//   a) Add any extra headers the bundle doesn't send
//   b) Log API request headers for diagnostics

app.whenReady().then(() => {
  try {
    const webReq = session.defaultSession.webRequest;
    const origOnBefore = webReq.onBeforeSendHeaders.bind(webReq);
    let headerLogCount = 0;

    webReq.onBeforeSendHeaders = function(...args) {
      // onBeforeSendHeaders(filter, listener) or onBeforeSendHeaders(listener)
      const listener = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (!listener) return origOnBefore(...args);

      const wrappedListener = (details, callback) => {
        listener(details, (result) => {
          const headers = result?.requestHeaders || details.requestHeaders;
          try {
            const url = new URL(details.url);
            if (url.host === 'claude.ai' || url.host.endsWith('.claude.ai')) {
              // Fix: Remove lowercase anthropic-* headers set by the web code.
              // The web code (from claude.ai) sets its own lowercase headers like
              // "anthropic-client-platform: web_claude_ai". The bundle's Spe() adds
              // capitalized headers like "Anthropic-Client-Platform: desktop_app".
              // HTTP headers are case-insensitive, so both reach the server, causing
              // the server to see "web_claude_ai" and serve web-mode configuration.
              // We remove the web code's lowercase headers so only the bundle's
              // desktop_app headers are sent.
              for (const key of Object.keys(headers)) {
                if (key.startsWith('anthropic-') && key === key.toLowerCase()) {
                  delete headers[key];
                }
              }

              // Log first 5 API requests for diagnostics
              if (url.pathname.startsWith('/api/') && headerLogCount < 5) {
                headerLogCount++;
                const anthHeaders = Object.entries(headers)
                  .filter(([k]) => k.toLowerCase().startsWith('anthropic'))
                  .map(([k, v]) => `${k}: ${v}`);
                const ua = headers['User-Agent'] || headers['user-agent'] || '';
                const uaShort = ua.includes('ClaudeNest') ? 'ClaudeNest/' + (ua.match(/ClaudeNest\/(\S+)/)?.[1] || '?')
                  : ua.includes('Claude/') ? 'Claude/' + (ua.match(/Claude\/(\S+)/)?.[1] || '?')
                  : 'no-Claude-in-UA';
                console.log(`[Headers] ${url.pathname} => ${anthHeaders.join(', ')} | UA: ${uaShort}`);
              }
            }
          } catch (e) { /* URL parse error */ }
          callback({ requestHeaders: headers });
        });
      };

      args[args.length - 1] = wrappedListener;
      return origOnBefore(...args);
    };
    console.log('[Headers] Header interception configured');
  } catch (e) {
    console.error('[Headers] Failed:', e.message);
  }
});

// Diagnostic: Capture renderer console output + probe desktop APIs
app.whenReady().then(() => {
  app.on('web-contents-created', (_event, contents) => {
    const cType = contents.getType();
    console.log(`[DIAG] web-contents-created: type=${cType}`);

    // Wrap webContents.ipc.handle to intercept scoped handler registrations.
    // The bundle registers handlers via webContents.ipc.handle() (not ipcMain.handle()),
    // which bypasses our ipcMain wrappers. This intercepts those registrations.
    if (contents.ipc && typeof contents.ipc.handle === 'function') {
      const origWcHandle = contents.ipc.handle.bind(contents.ipc);
      contents.ipc.handle = function(channel, handler) {
        const name = shortChannelName(channel);
        if (name.includes('AppFeatures') || name.includes('ClaudeVM') || name.includes('LocalAgent')) {
          console.log(`[IPC:WC] scoped handle() registering: ${name}`);
        }
        // Wrap getSupportedFeatures to log response/errors
        if (name.includes('getSupportedFeatures')) {
          const wrapped = async (event, ...args) => {
            try {
              const result = await handler(event, ...args);
              console.log(`[IPC:WC] ${name} => ${describeResult(result)}`);
              return result;
            } catch (e) {
              console.error(`[IPC:WC] ${name} => ERROR: ${e.message}`);
              throw e;
            }
          };
          return origWcHandle(channel, wrapped);
        }
        return origWcHandle(channel, handler);
      };
      const origWcRemove = contents.ipc.removeHandler.bind(contents.ipc);
      contents.ipc.removeHandler = function(channel) {
        const name = shortChannelName(channel);
        if (name.includes('AppFeatures')) {
          console.log(`[IPC:WC] scoped removeHandler: ${name}`);
        }
        return origWcRemove(channel);
      };
    }

    // Capture ALL renderer console output to main process stdout
    contents.on('console-message', (_e, level, message, line, sourceId) => {
      const src = sourceId ? sourceId.split('/').pop() : '';
      if (message.includes('BRIDGE') || message.includes('DESKTOP_API') ||
          message.includes('YukonSilver') || message.includes('API_DIAG') ||
          message.includes('Cowork') || message.includes('cowork') ||
          message.includes('INTERCEPT') || message.includes('[BIND]') ||
          message.includes('CHUNK_ANALYSIS') || message.includes('[BOOT]')) {
        console.log(`[RENDERER:${level}] ${message} (${src}:${line})`);
      }
    });

    contents.on('dom-ready', () => {
      const url = contents.getURL();
      console.log(`[DIAG] dom-ready: type=${cType} url=${url.slice(0, 80)}`);
      if (url.includes('claude.ai')) {
        // Open DevTools for debugging (remove after investigation)
        if (process.argv.includes('--devtools')) {
          try { contents.openDevTools({ mode: 'detach' }); } catch(e) {}
        }
        // Inject desktopBootFeatures BEFORE web code reads it
        contents.executeJavaScript(`
          window.desktopBootFeatures = {
            nativeQuickEntry: true,
            quickEntryDictation: true,
            cowork: true,
            yukonSilver: true,
            localAgentMode: true,
            extensions: true,
            mcp: true
          };
          console.log('[BOOT] Injected desktopBootFeatures');
        `).catch(() => {});
        contents.executeJavaScript(`
          (() => {
            const L = console.log.bind(console);
            // Log exposed APIs
            const namespaces = ['claude.settings', 'claude.web', 'claude.hybrid'];
            for (const ns of namespaces) {
              const obj = window[ns];
              if (obj) {
                const keys = Object.keys(obj);
                L('[API_DIAG] ' + ns + ': ' + keys.join(', '));
                for (const k of keys) {
                  if (typeof obj[k] === 'object' && obj[k]) {
                    L('[API_DIAG]   ' + ns + '.' + k + ': ' + Object.keys(obj[k]).join(', '));
                  }
                }
              }
            }
            // Probe: Call getSupportedFeatures to verify IPC response
            try {
              const af = window['claude.settings']?.AppFeatures;
              if (af && typeof af.getSupportedFeatures === 'function') {
                L('[API_DIAG] Calling AppFeatures.getSupportedFeatures()...');
                af.getSupportedFeatures()
                  .then(v => L('[API_DIAG] getSupportedFeatures resolved: ' + JSON.stringify(v)))
                  .catch(e => L('[API_DIAG] getSupportedFeatures rejected: ' + e));
              } else {
                L('[API_DIAG] AppFeatures.getSupportedFeatures NOT available');
              }
            } catch(e) { L('[API_DIAG] probe error: ' + e); }
            // Also check ClaudeVM availability
            try {
              const cv = window['claude.settings']?.ClaudeVM;
              if (cv && typeof cv.getSupportStatus === 'function') {
                cv.getSupportStatus()
                  .then(v => L('[API_DIAG] ClaudeVM.getSupportStatus resolved: ' + JSON.stringify(v)))
                  .catch(e => L('[API_DIAG] ClaudeVM.getSupportStatus rejected: ' + e));
              } else {
                L('[API_DIAG] ClaudeVM.getSupportStatus NOT available');
              }
            } catch(e) { L('[API_DIAG] probe error: ' + e); }
            // Check for other desktop binding mechanisms
            const checks = [
              'claudeAppBindings', 'electronAPI', '__CLAUDE_DESKTOP__',
              'desktopAPI', 'nativeAPI', '__electron__'
            ];
            for (const name of checks) {
              if (window[name]) {
                L('[API_DIAG] Found window.' + name + ': ' +
                  typeof window[name] + ' keys=' +
                  (typeof window[name] === 'object' ? Object.keys(window[name]).join(',') : 'N/A'));
              }
            }
            // Dump window.process to understand what web code sees
            L('[BOOT] window.process: ' + JSON.stringify({
              platform: window.process?.platform,
              arch: window.process?.arch,
              isInternalBuild: window.process?.isInternalBuild,
              isPackaged: window.process?.isPackaged,
              keys: window.process ? Object.keys(window.process).join(',') : 'N/A'
            }));
            // Check desktopBootFeatures and other runtime state
            setTimeout(() => {
              const dbf = window.desktopBootFeatures;
              L('[BOOT] desktopBootFeatures: ' + (dbf ? JSON.stringify(dbf).slice(0, 500) : 'NOT FOUND'));
              // Check all window properties that might be desktop-related
              const desktopProps = Object.keys(window).filter(k =>
                k.includes('desktop') || k.includes('Desktop') || k.includes('claude') ||
                k.includes('Claude') || k.includes('electron') || k.includes('Electron') ||
                k.includes('yukon') || k.includes('Yukon') || k.includes('cowork') || k.includes('Cowork')
              );
              L('[BOOT] Desktop-related window props: ' + desktopProps.join(', '));
            }, 3000);
          })();
        `).catch(e => console.log('[DIAG] executeJS error:', e.message));
      }
    });
  });
});

// ============================================================
// 8. LOAD APPLICATION
// ============================================================
console.log('='.repeat(60));
console.log('Claude Linux Loader v3.0');
console.log('='.repeat(60));

require('./linux-app-extracted/frame-fix-entry.js');
