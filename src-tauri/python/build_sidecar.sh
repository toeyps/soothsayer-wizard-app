#!/usr/bin/env bash
# Build the Soothsayer-Wizard Python sidecar with Nuitka.
#
# This script is intentionally small and dependency-light so it runs the same
# way on macOS / Linux / WSL. It compiles `backend.py` into a single-file
# executable (--onefile + --standalone) and copies the artifact into the
# Tauri sidecar directory `../bin/backend-<target-triple>` so
# `tauri.conf.json` can pick it up.
#
# ── Prerequisites ───────────────────────────────────────────────────────
# macOS:
#   1. Xcode Command Line Tools:  xcode-select --install
#   2. Python 3.11+ (Homebrew or python.org installer)
#   3. (recommended) ccache:      brew install ccache
# Linux:
#   gcc, patchelf, python3.11+
# Windows / WSL:
#   MSVC Build Tools (Visual Studio 2022) or use WSL Ubuntu.
#
# ── First-time setup ────────────────────────────────────────────────────
# From this directory:
#   python3 -m venv .venv
#   source .venv/bin/activate
#   pip install -U pip
#   pip install -r requirements.txt
#
# ── Run the build ───────────────────────────────────────────────────────
#   ./build_sidecar.sh
#
# Expected runtime: 8–12 minutes on M-series Mac (cold build), 2–3 minutes
# with ccache warm. Output binary should be < 200 MB.
#
# Windows, MSVC dies with `C1002: compiler is out of heap space` on the
# giant generated scipy constant-table modules (each cl.exe wants ~5-7GB
# of free commit at /Ox): retry as
#   NUITKA_JOBS=1 _CL_=-Od ./build_sidecar.sh
# `_CL_` is appended by cl.exe after the command line, so -Od overrides
# /Ox for the retry without invalidating the scons object cache. The dash
# form matters under Git Bash: MSYS path conversion mangles values that
# start with `/` (`/Od` → `C:/Program Files/Git/Od`).
#
# Verify with a smoke test:
#   echo '{"action":"preview_relationship","payload":{"predictors":["P1"],"target":"T","X":[[1],[2],[3],[4]],"y":[2,4,6,8],"linearGAM_lambda":1}}' \
#     | ../bin/backend-$(rustc -vV | sed -n 's/host: //p')

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1) Activate the venv if present.
if [[ -f ".venv/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source ".venv/bin/activate"
elif [[ -f ".venv/Scripts/activate" ]]; then
    # shellcheck disable=SC1091
    source ".venv/Scripts/activate"
else
    echo "[build_sidecar] WARNING: no .venv found in $SCRIPT_DIR"
    echo "[build_sidecar] Falling back to system python — install requirements first:"
    echo "[build_sidecar]   python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
fi

# 2) Sanity-check critical deps.
python -c "import numpy, pygam, nuitka" || {
    echo "[build_sidecar] Missing required packages. Run: pip install -r requirements.txt"
    exit 1
}

# 3) Resolve the Rust target triple for the output filename.
if command -v rustc >/dev/null 2>&1; then
    TARGET_TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
else
    echo "[build_sidecar] rustc not found — falling back to uname-derived triple"
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64)   TARGET_TRIPLE="aarch64-apple-darwin" ;;
        Darwin-x86_64)  TARGET_TRIPLE="x86_64-apple-darwin" ;;
        Linux-x86_64)   TARGET_TRIPLE="x86_64-unknown-linux-gnu" ;;
        *)              echo "[build_sidecar] Unknown platform; set TARGET_TRIPLE manually."; exit 1 ;;
    esac
fi
echo "[build_sidecar] target triple: $TARGET_TRIPLE"

# 4) Run Nuitka with the proven-safer flag set for scientific stacks.
#    --assume-yes-for-downloads is required on Windows (Nuitka prompts to
#    download Dependency Walker for --standalone/--onefile; in non-interactive
#    CI the prompt defaults to "no" → fatal). On macOS/Linux it is a no-op.
#    --jobs defaults to the number of available cores when omitted; GitHub
#    Actions runners have 4 vCPUs, so dropping the explicit `--jobs=2` ~2x's
#    the build on CI. Override with NUITKA_JOBS env var if you need to limit
#    parallelism on a memory-constrained machine.
mkdir -p build
NUITKA_JOBS_FLAG=""
if [[ -n "${NUITKA_JOBS:-}" ]]; then
    NUITKA_JOBS_FLAG="--jobs=${NUITKA_JOBS}"
fi
# NUITKA_EXTRA_FLAGS: optional space-separated extra Nuitka flags for
# machine-specific tuning. Known use: `--low-memory` when MSVC dies with
# `C1002: compiler is out of heap space` on the giant generated scipy
# constant-table modules (each cl.exe needs ~5-7GB of free commit at /Ox
# without it).
# --disable-ccache: on Windows, Nuitka's bundled clcache passes the MSVC
# compiler path (`C:\Program Files\Microsoft Visual Studio\...\cl.exe`)
# unquoted, and the compile then dies with `C1083: Cannot open source
# file: 'C:/Program'` (see nuitka-crash-report.xml from the first local
# build attempt). The cache only speeds up REBUILDS and CI runners are
# cold anyway, so disabling costs nothing there and unbreaks local
# Windows builds.
python -m nuitka \
    --assume-yes-for-downloads \
    --disable-ccache \
    --onefile \
    --standalone \
    --enable-plugin=numpy \
    --enable-plugin=anti-bloat \
    --include-package=pygam \
    --include-package=scipy \
    ${NUITKA_JOBS_FLAG} \
    ${NUITKA_EXTRA_FLAGS:-} \
    --lto=no \
    --output-dir=build \
    backend.py

# 5) Copy artifact into the Tauri sidecar path.
SRC_BINARY="build/backend.bin"
[[ -f "build/backend.exe" ]] && SRC_BINARY="build/backend.exe"
[[ -f "build/backend"     ]] && SRC_BINARY="build/backend"

if [[ ! -f "$SRC_BINARY" ]]; then
    echo "[build_sidecar] ERROR: Nuitka did not produce an artifact under build/"
    ls -la build/
    exit 1
fi

DEST_DIR="../bin"
mkdir -p "$DEST_DIR"
DEST_FILE="$DEST_DIR/backend-$TARGET_TRIPLE"
[[ "$TARGET_TRIPLE" == *windows* ]] && DEST_FILE="$DEST_FILE.exe"

cp -f "$SRC_BINARY" "$DEST_FILE"
chmod +x "$DEST_FILE"

echo "[build_sidecar] OK → $DEST_FILE"
ls -la "$DEST_FILE"
