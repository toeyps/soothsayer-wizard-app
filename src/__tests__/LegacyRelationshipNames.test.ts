/**
 * A workspace saved BEFORE the wording change ("Relationship" ->
 * "Relation model" in every label) must open exactly as it was saved
 *.
 *
 * The old "Use '<name> (Relationship)'" suggestion wrote names such as
 * "TAG1 (Relationship)" into saved models. A model's name is the user's data:
 * it is shown in the Dashboard and the Workbench and sent to Rust as the export
 * `model_name`. The wording change is DISPLAY ONLY, so for such a workspace:
 *   - opening it rewrites nothing, and every name comes back byte for byte;
 *   - `kind` stays the value `'relationship'`;
 *   - the train fingerprint (the model name is not part of it) still equals the
 *     saved `trainedFingerprint`, so nothing turns stale and a Complete model
 *     stays Complete;
 *   - a later, unrelated write keeps the name and the status;
 *   - Mark complete still exports under the saved name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FailureGroupStateSlice, FailureModel, WorkspaceState } from '../types';
import { computeTrainFingerprint, isModelTrainedFresh } from '../utils/trainFingerprint';
import { isModelComplete, isModelStale } from '../utils/modelStatus';
import { buildModelFilesRequest } from '../utils/healthRequest';
import { withFailureGroupState } from '../utils/failureGroupState';
import { findSameSensorNameConflict, suggestDistinctModelName } from '../utils/modelNames';
import { mk } from './helpers/failureModelFixture';

const mockStoreGet = vi.fn();
vi.mock('@tauri-apps/plugin-store', () => ({
    load: async () => ({ get: mockStoreGet, set: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined) }),
}));

const mockReadTextFile = vi.fn();
const mockWriteTextFile = vi.fn().mockResolvedValue(undefined);
const mockRename = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/plugin-fs', () => ({
    readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
    writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
    exists: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    rename: (...args: unknown[]) => mockRename(...args),
    BaseDirectory: { AppData: 'AppData' },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

async function freshModule() {
    vi.resetModules();
    return await import('../workspaceManager');
}

const LEGACY_NAME = 'TAG1 (Relationship)';
const TRAINED_AT = '2026-10-01T08:00:00.000Z';

/** The slice as an older build saved it: the Relation model of TAG1 carries the legacy suggested name. */
function savedSlice(): FailureGroupStateSlice {
    const fg: FailureGroupStateSlice = {
        groups: [{ no: 1, name: 'Group A' }],
        models: [],
        runningConditionFilters: [{ id: 'c1', sensor: 'TAG9', operation: 'greater_than', value1: '10', value2: '' }],
        runningConditionCombine: 'and',
        runningConditionTimePeriods: [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }],
    } as FailureGroupStateSlice;
    const individual = mk({ id: 'i1', kind: 'individual', targetSensor: 'TAG1', name: 'TAG1', category: 'condition' });
    const relation = mk({
        id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2', 'TAG3'], relStiffness: 100_000,
        name: LEGACY_NAME, category: 'condition',
    });
    const clustering = mk({
        id: 'c1', kind: 'clustering', xSensor: 'TAG4', ySensor: 'TAG5', name: 'TAG4 (Clustering)', category: 'condition',
    });
    fg.models = [individual, relation, clustering];
    // Trained and marked complete by the older build: its fingerprint is on disk.
    relation.lastTrainedAt = TRAINED_AT;
    relation.trainedFingerprint = computeTrainFingerprint(relation, fg);
    relation.status = true;
    relation.healthSetPoints = { kind: 'relationship', residualAt80Lower: -1, residualAt80Upper: 1, residualAt0Lower: -2, residualAt0Upper: 2 } as FailureModel['healthSetPoints'];
    clustering.lastTrainedAt = TRAINED_AT;
    clustering.trainedFingerprint = computeTrainFingerprint(clustering, fg);
    return fg;
}

function savedWorkspace(): WorkspaceState {
    return { id: 'ws1', name: 'Saved before the wording change', failureGroupState: savedSlice() } as unknown as WorkspaceState;
}

