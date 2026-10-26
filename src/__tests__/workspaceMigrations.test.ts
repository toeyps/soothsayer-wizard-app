import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, FailureModel, WorkspaceState } from '../types';
import { migratePeriods, normalizeCategories, migrateHealthSetPoints, migrateSingleRunningCondition } from '../utils/workspaceMigrations';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { isModelComplete, modelDotState } from '../utils/modelStatus';
import { mk as baseMk } from './helpers/failureModelFixture';

/** A PRE-periods model: like the shared fixture, but with no `filterTimePeriods`
 *  (unless given) and free to carry the old `filterTimeStart`/`filterTimeEnd` keys. */
function mk(over: Partial<FailureModel> & { id: string } & Record<string, unknown>): FailureModel {
    const m = baseMk(over as never) as unknown as Record<string, unknown>;
    if (!('filterTimePeriods' in over)) delete m.filterTimePeriods;
    return m as unknown as FailureModel;
}

type Old = Record<string, unknown>;

function ws(fg?: Partial<FailureGroupStateSlice> & Record<string, unknown>): WorkspaceState {
    return {
        id: 'w', name: 'W', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        ...(fg ? { failureGroupState: { groups: [], models: [], ...fg } as FailureGroupStateSlice } : {}),
    };
}

describe('migratePeriods', () => {
    it('no failureGroupState -> same state', () => {
        const s = ws();
        expect(migratePeriods(s)).toBe(s);
    });
    it('turns workspace and per-model single ranges into periods, keeping the old keys by default', () => {
        const s = ws({
            runningConditionTimeStart: '2025-01-01T00:00', runningConditionTimeEnd: '2025-02-01T00:00',
            models: [mk({ id: 'a', filterTimeStart: '2025-03-01T00:00' }), mk({ id: 'b' })],
        });
        const out = migratePeriods(s).failureGroupState!;
        expect(out.runningConditionTimePeriods).toEqual([{ id: 'legacy-1', start: '2025-01-01T00:00', end: '2025-02-01T00:00' }]);
        expect(out.models[0].filterTimePeriods).toEqual([{ id: 'legacy-1', start: '2025-03-01T00:00', end: '' }]);
        expect(out.models[1].filterTimePeriods).toEqual([]);
        expect(out.models[0].customRunningConditionNoneConfirmed).toBe(false);
        expect((out as unknown as Old).runningConditionTimeStart).toBe('2025-01-01T00:00');
        expect((out.models[0] as unknown as Old).filterTimeStart).toBe('2025-03-01T00:00');
    });
    it('both empty -> [] (not one blank period)', () => {
        expect(migratePeriods(ws({ models: [] })).failureGroupState!.runningConditionTimePeriods).toEqual([]);
    });
    it('dropLegacyKeys deletes the old keys everywhere', () => {
        const s = ws({
            runningConditionTimeStart: 'a', runningConditionTimeEnd: 'b',
            models: [mk({ id: 'a', filterTimeStart: 'c', filterTimeEnd: 'd' })],
        });
        const out = migratePeriods(s, { dropLegacyKeys: true }).failureGroupState!;
        expect('runningConditionTimeStart' in out).toBe(false);
        expect('runningConditionTimeEnd' in out).toBe(false);
        expect('filterTimeStart' in out.models[0]).toBe(false);
        expect('filterTimeEnd' in out.models[0]).toBe(false);
        expect(out.runningConditionTimePeriods).toEqual([{ id: 'legacy-1', start: 'a', end: 'b' }]);
        expect(out.models[0].filterTimePeriods).toEqual([{ id: 'legacy-1', start: 'c', end: 'd' }]);
    });
    it('dropLegacyKeys also cleans up when periods already exist (later cleanup pass)', () => {
        const once = migratePeriods(ws({ runningConditionTimeStart: 'a', models: [mk({ id: 'a', filterTimeEnd: 'x' })] }));
        const dropped = migratePeriods(once, { dropLegacyKeys: true }).failureGroupState!;
        expect('runningConditionTimeStart' in dropped).toBe(false);
        expect('filterTimeEnd' in dropped.models[0]).toBe(false);
        expect(dropped.runningConditionTimePeriods).toHaveLength(1);
    });
    it('existing periods (even []) are never overwritten by the legacy keys', () => {
        const s = ws({
            runningConditionTimeStart: 'old', runningConditionTimePeriods: [],
            models: [mk({ id: 'a', filterTimeStart: 'old', filterTimePeriods: [{ id: 'p', start: 'n', end: 'm' }], customRunningConditionNoneConfirmed: true })],
        });
        const out = migratePeriods(s);
        expect(out).toBe(s); // nothing to do -> same reference
        expect(out.failureGroupState!.models[0].filterTimePeriods).toEqual([{ id: 'p', start: 'n', end: 'm' }]);
    });
    it('is idempotent (twice equals once, and second run returns the same reference)', () => {
        const s = ws({ runningConditionTimeStart: 'a', models: [mk({ id: 'a', filterTimeStart: 'c' })] });
        const once = migratePeriods(s);
        expect(migratePeriods(once)).toBe(once);
        const dropOnce = migratePeriods(s, { dropLegacyKeys: true });
        expect(migratePeriods(dropOnce, { dropLegacyKeys: true })).toEqual(dropOnce);
    });
    it('keeps unknown/future slice fields and non-slice workspace fields', () => {
        const s = { ...ws({ futureField: 42, runningConditionCombine: 'or' }), name: 'keep' };
        const out = migratePeriods(s, { dropLegacyKeys: true });
        expect((out.failureGroupState as unknown as Record<string, unknown>).futureField).toBe(42);
        expect(out.failureGroupState!.runningConditionCombine).toBe('or');
        expect(out.name).toBe('keep');
    });
    it('does not mutate its input', () => {
        const s = ws({ runningConditionTimeStart: 'a', models: [mk({ id: 'a', filterTimeStart: 'c' })] });
        const snap = JSON.stringify(s);
        migratePeriods(s, { dropLegacyKeys: true });
        expect(JSON.stringify(s)).toBe(snap);
    });
});

