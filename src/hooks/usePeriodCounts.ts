import { useEffect, useMemo, useRef, useState } from 'react';
import type { TestPeriod, TimePeriod } from '../types';
import type { PeriodCountArg, PeriodCountCondition, PeriodCounts } from '../types/periodCounts';
import { MAX_COUNT_PERIODS } from '../types/periodCounts';
import {
    countCondition, countPeriodRows, PERIOD_COUNTS_IDLE, scoringCountPlan, trainCountPlan,
    type CountFilterInput, type PeriodCountsState,
} from '../utils/periodCounts';

/** Wait after the last change of the draft before counting, so typing a
 *  condition value or a date never fires a call per keystroke. */
export const PERIOD_COUNT_DEBOUNCE_MS = 300;

/** Answers kept per open modal (a draft the user toggles back to is instant). */
const CACHE_LIMIT = 24;

export interface UsePeriodCountsOptions {
    /** Count only while true (the settings are open and loaded); while false nothing is called and old answers are dropped. */
    enabled: boolean;
    /** The workspace on screen; `null` = nothing is counted. */
    workspaceId: string | null;
    /** The DRAFT's train periods, in list order (P1, P2 …). */
    trainPeriods: TimePeriod[];
    /** The DRAFT's scoring periods, in list order (S1, S2 …). */
    scoringPeriods: TestPeriod[];
    /** The DRAFT's running condition from `buildPreviewFilterPayload(draft, headers)`; only `value_filters` and `combine` are used. null = not set. */
    filter: CountFilterInput | null;
    /** Rust dataset generation this window opened on; a window left over from another dataset gets `STALE_SESSION`. */
    expectedGeneration?: number | null;
    /** Default `PERIOD_COUNT_DEBOUNCE_MS`. */
    debounceMs?: number;
}

const CODES = ['STALE_SESSION', 'NO_DATA', 'BAD_REQUEST'] as const;

function parseError(e: unknown): Pick<PeriodCountsState, 'error' | 'errorCode'> {
    const text = e instanceof Error ? e.message : String(e ?? '');
    const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(text);
    const code = m ? CODES.find(c => c === m[1]) ?? null : null;
    return { error: code && m ? (m[2] || text) : text, errorCode: code };
}

/** A usable answer has the three parts the builders read. */
function isCounts(v: unknown): v is PeriodCounts {
    const c = v as PeriodCounts | null;
    return !!c && typeof c === 'object' && typeof c.total_rows === 'number' && Array.isArray(c.periods)
        && !!c.union && typeof c.union.running_rows === 'number';
}

