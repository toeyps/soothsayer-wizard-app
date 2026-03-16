import { useState, useMemo, useEffect, useDeferredValue, useRef, forwardRef, useImperativeHandle } from 'react';
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, UnlistenFn } from "@tauri-apps/api/event";
import { saveWorkspaceData } from '../workspaceManager';
import { ProcessedData, CsvMetadata, SensorMetadata, CsvRecord, SensorOperationConfig, WorkspaceState } from '../types';
import DataTable from './DataTable';
import Chart from './Chart';
import FilterPanel from './FilterPanel';
import SensorSelection from './SensorSelection';

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Plus, EyeOff, BarChart3, Radio, Table, Download, Filter, Calendar, ArrowRight, ArrowLeft } from 'lucide-react';

// Panel configuration
const PANELS = {
    chart: { id: 'chart', label: 'Chart', icon: BarChart3 },
    filter: { id: 'filter', label: 'Filter', icon: Filter },
    sensors: { id: 'sensors', label: 'Sensors', icon: Radio },
    data: { id: 'data', label: 'Data', icon: Table }
} as const;

type PanelId = keyof typeof PANELS;


interface DashboardProps {
    metadata: CsvMetadata;
    sensorMetadata: SensorMetadata[] | null;
    onBack: () => void;
    initialState: WorkspaceState | null;
}

export interface DashboardRef {
    saveWorkspace: () => Promise<void>;
    saveWorkspaceAs: () => Promise<void>;
    renameWorkspace: (newName: string) => void;
}

