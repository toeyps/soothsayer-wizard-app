import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, ChevronDown, FolderPlus, X, Bell } from 'lucide-react';
import { SensorMetadata, FailureGroup, FailureModel, ModelKind, AlarmLevel } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { modelSensorKey } from '../../utils/modelGrouping';
import { ALARM_LEVELS, ALARM_LABELS, isCriticalAlarmLevel, alarmLevelColor, hasAlarmSetpoints } from '../../utils/alarmLevels';
import AnchoredPopover, { type PopoverAnchorRect } from '../AnchoredPopover';
import FailureGroupAssignSheet, { KIND_LETTER, KIND_LABEL, ALL_KINDS } from './FailureGroupAssignSheet';



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

// Which sensor a model represents is `modelSensorKey` (Individual/
// Relationship key off targetSensor; Clustering off xSensor, which the
// single-sensor toggle flow seeds as X — see Dashboard.tsx's
// makeDefaultModelForKind), normalised the same way Dashboard's own toggle
// matches it, so the chips here and the assignment sheet never disagree about
// whether a sensor belongs to a group.

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
    // Which sensor the Failure Group Assignment sheet (FailureGroupAssignSheet)
    // is open for — `null` = closed. 2026-10-03: this replaced an
    // AnchoredPopover menu with a full-height sheet docked to the left edge of
    // the Sensors panel; it is NOT dismissed by scrolling the list or clicking
    // inside the panel, only by the triggers listed above `closeSheet` below.
    // A sensor can belong to more than one group (and kind), so the sheet is a
    // matrix of toggles, not a single-select assignment.
    const [fgSheetFor, setFgSheetFor] = useState<string | null>(null);
    // Which sensor's alarm-setpoint checkbox list is open. Closed by default
    // for every sensor — the icon only appears when the sensor actually HAS
    // a setpoint (see `hasAlarmSetpoints` below), and clicking it is the only
    // way to reveal the checkboxes. Checking a sensor into the chart does
    // NOT auto-open this — the user explicitly asked for click-only.
    const [alarmPanelFor, setAlarmPanelFor] = useState<string | null>(null);
    // Viewport-relative rect of the 🔔 button that opened the alarm-setpoints
    // popover — captured once, when it opens (see AnchoredPopover's own
    // docstring for why this isn't tracked live).
    const [alarmPanelAnchor, setAlarmPanelAnchor] = useState<PopoverAnchorRect | null>(null);
    // Latest-DOM handles the sheet needs: the Sensors panel it docks to, the
    // scrolling list, and the row it points at.
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const rowEls = useRef(new Map<string, HTMLElement>());
    // A sensor the list should scroll to once its row has rendered (set by the
    // sheet's ‹ › buttons, which may have just expanded its component).
    const [scrollToSensor, setScrollToSensor] = useState<string | null>(null);

    const atSelectionCap = maxSelectable !== undefined && selectedSensors.length >= maxSelectable;

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
    const groupByComponent = (list: string[]): [string, string[]][] => {
        const groups = new Map<string, string[]>();
        for (const s of list) {
            const comp = getMetadata(s)?.component || UNCATEGORIZED;
            if (!groups.has(comp)) groups.set(comp, []);
            groups.get(comp)!.push(s);
        }
        return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
    };
    const groupedSensors = useMemo(
        () => groupByComponent(filteredSensors),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [filteredSensors, sensorMetadata]
    );
    // EVERY sensor in on-screen order, ignoring the search box — the order the
    // assignment sheet's ‹ › buttons walk (they go across all sensors, expanding
    // collapsed components and clearing the search on the way).
    const allSensorsInOrder = useMemo(
        () => groupByComponent(sensors).flatMap(([, list]) => list),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [sensors, sensorMetadata]
    );

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

    // Which sensor tags are actually rendered right now — a component that's
    // collapsed, or a search that doesn't match, both remove a sensor's row from
    // the DOM without the sensor itself ever being deselected. `fgSheetFor` /
    // `alarmPanelFor` (and the alarm popover's captured anchor rect) are state
    // local to THIS component, not tied to the row's lifecycle, so they used to
    // just sit there while hidden — collapsing then re-expanding the group (or
    // filtering the row out then clearing the search) remounted the popover at
    // the stale rect captured before the row disappeared (QA sweep,
    // 2026-10-02; same bug class as Dashboard.tsx's selectedSensors prune
    // effect for colorPickerFor/axisEditorFor). One shared effect, keyed on the
    // actual visible row set, closes whichever panel's row just left it —
    // covers both the collapse/expand and the filter-out/clear-search path, and
    // also a sensor that disappears from `sensors` altogether (a deleted
    // special sensor), so a further "row disappeared" trigger needs no one-off
    // fix. The assignment sheet follows the same rule: with its row gone there
    // is nothing for its arrow to point at, so it closes (its own ‹ › buttons
    // expand the target's component in the SAME update, so they never trip it).
    const visibleSensorSet = useMemo(() => {
        const visible = new Set<string>();
        for (const [component, compSensors] of groupedSensors) {
            if (!isComponentExpanded(component)) continue;
            for (const sensor of compSensors) visible.add(sensor);
        }
        return visible;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupedSensors, expandedComponents, searchTerm]);

    useEffect(() => {
        if (fgSheetFor && !visibleSensorSet.has(fgSheetFor)) {
            setFgSheetFor(null);
        }
        if (alarmPanelFor && !visibleSensorSet.has(alarmPanelFor)) {
            setAlarmPanelFor(null);
            setAlarmPanelAnchor(null);
        }
    }, [visibleSensorSet, fgSheetFor, alarmPanelFor]);

    // After the sheet's ‹ › moves to a sensor whose component was collapsed (or
    // that is scrolled out of the list), bring that row into view once it has
    // rendered. The sheet re-measures its arrow on the resulting scroll event.
    useEffect(() => {
        if (!scrollToSensor) return;
        const row = rowEls.current.get(scrollToSensor);
        if (!row) return; // not rendered yet — runs again when visibleSensorSet changes
        row.scrollIntoView?.({ block: 'nearest' });
        setScrollToSensor(null);
    }, [scrollToSensor, visibleSensorSet]);

    // Membership index: sensor tag (lower-cased) -> set of "<groupNo>:<kind>".
    //
    // 2026-09-03 perf: this used to be derived inside renderSensorRow as
    // `fgGroups.flatMap(g => ALL_KINDS.filter(kind => fgModels.some(...)))`,
    // i.e. a full scan of `fgModels` for every (group, kind) pair of every
    // rendered row — O(rows x groups x kinds x models), recomputed on every
    // render, so every keystroke in the search box paid for all of it. With
    // 11 groups x 3 kinds that was 33 whole-array scans per row. Building
    // the index once per `fgModels` change makes each row's lookups O(1).
    const membershipIndex = useMemo(() => {
        const index = new Map<string, Set<string>>();
        for (const m of fgModels) {
            const tag = modelSensorKey(m);
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

    // Typing in the search box re-filters the list under an open panel. The
    // alarm popover (positioned from a one-time captured rect) would float over
    // the wrong spot, so — like AnchoredPopover's own scroll/resize rule — it
    // closes. The assignment sheet closes on a keystroke too (2026-10-03 spec:
    // "search changes" is one of its dismissals); clearing the search through
    // its ‹ › buttons is a programmatic change, not typing, so it keeps it open.
    const handleSearchChange = (value: string) => {
        setSearchTerm(value);
        if (fgSheetFor) setFgSheetFor(null);
        if (alarmPanelFor) { setAlarmPanelFor(null); setAlarmPanelAnchor(null); }
    };

    // ── Failure Group Assignment sheet ───────────────────────────────────────
    const getHostEl = useCallback(
        () => (rootRef.current?.closest('.widget-section') as HTMLElement | null) ?? rootRef.current,
        [],
    );
    const getSheetRowEl = useCallback(
        () => (fgSheetFor ? rowEls.current.get(fgSheetFor) ?? null : null),
        [fgSheetFor],
    );
    const getListEl = useCallback(() => listRef.current, []);

    const openSheetFor = (sensor: string) => {
        // Opening one popover closes the other: the alarm list is a
        // `position: fixed` popover under the same row's bell button.
        setAlarmPanelFor(null); setAlarmPanelAnchor(null);
        setFgSheetFor(sensor);
    };

    const stepSheet = (direction: -1 | 1) => {
        if (!fgSheetFor) return;
        const next = allSensorsInOrder[allSensorsInOrder.indexOf(fgSheetFor) + direction];
        if (!next) return;
        // The target may sit in a collapsed component or be filtered out by the
        // search — expand/clear on demand so its row exists to be highlighted.
        const comp = getMetadata(next)?.component || UNCATEGORIZED;
        setExpandedComponents(prev => (prev.has(comp) ? prev : new Set(prev).add(comp)));
        setSearchTerm('');
        setFgSheetFor(next);
        setScrollToSensor(next);
    };

    const sheetIndex = fgSheetFor ? allSensorsInOrder.indexOf(fgSheetFor) : -1;

    const renderSensorRow = (sensor: string) => {
        const meta = getMetadata(sensor);
        // This sensor's own membership keys, straight out of the index
        // above — one Map lookup instead of re-scanning every model.
        const ownMemberships = membershipIndex.get(normalizeSensorTag(sensor));
        const isMemberOfKind = (groupNo: number, kind: ModelKind) =>
            ownMemberships?.has(membershipKey(groupNo, kind)) ?? false;
        // Which (group, kind) pairs this sensor belongs to, in group order —
        // a sensor can carry more than one model kind per group (e.g. both an
        // Individual and a Relationship model), so membership is per kind,
        // not just per group. Includes group 0 ("Not in Group"), which a
        // sensor can be toggled into exactly like any real group (see
        // Dashboard.tsx's toggleSensorGroupKind).
        const memberEntries: { group: FailureGroup; kind: ModelKind }[] = fgGroups.flatMap(g =>
            ALL_KINDS.filter(kind => isMemberOfKind(g.no, kind)).map(kind => ({ group: g, kind }))
        );
        const sheetOpen = fgSheetFor === sensor;
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
                ref={(el) => { if (el) rowEls.current.set(sensor, el); else rowEls.current.delete(sensor); }}
                className={`sensor-list-row${sheetOpen ? ' sensor-list-row--fg-target' : ''}`}
                data-fg-target={sheetOpen ? 'true' : undefined}
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
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <label htmlFor={`sensor-${sensor}`} onClick={(e) => e.stopPropagation()} style={{ cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span>{meta ? meta.description : sensor}</span>
                                {meta?.unit && <span className="unit-badge">{meta.unit}</span>}
                            </label>
                            {meta && (
                                <span className="sensor-row-tag">{meta.tag}</span>
                            )}
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                        {hasAlarms && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (alarmOpen) { setAlarmPanelFor(null); setAlarmPanelAnchor(null); }
                                    else {
                                        // Opening this one closes the assignment sheet if
                                        // it's open — one panel at a time.
                                        setFgSheetFor(null);
                                        setAlarmPanelAnchor(e.currentTarget.getBoundingClientRect()); setAlarmPanelFor(sensor);
                                    }
                                }}
                                title="Alarm setpoints"
                                className={`row-action-btn${alarmOpen ? ' on' : ''}`}
                            >
                                <Bell size={14} />
                            </button>
                        )}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                // Clicking the open sensor's own 📁 closes the sheet;
                                // clicking ANOTHER sensor's switches it over.
                                if (sheetOpen) setFgSheetFor(null);
                                else openSheetFor(sensor);
                            }}
                            onContextMenu={(e) => {
                                e.preventDefault(); e.stopPropagation();
                                openSheetFor(sensor);
                            }}
                            title="Add to failure group"
                            aria-expanded={sheetOpen}
                            className={`row-action-btn${sheetOpen ? ' on' : ''}`}
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
                    <AnchoredPopover
                        anchorRect={alarmPanelAnchor}
                        onRequestClose={() => { setAlarmPanelFor(null); setAlarmPanelAnchor(null); }}
                        width={220}
                    >
                        <div className="fg-menu-heading">Alarm setpoints</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
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
                    </AnchoredPopover>
                )}
            </div>
        );
    };

    return (
        <div className="sensor-selection-widget h-full flex flex-col" ref={rootRef}>
            <div className="widget-header flex-shrink-0" style={{ flexDirection: 'column', gap: '8px', alignItems: 'stretch' }}>
                <input
                    type="text"
                    placeholder="Search sensors..."
                    value={searchTerm}
                    onChange={e => handleSearchChange(e.target.value)}
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

            <div className="sensor-list-widget flex-1 min-h-0 overflow-y-auto" ref={listRef}>
                {groupedSensors.map(([component, compSensors]) => {
                    const expanded = isComponentExpanded(component);
                    // "selected / total" (e.g. "2 / 8") once at least one
                    // sensor in this component is on the chart — matching
                    // the approved prototype's own counter exactly, which
                    // hides the "0 / " prefix rather than showing it
                    // (a bare total reads the same as "nothing selected
                    // yet" without needing the extra "0 /" noise).
                    const selectedInGroup = compSensors.filter(s => selectedSensors.includes(s)).length;
                    return (
                        <div key={component}>
                            <div
                                onClick={() => toggleComponentExpanded(component)}
                                className="component-group-header"
                            >
                                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <span style={{ flex: 1 }}>{component}</span>
                                <span className="component-group-count">
                                    {selectedInGroup > 0 ? <><b>{selectedInGroup}</b> / {compSensors.length}</> : compSensors.length}
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

            {fgSheetFor && (
                <FailureGroupAssignSheet
                    tag={fgSheetFor}
                    sensorLabel={getMetadata(fgSheetFor)?.description || fgSheetFor}
                    unit={getMetadata(fgSheetFor)?.unit}
                    fgGroups={fgGroups}
                    fgModels={fgModels}
                    getGroupColor={getGroupColor}
                    onToggleSensorGroupKind={onToggleSensorGroupKind}
                    onCreateGroupForSensor={onCreateGroupForSensor}
                    onRenameGroup={onRenameGroup}
                    onDeleteGroup={onDeleteGroup}
                    canStepPrev={sheetIndex > 0}
                    canStepNext={sheetIndex >= 0 && sheetIndex < allSensorsInOrder.length - 1}
                    onStep={stepSheet}
                    onClose={() => setFgSheetFor(null)}
                    getHostEl={getHostEl}
                    getRowEl={getSheetRowEl}
                    getListEl={getListEl}
                />
            )}
        </div>
    );
}
