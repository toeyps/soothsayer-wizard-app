import { useMemo, memo, useRef, useState, useEffect, useCallback } from 'react';
import { Tag, Trash2, Search, ZoomIn, ZoomOut } from 'lucide-react';
import ResponsiveECharts from './ResponsiveECharts';
import { ChartProps } from './ChartTypes';
import { formatAxisTick, formatDateTime } from '../../utils/dateFormat';
import { fmtNum, sensorInlineHtml, useLayeredSensorLookup } from '../sensor/sensorInfo';
import { tooltipDistinctEnds } from '../../utils/tooltipLayout';
import { hexToRgbaCss, rgbaToHex, RANGE_PALETTE, TAG_BADGES, MAX_TAGGED_POINTS } from './pairPlotColors';
import type { LineTaggedPoint } from '../../types';
import { firstFreeColorIndex, sortTagsByTime } from './TaggedPointList';
import { TagTableSlot, tagCell, type TagCompareRow } from './TagCompareTable';

/** Epoch ms of an `xData` entry, or `null` if missing/unparseable; a time-axis point needs its own x. */
function toMs(raw: string | null): number | null {
    if (raw == null) return null;
    const t = new Date(raw).getTime();
    return isNaN(t) ? null : t;
}

/** Index in `xData` nearest `targetMs`; linear scan is fine (few thousand points, only per click). */
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

/** Index of the `xMs` entry nearest `targetMs`: binary search if complete and ascending, else scan. -1 if none usable. */
export function nearestMsIndex(xMs: (number | null)[], sorted: boolean, targetMs: number): number {
    if (xMs.length === 0 || !isFinite(targetMs)) return -1;
    if (sorted) {
        let lo = 0;
        let hi = xMs.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if ((xMs[mid] as number) < targetMs) lo = mid + 1;
            else hi = mid;
        }
        return lo > 0 && targetMs - (xMs[lo - 1] as number) <= (xMs[lo] as number) - targetMs ? lo - 1 : lo;
    }
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < xMs.length; i++) {
        const t = xMs[i];
        if (t == null) continue;
        const diff = Math.abs(t - targetMs);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
}

// Order keeps every prefix distinguishable; near-duplicate hues sit at the tail (used from 9+ sensors).
export const LINE_CHART_COLORS = [
    "#3b82f6", // blue
    "#10b981", // emerald
    "#f43f5e", // rose
    "#f59e0b", // amber
    "#8b5cf6", // violet
    "#06b6d4", // cyan
    "#84cc16", // lime
    "#d946ef", // fuchsia
    "#f97316", // orange
    "#14b8a6", // teal (near emerald/cyan)
    "#6366f1", // indigo (near blue/violet)
    "#ec4899", // pink (near rose)
];

