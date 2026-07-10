import { CsvRecord } from '../../types';

export interface ChartMarkLine {
    /** Sensor (yAxis) this marker belongs to. Must be present in `sensors`. */
    sensor: string;
    /** Y-value to draw the horizontal line at. */
    y: number;
    /** Short label shown next to the line. */
    label: string;
    /** Optional CSS color. Falls back to the series color. */
    color?: string;
    /** Optional dash style. Defaults to 'solid'. */
    lineStyle?: 'solid' | 'dashed' | 'dotted';
    /** Optional line width. Defaults to 1. */
    width?: number;
}

/**
 * Columnar line-chart feed: one shared x-axis plus one value array per
 * header. Produced by the Rust `get_chart_data` command; already bounded
 * and in ECharts' native shape, so the chart consumes it with zero
 * per-row object allocation.
 */
export interface ColumnarSeries {
    timestamps: string[];
    /** `series[i]` aligns with `headers[i]`; null = missing. */
    series: (number | null)[][];
}

export interface ChartProps {
    data: CsvRecord[];
    /**
     * Preferred data source for the line chart when provided — `data` is
     * then ignored by LineChart. Scatter / pair plots ignore this field.
     */
    columnar?: ColumnarSeries;
    sensors: string[];
    headers: string[];
    /** Optional horizontal reference lines (e.g. mean, ±1σ, ±3σ). */
    markLines?: ChartMarkLine[];
    /** Hide the horizontal Y-axis split lines. Defaults to false (shown). */
    hideYSplitLine?: boolean;
}
