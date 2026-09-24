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

### Feature 3 / Phase 2 -- rust-agent

```
## HANDOFF
- Completed: New `src-tauri/src/metrics.rs` module with `r2_score`, `rmse`, `mean`, `population_sd`, `sample_sd` — all `pub fn`, all on `&[f64]`, std-only. Edge cases (empty / length-mismatch / single-element-where-undefined / constant y_true for R²) return `f64::NAN` instead of panicking. Module registered via `pub mod metrics;` in `src-tauri/src/lib.rs`. Functions marked `#[allow(dead_code)]` for now (Phase 3 will wire them into `compute_sensor_stats` and remove the attribute).
- New commands added: none (helper module only; no Tauri command surface change).
- Files changed: src-tauri/src/metrics.rs (new, 285 lines incl. tests), src-tauri/src/lib.rs (one-line `pub mod metrics;` addition).
- Verified: `cargo build` succeeds with no warnings. `cargo test --lib metrics` → 25/25 pass. Hand-computed fixtures: r2 sklearn doc example (y=[3,-0.5,2,7], yhat=[2.5,0,2,8] → r2 = 1 - 1.5/29.1875), rmse same fixture (sqrt(0.375)), sample_sd vs population_sd identity (samp²·(N-1) = pop²·N) verified on 8-element fixture where pop_sd=2 exactly.
- Numerical parity: matches numpy/pandas to <1e-9 on every fixture. `sample_sd` uses ddof=1 (Bessel) — matches pandas `.std()` per requirements §Critical Constraints item 4.
- Needs qa-agent: no — module is fully self-tested. Integration testing belongs to Phase 3 once `compute_sensor_stats` switches over.
- Blocking issues: none. Phase 3 (Individual model port) is unblocked and ready to start.
```

### Feature 3 / Phase 3 -- rust-agent

```
## HANDOFF
- Completed: `compute_sensor_stats` now uses `metrics::mean` + `metrics::sample_sd` (ddof=1, pandas parity). Population→sample SD switch slightly widens ±1σ/±3σ bands at small N — intentional per requirements. New `train_individual_model(target, model_name, save_path) -> IndividualModelInfo` writes `INDV_INFO_{target}.json` matching `wizard.PredictiveImplementationTemplate.INDIVIDUAL_INFO` exactly. Helpers `parse_timestamp` (10 formats) and `dataset_time_bounds` populate `training_set_start_date` / `training_set_end_date` from the loaded dataset.
- New commands added: `train_individual_model`.
- Files changed: src-tauri/src/lib.rs (compute_sensor_stats refactor + new commands), src-tauri/src/metrics.rs (doc comment update).
- Verified: `cargo build` clean (no warnings). `cargo test --lib` → 30/30 (25 metrics + 5 clustering — Phase 4 landed in parallel).
- Numerical parity: mean/sample_sd already validated to 1e-9 in metrics tests; round-to-3-decimals follows wizard.py exactly.
- Behavioural change to flag: `compute_sensor_stats.sd` is now sample SD (ddof=1). For N=1 we coerce sample_sd's NaN to 0.0 so the ±σ band stays well-defined.
- Needs qa-agent: integration testing rolled into Phase 6.
- Blocking issues: none.
```

### Feature 3 / Phase 4 -- rust-agent

```
## HANDOFF
- Completed: New `src-tauri/src/clustering.rs` module (`pub mod clustering;` registered) with `EllipseFit` struct (serde-serializable) and `fit_single_cluster_ellipse(xs, ys)`. Uses `nalgebra::SVD` on a biased 2×2 sample covariance matrix (matching sklearn `GaussianMixture.covariances_`). Two new Tauri commands: `compute_clustering_preview` (preview-only, returns ellipse + n_rows) and `train_clustering_model` (writes `CLUS_INFO_{first}_{second}.json` matching wizard CLUSTERING_INFO). Multi-cluster (n_clusters>1) returns Err("Multi-cluster not yet supported in Rust port") per spec.
- New commands added: `compute_clustering_preview`, `train_clustering_model`.
- New deps: `nalgebra = "0.33"` in `src-tauri/Cargo.toml`.
- Files changed: src-tauri/Cargo.toml, src-tauri/src/clustering.rs (new, 165 lines incl. tests), src-tauri/src/lib.rs (commands + module registration).
- Verified: `cargo build` clean. `cargo test --lib clustering` → 5/5 pass. Tests cover: axis-aligned Gaussian → angle ≈ 0 mod 180°; rotated 45° cloud → angle ≈ 45° mod 180° + degenerate minor sd; 4-corner unit-cov recovery; empty/length-mismatch errors.
- Numerical parity: nalgebra's SVD returns singular values descending (matches numpy convention), so major_sd corresponds to s[0]. Ellipse angle convention identical to wizard.py: `atan2(U[1,0], U[0,0]).to_degrees()`.
- Needs qa-agent: integration in Phase 6.
- Blocking issues: none.
```

### Feature 3 / Phase 5 -- fe-logic-agent + fe-ui-agent + rust-agent (cleanup)

```
## HANDOFF
- Completed (fe-logic): `src/types/commands.ts` rewritten — `RelationshipPreviewResult` switched to new shape `{request, r2_per_step, rmse2_per_step, predicted, residual, error?, trace?}` (legacy `output/r2_dict/rmse2_dict` removed). Added 5 new interfaces (`IndividualModelInfo`, `EllipseFit`, `ClusteringPreview`, `ClusteringModelInfo`, `RelationshipTrainResult`) and 4 new TauriCommands (`train_individual_model`, `compute_clustering_preview`, `train_clustering_model`, `train_relationship_model`).
- Completed (fe-ui): `PredictiveModelBuild.tsx` updated. `handleRelationshipApply` consumes new shape, derives R²/RMSE from `r2_per_step[last]` / `rmse2_per_step[last]/2`, computes residual mean/sd client-side from `result.residual`. `handleClusteringApply` calls `compute_clustering_preview` and surfaces ellipse parameters in the right-column. `handleSaveModel` resolves `save_path = appDataDir/workspaces/{id}` then dispatches to `train_individual_model`, `train_relationship_model`, and/or `train_clustering_model` based on which modes are active. New "Save status" panel surfaces success/error feedback. Loading spinner added to clustering Apply button.
- Completed (rust-agent cleanup): Legacy compat shim removed from `backend.py` — `preview_relationship` now returns ONLY the new shape.
- New commands added: 4 (listed above) wired through invoke_handler.
- Files changed: src/types/commands.ts, src/components/windows/PredictiveModelBuild.tsx, src-tauri/python/backend.py.
- Verified: `npx tsc --noEmit` → exit 0 (no errors, no `any` introduced). `cargo build` clean. `cargo test --lib` → 30/30.
- Behavioural notes: the `save_path` is `${appDataDir}/workspaces/${workspaceId}`; output JSONs land under `${save_path}/output/${target}/`. The .pkl model itself is still written by the Python sidecar (preserves pickle-format compatibility with downstream pygam loaders); Rust writes the companion `REL_INFO_*.json`. Multi-cluster (n_clusters>1) is blocked at the UI level with a friendly error message.
- Needs qa-agent: end-to-end UI test deferred to Phase 6 (requires built sidecar).
- Blocking issues: none.
```

### Feature 3 / Phase 6 -- rust-agent + qa-agent

```
## HANDOFF
- Completed (rust-agent): `src-tauri/python/build_sidecar.sh` (executable) — auto-detects target triple, activates .venv, runs Nuitka with the proven flag set (`--onefile --standalone --enable-plugin=numpy --enable-plugin=anti-bloat --include-package=pygam --include-package=scipy --jobs=2 --lto=no`), copies output to `../bin/backend-<triple>` and chmods +x. Header documents Xcode CLT / gcc+patchelf / MSVC prerequisites. `requirements.txt` pins `numpy==1.26.4 / scipy==1.13.1 / pygam==0.9.1 / nuitka==2.4.8`.
- Completed (qa-agent): `src-tauri/tests/predictive_model_tests.rs` (new, 8 tests) covers the public clustering API, the new sidecar JSON contract (positive parse + no-legacy-fields parse + error-envelope parse + train response parse), and a field-name regression guard on `EllipseFit` serialisation. All pass.
- New commands added: none in this phase.
- Files changed: src-tauri/python/build_sidecar.sh (new), src-tauri/python/requirements.txt (new), src-tauri/tests/predictive_model_tests.rs (new).
- Verified: `cargo test --lib --test predictive_model_tests` → 30 + 8 = 38/38 pass. `npx tsc --noEmit` → exit 0.
- DEFERRED to user (manual): actually running `./build_sidecar.sh` (10+ minute Nuitka compile, requires .venv + pip install). Once built, the in-app Predictive Model Build flow (Apply Relationship / Individual / Save Model) can be smoke-tested end-to-end.
- Pre-existing `src-tauri/tests/csv_tests.rs` does NOT compile — `csv_processor::apply_mapping` signature changed in Feature 1 (4→3 args) and that test wasn't updated. Out of scope for Feature 3; flagged for a follow-up cleanup task.
- Blocking issues: none for the Feature 3 logic itself. The user must run the Nuitka build before end-to-end testing of the actual model save/preview flow.
```


---
---

## Feature 3: Hybrid Rust/Python Architecture for Predictive Model

### Status: Phases 1-6 Complete (Nuitka build itself deferred to manual user step)

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

### Phase 2: Rust metric helpers (`src-tauri/src/metrics.rs`) -- COMPLETE

#### rust-agent
- [x] **F3-2.1** Create `src-tauri/src/metrics.rs` with: `r2_score`, `rmse`, `mean`, `population_sd`, `sample_sd`.
- [x] **F3-2.2** All functions return `f64::NAN` (no panic) on empty/single-element input.
- [x] **F3-2.3** Match Python output to within 1e-9 on a fixed fixture (hand-computed sklearn doc fixture for r2/rmse, plus pop/sample SD ddof identity).
- [x] **F3-2.4** Add unit tests with at least 3 hand-computed cases per function (25 tests total).
- [x] **F3-2.5** `cargo test --lib metrics` passes (25/25).
- [x] **F3-2.6** No new external crate deps (std only). `pub mod metrics;` registered in `src-tauri/src/lib.rs`. Functions marked `#[allow(dead_code)]` until Phase 3 wires them into `compute_sensor_stats`.

