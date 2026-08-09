export interface CsvRecord {
    timestamp: string | null;
    values: (number | null)[];
}

export interface CsvMetadata {
    headers: string[];
    total_rows: number;
}

export interface SensorMetadata {
    tag: string;
    description: string;
    unit: string;
    component: string;
    /** Alarm setpoints from the mapping CSV's ALARM_L/ALARM_LL/ALARM_H/ALARM_HH
     *  columns. Undefined (not NaN or 0) when the sensor has no value for that
     *  level — callers must treat "undefined" as "don't show", not "show 0". */
    alarmL?: number;
    alarmLL?: number;
    alarmH?: number;
    alarmHH?: number;
}

/** The four alarm setpoint levels, in low-to-high order. */
export type AlarmLevel = 'LL' | 'L' | 'H' | 'HH';

export type SingleOperationType =
    | 'add' | 'subtract' | 'multiply' | 'divide' | 'power'
    | 'abs' | 'log10' | 'sqrt' | 'round' | 'exp' | 'ceil' | 'floor';
export type MultiOperationType = 'sum' | 'mean' | 'median' | 'product' | 'subtract' | 'divide';

export interface SensorOperationConfig {
    mode: 'single' | 'multi';
    singleOp?: {
        type: SingleOperationType;
        value: number;
    };
    multiOp?: {
        type: MultiOperationType;
        baseSensor?: string;
    };
    customName?: string;
}

export interface WorkspaceMetadata {
    id: string;
    name: string;
    description?: string;
    lastModified: number;
    filePath: string;
}

export interface WorkspaceSensorFilter {
    id: string;
    sensor: string;
    operation: 'less_than' | 'greater_than' | 'between' | 'equals';
    value1: string;
    value2: string;
}

export interface WorkspaceFilterState {
    timestampStart: string;
    timestampEnd: string;
    sensorFilters: WorkspaceSensorFilter[];
}

// Snapshot of Dashboard's applied filtering/processing state captured on Save & Continue.
// Used by Step 2/3 so filtering context carries forward.
export interface DashboardSnapshot {
    selectedSensors: string[];
    visibleSensors: string[];
    operationConfig: SensorOperationConfig | null;
    filters: WorkspaceFilterState;
    samplingMethod: 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last';
}

export interface FailureGroup {
    no: number;
    name: string;
    isCollapsed: boolean;
}

export interface FailureSensorRow {
    id: string;
    groupNo: number;
    conceptSensor: string;
    mappedSensorTag: string;
    mappedSensorName: string;
    modelType: string;
    modelNotes: string;
    additionalNotes: string;
    status: boolean;
}

export interface FailureGroupStateSlice {
    groups: FailureGroup[];
    rows: FailureSensorRow[];
}

/**
 * A single cluster's criteria range. `null` = unbounded in that
 * direction (matches the Rust `Option<f64>` round-trip). Lives in the
 * persisted slice so multi-cluster configs survive workspace reload.
 */
export interface PredictiveClusterRange {
    min: number | null;
    max: number | null;
}

export interface PredictiveModelStateSlice {
    targetSensor: string;
    predictorSensors: string[];
    individualChecked: boolean;
    rcMode: 'relationship' | 'clustering' | null;
    scatterXSensor: string;
    relModelName: string;
    relStiffness: number;
    clusterModelName: string;
    numClusters: number;
    criteriaSensor: string;
    /** One entry per cluster, length === numClusters. Replaces the
     *  pre-multi-cluster `clusterRangeMin` / `clusterRangeMax` fields. */
    clusterRanges: PredictiveClusterRange[];
    filterTimeStart: string;
    filterTimeEnd: string;
    /**
     * Per-sensor value filters set on the PM page itself. Sensor pool is
     * restricted to the page's target + predictors at the time the row is
     * added (UI enforces this). Combined AND-style with whatever filters
     * the user already applied on the Dashboard before navigating here —
     * the dashboard slice is the base, PM filters narrow further.
     *
     * Shape matches `WorkspaceSensorFilter` so the same Rust-side
     * `value_filters` payload format is reused (no new commands needed).
     */
    pmSensorFilters: WorkspaceSensorFilter[];
}

