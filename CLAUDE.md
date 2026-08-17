# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Wizard** (repo: Soothsayer-wizard-app) is a Tauri v2 desktop app for importing sensor CSV data, exploring it (dashboard with table/line/scatter/pair-plot), building failure groups, and training predictive models. Three tiers:

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS v4. ECharts for line charts; `regl-scatterplot` (WebGL) for scatter and pair-plot cells; `split.js` for resizable panes; `lucide-react` icons.
- **Rust core** (`src-tauri/`): Tauri v2 commands — CSV parse/merge (`csv` + `rayon`), in-RAM columnar store, filtering/stats, clustering (`nalgebra` GMM ellipse fits), formula engine (`fasteval`).
- **Python sidecar** (`src-tauri/bin/backend-<target-triple>`, Nuitka-compiled from `src-tauri/python/backend.py`): LinearGAM relationship-model fit/predict. Spawned via the shell plugin's sidecar API; JSON over stdin/stdout. The sidecar binary must exist before `tauri dev`/`tauri build` — see README for the Nuitka compile command (output filename must carry the target triple).

## Commands

```bash
npm run tauri dev                 # full app (compiles Rust, needs sidecar binary)
npm run dev                       # frontend only (Vite, port 1420)
npm run build                     # tsc type-check + vite build — run before handing off
npx vitest run                    # frontend tests (jsdom, src/__tests__/)
npx vitest run src/__tests__/useScatterSample.test.ts   # single test file
cd src-tauri && cargo test        # Rust unit tests (in-module) + integration
cd src-tauri && cargo test --test predictive_model_tests # integration only
npm run tauri:build               # release bundle; per-target + installer scripts in scripts/
```

## Architecture

### Data path (the core of the app)

1. `load_csv` (Rust) parses one or more CSVs in parallel with rayon (**2 GB/file hard cap** — `MAX_CSV_BYTES` in `csv_processor.rs`), merges multi-file datasets by timestamp (later-non-null-wins on duplicate timestamps; single-file loads take a fast path that skips the merge), and stores the result in Tauri managed state.
2. The in-RAM store is **`ColumnarData`** (`csv_processor.rs`) — column-major on purpose: one contiguous `Vec<f64>` per sensor, **NaN = missing**; `timestamps` keeps the verbatim CSV text; `ts_parsed` holds epoch-microseconds parsed **once at load** (`TS_MISSING` when absent). `headers[0]` is the canonical timestamp column. Filters must compare against `ts_parsed` — never re-parse timestamp strings per query. New aggregations should walk columns, not rows.
3. **The frontend never receives the full dataset** (since v0.2.1). Display queries run Rust-side in `chart_query.rs` — filter → operation transform → optional hourly aggregation → min/max downsample — so the WebView only ever gets O(max_points) rows:
   - `get_chart_data` (hard ceiling 100k points) via `useChartData` — line chart; `get_table_page` (page size ≤ 1000) via `useTablePage` — data table.
   - `get_scatter_sample` (reservoir sampling, `max_points` cap) via `useScatterSample` — scatter + pair plot.
   - `export_chart_csv` writes CSV exports straight to disk from Rust instead of round-tripping rows through JS.
4. Chart-level GPU guards: `ScatterChart` and `PairPlotCell` handle WebGL context loss (retry overlay) and apply defensive stride caps (500k / 100k points) as a last line of defense.

### IPC contract — conventions that break silently if violated

