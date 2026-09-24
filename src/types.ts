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
export type MultiOperationType = 'sum' | 'mean' | 'median';

export interface SensorOperationConfig {
    mode: 'single' | 'multi';
    singleOp?: {
        type: SingleOperationType;
        value: number;
    };
    multiOp?: {
        type: MultiOperationType;
    };
    customName?: string;
}

/** What to re-run to rebuild one "Add Special Sensor" column after a
 *  workspace reopen -- see `WorkspaceState.specialSensorRecipes` for the
 *  full story. `tag` is the sensor's persisted name (forced back as the
 *  recomputation's customName on replay, not just a label). */
export type SpecialSensorRecipe =
    | { kind: 'formula'; tag: string; formula: string }
    | { kind: 'operation'; tag: string; sourceSensors: string[]; operationConfig: SensorOperationConfig };

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

/** @deprecated Replaced by `FailureModel`. Kept only so the legacy-workspace
 *  migration shim in `workspaceManager.ts` has a type to read old data as. */
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

/** Performance = model predicts throughput/output quality; Condition = model
 *  predicts equipment health/degradation. `null` = not yet classified (e.g.
 *  a model migrated from a pre-redesign workspace, where no source field maps
 *  to this — the user is expected to set it explicitly afterward). */
export type ModelCategory = 'performance' | 'condition';

/**
 * A single cluster's criteria range. `null` = unbounded in that
 * direction (matches the Rust `Option<f64>` round-trip). Lives in the
 * persisted slice so multi-cluster configs survive workspace reload.
 */
export interface PredictiveClusterRange {
    min: number | null;
    max: number | null;
}

/**
 * Predictive-model build config. Historically this was a single slot on
 * `WorkspaceState` shared by every model in the workspace (the root cause of
 * "editing one model's config silently discards another's" — see Notion).
 * It is now embedded directly in each `FailureModel` so every model carries
 * its own config and configuring one can never clobber another's.
 */
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
    /** This model's own training periods — only read when
     *  `runningConditionMode === 'custom'` (in 'workspace' mode the effective
     *  periods are `FailureGroupStateSlice.runningConditionTimePeriods`).
     *  Empty = no time limit. Replaced the old single `filterTimeStart`/
     *  `filterTimeEnd` pair (migrated by `migratePeriods`, Feature 4-C). */
    filterTimePeriods: TimePeriod[];
    /** Custom mode: user explicitly chose "No condition — use all rows". */
    customRunningConditionNoneConfirmed?: boolean;
    /** 'workspace' (default): this model's training window AND running
     *  condition are whatever's set on BuildModelWindow's Overview page
     *  (`FailureGroupStateSlice.runningConditionTimePeriods`/
     *  `runningConditionFilters`/`runningConditionCombine`). 'custom': this
     *  model ignores the workspace default entirely and uses its own
     *  `filterTimePeriods` + `customRunningConditionFilters`/
     *  `customRunningConditionCombine` instead — set from this model's own
     *  Build page (2026-09-23 redesign, replacing an earlier "which models
     *  does the workspace filter apply to" idea with a per-model override
     *  chosen where training actually happens, per explicit user direction;
     *  extended the same day, also per explicit user correction, to cover
     *  the time range too — it used to be a structurally separate,
     *  always-per-model-only field with no workspace default at all). */
    runningConditionMode: 'workspace' | 'custom';
    /** Only read when `runningConditionMode === 'custom'`. Seeded from the
     *  workspace's conditions at the moment the user switches to Custom (a
     *  sensible starting point to edit from), then fully independent —
     *  editing the workspace default afterward does not change this. */
    customRunningConditionFilters: WorkspaceSensorFilter[];
    /** Only read when `runningConditionMode === 'custom'`. */
    customRunningConditionCombine: 'and' | 'or';
}

/**
 * One model inside 1+ Failure Groups. Sensor requirements depend on `kind`:
 * - individual: `targetSensor` only.
 * - relationship: `targetSensor` (the target) + `predictorSensors` (>=1).
 * - clustering: `xSensor` + `ySensor`; `criteriaSensor` is optional but if
 *   set, `clusterRanges` must be configured (length === numClusters).
 *
 * `component` is intentionally NOT stored here — it's derived at read time
 * from `SensorMetadata.component` of the model's target sensor (`targetSensor`
 * for individual/relationship, `ySensor` for clustering), since sensor
 * metadata is re-derived from the CSV mapping each session rather than
 * persisted per-model. See `getModelTargetSensor` / component lookups at
 * call sites.
 *
 * Extends `PredictiveModelStateSlice` so a model's full PM build config
 * travels with it as one self-contained record.
 */
