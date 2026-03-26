import { useMemo, memo } from 'react';
import ReactECharts from 'echarts-for-react';
import { ChartProps } from './ChartTypes';

const colors = ["#3b82f6", "#10b981", "#6366f1", "#8b5cf6", "#f43f5e", "#f59e0b"];

function LineChart({ data, sensors, headers }: ChartProps) {
    const option = useMemo(() => {
        const dataCount = data.length;
        const isLargeData = dataCount > 10000;

        return {
            backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Inter, system-ui, sans-serif' },
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(30, 41, 59, 0.9)',
                borderColor: '#334155',
                textStyle: { color: '#f8fafc' },
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
            legend: { data: sensors, textStyle: { color: '#94a3b8' }, bottom: 0 },
            grid: { left: '3%', right: '4%', bottom: '10%', top: '5%', containLabel: true },
            animation: !isLargeData,
            dataZoom: [
                { type: 'inside', xAxisIndex: [0], filterMode: 'filter' },
                { type: 'slider', xAxisIndex: [0], filterMode: 'filter', bottom: 10 }
            ],
            xAxis: {
                type: 'category',
                boundaryGap: false,
                data: data.map(d => d.timestamp),
                axisLabel: { formatter: (val: string) => new Date(val).toLocaleTimeString(), color: '#94a3b8' },
                axisLine: { lineStyle: { color: '#334155' } }
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
                    splitLine: { show: index === 0, lineStyle: { color: '#334155', type: 'dashed', opacity: 0.3 } }
                };
            }),
            series: sensors.map((sensor, index) => {
                const sensorIdx = headers.indexOf(sensor);
                const color = colors[index % colors.length];
                return {
                    name: sensor,
                    type: 'line',
                    yAxisIndex: index,
                    data: data.map(d => d.values[sensorIdx] ?? null),
                    smooth: !isLargeData,
                    showSymbol: false,
                    itemStyle: { color: color },
                    lineStyle: { width: isLargeData ? 1 : 2 }
                };
            })
        };
    }, [data, sensors, headers]);

    return (
        <ReactECharts option={option} style={{ height: '100%', width: '100%', minHeight: '300px' }} notMerge={true} theme="dark" />
    );
}

export default memo(LineChart);
