import { describe, it, expect, vi, afterEach } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, SensorMetadata, SpecialSensorRecipe, WorkspaceState } from '../types';
import {
    buildWorkspaceExportRequest, exportReadiness, exportRunOrder, modelExportTags, trainingNote, type ExportReadinessItem,
} from '../utils/exportReadiness';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { trainingScopeFilter } from '../utils/trainingScope';
import { healthSetPointsToWire } from '../utils/healthRequest';

afterEach(() => { vi.restoreAllMocks(); });

const HEADERS = ['T1', 'T2', 'P1', 'P2', 'X', 'Y', 'C', 'SPEED', 'V', 'I', 'POWER'];
const META: SensorMetadata[] = [
    { tag: 'T1', description: 'Bearing temp', unit: 'C', component: 'Engine' },
    { tag: 'T2', description: 'Oil temp', unit: 'C', component: 'Engine' },
    { tag: 'P1', description: 'Load', unit: '%', component: 'Generator' },
    { tag: 'P2', description: '', unit: '', component: '' },
    { tag: 'X', description: 'X', unit: '', component: 'Pump' },
    { tag: 'Y', description: 'Y', unit: '', component: 'Pump' },
    { tag: 'C', description: 'Criteria', unit: '', component: 'Pump' },
    { tag: 'SPEED', description: 'Speed', unit: 'rpm', component: '' },
    { tag: 'V', description: 'Volt', unit: 'V', component: 'Electrical' },
    { tag: 'I', description: 'Amp', unit: 'A', component: 'Electrical' },
];
const RECIPES: SpecialSensorRecipe[] = [{ kind: 'formula', tag: 'POWER', formula: '$V * $I' }];

