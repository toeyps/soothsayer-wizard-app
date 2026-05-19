#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# Build Soothsayer-Wizard installer for macOS Intel (x86_64).
#
# Run on a real Intel Mac (or an arm64 Mac running this script under Rosetta
# `arch -x86_64 bash scripts/build-installer-mac-x64.sh` — but the simpler,
# more reliable path is to run it on a native Intel Mac).
#
# The Python sidecar must be Mach-O x86_64 — Nuitka cross-compile from arm64
# is unreliable for the numpy/scipy stack, so the script refuses to run on a
# non-Intel host unless TIDE_FORCE_ROSETTA=1 is set (advanced; you own it).
#
# Prerequisites:
#   - macOS on x86_64 (Intel) — OR arm64 + Rosetta + TIDE_FORCE_ROSETTA=1
#   - Xcode Command Line Tools
#   - Rust toolchain with x86_64-apple-darwin target
#   - Node.js 18+ / npm
#   - Python 3.11+ (Intel build — Rosetta python if forcing on arm64 host)
#
# Output:
#   src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/
#     Soothsayer-Wizard_<version>_x64.dmg
# ──────────────────────────────────────────────────────────────────────────

set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RED=$'\033[31m'; BLUE=$'\033[34m'; RESET=$'\033[0m'

step()  { printf "\n${BOLD}${BLUE}▶ %s${RESET}\n" "$*"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "  ${YELLOW}⚠${RESET} %s\n" "$*"; }
fail()  { printf "\n${BOLD}${RED}✗ %s${RESET}\n" "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TARGET="x86_64-apple-darwin"
START_TS=$(date +%s)

# ─── 1. Prerequisites ─────────────────────────────────────────────────────
step "1/5  Checking prerequisites"

[[ "$(uname -s)" == "Darwin" ]] || fail "This script must run on macOS. Detected: $(uname -s)"

HOST_ARCH="$(uname -m)"
if [[ "$HOST_ARCH" != "x86_64" ]]; then
    if [[ "${TIDE_FORCE_ROSETTA:-0}" == "1" ]]; then
        warn "Running on $HOST_ARCH with TIDE_FORCE_ROSETTA=1 — proceeding under Rosetta. You're on your own if numpy/scipy compile fails."
    else
        fail "This script needs an Intel Mac (x86_64 host). Detected: $HOST_ARCH.

  ${DIM}Options:${RESET}
    1. Run on a real Intel Mac (recommended)
    2. Use GitHub Actions CI — it provides an Intel macos-13 runner
    3. Force Rosetta on this arm64 host (advanced — Nuitka cross-builds are
       fragile for the numpy/scipy stack):
         arch -x86_64 env TIDE_FORCE_ROSETTA=1 bash scripts/build-installer-mac-x64.sh"
    fi
fi
ok "macOS host ($HOST_ARCH)"

xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools missing. Install with: xcode-select --install"
ok "Xcode Command Line Tools"

command -v rustc >/dev/null  || fail "Rust toolchain missing. Install from https://rustup.rs"
ok "Rust $(rustc --version | awk '{print $2}')"

if ! rustup target list --installed 2>/dev/null | grep -q "^${TARGET}$"; then
    warn "Rust target ${TARGET} not installed — adding now"
    rustup target add "${TARGET}"
fi
ok "Rust target ${TARGET}"

command -v node >/dev/null   || fail "Node.js missing. Install from https://nodejs.org (v18+)"
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[[ "$NODE_MAJOR" -ge 18 ]] || fail "Node.js v${NODE_MAJOR} is too old. Need v18+."
ok "Node.js $(node -v)"

PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null; then
        PYV=$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        PYMAJ=${PYV%%.*}; PYMIN=${PYV##*.}
        if [[ "$PYMAJ" -eq 3 && "$PYMIN" -ge 11 ]]; then
            PYTHON_BIN="$candidate"; break
        fi
    fi
done
[[ -n "$PYTHON_BIN" ]] || fail "Python 3.11+ missing. Install via: brew install python@3.11"
ok "Python $($PYTHON_BIN --version | awk '{print $2}') ($PYTHON_BIN)"

# ─── 2. npm install ───────────────────────────────────────────────────────
step "2/5  Installing npm dependencies"
if [[ -d node_modules && -f node_modules/.package-lock.json ]] \
   && [[ node_modules/.package-lock.json -nt package-lock.json ]]; then
    ok "node_modules up to date (skip)"
else
    npm ci --no-audit --no-fund
    ok "npm ci complete"
fi

# ─── 3. Python sidecar ────────────────────────────────────────────────────
step "3/5  Building Python sidecar (Nuitka)"
SIDECAR="src-tauri/bin/backend-${TARGET}"
if [[ -f "$SIDECAR" ]]; then
    SIZE=$(du -h "$SIDECAR" | awk '{print $1}')
    # Verify the existing binary really is x86_64 — if a previous arm64 run
    # left a binary with this name it would still pass this check naively.
    if file "$SIDECAR" | grep -q "x86_64"; then
        warn "Sidecar already exists ($SIZE, x86_64) — skipping rebuild"
        warn "Force rebuild with: rm $SIDECAR && $0"
    else
        warn "Existing $SIDECAR is NOT x86_64 — deleting and rebuilding"
        rm -f "$SIDECAR"
    fi
fi

if [[ ! -f "$SIDECAR" ]]; then
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
    file "$SIDECAR" | grep -q "x86_64" || fail "Built sidecar is not x86_64 — Rosetta env probably bypassed. Aborting."
    ok "Sidecar built ($(du -h "$SIDECAR" | awk '{print $1}'), x86_64)"
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
printf "\n  ${DIM}Open the DMG with:${RESET}  open '%s'\n\n" "$DMG_PATH"
