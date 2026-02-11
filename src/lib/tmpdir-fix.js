/**
 * TMPDIR fix + fs.rename EXDEV patch
 *
 * Claude downloads VM bundles to /tmp (tmpfs), then fs.rename() to persistent
 * storage fails with EXDEV (cross-device link). Fix: redirect TMPDIR to the
 * same filesystem and wrap fs.rename to copy+delete on EXDEV.
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// --- TMPDIR redirect ---
const vmBundleDir = path.join(os.homedir(), '.config/Claude/vm_bundles');
const vmTmpDir = path.join(vmBundleDir, 'tmp');
const claudeVmBundle = path.join(vmBundleDir, 'claudevm.bundle');

try {
  fs.mkdirSync(vmTmpDir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = vmTmpDir;
  process.env.TMP = vmTmpDir;
  process.env.TEMP = vmTmpDir;
  os.tmpdir = () => vmTmpDir;

  // Pre-create VM bundle markers to skip download (we run native, no VM)
  fs.mkdirSync(claudeVmBundle, { recursive: true, mode: 0o755 });
  const markers = ['bundle_complete', 'rootfs.img', 'rootfs.img.zst', 'vmlinux', 'config.json'];
  for (const m of markers) {
    const p = path.join(claudeVmBundle, m);
    if (!fs.existsSync(p)) {
      const content = m === 'config.json'
        ? '{"version":"linux-native","skip_vm":true}'
        : 'linux-native-placeholder';
      fs.writeFileSync(p, content, { mode: 0o644 });
    }
  }
  fs.writeFileSync(path.join(claudeVmBundle, 'version'), '999.0.0-linux-native', { mode: 0o644 });
  console.log('[TMPDIR] Fixed:', vmTmpDir);
} catch (e) {
  console.error('[TMPDIR] Setup failed:', e.message);
}

// --- fs.rename EXDEV patch ---
const originalRename = fs.rename;
const originalRenameSync = fs.renameSync;

fs.rename = function(oldPath, newPath, callback) {
  originalRename(oldPath, newPath, (err) => {
    if (err && err.code === 'EXDEV') {
      const readStream = fs.createReadStream(oldPath);
      const writeStream = fs.createWriteStream(newPath);
      readStream.on('error', callback);
      writeStream.on('error', callback);
      writeStream.on('close', () => {
        fs.unlink(oldPath, () => callback(null));
      });
      readStream.pipe(writeStream);
    } else {
      callback(err);
    }
  });
};

fs.renameSync = function(oldPath, newPath) {
  try {
    return originalRenameSync(oldPath, newPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(oldPath, newPath);
      fs.unlinkSync(oldPath);
      return;
    }
    throw err;
  }
};
