import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, HealthSetPoints, WorkspaceState } from '../types';

const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({ emit: (...a: unknown[]) => mockEmit(...a) }));

// Disk fake: `updateWorkspaceData` applies the patch to the CURRENT disk state
// and the REAL incomplete rule, like workspaceManager does.
import { applyIncompleteRule } from '../utils/incompleteRule';
let disk: WorkspaceState;
vi.mock('../workspaceManager', () => ({
    updateWorkspaceData: async (_id: string, patch: (s: WorkspaceState) => WorkspaceState) => {
        const next = applyIncompleteRule(disk, patch(disk));
        disk = next;
        return next;
    },
}));

import { commitHealthVerdict, commitSetPoints, persistModelComplete, SETTINGS_CHANGED_DURING_EXPORT_REASON } from '../utils/healthPersist';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

const baseFg = (models: FailureModel[]): FailureGroupStateSlice => ({
    groups: [], models,
    runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: [], runningConditionNoneConfirmed: true,
    rcLegacyNotice: null,
});
const setDisk = (models: FailureModel[]) => {
    disk = { id: 'ws1', name: 'W', failureGroupState: baseFg(models) } as unknown as WorkspaceState;
};
const trained = (m: FailureModel): FailureModel => ({
    ...m, lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: computeTrainFingerprint(m, baseFg([])),
});
const sp: HealthSetPoints = { kind: 'individual', lower: 1, upper: 9 };
const ind = (over: Partial<FailureModel> = {}) => mk({ id: 'i1', kind: 'individual', targetSensor: 'T', category: 'condition', ...over });

beforeEach(() => { mockEmit.mockClear(); });

describe('commitSetPoints', () => {
    it('writes ONLY healthSetPoints (status, train record and every other model untouched) and broadcasts the whole slice', async () => {
        const other = ind({ id: 'o', status: true });
        setDisk([trained(ind({ status: true })), other]);
        const next = await commitSetPoints('ws1', 'i1', sp);
        const m = next!.failureGroupState!.models.find(x => x.id === 'i1')!;
        expect(m.healthSetPoints).toEqual(sp);
        expect(m.status).toBe(true); // a set-point save never changes the status
        expect(m.lastTrainedAt).toBe('2026-10-03T00:00:00Z');
        expect(next!.failureGroupState!.models.find(x => x.id === 'o')).toEqual(other);
        expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', expect.objectContaining({
            workspaceId: 'ws1', origin: 'build-model', models: next!.failureGroupState!.models,
        }));
    });

    it('computes against what is on disk: a field another window just changed is not reverted', async () => {
        setDisk([ind({ name: 'changed elsewhere' })]);
        const next = await commitSetPoints('ws1', 'i1', sp);
        expect(next!.failureGroupState!.models[0].name).toBe('changed elsewhere');
    });

    it('an unknown model id writes nothing new into any model', async () => {
        setDisk([ind()]);
        const before = JSON.stringify(disk.failureGroupState!.models);
        const next = await commitSetPoints('ws1', 'nope', sp);
        expect(JSON.stringify(next!.failureGroupState!.models)).toBe(before);
    });

    it('honours the origin it is given', async () => {
        setDisk([ind()]);
        await commitSetPoints('ws1', 'i1', sp, 'predictive-model');
        expect(mockEmit.mock.calls[0][1].origin).toBe('predictive-model');
    });
});

