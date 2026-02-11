#!/bin/bash
#
# Claude Desktop for Linux - One-Click Installer
#
# Usage: curl -fsSL https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master/install-oneclick.sh | bash
#
# This script:
#   1. Checks/installs dependencies (7z, node, electron, asar)
#   2. Downloads Claude macOS DMG from Anthropic's official CDN
#   3. Extracts and patches the app for Linux compatibility
#   4. Installs to /Applications/Claude.app (macOS-style path for compat)
#   5. Creates desktop entry and CLI command
#
# Requirements: Linux with apt/pacman/dnf, Node.js 18+, ~500MB disk space
#
# License: MIT
# Source: https://github.com/johnzfitch/claude-cowork-linux

set -euo pipefail

# ============================================================
# Local repo detection (for running from cloned repo)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============================================================
# Configuration
# ============================================================

VERSION="2.0.0"
CLAUDE_VERSION="latest"

# Official Anthropic download URLs
DMG_URL_PRIMARY="https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest/Claude.dmg"
DMG_URL_FALLBACK="https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect"

# Stub download URLs (from GitHub repo)
REPO_BASE="https://raw.githubusercontent.com/johnzfitch/claude-cowork-linux/master"
SWIFT_STUB_URL="${REPO_BASE}/stubs/@ant/claude-swift/js/index.js"
NATIVE_STUB_URL="${REPO_BASE}/stubs/@ant/claude-native/index.js"

# Minimum expected DMG size (100MB) - basic integrity check
MIN_DMG_SIZE=100000000

# Installation paths
INSTALL_DIR="/Applications/Claude.app"
USER_DATA_DIR="$HOME/Library/Application Support/Claude"
USER_LOG_DIR="$HOME/Library/Logs/Claude"
USER_CACHE_DIR="$HOME/Library/Caches/Claude"

# Temp directory for installation (with cleanup on multiple signals)
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================
# Utility Functions
# ============================================================

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