const Dashboard = forwardRef<DashboardRef, DashboardProps>(({ metadata, sensorMetadata, onBack, initialState }, ref) => {
    const [_, setAnalysisResult] = useState<string>("");
    const [localName, setLocalName] = useState(initialState?.name || "");

    const [sensorHeaders, setSensorHeaders] = useState<string[]>(() =>
        metadata.headers.filter(h => {
            const lower = h.trim().toLowerCase();
            return lower !== 'timestamp' && lower !== 'time';
        })
    );

    const [selectedSensors, setSelectedSensors] = useState<string[]>(initialState?.selectedSensors || []);
    const [visibleSensors, setVisibleSensors] = useState<string[]>(initialState?.visibleSensors || []);
    const [operationConfig, setOperationConfig] = useState<SensorOperationConfig | null>(initialState?.operationConfig || null);

    useImperativeHandle(ref, () => ({
        saveWorkspace: async () => {
            if (initialState) {
                const updatedState: WorkspaceState = {
                    ...initialState,
                    name: localName,
                    lastRoute: 'dashboard',
                    selectedSensors,
                    visibleSensors,
                    operationConfig
                };
                await saveWorkspaceData(updatedState);
                alert(`Workspace "${localName}" Saved Successfully!`);
            }
        },
        saveWorkspaceAs: async () => {
            // Open new window instead of prompt
            const webview = new WebviewWindow('save-as', {
                url: '/?window=save-as',
                title: 'Save Workspace As',
                width: 450,
                height: 350,
                center: true,
                alwaysOnTop: true,
                decorations: false,
                resizable: false,
                skipTaskbar: true
            });

            await webview.once('tauri://error', (e) => {
                console.error('Failed to create Save As window:', e);
            });
        },
        renameWorkspace: (newName: string) => {
            setLocalName(newName);
        }
    }));

    // Listen for Save As window requests and submissions
    useEffect(() => {
        let unlistenReq: (() => void) | undefined;
        let unlistenSubmit: (() => void) | undefined;

        const setupSaveAsListeners = async () => {
            unlistenReq = await listen('request-save-as-data', async () => {
                await emit('request-save-as-data-response', { currentName: localName });
            });

            unlistenSubmit = await listen<{ newName: string }>('save-as-submit', async (event) => {
                if (initialState) {
                    const newId = `ws_${Date.now()}`;
                    const newState: WorkspaceState = {
                        ...initialState,
                        id: newId,
                        name: event.payload.newName,
                        lastRoute: 'dashboard',
                        selectedSensors,
                        visibleSensors,
                        operationConfig
                    };
                    await saveWorkspaceData(newState);
                    setLocalName(event.payload.newName);
                    // We also need to notify the parent App to update its workspaceName state
                    await emit('workspace-renamed-internal', { newName: event.payload.newName });
                    alert(`New workspace "${event.payload.newName}" created!`);
                }
            });
        };

        setupSaveAsListeners();
        return () => {
            if (unlistenReq) unlistenReq();
            if (unlistenSubmit) unlistenSubmit();
        };
    }, [localName, initialState, selectedSensors, visibleSensors, operationConfig]);

    const handleAnalysis = async () => {
        try {
            const result = await invoke<string>("run_python_analysis");
            console.log("Python Analysis Result:", result);
            setAnalysisResult(result);
            alert("Analysis Result: " + result);
        } catch (e) {
            console.error("Analysis Failed:", e);
            alert("Analysis Failed: " + String(e));
        }
    };

    
    // Auto-save state changes
    useEffect(() => {
        if (initialState) {
            const saveState = async () => {
                const updatedState: WorkspaceState = {
                    ...initialState,
                    name: localName,
                    lastRoute: 'dashboard',
                    selectedSensors,
                    visibleSensors,
                    operationConfig
                };
                await saveWorkspaceData(updatedState);
            };
            saveState();
        }
    }, [selectedSensors, visibleSensors, operationConfig, initialState, localName]);

    const deferredSensors = useDeferredValue(selectedSensors);
    const [chartData, setChartData] = useState<ProcessedData | null>(null);
    const [loading, setLoading] = useState(false);

    // Sync visibleSensors with selectedSensors when selectedSensors changes
    useEffect(() => {
        setVisibleSensors(selectedSensors);
    }, [selectedSensors]);

    // Collapsed panels state
    const [collapsedPanels, setCollapsedPanels] = useState<Set<PanelId>>(new Set());

    const togglePanel = (panelId: PanelId) => {
        setCollapsedPanels(prev => {
            const newSet = new Set(prev);
            if (newSet.has(panelId)) {
                newSet.delete(panelId);
            } else {
                newSet.add(panelId);
            }
            return newSet;
        });
    };

    const expandPanel = (panelId: PanelId) => {
        setCollapsedPanels(prev => {
            const newSet = new Set(prev);
            newSet.delete(panelId);
            return newSet;
        });
    };

    // Fetch data when sensors change
    useEffect(() => {
        let unlistenChunk: UnlistenFn | undefined;
        let unlistenEnd: UnlistenFn | undefined;

        const fetchData = async () => {
            // Reset state
            // setChartData(null); // Keep previous data to prevent flickering

            if (deferredSensors.length === 0) {
                setChartData({ headers: [], rows: [] });
                return;
            }

            setLoading(true);
            const accumRows: CsvRecord[] = [];
            let headers: string[] = [];

            try {
                // Setup listeners BEFORE invoking
                unlistenChunk = await listen<ProcessedData>('data-stream-chunk', (event) => {
                    const chunk = event.payload;
                    if (headers.length === 0) {
                        headers = chunk.headers;
                    }
                    accumRows.push(...chunk.rows);

                    // Optional: Update intermediate state if we want real-time visualization
                    // But for performance, usually better to wait or throttle updates.
                    // Here we will just accumulate and update at end for safety/simplicity first,
                    // or we could update setChartData incrementally if desired.
                    // Given the request is about "sending as chunk", let's wait for end for the *chart*
                    // render to avoid thrashing, or maybe show a progress count.
                });

                unlistenEnd = await listen('data-stream-end', () => {
                    setChartData({
                        headers: headers.length > 0 ? headers : deferredSensors,
                        rows: accumRows
                    });
                    setLoading(false);
                });

                console.time("invoke_get_data_stream");
                // invoke now just starts the process
                await invoke("get_data", { sensors: deferredSensors });
                console.timeEnd("invoke_get_data_stream");

            } catch (err) {
                console.error("Failed to fetch data:", err);
                setLoading(false);
            }
        };

        fetchData();

        return () => {
            if (unlistenChunk) unlistenChunk();
            if (unlistenEnd) unlistenEnd();
        };
    }, [deferredSensors]);

    // Event handling for Add Sensor Window communication
    // Use ref to keep track of latest state without re-binding listeners
    const stateRef = useRef({ sensorHeaders, selectedSensors, sensorMetadata, metadata });
    useEffect(() => {
        stateRef.current = { sensorHeaders, selectedSensors, sensorMetadata, metadata };
    }, [sensorHeaders, selectedSensors, sensorMetadata, metadata]);

    useEffect(() => {
        let unlistenRequest: UnlistenFn | undefined;
        let unlistenAdd: UnlistenFn | undefined;
        let unlistenPredictive: UnlistenFn | undefined;

        const setupListeners = async () => {
            console.log("Setting up Dashboard listeners");
            // Listen for request from child window
            unlistenRequest = await listen('request-sensors', () => {
                console.log("Dashboard received 'request-sensors', emitting data...");
                const { sensorHeaders, selectedSensors, sensorMetadata } = stateRef.current;
                emit('sensors-data', {
                    sensors: sensorHeaders,
                    selectedSensors: selectedSensors,
                    sensorMetadata: sensorMetadata
                });
            });

            // Listen for new selections from child window
            unlistenAdd = await listen<{ sensors: string[], operation: SensorOperationConfig | null }>('add-sensor-selection', async (event) => {
                console.log("Dashboard received 'add-sensor-selection'", event.payload);

                let newSelectedSensors: string[] = [];
                let newOperationConfig: SensorOperationConfig | null = null;

                if (Array.isArray(event.payload)) {
                    newSelectedSensors = event.payload;
                    newOperationConfig = null;
                } else {
                    newSelectedSensors = event.payload.sensors;
                    newOperationConfig = event.payload.operation;
                }

                // Update selection
                setSelectedSensors(newSelectedSensors);
                setOperationConfig(newOperationConfig);

                // Manually update sensor headers to include any new sensors from the selection
                // This ensures immediate UI update without waiting for backend fetch
                setSensorHeaders(prevHeaders => {
                    const newHeaders = [...prevHeaders];
                    let changed = false;
                    newSelectedSensors.forEach(s => {
                        // Check case-insensitive existence
                        const exists = newHeaders.some(h => h.toLowerCase() === s.toLowerCase());
                        if (!exists) {
                            newHeaders.push(s);
                            changed = true;
                        }
                    });
                    return changed ? newHeaders : prevHeaders;
                });
            });
            // Listen for request from failure group window
            unlistenPredictive = await listen('request-failure-group-data', () => {
                console.log("Dashboard received 'request-failure-group-data', emitting data...");
                const { sensorHeaders, sensorMetadata, metadata } = stateRef.current;
                emit('failure-group-data', {
                    sensorHeaders,
                    sensorMetadata,
                    metadata
                });
            });
        };

        setupListeners();

        return () => {
            if (unlistenRequest) unlistenRequest();
            if (unlistenAdd) unlistenAdd();
            if (unlistenPredictive) unlistenPredictive();
        };
    }, []);

    const [dateRange, setDateRange] = useState<{ start: string, end: string } | null>(null);
    const [chartType, setChartType] = useState<'line' | 'scatter' | 'pair'>('line');
    const [samplingMethod, setSamplingMethod] = useState<'raw' | 'avg' | 'max' | 'min' | 'first' | 'last'>('raw');


    // Filter logic (Client side filtering of the fetched subset)
    const displayHeaders = useMemo(() => {
        if (!chartData) return [];
        if (operationConfig?.mode === 'multi' && operationConfig?.multiOp) {
            return [`Result (${operationConfig.multiOp.type})`];
        }
        // Filter by visibleSensors
        return chartData.headers.filter(h => visibleSensors.includes(h));
    }, [chartData, operationConfig, visibleSensors]);

    const filteredData = useMemo(() => {
        if (!chartData) return [];

        let rows = chartData.rows.filter(r => r.timestamp !== null);

        // 1. Filter by Date Range first (optimization)
        if (dateRange && dateRange.start && dateRange.end) {
            const start = new Date(dateRange.start).getTime();
            const end = new Date(dateRange.end).getTime();
            rows = rows.filter(r => {
                if (!r.timestamp) return false;
                const t = new Date(r.timestamp).getTime();
                if (isNaN(t)) return false; // Skip invalid dates
                return t >= start && t <= end;
            });
        }

        // 2. Aggregation / Sampling
        // First, apply Operation Logic if exists (Transform values before sampling or after? 
        // Better to transform raw rows first if we want accurate aggregation, 
        // BUT for performance on large data, maybe after? 
        // For accurate Single op (A+10), order doesn't matter much vs sampling.
        // For Multi op (A+B), we need rows to have aligned timestamps. Data is row-based, so A and B are in `values` array.

        let processedRows = rows;

        // Apply Multi-Sensor Operation (Reduces to 1 "sensor" usually, or transforms?)
        // If Multi Op: "Sum", we probably want to visualize the SUM. 
        // The headers currently correspond to `chartData.headers`.
        // If we compute a new value, we need to map it to a "Chartable" format.
        // The Chart component takes `data` and `sensors`.
        // We might need to override the data being passed to Chart if we change the shape.
        // Doing this inside `filteredData` which returns `CsvRecord[]` is tricky if headers don't match.
        // **Compromise**: We will perform the calculation and place it in a generated "Result" column, 
        // and ideally we should update the headers passed to Chart. 
        // But `filteredData` only returns rows. `Chart` uses `chartData.headers`.
        // We might need to handle this by modifying how Chart receives headers, or by returning a different structure.

        if (operationConfig) {
            if (operationConfig.mode === 'single' && operationConfig.singleOp) {
                const { type, value } = operationConfig.singleOp;
                processedRows = rows.map(r => ({
                    ...r,
                    values: r.values.map(v => {
                        if (v === null) return null;
                        switch (type) {
                            case 'add': return v + value;
                            case 'subtract': return v - value;
                            case 'multiply': return v * value;
                            case 'divide': return value !== 0 ? v / value : v;
                            case 'power': return Math.pow(v, value);
                            default: return v;
                        }
                    })
                }));
            } else if (operationConfig.mode === 'multi' && operationConfig.multiOp) {
                const { type, baseSensor } = operationConfig.multiOp;
                // We need to know indices of selected sensors in the `chartData.headers`
                // `chartData.headers` contains ALL sensors loaded? Or just the ones requested?
                // `get_data` returns only requested sensors usually?
                // Let's assume chartData.headers matches the columns in r.values

                processedRows = rows.map(r => {
                    let result: number | null = null;

                    // Get values for the selected sensors
                    // Note: chartData.headers should match r.values
                    const valuesToProcess = r.values;

                    // Filter out nulls
                    const validValues = valuesToProcess.filter((v): v is number => v !== null);

                    if (validValues.length > 0) {
                        switch (type) {
                            case 'sum':
                                result = validValues.reduce((a, b) => a + b, 0);
                                break;
                            case 'mean':
                                result = validValues.reduce((a, b) => a + b, 0) / validValues.length;
                                break;
                            case 'median':
                                const sorted = [...validValues].sort((a, b) => a - b);
                                const mid = Math.floor(sorted.length / 2);
                                result = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
                                break;
                            case 'product':
                                result = validValues.reduce((a, b) => a * b, 1);
                                break;
                            case 'subtract':
                            case 'divide':
                                if (baseSensor) {
                                    // Find base index
                                    const baseIndex = chartData.headers.indexOf(baseSensor);
                                    if (baseIndex !== -1) {
                                        const baseVal = r.values[baseIndex];
                                        if (baseVal !== null) {
                                            // Actors are everyone else
                                            const actors = r.values.filter((_, i) => i !== baseIndex && r.values[i] !== null) as number[];
                                            // Logic: Base - Sum(Actors) or Base / Sum(Actors)?
                                            // Or sequential? Base - A - B?
                                            // Let's do Base - Sum(Rest) for now as a reasonable default for "Combine".
                                            // Or if strict sequential is needed, we need order.
                                            const actorSum = actors.reduce((a, b) => a + b, 0);

                                            if (type === 'subtract') {
                                                result = baseVal - actorSum;
                                            } else {
                                                result = actorSum !== 0 ? baseVal / actorSum : null;
                                            }
                                        }
                                    }
                                }
                                break;
                        }
                    }
                    return { ...r, values: [result] };
                });
            }
        }


        if (samplingMethod === 'raw') {
            return processedRows;
        }

        // Sampling Logic (Updated to use processedRows)
        const getHourKey = (ts: string) => {
            const d = new Date(ts);
            d.setMinutes(0, 0, 0); // round down to hour
            return d.toISOString();
        };

        const grouped = new Map<string, CsvRecord[]>();

        processedRows.forEach(r => {
            if (!r.timestamp) return;
            const key = getHourKey(r.timestamp);
            if (!grouped.has(key)) {
                grouped.set(key, []);
            }
            grouped.get(key)!.push(r);
        });

        const aggregated: CsvRecord[] = [];

        for (const [timestamp, groupRows] of grouped) {
            const newValues: (number | null)[] = [];
            // Determine num columns from first row (might change if Multi Op)
            const numCols = groupRows[0].values.length;

            // For each sensor column
            for (let i = 0; i < numCols; i++) {
                const validValues = groupRows
                    .map(r => r.values[i])
                    .filter((v): v is number => v !== null);

                let val: number | null = null;

                if (validValues.length > 0) {
                    if (samplingMethod === 'avg') {
                        const sum = validValues.reduce((a, b) => a + b, 0);
                        val = sum / validValues.length;
                    } else if (samplingMethod === 'max') {
                        val = Math.max(...validValues);
                    } else if (samplingMethod === 'min') {
                        val = Math.min(...validValues);
                    } else if (samplingMethod === 'first') {
                        val = validValues[0];
                    } else if (samplingMethod === 'last') {
                        val = validValues[validValues.length - 1];
                    }
                }
                newValues.push(val);
            }
            aggregated.push({ timestamp, values: newValues });
        }

        // If aggregation happened, we might want to ensure it's sorted by time again
        aggregated.sort((a, b) => new Date(a.timestamp!).getTime() - new Date(b.timestamp!).getTime());

        return aggregated;
    }, [chartData, dateRange, samplingMethod, operationConfig]);

    // Filter data values by visible sensors
    const visibleFilteredData = useMemo(() => {
        if (!chartData || operationConfig?.mode === 'multi') {
            // If multi-op mode, data only has 1 column, no filtering needed
            return filteredData;
        }

        // Get indices of visible sensors in chartData.headers
        const visibleIndices = chartData.headers
            .map((h, i) => visibleSensors.includes(h) ? i : -1)
            .filter(i => i !== -1);

        // Map rows to only include visible sensor values
        return filteredData.map(row => ({
            ...row,
            values: visibleIndices.map(i => row.values[i])
        }));
    }, [filteredData, chartData, visibleSensors, operationConfig]);


    // Calculate data range for auto-filling inputs
    const dataRange = useMemo(() => {
        if (!chartData || chartData.rows.length === 0) return undefined;
        // Assuming sorted by timestamp, but let's be safe.
        // Actually, large data might be unsorted? Usually sorted.
        // If data is huge, this might be slow. But rows is usually filtered? No, chartData.rows is "all" fetched data.
        // We should just take first and last if sorted.
        // Let's assume sorted for O(1). If not, we fix later.
        // Backend usually returns sorted.

        const first = chartData.rows[0].timestamp;
        const last = chartData.rows[chartData.rows.length - 1].timestamp;

        if (first && last) {
            // Check if sorted?
            // Let's just trust first and last for optimization on large datasets.
            return {
                min: first,
                max: last
            };
        }
        return undefined;
    }, [chartData]);


    return (
        <div className="dashboard-container">
            {/* Collapsed Tabs Sidebar */}
            {collapsedPanels.size > 0 && (
                <div className="collapsed-tabs-sidebar">
                    {Array.from(collapsedPanels).map(panelId => {
                        const panel = PANELS[panelId];
                        const IconComponent = panel.icon;
                        return (
                            <button
                                key={panelId}
                                className="collapsed-tab"
                                onClick={() => expandPanel(panelId)}
                                title={`Show ${panel.label}`}
                            >
                                <IconComponent size={18} />
                                <span className="collapsed-tab-label">{panel.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}



            <div className="dashboard-grid-2x2">
                {/* Left Column - Chart + Filter */}
                <div className="left-column">
                    {/* Chart Section */}
                    {!collapsedPanels.has('chart') ? (
                        <div className="chart-section-large">
                            <div className="section-header collapsible-header">
                                <div className="section-header-left">
                                    <button 
                                        onClick={onBack}
                                        className="collapse-btn" 
                                        title="Back to Import"
                                        style={{ marginRight: '0.5rem', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
                                    >
                                        <ArrowLeft size={18} />
                                    </button>
                                    <h3>Sensor Readings</h3>
                                    <span className="section-badge">{samplingMethod.toUpperCase()} (1h)</span>
                                    <span className="section-badge">{visibleFilteredData.length.toLocaleString()} Points</span>
                                    {loading && <span className="section-badge section-badge-loading">Loading...</span>}
                                </div>
                                <div className="section-header-actions">
                                    <div className="chart-type-group">
                                        <button className={`chart-type-btn ${chartType === 'line' ? 'active' : ''}`} onClick={() => setChartType('line')}>Line</button>
                                        <button className={`chart-type-btn ${chartType === 'scatter' ? 'active' : ''}`} onClick={() => setChartType('scatter')}>Scatter</button>
                                        <button className={`chart-type-btn ${chartType === 'pair' ? 'active' : ''}`} onClick={() => setChartType('pair')}>Pair Plot</button>
                                    </div>
                                    <button className="chart-type-btn chart-type-btn-accent" onClick={handleAnalysis}>Run Python Analysis</button>
                                    <button className="collapse-btn" onClick={() => togglePanel('chart')} title="Hide panel">
                                        <EyeOff size={14} />
                                    </button>
                                </div>
                            </div>
                            <div className="chart-wrapper" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 0.2s' }}>
                                {chartData && (
                                    <Chart
                                        data={visibleFilteredData}
                                        sensors={displayHeaders}
                                        headers={displayHeaders}
                                        chartType={chartType}
                                    />
                                )}
                            </div>
                            {/* Chart Bottom Tab - Time Range & Sampling */}
                            <div className="chart-bottom-tab">
                                <div className="chart-tab-content">
                                    <div className="time-range-tab-group">
                                        <label>TIME RANGE</label>
                                        <div className="time-range-inputs">
                                            <div className="date-input-wrapper">
                                                <Calendar size={14} />
                                                <input
                                                    type="datetime-local"
                                                    value={dateRange?.start || ''}
                                                    onChange={(e) => setDateRange(prev => ({ start: e.target.value, end: prev?.end || '' }))}
                                                    placeholder="Start Date"
                                                />
                                            </div>
                                            <span className="separator">-</span>
                                            <div className="date-input-wrapper">
                                                <Calendar size={14} />
                                                <input
                                                    type="datetime-local"
                                                    value={dateRange?.end || ''}
                                                    onChange={(e) => setDateRange(prev => ({ start: prev?.start || '', end: e.target.value }))}
                                                    placeholder="End Date"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="time-range-tab-group">
                                        <label>SAMPLING (1 HR)</label>
                                        <div className="date-input-wrapper">
                                            <select
                                                value={samplingMethod}
                                                onChange={(e) => setSamplingMethod(e.target.value as 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last')}
                                                style={{
                                                    background: 'var(--input-bg)',
                                                    border: 'none',
                                                    color: 'var(--text-primary)',
                                                    fontSize: '0.8rem',
                                                    outline: 'none',
                                                    cursor: 'pointer',
                                                    padding: 0
                                                }}
                                            >
                                                <option value="raw" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Raw</option>
                                                <option value="avg" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Avg</option>
                                                <option value="max" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Max</option>
                                                <option value="min" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Min</option>
                                                <option value="first" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>First</option>
                                                <option value="last" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>Last</option>
                                            </select>
                                        </div>
                                    </div>
                                    {dataRange && (
                                        <button
                                            className="reset-range-btn"
                                            onClick={() => {
                                                const formatForInput = (dateStr: string) => {
                                                    try {
                                                        const date = new Date(dateStr);
                                                        if (isNaN(date.getTime())) return '';
                                                        const offset = date.getTimezoneOffset() * 60000;
                                                        const localISOTime = (new Date(date.getTime() - offset)).toISOString().slice(0, 16);
                                                        return localISOTime;
                                                    } catch (e) {
                                                        return '';
                                                    }
                                                };
                                                setDateRange({
                                                    start: formatForInput(dataRange.min),
                                                    end: formatForInput(dataRange.max)
                                                });
                                            }}
                                        >
                                            Reset
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="panel-collapsed-placeholder" />
                    )}

                    {/* Data Insight Section */}
                    {!collapsedPanels.has('data') ? (
                        <div className="widget-section data-widget" style={collapsedPanels.has('chart') ? { flex: '1' } : { height: '400px', flex: '0 0 400px' }}>
                            <div className="section-header collapsible-header">
                                <div className="section-header-left">
                                    <h3>Data Insight</h3>
                                    <span className="section-badge">{visibleFilteredData.length} Rows</span>
                                </div>
                                <div className="section-header-actions">
                                    <button
                                        className="export-btn-header"
                                        onClick={() => {
                                            if (visibleFilteredData.length === 0) return;
                                            const csvHeaders = ['Timestamp', ...displayHeaders].join(',');
                                            const csvRows = visibleFilteredData.map(row => {
                                                const values = [
                                                    row.timestamp || '',
                                                    ...row.values.map(v => v !== null ? v.toString() : '')
                                                ];
                                                return values.map(val => {
                                                    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                                                        return `"${val.replace(/"/g, '""')}"`;
                                                    }
                                                    return val;
                                                }).join(',');
                                            });
                                            const csvContent = [csvHeaders, ...csvRows].join('\n');
                                            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                                            const link = document.createElement('a');
                                            const url = URL.createObjectURL(blob);
                                            link.setAttribute('href', url);
                                            link.setAttribute('download', `sensor_data_${new Date().toISOString().slice(0, 10)}.csv`);
                                            link.style.visibility = 'hidden';
                                            document.body.appendChild(link);
                                            link.click();
                                            document.body.removeChild(link);
                                            URL.revokeObjectURL(url);
                                        }}
                                        title="Export to CSV"
                                        disabled={visibleFilteredData.length === 0}
                                    >
                                        <Download size={14} />
                                        Export dataset
                                    </button>
                                    <button
                                        className="collapse-btn"
                                        onClick={() => togglePanel('data')}
                                        title="Hide panel"
                                    >
                                        <EyeOff size={14} />
                                    </button>
                                </div>
                            </div>
                            <div className="widget-content">
                                {chartData && <DataTable headers={displayHeaders} data={visibleFilteredData} />}
                            </div>
                        </div>
                    ) : (
                        <div className="panel-collapsed-placeholder-small" />
                    )}
                </div>

                <div className="right-column">
                    {/* Sensors Section */}
                    {!collapsedPanels.has('sensors') ? (
                        <div className="widget-section">
                            <div className="section-header collapsible-header">
                                <div className="section-header-left">
                                    <h3>Recent Sensor Data</h3>
                                    <span className="section-badge">{sensorHeaders.length} Sensors</span>
                                </div>
                                <button
                                    className="collapse-btn"
                                    onClick={() => togglePanel('sensors')}
                                    title="Hide panel"
                                >
                                    <EyeOff size={14} />
                                </button>
                            </div>
                            <div className="widget-content">
                                <SensorSelection
                                    sensors={sensorHeaders}
                                    selectedSensors={selectedSensors}
                                    onSensorChange={setSelectedSensors}
                                    sensorMetadata={sensorMetadata}
                                />
                            </div>
                            <div className="widget-footer">
                                <button
                                    className="add-sensor-btn"
                                    onClick={async () => {
                                        const webview = new WebviewWindow('add-sensor', {
                                            url: '/?window=add-sensor',
                                            title: 'Add Special Sensor',
                                            width: 800,
                                            height: 700,
                                            center: true,
                                            alwaysOnTop: false,
                                            decorations: false
                                        });
                                        await webview.once('tauri://created', function () {
                                            // webview window successfully created
                                        });
                                        await webview.once('tauri://error', function (e) {
                                            // an error happened creating the webview window
                                            console.error(e);
                                        });
                                    }}
                                >
                                    <Plus size={16} />
                                    Add Special Sensor
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="panel-collapsed-placeholder-small" />
                    )}

                    {/* Filter Panel Section */}
                    {!collapsedPanels.has('filter') ? (
                        <div className="widget-section filter-widget">
                            <div className="section-header collapsible-header">
                                <div className="section-header-left">
                                    <h3>Filter & Controls</h3>
                                </div>
                                <button
                                    className="collapse-btn"
                                    onClick={() => togglePanel('filter')}
                                    title="Hide panel"
                                >
                                    <EyeOff size={14} />
                                </button>
                            </div>
                            <div className="widget-content filter-content">
                                <FilterPanel
                                    selectedSensors={selectedSensors}
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="panel-collapsed-placeholder-small" />
                    )}

                    {/* Save & Continue Section */}
                    <div className="save-continue-section">
                        <button
                            className="save-continue-btn"
                            onClick={async () => {
                                try {
                                    const screenW = window.screen.width;
                                    const screenH = window.screen.height;
                                    const webview = new WebviewWindow('failure-group', {
                                        url: '/?window=failure-group',
                                        title: 'Predictive Mode - Failure Group Creation',
                                        width: Math.round(screenW * 0.25),
                                        height: Math.round(screenH * 0.8),
                                        x: 15,
                                        y: Math.round(screenH * 0.1),
                                        decorations: false,
                                    });
                                    // Wait for the failure-group window to request data (after React mounts),
                                    // then respond and close the dashboard
                                    const unlisten = await listen('request-failure-group-data', async () => {
                                        await emit('failure-group-data', {
                                            sensorHeaders,
                                            sensorMetadata,
                                            metadata
                                        });
                                        unlisten();
                                        await getCurrentWindow().close();
                                    });
                                    webview.once('tauri://error', (e) => {
                                        console.error('Failed to create failure group window:', e);
                                    });
                                } catch (err) {
                                    console.error('Error opening failure group window:', err);
                                }
                            }}
                        >
                            Save & Continue
                            <ArrowRight size={16} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
});

export default Dashboard;
