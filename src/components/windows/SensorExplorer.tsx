import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, Folder, FileText } from 'lucide-react';
import { SensorMetadata } from '../../types';

interface SensorExplorerProps {
    sensors: string[];
    sensorMetadata: SensorMetadata[] | null;
    selectedSensors: string[];
    onToggleSensor: (sensor: string) => void;
    searchTerm: string;
    onSearchChange: (term: string) => void;
}

export default function SensorExplorer({
    sensors,
    sensorMetadata,
    selectedSensors,
    onToggleSensor,
    searchTerm,
    onSearchChange
}: SensorExplorerProps) {
    const [expandedComponents, setExpandedComponents] = useState<Set<string>>(new Set());
    const [isAllExpanded, setIsAllExpanded] = useState(true);

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

    // Helper to render a sensor item
    const renderSensorItem = (sensor: string) => {
        const isSelected = selectedSensors.includes(sensor);
        const meta = sensorMetadata?.find(m => m.tag === sensor);

        return (
            <div
                key={sensor}
                className={`flex items-center gap-2 px-6 py-1 cursor-pointer hover:bg-[#2a2d2e] ${isSelected ? 'bg-[#37373d]' : ''}`}
                onClick={(e) => {
                    e.stopPropagation();
                    onToggleSensor(sensor);
                }}
            >
                <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => { }}
                    className="cursor-pointer"
                />
                <FileText size={14} className="text-[#858585] shrink-0" />
                <span className={`text-sm truncate ${isSelected ? 'text-white' : 'text-[#cccccc]'}`} title={sensor}>
                    {meta ? meta.description : sensor}
                </span>
                {meta && (
                    <span className="text-xs text-[#6b7280] ml-auto font-mono">
                        {meta.tag}
                    </span>
                )}
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full bg-[#18181b] border-r border-[#27272a] text-[#cccccc]">
            {/* Search Header */}
            <div className="p-3 border-b border-[#27272a]">
                <input
                    type="text"
                    placeholder="Search sensors..."
                    value={searchTerm}
                    onChange={(e) => onSearchChange(e.target.value)}
                    className="w-full bg-[#27272a] border border-[#3f3f46] text-sm px-2 py-1.5 focus:outline-none focus:border-[#007fd4] placeholder-[#6b7280] text-white"
                />
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="px-4 py-2 text-xs font-bold text-[#6b7280] tracking-wider">
                    EXPLORER
                </div>

                <div className="flex flex-col">
                    {/* All Components Root */}
                    <div>
                        <div
                            className="cursor-pointer hover:bg-[#2a2d2e] px-2 py-1 text-sm flex items-center gap-1.5 text-[#cccccc]"
                            onClick={() => setIsAllExpanded(!isAllExpanded)}
                        >
                            {isAllExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span className="font-semibold">All Components</span>
                        </div>

                        {isAllExpanded && (
                            <div className="ml-0">
                                {groupedSensors.sortedKeys.map(comp => {
                                    const isExpanded = expandedComponents.has(comp);
                                    const count = groupedSensors.groups[comp].length;

                                    return (
                                        <div key={comp}>
                                            <div
                                                className="cursor-pointer hover:bg-[#2a2d2e] px-4 py-1 text-sm flex items-center gap-2 text-[#cccccc]"
                                                onClick={() => toggleComponent(comp)}
                                            >
                                                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                <Folder size={14} className="text-[#eab308]" />
                                                <span className="truncate">{comp}</span>
                                                <span className="text-xs text-[#6b7280] ml-auto">{count}</span>
                                            </div>

                                            {isExpanded && (
                                                <div className="ml-0 border-l border-[#3f3f46]/50 ml-[22px]">
                                                    {groupedSensors.groups[comp].map(sensor => renderSensorItem(sensor))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}

                                {/* Items with no component */}
                                {groupedSensors.noComponent.length > 0 && (
                                    groupedSensors.noComponent.map(sensor => renderSensorItem(sensor))
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
