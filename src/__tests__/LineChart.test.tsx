import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

const capturedOptions: any[] = [];
vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => { capturedOptions.push(props.option); return <div data-testid="chart" />; },
}));

class MockResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
}

import LineChart, { LINE_CHART_COLORS, defaultSensorColor } from '../components/charts/LineChart';
import type { ColumnarSeries } from '../components/charts/ChartTypes';

function columnarOf(headers: string[], length: number): ColumnarSeries {
    const timestamps = Array.from({ length }, (_, i) => `2026-01-01T00:${String(i).padStart(2, '0')}:00`);
    const series = headers.map((_, hi) => Array.from({ length }, (_, i) => hi * 100 + i));
    return { timestamps, series };
}

beforeEach(() => {
    capturedOptions.length = 0;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('defaultSensorColor', () => {
    it('is deterministic for the same tag', () => {
        expect(defaultSensorColor('SensorA')).toBe(defaultSensorColor('SensorA'));
    });

    it('picks from the given palette', () => {
        expect(LINE_CHART_COLORS).toContain(defaultSensorColor('AnySensor'));
    });

    it('differs for at least some different tags (not a constant fallback)', () => {
        const colors = new Set(['A', 'B', 'C', 'D', 'E', 'F'].map((s) => defaultSensorColor(s)));
        expect(colors.size).toBeGreaterThan(1);
    });
});

describe('LineChart option building', () => {
    const headers = ['A', 'B', 'C'];

    it('builds one series and one yAxis entry per selected sensor', () => {
        const columnar = columnarOf(headers, 10);
        render(<LineChart data={[]} columnar={columnar} sensors={['A', 'B', 'C']} headers={headers} />);
        const option = capturedOptions[capturedOptions.length - 1];
        expect(option.series).toHaveLength(3);
        expect(option.yAxis).toHaveLength(3);
        expect(option.series.map((s: any) => s.name)).toEqual(['A', 'B', 'C']);
    });

    it('alternates yAxis position left/right and offsets by pair index', () => {
        const columnar = columnarOf(headers, 10);
        render(<LineChart data={[]} columnar={columnar} sensors={['A', 'B', 'C']} headers={headers} />);
        const [yA, yB, yC] = capturedOptions[capturedOptions.length - 1].yAxis;
        expect(yA.position).toBe('left');
        expect(yA.offset).toBe(0);
        expect(yB.position).toBe('right');
        expect(yB.offset).toBe(0);
        expect(yC.position).toBe('left');
        expect(yC.offset).toBe(60);
    });

    it('computes symmetric grid left/right padding from left/right axis counts', () => {
        const columnar = columnarOf(headers, 10);
        render(<LineChart data={[]} columnar={columnar} sensors={['A', 'B', 'C']} headers={headers} />);
        const { grid } = capturedOptions[capturedOptions.length - 1];
        // 3 sensors -> 2 on the left, 1 on the right.
        expect(grid.left).toBe(40 + 1 * 60);
        expect(grid.right).toBe(40 + 0 * 60);
    });

    it('uses a default 400px-container layout when the wrapper has no measured height (jsdom)', () => {
        const columnar = columnarOf(headers, 10);
        render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={headers} />);
        const { grid, dataZoom } = capturedOptions[capturedOptions.length - 1];
        expect(grid.top).toBe(30);
        expect(grid.bottom).toBe(58); // 20 (slider) + 8 + 24 + 6
        expect(dataZoom[1].height).toBe(20);
    });

    it('uses sensorColors overrides when provided, falling back to the hash-based default otherwise', () => {
        const columnar = columnarOf(headers, 10);
        render(
            <LineChart
                data={[]} columnar={columnar} sensors={['A', 'B']} headers={headers}
                sensorColors={{ A: '#ff0000' }}
            />,
        );
        const [seriesA, seriesB] = capturedOptions[capturedOptions.length - 1].series;
        expect(seriesA.itemStyle.color).toBe('#ff0000');
        expect(seriesB.itemStyle.color).toBe(defaultSensorColor('B'));
    });

    it('applies a user-pinned sensorAxisRange to the matching yAxis', () => {
        const columnar = columnarOf(headers, 10);
        render(
            <LineChart
                data={[]} columnar={columnar} sensors={['A']} headers={headers}
                sensorAxisRange={{ A: { min: 0, max: 15 } }}
            />,
        );
        const [yA] = capturedOptions[capturedOptions.length - 1].yAxis;
        expect(yA.min).toBe(0);
        expect(yA.max).toBe(15);
    });

    it('leaves yAxis min/max unset when there is no pin and no out-of-range markLine', () => {
        const columnar = columnarOf(headers, 10);
        render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={headers} />);
        const [yA] = capturedOptions[capturedOptions.length - 1].yAxis;
        expect(yA.min).toBeUndefined();
        expect(yA.max).toBeUndefined();
        expect(yA.scale).toBe(true);
    });

    it('widens the yAxis range when a markLine value falls outside the natural data range', () => {
        const columnar: ColumnarSeries = {
            timestamps: ['t0', 't1', 't2'],
            series: [[10, 20, 30]],
        };
        render(
            <LineChart
                data={[]} columnar={columnar} sensors={['A']} headers={['A']}
                markLines={[{ sensor: 'A', y: 50, label: 'High' }]}
            />,
        );
        const [yA] = capturedOptions[capturedOptions.length - 1].yAxis;
        // naturalMin=10, naturalMax=30, mark=50 -> neededMax=50 > naturalMax -> widen.
        expect(yA.min).toBeCloseTo(6.8, 5);
        expect(yA.max).toBeCloseTo(53.2, 5);
    });

    it('does not override an explicit sensorAxisRange even when a markLine would otherwise widen it', () => {
        const columnar: ColumnarSeries = {
            timestamps: ['t0', 't1', 't2'],
            series: [[10, 20, 30]],
        };
        render(
            <LineChart
                data={[]} columnar={columnar} sensors={['A']} headers={['A']}
                sensorAxisRange={{ A: { min: 0, max: 35 } }}
                markLines={[{ sensor: 'A', y: 50, label: 'High' }]}
            />,
        );
        const [yA] = capturedOptions[capturedOptions.length - 1].yAxis;
        expect(yA.min).toBe(0);
        expect(yA.max).toBe(35);
    });

    it('attaches markLine data with label/color/lineStyle per configured line', () => {
        const columnar: ColumnarSeries = { timestamps: ['t0'], series: [[10]] };
        render(
            <LineChart
                data={[]} columnar={columnar} sensors={['A']} headers={['A']}
                markLines={[{ sensor: 'A', y: 90, label: 'HH', color: '#ef4444', lineStyle: 'dashed', width: 2 }]}
            />,
        );
        const [seriesA] = capturedOptions[capturedOptions.length - 1].series;
        expect(seriesA.markLine.data).toEqual([
            expect.objectContaining({
                name: 'HH',
                yAxis: 90,
                lineStyle: expect.objectContaining({ color: '#ef4444', type: 'dashed', width: 2 }),
            }),
        ]);
    });

    it('omits markLine entirely for series with no configured lines', () => {
        const columnar: ColumnarSeries = { timestamps: ['t0'], series: [[10]] };
        render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        expect(capturedOptions[capturedOptions.length - 1].series[0].markLine).toBeUndefined();
    });

    describe('time-highlight bands (markArea — a distinct mechanism from markLine above)', () => {
        // columnarOf(headers, 5) → 2026-01-01T00:00 .. 00:04, one minute apart.
        const highlight = { id: 'h1', start: '2026-01-01T00:01:00', end: '2026-01-01T00:03:00', label: 'Startup', color: '#ff0000', enabled: true };

        it('attaches a markArea to the first series only, snapped to the nearest plotted timestamps', () => {
            const columnar = columnarOf(headers, 5);
            render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} timeHighlights={[highlight]} />);
            const [seriesA, seriesB] = capturedOptions[capturedOptions.length - 1].series;
            expect(seriesA.markArea.data).toEqual([[
                expect.objectContaining({ xAxis: 1 }), // 00:01 → index 1
                expect.objectContaining({ xAxis: 3 }), // 00:03 → index 3
            ]]);
            expect(seriesB.markArea).toBeUndefined(); // not duplicated onto every series
        });

        it('carries the highlight\'s label and colour on the area\'s start point', () => {
            const columnar = columnarOf(headers, 5);
            render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} timeHighlights={[highlight]} />);
            const [start] = capturedOptions[capturedOptions.length - 1].series[0].markArea.data[0];
            expect(start.label.formatter).toBe('Startup');
            expect(start.label.color).toBe('#ff0000');
            expect(start.itemStyle.color).toContain('255, 0, 0'); // hex→rgba, translucent
        });

        it('excludes disabled highlights', () => {
            const columnar = columnarOf(headers, 5);
            render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} timeHighlights={[{ ...highlight, enabled: false }]} />);
            expect(capturedOptions[capturedOptions.length - 1].series[0].markArea).toBeUndefined();
        });

        it('omits markArea entirely with no timeHighlights', () => {
            const columnar = columnarOf(headers, 5);
            render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
            expect(capturedOptions[capturedOptions.length - 1].series[0].markArea).toBeUndefined();
        });

        it('renders one boundary pair per enabled highlight, independently of markLine', () => {
            const columnar = columnarOf(headers, 5);
            const highlight2 = { id: 'h2', start: '2026-01-01T00:00:00', end: '2026-01-01T00:01:00', label: 'Overhaul', color: '#00ff00', enabled: true };
            render(
                <LineChart
                    data={[]} columnar={columnar} sensors={headers} headers={headers}
                    timeHighlights={[highlight, highlight2]}
                    markLines={[{ sensor: 'A', y: 90, label: 'HH' }]}
                />,
            );
            const seriesA = capturedOptions[capturedOptions.length - 1].series[0];
            expect(seriesA.markArea.data).toHaveLength(2);
            expect(seriesA.markLine.data).toHaveLength(1); // unaffected by markArea
        });
    });

    describe('large-data rendering profile (>2000 points)', () => {
        it('enables smoothing/animation and full-size line for small datasets', () => {
            const columnar = columnarOf(['A'], 500);
            render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
            const option = capturedOptions[capturedOptions.length - 1];
            expect(option.animation).toBe(true);
            expect(option.series[0].smooth).toBe(true);
            expect(option.series[0].lineStyle.width).toBe(2);
            expect(option.series[0].silent).toBe(false);
            expect(option.series[0].sampling).toBeUndefined();
        });

        it('disables smoothing/animation and switches to hairline+LTTB for large datasets', () => {
            const columnar = columnarOf(['A'], 2001);
            render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
            const option = capturedOptions[capturedOptions.length - 1];
            expect(option.animation).toBe(false);
            expect(option.series[0].smooth).toBe(false);
            expect(option.series[0].lineStyle.width).toBe(0.8);
            expect(option.series[0].silent).toBe(true);
            expect(option.series[0].emphasis).toEqual({ disabled: true });
            expect(option.series[0].sampling).toBe('lttb');
        });
    });

    describe('tooltip formatter', () => {
        it('returns an empty string for empty params', () => {
            const columnar = columnarOf(['A'], 3);
            render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
            const { formatter } = capturedOptions[capturedOptions.length - 1].tooltip;
            expect(formatter(null)).toBe('');
            expect(formatter([])).toBe('');
        });

        it('renders a date header and rounds values to 3 decimals, appending the sensor unit', () => {
            const columnar = columnarOf(['A'], 3);
            render(
                <LineChart
                    data={[]} columnar={columnar} sensors={['A']} headers={['A']}
                    sensorMetadata={[{ tag: 'A', description: 'd', unit: 'bar', component: 'x' }]}
                />,
            );
            const { formatter } = capturedOptions[capturedOptions.length - 1].tooltip;
            const html = formatter([
                { axisValueLabel: '2026-01-01T00:00:00', seriesName: 'A', value: 12.34567, color: '#fff' },
            ]);
            expect(html).toContain('12.346 bar');
            expect(html).toContain('2026/01/01');
        });

        it('omits the unit segment when the sensor has none in metadata', () => {
            const columnar = columnarOf(['A'], 3);
            render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
            const { formatter } = capturedOptions[capturedOptions.length - 1].tooltip;
            const html = formatter([
                { axisValueLabel: '2026-01-01T00:00:00', seriesName: 'A', value: 5, color: '#fff' },
            ]);
            expect(html).toContain('A: 5');
            expect(html).not.toContain('undefined');
        });

        it('caps the number of rendered rows at 10', () => {
            const columnar = columnarOf(['A'], 3);
            render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
            const { formatter } = capturedOptions[capturedOptions.length - 1].tooltip;
            const params = Array.from({ length: 15 }, (_, i) => ({
                axisValueLabel: '2026-01-01T00:00:00', seriesName: `S${i}`, value: i, color: '#fff',
            }));
            const html = formatter(params);
            expect((html.match(/S\d+:/g) ?? [])).toHaveLength(10);
        });
    });

    it("xAxis label formatter renders the shared YYYY/MM/DD date format", () => {
        const columnar = columnarOf(['A'], 3);
        render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        const { formatter } = capturedOptions[capturedOptions.length - 1].xAxis.axisLabel;
        expect(formatter('2026-03-09T00:00:00')).toBe('2026/03/09');
    });

    it('respects hideYSplitLine by hiding the first axis split line', () => {
        const columnar = columnarOf(['A'], 3);
        const { rerender } = render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        expect(capturedOptions[capturedOptions.length - 1].yAxis[0].splitLine.show).toBe(true);

        rerender(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} hideYSplitLine />);
        expect(capturedOptions[capturedOptions.length - 1].yAxis[0].splitLine.show).toBe(false);
    });

    it('reads the initial theme from documentElement data-theme and colors the axis accordingly', () => {
        document.documentElement.setAttribute('data-theme', 'light');
        const columnar = columnarOf(['A'], 3);
        render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        expect(capturedOptions[capturedOptions.length - 1].xAxis.axisLabel.color).toBe('#475569'); // light txtSecondary
    });

    it('falls back to row-based `data`/`headers` indexing when no columnar feed is supplied', () => {
        const data = [
            { timestamp: 't0', values: [1, 2] },
            { timestamp: 't1', values: [3, 4] },
        ] as any;
        render(<LineChart data={data} sensors={['B']} headers={['A', 'B']} />);
        const option = capturedOptions[capturedOptions.length - 1];
        expect(option.xAxis.data).toEqual(['t0', 't1']);
        expect(option.series[0].data).toEqual([2, 4]);
    });
});
