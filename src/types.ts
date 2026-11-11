export interface CsvRecord {
    timestamp: string | null;
    values: (number | null)[];
}

export interface CsvMetadata {
    headers: string[];
    total_rows: number;
    /** Rust session generation; special-sensor commands bind to it (`expectedGeneration`) to reject stale windows. Optional only in fixtures. */
    generation?: number;
}

export interface SensorMetadata {
    tag: string;
    description: string;
    unit: string;
    component: string;
    /** Alarm setpoints; undefined = sensor has no value for that level (do not show 0). */
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
export type MultiOperationType = 'sum' | 'mean' | 'median';

export interface SensorOperationConfig {
    mode: 'single' | 'multi';
    singleOp?: {
        type: SingleOperationType;
        value: number;
    };
    multiOp?: {
        type: MultiOperationType;
        /** Decimals each result row is rounded to (0..10, Rust `MAX_OPERATION_DECIMALS`, half away from 0); absent = no rounding. */
        decimals?: number;
    };
    customName?: string;
}

/** Recipe to rebuild a special-sensor column on workspace reopen; `tag` is forced as the replay's customName. */
export type SpecialSensorRecipe =
    | { kind: 'formula'; tag: string; formula: string }
    | { kind: 'operation'; tag: string; sourceSensors: string[]; operationConfig: SensorOperationConfig };

export interface WorkspaceMetadata {
    id: string;
    name: string;
    description?: string;
    lastModified: number;
    filePath: string;
    /** Count of Failure Groups (not 'Not in Group') for the recent-project chip, refreshed on every workspace write. undefined = no chip, 0 = 'No failure groups'. */
    failureGroupCount?: number;
    /** Numbers of the first 3 Failure Groups (chip colour squares); set together with `failureGroupCount`. */
    failureGroupNos?: number[];
}

export interface WorkspaceSensorFilter {
    id: string;
    sensor: string;
    operation: 'less_than' | 'greater_than' | 'between' | 'equals';
    value1: string;
    value2: string;
}

interface WorkspaceFilterState {
    timestampStart: string;
    timestampEnd: string;
    sensorFilters: WorkspaceSensorFilter[];
}

export interface FailureGroup {
    no: number;
    name: string;
    /** Free-text description of the failure mode this group tracks. */
    description?: string;
    /** Free-text recommended action/response for this failure mode. */
    recommendation?: string;
}

/** @deprecated Replaced by `FailureModel`; kept for the legacy migration. */
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

export type ModelKind = 'individual' | 'relationship' | 'clustering';

/** `null` = not yet classified (e.g. a migrated model). */
export type ModelCategory = 'performance' | 'condition';

/** `null` = unbounded on that side (matches Rust `Option<f64>`). */
export interface PredictiveClusterRange {
    min: number | null;
    max: number | null;
}

/** Per-model predictive build config, embedded in each `FailureModel` so configuring one never overwrites another. */
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
    /** One entry per cluster, length === numClusters. */
    clusterRanges: PredictiveClusterRange[];
    /** This model's own TRAIN periods; only read when `runningConditionMode === 'custom'`. Empty blocks training (it does not mean no limit). */
    filterTimePeriods: TimePeriod[];
    /** OLD FILES ONLY: reset to false by `migrateSingleRunningCondition`; no longer counts as configured. */
    customRunningConditionNoneConfirmed?: boolean;
    /** Custom 'Use all data': train and score on every row of its own periods; undefined = false. */
    customRunningConditionAllData?: boolean;
    /** 'workspace': use the workspace's periods and running condition; 'custom': use this model's own. */
    runningConditionMode: 'workspace' | 'custom';
    /** Only read in 'custom' mode: ONE 'sensor > value' row; empty = not set (Train blocked). Seeded from the workspace's on switching to Custom. */
    customRunningConditionFilters: WorkspaceSensorFilter[];
    /** Only read in 'custom' mode; always 'and' (old files may say 'or'). */
    customRunningConditionCombine: 'and' | 'or';
    /** Own SCORING periods; only read in 'custom' mode, copied once from the workspace list. Not in `computeTrainFingerprint`; absent = none. */
    customTestPeriods?: TestPeriod[];
    /** ISO time the effective scoring periods changed while Complete (model goes to `status: false`, stays trained). Cleared by Mark complete. */
    testsChangedAt?: string;
}

