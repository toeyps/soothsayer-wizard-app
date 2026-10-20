import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));

import {
    asciiFolderPart, cancelWorkspaceExport, exportFolderName, exportStamp, exportWorkspaceResults, parseExportError,
    planWorkspaceExport, revealExportFolder,
} from '../utils/workspaceExport';
import type { WorkspaceExportRequest } from '../types/export';
import { WORKSPACE_EXPORT_PROGRESS } from '../types/export';

const REQ: WorkspaceExportRequest = {
    workspace_id: 'ws1',
    expected_generation: 3,
    data_utc_offset_min: 420,
    machine: { plant: 'P', name: 'M', tag: 'U-1', notes: '' },
    running_status: { sensor: 'SPEED', stop_if_lower_than: 1200 },
    sensor_meta: [{ tag: 'T', name: 'Temp', unit: 'C', component: 'Engine' }],
    derived_sensors: [],
    failure_groups: [{ no: 1, name: 'FG', description: 'd', recommendation: 'r' }],
    models: [{
        id: 'i1', kind: 'individual', display_name: 'Temp band', category: 'condition', group_nos: [1],
        target: 'T', filter: null, set_points: { lower: 1, upper: 9 }, training_note: 'All rows',
    }],
};

beforeEach(() => { mockInvoke.mockReset(); });

describe('bindings: command names and EXACT snake_case keys', () => {
    it('plan_workspace_export { request }', async () => {
        mockInvoke.mockResolvedValue({ ok: true });
        await expect(planWorkspaceExport(REQ)).resolves.toEqual({ ok: true });
        expect(mockInvoke).toHaveBeenCalledWith('plan_workspace_export', { request: REQ });
        expect(Object.keys(mockInvoke.mock.calls[0][1])).toEqual(['request']);
    });
    it('export_workspace_results { request, dest_dir, folder_name, export_id }', async () => {
        const result = { folder: 'D:/out/X_2026', files: 3, models: 1, rows: 10, bytes: 100, exported_at: 'x', warnings: [] };
        mockInvoke.mockResolvedValue(result);
        await expect(exportWorkspaceResults(REQ, 'D:/out', 'X_2026-10-20_1430', 'exp-1')).resolves.toBe(result);
        expect(mockInvoke).toHaveBeenCalledWith('export_workspace_results', {
            request: REQ, dest_dir: 'D:/out', folder_name: 'X_2026-10-20_1430', export_id: 'exp-1',
        });
        expect(Object.keys(mockInvoke.mock.calls[0][1]).sort()).toEqual(['dest_dir', 'export_id', 'folder_name', 'request']);
    });
    it('cancel_workspace_export { export_id } -> boolean', async () => {
        mockInvoke.mockResolvedValue(true);
        await expect(cancelWorkspaceExport('exp-1')).resolves.toBe(true);
        expect(mockInvoke).toHaveBeenCalledWith('cancel_workspace_export', { export_id: 'exp-1' });
    });
    it('reveal_export_folder { path } -> void', async () => {
        mockInvoke.mockResolvedValue(null);
        await expect(revealExportFolder('D:/out/X')).resolves.toBeUndefined();
        expect(mockInvoke).toHaveBeenCalledWith('reveal_export_folder', { path: 'D:/out/X' });
    });
    it('a rejection reaches the caller unchanged (to be parsed)', async () => {
        mockInvoke.mockRejectedValue('NOT_READY: 2 problem(s)');
        await expect(exportWorkspaceResults(REQ, 'D:/out', 'X', 'e')).rejects.toBe('NOT_READY: 2 problem(s)');
    });
    it('the progress event name', () => {
        expect(WORKSPACE_EXPORT_PROGRESS).toBe('workspace-export-progress');
    });
});

