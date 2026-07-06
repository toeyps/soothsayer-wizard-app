import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CsvRecord } from '../types';
import type { ScatterSample } from '../types/commands';

/**
 * Filter payload for `get_scatter_sample` — mirrors the dashboard's
 * `get_filtered_data` filter shape so the same value-filter format is reused.
 */
export interface ScatterSampleFilter {
    sensors: string[];
    timestamp_start: string | null;
    timestamp_end: string | null;
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

/** Debounce (ms) before hitting the backend, so rapid filter / sensor edits
 *  don't queue several full-dataset sampling passes back-to-back. */
const DEBOUNCE_MS = 200;

/**
 * Fetch a bounded, GPU-safe sample of the dataset for the scatter / pair-plot
 * charts. The whole reason this exists: a 2 GB CSV is millions of rows, and
 * streaming/holding/uploading all of them blows up the renderer heap and the
 * WebGL context (black canvas). The Rust side reservoir-samples down to
 * `maxPoints` so the payload, heap, and GPU buffers all stay bounded no matter
 * how large the underlying dataset is.
 *
 * The fetch only runs while `enabled` is true (i.e. a scatter/pair chart is
 * actually on screen). Results are race-guarded so a stale in-flight request
 * can't overwrite a newer one, and debounced so filter edits don't spam the
 * backend.
 */
export function useScatterSample(
    filter: ScatterSampleFilter | null,
    maxPoints: number,
    enabled: boolean,
): UseScatterSampleResult {
    const [state, setState] = useState<UseScatterSampleResult>(EMPTY);
    const fetchIdRef = useRef(0);

    // Serialise the inputs so the effect only re-runs on a real change (the
    // caller passes freshly-built objects every render).
    const key = enabled && filter && filter.sensors.length > 0
        ? JSON.stringify({ filter, maxPoints })
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
            // snake_case `max_points` to match the Rust param verbatim (same
            // convention as the other commands — Tauri matches keys exactly).
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
            // Invalidate the in-flight request so its late resolve is ignored.
            fetchIdRef.current++;
        };
        // `filter` / `maxPoints` are captured via `key`; depending on `key`
        // alone avoids re-running on unrelated re-renders.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    return state;
}
