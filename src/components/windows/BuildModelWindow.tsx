import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../../utils/tauriEvents";
import { X, ChevronRight, Lock, CircleAlert, TriangleAlert, Search, Maximize2, Loader2, Activity, GitBranch, Layers } from "lucide-react";
import { CsvRecord, FailureGroup, FailureModel, ModelKind, ModelCategory, SensorMetadata, CsvMetadata, WorkspaceSensorFilter, CategoryChange, TimePeriod, FailureGroupStateSlice, FailureGroupStateChangedPayload } from "../../types";
import type { RelationshipPreviewResult, ClusteringPreview } from "../../types/commands";
import { loadWorkspaceData, updateWorkspaceData } from "../../workspaceManager";
import { withFailureGroupState } from "../../utils/failureGroupState";
import { modelSensorKey, groupModelsBySensor, sensorCategory, setSensorCategory, type SensorModelGroup } from "../../utils/modelGrouping";
import { normalizeCategories, flagLegacyGate, migratePeriods } from "../../utils/workspaceMigrations";
import { findSameSensorNameConflict, suggestDistinctModelName } from "../../utils/modelNames";
import { CATEGORY_BLOCK_REASON, getBuildBlockReason, isRunningConditionConfigured, isWorkspaceRunningConditionConfigured, effectiveRunningCondition, isCompleteCondition, type RunningConditionFg } from "../../utils/runningCondition";
import { computeTrainFingerprint, isModelTrainedFresh as trainedFreshFor } from "../../utils/trainFingerprint";
import { useSensorMetaMap, normalizeSensorTag } from "../../hooks/useSensorMetaMap";
import { useDatasetTimeBounds } from "../../hooks/useDatasetTimeBounds";
import { useChartData } from "../../hooks/useChartData";
import { conditionText } from "./periodDisplay";
import { validatePeriods, toFilterRanges } from "../../utils/timePeriods";
import { STIFFNESS_OPTIONS, STIFFNESS_DEFAULT, stiffnessLabel, snapStiffness } from "../reports/pmReportTypes";
import RunningConditionPanel from "./RunningConditionPanel";
import PredictiveModelBuild, { SensorPickerModal } from "./PredictiveModelBuild";
import LineChart from "../charts/LineChart";
import ResponsiveECharts from "../charts/ResponsiveECharts";
import { ChartMarkLine } from "../charts/ChartTypes";

interface BuildModelData {
    workspaceId: string;
    sensorHeaders: string[];
    sensorMetadata: SensorMetadata[] | null;
    metadata: CsvMetadata;
}

const KIND_ABBREV: Record<ModelKind, string> = {
    individual: 'I',
    relationship: 'R',
    clustering: 'C',
};

const CATEGORY_LABELS: Record<ModelCategory, string> = {
    performance: 'Performance',
    condition: 'Condition',
};

const UNCATEGORIZED = 'Uncategorized';
const DEFAULT_CLUSTER_RANGES = [
    { min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 },
];

// Mirrors Dashboard.tsx's own FG_GROUP_PALETTE/getFgGroupColor exactly
// (duplicated, not imported — sub-windows don't share a components module)
// so a group renders the same color here as it does on the Dashboard tab.
const FG_GROUP_PALETTE = ['amber', 'violet', 'green', 'blue'] as const;
const getFgGroupColor = (no: number): string =>
    no === 0 ? 'slate' : FG_GROUP_PALETTE[(no - 1) % FG_GROUP_PALETTE.length];

// Same oklch values as .fg-group-color-{name} in App.css, kept as plain JS
// here rather than relied on via CSS inheritance.
const FG_ACCENT: Record<string, string> = {
    amber: 'oklch(0.78 0.14 75)',
    violet: 'oklch(0.7 0.15 310)',
    green: 'oklch(0.72 0.15 150)',
    blue: 'oklch(0.68 0.17 245)',
    slate: 'var(--text-faint)',
};

/** Every model bucketed by its sensor key, workspace-wide (not scoped to one
 *  Failure Group) — the left list's "Component" grouping and the detail
 *  pane both need the sensor's FULL model set regardless of which FG a
 *  particular list row came from. Same identity (`modelSensorKey`) as
 *  `groupModelsBySensor`, just without the per-group filter. */
function allSensorGroups(models: FailureModel[]): SensorModelGroup[] {
    const out: SensorModelGroup[] = [];
    const byKey = new Map<string, SensorModelGroup>();
    for (const m of models) {
        const key = modelSensorKey(m);
        let g = byKey.get(key);
        if (!g) { g = { key, models: [] }; byKey.set(key, g); out.push(g); }
        g.models.push(m);
    }
    return out;
}

type LeftGroupBy = 'fg' | 'component';
type SidebarFilter = 'all' | 'attn' | 'done';

const LEGACY_BADGE = 'Legacy · all data';

/** Gate badge (approved mockup rc-gate.html): "Legacy · all data" is a neutral
 *  grey pill (the model stays Complete, nothing is wrong); every blocking
 *  reason ("Needs condition" ...) is the amber warn pill. */
function GateBadgePill({ text, title, testId }: { text: string; title?: string; testId?: string }) {
    return (
        <span data-testid={testId} title={title} className={`f4-pill ${text === LEGACY_BADGE ? 'f4-pill--grey' : 'f4-pill--warn'}`}>
            {text}
        </span>
    );
}

/** Kind identity colour used for the active tab underline. */
const KIND_COLOR: Record<ModelKind, string> = {
    individual: 'var(--accent-hi)',
    relationship: 'var(--warn)',
    clustering: 'var(--kind-clu)',
};

/** Unsaved edits to ONE model (kept per model id so switching a sensor's
 *  kind tabs never loses them). Only fields the user can edit here;
 *  `category` is deliberately absent (per-sensor, saved instantly from the
 *  detail header). */
interface ModelDraft {
    name: string;
    predictors: string[];
    y: string;
    criteria: string;
    ranges: { min: number | null; max: number | null }[];
    stiffness: number;
    numClusters: number;
    runningConditionMode: 'workspace' | 'custom';
}

const draftFromModel = (m: FailureModel): ModelDraft => ({
    name: m.name,
    predictors: m.predictorSensors ?? [],
    y: m.ySensor ?? '',
    criteria: m.criteriaSensor ?? '',
    ranges: m.clusterRanges?.length ? m.clusterRanges : DEFAULT_CLUSTER_RANGES,
    stiffness: snapStiffness(m.relStiffness ?? STIFFNESS_DEFAULT),
    numClusters: m.numClusters ?? 3,
    runningConditionMode: m.runningConditionMode ?? 'workspace',
});

// Fixed order (not alphabetical) -- I/R/C is a small, natural taxonomy, not
// an open-ended list like components, so it reads better presented in the
// same order the kind toggles/badges use everywhere else in the app.
const KIND_ORDER: ModelKind[] = ['individual', 'relationship', 'clustering'];
const DUPLICATE_NAME_BLOCK_REASON = 'Model name is already used by another model of this sensor';
const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

// ─── Build Model Workbench Phase B (Train in place) ───────────────────────
// Shape returned by Rust's `compute_sensor_stats` — mirrors the identically-
// named (and likewise un-exported) interface in PredictiveModelBuild.tsx;
// duplicated rather than imported since that file doesn't export it.
interface SensorStats {
    mean: number;
    sd: number;
    min: number;
    max: number;
    count: number;
    lower1: number;
    upper1: number;
    lower3: number;
    upper3: number;
}

/** One model's cached Phase-B preview result, keyed by kind so the results
 *  stage/expand-modal can render the right chart without re-deriving which
 *  invoke produced it. Session-only — Phase B never writes a file, so this
 *  is never persisted (only `lastTrainedAt`/`trainedFingerprint` are). */
type TrainResult =
    | { kind: 'individual'; stats: SensorStats }
    | { kind: 'relationship'; result: RelationshipPreviewResult; predictorsAtApply: string[] }
    | { kind: 'clustering'; preview: ClusteringPreview };

interface TrainCacheEntry {
    /** The fingerprint this result was computed against — lets a stale
     *  auto-recompute effect tell "already have the current result" apart
     *  from "have an old one that happens to still be cached". */
    fingerprint: string;
    result: TrainResult;
}

// Mirrors PredictiveModelBuild.tsx's own CLUSTER_PALETTE (not exported there).
const CLUSTER_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#f43f5e', '#14b8a6', '#ec4899', '#6366f1'];
// Stable empty array for LineChart's unused row-based `data` prop (the chart
// consumes the bounded `columnar` feed instead) — same convention as PM page.
const EMPTY_RECORDS: CsvRecord[] = [];
const RESULT_CHART_MAX_POINTS = 4000;

/** 🆕 2026-09-30 [data-loss fix, repeat report]: `TimePeriodsEditor`'s date
 *  fields only commit an edit to the parent (`onPeriodsChange` ->
 *  `persistRunningCondition`, tracked in `pendingSaveRef`) on blur / Enter —
 *  never per keystroke, by design, so rows don't jump around mid-type (see
 *  that file's own top comment). The Running Condition Filter modal's own
 *  close paths (the X button, backdrop click) used to just call
 *  `setRcFilterOpen(false)` directly — a plain state update, not a real DOM
 *  focus change — so a half-typed date that never naturally blurred (e.g. a
 *  test's `fireEvent.change` with no following `fireEvent.blur`, or, per the
 *  user's real report, some real click paths) unmounted the editor without
 *  its `onCommit` ever firing, silently discarding the edit. Calling this
 *  before any close path (the modal's own, and the whole window's) forces
 *  that commit synchronously and unconditionally — a no-op when nothing
 *  relevant is focused. */
function flushFocusedInput(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && typeof active.blur === 'function') active.blur();
}

/** Footer's "Last trained <date>" (Complete state) — locale-formatted, not a
 *  fixed pattern, since this is a plain human-readable timestamp, not
 *  something any other code parses back. */
function formatTrainedAt(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Wire shape the three preview commands (`compute_sensor_stats`,
 *  `preview_relationship_model`, `compute_clustering_preview`) expect for
 *  `filter` — same `{timestamp_ranges, value_filters, combine}` (or `null`
 *  for "no filter at all") that PredictiveModelBuild.tsx's own
 *  `dashboardFilterPayload` memo builds, reimplemented here as a pure
 *  function since that memo is local to that component. */
function buildPreviewFilterPayload(
    eff: { filters: WorkspaceSensorFilter[]; combine: 'and' | 'or'; noneConfirmed: boolean; periods: TimePeriod[] },
    headers: string[] | null,
) {
    const rawFilters = eff.noneConfirmed ? [] : eff.filters;
    const valueFilters = rawFilters
        .filter(sf => isCompleteCondition(sf, headers))
        .map(sf => ({
            sensor: sf.sensor,
            operation: sf.operation,
            value1: sf.value1 !== '' ? parseFloat(sf.value1) : null,
            value2: sf.value2 !== '' ? parseFloat(sf.value2) : null,
        }));
    const ranges = toFilterRanges(eff.periods);
    const filterRanges = ranges.some(rg => rg.start === null && rg.end === null) ? [] : ranges;
    if (valueFilters.length === 0 && filterRanges.length === 0) return null;
    return { timestamp_ranges: filterRanges, value_filters: valueFilters, combine: eff.combine };
}

/** Relationship scatter option: Raw (blue) vs. Relation model output (red)
 *  against the first fitted predictor — mirrors PredictiveModelBuild.tsx's
 *  own `relScatterOption` memo, reimplemented as a pure function (that memo
 *  is local to that component and not exported). Deliberately simplified:
 *  the Workbench shows the first predictor only, with no X-axis switcher —
 *  the full picker lives on "Open full view". */
function buildRelScatterOption(result: RelationshipPreviewResult, predictorsAtApply: string[], targetSensor: string) {
    const xRaw = result.predictor_raw;
    const yRaw = result.target_raw;
    const yPred = result.predicted;
    if (!xRaw || !yRaw || !yPred || xRaw.length === 0 || predictorsAtApply.length === 0) return null;
    const xSensor = predictorsAtApply[0];
    const txtSecondary = '#94a3b8';
    const gridLine = '#334155';
    const rawPoints: [number, number][] = [];
    const modelPoints: [number, number][] = [];
    const n = Math.min(xRaw.length, yRaw.length, yPred.length);
    for (let i = 0; i < n; i++) {
        const xv = xRaw[i]?.[0];
        if (typeof xv !== 'number' || !Number.isFinite(xv)) continue;
        const yr = yRaw[i];
        if (typeof yr === 'number' && Number.isFinite(yr)) rawPoints.push([xv, yr]);
        const yp = yPred[i];
        if (typeof yp === 'number' && Number.isFinite(yp)) modelPoints.push([xv, yp]);
    }
    const totalPoints = rawPoints.length + modelPoints.length;
    const isLargeData = totalPoints > 2000;
    const isHugeData = totalPoints > 20000;
    const symbolSize = isHugeData ? 2 : isLargeData ? 3 : 5;
    const pointOpacity = isHugeData ? 0.18 : isLargeData ? 0.35 : 0.55;
    const seriesCommon = {
        type: 'scatter' as const, symbolSize, large: isLargeData, largeThreshold: 2000,
        progressive: 5000, progressiveThreshold: 10000,
        emphasis: { scale: !isHugeData, disabled: isHugeData }, silent: isHugeData,
    };
    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
        animation: !isLargeData,
        tooltip: { trigger: 'item', backgroundColor: 'rgba(30,41,59,0.95)', borderColor: gridLine, textStyle: { color: '#f1f5f9' } },
        legend: { show: false },
        grid: { left: 60, right: 20, top: 16, bottom: 42, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'filter' }, { type: 'inside', yAxisIndex: 0, filterMode: 'filter' }],
        xAxis: { type: 'value', name: xSensor, nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: txtSecondary }, scale: true, axisLabel: { color: txtSecondary }, axisLine: { lineStyle: { color: gridLine } }, splitLine: { show: false } },
        yAxis: { type: 'value', name: targetSensor, nameLocation: 'middle', nameGap: 44, nameTextStyle: { color: txtSecondary }, scale: true, axisLabel: { color: txtSecondary }, axisLine: { lineStyle: { color: gridLine } }, splitLine: { show: true, lineStyle: { color: gridLine, type: 'dashed', opacity: 0.3 } } },
        series: [
            { ...seriesCommon, name: 'Raw', data: rawPoints, itemStyle: { color: '#3b82f6', opacity: pointOpacity } },
            { ...seriesCommon, name: 'Model', data: modelPoints, itemStyle: { color: '#f43f5e', opacity: pointOpacity } },
        ],
    };
}

