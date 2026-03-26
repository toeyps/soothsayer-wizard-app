import { useMemo, memo } from 'react';
import ReactECharts from 'echarts-for-react';
import 'echarts-gl';
import { ChartProps } from './ChartTypes';

function PairPlotChart({ data, sensors, headers }: ChartProps) {
    const colors = ["#3b82f6", "#10b981", "#6366f1", "#8b5cf6", "#f43f5e", "#f59e0b"];

    const option = useMemo(() => {
        const dataCount = data.length;
        const isLargeData = dataCount > 10000;

        const n = sensors.length;
        if (n < 2) return {};

        const grids: any[] = [];
        const xAxes: any[] = [];
        const yAxes: any[] = [];
        const series: any[] = [];

        const totalWidth = 100;
        const totalHeight = 100;
        const margin = 5;
        const totalCols = n + 1;
        const matrixLeft = 4;
        const matrixTop = 5;
        const matrixHeight = totalHeight - 5 - 4;
        const matrixWidth = totalWidth - matrixLeft - margin;
        const gap = 2;

        const cellHeight = (matrixHeight - (n - 1) * gap) / n;
        const cellWidth = (matrixWidth - (totalCols - 1) * gap) / totalCols;

        const calculateHistogram = (sensorVals: number[], min: number, max: number) => {
            const valid = sensorVals.filter(v => v !== null && !isNaN(v));
            if (valid.length === 0) return [];

            const bins = 20;
            const step = (max - min) / bins;

            if (step === 0) {
                return [[valid.length, min, min, min]];
            }

            const hist = new Array(bins).fill(0);
            const binEdges = new Array(bins + 1).fill(0).map((_, i) => min + i * step);

            valid.forEach(v => {
                let idx = Math.floor((v - min) / step);
                if (idx >= bins) idx = bins - 1;
                if (idx < 0) idx = 0;
                hist[idx]++;
            });
            return hist.map((count, i) => {
                const mid = binEdges[i] + step / 2;
                return [count, mid, binEdges[i], binEdges[i + 1]];
            });
        };

        const sensorDataMap = sensors.map(s => {
            const idx = headers.indexOf(s);
            const vals = data.map(d => d.values[idx] ?? NaN);
            const validVals = vals.filter(v => !isNaN(v));
            const min = validVals.length ? Math.min(...validVals) : 0;
            const max = validVals.length ? Math.max(...validVals) : 1;

            return {
                name: s,
                idx: idx,
                vals: vals,
                min,
                max,
                hist: calculateHistogram(vals, min, max)
            };
        });

        sensors.forEach((sensorY, i) => {
            const dataY = sensorDataMap[i];
            const rowTop = matrixTop + i * (cellHeight + gap);

            for (let k = 0; k < n; k++) {
                const colIdx = k;
                const colLeft = matrixLeft + (colIdx * (cellWidth + gap));
                const gridIndex = grids.length;

                if (k === i) {
                    grids.push({
                        left: `${colLeft}%`, top: `${rowTop}%`, width: `${cellWidth}%`, height: `${cellHeight}%`,
                        containLabel: false, show: true, borderColor: '#475569', borderWidth: 1
                    });
                    xAxes.push({
                        gridIndex, type: 'value', name: 'Count', nameLocation: 'middle', nameGap: 10,
                        nameTextStyle: { fontSize: 9, color: '#64748b' }, show: true,
                        axisLabel: { show: true, fontSize: 8, color: '#94a3b8' }, splitLine: { show: false }, min: 0
                    });
                    yAxes.push({
                        gridIndex, type: 'value', name: sensorY, nameLocation: 'middle', nameGap: 25, nameRotate: 90,
                        nameTextStyle: { fontSize: 10, color: '#cbd5e1' }, show: true,
                        axisLabel: { show: true, color: '#94a3b8', fontSize: 9, margin: 2 },
                        axisTick: { show: false }, splitLine: { show: false }, scale: true
                    });
                    series.push({
                        type: 'custom', xAxisIndex: gridIndex, yAxisIndex: gridIndex, data: dataY.hist,
                        renderItem: (_params: any, api: any) => {
                            const count = api.value(0);
                            const yMin = api.value(2);
                            const yMax = api.value(3);
                            const start = api.coord([0, yMax]);
                            const end = api.coord([count, yMin]);
                            const width = end[0] - start[0];
                            const height = end[1] - start[1];
                            return { type: 'rect', shape: { x: start[0], y: start[1], width, height }, style: api.style() };
                        },
                        encode: { x: 0, y: [2, 3] }, itemStyle: { color: '#6366f1', opacity: 0.8 }
                    });
                } else if (k > i) {
                    const sensorX = sensors[k];
                    const dataX = sensorDataMap.find(d => d.name === sensorX)!;
                    grids.push({
                        left: `${colLeft}%`, top: `${rowTop}%`, width: `${cellWidth}%`, height: `${cellHeight}%`,
                        containLabel: false, show: true, borderColor: '#475569', borderWidth: 1
                    });
                    xAxes.push({
                        gridIndex, type: 'value', name: i === 0 ? sensorX : '', nameLocation: 'middle', nameGap: 5,
                        position: 'top', show: true, nameTextStyle: { fontSize: 10, color: '#f8fafc' },
                        axisLabel: { show: i === 0, color: '#94a3b8', fontSize: 9, margin: 2 },
                        axisTick: { show: false }, axisLine: { show: false }, splitLine: { show: false }, scale: true
                    });
                    yAxes.push({ gridIndex, type: 'value', show: false, scale: true });
                    series.push({
                        type: isLargeData ? 'scatterGL' : 'scatter', symbol: 'circle',
                        xAxisIndex: gridIndex, yAxisIndex: gridIndex,
                        itemStyle: { color: colors[0], opacity: 0.6 }, symbolSize: 3, large: false,
                        data: data.map(d => {
                            const valX = d.values[dataX.idx];
                            const valY = d.values[dataY.idx];
                            if (valX == null || valY == null) return null;
                            return [valX, valY];
                        }).filter(Boolean)
                    });
                }
            }

            {
                const gridIndex = grids.length;
                const colIdx = n;
                const colLeft = matrixLeft + (colIdx * (cellWidth + gap));
                grids.push({
                    left: `${colLeft}%`, top: `${rowTop}%`, width: `${cellWidth}%`, height: `${cellHeight}%`,
                    containLabel: false, show: true, borderColor: '#939dacff', borderWidth: 1
                });
                xAxes.push({
                    gridIndex, type: 'time', name: i === 0 ? 'timeseries' : '', nameLocation: 'middle', nameGap: 5,
                    position: 'top', nameTextStyle: { fontSize: 10, color: '#f8fafc' },
                    axisLabel: { show: i === 0, formatter: '{yyyy}-{MM}', color: '#cbd5e1', fontSize: 9, margin: 2 },
                    axisLine: { show: false }, splitLine: { show: false }, axisTick: { show: false }, show: true
                });
                yAxes.push({
                    gridIndex, type: 'value', show: true, position: 'right',
                    axisLabel: { show: true, color: '#94a3b8', fontSize: 9, margin: 2 },
                    splitLine: { show: false }, scale: true
                });
                series.push({
                    type: isLargeData ? 'scatterGL' : 'scatter', symbol: 'circle',
                    xAxisIndex: gridIndex, yAxisIndex: gridIndex, symbolSize: 3,
                    itemStyle: { color: '#60a5fa', opacity: 0.8 }, large: false,
                    data: data.map(d => {
                        const val = d.values[dataY.idx];
                        if (val == null || !d.timestamp) return null;
                        return [new Date(d.timestamp).getTime(), val];
                    }).filter(Boolean)
                });
            }
        });

        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
            tooltip: {
                trigger: 'item',
                formatter: (params: any) => {
                    if (!params.value) return '';
                    const isTimeSeries = params.seriesType === 'line' ||
                        ((params.seriesType === 'scatter' || params.seriesType === 'scatterGL') && params.value[0] > 1000000000000);
                    if (isTimeSeries) {
                        return `Time: ${new Date(params.value[0]).toLocaleString()}<br/>Val: ${params.value[1]}`;
                    }
                    if (params.seriesType === 'custom') {
                        const count = params.value[0];
                        const minVal = params.value[2];
                        const maxVal = params.value[3];
                        return `Value: ${minVal?.toFixed(2)} - ${maxVal?.toFixed(2)}<br/>Count: ${count}`;
                    }
                    return '';
                }
            },
            grid: grids, xAxis: xAxes, yAxis: yAxes, series: series
        };
    }, [data, sensors, headers]);

    return (
        <ReactECharts option={option} style={{ height: '100%', width: '100%', minHeight: '300px' }} notMerge={true} theme="dark" />
    );
}

export default memo(PairPlotChart);
