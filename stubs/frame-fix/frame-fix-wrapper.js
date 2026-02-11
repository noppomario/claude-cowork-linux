// Frame fix and module interception for Linux
//
// Runs after linux-loader.js (which handles TMPDIR, fs.rename, platform
// spoofing, and EIPC handler registration). This file's sole responsibility
// is intercepting Module.prototype.require to:
//   1. Override @ant/claude-swift vm status methods
//   2. Subclass BrowserWindow for native frame + icon on Linux
//   3. Wrap Menu.setApplicationMenu to hide the menu bar on Linux

const Module = require('module');
const originalRequire = Module.prototype.require;
const path = require('path');
const fs = require('fs');

// linux-loader.js's isSystemCall() treats calls from 'frame-fix-wrapper' as
// system calls, so process.platform returns the real value here.
const REAL_PLATFORM = process.platform;

console.log('[Frame Fix] Wrapper v3.0 loaded');

Module.prototype.require = function(id) {
  // Intercept @ant/claude-swift to ensure VM reports as supported
  if (id && id.includes('@ant/claude-swift')) {
    console.log('[Cowork] Intercepting @ant/claude-swift');
    const swiftStub = originalRequire.apply(this, arguments);
    if (swiftStub && swiftStub.vm) {
      swiftStub.vm.getStatus = function() {
        return { supported: true, status: 'supported', running: true, connected: true };
      };
      swiftStub.vm.getSupportStatus = function() {
        return 'supported';
      };
      swiftStub.vm.isSupported = function() {
        return true;
      };
    }
    return swiftStub;
  }

  const mod = originalRequire.apply(this, arguments);

  if (id === 'electron') {
    const OriginalBrowserWindow = mod.BrowserWindow;
    const OriginalMenu = mod.Menu;

    // Subclass BrowserWindow to force native frame on Linux
    mod.BrowserWindow = class BrowserWindowWithFrame extends OriginalBrowserWindow {
      constructor(options) {
        if (REAL_PLATFORM === 'linux') {
          options = options || {};
          const originalFrame = options.frame;
          // Force native frame
          options.frame = true;
          // Hide the menu bar by default (Alt key will toggle it)
          options.autoHideMenuBar = true;
          // Remove custom titlebar options
          delete options.titleBarStyle;
          delete options.titleBarOverlay;
          // Set window icon (Linux doesn't get it from the app bundle like macOS)
          if (!options.icon) {
            const iconPath = path.join(__dirname, '..', 'icons', 'claude-256.png');
            if (fs.existsSync(iconPath)) {
              options.icon = iconPath;
            }
          }
          console.log(`[Frame Fix] Modified frame from ${originalFrame} to true`);
        }
        super(options);
        if (REAL_PLATFORM === 'linux') {
          this.setMenuBarVisibility(false);
        }
      }
    };

    // Copy static methods and properties (prototype is already set by extends)
    for (const key of Object.getOwnPropertyNames(OriginalBrowserWindow)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(OriginalBrowserWindow, key);
          if (descriptor) {
            Object.defineProperty(mod.BrowserWindow, key, descriptor);
          }
        } catch (e) {
          // Ignore errors for non-configurable properties
        }
      }
    }

    // Wrap Menu.setApplicationMenu to hide menu bar on Linux
    const originalSetAppMenu = OriginalMenu.setApplicationMenu;
    mod.Menu.setApplicationMenu = function(menu) {
      try {
        if (typeof originalSetAppMenu === 'function') {
          originalSetAppMenu.call(OriginalMenu, menu);
        }
      } catch (e) {
        console.log('[Frame Fix] setApplicationMenu error (ignored):', e.message);
      }
      if (REAL_PLATFORM === 'linux') {
        try {
          for (const win of mod.BrowserWindow.getAllWindows()) {
            win.setMenuBarVisibility(false);
          }
        } catch (e) {
          // Ignore - windows may not be ready yet
        }
      }
    };
  }

  return mod;
};
