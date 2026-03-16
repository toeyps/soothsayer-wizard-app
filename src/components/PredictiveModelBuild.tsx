import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { CsvMetadata, SensorMetadata } from "../types";
import { ChevronDown, Check, Save, BarChart3, GitBranch, Layers } from "lucide-react";

interface PredictiveModelData {
    targetSensor: string;
    predictorSensors: string[];
    sensorHeaders: string[];
    sensorMetadata: SensorMetadata[] | null;
    metadata: CsvMetadata;
}



export default function PredictiveModelBuild() {
    // Data from previous page
    const [targetSensor, setTargetSensor] = useState<string>("");
    const [predictorSensors, setPredictorSensors] = useState<string[]>([]);
    const [allSensors, setAllSensors] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);

    // Plot mode
    const [individualChecked, setIndividualChecked] = useState(true);
    const [rcMode, setRcMode] = useState<'relationship' | 'clustering' | null>(null);
    const [rcDropdownOpen, setRcDropdownOpen] = useState(false);

    // Predictor dropdown
    const [predictorDropdownOpen, setPredictorDropdownOpen] = useState(false);
    const [scatterXSensor, setScatterXSensor] = useState<string>("");

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
            unlistenData = await listen<PredictiveModelData>('predictive-model-data', (event) => {
                console.log("Received predictive-model-data:", event.payload);
                const d = event.payload;
                setTargetSensor(d.targetSensor);
                setPredictorSensors(d.predictorSensors);
                setAllSensors(d.sensorHeaders);
                if (d.predictorSensors.length > 0) {
                    setScatterXSensor(d.predictorSensors[0]);
                }
                // Compute placeholder stats
                setModelStats({ mean: 42.5, sd: 12.3 });
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

    const handleIndividualToggle = () => {
        setIndividualChecked(!individualChecked);
    };

    const handleRcModeChange = (mode: 'relationship' | 'clustering') => {
        if (rcMode === mode) {
            setRcMode(null);
        } else {
            setRcMode(mode);
        }
        setRcDropdownOpen(false);
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

    if (loading) {
        return (
            <div className="predictive-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>Loading model data...</div>
            </div>
        );
    }

    return (
        <div className="predictive-container" ref={containerRef}>
            {/* Title Bar */}
            <div data-tauri-drag-region className="predictive-titlebar">
                <h2 className="predictive-title">Predictive Mode — Model Build</h2>
                <button onClick={handleClose} className="predictive-close-btn">&times;</button>
            </div>

            {/* Main Content */}
            <div className="predictive-body">
                {/* LEFT PANEL - Configuration */}
                <div className="predictive-left-panel">
                    {/* Target Sensor */}
                    <div className="config-section config-section-sticky">
                        <div className="config-section-header">Target Sensor</div>
                        <div className="config-readonly-value">
                            <BarChart3 size={14} />
                            <span>{targetSensor || "Not selected"}</span>
                            <span className="config-badge">From previous page</span>
                        </div>
                    </div>

                    {/* Predictor Sensors */}
                    <div className="config-section">
                        <div className="config-section-header">Predictor Sensor(s)</div>
                        <div className="config-description">Select sensors to use as predictors. Can select multiple.</div>
                        <div className="predictor-dropdown-wrapper">
                            <button
                                className="predictor-dropdown-toggle"
                                onClick={() => setPredictorDropdownOpen(!predictorDropdownOpen)}
                            >
                                <span>{predictorSensors.length > 0 ? `${predictorSensors.length} sensor(s) selected` : "Select sensor(s)..."}</span>
                                <ChevronDown size={14} style={{ transform: predictorDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                            </button>
                            {predictorDropdownOpen && (
                                <div className="predictor-dropdown-list">
                                    {allSensors.map(sensor => (
                                        <label key={sensor} className="predictor-dropdown-item">
                                            <input
                                                type="checkbox"
                                                checked={predictorSensors.includes(sensor)}
                                                onChange={() => handlePredictorToggle(sensor)}
                                            />
                                            <span>{sensor}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                        {/* Selected tags */}
                        {predictorSensors.length > 0 && (
                            <div className="predictor-tags">
                                {predictorSensors.map(s => (
                                    <span key={s} className="predictor-tag">
                                        {s}
                                        <button onClick={() => handlePredictorToggle(s)}>&times;</button>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Data Filter */}
                    <div className="config-section">
                        <div className="config-section-header">Data Filter</div>
                        <div className="config-description">Filter by TimeStamp, Sensor Value</div>
                        <div className="filter-row">
                            <label>Time Start</label>
                            <input type="datetime-local" value={filterTimeStart} onChange={e => setFilterTimeStart(e.target.value)} className="config-input" />
                        </div>
                        <div className="filter-row">
                            <label>Time End</label>
                            <input type="datetime-local" value={filterTimeEnd} onChange={e => setFilterTimeEnd(e.target.value)} className="config-input" />
                        </div>
                        <div className="filter-row">
                            <label>Sensor Value</label>
                            <input type="text" value={filterSensorValue} onChange={e => setFilterSensorValue(e.target.value)} placeholder="e.g. > 50" className="config-input" />
                        </div>
                    </div>

                    {/* Relationship Model Config */}
                    <div className={`config-section ${rcMode === 'relationship' ? 'config-active' : 'config-disabled'}`}>
                        <div className="config-section-header">
                            <span>Relationship Model Config</span>
                            <button
                                className="config-apply-btn"
                                onClick={handleRelationshipApply}
                                disabled={rcMode !== 'relationship'}
                            >
                                Apply
                            </button>
                        </div>
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
                                disabled={rcMode !== 'relationship'}
                                min={0}
                                step={0.1}
                            />
                        </div>
                    </div>

                    {/* Clustering Model Config */}
                    <div className={`config-section ${rcMode === 'clustering' ? 'config-active' : 'config-disabled'}`}>
                        <div className="config-section-header">
                            <span>Clustering Model Config</span>
                            <button
                                className="config-apply-btn"
                                onClick={handleClusteringApply}
                                disabled={rcMode !== 'clustering'}
                            >
                                Apply
                            </button>
                        </div>
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
                                disabled={rcMode !== 'clustering'}
                                min={1}
                            />
                        </div>
                        <div className="filter-row">
                            <label>Criteria Sensor</label>
                            <select
                                value={criteriaSensor}
                                onChange={e => setCriteriaSensor(e.target.value)}
                                className="config-input"
                                disabled={rcMode !== 'clustering'}
                            >
                                <option value="">None (1 cluster)</option>
                                {allSensors.map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                        </div>
                        <div className="filter-row">
                            <label>Clustering Range</label>
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                <input
                                    type="number"
                                    value={clusterRangeMin}
                                    onChange={e => setClusterRangeMin(Number(e.target.value))}
                                    className="config-input"
                                    disabled={rcMode !== 'clustering'}
                                    style={{ width: '80px' }}
                                />
                                <span style={{ color: 'var(--text-secondary)' }}>to</span>
                                <input
                                    type="number"
                                    value={clusterRangeMax}
                                    onChange={e => setClusterRangeMax(Number(e.target.value))}
                                    className="config-input"
                                    disabled={rcMode !== 'clustering'}
                                    style={{ width: '80px' }}
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* CENTER - Chart / Plot Area */}
                <div className="predictive-main-area">
                    {/* Plot Toggle Row */}
                    <div className="plot-toggle-row">
                        {/* Individual checkbox */}
                        <label className={`plot-type-toggle ${individualChecked ? 'active' : ''}`}>
                            <input
                                type="checkbox"
                                checked={individualChecked}
                                onChange={handleIndividualToggle}
                                className="plot-checkbox"
                            />
                            <BarChart3 size={14} />
                            <span>Individual</span>
                        </label>

                        {/* Relationship / Clustering Dropdown */}
                        <div className="rc-dropdown-wrapper">
                            <button
                                className={`plot-type-toggle ${rcMode ? 'active' : ''}`}
                                onClick={() => setRcDropdownOpen(!rcDropdownOpen)}
                            >
                                <input
                                    type="checkbox"
                                    checked={rcMode !== null}
                                    onChange={() => {
                                        if (rcMode) setRcMode(null);
                                        else setRcMode('relationship');
                                    }}
                                    className="plot-checkbox"
                                    onClick={e => e.stopPropagation()}
                                />
                                {rcMode === 'clustering' ? <Layers size={14} /> : <GitBranch size={14} />}
                                <span>{rcMode ? (rcMode === 'relationship' ? 'Relationship' : 'Clustering') : 'Relationship/Clustering'}</span>
                                <ChevronDown size={12} />
                            </button>
                            {rcDropdownOpen && (
                                <div className="rc-dropdown-menu">
                                    <button
                                        className={`rc-dropdown-item ${rcMode === 'relationship' ? 'selected' : ''}`}
                                        onClick={() => handleRcModeChange('relationship')}
                                    >
                                        <GitBranch size={14} />
                                        Relationship
                                        {rcMode === 'relationship' && <Check size={14} />}
                                    </button>
                                    <button
                                        className={`rc-dropdown-item ${rcMode === 'clustering' ? 'selected' : ''}`}
                                        onClick={() => handleRcModeChange('clustering')}
                                    >
                                        <Layers size={14} />
                                        Clustering
                                        {rcMode === 'clustering' && <Check size={14} />}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Plot Area */}
                    <div className="predictive-plot-area">
                        {individualChecked && (
                            <div className="plot-card">
                                <div className="plot-card-header">
                                    <span>Standard Time Series Plot</span>
                                    <span className="plot-card-subtitle">X: TimeStamp (fixed) • Y: {targetSensor} (fixed)</span>
                                </div>
                                <div className="plot-card-body">
                                    <div className="plot-placeholder">
                                        <BarChart3 size={48} style={{ opacity: 0.2 }} />
                                        <p>Time Series Plot</p>
                                        <p className="plot-placeholder-sub">1SD + 3SD boundary drawn automatically</p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {rcMode && (
                            <div className="plot-card">
                                <div className="plot-card-header">
                                    <span>Scatterplot</span>
                                    <div className="scatter-x-selector">
                                        <label>X-axis:</label>
                                        <select
                                            value={scatterXSensor}
                                            onChange={e => setScatterXSensor(e.target.value)}
                                            className="config-input"
                                            style={{ minWidth: '150px' }}
                                        >
                                            {predictorSensors.map(s => (
                                                <option key={s} value={s}>{s}</option>
                                            ))}
                                        </select>
                                        <span className="plot-card-subtitle">Y: {targetSensor} (fixed)</span>
                                    </div>
                                </div>
                                <div className="plot-card-body">
                                    <div className="plot-placeholder">
                                        <GitBranch size={48} style={{ opacity: 0.2 }} />
                                        <p>Scatterplot — {rcMode === 'relationship' ? 'Relationship' : 'Clustering'} Mode</p>
                                        <p className="plot-placeholder-sub">
                                            {rcMode === 'relationship'
                                                ? 'Click Apply to compute predicted values'
                                                : 'Click Apply to draw cluster ellipses'}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Model Stats Bar */}
                    <div className="model-stats-bar">
                        <div className="model-stats-header">Model Stats</div>
                        <div className="model-stats-grid">
                            <div className="stat-item">
                                <span className="stat-label">Mean</span>
                                <span className="stat-value">{modelStats.mean?.toFixed(2) ?? '—'}</span>
                            </div>
                            <div className="stat-item">
                                <span className="stat-label">SD</span>
                                <span className="stat-value">{modelStats.sd?.toFixed(2) ?? '—'}</span>
                            </div>
                            <div className="stat-item">
                                <span className="stat-label">Mean ± SD</span>
                                <span className="stat-value">
                                    {modelStats.mean !== null && modelStats.sd !== null
                                        ? `${(modelStats.mean - modelStats.sd).toFixed(2)} ~ ${(modelStats.mean + modelStats.sd).toFixed(2)}`
                                        : '—'}
                                </span>
                            </div>
                            <div className="stat-item">
                                <span className="stat-label">Mean ± 3SD</span>
                                <span className="stat-value">
                                    {modelStats.mean !== null && modelStats.sd !== null
                                        ? `${(modelStats.mean - 3 * modelStats.sd).toFixed(2)} ~ ${(modelStats.mean + 3 * modelStats.sd).toFixed(2)}`
                                        : '—'}
                                </span>
                            </div>
                            {rcMode === 'relationship' && (
                                <>
                                    <div className="stat-item stat-highlight">
                                        <span className="stat-label">R²</span>
                                        <span className="stat-value">{modelStats.r2?.toFixed(4) ?? '—'}</span>
                                    </div>
                                    <div className="stat-item stat-highlight">
                                        <span className="stat-label">RMSE</span>
                                        <span className="stat-value">{modelStats.rmse?.toFixed(4) ?? '—'}</span>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {/* RIGHT PANEL - Sensor Lists */}
                <div className="predictive-sensor-list">
                    <div className="sensor-list-panel-header">
                        Sensor Lists (Predictors)
                    </div>
                    <div className="sensor-list-panel-body">
                        {predictorSensors.length === 0 ? (
                            <div className="sensor-list-empty">No predictors selected</div>
                        ) : (
                            predictorSensors.map((sensor, idx) => (
                                <div key={sensor} className="sensor-list-panel-item">
                                    <span className="sensor-list-index">{idx + 1}</span>
                                    <span className="sensor-list-name">{sensor}</span>
                                </div>
                            ))
                        )}
                    </div>

                    {/* Save Button */}
                    <div className="sensor-list-panel-footer">
                        <button className="save-model-btn" onClick={handleSaveModel} title="Save Model">
                            <Save size={16} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
