#!/usr/bin/env node
/**
 * Patch Claude Desktop to enable Cowork (yukonSilver) on Linux.
 *
 * Finds all functions that gate features behind process.platform !== "darwin"
 * and patches them to unconditionally return {status:"supported"}.
 *
 * Usage:
 *     node scripts/enable-cowork.js <path-to-index.js>
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Find a function body with balanced braces starting at `start`.
 */
function findBalancedFunction(content, start) {
  let depth = 0;
  for (let i = start; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return null;
}

function patchFile(filepath) {
  let content = fs.readFileSync(filepath, 'utf8');

  // Find all: function <name>(){return process.platform!=="darwin"?{status:"un...
  const pattern = /function\s+(\w+)\(\)\{return\s+process\.platform!=="darwin"\?\{status:"(?:unsupported|unavailable)"/g;

  const patches = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const funcName = match[1];
    const funcBody = findBalancedFunction(content, match.index);
    if (funcBody) {
      const replacement = `function ${funcName}(){return{status:"supported"}}`;
      patches.push({ old: funcBody, replacement, name: funcName });
    }
  }

  if (patches.length === 0) {
    console.error(`ERROR: No platform-gated functions found in ${filepath}`);
    process.exit(1);
  }

  for (const { old, replacement, name } of patches) {
    if (content.includes(replacement)) {
      console.log(`  ${name}(): already patched`);
      continue;
    }
    content = content.replace(old, replacement);
    console.log(`  ${name}(): patched -> {status:"supported"}`);
  }

  // Remove titleBarStyle:"hidden" — strip the option from the bundle
  // so windows use the default native frame on Linux.
  const count = (content.match(/titleBarStyle:"hidden",/g) || []).length;
  if (count) {
    content = content.replaceAll('titleBarStyle:"hidden",', '');
    console.log(`  Removed ${count} titleBarStyle:"hidden" (Linux native frame)`);
  }

  fs.writeFileSync(filepath, content, 'utf8');
  console.log(`SUCCESS: Patched ${patches.length} function(s) in ${filepath}`);
}

if (process.argv.length < 3) {
  console.log('Usage: node scripts/enable-cowork.js <path-to-index.js>');
  process.exit(1);
}

patchFile(process.argv[2]);
