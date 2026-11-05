import { useState, useEffect, useRef, useMemo, useId, useCallback, memo } from 'react';
import { destroyReleasingContext } from './releaseGlContext';
import createScatterplot from 'regl-scatterplot';
import { scaleLinear } from 'd3-scale';
import type { CsvRecord } from '../../types';
import { reportError } from '../../errorReporter';
import { useCoalescedDraw } from '../../hooks/useCoalescedDraw';
import { formatYearMonth } from '../../utils/dateFormat';
import { textWidth } from '../../utils/textMeasure';
import { sensorPlainLabel, useSensorLookup } from '../sensor/sensorInfo';
import { CANVAS_BG, CANVAS_BG_HEX } from './pairPlotColors';

/** Hover colour as plain RGBA: WebGL can't read CSS variables (the canvas clear colour is in pairPlotColors.ts). */
const POINT_COLOR_HOVER: [number, number, number, number] = [0.925, 0.282, 0.6, 1.0];

/** One scatter / time x value cell of the pair plot. Ignores Highlights time windows: lasso clusters already mark points. */

type ToolMode = 'pan' | 'lasso';

/** One brushed group of rows; each cluster gets its own colour via `colorBy: 'valueA'` + `pointColor`. */
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
    /** Parent-owned brushed clusters; a row belongs to at most one. */
    clusters: Cluster[];
    /** Lasso done in this cell; passes the picked row indices to the parent. */
    onLasso: (rows: number[]) => void;
    onHover: (info: HoverInfo | null) => void;
    /** Default colour for points that DON'T belong to any cluster. */
    pointColor: [number, number, number, number];
    /** Bumping this above the last applied value calls `sc.reset()`, so one button resets every cell. */
    resetTick: number;
    /** True when zoomed/panned away from the full extent; fires on change only. `cellId` is the instance's `useId()`, not a sensor id (cells are keyed by index). */
    onZoomChange?: (cellId: string, zoomed: boolean) => void;
}

/** True when the view differs from the full extent; the tolerance absorbs float noise. */
export function isViewAwayFromExtent(
    xDomain: readonly number[], yDomain: readonly number[],
    b: { xLo: number; xHi: number; yLo: number; yHi: number },
): boolean {
    const tolX = Math.abs(b.xHi - b.xLo || 1) * 1e-4;
    const tolY = Math.abs(b.yHi - b.yLo || 1) * 1e-4;
    return Math.abs(xDomain[0] - b.xLo) > tolX || Math.abs(xDomain[1] - b.xHi) > tolX
        || Math.abs(yDomain[0] - b.yLo) > tolY || Math.abs(yDomain[1] - b.yHi) > tolY;
}

/** Padding on every cell, even without an axis, keeps all plot rects the same size so borders line up. */
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

const LABEL_FONT = '10px Inter, system-ui';

/** Cuts an SVG label to its room: SVG text neither wraps nor ellipsizes. */
export function fitLabel(text: string, room: number): string {
    if (room <= 0 || textWidth(text, LABEL_FONT) <= room) return text;
    let n = text.length;
    while (n > 1 && textWidth(`${text.slice(0, n)}…`, LABEL_FONT) > room) n--;
    return `${text.slice(0, n)}…`;
}