describe('normalizeCategories', () => {
    const conflicting = () => [
        mk({ id: 'i', targetSensor: 'T', category: 'performance' }),
        mk({ id: 'r', kind: 'relationship', targetSensor: 'T', category: 'condition' }),
    ];
    it('no failureGroupState -> same state', () => {
        const s = ws();
        expect(normalizeCategories(s)).toBe(s);
    });
    it('sets the notice with the changes when undefined', () => {
        const out = normalizeCategories(ws({ models: conflicting() })).failureGroupState!;
        expect(out.models.map((m) => m.category)).toEqual(['performance', 'performance']);
        expect(out.categoryNormalisationNotice).toEqual([{ modelId: 'r', kind: 'relationship', sensorKey: 't', from: 'condition', to: 'performance' }]);
    });
    it('sets null (never re-fires) when nothing to change, including an empty workspace', () => {
        expect(normalizeCategories(ws({ models: [] })).failureGroupState!.categoryNormalisationNotice).toBeNull();
        expect(normalizeCategories(ws({ models: [mk({ id: 'a', targetSensor: 'T', category: 'condition' })] })).failureGroupState!.categoryNormalisationNotice).toBeNull();
    });
    it('null and an existing notice both mean handled: state untouched', () => {
        const a = ws({ models: conflicting(), categoryNormalisationNotice: null });
        expect(normalizeCategories(a)).toBe(a);
        const notice = [{ modelId: 'x', kind: 'individual' as const, sensorKey: 't', from: null, to: 'condition' as const }];
        const b = ws({ models: conflicting(), categoryNormalisationNotice: notice });
        expect(normalizeCategories(b)).toBe(b);
    });
    it('is idempotent and keeps sibling fields', () => {
        const s = ws({ runningConditionNoneConfirmed: true, futureField: 1, models: conflicting() });
        const once = normalizeCategories(s);
        expect(normalizeCategories(once)).toBe(once);
        expect(once.failureGroupState!.runningConditionNoneConfirmed).toBe(true);
        expect((once.failureGroupState as unknown as Record<string, unknown>).futureField).toBe(1);
    });
});

