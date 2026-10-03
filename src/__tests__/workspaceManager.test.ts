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

describe('writeUserTextFile', () => {
    it('encodes a UTF-8 string and bridges through write_user_file', async () => {
        const { writeUserTextFile } = await freshModule();
        await writeUserTextFile('C:/out.txt', 'hi');
        expect(mockInvoke).toHaveBeenCalledWith('write_user_file', {
            path: 'C:/out.txt',
            contents: Array.from(new TextEncoder().encode('hi')),
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

    it('serializes concurrent saves in strict FIFO order -- none dropped (regression: an earlier "single-slot queue" design coalesced concurrent saves down to just the last one, which was safe for saveWorkspaceData alone but caused real data loss once updateWorkspaceData started sharing the same queue for its read-modify-write -- see workspaceManager.ts\'s comment on `enqueue`)', async () => {
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
        // All three actually write now -- ws2 is NOT dropped in favour of
        // ws3, unlike the old single-slot queue.
        await vi.waitFor(() => expect(mockWriteTextFile).toHaveBeenCalledTimes(3));
        expect(mockWriteTextFile).toHaveBeenNthCalledWith(1,
            'workspaces/ws1.json', JSON.stringify({ ...state, id: 'ws1' }), { baseDir: 'AppData' },
        );
        expect(mockWriteTextFile).toHaveBeenNthCalledWith(2,
            'workspaces/ws2.json', JSON.stringify({ ...state, id: 'ws2' }), { baseDir: 'AppData' },
        );
        expect(mockWriteTextFile).toHaveBeenNthCalledWith(3,
            'workspaces/ws3.json', JSON.stringify({ ...state, id: 'ws3' }), { baseDir: 'AppData' },
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

        it('is a no-op when every model already has groupNos (fully migrated)', async () => {
            const models = [{ id: 'm1', groupNos: [1], kind: 'individual' }];
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: { groups: [], models },
            }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            // Only the (2026-10-03) empty set points are added; nothing else changes.
            expect(result?.failureGroupState?.models).toEqual([
                { ...models[0], healthSetPoints: { kind: 'individual', lower: null, upper: null } },
            ]);
        });

        it('normalizes a model that still has the old singular groupNo into groupNos[] (2026-08-25 redesign, model<->group is now many-to-many)', async () => {
            const models = [{ id: 'm1', groupNo: 1, kind: 'individual' }];
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: { groups: [], models },
            }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            const migrated = result?.failureGroupState?.models;
            expect(migrated).toEqual([{ id: 'm1', kind: 'individual', groupNos: [1], healthSetPoints: { kind: 'individual', lower: null, upper: null } }]);
        });

        it('normalizes a model with neither groupNo nor groupNos into groupNos: [0] ("Not in Group")', async () => {
            const models = [{ id: 'm1', kind: 'individual' }];
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: { groups: [], models },
            }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            const migrated = result?.failureGroupState?.models;
            expect(migrated).toEqual([{ id: 'm1', kind: 'individual', groupNos: [0], healthSetPoints: { kind: 'individual', lower: null, upper: null } }]);
        });

        describe('health set points (2026-10-03, phase 1)', () => {
            // A hand-written OLD workspace file: no `healthSetPoints` anywhere.
            const oldWorkspace = () => ({
                id: 'ws1', name: 'Old',
                failureGroupState: {
                    groups: [{ no: 1, name: 'G' }],
                    models: [
                        { id: 'i1', groupNos: [1], kind: 'individual', targetSensor: 'T1', notes: 'keep-i', status: true, lastTrainedAt: '2026-09-30T00:00:00Z', trainedFingerprint: 'fp-i' },
                        { id: 'r1', groupNos: [1], kind: 'relationship', targetSensor: 'T2', predictorSensors: ['T3'], relStiffness: 7 },
                        { id: 'c1', groupNos: [1], kind: 'clustering', xSensor: 'X', ySensor: 'Y', numClusters: 4 },
                    ],
                    runningConditionCombine: 'or',
                    runningConditionTimePeriods: [{ id: 'p1', start: '2026-01-01T00:00', end: '' }],
                },
            });

            it('an old workspace loads with every model intact and gets the EMPTY shape for its kind (no master snapshot yet)', async () => {
                mockReadTextFile.mockResolvedValue(JSON.stringify(oldWorkspace()));
                const { loadWorkspaceData } = await freshModule();
                const fg = (await loadWorkspaceData('ws1'))!.failureGroupState!;
                const [i, r, c] = fg.models;
                expect(i.healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: null });
                expect('masterLower' in i.healthSetPoints!).toBe(false);
                expect('masterUpper' in i.healthSetPoints!).toBe(false);
                expect(r.healthSetPoints).toEqual({
                    kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null,
                });
                expect(c.healthSetPoints).toEqual({ kind: 'clustering', outerSd: null });
                // everything else survives
                expect(i).toMatchObject({ id: 'i1', notes: 'keep-i', status: true, lastTrainedAt: '2026-09-30T00:00:00Z', trainedFingerprint: 'fp-i' });
                expect(r).toMatchObject({ predictorSensors: ['T3'], relStiffness: 7 });
                expect(c).toMatchObject({ xSensor: 'X', ySensor: 'Y', numClusters: 4 });
                expect(fg.runningConditionCombine).toBe('or');
                expect(fg.runningConditionTimePeriods).toEqual([{ id: 'p1', start: '2026-01-01T00:00', end: '' }]);
            });

            it('keeps set points a model already has, byte-identical (never overwritten, snapshot untouched)', async () => {
                const ws = oldWorkspace();
                const sp = { kind: 'individual', lower: 1.5, upper: null, masterLower: 2, masterUpper: null };
                (ws.failureGroupState.models[0] as Record<string, unknown>).healthSetPoints = sp;
                const rel = { kind: 'relationship', residualAt80Lower: -1, residualAt80Upper: 1, residualAt0Lower: -2, residualAt0Upper: 2 };
                (ws.failureGroupState.models[1] as Record<string, unknown>).healthSetPoints = rel;
                mockReadTextFile.mockResolvedValue(JSON.stringify(ws));
                const { loadWorkspaceData } = await freshModule();
                const models = (await loadWorkspaceData('ws1'))!.failureGroupState!.models;
                expect(JSON.stringify(models[0].healthSetPoints)).toBe(JSON.stringify(sp));
                expect(JSON.stringify(models[1].healthSetPoints)).toBe(JSON.stringify(rel));
                expect(models[2].healthSetPoints).toEqual({ kind: 'clustering', outerSd: null });
            });

            it('round trip: load -> updateWorkspaceData (writes) -> load again gives the same models, and a null master snapshot survives JSON', async () => {
                const ws = oldWorkspace();
                (ws.failureGroupState.models[0] as Record<string, unknown>).healthSetPoints =
                    { kind: 'individual', lower: null, upper: 9, masterLower: null, masterUpper: 9 };
                let disk = JSON.stringify(ws);
                mockStoreGet.mockResolvedValue([]);
                mockReadTextFile.mockImplementation(async () => disk);
                mockWriteTextFile.mockImplementation(async (_p: string, content: string) => { disk = content; });
                const { loadWorkspaceData, updateWorkspaceData } = await freshModule();
                const first = await loadWorkspaceData('ws1');
                await updateWorkspaceData('ws1', prev => ({ ...prev, name: 'Renamed' }));
                const second = await loadWorkspaceData('ws1');
                expect(second!.failureGroupState!.models).toEqual(first!.failureGroupState!.models);
                const i = second!.failureGroupState!.models[0].healthSetPoints as { masterLower: number | null; masterUpper: number | null };
                expect(i.masterLower).toBeNull();
                expect(i.masterUpper).toBe(9);
                // idempotent: a second pass over what was written changes nothing
                expect(JSON.parse(disk).failureGroupState.models[0].healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: 9, masterLower: null, masterUpper: 9 });
            });

            it('legacy `rows` models also get set points', async () => {
                mockReadTextFile.mockResolvedValue(JSON.stringify({
                    id: 'ws1', name: 'A',
                    failureGroupState: {
                        groups: [{ no: 1, name: 'G' }],
                        rows: [{ id: 'row-1', groupNo: 1, conceptSensor: '', mappedSensorTag: 'TAG1', mappedSensorName: '', modelType: 'Clustering', modelNotes: '', additionalNotes: '', status: false }],
                    },
                }));
                const { loadWorkspaceData } = await freshModule();
                const models = (await loadWorkspaceData('ws1'))!.failureGroupState!.models;
                expect(models[0].healthSetPoints).toEqual({ kind: 'clustering', outerSd: null });
            });
        });

        it('keeps every other failureGroupState field when it migrates groupNos (regression 2026-09-23: the migration rebuilt the object from an explicit field list and silently dropped the workspace time range and any future field)', async () => {
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: {
                    groups: [], models: [{ id: 'm1', groupNo: 1, kind: 'individual' }],
                    runningConditionFilters: [{ id: 'f1', sensor: 'S', operation: 'greater_than', value1: '1', value2: '' }],
                    runningConditionCombine: 'or',
                    runningConditionTimePeriods: [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }],
                    someFutureField: { keep: 'me' },
                },
            }));
            const { loadWorkspaceData } = await freshModule();
            const fg = (await loadWorkspaceData('ws1'))?.failureGroupState as unknown as Record<string, unknown>;
            expect(fg.runningConditionTimePeriods).toEqual([{ id: 'p1', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }]);
            expect(fg.runningConditionCombine).toBe('or');
            expect(fg.someFutureField).toEqual({ keep: 'me' });
        });

        it('converts legacy rows into individual-kind models by default', async () => {
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: {
                    groups: [{ no: 1, name: 'Group A' }],
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
                id: 'row-1', groupNos: [1], name: 'Vibration', kind: 'individual', category: null,
                notes: 'note', status: true, targetSensor: 'TAG1',
            });
        });

        it('leaves name empty (not the raw sensor tag) when the legacy row has no concept-sensor label', async () => {
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: {
                    groups: [{ no: 1, name: 'Group A' }],
                    rows: [{
                        id: 'row-1', groupNo: 1, conceptSensor: '', mappedSensorTag: 'TAG1',
                        mappedSensorName: '', modelType: '', modelNotes: '', additionalNotes: '', status: false,
                    }],
                },
            }));
            const { loadWorkspaceData } = await freshModule();
            const result = await loadWorkspaceData('ws1');
            const models = result?.failureGroupState?.models ?? [];
            // Empty, not 'TAG1' — the display layer (FailureGroupsPanel/
            // BuildModelWindow) falls back to the sensor's description when
            // name is unset; defaulting name to the tag here would defeat
            // that fallback (a non-empty name always wins over it).
            expect(models[0].name).toBe('');
        });

        it('infers relationship/clustering kind from the legacy free-text modelType field', async () => {
            mockReadTextFile.mockResolvedValue(JSON.stringify({
                id: 'ws1', name: 'A',
                failureGroupState: {
                    groups: [{ no: 1, name: 'Group A' }],
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
                    groups: [{ no: 1, name: 'Group A' }],
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
                    clusterRanges: [], filterTimePeriods: [], pmSensorFilters: [],
                },
                failureGroupState: {
                    groups: [{ no: 1, name: 'Group A' }],
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

    it('a second call\'s read never sees a stale pre-write snapshot while a first call\'s write is still in flight (regression: this exact race lost real Failure Group / model data on 2026-09-16 -- a rapid second edit read the disk before the first edit\'s write landed, computed its patch against that stale copy, and then overwrote the first edit\'s already-saved change)', async () => {
        mockStoreGet.mockResolvedValue([
            { id: 'ws1', name: 'A', description: '', lastModified: 1, filePath: 'workspaces/ws1.json' },
        ]);
        mockExists.mockResolvedValue(true);

        // A minimal fake disk: readTextFile always returns whatever the
        // most recent writeTextFile call actually wrote (not a fixed canned
        // value) -- otherwise this test can't distinguish a correctly
        // sequenced read from a racy stale one.
        let diskContent = JSON.stringify({
            id: 'ws1', name: 'A',
            failureGroupState: { groups: [], models: [] },
        });
        mockReadTextFile.mockImplementation(async () => diskContent);
        const firstWrite = deferred();
        let writeCount = 0;
        mockWriteTextFile.mockImplementation(async (_path: string, json: string) => {
            writeCount++;
            if (writeCount === 1) await firstWrite.promise; // hold the first write open
            diskContent = json;
        });

        const { updateWorkspaceData } = await freshModule();

        // Call 1: add a Failure Group. Its write is held pending above.
        const first = updateWorkspaceData('ws1', (s: any) => ({
            ...s,
            failureGroupState: { groups: [{ no: 1, name: 'Group A' }], models: s.failureGroupState.models },
        }));
        await vi.waitFor(() => expect(mockWriteTextFile).toHaveBeenCalledTimes(1));

        // Call 2 fires while call 1's write is still in flight -- an
        // unrelated edit (adding a model), not a repeat of call 1's own
        // change.
        mockReadTextFile.mockClear();
        const second = updateWorkspaceData('ws1', (s: any) => ({
            ...s,
            failureGroupState: {
                groups: s.failureGroupState.groups,
                models: [...s.failureGroupState.models, { id: 'm1', name: 'Model X' }],
            },
        }));

        // The actual property under test: call 2 must not even START its
        // own read while call 1's write is still pending. Flush several
        // microtask turns WITHOUT resolving `firstWrite` -- with the old
        // mutex-on-write-only design, `updateWorkspaceData`'s
        // `loadWorkspaceData` was never gated at all, so call 2's
        // `readTextFile` would already have fired by now (and read the
        // pre-Group-A snapshot). A final-state-only assertion can pass "by
        // accident" here since microtask scheduling can coincidentally
        // still land the read after the write resolves; asserting the call
        // hasn't happened yet is what actually pins down the guarantee.
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(mockReadTextFile).not.toHaveBeenCalled();

        firstWrite.resolve();
        await first;
        const result = await second;

        // Both survive: call 2's read only happened after call 1's write
        // fully landed, so its patch is applied on top of Group A instead
        // of silently erasing it.
        expect(result?.failureGroupState?.groups).toEqual([{ no: 1, name: 'Group A' }]);
        expect(result?.failureGroupState?.models).toEqual([{ id: 'm1', name: 'Model X' }]);
        expect(writeCount).toBe(2); // neither write was dropped
    });

    // 🆕 2026-10-02 [data-loss fix — real root cause of the repeated
    // "Running Condition Filter edit, then it's gone" reports]: a plain
    // `loadWorkspaceData()` call (not an `updateWorkspaceData` read-modify-
    // write) used to be a bare, unqueued read -- it could start and finish
    // WHILE an `updateWorkspaceData` write from the SAME window was still
    // in flight, resolving with pre-write data. `BuildModelWindow.tsx`'s own
    // hydration listener calls `loadWorkspaceData` directly (not through
    // `updateWorkspaceData`) every time it re-hydrates -- which happens more
    // than once per window: React StrictMode double-invokes the mount
    // effect that requests it, and Dashboard's `spawnBuildModel` re-sends
    // `build-model-data` every time "Build Model" is clicked while the
    // window is already open (re-pointing it, not just focusing it). If one
    // of those re-hydration reads landed in the gap between a user's RC
    // edit's `updateWorkspaceData` write starting and finishing, it would
    // `applyFg` the stale pre-edit snapshot straight over the just-saved
    // local state the instant the write actually completed -- reverting the
    // on-screen value back to the old one, even though the edit itself had
    // already landed correctly on disk. From the user's side this is
    // indistinguishable from "the edit never saved at all," which is
    // exactly what was reported ("regardless of how I close it, the value
    // doesn't stay"). Confirmed with a real repro against `BuildModelWindow`
    // (see that file's own test, same date) before this fix, which reliably
    // showed the on-screen value revert.
    it('a `loadWorkspaceData` call started before an `updateWorkspaceData` write landed must not resolve with pre-write data (the fix: `loadWorkspaceData` now shares the same `enqueue` queue)', async () => {
        mockStoreGet.mockResolvedValue([
            { id: 'ws1', name: 'A', description: '', lastModified: 1, filePath: 'workspaces/ws1.json' },
        ]);
        mockExists.mockResolvedValue(true);

        let diskContent = JSON.stringify({
            id: 'ws1', name: 'A',
            failureGroupState: { groups: [], models: [], runningConditionCombine: 'and' },
        });
        mockReadTextFile.mockImplementation(async () => diskContent);

        const pendingWrite = deferred();
        let writeCount = 0;
        mockWriteTextFile.mockImplementation(async (_path: string, json: string) => {
            writeCount++;
            if (writeCount === 1) await pendingWrite.promise; // hold the RC edit's write open
            diskContent = json;
        });

        const { loadWorkspaceData, updateWorkspaceData } = await freshModule();

        // The user's real RC edit — a read-modify-write, its write held open.
        const editPromise = updateWorkspaceData('ws1', (s: any) => ({
            ...s,
            failureGroupState: { ...s.failureGroupState, runningConditionCombine: 'or' },
        }));
        await vi.waitFor(() => expect(mockWriteTextFile).toHaveBeenCalledTimes(1));

        // A re-hydration pass's own `loadWorkspaceData` call starts now,
        // while the edit's write is still in flight (StrictMode's double
        // mount, or a second "Build Model" click re-pointing the window).
        mockReadTextFile.mockClear();
        const rehydratePromise = loadWorkspaceData('ws1');

        // Pinned, not inferred from final state (same reasoning as the
        // `updateWorkspaceData`-vs-`updateWorkspaceData` test above): the
        // re-hydration's read must not even have STARTED yet while the edit's
        // write is still pending. Before the fix this would already be true
        // (readTextFile already called, holding the stale pre-edit content).
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(mockReadTextFile).not.toHaveBeenCalled();

        pendingWrite.resolve();
        await editPromise;
        const rehydrated = await rehydratePromise;

        // The re-hydration must see the EDIT, not the pre-edit snapshot it
        // would have raced to if its read had fired immediately.
        expect(rehydrated?.failureGroupState?.runningConditionCombine).toBe('or');
    });

    it('2026-10-03 cross-window: two writers that edit DIFFERENT parts of a model (one its set points, one its settings/training fields) never erase each other, because both go through updateWorkspaceData against what is on disk', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(true);
        let disk = JSON.stringify({
            id: 'ws1', name: 'A',
            failureGroupState: {
                groups: [{ no: 1, name: 'G' }],
                models: [
                    { id: 'm1', groupNos: [1], kind: 'clustering', xSensor: 'X', ySensor: 'Y', numClusters: 3, notes: '' },
                    { id: 'm2', groupNos: [1], kind: 'individual', targetSensor: 'T', notes: '' },
                ],
                runningConditionCombine: 'or',
            },
        });
        mockReadTextFile.mockImplementation(async () => disk);
        mockWriteTextFile.mockImplementation(async (_p: string, content: string) => { disk = content; });
        const { updateWorkspaceData } = await freshModule();
        const { withFailureGroupState } = await import('../utils/failureGroupState');
        const { patchModelHealthSetPoints } = await import('../utils/healthSetPoints');

        // Window A: the (phase 3) set-points editor.
        const a = updateWorkspaceData('ws1', prev => withFailureGroupState(prev, {
            models: patchModelHealthSetPoints(prev.failureGroupState!.models, 'm1', { kind: 'clustering', outerSd: 5 }),
        }));
        // Window B: BuildModelWindow-style persist (spreads the model it edits) + a train-meta write.
        const b = updateWorkspaceData('ws1', prev => withFailureGroupState(prev, {
            models: prev.failureGroupState!.models.map(m => m.id === 'm1' ? { ...m, notes: 'edited in B', lastTrainedAt: 'T', trainedFingerprint: 'fp' } : m),
        }));
        // Dashboard-style toggle of ANOTHER model (spread) landing last.
        const c = updateWorkspaceData('ws1', prev => withFailureGroupState(prev, {
            models: prev.failureGroupState!.models.map(m => m.id === 'm2' ? { ...m, groupNos: [1, 2] } : m),
        }));
        await Promise.all([a, b, c]);

        const out = JSON.parse(disk).failureGroupState;
        expect(out.models[0]).toMatchObject({ id: 'm1', notes: 'edited in B', lastTrainedAt: 'T', healthSetPoints: { kind: 'clustering', outerSd: 5 } });
        expect(out.models[1]).toMatchObject({ id: 'm2', groupNos: [1, 2], healthSetPoints: { kind: 'individual', lower: null, upper: null } });
        expect(out.runningConditionCombine).toBe('or');
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
