import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DatasetTimeBounds } from '../types/commands';

export interface UseDatasetTimeBoundsResult {
    bounds: DatasetTimeBounds | null;
    loading: boolean;
    error: string | null;
}

/** Which dataset the bounds are for. `undefined` = caller has no key (one fetch on mount); `null` = not known yet (nothing fetched). */
export type DatasetBoundsKey = number | string | null | undefined;

const LOADING: UseDatasetTimeBoundsResult = { bounds: null, loading: true, error: null };

/** The loaded dataset's true first/last timestamp over every row, independent of dashboard filters. `datasetKey` omitted = fetch once; given = refetch on change, an older key's answer is dropped. */
export function useDatasetTimeBounds(datasetKey?: number | string | null): UseDatasetTimeBoundsResult {
    const [held, setHeld] = useState<{ key: DatasetBoundsKey; value: UseDatasetTimeBoundsResult }>({ key: undefined, value: LOADING });

    useEffect(() => {
        if (datasetKey === null) return;
        let live = true;

        invoke<DatasetTimeBounds>('get_dataset_time_bounds')
            .then(bounds => {
                if (!live) return;
                setHeld({ key: datasetKey, value: { bounds, loading: false, error: null } });
            })
            .catch(err => {
                if (!live) return;
                console.error('get_dataset_time_bounds failed:', err);
                setHeld({ key: datasetKey, value: { bounds: null, loading: false, error: String(err) } });
            });

        return () => {
            live = false;
        };
    }, [datasetKey]);

    // An answer for another dataset (key changed this render, or its answer is still coming) reads as unknown, never the old one.
    return held.key === datasetKey ? held.value : LOADING;
}