describe('migrateHealthSetPoints', () => {
    const three = () => [
        mk({ id: 'i', kind: 'individual', targetSensor: 'T', notes: 'keep' }),
        mk({ id: 'r', kind: 'relationship', targetSensor: 'T' }),
        mk({ id: 'c', kind: 'clustering' }),
    ];
    it('no failureGroupState / no models -> same state', () => {
        const s = ws();
        expect(migrateHealthSetPoints(s)).toBe(s);
        const e = ws({ models: [] });
        expect(migrateHealthSetPoints(e)).toBe(e);
    });
    it('gives each model the empty shape of its kind and keeps everything else', () => {
        const s = ws({ runningConditionCombine: 'or', futureField: 7, models: three() });
        const out = migrateHealthSetPoints(s).failureGroupState!;
        expect(out.models.map((m) => m.healthSetPoints)).toEqual([
            { kind: 'individual', lower: null, upper: null },
            { kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null },
            { kind: 'clustering', outerSd: null },
        ]);
        expect(out.models[0]).toMatchObject({ id: 'i', notes: 'keep' });
        expect(out.runningConditionCombine).toBe('or');
        expect((out as unknown as Old).futureField).toBe(7);
    });
    it('never overwrites existing set points; a state that already has them is returned as the SAME reference', () => {
        const entered = { kind: 'individual' as const, lower: 1, upper: 2, masterLower: 3, masterUpper: null };
        const s = ws({ models: [mk({ id: 'i', healthSetPoints: entered }), mk({ id: 'c', kind: 'clustering', healthSetPoints: { kind: 'clustering', outerSd: 5 } })] });
        expect(migrateHealthSetPoints(s)).toBe(s);
    });
    it('only the model that lacks them changes; others keep their object identity', () => {
        const have = mk({ id: 'h', kind: 'clustering', healthSetPoints: { kind: 'clustering', outerSd: 6 } });
        const out = migrateHealthSetPoints(ws({ models: [have, mk({ id: 'n', kind: 'clustering' })] })).failureGroupState!;
        expect(out.models[0]).toBe(have);
        expect(out.models[1].healthSetPoints).toEqual({ kind: 'clustering', outerSd: null });
    });
    it('is idempotent and does not mutate its input', () => {
        const s = ws({ models: three() });
        const snap = JSON.stringify(s);
        const once = migrateHealthSetPoints(s);
        expect(JSON.stringify(s)).toBe(snap);
        expect(migrateHealthSetPoints(once)).toBe(once);
    });
});

