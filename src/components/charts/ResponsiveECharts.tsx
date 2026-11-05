import { useRef, useEffect, useState, useCallback, CSSProperties } from 'react';
import ReactECharts from 'echarts-for-react';
import { attachEvenTimeTicks, hasTimeXAxis } from './evenTimeAxis';
import { attachFollowY, getFollowY } from './followYAxis';
import { attachAxisNames, getAxisNames } from '../../utils/axisName';

interface ResponsiveEChartsProps {
    option: any;
    notMerge?: boolean;
    lazyUpdate?: boolean;
    theme?: string;
    style?: CSSProperties;
    className?: string;
    opts?: any;
    onEvents?: Record<string, (...args: any[]) => void>;
    /** Called once with the real echarts instance; getEchartsInstance() in a mount effect returns a temporary one that is disposed. */
    onChartReady?: (instance: any) => void;
}

/** ReactECharts wrapper that resizes on any container size change (ResizeObserver), not just window resize. */
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

    // The long-lived instance (see `onChartReady` above for why it is taken from there).
    const [instance, setInstance] = useState<any>(null);
    const onReadyRef = useRef(onChartReady);
    onReadyRef.current = onChartReady;
    const handleReady = useCallback((inst: any) => {
        setInstance(inst);
        onReadyRef.current?.(inst);
    }, []);

    // Time-X-axis charts get evenly spaced ticks (evenTimeAxis.ts); reattach per option because notMerge replaces it.
    const timeAxis = hasTimeXAxis(option);
    useEffect(() => {
        if (!instance || !timeAxis) return;
        return attachEvenTimeTicks(instance);
    }, [instance, timeAxis, option]);

    // withFollowY charts: the Y axis follows the zoom window and keeps reference lines; each option carries its spec.
    const followY = getFollowY(option);
    useEffect(() => {
        if (!instance || !followY) return;
        return attachFollowY(instance, followY);
    }, [instance, followY]);

    // `withAxisNames` charts: titles are fitted to the plot's real size, now and on resize; a title that fits is unchanged.
    const axisNames = getAxisNames(option);
    useEffect(() => {
        if (!instance || !axisNames) return;
        return attachAxisNames(instance, axisNames, option);
    }, [instance, axisNames, option]);

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
                onChartReady={handleReady}
                style={{ height: '100%', width: '100%' }}
            />
        </div>
    );
}
