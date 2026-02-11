# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Cowork for Linux — runs the official Claude Desktop (macOS Electron app) on Linux with full Cowork (YukonSilver) support via platform spoofing, native module stubbing, IPC bridge injection, and bundle patching.

## Commands

```bash
./install-oneclick.sh                               # Interactive install
CLAUDE_DMG=/path/to/local.dmg ./install-oneclick.sh # Use local DMG
claude-desktop --debug                              # Trace logging
tail -f ~/Library/Logs/Claude/startup.log           # Watch logs
```

No build step, no test suite. Scripts run directly via bash/node.

## Key Mechanisms

- **Stack-based platform spoofing**: `isSystemCall()` in `src/lib/platform-spoof.js` inspects the call stack. App code sees `darwin`/`arm64`; Node internals see the real platform.
- **TMPDIR trick**: Claude downloads VM bundles to /tmp (tmpfs), then `rename()` to disk fails with EXDEV. Fix: redirect TMPDIR to `~/.config/Claude/vm_bundles/tmp` and wrap `fs.rename` to copy+delete.
- **IPC channel format**: `$eipc_message$_<UUID>_$_<namespace>_$_<method>` — UUID is auto-detected from the bundle at both install time (by `scripts/inject-cowork-bridge.js`) and runtime (by `src/lib/eipc-handlers.js`).
- **Path translation**: VM paths `/sessions/<name>/...` → host paths `~/.local/share/claude-cowork/sessions/<name>/...` in SwiftAddonStub.

## Repo Layout

`src/` maps 1:1 to `Contents/Resources/` at install time. `scripts/` is not installed.

## Patch Fragility

Bundle patches (`scripts/enable-cowork.js`, `scripts/inject-cowork-bridge.js`) rely on specific minification patterns. Upstream Claude releases may break these regex patterns — this is the most common breakage point.
