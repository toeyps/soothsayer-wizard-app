import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CsvMetadata, CsvRecord, ProcessedData, SensorMetadata, DashboardSnapshot, PredictiveModelStateSlice, PredictiveClusterRange } from "../../types";
import type {
    RelationshipPreviewResult,
    ClusteringPreview,
    IndividualModelInfo,
    ClusteringModelInfo,
    RelationshipTrainResult,
} from "../../types/commands";
import { Check, Activity, GitBranch, Layers, Minus, Plus, Square, Search, X, Calendar, ChevronLeft, ChevronRight, Thermometer, Loader2, Maximize2, LayoutGrid } from "lucide-react";
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

    // Clustering preview result + status.
    const [clusteringPreview, setClusteringPreview] = useState<ClusteringPreview | null>(null);
    const [clusteringLoading, setClusteringLoading] = useState(false);
    const [clusteringError, setClusteringError] = useState<string | null>(null);

    // Save flow status.
    const [saveStatus, setSaveStatus] = useState<{
        kind: 'idle' | 'saving' | 'success' | 'error';
        message?: string;
        /** Which model is currently being trained — surfaced in the blocking
         *  save overlay so the user sees concrete progress instead of a
         *  generic spinner. Set transiently inside `handleSaveModel` right
         *  before each `invoke('train_*_model')` call. */
        step?: 'individual' | 'relationship' | 'clustering';
    }>({ kind: 'idle' });
    // Last folder the user picked in the Save Model dialog. Acts as the
    // `defaultPath` for the next picker invocation, and is persisted into the
    // workspace JSON (`WorkspaceState.outputDir`) so the choice survives app
    // restarts. We always still open the picker — this never bypasses it.
    const [outputDir, setOutputDir] = useState<string | null>(null);

    // ── Target sensor time-series (for Individual plot) ────────────────
    const [targetChartData, setTargetChartData] = useState<{ headers: string[]; rows: CsvRecord[] }>({ headers: [], rows: [] });
    const [targetChartLoading, setTargetChartLoading] = useState(false);
    const targetFetchIdRef = useRef(0);

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

    // ── Preview modal ─────────────────────────────────────────────────
    // Mirrors the wizard.py `PreviewModel.{individual, relationship,
    // clustering}` outputs in a single modal so the user can sanity-check
    // the preview payload BEFORE committing to disk via Save Model
    // (`SaveThisSensor` in wizard.py). Opens via the toolbar's Preview
    // button. Pure read-only — no disk I/O happens here.
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    useEffect(() => {
        if (!previewOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setPreviewOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [previewOpen]);

    // ESC key closes the sub-models modal (parallels expandedChart /
    // previewOpen). Listener is only attached while the modal is open
    // so unrelated key presses don't pay for it.
    useEffect(() => {
        if (!subModelsOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSubModelsOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [subModelsOpen]);

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
                    // Hydrate the remembered save folder so the next picker
                    // defaults to wherever the user last picked.
                    if (ws?.outputDir) setOutputDir(ws.outputDir);
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
                clusterRanges,
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
        clusterRanges, filterTimeStart, filterTimeEnd, filterSensorValue,
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

    // Keep `clusterRanges` in sync with `numClusters` so the array
    // always has exactly N entries. When the user steps the count up
    // we extrapolate from the last existing range (continuing its
    // width); when they step down we just slice the tail off, preserving
    // any edits the user made to the head ranges.
    useEffect(() => {
        setClusterRanges((prev) => {
            if (prev.length === numClusters) return prev;
            if (numClusters <= 0) return [];
            if (prev.length === 0) {
                // Bootstrap with N equal segments over [0, 100] — same shape
                // the initial useState default uses.
                const step = 100 / numClusters;
                return Array.from({ length: numClusters }, (_, i) => ({
                    min: step * i,
                    max: step * (i + 1),
                }));
            }
            if (numClusters < prev.length) {
                return prev.slice(0, numClusters);
            }
            // Growing: append new ranges starting where the last one ended.
            const last = prev[prev.length - 1];
            const width =
                last.min !== null && last.max !== null && last.max > last.min
                    ? last.max - last.min
                    : 33;
            const next = [...prev];
            let cursor = last.max ?? (last.min ?? 0);
            for (let i = prev.length; i < numClusters; i++) {
                const start = cursor;
                const end = cursor + width;
                next.push({ min: start, max: end });
                cursor = end;
            }
            return next;
        });
    }, [numClusters]);

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

    // Min / max timestamp of the loaded target-sensor series. Used as the
    // default value (and as the picker's `min` / `max` constraint) for the
    // Data-filter date pickers, so the user starts on a valid range.
    const targetDataRange = useMemo<{ min: string; max: string } | null>(() => {
        const rows = targetChartData.rows;
        if (rows.length === 0) return null;
        let minTs: string | null = null;
        let maxTs: string | null = null;
        for (const r of rows) {
            const ts = r.timestamp;
            if (!ts) continue;
            if (minTs === null || ts < minTs) minTs = ts;
            if (maxTs === null || ts > maxTs) maxTs = ts;
        }
        if (!minTs || !maxTs) return null;
        return { min: minTs, max: maxTs };
    }, [targetChartData]);

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

    /**
     * Per-cluster palette — palette mirrors the multi-series colour set
     * used elsewhere in the app (LineChart). Cycles when there are more
     * clusters than colours.
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

    const clusteringScatterOption = useMemo(() => {
        if (!clusteringPreview) return null;
        const { first_sensor, second_sensor, clusters, n_rows } = clusteringPreview;
        if (!clusters || clusters.length === 0 || n_rows === 0) return null;

        const isLight = themeMode === 'light';
        const txtPrimary    = isLight ? '#0f172a' : '#f1f5f9';
        const txtSecondary  = isLight ? '#475569' : '#94a3b8';
        const gridLine      = isLight ? '#cbd5e1' : '#334155';
        const tooltipBg     = isLight ? 'rgba(248,250,252,0.96)' : 'rgba(30,41,59,0.95)';
        const tooltipBorder = isLight ? '#cbd5e1' : '#334155';

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
    }, [clusteringPreview, themeMode]);

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
            setSubModels(results);
            console.log("Sub-model fits complete:", results.map(r => ({
                predictors: r.predictors,
                rows: r.result.predicted.length,
                r2: r.result.r2_per_step[r.result.r2_per_step.length - 1],
            })));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setSubModelsError(msg);
            console.error("runSubModelFits failed:", e);
        } finally {
            setSubModelsLoading(false);
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
    }, [themeMode, targetSensor]);

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

    /**
     * Open the Preview modal and lazily refresh any stale fits.
     *
     * The modal mirrors the per-mode return shapes from `wizard.py` —
     * `PreviewModel.individual`, `PreviewModel.relationship`,
     * `PreviewModel.clustering` — so the user can review the preview
     * payload before committing to disk via Save Model. Crucially, this
     * does NOT write anything; it just lays out cached state in the
     * wizard.py shape.
     *
     *   • Individual: target stats are auto-fetched on `targetSensor`
     *     change (via `compute_sensor_stats`), so nothing to do here.
     *   • Relationship: re-fit only if no cache OR if predictor list has
     *     drifted since last Apply (`fitIsStale`).
     *   • Clustering: re-fit only if no cache.
     *
     * State updates from `runRelationshipFit` / `handleClusteringApply`
     * propagate normally — the modal renders skeletons while loading and
     * fills in as the results land.
     */
    const handleOpenPreview = () => {
        setPreviewError(null);
        setPreviewOpen(true);

        if (!targetSensor) return;

        if (rcMode === 'relationship' && predictorSensors.length > 0 && !relLoading) {
            if (!relPreview || fitIsStale) {
                runRelationshipFit();
            }
        }
        if (rcMode === 'clustering' && !clusteringLoading && !clusteringPreview) {
            // Fire-and-forget — handleClusteringApply manages its own state.
            handleClusteringApply();
        }
    };

    /** Prompt the user to pick the on-disk root folder for the save (the
     *  `saved_path` in the wizard payload). Output files land under
     *  `{savePath}/output/{target}/...` — see `train_*_model` in `lib.rs`.
     *
     *  Returns the chosen absolute path, or `null` if the user cancelled.
     *  Side-effect: persists the choice to `WorkspaceState.outputDir` so the
     *  next picker invocation defaults to the same folder.
     */
    const pickSavePath = async (): Promise<string | null> => {
        if (!workspaceId) throw new Error("No workspace loaded.");
        const picked = await openDialog({
            directory: true,
            multiple: false,
            // Default to the last-used folder when available, otherwise let
            // the OS decide (typically the user's home dir).
            defaultPath: outputDir ?? undefined,
            title: 'Choose Save Folder',
        });
        if (typeof picked !== 'string' || !picked) return null;
        // Remember the choice immediately, even if the train calls fail —
        // the user's intent ("save into X") is independent of the model
        // training outcome.
        setOutputDir(picked);
        try {
            await updateWorkspaceData(workspaceId, (prev) => ({
                ...prev,
                outputDir: picked,
            }));
        } catch (e) {
            console.warn('Failed to persist outputDir to workspace:', e);
        }
        return picked;
    };

    const handleSaveModel = async () => {
        if (!targetSensor) {
            setSaveStatus({ kind: 'error', message: 'Select a target sensor first.' });
            return;
        }
        let savePath: string;
        try {
            const picked = await pickSavePath();
            if (picked === null) {
                // User cancelled — leave saveStatus as-is (don't surface an
                // error; cancellation is a normal flow).
                return;
            }
            savePath = picked;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setSaveStatus({ kind: 'error', message: msg });
            return;
        }
        setSaveStatus({ kind: 'saving' });
        try {
            const written: string[] = [];

            if (individualChecked) {
                setSaveStatus({ kind: 'saving', step: 'individual' });
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
                setSaveStatus({ kind: 'saving', step: 'relationship' });
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
                if (effectiveClusters > 1) {
                    if (!criteriaSensor) {
                        throw new Error("Clustering mode requires a criteria sensor when n_clusters > 1.");
                    }
                    if (clusterRanges.length !== effectiveClusters) {
                        throw new Error(
                            `Cluster ranges length (${clusterRanges.length}) does not match n_clusters (${effectiveClusters}).`,
                        );
                    }
                }
                setSaveStatus({ kind: 'saving', step: 'clustering' });
                const trained = await invoke<ClusteringModelInfo>("train_clustering_model", {
                    first_sensor: firstSensor,
                    second_sensor: targetSensor,
                    n_clusters: effectiveClusters,
                    criteria_sensor: effectiveClusters > 1 ? criteriaSensor : null,
                    cluster_ranges: effectiveClusters > 1 ? clusterRanges.slice(0, effectiveClusters) : null,
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
                <button className="pm-btn pm-btn-secondary" onClick={handleOpenPreview}>Preview</button>
                <button
                    className="pm-btn pm-btn-primary"
                    onClick={handleSaveModel}
                    disabled={saveStatus.kind === 'saving'}
                >
                    {saveStatus.kind === 'saving' ? (
                        <Loader2 size={13} className="animate-spin" />
                    ) : (
                        <Check size={13} />
                    )}
                    <span>{saveStatus.kind === 'saving' ? 'Saving…' : 'Save Model'}</span>
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
                                    value={filterTimeStart || targetMinForInput}
                                    min={targetMinForInput || undefined}
                                    max={targetMaxForInput || undefined}
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
                                    value={filterTimeEnd || targetMaxForInput}
                                    min={targetMinForInput || undefined}
                                    max={targetMaxForInput || undefined}
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

                            {/* Row 3: Per-cluster ranges. One [min, max) interval per
                                cluster on the criteria sensor. Empty inputs map to
                                `null` = "unbounded" (matches Rust's `Option<f64>`
                                edge-cluster semantics). */}
                            <div className="filter-row">
                                <label>
                                    Cluster Ranges
                                    {(numClusters <= 1 || !criteriaSensor) && (
                                        <span className="pm-field-hint-inline"> · requires criteria sensor + N≥2</span>
                                    )}
                                </label>
                                <div className="pm-cluster-ranges">
                                    {clusterRanges.map((range, idx) => {
                                        const color = CLUSTER_PALETTE[idx % CLUSTER_PALETTE.length];
                                        const updateRange = (field: 'min' | 'max', raw: string) => {
                                            // Empty string → null (= unbounded on that side).
                                            const parsed = raw === '' ? null : Number(raw);
                                            const next: PredictiveClusterRange = {
                                                ...range,
                                                [field]: Number.isNaN(parsed as number) ? null : parsed,
                                            };
                                            setClusterRanges(prev => prev.map((r, i) => (i === idx ? next : r)));
                                        };
                                        const inputsDisabled = rcMode !== 'clustering' || numClusters <= 1 || !criteriaSensor;
                                        return (
                                            <div key={idx} className="pm-cluster-range-row">
                                                <span
                                                    className="pm-cluster-range-dot"
                                                    style={{ background: color }}
                                                    title={`Cluster ${idx + 1}`}
                                                />
                                                <span className="pm-cluster-range-label">#{idx + 1}</span>
                                                <input
                                                    type="number"
                                                    value={range.min === null ? '' : range.min}
                                                    onChange={e => updateRange('min', e.target.value)}
                                                    className="config-input pm-range-input-num"
                                                    disabled={inputsDisabled}
                                                    placeholder="min (blank = −∞)"
                                                />
                                                <span className="pm-range-sep">to</span>
                                                <input
                                                    type="number"
                                                    value={range.max === null ? '' : range.max}
                                                    onChange={e => updateRange('max', e.target.value)}
                                                    className="config-input pm-range-input-num"
                                                    disabled={inputsDisabled}
                                                    placeholder="max (blank = +∞)"
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
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
                                                ? 'Raw (blue) vs. LinearGAM model output (red)'
                                                : 'K-means clustering with confidence ellipses'}
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
                            {expandedChart === 'individual' && targetSensor && targetChartData.rows.length > 0 ? (
                                <LineChart
                                    data={targetChartData.rows}
                                    sensors={[targetSensor]}
                                    headers={targetChartData.headers}
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

            {/* ── Preview Modal ────────────────────────────────────────────
                Mirrors `wizard.py`'s `PreviewModel.*` return shapes so the
                user can review the preview payload before Save Model commits
                files to disk (= `wizard.py`'s `SaveThisSensor`). */}
            {previewOpen && (
                <div
                    className="pm-preview-modal-backdrop"
                    onClick={() => setPreviewOpen(false)}
                    role="dialog"
                    aria-modal="true"
                >
                    <div
                        className="pm-preview-modal-card"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="pm-preview-modal-header">
                            <div className="pm-chart-title-block">
                                <div className="pm-chart-title">Model Preview</div>
                                <div className="pm-chart-subtitle">
                                    Review the wizard.py preview output before committing to disk.
                                </div>
                            </div>
                            <button
                                className="pm-chart-modal-close"
                                onClick={() => setPreviewOpen(false)}
                                title="Close (Esc)"
                                aria-label="Close"
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <div className="pm-preview-modal-body">
                            {previewError && (
                                <div className="pm-preview-error">{previewError}</div>
                            )}

                            {!individualChecked && !rcMode && (
                                <div className="pm-preview-empty">
                                    Toggle Individual / Relationship / Clustering on the chart row to preview a model.
                                </div>
                            )}

                            {/* ── PreviewModel.individual ──────────────── */}
                            {individualChecked && (
                                <section className="pm-preview-section">
                                    <header className="pm-preview-section-header">
                                        <div>
                                            <div className="pm-preview-section-title">Individual</div>
                                            <div className="pm-preview-section-sub">
                                                request: <code>PreviewModel/individual</code> · target: <code>{targetSensor || '—'}</code>
                                            </div>
                                        </div>
                                    </header>
                                    {!targetSensor ? (
                                        <div className="pm-preview-empty">No target sensor selected.</div>
                                    ) : !targetStats ? (
                                        <div className="pm-preview-empty">
                                            <Loader2 size={14} className="animate-spin" /> Computing target stats…
                                        </div>
                                    ) : (
                                        <>
                                            <div className="pm-preview-meta">
                                                output_dataframe: <strong>{targetStats.count.toLocaleString()}</strong> rows × <strong>1</strong> col
                                                <span className="pm-preview-meta-faint">({targetSensor})</span>
                                            </div>
                                            <div className="pm-preview-grid">
                                                <div className="pm-preview-stat">
                                                    <span className="pm-preview-stat-label">mean</span>
                                                    <span className="pm-preview-stat-value">{targetStats.mean.toFixed(3)}</span>
                                                </div>
                                                <div className="pm-preview-stat">
                                                    <span className="pm-preview-stat-label">sd</span>
                                                    <span className="pm-preview-stat-value">{targetStats.sd.toFixed(3)}</span>
                                                </div>
                                                <div className="pm-preview-stat">
                                                    <span className="pm-preview-stat-label">1sd_boundary</span>
                                                    <span className="pm-preview-stat-value">[{targetStats.lower1.toFixed(3)}, {targetStats.upper1.toFixed(3)}]</span>
                                                </div>
                                                <div className="pm-preview-stat">
                                                    <span className="pm-preview-stat-label">3sd_boundary</span>
                                                    <span className="pm-preview-stat-value">[{targetStats.lower3.toFixed(3)}, {targetStats.upper3.toFixed(3)}]</span>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </section>
                            )}

                            {/* ── PreviewModel.relationship ────────────── */}
                            {rcMode === 'relationship' && (
                                <section className="pm-preview-section">
                                    <header className="pm-preview-section-header">
                                        <div>
                                            <div className="pm-preview-section-title">Relationship</div>
                                            <div className="pm-preview-section-sub">
                                                request: <code>PreviewModel/relationship</code> · linearGAM_lambda: <code>{relStiffness}</code>
                                            </div>
                                        </div>
                                    </header>
                                    {relLoading ? (
                                        <div className="pm-preview-empty">
                                            <Loader2 size={14} className="animate-spin" /> Running LinearGAM…
                                        </div>
                                    ) : relError ? (
                                        <div className="pm-preview-error">{relError}</div>
                                    ) : !relPreview ? (
                                        <div className="pm-preview-empty">
                                            {predictorSensors.length === 0
                                                ? 'Add a predictor and click Apply on the Relationship config first.'
                                                : 'Click Apply on the Relationship config to compute a preview.'}
                                        </div>
                                    ) : (
                                        <>
                                            <div className="pm-preview-meta">
                                                output_dataframe: <strong>{relPreview.result.predicted.length.toLocaleString()}</strong> rows
                                                <span className="pm-preview-meta-faint">
                                                    (predictors: {relPreview.predictorsAtApply.join(', ')} · target: {targetSensor} · plus PREDICTED_* columns per cumulative step)
                                                </span>
                                            </div>
                                            <div className="pm-preview-table-wrap">
                                                <table className="pm-preview-table">
                                                    <thead>
                                                        <tr>
                                                            <th>step</th>
                                                            <th>cumulative predictor key</th>
                                                            <th>r2_dict</th>
                                                            <th>2rmse_dict</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {relPreview.result.r2_per_step.map((r2, i) => {
                                                            const cum = relPreview.predictorsAtApply.slice(0, i + 1);
                                                            const rmse2 = relPreview.result.rmse2_per_step[i];
                                                            // Build the Python-list-repr-style key wizard.py uses:
                                                            //   PREDICTED_['SENS01', 'SENS02']
                                                            const cumRepr = `[${cum.map(s => `'${s}'`).join(', ')}]`;
                                                            return (
                                                                <tr key={i}>
                                                                    <td>{i + 1}</td>
                                                                    <td><code>PREDICTED_{cumRepr}</code></td>
                                                                    <td>{typeof r2 === 'number' ? r2.toFixed(2) : '—'}</td>
                                                                    <td>{typeof rmse2 === 'number' ? rmse2.toFixed(4) : '—'}</td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            </div>
                                            {fitIsStale && (
                                                <div className="pm-preview-meta" style={{ color: '#f59e0b', marginTop: 8 }}>
                                                    Predictor selection has changed since last fit — click Apply to refresh.
                                                </div>
                                            )}
                                        </>
                                    )}
                                </section>
                            )}

                            {/* ── PreviewModel.clustering ──────────────── */}
                            {rcMode === 'clustering' && (
                                <section className="pm-preview-section">
                                    <header className="pm-preview-section-header">
                                        <div>
                                            <div className="pm-preview-section-title">Clustering</div>
                                            <div className="pm-preview-section-sub">
                                                request: <code>PreviewModel/clustering</code>
                                            </div>
                                        </div>
                                    </header>
                                    {clusteringLoading ? (
                                        <div className="pm-preview-empty">
                                            <Loader2 size={14} className="animate-spin" /> Fitting GMM ellipses…
                                        </div>
                                    ) : clusteringError ? (
                                        <div className="pm-preview-error">{clusteringError}</div>
                                    ) : !clusteringPreview ? (
                                        <div className="pm-preview-empty">
                                            Click Apply on the Clustering config to compute a preview.
                                        </div>
                                    ) : (
                                        <>
                                            <div className="pm-preview-meta">
                                                cluster_count: <strong>{clusteringPreview.cluster_count}</strong> ·
                                                output_dataframe: <strong>{clusteringPreview.n_rows.toLocaleString()}</strong> rows
                                                <span className="pm-preview-meta-faint">
                                                    (first_sensor: {clusteringPreview.first_sensor} · second_sensor: {clusteringPreview.second_sensor}
                                                    {clusteringPreview.criteria_sensor && ` · criteria_sensor: ${clusteringPreview.criteria_sensor}`})
                                                </span>
                                            </div>
                                            <div className="pm-preview-table-wrap">
                                                <table className="pm-preview-table">
                                                    <thead>
                                                        <tr>
                                                            <th>cluster</th>
                                                            <th>range</th>
                                                            <th>n_rows</th>
                                                            <th>x_center</th>
                                                            <th>y_center</th>
                                                            <th>x_sd</th>
                                                            <th>y_sd</th>
                                                            <th>angle (°)</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {clusteringPreview.clusters.map(c => {
                                                            // Format range as wizard.py-friendly bracket notation,
                                                            // using ∞ when a bound is null.
                                                            const lo = c.range?.min;
                                                            const hi = c.range?.max;
                                                            const loStr = lo === null || lo === undefined ? '−∞' : lo.toString();
                                                            const hiStr = hi === null || hi === undefined ? '+∞' : hi.toString();
                                                            const rangeStr = c.range
                                                                ? `[${loStr}, ${hiStr})`
                                                                : '—';
                                                            return (
                                                                <tr key={c.cluster_id}>
                                                                    <td>{c.cluster_id}</td>
                                                                    <td><code>{rangeStr}</code></td>
                                                                    <td>{c.n_rows.toLocaleString()}</td>
                                                                    <td>{c.ellipse.x_center.toFixed(3)}</td>
                                                                    <td>{c.ellipse.y_center.toFixed(3)}</td>
                                                                    <td>{c.ellipse.x_sd.toFixed(3)}</td>
                                                                    <td>{c.ellipse.y_sd.toFixed(3)}</td>
                                                                    <td>{c.ellipse.angle_deg.toFixed(3)}</td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </>
                                    )}
                                </section>
                            )}
                        </div>
                        <div className="pm-preview-modal-footer">
                            <span className="pm-preview-footer-status">
                                {saveStatus.kind === 'saving' && 'Saving…'}
                                {saveStatus.kind === 'success' && <span style={{ color: '#10b981' }}>Saved.</span>}
                                {saveStatus.kind === 'error' && <span style={{ color: '#f43f5e' }}>{saveStatus.message}</span>}
                            </span>
                            <button
                                className="pm-btn pm-btn-secondary"
                                onClick={() => setPreviewOpen(false)}
                            >
                                Close
                            </button>
                            <button
                                className="pm-btn pm-btn-primary"
                                onClick={() => { handleSaveModel(); }}
                                disabled={saveStatus.kind === 'saving'}
                            >
                                <Check size={13} />
                                <span>{saveStatus.kind === 'saving' ? 'Saving…' : 'Save Model'}</span>
                            </button>
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
                                    One LinearGAM fit per cumulative-feature subset · target: <code>{targetSensor || '—'}</code> · λ: <code>{relStiffness}</code>
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
                                    Fitting LinearGAM model {Math.min(subModelsProgress.current + 1, subModelsProgress.total)} of {subModelsProgress.total}…
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

            {/* ── Saving overlay ────────────────────────────────────────────
                Full-viewport blocking overlay shown while `train_*_model`
                commands run. Renders above every other modal (chart, preview,
                sub-models) because it's the last JSX node and uses a high
                `zIndex`. Intentionally has no close button — the save is
                non-cancellable from Rust's side, so letting the user click
                away would create a UI that no longer matches the in-flight
                operation. */}
            {saveStatus.kind === 'saving' && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Saving model"
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(2, 6, 23, 0.55)',
                        backdropFilter: 'blur(2px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 9999,
                    }}
                >
                    <div
                        style={{
                            background: 'var(--bg-secondary, #1e293b)',
                            color: 'var(--text-primary, #e2e8f0)',
                            borderRadius: 12,
                            padding: '24px 32px',
                            minWidth: 280,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 14,
                            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
                            border: '1px solid var(--border-color, #334155)',
                        }}
                    >
                        <Loader2 size={36} className="animate-spin" style={{ color: '#3b82f6' }} />
                        <div style={{ fontSize: 14, fontWeight: 600 }}>Saving model…</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)', minHeight: 18 }}>
                            {saveStatus.step === 'individual' && 'Training individual model'}
                            {saveStatus.step === 'relationship' && 'Fitting LinearGAM (relationship model)'}
                            {saveStatus.step === 'clustering' && 'Fitting GMM ellipses (clustering model)'}
                            {!saveStatus.step && 'Preparing…'}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
