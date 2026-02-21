/**
 * Diagnostic logging
 *
 * Captures renderer console output, probes desktop APIs,
 * and injects desktopBootFeatures into web contents.
 */

'use strict';

/**
 * @param {{ app: Electron.App, shortChannelName: Function, describeResult: Function }} deps
 */
module.exports = function({ app, shortChannelName, describeResult }) {
  app.whenReady().then(() => {
    app.on('web-contents-created', (_event, contents) => {
      const cType = contents.getType();
      console.log(`[DIAG] web-contents-created: type=${cType}`);

      // Wrap webContents.ipc.handle to intercept scoped handler registrations
      if (contents.ipc && typeof contents.ipc.handle === 'function') {
        const origWcHandle = contents.ipc.handle.bind(contents.ipc);
        contents.ipc.handle = function(channel, handler) {
          const name = shortChannelName(channel);
          if (name.includes('AppFeatures') || name.includes('ClaudeVM') || name.includes('LocalAgent')) {
            console.log(`[IPC:WC] scoped handle() registering: ${name}`);
          }
          // Replace QuickEntry scoped handlers with no-ops to prevent
          // Dt.setRecentChats/setActiveChatId crashes in the bundle
          if (name.includes('QuickEntry')) {
            console.log(`[IPC:WC] Replacing QuickEntry scoped handler: ${name}`);
            return origWcHandle(channel, async () => ({ success: true }));
          }
          // Log getSupportedFeatures and getAppConfig responses
          if (name.includes('getSupportedFeatures') || name.includes('getAppConfig')) {
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

      // Capture renderer console output
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
          // Intercept fetch to log 4xx/5xx responses (all URLs)
          contents.executeJavaScript(`
            (() => {
              const origFetch = window.fetch;
              window.fetch = async function(...args) {
                const resp = await origFetch.apply(this, args);
                if (resp.status >= 400) {
                  const u = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                  console.log('[FETCH_DIAG] ' + resp.status + ' ' + u.split('?')[0]);
                }
                return resp;
              };
              // Also intercept XMLHttpRequest
              const origXHROpen = XMLHttpRequest.prototype.open;
              const origXHRSend = XMLHttpRequest.prototype.send;
              XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                this._diagUrl = url;
                return origXHROpen.call(this, method, url, ...rest);
              };
              XMLHttpRequest.prototype.send = function(...args) {
                this.addEventListener('load', function() {
                  if (this.status >= 400) {
                    console.log('[XHR_DIAG] ' + this.status + ' ' + (this._diagUrl || '').split('?')[0]);
                  }
                });
                return origXHRSend.apply(this, args);
              };
              console.log('[FETCH_DIAG] Fetch+XHR interceptor installed');
            })();
          `).catch(() => {});
          // Probe getAppConfig to see cowork flags
          contents.executeJavaScript(`
            (() => {
              const ac = window['claude.settings']?.AppConfig;
              if (ac && typeof ac.getAppConfig === 'function') {
                ac.getAppConfig()
                  .then(v => console.log('[DIAG] getAppConfig => ' + JSON.stringify(v).slice(0, 500)))
                  .catch(e => console.log('[DIAG] getAppConfig error: ' + e));
              } else {
                console.log('[DIAG] AppConfig.getAppConfig NOT available');
              }
            })();
          `).catch(() => {});
          contents.executeJavaScript(`
            (() => {
              const L = console.log.bind(console);
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
              L('[BOOT] window.process: ' + JSON.stringify({
                platform: window.process?.platform,
                arch: window.process?.arch,
                isInternalBuild: window.process?.isInternalBuild,
                isPackaged: window.process?.isPackaged,
                keys: window.process ? Object.keys(window.process).join(',') : 'N/A'
              }));
              setTimeout(() => {
                const dbf = window.desktopBootFeatures;
                L('[BOOT] desktopBootFeatures: ' + (dbf ? JSON.stringify(dbf).slice(0, 500) : 'NOT FOUND'));
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
};
