# Known Issues

## Folder Selection Dropdown Doesn't Update

**Status**: Known limitation
**Severity**: Low (cosmetic only)

### Description

After selecting a new folder, the dropdown continues to display the previously selected folder name.

**Important**: The folder is stored correctly and sessions work as expected. This is only a UI display issue.

### Workaround

Press `Ctrl+R` or `F5` to refresh the page after selecting a folder.

---

## Safe Storage Encryption Warning

**Message**: `Electron safeStorage encryption is not available on this system`

**Impact**: Low - allowlist cache can't be encrypted

**Workaround**: None needed

---

## Reporting Issues

If you encounter other issues:

1. Check `~/.config/Claude/logs/main.log`
2. Check `~/.local/share/claude-cowork/logs/claude-swift-trace.log`
3. Report at: https://github.com/johnzfitch/claude-cowork-linux/issues

Include:
- Distro and kernel version
- Relevant log snippets
- Steps to reproduce
