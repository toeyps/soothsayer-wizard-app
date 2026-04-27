# Task Breakdown

---

## Feature 1: Data Upload Page Redesign

### Status: Phases 1-2 Complete, Phase 3 Pending

### Feature Summary
Redesign the Import CSV page into a full Data Upload Page with:
- Multi-file CSV upload with detailed validation report
- Mapping CSV upload with scrollable table preview
- Sensor tag-to-name mapping with color-coded results
- Mode selection (Free Exploration vs Soothsayer Predictive)
- Full auto-resume persistence

---

### Phase 1: Contract Definition -- COMPLETE

#### fe-logic-agent
- [x] **1.1** Add new types to `src/types/dataUpload.ts`: `CsvLoadReport`, `ColumnInfo`, `MappingData`, `MappingResult`
- [x] **1.2** Update `src/types/commands.ts` with new commands: `load_csv` (updated return type), `load_mapping_csv`, `apply_sensor_mapping`
- [x] **1.3** Update `WorkspaceState` in `src/types.ts` to include `mappingFilePath` and `mappingKeyColumn`
- [x] **1.4** Create `src/hooks/useDataUpload.ts` -- hook managing upload page state, file selection
- [x] **1.5** Create `src/hooks/useMappingData.ts` -- hook for loading mapping CSV data and applying sensor tag mapping

#### rust-agent
- [x] **1.6** Update `load_csv` command to return `CsvLoadReport` (with column info, null counts, warnings, dtypes)
- [x] **1.7** Implement `load_mapping_csv` command -- parse a single CSV and return all rows/columns as structured data
- [x] **1.8** Implement `apply_sensor_mapping` command -- accept key_column, mapping data, and dataset headers; return mapping results (matched, not_in_dataset, not_in_mapping)

---

### Phase 2: Implementation -- COMPLETE

#### fe-ui-agent
- [x] **2.1** Redesign as `DataUploadPage.tsx` with two-panel layout (Left: Dataset upload + validation, Right: Mapping + config + results, Bottom: Mode selection)
- [x] **2.2** Build `DataValidationSummary` sub-component
- [x] **2.3** Build `MappingUpload` sub-component with scrollable table
- [x] **2.4** Build `SensorTagMapping` sub-component -- dropdown for key column + Apply button
- [x] **2.5** Build `MappingResults` sub-component -- color-coded results (green/amber/red)
- [x] **2.6** Build `ModeSelection` sub-component -- two mode buttons
- [x] **2.7** Build `RecentWorkspaces` sidebar component
- [x] **2.8** Wire all sub-components to hooks from Phase 1

---

### Phase 3: Testing -- PENDING

#### qa-agent
- [ ] **3.1** Write unit tests for `useDataUpload` hook
- [ ] **3.2** Write unit tests for `useMappingData` hook
- [ ] **3.3** Write Rust tests for `load_mapping_csv` command
- [ ] **3.4** Write Rust tests for `apply_sensor_mapping` command
- [ ] **3.5** Write Rust tests for updated `load_csv` command (validation report)

---
---

## Feature 2: Hybrid Calculation Engine (Add Sensor Window)

### Status: Phases 1-2 Complete, Phase 3 Pending

### Feature Summary
Replace the hardcoded sensor calculation system with a flexible hybrid approach:
- **Simple Mode**: Data-driven dropdowns powered by an operation registry (no hardcoded `<option>` tags)
- **Advanced Mode**: Formula editor with sensor autocomplete, syntax highlighting, live preview, and real-time error feedback
- **Operation Registry**: Single source of truth for both frontend and backend operations
- Backward compatible with existing `calculate_new_sensor` command

---

### Phase 1: Contract Definition -- COMPLETE

#### fe-logic-agent
- [x] **F2-1.1** Verified `src/types/calculationEngine.ts` with types: `OperationDefinition`, `OperationParam`, `SensorCalculationConfig`, `FormulaValidationResult`
- [x] **F2-1.2** Created `src/config/operations.ts` -- operation registry with `OPERATIONS.single[]` (12 ops) and `OPERATIONS.multi[]` (8 ops), categorized entries
- [x] **F2-1.3** Updated `src/types/commands.ts` -- added `evaluate_formula` and `validate_formula` commands
- [x] **F2-1.4** Created `src/hooks/useCalculationEngine.ts` -- hook with mode toggle, registry-driven config, preview, legacy+new config builders
- [x] **F2-1.5** Created `src/hooks/useFormulaEditor.ts` -- hook with formula state, debounced validation, autocomplete, sensor insertion