/** Required sensors per kind: individual = targetSensor; relationship = targetSensor + >=1 predictor; clustering = xSensor + ySensor. criteriaSensor is optional for clustering (then clusterRanges length === numClusters). Component is derived from the target sensor (ySensor for clustering). */
export interface FailureModel extends PredictiveModelStateSlice {
    id: string;
    /** Failure Groups this model belongs to (many-to-many); `0` = 'Not in Group', used only when it has no real group (never an empty array). */
    groupNos: number[];
    name: string;
    kind: ModelKind;
    category: ModelCategory | null;
    notes: string;
    status: boolean;
    /** Clustering only: the X-axis sensor. */
    xSensor: string;
    /** Clustering only: the Y-axis sensor (acts as this model's "target"). */
    ySensor: string;
    /** ISO time of the last Train; undefined = never trained. Trained-and-fresh = set AND `trainedFingerprint === computeTrainFingerprint(model, fg)`. */
    lastTrainedAt?: string;
    /** Fingerprint of the inputs behind the last train; compare with `computeTrainFingerprint` to detect staleness. Opaque, never parse. */
    trainedFingerprint?: string;
    /** Signatures of the special-sensor recipes at train time (key = tag trimmed, lower-cased); editing a recipe makes the model stale. Absent = never stale by it. */
    trainedFormulas?: Record<string, string>;
    /** User-entered health score set points, stored on the model only (never written to master data). Not in `computeTrainFingerprint`. */
    healthSetPoints?: HealthSetPoints;
    /** @deprecated Nothing reads or writes it; kept so old files type-check. */
    healthExport?: HealthExportRecord;
    /** Last Rust verdict on the SAVED set points: valid / incomplete / invalid. Read through `modelSetPointFlag`; dropped when set points, re-train or training inputs change. */
    healthVerdict?: HealthVerdictValue;
}

export type HealthVerdictValue = 'valid' | 'incomplete' | 'invalid';

/** @deprecated Old `healthExport` record; nothing reads or writes it. */
export interface HealthExportRecord {
    /** ISO timestamp of the export. */
    at: string;
    /** The folder the files were written to (`{app_data}/workspaces/{id}/output`). */
    outputDir: string;
    /** The set points the exported files carry. */
    setPoints: HealthSetPoints;
    /** Scoring interval (seconds) the old files used; may be absent. */
    scoringIntervalSecs?: number;
}

/** Individual: health is 0 at `lower`/`upper` (alarm L/H); 100 within 1SD and 80 at 3SD are computed. `null` = not set. `masterLower`/`masterUpper` snapshot master `alarmL`/`alarmH` at creation: `undefined` = not taken, `null` = master has none. */
export interface IndividualHealthSetPoints {
    kind: 'individual';
    lower: number | null;
    upper: number | null;
    masterLower?: number | null;
    masterUpper?: number | null;
}

/** Relationship: residual = actual - predicted (lower side negative). All start `null`; no defaults. */
export interface RelationshipHealthSetPoints {
    kind: 'relationship';
    residualAt80Lower: number | null;
    residualAt80Upper: number | null;
    residualAt0Lower: number | null;
    residualAt0Upper: number | null;
}

/** Clustering model: ONE number N (> 3) -- every cluster's outer ring (health
 *  0) sits at N x that cluster's own SD. Starts `null`. */
export interface ClusteringHealthSetPoints {
    kind: 'clustering';
    outerSd: number | null;
}

export type HealthSetPoints =
    | IndividualHealthSetPoints
    | RelationshipHealthSetPoints
    | ClusteringHealthSetPoints;

export interface FailureGroupStateSlice {
    groups: FailureGroup[];
    models: FailureModel[];
    /** Workspace running condition: ONE `greater_than` row, also the export's `machine_info.running_status`; absent = no filter. Combined with training periods in `utils/trainingScope.ts`. */
    runningConditionFilters?: WorkspaceSensorFilter[];
    /** Always 'and' (one condition); old files may say 'or'. */
    runningConditionCombine?: 'and' | 'or';
    /** Workspace-default TRAIN periods for 'workspace' mode ('custom' uses `filterTimePeriods`). At least one is required to train; empty is not 'whole dataset'. */
    runningConditionTimePeriods?: TimePeriod[];
    /** Workspace-default SCORING periods (never trained on); 'custom' uses `customTestPeriods`. At least one required before Mark complete; undefined = []. */
    runningConditionTestPeriods?: TestPeriod[];
    /** OLD FILES ONLY: reset to false by `migrateSingleRunningCondition`; no longer counts as configured. */
    runningConditionNoneConfirmed?: boolean;
    /** 'Use all data': Train and Health score use every row of the periods. The condition stays required (export `running_status`). undefined = false. */
    runningConditionAllData?: boolean;
    /** Category changes made by the one-time normalisation. `undefined` =
     *  step not run yet; `null` = nothing to show / dismissed. */
    categoryNormalisationNotice?: CategoryChange[] | null;
    /** Relation models whose old stiffness (not one of the seven steps) was snapped on open and made Incomplete; shown until dismissed (null). */
    stiffnessSnapNotice?: string[] | null;
    /** OLD FILES ONLY: a leftover 'pending' is cleared to null by `migrateSingleRunningCondition`. */
    rcLegacyNotice?: 'pending' | null;
    /** OLD FILES ONLY: read once by `migrateSingleRunningCondition` as a source for the condition, then cleared. */
    runningStatus?: { sensor: string; stopAtOrBelow: string } | null;
    /** Result of the one-time conversion to the single running condition. undefined = not run; null = nothing to show, dismissed, or condition re-Applied. */
    runningConditionConversion?: RunningConditionConversion | null;
}

