import { useState, useEffect, useRef, useMemo, memo } from 'react';
import createScatterplot from 'regl-scatterplot';
import { scaleLinear } from 'd3-scale';
import type { CsvRecord } from '../../types';
import { reportError } from '../../errorReporter';
import { useCoalescedDraw } from '../../hooks/useCoalescedDraw';
import type { ThemeMode } from '../../hooks/useThemeMode';
import { formatYearMonth } from '../../utils/dateFormat';
import { CANVAS_BG, CANVAS_BG_HEX } from './pairPlotColors';

/** WebGL can't read CSS custom properties, so the canvas clear colour is a
 *  plain RGBA constant — shared with PairPlotChart's diagonal histograms via
 *  pairPlotColors.ts so both always render the exact same background (not
 *  ScatterChart.tsx's own separate CANVAS_BG, which is a single-canvas
 *  component with no sibling background to stay in sync with). */
const POINT_COLOR_HOVER: [number, number, number, number] = [0.925, 0.282, 0.6, 1.0];

/**
 * One scatter / time × value cell of the pair plot. Wraps a single
 * regl-scatterplot instance, exposes axis labels on the outer-edge cells,
 * subscribes to lasso & hover events, and accepts a parent-owned list of
 * brushed clusters so the multi-coloured highlight stays in sync across
 * every cell.
 *
 * Deliberately does NOT read the Highlights tab's time-window list (unlike
 * ScatterChart/LineChart) — Pair Plot's lasso-cluster already covers "mark a
 * group of points I care about", and layering a second, differently-scoped
 * highlighting mechanism on top of it was judged more confusing than useful
 * (an earlier revision added a `sizeBy`-driven emphasis for this; removed
 * per the same call).
 */

type ToolMode = 'pan' | 'lasso';

/**
 * One brushed group of rows. Multiple clusters can coexist — each gets its
 * own colour, count, and is rendered as a separate visual group in every
 * cell via regl-scatterplot's `colorBy: 'valueA'` + `pointColor` palette.
 */
export type Cluster = {
    id: string;
    label: string;
    /** RGBA in 0..1 space, ready to push straight into regl uniforms. */
    color: [number, number, number, number];
    rowIndices: Set<number>;
};

export type HoverInfo = {
    rowIdx: number;
    xVal: number;
    yVal: number;
    sensorX: string;
    sensorY: string;
    isTimeAxis: boolean;
    timestamp: string | null;
    /** Screen coordinates of the canvas wrapper (page-level), used to position
     *  the parent tooltip without per-cell relative math. */
    pageX: number;
    pageY: number;
};

interface PairPlotCellProps {
    data: CsvRecord[];
    headers: string[];
    sensorY: string;
    /** Omitted on time-axis cells (X is the row's timestamp instead). */
    sensorX?: string;
    isTimeAxis?: boolean;
    /** Render an X-axis tick row (only outermost — top or bottom — cells). */
    showXAxis: boolean;
    /** Render a Y-axis tick column (only left-most cell of each row). */
    showYAxis: boolean;
    /** Show this cell's X-sensor name as a label on the top edge. */
    showXLabel: boolean;
    /** Show this cell's Y-sensor name as a label on the left edge. */
    showYLabel: boolean;
    /** Active tool — propagated to sc via `mouseMode`. */
    tool: ToolMode;
    /** Parent-owned list of brushed clusters. Each row may belong to at
     *  most one cluster. Drives the multi-coloured highlight via the
     *  regl-scatterplot category-colour pipeline. */
    clusters: Cluster[];
    /** Lasso completed in this cell → bubble the picked row indices up so
     *  the parent can decide whether to spawn a new cluster (or append). */
    onLasso: (rows: number[]) => void;
    onHover: (info: HoverInfo | null) => void;
    /** Default colour for points that DON'T belong to any cluster. */
    pointColor: [number, number, number, number];
    /** Monotonically-increasing counter. When it bumps higher than the
     *  last value we acted on, the cell calls `sc.reset()` to snap its
     *  camera back to the full data extent. Allows a single toolbox
     *  button to broadcast a reset to every cell at once. */
    resetTick: number;
    /** Read once from the parent (PairPlotChart) instead of each cell
     *  running its own MutationObserver — a matrix can have dozens of
     *  cells mounted at once. */
    themeMode: ThemeMode;
}

