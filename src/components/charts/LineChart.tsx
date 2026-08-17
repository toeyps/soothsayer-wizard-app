import { useMemo, memo, useRef, useState, useEffect, useCallback } from 'react';
import { Tag, Trash2 } from 'lucide-react';
import ResponsiveECharts from './ResponsiveECharts';
import { ChartProps } from './ChartTypes';
import { formatDate, formatDateTime } from '../../utils/dateFormat';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { hexToRgbaCss, rgbaToHex, RANGE_PALETTE, TAG_BADGES, MAX_TAGGED_POINTS } from './pairPlotColors';
import type { LineTaggedPoint } from '../../types';

/** Index into `xData` (a category axis of timestamp strings) whose parsed
 *  time is closest to `targetMs` — ECharts' category axis needs an actual
 *  axis value (or index) for markArea boundaries, not an arbitrary
 *  timestamp, so a highlight's start/end snap to the nearest plotted point.
 *  Linear scan is fine here: xData is capped at a few thousand points
 *  (LINE_MAX_POINTS backend-side) and this only runs per highlight, not per
 *  render frame. */
function nearestXIndex(xData: (string | null)[], targetMs: number): number {
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < xData.length; i++) {
        const raw = xData[i];
        const t = raw == null ? NaN : new Date(raw).getTime();
        if (isNaN(t)) continue;
        const diff = Math.abs(t - targetMs);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
}

/**
 * Collapses a (possibly overlapping) list of highlighted index ranges into a
 * flat, non-overlapping run of `{min, max, color}` pieces — one entry per
 * contiguous stretch of x-axis indices that all resolve to the same colour.
 * Indices covered by no highlight are simply omitted from the result.
 *
 * Used to build the 'line' display mode's highlight overlay: one extra,
 * thicker line series per (sensor, piece) pair, drawn on top of that
 * sensor's normal line — see the overlay-building code below for why a
 * bolder second layer reads better than recolouring the base line in place
 * (a same-width colour swap was too easy to miss against a busy chart).
 *
 * Resolves overlaps itself rather than depending on undocumented tie-break
 * behaviour elsewhere — `ranges` is walked in array order and the FIRST
 * range covering a given index wins, matching the "first enabled highlight
 * wins" convention already used for ScatterChart's halo layer.
 */
export function buildLineColorPieces(
    dataCount: number,
    ranges: { startIdx: number; endIdx: number; color: string }[],
): { min: number; max: number; color: string }[] {
    const pieces: { min: number; max: number; color: string }[] = [];
    if (dataCount === 0 || ranges.length === 0) return pieces;

    const colorAt = (i: number): string | null => {
        for (const r of ranges) {
            if (i >= r.startIdx && i <= r.endIdx) return r.color;
        }
        return null;
    };

    let runStart = 0;
    let runColor = colorAt(0);
    for (let i = 1; i < dataCount; i++) {
        const c = colorAt(i);
        if (c !== runColor) {
            if (runColor !== null) pieces.push({ min: runStart, max: i - 1, color: runColor });
            runStart = i;
            runColor = c;
        }
    }
    if (runColor !== null) pieces.push({ min: runStart, max: dataCount - 1, color: runColor });
    return pieces;
}

// Exported so callers (e.g. the "Selected Sensor" color-swatch picker) can
// show/default to the same palette a sensor would get without an override.
export const LINE_CHART_COLORS = ["#3b82f6", "#10b981", "#6366f1", "#8b5cf6", "#f43f5e", "#f59e0b"];

/**
 * Deterministic default color for a sensor, keyed by its tag rather than its
 * position in whatever array happens to be rendering it. Also exported so
 * the "Selected Sensor" tab's color swatch always shows the same default the
 * chart itself would use.
 *
 * This exists because `sensors[index % colors.length]` silently disagreed
 * between callers: the chart only ever sees the currently-VISIBLE subset
 * (`displayHeaders`), while the Selected Sensor tab iterates the full
 * selection — hiding one sensor shifted every later sensor's index in the
 * chart but not in the tab, so an unrelated sensor's swatch stopped matching
 * its actual line color. Hashing the tag itself removes the shared "index"
 * both sides would otherwise need to agree on.
 */