#### rust-agent
- [x] **F2-1.6** Added `fasteval = "0.2"` to `Cargo.toml`
- [x] **F2-1.7** Created `src-tauri/src/operation_registry.rs` with `build_single_ops()`, `build_multi_ops()`, `execute_single_op()`, `execute_multi_op()`, `execute_base_op()`, plus display helpers
- [x] **F2-1.8** Refactored `calculate_new_sensor` to use operation registry lookups (backward compatible)
- [x] **F2-1.9** Implemented `evaluate_formula` command with `$SensorName`/`${Sensor Name}` parsing, fasteval evaluation, row-by-row processing
- [x] **F2-1.10** Implemented `validate_formula` command with expression parsing, sensor existence check, dummy evaluation

---

### Phase 2: Implementation (UI) -- COMPLETE

#### fe-ui-agent
- [x] **F2-2.1** Rewrote `SensorTooling.tsx` with Simple/Advanced mode toggle tabs
- [x] **F2-2.2** Simple Mode: registry-driven dropdowns with `<optgroup>` by category, dynamic value/base/param inputs
- [x] **F2-2.3** Simple Mode: auto-generated formula preview from `engine.preview`
- [x] **F2-2.4** Advanced Mode: formula editor textarea with cursor tracking
- [x] **F2-2.5** Advanced Mode: autocomplete popup for sensor names triggered by `$`
- [x] **F2-2.6** Advanced Mode: real-time validation feedback (green/red) + referenced sensor tags
- [x] **F2-2.7** Advanced Mode: collapsible syntax help section
- [x] **F2-2.8** Updated `AddSensorWindow.tsx` to dispatch to `evaluate_formula` or `calculate_new_sensor` based on mode

---

### Phase 3: Testing

#### qa-agent
- [ ] **F2-3.1** Write unit tests for `useCalculationEngine` hook
- [ ] **F2-3.2** Write unit tests for `useFormulaEditor` hook
- [ ] **F2-3.3** Write unit tests for operation registry (`src/config/operations.ts`)
- [ ] **F2-3.4** Write Rust tests for operation registry (single and multi ops)
- [ ] **F2-3.5** Write Rust tests for `evaluate_formula` command
- [ ] **F2-3.6** Write Rust tests for `validate_formula` command
- [ ] **F2-3.7** Write Rust tests verifying backward compatibility of refactored `calculate_new_sensor`

---

## HANDOFF Reports
<!-- Worker agents will write HANDOFF blocks here -->

### Feature 3 / Phase 1 -- rust-agent (executed by pm-agent due to no spawn tool)

```
## HANDOFF
- Completed: backend.py is now self-contained (numpy + pygam only). preview_relationship reimplemented pure-numpy, train_relationship added with pickle save. Rust preview_relationship_model now ships {predictors, target, X, y, linearGAM_lambda} instead of {headers, rows}; NaN-drop + column projection happen Rust-side. Compat shim keeps the legacy {output, r2_dict, rmse2_dict} fields in the response so TS + UI continue to work without modification.
- New commands added: none (existing preview_relationship_model contract internals changed; train_relationship sidecar action added but not yet exposed as a Tauri command — that lands in Phase 3/5).
- Files changed: src-tauri/python/backend.py (rewritten), src-tauri/src/lib.rs (preview_relationship_model body rewritten).
- Verified: `cargo check` passes; backend.py passes `python -c "import ast; ast.parse(...)"`; `git diff src-tauri/python/soothsayer-wizard-python/` is empty (wizard.py untouched); imports in backend.py confirmed = {sys, os, json, pickle, traceback, numpy, pygam}.
- Compat decision: chose option (a) — Python sidecar emits BOTH new and legacy response shapes. No TS code touched. Phase 5 (fe-logic-agent) will remove the legacy fields when migrating the type + handler.
- Needs qa-agent: yes — manual sidecar smoke test (`echo '{...}' | python backend.py`) and UI Apply test require a host with numpy + pygam installed (host system python lacks them; Phase 6 will create the .venv). Numerical parity vs the previous wizard-backed sidecar should be confirmed once sidecar is runnable.
- Blocking issues: none for the next phase. Smoke test is environment-deferred, not a code defect.
```


