import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TestPeriod, TimePeriod } from '../types';
import type { PeriodCountArg, PeriodCounts } from '../types/periodCounts';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

import { usePeriodCounts, PERIOD_COUNT_DEBOUNCE_MS, type UsePeriodCountsOptions } from '../hooks/usePeriodCounts';
import { PERIOD_COUNTS_IDLE, runningConditionCaption, trainRowModels } from '../utils/periodCounts';
import { createFakeHealthRust, STALE_SESSION_ERROR, type HealthDataset } from './helpers/fakeHealthRust';

const P1: TimePeriod = { id: 'p1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
const P2: TimePeriod = { id: 'p2', start: '2026-03-01T00:00', end: '2026-03-31T23:59' };
const S1: TestPeriod = { id: 's1', start: '2026-02-01T00:00', end: '2026-02-28T23:59' };
const S2: TestPeriod = { id: 's2', start: '2026-04-01T00:00', end: '2026-04-30T23:59' };
const BAD: TimePeriod = { id: 'bad', start: '2026-05-11T00:00', end: '2026-05-01T00:00' };
const COND = { value_filters: [{ sensor: 'KW', operation: 'greater_than' as const, value1: 4000, value2: null }], combine: 'and' as const };
/** The training payload as `buildPreviewFilterPayload` builds it (with its time ranges). */
const FILTER = { timestamp_ranges: [{ start: P1.start, end: P1.end }], ...COND };

const wire = (list: { start: string; end: string }[]): PeriodCountArg[] => list.map(p => ({ start: p.start || null, end: p.end || null }));

/** An answer whose numbers say which request it belongs to: `running_rows` of
 *  the union = 100 x the number of periods + `seed`. */
const answer = (periods: PeriodCountArg[], seed = 0): PeriodCounts => ({
    total_rows: 1_000, interval_secs: 600,
    periods: periods.map((p, i) => ({ index: i + 1, start: p.start ?? null, end: p.end ?? null, valid: true, invalid_reason: null, rows_in_period: 200, running_rows: 100, running_days: 0.7 })),
    union: { rows_in_period: 200 * periods.length, running_rows: 100 * periods.length + seed, running_days: 0.7 * periods.length },
});

const base: UsePeriodCountsOptions = {
    enabled: true, workspaceId: 'ws1', trainPeriods: [P1], scoringPeriods: [S1], filter: FILTER, expectedGeneration: 4,
};
const setup = (over: Partial<UsePeriodCountsOptions> = {}) => {
    const initial = { ...base, ...over };
    const hook = renderHook((props: UsePeriodCountsOptions) => usePeriodCounts(props), { initialProps: initial });
    return { ...hook, initial };
};
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const calls = () => mockInvoke.mock.calls.map(c => c[1] as { periods: PeriodCountArg[]; filter: unknown; expected_generation: number | null });

beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (_cmd: string, args: { periods: PeriodCountArg[] }) => answer(args.periods));
});
afterEach(() => { vi.useRealTimers(); });