die() {
    log_error "$@"
    exit 1
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Detect package manager
detect_pkg_manager() {
    if command_exists apt-get; then
        echo "apt"
    elif command_exists pacman; then
        echo "pacman"
    elif command_exists dnf; then
        echo "dnf"
    elif command_exists zypper; then
        echo "zypper"
    elif command_exists nix-env; then
        echo "nix"
    else
        echo "unknown"
    fi
}

# ============================================================
# Dependency Installation
# ============================================================

install_dependencies() {

# Portable file size formatter (replacement for numfmt)
format_size() {
    local size=$1
    local units=("B" "KB" "MB" "GB" "TB")
    local unit=0
    local num=$size
    
    while (( num > 1024 && unit < 4 )); do
        num=$((num / 1024))
        unit=$((unit + 1))
    done
    
    echo "${num}${units[$unit]}"
}

# Optional SHA256 verification if checksum is known
verify_checksum() {
    local file_path="$1"
    local expected_sha256="${CLAUDE_DMG_SHA256:-}"
    
    if [[ -z "$expected_sha256" ]]; then
        log_warn "No SHA256 checksum provided (set CLAUDE_DMG_SHA256=<hash> to verify)"
        log_info "Anthropic does not publish official checksums for Claude Desktop DMG"
        log_info "Download source: $DMG_URL_PRIMARY"
        return 0
    fi
    
    log_info "Verifying SHA256 checksum..."
    local actual_sha256
    if command -v sha256sum >/dev/null 2>&1; then
        actual_sha256=$(sha256sum "$file_path" | awk "{print \$1}")
    elif command -v shasum >/dev/null 2>&1; then
        actual_sha256=$(shasum -a 256 "$file_path" | awk "{print \$1}")
    else
        log_warn "No SHA256 tool available (sha256sum or shasum required)"
        return 0
    fi
    
    if [[ "$actual_sha256" != "$expected_sha256" ]]; then
        die "SHA256 checksum mismatch! Expected: $expected_sha256, Got: $actual_sha256"
    fi
    
    log_success "SHA256 checksum verified"
}

    log_info "Checking dependencies..."

    local pkg_manager
    pkg_manager=$(detect_pkg_manager)
    local missing=()

    # Check each required command
    if ! command_exists 7z; then
        missing+=("7z")
    fi
    if ! command_exists node; then
        missing+=("nodejs")
    fi
    if ! command_exists npm; then
        missing+=("npm")
    fi
    if ! command_exists bwrap; then
        missing+=("bubblewrap")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_info "Missing packages: ${missing[*]}"
        log_warn "The following packages will be installed via your package manager."
        echo ""
        read -r -p "Continue with installation? [Y/n] " response
        response=${response:-Y}
        if [[ ! "$response" =~ ^[Yy]$ ]]; then
            die "Installation cancelled by user"
        fi

        case "$pkg_manager" in
            apt)
                sudo apt-get update -qq
                sudo apt-get install -y p7zip-full nodejs npm bubblewrap
                ;;
            pacman)
                # Install only required packages without system upgrade
                sudo pacman -S --noconfirm --needed p7zip nodejs npm bubblewrap
                ;;
            dnf)
                sudo dnf install -y p7zip nodejs npm bubblewrap
                ;;
            zypper)
                sudo zypper install -y p7zip nodejs npm bubblewrap
                ;;
            nix)
                nix-env -iA nixpkgs.p7zip nixpkgs.nodejs nixpkgs.bubblewrap
                ;;
            *)
                die "Unknown package manager. Please install manually: p7zip nodejs npm bubblewrap"
                ;;
        esac
    fi

    # Install npm packages to user prefix (avoid sudo npm)
    local npm_prefix="${HOME}/.local"
    mkdir -p "$npm_prefix"

    if ! command_exists asar; then
        log_info "Installing @electron/asar to $npm_prefix..."
        npm config set prefix "$npm_prefix" 2>/dev/null || true
        npm install --silent -g @electron/asar || die "Failed to install asar. Try: npm install -g @electron/asar"
        export PATH="$npm_prefix/bin:$PATH"
    fi

    if ! command_exists electron; then
        log_info "Installing electron to $npm_prefix..."
        npm config set prefix "$npm_prefix" 2>/dev/null || true
        npm install --silent -g electron || die "Failed to install electron. Try: npm install -g electron"
        export PATH="$npm_prefix/bin:$PATH"
    fi

    # Verify all dependencies
    local all_ok=true
    for cmd in 7z node npm asar electron bwrap; do
        if command_exists "$cmd"; then
            log_success "Found: $cmd"
        else
            log_error "Missing: $cmd"
            all_ok=false
        fi
    done

    if [[ "$all_ok" != "true" ]]; then
        die "Some dependencies could not be installed"
    fi

    # Check Node.js version
    local node_version
    node_version=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ "$node_version" -lt 18 ]]; then
        die "Node.js 18+ required, found v$node_version"
    fi
    log_success "Node.js version OK (v$node_version)"
}

# ============================================================
# Download Claude DMG
# ============================================================

download_dmg() {
    local dmg_path="$1"

    # Validate user-provided DMG path (prevent path traversal)
    if [[ -n "${CLAUDE_DMG:-}" ]]; then
        # Resolve to absolute path and check it exists
        local resolved_path
        resolved_path=$(realpath -e "$CLAUDE_DMG" 2>/dev/null) || die "User-provided DMG not found: $CLAUDE_DMG"

        # Verify it's a regular file
        if [[ ! -f "$resolved_path" ]]; then
            die "CLAUDE_DMG must be a regular file: $CLAUDE_DMG"
        fi

        # Basic sanity check - must end in .dmg
        if [[ ! "$resolved_path" =~ \.dmg$ ]]; then
            log_warn "File does not have .dmg extension: $CLAUDE_DMG"
            read -r -p "Continue anyway? [y/N] " response
            if [[ ! "$response" =~ ^[Yy]$ ]]; then
                die "Installation cancelled"
            fi
        fi

        log_info "Using user-provided DMG: $resolved_path"
        cp "$resolved_path" "$dmg_path"
        return 0
    fi

    # Check current directory for existing DMG (safely)
    local existing_dmg=""
    while IFS= read -r -d $'\0' file; do
        existing_dmg="$file"
        break
    done < <(find . -maxdepth 1 \( -name "Claude*.dmg" -o -name "claude*.dmg" \) -type f -print0 2>/dev/null)

    if [[ -n "$existing_dmg" ]]; then
        log_info "Found existing DMG: $existing_dmg"
        read -r -p "Use this DMG? [Y/n] " response
        response=${response:-Y}
        if [[ "$response" =~ ^[Yy]$ ]]; then
            cp "$existing_dmg" "$dmg_path"
            return 0
        fi
    fi

    log_info "Downloading Claude Desktop from Anthropic's official CDN..."
    log_info "Source: $DMG_URL_PRIMARY"
    echo ""

    # Try primary URL first
    if curl -fSL --progress-bar -o "$dmg_path" "$DMG_URL_PRIMARY" 2>/dev/null; then
        log_success "Downloaded from primary CDN"
    elif curl -fSL --progress-bar -o "$dmg_path" "$DMG_URL_FALLBACK" 2>/dev/null; then
        log_success "Downloaded from fallback URL"
    else
        log_error "Failed to download Claude DMG"
        log_info ""
        log_info "Manual download instructions:"
        log_info "  1. Visit https://claude.ai/download"
        log_info "  2. Download the macOS version"
        log_info "  3. Re-run with: CLAUDE_DMG=/path/to/Claude.dmg $0"
        exit 1
    fi

    # Verify download size (minimum 100MB for valid DMG)
    local dmg_size
    dmg_size=$(stat -c%s "$dmg_path" 2>/dev/null || stat -f%z "$dmg_path" 2>/dev/null || echo 0)
    if [[ ! -f "$dmg_path" ]] || [[ "$dmg_size" -lt "$MIN_DMG_SIZE" ]]; then
        die "Download appears incomplete or corrupted (size: ${dmg_size} bytes, expected >100MB)"
    fi
    log_success "Download verified ($(format_size "$dmg_size"))"
    
    # Optional SHA256 verification
    verify_checksum "$dmg_path"
}

