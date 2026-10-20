import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mk } from './helpers/failureModelFixture';
import type { WorkspaceState } from '../types';

// ---- Tauri event bus fake: listeners by event name ------------------------
type Handler = (e: { payload: unknown }) => void;
const listeners = new Map<string, Set<Handler>>();
const mockListen = vi.fn(async (event: string, cb: Handler) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb);
    return () => { listeners.get(event)?.delete(cb); };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: (e: string, cb: Handler) => mockListen(e, cb) }));
const fire = (event: string, payload: unknown) => { for (const cb of [...(listeners.get(event) ?? [])]) cb({ payload }); };

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));

let disk: WorkspaceState | null;
const mockLoad = vi.fn(async () => disk);
const mockGetDir = vi.fn(async () => 'D:/last');
const mockSetDir = vi.fn(async (_dir: string) => {});
vi.mock('../workspaceManager', () => ({
    loadWorkspaceData: () => mockLoad(),
    getLastExportDir: () => mockGetDir(),
    setLastExportDir: (d: string) => mockSetDir(d),
}));

import { EXPORT_PROGRESS_DELAY_MS, useWorkspaceExport, type WorkspaceExportContext } from '../hooks/useWorkspaceExport';

const EVT = 'workspace-export-progress';
const CTX: WorkspaceExportContext = { metadata: [], headers: ['T'], expectedGeneration: 4 };
const AT = new Date(2026, 9, 20, 14, 30);

const makeWs = (name = 'Plant · M'): WorkspaceState => ({
    id: 'ws1', name, machine: { plant: 'Plant', name: 'M', tag: 'U-1', notes: '' }, dataUtcOffsetMin: 420,
    failureGroupState: { groups: [], models: [mk({ id: 'i1', targetSensor: 'T', category: 'condition' })], runningConditionNoneConfirmed: true },
} as unknown as WorkspaceState);

/** A deferred promise for the export command, so a test can fire events while it "runs". */
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const RESULT = { folder: 'D:/out/Plant_M_2026-10-20_1430', files: 3, models: 1, rows: 5, bytes: 50, exported_at: 'x', warnings: [] };

