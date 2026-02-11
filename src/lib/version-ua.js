/**
 * App version fix + User-Agent spoofing
 *
 * Electron reads version from package.json relative to the main script.
 * Since linux-loader.js is in Resources/ (not Resources/app/), Electron
 * returns "0.0". The bundle captures app.getVersion() at init time for
 * Anthropic-Client-Version headers.
 *
 * User-Agent must contain "Claude/<version>" so the bundle's Spe() can
 * replace it with "ClaudeNest/<version>". The web code checks for
 * "ClaudeNest" in UA to determine desktop mode.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {{ app: Electron.App, session: typeof Electron.session }} deps
 * @returns {string} The correct app version
 */
module.exports = function({ app, session }) {
  let correctVersion = '0.14.10';
  try {
    const appPkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'app', 'package.json'), 'utf8')
    );
    correctVersion = appPkg.version || '0.14.10';
    app.getVersion = () => correctVersion;
    console.log('[Version] Fixed:', correctVersion, '| app.name:', app.getName());
  } catch (e) {
    console.warn('[Version] Failed to read app version, using fallback');
    app.getVersion = () => correctVersion;
  }

  // Set desktop filename so GNOME Wayland matches the window to claude.desktop
  if (typeof app.setDesktopName === 'function') {
    app.setDesktopName('claude.desktop');
  }

  // Spoof User-Agent to include Claude/<version> for desktop mode detection
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

  return correctVersion;
};
