import { load } from '@tauri-apps/plugin-store';
import { readTextFile, writeTextFile, exists, mkdir, readDir, stat, remove as removeFile, rename, BaseDirectory } from '@tauri-apps/plugin-fs';
import { WorkspaceState, WorkspaceMetadata, FailureModel, FailureSensorRow, FailureGroup, FailureGroupStateSlice, ModelKind, WorkspaceSensorFilter, TimePeriod } from './types';
import { debugLog } from './utils/debugLog';
import { migrateHealthSetPoints, migrateRelStiffness, migrateSingleRunningCondition } from './utils/workspaceMigrations';
import { emptyHealthSetPoints } from './utils/healthSetPoints';
import { applyIncompleteRule } from './utils/incompleteRule';
import { failureGroupMetaFields } from './utils/failureGroupSummary';
import { logToFile } from './errorReporter';
import { applyLegacyConversion, legacyConversionMessage } from './utils/legacyFormulaConversion';
import type { LegacyFormulaConversion } from './types/formula';

const STORE_FILE = 'settings.json';

let storeInstance: any = null;
let storePromise: Promise<any> | null = null;

async function getStore() {
    if (storeInstance) return storeInstance;
    if (storePromise) return storePromise;

    storePromise = load(STORE_FILE).then(s => {
        storeInstance = s;
        storePromise = null;
        return s;
    });
    return storePromise;
}

async function storedRecentList(): Promise<WorkspaceMetadata[]> {
    const s = await getStore();
    const workspaces = (await s.get('recent_workspaces')) as WorkspaceMetadata[];
    return Array.isArray(workspaces) ? workspaces : [];
}

// For code already inside the queue: `getRecentWorkspaces` may enqueue and would deadlock there.
async function readRecentList(): Promise<WorkspaceMetadata[]> {
    try {
        return await storedRecentList();
    } catch (e) {
        console.error("Failed to get recent workspaces:", e);
        return [];
    }
}

/** The list entry of an unlisted workspace file, or null when it is not a usable project. */
async function metaFromFile(id: string, filePath: string): Promise<WorkspaceMetadata | null> {
    try {
        const state = JSON.parse(await readTextFile(filePath, { baseDir: BaseDirectory.AppData })) as WorkspaceState;
        if (state?.id !== id) return null;
        let lastModified = 0;
        try {
            lastModified = (await stat(filePath, { baseDir: BaseDirectory.AppData })).mtime?.getTime() ?? 0;
        } catch { /* no date known: it sorts last */ }
        return {
            id,
            name: state.name ?? id,
            description: state.description,
            lastModified,
            filePath,
            ...failureGroupMetaFields(state.failureGroupState?.groups),
        };
    } catch (e) {
        console.warn(`Skipped an unreadable workspace file (${filePath}):`, e);
        return null;
    }
}

// Restores projects that fell off the list when it was capped at 10; parses only unlisted files. Never throws.
async function recoverUnlistedWorkspaces(): Promise<void> {
    try {
        const entries = await readDir('workspaces', { baseDir: BaseDirectory.AppData });
        const files = entries.filter(e => !e.isDirectory && e.name.endsWith('.json'));
        if (files.length === 0) return;
        const listed = new Set((await storedRecentList()).map(w => w.id));
        const found: WorkspaceMetadata[] = [];
        for (const file of files) {
            const id = file.name.slice(0, -'.json'.length);
            if (listed.has(id)) continue;
            const meta = await metaFromFile(id, `workspaces/${file.name}`);
            if (meta) found.push(meta);
        }
        if (found.length === 0) return;
        // Read again: another window may have saved while the files were parsed.
        const current = await storedRecentList();
        const added = found.filter(m => !current.some(w => w.id === m.id));
        await saveRecentWorkspaces([...current, ...added].sort((a, b) => b.lastModified - a.lastModified));
    } catch (e) {
        console.warn('Could not look for workspaces missing from the recent list:', e);
    }
}

// Once per window: a project written after this always lists itself.
let recovery: Promise<void> | null = null;

export async function getRecentWorkspaces(): Promise<WorkspaceMetadata[]> {
    recovery ??= enqueue(recoverUnlistedWorkspaces);
    await recovery;
    return readRecentList();
}

