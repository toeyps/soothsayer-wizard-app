import { useMemo, memo, useRef, useState, useEffect } from 'react';
import ResponsiveECharts from './ResponsiveECharts';
import { ChartProps } from './ChartTypes';

const colors = ["#3b82f6", "#10b981", "#6366f1", "#8b5cf6", "#f43f5e", "#f59e0b"];

function LineChart({ data, sensors, headers, markLines, hideYSplitLine }: ChartProps) {
    // Track container height so the grid/slider/legend scale with it.
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [containerH, setContainerH] = useState<number>(0);

    useEffect(() => {
        const el = wrapperRef.current;
        if (!el) return;
        const update = () => setContainerH(el.clientHeight);
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
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
        const dataCount = data.length;
        const isLargeData = dataCount > 10000;

        // ── Dynamic horizontal padding ────────────────────────────
        const AXIS_OFFSET = 60;
        const AXIS_BASE_PAD = 40;
        const leftCount = Math.ceil(sensors.length / 2);
        const rightCount = Math.floor(sensors.length / 2);
        const gridLeft = AXIS_BASE_PAD + Math.max(0, leftCount - 1) * AXIS_OFFSET;
        const gridRight = AXIS_BASE_PAD + Math.max(0, rightCount - 1) * AXIS_OFFSET;

        // ── Dynamic vertical layout (pixel values, clamped to container) ──
        // Ideal full-size reservations:
        const LEGEND_H = 28;
        const SLIDER_H = 20;
        const X_AXIS_LABEL_H = 24;
        const GAP_ABOVE_LEGEND = 6;
        const GAP_ABOVE_SLIDER = 8;
        const GAP_ABOVE_XAXIS = 6;
        const idealBottom = LEGEND_H + GAP_ABOVE_LEGEND + SLIDER_H + GAP_ABOVE_SLIDER + X_AXIS_LABEL_H + GAP_ABOVE_XAXIS;

        // Clamp bottom reservation to at most 45% of the container so the
        // plotting area is never squeezed to zero (or negative) when the
        // panel is small.
        const h = containerH > 0 ? containerH : 400;
        const maxBottom = Math.max(60, Math.floor(h * 0.45));
        const scale = Math.min(1, maxBottom / idealBottom);

        const legendH = Math.round(LEGEND_H * scale);
        const sliderH = Math.max(12, Math.round(SLIDER_H * scale));
        const gapLegend = Math.round(GAP_ABOVE_LEGEND * scale);
        const gapSlider = Math.round(GAP_ABOVE_SLIDER * scale);
        const gapXAxis = Math.round(GAP_ABOVE_XAXIS * scale);
        const xAxisLabelH = Math.round(X_AXIS_LABEL_H * scale);

        const legendBottom = 0;
        const sliderBottom = legendBottom + legendH + gapLegend;
        const gridBottom = sliderBottom + sliderH + gapSlider + xAxisLabelH + gapXAxis;
        const gridTop = Math.max(20, Math.round(30 * scale));

        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
            tooltip: {
                trigger: 'axis',
                backgroundColor: tooltipBg,
                borderColor: tooltipBorder,
                textStyle: { color: txtPrimary },
                formatter: (params: any) => {
                    if (!params || (Array.isArray(params) && params.length === 0)) return '';
                    const pList = Array.isArray(params) ? params : [params];
                    const dateStr = new Date(pList[0].axisValueLabel).toLocaleString();
                    let content = `<div style="font-weight:bold; margin-bottom:5px;">${dateStr}</div>`;
                    const maxItems = 10;
                    pList.slice(0, maxItems).forEach((p: any) => {
                        content += `<div style="display:flex; align-items:center; gap:5px;">
                            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background-color:${p.color};"></span>
                            <span>${p.seriesName}: ${p.value}</span>
                        </div>`;
                    });
                    return content;
                }
            },
            legend: { data: sensors, textStyle: { color: txtSecondary }, bottom: legendBottom, height: legendH },
            grid: {
                left: gridLeft,
                right: gridRight,
                top: gridTop,
                bottom: gridBottom,
                containLabel: false,
            },
            animation: !isLargeData,
            dataZoom: [
                { type: 'inside', xAxisIndex: [0], filterMode: 'filter' },
                { type: 'slider', xAxisIndex: [0], filterMode: 'filter', bottom: sliderBottom, height: sliderH }
            ],
            xAxis: {
                type: 'category',
                boundaryGap: false,
                data: data.map(d => d.timestamp),
                axisLabel: { formatter: (val: string) => new Date(val).toLocaleTimeString(), color: txtSecondary },
                axisLine: { lineStyle: { color: gridLine } }
            },
            yAxis: sensors.map((sensor, index) => {
                const color = colors[index % colors.length];
                return {
                    type: 'value',
                    name: sensor,
                    position: index % 2 === 0 ? 'left' : 'right',
                    offset: Math.floor(index / 2) * 60,
                    axisLine: { show: true, lineStyle: { color: color } },
                    axisLabel: { color: color },
                    splitLine: { show: !hideYSplitLine && index === 0, lineStyle: { color: gridLine, type: 'dashed', opacity: 0.3 } }
                };
            }),
            series: sensors.map((sensor, index) => {
                const sensorIdx = headers.indexOf(sensor);
                const color = colors[index % colors.length];
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
                        })),
                    }
                    : undefined;
                return {
                    name: sensor,
                    type: 'line',
                    yAxisIndex: index,
                    data: data.map(d => d.values[sensorIdx] ?? null),
                    smooth: !isLargeData,
                    showSymbol: false,
                    itemStyle: { color: color },
                    lineStyle: { width: isLargeData ? 1 : 2 },
                    ...(markLine ? { markLine } : {}),
                };
            })
        };
    }, [data, sensors, headers, containerH, markLines, hideYSplitLine, theme]);

    return (
        <div ref={wrapperRef} style={{ width: '100%', height: '100%', minHeight: 0 }}>
            <ResponsiveECharts option={option} style={{ minHeight: '200px' }} />
        </div>
    );
}

export default memo(LineChart);