beforeEach(() => {
    listeners.clear();
    mockInvoke.mockReset();
    mockListen.mockClear();
    mockLoad.mockClear();
    mockSetDir.mockClear();
    disk = makeWs();
});
afterEach(() => { vi.useRealTimers(); });

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('useWorkspaceExport', () => {
    it('loads the last export folder', async () => {
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        await flush();
        expect(result.current.lastDir).toBe('D:/last');
        expect(result.current.phase).toBe('idle');
    });

    it('plan(): reads the workspace from disk, sends the built request, phase ready', async () => {
        const planOut = { ok: true, issues: [], models: [], files: 3 };
        mockInvoke.mockResolvedValue(planOut);
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        await act(async () => { await result.current.plan(); });
        expect(mockLoad).toHaveBeenCalled();
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        const [cmd, args] = mockInvoke.mock.calls[0];
        expect(cmd).toBe('plan_workspace_export');
        expect(args.request).toMatchObject({ workspace_id: 'ws1', expected_generation: 4, data_utc_offset_min: 420, models: [{ id: 'i1' }] });
        expect(result.current.phase).toBe('ready');
        expect(result.current.exportPlan).toEqual(planOut);
        expect(result.current.request?.workspace_id).toBe('ws1');
    });

    it('plan(): a workspace that cannot be read, or a Rust error, is a failure', async () => {
        disk = null;
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        await act(async () => { await result.current.plan(); });
        expect(result.current.phase).toBe('failed');
        expect(mockInvoke).not.toHaveBeenCalled();
        disk = makeWs();
        mockInvoke.mockRejectedValue('NO_DATA: nothing loaded');
        await act(async () => { await result.current.plan(); });
        expect(result.current).toMatchObject({ phase: 'failed', error: { code: 'NO_DATA', message: 'nothing loaded' } });
    });

    it('start(): fresh disk read, exact keys, progress filtered by export_id, shown only after 1 s, then done + lastDir saved', async () => {
        vi.useFakeTimers();
        const run = deferred<typeof RESULT>();
        mockInvoke.mockImplementation((cmd: string) => (cmd === 'export_workspace_results' ? run.promise : Promise.resolve(null)));
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        disk = makeWs('Plant · M2'); // changed on disk since the window looked
        let done!: Promise<unknown>;
        await act(async () => { done = result.current.start('D:/out', AT); await vi.advanceTimersByTimeAsync(0); });
        expect(result.current.phase).toBe('running');
        const call = mockInvoke.mock.calls.find(c => c[0] === 'export_workspace_results')!;
        expect(Object.keys(call[1]).sort()).toEqual(['dest_dir', 'export_id', 'folder_name', 'request']);
        expect(call[1].dest_dir).toBe('D:/out');
        expect(call[1].folder_name).toBe('Plant_M2_2026-10-20_1430');
        const exportId = call[1].export_id as string;
        expect(exportId).toBeTruthy();
        // the listener was registered BEFORE the command was invoked
        expect(mockListen).toHaveBeenCalledWith(EVT, expect.any(Function));

        await act(async () => {
            fire(EVT, { export_id: 'someone-else', workspace_id: 'ws1', written: 9, total: 9, model_key: 'X-I1' });
        });
        expect(result.current.progress).toBeNull();
        await act(async () => { fire(EVT, { export_id: exportId, workspace_id: 'ws1', written: 1, total: 2, model_key: 'T-I1' }); });
        expect(result.current.progress).toEqual({ written: 1, total: 2, modelKey: 'T-I1' });
        expect(result.current.showProgress).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_PROGRESS_DELAY_MS); });
        expect(result.current.showProgress).toBe(true);

        await act(async () => { run.resolve(RESULT); await done; });
        expect(result.current.phase).toBe('done');
        expect(result.current.result).toEqual(RESULT);
        expect(result.current.showProgress).toBe(false);
        expect(result.current.lastDir).toBe('D:/out');
        expect(mockSetDir).toHaveBeenCalledWith('D:/out');
        // the listener is gone: a late event changes nothing
        expect(listeners.get(EVT)?.size ?? 0).toBe(0);
        await act(async () => { fire(EVT, { export_id: exportId, workspace_id: 'ws1', written: 2, total: 2, model_key: 'T-I1' }); });
        expect(result.current.progress).toEqual({ written: 1, total: 2, modelKey: 'T-I1' });
    });

    it('a quick export never shows progress', async () => {
        vi.useFakeTimers();
        mockInvoke.mockResolvedValue(RESULT);
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        await act(async () => { await result.current.start('D:/out', AT); });
        await act(async () => { await vi.advanceTimersByTimeAsync(EXPORT_PROGRESS_DELAY_MS * 2); });
        expect(result.current.phase).toBe('done');
        expect(result.current.showProgress).toBe(false);
    });

    it('cancel(): sends the running export_id; a CANCELLED answer is phase cancelled, nothing remembered', async () => {
        const run = deferred<typeof RESULT>();
        mockInvoke.mockImplementation((cmd: string) => (cmd === 'export_workspace_results' ? run.promise : Promise.resolve(true)));
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        let done!: Promise<unknown>;
        await act(async () => { done = result.current.start('D:/out', AT); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        const exportId = mockInvoke.mock.calls.find(c => c[0] === 'export_workspace_results')![1].export_id;
        await act(async () => { await result.current.cancel(); });
        expect(mockInvoke).toHaveBeenCalledWith('cancel_workspace_export', { export_id: exportId });
        await act(async () => { run.reject('CANCELLED: by the user'); await done; });
        expect(result.current.phase).toBe('cancelled');
        expect(mockSetDir).not.toHaveBeenCalled();
    });

    it('a failed export: phase failed with the parsed error; a second start is possible afterwards', async () => {
        mockInvoke.mockRejectedValueOnce('WRITE_FAILED: T-I1.csv (denied)');
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        await act(async () => { await result.current.start('D:/out', AT); });
        expect(result.current).toMatchObject({ phase: 'failed', error: { code: 'WRITE_FAILED', message: 'T-I1.csv (denied)' } });
        mockInvoke.mockResolvedValue(RESULT);
        await act(async () => { await result.current.start('D:/out', AT); });
        expect(result.current.phase).toBe('done');
    });

    it('a second start while one runs does nothing', async () => {
        const run = deferred<typeof RESULT>();
        mockInvoke.mockImplementation(() => run.promise);
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        let first!: Promise<unknown>;
        await act(async () => { first = result.current.start('D:/out', AT); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        let second: unknown;
        await act(async () => { second = await result.current.start('D:/other', AT); });
        expect(second).toBeNull();
        expect(mockInvoke.mock.calls.filter(c => c[0] === 'export_workspace_results')).toHaveLength(1);
        await act(async () => { run.resolve(RESULT); await first; });
    });

    it('reset while the progress listener is still being registered: the export is never invoked, a following start works', async () => {
        const gate = deferred<void>();
        mockListen.mockImplementationOnce(async (event: string, cb: Handler) => {
            await gate.promise;
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(cb);
            return () => { listeners.get(event)?.delete(cb); };
        });
        mockInvoke.mockResolvedValue(RESULT);
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        let first!: Promise<unknown>;
        await act(async () => { first = result.current.start('D:/out', AT); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        expect(mockListen).toHaveBeenCalledTimes(1); // subscribed, `ready` still pending
        act(() => { result.current.reset(); });
        let firstOut: unknown;
        await act(async () => { gate.resolve(); firstOut = await first; });
        expect(firstOut).toBeNull();
        expect(mockInvoke.mock.calls.filter(c => c[0] === 'export_workspace_results')).toHaveLength(0);
        expect(listeners.get(EVT)?.size ?? 0).toBe(0); // the late listener was removed
        expect(result.current.phase).toBe('idle');
        await act(async () => { await result.current.start('D:/out', AT); });
        expect(mockInvoke.mock.calls.filter(c => c[0] === 'export_workspace_results')).toHaveLength(1);
        expect(result.current.phase).toBe('done');
    });

    it('re-pointed at another workspace: the old export is cancelled, its answer and events are ignored', async () => {
        const run = deferred<typeof RESULT>();
        mockInvoke.mockImplementation((cmd: string) => (cmd === 'export_workspace_results' ? run.promise : Promise.resolve(true)));
        const { result, rerender } = renderHook(({ id }) => useWorkspaceExport(id, CTX), { initialProps: { id: 'ws1' } });
        let done!: Promise<unknown>;
        await act(async () => { done = result.current.start('D:/out', AT); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        const exportId = mockInvoke.mock.calls.find(c => c[0] === 'export_workspace_results')![1].export_id;
        rerender({ id: 'ws2' });
        await flush();
        expect(mockInvoke).toHaveBeenCalledWith('cancel_workspace_export', { export_id: exportId });
        expect(result.current.phase).toBe('idle');
        await act(async () => { fire(EVT, { export_id: exportId, workspace_id: 'ws1', written: 1, total: 1, model_key: 'k' }); });
        await act(async () => { run.resolve(RESULT); await done; });
        expect(result.current.phase).toBe('idle');
        expect(result.current.result).toBeNull();
        expect(result.current.progress).toBeNull();
    });

    it('hide / show', async () => {
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        act(() => result.current.hide());
        expect(result.current.hidden).toBe(true);
        act(() => result.current.show());
        expect(result.current.hidden).toBe(false);
    });

    it('nothing is ever written to the workspace', async () => {
        mockInvoke.mockResolvedValue(RESULT);
        const { result } = renderHook(() => useWorkspaceExport('ws1', CTX));
        await act(async () => { await result.current.plan(); await result.current.start('D:/out', AT); });
        // the workspaceManager mock has no writer at all: only reads + the app-wide last folder
        expect(mockSetDir).toHaveBeenCalledTimes(1);
    });
});