export async function saveRecentWorkspaces(workspaces: WorkspaceMetadata[]) {
    try {
        const s = await getStore();
        await s.set('recent_workspaces', workspaces);
        await s.save();
    } catch (e) {
        console.error("Failed to save recent workspaces:", e);
    }
}

/** plugin-store key of the folder the last Export results went into. */
export const LAST_EXPORT_DIR_KEY = 'lastExportDir';

/** The folder the last Export results went into (`settings.json`), or null. */
export async function getLastExportDir(): Promise<string | null> {
    try {
        const s = await getStore();
        const v = await s.get(LAST_EXPORT_DIR_KEY);
        return typeof v === 'string' && v.trim() !== '' ? v : null;
    } catch (e) {
        console.error("Failed to read the last export folder:", e);
        return null;
    }
}

/** Remember the folder an export went into (app-wide, not per project). */
export async function setLastExportDir(dir: string): Promise<void> {
    try {
        const s = await getStore();
        await s.set(LAST_EXPORT_DIR_KEY, dir);
        await s.save();
    } catch (e) {
        console.error("Failed to save the last export folder:", e);
    }
}

// Serializes this window's disk operations in strict FIFO, reads included, so a read-modify-write sees every earlier write.
// Not shared across windows: each webview has its own copy.
let queue: Promise<unknown> = Promise.resolve();

/** Runs `op` after earlier operations settle (resolved or rejected, so one failure doesn't wedge the queue). */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = queue.then(op, op);
    queue = result.then(() => undefined, () => undefined);
    return result;
}

