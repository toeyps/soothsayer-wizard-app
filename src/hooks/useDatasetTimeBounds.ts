import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DatasetTimeBounds } from '../types/commands';

export interface UseDatasetTimeBoundsResult {
    bounds: DatasetTimeBounds | null;
    loading: boolean;
    error: string | null;
}

/** Which dataset the bounds are asked for. `undefined` = the caller has no key
 *  (one fetch on mount); `null` = not known yet (nothing is fetched). */
export type DatasetBoundsKey = number | string | null | undefined;

const LOADING: UseDatasetTimeBoundsResult = { bounds: null, loading: true, error: null };

/**
 * Fetch the loaded dataset's TRUE first/last timestamp, over every row —
 * independent of whatever time-range filter is currently applied on the
 * dashboard. `useChartData`'s `ts_min`/`ts_max` can't serve this: they're
 * computed from the (possibly filtered) query population, so once any time
 * filter is applied they stop reflecting the dataset's real extent. This
 * hook is the one source of truth for "what does the whole dataset span" —
 * used for the Time Range panel's "data available" label, to anchor the
 * Y/M/W/D/H relative-range buttons to the data itself instead of the machine's
 * clock, and by the Build Model window's "no data to train on" guards.
 *
 * `datasetKey` — which dataset the bounds are asked for:
 *  - omitted (the Dashboard): one dataset is loaded per Dashboard mount (a new
 *    CSV load always goes back through Import first), so this fetches once on
 *    mount;
 *  - given (the Build Model window: the workspace it is pointed at + the Rust
 *    dataset GENERATION): that window outlives its dataset — it is re-pointed at
 *    another workspace while it stays open — so the bounds are fetched again
 *    whenever the key changes, and they are `null` ("unknown") from the very
 *    render the key changes in until the answer for THAT key has landed. An
 *    answer that belongs to an older key is dropped: it must never be read as
 *    the new dataset's range (the guards would call a valid period "outside the
 *    data"). `null` = the dataset is not known yet: nothing is fetched.
 * One request per key, nothing else.
 */
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

    // The answer on hand is for another dataset (the key changed in this very
    // render, or its own answer is still on its way): unknown, never the old one.
    return held.key === datasetKey ? held.value : LOADING;
}
