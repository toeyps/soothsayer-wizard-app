/*
 * Export results — the wire types of `plan_workspace_export`,
 * `export_workspace_results`, `cancel_workspace_export`, `reveal_export_folder`
 * and the `workspace-export-progress` event (Rust: `workspace_export.rs`).
 * snake_case keys, exactly as Rust (de)serializes them. Spec:
 * `docs/specs/WIZARD_OUTPUT_SPEC.md` v1.0; contract fixed 2026-10-20.
 */

import type { ModelCategory, ModelKind } from '../types';
import type { HealthSetPointsWire, TrainingScopeFilter } from './health';

/** The machine as the export writes it (`machine_info.json` → `machine`). */
export interface ExportMachine {
    plant: string;
    name: string;
    tag: string;
    notes: string;
}

/** "Machine is running when `sensor` is above `stop_if_lower_than`". */
export interface ExportRunningStatus {
    sensor: string;
    stop_if_lower_than: number;
}

/** One sensor's metadata. `name` = the description (Rust falls back to the
 *  tag); `component` `""` becomes "Uncategorized" in Rust. */
export interface ExportSensorMeta {
    tag: string;
    name: string;
    unit: string;
    component: string;
}

/** A special (calculated) sensor used by the export. `source_tags` are RAW
 *  tags, nested special sensors already expanded. */
export interface ExportDerivedSensor {
    tag: string;
    how_to_build: string;
    source_tags: string[];
}

/** A real failure group (never group 0). */
export interface ExportFailureGroup {
    no: number;
    name: string;
    description: string;
    recommendation: string;
}

export interface ExportClusterRange {
    min: number | null;
    max: number | null;
}

/** One model to export, in Workbench run order. */
export interface ExportModelSpec {
    id: string;
    kind: ModelKind;
    display_name: string;
    category: ModelCategory | null;
    group_nos: number[];
    /** Individual / Relationship. */
    target?: string;
    predictors?: string[];
    rel_stiffness?: number;
    /** Clustering. */
    x_sensor?: string;
    y_sensor?: string;
    n_clusters?: number;
    criteria_sensor?: string | null;
    cluster_ranges?: ExportClusterRange[] | null;
    /** `trainingScopeFilter(model, fg, headers)` — the SAME builder Train uses. */
    filter: TrainingScopeFilter | null;
    /** `healthSetPointsToWire(kind, model.healthSetPoints)`. */
    set_points: HealthSetPointsWire;
    training_note: string;
}

export interface WorkspaceExportRequest {
    workspace_id: string;
    expected_generation?: number;
    /** -720..=840, minutes east of UTC. */
    data_utc_offset_min: number;
    machine: ExportMachine;
    running_status: ExportRunningStatus | null;
    sensor_meta: ExportSensorMeta[];
    derived_sensors: ExportDerivedSensor[];
    failure_groups: ExportFailureGroup[];
    models: ExportModelSpec[];
}

/** Stable issue codes (errors block the export; warnings do not). */
export type ExportIssueCode =
    | 'machine_missing'
    | 'running_status_missing'
    | 'running_status_sensor_unknown'
    | 'offset_out_of_range'
    | 'no_models'
    | 'duplicate_model_id'
    | 'unknown_sensor'
    | 'category_missing'
    | 'display_name_duplicate'
    | 'set_points_invalid'
    | 'fit_profile_unknown'
    | 'regimes_not_contiguous'
    | 'no_training_rows'
    | 'derived_recipe_missing'
    | 'fg_text_missing'
    | 'rows_without_timestamp'
    | 'duplicate_instants_dropped'
    | 'component_uncategorized';

export interface ExportIssue {
    /** One of `ExportIssueCode`; typed as string so a newer backend's code
     *  still parses. */
    code: ExportIssueCode | (string & {});
    severity: 'error' | 'warning';
    model_id?: string;
    tag?: string;
    group_no?: number;
    field?: string;
    message: string;
}

/** One model in the plan: its key, the JSON exactly as written, and the CSV
 *  shape (`peek` = header + the first 6 rows). */
export interface ExportPlanModel {
    id: string;
    key: string;
    json: Record<string, unknown>;
    csv_columns: string[];
    rows: number;
    bytes: number;
    peek: string[][];
}

/** Dry run of an export — nothing written. */
export interface WorkspaceExportPlan {
    ok: boolean;
    issues: ExportIssue[];
    /** Exactly what `machine_info.json` will hold; `exported_at` is null here. */
    machine_info: Record<string, unknown>;
    models: ExportPlanModel[];
    total_rows: number;
    total_bytes: number;
    /** 2 × models + 1. */
    files: number;
    rows_without_timestamp: number;
    duplicate_instants_dropped: number;
    uncategorized_tags: string[];
}

export interface WorkspaceExportResult {
    /** Absolute path of the folder written (its name may end `_2` … `_99`). */
    folder: string;
    files: number;
    models: number;
    rows: number;
    bytes: number;
    exported_at: string;
    warnings: string[];
}

/** Payload of `WORKSPACE_EXPORT_PROGRESS` (a global emit): receivers drop
 *  other `export_id`s. */
export interface WorkspaceExportProgress {
    export_id: string;
    workspace_id: string;
    written: number;
    total: number;
    model_key: string;
}

export const WORKSPACE_EXPORT_PROGRESS = 'workspace-export-progress';

/** Error prefixes the export commands reject with. */
export type ExportErrorCode = 'NO_DATA' | 'STALE_SESSION' | 'BAD_REQUEST' | 'NOT_READY' | 'CANCELLED' | 'WRITE_FAILED';
