import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, fireEvent, act, screen, within } from '@testing-library/react';
import { formatDateTime } from '../utils/dateFormat';

const capturedOptions: any[] = [];
/** Fake echarts instance handed to `onChartReady`, exposing just enough of
 *  the real API (getZr/containPixel/convertFromPixel/dispatchAction) for
 *  the Tag Point and Horizontal Zoom click/drag-handling tests below.
 *  `zrClickHandler`/`zrMouseDownHandler`/`zrMouseMoveHandler`/
 *  `zrMouseUpHandler` capture the listeners LineChart registers via
 *  `getZr().on(...)` so tests can invoke them directly, the same way real
 *  zrender canvas events would. */
let zrClickHandler: ((event: any) => void) | null = null;
let zrMouseDownHandler: ((event: any) => void) | null = null;
let zrMouseMoveHandler: ((event: any) => void) | null = null;
let zrMouseUpHandler: ((event: any) => void) | null = null;
const mockContainPixel = vi.fn(() => true);
// `convertFromPixel({ seriesIndex: 0 }, pixel)` resolves through the
// series' own coordinate system and returns `[xValue, yValue]` in the
// axis's native units (confirmed against the real installed echarts
// package -- see LineChart.tsx's comment on the click handler) -- a
// category INDEX before the axis was switched to 'time', a raw ms
// TIMESTAMP now. Mocked as an array here so these tests actually exercise
// that return shape.
const mockConvertFromPixel = vi.fn(() => [0, 0]);
const mockDispatchAction = vi.fn();
const mockZr = {
    on: vi.fn((evt: string, cb: (event: any) => void) => {
        if (evt === 'click') zrClickHandler = cb;
        if (evt === 'mousedown') zrMouseDownHandler = cb;
        if (evt === 'mousemove') zrMouseMoveHandler = cb;
        if (evt === 'mouseup') zrMouseUpHandler = cb;
    }),
    off: vi.fn(),
};
const mockChartInstance = {
    getZr: () => mockZr,
    containPixel: mockContainPixel,
    convertFromPixel: mockConvertFromPixel,
    dispatchAction: mockDispatchAction,
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

import LineChart, { LINE_CHART_COLORS, defaultSensorColor } from '../components/charts/LineChart';
import type { ColumnarSeries } from '../components/charts/ChartTypes';

function columnarOf(headers: string[], length: number): ColumnarSeries {
    const timestamps = Array.from({ length }, (_, i) => `2026-01-01T00:${String(i).padStart(2, '0')}:00`);
    const series = headers.map((_, hi) => Array.from({ length }, (_, i) => hi * 100 + i));
    return { timestamps, series };
}

/** Epoch ms of an ISO timestamp string -- matches how LineChart.tsx itself
 *  converts `xData` entries (`toMs`) for a time-axis series/markArea/coord,
 *  so tests assert against the same value production code computes rather
 *  than a hardcoded epoch number. */
function msOf(ts: string): number {
    return new Date(ts).getTime();
}

/** Pairs a plain value array with `columnar`'s own timestamps, the shape a
 *  time-axis series now needs (`[x_ms, y]` per point) instead of the old
 *  category-axis bare-value array. */
function pairs(columnar: ColumnarSeries, values: (number | null)[]): (number | null)[][] {
    return values.map((v, i) => [msOf(columnar.timestamps[i]), v]);
}

/** The Tag Point toggle button specifically — found by its stable `title`
 *  prefix rather than array position, since the toolbox also renders a Zoom
 *  button before it (and a Clear-all button after, once tags exist), so
 *  `.line-chart-tool` order alone isn't a reliable way to find it. */
function tagToggle(container: HTMLElement): HTMLElement {
    return container.querySelector('[title^="Tag point"]') as HTMLElement;
}

beforeEach(() => {
    capturedOptions.length = 0;
    zrClickHandler = null;
    zrMouseDownHandler = null;
    zrMouseMoveHandler = null;
    zrMouseUpHandler = null;
    mockContainPixel.mockClear().mockReturnValue(true);
    mockConvertFromPixel.mockClear().mockReturnValue([0, 0]);
    mockDispatchAction.mockClear();
    mockZr.on.mockClear();
    mockZr.off.mockClear();
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
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

describe('LINE_CHART_COLORS', () => {
    it('has more than 6 entries (regression: a 7th selected sensor wrapped back to the 1st sensor\'s exact color)', () => {
        expect(LINE_CHART_COLORS.length).toBeGreaterThan(6);
    });

    it('has no duplicate hex values', () => {
        expect(new Set(LINE_CHART_COLORS).size).toBe(LINE_CHART_COLORS.length);
    });

    it('starts with a maximally-distinct blue/emerald/rose triad for the common few-sensor case', () => {
        expect(LINE_CHART_COLORS.slice(0, 3)).toEqual(['#3b82f6', '#10b981', '#f43f5e']);
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
        // No slider reservation anymore (the dataZoom 'slider' component was
        // removed in favour of the toolbox's Horizontal Zoom tool) — just
        // the x-axis label height + its gap.
        expect(grid.bottom).toBe(30); // 24 + 6
        expect(dataZoom).toHaveLength(1); // just 'inside', no 'slider'
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

    it('yAxis label formatter rounds to at most 3 decimals and drops trailing zeros', () => {
        // Explicit min/max (widened by a markLine, as above) are raw floats,
        // not "nice" round numbers -- ECharts would otherwise label them at
        // full precision (e.g. 7.687984495640254).
        const columnar: ColumnarSeries = { timestamps: ['t0'], series: [[10]] };
        render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        const [yA] = capturedOptions[capturedOptions.length - 1].yAxis;
        expect(yA.axisLabel.formatter(7.687984495640254)).toBe('7.688');
        expect(yA.axisLabel.formatter(-0.5694803330103893)).toBe('-0.569');
        expect(yA.axisLabel.formatter(6)).toBe('6'); // round values don't grow trailing zeros
        expect(yA.axisLabel.formatter(0)).toBe('0');
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
                expect.objectContaining({ xAxis: msOf(columnar.timestamps[1]) }), // 00:01 → index 1
                expect.objectContaining({ xAxis: msOf(columnar.timestamps[3]) }), // 00:03 → index 3
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

    describe('time highlights always draw as a band (the Band / Line colour switch was removed 2026-10-08)', () => {
        const highlight = { id: 'h1', start: '2026-01-01T00:01:00', end: '2026-01-01T00:03:00', label: 'Startup', color: '#ff0000', enabled: true };

        it('attaches a markArea band and adds no extra overlay series -- one series per sensor, base data untouched', () => {
            const columnar = columnarOf(headers, 5);
            render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} timeHighlights={[highlight]} />);
            const option = capturedOptions[capturedOptions.length - 1];
            expect(option.series).toHaveLength(3); // one per sensor, no recolour overlays any more
            expect(option.series[0].markArea).toBeDefined();
            option.series.forEach((s: any, i: number) => {
                expect(s.itemStyle.color).toBe(defaultSensorColor(headers[i])); // never recoloured
                expect(s.data).toEqual(pairs(columnar, [i * 100, i * 100 + 1, i * 100 + 2, i * 100 + 3, i * 100 + 4]));
            });
        });

        it('a legacy highlightDisplay="line" prop (an old caller / saved setting) is ignored -- still a band, no overlays', () => {
            const columnar = columnarOf(headers, 5);
            const legacyProps = { highlightDisplay: 'line' } as Record<string, unknown>;
            render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} timeHighlights={[highlight]} {...legacyProps} />);
            const option = capturedOptions[capturedOptions.length - 1];
            expect(option.series).toHaveLength(3);
            expect(option.series[0].markArea.data).toHaveLength(1);
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

    describe('dataZoom resets to the full view when the underlying range actually changes (regression: ECharts preserves a dataZoom window across setOption by design, so zooming in then widening the Time Range filter left the chart stuck showing only a sliver of the new, larger dataset -- reported 2026-09-16)', () => {
        it('a rerender with the SAME time range (identical first/last timestamp and point count) does not force start/end -- an in-progress pan/zoom is left alone', () => {
            const columnar = columnarOf(['A'], 5);
            const { rerender } = render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
            // Some other, unrelated prop change (mirrors a real re-render
            // cause like tagging a point or resizing a panel) -- same
            // columnar object, so the range identity is unchanged.
            rerender(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} hideYSplitLine />);
            const { dataZoom } = capturedOptions[capturedOptions.length - 1];
            expect(dataZoom[0].start).toBeUndefined();
        });

        it('a rerender with a WIDER time range (different first/last timestamp) forces dataZoom back to start:0, end:100', () => {
            const narrow = columnarOf(['A'], 5); // 2026-01-01T00:00 .. 00:04
            const { rerender } = render(<LineChart data={[]} columnar={narrow} sensors={['A']} headers={['A']} />);

            const wider: ColumnarSeries = {
                timestamps: Array.from({ length: 20 }, (_, i) => `2026-01-01T00:${String(i).padStart(2, '0')}:00`),
                series: [Array.from({ length: 20 }, (_, i) => i)],
            };
            rerender(<LineChart data={[]} columnar={wider} sensors={['A']} headers={['A']} />);
            const { dataZoom } = capturedOptions[capturedOptions.length - 1];
            expect(dataZoom[0].start).toBe(0);
            expect(dataZoom[0].end).toBe(100);
        });

        it('does not keep forcing start/end on every subsequent render after the range-change render itself', () => {
            const narrow = columnarOf(['A'], 5);
            const { rerender } = render(<LineChart data={[]} columnar={narrow} sensors={['A']} headers={['A']} />);
            const wider: ColumnarSeries = {
                timestamps: Array.from({ length: 20 }, (_, i) => `2026-01-01T00:${String(i).padStart(2, '0')}:00`),
                series: [Array.from({ length: 20 }, (_, i) => i)],
            };
            rerender(<LineChart data={[]} columnar={wider} sensors={['A']} headers={['A']} />);
            // A further render with the SAME wider range -- the one-time
            // reset must not keep re-firing on every option rebuild after.
            rerender(<LineChart data={[]} columnar={wider} sensors={['A']} headers={['A']} hideYSplitLine />);
            const { dataZoom } = capturedOptions[capturedOptions.length - 1];
            expect(dataZoom[0].start).toBeUndefined();
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

        it('renders a date header and rounds values to 3 decimals, appending the sensor unit (regression: for a time axis, ECharts\' `p.value` is the whole [x_ms, y] point -- matching this component\'s own series.data shape -- not just y; an earlier version of this fix printed the raw pair as e.g. "1756872000000,6425.3" in the tooltip)', () => {
            const columnar = columnarOf(['A'], 3);
            render(
                <LineChart
                    data={[]} columnar={columnar} sensors={['A']} headers={['A']}
                    sensorMetadata={[{ tag: 'A', description: 'd', unit: 'bar', component: 'x' }]}
                />,
            );
            const { formatter } = capturedOptions[capturedOptions.length - 1].tooltip;
            const ms = msOf('2026-01-01T00:00:00');
            const html = formatter([
                { axisValue: ms, seriesName: 'A', value: [ms, 12.34567], color: '#fff' },
            ]);
            expect(html).toContain('12.346 bar');
            expect(html).not.toContain(String(ms)); // the raw ms must never leak into the displayed value
            expect(html).toContain('2026/01/01');
        });

        it('omits the unit segment when the sensor has none in metadata', () => {
            const columnar = columnarOf(['A'], 3);
            render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
            const { formatter } = capturedOptions[capturedOptions.length - 1].tooltip;
            const ms = msOf('2026-01-01T00:00:00');
            const html = formatter([
                { axisValue: ms, seriesName: 'A', value: [ms, 5], color: '#fff' },
            ]);
            expect(html).toContain('A: 5');
            expect(html).not.toContain('undefined');
        });

        it('caps the number of rendered rows at 10', () => {
            const columnar = columnarOf(['A'], 3);
            render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
            const { formatter } = capturedOptions[capturedOptions.length - 1].tooltip;
            const ms = msOf('2026-01-01T00:00:00');
            const params = Array.from({ length: 15 }, (_, i) => ({
                axisValue: ms, seriesName: `S${i}`, value: [ms, i], color: '#fff',
            }));
            const html = formatter(params);
            expect((html.match(/S\d+:/g) ?? [])).toHaveLength(10);
        });
    });

    it("xAxis label formatter renders the shared YYYY/MM/DD date format", () => {
        const columnar = columnarOf(['A'], 3);
        render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        const { formatter } = capturedOptions[capturedOptions.length - 1].xAxis.axisLabel;
        // A time axis hands its formatter a numeric ms value, not the raw
        // date string a category axis' shared `xAxis.data` used to carry.
        expect(formatter(msOf('2026-03-09T00:00:00'))).toBe('2026/03/09');
    });

    it("xAxis is a time axis, not a category axis (regression: a category axis spaces every point equally by index regardless of real elapsed time, so a 10-minute gap and a 10-hour gap between points rendered at the same pixel width)", () => {
        const columnar = columnarOf(['A'], 3);
        render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        const { xAxis } = capturedOptions[capturedOptions.length - 1];
        expect(xAxis.type).toBe('time');
        expect(xAxis.data).toBeUndefined(); // no shared category array anymore
    });

    it('respects hideYSplitLine by hiding the first axis split line', () => {
        const columnar = columnarOf(['A'], 3);
        const { rerender } = render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        expect(capturedOptions[capturedOptions.length - 1].yAxis[0].splitLine.show).toBe(true);

        rerender(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} hideYSplitLine />);
        expect(capturedOptions[capturedOptions.length - 1].yAxis[0].splitLine.show).toBe(false);
    });

    it('colors the axis with the fixed dark palette', () => {
        // Visual refresh (2026-10-02): recoloured from a leftover slate-blue
        // palette to match the app's own `--text-secondary` token value —
        // see LineChart.tsx's matching comment.
        const columnar = columnarOf(['A'], 3);
        render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        expect(capturedOptions[capturedOptions.length - 1].xAxis.axisLabel.color).toBe('#8c8c94');
    });

    it('falls back to row-based `data`/`headers` indexing when no columnar feed is supplied', () => {
        const data = [
            { timestamp: '2026-01-01T00:00:00', values: [1, 2] },
            { timestamp: '2026-01-01T00:01:00', values: [3, 4] },
        ] as any;
        render(<LineChart data={data} sensors={['B']} headers={['A', 'B']} />);
        const option = capturedOptions[capturedOptions.length - 1];
        expect(option.xAxis.data).toBeUndefined();
        expect(option.series[0].data).toEqual([
            [msOf('2026-01-01T00:00:00'), 2],
            [msOf('2026-01-01T00:01:00'), 4],
        ]);
    });
});

describe('Tag Point (click a point on the chart to compare it with others)', () => {
    const headers = ['A', 'B'];

    it('renders the toolbox with a Zoom button and a Tag toggle (off by default)', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        // Zoom + Tag toggle — Clear all only appears once tags exist.
        expect(container.querySelectorAll('.line-chart-tool').length).toBe(2);
        expect(tagToggle(container).className).not.toContain('active');
    });

    it('activates the toggle on click', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(tagToggle(container));
        expect(tagToggle(container).className).toContain('active');
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

    it('resolves the clicked pixel via convertFromPixel({ seriesIndex: 0 }, ...), reading result[0] as a raw ms timestamp then snapping it to the nearest plotted point (regression: { xAxisIndex: 0 } returns NaN on real echarts regardless of axis type -- switching to it when the axis became "time" broke every Tag Point click in the real app; confirmed by the user, since this app can\'t be opened in a browser preview to catch it before shipping)', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(tagToggle(container));
        mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[3]), 0]);
        act(() => { zrClickHandler!({ offsetX: 10, offsetY: 10 }); });
        expect(mockConvertFromPixel).toHaveBeenCalledWith({ seriesIndex: 0 }, expect.any(Array));
        expect(mockConvertFromPixel).not.toHaveBeenCalledWith({ xAxisIndex: 0 }, expect.anything());
        expect(capturedOptions[capturedOptions.length - 1].series[0].markPoint.data[0].coord[0]).toBe(msOf(columnar.timestamps[3]));
    });

    it('tags the nearest point on click while tag mode is on, reporting it via onLineTaggedPointsChange', () => {
        const columnar = columnarOf(headers, 5);
        const onChange = vi.fn();
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(tagToggle(container)); // enable tag mode
        mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[2]), 0]); // → index 2 (00:02)
        act(() => { zrClickHandler!({ offsetX: 50, offsetY: 50 }); });
        expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ timestamp: '2026-01-01T00:02:00' })]);
        const markPoint = capturedOptions[capturedOptions.length - 1].series[0].markPoint;
        expect(markPoint.data).toHaveLength(1);
        expect(markPoint.data[0].coord[0]).toBe(msOf(columnar.timestamps[2]));
        expect(markPoint.data[0].label.formatter).toContain('①');
    });

    it('ignores a click outside the plot grid (containPixel false)', () => {
        const columnar = columnarOf(headers, 5);
        const onChange = vi.fn();
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(tagToggle(container));
        mockContainPixel.mockReturnValue(false);
        onChange.mockClear();
        act(() => { zrClickHandler!({ offsetX: 10, offsetY: 10 }); });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('clicking an already-tagged point again removes it (toggle, not a separate badge click)', () => {
        const columnar = columnarOf(headers, 5);
        const onChange = vi.fn();
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(tagToggle(container));
        mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[1]), 0]);
        act(() => { zrClickHandler!({ offsetX: 10, offsetY: 10 }); }); // tag
        act(() => { zrClickHandler!({ offsetX: 10, offsetY: 10 }); }); // untag
        expect(onChange).toHaveBeenLastCalledWith([]);
        expect(capturedOptions[capturedOptions.length - 1].series[0].markPoint).toBeUndefined();
    });

    it('does not show a delta comparison line for a second tag (removed per user feedback -- not used)', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(tagToggle(container));
        mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[0]), 0]);
        act(() => { zrClickHandler!({ offsetX: 1, offsetY: 1 }); });
        mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[3]), 0]);
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
        fireEvent.click(tagToggle(container));
        mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[0]), 0]);
        act(() => { zrClickHandler!({ offsetX: 1, offsetY: 1 }); });
        const [entry] = capturedOptions[capturedOptions.length - 1].series[0].markPoint.data;
        expect(entry.label.align).toBe('left');
        expect(entry.label.position).toBe('top'); // low value -- no clipping risk above it
    });

    it('flips the callout right-aligned and below the point for a tag at the right edge whose value is also this series\' maximum', () => {
        const columnar = columnarOf(headers, 10);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(tagToggle(container));
        mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[9]), 0]); // rightmost index, series[0]'s max value (9)
        act(() => { zrClickHandler!({ offsetX: 1, offsetY: 1 }); });
        const [entry] = capturedOptions[capturedOptions.length - 1].series[0].markPoint.data;
        expect(entry.label.align).toBe('right');
        expect(entry.label.position).toBe('bottom'); // high value -- 'top' would clip above the chart
    });

    it('centres the callout (default top/center) for a tag away from every edge', () => {
        const columnar = columnarOf(headers, 10);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(tagToggle(container));
        mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[5]), 0]); // middle index
        act(() => { zrClickHandler!({ offsetX: 1, offsetY: 1 }); });
        const [entry] = capturedOptions[capturedOptions.length - 1].series[0].markPoint.data;
        expect(entry.label.align).toBe('center');
        expect(entry.label.position).toBe('top');
    });

    it('caps at 8 tagged points (one per RANGE_PALETTE colour)', () => {
        const columnar = columnarOf(headers, 10);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(tagToggle(container));
        for (let i = 0; i < 9; i++) {
            mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[i]), 0]);
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
        // Zoom + Tag toggle + Clear all.
        expect(container.querySelectorAll('.line-chart-tool').length).toBe(3);
        const clearAll = container.querySelector('[title="Clear all tags"]') as HTMLElement;
        fireEvent.click(clearAll);
        expect(onChange).toHaveBeenLastCalledWith([]);
        expect(container.querySelectorAll('.line-chart-tool').length).toBe(2); // Clear all disappears, Zoom + Tag toggle remain
    });
});