describe('parseExportError', () => {
    it('every known prefix', () => {
        expect(parseExportError('NO_DATA: no dataset loaded')).toEqual({ code: 'NO_DATA', message: 'no dataset loaded' });
        expect(parseExportError('STALE_SESSION: the data changed')).toEqual({ code: 'STALE_SESSION', message: 'the data changed' });
        expect(parseExportError('BAD_REQUEST: export already running')).toEqual({ code: 'BAD_REQUEST', message: 'export already running' });
        expect(parseExportError('CANCELLED: by the user')).toEqual({ code: 'CANCELLED', message: 'by the user' });
        expect(parseExportError('WRITE_FAILED: T-I1.csv (Access is denied. (os error 5))'))
            .toEqual({ code: 'WRITE_FAILED', message: 'T-I1.csv (Access is denied. (os error 5))' });
    });
    it('NOT_READY carries the number of problems', () => {
        expect(parseExportError('NOT_READY: 3 problem(s)')).toEqual({ code: 'NOT_READY', message: '3 problem(s)', problems: 3 });
    });
    it('an Error object, an unknown prefix, and nothing at all', () => {
        expect(parseExportError(new Error('CANCELLED: stop'))).toEqual({ code: 'CANCELLED', message: 'stop' });
        expect(parseExportError('NOT_FITTED: x')).toEqual({ code: null, message: 'NOT_FITTED: x' });
        expect(parseExportError('disk on fire')).toEqual({ code: null, message: 'disk on fire' });
        expect(parseExportError(undefined)).toEqual({ code: null, message: '' });
    });
    it('a prefix with no text keeps the whole string as the message', () => {
        expect(parseExportError('CANCELLED:')).toEqual({ code: 'CANCELLED', message: 'CANCELLED:' });
    });
});

describe('exportFolderName', () => {
    const D = new Date(2026, 9, 5, 9, 7); // local 2026-10-05 09:07
    // Rust's rule for folder_name
    const RUST_RULE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

    it('ASCII of the project name + _YYYY-MM-DD_HHMM (local time, zero-padded)', () => {
        expect(exportStamp(D)).toBe('_2026-10-05_0907');
        expect(exportFolderName('Bang Pakong · Gas Engine 4', 'U-2010', D)).toBe('Bang_Pakong_Gas_Engine_4_2026-10-05_0907');
    });
    it('accents are dropped, not the letter', () => {
        expect(exportFolderName('Usine Électrique · Café', 't', D)).toBe('Usine_Electrique_Cafe_2026-10-05_0907');
    });
    it('a Thai-only name falls back to the sanitized machine tag', () => {
        expect(exportFolderName('โรงไฟฟ้า · เครื่องที่', 'U 20/10', D)).toBe('U_20_10_2026-10-05_0907');
    });
    it('a Thai name with ASCII parts keeps the ASCII parts', () => {
        expect(exportFolderName('โรงไฟฟ้า · GEG 4', 'U-1', D)).toBe('GEG_4_2026-10-05_0907');
    });
    it('no usable name nor tag -> "Workspace"', () => {
        expect(exportFolderName('ทดสอบ', 'ทดสอบ', D)).toBe('Workspace_2026-10-05_0907');
        expect(exportFolderName('', '', D)).toBe('Workspace_2026-10-05_0907');
        expect(exportFolderName('···', '-._', D)).toBe('Workspace_2026-10-05_0907');
    });
    it('always passes the Rust folder-name rule: starts with a letter/digit, at most 120 chars, never ends with "."', () => {
        for (const name of ['.hidden', '_x_', 'a'.repeat(300), 'x.'.repeat(80), '  spaced  out  ', 'Plant · M (Copy)', '../../etc']) {
            const f = exportFolderName(name, 'T', D);
            expect(f, name).toMatch(RUST_RULE);
            expect(f.endsWith('.')).toBe(false);
            expect(f.endsWith('_2026-10-05_0907')).toBe(true);
        }
        expect(exportFolderName('../../etc', 'T', D)).toBe('etc_2026-10-05_0907');
    });
    it('asciiFolderPart', () => {
        expect(asciiFolderPart('Plant · M (Copy)')).toBe('Plant_M_Copy');
        expect(asciiFolderPart('ไทย')).toBe('');
        expect(asciiFolderPart('a.b-c_d')).toBe('a.b-c_d');
    });
});