---
---

## Feature 3: Hybrid Rust/Python Architecture for Predictive Model

### Status: Phase 1 In Progress, Phases 2-6 Pending

### Feature Summary
Move all non-LinearGAM math out of the Python sidecar into Rust. Python sidecar
keeps only `numpy + scipy + pygam` (drop `pandas`, `sklearn`) so Nuitka builds
become reproducible. Numerical parity must hold to within 1e-6 vs the original
Python reference. `src-tauri/python/soothsayer-wizard-python/wizard.py` is
read-only — copy logic into `backend.py`, never modify the vendored file.

Recommended ordering (per requirements doc): Phase 2 → Phase 1 → Phases 3 & 4 (parallel) → Phase 5 → Phase 6.
This run starts with Phase 1 (sidecar self-containment) since it unblocks Phase 6 (Nuitka rebuild).

---

### Phase 1: Self-contained `backend.py` (no `wizard.py` import) -- COMPLETE (pending host smoke test)

#### rust-agent (owns `src-tauri/`)
- [x] **F3-1.1** Copy LinearGAM `relationship` logic from `wizard.py` into `backend.py` as `preview_relationship(payload)` -- pure numpy + pygam, no DataFrame.
- [x] **F3-1.2** Copy `_execute_relationship` train/save logic into `backend.py` as `train_relationship(payload)` -- numpy r2/RMSE, pickle the LinearGAM model.
- [x] **F3-1.3** Implement numpy-only `_r2(y_true, y_pred)` and `_rmse(y_true, y_pred)` helpers in `backend.py`.
- [x] **F3-1.4** Remove `pandas` and `wizard` imports from `backend.py`. Final imports verified: `sys, os, json, pickle, traceback, numpy, pygam`.
- [x] **F3-1.5** Update `preview_relationship_model` in `src-tauri/src/lib.rs` to ship pre-cleaned `{predictors, target, X, y, linearGAM_lambda}` (Rust does NaN-drop + projection; X is n_rows × n_predictors, y is n_rows).
- [x] **F3-1.6** Compat-shim chosen (option a): sidecar response includes BOTH new fields (`r2_per_step`, `rmse2_per_step`, `predicted`, `residual`) AND legacy fields (`output: {columns, rows}`, `r2_dict`, `rmse2_dict`) so the existing TS `RelationshipPreviewResult` and `PredictiveModelBuild.tsx` `handleRelationshipApply` continue to work unmodified. Legacy fields to be removed in Phase 5.
- [x] **F3-1.7** `cargo check` passes (no warnings introduced).
- [ ] **F3-1.8** Manual sidecar smoke test -- DEFERRED: host system python lacks numpy/pygam (no .venv exists yet; Phase 6 creates it). `python3 -c "import ast; ast.parse(...)"` passes, so the file is syntactically valid. Smoke test should be re-run on a host with `pip install numpy pygam` or after Phase 6 builds the .venv.
- [x] **F3-1.9** `wizard.py` confirmed unchanged (`git diff src-tauri/python/soothsayer-wizard-python/` returns empty diff).
- [ ] **F3-1.10** End-to-end UI smoke -- DEFERRED to Phase 6 / QA (requires either an installed sidecar binary or a dev-mode python with numpy/pygam).

---

### Phase 2: Rust metric helpers (`src-tauri/src/metrics.rs`) -- PENDING

#### rust-agent
- [ ] **F3-2.1** Create `src-tauri/src/metrics.rs` with: `r2_score`, `rmse`, `mean`, `population_sd`, `sample_sd`.
- [ ] **F3-2.2** All functions return `f64::NAN` (no panic) on empty/single-element input.
- [ ] **F3-2.3** Match Python output to within 1e-9 on a fixed fixture.
- [ ] **F3-2.4** Add unit tests with at least 3 hand-computed cases per function.
- [ ] **F3-2.5** `cargo test --lib metrics` passes.
- [ ] **F3-2.6** No new external crate deps (std only).

---

