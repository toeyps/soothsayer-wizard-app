import { useState, useEffect, useMemo, memo, useRef, useCallback } from 'react';
import createScatterplot from 'regl-scatterplot';
import { scaleLinear } from 'd3-scale';
import { RotateCcw, Ruler, X } from 'lucide-react';
import { ChartProps } from './ChartTypes';
import type { ScatterCriteriaRange } from '../../types';
import AxisLabel from './AxisLabel';
import { rgbaToHex } from './pairPlotColors';
import { reportError } from '../../errorReporter';
import { useCoalescedDraw } from '../../hooks/useCoalescedDraw';
import { useThemeMode } from '../../hooks/useThemeMode';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';

/** WebGL can't read CSS custom properties, so the canvas clear color is
 *  recomputed per theme here (dark slate-900 / light white, matching
 *  `--card-bg`). `pointColorHover` was pure white — invisible once the
 *  canvas itself goes light — so it's a fixed magenta instead of switching
 *  by theme: strong contrast against both a dark and a light background,
 *  no need to also react to `themeMode`. */
const CANVAS_BG: Record<ReturnType<typeof useThemeMode>, [number, number, number, number]> = {
    dark: [0.058, 0.094, 0.165, 1.0],
    light: [1.0, 1.0, 1.0, 1.0],
};
const POINT_COLOR_HOVER: [number, number, number, number] = [0.925, 0.282, 0.6, 1.0];

/** Base point colour when no criteria sensor is selected — the app's
 *  standard indigo accent at low alpha (density emerges via WebGL alpha
 *  blending). */
const BASE_POINT_COLOR: [number, number, number, number] = [0.39, 0.58, 0.98, 0.55];

/** Colour for a point that falls outside every enabled criteria range — very
 *  low alpha so it fades into the background instead of competing with the
 *  highlighted bands, while still giving the overall data shape as context. */
const CRITERIA_UNMATCHED_COLOR: [number, number, number, number] = [0.55, 0.6, 0.68, 0.12];

/** Distinct colours for criteria-sensor value ranges ("load bands") — same
 *  palette as PairPlotChart's CLUSTER_PALETTE for visual consistency across
 *  the app's two lasso/range-based colouring features. Cycles if the user
 *  adds more ranges than colours. */
const RANGE_PALETTE: Array<[number, number, number, number]> = [
    [0.99, 0.75, 0.18, 1.0],  // amber
    [0.20, 0.83, 0.60, 1.0],  // emerald
    [0.86, 0.40, 0.97, 1.0],  // fuchsia
    [0.99, 0.45, 0.45, 1.0],  // rose
    [0.40, 0.85, 0.99, 1.0],  // sky
    [0.99, 0.55, 0.27, 1.0],  // orange
    [0.65, 0.85, 0.40, 1.0],  // lime
    [0.78, 0.66, 0.99, 1.0],  // violet
];

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

