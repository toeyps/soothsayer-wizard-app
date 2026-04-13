import { SensorMetadata, SensorOperationConfig } from '../types';
import { CsvLoadReport, MappingData, MappingResult } from './dataUpload';
import type { FormulaValidationResult } from './calculationEngine';

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
