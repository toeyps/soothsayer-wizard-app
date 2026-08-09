import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, FolderPlus, X, Plus, Pencil, Trash2, Check, Bell } from 'lucide-react';
import { SensorMetadata, FailureGroup, FailureSensorRow, AlarmLevel } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { ALARM_LEVELS, ALARM_LABELS, isCriticalAlarmLevel, alarmLevelColor, hasAlarmSetpoints } from '../../utils/alarmLevels';



interface SensorSelectionProps {
    sensors: string[];
    selectedSensors: string[];
    onSensorChange: (sensors: string[]) => void;
    sensorMetadata: SensorMetadata[] | null;
    fgGroups: FailureGroup[];
    fgRows: FailureSensorRow[];
    getGroupColor: (groupNo: number) => string;
    onToggleSensorGroup: (tag: string, groupNo: number) => void;
    onCreateGroupForSensor: (tag: string, name: string) => void;
    onRenameGroup: (groupNo: number, name: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    /** Which alarm setpoint lines are toggled on, per sensor tag. */
    alarmLinesEnabled: Record<string, AlarmLevel[]>;
    onToggleAlarmLine: (tag: string, level: AlarmLevel) => void;
}

const UNCATEGORIZED = 'Uncategorized';

export default function SensorSelection({
    sensors,
    selectedSensors,
    onSensorChange,
    sensorMetadata,
    fgGroups,
    fgRows,
    getGroupColor,
    onToggleSensorGroup,
    onCreateGroupForSensor,
    onRenameGroup,
    onDeleteGroup,
    alarmLinesEnabled,
    onToggleAlarmLine,
}: SensorSelectionProps) {
    const [searchTerm, setSearchTerm] = useState('');
    // Component groups the user has manually expanded. Everything starts
    // collapsed — browsing means opening a component to see its sensors,
    // not scanning a flat 133-row list.
    const [expandedComponents, setExpandedComponents] = useState<Set<string>>(new Set());
    // Which sensor's failure-group menu is open, and the draft text for its
    // inline "new group" input. A sensor can belong to more than one group,
    // so this is a toggleable checklist, not a single-select assignment.
    const [groupMenuFor, setGroupMenuFor] = useState<string | null>(null);
    const [newGroupDraft, setNewGroupDraft] = useState('');
    // Which sensor's alarm-setpoint checkbox list is open. Closed by default
    // for every sensor — the icon only appears when the sensor actually HAS
    // a setpoint (see `hasAlarmSetpoints` below), and clicking it is the only
    // way to reveal the checkboxes. Checking a sensor into the chart does
    // NOT auto-open this — the user explicitly asked for click-only.
    const [alarmPanelFor, setAlarmPanelFor] = useState<string | null>(null);
    // Which group (by `no`) is being renamed inline, and its draft text.
    // Group identity is global, so this isn't scoped to a particular sensor —
    // only one group can be mid-rename across the whole panel at a time.
    const [editingGroupNo, setEditingGroupNo] = useState<number | null>(null);
    const [editGroupDraft, setEditGroupDraft] = useState('');

    const handleSensorToggle = (sensor: string) => {
        if (selectedSensors.includes(sensor)) {
            onSensorChange(selectedSensors.filter(s => s !== sensor));
        } else {
            onSensorChange([...selectedSensors, sensor]);
        }
    };

    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getMetadata = (sensor: string) => sensorMetaMap.get(normalizeSensorTag(sensor));

    const matchesSearch = (sensor: string) => {
        if (!searchTerm) return true;
        const meta = getMetadata(sensor);
        const searchTarget = meta
            ? `${sensor} ${meta.description} ${meta.component} ${meta.unit}`.toLowerCase()
            : sensor.toLowerCase();
        return searchTarget.includes(searchTerm.toLowerCase());
    };

    const filteredSensors = useMemo(
        () => sensors.filter(matchesSearch),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [sensors, searchTerm, sensorMetadata]
    );

    // Sensors grouped by component, sorted alphabetically by component name
    // and, within each group, by sensor label. Sensors without a mapped
    // component (or no mapping loaded at all) fall into "Uncategorized"
    // rather than disappearing.
    const groupedSensors = useMemo(() => {
        const groups = new Map<string, string[]>();
        for (const s of filteredSensors) {
            const comp = getMetadata(s)?.component || UNCATEGORIZED;
            if (!groups.has(comp)) groups.set(comp, []);
            groups.get(comp)!.push(s);
        }
        return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filteredSensors, sensorMetadata]);

    const toggleComponentExpanded = (comp: string) => {
        setExpandedComponents(prev => {
            const next = new Set(prev);
            if (next.has(comp)) next.delete(comp);
            else next.add(comp);
            return next;
        });
    };

    // While actively searching, force every matching group open — the user
    // is looking for a specific sensor, not browsing by system, so nothing
    // should hide behind a collapsed header. Manual expand/collapse state
    // still applies once the search box is cleared.
    const isComponentExpanded = (comp: string) =>
        searchTerm !== '' || expandedComponents.has(comp);

    const isFilterActive = searchTerm !== '';

    const handleClearFilter = () => {
        setSearchTerm('');
    };

    const renderSensorRow = (sensor: string) => {
        const meta = getMetadata(sensor);
        const memberGroups = fgGroups.filter(g =>
            g.no !== 0 && fgRows.some(r => r.groupNo === g.no && r.mappedSensorTag.toLowerCase() === sensor.toLowerCase())
        );
        const menuOpen = groupMenuFor === sensor;
        // The bell only appears at all when the sensor has at least one
        // setpoint value — independent of whether it's currently checked
        // into the chart, so it's browsable before deciding to plot. The
        // checkbox list itself only opens on click; checking the sensor's
        // own box does NOT auto-reveal it.
        const hasAlarms = hasAlarmSetpoints(meta);
        const alarmOpen = alarmPanelFor === sensor;
        return (
            <div
                key={sensor}
                className="sensor-list-row"
                onClick={() => handleSensorToggle(sensor)}
                style={{ cursor: 'pointer', flexDirection: 'column', alignItems: 'stretch', position: 'relative' }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                                {meta ? (
                                    <>
                                        {meta.description}
                                        {meta.unit && (
                                            <span style={{ marginLeft: '6px', fontSize: '0.8em', color: '#94a3b8', fontWeight: 400 }}>
                                                ({meta.unit})
                                            </span>
                                        )}
                                    </>
                                ) : sensor}
                            </label>
                            {meta && (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    {meta.tag} • {meta.unit}
                                </span>
                            )}
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                        {hasAlarms && (
                            <button
                                onClick={(e) => { e.stopPropagation(); setAlarmPanelFor(alarmOpen ? null : sensor); }}
                                title="Alarm setpoints"
                                style={{
                                    background: alarmOpen ? 'var(--hover-bg)' : 'none',
                                    border: 'none', borderRadius: '4px',
                                    color: 'var(--text-secondary)',
                                    cursor: 'pointer', padding: '4px', display: 'flex',
                                }}
                            >
                                <Bell size={14} />
                            </button>
                        )}
                        <button
                            onClick={(e) => { e.stopPropagation(); setGroupMenuFor(menuOpen ? null : sensor); }}
                            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setGroupMenuFor(sensor); }}
                            title="Add to failure group"
                            style={{
                                background: menuOpen ? 'var(--hover-bg)' : 'none',
                                border: 'none', borderRadius: '4px',
                                color: 'var(--text-secondary)',
                                cursor: 'pointer', padding: '4px', display: 'flex',
                            }}
                        >
                            <FolderPlus size={14} />
                        </button>
                    </div>
                </div>
                {memberGroups.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', paddingLeft: '26px', marginTop: '4px' }}>
                        {memberGroups.map(g => (
                            <span
                                key={g.no}
                                className={`fg-group-color-${getGroupColor(g.no)}`}
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                    fontSize: '0.65rem', padding: '1px 4px 1px 7px', borderRadius: '999px',
                                    background: 'var(--fg-tint)', color: 'var(--fg-dot)',
                                }}
                            >
                                <span className="fg-group-dot" />
                                {g.name}
                                <button
                                    onClick={(e) => { e.stopPropagation(); onToggleSensorGroup(sensor, g.no); }}
                                    title={`Remove from ${g.name}`}
                                    style={{
                                        background: 'none', border: 'none', color: 'inherit', opacity: 0.7,
                                        cursor: 'pointer', padding: '2px', display: 'flex', borderRadius: '999px',
                                    }}
                                >
                                    <X size={9} />
                                </button>
                            </span>
                        ))}
                    </div>
                )}
                {hasAlarms && alarmOpen && (
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '26px', marginTop: '4px' }}
                    >
                        {ALARM_LEVELS.map(({ level, metaKey }) => {
                            const value = meta?.[metaKey];
                            if (value === undefined) return null;
                            const checked = alarmLinesEnabled[sensor]?.includes(level) ?? false;
                            const critical = isCriticalAlarmLevel(level);
                            return (
                                <label
                                    key={level}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '6px',
                                        fontSize: '0.75rem', cursor: 'pointer',
                                        fontWeight: critical ? 600 : 400,
                                        color: alarmLevelColor(level),
                                    }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => onToggleAlarmLine(sensor, level)}
                                    />
                                    {ALARM_LABELS[level]} ({value})
                                </label>
                            );
                        })}
                    </div>
                )}
                {menuOpen && (
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            marginTop: '6px', marginLeft: '26px',
                            padding: '8px', background: 'var(--input-bg)', border: '1px solid var(--border)',
                            borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '2px',
                        }}
                    >
                        {fgGroups.filter(g => g.no !== 0).map(g => {
                            const isMember = memberGroups.some(mg => mg.no === g.no);
                            const isEditing = editingGroupNo === g.no;
                            if (isEditing) {
                                return (
                                    <div key={g.no} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px' }}>
                                        <span className={`fg-group-color-${getGroupColor(g.no)}`} style={{
                                            width: '8px', height: '8px', borderRadius: '2px', flexShrink: 0, background: 'var(--fg-dot)',
                                        }} />
                                        <input
                                            type="text"
                                            value={editGroupDraft}
                                            autoFocus
                                            onChange={(e) => setEditGroupDraft(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') { onRenameGroup(g.no, editGroupDraft); setEditingGroupNo(null); }
                                            }}
                                            style={{
                                                flex: 1, minWidth: 0, padding: '3px 6px',
                                                background: 'var(--input-bg)', border: '1px solid var(--border)',
                                                borderRadius: '4px', color: 'var(--text-primary)',
                                                fontSize: '0.75rem', outline: 'none',
                                            }}
                                        />
                                        <button
                                            onClick={() => { onRenameGroup(g.no, editGroupDraft); setEditingGroupNo(null); }}
                                            title="Save name"
                                            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '2px', display: 'flex' }}
                                        >
                                            <Check size={14} />
                                        </button>
                                    </div>
                                );
                            }
                            return (
                                <div
                                    key={g.no}
                                    className={`fg-group-color-${getGroupColor(g.no)}`}
                                    style={{ display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '4px', padding: '4px 8px' }}
                                >
                                    <span style={{ width: '8px', height: '8px', borderRadius: '2px', flexShrink: 0, background: 'var(--fg-dot)' }} />
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.75rem', color: 'var(--text-primary)' }}>{g.name}</span>
                                    {!isMember && (
                                        <button
                                            onClick={() => onToggleSensorGroup(sensor, g.no)}
                                            title={`Add to ${g.name}`}
                                            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '2px', display: 'flex' }}
                                        >
                                            <Plus size={14} />
                                        </button>
                                    )}
                                    <button
                                        onClick={() => { setEditingGroupNo(g.no); setEditGroupDraft(g.name); }}
                                        title={`Rename ${g.name}`}
                                        style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '2px', display: 'flex' }}
                                    >
                                        <Pencil size={13} />
                                    </button>
                                    <button
                                        onClick={() => onDeleteGroup(g.no)}
                                        title={`Delete ${g.name}`}
                                        style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '2px', display: 'flex' }}
                                    >
                                        <Trash2 size={13} />
                                    </button>
                                </div>
                            );
                        })}
                        {fgGroups.filter(g => g.no !== 0).length === 0 && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', padding: '4px 8px' }}>
                                No failure groups yet
                            </div>
                        )}
                        <div style={{ display: 'flex', gap: '4px', marginTop: '4px', borderTop: '1px solid var(--border)', paddingTop: '6px' }}>
                            <input
                                type="text"
                                placeholder="New group name"
                                value={newGroupDraft}
                                onChange={(e) => setNewGroupDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        onCreateGroupForSensor(sensor, newGroupDraft);
                                        setNewGroupDraft('');
                                    }
                                }}
                                style={{
                                    flex: 1, minWidth: 0, padding: '4px 6px',
                                    background: 'var(--input-bg)', border: '1px solid var(--border)',
                                    borderRadius: '4px', color: 'var(--text-primary)',
                                    fontSize: '0.75rem', outline: 'none',
                                }}
                            />
                            <button
                                className="text-btn"
                                onClick={() => { onCreateGroupForSensor(sensor, newGroupDraft); setNewGroupDraft(''); }}
                                disabled={!newGroupDraft.trim()}
                            >
                                Create
                            </button>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="sensor-selection-widget h-full flex flex-col">
            <div className="widget-header flex-shrink-0" style={{ flexDirection: 'column', gap: '8px', alignItems: 'stretch' }}>
                <input
                    type="text"
                    placeholder="Search sensors..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="search-input-compact"
                />

                {isFilterActive && (
                    <div className="sensor-actions-compact" style={{ alignSelf: 'flex-end' }}>
                        <button className="text-btn" onClick={handleClearFilter}>Clear filter</button>
                    </div>
                )}

                {selectedSensors.length > 0 && (
                    <div style={{
                        padding: '6px 10px',
                        background: '#1d283a',
                        border: '1px solid #334155',
                        borderRadius: '6px',
                        fontSize: '0.8rem',
                    }}>
                        <span>{selectedSensors.length} sensor{selectedSensors.length !== 1 ? 's' : ''} selected</span>
                    </div>
                )}
            </div>

            <div className="sensor-list-widget flex-1 min-h-0 overflow-y-auto">
                {groupedSensors.map(([component, compSensors]) => {
                    const expanded = isComponentExpanded(component);
                    return (
                        <div key={component}>
                            <div
                                onClick={() => toggleComponentExpanded(component)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '8px 10px',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                    fontSize: '0.8rem',
                                    letterSpacing: '0.03em',
                                    textTransform: 'uppercase',
                                    borderBottom: '1px solid #1e293b',
                                    userSelect: 'none',
                                }}
                            >
                                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <span style={{ flex: 1 }}>{component}</span>
                                <span style={{ color: '#64748b', fontWeight: 400, textTransform: 'none' }}>
                                    {compSensors.length}
                                </span>
                            </div>
                            {expanded && compSensors.map(sensor => renderSensorRow(sensor))}
                        </div>
                    );
                })}
                {groupedSensors.length === 0 && (
                    <div className="no-results">No sensors found</div>
                )}
            </div>
        </div>
    );
}
