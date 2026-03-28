# Requirements: Predictive Mode — Failure Group Creation Page

## Feature: Failure Group Creation — Redesign

### User Story
As a **reliability engineer**, I want an **interactive failure group creation page** that lets me organize sensor tags into failure groups, configure model metadata per sensor, and launch model building — so that I can **systematically define predictive models for each failure mode**.

### Description

This page is accessed after selecting **"Soothsayer Predictive Implementation Mode"** from the Data Upload page. It provides:

1. **Upload / Download Failure Group** — Import a pre-filled `.xlsx` failure group file, or download an unfilled template.
2. **Interactive Failure Group Table** — A grouped, editable table of sensor rows organized by failure groups.
3. **Model Build Panel** — A side panel that opens when clicking a sensor row, showing details and model build tools.
4. **Save** — Export the current table state back to `.xlsx` for download.

---

### Section 1: Toolbar (Top Bar)

#### 1.1 Upload Filled Failure Group
- [ ] Button: **"Upload Filled Failure Group"**
- [ ] Opens a file dialog to select a **single `.xlsx` file**
- [ ] Parse the `.xlsx` file and populate the interactive table with the data
- [ ] Columns expected: `No.`, `Group Name`, `Concept Sensor`, `Mapped Sensor Tag`, `Mapped Sensor Name`, `Model Type`, `Model Notes`, `Additional Notes`, `Status`
- [ ] Auto-create failure groups based on unique `No.` values in the file
- [ ] Validate `Mapped Sensor Tag` values against loaded dataset sensors — warn if tag doesn't exist

#### 1.2 Download Unfilled Failure Group Template
- [ ] Button: **"Download Unfilled Failure Group .xlsx"**
- [ ] Download a blank `.xlsx` template with the correct column headers
- [ ] Template columns: `No.`, `Group Name`, `Concept Sensor`, `Mapped Sensor Tag`, `Mapped Sensor Name`, `Model Type`, `Model Notes`, `Additional Notes`, `Status`

#### 1.3 Save (Export)
- [ ] Button: **"Save"**
- [ ] Convert the current interactive table state back to `.xlsx` and trigger a download
- [ ] Include all groups and sensor rows with their current values

---

### Section 2: Interactive Failure Group Table

#### 2.1 Table Structure
- [ ] Table columns: `No.`, `Group Name`, `Concept Sensor`, `Mapped Sensor Tag`, `Mapped Sensor Name`, `Model Type`, `Model Notes`, `Additional Notes`, `Status`
- [ ] Rows are **grouped by failure group** (identified by `No.`)
- [ ] Each group can be **collapsed/expanded**
- [ ] Each group has a **header row** showing the group number, name, and sensor count

#### 2.2 Failure Group Management
- [ ] **"Not in Group"** is a special default group with `No. = 0` — always present, cannot be deleted
- [ ] User can **add new failure groups** with a custom name
- [ ] User can **rename** existing failure groups (except "Not in Group")
- [ ] User can **remove** failure groups — this also removes all sensor rows in that group

#### 2.3 Sensor Row Management
- [ ] User can **add sensor rows** to any group via an "Add Sensor" button
- [ ] User can **remove** individual sensor rows
- [ ] Each group can contain **multiple sensor rows**
- [ ] The **same sensor tag** can appear in different groups, but **not in the same group**

#### 2.4 Column Behavior

| Column | Type | Behavior |
|--------|------|----------|
| `No.` | Auto | Auto-assigned from the parent failure group number |
| `Group Name` | Auto | Auto-filled from the parent failure group name |
| `Concept Sensor` | Text (editable) | Free-text input for descriptive sensor name (e.g. "crankcase vibration") |
| `Mapped Sensor Tag` | Dropdown (editable) | **Primary column** — click to open a searchable dropdown listing all sensor tags from the loaded dataset. Raise a **warning icon** if the selected tag doesn't exist in the loaded data |
| `Mapped Sensor Name` | Auto (read-only) | Auto-populated from sensor metadata when `Mapped Sensor Tag` is selected. Not user-editable |
| `Model Type` | Text (editable) | Free-text input (e.g. "I", "I + R") |
| `Model Notes` | Text (editable) | Free-text input (e.g. "Lube Oil Temp") |
| `Additional Notes` | Text (editable) | Free-text input for any extra notes |
| `Status` | Checkbox | Checkable box to mark completion status |