/** Default colour keyed by tag, not index, so the chart and the Selected Sensor tab agree when sensors are hidden. */
export function defaultSensorColor(sensor: string, palette: string[] = LINE_CHART_COLORS): string {
    let hash = 0;
    for (let i = 0; i < sensor.length; i++) {
        hash = (hash * 31 + sensor.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
}


function LineChart({
    data, columnar, sensors, headers, markLines, hideYSplitLine, sensorColors, sensorAxisRange,
    sensorMetadata, timeHighlights,
    lineTaggedPoints: persistedTaggedPoints, onLineTaggedPointsChange,
    tagTableHost, onTagCountChange,
}: ChartProps) {
    // Track container height so the grid/slider/legend scale with it.
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [containerH, setContainerH] = useState<number>(0);

    // Label and unit lookup for the tooltip and tag boxes; covers mapping-CSV and special sensors.
    const sensorLookup = useLayeredSensorLookup(sensorMetadata);

    // Seeded from the persisted prop: Chart.tsx unmounts LineChart when chartType leaves 'line'.
    const [taggedPoints, setTaggedPoints] = useState<LineTaggedPoint[]>(() => persistedTaggedPoints ?? []);
    const [tagMode, setTagMode] = useState(false);
    const [chartInstance, setChartInstance] = useState<any>(null);
    const handleChartReady = useCallback((instance: any) => setChartInstance(instance), []);

    // `zoomSelectMode` is one-shot: the next drag zooms, then it turns off.
    const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
    const [zoomSelectMode, setZoomSelectMode] = useState(false);
    // Drag-in-progress visual feedback (pixel-space, relative to the
    // wrapper) — `null` outside of an active drag.
    const [dragPixels, setDragPixels] = useState<[number, number] | null>(null);
    const zoomMenuRef = useRef<HTMLDivElement>(null);

    // Zoom and Tag Point both read canvas clicks/drags, so entering one turns the other off.
    const enterZoomSelectMode = useCallback(() => {
        setTagMode(false);
        setZoomSelectMode(true);
        setZoomMenuOpen(false);
    }, []);
    const toggleTagMode = useCallback(() => {
        setZoomSelectMode(false);
        setTagMode(m => !m);
    }, []);

    // Closes the zoom dropdown on an outside click.
    useEffect(() => {
        if (!zoomMenuOpen) return;
        const onDocClick = (e: MouseEvent) => {
            if (zoomMenuRef.current && !zoomMenuRef.current.contains(e.target as Node)) {
                setZoomMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, [zoomMenuOpen]);

    useEffect(() => {
        onLineTaggedPointsChange?.(taggedPoints);
    }, [taggedPoints, onLineTaggedPointsChange]);

    // Reports the tagged-point count to the parent; 0 when this chart unmounts.
    const tagCountRef = useRef(taggedPoints.length);
    const onTagCountChangeRef = useRef(onTagCountChange);
    onTagCountChangeRef.current = onTagCountChange;
    useEffect(() => {
        const n = taggedPoints.length;
        onTagCountChangeRef.current?.(n, n > tagCountRef.current);
        tagCountRef.current = n;
    }, [taggedPoints.length]);
    useEffect(() => () => { onTagCountChangeRef.current?.(0, false); }, []);

    // Shared by the option builder and the click handler (pixel to timestamp).
    const xData = useMemo(
        () => (columnar ? columnar.timestamps : data.map(d => d.timestamp)),
        [columnar, data],
    );

    // Identifies the data shown: a new span resets to full view, else the zoom is kept (rebuilt options reset dataZoom to 0-100).
    const rangeId = xData.length > 0 ? `${xData[0]}|${xData[xData.length - 1]}|${xData.length}` : 'empty';
    const prevRangeIdRef = useRef(rangeId);
    const rangeChanged = rangeId !== prevRangeIdRef.current;
    const zoomWindowRef = useRef<Record<string, number> | null>(null);
    useEffect(() => {
        if (prevRangeIdRef.current !== rangeId) zoomWindowRef.current = null;
        prevRangeIdRef.current = rangeId;
    });
    useEffect(() => {
        if (!chartInstance?.on) return;
        const onDataZoom = (event: any) => {
            // Inside zoom and pan report under `batch`, the Horizontal Zoom action at the top level.
            const z = event?.batch?.[0] ?? event;
            zoomWindowRef.current = z?.startValue != null
                ? { startValue: z.startValue, endValue: z.endValue }
                : { start: z?.start, end: z?.end };
        };
        chartInstance.on('datazoom', onDataZoom);
        return () => chartInstance.off?.('datazoom', onDataZoom);
    }, [chartInstance]);

    // Refs so the once-attached zr click listener reads the current tagMode/xData.
    const tagModeRef = useRef(tagMode);
    useEffect(() => { tagModeRef.current = tagMode; }, [tagMode]);
    const xDataRef = useRef(xData);
    useEffect(() => { xDataRef.current = xData; }, [xData]);
    const zoomSelectModeRef = useRef(zoomSelectMode);
    useEffect(() => { zoomSelectModeRef.current = zoomSelectMode; }, [zoomSelectMode]);

    // On zrender, not ECharts events: large data is `silent`, so series clicks never fire. Clicking a tagged point removes it.
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
            // Use `{ seriesIndex: 0 }`; `{ xAxisIndex: 0 }` returns NaN here. Gives the axis value (ms).
            const converted = chartInstance.convertFromPixel({ seriesIndex: 0 }, pixel);
            const targetMs = Array.isArray(converted) ? converted[0] : converted;
            if (targetMs == null || !isFinite(targetMs)) return;
            const idx = nearestXIndex(xd, targetMs);
            const timestamp = xd[idx];
            if (timestamp == null) return;
            setTaggedPoints(prev => {
                const existing = prev.find(t => {
                    const ms = new Date(t.timestamp).getTime();
                    return !isNaN(ms) && nearestXIndex(xd, ms) === idx;
                });
                if (existing) return prev.filter(t => t.id !== existing.id);
                if (prev.length >= MAX_TAGGED_POINTS) return prev;
                const used = prev.map(t => RANGE_PALETTE.findIndex(c => rgbaToHex(c) === t.color));
                const colorIdx = firstFreeColorIndex(used, RANGE_PALETTE.length);
                return [...prev, {
                    id: `tag-${Date.now()}-${prev.length}`,
                    timestamp: timestamp as string,
                    color: rgbaToHex(RANGE_PALETTE[colorIdx]),
                }];
            });
        };
        zr.on('click', handleZrClick);
        return () => { zr.off('click', handleZrClick); };
    }, [chartInstance]);

    // Drag to select an x-range, release to zoom. On zrender because large data is `silent`.
    useEffect(() => {
        if (!chartInstance) return;
        const zr = chartInstance.getZr?.();
        if (!zr) return;
        let dragStartPixel: number | null = null;

        const handleMouseDown = (event: any) => {
            if (!zoomSelectModeRef.current) return;
            const pixel = [event.offsetX, event.offsetY];
            if (!chartInstance.containPixel({ gridIndex: 0 }, pixel)) return;
            dragStartPixel = event.offsetX;
            setDragPixels([event.offsetX, event.offsetX]);
        };
        const handleMouseMove = (event: any) => {
            if (dragStartPixel == null) return;
            setDragPixels([dragStartPixel, event.offsetX]);
        };
        const handleMouseUp = (event: any) => {
            if (dragStartPixel == null) return;
            const startPixel = dragStartPixel;
            const endPixel = event.offsetX;
            dragStartPixel = null;
            setDragPixels(null);
            // Ignore drags under 4px: accidental click.
            if (Math.abs(endPixel - startPixel) < 4) return;
            // Finder is `{ seriesIndex: 0 }`: `{ xAxisIndex: 0 }` returns NaN here.
            const p1 = chartInstance.convertFromPixel({ seriesIndex: 0 }, [startPixel, event.offsetY]);
            const p2 = chartInstance.convertFromPixel({ seriesIndex: 0 }, [endPixel, event.offsetY]);
            const v1 = Array.isArray(p1) ? p1[0] : p1;
            const v2 = Array.isArray(p2) ? p2[0] : p2;
            if (v1 == null || v2 == null || !isFinite(v1) || !isFinite(v2)) return;
            chartInstance.dispatchAction({
                type: 'dataZoom',
                startValue: Math.min(v1, v2),
                endValue: Math.max(v1, v2),
            });
            // One-shot: back to the normal pointer after a single drag.
            setZoomSelectMode(false);
        };

        zr.on('mousedown', handleMouseDown);
        zr.on('mousemove', handleMouseMove);
        zr.on('mouseup', handleMouseUp);
        return () => {
            zr.off('mousedown', handleMouseDown);
            zr.off('mousemove', handleMouseMove);
            zr.off('mouseup', handleMouseUp);
        };
    }, [chartInstance]);

    // Removes one tag; the others keep their colours. Focus target when the last tag is removed (list unmounts).
    const tagButtonRef = useRef<HTMLButtonElement>(null);
    const removeTag = useCallback((id: string) => {
        setTaggedPoints(prev => prev.filter(t => t.id !== id));
    }, []);
    // Labels snap to the nearest plotted point like the marker (a refetch may drop the stored timestamp); falls back to the stored text.
    const tagsByTime = useMemo(() => sortTagsByTime(taggedPoints, tag => new Date(tag.timestamp).getTime()), [taggedPoints]);
    const tagListItems = useMemo(() => tagsByTime.map((tag, order) => {
        const tagMs = new Date(tag.timestamp).getTime();
        let resolved: string = tag.timestamp;
        if (!isNaN(tagMs) && xData.length > 0) {
            resolved = xData[nearestXIndex(xData, tagMs)] ?? tag.timestamp;
        }
        const d = new Date(resolved);
        return {
            id: tag.id,
            badge: TAG_BADGES[order % TAG_BADGES.length],
            color: tag.color,
            label: isNaN(d.getTime()) ? tag.timestamp : formatDateTime(d),
        };
    }), [tagsByTime, xData]);

    // One row per shown sensor, one value per tag, read at the same nearest point as the marker.
    const tagTableRows = useMemo<TagCompareRow[]>(() => {
        if (tagsByTime.length === 0) return [];
        const idxOf = tagsByTime.map(tag => {
            const ms = new Date(tag.timestamp).getTime();
            return isNaN(ms) || xData.length === 0 ? -1 : nearestXIndex(xData, ms);
        });
        return sensors.map(sensor => {
            const sensorIdx = headers.indexOf(sensor);
            const info = sensorLookup(sensor);
            const at = (i: number): number | null => {
                if (i < 0 || sensorIdx < 0) return null;
                const v = columnar ? columnar.series[sensorIdx]?.[i] : data[i]?.values[sensorIdx];
                return typeof v === 'number' && Number.isFinite(v) ? v : null;
            };
            return {
                key: sensor,
                info,
                color: sensorColors?.[sensor] ?? defaultSensorColor(sensor),
                cells: idxOf.map(i => { const v = at(i); return tagCell(v == null ? null : fmtNum(v, true)); }),
            };
        });
    }, [tagsByTime, xData, sensors, headers, columnar, data, sensorLookup, sensorColors]);

    const zoomOut = useCallback(() => {
        chartInstance?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
        setZoomMenuOpen(false);
    }, [chartInstance]);

    useEffect(() => {
        const el = wrapperRef.current;
        if (!el) return;
        // Quantize to 8px and rAF-coalesce: each containerH change rebuilds the option, so per-pixel drag would rebuild per pixel.
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

    // Canvas can't read CSS variables; these literals mirror the App.css tokens and must be kept in sync by hand.
    const txtPrimary  = '#ededef';
    const txtSecondary = '#8c8c94';
    const gridLine    = '#2a2a30';
    const markLabelBg = 'rgba(23, 23, 28, 0.85)';
    const tooltipBg   = 'rgba(23, 23, 28, 0.92)';
    const tooltipBorder = 'rgba(255, 255, 255, 0.12)';

    const option = useMemo(() => {
        const dataCount = xData.length;
        // Heavy profile (no smoothing/animation, hairline, sampling) above 2000 points; splines look the same as straight segments there.
        const isLargeData = dataCount > 2000;

        // Highlight bounds snap to the nearest plotted index so a band starts and ends on a drawn point; user's creation order.
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

        // Bands are markArea on the first series only (it spans the shared grid; more series would repeat it). Time axis takes ms values.
        const highlightAreas = highlightIndexRanges.map(r => [
            {
                xAxis: toMs(xData[r.startIdx]),
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
            { xAxis: toMs(xData[r.endIdx]) },
        ]);

        const AXIS_OFFSET = 60;
        const AXIS_BASE_PAD = 40;
        const leftCount = Math.ceil(sensors.length / 2);
        const rightCount = Math.floor(sensors.length / 2);
        const gridLeft = AXIS_BASE_PAD + Math.max(0, leftCount - 1) * AXIS_OFFSET;
        const gridRight = AXIS_BASE_PAD + Math.max(0, rightCount - 1) * AXIS_OFFSET;

        // Vertical reservations in px; no slider, zoom is the toolbox tool.
        const X_AXIS_LABEL_H = 24;
        const GAP_ABOVE_XAXIS = 6;
        const idealBottom = X_AXIS_LABEL_H + GAP_ABOVE_XAXIS;

        // Cap the bottom reservation at 45% of the container so the plot never collapses.
        const h = containerH > 0 ? containerH : 400;
        const maxBottom = Math.max(60, Math.floor(h * 0.45));
        const scale = Math.min(1, maxBottom / idealBottom);

        const gapXAxis = Math.round(GAP_ABOVE_XAXIS * scale);
        const xAxisLabelH = Math.round(X_AXIS_LABEL_H * scale);

        const gridBottom = xAxisLabelH + gapXAxis;
        const gridTop = Math.max(20, Math.round(30 * scale));

        // `scale: true` ignores markLine values, so an alarm setpoint outside the data range would draw off-screen; widen only then.
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

        // Tag markers on the first series only (spans the shared grid): a dot and dashed line in the tag colour; values are in the table.
        const valuesFor = (sensor: string): (number | null)[] => {
            const sensorIdx = headers.indexOf(sensor);
            return columnar ? (columnar.series[sensorIdx] ?? []) : data.map(d => d.values[sensorIdx] ?? null);
        };
        const taggedMarkPointData = dataCount > 0
            ? taggedPoints
                .map(tag => {
                    const tagMs = new Date(tag.timestamp).getTime();
                    if (isNaN(tagMs)) return null;
                    const idx = nearestXIndex(xData, tagMs);
                    const anchorValue = sensors.length > 0 ? valuesFor(sensors[0])[idx] ?? null : null;
                    // Skip when series[0] has no value here; don't plot at a made-up y.
                    if (anchorValue == null) return null;
                    return {
                        coord: [toMs(xData[idx]), anchorValue],
                        itemStyle: { color: tag.color, borderColor: markLabelBg, borderWidth: 2 },
                    };
                })
                .filter((v): v is NonNullable<typeof v> => v !== null)
            : [];

        const tagLineData = dataCount > 0
            ? taggedPoints
                .map(tag => {
                    const tagMs = new Date(tag.timestamp).getTime();
                    if (isNaN(tagMs)) return null;
                    const ms = toMs(xData[nearestXIndex(xData, tagMs)]);
                    if (ms == null) return null;
                    return { xAxis: ms, lineStyle: { color: tag.color, type: 'dashed' as const, width: 1, opacity: 0.75 }, label: { show: false } };
                })
                .filter((v): v is NonNullable<typeof v> => v !== null)
            : [];

        const baseSeries = sensors.map((sensor, index) => {
            const sensorIdx = headers.indexOf(sensor);
            const color = sensorColors?.[sensor] ?? defaultSensorColor(sensor);
            const sensorMarks = (markLines ?? []).filter(m => m.sensor === sensor);
            const thresholdLine = sensorMarks.length > 0
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
                        // Per-entry label colour; otherwise every label would use `txtPrimary`.
                        label: { color: m.color ?? txtPrimary },
                    })),
                }
                : undefined;
            // The tag lines ride on the first series (same convention as markArea / markPoint).
            const tagLines = index === 0 ? tagLineData : [];
            const markLine = thresholdLine && tagLines.length > 0
                ? { ...thresholdLine, data: [...thresholdLine.data, ...tagLines] }
                : thresholdLine
                    ?? (tagLines.length > 0
                        ? { symbol: 'none', silent: true, animation: false, label: { show: false }, data: tagLines }
                        : undefined);
            const rawValues = columnar
                ? (columnar.series[sensorIdx] ?? [])
                : data.map(d => d.values[sensorIdx] ?? null);
            // Time axis: each point carries its own x value.
            const pairedData = rawValues.map((v, i) => [toMs(xData[i]), v]);
            return {
                name: sensor,
                type: 'line',
                yAxisIndex: index,
                data: pairedData,
                smooth: !isLargeData,
                showSymbol: false,
                itemStyle: { color: color },
                // Hairline strokes for dense data: cheaper to rasterize
                // and the trace reads better when segments are sub-pixel.
                lineStyle: { width: isLargeData ? 0.8 : 2 },
                // On large data skip hit-testing and hover states; markLines stay hoverable on small data.
                silent: isLargeData,
                // No hover emphasis at any size: repainting the series on every move is not worth the dot.
                emphasis: { disabled: true },
                // Hovering a legend entry otherwise re-renders the linked
                // series into its highlight state — pure cost, low value.
                legendHoverLink: false,
                // `minmax`, not `lttb`: ECharts 6.1 lttb mixes zoom-window and full-series indexes once a null is present. Keeps time order and spikes.
                ...(isLargeData ? { sampling: 'minmax' as const } : {}),
                ...(markLine ? { markLine } : {}),
                // Only the first series carries markArea; see highlightAreas.
                ...(index === 0 && highlightAreas.length > 0
                    ? { markArea: { silent: true, data: highlightAreas } }
                    : {}),
                // `silent`: clicks are handled by the zrender handler above; avoids ECharts hover/tooltip on top.
                ...(index === 0 && taggedMarkPointData.length > 0
                    ? {
                        markPoint: {
                            silent: true,
                            animation: false,
                            symbol: 'circle',
                            symbolSize: 13,
                            data: taggedMarkPointData,
                            label: { show: false },
                        },
                    }
                    : {}),
            };
        });

        // Tooltip reads every shown sensor's value at the hovered time: `params` omits series without a point at exactly that time.
        const xMs = xData.map(toMs);
        const xSorted = xMs.every((t, i) => t != null && (i === 0 || t >= (xMs[i - 1] as number)));
        const tipSeries = sensors.map(sensor => {
            const sensorIdx = headers.indexOf(sensor);
            return {
                sensor,
                color: sensorColors?.[sensor] ?? defaultSensorColor(sensor),
                values: columnar ? (columnar.series[sensorIdx] ?? []) : data.map(d => d.values[sensorIdx] ?? null),
            };
        });

        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
            // Crosshair on its own canvas layer (zlevel 1), no hover emphasis: otherwise each mousemove repaints every series.
            axisPointer: { zlevel: 1, triggerEmphasis: false },
            tooltip: {
                trigger: 'axis',
                backgroundColor: tooltipBg,
                borderColor: tooltipBorder,
                textStyle: { color: txtPrimary },
                // Disable tooltip and crosshair animation so no redraw loop runs while hovering.
                transitionDuration: 0,
                axisPointer: { animation: false },
                // Not enterable: skips ECharts' enter/leave tracking.
                enterable: false,
                hideDelay: 0,
                // `confine` keeps a tall box inside the chart; from `body` the card can't clip it. Only a box past the chart moves.
                confine: true,
                appendTo: () => document.body,
                formatter: (params: any) => {
                    if (!params || (Array.isArray(params) && params.length === 0)) return '';
                    const pList = Array.isArray(params) ? params : [params];
                    // Use `axisValue` (raw ms); `axisValueLabel` is a display string `new Date()` can't parse.
                    const dateStr = formatDateTime(new Date(pList[0].axisValue));
                    let content = `<div class="tt-head">${dateStr}</div>`;
                    const maxItems = 10;
                    const at = nearestMsIndex(xMs, xSorted, Number(pList[0].axisValue));
                    const shown = tipSeries.slice(0, maxItems);
                    const ends = tooltipDistinctEnds(shown.map(t => sensorLookup(t.sensor)));
                    shown.forEach(({ sensor, color, values }) => {
                        const rawValue = at >= 0 ? values[at] : null;
                        // Aggregated values are unrounded, so show 3 decimals with separators. A sensor with no value keeps its row as '—'.
                        const hasValue = typeof rawValue === 'number' && !isNaN(rawValue);
                        const displayValue = hasValue ? fmtNum(rawValue, true) : '—';
                        // Label left, value + unit right in the series colour; unit comes from master data, omitted if absent.
                        const info = sensorLookup(sensor);
                        content += sensorInlineHtml(info, color, `${displayValue}${hasValue && info.unit ? ` ${info.unit}` : ''}`, ends.get(info.tag));
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
            // Animate only small data, and fast: refetches on every debounced filter edit would replay a slow default.
            animation: !isLargeData,
            animationDuration: 250,
            animationDurationUpdate: 150,
            // Invisible 'inside' dataZoom only: wheel zoom and drag-to-pan; explicit zoom is the toolbox tool.
            dataZoom: [
                {
                    type: 'inside', xAxisIndex: [0], filterMode: 'filter',
                    // Not `disabled: zoomSelectMode`: the mouseup `dispatchAction` is a silent no-op while its target is disabled.
                    // Full view when `rangeId` changed, else the user's window.
                    ...(rangeChanged ? { start: 0, end: 100 } : (zoomWindowRef.current ?? {})),
                },
            ],
            xAxis: {
                // 'time' axis, not 'category': spaces points by real elapsed time.
                type: 'time',
                // `hideOverlap` drops colliding labels (week and month ticks land close). `formatAxisTick` is the shared time-axis label.
                axisLabel: { formatter: formatAxisTick, color: txtSecondary, hideOverlap: true },
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
                    // Widen only when a setpoint falls outside the trace range.
                    if (neededMin < naturalMin || neededMax > naturalMax) {
                        const span = (neededMax - neededMin) || 1;
                        const pad = span * 0.08;
                        if (autoMin === undefined) autoMin = neededMin - pad;
                        if (autoMax === undefined) autoMax = neededMax + pad;
                    }
                }
                return {
                    type: 'value',
                    // No axis name (legend has it). `scale: true` auto-fits Y; a pinned min/max overrides that side; autoMin/autoMax keep markLines visible.
                    scale: true,
                    ...(autoMin !== undefined ? { min: autoMin } : {}),
                    ...(autoMax !== undefined ? { max: autoMax } : {}),
                    position: index % 2 === 0 ? 'left' : 'right',
                    offset: Math.floor(index / 2) * 60,
                    axisLine: { show: true, lineStyle: { color: color } },
                    // Round labels to at most 3 decimals; padded min/max would otherwise print at full float precision.
                    axisLabel: { color: color, formatter: (val: number) => `${Number(val.toFixed(3))}` },
                    splitLine: { show: !hideYSplitLine && index === 0, lineStyle: { color: gridLine, type: 'dashed', opacity: 0.3 } }
                };
            }),
            series: baseSeries,
        };
    }, [data, columnar, sensors, headers, containerH, markLines, hideYSplitLine, sensorColors, sensorAxisRange, sensorLookup, timeHighlights, xData, taggedPoints, rangeChanged]);

    return (
        <div className="chart-with-tags">
        <div ref={wrapperRef} className="chart-with-tags-plot" style={{ width: '100%', minHeight: 0, position: 'relative' }}>
            {/* lazyUpdate coalesces consecutive setOption calls into one frame. */}
            <ResponsiveECharts option={option} lazyUpdate style={{ minHeight: '200px' }} onChartReady={handleChartReady} />
            <div className="line-chart-toolbox">
                <div ref={zoomMenuRef} style={{ position: 'relative' }}>
                    <button
                        type="button"
                        onClick={() => setZoomMenuOpen(o => !o)}
                        className={`line-chart-tool${zoomSelectMode ? ' active' : ''}`}
                        title="Zoom"
                    >
                        <Search size={13} />
                    </button>
                    {zoomMenuOpen && (
                        <div className="line-chart-zoom-menu">
                            <button type="button" className="line-chart-zoom-menu-item" onClick={enterZoomSelectMode}>
                                <ZoomIn size={13} /> Horizontal zoom
                            </button>
                            <button type="button" className="line-chart-zoom-menu-item" onClick={zoomOut}>
                                <ZoomOut size={13} /> Zoom out
                            </button>
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    ref={tagButtonRef}
                    onClick={toggleTagMode}
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
                        aria-label="Clear all tags"
                    >
                        <Trash2 size={13} />
                    </button>
                )}
            </div>
            {zoomSelectMode && (
                <div style={{
                    position: 'absolute', top: 12, left: 44, pointerEvents: 'none',
                    fontSize: 10, fontStyle: 'italic', color: txtSecondary,
                }}>
                    Drag across the chart to zoom into that range
                </div>
            )}
            {tagMode && (
                <div style={{
                    position: 'absolute', top: 12, left: 44, pointerEvents: 'none',
                    fontSize: 10, fontStyle: 'italic', color: txtSecondary,
                }}>
                    {tagTableHost === undefined
                        ? 'Click the chart to tag a point — its values are listed under the chart'
                        : 'Click the chart to tag a point — its values are listed in the Tagged points tab'}
                </div>
            )}
            {/* Drag feedback is a DOM overlay, not markArea: markArea would rebuild the option on every mousemove. */}
            {dragPixels && (
                <div style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: Math.min(dragPixels[0], dragPixels[1]),
                    width: Math.abs(dragPixels[1] - dragPixels[0]),
                    background: 'rgba(59,130,246,0.15)',
                    border: '1px solid rgba(59,130,246,0.5)',
                    pointerEvents: 'none',
                }} />
            )}
        </div>
        <TagTableSlot host={tagTableHost} items={tagListItems} rows={tagTableRows} onRemove={removeTag} emptyFocusRef={tagButtonRef} />
        </div>
    );
}

export default memo(LineChart);
