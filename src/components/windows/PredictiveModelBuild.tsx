import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { CsvRecord, SensorMetadata, FailureModel, ModelKind, PredictiveModelStateSlice, PredictiveClusterRange, WorkspaceSensorFilter } from "../../types";
import type {
    RelationshipPreviewResult,
    ClusteringPreview,
} from "../../types/commands";
import { Check, Activity, GitBranch, Layers, Minus, Plus, Search, X, Calendar, ChevronRight, Thermometer, Loader2, Maximize2, LayoutGrid, ArrowLeft } from "lucide-react";
import { STIFFNESS_OPTIONS, STIFFNESS_DEFAULT, stiffnessLabel, snapStiffness } from "../reports/pmReportTypes";
import { updateWorkspaceData, loadWorkspaceData } from "../../workspaceManager";
import LineChart from "../charts/LineChart";
import ResponsiveECharts from "../charts/ResponsiveECharts";
import { ChartMarkLine } from "../charts/ChartTypes";
import { useChartData } from "../../hooks/useChartData";
import { debugLog } from "../../utils/debugLog";

// Point budget for the target-sensor time series. Rust's `get_chart_data`
// min/max-decimates the filtered rows down to at most this many x-positions,
// so the chart payload stays bounded no matter how many rows the CSV holds.
const TARGET_CHART_MAX_POINTS = 4000;
// Stable empty array for LineChart's unused row-based `data` prop (the
// chart consumes the bounded `columnar` feed instead).
const EMPTY_RECORDS: CsvRecord[] = [];

const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

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

// ── Reusable Sensor Autocomplete ─────────────────────────────────────
// Exported so BuildModelWindow.tsx's "Running Condition Filter" panel (the
// one place a filter's sensor is picked now — see that file) can reuse the
// exact same search UI instead of a second implementation drifting from
// this one.
export interface SensorAutocompleteProps {
    sensors: string[];
    getDesc: (tag: string) => string;
    value: string;
    onSelect: (tag: string) => void;
    placeholder?: string;
    excluded?: string[];
    clearOnSelect?: boolean;
    allowNone?: boolean;
    disabled?: boolean;
    style?: React.CSSProperties;
}

