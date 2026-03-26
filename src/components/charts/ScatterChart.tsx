import { useState, useEffect, useMemo, memo } from 'react';
import ReactECharts from 'echarts-for-react';
import 'echarts-gl';
import { ChartProps } from './ChartTypes';

function ScatterChart({ data, sensors, headers }: ChartProps) {
    const colors = ["#3b82f6", "#10b981", "#6366f1", "#8b5cf6", "#f43f5e", "#f59e0b"];

    const [scatterX, setScatterX] = useState<string>('');
    const [scatterY, setScatterY] = useState<string>('');

    useEffect(() => {
        if (sensors.length >= 2) {
            if (!sensors.includes(scatterX)) setScatterX(sensors[0]);
            if (!sensors.includes(scatterY)) setScatterY(sensors[1]);
        } else if (sensors.length === 1) {
            setScatterX(sensors[0]);
            setScatterY(sensors[0]);
        }
    }, [sensors, scatterX, scatterY]);

    const option = useMemo(() => {
        const dataCount = data.length;
        const isLargeData = dataCount > 10000;

        const xIndex = headers.indexOf(scatterX);
        const yIndex = headers.indexOf(scatterY);

        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
            animation: !isLargeData,
            toolbox: {
                show: true,
                right: 20,
                top: 10,
                feature: {
                    dataZoom: { title: { zoom: 'Brush Zoom', back: 'Reset Zoom' } },
                    restore: { title: 'Reset All' }
                },
                iconStyle: { borderColor: '#94a3b8' },
                emphasis: { iconStyle: { borderColor: '#6366f1' } }
            },
            grid: { left: '3%', right: '4%', bottom: '5%', top: '5%', containLabel: true },
            dataZoom: [
                { type: 'inside', xAxisIndex: [0], filterMode: 'filter' },
                { type: 'inside', yAxisIndex: [0], filterMode: 'filter' },
                { type: 'slider', xAxisIndex: [0], filterMode: 'filter', bottom: 10, height: 20, handleSize: '100%' },
                { type: 'slider', yAxisIndex: [0], filterMode: 'filter', right: 10, width: 20, handleSize: '100%' }
            ],
            tooltip: {
                show: true,
                trigger: 'axis',
                axisPointer: { type: 'cross', crossStyle: { color: '#6366f1', width: 1 }, label: { show: true, backgroundColor: 'rgba(99, 102, 241, 0.9)' } },
                backgroundColor: 'rgba(30, 41, 59, 0.95)',
                borderColor: '#334155',
                textStyle: { color: '#f8fafc' },
                formatter: (params: any) => {
                    if (!params || params.length === 0) return '';
                    const xVal = params[0]?.axisValue ?? params[0]?.value?.[0] ?? '-';
                    const yVal = params[0]?.value?.[1] ?? '-';
                    return `<div style="font-weight:bold; margin-bottom:8px; color:#a5b4fc;">${scatterX} vs ${scatterY}</div>
                             <div>X: ${typeof xVal === 'number' ? xVal.toFixed(4) : xVal}</div>
                             <div>Y: ${typeof yVal === 'number' ? yVal.toFixed(4) : yVal}</div>`;
                }
            },
            xAxis: {
                type: 'value',
                name: scatterX,
                nameLocation: 'middle',
                nameGap: 30,
                scale: true,
                axisLabel: { color: '#94a3b8' },
                axisLine: { lineStyle: { color: '#334155' } },
                splitLine: { show: false }
            },
            yAxis: {
                type: 'value',
                name: scatterY,
                scale: true,
                axisLine: { lineStyle: { color: '#334155' } },
                axisLabel: { color: '#94a3b8' },
                splitLine: { show: true, lineStyle: { color: '#334155', type: 'dashed', opacity: 0.3 } }
            },
            series: [{
                name: `${scatterX} vs ${scatterY}`,
                type: isLargeData ? 'scatterGL' : 'scatter',
                clip: true,
                dimensions: [scatterX, scatterY, 'Time'],
                ...(isLargeData ? { progressive: 1000000, progressiveThreshold: 5000 } : { large: true, largeThreshold: 2000 }),
                symbolSize: 5,
                itemStyle: { color: colors[0], opacity: 0.5 },
                data: data.map(d => {
                    if (xIndex === -1 || yIndex === -1) return null;
                    const valX = d.values[xIndex];
                    const valY = d.values[yIndex];
                    if (valX === null || valY === null) return null;
                    return [valX, valY, d.timestamp ? new Date(d.timestamp).getTime() : 0];
                }).filter(Boolean)
            }]
        };
    }, [data, sensors, headers, scatterX, scatterY]);

    if ((sensors.length < 2)) {
        return <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: '20%' }}>Select at least 2 sensors</div>;
    }

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <div style={{ position: 'absolute', top: '10px', left: '50px', zIndex: 10, display: 'flex', gap: '10px', background: 'rgba(30, 41, 59, 0.8)', padding: '5px', borderRadius: '4px' }}>
                <select value={scatterX} onChange={e => setScatterX(e.target.value)} style={{ backgroundColor: '#1e293b', color: 'white', border: 'none' }}>
                    {sensors.map(s => <option key={s} value={s}>{s} (X)</option>)}
                </select>
                <span style={{ color: '#94a3b8' }}>vs</span>
                <select value={scatterY} onChange={e => setScatterY(e.target.value)} style={{ backgroundColor: '#1e293b', color: 'white', border: 'none' }}>
                    {sensors.map(s => <option key={s} value={s}>{s} (Y)</option>)}
                </select>
            </div>
            <ReactECharts option={option} style={{ height: '100%', width: '100%', minHeight: '300px' }} notMerge={true} theme="dark" />
        </div>
    );
}

export default memo(ScatterChart);
