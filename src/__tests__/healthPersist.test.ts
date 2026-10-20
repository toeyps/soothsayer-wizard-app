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

// `checkModelForComplete` (used by the Mark complete flow below) calls Rust.
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));

import { commitHealthVerdict, commitSetPoints, persistModelComplete, SETTINGS_CHANGED_DURING_EXPORT_REASON, TESTS_CHANGED_DURING_EXPORT_REASON } from '../utils/healthPersist';
import { checkModelForComplete } from '../utils/completeModel';
import { NO_TEST_PERIOD_REASON } from '../utils/runningCondition';
import { testPeriodsKey, toScoringPeriods } from '../utils/timePeriods';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import type { TestPeriod } from '../types';
import { LEGACY_TESTS } from './helpers/trainTestFixture';

// A scoring period is start → end only.
const TEST: TestPeriod = { id: 't1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
// A train period is required to train and a scoring period to Mark complete.
const baseFg = (models: FailureModel[]): FailureGroupStateSlice => ({
    groups: [], models,
    runningConditionFilters: [], runningConditionCombine: 'and',
    runningConditionTimePeriods: [{ id: 'tr', start: '2025-01-01T00:00', end: '2025-12-31T23:59' }],
    runningConditionTestPeriods: [TEST],
    runningConditionNoneConfirmed: true,
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
    it('writes healthSetPoints (train record and every other model untouched) and broadcasts the whole slice; an Incomplete model stays Incomplete', async () => {
        const other = ind({ id: 'o', status: true });
        setDisk([trained(ind()), other]);
        const next = await commitSetPoints('ws1', 'i1', sp);
        const m = next!.failureGroupState!.models.find(x => x.id === 'i1')!;
        expect(m.healthSetPoints).toEqual(sp);
        expect(m.status).toBe(false);
        expect(m.lastTrainedAt).toBe('2026-10-03T00:00:00Z');
        expect(next!.failureGroupState!.models.find(x => x.id === 'o')).toEqual(other);
        expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', expect.objectContaining({
            workspaceId: 'ws1', origin: 'build-model', models: next!.failureGroupState!.models,
        }));
    });

    it('different numbers on a Complete model set it back to Incomplete in the SAME write (still trained, verdict and export record kept)', async () => {
        const record = { at: 'x', outputDir: 'C:/ws/output', setPoints: sp };
        setDisk([{ ...trained(ind({ status: true, healthSetPoints: sp, healthExport: record })), healthVerdict: 'valid' }]);
        const next = await commitSetPoints('ws1', 'i1', { kind: 'individual', lower: 0, upper: 99 });
        const m = next!.failureGroupState!.models[0];
        expect(m).toMatchObject({ status: false, healthSetPoints: { lower: 0, upper: 99 }, lastTrainedAt: '2026-10-03T00:00:00Z', healthExport: record });
        // commitSetPoints itself drops the verdict of the OLD numbers (unchanged behaviour)
        expect(m.healthVerdict).toBeUndefined();
        // the broadcast carries the demoted model
        expect(mockEmit.mock.calls[0][1].models[0].status).toBe(false);
    });

    it('the SAME numbers (only a snapshot change) keep a Complete model Complete', async () => {
        setDisk([trained(ind({ status: true, healthSetPoints: sp }))]);
        const next = await commitSetPoints('ws1', 'i1', { ...sp, masterLower: 1, masterUpper: 9 } as HealthSetPoints);
        expect(next!.failureGroupState!.models[0].status).toBe(true);
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
        await commitSetPoints('ws1', 'i1', sp, 'dashboard');
        expect(mockEmit.mock.calls[0][1].origin).toBe('dashboard');
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

    it('writes NO healthExport record (2026-10-20: Mark complete writes no files); an old record on disk is left untouched', async () => {
        setDisk([trained(ind())]);
        const { next } = await persistModelComplete('ws1', 'i1', sp, null);
        expect(next!.failureGroupState!.models[0]).not.toHaveProperty('healthExport');
        const old = { at: 'x', outputDir: 'C:/ws/output', setPoints: sp };
        setDisk([trained(ind({ healthExport: old }))]);
        expect((await persistModelComplete('ws1', 'i1', sp, null)).next!.failureGroupState!.models[0].healthExport).toEqual(old);
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

    it('the completing write keeps its new set points AND Complete (status false -> true is exempt from the set-point rule)', async () => {
        setDisk([trained(ind({ healthSetPoints: { kind: 'individual', lower: 5, upper: 6 } }))]);
        const { reason } = await persistModelComplete('ws1', 'i1', sp, null);
        expect(reason).toBeNull();
        expect(disk.failureGroupState!.models[0]).toMatchObject({ status: true, healthSetPoints: sp });
    });

    it('after completing, an UNRELATED write (a model name) keeps it Complete; a scope change sets it Incomplete again', async () => {
        setDisk([trained(ind())]);
        await persistModelComplete('ws1', 'i1', sp, null);
        const { updateWorkspaceData } = await import('../workspaceManager');
        await updateWorkspaceData('ws1', prev => ({
            ...prev,
            failureGroupState: { ...prev.failureGroupState!, models: prev.failureGroupState!.models.map(m => ({ ...m, name: 'renamed' })) },
        }));
        expect(disk.failureGroupState!.models[0].status).toBe(true);
        await commitSetPoints('ws1', 'i1', { kind: 'individual', lower: 0, upper: 99 });
        expect(disk.failureGroupState!.models[0].status).toBe(false);
        await persistModelComplete('ws1', 'i1', { kind: 'individual', lower: 0, upper: 99 }, null);
        expect(disk.failureGroupState!.models[0].status).toBe(true);
        // Another window changes the target -> the same rule the real write applies.
        await updateWorkspaceData('ws1', prev => ({
            ...prev,
            failureGroupState: { ...prev.failureGroupState!, models: prev.failureGroupState!.models.map(m => ({ ...m, targetSensor: 'T2' })) },
        }));
        expect(disk.failureGroupState!.models[0]).toMatchObject({ status: false, healthSetPoints: { lower: 0, upper: 99 } });
    });
});

// ---------------------------------------------------------------------------
// The real Mark complete flow: validate (no files), then ONE write
// ---------------------------------------------------------------------------

describe('Mark complete = checkModelForComplete + persistModelComplete (no files)', () => {
    const HEADERS = ['T'];
    beforeEach(() => { mockInvoke.mockReset(); });

    it('validates with compute_health_preview only, then marks Complete in one write with one broadcast', async () => {
        setDisk([trained(ind())]);
        mockInvoke.mockResolvedValue({ kind: 'individual', valid: true, validation: [], scoring_interval_secs: 3600 });
        const fg = disk.failureGroupState!;
        const res = await checkModelForComplete({ model: fg.models[0], fg, headers: HEADERS, setPoints: sp });
        if (!res.ok) throw new Error(`refused: ${res.reason} ${res.error ?? ''}`);
        const { reason } = await persistModelComplete('ws1', 'i1', res.setPoints, HEADERS, 'build-model');
        expect(reason).toBeNull();
        expect(mockInvoke.mock.calls.map(c => c[0])).toEqual(['compute_health_preview']);
        const m = disk.failureGroupState!.models[0];
        expect(m).toMatchObject({ status: true, healthSetPoints: sp, healthVerdict: 'valid' });
        expect(m).not.toHaveProperty('healthExport');
        expect(mockEmit).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Races of a long export, and the persisted verdict
// ---------------------------------------------------------------------------

describe('persistModelComplete - changes made while the export ran (QA 2026-10-04)', () => {
    const saved: HealthSetPoints = { kind: 'individual', lower: 20, upper: 80 };
    const edited: HealthSetPoints = { kind: 'individual', lower: 20, upper: 85 };
    const raceFor = (m: FailureModel, before: HealthSetPoints | undefined = saved) => ({ fingerprint: computeTrainFingerprint(m, baseFg([])), setPointsBefore: before });

    it('set points committed DURING the check keep their newer values; the model is still Complete', async () => {
        const m = trained(ind({ healthSetPoints: saved }));
        setDisk([m]);
        const race = raceFor(m);
        await commitSetPoints('ws1', 'i1', edited); // the user commits 85 while the files are being written
        const { reason } = await persistModelComplete('ws1', 'i1', saved, null, 'build-model', race);
        expect(reason).toBeNull();
        const out = disk.failureGroupState!.models[0];
        expect(out.status).toBe(true);
        expect(out.healthSetPoints).toEqual(edited); // NOT reverted to the exported 80
    });

    it('set points typed but never committed (disk unchanged since the click): the exported values are stored, as before', async () => {
        const m = trained(ind({ healthSetPoints: { kind: 'individual', lower: null, upper: null } }));
        setDisk([m]);
        const race = raceFor(m, { kind: 'individual', lower: null, upper: null });
        await persistModelComplete('ws1', 'i1', saved, null, 'build-model', race);
        expect(disk.failureGroupState!.models[0].healthSetPoints).toEqual(saved);
    });

    it('a model re-configured AND re-trained during the export stays Incomplete (files carry the old settings)', async () => {
        const m = trained(ind({ healthSetPoints: saved }));
        setDisk([m]);
        const race = raceFor(m);
        // another window: new target + re-train => fresh against its NEW settings
        disk = { ...disk, failureGroupState: { ...disk.failureGroupState!, models: [trained({ ...m, targetSensor: 'T2' })] } };
        const { reason } = await persistModelComplete('ws1', 'i1', saved, null, 'build-model', race);
        expect(reason).toBe(SETTINGS_CHANGED_DURING_EXPORT_REASON);
        expect(disk.failureGroupState!.models[0].status).toBe(false);
        expect(mockEmit).not.toHaveBeenCalled();
    });

    it('the unchanged model passes the fingerprint check; without a race argument (old call shape) there is no check', async () => {
        const m = trained(ind({ healthSetPoints: saved }));
        setDisk([m]);
        expect((await persistModelComplete('ws1', 'i1', saved, null, 'build-model', raceFor(m))).reason).toBeNull();
        const m2 = trained(ind({ healthSetPoints: saved }));
        setDisk([{ ...m2, targetSensor: 'T2', trainedFingerprint: computeTrainFingerprint({ ...m2, targetSensor: 'T2' }, baseFg([])) }]);
        expect((await persistModelComplete('ws1', 'i1', saved, null)).reason).toBeNull();
    });

    it('marks the verdict valid when the validated numbers are what is on disk; drops it when newer numbers were kept', async () => {
        const m = trained(ind({ healthSetPoints: saved, healthVerdict: 'invalid' }));
        setDisk([m]);
        await persistModelComplete('ws1', 'i1', saved, null, 'build-model', raceFor(m));
        expect(disk.failureGroupState!.models[0].healthVerdict).toBe('valid');
        const m2 = trained(ind({ healthSetPoints: saved, healthVerdict: 'valid' }));
        setDisk([m2]);
        const race = raceFor(m2);
        await commitSetPoints('ws1', 'i1', edited);
        await persistModelComplete('ws1', 'i1', saved, null, 'build-model', race);
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

describe('persistModelComplete - scoring periods', () => {
    it('refuses without a scoring period (re-checked against disk), nothing written or broadcast', async () => {
        setDisk([trained(ind())]);
        disk = { ...disk, failureGroupState: { ...disk.failureGroupState!, runningConditionTestPeriods: [] } };
        const { reason } = await persistModelComplete('ws1', 'i1', sp, null);
        expect(reason).toBe(NO_TEST_PERIOD_REASON);
        expect(disk.failureGroupState!.models[0].status).toBe(false);
        expect(mockEmit).not.toHaveBeenCalled();
    });

    it('Mark complete clears testsChangedAt in the same write', async () => {
        setDisk([{ ...trained(ind()), testsChangedAt: '2026-10-07T00:00:00Z' }]);
        const { reason } = await persistModelComplete('ws1', 'i1', sp, null);
        expect(reason).toBeNull();
        expect(disk.failureGroupState!.models[0].status).toBe(true);
        expect(disk.failureGroupState!.models[0]).not.toHaveProperty('testsChangedAt');
    });

    it('scoring periods edited DURING the export keep the model Incomplete (the files describe the old ones)', async () => {
        const m = trained(ind());
        setDisk([m]);
        const race = { fingerprint: computeTrainFingerprint(m, baseFg([])), setPointsBefore: undefined, testsKey: testPeriodsKey([TEST]) };
        const moved = [{ ...TEST, end: '2026-02-15T00:00' }];
        disk = { ...disk, failureGroupState: { ...disk.failureGroupState!, runningConditionTestPeriods: moved } };
        const { reason } = await persistModelComplete('ws1', 'i1', sp, null, 'build-model', race);
        expect(reason).toBe(TESTS_CHANGED_DURING_EXPORT_REASON);
        expect(TESTS_CHANGED_DURING_EXPORT_REASON).toBe('the scoring periods changed while it was being checked — mark it complete again.');
        expect(disk.failureGroupState!.models[0].status).toBe(false);
        // Unchanged periods pass.
        const ok = await persistModelComplete('ws1', 'i1', sp, null, 'build-model', { ...race, testsKey: testPeriodsKey(moved) });
        expect(ok.reason).toBeNull();
    });

    it('an old workspace (periods still carrying label / eventTime): Mark complete works, and periods that only LOST those keys during the export are not "changed"', async () => {
        const m = trained(ind());
        setDisk([m]);
        disk = { ...disk, failureGroupState: { ...disk.failureGroupState!, runningConditionTestPeriods: LEGACY_TESTS } };
        // key taken at click time from the old-shaped list...
        const race = { fingerprint: computeTrainFingerprint(m, baseFg([])), setPointsBefore: undefined, testsKey: testPeriodsKey(LEGACY_TESTS) };
        // ...while the export ran, an edit elsewhere re-wrote the same periods without the legacy keys
        disk = { ...disk, failureGroupState: { ...disk.failureGroupState!, runningConditionTestPeriods: toScoringPeriods(LEGACY_TESTS) } };
        const { reason } = await persistModelComplete('ws1', 'i1', sp, null, 'build-model', race);
        expect(reason).toBeNull();
        expect(disk.failureGroupState!.models[0].status).toBe(true);
        expect(disk.failureGroupState!.models[0]).not.toHaveProperty('testsChangedAt');
    });

    it('an old workspace: a Complete model stays Complete through an unrelated write and through its periods losing the legacy keys', async () => {
        setDisk([trained(ind())]);
        disk = { ...disk, failureGroupState: { ...disk.failureGroupState!, runningConditionTestPeriods: LEGACY_TESTS } };
        expect((await persistModelComplete('ws1', 'i1', sp, null)).reason).toBeNull();
        expect(disk.failureGroupState!.models[0].status).toBe(true);
        const { updateWorkspaceData } = await import('../workspaceManager');
        // an unrelated write (e.g. the Dashboard autosave)
        await updateWorkspaceData('ws1', prev => ({ ...prev, name: 'Renamed' }));
        expect(disk.failureGroupState!.models[0].status).toBe(true);
        // the periods pass through an edit that changes no date (the legacy keys go)
        await updateWorkspaceData('ws1', prev => ({
            ...prev,
            failureGroupState: { ...prev.failureGroupState!, runningConditionTestPeriods: toScoringPeriods(prev.failureGroupState!.runningConditionTestPeriods) },
        }));
        const after = disk.failureGroupState!.models[0];
        expect(after.status).toBe(true);
        expect(after).not.toHaveProperty('testsChangedAt');
        expect(JSON.stringify(disk.failureGroupState!.runningConditionTestPeriods)).not.toMatch(/label|eventTime|fromHighlight/);
    });

    it('after completing, a scoring-periods-only change sets it Incomplete + testsChangedAt but keeps it trained', async () => {
        setDisk([trained(ind())]);
        await persistModelComplete('ws1', 'i1', sp, null);
        expect(disk.failureGroupState!.models[0].status).toBe(true);
        const { updateWorkspaceData } = await import('../workspaceManager');
        await updateWorkspaceData('ws1', prev => ({
            ...prev,
            failureGroupState: { ...prev.failureGroupState!, runningConditionTestPeriods: [] },
        }));
        const after = disk.failureGroupState!.models[0];
        expect(after.status).toBe(false);
        expect(typeof after.testsChangedAt).toBe('string');
        expect(after.trainedFingerprint).toBe(computeTrainFingerprint(after, disk.failureGroupState!));
    });
});
