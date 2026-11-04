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
const mockRename = vi.fn().mockResolvedValue(undefined);
const mockReadDir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn();
vi.mock('@tauri-apps/plugin-fs', () => ({
    readDir: (...args: unknown[]) => mockReadDir(...args),
    stat: (...args: unknown[]) => mockStat(...args),
    readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
    writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
    exists: (...args: unknown[]) => mockExists(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    remove: (...args: unknown[]) => mockRemove(...args),
    rename: (...args: unknown[]) => mockRename(...args),
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

/** Where every workspace save LANDED, in order: `[path, content]`. A save writes
 *  a temp sibling and renames it over the real file (so another
 *  window never reads a half-written file); a direct write (the fallback when
 *  the rename is refused) counts as landing at its own path. */
function savedFiles(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const tmp = new Map<string, string>();
    for (const [path, content] of mockWriteTextFile.mock.calls as Array<[string, string]>) {
        if (path.endsWith('.tmp')) tmp.set(path, content);
        else out.push([path, content]);
    }
    for (const [from, to] of mockRename.mock.calls as Array<[string, string]>) {
        if (tmp.has(from)) out.push([to, tmp.get(from)!]);
    }
    return out;
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
    mockRename.mockReset().mockResolvedValue(undefined);
    mockReadDir.mockReset().mockResolvedValue([]);
    mockStat.mockReset().mockResolvedValue({ mtime: null });
    mockInvoke.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('user-picked file exports', () => {
    it('no longer exports writeUserTextFile (its last caller, the Pair Plot CSV export, was removed 2026-10-09)', async () => {
        const mod = await freshModule();
        expect('writeUserTextFile' in mod).toBe(false);
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

describe('getRecentWorkspaces: projects missing from the list come back', () => {
    const entry = (id: string, lastModified = 1) => ({ id, name: id.toUpperCase(), description: '', lastModified, filePath: `workspaces/${id}.json` });
    const file = (name: string, isDirectory = false) => ({ name, isDirectory, isFile: !isDirectory, isSymlink: false });
    /** The store as a real one: `set` changes what `get` returns. */
    const storeHolding = (list: unknown[]) => {
        let held = list;
        mockStoreGet.mockImplementation(async () => held);
        mockStoreSet.mockImplementation(async (_k: string, v: unknown[]) => { held = v; });
    };
    const fileText = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, name: `Plant · ${id}`, ...extra });

    it('adds an unlisted workspace file, with its name, date and failure-group chip', async () => {
        storeHolding([entry('a', 500)]);
        mockReadDir.mockResolvedValue([file('a.json'), file('old.json')]);
        mockReadTextFile.mockResolvedValue(fileText('old', { description: 'd', failureGroupState: { groups: [{ no: 0, name: 'x' }, { no: 2, name: 'y' }], models: [] } }));
        mockStat.mockResolvedValue({ mtime: new Date(900) });
        const { getRecentWorkspaces } = await freshModule();
        const list = await getRecentWorkspaces();
        expect(list.map(w => w.id)).toEqual(['old', 'a']); // newest first
        expect(list[0]).toMatchObject({ name: 'Plant · old', description: 'd', lastModified: 900, filePath: 'workspaces/old.json', failureGroupCount: 1, failureGroupNos: [2] });
        expect(mockReadDir).toHaveBeenCalledWith('workspaces', { baseDir: 'AppData' });
        // Only the unlisted file was parsed.
        expect(mockReadTextFile.mock.calls.map(c => c[0])).toEqual(['workspaces/old.json']);
    });

    it('runs once: later reads do not list the folder or parse anything again', async () => {
        storeHolding([]);
        mockReadDir.mockResolvedValue([file('bad.json')]);
        mockReadTextFile.mockResolvedValue('{ not json');
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { getRecentWorkspaces } = await freshModule();
        await getRecentWorkspaces();
        await getRecentWorkspaces();
        expect(mockReadDir).toHaveBeenCalledTimes(1);
        expect(mockReadTextFile).toHaveBeenCalledTimes(1);
    });

    it('a bad file is skipped, the good ones still come back and the read does not fail', async () => {
        storeHolding([entry('a')]);
        mockReadDir.mockResolvedValue([file('bad.json'), file('other-id.json'), file('good.json')]);
        mockReadTextFile.mockImplementation(async (p: string) => {
            if (p.includes('bad')) return '{ not json';
            if (p.includes('other-id')) return fileText('not-this-file');
            return fileText('good');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { getRecentWorkspaces } = await freshModule();
        expect((await getRecentWorkspaces()).map(w => w.id).sort()).toEqual(['a', 'good']);
    });

    it('ignores temp files and folders, and writes nothing when nothing is missing', async () => {
        storeHolding([entry('a')]);
        mockReadDir.mockResolvedValue([file('a.json'), file('a.json.xyz.tmp'), file('a', true), file('dir.json', true)]);
        const { getRecentWorkspaces } = await freshModule();
        expect((await getRecentWorkspaces()).map(w => w.id)).toEqual(['a']);
        expect(mockReadTextFile).not.toHaveBeenCalled();
        expect(mockStoreSet).not.toHaveBeenCalled();
    });

    it('the list still reads when the folder cannot be listed, or a date cannot be read', async () => {
        storeHolding([entry('a')]);
        mockReadDir.mockRejectedValueOnce(new Error('forbidden path'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const first = await freshModule();
        expect((await first.getRecentWorkspaces()).map(w => w.id)).toEqual(['a']);

        mockReadDir.mockResolvedValue([file('old.json')]);
        mockReadTextFile.mockResolvedValue(fileText('old'));
        mockStat.mockRejectedValue(new Error('no stat'));
        const second = await freshModule();
        expect((await second.getRecentWorkspaces()).find(w => w.id === 'old')?.lastModified).toBe(0);
    });

    it('a store that cannot be read is not taken for an empty list', async () => {
        mockStoreGet.mockRejectedValue(new Error('store boom'));
        mockReadDir.mockResolvedValue([file('old.json')]);
        const { getRecentWorkspaces } = await freshModule();
        expect(await getRecentWorkspaces()).toEqual([]);
        expect(mockReadTextFile).not.toHaveBeenCalled();
        expect(mockStoreSet).not.toHaveBeenCalled();
    });

    it('a project that came back is seen by the duplicate Plant · Machine check, and can be deleted', async () => {
        storeHolding([]);
        mockReadDir.mockResolvedValue([file('old.json')]);
        mockReadTextFile.mockResolvedValue(fileText('old'));
        const { getRecentWorkspaces, deleteWorkspace } = await freshModule();
        const { isDuplicatePlantMachine } = await import('../utils/projectDetails');
        const list = await getRecentWorkspaces();
        expect(isDuplicatePlantMachine({ plant: 'Plant', name: 'old', tag: 'T', notes: '' }, list)).toBe(true);
        await deleteWorkspace('old');
        expect(mockRemove).toHaveBeenCalledWith('workspaces/old.json', { baseDir: 'AppData' });
        expect(await getRecentWorkspaces()).toEqual([]);
    });

    it('does not hold up or deadlock a save or load running in the queue', async () => {
        storeHolding([]);
        mockReadDir.mockResolvedValue([]);
        mockReadTextFile.mockResolvedValue(JSON.stringify({ id: 'ws1', name: 'A' }));
        const { getRecentWorkspaces, saveWorkspaceData, loadWorkspaceData, updateWorkspaceData } = await freshModule();
        await Promise.all([
            saveWorkspaceData({ id: 'ws1', name: 'A' } as any),
            getRecentWorkspaces(),
            loadWorkspaceData('ws1'),
            updateWorkspaceData('ws1', s => ({ ...s, name: 'B' })),
            getRecentWorkspaces(),
        ]);
        expect(savedFiles().length).toBeGreaterThanOrEqual(2);
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
        expect(savedFiles()).toContainEqual(['workspaces/ws1.json', JSON.stringify(state)]);
    });

    it('writes atomically: a temp sibling is renamed over the real file, never a write in place (2026-10-07: a read in another window could hit the file while an in-place write had it truncated, and the Dashboard then wrote its stale copy over every Failure Group)', async () => {
        mockStoreGet.mockResolvedValue([]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData(state);
        const paths = mockWriteTextFile.mock.calls.map(c => c[0] as string);
        expect(paths).not.toContain('workspaces/ws1.json');
        expect(paths).toHaveLength(1);
        expect(paths[0]).toMatch(/^workspaces\/ws1\.json\..+\.tmp$/);
        expect(mockRename).toHaveBeenCalledWith(paths[0], 'workspaces/ws1.json', { oldPathBaseDir: 'AppData', newPathBaseDir: 'AppData' });
    });

    it('falls back to a direct write (and removes the temp file) when the rename is refused', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockRename.mockRejectedValueOnce(new Error('rename not allowed'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData(state);
        const tmpPath = mockWriteTextFile.mock.calls[0][0] as string;
        expect(mockRemove).toHaveBeenCalledWith(tmpPath, { baseDir: 'AppData' });
        expect(mockWriteTextFile).toHaveBeenLastCalledWith('workspaces/ws1.json', JSON.stringify(state), { baseDir: 'AppData' });
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

    it('keeps every project on the list, newest first (no limit)', async () => {
        const existing = Array.from({ length: 12 }, (_, i) => ({
            id: `old-${i}`, name: `Old ${i}`, description: '', lastModified: i, filePath: `workspaces/old-${i}.json`,
        }));
        mockStoreGet.mockResolvedValue(existing);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData(state);
        const saved = mockStoreSet.mock.calls[0][1];
        expect(saved).toHaveLength(13);
        expect(saved[0].id).toBe('ws1');
        expect(saved[12].id).toBe('old-0');
    });

    it('rejects when the write fails, so a new project cannot look saved, and adds nothing to Recents', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockWriteTextFile.mockRejectedValue(new Error('disk full'));
        const { saveWorkspaceData } = await freshModule();
        await expect(saveWorkspaceData(state)).rejects.toThrow('disk full');
        expect(mockStoreSet).not.toHaveBeenCalled();
    });

    it('a failed save does not block the next queued save', async () => {
        mockStoreGet.mockResolvedValue([]);
        // Twice: the temp-file write, then its direct-write fallback.
        mockWriteTextFile.mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce(new Error('disk full'));
        const { saveWorkspaceData } = await freshModule();
        const first = saveWorkspaceData(state);
        const second = saveWorkspaceData(state);
        await expect(first).rejects.toThrow('disk full');
        await expect(second).resolves.toBeUndefined();
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
        expect(savedFiles()).toEqual([
            ['workspaces/ws1.json', JSON.stringify({ ...state, id: 'ws1' })],
            ['workspaces/ws2.json', JSON.stringify({ ...state, id: 'ws2' })],
            ['workspaces/ws3.json', JSON.stringify({ ...state, id: 'ws3' })],
        ]);
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

    it('throws WorkspaceReadError (never null) when the file exists but stays unreadable after retries (2026-10-07: null used to mean both "no such workspace" and "could not read it", and Dashboard\'s autosave answered the second by writing its in-memory copy over the file — erasing every Failure Group saved since that copy was taken)', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue('{not valid json');
        const { loadWorkspaceData, WorkspaceReadError } = await freshModule();
        await expect(loadWorkspaceData('ws1')).rejects.toBeInstanceOf(WorkspaceReadError);
        expect(mockReadTextFile.mock.calls.length).toBeGreaterThan(1); // retried
        // ...and it leaves a permanent trace in the log FILE (the only evidence
        // if a skipped save is ever followed by missing data).
        expect(mockInvoke).toHaveBeenCalledWith('log_frontend_error', expect.objectContaining({
            message: expect.stringContaining('[workspace-read] Could not read workspace ws1'),
        }));
    });

    it('retries a read that hits a half-written file and returns the state once it is complete', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile
            .mockResolvedValueOnce('')             // another window had it truncated
            .mockResolvedValueOnce('{"id":"ws1",') // still being written
            .mockResolvedValue(JSON.stringify({ id: 'ws1', name: 'A' }));
        const { loadWorkspaceData } = await freshModule();
        expect(await loadWorkspaceData('ws1')).toEqual({ id: 'ws1', name: 'A' });
    });

    it('still returns null when the workspace file does not exist', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(false);
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
            // Only the empty set points are added; nothing else changes.
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
            // A defaulted model starts with ONE cluster (2+ need a criteria sensor).
            expect(unmatched.numClusters).toBe(1);
            expect(unmatched.clusterRanges).toEqual([]);
            expect(unmatched.predictorSensors).toEqual([]);
        });
    });
});

describe('saveWorkspaceFrom', () => {
    it('an update queued while its read is in flight lands after the write, so it is not overwritten', async () => {
        const files = new Map<string, string>([['workspaces/ws1.json', JSON.stringify({ id: 'ws1', name: 'old', failureGroupState: { groups: [], models: [] } })]]);
        mockExists.mockImplementation(async (p: string) => files.has(p) || p === 'workspaces');
        mockReadTextFile.mockImplementation(async (p: string) => files.get(p) ?? '');
        mockWriteTextFile.mockImplementation(async (p: string, c: string) => { files.set(p, c); });
        mockRename.mockImplementation(async (a: string, b: string) => { files.set(b, files.get(a) ?? ''); files.delete(a); });
        const { saveWorkspaceFrom, updateWorkspaceData } = await freshModule();

        const save = saveWorkspaceFrom('ws1', disk => ({ ...disk!, name: 'from autosave' }));
        const update = updateWorkspaceData('ws1', prev => ({ ...prev, description: 'from the update' }));
        await Promise.all([save, update]);

        const onDisk = JSON.parse(files.get('workspaces/ws1.json') ?? '{}');
        expect(onDisk.name).toBe('from autosave');
        expect(onDisk.description).toBe('from the update');
    });

    it('writes nothing when compute returns null', async () => {
        const files = new Map<string, string>([['workspaces/ws1.json', JSON.stringify({ id: 'ws1', name: 'old' })]]);
        mockExists.mockImplementation(async (p: string) => files.has(p));
        mockReadTextFile.mockImplementation(async (p: string) => files.get(p) ?? '');
        const { saveWorkspaceFrom } = await freshModule();
        await expect(saveWorkspaceFrom('ws1', () => null)).resolves.toBeNull();
        expect(mockWriteTextFile).not.toHaveBeenCalled();
    });
});

describe('saveWorkspaceFrom failures', () => {
    const readable = () => {
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue(JSON.stringify({ id: 'ws1', name: 'A' }));
    };

    it('rejects when the write fails (temp file and direct write)', async () => {
        readable();
        mockWriteTextFile.mockRejectedValue(new Error('disk full'));
        const { saveWorkspaceFrom } = await freshModule();
        await expect(saveWorkspaceFrom('ws1', d => d)).rejects.toThrow('disk full');
        mockWriteTextFile.mockReset();
        mockWriteTextFile.mockResolvedValue(undefined);
    });

    it('rejects with WorkspaceReadError on an unreadable file: compute never runs, nothing is written', async () => {
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue('{ not json');
        const { saveWorkspaceFrom, WorkspaceReadError } = await freshModule();
        const compute = vi.fn();
        await expect(saveWorkspaceFrom('ws1', compute)).rejects.toBeInstanceOf(WorkspaceReadError);
        expect(compute).not.toHaveBeenCalled();
        expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it('a compute that throws rejects and does not block the next queued write', async () => {
        readable();
        const { saveWorkspaceFrom } = await freshModule();
        await expect(saveWorkspaceFrom('ws1', () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await expect(saveWorkspaceFrom('ws1', d => d)).resolves.toMatchObject({ id: 'ws1' });
    });
});

describe('updateWorkspaceData', () => {
    it('normalizeConditionSpelling as its patch: one write that also demotes the Complete model; a second run writes nothing', async () => {
        const { normalizeConditionSpelling } = await import('../utils/workspaceMigrations');
        const { computeTrainFingerprint } = await import('../utils/trainFingerprint');
        const cond = { id: 'c', sensor: 'temp a', operation: 'greater_than' as const, value1: '5', value2: '' };
        const fg: any = { runningConditionFilters: [cond], runningConditionTimePeriods: [{ id: 'p', start: '', end: '' }], runningConditionConversion: null };
        const model: any = {
            id: 'm', kind: 'individual', groupNos: [1], status: true, targetSensor: 'Flow', predictorSensors: [],
            runningConditionMode: 'workspace', customRunningConditionFilters: [], lastTrainedAt: '2026-10-01T00:00:00Z',
        };
        model.trainedFingerprint = computeTrainFingerprint(model, fg);
        const files = new Map<string, string>([['workspaces/ws1.json', JSON.stringify({ id: 'ws1', name: 'A', failureGroupState: { groups: [], models: [model], ...fg } })]]);
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockImplementation(async (p: string) => files.has(p) || p === 'workspaces');
        mockReadTextFile.mockImplementation(async (p: string) => files.get(p) ?? '');
        mockWriteTextFile.mockImplementation(async (p: string, c: string) => { files.set(p, c); });
        mockRename.mockImplementation(async (a: string, b: string) => { files.set(b, files.get(a) ?? ''); files.delete(a); });
        const { updateWorkspaceData } = await freshModule();
        const patch = (s: any) => normalizeConditionSpelling(s, ['timestamp', 'Temp A', 'Flow']);

        await updateWorkspaceData('ws1', patch);
        const onDisk = JSON.parse(files.get('workspaces/ws1.json')!);
        expect(onDisk.failureGroupState.runningConditionFilters[0].sensor).toBe('Temp A');
        expect(onDisk.failureGroupState.models[0].status).toBe(false);
        expect(onDisk.failureGroupState.models[0].trainedFingerprint).toBe(model.trainedFingerprint);

        mockRename.mockClear();
        await updateWorkspaceData('ws1', patch);
        expect(mockRename).not.toHaveBeenCalled();
    });

    it('rejects when the write fails, so a caller never takes it for saved', async () => {
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue(JSON.stringify({ id: 'ws1', name: 'A' }));
        mockWriteTextFile.mockRejectedValue(new Error('disk full'));
        const { updateWorkspaceData } = await freshModule();
        await expect(updateWorkspaceData('ws1', s => ({ ...s, name: 'B' }))).rejects.toThrow('disk full');
        mockWriteTextFile.mockReset();
        mockWriteTextFile.mockResolvedValue(undefined);
    });

    describe('an updater that changes nothing', () => {
        const stored = { id: 'ws1', name: 'A', failureGroupState: { groups: [{ no: 1, name: 'G' }], models: [], runningConditionConversion: null } };
        const listed = [{ id: 'ws1', name: 'A', description: '', lastModified: 123, filePath: 'workspaces/ws1.json' }];

        it.each([
            ['the same object', (s: any) => s],
            ['an equal copy', (s: any) => JSON.parse(JSON.stringify(s))],
            ['a copy with an undefined key', (s: any) => ({ ...s, description: undefined })],
        ])('%s: no write, Recents untouched, the state is still returned', async (_name, patch) => {
            mockStoreGet.mockResolvedValue(listed);
            mockExists.mockResolvedValue(true);
            mockReadTextFile.mockResolvedValue(JSON.stringify(stored));
            const { updateWorkspaceData } = await freshModule();
            await expect(updateWorkspaceData('ws1', patch)).resolves.toMatchObject({ id: 'ws1', name: 'A' });
            expect(mockWriteTextFile).not.toHaveBeenCalled();
            expect(mockRename).not.toHaveBeenCalled();
            expect(mockStoreSet).not.toHaveBeenCalled();
        });

        it('a real change still writes and moves lastModified', async () => {
            mockStoreGet.mockResolvedValue(listed);
            mockExists.mockResolvedValue(true);
            mockReadTextFile.mockResolvedValue(JSON.stringify(stored));
            const { updateWorkspaceData } = await freshModule();
            await updateWorkspaceData('ws1', s => ({ ...s, name: 'B' }));
            expect(savedFiles()).toHaveLength(1);
            expect(mockStoreSet.mock.calls[0][1][0].lastModified).toBeGreaterThan(123);
        });

        it('a file that needs a read-path migration is still written once, then no more', async () => {
            const oldFile = JSON.stringify({ id: 'ws1', name: 'A', failureGroupState: { groups: [], models: [] } });
            const files = new Map([['workspaces/ws1.json', oldFile]]);
            mockStoreGet.mockResolvedValue(listed);
            mockExists.mockResolvedValue(true);
            mockReadTextFile.mockImplementation(async (p: string) => files.get(p) ?? '');
            mockWriteTextFile.mockImplementation(async (p: string, c: string) => { files.set(p, c); });
            mockRename.mockImplementation(async (a: string, b: string) => { files.set(b, files.get(a) ?? ''); files.delete(a); });
            const { updateWorkspaceData } = await freshModule();
            await updateWorkspaceData('ws1', s => s);
            expect(JSON.parse(files.get('workspaces/ws1.json')!).failureGroupState.runningConditionConversion).toBeNull();
            expect(mockRename).toHaveBeenCalledTimes(1);
            await updateWorkspaceData('ws1', s => s);
            expect(mockRename).toHaveBeenCalledTimes(1);
        });
    });

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
        expect(savedFiles()).toEqual([['workspaces/ws1.json', JSON.stringify({ id: 'ws1', name: 'Patched' })]]);
    });

    it('writes NOTHING (and never calls the patch) when the file exists but cannot be read (2026-10-07: a patch computed against a missing prev would replace every field it does not mention)', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockResolvedValue('');
        const { updateWorkspaceData } = await freshModule();
        const patch = vi.fn();
        await expect(updateWorkspaceData('ws1', patch)).rejects.toThrow();
        expect(patch).not.toHaveBeenCalled();
        expect(mockWriteTextFile).not.toHaveBeenCalled();
        expect(mockRename).not.toHaveBeenCalled();
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

    // [data-loss fix — real root cause of the repeated
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

        // Window A: the set-points editor.
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

describe('updateWorkspaceData applies the Incomplete-immediately rule to every write (2026-10-03)', () => {
    const model = (over: Record<string, unknown> = {}) => ({
        id: 'm1', groupNos: [1], name: 'M', kind: 'individual', category: 'condition', notes: '', status: true,
        targetSensor: 'T1', predictorSensors: [], xSensor: '', ySensor: '', individualChecked: true, rcMode: null,
        scatterXSensor: '', relModelName: '', relStiffness: 100000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimePeriods: [], runningConditionMode: 'workspace',
        customRunningConditionFilters: [], customRunningConditionCombine: 'and',
        healthSetPoints: { kind: 'individual', lower: 1, upper: 9 },
        ...over,
    });
    const disk = (models: unknown[]) => JSON.stringify({
        id: 'ws1', name: 'A',
        failureGroupState: { groups: [], models, runningConditionFilters: [{ id: 'rc', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' }], runningConditionCombine: 'and' },
    });

    it('a write that changes the workspace running condition sets a Complete Workspace-mode model back to Incomplete, and keeps a Custom-mode one', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockReadTextFile.mockResolvedValue(disk([
            model({ id: 'ws-mode' }),
            model({ id: 'custom-mode', runningConditionMode: 'custom', customRunningConditionFilters: [{ id: 'rc', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' }] }),
        ]));
        const { updateWorkspaceData } = await freshModule();
        const next = await updateWorkspaceData('ws1', prev => ({
            ...prev,
            failureGroupState: { ...prev.failureGroupState!, runningConditionFilters: [{ id: 'rc', sensor: 'SPEED', operation: 'greater_than' as const, value1: '900', value2: '' }] },
        }));
        const byId = Object.fromEntries(next!.failureGroupState!.models.map(m => [m.id, m]));
        expect(byId['ws-mode'].status).toBe(false);
        expect(byId['custom-mode'].status).toBe(true);
        // What was written to disk is the demoted state.
        const written = JSON.parse(mockWriteTextFile.mock.calls[0][1] as string);
        expect(written.failureGroupState.models.find((m: any) => m.id === 'ws-mode').status).toBe(false);
    });

    it('keeps set points, lastTrainedAt and trainedFingerprint when it demotes', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockReadTextFile.mockResolvedValue(disk([model({ lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: 'fp' })]));
        const { updateWorkspaceData } = await freshModule();
        const next = await updateWorkspaceData('ws1', prev => ({
            ...prev,
            failureGroupState: { ...prev.failureGroupState!, models: prev.failureGroupState!.models.map(m => ({ ...m, targetSensor: 'T2' })) },
        }));
        expect(next!.failureGroupState!.models[0]).toMatchObject({
            status: false, targetSensor: 'T2', lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: 'fp',
            healthSetPoints: { kind: 'individual', lower: 1, upper: 9 },
        });
    });

    it('an unrelated write (rename, name/notes/category, group membership, runningStatus) leaves a Complete model Complete', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockReadTextFile.mockResolvedValue(disk([model()]));
        const { updateWorkspaceData } = await freshModule();
        const next = await updateWorkspaceData('ws1', prev => ({
            ...prev,
            name: 'Renamed',
            failureGroupState: {
                ...prev.failureGroupState!,
                runningStatus: { sensor: 'SPEED', stopAtOrBelow: '1200' },
                models: prev.failureGroupState!.models.map(m => ({
                    ...m, name: 'New name', notes: 'n', category: 'performance' as const, groupNos: [2],
                })),
            },
        }));
        expect(next!.failureGroupState!.models[0].status).toBe(true);
    });

    it('changed set points on a Complete model set it back to Incomplete in the same write (export round 2026-10-20), and what is written is the demoted state', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockReadTextFile.mockResolvedValue(disk([model({ lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: 'fp' })]));
        const { updateWorkspaceData } = await freshModule();
        const next = await updateWorkspaceData('ws1', prev => ({
            ...prev,
            failureGroupState: {
                ...prev.failureGroupState!,
                models: prev.failureGroupState!.models.map(m => ({ ...m, healthSetPoints: { kind: 'individual' as const, lower: 5, upper: 50 } })),
            },
        }));
        expect(next!.failureGroupState!.models[0]).toMatchObject({ status: false, lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: 'fp' });
        const written = JSON.parse(mockWriteTextFile.mock.calls[0][1] as string);
        expect(written.failureGroupState.models[0].status).toBe(false);
    });

    it('does not throw (and leaves statuses alone) on a malformed model record', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockStoreGet.mockResolvedValue([]);
        mockReadTextFile.mockResolvedValue(disk([{ id: 'weird', status: true, kind: 'relationship', groupNos: [1] }]));
        const { updateWorkspaceData } = await freshModule();
        const next = await updateWorkspaceData('ws1', prev => ({ ...prev, name: 'x' }));
        expect(next!.failureGroupState!.models[0].status).toBe(true);
    });

    // "Just score it": a scoring period is only
    // start -> end. A workspace saved BEFORE that still has `label` / `eventTime` /
    // `fromHighlight` on its periods: it must load, stay Complete, and never be sent back to
    // "Mark complete again" just because those keys stop counting or get dropped by an edit.
    describe('a workspace saved before 2026-10-10 (scoring periods still carrying label / eventTime / fromHighlight)', () => {
        const OLD_TESTS = [
            { id: 'o1', start: '2024-01-01T00:00', end: '2024-01-31T23:59', label: 'normal' },
            { id: 'o2', start: '2024-03-01T00:00', end: '2024-03-31T23:59', label: 'problem', eventTime: '2024-03-20T08:00', fromHighlight: 'Bearing failure' },
        ];
        const oldDisk = (models: unknown[]) => JSON.stringify({
            id: 'ws1', name: 'A',
            failureGroupState: {
                groups: [], models, runningConditionFilters: [{ id: 'rc', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' }], runningConditionCombine: 'and',
                runningConditionTimePeriods: [{ id: 'tr', start: '2023-01-01T00:00', end: '2023-12-31T23:59' }],
                runningConditionTestPeriods: OLD_TESTS,
            },
        });
        const complete = (over: Record<string, unknown> = {}) => model({ lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: 'fp', ...over });
        const lastWritten = () => {
            const saved = savedFiles();
            return JSON.parse(saved[saved.length - 1][1]);
        };

        it('loads as it is: the model is Complete and the legacy keys are still readable (no migration on load)', async () => {
            mockStoreGet.mockResolvedValue([]);
            mockReadTextFile.mockResolvedValue(oldDisk([complete()]));
            const { loadWorkspaceData } = await freshModule();
            const state = await loadWorkspaceData('ws1');
            expect(state!.failureGroupState!.models[0]).toMatchObject({ status: true, trainedFingerprint: 'fp' });
            expect(state!.failureGroupState!.models[0]).not.toHaveProperty('testsChangedAt');
            expect(state!.failureGroupState!.runningConditionTestPeriods).toEqual(OLD_TESTS);
            expect(mockWriteTextFile).not.toHaveBeenCalled(); // reading never rewrites the file
        });

        it('an unrelated write keeps the model Complete and writes the periods back untouched', async () => {
            mockStoreGet.mockResolvedValue([]);
            mockReadTextFile.mockResolvedValue(oldDisk([complete()]));
            const { updateWorkspaceData } = await freshModule();
            const next = await updateWorkspaceData('ws1', prev => ({ ...prev, name: 'Renamed' }));
            expect(next!.failureGroupState!.models[0].status).toBe(true);
            expect(next!.failureGroupState!.models[0]).not.toHaveProperty('testsChangedAt');
            expect(lastWritten().failureGroupState.runningConditionTestPeriods).toEqual(OLD_TESTS);
        });

        it('a write whose periods went through an edit and lost the legacy keys (toScoringPeriods) keeps it Complete — nothing to mark again', async () => {
            mockStoreGet.mockResolvedValue([]);
            mockReadTextFile.mockResolvedValue(oldDisk([
                complete({ id: 'ws-mode' }),
                complete({ id: 'custom-mode', runningConditionMode: 'custom', customRunningConditionFilters: [{ id: 'rc', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' }], customTestPeriods: OLD_TESTS }),
            ]));
            const { updateWorkspaceData } = await freshModule();
            const { toScoringPeriods } = await import('../utils/timePeriods');
            const next = await updateWorkspaceData('ws1', prev => ({
                ...prev,
                failureGroupState: {
                    ...prev.failureGroupState!,
                    runningConditionTestPeriods: toScoringPeriods(prev.failureGroupState!.runningConditionTestPeriods),
                    models: prev.failureGroupState!.models.map(m => (m.customTestPeriods ? { ...m, customTestPeriods: toScoringPeriods(m.customTestPeriods) } : m)),
                },
            }));
            for (const m of next!.failureGroupState!.models) {
                expect(m.status).toBe(true);
                expect(m).not.toHaveProperty('testsChangedAt');
            }
            const written = lastWritten().failureGroupState;
            expect(written.models.map((m: any) => m.status)).toEqual([true, true]);
            expect(JSON.stringify(written)).not.toMatch(/"label"|eventTime|fromHighlight/);
            expect(written.runningConditionTestPeriods).toEqual([
                { id: 'o1', start: '2024-01-01T00:00', end: '2024-01-31T23:59' },
                { id: 'o2', start: '2024-03-01T00:00', end: '2024-03-31T23:59' },
            ]);
        });

        it('a real change of an old period (its end moved) still asks for Mark complete again: Incomplete + testsChangedAt, train record kept', async () => {
            mockStoreGet.mockResolvedValue([]);
            mockReadTextFile.mockResolvedValue(oldDisk([complete()]));
            const { updateWorkspaceData } = await freshModule();
            const { toScoringPeriod } = await import('../utils/timePeriods');
            const next = await updateWorkspaceData('ws1', prev => ({
                ...prev,
                failureGroupState: {
                    ...prev.failureGroupState!,
                    runningConditionTestPeriods: prev.failureGroupState!.runningConditionTestPeriods!.map((t, i) => toScoringPeriod(i === 0 ? { ...t, end: '2024-02-15T00:00' } : t)),
                },
            }));
            const m = next!.failureGroupState!.models[0];
            expect(m).toMatchObject({ status: false, lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: 'fp' });
            expect(typeof m.testsChangedAt).toBe('string');
        });
    });
});

describe('deleteWorkspace', () => {
    it('does nothing to the JSON file or the recent list when the id is not in the recent list (a missing output folder is simply skipped)', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockExists.mockResolvedValue(false);
        const { deleteWorkspace } = await freshModule();
        await deleteWorkspace('missing');
        expect(mockRemove).not.toHaveBeenCalled();
        expect(mockStoreSet).not.toHaveBeenCalled();
    });

    // "Mark complete" writes model files into
    // `{app_data}/workspaces/{id}/output`; deleting the workspace must remove
    // that folder too, not only `{id}.json`.
    describe('model output folder cleanup', () => {
        const entry = (id: string) => ({ id, name: 'A', description: '', lastModified: 1, filePath: `workspaces/${id}.json` });

        it('removes workspaces/{id} recursively (in addition to the JSON file) when it exists', async () => {
            mockStoreGet.mockResolvedValue([entry('ws1')]);
            mockExists.mockResolvedValue(true);
            const { deleteWorkspace } = await freshModule();
            await deleteWorkspace('ws1');
            expect(mockRemove).toHaveBeenCalledWith('workspaces/ws1.json', { baseDir: 'AppData' });
            expect(mockRemove).toHaveBeenCalledWith('workspaces/ws1', { baseDir: 'AppData', recursive: true });
        });

        it('skips the folder when it does not exist (nothing was ever exported)', async () => {
            mockStoreGet.mockResolvedValue([entry('ws1')]);
            mockExists.mockImplementation(async (path: string) => path !== 'workspaces/ws1');
            const { deleteWorkspace } = await freshModule();
            await deleteWorkspace('ws1');
            expect(mockRemove).toHaveBeenCalledTimes(1);
            expect(mockRemove).toHaveBeenCalledWith('workspaces/ws1.json', { baseDir: 'AppData' });
        });

        it('still removes the folder when the workspace has fallen out of the (capped) recent list', async () => {
            mockStoreGet.mockResolvedValue([]);
            mockExists.mockImplementation(async (path: string) => path === 'workspaces/old');
            const { deleteWorkspace } = await freshModule();
            await deleteWorkspace('old');
            expect(mockRemove).toHaveBeenCalledTimes(1);
            expect(mockRemove).toHaveBeenCalledWith('workspaces/old', { baseDir: 'AppData', recursive: true });
        });

        it('never fails the delete when removing the folder throws', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockStoreGet.mockResolvedValue([entry('ws1')]);
            mockExists.mockResolvedValue(true);
            mockRemove.mockImplementation(async (path: string) => {
                if (path === 'workspaces/ws1') throw new Error('locked');
            });
            const { deleteWorkspace } = await freshModule();
            await expect(deleteWorkspace('ws1')).resolves.toBeUndefined();
            // The recent list was still updated.
            expect(mockStoreSet).toHaveBeenCalledWith('recent_workspaces', []);
        });

        it('refuses an id that could escape workspaces/ (no recursive remove is attempted)', async () => {
            mockStoreGet.mockResolvedValue([]);
            mockExists.mockResolvedValue(true);
            const { deleteWorkspace } = await freshModule();
            await deleteWorkspace('../secrets');
            await deleteWorkspace('a/b');
            await deleteWorkspace('');
            expect(mockRemove).not.toHaveBeenCalled();
        });
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

describe('recent-project Failure Group fields (customer batch 2026-10, item 5)', () => {
    /** A store whose `recent_workspaces` actually persists between calls. */
    function liveStore(initial: any[]) {
        let recent = initial;
        mockStoreGet.mockImplementation(async () => recent);
        mockStoreSet.mockImplementation(async (_k: string, v: any[]) => { recent = v; });
        return () => recent;
    }
    /** A disk where every read returns the last write. */
    function liveDisk(initial: object) {
        let disk = JSON.stringify(initial);
        mockReadTextFile.mockImplementation(async () => disk);
        mockWriteTextFile.mockImplementation(async (_p: string, json: string) => { disk = json; });
        mockRename.mockImplementation(async () => undefined);
    }
    const entry = (extra: object = {}) => ({ id: 'ws1', name: 'A', description: '', lastModified: 1, filePath: 'workspaces/ws1.json', ...extra });
    const groups = (...nos: number[]) => nos.map(no => ({ no, name: no === 0 ? 'Not in Group' : `G${no}` }));

    it('saveWorkspaceData writes the count of real groups (Not in Group excluded) and the first three numbers in group-number order', async () => {
        const recent = liveStore([]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData({ id: 'ws1', name: 'A', failureGroupState: { groups: groups(0, 5, 2, 1, 4), models: [] } } as any);
        expect(recent()[0]).toMatchObject({ id: 'ws1', failureGroupCount: 4, failureGroupNos: [1, 2, 4] });
    });

    it('a workspace with a Failure Group slice but no groups gets an explicit 0 (the "No failure groups" chip)', async () => {
        const recent = liveStore([]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData({ id: 'ws1', name: 'A', failureGroupState: { groups: groups(0), models: [] } } as any);
        expect(recent()[0].failureGroupCount).toBe(0);
        expect(recent()[0].failureGroupNos).toEqual([]);
    });

    it('a workspace with NO Failure Group slice never gets a default 0 — an old entry stays without the fields (no chip)', async () => {
        const recent = liveStore([entry()]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData({ id: 'ws1', name: 'Renamed' } as any);
        expect(recent()[0].name).toBe('Renamed');
        expect('failureGroupCount' in recent()[0]).toBe(false);
        expect('failureGroupNos' in recent()[0]).toBe(false);
    });

    it('a brand-new workspace saved without a slice has no fields either', async () => {
        const recent = liveStore([]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData({ id: 'ws1', name: 'A' } as any);
        expect('failureGroupCount' in recent()[0]).toBe(false);
    });

    it('a write without a slice keeps the entry\'s previously known count rather than dropping it', async () => {
        const recent = liveStore([entry({ failureGroupCount: 2, failureGroupNos: [1, 2] })]);
        const { saveWorkspaceData } = await freshModule();
        await saveWorkspaceData({ id: 'ws1', name: 'A' } as any);
        expect(recent()[0]).toMatchObject({ failureGroupCount: 2, failureGroupNos: [1, 2] });
    });

    it('updateWorkspaceData (Dashboard FG edits, Build Model window) keeps the count in step as groups are added and removed', async () => {
        const recent = liveStore([entry({ failureGroupCount: 1, failureGroupNos: [1] })]);
        liveDisk({ id: 'ws1', name: 'A', failureGroupState: { groups: groups(0, 1), models: [] } });
        const { updateWorkspaceData } = await freshModule();
        const { withFailureGroupState } = await import('../utils/failureGroupState');

        await updateWorkspaceData('ws1', s => withFailureGroupState(s, { groups: [...s.failureGroupState!.groups, { no: 2, name: 'G2' }, { no: 3, name: 'G3' }, { no: 4, name: 'G4' }] }));
        expect(recent()[0]).toMatchObject({ failureGroupCount: 4, failureGroupNos: [1, 2, 3] });

        await updateWorkspaceData('ws1', s => withFailureGroupState(s, { groups: s.failureGroupState!.groups.filter(g => g.no !== 1 && g.no !== 3) }));
        expect(recent()[0]).toMatchObject({ failureGroupCount: 2, failureGroupNos: [2, 4] });

        await updateWorkspaceData('ws1', s => withFailureGroupState(s, { groups: groups(0) }));
        expect(recent()[0]).toMatchObject({ failureGroupCount: 0, failureGroupNos: [] });
    });

    it('an unrelated write (no FG change) adds no extra store write — the entry is rewritten once per save, as before', async () => {
        liveStore([entry()]);
        liveDisk({ id: 'ws1', name: 'A', failureGroupState: { groups: groups(0, 1), models: [] } });
        const { updateWorkspaceData } = await freshModule();
        await updateWorkspaceData('ws1', s => ({ ...s, lastRoute: 'dashboard' } as any));
        expect(mockStoreSet).toHaveBeenCalledTimes(1);
        expect(mockStoreSave).toHaveBeenCalledTimes(1);
    });

});

// The legacy `round($A, 2)` auto-conversion
// on workspace open is persisted in ONE write (new text + model demotion), and
// writes nothing at all when there was nothing to convert.
describe('saveLegacyFormulaConversion', () => {
    const conversions = [{ tag: 'A', from: 'round($RAW, 2)', to: 'round($RAW * 100) / 100' }];

    function fakeDisk(initial: unknown) {
        let disk = JSON.stringify(initial);
        mockStoreGet.mockResolvedValue([{ id: 'ws1', name: 'W', description: '', lastModified: 1, filePath: 'workspaces/ws1.json' }]);
        mockExists.mockResolvedValue(true);
        mockReadTextFile.mockImplementation(async () => disk);
        mockWriteTextFile.mockImplementation(async (_p: string, json: string) => { disk = json; });
        return () => JSON.parse(disk);
    }

    it('nothing converted: no read, no write, null', async () => {
        const { saveLegacyFormulaConversion } = await freshModule();
        expect(await saveLegacyFormulaConversion('ws1', [])).toBeNull();
        expect(mockReadTextFile).not.toHaveBeenCalled();
        expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it('writes the converted text and demotes the models trained on it in the same write, and returns the written state + notice', async () => {
        const model = {
            id: 'm1', groupNos: [1], name: 'm1', kind: 'individual', category: 'condition', notes: '', status: true,
            xSensor: '', ySensor: '', targetSensor: 'A', predictorSensors: [], individualChecked: true, rcMode: null,
            scatterXSensor: '', relModelName: '', relStiffness: 0, clusterModelName: '', numClusters: 1, criteriaSensor: '',
            clusterRanges: [], filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [],
            customRunningConditionCombine: 'and', lastTrainedAt: '2026-01-01T00:00:00.000Z', trainedFingerprint: 'fp',
        };
        const read = fakeDisk({
            id: 'ws1', name: 'W',
            specialSensorRecipes: [{ kind: 'formula', tag: 'A', formula: 'round($RAW, 2)' }],
            failureGroupState: { groups: [], models: [model], runningConditionFilters: [] },
        });
        const { saveLegacyFormulaConversion } = await freshModule();
        const notice = await saveLegacyFormulaConversion('ws1', conversions);
        expect(notice).not.toBeNull();
        expect(notice!.converted).toEqual(conversions);
        expect(notice!.retrainModelIds).toEqual(['m1']);
        expect(notice!.message).toContain('1 model set back to Incomplete');
        const disk = read();
        expect(disk.specialSensorRecipes).toEqual([{ kind: 'formula', tag: 'A', formula: 'round($RAW * 100) / 100' }]);
        expect(disk.failureGroupState.models[0].status).toBe(false);
        expect(disk.failureGroupState.models[0].trainedFingerprint).toBeUndefined();
        expect(notice!.state.specialSensorRecipes).toEqual(disk.specialSensorRecipes);
        expect(savedFiles().filter(([p]) => p === 'workspaces/ws1.json')).toHaveLength(1);
    });
});

describe('last export folder (app-wide, settings.json key lastExportDir)', () => {
    it('reads it, null when absent or not a string', async () => {
        const { getLastExportDir, LAST_EXPORT_DIR_KEY } = await freshModule();
        expect(LAST_EXPORT_DIR_KEY).toBe('lastExportDir');
        mockStoreGet.mockResolvedValue('D:/exports');
        expect(await getLastExportDir()).toBe('D:/exports');
        expect(mockStoreGet).toHaveBeenCalledWith('lastExportDir');
        mockStoreGet.mockResolvedValue(undefined);
        expect(await getLastExportDir()).toBeNull();
        mockStoreGet.mockResolvedValue(42);
        expect(await getLastExportDir()).toBeNull();
    });
    it('saves it to the store', async () => {
        const { setLastExportDir } = await freshModule();
        await setLastExportDir('D:/x');
        expect(mockStoreSet).toHaveBeenCalledWith('lastExportDir', 'D:/x');
        expect(mockStoreSave).toHaveBeenCalled();
    });
});

describe('read path: the one-time conversion to ONE running condition (2026-10-26)', () => {
    const oldFile = () => JSON.stringify({
        id: 'ws1', name: 'A',
        failureGroupState: {
            groups: [],
            models: [{
                id: 'm1', groupNos: [1], name: 'M', kind: 'individual', category: 'condition', notes: '', status: true,
                targetSensor: 'T1', predictorSensors: [], xSensor: '', ySensor: '', individualChecked: true, rcMode: null,
                scatterXSensor: '', relModelName: '', relStiffness: 100000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
                clusterRanges: [], filterTimePeriods: [], runningConditionMode: 'workspace',
                customRunningConditionFilters: [], customRunningConditionCombine: 'and',
                healthSetPoints: { kind: 'individual', lower: 1, upper: 9 }, trainedFingerprint: 'fp',
            }],
            runningConditionFilters: [
                { id: 'a', sensor: 'TEMP', operation: 'less_than', value1: '90', value2: '' },
                { id: 'b', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' },
            ],
            runningConditionCombine: 'or',
            runningStatus: { sensor: 'LOAD', stopAtOrBelow: '3' },
        },
    });
    const ONE = [{ id: 'b', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' }];

    it('every read returns the converted shape (no write on read); the first write persists it', async () => {
        mockStoreGet.mockResolvedValue([]);
        mockReadTextFile.mockResolvedValue(oldFile());
        const { loadWorkspaceData, updateWorkspaceData } = await freshModule();
        const state = await loadWorkspaceData('ws1');
        const fg = state!.failureGroupState!;
        expect(fg.runningConditionFilters).toEqual(ONE);
        expect(fg.runningConditionCombine).toBe('and');
        expect(fg.runningStatus).toBeNull();
        expect(fg.models[0]).toMatchObject({ status: false, trainedFingerprint: 'fp', healthSetPoints: { kind: 'individual', lower: 1, upper: 9 } });
        expect(fg.runningConditionConversion).toMatchObject({ result: 'converted', source: 'first-above', after: { sensor: 'SPEED', value: '1200' }, incompleteModelIds: ['m1'] });
        expect(mockWriteTextFile).not.toHaveBeenCalled();

        // An unrelated write (e.g. a rename) writes the converted shape, never the old set.
        await updateWorkspaceData('ws1', prev => ({ ...prev, name: 'Renamed' }));
        const written = JSON.parse(mockWriteTextFile.mock.calls[0][1] as string).failureGroupState;
        expect(written.runningConditionFilters).toEqual(ONE);
        expect(written.runningStatus).toBeNull();
        expect(written.models[0].status).toBe(false);
        expect(written.runningConditionConversion).toMatchObject({ result: 'converted' });
    });

    it("a full-overwrite save of what was read (the Dashboard's autosave) cannot put the old multi-condition set back", async () => {
        mockStoreGet.mockResolvedValue([]);
        mockReadTextFile.mockResolvedValue(oldFile());
        const { loadWorkspaceData, saveWorkspaceData } = await freshModule();
        const state = await loadWorkspaceData('ws1');
        await saveWorkspaceData({ ...state!, name: 'Autosaved' });
        const written = savedFiles().map(([, body]) => JSON.parse(body)).find((w: any) => w.failureGroupState)!.failureGroupState;
        expect(written.runningConditionFilters).toEqual(ONE);
        expect(written.runningConditionConversion).not.toBeUndefined();
    });

    it('a dismissed conversion (null on disk) writes no new notice, but an old shape brought back by an older build is still normalised (data-driven)', async () => {
        mockStoreGet.mockResolvedValue([]);
        const file = JSON.parse(oldFile());
        file.failureGroupState.runningConditionConversion = null;
        mockReadTextFile.mockResolvedValue(JSON.stringify(file));
        const { loadWorkspaceData } = await freshModule();
        const fg = (await loadWorkspaceData('ws1'))!.failureGroupState!;
        expect(fg.runningConditionFilters).toEqual([{ id: 'b', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' }]);
        expect(fg.runningConditionConversion).toBeNull();
        expect(fg.models[0].status).toBe(false); // its rows changed: Incomplete, silently
    });
});