export type WorkspaceRoute = 'import' | 'dashboard' | 'failure-group' | 'predictive-model';

/**
 * Fixed positions on the Dashboard that any panel can occupy. Naming is
 * column-major: `left-top` = chart slot by default. The right column is a
 * single slot — Filter now lives as a tab inside the `data` panel instead
 * of its own slot. Resize ratios are tied to slots (not panels), so after
 * a swap the new occupant inherits the previous panel's slot size.
 */
export type DashboardSlot = 'left-top' | 'left-bottom' | 'right-top';

/**
 * The swappable panels on the Dashboard. Save & Continue is NOT a
 * panel — it lives permanently at the bottom of the right column. Filter
 * is NOT a panel either — it's a tab inside the `data` panel.
 */
export type DashboardPanel = 'chart' | 'data' | 'sensors';

/**
 * Which panel is currently rendered in which slot. Mutated by drag-and-drop
 * on panel headers and persisted in WorkspaceState so the layout survives
 * reload.
 */
export type DashboardSlotMap = Record<DashboardSlot, DashboardPanel>;

/**
 * Persisted split-pane ratios for the Dashboard's resizable layout.
 * Each tuple is `[primary%, secondary%]` summing to ~100. Stored per
 * workspace so the user's preferred proportions survive reload. When
 * absent on an older workspace, Dashboard falls back to its DEFAULT_LAYOUT_SIZES.
 */
export interface DashboardLayoutSizes {
    /** Horizontal: [left-column%, right-column%]. Default ~ [66.67, 33.33]. */
    columns: [number, number];
    /** Vertical inside the left column: [chart%, data-insight%]. Default [60, 40]. */
    leftRows: [number, number];
}

export interface WorkspaceState {
    id: string;
    name: string;
    /** Optional free-text project description, set on the "Create project"
     *  step before the dataset is uploaded. */
    description?: string;
    lastRoute: WorkspaceRoute;
    dataFilePaths: string[];
    metadataFilePath: string | null;
    selectedSensors: string[];
    visibleSensors: string[];
    operationConfig: SensorOperationConfig | null;
    filters?: WorkspaceFilterState;
    chartType?: 'line' | 'scatter' | 'pair';
    samplingMethod?: 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last';
    collapsedPanels?: string[];
    mappingFilePath?: string | null;
    mappingKeyColumn?: string | null;
    dashboardSnapshot?: DashboardSnapshot;
    failureGroupState?: FailureGroupStateSlice;
    predictiveModelState?: PredictiveModelStateSlice;
    /** Last folder the user picked in the Save Model dialog. Used as the
     *  `defaultPath` for the next folder-picker invocation so they don't have
     *  to re-navigate to the same place every save. The actual save still
     *  always opens the picker — this is only the default, not a bypass. */
    outputDir?: string;
    /** Dashboard's resizable layout ratios (split.js gutters). Optional so
     *  older workspaces just use the default proportions. Updated on the
     *  fly via `onDragEnd` and persisted by the existing autosave effect. */
    layoutSizes?: DashboardLayoutSizes;
    /** Which alarm setpoint lines are toggled on, per sensor tag. Keyed by
     *  tag rather than a flat list so removing a sensor's entry is O(1) and
     *  the shape stays legible in the saved JSON. Absent tag = no lines on. */
    alarmLinesEnabled?: Record<string, AlarmLevel[]>;
    /** Scatter chart's selected X/Y sensor pair. Persisted because
     *  Chart.tsx unmounts ScatterChart entirely when the chart type isn't
     *  'scatter' — without this, switching to Line/Pair Plot and back reset
     *  the pair to the first two sensors every time. Absent = default to
     *  the first two selected sensors. */
    scatterAxes?: { x: string; y: string };
    /** Metadata for sensors created at runtime via "Add Special Sensor"
     *  (calculated/derived sensors have no row in the mapping CSV, so they
     *  get no entry there). Merged with the mapping-CSV-derived
     *  `sensorMetadata` in Dashboard.tsx -- kept separate here rather than
     *  folded into one array because `sensorMetadata` itself is re-derived
     *  fresh from the mapping CSV on every load, not persisted directly. */
    extraSensorMetadata?: SensorMetadata[];
}
