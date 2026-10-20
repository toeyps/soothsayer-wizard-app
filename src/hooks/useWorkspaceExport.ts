import { useCallback, useEffect, useRef, useState } from 'react';
import type { SensorMetadata, SpecialSensorRecipe } from '../types';
import type {
    WorkspaceExportPlan, WorkspaceExportProgress, WorkspaceExportRequest, WorkspaceExportResult,
} from '../types/export';
import { WORKSPACE_EXPORT_PROGRESS } from '../types/export';
import { getLastExportDir, loadWorkspaceData, setLastExportDir } from '../workspaceManager';
import { buildWorkspaceExportRequest } from '../utils/exportReadiness';
import { subscribe, type Unsubscribe } from '../utils/tauriEvents';
import {
    cancelWorkspaceExport, exportFolderName, exportWorkspaceResults, parseExportError, planWorkspaceExport,
    type ParsedExportError,
} from '../utils/workspaceExport';

/*
 * Export results, as a hook. It reads the workspace FROM DISK every time it
 * needs it (another window may have changed it since this one last looked),
 * builds the request with `buildWorkspaceExportRequest`, and drives the Rust
 * commands. Nothing it does is written to the workspace; only the last export
 * folder is remembered (app-wide, plugin-store `lastExportDir`).
 */

export type WorkspaceExportPhase = 'idle' | 'planning' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled';

/** What the request needs besides the workspace on disk. Read when `plan` /
 *  `start` run (the latest values), never captured at mount. */
export interface WorkspaceExportContext {
    metadata: readonly SensorMetadata[] | null | undefined;
    headers: string[] | null;
    recipes?: readonly SpecialSensorRecipe[] | null;
    /** Model ids in Workbench run order. */
    order?: readonly string[];
    expectedGeneration?: number;
}

export interface WorkspaceExportProgressState {
    written: number;
    total: number;
    modelKey: string;
}

/** How long an export runs before its progress is shown (a quick one just finishes). */
export const EXPORT_PROGRESS_DELAY_MS = 1000;

