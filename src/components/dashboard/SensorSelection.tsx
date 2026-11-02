import { Fragment, useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { ChevronRight, ChevronDown, FolderPlus, X, Bell } from 'lucide-react';
import { SensorMetadata, FailureGroup, FailureModel, ModelKind, AlarmLevel } from '../../types';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { modelSensorKey } from '../../utils/modelGrouping';
import { ALARM_LEVELS, ALARM_LABELS, isCriticalAlarmLevel, alarmLevelColor, hasAlarmSetpoints } from '../../utils/alarmLevels';
import AnchoredPopover, { type PopoverAnchorRect } from '../AnchoredPopover';
import FailureGroupAssignSheet, { KIND_LETTER, KIND_LABEL, ALL_KINDS } from './FailureGroupAssignSheet';
import { SensorLabel, SensorNamesContext, SensorSearchContext, SensorSetContext, SensorSetDropContext } from '../sensor/SensorLabel';
import { SensorMetaContext, useLayeredSensorLookup, type SensorNamesValue } from '../sensor/sensorInfo';
import { useCutRuns } from '../../hooks/useNameFit';
import { NAME_TAIL_MAX, commonPrefix, displayedName, splitName } from '../../utils/sensorNames';



interface SensorSelectionProps {
    sensors: string[];
    selectedSensors: string[];
    onSensorChange: (sensors: string[]) => void;
    /** When set, selecting a NEW sensor once selectedSensors.length has
     *  already reached this count is a no-op — used to hard-block picking a
     *  5th sensor while Pair Plot is active (WebGL context exhaustion): the
     *  click is blocked rather than silently redirecting away from the chart
     *  afterward. Deselecting is never blocked. */
    maxSelectable?: number;
    sensorMetadata: SensorMetadata[] | null;
    fgGroups: FailureGroup[];
    fgModels: FailureModel[];
    getGroupColor: (groupNo: number) => string;
    /** Toggles a specific (sensor, group, kind) membership on/off — creates
     *  or reuses a model of that kind for this sensor (a sensor can carry
     *  more than one model kind at once, e.g. both Individual and
     *  Relationship, and more than one group). One control does both add and
     *  remove, no separate confirm step — clicking an already-member kind
     *  removes it, clicking an absent one adds it. */
    onToggleSensorGroupKind: (tag: string, groupNo: number, kind: ModelKind) => void;
    onCreateGroupForSensor: (tag: string, name: string) => void;
    onRenameGroup: (groupNo: number, name: string) => void;
    onDeleteGroup: (groupNo: number) => void;
    /** Which alarm setpoint lines are toggled on, per sensor tag. */
    alarmLinesEnabled: Record<string, AlarmLevel[]>;
    onToggleAlarmLine: (tag: string, level: AlarmLevel) => void;
    /** "Assign sensors →" on a Failure Groups card: the group being filled. A
     *  bar names it, component counts read "assigned / total" for it, and the
     *  assignment sheet pins it first. `null`/omitted = the ordinary Sensor tab. */
    assignGroupNo?: number | null;
    /** The bar's Done — the Dashboard goes back to the Failure Groups tab. */
    onAssignDone?: () => void;
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

/** The start a row's run shares: its name without the distinguishing end. A name whose end is too long to split
 *  still joins its run (its start = all but its last segment). */
function runKeyOf(name: string): string {
    let head = splitName(name).head;
    if (!head) {
        const seps = [...name.matchAll(/\s[-–—·|/]\s/g)];
        head = seps.length ? name.slice(0, seps[seps.length - 1].index) : '';
    }
    return head.replace(/\s*[-–—·|/]\s*$/, '');
}

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
    // Component groups the user has manually expanded. Everything starts
    // collapsed — browsing means opening a component to see its sensors,
    // not scanning a flat 133-row list.
    const [expandedComponents, setExpandedComponents] = useState<Set<string>>(new Set());
    // Which sensor the Failure Group Assignment sheet (FailureGroupAssignSheet)
    // is open for — `null` = closed. A full-height sheet docked to the left
    // edge of the Sensors panel; it is NOT dismissed by scrolling the list or
    // clicking inside the panel, only by the triggers listed above
    // `closeSheet` below. A sensor can belong to more than one group (and
    // kind), so the sheet is a matrix of toggles, not a single-select
    // assignment.
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
    // Each row's Failure groups button, so closing the sheet from the keyboard
    // (Esc / ✕ / Done) can hand focus back to the button that opened it.
    const fgButtonEls = useRef(new Map<string, HTMLButtonElement>());
    // The group an "Assign sensors" run is filling; gone (bar hides) if it was
    // deleted meanwhile.
    const assignGroup = assignGroupNo !== null && assignGroupNo !== 0
        ? fgGroups.find(g => g.no === assignGroupNo) ?? null
        : null;
    // A sensor the list should scroll to once its row has rendered (set by the
    // sheet's ‹ › buttons, which may have just expanded its component).
    const [scrollToSensor, setScrollToSensor] = useState<string | null>(null);
    // Windowed list (rule 6, see `items` below): what is in view, and the heights measured so far.
    const [view, setView] = useState({ top: 0, height: VIEW_FALLBACK_PX });
    const measuredHeights = useRef(new Map<string, number>());
    const [measureTick, setMeasureTick] = useState(0);
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
    // Labels (rows + the assignment sheet header) read this panel's own metadata, layered on the
    // window's provider so special-sensor badges still come through.
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
    // local to THIS component, not tied to the row's lifecycle, so without
    // this effect collapsing then re-expanding the group (or filtering the row
    // out then clearing the search) would remount the popover at the stale rect
    // captured before the row disappeared. One shared effect, keyed on the
    // actual visible row set, closes whichever panel's row just left it —
    // covers the collapse/expand path, the filter-out/clear-search path, and a
    // sensor that disappears from `sensors` altogether (a deleted special
    // sensor). The assignment sheet follows the same rule: with its row gone
    // there is nothing for its arrow to point at, so it closes (its own ‹ ›
    // buttons expand the target's component in the SAME update, so they never
    // trip it).
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
        if (!row) {
            // Not rendered yet: a windowed row is not in the DOM until it is in view, so scroll to its place.
            // Runs again when visibleSensorSet or the window changes.
            const at = windowedOffsetOf.current ? windowedOffsetOf.current(scrollToSensor) : -1;
            if (at >= 0 && listRef.current) listRef.current.scrollTop = Math.max(0, at - 60);
            return;
        }
        row.scrollIntoView?.({ block: 'nearest' });
        setScrollToSensor(null);
    }, [scrollToSensor, visibleSensorSet, view.top, measureTick]);

    // Membership index: sensor tag (lower-cased) -> set of "<groupNo>:<kind>".
    // Built once per `fgModels` change, so each row's lookups are O(1) instead
    // of a scan of `fgModels` for every (group, kind) pair of every rendered
    // row on every render (every keystroke in the search box).
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
    // closes. The assignment sheet closes on a keystroke too ("search changes"
    // is one of its dismissals); clearing the search through its ‹ › buttons is
    // a programmatic change, not typing, so it keeps it open.
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

    // "Assign sensors →" moves keyboard focus to the bar's Done (the FG card
    // that had it is gone), so the run starts somewhere visible, not on <body>.
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

    // Assign mode: per component, how many of its sensors already have a model
    // in the group being filled ("assigned / total" on the component header).
    // Only built while a run is active, from the membership index above.
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
                        {/* The stacked SensorLabel — description + unit chip,
                            tag on line 2, full name in the title when it truncates. */}
                        <label htmlFor={`sensor-${sensor}`} onClick={(e) => e.stopPropagation()} className="sensor-row-label">
                            <SensorLabel tag={sensor} info={sensorLookup(sensor)} wrap />
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
                                {/* The kind badge leads the chip. Reuses
                                    `.model-kind-icon--*`, the class Build
                                    Model's own model rows use. */}
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

    // ── The list's lines ─────────────────────────────────────────────────────
    // Rule 2 at row level: consecutive rows whose names share a start get that start ONCE on a muted line and
    // the rows drop it, only while one of those rows is really cut at the panel's current width. `commonPrefix`
    // has the short-name guard, so a run of short names never gets a line (nor any measuring attribute).
    // Every name is the DISPLAYED name, so a tag-only sensor joins its run like any other.
    const allItems = useMemo<ListItem[]>(() => {
        const nameOf = (t: string) => displayedName(sensorLookup(t));
        const keys = new Map<string, string>();
        const runKey = (t: string) => {
            let key = keys.get(t);
            if (key === undefined) { key = runKeyOf(nameOf(t)); keys.set(t, key); }
            return key;
        };
        const out: ListItem[] = [];
        for (const [component, list] of groupedSensors) {
            out.push({ k: 'header', component, list });
            if (!isComponentExpanded(component)) continue;
            let i = 0;
            while (i < list.length) {
                const key = runKey(list[i]);
                let j = i + 1;
                while (key && j < list.length && runKey(list[j]) === key) j++;
                const names = list.slice(i, j).map(nameOf);
                const prefix = names.length >= 2 ? commonPrefix(names) : '';
                const id = `${component}:${list[i]}`;
                if (prefix) out.push({ k: 'prefix', id, prefix });
                const set: SensorNamesValue = { names, run: prefix ? id : '' };
                for (let r = i; r < j; r++) out.push({ k: 'row', sensor: list[r], prefix, set });
                i = j;
            }
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupedSensors, expandedComponents, searchTerm, sensorLookup]);
    const hasRuns = useMemo(() => allItems.some(it => it.k === 'prefix'), [allItems]);
    // Search hits are marked only in a project that has long names (a match may sit in a cut-off head); a project
    // of short names keeps today's plain rows.
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
    const offsets = useMemo(() => {
        const off = new Array<number>(items.length + 1);
        off[0] = 0;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const est = it.k === 'header' ? HEADER_EST_PX
                : it.k === 'prefix' ? PREFIX_EST_PX
                    : ROW_EST_PX + (membershipIndex.get(normalizeSensorTag(it.sensor))?.size ? CHIPS_EST_PX : 0);
            off[i + 1] = off[i] + (measuredHeights.current.get(itemKey(it)) ?? est);
        }
        return off;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, measureTick, membershipIndex]);
    /** The first line reaching past `px`. */
    const lineAt = (px: number): number => {
        let a = 0;
        let b = items.length;
        while (a < b) {
            const m = (a + b) >> 1;
            if (offsets[m + 1] <= px) a = m + 1; else b = m;
        }
        return a;
    };
    let windowStart = 0;
    let windowEnd = items.length;
    if (windowed) {
        windowStart = lineAt(view.top - WINDOW_OVERSCAN);
        windowEnd = windowStart;
        while (windowEnd < items.length && offsets[windowEnd] < view.top + view.height + WINDOW_OVERSCAN) windowEnd++;
    }
    windowedOffsetOf.current = windowed
        ? (sensor: string) => {
            const i = items.findIndex(it => it.k === 'row' && it.sensor === sensor);
            return i < 0 ? -1 : offsets[i];
        }
        : null;

    const handleListScroll = () => {
        const el = listRef.current;
        if (!el) return;
        const next = { top: el.scrollTop, height: el.clientHeight || VIEW_FALLBACK_PX };
        setView(v => (Math.abs(v.top - next.top) < 6 && v.height === next.height ? v : next));
    };
    // A list that starts hidden has no height yet, and growing it fires no scroll event.
    useEffect(() => {
        handleListScroll();
        const el = listRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(handleListScroll);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const lineEls = useRef(new Map<string, HTMLElement>());
    const measureLines = useCallback(() => {
        let changed = false;
        for (const [key, el] of lineEls.current) {
            // The used height in CSS px: a rect is scaled by the page's zoom, offsetHeight is rounded.
            const h = parseFloat(getComputedStyle(el).height);
            if (h > 0 && Math.abs((measuredHeights.current.get(key) ?? -1) - h) > 0.1) {
                measuredHeights.current.set(key, h);
                changed = true;
            }
        }
        if (changed) setMeasureTick(t => t + 1);
    }, []);
    // After every commit, and when a line changes height with no commit at all (the web font arriving, a width change).
    const lineObserver = useRef<{ ro: ResizeObserver; watched: Set<HTMLElement> } | null>(null);
    useLayoutEffect(() => {
        if (!windowed) return;
        measureLines();
        if (typeof ResizeObserver === 'undefined') return;
        if (!lineObserver.current) lineObserver.current = { ro: new ResizeObserver(measureLines), watched: new Set() };
        const { ro, watched } = lineObserver.current;
        const now = new Set(lineEls.current.values());
        for (const el of watched) if (!now.has(el)) { ro.unobserve(el); watched.delete(el); }
        for (const el of now) if (!watched.has(el)) { ro.observe(el); watched.add(el); }
    });
    useEffect(() => () => {
        lineObserver.current?.ro.disconnect();
        lineObserver.current = null;
    }, []);
    // A line above the view that changes height (first measured, or a run's line appearing) must not move what
    // the user is looking at: the first line in view keeps its place on screen. A new search starts over.
    const anchor = useRef<{ list: ListItem[]; key: string; offset: number } | null>(null);
    useLayoutEffect(() => {
        const el = listRef.current;
        if (!el || !windowed) { anchor.current = null; return; }
        const a = anchor.current;
        if (a && a.list === allItems && el.scrollTop > 0) {
            const i = items.findIndex(it => itemKey(it) === a.key);
            if (i >= 0 && Math.abs(offsets[i] - a.offset) >= 1) el.scrollTop += offsets[i] - a.offset;
        }
        const top = lineAt(el.scrollTop);
        anchor.current = items[top] ? { list: allItems, key: itemKey(items[top]), offset: offsets[top] } : null;
    });

    const renderHeader = (component: string, compSensors: string[]) => {
        const expanded = isComponentExpanded(component);
        // "selected / total" (e.g. "2 / 8") once at least one
        // sensor in this component is on the chart — matching
        // the approved prototype's own counter exactly, which
        // hides the "0 / " prefix rather than showing it
        // (a bare total reads the same as "nothing selected
        // yet" without needing the extra "0 /" noise).
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
                    {it.prefix} <span aria-hidden="true">…</span>
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
                {stickyRun && <div className="sensor-run-sticky" data-testid="sensor-run-sticky"><b>{stickyRun.component}</b> · {stickyRun.prefix} …</div>}
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
                            ref={el => { if (el) lineEls.current.set(key, el); else lineEls.current.delete(key); }}
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

            <div className="sensor-list-widget flex-1 min-h-0 overflow-y-auto" ref={listRef} onScroll={handleListScroll}>
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
