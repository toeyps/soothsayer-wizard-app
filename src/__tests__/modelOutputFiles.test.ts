import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args) }));
const mockReport = vi.fn();
vi.mock('../errorReporter', () => ({ reportError: (...a: unknown[]) => mockReport(...a) }));

import { modelsOnlyIn, removeModelOutputFiles } from '../utils/modelOutputFiles';

// User decision 2026-10-17: a deleted model's saved files leave the output folder with it.
const ind = (t: string) => ({ kind: 'individual' as const, targetSensor: t, xSensor: '' });
const rel = (t: string) => ({ kind: 'relationship' as const, targetSensor: t, xSensor: '' });
const clu = (x: string) => ({ kind: 'clustering' as const, targetSensor: '', xSensor: x });

beforeEach(() => { mockInvoke.mockReset().mockResolvedValue(3); mockReport.mockReset(); });

describe('removeModelOutputFiles', () => {
    it('asks Rust to remove the model\'s files: target sensor for Individual / Relation model, X sensor for Clustering', async () => {
        expect(await removeModelOutputFiles('ws1', rel('T1'), [])).toBe(3);
        expect(mockInvoke).toHaveBeenLastCalledWith('remove_model_files', { workspace_id: 'ws1', kind: 'relationship', sensor: 'T1' });
        await removeModelOutputFiles('ws1', clu('X1'), []);
        expect(mockInvoke).toHaveBeenLastCalledWith('remove_model_files', { workspace_id: 'ws1', kind: 'clustering', sensor: 'X1' });
    });

    it('leaves the files alone when a model of the same kind for the same sensor still exists (Undo, re-created)', async () => {
        expect(await removeModelOutputFiles('ws1', ind('T1'), [ind('t1 '), rel('T1')])).toBe(0);
        expect(mockInvoke).not.toHaveBeenCalled();
        // another kind of the same sensor does not count
        await removeModelOutputFiles('ws1', ind('T1'), [rel('T1')]);
        expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('nothing to do without a workspace or a sensor; a failure is reported, never thrown', async () => {
        expect(await removeModelOutputFiles(undefined, ind('T1'), [])).toBe(0);
        expect(await removeModelOutputFiles('ws1', ind(''), [])).toBe(0);
        expect(mockInvoke).not.toHaveBeenCalled();
        mockInvoke.mockRejectedValueOnce('BAD_REQUEST: nope');
        expect(await removeModelOutputFiles('ws1', ind('T1'), [])).toBe(0);
        expect(mockReport).toHaveBeenCalledWith('remove_model_files', 'BAD_REQUEST: nope', 'individual T1');
    });
});

describe('modelsOnlyIn', () => {
    it('the models whose every group is that one', () => {
        const ms = [{ id: 'a', groupNos: [1] }, { id: 'b', groupNos: [1, 2] }, { id: 'c', groupNos: [2] }, { id: 'd', groupNos: [] as number[] }];
        expect(modelsOnlyIn(ms, 1).map(m => m.id)).toEqual(['a']);
    });
});

// QA 2026-10-19: the confirm sentence both delete buttons show, and the edge cases of the counts.
describe('groupDeleteCounts / groupDeleteSentence — edges', () => {
    it('a model listed twice in the same group is still only in it; a model in no group is never counted', async () => {
        const { groupDeleteCounts } = await import('../utils/modelOutputFiles');
        expect(groupDeleteCounts([{ groupNos: [1, 1] }, { groupNos: [] }, { groupNos: [0] }], 1)).toEqual({ deleted: 1, kept: 0 });
        expect(groupDeleteCounts([], 1)).toEqual({ deleted: 0, kept: 0 });
    });

    it('singular and plural wording', async () => {
        const { groupDeleteSentence } = await import('../utils/modelOutputFiles');
        expect(groupDeleteSentence('G', 1, 0)).toBe('Delete G? 1 model used only by this group is deleted with its saved files.');
        expect(groupDeleteSentence('G', 0, 1)).toBe('Delete G? 1 model stays in its other groups.');
        expect(groupDeleteSentence('G', 0, 0)).toBe('Delete G? It has no models.');
    });

    it('a Clustering model without an X sensor has no files to remove', async () => {
        expect(await removeModelOutputFiles('ws1', { kind: 'clustering', targetSensor: 'T1', xSensor: '' }, [])).toBe(0);
        expect(mockInvoke).not.toHaveBeenCalled();
    });
});
