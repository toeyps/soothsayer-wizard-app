import { describe, it, expect, vi } from 'vitest';
import type { FailureModel, TestPeriod, TimePeriod } from '../types';
import type { PeriodCount, PeriodCounts } from '../types/periodCounts';

// `periodCounts.ts` binds the Rust command; nothing here calls it.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
    dataRangeText, faultOnSide, faultSide, firstInvalidPeriodNumber, firstInvalidTestPeriodNumber, periodDataFit,
    testPeriodsError, toFilterRanges, validatePeriods, validateTestPeriods,
} from '../utils/timePeriods';
import {
    customBlockText, getBuildBlock, getBuildBlockReason, markCompleteBlockReason, runningConditionApplyBlock,
    NO_TRAIN_ROWS_FOOTER, NO_TRAIN_ROWS_REASON, NO_TRAIN_ROWS_REASON_CUSTOM, NO_TRAIN_ROWS_TEXT,
} from '../utils/runningCondition';
import {
    countedNoTrainRows, noRunningRowsNote, runningConditionCaption, scoringCountPlan, scoringRowModels, trainCountPlan,
    trainRowModels, type PeriodCountsState,
} from '../utils/periodCounts';
import { classifyTrainPlan, preflightReason } from '../utils/trainQueue';
import { mk } from './helpers/failureModelFixture';

/*
 * "No data to train on" is stopped at the UI (user request 2026-10-10):
 *   B1 — a period against the loaded data's time range (pure, from the dataset
 *        bounds): entirely outside = invalid, partly outside = a quiet note;
 *   B2 / B3 — a SETTLED count of zero running rows in the train periods.
 * These are the pure rules; the rows / footers / window behaviour are tested in
 * RunningConditionDataGuards.test.tsx and BuildModelWindow.test.tsx.
 */

// The user's own example: the data covers 2025-01 … 2025-12.
const DATA = { min: '2025-01-01 00:00:00', max: '2025-12-31 23:59:00' };
const p = (start: string, end: string, id = `${start}|${end}`): TimePeriod => ({ id, start, end });
const INSIDE = p('2025-03-01T00:00', '2025-04-30T23:59');
const AFTER = p('2026-02-01T00:00', '2026-03-01T00:00');
const BEFORE = p('2024-02-01T00:00', '2024-03-01T00:00');

