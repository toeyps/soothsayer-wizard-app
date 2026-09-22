import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DatasetTimeBounds } from '../types/commands';

export interface UseDatasetTimeBoundsResult {
    bounds: DatasetTimeBounds | null;
    loading: boolean;
    error: string | null;
}

/**
 * Fetch the loaded dataset's TRUE first/last timestamp, over every row —
 * independent of whatever time-range filter is currently applied on the
 * dashboard. `useChartData`'s `ts_min`/`ts_max` can't serve this: they're
 * computed from the (possibly filtered) query population, so once any time
 * filter is applied they stop reflecting the dataset's real extent. This
 * hook is the Dashboard's one source of truth for "what does the whole
 * dataset span" — used for the Time Range panel's "data available" label
 * and to anchor the Y/M/W/D/H relative-range buttons to the data itself
 * instead of the machine's clock.
 *
 * No inputs: one dataset is loaded per Dashboard mount (a new CSV load
 * always goes back through Import first), so this fetches once on mount
 * rather than taking a query key like `useChartData`/`useScatterSample`.
 */
export function useDatasetTimeBounds(): UseDatasetTimeBoundsResult {
    const [state, setState] = useState<UseDatasetTimeBoundsResult>({
        bounds: null,
        loading: true,
        error: null,
    });

    useEffect(() => {
        let live = true;
        setState(s => ({ ...s, loading: true, error: null }));

        invoke<DatasetTimeBounds>('get_dataset_time_bounds')
            .then(bounds => {
                if (!live) return;
                setState({ bounds, loading: false, error: null });
            })
            .catch(err => {
                if (!live) return;
                console.error('get_dataset_time_bounds failed:', err);
                setState({ bounds: null, loading: false, error: String(err) });
            });

        return () => {
            live = false;
        };
    }, []);

    return state;
}