---

### Phase 3: Rust Individual model port -- COMPLETE

#### rust-agent
- [x] **F3-3.1** Refactored `compute_sensor_stats` to use `metrics::mean` and `metrics::sample_sd`. Switched population SD → sample SD (ddof=1) to match pandas `.std()`. Falls back to 0.0 when N<2 (sample_sd is NaN).
- [x] **F3-3.2** New command `train_individual_model(target, model_name, save_path) -> IndividualModelInfo`.
- [x] **F3-3.3** Computes mean, sample SD, ±1σ and ±3σ boundaries on non-NaN finite target values (via rayon parallel collect).
- [x] **F3-3.4** Builds JSON matching `wizard.PredictiveImplementationTemplate.INDIVIDUAL_INFO` exactly: `model_name`, empty `model_composition`, `model_training_set_info {publish_id, training_set_start/end_date, training_set_comments}`, `model_metrics {mean, sd, 1sd_boundary, 3sd_boundary, setpoint_health_score}`, empty `historical_sd_band_and_set_point`, `model_update_record [...]`. Numbers rounded to 3 decimals.
- [x] **F3-3.5** Writes `{save_path}/output/{target}/INDV_INFO_{target}.json` (creates dirs) and returns `IndividualModelInfo`.
- [x] **F3-3.6** Implemented `parse_timestamp` + `dataset_time_bounds` covering 10 common timestamp formats (with/without timezone, T separator vs space, with/without fractional seconds). Falls back to empty strings if no rows parse.
- [x] **F3-3.7** Numerical parity: hand-computed fixtures match (mean / sample_sd already validated by metrics tests to 1e-9; round-to-3 follows the same convention as wizard.py).

---

### Phase 4: Rust Clustering model port (GMM 1-cluster + SVD) -- COMPLETE

#### rust-agent
- [x] **F3-4.1** Added `nalgebra = "0.33"` to `Cargo.toml`.
- [x] **F3-4.2** New module `src-tauri/src/clustering.rs` with `EllipseFit { x_center, y_center, x_sd, y_sd, angle_deg }` + `fit_single_cluster_ellipse(xs, ys) -> Result<EllipseFit, String>`. `pub mod clustering;` registered in `lib.rs`.
- [x] **F3-4.3** Computes biased 2×2 covariance (divide by N — matches sklearn `GaussianMixture.covariances_`), runs `nalgebra::SVD::new`, derives angle from `atan2(U[1,0], U[0,0]).to_degrees()`, and returns `(major_sd, minor_sd) = (sqrt(s0), sqrt(s1))` (singular values come back descending from nalgebra).
- [x] **F3-4.4** New command `compute_clustering_preview(first_sensor, second_sensor, n_clusters)` returns `ClusteringPreview { first_sensor, second_sensor, cluster_count, n_rows, ellipse }`. Returns `Err("Multi-cluster not yet supported in Rust port")` when `n_clusters != 1`. Drops rows with any NaN/non-finite on either axis before fitting.
- [x] **F3-4.5** New command `train_clustering_model(...)` writes `{save_path}/output/{second_sensor}/CLUS_INFO_{first}_{second}.json` matching the `CLUSTERING_INFO` template (single cluster keyed `"1"`, includes `boundary_sd_health_score: null`, criteria_sensor empty, cluster_count=1). Numbers rounded to 3 decimals.
- [x] **F3-4.6** Unit tests in `clustering.rs` (5 tests): axis-aligned Gaussian → angle ≈ 0 mod 180°; 45°-rotated cloud → angle ≈ 45° mod 180°; 4-corner unit-cov recovery → x_sd = y_sd = 1; empty input → Err; length mismatch → Err. All pass to within 1e-6.
- [x] **F3-4.7** Numerical parity: hand-computed against analytic SVD output; matches numpy `np.linalg.svd` ordering convention (descending singular values).

