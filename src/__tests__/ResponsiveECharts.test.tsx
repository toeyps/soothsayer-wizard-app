import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
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

    it('calls onChartReady once with the echarts instance after mount', () => {
        const onChartReady = vi.fn();
        render(<ResponsiveECharts option={{}} onChartReady={onChartReady} />);
        expect(onChartReady).toHaveBeenCalledTimes(1);
        expect(onChartReady).toHaveBeenCalledWith({ resize: mockResize });
    });

    it('does not throw when onChartReady is omitted', () => {
        expect(() => render(<ResponsiveECharts option={{}} />)).not.toThrow();
    });
});
