import { useState, useEffect, useMemo, memo, useRef } from 'react';
import createScatterplot from 'regl-scatterplot';
import { scaleLinear } from 'd3-scale';
import { Download, Eraser, Move, Lasso, RotateCcw } from 'lucide-react';
import { ChartProps } from './ChartTypes';

type ToolMode = 'pan' | 'lasso';

/**
 * Pixel padding around the WebGL canvas for the SVG axis overlay.
 * regl-scatterplot draws points only — ticks/labels/axis titles
 * are rendered by our own SVG layer on top of the canvas.
 */
const AXIS_PADDING = { left: 60, right: 20, top: 50, bottom: 50 };
const AXIS_TICKS = 5;

function fmt(n: number): string {
    if (!isFinite(n)) return '—';
    if (Math.abs(n) >= 10000 || (Math.abs(n) > 0 && Math.abs(n) < 0.01)) return n.toExponential(2);
    return n.toFixed(2);
}

function makeTicks(min: number, max: number, count: number = AXIS_TICKS): number[] {
    if (max === min) return [min];
    return Array.from({ length: count }, (_, i) => min + (max - min) * i / (count - 1));
}

function ScatterChart({ data, sensors, headers }: ChartProps) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    /** Scatter-point index → original CSV row index. lasso `select` gives us
     *  point indices into the array we passed to `.draw()`; this maps back
     *  to the row inside `data[]`. */
    const origIndicesRef = useRef<number[]>([]);

    const [scatterX, setScatterX] = useState<string>('');
    const [scatterY, setScatterY] = useState<string>('');
    const [innerDims, setInnerDims] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    const [wrapperDims, setWrapperDims] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    /** Full data extent — never changes while the chart is on a given (x, y).
     *  Stored in a ref so the `view` event subscriber (registered once when the
     *  instance is built) can read the LATEST bounds without becoming stale. */
    const dataBoundsRef = useRef<{ xLo: number; xHi: number; yLo: number; yHi: number }>({
        xLo: 0, xHi: 1, yLo: 0, yHi: 1,
    });
    /** Currently visible window in REAL data coordinates. Equals full extent
     *  at rest; shrinks/shifts as the user zooms or pans. Drives the SVG
     *  axis ticks so labels stay in sync with the canvas. */
    const [visibleBounds, setVisibleBounds] = useState<{ xMin: number; xMax: number; yMin: number; yMax: number }>({
        xMin: 0, xMax: 1, yMin: 0, yMax: 1,
    });
    const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
    const [tool, setTool] = useState<ToolMode>('pan');
    /** Point index currently under the cursor — drives the floating tooltip.
     *  Cleared on `pointout`. */
    const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
    /** The regl-scatterplot instance kept in component state so the draw
     *  effect can react to its lifecycle (recreate on resize → redraw). */
    const [sc, setSc] = useState<any>(null);

    // Default X/Y to the first two sensors, like the previous ECharts version.
    useEffect(() => {
        if (sensors.length >= 2) {
            if (!sensors.includes(scatterX)) setScatterX(sensors[0]);
            if (!sensors.includes(scatterY)) setScatterY(sensors[1]);
        } else if (sensors.length === 1) {
            setScatterX(sensors[0]);
            setScatterY(sensors[0]);
        }
    }, [sensors, scatterX, scatterY]);

    // Track wrapper size + derive the inner plot area (canvas size).
    useEffect(() => {
        const el = wrapperRef.current;
        if (!el) return;
        const update = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            setWrapperDims({ width: w, height: h });
            setInnerDims({
                width: Math.max(0, w - AXIS_PADDING.left - AXIS_PADDING.right),
                height: Math.max(0, h - AXIS_PADDING.top - AXIS_PADDING.bottom),
            });
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Create / destroy the regl-scatterplot instance whenever the canvas
    // size changes. Stored in state so the draw effect can react to its
    // lifecycle (recreate on resize → redraw).
    useEffect(() => {
        if (!canvasRef.current || innerDims.width === 0 || innerDims.height === 0) return;

        const inst = createScatterplot({
            canvas: canvasRef.current,
            width: innerDims.width,
            height: innerDims.height,
            pointSize: 3,
            // Indigo at low alpha — density emerges via WebGL alpha blending.
            pointColor: [0.39, 0.58, 0.98, 0.55],
            // Amber for lasso-selected (matches palette used in other charts).
            pointColorActive: [0.99, 0.75, 0.18, 1.0],
            pointColorHover: [1.0, 1.0, 1.0, 1.0],
            opacity: 0.6,
            // Match dashboard's slate-900 background.
            backgroundColor: [0.058, 0.094, 0.165, 1.0],
            lassoColor: [0.65, 0.73, 0.97, 0.8],
        });

        inst.subscribe('select', ({ points }: { points: number[] }) => {
            setSelectedIndices(points);
        });
        inst.subscribe('deselect', () => {
            setSelectedIndices([]);
        });
        // Hover → tooltip. The library emits `pointover`/`pointout` with the
        // point index (= position inside the array we passed to draw(), i.e.
        // an index into `origIndicesRef.current`).
        //
        // ts-expect-error explanation: regl-scatterplot's d.ts declares the
        // event names as camelCase (`pointOver` / `pointOut`) but the runtime
        // publishes lowercase (`pointover` / `pointout`). The lowercase form
        // is the one that actually fires — confirmed in the lib's source.
        // @ts-expect-error – lib type/runtime mismatch on event name
        inst.subscribe('pointover', (pointIdx: number) => {
            setHoveredIdx(pointIdx);
        });
        // @ts-expect-error – lib type/runtime mismatch on event name
        inst.subscribe('pointout', () => {
            setHoveredIdx(null);
        });
        // Zoom/pan sync: regl-scatterplot fires `view` every time the camera
        // changes. Because we pass xScale/yScale (built when data arrives)
        // with `.domain([xLo, xHi]).range([-1, 1])`, the lib mutates each
        // scale's domain to reflect the currently-visible region — so
        // `xScale.domain()` here is already in REAL data values, no manual
        // inversion needed.
        inst.subscribe('view', ({ xScale, yScale }: any) => {
            if (!xScale || !yScale) return;
            const [vxMin, vxMax] = xScale.domain();
            const [vyMin, vyMax] = yScale.domain();
            setVisibleBounds({ xMin: vxMin, xMax: vxMax, yMin: vyMin, yMax: vyMax });
        });

        setSc(inst);

        return () => {
            inst.destroy();
            setSc(null);
            setSelectedIndices([]);
        };
    }, [innerDims.width, innerDims.height]);

    // Build points + normalise to [-1, 1] and push to the instance.
    // Runs whenever data / chosen sensors / the instance itself changes.
    useEffect(() => {
        if (!sc) return;
        const xIdx = headers.indexOf(scatterX);
        const yIdx = headers.indexOf(scatterY);
        if (xIdx < 0 || yIdx < 0) return;

        const xs: number[] = [];
        const ys: number[] = [];
        const orig: number[] = [];
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (let i = 0; i < data.length; i++) {
            const x = data[i].values[xIdx];
            const y = data[i].values[yIdx];
            if (x == null || y == null || typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) continue;
            xs.push(x);
            ys.push(y);
            orig.push(i);
            if (x < xMin) xMin = x;
            if (x > xMax) xMax = x;
            if (y < yMin) yMin = y;
            if (y > yMax) yMax = y;
        }

        const xLo = isFinite(xMin) ? xMin : 0;
        const xHi = isFinite(xMax) ? xMax : 1;
        const yLo = isFinite(yMin) ? yMin : 0;
        const yHi = isFinite(yMax) ? yMax : 1;
        const xRange = (xHi - xLo) || 1;
        const yRange = (yHi - yLo) || 1;

        // regl-scatterplot v1.16's `Points` type is `number[][] | PointsObject`.
        // A flat Float32Array is NOT accepted (it'd be read as 1D scalars), so
        // we use the columnar PointsObject form — two Float32Arrays for x and
        // y. ArrayLike<number> satisfies the type AND is the fastest layout
        // for the library's internal vertex buffer upload.
        const len = xs.length;
        const xArr = new Float32Array(len);
        const yArr = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            xArr[i] = ((xs[i] - xLo) / xRange) * 2 - 1;
            yArr[i] = ((ys[i] - yLo) / yRange) * 2 - 1;
        }

        origIndicesRef.current = orig;
        dataBoundsRef.current = { xLo, xHi, yLo, yHi };
        // Fresh data → reset the visible window to the full extent. The next
        // `view` event (after a zoom or pan) will narrow it again.
        setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });
        sc.draw({ x: xArr, y: yArr });
        // Register d3 scales so the `view` event payload's xScale/yScale
        // expose the CURRENT visible domain in real data values. Without
        // this they stay `null` and the axis sync silently no-ops.
        // domain = real range; range = the normalised [-1, 1] coords we
        // actually pushed via draw(). The library mutates the scales as
        // the camera moves.
        sc.set({
            xScale: scaleLinear().domain([xLo, xHi]).range([-1, 1]),
            yScale: scaleLinear().domain([yLo, yHi]).range([-1, 1]),
        });
    }, [sc, data, scatterX, scatterY, headers]);

    // Push the active tool to regl-scatterplot. 'panZoom' is the library
    // default; 'lasso' makes a plain drag draw a polygon selection (no need
    // for shift). Toggle via the toolbar buttons below.
    useEffect(() => {
        if (!sc) return;
        sc.set({ mouseMode: tool === 'lasso' ? 'lasso' : 'panZoom' });
    }, [sc, tool]);

    // Map scatter-point indices → original CSV rows for the panel + export.
    const selectedRows = useMemo(() => {
        return selectedIndices.map(i => {
            const origIdx = origIndicesRef.current[i];
            if (origIdx == null) return null;
            const row = data[origIdx];
            if (!row) return null;
            return { origIdx, row };
        }).filter(Boolean) as Array<{ origIdx: number; row: typeof data[number] }>;
    }, [selectedIndices, data]);

    const handleClear = () => {
        sc?.deselect();
        setSelectedIndices([]);
    };

    const handleResetView = () => {
        sc?.reset();
        // `reset` snaps the camera back to the initial view, so the visible
        // window once again equals the full data extent. Update state right
        // away so the axes don't lag behind the `view` event.
        const { xLo, xHi, yLo, yHi } = dataBoundsRef.current;
        setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });
    };

    const handleExportCsv = () => {
        if (selectedRows.length === 0) return;
        const xIdx = headers.indexOf(scatterX);
        const yIdx = headers.indexOf(scatterY);
        const cols = ['rowIndex', 'timestamp', scatterX, scatterY];
        const escape = (v: string) => /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        const lines = [cols.map(escape).join(',')];
        for (const { origIdx, row } of selectedRows) {
            lines.push([
                String(origIdx),
                row.timestamp ?? '',
                row.values[xIdx] != null ? String(row.values[xIdx]) : '',
                row.values[yIdx] != null ? String(row.values[yIdx]) : '',
            ].map(escape).join(','));
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `scatter-selection-${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // Compute tooltip payload from the hovered point. Recomputes whenever
    // hover state, instance, data, or chosen sensors change. `getScreenPosition`
    // returns canvas-local CSS pixels; we clamp to inside the canvas so the
    // tooltip never falls off the right/bottom edge.
    const tooltip = useMemo(() => {
        if (hoveredIdx === null || !sc) return null;
        const origIdx = origIndicesRef.current[hoveredIdx];
        if (origIdx == null) return null;
        const row = data[origIdx];
        if (!row) return null;
        let pos: [number, number] | undefined;
        try {
            pos = sc.getScreenPosition(hoveredIdx);
        } catch {
            return null;
        }
        if (!pos) return null;
        const xIdx = headers.indexOf(scatterX);
        const yIdx = headers.indexOf(scatterY);
        const xVal = xIdx >= 0 ? row.values[xIdx] : null;
        const yVal = yIdx >= 0 ? row.values[yIdx] : null;

        // Edge clamping — flip the tooltip to the other side of the cursor
        // when it would overflow the inner canvas area.
        const W = 200;
        const H = 76;
        let tx = pos[0] + 12;
        let ty = pos[1] + 12;
        if (tx + W > innerDims.width) tx = pos[0] - W - 12;
        if (ty + H > innerDims.height) ty = pos[1] - H - 12;
        if (tx < 0) tx = 4;
        if (ty < 0) ty = 4;

        return {
            x: tx,
            y: ty,
            xVal,
            yVal,
            timestamp: row.timestamp,
            origIdx,
        };
    }, [hoveredIdx, sc, data, scatterX, scatterY, headers, innerDims.width, innerDims.height]);

    if (sensors.length < 2) {
        return <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: '20%' }}>Select at least 2 sensors</div>;
    }

    const yTicks = makeTicks(visibleBounds.yMin, visibleBounds.yMax);
    const xTicks = makeTicks(visibleBounds.xMin, visibleBounds.xMax);

    return (
        <div ref={wrapperRef} className="scatter-regl-wrap">
            {/* Sensor pickers */}
            <div className="scatter-regl-controls">
                <select value={scatterX} onChange={e => setScatterX(e.target.value)} className="scatter-regl-select">
                    {sensors.map(s => <option key={s} value={s}>{s} (X)</option>)}
                </select>
                <span className="scatter-regl-vs">vs</span>
                <select value={scatterY} onChange={e => setScatterY(e.target.value)} className="scatter-regl-select">
                    {sensors.map(s => <option key={s} value={s}>{s} (Y)</option>)}
                </select>
            </div>

            {/* ECharts-style toolbox (click to activate) */}
            <div className="scatter-regl-toolbox">
                <button
                    onClick={() => setTool('pan')}
                    className={`scatter-regl-tool${tool === 'pan' ? ' active' : ''}`}
                    title="Pan / Zoom (drag = pan, scroll = zoom)"
                >
                    <Move size={13} />
                </button>
                <button
                    onClick={() => setTool('lasso')}
                    className={`scatter-regl-tool${tool === 'lasso' ? ' active' : ''}`}
                    title="Lasso select (drag to draw polygon)"
                >
                    <Lasso size={13} />
                </button>
                <button
                    onClick={handleResetView}
                    className="scatter-regl-tool"
                    title="Reset view"
                >
                    <RotateCcw size={13} />
                </button>
                <button
                    onClick={handleClear}
                    className="scatter-regl-tool"
                    title="Clear selection"
                    disabled={selectedIndices.length === 0}
                >
                    <Eraser size={13} />
                </button>
            </div>

            {/* WebGL canvas — only points, no axes. */}
            <div className="scatter-regl-canvas-wrap" style={{
                position: 'absolute',
                left: AXIS_PADDING.left,
                top: AXIS_PADDING.top,
                width: innerDims.width,
                height: innerDims.height,
            }}>
                <canvas ref={canvasRef} style={{ display: 'block', width: innerDims.width, height: innerDims.height }} />
                {/* Hover tooltip — positioned in canvas-local coordinates so it
                    tracks the highlighted point. pointerEvents:none prevents it
                    from stealing hover from neighbouring points. */}
                {tooltip && (
                    <div className="scatter-regl-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
                        <div className="scatter-regl-tooltip-title">Row {tooltip.origIdx}</div>
                        <div className="scatter-regl-tooltip-row">
                            <span className="scatter-regl-tooltip-label">{scatterX}</span>
                            <span className="scatter-regl-tooltip-value">
                                {tooltip.xVal != null ? fmt(tooltip.xVal as number) : '—'}
                            </span>
                        </div>
                        <div className="scatter-regl-tooltip-row">
                            <span className="scatter-regl-tooltip-label">{scatterY}</span>
                            <span className="scatter-regl-tooltip-value">
                                {tooltip.yVal != null ? fmt(tooltip.yVal as number) : '—'}
                            </span>
                        </div>
                        {tooltip.timestamp && (
                            <div className="scatter-regl-tooltip-ts">{tooltip.timestamp}</div>
                        )}
                    </div>
                )}
            </div>

            {/* SVG overlay = axes + ticks + axis titles. pointerEvents:none so it
                doesn't intercept canvas drags / wheel events. */}
            <svg className="scatter-regl-axes" style={{
                position: 'absolute',
                top: 0, left: 0,
                width: wrapperDims.width,
                height: wrapperDims.height,
                pointerEvents: 'none',
            }}>
                {/* Y axis line */}
                <line x1={AXIS_PADDING.left} y1={AXIS_PADDING.top}
                      x2={AXIS_PADDING.left} y2={AXIS_PADDING.top + innerDims.height}
                      stroke="#475569" />
                {yTicks.map((v, i, arr) => {
                    const y = AXIS_PADDING.top + innerDims.height * (1 - i / (arr.length - 1));
                    return (
                        <g key={`y${i}`}>
                            <line x1={AXIS_PADDING.left - 4} y1={y} x2={AXIS_PADDING.left} y2={y} stroke="#94a3b8" />
                            <text x={AXIS_PADDING.left - 8} y={y + 3} textAnchor="end"
                                  fontSize="10" fill="#94a3b8" fontFamily="Inter, system-ui">{fmt(v)}</text>
                        </g>
                    );
                })}

                {/* X axis line */}
                <line x1={AXIS_PADDING.left} y1={AXIS_PADDING.top + innerDims.height}
                      x2={AXIS_PADDING.left + innerDims.width} y2={AXIS_PADDING.top + innerDims.height}
                      stroke="#475569" />
                {xTicks.map((v, i, arr) => {
                    const x = AXIS_PADDING.left + innerDims.width * (i / (arr.length - 1));
                    return (
                        <g key={`x${i}`}>
                            <line x1={x} y1={AXIS_PADDING.top + innerDims.height}
                                  x2={x} y2={AXIS_PADDING.top + innerDims.height + 4} stroke="#94a3b8" />
                            <text x={x} y={AXIS_PADDING.top + innerDims.height + 16} textAnchor="middle"
                                  fontSize="10" fill="#94a3b8" fontFamily="Inter, system-ui">{fmt(v)}</text>
                        </g>
                    );
                })}

                {/* Axis titles */}
                <text x={AXIS_PADDING.left + innerDims.width / 2} y={wrapperDims.height - 10}
                      textAnchor="middle" fontSize="11" fill="#cbd5e1" fontFamily="Inter, system-ui">
                    {scatterX}
                </text>
                <text x={14} y={AXIS_PADDING.top + innerDims.height / 2}
                      transform={`rotate(-90, 14, ${AXIS_PADDING.top + innerDims.height / 2})`}
                      textAnchor="middle" fontSize="11" fill="#cbd5e1" fontFamily="Inter, system-ui">
                    {scatterY}
                </text>
            </svg>

            {/* Selection panel — only shown when lasso has picked something. */}
            {selectedRows.length > 0 && (
                <div className="scatter-regl-panel">
                    <span>
                        <b>{selectedRows.length.toLocaleString()}</b> point{selectedRows.length === 1 ? '' : 's'} selected
                    </span>
                    <div className="scatter-regl-actions">
                        <button onClick={handleExportCsv} className="scatter-regl-btn" title="Export selection to CSV">
                            <Download size={12} /> CSV
                        </button>
                        <button onClick={handleClear} className="scatter-regl-btn scatter-regl-btn-icon" title="Clear selection">
                            <Eraser size={12} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export default memo(ScatterChart);