- `src/types/commands.ts` (`TauriCommands`) is the **single source of truth** for command signatures. Every command registered in `lib.rs`'s `invoke_handler` must be typed there **before** UI work begins (contract-first).
- **Arg-key casing (the #1 silent-failure trap)**: this codebase sends **snake_case keys from TS** matching the Rust parameter names (`max_points`, `first_sensor`, `save_path`). But Tauri v2's command macro expects **camelCase keys by default**, so every command with a multi-word parameter MUST carry `#[tauri::command(rename_all = "snake_case")]`. Missing it → invoke rejects with `missing required key maxPoints`-style errors, which hooks may swallow, so the feature just silently does nothing.
- Never call `invoke()` without an explicit TypeScript return type.

### Windows & capabilities

Multi-window app: `main` (upload → dashboard) plus sub-windows `predictive-model`, `save-as` (full capability, `src-tauri/capabilities/default.json`) and `add-sensor` (slimmer capability, `add-sensor.json`). The fs plugin is scoped to `$APPDATA` — writes to arbitrary user-picked paths (CSV/PDF/PNG exports) must go through the Rust `write_user_file` command, via `writeUserTextFile` / `writeUserBinaryFile` in `workspaceManager.ts`.

**2026-08-06**: the standalone `failure-group` sub-window (`FailureGroupCreation.tsx`) was deleted — failure-group management now lives inline in the Dashboard window as a "Failure Groups" tab in the Sensor panel (`FailureGroupsPanel.tsx`), plus a per-sensor quick-assign in the existing Sensor tab (`SensorSelection.tsx`). `save-as`'s window/component is still spawned, but only for the "Rename Workspace" mode now — the "Save As" (duplicate workspace) mode was removed app-wide. See `docs/PROJECT_HANDOVER.md` for the full account.

### Workspace persistence & auto-resume

- `src/workspaceManager.ts` owns save/load/list/delete/duplicate/rename — frontend-only, via plugin-fs + plugin-store.
- Lightweight state (recent-workspace list, settings) → plugin-store `settings.json`. Heavy `WorkspaceState` → JSON files under `$APPDATA`.
- **Auto-resume is a hard requirement**: if the app closes, it reopens exactly where the user left off (`lastRoute` + state). Keep React state synced to storage frequently; never reset full state on reload.

### Predictive models (`PredictiveModelBuild.tsx`)

- **Individual**: Rust — per-sensor stats/boundaries → `INDV_INFO_*.json`.
- **Clustering**: Rust — GMM ellipse fits (nalgebra), 1..N clusters split by criteria-sensor ranges → `CLUS_INFO_*.json`.
- **Relationship**: Python sidecar (LinearGAM) — Rust pre-cleans/projects rows and ships small arrays over stdin; sidecar returns JSON; the sidecar writes the `.pkl`, Rust writes `REL_INFO_*.json` alongside. Output layout matches the legacy `wizard.py` (`{save_path}/output/{target}/`).
- **Naming rule: the UI must say "Relation model" — the LinearGAM algorithm name is confidential and must never appear in user-facing UI** (code comments are fine).

### Report export (PM page)

`usePMReport` exports PNG (html-to-image + `echarts.getInstanceByDom` composited onto a canvas; charts re-rendered offscreen at large size) and PDF (`@react-pdf/renderer` with `PMReportTemplate.tsx`). Note: react-pdf's yoga-layout engine compiles **WebAssembly at runtime** — the production `script-src` in `tauri.conf.json` includes `'unsafe-eval'` for this reason (the narrower `'wasm-unsafe-eval'` also satisfies it if the CSP is ever tightened). Dev mode uses the looser `devCsp`, so CSP regressions in PDF export only surface in **installed builds** — always test export from a real installer build after touching CSP or report code.

## Release checklist — required before every `.exe`/installer build

**Every time this app is built into an installer (`npm run tauri:build`, `installer:win`, or equivalent), `docs/CHANGELOG.md` must get a new version entry in the same pass — no exceptions, don't wait to be asked.**

1. **Decide the version bump using this table** — look at every change accumulated since the last tag that was actually shipped, find the categories present (same categories as the changelog entry itself, step 2 below), and bump by the single highest-severity category found. Every real (non-dev) build bumps at least PATCH, even for a one-line fix, so no two shipped builds ever share a version number:

   | Highest category present since last shipped tag | Bump |
   |---|---|
   | ⚠️ Breaking change (old workspace files stop working, a major feature is removed) | **MINOR** (reset patch to 0) — do **not** bump MAJOR for this; MAJOR stays `0` until the user explicitly declares the app has reached a "1.0, production-ready" milestone. That's a deliberate call the user makes, not something to infer from a changeset. |
   | ✨ New feature / major improvement (no breaking change) | **MINOR** (reset patch to 0) |
   | Only 🐛 Bug fixes / ⚡ Performance / 🧪 Tests / 📝 Docs / 🗑️ Removed (non-breaking) | **PATCH** |

   Apply the resulting version to `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` — all three must match.
2. Before building, write a new `## [x.y.z] — YYYY-MM-DD` section at the top of `docs/CHANGELOG.md` (newest first) summarizing what changed since the previous shipped version — pull from `git log <last-shipped-tag>..HEAD` and group into Breaking changes / Features / Bug fixes / Performance / Tests / Docs / Removed, matching the style of the existing 0.2.1 entry (this is also the exact category list step 1 reads from — decide the bump and write the note from the same pass over the same commit range, don't do them independently). Written for the end user, not just developers — explain user-visible symptoms fixed, not just function names touched.
3. Run the build (`scripts/build-installer-windows.ps1` on Windows — verifies prerequisites, builds the Python sidecar if missing, then `tauri build`).
4. After a successful build, tag the release (`git tag vX.Y.Z`) so the next changelog entry has an anchor to diff against.

**Windows output is `.exe` only** — `src-tauri/tauri.windows.conf.json` sets `bundle.targets: ["nsis"]`, overriding the main config's `"all"` just for Windows builds so `tauri build` on this platform produces only the NSIS `.exe`, no `.msi`. Don't remove this without asking — it's a deliberate user preference, not an oversight. (macOS builds are untouched — the main `tauri.conf.json`'s `"all"` still applies there, giving `dmg`/`app`.)

## Testing discipline

**Every code change ships with a test change in the same pass — no exceptions, don't wait to be asked.**

- New file/function/component → new test file/case covering it.
- Changed behavior (UI flow, hook return shape, command args, business logic) → update the existing test(s) that cover it so they assert the *new* behavior, not the old one. A test that still passes after a behavior change but never actually exercises the new behavior is worse than no test — it hides the drift.
- Renamed/removed a prop, field, command name, or UI copy string? Grep `src/__tests__/` (and `src-tauri/tests/` + `#[cfg(test)]` blocks) for the old name before considering the change done.
- This applies to *modifications*, not just additions — editing `Dashboard.tsx` means checking `Dashboard.test.tsx` still matches, not just leaving it alone because it currently passes.
- Verify with `npx tsc --noEmit` + `npx vitest run` (frontend) and `cargo test` (Rust) before calling a task done.
- Coverage reached 586 frontend tests / 45 files + 139 Rust unit tests as of 2026-08-10 specifically because this discipline was absent for most of the project's history — UI was reshaped multiple times (step-based onboarding, Failure Group panel moves, Class B persistence) while old tests sat untouched. They happened to still be accurate on inspection, but that was luck, not process — see `docs/PROJECT_HANDOVER.md` entry 2026-08-10 for the audit. Don't rely on luck going forward.

## Post-task checklist — Notion sync + git push, required after every task, no exceptions, don't wait to be asked

The user tracks all work in the Notion database **"wizard application plan improvement"** (`collection://39e959a6-c718-8039-b30b-000bbea5ca96`). Schema: `Project name` (title), `Status` (status type: `Not started` → `In progress` / `wait for advisor` / `waiting re design` → `Done`), `Note` (text), `technical stack` (multi-select: `UX/UI`, `algorithum`, `backend`, `Sequence UX/UI`).

**Whenever a task finishes (whatever its origin — a Notion item the user pointed at, or something asked directly in chat that was never in Notion):**
1. Query the database for an existing page matching the task (fuzzy-match `Project name`/`Note` against the task's subject — if genuinely ambiguous which page it is, ask rather than guess).
2. If found, update it. If not found, create a new page (`Project name` = short task title, `Note` = 1-2 line summary, `technical stack` = best-guess tag(s) from the work's nature).
3. **Never set `Status` to `Done` on your own judgment — not even after `tsc`/`vitest`/`cargo test` all pass.** Set it to `In progress` (or leave whatever in-progress-family status it already had) instead. Only flip it to `Done` when the user explicitly confirms they've checked the real running app and it's fine — this project's whole history is full of fixes that passed every automated check yet still needed 2-3 more rounds after real manual testing surfaced a regression (see `docs/PROJECT_HANDOVER.md`'s many "ยังไม่ได้ทดสอบบนแอปจริง" entries); a prematurely-"Done" Notion item would misrepresent that.
4. **Design tasks — Figma only for genuinely new designs, Artifact is fine for small tweaks:** if the task is a full new design (a new screen/feature mockup the user wants to hand-edit themselves), push the actual design into a real Figma file via the Figma MCP tools (`create_new_file` / `use_figma` / `upload_assets`) — not just an Artifact — after the direction is validated in chat (per the confirm-before-implementing habit below). Set the Notion item's `Status` to **`waiting re design`** with the Figma file URL in `Note`, so it's visibly "in the user's court." When the user later says they've finished editing in Figma and it's ready to read back, re-fetch the Figma file (`get_design_context`/`get_screenshot`) before implementing, and move `Status` back to `In progress` (then `Done` per rule 3 once they confirm it works). If the task is just a small tweak/bug fix to an existing design (not a from-scratch design), an Artifact mockup is enough — don't push those to Figma. This is a different thing from `docs/figma/*.svg` in this repo — those are static reference mockups from earlier design rounds and are explicitly *not* kept in sync with code changes (don't touch them unprompted, per standing user feedback); this rule is about actively pushing genuinely new design work into Figma when the user wants to edit it there.
5. **Commit and push the code, unasked, in the same pass.** Push only to the `personal` remote (`toeyps/soothsayer-wizard-app`) — **never** `origin` (`Alpha-Com-Thailand`), even though `origin` exists and tracks `main` and even though push access to it may work. This is the user's explicit decision, not a permissions issue. Follow the repo's standard commit-message conventions (see git history) and include the `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.

## Security constraints

- 2 GB per-file CSV cap (`MAX_CSV_BYTES`).
- Any new file-I/O command must use the existing helpers in `lib.rs`: `validate_read_path` (frontend-supplied read paths) and `sanitize_filename_component` (model names → filenames).
- Dataset CSV exports escape Excel formula injection; the formula engine enforces expression length + nesting-depth limits.
- Don't widen the CSP or fs scope without explicit approval.

## Agent Roles & File Ownership

> Only for large, contract-clean features (new Tauri command + its consuming hook + UI, cleanly phased — e.g. the original Data Upload Page redesign and the Predictive Model Rust port, both in `docs/task.md`). Most work on this project is small, iterative, cross-cutting fixes done directly in the main session — see `multi_agent_orchestration_design.md` for the explicit criteria on when to spawn this pipeline at all. Each agent must ONLY read and modify **application code** within its own zone (test files are the one deliberate exception below). Architectural decisions must be approved by the PM Agent.

| Agent            | Zone (app code)                                  | Also writes                    | Responsibility                                  |
|------------------|---------------------------------------------------|---------------------------------|-------------------------------------------------|
| `pm-agent`       | `docs/` (incl. `docs/task.md`)                   | —                               | Requirements, task breakdown, coordination, final sync-check |
| `fe-ui-agent`    | `src/components/`, `src/App.tsx`                 | `src/__tests__/` (its own components) | React UI, Tailwind styling, charts        |
| `fe-logic-agent` | `src/hooks/`, `src/types/`, `src/workspaceManager.ts` | `src/__tests__/` (its own hooks/types) | Hooks, Tauri bindings, state management |
| `rust-agent`     | `src-tauri/src/`, `src-tauri/Cargo.toml`         | inline `#[cfg(test)]` in the same file | Tauri commands, CSV parsing, file I/O   |
| `qa-agent`       | —                                                 | `src/__tests__/`, `src-tauri/tests/` | Final integration/regression sweep across everything workers built — not the sole test author |

**Workflow**: pm-agent plans in `docs/task.md` → workers implement phase by phase, **each writing the tests for the code they just wrote in the same pass** (matches the "test with every change" rule above — don't defer your own unit tests to qa-agent) → **contract-first**: backend-facing features update `src/types/commands.ts` before UI → qa-agent runs last, writes cross-cutting integration tests, and re-runs the full suite → **pm-agent runs `npx tsc --noEmit` + `cargo check --lib` + the full frontend/Rust test suites itself before reporting to the user** — don't just trust workers' individual HANDOFF claims (a signature change in one zone silently broke a test file owned by another agent once already; see `docs/task.md`'s Feature 3 closing note). Load only files needed for the current task; do not scan the full repo.

When your task is complete, output this block before stopping:

```
## HANDOFF
- Completed: [what was built]
- New commands added: [list or "none"]
- Files changed: [list]
- Needs qa-agent: [yes / no — and what to test]
- Blocking issues: [none / describe]
```

## Anti-patterns

- ❌ `invoke()` without a TypeScript return type, or with camelCase arg keys
- ❌ A new command with multi-word args but no `#[tauri::command(rename_all = "snake_case")]`
- ❌ Storing large data in `plugin-store` (use the filesystem)
- ❌ Resetting full state on reload (breaks Auto-Resume)
- ❌ Re-parsing timestamp strings per query, or row-major loops over `ColumnarData`
- ❌ Shipping unbounded row counts to the frontend (use the bounded `chart_query` commands / `get_scatter_sample`)
- ❌ Exposing "LinearGAM" in user-facing UI (say "Relation model")
- ❌ Using Tauri v1 API syntax
- ❌ An agent modifying files outside its zone
- ❌ Landing a code change (new or modified) without a matching new/updated test in the same pass

## Repo state snapshot (2026-07-14 — verify with `git log` before trusting)

- `main` @ v0.2.1 (`6ed6559`) is canonical. It contains the full RAM-optimization work: **step 1** (columnar store, ~52% RSS reduction, merged via PR #1) and **step 2** (bounded chart pipeline `chart_query.rs` + error reporting `log_frontend_error`/`get_error_log_path` + chart perf + sidecar fixes, `3620eb6`).
- **Step 3** (disk-backed store, e.g. DuckDB / mmap Arrow) is planned only if RAM is still insufficient after step 2.
- Branches `feat/columnar-ram-opt` and `claude/gifted-kepler-*` are superseded by main — don't base new work on them.
