import { Fragment, memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown, Search, Plus, Check } from 'lucide-react';
import { SensorMetadata } from '../../types';
import { SensorLabel, SensorNamesContext, SensorSetContext } from '../sensor/SensorLabel';
import { SensorMetaContext, useLayeredSensorLookup, type SensorNamesValue } from '../sensor/sensorInfo';
import { useCutRuns } from '../../hooks/useNameFit';
import { useWindowedLines } from '../../hooks/useWindowedLines';
import { commonPrefix, displayedName } from '../../utils/sensorNames';

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

/** Rule 6 (DESIGN_SYSTEM §4): over this many lines only the lines in view are rendered. */
const WINDOW_ABOVE = 150;
const WINDOW_OVERSCAN_PX = 400;
const HEADER_EST_PX = 30;
const ROW_EST_PX = 46;
const VIEW_FALLBACK_PX = 600;

/** One component's names, worked out once: every row of the group shares this set and its one run id. */
interface GroupSet {
    prefix: string;
    value: SensorNamesValue;
}
/** The group of the sensors with no component (not a component name: the list groups by real names). */
const NO_COMPONENT = '\u0000none';

type ListLine =
    | { k: 'header'; component: string }
    | { k: 'row'; sensor: string; group: string };

const lineKey = (l: ListLine) => (l.k === 'header' ? `h:${l.component}` : `r:${l.sensor}`);
const estimateLine = (l: ListLine) => (l.k === 'header' ? HEADER_EST_PX : ROW_EST_PX);

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

    const listRef = useRef<HTMLDivElement>(null);
    const getList = useCallback(() => listRef.current, []);

    // Each group is one set, measured together on the list: one row's cut marks its whole group, and a list over
    // 150 lines reads the same as one under 150.
    const { groupSets, setsKey, hasRuns } = useMemo(() => {
        const sets = new Map<string, GroupSet>();
        const keyParts: string[] = [];
        let runs = false;
        const add = (group: string, tags: string[]) => {
            const names = tags.map(t => displayedName(sensorLookup(t)));
            const prefix = commonPrefix(names);
            if (prefix) runs = true;
            keyParts.push(group, ...names);
            sets.set(group, { prefix, value: { names, run: prefix ? group : '' } });
        };
        for (const component of groupedSensors.sortedKeys) add(component, groupedSensors.groups[component]);
        add(NO_COMPONENT, groupedSensors.noComponent);
        return { groupSets: sets, setsKey: keyParts.join('|'), hasRuns: runs };
    }, [groupedSensors, sensorLookup]);
    const cutRuns = useCutRuns(getList, setsKey, hasRuns);

    const lines = useMemo<ListLine[]>(() => {
        const out: ListLine[] = [];
        for (const component of groupedSensors.sortedKeys) {
            out.push({ k: 'header', component });
            if (isExpanded(component)) for (const sensor of groupedSensors.groups[component]) out.push({ k: 'row', sensor, group: component });
        }
        for (const sensor of groupedSensors.noComponent) out.push({ k: 'row', sensor, group: NO_COMPONENT });
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupedSensors, expandedComponents, searchTerm]);
    const windowed = lines.length > WINDOW_ABOVE;
    const { offsets, windowStart, windowEnd, readView, lineRef } = useWindowedLines({
        listRef,
        lines,
        keyOf: lineKey,
        estimate: estimateLine,
        windowed,
        overscanPx: WINDOW_OVERSCAN_PX,
        fallbackHeightPx: VIEW_FALLBACK_PX,
        anchorList: lines,
    });

    /** A row's group: its shared start (only while the group is cut) and the names it must read differently from. */
    const inGroup = (group: string, row: ReactNode) => {
        const set = groupSets.get(group);
        if (!set) return row;
        return (
            <SensorSetContext.Provider value={cutRuns.has(set.value.run) ? set.prefix : ''}>
                <SensorNamesContext.Provider value={set.value}>{row}</SensorNamesContext.Provider>
            </SensorSetContext.Provider>
        );
    };

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
                    <SensorLabel tag={sensor} wrap />
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

    const renderHeader = (comp: string) => {
        const expanded = isExpanded(comp);
        const count = groupedSensors.groups[comp].length;
        const picked = groupedSensors.groups[comp].filter(s => selectedSensors.includes(s)).length;
        return (
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

            <div className="special-sensor-explorer-list custom-scrollbar" ref={listRef} onScroll={readView}>
                {windowed ? (
                    <div className="special-sensor-window" style={{ height: offsets[lines.length] }} data-testid="explorer-window">
                        {lines.slice(windowStart, windowEnd).map((l, n) => {
                            const key = lineKey(l);
                            return (
                                <div
                                    key={key}
                                    className="special-sensor-line"
                                    style={{ top: offsets[windowStart + n] }}
                                    ref={lineRef(key)}
                                >
                                    {l.k === 'header'
                                        ? renderHeader(l.component)
                                        : inGroup(l.group, renderSensorItem(l.sensor))}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <>
                        {groupedSensors.sortedKeys.map(comp => (
                            <div key={comp}>
                                {renderHeader(comp)}
                                {isExpanded(comp) && groupedSensors.groups[comp].map(sensor => (
                                    <Fragment key={sensor}>{inGroup(comp, renderSensorItem(sensor))}</Fragment>
                                ))}
                            </div>
                        ))}

                        {groupedSensors.noComponent.map(sensor => (
                            <Fragment key={sensor}>{inGroup(NO_COMPONENT, renderSensorItem(sensor))}</Fragment>
                        ))}
                    </>
                )}

                {sensors.length === 0 && (
                    <div className="special-sensor-explorer-empty">No sensors found</div>
                )}
            </div>
        </div>
        </SensorMetaContext.Provider>
    );
}

export default memo(SensorExplorer);