describe('usePeriodCounts — what is called', () => {
    it('opening: TWO calls at once (no debounce), one with the train periods, one with the scoring periods — snake_case keys, the condition without its time ranges, pinned to the generation', async () => {
        const { result } = setup();
        expect(result.current.status).toBe('loading'); // from the very first render, before anything was called
        expect(mockInvoke).not.toHaveBeenCalled();
        await tick(0);
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        expect(mockInvoke.mock.calls.every(c => c[0] === 'count_period_rows')).toBe(true);
        expect(calls()).toEqual([
            { periods: wire([P1]), filter: COND, expected_generation: 4 },
            { periods: wire([S1]), filter: COND, expected_generation: 4 },
        ]);
        expect(JSON.stringify(calls())).not.toMatch(/timestamp_ranges|expectedGeneration/);
        expect(result.current).toEqual({ status: 'ok', train: answer(wire([P1])), scoring: answer(wire([S1])), error: null, errorCode: null });
    });

    it('never one call per period: three train periods and two scoring periods are still two calls', async () => {
        setup({ trainPeriods: [P1, { id: 'm', start: '2026-02-01T00:00', end: '2026-02-10T00:00' }, P2], scoringPeriods: [S1, S2] });
        await tick(0);
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        expect(calls().map(c => c.periods.length)).toEqual([3, 2]);
    });

    it('"Use all rows" / no condition is sent as filter null; no pinned generation as null', async () => {
        setup({ filter: null, expectedGeneration: undefined });
        await tick(0);
        expect(calls()).toEqual([
            { periods: wire([P1]), filter: null, expected_generation: null },
            { periods: wire([S1]), filter: null, expected_generation: null },
        ]);
    });

    it('a side with no valid period makes NO call; an invalid period is never sent', async () => {
        const { result } = setup({ trainPeriods: [P1, BAD], scoringPeriods: [] });
        await tick(0);
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(calls()[0].periods).toEqual(wire([P1])); // BAD dropped: it must not be part of the union
        expect(result.current).toMatchObject({ status: 'ok', scoring: null });
        expect(result.current.train?.periods).toHaveLength(1);
    });

    it('nothing valid on either side: status ok with no numbers and no call at all', async () => {
        const { result } = setup({ trainPeriods: [], scoringPeriods: [{ id: 'x', start: '', end: '' }] });
        await tick(PERIOD_COUNT_DEBOUNCE_MS * 2);
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(result.current).toEqual({ status: 'ok', train: null, scoring: null, error: null, errorCode: null });
    });

    it('more periods than Rust takes in one call (64): an error without asking', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const many = Array.from({ length: 65 }, (_, i) => ({ id: `t${i}`, start: '2026-01-01T00:00', end: '2026-01-02T00:00' }));
        const { result } = setup({ scoringPeriods: many, trainPeriods: [] });
        await tick(0);
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(result.current).toMatchObject({ status: 'error', errorCode: 'BAD_REQUEST', train: null, scoring: null });
        warn.mockRestore();
    });
});