export function defaultSensorColor(sensor: string, palette: string[] = LINE_CHART_COLORS): string {
    let hash = 0;
    for (let i = 0; i < sensor.length; i++) {
        hash = (hash * 31 + sensor.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
}

function LineChart({
    data, columnar, sensors, headers, markLines, hideYSplitLine, sensorColors, sensorAxisRange,
    sensorMetadata, timeHighlights, highlightDisplay,
    lineTaggedPoints: persistedTaggedPoints, onLineTaggedPointsChange,
}: ChartProps) {
    // Track container height so the grid/slider/legend scale with it.
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [containerH, setContainerH] = useState<number>(0);

    // Unit lookup for the hover tooltip — covers both mapping-CSV sensors
    // and runtime "special" (calculated) sensors, since Dashboard.tsx merges
    // both into the same `sensorMetadata` array before it reaches here.
    const sensorMetaMap = useSensorMetaMap(sensorMetadata);

    // Tag Point — pin 2+ points on the chart to compare their values.
    // Seeded from the persisted prop on mount, same reasoning as
    // scatterAxisPins/criteriaSensor elsewhere in this codebase: Chart.tsx
    // fully unmounts LineChart when chartType leaves 'line', so without this
    // every tag would vanish the moment the user looked at Scatter/Pair Plot
    // and came back.
    const [taggedPoints, setTaggedPoints] = useState<LineTaggedPoint[]>(() => persistedTaggedPoints ?? []);
    const [tagMode, setTagMode] = useState(false);
    const [chartInstance, setChartInstance] = useState<any>(null);
    const handleChartReady = useCallback((instance: any) => setChartInstance(instance), []);

    useEffect(() => {
        onLineTaggedPointsChange?.(taggedPoints);
    }, [taggedPoints, onLineTaggedPointsChange]);

    // xData is needed both by the option builder below and by the click
    // handler (to resolve a clicked pixel back to a timestamp) — computed
    // once here so neither has to duplicate or re-derive it.
    const xData = useMemo(
        () => (columnar ? columnar.timestamps : data.map(d => d.timestamp)),
        [columnar, data],
    );
    // Refs so the zr click listener (attached once per chart instance, see
    // below) always reads the CURRENT tagMode/xData instead of whatever was
    // in scope when the listener was attached — avoids re-attaching the
    // listener on every keystroke-unrelated render.
    const tagModeRef = useRef(tagMode);
    useEffect(() => { tagModeRef.current = tagMode; }, [tagMode]);
    const xDataRef = useRef(xData);
    useEffect(() => { xDataRef.current = xData; }, [xData]);

    // Click-to-tag: attached at the zrender (canvas) level, not via
    // ResponsiveECharts' onEvents, because the large-data rendering profile
    // sets `silent: true` on the line series to skip per-pixel hit-testing
    // (see isLargeData below) — an ECharts-level series click would simply
    // never fire on exactly the data this feature is most useful for. A
    // zrender click fires for any click on the canvas regardless of what's
    // under it; convertFromPixel resolves it back to the nearest x-axis
    // index ourselves, the same way containPixel/convertFromPixel are
    // documented to be used together for this exact "click anywhere on the
    // chart" pattern.
    //
    // Clicking an already-tagged point removes it (toggle), instead of a
    // separate "click the badge" gesture — a badge is a tiny, precise
    // target to hit inside a markPoint's rendered symbol, while re-clicking
    // the same spot on the chart is exactly as easy as tagging it was.
    useEffect(() => {
        if (!chartInstance) return;
        const zr = chartInstance.getZr?.();
        if (!zr) return;
        const handleZrClick = (event: any) => {
            if (!tagModeRef.current) return;
            const xd = xDataRef.current;
            if (xd.length === 0) return;
            const pixel = [event.offsetX, event.offsetY];
            if (!chartInstance.containPixel({ gridIndex: 0 }, pixel)) return;
            const rawIdx = chartInstance.convertFromPixel({ xAxisIndex: 0 }, pixel);
            if (rawIdx == null || !isFinite(rawIdx)) return;
            const idx = Math.max(0, Math.min(xd.length - 1, Math.round(rawIdx)));
            const timestamp = xd[idx];
            if (timestamp == null) return;
            setTaggedPoints(prev => {
                const existing = prev.find(t => {
                    const ms = new Date(t.timestamp).getTime();
                    return !isNaN(ms) && nearestXIndex(xd, ms) === idx;
                });
                if (existing) return prev.filter(t => t.id !== existing.id);
                if (prev.length >= MAX_TAGGED_POINTS) return prev;
                return [...prev, {
                    id: `tag-${Date.now()}-${prev.length}`,
                    timestamp: timestamp as string,
                    color: rgbaToHex(RANGE_PALETTE[prev.length % RANGE_PALETTE.length]),
                }];
            });
        };
        zr.on('click', handleZrClick);
        return () => { zr.off('click', handleZrClick); };
    }, [chartInstance]);

    useEffect(() => {
        const el = wrapperRef.current;
        if (!el) return;
        // Quantize to 8px steps + rAF-coalesce: every containerH change
        // rebuilds the whole option (and setOption(notMerge) re-inits the
        // chart), so per-pixel updates while dragging the Split.js divider
        // meant a full chart teardown per pixel. 8px granularity is invisible
        // in the layout math but cuts rebuilds ~8×.
        let raf: number | null = null;
        const update = () => {
            raf = null;
            setContainerH(Math.round(el.clientHeight / 8) * 8);
        };
        update();
        const ro = new ResizeObserver(() => {
            if (raf !== null) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(update);
        });
        ro.observe(el);
        return () => {
            ro.disconnect();
            if (raf !== null) cancelAnimationFrame(raf);
        };
    }, []);

    // Track current theme (data-theme attribute on <html>) so text colors adapt.
    const [theme, setTheme] = useState<'dark' | 'light'>(() =>
        (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark'
    );
    useEffect(() => {
        const obs = new MutationObserver(() => {
            const t = document.documentElement.getAttribute('data-theme');
            setTheme(t === 'light' ? 'light' : 'dark');
        });
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => obs.disconnect();
    }, []);
    const isLight = theme === 'light';
    const txtPrimary  = isLight ? '#0f172a' : '#f1f5f9';
    const txtSecondary = isLight ? '#475569' : '#94a3b8';
    const gridLine    = isLight ? '#cbd5e1' : '#334155';
    const markLabelBg = isLight ? 'rgba(248,250,252,0.9)' : 'rgba(15,23,42,0.82)';
    const tooltipBg   = isLight ? 'rgba(248,250,252,0.96)' : 'rgba(30,41,59,0.9)';
    const tooltipBorder = isLight ? '#cbd5e1' : '#334155';

    const option = useMemo(() => {
        // xData is computed once above (shared with the click handler) —
        // columnar feed (from Rust's `get_chart_data`) is preferred there
        // too: arrays drop straight into ECharts with no per-row mapping.
        const dataCount = xData.length;
        // Threshold for the "heavy" rendering profile (no smoothing / no
        // animation / hairline stroke / LTTB). The columnar dashboard feed is
        // capped at 4 000 rows backend-side, so the old 10 000 cutoff never
        // fired there — every refetch replayed a ~1 s entrance animation and
        // stroked catmull-rom splines across every series, which is exactly
        // the interaction jank on big datasets. Above ~2 000 points a smooth
        // spline is visually identical to straight segments anyway (<1 px per
        // segment), so the pretty profile is reserved for genuinely small data.
        const isLargeData = dataCount > 2000;

        // Time highlights ("Highlights" tab's "By time" group) — snapped to
        // the nearest plotted index once, shared by both display modes
        // below. Category axis needs an actual axis value/index for a
        // markArea boundary (or an overlay-series data slice), not an
        // arbitrary timestamp, so each highlight's start/end snap to the
        // nearest plotted point. Kept in the user's own creation order — the
        // "first enabled highlight wins" convention (see
        // `buildLineColorPieces`) needs that order preserved.
        const highlightIndexRanges = dataCount > 0
            ? (timeHighlights ?? [])
                .filter(h => h.enabled)
                .map(h => {
                    const s = new Date(h.start).getTime();
                    const e = new Date(h.end).getTime();
                    if (isNaN(s) || isNaN(e)) return null;
                    return {
                        startIdx: nearestXIndex(xData, Math.min(s, e)),
                        endIdx: nearestXIndex(xData, Math.max(s, e)),
                        color: h.color,
                        label: h.label,
                    };
                })
                .filter((v): v is NonNullable<typeof v> => v !== null)
            : [];

        // 'band' (the default): a tinted background rectangle — a distinct
        // ECharts mechanism from the horizontal markLine used for alarm
        // setpoints above/below. Attached to the first series only:
        // markArea renders across the shared grid regardless of which
        // series owns it, so adding it to every series would just draw the
        // same bands N times over.
        const highlightAreas = highlightDisplay !== 'line'
            ? highlightIndexRanges.map(r => [
                {
                    xAxis: r.startIdx,
                    itemStyle: { color: hexToRgbaCss(r.color, 0.16) },
                    label: {
                        show: true,
                        formatter: r.label,
                        position: 'insideTop' as const,
                        color: r.color,
                        fontSize: 10,
                        fontWeight: 600,
                        fontFamily: 'JetBrains Mono, monospace',
                    },
                },
                { xAxis: r.endIdx },
            ])
            : [];

        // 'line': emphasise each highlighted window with a second, bolder
        // line drawn on top of the trace, instead of a background band. The
        // base series is untouched — same colour and width across its whole
        // range — and `linePieces` (below) drives one extra overlay series
        // per (sensor, piece), built alongside `series` further down.
        const linePieces = highlightDisplay === 'line'
            ? buildLineColorPieces(dataCount, highlightIndexRanges)
            : [];

        // ── Dynamic horizontal padding ────────────────────────────
        const AXIS_OFFSET = 60;
        const AXIS_BASE_PAD = 40;
        const leftCount = Math.ceil(sensors.length / 2);
        const rightCount = Math.floor(sensors.length / 2);
        const gridLeft = AXIS_BASE_PAD + Math.max(0, leftCount - 1) * AXIS_OFFSET;
        const gridRight = AXIS_BASE_PAD + Math.max(0, rightCount - 1) * AXIS_OFFSET;

        // ── Dynamic vertical layout (pixel values, clamped to container) ──
        // Ideal full-size reservations:
        const SLIDER_H = 20;
        const X_AXIS_LABEL_H = 24;
        const GAP_ABOVE_SLIDER = 8;
        const GAP_ABOVE_XAXIS = 6;
        const idealBottom = SLIDER_H + GAP_ABOVE_SLIDER + X_AXIS_LABEL_H + GAP_ABOVE_XAXIS;

        // Clamp bottom reservation to at most 45% of the container so the
        // plotting area is never squeezed to zero (or negative) when the
        // panel is small.
        const h = containerH > 0 ? containerH : 400;
        const maxBottom = Math.max(60, Math.floor(h * 0.45));
        const scale = Math.min(1, maxBottom / idealBottom);

        const sliderH = Math.max(12, Math.round(SLIDER_H * scale));
        const gapSlider = Math.round(GAP_ABOVE_SLIDER * scale);
        const gapXAxis = Math.round(GAP_ABOVE_XAXIS * scale);
        const xAxisLabelH = Math.round(X_AXIS_LABEL_H * scale);

        const sliderBottom = 0;
        const gridBottom = sliderBottom + sliderH + gapSlider + xAxisLabelH + gapXAxis;
        const gridTop = Math.max(20, Math.round(30 * scale));

        // `scale: true` only auto-fits the Y axis to each series' own data
        // points — it does NOT account for markLine reference values (this is
        // an ECharts limitation, not a bug in how we call it: markLine data
        // lives outside the axis's own extent calculation). A checked alarm
        // setpoint far outside the sensor's actual data range (e.g. a "high"
        // setpoint of 90 when the trace only ever reaches 80) would silently
        // draw the line off-screen with no visible sign it exists. Only
        // step in when a markLine value actually falls outside the data's
        // own range — untouched sensors, and markLines already comfortably
        // inside the trace, keep ECharts' own auto-fit exactly as before.
        const seriesMinMax = (sensor: string): { min: number; max: number } | null => {
            const sensorIdx = headers.indexOf(sensor);
            if (sensorIdx < 0) return null;
            const values = columnar ? columnar.series[sensorIdx] : data.map(d => d.values[sensorIdx]);
            let min = Infinity, max = -Infinity;
            for (const v of values) {
                if (v === null || v === undefined || Number.isNaN(v)) continue;
                if (v < min) min = v;
                if (v > max) max = v;
            }
            return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
        };

        // Tag Point markers — one per tagged point, attached to the first
        // series only (same "only the first series carries it" convention
        // as markArea above, for the same reason: this draws across the
        // shared grid regardless of which series owns it, so attaching it
        // to every series would just draw it N times over). Each entry's
        // `coord` anchors the marker to series[0]'s own value at that
        // index; the label lists every visible sensor's value (not just
        // series[0]'s) plus a Δ line vs the first tag, for every tag after
        // the first.
        const valuesFor = (sensor: string): (number | null)[] => {
            const sensorIdx = headers.indexOf(sensor);
            return columnar ? (columnar.series[sensorIdx] ?? []) : data.map(d => d.values[sensorIdx] ?? null);
        };
        const taggedMarkPointData = dataCount > 0
            ? taggedPoints
                .map((tag, order) => {
                    const tagMs = new Date(tag.timestamp).getTime();
                    if (isNaN(tagMs)) return null;
                    const idx = nearestXIndex(xData, tagMs);
                    const perSensor = sensors.map(sensor => ({ sensor, value: valuesFor(sensor)[idx] ?? null }));
                    const anchorValue = perSensor[0]?.value;
                    // series[0] missing at this exact index (e.g. a NaN row) —
                    // nothing to anchor the marker to; skip rather than plot
                    // at a fabricated y value.
                    if (anchorValue == null) return null;
                    const badge = TAG_BADGES[order % TAG_BADGES.length];
                    const lines = [`${badge}  ${formatDateTime(new Date(xData[idx] ?? ''))}`];
                    perSensor.forEach(({ sensor, value }) => {
                        const unit = sensorMetaMap.get(normalizeSensorTag(sensor))?.unit;
                        lines.push(`${sensor}: ${value == null ? '—' : value.toFixed(3)}${unit ? ` ${unit}` : ''}`);
                    });
                    if (order > 0) {
                        const baseTag = taggedPoints[0];
                        const baseMs = new Date(baseTag.timestamp).getTime();
                        const baseIdx = isNaN(baseMs) ? -1 : nearestXIndex(xData, baseMs);
                        if (baseIdx >= 0) {
                            const deltaParts = sensors
                                .map(sensor => {
                                    const values = valuesFor(sensor);
                                    const v = values[idx];
                                    const baseV = values[baseIdx];
                                    if (v == null || baseV == null) return null;
                                    const delta = v - baseV;
                                    return `${sensor}: ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`;
                                })
                                .filter((v): v is string => v !== null);
                            if (deltaParts.length > 0) lines.push(`Δ vs ${TAG_BADGES[0]}: ${deltaParts.join(', ')}`);
                        }
                    }
                    return {
                        coord: [idx, anchorValue],
                        itemStyle: { color: tag.color, borderColor: markLabelBg, borderWidth: 2 },
                        label: { formatter: lines.join('\n') },
                    };
                })
                .filter((v): v is NonNullable<typeof v> => v !== null)
            : [];

        const baseSeries = sensors.map((sensor, index) => {
            const sensorIdx = headers.indexOf(sensor);
            const color = sensorColors?.[sensor] ?? defaultSensorColor(sensor);
            const sensorMarks = (markLines ?? []).filter(m => m.sensor === sensor);
            const markLine = sensorMarks.length > 0
                ? {
                    symbol: 'none',
                    silent: false,
                    animation: false,
                    label: {
                        show: true,
                        formatter: (p: any) => p.data?.name ?? '',
                        position: 'insideEndTop' as const,
                        color: txtPrimary,
                        fontSize: 10,
                        fontWeight: 600,
                        fontFamily: 'JetBrains Mono, monospace',
                        backgroundColor: markLabelBg,
                        padding: [2, 5],
                        borderRadius: 3,
                    },
                    data: sensorMarks.map(m => ({
                        name: m.label,
                        yAxis: m.y,
                        lineStyle: {
                            color: m.color ?? color,
                            type: m.lineStyle ?? 'solid',
                            width: m.width ?? 1,
                        },
                        // Per-entry override merges with the shared
                        // `markLine.label` above — without this every
                        // label in the group would render in the same
                        // `txtPrimary` regardless of that line's own color.
                        label: { color: m.color ?? txtPrimary },
                    })),
                }
                : undefined;
            const rawValues = columnar
                ? (columnar.series[sensorIdx] ?? [])
                : data.map(d => d.values[sensorIdx] ?? null);
            return {
                name: sensor,
                type: 'line',
                yAxisIndex: index,
                data: rawValues,
                smooth: !isLargeData,
                showSymbol: false,
                itemStyle: { color: color },
                // Hairline strokes for dense data: cheaper to rasterize
                // and the trace reads better when segments are sub-pixel.
                lineStyle: { width: isLargeData ? 0.8 : 2 },
                // The axis-trigger tooltip doesn't need the polylines to
                // be mouse-interactive, but ECharts still hit-tests every
                // vertex-dense line on each mousemove and runs emphasis
                // state transitions on hover. Cut both for heavy data —
                // markLine hover/labels (small-data screens) keep working.
                silent: isLargeData,
                emphasis: { disabled: isLargeData },
                // Hovering a legend entry otherwise re-renders the linked
                // series into its highlight state — pure cost, low value.
                legendHoverLink: false,
                // Belt-and-suspenders for the row-based path: when a
                // caller still feeds raw points past the threshold, let
                // ECharts LTTB-downsample instead of rasterizing every
                // vertex.
                ...(isLargeData ? { sampling: 'lttb' as const } : {}),
                ...(markLine ? { markLine } : {}),
                // Only the first series carries markArea — see
                // highlightAreas' own comment above for why attaching it
                // to every series would be redundant.
                ...(index === 0 && highlightAreas.length > 0
                    ? { markArea: { silent: true, data: highlightAreas } }
                    : {}),
                // Tag Point markers — same "first series only" convention.
                // `silent: true`: clicks are handled entirely by the
                // zrender-level handler above (click the same spot again to
                // untag), not by markPoint's own hit-testing — keeping it
                // silent avoids ECharts layering its own hover/tooltip
                // behaviour on top of that.
                ...(index === 0 && taggedMarkPointData.length > 0
                    ? {
                        markPoint: {
                            silent: true,
                            animation: false,
                            symbol: 'circle',
                            symbolSize: 12,
                            data: taggedMarkPointData,
                            label: {
                                show: true,
                                position: 'top' as const,
                                color: txtPrimary,
                                backgroundColor: markLabelBg,
                                borderColor: tooltipBorder,
                                borderWidth: 1,
                                borderRadius: 6,
                                padding: [6, 8],
                                fontSize: 10,
                                fontFamily: 'JetBrains Mono, monospace',
                                lineHeight: 15,
                                align: 'left' as const,
                            },
                        },
                    }
                    : {}),
            };
        });

        // 'line' display mode: one extra, bolder line per (sensor, piece) —
        // drawn on top of that sensor's own (untouched) base line above, so
        // the highlighted stretch reads as "the same trace, but thicker and
        // in the highlight's colour" rather than a same-width colour swap
        // that's easy to miss on a busy multi-sensor chart. `null` outside
        // its own [min, max] leaves the rest of the line simply not drawn
        // by this series — the always-continuous base line underneath is
        // what the eye follows there.
        const highlightOverlaySeries = linePieces.length > 0
            ? sensors.flatMap((sensor, index) => {
                const sensorIdx = headers.indexOf(sensor);
                const rawValues = columnar
                    ? (columnar.series[sensorIdx] ?? [])
                    : data.map(d => d.values[sensorIdx] ?? null);
                return linePieces.map(piece => ({
                    name: sensor,
                    type: 'line',
                    yAxisIndex: index,
                    data: rawValues.map((v, i) => (i >= piece.min && i <= piece.max ? v : null)),
                    smooth: !isLargeData,
                    showSymbol: false,
                    silent: true,
                    // Excluded from the axis-trigger tooltip — without this
                    // every hover inside a highlighted window would show the
                    // same sensor twice (once from this overlay, once from
                    // its base series).
                    tooltip: { show: false },
                    legendHoverLink: false,
                    animation: false,
                    // Above the base lines (default z) so the emphasis
                    // stroke is never hidden behind a neighbouring sensor's
                    // trace.
                    z: 5,
                    itemStyle: { color: piece.color },
                    // A FIXED emphasis width, not a multiple of the base
                    // line's own width — the large-data profile's hairline
                    // stroke is only 0.8px, and doubling that to 1.6px reads
                    // as no different from the base line at a glance
                    // (confirmed live: barely visible on a real ~4 000-point
                    // aggregated chart). This has to be thick enough to read
                    // as "emphasised" regardless of how thin the base trace
                    // currently is.
                    lineStyle: { color: piece.color, width: 4 },
                }));
            })
            : [];

        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
            tooltip: {
                trigger: 'axis',
                backgroundColor: tooltipBg,
                borderColor: tooltipBorder,
                textStyle: { color: txtPrimary },
                // Kill the pointer-chasing animations: by default the tooltip
                // box eases toward the cursor and the axis crosshair animates
                // per mousemove, keeping a redraw loop alive the whole time
                // the user hovers the chart.
                transitionDuration: 0,
                axisPointer: { animation: false },
                // Tooltip is display-only here — not letting the pointer
                // enter it skips the enter/leave tracking ECharts otherwise
                // does on every move near the box.
                enterable: false,
                hideDelay: 0,
                formatter: (params: any) => {
                    if (!params || (Array.isArray(params) && params.length === 0)) return '';
                    const rawList = Array.isArray(params) ? params : [params];
                    // 'line' display mode's highlight overlay series (see the
                    // series-building code above) share their sensor's own
                    // `name` and can report the exact same value, at the
                    // exact same index, as their base series. Per-series
                    // `tooltip.show: false` is documented for item-trigger
                    // tooltips but isn't confirmed to exclude a series from
                    // *axis*-trigger aggregation too (a matching upstream
                    // feature request, unresolved as of writing:
                    // https://github.com/apache/echarts/issues/15924) — don't
                    // depend on it. Dedupe defensively instead, keeping the
                    // FIRST entry per sensor name (the base series always
                    // sorts first: `series: [...baseSeries,
                    // ...highlightOverlaySeries]`), so a hover inside a
                    // highlighted window can never show one sensor twice
                    // regardless of which way that ECharts behavior goes.
                    const seenNames = new Set<string>();
                    const pList = rawList.filter((p: any) => {
                        if (seenNames.has(p.seriesName)) return false;
                        seenNames.add(p.seriesName);
                        return true;
                    });
                    const dateStr = formatDateTime(new Date(pList[0].axisValueLabel));
                    let content = `<div style="font-weight:bold; margin-bottom:5px;">${dateStr}</div>`;
                    const maxItems = 10;
                    pList.slice(0, maxItems).forEach((p: any) => {
                        // Aggregated values (Avg etc.) are raw floating-point
                        // divisions with no rounding applied upstream — fix
                        // the tooltip display to 3 decimals regardless of
                        // sensor or aggregation method.
                        const displayValue = typeof p.value === 'number' ? p.value.toFixed(3) : p.value;
                        // Unit from master data — covers both mapping-CSV
                        // sensors and runtime "special" (calculated) ones,
                        // since Dashboard.tsx merges both before this prop
                        // reaches the chart. Absent unit → omit, not "undefined".
                        const unit = sensorMetaMap.get(normalizeSensorTag(p.seriesName))?.unit;
                        content += `<div style="display:flex; align-items:center; gap:5px;">
                            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background-color:${p.color};"></span>
                            <span>${p.seriesName}: ${displayValue}${unit ? ` ${unit}` : ''}</span>
                        </div>`;
                    });
                    return content;
                }
            },
            grid: {
                left: gridLeft,
                right: gridRight,
                top: gridTop,
                bottom: gridBottom,
                containLabel: false,
            },
            // Entrance/update transitions only for small data — and even then
            // fast ones. The dashboard refetches on every (debounced) filter
            // edit, so a slow default 1 s animation replays constantly.
            animation: !isLargeData,
            animationDuration: 250,
            animationDurationUpdate: 150,
            dataZoom: [
                { type: 'inside', xAxisIndex: [0], filterMode: 'filter' },
                {
                    type: 'slider', xAxisIndex: [0], filterMode: 'filter',
                    bottom: sliderBottom, height: sliderH,
                    // Heavy-data mode: the slider's mini preview (data shadow)
                    // re-renders every series into the track on each data
                    // change, and realtime dragging re-filters + re-lays-out
                    // all series and axes on every mousemove of the handle.
                    // Drop both above the threshold — the window then applies
                    // on release, which keeps the drag itself at 60 fps.
                    showDataShadow: !isLargeData,
                    realtime: !isLargeData,
                }
            ],
            xAxis: {
                type: 'category',
                boundaryGap: false,
                data: xData,
                axisLabel: { formatter: (val: string) => formatDate(new Date(val)), color: txtSecondary },
                axisLine: { lineStyle: { color: gridLine } }
            },
            yAxis: sensors.map((sensor, index) => {
                const color = sensorColors?.[sensor] ?? defaultSensorColor(sensor);
                const fixedRange = sensorAxisRange?.[sensor];
                let autoMin = fixedRange?.min;
                let autoMax = fixedRange?.max;
                const sensorMarkYs = (markLines ?? []).filter(m => m.sensor === sensor).map(m => m.y);
                if (sensorMarkYs.length > 0) {
                    const dataRange = seriesMinMax(sensor);
                    const naturalMin = dataRange?.min ?? Math.min(...sensorMarkYs);
                    const naturalMax = dataRange?.max ?? Math.max(...sensorMarkYs);
                    const neededMin = Math.min(naturalMin, ...sensorMarkYs);
                    const neededMax = Math.max(naturalMax, ...sensorMarkYs);
                    // Only step in when a setpoint actually falls outside the
                    // trace's own range — otherwise leave scale:true's normal
                    // auto-fit alone.
                    if (neededMin < naturalMin || neededMax > naturalMax) {
                        const span = (neededMax - neededMin) || 1;
                        const pad = span * 0.08;
                        if (autoMin === undefined) autoMin = neededMin - pad;
                        if (autoMax === undefined) autoMax = neededMax + pad;
                    }
                }
                return {
                    type: 'value',
                    // No axis `name` — the sensor label already lives in the
                    // legend below the chart; showing it a second time above
                    // the axis was redundant clutter.
                    // `scale: true` lets ECharts auto-fit the Y range to the
                    // actual data instead of forcing the axis to include 0.
                    // Time-series with a non-zero baseline (e.g. a sensor
                    // that hovers around 50–80) reads much better this way,
                    // and the ±1σ / ±3σ markLines stay close to the trace.
                    // A user-pinned min/max (sensorAxisRange) overrides this on
                    // whichever side is actually set — `scale: true` stays on
                    // as the baseline so a pinned-min-only (or max-only) sensor
                    // still auto-fits its other side instead of defaulting to
                    // "always include zero". `autoMin`/`autoMax` additionally
                    // widen that baseline (see `seriesMinMax` above) whenever
                    // an active markLine would otherwise land off-screen.
                    scale: true,
                    ...(autoMin !== undefined ? { min: autoMin } : {}),
                    ...(autoMax !== undefined ? { max: autoMax } : {}),
                    position: index % 2 === 0 ? 'left' : 'right',
                    offset: Math.floor(index / 2) * 60,
                    axisLine: { show: true, lineStyle: { color: color } },
                    axisLabel: { color: color },
                    splitLine: { show: !hideYSplitLine && index === 0, lineStyle: { color: gridLine, type: 'dashed', opacity: 0.3 } }
                };
            }),
            series: [...baseSeries, ...highlightOverlaySeries],
        };
    }, [data, columnar, sensors, headers, containerH, markLines, hideYSplitLine, theme, sensorColors, sensorAxisRange, sensorMetaMap, timeHighlights, highlightDisplay, xData, taggedPoints]);

    return (
        <div ref={wrapperRef} style={{ width: '100%', height: '100%', minHeight: 0, position: 'relative' }}>
            {/* lazyUpdate batches consecutive setOption calls into one frame
                (resize + data + theme changes coalesce instead of each
                triggering its own full notMerge re-init). */}
            <ResponsiveECharts option={option} lazyUpdate style={{ minHeight: '200px' }} onChartReady={handleChartReady} />
            <div className="line-chart-toolbox">
                <button
                    type="button"
                    onClick={() => setTagMode(m => !m)}
                    className={`line-chart-tool${tagMode ? ' active' : ''}`}
                    title={tagMode
                        ? 'Tag point — click the chart to pin a point, click a pinned point again to remove it'
                        : 'Tag point — compare 2+ points\' values side by side'}
                >
                    <Tag size={13} />
                </button>
                {taggedPoints.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setTaggedPoints([])}
                        className="line-chart-tool"
                        title="Clear all tags"
                    >
                        <Trash2 size={13} />
                    </button>
                )}
            </div>
            {tagMode && (
                <div style={{
                    position: 'absolute', top: 12, left: 44, pointerEvents: 'none',
                    fontSize: 10, fontStyle: 'italic', color: txtSecondary,
                }}>
                    Click the chart to tag a point — click a tag again to remove it
                </div>
            )}
        </div>
    );
}

export default memo(LineChart);