beforeEach(() => {
    mockStoreGet.mockReset();
    mockReadTextFile.mockReset();
    mockWriteTextFile.mockReset().mockResolvedValue(undefined);
    mockRename.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a workspace saved before "Relationship" became "Relation model"', () => {
    it('opens with identical names, kinds, statuses and fingerprints — and opening writes nothing', async () => {
        const saved = savedWorkspace();
        mockReadTextFile.mockResolvedValue(JSON.stringify(saved));
        const { loadWorkspaceData } = await freshModule();
        const loaded = await loadWorkspaceData('ws1');
        const fg = loaded!.failureGroupState!;
        const before = saved.failureGroupState!.models;

        expect(fg.models.map(m => m.name)).toEqual(['TAG1', LEGACY_NAME, 'TAG4 (Clustering)']);
        expect(fg.models.map(m => m.kind)).toEqual(['individual', 'relationship', 'clustering']);
        expect(fg.models.map(m => m.status)).toEqual(before.map(m => m.status));
        expect(fg.models.map(m => m.trainedFingerprint)).toEqual(before.map(m => m.trainedFingerprint));
        expect(fg.models.map(m => m.lastTrainedAt)).toEqual(before.map(m => m.lastTrainedAt));
        // every model comes back whole (nothing dropped, nothing renamed)
        for (const [i, m] of fg.models.entries()) expect(m).toMatchObject(before[i] as unknown as Record<string, unknown>);

        // the fingerprints computed NOW still equal what the older build saved…
        const rel = fg.models[1];
        expect(computeTrainFingerprint(rel, fg)).toBe(rel.trainedFingerprint);
        expect(computeTrainFingerprint(fg.models[2], fg)).toBe(fg.models[2].trainedFingerprint);
        // …so nothing reads as out of date and the Complete model stays Complete
        expect(isModelStale(rel, fg)).toBe(false);
        expect(isModelTrainedFresh(rel, fg)).toBe(true);
        expect(isModelComplete(rel, fg)).toBe(true);
        expect(isModelTrainedFresh(fg.models[2], fg)).toBe(true);

        expect(mockWriteTextFile).not.toHaveBeenCalled();
        expect(mockRename).not.toHaveBeenCalled();
    });

    it('the model name is not part of the train fingerprint: old and new spelling fingerprint the same', () => {
        const fg = savedSlice();
        const rel = fg.models[1];
        const renamed: FailureModel = { ...rel, name: 'TAG1 (Relation model)' };
        expect(computeTrainFingerprint(renamed, fg)).toBe(computeTrainFingerprint(rel, fg));
        expect(isModelComplete(renamed, { ...fg, models: [fg.models[0], renamed, fg.models[2]] })).toBe(true);
    });

    it('a later unrelated write keeps the legacy name and the Complete status (the incomplete rule ignores names)', async () => {
        mockReadTextFile.mockResolvedValue(JSON.stringify(savedWorkspace()));
        const { updateWorkspaceData } = await freshModule();
        const next = await updateWorkspaceData('ws1', s => withFailureGroupState(s, {
            models: s.failureGroupState!.models.map(m => (m.id === 'i1' ? { ...m, notes: 'checked on site' } : m)),
        }));
        const rel = next!.failureGroupState!.models[1];
        expect(rel.name).toBe(LEGACY_NAME);
        expect(rel.kind).toBe('relationship');
        expect(rel.status).toBe(true);
        expect(isModelComplete(rel, next!.failureGroupState!)).toBe(true);
        // what landed on disk says the same
        const written = (mockWriteTextFile.mock.calls as Array<[string, string]>).map(c => c[1]).filter(c => c.includes('"failureGroupState"'));
        expect(written.length).toBeGreaterThan(0);
        const onDisk = JSON.parse(written[written.length - 1]) as WorkspaceState;
        expect(onDisk.failureGroupState!.models.map(m => m.name)).toEqual(['TAG1', LEGACY_NAME, 'TAG4 (Clustering)']);
    });

    it('Mark complete still exports under the saved name', () => {
        const fg = savedSlice();
        const rel = fg.models[1];
        const req = buildModelFilesRequest({
            model: rel, fg, headers: ['TAG1', 'TAG2', 'TAG3', 'TAG9'], setPoints: rel.healthSetPoints!, workspaceId: 'ws1',
        });
        expect(req).not.toBeNull();
        expect(req!.model_name).toBe(LEGACY_NAME);
        expect(req!.kind).toBe('relationship');
    });

    it('name logic reads both spellings: the saved name is no conflict for its own model, and a new suggestion never lands on its twin', () => {
        const fg = savedSlice();
        const [ind, rel] = fg.models;
        // the saved legacy name of the model itself is never "a duplicate"
        expect(findSameSensorNameConflict(fg.models, rel, LEGACY_NAME)).toBeNull();
        // new suggestions use the new word…
        expect(suggestDistinctModelName(fg.models, rel, 'TAG1')).toBe('TAG1 (Relation model)');
        // …and step past a legacy name held by ANOTHER model of the same sensor
        expect(suggestDistinctModelName(fg.models, ind, 'TAG1')).toBe('TAG1 (Individual)');
        const secondRel: FailureModel = { ...rel, id: 'r2', name: 'TAG1' };
        expect(suggestDistinctModelName([...fg.models, secondRel], secondRel, 'TAG1')).toBe('TAG1 (Relation model) 2');
    });
});
