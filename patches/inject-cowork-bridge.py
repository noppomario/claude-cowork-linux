#!/usr/bin/env python3
"""
Inject ClaudeVM and Cowork IPC bridges into mainView.js preload.

The web code (claude.ai) expects ClaudeVM and extended AppFeatures APIs
to be exposed via contextBridge. Newer bundle versions removed these,
so we inject them at install time.

Usage:
    python3 patches/inject-cowork-bridge.py <path-to-mainView.js>
"""

import sys
import re


def patch_mainview(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Already patched?
    if 'ClaudeVM' in content:
        print(f"  mainView.js: already patched (ClaudeVM bridge exists)")
        return True

    # Extract EIPC UUID from existing code
    uuid_match = re.search(
        r'\$eipc_message\$_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
        content
    )
    if not uuid_match:
        print(f"ERROR: Could not extract EIPC UUID from {filepath}")
        return False

    uuid = uuid_match.group(1)
    print(f"  EIPC UUID: {uuid}")

    # Find the ipcRenderer variable name (e.g., 'o' in o.ipcRenderer.invoke)
    ipc_match = re.search(r'(\w+)\.ipcRenderer\.invoke\("\$eipc_message\$', content)
    if not ipc_match:
        print(f"ERROR: Could not find ipcRenderer variable in {filepath}")
        return False
    ipc_var = ipc_match.group(1)

    # Find the contextBridge.exposeInMainWorld call for claude.settings namespace
    # Pattern: Object.keys(X).forEach(Y=>Z.contextBridge.exposeInMainWorld(Y,X[Y]))
    # We target the FIRST such call (which exposes the claude.settings namespace)
    pattern = re.compile(
        r'(Object\.keys\((\w+)\)\.forEach\((\w+)=>(\w+)\.contextBridge\.exposeInMainWorld\(\3,\2\[\3\]\)\))'
    )

    match = pattern.search(content)
    if not match:
        print(f"ERROR: Could not find contextBridge.exposeInMainWorld pattern in {filepath}")
        return False

    obj_var = match.group(2)  # The settings object variable (e.g., C)
    original = match.group(1)

    # Build EIPC channel prefix
    pfx = f'$eipc_message$_{uuid}_$_claude.settings_$_'
    inv = f'{ipc_var}.ipcRenderer.invoke'

    # Build the injection code
    inject_parts = [
        # Ensure claude.settings namespace exists
        f'{obj_var}["claude.settings"]={obj_var}["claude.settings"]||{{}}',

        # ClaudeVM namespace - IPC bridges for Cowork/YukonSilver (with logging)
        f'{obj_var}["claude.settings"].ClaudeVM={{'
        f'setYukonSilverConfig:function(t){{console.log("[BRIDGE] ClaudeVM.setYukonSilverConfig called",t);return {inv}("{pfx}ClaudeVM_$_setYukonSilverConfig",t)}},'
        f'getSupportStatus:function(){{console.log("[BRIDGE] ClaudeVM.getSupportStatus called");return {inv}("{pfx}ClaudeVM_$_getSupportStatus")}},'
        f'getDownloadStatus:function(){{console.log("[BRIDGE] ClaudeVM.getDownloadStatus called");return {inv}("{pfx}ClaudeVM_$_getDownloadStatus")}},'
        f'getRunningStatus:function(){{console.log("[BRIDGE] ClaudeVM.getRunningStatus called");return {inv}("{pfx}ClaudeVM_$_getRunningStatus")}},'
        f'download:function(){{console.log("[BRIDGE] ClaudeVM.download called");return {inv}("{pfx}ClaudeVM_$_download")}},'
        f'start:function(){{console.log("[BRIDGE] ClaudeVM.start called");return {inv}("{pfx}ClaudeVM_$_start")}},'
        f'stop:function(){{console.log("[BRIDGE] ClaudeVM.stop called");return {inv}("{pfx}ClaudeVM_$_stop")}}'
        f'}}',

        # Extend AppFeatures with Cowork-related methods
        f'if({obj_var}["claude.settings"].AppFeatures){{'
        f'{obj_var}["claude.settings"].AppFeatures.getCoworkFeatureState=function(){{return {inv}("{pfx}AppFeatures_$_getCoworkFeatureState")}};'
        f'{obj_var}["claude.settings"].AppFeatures.getYukonSilverStatus=function(){{return {inv}("{pfx}AppFeatures_$_getYukonSilverStatus")}};'
        f'{obj_var}["claude.settings"].AppFeatures.getFeatureFlags=function(){{return {inv}("{pfx}AppFeatures_$_getFeatureFlags")}}'
        f'}}',

        # LocalAgentModeSessions namespace - Cowork session management
        f'{obj_var}["claude.settings"].LocalAgentModeSessions={{'
        f'getAll:function(){{return {inv}("{pfx}LocalAgentModeSessions_$_getAll")}},'
        f'create:function(t){{return {inv}("{pfx}LocalAgentModeSessions_$_create",t)}},'
        f'get:function(t){{return {inv}("{pfx}LocalAgentModeSessions_$_get",t)}}'
        f'}}',
    ]

    inject = ';'.join(inject_parts)

    # Inject before the Object.keys(...).forEach(...) call
    replacement = inject + ';' + original
    content = content.replace(original, replacement, 1)

    # Patch 2: Fix window.process.platform/arch for web code
    # The preload copies real process.platform/arch into K object, then exposes
    # it as window.process. The web code checks window.process.platform to gate
    # desktop features. We override K.platform/K.arch right before exposure.
    process_expose = f'{ipc_var}.contextBridge.exposeInMainWorld("process",K)'
    process_fix = f'K.platform="darwin";K.arch="arm64";{process_expose}'
    if process_expose in content and process_fix not in content:
        content = content.replace(process_expose, process_fix, 1)
        print("  Patched window.process.platform/arch -> darwin/arm64")

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"SUCCESS: Injected Cowork IPC bridges into {filepath}")
    print(f"  Settings var: {obj_var}, Electron var: {ipc_var}")
    print(f"  Added: ClaudeVM (7 methods), AppFeatures (+3), LocalAgentModeSessions (3)")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    success = patch_mainview(sys.argv[1])
    sys.exit(0 if success else 1)
