#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Build Soothsayer-Wizard installer for macOS Apple Silicon (arm64).
#
# Run on a Mac with an M-series chip (M1/M2/M3/M4). The script is idempotent
# — re-running skips work that is already done (npm deps, sidecar binary).
#
# Prerequisites (the script verifies each and bails with instructions if
# missing):
#   - macOS on arm64 (Apple Silicon)
#   - Xcode Command Line Tools
#   - Rust toolchain (rustup) with aarch64-apple-darwin target
#   - Node.js 18+ / npm
#   - Python 3.11+
#
# Output:
#   src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/
#     Soothsayer-Wizard_<version>_aarch64.dmg
#   src-tauri/target/aarch64-apple-darwin/release/bundle/macos/
#     Soothsayer-Wizard.app
#
# Expected runtime: 10–15 min cold (mostly Nuitka), <2 min warm (cached).
# ──────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Pretty output ────────────────────────────────────────────────────────
BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
BLUE=$'\033[34m'
RESET=$'\033[0m'

step()  { printf "\n${BOLD}${BLUE}▶ %s${RESET}\n" "$*"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "  ${YELLOW}⚠${RESET} %s\n" "$*"; }
fail()  { printf "\n${BOLD}${RED}✗ %s${RESET}\n" "$*" >&2; exit 1; }

# ─── Resolve repo root regardless of cwd ──────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TARGET="aarch64-apple-darwin"
START_TS=$(date +%s)

# ─── 1. Prerequisites ─────────────────────────────────────────────────────
step "1/5  Checking prerequisites"

[[ "$(uname -s)" == "Darwin" ]] || fail "This script must run on macOS. Detected: $(uname -s)"
[[ "$(uname -m)" == "arm64"  ]] || fail "This script requires Apple Silicon (arm64). Detected arch: $(uname -m). Use build-installer-mac-x64.sh instead."
ok "macOS arm64 host"

xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools missing. Install with: xcode-select --install"
ok "Xcode Command Line Tools"

command -v rustc >/dev/null  || fail "Rust toolchain missing. Install from https://rustup.rs"
command -v cargo >/dev/null  || fail "Cargo missing (Rust toolchain broken)"
ok "Rust $(rustc --version | awk '{print $2}')"

if ! rustup target list --installed 2>/dev/null | grep -q "^${TARGET}$"; then
    warn "Rust target ${TARGET} not installed — adding now"
    rustup target add "${TARGET}"
fi
ok "Rust target ${TARGET}"

command -v node >/dev/null   || fail "Node.js missing. Install from https://nodejs.org (v18+)"
command -v npm  >/dev/null   || fail "npm missing"
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[[ "$NODE_MAJOR" -ge 18 ]] || fail "Node.js v${NODE_MAJOR} is too old. Need v18+."
ok "Node.js $(node -v)"

PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null; then
        PYV=$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        PYMAJ=${PYV%%.*}
        PYMIN=${PYV##*.}
        if [[ "$PYMAJ" -eq 3 && "$PYMIN" -ge 11 ]]; then
            PYTHON_BIN="$candidate"
            break
        fi
    fi
done
[[ -n "$PYTHON_BIN" ]] || fail "Python 3.11+ missing. Install via: brew install python@3.11"
ok "Python $($PYTHON_BIN --version | awk '{print $2}') ($PYTHON_BIN)"

# ─── 2. npm install (only if needed) ──────────────────────────────────────
step "2/5  Installing npm dependencies"
if [[ -d node_modules && -f node_modules/.package-lock.json ]] \
   && [[ node_modules/.package-lock.json -nt package-lock.json ]]; then
    ok "node_modules up to date (skip)"
else
    npm ci --no-audit --no-fund
    ok "npm ci complete"
fi

# ─── 3. Python sidecar (only if missing) ──────────────────────────────────
step "3/5  Building Python sidecar (Nuitka)"
SIDECAR="src-tauri/bin/backend-${TARGET}"
if [[ -f "$SIDECAR" ]]; then
    SIZE=$(du -h "$SIDECAR" | awk '{print $1}')
    warn "Sidecar already exists ($SIZE) — skipping rebuild"
    warn "Force rebuild with: rm $SIDECAR && $0"
else
    pushd src-tauri/python >/dev/null
    if [[ ! -d .venv ]]; then
        warn "No .venv found — creating one with $PYTHON_BIN"
        "$PYTHON_BIN" -m venv .venv
        source .venv/bin/activate
        python -m pip install --upgrade pip
        python -m pip install -r requirements.txt
    else
        source .venv/bin/activate
        if ! python -c "import nuitka, numpy, pygam" 2>/dev/null; then
            warn ".venv exists but missing packages — reinstalling"
            python -m pip install -r requirements.txt
        fi
    fi
    chmod +x ./build_sidecar.sh
    ./build_sidecar.sh
    deactivate
    popd >/dev/null
    [[ -f "$SIDECAR" ]] || fail "Sidecar build finished but $SIDECAR is missing"
    ok "Sidecar built ($(du -h "$SIDECAR" | awk '{print $1}'))"
fi

# ─── 4. Tauri build ───────────────────────────────────────────────────────
step "4/5  Building Tauri app + DMG installer"
npm run tauri -- build --target "${TARGET}"

# ─── 5. Locate + report installer ─────────────────────────────────────────
step "5/5  Locating installer"
DMG_DIR="src-tauri/target/${TARGET}/release/bundle/dmg"
APP_DIR="src-tauri/target/${TARGET}/release/bundle/macos"
DMG_PATH=$(ls -t "$DMG_DIR"/*.dmg 2>/dev/null | head -1 || true)
APP_PATH=$(ls -dt "$APP_DIR"/*.app 2>/dev/null | head -1 || true)

[[ -n "$DMG_PATH" ]] || fail "No .dmg found in $DMG_DIR"

ELAPSED=$(( $(date +%s) - START_TS ))
MM=$((ELAPSED / 60)); SS=$((ELAPSED % 60))

printf "\n${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}${GREEN}  Build complete in ${MM}m ${SS}s${RESET}\n"
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "  ${BOLD}DMG installer:${RESET}\n    %s  ${DIM}(%s)${RESET}\n" \
       "$DMG_PATH" "$(du -h "$DMG_PATH" | awk '{print $1}')"
if [[ -n "$APP_PATH" ]]; then
    printf "  ${BOLD}App bundle:${RESET}\n    %s\n" "$APP_PATH"
fi
printf "\n  ${DIM}Open the DMG with:${RESET}  open '%s'\n" "$DMG_PATH"
printf "\n  ${YELLOW}Note:${RESET} unsigned build — first launch will warn about\n"
printf "  ${YELLOW}     ${RESET} an unidentified developer. Right-click → Open to bypass.\n\n"