export interface FailureModel extends PredictiveModelStateSlice {
    id: string;
    /** Which Failure Group(s) this model belongs to — a genuine many-to-many
     *  relationship (2026-08-25 redesign, per explicit user request: a
     *  sensor legitimately needs an individual, a relationship, AND a
     *  clustering model at once, and a single model — most importantly a
     *  Relationship/Clustering one with real config, not just a bare
     *  individual — needs to appear under more than one Failure Group
     *  without being duplicated into a second, independently-editable
     *  copy). Always has at least one entry. `0` is the permanent "Not in
     *  Group" sentinel (see FG-0's own history) — a model with no real
     *  group falls back to `[0]`, it's never an empty array. A model with
     *  both `0` and a real group in this array is not a valid steady
     *  state (adding a real group drops `0`; losing its last real group
     *  falls back to `[0]`) but isn't actively guarded against everywhere
     *  — callers that assign groups follow this convention rather than the
     *  type enforcing it.
     *
     *  Migrated from the old singular `groupNo: number` field by
     *  `workspaceManager.ts`'s load shim — every model persisted before
     *  this redesign becomes `groupNos: [that old groupNo]`. */
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
}

export interface FailureGroupStateSlice {
    groups: FailureGroup[];
    models: FailureModel[];
    /**
     * Workspace-wide "is the machine actually running" filter (e.g.
     * `GEN_SPEED > 1200`) — set once here rather than per model, since
     * every model (any kind, any count) needs training data restricted to
     * the same operating condition. Replaced the old per-model
     * `PredictiveModelStateSlice.pmSensorFilters` (2026-09-15): with 100
     * models sharing one workspace, setting this 100 times separately was
     * the actual problem being solved. AND-combined with each model's own
     * Time start/end (which stays per-model — the training *period*
     * legitimately differs per model, only the running-condition gate
     * doesn't) client-side in `PredictiveModelBuild.tsx` before every
     * `train_*`/preview invoke; optional so older workspaces without it
     * just read as "no filter" (`?? []`).
     */
    runningConditionFilters?: WorkspaceSensorFilter[];
    /** How `runningConditionFilters` combine: 'and' (default, matches every
     *  workspace's behavior before this field existed) requires every
     *  condition to pass; 'or' keeps a row if any one does. Optional so an
     *  older workspace without it reads as 'and' (`?? 'and'`) — see
     *  BuildModelWindow's "Running Condition Filter" panel (2026-09-23). */
    runningConditionCombine?: 'and' | 'or';
    /** Workspace-default training periods (sibling to `runningConditionFilters`).
     *  A model in `runningConditionMode: 'workspace'` uses THIS list; 'custom'
     *  uses its own `filterTimePeriods`. Empty/undefined = no time limit. */
    runningConditionTimePeriods?: TimePeriod[];
    /** Workspace: user explicitly chose "No condition — use all rows". */
    runningConditionNoneConfirmed?: boolean;
    /** Category changes made by the one-time normalisation. `undefined` =
     *  step not run yet; `null` = nothing to show / dismissed. */
    categoryNormalisationNotice?: CategoryChange[] | null;
    /** `'pending'` = legacy workspace with models but no configured running
     *  condition, user hasn't answered yet. `undefined` = step not run; `null` = handled. */
    rcLegacyNotice?: 'pending' | null;
}

/** One training period. `''` = open end (only valid on the first period's
 *  start and the last period's end). Times are `datetime-local` strings. */
