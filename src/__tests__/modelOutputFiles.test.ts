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