# ============================================================
# Extract and Patch App
# ============================================================

extract_app() {
    local dmg_path="$1"
    local extract_dir="$2"

    log_info "Extracting DMG..." >&2
    7z x -y -o"$extract_dir" "$dmg_path" >/dev/null 2>&1 || die "Failed to extract DMG"

    # Find Claude.app
    local claude_app
    claude_app=$(find "$extract_dir" -name "Claude.app" -type d | head -1)
    if [[ -z "$claude_app" ]]; then
        die "Claude.app not found in DMG"
    fi

    log_success "Extracted Claude.app" >&2
    echo "$claude_app"
}

extract_asar() {
    local claude_app="$1"
    local app_extract_dir="$2"

    local asar_file="$claude_app/Contents/Resources/app.asar"
    if [[ ! -f "$asar_file" ]]; then
        die "app.asar not found"
    fi

    log_info "Extracting app.asar..."
    asar extract "$asar_file" "$app_extract_dir" || die "Failed to extract app.asar"
    log_success "Extracted app code"
}

# ============================================================
# Download Linux Stubs
# ============================================================

download_swift_stub() {
    local stub_dir="$1"
    mkdir -p "$stub_dir"
    local local_stub="$SCRIPT_DIR/stubs/@ant/claude-swift/js/index.js"
    if [[ -f "$local_stub" ]]; then
        cp "$local_stub" "$stub_dir/index.js" || die "Failed to copy local Swift stub"
        log_success "Copied Swift stub from local repo"
    else
        curl -fsSL "$SWIFT_STUB_URL" -o "$stub_dir/index.js" || die "Failed to download Swift stub"
        log_success "Downloaded Swift stub"
    fi
}

download_native_stub() {
    local stub_dir="$1"
    mkdir -p "$stub_dir"
    local local_stub="$SCRIPT_DIR/stubs/@ant/claude-native/index.js"
    if [[ -f "$local_stub" ]]; then
        cp "$local_stub" "$stub_dir/index.js" || die "Failed to copy local Native stub"
        log_success "Copied Native stub from local repo"
    else
        curl -fsSL "$NATIVE_STUB_URL" -o "$stub_dir/index.js" || die "Failed to download Native stub"
        log_success "Downloaded Native stub"
    fi
}

# ============================================================
# Create Linux Loader
# ============================================================

create_linux_loader() {
    local resources_dir="$1"
    local local_loader="$SCRIPT_DIR/linux-loader.js"

    if [[ -f "$local_loader" ]]; then
        sudo cp "$local_loader" "$resources_dir/linux-loader.js"
        sudo chmod +x "$resources_dir/linux-loader.js"
        log_success "Copied Linux loader from local repo"
    else
        die "linux-loader.js not found at $local_loader"
    fi
}

# ============================================================
# Create Launch Script
# ============================================================

