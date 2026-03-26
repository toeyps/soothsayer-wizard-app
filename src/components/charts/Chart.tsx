import { memo } from 'react';
import LineChart from './LineChart';
import ScatterChart from './ScatterChart';
import PairPlotChart from './PairPlotChart';
import { ChartProps } from './ChartTypes';

interface MainChartProps extends ChartProps {
    chartType?: 'line' | 'scatter' | 'pair';
}

function Chart({ data, sensors, headers, chartType = 'line' }: MainChartProps) {

    if (!sensors || sensors.length === 0) {
        return <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: '20%' }}>Select sensors to view data</div>;
    }

    if (chartType === 'line') {
        return <LineChart data={data} sensors={sensors} headers={headers} />;
    }

    if (chartType === 'pair') {
        if (sensors.length < 2) {
            return <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: '20%' }}>Select at least 2 sensors</div>;
        }
        return <PairPlotChart data={data} sensors={sensors} headers={headers} />;
    }

    // Default to Scatter
    return <ScatterChart data={data} sensors={sensors} headers={headers} />;
}

export default memo(Chart);
