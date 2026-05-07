import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join as pathJoin } from "@tauri-apps/api/path";
import { CsvMetadata, CsvRecord, ProcessedData, SensorMetadata, DashboardSnapshot, PredictiveModelStateSlice } from "../../types";
import type {
    RelationshipPreviewResult,
    ClusteringPreview,
    IndividualModelInfo,
    ClusteringModelInfo,
    RelationshipTrainResult,
} from "../../types/commands";
import { Check, Activity, GitBranch, Layers, Minus, Square, Search, X, Calendar, ChevronLeft, ChevronRight, Thermometer, Loader2 } from "lucide-react";
import { useIsMacOS } from "../../hooks/useIsMacOS";
import { useSubWindowMenu } from "../../hooks/useSubWindowMenu";
import { updateWorkspaceData, loadWorkspaceData } from "../../workspaceManager";
import LineChart from "../charts/LineChart";
import ResponsiveECharts from "../charts/ResponsiveECharts";
import { ChartMarkLine } from "../charts/ChartTypes";

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
interface SensorAutocompleteProps {
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

function SensorAutocomplete({
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

interface PredictiveModelData {
    workspaceId: string;
    targetSensor: string;
    predictorSensors: string[];
    sensorHeaders: string[];
    sensorMetadata: SensorMetadata[] | null;
    metadata: CsvMetadata;
    dashboardSnapshot?: DashboardSnapshot;
}



export default function PredictiveModelBuild() {
    const isMacOS = useIsMacOS();
    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    const [dashboardSnapshot, setDashboardSnapshot] = useState<DashboardSnapshot | null>(null);
    const hydratedRef = useRef(false);
    // Data from previous page
    const [targetSensor, setTargetSensor] = useState<string>("");
    const [predictorSensors, setPredictorSensors] = useState<string[]>([]);
    const [allSensors, setAllSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [loading, setLoading] = useState(true);

    // Plot mode — Individual is an independent toggle; Relationship/Clustering are mutually exclusive
    const [individualChecked, setIndividualChecked] = useState(true);
    const [rcMode, setRcMode] = useState<'relationship' | 'clustering' | null>(null);

    const toggleIndividual = () => setIndividualChecked(v => !v);
    const toggleRc = (m: 'relationship' | 'clustering') => setRcMode(prev => prev === m ? null : m);

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
    const [relStiffness, setRelStiffness] = useState<number>(1);

    // Clustering Model Config
    const [clusterModelName, setClusterModelName] = useState("");
    const [numClusters, setNumClusters] = useState<number>(3);
    const [criteriaSensor, setCriteriaSensor] = useState<string>("");
    const [clusterRangeMin, setClusterRangeMin] = useState<number>(0);
    const [clusterRangeMax, setClusterRangeMax] = useState<number>(100);

    // Data Filter
    const [filterTimeStart, setFilterTimeStart] = useState("");
    const [filterTimeEnd, setFilterTimeEnd] = useState("");
    const [filterSensorValue, setFilterSensorValue] = useState("");

    // Model Stats — computed on Rust side over ALL rows of the target sensor.
    const [targetStats, setTargetStats] = useState<SensorStats | null>(null);
    const [statsError, setStatsError] = useState<string | null>(null);

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

    // Clustering preview result + status.
    const [clusteringPreview, setClusteringPreview] = useState<ClusteringPreview | null>(null);
    const [clusteringLoading, setClusteringLoading] = useState(false);
    const [clusteringError, setClusteringError] = useState<string | null>(null);

    // Save flow status.
    const [saveStatus, setSaveStatus] = useState<{ kind: 'idle' | 'saving' | 'success' | 'error'; message?: string }>({ kind: 'idle' });

    // ── Target sensor time-series (for Individual plot) ────────────────
    const [targetChartData, setTargetChartData] = useState<{ headers: string[]; rows: CsvRecord[] }>({ headers: [], rows: [] });
    const [targetChartLoading, setTargetChartLoading] = useState(false);
    const targetFetchIdRef = useRef(0);

    useEffect(() => {
        const theme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);

        let unlistenData: (() => void) | undefined;

        const setup = async () => {
            unlistenData = await listen<PredictiveModelData>('predictive-model-data', async (event) => {
                console.log("Received predictive-model-data:", event.payload);
                const d = event.payload;
                setWorkspaceId(d.workspaceId);
                setAllSensors(d.sensorHeaders);
                setSensorMetadata(d.sensorMetadata);
                if (d.dashboardSnapshot) setDashboardSnapshot(d.dashboardSnapshot);

                // Hydrate model config from workspace if a slice exists; otherwise fall back to incoming payload.
                let slice: PredictiveModelStateSlice | undefined;
                try {
                    const ws = await loadWorkspaceData(d.workspaceId);
                    slice = ws?.predictiveModelState;
                    if (ws?.dashboardSnapshot && !d.dashboardSnapshot) setDashboardSnapshot(ws.dashboardSnapshot);
                } catch (e) {
                    console.warn('Failed to hydrate predictive-model state from workspace:', e);
                }

                const effectiveTarget = slice?.targetSensor || d.targetSensor;
                const effectivePredictors = slice?.predictorSensors ?? d.predictorSensors;
                setTargetSensor(effectiveTarget);
                setPredictorSensors(effectivePredictors);
                if (slice) {
                    setIndividualChecked(slice.individualChecked);
                    setRcMode(slice.rcMode);
                    setScatterXSensor(slice.scatterXSensor || (effectivePredictors[0] ?? ''));
                    setRelModelName(slice.relModelName);
                    setRelStiffness(slice.relStiffness);
                    setClusterModelName(slice.clusterModelName);
                    setNumClusters(slice.numClusters);
                    setCriteriaSensor(slice.criteriaSensor);
                    setClusterRangeMin(slice.clusterRangeMin);
                    setClusterRangeMax(slice.clusterRangeMax);
                    setFilterTimeStart(slice.filterTimeStart);
                    setFilterTimeEnd(slice.filterTimeEnd);
                    setFilterSensorValue(slice.filterSensorValue);
                } else if (effectivePredictors.length > 0) {
                    setScatterXSensor(effectivePredictors[0]);
                }

                hydratedRef.current = true;
                setLoading(false);
            });

            // Request data from opener
            await emit('request-predictive-data');
        };

        setup();

        return () => {
            if (unlistenData) unlistenData();
        };
    }, []);

    // Persist predictive-model slice back into the workspace file on change.
    useEffect(() => {
        if (!workspaceId || !hydratedRef.current) return;
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
                clusterRangeMin,
                clusterRangeMax,
                filterTimeStart,
                filterTimeEnd,
                filterSensorValue,
            };
            updateWorkspaceData(workspaceId, (prev) => ({
                ...prev,
                lastRoute: 'predictive-model',
                predictiveModelState: slice,
            })).catch(e => console.error('Failed to persist predictive-model state:', e));
        }, 250);
        return () => clearTimeout(timer);
    }, [
        workspaceId, targetSensor, predictorSensors, individualChecked, rcMode, scatterXSensor,
        relModelName, relStiffness, clusterModelName, numClusters, criteriaSensor,
        clusterRangeMin, clusterRangeMax, filterTimeStart, filterTimeEnd, filterSensorValue,
    ]);

