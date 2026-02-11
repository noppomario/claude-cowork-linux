# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Cowork for Linux — unofficial project that runs the official Claude Desktop (macOS Electron app) on Linux with full Cowork (YukonSilver) support. Achieves this through platform spoofing, native module stubbing, IPC bridge injection, and bundle patching.

## Commands

### Install

```bash
./install-oneclick.sh                              # Interactive install
CLAUDE_DMG=/path/to/local.dmg ./install-oneclick.sh # Use local DMG
```

### Run

```bash
claude-desktop              # Normal launch
claude-desktop --debug      # Trace logging (CLAUDE_TRACE=1)
claude-desktop --devtools   # Chrome DevTools
```

### Debug

```bash
tail -f ~/Library/Logs/Claude/startup.log
tail -f ~/.local/share/claude-cowork/logs/claude-swift-trace.log  # Requires CLAUDE_COWORK_TRACE_IO=1
```

### No build/lint/test pipeline

This project has no package.json, no build step, and no test suite. Scripts run directly via bash/node/python.

## Architecture

### Boot Sequence

1. **install-oneclick.sh** — Downloads Claude.dmg, extracts .asar, patches bundle, installs to `/Applications/Claude.app`
2. **linux-loader.js** — Electron main process compatibility layer (platform spoofing, module interception, EIPC handler registration, TMPDIR fix)
3. **stubs/frame-fix/frame-fix-entry.js** → **frame-fix-wrapper.js** — Pre-app initialization, then loads `.vite/build/index.js`
4. **patches/enable-cowork.py** — Bundle patch: rewrites platform checks to return `{status:"supported"}`
5. **patches/inject-cowork-bridge.py** — Injects ClaudeVM/AppFeatures/LocalAgentModeSessions IPC bridges into mainView.js preload
6. **stubs/@ant/claude-swift/js/index.js** — SwiftAddonStub: replaces macOS Swift VM addon, spawns Cowork processes on host, translates VM paths to `~/.local/share/claude-cowork/sessions/`
7. **stubs/@ant/claude-native/index.js** — Native module stubs (auth, window control, desktop integration)

### Key Mechanisms

- **Platform spoofing is stack-based**: `isSystemCall()` in linux-loader.js inspects the call stack. App code sees `process.platform === 'darwin'` / `os.arch() === 'arm64'`; system/Node internals see the real platform.
- **TMPDIR trick**: Claude downloads VM bundles to /tmp (tmpfs), then `rename()` to disk fails with EXDEV. Fix: set TMPDIR to `~/.config/Claude/vm_bundles/tmp` and wrap `fs.rename` to copy+delete on cross-device errors.
- **IPC channel format**: `$eipc_message$_<UUID>_$_<namespace>_$_<method>` — UUID is extracted from the bundle by inject-cowork-bridge.py.
- **Path translation**: VM paths `/sessions/<name>/...` → host paths `~/.local/share/claude-cowork/sessions/<name>/...` in all file operations.

### File Roles

| File | Role |
| ---- | ---- |
| `install-oneclick.sh` | 9-phase installer (deps, download, extract, patch, install, desktop entry) |
| `linux-loader.js` | Core compat layer: 8-phase patching of Electron runtime |
| `patches/enable-cowork.py` | Regex patch: force Cowork support status in minified bundle |
| `patches/inject-cowork-bridge.py` | Inject IPC bridge code into mainView.js preload script |
| `stubs/@ant/claude-swift/js/index.js` | SwiftAddonStub (EventEmitter): process spawning, path translation, file ops, desktop integration |
| `stubs/@ant/claude-native/index.js` | Native binding stubs + IPC handler registration |
| `stubs/frame-fix/` | Entry point chain for pre-app initialization |

## Development Notes

- **No package.json**: Global tools required — `electron`, `@electron/asar` (installed via npm or mise)
- **Git branch**: `main` is the default branch
- **Patch fragility**: Python patches in `patches/` rely on specific minification patterns in the Claude bundle. Changes in upstream Claude releases may break these regex patterns.
- **Security**: SwiftAddonStub uses environment variable allowlisting, path traversal protection, and `execFile` (not `exec`) to prevent injection.
