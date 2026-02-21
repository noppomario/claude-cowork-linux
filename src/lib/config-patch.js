/**
 * Config patch for Cowork/YukonSilver
 *
 * Ensures claude_desktop_config.json includes cowork feature flags
 * so the bundle's getAppConfig() returns them to the web code.
 *
 * @param {{ app: Electron.App }} deps
 */

'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function({ app }) {
  try {
    // app.getPath('userData') returns ~/.config/Electron/ at this point
    // because app.name is still "Electron". The bundle reads config from
    // ~/Library/Application Support/Claude/ (macOS-spoofed path), so
    // compute the path directly.
    const configDir = path.join(require('os').homedir(), 'Library', 'Application Support', 'Claude');
    const configPath = path.join(configDir, 'claude_desktop_config.json');

    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      // Config doesn't exist yet or is invalid — start fresh
      fs.mkdirSync(configDir, { recursive: true });
    }

    let changed = false;

    // Ensure features.cowork and features.yukonSilver are set
    if (!config.features || !config.features.cowork) {
      config.features = {
        ...config.features,
        cowork: true,
        yukonSilver: true,
      };
      changed = true;
    }

    // Ensure yukonSilverConfig is set
    if (!config.yukonSilverConfig) {
      config.yukonSilverConfig = {
        autoDownloadInBackground: true,
        autoStartOnUserIntent: true,
        memoryGB: 4,
        useCoworkOauth: true,
      };
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      console.log('[ConfigPatch] Patched:', configPath);
    } else {
      console.log('[ConfigPatch] Config already has cowork flags');
    }
  } catch (e) {
    console.warn('[ConfigPatch] Failed:', e.message);
  }
};