describe('persistModelComplete', () => {
    it('marks the model Complete and stores the validated set points in ONE write, then broadcasts', async () => {
        setDisk([trained(ind())]);
        const { next, reason } = await persistModelComplete('ws1', 'i1', sp, null);
        expect(reason).toBeNull();
        expect(next!.failureGroupState!.models[0]).toMatchObject({ status: true, healthSetPoints: sp });
        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockEmit.mock.calls[0][1].models[0].status).toBe(true);
    });

    it('stores the export record (when / where / with which set points) in the same write, and a later set-point save leaves it alone', async () => {
        setDisk([trained(ind())]);
        const record = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/ws/output', setPoints: sp };
        const { next } = await persistModelComplete('ws1', 'i1', sp, null, 'build-model', record);
        expect(next!.failureGroupState!.models[0].healthExport).toEqual(record);
        await commitSetPoints('ws1', 'i1', { kind: 'individual', lower: 0, upper: 99 });
        // the files still carry the old points: the record is what lets the page say "changed after saving"
        expect(disk.failureGroupState!.models[0].healthExport).toEqual(record);
        expect(disk.failureGroupState!.models[0].healthSetPoints).toMatchObject({ lower: 0, upper: 99 });
        expect(disk.failureGroupState!.models[0].status).toBe(true);
    });

    it('without a record (the old call shape) an earlier record is kept, none is invented', async () => {
        const record = { at: 'x', outputDir: 'C:/ws/output', setPoints: sp };
        setDisk([trained(ind({ healthExport: record }))]);
        const { next } = await persistModelComplete('ws1', 'i1', sp, null);
        expect(next!.failureGroupState!.models[0].healthExport).toEqual(record);
        setDisk([trained(ind())]);
        expect((await persistModelComplete('ws1', 'i1', sp, null)).next!.failureGroupState!.models[0].healthExport).toBeUndefined();
    });

    it('a model whose inputs changed since it was trained is NOT marked (re-checked against disk), nothing broadcast', async () => {
        setDisk([{ ...trained(ind()), targetSensor: 'T2' }]);
        const { next, reason } = await persistModelComplete('ws1', 'i1', sp, null);
        expect(reason).toMatch(/Train the model/);
        expect(next!.failureGroupState!.models[0].status).toBe(false);
        expect(mockEmit).not.toHaveBeenCalled();
    });

    it('a never-trained model is not marked', async () => {
        setDisk([ind()]);
        expect((await persistModelComplete('ws1', 'i1', sp, null)).reason).toMatch(/Train the model/);
    });

    it('the gate still applies (no category)', async () => {
        setDisk([trained(ind({ category: null }))]);
        const { reason } = await persistModelComplete('ws1', 'i1', sp, null);
        expect(reason).toMatch(/category/i);
    });

    it('a model deleted in the meantime reports it instead of throwing', async () => {
        setDisk([]);
        expect((await persistModelComplete('ws1', 'gone', sp, null)).reason).toMatch(/no longer exists/);
    });

    it('after completing, an UNRELATED write (a set-point save) keeps it Complete; a scope change sets it Incomplete again', async () => {
        setDisk([trained(ind())]);
        await persistModelComplete('ws1', 'i1', sp, null);
        await commitSetPoints('ws1', 'i1', { kind: 'individual', lower: 0, upper: 99 });
        expect(disk.failureGroupState!.models[0].status).toBe(true);
        // Another window changes the target -> the same rule the real write applies.
        const { updateWorkspaceData } = await import('../workspaceManager');
        await updateWorkspaceData('ws1', prev => ({
            ...prev,
            failureGroupState: { ...prev.failureGroupState!, models: prev.failureGroupState!.models.map(m => ({ ...m, targetSensor: 'T2' })) },
        }));
        expect(disk.failureGroupState!.models[0]).toMatchObject({ status: false, healthSetPoints: { lower: 0, upper: 99 } });
    });
});

// ---------------------------------------------------------------------------
// QA fixes 2026-10-04: races of a long export, and the persisted verdict
// ---------------------------------------------------------------------------

