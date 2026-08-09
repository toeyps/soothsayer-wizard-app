import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Split from 'split.js';
import { X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { SensorMetadata, SensorOperationConfig } from "../../types";
import SensorExplorer from "./SensorExplorer";
import SensorTooling from "./SensorTooling";

export default function AddSensorWindow() {
    const [sensors, setSensors] = useState<string[]>([]);
    const [selectedSensors, setSelectedSensors] = useState<string[]>([]);
    const [sensorMetadata, setSensorMetadata] = useState<SensorMetadata[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [operationConfig, setOperationConfig] = useState<SensorOperationConfig | null>(null);
    const [description, setDescription] = useState('');
    const [unit, setUnit] = useState('');
    const [component, setComponent] = useState('');

    // Formula mode state
    const [formulaMode, setFormulaMode] = useState(false);
    const [formulaExpression, setFormulaExpression] = useState('');
    const [formulaCustomName, setFormulaCustomName] = useState('');

    // Every click of "Add sensor" creates immediately and keeps the window
    // open (see handleAdd) rather than closing after exactly one -- so this
    // accumulates everything created so far this session, since Dashboard's
    // `add-sensor-selection` handler replaces its whole plotted selection on
    // each event rather than appending to it.
    const [pendingSensors, setPendingSensors] = useState<string[]>([]);

    const [nameMissing, setNameMissing] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // UI State
    const [searchTerm, setSearchTerm] = useState("");

    useEffect(() => {
        // Initialize Split.js
        const splitInstance = Split(['#split-0', '#split-1'], {
            sizes: [60, 40],
            minSize: [300, 150],
            gutterSize: 5,
            cursor: 'col-resize',
            direction: 'horizontal',
        });

        return () => {
            splitInstance.destroy();
        };
    }, []);

    useEffect(() => {
        // Load theme from localStorage
        const theme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', theme);


        let unlistenData: (() => void) | undefined;

        const setup = async () => {
            // 1. Listen for data from Dashboard (Rich data with metadata)
            unlistenData = await listen<{
                sensors: string[],
                selectedSensors: string[],
                sensorMetadata: SensorMetadata[]
            }>('sensors-data', (event) => {
                console.log("Received sensors-data:", event.payload);
                setSensors(event.payload.sensors);
                // Deliberately NOT pre-checking `event.payload.selectedSensors`
                // (whatever's currently plotted on the Dashboard chart) --
                // this window always starts with a clean, empty picker.
                // Pre-checking used to be harmless, but combined with the
                // default "+" chain (see useCalculationEngine), reopening
                // this window right after adding a sensor would pre-check
                // the same inputs AND show an already-active calculation
                // ready to submit -- indistinguishable from the screen right
                // before the previous "Add sensor" click, which read as "did
                // my sensor not get added?".
                setSensorMetadata(event.payload.sensorMetadata);
                setLoading(false);
            });

            // 2. Request data
            await emit('request-sensors');

            // 3. Fallback logic
            try {
                const allHeaders = await invoke<string[]>('get_all_sensors');
                if (allHeaders.length > 0) {
                    setSensors(prev => prev.length === 0 ? allHeaders.filter(h => h.trim().toLowerCase() !== 'timestamp') : prev);
                    setLoading(false);
                } else {
                    const paths = await invoke<string[]>('get_loaded_paths');
                    if (paths && paths.length > 0) {
                        await invoke("load_csv", { paths });
                        const retriedHeaders = await invoke<string[]>('get_all_sensors');
                        setSensors(prev => prev.length === 0 ? retriedHeaders.filter(h => h.trim().toLowerCase() !== 'timestamp') : prev);
                        setLoading(false);
                    }
                }
            } catch (err) {
                console.warn("Fallback loading failed:", err);
            }
        };

        setup();

        return () => {
            if (unlistenData) unlistenData();
            if (toastTimer.current) clearTimeout(toastTimer.current);
        };
    }, []);

    const handleClose = async () => {
        await getCurrentWindow().close();
    };

    const showToast = (message: string) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(message);
        toastTimer.current = setTimeout(() => setToast(null), 2200);
    };

    // Whether the current selection/operation would actually create a new
    // derived sensor (needs a name) vs. just adding the raw sensor(s)
    // through as-is (nothing to name). Mirrors SensorTooling's own
    // `creatingSomething`, computed here from the same config/formula state
    // it reports up via onConfigChange/onFormulaSubmit.
    const isCreatingSomething = (formulaMode && formulaExpression.trim() !== '') || operationConfig !== null;
    const currentName = formulaMode ? formulaCustomName : (operationConfig?.customName ?? '');

    /**
     * Run whatever calculation is currently configured (formula, legacy
     * config, or none -- "add as-is") and return the resulting sensor list
     * plus the master-data metadata (description/unit/component) for the
     * newly created sensor -- the same fields a mapping CSV row supplies
     * for an imported sensor.
     */
    const computeCurrentRound = async (): Promise<{ sensorsForEmit: string[]; newMetadata: SensorMetadata[] }> => {
        if (formulaMode && formulaExpression.trim()) {
            const newSensorName = await invoke<string>('evaluate_formula', {
                formula: formulaExpression,
                customName: formulaCustomName.trim() || null,
            });
            return {
                sensorsForEmit: [...selectedSensors, newSensorName],
                newMetadata: [{
                    tag: newSensorName,
                    description: description.trim() || formulaCustomName.trim(),
                    unit: unit.trim(),
                    component: component.trim() || 'Uncategorized',
                }],
            };
        }
        if (operationConfig) {
            const newSensorName = await invoke<string>('calculate_new_sensor', {
                sensors: selectedSensors,
                config: operationConfig,
            });
            return {
                sensorsForEmit: [...selectedSensors, newSensorName],
                newMetadata: [{
                    tag: newSensorName,
                    description: description.trim() || (operationConfig.customName ?? '').trim(),
                    unit: unit.trim(),
                    component: component.trim() || 'Uncategorized',
                }],
            };
        }
        return { sensorsForEmit: selectedSensors, newMetadata: [] };
    };

    // Creates the sensor currently configured, tells Dashboard about it right
    // away (so the chart updates immediately), clears the form for the next
    // one, and keeps the window open -- there's no separate "finish" step;
    // "Close" just closes once the user is done adding sensors.
    const handleAdd = async () => {
        if (isCreatingSomething && !currentName.trim()) {
            setNameMissing(true);
            return;
        }
        setNameMissing(false);
        setLoading(true);
        try {
            const { sensorsForEmit, newMetadata } = await computeCurrentRound();
            const nextPending = Array.from(new Set([...pendingSensors, ...sensorsForEmit]));
            setPendingSensors(nextPending);

            const createdName = newMetadata[0]?.tag;
            if (createdName) {
                // Make the new sensor pickable as an input for the next round
                // (e.g. building a second sensor on top of the first).
                setSensors(prev => (prev.includes(createdName) ? prev : [...prev, createdName]));
                setSensorMetadata(prev => {
                    const existing = prev ?? [];
                    return existing.some(m => m.tag === createdName) ? existing : [...existing, newMetadata[0]];
                });
            }

            await emit('add-sensor-selection', {
                sensors: nextPending,
                operation: null,
                newMetadata,
            });

            showToast(createdName ? `Added: ${newMetadata[0].description || createdName}` : `Added ${sensorsForEmit.length} sensor(s)`);

            // Reset the picker for the next round.
            setSelectedSensors([]);
            setOperationConfig(null);
            setFormulaMode(false);
            setFormulaExpression('');
            setFormulaCustomName('');
            setDescription('');
            setUnit('');
            setComponent('');
        } catch (err) {
            console.error("Failed to add sensor:", err);
            alert("Failed: " + String(err));
        } finally {
            setLoading(false);
        }
    };

    const handleSensorToggle = (sensor: string) => {
        setSelectedSensors(prev => {
            if (prev.includes(sensor)) {
                return prev.filter(s => s !== sensor);
            } else {
                return [...prev, sensor];
            }
        });
    };

    const handleFormulaSubmit = useCallback((formula: string, customName?: string) => {
        setFormulaMode(true);
        setFormulaExpression(formula);
        setFormulaCustomName(customName || '');
        setNameMissing(false);
    }, []);

    const handleConfigChange = useCallback((config: SensorOperationConfig | null) => {
        setFormulaMode(false);
        setOperationConfig(config);
        setNameMissing(false);
    }, []);

    const filteredSensors = useMemo(() => {
        if (!searchTerm) return sensors;
        const lowerTerm = searchTerm.toLowerCase();
        return sensors.filter(s => {
            const meta = sensorMetadata?.find(m => m.tag === s);
            const searchStr = meta
                ? `${s} ${meta.description} ${meta.component} ${meta.unit}`.toLowerCase()
                : s.toLowerCase();
            return searchStr.includes(lowerTerm);
        });
    }, [sensors, searchTerm, sensorMetadata]);


    return (
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', position: 'relative' }}>
            {/* Header — matches View Table dialog (.pair-regl-modal-header) */}
            <div data-tauri-drag-region className="flex justify-between items-center gap-3 shrink-0" style={{ padding: '12px 16px', backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="pointer-events-none" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>Add Special Sensor</h2>
                <button
                    onClick={handleClose}
                    className="scatter-regl-btn scatter-regl-btn-icon"
                    title="Close"
                >
                    <X size={14} />
                </button>
            </div>

            {/* Main Content (Split.js) */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
                {/* Left: Explorer */}
                <div id="split-0" className="flex flex-col h-full min-h-0 divide-y" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex-1 min-h-0 overflow-hidden">
                        {loading ? (
                            <div className="flex items-center justify-center h-full" style={{ color: 'var(--text-secondary)' }}>Loading...</div>
                        ) : (
                            <SensorExplorer
                                sensors={filteredSensors}
                                sensorMetadata={sensorMetadata}
                                selectedSensors={selectedSensors}
                                onToggleSensor={handleSensorToggle}
                                searchTerm={searchTerm}
                                onSearchChange={setSearchTerm}
                            />
                        )}
                    </div>
                </div>

                {/* Right: Tooling */}
                <div id="split-1" className="flex flex-col h-full overflow-hidden" style={{ backgroundColor: 'var(--bg-secondary)' }}>
                    <div className="px-4 py-2 text-xs font-bold tracking-wider uppercase border-b" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                        Tooling
                    </div>
                    <div className="flex-1 overflow-hidden">
                        <SensorTooling
                            selectedSensors={selectedSensors}
                            sensorMetadata={sensorMetadata}
                            onConfigChange={handleConfigChange}
                            onRemoveSensor={handleSensorToggle}
                            onFormulaSubmit={handleFormulaSubmit}
                            onDescriptionChange={setDescription}
                            onUnitChange={setUnit}
                            onComponentChange={setComponent}
                        />
                    </div>
                </div>
            </div>

            {/* Footer */}
            <div className="flex flex-col gap-2 px-4 py-3 border-t shrink-0" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
                {nameMissing && (
                    <p className="text-xs" style={{ color: 'var(--danger)' }}>
                        Give this sensor a name before adding it.
                    </p>
                )}
                <div className="flex justify-end gap-2">
                    <button onClick={handleClose} className="px-4 py-1.5 rounded text-sm" style={{ backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>Close</button>
                    <button onClick={handleAdd} className="px-4 py-1.5 rounded text-white text-sm font-medium" style={{ backgroundColor: 'var(--accent-color)' }}>Add sensor</button>
                </div>
            </div>

            {/* Toast */}
            {toast && (
                <div
                    className="text-xs rounded shadow-lg"
                    style={{
                        position: 'absolute',
                        bottom: 16,
                        right: 16,
                        padding: '10px 14px',
                        backgroundColor: 'var(--card-bg)',
                        border: '1px solid var(--ok)',
                        color: 'var(--ok)',
                    }}
                >
                    ✓ {toast}
                </div>
            )}
        </div>
    );
}
