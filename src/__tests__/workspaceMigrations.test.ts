import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, FailureModel, WorkspaceState } from '../types';
import { migratePeriods, normalizeCategories, flagLegacyGate, migrateHealthSetPoints } from '../utils/workspaceMigrations';
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

describe('flagLegacyGate', () => {
    const f = { id: 'f', sensor: 'S', operation: 'greater_than' as const, value1: '1', value2: '' };
    it('pending when there are models and no configured condition', () => {
        expect(flagLegacyGate(ws({ models: [mk({ id: 'a' })] })).failureGroupState!.rcLegacyNotice).toBe('pending');
    });
    it('a time range alone does not stop it being pending', () => {
        const out = flagLegacyGate(ws({ models: [mk({ id: 'a' })], runningConditionTimeStart: '2025-01-01T00:00' }));
        expect(out.failureGroupState!.rcLegacyNotice).toBe('pending');
    });
    it('null when configured (row or none-confirmed) or when there are no models', () => {
        expect(flagLegacyGate(ws({ models: [mk({ id: 'a' })], runningConditionFilters: [f] })).failureGroupState!.rcLegacyNotice).toBeNull();
        expect(flagLegacyGate(ws({ models: [mk({ id: 'a' })], runningConditionNoneConfirmed: true })).failureGroupState!.rcLegacyNotice).toBeNull();
        expect(flagLegacyGate(ws({ models: [] })).failureGroupState!.rcLegacyNotice).toBeNull();
    });
    it('an incomplete row does not count as configured', () => {
        expect(flagLegacyGate(ws({ models: [mk({ id: 'a' })], runningConditionFilters: [{ ...f, value1: '' }] })).failureGroupState!.rcLegacyNotice).toBe('pending');
    });
    it('null and pending are both "already handled" (undefined is the only trigger)', () => {
        const a = ws({ models: [mk({ id: 'a' })], rcLegacyNotice: null });
        expect(flagLegacyGate(a)).toBe(a);
        const b = ws({ models: [mk({ id: 'a' })], runningConditionFilters: [f], rcLegacyNotice: 'pending' });
        expect(flagLegacyGate(b)).toBe(b); // does not clear a pending notice
    });
    it('no failureGroupState -> same state; idempotent', () => {
        const s = ws();
        expect(flagLegacyGate(s)).toBe(s);
        const once = flagLegacyGate(ws({ models: [mk({ id: 'a' })] }));
        expect(flagLegacyGate(once)).toBe(once);
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