create_launcher() {
    local macos_dir="$1"

    sudo tee "$macos_dir/Claude" > /dev/null << 'LAUNCHER'
#!/bin/bash
# Claude launcher script

SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done

SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../Resources"
cd "$RESOURCES_DIR"

ELECTRON_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --debug) export CLAUDE_TRACE=1 ;;
    --devtools) ELECTRON_ARGS+=("--inspect") ;;
    --isolate-network) export CLAUDE_ISOLATE_NETWORK=1 ;;
    *) ELECTRON_ARGS+=("$arg") ;;
  esac
done

export ELECTRON_ENABLE_LOGGING=1

# Add mise shims to PATH (for mise-managed electron/node)
if [[ -d "$HOME/.local/share/mise/shims" ]]; then
  export PATH="$HOME/.local/share/mise/shims:$PATH"
fi

# Wayland support for Hyprland, Sway, and other Wayland compositors
if [[ -n "$WAYLAND_DISPLAY" ]] || [[ "$XDG_SESSION_TYPE" == "wayland" ]]; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
fi

# Launch Electron
exec electron linux-loader.js "${ELECTRON_ARGS[@]}" 2>&1 | tee -a ~/Library/Logs/Claude/startup.log
LAUNCHER

    sudo chmod +x "$macos_dir/Claude"
    log_success "Created launcher script"
}

# ============================================================
# Install Application
# ============================================================

confirm_sudo_operations() {
    echo ""
    log_warn "The following operations require sudo (root) privileges:"
    echo "  - Create directory: $INSTALL_DIR"
    echo "  - Copy application files to $INSTALL_DIR"
    echo "  - Create symlink: /usr/local/bin/claude"
    echo ""
    read -r -p "Proceed with installation? [Y/n] " response
    response=${response:-Y}
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        die "Installation cancelled by user"
    fi
}

