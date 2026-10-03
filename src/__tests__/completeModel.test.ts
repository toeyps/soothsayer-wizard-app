import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, HealthSetPoints } from '../types';
import type { HealthPreview, ModelFilesResult } from '../types/health';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { completeModel, getModelOutputDir, parseHealthError } from '../utils/completeModel';

const fg: FailureGroupStateSlice = {
    groups: [], models: [],
    runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: [], runningConditionNoneConfirmed: true,
};
const HEADERS = ['T', 'P1'];
const sp: HealthSetPoints = { kind: 'individual', lower: 1, upper: 9 };
const model = mk({ id: 'i1', name: 'Pump', kind: 'individual', targetSensor: 'T' });

const previewOk = { kind: 'individual', valid: true, validation: [] } as unknown as HealthPreview;
const issue = { code: 'lower_inside_3sd', severity: 'error' as const, message: 'L must be below -3SD', field: 'lower' };
const previewBad = { kind: 'individual', valid: false, validation: [issue] } as unknown as HealthPreview;
const filesOk: ModelFilesResult = {
    ok: true, output_dir: 'C:/data/workspaces/ws1/output', validation: [], warnings: ['w'],
    files: [{ kind: 'info', file_name: 'INDV_INFO_T.json', path: 'C:/data/workspaces/ws1/output/T/INDV_INFO_T.json' }],
};

const run = (m: FailureModel = model, setPoints: HealthSetPoints = sp) =>
    completeModel({ model: m, fg, headers: HEADERS, workspaceId: 'ws1', setPoints, expectedGeneration: 2 });

const calls = (cmd: string) => mockInvoke.mock.calls.filter(c => c[0] === cmd);

beforeEach(() => { mockInvoke.mockReset(); });

