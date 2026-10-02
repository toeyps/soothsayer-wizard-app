import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, Search, Plus, Check } from 'lucide-react';
import { SensorMetadata } from '../../types';

interface SensorExplorerProps {
    sensors: string[];
    sensorMetadata: SensorMetadata[] | null;
    selectedSensors: string[];
    onToggleSensor: (sensor: string) => void;
    searchTerm: string;
    onSearchChange: (term: string) => void;
}

/**
 * Left column of the Create tab — search + a flat-per-component list of
 * every sensor, each row toggled as a source with a click (an "Added" pill
 * when picked, a bare + icon otherwise). Visual refresh Phase 5
 * (2026-10-02): this used to render in a hardcoded VS Code-dark palette
 * (#18181b/#27272a/#3f3f46/#eab308/#007fd4) that never read any of the
 * app's own theme tokens — the single biggest reason this whole window
 * still looked like "the old app" after the token-only Phases 0-4 (those
 * phases only retuned CSS custom-property VALUES on existing markup; this
 * component's colours were never custom properties to begin with). Restyled
 * onto the shared tokens + the same `.sens`-row look (checkbox replaced by
 * an added-pill/+-icon, matching the approved prototype's own
 * `specialModal()` left column) the rest of the app's sensor pickers
 * already use. Component-grouping is kept (a deliberate superset of the
 * prototype's flat list — this app's established sensor-picker convention
 * elsewhere, e.g. SensorSelection.tsx, also groups by component) rather
 * than flattened to match the prototype literally; every prop/handler is
 * unchanged.
 */
export default function SensorExplorer({
    sensors,
    sensorMetadata,
    selectedSensors,
    onToggleSensor,
    searchTerm,
    onSearchChange
}: SensorExplorerProps) {
    const [expandedComponents, setExpandedComponents] = useState<Set<string>>(new Set());

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
            const meta = sensorMetadata?.find(m => m.tag === sensor);
            if (meta && meta.component) {
                if (!groups[meta.component]) {
                    groups[meta.component] = [];
                }
                groups[meta.component].push(sensor);
            } else {
                noComponent.push(sensor);
            }
        });

        // Sort keys
        const sortedKeys = Object.keys(groups).sort();

        return { groups, sortedKeys, noComponent };
    }, [sensors, sensorMetadata]);

    // While searching, every group that still has a match opens automatically
    // — same convention as SensorSelection.tsx's sensor list.
    const isExpanded = (comp: string) => searchTerm.trim() !== '' || expandedComponents.has(comp);

    const renderSensorItem = (sensor: string) => {
        const isSelected = selectedSensors.includes(sensor);
        const meta = sensorMetadata?.find(m => m.tag === sensor);

        return (
            <div
                key={sensor}
                className="special-sensor-row"
                onClick={() => onToggleSensor(sensor)}
            >
                <div className="special-sensor-row-main">
                    <span className="special-sensor-row-name">{meta ? meta.description : sensor}</span>
                    {/* Only shown alongside a real description -- when there's
                        no metadata, the name above already falls back to the
                        bare tag, so repeating it here would just duplicate
                        the same text (matches SensorSelection.tsx's row). */}
                    {meta && <span className="sensor-row-tag">{sensor}</span>}
                </div>
                {isSelected ? (
                    <span className="special-sensor-added-pill"><Check size={10} /> Added</span>
                ) : (
                    <span className="special-sensor-add-icon" title="Add as a source"><Plus size={13} /></span>
                )}
            </div>
        );
    };

    return (
        <div className="special-sensor-explorer">
            <div className="special-sensor-explorer-search">
                <Search size={14} />
                <input
                    type="text"
                    placeholder="Search sensors..."
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
    );
}
