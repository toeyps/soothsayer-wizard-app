import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockStoreGet = vi.fn();
const mockStoreSet = vi.fn().mockResolvedValue(undefined);
const mockStoreSave = vi.fn().mockResolvedValue(undefined);
const mockLoad = vi.fn(async (_file?: unknown) => ({ get: mockStoreGet, set: mockStoreSet, save: mockStoreSave }));
vi.mock('@tauri-apps/plugin-store', () => ({
    load: (file: unknown) => mockLoad(file),
}));

const mockReadTextFile = vi.fn();
const mockWriteTextFile = vi.fn().mockResolvedValue(undefined);
const mockExists = vi.fn();
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/plugin-fs', () => ({
    readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
    writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
    exists: (...args: unknown[]) => mockExists(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    remove: (...args: unknown[]) => mockRemove(...args),
    BaseDirectory: { AppData: 'AppData' },
}));

const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Module-scope caches (store singleton, save mutex) mean every test needs a
// clean module instance.
async function freshModule() {
    vi.resetModules();
    return await import('../workspaceManager');
}

function deferred<T = void>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

beforeEach(() => {
    mockStoreGet.mockReset();
    mockStoreSet.mockReset().mockResolvedValue(undefined);
    mockStoreSave.mockReset().mockResolvedValue(undefined);
    mockLoad.mockClear();
    mockReadTextFile.mockReset();
    mockWriteTextFile.mockReset().mockResolvedValue(undefined);
    mockExists.mockReset().mockResolvedValue(true);
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockRemove.mockReset().mockResolvedValue(undefined);
    mockInvoke.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('writeUserTextFile / writeUserBinaryFile', () => {
    it('encodes a UTF-8 string and bridges through write_user_file', async () => {
        const { writeUserTextFile } = await freshModule();
        await writeUserTextFile('C:/out.txt', 'hi');
        expect(mockInvoke).toHaveBeenCalledWith('write_user_file', {
            path: 'C:/out.txt',
            contents: Array.from(new TextEncoder().encode('hi')),
        });
    });

    it('passes raw bytes through as an array', async () => {
        const { writeUserBinaryFile } = await freshModule();
        await writeUserBinaryFile('C:/out.bin', new Uint8Array([1, 2, 3]));
        expect(mockInvoke).toHaveBeenCalledWith('write_user_file', {
            path: 'C:/out.bin',
            contents: [1, 2, 3],
        });
    });
});

describe('getRecentWorkspaces / saveRecentWorkspaces', () => {
    it('returns [] when nothing is stored', async () => {
        mockStoreGet.mockResolvedValue(undefined);
        const { getRecentWorkspaces } = await freshModule();
        expect(await getRecentWorkspaces()).toEqual([]);
    });

    it('returns [] (not throw) when the stored value is not an array', async () => {
        mockStoreGet.mockResolvedValue({ not: 'an array' });
        const { getRecentWorkspaces } = await freshModule();
        expect(await getRecentWorkspaces()).toEqual([]);
    });

    it('returns the stored list when valid', async () => {
        const list = [{ id: 'a', name: 'A', description: '', lastModified: 1, filePath: 'x' }];
        mockStoreGet.mockResolvedValue(list);
        const { getRecentWorkspaces } = await freshModule();
        expect(await getRecentWorkspaces()).toEqual(list);
    });

    it('returns [] when the store throws', async () => {
        mockLoad.mockRejectedValueOnce(new Error('store boom'));
        const { getRecentWorkspaces } = await freshModule();
        expect(await getRecentWorkspaces()).toEqual([]);
    });

    it('saveRecentWorkspaces writes then persists the store', async () => {
        const { saveRecentWorkspaces } = await freshModule();
        const list = [{ id: 'a', name: 'A', description: '', lastModified: 1, filePath: 'x' }] as any;
        await saveRecentWorkspaces(list);
        expect(mockStoreSet).toHaveBeenCalledWith('recent_workspaces', list);
        expect(mockStoreSave).toHaveBeenCalledTimes(1);
    });

    it('saveRecentWorkspaces swallows store errors', async () => {
        mockStoreSet.mockRejectedValueOnce(new Error('disk full'));
        const { saveRecentWorkspaces } = await freshModule();
        await expect(saveRecentWorkspaces([])).resolves.toBeUndefined();
    });
});

describe('saveWorkspaceData', () => {
    const state = { id: 'ws1', name: 'My Workspace', description: 'desc' } as any;

    it('creates the workspaces directory when it does not exist', async () => {
        mockExists.mockResolvedValueOnce(false); // workspaces dir check
        mockStoreGet.mockResolvedValue([]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData(state);
        expect(mockMkdir).toHaveBeenCalledWith('workspaces', { recursive: true, baseDir: 'AppData' });
    });

    it('skips mkdir when the directory already exists', async () => {
        mockExists.mockResolvedValue(true);
        mockStoreGet.mockResolvedValue([]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData(state);
        expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('writes the serialized state to workspaces/<id>.json', async () => {
        mockStoreGet.mockResolvedValue([]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData(state);
        expect(mockWriteTextFile).toHaveBeenCalledWith(
            'workspaces/ws1.json',
            JSON.stringify(state),
            { baseDir: 'AppData' },
        );
    });

    it('prepends a new entry to the recent-workspaces list', async () => {
        mockStoreGet.mockResolvedValue([]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData(state);
        const saved = mockStoreSet.mock.calls[0][1];
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ id: 'ws1', name: 'My Workspace', filePath: 'workspaces/ws1.json' });
    });

    it('updates the existing entry in place rather than duplicating it', async () => {
        mockStoreGet.mockResolvedValue([
            { id: 'ws1', name: 'Old Name', description: '', lastModified: 1, filePath: 'workspaces/ws1.json' },
            { id: 'ws2', name: 'Other', description: '', lastModified: 2, filePath: 'workspaces/ws2.json' },
        ]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData(state);
        const saved = mockStoreSet.mock.calls[0][1];
        expect(saved).toHaveLength(2);
        expect(saved.find((w: any) => w.id === 'ws1').name).toBe('My Workspace');
    });

    it('keeps only the 10 most recently modified workspaces', async () => {
        const existing = Array.from({ length: 12 }, (_, i) => ({
            id: `old-${i}`, name: `Old ${i}`, description: '', lastModified: i, filePath: `workspaces/old-${i}.json`,
        }));
        mockStoreGet.mockResolvedValue(existing);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData(state);
        const saved = mockStoreSet.mock.calls[0][1];
        expect(saved).toHaveLength(10);
        // Newest entry (just-saved ws1) must survive the trim.
        expect(saved.some((w: any) => w.id === 'ws1')).toBe(true);
    });

    it('does not throw when the write fails', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockWriteTextFile.mockRejectedValueOnce(new Error('disk full'));
        const { saveWorkspaceData } = await freshModule();
        await expect(saveWorkspaceData(state)).resolves.toBeUndefined();
    });

    it('serializes concurrent saves: a save requested mid-flight is queued and run after, using only the latest state', async () => {
        mockStoreGet.mockResolvedValue([]);
        const write = deferred();
        mockWriteTextFile.mockReturnValueOnce(write.promise);
        mockWriteTextFile.mockResolvedValue(undefined); // subsequent calls resolve immediately

        const { saveWorkspaceData } = await freshModule();
        const first = saveWorkspaceData({ ...state, id: 'ws1' });
        // Two more saves arrive while the first write is still pending.
        // Give the first call's own awaits (exists/getRecentWorkspaces) a
        // chance to reach the pending writeTextFile call before the next
        // two saves are issued "while it's in flight".
        await vi.waitFor(() => expect(mockWriteTextFile).toHaveBeenCalledTimes(1));

        const secondCall = saveWorkspaceData({ ...state, id: 'ws2' });
        const thirdCall = saveWorkspaceData({ ...state, id: 'ws3' });

        expect(mockWriteTextFile).toHaveBeenCalledTimes(1); // still just ws1, in flight

        write.resolve();
        await first;
        await secondCall;
        await thirdCall;
        // ws2 was overwritten in the queue by ws3 before the mutex freed up.
        await vi.waitFor(() => expect(mockWriteTextFile).toHaveBeenCalledTimes(2));
        expect(mockWriteTextFile).toHaveBeenLastCalledWith(
            'workspaces/ws3.json',
            JSON.stringify({ ...state, id: 'ws3' }),
            { baseDir: 'AppData' },
        );
    });
});

describe('loadWorkspaceData', () => {
    it('returns null when the id is unknown and no default-path file exists', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(false);
        const { loadWorkspaceData } = await freshModule();
        expect(await loadWorkspaceData('missing')).toBeNull();
    });

    it('uses the recent-list filePath when the id is known', async () => {
        mockStoreGet.mockResolvedValue([
            { id: 'ws1', name: 'A', description: '', lastModified: 1, filePath: 'custom/path.json' },
        ]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue(JSON.stringify({ id: 'ws1', name: 'A' }));
        const { loadWorkspaceData } = await freshModule();
        const result = await loadWorkspaceData('ws1');
        expect(mockReadTextFile).toHaveBeenCalledWith('custom/path.json', { baseDir: 'AppData' });
        expect(result).toEqual({ id: 'ws1', name: 'A' });
    });

    it('falls back to workspaces/<id>.json when the id is not in the recent list', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue(JSON.stringify({ id: 'ws9', name: 'B' }));
        const { loadWorkspaceData } = await freshModule();
        await loadWorkspaceData('ws9');
        expect(mockReadTextFile).toHaveBeenCalledWith('workspaces/ws9.json', { baseDir: 'AppData' });
    });

    it('returns null when reading or parsing throws', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue('{not valid json');
        const { loadWorkspaceData } = await freshModule();
        expect(await loadWorkspaceData('ws1')).toBeNull();
    });

    describe('legacy failure-group migration', () => {
        beforeEach(() => {
            mockStoreGet.mockResolvedValue([]);
            mockExists.mockResolvedValue(true);
        });

        it('is a no-op when there is no failureGroupState at all', async () => {
            mockReadTextFile.mockResolvedValue(JSON.stringify({ id: 'ws1', name: 'A' }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            expect(result?.failureGroupState).toBeUndefined();
        });

        it('is a no-op when failureGroupState.models already exists (already migrated)', async () => {
            const models = [{ id: 'm1', groupNo: 1, kind: 'individual' }];
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: { groups: [], models },
            }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            expect(result?.failureGroupState?.models).toEqual(models);
        });

        it('converts legacy rows into individual-kind models by default', async () => {
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: {
                    groups: [{ no: 1, name: 'Group A', isCollapsed: false }],
                    rows: [{
                        id: 'row-1', groupNo: 1, conceptSensor: 'Vibration', mappedSensorTag: 'TAG1',
                        mappedSensorName: 'Tag One', modelType: '', modelNotes: 'note', additionalNotes: '', status: true,
                    }],
                },
            }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            const models = result?.failureGroupState?.models;
            expect(models).toHaveLength(1);
            expect(models![0]).toMatchObject({
                id: 'row-1', groupNo: 1, name: 'Vibration', kind: 'individual', category: null,
                notes: 'note', status: true, targetSensor: 'TAG1',
            });
        });

        it('infers relationship/clustering kind from the legacy free-text modelType field', async () => {
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: {
                    groups: [{ no: 1, name: 'Group A', isCollapsed: false }],
                    rows: [
                        { id: 'r1', groupNo: 1, conceptSensor: '', mappedSensorTag: 'TAG1', mappedSensorName: '', modelType: 'Relationship model', modelNotes: '', additionalNotes: '', status: false },
                        { id: 'r2', groupNo: 1, conceptSensor: '', mappedSensorTag: 'TAG2', mappedSensorName: '', modelType: 'Clustering', modelNotes: '', additionalNotes: '', status: false },
                        { id: 'r3', groupNo: 1, conceptSensor: '', mappedSensorTag: 'TAG3', mappedSensorName: '', modelType: 'something else', modelNotes: '', additionalNotes: '', status: false },
                    ],
                },
            }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            const models = result?.failureGroupState?.models ?? [];
            expect(models.find(m => m.id === 'r1')?.kind).toBe('relationship');
            expect(models.find(m => m.id === 'r2')?.kind).toBe('clustering');
            expect(models.find(m => m.id === 'r2')?.xSensor).toBe('TAG2');
            expect(models.find(m => m.id === 'r3')?.kind).toBe('individual');
        });

        it('drops rows with no sensor tag assigned yet', async () => {
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: {
                    groups: [{ no: 1, name: 'Group A', isCollapsed: false }],
                    rows: [{ id: 'blank', groupNo: 1, conceptSensor: '', mappedSensorTag: '', mappedSensorName: '', modelType: '', modelNotes: '', additionalNotes: '', status: false }],
                },
            }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            expect(result?.failureGroupState?.models).toEqual([]);
        });

        it('only carries the old global predictiveModelState onto the ONE model it belonged to, defaulting every other model', async () => {
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                predictiveModelState: {
                    targetSensor: 'TAG1', predictorSensors: ['TAG9'], individualChecked: false,
                    rcMode: 'relationship', scatterXSensor: 'TAG9', relModelName: 'My Model',
                    relStiffness: 500, clusterModelName: '', numClusters: 5, criteriaSensor: '',
                    clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
                },
                failureGroupState: {
                    groups: [{ no: 1, name: 'Group A', isCollapsed: false }],
                    rows: [
                        { id: 'r1', groupNo: 1, conceptSensor: '', mappedSensorTag: 'TAG1', mappedSensorName: '', modelType: '', modelNotes: '', additionalNotes: '', status: false },
                        { id: 'r2', groupNo: 1, conceptSensor: '', mappedSensorTag: 'TAG2', mappedSensorName: '', modelType: '', modelNotes: '', additionalNotes: '', status: false },
                    ],
                },
            }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            const models = result?.failureGroupState?.models ?? [];
            const matched = models.find(m => m.id === 'r1')!;
            const unmatched = models.find(m => m.id === 'r2')!;
            expect(matched.relModelName).toBe('My Model');
            expect(matched.predictorSensors).toEqual(['TAG9']);
            expect(matched.numClusters).toBe(5);
            expect(unmatched.relModelName).toBe('');
            expect(unmatched.numClusters).toBe(3);
            expect(unmatched.predictorSensors).toEqual([]);
        });
    });
});

describe('updateWorkspaceData', () => {
    it('returns null without saving when the workspace does not exist', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(false);
        const { updateWorkspaceData } = await freshModule();
        const patch = vi.fn();
        const result = await updateWorkspaceData('missing', patch);
        expect(result).toBeNull();
        expect(patch).not.toHaveBeenCalled();
        expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it('loads, patches, saves, and returns the patched state', async () => {
        mockStoreGet.mockResolvedValue([
            { id: 'ws1', name: 'A', description: '', lastModified: 1, filePath: 'workspaces/ws1.json' },
        ]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue(JSON.stringify({ id: 'ws1', name: 'A' }));
        const { updateWorkspaceData } = await freshModule();

        const result = await updateWorkspaceData('ws1', (s) => ({ ...s, name: 'Patched' }));
        expect(result).toEqual({ id: 'ws1', name: 'Patched' });
        expect(mockWriteTextFile).toHaveBeenCalledWith(
            'workspaces/ws1.json',
            JSON.stringify({ id: 'ws1', name: 'Patched' }),
            { baseDir: 'AppData' },
        );
    });
});

describe('deleteWorkspace', () => {
    it('does nothing when the id is not in the recent list', async () => {
        mockStoreGet.mockResolvedValue([]);
        const { deleteWorkspace } = await freshModule();
        await deleteWorkspace('missing');
        expect(mockRemove).not.toHaveBeenCalled();
        expect(mockStoreSet).not.toHaveBeenCalled();
    });

    it('removes the file and drops the entry from the recent list when found', async () => {
        mockStoreGet.mockResolvedValue([
            { id: 'ws1', name: 'A', description: '', lastModified: 1, filePath: 'workspaces/ws1.json' },
            { id: 'ws2', name: 'B', description: '', lastModified: 2, filePath: 'workspaces/ws2.json' },
        ]);
        mockExists.mockResolvedValue(true);
        const { deleteWorkspace } = await freshModule();
        await deleteWorkspace('ws1');

        expect(mockRemove).toHaveBeenCalledWith('workspaces/ws1.json', { baseDir: 'AppData' });
        const saved = mockStoreSet.mock.calls[0][1];
        expect(saved.map((w: any) => w.id)).toEqual(['ws2']);
    });

    it('still updates the recent list even if the file is already gone', async () => {
        mockStoreGet.mockResolvedValue([
            { id: 'ws1', name: 'A', description: '', lastModified: 1, filePath: 'workspaces/ws1.json' },
        ]);
        mockExists.mockResolvedValue(false);
        const { deleteWorkspace } = await freshModule();
        await deleteWorkspace('ws1');

        expect(mockRemove).not.toHaveBeenCalled();
        expect(mockStoreSet).toHaveBeenCalledWith('recent_workspaces', []);
    });
});

describe('duplicateWorkspace', () => {
    it('returns null when the source workspace does not exist', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(false);
        const { duplicateWorkspace } = await freshModule();
        expect(await duplicateWorkspace('missing')).toBeNull();
    });

    it('clones with a new id and a "(Copy)" suffixed name, then saves it', async () => {
        mockStoreGet.mockResolvedValue([
            { id: 'ws1', name: 'A', description: '', lastModified: 1, filePath: 'workspaces/ws1.json' },
        ]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue(JSON.stringify({ id: 'ws1', name: 'A' }));
        const { duplicateWorkspace } = await freshModule();

        const result = await duplicateWorkspace('ws1');
        expect(result?.name).toBe('A (Copy)');
        expect(result?.id).toMatch(/^ws_\d+$/);
        expect(result?.id).not.toBe('ws1');
        expect(mockWriteTextFile).toHaveBeenCalled();
    });
});

describe('renameWorkspaceFile', () => {
    it('returns false when the workspace does not exist', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(false);
        const { renameWorkspaceFile } = await freshModule();
        expect(await renameWorkspaceFile('missing', 'New Name')).toBe(false);
    });

    it('saves the state with the new name and returns true', async () => {
        mockStoreGet.mockResolvedValue([
            { id: 'ws1', name: 'Old', description: '', lastModified: 1, filePath: 'workspaces/ws1.json' },
        ]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue(JSON.stringify({ id: 'ws1', name: 'Old' }));
        const { renameWorkspaceFile } = await freshModule();

        expect(await renameWorkspaceFile('ws1', 'New Name')).toBe(true);
        expect(mockWriteTextFile).toHaveBeenCalledWith(
            'workspaces/ws1.json',
            JSON.stringify({ id: 'ws1', name: 'New Name' }),
            { baseDir: 'AppData' },
        );
    });
});
