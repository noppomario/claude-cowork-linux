/**
 * Electron API polyfills
 *
 * Patches systemPreferences, BrowserWindow.prototype (macOS-only methods),
 * and Menu (services/recentDocuments filtering).
 */

'use strict';

const electron = require('electron');

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

console.log('[Electron] Patched: systemPreferences, BrowserWindow.prototype, Menu');

module.exports = electron;
