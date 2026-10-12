import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { Lasso, Move, RotateCcw, X, Search } from 'lucide-react';
import PairPlotCell, { HoverInfo, Cluster } from './PairPlotCell';
import AxisLabel from './AxisLabel';
import ClusterLegend from './ClusterLegend';
import { nextClusterColour, nextClusterName } from './pairPlotClusters';
import { SensorInline } from '../sensor/SensorLabel';
import { SensorMetaContext, fmtNum, useLayeredSensorLookup } from '../sensor/sensorInfo';
import { ChartProps, MAX_PAIR_PLOT_SENSORS } from './ChartTypes';
import { formatDateTime } from '../../utils/dateFormat';
import { formatDataStamp } from '../../utils/workbenchDate';
import { ACCENT_HEX, CANVAS_BG_HEX, correlationGradientHex, hexToRgba, hexToRgbaCss, rgbaToHex } from './pairPlotColors';
import { pearsonCorrelation } from './pairPlotStats';

type Tool = 'lasso' | 'pan';

/** Colour used by every scatter cell — keeps the matrix visually cohesive so
 *  the user reads density / shape rather than chasing per-cell hue. Derived
 *  from the shared ACCENT_HEX (pairPlotColors.ts) so it never drifts from
 *  the diagonal histogram's bar colour again. */
const POINT_COLOR: [number, number, number, number] = hexToRgba(ACCENT_HEX, 0.55);

/** Must match PairPlotCell's AXIS_PAD so the diagonal histogram's frame
 *  has the exact same inset as every scatter cell. */
const CELL_PAD = { left: 36, right: 4, top: 14, bottom: 18 };

/** Compact diagonal histogram — pure SVG so the cell doesn't burn a WebGL
 *  context just to draw 20 bars. Uses the same pixel padding as PairPlotCell
 *  (CELL_PAD) so the bordered frame matches scatter cells exactly. */
function DiagonalHistogram({
    values, sensor, isTopRow,
}: {
    values: number[];
    sensor: string;
    /** Only row 0's diagonal prints its name — it doubles as that column's
     *  header. Every other row's diagonal sits at column i (i > 0), which
     *  row 0 already labeled at the top; repeating it there would be noise
     *  the "outer frame only" label scheme deliberately avoids. */
    isTopRow: boolean;
}) {
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
                        {sensor}
                    </text>
                )}
                {/* Horizontal bars: low value at bottom, high at top. Bar
                    length = count / maxCount across the inner plot width. */}
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

/** Lower-triangle correlation heatmap cell — mirrors the upper-triangle
 *  scatter cell for the same sensor pair. Computes nothing new: `r` is
 *  derived once for the whole matrix from the same `sensorVals` sample the
 *  diagonal histograms already use. Tinted by sign (indigo accent = positive,
 *  rose = negative) and magnitude (stronger |r| = more saturated fill), so
 *  the strongest relationships in the matrix are visible at a glance before
 *  drilling into any one scatter cell. */
/** Positioning for the two AxisLabel orientations used across this matrix —
 *  `top` labels span the cell's top padding strip (column headers), `left`
 *  labels span the left padding strip, rotated (row headers). Shared here
 *  so every call site stays consistent with CELL_PAD. */
const AXIS_LABEL_STYLE = {
    top: { top: 0, left: CELL_PAD.left, right: CELL_PAD.right, height: CELL_PAD.top },
    left: { top: CELL_PAD.top, bottom: CELL_PAD.bottom, left: 0, width: CELL_PAD.left },
} as const;

