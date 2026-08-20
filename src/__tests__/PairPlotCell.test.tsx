import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

function makeMockInstance() {
    const subs: Record<string, (...args: any[]) => void> = {};
    return {
        subscribe: vi.fn((event: string, cb: (...args: any[]) => void) => { subs[event] = cb; }),
        set: vi.fn(),
        reset: vi.fn(),
        deselect: vi.fn(),
        destroy: vi.fn(),
        draw: vi.fn(),
        getScreenPosition: vi.fn(() => [20, 20]),
        __subs: subs,
    };
}

let lastInstance: ReturnType<typeof makeMockInstance> | null = null;
const mockCreateScatterplot = vi.fn((_opts: any) => {
    lastInstance = makeMockInstance();
    return lastInstance;
});
vi.mock('regl-scatterplot', () => ({
    default: (opts: any) => mockCreateScatterplot(opts),
}));

const mockReportError = vi.fn();
vi.mock('../errorReporter', () => ({
    reportError: (...args: unknown[]) => mockReportError(...args),
}));

let lastResizeCallback: (() => void) | null = null;
class MockResizeObserver {
    constructor(cb: () => void) { lastResizeCallback = cb; }
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
}

import PairPlotCell from '../components/charts/PairPlotCell';
import type { Cluster } from '../components/charts/PairPlotCell';

const headers = ['A', 'B'];
const data = [
    { timestamp: '2026-01-01T00:00:00Z', values: [1, 10] },
    { timestamp: '2026-01-02T00:00:00Z', values: [2, 20] },
    { timestamp: '2026-01-03T00:00:00Z', values: [3, 30] },
] as any;

const noop = () => {};

let origClientWidth: PropertyDescriptor | undefined;
let origClientHeight: PropertyDescriptor | undefined;

beforeEach(() => {
    mockCreateScatterplot.mockClear();
    mockReportError.mockClear();
    lastInstance = null;
    lastResizeCallback = null;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 150 });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (origClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientWidth);
    if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight);
});

const baseProps = {
    data, headers, sensorY: 'B', sensorX: 'A',
    showXAxis: true, showYAxis: true, showXLabel: true, showYLabel: true,
    tool: 'pan' as const, clusters: [] as Cluster[],
    onLasso: noop, onHover: noop,
    pointColor: [0.5, 0.5, 0.5, 1] as [number, number, number, number],
    resetTick: 0, themeMode: 'dark' as const,
};

