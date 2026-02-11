#!/usr/bin/env node
/**
 * Extract Linux-compatible PNG icons from electron.icns (macOS format).
 *
 * icns is a container with embedded PNG data — no external dependencies needed.
 *
 * Usage:
 *     node scripts/extract-icons.js <path-to-electron.icns> <output-dir>
 */

'use strict';

const fs = require('fs');
const path = require('path');

// icns type -> nominal pixel size (modern types embed PNG directly)
const TYPE_SIZE = {
  'ic07': 128,
  'ic08': 256,
  'ic09': 512,
  'ic10': 1024,
  'ic11': 32,
  'ic12': 64,
  'ic13': 256,
  'ic14': 512,
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

function extractIcons(icnsPath, outputDir) {
  const data = fs.readFileSync(icnsPath);

  if (data.toString('ascii', 0, 4) !== 'icns') {
    console.error('Not an icns file');
    process.exit(1);
  }

  const total = data.readUInt32BE(4);
  let pos = 8;
  const best = new Map(); // size -> { data, length }

  while (pos < total) {
    const etype = data.toString('ascii', pos, pos + 4);
    const esize = data.readUInt32BE(pos + 4);
    const payload = data.subarray(pos + 8, pos + esize);

    if (etype in TYPE_SIZE && payload.subarray(0, 4).equals(PNG_MAGIC)) {
      const size = TYPE_SIZE[etype];
      if (!best.has(size) || payload.length > best.get(size).length) {
        best.set(size, payload);
      }
    }
    pos += esize;
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const sizes = [...best.keys()].sort((a, b) => a - b);
  for (const size of sizes) {
    fs.writeFileSync(path.join(outputDir, `claude-${size}.png`), best.get(size));
  }

  console.log(`Extracted ${best.size} icons: [${sizes.join(', ')}]`);
}

if (process.argv.length < 4) {
  console.log('Usage: node scripts/extract-icons.js <path-to-electron.icns> <output-dir>');
  process.exit(1);
}

extractIcons(process.argv[2], process.argv[3]);