// `writeTextFile` is not atomic and other windows read this file: write a temp file and rename it over the real one so readers see old or new, never half.
// If rename is refused, fall back to a plain write (readers retry).
async function writeWorkspaceJsonAtomically(filePath: string, json: string): Promise<void> {
    const tmpPath = `${filePath}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
        await writeTextFile(tmpPath, json, { baseDir: BaseDirectory.AppData });
        await rename(tmpPath, filePath, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData });
    } catch (e) {
        console.warn('Atomic workspace write failed, falling back to a direct write:', e);
        try { await removeFile(tmpPath, { baseDir: BaseDirectory.AppData }); } catch { /* may not exist */ }
        await writeTextFile(filePath, json, { baseDir: BaseDirectory.AppData });
    }
}

async function writeWorkspaceFile(state: WorkspaceState): Promise<void> {
    debugLog("Saving Workspace Data for:", state.id);
    const workspacesDir = 'workspaces';

    const dirExists = await exists(workspacesDir, { baseDir: BaseDirectory.AppData });
    if (!dirExists) {
        debugLog("Creating workspaces directory in AppData...");
        await mkdir(workspacesDir, { recursive: true, baseDir: BaseDirectory.AppData });
    }

    const filePath = `${workspacesDir}/${state.id}.json`;
    debugLog("Writing workspace JSON to:", filePath);

    const json = JSON.stringify(state);
    await writeWorkspaceJsonAtomically(filePath, json);

    const recent = await readRecentList();
    const meta: WorkspaceMetadata = {
        id: state.id,
        name: state.name,
        description: state.description,
        lastModified: Date.now(),
        filePath
    };

    const existingIdx = recent.findIndex(w => w.id === state.id);
    // Recents chip count/colours come from the groups written here; with no group slice the previous values are kept.
    const fgMeta = failureGroupMetaFields(state.failureGroupState?.groups);
    const previous = existingIdx >= 0 ? recent[existingIdx] : undefined;
    if (fgMeta) {
        Object.assign(meta, fgMeta);
    } else if (previous?.failureGroupCount !== undefined) {
        meta.failureGroupCount = previous.failureGroupCount;
        if (previous.failureGroupNos !== undefined) meta.failureGroupNos = previous.failureGroupNos;
    }
    if (existingIdx >= 0) {
        recent[existingIdx] = meta;
    } else {
        recent.unshift(meta);
    }

    await saveRecentWorkspaces(recent.sort((a, b) => b.lastModified - a.lastModified));

    debugLog("Workspace save successful.");
}

/** Rejects when the write fails, so a caller never takes it for saved. */
export async function saveWorkspaceData(state: WorkspaceState): Promise<void> {
    await enqueue(() => writeWorkspaceFile(state));
}

// Read-modify-write inside the queue; protects only against this window's own writes, not another window's (open gap).
// Null only when the file doesn't exist; rejects if unreadable (nothing written) or the write fails.
export async function updateWorkspaceData(
    id: string,
    patch: (state: WorkspaceState) => WorkspaceState
): Promise<WorkspaceState | null> {
    return enqueue(async () => {
        // Not the exported `loadWorkspaceData`: it enqueues too, and waiting for
        // it from inside this queued operation would deadlock.
        const read = await readWorkspaceFileAndText(id);
        if (!read) return null;
        // Any write that changes what a Complete model is trained on sets it Incomplete in this same write, compared against disk, never a caller's mirror.
        const next = applyIncompleteRule(read.state, patch(read.state));
        // No write when the text is unchanged (narrows the cross-window race, no Recents bump); a read-path migration differs, so it still lands.
        if (JSON.stringify(next) !== read.text) await writeWorkspaceFile(next);
        return next;
    });
}

/** Queued read-then-write: `compute` gets the disk state and returns the state to write, or null for no write. Rejects with `WorkspaceReadError` if unreadable, or when the write fails. Returns what was written, else null. */
export async function saveWorkspaceFrom(
    id: string,
    compute: (disk: WorkspaceState | null) => WorkspaceState | null,
): Promise<WorkspaceState | null> {
    return enqueue(async () => {
        const next = compute(await readWorkspaceFile(id));
        if (next) await writeWorkspaceFile(next);
        return next;
    });
}

/** What `saveLegacyFormulaConversion` wrote. */
export interface LegacyConversionNotice {
    /** State now on disk; hand THIS to Dashboard, or its autosave writes the old text back. */
    state: WorkspaceState;
    /** Conversions actually applied (a recipe edited meanwhile is skipped). */
    converted: LegacyFormulaConversion[];
    /** Ids of the models set back to Incomplete that must be trained again. */
    retrainModelIds: string[];
    /** User-facing text (`legacyConversionMessage`). */
    message: string;
}

/** Persists the legacy `round(x, n)` conversion in ONE write against disk: new formula text plus demotion of models trained on converted sensors. Nothing to convert = no write (null); also null if the file is missing; rejects if unreadable/unwritable. */
export async function saveLegacyFormulaConversion(
    id: string,
    converted: LegacyFormulaConversion[],
): Promise<LegacyConversionNotice | null> {
    if (converted.length === 0) return null;
    let applied: LegacyFormulaConversion[] = [];
    let retrain: string[] = [];
    const written = await updateWorkspaceData(id, prev => {
        const res = applyLegacyConversion(prev, converted);
        applied = res.applied;
        retrain = res.retrain;
        return res.state;
    });
    if (!written || applied.length === 0) return null;
    return {
        state: written,
        converted: applied,
        retrainModelIds: retrain,
        message: legacyConversionMessage(applied, retrain.length),
    };
}

// Default PM config for a model with none; mirrors the defaults of Dashboard's `makeDefaultModelForKind`.
const DEFAULT_PM_SLICE = {
    individualChecked: true,
    rcMode: null as 'relationship' | 'clustering' | null,
    scatterXSensor: '',
    relModelName: '',
    relStiffness: 100_000,
    clusterModelName: '',
    // One cluster by default: 2+ needs a criteria sensor (Rust refuses otherwise).
    numClusters: 1,
    criteriaSensor: '',
    clusterRanges: [],
    filterTimePeriods: [] as TimePeriod[],
    runningConditionMode: 'workspace' as 'workspace' | 'custom',
    customRunningConditionFilters: [] as WorkspaceSensorFilter[],
    customRunningConditionCombine: 'and' as 'and' | 'or',
};

/** Best-effort kind from the old free-text `modelType`; falls back to `individual`. */
function inferModelKind(modelType: string): ModelKind {
    const t = (modelType || '').toLowerCase();
    if (t.includes('relationship') || t.includes('relation')) return 'relationship';
    if (t.includes('cluster')) return 'clustering';
    return 'individual';
}

/** Gives every model `groupNos`: an old singular `groupNo` becomes `[groupNo]`, falling back to `[0]` ('Not in Group'). */
function normalizeModelGroups(models: FailureModel[]): FailureModel[] {
    return models.map(m => {
        const legacy = m as unknown as { groupNo?: number; groupNos?: number[] };
        if (Array.isArray(legacy.groupNos)) return m;
        const { groupNo, ...rest } = legacy as FailureModel & { groupNo?: number };
        return { ...rest, groupNos: [typeof groupNo === 'number' ? groupNo : 0] } as FailureModel;
    });
}

/** Read-path shim: legacy `rows` + global `predictiveModelState` become `models` with PM config per model, and `groupNos` are normalised; then health set points and the single running condition. Idempotent. */
function migrateFailureGroupState(state: WorkspaceState): WorkspaceState {
    // Every read: give models their kind's empty `healthSetPoints`, then convert to the ONE running condition.
    // On the read path so every window (incl. Dashboard autosave) sees the converted shape; the first write persists it.
    return migrateRelStiffness(migrateSingleRunningCondition(migrateHealthSetPoints(migrateFailureGroupStateStructure(state))));
}

function migrateFailureGroupStateStructure(state: WorkspaceState): WorkspaceState {
    const fg = state.failureGroupState as unknown as { groups?: unknown[]; rows?: FailureSensorRow[]; models?: FailureModel[]; runningConditionFilters?: WorkspaceSensorFilter[]; runningConditionCombine?: 'and' | 'or' } | undefined;
    if (!fg) return state;

    if (Array.isArray(fg.models)) {
        const needsGroupNosMigration = fg.models.some(m => !Array.isArray((m as unknown as { groupNos?: unknown }).groupNos));
        if (!needsGroupNosMigration) return state;
        // Spread first: every field this migration doesn't own (the
        // workspace time range, anything added later) must survive it.
        return {
            ...state,
            failureGroupState: {
                ...(fg as object),
                groups: (fg.groups as FailureGroup[] | undefined) ?? [],
                models: normalizeModelGroups(fg.models),
                runningConditionFilters: fg.runningConditionFilters ?? [],
                runningConditionCombine: fg.runningConditionCombine ?? 'and',
            } as FailureGroupStateSlice,
        };
    }

    const legacyRows = Array.isArray(fg.rows) ? fg.rows : [];
    const pm = state.predictiveModelState;

    const models: FailureModel[] = legacyRows
        .filter(row => !!row.mappedSensorTag)
        .map(row => {
            // Only the model open in the global PM slice inherits its config.
            const matchesPm = !!pm && pm.targetSensor === row.mappedSensorTag;
            const kind = inferModelKind(row.modelType);
            return {
                id: row.id,
                groupNos: [row.groupNo],
                // Leave name empty: display falls back to the sensor description instead of echoing the tag.
                name: row.conceptSensor ?? '',
                kind,
                category: null,
                notes: row.modelNotes ?? '',
                status: !!row.status,
                targetSensor: kind === 'clustering' ? '' : row.mappedSensorTag,
                predictorSensors: matchesPm ? (pm!.predictorSensors ?? []) : [],
                xSensor: kind === 'clustering' ? row.mappedSensorTag : '',
                ySensor: '',
                // Legacy rows predate set points; no sensor metadata here, so
                // Individual's master snapshot stays "not taken yet".
                healthSetPoints: emptyHealthSetPoints(kind),
                ...(matchesPm
                    ? {
                        individualChecked: pm!.individualChecked,
                        rcMode: pm!.rcMode,
                        scatterXSensor: pm!.scatterXSensor,
                        relModelName: pm!.relModelName,
                        relStiffness: pm!.relStiffness,
                        clusterModelName: pm!.clusterModelName,
                        numClusters: pm!.numClusters,
                        criteriaSensor: pm!.criteriaSensor,
                        clusterRanges: pm!.clusterRanges,
                        // The legacy global PM slice's single time range becomes one period.
                        filterTimePeriods: (() => {
                            const old = pm as unknown as { filterTimeStart?: string; filterTimeEnd?: string };
                            return old.filterTimeStart || old.filterTimeEnd
                                ? [{ id: 'legacy-1', start: old.filterTimeStart ?? '', end: old.filterTimeEnd ?? '' }]
                                : [];
                        })(),
                        // The legacy global slice has nothing to inherit.
                        runningConditionMode: DEFAULT_PM_SLICE.runningConditionMode,
                        customRunningConditionFilters: DEFAULT_PM_SLICE.customRunningConditionFilters,
                        customRunningConditionCombine: DEFAULT_PM_SLICE.customRunningConditionCombine,
                    }
                    : DEFAULT_PM_SLICE),
            };
        });

    // Drop legacy `rows`, keep the rest.
    const { rows: _legacyRows, ...restOfFg } = fg;
    void _legacyRows;
    return {
        ...state,
        failureGroupState: {
            ...(restOfFg as object),
            groups: (fg.groups as FailureGroup[] | undefined) ?? [],
            models,
            runningConditionFilters: fg.runningConditionFilters ?? [],
            runningConditionCombine: fg.runningConditionCombine ?? 'and',
        } as FailureGroupStateSlice,
    };
}

/** Thrown when the file EXISTS but can't be read/parsed after retries (`null` = no workspace), so autosave never overwrites unreadable data. */
export class WorkspaceReadError extends Error {
    constructor(public readonly workspaceId: string, cause: unknown) {
        super(`Could not read workspace ${workspaceId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'WorkspaceReadError';
    }
}