function PairPlotCell({
    data, headers, sensorY, sensorX, isTimeAxis,
    showXAxis, showYAxis, showXLabel, showYLabel,
    tool, clusters, onLasso, onHover, pointColor, resetTick,
    onZoomChange,
}: PairPlotCellProps) {
    const cellId = useId();
    const sensorLookup = useSensorLookup();
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    /** scatter-point index → original CSV row index (skips rows with null values). */
    const pointToRowRef = useRef<number[]>([]);
    /** row index -> scatter-point index; inverse of pointToRowRef. */
    const rowToPointRef = useRef<Map<number, number>>(new Map());
    /** Per-point cluster category (0 = none, 1..N); a ref so it can be rewritten without a render. */
    const valueARef = useRef<Float32Array>(new Float32Array(0));
    /** Last x/y sent to draw(); redrawn with a fresh `valueA` on cluster change (regl needs the category dim re-uploaded). */
    const drawDataRef = useRef<{ x: Float32Array; y: Float32Array } | null>(null);
    const dataBoundsRef = useRef<{ xLo: number; xHi: number; yLo: number; yHi: number }>({
        xLo: 0, xHi: 1, yLo: 0, yHi: 1,
    });
    /** Last resetTick applied; stops a reset firing on mount or on unrelated effect re-runs. */
    const lastResetTickRef = useRef(0);
    /** Whether this cell currently reports itself as zoomed/panned. */
    const zoomedRef = useRef(false);
    const onZoomChangeRef = useRef(onZoomChange);
    onZoomChangeRef.current = onZoomChange;
    const reportZoomed = useCallback((zoomed: boolean) => {
        if (zoomedRef.current === zoomed) return;
        zoomedRef.current = zoomed;
        onZoomChangeRef.current?.(cellId, zoomed);
    }, [cellId]);

    const [innerDims, setInnerDims] = useState({ width: 0, height: 0 });
    const [wrapperDims, setWrapperDims] = useState({ width: 0, height: 0 });
    const [visibleBounds, setVisibleBounds] = useState({
        xMin: 0, xMax: 1, yMin: 0, yMax: 1,
    });
    const [sc, setSc] = useState<any>(null);
    /** The instance alive right now: a resize destroys `sc` before the other effects of that commit run. */
    const liveScRef = useRef<any>(null);
    /** What the last data effect drew, to tell new data from a re-run with the same data. */
    const drawnRef = useRef<{ sc: any; data: CsvRecord[]; x?: string; y: string; time: boolean; xLo: number; xHi: number; yLo: number; yHi: number } | null>(null);
    /** The instance's handlers outlive renders (created once per size), so they read the latest props here. */
    const latestRef = useRef({ data, headers, sensorX, sensorY, isTimeAxis, onLasso, onHover });
    latestRef.current = { data, headers, sensorX, sensorY, isTimeAxis, onLasso, onHover };
    /** The GPU dropped this cell's context: an overlay offers Retry, which rebuilds the instance. */
    const [contextLost, setContextLost] = useState(false);
    const [rebuildNonce, setRebuildNonce] = useState(0);
    /** createScatterplot() throws without a WebGL context; an escaped throw would unmount the app. */
    const [initError, setInitError] = useState<string | null>(null);
    /** Both effects draw in one commit; regl-scatterplot drops a mid-draw request, so keep only the latest. */
    const { requestDraw, resetDraw } = useCoalescedDraw();

    // Constant padding (see AXIS_PAD) keeps every cell's inner rect the same size.
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
        // Debounced: a resize rebuilds a WebGL context in every cell, so pay it once after a drag.
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
                // regl-scatterplot letterboxes at aspectRatio 1; use the canvas ratio so the [-1, 1] domains fill the cell.
                aspectRatio: innerDims.width / innerDims.height,
                pointSize: 2,
                pointColor,
                pointColorActive: [0.99, 0.75, 0.18, 1.0],
                pointColorHover: POINT_COLOR_HOVER,
                opacity: 0.55,
                backgroundColor: CANVAS_BG,
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
            latestRef.current.onLasso(rows);
            // Drop the lib's `select` state: clusters are drawn by our own colour pipeline and it would double-render the latest one.
            inst.deselect({ preventEvent: true });
        });
        // No 'deselect' subscription — clearing happens via parent state.
        inst.subscribe('view', ({ xScale, yScale }: any) => {
            if (!xScale || !yScale) return;
            const [vxMin, vxMax] = xScale.domain();
            const [vyMin, vyMax] = yScale.domain();
            setVisibleBounds({ xMin: vxMin, xMax: vxMax, yMin: vyMin, yMax: vyMax });
            reportZoomed(isViewAwayFromExtent([vxMin, vxMax], [vyMin, vyMax], dataBoundsRef.current));
        });

        // @ts-expect-error – lib type/runtime mismatch on event name
        inst.subscribe('pointover', (pointIdx: number) => {
            const { data, headers, sensorX, sensorY, isTimeAxis, onHover } = latestRef.current;
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
            latestRef.current.onHover(null);
        });

        // regl draws on a hidden WebGL canvas and copies to `canvasRef`, so context events fire only on the hidden one.
        const glCanvas: HTMLCanvasElement | undefined = inst.get?.('renderer')?.canvas;
        const onContextLost = (e: Event) => { e.preventDefault(); setContextLost(true); };
        // A fresh instance, not the old one resumed: it re-uploads the current points.
        const onContextRestored = () => { setContextLost(false); setRebuildNonce(n => n + 1); };
        glCanvas?.addEventListener('webglcontextlost', onContextLost);
        glCanvas?.addEventListener('webglcontextrestored', onContextRestored);

        liveScRef.current = inst;
        setSc(inst);
        // A rebuild after a resize is a healthy context: no overlay over it.
        setContextLost(false);

        return () => {
            glCanvas?.removeEventListener('webglcontextlost', onContextLost);
            glCanvas?.removeEventListener('webglcontextrestored', onContextRestored);
            // Clear the draw queue FIRST: a draw interrupted by destroy() may
            // never settle, which would leave the queue stuck busy.
            resetDraw();
            liveScRef.current = null;
            destroyReleasingContext(inst);
            setSc(null);
            // A rebuilt (or unmounted) instance starts at the default camera.
            reportZoomed(false);
        };
        // Props reach the handlers through `latestRef`: depending on them would rebuild the context.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [innerDims.width, innerDims.height, rebuildNonce]);

    // Push data when rows, sensors or the instance change; rebuilds the row/point lookups.
    useEffect(() => {
        if (!sc || liveScRef.current !== sc) return;
        const xIdxRaw = sensorX != null ? headers.indexOf(sensorX) : -1;
        const yIdx = headers.indexOf(sensorY);
        if (yIdx < 0) return;
        if (!isTimeAxis && xIdxRaw < 0) return;

        const xs: number[] = [];
        const ys: number[] = [];
        const orig: number[] = [];
        // Defensive cap: stride down raw data so a cell never exceeds a GPU-safe count. `orig` keeps the true row indices.
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
        // Category dim aligned to rendered points: 0 = no cluster, 1..N = palette index.
        const valueA = new Float32Array(orig.length);
        for (let ci = 0; ci < clusters.length; ci++) {
            const cluster = clusters[ci];
            for (const r of cluster.rowIndices) {
                const p = rowToPoint.get(r);
                if (p != null) valueA[p] = ci + 1;
            }
        }
        valueARef.current = valueA;

        // set() before draw: it's synchronous instance config, so the queued
        // draw (which may run a tick later) picks it up either way.
        sc.set({
            pointColor: [pointColor, ...clusters.map(c => c.color)],
            colorBy: 'valueA',
            xScale: scaleLinear().domain([xLo, xHi]).range([-1, 1]),
            yScale: scaleLinear().domain([yLo, yHi]).range([-1, 1]),
        });
        const was = drawnRef.current;
        const sameInstance = was !== null && was.sc === sc;
        const sameView = was !== null && sameInstance && was.data === data && was.x === sensorX && was.y === sensorY
            && was.time === !!isTimeAxis && was.xLo === xLo && was.xHi === xHi && was.yLo === yLo && was.yHi === yHi;
        if (!sameView) {
            // The old camera maps to another region under the new mapping, so reset it. A new instance is already at the default.
            if (sameInstance) sc.reset();
            setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });
            reportZoomed(false);
        }
        drawnRef.current = { sc, data, x: sensorX, y: sensorY, time: !!isTimeAxis, xLo, xHi, yLo, yHi };
        requestDraw(sc, { x: xArr, y: yArr, valueA });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sc, data, sensorX, sensorY, isTimeAxis, headers]);

    // Cluster change: rebuild valueA in place and re-upload; x/y unchanged.
    useEffect(() => {
        if (!sc || liveScRef.current !== sc) return;
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
        if (!sc || liveScRef.current !== sc) return;
        sc.set({ mouseMode: tool === 'lasso' ? 'lasso' : 'panZoom' });
    }, [sc, tool]);

    // Reset broadcast: when the parent's resetTick increments, snap the camera to the full extent.
    useEffect(() => {
        if (!sc) return;
        // Replaced in this commit: the new instance is already at the default camera.
        if (liveScRef.current !== sc) { lastResetTickRef.current = resetTick; return; }
        if (resetTick > lastResetTickRef.current) {
            lastResetTickRef.current = resetTick;
            sc.reset();
            const { xLo, xHi, yLo, yHi } = dataBoundsRef.current;
            setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });
            reportZoomed(false);
        }
    }, [sc, resetTick, reportZoomed]);

    const yTicks = useMemo(() => makeTicks(visibleBounds.yMin, visibleBounds.yMax, 3), [visibleBounds]);
    const xTicks = useMemo(() => makeTicks(visibleBounds.xMin, visibleBounds.xMax, 3), [visibleBounds]);

    const padLeft = AXIS_PAD.left;
    const padTop = AXIS_PAD.top;

    return (
        <div ref={containerRef} className="pair-regl-cell" style={{ background: CANVAS_BG_HEX }}>
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
                {contextLost && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center', gap: 4,
                        background: 'var(--card-bg)', color: 'var(--text-primary)',
                        fontSize: 9, textAlign: 'center', padding: 4, zIndex: 5,
                    }}>
                        <span>Rendering paused</span>
                        <button
                            type="button"
                            onClick={() => { setContextLost(false); setRebuildNonce(n => n + 1); }}
                            style={{
                                padding: '2px 8px', fontSize: 9, cursor: 'pointer', borderRadius: 6,
                                border: '1px solid var(--border-strong)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                            }}
                        >
                            Retry
                        </button>
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
                        {isTimeAxis ? 'Time' : fitLabel(sensorPlainLabel(sensorLookup(sensorX ?? '')), innerDims.width)}
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
                        {fitLabel(sensorPlainLabel(sensorLookup(sensorY)), innerDims.height)}
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
