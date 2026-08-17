import { useRef, useEffect, CSSProperties } from 'react';
import ReactECharts from 'echarts-for-react';

interface ResponsiveEChartsProps {
    option: any;
    notMerge?: boolean;
    lazyUpdate?: boolean;
    theme?: string;
    style?: CSSProperties;
    className?: string;
    opts?: any;
    onEvents?: Record<string, (...args: any[]) => void>;
    /** Fired once with the underlying echarts instance after mount. For
     *  callers that need APIs `onEvents` can't reach — e.g. `getZr()` for a
     *  canvas-level click listener that fires regardless of series `silent`
     *  state, or `convertFromPixel`/`convertToPixel` for coordinate math. */
    onChartReady?: (instance: any) => void;
}

/**
 * ReactECharts wrapper that resizes the chart whenever its container box changes size
 * (not just on window resize). Uses ResizeObserver on the outer wrapper div and calls
 * echarts instance .resize() on every observed change.
 */
export default function ResponsiveECharts({
    option,
    notMerge = true,
    lazyUpdate,
    theme = 'dark',
    style,
    className,
    opts,
    onEvents,
    onChartReady,
}: ResponsiveEChartsProps) {
    const chartRef = useRef<ReactECharts>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        const inst = chartRef.current?.getEchartsInstance();
        if (inst) onChartReady?.(inst);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onChartReady]);

    useEffect(() => {
        if (!containerRef.current) return;
        const el = containerRef.current;

        const doResize = () => {
            const inst = chartRef.current?.getEchartsInstance();
            if (inst) inst.resize();
        };

        const ro = new ResizeObserver(() => {
            // Throttle with rAF to avoid resize thrashing
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                doResize();
            });
        });

        ro.observe(el);

        return () => {
            ro.disconnect();
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    return (
        <div
            ref={containerRef}
            className={className}
            style={{ width: '100%', height: '100%', minHeight: 0, minWidth: 0, ...style }}
        >
            <ReactECharts
                ref={chartRef}
                option={option}
                notMerge={notMerge}
                lazyUpdate={lazyUpdate}
                theme={theme}
                opts={opts}
                onEvents={onEvents}
                style={{ height: '100%', width: '100%' }}
            />
        </div>
    );
}