describe('periodDataFit / validatePeriods against the loaded data', () => {
    it('a period entirely AFTER the data is invalid: fault, reason with the data range in the Workbench date format, both fields wrong', () => {
        const [st] = validatePeriods([AFTER], DATA);
        expect(st.invalid).toBe(true);
        expect(st.fault).toBe('outside-data');
        expect(st.rowReason).toBe('P1 is outside the data (1 Jan 2025 – 31 Dec 2025)');
        expect(st.reason).toBe('P1 is outside the data (1 Jan 2025 – 31 Dec 2025).');
        expect(st.dataNote).toBeUndefined();
        expect(faultOnSide('outside-data', 'start')).toBe(true);
        expect(faultOnSide('outside-data', 'end')).toBe(true);
        expect(firstInvalidPeriodNumber([INSIDE, AFTER], DATA)).toBe(2);
    });

    it('a period entirely BEFORE the data is invalid too, named by its list number', () => {
        const status = validatePeriods([BEFORE, INSIDE], DATA);
        expect(status.map(s => s.fault)).toEqual(['outside-data', undefined]);
        expect(status[0].rowReason).toBe('P1 is outside the data (1 Jan 2025 – 31 Dec 2025)');
        expect(status[1].overlapsPrev).toBe(false); // never "overlaps" a period that is already flagged
    });

    it('open bounds resolve to the data edges: an open START that ends before the first row, an open END that starts after the last row', () => {
        expect(validatePeriods([p('', '2024-06-01T00:00')], DATA)[0].fault).toBe('outside-data');
        expect(validatePeriods([p('2026-06-01T00:00', '')], DATA)[0].fault).toBe('outside-data');
        // open at both ends = the whole data: always inside
        expect(validatePeriods([p('', '')], DATA)[0]).toMatchObject({ invalid: false, dataNote: undefined });
    });

    it('PARTLY outside is valid, with one quiet note that names the side', () => {
        const ends = validatePeriods([p('2025-11-01T00:00', '2026-02-28T23:59')], DATA)[0];
        expect(ends.invalid).toBe(false);
        expect(ends.dataNote).toBe('Only the part inside the data is used (data ends 31 Dec 2025)');
        const starts = validatePeriods([p('2024-11-01T00:00', '2025-02-28T23:59')], DATA)[0];
        expect(starts).toMatchObject({ invalid: false, dataNote: 'Only the part inside the data is used (data starts 1 Jan 2025)' });
        const both = validatePeriods([p('2024-11-01T00:00', '2026-02-28T23:59')], DATA)[0];
        expect(both).toMatchObject({ invalid: false, dataNote: 'Only the part inside the data is used (data runs 1 Jan 2025 – 31 Dec 2025)' });
    });

    it('a bound on the data\'s own first / last calendar day is not "past" it (data that ends at 23:50, a period typed to 23:59)', () => {
        const bounds = { min: '2025-01-01 00:10:00', max: '2025-12-31 23:50:00' };
        expect(validatePeriods([p('2025-01-01T00:00', '2025-12-31T23:59')], bounds)[0]).toMatchObject({ invalid: false, dataNote: undefined });
        // one day further is a note
        expect(validatePeriods([p('2025-01-01T00:00', '2026-01-01T23:59')], bounds)[0].dataNote).toBe('Only the part inside the data is used (data ends 31 Dec 2025)');
        // ...and the invalid reason keeps the time of an edge that is not a whole-day edge
        expect(validatePeriods([p('2026-01-05T00:00', '2026-01-06T00:00')], bounds)[0].rowReason)
            .toBe('P1 is outside the data (1 Jan 2025 00:10 – 31 Dec 2025 23:50)');
    });

    it('with the bounds unknown nothing is flagged — and the plain call (no bounds) is exactly the old rule', () => {
        for (const bounds of [undefined, null, {}, { min: null, max: null }, { min: '2025-01-01 00:00:00', max: null }, { min: 'junk', max: 'junk' }]) {
            const [st] = validatePeriods([AFTER], bounds);
            expect(st).toMatchObject({ invalid: false, fault: undefined, dataNote: undefined });
        }
        expect(validatePeriods([AFTER])[0].invalid).toBe(false);
        expect(firstInvalidPeriodNumber([AFTER])).toBeNull();
    });

    it('a date fault comes first: a reversed or unreadable period keeps its own reason', () => {
        expect(validatePeriods([p('2026-03-01T00:00', '2026-02-01T00:00')], DATA)[0].fault).toBe('ends-before-start');
        expect(validatePeriods([p('junk', '2026-02-01T00:00')], DATA)[0].fault).toBe('start-invalid');
        expect(periodDataFit(p('2026-03-01T00:00', '2026-02-01T00:00'), DATA)).toBeNull();
        expect(faultSide('ends-before-start')).toBe('end');
        expect(faultOnSide('ends-before-start', 'start')).toBe(false);
    });

    it('scoring periods follow the same rule with their S-number', () => {
        const tests: TestPeriod[] = [INSIDE, AFTER, p('2025-12-20T00:00', '2026-01-10T00:00')];
        const status = validateTestPeriods(tests, DATA);
        expect(status.map(s => s.invalid)).toEqual([false, true, false]);
        expect(status[1]).toMatchObject({ fault: 'outside-data', rowReason: 'S2 is outside the data (1 Jan 2025 – 31 Dec 2025)' });
        expect(status[2].dataNote).toBe('Only the part inside the data is used (data ends 31 Dec 2025)');
        expect(firstInvalidTestPeriodNumber(tests, DATA)).toBe(2);
        expect(testPeriodsError(tests, DATA)).toBe('S2 is outside the data (1 Jan 2025 – 31 Dec 2025).');
        // without bounds: the old rule
        expect(testPeriodsError(tests)).toBeNull();
    });

    it('dataRangeText: the date alone on a whole-day edge, date + time otherwise', () => {
        expect(dataRangeText(DATA)).toBe('1 Jan 2025 – 31 Dec 2025');
        expect(dataRangeText({ min: '2025-01-01 06:00:00', max: '2025-12-31 23:59:00' })).toBe('1 Jan 2025 06:00 – 31 Dec 2025');
    });

    it('the request builders are NOT changed by the guard (no bounds there): same wire, same count plan, so nothing is asked differently', () => {
        expect(toFilterRanges([INSIDE, AFTER])).toHaveLength(2);
        expect(trainCountPlan([INSIDE, AFTER]).wire).toHaveLength(2);
        expect(scoringCountPlan([AFTER]).wire).toHaveLength(1);
    });
});

