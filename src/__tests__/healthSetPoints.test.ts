import { describe, it, expect } from 'vitest';
import type { FailureModel, IndividualHealthSetPoints, SensorMetadata } from '../types';
import {
    emptyHealthSetPoints, seedHealthSetPoints, masterSnapshotOf, setPointSource, canResetToMaster,
    resetToMaster, ensureHealthSetPoints, patchModelHealthSetPoints,
} from '../utils/healthSetPoints';
import { mk } from './helpers/failureModelFixture';

const meta = (tag: string, o: Partial<SensorMetadata> = {}): SensorMetadata =>
    ({ tag, description: tag, unit: '', component: 'C', ...o });

describe('emptyHealthSetPoints', () => {
    it('Individual: lower/upper null and NO master snapshot key (= not taken yet)', () => {
        const sp = emptyHealthSetPoints('individual') as IndividualHealthSetPoints;
        expect(sp).toEqual({ kind: 'individual', lower: null, upper: null });
        expect(sp.masterLower).toBeUndefined();
        expect(sp.masterUpper).toBeUndefined();
    });
    it('Relationship: four null residual points (no defaults)', () => {
        expect(emptyHealthSetPoints('relationship')).toEqual({
            kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null,
        });
    });
    it('Clustering: outerSd null', () => {
        expect(emptyHealthSetPoints('clustering')).toEqual({ kind: 'clustering', outerSd: null });
    });
    it('returns a fresh object each call', () => {
        expect(emptyHealthSetPoints('clustering')).not.toBe(emptyHealthSetPoints('clustering'));
    });
});

describe('masterSnapshotOf', () => {
    it('reads alarmL/alarmH only (not LL/HH)', () => {
        expect(masterSnapshotOf({ alarmL: 1, alarmH: 9 })).toEqual({ masterLower: 1, masterUpper: 9 });
        expect(masterSnapshotOf(meta('T', { alarmLL: 0, alarmHH: 99 }))).toEqual({ masterLower: null, masterUpper: null });
    });
    it('keeps a legitimate 0 and negative values', () => {
        expect(masterSnapshotOf({ alarmL: 0, alarmH: -3 })).toEqual({ masterLower: 0, masterUpper: -3 });
    });
    it('missing entry / non-finite -> null', () => {
        expect(masterSnapshotOf(null)).toEqual({ masterLower: null, masterUpper: null });
        expect(masterSnapshotOf(undefined)).toEqual({ masterLower: null, masterUpper: null });
        expect(masterSnapshotOf({ alarmL: NaN, alarmH: Infinity })).toEqual({ masterLower: null, masterUpper: null });
    });
});

describe('seedHealthSetPoints (model creation)', () => {
    it('Individual with both alarms: snapshot taken and values prefilled', () => {
        expect(seedHealthSetPoints('individual', meta('T', { alarmL: 10, alarmH: 90 }))).toEqual({
            kind: 'individual', lower: 10, upper: 90, masterLower: 10, masterUpper: 90,
        });
    });
    it('Individual with only one alarm: the other side is null/null (user must fill it)', () => {
        expect(seedHealthSetPoints('individual', meta('T', { alarmH: 90 }))).toEqual({
            kind: 'individual', lower: null, upper: 90, masterLower: null, masterUpper: 90,
        });
        expect(seedHealthSetPoints('individual', meta('T', { alarmL: 1 }))).toEqual({
            kind: 'individual', lower: 1, upper: null, masterLower: 1, masterUpper: null,
        });
    });
    it('Individual with no alarms, or a special sensor / sensor with no master entry (null meta): null/null, snapshot TAKEN', () => {
        const none = { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null };
        expect(seedHealthSetPoints('individual', meta('T'))).toEqual(none);
        expect(seedHealthSetPoints('individual', null)).toEqual(none);
    });
    it('Individual with metadata unavailable (undefined): snapshot NOT taken', () => {
        const sp = seedHealthSetPoints('individual') as IndividualHealthSetPoints;
        expect(sp.masterLower).toBeUndefined();
        expect(sp.masterUpper).toBeUndefined();
    });
    it('Relationship and Clustering start empty whatever the metadata says', () => {
        expect(seedHealthSetPoints('relationship', meta('T', { alarmL: 1, alarmH: 2 }))).toEqual(emptyHealthSetPoints('relationship'));
        expect(seedHealthSetPoints('clustering', meta('T', { alarmL: 1, alarmH: 2 }))).toEqual(emptyHealthSetPoints('clustering'));
    });
});

