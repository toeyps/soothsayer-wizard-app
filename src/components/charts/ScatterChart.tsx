import { useState, useEffect, useMemo, memo, useRef, useCallback, type CSSProperties } from 'react';
import { destroyReleasingContext } from './releaseGlContext';
import createScatterplot from 'regl-scatterplot';
import { scaleLinear } from 'd3-scale';
import { RotateCcw, Ruler, Tag, Trash2 } from 'lucide-react';
import { ChartProps } from './ChartTypes';
import type { TimeHighlight, ValueHighlightRange } from '../../types';
import { firstMatchingHighlight } from '../../utils/timeHighlights';
import { formatDataStamp } from '../../utils/workbenchDate';
import { readWallClock } from '../../utils/dateFormat';
import { SensorPickerSingle } from '../sensor/SensorPicker';
import { FxBadge, TooltipRowName } from '../sensor/SensorLabel';
import { SensorMetaContext, fmtNum, sensorTitle, ttRowClass, useLayeredSensorLookup, type SensorInfo } from '../sensor/sensorInfo';
import { scatterAxisTitle, type ScatterAxisTitle } from '../../utils/axisName';
import { monoFontFamily, uiFontFamily } from '../../utils/textMeasure';
import { tooltipDistinctEnds } from '../../utils/tooltipLayout';
import { hexToRgba, rgbaToHex, RANGE_PALETTE, TAG_BADGES, MAX_TAGGED_POINTS } from './pairPlotColors';
import { reportError } from '../../errorReporter';
import { useCoalescedDraw } from '../../hooks/useCoalescedDraw';
import { firstFreeColorIndex, sortTagsByTime } from './TaggedPointList';
import { TagTableSlot, tagCell, type TagCompareRow } from './TagCompareTable';

// Re-exported for callers; the array lives in pairPlotColors.ts so LineChart avoids importing regl-scatterplot.
export { RANGE_PALETTE };

// WebGL can't read CSS variables: constant equals --card-bg #101012 as (16, 16, 18) / 255.
const CANVAS_BG: [number, number, number, number] = [0.0627, 0.0627, 0.0706, 1.0];
const POINT_COLOR_HOVER: [number, number, number, number] = [0.925, 0.282, 0.6, 1.0];

/** Base point colour — the app's standard indigo accent at low alpha
 *  (density emerges via WebGL alpha blending). */
const BASE_POINT_COLOR: [number, number, number, number] = [0.39, 0.58, 0.98, 0.55];

/** Colour for points outside every enabled range: low alpha so they fade but keep the data shape. */
const VALUE_UNMATCHED_COLOR: [number, number, number, number] = [0.55, 0.6, 0.68, 0.12];

/** Padding around the WebGL canvas for the SVG axis overlay (ticks, labels, titles). */
const AXIS_PADDING = { left: 88, right: 20, top: 50, bottom: 56 };
/** Y title column (30 px) clears the widest tick label in the 88 px gutter; X title (28 px) sits in the 56 px bottom band. */
const Y_TITLE = { left: 2, width: 30 };
const X_TITLE = { height: 28, bottom: 3 };
/** The one line a title may add: its name's second line, when its tag line prints as well (rule 1b). */
const TITLE_LINE = 14;
/** A Y title longer than the plot uses its free column, this far from the chart's top and bottom. */
const Y_TITLE_INSET = 4;
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

/** Axis title: description, then tag + unit; `fit.wrapped` prints a long name on one or two lines with the unit attached. */
function AxisTitle({ axis, info, style, fit }: { axis: 'x' | 'y'; info: SensorInfo; style: CSSProperties; fit?: ScatterAxisTitle }) {
    if (fit?.wrapped) {
        const unitTail = info.unit ? ` · ${info.unit}` : '';
        return (
            <div
                className={`scatter-axis-title scatter-axis-title--${axis}`}
                data-testid={`scatter-axis-title-${axis}`}
                data-lines={fit.wrapped.length}
                data-cut={fit.cut ? '1' : undefined}
                title={sensorTitle(info)}
                style={style}
            >
                {fit.wrapped.map((line, i) => {
                    const last = i === fit.wrapped!.length - 1;
                    const withUnit = last && !!unitTail && line.endsWith(unitTail);
                    return (
                        <span key={i} className="sat-l1">
                            {i === 0 && <FxBadge special={info.special} />}
                            <span className={info.description ? 'sat-desc' : 'sat-desc sat-desc--tag'}>
                                {withUnit ? line.slice(0, -unitTail.length) : line}
                                {withUnit && <span className="sat-unit">{unitTail}</span>}
                            </span>
                        </span>
                    );
                })}
                {fit.tagLine && (
                    <span className="sat-l2">
                        <span className="sat-tag">{info.tag}</span>
                        {fit.unitOnTagLine && info.unit && <span className="scatter-axis-unit">{info.unit}</span>}
                    </span>
                )}
            </div>
        );
    }
    return (
        <div className={`scatter-axis-title scatter-axis-title--${axis}`} data-testid={`scatter-axis-title-${axis}`} title={sensorTitle(info)} style={style}>
            {info.description && (
                <span className="sat-l1">
                    <FxBadge special={info.special} />
                    <span className="sat-desc">{info.description}</span>
                </span>
            )}
            <span className="sat-l2">
                {!info.description && <FxBadge special={info.special} />}
                <span className="sat-tag">{info.tag}</span>
                {info.unit && <span className="scatter-axis-unit">{info.unit}</span>}
            </span>
        </div>
    );
}

/** One value row of the hover tooltip: inline label left, value + unit right
 *  (DESIGN_SYSTEM §4 "Tooltips and value boxes"). */
function ValueRow({ info, value, distinct }: { info: SensorInfo; value: unknown; distinct?: string }) {
    const valueText = `${typeof value === 'number' ? fmtNum(value) : '—'}${info.unit ? ` ${info.unit}` : ''}`;
    return (
        <div className={ttRowClass(info, valueText, distinct)}>
            <span className="tt-label"><TooltipRowName info={info} valueText={valueText} distinct={distinct} /></span>
            <span className="tt-val">{valueText}</span>
        </div>
    );
}

