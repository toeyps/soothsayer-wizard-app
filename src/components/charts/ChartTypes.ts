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

export interface ChartProps {
    data: CsvRecord[];
    sensors: string[];
    headers: string[];
    /** Optional horizontal reference lines (e.g. mean, ±1σ, ±3σ). */
    markLines?: ChartMarkLine[];
    /** Hide the horizontal Y-axis split lines. Defaults to false (shown). */
    hideYSplitLine?: boolean;
}