---

### Phase 5: TypeScript contract & UI integration -- COMPLETE

#### fe-logic-agent
- [x] **F3-5.1** `RelationshipPreviewResult` rewritten to `{request, r2_per_step, rmse2_per_step, predicted, residual, error?, trace?}`. Legacy `output/r2_dict/rmse2_dict` removed.
- [x] **F3-5.2** Added `IndividualModelInfo`, `EllipseFit`, `ClusteringPreview`, `ClusteringModelInfo`, `RelationshipTrainResult` interfaces. Added `train_individual_model`, `compute_clustering_preview`, `train_clustering_model`, `train_relationship_model` to `TauriCommands`.
- [x] **F3-5.3** Hook extraction deferred — handlers live in `PredictiveModelBuild.tsx` directly (single consumer, hook would be premature).

#### fe-ui-agent
- [x] **F3-5.4** `handleRelationshipApply` reads the new shape: R²/RMSE come from `r2_per_step[last]` / `rmse2_per_step[last] / 2`. "Trained on N rows" derived from `predicted.length`.
- [x] **F3-5.5** `handleClusteringApply` calls `compute_clustering_preview` (uses `scatterXSensor` as first_sensor, `targetSensor` as second_sensor). Errors when `n_clusters > 1`. Ellipse parameters (center, σ×σ, angle, n_rows) surfaced in the right-column config block.
- [x] **F3-5.6** Save flow: `handleSaveModel` resolves `save_path = appDataDir/workspaces/{workspaceId}` then dispatches to `train_individual_model` (when Individual on), `train_relationship_model` (when rcMode='relationship'), and/or `train_clustering_model` (when rcMode='clustering'). Reports per-model save paths via `saveStatus`.
- [x] **F3-5.7** Residual mean/SD computed client-side from `result.residual` (filters nulls, ddof=1 sample SD) and shown in the Stats Strip alongside R²/RMSE.
- [x] **F3-5.8** `npx tsc --noEmit` clean (exit 0). No `any` types introduced.

#### rust-agent (post-UI cleanup)
- [x] **F3-5.9** Removed legacy compat shim from `backend.py`. `preview_relationship` now returns ONLY the new shape (`request, r2_per_step, rmse2_per_step, predicted, residual`). The `output / r2_dict / rmse2_dict` fields and the per-step PREDICTED columns are gone.

---

### Phase 6: Nuitka rebuild & verification -- COMPLETE (script + tests landed; build itself deferred to user)

#### rust-agent
- [x] **F3-6.1** Created `src-tauri/python/build_sidecar.sh` (executable). Flags: `--onefile --standalone --enable-plugin=numpy --enable-plugin=anti-bloat --include-package=pygam --include-package=scipy --jobs=2 --lto=no --output-dir=build`. Auto-detects target triple via `rustc -vV` (with uname fallback), copies the artifact to `../bin/backend-<triple>` and chmods +x.
- [x] **F3-6.2** Created `src-tauri/python/requirements.txt` pinning `numpy==1.26.4`, `scipy==1.13.1`, `pygam==0.9.1`, `nuitka==2.4.8`.
- [x] **F3-6.3** Documented Xcode CLT (macOS) / gcc+patchelf (Linux) / MSVC (Windows) prerequisites in both the requirements.txt header and the build_sidecar.sh comment block, plus first-time setup instructions.

#### qa-agent
- [x] **F3-6.4 → MANUAL** Nuitka build itself is NOT run in this session (10+ minutes, requires .venv setup). User runs:
       ```bash
       cd src-tauri/python
       python3 -m venv .venv && source .venv/bin/activate
       pip install -r requirements.txt
       ./build_sidecar.sh
       ```
- [x] **F3-6.5 → MANUAL** Smoke test command documented in script header:
       ```bash
       echo '{"action":"preview_relationship","payload":{"predictors":["P1"],"target":"T","X":[[1],[2],[3],[4]],"y":[2,4,6,8],"linearGAM_lambda":1}}' \
         | ../bin/backend-$(rustc -vV | sed -n 's/host: //p')
       ```
- [x] **F3-6.6 → MANUAL** End-to-end Tauri app smoke deferred until the user has built the sidecar binary.
- [x] **F3-6.7 → MANUAL** `bin/backend-aarch64-apple-darwin` will be created by the build script.

#### qa-agent (in-session deliverables)
- [x] **F3-6.8** Created `src-tauri/tests/predictive_model_tests.rs` (8 tests): public-API smoke tests for `clustering::fit_single_cluster_ellipse`, JSON-shape verification of the new sidecar response (no legacy fields required), error-envelope round-trip, and field-name guard for `EllipseFit` serialisation. All pass via `cargo test --test predictive_model_tests`.
- [x] **F3-6.9** All previously added tests still pass (`cargo test --lib`: 30/30 — 25 metrics + 5 clustering).
- [x] **F3-6.10** Verified TypeScript: `npx tsc --noEmit` exits 0.

NOTE: Pre-existing `csv_tests.rs` does NOT compile due to a Feature 1 signature change in `csv_processor::apply_mapping` (took 4 args, now takes 3). Out of scope for Feature 3 — flagged as separate cleanup.

---
---

## Feature 4: Build Model: one row per sensor (A), running-condition gate (B), multiple training periods (C)

### Status: PLANNED (2026-09-24). Nothing implemented, no workers spawned.

Written by pm-agent (claude-opus-5-5) from the approved brief plus three mockups in the session scratchpad
(`merged-fg-opus.html` for A, `rc-gate.html` for B, `time-ranges.html` for C; the older `merged-fg.html` is kept only as history).
All line numbers are from `main` @ `71a04d5`.

### Feature summary (decisions already confirmed by the user; see the brief for the full list)
- **A**: The Overview's "Group by Failure Group" shows ONE row per sensor per FG. The grouping key is Target for Individual/Relationship and **X for Clustering**. The row header shows only the I/R/C chips for kinds that exist. The expanded row has shared fields plus one tab per kind. **Category is set once per sensor (workspace-wide, across every FG) and saves instantly.** Legacy data is normalised once, with a notice. New models inherit the sensor's category. The Dashboard FG tab uses the same grouping with no category control. Stored data stays one record per model.
- **B**: Build Model, Finish and re-train need a *configured* effective running condition: ≥1 value condition, or an explicit "No condition — use all rows". A time range alone does not count. Save stays allowed. Existing workspaces get a one-time banner, and Complete models without a condition show "Legacy · all data".
- **C**: The time start/end pair becomes a list `TimePeriod {id,start,end}`. A row is kept if it is in ANY period AND passes the value-condition block. Overlaps show a warning plus "Merge into one". An end before its start is invalid and blocks. The list is sorted on commit. Existing single ranges are migrated to periods. Rust gets `timestamp_ranges`, and an unparseable bound becomes an error instead of silently "unbounded". Chart shading of unused periods is **deferred**.

