# Requirements: Hybrid Rust/Python Architecture for Predictive Model

## Feature: Move "easy" model logic from Python sidecar to Rust, keep `pygam` LinearGAM in Python

### Background & Motivation

The Python sidecar currently bundles `pandas + scikit-learn + scipy + numpy + pygam` and is built with **Nuitka** for IP protection. Nuitka builds keep crashing (see `nuitka-crash-report.xml`) because of the heavy Cython surface of `pandas` and `scikit-learn`.

**The only piece that genuinely requires Python is `pygam.LinearGAM`** (no Rust equivalent). Everything else (mean/sd, r²/RMSE, GMM with 1 component, DataFrame projection, NaN drop) can run in Rust.

If we move those out, the Python sidecar will only need `numpy + scipy + pygam` — a much smaller and more Nuitka-friendly footprint, while still protecting the LinearGAM logic that is our actual IP.

### Goals

1. Reduce Python sidecar dependencies from `{pandas, sklearn, scipy, numpy, pygam}` → `{numpy, scipy, pygam}`.
2. Move all non-LinearGAM math to Rust where it is faster, smaller, and reverse-engineering-resistant by default.
3. Make Nuitka builds reproducible.
4. Keep numerical results within ±1e-9 of the original Python implementation (hash-test against fixed datasets).

### Non-Goals

- Do **not** rewrite `pygam.LinearGAM` in Rust. Stays in Python.
- Do **not** modify `src-tauri/python/soothsayer-wizard-python/wizard.py`. The folder is upstream and must remain untouched. Any logic we want to keep in Python must be **copied** into `src-tauri/python/backend.py`.
- Do **not** break existing `compute_sensor_stats` / `preview_relationship_model` callers — they may be replaced or extended, but the Predictive Model Build UI must stay functional throughout.

---

## Architecture Target

