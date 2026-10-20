import { load } from '@tauri-apps/plugin-store';
import { readTextFile, writeTextFile, exists, mkdir, remove as removeFile, rename, BaseDirectory } from '@tauri-apps/plugin-fs';
import { WorkspaceState, WorkspaceMetadata, FailureModel, FailureSensorRow, FailureGroup, FailureGroupStateSlice, ModelKind, WorkspaceSensorFilter, TimePeriod } from './types';
import { debugLog } from './utils/debugLog';
import { migrateHealthSetPoints } from './utils/workspaceMigrations';
import { emptyHealthSetPoints } from './utils/healthSetPoints';
import { applyIncompleteRule } from './utils/incompleteRule';
import { withFailureGroupState } from './utils/failureGroupState';
import { failureGroupMetaFields } from './utils/failureGroupSummary';
import { logToFile } from './errorReporter';
import { projectDisplayName } from './utils/projectDetails';
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

export async function getRecentWorkspaces(): Promise<WorkspaceMetadata[]> {
    try {
        const s = await getStore();
        const workspaces = (await s.get('recent_workspaces')) as WorkspaceMetadata[];
        return Array.isArray(workspaces) ? workspaces : [];
    } catch (e) {
        console.error("Failed to get recent workspaces:", e);
        return [];
    }
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

// Serializes every disk-touching operation below (within THIS window's own
// module instance — each Tauri webview loads its own copy of this module,
// so this queue does NOT coordinate across windows; see updateWorkspaceData's
// own doc comment for that residual gap) into strict FIFO order. A later
// operation's `await` on this chain never resolves until every earlier one
// has fully finished writing.
//
// The READ of a read-modify-write is serialized too, not just the write:
// `updateWorkspaceData` reads the CURRENT file before applying a patch
// (e.g. "add this specific model") and writing. If only the write were
// queued, a second call could read the disk while the first call's write
// was still in flight, compute its patch against that stale snapshot and
// overwrite the first call's change. Serialized, every call sees the
// fully-committed result of every earlier one.
let queue: Promise<unknown> = Promise.resolve();

/** Runs `op` after every previously enqueued operation has settled
 *  (resolved OR rejected — a failed operation must not wedge every later
 *  one forever), and only after. */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = queue.then(op, op);
    queue = result.then(() => undefined, () => undefined);
    return result;
}

// `writeTextFile` is NOT atomic (it truncates the file, then writes).
// Dashboard and the Build Model window are separate OS windows, each with its
// own write queue, so one could READ the workspace file in the few
// milliseconds the other has it truncated: the read would come back empty and
// `JSON.parse` would throw. Writing to a sibling temp file and
// renaming it over the real one means a reader only ever sees the old or the
// new file, never a half-written one. `rename` replaces an existing file on
// Windows/macOS/Linux alike. If the rename is refused (an older capability
// without `fs:allow-rename`), fall back to the plain write so saving still
// works — the readers' retry below covers that case.
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
    try {
        const workspacesDir = 'workspaces';

        // Ensure directory exists
        const dirExists = await exists(workspacesDir, { baseDir: BaseDirectory.AppData });
        if (!dirExists) {
            debugLog("Creating workspaces directory in AppData...");
            await mkdir(workspacesDir, { recursive: true, baseDir: BaseDirectory.AppData });
        }

        const filePath = `${workspacesDir}/${state.id}.json`;
        debugLog("Writing workspace JSON to:", filePath);

        // Serialize state
        const json = JSON.stringify(state);
        await writeWorkspaceJsonAtomically(filePath, json);

        // Update recent workspaces list
        let recent = await getRecentWorkspaces();
        const meta: WorkspaceMetadata = {
            id: state.id,
            name: state.name,
            description: state.description,
            lastModified: Date.now(),
            filePath
        };

        const existingIdx = recent.findIndex(w => w.id === state.id);
        // The recent-project chip's Failure
        // Group count + colours. Derived from the groups being written HERE —
        // every save and every `updateWorkspaceData` (Dashboard autosave and FG
        // edits, Build Model window writes, rename, duplicate) funnels through
        // this function and already rewrites this entry, so the chip can never
        // go stale and keeping it current costs no extra disk write. A state
        // with no Failure Group slice keeps the entry's previous values (so a
        // project saved before these fields existed stays `undefined` = no
        // chip, rather than turning into a fake "No failure groups").
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

        // Keep top 10, sort by most recent
        recent = recent.sort((a, b) => b.lastModified - a.lastModified).slice(0, 10);

        await saveRecentWorkspaces(recent);

        debugLog("Workspace save successful.");
    } catch (e) {
        console.error("CRITICAL: Failed to save workspace:", e);
    }
}