describe('setPointSource (derived label)', () => {
    const sp = (o: Partial<IndividualHealthSetPoints>): IndividualHealthSetPoints =>
        ({ kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null, ...o });
    it('value equal to the master snapshot -> master', () => {
        expect(setPointSource(sp({ lower: 5, masterLower: 5 }), 'lower')).toBe('master');
        expect(setPointSource(sp({ upper: 0, masterUpper: 0 }), 'upper')).toBe('master');
    });
    it('value differs from master -> model', () => {
        expect(setPointSource(sp({ lower: 6, masterLower: 5 }), 'lower')).toBe('model');
    });
    it('value entered where master has none -> model', () => {
        expect(setPointSource(sp({ upper: 7, masterUpper: null }), 'upper')).toBe('model');
    });
    it('value cleared although master has one -> model', () => {
        expect(setPointSource(sp({ lower: null, masterLower: 5 }), 'lower')).toBe('model');
    });
    it('no value and master has none -> not-in-master', () => {
        expect(setPointSource(sp({}), 'lower')).toBe('not-in-master');
    });
    it('untaken snapshot counts as "master has none"', () => {
        const untaken: IndividualHealthSetPoints = { kind: 'individual', lower: null, upper: 4 };
        expect(setPointSource(untaken, 'lower')).toBe('not-in-master');
        expect(setPointSource(untaken, 'upper')).toBe('model');
    });
    it('sides are independent', () => {
        const s = sp({ lower: 5, masterLower: 5, upper: 8, masterUpper: 9 });
        expect(setPointSource(s, 'lower')).toBe('master');
        expect(setPointSource(s, 'upper')).toBe('model');
    });
});

describe('resetToMaster', () => {
    const edited: IndividualHealthSetPoints = { kind: 'individual', lower: 1, upper: 2, masterLower: 10, masterUpper: null };
    it('one side', () => {
        expect(resetToMaster(edited, 'lower')).toEqual({ ...edited, lower: 10 });
        expect(resetToMaster(edited, 'upper')).toEqual({ ...edited, upper: null });
    });
    it('both sides when no side is given; the snapshot itself never changes', () => {
        const out = resetToMaster(edited);
        expect(out).toEqual({ ...edited, lower: 10, upper: null });
        expect(out.masterLower).toBe(10);
        expect(out.masterUpper).toBeNull();
    });
    it('returns the SAME object when nothing differs', () => {
        const same: IndividualHealthSetPoints = { kind: 'individual', lower: 10, upper: null, masterLower: 10, masterUpper: null };
        expect(resetToMaster(same)).toBe(same);
    });
    it('a side with no snapshot is left alone', () => {
        const untaken: IndividualHealthSetPoints = { kind: 'individual', lower: 3, upper: 4 };
        expect(resetToMaster(untaken)).toBe(untaken);
        expect(canResetToMaster(untaken, 'lower')).toBe(false);
    });
    it('canResetToMaster is true only while the value differs from a taken snapshot', () => {
        expect(canResetToMaster(edited, 'lower')).toBe(true);
        expect(canResetToMaster({ ...edited, lower: 10 }, 'lower')).toBe(false);
    });
});