describe('Tag Point -- removing ONE tag from the tag list (customer request 2026-10-08: tags could only be cleared all at once)', () => {
    const headers = ['A', 'B'];
    const seeded = [
        { id: 't1', timestamp: '2026-01-01T00:01:00', color: '#aa0000' },
        { id: 't2', timestamp: '2026-01-01T00:02:00', color: '#00aa00' },
        { id: 't3', timestamp: '2026-01-01T00:03:00', color: '#0000aa' },
    ];
    const label = (ts: string) => formatDateTime(new Date(ts));

    it('shows no tag list until a tag exists', () => {
        render(<LineChart data={[]} columnar={columnarOf(headers, 5)} sensors={headers} headers={headers} />);
        expect(screen.queryByRole('list', { name: 'Tagged points' })).toBeNull();
    });

    it('lists every tag with its badge, time and its own keyboard-reachable remove button', () => {
        render(<LineChart data={[]} columnar={columnarOf(headers, 5)} sensors={headers} headers={headers} lineTaggedPoints={seeded} />);
        const list = screen.getByRole('list', { name: 'Tagged points' });
        const rows = within(list).getAllByRole('listitem');
        expect(rows.map(r => r.textContent)).toEqual(seeded.map((t, i) => `${['①', '②', '③'][i]}${label(t.timestamp)}`));
        const removeButtons = within(list).getAllByRole('button', { name: /^Remove tag/ });
        expect(removeButtons).toHaveLength(3);
        removeButtons.forEach(b => expect(b.tagName).toBe('BUTTON')); // native button: Tab + Enter/Space for free
    });

    it('the x removes exactly that tag, keeps the others with their own colours, and reports the new list', () => {
        const onChange = vi.fn();
        render(<LineChart data={[]} columnar={columnarOf(headers, 5)} sensors={headers} headers={headers} lineTaggedPoints={seeded} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: `Remove tag ② ${label(seeded[1].timestamp)}` }));

        expect(onChange).toHaveBeenLastCalledWith([seeded[0], seeded[2]]);
        const markPoint = capturedOptions[capturedOptions.length - 1].series[0].markPoint;
        expect(markPoint.data.map((d: any) => d.itemStyle.color)).toEqual(['#aa0000', '#0000aa']);
        expect(markPoint.data[1].label.formatter).toContain('②'); // badges renumber by position
        const rows = within(screen.getByRole('list', { name: 'Tagged points' })).getAllByRole('listitem');
        expect(rows).toHaveLength(2);
        // "Clear all" is still offered for the rest.
        expect(document.querySelector('[title="Clear all tags"]')).not.toBeNull();
    });

    it('works with tag mode off (no need to enter tag mode just to remove one)', () => {
        const onChange = vi.fn();
        const { container } = render(<LineChart data={[]} columnar={columnarOf(headers, 5)} sensors={headers} headers={headers} lineTaggedPoints={seeded} onLineTaggedPointsChange={onChange} />);
        expect(tagToggle(container).className).not.toContain('active');
        fireEvent.click(screen.getByRole('button', { name: `Remove tag ① ${label(seeded[0].timestamp)}` }));
        expect(onChange).toHaveBeenLastCalledWith([seeded[1], seeded[2]]);
    });

    it('removing the last tag hides the list and the Clear all button', () => {
        const onChange = vi.fn();
        render(<LineChart data={[]} columnar={columnarOf(headers, 5)} sensors={headers} headers={headers} lineTaggedPoints={[seeded[0]]} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: /^Remove tag ①/ }));
        expect(onChange).toHaveBeenLastCalledWith([]);
        expect(screen.queryByRole('list', { name: 'Tagged points' })).toBeNull();
        expect(document.querySelector('[title="Clear all tags"]')).toBeNull();
        expect(capturedOptions[capturedOptions.length - 1].series[0].markPoint).toBeUndefined();
    });

    it('Clear all still clears every tag at once', () => {
        const onChange = vi.fn();
        render(<LineChart data={[]} columnar={columnarOf(headers, 5)} sensors={headers} headers={headers} lineTaggedPoints={seeded} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(document.querySelector('[title="Clear all tags"]') as HTMLElement);
        expect(onChange).toHaveBeenLastCalledWith([]);
        expect(screen.queryByRole('list', { name: 'Tagged points' })).toBeNull();
    });

    it('a tag added after removing a middle one takes the freed colour instead of duplicating one still on the chart', () => {
        const columnar = columnarOf(headers, 5);
        const onChange = vi.fn();
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} onLineTaggedPointsChange={onChange} />);
        fireEvent.click(tagToggle(container));
        for (const i of [0, 1, 2]) {
            mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[i]), 0]);
            act(() => { zrClickHandler!({ offsetX: i, offsetY: i }); });
        }
        const before = onChange.mock.calls[onChange.mock.calls.length - 1][0].map((t: any) => t.color);
        fireEvent.click(screen.getByRole('button', { name: /^Remove tag ②/ }));
        mockConvertFromPixel.mockReturnValue([msOf(columnar.timestamps[4]), 0]);
        act(() => { zrClickHandler!({ offsetX: 4, offsetY: 4 }); });
        const after = onChange.mock.calls[onChange.mock.calls.length - 1][0].map((t: any) => t.color);
        expect(after).toHaveLength(3);
        expect(new Set(after).size).toBe(3);
        expect(after).toEqual([before[0], before[2], before[1]]);
    });

    it('keyboard focus moves to the next row’s ×, then to the toolbox Tag button once the last tag is gone', () => {
        const { container } = render(<LineChart data={[]} columnar={columnarOf(headers, 5)} sensors={headers} headers={headers} lineTaggedPoints={seeded.slice(0, 2)} />);
        const first = screen.getByRole('button', { name: /^Remove tag ①/ });
        first.focus();
        fireEvent.click(first);
        // The former ② row is now ① and holds focus.
        expect(document.activeElement).toBe(screen.getByRole('button', { name: `Remove tag ① ${label(seeded[1].timestamp)}` }));
        fireEvent.click(document.activeElement as HTMLElement);
        expect(screen.queryByRole('list', { name: 'Tagged points' })).toBeNull();
        expect(document.activeElement).toBe(tagToggle(container));
    });

    it('each row names the SAME instant as its marker callout: the stored timestamp snapped to the nearest plotted point, re-resolved after a refetch', () => {
        // A tag stored at 00:01:20 (e.g. pinned on a finer aggregation) on a
        // chart whose points are 00:00, 00:01, ... -> both resolve to 00:01.
        const tag = [{ id: 'tx', timestamp: '2026-01-01T00:01:20', color: '#aa0000' }];
        const { rerender } = render(<LineChart data={[]} columnar={columnarOf(headers, 5)} sensors={headers} headers={headers} lineTaggedPoints={tag} />);
        const rowText = () => within(screen.getByRole('list', { name: 'Tagged points' })).getAllByRole('listitem')[0].textContent;
        const calloutHead = () => String(capturedOptions[capturedOptions.length - 1].series[0].markPoint.data[0].label.formatter).split('\n')[0];
        expect(rowText()).toBe(`①${label('2026-01-01T00:01:00')}`);
        expect(calloutHead()).toContain(label('2026-01-01T00:01:00'));

        // Refetch onto a coarser 5-minute grid: the marker snaps to 00:00,
        // and the list must follow it rather than keep the stored 00:01:20.
        const coarse: ColumnarSeries = {
            timestamps: ['2026-01-01T00:00:00', '2026-01-01T00:05:00', '2026-01-01T00:10:00'],
            series: headers.map(() => [1, 2, 3]),
        };
        rerender(<LineChart data={[]} columnar={coarse} sensors={headers} headers={headers} lineTaggedPoints={tag} />);
        expect(rowText()).toBe(`①${label('2026-01-01T00:00:00')}`);
        expect(calloutHead()).toContain(label('2026-01-01T00:00:00'));
        expect(screen.getByRole('button', { name: `Remove tag ① ${label('2026-01-01T00:00:00')}` })).toBeTruthy();
    });
});

