import { emit } from '@tauri-apps/api/event';
import { PROJECT_DETAILS_CHANGED, type MachineDetails, type ProjectDetailsChangedPayload, type WorkspaceState } from '../types';
import { loadWorkspaceData, updateWorkspaceData } from '../workspaceManager';

/* Project details: the machine and its data time zone. `name` and `description` derive from the machine; `saveProjectDetails` is the one writer of all four fields. */

export const EMPTY_MACHINE: MachineDetails = { plant: '', name: '', tag: '', notes: '' };

const t = (s: string | null | undefined): string => (s ?? '').trim();

/** "Plant · Machine" — how the project is named everywhere. Empty parts are left out. */
export function projectDisplayName(m: MachineDetails | null | undefined): string {
    return [t(m?.plant), t(m?.name)].filter(Boolean).join(' · ');
}

/** "tag · notes" — the project's description. Empty parts are left out. */
export function projectDescription(m: MachineDetails | null | undefined): string {
    return [t(m?.tag), t(m?.notes)].filter(Boolean).join(' · ');
}

/** Does another project already use this Plant · Machine pair? Trimmed, case-insensitive; `selfId` skipped; an incomplete pair is never a duplicate. */
export function isDuplicatePlantMachine(
    machine: MachineDetails,
    existing: ReadonlyArray<{ id?: string; name?: string }>,
    selfId?: string,
): boolean {
    if (!t(machine.plant) || !t(machine.name)) return false;
    const key = projectDisplayName(machine).toLowerCase();
    return existing.some(w => (selfId === undefined || w.id !== selfId) && t(w.name).toLowerCase() === key);
}

/** User-facing names of the required machine fields that are still empty. */
export function missingMachineFields(m: MachineDetails | null | undefined): string[] {
    const v = m ?? EMPTY_MACHINE;
    const out: string[] = [];
    if (!t(v.plant)) out.push('Plant name');
    if (!t(v.name)) out.push('Machine name');
    if (!t(v.tag)) out.push('Machine tag');
    return out;
}

/** A project made before machine details existed: Plant = its old name, the rest empty. */
export function machineOfOldProject(name: string): MachineDetails {
    return { ...EMPTY_MACHINE, plant: name };
}

/** The project's machine, or the old-project fallback when it has none. */
export function machineOf(ws: Pick<WorkspaceState, 'name' | 'machine'>): MachineDetails {
    return ws.machine ?? machineOfOldProject(ws.name ?? '');
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "+07:00" / "-03:30" for an offset in minutes east of UTC. */
export function fmtOffset(min: number): string {
    const a = Math.abs(Math.trunc(min));
    return `${min < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/** This PC's current offset from UTC, minutes east (Bangkok = 420). */
export function pcOffsetMin(): number {
    // `|| 0` turns -0 into 0.
    return -new Date().getTimezoneOffset() || 0;
}

/** Lowest / highest offset a data time zone may have (UTC-12:00 … UTC+14:00). */
export const MIN_UTC_OFFSET_MIN = -720;
export const MAX_UTC_OFFSET_MIN = 840;

/** Every offset the time-zone picker offers: half hours from UTC-12:00 to UTC+14:00 plus +05:45, +08:45, +12:45, +13:45. */
export const TZ_OPTIONS: readonly number[] = [
    ...Array.from({ length: (MAX_UTC_OFFSET_MIN - MIN_UTC_OFFSET_MIN) / 30 + 1 }, (_, i) => MIN_UTC_OFFSET_MIN + i * 30),
    345, 525, 765, 825,
].sort((a, b) => a - b);

/** What Project details saves. */
export interface ProjectDetailsValue {
    machine: MachineDetails;
    dataUtcOffsetMin: number;
}

/** The machine with every field trimmed (what is stored). */
function trimmedMachine(m: MachineDetails): MachineDetails {
    return { plant: t(m.plant), name: t(m.name), tag: t(m.tag), notes: t(m.notes) };
}

/** The one Project details save: ONE `updateWorkspaceData` write, then a `PROJECT_DETAILS_CHANGED` broadcast with `workspaceId`. Returns the payload; null when the project file is missing (nothing written or emitted); rejects if it can't save. */
export async function saveProjectDetails(
    workspaceId: string,
    value: ProjectDetailsValue,
): Promise<ProjectDetailsChangedPayload | null> {
    const machine = trimmedMachine(value.machine);
    const name = projectDisplayName(machine);
    const description = projectDescription(machine);
    const next = await updateWorkspaceData(workspaceId, prev => ({
        ...prev,
        name,
        description: description || undefined,
        machine,
        dataUtcOffsetMin: value.dataUtcOffsetMin,
    }));
    if (!next) return null;
    const payload: ProjectDetailsChangedPayload = { workspaceId, name, description };
    try {
        await emit(PROJECT_DETAILS_CHANGED, payload);
    } catch (e) {
        console.warn('saveProjectDetails: could not broadcast the change', e);
    }
    return payload;
}

/** Gives the project the PC's offset when it has none; re-checked on disk inside the write, so another window's value is kept. Write-free when already set. Returns the offset, or null if unreadable. */
export async function ensureDataUtcOffset(workspaceId: string): Promise<number | null> {
    let current: WorkspaceState | null;
    try {
        current = await loadWorkspaceData(workspaceId);
    } catch {
        return null;
    }
    if (!current) return null;
    if (current.dataUtcOffsetMin !== undefined) return current.dataUtcOffsetMin;
    let offset: number | null = null;
    await updateWorkspaceData(workspaceId, prev => {
        if (prev.dataUtcOffsetMin !== undefined) {
            offset = prev.dataUtcOffsetMin;
            return prev;
        }
        offset = pcOffsetMin();
        return { ...prev, dataUtcOffsetMin: offset };
    });
    return offset;
}