describe('persistModelComplete - changes made while the export ran (QA 2026-10-04)', () => {
    const saved: HealthSetPoints = { kind: 'individual', lower: 20, upper: 80 };
    const edited: HealthSetPoints = { kind: 'individual', lower: 20, upper: 85 };
    const record = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/ws/output', setPoints: saved };
    const raceFor = (m: FailureModel, before: HealthSetPoints | undefined = saved) => ({ fingerprint: computeTrainFingerprint(m, baseFg([])), setPointsBefore: before });

    it('set points committed DURING the export keep their newer values; the record holds the EXPORTED ones; the model is still Complete', async () => {
        const m = trained(ind({ healthSetPoints: saved }));
        setDisk([m]);
        const race = raceFor(m);
        await commitSetPoints('ws1', 'i1', edited); // the user commits 85 while the files are being written
        const { reason } = await persistModelComplete('ws1', 'i1', saved, null, 'build-model', record, race);
        expect(reason).toBeNull();
        const out = disk.failureGroupState!.models[0];
        expect(out.status).toBe(true);
        expect(out.healthSetPoints).toEqual(edited); // NOT reverted to the exported 80
        expect(out.healthExport!.setPoints).toEqual(saved); // what the files carry
    });

    it('set points typed but never committed (disk unchanged since the click): the exported values are stored, as before', async () => {
        const m = trained(ind({ healthSetPoints: { kind: 'individual', lower: null, upper: null } }));
        setDisk([m]);
        const race = raceFor(m, { kind: 'individual', lower: null, upper: null });
        await persistModelComplete('ws1', 'i1', saved, null, 'build-model', record, race);
        expect(disk.failureGroupState!.models[0].healthSetPoints).toEqual(saved);
    });

    it('a model re-configured AND re-trained during the export stays Incomplete (files carry the old settings)', async () => {
        const m = trained(ind({ healthSetPoints: saved }));
        setDisk([m]);
        const race = raceFor(m);
        // another window: new target + re-train => fresh against its NEW settings
        disk = { ...disk, failureGroupState: { ...disk.failureGroupState!, models: [trained({ ...m, targetSensor: 'T2' })] } };
        const { reason } = await persistModelComplete('ws1', 'i1', saved, null, 'build-model', record, race);
        expect(reason).toBe(SETTINGS_CHANGED_DURING_EXPORT_REASON);
        expect(disk.failureGroupState!.models[0].status).toBe(false);
        expect(disk.failureGroupState!.models[0].healthExport).toBeUndefined();
        expect(mockEmit).not.toHaveBeenCalled();
    });

    it('the unchanged model passes the fingerprint check; without a race argument (old call shape) there is no check', async () => {
        const m = trained(ind({ healthSetPoints: saved }));
        setDisk([m]);
        expect((await persistModelComplete('ws1', 'i1', saved, null, 'build-model', record, raceFor(m))).reason).toBeNull();
        const m2 = trained(ind({ healthSetPoints: saved }));
        setDisk([{ ...m2, targetSensor: 'T2', trainedFingerprint: computeTrainFingerprint({ ...m2, targetSensor: 'T2' }, baseFg([])) }]);
        expect((await persistModelComplete('ws1', 'i1', saved, null)).reason).toBeNull();
    });

    it('marks the verdict valid when the validated numbers are what is on disk; drops it when newer numbers were kept', async () => {
        const m = trained(ind({ healthSetPoints: saved, healthVerdict: 'invalid' }));
        setDisk([m]);
        await persistModelComplete('ws1', 'i1', saved, null, 'build-model', record, raceFor(m));
        expect(disk.failureGroupState!.models[0].healthVerdict).toBe('valid');
        const m2 = trained(ind({ healthSetPoints: saved, healthVerdict: 'valid' }));
        setDisk([m2]);
        const race = raceFor(m2);
        await commitSetPoints('ws1', 'i1', edited);
        await persistModelComplete('ws1', 'i1', saved, null, 'build-model', record, race);
        expect(disk.failureGroupState!.models[0].healthVerdict).toBeUndefined();
    });
});

describe('the persisted verdict (healthVerdict)', () => {
    it('commitSetPoints drops a verdict that described the OLD numbers, and keeps it when only the snapshot changed', async () => {
        setDisk([trained(ind({ healthSetPoints: { kind: 'individual', lower: 1, upper: 9 }, healthVerdict: 'valid' }))]);
        await commitSetPoints('ws1', 'i1', { kind: 'individual', lower: 1, upper: 9, masterLower: 1, masterUpper: 9 });
        expect(disk.failureGroupState!.models[0].healthVerdict).toBe('valid');
        await commitSetPoints('ws1', 'i1', { kind: 'individual', lower: 2, upper: 9, masterLower: 1, masterUpper: 9 });
        expect(disk.failureGroupState!.models[0]).not.toHaveProperty('healthVerdict');
    });

    it('commitHealthVerdict writes ONLY the verdict and broadcasts; the same verdict again writes nothing', async () => {
        setDisk([trained(ind({ status: true, healthSetPoints: sp }))]);
        const next = await commitHealthVerdict('ws1', 'i1', 'invalid');
        expect(next!.failureGroupState!.models[0]).toMatchObject({ healthVerdict: 'invalid', status: true, healthSetPoints: sp });
        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockEmit.mock.calls[0][1]).toMatchObject({ workspaceId: 'ws1', origin: 'build-model' });
        mockEmit.mockClear();
        expect(await commitHealthVerdict('ws1', 'i1', 'invalid')).toBeNull();
        expect(mockEmit).not.toHaveBeenCalled();
    });

    it('commitHealthVerdict refuses a model that is gone, never trained or no longer fresh (a verdict of an old fit must not stick)', async () => {
        setDisk([]);
        expect(await commitHealthVerdict('ws1', 'gone', 'valid')).toBeNull();
        setDisk([ind()]);
        expect(await commitHealthVerdict('ws1', 'i1', 'valid')).toBeNull();
        setDisk([{ ...trained(ind()), targetSensor: 'T2' }]);
        expect(await commitHealthVerdict('ws1', 'i1', 'valid')).toBeNull();
        expect(disk.failureGroupState!.models[0]).not.toHaveProperty('healthVerdict');
        expect(mockEmit).not.toHaveBeenCalled();
    });
});