/** Clustering scatter + per-cluster σ-ellipse option — mirrors
 *  PredictiveModelBuild.tsx's own `clusteringScatterOption` memo (not
 *  exported there), reimplemented as a pure function. */
function buildClusteringScatterOption(preview: ClusteringPreview) {
    const { first_sensor, second_sensor, clusters, n_rows } = preview;
    if (!clusters || clusters.length === 0 || n_rows === 0) return null;
    const txtSecondary = '#94a3b8';
    const gridLine = '#334155';
    const totalPoints = clusters.reduce((acc, c) => acc + c.xs.length, 0);
    const isLargeData = totalPoints > 2000;
    const isHugeData = totalPoints > 20000;
    const symbolSize = isHugeData ? 2 : isLargeData ? 3 : 5;
    const pointOpacity = isHugeData ? 0.18 : isLargeData ? 0.35 : 0.55;
    const ellipseCustomSeries = (
        cluster: (typeof clusters)[number],
        sigma: number,
        opts: { stroke: string; fill?: string; lineWidth: number; lineDash?: number[]; opacity: number; name: string; z: number },
    ) => {
        const cx = cluster.ellipse.x_center;
        const cy = cluster.ellipse.y_center;
        const rx = cluster.ellipse.x_sd * sigma;
        const ry = cluster.ellipse.y_sd * sigma;
        const angleRad = (cluster.ellipse.angle_deg * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        return {
            type: 'custom' as const,
            name: opts.name,
            itemStyle: { color: opts.stroke },
            data: [[cx, cy]],
            z: opts.z,
            renderItem: (params: any, api: any) => {
                const polyPts: number[][] = [];
                for (let theta = 0; theta < 2 * Math.PI; theta += Math.PI / 36) {
                    const x = rx * Math.cos(theta);
                    const y = ry * Math.sin(theta);
                    polyPts.push(api.coord([cx + x * cos - y * sin, cy + x * sin + y * cos]));
                }
                return {
                    type: 'polygon',
                    shape: { points: polyPts },
                    style: { fill: opts.fill ?? 'none', stroke: opts.stroke, lineWidth: opts.lineWidth, lineDash: opts.lineDash ?? [0, 0], opacity: opts.opacity },
                    clipPath: { type: 'rect', shape: { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height } },
                };
            },
        };
    };
    const scatterSeries: any[] = [];
    const ellipseSeries: any[] = [];
    clusters.forEach((cluster, i) => {
        const color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
        const seriesName = clusters.length === 1 ? 'Data' : `Cluster ${cluster.cluster_id}`;
        const points: [number, number][] = [];
        const n = Math.min(cluster.xs.length, cluster.ys.length);
        for (let j = 0; j < n; j++) {
            const xv = cluster.xs[j], yv = cluster.ys[j];
            if (Number.isFinite(xv) && Number.isFinite(yv)) points.push([xv, yv]);
        }
        scatterSeries.push({
            type: 'scatter' as const, name: seriesName, data: points, symbolSize, large: isLargeData, largeThreshold: 2000,
            progressive: 5000, progressiveThreshold: 10000, emphasis: { scale: !isHugeData, disabled: isHugeData },
            silent: isHugeData, itemStyle: { color, opacity: pointOpacity }, z: 1,
        });
        ellipseSeries.push(ellipseCustomSeries(cluster, 1, { name: `${seriesName} 1σ`, stroke: color, fill: `${color}1F`, lineWidth: 2, opacity: 1, z: 3 }));
        ellipseSeries.push(ellipseCustomSeries(cluster, 3, { name: `${seriesName} 3σ`, stroke: color, lineWidth: 1.5, lineDash: [5, 5], opacity: 0.55, z: 2 }));
    });
    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
        animation: !isLargeData,
        tooltip: { trigger: 'item', backgroundColor: 'rgba(30,41,59,0.95)', borderColor: gridLine, textStyle: { color: '#f1f5f9' } },
        legend: { show: false },
        grid: { left: 60, right: 20, top: 16, bottom: 42, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'filter' }, { type: 'inside', yAxisIndex: 0, filterMode: 'filter' }],
        xAxis: { type: 'value', name: first_sensor, nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: txtSecondary }, scale: true, axisLabel: { color: txtSecondary }, axisLine: { lineStyle: { color: gridLine } }, splitLine: { show: false } },
        yAxis: { type: 'value', name: second_sensor, nameLocation: 'middle', nameGap: 44, nameTextStyle: { color: txtSecondary }, scale: true, axisLabel: { color: txtSecondary }, axisLine: { lineStyle: { color: gridLine } }, splitLine: { show: true, lineStyle: { color: gridLine, type: 'dashed', opacity: 0.3 } } },
        series: [...scatterSeries, ...ellipseSeries],
    };
}

/**
 * The single Build Model window — a singleton (label `build-model`) opened
 * from the Failure Groups tab's "Build Model" button.
 *
 * 🆕 2026-09-29 [Build Model Workbench, Phase A]: the Overview page was
 * rebuilt as a master/detail "Workbench" (approved mockup
 * 4jDz6AVCFMgTbxrGuFB9SN, Version 13) replacing the old "Group by Failure
 * Group / Component / Model Type" accordion — layout only, every
 * behavior/handler below is unchanged from before this pass:
 *   - A left sensor list (search + filter chips + Failure-group/Component
 *     grouping — Model Type grouping is REMOVED entirely) selects a sensor;
 *     a right detail panel shows that sensor's I/R/C tabs, a collapsible
 *     "Model settings" section, a Phase-A placeholder results area, and a
 *     per-model footer (status pill, Open full view, Save, Mark complete).
 *   - The workspace-wide Running Condition Filter moved from an always-
 *     visible inline panel to a one-line summary bar + "Edit…" modal
 *     wrapping the same, unchanged `RunningConditionPanel`.
 *   - Train/lastTrainedAt/staleness and the Failure-Groups-tab status dots
 *     are explicitly NOT part of this phase (Phase B/C) — the results area
 *     is a placeholder only.
 *   - 2026-08-31: there is no "add" flow — toggling a sensor into a group
 *     (Dashboard's Sensor tab) is the sole way a model comes into existence,
 *     always as kind 'individual'. A model's kind, its auto-filled identity
 *     sensor (Target / X), FG membership and Model Type are still not
 *     editable here — see this file's git history for the long list of
 *     explicit user requests behind each of those rules; none of them
 *     changed in this pass, only where/how they render.
 *
 * All of this is local state — no window spawn for any of it.
 *
 * Owns `failureGroupState` jointly with Dashboard and PredictiveModelBuild —
 * every write here is a read-modify-write against the full workspace file
 * and broadcasts `failure-group-state-changed` afterward so those other
 * windows never see stale data.
 */
