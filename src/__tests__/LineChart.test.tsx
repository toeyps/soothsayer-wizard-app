import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, fireEvent, act } from '@testing-library/react';

const capturedOptions: any[] = [];
/** Fake echarts instance handed to `onChartReady`, exposing just enough of
 *  the real API (getZr/containPixel/convertFromPixel) for the Tag Point
 *  click-handling tests below. `zrClickHandler` captures the listener
 *  LineChart registers via `getZr().on('click', ...)` so tests can invoke
 *  it directly, the same way a real zrender canvas click would. */
let zrClickHandler: ((event: any) => void) | null = null;
const mockContainPixel = vi.fn(() => true);
// Real echarts (confirmed against the actual installed package -- see
// LineChart.tsx's comment on the click handler) returns `[categoryIndex,
// value]` for a category-axis `{ seriesIndex: 0 }` finder, NOT a plain
// number -- mocked as an array here so these tests actually exercise that
// return shape instead of accidentally only covering the number fallback.
const mockConvertFromPixel = vi.fn(() => [0, 0]);
const mockZr = {
    on: vi.fn((evt: string, cb: (event: any) => void) => { if (evt === 'click') zrClickHandler = cb; }),
    off: vi.fn(),
};
const mockChartInstance = {
    getZr: () => mockZr,
    containPixel: mockContainPixel,
    convertFromPixel: mockConvertFromPixel,
};

vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => {
        capturedOptions.push(props.option);
        // Mirrors the real component's mount-only effect — calling
        // onChartReady synchronously during render would trip React's
        // "setState while rendering a different component" guard.
        // eslint-disable-next-line react-hooks/rules-of-hooks
        useEffect(() => { props.onChartReady?.(mockChartInstance); }, []);
        return <div data-testid="chart" />;
    },
}));

class MockResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
}

import LineChart, { LINE_CHART_COLORS, defaultSensorColor, buildLineColorPieces } from '../components/charts/LineChart';
import type { ColumnarSeries } from '../components/charts/ChartTypes';

function columnarOf(headers: string[], length: number): ColumnarSeries {
    const timestamps = Array.from({ length }, (_, i) => `2026-01-01T00:${String(i).padStart(2, '0')}:00`);
    const series = headers.map((_, hi) => Array.from({ length }, (_, i) => hi * 100 + i));
    return { timestamps, series };
}