export async function saveWorkspaceData(state: WorkspaceState): Promise<void> {
    await enqueue(() => writeWorkspaceFile(state));
}

// Read-modify-write: load workspace, apply a patch function, save. Use this
// from step 2/3 windows to avoid clobbering fields owned by other windows.
//
// The read and write both run inside `enqueue`, so this call's `loadWorkspaceData`
// cannot start until every earlier `updateWorkspaceData`/`saveWorkspaceData`
// call FROM THIS SAME WINDOW has finished writing — see the queue's own
// comment above for why that matters. This does NOT protect against a
// DIFFERENT window (e.g. Dashboard vs. the Build Model window) writing to
// the same workspace file at the same time — each window's webview loads
// its own independent copy of this module, so `queue` is not shared across
// them. That cross-window race is a real, separate, still-open gap.
export async function updateWorkspaceData(
    id: string,
    patch: (state: WorkspaceState) => WorkspaceState
): Promise<WorkspaceState | null> {
    return enqueue(async () => {
        // `readWorkspaceFile`, NOT the exported `loadWorkspaceData` — that one
        // is itself wrapped in `enqueue` now (see its own comment), and
        // calling it from inside an already-running enqueued operation would
        // queue a second operation that can only run once this one finishes,
        // which this one is waiting on — a deadlock.
        let current: WorkspaceState | null;
        try {
            current = await readWorkspaceFile(id);
        } catch (e) {
            // Unreadable file: write NOTHING (a patch computed against a missing
            // `prev` would replace every field the patch does not mention).
            console.error('updateWorkspaceData: skipping the write, the workspace file could not be read:', e);
            return null;
        }
        if (!current) return null;
        // "Incomplete immediately" — any write that
        // changes what a Complete model is trained on (its own inputs, or the
        // workspace running condition it follows) sets it back to Incomplete in
        // THIS same write, whichever window or writer made it. Compared against
        // `current` (what is on disk), never a caller's possibly stale mirror.
        const next = applyIncompleteRule(current, patch(current));
        await writeWorkspaceFile(next);
        return next;
    });
}

/** What `saveLegacyFormulaConversion` wrote. */
export interface LegacyConversionNotice {
    /** The state now on disk -- hand THIS (its recipes and models) to the
     *  Dashboard, or its full-overwrite autosave writes the old text back. */
    state: WorkspaceState;
    /** Conversions actually applied (a recipe edited meanwhile is skipped). */
    converted: LegacyFormulaConversion[];
    /** Ids of the models set back to Incomplete that must be trained again. */
    retrainModelIds: string[];
    /** User-facing text (`legacyConversionMessage`). */
    message: string;
}

/**
 * Persist the legacy `round(x, n)` conversion of a workspace open (customer
 * batch 2026-10, item 6; see `utils/legacyFormulaConversion.ts`): the new
 * formula text and the demotion of every model trained on a converted sensor
 * (or one built on it), in ONE write, computed against what is on disk.
 * Nothing to convert = no write at all (returns null), so this is safe to
 * call on every open. Null too when the file could not be read.
 */
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

// Default PM build config for a model that never had one — mirrors
// Dashboard.tsx's `spawnPredictiveModel` seed defaults so a freshly-migrated
// model behaves identically to a brand-new one until the user configures it.
const DEFAULT_PM_SLICE = {
    individualChecked: true,
    rcMode: null as 'relationship' | 'clustering' | null,
    scatterXSensor: '',
    relModelName: '',
    relStiffness: 100_000,
    clusterModelName: '',
    // One cluster by default — 2+ clusters need a criteria sensor (Rust
    // refuses n_clusters > 1 without one). Picking a criteria sensor lets
    // the stepper raise the count.
    numClusters: 1,
    criteriaSensor: '',
    clusterRanges: [],
    filterTimePeriods: [] as TimePeriod[],
    runningConditionMode: 'workspace' as 'workspace' | 'custom',
    customRunningConditionFilters: [] as WorkspaceSensorFilter[],
    customRunningConditionCombine: 'and' as 'and' | 'or',
};

/** Best-effort detection of the new `ModelKind` from the old free-text
 *  `modelType` field, so migrated rows land in the right kind instead of
 *  dumping everything into `individual` and making the user re-classify
 *  every model by hand. Falls back to `individual` when nothing matches. */
function inferModelKind(modelType: string): ModelKind {
    const t = (modelType || '').toLowerCase();
    if (t.includes('relationship') || t.includes('relation')) return 'relationship';
    if (t.includes('cluster')) return 'clustering';
    return 'individual';
}

