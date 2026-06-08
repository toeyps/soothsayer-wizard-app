# ──────────────────────────────────────────────────────────────────────────
# Build Soothsayer-Wizard installer for Windows x86_64.
#
# Run on a Windows machine in PowerShell:
#   PS> .\scripts\build-installer-windows.ps1
#
# If PowerShell blocks the script, allow it once for this process:
#   PS> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#
# The script is idempotent - re-running skips work that is already done.
#
# Prerequisites (each is verified; the script bails with instructions if missing):
#   - Windows 10/11 (x86_64)
#   - Visual Studio 2022 Build Tools (MSVC C++ workload)
#   - Rust toolchain (rustup) with x86_64-pc-windows-msvc target
#   - Node.js 18+ / npm
#   - Python 3.11+
#   - Git for Windows (provides Git Bash for the sidecar build)
#
# Output:
#   src-tauri\target\x86_64-pc-windows-msvc\release\bundle\
#     nsis\Soothsayer-Wizard_<version>_x64-setup.exe
#     msi\Soothsayer-Wizard_<version>_x64_en-US.msi
#
# Expected runtime: 15–20 min cold, ~3 min warm.
# ──────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

# ─── Pretty output ────────────────────────────────────────────────────────
function Step  ($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Ok    ($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn  ($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Fail  ($msg) { Write-Host "`n[FAIL] $msg" -ForegroundColor Red; exit 1 }

# ─── Resolve repo root regardless of cwd ──────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

$Target   = "x86_64-pc-windows-msvc"
$StartTs  = Get-Date

# ─── 1. Prerequisites ─────────────────────────────────────────────────────
Step "1/5  Checking prerequisites"

if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
    Fail "This script must run on Windows. Detected non-Windows host."
}
Ok "Windows host"

# MSVC: look for cl.exe in PATH OR a known VS install
$msvc = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $msvc) {
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vsWhere) {
        $vsPath = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if (-not $vsPath) {
            Fail "MSVC C++ Build Tools not found. Install Visual Studio 2022 Build Tools with the 'Desktop development with C++' workload."
        }
        Ok "MSVC found at $vsPath"
    } else {
        Fail "MSVC not in PATH and vswhere.exe missing. Open a 'Developer PowerShell for VS 2022' window and re-run, OR install VS Build Tools."
    }
} else {
    Ok "MSVC cl.exe in PATH"
}

# Rust
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    Fail "Rust toolchain missing. Install from https://rustup.rs"
}
$rustVersion = (rustc --version).Split(" ")[1]
Ok "Rust $rustVersion"

$installedTargets = (rustup target list --installed) -split "`n"
if ($installedTargets -notcontains $Target) {
    Warn "Rust target $Target not installed - adding now"
    rustup target add $Target
}
Ok "Rust target $Target"

# Node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js missing. Install from https://nodejs.org (v18+)"
}
$nodeVer = (node -v).TrimStart("v").Split(".")[0]
if ([int]$nodeVer -lt 18) { Fail "Node.js v$nodeVer too old. Need v18+." }
Ok "Node.js $(node -v)"

# Python
$pythonBin = $null
foreach ($candidate in @("python3.13", "python3.12", "python3.11", "python", "python3")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) {
        $pyVer = & $cmd -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
        $parts = $pyVer.Split(".")
        if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11) {
            $pythonBin = $cmd.Source
            break
        }
    }
}
if (-not $pythonBin) {
    Fail "Python 3.11+ missing. Install from https://www.python.org/downloads/ (check 'Add to PATH')."
}
$pyver = & $pythonBin --version
Ok "$pyver ($pythonBin)"

# Git Bash (needed to run build_sidecar.sh)
# Prefer Git Bash over WSL bash (C:\WINDOWS\system32\bash.exe)
$gitBashPaths = @(
    "C:\Program Files\Git\bin\bash.exe",
    "C:\Program Files\Git\usr\bin\bash.exe",
    "C:\Program Files (x86)\Git\bin\bash.exe"
)
$bashExe = $null
foreach ($p in $gitBashPaths) {
    if (Test-Path $p) { $bashExe = $p; break }
}
if (-not $bashExe) {
    # Fallback: any bash that is NOT the WSL stub
    $found = Get-Command bash -ErrorAction SilentlyContinue
    if ($found -and $found.Source -notlike "*system32*") {
        $bashExe = $found.Source
    }
}
if (-not $bashExe) {
    Fail "Git Bash not found. Install Git for Windows from https://git-scm.com - it ships Git Bash."
}
Ok "Git Bash found at $bashExe"

