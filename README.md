# Wizard (Soothsayer-Wizard)

Desktop app for importing sensor CSV data, exploring it, grouping sensors into
failure groups, and training predictive models — built with Tauri v2, React,
and a Python sidecar for the relationship-model math.

For a deeper architectural walkthrough (IPC conventions, security constraints,
data-flow internals) see [`CLAUDE.md`](CLAUDE.md). For a running log of recent
work and known issues across sessions, see
[`docs/PROJECT_HANDOVER.md`](docs/PROJECT_HANDOVER.md) and
[`docs/BACKLOG.md`](docs/BACKLOG.md).

## What it does

1. **Import** — load one or more CSV files (parsed in Rust, merged by
   timestamp), optionally with a sensor-mapping CSV that supplies
   descriptions, units, components, and alarm setpoints per tag.
2. **Explore** — a dashboard with a resizable Chart / Data / Sensor layout:
   - Line, Scatter, and Pair Plot charts (WebGL-accelerated scatter/pair-plot
     via `regl-scatterplot`), with per-sensor color and Y-axis pinning.
   - A data table and time-range / value filters.
   - Alarm setpoint lines (from the mapping CSV) toggleable per sensor.
3. **Failure Groups** — group sensors under named failure groups directly
   from the Dashboard's "Failure Groups" tab (create/rename/delete groups,
   assign sensors, track concept sensor / model type / notes / completion
   status per sensor), plus a quick-assign shortcut from the Sensor tab.
4. **Predictive models** — train and export models per sensor, three ways:
   - **Individual** — per-sensor statistical boundaries (Rust).
   - **Clustering** — GMM ellipse fits split by a criteria sensor (Rust).
   - **Relationship** — sensor-to-sensor relationship model (Python sidecar,
     LinearGAM under the hood — surfaced in the UI as "Relation model" only).
   - Results export to PNG/PDF reports.
5. **Workspaces** — every project (dataset selection, filters, chart
   settings, failure groups, model config) persists as a workspace you can
   reopen later from the Recent list.

## Architecture

Three tiers:

- **Frontend** — React 19 + TypeScript + Vite + Tailwind CSS v4. ECharts for
  line charts; `regl-scatterplot` (WebGL) for scatter/pair-plot; `split.js`
  for resizable panes.
- **Rust core** (`src-tauri/`) — Tauri v2 commands: CSV parsing/merging
  (`csv` + `rayon`), an in-RAM columnar store, the bounded chart-query
  pipeline (the frontend never receives a full dataset — everything is
  filtered/aggregated/downsampled server-side), clustering (`nalgebra`),
  and a formula engine (`fasteval`) for calculated sensors.
- **Python sidecar** (`src-tauri/python/backend.py`, compiled with Nuitka) —
  fits the Relationship model (LinearGAM) and returns JSON over stdin/stdout.
  Only invoked for that one model type.

The app is multi-window: the main window (import → dashboard) plus secondary
windows for Add Sensor, Predictive Model Build, and Save/Rename Workspace.

## Prerequisites

1. **Node.js** (latest LTS) — [nodejs.org](https://nodejs.org/)
2. **Rust** — [rustup.rs](https://rustup.rs/)
3. **Python 3.11+** (3.13/3.14 also tested working)
4. **Nuitka**, for compiling the Python sidecar:
   ```bash
   pip install nuitka
   ```
5. **Windows only**: Visual Studio C++ Build Tools
6. **Windows + Kaspersky**: add an Intrusion Prevention exclusion for the
   project folder, `%USERPROFILE%\.cargo`, and `%USERPROFILE%\.rustup` —
   otherwise Rust builds fail with an "Application Control policy" error.
7. **Do not** clone into a OneDrive-synced folder — this has caused
   intermittent `cargo build` failures ("output path is not a writable
   directory").

## Setup

```bash
git clone https://github.com/toeyps/soothsayer-wizard-app.git
cd soothsayer-wizard-app
npm install
```

### Compile the Python sidecar

The app expects a compiled sidecar binary before it can run. This is a
one-time step per machine (the binary is gitignored — everyone builds their
own):

```bash
cd src-tauri/python
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt   # Windows; use .venv/bin/pip on macOS/Linux
bash build_sidecar.sh                           # requires Git Bash on Windows
```

Copy the resulting binary to `src-tauri/bin/backend-<target-triple>.exe`
(e.g. `backend-x86_64-pc-windows-msvc.exe` for Windows x64,
`backend-x86_64-apple-darwin` / `backend-aarch64-apple-darwin` for macOS).
The target triple must match what `tauri.conf.json`'s `externalBin` expects.

## Running

```bash
npm run tauri dev        # full app — compiles Rust, needs the sidecar binary present
npm run dev               # frontend only (Vite, port 1420) — no Tauri backend, cannot open the app window
npm run build              # tsc type-check + vite build
npm run tauri:build        # release bundle (needs the sidecar binary)
```

> The app cannot be previewed in a plain browser tab — it calls Tauri's
> window APIs on mount, which don't exist outside a real Tauri webview.
> Always test through `npm run tauri dev`.

## Testing

```bash
npx vitest run                                          # frontend tests (jsdom)
npx vitest run src/__tests__/useScatterSample.test.ts    # a single test file
cd src-tauri && cargo test                               # Rust unit + integration tests
cd src-tauri && cargo test --test predictive_model_tests # integration tests only
```

## Building a release installer

```bash
npm run tauri:build:win           # or :mac:arm64 / :mac:x64
npm run installer:win             # wraps the build into a distributable installer
```

CI (`.github/workflows/release.yml`) builds the sidecar + Tauri bundle for
macOS arm64 and Windows x64 on every `v*` tag push, and publishes a draft
GitHub Release.

## Project structure

```
src/
├─ main.tsx              # entry — picks the root component from the ?window= query param
├─ App.tsx                # main window entry (upload → dashboard)
├─ components/
│  ├─ upload/              DataUploadPage (3-step: choose/create → name → upload+map)
│  ├─ dashboard/           Dashboard, FailureGroupsPanel, SensorSelection, DataTable, FilterPanel
│  ├─ charts/              LineChart, ScatterChart, PairPlotChart/Cell
│  ├─ windows/              secondary windows: AddSensor, PredictiveModelBuild, SaveAs (also serves Rename)
│  └─ reports/              PM PDF/PNG report template
├─ hooks/                  data-fetching + Tauri-binding hooks (useChartData, useScatterSample, ...)
├─ types/commands.ts       single source of truth for every Tauri command signature
└─ workspaceManager.ts     save/load/list/delete/duplicate/rename workspace files

src-tauri/
├─ src/
│  ├─ lib.rs               entry point — command registration, window lifecycle
│  ├─ csv_processor.rs      CSV parse/merge → the in-RAM columnar store
│  ├─ chart_query.rs         bounded query pipeline (filter → transform → aggregate → downsample)
│  ├─ clustering.rs           GMM ellipse fit
│  └─ metrics.rs               per-sensor statistics
├─ python/backend.py        Relationship-model sidecar source
└─ tauri.conf.json           CSP, window config, bundle targets (tauri.windows.conf.json overrides for Windows)
```

## Security notes

- CSV files are capped at 2 GB each.
- Writes to user-picked paths (CSV/PDF/PNG export) go through a dedicated
  Rust command — the fs plugin itself is scoped to `$APPDATA` only.
- The Relationship model's underlying algorithm name must never appear in
  user-facing text (say "Relation model").

See [`CLAUDE.md`](CLAUDE.md) for the full list of conventions and anti-patterns
this codebase relies on.
