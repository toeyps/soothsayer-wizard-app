import { memo, useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, Search, Plus, Check } from 'lucide-react';
import { SensorMetadata } from '../../types';
import { SensorLabel } from '../sensor/SensorLabel';
import { SensorMetaContext, useLayeredSensorLookup } from '../sensor/sensorInfo';

interface SensorExplorerProps {
    sensors: string[];
    sensorMetadata: SensorMetadata[] | null;
    selectedSensors: string[];
    onToggleSensor: (sensor: string) => void;
    /** Formula editor: the row's small `$` button inserts `$TAG` at the editor's caret
     *  instead of picking the row. Omitted = no button. */
    onInsertSensor?: (sensor: string) => void;
    searchTerm: string;
    onSearchChange: (term: string) => void;
}

/**
 * Left column of the Create tab — search + a per-component list of every
 * sensor. A click PICKS the row for Quick build (a "Picked" pill, the group
 * header counts the picks); the small `$` button on the row inserts `$TAG` at
 * the formula editor's caret instead.
 * Memoised: the window re-renders on every keystroke in the editor, and the
 * list only needs to when its own props change.
 */
function SensorExplorer({
    sensors,
    sensorMetadata,
    selectedSensors,
    onToggleSensor,
    onInsertSensor,
    searchTerm,
    onSearchChange
}: SensorExplorerProps) {
    const [expandedComponents, setExpandedComponents] = useState<Set<string>>(new Set());
    // Rows use the stacked SensorLabel from this list's own metadata (O(1) per
    // row, layered on the window's provider so the ƒ / Σ badges come through).
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);

    const toggleComponent = (comp: string) => {
        const newSet = new Set(expandedComponents);
        if (newSet.has(comp)) {
            newSet.delete(comp);
        } else {
            newSet.add(comp);
        }
        setExpandedComponents(newSet);
    };

    // Group sensors by component
    const groupedSensors = useMemo(() => {
        const groups: Record<string, string[]> = {};
        const noComponent: string[] = [];

        sensors.forEach(sensor => {
            const component = sensorLookup(sensor).component;
            if (component) {
                if (!groups[component]) {
                    groups[component] = [];
                }
                groups[component].push(sensor);
            } else {
                noComponent.push(sensor);
            }
        });

        // Sort keys
        const sortedKeys = Object.keys(groups).sort();

        return { groups, sortedKeys, noComponent };
    }, [sensors, sensorLookup]);

    // While searching, every group that still has a match opens automatically
    // — same convention as SensorSelection.tsx's sensor list.
    const isExpanded = (comp: string) => searchTerm.trim() !== '' || expandedComponents.has(comp);

    const renderSensorItem = (sensor: string) => {
        const isSelected = selectedSensors.includes(sensor);

        return (
            <div
                key={sensor}
                className={`special-sensor-row${isSelected ? ' is-picked' : ''}`}
                onClick={() => onToggleSensor(sensor)}
                title={isSelected ? 'Picked for Quick build — click to un-pick' : 'Click to pick for Quick build'}
            >
                <div className="special-sensor-row-main">
                    <SensorLabel tag={sensor} />
                </div>
                {onInsertSensor && (
                    <button
                        type="button"
                        className="special-sensor-row-ins"
                        title="Insert at the cursor in the formula"
                        aria-label={`Insert ${sensor} in the formula`}
                        onMouseDown={e => e.preventDefault()}
                        onClick={(e) => { e.stopPropagation(); onInsertSensor(sensor); }}
                    >
                        $
                    </button>
                )}
                {isSelected ? (
                    <span className="special-sensor-added-pill"><Check size={10} /> Picked</span>
                ) : (
                    <span className="special-sensor-add-icon" title="Pick for Quick build"><Plus size={13} /></span>
                )}
            </div>
        );
    };

    return (
        <SensorMetaContext.Provider value={sensorLookup}>
        <div className="special-sensor-explorer">
            <div className="special-sensor-explorer-search">
                <Search size={14} />
                <input
                    type="text"
                    placeholder="Search description, tag, unit or component…"
                    value={searchTerm}
                    onChange={(e) => onSearchChange(e.target.value)}
                />
            </div>

            <div className="special-sensor-explorer-list custom-scrollbar">
                {groupedSensors.sortedKeys.map(comp => {
                    const expanded = isExpanded(comp);
                    const count = groupedSensors.groups[comp].length;
                    const picked = groupedSensors.groups[comp].filter(s => selectedSensors.includes(s)).length;

                    return (
                        <div key={comp}>
                            <div
                                className="special-sensor-explorer-group-header"
                                onClick={() => toggleComponent(comp)}
                            >
                                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                <span className="special-sensor-explorer-group-name">{comp}</span>
                                <span className="special-sensor-explorer-group-count">
                                    {picked > 0 ? <><b>{picked}</b> / {count}</> : count}
                                </span>
                            </div>
                            {expanded && groupedSensors.groups[comp].map(sensor => renderSensorItem(sensor))}
                        </div>
                    );
                })}

                {groupedSensors.noComponent.length > 0 && groupedSensors.noComponent.map(sensor => renderSensorItem(sensor))}

                {sensors.length === 0 && (
                    <div className="special-sensor-explorer-empty">No sensors found</div>
                )}
            </div>
        </div>
        </SensorMetaContext.Provider>
    );
}

export default memo(SensorExplorer);
