import { SensorMetadata, SensorOperationConfig } from '../types';
import { CsvLoadReport, MappingData, MappingResult } from './dataUpload';
import type { FormulaValidationResult } from './calculationEngine';

/**
 * Response shape from the Python sidecar's `preview_relationship` action.
 * Mirrors `wizard.Wizard.PreviewModel.relationship`'s return value with
 * the DataFrame serialised as `{columns, rows}` (rows aligned with columns).
 *
 * `r2_dict` and `rmse2_dict` are keyed by the cumulative-feature column
 * name, e.g. `"PREDICTED_['P1' 'P2']"`. The rmse2 value is `2 * RMSE`
 * (matching the Wizard convention) — divide by 2 for plain RMSE.
 */
export interface RelationshipPreviewResult {
  request: string;
  output: { columns: string[]; rows: (number | null)[][] };
  r2_dict: Record<string, number>;
  rmse2_dict: Record<string, number>;
  /** Present only on failure. */
  error?: string;
  trace?: string;
}

export type TauriCommands = {
  /** Updated: now returns CsvLoadReport instead of CsvMetadata */
  load_csv: {
    args: { paths: string[] };
    returns: CsvLoadReport;
  };
  /** New: Load a mapping CSV and return raw rows/columns */
  load_mapping_csv: {
    args: { path: string };
    returns: MappingData;
  };
  /** New: Apply sensor tag-to-name mapping */
  apply_sensor_mapping: {
    args: {
      tag_column: string;
      name_column: string;
      mapping_data: MappingData;
      dataset_headers: string[];
    };
    returns: MappingResult;
  };
  get_loaded_paths: {
    args: Record<string, never>;
    returns: string[];
  };
  get_data: {
    args: { sensors: string[] };
    returns: void; // Emits events
  };
  get_filtered_data: {
    args: {
      filter: {
        sensors: string[];
        timestamp_start: string | null;
        timestamp_end: string | null;
        value_filters: {
          sensor: string;
          operation: string;
          value1: number | null;
          value2: number | null;
        }[];
      };
    };
    returns: void; // Emits events
  };
  get_all_sensors: {
    args: Record<string, never>;
    returns: string[];
  };
  load_metadata_command: {
    args: { path: string };
    returns: SensorMetadata[];
  };
  calculate_new_sensor: {
    args: { sensors: string[]; config: SensorOperationConfig };
    returns: string;
  };
  run_python_analysis: {
    args: Record<string, never>;
    returns: string;
  };
  /**
   * Run a Relationship-model preview (LinearGAM) via the Python sidecar.
   * Returns the raw JSON payload from the sidecar — see `RelationshipPreviewResult`.
   */
  preview_relationship_model: {
    args: { predictors: string[]; target: string; lambda: number };
    returns: RelationshipPreviewResult;
  };
  /** Evaluate a formula expression and create a new sensor column */
  evaluate_formula: {
    args: { formula: string; custom_name: string | null };
    returns: string;
  };
  /** Validate a formula without executing it */
  validate_formula: {
    args: { formula: string };
    returns: FormulaValidationResult;
  };
};
