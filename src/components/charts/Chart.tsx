import { memo } from 'react';
import LineChart from './LineChart';
import ScatterChart from './ScatterChart';
import PairPlotChart from './PairPlotChart';
import { ChartProps } from './ChartTypes';

interface MainChartProps extends ChartProps {
    chartType?: 'line' | 'scatter' | 'pair';
}

function Chart({ data, columnar, sensors, headers, chartType = 'line', markLines, sensorColors, sensorAxisRange, scatterX, scatterY, onScatterAxesChange }: MainChartProps) {

    if (!sensors || sensors.length === 0) {
        return <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: '20%' }}>Select sensors to view data</div>;
    }

    if (chartType === 'line') {
        return (
            <LineChart
                data={data}
                columnar={columnar}
                sensors={sensors}
                headers={headers}
                markLines={markLines}
                sensorColors={sensorColors}
                sensorAxisRange={sensorAxisRange}
            />
        );
    }

    if (chartType === 'pair') {
        if (sensors.length < 2) {
            return <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: '20%' }}>Select at least 2 sensors</div>;
        }
        return <PairPlotChart data={data} sensors={sensors} headers={headers} />;
    }

    // Default to Scatter
    return (
        <ScatterChart
            data={data}
            sensors={sensors}
            headers={headers}
            scatterX={scatterX}
            scatterY={scatterY}
            onScatterAxesChange={onScatterAxesChange}
        />
    );
}

export default memo(Chart);