export function SensorAutocomplete({
    sensors, getDesc, value, onSelect, placeholder, excluded = [],
    clearOnSelect = false, allowNone = false, disabled = false, style,
}: SensorAutocompleteProps) {
    const [query, setQuery] = useState(value);
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => { if (!open) setQuery(value); }, [value, open]);

    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
                setOpen(false);
                setQuery(value);
            }
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [value]);

    const filtered = sensors.filter(s => {
        if (excluded.includes(s)) return false;
        const q = query.trim().toLowerCase();
        if (!q) return true;
        if (s.toLowerCase().includes(q)) return true;
        return getDesc(s).toLowerCase().includes(q);
    });

    const handleSelect = (tag: string) => {
        onSelect(tag);
        setQuery(clearOnSelect ? '' : tag);
        setOpen(false);
    };

    return (
        <div className="sensor-autocomplete" ref={wrapRef} style={style}>
            <div className="sensor-autocomplete-input-wrap">
                <Search size={12} className="sensor-autocomplete-icon" />
                <input
                    type="text"
                    className="sensor-autocomplete-input"
                    value={query}
                    onChange={e => { setQuery(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    placeholder={placeholder}
                    disabled={disabled}
                />
                {query && !disabled && (
                    <button
                        type="button"
                        className="sensor-autocomplete-clear"
                        onClick={() => { setQuery(''); if (!clearOnSelect) onSelect(''); setOpen(true); }}
                        title="Clear"
                    >
                        <X size={12} />
                    </button>
                )}
            </div>
            {open && !disabled && (
                <div className="sensor-autocomplete-list">
                    {allowNone && (
                        <button type="button" className="sensor-autocomplete-item sensor-autocomplete-item--none" onClick={() => handleSelect('')}>
                            <span className="sensor-autocomplete-item-tag"><em>None</em></span>
                        </button>
                    )}
                    {filtered.length === 0 ? (
                        <div className="sensor-autocomplete-empty">No sensors found</div>
                    ) : filtered.map(s => {
                        const desc = getDesc(s);
                        return (
                            <button
                                type="button"
                                key={s}
                                className={`sensor-autocomplete-item ${s === value ? 'selected' : ''}`}
                                onClick={() => handleSelect(s)}
                            >
                                <span className="sensor-autocomplete-item-tag">{s}</span>
                                {desc && <span className="sensor-autocomplete-item-desc">{desc}</span>}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

interface PredictiveModelBuildProps {
    workspaceId: string;
    /** Which FailureModel this session's config belongs to — config is
     *  persisted into that specific model in `failureGroupState.models`
     *  rather than a single global slot, so training one model can never
     *  discard another's config (see FailureModel's own doc comment). */
    modelId: string;
    /** The model's kind, as chosen on the Build Model overview page's own
     *  "Model kind" selector (Individual/Relationship/Clustering) — this
     *  page must not ask for it again. Locks which of the three plot panels
     *  below is active; the other two render disabled. */
    kind: ModelKind;
    sensorHeaders: string[];
    sensorMetadata: SensorMetadata[] | null;
    /** Workspace-wide "machine running" filter, owned and edited entirely on
     *  BuildModelWindow's Overview page (see its "Running Condition Filter"
     *  panel) — this page only displays it read-only and AND-combines it
     *  into every training/preview query. Kept fresh by the parent's own
     *  `failure-group-state-changed` listener; this page's own debounced
     *  save preserves whatever value is on disk at write time rather than
     *  round-tripping this prop back into the write. */
    runningConditionFilters: WorkspaceSensorFilter[];
    /** Returns to BuildModelWindow's overview page. This page is a child of
     *  that window (not a spawned OS window of its own — see BuildModelWindow's
     *  own doc comment for why), so "closing" it just means switching the
     *  parent's local page state back. */
    onBack: () => void;
    /** Marks this model `status: true` (Complete) on the overview list, then
     *  returns to it — the toolbar's "Finish" button. One-directional by
     *  design: re-clicking Finish on an already-complete model must not
     *  flip it back to Incomplete (that's what the overview's own status
     *  pill is for). */
    onFinish: () => void;
}

/**
 * Per-cluster palette — mirrors the multi-series colour set used elsewhere in
 * the app (LineChart). Cycles when there are more clusters than colours.
 *
 * 2026-09-03: hoisted out of the component. It is a plain constant, so
 * rebuilding the array on every render bought nothing and gave the useMemo
 * that depends on it a new identity each time.
 */
const CLUSTER_PALETTE = [
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#8b5cf6', // violet
    '#f43f5e', // rose
    '#14b8a6', // teal
    '#ec4899', // pink
    '#6366f1', // indigo
];

export default function PredictiveModelBuild({ workspaceId, modelId, kind, sensorHeaders, sensorMetadata, runningConditionFilters, onBack, onFinish }: PredictiveModelBuildProps) {
    const [workspaceName, setWorkspaceName] = useState<string>("");
    const hydratedRef = useRef(false);
    // Alias kept so the large body of pre-existing code below (persistence
    // effect, save/train calls, etc.) didn't need a mechanical rename pass.
    const pmModelId = modelId;
    const allSensors = sensorHeaders;

    // Data from previous page
    const [targetSensor, setTargetSensor] = useState<string>("");
    const [predictorSensors, setPredictorSensors] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);

    // Plot mode — locked to the model's own `kind` prop (set by the
    // hydration effect below), not independently user-toggleable anymore.
    // Kept as state (rather than derived inline) because the Apply/Save
    // logic and chart JSX throughout this file already key off these two
    // values, and both still get persisted like any other PM config field.
    const [individualChecked, setIndividualChecked] = useState(true);
    const [rcMode, setRcMode] = useState<'relationship' | 'clustering' | null>(null);

    // Scatter X
    const [scatterXSensor, setScatterXSensor] = useState<string>("");

    // Description lookup
    const getDesc = (tag: string): string => {
        if (!sensorMetadata || !tag) return "";
        const found = sensorMetadata.find(m => m.tag.toLowerCase() === tag.toLowerCase());
        return found ? found.description : "";
    };

    // Relationship Model Config
    const [relModelName, setRelModelName] = useState("");
    const [relStiffness, setRelStiffness] = useState<number>(STIFFNESS_DEFAULT);

    // Clustering Model Config
    const [clusterModelName, setClusterModelName] = useState("");
    const [numClusters, setNumClusters] = useState<number>(3);
    const [criteriaSensor, setCriteriaSensor] = useState<string>("");
    // One range per cluster; length === numClusters at steady state.
    // null bound = unbounded in that direction (round-trips to Rust's
    // `Option<f64>` for the cluster-edge case).
    const [clusterRanges, setClusterRanges] = useState<PredictiveClusterRange[]>(
        () => [
            { min: 0, max: 33 },
            { min: 33, max: 66 },
            { min: 66, max: 100 },
        ],
    );

    // Data Filter — Time start/end stays per-model (the training *period*
    // legitimately differs per model); the value-filter half moved to the
    // workspace-wide `runningConditionFilters` prop (2026-09-15 — see
    // BuildModelWindow's "Running Condition Filter" panel and this prop's
    // own doc comment on `PredictiveModelBuildProps`).
    const [filterTimeStart, setFilterTimeStart] = useState("");
    const [filterTimeEnd, setFilterTimeEnd] = useState("");
    // Lets the Calendar icon (rendered next to each input, see the "Data
    // filter" JSX below) open the native picker directly on click —
    // `<input type="datetime-local">`'s own browser-drawn picker-indicator
    // icon is a `::-webkit-calendar-picker-indicator` pseudo-element this
    // app already tries to recolor for dark mode (`filter: invert(1)` in
    // App.css), but how visible that ends up is entirely up to the
    // WebView2 engine's own rendering of it — reported hard to see/find on
    // this page (2026-09-16). `showPicker()` sidesteps that uncertainty
    // instead of trying to fix a browser-native pseudo-element's styling
    // further: the lucide icon is an ordinary SVG this app already renders
    // reliably everywhere else, so making IT the trigger guarantees a
    // visible, clickable way to open the picker regardless.
    const filterTimeStartRef = useRef<HTMLInputElement>(null);
    const filterTimeEndRef = useRef<HTMLInputElement>(null);

    // ── Filter payload passed through to every Rust data-reading command ──
    // Translates this page's own Time start/end plus the inherited
    // workspace-wide `runningConditionFilters` into the snake_case shape
    // Rust expects (`PreviewFilter`) and forwards it on every invoke so
    // target chart, σ markers, clustering preview, and all `train_*`
    // commands operate on the same filtered slice.
    //
    // 2026-09-01: this used to also merge in a `dashboardSnapshot` carried
    // over from Dashboard's own filter panel via a "Save & Continue" flow —
    // that flow was removed earlier in the project and nothing has written
    // `dashboardSnapshot` since, so it always read as empty here; removed
    // as dead code (no behavior change — the merge was already a no-op).
    // Dashboard's filters currently do NOT carry into PM training/preview
    // at all; only this page's own filters do. This is intentional: Dashboard
    // filtering is for viewing charts, while this page's own fields are for
    // choosing the training period, and the two must stay independent.
    //
    // Returns `null` when no filter is active — Rust then falls back to "use
    // every row" (legacy behavior, plus identical request shape for tests).
    //
    // Hoisted above the chart/stats effects (~line 470/560 below) because
    // those effects depend on `dashboardFilterKey` — placing the memos right
    // after the filter inputs avoids a temporal-dead-zone reference during
    // render.
    const dashboardFilterPayload = useMemo(() => {
        const valueFilters = runningConditionFilters
            .filter(sf => sf.value1 !== '')
            .map(sf => ({
                sensor: sf.sensor,
                operation: sf.operation,
                value1: sf.value1 !== '' ? parseFloat(sf.value1) : null,
                value2: sf.value2 !== '' ? parseFloat(sf.value2) : null,
            }));

        if (valueFilters.length === 0 && !filterTimeStart && !filterTimeEnd) return null;
        return {
            timestamp_start: filterTimeStart || null,
            timestamp_end: filterTimeEnd || null,
            value_filters: valueFilters,
        };
    }, [runningConditionFilters, filterTimeStart, filterTimeEnd]);

    // Stable string key used to detect filter changes for cache invalidation
    // without re-running effects on identical-but-new object references.
    const dashboardFilterKey = useMemo(
        () => JSON.stringify(dashboardFilterPayload),
        [dashboardFilterPayload],
    );

    // Model Stats — computed on Rust side over ALL rows of the target sensor.
    const [targetStats, setTargetStats] = useState<SensorStats | null>(null);
    const [statsError, setStatsError] = useState<string | null>(null);

    // Stats for the criteria sensor — drives the cluster slider's overall
    // [min, max] bounds. Fetched independently of targetStats because the
    // criteria sensor is usually NOT the target. `null` when no sensor is
    // picked or while the fetch is in flight. Errors are console-logged
    // (the slider just shows the "loading…" placeholder until valid stats
    // arrive — the user can still fall back to picking another sensor).
    const [criteriaStats, setCriteriaStats] = useState<SensorStats | null>(null);

    // Single multivariate relationship-model cache.
    //
    // One Apply click fits ONE LinearGAM over all currently selected
    // predictors: target = f(p_1, …, p_k). The result holds the (n × k) raw
    // predictor matrix, the raw target vector, and the model's predicted
    // target — and we lock the predictor list at fit time so switching the
    // X-axis only swaps which column of the matrix is plotted, while both Y
    // series (raw and predicted) stay byte-for-byte identical.
    //
    // Adding a predictor after Apply does NOT auto-refit; the user must hit
    // Apply again to include it in the model. The cache is invalidated when
    // target / lambda / dashboard filter changes, since that's a different
    // model entirely.
    interface RelPreviewBundle {
        result: RelationshipPreviewResult;
        // Snapshot of `predictorSensors` at the moment Apply ran. This freezes
        // the column order of `result.predictor_raw` so the X-axis selector
        // can map a predictor name back to its column index.
        predictorsAtApply: string[];
    }
    const [relPreview, setRelPreview] = useState<RelPreviewBundle | null>(null);
    const [relLoading, setRelLoading] = useState(false);
    const [relError, setRelError] = useState<string | null>(null);

    // Indeterminate progress flag for the inline bar shown over the chart
    // while a fit is in flight. With a single multivariate fit we don't have
    // countable steps, so the bar always uses the sliding animation.
    const [relFitProgress, setRelFitProgress] = useState<{ current: number; total: number } | null>(null);

    // ── Sub-model fits (per cumulative-step) ──────────────────────────
    // For predictors=[p1,p2,p3] we make N=3 LinearGAM fits — f(p1),
    // f(p1,p2), f(p1,p2,p3) — and stash each one's full preview payload.
    // This lets the user open a "sub-models" view from the Relationship
    // chart and see one detail chart per cumulative step, each with its
    // own R² / 2·RMSE so they can judge how each added predictor
    // contributes to the fit. Fired by the LayoutGrid button on the
    // Relationship chart card header.
    interface SubModelFit {
        predictors: string[];                  // cumulative subset (length 1..N)
        result: RelationshipPreviewResult;     // sidecar response for THIS subset
    }
    const [subModels, setSubModels] = useState<SubModelFit[] | null>(null);
    const [subModelsLoading, setSubModelsLoading] = useState(false);
    const [subModelsError, setSubModelsError] = useState<string | null>(null);
    const [subModelsProgress, setSubModelsProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
    const [subModelsOpen, setSubModelsOpen] = useState(false);
    // Generation counter for sub-model fits. Each call to `runSubModelFits`
    // bumps this and remembers its own gen number; on completion it only
    // commits results when its gen still matches `current` — guarantees a
    // late-finishing older call can't overwrite a newer Apply's results.
    // Needed because Apply now fires sub-models in the background, so two
    // overlapping Applies are possible if the user re-clicks during phase 2.
    const subModelsGenRef = useRef(0);
    // Clustering preview result + status.
    const [clusteringPreview, setClusteringPreview] = useState<ClusteringPreview | null>(null);
    const [clusteringLoading, setClusteringLoading] = useState(false);
    const [clusteringError, setClusteringError] = useState<string | null>(null);

    // ── Target sensor time-series (for Individual plot) ────────────────
    // Bounded columnar fetch via `get_chart_data` (same path as Dashboard):
    // filter + min/max decimation run in Rust, so the WebView receives at
    // most TARGET_CHART_MAX_POINTS positions instead of the full row stream
    // the old `get_data` accumulation copied into the JS heap.
    const targetChartQuery = useMemo(() => {
        if (!targetSensor) return null;
        return {
            filter: {
                sensors: [targetSensor],
                timestamp_start: dashboardFilterPayload?.timestamp_start ?? null,
                timestamp_end: dashboardFilterPayload?.timestamp_end ?? null,
                value_filters: dashboardFilterPayload?.value_filters ?? [],
            },
            sampling: 'raw' as const,
            operation: null,
            maxPoints: TARGET_CHART_MAX_POINTS,
        };
    }, [targetSensor, dashboardFilterPayload]);

    const { view: targetChartView, loading: targetChartLoading } = useChartData(targetChartQuery);

    const targetHasData = (targetChartView?.timestamps.length ?? 0) > 0;
    const targetChartColumnar = useMemo(
        () => targetChartView
            ? { timestamps: targetChartView.timestamps, series: targetChartView.series }
            : { timestamps: [] as string[], series: [] as (number | null)[][] },
        [targetChartView]
    );
    // Resolved header fallback mirrors the old stream path: if the sensor
    // is unknown to the dataset the chart still renders (empty) axes.
    const targetChartHeaders = useMemo(
        () => (targetChartView && targetChartView.headers.length > 0 ? targetChartView.headers : [targetSensor]),
        [targetChartView, targetSensor]
    );
    const targetChartSensors = useMemo(() => [targetSensor], [targetSensor]);

    // ── Expandable chart modal ────────────────────────────────────────
    // `'individual'`  → Standard time-series (LineChart)
    // `'rc'`          → Whichever Relationship/Clustering chart is active
    // `null`          → Modal closed
    const [expandedChart, setExpandedChart] = useState<'individual' | 'rc' | null>(null);
    useEffect(() => {
        if (!expandedChart) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setExpandedChart(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [expandedChart]);

    // ESC key closes the sub-models modal (parallels expandedChart above).
    // Listener is only attached while the modal is open so unrelated key
    // presses don't pay for it.
    useEffect(() => {
        if (!subModelsOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSubModelsOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [subModelsOpen]);

    useEffect(() => {
        let cancelled = false;
        hydratedRef.current = false;
        setLoading(true);

        (async () => {
            // Hydrate model config from this specific FailureModel — it
            // extends PredictiveModelStateSlice, so the model record itself
            // IS the slice. `found` also carries `kind`/`xSensor`/`ySensor`,
            // needed below for the very-first-open fallback (clustering
            // models keep their sensors in xSensor/ySensor, not
            // targetSensor/predictorSensors).
            let found: FailureModel | undefined;
            try {
                const ws = await loadWorkspaceData(workspaceId);
                if (cancelled) return;
                if (ws?.name) setWorkspaceName(ws.name);
                found = ws?.failureGroupState?.models.find(m => m.id === modelId);
            } catch (e) {
                console.warn('Failed to hydrate predictive-model state from workspace:', e);
            }
            if (cancelled) return;

            const slice: PredictiveModelStateSlice | undefined = found;
            const kindMappedTarget = found ? (found.kind === 'clustering' ? found.ySensor : (found.targetSensor ?? '')) : '';
            const effectiveTarget = slice?.targetSensor || kindMappedTarget;
            const effectivePredictors = slice?.predictorSensors ?? [];
            setTargetSensor(effectiveTarget);
            setPredictorSensors(effectivePredictors);
            // Which panel is active is locked to the model's own `kind` —
            // that was already chosen on the Build Model overview page, so
            // this page must not ask again. Overrides any persisted
            // `individualChecked`/`rcMode` (old data from before this model
            // was per-kind could disagree with `kind`; `kind` always wins).
            setIndividualChecked(kind === 'individual');
            setRcMode(kind === 'individual' ? null : kind);
            if (slice) {
                setScatterXSensor(slice.scatterXSensor || (effectivePredictors[0] ?? ''));
                setRelModelName(slice.relModelName);
                // Snap legacy values (e.g. old default `1`) to the nearest
                // preset so the dropdown always renders a valid option.
                setRelStiffness(snapStiffness(slice.relStiffness));
                setClusterModelName(slice.clusterModelName);
                setNumClusters(slice.numClusters);
                setCriteriaSensor(slice.criteriaSensor);
                // Restore per-cluster ranges. Older workspaces from before the
                // multi-cluster migration may carry the legacy
                // `clusterRangeMin` / `clusterRangeMax` scalar pair instead —
                // fall back to those (replicated across all clusters) when
                // `clusterRanges` is missing so old workspaces still open.
                const legacy = slice as unknown as {
                    clusterRangeMin?: number;
                    clusterRangeMax?: number;
                };
                if (Array.isArray(slice.clusterRanges) && slice.clusterRanges.length > 0) {
                    setClusterRanges(slice.clusterRanges);
                } else if (typeof legacy.clusterRangeMin === 'number' && typeof legacy.clusterRangeMax === 'number') {
                    // Spread the single pair into one range per cluster.
                    const n = Math.max(1, slice.numClusters);
                    const lo = legacy.clusterRangeMin;
                    const hi = legacy.clusterRangeMax;
                    const step = (hi - lo) / n;
                    setClusterRanges(
                        Array.from({ length: n }, (_, i) => ({
                            min: lo + step * i,
                            max: lo + step * (i + 1),
                        })),
                    );
                }
                setFilterTimeStart(slice.filterTimeStart);
                setFilterTimeEnd(slice.filterTimeEnd);
                // NOTE: Fit results (relPreview / subModels / clusteringPreview)
                // are deliberately NOT persisted. With many target sensors or
                // large datasets the predictor_raw matrices balloon the workspace
                // JSON quickly, so we accept that re-opening a workspace requires
                // clicking Apply again.
            } else if (effectivePredictors.length > 0) {
                setScatterXSensor(effectivePredictors[0]);
            }

            hydratedRef.current = true;
            setLoading(false);
        })();

        return () => { cancelled = true; };
    }, [workspaceId, modelId, kind]);

    // Keep workspaceName synced when the user renames the workspace from
    // Dashboard's native menu (App.tsx) while this page is open — that
    // rename UI emits `workspace-renamed-internal` globally after disk write.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        (async () => {
            unlisten = await listen<{ newName: string }>('workspace-renamed-internal', (event) => {
                setWorkspaceName(event.payload.newName);
            });
        })();
        return () => { if (unlisten) unlisten(); };
    }, []);

    // Persist config back into THIS model's own record in
    // failureGroupState.models (not a global slot) so training one model can
    // never discard another's config — the redesign's fix for the old
    // single-slot `predictiveModelState`. Config only — fit results
    // (relPreview / subModels / clusteringPreview) are deliberately excluded
    // so workspace JSONs stay small even with many target sensors. Re-opening
    // forces the user to click Apply again. Broadcasts
    // `failure-group-state-changed` afterward so Dashboard/BuildModelWindow
    // (separate OS windows) never see stale data.
    useEffect(() => {
        if (!workspaceId || !hydratedRef.current || !pmModelId) return;
        const timer = setTimeout(() => {
            const slice: PredictiveModelStateSlice = {
                targetSensor,
                predictorSensors,
                individualChecked,
                rcMode,
                scatterXSensor,
                relModelName,
                relStiffness,
                clusterModelName,
                numClusters,
                criteriaSensor,
                clusterRanges,
                filterTimeStart,
                filterTimeEnd,
            };
            (async () => {
                const next = await updateWorkspaceData(workspaceId, (prev) => ({
                    ...prev,
                    failureGroupState: {
                        groups: prev.failureGroupState?.groups ?? [],
                        models: (prev.failureGroupState?.models ?? []).map(m => m.id === pmModelId ? { ...m, ...slice } : m),
                        // This page never edits the workspace-wide running-condition
                        // filter (that's BuildModelWindow's job) — preserve whatever
                        // is on disk right now rather than dropping it, since this
                        // write only intends to touch this one model's own fields.
                        runningConditionFilters: prev.failureGroupState?.runningConditionFilters ?? [],
                    },
                }));
                if (next?.failureGroupState) {
                    await emit('failure-group-state-changed', next.failureGroupState);
                }
            })().catch(e => console.error('Failed to persist predictive-model state:', e));
        }, 250);
        return () => clearTimeout(timer);
    }, [
        workspaceId, pmModelId, targetSensor, predictorSensors, individualChecked, rcMode, scatterXSensor,
        relModelName, relStiffness, clusterModelName, numClusters, criteriaSensor,
        clusterRanges, filterTimeStart, filterTimeEnd,
    ]);

    // Auto-divide cluster ranges across the criteria sensor's [min, max]
    // whenever the user picks a different criteria sensor OR steps the
    // cluster count. We compute a "division key" (sensor + N) and reset
    // only when it changes — so slider drags within the same (sensor, N)
    // are preserved.
    //
    // When a criteriaSensor is set but its stats haven't loaded yet, we
    // defer the reset (returning prev) so we don't briefly seed with the
    // [0,100] fallback only to immediately re-reset with the real bounds.
    // Length-mismatch is always reconciled so the array invariant
    // (length === numClusters) holds regardless of stats state.
    const divisionKey = `${criteriaSensor}::${numClusters}`;
    const prevDivisionKeyRef = useRef<string>('');
    useEffect(() => {
        const keyChanged = divisionKey !== prevDivisionKeyRef.current;
        setClusterRanges((prev) => {
            // Bail on degenerate counts (shouldn't happen — stepper blocks
            // <= 0 — but keep the guard so we never produce an empty array
            // and crash downstream consumers).
            if (numClusters <= 0) return [];

            const lengthMismatch = prev.length !== numClusters;
            const needsReset = lengthMismatch || keyChanged;
            if (!needsReset) return prev;

            // Wait for criteria stats if a sensor IS selected but stats
            // haven't arrived yet. Without this guard we'd seed with the
            // [0,100] fallback then reset again ~100ms later.
            if (criteriaSensor && !criteriaStats && !lengthMismatch) {
                return prev;
            }

            prevDivisionKeyRef.current = divisionKey;
            const lo = criteriaStats?.min ?? 0;
            const hi = criteriaStats?.max ?? 100;
            const step = (hi - lo) / numClusters;
            return Array.from({ length: numClusters }, (_, i) => ({
                min: lo + step * i,
                max: lo + step * (i + 1),
            }));
        });
    }, [divisionKey, numClusters, criteriaSensor, criteriaStats]);

    // Compute mean / sd / 1σ / 3σ of the target sensor on the Rust side.
    useEffect(() => {
        if (!targetSensor) {
            setTargetStats(null);
            setStatsError(null);
            return;
        }
        let cancelled = false;
        invoke<SensorStats>("compute_sensor_stats", {
            sensor: targetSensor,
            filter: dashboardFilterPayload,
        })
            .then(s => {
                if (!cancelled) {
                    setTargetStats(s);
                    setStatsError(null);
                }
            })
            .catch(err => {
                if (!cancelled) {
                    console.error("compute_sensor_stats failed:", err);
                    setTargetStats(null);
                    setStatsError(String(err));
                }
            });
        return () => { cancelled = true; };
        // dashboardFilterKey in deps: σ-band markers must move when the
        // user re-explores the dashboard with different filters.
    }, [targetSensor, dashboardFilterKey]);

    // Same pattern, but for the clustering criteria sensor. Drives the
    // cluster slider's overall [min, max] bounds so the user sees real
    // sensor values (instead of an abstract 0–100 scale).
    useEffect(() => {
        if (!criteriaSensor) {
            setCriteriaStats(null);
            return;
        }
        let cancelled = false;
        invoke<SensorStats>("compute_sensor_stats", {
            sensor: criteriaSensor,
            filter: dashboardFilterPayload,
        })
            .then(s => {
                if (!cancelled) setCriteriaStats(s);
            })
            .catch(err => {
                if (!cancelled) {
                    console.error("compute_sensor_stats (criteria) failed:", err);
                    setCriteriaStats(null);
                }
            });
        return () => { cancelled = true; };
    }, [criteriaSensor, dashboardFilterKey]);

    const meanColor = '#f1f5f9';

    // Build markLines for mean / ±1σ / ±3σ to overlay on the LineChart.
    const targetMarkLines: ChartMarkLine[] = targetSensor && targetStats ? [
        { sensor: targetSensor, y: targetStats.mean,   label: 'Mean', color: meanColor,                 lineStyle: 'solid'  },
        { sensor: targetSensor, y: targetStats.upper1, label: '+1σ',  color: '#f59e0b',                 lineStyle: 'solid'  },
        { sensor: targetSensor, y: targetStats.lower1, label: '−1σ',  color: '#f59e0b',                 lineStyle: 'solid'  },
        { sensor: targetSensor, y: targetStats.upper3, label: '+3σ',  color: '#f43f5e',                 lineStyle: 'dashed' },
        { sensor: targetSensor, y: targetStats.lower3, label: '−3σ',  color: '#f43f5e',                 lineStyle: 'dashed' },
    ] : [];

    // Convert an ISO-ish timestamp to the `YYYY-MM-DDTHH:mm` format expected
    // by `<input type="datetime-local">` (in the user's local timezone).
    const formatTimestampForInput = useCallback((dateStr: string | null) => {
        if (!dateStr) return '';
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return '';
            const offset = date.getTimezoneOffset() * 60000;
            return new Date(date.getTime() - offset).toISOString().slice(0, 16);
        } catch {
            return '';
        }
    }, []);

    // Min / max timestamp of the target-sensor series (computed backend-side
    // over the full filtered population, not the decimated sample). Used as
    // the default value (and as the picker's `min` / `max` constraint) for
    // the Data-filter date pickers, so the user starts on a valid range.
    const targetDataRange = useMemo<{ min: string; max: string } | null>(() => {
        if (targetChartView?.ts_min && targetChartView?.ts_max) {
            return { min: targetChartView.ts_min, max: targetChartView.ts_max };
        }
        return null;
    }, [targetChartView]);

    const targetMinForInput = useMemo(
        () => targetDataRange ? formatTimestampForInput(targetDataRange.min) : '',
        [targetDataRange, formatTimestampForInput]
    );
    const targetMaxForInput = useMemo(
        () => targetDataRange ? formatTimestampForInput(targetDataRange.max) : '',
        [targetDataRange, formatTimestampForInput]
    );

    // X-axis predictor for the scatter. Prefer whatever the user explicitly
    // picked, but only honor it when that predictor is in the cached fit —
    // otherwise we'd ask the chart to plot a column the matrix doesn't have.
    // Falls back to the first fitted predictor when the saved selection is
    // stale (predictor was removed before re-Apply, etc.).
    const effectiveScatterX = useMemo(() => {
        const fitted = relPreview?.predictorsAtApply ?? [];
        if (fitted.length === 0) {
            // No fit yet — use predictor selection as a hint for the dropdown
            // default so the selector isn't empty when the user opens the page.
            if (predictorSensors.length === 0) return '';
            if (scatterXSensor && predictorSensors.includes(scatterXSensor)) return scatterXSensor;
            return predictorSensors[0];
        }
        if (scatterXSensor && fitted.includes(scatterXSensor)) return scatterXSensor;
        return fitted[0];
    }, [scatterXSensor, predictorSensors, relPreview]);

    // Regression stats (R², RMSE) of the multivariate fit. Same value
    // regardless of which X-axis predictor is shown.
    const modelStats = useMemo<{ r2: number | null; rmse: number | null }>(() => {
        if (!relPreview) return { r2: null, rmse: null };
        const r = relPreview.result;
        const lastIdx = r.r2_per_step.length - 1;
        if (lastIdx < 0) return { r2: null, rmse: null };
        return {
            r2: r.r2_per_step[lastIdx],
            rmse: r.rmse2_per_step[lastIdx] / 2, // sidecar returns 2*RMSE
        };
    }, [relPreview]);

    // Residual mean / sd over the non-null residuals from the multivariate fit.
    const residualStats = useMemo<{ mean: number; sd: number } | null>(() => {
        if (!relPreview) return null;
        const finiteResid = relPreview.result.residual.filter(
            (v): v is number => typeof v === 'number' && Number.isFinite(v),
        );
        if (finiteResid.length <= 1) return null;
        const m = finiteResid.reduce((a, b) => a + b, 0) / finiteResid.length;
        const variance = finiteResid.reduce((a, b) => a + (b - m) ** 2, 0) / (finiteResid.length - 1);
        return { mean: m, sd: Math.sqrt(variance) };
    }, [relPreview]);

    // True when the user has changed the predictor selection since the last
    // Apply — used to surface "click Apply to refit" hints in the UI.
    const fitIsStale = useMemo(() => {
        if (!relPreview) return false;
        const a = relPreview.predictorsAtApply;
        const b = predictorSensors;
        if (a.length !== b.length) return true;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
        return false;
    }, [relPreview, predictorSensors]);

    // True when cached sub-model fits no longer line up with the current
    // predictor list (count or order). Drives a "Refresh" hint in the
    // sub-models modal and lets `handleOpenSubModels` know to re-fit on
    // open. Mirrors `fitIsStale` semantics — predictor list changes are
    // surfaced as stale rather than silently invalidated, so the user
    // chooses when to pay for the N additional sidecar calls.
    const subModelsStale = useMemo(() => {
        if (!subModels) return false;
        if (subModels.length !== predictorSensors.length) return true;
        const last = subModels[subModels.length - 1].predictors;
        if (last.length !== predictorSensors.length) return true;
        for (let i = 0; i < last.length; i++) {
            if (last[i] !== predictorSensors[i]) return true;
        }
        return false;
    }, [subModels, predictorSensors]);

    // Invalidate the cached fit whenever the regression target, the smoothness
    // parameter, or the dashboard filter changes — any of those produce a
    // different (target, lambda, sample) triple, so the prior fit is no
    // longer comparable. Adding/removing a predictor does NOT invalidate;
    // the old fit stays plotted until the user hits Apply.
    useEffect(() => {
        setRelPreview(null);
        setRelError(null);
    }, [targetSensor, relStiffness, dashboardFilterKey]);

    // Sub-models share the same cache-invalidation contract as relPreview:
    // any change to (target, lambda, dashboard filter) makes prior sub-fits
    // moot. Predictor-list changes are surfaced via `subModelsStale`
    // instead, so we don't silently throw away results the user might
    // still want to compare against.
    useEffect(() => {
        setSubModels(null);
        setSubModelsError(null);
    }, [targetSensor, relStiffness, dashboardFilterKey]);

    // Scatter chart option for the Relationship mode preview:
    //   • Blue series: (predictor_raw, target_raw)        — actual measurements
    //   • Red  series: (predictor_raw, target_predicted)  — LinearGAM output
    // Y values are the same for every choice of X — switching the X-axis
    // just swaps which column of `predictor_raw` is read for the X coord.
    const relScatterOption = useMemo(() => {
        if (!relPreview) return null;
        const { result, predictorsAtApply } = relPreview;
        const xRaw = result.predictor_raw;
        const yRaw = result.target_raw;
        const yPred = result.predicted;
        if (!xRaw || !yRaw || !yPred) return null;
        if (xRaw.length === 0) return null;

        // Map the picked predictor name back to its column in the matrix.
        // Bail out cleanly if it isn't in the cached fit (e.g., user added
        // a predictor after Apply and switched X to it before re-Applying).
        const xIdx = predictorsAtApply.indexOf(effectiveScatterX);
        if (xIdx < 0) return null;

        const txtPrimary    = '#f1f5f9';
        const txtSecondary  = '#94a3b8';
        const gridLine      = '#334155';
        const tooltipBg     = 'rgba(30,41,59,0.95)';
        const tooltipBorder = '#334155';

        const rawPoints: [number, number][] = [];
        const modelPoints: [number, number][] = [];
        const n = Math.min(xRaw.length, yRaw.length, yPred.length);
        for (let i = 0; i < n; i++) {
            const xv = xRaw[i]?.[xIdx];
            if (typeof xv !== 'number' || !Number.isFinite(xv)) continue;
            const yr = yRaw[i];
            if (typeof yr === 'number' && Number.isFinite(yr)) rawPoints.push([xv, yr]);
            const yp = yPred[i];
            if (typeof yp === 'number' && Number.isFinite(yp)) modelPoints.push([xv, yp]);
        }

        // Auto-tune symbol size + opacity by point count so a few-thousand-row
        // sensor doesn't render as one indistinguishable blob. ECharts' `large`
        // path swaps in a fast batch renderer above the threshold, and
        // `progressive` streams the points in chunks instead of stalling on
        // the first frame. Tuning bands roughly:
        //   <2k       big crisp dots, animated
        //   2k–20k    medium dots, lower opacity
        //   >20k      tiny dots, low opacity, hover disabled, no animation
        const totalPoints = rawPoints.length + modelPoints.length;
        const isLargeData = totalPoints > 2000;
        const isHugeData = totalPoints > 20000;
        const symbolSize = isHugeData ? 2 : isLargeData ? 3 : 5;
        const pointOpacity = isHugeData ? 0.18 : isLargeData ? 0.35 : 0.55;

        const seriesCommon = {
            type: 'scatter' as const,
            symbolSize,
            large: isLargeData,
            largeThreshold: 2000,
            progressive: 5000,
            progressiveThreshold: 10000,
            // Disable hover-scale jitter on huge datasets; with thousands of
            // dots a 1px hover ring is just noise.
            emphasis: { scale: !isHugeData, disabled: isHugeData },
            // Drop the per-point selectability when we're in large mode —
            // tooltip still works via the lasso path but per-point hover is
            // expensive without adding value.
            silent: isHugeData,
        };

        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
            animation: !isLargeData,
            tooltip: {
                trigger: 'item',
                backgroundColor: tooltipBg,
                borderColor: tooltipBorder,
                textStyle: { color: txtPrimary },
                formatter: (p: any) => {
                    const v = p.value as [number, number];
                    return `<div style="font-weight:bold;margin-bottom:4px;color:${p.color}">${p.seriesName}</div>`
                        + `<div>${effectiveScatterX}: ${typeof v?.[0] === 'number' ? v[0].toFixed(4) : '—'}</div>`
                        + `<div>${targetSensor}: ${typeof v?.[1] === 'number' ? v[1].toFixed(4) : '—'}</div>`;
                },
            },
            legend: {
                data: ['Raw', 'Model'],
                textStyle: { color: txtSecondary },
                top: 4,
                right: 10,
                itemWidth: 12,
                itemHeight: 12,
            },
            grid: { left: 64, right: 30, top: 36, bottom: 56, containLabel: false },
            dataZoom: [
                { type: 'inside', xAxisIndex: 0, filterMode: 'filter' },
                { type: 'inside', yAxisIndex: 0, filterMode: 'filter' },
            ],
            xAxis: {
                type: 'value',
                name: effectiveScatterX,
                nameLocation: 'middle',
                nameGap: 28,
                nameTextStyle: { color: txtSecondary },
                scale: true,
                axisLabel: { color: txtSecondary },
                axisLine: { lineStyle: { color: gridLine } },
                splitLine: { show: false },
            },
            yAxis: {
                type: 'value',
                name: targetSensor,
                nameLocation: 'middle',
                nameGap: 46,
                nameTextStyle: { color: txtSecondary },
                scale: true,
                axisLabel: { color: txtSecondary },
                axisLine: { lineStyle: { color: gridLine } },
                splitLine: { show: true, lineStyle: { color: gridLine, type: 'dashed', opacity: 0.3 } },
            },
            series: [
                {
                    ...seriesCommon,
                    name: 'Raw',
                    data: rawPoints,
                    itemStyle: { color: '#3b82f6', opacity: pointOpacity },
                },
                {
                    ...seriesCommon,
                    name: 'Model',
                    data: modelPoints,
                    itemStyle: { color: '#f43f5e', opacity: pointOpacity },
                },
            ],
        };
    }, [relPreview, effectiveScatterX, targetSensor]);


    const clusteringScatterOption = useMemo(() => {
        if (!clusteringPreview) return null;
        const { first_sensor, second_sensor, clusters, n_rows } = clusteringPreview;
        if (!clusters || clusters.length === 0 || n_rows === 0) return null;

        const txtPrimary    = '#f1f5f9';
        const txtSecondary  = '#94a3b8';
        const gridLine      = '#334155';
        const tooltipBg     = 'rgba(30,41,59,0.95)';
        const tooltipBorder = '#334155';

        // Density-based scatter tuning (mirrors relScatterOption).
        const totalPoints = clusters.reduce((acc, c) => acc + c.xs.length, 0);
        const isLargeData = totalPoints > 2000;
        const isHugeData = totalPoints > 20000;
        const symbolSize = isHugeData ? 2 : isLargeData ? 3 : 5;
        const pointOpacity = isHugeData ? 0.18 : isLargeData ? 0.35 : 0.55;

        /** Custom-renderer factory producing one ECharts polygon series for
         *  a single ellipse (one σ multiple, one cluster). Coordinates the
         *  rotation in data-space then converts to pixel-space inside
         *  renderItem so the polygon doesn't drift on zoom. */
        const ellipseCustomSeries = (
            cluster: typeof clusters[0],
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
                        const xRot = cx + x * cos - y * sin;
                        const yRot = cy + x * sin + y * cos;
                        polyPts.push(api.coord([xRot, yRot]));
                    }
                    return {
                        type: 'polygon',
                        shape: { points: polyPts },
                        style: {
                            fill: opts.fill ?? 'none',
                            stroke: opts.stroke,
                            lineWidth: opts.lineWidth,
                            lineDash: opts.lineDash ?? [0, 0],
                            opacity: opts.opacity,
                        },
                        clipPath: {
                            type: 'rect',
                            shape: {
                                x: params.coordSys.x,
                                y: params.coordSys.y,
                                width: params.coordSys.width,
                                height: params.coordSys.height,
                            },
                        },
                    };
                },
            };
        };

        // Build per-cluster scatter + ellipse pairs. Each cluster gets its
        // own palette colour so points and ellipses read as one group.
        const scatterSeries: any[] = [];
        const ellipseSeries: any[] = [];
        const legendData: string[] = [];

        clusters.forEach((cluster, i) => {
            const color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
            const seriesName =
                clusters.length === 1
                    ? 'Data'
                    : `Cluster ${cluster.cluster_id}`;
            legendData.push(seriesName);

            // Pair (xs[i], ys[i]) → ECharts point.
            const points: [number, number][] = [];
            const n = Math.min(cluster.xs.length, cluster.ys.length);
            for (let j = 0; j < n; j++) {
                const xv = cluster.xs[j], yv = cluster.ys[j];
                if (Number.isFinite(xv) && Number.isFinite(yv)) points.push([xv, yv]);
            }

            scatterSeries.push({
                type: 'scatter' as const,
                name: seriesName,
                data: points,
                symbolSize,
                large: isLargeData,
                largeThreshold: 2000,
                progressive: 5000,
                progressiveThreshold: 10000,
                emphasis: { scale: !isHugeData, disabled: isHugeData },
                silent: isHugeData,
                itemStyle: { color, opacity: pointOpacity },
                z: 1,
            });

            // 1σ outline (filled with low-alpha cluster colour).
            ellipseSeries.push(ellipseCustomSeries(cluster, 1, {
                name: `${seriesName} 1σ`,
                stroke: color,
                fill: `${color}1F`, // ~12% alpha, hex AA
                lineWidth: 2,
                opacity: 1,
                z: 3,
            }));
            // 3σ dashed outline (no fill).
            ellipseSeries.push(ellipseCustomSeries(cluster, 3, {
                name: `${seriesName} 3σ`,
                stroke: color,
                lineWidth: 1.5,
                lineDash: [5, 5],
                opacity: 0.55,
                z: 2,
            }));
        });

        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
            animation: !isLargeData,
            tooltip: {
                trigger: 'item',
                backgroundColor: tooltipBg,
                borderColor: tooltipBorder,
                textStyle: { color: txtPrimary },
                formatter: (p: any) => {
                    const v = p.value as [number, number];
                    return `<div style="font-weight:bold;margin-bottom:4px;color:${p.color}">${p.seriesName}</div>`
                        + `<div>${first_sensor}: ${typeof v?.[0] === 'number' ? v[0].toFixed(4) : '—'}</div>`
                        + `<div>${second_sensor}: ${typeof v?.[1] === 'number' ? v[1].toFixed(4) : '—'}</div>`;
                },
            },
            legend: {
                data: legendData,
                textStyle: { color: txtSecondary },
                top: 4, right: 10, itemWidth: 12, itemHeight: 12,
                type: 'scroll',
            },
            grid: { left: 64, right: 30, top: 36, bottom: 56, containLabel: false },
            dataZoom: [
                { type: 'inside', xAxisIndex: 0, filterMode: 'filter' },
                { type: 'inside', yAxisIndex: 0, filterMode: 'filter' },
            ],
            xAxis: {
                type: 'value', name: first_sensor, nameLocation: 'middle', nameGap: 28,
                nameTextStyle: { color: txtSecondary }, scale: true,
                axisLabel: { color: txtSecondary },
                axisLine: { lineStyle: { color: gridLine } },
                splitLine: { show: false },
            },
            yAxis: {
                type: 'value', name: second_sensor, nameLocation: 'middle', nameGap: 46,
                nameTextStyle: { color: txtSecondary }, scale: true,
                axisLabel: { color: txtSecondary },
                axisLine: { lineStyle: { color: gridLine } },
                splitLine: { show: true, lineStyle: { color: gridLine, type: 'dashed', opacity: 0.3 } },
            },
            series: [...scatterSeries, ...ellipseSeries],
        };
    }, [clusteringPreview]);

    const handlePredictorToggle = (sensor: string) => {
        setPredictorSensors(prev => {
            if (prev.includes(sensor)) {
                return prev.filter(s => s !== sensor);
            }
            return [...prev, sensor];
        });
    };

    // Core fit routine. Single multivariate LinearGAM over ALL currently
    // selected predictors → one `predicted` vector keyed against the same
    // target. Snapshots the predictor list at fit time so the X-axis switch
    // is a pure column lookup against the matrix the model was trained on.
    const runRelationshipFit = useCallback(async () => {
        if (!targetSensor || predictorSensors.length === 0) return;

        const predictorsForFit = [...predictorSensors];
        setRelLoading(true);
        setRelFitProgress({ current: 0, total: 1 });
        try {
            const r = await invoke<RelationshipPreviewResult>("preview_relationship_model", {
                predictors: predictorsForFit,
                target: targetSensor,
                lambda: relStiffness,
                filter: dashboardFilterPayload,
            });
            // Sidecar surfaces errors as {error, trace} in the JSON body —
            // surface them as a thrown error so they hit the catch arm and
            // get rendered in the inline error slot.
            if (r.error) throw new Error(r.error);
            setRelPreview({ result: r, predictorsAtApply: predictorsForFit });
            setRelError(null);
            debugLog("Multivariate relationship preview updated:", {
                predictors: predictorsForFit,
                rows: r.predicted?.length ?? 0,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setRelError(msg);
            console.error("preview_relationship_model failed:", e);
        } finally {
            setRelLoading(false);
            setRelFitProgress(null);
        }
    }, [targetSensor, predictorSensors, relStiffness, dashboardFilterPayload]);

    const handleRelationshipApply = async () => {
        if (!targetSensor) {
            setRelError("Target sensor is required.");
            return;
        }
        if (predictorSensors.length === 0) {
            setRelError("Select at least one predictor.");
            return;
        }
        setRelError(null);
        // Phase 1 (main multivariate fit) is awaited so the Apply button
        // stays "Running…" until the chart can render. Once phase 1 is in,
        // the button re-enables and the user can keep working while phase 2
        // (cumulative sub-model fits) finishes IN THE BACKGROUND.
        await runRelationshipFit();
        runSubModelFits().catch(err => {
            // Errors are already surfaced via `subModelsError` state inside
            // runSubModelFits; the catch here just prevents an unhandled
            // promise rejection warning from the fire-and-forget pattern.
            console.warn('Background sub-models fit failed:', err);
        });
    };

    /**
     * Loops `preview_relationship_model` over CUMULATIVE subsets of the
     * predictor list — predictors=[p1,p2,p3] yields three sequential
     * sidecar calls returning fits for [p1], [p1,p2], [p1,p2,p3]. The
     * full payload of each fit is stashed so the sub-models view can
     * draw a per-step scatter alongside the per-step R² / 2·RMSE.
     *
     * Reuses the cached `relPreview` for the final (full-predictor)
     * subset when it's already up-to-date, so we don't refit the same
     * model twice on a fresh open.
     *
     * Awaited sequentially rather than `Promise.all`'d on purpose: the
     * sidecar is a single-process pool, so parallel calls would queue
     * anyway, and serial execution gives us cheap progress reporting.
     */
    const runSubModelFits = useCallback(async () => {
        if (!targetSensor || predictorSensors.length === 0) return;
        const subsetPredictors = [...predictorSensors];
        const total = subsetPredictors.length;
        // Claim a generation. Late-finishing older calls will see their
        // gen != current at write time and skip the state commit.
        const myGen = ++subModelsGenRef.current;
        setSubModelsLoading(true);
        setSubModelsError(null);
        setSubModelsProgress({ current: 0, total });
        const results: SubModelFit[] = [];
        try {
            for (let i = 1; i <= total; i++) {
                const subset = subsetPredictors.slice(0, i);
                const isLast = i === total;
                const cachedMatches =
                    relPreview &&
                    !fitIsStale &&
                    relPreview.predictorsAtApply.length === subset.length;
                if (isLast && cachedMatches) {
                    // Full-predictor fit already lives in `relPreview`; reuse it
                    // verbatim so the bottom card matches the inline chart.
                    results.push({ predictors: subset, result: relPreview!.result });
                    setSubModelsProgress({ current: i, total });
                    continue;
                }
                const r = await invoke<RelationshipPreviewResult>("preview_relationship_model", {
                    predictors: subset,
                    target: targetSensor,
                    lambda: relStiffness,
                    filter: dashboardFilterPayload,
                });
                if (r.error) throw new Error(r.error);
                results.push({ predictors: subset, result: r });
                setSubModelsProgress({ current: i, total });
            }
            if (myGen === subModelsGenRef.current) {
                setSubModels(results);
                debugLog("Sub-model fits complete:", results.map(r => ({
                    predictors: r.predictors,
                    rows: r.result.predicted.length,
                    r2: r.result.r2_per_step[r.result.r2_per_step.length - 1],
                })));
            } else {
                debugLog(`[PM] Discarding stale sub-models result (gen ${myGen} vs current ${subModelsGenRef.current})`);
            }
        } catch (e) {
            if (myGen === subModelsGenRef.current) {
                const msg = e instanceof Error ? e.message : String(e);
                setSubModelsError(msg);
                console.error("runSubModelFits failed:", e);
            }
        } finally {
            // Only the latest gen flips loading off — older calls' finally
            // would otherwise momentarily clear a still-running newer call's
            // loading flag.
            if (myGen === subModelsGenRef.current) {
                setSubModelsLoading(false);
            }
        }
    }, [targetSensor, predictorSensors, relStiffness, dashboardFilterPayload, relPreview, fitIsStale]);

    /** Open the sub-models modal; lazy-fits when no/stale cache. */
    const handleOpenSubModels = () => {
        setSubModelsOpen(true);
        if (!targetSensor || predictorSensors.length === 0) return;
        if ((!subModels || subModelsStale) && !subModelsLoading) {
            runSubModelFits();
        }
    };

    /**
     * Build an ECharts scatter option for ONE sub-model fit. Mirrors the
     * structure of the main `relScatterOption` but tailored for the
     * compact card layout in the sub-models modal (smaller margins,
     * font sizes). All sub-graphs share the same X-axis sensor — the
     * first predictor in the cumulative subset, which is also the FIRST
     * predictor of the full list, so apples-to-apples across cards.
     */
    const buildSubModelOption = useCallback((fit: SubModelFit, xSensor: string) => {
        const { result, predictors } = fit;
        const xRaw = result.predictor_raw;
        const yRaw = result.target_raw;
        const yPred = result.predicted;
        if (!xRaw || !yRaw || !yPred) return null;
        if (xRaw.length === 0) return null;

        const xIdx = predictors.indexOf(xSensor);
        if (xIdx < 0) return null;

        const txtPrimary    = '#f1f5f9';
        const txtSecondary  = '#94a3b8';
        const gridLine      = '#334155';
        const tooltipBg     = 'rgba(30,41,59,0.95)';
        const tooltipBorder = '#334155';

        const rawPoints: [number, number][] = [];
        const modelPoints: [number, number][] = [];
        const n = Math.min(xRaw.length, yRaw.length, yPred.length);
        for (let i = 0; i < n; i++) {
            const xv = xRaw[i]?.[xIdx];
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
            type: 'scatter' as const,
            symbolSize,
            large: isLargeData,
            largeThreshold: 2000,
            progressive: 5000,
            progressiveThreshold: 10000,
            emphasis: { scale: !isHugeData, disabled: isHugeData },
            silent: isHugeData,
        };

        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
            animation: !isLargeData,
            tooltip: {
                trigger: 'item',
                backgroundColor: tooltipBg,
                borderColor: tooltipBorder,
                textStyle: { color: txtPrimary },
                formatter: (p: any) => {
                    const v = p.value as [number, number];
                    return `<div style="font-weight:bold;margin-bottom:4px;color:${p.color}">${p.seriesName}</div>`
                        + `<div>${xSensor}: ${typeof v?.[0] === 'number' ? v[0].toFixed(4) : '—'}</div>`
                        + `<div>${targetSensor}: ${typeof v?.[1] === 'number' ? v[1].toFixed(4) : '—'}</div>`;
                },
            },
            legend: {
                data: ['Raw', 'Model'],
                textStyle: { color: txtSecondary, fontSize: 11 },
                top: 4,
                right: 10,
                itemWidth: 10,
                itemHeight: 10,
            },
            grid: { left: 56, right: 22, top: 32, bottom: 50, containLabel: false },
            dataZoom: [
                { type: 'inside', xAxisIndex: 0, filterMode: 'filter' },
                { type: 'inside', yAxisIndex: 0, filterMode: 'filter' },
            ],
            xAxis: {
                type: 'value',
                name: xSensor,
                nameLocation: 'middle',
                nameGap: 26,
                nameTextStyle: { color: txtSecondary, fontSize: 11 },
                scale: true,
                axisLabel: { color: txtSecondary, fontSize: 10 },
                axisLine: { lineStyle: { color: gridLine } },
                splitLine: { show: false },
            },
            yAxis: {
                type: 'value',
                name: targetSensor,
                nameLocation: 'middle',
                nameGap: 40,
                nameTextStyle: { color: txtSecondary, fontSize: 11 },
                scale: true,
                axisLabel: { color: txtSecondary, fontSize: 10 },
                axisLine: { lineStyle: { color: gridLine } },
                splitLine: { show: true, lineStyle: { color: gridLine, type: 'dashed', opacity: 0.3 } },
            },
            series: [
                {
                    ...seriesCommon,
                    name: 'Raw',
                    data: rawPoints,
                    itemStyle: { color: '#3b82f6', opacity: pointOpacity },
                },
                {
                    ...seriesCommon,
                    name: 'Model',
                    data: modelPoints,
                    itemStyle: { color: '#f43f5e', opacity: pointOpacity },
                },
            ],
        };
    }, [targetSensor]);

    const handleClusteringApply = async () => {
        if (!targetSensor) {
            setClusteringError("Target sensor is required.");
            return;
        }
        // The "first sensor" is the X-axis predictor; "second sensor" is the target (Y-axis).
        const firstSensor = scatterXSensor || predictorSensors[0] || "";
        if (!firstSensor) {
            setClusteringError("Select a predictor sensor for the X-axis.");
            return;
        }
        // Multi-cluster requires a criteria sensor + one range per cluster.
        // Fall back to 1 cluster when no criteria is picked (matches the
        // disabled-state of the criteria/range inputs in the UI).
        const effectiveClusters = criteriaSensor ? numClusters : 1;
        if (effectiveClusters > 1) {
            if (!criteriaSensor) {
                setClusteringError("Pick a criteria sensor to split rows into clusters.");
                return;
            }
            if (clusterRanges.length !== effectiveClusters) {
                setClusteringError(
                    `Expected ${effectiveClusters} cluster ranges but found ${clusterRanges.length}.`,
                );
                return;
            }
        }

        setClusteringLoading(true);
        setClusteringError(null);
        try {
            const result = await invoke<ClusteringPreview>("compute_clustering_preview", {
                first_sensor: firstSensor,
                second_sensor: targetSensor,
                n_clusters: effectiveClusters,
                criteria_sensor: effectiveClusters > 1 ? criteriaSensor : null,
                cluster_ranges: effectiveClusters > 1 ? clusterRanges.slice(0, effectiveClusters) : null,
                filter: dashboardFilterPayload,
            });
            setClusteringPreview(result);
            debugLog("Clustering preview:", result);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setClusteringError(msg);
            setClusteringPreview(null);
            console.error("compute_clustering_preview failed:", e);
        } finally {
            setClusteringLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="predictive-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>Loading model data...</div>
            </div>
        );
    }

    return (
        <div className="predictive-container">
            {/* Command bar — no window chrome (minimize/maximize/close) here
                anymore: this is a page inside BuildModelWindow now, not its
                own OS window, so that's BuildModelWindow's own titlebar's
                job. "Closing" this page just means going back to it. */}
            <div className="pm-commandbar">
                <button className="pm-btn pm-btn-secondary" onClick={onBack} title="Back to Build Model overview">
                    <ArrowLeft size={13} />
                    <span>Back</span>
                </button>
                <div className="pm-breadcrumb">
                    <span className="pm-crumb-current" title={workspaceName || undefined}>
                        {workspaceName || 'Unnamed'}
                    </span>
                    <ChevronRight size={12} className="pm-crumb-sep" />
                    <span className="pm-crumb-muted">Target</span>
                    <span className="pm-crumb-current">{targetSensor || 'Model'}</span>
                </div>
                <div className="pm-flex-spacer" />
                <button
                    className="pm-btn pm-btn-primary"
                    onClick={onFinish}
                    title="Mark this model Complete and return to the overview"
                >
                    <Check size={13} />
                    <span>Finish</span>
                </button>
            </div>

            {/* Main Content */}
            <div className={`predictive-body pm-grid ${kind === 'individual' ? 'pm-grid--no-right' : ''}`}>
                {/* LEFT PANEL - Target + Predictors + Filter */}
                <div className="pm-col-left">
                    {/* Target */}
                    <div className="pm-section">
                        <div className="pm-section-header">
                            <span className="pm-eyebrow">Target</span>
                            <span className="pm-section-title">Predict this sensor</span>
                        </div>
                        <div className="pm-target-card">
                            <div className="pm-target-card-top">
                                <Thermometer size={14} className="pm-target-icon" />
                                <span className="pm-target-tag">{targetSensor || 'Not selected'}</span>
                            </div>
                            {getDesc(targetSensor) && (
                                <div className="pm-target-desc">{getDesc(targetSensor)}</div>
                            )}
                            <div className="pm-target-meta">From previous page</div>
                        </div>
                    </div>

                    {/* Predictors — only Relationship (regressors) and
                        Clustering (X sensor) use predictor sensors; Individual
                        trains on the target sensor alone, so this section has
                        no effect for it and is hidden entirely. */}
                    {kind !== 'individual' && (
                        <div className="pm-section">
                            <div className="pm-section-header">
                                <span className="pm-eyebrow">Inputs</span>
                                <span className="pm-section-title">Predictor sensors</span>
                                <span className="pm-count-pill">{predictorSensors.length}</span>
                            </div>
                            <div className="pm-section-hint">
                                {kind === 'clustering'
                                    // Clustering only ever uses ONE of these
                                    // (whichever becomes the X sensor below) —
                                    // "informs the target" is Relationship
                                    // phrasing and doesn't fit a single-axis
                                    // pick, so this stays honest about why
                                    // more than one might be added.
                                    ? 'Add candidate sensors, then pick one as the X sensor below.'
                                    : 'Select sensors whose history informs the target. Multi-select.'}
                            </div>
                            <SensorAutocomplete
                                sensors={allSensors}
                                getDesc={getDesc}
                                value=""
                                onSelect={(tag) => { if (tag) handlePredictorToggle(tag); }}
                                placeholder="Search sensor tag or description..."
                                excluded={predictorSensors}
                                clearOnSelect
                            />
                            {/* Selected predictor chips — uses the richer pm-selected
                                styling (color dot per slot, tag + description, remove)
                                inherited from the old right-column panel. Single
                                source of truth so the right column doesn't duplicate. */}
                            <div style={{ marginTop: '0.6rem' }}>
                                {predictorSensors.length === 0 ? (
                                    <div className="pm-empty-dashed">No predictors selected</div>
                                ) : (
                                    <div className="pm-selected-list">
                                        {predictorSensors.map((sensor, idx) => {
                                            const d = getDesc(sensor);
                                            return (
                                                <div key={sensor} className="pm-selected-chip" title={d}>
                                                    <span className={`pm-selected-dot pm-selected-dot-${(idx % 4) + 1}`} />
                                                    <div className="pm-selected-text">
                                                        <div className="pm-selected-tag">{sensor}</div>
                                                        {d && <div className="pm-selected-desc">{d}</div>}
                                                    </div>
                                                    <button className="pm-selected-remove" onClick={() => handlePredictorToggle(sensor)}>
                                                        <X size={12} />
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}


                    {/* Data filter */}
                    <div className="pm-section">
                        <div className="pm-section-header">
                            <span className="pm-eyebrow">Scope</span>
                            <span className="pm-section-title">Data filter</span>
                        </div>
                        <div className="filter-row">
                            <label>Time start</label>
                            <div className="date-input-wrapper">
                                <input
                                    ref={filterTimeStartRef}
                                    type="datetime-local"
                                    value={filterTimeStart || targetMinForInput}
                                    min={targetMinForInput || undefined}
                                    max={targetMaxForInput || undefined}
                                    onChange={e => setFilterTimeStart(e.target.value)}
                                />
                                {/* Flush against the box's own right edge
                                    (`marginLeft: auto` pushes it there
                                    regardless of how much space the input
                                    itself takes up) and white — explicit
                                    color, not just `currentColor` inherited
                                    from the wrapper's dimmer text color, so
                                    it reads clearly against the dark input
                                    background rather than blending in. */}
                                <Calendar
                                    size={14}
                                    style={{ cursor: 'pointer', color: '#fff', marginLeft: 'auto' }}
                                    onClick={() => filterTimeStartRef.current?.showPicker?.()}
                                />
                            </div>
                        </div>
                        <div className="filter-row">
                            <label>Time end</label>
                            <div className="date-input-wrapper">
                                <input
                                    ref={filterTimeEndRef}
                                    type="datetime-local"
                                    value={filterTimeEnd || targetMaxForInput}
                                    min={targetMinForInput || undefined}
                                    max={targetMaxForInput || undefined}
                                    onChange={e => setFilterTimeEnd(e.target.value)}
                                />
                                <Calendar
                                    size={14}
                                    style={{ cursor: 'pointer', color: '#fff', marginLeft: 'auto' }}
                                    onClick={() => filterTimeEndRef.current?.showPicker?.()}
                                />
                            </div>
                        </div>
                        {/* Running condition — workspace-wide, read-only here. Owned
                            and edited entirely from BuildModelWindow's Overview page
                            ("Running Condition Filter" panel) so every model (any
                            kind, any count) shares one definition instead of each
                            needing its own "machine running" filter set separately
                            (2026-09-15 — see runningConditionFilters prop doc). */}
                        <div className="filter-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '0.4rem',
                            }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                    Running condition
                                    {runningConditionFilters.length > 0 && (
                                        <span className="pm-count-pill">{runningConditionFilters.length}</span>
                                    )}
                                </label>
                                <button
                                    type="button"
                                    onClick={onBack}
                                    title="Edit the workspace-wide running-condition filter on the Overview page"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.2rem',
                                        padding: '0.2rem 0.45rem',
                                        background: 'rgba(59,130,246,0.12)',
                                        border: '1px solid rgba(59,130,246,0.3)',
                                        borderRadius: '4px',
                                        color: 'var(--accent-color)',
                                        fontSize: '0.65rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                    }}
                                >
                                    Edit on Overview →
                                </button>
                            </div>

                            {runningConditionFilters.length === 0 ? (
                                <div style={{
                                    fontSize: '0.7rem',
                                    color: 'var(--text-secondary)',
                                    opacity: 0.65,
                                    padding: '0.3rem 0 0',
                                    fontStyle: 'italic',
                                }}>
                                    No running-condition filter set — training on the full dataset, including idle periods.
                                </div>
                            ) : (
                                <div style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: '0.3rem',
                                    marginTop: '0.3rem',
                                }}>
                                    {runningConditionFilters.map(f => (
                                        <span key={f.id} className="pm-count-pill" style={{
                                            padding: '0.25rem 0.5rem',
                                            fontSize: '0.68rem',
                                            fontWeight: 500,
                                        }}>
                                            {getDesc(f.sensor) || f.sensor}{' '}
                                            {f.operation === 'greater_than' ? '>' : f.operation === 'less_than' ? '<' : f.operation === 'between' ? 'between' : '='}{' '}
                                            {f.operation === 'between' ? `${f.value1}–${f.value2}` : f.value1}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                </div>

                {/* CENTER */}
                <div className="pm-col-center">
                    {/* Toggle pills + axis info */}
                    <div className="pm-mode-row">
                        {/* Locked to this model's own `kind` — chosen already
                            on the Build Model overview page's "Model kind"
                            selector, so this page must not ask again. The
                            two non-matching buttons are disabled+dimmed
                            rather than hidden, so the model's kind is still
                            visible at a glance. */}
                        <div className="pm-segmented">
                            <button
                                className={`pm-segmented-btn ${individualChecked ? 'active' : ''}`}
                                disabled={kind !== 'individual'}
                                title={kind === 'individual' ? 'Individual plot' : `This model's kind is ${KIND_LABEL[kind]} — set on the Build Model overview page`}
                            >
                                <Activity size={13} />
                                <span>Individual</span>
                            </button>
                        </div>
                        <div className="pm-segmented">
                            <button
                                className={`pm-segmented-btn ${rcMode === 'relationship' ? 'active' : ''}`}
                                disabled={kind !== 'relationship'}
                                title={kind === 'relationship' ? 'Relationship plot' : `This model's kind is ${KIND_LABEL[kind]} — set on the Build Model overview page`}
                            >
                                <GitBranch size={13} />
                                <span>Relationship</span>
                            </button>
                            <button
                                className={`pm-segmented-btn ${rcMode === 'clustering' ? 'active' : ''}`}
                                disabled={kind !== 'clustering'}
                                title={kind === 'clustering' ? 'Clustering plot' : `This model's kind is ${KIND_LABEL[kind]} — set on the Build Model overview page`}
                            >
                                <Layers size={13} />
                                <span>Clustering</span>
                            </button>
                        </div>
                        <div className="pm-flex-spacer" />
                        <span className="pm-axis-info">
                            X: TimeStamp <span className="pm-axis-faint">(fixed)</span> · Y: {targetSensor || '—'} <span className="pm-axis-faint">(fixed)</span>
                        </span>
                    </div>

                    {/* Chart area — Individual and RC can be shown simultaneously */}
                    <div className="pm-chart-stack">
                        {!individualChecked && !rcMode && (
                            <div className="pm-chart-card pm-chart-empty">
                                <div className="plot-placeholder pm-chart-placeholder">
                                    <Activity size={48} style={{ opacity: 0.2 }} />
                                    <p>Select a plot type</p>
                                    <p className="plot-placeholder-sub">Toggle Individual, Relationship, or Clustering above</p>
                                </div>
                            </div>
                        )}

                        {individualChecked && (
                            <div className="pm-chart-card">
                                <div className="pm-chart-header">
                                    <div className="pm-chart-title-block">
                                        <div className="pm-chart-title">Standard Time Series</div>
                                        <div className="pm-chart-subtitle">1σ + 3σ boundary drawn automatically</div>
                                    </div>
                                    <div className="pm-chart-legend">
                                        <span className="pm-legend-dot"><span className="pm-legend-line pm-legend-accent" />Target</span>
                                        <span className="pm-legend-dot"><span className="pm-legend-line pm-legend-warn" />±1σ</span>
                                        <span className="pm-legend-dot"><span className="pm-legend-line pm-legend-danger pm-legend-dashed" />±3σ</span>
                                    </div>
                                    <button
                                        className="pm-chart-expand-btn"
                                        onClick={() => setExpandedChart('individual')}
                                        title="Expand chart"
                                        aria-label="Expand chart"
                                    >
                                        <Maximize2 size={14} />
                                    </button>
                                </div>
                                <div className="pm-chart-body">
                                    {!targetSensor ? (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            <Activity size={48} style={{ opacity: 0.2 }} />
                                            <p>No target sensor selected</p>
                                            <p className="plot-placeholder-sub">Pick a target sensor on the previous page</p>
                                        </div>
                                    ) : targetChartLoading && !targetHasData ? (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            <Loader2 size={36} style={{ opacity: 0.45 }} className="pm-spin" />
                                            <p>Loading {targetSensor}…</p>
                                        </div>
                                    ) : !targetHasData ? (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            <Activity size={48} style={{ opacity: 0.2 }} />
                                            <p>No data available for {targetSensor}</p>
                                        </div>
                                    ) : (
                                        <LineChart
                                            data={EMPTY_RECORDS}
                                            columnar={targetChartColumnar}
                                            sensors={targetChartSensors}
                                            headers={targetChartHeaders}
                                            markLines={targetMarkLines}
                                            hideYSplitLine
                                        />
                                    )}
                                </div>
                            </div>
                        )}

                        {rcMode && (
                            <div className="pm-chart-card">
                                <div className="pm-chart-header">
                                    <div className="pm-chart-title-block">
                                        <div className="pm-chart-title">
                                            {rcMode === 'relationship' ? 'Predictor vs. Target' : 'Cluster Assignment'}
                                        </div>
                                        <div className="pm-chart-subtitle">
                                            {rcMode === 'relationship'
                                                ? `Raw (blue) vs. Relation model output (red) — pick a predictor for the X-axis${dashboardFilterPayload ? ' · using Dashboard filter' : ''}`
                                                // Actual algorithm is GMM ellipse fits (nalgebra) —
                                                // see CLAUDE.md — not k-means. This label was just
                                                // wrong, not a confidential-naming case like
                                                // Relationship's LinearGAM.
                                                : 'GMM clustering'}
                                        </div>
                                    </div>
                                    {rcMode && predictorSensors.length > 0 && (
                                        <div className="pm-scatter-x-selector">
                                            <label>X-axis:</label>
                                            <SensorAutocomplete
                                                sensors={predictorSensors}
                                                getDesc={getDesc}
                                                value={effectiveScatterX}
                                                onSelect={setScatterXSensor}
                                                placeholder="Select X-axis sensor..."
                                                style={{ minWidth: '180px' }}
                                            />
                                        </div>
                                    )}
                                    {/* Sub-models button — only meaningful for ≥2 predictors,
                                        since a single-predictor "sub-model" view would just
                                        duplicate the inline chart. */}
                                    {rcMode === 'relationship' && predictorSensors.length > 1 && (
                                        <button
                                            className="pm-chart-expand-btn"
                                            onClick={handleOpenSubModels}
                                            title="View sub-models (one chart per cumulative-predictor step)"
                                            aria-label="View sub-models"
                                        >
                                            <LayoutGrid size={14} />
                                        </button>
                                    )}
                                    <button
                                        className="pm-chart-expand-btn"
                                        onClick={() => setExpandedChart('rc')}
                                        title="Expand chart"
                                        aria-label="Expand chart"
                                    >
                                        <Maximize2 size={14} />
                                    </button>
                                </div>
                                {/* Inline progress bar — visible across BOTH Apply phases:
                                    PHASE 1 (relLoading) is the main multivariate fit,
                                    PHASE 2 (subModelsLoading) is the cumulative sub-model
                                    fits that Apply now pre-computes so the PDF report
                                    always has every step chart. Without the phase-2 arm,
                                    after phase 1 the chart appears but the page goes
                                    silent for the 1-3s/predictor of sub-model fitting —
                                    which read to the user as a "stuck spinner". */}
                                {rcMode === 'relationship' && (relLoading || subModelsLoading) && (
                                    <div className="pm-progress">
                                        <div className="pm-progress-track">
                                            {subModelsLoading && subModelsProgress.total > 0 ? (
                                                <div
                                                    className="pm-progress-bar"
                                                    style={{ width: `${Math.min(100, (subModelsProgress.current / subModelsProgress.total) * 100)}%` }}
                                                />
                                            ) : relFitProgress && relFitProgress.total > 1 ? (
                                                <div
                                                    className="pm-progress-bar"
                                                    style={{ width: `${Math.min(100, (relFitProgress.current / relFitProgress.total) * 100)}%` }}
                                                />
                                            ) : (
                                                <div className="pm-progress-bar pm-progress-bar--indeterminate" />
                                            )}
                                        </div>
                                        <div className="pm-progress-label">
                                            <Loader2 size={11} className="pm-spin" />
                                            {subModelsLoading
                                                ? `Fitting sub-model ${Math.min(subModelsProgress.current + 1, subModelsProgress.total)} of ${subModelsProgress.total}…`
                                                : relFitProgress && relFitProgress.total > 1
                                                    ? `Fitting predictor ${Math.min(relFitProgress.current + 1, relFitProgress.total)} of ${relFitProgress.total}…`
                                                    : 'Running Relation model…'}
                                        </div>
                                    </div>
                                )}
                                <div className="pm-chart-body" style={{ position: 'relative' }}>
                                    {rcMode === 'relationship' && relScatterOption ? (
                                        <ResponsiveECharts option={relScatterOption} style={{ minHeight: '200px' }} />
                                    ) : rcMode === 'relationship' && relLoading ? (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            <Loader2 size={36} style={{ opacity: 0.45 }} className="pm-spin" />
                                            <p>Running Relation model…</p>
                                        </div>
                                    ) : rcMode === 'clustering' && clusteringScatterOption ? (
                                        <ResponsiveECharts option={clusteringScatterOption} style={{ minHeight: '200px' }} />
                                    ) : rcMode === 'clustering' && clusteringLoading ? (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            <Loader2 size={36} style={{ opacity: 0.45 }} className="pm-spin" />
                                            <p>Fitting cluster ellipse…</p>
                                        </div>
                                    ) : (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            {rcMode === 'relationship' ? <GitBranch size={48} style={{ opacity: 0.2 }} /> : <Layers size={48} style={{ opacity: 0.2 }} />}
                                            <p>
                                                {rcMode === 'relationship' ? 'No prediction yet' : 'Cluster Plot'}
                                            </p>
                                            <p className="plot-placeholder-sub">
                                                {rcMode === 'relationship' ? 'Pick predictors then click Apply to compute predicted values' : 'Click Apply to draw cluster ellipses'}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Stats strip — computed on the Rust side over all rows */}
                    <div className="pm-stats-strip">
                        <span className="pm-stats-eyebrow">Target stats</span>
                        {statsError ? (
                            <div className="pm-stats-item">
                                <span className="pm-stats-label" style={{ color: '#f43f5e' }}>Error</span>
                                <span className="pm-stats-value" style={{ color: '#f43f5e' }}>{statsError}</span>
                            </div>
                        ) : (
                            <>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">N</span>
                                    <span className="pm-stats-value">{targetStats ? targetStats.count.toLocaleString() : '—'}</span>
                                </div>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">Mean</span>
                                    <span className="pm-stats-value">{targetStats ? targetStats.mean.toFixed(3) : '—'}</span>
                                </div>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">SD</span>
                                    <span className="pm-stats-value">{targetStats ? targetStats.sd.toFixed(3) : '—'}</span>
                                </div>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">Min</span>
                                    <span className="pm-stats-value">{targetStats ? targetStats.min.toFixed(3) : '—'}</span>
                                </div>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">Max</span>
                                    <span className="pm-stats-value">{targetStats ? targetStats.max.toFixed(3) : '—'}</span>
                                </div>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">±1σ</span>
                                    <span className="pm-stats-value">
                                        {targetStats ? `${targetStats.lower1.toFixed(3)} – ${targetStats.upper1.toFixed(3)}` : '—'}
                                    </span>
                                </div>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">±3σ</span>
                                    <span className="pm-stats-value pm-stats-warn">
                                        {targetStats ? `${targetStats.lower3.toFixed(3)} – ${targetStats.upper3.toFixed(3)}` : '—'}
                                    </span>
                                </div>
                            </>
                        )}
                        {rcMode === 'relationship' && (
                            <>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">R²</span>
                                    <span className="pm-stats-value">{modelStats.r2?.toFixed(4) ?? '—'}</span>
                                </div>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">RMSE</span>
                                    <span className="pm-stats-value">{modelStats.rmse?.toFixed(4) ?? '—'}</span>
                                </div>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">Resid Mean</span>
                                    <span className="pm-stats-value">{residualStats?.mean.toFixed(4) ?? '—'}</span>
                                </div>
                                <div className="pm-stats-item">
                                    <span className="pm-stats-label">Resid SD</span>
                                    <span className="pm-stats-value">{residualStats?.sd.toFixed(4) ?? '—'}</span>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* RIGHT - Context config (predictors chips moved into LEFT
                    "Predictor sensors" section to remove duplicate UI). Only
                    Relationship/Clustering models have config here at all —
                    for Individual there is nothing to configure on this page,
                    so the whole column is dropped rather than shown dimmed. */}
                {kind !== 'individual' && (
                <div className="pm-col-right">
                    {/* Relationship Model Config — kind is locked per model
                        (never changes after creation), so a Clustering-kind
                        model can never use this block; showing it dimmed
                        was clutter with no upside, same bug class as the
                        Individual-page fix above. Only rendered at all when
                        it's actually this model's kind. */}
                    {kind === 'relationship' && (
                    <div className={`pm-section pm-config-block ${rcMode === 'relationship' ? '' : 'pm-config-dim'}`}>
                        <div className="pm-section-header">
                            <span className="pm-eyebrow">Configure</span>
                            <span className="pm-section-title">Relationship Model</span>
                            <button
                                className="pm-btn pm-btn-primary pm-btn-sm"
                                onClick={handleRelationshipApply}
                                // Only block on phase 1 (the main multivariate fit) —
                                // phase 2 (sub-models) runs in the background after
                                // Apply returns, so the button re-enables as soon as
                                // there's a chart to look at. Concurrent re-clicks
                                // are handled by `subModelsGenRef` (older fits drop
                                // their writes when they discover a newer Apply
                                // claimed a fresher generation).
                                disabled={rcMode !== 'relationship' || relLoading}
                            >
                                {relLoading ? (
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        <Loader2 size={12} className="animate-spin" />
                                        Running…
                                    </span>
                                ) : 'Apply'}
                            </button>
                        </div>
                        <div className="pm-fields">
                            <div className="filter-row">
                                <label>Model Name</label>
                                <input
                                    type="text"
                                    value={relModelName}
                                    onChange={e => setRelModelName(e.target.value)}
                                    placeholder="Optional"
                                    className="config-input"
                                    disabled={rcMode !== 'relationship'}
                                />
                            </div>
                            <div className="filter-row">
                                <label>Stiffness</label>
                                <select
                                    value={relStiffness}
                                    onChange={e => setRelStiffness(Number(e.target.value))}
                                    className="config-input"
                                    disabled={rcMode !== 'relationship'}
                                >
                                    {STIFFNESS_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            {relError && (
                                <div className="filter-row" style={{ color: '#f43f5e', fontSize: 12 }}>
                                    {relError}
                                </div>
                            )}
                            {relPreview && !relError && (
                                <div className="filter-row" style={{ flexDirection: 'column', alignItems: 'stretch', color: 'var(--text-secondary)', fontSize: 12, gap: 2 }}>
                                    <div>
                                        Fit on {relPreview.predictorsAtApply.length} predictor{relPreview.predictorsAtApply.length !== 1 ? 's' : ''} · {relPreview.result.predicted.length.toLocaleString()} rows
                                    </div>
                                    {fitIsStale && (
                                        <div style={{ color: '#f59e0b' }}>
                                            Predictor selection changed — click Apply to refit.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    )}

                    {/* Clustering Model Config — same reasoning as
                        Relationship above: only rendered when it's actually
                        this model's kind. */}
                    {kind === 'clustering' && (
                    <div className={`pm-section pm-config-block ${rcMode === 'clustering' ? '' : 'pm-config-dim'}`}>
                        <div className="pm-section-header">
                            <span className="pm-eyebrow">Configure</span>
                            <span className="pm-section-title">Clustering Model</span>
                            <button
                                className="pm-btn pm-btn-primary pm-btn-sm"
                                onClick={handleClusteringApply}
                                disabled={rcMode !== 'clustering' || clusteringLoading}
                            >
                                {clusteringLoading ? (
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        <Loader2 size={12} className="animate-spin" />
                                        Running…
                                    </span>
                                ) : 'Apply'}
                            </button>
                        </div>
                        <div className="pm-fields pm-fields-clustering">
                            {/* Row 1: Model Name (full-width) */}
                            <div className="filter-row">
                                <label>Model Name</label>
                                <input
                                    type="text"
                                    value={clusterModelName}
                                    onChange={e => setClusterModelName(e.target.value)}
                                    placeholder="Optional — auto-generated if left blank"
                                    className="config-input"
                                    disabled={rcMode !== 'clustering'}
                                />
                            </div>

                            {/* Row 1.5: X sensor — picks from the user's selected predictors. */}
                            <div className="filter-row">
                                <label>
                                    X sensor (vs target on Y)
                                    {predictorSensors.length === 0 && (
                                        <span className="pm-field-hint-inline"> · add a predictor first</span>
                                    )}
                                </label>
                                <SensorAutocomplete
                                    sensors={predictorSensors}
                                    getDesc={getDesc}
                                    value={scatterXSensor}
                                    onSelect={setScatterXSensor}
                                    placeholder={predictorSensors.length === 0 ? 'No predictors selected' : 'Pick from predictors...'}
                                    disabled={rcMode !== 'clustering' || predictorSensors.length === 0}
                                />
                            </div>

                            {/* Row 2: # of Clusters + Criteria Sensor (2-col grid) */}
                            <div className="pm-field-grid-2">
                                <div className="filter-row">
                                    <label>Number of Clusters</label>
                                    <div className="pm-stepper">
                                        <button
                                            type="button"
                                            className="pm-stepper-btn"
                                            onClick={() => setNumClusters(n => Math.max(1, n - 1))}
                                            disabled={rcMode !== 'clustering' || numClusters <= 1}
                                            aria-label="Decrease number of clusters"
                                        >
                                            <Minus size={14} />
                                        </button>
                                        <span className="pm-stepper-value">{numClusters}</span>
                                        <button
                                            type="button"
                                            className="pm-stepper-btn"
                                            onClick={() => setNumClusters(n => n + 1)}
                                            disabled={rcMode !== 'clustering'}
                                            aria-label="Increase number of clusters"
                                        >
                                            <Plus size={14} />
                                        </button>
                                    </div>
                                </div>
                                <div className="filter-row">
                                    <label>
                                        Criteria Sensor
                                        {numClusters <= 1 && (
                                            <span className="pm-field-hint-inline"> · used when N ≥ 2</span>
                                        )}
                                    </label>
                                    <SensorAutocomplete
                                        sensors={allSensors}
                                        getDesc={getDesc}
                                        value={criteriaSensor}
                                        onSelect={setCriteriaSensor}
                                        placeholder={numClusters <= 1 ? 'Not needed for 1 cluster' : 'Pick criteria sensor...'}
                                        allowNone
                                        disabled={rcMode !== 'clustering' || numClusters <= 1}
                                    />
                                </div>
                            </div>

                            {/* Row 3: Per-cluster ranges, now visualised as a
                                multi-handle slider over the criteria sensor's
                                actual [min, max] data range. N-1 draggable
                                split handles partition the track into N
                                colored segments; auto-divided evenly on
                                sensor/N change. The persisted shape is still
                                `PredictiveClusterRange[]` (each cluster's
                                {min, max}) — only the editor changed. */}
                            <div className="filter-row">
                                <label>
                                    Cluster Ranges
                                    {(numClusters <= 1 || !criteriaSensor) && (
                                        <span className="pm-field-hint-inline"> · requires criteria sensor + N≥2</span>
                                    )}
                                </label>
                                {(() => {
                                    const sliderDisabled = rcMode !== 'clustering' || numClusters <= 1 || !criteriaSensor;
                                    if (sliderDisabled) {
                                        return (
                                            <div className="pm-cluster-slider pm-cluster-slider--empty">
                                                {numClusters <= 1
                                                    ? 'One cluster — every row goes in. No ranges to set.'
                                                    : !criteriaSensor
                                                        ? 'Pick a criteria sensor above to define cluster ranges.'
                                                        : '—'}
                                            </div>
                                        );
                                    }
                                    if (!criteriaStats) {
                                        return (
                                            <div className="pm-cluster-slider pm-cluster-slider--empty">
                                                <Loader2 size={12} className="animate-spin" /> Loading {criteriaSensor} range…
                                            </div>
                                        );
                                    }
                                    if (criteriaStats.min === criteriaStats.max) {
                                        return (
                                            <div className="pm-cluster-slider pm-cluster-slider--empty">
                                                {criteriaSensor} has a constant value ({criteriaStats.min}) — cannot partition.
                                            </div>
                                        );
                                    }
                                    const lo = criteriaStats.min;
                                    const hi = criteriaStats.max;
                                    const span = hi - lo;
                                    const fmt = (v: number | null) =>
                                        v == null ? '—' : (
                                            // Pick decimal precision based on the value's magnitude
                                            // — small numbers get more precision, big numbers fewer.
                                            Math.abs(v) >= 100 ? v.toFixed(1)
                                            : Math.abs(v) >= 10 ? v.toFixed(2)
                                            : v.toFixed(3)
                                        );
                                    const pctOf = (v: number) =>
                                        Math.max(0, Math.min(100, ((v - lo) / span) * 100));

                                    // Drag a split handle. The handle at index `idx` is the
                                    // boundary between cluster[idx] and cluster[idx+1], i.e.
                                    // cluster[idx].max = cluster[idx+1].min. Clamped against
                                    // adjacent splits so handles can't cross.
                                    const startSplitDrag = (idx: number, e: React.MouseEvent) => {
                                        e.preventDefault();
                                        const track = (e.currentTarget.parentElement) as HTMLDivElement | null;
                                        if (!track) return;
                                        const rect = track.getBoundingClientRect();
                                        const onMove = (moveEvt: MouseEvent) => {
                                            const x = moveEvt.clientX - rect.left;
                                            const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
                                            const value = lo + (pct / 100) * span;
                                            setClusterRanges(prev => {
                                                // Clamp between the boundaries of the immediately
                                                // adjacent clusters so handles can't cross.
                                                const leftBound = (prev[idx]?.min ?? lo);
                                                const rightBound = (prev[idx + 1]?.max ?? hi);
                                                // Add a tiny epsilon so clusters never have
                                                // zero width (would break downstream consumers).
                                                const eps = span * 0.001;
                                                const clamped = Math.max(leftBound + eps, Math.min(rightBound - eps, value));
                                                return prev.map((r, i) => {
                                                    if (i === idx) return { ...r, max: clamped };
                                                    if (i === idx + 1) return { ...r, min: clamped };
                                                    return r;
                                                });
                                            });
                                        };
                                        const onUp = () => {
                                            document.removeEventListener('mousemove', onMove);
                                            document.removeEventListener('mouseup', onUp);
                                        };
                                        document.addEventListener('mousemove', onMove);
                                        document.addEventListener('mouseup', onUp);
                                    };

                                    return (
                                        <div className="pm-cluster-slider">
                                            {/* Bounds header */}
                                            <div className="pm-cluster-slider-header">
                                                <span className="pm-cluster-slider-bound">{fmt(lo)}</span>
                                                <span className="pm-cluster-slider-sensor">{criteriaSensor}</span>
                                                <span className="pm-cluster-slider-bound">{fmt(hi)}</span>
                                            </div>
                                            {/* Track with colored segments + draggable splits */}
                                            <div className="pm-cluster-slider-track">
                                                {clusterRanges.map((r, i) => {
                                                    const segLo = r.min ?? lo;
                                                    const segHi = r.max ?? hi;
                                                    const color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
                                                    return (
                                                        <div
                                                            key={`seg-${i}`}
                                                            className="pm-cluster-slider-segment"
                                                            style={{
                                                                left: `${pctOf(segLo)}%`,
                                                                width: `${pctOf(segHi) - pctOf(segLo)}%`,
                                                                background: color,
                                                            }}
                                                            title={`Cluster ${i + 1}: ${fmt(segLo)} – ${fmt(segHi)}`}
                                                        >
                                                            <span className="pm-cluster-slider-seg-label">#{i + 1}</span>
                                                        </div>
                                                    );
                                                })}
                                                {/* One handle per split point (numClusters - 1 of them) */}
                                                {clusterRanges.slice(0, -1).map((r, i) => {
                                                    const splitVal = r.max ?? hi;
                                                    return (
                                                        <div
                                                            key={`handle-${i}`}
                                                            className="pm-cluster-slider-handle"
                                                            style={{ left: `${pctOf(splitVal)}%` }}
                                                            onMouseDown={e => startSplitDrag(i, e)}
                                                            role="slider"
                                                            aria-label={`Split between cluster ${i + 1} and ${i + 2}`}
                                                            aria-valuemin={lo}
                                                            aria-valuemax={hi}
                                                            aria-valuenow={splitVal}
                                                            title={`${fmt(splitVal)}`}
                                                        />
                                                    );
                                                })}
                                            </div>
                                            {/* Per-cluster value pills */}
                                            <div className="pm-cluster-slider-values">
                                                {clusterRanges.map((r, i) => {
                                                    const color = CLUSTER_PALETTE[i % CLUSTER_PALETTE.length];
                                                    return (
                                                        <span key={`pill-${i}`} className="pm-cluster-slider-pill">
                                                            <span
                                                                className="pm-cluster-range-dot"
                                                                style={{ background: color }}
                                                            />
                                                            #{i + 1}: {fmt(r.min)} – {fmt(r.max)}
                                                        </span>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>

                            {clusteringError && (
                                <div className="pm-config-error">
                                    {clusteringError}
                                </div>
                            )}
                            {clusteringPreview && !clusteringError && (
                                <div className="pm-stat-pills">
                                    <div className="pm-stat-pill">
                                        <span className="pm-stat-pill-label">Clusters</span>
                                        <span className="pm-stat-pill-value">{clusteringPreview.cluster_count}</span>
                                    </div>
                                    <div className="pm-stat-pill">
                                        <span className="pm-stat-pill-label">Total Rows</span>
                                        <span className="pm-stat-pill-value">{clusteringPreview.n_rows.toLocaleString()}</span>
                                    </div>
                                    {/* For multi-cluster, show a one-line summary per cluster.
                                        For single-cluster, fall back to the previous detailed pills. */}
                                    {clusteringPreview.clusters.length === 1 && clusteringPreview.clusters[0] && (
                                        <>
                                            <div className="pm-stat-pill">
                                                <span className="pm-stat-pill-label">Center</span>
                                                <span className="pm-stat-pill-value">
                                                    ({clusteringPreview.clusters[0].ellipse.x_center.toFixed(3)}, {clusteringPreview.clusters[0].ellipse.y_center.toFixed(3)})
                                                </span>
                                            </div>
                                            <div className="pm-stat-pill">
                                                <span className="pm-stat-pill-label">σ</span>
                                                <span className="pm-stat-pill-value">
                                                    {clusteringPreview.clusters[0].ellipse.x_sd.toFixed(3)} × {clusteringPreview.clusters[0].ellipse.y_sd.toFixed(3)}
                                                </span>
                                            </div>
                                            <div className="pm-stat-pill">
                                                <span className="pm-stat-pill-label">Angle</span>
                                                <span className="pm-stat-pill-value">{clusteringPreview.clusters[0].ellipse.angle_deg.toFixed(2)}°</span>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    )}
                </div>
                )}
            </div>

            {/* Expanded chart modal — re-renders the active chart at full screen */}
            {expandedChart && (
                <div
                    className="pm-chart-modal-backdrop"
                    onClick={() => setExpandedChart(null)}
                    role="dialog"
                    aria-modal="true"
                >
                    <div
                        className="pm-chart-modal-card"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="pm-chart-modal-header">
                            <div className="pm-chart-title-block">
                                {expandedChart === 'individual' ? (
                                    <>
                                        <div className="pm-chart-title">Standard Time Series</div>
                                        <div className="pm-chart-subtitle">
                                            {targetSensor || '—'} · 1σ + 3σ boundary
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="pm-chart-title">
                                            {rcMode === 'relationship' ? 'Predictor vs. Target' : 'Cluster Assignment'}
                                        </div>
                                        <div className="pm-chart-subtitle">
                                            {rcMode === 'relationship'
                                                ? 'Raw (blue) vs. Relation model output (red)'
                                                : 'GMM clustering with confidence ellipses'}
                                        </div>
                                    </>
                                )}
                            </div>
                            <button
                                className="pm-chart-modal-close"
                                onClick={() => setExpandedChart(null)}
                                title="Close (Esc)"
                                aria-label="Close"
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <div className="pm-chart-modal-body">
                            {expandedChart === 'individual' && targetSensor && targetHasData ? (
                                <LineChart
                                    data={EMPTY_RECORDS}
                                    columnar={targetChartColumnar}
                                    sensors={targetChartSensors}
                                    headers={targetChartHeaders}
                                    markLines={targetMarkLines}
                                    hideYSplitLine
                                />
                            ) : expandedChart === 'rc' && rcMode === 'relationship' && relScatterOption ? (
                                <ResponsiveECharts option={relScatterOption} style={{ height: '100%', minHeight: '100%' }} />
                            ) : expandedChart === 'rc' && rcMode === 'clustering' && clusteringScatterOption ? (
                                <ResponsiveECharts option={clusteringScatterOption} style={{ height: '100%', minHeight: '100%' }} />
                            ) : (
                                <div className="plot-placeholder pm-chart-placeholder">
                                    <Activity size={48} style={{ opacity: 0.2 }} />
                                    <p>No chart data to display</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Sub-models Modal ─────────────────────────────────────────
                Detail view fired from the LayoutGrid button on the
                Relationship chart card. Renders one scatter card per
                cumulative-predictor step (1, 2, …, N), each with its own
                R² / 2·RMSE / RMSE / N so the user can see how each added
                predictor moves the model. Charts share an X-axis (the
                first predictor) so the comparison is apples-to-apples. */}
            {subModelsOpen && (
                <div
                    className="pm-preview-modal-backdrop"
                    onClick={() => setSubModelsOpen(false)}
                    role="dialog"
                    aria-modal="true"
                >
                    <div
                        className="pm-preview-modal-card pm-submodels-modal-card"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="pm-preview-modal-header">
                            <div className="pm-chart-title-block">
                                <div className="pm-chart-title">Sub-models</div>
                                <div className="pm-chart-subtitle">
                                    One Relation model fit per cumulative-feature subset · target: <code>{targetSensor || '—'}</code> · stiffness: <code>{stiffnessLabel(relStiffness)}</code>
                                </div>
                            </div>
                            <button
                                className="pm-chart-modal-close"
                                onClick={() => setSubModelsOpen(false)}
                                title="Close (Esc)"
                                aria-label="Close"
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <div className="pm-preview-modal-body pm-submodels-body">
                            {!targetSensor ? (
                                <div className="pm-preview-empty">No target sensor selected.</div>
                            ) : predictorSensors.length === 0 ? (
                                <div className="pm-preview-empty">Add at least one predictor to compute sub-models.</div>
                            ) : subModelsLoading ? (
                                <div className="pm-preview-empty">
                                    <Loader2 size={14} className="animate-spin" />
                                    Fitting Relation model {Math.min(subModelsProgress.current + 1, subModelsProgress.total)} of {subModelsProgress.total}…
                                </div>
                            ) : subModelsError ? (
                                <div className="pm-preview-error">{subModelsError}</div>
                            ) : !subModels || subModels.length === 0 ? (
                                <div className="pm-preview-empty">
                                    No sub-models computed yet.
                                    <button
                                        className="pm-btn pm-btn-secondary pm-btn-sm"
                                        onClick={runSubModelFits}
                                        style={{ marginLeft: 8 }}
                                    >
                                        Run now
                                    </button>
                                </div>
                            ) : (
                                <>
                                    {subModelsStale && (
                                        <div className="pm-submodels-stale-banner">
                                            <span>
                                                Predictor selection changed since last fit — these results may be stale.
                                            </span>
                                            <button
                                                className="pm-btn pm-btn-secondary pm-btn-sm"
                                                onClick={runSubModelFits}
                                                disabled={subModelsLoading}
                                            >
                                                Refresh
                                            </button>
                                        </div>
                                    )}
                                    {subModels.map((fit, idx) => {
                                        // Last entry of `r2_per_step` is the score for the
                                        // full subset of THIS sub-fit (per the sidecar
                                        // contract). We surface it as the headline R² for
                                        // this card.
                                        const r2 = fit.result.r2_per_step[fit.result.r2_per_step.length - 1];
                                        const rmse2 = fit.result.rmse2_per_step[fit.result.rmse2_per_step.length - 1];
                                        const xSensor = fit.predictors[0] ?? '';
                                        const opt = buildSubModelOption(fit, xSensor);
                                        return (
                                            <div key={idx} className="pm-submodel-card">
                                                <div className="pm-submodel-header">
                                                    <div className="pm-submodel-title-block">
                                                        <div className="pm-submodel-step">Step {idx + 1} of {subModels.length}</div>
                                                        <div className="pm-submodel-predictors">
                                                            <code>{fit.predictors.join(' + ')}</code>
                                                            <span className="pm-submodel-arrow"> → </span>
                                                            <code>{targetSensor}</code>
                                                        </div>
                                                    </div>
                                                    <div className="pm-submodel-stats">
                                                        <div className="pm-submodel-stat">
                                                            <span className="pm-submodel-stat-label">R²</span>
                                                            <span className="pm-submodel-stat-value">{typeof r2 === 'number' ? r2.toFixed(4) : '—'}</span>
                                                        </div>
                                                        <div className="pm-submodel-stat">
                                                            <span className="pm-submodel-stat-label">RMSE</span>
                                                            <span className="pm-submodel-stat-value">{typeof rmse2 === 'number' ? (rmse2 / 2).toFixed(4) : '—'}</span>
                                                        </div>
                                                        <div className="pm-submodel-stat">
                                                            <span className="pm-submodel-stat-label">2·RMSE</span>
                                                            <span className="pm-submodel-stat-value">{typeof rmse2 === 'number' ? rmse2.toFixed(4) : '—'}</span>
                                                        </div>
                                                        <div className="pm-submodel-stat">
                                                            <span className="pm-submodel-stat-label">N</span>
                                                            <span className="pm-submodel-stat-value">{fit.result.predicted.length.toLocaleString()}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="pm-submodel-chart">
                                                    {opt ? (
                                                        <ResponsiveECharts option={opt} style={{ height: '280px', minHeight: '280px' }} />
                                                    ) : (
                                                        <div className="plot-placeholder pm-chart-placeholder">
                                                            <Activity size={32} style={{ opacity: 0.2 }} />
                                                            <p>No data to render</p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
