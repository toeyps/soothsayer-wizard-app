import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, HealthSetPoints } from '../types';
import type { HealthPreview } from '../types/health';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { checkModelForComplete, HEALTH_ERROR_TEXT, parseHealthError } from '../utils/completeModel';

// An open-ended train period (= no time filter on the wire) and one scoring
// period, which Mark complete requires. The period is deliberately in the shape
// a workspace saved BEFORE holds it (the removed `label` /
// `eventTime` / `fromHighlight` still on it): every request below must carry
// start / end ONLY — an old workspace is validated like a new one.
const fg: FailureGroupStateSlice = {
    groups: [], models: [],
    runningConditionFilters: [], runningConditionCombine: 'and',
    runningConditionTimePeriods: [{ id: 'all', start: '', end: '' }],
    runningConditionTestPeriods: [{ id: 't1', start: '2026-01-01T00:00', end: '2026-01-31T23:59', label: 'problem', eventTime: '2026-01-20T06:00', fromHighlight: 'Bearing' }],
    runningConditionNoneConfirmed: true,
};
const TESTS_WIRE = [{ start: '2026-01-01T00:00', end: '2026-01-31T23:59' }];
const HEADERS = ['T', 'P1'];
const sp: HealthSetPoints = { kind: 'individual', lower: 1, upper: 9 };
const model = mk({ id: 'i1', name: 'Pump', kind: 'individual', targetSensor: 'T' });

// The validating preview reports the scoring interval (3600 = 1-hour averages).
const previewOk = { kind: 'individual', valid: true, validation: [], scoring_interval_secs: 3600 } as unknown as HealthPreview;
const issue = { code: 'lower_inside_3sd', severity: 'error' as const, message: 'L must be below -3SD', field: 'lower' };
const previewBad = { kind: 'individual', valid: false, validation: [issue] } as unknown as HealthPreview;
const run = (m: FailureModel = model, setPoints: HealthSetPoints = sp, f: FailureGroupStateSlice = fg) =>
    checkModelForComplete({ model: m, fg: f, headers: HEADERS, setPoints, expectedGeneration: 2 });

const calls = (cmd: string) => mockInvoke.mock.calls.filter(c => c[0] === cmd);

beforeEach(() => { mockInvoke.mockReset(); });

