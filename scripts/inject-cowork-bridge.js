#!/usr/bin/env node
/**
 * Inject ClaudeVM and Cowork IPC bridges into mainView.js preload.
 *
 * The web code (claude.ai) expects ClaudeVM and extended AppFeatures APIs
 * to be exposed via contextBridge. Newer bundle versions removed these,
 * so we inject them at install time.
 *
 * Usage:
 *     node scripts/inject-cowork-bridge.js <path-to-mainView.js>
 */

'use strict';

const fs = require('fs');

function patchMainview(filepath) {
  let content = fs.readFileSync(filepath, 'utf8');

  // Already patched?
  if (content.includes('ClaudeVM')) {
    console.log('  mainView.js: already patched (ClaudeVM bridge exists)');
    return;
  }

  // Extract EIPC UUID
  const uuidMatch = content.match(
    /\$eipc_message\$_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
  );
  if (!uuidMatch) {
    console.error(`ERROR: Could not extract EIPC UUID from ${filepath}`);
    process.exit(1);
  }
  const uuid = uuidMatch[1];
  console.log(`  EIPC UUID: ${uuid}`);

  // Find the ipcRenderer variable name (e.g., 'o' in o.ipcRenderer.invoke)
  const ipcMatch = content.match(/(\w+)\.ipcRenderer\.invoke\("\$eipc_message\$/);
  if (!ipcMatch) {
    console.error(`ERROR: Could not find ipcRenderer variable in ${filepath}`);
    process.exit(1);
  }
  const ipcVar = ipcMatch[1];

  // Find the contextBridge.exposeInMainWorld call for claude.settings namespace
  // Pattern: Object.keys(X).forEach(Y=>Z.contextBridge.exposeInMainWorld(Y,X[Y]))
  const exposePattern =
    /Object\.keys\((\w+)\)\.forEach\((\w+)=>(\w+)\.contextBridge\.exposeInMainWorld\(\2,\1\[\2\]\)\)/;
  const exposeMatch = content.match(exposePattern);
  if (!exposeMatch) {
    console.error(`ERROR: Could not find contextBridge.exposeInMainWorld pattern in ${filepath}`);
    process.exit(1);
  }
  const original = exposeMatch[0];
  const objVar = exposeMatch[1];

  // Build EIPC channel prefix
  const pfx = `$eipc_message$_${uuid}_$_claude.settings_$_`;
  const inv = `${ipcVar}.ipcRenderer.invoke`;

  // Build injection code
  const parts = [
    // Ensure claude.settings namespace exists
    `${objVar}["claude.settings"]=${objVar}["claude.settings"]||{}`,

    // ClaudeVM namespace
    `${objVar}["claude.settings"].ClaudeVM={`
    + `setYukonSilverConfig:function(t){console.log("[BRIDGE] ClaudeVM.setYukonSilverConfig called",t);return ${inv}("${pfx}ClaudeVM_$_setYukonSilverConfig",t)},`
    + `getSupportStatus:function(){console.log("[BRIDGE] ClaudeVM.getSupportStatus called");return ${inv}("${pfx}ClaudeVM_$_getSupportStatus")},`
    + `getDownloadStatus:function(){console.log("[BRIDGE] ClaudeVM.getDownloadStatus called");return ${inv}("${pfx}ClaudeVM_$_getDownloadStatus")},`
    + `getRunningStatus:function(){console.log("[BRIDGE] ClaudeVM.getRunningStatus called");return ${inv}("${pfx}ClaudeVM_$_getRunningStatus")},`
    + `download:function(){console.log("[BRIDGE] ClaudeVM.download called");return ${inv}("${pfx}ClaudeVM_$_download")},`
    + `start:function(){console.log("[BRIDGE] ClaudeVM.start called");return ${inv}("${pfx}ClaudeVM_$_start")},`
    + `stop:function(){console.log("[BRIDGE] ClaudeVM.stop called");return ${inv}("${pfx}ClaudeVM_$_stop")}`
    + `}`,

    // Extend AppFeatures with Cowork-related methods
    `if(${objVar}["claude.settings"].AppFeatures){`
    + `${objVar}["claude.settings"].AppFeatures.getCoworkFeatureState=function(){return ${inv}("${pfx}AppFeatures_$_getCoworkFeatureState")};`
    + `${objVar}["claude.settings"].AppFeatures.getYukonSilverStatus=function(){return ${inv}("${pfx}AppFeatures_$_getYukonSilverStatus")};`
    + `${objVar}["claude.settings"].AppFeatures.getFeatureFlags=function(){return ${inv}("${pfx}AppFeatures_$_getFeatureFlags")}`
    + `}`,

    // LocalAgentModeSessions namespace
    `${objVar}["claude.settings"].LocalAgentModeSessions={`
    + `getAll:function(){return ${inv}("${pfx}LocalAgentModeSessions_$_getAll")},`
    + `create:function(t){return ${inv}("${pfx}LocalAgentModeSessions_$_create",t)},`
    + `get:function(t){return ${inv}("${pfx}LocalAgentModeSessions_$_get",t)}`
    + `}`,
  ];

  const inject = parts.join(';');

  // Inject before the Object.keys(...).forEach(...) call
  content = content.replace(original, inject + ';' + original);

  // Patch window.process.platform/arch for web code
  const processExpose = `${ipcVar}.contextBridge.exposeInMainWorld("process",K)`;
  const processFix = `K.platform="darwin";K.arch="arm64";${processExpose}`;
  if (content.includes(processExpose) && !content.includes(processFix)) {
    content = content.replace(processExpose, processFix);
    console.log('  Patched window.process.platform/arch -> darwin/arm64');
  }

  fs.writeFileSync(filepath, content, 'utf8');
  console.log(`SUCCESS: Injected Cowork IPC bridges into ${filepath}`);
  console.log(`  Settings var: ${objVar}, Electron var: ${ipcVar}`);
  console.log('  Added: ClaudeVM (7 methods), AppFeatures (+3), LocalAgentModeSessions (3)');
}

if (process.argv.length < 3) {
  console.log('Usage: node scripts/inject-cowork-bridge.js <path-to-mainView.js>');
  process.exit(1);
}

patchMainview(process.argv[2]);