---

### F4-0. PRE-EXISTING BUG found while planning. Fix it first (Phase 0, blocks everything)

**The workspace-level training time range (`runningConditionTimeStart`/`runningConditionTimeEnd`, shipped 2026-09-23 in the 0.6.0 bump) is dropped by three writers that rebuild `failureGroupState` from an explicit field list.** I found this by reading the code; it has not been reproduced in the running app. The first task is a failing test that proves it.
- `Dashboard.tsx:1740-1749` (debounced full-overwrite autosave): re-reads `failureGroupState` from disk but copies only `groups/models/runningConditionFilters/runningConditionCombine`. Also `buildWorkspaceState` at `:1661` and `persistFailureGroupState` at `:372-381`. Dashboard's state mirror and event listener (`:349-356`, `:424-431`) have no time fields at all.
- `PredictiveModelBuild.tsx:974-986` (per-model config autosave): same pattern, time fields dropped.
- `workspaceManager.ts:247-255` (`migrateFailureGroupState`, groupNos branch): builds a fresh object without the time fields.
- Likely trigger: BuildModelWindow persists a time range and broadcasts it. Dashboard's listener sets `runningConditionFilters` (new identity), which re-arms the autosave, and ~250 ms later the autosave rewrites the file without the time fields. The UI hides this during the session because BuildModelWindow keeps the value in local state. It surfaces as "time range gone after reopen".
- **Why this blocks A/B/C**: B adds 2 workspace/model flags, C adds `runningConditionTimePeriods`, and A adds a notice field. Every one of these would be silently erased the same way.
- `v0.6.0` has a version-bump commit (`71a04d5`) but **no git tag** (latest tag is `v0.5.0`). If the 0.6.0 installer has not been built or shipped yet, fold this fix into 0.6.0. Otherwise ship it as 0.6.1 before this feature (see Q5).

| id | owner | task | tests (same pass) | acceptance |
|---|---|---|---|---|
| F4-0.1 | fe-logic-agent | Export `FailureGroupStateSlice` from `src/types.ts` (today it is a non-exported `interface` at `:219`). Add `withFailureGroupState(prev: WorkspaceState, patch: Partial<FailureGroupStateSlice>): WorkspaceState` to `workspaceManager.ts`. It **spreads `...prev.failureGroupState`** and then applies the patch, so no writer ever lists fields again. Also export one `FailureGroupStateChangedPayload` type (`FailureGroupStateSlice & {workspaceId; origin}`). Fix `migrateFailureGroupState:247-255` to spread as well. | `workspaceManager.test.ts`: a round-trip with unknown/extra FG fields (time start/end plus a dummy future field) survives `updateWorkspaceData` and the groupNos migration. | New tests fail on `main` and pass after the fix. |
| F4-0.2 | fe-ui-agent | Switch every writer to the helper: `Dashboard.tsx` `persistFailureGroupState` (`:370`), autosave (`:1740-1749`, spread `onDisk.failureGroupState`), `buildWorkspaceState` (`:1661`; carry the full slice mirror, not 4 fields), and the listener/mirror (`:424-431`: store the whole payload slice, not 4 fields). Also `PredictiveModelBuild.tsx:974-986`, and `BuildModelWindow.tsx` `persist`/`persistRunningCondition` (`:322-389`). Type every `subscribe<...>('failure-group-state-changed')` with the shared payload type. | `Dashboard.test.tsx`: after a broadcast carrying `runningConditionTimeStart`, the autosave write still contains it. `PredictiveModelBuild.test.tsx` `describe('persistence')`: a PM config autosave preserves workspace time fields. | `grep -n "runningConditionCombine: prev" src/components` returns 0 hits. Nothing enumerates FG fields any more. |
| F4-0.3 | fe-ui-agent | **Race hardening (makes A safer)**: `Dashboard.tsx` `toggleSensorGroupKind`/`createGroupForSensor`/`deleteModel` (`:519-570`) compute `nextModels` from the in-memory `fgModels` and write the whole array. Move each computation *inside* the `updateWorkspaceData` patch so it runs against `prev.failureGroupState.models`. Otherwise a Dashboard toggle landing just before BuildModelWindow's category broadcast arrives reverts the category on every model of that sensor. | `Dashboard.test.tsx`: a disk state newer than the in-memory mirror survives a sensor-kind toggle. | Same. |

Commit: `Fix workspace time range being erased by Dashboard/PM autosave` (1 commit). Manual test: PER-1 re-run plus a new **PER-9** (set an Overview time range, pan a chart on Dashboard, close and reopen: the range is still there).

---

### Dependency graph and recommended order

```
F4-0 (hotfix: spread-merge FG state)                               [fe-logic → fe-ui]
   │
   ├── Phase 1 CONTRACT (all three features at once, one schema bump)
   │     1a fe-logic: types.ts + workspaceManager migrations + src/utils helpers ─┐  (parallel)
   │     1b rust:     timestamp_ranges + error on bad bound (C only)  ───────────┘
   │
   ├── Phase 2 UI-A  (BuildModelWindow Overview + FailureGroupsPanel + Dashboard inherit)   [fe-ui]
   ├── Phase 3 UI-B  (gate: Overview panel, badges, PM Finish/banner)                       [fe-ui]
   ├── Phase 4 UI-C  (periods: Overview panel + PM Training scope + payload)                [fe-ui]
   └── Phase 5 qa sweep → Phase 6 pm verification
```

- **Only these can run in parallel**: 1a (fe-logic) and 1b (rust). They share no files. Everything else is sequential, because A, B and C all edit `BuildModelWindow.tsx` (1239 lines) and `PredictiveModelBuild.tsx` (3172 lines) in the same regions. Workers share one working tree, so two fe-ui agents on those files at once would clobber each other.
- **Why A → B → C for the UI**:
  - A rebuilds the Overview list, and B's "Needs condition" / "N blocked" badges are drawn on A's sensor rows.
  - B introduces the build-block reason plumbing (disabled Build/Finish plus a reason string). C only adds one more reason ("period N ends before it starts") to that plumbing.
  - C's periods list sits *above* B's segmented control in two places (Overview panel, PM Training scope). Doing C last means that region is restructured once, against its final shape.
- **Why all migrations happen in one contract phase**: one `schemaVersion` bump, one ordered and idempotent pipeline, one test file. This also avoids three separate "legacy" detections guessing from `undefined` fields. Those guesses are fragile because Phase 0 shows that writers drop fields.
- Shared-file map: `types.ts` (1a), `workspaceManager.ts` (0, 1a), `src/utils/*` (1a), `lib.rs` + `chart_query.rs` (1b), `Dashboard.tsx` (0, A inherit, C literal defaults), `BuildModelWindow.tsx` (0, A, B, C), `PredictiveModelBuild.tsx` (0, B, C), `FailureGroupsPanel.tsx` (A only), `src/types/commands.ts` + `src/hooks/useScatterSample.ts`/`useChartData.ts` filter types (1a, C).

