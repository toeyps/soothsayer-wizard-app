import { CsvRecord, SensorMetadata, ScatterAxisPins } from '../../types';

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
    /** Per-sensor line/axis color override (any CSS color). Sensors absent
     *  from this map fall back to the default palette. */
    sensorColors?: Record<string, string>;
    /** Per-sensor fixed Y-axis bounds. `min`/`max` are independent — either
     *  may be omitted to keep that side auto-fitting (`scale: true`) while
     *  the other stays pinned so the axis doesn't jump around as the
     *  visible time range changes. */
    sensorAxisRange?: Record<string, { min?: number; max?: number }>;
    /** Scatter chart's persisted X-axis sensor (Dashboard-owned). Ignored
     *  by Line/Pair Plot. */
    scatterX?: string;
    /** Scatter chart's persisted Y-axis sensor. */
    scatterY?: string;
    /** Fired whenever the Scatter chart's X/Y selection settles on a
     *  value, so the parent can persist it. */
    onScatterAxesChange?: (x: string, y: string) => void;
    /** Scatter chart's persisted axis-scale pins (Dashboard-owned) — the
     *  ruler-icon editor's min/max, independent of `scatterX`/`scatterY`
     *  above. Ignored by Line/Pair Plot. */
    scatterAxisPins?: ScatterAxisPins;
    /** Fired whenever the Scatter chart's axis pins change (apply/clear),
     *  so the parent can persist them. */
    onScatterAxisPinsChange?: (pins: ScatterAxisPins) => void;
    /** Sensor master data (description/unit/component), including
     *  runtime-created "special" sensors merged in by Dashboard.tsx. Used
     *  by LineChart's hover tooltip to append each sensor's unit next to
     *  its value. */
    sensorMetadata?: SensorMetadata[] | null;
}
