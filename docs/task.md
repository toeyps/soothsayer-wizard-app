# Task Breakdown — Data Upload Page Redesign

## Status: In Progress

## Feature Summary
Redesign the Import CSV page into a full Data Upload Page with:
- Multi-file CSV upload with detailed validation report
- Mapping CSV upload with scrollable table preview
- Sensor tag-to-name mapping with color-coded results
- Mode selection (Free Exploration vs Soothsayer Predictive)
- Full auto-resume persistence

---

## Phase 1: Contract Definition

### fe-logic-agent
- [ ] **1.1** Add new types to `src/types/`: `CsvLoadReport`, `ColumnInfo`, `MappingData`, `MappingResult`, `MappingResultEntry`
- [ ] **1.2** Update `src/types/commands.ts` with new commands: `load_csv` (updated return type), `load_mapping_csv`, `apply_sensor_mapping`
- [ ] **1.3** Update `WorkspaceState` in `src/types.ts` to include `mappingFilePath`, `sensorMapping`, and `selectedMode`
- [ ] **1.4** Create `src/hooks/useDataUpload.ts` — hook managing upload page state, file selection, mapping, and mode selection
- [ ] **1.5** Create `src/hooks/useMappingData.ts` — hook for loading mapping CSV data and applying sensor tag mapping

### rust-agent
- [ ] **1.6** Update `load_csv` command to return `CsvLoadReport` (with column info, null counts, warnings, dtypes)
- [ ] **1.7** Implement `load_mapping_csv` command — parse a single CSV and return all rows/columns as structured data
- [ ] **1.8** Implement `apply_sensor_mapping` command — accept tag_column, name_column, mapping data, and dataset headers; return mapping results (matched, missing_in_dataset, missing_in_mapping)

---

## Phase 2: Implementation

### fe-ui-agent
- [ ] **2.1** Redesign `ImportScreen.tsx` as a two-panel layout:
  - Left panel: Dataset upload area + validation summary
  - Right panel: Mapping upload + mapping config + results
  - Bottom: Mode selection buttons
- [ ] **2.2** Build `DataValidationSummary` sub-component — shows column count, row count, dtype table, null counts, warnings
- [ ] **2.3** Build `MappingTable` sub-component — scrollable table (X+Y) displaying mapping CSV data
- [ ] **2.4** Build `MappingConfig` sub-component — dropdowns for tag/name columns + Apply button
- [ ] **2.5** Build `MappingResults` sub-component — color-coded results (green/yellow/red)
- [ ] **2.6** Build `ModeSelection` sub-component — two mode buttons at the bottom
- [ ] **2.7** Update `App.tsx` to handle `selectedMode` from workspace state for routing (dashboard vs predictive)
- [ ] **2.8** Wire all sub-components to hooks from Phase 1

---

## Phase 3: Testing

### qa-agent
- [ ] **3.1** Write unit tests for `useDataUpload` hook
- [ ] **3.2** Write unit tests for `useMappingData` hook
- [ ] **3.3** Write Rust tests for `load_mapping_csv` command
- [ ] **3.4** Write Rust tests for `apply_sensor_mapping` command
- [ ] **3.5** Write Rust tests for updated `load_csv` command (validation report)

---

## HANDOFF Reports
<!-- Worker agents will write HANDOFF blocks here -->
