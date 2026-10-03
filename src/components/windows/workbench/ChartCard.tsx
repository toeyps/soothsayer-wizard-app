import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { Maximize2, X } from 'lucide-react';
import ResponsiveECharts from '../../charts/ResponsiveECharts';

/*
 * A chart card of the Build Model Workbench (mockup `.cc`): title + subtitle,
 * optional controls on the right, an Expand button, the chart, an optional
 * legend row, and the "Out of date" overlay while the model is stale.
 *
 * Both pages use it: Model fit (3b-1) and Health score (3b-2). Expanding opens
 * a large copy of the SAME chart (same option, same data — nothing is
 * re-fetched) in the app's usual full-screen chart modal; Esc / the backdrop /
 * the X close it.
 *
 * Give it either `option` (an ECharts option, drawn with ResponsiveECharts) or
 * `render` (any node, called with `expanded` so a custom chart can size itself
 * for the overlay).
 */

export type ChartCardSize = 'normal' | 'tall' | 'xtall' | 'hs';

export interface ChartCardProps {
    /** Stable id — becomes `data-testid="chart-card-{id}"` / `chart-expand-{id}`. */
    id: string;
    title: string;
    sub?: ReactNode;
    /** Spans every column of the board (mockup `.full`). */
    full?: boolean;
    size?: ChartCardSize;
    /** Controls shown right of the title, before the Expand button. */
    extra?: ReactNode;
    /** Legend row under the chart (use `LegendItem`s). */
    legend?: ReactNode;
    /** The model is stale: cover the chart with "Out of date". */
    stale?: boolean;
    option?: object | null;
    /** Props forwarded to ResponsiveECharts (`onEvents`, `onChartReady`, ...). */
    chartProps?: Partial<ComponentProps<typeof ResponsiveECharts>>;
    /** Shown instead of the chart when there is no `option`. */
    empty?: ReactNode;
    render?: (expanded: boolean) => ReactNode;
}

export function LegendItem({ color, label, dashed, square }: { color: string; label: string; dashed?: boolean; square?: boolean }) {
    return (
        <span className="wb2-lg">
            <i
                className={square ? 'wb2-lg-sq' : undefined}
                style={square ? { background: color } : { borderColor: color, borderTopStyle: dashed ? 'dashed' : 'solid' }}
            />
            {label}
        </span>
    );
}

export default function ChartCard({ id, title, sub, full, size = 'normal', extra, legend, stale, option, chartProps, empty, render }: ChartCardProps) {
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        if (!expanded) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [expanded]);

    const body = (big: boolean) => {
        if (render) return render(big);
        if (option) return <ResponsiveECharts option={option} style={{ height: '100%', minHeight: 0 }} {...chartProps} />;
        return <div className="wb2-empty">{empty ?? 'No data to show'}</div>;
    };

    return (
        <>
            <section className={`wb2-card wb2-card--${size}${full ? ' wb2-full' : ''}`} data-testid={`chart-card-${id}`}>
                <div className="wb2-card-h">
                    <b>{title}</b>
                    {sub && <span className="wb2-card-s">{sub}</span>}
                    <span className="wb2-sp" />
                    {extra}
                    <button
                        type="button"
                        className="wb2-ib"
                        data-testid={`chart-expand-${id}`}
                        onClick={() => setExpanded(true)}
                        title="Expand"
                        aria-label={`Expand ${title}`}
                    >
                        <Maximize2 size={13} aria-hidden="true" />
                    </button>
                </div>
                <div className="wb2-cv">
                    {body(false)}
                    {stale && (
                        <div className="wb2-outdated" data-testid="chart-outdated">
                            <div><b>Out of date</b>Re-train to see the chart for the new settings</div>
                        </div>
                    )}
                </div>
                {legend && <div className="wb2-legend">{legend}</div>}
            </section>
            {expanded && (
                <div className="pm-chart-modal-backdrop" role="dialog" aria-modal="true" aria-label={title} data-testid={`chart-overlay-${id}`} onClick={() => setExpanded(false)}>
                    <div className="pm-chart-modal-card" onClick={e => e.stopPropagation()}>
                        <div className="pm-chart-modal-header">
                            <div className="pm-chart-title-block">
                                <div className="pm-chart-title">{title}</div>
                                {sub && <div className="pm-chart-subtitle">{sub}</div>}
                            </div>
                            <button type="button" className="pm-chart-modal-close" onClick={() => setExpanded(false)} title="Close (Esc)" aria-label="Close">
                                <X size={18} />
                            </button>
                        </div>
                        <div className="pm-chart-modal-body wb2-ovl-body">
                            {body(true)}
                            {stale && (
                                <div className="wb2-outdated">
                                    <div><b>Out of date</b>Re-train to see the chart for the new settings</div>
                                </div>
                            )}
                        </div>
                        {legend && <div className="wb2-legend">{legend}</div>}
                    </div>
                </div>
            )}
        </>
    );
}
