import { load } from '@tauri-apps/plugin-store';
import { readTextFile, writeTextFile, exists, mkdir, remove as removeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { WorkspaceState, WorkspaceMetadata } from './types';

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

export async function getLastWorkspaceId(): Promise<string | null> {
    try {
        const s = await getStore();
        const id = await s.get('last_workspace_id');
        return (id as string) || null;
    } catch (e) {
        console.error("Failed to get last workspace ID:", e);
        return null;
    }
}

export async function setLastWorkspaceId(id: string | null) {
    try {
        const s = await getStore();
        await s.set('last_workspace_id', id);
        await s.save();
    } catch (e) {
        console.error("Failed to set last workspace ID:", e);
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
        await setLastWorkspaceId(state.id);
        
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
        return JSON.parse(content) as WorkspaceState;
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
            
            // If it was last session, clear it
            const lastId = await getLastWorkspaceId();
            if (lastId === id) {
                await setLastWorkspaceId(null);
            }
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