const baseFg = (models: FailureModel[], over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({
    groups: [
        { no: 0, name: 'Not in group' },
        { no: 1, name: 'Overheat', description: 'Too hot', recommendation: 'Cool it' },
        { no: 2, name: 'Unused', description: '', recommendation: '' },
    ],
    models,
    runningConditionFilters: [{ id: 'f1', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' }],
    runningConditionCombine: 'and',
    runningConditionTimePeriods: [{ id: 'p1', start: '2025-01-01T00:00', end: '2025-06-30T23:59' }],
    runningConditionTestPeriods: [{ id: 't1', start: '2025-07-01T00:00', end: '2025-07-31T23:59' }],
    rcLegacyNotice: null,
    ...over,
});

/** A model trained against `fg` (fresh), optionally Complete. */
function trained(m: FailureModel, fgForPrint: FailureGroupStateSlice, complete = true): FailureModel {
    return { ...m, status: complete, lastTrainedAt: '2026-10-01T00:00:00Z', trainedFingerprint: computeTrainFingerprint(m, fgForPrint) };
}

const MACHINE = { plant: 'Bang Pakong', name: 'GEG 4', tag: 'U-2010', notes: '' };
const ws = (fg: FailureGroupStateSlice, over: Partial<WorkspaceState> = {}): WorkspaceState =>
    ({ id: 'ws1', name: 'Bang Pakong · GEG 4', machine: MACHINE, dataUtcOffsetMin: 420, failureGroupState: fg, specialSensorRecipes: RECIPES, ...over } as unknown as WorkspaceState);

/** A workspace whose models are all Complete and fresh. */
function readyWorkspace(extra: (fg: FailureGroupStateSlice) => FailureModel[] = () => []): WorkspaceState {
    const fg = baseFg([]);
    const raw = [
        mk({ id: 'i1', name: 'Bearing band', kind: 'individual', targetSensor: 'T1', category: 'condition', healthSetPoints: { kind: 'individual', lower: 1, upper: 9 } }),
        mk({ id: 'r1', name: 'Bearing vs load', kind: 'relationship', targetSensor: 'T1', predictorSensors: ['P1'], relStiffness: 100000, category: 'condition' }),
    ];
    fg.models = [...raw.map(m => trained(m, fg)), ...extra(fg)];
    return ws(fg);
}

const itemOf = <K extends ExportReadinessItem['id']>(items: ExportReadinessItem[], id: K) =>
    items.find(i => i.id === id) as Extract<ExportReadinessItem, { id: K }>;

describe('exportRunOrder / modelExportTags', () => {
    it('sensors in first-seen order, per sensor Individual, Relation model, Clustering; unique by id', () => {
        const a = mk({ id: 'r', kind: 'relationship', targetSensor: 'T1' });
        const b = mk({ id: 'c', kind: 'clustering', xSensor: 'X' });
        const c = mk({ id: 'i', kind: 'individual', targetSensor: 't1 ' });
        expect(exportRunOrder([a, b, c, a]).map(m => m.id)).toEqual(['i', 'r', 'c']);
    });
    it('a caller order wins; the rest follow in run order', () => {
        const a = mk({ id: 'a', targetSensor: 'T1' });
        const b = mk({ id: 'b', targetSensor: 'T2' });
        const c = mk({ id: 'c', targetSensor: 'X' });
        expect(exportRunOrder([a, b, c], ['c', 'zz', 'a', 'c']).map(m => m.id)).toEqual(['c', 'a', 'b']);
    });
    it('the CSV columns of each kind', () => {
        expect(modelExportTags(mk({ id: 'r', kind: 'relationship', targetSensor: 'T1', predictorSensors: ['P1', 'P2'] }))).toEqual(['P1', 'P2', 'T1']);
        expect(modelExportTags(mk({ id: 'i', targetSensor: 'T1' }))).toEqual(['T1']);
        expect(modelExportTags(mk({ id: 'c', kind: 'clustering', xSensor: 'X', ySensor: 'Y', numClusters: 2, criteriaSensor: 'C' }))).toEqual(['X', 'Y', 'C']);
        expect(modelExportTags(mk({ id: 'c', kind: 'clustering', xSensor: 'X', ySensor: 'Y', numClusters: 2, criteriaSensor: 'X' }))).toEqual(['X', 'Y']);
        expect(modelExportTags(mk({ id: 'c', kind: 'clustering', xSensor: 'X', ySensor: 'Y', numClusters: 1, criteriaSensor: 'C' }))).toEqual(['X', 'Y']);
    });
});

describe('trainingNote', () => {
    it('workspace mode: condition, train periods, missing values', () => {
        const m = mk({ id: 'i', targetSensor: 'T1' });
        expect(trainingNote(m, baseFg([m]))).toBe('Running only: SPEED > 1200; train periods 2025-01-01 00:00 to 2025-06-30 23:59; rows with a missing value removed');
    });
    it('custom mode with OR, between and open ends', () => {
        const m = mk({
            id: 'i', targetSensor: 'T1', runningConditionMode: 'custom', customRunningConditionCombine: 'or',
            customRunningConditionFilters: [
                { id: 'a', sensor: 'SPEED', operation: 'between', value1: '1', value2: '5' },
                { id: 'b', sensor: 'P1', operation: 'less_than', value1: '3', value2: '' },
                { id: 'c', sensor: '', operation: 'equals', value1: '3', value2: '' },
            ],
            filterTimePeriods: [{ id: 'p', start: '', end: '' }],
        });
        expect(trainingNote(m, baseFg([m]))).toBe('Running only: SPEED between 1 and 5 OR P1 < 3; train periods start of data to end of data; own condition of this model; rows with a missing value removed');
    });
    it('Use all rows', () => {
        const m = mk({ id: 'i', targetSensor: 'T1' });
        expect(trainingNote(m, baseFg([m], { runningConditionNoneConfirmed: true, runningConditionTimePeriods: [] })))
            .toBe('All rows (no running condition); rows with a missing value removed');
    });
});

describe('exportReadiness: model reasons', () => {
    it('everything Complete + every item fine -> all ready', () => {
        const r = exportReadiness({ workspace: readyWorkspace(), metadata: META, headers: HEADERS });
        expect(r.rows.map(x => [x.id, x.reason, x.ready, x.tone])).toEqual([['i1', 'complete', true, 'complete'], ['r1', 'complete', true, 'complete']]);
        expect(r.counts).toEqual({ total: 2, ready: 2, notReady: 0, toFix: 0, allReady: true });
    });

    it('every reason, in its precedence', () => {
        const w = readyWorkspace(fg => [
            trained(mk({ id: 'twin', name: 'bearing BAND ', targetSensor: 'X', category: 'condition' }), fg),
            trained(mk({ id: 'nocat', targetSensor: 'Y' }), fg),
            trained(mk({ id: 'lf', targetSensor: 'C', category: 'performance' }), fg),
            trained(mk({ id: 'nd', targetSensor: 'P2', category: 'performance' }), fg),
            mk({ id: 'cat0', targetSensor: 'V', status: false }),
            mk({ id: 'blk', targetSensor: 'I', category: 'condition', runningConditionMode: 'custom' }),
            { ...trained(mk({ id: 'stale', targetSensor: 'T2', category: 'condition' }), fg, false), trainedFingerprint: 'old' },
            trained(mk({ id: 'tr', targetSensor: 'SPEED', category: 'condition' }), fg, false),
            mk({ id: 'nt', targetSensor: 'POWER', category: 'condition' }),
        ]);
        const r = exportReadiness({
            workspace: w, metadata: META, headers: HEADERS, noData: ['nd'], loadFailed: new Set(['lf']),
            order: ['i1', 'twin', 'nocat', 'lf', 'nd', 'cat0', 'blk', 'stale', 'tr', 'nt', 'r1'],
        });
        const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
        expect(by.i1.reason).toBe('name-twin'); // its twin also blocks it
        expect(by.twin).toMatchObject({ reason: 'name-twin', ready: false, twinId: 'i1', words: 'Name also used by the Individual model of Bearing temp · T1 — rename one' });
        expect(by.nocat).toMatchObject({ reason: 'complete-no-category', words: 'Complete · category not set (Performance or Condition, in the sensor header)' });
        expect(by.lf).toMatchObject({ reason: 'load-failed', tone: 'bad' });
        expect(by.nd).toMatchObject({ reason: 'no-data', tone: 'bad', words: 'No data for this model in the loaded file' });
        expect(by.cat0.reason).toBe('category-missing');
        expect(by.blk.reason).toBe('blocked');
        expect(by.blk.words).toMatch(/running condition/i);
        expect(by.stale).toMatchObject({ reason: 'stale', words: 'Settings changed — re-train' });
        expect(by.tr).toMatchObject({ reason: 'trained', words: 'Trained · Mark complete is next', tone: 'need' });
        expect(by.nt).toMatchObject({ reason: 'not-trained', tone: 'none' });
        expect(by.r1.reason).toBe('complete');
        expect(r.rows.map(x => x.id)).toEqual(['i1', 'twin', 'nocat', 'lf', 'nd', 'cat0', 'blk', 'stale', 'tr', 'nt', 'r1']);
        expect(r.counts.ready).toBe(1);
        expect(r.counts.allReady).toBe(false);
    });

    it('a model in no group shows group [0]; the sensor-wide category counts', () => {
        const fg = baseFg([]);
        const a = trained(mk({ id: 'a', targetSensor: 'T1', category: 'condition', groupNos: [] }), fg);
        const b = trained(mk({ id: 'b', kind: 'relationship', targetSensor: 'T1', predictorSensors: ['P1'], category: null, relStiffness: 100000 }), fg);
        fg.models = [a, b];
        const r = exportReadiness({ workspace: ws(fg), metadata: META, headers: HEADERS });
        expect(r.rows[0].groupNos).toEqual([0]);
        expect(r.rows[1].reason).toBe('complete');
    });

    it('no models: nothing is ready', () => {
        const r = exportReadiness({ workspace: ws(baseFg([])), metadata: META, headers: HEADERS });
        expect(r.counts).toMatchObject({ total: 0, allReady: false });
    });
});

describe('exportReadiness: items', () => {
    it('machine: complete / missing fields / legacy project', () => {
        const ok = itemOf(exportReadiness({ workspace: readyWorkspace(), metadata: META, headers: HEADERS }).items, 'machine');
        expect(ok).toMatchObject({ ok: true, blocking: false, missing: [], legacy: false });
        const w = { ...readyWorkspace(), machine: { ...MACHINE, tag: ' ' } } as WorkspaceState;
        const r = exportReadiness({ workspace: w, metadata: META, headers: HEADERS });
        expect(itemOf(r.items, 'machine')).toMatchObject({ ok: false, blocking: true, missing: ['Machine tag'] });
        expect(r.counts.toFix).toBe(1);
        expect(r.counts.allReady).toBe(false);
        const legacy = { ...readyWorkspace(), machine: undefined, name: 'Old project' } as WorkspaceState;
        expect(itemOf(exportReadiness({ workspace: legacy, metadata: META, headers: HEADERS }).items, 'machine'))
            .toMatchObject({ ok: false, legacy: true, machine: { plant: 'Old project', name: '', tag: '', notes: '' }, missing: ['Machine name', 'Machine tag'] });
    });

    it('time zone: saved, or the PC offset assumed', () => {
        vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-420);
        expect(itemOf(exportReadiness({ workspace: readyWorkspace(), metadata: META, headers: HEADERS }).items, 'tz'))
            .toMatchObject({ ok: true, offsetMin: 420, isPcOffset: true, saved: true });
        const w = { ...readyWorkspace(), dataUtcOffsetMin: undefined } as WorkspaceState;
        expect(itemOf(exportReadiness({ workspace: w, metadata: META, headers: HEADERS }).items, 'tz'))
            .toMatchObject({ ok: true, offsetMin: 420, saved: false });
        const w2 = { ...readyWorkspace(), dataUtcOffsetMin: 0 } as WorkspaceState;
        expect(itemOf(exportReadiness({ workspace: w2, metadata: META, headers: HEADERS }).items, 'tz')).toMatchObject({ offsetMin: 0, isPcOffset: false });
    });

    it('running status: the one running condition, or blocking when it is not set', () => {
        expect(itemOf(exportReadiness({ workspace: readyWorkspace(), metadata: META, headers: HEADERS }).items, 'running'))
            .toMatchObject({ ok: true, status: { sensor: 'SPEED', value: 1200 } });
        const w = readyWorkspace();
        w.failureGroupState!.runningConditionFilters = [];
        // An old export-only line no longer stands in for it.
        w.failureGroupState!.runningStatus = { sensor: 'SPEED', stopAtOrBelow: '5' };
        const r = exportReadiness({ workspace: w, metadata: META, headers: HEADERS });
        expect(itemOf(r.items, 'running')).toMatchObject({ ok: false, blocking: true, status: null });
    });

    it('machine_info.running_status is the one condition: sensor + stop_if_lower_than = its value', () => {
        const w = readyWorkspace();
        w.failureGroupState!.runningConditionFilters = [{ id: 'one', sensor: 'SPEED', operation: 'greater_than', value1: ' 850.5 ', value2: '' }];
        w.failureGroupState!.runningStatus = { sensor: 'P1', stopAtOrBelow: '3' };
        const req = buildWorkspaceExportRequest({ workspace: w, metadata: META, headers: HEADERS });
        expect(req.running_status).toEqual({ sensor: 'SPEED', stop_if_lower_than: 850.5 });
    });

    it('sensors: counts raw/special and the ones without a component (info only); the running sensor is flagged', () => {
        const w = readyWorkspace(fg => [trained(mk({ id: 'p', kind: 'relationship', name: 'Power', targetSensor: 'POWER', predictorSensors: ['P2'], category: 'performance', relStiffness: 100000 }), fg)]);
        const r = exportReadiness({ workspace: w, metadata: META, headers: HEADERS });
        const s = itemOf(r.items, 'sensors');
        // used: T1, P1, P2, POWER, SPEED -> raw T1 P1 P2 SPEED V I ; special POWER
        expect(s).toMatchObject({ ok: true, rawCount: 6, specialCount: 1, noComponentCount: 3, blocking: false });
        expect(s.info).toBe(true);
        expect(r.noComponent).toEqual([
            { tag: 'P2', special: false, modelIds: ['p'], runningStatus: false },
            { tag: 'POWER', special: true, modelIds: ['p'], runningStatus: false },
            { tag: 'SPEED', special: false, modelIds: [], runningStatus: true },
        ]);
        expect(r.counts.toFix).toBe(0); // never blocks
        const d = itemOf(r.items, 'derived');
        expect(d).toMatchObject({ ok: true, info: true, blocking: false, sensors: [{ tag: 'POWER', howToBuild: 'Calculated as V × I', sourceTags: ['V', 'I'] }] });
    });

    it('a special sensor component from the workspace special-sensor metadata', () => {
        const w = readyWorkspace(fg => [trained(mk({ id: 'p', name: 'Power', targetSensor: 'POWER', category: 'performance' }), fg)]);
        w.extraSensorMetadata = [{ tag: 'POWER', description: 'Power', unit: 'kW', component: 'Electrical' }];
        const r = exportReadiness({ workspace: w, metadata: META, headers: HEADERS });
        expect(r.noComponent.map(n => n.tag)).toEqual(['SPEED']);
    });

    it('no derived item when no special sensor is used', () => {
        expect(exportReadiness({ workspace: readyWorkspace(), metadata: META, headers: HEADERS }).items.map(i => i.id))
            .toEqual(['machine', 'tz', 'running', 'sensors', 'fg']);
    });

    it('failure groups: only USED groups count; one without a text blocks', () => {
        const ok = itemOf(exportReadiness({ workspace: readyWorkspace(), metadata: META, headers: HEADERS }).items, 'fg');
        expect(ok).toMatchObject({ ok: true, usedCount: 1, missing: [] }); // FG-2 is empty but unused
        const w = readyWorkspace();
        w.failureGroupState!.groups[1] = { no: 1, name: 'Overheat', description: 'x', recommendation: ' ' };
        const r = exportReadiness({ workspace: w, metadata: META, headers: HEADERS });
        expect(itemOf(r.items, 'fg')).toMatchObject({ ok: false, blocking: true, missing: [{ no: 1, name: 'Overheat', description: false, recommendation: true }] });
        expect(r.counts.toFix).toBe(1);
    });
});

describe('buildWorkspaceExportRequest', () => {
    it('models deduped, in run order, with the SAME scope Train uses, set points, notes and kind fields', () => {
        const fg = baseFg([]);
        const custom = mk({
            id: 'c1', kind: 'clustering', name: 'Pump', xSensor: 'X', ySensor: 'Y', numClusters: 2, criteriaSensor: 'C', category: 'condition',
            clusterRanges: [{ min: null, max: 5 }, { min: 5, max: null }, { min: 9, max: 10 }],
            runningConditionMode: 'custom', customRunningConditionFilters: [{ id: 'q', sensor: 'P1', operation: 'less_than', value1: '50', value2: '' }],
            customRunningConditionNoneConfirmed: false, filterTimePeriods: [{ id: 'cp', start: '2025-02-01T00:00', end: '' }],
            healthSetPoints: { kind: 'clustering', outerSd: 4 },
        });
        const rel = mk({ id: 'r1', kind: 'relationship', name: 'Rel', targetSensor: 'T1', predictorSensors: ['P1', 'P2'], relStiffness: 1000, category: null, groupNos: [0, 1] });
        const ind = mk({ id: 'i1', name: 'Ind', targetSensor: 'T1', category: 'performance', healthSetPoints: { kind: 'individual', lower: 1, upper: 9 } });
        fg.models = [custom, rel, ind, rel];
        const req = buildWorkspaceExportRequest({ workspace: ws(fg), metadata: META, headers: HEADERS, expectedGeneration: 7 });
        expect(req.models.map(m => m.id)).toEqual(['c1', 'i1', 'r1']);
        expect(req.expected_generation).toBe(7);
        const [c, i, r] = req.models;
        expect(c.filter).toEqual(trainingScopeFilter(custom, fg, HEADERS));
        expect(i.filter).toEqual(trainingScopeFilter(ind, fg, HEADERS));
        expect(c.filter).not.toEqual(i.filter); // Custom vs Workspace really differ
        expect(c).toMatchObject({
            kind: 'clustering', x_sensor: 'X', y_sensor: 'Y', n_clusters: 2, criteria_sensor: 'C',
            cluster_ranges: [{ min: null, max: 5 }, { min: 5, max: null }], set_points: { outer_sd: 4 }, category: 'condition',
            training_note: 'Running only: P1 < 50; train periods 2025-02-01 00:00 to end of data; own condition of this model; rows with a missing value removed',
        });
        expect(i).toMatchObject({ kind: 'individual', target: 'T1', set_points: healthSetPointsToWire('individual', ind.healthSetPoints), category: 'performance' });
        expect(i).not.toHaveProperty('x_sensor');
        // category from the sensor (T1's Individual), group 0 dropped, lambda
        expect(r).toMatchObject({ kind: 'relationship', target: 'T1', predictors: ['P1', 'P2'], rel_stiffness: 1000, category: 'performance', group_nos: [1], set_points: {} });
    });

    it('machine, offset (PC fallback), running status, failure groups (real only)', () => {
        vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-330);
        const w = { ...readyWorkspace(), dataUtcOffsetMin: undefined } as WorkspaceState;
        const req = buildWorkspaceExportRequest({ workspace: w, metadata: META, headers: HEADERS });
        expect(req.workspace_id).toBe('ws1');
        expect(req.data_utc_offset_min).toBe(330);
        expect(req).not.toHaveProperty('expected_generation');
        expect(req.machine).toEqual(MACHINE);
        expect(req.running_status).toEqual({ sensor: 'SPEED', stop_if_lower_than: 1200 });
        expect(req.failure_groups.map(g => g.no)).toEqual([1, 2]);
        expect(req.failure_groups[0]).toEqual({ no: 1, name: 'Overheat', description: 'Too hot', recommendation: 'Cool it' });
        expect(buildWorkspaceExportRequest({ workspace: readyWorkspace(), metadata: META, headers: HEADERS }).data_utc_offset_min).toBe(420);
    });

    it('sensor_meta: every used tag + running sensor + raw sources of special sensors; derived_sensors with how to build', () => {
        const w = readyWorkspace(fg => [trained(mk({ id: 'p', name: 'Power', targetSensor: 'POWER', category: 'performance' }), fg)]);
        const req = buildWorkspaceExportRequest({ workspace: w, metadata: META, headers: HEADERS });
        expect(req.sensor_meta.map(s => s.tag)).toEqual(['T1', 'P1', 'POWER', 'SPEED', 'V', 'I']);
        expect(req.sensor_meta[0]).toEqual({ tag: 'T1', name: 'Bearing temp', unit: 'C', component: 'Engine' });
        expect(req.sensor_meta.find(s => s.tag === 'POWER')).toEqual({ tag: 'POWER', name: '', unit: '', component: '' });
        expect(req.derived_sensors).toEqual([{ tag: 'POWER', how_to_build: 'Calculated as V × I', source_tags: ['V', 'I'] }]);
    });

    it('a legacy project without machine details sends Plant = its name', () => {
        const w = { ...readyWorkspace(), machine: undefined, name: 'Old' } as WorkspaceState;
        expect(buildWorkspaceExportRequest({ workspace: w, metadata: META, headers: HEADERS }).machine).toEqual({ plant: 'Old', name: '', tag: '', notes: '' });
    });
});
