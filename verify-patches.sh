#!/bin/bash
# Verify all patches have been applied correctly

echo "=== Verifying Claude Cowork Linux Patches ==="
echo ""

INDEX_FILE="app/.vite/build/index.js"

if [ ! -f "$INDEX_FILE" ]; then
    echo "❌ ERROR: $INDEX_FILE not found"
    echo "   Run ./install.sh first"
    exit 1
fi

check_patch() {
    local name="$1"
    local pattern="$2"

    if grep -q "$pattern" "$INDEX_FILE"; then
        echo "✓ $name"
        return 0
    else
        echo "✗ $name - NOT APPLIED"
        return 1
    fi
}

echo "Checking patches:"
echo ""

# Check all 3 patches
check_patch "1. Platform support (Ege)" 'if(process.platform==="linux")return{status:"supported"}'
check_patch "2. IPC origin validation (Q7)" 'process.platform==="linux"'
check_patch "3. Extensions/connectors (\$n)" '\$n=process.platform==="darwin"||process.platform==="linux"'

echo ""
echo "=== Verification Complete ==="
echo ""
echo "If any patches are missing, run:"
echo "  ./install.sh"