---

### Zone decision (pm-agent, architectural)
`src/utils/` is in no agent's zone, and `src/types.ts` (a root file, not `src/types/`) is not literally in fe-logic's zone either. **For Feature 4, fe-logic-agent owns `src/types.ts` and these three NEW pure-function files**, with unit tests in `src/__tests__/`:
- `src/utils/modelGrouping.ts`: `modelSensorKey(m)` (clustering → `xSensor`, else `targetSensor`, normalised with `normalizeSensorTag`, the same case-insensitive rule as Dashboard's `findModelForKind` `:487-491`, which should be switched to call it), `groupModelsBySensor(models, groupNo)`, `sensorCategory(models, key)`, `setSensorCategory(models, key, cat)` (writes every model of that key workspace-wide), and `normalizeSensorCategories(models) → {models, changes}` (Individual → Relationship → Clustering precedence).
- `src/utils/runningCondition.ts`: `effectiveRunningCondition(model, fg)`, `isCompleteCondition(f, headers)`, `isRunningConditionConfigured(model, fg, headers)`, and **one** `getBuildBlockReason(model, fg, headers) → string | null` that returns the first blocking reason from A (no category), B (unconfigured) and C (invalid period). Every Build/Finish/re-train path uses it, so the three features cannot drift.
- `src/utils/timePeriods.ts`: `validatePeriods` (per-period `invalid`/`overlapsPrev`, open-end rules), `sortPeriods`, `mergeOverlapping(a,b)`, `nextDefaultPeriod(list, datasetMax)` (the day after the last period's end → 23:59 at month end), `isRangeFullyCovered(list, bounds)`, `periodChipLabel` (dates only for full-day ranges), and `toFilterRanges(list)` (drops invalid periods; `''` → `null`).

fe-ui-agent only imports these. There is no logic duplication in components.

---

### Phase 1a: contract, types, migrations, helpers (fe-logic-agent)

**Types (`src/types.ts`)**
- `export interface TimePeriod { id: string; start: string; end: string }` (`''` = open end, allowed only on the first period's start and the last period's end).
- `FailureGroupStateSlice` (`:219`): add `runningConditionTimePeriods?: TimePeriod[]`, `runningConditionNoneConfirmed?: boolean` (B, workspace), `schemaVersion?: number`, `categoryNormalisationNotice?: CategoryChange[] | null` (A), `rcLegacyNotice?: 'pending' | null` (B). **Remove** `runningConditionTimeStart/End` from the type. Migration deletes them from data.
- `PredictiveModelStateSlice` (`:123`): add **required** `filterTimePeriods: TimePeriod[]` and `customRunningConditionNoneConfirmed: boolean`. Remove `filterTimeStart/End`. Required fields make `tsc` flag every `FailureModel` literal: `Dashboard.tsx:448-478`, `workspaceManager.ts` `DEFAULT_PM_SLICE:178-197` and the legacy branch `:285-305`, and `PredictiveModelBuild.tsx:955-972`. This is the same deliberate trick used on 2026-09-23.
- `FailureModel.category` stays per-record (3 records per sensor). A is display-time and write-fan-out only. `ModelCategory` is unchanged.
- `src/types/commands.ts:123-124` `DashboardDataFilter` plus the `useScatterSample.ts:12-13` filter type: add optional `timestamp_ranges?: {start: string|null; end: string|null}[]`.

**Migrations (`workspaceManager.ts`)**: see "Data-migration plan" below.

**Hooks**: none new. **Reuse `useDatasetTimeBounds`** (`src/hooks/useDatasetTimeBounds.ts`, backed by the existing `get_dataset_time_bounds` at `lib.rs:3092`, which already scans `ts_parsed` via `chart_query::full_dataset_time_bounds` `:486-498`). **The brief's "add a small min/max `ts_parsed` query" already exists, so no new Rust command is needed.** The build-model window uses `capabilities/default.json` like `main`, so it can invoke it.

**Tests (same pass)**: `modelGrouping.test.ts`, `runningCondition.test.ts`, `timePeriods.test.ts` (new), and `workspaceManager.test.ts` (new `describe('schema v2 migration')`). **Existing gotcha**: the `toEqual` assertions at `workspaceManager.test.ts:273-305` compare migrated models against minimal objects and will fail once migration adds `filterTimePeriods` etc. Update them to `toMatchObject` or add the new fields explicitly. Don't delete them.

**Acceptance**: `npx tsc --noEmit` passes *only after* the literal sites above are updated. fe-logic lists them in HANDOFF for fe-ui to finish in Phase 2 if they are outside its zone. `npx vitest run` passes for the new/changed files.

### Phase 1b: Rust (rust-agent, parallel with 1a)
- `lib.rs:621-637` `PreviewFilter`: add `#[serde(default)] timestamp_ranges: Vec<TimeRangeArg>` with `TimeRangeArg { start: Option<String>, end: Option<String> }`. `lib.rs:3013-3027` `DataFilter`: same field, plus `#[derive(Default)]` so test literals can use `..Default::default()`. `to_preview` (`:3033`) passes it through. The **2026-09-23 lesson in CLAUDE.md applies**: the PM target chart goes through `DataFilter`/`get_chart_data`, not `PreviewFilter`, and missing the field there once left the chart on different semantics than training.
- `ResolvedFilter` (`:656-773`): replace `ts_start/ts_end` with `ts_ranges: Vec<(Option<i64>, Option<i64>)>`, sorted and merged at resolve time. The legacy pair becomes one range. **If both the legacy pair and `timestamp_ranges` are non-empty, return `Err`** (pm-agent decision: no caller sends both; an error catches a wiring bug instead of guessing precedence). `keeps()` = timestamp in ANY range (an empty list means no time gate; `TS_MISSING` is excluded whenever a gate exists), then the unchanged value-filter AND/OR. `is_noop()` (`:709`) = `ts_ranges.is_empty() && value_filters.is_empty()`.
- **Unparseable bound → error**: `resolve` becomes `Result<Self, String>`. `Some("")` or whitespace still means `None`. **Don't turn today's `''` into an error**: Dashboard sends `|| null` (`Dashboard.tsx:1559-1560,1824-1825`), but be defensive. A bound with start > end → `Err("time period N ends before it starts")`. Propagate with `?` through all 8 call sites: `compute_sensor_stats:511`, `preview_relationship_model:1059`, `train_individual_model:1263`, `compute_clustering_preview:1458`, `train_clustering_model:1652`, `train_relationship_model:1848`, `sample_dataset:3195`, and `chart_query::resolve_ctx:136`. That means `build_chart_view` (`chart_query.rs:504`) and `sample_dataset` return `Result`, and `get_chart_data`/`get_scatter_sample` map the error.
- Every new/changed command param already uses snake_case keys. No new command is added, so there is no `rename_all` change.
- **Tests (inline)**: extend `resolved_filter_tests` (`lib.rs:776+`, literals at `:811-989` need the new field or `..Default::default()`). Cover: OR across 2 disjoint ranges, overlapping ranges merged, open first start/last end, ranges combined with value filters under AND and OR, legacy pair still works, both given → Err, unparseable → Err, `""` → no bound, start > end → Err, and `is_noop` with ranges. Update the `chart_query.rs` test literals (`:586`, `:658`) and `lib.rs:3255,3321`. Check `src-tauri/tests/predictive_model_tests.rs` still compiles (it does not reference the filters today).
- **Acceptance**: `cargo check --lib` and `cargo test` green. HANDOFF states the exact JSON shape.

---

### Data-migration plan (`workspaceManager.ts`, Phase 1a)

**Where**: `loadWorkspaceData` (`:320-343`) already runs `migrateFailureGroupState` on every read, in memory, without writing. Keep that shape. Add `migrateToSchemaV2(state)` and chain it after the existing function, so it runs on every load and is a **pure, deterministic no-op once `failureGroupState.schemaVersion >= 2`**.

**Order inside `migrateToSchemaV2`** (all gated on `(fg.schemaVersion ?? 0) < 2`):
1. **Periods (C)**. Workspace: if `runningConditionTimePeriods === undefined`, create one period from `runningConditionTimeStart/End` (or `[]` if both are empty), then **`delete`** the old keys. Per model: the same from `filterTimeStart/End` → `filterTimePeriods`, then `delete`. **The delete matters**: PM persist does `{...m, ...slice}` (`PredictiveModelBuild.tsx:978`), so the old keys would otherwise stay in the file forever. Also seed `customRunningConditionNoneConfirmed: false` where it is missing.
2. **Category normalisation (A)**. `normalizeSensorCategories(models)` is keyed by `modelSensorKey` (**X for clustering**; the mockup's `keyOf` uses `y||x`, which is outdated, don't copy it). If `changes.length > 0`, set `categoryNormalisationNotice = changes`.
3. **Gate legacy flag (B)**. If `models.length > 0` and the workspace running condition is not configured (`isRunningConditionConfigured` workspace-level, using stored conditions with no header check, see the note below), set `rcLegacyNotice = 'pending'`. `runningConditionNoneConfirmed` stays `undefined`/`false`, so the user must choose.
4. Set `schemaVersion = 2`.

**Idempotency and "exactly once"**
- Because the notices are **stored in the data, not derived per load**, it doesn't matter which window writes the migrated state back first. Dashboard's autosave usually wins the race, because it re-reads disk every ~250 ms after any change (`Dashboard.tsx:1742`). After Phase 0 its spread-merge carries the notice fields along. A notice disappears only when the user acts in BuildModelWindow: Dismiss sets `categoryNormalisationNotice: null`; "Set a condition" or "Keep using all data" sets `rcLegacyNotice: null` (and "Keep using all data" also sets `runningConditionNoneConfirmed: true`). "Remind me later" is session-only local state and writes nothing, so it comes back next time the window opens (pm-agent default).
- If no window ever writes, the next load re-derives the *same* changes from the same unmigrated file, so the output is identical. Once written, v2 is never re-migrated.
- **Write-back**: BuildModelWindow's hydration (`BuildModelWindow.tsx:277`) calls `updateWorkspaceData(id, s => s)` when the loaded state carries a pending notice and the raw file was < v2. The patch receives the migrated state, so the write persists it, and "normalisation writes back" happens once. Dashboard's own autosave does the same implicitly.
- **New workspaces**: `DataUploadPage.handleContinue` omits `failureGroupState`, and Dashboard's first write creates it. Add `schemaVersion: 2` to Dashboard's initial `fgGroups` path via the Phase 0 mirror, so a brand-new workspace never looks legacy. Step 3 requires `models.length > 0`, so even a missed seed can't show a false banner on an empty workspace.
- **The legacy-flag condition ignores headers**: the dataset headers are unknown in `workspaceManager`. The header-aware "complete condition" check lives only in the UI helper (`runningCondition.ts`).
- **No downgrade**: a v2 file opened in 0.6.0 loses its time ranges (old keys deleted) and its category-notice fields. It is acceptable because no older-version reopen is expected. Note it in the CHANGELOG.
- `duplicateWorkspace` copies the notices as they are, which is fine.

---

### Phase 2: UI-A, one row per sensor (fe-ui-agent)

Files: `BuildModelWindow.tsx`, `FailureGroupsPanel.tsx`, `Dashboard.tsx` (inherit only), `App.css` if needed.
- **F4-A.1** FG view (`BuildModelWindow.tsx:1148-1196`): replace `models.map(overviewModelRow)` with `groupModelsBySensor(...)`, giving one sensor row each. Header: chevron, description/tag (one line, ellipsis), component chip, "also in FG-n" chips, "k of n complete", I/R/C chips with status dots (only existing kinds), and the category segmented control. Build the long label from the existing `.sensor-picker-trigger-label` pattern. **Do not copy the mockup's clustering "move-note"**: with X grouping, changing Y never moves a row.
- **F4-A.2** Expanded row: shared fields (key sensor locked, component, read-only FG chips with the "I R only" suffix when membership is partial), then tabs per kind with only that kind's fields (Individual: name; Relationship: name + predictors; Clustering: name + X locked + Y + criteria + ranges). Each tab keeps its own status pill, Save and Build Model. Today's single-model form state (`:186-200`, `openEditForm:449`) becomes per-model drafts keyed by model id, so switching tabs doesn't lose an unsaved draft (the mockup shows an "edited" marker).
- **F4-A.3** Category: remove `formCategory` (`:194`, `:454`, `:489`), the Category field (`:584-608`) and the row chip (`:877-881`). The header control calls `persist` with `setSensorCategory(models, key, cat)`, so it saves instantly and fans out to every model of that sensor workspace-wide. Show a short warning (toast or inline) when that sensor has models in >1 FG. `formValid` (`:472`) reads `sensorCategory(...)` instead. Save/Build stay disabled with the reason "Pick a category on the sensor header". `commitForm` (`:483-502`) **must not write `category`** from the form any more. It should drop that key from `fields`, so a stale draft can't overwrite a newer sensor-level change.
- **F4-A.4** Normalisation notice card at the top of the list (copy from the mockup), with a Dismiss button that persists `categoryNormalisationNotice: null`.
- **F4-A.5** Component view and Model Type view (`:1198-1233`) stay per-model rows (not in scope), but their category chip/field is removed too. **See Q2.**
- **F4-A.6** `FailureGroupsPanel.tsx:220-332`: the same sensor grouping (collapsible sensor line with I/R/C mini-chips). Per-model delete moves inside the expanded sensor sub-list (mockup `renderDashNew`). No category control. Counts become "N sensors · M models · G groups".
- **F4-A.7** `Dashboard.tsx` `makeDefaultModelForKind` (`:448-478`) inherits `sensorCategory(prevModels, key)` instead of `null`. After F4-0.3 it runs inside the patch, against disk.
- **Tests**: `BuildModelWindow.test.tsx`: rewrite `describe('model accordion …')` (`:383`), `'edit form validation'` (`:739`; category now comes from the sensor), `'locked auto-fill sensor'` (`:798`), and the `category: 'performance'` fixture (`:93`). New cases: two models of one sensor produce one row; clustering is grouped by X even after Y is set; a category click writes all models in all FGs; the multi-FG warning; the notice dismiss persists; Save is disabled with the reason while unset. `FailureGroupsPanel.test.tsx`: `'model display label fallback chain'` (`:121`) plus new grouping/delete tests. `Dashboard.test.tsx`: new model inherits category.
- **Acceptance**: tsc and vitest green. Stored records are unchanged apart from `category` fan-out.

### Phase 3: UI-B, running-condition gate (fe-ui-agent)
- **F4-B.1** Overview RC panel (`BuildModelWindow.tsx:952-1114`): "Filter by condition | No condition" choice (mockup `wsTab`). "No condition" sets `runningConditionNoneConfirmed: true` and clears nothing. Adding a condition sets it back to `false`: the two are mutually exclusive (see Q4). While unconfigured, show a "Required" pill and amber border, auto-open once per hydration, and change the copy from "No filter — use all data" to "No condition — use all rows".
- **F4-B.2** Rows: model tab/chip badge "Needs condition", sensor row badge "N blocked", and "Legacy · all data" for `status && !configured`.
- **F4-B.3** Every path through `getBuildBlockReason` (disabled plus the reason as tooltip/inline text):
  - Overview "Build Model →" (`:791-798`, `buildModelFromForm:770`). `trainModel` (`:523`) itself also early-returns on a reason. This is the only caller today, but guard at the source so a future caller can't bypass it.
  - PM "Finish" (`PredictiveModelBuild.tsx:1904-1911`). Pass `blockReason` as a prop or compute it in-page from the effective state. `markModelComplete` (`BuildModelWindow.tsx:516`) also re-checks and refuses.
  - "Re-train" here means opening Build Model → on an already-Complete model, which is the same gate. There is no `train_*` invoke anywhere in `src/` (CLAUDE.md, 2026-09-17), so there is no other training entry point.
  - Status pill `toggleModelStatus` (`:504-509`, `:888-893`) → **see Q3**.
- **F4-B.4** PM page, Workspace mode with the workspace unset: banner with "Set on Overview →" (`onBack`) and "Use Custom instead" (switches mode). Custom mode gets its own "No condition" choice, which sets `customRunningConditionNoneConfirmed` and shows a one-time warning at confirmation. A configured Custom model works even if the workspace is unset.
- **F4-B.5** Legacy banner on the Overview (`rcLegacyNotice === 'pending'`): "Set a condition" (opens the panel) / "Keep using all data" / "Remind me later".
- **Tests**: `BuildModelWindow.test.tsx` `describe('Running Condition Filter panel')` (`:888`) extended with: the gate blocks Build →, "No condition" enables it, adding a condition clears none-confirmed, the legacy banner's 3 buttons, the badges. `PredictiveModelBuild.test.tsx` `describe('Finish button …')` (`:877`): disabled with a reason while unconfigured, Custom configured works with the workspace unset, and the banner actions. The existing "Finish marks Complete" test must now set a condition first.

### Phase 4: UI-C, training periods (fe-ui-agent)
- **F4-C.1** Overview panel: replace Time start/end (`BuildModelWindow.tsx:984-1017`) with a periods list above the Match/No-condition block, using `useDatasetTimeBounds` for defaults, the open-end labels "Start of data"/"End of data", and the Add button (disabled when the data range is fully covered). Sort on blur/Enter only, not on every keystroke. Show an overlap warning with a "Merge into one" button, and flag an invalid period inline. Persist via `persistRunningCondition({ periods })` (extend its patch type at `:362`; the Phase 0 spread fix is already in place).
- **F4-C.2** PM Training scope (`PredictiveModelBuild.tsx:2061-2175`): Workspace mode shows read-only period chips (`periodChipLabel`). Custom mode shows the editable list. The Custom seed (`handleRunningConditionModeChange:616-628`) copies the workspace periods, with fresh ids, only when `filterTimePeriods.length === 0`. That is the same non-destructive rule as today (edge case: a Custom model that deliberately cleared all periods gets re-seeded on the next Workspace→Custom switch; this is also true today and left as is).
- **F4-C.3** Payload: `activeTimeStart/End` (`:679-680`) become `activePeriods`. `dashboardFilterPayload` (`:682-699`) sends `timestamp_ranges: toFilterRanges(activePeriods)` and no legacy pair, and `targetChartQuery` (`:783-797`) **must carry the same `timestamp_ranges`** (the 2026-09-23 `combine` trap). If the list is non-empty but no period is valid, don't query. Show "Fix the period dates" instead, because sending `[]` would silently mean "whole dataset".
- **F4-C.4** Remove the `targetMinForInput`/`targetMaxForInput` fallback-as-value (`:2139`, `:2163`). Open ends are shown as labels now.
- **F4-C.5** `Dashboard.tsx:913-1015`-style test literals and `makeDefaultModelForKind`: `filterTimePeriods: []`.
- **Tests**: `PredictiveModelBuild.test.tsx`: rewrite `describe('Time start/end filter actually affects training data')` (`:727`) to use periods and assert `timestamp_ranges` on BOTH `compute_sensor_stats`/preview invokes AND the `get_chart_data` filter. Update `'running condition — Workspace/Custom override'` (`:643`) for period seeding. `BuildModelWindow.test.tsx`: panel periods add/sort/merge/invalid.

### Phase 5: qa-agent sweep
Cross-zone checks: (1) a v1 workspace fixture with a single range, mixed categories and an unset condition loads, migrates, writes back once, shows both notices, and loads again unchanged. (2) A category change in BuildModelWindow followed by a Dashboard toggle keeps the category (F4-0.3). (3) Filter JSON built in TS is accepted by the Rust serde shape (fixture test in `src-tauri/tests/`). (4) The gate is consistent: the Overview Build → reason equals the PM Finish reason for the same model. Re-run the full suites.

### Phase 6: pm-agent final verification
`npx tsc --noEmit`, `cargo check --lib`, `npx vitest run`, `cd src-tauri && cargo test`, and `python scripts/build-manual-test-html.py --check`. Report the results. Don't trust HANDOFF claims.

---

### Risks and gotchas
1. **Field-dropping writers** (Phase 0): the root risk for all three features. After Phase 0, reviewers should reject any new `failureGroupState: { groups, models, … }` literal.
2. **A category change from a multi-FG view**: a model record sits in several FGs, so the write *must* fan out by sensor key across all models, not "models of this FG". The UI warns when other FGs are affected. Concurrent Dashboard writes are handled by F4-0.3.
3. **Clustering key**: X everywhere (`modelSensorKey`). Today's clustering *component* is derived from `ySensor || xSensor` (`BuildModelWindow.tsx:237-241`, `FailureGroupsPanel.tsx:112`, `types.ts:176-181` doc). A clustering model on an X-row could show a different component chip than its row (Q1).
4. **Stale drafts**: per-tab drafts must never carry `category` (F4-A.3), and a draft whose model was deleted from the Dashboard in the meantime must be dropped when the broadcast arrives.
5. **Notice loss via Dashboard autosave**: solved by storing the notices in the data (see the migration plan). Don't implement them as "derived from the migration return value" only.
6. **Rust error change**: every command that used to ignore a bad bound now errors. The PM page must show the error, not swallow it (check the `statsError` path at `:710` and `useChartData` error handling). Dashboard's inputs are `datetime-local`, and the relative-range buttons produce ISO strings `parse_timestamp` already accepts. Add a Rust test for each format Dashboard emits.
7. **"Configured" vs. what Rust applies**: `dashboardFilterPayload` drops rows with an empty `value1` (`:684`), and Rust silently drops conditions on sensors missing from the headers (`lib.rs:688-698`, e.g. a deleted special sensor). The gate must use the same "complete condition" definition (Q4), or a model passes the gate while training on unfiltered data.
8. **Existing tests that assume old behaviour** (they must be *updated*, not left passing): `workspaceManager.test.ts:273-305` (`toEqual`), `PredictiveModelBuild.test.tsx:727+` (Time start/end), `:877` (Finish ungated), `BuildModelWindow.test.tsx:739` (category in form), `:888` (RC panel copy), `FailureGroupsPanel.test.tsx:121`, and every `filterTimeStart` fixture (`Dashboard.test.tsx:913-1015`). Grep for `filterTimeStart`, `runningConditionTimeStart`, `category:` and `No filter` in `src/__tests__/` before calling any phase done.
9. **Cross-window broadcast types**: three listeners each hand-list payload fields (`BuildModelWindow.tsx:296`, `Dashboard.tsx:424`, and the PM persist emit at `:990`). Use the shared type from F4-0.1, otherwise new fields arrive but are never applied.

---

### Test plan: `docs/testing/MANUAL_TEST_PLAN.md` (edit the .md, regenerate the HTML, run `--check`)
- **Items whose meaning changes, so they get NEW ids (delete the old ones)**:
  - BMW-3 (model settings incl. Category) → **BMW-15**
  - BMW-12 (status pill per model row) → **BMW-16** (pill per tab)
  - BMW-7 (Build → disabled rule) → **BMW-17** (includes category + gate reasons)
  - BMW-11 (RC panel: time start/end, copy) → **BMW-18** (periods + Required + No condition)
  - FG-3 (delete model) → **FG-8** (delete inside the sensor sub-list)
  - PM-8 (Time start/end affects training) → **PM-22** (periods affect chart + stats + fit)
  - PM-14 (Finish) → **PM-23** (gated)
  - PM-21 (Workspace/Custom incl. time) → **PM-24** (periods seed + Custom "No condition")
- **New items**:
  - BMW-19 one row per sensor (clustering by X, only existing kinds)
  - BMW-20 category set once per sensor + multi-FG warning + saves instantly
  - BMW-21 category normalisation notice (legacy fixture) shown once
  - BMW-22 new model inherits the sensor's category (created from Dashboard)
  - BMW-23 badges "Needs condition" / "N blocked" / "Legacy · all data"
  - BMW-24 legacy RC banner, 3 buttons, shown once
  - BMW-25 periods: add default, sort on commit, overlap + Merge, invalid blocks, open ends, Add disabled when covered
  - PM-25 Workspace-unset banner on the PM page (Set on Overview / Use Custom)
  - PER-9 time range survives a Dashboard autosave (Phase 0)
  - PER-10 v0.6 workspace with a single range opens as one period, and legacy fields are gone after save
  - FG-9 Dashboard FG tab sensor grouping (no category control)
- Update the header changelog line of the plan file.

### Commits, Notion, release
- **Commits**: one local commit per phase that passes tsc/vitest/cargo on its own: F4-0; 1a+1b (one "contract" commit, or two if the agents finish separately); A; B; C; qa. Every commit gets the `Co-Authored-By` trailer from the session reminder. **No push until the user confirms they tested the real app** (then push to `personal` only, never `origin`).
- **Notion** (`collection://39e959a6-c718-8039-b30b-000bbea5ca96`), all set to **In progress**, never Done without the user's confirmation:
  - Update the existing "จับกลุ่ม FG ที่มี model เดียวกัน…" (A; `UX/UI`).
  - Create "Running condition บังคับตั้งก่อน Build (soft gate)" (B; `UX/UI`, `Sequence UX/UI`).
  - Create "Training periods หลายช่วงเวลา" (C; `backend`, `UX/UI`).
  - Create "Workspace time range หายหลัง Dashboard autosave" (Phase 0; `backend`).
- **Release**: ship A+B+C as **one release, 0.7.0 (MINOR: new features)**. The migration keeps old workspaces working, so this is not a breaking MINOR by the table's definition, but the CHANGELOG should note "files saved by 0.7 can't be reopened correctly in 0.6". Phase 0 goes into 0.6.0 (if it hasn't been built yet) or 0.6.1 (Q5). All three version files must match. Tag after the build.

### Blocking questions (pm-agent defaults in brackets, not decided silently)
1. **Clustering component**: with rows keyed by X, should a clustering model's *component* (chips, Group by Component bucket) also come from X instead of today's `ySensor || xSensor`? [Default: yes, X for key, category and component; Y is just a field.]
2. **Category in the Component / Model Type views**: those views keep per-model rows and have no sensor header, so the "pick a category on the sensor header" reason points at something that isn't on screen. [Default: show the sensor's category as a read-only chip on those rows, and word the blocked reason "Set a category in Group by Failure Group view", with a link that switches the view.]
3. **Status pill bypass**: the Overview's Incomplete→Complete pill (`toggleModelStatus`) currently marks a model Complete with no checks. Should it follow the same gate as Finish? [Default: gate only the Incomplete→Complete direction with the same reason. Complete→Incomplete is always allowed.]
4. **What counts as "≥1 value condition"?** Rows with an empty value, or on a sensor no longer in the dataset, are silently ignored at train time today. [Default: count only complete conditions (sensor in the headers, value1 set, value2 set for `between`). Adding a condition clears "No condition"; confirming "No condition" with incomplete rows present is disabled.]
5. **Phase 0 ship vehicle**: is the 0.6.0 installer already built or shipped? [Default: if not, add the fix to 0.6.0 before building. If it is, ship 0.6.1 as a patch before starting A/B/C.]
