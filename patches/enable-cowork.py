#!/usr/bin/env python3
"""
Patch Claude Desktop to enable Cowork (yukonSilver) on Linux.

Finds all functions that gate features behind process.platform !== "darwin"
and patches them to unconditionally return {status:"supported"}.

Usage:
    python3 patches/enable-cowork.py <path-to-index.js>
"""

import sys
import re


def find_balanced_function(content, start):
    """Find a function body with balanced braces starting at `start`."""
    depth = 0
    for i in range(start, len(content)):
        if content[i] == '{':
            depth += 1
        elif content[i] == '}':
            depth -= 1
            if depth == 0:
                return content[start:i + 1]
    return None


def patch_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Find all functions: function <name>(){return process.platform!=="darwin"?{status:"un...
    pattern = re.compile(
        r'function\s+(\w+)\(\)\{return\s+process\.platform!=="darwin"\?\{status:"(?:unsupported|unavailable)"'
    )

    patches = []
    for match in pattern.finditer(content):
        func_name = match.group(1)
        func_body = find_balanced_function(content, match.start())
        if func_body:
            replacement = f'function {func_name}(){{return{{status:"supported"}}}}'
            patches.append((func_body, replacement, func_name))

    if not patches:
        print(f"ERROR: No platform-gated functions found in {filepath}")
        return False

    for old, new, name in patches:
        if new in content:
            print(f"  {name}(): already patched")
            continue
        content = content.replace(old, new)
        print(f"  {name}(): patched -> {{status:\"supported\"}}")

    # Remove titleBarStyle:"hidden" — Electron's BrowserWindow property is
    # read-only so we cannot wrap the constructor. Instead, strip the option
    # from the bundle so windows use the default native frame on Linux.
    # Quick Entry windows also lose this but keep frame:!1 so stay frameless.
    count = content.count('titleBarStyle:"hidden",')
    if count:
        content = content.replace('titleBarStyle:"hidden",', '')
        print(f"  Removed {count} titleBarStyle:\"hidden\" (Linux native frame)")

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"SUCCESS: Patched {len(patches)} function(s) in {filepath}")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    success = patch_file(sys.argv[1])
    sys.exit(0 if success else 1)