describe('PairPlotCell', () => {
    it('the container div background matches the WebGL canvas clear colour exactly (regression: used to fall through to --bg-primary, a different shade than pure black/white)', () => {
        const { container: darkContainer } = render(<PairPlotCell {...baseProps} themeMode="dark" />);
        expect((darkContainer.querySelector('.pair-regl-cell') as HTMLElement).style.background).toBe('rgb(0, 0, 0)');
        cleanup();

        const { container: lightContainer } = render(<PairPlotCell {...baseProps} themeMode="light" />);
        expect((lightContainer.querySelector('.pair-regl-cell') as HTMLElement).style.background).toBe('rgb(255, 255, 255)');
    });

    it('creates a WebGL instance sized to the padded inner area, themed per prop', () => {
        render(<PairPlotCell {...baseProps} themeMode="light" />);
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1);
        const opts = mockCreateScatterplot.mock.calls[0][0];
        const expectedWidth = 200 - 36 - 4; // AXIS_PAD.left/right
        const expectedHeight = 150 - 14 - 18; // AXIS_PAD.top/bottom
        expect(opts.width).toBe(expectedWidth);
        expect(opts.height).toBe(expectedHeight);
        // Regression: regl-scatterplot defaults aspectRatio to 1 (assumes a
        // square data domain) and letterboxes a non-square canvas — our x/y
        // domains are both normalized to [-1,1] with nothing physical to
        // preserve, so this must match the canvas's own ratio to fill the
        // whole cell instead of showing black bars on the sides.
        expect(opts.aspectRatio).toBe(expectedWidth / expectedHeight);
        expect(opts.backgroundColor).toEqual([1.0, 1.0, 1.0, 1.0]);
        expect(opts.pointColor).toEqual(baseProps.pointColor);
        // pointOutlineWidth only affects lasso-selected points (unused
        // here) — kept at 0 as a documented no-op.
        expect(opts.pointOutlineWidth).toBe(0);
        // Regression: the SDF-antialiased circle edge read as a visible dark
        // ring around every point at high density on light theme's white
        // canvas.
        expect(opts.antiAliasing).toBe(0);
    });

    it('debounces resize-driven WebGL recreation (regression: a split-pane drag used to destroy+recreate every matrix cell\'s context on every single ResizeObserver tick)', () => {
        vi.useFakeTimers();
        render(<PairPlotCell {...baseProps} />);
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1); // initial mount — immediate, no debounce

        // Simulate a rapid drag: several resize ticks in quick succession.
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 260 });
        act(() => { lastResizeCallback!(); });
        act(() => { vi.advanceTimersByTime(50); });
        act(() => { lastResizeCallback!(); });
        act(() => { vi.advanceTimersByTime(50); });
        act(() => { lastResizeCallback!(); });
        // Still within the 150ms debounce window of the LAST tick — no new
        // instance yet, even though 3 resize events already fired.
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1);

        // Let the debounce settle past the last tick.
        act(() => { vi.advanceTimersByTime(150); });
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(2); // exactly one recreation, not three
    });

    it('shows an inline error and reports it when instance creation throws', () => {
        mockCreateScatterplot.mockImplementationOnce(() => { throw new Error('gl fail'); });
        render(<PairPlotCell {...baseProps} />);
        expect(screen.getByText('WebGL unavailable')).toBeTruthy();
        expect(mockReportError).toHaveBeenCalledWith('pairplot-init', expect.any(Error));
    });

    it('maps a lasso selection back to original row indices via onLasso', () => {
        const onLasso = vi.fn();
        render(<PairPlotCell {...baseProps} onLasso={onLasso} />);
        // All 3 rows have valid values for A/B, so point indices == row indices here.
        act(() => { lastInstance!.__subs['select']({ points: [0, 2] }); });
        expect(onLasso).toHaveBeenCalledWith([0, 2]);
        expect(lastInstance!.deselect).toHaveBeenCalledWith({ preventEvent: true });
    });

    it('ignores an empty lasso selection', () => {
        const onLasso = vi.fn();
        render(<PairPlotCell {...baseProps} onLasso={onLasso} />);
        act(() => { lastInstance!.__subs['select']({ points: [] }); });
        expect(onLasso).not.toHaveBeenCalled();
    });

    it('reports hover info with real sensor values for a non-time-axis cell', () => {
        const onHover = vi.fn();
        render(<PairPlotCell {...baseProps} onHover={onHover} />);
        act(() => { lastInstance!.__subs['pointover'](0); });
        expect(onHover).toHaveBeenCalledWith(
            expect.objectContaining({
                rowIdx: 0, xVal: 1, yVal: 10, sensorX: 'A', sensorY: 'B', isTimeAxis: false,
                timestamp: '2026-01-01T00:00:00Z',
            }),
        );
    });

    it('reports hover info with the row timestamp as xVal for a time-axis cell', () => {
        const onHover = vi.fn();
        render(<PairPlotCell {...baseProps} sensorX={undefined} isTimeAxis onHover={onHover} />);
        act(() => { lastInstance!.__subs['pointover'](0); });
        expect(onHover).toHaveBeenCalledWith(
            expect.objectContaining({
                xVal: new Date('2026-01-01T00:00:00Z').getTime(),
                sensorX: 'Time', isTimeAxis: true,
            }),
        );
    });

    it('clears hover on pointout', () => {
        const onHover = vi.fn();
        render(<PairPlotCell {...baseProps} onHover={onHover} />);
        act(() => { lastInstance!.__subs['pointout'](); });
        expect(onHover).toHaveBeenCalledWith(null);
    });

    it('skips rows with null/NaN values when pushing data (verified via lasso row mapping)', () => {
        const sparse = [
            { timestamp: 't0', values: [1, 10] },
            { timestamp: 't1', values: [null, 20] },
            { timestamp: 't2', values: [3, 30] },
        ] as any;
        const onLasso = vi.fn();
        render(<PairPlotCell {...baseProps} data={sparse} onLasso={onLasso} />);
        // Only rows 0 and 2 survive filtering, so they become points 0 and 1.
        act(() => { lastInstance!.__subs['select']({ points: [0, 1] }); });
        expect(onLasso).toHaveBeenCalledWith([0, 2]);
    });

    it('applies cluster colors via colorBy/pointColor on the data-push set() call', () => {
        const clusters: Cluster[] = [
            { id: 'c1', label: 'Cluster 1', color: [1, 0, 0, 1], rowIndices: new Set([0]) },
        ];
        render(<PairPlotCell {...baseProps} clusters={clusters} />);
        const setCalls = lastInstance!.set.mock.calls;
        const dataSetCall = setCalls.find((c) => c[0]?.colorBy === 'valueA');
        expect(dataSetCall![0].pointColor).toEqual([baseProps.pointColor, [1, 0, 0, 1]]);
    });

    it('re-uploads valueA and re-draws when the cluster list changes without new data', () => {
        const { rerender } = render(<PairPlotCell {...baseProps} clusters={[]} />);
        lastInstance!.set.mockClear();
        const newClusters: Cluster[] = [
            { id: 'c1', label: 'C1', color: [0, 1, 0, 1], rowIndices: new Set([1]) },
        ];
        rerender(<PairPlotCell {...baseProps} clusters={newClusters} />);
        expect(lastInstance!.set).toHaveBeenCalledWith(
            expect.objectContaining({ colorBy: 'valueA', pointColor: [baseProps.pointColor, [0, 1, 0, 1]] }),
        );
    });

    // Regression guard: Pair Plot deliberately does NOT read the Highlights
    // tab's time-window list at all (unlike ScatterChart/LineChart) — its
    // lasso-cluster already covers "mark points I care about", and an
    // earlier revision's `sizeBy`-driven highlight emphasis here was removed
    // as more confusing than useful once both existed side by side.
    it('has no timeHighlights prop at all -- Pair Plot only ever reads clusters for colouring', () => {
        render(<PairPlotCell {...baseProps} />);
        const setCalls = lastInstance!.set.mock.calls;
        const dataSetCall = setCalls.find((c) => c[0]?.colorBy === 'valueA');
        expect(dataSetCall![0].sizeBy).toBeUndefined();
        expect(dataSetCall![0].pointSize).toBeUndefined();
    });

    it('sets mouseMode according to the active tool', () => {
        const { rerender } = render(<PairPlotCell {...baseProps} tool="pan" />);
        expect(lastInstance!.set).toHaveBeenCalledWith(expect.objectContaining({ mouseMode: 'panZoom' }));

        lastInstance!.set.mockClear();
        rerender(<PairPlotCell {...baseProps} tool="lasso" />);
        expect(lastInstance!.set).toHaveBeenCalledWith(expect.objectContaining({ mouseMode: 'lasso' }));
    });

    it('does not reset the camera on initial mount (resetTick starts at 0)', () => {
        render(<PairPlotCell {...baseProps} resetTick={0} />);
        expect(lastInstance!.reset).not.toHaveBeenCalled();
    });

    it('resets the camera only when resetTick increases past the last applied value', () => {
        const { rerender } = render(<PairPlotCell {...baseProps} resetTick={0} />);
        rerender(<PairPlotCell {...baseProps} resetTick={1} />);
        expect(lastInstance!.reset).toHaveBeenCalledTimes(1);

        // Re-render with the SAME tick must not reset again.
        rerender(<PairPlotCell {...baseProps} resetTick={1} />);
        expect(lastInstance!.reset).toHaveBeenCalledTimes(1);

        rerender(<PairPlotCell {...baseProps} resetTick={2} />);
        expect(lastInstance!.reset).toHaveBeenCalledTimes(2);
    });

    it('renders X/Y axis sensor-name labels when show*Label is true', () => {
        render(<PairPlotCell {...baseProps} showXLabel showYLabel />);
        expect(screen.getByText('A')).toBeTruthy();
        expect(screen.getByText('B')).toBeTruthy();
    });

    it('shows "Time" as the label for a time-axis cell instead of the sensor name', () => {
        render(<PairPlotCell {...baseProps} sensorX={undefined} isTimeAxis showXLabel />);
        expect(screen.getByText('Time')).toBeTruthy();
    });

    it('omits axis labels when show*Label is false', () => {
        render(<PairPlotCell {...baseProps} showXLabel={false} showYLabel={false} />);
        expect(screen.queryByText('A')).toBeNull();
        expect(screen.queryByText('B')).toBeNull();
    });
});
