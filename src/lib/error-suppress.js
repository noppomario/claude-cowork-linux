/**
 * Error handling
 *
 * Suppresses known non-fatal errors from macOS-specific code paths
 * that don't exist on Linux.
 */

'use strict';

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
