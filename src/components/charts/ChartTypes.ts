import { CsvRecord, SensorMetadata, ScatterAxisPins, TimeHighlight, ValueHighlight, LineTaggedPoint } from '../../types';

/** Pair Plot makes one WebGL context per scatter cell AND per time-series cell: n(n-1)/2 + n for n sensors. Chromium (WebView2) evicts the oldest past ~16 (cell shows "Rendering paused" with Retry): 4 sensors = 10, 5 would be 15. Single source for Dashboard's tab-enabling and PairPlotChart's render guard. */
export const MAX_PAIR_PLOT_SENSORS = 4;

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

/** Columnar line-chart feed from Rust `get_chart_data`: one shared x-axis plus one array per header, no per-row objects. */
export interface ColumnarSeries {
    timestamps: string[];
    /** `series[i]` aligns with `headers[i]`; null = missing. */
    series: (number | null)[][];
}

export interface ChartProps {
    data: CsvRecord[];
    /** Preferred data source for the line chart when given: `data` is then ignored by LineChart. Scatter/pair plots ignore it. */
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
    /** Per-sensor fixed Y bounds; `min`/`max` are independent: an omitted side keeps auto-fitting (`scale: true`). */
    sensorAxisRange?: Record<string, { min?: number; max?: number }>;
    /** Scatter chart's persisted X-axis sensor (Dashboard-owned). Ignored
     *  by Line/Pair Plot. */
    scatterX?: string;
    /** Scatter chart's persisted Y-axis sensor. */
    scatterY?: string;
    /** Fired whenever the Scatter chart's X/Y selection settles on a
     *  value, so the parent can persist it. */
    onScatterAxesChange?: (x: string, y: string) => void;
    /** Scatter's persisted axis-scale pins (Dashboard-owned): the ruler editor's min/max. Ignored by Line/Pair Plot. */
    scatterAxisPins?: ScatterAxisPins;
    /** Fired whenever the Scatter chart's axis pins change (apply/clear),
     *  so the parent can persist them. */
    onScatterAxisPinsChange?: (pins: ScatterAxisPins) => void;
    /** Sensor master data incl. special sensors merged in by Dashboard; LineChart's tooltip appends each unit. */
    sensorMetadata?: SensorMetadata[] | null;
    /** Time windows to highlight (Highlights tab "By time"): Line draws a tinted band, Scatter rings matching points. Ignored by Pair Plot. */
    timeHighlights?: TimeHighlight[];
    /** Line chart's persisted tagged points (Dashboard-owned). Ignored by Pair Plot; Scatter keeps its own local tags. */
    lineTaggedPoints?: LineTaggedPoint[];
    /** Fired whenever the Line chart's tagged points change (add/remove/
     *  clear), so the parent can persist them. */
    onLineTaggedPointsChange?: (points: LineTaggedPoint[]) => void;
    /** Where the Line/Scatter chart renders the tagged-points table: the "Tagged points" tab element, or null while that tab is closed (nothing drawn). `undefined` docks it under the chart. */
    tagTableHost?: HTMLElement | null;
    /** How many points are tagged now; `added` is true when the user just tagged one more (not on mount or removal). */
    onTagCountChange?: (count: number, added: boolean) => void;
    /** "By value" highlighting (Dashboard-owned, Highlights tab): colours Scatter points by which range a 3rd sensor's value falls in. Scatter-only. */
    valueHighlight?: ValueHighlight;
}
