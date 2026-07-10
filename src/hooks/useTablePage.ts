import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SensorOperationConfig } from '../types';
import type {
    ChartSamplingMethod,
    DashboardDataFilter,
    TablePageData,
} from '../types/commands';

/** Inputs for `get_table_page` — the chart query plus a page window. */
export interface TablePageQuery {
    filter: DashboardDataFilter;
    sampling: ChartSamplingMethod;
    operation: SensorOperationConfig | null;
    page: number;
    pageSize: number;
}

export interface UseTablePageResult {
    /** Latest fetched page; kept during refetches to avoid table flicker. */
    page: TablePageData | null;
    loading: boolean;
    error: string | null;
}

const DEBOUNCE_MS = 200;

/**
 * Fetch one page of the post-op / post-aggregation row set for the data
 * table. The backend pages through the true row set, so the WebView holds
 * `pageSize` rows instead of the whole dataset.
 */
export function useTablePage(query: TablePageQuery | null): UseTablePageResult {
    const [state, setState] = useState<UseTablePageResult>({
        page: null,
        loading: false,
        error: null,
    });
    const fetchIdRef = useRef(0);

    const key = query && query.filter.sensors.length > 0 ? JSON.stringify(query) : null;

    useEffect(() => {
        if (key === null || !query) {
            fetchIdRef.current++;
            setState({ page: null, loading: false, error: null });
            return;
        }

        const myId = ++fetchIdRef.current;
        setState(s => ({ ...s, loading: true, error: null }));

        const timer = setTimeout(() => {
            invoke<TablePageData>('get_table_page', {
                filter: query.filter,
                sampling: query.sampling,
                operation: query.operation,
                page: query.page,
                page_size: query.pageSize,
            })
                .then(page => {
                    if (fetchIdRef.current !== myId) return; // superseded
                    setState({ page, loading: false, error: null });
                })
                .catch(err => {
                    if (fetchIdRef.current !== myId) return;
                    console.error('get_table_page failed:', err);
                    setState(s => ({ ...s, loading: false, error: String(err) }));
                });
        }, DEBOUNCE_MS);

        return () => {
            clearTimeout(timer);
            fetchIdRef.current++;
        };
        // `query` is captured via `key` (see useChartData).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    return state;
}