/**
 * Ensures every model has `groupNos: number[]` (a many-to-many
 * model<->group relationship; an old workspace carries a singular
 * `groupNo: number`). A model that
 * already has `groupNos` is returned as-is; one still carrying only the
 * old `groupNo` becomes `groupNos: [groupNo]` (falling back to `[0]` —
 * the permanent "Not in Group" sentinel — if even that's missing).
 */
function normalizeModelGroups(models: FailureModel[]): FailureModel[] {
    return models.map(m => {
        const legacy = m as unknown as { groupNo?: number; groupNos?: number[] };
        if (Array.isArray(legacy.groupNos)) return m;
        const { groupNo, ...rest } = legacy as FailureModel & { groupNo?: number };
        return { ...rest, groupNos: [typeof groupNo === 'number' ? groupNo : 0] } as FailureModel;
    });
}

/**
 * One-time shim for legacy workspaces:
 * old `failureGroupState.rows: FailureSensorRow[]` +
 * global `predictiveModelState` become `failureGroupState.models: FailureModel[]`
 * with PM config folded per-model. Also runs `normalizeModelGroups` on the
 * already-migrated path, so a workspace whose models still carry the
 * singular `groupNo` opens correctly. Both steps no-op
 * once a workspace is fully current (`failureGroupState.models` exists and
 * every model already has `groupNos`).
 */
function migrateFailureGroupState(state: WorkspaceState): WorkspaceState {
    // Every read also gives each model the empty `healthSetPoints`
    // shape for its kind if it has none (idempotent; same object when nothing
    // to do). Runs AFTER the structural migration so legacy `rows` models count.
    return migrateHealthSetPoints(migrateFailureGroupStateStructure(state));
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
            // Only the one model that was actually open in the (single,
            // global) PM slice inherits its config — every other migrated
            // model gets fresh defaults rather than someone else's settings.
            const matchesPm = !!pm && pm.targetSensor === row.mappedSensorTag;
            const kind = inferModelKind(row.modelType);
            return {
                id: row.id,
                groupNos: [row.groupNo],
                // Leave name empty rather than falling back to the raw tag —
                // FailureGroupsPanel's display already falls back to the
                // sensor's description when name is unset, which reads far
                // better than permanently echoing the tag back as a "name".
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
                        // The legacy global PM slice predates this feature
                        // entirely — nothing to inherit, same as every other
                        // migrated model.
                        runningConditionMode: DEFAULT_PM_SLICE.runningConditionMode,
                        customRunningConditionFilters: DEFAULT_PM_SLICE.customRunningConditionFilters,
                        customRunningConditionCombine: DEFAULT_PM_SLICE.customRunningConditionCombine,
                    }
                    : DEFAULT_PM_SLICE),
            };
        });

    // `rows` is the legacy field this branch just converted — drop it, keep
    // everything else (same reasoning as the groupNos branch above).
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

// The actual read, NOT enqueued. `updateWorkspaceData`
// calls this (not the exported `loadWorkspaceData` below) so its own
// read-inside-enqueue doesn't try to enqueue a second time onto a queue it is
// already occupying (that would deadlock — the queued read would wait
// forever for itself to finish).
/** Thrown by `loadWorkspaceData` when the workspace file EXISTS but could not
 *  be read or parsed (after retries). Distinct from `null` = "no such
 *  workspace", so a caller that would otherwise overwrite the file from its
 *  own memory (Dashboard's autosave) can tell "nothing there" from "there is
 *  data there that I could not read" — and must not write in the second case. */