install_app() {
    local claude_app="$1"
    local app_extract_dir="$2"

    # Show what sudo operations will be performed
    confirm_sudo_operations

    log_info "Installing to $INSTALL_DIR..."

    # Remove old installation (with safety check)
    if [[ -d "$INSTALL_DIR" ]]; then
        log_info "Removing previous installation..."
        sudo rm -rf "$INSTALL_DIR"
    fi

    # Create directory structure
    sudo mkdir -p "$INSTALL_DIR/Contents/"{MacOS,Resources,Frameworks}

    # Copy extracted app code
    sudo cp -r "$app_extract_dir" "$INSTALL_DIR/Contents/Resources/app"

    # Copy resources from original app
    sudo cp -r "$claude_app/Contents/Resources/"* "$INSTALL_DIR/Contents/Resources/" 2>/dev/null || true

    # Create and install stubs
    local stub_swift_dir="$INSTALL_DIR/Contents/Resources/stubs/@ant/claude-swift/js"
    local stub_native_dir="$INSTALL_DIR/Contents/Resources/stubs/@ant/claude-native"

    sudo mkdir -p "$stub_swift_dir" "$stub_native_dir"

    # Download stubs from repo then copy
    download_swift_stub "$WORK_DIR/stubs/swift"
    download_native_stub "$WORK_DIR/stubs/native"

    sudo cp "$WORK_DIR/stubs/swift/index.js" "$stub_swift_dir/index.js"
    sudo cp "$WORK_DIR/stubs/native/index.js" "$stub_native_dir/index.js"

    # Replace original modules with stubs (detect actual module paths)
    local app_modules="$INSTALL_DIR/Contents/Resources/app/node_modules"
    local swift_targets=("$app_modules/@ant/claude-swift/js" "$app_modules/@anthropic-ai/claude-swift/js")
    local native_targets=("$app_modules/@ant/claude-native" "$app_modules/claude-native")

    for target in "${swift_targets[@]}"; do
        if [[ -d "$target" ]]; then
            sudo cp "$WORK_DIR/stubs/swift/index.js" "$target/index.js"
            log_success "Replaced swift stub in $target"
        fi
    done

    for target in "${native_targets[@]}"; do
        if [[ -d "$target" ]]; then
            sudo cp "$WORK_DIR/stubs/native/index.js" "$target/index.js"
            log_success "Replaced native stub in $target"
        fi
    done

    # Create Linux loader
    create_linux_loader "$INSTALL_DIR/Contents/Resources"

    # Patch EIPC UUID in linux-loader.js to match the app bundle
    local loader_js="$INSTALL_DIR/Contents/Resources/linux-loader.js"
    local bundle_index="$INSTALL_DIR/Contents/Resources/app/.vite/build/index.js"
    if [[ -f "$loader_js" ]] && [[ -f "$bundle_index" ]]; then
        local bundle_uuid
        bundle_uuid=$(grep -oP '\$eipc_message\$_\K[a-f0-9-]{36}' "$bundle_index" | head -1 || true)
        if [[ -n "$bundle_uuid" ]]; then
            sudo sed -i "s/c42e5915-d1f8-48a1-a373-fe793971fdbd/$bundle_uuid/g" "$loader_js"
            log_success "Patched EIPC UUID to $bundle_uuid"
        else
            log_warn "Could not extract EIPC UUID from bundle"
        fi
    fi

    # Disable EIPC origin validation for file:// URLs
    # The app's EIPC handlers validate senderFrame.parent === null, which fails
    # for our file:// renderer pages. Multiple minified copies exist with
    # different function names (e.g. ki, _C), so use a general regex.
    if [[ -f "$bundle_index" ]]; then
        local val_count
        val_count=$(grep -cP 'function \w+\(t\)\{var e;return\(\(e=t\.senderFrame\)==null\?void 0:e\.parent\)===null\}' "$bundle_index" || true)
        if [[ "$val_count" -gt 0 ]]; then
            sudo sed -i -E 's/function ([a-zA-Z_$][a-zA-Z0-9_$]*)\(t\)\{var e;return\(\(e=t\.senderFrame\)==null\?void 0:e\.parent\)===null\}/function \1(t){return true}/g' "$bundle_index"
            log_success "Patched $val_count EIPC origin validation function(s)"
        else
            log_warn "No EIPC origin validation functions found (non-fatal)"
        fi
    fi

    # Apply Cowork enablement patch
    local cowork_patch="$SCRIPT_DIR/patches/enable-cowork.py"
    local bundle_index="$INSTALL_DIR/Contents/Resources/app/.vite/build/index.js"
    if [[ -f "$cowork_patch" ]] && [[ -f "$bundle_index" ]]; then
        log_info "Applying Cowork enablement patch..."
        sudo python3 "$cowork_patch" "$bundle_index" || log_warn "Cowork patch failed (non-fatal)"
    fi

    # Inject Cowork IPC bridges into mainView.js preload
    # Newer bundles removed ClaudeVM/YukonSilver bridges from the preload,
    # so the web code cannot communicate Cowork state to the main process.
    local bridge_patch="$SCRIPT_DIR/patches/inject-cowork-bridge.py"
    local mainview_js="$INSTALL_DIR/Contents/Resources/app/.vite/build/mainView.js"
    if [[ -f "$bridge_patch" ]] && [[ -f "$mainview_js" ]]; then
        log_info "Injecting Cowork IPC bridges into preload..."
        sudo python3 "$bridge_patch" "$mainview_js" || log_warn "Cowork bridge injection failed (non-fatal)"
    fi

    # Copy frame-fix files into app/ and symlink linux-app-extracted -> app
    # linux-loader.js requires ./linux-app-extracted/frame-fix-entry.js
    # frame-fix-entry.js requires ./.vite/build/index.js (relative to itself)
    local app_dir="$INSTALL_DIR/Contents/Resources/app"
    local local_frame_fix="$SCRIPT_DIR/stubs/frame-fix"
    if [[ -d "$local_frame_fix" ]] && [[ -d "$app_dir" ]]; then
        sudo cp "$local_frame_fix/frame-fix-entry.js" "$app_dir/frame-fix-entry.js"
        sudo cp "$local_frame_fix/frame-fix-wrapper.js" "$app_dir/frame-fix-wrapper.js"
        sudo ln -sfn app "$INSTALL_DIR/Contents/Resources/linux-app-extracted"
        log_success "Copied frame-fix files and created linux-app-extracted symlink"
    else
        die "frame-fix stubs or app dir not found"
    fi

    # Symlink i18n locale files into app/resources/i18n/
    # The app expects them at app/resources/i18n/*.json but asar extracts them to Resources/*.json
    local i18n_dir="$INSTALL_DIR/Contents/Resources/app/resources/i18n"
    sudo mkdir -p "$i18n_dir"
    for f in "$INSTALL_DIR/Contents/Resources"/*.json; do
        [[ -f "$f" ]] && sudo ln -sf "$f" "$i18n_dir/$(basename "$f")"
    done
    log_success "Linked i18n locale files"

    # Symlink .vite/build/ into Resources/ for preload scripts
    # Electron resolves preload paths relative to Resources/, not Resources/app/
    sudo ln -sfn app/.vite "$INSTALL_DIR/Contents/Resources/.vite"
    log_success "Linked .vite preload scripts"

    # Create launcher
    create_launcher "$INSTALL_DIR/Contents/MacOS"

    # Create symlink in PATH
    sudo ln -sf "$INSTALL_DIR/Contents/MacOS/Claude" /usr/local/bin/claude-desktop

    log_success "Installed to $INSTALL_DIR"
}

# ============================================================
# Setup User Environment
# ============================================================

setup_user_dirs() {
    log_info "Setting up user directories..."

    # Create macOS-style directories
    mkdir -p "$USER_DATA_DIR"/{Projects,Conversations,"Claude Extensions","Claude Extensions Settings",claude-code-vm,vm_bundles,blob_storage}
    mkdir -p "$USER_LOG_DIR"
    mkdir -p "$USER_CACHE_DIR"
    mkdir -p ~/Library/Preferences

    # Create default configs if not exist
    if [[ ! -f "$USER_DATA_DIR/config.json" ]]; then
        cat > "$USER_DATA_DIR/config.json" << 'EOF'
{
  "scale": 0,
  "locale": "en-US",
  "userThemeMode": "system",
  "hasTrackedInitialActivation": false
}
EOF
    fi

    if [[ ! -f "$USER_DATA_DIR/claude_desktop_config.json" ]]; then
        cat > "$USER_DATA_DIR/claude_desktop_config.json" << 'EOF'
{
  "preferences": {
    "chromeExtensionEnabled": true
  }
}
EOF
    fi

    # Set permissions
    chmod 700 "$USER_DATA_DIR" "$USER_LOG_DIR" "$USER_CACHE_DIR"

    log_success "User directories created"
}

# ============================================================
# Create Desktop Entry
# ============================================================

create_desktop_entry() {
    log_info "Creating desktop entry..."

    mkdir -p ~/.local/share/applications

    cat > ~/.local/share/applications/claude.desktop << EOF
[Desktop Entry]
Type=Application
Name=Claude
Comment=AI assistant by Anthropic
Exec=/usr/local/bin/claude
Icon=$INSTALL_DIR/Contents/Resources/icon.icns
Terminal=false
Categories=Utility;Development;Chat;
Keywords=AI;assistant;chat;anthropic;
StartupWMClass=Claude
EOF

    chmod +x ~/.local/share/applications/claude.desktop

    if command_exists update-desktop-database; then
        update-desktop-database ~/.local/share/applications 2>/dev/null || true
    fi

    log_success "Desktop entry created"
}

# ============================================================
# Main Installation Flow
# ============================================================

main() {
    echo ""
    echo "=========================================="
    echo " Claude Desktop for Linux - Installer"
    echo " Version: $VERSION"
    echo "=========================================="
    echo ""

    # Check if running as root (bad idea)
    if [[ $EUID -eq 0 ]]; then
        die "Do not run as root. The script will use sudo when needed."
    fi

    # Step 1: Dependencies
    install_dependencies
    echo ""

    # Step 2: Download DMG
    local dmg_path="$WORK_DIR/Claude.dmg"
    download_dmg "$dmg_path"
    echo ""

    # Step 3: Extract
    local extract_dir="$WORK_DIR/extract"
    local claude_app
    claude_app=$(extract_app "$dmg_path" "$extract_dir")
    echo ""

    # Step 4: Extract app.asar
    local app_extract_dir="$WORK_DIR/app-extracted"
    extract_asar "$claude_app" "$app_extract_dir"
    echo ""

    # Step 5: Install
    install_app "$claude_app" "$app_extract_dir"
    echo ""

    # Step 6: User setup
    setup_user_dirs
    echo ""

    # Step 7: Desktop entry
    create_desktop_entry
    echo ""

    # Done!
    echo "=========================================="
    echo -e "${GREEN} Installation Complete!${NC}"
    echo "=========================================="
    echo ""
    echo "Launch Claude Desktop:"
    echo "  Command:  claude-desktop"
    echo "  Desktop:  Search for 'Claude' in app launcher"
    echo ""
    echo "Options:"
    echo "  claude-desktop --debug      Enable trace logging"
    echo "  claude-desktop --devtools   Enable Chrome DevTools"
    echo ""
    echo "Logs: ~/Library/Logs/Claude/startup.log"
    echo ""
}

# Run main
main "$@"