describe('runningConditionApplyBlock with the data guards', () => {
    it('a train period entirely outside the data blocks Apply / Save like any invalid period — "Fix P1 before applying" / "…before saving"', () => {
        const block = runningConditionApplyBlock([AFTER], [], 'applying', { bounds: DATA });
        expect(block).toMatchObject({ kind: 'invalid-train', periodNumber: 1, footer: 'Fix P1 before applying', reason: 'P1 is outside the data (1 Jan 2025 – 31 Dec 2025).' });
        expect(runningConditionApplyBlock([INSIDE, AFTER], [], 'saving', { bounds: DATA })).toMatchObject({ kind: 'invalid-train', periodNumber: 2, footer: 'Fix P2 before saving' });
    });

    it('a scoring period entirely outside the data blocks too ("Fix S1 before applying"); partly outside never blocks', () => {
        expect(runningConditionApplyBlock([INSIDE], [AFTER], 'applying', { bounds: DATA })).toMatchObject({ kind: 'invalid-test', periodNumber: 1, footer: 'Fix S1 before applying' });
        expect(runningConditionApplyBlock([p('2025-11-01T00:00', '2026-02-28T23:59')], [p('2024-12-01T00:00', '2025-01-15T00:00')], 'applying', { bounds: DATA })).toBeNull();
    });

    it('a settled count of zero running rows is the LAST block: "No rows to train on"', () => {
        const block = runningConditionApplyBlock([INSIDE], [INSIDE], 'applying', { bounds: DATA, noTrainRows: true });
        expect(block).toEqual({ kind: 'no-rows', reason: NO_TRAIN_ROWS_TEXT, footer: NO_TRAIN_ROWS_FOOTER });
        expect(NO_TRAIN_ROWS_TEXT).toBe('No rows match — nothing to train on. Widen a train period or relax the condition.');
        expect(NO_TRAIN_ROWS_FOOTER).toBe('No rows to train on');
        // everything else is said first
        expect(runningConditionApplyBlock([], [], 'applying', { noTrainRows: true })!.kind).toBe('no-train');
        expect(runningConditionApplyBlock([AFTER], [], 'applying', { bounds: DATA, noTrainRows: true })!.kind).toBe('invalid-train');
        expect(runningConditionApplyBlock([INSIDE], [p('2025-05-02T00:00', '2025-05-01T00:00')], 'applying', { noTrainRows: true })!.kind).toBe('invalid-test');
    });

    it('without options (or with unknown bounds) it is exactly the old gate', () => {
        expect(runningConditionApplyBlock([AFTER], [AFTER])).toBeNull();
        expect(runningConditionApplyBlock([AFTER], [AFTER], 'applying', { bounds: null, noTrainRows: false })).toBeNull();
    });
});