describe('completeModel', () => {
    it('valid set points: previews, then exports, then returns the validated set points + files for the caller to persist', async () => {
        mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'compute_health_preview' ? previewOk : filesOk));
        const res = await run();
        expect(res).toEqual({
            ok: true, setPoints: sp, files: filesOk.files, outputDir: filesOk.output_dir, warnings: ['w'],
        });
        expect(mockInvoke.mock.calls.map(c => c[0])).toEqual(['compute_health_preview', 'export_model_files']);
        // Both calls carry { request } and the same set points / scope / generation.
        const [, previewArgs] = mockInvoke.mock.calls[0];
        const [, exportArgs] = mockInvoke.mock.calls[1];
        expect(previewArgs.request).toMatchObject({ kind: 'individual', target: 'T', set_points: { lower: 1, upper: 9 }, expected_generation: 2 });
        expect(exportArgs.request).toEqual({
            kind: 'individual', workspace_id: 'ws1', model_name: 'Pump', target: 'T', filter: null,
            set_points: { lower: 1, upper: 9 }, expected_generation: 2,
        });
    });

    it('invalid set points: refuses with the issues and makes NO export call', async () => {
        mockInvoke.mockResolvedValue(previewBad);
        const res = await run();
        expect(res).toEqual({ ok: false, reason: 'validation', issues: [issue], code: null, error: null });
        expect(calls('export_model_files')).toHaveLength(0);
    });

    it('export that fails (hard error): stays incomplete, typed result, code parsed', async () => {
        mockInvoke.mockImplementation(async (cmd: string) => {
            if (cmd === 'compute_health_preview') return previewOk;
            throw 'STALE_SESSION: the dataset was reloaded';
        });
        const res = await run();
        expect(res).toMatchObject({ ok: false, reason: 'error', code: 'STALE_SESSION', error: 'the dataset was reloaded' });
    });

    it('export that fails with an unprefixed error (sidecar / disk): code is null, message kept', async () => {
        mockInvoke.mockImplementation(async (cmd: string) => {
            if (cmd === 'compute_health_preview') return previewOk;
            throw new Error('sidecar crashed');
        });
        expect(await run()).toMatchObject({ ok: false, reason: 'error', code: null, error: 'sidecar crashed' });
    });

    it('export that comes back ok:false (Rust re-validated and refused): validation result with ITS issues, nothing persisted', async () => {
        mockInvoke.mockImplementation(async (cmd: string) =>
            cmd === 'compute_health_preview' ? previewOk : { ok: false, files: [], output_dir: 'x', validation: [issue], warnings: [] });
        expect(await run()).toMatchObject({ ok: false, reason: 'validation', issues: [issue] });
    });

    it('preview error (Relationship NOT_FITTED): typed error, no export call', async () => {
        const rel = mk({ id: 'r1', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P1'], relStiffness: 100_000 });
        mockInvoke.mockRejectedValue('NOT_FITTED: no fit in memory');
        const res = await run(rel, { kind: 'relationship', residualAt80Lower: -1, residualAt80Upper: 1, residualAt0Lower: -2, residualAt0Upper: 2 });
        expect(res).toMatchObject({ ok: false, reason: 'error', code: 'NOT_FITTED' });
        expect(calls('export_model_files')).toHaveLength(0);
    });

    it('a model missing a required sensor never reaches Rust', async () => {
        const res = await run(mk({ id: 'x', kind: 'individual', targetSensor: '' }));
        expect(res).toMatchObject({ ok: false, reason: 'inputs' });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('Relationship export carries lambda and the same cache_key as the preview', async () => {
        const rel = mk({ id: 'r1', name: 'Rel', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P1'], relStiffness: 10_000 });
        mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'compute_health_preview' ? { ...previewOk, kind: 'relationship' } : filesOk));
        await run(rel, { kind: 'relationship', residualAt80Lower: -1, residualAt80Upper: 1, residualAt0Lower: -2, residualAt0Upper: 2 });
        const p = calls('compute_health_preview')[0][1].request;
        const e = calls('export_model_files')[0][1].request;
        expect(e.lambda).toBe(10_000);
        expect(e.cache_key).toBe(p.cache_key);
        expect(e.set_points).toEqual({ residual_at_80_lower: -1, residual_at_80_upper: 1, residual_at_0_lower: -2, residual_at_0_upper: 2 });
    });
});

describe('parseHealthError', () => {
    it('splits a known prefix from the message', () => {
        expect(parseHealthError('NOT_FITTED: train first')).toEqual({ code: 'NOT_FITTED', message: 'train first' });
        expect(parseHealthError(new Error('NO_DATA: nothing in scope'))).toEqual({ code: 'NO_DATA', message: 'nothing in scope' });
        expect(parseHealthError('VALIDATION: a; b')).toEqual({ code: 'VALIDATION', message: 'a; b' });
    });
    it('leaves unknown prefixes and plain text alone', () => {
        expect(parseHealthError('SOMETHING_ELSE: x')).toEqual({ code: null, message: 'SOMETHING_ELSE: x' });
        expect(parseHealthError('plain')).toEqual({ code: null, message: 'plain' });
        expect(parseHealthError(undefined)).toEqual({ code: null, message: '' });
    });
});

describe('export error prefixes (QA/coordinator 2026-10-04)', () => {
    for (const [text, code, msg] of [
        ['NOT_FITTED: the cache key belongs to another model', 'NOT_FITTED', 'the cache key belongs to another model'],
        ['STALE_SESSION: dataset reloaded', 'STALE_SESSION', 'dataset reloaded'],
        ['BAD_REQUEST: Sensor not found: T', 'BAD_REQUEST', 'Sensor not found: T'],
        ['NO_DATA: no rows in scope', 'NO_DATA', 'no rows in scope'],
    ] as const) {
        it(`${code} from export_model_files is a typed, coded error (nothing persisted)`, async () => {
            mockInvoke.mockImplementation(async (cmd: string) => {
                if (cmd === 'compute_health_preview') return previewOk;
                throw text;
            });
            expect(await run()).toMatchObject({ ok: false, reason: 'error', code, error: msg });
        });
    }

    it('a warning-only validation list on a valid preview does not stop the export', async () => {
        const warn = { code: 'unsafe_file_name', severity: 'warning', message: 'm', field: 'name' };
        mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'compute_health_preview' ? { ...previewOk, valid: true, validation: [warn] } : filesOk));
        expect(await run()).toMatchObject({ ok: true });
    });
});

describe('getModelOutputDir', () => {
    it('calls get_model_output_dir with the snake_case workspace_id key', async () => {
        mockInvoke.mockResolvedValue('C:/data/workspaces/ws1/output');
        expect(await getModelOutputDir('ws1')).toBe('C:/data/workspaces/ws1/output');
        expect(mockInvoke).toHaveBeenCalledWith('get_model_output_dir', { workspace_id: 'ws1' });
    });
});