    // Fetch target-sensor time-series whenever targetSensor changes.
    // Uses the same invoke/event-stream pattern as Dashboard.
    useEffect(() => {
        if (!targetSensor) {
            setTargetChartData({ headers: [], rows: [] });
            setTargetChartLoading(false);
            return;
        }

        const myFetchId = ++targetFetchIdRef.current;
        let unlistenChunk: (() => void) | undefined;
        let unlistenEnd: (() => void) | undefined;
        let cancelled = false;

        const run = async () => {
            setTargetChartLoading(true);
            const accumRows: CsvRecord[] = [];
            let headers: string[] = [];

            try {
                let resolveDone: () => void;
                const streamDone = new Promise<void>((r) => { resolveDone = r; });

                unlistenChunk = await listen<ProcessedData>('data-stream-chunk', (event) => {
                    if (targetFetchIdRef.current !== myFetchId) return;
                    const chunk = event.payload;
                    if (headers.length === 0) headers = chunk.headers;
                    accumRows.push(...chunk.rows);
                });

                unlistenEnd = await listen('data-stream-end', () => {
                    if (targetFetchIdRef.current === myFetchId) resolveDone();
                });

                await invoke("get_data", { sensors: [targetSensor] });
                await streamDone;

                if (cancelled || targetFetchIdRef.current !== myFetchId) return;
                setTargetChartData({
                    headers: headers.length > 0 ? headers : [targetSensor],
                    rows: accumRows,
                });
            } catch (err) {
                if (targetFetchIdRef.current === myFetchId) {
                    console.error("Failed to fetch target sensor data:", err);
                }
            } finally {
                if (targetFetchIdRef.current === myFetchId) {
                    setTargetChartLoading(false);
                }
            }
        };

        run();

        return () => {
            cancelled = true;
            if (unlistenChunk) unlistenChunk();
            if (unlistenEnd) unlistenEnd();
        };
    }, [targetSensor]);

