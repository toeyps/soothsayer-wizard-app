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

---
---

# Requirements: Hybrid Calculation Engine (Add Sensor Window)

## Feature: Flexible Sensor Calculation — Hybrid Mode

### User Story
As a **data engineer**, I want to create new calculated sensors using either a **simple dropdown** for common operations or an **advanced formula editor** for complex expressions — so that I can perform calculations **flexibly without code changes**.

### Problem Statement

ระบบ calculate ปัจจุบัน hardcode operation ทั้ง Frontend (TypeScript types, UI dropdowns) และ Backend (Rust `match` blocks) ทำให้การเพิ่ม operation ใหม่ต้องแก้ไข **อย่างน้อย 4 ไฟล์** (`types.ts`, `SensorTooling.tsx`, `lib.rs`, `commands.ts`) ทุกครั้ง

### Solution: Hybrid Approach (Simple + Advanced Mode)

UI จะมี 2 โหมดให้เลือก:

```
┌─────────────────────────────────┐
│  [ Simple ▼ ]  [ Advanced ▼ ]  │
├─────────────────────────────────┤
│ Simple:   [Sum ▼] + sensors     │
│ Advanced: = A + B * sqrt(C)     │
└─────────────────────────────────┘
```

---

### Part 1: Operation Registry (Single Source of Truth)

สร้าง registry กลางที่ทั้ง Frontend และ Backend อ่านจากที่เดียว

#### 1.1 Frontend Registry (`src/config/operations.ts`)
- [ ] สร้างไฟล์ registry กลางเก็บ operation ทั้งหมด
- [ ] แต่ละ operation ประกอบด้วย: `id`, `label`, `symbol`, `category`, `requiresValue`, `requiresBase`, `params[]`
- [ ] UI ทุกส่วน (dropdown, preview, validation) อ่านจาก registry นี้เท่านั้น
- [ ] เพิ่ม operation ใหม่ = เพิ่มแค่ entry ใน registry

```typescript
// ตัวอย่างโครงสร้าง
export const OPERATIONS = {
  single: [
    { id: 'add', label: 'Add (+)', symbol: '+', category: 'arithmetic', requiresValue: true },
    { id: 'abs', label: 'Absolute', symbol: 'abs', category: 'transform', requiresValue: false },
    { id: 'log10', label: 'Log₁₀', symbol: 'log10', category: 'transform', requiresValue: false },
    { id: 'sqrt', label: 'Square Root', symbol: '√', category: 'transform', requiresValue: false },
    { id: 'round', label: 'Round', symbol: 'round', category: 'transform', requiresValue: true, params: [{ name: 'decimals', type: 'number', default: 2 }] },
  ],
  multi: [
    { id: 'sum', label: 'Sum', category: 'aggregation', requiresBase: false },
    { id: 'mean', label: 'Average', category: 'aggregation', requiresBase: false },
    { id: 'moving_avg', label: 'Moving Average', category: 'time_series', requiresBase: false, params: [{ name: 'window_size', type: 'number', default: 10 }] },
    { id: 'rate_of_change', label: 'Rate of Change', category: 'time_series', requiresBase: false },
    { id: 'subtract', label: 'Subtract', category: 'arithmetic', requiresBase: true },
  ],
} as const;
```

#### 1.2 Backend Registry (Rust)
- [ ] สร้าง operation registry ใน Rust ด้วย `HashMap<&str, OperationFn>`
- [ ] แต่ละ operation เป็น function ที่ลงทะเบียนไว้
- [ ] เพิ่ม operation ใหม่ = เพิ่มแค่ `register()` call

```rust
// ตัวอย่างโครงสร้าง
fn build_single_ops() -> HashMap<&'static str, Box<dyn Fn(f64, f64) -> Option<f64>>> {
    let mut ops = HashMap::new();
    ops.insert("add",    Box::new(|a, b| Some(a + b)));
    ops.insert("abs",    Box::new(|a, _| Some(a.abs())));
    ops.insert("log10",  Box::new(|a, _| if a > 0.0 { Some(a.log10()) } else { None }));
    ops.insert("sqrt",   Box::new(|a, _| if a >= 0.0 { Some(a.sqrt()) } else { None }));
    ops
}
```

---

### Part 2: Simple Mode (Dropdown UI — Data-Driven)

Refactor `SensorTooling.tsx` ให้ render dropdowns จาก registry อัตโนมัติ

#### 2.1 UI Rendering
- [ ] Dropdown options สร้างจาก registry โดยอัตโนมัติ (ไม่ hardcode `<option>`)
- [ ] Group options ตาม `category` (arithmetic, transform, aggregation, time_series)
- [ ] แสดง/ซ่อน input fields ตาม `requiresValue` / `params[]` ของ operation ที่เลือก
- [ ] Preview formula อัตโนมัติจาก `symbol` ใน registry

#### 2.2 Config Generation
- [ ] สร้าง `SensorOperationConfig` จาก registry + user selection
- [ ] ส่งไป backend เป็น `{ operationId: string, sensors: string[], params: Record<string, number> }`

---

### Part 3: Advanced Mode (Formula Editor)

เพิ่ม tab ใหม่ใน `SensorTooling.tsx` สำหรับ power user