function ScatterChart({
    data, sensors, headers, scatterX: persistedX, scatterY: persistedY, onScatterAxesChange,
    scatterAxisPins: persistedPins, onScatterAxisPinsChange,
    sensorMetadata, timeHighlights, valueHighlight,
    tagTableHost, onTagCountChange,
}: ChartProps) {
    // Labels (pickers, axis titles, tooltip / tag rows) resolve through this lookup.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    /** Scatter-point index to original row index (for the hover tooltip). */
    const origIndicesRef = useRef<number[]>([]);
    /** Last instance the draw effect ran on: reset the camera only on an existing instance (right after creation it can crash). */
    const prevScForResetRef = useRef<any>(null);
    /** What the camera was last fitted to. A highlight change re-runs the draw effect without changing it. */
    const fittedRef = useRef<{ data: unknown; x: string; y: string; xLo: number; xHi: number; yLo: number; yHi: number } | null>(null);
    /** Instance alive now; the draw effect skips a stale `sc` because sc.set() on a destroyed instance throws. */
    const liveScRef = useRef<any>(null);
    const liveHaloScRef = useRef<any>(null);
    // Seeded from the persisted prop: this component remounts on every chart-type switch.
    const [scatterX, setScatterX] = useState<string>(() => persistedX ?? '');
    const [scatterY, setScatterY] = useState<string>(() => persistedY ?? '');
    const [wrapperDims, setWrapperDims] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
    /** Full data extent, in a ref so the `view` subscriber reads the latest bounds. */
    const dataBoundsRef = useRef<{ xLo: number; xHi: number; yLo: number; yHi: number }>({
        xLo: 0, xHi: 1, yLo: 0, yHi: 1,
    });
    /** Visible window in real data coordinates; drives the SVG axis ticks. */
    const [visibleBounds, setVisibleBounds] = useState<{ xMin: number; xMax: number; yMin: number; yMax: number }>({
        xMin: 0, xMax: 1, yMin: 0, yMax: 1,
    });
    /** Point index currently under the cursor — drives the floating tooltip.
     *  Cleared on `pointout`. */
    const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
    /** Ref mirror of hoveredIdx for the click listener, which is attached only on resize. */
    const hoveredIdxRef = useRef<number | null>(null);
    useEffect(() => { hoveredIdxRef.current = hoveredIdx; }, [hoveredIdx]);

    /** Tagged points are local state: pointIdx has no meaning across a refetch (the sample is re-drawn). */
    const [scatterTagMode, setScatterTagMode] = useState(false);
    const scatterTagModeRef = useRef(false);
    useEffect(() => { scatterTagModeRef.current = scatterTagMode; }, [scatterTagMode]);
    const [scatterTags, setScatterTags] = useState<{ id: string; pointIdx: number; colorIdx: number }[]>([]);
    // Clear tags when the drawn point set can change (new data or sensor pair); pan, zoom and pins don't change it.
    useEffect(() => {
        setScatterTags([]);
    }, [data, scatterX, scatterY]);

    // Report the tag count to the parent; 0 when the chart goes away.
    const tagCountRef = useRef(scatterTags.length);
    const onTagCountChangeRef = useRef(onTagCountChange);
    onTagCountChangeRef.current = onTagCountChange;
    useEffect(() => {
        const n = scatterTags.length;
        onTagCountChangeRef.current?.(n, n > tagCountRef.current);
        tagCountRef.current = n;
    }, [scatterTags.length]);
    useEffect(() => () => { onTagCountChangeRef.current?.(0, false); }, []);
    /** Instance kept in state so the draw effect reacts to its recreation. */
    const [sc, setSc] = useState<any>(null);
    /** WebGL context-loss guard: show a Retry overlay; `rebuildNonce` re-runs the create effect. */
    const [contextLost, setContextLost] = useState(false);
    const [rebuildNonce, setRebuildNonce] = useState(0);
    /** WebGL init failure throws synchronously; guard it or the whole app unmounts. */
    const [initError, setInitError] = useState<string | null>(null);
    /** Serialized draw queue: regl-scatterplot drops a draw() issued while one is in flight. */
    const { requestDraw, resetDraw } = useCoalescedDraw();

    /** Halo layer needs its own draw queue; the hook's busy flag is per hook instance. */
    const haloCanvasRef = useRef<HTMLCanvasElement>(null);
    const [haloSc, setHaloSc] = useState<any>(null);
    /** Ref so the one-time `view` subscriber always sees the current halo instance. */
    const haloScRef = useRef<any>(null);
    useEffect(() => { haloScRef.current = haloSc; }, [haloSc]);
    const { requestDraw: requestHaloDraw, resetDraw: resetHaloDraw } = useCoalescedDraw();

    /** Pinned X/Y bounds; a pin records its sensor and stops applying when the axis sensor changes. Seeded from props. */
    const [xPin, setXPin] = useState<{ sensor: string; min?: number; max?: number } | null>(() => persistedPins?.x ?? null);
    const [yPin, setYPin] = useState<{ sensor: string; min?: number; max?: number } | null>(() => persistedPins?.y ?? null);
    // Follow renamed props, or the effect below sees an unknown sensor and resets the axis.
    const [seenProps, setSeenProps] = useState({ x: persistedX, y: persistedY, pinX: persistedPins?.x, pinY: persistedPins?.y });
    if (seenProps.x !== persistedX || seenProps.y !== persistedY || seenProps.pinX !== persistedPins?.x || seenProps.pinY !== persistedPins?.y) {
        setSeenProps({ x: persistedX, y: persistedY, pinX: persistedPins?.x, pinY: persistedPins?.y });
        if (persistedX && persistedX !== seenProps.x) setScatterX(persistedX);
        if (persistedY && persistedY !== seenProps.y) setScatterY(persistedY);
        if (persistedPins?.x !== seenProps.pinX) setXPin(persistedPins?.x ?? null);
        if (persistedPins?.y !== seenProps.pinY) setYPin(persistedPins?.y ?? null);
    }
    const [axisEditorOpen, setAxisEditorOpen] = useState(false);
    const [draftXMin, setDraftXMin] = useState('');
    const [draftXMax, setDraftXMax] = useState('');
    const [draftYMin, setDraftYMin] = useState('');
    const [draftYMax, setDraftYMax] = useState('');
    const [axisEditorError, setAxisEditorError] = useState<string | null>(null);

    // Derived in render so a stale pin never applies for a frame after a sensor change.
    const effectiveXRange = xPin && xPin.sensor === scatterX ? xPin : undefined;
    const effectiveYRange = yPin && yPin.sensor === scatterY ? yPin : undefined;
    const isAxisPinned = !!effectiveXRange || !!effectiveYRange;

    // Re-sync drafts when X/Y sensors change while open, or Apply would pin the new sensor with the old sensor's numbers.
    useEffect(() => {
        if (!axisEditorOpen) return;
        setDraftXMin(effectiveXRange?.min !== undefined ? String(effectiveXRange.min) : '');
        setDraftXMax(effectiveXRange?.max !== undefined ? String(effectiveXRange.max) : '');
        setDraftYMin(effectiveYRange?.min !== undefined ? String(effectiveYRange.min) : '');
        setDraftYMax(effectiveYRange?.max !== undefined ? String(effectiveYRange.max) : '');
        // effectiveXRange/YRange omitted: they change only on apply/clear (editor closes); including them would clobber typing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scatterX, scatterY, axisEditorOpen]);

    const toggleAxisEditor = () => {
        setAxisEditorError(null);
        setAxisEditorOpen(o => !o);
    };

    const applyAxisRange = () => {
        const parse = (s: string) => s.trim() === '' ? undefined : parseFloat(s.trim());
        const xMin = parse(draftXMin), xMax = parse(draftXMax);
        const yMin = parse(draftYMin), yMax = parse(draftYMax);
        // Use isFinite: parseFloat('1e400') is Infinity and would turn normalised points into NaN.
        for (const v of [xMin, xMax, yMin, yMax]) {
            if (v !== undefined && !isFinite(v)) { setAxisEditorError('Enter valid numbers'); return; }
        }
        if (xMin === undefined && xMax === undefined && yMin === undefined && yMax === undefined) {
            setAxisEditorError('Enter at least one bound');
            return;
        }
        if (xMin !== undefined && xMax !== undefined && xMin >= xMax) { setAxisEditorError('X min must be less than X max'); return; }
        if (yMin !== undefined && yMax !== undefined && yMin >= yMax) { setAxisEditorError('Y min must be less than Y max'); return; }
        setXPin(xMin !== undefined || xMax !== undefined ? { sensor: scatterX, min: xMin, max: xMax } : null);
        setYPin(yMin !== undefined || yMax !== undefined ? { sensor: scatterY, min: yMin, max: yMax } : null);
        setAxisEditorOpen(false);
        setAxisEditorError(null);
    };

    const clearAxisRange = () => {
        setXPin(null);
        setYPin(null);
        setAxisEditorOpen(false);
        setAxisEditorError(null);
    };

    // Default X/Y to the first two sensors.
    useEffect(() => {
        if (sensors.length >= 2) {
            const x = sensors.includes(scatterX) ? scatterX : sensors[0];
            if (x !== scatterX) setScatterX(x);
            if (!sensors.includes(scatterY)) {
                // Pick a DIFFERENT sensor than X so a fresh default never
                // plots a column against itself.
                setScatterY(sensors.find(s => s !== x) ?? sensors[1]);
            }
        } else if (sensors.length === 1) {
            setScatterX(sensors[0]);
            // Reset Y so going from 1 to 2 sensors cannot leave Y === X; '' is never shown (the <2-sensor guard hides the chart).
            setScatterY('');
        }
    }, [sensors, scatterX, scatterY]);

    // Push the settled X/Y pair to the parent so it survives unmount.
    useEffect(() => {
        if (scatterX && scatterY) onScatterAxesChange?.(scatterX, scatterY);
    }, [scatterX, scatterY, onScatterAxesChange]);

    // Push pin changes up for the same reason; the re-send on mount is a no-op.
    useEffect(() => {
        onScatterAxisPinsChange?.({ x: xPin ?? undefined, y: yPin ?? undefined });
    }, [xPin, yPin, onScatterAxisPinsChange]);

    // Titles fit the plot; only a title needing a third line takes one line from the plot.
    const [fontsTick, setFontsTick] = useState(0);
    useEffect(() => {
        let gone = false;
        document.fonts?.ready.then(() => { if (!gone) setFontsTick(t => t + 1); });
        return () => { gone = true; };
    }, []);
    const titleFit = useMemo(() => {
        const none = { pad: AXIS_PADDING, x: undefined as ScatterAxisTitle | undefined, y: undefined as ScatterAxisTitle | undefined };
        if (!wrapperDims.width || !wrapperDims.height) return none;
        const options = { fontFamily: uiFontFamily(), monoFamily: monoFontFamily() };
        const xInfo = sensorLookup(scatterX);
        const yInfo = sensorLookup(scatterY);
        let { pad, x, y } = none;
        for (let i = 0; i < 3; i++) {
            y = scatterAxisTitle(yInfo, wrapperDims.height - pad.top - pad.bottom, { ...options, chartRoom: wrapperDims.height - 2 * Y_TITLE_INSET });
            x = scatterAxisTitle(xInfo, wrapperDims.width - pad.left - pad.right, options);
            pad = {
                ...AXIS_PADDING,
                left: AXIS_PADDING.left + (y.tagLine && (y.wrapped?.length ?? 0) > 1 ? TITLE_LINE : 0),
                bottom: AXIS_PADDING.bottom + (x.tagLine && (x.wrapped?.length ?? 0) > 1 ? TITLE_LINE : 0),
            };
        }
        return { pad, x, y };
        // fontsTick: the widths change once the web fonts have loaded.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wrapperDims.width, wrapperDims.height, scatterX, scatterY, sensorLookup, fontsTick]);
    // Apply the gutter in its own commit: a same-commit size and sensor change would hand the draw effect a destroyed instance.
    const [pad, setPad] = useState(AXIS_PADDING);
    useEffect(() => {
        setPad(p => (p.left === titleFit.pad.left && p.bottom === titleFit.pad.bottom ? p : titleFit.pad));
    }, [titleFit.pad]);
    const innerDims = useMemo(() => ({
        width: Math.max(0, wrapperDims.width - pad.left - pad.right),
        height: Math.max(0, wrapperDims.height - pad.top - pad.bottom),
    }), [wrapperDims.width, wrapperDims.height, pad]);

    // Track wrapper size (the inner plot area is derived from it above).
    useEffect(() => {
        const el = wrapperRef.current;
        if (!el) return;
        const update = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            setWrapperDims({ width: w, height: h });
        };
        update(); // immediate on mount — no debounce delay for the initial layout
        // Debounce: each size change destroys and recreates the WebGL context; wait for a drag to pause.
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

    // Create/destroy the instance when the canvas size changes.
    useEffect(() => {
        if (!canvasRef.current || innerDims.width === 0 || innerDims.height === 0) return;

        let inst: ReturnType<typeof createScatterplot>;
        try {
            inst = createScatterplot({
                canvas: canvasRef.current,
                width: innerDims.width,
                height: innerDims.height,
                // Match aspectRatio to the canvas: domains are normalised to [-1, 1], so the default 1 would letterbox.
                aspectRatio: innerDims.width / innerDims.height,
                pointSize: 3,
                pointColor: BASE_POINT_COLOR,
                pointColorHover: POINT_COLOR_HOVER,
                opacity: 0.6,
                backgroundColor: CANVAS_BG,
            });
        } catch (err) {
            reportError('scatter-init', err);
            setInitError(err instanceof Error ? err.message : String(err));
            return;
        }
        setInitError(null);

        // ts-expect-error: typings say pointOver/pointOut but the runtime fires lowercase pointover/pointout.
        // @ts-expect-error – lib type/runtime mismatch on event name
        inst.subscribe('pointover', (pointIdx: number) => {
            setHoveredIdx(pointIdx);
        });
        // @ts-expect-error – lib type/runtime mismatch on event name
        inst.subscribe('pointout', () => {
            setHoveredIdx(null);
        });
        // The lib mutates xScale/yScale domains on camera moves, so `domain()` is already in real data values.
        inst.subscribe('view', ({ xScale, yScale, view }: any) => {
            if (!xScale || !yScale) return;
            const [vxMin, vxMax] = xScale.domain();
            const [vyMin, vyMax] = yScale.domain();
            setVisibleBounds({ xMin: vxMin, xMax: vxMax, yMin: vyMin, yMax: vyMax });
            // Relay camera to the halo: it gets no mouse input (pointer-events: none) and shares the same data-to-[-1,1] mapping.
            if (view) haloScRef.current?.set({ cameraView: view });
        });

        // Context events fire on regl's hidden WebGL canvas, not on `canvasRef` (2D).
        const canvas = canvasRef.current;
        // A rebuild after a resize is a healthy context: no overlay over it.
        setContextLost(false);
        const glCanvas: HTMLCanvasElement | undefined = inst.get?.('renderer')?.canvas;
        const onContextLost = (e: Event) => { e.preventDefault(); setContextLost(true); };
        // A fresh instance, not the old one resumed: it re-uploads the current points.
        const onContextRestored = () => { setContextLost(false); setRebuildNonce(n => n + 1); };
        glCanvas?.addEventListener('webglcontextlost', onContextLost);
        glCanvas?.addEventListener('webglcontextrestored', onContextRestored);

        // Tag click lives with the canvas lifecycle; mode and hover are read via refs to avoid re-attaching.
        const onCanvasClick = () => {
            if (!scatterTagModeRef.current) return;
            const idx = hoveredIdxRef.current;
            if (idx == null) return;
            setScatterTags(prev => {
                const existing = prev.find(t => t.pointIdx === idx);
                if (existing) return prev.filter(t => t.id !== existing.id);
                if (prev.length >= MAX_TAGGED_POINTS) return prev;
                const colorIdx = firstFreeColorIndex(prev.map(t => t.colorIdx), RANGE_PALETTE.length);
                return [...prev, { id: `tag-${Date.now()}-${prev.length}`, pointIdx: idx, colorIdx }];
            });
        };
        canvas.addEventListener('click', onCanvasClick);

        liveScRef.current = inst;
        setSc(inst);

        return () => {
            glCanvas?.removeEventListener('webglcontextlost', onContextLost);
            glCanvas?.removeEventListener('webglcontextrestored', onContextRestored);
            canvas.removeEventListener('click', onCanvasClick);
            // Clear the draw queue FIRST: a draw interrupted by destroy() may
            // never settle, which would leave the queue stuck busy.
            resetDraw();
            liveScRef.current = null;
            destroyReleasingContext(inst);
            setSc(null);
        };
    }, [innerDims.width, innerDims.height, rebuildNonce]);

    /** Whether the halo has anything to show; gates the halo effect and is its dependency. */
    const hasEnabledHighlights = (timeHighlights ?? []).some(h => h.enabled);

    // Halo exists only while a highlight is enabled, so the extra WebGL context isn't held otherwise.
    useEffect(() => {
        if (!haloCanvasRef.current || innerDims.width === 0 || innerDims.height === 0 || !hasEnabledHighlights) return;

        let inst: ReturnType<typeof createScatterplot>;
        try {
            inst = createScatterplot({
                canvas: haloCanvasRef.current,
                width: innerDims.width,
                height: innerDims.height,
                aspectRatio: innerDims.width / innerDims.height,
                pointSize: 7,
                // Transparent clear colour: this canvas paints only the highlighted points.
                backgroundColor: [0, 0, 0, 0],
            });
        } catch (err) {
            // Decorative layer: skip silently if a second WebGL context can't be created.
            reportError('scatter-halo-init', err);
            return;
        }
        liveHaloScRef.current = inst;
        setHaloSc(inst);
        const haloCanvas = haloCanvasRef.current;

        return () => {
            resetHaloDraw();
            // Null the refs before destroy(): a `view` event in between would call .set() on a destroyed instance and throw.
            haloScRef.current = null;
            liveHaloScRef.current = null;
            destroyReleasingContext(inst);
            setHaloSc(null);
            // destroy() leaves the canvas bitmap frozen; resetting width clears it (the self-assign is intentional).
            // eslint-disable-next-line no-self-assign
            if (haloCanvas) haloCanvas.width = haloCanvas.width;
        };
    }, [innerDims.width, innerDims.height, rebuildNonce, hasEnabledHighlights, resetHaloDraw]);

    // Build points + normalise to [-1, 1] and push to the instance.
    // Runs whenever data / chosen sensors / the instance itself changes.
    useEffect(() => {
        // `sc` was replaced in this very commit (see `liveScRef`): the new instance runs this effect again.
        if (!sc || liveScRef.current !== sc) return;
        const xIdx = headers.indexOf(scatterX);
        const yIdx = headers.indexOf(scatterY);
        if (xIdx < 0 || yIdx < 0) return;

        const xs: number[] = [];
        const ys: number[] = [];
        const orig: number[] = [];
        // Criteria-sensor column gathered on the same filtered rows; a row missing it still plots, uncoloured.
        const valueSensorIdx = valueHighlight?.sensor ? headers.indexOf(valueHighlight.sensor) : -1;
        const zs: (number | null)[] = [];
        // Defensive cap: stride raw data over 500k points to avoid losing the WebGL context; `orig` keeps true row indices.
        const RENDER_CAP = 500_000;
        const step = data.length > RENDER_CAP ? Math.ceil(data.length / RENDER_CAP) : 1;
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (let i = 0; i < data.length; i += step) {
            const x = data[i].values[xIdx];
            const y = data[i].values[yIdx];
            if (x == null || y == null || typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) continue;
            xs.push(x);
            ys.push(y);
            orig.push(i);
            if (valueSensorIdx >= 0) {
                const z = data[i].values[valueSensorIdx];
                zs.push(z != null && typeof z === 'number' && !isNaN(z) ? z : null);
            }
            if (x < xMin) xMin = x;
            if (x > xMax) xMax = x;
            if (y < yMin) yMin = y;
            if (y > yMax) yMax = y;
        }

        // Pinned bounds override the data extent per side; the unset side auto-fits.
        let xLo = effectiveXRange?.min !== undefined ? effectiveXRange.min : (isFinite(xMin) ? xMin : 0);
        let xHi = effectiveXRange?.max !== undefined ? effectiveXRange.max : (isFinite(xMax) ? xMax : 1);
        let yLo = effectiveYRange?.min !== undefined ? effectiveYRange.min : (isFinite(yMin) ? yMin : 0);
        let yHi = effectiveYRange?.max !== undefined ? effectiveYRange.max : (isFinite(yMax) ? yMax : 1);
        // A partial pin can cross the auto-fitted side; swap so the axis isn't inverted.
        if (xLo > xHi) { const t = xLo; xLo = xHi; xHi = t; }
        if (yLo > yHi) { const t = yLo; yLo = yHi; yHi = t; }
        const xRange = (xHi - xLo) || 1;
        const yRange = (yHi - yLo) || 1;

        // Points must be a PointsObject of two Float32Arrays; a flat Float32Array is read as 1D scalars.
        const len = xs.length;
        const xArr = new Float32Array(len);
        const yArr = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            xArr[i] = ((xs[i] - xLo) / xRange) * 2 - 1;
            yArr[i] = ((ys[i] - yLo) / yRange) * 2 - 1;
        }

        // Halo colour channel: 0 = no enabled highlight; 1..N = Nth enabled highlight, first match wins.
        if (haloSc && liveHaloScRef.current === haloSc) {
            const enabledHighlights: TimeHighlight[] = (timeHighlights ?? []).filter(h => h.enabled);
            if (enabledHighlights.length > 0) {
                const idOrder = new Map(enabledHighlights.map((h, i) => [h.id, i]));
                const haloValueA = new Float32Array(len);
                for (let i = 0; i < len; i++) {
                    const row = data[orig[i]];
                    const match = firstMatchingHighlight(row?.timestamp, enabledHighlights);
                    if (match) haloValueA[i] = (idOrder.get(match.id) ?? -1) + 1;
                }
                haloSc.set({
                    xScale: scaleLinear().domain([xLo, xHi]).range([-1, 1]),
                    yScale: scaleLinear().domain([yLo, yHi]).range([-1, 1]),
                    colorBy: 'valueA',
                    // Category 0 is transparent so unmatched points paint nothing on the halo.
                    pointColor: [[0, 0, 0, 0], ...enabledHighlights.map(h => hexToRgba(h.color, 0.85))],
                    // A halo created while the chart is zoomed starts at the default camera.
                    cameraView: sc.get?.('cameraView'),
                });
                requestHaloDraw(haloSc, { x: xArr, y: yArr, valueA: haloValueA });
            }
        }

        // Main canvas colour channel for by-value ranges: 0 = unmatched; 1..N = Nth enabled range, first match wins.
        const enabledRanges: ValueHighlightRange[] = valueSensorIdx >= 0 ? (valueHighlight?.ranges ?? []).filter(r => r.enabled) : [];
        const hasActiveRanges = enabledRanges.length > 0;
        let valueAArr: Float32Array | undefined;
        if (hasActiveRanges) {
            valueAArr = new Float32Array(len);
            for (let i = 0; i < len; i++) {
                const z = zs[i];
                if (z == null) continue; // stays 0 (unmatched)
                const idx = enabledRanges.findIndex(r => z >= r.min && z <= r.max);
                if (idx >= 0) valueAArr[i] = idx + 1;
            }
        }

        origIndicesRef.current = orig;
        dataBoundsRef.current = { xLo, xHi, yLo, yHi };
        const fitted = fittedRef.current;
        const sameInstance = prevScForResetRef.current === sc;
        // Only colours changed (a highlight): the camera and the ticks stay where the user put them.
        const sameFit = sameInstance && !!fitted && fitted.data === data && fitted.x === scatterX && fitted.y === scatterY
            && fitted.xLo === xLo && fitted.xHi === xHi && fitted.yLo === yLo && fitted.yHi === yHi;
        fittedRef.current = { data, x: scatterX, y: scatterY, xLo, xHi, yLo, yHi };
        // Fresh data → reset the visible window to the full extent. The next
        // `view` event (after a zoom or pan) will narrow it again.
        if (!sameFit) setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });
        // Register d3 scales so `view` payloads expose the visible domain in real values; otherwise axis sync no-ops.
        sc.set({
            xScale: scaleLinear().domain([xLo, xHi]).range([-1, 1]),
            yScale: scaleLinear().domain([yLo, yHi]).range([-1, 1]),
            // pointColor is the flat colour when colorBy is null, and the palette (index 0 = unmatched) for 'valueA'.
            colorBy: hasActiveRanges ? 'valueA' : null,
            pointColor: hasActiveRanges
                ? [VALUE_UNMATCHED_COLOR, ...enabledRanges.map(r => hexToRgba(r.color))]
                : BASE_POINT_COLOR,
        });
        // Reset the camera on sensor/pin changes so the view matches the ticks; skip a fresh instance (unsafe to reset).
        if (sameInstance && !sameFit) {
            sc.reset();
        }
        prevScForResetRef.current = sc;
        requestDraw(sc, valueAArr ? { x: xArr, y: yArr, valueA: valueAArr } : { x: xArr, y: yArr });
    }, [sc, data, scatterX, scatterY, headers, requestDraw, effectiveXRange, effectiveYRange, haloSc, timeHighlights, requestHaloDraw, valueHighlight]);

    const handleResetView = () => {
        sc?.reset();
        // reset restores the full extent; update state now so axes don't lag the `view` event.
        const { xLo, xHi, yLo, yHi } = dataBoundsRef.current;
        setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });
    };

    // Tooltip payload from the hovered point; getScreenPosition is canvas-local, clamped inside the canvas.
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

        // Flip the tooltip to the other side of the cursor when it would overflow; a wrapping row makes the box larger.
        const wraps = [scatterX, scatterY].some(t => ttRowClass(sensorLookup(t)) !== 'tt-row');
        const W = wraps ? 440 : 200;
        const H = wraps ? 112 : 76;
        // Flipped, the box hangs from its right edge: W is only an estimate, so it must end 12 px from the point.
        let tx = pos[0] + 12;
        let tr: number | undefined;
        let ty = pos[1] + 12;
        if (tx + W > innerDims.width) {
            const roomLeft = pos[0] - 12;
            if (roomLeft >= W || (wraps && roomLeft >= innerDims.width - tx)) tr = innerDims.width - roomLeft;
            // Fits on neither side: a box that wraps stays on the roomier side and wraps in what is there.
            else if (!wraps) tx = 4;
        }
        if (ty + H > innerDims.height) ty = pos[1] - H - 12;
        if (tx < 0) tx = 4;
        if (ty < 0) ty = 4;

        return {
            x: tr === undefined ? tx : undefined,
            right: tr,
            // Hanging right, the room is what lies left of the point; only a wrapping box gives way.
            hug: tr !== undefined && !wraps,
            y: ty,
            xVal,
            yVal,
            timestamp: row.timestamp,
            origIdx,
        };
    }, [hoveredIdx, sc, data, scatterX, scatterY, headers, innerDims.width, innerDims.height, sensorLookup]);
    const hasTooltip = !!tooltip;
    const tooltipEnds = useMemo(() => (
        hasTooltip ? tooltipDistinctEnds([sensorLookup(scatterX), sensorLookup(scatterY)]) : new Map<string, string>()
    ), [hasTooltip, scatterX, scatterY, sensorLookup]);

    // Ring positions recompute on each view change so they track the camera.
    const tagOverlays = useMemo(() => {
        if (!sc || scatterTags.length === 0) return [];
        return scatterTags
            .map(tag => {
                const origIdx = origIndicesRef.current[tag.pointIdx];
                const row = origIdx != null ? data[origIdx] : null;
                if (!row) return null;
                let pos: [number, number] | undefined;
                try {
                    pos = sc.getScreenPosition(tag.pointIdx);
                } catch {
                    return null;
                }
                if (!pos) return null;
                const color = rgbaToHex(RANGE_PALETTE[tag.colorIdx % RANGE_PALETTE.length]);
                return {
                    id: tag.id,
                    x: pos[0],
                    y: pos[1],
                    color,
                };
            })
            .filter((v): v is NonNullable<typeof v> => v !== null);
    }, [sc, scatterTags, data, visibleBounds]);

    // Table columns come from scatterTags, not tagOverlays, so an unplaceable tag can still be removed.
    // Focus target when the last tag's × empties the list.
    const tagButtonRef = useRef<HTMLButtonElement>(null);
    const removeScatterTag = useCallback((id: string) => {
        setScatterTags(prev => prev.filter(t => t.id !== id));
    }, []);
    // The table's columns run in TIME order (the row's own wall clock), like the Line chart's.
    const tagsByTime = useMemo(() => sortTagsByTime(scatterTags, tag => {
        const origIdx = origIndicesRef.current[tag.pointIdx];
        const w = origIdx != null && data[origIdx]?.timestamp ? readWallClock(data[origIdx].timestamp) : null;
        return w ? Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) : NaN;
    }), [scatterTags, data]);
    const tagListItems = useMemo(() => tagsByTime.map((tag, order) => {
        const origIdx = origIndicesRef.current[tag.pointIdx];
        const row = origIdx != null ? data[origIdx] : null;
        return {
            id: tag.id,
            badge: TAG_BADGES[order % TAG_BADGES.length],
            color: rgbaToHex(RANGE_PALETTE[tag.colorIdx % RANGE_PALETTE.length]),
            label: row?.timestamp ? formatDataStamp(row.timestamp) : `Point ${order + 1}`,
        };
    }), [tagsByTime, data]);
    // ... and its two rows: the X and the Y sensor's value at each tagged point.
    const tagTableRows = useMemo<TagCompareRow[]>(() => {
        if (tagsByTime.length === 0) return [];
        return ([['X', scatterX], ['Y', scatterY]] as const).map(([lead, sensor]) => {
            const col = headers.indexOf(sensor);
            const info = sensorLookup(sensor);
            return {
                key: lead,
                lead,
                info,
                cells: tagsByTime.map(tag => {
                    const origIdx = origIndicesRef.current[tag.pointIdx];
                    const v = origIdx != null && col >= 0 ? data[origIdx]?.values[col] : null;
                    return tagCell(typeof v === 'number' ? fmtNum(v) : null);
                }),
            };
        });
    }, [tagsByTime, data, scatterX, scatterY, headers, sensorLookup]);

    if (sensors.length < 2) {
        return <div style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: '20%' }}>Select at least 2 sensors</div>;
    }

    const yTicks = makeTicks(visibleBounds.yMin, visibleBounds.yMax);
    const xTicks = makeTicks(visibleBounds.xMin, visibleBounds.xMax);

    return (
        <SensorMetaContext.Provider value={sensorLookup}>
        <div className="chart-with-tags">
        <div ref={wrapperRef} className="scatter-regl-wrap chart-with-tags-plot">
            {/* Sensor pickers — "X"/"Y" is its own small badge beside each picker. */}
            <div className={`scatter-regl-controls${scatterTags.length > 0 ? ' scatter-regl-controls--tags' : ''}`}>
                <span className="scatter-regl-axis-badge">X</span>
                {/* The shared single picker in its compact 24 px form. Y opens
                    right-aligned so it stays inside the chart. */}
                <span className="scatter-pk">
                    <SensorPickerSingle
                        compact
                        sensors={sensors}
                        value={scatterX}
                        onSelect={(t) => { if (t) setScatterX(t); }}
                        scope={<>Sensors on the chart · {sensors.length}</>}
                        ariaLabel="X sensor"
                    />
                </span>
                <span className="scatter-regl-vs">vs</span>
                <span className="scatter-regl-axis-badge">Y</span>
                <span className="scatter-pk">
                    <SensorPickerSingle
                        compact
                        alignRight
                        sensors={sensors}
                        value={scatterY}
                        onSelect={(t) => { if (t) setScatterY(t); }}
                        scope={<>Sensors on the chart · {sensors.length}</>}
                        ariaLabel="Y sensor"
                    />
                </span>
            </div>

            <div className="scatter-regl-toolbox">
                <button
                    onClick={handleResetView}
                    className="scatter-regl-tool"
                    title="Reset view"
                >
                    <RotateCcw size={13} />
                </button>
                <button
                    onClick={toggleAxisEditor}
                    className={`scatter-regl-tool${axisEditorOpen || isAxisPinned ? ' active' : ''}`}
                    title={isAxisPinned ? 'Axis scale pinned — click to edit, click again to close' : 'Pin the X/Y axis to a fixed scale'}
                >
                    <Ruler size={13} />
                </button>
                <button
                    ref={tagButtonRef}
                    onClick={() => setScatterTagMode(m => !m)}
                    className={`scatter-regl-tool${scatterTagMode ? ' active' : ''}`}
                    title={scatterTagMode
                        ? 'Tag point — click a point to pin it, click a pinned point again to remove it'
                        : "Tag point — compare 2+ points' values side by side"}
                >
                    <Tag size={13} />
                </button>
                {scatterTags.length > 0 && (
                    <button
                        onClick={() => setScatterTags([])}
                        className="scatter-regl-tool"
                        title="Clear all tags"
                        aria-label="Clear all tags"
                    >
                        <Trash2 size={13} />
                    </button>
                )}
            </div>
            {/* Tag-mode hint, in the right-hand column under the toolbox. */}
            {scatterTagMode && (
                <div className="chart-tag-anchor">
                    <div className="scatter-regl-hint chart-tag-hint">
                        {tagTableHost === undefined
                            ? 'Click a point to tag it — its values are listed under the chart'
                            : 'Click a point to tag it — its values are listed in the Tagged points tab'}
                    </div>
                </div>
            )}

            {/* Axis-scale editor: pins X and/or Y to a fixed range. */}
            {axisEditorOpen && (
                <div className="scatter-regl-axis-editor">
                    <div className="scatter-regl-axis-editor-row">
                        <span className="scatter-regl-axis-editor-label">X</span>
                        <input
                            type="number"
                            placeholder="min"
                            value={draftXMin}
                            onChange={e => setDraftXMin(e.target.value)}
                            className="scatter-regl-axis-editor-input"
                        />
                        <span className="scatter-regl-axis-editor-label" style={{ width: 'auto' }}>–</span>
                        <input
                            type="number"
                            placeholder="max"
                            value={draftXMax}
                            onChange={e => setDraftXMax(e.target.value)}
                            className="scatter-regl-axis-editor-input"
                        />
                    </div>
                    <div className="scatter-regl-axis-editor-row">
                        <span className="scatter-regl-axis-editor-label">Y</span>
                        <input
                            type="number"
                            placeholder="min"
                            value={draftYMin}
                            onChange={e => setDraftYMin(e.target.value)}
                            className="scatter-regl-axis-editor-input"
                        />
                        <span className="scatter-regl-axis-editor-label" style={{ width: 'auto' }}>–</span>
                        <input
                            type="number"
                            placeholder="max"
                            value={draftYMax}
                            onChange={e => setDraftYMax(e.target.value)}
                            className="scatter-regl-axis-editor-input"
                        />
                    </div>
                    {axisEditorError && (
                        <span className="scatter-regl-axis-editor-error">{axisEditorError}</span>
                    )}
                    <div className="scatter-regl-axis-editor-actions">
                        <button onClick={applyAxisRange} className="scatter-regl-btn">Apply</button>
                        {isAxisPinned && (
                            <button onClick={clearAxisRange} className="scatter-regl-btn scatter-regl-btn-icon">Unpin</button>
                        )}
                    </div>
                </div>
            )}

            {/* WebGL canvas — only points, no axes. */}
            <div className="scatter-regl-canvas-wrap" style={{
                position: 'absolute',
                left: pad.left,
                top: pad.top,
                width: innerDims.width,
                height: innerDims.height,
            }}>
                {/* Highlight halo: non-interactive layer behind the main canvas; mounted only while a highlight is enabled. */}
                <canvas
                    ref={haloCanvasRef}
                    data-testid="scatter-halo-canvas"
                    style={{
                        display: 'block', position: 'absolute', inset: 0,
                        width: innerDims.width, height: innerDims.height,
                        pointerEvents: 'none', zIndex: 0,
                    }}
                />
                <canvas
                    ref={canvasRef}
                    data-testid="scatter-main-canvas"
                    style={{ display: 'block', position: 'absolute', inset: 0, width: innerDims.width, height: innerDims.height, zIndex: 1 }}
                />
                {/* Tooltip in canvas-local coordinates; pointerEvents none so it doesn't steal hover. */}
                {tooltip && (
                    <div className="scatter-regl-tooltip" style={{ left: tooltip.x, right: tooltip.right, top: tooltip.y, width: tooltip.hug ? 'max-content' : undefined }}>
                        {/* Inline label + value + unit. */}
                        <ValueRow info={sensorLookup(scatterX)} value={tooltip.xVal} distinct={tooltipEnds.get(scatterX)} />
                        <ValueRow info={sensorLookup(scatterY)} value={tooltip.yVal} distinct={tooltipEnds.get(scatterY)} />
                        {tooltip.timestamp && (
                            // The row's own time in the app's one date format ("2025/03/14 21:25:00").
                            <div className="scatter-regl-tooltip-ts">{formatDataStamp(tooltip.timestamp)}</div>
                        )}
                    </div>
                )}
                {/* Tag ring in the tag's colour, layered over range colouring; the colour ties it to its table column. */}
                {tagOverlays.map(t => (
                    <div key={t.id} className="scatter-tag-ring" style={{ left: t.x, top: t.y, borderColor: t.color }} />
                ))}
                {initError && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center', gap: 10,
                        background: 'var(--card-bg)', color: 'var(--text-primary)', textAlign: 'center',
                        padding: 16, zIndex: 5,
                    }}>
                        <span style={{ fontSize: 13, maxWidth: 340, lineHeight: 1.5 }}>
                            Scatter engine failed to start (WebGL unavailable).
                        </span>
                        <code style={{
                            fontSize: 11, maxWidth: 340, maxHeight: 80, overflow: 'auto',
                            color: 'var(--danger)', background: 'var(--input-bg)', padding: '6px 10px',
                            borderRadius: 6, wordBreak: 'break-word',
                        }}>
                            {initError}
                        </code>
                        <button
                            onClick={() => { setInitError(null); setRebuildNonce(n => n + 1); }}
                            style={{
                                padding: '4px 14px', fontSize: 12, cursor: 'pointer', borderRadius: 6,
                                border: '1px solid var(--border-strong)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                            }}
                        >
                            Retry
                        </button>
                    </div>
                )}
                {contextLost && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center', gap: 10,
                        background: 'var(--card-bg)', color: 'var(--text-primary)', textAlign: 'center',
                        padding: 16, zIndex: 5,
                    }}>
                        <span style={{ fontSize: 13, maxWidth: 300, lineHeight: 1.5 }}>
                            Rendering paused — the GPU dropped the canvas. Try filtering the data or showing fewer sensors.
                        </span>
                        <button
                            onClick={() => { setContextLost(false); setRebuildNonce(n => n + 1); }}
                            style={{
                                padding: '4px 14px', fontSize: 12, cursor: 'pointer', borderRadius: 6,
                                border: '1px solid var(--border-strong)', background: 'var(--input-bg)', color: 'var(--text-primary)',
                            }}
                        >
                            Retry
                        </button>
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
                <line x1={pad.left} y1={pad.top}
                      x2={pad.left} y2={pad.top + innerDims.height}
                      stroke="var(--border-strong, #475569)" />
                {yTicks.map((v, i, arr) => {
                    const y = pad.top + innerDims.height * (1 - i / (arr.length - 1));
                    return (
                        <g key={`y${i}`}>
                            <line x1={pad.left - 4} y1={y} x2={pad.left} y2={y} stroke="var(--text-secondary)" />
                            <text x={pad.left - 8} y={y + 3} textAnchor="end"
                                  fontSize="10" fill="var(--text-secondary)" fontFamily="Inter, system-ui">{fmt(v)}</text>
                        </g>
                    );
                })}

                <line x1={pad.left} y1={pad.top + innerDims.height}
                      x2={pad.left + innerDims.width} y2={pad.top + innerDims.height}
                      stroke="var(--border-strong, #475569)" />
                {xTicks.map((v, i, arr) => {
                    const x = pad.left + innerDims.width * (i / (arr.length - 1));
                    return (
                        <g key={`x${i}`}>
                            <line x1={x} y1={pad.top + innerDims.height}
                                  x2={x} y2={pad.top + innerDims.height + 4} stroke="var(--text-secondary)" />
                            <text x={x} y={pad.top + innerDims.height + 16} textAnchor="middle"
                                  fontSize="10" fill="var(--text-secondary)" fontFamily="Inter, system-ui">{fmt(v)}</text>
                        </g>
                    );
                })}

            </svg>

            {/* HTML overlay titles on two lines; Y is vertical-rl capped at plot height, a longer name may use the free column. */}
            <AxisTitle
                axis="x"
                fit={titleFit.x}
                info={sensorLookup(scatterX)}
                style={{
                    left: pad.left,
                    width: innerDims.width,
                    top: wrapperDims.height - X_TITLE.height - X_TITLE.bottom - (pad.bottom - AXIS_PADDING.bottom),
                    height: X_TITLE.height + (pad.bottom - AXIS_PADDING.bottom),
                }}
            />
            <AxisTitle
                axis="y"
                fit={titleFit.y}
                info={sensorLookup(scatterY)}
                style={{
                    ...Y_TITLE,
                    width: Y_TITLE.width + (pad.left - AXIS_PADDING.left),
                    ...(titleFit.y?.wrapped
                        ? { top: Y_TITLE_INSET, height: wrapperDims.height - 2 * Y_TITLE_INSET }
                        : { top: pad.top, height: innerDims.height, maxHeight: innerDims.height }),
                }}
            />
        </div>
        <TagTableSlot host={tagTableHost} items={tagListItems} rows={tagTableRows} onRemove={removeScatterTag} emptyFocusRef={tagButtonRef} />
        </div>
        </SensorMetaContext.Provider>
    );
}

export default memo(ScatterChart);