export interface TimePeriod {
    id: string;
    start: string;
    end: string;
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

/** Payload of the cross-window 'failure-group-state-changed' event — the whole
 *  slice plus who sent it. Typed once here so every listener carries every
 *  field instead of re-listing them (a listener that names only some fields
 *  is how new slice fields used to get lost — see `withFailureGroupState`). */
export interface FailureGroupStateChangedPayload extends FailureGroupStateSlice {
    workspaceId?: string;
    origin?: string;
}

type WorkspaceRoute = 'import' | 'dashboard' | 'failure-group';

/**
 * Fixed positions on the Dashboard that any panel can occupy. Naming is
 * column-major: `left-top` = chart slot by default. The right column is a
 * single slot — Filter now lives as a tab inside the `data` panel instead
 * of its own slot. Resize ratios are tied to slots (not panels), so after
 * a swap the new occupant inherits the previous panel's slot size.
 */
export type DashboardSlot = 'left-top' | 'left-bottom' | 'right-top';

/**
 * The swappable panels on the Dashboard. Filter is NOT a panel — it's a
 * tab inside the `data` panel.
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

/** A single pinned axis bound for the Scatter chart — which sensor it was
 *  set against, plus min/max (either may be omitted to keep that side
 *  auto-fitting). */
interface ScatterAxisPin {
    sensor: string;
    min?: number;
    max?: number;
}

export interface ScatterAxisPins {
    x?: ScatterAxisPin;
    y?: ScatterAxisPin;
}

/** One user-defined time window, highlighted on Line and Scatter (not Pair
 *  Plot — it keeps its own lasso-cluster gesture instead) — a span of
 *  wall-clock time, not tied to any one sensor or chart. `start`/`end` are
 *  datetime-local input strings (not epoch numbers) so they round-trip
 *  through the same `<input type="datetime-local">` the rest of the app's
 *  date fields already use. */
export interface TimeHighlight {
    id: string;
    start: string;
    end: string;
    label: string;
    color: string;
    enabled: boolean;
}

/** How "By time" highlights render on the Line chart specifically — a
 *  tinted background band (the original behaviour), or by recolouring the
 *  line itself during each highlighted window. One setting for every
 *  highlight at once (not per-item), so a chart with several highlights
 *  never ends up half bands, half recoloured segments. Scatter is
 *  unaffected either way — it always shows the coloured ring, regardless
 *  of this setting; Pair Plot doesn't read highlights at all. Absent =
 *  'band' (the original, pre-this-field default). */
export type HighlightLineDisplay = 'band' | 'line';

/** One user-defined value range ("load band") under `ValueHighlight.sensor`
 *  — a point whose value on that sensor falls in [min, max] gets this
 *  range's colour when `enabled`. Colour is assigned once (from the same
 *  palette `TimeHighlight` cycles through) when the range is created and
 *  persisted from then on, same as `TimeHighlight.color` — stable across
 *  adding/removing other ranges, and user-recolourable. */
export interface ValueHighlightRange {
    id: string;
    min: number;
    max: number;
    color: string;
    enabled: boolean;
}

/** "By value" highlighting — colours Scatter chart points by where a 3rd
 *  sensor's value falls among user-defined ranges (e.g. two speed bands
 *  compared spatially on an X/Y plot). Lives in the same "Highlights" tab
 *  as `TimeHighlight` ("By time"), but is a single sensor + its ranges
 *  rather than a flat list — Scatter only has one colour channel, so
 *  ranges from more than one sensor active at once would be ambiguous.
 *  Scatter-only (Line/Pair Plot don't read this at all — Pair Plot keeps
 *  its own lasso-cluster gesture, Line has no 3rd-sensor colour channel).
 *  `sensor: ''` = off (no sensor picked yet). */
export interface ValueHighlight {
    sensor: string;
    ranges: ValueHighlightRange[];
}

/** A single tagged point on the Line chart — "pin this exact point so I can
 *  compare its value against another one." Identified by its x-axis
 *  TIMESTAMP, not a raw array index: the query result's index-to-timestamp
 *  mapping shifts whenever the time range/aggregation changes, so an
 *  index-based reference would silently point at the wrong point after any
 *  such change. Re-resolved to the nearest plotted index at render time via
 *  the same `nearestXIndex` snapping `TimeHighlight` already uses.
 *
 *  NOT part of `WorkspaceState` — per the user's explicit call, tags don't
 *  need to survive closing and reopening the app. They're still lifted up
 *  to Dashboard.tsx (not left as LineChart-local state) so they survive
 *  switching chart type away and back to Line within the same running
 *  session — Dashboard's in-memory state just never gets written to or
 *  seeded from disk.
 *
 *  Scatter chart's own tagged points are deliberately NOT modeled here
 *  either — Scatter's sample comes from reservoir sampling
 *  (`get_scatter_sample`), so a tagged point has no stable identity across a
 *  refetch; ScatterChart keeps its tags as local, ephemeral state instead. */
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
    /** Undefined only for a workspace that has never been through Dashboard's
     *  autosave — a freshly-created one (see `DataUploadPage.handleContinue`,
     *  which omits this field entirely). Dashboard reads that absence as
     *  "never had a time period chosen" and applies its one-time "last 6
     *  months" default range; a workspace that HAS been autosaved always has
     *  this set (even to explicitly-empty strings, e.g. after "Reset
     *  Period"), and Dashboard leaves those alone. */
    filters?: WorkspaceFilterState;
    chartType?: 'line' | 'scatter' | 'pair';
    samplingMethod?: 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last';
    collapsedPanels?: string[];
    mappingFilePath?: string | null;
    mappingKeyColumn?: string | null;
    failureGroupState?: FailureGroupStateSlice;
    /** @deprecated Legacy global PM slot from before PM config was folded
     *  into each `FailureModel`. Only read by the workspace-load migration
     *  shim (`workspaceManager.ts`) to seed the one model it used to belong
     *  to; never written by current code. */
    predictiveModelState?: PredictiveModelStateSlice;
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
     *  fresh from the mapping CSV on every load, not persisted directly.
     *
     *  Cosmetic only (name/description/unit/component) -- see
     *  `specialSensorRecipes` below for what actually reconstructs the
     *  sensor's data on reload. */
    extraSensorMetadata?: SensorMetadata[];
    /** 2026-09-01: what to re-run, in order, right after `load_csv` on
     *  workspace open, to rebuild each "Add Special Sensor" column in the
     *  Rust backend's in-memory session -- that computed column previously
     *  only ever lived in that session's memory (`calculate_new_sensor`/
     *  `evaluate_formula` push directly onto `AppState.data`), so it was
     *  silently gone after every restart: `extraSensorMetadata` kept the
     *  cosmetic name/description around, but the sensor plotted no data at
     *  all, with no error -- a "ghost" entry in the sensor list. This is
     *  the actual recipe (not the result) needed to recreate it, in the
     *  same spirit as the rest of the app never caching computed data (see
     *  PM fit results, CSV rows themselves). `tag` is always forced back as
     *  the recomputation's `customName` so the recreated column's header
     *  matches `extraSensorMetadata`/`selectedSensors` exactly, regardless
     *  of Rust's own auto-naming. Entries must replay in array order --
     *  formula sensors can reference an earlier "Add Special Sensor" round
     *  by tag, and Rust needs that earlier column to already exist. */
    specialSensorRecipes?: SpecialSensorRecipe[];
    /** Per-sensor line-color override, set via the pipette in the Selected
     *  Sensor tab. Sensors absent from this map fall back to the default
     *  palette (see `resolvedSensorColors` in Dashboard.tsx). */
    sensorColors?: Record<string, string>;
    /** Per-sensor pinned Y-axis bounds for the Line chart, set via the
     *  axis-editor icon in the Selected Sensor tab. min/max are independent
     *  — either may be omitted to keep that side auto-fitting. */
    sensorAxisRange?: Record<string, { min?: number; max?: number }>;
    /** Scatter chart's pinned X/Y axis scale (the ruler-icon editor,
     *  independent of `scatterAxes` above which just tracks WHICH sensor is
     *  on each axis). Each side records which sensor it was pinned against
     *  so it stops applying automatically if the X/Y dropdown is later
     *  switched to a different sensor — same "stale pin" guard ScatterChart
     *  already does for the in-session case, now surviving reload too. */
    scatterAxisPins?: ScatterAxisPins;
    /** Last-used input for the TIME RANGE panel's quick relative-range
     *  shortcut (the Y/M/W/D/H buttons + amount field). Purely a UI
     *  convenience — the actual applied range lives in `filters`, which
     *  already persists on its own; this only restores what was last typed
     *  into the shortcut so it doesn't silently reset to "1 D". */
    relativeTimeRange?: { amount: string; unit: 'Y' | 'M' | 'W' | 'D' | 'H' };
    /** Time windows highlighted on Line and Scatter (Pair Plot doesn't read
     *  this list) — see `TimeHighlight`. Absent = no highlights defined
     *  (the pre-feature default). */
    timeHighlights?: TimeHighlight[];
    /** See `HighlightLineDisplay`. Absent = 'band'. */
    highlightLineDisplay?: HighlightLineDisplay;
    /** "By value" highlighting — see `ValueHighlight`. Scatter-only. Absent
     *  = no sensor picked (the pre-feature default). */
    valueHighlight?: ValueHighlight;
}
