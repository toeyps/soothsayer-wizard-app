import { useMemo, memo, useRef, useState, useEffect } from 'react';
import ResponsiveECharts from './ResponsiveECharts';
import { ChartProps } from './ChartTypes';
import { formatDate, formatDateTime } from '../../utils/dateFormat';
import { useSensorMetaMap, normalizeSensorTag } from '../../hooks/useSensorMetaMap';

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

function LineChart({ data, columnar, sensors, headers, markLines, hideYSplitLine, sensorColors, sensorAxisRange, sensorMetadata }: ChartProps) {
    // Track container height so the grid/slider/legend scale with it.
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [containerH, setContainerH] = useState<number>(0);

    // Unit lookup for the hover tooltip — covers both mapping-CSV sensors
    // and runtime "special" (calculated) sensors, since Dashboard.tsx merges
    // both into the same `sensorMetadata` array before it reaches here.
    const sensorMetaMap = useSensorMetaMap(sensorMetadata);

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
        // Columnar feed (from Rust's `get_chart_data`) is preferred: arrays
        // drop straight into ECharts with no per-row mapping. The row-based
        // `data` path remains for callers that stream full rows (e.g.
        // PredictiveModelBuild's target chart).
        const xData = columnar ? columnar.timestamps : data.map(d => d.timestamp);
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
                    const pList = Array.isArray(params) ? params : [params];
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
            series: sensors.map((sensor, index) => {
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
                return {
                    name: sensor,
                    type: 'line',
                    yAxisIndex: index,
                    data: columnar
                        ? (columnar.series[sensorIdx] ?? [])
                        : data.map(d => d.values[sensorIdx] ?? null),
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
                };
            })
        };
    }, [data, columnar, sensors, headers, containerH, markLines, hideYSplitLine, theme, sensorColors, sensorAxisRange, sensorMetaMap]);

    return (
        <div ref={wrapperRef} style={{ width: '100%', height: '100%', minHeight: 0 }}>
            {/* lazyUpdate batches consecutive setOption calls into one frame
                (resize + data + theme changes coalesce instead of each
                triggering its own full notMerge re-init). */}
            <ResponsiveECharts option={option} lazyUpdate style={{ minHeight: '200px' }} />
        </div>
    );
}

export default memo(LineChart);