```
┌────────────────────────────────────────────────────────────────┐
│ Frontend (React / TypeScript)                                   │
│   PredictiveModelBuild.tsx — invokes Rust commands              │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Rust (src-tauri/src/)                                           │
│   - compute_sensor_stats          (already exists)              │
│   - compute_individual_model      (NEW — replaces python)       │
│   - compute_clustering_model      (NEW — GMM 1-cluster + SVD)   │
│   - compute_regression_metrics    (NEW — r², RMSE)              │
│   - preview_relationship_model    (existing — calls sidecar)    │
│   - train_relationship_model      (NEW — calls sidecar, saves)  │
└────────────────────────────────────────────────────────────────┘
                              │  (only for relationship)
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Python sidecar (src-tauri/python/backend.py — Nuitka-compiled)  │
│   Dependencies: numpy + scipy + pygam (+ progressbar2)          │
│   Actions:                                                      │
│     - preview_relationship   (LinearGAM fit + predict + r²)     │
│     - train_relationship     (LinearGAM fit + pickle save)      │
└────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Self-contained `backend.py` (no `wizard.py` import)

### Owner: `rust-agent` (because they own `src-tauri/`, including `python/`)

### Goal
Make `src-tauri/python/backend.py` self-contained — copy only the LinearGAM logic from `wizard.py` directly into `backend.py`. Remove the `sys.path.insert` import of the `soothsayer-wizard-python` package. Remove all dependency on `pandas` and `sklearn` inside `backend.py`.

### Tasks
1. **Copy LinearGAM logic** from `wizard.py` into `backend.py`:
   - `Wizard.PreviewModel.relationship` → adapt as `preview_relationship(payload)` — but **without using pandas DataFrame**. Accept the input as `{predictors: [...], target: "...", X: [[...]], y: [...], linearGAM_lambda: ...}` where `X` and `y` are already cleaned by Rust.
   - `Wizard.SaveThisSensor._execute_relationship` → adapt as `train_relationship(payload)` — fits the model, computes r²/2·RMSE **using numpy only** (no sklearn), pickles the model to disk, returns the metrics + the predicted/residual columns + the saved model path.
2. **Remove pandas/sklearn imports** from `backend.py`. Use:
   - `numpy` for array ops
   - `pygam.LinearGAM` for the model
   - `pickle` (stdlib) for model serialisation
   - `json` (stdlib) for I/O
3. **r²/RMSE in numpy**:
   ```python
   def _r2(y_true, y_pred):
       ss_res = float(np.sum((y_true - y_pred) ** 2))
       ss_tot = float(np.sum((y_true - np.mean(y_true)) ** 2))
       return 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
   def _rmse(y_true, y_pred):
       return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))
   ```
4. **Update Rust** — `preview_relationship_model` in `lib.rs` must now send pre-cleaned `X` (matrix of predictors) and `y` (vector of target) instead of `{headers, rows}`. NaN drop happens fully on the Rust side.
5. **DO NOT MODIFY** `src-tauri/python/soothsayer-wizard-python/wizard.py`. It is read-only reference material.

### Acceptance Criteria
- [ ] `backend.py` imports only: `sys`, `os`, `json`, `pickle`, `traceback`, `numpy`, `pygam`. No `pandas`, no `sklearn`, no `wizard` import.
- [ ] `pip install numpy scipy pygam` is sufficient to run `backend.py` standalone.
- [ ] Manual smoke test passes:
  ```bash
  echo '{"action":"preview_relationship","payload":{"predictors":["P1"],"target":"T","X":[[1],[2],[3],[4]],"y":[2,4,6,8],"linearGAM_lambda":1}}' | python backend.py
  ```
  → returns `{"request":"...","r2":..., "rmse2":..., "predicted":[...], "residual":[...]}` (no error).
- [ ] `cargo check` passes with the updated `preview_relationship_model` payload shape.
- [ ] Predictive Model Build "Apply" on Relationship still works end-to-end (manual UI test acceptable until QA phase).

### Contract — sidecar I/O
**Input** (one JSON line on stdin):
```json
{
  "action": "preview_relationship",
  "payload": {
    "predictors": ["P1", "P2"],
    "target": "T",
    "X": [[1.0, 2.0], [1.5, 2.1], ...],   // n_rows × n_predictors (no NaN)
    "y": [3.0, 3.6, ...],                   // n_rows (no NaN)
    "linearGAM_lambda": 10000
  }
}
```
**Output** (one JSON line on stdout):
```json
{
  "request": "preview_relationship",
  "r2_per_step":   [0.85, 0.91],            // cumulative: features[:1], features[:2], ...
  "rmse2_per_step":[0.34, 0.21],            // 2 * RMSE per cumulative step
  "predicted":     [3.05, 3.61, ...],       // full-model prediction (length = n_rows)
  "residual":      [-0.05, -0.01, ...]      // y - predicted
}
```

---

## Phase 2: Rust — r² / RMSE / metric helpers

### Owner: `rust-agent`

### Goal
Provide a Rust module with statistically sound metric helpers that can be reused by Individual, Clustering, and (for sanity-check) Relationship.

### Tasks
1. New module `src-tauri/src/metrics.rs` with:
   ```rust
   pub fn r2_score(y_true: &[f64], y_pred: &[f64]) -> f64;
   pub fn rmse(y_true: &[f64], y_pred: &[f64]) -> f64;
   pub fn mean(values: &[f64]) -> f64;
   pub fn population_sd(values: &[f64], mean: f64) -> f64;
   pub fn sample_sd(values: &[f64], mean: f64) -> f64;   // Bessel's correction (matches pandas .std())
   ```
2. All functions must:
   - Handle empty/single-element inputs by returning `f64::NAN` (not panicking).
   - Match Python output to within 1e-9 on a fixed test fixture.
3. Add unit tests in `src-tauri/src/metrics.rs` with at least 3 hand-computed cases per function.

### Acceptance Criteria
- [ ] `cargo test --lib metrics` passes.
- [ ] No external crate dependencies beyond what's already in `Cargo.toml` (use `std` only).

---

## Phase 3: Rust — Individual model

### Owner: `rust-agent`

### Goal
Replace `wizard.SaveThisSensor._execute_individual` with a Rust command. The current `compute_sensor_stats` already covers the *preview* — this phase adds the **save/persist** equivalent.

### Tasks
1. Refactor `compute_sensor_stats` to internally use `metrics::mean` and `metrics::sample_sd` (note: `wizard.py` uses pandas `.std()` which is **sample** sd by default — switch from population to sample for parity).
2. New command `train_individual_model(target: String, model_name: Option<String>, save_path: String) -> IndividualModelInfo`:
   - Computes mean, sd (sample), 1σ boundary, 3σ boundary across all non-NaN target values.
   - Builds the `INDIVIDUAL_INFO` JSON structure (see `wizard.py` → `Wizard.PredictiveImplementationTemplate.INDIVIDUAL_INFO`).
   - Writes `{save_path}/output/{target}/INDV_INFO_{target}.json`.
   - Returns the same JSON to the frontend.
3. Use `chrono` (or whatever's already in `Cargo.toml`) for `updated_timestamp` ISO strings. If timestamps in the dataset are strings, parse them to find min/max for `training_set_start_date`/`training_set_end_date`.

### Contract
```rust
#[derive(Serialize)]
struct IndividualModelInfo {
    model_name: String,
    publish_id: i64,
    training_set_start_date: String,
    training_set_end_date: String,
    mean: f64, sd: f64,
    boundary_1sd: [f64; 2],
    boundary_3sd: [f64; 2],
    saved_path: String,    // absolute path to JSON file written
}
```

### Acceptance Criteria
- [ ] Output JSON structure matches `wizard.py`'s `INDIVIDUAL_INFO` exactly (same keys, same nesting).
- [ ] Numerical values match a Python reference output to within 1e-6.
- [ ] Existing Individual stats strip in `PredictiveModelBuild.tsx` continues to work via `compute_sensor_stats` (unchanged contract).

---

## Phase 4: Rust — Clustering model (GMM, 1 cluster, full covariance)

### Owner: `rust-agent`

### Goal
Replace `wizard.PreviewModel.clustering` and `wizard.SaveThisSensor._execute_clustering` for the **single-cluster case** (where `n_components=1`). When `n_components=1`, GMM with full covariance simplifies to: mean = sample mean, covariance = sample covariance matrix. No EM iteration needed.

For multi-cluster (`n_components > 1`): out of scope for this phase — keep emitting an error or fall back to the existing Python path if applicable.

### Tasks
1. Add dependency: `nalgebra = "0.33"` (or current stable) to `Cargo.toml` for SVD.
2. New module `src-tauri/src/clustering.rs` with:
   ```rust
   pub struct EllipseFit {
       pub x_center: f64,
       pub y_center: f64,
       pub x_sd: f64,         // major-axis std (after rotation)
       pub y_sd: f64,         // minor-axis std
       pub angle_deg: f64,    // rotation angle of major axis
   }
   pub fn fit_single_cluster_ellipse(xs: &[f64], ys: &[f64]) -> Result<EllipseFit, String>;
   ```
   Implementation:
   - Compute means.
   - Compute 2×2 sample covariance matrix.
   - SVD via `nalgebra::SVD`. Match Python's behaviour: `angle = atan2(U[1,0], U[0,0]).to_degrees()`, `(major_sd, minor_sd) = sqrt(singular_values)`.
3. New command `compute_clustering_preview(first_sensor: String, second_sensor: String, n_clusters: u32, criteria_sensor: Option<String>, cluster_ranges: Option<HashMap<String,[f64;2]>>) -> ClusteringPreview`:
   - For now, **support only `n_clusters == 1`**. If `n_clusters > 1` return `Err("Multi-cluster not yet supported in Rust port — falling back required")`.
   - Project the two sensors, drop NaN rows, call `fit_single_cluster_ellipse`.
4. New command `train_clustering_model(...)` analogous to `train_individual_model` — writes `CLUS_INFO_*.json` to disk.

### Acceptance Criteria
- [ ] `fit_single_cluster_ellipse` reproduces sklearn's GMM output for `n_components=1` to within 1e-6 on a hand-prepared fixture.
- [ ] Output JSON for save matches `wizard.py`'s `CLUSTERING_INFO` template.
- [ ] Unit tests cover: 2D Gaussian sample → recovers mean/cov, axis-aligned ellipse → angle ≈ 0.

---

## Phase 5: TypeScript contract & UI integration

### Owner: `fe-logic-agent` (types + bindings) → then `fe-ui-agent` (UI wiring)

### Goal
Surface the new Rust commands to the frontend and wire the relationship/individual/clustering Apply buttons.

### Tasks (fe-logic-agent)
1. Update `src/types/commands.ts`:
   - Update `preview_relationship_model` return type to match the new sidecar contract (`r2_per_step`, `rmse2_per_step`, `predicted`, `residual`) — replace existing `RelationshipPreviewResult`.
   - Add `train_relationship_model`, `train_individual_model`, `train_clustering_model`, `compute_clustering_preview`.
2. If there is a hook `useRelationshipPreview` etc., create one to centralise invoke + state.

### Tasks (fe-ui-agent)
3. In `src/components/windows/PredictiveModelBuild.tsx`:
   - Update `handleRelationshipApply` to read the new field names.
   - Wire `handleClusteringApply` to call `compute_clustering_preview`. Show the ellipse parameters in the right-column config block (or in a placeholder for now if scatter chart not ready).
   - Add a new Save flow that calls the appropriate `train_*_model` commands when the user hits "Save This Sensor Model(s)".
   - Display residual stats (mean residual, residual sd) in the Stats Strip when relationship preview returns.

### Acceptance Criteria
- [ ] `npx tsc --noEmit` passes.
- [ ] All three Apply buttons (Individual is read-only / Relationship / Clustering) produce results without errors.
- [ ] No `any` types introduced — every invoke return is fully typed.

---

## Phase 6: Nuitka rebuild & verification

### Owner: `rust-agent` (sidecar build) + `qa-agent` (smoke tests)

### Goal
Produce a working Nuitka-compiled sidecar with the slimmed-down dependency set and verify the full Predictive Model Build flow.

### Tasks
1. Create `src-tauri/python/build_sidecar.sh`:
   - Activates a `.venv` in the same folder.
   - Runs Nuitka with these flags (proven safer for scientific stacks):
     ```bash
     python -m nuitka \
       --onefile --standalone \
       --enable-plugin=numpy \
       --enable-plugin=anti-bloat \
       --include-package=pygam \
       --include-package=scipy \
       --jobs=2 \
       --lto=no \
       --output-dir=build \
       backend.py
     ```
   - On success, copies the artifact to `../bin/backend-$(rustc -vV | sed -n 's/host: //p')` and chmods it executable.
2. Create `src-tauri/python/requirements.txt` listing exactly: `numpy`, `scipy`, `pygam`, `nuitka` (+ pinned versions known to work).
3. Document in the script header how to install Xcode CLT / build tools per OS.
4. **Smoke test** (qa-agent):
   - Build the sidecar.
   - Pipe a known JSON payload to it manually, verify output matches a Python reference.
   - Launch the Tauri app, run Apply on Relationship/Individual/Clustering, check no errors in console.

### Acceptance Criteria
- [ ] Nuitka build completes in under 15 minutes on an M-series Mac without crashing.
- [ ] Output binary size < 200 MB.
- [ ] `bin/backend-aarch64-apple-darwin` is non-empty and executable (current file is 0 bytes).
- [ ] End-to-end: open app → load CSV → go to Predictive Model Build → Apply Relationship → see R²/RMSE populate.

---

## File Ownership Summary

| File | Owner Agent | Phase |
|---|---|---|
| `src-tauri/python/backend.py` | rust-agent | 1, 6 |
| `src-tauri/python/build_sidecar.sh` | rust-agent | 6 |
| `src-tauri/python/requirements.txt` | rust-agent | 6 |
| `src-tauri/python/soothsayer-wizard-python/**` | **READ-ONLY — DO NOT MODIFY** | — |
| `src-tauri/src/lib.rs` | rust-agent | 1, 2, 3, 4 |
| `src-tauri/src/metrics.rs` (new) | rust-agent | 2 |
| `src-tauri/src/clustering.rs` (new) | rust-agent | 4 |
| `src-tauri/Cargo.toml` | rust-agent | 4 |
| `src/types/commands.ts` | fe-logic-agent | 5 |
| `src/hooks/*` (any new hooks) | fe-logic-agent | 5 |
| `src/components/windows/PredictiveModelBuild.tsx` | fe-ui-agent | 5 |
| `src/__tests__/**`, `src-tauri/tests/**` | qa-agent | 6 |

---

## Critical Constraints (must read before starting)

1. **`soothsayer-wizard-python/wizard.py` is read-only.** Treat it like a vendored library. All copying happens *into* `backend.py`.
2. **Numerical parity is non-negotiable.** Every Rust port must match Python output to within 1e-6 (1e-9 for trivial metrics) on at least one fixed fixture. If you can't match it, surface the discrepancy in the HANDOFF block — do not silently ship.
3. **No regressions.** The existing `compute_sensor_stats` and the existing Predictive Model Build UI must continue to work at every phase boundary. Land each phase as an independently shippable change.
4. **Sample vs population SD.** `wizard.py` uses pandas `.std()` (sample sd, ddof=1). Our existing Rust `compute_sensor_stats` uses population sd. Phase 2/3 must reconcile this — switching to sample is the correct path for wizard parity.
5. **Pickle compatibility.** The pickled LinearGAM model in `_execute_relationship` must remain loadable by `pygam` later. Don't change the model class or wrap it.

---

## Suggested PM Phase Ordering

Phases 1, 2, 3, 4 are largely independent — they could go in parallel if you have multiple workers. Recommended serial order if going one at a time:

1. **Phase 2** (metrics) — smallest, unblocks Phase 3.
2. **Phase 1** (backend.py self-contained) — unblocks Phase 6.
3. **Phase 3** (individual port) — uses Phase 2.
4. **Phase 4** (clustering port) — uses Phase 2.
5. **Phase 5** (TS + UI) — needs all backend phases to expose contracts.
6. **Phase 6** (Nuitka rebuild + QA) — final integration.
