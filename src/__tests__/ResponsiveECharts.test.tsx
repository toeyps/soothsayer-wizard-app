import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';

const receivedProps: any[] = [];
const mockResize = vi.fn();
const mockGetEchartsInstance = vi.fn(() => ({ resize: mockResize }));

vi.mock('echarts-for-react', () => ({
    default: forwardRef((props: any, ref: any) => {
        receivedProps.push(props);
        useImperativeHandle(ref, () => ({ getEchartsInstance: mockGetEchartsInstance }));
        return <div data-testid="echarts-mock" />;
    }),
}));

let roCallback: (() => void) | null = null;
const observeSpy = vi.fn();
const disconnectSpy = vi.fn();
class MockResizeObserver {
    constructor(cb: () => void) { roCallback = cb; }
    observe = observeSpy;
    disconnect = disconnectSpy;
    unobserve = vi.fn();
}

import ResponsiveECharts from '../components/charts/ResponsiveECharts';

beforeEach(() => {
    receivedProps.length = 0;
    mockResize.mockClear();
    mockGetEchartsInstance.mockClear();
    observeSpy.mockClear();
    disconnectSpy.mockClear();
    roCallback = null;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('ResponsiveECharts', () => {
    it('renders the wrapped chart with default notMerge=true and theme="dark"', () => {
        render(<ResponsiveECharts option={{ series: [] }} />);
        expect(receivedProps[0]).toMatchObject({
            option: { series: [] },
            notMerge: true,
            theme: 'dark',
        });
    });

    it('forwards notMerge/theme/lazyUpdate/opts/onEvents overrides', () => {
        const onEvents = { click: vi.fn() };
        const opts = { renderer: 'svg' };
        render(
            <ResponsiveECharts
                option={{}}
                notMerge={false}
                lazyUpdate
                theme="light"
                opts={opts}
                onEvents={onEvents}
            />,
        );
        expect(receivedProps[0]).toMatchObject({
            notMerge: false,
            lazyUpdate: true,
            theme: 'light',
            opts,
            onEvents,
        });
    });

    it('observes the container with a ResizeObserver on mount', () => {
        render(<ResponsiveECharts option={{}} />);
        expect(observeSpy).toHaveBeenCalledTimes(1);
    });

    it('resizes the echarts instance (throttled via rAF) when the container resizes', async () => {
        render(<ResponsiveECharts option={{}} />);
        expect(roCallback).not.toBeNull();

        roCallback!();
        await waitFor(() => expect(mockResize).toHaveBeenCalledTimes(1));
    });

    it('coalesces rapid resize notifications into a single resize() call', async () => {
        render(<ResponsiveECharts option={{}} />);
        roCallback!();
        roCallback!();
        roCallback!();
        await waitFor(() => expect(mockResize).toHaveBeenCalledTimes(1));
    });

    it('disconnects the observer on unmount', () => {
        const { unmount } = render(<ResponsiveECharts option={{}} />);
        unmount();
        expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });

    it('forwards onChartReady straight to echarts-for-react, not grabbed via a mount effect (regression: echarts-for-react initializes asynchronously -- it creates a temporary instance, disposes it once its first render finishes, then creates the real one; a synchronous effect right after mount would observe the temporary/disposed instance instead of the long-lived one, so this MUST be a plain prop the library itself calls once the real instance exists)', () => {
        const onChartReady = vi.fn();
        render(<ResponsiveECharts option={{}} onChartReady={onChartReady} />);
        // The library is handed a ready-callback (the wrapper's own, which also keeps the
        // instance for the even time-axis ticks) and the caller's is NOT called at mount ...
        expect(typeof receivedProps[0].onChartReady).toBe('function');
        expect(onChartReady).not.toHaveBeenCalled();
        // ... only when the library reports its real instance — and with that same instance.
        const inst = { resize: vi.fn() };
        act(() => { receivedProps[0].onChartReady(inst); });
        expect(onChartReady).toHaveBeenCalledTimes(1);
        expect(onChartReady).toHaveBeenCalledWith(inst);
    });

    it('a chart with a time X axis gets evenly spaced ticks attached once its instance is ready; others do not', () => {
        const mk = () => {
            const handlers: Record<string, () => void> = {};
            return { handlers, on: vi.fn((e: string, h: () => void) => { handlers[e] = h; }), off: vi.fn(), getModel: vi.fn(() => null), resize: vi.fn() };
        };
        const timeInst = mk();
        const { unmount } = render(<ResponsiveECharts option={{ xAxis: { type: 'time' }, series: [] }} />);
        act(() => { receivedProps[receivedProps.length - 1].onChartReady(timeInst); });
        expect(timeInst.on.mock.calls.map(c => c[0]).sort()).toEqual(['datazoom', 'finished']);
        unmount();
        expect(timeInst.off.mock.calls.map(c => c[0]).sort()).toEqual(['datazoom', 'finished']);

        const valueInst = mk();
        render(<ResponsiveECharts option={{ xAxis: { type: 'value' }, series: [] }} />);
        act(() => { receivedProps[receivedProps.length - 1].onChartReady(valueInst); });
        expect(valueInst.on).not.toHaveBeenCalled();
    });

    it('does not throw when onChartReady is omitted', () => {
        expect(() => render(<ResponsiveECharts option={{}} />)).not.toThrow();
    });
});