describe('usePeriodCounts — nothing gets slower', () => {
    it('never fires while the modal is closed — whatever the draft does meanwhile', async () => {
        const { result, rerender, initial } = setup({ enabled: false });
        await tick(1_000);
        rerender({ ...initial, enabled: false, trainPeriods: [P1, P2] });
        rerender({ ...initial, enabled: false, filter: null });
        await tick(1_000);
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(result.current).toBe(PERIOD_COUNTS_IDLE);
    });

    it('no workspace: idle, nothing called', async () => {
        const { result } = setup({ workspaceId: null });
        await tick(1_000);
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(result.current.status).toBe('idle');
    });

    it('typing: no call per keystroke — a changing draft waits for the debounce, and only the settled draft is counted', async () => {
        const { rerender, initial } = setup();
        await tick(0);
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        const typed = (v: number) => ({ ...FILTER, value_filters: [{ ...COND.value_filters[0], value1: v }] });
        rerender({ ...initial, filter: typed(4) });
        await tick(PERIOD_COUNT_DEBOUNCE_MS - 1);
        rerender({ ...initial, filter: typed(40) }); // a keystroke later: the wait restarts
        await tick(PERIOD_COUNT_DEBOUNCE_MS - 1);
        rerender({ ...initial, filter: typed(400) });
        await tick(PERIOD_COUNT_DEBOUNCE_MS - 1);
        expect(mockInvoke).toHaveBeenCalledTimes(2); // still only the opening pair
        await tick(1);
        expect(mockInvoke).toHaveBeenCalledTimes(4); // ONE round, for the settled draft
        expect(calls().slice(2).map(c => (c.filter as typeof COND).value_filters[0].value1)).toEqual([400, 400]);
        expect(PERIOD_COUNT_DEBOUNCE_MS).toBe(300);
    });

    it('a re-render that changes nothing (new arrays, same content) asks nothing', async () => {
        const { rerender, initial } = setup();
        await tick(0);
        rerender({ ...initial, trainPeriods: [{ ...P1 }], scoringPeriods: [{ ...S1 }], filter: JSON.parse(JSON.stringify(FILTER)) });
        // an id is not part of a count either
        rerender({ ...initial, trainPeriods: [{ ...P1, id: 'other' }] });
        await tick(1_000);
        expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it('only the scoring periods changed: ONE call — the train side is answered from memory (and the other way round)', async () => {
        const { result, rerender, initial } = setup();
        await tick(0);
        rerender({ ...initial, scoringPeriods: [S1, S2] });
        expect(result.current.train).toEqual(answer(wire([P1]))); // its own, still right
        await tick(PERIOD_COUNT_DEBOUNCE_MS);
        expect(mockInvoke).toHaveBeenCalledTimes(3);
        expect(calls()[2].periods).toEqual(wire([S1, S2]));
        rerender({ ...initial, scoringPeriods: [S1, S2], trainPeriods: [P1, P2] });
        await tick(PERIOD_COUNT_DEBOUNCE_MS);
        expect(mockInvoke).toHaveBeenCalledTimes(4);
        expect(calls()[3].periods).toEqual(wire([P1, P2]));
        expect(result.current.status).toBe('ok');
    });

    it('a TRAIN period edit does not re-count the scoring periods even though the training payload (its time ranges) changed', async () => {
        const { rerender, initial } = setup();
        await tick(0);
        const moved = { ...P1, end: '2026-01-20T23:59' };
        rerender({ ...initial, trainPeriods: [moved], filter: { ...FILTER, timestamp_ranges: [{ start: moved.start, end: moved.end }] } });
        await tick(PERIOD_COUNT_DEBOUNCE_MS);
        expect(mockInvoke).toHaveBeenCalledTimes(3);
        expect(calls()[2].periods).toEqual(wire([moved]));
    });

    it('going back to a draft already counted (within one open modal) costs no call and is instant', async () => {
        const { result, rerender, initial } = setup();
        await tick(0);
        rerender({ ...initial, trainPeriods: [P1, P2] });
        await tick(PERIOD_COUNT_DEBOUNCE_MS);
        expect(mockInvoke).toHaveBeenCalledTimes(3);
        rerender(initial); // undo
        await tick(0);
        expect(mockInvoke).toHaveBeenCalledTimes(3);
        expect(result.current).toMatchObject({ status: 'ok', train: answer(wire([P1])) });
    });

    it('closing drops the numbers and the memory; opening again counts again (two calls, at once)', async () => {
        const { result, rerender, initial } = setup();
        await tick(0);
        expect(result.current.status).toBe('ok');
        rerender({ ...initial, enabled: false });
        expect(result.current).toBe(PERIOD_COUNTS_IDLE); // in the same render: a closed modal holds nothing
        await tick(1_000);
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        rerender(initial);
        expect(result.current).toEqual({ status: 'loading', train: null, scoring: null, error: null, errorCode: null });
        await tick(0);
        expect(mockInvoke).toHaveBeenCalledTimes(4);
        expect(result.current.status).toBe('ok');
    });

    it('a different dataset generation or workspace is a different request', async () => {
        const { rerender, initial } = setup();
        await tick(0);
        rerender({ ...initial, expectedGeneration: 5 });
        await tick(PERIOD_COUNT_DEBOUNCE_MS);
        expect(mockInvoke).toHaveBeenCalledTimes(4);
        expect(calls().slice(2).every(c => c.expected_generation === 5)).toBe(true);
        rerender({ ...initial, expectedGeneration: 5, workspaceId: 'ws2' });
        await tick(PERIOD_COUNT_DEBOUNCE_MS);
        expect(mockInvoke).toHaveBeenCalledTimes(6);
    });
});

describe('usePeriodCounts — answers', () => {
    it('while a new count is on its way: "loading" in the same render, with the previous numbers kept (no flicker)', async () => {
        const { result, rerender, initial } = setup();
        await tick(0);
        const before = result.current;
        mockInvoke.mockImplementation(() => new Promise(() => {})); // never answers
        rerender({ ...initial, trainPeriods: [P1, P2], scoringPeriods: [S1, S2] });
        expect(result.current).toEqual({ status: 'loading', train: before.train, scoring: before.scoring, error: null, errorCode: null });
        await tick(PERIOD_COUNT_DEBOUNCE_MS + 50);
        expect(result.current).toEqual({ status: 'loading', train: before.train, scoring: before.scoring, error: null, errorCode: null });
    });

    it('a slow answer of an older draft never replaces a newer one (sequence guard)', async () => {
        const held: Record<string, (v: PeriodCounts) => void> = {};
        mockInvoke.mockImplementation((_c: string, args: { periods: PeriodCountArg[] }) => new Promise<PeriodCounts>(res => { held[JSON.stringify(args.periods)] = res; }));
        const { result, rerender, initial } = setup({ scoringPeriods: [] });
        await tick(0);
        rerender({ ...initial, scoringPeriods: [], trainPeriods: [P1, P2] });
        await tick(PERIOD_COUNT_DEBOUNCE_MS);
        expect(Object.keys(held)).toHaveLength(2);
        // the NEWER draft answers first ...
        await act(async () => { held[JSON.stringify(wire([P1, P2]))](answer(wire([P1, P2]), 7)); });
        expect(result.current).toMatchObject({ status: 'ok' });
        expect(result.current.train?.union.running_rows).toBe(207);
        // ... then the old one finally lands: ignored
        await act(async () => { held[JSON.stringify(wire([P1]))](answer(wire([P1]), 999)); });
        expect(result.current.train?.union.running_rows).toBe(207);
        expect(result.current.status).toBe('ok');
    });

    it('a Rust error: status "error", no numbers, the code from its prefix', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const [text, code, message] of [
            ['STALE_SESSION: the dataset changed since this window was opened', 'STALE_SESSION', 'the dataset changed since this window was opened'],
            ['NO_DATA: no dataset is loaded', 'NO_DATA', 'no dataset is loaded'],
            ['BAD_REQUEST: too many periods (65); at most 64 can be counted in one call', 'BAD_REQUEST', 'too many periods (65); at most 64 can be counted in one call'],
            ['something else broke', null, 'something else broke'],
        ] as const) {
            mockInvoke.mockRejectedValue(text);
            const { result, unmount } = setup();
            await tick(0);
            expect(result.current).toEqual({ status: 'error', train: null, scoring: null, error: message, errorCode: code });
            unmount();
        }
        warn.mockRestore();
    });

    it('one side failing fails the round (no half answer), and the next change of the draft tries again', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockInvoke.mockImplementation(async (_c: string, args: { periods: PeriodCountArg[] }) => {
            if (args.periods[0].start === S1.start) throw 'NO_DATA: no dataset is loaded';
            return answer(args.periods);
        });
        const { result, rerender, initial } = setup();
        await tick(0);
        expect(result.current).toMatchObject({ status: 'error', train: null, scoring: null, errorCode: 'NO_DATA' });
        mockInvoke.mockImplementation(async (_c: string, args: { periods: PeriodCountArg[] }) => answer(args.periods));
        rerender({ ...initial, scoringPeriods: [S2] });
        await tick(PERIOD_COUNT_DEBOUNCE_MS);
        expect(result.current).toMatchObject({ status: 'ok', train: answer(wire([P1])), scoring: answer(wire([S2])) });
        warn.mockRestore();
    });

    it('an answer that is not a count (a backend without the command answers null) is an error, never NaN on screen', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const bad of [null, undefined, {}, { total_rows: 5 }, { total_rows: 5, periods: [] }]) {
            mockInvoke.mockResolvedValue(bad);
            const { result, unmount } = setup();
            await tick(0);
            expect(result.current).toMatchObject({ status: 'error', train: null, scoring: null, errorCode: null });
            unmount();
        }
        warn.mockRestore();
    });

    it('unmounting mid-count is safe (no state update afterwards)', async () => {
        let release!: (v: PeriodCounts) => void;
        mockInvoke.mockImplementation(() => new Promise<PeriodCounts>(res => { release = res; }));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { unmount } = setup({ scoringPeriods: [] });
        await tick(0);
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        unmount();
        await act(async () => { release(answer(wire([P1]))); });
        expect(err).not.toHaveBeenCalled();
        err.mockRestore();
    });

    it('closing while a count is in flight: its late answer neither shows nor is remembered for the next opening', async () => {
        let release!: (v: PeriodCounts) => void;
        mockInvoke.mockImplementation(() => new Promise<PeriodCounts>(res => { release = res; }));
        const { result, rerender, initial } = setup({ scoringPeriods: [] });
        await tick(0);
        rerender({ ...initial, scoringPeriods: [], enabled: false });
        await act(async () => { release(answer(wire([P1]), 55)); });
        expect(result.current).toBe(PERIOD_COUNTS_IDLE);
        mockInvoke.mockImplementation(async (_c: string, args: { periods: PeriodCountArg[] }) => answer(args.periods));
        rerender({ ...initial, scoringPeriods: [] });
        await tick(0);
        expect(mockInvoke).toHaveBeenCalledTimes(2); // asked again, not served the stale 155
        expect(result.current.train?.union.running_rows).toBe(100);
    });
});

