# Interface Contract — Data Upload Page Redesign

## Feature: Data Upload Page (Import CSV Redesign)

## Updated Tauri Commands

| Command | Args | Returns | Owner | Status |
|---------|------|---------|-------|--------|
| `load_csv` (updated) | `{ paths: string[] }` | `CsvLoadReport` | rust-agent | ⬜ pending |
| `load_mapping_csv` (new) | `{ path: string }` | `MappingData` | rust-agent | ⬜ pending |
| `apply_sensor_mapping` (new) | `{ tag_column: string, name_column: string, mapping_data: MappingData, dataset_headers: string[] }` | `MappingResult` | rust-agent | ⬜ pending |

## New TypeScript Types

```typescript
// In src/types/dataUpload.ts

/** Extended report returned by load_csv (replaces CsvMetadata) */
export interface CsvLoadReport {
  headers: string[];
  total_rows: number;
  columns: ColumnInfo[];
  warnings: string[];
}

export interface ColumnInfo {
  name: string;
  dtype: 'datetime' | 'numeric';
  null_count: number;
  /** Total non-null values */
  valid_count: number;
}

/** Raw mapping CSV data */
export interface MappingData {
  headers: string[];
  rows: string[][];
}

/** Result of applying sensor tag mapping */
export interface MappingResult {
  /** Sensors successfully matched and renamed */
  mapped: MappingResultEntry[];
  /** Tags found in mapping but not in dataset */
  not_in_dataset: MappingResultEntry[];
  /** Columns in dataset but not found in mapping */
  not_in_mapping: string[];
}

export interface MappingResultEntry {
  tag: string;
  name: string;
}
```

## Updated TypeScript Types

```typescript
// In src/types.ts — WorkspaceState additions
export interface WorkspaceState {
  // ... existing fields ...
  mappingFilePath: string | null;
  sensorMapping: Record<string, string> | null;  // tag -> name
  selectedMode: 'free_exploration' | 'soothsayer' | null;
}
```

## Updated Commands Contract

```typescript
// In src/types/commands.ts
import { CsvLoadReport, MappingData, MappingResult } from './dataUpload';

export type TauriCommands = {
  // UPDATED: load_csv now returns CsvLoadReport instead of CsvMetadata
  load_csv: {
    args: { paths: string[] };
    returns: CsvLoadReport;
  };
  // NEW: Load mapping CSV
  load_mapping_csv: {
    args: { path: string };
    returns: MappingData;
  };
  // NEW: Apply sensor tag mapping
  apply_sensor_mapping: {
    args: {
      tag_column: string;
      name_column: string;
      mapping_data: MappingData;
      dataset_headers: string[];
    };
    returns: MappingResult;
  };
  // ... existing commands unchanged ...
  get_loaded_paths: { args: Record<string, never>; returns: string[] };
  get_data: { args: { sensors: string[] }; returns: void };
  get_all_sensors: { args: Record<string, never>; returns: string[] };
  load_metadata_command: { args: { path: string }; returns: SensorMetadata[] };
  calculate_new_sensor: { args: { sensors: string[]; config: SensorOperationConfig }; returns: string };
  run_python_analysis: { args: Record<string, never>; returns: string };
};
```

## New React Hooks

```typescript
// In src/hooks/useDataUpload.ts
export function useDataUpload() {
  // Manages:
  // - selectedFiles: string[] (paths of CSV files to upload)
  // - loadReport: CsvLoadReport | null (parsing results)
  // - isLoading: boolean
  // - error: string | null
  //
  // Functions:
  // - selectFiles(): opens file dialog, updates selectedFiles
  // - removeFile(path): removes a file from selection
  // - uploadDataset(): calls load_csv, sets loadReport
  // - clearDataset(): resets state
}

// In src/hooks/useMappingData.ts
export function useMappingData() {
  // Manages:
  // - mappingData: MappingData | null
  // - tagColumn: string | null (selected dropdown value)
  // - nameColumn: string | null (selected dropdown value)
  // - mappingResult: MappingResult | null
  // - isLoading: boolean
  //
  // Functions:
  // - selectMappingFile(): opens file dialog for single CSV
  // - setTagColumn(col): sets selected tag column
  // - setNameColumn(col): sets selected name column
  // - applyMapping(datasetHeaders): calls apply_sensor_mapping
  // - clearMapping(): resets state
}
```

## State Changes

### WorkspaceState additions:
- `mappingFilePath: string | null` — path to the mapping CSV (for auto-resume)
- `sensorMapping: Record<string, string> | null` — applied tag→name mapping
- `selectedMode: 'free_exploration' | 'soothsayer' | null` — chosen analysis mode

### Persistence:
- All new fields saved via existing `workspaceManager.ts` (filesystem JSON)
- `selectedMode` determines `lastRoute` when proceeding from upload page

## Notes
- `CsvLoadReport` is a **superset** of `CsvMetadata` — backward compatible (has `headers` and `total_rows`)
- `apply_sensor_mapping` is a **pure function** on the frontend-provided data — it does not modify backend state
- Mapping is **optional** — user can proceed without uploading mapping data
- The existing `load_metadata_command` is separate from `load_mapping_csv` — metadata is for sensor descriptions/units, mapping is for tag-to-name renaming
