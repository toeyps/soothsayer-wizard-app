import { load } from '@tauri-apps/plugin-store';
import { readTextFile, writeTextFile, exists, mkdir, remove as removeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { WorkspaceState, WorkspaceMetadata, FailureModel, FailureSensorRow, FailureGroup, ModelKind } from './types';

const STORE_FILE = 'settings.json';

// ─────────────────────────────────────────────────────────────────────────
// FS bridge helpers — for writing user-picked paths (CSV / PDF / PNG exports).
// These go through a Rust command instead of the fs plugin so they're not
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

/**
 * Write raw bytes to a user-picked file path.
 * Use this for PDF / PNG / binary exports. Same bridging rationale as
 * `writeUserTextFile`.
 */
export async function writeUserBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
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

// Simple mutex to prevent concurrent saves
let isSaving = false;
let saveQueue: WorkspaceState | null = null;

export async function saveWorkspaceData(state: WorkspaceState) {
    if (isSaving) {
        saveQueue = state;
        return;
    }

    isSaving = true;
    console.log("Saving Workspace Data for:", state.id);
    
    try {
        const workspacesDir = 'workspaces';
        
        // Ensure directory exists
        const dirExists = await exists(workspacesDir, { baseDir: BaseDirectory.AppData });
        if (!dirExists) {
            console.log("Creating workspaces directory in AppData...");
            await mkdir(workspacesDir, { recursive: true, baseDir: BaseDirectory.AppData });
        }
        
        const filePath = `${workspacesDir}/${state.id}.json`;
        console.log("Writing workspace JSON to:", filePath);
        
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

        console.log("Workspace save successful.");
    } catch (e) {
        console.error("CRITICAL: Failed to save workspace:", e);
    } finally {
        isSaving = false;
        if (saveQueue) {
            const nextState = saveQueue;
            saveQueue = null;
            saveWorkspaceData(nextState);
        }
    }
}

// Read-modify-write: load workspace, apply a patch function, save. Use this from step 2/3 windows
// to avoid clobbering fields owned by other windows.
export async function updateWorkspaceData(
    id: string,
    patch: (state: WorkspaceState) => WorkspaceState
): Promise<WorkspaceState | null> {
    const current = await loadWorkspaceData(id);
    if (!current) return null;
    const next = patch(current);
    await saveWorkspaceData(next);
    return next;
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
    pmSensorFilters: [],
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
 * One-time shim for workspaces saved before the Failure Group / Predictive
 * Model redesign: old `failureGroupState.rows: FailureSensorRow[]` +
 * global `predictiveModelState` become `failureGroupState.models: FailureModel[]`
 * with PM config folded per-model. No-ops once a workspace has already been
 * migrated (i.e. `failureGroupState.models` already exists).
 */
function migrateFailureGroupState(state: WorkspaceState): WorkspaceState {
    const fg = state.failureGroupState as unknown as { groups?: unknown[]; rows?: FailureSensorRow[]; models?: FailureModel[] } | undefined;
    if (!fg || Array.isArray(fg.models)) return state;

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
                groupNo: row.groupNo,
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
                        pmSensorFilters: pm!.pmSensorFilters,
                    }
                    : DEFAULT_PM_SLICE),
            };
        });

    return {
        ...state,
        failureGroupState: {
            groups: (fg.groups as FailureGroup[] | undefined) ?? [],
            models,
        },
    };
}

export async function loadWorkspaceData(id: string): Promise<WorkspaceState | null> {
    console.log("Loading Workspace Data for ID:", id);
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
