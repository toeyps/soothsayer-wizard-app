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
