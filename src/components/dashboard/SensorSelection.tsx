import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, FolderPlus, X, Pencil, Trash2, Check, Bell } from 'lucide-react';
import { SensorMetadata, FailureGroup, FailureModel, ModelKind, AlarmLevel } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { ALARM_LEVELS, ALARM_LABELS, isCriticalAlarmLevel, alarmLevelColor, hasAlarmSetpoints } from '../../utils/alarmLevels';



interface SensorSelectionProps {
    sensors: string[];
    selectedSensors: string[];
    onSensorChange: (sensors: string[]) => void;
    /** When set, selecting a NEW sensor once selectedSensors.length has
     *  already reached this count is a no-op — used to hard-block picking a
     *  5th sensor while Pair Plot is active (WebGL context exhaustion), per
     *  the user's explicit "don't let the click through" preference over
     *  silently redirecting away from the chart afterward. Deselecting is
     *  never blocked. */
    maxSelectable?: number;
    sensorMetadata: SensorMetadata[] | null;
    fgGroups: FailureGroup[];
    fgModels: FailureModel[];
    getGroupColor: (groupNo: number) => string;
    /** Toggles a specific (sensor, group, kind) membership on/off — creates
     *  or reuses a model of that kind for this sensor (2026-08-31: a sensor
     *  can now carry more than one model kind at once, e.g. both Individual
     *  and Relationship, not just more than one group). One control does
     *  both add and remove, no separate confirm step — clicking an
     *  already-member kind removes it, clicking an absent one adds it. */
    onToggleSensorGroupKind: (tag: string, groupNo: number, kind: ModelKind) => void;
    onCreateGroupForSensor: (tag: string, name: string) => void;
    onRenameGroup: (groupNo: number, name: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    /** Which alarm setpoint lines are toggled on, per sensor tag. */
    alarmLinesEnabled: Record<string, AlarmLevel[]>;
    onToggleAlarmLine: (tag: string, level: AlarmLevel) => void;
}

const UNCATEGORIZED = 'Uncategorized';

// Same per-kind colours/labels as BuildModelWindow.tsx's own KIND_ACCENT
// (and, via that, the row badge's .model-kind-icon--* classes in App.css) —
// duplicated rather than imported since this panel doesn't share a
// components module with BuildModelWindow. A sensor's membership in a
// group is now per-kind, so each kind gets its own small toggle here.
const KIND_ACCENT: Record<ModelKind, string> = {
    individual: 'var(--accent-color)',
    relationship: 'var(--warn)',
    clustering: 'var(--kind-clu)',
};
const KIND_LETTER: Record<ModelKind, string> = {
    individual: 'I',
    relationship: 'R',
    clustering: 'C',
};
const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};
const ALL_KINDS: ModelKind[] = ['individual', 'relationship', 'clustering'];

/** Which sensor does model `m` represent? Individual/Relationship key off
 *  targetSensor; Clustering keys off xSensor, since a Clustering model
 *  created from the single-sensor toggle flow seeds that sensor as X and
 *  leaves Y for later (see Dashboard.tsx's makeDefaultModelForKind).
 *  Lower-cased because tags are matched case-insensitively. */
const modelSensorTag = (m: FailureModel) =>
    (m.kind === 'clustering' ? (m.xSensor ?? '') : (m.targetSensor ?? '')).toLowerCase();

/** Key for one (group, kind) membership inside the index below. */
const membershipKey = (groupNo: number, kind: ModelKind) => `${groupNo}:${kind}`;