#### 3.1 Formula Editor UI
- [ ] Text input / textarea สำหรับพิมพ์สูตร
- [ ] **Autocomplete** sensor names (trigger ด้วย `$` หรือ typing)
- [ ] **Syntax highlighting** (sensor names, operators, functions)
- [ ] **Live preview** แสดง parsed formula + ตัวอย่างผลลัพธ์
- [ ] **Error feedback** แสดง syntax error แบบ real-time

#### 3.2 Formula Syntax
```
// ตัวอย่างสูตรที่ support
= $SensorA + $SensorB * 2
= avg($SensorA, $SensorB, $SensorC)
= abs($SensorA) / max($SensorB)
= $SensorA - moving_avg($SensorB, 10)
= sqrt(pow($SensorA, 2) + pow($SensorB, 2))
= clamp($SensorA, 0, 100)
```

**Syntax rules:**
- Sensor names อ้างอิงด้วย `$SensorName` หรือ `${Sensor Name With Spaces}`
- Built-in functions: `abs`, `sqrt`, `pow`, `log`, `log10`, `exp`, `ceil`, `floor`, `round`, `clamp`, `min`, `max`
- Aggregation functions: `sum`, `avg`, `median`, `std`
- Time-series functions: `moving_avg(sensor, window)`, `rate_of_change(sensor)`, `lag(sensor, periods)`
- Standard operators: `+`, `-`, `*`, `/`, `^`, `(`, `)`

#### 3.3 Backend Expression Engine (Rust)
- [ ] ใช้ crate เช่น `evalexpr` หรือ `fasteval` เป็น expression parser
- [ ] Register custom functions (`moving_avg`, `rate_of_change`, etc.) เข้า parser
- [ ] Validate formula ก่อน execute (return error ถ้า syntax ผิดหรือ sensor ไม่มี)
- [ ] New Tauri command: `evaluate_formula`

```rust
#[tauri::command]
fn evaluate_formula(
    formula: String,
    custom_name: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    // 1. Parse formula → AST
    // 2. Resolve $SensorName → column indices
    // 3. Evaluate row-by-row
    // 4. Append new column to data
    // 5. Return new sensor name
}
```

---

### Part 4: Shared Infrastructure

#### 4.1 Updated Types (`src/types.ts`)
- [ ] Replace hardcoded union types with flexible config:

```typescript
// แทนที่ของเดิม
export interface SensorCalculationConfig {
  mode: 'simple' | 'formula';
  // Simple mode
  simple?: {
    operationId: string;
    sensors: string[];
    params: Record<string, number>;
  };
  // Formula mode
  formula?: {
    expression: string;
  };
  customName?: string;
}
```

#### 4.2 Updated Backend Command
- [ ] Refactor `calculate_new_sensor` → รับ unified config แล้ว dispatch ตาม mode
- [ ] Simple mode → lookup operation จาก registry
- [ ] Formula mode → parse + evaluate expression

---

### Acceptance Criteria
- [ ] Simple Mode: เพิ่ม operation ใหม่โดยแก้แค่ registry file (FE + BE อย่างละ 1 ที่)
- [ ] Simple Mode: Dropdown render จาก registry อัตโนมัติ — ไม่มี hardcoded `<option>`
- [ ] Advanced Mode: User สามารถพิมพ์สูตรแบบ Excel-like ได้
- [ ] Advanced Mode: Autocomplete sensor names ทำงานได้
- [ ] Advanced Mode: Syntax error แสดง real-time
- [ ] Advanced Mode: Formula evaluate ถูกต้องกับทุก row ของ data
- [ ] ทั้ง 2 mode ใช้ `customName` ตั้งชื่อ sensor ใหม่ได้
- [ ] Backward compatible — existing calculated sensors ยังทำงานได้

### Priority: Medium
### Scope: Fullstack

### Technical Notes

#### Files to Modify/Create

| Action | File | Description |
|--------|------|-------------|
| NEW | `src/config/operations.ts` | Operation registry (single source of truth) |
| MODIFY | `src/types.ts` | Replace `SensorOperationConfig` → `SensorCalculationConfig` |
| MODIFY | `src/components/windows/SensorTooling.tsx` | Data-driven dropdowns + formula editor tab |
| MODIFY | `src/components/windows/AddSensorWindow.tsx` | Updated config handling |
| MODIFY | `src-tauri/src/lib.rs` | Operation registry + expression engine |
| MODIFY | `src-tauri/Cargo.toml` | Add `evalexpr` or `fasteval` crate |

#### Recommended Rust Crates
- **`evalexpr`** — Simple expression evaluation with custom function support
- **`fasteval`** — High-performance math expression evaluator
- เลือกอันใดอันหนึ่ง ขึ้นกับว่าต้องการ custom function มากแค่ไหน

#### Migration Path
1. **Phase 1**: สร้าง Operation Registry + refactor Simple Mode → data-driven (ไม่กระทบ UX)
2. **Phase 2**: เพิ่ม Advanced Mode (Formula Editor) เป็น tab ใหม่
3. **Phase 3**: เพิ่ม time-series functions (moving_avg, rate_of_change, lag)