describe('migrateSingleRunningCondition (ONE running condition, 2026-10-26)', () => {
    const above = (sensor: string, value1: string, id = sensor) => ({ id, sensor, operation: 'greater_than' as const, value1, value2: '' });
    const below = (sensor: string, value1: string, id = sensor + '<') => ({ id, sensor, operation: 'less_than' as const, value1, value2: '' });
    const SP = { kind: 'individual' as const, lower: 1, upper: 9 };
    /** A Complete, trained Workspace-mode model. */
    const done = (id: string, over: Partial<FailureModel> = {}) => mk({
        id, targetSensor: 'T', category: 'condition', status: true, filterTimePeriods: [],
        lastTrainedAt: '2026-10-01T00:00:00Z', trainedFingerprint: 'fp', healthSetPoints: SP, healthVerdict: 'valid', ...over,
    });

    it('(1) keeps the FIRST complete ">" of several (AND / OR); Complete Workspace-mode models go Incomplete in the same result, set points kept', () => {
        const s = ws({
            runningConditionFilters: [below('TEMP', '90'), above('SPEED', ' 1200 '), above('LOAD', '10')],
            runningConditionCombine: 'or', rcLegacyNotice: 'pending', futureField: 1,
            models: [done('a'), mk({ id: 'b', status: false })],
        });
        const fg = migrateSingleRunningCondition(s).failureGroupState!;
        expect(fg.runningConditionFilters).toEqual([{ id: 'SPEED', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' }]);
        expect(fg.runningConditionCombine).toBe('and');
        expect(fg.runningConditionNoneConfirmed).toBe(false);
        expect(fg.runningStatus).toBeNull();
        expect(fg.rcLegacyNotice).toBeNull();
        expect((fg as unknown as Old).futureField).toBe(1);
        const a = fg.models.find(m => m.id === 'a')!;
        expect(a).toMatchObject({ status: false, healthSetPoints: SP, lastTrainedAt: '2026-10-01T00:00:00Z', trainedFingerprint: 'fp' });
        expect(a).not.toHaveProperty('healthVerdict');
        expect(fg.runningConditionConversion).toEqual({
            result: 'converted', source: 'first-above',
            before: { filters: s.failureGroupState!.runningConditionFilters, combine: 'or', allRows: false, savedStatus: null },
            after: { sensor: 'SPEED', value: '1200' },
            incompleteModelIds: ['a'],
            customModels: [],
        });
    });

    it('(2) no ">" condition: takes the saved export running status, and clears it', () => {
        const s = ws({
            runningConditionFilters: [below('TEMP', '90')],
            runningStatus: { sensor: 'POWER', stopAtOrBelow: ' 5 ' },
            models: [done('a')],
        });
        const fg = migrateSingleRunningCondition(s).failureGroupState!;
        expect(fg.runningConditionFilters).toEqual([{ id: 'rc-converted', sensor: 'POWER', operation: 'greater_than', value1: '5', value2: '' }]);
        expect(fg.runningStatus).toBeNull();
        expect(fg.runningConditionConversion).toMatchObject({
            result: 'converted', source: 'saved-status', after: { sensor: 'POWER', value: '5' }, incompleteModelIds: ['a'],
            before: { savedStatus: { sensor: 'POWER', stopAtOrBelow: ' 5 ' } },
        });
        // also when the old list was empty and only the export line existed
        const only = migrateSingleRunningCondition(ws({ runningStatus: { sensor: 'POWER', stopAtOrBelow: '5' }, models: [] })).failureGroupState!;
        expect(only.runningConditionConversion).toMatchObject({ result: 'converted', source: 'saved-status' });
    });

    it('(3) "Use all rows" -> needs-set: the condition is emptied (Train blocked) and Complete models go Incomplete', () => {
        const s = ws({
            runningConditionFilters: [above('SPEED', '1200')], runningConditionNoneConfirmed: true,
            models: [done('a'), mk({ id: 'b', status: false })],
        });
        const fg = migrateSingleRunningCondition(s).failureGroupState!;
        expect(fg.runningConditionFilters).toEqual([]);
        expect(fg.runningConditionNoneConfirmed).toBe(false);
        expect(fg.models.map(m => m.status)).toEqual([false, false]);
        expect(fg.models[0]).toMatchObject({ healthSetPoints: SP, trainedFingerprint: 'fp' });
        expect(fg.runningConditionConversion).toMatchObject({
            result: 'needs-set', source: null, after: null, incompleteModelIds: ['a'],
            before: { allRows: true },
        });
        // A saved export line (a sensor + value) is still a source with Use all rows.
        const withSaved = migrateSingleRunningCondition(ws({ runningConditionNoneConfirmed: true, runningStatus: { sensor: 'S', stopAtOrBelow: '1' }, models: [] }));
        expect(withSaved.failureGroupState!.runningConditionConversion).toMatchObject({ result: 'converted', source: 'saved-status' });
        // Only "<" / between / = conditions and no saved line -> needs-set too.
        const none = migrateSingleRunningCondition(ws({ runningConditionFilters: [below('TEMP', '90')], models: [] }));
        expect(none.failureGroupState!.runningConditionConversion).toMatchObject({ result: 'needs-set', after: null });
    });

    it('(4) Custom models: their own condition converts the same way (no saved-status fallback); a Complete one whose rows change goes Incomplete', () => {
        const s = ws({
            runningConditionFilters: [above('SPEED', '1200')],
            models: [
                done('c1', { runningConditionMode: 'custom', customRunningConditionFilters: [below('T', '3'), above('LOAD', '7')], customRunningConditionCombine: 'or' }),
                done('c2', { runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true }),
                done('c3', { runningConditionMode: 'custom', customRunningConditionFilters: [above('LOAD', '7')] }),
                done('w'),
            ],
        });
        const fg = migrateSingleRunningCondition(s).failureGroupState!;
        const by = Object.fromEntries(fg.models.map(m => [m.id, m]));
        expect(by.c1).toMatchObject({ status: false, customRunningConditionFilters: [above('LOAD', '7')], customRunningConditionCombine: 'and', customRunningConditionNoneConfirmed: false, healthSetPoints: SP });
        expect(by.c2).toMatchObject({ status: false, customRunningConditionFilters: [], customRunningConditionNoneConfirmed: false });
        expect(by.c3).toBe(s.failureGroupState!.models[2]); // already one ">" -> untouched
        expect(by.w).toBe(s.failureGroupState!.models[3]); // the workspace condition did not change
        expect(fg.runningConditionFilters).toBe(s.failureGroupState!.runningConditionFilters);
        expect(fg.runningConditionConversion).toMatchObject({
            result: 'converted', source: null, after: { sensor: 'SPEED', value: '1200' },
            incompleteModelIds: ['c1', 'c2'],
            customModels: [{ id: 'c1', result: 'converted' }, { id: 'c2', result: 'needs-set' }],
        });
    });

    it('dropping only blank / half-filled rows next to the one ">" keeps the rows the same: no model goes Incomplete, AND/OR kept, no notice', () => {
        const s = ws({
            runningConditionFilters: [above('SPEED', '1200'), { id: 'x', sensor: '', operation: 'less_than', value1: '', value2: '' }],
            runningConditionCombine: 'or', models: [done('a')],
        });
        const fg = migrateSingleRunningCondition(s).failureGroupState!;
        expect(fg.runningConditionFilters).toEqual([s.failureGroupState!.runningConditionFilters![0]]);
        expect(fg.runningConditionCombine).toBe('or');
        expect(fg.models[0]).toBe(s.failureGroupState!.models[0]);
        expect(fg.runningConditionConversion).toBeNull(); // pure cleanup: nothing to tell the user
    });

    it('pure cleanup keeps the kept row byte-for-byte (untrimmed value1, stray value2), so trained models stay fresh + Complete (workspace and Custom)', () => {
        const odd = { id: 'k', sensor: 'SPEED', operation: 'greater_than' as const, value1: '1200 ', value2: '20' };
        const blank = { id: 'b', sensor: '', operation: 'less_than' as const, value1: '', value2: '' };
        const fgBefore = { runningConditionFilters: [odd, blank], runningConditionCombine: 'or' as const };
        const wsModel = done('w');
        const customBase = done('c', { runningConditionMode: 'custom', customRunningConditionFilters: [odd, { ...blank, id: 'b2' }], customRunningConditionCombine: 'or' });
        const trained = (m: FailureModel) => ({ ...m, trainedFingerprint: computeTrainFingerprint(m, fgBefore) });
        const s = ws({ ...fgBefore, models: [trained(wsModel), trained(customBase)] });
        const fg = migrateSingleRunningCondition(s).failureGroupState!;
        expect(fg.runningConditionFilters).toEqual([odd]);
        expect(fg.runningConditionFilters![0]).toBe(odd);
        const [w, c] = fg.models;
        expect(c.customRunningConditionFilters).toEqual([odd]);
        for (const m of [w, c]) {
            expect(m.status).toBe(true);
            expect(isModelComplete(m, fg)).toBe(true);
            expect(modelDotState(m, fg)).toBe('complete');
        }
        expect(fg.runningConditionConversion).toBeNull();
        expect(migrateSingleRunningCondition({ ...s, failureGroupState: fg }).failureGroupState).toBe(fg);
    });

    it('the notice lists only the old rows that applied (never a blank row)', () => {
        const blank = { id: 'b', sensor: '', operation: 'less_than' as const, value1: '', value2: '' };
        const s = ws({ runningConditionFilters: [below('TEMP', '90'), blank, above('SPEED', '1200')], models: [] });
        const conv = migrateSingleRunningCondition(s).failureGroupState!.runningConditionConversion!;
        expect(conv.before.filters).toEqual([below('TEMP', '90'), above('SPEED', '1200')]);
    });

    it('a single ">" row whose value is still blank (a saved draft) is already the one shape: left alone', () => {
        const draft = [{ id: 'd', sensor: 'SPEED', operation: 'greater_than' as const, value1: '', value2: '' }];
        const s = ws({ runningConditionFilters: draft, runningConditionConversion: null, models: [done('c', { runningConditionMode: 'custom', customRunningConditionFilters: draft })] });
        expect(migrateSingleRunningCondition(s)).toBe(s);
    });

    it('the shape is data-driven: an old shape that came back after the marker was set (null) is normalised silently -- models demoted, no new notice', () => {
        const s = ws({
            runningConditionFilters: [below('T', '1'), above('SPEED', '1200')], runningConditionCombine: 'or',
            runningConditionConversion: null,
            models: [done('a'), done('c', { runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true })],
        });
        const once = migrateSingleRunningCondition(s);
        const fg = once.failureGroupState!;
        expect(fg.runningConditionFilters).toEqual([above('SPEED', '1200')]);
        expect(fg.runningConditionCombine).toBe('and');
        expect(fg.models.map(m => m.status)).toEqual([false, false]);
        expect(fg.models[1]).toMatchObject({ customRunningConditionFilters: [], customRunningConditionNoneConfirmed: false });
        expect(fg.runningConditionConversion).toBeNull();
        expect(migrateSingleRunningCondition(once)).toBe(once);
        // "Use all rows" written back by an older build is cleared too
        const none = migrateSingleRunningCondition(ws({ runningConditionFilters: [above('SPEED', '1')], runningConditionNoneConfirmed: true, runningConditionConversion: null, models: [] }));
        expect(none.failureGroupState).toMatchObject({ runningConditionFilters: [], runningConditionNoneConfirmed: false, runningConditionConversion: null });
    });

    it('an existing (not yet dismissed) notice record is kept as it is when the old shape is normalised again', () => {
        const first = migrateSingleRunningCondition(ws({ runningConditionFilters: [below('T', '1'), above('SPEED', '1200')], models: [done('a')] }));
        const record = first.failureGroupState!.runningConditionConversion!;
        const back = { ...first, failureGroupState: { ...first.failureGroupState!, runningConditionFilters: [below('X', '2'), above('LOAD', '3')] } };
        const fg = migrateSingleRunningCondition(back).failureGroupState!;
        expect(fg.runningConditionFilters).toEqual([above('LOAD', '3')]);
        expect(fg.runningConditionConversion).toBe(record);
    });

    it('already the one shape (or nothing set): only marks the step done (null), nothing else changes', () => {
        const one = ws({ runningConditionFilters: [above('SPEED', '1200')], runningConditionCombine: 'or', models: [done('a')] });
        const fg = migrateSingleRunningCondition(one).failureGroupState!;
        expect(fg.runningConditionConversion).toBeNull();
        expect(fg.models[0]).toBe(one.failureGroupState!.models[0]);
        expect(fg.runningConditionFilters).toBe(one.failureGroupState!.runningConditionFilters);
        expect(fg.runningConditionCombine).toBe('or');
        expect(migrateSingleRunningCondition(ws({ models: [done('a')] })).failureGroupState!.runningConditionConversion).toBeNull();
        // a leftover export line is cleared even then
        const left = migrateSingleRunningCondition(ws({ runningConditionFilters: [above('SPEED', '1')], runningStatus: { sensor: 'X', stopAtOrBelow: '2' } }));
        expect(left.failureGroupState!.runningStatus).toBeNull();
    });

    it('a handled marker with the one shape is a no-op; idempotent, deterministic and does not mutate its input', () => {
        const s = ws({ runningConditionFilters: [below('T', '1'), above('SPEED', '1200')], runningConditionNoneConfirmed: false, models: [done('a')] });
        const snap = JSON.stringify(s);
        const once = migrateSingleRunningCondition(s);
        expect(JSON.stringify(s)).toBe(snap);
        expect(migrateSingleRunningCondition(once)).toBe(once);
        expect(JSON.stringify(migrateSingleRunningCondition(s))).toBe(JSON.stringify(once));
        const dismissed = ws({ runningConditionFilters: [above('SPEED', '1200')], runningConditionConversion: null, models: [done('a')] });
        expect(migrateSingleRunningCondition(dismissed)).toBe(dismissed);
        const noFg = ws();
        expect(migrateSingleRunningCondition(noFg)).toBe(noFg);
    });
});
