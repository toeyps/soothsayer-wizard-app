import { Fragment, useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, ChevronDown, FolderPlus, X, Bell } from 'lucide-react';
import { SensorMetadata, FailureGroup, FailureModel, ModelKind, AlarmLevel } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { modelSensorKey } from '../../utils/modelGrouping';
import { ALARM_LEVELS, ALARM_LABELS, isCriticalAlarmLevel, alarmLevelColor, hasAlarmSetpoints } from '../../utils/alarmLevels';
import AnchoredPopover, { type PopoverAnchorRect } from '../AnchoredPopover';
import FailureGroupAssignSheet, { KIND_LETTER, KIND_LABEL, ALL_KINDS } from './FailureGroupAssignSheet';
import { SensorLabel, SensorNamesContext, SensorSearchContext, SensorSetContext, SensorSetDropContext } from '../sensor/SensorLabel';
import { SensorMetaContext, nameRuns, useLayeredSensorLookup, type SensorNamesValue } from '../sensor/sensorInfo';
import { useCutRuns } from '../../hooks/useNameFit';
import { useWindowedLines } from '../../hooks/useWindowedLines';
import { NAME_TAIL_MAX, displayedName } from '../../utils/sensorNames';



interface SensorSelectionProps {
    sensors: string[];
    selectedSensors: string[];
    onSensorChange: (sensors: string[]) => void;
    /** Hard cap on selected sensors (Pair Plot allows 4: WebGL contexts); selecting past it is a no-op, deselecting is never blocked. */
    maxSelectable?: number;
    sensorMetadata: SensorMetadata[] | null;
    fgGroups: FailureGroup[];
    fgModels: FailureModel[];
    getGroupColor: (groupNo: number) => string;
    /** Toggles one (sensor, group, kind) membership: creates or reuses that kind's model; clicking a member kind removes it. */
    onToggleSensorGroupKind: (tag: string, groupNo: number, kind: ModelKind) => void;
    onCreateGroupForSensor: (tag: string, name: string) => void;
    onRenameGroup: (groupNo: number, name: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    /** Which alarm setpoint lines are toggled on, per sensor tag. */
    alarmLinesEnabled: Record<string, AlarmLevel[]>;
    onToggleAlarmLine: (tag: string, level: AlarmLevel) => void;
    /** Group being filled by 'Assign sensors' (bar, 'assigned / total' counts, pinned in the sheet); `null`/omitted = ordinary Sensor tab. */
    assignGroupNo?: number | null;
    /** The bar's Done — the Dashboard goes back to the Failure Groups tab. */
    onAssignDone?: () => void;
}

const UNCATEGORIZED = 'Uncategorized';

// A model's sensor is `modelSensorKey` (Individual/Relationship: targetSensor; Clustering: xSensor), normalised like Dashboard's toggle so chips and the sheet agree on membership.

/** Key for one (group, kind) membership inside the index below. */
const membershipKey = (groupNo: number, kind: ModelKind) => `${groupNo}:${kind}`;

/** One line of the list. `run`: consecutive rows whose names share a start (rule 2) share a line that prints it. */
type ListItem =
    | { k: 'header'; component: string; list: string[] }
    | { k: 'prefix'; id: string; prefix: string }
    | { k: 'row'; sensor: string; prefix: string; set: SensorNamesValue };

/** Rule 6: above this many lines the list only renders the ones in view. */
const WINDOW_ABOVE = 150;
/** Rendered above and below the view, in px. */
const WINDOW_OVERSCAN = 400;
const HEADER_EST_PX = 37;
const PREFIX_EST_PX = 22;
const ROW_EST_PX = 52;
const CHIPS_EST_PX = 26;
/** Used until the list has a measured height (a hidden tab, jsdom). */
const VIEW_FALLBACK_PX = 900;

const itemKey = (it: ListItem): string => (it.k === 'header' ? `h:${it.component}` : it.k === 'prefix' ? `p:${it.id}` : `r:${it.sensor}`);

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
    assignGroupNo = null,
    onAssignDone,
}: SensorSelectionProps) {
    const [searchTerm, setSearchTerm] = useState('');
    // Manually expanded components; all start collapsed.
    const [expandedComponents, setExpandedComponents] = useState<Set<string>>(new Set());
    // Sensor the Failure Group Assignment sheet is open for (`null` = closed); stays open on scroll or panel clicks.
    const [fgSheetFor, setFgSheetFor] = useState<string | null>(null);
    // Sensor whose alarm-setpoint list is open; click-only, and the icon shows only if the sensor has a setpoint.
    const [alarmPanelFor, setAlarmPanelFor] = useState<string | null>(null);
    // Rect of the bell button that opened the popover, captured once on open (see AnchoredPopover).
    const [alarmPanelAnchor, setAlarmPanelAnchor] = useState<PopoverAnchorRect | null>(null);
    // Latest-DOM handles the sheet needs: the Sensors panel it docks to, the
    // scrolling list, and the row it points at.
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const rowEls = useRef(new Map<string, HTMLElement>());
    // Each row's Failure groups button, so closing the sheet by keyboard can return focus to it.
    const fgButtonEls = useRef(new Map<string, HTMLButtonElement>());
    // The group an "Assign sensors" run is filling; gone (bar hides) if it was
    // deleted meanwhile.
    const assignGroup = assignGroupNo !== null && assignGroupNo !== 0
        ? fgGroups.find(g => g.no === assignGroupNo) ?? null
        : null;
    // Sensor to scroll to once its row renders (the sheet's ‹ › may have just expanded its component).
    const [scrollToSensor, setScrollToSensor] = useState<string | null>(null);
    const windowedOffsetOf = useRef<((sensor: string) => number) | null>(null);

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
    // Labels read this panel's metadata layered on the window's provider, so special-sensor badges still show.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);
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

    // Group by component, sorted by component then sensor label; unmapped sensors go to 'Uncategorized' rather than disappearing.
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
    // Every sensor in on-screen order, ignoring search: the order the sheet's ‹ › walk (they expand components and clear search).
    const allSensorsInOrder = useMemo(
        () => groupByComponent(sensors).flatMap(([, list]) => list),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [sensors, sensorMetadata]
    );

    // The group just opened: its rows get the reveal (windowed rows mount on every scroll, so never all rows).
    // Played on mount (Web Animations), so no class is added or stripped later: nothing re-renders, nothing blinks.
    const reveal = useRef<{ comp: string | null; until: number; i: number }>({ comp: null, until: 0, i: 0 });
    const revealSeen = useRef(new WeakSet<HTMLElement>());
    const revealRow = (el: HTMLElement, comp: string) => {
        if (revealSeen.current.has(el)) return; // ref callbacks re-run on every render: a row reveals once, when it mounts
        revealSeen.current.add(el);
        const r = reveal.current;
        if (r.comp !== comp || performance.now() > r.until) return;
        const scale = parseFloat(getComputedStyle(el).getPropertyValue('--motion-scale'));
        if (!(scale > 0)) return; // reduced motion, or no motion stylesheet
        const i = Math.min(r.i++, 5);
        el.animate?.([{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }],
            { duration: 180 * scale, delay: i * 30 * scale, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'backwards' });
    };
    const toggleComponentExpanded = (comp: string) => {
        setExpandedComponents(prev => {
            const next = new Set(prev);
            if (next.has(comp)) next.delete(comp);
            else { next.add(comp); reveal.current = { comp, until: performance.now() + 400, i: 0 }; }
            return next;
        });
    };

    // While searching, force matching groups open so nothing hides behind a collapsed header; manual state applies again when cleared.
    const isComponentExpanded = (comp: string) =>
        searchTerm !== '' || expandedComponents.has(comp);

    const isFilterActive = searchTerm !== '';

    // Close the sheet/alarm popover when its row leaves the visible set (collapsed, filtered, gone): they would remount at a stale rect.
    // The sheet's ‹ › expand the target in the same update, so they don't trip it.
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

    // Membership index: lower-cased tag -> set of '<groupNo>:<kind>', rebuilt per `fgModels` change so row lookups are O(1).
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

    // Typing re-filters the list, so close the alarm popover and the sheet (their rect is fixed at open). ‹ › clearing search keeps them.
    const handleSearchChange = (value: string) => {
        setSearchTerm(value);
        if (fgSheetFor) setFgSheetFor(null);
        if (alarmPanelFor) { setAlarmPanelFor(null); setAlarmPanelAnchor(null); }
    };

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
        // Target may be in a collapsed component or filtered out: expand/clear so its row exists.
        const comp = getMetadata(next)?.component || UNCATEGORIZED;
        setExpandedComponents(prev => (prev.has(comp) ? prev : new Set(prev).add(comp)));
        setSearchTerm('');
        setFgSheetFor(next);
        setScrollToSensor(next);
    };

    const sheetIndex = fgSheetFor ? allSensorsInOrder.indexOf(fgSheetFor) : -1;

    // Move focus to the bar's Done when 'Assign sensors' starts (the FG card that had it is gone).
    const assignDoneRef = useRef<HTMLButtonElement>(null);
    const assignGroupNoShown = assignGroup?.no ?? null;
    useEffect(() => {
        if (assignGroupNoShown !== null) assignDoneRef.current?.focus();
    }, [assignGroupNoShown]);

    const closeSheet = (opts?: { returnFocus?: boolean }) => {
        const tag = fgSheetFor;
        setFgSheetFor(null);
        if (opts?.returnFocus && tag) fgButtonEls.current.get(tag)?.focus();
    };

    // Assign mode: per component, sensors already in the group being filled ('assigned / total'); built only during a run.
    const assignedInGroup = useMemo(() => {
        if (!assignGroup) return null;
        const assigned = new Set<string>();
        for (const m of fgModels) {
            if (!m.groupNos.includes(assignGroup.no)) continue;
            const key = modelSensorKey(m);
            if (key) assigned.add(key);
        }
        return assigned;
    }, [assignGroup, fgModels]);

    const renderSensorRow = (sensor: string) => {
        const meta = getMetadata(sensor);
        // This sensor's own membership keys, straight out of the index
        // above — one Map lookup instead of re-scanning every model.
        const ownMemberships = membershipIndex.get(normalizeSensorTag(sensor));
        const isMemberOfKind = (groupNo: number, kind: ModelKind) =>
            ownMemberships?.has(membershipKey(groupNo, kind)) ?? false;
        // (group, kind) pairs the sensor belongs to, in group order; membership is per kind. Includes group 0 ('Not in Group').
        const memberEntries: { group: FailureGroup; kind: ModelKind }[] = fgGroups.flatMap(g =>
            ALL_KINDS.filter(kind => isMemberOfKind(g.no, kind)).map(kind => ({ group: g, kind }))
        );
        const sheetOpen = fgSheetFor === sensor;
        // Bell shows only if the sensor has a setpoint, whether or not it is plotted; the list opens on click only.
        const hasAlarms = hasAlarmSetpoints(meta);
        const alarmOpen = alarmPanelFor === sensor;
        const isSelected = selectedSensors.includes(sensor);
        // Cap reached and not selected: the click is a no-op, so show the row as disabled.
        const blockedByCap = !isSelected && atSelectionCap;
        return (
            <div
                key={sensor}
                ref={(el) => { if (el) { revealRow(el, meta?.component || UNCATEGORIZED); rowEls.current.set(sensor, el); } else rowEls.current.delete(sensor); }}
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
                        {/* Stacked SensorLabel: description + unit, tag on line 2; full name in the title when truncated. */}
                        <label htmlFor={`sensor-${sensor}`} onClick={(e) => e.stopPropagation()} className="sensor-row-label">
                            <SensorLabel tag={sensor} info={sensorLookup(sensor)} wrap="always" />
                        </label>
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
                            ref={(el) => { if (el) fgButtonEls.current.set(sensor, el); else fgButtonEls.current.delete(sensor); }}
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
                                {/* Kind badge leads the chip; reuses `.model-kind-icon--*` from Build Model's rows. */}
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

    // Consecutive rows sharing a name start get that start once on a muted line, only while a row is really cut; `commonPrefix` guards short names.
    // Names are the displayed names, so tag-only sensors join runs too.
    const allItems = useMemo<ListItem[]>(() => {
        const nameOf = (t: string) => displayedName(sensorLookup(t));
        const out: ListItem[] = [];
        for (const [component, list] of groupedSensors) {
            out.push({ k: 'header', component, list });
            if (!isComponentExpanded(component)) continue;
            for (const run of nameRuns(list, nameOf)) {
                const id = `${component}:${run.tags[0]}`;
                if (run.prefix) out.push({ k: 'prefix', id, prefix: run.prefix });
                const set: SensorNamesValue = { names: run.names, run: run.prefix ? id : '' };
                for (const sensor of run.tags) out.push({ k: 'row', sensor, prefix: run.prefix, set });
            }
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupedSensors, expandedComponents, searchTerm, sensorLookup]);
    const hasRuns = useMemo(() => allItems.some(it => it.k === 'prefix'), [allItems]);
    // Search hits are marked only when the project has long names (a match may sit in a cut-off head).
    const hasLongNames = useMemo(
        () => sensors.some(t => displayedName(sensorLookup(t)).length > NAME_TAIL_MAX),
        [sensors, sensorLookup],
    );
    const getList = useCallback(() => listRef.current, []);
    const cutRuns = useCutRuns(getList, `${allItems.length}|${searchTerm}|${[...expandedComponents].join('|')}`, hasRuns);
    const items = useMemo<ListItem[]>(() => (!hasRuns ? allItems : allItems
        .filter(it => it.k !== 'prefix' || cutRuns.has(it.id))
        .map(it => (it.k === 'row' && it.prefix && !cutRuns.has(it.set.run) ? { ...it, prefix: '' } : it))
    ), [allItems, hasRuns, cutRuns]);

    // Rule 6: over 150 lines only what is in view is rendered (heights measured once rendered, estimated before).
    const windowed = items.length > WINDOW_ABOVE;
    const estimateLine = useCallback((it: ListItem) => (it.k === 'header' ? HEADER_EST_PX
        : it.k === 'prefix' ? PREFIX_EST_PX
            : ROW_EST_PX + (membershipIndex.get(normalizeSensorTag(it.sensor))?.size ? CHIPS_EST_PX : 0)), [membershipIndex]);
    const { view, measureTick, offsets, windowStart, windowEnd, lineAt, readView, lineRef } = useWindowedLines({
        listRef,
        lines: items,
        keyOf: itemKey,
        estimate: estimateLine,
        windowed,
        overscanPx: WINDOW_OVERSCAN,
        fallbackHeightPx: VIEW_FALLBACK_PX,
        // A new search or an expanded group starts over; a run's line appearing does not.
        anchorList: allItems,
    });
    windowedOffsetOf.current = windowed
        ? (sensor: string) => {
            const i = items.findIndex(it => it.k === 'row' && it.sensor === sensor);
            return i < 0 ? -1 : offsets[i];
        }
        : null;

    // After ‹ › moves to a sensor in a collapsed component or out of view, scroll its row into view once rendered.
    useEffect(() => {
        if (!scrollToSensor) return;
        const row = rowEls.current.get(scrollToSensor);
        if (!row) {
            // Windowed row not in the DOM yet: scroll to its place; runs again when visibleSensorSet or the window changes.
            const at = windowedOffsetOf.current ? windowedOffsetOf.current(scrollToSensor) : -1;
            if (at >= 0 && listRef.current) listRef.current.scrollTop = Math.max(0, at - 60);
            return;
        }
        row.scrollIntoView?.({ block: 'nearest' });
        setScrollToSensor(null);
    }, [scrollToSensor, visibleSensorSet, view.top, measureTick]);

    const renderHeader = (component: string, compSensors: string[]) => {
        const expanded = isComponentExpanded(component);
        // Show 'selected / total' (e.g. '2 / 8') only once a sensor in this component is plotted; no '0 / ' prefix.
        const selectedInGroup = compSensors.filter(s => selectedSensors.includes(s)).length;
        // Assign mode: "assigned / total" for the group being filled
        // (always with the prefix, 0 included — that number IS the task).
        const assignedHere = assignedInGroup
            ? compSensors.filter(s => assignedInGroup.has(normalizeSensorTag(s))).length
            : null;
        return (
            <div
                onClick={() => toggleComponentExpanded(component)}
                className="component-group-header"
            >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span style={{ flex: 1 }}>{component}</span>
                {assignedHere !== null && assignGroup ? (
                    <span
                        className="component-group-count"
                        title={`Sensors in ${assignGroup.name} / sensors in this component`}
                        data-testid={`assign-count-${component}`}
                    >
                        <b>{assignedHere}</b> / {compSensors.length}
                    </span>
                ) : (
                    <span className="component-group-count">
                        {selectedInGroup > 0 ? <><b>{selectedInGroup}</b> / {compSensors.length}</> : compSensors.length}
                    </span>
                )}
            </div>
        );
    };

    const renderItem = (it: ListItem) => {
        if (it.k === 'header') return renderHeader(it.component, it.list);
        if (it.k === 'prefix') {
            return (
                <div className="sensor-run-prefix" data-testid="sensor-run-prefix" title={`Every sensor below starts with: ${it.prefix}`}>
                    {it.prefix}
                </div>
            );
        }
        return (
            <SensorSetContext.Provider value={it.prefix}>
                <SensorNamesContext.Provider value={it.set}>
                    <SensorSetDropContext.Provider value={!!it.prefix}>
                        {renderSensorRow(it.sensor)}
                    </SensorSetDropContext.Provider>
                </SensorNamesContext.Provider>
            </SensorSetContext.Provider>
        );
    };

    // Windowed: the run (and component) the top row belongs to stays named while its own line is scrolled away.
    let stickyRun: { component: string; prefix: string } | null = null;
    if (windowed && view.top >= 4) {
        const top = lineAt(view.top + 2);
        const it = items[top];
        if (it?.k === 'row' && it.prefix) {
            let component = '';
            for (let i = top; i >= 0; i--) {
                const h = items[i];
                if (h.k === 'header') { component = h.component; break; }
            }
            stickyRun = { component, prefix: it.prefix };
        }
    }

    const listBody = windowed ? (
        <>
            <div className="sensor-run-stick" aria-hidden="true">
                {stickyRun && <div className="sensor-run-sticky" data-testid="sensor-run-sticky"><b>{stickyRun.component}</b> · {stickyRun.prefix}</div>}
            </div>
            <div className="sensor-list-window" style={{ height: offsets[items.length] }} data-testid="sensor-list-window">
                {items.slice(windowStart, windowEnd).map((it, n) => {
                    const i = windowStart + n;
                    const key = itemKey(it);
                    // Rows beside each other share one margin in a plain list; here each has its own box.
                    const follows = it.k === 'row' && items[i - 1]?.k === 'row';
                    return (
                        <div
                            key={key}
                            className={`sensor-list-line${follows ? ' sensor-list-line--follow' : ''}`}
                            ref={lineRef(key)}
                            style={{ top: offsets[i] }}
                        >
                            {renderItem(it)}
                        </div>
                    );
                })}
            </div>
        </>
    ) : (() => {
        // A short list: one block per component.
        const groups: { component: string; lines: ListItem[] }[] = [];
        for (const it of items) {
            if (it.k === 'header') groups.push({ component: it.component, lines: [it] });
            else groups[groups.length - 1]?.lines.push(it);
        }
        return groups.map(g => (
            <div key={g.component}>
                {g.lines.map(it => <Fragment key={itemKey(it)}>{renderItem(it)}</Fragment>)}
            </div>
        ));
    })();

    return (
        <SensorMetaContext.Provider value={sensorLookup}>
        <div className="sensor-selection-widget h-full flex flex-col" ref={rootRef}>
            {assignGroup && (
                <div className={`fg-assignbar fg-group-color-${getGroupColor(assignGroup.no)}`} role="status" data-testid="fg-assignbar">
                    <span className="fg-group-dot" aria-hidden="true" />
                    <span className="fg-assignbar-text">
                        Assigning to <b>FG-{assignGroup.no} · {assignGroup.name}</b>. Use the Failure groups button
                        {' '}<FolderPlus size={12} className="fg-callout-icon" aria-hidden="true" />{' '}
                        on a sensor row.
                    </span>
                    <button
                        ref={assignDoneRef}
                        type="button"
                        className="fg-sheet-btn"
                        onClick={() => { setFgSheetFor(null); onAssignDone?.(); }}
                    >
                        Done
                    </button>
                </div>
            )}
            <div className="widget-header flex-shrink-0" style={{ flexDirection: 'column', gap: '8px', alignItems: 'stretch' }}>
                <input
                    type="text"
                    placeholder="Search description, tag, unit or component…"
                    value={searchTerm}
                    onChange={e => handleSearchChange(e.target.value)}
                    className="search-input-compact"
                />

                {isFilterActive && (
                    <div className="sensor-actions-compact" style={{ alignSelf: 'flex-end' }}>
                        <button className="text-btn" onClick={handleClearFilter}>Clear filter</button>
                    </div>
                )}

            </div>

            <div className="sensor-list-widget flex-1 min-h-0 overflow-y-auto" ref={listRef} onScroll={readView}>
                <SensorSearchContext.Provider value={hasLongNames ? searchTerm : ''}>{listBody}</SensorSearchContext.Provider>
                {groupedSensors.length === 0 && (
                    <div className="no-results">No sensors found</div>
                )}
            </div>

            {fgSheetFor && (
                <FailureGroupAssignSheet
                    tag={fgSheetFor}
                    info={sensorLookup(fgSheetFor)}
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
                    onClose={closeSheet}
                    getHostEl={getHostEl}
                    getRowEl={getSheetRowEl}
                    getListEl={getListEl}
                    pinnedGroupNo={assignGroup?.no ?? null}
                />
            )}
        </div>
        </SensorMetaContext.Provider>
    );
}