function CorrelationCell({
    r, sensorY, showYLabel,
}: {
    r: number | null;
    sensorY: string;
    /** True only for the left-most correlation cell in its row (column 0) —
     *  that's the row's shared header, "outer frame only" like every other
     *  cell type. Correlation cells never sit in row 0, so they never carry
     *  a top/column label — row 0 already labeled that column. */
    showYLabel: boolean;
}) {
    // Diverging-by-magnitude, not by sign: weak (|r| near 0) reads red,
    // strong (|r| near 1) reads green regardless of direction — a strong
    // negative relationship is exactly as noteworthy as a strong positive
    // one for this app's use case (spotting *any* tight sensor relationship).
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
            {/* Sibling of .pair-regl-cell, not nested inside it — .pair-regl-cell
                clips to the tinted square (see App.css), and the hover
                tooltip needs to escape that boundary to show a full
                description without being cut off. */}
            {showYLabel && (
                <AxisLabel tag={sensorY} rotate style={AXIS_LABEL_STYLE.left} />
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

/** Focus the first control of a toolbox (the legend's focus fallback). */
function focusFirstTool(el: HTMLElement | null) {
    el?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
}

const RESET_VIEW_TITLE = 'Reset zoom and pan — every cell back to its full data range (clusters stay)';
const RESET_VIEW_IDLE_TITLE = 'Nothing to reset — zoom (scroll) or pan a cell first';

/** The toolbox ↺: resets the zoom/pan of every cell (matrix and enlarged
 *  view) — nothing else; clusters stay (the legend's own × / Clear removes
 *  them). While no cell is zoomed or panned it stays visible but inert and
 *  its tooltip says so (`aria-disabled`, not `disabled`, so the tooltip
 *  still shows). */
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
    /** Ordered list of brushed clusters. Each lasso pushes a new entry; the
     *  user can recolour, rename or remove any cluster from the legend chips
     *  above the matrix. Session-only — clusters are never persisted. */
    const [clusters, setClusters] = useState<Cluster[]>([]);
    /** Counter for unique cluster IDs (Date.now would collide if two lassos
     *  fire in the same ms while React batches state updates). */
    const clusterSeqRef = useRef(0);
    const [hover, setHover] = useState<HoverInfo | null>(null);
    /** Active interaction mode, shared by every cell in the matrix (and the
     *  enlarged-view dialog). Lasso still creates clusters; Pan/zoom lets the
     *  user look closer at a dense cloud without accidentally brushing one. */
    const [tool, setTool] = useState<Tool>('lasso');
    /** Increments on every Reset click; each cell watches it and calls
     *  `sc.reset()` once when it changes. Lets the toolbox broadcast a
     *  reset action to every WebGL canvas without holding refs to them all. */
    const [resetTick, setResetTick] = useState(0);
    /** Ids (each cell instance's own `useId`) of the cells — matrix and
     *  enlarged view — currently zoomed or panned away from their full
     *  extent. Empty = the ↺ button has nothing to undo and says so instead
     *  of silently doing nothing (↺ restores zoom / pan only; it does not
     *  clear clusters). */
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
    /** Inspect-mode toggle. When true every cell shows an overlay that
     *  intercepts clicks → opens the enlarged view dialog. Auto-disabled
     *  after one click so the cursor returns to normal interactions. */
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

    /** Rename / recolour return the SAME array when nothing changes (e.g.
     *  picking the colour a cluster already has), so nothing re-renders. */
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

    /** What the WebGL cells draw from. A rename only changes a label, which
     *  the cells never read, so this keeps the previous array (same
     *  reference) unless an id, colour or row set changed — PairPlotCell is
     *  memoised, so renaming re-renders the legend and nothing else. */
    const [cellClusters, setCellClusters] = useState<Cluster[]>(clusters);
    if (cellClusters !== clusters && !sameForCells(cellClusters, clusters)) {
        // "Adjust state while rendering" (React docs): re-renders this
        // component before any child, no ref read during render.
        setCellClusters(clusters);
    }

    /** Toolbox reset = every cell's camera only (bumping `resetTick`
     *  propagates it to each PairPlotCell). Clusters stay — removing them is
     *  the legend's own × / Clear: two intents, two controls. */
    const handleResetView = useCallback(() => {
        setResetTick(t => t + 1);
    }, []);

    const handleClearClusters = useCallback(() => {
        setClusters([]);
    }, []);

    const toolboxRef = useRef<HTMLDivElement>(null);
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

    /** Pearson r for every lower-triangle pair, keyed `"i-k"` (i = row, k =
     *  column, k < i). Computed once per matrix from the same sensorVals
     *  sample — no extra data fetch, just a stat over what's already loaded. */
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
    // Defense-in-depth: Dashboard's tab-enabling logic already keeps the
    // selection at MAX_PAIR_PLOT_SENSORS while in Pair Plot mode, but its
    // bounce-back effect runs AFTER render — this guard covers the one frame
    // where a selection could still exceed the cap (e.g. a workspace restore
    // that persisted a larger selection alongside chartType: 'pair').
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
            {/* Global toolbox — Lasso / Pan-zoom are mutually exclusive, shared
                by every cell in the matrix (and the enlarged-view dialog). */}
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

            <div className="pair-regl-grid" style={gridTemplate}>
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
                                        <AxisLabel tag={sensorY} style={AXIS_LABEL_STYLE.top} />
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
                                        <AxisLabel tag={sensorX} style={AXIS_LABEL_STYLE.top} />
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
                            // Lower triangle (k < i): correlation heatmap for the
                            // same sensor pair as the scatter cell mirrored above
                            // it — no new data fetch, just a stat over sensorVals.
                            rowCells.push(
                                <div key={`c-${i}-${k}`} className="pair-regl-cell-slot" style={gridStyle}>
                                    <CorrelationCell
                                        r={correlations.get(`${i}-${k}`) ?? null}
                                        sensorY={sensorY}
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

            {/* Global hover tooltip — child cells report page-anchored coords
                via `onHover`, so we can position it without re-computing
                offsets inside each cell on every camera move. This same
                tooltip also serves the enlarged-view dialog's PairPlotCell
                (shared `onHover={setHover}`), so its z-index must clear
                .pair-regl-expand-backdrop's 150 or it renders correctly but
                paints behind the modal. */}
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
                    <div className="tt-row">
                        <span className="tt-label">
                            {hover.isTimeAxis ? <span className="tt-desc">Time</span> : <SensorInline tag={hover.sensorX} size="sm" />}
                        </span>
                        <span className="tt-val">
                            {hover.isTimeAxis
                                ? formatDateTime(new Date(hover.xVal))
                                : `${fmtNum(hover.xVal)}${sensorLookup(hover.sensorX).unit ? ` ${sensorLookup(hover.sensorX).unit}` : ''}`}
                        </span>
                    </div>
                    <div className="tt-row">
                        <span className="tt-label"><SensorInline tag={hover.sensorY} size="sm" /></span>
                        <span className="tt-val">{fmtNum(hover.yVal)}{sensorLookup(hover.sensorY).unit ? ` ${sensorLookup(hover.sensorY).unit}` : ''}</span>
                    </div>
                    {hover.timestamp && !hover.isTimeAxis && (
                        <div className="scatter-regl-tooltip-ts">{formatDataStamp(hover.timestamp)}</div>
                    )}
                </div>
            )}

            {/* Enlarged view dialog — opens when the magnifier picks a cell.
                Reuses the same components (PairPlotCell / DiagonalHistogram)
                at full dialog size + a mini toolbox (no magnifier here so
                we don't nest inspections). Selection state flows back to
                the parent so any lasso in here also lights up the matrix
                behind the modal. */}
            {expanded && (
                <div className="pair-regl-expand-backdrop" onClick={() => setExpanded(null)}>
                    <div className="pair-regl-expand-modal" onClick={e => e.stopPropagation()}>
                        <div className="pair-regl-expand-header">
                            <div className="pair-regl-expand-title">
                                {expanded.kind === 'diagonal' && `${expanded.sensorY} — distribution`}
                                {expanded.kind === 'scatter' && `${expanded.sensorX} × ${expanded.sensorY}`}
                                {expanded.kind === 'time' && `${expanded.sensorY} × Time`}
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
