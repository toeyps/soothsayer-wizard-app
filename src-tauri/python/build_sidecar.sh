#!/usr/bin/env bash
# Build the Python sidecar with Nuitka (--onefile --standalone) into ../bin/backend-<target-triple>.
# Setup: python3 -m venv .venv; source .venv/bin/activate; pip install -r requirements.txt
# Needs: Xcode CLT (macOS), gcc + patchelf (Linux), MSVC Build Tools or WSL (Windows).
#
# MSVC C1002 "out of heap space" on Windows: retry with NUITKA_JOBS=1 _CL_=-Od ./build_sidecar.sh
# (_CL_ is appended after the command line, so -Od beats /Ox without invalidating the object cache;
# use the dash form because Git Bash path conversion mangles a leading `/`).
#
# The engine only runs SIGNED lines (`<unix seconds> <hex HMAC-SHA256> <request JSON>`), so a bare
# JSON line answers "Request refused.". Smoke test: sign one with backend.py's own key:
#   python -c 'import sys,time,backend as b; body=b"{\"action\":\"preview_relationship\",\"payload\":{\"predictors\":[\"P1\"],\"target\":\"T\",\"X\":[[1],[2],[3],[4]],\"y\":[2,4,6,8],\"smoothing\":1}}"; ts=str(int(time.time())).encode(); sys.stdout.buffer.write(ts+b" "+b._signature(ts,body)+b" "+body+b"\n")' \
#     | ../bin/backend-$(rustc -vV | sed -n 's/host: //p')

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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

python -c "import numpy, pygam, nuitka" || {
    echo "[build_sidecar] Missing required packages. Run: pip install -r requirements.txt"
    exit 1
}

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

# --assume-yes-for-downloads: on Windows Nuitka otherwise prompts for Dependency Walker, which
# defaults to "no" in non-interactive CI. --jobs is omitted (all cores); set NUITKA_JOBS to limit it.
mkdir -p build
NUITKA_JOBS_FLAG=""
if [[ -n "${NUITKA_JOBS:-}" ]]; then
    NUITKA_JOBS_FLAG="--jobs=${NUITKA_JOBS}"
fi
# NUITKA_EXTRA_FLAGS: extra Nuitka flags, e.g. --low-memory when MSVC hits C1002.
# --disable-ccache: on Windows the bundled clcache passes the unquoted cl.exe path and the compile
# dies with C1083 "Cannot open source file: 'C:/Program'".
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