/** Per-period running-row counts (`count_period_rows`) for the settings DRAFT. Debounced; unchanged sides and revisited drafts come from memory; a sequence guard drops late answers; old numbers stay while loading; calls are pinned to `expectedGeneration`. */
export function usePeriodCounts(opts: UsePeriodCountsOptions): PeriodCountsState {
    const { enabled, workspaceId, trainPeriods, scoringPeriods, filter, expectedGeneration } = opts;
    const debounceMs = opts.debounceMs ?? PERIOD_COUNT_DEBOUNCE_MS;
    // Counted value and the request it was for (`key`); a draft changed in this render reads 'loading', never old numbers called 'ok'.
    const [held, setHeld] = useState<{ key: string | null; value: PeriodCountsState }>({ key: null, value: PERIOD_COUNTS_IDLE });
    // Every effect run takes a new number; an answer only lands if it is still
    // the latest one.
    const seq = useRef(0);
    // Answers of this open modal by request, dropped on close: columns can change under one generation.
    const cache = useRef(new Map<string, PeriodCounts>());
    const cacheEpoch = useRef(0);
    // A count has gone out since the modal opened (the first one is not debounced).
    const issued = useRef(false);

    const active = enabled && !!workspaceId;
    // The request, serialised: the effect's only trigger (callers pass fresh
    // arrays every render).
    const requestKey = useMemo(() => {
        if (!active) return null;
        return JSON.stringify({
            ws: workspaceId,
            gen: expectedGeneration ?? null,
            cond: countCondition(filter),
            train: trainCountPlan(trainPeriods).wire,
            scoring: scoringCountPlan(scoringPeriods).wire,
        });
    }, [active, workspaceId, expectedGeneration, filter, trainPeriods, scoringPeriods]);

    useEffect(() => {
        const mine = ++seq.current;
        if (requestKey === null) {
            cache.current = new Map();
            cacheEpoch.current++;
            issued.current = false;
            setHeld(prev => (prev.key === null && prev.value === PERIOD_COUNTS_IDLE ? prev : { key: null, value: PERIOD_COUNTS_IDLE }));
            return () => { seq.current++; };
        }
        const req = JSON.parse(requestKey) as {
            ws: string; gen: number | null; cond: PeriodCountCondition | null; train: PeriodCountArg[]; scoring: PeriodCountArg[];
        };
        const keyOf = (periods: PeriodCountArg[]) => JSON.stringify([req.ws, req.gen, req.cond, periods]);
        const cached = (periods: PeriodCountArg[]): PeriodCounts | null | undefined =>
            periods.length === 0 ? null : cache.current.get(keyOf(periods));

        const trainHit = cached(req.train);
        const scoringHit = cached(req.scoring);
        if (trainHit !== undefined && scoringHit !== undefined) {
            // Nothing to ask (no valid period on either side, or both remembered).
            setHeld({ key: requestKey, value: { status: 'ok', train: trainHit, scoring: scoringHit, error: null, errorCode: null } });
            return () => { seq.current++; };
        }
        // Keep the previous numbers until the new ones land; a known side (remembered, or no valid period) shows at once.
        setHeld(prev => ({
            key: requestKey,
            value: {
                status: 'loading',
                train: trainHit !== undefined ? trainHit : prev.value.train,
                scoring: scoringHit !== undefined ? scoringHit : prev.value.scoring,
                error: null,
                errorCode: null,
            },
        }));

        const epoch = cacheEpoch.current;
        const count = async (periods: PeriodCountArg[], hit: PeriodCounts | null | undefined): Promise<PeriodCounts | null> => {
            if (hit !== undefined) return hit;
            if (periods.length > MAX_COUNT_PERIODS) {
                throw new Error(`BAD_REQUEST: too many periods (${periods.length}); at most ${MAX_COUNT_PERIODS} can be counted in one call`);
            }
            const answer = await countPeriodRows(periods, req.cond, req.gen);
            if (!isCounts(answer)) throw new Error('count_period_rows returned no counts');
            // Keep a correct answer for its own request even if the draft moved on, unless the modal closed.
            if (cacheEpoch.current === epoch) {
                cache.current.set(keyOf(periods), answer);
                while (cache.current.size > CACHE_LIMIT) cache.current.delete(cache.current.keys().next().value as string);
            }
            return answer;
        };
        const run = async () => {
            issued.current = true;
            try {
                const [train, scoring] = await Promise.all([count(req.train, trainHit), count(req.scoring, scoringHit)]);
                if (mine !== seq.current) return;
                setHeld({ key: requestKey, value: { status: 'ok', train, scoring, error: null, errorCode: null } });
            } catch (e) {
                if (mine !== seq.current) return;
                console.warn('Period count failed:', e);
                setHeld({ key: requestKey, value: { status: 'error', train: null, scoring: null, ...parseError(e) } });
            }
        };
        const timer = setTimeout(run, issued.current ? Math.max(0, debounceMs) : 0);
        return () => {
            // Race-guard counter, not a DOM node: cleanup must see its live value so an in-flight answer is ignored.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            seq.current++;
            clearTimeout(timer);
        };
    }, [requestKey, debounceMs]);

    return useMemo<PeriodCountsState>(() => {
        if (requestKey === null) return PERIOD_COUNTS_IDLE;
        if (held.key === requestKey) return held.value;
        // The draft changed in this render (or the modal just opened): its own
        // count has not started yet.
        return { status: 'loading', train: held.value.train, scoring: held.value.scoring, error: null, errorCode: null };
    }, [requestKey, held]);
}