const newExportId = (): string => {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
    return `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const NO_WORKSPACE: ParsedExportError = { code: null, message: 'The project could not be read — nothing was exported.' };

export interface UseWorkspaceExport {
    phase: WorkspaceExportPhase;
    /** The last dry run (`plan()`), or null. */
    exportPlan: WorkspaceExportPlan | null;
    /** The request the last plan / export was made with. */
    request: WorkspaceExportRequest | null;
    result: WorkspaceExportResult | null;
    error: ParsedExportError | null;
    progress: WorkspaceExportProgressState | null;
    /** True once a running export has taken longer than `EXPORT_PROGRESS_DELAY_MS`. */
    showProgress: boolean;
    /** The dialog is hidden while the export goes on (the bar shows it). */
    hidden: boolean;
    /** The folder the last export went into (app-wide), or null. */
    lastDir: string | null;
    /** Dry run against the workspace as it is on disk now. */
    plan: () => Promise<WorkspaceExportPlan | null>;
    /** Export into `destDir` (fresh disk read, rebuilt request). `at` names the folder. */
    start: (destDir: string, at?: Date) => Promise<WorkspaceExportResult | null>;
    /** Ask the running export to stop (it answers with `cancelled`). */
    cancel: () => Promise<void>;
    hide: () => void;
    show: () => void;
    /** Back to idle; a running export is cancelled. */
    reset: () => void;
}

export function useWorkspaceExport(workspaceId: string | null, context: WorkspaceExportContext): UseWorkspaceExport {
    const [phase, setPhase] = useState<WorkspaceExportPhase>('idle');
    const [exportPlan, setPlan] = useState<WorkspaceExportPlan | null>(null);
    const [request, setRequest] = useState<WorkspaceExportRequest | null>(null);
    const [result, setResult] = useState<WorkspaceExportResult | null>(null);
    const [error, setError] = useState<ParsedExportError | null>(null);
    const [progress, setProgress] = useState<WorkspaceExportProgressState | null>(null);
    const [showProgress, setShowProgress] = useState(false);
    const [hidden, setHidden] = useState(false);
    const [lastDir, setLastDir] = useState<string | null>(null);

    const ctxRef = useRef(context);
    ctxRef.current = context;
    const wsRef = useRef(workspaceId);
    wsRef.current = workspaceId;
    /** Bumped by every plan / start / reset / workspace change: an answer that
     *  arrives for an older one is dropped. */
    const seqRef = useRef(0);
    /** The export id of the running export (progress and cancel use it). */
    const exportIdRef = useRef<string | null>(null);
    const offRef = useRef<Unsubscribe | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const stopListening = useCallback(() => {
        offRef.current?.();
        offRef.current = null;
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    }, []);

    const reset = useCallback(() => {
        seqRef.current++;
        const running = exportIdRef.current;
        if (running) void cancelWorkspaceExport(running).catch(() => {});
        exportIdRef.current = null;
        stopListening();
        setPhase('idle'); setPlan(null); setRequest(null); setResult(null); setError(null);
        setProgress(null); setShowProgress(false); setHidden(false);
    }, [stopListening]);

    // A window re-pointed at another project starts clean.
    useEffect(() => { reset(); }, [workspaceId, reset]);
    useEffect(() => () => { seqRef.current++; stopListening(); }, [stopListening]);

    useEffect(() => {
        let alive = true;
        void getLastExportDir().then(d => { if (alive) setLastDir(d); });
        return () => { alive = false; };
    }, []);

    /** The request from the workspace as it is on disk NOW, or null. */
    const freshRequest = useCallback(async (id: string) => {
        const ws = await loadWorkspaceData(id);
        if (!ws) return null;
        const c = ctxRef.current;
        return {
            ws,
            req: buildWorkspaceExportRequest({
                workspace: ws, metadata: c.metadata, headers: c.headers, recipes: c.recipes,
                order: c.order, expectedGeneration: c.expectedGeneration,
            }),
        };
    }, []);

    const plan = useCallback(async (): Promise<WorkspaceExportPlan | null> => {
        const id = wsRef.current;
        if (!id) return null;
        const seq = ++seqRef.current;
        setPhase('planning'); setError(null); setResult(null);
        try {
            const fresh = await freshRequest(id);
            if (seq !== seqRef.current) return null;
            if (!fresh) { setError(NO_WORKSPACE); setPhase('failed'); return null; }
            setRequest(fresh.req);
            const p = await planWorkspaceExport(fresh.req);
            if (seq !== seqRef.current) return null;
            setPlan(p);
            setPhase('ready');
            return p;
        } catch (e) {
            if (seq !== seqRef.current) return null;
            setError(parseExportError(e));
            setPhase('failed');
            return null;
        }
    }, [freshRequest]);

    const start = useCallback(async (destDir: string, at: Date = new Date()): Promise<WorkspaceExportResult | null> => {
        const id = wsRef.current;
        if (!id || exportIdRef.current) return null;
        const seq = ++seqRef.current;
        const exportId = newExportId();
        exportIdRef.current = exportId;
        stopListening();
        setPhase('running'); setError(null); setResult(null); setProgress(null); setShowProgress(false);
        const finish = () => {
            if (exportIdRef.current === exportId) exportIdRef.current = null;
            stopListening();
        };
        try {
            const fresh = await freshRequest(id);
            if (seq !== seqRef.current) { finish(); return null; }
            if (!fresh) { finish(); setError(NO_WORKSPACE); setPhase('failed'); return null; }
            setRequest(fresh.req);
            const off = subscribe<WorkspaceExportProgress>(WORKSPACE_EXPORT_PROGRESS, ev => {
                const p = ev.payload;
                if (!p || p.export_id !== exportId || exportIdRef.current !== exportId) return;
                setProgress({ written: p.written, total: p.total, modelKey: p.model_key });
            });
            offRef.current = off;
            await off.ready;
            timerRef.current = setTimeout(() => {
                if (exportIdRef.current === exportId) setShowProgress(true);
            }, EXPORT_PROGRESS_DELAY_MS);
            const folderName = exportFolderName(fresh.ws.name ?? '', fresh.ws.machine?.tag ?? '', at);
            const res = await exportWorkspaceResults(fresh.req, destDir, folderName, exportId);
            finish();
            if (seq !== seqRef.current) return null;
            setResult(res);
            setPhase('done');
            setShowProgress(false);
            setLastDir(destDir);
            void setLastExportDir(destDir);
            return res;
        } catch (e) {
            finish();
            if (seq !== seqRef.current) return null;
            const err = parseExportError(e);
            setError(err);
            setShowProgress(false);
            setPhase(err.code === 'CANCELLED' ? 'cancelled' : 'failed');
            return null;
        }
    }, [freshRequest, stopListening]);

    const cancel = useCallback(async () => {
        const id = exportIdRef.current;
        if (!id) return;
        try {
            await cancelWorkspaceExport(id);
        } catch (e) {
            console.warn('cancelWorkspaceExport failed', e);
        }
    }, []);

    const hide = useCallback(() => setHidden(true), []);
    const show = useCallback(() => setHidden(false), []);

    return {
        phase, exportPlan, request, result, error, progress, showProgress, hidden, lastDir,
        plan, start, cancel, hide, show, reset,
    };
}
