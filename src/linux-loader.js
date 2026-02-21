#!/usr/bin/env node
/**
 * linux-loader.js - Claude Linux compatibility layer v4.0
 *
 * Orchestrator: loads the macOS-only Claude Desktop app on Linux.
 * Each concern is implemented in a separate module under lib/.
 */

// Redirect TMPDIR to same filesystem, patch fs.rename for EXDEV
require('./lib/tmpdir-fix');

// Spoof process.platform/arch for app code (stack-based)
require('./lib/platform-spoof');

// Intercept Module._load for swift_addon.node and electron
const { setPatchedElectron } = require('./lib/module-intercept');

// Polyfill macOS-only Electron APIs (systemPreferences, BrowserWindow, Menu)
const electron = require('./lib/electron-patch');
setPatchedElectron(electron);

const { app, session, ipcMain } = electron;

// Fix app version and spoof User-Agent for desktop mode detection
require('./lib/version-ua')({ app, session });

// Ensure claude_desktop_config.json includes cowork feature flags
require('./lib/config-patch')({ app });

// Wrap ipcMain to log calls, protect Cowork handlers, suppress errors
const { shortChannelName, describeResult } = require('./lib/ipc-wrappers')({ ipcMain });

// Pre-register EIPC handlers (AppFeatures, ClaudeVM, AutoUpdater, etc.)
require('./lib/eipc-handlers')({ ipcMain });

// Suppress known non-fatal errors from macOS code paths
require('./lib/error-suppress');

// Remove web code's lowercase anthropic-* headers, log API requests
require('./lib/header-intercept')({ app, session });

// Inject desktopBootFeatures, capture renderer console, probe APIs
require('./lib/diagnostics')({ app, shortChannelName, describeResult });

console.log('='.repeat(60));
console.log('Claude Linux Loader v4.0');
console.log('='.repeat(60));

require('./linux-app-extracted/frame-fix-entry.js');