const READ_RETRY_ATTEMPTS = 4;
const READ_RETRY_DELAY_MS = 40;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Retries a failed read of an existing file (it may be mid-write by another window); ends in `WorkspaceReadError`, never `null`.
// Not enqueued: callers already inside the queue use it, and enqueueing again would deadlock.
async function readWorkspaceFile(id: string): Promise<WorkspaceState | null> {
    return (await readWorkspaceFileAndText(id))?.state ?? null;
}

async function readWorkspaceFileAndText(id: string): Promise<{ state: WorkspaceState; text: string } | null> {
    debugLog("Loading Workspace Data for ID:", id);
    const recent = await readRecentList();
    const meta = recent.find(w => w.id === id);
    const filePath = meta ? meta.filePath : `workspaces/${id}.json`;

    let lastError: unknown = null;
    for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(READ_RETRY_DELAY_MS * attempt);
        try {
            const fileExists = await exists(filePath, { baseDir: BaseDirectory.AppData });
            if (!fileExists) return null;
            const content = await readTextFile(filePath, { baseDir: BaseDirectory.AppData });
            const parsed = JSON.parse(content) as WorkspaceState;
            return { state: migrateFailureGroupState(parsed), text: content };
        } catch (e) {
            lastError = e;
        }
    }
    console.error("Failed to load workspace data:", lastError);
    // Log the failure: the caller skips its write, so this is the only evidence if data goes missing.
    logToFile('workspace-read',
        `Could not read workspace ${id} (${filePath}) after ${READ_RETRY_ATTEMPTS} tries; the save that needed it was skipped, nothing was overwritten`,
        lastError instanceof Error ? (lastError.stack ?? lastError.message) : String(lastError));
    throw new WorkspaceReadError(id, lastError);
}