describe('checkModelForComplete (Mark complete validates only — writes NO files since 2026-10-20)', () => {
    it('valid set points: ONE compute_health_preview call, ok with the set points and the scoring interval', async () => {
        mockInvoke.mockResolvedValue(previewOk);
        const res = await run();
        expect(res).toEqual({ ok: true, setPoints: sp, scoringIntervalSecs: 3600 });
        expect(mockInvoke.mock.calls.map(c => c[0])).toEqual(['compute_health_preview']);
        expect(mockInvoke.mock.calls[0][1].request).toMatchObject({
            kind: 'individual', target: 'T', set_points: { lower: 1, upper: 9 }, expected_generation: 2, test_periods: TESTS_WIRE,
        });
    });

    it('never calls a file-writing command, whatever the outcome', async () => {
        for (const v of [previewOk, previewBad]) {
            mockInvoke.mockReset();
            mockInvoke.mockResolvedValue(v);
            await run();
            expect(mockInvoke.mock.calls.map(c => c[0])).toEqual(['compute_health_preview']);
        }
    });

    it('"just score it": the request carries no label / event time, even from an old workspace whose periods still have them', async () => {
        mockInvoke.mockResolvedValue(previewOk);
        expect((await run()).ok).toBe(true);
        const req = calls('compute_health_preview')[0][1].request;
        expect(req.test_periods).toEqual(TESTS_WIRE);
        expect(Object.keys(req.test_periods[0]).sort()).toEqual(['end', 'start']);
        expect(JSON.stringify(req)).not.toMatch(/label|event_time|eventTime|fromHighlight|problem|Bearing/);
    });

    it('an old period whose event time lay OUTSIDE it is checked like any other', async () => {
        mockInvoke.mockResolvedValue(previewOk);
        const old = { ...fg, runningConditionTestPeriods: [{ id: 't1', start: '2026-01-01T00:00', end: '2026-01-31T23:59', label: 'problem' as const, eventTime: '2027-06-01T00:00' }] };
        expect((await run(model, sp, old)).ok).toBe(true);
        expect(calls('compute_health_preview')[0][1].request.test_periods).toEqual(TESTS_WIRE);
    });

    it('no scoring period -> refused as inputs with the reason, NO Rust call', async () => {
        const res = await run(model, sp, { ...fg, runningConditionTestPeriods: [] });
        expect(res).toMatchObject({ ok: false, reason: 'inputs' });
        expect(res.ok === false && res.error).toMatch(/Add a scoring period/);
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('an invalid scoring period -> refused as inputs, named S<n>, NO Rust call', async () => {
        const bad = { ...fg, runningConditionTestPeriods: [{ id: 't1', start: '2026-02-01T00:00', end: '2026-01-01T00:00' }] };
        expect(await run(model, sp, bad)).toMatchObject({ ok: false, reason: 'inputs', error: 'S1 ends before it starts. Fix it in Running condition → Edit.' });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('a Custom model is checked against ITS OWN scoring periods', async () => {
        mockInvoke.mockResolvedValue(previewOk);
        const custom = mk({
            id: 'i1', name: 'Pump', kind: 'individual', targetSensor: 'T', runningConditionMode: 'custom',
            customRunningConditionNoneConfirmed: true, filterTimePeriods: [{ id: 'o', start: '', end: '' }],
            customTestPeriods: [{ id: 'c', start: '2026-02-01T00:00', end: '2026-02-10T00:00' }],
        });
        expect((await run(custom)).ok).toBe(true);
        expect(calls('compute_health_preview')[0][1].request.test_periods).toEqual([{ start: '2026-02-01T00:00', end: '2026-02-10T00:00' }]);
    });

    it('invalid set points: refuses with the issues', async () => {
        mockInvoke.mockResolvedValue(previewBad);
        expect(await run()).toEqual({ ok: false, reason: 'validation', issues: [issue], code: null, error: null });
    });

    it('a warning-only validation list on a valid preview still passes', async () => {
        const warn = { code: 'unsafe_file_name', severity: 'warning', message: 'm', field: 'name' };
        mockInvoke.mockResolvedValue({ ...previewOk, valid: true, validation: [warn] });
        expect(await run()).toMatchObject({ ok: true });
    });

    for (const [text, code, msg] of [
        ['NOT_FITTED: the cache key belongs to another model', 'NOT_FITTED', 'Fit no longer in memory — load it again.'],
        ['STALE_SESSION: dataset reloaded', 'STALE_SESSION', 'dataset reloaded'],
        ['BAD_REQUEST: Sensor not found: T', 'BAD_REQUEST', 'Sensor not found: T'],
        ['NO_DATA: no rows in scope', 'NO_DATA', 'no rows in scope'],
    ] as const) {
        it(`${code} from the preview is a typed, coded error`, async () => {
            mockInvoke.mockRejectedValue(text);
            expect(await run()).toMatchObject({ ok: false, reason: 'error', code, error: msg });
        });
    }

    it('an unprefixed error (the Relation model engine): code is null, message kept', async () => {
        mockInvoke.mockRejectedValue(new Error('The Relation model engine stopped without returning a result.'));
        expect(await run()).toMatchObject({ ok: false, reason: 'error', code: null, error: 'The Relation model engine stopped without returning a result.' });
    });

    it('Relationship NOT_FITTED: typed error', async () => {
        const rel = mk({ id: 'r1', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P1'], relStiffness: 100_000 });
        mockInvoke.mockRejectedValue('NOT_FITTED: no fit in memory');
        const res = await run(rel, { kind: 'relationship', residualAt80Lower: -1, residualAt80Upper: 1, residualAt0Lower: -2, residualAt0Upper: 2 });
        expect(res).toMatchObject({ ok: false, reason: 'error', code: 'NOT_FITTED' });
    });

    it('a model missing a required sensor never reaches Rust', async () => {
        expect(await run(mk({ id: 'x', kind: 'individual', targetSensor: '' }))).toMatchObject({ ok: false, reason: 'inputs' });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    describe('scoring interval (health score on 1-hour averages)', () => {
        const runWith = async (v: unknown) => {
            mockInvoke.mockResolvedValue({ ...previewOk, scoring_interval_secs: v });
            return run();
        };
        it('returns the interval of the preview that VALIDATED the set points', async () => {
            expect(await runWith(3600)).toMatchObject({ ok: true, scoringIntervalSecs: 3600 });
            expect(await runWith(900)).toMatchObject({ ok: true, scoringIntervalSecs: 900 });
        });
        it.each([undefined, null, 0, -3600, NaN, Infinity, '3600'])('an unusable interval (%s) is left out — never a guessed number', async v => {
            const res = await runWith(v);
            expect(res.ok).toBe(true);
            expect(res).not.toHaveProperty('scoringIntervalSecs');
        });
        it('a refused run carries no interval', async () => {
            mockInvoke.mockResolvedValue(previewBad);
            expect(await run()).not.toHaveProperty('scoringIntervalSecs');
        });
    });
});

describe('the removed export path stays removed', () => {
    it('completeModel / healthExportRecord / getModelOutputDir are gone from the module', async () => {
        const mod = await import('../utils/completeModel') as Record<string, unknown>;
        for (const name of ['completeModel', 'healthExportRecord', 'getModelOutputDir']) expect(mod[name]).toBeUndefined();
    });
});

describe('parseHealthError', () => {
    it('splits a known prefix from the message', () => {
        // NOT_FITTED: the Workbench's own words, never Rust's "this Relation model … train it first"
        expect(parseHealthError('NOT_FITTED: this Relation model has no fit in memory (not trained yet, or the data changed) - train it first'))
            .toEqual({ code: 'NOT_FITTED', message: 'Fit no longer in memory — load it again.' });
        expect(HEALTH_ERROR_TEXT.NOT_FITTED).not.toMatch(/Relationship|re-?train|train it/i);
        expect(parseHealthError(new Error('NO_DATA: nothing in scope'))).toEqual({ code: 'NO_DATA', message: 'nothing in scope' });
        expect(parseHealthError('VALIDATION: a; b')).toEqual({ code: 'VALIDATION', message: 'a; b' });
    });
    it('SIDECAR_OUTDATED (review fix 2026-10-07): known code, the app\'s own user-facing wording', () => {
        const r = parseHealthError('SIDECAR_OUTDATED: The Relation model engine in this build is out of date - please reinstall or update the app.');
        expect(r.code).toBe('SIDECAR_OUTDATED');
        expect(r.message).toBe(HEALTH_ERROR_TEXT.SIDECAR_OUTDATED);
        expect(r.message).toContain('reinstall or update the app');
        expect(r.message).not.toContain('SIDECAR_OUTDATED');
    });
    it('leaves unknown prefixes and plain text alone', () => {
        expect(parseHealthError('SOMETHING_ELSE: x')).toEqual({ code: null, message: 'SOMETHING_ELSE: x' });
        expect(parseHealthError('plain')).toEqual({ code: null, message: 'plain' });
        expect(parseHealthError(undefined)).toEqual({ code: null, message: '' });
    });
});
