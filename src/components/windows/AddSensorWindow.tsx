import { useState, useEffect, useMemo } from "react";
import Split from 'split.js';
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
                setSelectedSensors(event.payload.selectedSensors);
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
        };
    }, []);

    const handleClose = async () => {
        await getCurrentWindow().close();
    };

    const handleAdd = async () => {
        if (operationConfig?.mode === 'single' && selectedSensors.length > 1) {
            alert("Only one sensor allowed for Single Calculation mode!");
            return;
        }

        setLoading(true);
        try {
            // If operation config is set, perform calculation on backend
            if (operationConfig) {
                const newSensorName = await invoke<string>('calculate_new_sensor', {
                    sensors: selectedSensors,
                    config: operationConfig
                });

                // After calculation, we want to select the NEW sensor AND the input sensors.
                await emit('add-sensor-selection', {
                    sensors: [...selectedSensors, newSensorName],
                    operation: null // Reset operation since it's now a "real" sensor
                });
            } else {
                // No operation, just adding selected sensors
                await emit('add-sensor-selection', {
                    sensors: selectedSensors,
                    operation: null
                });
            }
            await handleClose();
        } catch (err) {
            console.error("Failed to update sensor:", err);
            alert("Failed to update sensor: " + String(err));
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

    // Filter Logic for Explorer (passed down, or just pass filtered list?)
    // SensorExplorer now handles grouping. We should pass the FILTERED list to it?
    // Or pass all and let it filter?
    // Current SensorExplorer implementation takes `sensors` and `sensorMetadata`.
    // It groups what it receives. So we should filter BEFORE passing if we want search to work effectively
    // across the whole tree (or let Explorer handle search internally? Explorer props has searchTerm).
    // Let's pass the filtered list to Explorer so it only renders matching nodes.
    // Let's pass the filtered list to Explorer so it only renders matching nodes.

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
        <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
            {/* Header */}
            <div data-tauri-drag-region className="flex justify-between items-center px-4 py-3 shrink-0" style={{ backgroundColor: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
                <h2 className="text-sm font-semibold pointer-events-none" style={{ color: 'var(--text-primary)' }}>Add Special Sensor</h2>
                <button onClick={handleClose} className="hover:opacity-80" style={{ color: 'var(--text-secondary)' }}>&times;</button>
            </div>

            {/* Main Content (Split.js) */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
                {/* Left: Selected List + Explorer */}
                {/* Left: Explorer Only */}
                <div id="split-0" className="flex flex-col h-full min-h-0 divide-y" style={{ borderColor: 'var(--border)' }}>
                    {/* Explorer */}
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
                            onConfigChange={setOperationConfig}
                            onRemoveSensor={handleSensorToggle}
                        />
                    </div>
                </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 px-4 py-3 border-t shrink-0" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
                <button onClick={handleClose} className="px-4 py-1.5 rounded text-sm" style={{ backgroundColor: 'var(--input-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>Cancel</button>
                <button onClick={handleAdd} className="px-4 py-1.5 rounded text-white text-sm font-medium" style={{ backgroundColor: 'var(--accent-color)' }}>Update Sensors</button>
            </div>
        </div>
    );
}