describe('getBuildBlock with the data guards (the PERSISTED state)', () => {
    const fg = (periods: TimePeriod[]) => ({ models: [], runningConditionFilters: [], runningConditionCombine: 'and' as const, runningConditionNoneConfirmed: true, runningConditionTimePeriods: periods });
    const model = (over: Partial<FailureModel> = {}) => mk({ id: 'm1', category: 'performance', ...over });

    it('a saved train period entirely outside the loaded data blocks Train: `invalid-train` with the named reason', () => {
        const block = getBuildBlock(model(), fg([AFTER]), null, { bounds: DATA });
        expect(block).toMatchObject({
            kind: 'invalid-train', mode: 'workspace', periodNumber: 1, fault: 'outside-data',
            reason: 'P1 is outside the data (1 Jan 2025 – 31 Dec 2025).',
            rowReason: 'P1 is outside the data (1 Jan 2025 – 31 Dec 2025)',
        });
        // the same model without the bounds (a write path, the Dashboard's dot): not blocked
        expect(getBuildBlock(model(), fg([AFTER]), null)).toBeNull();
        expect(getBuildBlockReason(model(), fg([AFTER]), null, { bounds: null })).toBeNull();
    });

    it('a settled count of zero rows is the last block (`no-rows`), worded for where the fix is', () => {
        expect(getBuildBlock(model(), fg([INSIDE]), null, { bounds: DATA, noTrainRows: true })).toEqual({ kind: 'no-rows', mode: 'workspace', reason: NO_TRAIN_ROWS_REASON });
        const custom = model({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [INSIDE] });
        expect(getBuildBlock(custom, fg([]), null, { noTrainRows: true })).toEqual({ kind: 'no-rows', mode: 'custom', reason: NO_TRAIN_ROWS_REASON_CUSTOM });
        // a missing train period is said first
        expect(getBuildBlock(model(), fg([]), null, { noTrainRows: true })!.kind).toBe('no-train');
    });

    it('customBlockText words both for a Custom model, open and closed', () => {
        const custom = model({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [AFTER] });
        const outside = getBuildBlock(custom, fg([]), null, { bounds: DATA })!;
        expect(customBlockText(outside, { settingsOpen: true })).toBe('Move P1 inside the data above');
        expect(customBlockText(outside, { settingsOpen: false })).toBe('Own running condition: P1 is outside the data (1 Jan 2025 – 31 Dec 2025). Fix it in Model settings');
        const noRows = getBuildBlock({ ...custom, filterTimePeriods: [INSIDE] }, fg([]), null, { bounds: DATA, noTrainRows: true })!;
        expect(customBlockText(noRows, { settingsOpen: true })).toBe('Widen a train period or relax the condition above');
        expect(customBlockText(noRows, { settingsOpen: false })).toBe('Own running condition: no rows to train on. Fix it in Model settings');
    });

    it('Mark complete\'s own scoring-period rule is unchanged (a saved scoring period is not judged against the data there)', () => {
        const withTests = { ...fg([INSIDE]), runningConditionTestPeriods: [AFTER] };
        expect(markCompleteBlockReason(model(), withTests)).toBeNull();
    });

    it('the train queue names both reasons: preflight "Skipped" text + where Fix → goes', () => {
        expect(preflightReason('P1 is outside the data (1 Jan 2025 – 31 Dec 2025).')).toEqual({ text: 'Train period P1 is outside the data (1 Jan 2025 – 31 Dec 2025)', fix: 'runningCondition' });
        expect(preflightReason('P1 is outside the data (1 Jan 2025 – 31 Dec 2025).', { customMode: true }).fix).toBe('settings');
        expect(preflightReason(NO_TRAIN_ROWS_REASON)).toEqual({ text: 'No rows to train on', fix: 'runningCondition' });
        expect(preflightReason(NO_TRAIN_ROWS_REASON_CUSTOM, { customMode: true })).toEqual({ text: 'No rows to train on in its own training data', fix: 'settings' });
        // a blocked model is never "ready", whatever its dot says
        expect(classifyTrainPlan({ blockReason: NO_TRAIN_ROWS_REASON, dotState: 'trained' })).toEqual({ kind: 'missing', reason: 'No rows to train on', fix: 'runningCondition' });
    });
});

// ---------------------------------------------------------------------------
// The zero-rows rule reads the counts the panels already ask for
// ---------------------------------------------------------------------------

const pc = (start: string | null, end: string | null, rows: number, running: number, index = 1): PeriodCount =>
    ({ index, start, end, valid: true, invalid_reason: null, rows_in_period: rows, running_rows: running, running_days: running / 288 });
const counts = (periods: PeriodCount[], total = 10_000): PeriodCounts => ({
    total_rows: total, interval_secs: 300, periods,
    union: {
        rows_in_period: periods.reduce((s, c) => s + c.rows_in_period, 0),
        running_rows: periods.reduce((s, c) => s + c.running_rows, 0),
        running_days: periods.reduce((s, c) => s + c.running_days, 0),
    },
});
const state = (status: PeriodCountsState['status'], train: PeriodCounts | null, scoring: PeriodCounts | null = null): PeriodCountsState =>
    ({ status, train, scoring, error: status === 'error' ? 'failed' : null, errorCode: null });

