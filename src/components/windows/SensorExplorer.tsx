import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, Search, Plus, Check } from 'lucide-react';
import { SensorMetadata } from '../../types';
import { SensorLabel, SensorSetProvider } from '../sensor/SensorLabel';
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

/** Rule 6 (DESIGN_SYSTEM §4): over this many lines only the lines in view are rendered. */
const WINDOW_ABOVE = 150;
const WINDOW_OVERSCAN_PX = 400;
const HEADER_EST_PX = 30;
const ROW_EST_PX = 46;
const VIEW_FALLBACK_PX = 600;

type ListLine =
    | { k: 'header'; component: string }
    | { k: 'row'; sensor: string; set: string[] };

const lineKey = (l: ListLine) => (l.k === 'header' ? `h:${l.component}` : `r:${l.sensor}`);

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
    const [view, setView] = useState({ top: 0, height: VIEW_FALLBACK_PX });
    const heights = useRef(new Map<string, number>());
    const [heightTick, setHeightTick] = useState(0);
    const lineEls = useRef(new Map<string, HTMLElement>());

    const lines = useMemo<ListLine[]>(() => {
        const out: ListLine[] = [];
        for (const component of groupedSensors.sortedKeys) {
            out.push({ k: 'header', component });
            if (isExpanded(component)) for (const sensor of groupedSensors.groups[component]) out.push({ k: 'row', sensor, set: groupedSensors.groups[component] });
        }
        for (const sensor of groupedSensors.noComponent) out.push({ k: 'row', sensor, set: groupedSensors.noComponent });
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupedSensors, expandedComponents, searchTerm]);
    const windowed = lines.length > WINDOW_ABOVE;
    const offsets = useMemo(() => {
        const off = new Array<number>(lines.length + 1);
        off[0] = 0;
        lines.forEach((l, i) => { off[i + 1] = off[i] + (heights.current.get(lineKey(l)) ?? (l.k === 'header' ? HEADER_EST_PX : ROW_EST_PX)); });
        return off;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lines, heightTick]);
    let windowStart = 0;
    let windowEnd = lines.length;
    if (windowed) {
        const from = view.top - WINDOW_OVERSCAN_PX;
        let a = 0;
        let b = lines.length;
        while (a < b) {
            const m = (a + b) >> 1;
            if (offsets[m + 1] <= from) a = m + 1; else b = m;
        }
        windowStart = a;
        windowEnd = a;
        while (windowEnd < lines.length && offsets[windowEnd] < view.top + view.height + WINDOW_OVERSCAN_PX) windowEnd++;
    }
    const readView = useCallback(() => {
        const el = listRef.current;
        if (!el) return;
        const next = { top: el.scrollTop, height: el.clientHeight || VIEW_FALLBACK_PX };
        setView(v => (Math.abs(v.top - next.top) < 6 && v.height === next.height ? v : next));
    }, []);
    // A list that starts hidden has no height yet, and growing it fires no scroll event.
    useEffect(() => {
        readView();
        const el = listRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(readView);
        ro.observe(el);
        return () => ro.disconnect();
    }, [readView]);
    // Heights are estimated until a line has been rendered (a row with a long name can take more lines).
    useLayoutEffect(() => {
        if (!windowed) return;
        let changed = false;
        for (const [key, el] of lineEls.current) {
            const h = parseFloat(getComputedStyle(el).height);
            if (h > 0 && Math.abs((heights.current.get(key) ?? -1) - h) > 0.1) {
                heights.current.set(key, h);
                changed = true;
            }
        }
        if (changed) setHeightTick(t => t + 1);
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
                                    ref={el => { if (el) lineEls.current.set(key, el); else lineEls.current.delete(key); }}
                                >
                                    {l.k === 'header'
                                        ? renderHeader(l.component)
                                        : <SensorSetProvider tags={l.set}>{renderSensorItem(l.sensor)}</SensorSetProvider>}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <>
                        {groupedSensors.sortedKeys.map(comp => (
                            <div key={comp}>
                                {renderHeader(comp)}
                                {isExpanded(comp) && (
                                    <SensorSetProvider tags={groupedSensors.groups[comp]}>
                                        {groupedSensors.groups[comp].map(sensor => <Fragment key={sensor}>{renderSensorItem(sensor)}</Fragment>)}
                                    </SensorSetProvider>
                                )}
                            </div>
                        ))}

                        {groupedSensors.noComponent.length > 0 && (
                            <SensorSetProvider tags={groupedSensors.noComponent}>
                                {groupedSensors.noComponent.map(sensor => <Fragment key={sensor}>{renderSensorItem(sensor)}</Fragment>)}
                            </SensorSetProvider>
                        )}
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