### Phase 3: Rust Individual model port -- PENDING

#### rust-agent
- [ ] **F3-3.1** Refactor `compute_sensor_stats` to use `metrics::mean` and `metrics::sample_sd` (switch from population to sample SD for wizard parity).
- [ ] **F3-3.2** New command `train_individual_model(target, model_name?, save_path) -> IndividualModelInfo`.
- [ ] **F3-3.3** Computes mean, sample SD, 1σ and 3σ boundaries on non-NaN target values.
- [ ] **F3-3.4** Builds the `INDIVIDUAL_INFO` JSON structure matching `wizard.py`'s template exactly.
- [ ] **F3-3.5** Writes `{save_path}/output/{target}/INDV_INFO_{target}.json` and returns the same JSON.
- [ ] **F3-3.6** Parses dataset timestamp strings to fill `training_set_start_date` / `training_set_end_date`.
- [ ] **F3-3.7** Numerical parity vs Python reference within 1e-6.

---

### Phase 4: Rust Clustering model port (GMM 1-cluster + SVD) -- PENDING

#### rust-agent
- [ ] **F3-4.1** Add `nalgebra` dep to `Cargo.toml`.
- [ ] **F3-4.2** New module `src-tauri/src/clustering.rs` with `EllipseFit` struct + `fit_single_cluster_ellipse(xs, ys)`.
- [ ] **F3-4.3** Implement: 2x2 sample covariance, SVD via `nalgebra`, `angle = atan2(U[1,0], U[0,0]).to_degrees()`, `(major_sd, minor_sd) = sqrt(singular_values)`.
- [ ] **F3-4.4** New command `compute_clustering_preview(...)` -- only supports `n_clusters == 1`; returns Err for >1 (Python fallback out of scope).
- [ ] **F3-4.5** New command `train_clustering_model(...)` writes `CLUS_INFO_*.json` matching wizard template.
- [ ] **F3-4.6** Unit tests: 2D Gaussian mean/cov recovery, axis-aligned ellipse → angle ≈ 0.
- [ ] **F3-4.7** Numerical parity vs sklearn GMM(n=1) within 1e-6.

---

### Phase 5: TypeScript contract & UI integration -- PENDING

#### fe-logic-agent
- [ ] **F3-5.1** Update `RelationshipPreviewResult` in `src/types/commands.ts` to the new shape: `{request, r2_per_step, rmse2_per_step, predicted, residual}`. Remove legacy `output/r2_dict/rmse2_dict`.
- [ ] **F3-5.2** Add `train_relationship_model`, `train_individual_model`, `train_clustering_model`, `compute_clustering_preview` to `TauriCommands`.
- [ ] **F3-5.3** Optionally extract a `useRelationshipPreview` hook in `src/hooks/`.

#### fe-ui-agent
- [ ] **F3-5.4** Update `handleRelationshipApply` in `PredictiveModelBuild.tsx` to consume the new field names.
- [ ] **F3-5.5** Wire `handleClusteringApply` to `compute_clustering_preview`; surface ellipse parameters.
- [ ] **F3-5.6** Implement Save flow calling the appropriate `train_*_model` commands.
- [ ] **F3-5.7** Display residual stats (mean/sd) in the Stats Strip.
- [ ] **F3-5.8** `npx tsc --noEmit` passes; no new `any` types.

---

### Phase 6: Nuitka rebuild & verification -- PENDING

#### rust-agent
- [ ] **F3-6.1** Create `src-tauri/python/build_sidecar.sh` with the proven Nuitka flag set.
- [ ] **F3-6.2** Create `src-tauri/python/requirements.txt` pinning `numpy, scipy, pygam, nuitka`.
- [ ] **F3-6.3** Document Xcode CLT / build tool prerequisites in script header.

#### qa-agent
- [ ] **F3-6.4** Build the sidecar (must complete <15 min on M-series, output <200 MB).
- [ ] **F3-6.5** Manual JSON-pipe smoke test against the compiled binary.
- [ ] **F3-6.6** End-to-end Tauri app smoke: load CSV → Predictive Model Build → Apply Relationship/Individual/Clustering → no console errors.
- [ ] **F3-6.7** Verify `bin/backend-aarch64-apple-darwin` is non-empty and executable.