describe('Horizontal Zoom (drag across the chart to zoom into a range — replaces the old always-visible dataZoom slider)', () => {
    const headers = ['A', 'B'];

    /** The Zoom tool button specifically — found by its stable `title`,
     *  same reasoning as `tagToggle`. */
    function zoomButton(container: HTMLElement): HTMLElement {
        return container.querySelector('[title="Zoom"]') as HTMLElement;
    }

    it('renders the menu closed by default; opens on click, with a Horizontal zoom and a Zoom out item', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        expect(container.querySelector('.line-chart-zoom-menu')).toBeNull();
        fireEvent.click(zoomButton(container));
        const menu = container.querySelector('.line-chart-zoom-menu');
        expect(menu).not.toBeNull();
        expect(menu!.textContent).toContain('Horizontal zoom');
        expect(menu!.textContent).toContain('Zoom out');
    });

    it('clicking "Horizontal zoom" arms zoom-select mode (Zoom button goes active), closes the menu, and turns off an active Tag mode', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(tagToggle(container)); // tag mode on first
        expect(tagToggle(container).className).toContain('active');

        fireEvent.click(zoomButton(container));
        fireEvent.click(container.querySelector('.line-chart-zoom-menu-item') as HTMLElement); // "Horizontal zoom" is first
        expect(zoomButton(container).className).toContain('active');
        expect(container.querySelector('.line-chart-zoom-menu')).toBeNull(); // menu closed
        expect(tagToggle(container).className).not.toContain('active'); // mutually exclusive with Tag mode
    });

    it('clicking "Zoom out" dispatches a dataZoom reset action and closes the menu', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(zoomButton(container));
        const items = container.querySelectorAll('.line-chart-zoom-menu-item');
        fireEvent.click(items[1]); // "Zoom out" is second
        expect(mockDispatchAction).toHaveBeenCalledWith({ type: 'dataZoom', start: 0, end: 100 });
        expect(container.querySelector('.line-chart-zoom-menu')).toBeNull();
    });

    it('clicking outside the menu closes it without arming zoom-select mode', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(zoomButton(container));
        expect(container.querySelector('.line-chart-zoom-menu')).not.toBeNull();
        fireEvent.mouseDown(document.body);
        expect(container.querySelector('.line-chart-zoom-menu')).toBeNull();
        expect(zoomButton(container).className).not.toContain('active');
    });

    it('dragging across the chart while armed resolves both endpoints via convertFromPixel({ seriesIndex: 0 }, ...) and dispatches a dataZoom action with startValue/endValue, then disarms (one-shot)', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(zoomButton(container));
        fireEvent.click(container.querySelector('.line-chart-zoom-menu-item') as HTMLElement); // arm Horizontal zoom
        expect(zoomButton(container).className).toContain('active');

        mockConvertFromPixel
            .mockReturnValueOnce([msOf(columnar.timestamps[1]), 0]) // drag start
            .mockReturnValueOnce([msOf(columnar.timestamps[3]), 0]); // drag end
        act(() => { zrMouseDownHandler!({ offsetX: 20, offsetY: 20 }); });
        act(() => { zrMouseMoveHandler!({ offsetX: 60, offsetY: 20 }); });
        act(() => { zrMouseUpHandler!({ offsetX: 100, offsetY: 20 }); });

        expect(mockConvertFromPixel).toHaveBeenCalledWith({ seriesIndex: 0 }, [20, 20]);
        expect(mockConvertFromPixel).toHaveBeenCalledWith({ seriesIndex: 0 }, [100, 20]);
        expect(mockDispatchAction).toHaveBeenCalledWith({
            type: 'dataZoom',
            startValue: msOf(columnar.timestamps[1]),
            endValue: msOf(columnar.timestamps[3]),
        });
        // One-shot: back to the normal pointer after a single drag.
        expect(zoomButton(container).className).not.toContain('active');
    });

    it('orders startValue/endValue correctly regardless of drag direction (right-to-left drag)', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(zoomButton(container));
        fireEvent.click(container.querySelector('.line-chart-zoom-menu-item') as HTMLElement);

        mockConvertFromPixel
            .mockReturnValueOnce([msOf(columnar.timestamps[3]), 0]) // drag start (right side)
            .mockReturnValueOnce([msOf(columnar.timestamps[1]), 0]); // drag end (left side)
        act(() => { zrMouseDownHandler!({ offsetX: 100, offsetY: 20 }); });
        act(() => { zrMouseUpHandler!({ offsetX: 20, offsetY: 20 }); });

        expect(mockDispatchAction).toHaveBeenCalledWith({
            type: 'dataZoom',
            startValue: msOf(columnar.timestamps[1]), // still the smaller value
            endValue: msOf(columnar.timestamps[3]),
        });
    });

    it('ignores a drag under ~4px (an accidental click, not an intentional range) -- no dataZoom action dispatched, and it stays armed for a real attempt', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(zoomButton(container));
        fireEvent.click(container.querySelector('.line-chart-zoom-menu-item') as HTMLElement);

        act(() => { zrMouseDownHandler!({ offsetX: 50, offsetY: 20 }); });
        act(() => { zrMouseUpHandler!({ offsetX: 52, offsetY: 20 }); }); // 2px -- below the threshold

        expect(mockDispatchAction).not.toHaveBeenCalled();
    });

    it('ignores a mousedown outside the plot grid (containPixel false) -- no drag starts', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(zoomButton(container));
        fireEvent.click(container.querySelector('.line-chart-zoom-menu-item') as HTMLElement);
        mockContainPixel.mockReturnValue(false);

        act(() => { zrMouseDownHandler!({ offsetX: 50, offsetY: 20 }); });
        act(() => { zrMouseUpHandler!({ offsetX: 100, offsetY: 20 }); });

        expect(mockDispatchAction).not.toHaveBeenCalled();
    });

    it('does nothing on a drag while zoom-select mode is off (mousedown/up wired but not armed)', () => {
        const columnar = columnarOf(headers, 5);
        render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        expect(zrMouseDownHandler).not.toBeNull(); // listener attached regardless
        act(() => { zrMouseDownHandler!({ offsetX: 20, offsetY: 20 }); });
        act(() => { zrMouseUpHandler!({ offsetX: 100, offsetY: 20 }); });
        expect(mockDispatchAction).not.toHaveBeenCalled();
    });

    it('never disables the "inside" dataZoom component while zoom-select mode is armed (regression: `disabled: zoomSelectMode` looked right but made the drag a no-op -- ECharts ignores a dataZoom dispatchAction targeting a component that is disabled in the chart\'s currently-active option, and the option stays disabled for the whole drag since React never re-renders mid-gesture)', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(zoomButton(container));
        fireEvent.click(container.querySelector('.line-chart-zoom-menu-item') as HTMLElement); // arm Horizontal zoom
        const option = capturedOptions[capturedOptions.length - 1];
        expect(option.dataZoom[0].disabled).not.toBe(true);
    });

    it('turning on Tag mode disarms an active Horizontal Zoom', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        fireEvent.click(zoomButton(container));
        fireEvent.click(container.querySelector('.line-chart-zoom-menu-item') as HTMLElement);
        expect(zoomButton(container).className).toContain('active');

        fireEvent.click(tagToggle(container));
        expect(tagToggle(container).className).toContain('active');
        expect(zoomButton(container).className).not.toContain('active');
    });

    it('shows a drag-hint caption while zoom-select mode is armed', () => {
        const columnar = columnarOf(headers, 5);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={headers} headers={headers} />);
        expect(container.textContent).not.toContain('Drag across the chart to zoom into that range');
        fireEvent.click(zoomButton(container));
        fireEvent.click(container.querySelector('.line-chart-zoom-menu-item') as HTMLElement);
        expect(container.textContent).toContain('Drag across the chart to zoom into that range');
    });

    it('the 2000-point "large" rendering profile does not disable the Zoom tool (it works the same regardless of dataset size)', () => {
        const columnar = columnarOf(['A'], 2001);
        const { container } = render(<LineChart data={[]} columnar={columnar} sensors={['A']} headers={['A']} />);
        expect(zoomButton(container)).not.toBeNull();
        expect((zoomButton(container) as HTMLButtonElement).disabled).toBeFalsy();
    });
});
