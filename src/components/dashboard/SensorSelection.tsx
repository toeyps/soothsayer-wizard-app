import { useState, useMemo } from 'react';
import { Filter } from 'lucide-react';
import { SensorMetadata } from '../../types';



interface SensorSelectionProps {
    sensors: string[];
    selectedSensors: string[];
    onSensorChange: (sensors: string[]) => void;
    sensorMetadata: SensorMetadata[] | null;
}

export default function SensorSelection({
    sensors,
    selectedSensors,
    onSensorChange,
    sensorMetadata
}: SensorSelectionProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [showSelectedOnly, setShowSelectedOnly] = useState(false);
    const [isFilterExpanded, setIsFilterExpanded] = useState(false);

    const handleSensorToggle = (sensor: string) => {
        if (selectedSensors.includes(sensor)) {
            onSensorChange(selectedSensors.filter(s => s !== sensor));
        } else {
            onSensorChange([...selectedSensors, sensor]);
        }
    };

    const getMetadata = (sensor: string) => {
        if (!sensorMetadata) return null;
        const normalizedSensor = sensor.trim().toLowerCase();
        return sensorMetadata.find(m => m.tag.trim().toLowerCase() === normalizedSensor);
    };

    // Extract unique components and sort them
    const uniqueComponents = useMemo(() => {
        if (!sensorMetadata) return [];
        const comps = new Set(sensorMetadata.map(m => m.component).filter(Boolean));
        return Array.from(comps).sort();
    }, [sensorMetadata]);

    // Initialize selected components with all available components by default? 
    // Or start empty means "all"? usually empty means all, or we check all by default.
    // Let's use empty array = all selected (or easier: check all by default).
    // Let's go with: if empty, show all. If any selected, show only those.
    // Actually, for a checkbox list, typically you want "All" or specific ones. 
    // Let's use a Set for O(1) lookups.
    const [selectedComponents, setSelectedComponents] = useState<Set<string>>(new Set());

    const toggleComponent = (comp: string) => {
        const newSet = new Set(selectedComponents);
        if (newSet.has(comp)) {
            newSet.delete(comp);
        } else {
            newSet.add(comp);
        }
        setSelectedComponents(newSet);
    };


    const filteredSensors = sensors.filter(s => {
        const meta = getMetadata(s);

        // Show Selected Only Filter
        if (showSelectedOnly && !selectedSensors.includes(s)) {
            return false;
        }

        // Component Filter
        // If selectedComponents is not empty, we strictly check if the sensor's component is in it.
        // If it IS empty, we treat it as "Show All" (standard behavior for "no filters applied")?
        // OR should we initialize with ALL checked? 
        // User request: "ติ้กเลือกได้หลาย component" (tick to choose multiple components).
        // Let's assume if nothing is checked, show everything (default state). 
        // EXCEPT if the user explicitly unchecked everything? 
        // Let's stick to: Empty set = Show All. 
        if (selectedComponents.size > 0) {
            if (!meta || !meta.component || !selectedComponents.has(meta.component)) {
                return false;
            }
        }

        // Search Filter
        const searchTarget = meta
            ? `${s} ${meta.description} ${meta.component} ${meta.unit}`.toLowerCase()
            : s.toLowerCase();
        return searchTarget.includes(searchTerm.toLowerCase());
    });



    const handleDeselectAll = () => {
        const newSelected = selectedSensors.filter(s => !filteredSensors.includes(s));
        onSensorChange(newSelected);
    };

    return (
        <div className="sensor-selection-widget h-full flex flex-col">
            <div className="widget-header flex-shrink-0" style={{ flexDirection: 'column', gap: '8px', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                        type="text"
                        placeholder="Search sensors..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        className="search-input-compact"
                        style={{ flex: 1 }}
                    />
                    <button
                        className="text-btn"
                        onClick={() => setIsFilterExpanded(!isFilterExpanded)}
                        style={{
                            border: isFilterExpanded ? '1px solid #3b82f6' : '1px solid #334155',
                            backgroundColor: isFilterExpanded ? '#1e293b' : 'transparent',
                            color: isFilterExpanded ? '#3b82f6' : 'inherit',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                    >
                        <Filter size={14} />
                        {(selectedComponents.size > 0 || showSelectedOnly) && '•'}
                    </button>
                </div>

                {isFilterExpanded && (
                    <div style={{
                        borderTop: '1px solid #334155',
                        paddingTop: '8px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.875rem', cursor: 'pointer', userSelect: 'none' }}>
                                <input
                                    type="checkbox"
                                    checked={showSelectedOnly}
                                    onChange={e => setShowSelectedOnly(e.target.checked)}
                                />
                                Show Selected Only
                            </label>
                            <span style={{ width: '1px', height: '16px', backgroundColor: '#334155', margin: '0 4px' }}></span>
                            <button className="text-btn" style={{ fontSize: '0.75rem' }} onClick={() => setSelectedComponents(new Set())}>Clear Comps</button>
                        </div>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {uniqueComponents.map(comp => (
                                <label
                                    key={comp}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '4px',
                                        padding: '2px 6px',
                                        backgroundColor: selectedComponents.has(comp) ? '#1d283a' : '#0f172a',
                                        border: `1px solid ${selectedComponents.has(comp) ? '#3b82f6' : '#334155'}`,
                                        borderRadius: '4px',
                                        fontSize: '0.75rem',
                                        cursor: 'pointer',
                                        userSelect: 'none',
                                        color: selectedComponents.has(comp) ? '#60a5fa' : 'inherit'
                                    }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedComponents.has(comp)}
                                        onChange={() => toggleComponent(comp)}
                                        style={{ display: 'none' }} // Hide default checkbox, style the label
                                    />
                                    {comp}
                                </label>
                            ))}
                        </div>
                    </div>
                )}

                <div className="sensor-actions-compact" style={{ alignSelf: 'flex-end', marginTop: isFilterExpanded ? '4px' : '0' }}>
                    <span style={{ fontSize: '0.75rem', color: '#64748b', marginRight: 'auto' }}>
                        Showing {filteredSensors.length} / {sensors.length}
                    </span>
                    <button className="text-btn" onClick={handleDeselectAll}>Clear</button>
                </div>
            </div>

            <div className="sensor-list-widget flex-1 min-h-0 overflow-y-auto">
                <div className="sensor-list-header-row">
                    <span>Sensor</span>
                    <span>Component</span>
                </div>
                {filteredSensors.map(sensor => (
                    <div
                        key={sensor}
                        className="sensor-list-row"
                        onClick={() => handleSensorToggle(sensor)}
                        style={{ cursor: 'pointer' }}
                    >
                        <div className="checkbox-wrapper">
                            <input
                                type="checkbox"
                                id={`sensor-${sensor}`}
                                checked={selectedSensors.includes(sensor)}
                                onChange={() => handleSensorToggle(sensor)}
                                onClick={(e) => e.stopPropagation()}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <label htmlFor={`sensor-${sensor}`} onClick={(e) => e.stopPropagation()} style={{ cursor: 'pointer', fontWeight: 500 }}>
                                    {(() => {
                                        const meta = getMetadata(sensor);
                                        if (meta) {
                                            return (
                                                <>
                                                    {meta.description}
                                                    <span style={{ marginLeft: '6px', fontSize: '0.8em', color: '#94a3b8', fontWeight: 400 }}>
                                                        ({meta.unit})
                                                    </span>
                                                </>
                                            );
                                        }
                                        return sensor;
                                    })()}
                                </label>
                                {(() => {
                                    const meta = getMetadata(sensor);
                                    if (meta) {
                                        return (
                                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                {meta.tag} • {meta.unit}
                                            </span>
                                        );
                                    }
                                    return null;
                                })()}
                            </div>
                        </div>
                        {(() => {
                            const meta = getMetadata(sensor);
                            if (meta && meta.component) {
                                return (
                                    <span style={{
                                        backgroundColor: '#1d283a',
                                        color: '#60a5fa',
                                        padding: '2px 8px',
                                        borderRadius: '12px',
                                        fontSize: '0.75rem',
                                        border: '1px solid #334155',
                                        whiteSpace: 'nowrap'
                                    }}>
                                        {meta.component}
                                    </span>
                                );
                            }
                            return null;
                        })()}
                    </div>
                ))}
                {filteredSensors.length === 0 && (
                    <div className="no-results">No sensors found</div>
                )}
            </div>
        </div>
    );
}