describe('countedNoTrainRows — only a SETTLED count of zero', () => {
    const ZERO = counts([pc(INSIDE.start, INSIDE.end, 500, 0)]);
    const SOME = counts([pc(INSIDE.start, INSIDE.end, 500, 120)]);

    it('true for the request\'s own answer with no running row in the train periods together', () => {
        expect(countedNoTrainRows(state('ok', ZERO))).toBe(true);
        expect(countedNoTrainRows(state('ok', SOME))).toBe(false);
        // one empty period next to one with rows is NOT "nothing to train on"
        expect(countedNoTrainRows(state('ok', counts([pc('a', 'b', 500, 0), pc('c', 'd', 500, 7, 2)])))).toBe(false);
    });

    it('never while the count is loading (the previous answer is still shown), failed, idle, or not there', () => {
        expect(countedNoTrainRows(state('loading', ZERO))).toBe(false);
        expect(countedNoTrainRows(state('error', null))).toBe(false);
        expect(countedNoTrainRows(state('idle', null))).toBe(false);
        expect(countedNoTrainRows(state('ok', null))).toBe(false); // no train period was counted
    });

    it('a FULLY OPEN train period with undated rows is never read as "nothing": those rows are trained on but no period counts them', () => {
        // 60 rows, none with a readable timestamp: the open period holds 0, training uses all 60
        expect(countedNoTrainRows(state('ok', counts([pc(null, null, 0, 0)], 60)))).toBe(false);
        // every row dated: the count is the whole truth
        expect(countedNoTrainRows(state('ok', counts([pc(null, null, 60, 0)], 60)))).toBe(true);
        // a period with a bound is a time gate: undated rows are not trained on either
        expect(countedNoTrainRows(state('ok', counts([pc('2025-01-01T00:00', null, 0, 0)], 60)))).toBe(true);
    });

    it('the caption carries the same answer (`noRows`), and never for a stale / unconfigured count', () => {
        const cap = (st: PeriodCountsState, configured = true) => runningConditionCaption({ trainPeriods: [INSIDE], scoringPeriods: [], bounds: DATA, counts: st, configured });
        expect(cap(state('ok', ZERO)).noRows).toBe(true);
        expect(cap(state('ok', ZERO)).rowsText).toBe('0 of 10,000 rows (0%) used for training');
        expect(cap(state('loading', ZERO)).noRows).toBe(false);
        expect(cap(state('ok', ZERO), false).noRows).toBe(false); // "set the condition to count the rows"
        expect(cap(state('ok', SOME)).noRows).toBe(false);
        expect(cap(state('error', null)).noRows).toBe(false);
    });

    it('the caption treats a period outside the data as a period to fix (no total)', () => {
        const cap = runningConditionCaption({ trainPeriods: [AFTER], scoringPeriods: [], bounds: DATA, counts: state('ok', SOME) });
        expect(cap.rows.kind).toBe('fix');
        expect(cap.rowsText).toBe('fix the period to count the rows');
        expect(cap.noRows).toBe(false);
    });
});

describe('row models: "no running rows in P2" and the editor\'s own verdict', () => {
    const P_A = p('2025-01-01T00:00', '2025-01-31T23:59');
    const P_B = p('2025-06-01T00:00', '2025-06-30T23:59');
    const answer = counts([pc(P_A.start, P_A.end, 800, 640), pc(P_B.start, P_B.end, 800, 0, 2)]);

    it('a settled count of zero for ONE period flags that row; a count on its way never does', () => {
        expect(trainRowModels([P_A, P_B], DATA, state('ok', answer)).map(r => r.noRunningRows)).toEqual([false, true]);
        expect(trainRowModels([P_A, P_B], DATA, state('loading', answer)).map(r => r.noRunningRows)).toEqual([false, false]);
        expect(trainRowModels([P_A, P_B], DATA, state('idle', null)).map(r => r.noRunningRows)).toEqual([false, false]);
        expect(noRunningRowsNote('P2')).toBe('no running rows in P2');
        const scoring = scoringRowModels([P_B], DATA, state('ok', null, counts([pc(P_B.start, P_B.end, 800, 0)])));
        expect(scoring[0]).toMatchObject({ name: 'S1', noRunningRows: true });
    });

    it('`invalid` from the editor (a period outside the data) shows no day count and no running time', () => {
        const rows = trainRowModels([P_A, AFTER], DATA, state('ok', answer), validatePeriods([P_A, AFTER], DATA).map(s => s.invalid));
        expect(rows[1]).toMatchObject({ invalid: true, daysText: '—', runningText: null, noRunningRows: false });
        expect(rows[0].invalid).toBe(false);
    });
});