export default function BuildModelWindow() {
    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    const [allSensors, setAllSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [allGroups, setAllGroups] = useState<FailureGroup[]>([]);
    const [allModels, setAllModels] = useState<FailureModel[]>([]);
    // Workspace-wide "machine running" filter (2026-09-15) — set once here,
    // every model of every kind picks it up automatically at train time (see
    // PredictiveModelBuild.tsx's `dashboardFilterPayload`).
    const [runningConditionFilters, setRunningConditionFilters] = useState<WorkspaceSensorFilter[]>([]);
    // How the conditions above combine — 'and' (default) or 'or' (2026-09-23).
    const [runningConditionCombine, setRunningConditionCombine] = useState<'and' | 'or'>('and');
    // Workspace-default training PERIODS (Feature 4-C). Empty = no time limit.
    // A model in Workspace mode uses THIS list; Custom mode uses its own
    // `filterTimePeriods`.
    const [runningConditionTimePeriods, setRunningConditionTimePeriods] = useState<TimePeriod[]>([]);
    const { bounds: datasetBounds } = useDatasetTimeBounds();
    // Drives the Workbench's "Edit…" Running Condition modal (was an inline
    // collapsible panel before Phase A; same underlying state, now shown in
    // a modal overlay instead of an always-present card).
    const [rcFilterOpen, setRcFilterOpen] = useState(false);
    // "No condition - use all rows" was explicitly confirmed for the workspace
    // (Feature 4, soft gate A). Mirrors failureGroupState.runningConditionNoneConfirmed.
    const [runningConditionNoneConfirmed, setRunningConditionNoneConfirmed] = useState(false);
    // Legacy-workspace banner: the STORED flag (failureGroupState.rcLegacyNotice,
    // written at hydration) plus a session-only "Remind me later" (never persisted).
    const [rcLegacyNotice, setRcLegacyNotice] = useState<'pending' | null>(null);
    const [legacyRemindLater, setLegacyRemindLater] = useState(false);
    /** Why the last Finish did not mark the model Complete (shown on the overview). */
    const [completeBlock, setCompleteBlock] = useState<string | null>(null);
    // Workspace id the panel was last auto-opened for, so "auto-open when the
    // running condition is unconfigured" happens once per hydration, not on
    // every broadcast.
    const rcAutoOpenedFor = useRef<string | null>(null);
    const [loading, setLoading] = useState(true);
    const hydratedRef = useRef(false);

    // ---- Workbench left list (Phase A) ----
    const [leftGroupBy, setLeftGroupBy] = useState<LeftGroupBy>('fg');
    const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    /** The sensor currently shown in the detail pane (a `modelSensorKey`), or
     *  null before anything is selected / when there are no models yet. */
    const [selectedSensorKey, setSelectedSensorKey] = useState<string | null>(null);
    /** Which model (kind tab) is active per sensor. */
    const [activeTab, setActiveTab] = useState<Record<string, string>>({});
    /** "Model settings" collapse override per model id — absent = auto
     *  (open while incomplete, else collapsed). */
    const [settingsOpenOverride, setSettingsOpenOverride] = useState<Record<string, boolean>>({});

    // ---- Train in place (Phase B) ----
    /** Session-only cache of the last successful preview run per model id —
     *  never persisted (Phase B writes only `lastTrainedAt`/`trainedFingerprint`
     *  to the workspace; the actual chart data is cheap to recompute, same as
     *  the PM page's own live queries). */
    const [trainResults, setTrainResults] = useState<Record<string, TrainCacheEntry>>({});
    /** Presence of a key = that model id currently has a preview run in
     *  flight (explicit Train/Re-train click OR the silent auto-recompute on
     *  reopen); absence = idle. There is no separate "done" value — a
     *  finished run is represented by its entry landing in `trainResults`. */
    const [trainStatus, setTrainStatus] = useState<Record<string, 'loading'>>({});
    const [trainError, setTrainError] = useState<Record<string, string>>({});
    /** Full-screen expand of the CURRENTLY selected model's result chart —
     *  mirrors the PM page's own `expandedChart` modal pattern (there isn't a
     *  clean way to share that page-local state across the window boundary,
     *  so this is a separate, visually-identical implementation). */
    const [resultExpanded, setResultExpanded] = useState(false);
    // Never leave the modal open pointed at a model the user has since
    // navigated away from (switching sensor or kind tab).
    useEffect(() => { setResultExpanded(false); }, [selectedSensorKey, activeTab]);
    // Esc closes it — same as the PM page's own `expandedChart` modal.
    useEffect(() => {
        if (!resultExpanded) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setResultExpanded(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [resultExpanded]);

    // ---- Predictive Model page — an in-window "next page" (not a spawned
    //      OS window) reached from the detail footer's "Open full view ↗"
    //      button. Only Dashboard + this singleton window are ever open at
    //      once. ----
    const [activePage, setActivePage] = useState<'overview' | 'model'>('overview');
    const [pmPageModelId, setPmPageModelId] = useState<string | null>(null);

    /** Unsaved edits, keyed by model id. */
    const [drafts, setDrafts] = useState<Record<string, ModelDraft>>({});
    /** One-time "categories were made consistent" notice — STORED in the
     *  workspace (failureGroupState.categoryNormalisationNotice), not computed
     *  per render, so it survives whichever window writes the file first. */
    const [categoryNotice, setCategoryNotice] = useState<CategoryChange[] | null>(null);
    const [categoryWarn, setCategoryWarn] = useState<{ key: string; text: string } | null>(null);

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getComponent = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.component ?? '', [sensorMetaMap]);
    // Raw description only (not the "description (tag)" combo `sensorLabel`
    // below builds) — matches `SensorAutocomplete`'s own `getDesc` contract,
    // which appends the tag itself separately.
    const getDesc = useCallback((tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.description ?? '', [sensorMetaMap]);
    // "description (tag)" everywhere a sensor is shown to the user (picker
    // options, predictor chips, the summary line) — the raw tag alone isn't
    // enough to recognize a sensor by; falls back to the bare tag when no
    // mapping/description exists for it.
    const sensorLabel = useCallback((tag: string) => {
        const desc = sensorMetaMap.get(normalizeSensorTag(tag))?.description;
        return desc ? `${desc} (${tag})` : tag;
    }, [sensorMetaMap]);

    // The model's own name if the user set one — a name identical to its
    // own target tag doesn't count (legacy-migrated models default to
    // that), else "description (tag)" for the target sensor, else a
    // placeholder. Clustering's Y sensor stays blank until configured,
    // falling back to X.
    const modelDisplayLabel = useCallback((model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        const trimmedName = model.name.trim();
        if (trimmedName && trimmedName !== targetTag) return trimmedName;
        if (!targetTag) return 'Untitled model';
        return sensorLabel(targetTag);
    }, [sensorLabel]);

    const modelComponent = useCallback((model: FailureModel) => {
        const targetTag = model.kind === 'clustering' ? (model.ySensor || model.xSensor) : model.targetSensor;
        if (!targetTag) return UNCATEGORIZED;
        return sensorMetaMap.get(normalizeSensorTag(targetTag))?.component || UNCATEGORIZED;
    }, [sensorMetaMap]);

    // Which workspace this window is currently showing, and a counter that
    // lets a slow, superseded `loadWorkspaceData` drop its result instead of
    // overwriting a newer one (2026-09-21: several `build-model-data` replies
    // could be in flight at once and whichever load finished last won).
    const workspaceIdRef = useRef<string | null>(null);
    const loadSeq = useRef(0);

    // 🆕 2026-09-29 [data-loss fix]: the most recent in-flight
    // `updateWorkspaceData` write from ANY persist path in this window
    // (running-condition edits, a model draft Save, Finish/markModelComplete,
    // the hydration-time migration write, …). Mirrors Dashboard.tsx's own
    // `pendingSaveRef` pattern. Always overwritten to the LATEST write; a
    // superseded one is simply abandoned, never left dangling. `handleClose`
    // and the `onCloseRequested` handler below await whatever this currently
    // holds before actually letting the window close.
    const pendingSaveRef = useRef<Promise<void> | null>(null);
    const trackPending = useCallback((p: Promise<void>): Promise<void> => {
        const tracked = p.finally(() => {
            if (pendingSaveRef.current === tracked) pendingSaveRef.current = null;
        });
        pendingSaveRef.current = tracked;
        return tracked;
    }, []);
    // The Predictive Model page (rendered inline below, not a separate OS
    // window) owns its own debounced persist and already flushes it on its
    // Back/Finish buttons. A native window close bypasses those buttons
    // entirely, so this window also needs a way to flush THAT page's pending
    // write before it is allowed to close.
    const pmFlushRef = useRef<(() => Promise<void>) | null>(null);
    const registerPmFlush = useCallback((flush: (() => Promise<void>) | null) => {
        pmFlushRef.current = flush;
    }, []);
    /** Awaits both this window's own pending write and the PM page's pending
     *  debounced write (if that page is open), so no path off this window can
     *  drop an edit made just before closing. */
    const flushAllPending = useCallback(async () => {
        if (pmFlushRef.current) await pmFlushRef.current();
        if (pendingSaveRef.current) await pendingSaveRef.current;
    }, []);

    // Mirrors the whole slice into local state — used by every path that
    // receives a fresh copy (hydration, broadcasts, our own writes).
    const applyFg = useCallback((fg: FailureGroupStateSlice | undefined | null) => {
        setAllGroups(fg?.groups ?? []);
        setAllModels(fg?.models ?? []);
        setRunningConditionFilters(fg?.runningConditionFilters ?? []);
        setRunningConditionCombine(fg?.runningConditionCombine ?? 'and');
        setRunningConditionTimePeriods(fg?.runningConditionTimePeriods ?? []);
        setRunningConditionNoneConfirmed(fg?.runningConditionNoneConfirmed ?? false);
        setRcLegacyNotice(fg?.rcLegacyNotice ?? null);
        setCategoryNotice(fg?.categoryNormalisationNotice ?? null);
    }, []);

    // A draft for a model that no longer exists (deleted on the Dashboard
    // meanwhile) must not linger.
    useEffect(() => {
        setDrafts(prev => {
            const ids = new Set(allModels.map(m => m.id));
            const stale = Object.keys(prev).filter(id => !ids.has(id));
            if (stale.length === 0) return prev;
            const rest = { ...prev };
            for (const id of stale) delete rest[id];
            return rest;
        });
    }, [allModels]);

    // A cached Phase-B preview (or an in-flight one) for a model that no
    // longer exists (deleted on the Dashboard, or the model was re-pointed at
    // a different workspace — see the `switched` reset below) must be thrown
    // away, never written back anywhere.
    useEffect(() => {
        const ids = new Set(allModels.map(m => m.id));
        setTrainResults(prev => {
            const stale = Object.keys(prev).filter(id => !ids.has(id));
            if (stale.length === 0) return prev;
            const rest = { ...prev };
            for (const id of stale) delete rest[id];
            return rest;
        });
        setTrainStatus(prev => {
            const stale = Object.keys(prev).filter(id => !ids.has(id));
            if (stale.length === 0) return prev;
            const rest = { ...prev };
            for (const id of stale) delete rest[id];
            return rest;
        });
        setTrainError(prev => {
            const stale = Object.keys(prev).filter(id => !ids.has(id));
            if (stale.length === 0) return prev;
            const rest = { ...prev };
            for (const id of stale) delete rest[id];
            return rest;
        });
    }, [allModels]);

    // The sensor shown in the detail pane must always be one that still has
    // at least one model — reselects the first available sensor whenever the
    // current selection disappears (another window deleted it, or this is
    // the first hydration). Runs off `allModels` directly (not off any
    // memoized bucket) so it fires exactly when the underlying data changes.
    useEffect(() => {
        const keys = allSensorGroups(allModels).map(sg => sg.key);
        setSelectedSensorKey(prev => (prev !== null && keys.includes(prev)) ? prev : (keys[0] ?? null));
    }, [allModels]);

    useEffect(() => {
        const offData = subscribe<BuildModelData>('build-model-data', async (event) => {
            const d = event.payload;
            // Re-pointed at a DIFFERENT workspace than the one on screen (the
            // main window moved on to another project while this window
            // stayed open): drop everything belonging to the old one —
            // including a PM page or half-edited form for a model that does
            // not exist in the new workspace.
            const switched = workspaceIdRef.current !== null && workspaceIdRef.current !== d.workspaceId;
            workspaceIdRef.current = d.workspaceId;
            setWorkspaceId(d.workspaceId);
            if (switched) {
                setActivePage('overview');
                setPmPageModelId(null);
                setSelectedSensorKey(null);
                setActiveTab({});
                setSettingsOpenOverride({});
                setSearchQuery('');
                setSidebarFilter('all');
                setLeftGroupBy('fg');
                setSidebarCollapsed(false);
                setDrafts({});
                setCategoryNotice(null);
                setCategoryWarn(null);
                setAllGroups([]);
                setAllModels([]);
                setRunningConditionFilters([]);
                setRunningConditionCombine('and');
                setRunningConditionTimePeriods([]);
                setRunningConditionNoneConfirmed(false);
                setRcLegacyNotice(null);
                setLegacyRemindLater(false);
                setRcFilterOpen(false);
                setTrainResults({});
                setTrainStatus({});
                setTrainError({});
                setResultExpanded(false);
            }
            setAllSensors(d.sensorHeaders);
            setSensorMetadata(d.sensorMetadata);
            const seq = ++loadSeq.current;
            try {
                const ws = await loadWorkspaceData(d.workspaceId);
                if (seq !== loadSeq.current || workspaceIdRef.current !== d.workspaceId) return;
                // One-time legacy cleanup (Feature 4-A): a sensor whose models
                // disagree on category is made consistent. When that changed
                // something, the result + notice are WRITTEN BACK here so the
                // notice is stored data (Dashboard's autosave can't lose it,
                // and it never re-fires once dismissed).
                // Same for the running-condition gate (Feature 4-B): a workspace
                // that already has models but nothing configured is flagged
                // `rcLegacyNotice: 'pending'` and written back, so the banner is
                // stored data rather than something recomputed per render.
                // Feature 4-C: old single time ranges become periods and the old
                // keys are dropped; written back only when that changed something.
                const periodsMigrated = ws ? migratePeriods(ws, { dropLegacyKeys: true }) : ws;
                const periodsChanged = periodsMigrated !== ws;
                const migrated = periodsMigrated ? flagLegacyGate(normalizeCategories(periodsMigrated)) : periodsMigrated;
                applyFg(migrated?.failureGroupState);
                if (migrated && rcAutoOpenedFor.current !== d.workspaceId) {
                    rcAutoOpenedFor.current = d.workspaceId;
                    const headers = d.sensorHeaders.length ? d.sensorHeaders : null;
                    if (!isWorkspaceRunningConditionConfigured(migrated.failureGroupState, headers)) setRcFilterOpen(true);
                }
                if (periodsChanged || (migrated !== ws && (migrated?.failureGroupState?.categoryNormalisationNotice?.length || migrated?.failureGroupState?.rcLegacyNotice === 'pending'))) {
                    await trackPending((async () => {
                        const written = await updateWorkspaceData(d.workspaceId, prev => flagLegacyGate(normalizeCategories(migratePeriods(prev, { dropLegacyKeys: true }))));
                        if (seq !== loadSeq.current || workspaceIdRef.current !== d.workspaceId) return;
                        if (written?.failureGroupState) {
                            applyFg(written.failureGroupState);
                            await emit('failure-group-state-changed', { ...written.failureGroupState, workspaceId: d.workspaceId, origin: 'build-model' });
                        }
                    })());
                }
            } catch (e) {
                console.warn('Failed to hydrate failure-group state:', e);
            }
            hydratedRef.current = true;
            setLoading(false);
        });

        // Any other window (Dashboard, PredictiveModelBuild) that
        // persists failureGroupState broadcasts this so our copy never
        // goes stale. Ignores another workspace's broadcast (events are
        // global) and this window's own echo.
        const offChanged = subscribe<FailureGroupStateChangedPayload>('failure-group-state-changed', (event) => {
            if (event.payload.workspaceId !== workspaceIdRef.current) return;
            if (event.payload.origin === 'build-model') return;
            // A load already in flight is now older than this broadcast.
            loadSeq.current++;
            applyFg(event.payload);
        });

        // Register both before asking, so the reply can't be missed.
        Promise.all([offData.ready, offChanged.ready]).then(() => emit('request-build-model-data'));

        return () => {
            offData();
            offChanged();
        };
    }, [applyFg, trackPending]);

    // Returns the write's promise (also tracked via `trackPending`, so a
    // window close can await it) rather than being fire-and-forget itself.
    const persist = useCallback((
        updater: (models: FailureModel[], groups: FailureGroup[]) => { models: FailureModel[]; groups: FailureGroup[] },
    ): Promise<void> => {
        if (!workspaceId) return Promise.resolve();
        return trackPending((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => {
                const groups = prev.failureGroupState?.groups ?? [];
                const models = prev.failureGroupState?.models ?? [];
                const result = updater(models, groups);
                // Spread-merge: this path only changes groups/models; every other slice
                // field (running condition incl. time range, future fields) must survive.
                return withFailureGroupState(prev, { groups: result.groups, models: result.models });
            });
            if (next?.failureGroupState) {
                applyFg(next.failureGroupState);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyFg, trackPending]);

    // The one path that actually changes the workspace-wide running
    // condition — edited entirely from the "Running Condition Filter" modal
    // (see the JSX below), never per-model. One function for all four
    // sub-fields (filters/combine/time start/time end) rather than a
    // near-duplicate persist-function per field.
    const persistRunningCondition = useCallback((patch: {
        filters?: WorkspaceSensorFilter[];
        combine?: 'and' | 'or';
        periods?: TimePeriod[];
        noneConfirmed?: boolean;
    }): Promise<void> => {
        if (!workspaceId) return Promise.resolve();
        return trackPending((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => {
                const applied = withFailureGroupState(prev, {
                    ...(patch.filters !== undefined ? { runningConditionFilters: patch.filters } : {}),
                    ...(patch.combine !== undefined ? { runningConditionCombine: patch.combine } : {}),
                    ...(patch.periods !== undefined ? { runningConditionTimePeriods: patch.periods } : {}),
                    ...(patch.noneConfirmed !== undefined ? { runningConditionNoneConfirmed: patch.noneConfirmed } : {}),
                });
                // Any edit made through this panel settles the legacy notice.
                const fg = applied.failureGroupState;
                const stillPending = fg?.rcLegacyNotice === 'pending' && !isWorkspaceRunningConditionConfigured(fg);
                return withFailureGroupState(applied, { rcLegacyNotice: stillPending ? 'pending' : null });
            });
            if (next?.failureGroupState) {
                applyFg(next.failureGroupState);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    }, [workspaceId, applyFg, trackPending]);

    const addRunningConditionFilter = useCallback(() => {
        const next = [...runningConditionFilters, {
            id: `rcf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sensor: allSensors[0] ?? '',
            operation: 'greater_than' as const,
            value1: '',
            value2: '',
        }];
        // A condition and "No condition" are mutually exclusive.
        setRunningConditionNoneConfirmed(false);
        setRunningConditionFilters(next);
        persistRunningCondition({ filters: next, noneConfirmed: false });
    }, [runningConditionFilters, allSensors, persistRunningCondition]);

    const updateRunningConditionFilter = useCallback((id: string, patch: Partial<WorkspaceSensorFilter>) => {
        const next = runningConditionFilters.map(f => f.id === id ? { ...f, ...patch } : f);
        setRunningConditionFilters(next);
        persistRunningCondition({ filters: next });
    }, [runningConditionFilters, persistRunningCondition]);

    const removeRunningConditionFilter = useCallback((id: string) => {
        const next = runningConditionFilters.filter(f => f.id !== id);
        setRunningConditionFilters(next);
        persistRunningCondition({ filters: next });
    }, [runningConditionFilters, persistRunningCondition]);

    // Periods are committed by the editor itself on blur / Enter (sorted), so
    // no debounce is needed here.
    const updateRunningConditionPeriods = useCallback((periods: TimePeriod[]) => {
        setRunningConditionTimePeriods(periods);
        persistRunningCondition({ periods });
    }, [persistRunningCondition]);

    // ---- Model editing (Feature 4-A, 2026-09-24) ----
    // Edits are kept as one DRAFT PER MODEL ID (not one global form), so
    // switching between a sensor's Individual / Relationship / Clustering
    // tabs never loses an unsaved edit. Identity fields (target sensor / X
    // sensor, kind, failure groups) are read straight from the stored model:
    // they are locked/read-only, so a draft can never carry a stale copy of
    // them. A draft also never carries `category`: category is per SENSOR
    // and saves instantly from the detail header (see `changeCategory`).
    const draftOf = (m: FailureModel): ModelDraft => drafts[m.id] ?? draftFromModel(m);
    const patchDraft = (m: FailureModel, patch: Partial<ModelDraft>) =>
        setDrafts(prev => ({ ...prev, [m.id]: { ...(prev[m.id] ?? draftFromModel(m)), ...patch } }));

    /** Category of the model's sensor across every FG (never per-model any more). */
    const categoryOf = (m: FailureModel): ModelCategory | null => sensorCategory(allModels, modelSensorKey(m));

    // ---- Running-condition gate (Feature 4-B, soft gate A). ONE source of
    //      truth: `getBuildBlockReason`. Every Build / Finish / "mark Complete"
    //      path below asks it; Save is deliberately NOT gated by it. ----
    const gateFg: RunningConditionFg = {
        models: allModels, runningConditionFilters, runningConditionCombine,
        runningConditionTimePeriods, runningConditionNoneConfirmed,
    };
    const gateHeaders = allSensors.length ? allSensors : null;
    const gateReasonOf = (m: FailureModel): string | null => getBuildBlockReason(m, gateFg, gateHeaders);
    const rcConfigured = isWorkspaceRunningConditionConfigured(gateFg, gateHeaders);
    const needsCondition = (m: FailureModel): boolean => !isRunningConditionConfigured(m, gateFg, gateHeaders);
    const legacyCompleteCount = allModels.filter(m => m.status).length;
    const blockedByCondition = allModels.filter(m => !m.status && needsCondition(m)).length;
    /** Badge text for a model the gate blocks, for ANY reason (missing condition,
     *  missing category, invalid period), else null. Hover text is the reason. */
    const gateBadge = (m: FailureModel): string | null => {
        if (gateReasonOf(m) === null) return null;
        if (needsCondition(m)) return m.status ? LEGACY_BADGE : 'Needs condition';
        return categoryOf(m) === null ? 'Needs category' : 'Fix periods';
    };

    /** Another model of the same sensor already using the name being saved.
     *  Only the model being edited is gated: an untouched draft (or one reverted
     *  to its saved name) is never blocked, so already-saved duplicates stay. */
    const nameConflictOf = (m: FailureModel): FailureModel | null => {
        const d = drafts[m.id];
        if (!d || d.name.trim() === (m.name ?? '').trim()) return null;
        return findSameSensorNameConflict(allModels, m, d.name);
    };

    /** Why Save is disabled (category / required fields), or null. */
    const modelBlockReason = (m: FailureModel): string | null => {
        // Same text as `getBuildBlockReason` (single source: one string everywhere).
        if (categoryOf(m) === null) return CATEGORY_BLOCK_REASON;
        const d = draftOf(m);
        const ok = d.name.trim() !== '' && m.groupNos.length > 0 && (
            m.kind === 'individual' ? (m.targetSensor ?? '') !== '' :
            m.kind === 'relationship' ? (m.targetSensor ?? '') !== '' && d.predictors.length >= 1 :
            (m.xSensor ?? '') !== '' && d.y !== '' && (!d.criteria || d.ranges.every(r => r.min !== null && r.max !== null))
        );
        if (!ok) return 'Fill in the required fields above first';
        return nameConflictOf(m) ? DUPLICATE_NAME_BLOCK_REASON : null;
    };

    /** Why Open full view is disabled: everything Save needs, then the gate. */
    const buildBlockReason = (m: FailureModel): string | null => modelBlockReason(m) ?? gateReasonOf(m);

    /** Short list of what's missing from THIS model's own settings (not the
     *  running condition — that's a separate concern surfaced by the gate
     *  badge/footer instead). Drives the "Model settings" section's
     *  auto-expand and its "N to fix" pill. */
    const missingItems = (m: FailureModel): string[] => {
        const d = draftOf(m);
        const items: string[] = [];
        if (categoryOf(m) === null) items.push('Pick a category');
        if (!d.name.trim()) items.push('Model name is required');
        if (m.kind === 'relationship' && d.predictors.length === 0) items.push('Add at least 1 predictor');
        if (m.kind === 'clustering') {
            if (!d.y) items.push('Pick a Y sensor');
            if (d.criteria && !d.ranges.every(r => r.min !== null && r.max !== null)) items.push('Fill in the cluster ranges');
        }
        if (nameConflictOf(m)) items.push('Fix the duplicate model name');
        return items;
    };

    /** Collapsed "Model settings" one-line summary: name · predictors/Y ·
     *  stiffness/clusters · data scope. */
    const settingsSummaryLine = (m: FailureModel, d: ModelDraft): string => {
        const parts = [d.name.trim() || 'Untitled'];
        if (m.kind === 'relationship') parts.push(d.predictors.length ? `${d.predictors.length} predictor${d.predictors.length === 1 ? '' : 's'}` : 'no predictors');
        else if (m.kind === 'clustering') parts.push(`Y: ${d.y ? sensorLabel(d.y) : '—'}`);
        if (m.kind === 'relationship') parts.push(stiffnessLabel(d.stiffness));
        else if (m.kind === 'clustering') parts.push(`${d.numClusters} clusters`);
        else parts.push('1σ + 3σ');
        parts.push(d.runningConditionMode === 'custom' ? 'Custom data' : 'Workspace data');
        return parts.join(' · ');
    };

    // Returns the `persist()` promise (rather than firing it and forgetting)
    // so `buildModel` below can await the write actually landing on disk
    // before navigating to the PM page.
    /** The persistable fields a model's draft would write on Save — factored
     *  out of `commitModel` so `runTrainClick` (Phase B) can compute the exact
     *  same merged-with-draft model to train against, without waiting for a
     *  `persist()` round-trip + re-render to see the fresh values. */
    const draftFields = (m: FailureModel, d: ModelDraft): Partial<FailureModel> =>
        m.kind === 'individual' ? { name: d.name.trim(), runningConditionMode: d.runningConditionMode } :
        m.kind === 'relationship' ? { name: d.name.trim(), predictorSensors: d.predictors, relStiffness: d.stiffness, runningConditionMode: d.runningConditionMode } :
        { name: d.name.trim(), ySensor: d.y, criteriaSensor: d.criteria, clusterRanges: d.criteria ? d.ranges : [], numClusters: d.numClusters, runningConditionMode: d.runningConditionMode };

    const commitModel = async (m: FailureModel) => {
        if (modelBlockReason(m) !== null) return;
        const d = draftOf(m);
        const fields = draftFields(m, d);
        await persist((models, groups) => ({
            groups,
            models: models.map(x => x.id === m.id ? { ...x, ...fields } : x),
        }));
        setDrafts(prev => {
            if (!(m.id in prev)) return prev;
            const rest = { ...prev };
            delete rest[m.id];
            return rest;
        });
    };

    /** The detail header's category control: writes EVERY model of that
     *  sensor in EVERY failure group, and saves instantly (no Save button). */
    const changeCategory = async (key: string, cat: ModelCategory) => {
        if (sensorCategory(allModels, key) === cat) return;
        const groupNos = [...new Set(allModels.filter(m => modelSensorKey(m) === key).flatMap(m => m.groupNos))].sort((a, b) => a - b);
        await persist((models, groups) => ({ groups, models: setSensorCategory(models, key, cat) }));
        setCategoryWarn(groupNos.length > 1
            ? { key, text: `Category applies to this sensor in every failure group: ${groupNos.map(n => n === 0 ? 'Not in Group' : `FG-${n}`).join(', ')}.` }
            : null);
    };

    const dismissCategoryNotice = (): Promise<void> => {
        if (!workspaceId) return Promise.resolve();
        return trackPending((async () => {
            const next = await updateWorkspaceData(workspaceId, prev => withFailureGroupState(prev, { categoryNormalisationNotice: null }));
            if (next?.failureGroupState) {
                applyFg(next.failureGroupState);
                await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    };

    /** The model Train/staleness checks should actually judge RIGHT NOW: the
     *  persisted model, merged with any pending (unsaved) draft edit for it —
     *  same merge `runTrainClick` commits on an actual Train. A draft change
     *  to a fingerprinted field (stiffness, predictors, Y, cluster settings,
     *  Workspace/Custom, …) must make the results area go stale and disable
     *  Mark complete IMMEDIATELY, not only after Save/Train (QA fix,
     *  2026-09-29 — "an unsaved draft edit after training leaves the old
     *  chart up and Mark complete enabled"). The persisted
     *  `trainedFingerprint` write itself only ever happens through
     *  `runTrainClick`/`executeTrain`, never from this. */
    const effectiveModelFor = (m: FailureModel): FailureModel =>
        m.id in drafts ? { ...m, ...draftFields(m, draftOf(m)) } : m;

    /** "Trained" (the status pill, distinct from Complete): a successful
     *  Phase-B preview run exists AND its fingerprint still matches the
     *  model's current inputs AND the model isn't already Complete — see
     *  `src/utils/trainFingerprint.ts` and the SPEC FINAL entry in
     *  `docs/PROJECT_HANDOVER.md`. */
    const isModelTrainedFresh = (m: FailureModel): boolean =>
        !m.status && trainedFreshFor(effectiveModelFor(m), gateFg);
    /** Was trained at some point, but the model's inputs (or the effective
     *  running condition) changed since — "Settings changed — re-train". */
    const isModelStale = (m: FailureModel): boolean =>
        !m.status && !!m.lastTrainedAt && !trainedFreshFor(effectiveModelFor(m), gateFg);

    const toggleModelStatus = (modelId: string) => {
        // Toward Complete only: an unconfigured model can't be marked Complete;
        // going back to Incomplete is always allowed. Build Model Workbench
        // Phase B adds a second requirement for Incomplete -> Complete: the
        // model must have been Trained (fresh, not stale) first — a model
        // can't be marked complete straight from "Incomplete config" or a
        // stale preview (SPEC FINAL, footer rule 6). This does NOT change
        // `markModelComplete` (the PM page's own "Finish" button) — that is
        // a separate, unchanged path.
        const target = allModels.find(m => m.id === modelId);
        if (target && !target.status && (gateReasonOf(target) !== null || !isModelTrainedFresh(target) || trainError[modelId])) return;
        persist((models, groups) => ({
            groups,
            models: models.map(m => m.id === modelId ? { ...m, status: !m.status } : m),
        }));
    };

    /** Everything currently wrong with THIS model's own settings, plus (if
     *  distinct from the category reason `missingItems` already covers) the
     *  running-condition/period gate reason — feeds the results area's
     *  "N items to fix" list. Reuses the exact same messaging `missingItems`
     *  already surfaces in the collapsible Model settings section, per the
     *  SPEC FINAL instruction not to invent a second wording for the same
     *  thing. Each item carries its own "take me there" action. */
    const incompleteItems = (m: FailureModel): { text: string; onClick: () => void }[] => {
        const items = missingItems(m).map(text => ({
            text,
            onClick: () => setSettingsOpenOverride(prev => ({ ...prev, [m.id]: true })),
        }));
        const gr = gateReasonOf(m);
        // Avoid double-reporting the category reason: `missingItems` already
        // lists "Pick a category" when it's null; `gateReasonOf` returns the
        // SAME `CATEGORY_BLOCK_REASON` text in that case, not a distinct one.
        if (gr && categoryOf(m) !== null) items.push({ text: gr, onClick: () => setRcFilterOpen(true) });
        return items;
    };

    /** Runs the read-only preview computation for ONE model (Phase B —
     *  "the SAME preview computations the PM page already runs for
     *  training/preview purposes": `compute_sensor_stats` / `preview_relationship_model` /
     *  `compute_clustering_preview`). Never writes a `*_INFO_*.json` file —
     *  that's the next phase. `opts.persistMeta` distinguishes an explicit
     *  Train/Re-train click (writes `lastTrainedAt`/`trainedFingerprint` via
     *  `persist()`, never a hand-built object literal) from the silent
     *  auto-recompute that runs when reopening an already-Trained-and-fresh
     *  model (session-only — nothing to persist, the fingerprint hasn't
     *  changed). `merged` carries the exact inputs used, so a Train click can
     *  pass the just-committed draft values without waiting for this
     *  window's state to re-render first (see `runTrainClick`). */
    const executeTrain = async (merged: FailureModel, fingerprint: string, opts: { persistMeta: boolean }): Promise<void> => {
        const id = merged.id;
        // 🆕 QA fix (2026-09-29): a Train can still be running when this
        // window gets re-pointed at a different workspace (`build-model-data`
        // for a new project). `persist()`'s write targets whatever
        // `workspaceId` its OWN closure captured at call time, which is
        // fine — but its `applyFg` call replaces this window's CURRENT
        // in-memory state unconditionally, even though `workspaceIdRef`
        // already points elsewhere by the time this resolves. Capture the
        // workspace this run belongs to now, and refuse to write back (or
        // touch any of this window's state) if it no longer matches once the
        // preview actually finishes — "train ค้างแล้ว workspace เปลี่ยน →
        // ทิ้งผล ไม่เขียนกลับ" (SPEC FINAL). A stray `trainStatus`/`trainResults`
        // entry for the abandoned model id is harmless: the effect above
        // already prunes any id no longer in the (now different) `allModels`.
        const capturedWorkspaceId = workspaceIdRef.current;
        setTrainStatus(prev => ({ ...prev, [id]: 'loading' }));
        setTrainError(prev => {
            if (!(id in prev)) return prev;
            const rest = { ...prev };
            delete rest[id];
            return rest;
        });
        try {
            const eff = effectiveRunningCondition(merged, gateFg);
            const filter = buildPreviewFilterPayload(eff, gateHeaders);
            let result: TrainResult;
            if (merged.kind === 'individual') {
                const stats = await invoke<SensorStats>('compute_sensor_stats', { sensor: merged.targetSensor, filter });
                result = { kind: 'individual', stats };
            } else if (merged.kind === 'relationship') {
                const r = await invoke<RelationshipPreviewResult>('preview_relationship_model', {
                    predictors: merged.predictorSensors,
                    target: merged.targetSensor,
                    lambda: merged.relStiffness,
                    filter,
                });
                if (r.error) throw new Error(r.error);
                result = { kind: 'relationship', result: r, predictorsAtApply: [...merged.predictorSensors] };
            } else {
                const effClusters = merged.numClusters ?? 3;
                const r = await invoke<ClusteringPreview>('compute_clustering_preview', {
                    first_sensor: merged.xSensor,
                    second_sensor: merged.ySensor,
                    n_clusters: effClusters,
                    criteria_sensor: merged.criteriaSensor ? merged.criteriaSensor : null,
                    cluster_ranges: merged.criteriaSensor ? (merged.clusterRanges ?? []).slice(0, effClusters) : null,
                    filter,
                });
                result = { kind: 'clustering', preview: r };
            }
            if (workspaceIdRef.current !== capturedWorkspaceId) return; // abandoned — see comment above
            setTrainResults(prev => ({ ...prev, [id]: { fingerprint, result } }));
            setTrainStatus(prev => {
                const rest = { ...prev };
                delete rest[id];
                return rest;
            });
            if (opts.persistMeta) {
                await persist((models, groups) => ({
                    groups,
                    models: models.map(x => x.id === id ? { ...x, lastTrainedAt: new Date().toISOString(), trainedFingerprint: fingerprint } : x),
                }));
            }
        } catch (e) {
            if (workspaceIdRef.current !== capturedWorkspaceId) return; // abandoned — see comment above
            setTrainStatus(prev => {
                const rest = { ...prev };
                delete rest[id];
                return rest;
            });
            setTrainError(prev => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }));
        }
    };

    /** The footer's Train/Re-train button. Commits any pending draft edits
     *  FIRST (same as "Open full view" already does via `buildModel` ->
     *  `commitModel`) so a predictor/stiffness/etc. change made just before
     *  clicking Train is what actually gets trained and fingerprinted —
     *  never a stale, unsaved combination. Only actually MERGES the draft
     *  into the trained/fingerprinted model when a draft is genuinely
     *  pending for it (QA fix, 2026-09-29 — "Train never sticks for some
     *  models"): `draftFields`/`draftFromModel` re-derive/re-snap fields
     *  (e.g. `snapStiffness`, or defaulting `clusterRanges` off the DEFAULT
     *  when the model never had any) even with nothing to commit, which
     *  could fingerprint a value that doesn't match what's actually stored —
     *  stale the instant Train finishes, forever. With no pending draft,
     *  train against the persisted `m` directly, unmodified. */
    const runTrainClick = async (m: FailureModel) => {
        if (buildBlockReason(m) !== null) return;
        if (trainStatus[m.id] === 'loading') return;
        const hasDraft = m.id in drafts;
        const merged = effectiveModelFor(m); // = m untouched when no draft is pending
        if (hasDraft) await commitModel(m);
        const fingerprint = computeTrainFingerprint(merged, gateFg);
        await executeTrain(merged, fingerprint, { persistMeta: true });
    };

    /** Text shown (and the reason `markModelComplete` blocks on) when the
     *  gate itself passes but the model hasn't been Trained-and-fresh —
     *  shared so the PM page's Finish path and the Workbench's own "✓ Mark
     *  complete" button title never drift into two different wordings for
     *  the same requirement. */
    const NOT_TRAINED_BLOCK_REASON = 'Train the model, then check the result before marking it complete.';

    /** Sets `status: true` unconditionally (unlike `toggleModelStatus`) —
     *  used by the PM page's "Finish" button, where clicking it again should
     *  never accidentally flip an already-complete model back to incomplete.
     *  Un-marking a model still goes through the footer's own action button
     *  (`toggleModelStatus`). The gate is evaluated against what is on DISK
     *  inside the write (the PM page flushes its own edits first), never
     *  against this window's possibly lagging copy.
     *  🆕 QA scope-gap fix (2026-09-29): "Finish" used to mark a model
     *  Complete straight from the gate check alone, with no requirement that
     *  it had ever been Train'd — a second, looser gate than the Workbench's
     *  own "✓ Mark complete" button. SPEC FINAL says Mark complete replaces
     *  Finish everywhere, so this now ALSO requires `trainedFreshFor` — the
     *  exact same fingerprint-equality helper `isModelTrainedFresh` uses —
     *  checked against the model/fg read fresh off disk, never a second,
     *  independently-derived "is this trained" definition. (2026-09-30: that
     *  helper now lives in `src/utils/trainFingerprint.ts` as the exported
     *  `isModelTrainedFresh`, imported here under this file's existing local
     *  name `trainedFreshFor` — one definition, not two, also reused directly
     *  by `FailureGroupsPanel.tsx`'s status dot.) */
    const markModelComplete = (modelId: string): Promise<void> => {
        if (!workspaceId) return Promise.resolve();
        setCompleteBlock(null);
        return trackPending((async () => {
            const res = { reason: null as string | null };
            const next = await updateWorkspaceData(workspaceId, prev => {
                const fg = prev.failureGroupState;
                const target = fg?.models?.find(m => m.id === modelId);
                if (!target) return prev;
                res.reason = getBuildBlockReason(target, fg, gateHeaders);
                if (res.reason === null && !trainedFreshFor(target, fg)) res.reason = NOT_TRAINED_BLOCK_REASON;
                if (res.reason !== null) return prev;
                return withFailureGroupState(prev, { models: (fg?.models ?? []).map(m => m.id === modelId ? { ...m, status: true } : m) });
            });
            if (res.reason !== null) setCompleteBlock(res.reason);
            if (next?.failureGroupState) {
                applyFg(next.failureGroupState);
                if (res.reason === null) await emit('failure-group-state-changed', { ...next.failureGroupState, workspaceId, origin: 'build-model' });
            }
        })());
    };

    const trainModel = (modelId: string) => {
        // Guard at the source too, so a future caller can't bypass the gate.
        const target = allModels.find(m => m.id === modelId);
        if (target && gateReasonOf(target) !== null) return;
        setPmPageModelId(modelId);
        setActivePage('model');
    };

    // 🆕 2026-09-29 [data-loss fix]: awaits every in-flight write before
    // actually closing the window. See `flushAllPending` above and the
    // `onCloseRequested` effect below for the native-close equivalent.
    // 🆕 2026-09-30: `flushFocusedInput()` first, so a half-typed Running
    // Condition period date (blur/Enter-committed only, see that function's
    // own comment) is forced to commit — and lands in `pendingSaveRef` below
    // — even if this button click didn't happen to blur it naturally first.
    const handleClose = async () => {
        flushFocusedInput();
        await flushAllPending();
        await getCurrentWindow().close();
    };

    // 🆕 2026-09-29 [data-loss fix]: a native close (the window's own X
    // button, Alt+F4, or the OS closing the app) bypasses `handleClose`
    // entirely. Only intercepts the close when this window has an in-flight
    // write of its own or the PM page is currently mounted.
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        const win = getCurrentWindow();
        Promise.resolve(win.onCloseRequested(async (event) => {
            // 🆕 2026-09-30: same reasoning as `handleClose` above — a native
            // close (titlebar X, Alt+F4, OS shutdown) must not be able to
            // bypass a period edit that never naturally blurred. Read
            // `pmPending`/`pending` AFTER this, not before, so a write this
            // call itself just kicked off is included below.
            flushFocusedInput();
            const pmPending = pmFlushRef.current;
            const pending = pendingSaveRef.current;
            if (!pmPending && !pending) return;
            event.preventDefault();
            await flushAllPending();
            await win.close();
        })).then(fn => { if (disposed) fn(); else unlisten = fn; });
        return () => { disposed = true; if (unlisten) unlisten(); };
    }, [flushAllPending]);

    // 🆕 2026-09-18 [bug fix]: must await commitModel's write landing on disk
    // before navigating to the PM page — else the PM page's own hydration
    // effect (which reads the workspace file directly) can win the race and
    // load the model record from BEFORE this commit.
    const buildModel = async (m: FailureModel) => {
        if (buildBlockReason(m) !== null) return;
        await commitModel(m);
        trainModel(m.id);
    };

    // Hoisted above the `if (loading)` guard (and therefore above every hook
    // below it) so `individualChartQuery`/the auto-recompute effect can read
    // `activeModel` — every hook in this component must run unconditionally
    // on every render, so none of them can sit after an early return. These
    // three lines are otherwise identical to the ones the render body below
    // used to compute locally; nothing about their VALUE changed, only where
    // they're computed.
    const sensorGroupsAll = allSensorGroups(allModels);
    const fullSensorMap = new Map(sensorGroupsAll.map(sg => [sg.key, sg]));
    const detailModels = selectedSensorKey !== null ? (fullSensorMap.get(selectedSensorKey)?.models ?? []) : [];
    const orderedDetail = KIND_ORDER.flatMap(k => detailModels.filter(m => m.kind === k));
    const activeModel = orderedDetail.find(m => m.id === activeTab[selectedSensorKey ?? '']) ?? orderedDetail[0];

    // ---- Individual chart's time-series feed (Phase B) ----------------
    // Bounded columnar fetch via `get_chart_data`, same path PredictiveModelBuild.tsx's
    // own `targetChartQuery` uses — only active once a successful
    // `compute_sensor_stats` run exists for the currently active model, so
    // switching sensors doesn't fire an unnecessary fetch for every kind tab.
    const individualChartQuery = useMemo(() => {
        if (!activeModel || activeModel.kind !== 'individual') return null;
        const cached = trainResults[activeModel.id];
        if (!cached || cached.result.kind !== 'individual') return null;
        const eff = effectiveRunningCondition(activeModel, gateFg);
        const rawFilters = eff.noneConfirmed ? [] : eff.filters;
        const valueFilters = rawFilters
            .filter(sf => isCompleteCondition(sf, gateHeaders))
            .map(sf => ({
                sensor: sf.sensor,
                operation: sf.operation,
                value1: sf.value1 !== '' ? parseFloat(sf.value1) : null,
                value2: sf.value2 !== '' ? parseFloat(sf.value2) : null,
            }));
        const ranges = toFilterRanges(eff.periods);
        const filterRanges = ranges.some(rg => rg.start === null && rg.end === null) ? [] : ranges;
        return {
            filter: {
                sensors: [activeModel.targetSensor],
                timestamp_start: null,
                timestamp_end: null,
                timestamp_ranges: filterRanges,
                value_filters: valueFilters,
            },
            sampling: 'raw' as const,
            operation: null,
            maxPoints: RESULT_CHART_MAX_POINTS,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, activeModel?.kind, activeModel?.targetSensor, trainResults, runningConditionFilters, runningConditionCombine, runningConditionTimePeriods, runningConditionNoneConfirmed, gateHeaders]);
    const { view: individualChartView } = useChartData(individualChartQuery);

    // ---- Auto-recompute on reopen (Phase B, per explicit user decision) ---
    // A model that is already Trained-and-fresh (per the WORKSPACE'S
    // persisted `lastTrainedAt`/`trainedFingerprint`) shows its result
    // immediately, with no click required — this silently re-runs the same
    // read-only preview query in the background (cheap; same live query the
    // PM page already runs on every mount) whenever the Workbench doesn't yet
    // have a cached result for the CURRENT fingerprint (a fresh session, or
    // this exact model wasn't open before). Never fires for a Complete model
    // (status === true is not part of "Trained"), never persists anything
    // (`persistMeta: false` — the fingerprint didn't change), and never fires
    // while a run for this model is already in flight.
    useEffect(() => {
        if (!activeModel || activeModel.status) return;
        if (buildBlockReason(activeModel) !== null) return;
        const fp = computeTrainFingerprint(activeModel, gateFg);
        if (!activeModel.lastTrainedAt || activeModel.trainedFingerprint !== fp) return;
        const cached = trainResults[activeModel.id];
        if (cached && cached.fingerprint === fp) return;
        if (trainStatus[activeModel.id] === 'loading') return;
        void executeTrain(activeModel, fp, { persistMeta: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeModel?.id, activeModel?.trainedFingerprint, activeModel?.lastTrainedAt, activeModel?.status, activeModel?.category, runningConditionFilters, runningConditionCombine, runningConditionTimePeriods, runningConditionNoneConfirmed]);

    if (loading) {
        return <div style={{ background: 'var(--card-bg)', height: '100vh' }} />;
    }

    const realGroups = [...allGroups].filter(g => g.no !== 0).sort((a, b) => a.no - b.no);
    const totalModelsCount = allModels.length;
    const completeModelsCount = allModels.filter(m => m.status).length;

    const sensorBuildBlocked = (sg: SensorModelGroup) => sg.models.some(m => buildBlockReason(m) !== null);
    const sensorAllComplete = (sg: SensorModelGroup) => sg.models.length > 0 && sg.models.every(m => m.status);
    const matchesSidebarFilter = (sg: SensorModelGroup) =>
        sidebarFilter === 'all' || (sidebarFilter === 'attn' ? sensorBuildBlocked(sg) : sensorAllComplete(sg));
    const matchesSearch = (sg: SensorModelGroup) => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        const first = sg.models[0];
        if (!first) return false;
        const keyTag = (first.kind === 'clustering' ? first.xSensor : first.targetSensor) ?? '';
        return sensorLabel(keyTag).toLowerCase().includes(q) || keyTag.toLowerCase().includes(q);
    };
    const attnCount = sensorGroupsAll.filter(sensorBuildBlocked).length;
    const doneCount = sensorGroupsAll.filter(sensorAllComplete).length;

    // One left-list row for one sensor (within one grouping bucket — the same
    // sensor can render under several Failure Group buckets when it belongs
    // to more than one; selecting any of them shows the SAME detail pane).
    const renderSensorListRow = (sg: SensorModelGroup, bucketId: string) => {
        if (sg.models.length === 0 || !matchesSearch(sg) || !matchesSidebarFilter(sg)) return null;
        const first = sg.models[0];
        const keyTag = (first.kind === 'clustering' ? first.xSensor : first.targetSensor) ?? '';
        const title = keyTag ? (getDesc(keyTag) || keyTag) : modelDisplayLabel(first);
        const label = keyTag ? sensorLabel(keyTag) : title;
        const ordered = KIND_ORDER.flatMap(k => sg.models.filter(m => m.kind === k));
        const selected = sg.key === selectedSensorKey;
        return (
            <div
                key={`${bucketId}:${sg.key}`}
                data-testid={`sensor-list-row-${bucketId}-${sg.key || 'blank'}`}
                className={`bmw-srow${selected ? ' bmw-srow--sel' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                onClick={() => setSelectedSensorKey(sg.key)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedSensorKey(sg.key); } }}
            >
                <div style={{ minWidth: 0 }}>
                    <div data-testid="sensor-row-label" className="f4-sr-title" title={label}>{title}</div>
                    <div className="f4-sr-tag">{keyTag}</div>
                </div>
                <div className="f4-kinds">
                    {ordered.map(m => {
                        // Phase B status dot in the badge's corner: no dot =
                        // never trained, blue = Trained (not stale, not
                        // Complete), green = Complete. Stale reads as "no
                        // dot" here (same as the pill) — the badge is just a
                        // glance, the detail pane's own results area is
                        // where "Settings changed" actually shows.
                        // 🆕 QA fix (2026-09-29): a model the GATE currently
                        // blocks (e.g. its running-condition sensor vanished
                        // from the dataset) or whose last preview attempt
                        // errored in this session must not still read
                        // "Trained" here just because its persisted
                        // fingerprint happens to still match — same rule the
                        // footer pill below now applies.
                        const dot = m.status ? 'complete'
                            : (isModelTrainedFresh(m) && !trainError[m.id] && buildBlockReason(m) === null) ? 'trained'
                            : null;
                        return (
                            <span
                                key={m.id}
                                data-testid={`sensor-kind-badge-${m.id}`}
                                className={`f4-kb model-kind-icon--${m.kind}`}
                                title={`${KIND_LABEL[m.kind]} · ${m.status ? 'Complete' : dot === 'trained' ? 'Trained' : 'Incomplete'}`}
                            >
                                {KIND_ABBREV[m.kind]}
                                {dot && <span data-testid={`sensor-kind-badge-dot-${m.id}`} className={`f4-kb-dot f4-kb-dot--${dot}`} aria-hidden="true" />}
                            </span>
                        );
                    })}
                </div>
            </div>
        );
    };

    const renderLeftList = () => {
        if (leftGroupBy === 'fg') {
            const fgSection = (no: number, name: string) => {
                const rows = groupModelsBySensor(allModels, no);
                const visible = rows.filter(sg => matchesSearch(sg) && matchesSidebarFilter(sg));
                return (
                    <div key={no}>
                        <div className="bmw-list-grp"><i style={{ background: FG_ACCENT[getFgGroupColor(no)] }} />{no === 0 ? 'Not in Group' : `FG-${no} · ${name}`}</div>
                        {rows.length === 0 ? (
                            <div className="bmw-srow-empty">No models yet</div>
                        ) : visible.length === 0 ? (
                            <div className="bmw-srow-empty">No sensors match</div>
                        ) : visible.map(sg => renderSensorListRow(sg, `fg:${no}`))}
                    </div>
                );
            };
            return (
                <>
                    {realGroups.map(g => fgSection(g.no, g.name))}
                    {fgSection(0, '')}
                </>
            );
        }
        const byComp = new Map<string, SensorModelGroup[]>();
        for (const sg of sensorGroupsAll) {
            const comp = sg.models[0] ? modelComponent(sg.models[0]) : UNCATEGORIZED;
            if (!byComp.has(comp)) byComp.set(comp, []);
            byComp.get(comp)!.push(sg);
        }
        const comps = [...byComp.entries()].sort(([a], [b]) => a.localeCompare(b));
        if (comps.length === 0) return <div className="bmw-srow-empty">No models yet</div>;
        return comps.map(([comp, rows]) => {
            const visible = rows.filter(sg => matchesSearch(sg) && matchesSidebarFilter(sg));
            return (
                <div key={comp}>
                    <div className="bmw-list-grp"><i style={{ background: 'var(--text-faint)' }} />{comp}</div>
                    {visible.length === 0
                        ? <div className="bmw-srow-empty">No sensors match</div>
                        : visible.map(sg => renderSensorListRow(sg, `component:${comp}`))}
                </div>
            );
        });
    };

    // ---- Detail pane (Phase A) ---- `detailModels`/`orderedDetail`/
    // `activeModel` are computed above (before the `if (loading)` guard —
    // every hook needs them, see the comment there); reused here as-is.

    const renderModelSettingsFields = (m: FailureModel, d: ModelDraft) => (
        <>
            {/* 🆕 2026-09-30 (issue 2/3 fix): a fixed, generous width shared by
                all three kinds — was `minWidth: 200px` with no cap, which let
                a long real sensor name (e.g. "GENERATOR BEARING METAL
                TEMPERATURE") render far narrower than its text, scrolling
                off-screen with no ellipsis/tooltip. `.f4-fld--name` (App.css)
                grows with available space up to a real cap instead. */}
            <div className="f4-fld f4-fld--name">
                <label>Model name</label>
                <input
                    className="fg-inspector-input"
                    value={d.name}
                    placeholder="e.g. Bearing vibration model"
                    title={d.name || undefined}
                    style={d.name.trim() ? undefined : { borderColor: 'var(--warn-line)' }}
                    onChange={e => patchDraft(m, { name: e.target.value })}
                />
                {(() => {
                    const conflict = nameConflictOf(m);
                    if (!conflict) return null;
                    const suggestion = suggestDistinctModelName(allModels, m, d.name);
                    return (
                        <div data-testid="duplicate-name-warning" className="f4-req-note" style={{ marginTop: '4px' }}>
                            Same name as this sensor's {KIND_LABEL[conflict.kind]} model — give it a different name so they can be told apart
                            <button
                                type="button"
                                data-testid="use-suggested-name"
                                style={{ marginLeft: '8px', textDecoration: 'underline', color: 'inherit', cursor: 'pointer', background: 'none', border: 'none', padding: 0, fontSize: 'inherit' }}
                                onClick={() => patchDraft(m, { name: suggestion })}
                            >
                                Use '{suggestion}'
                            </button>
                        </div>
                    );
                })()}
            </div>

            {/* 🆕 2026-09-30 (issue 3 fix): every kind's OWN fields (as opposed
                to Model name / Training data, which are shared and always
                the same shape) live in one wrapping group so they read as a
                consistent block across Individual/Relationship/Clustering
                instead of each kind cramming a different field count into
                the same single flex row. `.bmw-sets-kind` (App.css) is
                itself flex-wrap, so Clustering's 4-5 fields fall onto a
                second line rather than being squeezed narrower than their
                content — see that class's own comment for the exact widths. */}
            <div className="bmw-sets-kind">
            {m.kind === 'individual' && (
                <div className="f4-fld">
                    <span className="f4-lbl">Boundary</span>
                    <span className="f4-pill f4-pill--grey" style={{ height: '28px', display: 'inline-flex' }}>1σ + 3σ · automatic</span>
                    <div className="f4-hint">Everything else is automatic for an Individual model.</div>
                </div>
            )}

            {m.kind === 'relationship' && (
                <>
                    <div className="f4-fld f4-fld--grow" style={{ flex: 1, minWidth: '260px' }}>
                        <span className="f4-lbl">Predictor sensors (≥ 1)</span>
                        <SensorPickerModal
                            sensors={allSensors}
                            getDesc={getDesc}
                            getComponent={getComponent}
                            selected={d.predictors}
                            excluded={[m.targetSensor ?? '']}
                            onConfirm={predictors => patchDraft(m, { predictors })}
                            noun="predictors"
                            triggerText={d.predictors.length ? `${d.predictors.length} selected. Edit predictors…` : undefined}
                            invalid={d.predictors.length === 0}
                        />
                        {d.predictors.length > 0 ? (
                            <div className="f4-pchips">
                                {d.predictors.map(p => (
                                    <span key={p} className="f4-ppill" title={sensorLabel(p)}>
                                        <span>{sensorLabel(p)}</span>
                                        <button type="button" aria-label={`Remove ${p}`} onClick={() => patchDraft(m, { predictors: d.predictors.filter(x => x !== p) })}>
                                            <X size={10} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <div className="f4-req-note">No predictors yet. A Relation model needs at least one.</div>
                        )}
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Stiffness</span>
                        <div className="f4-seg">
                            {STIFFNESS_OPTIONS.map(opt => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    className={d.stiffness === opt.value ? 'on' : undefined}
                                    onClick={() => patchDraft(m, { stiffness: opt.value })}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            )}

            {m.kind === 'clustering' && (
                <>
                    <div className="f4-fld">
                        <span className="f4-lbl">X sensor</span>
                        <div className="f4-readout" title={m.xSensor ? sensorLabel(m.xSensor) : undefined}>
                            <Lock size={12} aria-hidden="true" />
                            <span>{m.xSensor ? sensorLabel(m.xSensor) : '—'}</span>
                        </div>
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Y sensor (target)</span>
                        <SensorPickerModal
                            sensors={allSensors}
                            getDesc={getDesc}
                            getComponent={getComponent}
                            single
                            value={d.y}
                            onSelect={y => patchDraft(m, { y })}
                            noun="Y sensor"
                            placeholder="None selected"
                            invalid={!d.y}
                        />
                        {!d.y && <div className="f4-req-note">Required</div>}
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Criteria sensor (optional)</span>
                        <SensorPickerModal
                            sensors={allSensors}
                            getDesc={getDesc}
                            getComponent={getComponent}
                            single
                            allowNone
                            value={d.criteria}
                            onSelect={criteria => patchDraft(m, { criteria })}
                            noun="criteria sensor"
                            placeholder="None"
                        />
                    </div>
                    <div className="f4-fld">
                        <span className="f4-lbl">Clusters</span>
                        <span className="bmw-step">
                            <button type="button" aria-label="Fewer clusters" onClick={() => patchDraft(m, { numClusters: Math.max(1, d.numClusters - 1) })}>−</button>
                            <span>{d.numClusters}</span>
                            <button type="button" aria-label="More clusters" onClick={() => patchDraft(m, { numClusters: Math.min(8, d.numClusters + 1) })}>+</button>
                        </span>
                    </div>
                    {d.criteria && (
                        <div className="f4-fld f4-fld--grow" style={{ flex: 1, minWidth: '240px' }}>
                            <span className="f4-lbl">Cluster ranges</span>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {d.ranges.map((r, i) => (
                                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '16px minmax(0,1fr) minmax(0,1fr)', gap: '6px', alignItems: 'center' }}>
                                        <b style={{ fontSize: '0.68rem', color: 'var(--text-faint)', fontWeight: 500 }}>{i + 1}</b>
                                        <input
                                            type="number"
                                            className="fg-inspector-input"
                                            value={r.min ?? ''}
                                            placeholder="min"
                                            aria-label={`Cluster ${i + 1} min`}
                                            onChange={e => patchDraft(m, { ranges: d.ranges.map((row, idx) => idx === i ? { ...row, min: e.target.value === '' ? null : Number(e.target.value) } : row) })}
                                        />
                                        <input
                                            type="number"
                                            className="fg-inspector-input"
                                            value={r.max ?? ''}
                                            placeholder="max"
                                            aria-label={`Cluster ${i + 1} max`}
                                            onChange={e => patchDraft(m, { ranges: d.ranges.map((row, idx) => idx === i ? { ...row, max: e.target.value === '' ? null : Number(e.target.value) } : row) })}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}
            </div>

            {/* Always last, same fixed width in all three kinds (issue 3 fix) —
                `.f4-fld--traindata` (App.css). */}
            <div className="f4-fld f4-fld--traindata">
                <span className="f4-lbl">Training data</span>
                <div className="f4-seg">
                    <button type="button" className={d.runningConditionMode === 'workspace' ? 'on' : undefined} onClick={() => patchDraft(m, { runningConditionMode: 'workspace' })}>Workspace</button>
                    <button type="button" className={d.runningConditionMode === 'custom' ? 'on' : undefined} onClick={() => patchDraft(m, { runningConditionMode: 'custom' })}>Custom</button>
                </div>
                <div className="f4-hint">Custom edits its own conditions on the full Build page.</div>
            </div>
        </>
    );

    const renderModelSettings = (m: FailureModel) => {
        const d = draftOf(m);
        const missing = missingItems(m);
        const isOpen = settingsOpenOverride[m.id] ?? (missing.length > 0);
        const toggle = () => setSettingsOpenOverride(prev => ({ ...prev, [m.id]: !isOpen }));
        return (
            <div className={`bmw-sets${isOpen ? ' bmw-sets--open' : ''}`}>
                <button type="button" className="bmw-sets-h" aria-expanded={isOpen} onClick={toggle}>
                    <ChevronRight size={13} className="bmw-sets-chev" aria-hidden="true" />
                    <b>Model settings</b>
                    {isOpen ? <span className="bmw-sets-sp" /> : <span className="bmw-sets-sum">{settingsSummaryLine(m, d)}</span>}
                    {missing.length > 0 && <span data-testid="settings-to-fix" className="f4-pill f4-pill--warn">{missing.length} to fix</span>}
                </button>
                {isOpen && (
                    <div data-testid="add-model-form" className="bmw-sets-body">
                        {renderModelSettingsFields(m, d)}
                    </div>
                )}
            </div>
        );
    };

    /** The Phase-B chart+toolbar for a Trained-and-fresh model's cached
     *  result — legend on the left, numeric readouts on the right, ⤢ expand.
     *  Reuses the PM page's own `.pm-chart-card`/`.pm-chart-header`/
     *  `.pm-legend-*`/`.pm-stats-*` classes (see PredictiveModelBuild.tsx)
     *  rather than inventing a parallel set, composed into the "toolbar
     *  above the chart" shape the SPEC FINAL results-area asks for. `expanded`
     *  renders the chart alone (no card chrome) for the ⤢ modal. */
    const renderResultChart = (m: FailureModel, entry: TrainCacheEntry, expanded = false) => {
        if (entry.result.kind === 'individual') {
            const s = entry.result.stats;
            const hasChartData = (individualChartView?.timestamps.length ?? 0) > 0;
            const markLines: ChartMarkLine[] = [
                { sensor: m.targetSensor, y: s.mean, label: 'Mean', color: '#f1f5f9', lineStyle: 'solid' },
                { sensor: m.targetSensor, y: s.upper1, label: '+1σ', color: '#f59e0b', lineStyle: 'solid' },
                { sensor: m.targetSensor, y: s.lower1, label: '−1σ', color: '#f59e0b', lineStyle: 'solid' },
                { sensor: m.targetSensor, y: s.upper3, label: '+3σ', color: '#f43f5e', lineStyle: 'dashed' },
                { sensor: m.targetSensor, y: s.lower3, label: '−3σ', color: '#f43f5e', lineStyle: 'dashed' },
            ];
            return !hasChartData ? (
                <div className="plot-placeholder pm-chart-placeholder"><Activity size={40} style={{ opacity: 0.2 }} aria-hidden="true" /><p>No data available for {m.targetSensor}</p></div>
            ) : (
                <LineChart
                    data={EMPTY_RECORDS}
                    columnar={{ timestamps: individualChartView!.timestamps, series: individualChartView!.series }}
                    sensors={[m.targetSensor]}
                    headers={individualChartView!.headers.length ? individualChartView!.headers : [m.targetSensor]}
                    markLines={markLines}
                    hideYSplitLine
                />
            );
        }
        if (entry.result.kind === 'relationship') {
            const option = buildRelScatterOption(entry.result.result, entry.result.predictorsAtApply, m.targetSensor);
            return option ? (
                <ResponsiveECharts option={option} style={{ minHeight: expanded ? '100%' : '200px', height: expanded ? '100%' : undefined }} />
            ) : (
                <div className="plot-placeholder pm-chart-placeholder"><GitBranch size={40} style={{ opacity: 0.2 }} aria-hidden="true" /><p>No chart data</p></div>
            );
        }
        const option = buildClusteringScatterOption(entry.result.preview);
        return option ? (
            <ResponsiveECharts option={option} style={{ minHeight: expanded ? '100%' : '200px', height: expanded ? '100%' : undefined }} />
        ) : (
            <div className="plot-placeholder pm-chart-placeholder"><Layers size={40} style={{ opacity: 0.2 }} aria-hidden="true" /><p>No chart data</p></div>
        );
    };

    const renderResultToolbar = (m: FailureModel, entry: TrainCacheEntry) => {
        if (entry.result.kind === 'individual') {
            const s = entry.result.stats;
            return (
                <>
                    <div className="pm-chart-legend">
                        <span className="pm-legend-dot"><span className="pm-legend-line pm-legend-accent" />Target</span>
                        <span className="pm-legend-dot"><span className="pm-legend-line pm-legend-warn" />±1σ</span>
                        <span className="pm-legend-dot"><span className="pm-legend-line pm-legend-danger pm-legend-dashed" />±3σ</span>
                    </div>
                    <div className="pm-stats-strip bmw-result-stats">
                        <div className="pm-stats-item"><span className="pm-stats-label">Rows</span><span className="pm-stats-value">{s.count.toLocaleString()}</span></div>
                        <div className="pm-stats-item"><span className="pm-stats-label">Mean</span><span className="pm-stats-value">{s.mean.toFixed(3)}</span></div>
                        <div className="pm-stats-item"><span className="pm-stats-label">1σ</span><span className="pm-stats-value">{s.lower1.toFixed(3)} – {s.upper1.toFixed(3)}</span></div>
                        <div className="pm-stats-item"><span className="pm-stats-label">3σ</span><span className="pm-stats-value pm-stats-warn">{s.lower3.toFixed(3)} – {s.upper3.toFixed(3)}</span></div>
                    </div>
                </>
            );
        }
        if (entry.result.kind === 'relationship') {
            const r = entry.result.result;
            const r2 = r.r2_per_step.length ? r.r2_per_step[r.r2_per_step.length - 1] : null;
            const rmse2 = r.rmse2_per_step.length ? r.rmse2_per_step[r.rmse2_per_step.length - 1] : null;
            return (
                <>
                    <div className="pm-chart-legend">
                        <span className="pm-legend-dot"><span className="pm-legend-line" style={{ background: '#3b82f6' }} />Raw</span>
                        <span className="pm-legend-dot"><span className="pm-legend-line" style={{ background: '#f43f5e' }} />Model</span>
                    </div>
                    <div className="pm-stats-strip bmw-result-stats">
                        <div className="pm-stats-item"><span className="pm-stats-label">Rows</span><span className="pm-stats-value">{r.predicted.length.toLocaleString()}</span></div>
                        <div className="pm-stats-item"><span className="pm-stats-label">R²</span><span className="pm-stats-value">{r2 !== null ? r2.toFixed(4) : '—'}</span></div>
                        <div className="pm-stats-item"><span className="pm-stats-label">2×RMSE</span><span className="pm-stats-value">{rmse2 !== null ? rmse2.toFixed(4) : '—'}</span></div>
                        <div className="pm-stats-item"><span className="pm-stats-label">Stiffness</span><span className="pm-stats-value">{stiffnessLabel(m.relStiffness)}</span></div>
                    </div>
                </>
            );
        }
        const preview = entry.result.preview;
        const shares = preview.clusters.length > 1 ? (() => {
            const sizes = preview.clusters.map(c => c.n_rows);
            const total = sizes.reduce((a, b) => a + b, 0) || 1;
            return { largest: Math.max(...sizes) / total * 100, smallest: Math.min(...sizes) / total * 100 };
        })() : null;
        return (
            <>
                <div className="pm-chart-legend">
                    {preview.clusters.map((c, i) => (
                        <span key={c.cluster_id} className="pm-legend-dot">
                            <span className="pm-legend-line" style={{ background: CLUSTER_PALETTE[i % CLUSTER_PALETTE.length] }} />
                            {preview.clusters.length === 1 ? 'Data' : `Cluster ${c.cluster_id}`}
                        </span>
                    ))}
                </div>
                <div className="pm-stats-strip bmw-result-stats">
                    <div className="pm-stats-item"><span className="pm-stats-label">Rows</span><span className="pm-stats-value">{preview.n_rows.toLocaleString()}</span></div>
                    <div className="pm-stats-item"><span className="pm-stats-label">Clusters</span><span className="pm-stats-value">{preview.cluster_count}</span></div>
                    {shares && (
                        <div className="pm-stats-item"><span className="pm-stats-label">Largest / smallest</span><span className="pm-stats-value">{shares.largest.toFixed(0)}% / {shares.smallest.toFixed(0)}%</span></div>
                    )}
                </div>
            </>
        );
    };

    /** Results area state machine (SPEC FINAL, results-area rule 5):
     *  Complete -> unchanged Phase-A placeholder · incomplete config/gate ->
     *  "N items to fix" list with jump-to-field links (reuses `missingItems`'
     *  wording) · running -> progress · Trained-and-fresh -> chart+toolbar ·
     *  stale -> "Settings changed" · never trained -> "Not trained yet". */
    const renderResultsStage = (m: FailureModel) => {
        if (m.status) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-placeholder">
                        Marked complete — open full view to see the chart.
                    </div>
                </div>
            );
        }
        const reason = buildBlockReason(m);
        if (reason !== null) {
            const items = incompleteItems(m);
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-incomplete" style={{ textAlign: 'left', alignItems: 'flex-start' }}>
                        <div style={{ fontWeight: 600, marginBottom: '6px', color: 'var(--text-primary)' }}>
                            {items.length} item{items.length === 1 ? '' : 's'} to fix before training
                        </div>
                        <ul style={{ margin: 0, paddingLeft: '18px' }}>
                            {items.map((it, i) => (
                                <li key={i}>
                                    <button type="button" className="bmw-fix-link" onClick={it.onClick}>{it.text}</button>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            );
        }
        if (trainStatus[m.id] === 'loading') {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-loading">
                        <Loader2 size={20} className="pm-spin" aria-hidden="true" /> Running…
                    </div>
                </div>
            );
        }
        const err = trainError[m.id];
        if (err) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-error" style={{ color: 'var(--warn)' }}>
                        Couldn't compute the preview: {err}
                    </div>
                </div>
            );
        }
        if (!m.lastTrainedAt) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-placeholder">Not trained yet</div>
                </div>
            );
        }
        if (isModelStale(m)) {
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-stale">Settings changed — re-train to see the result.</div>
                </div>
            );
        }
        const entry = trainResults[m.id];
        if (!entry) {
            // Trained-and-fresh per the workspace's persisted fields, but the
            // auto-recompute effect hasn't landed its first result in THIS
            // session yet.
            return (
                <div className="bmw-stage">
                    <div className="bmw-stage-empty" data-testid="results-loading">
                        <Loader2 size={20} className="pm-spin" aria-hidden="true" /> Loading the last result…
                    </div>
                </div>
            );
        }
        return (
            <div className="bmw-stage" style={{ flexDirection: 'column', gap: '10px' }}>
                <div className="pm-chart-card" style={{ flex: 1, minHeight: 0 }} data-testid="results-chart">
                    <div className="pm-chart-header">
                        {renderResultToolbar(m, entry)}
                        <button type="button" className="pm-chart-expand-btn" onClick={() => setResultExpanded(true)} title="Expand chart" aria-label="Expand chart">
                            <Maximize2 size={14} />
                        </button>
                    </div>
                    <div className="pm-chart-body">{renderResultChart(m, entry)}</div>
                </div>
            </div>
        );
    };

    const renderFooter = (m: FailureModel) => {
        const saveReason = modelBlockReason(m);
        const reason = buildBlockReason(m);
        const cat = categoryOf(m);
        const trainedFresh = isModelTrainedFresh(m);
        const stale = isModelStale(m);
        const training = trainStatus[m.id] === 'loading';
        // 🆕 QA fix (2026-09-29): a run that failed IN THIS SESSION — whether
        // an explicit Re-train click or the silent auto-recompute on reopen —
        // must override the happy-path pill/footer/Mark-complete-enabled
        // state even though the PERSISTED fields still say "fresh" (nothing
        // was written back on failure). Mirrors how a failed MANUAL Train
        // already keeps the Train/Re-train button visible for retry without
        // touching persisted fields — this just extends the same "in-session
        // error overrides the happy path" treatment to the pill/footer text/
        // Mark complete, which previously only looked at `trainedFresh`.
        const hasSessionError = !!trainError[m.id];
        const pillState: 'complete' | 'trained' | 'incomplete' =
            m.status ? 'complete' : (trainedFresh && !hasSessionError && reason === null) ? 'trained' : 'incomplete';
        const pillLabel = pillState === 'complete' ? 'Complete' : pillState === 'trained' ? 'Trained' : 'Incomplete';
        return (
            <div className="f4-foot">
                <span className={`model-status-pill model-status-pill--${pillState}`} style={{ cursor: 'default' }}>
                    {pillLabel}
                </span>
                {reason ? (
                    <span data-testid="build-block-reason" className="f4-foot-reason f4-foot-reason--block">
                        <CircleAlert size={11} aria-hidden="true" />
                        {reason}
                    </span>
                ) : m.id in drafts ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Unsaved changes to the {KIND_LABEL[m.kind]} model</span>
                ) : m.status ? (
                    <span data-testid="footer-status" className="f4-foot-reason">
                        {m.lastTrainedAt ? `Last trained ${formatTrainedAt(m.lastTrainedAt)}` : `${KIND_LABEL[m.kind]}${cat ? ` · ${CATEGORY_LABELS[cat]}` : ''}`}
                    </span>
                ) : hasSessionError ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Couldn't refresh the result — fix the problem, then re-train</span>
                ) : trainedFresh ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Check the chart, then mark it complete</span>
                ) : stale ? (
                    <span data-testid="footer-status" className="f4-foot-reason">Settings changed — re-train</span>
                ) : (
                    <span data-testid="footer-status" className="f4-foot-reason">{KIND_LABEL[m.kind]}{cat ? ` · ${CATEGORY_LABELS[cat]}` : ''}</span>
                )}
                <button
                    type="button"
                    className="f4-btn f4-btn--plain f4-btn--small"
                    title={reason ?? 'Sub-models and full settings'}
                    disabled={reason !== null}
                    onClick={() => buildModel(m)}
                >
                    Open full view ↗
                </button>
                <button className="f4-btn-save" disabled={saveReason !== null} onClick={() => commitModel(m)}>
                    Save changes
                </button>
                {/* Train/Re-train — fixed position (SPEC FINAL footer rule 6): always
                    this same slot, never moves around based on state. Nothing renders
                    here at all once the model is Complete or Trained-and-fresh with no
                    error — there is nothing further to do until settings change. A
                    failed preview run (this session) still shows the button even
                    though the persisted fields still say "fresh", so there's always a
                    way to retry. */}
                {!m.status && !(reason === null && trainedFresh && !training && !trainError[m.id]) && (
                    <button
                        type="button"
                        className={reason !== null ? 'f4-btn f4-btn--plain f4-btn--small' : (stale || trainError[m.id]) ? 'bmw-btn-retrain bmw-btn-retrain--stale' : 'bmw-btn-retrain'}
                        disabled={reason !== null || training}
                        title={reason ?? undefined}
                        onClick={() => runTrainClick(m)}
                    >
                        {training ? 'Training…' : (stale || trainError[m.id]) ? '↻ Re-train' : '▶ Train model'}
                    </button>
                )}
                {m.status ? (
                    <button type="button" className="f4-btn f4-btn--plain f4-btn--small" onClick={() => toggleModelStatus(m.id)}>
                        Mark incomplete
                    </button>
                ) : (
                    <button
                        type="button"
                        className="bmw-btn-ok"
                        disabled={gateReasonOf(m) !== null || !trainedFresh || hasSessionError}
                        title={gateReasonOf(m) ?? (hasSessionError ? "Couldn't refresh the result — fix the problem, then re-train." : !trainedFresh ? NOT_TRAINED_BLOCK_REASON : undefined)}
                        onClick={() => toggleModelStatus(m.id)}
                    >
                        ✓ Mark complete
                    </button>
                )}
            </div>
        );
    };

    const renderDetailPane = () => {
        if (!activeModel) {
            return (
                <div className="bmw-empty-detail">
                    {allModels.length === 0 ? 'No models yet — add sensors to a Failure Group from the Dashboard.' : 'Select a sensor from the list.'}
                </div>
            );
        }
        const first = orderedDetail[0];
        const keyTag = (first.kind === 'clustering' ? first.xSensor : first.targetSensor) ?? '';
        const title = keyTag ? (getDesc(keyTag) || keyTag) : modelDisplayLabel(first);
        const component = keyTag ? getComponent(keyTag) : '';
        const groupNos = [...new Set(detailModels.flatMap(m => m.groupNos))].sort((a, b) => a - b);
        const category = selectedSensorKey !== null ? sensorCategory(allModels, selectedSensorKey) : null;
        return (
            <>
                <div className="bmw-dhead">
                    <button
                        type="button"
                        className="bmw-iconbtn"
                        onClick={() => setSidebarCollapsed(c => !c)}
                        title={sidebarCollapsed ? 'Show sensor list' : 'Hide sensor list'}
                        aria-label={sidebarCollapsed ? 'Show sensor list' : 'Hide sensor list'}
                    >
                        {sidebarCollapsed ? '⇥' : '⇤'}
                    </button>
                    <div style={{ minWidth: 0 }}>
                        <h3 title={keyTag ? sensorLabel(keyTag) : undefined}>{title}</h3>
                        <div className="bmw-dmeta">
                            {keyTag && <span className="f4-sr-tag">{keyTag}</span>}
                            {component && <span className="model-chip model-chip--component">{component}</span>}
                            {groupNos.map(no => {
                                const g = realGroups.find(x => x.no === no);
                                return (
                                    <span key={no} className="f4-fgchip">
                                        <i style={{ background: FG_ACCENT[getFgGroupColor(no)] }} />
                                        <span>{no === 0 ? 'Not in Group' : `FG-${no} · ${g?.name ?? ''}`}</span>
                                    </span>
                                );
                            })}
                        </div>
                    </div>
                    <div
                        role="group"
                        aria-label="Category"
                        className={`f4-catseg${category ? '' : ' f4-catseg--unset'}`}
                        title={category ? undefined : 'Pick a category — it is set once for this sensor and applies to all of its models.'}
                    >
                        {category === null && (
                            <span className="f4-cat-flag"><CircleAlert size={11} aria-hidden="true" /> Set category</span>
                        )}
                        {(['performance', 'condition'] as ModelCategory[]).map(c => {
                            const active = category === c;
                            return (
                                <button
                                    key={c}
                                    type="button"
                                    aria-pressed={active}
                                    className={active ? (c === 'condition' ? 'on-cond' : 'on-perf') : undefined}
                                    onClick={() => changeCategory(selectedSensorKey!, c)}
                                >
                                    {CATEGORY_LABELS[c]}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {categoryWarn?.key === selectedSensorKey && (
                    <div role="status" className="f4-req-note" style={{ padding: '4px 20px 0' }}>
                        {categoryWarn.text}
                    </div>
                )}

                <div role="tablist" className="f4-tabs">
                    {orderedDetail.map(m => {
                        const selected = m.id === activeModel.id;
                        const badge = gateBadge(m);
                        return (
                            <button
                                key={m.id}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                className={`f4-tab${selected ? ' f4-tab--on' : ''}`}
                                style={{ '--kc': KIND_COLOR[m.kind] } as CSSProperties}
                                title={`${KIND_LABEL[m.kind]} · ${m.status ? 'Complete' : 'Incomplete'}`}
                                onClick={() => setActiveTab(prev => ({ ...prev, [selectedSensorKey!]: m.id }))}
                            >
                                <span className={`f4-kmini model-kind-icon--${m.kind}`} aria-hidden="true">{KIND_ABBREV[m.kind]}</span>
                                <span className="f4-tab-l">{KIND_LABEL[m.kind]}</span>
                                <span className={`f4-sdot${m.status ? ' f4-sdot--done' : ''}`} />
                                {m.id in drafts && <span className="f4-dirty" title="Unsaved changes">edited</span>}
                                {badge && <GateBadgePill text={badge} testId={`condition-badge-${m.id}`} title={gateReasonOf(m) ?? undefined} />}
                            </button>
                        );
                    })}
                    <span className="f4-tabs-spacer" />
                </div>

                <div role="tabpanel" data-testid={`model-tab-panel-${activeModel.id}`} style={{ display: 'contents' }}>
                    {renderModelSettings(activeModel)}
                    {renderResultsStage(activeModel)}
                    {renderFooter(activeModel)}
                </div>
            </>
        );
    };

    const periodStatus = validatePeriods(runningConditionTimePeriods);
    const validPeriodCount = runningConditionTimePeriods.filter((_, i) => !periodStatus[i]?.invalid).length;
    const periodsText = validPeriodCount > 0 ? `${validPeriodCount} period${validPeriodCount === 1 ? '' : 's'}` : 'Any time';
    const rcCondText = runningConditionNoneConfirmed
        ? 'No condition — every row'
        : runningConditionFilters.length === 0
        ? 'Not set'
        : runningConditionFilters.map(f => conditionText(f, sensorLabel)).join(runningConditionCombine === 'or' ? ' OR ' : ' AND ');
    const rcOneLiner = `${rcCondText} · ${periodsText}`;

    const pmPageModel = activePage === 'model' ? allModels.find(m => m.id === pmPageModelId) : undefined;

    return (
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--card-bg)', color: 'var(--text-primary)' }}>
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--card-bg)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {pmPageModel ? `Build Model — ${modelDisplayLabel(pmPageModel)}` : 'Build Model — Overview'}
                </h2>
                <button onClick={handleClose} className="scatter-regl-btn scatter-regl-btn-icon" title="Close">
                    <X size={14} />
                </button>
            </div>

            {pmPageModel && workspaceId ? (
                <PredictiveModelBuild
                    workspaceId={workspaceId}
                    modelId={pmPageModel.id}
                    kind={pmPageModel.kind}
                    sensorHeaders={allSensors}
                    sensorMetadata={sensorMetadata}
                    runningConditionFilters={runningConditionFilters}
                    runningConditionCombine={runningConditionCombine}
                    runningConditionTimePeriods={runningConditionTimePeriods}
                    runningConditionNoneConfirmed={runningConditionNoneConfirmed}
                    category={categoryOf(pmPageModel)}
                    onBack={() => setActivePage('overview')}
                    onFinish={async () => {
                        await markModelComplete(pmPageModel.id);
                        setActivePage('overview');
                    }}
                    registerFlush={registerPmFlush}
                />
            ) : (
                <div className="flex flex-col" style={{ flex: 1, minHeight: 0 }}>
                    <div className="bmw-rcbar" data-testid="rc-bar">
                        <span className="bmw-rcbar-lbl">Running condition</span>
                        <span data-testid="rc-bar-pill" className={`f4-pill ${rcConfigured ? 'f4-pill--ok' : 'f4-pill--warn'}`}>{rcConfigured ? '✓ Set' : 'Required'}</span>
                        <span className="bmw-rcbar-rule" title={rcOneLiner}>{rcOneLiner}</span>
                        <button type="button" className="f4-btn f4-btn--small" onClick={() => setRcFilterOpen(true)}>Edit…</button>
                    </div>

                    {rcLegacyNotice === 'pending' && !rcConfigured && !legacyRemindLater && (
                        <div
                            role="status"
                            data-testid="rc-legacy-banner"
                            className="f4-callout f4-callout--info"
                            style={{ margin: '12px 20px 0' }}
                        >
                            <div>
                                <b>New: running condition is now required for every model.</b>{' '}
                                {legacyCompleteCount > 0
                                    ? `${legacyCompleteCount} model${legacyCompleteCount === 1 ? '' : 's'} in this workspace ${legacyCompleteCount === 1 ? 'was' : 'were'} trained on the full dataset. They stay `
                                    : 'Models in this workspace were set up without one. They stay '}
                                <b>Complete</b> and nothing is changed. Set a condition before you build or re-train a model.
                            </div>
                            <div className="f4-acts">
                                <button type="button" className="f4-btn f4-btn--small" onClick={() => setRcFilterOpen(true)}>Set a condition</button>
                                <button
                                    type="button"
                                    className="f4-btn f4-btn--plain f4-btn--small"
                                    onClick={() => {
                                        setRunningConditionNoneConfirmed(true);
                                        persistRunningCondition({ noneConfirmed: true });
                                    }}
                                >
                                    Keep using all data
                                </button>
                                <button type="button" className="f4-btn f4-btn--plain f4-btn--small" onClick={() => setLegacyRemindLater(true)}>Remind me later</button>
                            </div>
                        </div>
                    )}

                    {!rcConfigured && blockedByCondition > 0 && (
                        <div data-testid="rc-blocked-summary" className="f4-reason" style={{ margin: '8px 20px 0' }}>
                            ⚠ {blockedByCondition} of {totalModelsCount} model{totalModelsCount === 1 ? '' : 's'} can't be built yet — they follow the workspace or have no condition of their own.
                        </div>
                    )}

                    {completeBlock && (
                        <div
                            role="alert"
                            data-testid="complete-block-reason"
                            className="f4-callout"
                            style={{ margin: '12px 20px 0', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center' }}
                        >
                            <div>The model was not marked Complete. {completeBlock}</div>
                            <button type="button" className="f4-btn f4-btn--plain f4-btn--small" onClick={() => setCompleteBlock(null)}>Dismiss</button>
                        </div>
                    )}

                    {categoryNotice && categoryNotice.length > 0 && (() => {
                        // One entry per sensor (the change list is per model). The
                        // "taken from" model is the first one, in Individual ->
                        // Relationship -> Clustering order, that was NOT changed.
                        const bySensor = new Map<string, CategoryChange[]>();
                        for (const c of categoryNotice) bySensor.set(c.sensorKey, [...(bySensor.get(c.sensorKey) ?? []), c]);
                        const changedIds = new Set(categoryNotice.map(c => c.modelId));
                        return (
                            <div role="status" data-testid="category-normalisation-notice" className="f4-notice" style={{ margin: '12px 20px 0' }}>
                                <span className="f4-notice-ico"><TriangleAlert size={16} aria-hidden="true" /></span>
                                <div style={{ minWidth: 0 }}>
                                    <div className="f4-notice-title">
                                        Category made consistent for {bySensor.size} sensor{bySensor.size === 1 ? '' : 's'}
                                    </div>
                                    All models of one sensor now share one category. These models were changed when this workspace loaded:
                                    <ul>
                                        {[...bySensor.entries()].map(([key, changes]) => {
                                            const to = changes[0].to;
                                            const source = KIND_ORDER
                                                .flatMap(k => allModels.filter(m => modelSensorKey(m) === key && m.kind === k))
                                                .find(m => !changedIds.has(m.id) && m.category != null);
                                            const any = allModels.find(m => modelSensorKey(m) === key);
                                            const tag = (any && (any.kind === 'clustering' ? any.xSensor : any.targetSensor)) || key;
                                            return (
                                                <li key={key} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    <b>{sensorLabel(tag)}</b> → {to ? CATEGORY_LABELS[to] : 'not set'}
                                                    {source ? `, taken from its ${KIND_LABEL[source.kind]} model` : ''}. Changed:{' '}
                                                    {changes.map((c, i) => (
                                                        <span key={c.modelId}>
                                                            {i > 0 && ' · '}
                                                            {KIND_LABEL[c.kind]}{' '}
                                                            {c.from ? <span className="f4-strike">{CATEGORY_LABELS[c.from]}</span> : '(not set)'} → {c.to ? CATEGORY_LABELS[c.to] : 'not set'}
                                                        </span>
                                                    ))}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                    <div style={{ marginTop: '4px' }}>If that's wrong, change it on the sensor's header.</div>
                                </div>
                                <button type="button" className="f4-notice-x" onClick={dismissCategoryNotice}>Dismiss</button>
                            </div>
                        );
                    })()}

                    <div className="bmw-wb" style={{ gridTemplateColumns: sidebarCollapsed ? '0 minmax(0,1fr)' : '300px minmax(0,1fr)' }}>
                        {!sidebarCollapsed && (
                            <aside className="bmw-side">
                                <div className="bmw-side-top">
                                    <div className="bmw-prog">
                                        <div className="bmw-prog-row">
                                            <span><b style={{ color: 'var(--text-primary)' }}>{completeModelsCount}</b> of {totalModelsCount} complete</span>
                                        </div>
                                        <div className="bmw-prog-bar">
                                            <span style={{ width: `${totalModelsCount ? (completeModelsCount / totalModelsCount * 100) : 0}%`, background: 'var(--ok)' }} />
                                        </div>
                                    </div>
                                    <div className="sensor-autocomplete-input-wrap">
                                        <Search size={12} className="sensor-autocomplete-icon" aria-hidden="true" />
                                        <input
                                            className="sensor-autocomplete-input"
                                            placeholder="Search sensor or tag…"
                                            aria-label="Search sensors"
                                            value={searchQuery}
                                            onChange={e => setSearchQuery(e.target.value)}
                                        />
                                    </div>
                                    <div className="bmw-chips">
                                        <button type="button" className={`bmw-chip${sidebarFilter === 'all' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('all')}>All <b>{sensorGroupsAll.length}</b></button>
                                        <button type="button" className={`bmw-chip${sidebarFilter === 'attn' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('attn')}>Needs setup <b>{attnCount}</b></button>
                                        <button type="button" className={`bmw-chip${sidebarFilter === 'done' ? ' bmw-chip--on' : ''}`} onClick={() => setSidebarFilter('done')}>Complete <b>{doneCount}</b></button>
                                    </div>
                                    <div className="bmw-groupby">
                                        <span>Group by</span>
                                        <div className="f4-seg">
                                            <button type="button" className={leftGroupBy === 'fg' ? 'on' : undefined} onClick={() => setLeftGroupBy('fg')}>Failure group</button>
                                            <button type="button" className={leftGroupBy === 'component' ? 'on' : undefined} onClick={() => setLeftGroupBy('component')}>Component</button>
                                        </div>
                                    </div>
                                </div>
                                <div className="bmw-list">{renderLeftList()}</div>
                            </aside>
                        )}
                        <section className="bmw-detail">{renderDetailPane()}</section>
                    </div>
                </div>
            )}

            {rcFilterOpen && (
                // 🆕 2026-09-30 [data-loss fix]: both close paths call
                // `flushFocusedInput()` first — see that function's own
                // comment. Without it, typing a period date then closing via
                // X/backdrop (without the input separately losing focus
                // first) unmounted `TimePeriodsEditor` before its
                // blur-only commit ever ran, silently dropping the edit.
                <div className="bmw-modal-backdrop" role="presentation" onClick={() => { flushFocusedInput(); setRcFilterOpen(false); }}>
                    <div className="bmw-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Running Condition Filter">
                        <div className="bmw-modal-head">
                            <span>Running Condition Filter</span>
                            <button type="button" className="bmw-modal-x" onClick={() => { flushFocusedInput(); setRcFilterOpen(false); }} aria-label="Close">
                                <X size={16} />
                            </button>
                        </div>
                        <RunningConditionPanel
                            embedded
                            open={true}
                            onToggle={() => setRcFilterOpen(false)}
                            configured={rcConfigured}
                            periods={runningConditionTimePeriods}
                            onPeriodsChange={updateRunningConditionPeriods}
                            bounds={datasetBounds}
                            filters={runningConditionFilters}
                            combine={runningConditionCombine}
                            noneConfirmed={runningConditionNoneConfirmed}
                            onNoneChange={none => {
                                setRunningConditionNoneConfirmed(none);
                                persistRunningCondition({ noneConfirmed: none });
                            }}
                            onCombineChange={mode => {
                                setRunningConditionCombine(mode);
                                persistRunningCondition({ combine: mode });
                            }}
                            onAddFilter={addRunningConditionFilter}
                            onUpdateFilter={updateRunningConditionFilter}
                            onRemoveFilter={removeRunningConditionFilter}
                            sensors={allSensors}
                            getDesc={getDesc}
                            getComponent={getComponent}
                        />
                    </div>
                </div>
            )}

            {/* Expand the active model's result chart — mirrors the PM page's
                own `expandedChart` modal (same classes/shape), scoped to
                whichever model the Workbench detail pane currently shows. */}
            {resultExpanded && activeModel && trainResults[activeModel.id] && (
                <div className="pm-chart-modal-backdrop" onClick={() => setResultExpanded(false)} role="dialog" aria-modal="true">
                    <div className="pm-chart-modal-card" onClick={e => e.stopPropagation()}>
                        <div className="pm-chart-modal-header">
                            <div className="pm-chart-title-block">
                                <div className="pm-chart-title">{KIND_LABEL[activeModel.kind]} result</div>
                                <div className="pm-chart-subtitle">{modelDisplayLabel(activeModel)}</div>
                            </div>
                            <button className="pm-chart-modal-close" onClick={() => setResultExpanded(false)} title="Close (Esc)" aria-label="Close">
                                <X size={18} />
                            </button>
                        </div>
                        <div className="pm-chart-modal-body">
                            {renderResultChart(activeModel, trainResults[activeModel.id]!, true)}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