// Goes through the same queue as writes so it starts after this window's earlier writes land; otherwise a re-hydration read (StrictMode double mount, repeated 'Build Model' clicks) could return pre-edit data and overwrite newer local state.
// Does not cover other windows.
export async function loadWorkspaceData(id: string): Promise<WorkspaceState | null> {
    return enqueue(() => readWorkspaceFile(id));
}

/** Workspace folder under app data (`workspaces/{id}`); old projects may have an `output/` there. The JSON is the sibling `workspaces/{id}.json`. */
export const workspaceFolderPath = (id: string): string => `workspaces/${id}`;

/** Best-effort recursive removal of `workspaces/{id}`; never throws; a missing folder is skipped. */
async function removeWorkspaceFolder(id: string): Promise<void> {
    // An id that could escape `workspaces/` must never reach a recursive remove.
    if (!id || id.includes('/') || id.includes('\\') ||id.includes('..')) return;
    try {
        const dir = workspaceFolderPath(id);
        if (await exists(dir, { baseDir: BaseDirectory.AppData })) {
            await removeFile(dir, { baseDir: BaseDirectory.AppData, recursive: true });
        }
    } catch (e) {
        console.warn('Could not remove the workspace output folder:', e);
    }
}

export async function deleteWorkspace(id: string) {
    try {
        const recent = await readRecentList();
        const meta = recent.find(w => w.id === id);

        if (meta) {
            const fileExists = await exists(meta.filePath, { baseDir: BaseDirectory.AppData });
            if (fileExists) {
                await removeFile(meta.filePath, { baseDir: BaseDirectory.AppData });
            }
            
            const updated = recent.filter(w => w.id !== id);
            await saveRecentWorkspaces(updated);
        }
    } catch (e) {
        console.error("Failed to delete workspace:", e);
    }
    // Also remove the workspace's folder, listed or not.
    await removeWorkspaceFolder(id);
}