    // Compute mean / sd / 1σ / 3σ of the target sensor on the Rust side.
    useEffect(() => {
        if (!targetSensor) {
            setTargetStats(null);
            setStatsError(null);
            return;
        }
        let cancelled = false;
        invoke<SensorStats>("compute_sensor_stats", { sensor: targetSensor })
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
    }, [targetSensor]);

    // Track theme so the Mean markLine stays visible in both dark & light modes.
    const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() =>
        (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark'
    );
    useEffect(() => {
        const obs = new MutationObserver(() => {
            const t = document.documentElement.getAttribute('data-theme');
            setThemeMode(t === 'light' ? 'light' : 'dark');
        });
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => obs.disconnect();
    }, []);
    const meanColor = themeMode === 'light' ? '#0f172a' : '#f1f5f9';

    // Build markLines for mean / ±1σ / ±3σ to overlay on the LineChart.
    const targetMarkLines: ChartMarkLine[] = targetSensor && targetStats ? [
        { sensor: targetSensor, y: targetStats.mean,   label: 'Mean', color: meanColor,                 lineStyle: 'solid'  },
        { sensor: targetSensor, y: targetStats.upper1, label: '+1σ',  color: '#f59e0b',                 lineStyle: 'solid'  },
        { sensor: targetSensor, y: targetStats.lower1, label: '−1σ',  color: '#f59e0b',                 lineStyle: 'solid'  },
        { sensor: targetSensor, y: targetStats.upper3, label: '+3σ',  color: '#f43f5e',                 lineStyle: 'dashed' },
        { sensor: targetSensor, y: targetStats.lower3, label: '−3σ',  color: '#f43f5e',                 lineStyle: 'dashed' },
    ] : [];

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

    // Build the dashboard-filter payload sent to `preview_relationship_model`.
    // The relationship preview must be computed off the same filtered slice
    // the user saw on the dashboard, so any timestamp / value filter set
    // there flows through to the (X, y) construction on the Rust side.
    // Returns `null` when no filter is active — Rust then falls back to
    // "use every row" (legacy behavior).
    const dashboardFilterPayload = useMemo(() => {
        const f = dashboardSnapshot?.filters;
        if (!f) return null;
        const valueFilters = (f.sensorFilters ?? [])
            .filter(sf => sf.value1 !== '')
            .map(sf => ({
                sensor: sf.sensor,
                operation: sf.operation,
                value1: sf.value1 !== '' ? parseFloat(sf.value1) : null,
                value2: sf.value2 !== '' ? parseFloat(sf.value2) : null,
            }));
        const tsStart = f.timestampStart || null;
        const tsEnd = f.timestampEnd || null;
        if (!tsStart && !tsEnd && valueFilters.length === 0) return null;
        return {
            timestamp_start: tsStart,
            timestamp_end: tsEnd,
            value_filters: valueFilters,
        };
    }, [dashboardSnapshot]);

    // Stable string key used to detect filter changes for cache invalidation
    // without re-running effects on identical-but-new object references.
    const dashboardFilterKey = useMemo(
        () => JSON.stringify(dashboardFilterPayload),
        [dashboardFilterPayload],
    );

    // Invalidate the cached fit whenever the regression target, the smoothness
    // parameter, or the dashboard filter changes — any of those produce a
    // different (target, lambda, sample) triple, so the prior fit is no
    // longer comparable. Adding/removing a predictor does NOT invalidate;
    // the old fit stays plotted until the user hits Apply.
    useEffect(() => {
        setRelPreview(null);
        setRelError(null);
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

        const isLight = themeMode === 'light';
        const txtPrimary    = isLight ? '#0f172a' : '#f1f5f9';
        const txtSecondary  = isLight ? '#475569' : '#94a3b8';
        const gridLine      = isLight ? '#cbd5e1' : '#334155';
        const tooltipBg     = isLight ? 'rgba(248,250,252,0.96)' : 'rgba(30,41,59,0.95)';
        const tooltipBorder = isLight ? '#cbd5e1' : '#334155';

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
    }, [relPreview, effectiveScatterX, targetSensor, themeMode]);

