/**
 * Linux stub for @ant/claude-native
 *
 * Replaces the macOS Mach-O native module with JS equivalents.
 * IPC handlers are registered separately in linux-loader.js.
 */

const EventEmitter = require('events');
const path = require('path');
const os = require('os');
const fs = require('fs');

const LOG_PREFIX = '[claude-native-stub]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function trace(category, msg, data = null) {
  const entry = {
    ts: new Date().toISOString(),
    cat: category,
    msg,
    data
  };
  // Write to trace file if CLAUDE_NATIVE_TRACE is set
  if (process.env.CLAUDE_NATIVE_TRACE) {
    const logDir = process.env.CLAUDE_LOG_DIR ||
      path.join(os.homedir(), '.local/share/claude-cowork/logs');
    try {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        path.join(logDir, 'claude-native-trace.log'),
        JSON.stringify(entry) + '\n',
        { mode: 0o600 }
      );
    } catch (e) {}
  }
}

// ============================================================
// Keyboard constants (used by the app)
// ============================================================

const KeyboardKeys = {
  ESCAPE: 27,
  ENTER: 13,
  TAB: 9,
  BACKSPACE: 8,
  DELETE: 46,
  ARROW_UP: 38,
  ARROW_DOWN: 40,
  ARROW_LEFT: 37,
  ARROW_RIGHT: 39,
};

// ============================================================
// Auth request stub - falls back to system browser
// ============================================================

class AuthRequest extends EventEmitter {
  constructor() {
    super();
  }

  start(url, callbackUrl) {
    // Open URL in system browser
    // SECURITY: Use execFile to prevent command injection
    const { execFile } = require('child_process');
    execFile('xdg-open', [url], (err) => {
      if (err) console.error('[claude-native] Failed to open browser:', err.message);
    });

    // The app should handle the OAuth callback via deep link or manual paste
    setTimeout(() => {
      this.emit('error', new Error('Authentication via system browser - paste the callback URL when complete'));
    }, 100);
  }

  cancel() {
    this.emit('cancelled');
  }

  static isAvailable() {
    return false; // Force system browser auth
  }
}

// ============================================================
// Native binding stub
// The real module loads a .node file - we provide JS equivalents
// ============================================================

const nativeStub = {
  // Platform detection
  platform: 'darwin',   // Spoofed for Cowork support
  arch: 'arm64',        // Spoofed for Cowork support

  // System integration stubs
  getSystemTheme: () => 'dark',
  setDockBadge: (text) => { trace('NATIVE', 'setDockBadge', { text }); },
  showNotification: (title, body) => {
    trace('NATIVE', 'showNotification', { title, body });
    // Could use notify-send or node-notifier here
  },

  // File system integration
  revealInFinder: (filePath) => {
    trace('NATIVE', 'revealInFinder', { path: filePath });
    // xdg-open on Linux
    const { spawn } = require('child_process');
    spawn('xdg-open', [path.dirname(filePath)], { detached: true, stdio: 'ignore' });
  },

  // Accessibility
  isAccessibilityEnabled: () => true,
  requestAccessibilityPermission: () => Promise.resolve(true),

  // Screen capture
  hasScreenCapturePermission: () => true,
  requestScreenCapturePermission: () => Promise.resolve(true),
};

// ============================================================
// Window management stubs
// ============================================================

function focus_window(handle) {
  // Could implement with xdotool or wmctrl
  log('focus_window not implemented on Linux');
  return false;
}

function get_active_window_handle() {
  // Could implement with xdotool
  return null;
}

// ============================================================
// Preferences stubs (Linux uses different config systems)
// ============================================================

function read_plist_value(domain, key) {
  return null;
}

function read_cf_pref_value(domain, key) {
  return null;
}

function read_registry_values(request) {
  return null;
}

function write_registry_value(request) {
  return false;
}

function get_app_info_for_file(filePath) {
  // Could implement with xdg-mime
  return null;
}

log('claude-native stub loaded successfully');

module.exports = {
  // Keyboard constants
  KeyboardKeys,

  // Auth
  AuthRequest,

  // Window management (snake_case and camelCase)
  focus_window,
  focusWindow: focus_window,
  get_active_window_handle,
  getActiveWindowHandle: get_active_window_handle,

  // Preferences (snake_case and camelCase)
  read_plist_value,
  readPlistValue: read_plist_value,
  read_cf_pref_value,
  readCfPrefValue: read_cf_pref_value,
  read_registry_values,
  readRegistryValues: read_registry_values,
  write_registry_value,
  writeRegistryValue: write_registry_value,
  get_app_info_for_file,
  getAppInfoForFile: get_app_info_for_file,

  // Native stub functions
  ...nativeStub,
};

module.exports.default = module.exports;
