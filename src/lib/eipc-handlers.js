/**
 * IPC handlers for Cowork/YukonSilver
 *
 * Pre-registers EIPC handlers for AppFeatures, ClaudeVM,
 * LocalAgentModeSessions, AutoUpdater, DesktopIntl, WindowControl, etc.
 * UUID and getSupportedFeatures schema are auto-detected from the bundle.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {{ ipcMain: Electron.IpcMain }} deps
 */
module.exports = function({ ipcMain }) {
  // Auto-detect EIPC UUID and getSupportedFeatures schema from the app bundle
  let EIPC_UUID = 'c42e5915-d1f8-48a1-a373-fe793971fdbd';
  let SUPPORTED_FEATURES_FIELDS = ['nativeQuickEntry', 'quickEntryDictation'];
  try {
    const bundleIndex = path.join(__dirname, '..', 'app', '.vite', 'build', 'index.js');
    const bundleContent = fs.readFileSync(bundleIndex, 'utf8');

    const uuidMatch = bundleContent.match(
      /\$eipc_message\$_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
    );
    if (uuidMatch) {
      EIPC_UUID = uuidMatch[1];
      console.log('[EIPC] UUID:', EIPC_UUID);
    }

    // Extract getSupportedFeatures field names from Zod schema
    const validatorMatch = bundleContent.match(
      /!(\w{2,3})\(i\)\)throw new Error\('Result from method "getSupportedFeatures"/
    );
    if (validatorMatch) {
      const validatorFn = validatorMatch[1];
      const schemaMatch = bundleContent.match(
        new RegExp(`function ${validatorFn}\\(t\\)\\{return (\\w+)\\.safeParse`)
      );
      if (schemaMatch) {
        const schemaVar = schemaMatch[1];
        const defMatch = bundleContent.match(
          new RegExp(`[,;]${schemaVar}=\\w+\\(\\{([\\w:,]+)\\}\\)`)
        );
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

  function registerHandler(handlerName, handler, isSync = false) {
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
  registerHandler('AppFeatures_$_getSupportedFeatures', async () => {
    const result = {};
    for (const field of SUPPORTED_FEATURES_FIELDS) {
      result[field] = { status: 'supported' };
    }
    return result;
  });
  registerHandler('AppFeatures_$_getCoworkFeatureState', async () => ({
    enabled: true, status: 'supported', reason: null,
  }));
  registerHandler('AppFeatures_$_getYukonSilverStatus', async () => ({ status: 'supported' }));
  registerHandler('AppFeatures_$_getFeatureFlags', async () => ({
    yukonSilver: true, cowork: true, localAgentMode: true,
  }));

  // ----- ClaudeVM -----
  registerHandler('ClaudeVM_$_download', async () => ({ status: 'ready', downloaded: true, progress: 100 }));
  registerHandler('ClaudeVM_$_getDownloadStatus', async () => ({
    status: 'ready', downloaded: true, progress: 100, version: 'linux-native-1.0.0',
  }));
  registerHandler('ClaudeVM_$_getRunningStatus', async () => ({ running: true, connected: true, status: 'connected' }));
  registerHandler('ClaudeVM_$_start', async () => ({ started: true, status: 'running' }));
  registerHandler('ClaudeVM_$_stop', async () => ({ stopped: true }));
  registerHandler('ClaudeVM_$_getSupportStatus', async () => ({ status: 'supported' }));
  registerHandler('ClaudeVM_$_setYukonSilverConfig', async (_event, config) => {
    console.log('[YukonSilver] Config:', JSON.stringify(config).slice(0, 200));
    return { success: true };
  });

  // ----- LocalAgentMode / Cowork sessions -----
  registerHandler('LocalAgentModeSessions_$_getAll', async () => []);
  registerHandler('LocalAgentModeSessions_$_create', async (_event, data) => ({
    id: `session-${Date.now()}`, ...data,
  }));
  registerHandler('LocalAgentModeSessions_$_get', async (_event, id) => ({ id, status: 'active' }));

  // ----- AutoUpdater -----
  registerHandler('AutoUpdater_$_updaterState_$store$_getState', async () => ({
    updateAvailable: false, updateDownloaded: false, checking: false,
    error: null, version: null, progress: null,
  }));
  registerHandler('AutoUpdater_$_updaterState_$store$_update', async () => ({ success: true }));

  // ----- DesktopIntl (SYNC) -----
  registerHandler('DesktopIntl_$_getInitialLocale', () => {
    const locale = process.env.LANG?.split('.')[0]?.replace('_', '-') || 'en-US';
    return { result: { locale, messages: {} }, error: null };
  }, true);
  registerHandler('DesktopIntl_$_requestLocaleChange', async () => ({ success: true }));

  // ----- WindowControl -----
  registerHandler('WindowControl_$_setThemeMode', async () => ({ success: true }));
  registerHandler('WindowControl_$_setIncognitoMode', async () => ({ success: true }));
  registerHandler('WindowControl_$_getFullscreen', async () => false);

  // ----- Misc -----
  registerHandler('LocalPlugins_$_getPlugins', async () => []);
  registerHandler('Account_$_setAccountDetails', async () => ({ success: true }));
  registerHandler('QuickEntry_$_setRecentChats', async () => ({ success: true }));

  console.log('[IPC] Cowork handlers registered');
};