export default function SensorSelection({
    sensors,
    selectedSensors,
    onSensorChange,
    maxSelectable,
    sensorMetadata,
    fgGroups,
    fgModels,
    getGroupColor,
    onToggleSensorGroupKind,
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
    const [newGroupError, setNewGroupError] = useState('');
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

    const atSelectionCap = maxSelectable !== undefined && selectedSensors.length >= maxSelectable;

    const isDuplicateGroupName = (name: string) =>
        fgGroups.some(g => g.no !== 0 && g.name.trim().toLowerCase() === name.trim().toLowerCase());

    const commitCreateGroup = (sensor: string) => {
        const trimmed = newGroupDraft.trim();
        if (!trimmed) return;
        if (isDuplicateGroupName(trimmed)) {
            setNewGroupError(`A failure group named "${trimmed}" already exists`);
            return;
        }
        onCreateGroupForSensor(sensor, trimmed);
        setNewGroupDraft('');
        setNewGroupError('');
    };

    const handleSensorToggle = (sensor: string) => {
        if (selectedSensors.includes(sensor)) {
            onSensorChange(selectedSensors.filter(s => s !== sensor));
        } else {
            if (atSelectionCap) return;
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

    // Membership index: sensor tag (lower-cased) -> set of "<groupNo>:<kind>".
    //
    // 2026-09-02 perf: this used to be derived inside renderSensorRow as
    // `fgGroups.flatMap(g => ALL_KINDS.filter(kind => fgModels.some(...)))`,
    // i.e. a full scan of `fgModels` for every (group, kind) pair of every
    // rendered row — O(rows x groups x kinds x models), recomputed on every
    // render, so every keystroke in the search box paid for all of it. With
    // 11 groups x 3 kinds that was 33 whole-array scans per row. Building
    // the index once per `fgModels` change makes each row's lookups O(1).
    const membershipIndex = useMemo(() => {
        const index = new Map<string, Set<string>>();
        for (const m of fgModels) {
            const tag = modelSensorTag(m);
            if (!tag) continue;
            let keys = index.get(tag);
            if (!keys) { keys = new Set<string>(); index.set(tag, keys); }
            for (const groupNo of m.groupNos) keys.add(membershipKey(groupNo, m.kind));
        }
        return index;
    }, [fgModels]);

    const handleClearFilter = () => {
        setSearchTerm('');
    };

    const renderSensorRow = (sensor: string) => {
        const meta = getMetadata(sensor);
        // This sensor's own membership keys, straight out of the index
        // above — one Map lookup instead of re-scanning every model.
        const ownMemberships = membershipIndex.get(sensor.toLowerCase());
        const isMemberOfKind = (groupNo: number, kind: ModelKind) =>
            ownMemberships?.has(membershipKey(groupNo, kind)) ?? false;
        // Is the sensor a member of this group in ANY kind — used to tint
        // the row in the group-assignment menu so an active group doesn't
        // get lost among a long list of groups (2026-09-02, reported by the
        // user as "ตาลาย" once there are 10+ groups: the toggle buttons'
        // own highlight isn't enough at a glance, the row itself needs it).
        const isMemberOfGroup = (groupNo: number) =>
            ALL_KINDS.some(kind => isMemberOfKind(groupNo, kind));
        // Which (group, kind) pairs this sensor belongs to, in group order —
        // a sensor can carry more than one model kind per group (e.g. both an
        // Individual and a Relationship model), so membership is per kind,
        // not just per group. Includes group 0 ("Not in Group"), which a
        // sensor can be toggled into exactly like any real group (see
        // Dashboard.tsx's toggleSensorGroupKind).
        const memberEntries: { group: FailureGroup; kind: ModelKind }[] = fgGroups.flatMap(g =>
            ALL_KINDS.filter(kind => isMemberOfKind(g.no, kind)).map(kind => ({ group: g, kind }))
        );
        const menuOpen = groupMenuFor === sensor;

        // Three small per-kind toggle buttons for one group (or "Not in
        // Group", 0) — the single control for both adding AND removing a
        // (sensor, group, kind) membership, letting the user pick more
        // than one kind for the same group by clicking more than one
        // (2026-08-31 redesign, replacing the old single +/✕ button).
        const renderKindToggles = (groupNo: number, groupName: string) => (
            <div style={{ display: 'flex', gap: '2px' }} onClick={e => e.stopPropagation()}>
                {ALL_KINDS.map(kind => {
                    const active = isMemberOfKind(groupNo, kind);
                    return (
                        <button
                            key={kind}
                            onClick={() => onToggleSensorGroupKind(sensor, groupNo, kind)}
                            title={`${active ? 'Remove' : 'Add'} ${KIND_LABEL[kind]}${active ? ' from' : ' to'} ${groupName}`}
                            style={{
                                width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                borderRadius: '4px', fontSize: '0.62rem', fontWeight: 700, cursor: 'pointer', flexShrink: 0,
                                border: `1px solid ${active ? KIND_ACCENT[kind] : 'var(--border)'}`,
                                background: active ? KIND_ACCENT[kind] : 'none',
                                color: active ? 'var(--bg-primary)' : 'var(--text-faint)',
                            }}
                        >
                            {KIND_LETTER[kind]}
                        </button>
                    );
                })}
            </div>
        );
        // The bell only appears at all when the sensor has at least one
        // setpoint value — independent of whether it's currently checked
        // into the chart, so it's browsable before deciding to plot. The
        // checkbox list itself only opens on click; checking the sensor's
        // own box does NOT auto-reveal it.
        const hasAlarms = hasAlarmSetpoints(meta);
        const alarmOpen = alarmPanelFor === sensor;
        const isSelected = selectedSensors.includes(sensor);
        // Not selected AND the cap is reached — the click is a no-op, so the
        // row reads as disabled instead of inviting a click that does nothing.
        const blockedByCap = !isSelected && atSelectionCap;
        return (
            <div
                key={sensor}
                className="sensor-list-row"
                onClick={() => handleSensorToggle(sensor)}
                title={blockedByCap ? `Pair Plot supports at most ${maxSelectable} sensors` : undefined}
                style={{
                    cursor: blockedByCap ? 'not-allowed' : 'pointer',
                    opacity: blockedByCap ? 0.45 : 1,
                    flexDirection: 'column', alignItems: 'stretch', position: 'relative',
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="checkbox-wrapper">
                        <input
                            type="checkbox"
                            id={`sensor-${sensor}`}
                            checked={isSelected}
                            disabled={blockedByCap}
                            onChange={() => handleSensorToggle(sensor)}
                            onClick={(e) => e.stopPropagation()}
                        />
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <label htmlFor={`sensor-${sensor}`} onClick={(e) => e.stopPropagation()} style={{ cursor: 'pointer', fontWeight: 500 }}>
                                {meta ? (
                                    <>
                                        {meta.description}
                                        {meta.unit && (
                                            <span style={{ marginLeft: '6px', fontSize: '0.8em', color: 'var(--text-secondary)', fontWeight: 400 }}>
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
                {memberEntries.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', paddingLeft: '26px', marginTop: '4px' }}>
                        {memberEntries.map(({ group: g, kind }) => (
                            <span
                                key={`${g.no}-${kind}`}
                                className={`fg-group-color-${getGroupColor(g.no)}`}
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                                    fontSize: '0.65rem', padding: '1px 4px 1px 4px', borderRadius: '999px',
                                    background: 'var(--fg-tint)', color: 'var(--fg-dot)',
                                }}
                            >
                                {/* 2026-08-31: leads the chip now (was a
                                    small dim letter buried after the group
                                    name) — still not prominent enough per
                                    direct user follow-up ("sensor แทบไม่เยอะ
                                    เท่าไหร่"), so it's bigger still and
                                    goes first, same lead-with-the-badge
                                    order the FG tab uses (confirmed clear
                                    by the user there). Reuses
                                    `.model-kind-icon--*`, the exact class
                                    Build Model's own model rows use. */}
                                <span
                                    className={`model-kind-icon model-kind-icon--${kind}`}
                                    style={{ width: '16px', height: '16px', borderRadius: '4px', fontSize: '0.62rem', flexShrink: 0 }}
                                >
                                    {KIND_LETTER[kind]}
                                </span>
                                <span className="fg-group-dot" />
                                {g.name}
                                <button
                                    onClick={(e) => { e.stopPropagation(); onToggleSensorGroupKind(sensor, g.no, kind); }}
                                    title={`Remove ${KIND_LABEL[kind]} from ${g.name}`}
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
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '4px', padding: '4px 8px',
                                        background: isMemberOfGroup(g.no) ? 'var(--fg-tint)' : undefined,
                                    }}
                                >
                                    <span style={{ width: '8px', height: '8px', borderRadius: '2px', flexShrink: 0, background: 'var(--fg-dot)' }} />
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.75rem', color: 'var(--text-primary)' }}>{g.name}</span>
                                    {renderKindToggles(g.no, g.name)}
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

                        {/* "Not in Group" (FG-0) — same per-kind toggle mechanic
                            as a real group, but no rename/delete since it's a
                            permanent, non-editable bucket for a sensor that
                            doesn't belong to a failure mode yet still needs a
                            model built for it. */}
                        <div
                            className="fg-group-color-slate"
                            style={{
                                display: 'flex', alignItems: 'center', gap: '6px', borderRadius: '4px', padding: '4px 8px', marginTop: '2px', borderTop: '1px dashed var(--border)', paddingTop: '8px',
                                background: isMemberOfGroup(0) ? 'var(--fg-tint)' : undefined,
                            }}
                        >
                            <span style={{ width: '8px', height: '8px', borderRadius: '2px', flexShrink: 0, background: 'var(--fg-dot)' }} />
                            <span style={{ flex: 1, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Not in Group</span>
                            {renderKindToggles(0, 'Not in Group')}
                        </div>

                        <div style={{ marginTop: '4px', borderTop: '1px solid var(--border)', paddingTop: '6px' }}>
                            <div style={{ display: 'flex', gap: '4px' }}>
                                <input
                                    type="text"
                                    placeholder="New group name"
                                    value={newGroupDraft}
                                    onChange={(e) => { setNewGroupDraft(e.target.value); setNewGroupError(''); }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') commitCreateGroup(sensor);
                                    }}
                                    style={{
                                        flex: 1, minWidth: 0, padding: '4px 6px',
                                        background: 'var(--input-bg)', border: `1px solid ${newGroupError ? 'var(--danger)' : 'var(--border)'}`,
                                        borderRadius: '4px', color: 'var(--text-primary)',
                                        fontSize: '0.75rem', outline: 'none',
                                    }}
                                />
                                <button
                                    className="text-btn"
                                    onClick={() => commitCreateGroup(sensor)}
                                    disabled={!newGroupDraft.trim()}
                                >
                                    Create
                                </button>
                            </div>
                            {newGroupError && (
                                <div style={{ fontSize: '0.68rem', color: 'var(--danger)', marginTop: '3px' }}>{newGroupError}</div>
                            )}
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
                        background: 'var(--accent-muted)',
                        border: '1px solid var(--accent-color)',
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
                                    borderBottom: '1px solid var(--border)',
                                    userSelect: 'none',
                                }}
                            >
                                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <span style={{ flex: 1 }}>{component}</span>
                                <span style={{ color: 'var(--text-faint)', fontWeight: 400, textTransform: 'none' }}>
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
