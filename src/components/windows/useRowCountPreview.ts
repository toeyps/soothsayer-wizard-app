import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';

/*
 * "Rows used for training" count for the Running condition UI (2026-10-03).
 *
 * Reuses the existing `compute_sensor_stats` command — it already takes the
 * SAME `filter` payload training/preview uses (see `buildPreviewFilterPayload`
 * in BuildModelWindow.tsx) and reports `count` (finite values of the chosen
 * sensor among the rows that pass). No new Rust command: the count is "rows
 * where the reference sensor has a value", and the total it is compared with
 * is the same sensor counted with no filter, so "Use all rows" reads 100%.
 *
 * Lives next to the component, not in src/hooks/, because it is presentation
 * plumbing for this one UI and takes the already-built payload as input.
 */

/** Shape of the part of `compute_sensor_stats`'s result this needs. */
interface SensorStatsCount {
    count: number;
}

export interface RowCountPreview {
    /** `loading` keeps the previous numbers (if any) so the UI doesn't flicker. */
    status: 'idle' | 'loading' | 'ok' | 'error';
    used: number | null;
    total: number | null;
}

const IDLE: RowCountPreview = { status: 'idle', used: null, total: null };

/** Rust returns Err (not count 0) when no row passes. */
const NO_ROWS = 'No valid numeric values';

export interface RowCountOptions {
    enabled: boolean;
    workspaceId: string | null;
    /** Reference sensor the count is taken on. */
    sensor: string | null;
    /** The `filter` argument of `compute_sensor_stats` (`null` = no filter). */
    filter: unknown;
    /** Instance-scoped result cache (key -> count), shared by the hooks of one
     *  window so opening the modal on an unedited draft costs no query. */
    cache: MutableRefObject<Map<string, number>>;
    /** Wait this long after the last change before querying (typing). */
    debounceMs?: number;
}

export function useRowCountPreview({ enabled, workspaceId, sensor, filter, cache, debounceMs = 0 }: RowCountOptions): RowCountPreview {
    const [state, setState] = useState<RowCountPreview>(IDLE);
    // Every effect run takes a new number; a response only lands if it is still
    // the latest, so a slow, superseded query can never overwrite a newer one.
    const seq = useRef(0);
    const filterKey = useMemo(() => JSON.stringify(filter ?? null), [filter]);

    useEffect(() => {
        const mine = ++seq.current;
        if (!enabled || !workspaceId || !sensor) {
            setState(IDLE);
            return () => { seq.current++; };
        }
        const usedKey = JSON.stringify([workspaceId, sensor, JSON.parse(filterKey)]);
        const totalKey = JSON.stringify([workspaceId, sensor, null]);
        const cachedUsed = cache.current.get(usedKey);
        const cachedTotal = cache.current.get(totalKey);
        if (cachedUsed !== undefined && cachedTotal !== undefined) {
            setState({ status: 'ok', used: cachedUsed, total: cachedTotal });
            return () => { seq.current++; };
        }
        setState(prev => ({ status: 'loading', used: prev.used, total: prev.total }));

        const count = async (key: string, f: unknown): Promise<number> => {
            const hit = cache.current.get(key);
            if (hit !== undefined) return hit;
            let n: number;
            try {
                const stats = await invoke<SensorStatsCount>('compute_sensor_stats', { sensor, filter: f });
                n = typeof stats?.count === 'number' ? stats.count : NaN;
            } catch (e) {
                if (!String(e).includes(NO_ROWS)) throw e;
                n = 0;
            }
            if (Number.isNaN(n)) throw new Error('compute_sensor_stats returned no count');
            cache.current.set(key, n);
            return n;
        };
        const run = async () => {
            try {
                // No filter at all: used === total, one query is enough.
                const [used, total] = usedKey === totalKey
                    ? await count(totalKey, null).then(n => [n, n] as const)
                    : await Promise.all([count(usedKey, JSON.parse(filterKey)), count(totalKey, null)]);
                if (mine !== seq.current) return;
                setState({ status: 'ok', used, total });
            } catch (e) {
                console.warn('Row-count preview failed:', e);
                if (mine !== seq.current) return;
                setState({ status: 'error', used: null, total: null });
            }
        };
        const timer = debounceMs > 0 ? setTimeout(run, debounceMs) : null;
        if (timer === null) void run();
        return () => {
            seq.current++;
            if (timer !== null) clearTimeout(timer);
        };
    }, [enabled, workspaceId, sensor, filterKey, debounceMs, cache]);

    return state;
}

/** "25%" / "<1%" / "—" for used-of-total. */
export function formatPercent(used: number | null, total: number | null): string {
    if (used === null || total === null || total <= 0) return '—';
    if (used <= 0) return '0%';
    const pct = (used / total) * 100;
    return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}
