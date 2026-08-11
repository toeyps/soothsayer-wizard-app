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

class MockResizeObserver {
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
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 150 });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
    it('creates a WebGL instance sized to the padded inner area, themed per prop', () => {
        render(<PairPlotCell {...baseProps} themeMode="light" />);
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1);
        const opts = mockCreateScatterplot.mock.calls[0][0];
        expect(opts.width).toBe(200 - 36 - 4); // AXIS_PAD.left/right
        expect(opts.height).toBe(150 - 14 - 18); // AXIS_PAD.top/bottom
        expect(opts.backgroundColor).toEqual([1.0, 1.0, 1.0, 1.0]);
        expect(opts.pointColor).toEqual(baseProps.pointColor);
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