/** What the one-time running-condition conversion did (shown until dismissed). */
export interface RunningConditionConversion {
    /** `converted`: one condition was kept; `needs-set`: nothing to keep — set it again. */
    result: 'converted' | 'needs-set';
    /** Where the kept condition came from. */
    source: 'first-above' | 'saved-status' | null;
    /** The old condition, as it was. */
    before: { filters: WorkspaceSensorFilter[]; combine: 'and' | 'or'; allRows: boolean; savedStatus: { sensor: string; stopAtOrBelow: string } | null };
    /** The condition it kept (`null` with `needs-set`). */
    after: { sensor: string; value: string } | null;
    /** Models that were Complete and are Incomplete now. */
    incompleteModelIds: string[];
    /** Custom models whose own condition was converted (or must be set again). */
    customModels: { id: string; result: 'converted' | 'needs-set' }[];
}

/** `''` = open end (only first start / last end). Times are `datetime-local` strings. */
export interface TimePeriod {
    id: string;
    start: string;
    end: string;
}

/** A SCORING period: start and end only, both required (`validateTestPeriods`); may overlap train periods. Shown as S1, S2 by position. Build or copy through `toScoringPeriod`, which drops the legacy keys below. */
export interface TestPeriod extends TimePeriod {
    /** @deprecated read-only legacy (the removed Normal / Known problem label), never written. */
    label?: 'normal' | 'problem';
    /** @deprecated read-only legacy (the removed "when was it found" time), never written. */
    eventTime?: string;
    /** @deprecated read-only legacy (the removed "From Highlights" caption), never written. */
    fromHighlight?: string;
}

/** One category change made by `normalizeSensorCategories`. */
export interface CategoryChange {
    modelId: string;
    kind: ModelKind;
    /** Sensor grouping key (normalised tag). */
    sensorKey: string;
    from: ModelCategory | null;
    to: ModelCategory | null;
}

/** Payload of 'failure-group-state-changed': the whole slice plus sender; listeners must not re-list fields (see `withFailureGroupState`). */
export interface FailureGroupStateChangedPayload extends FailureGroupStateSlice {
    workspaceId?: string;
    origin?: string;
    /** Set by Dashboard autosave when special-sensor recipes changed; the listener re-reads them from disk. */
    recipesChanged?: boolean;
}

/** Payload of 'update-special-sensor' (Add Sensor window -> Dashboard): an edit that kept the tag. */
export interface UpdateSpecialSensorPayload {
    recipe: SpecialSensorRecipe;
    metadata: SensorMetadata;
    /** Tags whose columns were recomputed (empty for a metadata-only save). */
    recomputed: string[];
    /** Present only when the edit made the stored order an invalid build order. */
    recipeOrder?: string[];
    workspaceId?: string;
    generation?: number;
    /** The edit fixed a sensor that had no column this session. The train fingerprint ignores recipes, so Dashboard sets models trained on `affectedTags` back to Incomplete and stale (`demoteModelsTrainedOnSensors`). */
    repaired?: boolean;
    /** With `repaired`: the fixed sensor and every special sensor built on it
     *  (recomputed or still broken). */
    affectedTags?: string[];
}

type WorkspaceRoute = 'import' | 'dashboard' | 'failure-group';

/** Dashboard slots, column-major. Resize ratios belong to slots, so a swapped panel inherits the slot's size. */
export type DashboardSlot = 'left-top' | 'left-bottom' | 'right-top';

/** Filter is a tab inside `data`, not a panel. */
export type DashboardPanel = 'chart' | 'data' | 'sensors';

/** Panel shown in each slot; persisted in WorkspaceState. */
export type DashboardSlotMap = Record<DashboardSlot, DashboardPanel>;

/** Persisted split ratios `[primary%, secondary%]` summing to ~100; absent = DEFAULT_LAYOUT_SIZES. */
export interface DashboardLayoutSizes {
    /** Horizontal: [left-column%, right-column%]. Default ~ [66.67, 33.33]. */
    columns: [number, number];
    /** Vertical inside the left column: [chart%, data-insight%]. Default [60, 40]. */
    leftRows: [number, number];
}