function ScatterChart({
    data, sensors, headers, scatterX: persistedX, scatterY: persistedY, onScatterAxesChange,
    scatterAxisPins: persistedPins, onScatterAxisPinsChange,
    scatterCriteria: persistedCriteria, onScatterCriteriaChange, sensorMetadata,
}: ChartProps) {
    const themeMode = useThemeMode();
    const sensorMetaMap = useSensorMetaMap(sensorMetadata);
    const getDescription = useCallback(
        (tag: string) => sensorMetaMap.get(normalizeSensorTag(tag))?.description || undefined,
        [sensorMetaMap],
    );
    const wrapperRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    /** Scatter-point index → original CSV row index. `pointover` gives us a
     *  point index into the array we passed to `.draw()`; this maps back to
     *  the row inside `data[]` for the hover tooltip. */
    const origIndicesRef = useRef<number[]>([]);
    /** Last `sc` instance the data-push effect ran against. Lets that effect
     *  tell "sensors/pins changed on an existing instance" (should reset the
     *  camera) apart from "this instance was JUST created" (already at its
     *  default camera state — resetting it again is redundant, and was
     *  observed to crash: regl-scatterplot's internal camera setup isn't
     *  always synchronously ready right after construction, which rapid
     *  resize-driven recreates — e.g. dragging the window across monitors
     *  with different DPI — can hit). */
    const prevScForResetRef = useRef<any>(null);
    // Seeded from the persisted prop on mount — this component is fully
    // unmounted/remounted by Chart.tsx whenever chartType leaves 'scatter'
    // (LineChart/PairPlotChart/ScatterChart are mutually exclusive
    // branches), so without this the X/Y pair reset to the first two
    // sensors every time the user switched chart type and back.
    const [scatterX, setScatterX] = useState<string>(() => persistedX ?? '');
    const [scatterY, setScatterY] = useState<string>(() => persistedY ?? '');
    /** Optional 3rd sensor whose value ranges ("load bands") colour each
     *  point — e.g. speed 4000-5000 one colour, 5000-6000 another, so
     *  multiple operating bands can be compared spatially on the X/Y plot
     *  at once. Picking a sensor here only stages it; nothing is coloured
     *  until at least one enabled range exists (see criteriaRanges below).
     *  '' = off. Seeded from the persisted prop on mount — same unmount-
     *  survival reasoning as scatterX/scatterY above (regression: this used
     *  to be plain local state, so switching to Line/Pair Plot and back
     *  silently dropped the sensor + every range the user had set up). */
    const [criteriaSensor, setCriteriaSensor] = useState(() => persistedCriteria?.sensor ?? '');
    /** Real min/max of criteriaSensor's values in the currently-pushed
     *  points — shown as a hint next to the "add range" inputs so the user
     *  knows what bounds are actually meaningful to type. Deliberately NOT
     *  seeded from/persisted via `persistedCriteria` — it's re-derived from
     *  the live data the moment criteriaSensor settles below, so persisting
     *  it would just be a stale value flashing before that recompute. */
    const [criteriaRange, setCriteriaRange] = useState<{ min: number; max: number } | null>(null);
    /** User-defined value ranges for criteriaSensor. A point's colour comes
     *  from the FIRST enabled range its value falls inside (array order);
     *  a point matching no enabled range gets CRITERIA_UNMATCHED_COLOR.
     *  Seeded from the persisted prop — see criteriaSensor above. */
    const [criteriaRanges, setCriteriaRanges] = useState<ScatterCriteriaRange[]>(() => persistedCriteria?.ranges ?? []);
    const [draftRangeMin, setDraftRangeMin] = useState('');
    const [draftRangeMax, setDraftRangeMax] = useState('');
    const [rangeError, setRangeError] = useState<string | null>(null);
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
    /** Point index currently under the cursor — drives the floating tooltip.
     *  Cleared on `pointout`. */
    const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
    /** The regl-scatterplot instance kept in component state so the draw
     *  effect can react to its lifecycle (recreate on resize → redraw). */
    const [sc, setSc] = useState<any>(null);
    /** WebGL context-loss guard. If the GPU drops the context (e.g. too many
     *  points on a weak integrated GPU) the canvas goes black with NO error;
     *  we catch the event, show a recoverable overlay, and let the user
     *  rebuild via Retry (bumps `rebuildNonce` → the create effect re-runs). */
    const [contextLost, setContextLost] = useState(false);
    const [rebuildNonce, setRebuildNonce] = useState(0);
    /** WebGL init failure (context creation refused — GPU blocklist, remote
     *  desktop, CSP blocking regl's codegen, …). Unlike a mid-session context
     *  loss this happens synchronously inside createScatterplot(); without
     *  the guard the throw escapes the effect and unmounts the WHOLE app
     *  (the production black-screen). */
    const [initError, setInitError] = useState<string | null>(null);
    /** Serialized draw queue — regl-scatterplot silently drops a draw()
     *  issued while one is in flight, so back-to-back data/axis updates
     *  could leave the canvas showing stale points. */
    const { requestDraw, resetDraw } = useCoalescedDraw();

    /** Pinned X/Y axis bounds — like Line Plot's per-sensor Y-axis pin, but
     *  scoped to the axis ROLE (X vs Y) since Scatter only ever plots one
     *  X/Y pair at a time, not one series per selected sensor. Each pin
     *  records WHICH sensor it was set against; swapping the X (or Y)
     *  dropdown to a different sensor makes it inapplicable automatically
     *  (see effectiveXRange/effectiveYRange below) rather than via a
     *  follow-up effect, so there's no render where a stale scale from an
     *  unrelated sensor (e.g. a 0–100 pin from a temperature reused for a
     *  0–5000 pressure reading) briefly applies to the new one. Either side
     *  of either axis may be left unset to keep auto-fitting to the data.
     *
     *  Seeded from the persisted prop on mount — same reasoning as
     *  scatterX/scatterY above: this component unmounts/remounts on every
     *  chart-type switch, so without this the pin was lost the moment the
     *  user looked at Line or Pair Plot and came back. */
    const [xPin, setXPin] = useState<{ sensor: string; min?: number; max?: number } | null>(() => persistedPins?.x ?? null);
    const [yPin, setYPin] = useState<{ sensor: string; min?: number; max?: number } | null>(() => persistedPins?.y ?? null);
    const [axisEditorOpen, setAxisEditorOpen] = useState(false);
    const [draftXMin, setDraftXMin] = useState('');
    const [draftXMax, setDraftXMax] = useState('');
    const [draftYMin, setDraftYMin] = useState('');
    const [draftYMax, setDraftYMax] = useState('');
    const [axisEditorError, setAxisEditorError] = useState<string | null>(null);

    // Derived, not stateful — a pin only counts while its sensor is still
    // the one plotted on that axis. Computed inline during render (not a
    // useEffect reacting to scatterX/scatterY changes) so there is never a
    // frame where a stale pin from the previous sensor is still in effect.
    const effectiveXRange = xPin && xPin.sensor === scatterX ? xPin : undefined;
    const effectiveYRange = yPin && yPin.sensor === scatterY ? yPin : undefined;
    const isAxisPinned = !!effectiveXRange || !!effectiveYRange;

    // Keeps the draft fields in sync with whichever sensor is CURRENTLY on
    // each axis — both on open, and if the X/Y dropdown is swapped while the
    // editor is already open. Without the latter, Apply would pin the newly
    // selected sensor using text left over from the sensor that was showing
    // when the panel opened (e.g. silently overwriting an existing pin on
    // the new sensor with stale numbers that belonged to the old one).
    useEffect(() => {
        if (!axisEditorOpen) return;
        setDraftXMin(effectiveXRange?.min !== undefined ? String(effectiveXRange.min) : '');
        setDraftXMax(effectiveXRange?.max !== undefined ? String(effectiveXRange.max) : '');
        setDraftYMin(effectiveYRange?.min !== undefined ? String(effectiveYRange.min) : '');
        setDraftYMax(effectiveYRange?.max !== undefined ? String(effectiveYRange.max) : '');
        // effectiveXRange/effectiveYRange deliberately excluded: they only
        // change via applyAxisRange/clearAxisRange, which already close the
        // editor themselves, so re-deriving off scatterX/scatterY alone is
        // sufficient and avoids re-syncing (and clobbering active typing)
        // on every keystroke-driven state change elsewhere in the app.
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
        // isFinite (not isNaN) — parseFloat("1e400") overflows to Infinity,
        // which passes isNaN but would corrupt every normalised point into
        // NaN once it reaches the (x - lo) / range math below.
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

    // Default X/Y to the first two sensors, like the previous ECharts version.
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
            // Reset Y instead of pinning it to the only sensor: pinning left
            // Y === X after a 1 → 2 sensor transition (`includes` saw it as
            // valid), so the chart plotted the first column against itself
            // instead of using the newly added sensor. The <2-sensor guard
            // hides the chart while Y is unset, so '' is never visible.
            setScatterY('');
        }
    }, [sensors, scatterX, scatterY]);

    // Drop the criteria sensor (turn coloring off) if it's no longer among
    // the selected sensors — same reasoning as X/Y above, just with 'off'
    // as its valid "unset" state instead of falling back to a default.
    // Its ranges go with it — they're meaningless for a different sensor.
    useEffect(() => {
        if (criteriaSensor && !sensors.includes(criteriaSensor)) {
            setCriteriaSensor('');
            setCriteriaRanges([]);
        }
    }, [sensors, criteriaSensor]);

    const addCriteriaRange = () => {
        const min = parseFloat(draftRangeMin);
        const max = parseFloat(draftRangeMax);
        if (!isFinite(min) || !isFinite(max)) { setRangeError('Enter valid numbers'); return; }
        if (min >= max) { setRangeError('Min must be less than max'); return; }
        setCriteriaRanges(prev => [...prev, { id: `${Date.now()}-${prev.length}`, min, max, enabled: true }]);
        setDraftRangeMin('');
        setDraftRangeMax('');
        setRangeError(null);
    };

    const toggleCriteriaRange = (id: string) => {
        setCriteriaRanges(prev => prev.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
    };

    const removeCriteriaRange = (id: string) => {
        setCriteriaRanges(prev => prev.filter(r => r.id !== id));
    };

    // Push the settled X/Y pair up to the parent (Dashboard) so it survives
    // this component being unmounted — see the seeding comment above.
    useEffect(() => {
        if (scatterX && scatterY) onScatterAxesChange?.(scatterX, scatterY);
    }, [scatterX, scatterY, onScatterAxesChange]);

    // Push axis-pin changes up too, for the same unmount-survival reason.
    // Fires on every xPin/yPin change (apply or clear), including the
    // initial mount if a pin was seeded from `persistedPins` — that
    // re-send is a no-op for Dashboard (same value it already has).
    useEffect(() => {
        onScatterAxisPinsChange?.({ x: xPin ?? undefined, y: yPin ?? undefined });
    }, [xPin, yPin, onScatterAxisPinsChange]);

    // Push criteria-sensor changes up too, same unmount-survival reason —
    // fires on every sensor pick / range add / range toggle / range remove,
    // including the initial mount if seeded from `persistedCriteria` (a
    // no-op for Dashboard, same value it already has).
    useEffect(() => {
        onScatterCriteriaChange?.({ sensor: criteriaSensor, ranges: criteriaRanges });
    }, [criteriaSensor, criteriaRanges, onScatterCriteriaChange]);

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
        update(); // immediate on mount — no debounce delay for the initial layout
        // Debounced for every resize AFTER that: a split-pane drag fires many
        // rapid ResizeObserver callbacks, and each width/height change drives
        // a full WebGL context destroy+recreate below (shader compile + a
        // full point-buffer re-upload — real cost on a large scatter sample).
        // Waiting for the resize to pause briefly means that cost is paid
        // once at the end of a drag, not on every intermediate tick.
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

    // Create / destroy the regl-scatterplot instance whenever the canvas
    // size changes. Stored in state so the draw effect can react to its
    // lifecycle (recreate on resize → redraw).
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
                // canvas itself isn't square. Our x/y domains are both
                // normalized to [-1, 1] (equal ranges, genuinely square
                // data), so there's no meaningful shape to preserve; setting
                // this to the canvas's own ratio makes the plot fill the
                // whole chart area instead of leaving black bars on the sides.
                aspectRatio: innerDims.width / innerDims.height,
                pointSize: 3,
                pointColor: BASE_POINT_COLOR,
                pointColorHover: POINT_COLOR_HOVER,
                opacity: 0.6,
                backgroundColor: CANVAS_BG[themeMode],
            });
        } catch (err) {
            reportError('scatter-init', err);
            setInitError(err instanceof Error ? err.message : String(err));
            return;
        }
        setInitError(null);

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

        // WebGL context-loss recovery. Without `preventDefault` the browser
        // never fires `webglcontextrestored`, leaving a permanently black
        // canvas; we surface a Retry overlay instead of a silent black box.
        const canvas = canvasRef.current;
        const onContextLost = (e: Event) => { e.preventDefault(); setContextLost(true); };
        const onContextRestored = () => { setContextLost(false); };
        canvas.addEventListener('webglcontextlost', onContextLost as EventListener);
        canvas.addEventListener('webglcontextrestored', onContextRestored as EventListener);

        setSc(inst);

        return () => {
            canvas.removeEventListener('webglcontextlost', onContextLost as EventListener);
            canvas.removeEventListener('webglcontextrestored', onContextRestored as EventListener);
            // Clear the draw queue FIRST: a draw interrupted by destroy() may
            // never settle, which would leave the queue stuck busy.
            resetDraw();
            inst.destroy();
            setSc(null);
        };
        // `themeMode` is included so a theme toggle rebuilds the instance.
        // regl-scatterplot bakes `backgroundColor` into a WebGL color
        // texture at construction time — calling `.set({backgroundColor})`
        // on a live instance updates internal bookkeeping (lasso cursor
        // colors) but never rebuilds that texture, so the canvas keeps
        // showing its original background regardless of any later `.draw()`
        // call. Recreating is the only way that's been confirmed to work.
    }, [innerDims.width, innerDims.height, rebuildNonce, themeMode]);

    // Build points + normalise to [-1, 1] and push to the instance.
    // Runs whenever data / chosen sensors / the instance itself changes.
    useEffect(() => {
        if (!sc) return;
        const xIdx = headers.indexOf(scatterX);
        const yIdx = headers.indexOf(scatterY);
        if (xIdx < 0 || yIdx < 0) return;
        const zIdx = criteriaSensor ? headers.indexOf(criteriaSensor) : -1;

        const xs: number[] = [];
        const ys: number[] = [];
        const zs: (number | null)[] = [];
        const orig: number[] = [];
        // Defensive cap: the Dashboard already feeds a bounded sample, but if
        // this chart is ever handed raw data, stride it down so we never push
        // a GPU-unsafe point count (which would lose the WebGL context and
        // black the canvas). `orig` still records the true row index, so
        // the tooltip keeps mapping back correctly.
        const RENDER_CAP = 500_000;
        const step = data.length > RENDER_CAP ? Math.ceil(data.length / RENDER_CAP) : 1;
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        let zMin = Infinity, zMax = -Infinity;
        for (let i = 0; i < data.length; i += step) {
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
            // Criteria value travels alongside x/y on the SAME filtered row
            // set (so point count / orig-index mapping never depends on
            // whether a criteria sensor is picked) — a row missing/invalid
            // on the criteria sensor still plots, just uncoloured (matches
            // no range) rather than being dropped.
            if (zIdx >= 0) {
                const z = data[i].values[zIdx];
                if (z != null && typeof z === 'number' && !isNaN(z)) {
                    zs.push(z);
                    if (z < zMin) zMin = z;
                    if (z > zMax) zMax = z;
                } else {
                    zs.push(null);
                }
            }
        }

        // Pinned bounds win over the auto-computed data extent on whichever
        // side is set; the unset side keeps auto-fitting — same "partial
        // pin" semantics as Line Plot's per-sensor Y-axis pin.
        let xLo = effectiveXRange?.min !== undefined ? effectiveXRange.min : (isFinite(xMin) ? xMin : 0);
        let xHi = effectiveXRange?.max !== undefined ? effectiveXRange.max : (isFinite(xMax) ? xMax : 1);
        let yLo = effectiveYRange?.min !== undefined ? effectiveYRange.min : (isFinite(yMin) ? yMin : 0);
        let yHi = effectiveYRange?.max !== undefined ? effectiveYRange.max : (isFinite(yMax) ? yMax : 1);
        // A partial pin (only min or only max) can cross the auto-fitted
        // value on the OTHER side — e.g. pinning X min above the actual data
        // max — which would otherwise render a mirrored/inverted axis with
        // no warning. Canonicalize instead of validating at input time,
        // since the auto side isn't known until this render.
        if (xLo > xHi) { const t = xLo; xLo = xHi; xHi = t; }
        if (yLo > yHi) { const t = yLo; yLo = yHi; yHi = t; }
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

        // valueA is regl-scatterplot's discrete/categorical colour channel
        // (same one PairPlotCell uses for lasso clusters) — an integer index
        // into the pointColor palette. 0 = "no enabled range matched" (or no
        // criteria sensor at all); 1..N = the Nth enabled range, in the
        // order the user added them. Only the FIRST matching range wins for
        // a point whose value happens to fall in more than one (overlapping
        // ranges are the user's call, not an error).
        const enabledRanges = criteriaSensor ? criteriaRanges.filter(r => r.enabled) : [];
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
        setCriteriaRange(zIdx >= 0 && isFinite(zMin) && isFinite(zMax) ? { min: zMin, max: zMax } : null);

        origIndicesRef.current = orig;
        dataBoundsRef.current = { xLo, xHi, yLo, yHi };
        // Fresh data → reset the visible window to the full extent. The next
        // `view` event (after a zoom or pan) will narrow it again.
        setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });
        // Register d3 scales so the `view` event payload's xScale/yScale
        // expose the CURRENT visible domain in real data values. Without
        // this they stay `null` and the axis sync silently no-ops.
        // domain = real range; range = the normalised [-1, 1] coords we
        // actually pushed via draw(). The library mutates the scales as
        // the camera moves. set() is synchronous config, so it's safe to
        // apply before the (possibly queued) draw.
        sc.set({
            xScale: scaleLinear().domain([xLo, xHi]).range([-1, 1]),
            yScale: scaleLinear().domain([yLo, yHi]).range([-1, 1]),
            // Toggle criteria-range colouring on/off. pointColor doubles as
            // both "the flat colour" (colorBy: null) and "the category
            // palette, index 0 = unmatched" (colorBy: 'valueA') depending on
            // which mode is active — same dual-purpose option
            // regl-scatterplot itself specifies (and the same pattern
            // PairPlotCell uses for its lasso-cluster colours).
            colorBy: hasActiveRanges ? 'valueA' : null,
            pointColor: hasActiveRanges
                ? [CRITERIA_UNMATCHED_COLOR, ...enabledRanges.map((_, i) => RANGE_PALETTE[i % RANGE_PALETTE.length])]
                : BASE_POINT_COLOR,
        });
        // Without this, changing sensors or applying/editing a pin while
        // zoomed/panned left the camera showing whatever fraction of the
        // OLD [-1,1] mapping it was on — a region that means something
        // different under the NEW xScale/yScale — while visibleBounds below
        // claims the full (new) range is in view. Resetting the camera here
        // keeps what's actually on screen honest with the axis ticks — but
        // only when `sc` is the SAME instance as last run. A freshly
        // (re)created instance (this run triggered by `sc` itself changing,
        // e.g. after a resize) is already at its default camera state, so
        // resetting it again is both unnecessary and, per the crash this
        // guards against, unsafe.
        if (prevScForResetRef.current === sc) {
            sc.reset();
        }
        prevScForResetRef.current = sc;
        requestDraw(sc, valueAArr ? { x: xArr, y: yArr, valueA: valueAArr } : { x: xArr, y: yArr });
    }, [sc, data, scatterX, scatterY, headers, criteriaSensor, criteriaRanges, requestDraw, effectiveXRange, effectiveYRange]);

    const handleResetView = () => {
        sc?.reset();
        // `reset` snaps the camera back to the initial view, so the visible
        // window once again equals the full data extent. Update state right
        // away so the axes don't lag behind the `view` event.
        const { xLo, xHi, yLo, yHi } = dataBoundsRef.current;
        setVisibleBounds({ xMin: xLo, xMax: xHi, yMin: yLo, yMax: yHi });
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
                <span className="scatter-regl-vs">·</span>
                <select
                    value={criteriaSensor}
                    onChange={e => setCriteriaSensor(e.target.value)}
                    className="scatter-regl-select"
                    title="Colour points by a 3rd sensor's value (low→high gradient)"
                >
                    <option value="">Colour by…</option>
                    {sensors.map(s => <option key={s} value={s}>{s} (colour)</option>)}
                </select>
            </div>

            {/* Criteria-sensor range ("load band") manager — only shown once
                a 3rd sensor is picked. Points colour by whichever enabled
                range their value falls in, so several bands (e.g. two speed
                ranges) can be highlighted and compared at once; a value
                matching none of them fades to CRITERIA_UNMATCHED_COLOR. */}
            {criteriaSensor && (
                <div className="scatter-regl-criteria-legend" title={criteriaSensor}>
                    <span className="scatter-regl-criteria-legend-label">{criteriaSensor}</span>
                    {criteriaRange && (
                        <span className="scatter-regl-criteria-legend-value">
                            {fmt(criteriaRange.min)}–{fmt(criteriaRange.max)}
                        </span>
                    )}
                    {criteriaRanges.map((r, i) => (
                        <label key={r.id} className="scatter-regl-range-chip" title={r.enabled ? 'Click to hide this band' : 'Click to show this band'}>
                            <input type="checkbox" checked={r.enabled} onChange={() => toggleCriteriaRange(r.id)} />
                            <span
                                className="scatter-regl-range-chip-swatch"
                                style={{ background: rgbaToHex(RANGE_PALETTE[i % RANGE_PALETTE.length]) }}
                            />
                            <span>{fmt(r.min)}–{fmt(r.max)}</span>
                            <button
                                type="button"
                                onClick={() => removeCriteriaRange(r.id)}
                                className="scatter-regl-range-chip-remove"
                                title="Remove this range"
                            >
                                <X size={10} />
                            </button>
                        </label>
                    ))}
                    <input
                        type="number"
                        placeholder="min"
                        value={draftRangeMin}
                        onChange={e => { setDraftRangeMin(e.target.value); setRangeError(null); }}
                        className="scatter-regl-axis-editor-input"
                        style={{ width: 84 }}
                    />
                    <span>–</span>
                    <input
                        type="number"
                        placeholder="max"
                        value={draftRangeMax}
                        onChange={e => { setDraftRangeMax(e.target.value); setRangeError(null); }}
                        className="scatter-regl-axis-editor-input"
                        style={{ width: 84 }}
                    />
                    <button type="button" onClick={addCriteriaRange} className="scatter-regl-btn">+ Add</button>
                    {rangeError && <span className="scatter-regl-axis-editor-error">{rangeError}</span>}
                </div>
            )}

            {/* ECharts-style toolbox (click to activate). Pan/zoom is always
                on (the library's own default mouseMode) — no lasso-select
                tool anymore, so there's nothing to toggle it against. */}
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
            </div>

            {/* Axis-scale editor — pins X and/or Y to a fixed range instead of
                auto-fitting to the data extent. Toggled by the same Ruler icon,
                mirroring the Selected Sensor tab's pin-editor UX. */}
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
                {initError && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center', gap: 10,
                        background: 'rgba(15,23,42,0.95)', color: '#e2e8f0', textAlign: 'center',
                        padding: 16, zIndex: 5,
                    }}>
                        <span style={{ fontSize: 13, maxWidth: 340, lineHeight: 1.5 }}>
                            Scatter engine failed to start (WebGL unavailable).
                        </span>
                        <code style={{
                            fontSize: 11, maxWidth: 340, maxHeight: 80, overflow: 'auto',
                            color: '#fca5a5', background: '#0f172a', padding: '6px 10px',
                            borderRadius: 6, wordBreak: 'break-word',
                        }}>
                            {initError}
                        </code>
                        <button
                            onClick={() => { setInitError(null); setRebuildNonce(n => n + 1); }}
                            style={{
                                padding: '4px 14px', fontSize: 12, cursor: 'pointer', borderRadius: 6,
                                border: '1px solid #475569', background: '#1e293b', color: '#e2e8f0',
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
                        background: 'rgba(15,23,42,0.88)', color: '#e2e8f0', textAlign: 'center',
                        padding: 16, zIndex: 5,
                    }}>
                        <span style={{ fontSize: 13, maxWidth: 300, lineHeight: 1.5 }}>
                            Rendering paused — the GPU dropped the canvas. Try filtering the data or showing fewer sensors.
                        </span>
                        <button
                            onClick={() => { setContextLost(false); setRebuildNonce(n => n + 1); }}
                            style={{
                                padding: '4px 14px', fontSize: 12, cursor: 'pointer', borderRadius: 6,
                                border: '1px solid #475569', background: '#1e293b', color: '#e2e8f0',
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
                {/* Y axis line */}
                <line x1={AXIS_PADDING.left} y1={AXIS_PADDING.top}
                      x2={AXIS_PADDING.left} y2={AXIS_PADDING.top + innerDims.height}
                      stroke="var(--border-strong, #475569)" />
                {yTicks.map((v, i, arr) => {
                    const y = AXIS_PADDING.top + innerDims.height * (1 - i / (arr.length - 1));
                    return (
                        <g key={`y${i}`}>
                            <line x1={AXIS_PADDING.left - 4} y1={y} x2={AXIS_PADDING.left} y2={y} stroke="var(--text-secondary)" />
                            <text x={AXIS_PADDING.left - 8} y={y + 3} textAnchor="end"
                                  fontSize="10" fill="var(--text-secondary)" fontFamily="Inter, system-ui">{fmt(v)}</text>
                        </g>
                    );
                })}

                {/* X axis line */}
                <line x1={AXIS_PADDING.left} y1={AXIS_PADDING.top + innerDims.height}
                      x2={AXIS_PADDING.left + innerDims.width} y2={AXIS_PADDING.top + innerDims.height}
                      stroke="var(--border-strong, #475569)" />
                {xTicks.map((v, i, arr) => {
                    const x = AXIS_PADDING.left + innerDims.width * (i / (arr.length - 1));
                    return (
                        <g key={`x${i}`}>
                            <line x1={x} y1={AXIS_PADDING.top + innerDims.height}
                                  x2={x} y2={AXIS_PADDING.top + innerDims.height + 4} stroke="var(--text-secondary)" />
                            <text x={x} y={AXIS_PADDING.top + innerDims.height + 16} textAnchor="middle"
                                  fontSize="10" fill="var(--text-secondary)" fontFamily="Inter, system-ui">{fmt(v)}</text>
                        </g>
                    );
                })}

            </svg>

            {/* Axis titles — HTML overlays (not SVG text) so they can carry a
                hover tooltip with the sensor's description, same pattern as
                PairPlotChart's AxisLabel. tooltipSide points back INTO the
                chart area on both axes so it never hangs off the wrap's edge. */}
            <AxisLabel
                tag={scatterX}
                description={getDescription(scatterX)}
                tooltipSide="top"
                style={{ left: AXIS_PADDING.left, width: innerDims.width, top: wrapperDims.height - 20, height: 18 }}
            />
            <AxisLabel
                tag={scatterY}
                description={getDescription(scatterY)}
                rotate
                style={{ left: 0, width: 24, top: AXIS_PADDING.top, height: innerDims.height }}
            />
        </div>
    );
}

export default memo(ScatterChart);
