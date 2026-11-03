import { Fragment, memo, useCallback, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Search, Plus, Check } from 'lucide-react';
import { SensorMetadata } from '../../types';
import { NameText, SensorLabel, SensorNamesContext, SensorSetContext, SensorSetDropContext } from '../sensor/SensorLabel';
import { SensorMetaContext, nameRuns, useLayeredSensorLookup, type SensorNamesValue } from '../sensor/sensorInfo';
import { useCutRuns } from '../../hooks/useNameFit';
import { useWindowedLines } from '../../hooks/useWindowedLines';
import { displayedName } from '../../utils/sensorNames';

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
const PREFIX_EST_PX = 22;
const ROW_EST_PX = 46;
const VIEW_FALLBACK_PX = 600;
/** The sticky line's height: the row just below it decides what it names. */
const STICKY_PX = 30;

/** The group of the sensors with no component (not a component name: the list groups by real names). */
const NO_COMPONENT = '\u0000none';

type ListLine =
    | { k: 'header'; component: string }
    | { k: 'prefix'; id: string; prefix: string; component: string }
    | { k: 'row'; sensor: string; prefix: string; set: SensorNamesValue; component: string };

const lineKey = (l: ListLine) => (l.k === 'header' ? `h:${l.component}` : l.k === 'prefix' ? `p:${l.id}` : `r:${l.sensor}`);
const estimateLine = (l: ListLine) => (l.k === 'header' ? HEADER_EST_PX : l.k === 'prefix' ? PREFIX_EST_PX : ROW_EST_PX);

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

    // Rule 2: consecutive rows whose names share a start are one set, measured together on the list. A group holds
    // several families, so the run is what shares a start, not the group. While a row of a run is cut, its start
    // prints once on a line of its own and the rows print the rest; a list over 150 lines reads the same as one under.
    const allLines = useMemo<ListLine[]>(() => {
        const nameOf = (t: string) => displayedName(sensorLookup(t));
        const out: ListLine[] = [];
        const addRows = (component: string, tags: string[]) => {
            for (const run of nameRuns(tags, nameOf)) {
                const id = `${component}:${run.tags[0]}`;
                if (run.prefix) out.push({ k: 'prefix', id, prefix: run.prefix, component });
                const set: SensorNamesValue = { names: run.names, run: run.prefix ? id : '' };
                for (const sensor of run.tags) out.push({ k: 'row', sensor, prefix: run.prefix, set, component });
            }
        };
        for (const component of groupedSensors.sortedKeys) {
            out.push({ k: 'header', component });
            if (isExpanded(component)) addRows(component, groupedSensors.groups[component]);
        }
        addRows(NO_COMPONENT, groupedSensors.noComponent);
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupedSensors, expandedComponents, searchTerm, sensorLookup]);
    const hasRuns = useMemo(() => allLines.some(l => l.k === 'prefix'), [allLines]);
    const cutRuns = useCutRuns(getList, `${allLines.length}|${searchTerm}|${[...expandedComponents].join('|')}`, hasRuns);
    const lines = useMemo<ListLine[]>(() => (!hasRuns ? allLines : allLines
        .filter(l => l.k !== 'prefix' || cutRuns.has(l.id))
        .map(l => (l.k === 'row' && l.prefix && !cutRuns.has(l.set.run) ? { ...l, prefix: '' } : l))
    ), [allLines, hasRuns, cutRuns]);
    const windowed = lines.length > WINDOW_ABOVE;
    const { view, offsets, windowStart, windowEnd, lineAt, readView, lineRef } = useWindowedLines({
        listRef,
        lines,
        keyOf: lineKey,
        estimate: estimateLine,
        windowed,
        overscanPx: WINDOW_OVERSCAN_PX,
        fallbackHeightPx: VIEW_FALLBACK_PX,
        // A new search or an opened group starts over; a run's line appearing does not.
        anchorList: allLines,
    });

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
                    <SensorLabel tag={sensor} wrap="always" />
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

    const renderLine = (l: ListLine) => {
        if (l.k === 'header') return renderHeader(l.component);
        if (l.k === 'prefix') {
            return (
                <div className="special-sensor-run-prefix" data-testid="explorer-run-prefix" title={`Every sensor below starts with: ${l.prefix}`}>
                    <NameText text={l.prefix} prefix="" grow className="special-sensor-run-name" />
                </div>
            );
        }
        return (
            <SensorSetContext.Provider value={l.prefix}>
                <SensorNamesContext.Provider value={l.set}>
                    <SensorSetDropContext.Provider value={!!l.prefix}>
                        {renderSensorItem(l.sensor)}
                    </SensorSetDropContext.Provider>
                </SensorNamesContext.Provider>
            </SensorSetContext.Provider>
        );
    };

    // Windowed: what the row under the line belongs to stays named while its own header is scrolled away.
    let sticky: { component: string; prefix: string } | null = null;
    if (windowed && view.top >= 4) {
        const top = lines[lineAt(view.top + STICKY_PX + 2)];
        if (top && top.k !== 'header') {
            const component = top.component === NO_COMPONENT ? '' : top.component;
            if (component || top.prefix) sticky = { component, prefix: top.prefix };
        }
    }

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
                {windowed && (
                    <div className="special-sensor-stick" aria-hidden="true">
                        {sticky && (
                            <div className="special-sensor-sticky" data-testid="explorer-sticky">
                                {sticky.component && <b>{sticky.component}</b>}
                                {sticky.component && sticky.prefix && <span>·</span>}
                                {sticky.prefix && <NameText text={sticky.prefix} prefix="" grow className="special-sensor-run-name" />}
                            </div>
                        )}
                    </div>
                )}
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
                                    {renderLine(l)}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    lines.map(l => <Fragment key={lineKey(l)}>{renderLine(l)}</Fragment>)
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
