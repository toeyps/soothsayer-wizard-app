import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { CsvMetadata, SensorMetadata, DashboardSnapshot, PredictiveModelStateSlice } from "../../types";
import { Check, Activity, GitBranch, Layers, Minus, Square, Search, X, Calendar, ChevronLeft, ChevronRight, Thermometer } from "lucide-react";
import { useIsMacOS } from "../../hooks/useIsMacOS";
import { useSubWindowMenu } from "../../hooks/useSubWindowMenu";
import { updateWorkspaceData, loadWorkspaceData } from "../../workspaceManager";

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
    const [, setDashboardSnapshot] = useState<DashboardSnapshot | null>(null);
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

    // Model Stats (placeholder)
    const [modelStats, setModelStats] = useState<{
        mean: number | null;
        sd: number | null;
        r2?: number | null;
        rmse?: number | null;
    }>({ mean: null, sd: null });

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

                setModelStats({ mean: 42.5, sd: 12.3 });
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

    const handleClose = async () => {
        await emit('predictive-model-closed');
        await getCurrentWindow().close();
    };

    const handlePredictorToggle = (sensor: string) => {
        setPredictorSensors(prev => {
            if (prev.includes(sensor)) {
                return prev.filter(s => s !== sensor);
            }
            return [...prev, sensor];
        });
    };

    const handleRelationshipApply = () => {
        console.log("Applying Relationship Model:", { relModelName, relStiffness });
        // TODO: Call backend
    };

    const handleClusteringApply = () => {
        console.log("Applying Clustering Model:", { clusterModelName, numClusters, criteriaSensor, clusterRangeMin, clusterRangeMax });
        // TODO: Call backend
    };

    const handleSaveModel = () => {
        console.log("Save This Sensor Model(s) clicked");
        // TODO: Implement save logic
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
                                    <div className="plot-placeholder pm-chart-placeholder">
                                        <Activity size={48} style={{ opacity: 0.2 }} />
                                        <p>Time Series Plot</p>
                                        <p className="plot-placeholder-sub">1SD + 3SD boundary drawn automatically</p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {rcMode && (
                            <div className="pm-chart-card">
                                <div className="pm-chart-header">
                                    <div className="pm-chart-title-block">
                                        <div className="pm-chart-title">
                                            {rcMode === 'relationship' ? 'Target vs. Predictors' : 'Cluster Assignment'}
                                        </div>
                                        <div className="pm-chart-subtitle">
                                            {rcMode === 'relationship' ? 'Scatter against each enabled predictor' : 'K-means clustering'}
                                        </div>
                                    </div>
                                    {predictorSensors.length > 0 && (
                                        <div className="pm-scatter-x-selector">
                                            <label>X-axis:</label>
                                            <SensorAutocomplete
                                                sensors={predictorSensors}
                                                getDesc={getDesc}
                                                value={scatterXSensor}
                                                onSelect={setScatterXSensor}
                                                placeholder="Select X-axis sensor..."
                                                style={{ minWidth: '180px' }}
                                            />
                                        </div>
                                    )}
                                </div>
                                <div className="pm-chart-body">
                                    <div className="plot-placeholder pm-chart-placeholder">
                                        {rcMode === 'relationship' ? <GitBranch size={48} style={{ opacity: 0.2 }} /> : <Layers size={48} style={{ opacity: 0.2 }} />}
                                        <p>
                                            {rcMode === 'relationship' ? 'Scatterplot — Relationship Mode' : 'Cluster Plot'}
                                        </p>
                                        <p className="plot-placeholder-sub">
                                            {rcMode === 'relationship' ? 'Click Apply to compute predicted values' : 'Click Apply to draw cluster ellipses'}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Stats strip */}
                    <div className="pm-stats-strip">
                        <span className="pm-stats-eyebrow">Model stats</span>
                        <div className="pm-stats-item">
                            <span className="pm-stats-label">Mean</span>
                            <span className="pm-stats-value">{modelStats.mean?.toFixed(2) ?? '—'}</span>
                        </div>
                        <div className="pm-stats-item">
                            <span className="pm-stats-label">SD</span>
                            <span className="pm-stats-value">{modelStats.sd?.toFixed(2) ?? '—'}</span>
                        </div>
                        <div className="pm-stats-item">
                            <span className="pm-stats-label">±1σ</span>
                            <span className="pm-stats-value">
                                {modelStats.mean !== null && modelStats.sd !== null
                                    ? `${(modelStats.mean - modelStats.sd).toFixed(2)} – ${(modelStats.mean + modelStats.sd).toFixed(2)}`
                                    : '—'}
                            </span>
                        </div>
                        <div className="pm-stats-item">
                            <span className="pm-stats-label">±3σ</span>
                            <span className="pm-stats-value pm-stats-warn">
                                {modelStats.mean !== null && modelStats.sd !== null
                                    ? `${(modelStats.mean - 3 * modelStats.sd).toFixed(2)} – ${(modelStats.mean + 3 * modelStats.sd).toFixed(2)}`
                                    : '—'}
                            </span>
                        </div>
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
                                disabled={rcMode !== 'relationship'}
                            >
                                Apply
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
                                disabled={rcMode !== 'clustering'}
                            >
                                Apply
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
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
