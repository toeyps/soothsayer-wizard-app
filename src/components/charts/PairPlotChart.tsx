import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from 'react';
import { Lasso, Move, RotateCcw, X, Search } from 'lucide-react';
import PairPlotCell, { HoverInfo, Cluster, fitLabel } from './PairPlotCell';
import AxisLabel from './AxisLabel';
import ClusterLegend from './ClusterLegend';
import { nextClusterColour, nextClusterName } from './pairPlotClusters';
import { TooltipRowName } from '../sensor/SensorLabel';
import { SensorMetaContext, fmtNum, sensorPlainLabel, ttRowClass, useLayeredSensorLookup, useSensorLookup } from '../sensor/sensorInfo';
import { commonPrefix, displayedName, splitInSet } from '../../utils/sensorNames';
import { monoFontFamily, textWidth } from '../../utils/textMeasure';
import { tooltipDistinctEnds } from '../../utils/tooltipLayout';
import { ChartProps, MAX_PAIR_PLOT_SENSORS } from './ChartTypes';
import { formatDateTime } from '../../utils/dateFormat';
import { formatDataStamp } from '../../utils/workbenchDate';
import { ACCENT_HEX, CANVAS_BG_HEX, correlationGradientHex, hexToRgba, hexToRgbaCss, rgbaToHex } from './pairPlotColors';
import { pearsonCorrelation } from './pairPlotStats';

type Tool = 'lasso' | 'pan';

/** Used by every scatter cell; derived from ACCENT_HEX so it matches the histogram bars. */
const POINT_COLOR: [number, number, number, number] = hexToRgba(ACCENT_HEX, 0.55);

/** Must match PairPlotCell's AXIS_PAD so the diagonal histogram's frame
 *  has the exact same inset as every scatter cell. */
const CELL_PAD = { left: 36, right: 4, top: 14, bottom: 18 };

/** Pure SVG so the diagonal does not use a WebGL context; same CELL_PAD as the scatter cells. */
function DiagonalHistogram({
    values, sensor, isTopRow,
}: {
    values: number[];
    sensor: string;
    /** Only row 0's diagonal prints its name; it doubles as the column header. */
    isTopRow: boolean;
}) {
    const sensorLookup = useSensorLookup();
    const containerRef = useRef<HTMLDivElement>(null);
    const [dims, setDims] = useState({ width: 0, height: 0 });

    // Track container pixel size so the SVG renders in pixel coordinates that
    // match PairPlotCell's frame insets exactly.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => setDims({ width: el.clientWidth, height: el.clientHeight });
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const bins = 20;
    const { counts } = useMemo(() => {
        const valid = values.filter(v => v != null && !isNaN(v));
        if (valid.length === 0) return { counts: new Array(bins).fill(0) };
        let mn = Infinity, mx = -Infinity;
        for (const v of valid) { if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mn === mx) mx = mn + 1;
        const step = (mx - mn) / bins;
        const c = new Array(bins).fill(0);
        for (const v of valid) {
            let idx = Math.floor((v - mn) / step);
            if (idx >= bins) idx = bins - 1;
            if (idx < 0) idx = 0;
            c[idx]++;
        }
        return { counts: c };
    }, [values]);

    const maxC = Math.max(1, ...counts);
    const innerW = Math.max(0, dims.width - CELL_PAD.left - CELL_PAD.right);
    const innerH = Math.max(0, dims.height - CELL_PAD.top - CELL_PAD.bottom);

    return (
        <div ref={containerRef} className="pair-regl-cell" style={{ background: CANVAS_BG_HEX }}>
            <svg
                width={dims.width}
                height={dims.height}
                style={{ position: 'absolute', top: 0, left: 0 }}
            >
                {isTopRow && (
                    <text
                        x={CELL_PAD.left + innerW / 2}
                        y={11}
                        textAnchor="middle"
                        fontSize="10"
                        fill="var(--text-primary)"
                        fontFamily="Inter, system-ui"
                    >
                        {fitLabel(sensorPlainLabel(sensorLookup(sensor)), innerW)}
                    </text>
                )}
                {/* Horizontal bars: low value at bottom, high at top. Bar length = count / max count across the inner plot width. */}
                {counts.map((c, i) => {
                    const y = CELL_PAD.top + (1 - (i + 1) / bins) * innerH;
                    const h = innerH / bins;
                    const w = (c / maxC) * innerW;
                    return (
                        <rect
                            key={i}
                            x={CELL_PAD.left}
                            y={y}
                            width={w}
                            height={Math.max(0, h - 0.5)}
                            fill={ACCENT_HEX}
                            opacity={0.75}
                        />
                    );
                })}
                {/* Cell border — exactly the same inset as PairPlotCell so the
                    matrix reads as a grid of uniform frames. */}
                <rect
                    x={CELL_PAD.left}
                    y={CELL_PAD.top}
                    width={innerW}
                    height={innerH}
                    fill="none"
                    stroke="var(--border-strong, #334155)"
                    strokeWidth="1"
                />
            </svg>
        </div>
    );
}

