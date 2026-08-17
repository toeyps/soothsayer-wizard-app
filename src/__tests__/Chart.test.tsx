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

    it('renders ScatterChart for chartType="scatter" and forwards axis props + sensorMetadata (regression: sensorMetadata was never wired through to ScatterChart, so the axis-title hover-tooltip descriptions had no data to read)', () => {
        const onScatterAxesChange = vi.fn();
        const onScatterAxisPinsChange = vi.fn();
        const scatterAxisPins = { x: { sensor: 'A' } };
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
            sensorMetadata,
        });
    });

    it('forwards timeHighlights to Line and Scatter, but never to Pair Plot (its lasso-cluster is a separate, self-contained mechanism)', () => {
        const timeHighlights = [{ id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true }];

        const { unmount: unmountLine } = render(<Chart {...baseProps} sensors={['A']} chartType="line" timeHighlights={timeHighlights} />);
        expect(lineProps[0].timeHighlights).toBe(timeHighlights);
        unmountLine();

        const { unmount: unmountScatter } = render(<Chart {...baseProps} sensors={['A', 'B']} chartType="scatter" timeHighlights={timeHighlights} />);
        expect(scatterProps[0].timeHighlights).toBe(timeHighlights);
        unmountScatter();

        render(<Chart {...baseProps} sensors={['A', 'B']} chartType="pair" timeHighlights={timeHighlights} />);
        expect(pairProps[0].timeHighlights).toBeUndefined();
    });

    it('forwards highlightDisplay to Line only -- Scatter always rings regardless, Pair Plot has no highlights at all', () => {
        const { unmount: unmountLine } = render(<Chart {...baseProps} sensors={['A']} chartType="line" highlightDisplay="line" />);
        expect(lineProps[0].highlightDisplay).toBe('line');
        unmountLine();

        const { unmount: unmountScatter } = render(<Chart {...baseProps} sensors={['A', 'B']} chartType="scatter" highlightDisplay="line" />);
        expect(scatterProps[0].highlightDisplay).toBeUndefined();
        unmountScatter();

        render(<Chart {...baseProps} sensors={['A', 'B']} chartType="pair" highlightDisplay="line" />);
        expect(pairProps[0].highlightDisplay).toBeUndefined();
    });

    it('forwards lineTaggedPoints/onLineTaggedPointsChange to Line only -- Scatter keeps its own tags local, Pair Plot has none', () => {
        const lineTaggedPoints = [{ id: 't1', timestamp: '2026-01-01T00:00', color: '#f59e0b' }];
        const onLineTaggedPointsChange = vi.fn();

        const { unmount: unmountLine } = render(
            <Chart {...baseProps} sensors={['A']} chartType="line" lineTaggedPoints={lineTaggedPoints} onLineTaggedPointsChange={onLineTaggedPointsChange} />,
        );
        expect(lineProps[0].lineTaggedPoints).toBe(lineTaggedPoints);
        expect(lineProps[0].onLineTaggedPointsChange).toBe(onLineTaggedPointsChange);
        unmountLine();

        render(<Chart {...baseProps} sensors={['A', 'B']} chartType="scatter" lineTaggedPoints={lineTaggedPoints} onLineTaggedPointsChange={onLineTaggedPointsChange} />);
        expect(scatterProps[0].lineTaggedPoints).toBeUndefined();
        expect(scatterProps[0].onLineTaggedPointsChange).toBeUndefined();
    });
});