/** Pinned axis bound for Scatter; an omitted side keeps auto-fit. */
interface ScatterAxisPin {
    sensor: string;
    min?: number;
    max?: number;
}

export interface ScatterAxisPins {
    x?: ScatterAxisPin;
    y?: ScatterAxisPin;
}

/** User time window highlighted on Line and Scatter (not Pair Plot). `start`/`end` are datetime-local strings. */
export interface TimeHighlight {
    id: string;
    start: string;
    end: string;
    label: string;
    color: string;
    enabled: boolean;
}

/** A value band under `ValueHighlight.sensor`: points with value in [min, max] get this colour when `enabled`. Colour is fixed at creation. */
export interface ValueHighlightRange {
    id: string;
    min: number;
    max: number;
    color: string;
    enabled: boolean;
}

/** 'By value' highlighting, Scatter only: colours points by one third sensor's ranges (one colour channel). `sensor: ''` = off. */
export interface ValueHighlight {
    sensor: string;
    ranges: ValueHighlightRange[];
}

/** Pinned Line-chart point, identified by x-axis TIMESTAMP (indices shift with range/aggregation) and re-resolved with `nearestXIndex`. Lives in Dashboard state, not saved. */
export interface LineTaggedPoint {
    id: string;
    timestamp: string;
    color: string;
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
    /** Undefined only for a workspace never autosaved; Dashboard then applies its one-time 'last 6 months' default. */
    filters?: WorkspaceFilterState;
    chartType?: 'line' | 'scatter' | 'pair';
    samplingMethod?: 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last';
    collapsedPanels?: string[];
    mappingFilePath?: string | null;
    mappingKeyColumn?: string | null;
    failureGroupState?: FailureGroupStateSlice;
    /** @deprecated Legacy global slot; only read by the load migration. */
    predictiveModelState?: PredictiveModelStateSlice;
    /** Split.js ratios; absent = default proportions. */
    layoutSizes?: DashboardLayoutSizes;
    /** Alarm lines turned on, per sensor tag; absent tag = none. */
    alarmLinesEnabled?: Record<string, AlarmLevel[]>;
    /** Scatter X/Y pair, persisted because ScatterChart unmounts on chart-type change. Absent = first two selected sensors. */
    scatterAxes?: { x: string; y: string };
    /** Metadata of Add Special Sensor columns (not in the mapping CSV), merged with mapping metadata in Dashboard.tsx. Cosmetic only. */
    extraSensorMetadata?: SensorMetadata[];
    /** Recipes replayed in array order after `load_csv` to rebuild special-sensor columns (they live only in Rust session memory). Order matters: formulas can reference earlier ones. */
    specialSensorRecipes?: SpecialSensorRecipe[];
    /** Per-sensor colour override; absent falls back to the default palette (`resolvedSensorColors`). */
    sensorColors?: Record<string, string>;
    /** Per-sensor pinned Line Y bounds; an omitted side keeps auto-fit. */
    sensorAxisRange?: Record<string, { min?: number; max?: number }>;
    /** Scatter pinned axis scale; each side records its sensor so a pin stops applying when the axis sensor changes. */
    scatterAxisPins?: ScatterAxisPins;
    /** Last input of the relative-range shortcut; UI convenience only (the applied range lives in `filters`). */
    relativeTimeRange?: { amount: string; unit: 'Y' | 'M' | 'W' | 'D' | 'H' };
    /** Highlighted time windows (Line and Scatter); absent = none. */
    timeHighlights?: TimeHighlight[];
    /** "By value" highlighting — see `ValueHighlight`. Scatter-only. Absent
     *  = no sensor picked (the pre-feature default). */
    valueHighlight?: ValueHighlight;
    /** The machine this project is about; `saveProjectDetails` is the only writer of it and of the derived `name` and `description`. Absent on older projects. */
    machine?: MachineDetails;
    /** Minutes east of UTC (-720..840) of the data's timestamps; absent until `ensureDataUtcOffset` fills it. */
    dataUtcOffsetMin?: number;
}

/** The machine fields of Project details. `plant`, `name`, `tag` are required
 *  for an export; `notes` is optional free text. */
export interface MachineDetails {
    plant: string;
    name: string;
    tag: string;
    notes: string;
}

/** Cross-window event: project details saved; receivers drop a foreign `workspaceId`. */
export const PROJECT_DETAILS_CHANGED = 'project-details-changed';

/** Payload of `PROJECT_DETAILS_CHANGED`. */
export interface ProjectDetailsChangedPayload {
    workspaceId: string;
    name: string;
    description: string;
}
