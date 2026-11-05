import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CsvRecord } from '../types';
import type { ScatterSample } from '../types/commands';

/** Filter payload for get_scatter_sample; same shape as get_chart_data's. */
export interface ScatterSampleFilter {
    sensors: string[];
    timestamp_start: string | null;
    timestamp_end: string | null;
    /** Multiple periods; see `DashboardDataFilter`. */
    timestamp_ranges?: { start: string | null; end: string | null }[];
    value_filters: {
        sensor: string;
        operation: string;
        value1: number | null;
        value2: number | null;
    }[];
}

export interface UseScatterSampleResult {
    rows: CsvRecord[];
    headers: string[];
    /** Total rows that passed the filter (population the sample was drawn from). */
    total: number;
    /** Rows actually returned (`=== rows.length`, `<= maxPoints`). */
    sampled: number;
    loading: boolean;
    error: string | null;
}

const EMPTY: UseScatterSampleResult = {
    rows: [],
    headers: [],
    total: 0,
    sampled: 0,
    loading: false,
    error: null,
};

/** Debounce (ms) so rapid edits don't queue back-to-back full-dataset sampling passes. */
const DEBOUNCE_MS = 200;

/** Fetches a bounded sample for scatter/pair plot (Rust reservoir-samples to maxPoints); runs only while `enabled`, edits are debounced. */
export function useScatterSample(
    filter: ScatterSampleFilter | null,
    maxPoints: number,
    enabled: boolean,
    /** Bumped when columns are recomputed without the query changing; part of the cache key only, never sent. */
    revision: number = 0,
): UseScatterSampleResult {
    const [state, setState] = useState<UseScatterSampleResult>(EMPTY);
    const fetchIdRef = useRef(0);

    // Serialise the inputs so the effect only re-runs on a real change (the
    // caller passes freshly-built objects every render).
    const key = enabled && filter && filter.sensors.length > 0
        ? JSON.stringify({ filter, maxPoints, revision })
        : null;

    useEffect(() => {
        if (key === null || !filter) {
            // Chart not visible (or nothing to plot) — clear any stale loading
            // flag but keep the last data so toggling back is instant.
            setState(s => (s.loading ? { ...s, loading: false } : s));
            return;
        }

        const myId = ++fetchIdRef.current;
        setState(s => ({ ...s, loading: true, error: null }));

        const timer = setTimeout(() => {
            // snake_case `max_points` to match the Rust param; Tauri matches keys exactly.
            invoke<ScatterSample>('get_scatter_sample', { filter, max_points: maxPoints })
                .then(res => {
                    if (fetchIdRef.current !== myId) return; // superseded
                    setState({
                        rows: res.rows as CsvRecord[],
                        headers: res.headers,
                        total: res.total,
                        sampled: res.sampled,
                        loading: false,
                        error: null,
                    });
                })
                .catch(err => {
                    if (fetchIdRef.current !== myId) return;
                    setState(s => ({ ...s, loading: false, error: String(err) }));
                });
        }, DEBOUNCE_MS);

        return () => {
            clearTimeout(timer);
            // Invalidate the in-flight request so its late resolve is ignored; the ref is a counter, so the exhaustive-deps warning does not apply.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            fetchIdRef.current++;
        };
        // `filter` / `maxPoints` are captured via `key`; depending on `key`
        // alone avoids re-running on unrelated re-renders.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    return state;
}
