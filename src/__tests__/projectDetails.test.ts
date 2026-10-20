import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceState } from '../types';
import { PROJECT_DETAILS_CHANGED } from '../types';

const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({ emit: (...a: unknown[]) => mockEmit(...a) }));

// Disk fake: one workspace; every write is counted.
let disk: WorkspaceState | null;
let writes = 0;
vi.mock('../workspaceManager', () => ({
    loadWorkspaceData: async () => disk,
    updateWorkspaceData: async (_id: string, patch: (s: WorkspaceState) => WorkspaceState) => {
        if (!disk) return null;
        const next = patch(disk);
        writes++; // the real updateWorkspaceData always writes, even an unchanged state
        disk = next;
        return next;
    },
}));

import {
    EMPTY_MACHINE, TZ_OPTIONS, ensureDataUtcOffset, fmtOffset, isDuplicatePlantMachine, isValidUtcOffset, machineOf,
    machineOfOldProject, missingMachineFields, pcOffsetMin, projectDescription, projectDisplayName, saveProjectDetails,
} from '../utils/projectDetails';

const M = { plant: ' Bang Pakong ', name: 'Gas Engine 4 ', tag: ' U-2010', notes: '' };

beforeEach(() => {
    mockEmit.mockClear();
    writes = 0;
    disk = { id: 'ws1', name: 'Old name', description: 'old', failureGroupState: { groups: [], models: [] } } as unknown as WorkspaceState;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('names derived from the machine', () => {
    it('projectDisplayName = "Plant · Machine", parts trimmed, empty parts left out', () => {
        expect(projectDisplayName(M)).toBe('Bang Pakong · Gas Engine 4');
        expect(projectDisplayName({ ...M, name: '  ' })).toBe('Bang Pakong');
        expect(projectDisplayName(null)).toBe('');
    });
    it('projectDescription = "tag · notes"', () => {
        expect(projectDescription(M)).toBe('U-2010');
        expect(projectDescription({ ...M, notes: ' 2 MW ' })).toBe('U-2010 · 2 MW');
        expect(projectDescription(undefined)).toBe('');
    });
});

describe('isDuplicatePlantMachine', () => {
    const existing = [{ id: 'a', name: 'Bang Pakong · Gas Engine 4' }, { id: 'b', name: 'Other' }];
    it('matches the display name case-insensitively', () => {
        expect(isDuplicatePlantMachine({ ...M, plant: 'bang pakong', name: 'GAS ENGINE 4' }, existing)).toBe(true);
    });
    it('the project itself is excluded', () => {
        expect(isDuplicatePlantMachine(M, existing, 'a')).toBe(false);
    });
    it('an incomplete pair is never a duplicate', () => {
        expect(isDuplicatePlantMachine({ ...M, name: '' }, [{ id: 'x', name: 'Bang Pakong' }])).toBe(false);
    });
    it('a different pair is not', () => {
        expect(isDuplicatePlantMachine({ ...M, name: 'Gas Engine 5' }, existing)).toBe(false);
    });
});

describe('machine helpers', () => {
    it('missingMachineFields lists the empty required fields in order', () => {
        expect(missingMachineFields(EMPTY_MACHINE)).toEqual(['Plant name', 'Machine name', 'Machine tag']);
        expect(missingMachineFields(null)).toEqual(['Plant name', 'Machine name', 'Machine tag']);
        expect(missingMachineFields({ ...M, tag: ' ' })).toEqual(['Machine tag']);
        expect(missingMachineFields(M)).toEqual([]);
    });
    it('machineOfOldProject: Plant = the old name, the rest empty; machineOf falls back to it', () => {
        expect(machineOfOldProject('Line 3')).toEqual({ plant: 'Line 3', name: '', tag: '', notes: '' });
        expect(machineOf({ name: 'Line 3' })).toEqual(machineOfOldProject('Line 3'));
        expect(machineOf({ name: 'x', machine: M })).toBe(M);
    });
});

describe('time zone', () => {
    it('fmtOffset', () => {
        expect(fmtOffset(420)).toBe('+07:00');
        expect(fmtOffset(0)).toBe('+00:00');
        expect(fmtOffset(-210)).toBe('-03:30');
        expect(fmtOffset(345)).toBe('+05:45');
        expect(fmtOffset(-720)).toBe('-12:00');
        expect(fmtOffset(840)).toBe('+14:00');
    });
    it('pcOffsetMin is minutes EAST of UTC (the sign of getTimezoneOffset flipped), never -0', () => {
        vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-420);
        expect(pcOffsetMin()).toBe(420);
        vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(0);
        expect(Object.is(pcOffsetMin(), 0)).toBe(true);
    });
    it('TZ_OPTIONS: every half hour from -12:00 to +14:00 plus the 45-minute offsets, ascending, unique', () => {
        expect(TZ_OPTIONS[0]).toBe(-720);
        expect(TZ_OPTIONS[TZ_OPTIONS.length - 1]).toBe(840);
        for (const m of [345, 525, 765, 825, 420, 330, -210, 0]) expect(TZ_OPTIONS).toContain(m);
        expect([...TZ_OPTIONS].sort((a, b) => a - b)).toEqual([...TZ_OPTIONS]);
        expect(new Set(TZ_OPTIONS).size).toBe(TZ_OPTIONS.length);
        expect(TZ_OPTIONS.length).toBe(53 + 4);
        expect(TZ_OPTIONS.every(isValidUtcOffset)).toBe(true);
    });
    it('isValidUtcOffset', () => {
        expect(isValidUtcOffset(-721)).toBe(false);
        expect(isValidUtcOffset(841)).toBe(false);
        expect(isValidUtcOffset(1.5)).toBe(false);
        expect(isValidUtcOffset('420')).toBe(false);
    });
});

describe('saveProjectDetails (the one writer)', () => {
    it('ONE write of name, description, machine (trimmed) and offset; every other field kept; then one broadcast with the workspaceId', async () => {
        const res = await saveProjectDetails('ws1', { machine: { ...M, notes: ' 2 MW ' }, dataUtcOffsetMin: 420 });
        expect(writes).toBe(1);
        expect(disk).toMatchObject({
            id: 'ws1',
            name: 'Bang Pakong · Gas Engine 4',
            description: 'U-2010 · 2 MW',
            machine: { plant: 'Bang Pakong', name: 'Gas Engine 4', tag: 'U-2010', notes: '2 MW' },
            dataUtcOffsetMin: 420,
            failureGroupState: { groups: [], models: [] },
        });
        const payload = { workspaceId: 'ws1', name: 'Bang Pakong · Gas Engine 4', description: 'U-2010 · 2 MW' };
        expect(res).toEqual(payload);
        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockEmit).toHaveBeenCalledWith(PROJECT_DETAILS_CHANGED, payload);
        expect(PROJECT_DETAILS_CHANGED).toBe('project-details-changed');
    });

    it('an empty description is stored as absent', async () => {
        await saveProjectDetails('ws1', { machine: { ...M, tag: '' }, dataUtcOffsetMin: 0 });
        expect(disk!.description).toBeUndefined();
    });

    it('an unreadable workspace writes and emits nothing', async () => {
        disk = null;
        expect(await saveProjectDetails('ws1', { machine: M, dataUtcOffsetMin: 0 })).toBeNull();
        expect(mockEmit).not.toHaveBeenCalled();
    });

    it('a failed broadcast does not fail the save', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockEmit.mockRejectedValueOnce(new Error('no other window'));
        expect(await saveProjectDetails('ws1', { machine: M, dataUtcOffsetMin: 60 })).not.toBeNull();
        expect(disk!.dataUtcOffsetMin).toBe(60);
    });
});

describe('ensureDataUtcOffset', () => {
    it('writes the PC offset once when the project has none', async () => {
        vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-420);
        expect(await ensureDataUtcOffset('ws1')).toBe(420);
        expect(disk!.dataUtcOffsetMin).toBe(420);
        expect(writes).toBe(1);
        // second call: already set — no write at all
        expect(await ensureDataUtcOffset('ws1')).toBe(420);
        expect(writes).toBe(1);
    });

    it('never overwrites an offset the project already has (0 included)', async () => {
        disk = { ...disk!, dataUtcOffsetMin: 0 };
        expect(await ensureDataUtcOffset('ws1')).toBe(0);
        expect(writes).toBe(0);
    });

    it('an unreadable project gives null and writes nothing', async () => {
        disk = null;
        expect(await ensureDataUtcOffset('ws1')).toBeNull();
        expect(writes).toBe(0);
    });
});