/** Lower-triangle correlation cell; r is computed once per matrix, tinted by sign and magnitude. */
/** Positioning for the two AxisLabel orientations: top = column headers, left = rotated row headers. */
const AXIS_LABEL_STYLE = {
    top: { top: 0, left: CELL_PAD.left, right: CELL_PAD.right, height: CELL_PAD.top },
    left: { top: CELL_PAD.top, bottom: CELL_PAD.bottom, left: 0, width: CELL_PAD.left },
} as const;

function CorrelationCell({
    r, sensorY, showYLabel, keyNo,
}: {
    r: number | null;
    sensorY: string;
    /** Rule 5: the row's key, when the matrix prints keys. */
    keyNo?: number;
    /** True only for the row's left-most correlation cell (column 0): the row's shared header. */
    showYLabel: boolean;
}) {
    // Colour by magnitude, not sign: weak |r| reads red, strong reads green in either direction.
    const mag = r == null ? 0 : Math.abs(r);
    const tintHex = correlationGradientHex(mag);
    const tintAlpha = r == null ? 0 : 0.22 + mag * 0.55;
    const textColor = r == null ? 'var(--text-secondary)' : 'var(--text-primary)';

    return (
        <>
            <div className="pair-regl-cell" style={{ background: CANVAS_BG_HEX }}>
                <div
                    style={{
                        position: 'absolute',
                        left: CELL_PAD.left, right: CELL_PAD.right,
                        top: CELL_PAD.top, bottom: CELL_PAD.bottom,
                        background: hexToRgbaCss(tintHex, tintAlpha),
                        border: '1px solid var(--border-strong, #334155)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                >
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 500, color: textColor }}>
                        {r == null ? 'n/a' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}`}
                    </span>
                </div>
            </div>
            {/* Sibling of .pair-regl-cell, not nested: the cell clips, and the hover tooltip must escape it. */}
            {showYLabel && (
                <AxisLabel tag={sensorY} rotate style={AXIS_LABEL_STYLE.left} keyNo={keyNo} />
            )}
        </>
    );
}

/** True when the WebGL cells would draw `a` and `b` identically — same ids,
 *  colours and row sets (labels are not drawn). */
function sameForCells(a: Cluster[], b: Cluster[]): boolean {
    return a.length === b.length && a.every((c, i) =>
        c.id === b[i].id && c.color === b[i].color && c.rowIndices === b[i].rowIndices);
}

/** Clusters follow their rows by timestamp into a new sample; a missing row leaves its cluster, an emptied cluster goes. */
function clustersInNewSample(clusters: Cluster[], from: ChartProps['data'], to: ChartProps['data']): Cluster[] {
    const rowsAt = new Map<string, number[]>();
    to.forEach((row, i) => {
        if (!row.timestamp) return;
        const rows = rowsAt.get(row.timestamp);
        if (rows) rows.push(i); else rowsAt.set(row.timestamp, [i]);
    });
    return clusters.flatMap(cluster => {
        const rowIndices = new Set<number>();
        for (const r of cluster.rowIndices) {
            const timestamp = from[r]?.timestamp;
            for (const next of (timestamp && rowsAt.get(timestamp)) || []) rowIndices.add(next);
        }
        return rowIndices.size > 0 ? [{ ...cluster, rowIndices }] : [];
    });
}

/** Focus the first control of a toolbox (the legend's focus fallback). */
function focusFirstTool(el: HTMLElement | null) {
    el?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
}

const RESET_VIEW_TITLE = 'Reset zoom and pan — every cell back to its full data range (clusters stay)';
const RESET_VIEW_IDLE_TITLE = 'Nothing to reset — zoom (scroll) or pan a cell first';

/** Resets zoom/pan only; clusters stay. aria-disabled keeps the tooltip when nothing is zoomed. */
function ResetViewButton({ canReset, onReset }: { canReset: boolean; onReset: () => void }) {
    return (
        <button
            type="button"
            onClick={canReset ? onReset : undefined}
            className="scatter-regl-tool"
            aria-disabled={!canReset}
            aria-label="Reset zoom and pan"
            title={canReset ? RESET_VIEW_TITLE : RESET_VIEW_IDLE_TITLE}
        >
            <RotateCcw size={13} />
        </button>
    );
}

function PairPlotChart({ data, sensors, headers, sensorMetadata }: ChartProps) {
    // Axis hover cards and the hover tooltip resolve labels through this lookup.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);
    /** Brushed clusters, one per lasso. Session-only, never persisted. */
    const [clusters, setClusters] = useState<Cluster[]>([]);
    /** Counter for unique cluster IDs (Date.now would collide if two lassos
     *  fire in the same ms while React batches state updates). */
    const clusterSeqRef = useRef(0);
    const [hover, setHover] = useState<HoverInfo | null>(null);
    /** Interaction mode shared by every cell and the enlarged dialog. */
    const [tool, setTool] = useState<Tool>('lasso');
    /** Bumped on each Reset click; cells watch it and call `sc.reset()`. */
    const [resetTick, setResetTick] = useState(0);
    /** Ids of cells currently zoomed/panned; empty = the reset button has nothing to undo. */
    const [zoomedCells, setZoomedCells] = useState<ReadonlySet<string>>(() => new Set());
    const handleZoomChange = useCallback((cellId: string, zoomed: boolean) => {
        setZoomedCells(prev => {
            if (prev.has(cellId) === zoomed) return prev;
            const next = new Set(prev);
            if (zoomed) next.add(cellId); else next.delete(cellId);
            return next;
        });
    }, []);
    const canResetView = zoomedCells.size > 0;
    /** Inspect mode: cells intercept clicks to open the enlarged view; turns itself off after one click. */
    const [inspectMode, setInspectMode] = useState(false);
    /** When non-null, render the enlarged-view dialog for the picked cell. */
    const [expanded, setExpanded] = useState<
        | { kind: 'diagonal'; sensorY: string }
        | { kind: 'scatter'; sensorY: string; sensorX: string }
        | { kind: 'time'; sensorY: string }
        | null
    >(null);

    const n = sensors.length;

    /** Lasso completed → spawn a new cluster: the smallest free "Cluster N"
     *  name and the first palette colour no cluster uses yet. */
    const handleLasso = useCallback((rows: number[]) => {
        if (rows.length === 0) return;
        setClusters(prev => [...prev, {
            id: `c-${++clusterSeqRef.current}`,
            label: nextClusterName(prev),
            color: nextClusterColour(prev),
            rowIndices: new Set(rows),
        }]);
    }, []);

    const handleDeleteCluster = useCallback((id: string) => {
        setClusters(cs => cs.filter(c => c.id !== id));
    }, []);

    /** Rename/recolour return the same array when nothing changes, so nothing re-renders. */
    const handleRename = useCallback((id: string, name: string) => {
        setClusters(cs => cs.some(c => c.id === id && c.label !== name)
            ? cs.map(c => c.id === id ? { ...c, label: name } : c)
            : cs);
    }, []);

    const handleRecolour = useCallback((id: string, hex: string) => {
        const want = hex.toLowerCase();
        setClusters(cs => cs.some(c => c.id === id && rgbaToHex(c.color) !== want)
            ? cs.map(c => c.id === id ? { ...c, color: hexToRgba(want) } : c)
            : cs);
    }, []);

    /** What the cells draw from; a rename keeps the same reference because cells never read labels. */
    const [sampleData, setSampleData] = useState(data);
    if (sampleData !== data) {
        // Adjusted while rendering, so no cell ever draws old row numbers on the new sample.
        setSampleData(data);
        setHover(null);
        if (clusters.length > 0) setClusters(clustersInNewSample(clusters, sampleData, data));
    }
    const [cellClusters, setCellClusters] = useState<Cluster[]>(clusters);
    if (cellClusters !== clusters && !sameForCells(cellClusters, clusters)) {
        // "Adjust state while rendering" (React docs): re-renders this
        // component before any child, no ref read during render.
        setCellClusters(clusters);
    }

    /** Reset affects the cameras only; clusters are removed via the legend. */
    const handleResetView = useCallback(() => {
        setResetTick(t => t + 1);
    }, []);

    const handleClearClusters = useCallback(() => {
        setClusters([]);
    }, []);

    const toolboxRef = useRef<HTMLDivElement>(null);

    // Rule 5: S1…Sn keys and a key line only when names share a start or a header would be cut; only grid width decides.
    const gridRef = useRef<HTMLDivElement>(null);
    const [gridWidth, setGridWidth] = useState(0);
    const hasGrid = n >= 2 && n <= MAX_PAIR_PLOT_SENSORS;
    useLayoutEffect(() => {
        const el = gridRef.current;
        if (!el) return;
        const update = () => setGridWidth(el.clientWidth);
        update();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, [hasGrid]);
    const pairKey = useMemo(() => {
        if (!hasGrid) return null;
        const names = sensors.map(t => displayedName(sensorLookup(t)));
        const prefix = commonPrefix(names);
        let cut = false;
        if (gridWidth > 0) {
            const room = (gridWidth - n) / (n + 1) - CELL_PAD.left - CELL_PAD.right - 2;
            const font = `10px ${monoFontFamily()}`;
            cut = sensors.some(t => textWidth(t, font) > room);
        }
        if (!prefix && !cut) return null;
        const tails = names.map(name => splitInSet(name, names, prefix || undefined).tail.trimStart());
        return { prefix, names, tails };
    }, [hasGrid, sensors, sensorLookup, gridWidth, n]);
    const keyOf = (sensor: string) => (pairKey ? sensors.indexOf(sensor) + 1 : undefined);
    const tailOf = (sensor: string) => pairKey?.tails[sensors.indexOf(sensor)];

    const hoverEnds = useMemo(() => (
        hover && !hover.isTimeAxis ? tooltipDistinctEnds([sensorLookup(hover.sensorX), sensorLookup(hover.sensorY)]) : new Map<string, string>()
    ), [hover?.sensorX, hover?.sensorY, hover?.isTimeAxis, sensorLookup]); // eslint-disable-line react-hooks/exhaustive-deps

    const expandToolboxRef = useRef<HTMLDivElement>(null);
    const focusToolbox = useCallback(() => focusFirstTool(toolboxRef.current), []);
    const focusExpandToolbox = useCallback(() => focusFirstTool(expandToolboxRef.current), []);

    // Pre-extract each sensor's column once for the diagonal histograms — saves
    // doing it inside the diagonal component each render.
    const sensorVals = useMemo(() => {
        return sensors.map(s => {
            const idx = headers.indexOf(s);
            if (idx < 0) return [];
            return data.map(d => d.values[idx] ?? NaN);
        });
    }, [data, sensors, headers]);

    /** Pearson r per lower-triangle pair, keyed `i-k` (row i, column k < i), from the already-loaded sample. */
    const correlations = useMemo(() => {
        const map = new Map<string, number | null>();
        for (let i = 0; i < sensors.length; i++) {
            for (let k = 0; k < i; k++) {
                map.set(`${i}-${k}`, pearsonCorrelation(sensorVals[i], sensorVals[k]));
            }
        }
        return map;
    }, [sensorVals, sensors.length]);

    if (n < 2) {
        return <div style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: '20%' }}>Select at least 2 sensors</div>;
    }
    // Covers the one frame before the bounce-back effect trims a selection over the cap (e.g. a restored workspace).
    if (n > MAX_PAIR_PLOT_SENSORS) {
        return (
            <div style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: '20%' }}>
                Pair Plot supports at most {MAX_PAIR_PLOT_SENSORS} sensors at once — {n} selected
            </div>
        );
    }

    // Grid template: n+1 columns (n sensors + 1 timeseries column) × n rows.
    const gridTemplate = {
        gridTemplateColumns: `repeat(${n + 1}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${n}, minmax(0, 1fr))`,
    };

    return (
        <SensorMetaContext.Provider value={sensorLookup}>
        <div className="pair-regl-wrap">
            {/* Lasso / Pan-zoom are mutually exclusive and shared by every cell and the enlarged dialog. */}
            <div className="pair-regl-toolbox" ref={toolboxRef}>
                <button
                    onClick={() => setTool('lasso')}
                    className={`scatter-regl-tool${tool === 'lasso' ? ' active' : ''}`}
                    title="Lasso select — drag to draw a polygon, rows inside light up across every cell"
                    aria-pressed={tool === 'lasso'}
                >
                    <Lasso size={13} />
                </button>
                <button
                    onClick={() => setTool('pan')}
                    className={`scatter-regl-tool${tool === 'pan' ? ' active' : ''}`}
                    title="Pan / zoom — drag to pan, scroll to zoom, without brushing a cluster"
                    aria-pressed={tool === 'pan'}
                >
                    <Move size={13} />
                </button>
                <button
                    onClick={() => setInspectMode(m => !m)}
                    className={`scatter-regl-tool${inspectMode ? ' active' : ''}`}
                    title="Magnifier — click a cell to open an enlarged view"
                    aria-pressed={inspectMode}
                >
                    <Search size={13} />
                </button>
                <ResetViewButton canReset={canResetView} onReset={handleResetView} />
            </div>

            {/* Cluster legend — chips in the strip above the matrix, left of
                the toolbox, so it never covers a data point. */}
            <ClusterLegend
                clusters={clusters}
                onRecolour={handleRecolour}
                onRename={handleRename}
                onRemove={handleDeleteCluster}
                onClear={handleClearClusters}
                focusFallback={focusToolbox}
                className="pp-legend-top"
            />

            {pairKey && (
                <div className="pair-regl-key" aria-label="Pair plot sensor key" data-testid="pair-key">
                    {pairKey.prefix ? (
                        <span className="pair-regl-key-prefix" title={`Every sensor below starts with: ${pairKey.prefix}`}>{pairKey.prefix} …</span>
                    ) : sensors.map((t, i) => (
                        <span key={t} className="pair-regl-key-item" title={pairKey.names[i]}><b>S{i + 1}</b><span>{pairKey.names[i]}</span></span>
                    ))}
                </div>
            )}
            <div ref={gridRef} className={`pair-regl-grid${pairKey ? ' pair-regl-grid--key' : ''}`} style={gridTemplate}>
                {Array.from({ length: n }, (_, i) => {
                    const sensorY = sensors[i];
                    const rowCells: React.ReactNode[] = [];

                    for (let k = 0; k < n; k++) {
                        const gridStyle = { gridRow: i + 1, gridColumn: k + 1 };
                        if (k === i) {
                            rowCells.push(
                                <div key={`d-${i}`} className="pair-regl-cell-slot" style={gridStyle}>
                                    <DiagonalHistogram
                                        values={sensorVals[i]}
                                        sensor={sensorY}
                                        isTopRow={false}
                                    />
                                    {i === 0 && (
                                        <AxisLabel tag={sensorY} style={AXIS_LABEL_STYLE.top} keyNo={keyOf(sensorY)} keyTail={tailOf(sensorY)} />
                                    )}
                                    {inspectMode && (
                                        <div
                                            className="pair-regl-inspect-overlay"
                                            onClick={() => {
                                                setExpanded({ kind: 'diagonal', sensorY });
                                                setInspectMode(false);
                                            }}
                                        />
                                    )}
                                </div>
                            );
                        } else if (k > i) {
                            const sensorX = sensors[k];
                            rowCells.push(
                                <div key={`s-${i}-${k}`} className="pair-regl-cell-slot" style={gridStyle}>
                                    <PairPlotCell
                                        data={data}
                                        headers={headers}
                                        sensorX={sensorX}
                                        onZoomChange={handleZoomChange}
                                        sensorY={sensorY}
                                        showXAxis={i === n - 1}
                                        showYAxis={false}
                                        showXLabel={false}
                                        showYLabel={false}
                                        tool={tool}
                                        clusters={cellClusters}
                                        onLasso={handleLasso}
                                        onHover={setHover}
                                        pointColor={POINT_COLOR}
                                        resetTick={resetTick}
                                    />
                                    {i === 0 && (
                                        <AxisLabel tag={sensorX} style={AXIS_LABEL_STYLE.top} keyNo={keyOf(sensorX)} keyTail={tailOf(sensorX)} />
                                    )}
                                    {inspectMode && (
                                        <div
                                            className="pair-regl-inspect-overlay"
                                            onClick={() => {
                                                setExpanded({ kind: 'scatter', sensorY, sensorX });
                                                setInspectMode(false);
                                            }}
                                        />
                                    )}
                                </div>
                            );
                        } else {
                            // Lower triangle: correlation for the pair mirrored above.
                            rowCells.push(
                                <div key={`c-${i}-${k}`} className="pair-regl-cell-slot" style={gridStyle}>
                                    <CorrelationCell
                                        r={correlations.get(`${i}-${k}`) ?? null}
                                        sensorY={sensorY}
                                        keyNo={keyOf(sensorY)}
                                        showYLabel={k === 0}
                                    />
                                </div>
                            );
                        }
                    }

                    // Right-most timeseries cell for this row
                    rowCells.push(
                        <div
                            key={`t-${i}`}
                            className="pair-regl-cell-slot"
                            style={{ gridRow: i + 1, gridColumn: n + 1 }}
                        >
                            <PairPlotCell
                                data={data}
                                headers={headers}
                                sensorY={sensorY}
                                isTimeAxis
                                onZoomChange={handleZoomChange}
                                showXAxis={i === n - 1}
                                showYAxis={false}
                                showXLabel={false}
                                showYLabel={false}
                                tool={tool}
                                clusters={cellClusters}
                                onLasso={handleLasso}
                                onHover={setHover}
                                pointColor={POINT_COLOR}
                                resetTick={resetTick}
                            />
                            {i === 0 && (
                                <AxisLabel tag="Time" style={AXIS_LABEL_STYLE.top} />
                            )}
                            {inspectMode && (
                                <div
                                    className="pair-regl-inspect-overlay"
                                    onClick={() => {
                                        setExpanded({ kind: 'time', sensorY });
                                        setInspectMode(false);
                                    }}
                                />
                            )}
                        </div>
                    );

                    return rowCells;
                })}
            </div>

            {/* Also serves the enlarged dialog, so its z-index (200) must clear .pair-regl-expand-backdrop's 150. */}
            {hover && (
                <div
                    className="scatter-regl-tooltip"
                    style={{
                        position: 'fixed',
                        left: hover.pageX + 14,
                        top: hover.pageY + 14,
                        zIndex: 200,
                    }}
                >
                    {/* Inline label + value + unit. */}
                    {(() => {
                        const xInfo = sensorLookup(hover.sensorX);
                        const yInfo = sensorLookup(hover.sensorY);
                        const xText = hover.isTimeAxis ? formatDateTime(new Date(hover.xVal)) : `${fmtNum(hover.xVal)}${xInfo.unit ? ` ${xInfo.unit}` : ''}`;
                        const yText = `${fmtNum(hover.yVal)}${yInfo.unit ? ` ${yInfo.unit}` : ''}`;
                        return (
                            <>
                                <div className={hover.isTimeAxis ? 'tt-row' : ttRowClass(xInfo, xText, hoverEnds.get(hover.sensorX))}>
                                    <span className="tt-label">
                                        {hover.isTimeAxis ? <span className="tt-desc">Time</span> : <TooltipRowName info={xInfo} valueText={xText} distinct={hoverEnds.get(hover.sensorX)} />}
                                    </span>
                                    <span className="tt-val">{xText}</span>
                                </div>
                                <div className={ttRowClass(yInfo, yText, hoverEnds.get(hover.sensorY))}>
                                    <span className="tt-label"><TooltipRowName info={yInfo} valueText={yText} distinct={hoverEnds.get(hover.sensorY)} /></span>
                                    <span className="tt-val">{yText}</span>
                                </div>
                            </>
                        );
                    })()}
                    {hover.timestamp && !hover.isTimeAxis && (
                        <div className="scatter-regl-tooltip-ts">{formatDataStamp(hover.timestamp)}</div>
                    )}
                </div>
            )}

            {/* Enlarged view: same components at full size, mini toolbox without the magnifier; lasso flows back to the matrix. */}
            {expanded && (
                <div className="pair-regl-expand-backdrop" onClick={() => setExpanded(null)}>
                    <div className="pair-regl-expand-modal" onClick={e => e.stopPropagation()}>
                        <div className="pair-regl-expand-header">
                            <div className="pair-regl-expand-title">
                                {expanded.kind === 'diagonal' && `${sensorPlainLabel(sensorLookup(expanded.sensorY))} — distribution`}
                                {expanded.kind === 'scatter' && `${sensorPlainLabel(sensorLookup(expanded.sensorX))} × ${sensorPlainLabel(sensorLookup(expanded.sensorY))}`}
                                {expanded.kind === 'time' && `${sensorPlainLabel(sensorLookup(expanded.sensorY))} × Time`}
                            </div>
                            <div className="pair-regl-expand-toolbox" ref={expandToolboxRef}>
                                {expanded.kind !== 'diagonal' && (
                                    <>
                                        <button
                                            onClick={() => setTool('lasso')}
                                            className={`scatter-regl-tool${tool === 'lasso' ? ' active' : ''}`}
                                            title="Lasso select"
                                            aria-pressed={tool === 'lasso'}
                                        >
                                            <Lasso size={13} />
                                        </button>
                                        <button
                                            onClick={() => setTool('pan')}
                                            className={`scatter-regl-tool${tool === 'pan' ? ' active' : ''}`}
                                            title="Pan / zoom"
                                            aria-pressed={tool === 'pan'}
                                        >
                                            <Move size={13} />
                                        </button>
                                    </>
                                )}
                                <ResetViewButton canReset={canResetView} onReset={handleResetView} />
                                <button
                                    onClick={() => setExpanded(null)}
                                    className="scatter-regl-tool"
                                    title="Close"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        </div>
                        <div className="pair-regl-expand-body">
                            {expanded.kind === 'diagonal' ? (
                                <DiagonalHistogram
                                    values={sensorVals[sensors.indexOf(expanded.sensorY)] ?? []}
                                    sensor={expanded.sensorY}
                                    isTopRow={true}
                                />
                            ) : (
                                <PairPlotCell
                                    data={data}
                                    headers={headers}
                                    sensorY={expanded.sensorY}
                                    sensorX={expanded.kind === 'scatter' ? expanded.sensorX : undefined}
                                    isTimeAxis={expanded.kind === 'time'}
                                    onZoomChange={handleZoomChange}
                                    showXAxis
                                    showYAxis
                                    showXLabel
                                    showYLabel
                                    tool={tool}
                                    clusters={cellClusters}
                                    onLasso={handleLasso}
                                    onHover={setHover}
                                    pointColor={POINT_COLOR}
                                    resetTick={resetTick}
                                />
                            )}
                        </div>
                        <div className="pair-regl-expand-footer">
                            {clusters.length > 0
                                ? (
                                    <ClusterLegend
                                        clusters={clusters}
                                        onRecolour={handleRecolour}
                                        onRename={handleRename}
                                        onRemove={handleDeleteCluster}
                                        onClear={handleClearClusters}
                                        focusFallback={focusExpandToolbox}
                                    />
                                )
                                : <span>Drag to lasso · scroll to zoom · each lasso creates a new cluster</span>}
                        </div>
                    </div>
                </div>
            )}

        </div>
        </SensorMetaContext.Provider>
    );
}

export default memo(PairPlotChart);