export class WorkspaceReadError extends Error {
    constructor(public readonly workspaceId: string, cause: unknown) {
        super(`Could not read workspace ${workspaceId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'WorkspaceReadError';
    }
}

const READ_RETRY_ATTEMPTS = 4;
const READ_RETRY_DELAY_MS = 40;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// A read that fails on an EXISTING file is retried a few times
// before giving up — the file may be mid-write by another window (see
// `writeWorkspaceJsonAtomically`). Gives up with `WorkspaceReadError`,
// never with `null`.
async function readWorkspaceFile(id: string): Promise<WorkspaceState | null> {
    debugLog("Loading Workspace Data for ID:", id);
    const recent = await getRecentWorkspaces();
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
            return migrateFailureGroupState(parsed);
        } catch (e) {
            lastError = e;
        }
    }
    console.error("Failed to load workspace data:", lastError);
    // Leave a trace in the log FILE (no toast): the caller skips its write
    // because of this, and it is the only evidence if data ever goes missing.
    logToFile('workspace-read',
        `Could not read workspace ${id} (${filePath}) after ${READ_RETRY_ATTEMPTS} tries; the save that needed it was skipped, nothing was overwritten`,
        lastError instanceof Error ? (lastError.stack ?? lastError.message) : String(lastError));
    throw new WorkspaceReadError(id, lastError);
}

// This read goes through the SAME `enqueue` queue as
// `updateWorkspaceData`/`saveWorkspaceData`, so it can never start until
// every earlier write queued by THIS window has fully landed.
//
// A caller that hydrates component state from this call can fire MORE THAN
// ONCE per window (React StrictMode double-invokes the mount effect that
// requests it, and Dashboard re-sends `build-model-data` every time "Build
// Model" is clicked while the window is already open). Unqueued, a
// re-hydration read that started BEFORE this window's own in-flight write
// but resolved AFTER it would read pre-edit data and apply it over the
// just-saved local state — and the next edit computed from that stale state
// would overwrite the correct value on disk. (This does not protect against
// a genuinely different OS window — e.g. Dashboard vs. Build Model — writing
// at the same moment; each window's webview has its own independent `queue`,
// a narrower gap noted on `updateWorkspaceData` above.)
export async function loadWorkspaceData(id: string): Promise<WorkspaceState | null> {
    return enqueue(() => readWorkspaceFile(id));
}

/** Where "Mark complete" writes a workspace's model files
 *  (`{app_data}/workspaces/{id}/output/...`, see Rust `get_model_output_dir`),
 *  relative to `$APPDATA`. The workspace's own JSON is the SIBLING
 *  `workspaces/{id}.json`, never inside this folder. */
export const workspaceFolderPath = (id: string): string => `workspaces/${id}`;

/** Best-effort recursive removal of a workspace's model-output folder. Never
 *  throws and never touches anything but `workspaces/{id}` — a missing folder
 *  (the common case: nothing was ever exported) is simply skipped. */
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
        const recent = await getRecentWorkspaces();
        const meta = recent.find(w => w.id === id);
        
        if (meta) {
            // Delete file if exists
            const fileExists = await exists(meta.filePath, { baseDir: BaseDirectory.AppData });
            if (fileExists) {
                await removeFile(meta.filePath, { baseDir: BaseDirectory.AppData });
            }
            
            // Remove from recent list
            const updated = recent.filter(w => w.id !== id);
            await saveRecentWorkspaces(updated);
        }
    } catch (e) {
        console.error("Failed to delete workspace:", e);
    }
    // Model files exported by "Mark complete" live in their own folder; remove
    // it too, independently of whether the workspace was still in the recent
    // list (that list is capped, so its absence says nothing about the folder).
    await removeWorkspaceFolder(id);
}

/** The name / machine a duplicate gets: the machine name gains " (Copy)" and
 *  the project name is derived from it ("Plant · Machine (Copy)"). A project
 *  made before machine details existed has no machine: its name gains
 *  " (Copy)" directly. Pure. */
export function duplicateNaming(state: Pick<WorkspaceState, 'name' | 'machine'>): Pick<WorkspaceState, 'name' | 'machine'> {
    if (!state.machine) return { name: `${state.name} (Copy)` };
    const machine = { ...state.machine, name: `${state.machine.name.trim()} (Copy)` };
    return { name: projectDisplayName(machine), machine };
}

/** A copy of the project under a new id, with the name from `duplicateNaming`.
 *  Models keep their status, set points, train record and verdict (user
 *  decision 2026-10-20: a copy is the same work). Only `healthExport` is
 *  dropped: it records files in the ORIGINAL project's output folder, which
 *  is not copied, so the copy must not point at them. */
export async function duplicateWorkspace(id: string) {
    try {
        const state = await loadWorkspaceData(id);
        if (state) {
            const copy: WorkspaceState = {
                ...state,
                id: `ws_${Date.now()}`,
                ...duplicateNaming(state),
            };
            const models = state.failureGroupState?.models;
            const newState: WorkspaceState = Array.isArray(models) && models.some(m => m.healthExport !== undefined)
                ? withFailureGroupState(copy, {
                    models: models.map(m => {
                        if (m.healthExport === undefined) return m;
                        const { healthExport: dropped, ...rest } = m;
                        void dropped;
                        return rest;
                    }),
                })
                : copy;
            await saveWorkspaceData(newState);
            return newState;
        }
    } catch (e) {
        console.error("Failed to duplicate workspace:", e);
    }
    return null;
}

export async function renameWorkspaceFile(id: string, newName: string) {
    try {
        const state = await loadWorkspaceData(id);
        if (state) {
            const newState: WorkspaceState = {
                ...state,
                name: newName
            };
            await saveWorkspaceData(newState);
            return true;
        }
    } catch (e) {
        console.error("Failed to rename workspace:", e);
    }
    return false;
}