/**
 * Padding applied to EVERY cell — even when it doesn't actually render
 * an axis on that side. Uniform reserved space keeps every cell's plot
 * rect the same dimensions across the whole matrix, so the borders line
 * up like graph paper instead of zig-zagging in/out.
 *
 * `top: 14`     leaves room for the column sensor name on the top row.
 * `bottom: 18`  leaves room for the X-axis tick row on the bottom row.
 * `left: 36`    leaves room for Y-axis tick labels when a cell shows them.
 * `right: 4`    minimal breathing room on the right edge.
 */
const AXIS_PAD = { left: 36, right: 4, top: 14, bottom: 18 };

function fmt(n: number): string {
    if (!isFinite(n)) return '—';
    if (Math.abs(n) >= 10000 || (Math.abs(n) > 0 && Math.abs(n) < 0.01)) return n.toExponential(1);
    return n.toFixed(1);
}

function makeTicks(min: number, max: number, count: number): number[] {
    if (max === min) return [min];
    return Array.from({ length: count }, (_, i) => min + (max - min) * i / (count - 1));
}

function PairPlotCell({
    data, headers, sensorY, sensorX, isTimeAxis,
    showXAxis, showYAxis, showXLabel, showYLabel,
    tool, clusters, onLasso, onHover, pointColor, resetTick, themeMode,
}: PairPlotCellProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    /** scatter-point index → original CSV row index (skips rows with null values). */
    const pointToRowRef = useRef<number[]>([]);
    /** row index → scatter-point index. Inverse of pointToRow; used to map
     *  parent-owned cluster row indices back into local valueA categories. */
    const rowToPointRef = useRef<Map<number, number>>(new Map());
    /** Float32Array of per-point cluster categories (0 = none, 1..N = clusters).
     *  Kept in a ref so we can rewrite it cheaply on every cluster change
     *  without going through React's render cycle. */
    const valueARef = useRef<Float32Array>(new Float32Array(0));
    /** Last x/y arrays sent to draw(). We need to re-call draw() with the
     *  same x/y + a fresh `valueA` when clusters change, since regl needs
     *  the category dim re-uploaded alongside the position buffers. */
    const drawDataRef = useRef<{ x: Float32Array; y: Float32Array } | null>(null);
    const dataBoundsRef = useRef<{ xLo: number; xHi: number; yLo: number; yHi: number }>({
        xLo: 0, xHi: 1, yLo: 0, yHi: 1,
    });
    /** Last resetTick value we've already applied to this cell. Stops the
     *  reset effect from firing on initial mount (when tick=0) and from
     *  re-firing if React re-runs the effect for unrelated reasons. */
    const lastResetTickRef = useRef(0);

    const [innerDims, setInnerDims] = useState({ width: 0, height: 0 });
    const [wrapperDims, setWrapperDims] = useState({ width: 0, height: 0 });
    const [visibleBounds, setVisibleBounds] = useState({
        xMin: 0, xMax: 1, yMin: 0, yMax: 1,
    });
    const [sc, setSc] = useState<any>(null);
    /** WebGL init failure — same guard as ScatterChart: createScatterplot()
     *  throws synchronously when a context can't be created, and an escaped
     *  throw here would unmount the entire app (production black-screen).
     *  The reporter dedupes, so a whole matrix of failing cells surfaces as
     *  ONE toast instead of N. */
    const [initError, setInitError] = useState<string | null>(null);
    /** The data effect and the clusters effect both draw in the same commit
     *  (every mount!), and regl-scatterplot DROPS a draw issued while one is
     *  in flight ("Ignoring draw call…"). Coalescing keeps only the latest
     *  requested state and flushes it once the current draw settles. */
    const { requestDraw, resetDraw } = useCoalescedDraw();

    // Track wrapper size + carve out an inner plot area for the canvas.
    // Padding is CONSTANT — see AXIS_PAD docstring. Conditional rendering
    // below decides whether the reserved space actually shows ticks/labels,
    // but the inner rect stays the same size no matter what so every cell's
    // frame is identical across the matrix.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            setWrapperDims({ width: w, height: h });
            setInnerDims({
                width: Math.max(0, w - AXIS_PAD.left - AXIS_PAD.right),
                height: Math.max(0, h - AXIS_PAD.top - AXIS_PAD.bottom),
            });
        };
        update(); // immediate on mount — no debounce delay for the initial layout
        // Debounced for every resize AFTER that: a split-pane drag fires many
        // rapid ResizeObserver callbacks, and each one drives a full WebGL
        // context destroy+recreate below — multiplied by up to MAX_PAIR_PLOT_SENSORS
        // matrix cells all resizing at once, since every cell owns its own
        // instance. Waiting for the resize to pause briefly means that cost
        // is paid once at the end of a drag, not on every intermediate tick.
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const ro = new ResizeObserver(() => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(update, 150);
        });
        ro.observe(el);
        return () => {
            ro.disconnect();
            if (debounceTimer) clearTimeout(debounceTimer);
        };
    }, []);

    // Build / tear down the regl-scatterplot instance whenever the inner
    // canvas size changes.
    useEffect(() => {
        if (!canvasRef.current || innerDims.width === 0 || innerDims.height === 0) return;

        let inst: ReturnType<typeof createScatterplot>;
        try {
            inst = createScatterplot({
                canvas: canvasRef.current,
                width: innerDims.width,
                height: innerDims.height,
                // regl-scatterplot defaults aspectRatio to 1 (assumes a
                // square DATA domain) and letterboxes to preserve it when the
                // canvas itself isn't square — exactly what a pairplot cell
                // usually is (wider than tall). Our x/y domains are already
                // both normalized to [-1, 1] (equal ranges, genuinely square
                // data), so there's no meaningful shape to preserve; setting
                // this to the canvas's own ratio makes the plot fill the
                // whole cell instead of leaving black bars on the sides.
                aspectRatio: innerDims.width / innerDims.height,
                pointSize: 2,
                pointColor,
                pointColorActive: [0.99, 0.75, 0.18, 1.0],
                pointColorHover: POINT_COLOR_HOVER,
                opacity: 0.55,
                backgroundColor: CANVAS_BG[themeMode],
                lassoColor: [0.65, 0.73, 0.97, 0.8],
            });
        } catch (err) {
            reportError('pairplot-init', err);
            setInitError(err instanceof Error ? err.message : String(err));
            return;
        }
        setInitError(null);

        inst.subscribe('select', ({ points }: { points: number[] }) => {
            if (points.length === 0) return;
            const map = pointToRowRef.current;
            const rows: number[] = [];
            for (const p of points) {
                const r = map[p];
                if (r != null) rows.push(r);
            }
            onLasso(rows);
            // Drop the lib's transient `select` state immediately — we
            // visualise clusters via our own category-colour pipeline, so
            // letting regl hold onto its own highlighted set would just
            // double-render the most recent cluster.
            inst.deselect({ preventEvent: true });
        });
        // No 'deselect' subscription — clearing happens via parent state.
        inst.subscribe('view', ({ xScale, yScale }: any) => {
            if (!xScale || !yScale) return;
            const [vxMin, vxMax] = xScale.domain();
            const [vyMin, vyMax] = yScale.domain();
            setVisibleBounds({ xMin: vxMin, xMax: vxMax, yMin: vyMin, yMax: vyMax });
        });

        // @ts-expect-error – lib type/runtime mismatch on event name
        inst.subscribe('pointover', (pointIdx: number) => {
            const rowIdx = pointToRowRef.current[pointIdx];
            if (rowIdx == null) return;
            const row = data[rowIdx];
            if (!row) return;
            // Position the parent tooltip relative to the page — easier
            // than computing per-cell pixel offsets in the parent.
            const rect = containerRef.current?.getBoundingClientRect();
            let pos: [number, number] | undefined;
            try { pos = inst.getScreenPosition(pointIdx); } catch { pos = undefined; }
            const pageX = (rect?.left ?? 0) + AXIS_PAD.left + (pos?.[0] ?? 0);
            const pageY = (rect?.top ?? 0) + AXIS_PAD.top + (pos?.[1] ?? 0);
            const xIdx = sensorX != null ? headers.indexOf(sensorX) : -1;
            const yIdx = headers.indexOf(sensorY);
            const xVal = isTimeAxis
                ? (row.timestamp ? new Date(row.timestamp).getTime() : NaN)
                : (xIdx >= 0 ? (row.values[xIdx] ?? NaN) : NaN);
            const yVal = yIdx >= 0 ? (row.values[yIdx] ?? NaN) : NaN;
            onHover({
                rowIdx,
                xVal,
                yVal,
                sensorX: isTimeAxis ? 'Time' : (sensorX ?? ''),
                sensorY,
                isTimeAxis: !!isTimeAxis,
                timestamp: row.timestamp,
                pageX, pageY,
            });
        });
        // @ts-expect-error – lib type/runtime mismatch on event name
        inst.subscribe('pointout', () => {
            onHover(null);
        });

        setSc(inst);

        return () => {
            // Clear the draw queue FIRST: a draw interrupted by destroy() may
            // never settle, which would leave the queue stuck busy.
            resetDraw();
            inst.destroy();
            setSc(null);
        };
        // We deliberately don't depend on the callback props — they may
        // change identity every render and would force a costly recreate.
        // The latest props are captured via the closures below in newer
        // effects (selectedRows / tool sync).
        // `themeMode` IS included below (unlike the callback props) — a theme
        // toggle must recreate the instance, since `backgroundColor` is baked
        // into a WebGL color texture at construction time and `.set()` never
        // rebuilds it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [innerDims.width, innerDims.height, themeMode]);

    // Push fresh data whenever the source rows / chosen sensors / instance
    // changes. Also (re)builds the row↔point lookups used by the linked
    // highlight + hover handlers.
    useEffect(() => {
        if (!sc) return;
        const xIdxRaw = sensorX != null ? headers.indexOf(sensorX) : -1;
        const yIdx = headers.indexOf(sensorY);
        if (yIdx < 0) return;
        if (!isTimeAxis && xIdxRaw < 0) return;

        const xs: number[] = [];
        const ys: number[] = [];
        const orig: number[] = [];
        // Defensive cap: the Dashboard already feeds each cell a bounded sample,
        // but if raw data ever reaches here, stride it down so no single cell
        // pushes a GPU-unsafe point count (would lose the WebGL context →
        // black cell). `orig` keeps the TRUE row index, so cluster colouring
        // (valueA) + hover still map back correctly.
        const RENDER_CAP = 100_000;
        const step = data.length > RENDER_CAP ? Math.ceil(data.length / RENDER_CAP) : 1;
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;

        for (let i = 0; i < data.length; i += step) {
            const row = data[i];
            const yVal = row.values[yIdx];
            if (yVal == null || isNaN(yVal)) continue;
            let xVal: number;
            if (isTimeAxis) {
                if (!row.timestamp) continue;
                const t = new Date(row.timestamp).getTime();
                if (isNaN(t)) continue;
                xVal = t;
            } else {
                const xRaw = row.values[xIdxRaw];
                if (xRaw == null || isNaN(xRaw)) continue;
                xVal = xRaw;
            }
            xs.push(xVal);
            ys.push(yVal);
            orig.push(i);
            if (xVal < xMin) xMin = xVal;
            if (xVal > xMax) xMax = xVal;
            if (yVal < yMin) yMin = yVal;
            if (yVal > yMax) yMax = yVal;
        }

        const xLo = isFinite(xMin) ? xMin : 0;
        const xHi = isFinite(xMax) ? xMax : 1;
        const yLo = isFinite(yMin) ? yMin : 0;
        const yHi = isFinite(yMax) ? yMax : 1;
        const xRange = (xHi - xLo) || 1;
        const yRange = (yHi - yLo) || 1;
        const len = xs.length;
        const xArr = new Float32Array(len);
        const yArr = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            xArr[i] = ((xs[i] - xLo) / xRange) * 2 - 1;
            yArr[i] = ((ys[i] - yLo) / yRange) * 2 - 1;
        }

        // Build row→point inverse map for selection sync.
        const rowToPoint = new Map<number, number>();
        for (let i = 0; i < orig.length; i++) rowToPoint.set(orig[i], i);

        pointToRowRef.current = orig;
        rowToPointRef.current = rowToPoint;
        dataBoundsRef.current = { xLo, xHi, yLo, yHi };
        drawDataRef.current = { x: xArr, y: yArr };
        // Build category dim aligned to the rendered points using the
        // CURRENT cluster list. 0 = no cluster (default colour); 1..N =
        // index into the colour palette built below.
        const valueA = new Float32Array(orig.length);
        for (let ci = 0; ci < clusters.length; ci++) {
            const cluster = clusters[ci];
            for (const r of cluster.rowIndices) {
                const p = rowToPoint.get(r);
                if (p != null) valueA[p] = ci + 1;
            }
        }
        valueARef.current = valueA;
        setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });

        // set() before draw: it's synchronous instance config, so the queued
        // draw (which may run a tick later) picks it up either way.
        sc.set({
            pointColor: [pointColor, ...clusters.map(c => c.color)],
            colorBy: 'valueA',
            xScale: scaleLinear().domain([xLo, xHi]).range([-1, 1]),
            yScale: scaleLinear().domain([yLo, yHi]).range([-1, 1]),
        });
        requestDraw(sc, { x: xArr, y: yArr, valueA });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sc, data, sensorX, sensorY, isTimeAxis, headers]);

    // Cluster changes → rebuild valueA in-place + re-upload + bump palette.
    // No need to recompute x/y arrays since the data didn't change.
    useEffect(() => {
        if (!sc) return;
        const draw = drawDataRef.current;
        if (!draw) return;
        const rowToPoint = rowToPointRef.current;
        const len = draw.x.length;
        const valueA = new Float32Array(len);
        for (let ci = 0; ci < clusters.length; ci++) {
            const cluster = clusters[ci];
            for (const r of cluster.rowIndices) {
                const p = rowToPoint.get(r);
                if (p != null) valueA[p] = ci + 1;
            }
        }
        valueARef.current = valueA;
        sc.set({
            pointColor: [pointColor, ...clusters.map(c => c.color)],
            colorBy: 'valueA',
        });
        requestDraw(sc, { x: draw.x, y: draw.y, valueA });
    }, [sc, clusters, pointColor, requestDraw]);

    // Push tool changes (pan ↔ lasso) into the instance.
    useEffect(() => {
        if (!sc) return;
        sc.set({ mouseMode: tool === 'lasso' ? 'lasso' : 'panZoom' });
    }, [sc, tool]);

    // Reset broadcast — when the parent's resetTick increments, snap the
    // camera back to the full extent + clear any visible visible-bounds drift.
    useEffect(() => {
        if (!sc) return;
        if (resetTick > lastResetTickRef.current) {
            lastResetTickRef.current = resetTick;
            sc.reset();
            const { xLo, xHi, yLo, yHi } = dataBoundsRef.current;
            setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });
        }
    }, [sc, resetTick]);

    // (Selection sync used to live here. Highlight now happens via the
    // cluster-driven `valueA` re-upload + palette swap above.)

    const yTicks = useMemo(() => makeTicks(visibleBounds.yMin, visibleBounds.yMax, 3), [visibleBounds]);
    const xTicks = useMemo(() => makeTicks(visibleBounds.xMin, visibleBounds.xMax, 3), [visibleBounds]);

    const padLeft = AXIS_PAD.left;
    const padTop = AXIS_PAD.top;

    return (
        <div ref={containerRef} className="pair-regl-cell" style={{ background: CANVAS_BG_HEX[themeMode] }}>
            <div
                className="pair-regl-cell-canvas-wrap"
                style={{
                    position: 'absolute',
                    left: padLeft,
                    top: padTop,
                    width: innerDims.width,
                    height: innerDims.height,
                }}
            >
                <canvas
                    ref={canvasRef}
                    style={{ display: 'block', width: innerDims.width, height: innerDims.height }}
                />
                {initError && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                        background: 'var(--card-bg)', color: 'var(--danger)',
                        fontSize: 9, textAlign: 'center', padding: 4, zIndex: 5,
                    }}>
                        WebGL unavailable
                    </div>
                )}
            </div>

            <svg
                className="pair-regl-cell-axes"
                style={{
                    position: 'absolute',
                    top: 0, left: 0,
                    width: wrapperDims.width,
                    height: wrapperDims.height,
                    pointerEvents: 'none',
                }}
            >
                {showXLabel && (
                    <text
                        x={padLeft + innerDims.width / 2}
                        y={11}
                        textAnchor="middle"
                        fontSize="10"
                        fill="var(--text-primary)"
                        fontFamily="Inter, system-ui"
                    >
                        {isTimeAxis ? 'Time' : sensorX}
                    </text>
                )}
                {showYLabel && (
                    <text
                        x={9}
                        y={padTop + innerDims.height / 2}
                        transform={`rotate(-90, 9, ${padTop + innerDims.height / 2})`}
                        textAnchor="middle"
                        fontSize="10"
                        fill="var(--text-primary)"
                        fontFamily="Inter, system-ui"
                    >
                        {sensorY}
                    </text>
                )}
                {/* X-axis ticks (bottom edge) */}
                {showXAxis && xTicks.map((v, i, arr) => {
                    const x = padLeft + innerDims.width * (i / (arr.length - 1));
                    const y = padTop + innerDims.height;
                    const label = isTimeAxis
                        ? formatYearMonth(new Date(v))
                        : fmt(v);
                    return (
                        <g key={`x${i}`}>
                            <line x1={x} y1={y} x2={x} y2={y + 3} stroke="var(--text-secondary)" strokeWidth="0.5" />
                            <text
                                x={x}
                                y={y + 12}
                                textAnchor="middle"
                                fontSize="8"
                                fill="var(--text-secondary)"
                                fontFamily="Inter, system-ui"
                            >
                                {label}
                            </text>
                        </g>
                    );
                })}
                {/* Y-axis ticks (left edge) */}
                {showYAxis && yTicks.map((v, i, arr) => {
                    const y = padTop + innerDims.height * (1 - i / (arr.length - 1));
                    return (
                        <g key={`y${i}`}>
                            <line x1={padLeft - 3} y1={y} x2={padLeft} y2={y} stroke="var(--text-secondary)" strokeWidth="0.5" />
                            <text
                                x={padLeft - 5}
                                y={y + 3}
                                textAnchor="end"
                                fontSize="8"
                                fill="var(--text-secondary)"
                                fontFamily="Inter, system-ui"
                            >
                                {fmt(v)}
                            </text>
                        </g>
                    );
                })}
                {/* Cell border */}
                <rect
                    x={padLeft}
                    y={padTop}
                    width={innerDims.width}
                    height={innerDims.height}
                    fill="none"
                    stroke="var(--border-strong, #334155)"
                    strokeWidth="1"
                />
            </svg>
        </div>
    );
}

export default memo(PairPlotCell);