# ─── 2. npm install ───────────────────────────────────────────────────────
Step "2/5  Installing npm dependencies"
$needNpm = $true
if ((Test-Path "node_modules\.package-lock.json") -and (Test-Path "package-lock.json")) {
    $nm  = (Get-Item "node_modules\.package-lock.json").LastWriteTime
    $pkg = (Get-Item "package-lock.json").LastWriteTime
    if ($nm -gt $pkg) {
        Ok "node_modules up to date (skip)"
        $needNpm = $false
    }
}
if ($needNpm) {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail "npm ci failed" }
    Ok "npm ci complete"
}

# ─── 3. Python sidecar ────────────────────────────────────────────────────
Step "3/5  Building Python sidecar (Nuitka)"
$sidecar = "src-tauri\bin\backend-$Target.exe"

if (Test-Path $sidecar) {
    $size = "{0:N1} MB" -f ((Get-Item $sidecar).Length / 1MB)
    Warn "Sidecar already exists ($size) - skipping rebuild"
    Warn "Force rebuild with: Remove-Item $sidecar; .\scripts\build-installer-windows.ps1"
} else {
    Push-Location "src-tauri\python"
    try {
        if (-not (Test-Path ".venv")) {
            Warn "No .venv found - creating one with $pythonBin"
            & $pythonBin -m venv .venv
            & ".venv\Scripts\python.exe" -m pip install --upgrade pip
            & ".venv\Scripts\python.exe" -m pip install -r requirements.txt
        } else {
            # Verify sidecar deps present
            $check = & ".venv\Scripts\python.exe" -c "import nuitka, numpy, pygam" 2>$null
            if ($LASTEXITCODE -ne 0) {
                Warn ".venv exists but missing packages - reinstalling"
                & ".venv\Scripts\python.exe" -m pip install -r requirements.txt
            }
        }
        # Run the bash build script via Git Bash. Env var is defense-in-depth
        # for older Nuitka versions; the script itself already passes
        # --assume-yes-for-downloads as a flag.
        $env:NUITKA_ASSUME_YES_FOR_DOWNLOADS = "1"
        $env:NUITKA_JOBS = "1"
        & $bashExe ./build_sidecar.sh
        if ($LASTEXITCODE -ne 0) { Fail "build_sidecar.sh failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $sidecar)) {
        Fail "Sidecar build finished but $sidecar is missing"
    }
    $size = "{0:N1} MB" -f ((Get-Item $sidecar).Length / 1MB)
    Ok "Sidecar built ($size)"
}

# ─── 4. Tauri build ───────────────────────────────────────────────────────
Step "4/5  Building Tauri app + NSIS/MSI installers"
# Use npx directly to bypass npm's CLI config parsing, which swallows --target
# (npm 10+ treats --target as an unknown npm config and drops it).
npx tauri build --target $Target
if ($LASTEXITCODE -ne 0) { Fail "tauri build failed (exit $LASTEXITCODE)" }

# ─── 5. Locate + report installers ────────────────────────────────────────
Step "5/5  Locating installers"
$bundleDir = "src-tauri\target\$Target\release\bundle"
$nsisDir   = Join-Path $bundleDir "nsis"
$msiDir    = Join-Path $bundleDir "msi"

$nsisInstaller = $null
$msiInstaller  = $null
if (Test-Path $nsisDir) {
    $nsisInstaller = Get-ChildItem $nsisDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if (Test-Path $msiDir) {
    $msiInstaller = Get-ChildItem $msiDir -Filter "*.msi" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if (-not $nsisInstaller -and -not $msiInstaller) {
    Fail "No .exe or .msi installer found under $bundleDir"
}

$elapsed = (Get-Date) - $StartTs
$mm = [int]$elapsed.TotalMinutes
$ss = [int]($elapsed.TotalSeconds - $mm * 60)

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "  Build complete in ${mm}m ${ss}s" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green

if ($nsisInstaller) {
    $sz = "{0:N1} MB" -f ($nsisInstaller.Length / 1MB)
    Write-Host "  NSIS installer (recommended):" -ForegroundColor White
    Write-Host "    $($nsisInstaller.FullName)  ($sz)"
}
if ($msiInstaller) {
    $sz = "{0:N1} MB" -f ($msiInstaller.Length / 1MB)
    Write-Host "  MSI installer:" -ForegroundColor White
    Write-Host "    $($msiInstaller.FullName)  ($sz)"
}
Write-Host ""
Write-Host "  Note: unsigned build - Windows SmartScreen will warn on first" -ForegroundColor Yellow
Write-Host "        launch. Click 'More info' -> 'Run anyway' to bypass." -ForegroundColor Yellow
Write-Host ""