beforeEach(() => {
    capturedOptions.length = 0;
    zrClickHandler = null;
    mockContainPixel.mockClear().mockReturnValue(true);
    mockConvertFromPixel.mockClear().mockReturnValue([0, 0]);
    mockZr.on.mockClear();
    mockZr.off.mockClear();
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

describe('buildLineColorPieces (visualMap piece construction for \'line\' display mode)', () => {
    it('returns nothing for zero data points or zero ranges', () => {
        expect(buildLineColorPieces(0, [{ startIdx: 0, endIdx: 2, color: '#f00' }])).toEqual([]);
        expect(buildLineColorPieces(10, [])).toEqual([]);
    });

    it('produces one piece for a single range, leaving the rest uncovered (outOfRange picks it up)', () => {
        const pieces = buildLineColorPieces(10, [{ startIdx: 2, endIdx: 5, color: '#f00' }]);
        expect(pieces).toEqual([{ min: 2, max: 5, color: '#f00' }]);
    });

    it('produces one piece per disjoint range, in index order', () => {
        const pieces = buildLineColorPieces(10, [
            { startIdx: 6, endIdx: 8, color: '#0f0' },
            { startIdx: 1, endIdx: 3, color: '#f00' },
        ]);
        // Output order follows index position, not input array order.
        expect(pieces).toEqual([
            { min: 1, max: 3, color: '#f00' },
            { min: 6, max: 8, color: '#0f0' },
        ]);
    });

    it('resolves overlapping ranges by "first range in the array wins" (same convention as ScatterChart\'s halo)', () => {
        const pieces = buildLineColorPieces(10, [
            { startIdx: 2, endIdx: 6, color: '#f00' }, // listed first -> wins the overlap
            { startIdx: 4, endIdx: 8, color: '#0f0' },
        ]);
        expect(pieces).toEqual([
            { min: 2, max: 6, color: '#f00' },
            { min: 7, max: 8, color: '#0f0' },
        ]);
    });

    it('a range spanning the entire dataset produces exactly one piece covering it all', () => {
        const pieces = buildLineColorPieces(5, [{ startIdx: 0, endIdx: 4, color: '#f00' }]);
        expect(pieces).toEqual([{ min: 0, max: 4, color: '#f00' }]);
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

    describe('\'line\' highlight display mode (a bolder overlay line drawn on top of the trace, instead of a markArea band)', () => {
        const highlight = { id: 'h1', start: '2026-01-01T00:01:00', end: '2026-01-01T00:03:00', label: 'Startup', color: '#ff0000', enabled: true };

        it('with no highlightDisplay prop (default), behaves exactly like \'band\': markArea attached, no overlay series, base data untouched', () => {
            const columnar = columnarOf(headers, 5);
            render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} timeHighlights={[highlight]} />);
            const option = capturedOptions[capturedOptions.length - 1];
            expect(option.series).toHaveLength(3); // one per sensor, no overlays
            expect(option.series[0].markArea).toBeDefined();
            expect(typeof option.series[0].data[0]).toBe('number');
        });

        it('with highlightDisplay="line" and an enabled highlight: no markArea, base series are untouched (own colour/width, full data), plus one overlay series per sensor', () => {
            const columnar = columnarOf(headers, 5);
            render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} timeHighlights={[highlight]} highlightDisplay="line" />);
            const option = capturedOptions[capturedOptions.length - 1];

            expect(option.series).toHaveLength(6); // 3 base + 3 overlay (one highlight x 3 sensors)
            const baseSeries = option.series.slice(0, 3);
            const overlaySeries = option.series.slice(3);

            baseSeries.forEach((s: any, i: number) => {
                expect(s.markArea).toBeUndefined();
                expect(s.itemStyle.color).toBe(defaultSensorColor(headers[i]));
                expect(s.lineStyle.width).toBe(2); // unchanged, small-data profile
                expect(s.data).toEqual([i * 100, i * 100 + 1, i * 100 + 2, i * 100 + 3, i * 100 + 4]); // full, untouched
            });

            overlaySeries.forEach((s: any, i: number) => {
                expect(s.name).toBe(headers[i]);
                expect(s.itemStyle.color).toBe('#ff0000'); // the highlight's own colour
                expect(s.lineStyle.color).toBe('#ff0000');
                expect(s.lineStyle.width).toBe(4); // double the base width (2 * 2)
                expect(s.tooltip).toEqual({ show: false }); // excluded, so hover doesn't double up on the sensor
                expect(s.silent).toBe(true);
                // null outside the highlighted [1,3] index range (00:01..00:03), the sensor's real value inside it.
                expect(s.data).toEqual([null, i * 100 + 1, i * 100 + 2, i * 100 + 3, null]);
            });
        });

        it('the overlay stays at its full emphasis width even on the large-data hairline profile (regression: doubling the 0.8px hairline base only reached 1.6px, which read as no different from the base line on a real ~4 000-point chart)', () => {
            const columnar = columnarOf(['A'], 2001); // > 2000 -> isLargeData
            render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} timeHighlights={[highlight]} highlightDisplay="line" />);
            const option = capturedOptions[capturedOptions.length - 1];
            const [base, overlay] = option.series;
            expect(base.lineStyle.width).toBe(0.8); // base still gets the hairline profile
            expect(overlay.lineStyle.width).toBe(4); // overlay does NOT shrink with it
        });

        it('a second, differently-coloured highlight produces its own separate overlay series per sensor', () => {
            const highlight2 = { id: 'h2', start: '2026-01-01T00:00:00', end: '2026-01-01T00:00:00', label: 'Spike', color: '#00ff00', enabled: true };
            const columnar = columnarOf(['A'], 5);
            render(
                <LineChart
                    data={[]} columnar={columnar} sensors={['A']} headers={['A']}
                    timeHighlights={[highlight, highlight2]} highlightDisplay="line"
                />,
            );
            const option = capturedOptions[capturedOptions.length - 1];
            expect(option.series).toHaveLength(3); // 1 base + 2 overlays (one per highlight)
            const [, overlay1, overlay2] = option.series;
            expect(overlay1.lineStyle.color).toBe('#00ff00'); // earlier index (0) sorts first
            expect(overlay1.data).toEqual([0, null, null, null, null]);
            expect(overlay2.lineStyle.color).toBe('#ff0000');
            expect(overlay2.data).toEqual([null, 1, 2, 3, null]);
        });

        it('with highlightDisplay="line" but no enabled highlights: no overlay series, no markArea, same as \'band\' with nothing to draw', () => {
            const columnar = columnarOf(headers, 5);
            render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} highlightDisplay="line" />);
            const option = capturedOptions[capturedOptions.length - 1];
            expect(option.series).toHaveLength(3); // no overlays added
            expect(option.series[0].markArea).toBeUndefined();
            expect(typeof option.series[0].data[0]).toBe('number');
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

        it('dedupes by seriesName, keeping only the first entry -- defends against a highlight overlay series (same name as its sensor) appearing twice regardless of whether ECharts actually honours that series\' tooltip.show:false for axis-trigger aggregation', () => {
            const columnar = columnarOf(['A'], 3);
            render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
            const { formatter } = capturedOptions[capturedOptions.length - 1].tooltip;
            const html = formatter([
                { axisValueLabel: '2026-01-01T00:00:00', seriesName: 'A', value: 5, color: '#3b82f6' }, // base series
                { axisValueLabel: '2026-01-01T00:00:00', seriesName: 'A', value: 5, color: '#ff0000' }, // highlight overlay, same sensor
            ]);
            expect((html.match(/A:/g) ?? [])).toHaveLength(1);
            expect(html).toContain('#3b82f6'); // the FIRST (base series) entry wins, not the overlay
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

describe('Tag Point (click a point on the chart to compare it with others)', () => {
    const headers = ['A', 'B'];

    it('renders the toolbox with a Tag toggle, off by default', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        const tools = container.querySelectorAll('.line-chart-tool');
        expect(tools.length).toBe(1); // just the toggle — Clear all only appears once tags exist
        expect(tools[0].className).not.toContain('active');
    });

    it('activates the toggle on click', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]);
        expect(container.querySelectorAll('.line-chart-tool')[0].className).toContain('active');
    });

    it('does nothing on a chart click while tag mode is off', () => {
        const columnar = columnarOf(headers, 5);
        const onChange = vi.fn();
        render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} onLineTaggedPointsChange={onChange} />);
        expect(zrClickHandler).not.toBeNull();
        onChange.mockClear();
        act(() => { zrClickHandler!({ offsetX: 10, offsetY: 10 }); });
        expect(onChange).not.toHaveBeenCalled();
        expect(capturedOptions[capturedOptions.length - 1].series[0].markPoint).toBeUndefined();
    });

    it('resolves the clicked pixel via convertFromPixel({ seriesIndex: 0 }, ...), reading result[0] as the index (regression: { xAxisIndex: 0 } returns NaN for a category axis on real echarts -- confirmed against the actual installed package outside this test\'s mock -- and silently broke every click)', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]);
        mockConvertFromPixel.mockReturnValue([3, 0]);
        act(() => { zrClickHandler!({ offsetX: 10, offsetY: 10 }); });
        expect(mockConvertFromPixel).toHaveBeenCalledWith({ seriesIndex: 0 }, expect.any(Array));
        expect(mockConvertFromPixel).not.toHaveBeenCalledWith({ xAxisIndex: 0 }, expect.anything());
        expect(capturedOptions[capturedOptions.length - 1].series[0].markPoint.data[0].coord[0]).toBe(3);
    });

    it('tags the nearest point on click while tag mode is on, reporting it via onLineTaggedPointsChange', () => {
        const columnar = columnarOf(headers, 5);
        const onChange = vi.fn();
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]); // enable tag mode
        mockConvertFromPixel.mockReturnValue([2, 0]); // → index 2 (00:02)
        act(() => { zrClickHandler!({ offsetX: 50, offsetY: 50 }); });
        expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ timestamp: '2026-01-01T00:02:00' })]);
        const markPoint = capturedOptions[capturedOptions.length - 1].series[0].markPoint;
        expect(markPoint.data).toHaveLength(1);
        expect(markPoint.data[0].coord[0]).toBe(2);
        expect(markPoint.data[0].label.formatter).toContain('①');
    });

    it('ignores a click outside the plot grid (containPixel false)', () => {
        const columnar = columnarOf(headers, 5);
        const onChange = vi.fn();
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]);
        mockContainPixel.mockReturnValue(false);
        onChange.mockClear();
        act(() => { zrClickHandler!({ offsetX: 10, offsetY: 10 }); });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('clicking an already-tagged point again removes it (toggle, not a separate badge click)', () => {
        const columnar = columnarOf(headers, 5);
        const onChange = vi.fn();
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]);
        mockConvertFromPixel.mockReturnValue([1, 0]);
        act(() => { zrClickHandler!({ offsetX: 10, offsetY: 10 }); }); // tag
        act(() => { zrClickHandler!({ offsetX: 10, offsetY: 10 }); }); // untag
        expect(onChange).toHaveBeenLastCalledWith([]);
        expect(capturedOptions[capturedOptions.length - 1].series[0].markPoint).toBeUndefined();
    });

    it('does not show a delta comparison line for a second tag (removed per user feedback -- not used)', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]);
        mockConvertFromPixel.mockReturnValue([0, 0]);
        act(() => { zrClickHandler!({ offsetX: 1, offsetY: 1 }); });
        mockConvertFromPixel.mockReturnValue([3, 0]);
        act(() => { zrClickHandler!({ offsetX: 2, offsetY: 2 }); });
        const data = capturedOptions[capturedOptions.length - 1].series[0].markPoint.data;
        expect(data).toHaveLength(2);
        expect(data[0].label.formatter).not.toContain('Δ');
        expect(data[1].label.formatter).not.toContain('Δ');
    });

    it('aligns the callout left for a tag at the left edge (its value there is also this series\' minimum, so no vertical flip is needed)', () => {
        // columnarOf(headers, 10) -> series[0] (sensor 'A') is [0,1,...,9],
        // monotonically increasing, so index 0 is simultaneously the
        // leftmost x-position AND the series minimum.
        const columnar = columnarOf(headers, 10);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]);
        mockConvertFromPixel.mockReturnValue([0, 0]);
        act(() => { zrClickHandler!({ offsetX: 1, offsetY: 1 }); });
        const [entry] = capturedOptions[capturedOptions.length - 1].series[0].markPoint.data;
        expect(entry.label.align).toBe('left');
        expect(entry.label.position).toBe('top'); // low value -- no clipping risk above it
    });

    it('flips the callout right-aligned and below the point for a tag at the right edge whose value is also this series\' maximum', () => {
        const columnar = columnarOf(headers, 10);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]);
        mockConvertFromPixel.mockReturnValue([9, 0]); // rightmost index, series[0]'s max value (9)
        act(() => { zrClickHandler!({ offsetX: 1, offsetY: 1 }); });
        const [entry] = capturedOptions[capturedOptions.length - 1].series[0].markPoint.data;
        expect(entry.label.align).toBe('right');
        expect(entry.label.position).toBe('bottom'); // high value -- 'top' would clip above the chart
    });

    it('centres the callout (default top/center) for a tag away from every edge', () => {
        const columnar = columnarOf(headers, 10);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]);
        mockConvertFromPixel.mockReturnValue([5, 0]); // middle index
        act(() => { zrClickHandler!({ offsetX: 1, offsetY: 1 }); });
        const [entry] = capturedOptions[capturedOptions.length - 1].series[0].markPoint.data;
        expect(entry.label.align).toBe('center');
        expect(entry.label.position).toBe('top');
    });

    it('caps at 8 tagged points (one per RANGE_PALETTE colour)', () => {
        const columnar = columnarOf(headers, 10);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(container.querySelectorAll('.line-chart-tool')[0]);
        for (let i = 0; i < 9; i++) {
            mockConvertFromPixel.mockReturnValue([i, 0]);
            act(() => { zrClickHandler!({ offsetX: i, offsetY: i }); });
        }
        expect(capturedOptions[capturedOptions.length - 1].series[0].markPoint.data).toHaveLength(8);
    });

    it('seeds tagged points from the lineTaggedPoints prop on mount (persistence across chart-type switches)', () => {
        const columnar = columnarOf(headers, 5);
        const seeded = [{ id: 't1', timestamp: '2026-01-01T00:01:00', color: '#f59e0b' }];
        render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} lineTaggedPoints={seeded} />);
        const markPoint = capturedOptions[capturedOptions.length - 1].series[0].markPoint;
        expect(markPoint.data).toHaveLength(1);
        expect(markPoint.data[0].itemStyle.color).toBe('#f59e0b');
    });

    it('shows "Clear all" only once a tag exists, and it clears every tag', () => {
        const columnar = columnarOf(headers, 5);
        const seeded = [{ id: 't1', timestamp: '2026-01-01T00:01:00', color: '#f59e0b' }];
        const onChange = vi.fn();
        const { container } = render(
            <LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} lineTaggedPoints={seeded} onLineTaggedPointsChange={onChange} />,
        );
        const tools = container.querySelectorAll('.line-chart-tool');
        expect(tools.length).toBe(2); // toggle + Clear all
        fireEvent.click(tools[1]);
        expect(onChange).toHaveBeenLastCalledWith([]);
        expect(container.querySelectorAll('.line-chart-tool').length).toBe(1); // Clear all disappears
    });
});
