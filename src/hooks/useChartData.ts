import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SensorOperationConfig } from '../types';
import type {
    ChartSamplingMethod,
    ChartViewData,
    DashboardDataFilter,
} from '../types/commands';

/** Inputs for `get_chart_data` — everything that changes the rendered line chart. */
export interface ChartDataQuery {
    filter: DashboardDataFilter;
    sampling: ChartSamplingMethod;
    operation: SensorOperationConfig | null;
    maxPoints: number;
}

export interface UseChartDataResult {
    /** Latest successfully fetched view; kept during refetches so the chart
     *  never flashes blank while a new query is in flight. */
    view: ChartViewData | null;
    loading: boolean;
    error: string | null;
}

/** Debounce (ms) before hitting the backend, so rapid filter / sensor edits
 *  don't queue several full-dataset passes back-to-back. */
const DEBOUNCE_MS = 250;

/**
 * Fetch the bounded columnar chart view for the dashboard line chart.
 *
 * The heavy pipeline (dashboard filter → operation transform → hourly
 * aggregation → min/max decimation) runs Rust-side; this hook only ever
 * holds O(maxPoints) values, so selecting millions of rows no longer
 * duplicates the dataset into the JS heap or blocks the main thread.
 *
 * Debounced and race-guarded like `useScatterSample`: a stale in-flight
 * response can never overwrite a newer one.
 */
export function useChartData(query: ChartDataQuery | null): UseChartDataResult {
    const [state, setState] = useState<UseChartDataResult>({
        view: null,
        loading: false,
        error: null,
    });
    const fetchIdRef = useRef(0);

    // Serialise the inputs so the effect only re-runs on a real change (the
    // caller passes freshly-built objects every render).
    const key = query && query.filter.sensors.length > 0 ? JSON.stringify(query) : null;

    useEffect(() => {
        if (key === null || !query) {
            // Nothing to plot — clear the view so the chart empties.
            fetchIdRef.current++;
            setState({ view: null, loading: false, error: null });
            return;
        }

        const myId = ++fetchIdRef.current;
        setState(s => ({ ...s, loading: true, error: null }));

        const timer = setTimeout(() => {
            // snake_case `max_points` matches the Rust param verbatim (same
            // convention as `get_scatter_sample`).
            invoke<ChartViewData>('get_chart_data', {
                filter: query.filter,
                sampling: query.sampling,
                operation: query.operation,
                max_points: query.maxPoints,
            })
                .then(view => {
                    if (fetchIdRef.current !== myId) return; // superseded
                    setState({ view, loading: false, error: null });
                })
                .catch(err => {
                    if (fetchIdRef.current !== myId) return;
                    console.error('get_chart_data failed:', err);
                    setState(s => ({ ...s, loading: false, error: String(err) }));
                });
        }, DEBOUNCE_MS);

        return () => {
            clearTimeout(timer);
            // Invalidate the in-flight request so its late resolve is ignored.
            fetchIdRef.current++;
        };
        // `query` is captured via `key`; depending on `key` alone avoids
        // re-running on unrelated re-renders.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    return state;
}