    // Shake animation when FailureGroup tries to close
    const containerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let unlistenShake: (() => void) | undefined;
        const setupShake = async () => {
            unlistenShake = await listen('predictive-model-shake', () => {
                if (containerRef.current) {
                    containerRef.current.classList.add('window-shake');
                    setTimeout(() => {
                        containerRef.current?.classList.remove('window-shake');
                    }, 500);
                }
            });
        };
        setupShake();
        return () => { if (unlistenShake) unlistenShake(); };
    }, []);

    // No `onCloseRequested` handler — let close proceed unconditionally.
    // FG already listens for `tauri://destroyed` on the WebviewWindow handle
    // it created when spawning PM, so destruction is signaled regardless of
    // close path (custom button, native red-close, force-quit, crash).

    const handleClose = async () => {
        // The custom-titlebar path (Windows / Linux). Fire-and-forget the emit
        // so a slow/hung IPC channel can't block the actual close call.
        emit('predictive-model-closed').catch(() => { /* ignore */ });
        try { await getCurrentWindow().close(); } catch { /* ignore */ }
    };

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
            console.log("Multivariate relationship preview updated:", {
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

    const handleRelationshipApply = () => {
        if (!targetSensor) {
            setRelError("Target sensor is required.");
            return;
        }
        if (predictorSensors.length === 0) {
            setRelError("Select at least one predictor.");
            return;
        }
        setRelError(null);
        runRelationshipFit();
    };

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
        // Phase 4 supports n_clusters == 1 only.
        const effectiveClusters = criteriaSensor ? numClusters : 1;
        if (effectiveClusters !== 1) {
            setClusteringError("Multi-cluster not yet supported in Rust port. Clear the criteria sensor or set Number of Clusters to 1.");
            return;
        }

        setClusteringLoading(true);
        setClusteringError(null);
        try {
            const result = await invoke<ClusteringPreview>("compute_clustering_preview", {
                first_sensor: firstSensor,
                second_sensor: targetSensor,
                n_clusters: 1,
            });
            setClusteringPreview(result);
            console.log("Clustering preview:", result);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setClusteringError(msg);
            setClusteringPreview(null);
            console.error("compute_clustering_preview failed:", e);
        } finally {
            setClusteringLoading(false);
        }
    };

    /** Build the on-disk save_path for the current workspace. */
    const resolveSavePath = async (): Promise<string> => {
        if (!workspaceId) throw new Error("No workspace loaded.");
        const root = await appDataDir();
        return await pathJoin(root, "workspaces", workspaceId);
    };

    const handleSaveModel = async () => {
        if (!targetSensor) {
            setSaveStatus({ kind: 'error', message: 'Select a target sensor first.' });
            return;
        }
        setSaveStatus({ kind: 'saving' });
        try {
            const savePath = await resolveSavePath();
            const written: string[] = [];

            if (individualChecked) {
                const info = await invoke<IndividualModelInfo>("train_individual_model", {
                    target: targetSensor,
                    model_name: null,
                    save_path: savePath,
                });
                written.push(`Individual → ${info.saved_path}`);
            }

            if (rcMode === 'relationship') {
                if (predictorSensors.length === 0) {
                    throw new Error("Relationship mode requires at least one predictor.");
                }
                const trained = await invoke<RelationshipTrainResult>("train_relationship_model", {
                    predictors: predictorSensors,
                    target: targetSensor,
                    lambda: relStiffness,
                    save_path: savePath,
                    model_name: relModelName.trim() || null,
                });
                written.push(`Relationship → ${trained.info_path}`);
            }

            if (rcMode === 'clustering') {
                const firstSensor = scatterXSensor || predictorSensors[0] || "";
                if (!firstSensor) throw new Error("Clustering mode requires a predictor on the X-axis.");
                const effectiveClusters = criteriaSensor ? numClusters : 1;
                if (effectiveClusters !== 1) {
                    throw new Error("Clustering mode only supports n_clusters=1 for now.");
                }
                const trained = await invoke<ClusteringModelInfo>("train_clustering_model", {
                    first_sensor: firstSensor,
                    second_sensor: targetSensor,
                    n_clusters: 1,
                    model_name: clusterModelName.trim() || null,
                    save_path: savePath,
                });
                written.push(`Clustering → ${trained.saved_path}`);
            }

            if (written.length === 0) {
                setSaveStatus({ kind: 'error', message: 'Nothing to save — toggle Individual / Relationship / Clustering first.' });
                return;
            }
            setSaveStatus({ kind: 'success', message: written.join('\n') });
            console.log("Save model success:", written);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setSaveStatus({ kind: 'error', message: msg });
            console.error("Save model failed:", e);
        }
    };

    useSubWindowMenu({
        workspaceId,
        localSaveLabel: 'Save Model',
        onLocalSave: () => handleSaveModel(),
        onToggleTheme: () => {
            const current = localStorage.getItem('theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            localStorage.setItem('theme', next);
            document.documentElement.setAttribute('data-theme', next);
        },
    });

    if (loading) {
        return (
            <div className="predictive-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>Loading model data...</div>
            </div>
        );
    }

    return (
        <div className="predictive-container" ref={containerRef}>
            {/* Title Bar — only render custom bar when OS doesn't provide native decorations */}
            {!isMacOS && (
                <div data-tauri-drag-region className="predictive-titlebar">
                    <h2 className="predictive-title">Predictive Mode — Model Build</h2>
                    <div className="predictive-titlebar-actions">
                        <button className="predictive-window-btn" onClick={() => getCurrentWindow().minimize()} title="Minimize">
                            <Minus size={14} />
                        </button>
                        <button className="predictive-window-btn" onClick={() => getCurrentWindow().toggleMaximize()} title="Maximize">
                            <Square size={12} />
                        </button>
                        <button onClick={handleClose} className="predictive-close-btn">&times;</button>
                    </div>
                </div>
            )}

            {/* Command bar */}
            <div className="pm-commandbar">
                <button className="pm-back-btn" title="Back"><ChevronLeft size={16} /></button>
                <div className="pm-breadcrumb">
                    <span className="pm-crumb-eyebrow">Workspace</span>
                    <ChevronRight size={12} className="pm-crumb-sep" />
                    <span className="pm-crumb-muted">Predictive</span>
                    <ChevronRight size={12} className="pm-crumb-sep" />
                    <span className="pm-crumb-current">{targetSensor || 'Model'}</span>
                </div>
                <span className="pm-step-pill">Step 3 of 3</span>
                <div className="pm-flex-spacer" />
                <button className="pm-btn pm-btn-secondary">Preview</button>
                <button className="pm-btn pm-btn-primary" onClick={handleSaveModel}>
                    <Check size={13} />
                    <span>Save Model</span>
                </button>
            </div>

            {/* Main Content */}
            <div className="predictive-body pm-grid">
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

                    {/* Predictors */}
                    <div className="pm-section">
                        <div className="pm-section-header">
                            <span className="pm-eyebrow">Inputs</span>
                            <span className="pm-section-title">Predictor sensors</span>
                            <span className="pm-count-pill">{predictorSensors.length}</span>
                        </div>
                        <div className="pm-section-hint">Select sensors whose history informs the target. Multi-select.</div>
                        <SensorAutocomplete
                            sensors={allSensors}
                            getDesc={getDesc}
                            value=""
                            onSelect={(tag) => { if (tag) handlePredictorToggle(tag); }}
                            placeholder="Search sensor tag or description..."
                            excluded={predictorSensors}
                            clearOnSelect
                        />
                        {predictorSensors.length > 0 && (
                            <div className="predictor-tags" style={{ marginTop: '0.6rem' }}>
                                {predictorSensors.map(s => {
                                    const d = getDesc(s);
                                    return (
                                        <span key={s} className="predictor-tag" title={d}>
                                            <span className="predictor-tag-main">
                                                <span className="predictor-tag-name">{s}</span>
                                                {d && <span className="predictor-tag-desc">{d}</span>}
                                            </span>
                                            <button onClick={() => handlePredictorToggle(s)}>&times;</button>
                                        </span>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Data filter */}
                    <div className="pm-section">
                        <div className="pm-section-header">
                            <span className="pm-eyebrow">Scope</span>
                            <span className="pm-section-title">Data filter</span>
                        </div>
                        <div className="filter-row">
                            <label>Time start</label>
                            <div className="date-input-wrapper">
                                <Calendar size={14} />
                                <input
                                    type="datetime-local"
                                    value={filterTimeStart}
                                    onChange={e => setFilterTimeStart(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className="filter-row">
                            <label>Time end</label>
                            <div className="date-input-wrapper">
                                <Calendar size={14} />
                                <input
                                    type="datetime-local"
                                    value={filterTimeEnd}
                                    onChange={e => setFilterTimeEnd(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className="filter-row">
                            <label>Sensor value</label>
                            <input type="text" value={filterSensorValue} onChange={e => setFilterSensorValue(e.target.value)} placeholder="e.g. > 50" className="config-input" />
                        </div>
                    </div>
                </div>

                {/* CENTER */}
                <div className="pm-col-center">
                    {/* Toggle pills + axis info */}
                    <div className="pm-mode-row">
                        <div className="pm-segmented">
                            <button
                                className={`pm-segmented-btn ${individualChecked ? 'active' : ''}`}
                                onClick={toggleIndividual}
                                title="Toggle Individual plot"
                            >
                                <Activity size={13} />
                                <span>Individual</span>
                            </button>
                        </div>
                        <div className="pm-segmented">
                            <button
                                className={`pm-segmented-btn ${rcMode === 'relationship' ? 'active' : ''}`}
                                onClick={() => toggleRc('relationship')}
                            >
                                <GitBranch size={13} />
                                <span>Relationship</span>
                            </button>
                            <button
                                className={`pm-segmented-btn ${rcMode === 'clustering' ? 'active' : ''}`}
                                onClick={() => toggleRc('clustering')}
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
                                </div>
                                <div className="pm-chart-body">
                                    {!targetSensor ? (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            <Activity size={48} style={{ opacity: 0.2 }} />
                                            <p>No target sensor selected</p>
                                            <p className="plot-placeholder-sub">Pick a target sensor on the previous page</p>
                                        </div>
                                    ) : targetChartLoading && targetChartData.rows.length === 0 ? (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            <Loader2 size={36} style={{ opacity: 0.45 }} className="pm-spin" />
                                            <p>Loading {targetSensor}…</p>
                                        </div>
                                    ) : targetChartData.rows.length === 0 ? (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            <Activity size={48} style={{ opacity: 0.2 }} />
                                            <p>No data available for {targetSensor}</p>
                                        </div>
                                    ) : (
                                        <LineChart
                                            data={targetChartData.rows}
                                            sensors={[targetSensor]}
                                            headers={targetChartData.headers}
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
                                                ? `Raw (blue) vs. LinearGAM model output (red) — pick a predictor for the X-axis${dashboardFilterPayload ? ' · using Dashboard filter' : ''}`
                                                : 'K-means clustering'}
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
                                </div>
                                {/* Inline progress bar — shown only while a relationship fit
                                    is in flight. Indeterminate (sliding) when the batch is a
                                    single predictor, determinate (current/total) otherwise. */}
                                {rcMode === 'relationship' && relLoading && (
                                    <div className="pm-progress">
                                        <div className="pm-progress-track">
                                            {relFitProgress && relFitProgress.total > 1 ? (
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
                                            {relFitProgress && relFitProgress.total > 1
                                                ? `Fitting predictor ${Math.min(relFitProgress.current + 1, relFitProgress.total)} of ${relFitProgress.total}…`
                                                : 'Running LinearGAM…'}
                                        </div>
                                    </div>
                                )}
                                <div className="pm-chart-body" style={{ position: 'relative' }}>
                                    {rcMode === 'relationship' && relScatterOption ? (
                                        <ResponsiveECharts option={relScatterOption} style={{ minHeight: '200px' }} />
                                    ) : rcMode === 'relationship' && relLoading ? (
                                        <div className="plot-placeholder pm-chart-placeholder">
                                            <Loader2 size={36} style={{ opacity: 0.45 }} className="pm-spin" />
                                            <p>Running LinearGAM…</p>
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

                {/* RIGHT - Selected predictors + context config */}
                <div className="pm-col-right">
                    {/* Selected predictor chips */}
                    <div className="pm-section">
                        <div className="pm-section-header">
                            <span className="pm-eyebrow">Selected</span>
                            <span className="pm-section-title">Predictors</span>
                            <span className="pm-count-pill">{predictorSensors.length}</span>
                        </div>
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

                    {/* Relationship Model Config */}
                    <div className={`pm-section pm-config-block ${rcMode === 'relationship' ? '' : 'pm-config-dim'}`}>
                        <div className="pm-section-header">
                            <span className="pm-eyebrow">Configure</span>
                            <span className="pm-section-title">Relationship Model</span>
                            <button
                                className="pm-btn pm-btn-primary pm-btn-sm"
                                onClick={handleRelationshipApply}
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
                                <input
                                    type="number"
                                    value={relStiffness}
                                    onChange={e => setRelStiffness(Number(e.target.value))}
                                    className="config-input"
                                    min={0}
                                    step={0.1}
                                    disabled={rcMode !== 'relationship'}
                                />
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

                    {/* Clustering Model Config */}
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
                        <div className="pm-fields">
                            <div className="filter-row">
                                <label>Model Name</label>
                                <input
                                    type="text"
                                    value={clusterModelName}
                                    onChange={e => setClusterModelName(e.target.value)}
                                    placeholder="Optional"
                                    className="config-input"
                                    disabled={rcMode !== 'clustering'}
                                />
                            </div>
                            <div className="filter-row">
                                <label>Number of Clusters</label>
                                <input
                                    type="number"
                                    value={numClusters}
                                    onChange={e => setNumClusters(Number(e.target.value))}
                                    className="config-input"
                                    min={1}
                                    disabled={rcMode !== 'clustering'}
                                />
                            </div>
                            <div className="filter-row">
                                <label>Criteria Sensor</label>
                                <SensorAutocomplete
                                    sensors={allSensors}
                                    getDesc={getDesc}
                                    value={criteriaSensor}
                                    onSelect={setCriteriaSensor}
                                    placeholder="None (1 cluster)"
                                    allowNone
                                    disabled={rcMode !== 'clustering'}
                                />
                            </div>
                            <div className="filter-row">
                                <label>Clustering Range</label>
                                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                    <input
                                        type="number"
                                        value={clusterRangeMin}
                                        onChange={e => setClusterRangeMin(Number(e.target.value))}
                                        className="config-input"
                                        style={{ width: '80px' }}
                                        disabled={rcMode !== 'clustering'}
                                    />
                                    <span style={{ color: 'var(--text-secondary)' }}>to</span>
                                    <input
                                        type="number"
                                        value={clusterRangeMax}
                                        onChange={e => setClusterRangeMax(Number(e.target.value))}
                                        className="config-input"
                                        style={{ width: '80px' }}
                                        disabled={rcMode !== 'clustering'}
                                    />
                                </div>
                            </div>
                            {clusteringError && (
                                <div className="filter-row" style={{ color: '#f43f5e', fontSize: 12 }}>
                                    {clusteringError}
                                </div>
                            )}
                            {clusteringPreview && !clusteringError && (
                                <div className="filter-row" style={{ flexDirection: 'column', alignItems: 'stretch', color: 'var(--text-secondary)', fontSize: 12, gap: 2 }}>
                                    <div>Fit on {clusteringPreview.n_rows.toLocaleString()} rows</div>
                                    <div>center: ({clusteringPreview.ellipse.x_center.toFixed(3)}, {clusteringPreview.ellipse.y_center.toFixed(3)})</div>
                                    <div>σ: {clusteringPreview.ellipse.x_sd.toFixed(3)} × {clusteringPreview.ellipse.y_sd.toFixed(3)}</div>
                                    <div>angle: {clusteringPreview.ellipse.angle_deg.toFixed(2)}°</div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Save status */}
                    {saveStatus.kind !== 'idle' && (
                        <div className="pm-section">
                            <div className="pm-section-header">
                                <span className="pm-eyebrow">Save</span>
                                <span className="pm-section-title">Status</span>
                            </div>
                            <div
                                className="pm-fields"
                                style={{
                                    fontSize: 12,
                                    color: saveStatus.kind === 'error' ? '#f43f5e'
                                        : saveStatus.kind === 'success' ? '#10b981'
                                        : 'var(--text-secondary)',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                }}
                            >
                                {saveStatus.kind === 'saving' ? 'Saving…' : (saveStatus.message ?? '')}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
