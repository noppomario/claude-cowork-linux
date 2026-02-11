/**
 * IPC wrappers (logging + error suppression + handler protection)
 *
 * Wraps ipcMain.handle, ipcMain.on, and ipcMain.removeHandler to:
 *   - Log IPC calls for diagnostics
 *   - Protect Cowork handlers from being removed by the bundle
 *   - Suppress "already registered" errors
 *   - Fix getInitialLocale fallback
 */

'use strict';

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

/**
 * @param {{ ipcMain: Electron.IpcMain }} deps
 */
module.exports = function({ ipcMain }) {
  // Prevent MaxListenersExceededWarning from AutoUpdater store subscriptions
  ipcMain.setMaxListeners(50);

  // --- removeHandler wrapper ---
  // Prevent the bundle from removing our pre-registered Cowork handlers.
  const origRemoveHandler = ipcMain.removeHandler.bind(ipcMain);
  const removeHandlerWrapper = function(channel) {
    const name = shortChannelName(channel);
    console.log(`[IPC] removeHandler called: ${name}`);
    if (name.includes('ClaudeVM') ||
        name.includes('getCoworkFeatureState') || name.includes('getYukonSilverStatus') ||
        name.includes('getFeatureFlags') || name.includes('LocalAgentModeSessions')) {
      console.log(`[IPC] BLOCKED removeHandler: ${name}`);
      return;
    }
    return origRemoveHandler(channel);
  };
  ipcMain.removeHandler = removeHandlerWrapper;
  try {
    const proto = Object.getPrototypeOf(ipcMain);
    if (proto && typeof proto.removeHandler === 'function') {
      proto.removeHandler = removeHandlerWrapper;
    }
  } catch (e) { /* prototype patch failed, wrapper on instance should suffice */ }

  // --- handle wrapper ---
  const origHandle = ipcMain.handle.bind(ipcMain);
  const handleWrapper = function(channel, handler) {
    const name = shortChannelName(channel);
    if (name.includes('AppFeatures') || name.includes('ClaudeVM') || name.includes('LocalAgent')) {
      console.log(`[IPC] handle() registering: ${name}`);
    }
    const wrapped = async (event, ...args) => {
      try {
        const result = await handler(event, ...args);
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

  // --- on wrapper (sync IPC) ---
  const origOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = function(channel, handler) {
    const wrapped = (event, ...args) => {
      const name = shortChannelName(channel);
      try {
        handler(event, ...args);
        // Fix: If bundle's getInitialLocale handler fails origin validation,
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

  return { shortChannelName, describeResult };
};