#### 2.5 Sensor Tag Dropdown
- [ ] Clicking `Mapped Sensor Tag` opens a **searchable dropdown**
- [ ] Dropdown lists all sensor tags available in the currently loaded dataset
- [ ] Dropdown supports **search/filter** by typing
- [ ] After selecting a tag, `Mapped Sensor Name` auto-fills from sensor metadata
- [ ] If a selected tag **doesn't exist** in the loaded dataset, show a **warning indicator** (icon)

---

### Section 3: Model Build Panel (Right Side)

#### 3.1 Panel Behavior
- [ ] Clicking on a sensor row opens the **Model Build Panel** on the right side
- [ ] Panel takes approximately **30% width**, table takes **70% width** (30:70 split)
- [ ] Panel shows the selected sensor row's metadata (group, concept sensor, tag, name, model type)
- [ ] Panel includes a **"Build Model"** button that opens a new Predictive Model window
- [ ] Panel can be **closed** to return the table to full width

#### 3.2 Build Model
- [ ] **"Build Model"** button is available on each sensor row that has a `Mapped Sensor Tag` selected
- [ ] Clicking opens a new **Predictive Model window** (separate Tauri webview)
- [ ] Passes the selected sensor tag as the target sensor to the new window
- [ ] While a Build Model window is open, attempting to close the Failure Group window should **focus the Build Model window instead** (prevent accidental closure)

---

### Acceptance Criteria
- [ ] User can upload a pre-filled `.xlsx` failure group file and see it rendered as an interactive grouped table
- [ ] User can download a blank `.xlsx` template with the correct headers
- [ ] User can add/remove failure groups and rename them
- [ ] User can add/remove sensor rows within groups
- [ ] Sensor tag dropdown shows all available tags with search/filter functionality
- [ ] Warning is shown when a selected sensor tag doesn't exist in the loaded dataset
- [ ] Mapped Sensor Name auto-fills based on sensor metadata (read-only)
- [ ] All text fields (Concept Sensor, Model Type, Model Notes, Additional Notes) are editable
- [ ] Status checkbox is functional
- [ ] Clicking a row opens the Model Build Panel with sensor details
- [ ] Build Model button opens a new Predictive Model window
- [ ] Save button exports the current table to `.xlsx` for download
- [ ] All state is persisted to workspace (Auto-Resume compatible)

### Priority: High
### Scope: fullstack

### Technical Notes

#### Frontend (React + Tailwind)
- Component: `src/components/windows/FailureGroupCreation.tsx`
- Grouped card-based layout (current implementation uses collapsible group cards)
- Searchable sensor dropdown with warning state
- 30:70 split layout when Model Build Panel is open
- Lucide icons for actions (Plus, Trash2, Edit3, FolderPlus, ChevronDown, etc.)

#### Backend (Rust / Tauri)
- No new Tauri commands required for core table functionality (state managed in frontend)
- `.xlsx` import/export may require a new Rust command or frontend library (e.g. `SheetJS/xlsx`)
- Sensor data and metadata received from parent window via Tauri events (`failure-group-data`)

#### Data Flow
- On window open: parent emits `failure-group-data` event containing `sensorHeaders`, `sensorMetadata`, and `metadata`
- Failure Group window listens for this data to populate sensor dropdown options
- Build Model window receives data via `predictive-model-data` event

#### Out of Scope
- Actual model training/building logic (handled by the Predictive Model window)
- Data editing or transformation of the underlying dataset
- Multi-user collaboration or conflict resolution