/*
 * End to end against the fake Rust (`helpers/fakeHealthRust.ts`, a port of
 * `period_counts.rs`): the hook's two calls, then the caption and the rows the
 * modal prints from them.
 */
describe('usePeriodCounts + the fake Rust — the numbers the modal shows', () => {
    // 4 days of 10-minute rows; RUN = 1 during 06:00-17:50 (half of every day).
    const ROWS_PER_DAY = 144;
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = (i: number) => `2024-01-${pad(Math.floor(i / ROWS_PER_DAY) + 1)}T${pad(Math.floor((i % ROWS_PER_DAY) / 6))}:${pad((i % 6) * 10)}:00`;
    const n = 4 * ROWS_PER_DAY;
    const dataset: HealthDataset = {
        headers: ['timestamp', 'RUN'],
        timestamps: Array.from({ length: n }, (_, i) => stamp(i)),
        columns: { RUN: Array.from({ length: n }, (_, i) => { const h = Math.floor((i % ROWS_PER_DAY) / 6); return h >= 6 && h < 18 ? 1 : 0; }) },
    };
    const RUNNING = { value_filters: [{ sensor: 'RUN', operation: 'greater_than' as const, value1: 0.5, value2: null }], combine: 'and' as const };
    const D12: TimePeriod = { id: 'a', start: '2024-01-01T00:00', end: '2024-01-02T23:59' };
    const D23: TimePeriod = { id: 'b', start: '2024-01-02T00:00', end: '2024-01-03T23:59' };
    const D4: TestPeriod = { id: 's', start: '2024-01-04T00:00', end: '2024-01-04T23:59' };
    const BOUNDS = { min: dataset.timestamps[0], max: dataset.timestamps[n - 1] };

    it('overlapping train periods: each row line has its own running time, the caption counts a shared row once', async () => {
        const rust = createFakeHealthRust({ datasets: { d: dataset } });
        mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => rust.invoke(cmd, args));
        const props: UsePeriodCountsOptions = { enabled: true, workspaceId: 'ws', trainPeriods: [D12, D23], scoringPeriods: [D4], filter: RUNNING, expectedGeneration: rust.generation() };
        const { result } = renderHook((o: UsePeriodCountsOptions) => usePeriodCounts(o), { initialProps: props });
        await tick(0);
        expect(rust.cmds('count_period_rows')).toHaveLength(2);
        expect(result.current.status).toBe('ok');
        expect(result.current.train?.union).toEqual({ rows_in_period: 432, running_rows: 216, running_days: 1.5 }); // days 1-3 once, not 288 + 288
        expect(trainRowModels([D12, D23], BOUNDS, result.current).map(r => r.text)).toEqual(['P1 · 2 d · 1 d running', 'P2 · 2 d · 1 d running']);
        const caption = runningConditionCaption({ trainPeriods: [D12, D23], scoringPeriods: [D4], bounds: BOUNDS, counts: result.current });
        expect(caption.text).toBe('3 d train (about 1.5 d running time) · 1 d scoring · 216 of 576 rows (38%) used for training · ≥ 30 d recommended');
        expect(caption.belowRecommended).toBe(true);
    });

    it('"Use all rows": every row inside the train periods is used', async () => {
        const rust = createFakeHealthRust({ datasets: { d: dataset } });
        mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => rust.invoke(cmd, args));
        const { result } = renderHook(() => usePeriodCounts({ enabled: true, workspaceId: 'ws', trainPeriods: [{ id: 'all', start: '', end: '' }], scoringPeriods: [], filter: null, expectedGeneration: rust.generation() }));
        await tick(0);
        expect(rust.cmds('count_period_rows')).toHaveLength(1);
        expect(rust.cmds('count_period_rows')[0].args).toEqual({ periods: [{ start: null, end: null }], filter: null, expected_generation: 1 });
        const caption = runningConditionCaption({ trainPeriods: [{ id: 'all', start: '', end: '' }], scoringPeriods: [], bounds: BOUNDS, counts: result.current });
        expect(caption.rowsText).toBe('576 of 576 rows (100%) used for training');
        expect(caption.scoringText).toBe('no scoring time');
    });

    it('a window left over from another dataset is told STALE_SESSION, not given that dataset numbers', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const rust = createFakeHealthRust({ datasets: { d: dataset, other: dataset } });
        mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => rust.invoke(cmd, args));
        const opened = rust.generation();
        rust.loadDataset('other'); // load_csv meanwhile: a new generation
        const { result } = renderHook(() => usePeriodCounts({ enabled: true, workspaceId: 'ws', trainPeriods: [D12], scoringPeriods: [], filter: RUNNING, expectedGeneration: opened }));
        await tick(0);
        expect(result.current).toEqual({ status: 'error', train: null, scoring: null, error: STALE_SESSION_ERROR.replace('STALE_SESSION: ', ''), errorCode: 'STALE_SESSION' });
        warn.mockRestore();
    });
});
