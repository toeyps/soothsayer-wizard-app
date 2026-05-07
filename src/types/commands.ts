import { SensorMetadata, SensorOperationConfig } from '../types';
import { CsvLoadReport, MappingData, MappingResult } from './dataUpload';
import type { FormulaValidationResult } from './calculationEngine';

/**
 * Response shape from the Python sidecar's `preview_relationship` action.
 *
 * Phase 5: legacy `output / r2_dict / rmse2_dict` fields removed. The
 * cumulative-feature scores live in `r2_per_step` / `rmse2_per_step`
 * (last entry is the full-model score). `rmse2_per_step[i]` is `2 * RMSE`
 * — divide by 2 for plain RMSE.
 *
 * `predicted` and `residual` are aligned with the (NaN-dropped, projected)
 * input rows — same length as the `y` vector that was sent to the sidecar.
 */
export interface RelationshipPreviewResult {
  request: string;
  r2_per_step: number[];
  rmse2_per_step: number[];
  predicted: (number | null)[];
  residual: (number | null)[];
  /** Present only on failure. */
  error?: string;
  trace?: string;
}

/** New: result of `train_individual_model` (writes JSON to disk). */
export interface IndividualModelInfo {
  model_name: string;
  publish_id: number;
  training_set_start_date: string;
  training_set_end_date: string;
  mean: number;
  sd: number;
  boundary_1sd: [number, number];
  boundary_3sd: [number, number];
  saved_path: string;
}

/** New: ellipse parameters from a single-cluster GMM fit. */
export interface EllipseFit {
  x_center: number;
  y_center: number;
  x_sd: number;
  y_sd: number;
  angle_deg: number;
}

/** New: result of `compute_clustering_preview`. */
export interface ClusteringPreview {
  first_sensor: string;
  second_sensor: string;
  cluster_count: number;
  n_rows: number;
  ellipse: EllipseFit;
}

/** New: result of `train_clustering_model`. */
export interface ClusteringModelInfo {
  model_name: string;
  first_sensor: string;
  second_sensor: string;
  cluster_count: number;
  ellipse: EllipseFit;
  saved_path: string;
}

/** New: result of `train_relationship_model`. */
export interface RelationshipTrainResult {
  model_path: string;
  r2: number;
  rmse2: number;
  n_rows: number;
  info_path: string;
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
  /** Train + persist an Individual model. Writes INDV_INFO_*.json under
   *  `{save_path}/output/{target}/` and returns the JSON payload. */
  train_individual_model: {
    args: {
      target: string;
      model_name: string | null;
      save_path: string;
    };
    returns: IndividualModelInfo;
  };
  /** Single-cluster GMM ellipse fit (preview only — no disk write). */
  compute_clustering_preview: {
    args: {
      first_sensor: string;
      second_sensor: string;
      n_clusters: number;
    };
    returns: ClusteringPreview;
  };
  /** Train + persist a Clustering model. Writes CLUS_INFO_*.json under
   *  `{save_path}/output/{second_sensor}/`. */
  train_clustering_model: {
    args: {
      first_sensor: string;
      second_sensor: string;
      n_clusters: number;
      model_name: string | null;
      save_path: string;
    };
    returns: ClusteringModelInfo;
  };
  /** Train + persist a Relationship (LinearGAM) model. Sidecar writes the
   *  pickled .pkl; Rust writes the REL_INFO_*.json alongside it. */
  train_relationship_model: {
    args: {
      predictors: string[];
      target: string;
      lambda: number;
      save_path: string;
      model_name: string | null;
    };
    returns: RelationshipTrainResult;
  };
};
