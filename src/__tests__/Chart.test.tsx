import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const lineProps: any[] = [];
const scatterProps: any[] = [];
const pairProps: any[] = [];

vi.mock('../components/charts/LineChart', () => ({
    default: (props: any) => { lineProps.push(props); return <div data-testid="line-chart" />; },
}));
vi.mock('../components/charts/ScatterChart', () => ({
    default: (props: any) => { scatterProps.push(props); return <div data-testid="scatter-chart" />; },
}));
vi.mock('../components/charts/PairPlotChart', () => ({
    default: (props: any) => { pairProps.push(props); return <div data-testid="pair-chart" />; },
}));

import Chart from '../components/charts/Chart';

beforeEach(() => {
    lineProps.length = 0;
    scatterProps.length = 0;
    pairProps.length = 0;
});

const baseProps = {
    data: [{ timestamp: '1', A: 1 }] as any,
    headers: ['A', 'B'],
};

describe('Chart', () => {
    it('shows a placeholder when no sensors are selected', () => {
        render(<Chart {...baseProps} sensors={[]} />);
        expect(screen.getByText('Select sensors to view data')).toBeTruthy();
        expect(lineProps).toHaveLength(0);
    });

    it('defaults to the line chart when chartType is omitted', () => {
        render(<Chart {...baseProps} sensors={['A']} />);
        expect(screen.getByTestId('line-chart')).toBeTruthy();
    });

    it('renders LineChart for chartType="line" and forwards its props', () => {
        const markLines = [{ sensor: 'A', y: 5, label: 'mean' }];
        const sensorColors = { A: '#fff' };
        const sensorAxisRange = { A: { min: 0, max: 10 } };
        const sensorMetadata = [{ tag: 'A', description: 'd', unit: 'C', component: 'x' }];
        render(
            <Chart
                {...baseProps}
                sensors={['A']}
                chartType="line"
                markLines={markLines}
                sensorColors={sensorColors}
                sensorAxisRange={sensorAxisRange}
                sensorMetadata={sensorMetadata}
            />,
        );
        expect(screen.getByTestId('line-chart')).toBeTruthy();
        expect(lineProps[0]).toMatchObject({
            data: baseProps.data,
            sensors: ['A'],
            headers: baseProps.headers,
            markLines,
            sensorColors,
            sensorAxisRange,
            sensorMetadata,
        });
    });

    it('shows a placeholder for pair plot with fewer than 2 sensors', () => {
        render(<Chart {...baseProps} sensors={['A']} chartType="pair" />);
        expect(screen.getByText('Select at least 2 sensors')).toBeTruthy();
        expect(pairProps).toHaveLength(0);
    });

    it('renders PairPlotChart for chartType="pair" with 2+ sensors, forwarding sensorMetadata (regression: was never wired through, so the hover-tooltip sensor descriptions had no data to read)', () => {
        const sensorMetadata = [{ tag: 'A', description: 'Pump Pressure', unit: 'bar', component: 'Pump' }];
        render(<Chart {...baseProps} sensors={['A', 'B']} chartType="pair" sensorMetadata={sensorMetadata} />);
        expect(screen.getByTestId('pair-chart')).toBeTruthy();
        expect(pairProps[0]).toMatchObject({ data: baseProps.data, sensors: ['A', 'B'], headers: baseProps.headers, sensorMetadata });
    });

    it('renders ScatterChart for chartType="scatter" and forwards axis props + criteria props + sensorMetadata (regression: sensorMetadata was never wired through to ScatterChart, so the axis-title hover-tooltip descriptions had no data to read)', () => {
        const onScatterAxesChange = vi.fn();
        const onScatterAxisPinsChange = vi.fn();
        const onScatterCriteriaChange = vi.fn();
        const scatterAxisPins = { x: { sensor: 'A' } };
        const scatterCriteria = { sensor: 'A', ranges: [{ id: 'r1', min: 0, max: 10, enabled: true }] };
        const sensorMetadata = [{ tag: 'A', description: 'Pump Pressure', unit: 'bar', component: 'Pump' }];
        render(
            <Chart
                {...baseProps}
                sensors={['A', 'B']}
                chartType="scatter"
                scatterX="A"
                scatterY="B"
                onScatterAxesChange={onScatterAxesChange}
                scatterAxisPins={scatterAxisPins}
                onScatterAxisPinsChange={onScatterAxisPinsChange}
                scatterCriteria={scatterCriteria}
                onScatterCriteriaChange={onScatterCriteriaChange}
                sensorMetadata={sensorMetadata}
            />,
        );
        expect(screen.getByTestId('scatter-chart')).toBeTruthy();
        expect(scatterProps[0]).toMatchObject({
            sensors: ['A', 'B'],
            scatterX: 'A',
            scatterY: 'B',
            onScatterAxesChange,
            scatterAxisPins,
            onScatterAxisPinsChange,
            scatterCriteria,
            onScatterCriteriaChange,
            sensorMetadata,
        });
    });
});
