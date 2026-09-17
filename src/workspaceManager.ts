import { load } from '@tauri-apps/plugin-store';
import { readTextFile, writeTextFile, exists, mkdir, remove as removeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { WorkspaceState, WorkspaceMetadata, FailureModel, FailureSensorRow, FailureGroup, ModelKind, WorkspaceSensorFilter } from './types';
import { debugLog } from './utils/debugLog';

const STORE_FILE = 'settings.json';

// ─────────────────────────────────────────────────────────────────────────
// FS bridge helper — for writing user-picked paths (CSV / JSON exports).
// Goes through a Rust command instead of the fs plugin so it's not
// blocked by tightened fs scope (Phase 2 will limit fs plugin to $APPDATA/**).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Write a UTF-8 string to a user-picked file path.
 * Use this for CSV / JSON / text exports where the user chose the path via
 * the native save() dialog. Internally bridges through Rust to bypass fs
 * plugin scope restrictions.
 */
export async function writeUserTextFile(path: string, content: string): Promise<void> {
    const bytes = new TextEncoder().encode(content);
    await invoke('write_user_file', {
        path,
        contents: Array.from(bytes),
    });
}

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

// Serializes every disk-touching operation below (within THIS window's own
// module instance — each Tauri webview loads its own copy of this module,
// so this queue does NOT coordinate across windows; see updateWorkspaceData's
// own doc comment for that residual gap) into strict FIFO order. A later
// operation's `await` on this chain never resolves until every earlier one
// has fully finished writing.
//
// Replaces an earlier "mutex + single-slot queue" design that coalesced
// concurrent `saveWorkspaceData` calls down to just the LAST one — safe for
// a plain overwrite (nothing lost by skipping a superseded snapshot of the
// SAME data), but not safe once `updateWorkspaceData` started sharing it:
// its read-modify-write reads the CURRENT file (step 1) before applying an
// unrelated patch (step 2, e.g. "add this specific model") and writing
// (step 3) — only step 3 went through the mutex, so a second call's step 1
// could read the disk WHILE the first call's step 3 was still in flight,
// compute its patch against that stale snapshot, and then win the
// single-slot queue, overwriting the first call's already-written change
// with a version that never saw it. Confirmed as the cause of a real
// data-loss report (2026-09-16): rapid Failure Group / model edits in
// Dashboard, each its own immediate `updateWorkspaceData` call, raced each
// other exactly this way. Serializing the READ too (not just the write)
// closes it — every call now sees the fully-committed result of every
// earlier one, so no patch is ever computed against data that's about to
// be replaced.
let queue: Promise<unknown> = Promise.resolve();

/** Runs `op` after every previously enqueued operation has settled
 *  (resolved OR rejected — a failed operation must not wedge every later
 *  one forever), and only after. */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = queue.then(op, op);
    queue = result.then(() => undefined, () => undefined);
    return result;
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
        await writeTextFile(filePath, json, { baseDir: BaseDirectory.AppData });

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
        const current = await loadWorkspaceData(id);
        if (!current) return null;
        const next = patch(current);
        await writeWorkspaceFile(next);
        return next;
    });
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
    numClusters: 3,
    criteriaSensor: '',
    clusterRanges: [
        { min: 0, max: 33 },
        { min: 33, max: 66 },
        { min: 66, max: 100 },
    ],
    filterTimeStart: '',
    filterTimeEnd: '',
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
 * Ensures every model has `groupNos: number[]` (2026-08-25 redesign: the
 * old singular `groupNo: number` field became a real many-to-many
 * model<->group relationship — a sensor legitimately needs an individual,
 * a relationship, AND a clustering model at once, and a single model
 * needs to appear under more than one Failure Group without being
 * duplicated into a second, independently-editable copy). A model that
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
 * One-time shim for workspaces saved before the Failure Group / Predictive
 * Model redesign: old `failureGroupState.rows: FailureSensorRow[]` +
 * global `predictiveModelState` become `failureGroupState.models: FailureModel[]`
 * with PM config folded per-model. Also runs `normalizeModelGroups` on the
 * already-migrated path, so a workspace saved between that redesign and
 * the 2026-08-25 `groupNos[]` one still opens correctly. Both steps no-op
 * once a workspace is fully current (`failureGroupState.models` exists and
 * every model already has `groupNos`).
 */
function migrateFailureGroupState(state: WorkspaceState): WorkspaceState {
    const fg = state.failureGroupState as unknown as { groups?: unknown[]; rows?: FailureSensorRow[]; models?: FailureModel[]; runningConditionFilters?: WorkspaceSensorFilter[] } | undefined;
    if (!fg) return state;

    if (Array.isArray(fg.models)) {
        const needsGroupNosMigration = fg.models.some(m => !Array.isArray((m as unknown as { groupNos?: unknown }).groupNos));
        if (!needsGroupNosMigration) return state;
        return {
            ...state,
            failureGroupState: {
                groups: (fg.groups as FailureGroup[] | undefined) ?? [],
                models: normalizeModelGroups(fg.models),
                runningConditionFilters: fg.runningConditionFilters ?? [],
            },
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
                        filterTimeStart: pm!.filterTimeStart,
                        filterTimeEnd: pm!.filterTimeEnd,
                    }
                    : DEFAULT_PM_SLICE),
            };
        });

    return {
        ...state,
        failureGroupState: {
            groups: (fg.groups as FailureGroup[] | undefined) ?? [],
            models,
            runningConditionFilters: fg.runningConditionFilters ?? [],
        },
    };
}

export async function loadWorkspaceData(id: string): Promise<WorkspaceState | null> {
    debugLog("Loading Workspace Data for ID:", id);
    try {
        const recent = await getRecentWorkspaces();
        const meta = recent.find(w => w.id === id);

        let filePath = '';
        if (meta) {
            filePath = meta.filePath;
        } else {
            filePath = `workspaces/${id}.json`;
        }

        const fileExists = await exists(filePath, { baseDir: BaseDirectory.AppData });
        if (!fileExists) return null;

        const content = await readTextFile(filePath, { baseDir: BaseDirectory.AppData });
        const parsed = JSON.parse(content) as WorkspaceState;
        return migrateFailureGroupState(parsed);
    } catch (e) {
        console.error("Failed to load workspace data:", e);
        return null;
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
}

export async function duplicateWorkspace(id: string) {
    try {
        const state = await loadWorkspaceData(id);
        if (state) {
            const newState: WorkspaceState = {
                ...state,
                id: `ws_${Date.now()}`,
                name: `${state.name} (Copy)`
            };
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
