# Requirements: Data Upload Page (Import CSV)

## Feature: Data Upload Page — Redesign

### User Story
As a **data engineer**, I want a **comprehensive data upload page** that lets me import multiple CSV files, preview the parsed results, upload mapping data to rename sensor tags, and choose an analysis mode — so that I can **validate my data before starting analysis**.

### Description

This page is the **first step** of the application workflow. It replaces the current simple ImportScreen with a full **Data Upload Page** that includes:

1. **Upload Dataset** — Import multiple `.csv` files, parse and merge them.
2. **Data Validation Summary** — Display parsing results, column info, and warnings.
3. **Upload Mapping Data** — Import a single mapping CSV and preview it in a scrollable table.
4. **Sensor Tag Mapping** — Let user pick which columns map sensor tags to sensor names, then apply the mapping with a visual result report.
5. **Mode Selection** — Choose between "Free Exploration Mode" or "Soothsayer Predictive Implementation Mode" before proceeding.

---

### Section 1: Upload Dataset (Left Panel)

#### 1.1 File Upload
- [ ] Support uploading **multiple CSV files** (via file dialog or drag-and-drop)
- [ ] Display list of selected files with ability to remove individual files
- [ ] Show loading state during processing

#### 1.2 Dataset Assumptions (display to user as info/tooltip)
- The first column is always a **datetime** that can be parsed correctly
- **No duplicate column names** across files
- **No duplicate timestamps** within files
- Data has **no strange header/footer rows**
- Files must be in `.csv` format

#### 1.3 Parsing Logic (Backend — Rust)
- [ ] Parse the **first column as datetime** and merge all uploaded files into a single table (join on datetime)
- [ ] **Force parse every column** (except datetime) into numeric, replacing all strings with `Null/NaN`
- [ ] Detect and report:
  - Any initial **parsing/merging errors** + bad string values found
  - Total **number of columns** and **rows** after merge
  - **List of column names**, their datatypes, and null count post-parsing

#### 1.4 Data Validation Report (display after upload)
- [ ] Show a **summary panel** with:
  - Number of columns, number of rows
  - Columns with datatypes and null counts (like `pandas df.info()` output)
- [ ] **Warn** about:
  - Duplicated column names (across files)
  - Duplicate timestamps
  - Columns that had string values replaced with NaN (list them)

---

### Section 2: Upload Mapping Data (Right Panel)

#### 2.1 Mapping File Upload
- [ ] Support uploading a **single CSV file** for mapping data
- [ ] Display the mapping data in a **scrollable table** (both X and Y scrollable)
- [ ] Table should show all columns and rows from the mapping CSV

#### 2.2 Sensor Tag Mapping Configuration
- [ ] Provide a dropdown: **"Sensor Tag Column"** — user picks one column from the uploaded mapping data
- [ ] Provide a dropdown: **"Sensor Name Column"** — user picks one column from the uploaded mapping data
- [ ] **"Apply Mapping"** button to execute the mapping

#### 2.3 Mapping Result Report
After clicking "Apply Mapping":
- [ ] Show **number of columns successfully mapped** (color: green)
- [ ] List every column **found in mapping but doesn't exist in dataset** (color: yellow/warning)
- [ ] List every column **not found in mapping but exists in dataset** (color: red/error)
- [ ] Example format:
  - ✅ `100 sensors successfully mapped`
  - ⚠️ `PI123.PV found in mapping but doesn't exist in dataset`
  - ❌ `AB445.PV not found in mapping but exists in dataset`

---

### Section 3: Mode Selection (Bottom)

After data upload and optional mapping:
- [ ] Show two **mode buttons**:
  - **"Free Exploration Mode"** — Proceed to the Dashboard for open-ended data exploration
  - **"Soothsayer Predictive Implementation Mode"** — Proceed to the predictive model building workflow
- [ ] Selected mode determines the `lastRoute` saved in workspace state

---

### Acceptance Criteria
- [ ] User can upload multiple CSV files and see them merged into one dataset
- [ ] Parsed data summary (columns, rows, dtypes, null counts) is displayed
- [ ] Duplicate columns and timestamps are detected and warned about
- [ ] User can upload a mapping CSV and see it as a scrollable table
- [ ] User can select tag/name columns and apply mapping with color-coded results
- [ ] User can choose between Free Exploration or Soothsayer mode
- [ ] All state is persisted to workspace (Auto-Resume compatible)
- [ ] Page handles errors gracefully (bad CSV, missing columns, etc.)

### Priority: High
### Scope: fullstack

### Technical Notes

#### Frontend (React + Tailwind)
- Redesign `src/components/ImportScreen.tsx` (or split into sub-components)
- Scrollable table component needed for mapping preview
- Color-coded mapping results (green/yellow/red)
- Mode selection buttons at the bottom

#### Backend (Rust / Tauri)
- New or updated Tauri commands needed:
  - `load_csv` — update to return detailed parsing report (dtypes, null counts, warnings)
  - `load_mapping_csv` — new command to load mapping data and return as structured table
  - `apply_sensor_mapping` — new command that takes tag column + name column and returns mapping result report
- Use `rayon` for parallel parsing of multiple large CSV files

#### Existing Commands Reference (from `src/types/commands.ts`)
```typescript
export type TauriCommands = {
  load_csv:              { args: { paths: string[] };                                  returns: CsvMetadata }
  get_loaded_paths:      { args: {};                                                   returns: string[] }
  get_data:              { args: { sensors: string[] };                                returns: void }
  get_all_sensors:       { args: {};                                                   returns: string[] }
  load_metadata_command: { args: { path: string };                                     returns: SensorMetadata[] }
  calculate_new_sensor:  { args: { sensors: string[], config: SensorOperationConfig }; returns: string }
  run_python_analysis:   { args: {};                                                   returns: string }
}
```

#### Out of Scope
- This page is NOT a general-purpose data formatting tool (like Python pandas)
- No data editing/transformation on this page — only validation and mapping