describe('ensureHealthSetPoints', () => {
    const ind = (o: Partial<FailureModel> = {}) => mk({ id: 'i', kind: 'individual', targetSensor: 'Temp-1', ...o });

    it('adds the empty shape for each kind when missing, keeping every other field', () => {
        const m = ind({ notes: 'keep', status: true, lastTrainedAt: 'x' });
        const out = ensureHealthSetPoints(m);
        expect(out.healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: null });
        expect(out).toMatchObject({ notes: 'keep', status: true, lastTrainedAt: 'x', id: 'i' });
        expect(ensureHealthSetPoints(mk({ id: 'r', kind: 'relationship' })).healthSetPoints).toEqual(emptyHealthSetPoints('relationship'));
        expect(ensureHealthSetPoints(mk({ id: 'c', kind: 'clustering' })).healthSetPoints).toEqual(emptyHealthSetPoints('clustering'));
    });

    it('does not take a snapshot while metadata is not supplied', () => {
        const out = ensureHealthSetPoints(ind()) .healthSetPoints as IndividualHealthSetPoints;
        expect(out.masterLower).toBeUndefined();
    });

    it('takes the snapshot (matching the tag trimmed, case-insensitively) and prefills empty sides', () => {
        const out = ensureHealthSetPoints(ind(), [meta(' temp-1 ', { alarmL: 2, alarmH: 8 })]);
        expect(out.healthSetPoints).toEqual({ kind: 'individual', lower: 2, upper: 8, masterLower: 2, masterUpper: 8 });
    });

    it('never overwrites a value the user entered, but still records the snapshot', () => {
        const m = ind({ healthSetPoints: { kind: 'individual', lower: 1.25, upper: null } });
        const out = ensureHealthSetPoints(m, [meta('Temp-1', { alarmL: 2, alarmH: 8 })]).healthSetPoints as IndividualHealthSetPoints;
        expect(out.lower).toBe(1.25);
        expect(out.upper).toBe(8);
        expect(out.masterLower).toBe(2);
        expect(out.masterUpper).toBe(8);
        expect(setPointSource(out, 'lower')).toBe('model');
    });

    it('keeps a user-entered 0', () => {
        const m = ind({ healthSetPoints: { kind: 'individual', lower: 0, upper: 0 } });
        const out = ensureHealthSetPoints(m, [meta('Temp-1', { alarmL: 2, alarmH: 8 })]).healthSetPoints as IndividualHealthSetPoints;
        expect([out.lower, out.upper]).toEqual([0, 0]);
    });

    it('never touches a snapshot that already exists (even when master data has changed since); returns the SAME model', () => {
        const m = ind({ healthSetPoints: { kind: 'individual', lower: 5, upper: 6, masterLower: 5, masterUpper: null } });
        const out = ensureHealthSetPoints(m, [meta('Temp-1', { alarmL: 100, alarmH: 200 })]);
        expect(out).toBe(m);
    });

    it('only fills the side that has no snapshot', () => {
        const m = ind({ healthSetPoints: { kind: 'individual', lower: 5, upper: null, masterLower: 5 } });
        const out = ensureHealthSetPoints(m, [meta('Temp-1', { alarmL: 100, alarmH: 200 })]).healthSetPoints as IndividualHealthSetPoints;
        expect(out).toEqual({ kind: 'individual', lower: 5, upper: 200, masterLower: 5, masterUpper: 200 });
    });

    it('special sensor / absent from metadata -> snapshot null/null, values stay empty', () => {
        const out = ensureHealthSetPoints(ind(), [meta('Other', { alarmL: 1 })]);
        expect(out.healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null });
    });

    it('one-sided master: the missing side is null', () => {
        const out = ensureHealthSetPoints(ind(), [meta('Temp-1', { alarmH: 8 })]);
        expect(out.healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: 8, masterLower: null, masterUpper: 8 });
    });

    it('is idempotent', () => {
        const once = ensureHealthSetPoints(ind(), [meta('Temp-1', { alarmL: 2, alarmH: 8 })]);
        expect(ensureHealthSetPoints(once, [meta('Temp-1', { alarmL: 2, alarmH: 8 })])).toBe(once);
        const bare = ensureHealthSetPoints(mk({ id: 'r', kind: 'relationship' }));
        expect(ensureHealthSetPoints(bare)).toBe(bare);
    });

    it('never alters Relationship / Clustering values that were entered', () => {
        const r = mk({ id: 'r', kind: 'relationship', healthSetPoints: { kind: 'relationship', residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 } });
        expect(ensureHealthSetPoints(r, [meta('Temp-1', { alarmL: 1 })])).toBe(r);
        const c = mk({ id: 'c', kind: 'clustering', healthSetPoints: { kind: 'clustering', outerSd: 5 } });
        expect(ensureHealthSetPoints(c, [])).toBe(c);
    });

    it('a set-points block of the wrong kind is replaced by the empty shape for the model\'s kind', () => {
        const m = mk({ id: 'c', kind: 'clustering', healthSetPoints: { kind: 'individual', lower: 1, upper: 2 } });
        expect(ensureHealthSetPoints(m).healthSetPoints).toEqual({ kind: 'clustering', outerSd: null });
    });
});

describe('patchModelHealthSetPoints', () => {
    it('replaces only the named model\'s set points; others are the same references', () => {
        const a = mk({ id: 'a', kind: 'clustering', notes: 'A' });
        const b = mk({ id: 'b', kind: 'clustering', notes: 'B' });
        const out = patchModelHealthSetPoints([a, b], 'a', { kind: 'clustering', outerSd: 6 });
        expect(out[0]).toMatchObject({ id: 'a', notes: 'A', healthSetPoints: { kind: 'clustering', outerSd: 6 } });
        expect(out[1]).toBe(b);
    });
    it('unknown id -> same array', () => {
        const models = [mk({ id: 'a' })];
        expect(patchModelHealthSetPoints(models, 'zzz', { kind: 'clustering', outerSd: 4 })).toBe(models);
    });
});
