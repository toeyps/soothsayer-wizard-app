import { describe, it, expect } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, HealthSetPoints } from '../types';
import type { HealthPreview, ModelFilesResult } from '../types/health';
import {
    HEALTH_DEFAULT_MAX_POINTS,
    buildHealthPreviewRequest,
    buildModelFilesRequest,
    CLUSTERS_NEED_CRITERIA,
    healthInputsMissing,
    healthRequestKey,
    healthSetPointsToWire,
    relationshipCacheKey,
    relationshipLambda,
    testPeriodsWireFor,
} from '../utils/healthRequest';
import { toScoringPeriods } from '../utils/timePeriods';
import { createFakeHealthRust, plantDataset } from './helpers/fakeHealthRust';
import { LEGACY_TESTS } from './helpers/trainTestFixture';
import { buildPreviewFilterPayload, trainingScopeFilter } from '../utils/trainingScope';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

const fg = (over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({
    groups: [], models: [],
    runningConditionFilters: [], runningConditionCombine: 'and',
    runningConditionTimePeriods: [], runningConditionNoneConfirmed: true,
    ...over,
});
const HEADERS = ['T', 'P1', 'P2', 'X', 'Y', 'C', 'SPEED'];
const speedOver = (v: string) => ({ id: 'f1', sensor: 'SPEED', operation: 'greater_than' as const, value1: v, value2: '' });

const indSp: HealthSetPoints = { kind: 'individual', lower: 1, upper: 9, masterLower: 2, masterUpper: 8 };
const relSp: HealthSetPoints = { kind: 'relationship', residualAt80Lower: -3, residualAt80Upper: 3, residualAt0Lower: -6, residualAt0Upper: 6 };
const cluSp: HealthSetPoints = { kind: 'clustering', outerSd: 5 };

describe('healthSetPointsToWire (camelCase model fields -> snake_case wire)', () => {
    it('maps each kind to its own snake_case keys and drops the master snapshot / kind', () => {
        expect(healthSetPointsToWire('individual', indSp)).toEqual({ lower: 1, upper: 9 });
        expect(healthSetPointsToWire('relationship', relSp)).toEqual({
            residual_at_80_lower: -3, residual_at_80_upper: 3, residual_at_0_lower: -6, residual_at_0_upper: 6,
        });
        expect(healthSetPointsToWire('clustering', cluSp)).toEqual({ outer_sd: 5 });
    });

    it('keeps null ("not entered") as null so Rust reports the field as required', () => {
        expect(healthSetPointsToWire('clustering', { kind: 'clustering', outerSd: null })).toEqual({ outer_sd: null });
        expect(healthSetPointsToWire('individual', { kind: 'individual', lower: null, upper: 4 })).toEqual({ lower: null, upper: 4 });
    });

    it('gives {} for a missing or wrong-kind value', () => {
        expect(healthSetPointsToWire('individual', undefined)).toEqual({});
        expect(healthSetPointsToWire('individual', null)).toEqual({});
        expect(healthSetPointsToWire('individual', relSp)).toEqual({});
    });
});

describe('buildPreviewFilterPayload / trainingScopeFilter (extracted from BuildModelWindow, behaviour unchanged)', () => {
    it('is null with no condition and no period', () => {
        expect(buildPreviewFilterPayload({ filters: [], combine: 'and', noneConfirmed: true, periods: [] }, HEADERS)).toBeNull();
    });

    it('sends complete conditions with parsed numbers, the combine mode and the periods', () => {
        const out = buildPreviewFilterPayload({
            filters: [speedOver('1200')], combine: 'or', noneConfirmed: false,
            periods: [{ id: 'p', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }],
        }, HEADERS);
        expect(out).toEqual({
            timestamp_ranges: [{ start: '2026-01-01T00:00', end: '2026-02-01T00:00' }],
            value_filters: [{ sensor: 'SPEED', operation: 'greater_than', value1: 1200, value2: null }],
            combine: 'or',
        });
    });

    it('drops incomplete rows and rows on sensors that are not in the dataset', () => {
        const out = buildPreviewFilterPayload({
            filters: [speedOver(''), { ...speedOver('5'), id: 'g', sensor: 'NOPE' }], combine: 'and', noneConfirmed: false, periods: [],
        }, HEADERS);
        expect(out).toBeNull();
    });

    it('"No condition" sends no value filters even when rows exist', () => {
        expect(buildPreviewFilterPayload({ filters: [speedOver('5')], combine: 'and', noneConfirmed: true, periods: [] }, HEADERS)).toBeNull();
    });

    it('a fully open period means "no time limit"', () => {
        expect(buildPreviewFilterPayload({ filters: [], combine: 'and', noneConfirmed: true, periods: [{ id: 'p', start: '', end: '' }] }, HEADERS)).toBeNull();
    });

    it('trainingScopeFilter follows the Workspace condition in workspace mode and the model\'s own in custom mode', () => {
        const slice = fg({ runningConditionNoneConfirmed: false, runningConditionFilters: [speedOver('100')] });
        const wsModel = mk({ id: 'a', targetSensor: 'T' });
        const customModel = mk({
            id: 'b', targetSensor: 'T', runningConditionMode: 'custom',
            customRunningConditionFilters: [speedOver('999')], customRunningConditionCombine: 'or',
        });
        expect(trainingScopeFilter(wsModel, slice, HEADERS)!.value_filters[0].value1).toBe(100);
        const custom = trainingScopeFilter(customModel, slice, HEADERS)!;
        expect(custom.value_filters[0].value1).toBe(999);
        expect(custom.combine).toBe('or');
    });
});

describe('buildHealthPreviewRequest', () => {
    it('Individual: target, snake_case set points, default max_points, the training scope, no optional keys', () => {
        const model = mk({ id: 'i1', kind: 'individual', targetSensor: 'T' });
        const req = buildHealthPreviewRequest({
            model, fg: fg({ runningConditionNoneConfirmed: false, runningConditionFilters: [speedOver('1200')] }),
            headers: HEADERS, setPoints: indSp,
        });
        expect(req).toEqual({
            kind: 'individual', target: 'T',
            filter: { timestamp_ranges: [], value_filters: [{ sensor: 'SPEED', operation: 'greater_than', value1: 1200, value2: null }], combine: 'and' },
            set_points: { lower: 1, upper: 9 },
            max_points: HEALTH_DEFAULT_MAX_POINTS,
        });
        expect(Object.keys(req!)).not.toContain('include_out_of_scope');
        expect(Object.keys(req!)).not.toContain('expected_generation');
    });

    it('passes max_points, scatter cap, include_out_of_scope and expected_generation through when given', () => {
        const model = mk({ id: 'i1', targetSensor: 'T' });
        const req = buildHealthPreviewRequest({
            model, fg: fg(), headers: HEADERS, setPoints: indSp,
            maxPoints: 20000, maxScatterPoints: 5000, includeOutOfScope: true, expectedGeneration: 7,
        })!;
        expect(req).toMatchObject({ max_points: 20000, max_scatter_points: 5000, include_out_of_scope: true, expected_generation: 7, filter: null });
    });

    it('no set points entered -> an empty set_points object (Rust answers "required")', () => {
        const req = buildHealthPreviewRequest({ model: mk({ id: 'i', targetSensor: 'T' }), fg: fg(), headers: HEADERS })!;
        expect(req.set_points).toEqual({});
    });

    it('Relationship: predictors, x_predictor, set points and a cache_key built from the train fingerprint', () => {
        const model = mk({ id: 'r1', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P1', 'P2'], relStiffness: 100_000 });
        const slice = fg();
        const req = buildHealthPreviewRequest({ model, fg: slice, headers: HEADERS, setPoints: relSp, xPredictor: 'P2' })!;
        expect(req).toMatchObject({
            kind: 'relationship', target: 'T', predictors: ['P1', 'P2'], x_predictor: 'P2',
            set_points: { residual_at_80_lower: -3, residual_at_80_upper: 3, residual_at_0_lower: -6, residual_at_0_upper: 6 },
        });
        expect(req.cache_key).toBe(`r1::${computeTrainFingerprint(model, slice)}`);
        expect(req.cache_key).toBe(relationshipCacheKey(model, slice));
    });

    describe('Relationship cache_key changes whenever the fit would (Rust ignores `filter` for the cached fit)', () => {
        const base = () => mk({ id: 'r1', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P1'], relStiffness: 100_000 });
        const key = (m = base(), slice = fg()) =>
            buildHealthPreviewRequest({ model: m, fg: slice, headers: HEADERS, setPoints: relSp })!.cache_key;

        it('changes with the workspace running condition (workspace-mode model)', () => {
            expect(key(base(), fg({ runningConditionNoneConfirmed: false, runningConditionFilters: [speedOver('1')] })))
                .not.toBe(key());
            expect(key(base(), fg({ runningConditionTimePeriods: [{ id: 'p', start: '2026-01-01T00:00', end: '' }] })))
                .not.toBe(key());
            expect(key(base(), fg({ runningConditionCombine: 'or' }))).not.toBe(key());
        });

        it('changes with the model\'s own scope in custom mode, but NOT with the workspace one', () => {
            const custom = { ...base(), runningConditionMode: 'custom' as const, customRunningConditionNoneConfirmed: true };
            const k0 = key(custom);
            expect(key({ ...custom, filterTimePeriods: [{ id: 'p', start: '2026-03-01T00:00', end: '2026-04-01T00:00' }] })).not.toBe(k0);
            expect(key(custom, fg({ runningConditionNoneConfirmed: false, runningConditionFilters: [speedOver('1')] }))).toBe(k0);
        });

        it('changes with predictors, target and stiffness; not with predictor order, name, notes, category, status or set points', () => {
            const k0 = key();
            expect(key({ ...base(), predictorSensors: ['P1', 'P2'] })).not.toBe(k0);
            expect(key({ ...base(), targetSensor: 'X' })).not.toBe(k0);
            expect(key({ ...base(), relStiffness: 1_000_000 })).not.toBe(k0);
            expect(key({ ...base(), name: 'Renamed', notes: 'n', category: 'condition', status: true })).toBe(k0);
            const two = { ...base(), predictorSensors: ['P1', 'P2'] };
            expect(key({ ...two, predictorSensors: ['P2', 'P1'] })).toBe(key(two));
            const other: HealthSetPoints = { ...relSp, residualAt0Lower: -99 };
            expect(buildHealthPreviewRequest({ model: base(), fg: fg(), headers: HEADERS, setPoints: other })!.cache_key).toBe(k0);
        });

        it('includes the model id, so two models with identical settings never share a fit', () => {
            expect(key({ ...base(), id: 'r2' })).not.toBe(key());
        });
    });

    it('Clustering: sensors, cluster count, criteria and ranges sliced to the count (same as Train)', () => {
        const model = mk({
            id: 'c1', kind: 'clustering', xSensor: 'X', ySensor: 'Y', numClusters: 2, criteriaSensor: 'C',
            clusterRanges: [{ min: 0, max: 5 }, { min: 5, max: null }, { min: 9, max: 10 }],
        });
        const req = buildHealthPreviewRequest({ model, fg: fg(), headers: HEADERS, setPoints: cluSp })!;
        expect(req).toMatchObject({
            kind: 'clustering', first_sensor: 'X', second_sensor: 'Y', n_clusters: 2, criteria_sensor: 'C',
            cluster_ranges: [{ min: 0, max: 5 }, { min: 5, max: null }], set_points: { outer_sd: 5 },
        });
        expect(Object.keys(req)).not.toContain('cache_key');
        expect(Object.keys(req)).not.toContain('target');
    });

    it('Clustering without a criteria sensor sends null criteria and null ranges', () => {
        const model = mk({ id: 'c1', kind: 'clustering', xSensor: 'X', ySensor: 'Y', numClusters: 1, criteriaSensor: '   ', clusterRanges: [{ min: 0, max: 1 }] });
        expect(buildHealthPreviewRequest({ model, fg: fg(), headers: HEADERS })).toMatchObject({ criteria_sensor: null, cluster_ranges: null });
    });

    it('returns null (no request) while a required sensor is missing', () => {
        expect(buildHealthPreviewRequest({ model: mk({ id: 'a', kind: 'individual', targetSensor: '' }), fg: fg(), headers: HEADERS })).toBeNull();
        expect(buildHealthPreviewRequest({ model: mk({ id: 'a', kind: 'relationship', targetSensor: 'T', predictorSensors: [] }), fg: fg(), headers: HEADERS })).toBeNull();
        expect(buildHealthPreviewRequest({ model: mk({ id: 'a', kind: 'clustering', xSensor: 'X', ySensor: '' }), fg: fg(), headers: HEADERS })).toBeNull();
        expect(healthInputsMissing(mk({ id: 'a', kind: 'clustering', xSensor: '', ySensor: 'Y' }))).toMatch(/X sensor/);
    });

    // Mirrors Rust's "criteria_sensor is required when n_clusters > 1".
    it('Clustering with 2+ clusters and no criteria sensor is missing an input (no request); 1 cluster or a criteria sensor is fine', () => {
        const base = { id: 'c', kind: 'clustering' as const, xSensor: 'X', ySensor: 'Y' };
        expect(healthInputsMissing(mk({ ...base, numClusters: 2, criteriaSensor: '' }))).toBe(CLUSTERS_NEED_CRITERIA);
        expect(healthInputsMissing(mk({ ...base, numClusters: 3, criteriaSensor: '  ' }))).toBe(CLUSTERS_NEED_CRITERIA);
        expect(buildHealthPreviewRequest({ model: mk({ ...base, numClusters: 2, criteriaSensor: '' }), fg: fg(), headers: HEADERS })).toBeNull();
        expect(healthInputsMissing(mk({ ...base, numClusters: 1, criteriaSensor: '' }))).toBeNull();
        expect(healthInputsMissing(mk({ ...base, numClusters: 2, criteriaSensor: 'C', clusterRanges: [{ min: 0, max: 1 }, { min: 1, max: 2 }] }))).toBeNull();
    });

    it('healthRequestKey is stable for equal requests and differs when a set point changes', () => {
        const model = mk({ id: 'i1', targetSensor: 'T' });
        const a = buildHealthPreviewRequest({ model, fg: fg(), headers: HEADERS, setPoints: indSp });
        const b = buildHealthPreviewRequest({ model, fg: fg(), headers: HEADERS, setPoints: { ...indSp } });
        const c = buildHealthPreviewRequest({ model, fg: fg(), headers: HEADERS, setPoints: { ...indSp, lower: 0 } });
        expect(healthRequestKey(a)).toBe(healthRequestKey(b));
        expect(healthRequestKey(a)).not.toBe(healthRequestKey(c));
        expect(healthRequestKey(null)).toBeNull();
    });
});

describe('buildModelFilesRequest', () => {
    it('Individual: workspace id, model name, target, scope and set points', () => {
        const model = mk({ id: 'i1', name: 'Pump A', kind: 'individual', targetSensor: 'T' });
        expect(buildModelFilesRequest({ model, fg: fg(), headers: HEADERS, workspaceId: 'ws9', setPoints: indSp })).toEqual({
            kind: 'individual', workspace_id: 'ws9', model_name: 'Pump A', target: 'T', filter: null, set_points: { lower: 1, upper: 9 },
        });
    });

    it('Relationship: lambda = the stiffness the Workbench sends, and the SAME cache_key as the preview', () => {
        const model = mk({ id: 'r1', name: 'Rel', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P1'], relStiffness: 10_000 });
        const slice = fg({ runningConditionNoneConfirmed: false, runningConditionFilters: [speedOver('3')] });
        const files = buildModelFilesRequest({ model, fg: slice, headers: HEADERS, workspaceId: 'ws9', setPoints: relSp, expectedGeneration: 4 })!;
        const preview = buildHealthPreviewRequest({ model, fg: slice, headers: HEADERS, setPoints: relSp })!;
        expect(files).toMatchObject({ kind: 'relationship', model_name: 'Rel', target: 'T', predictors: ['P1'], lambda: 10_000, expected_generation: 4 });
        expect(files.cache_key).toBe(preview.cache_key);
        expect(files.filter).toEqual(preview.filter);
    });

    it('relationshipLambda uses relStiffness as is, falling back to Standard only when it is missing', () => {
        expect(relationshipLambda(mk({ id: 'a', relStiffness: 1_000 }))).toBe(1_000);
        expect(relationshipLambda(mk({ id: 'a', relStiffness: 5 }))).toBe(5);
        expect(relationshipLambda({ ...mk({ id: 'a' }), relStiffness: undefined as unknown as number })).toBe(100_000);
    });

    it('Clustering: sensors, count, criteria and ranges, no cache_key / lambda', () => {
        const model = mk({ id: 'c1', name: 'Clu', kind: 'clustering', xSensor: 'X', ySensor: 'Y', numClusters: 1, criteriaSensor: '', clusterRanges: [] });
        const req = buildModelFilesRequest({ model, fg: fg(), headers: HEADERS, workspaceId: 'ws9', setPoints: cluSp })!;
        expect(req).toMatchObject({ kind: 'clustering', model_name: 'Clu', first_sensor: 'X', second_sensor: 'Y', n_clusters: 1, criteria_sensor: null, set_points: { outer_sd: 5 } });
        expect(Object.keys(req)).not.toContain('lambda');
        expect(Object.keys(req)).not.toContain('cache_key');
    });

    it('null while a required sensor is missing', () => {
        expect(buildModelFilesRequest({ model: mk({ id: 'a', kind: 'relationship', targetSensor: 'T' }), fg: fg(), headers: HEADERS, workspaceId: 'w' })).toBeNull();
    });
});

describe('test_periods — scoring periods are sent as start / end only ("just score it", 2026-10-10)', () => {
    // The workspace list as a workspace saved BEFORE holds it: the removed
    // label / event time / highlight caption are still on the periods. None of it may be sent.
    const wsTests = [
        { id: 'w1', start: '2026-01-01T00:00', end: '2026-01-31T23:59', label: 'normal' as const },
        { id: 'w2', start: '2026-03-01T00:00', end: '2026-03-31T23:59', label: 'problem' as const, eventTime: '2026-03-15T08:00', fromHighlight: 'Bearing' },
    ];
    const own = [{ id: 'c1', start: '2026-05-01T00:00', end: '2026-05-31T23:59' }];
    const ind = mk({ id: 'i', kind: 'individual', targetSensor: 'T' });
    const rel = mk({ id: 'r', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P1'], relStiffness: 100_000 });
    const WIRE = [
        { start: '2026-01-01T00:00', end: '2026-01-31T23:59' },
        { start: '2026-03-01T00:00', end: '2026-03-31T23:59' },
    ];

    it('Workspace mode: the preview AND the export carry the workspace list — start / end only, no ids, no label, no event time', () => {
        const f = fg({ runningConditionTestPeriods: wsTests });
        const preview = buildHealthPreviewRequest({ model: ind, fg: f, headers: HEADERS })!;
        const files = buildModelFilesRequest({ model: ind, fg: f, headers: HEADERS, workspaceId: 'ws' })!;
        expect(preview.test_periods).toEqual(WIRE);
        expect(files.test_periods).toEqual(WIRE);
        for (const req of [preview, files]) {
            for (const item of req.test_periods!) expect(Object.keys(item).sort()).toEqual(['end', 'start']);
            expect(JSON.stringify(req)).not.toMatch(/label|event_time|eventTime|fromHighlight|normal|problem|Bearing/);
        }
    });

    it('testPeriodsWireFor (also the `test_periods` argument of preview_relationship_model): the same start / end list, undefined when there is none', () => {
        expect(testPeriodsWireFor(rel, fg({ runningConditionTestPeriods: wsTests }))).toEqual(WIRE);
        expect(testPeriodsWireFor(rel, fg())).toBeUndefined();
        // every period invalid -> nothing to send
        expect(testPeriodsWireFor(rel, fg({ runningConditionTestPeriods: [{ id: 'x', start: '2026-02-01T00:00', end: '' }] }))).toBeUndefined();
    });

    it('Custom mode: the model own customTestPeriods, never the workspace list', () => {
        const custom = { ...ind, runningConditionMode: 'custom' as const, customTestPeriods: own };
        const f = fg({ runningConditionTestPeriods: wsTests });
        const wire = [{ start: '2026-05-01T00:00', end: '2026-05-31T23:59' }];
        expect(buildHealthPreviewRequest({ model: custom, fg: f, headers: HEADERS })!.test_periods).toEqual(wire);
        expect(buildModelFilesRequest({ model: custom, fg: f, headers: HEADERS, workspaceId: 'ws' })!.test_periods).toEqual(wire);
        // A Custom model without its own list sends none (the key is omitted).
        expect(buildHealthPreviewRequest({ model: { ...ind, runningConditionMode: 'custom' }, fg: f, headers: HEADERS })).not.toHaveProperty('test_periods');
    });

    it('no scoring periods -> the key is omitted (old workspaces send exactly what they sent before)', () => {
        expect(buildHealthPreviewRequest({ model: ind, fg: fg(), headers: HEADERS })).not.toHaveProperty('test_periods');
        expect(buildModelFilesRequest({ model: ind, fg: fg(), headers: HEADERS, workspaceId: 'ws' })).not.toHaveProperty('test_periods');
    });

    it('changing ONLY the scoring periods keeps the Relationship cache_key (re-score, no re-train) but changes the request key', () => {
        const a = buildHealthPreviewRequest({ model: rel, fg: fg(), headers: HEADERS })!;
        const b = buildHealthPreviewRequest({ model: rel, fg: fg({ runningConditionTestPeriods: wsTests }), headers: HEADERS })!;
        expect(b.cache_key).toBe(a.cache_key);
        expect(healthRequestKey(b)).not.toBe(healthRequestKey(a));
    });

    it('an old-shaped list and the same list without the legacy keys build the IDENTICAL request (no extra preview call, same key)', () => {
        const oldReq = buildHealthPreviewRequest({ model: rel, fg: fg({ runningConditionTestPeriods: wsTests }), headers: HEADERS })!;
        const newReq = buildHealthPreviewRequest({ model: rel, fg: fg({ runningConditionTestPeriods: toScoringPeriods(wsTests) }), headers: HEADERS })!;
        expect(healthRequestKey(newReq)).toBe(healthRequestKey(oldReq));
    });
});

// End to end against the fake Rust backend (a port of the real contract): a workspace
// saved before — scoring periods still carrying label / eventTime — is scored.
describe('an old workspace is scored like a new one (request -> fake Rust)', () => {
    const data = plantDataset();
    const model = mk({ id: 'i', kind: 'individual', targetSensor: 'TAG1', category: 'condition' });
    const oldFg = fg({ runningConditionTimePeriods: [{ id: 'all', start: '', end: '' }], runningConditionTestPeriods: LEGACY_TESTS });
    const setPoints: HealthSetPoints = { kind: 'individual', lower: 20, upper: 80 };
    const request = () => buildHealthPreviewRequest({ model, fg: oldFg, headers: data.headers, setPoints })!;

    it('the preview request is accepted and returns a valid, scored preview', async () => {
        const rust = createFakeHealthRust({ datasets: { plant: data } });
        const req = request();
        expect(req.test_periods).toEqual([
            { start: '2024-01-01T00:00', end: '2024-01-31T23:59' },
            { start: '2024-03-01T00:00', end: '2024-03-31T23:59' },
        ]);
        const res = await rust.invoke('compute_health_preview', { request: req }) as HealthPreview;
        expect(res.valid).toBe(true);
        expect(res.validation).toEqual([]);
        expect(res.score_summary).not.toBeNull();
        expect(res.score_summary!.scored).toBeGreaterThan(0);
    });

    it('the export request is accepted too (Mark complete writes the files)', async () => {
        const rust = createFakeHealthRust({ datasets: { plant: data } });
        const req = buildModelFilesRequest({ model, fg: oldFg, headers: data.headers, workspaceId: 'ws-old', setPoints })!;
        const res = await rust.invoke('export_model_files', { request: req }) as ModelFilesResult;
        expect(res.ok).toBe(true);
        expect(res.files.length).toBeGreaterThan(0);
    });

    it('guard: the fake REJECTS a scoring period that still carries a label / event time (stricter than Rust, so a stale caller fails its test)', async () => {
        const rust = createFakeHealthRust({ datasets: { plant: data } });
        const legacyItem = { start: '2024-01-01T00:00', end: '2024-01-31T23:59', label: 'problem', event_time: '2024-01-20T08:00' };
        await expect(rust.invoke('compute_health_preview', { request: { ...request(), test_periods: [legacyItem] } }))
            .rejects.toMatch(/compute_health_preview: test_periods\[0\] carries 'label', 'event_time'/);
        await expect(rust.invoke('export_model_files', { request: { ...buildModelFilesRequest({ model, fg: oldFg, headers: data.headers, workspaceId: 'ws-old', setPoints })!, test_periods: [{ start: null, end: null }, legacyItem] } }))
            .rejects.toMatch(/export_model_files: test_periods\[1\] carries/);
        await expect(rust.invoke('preview_relationship_model', { predictors: ['TAG3'], target: 'TAG1', lambda: 1, test_periods: [{ start: '2024-01-01T00:00', end: '2024-01-31T23:59', label: 'normal' }] }))
            .rejects.toMatch(/preview_relationship_model: test_periods\[0\] carries 'label'/);
        // the new shape passes
        await expect(rust.invoke('preview_relationship_model', { predictors: ['TAG3'], target: 'TAG1', lambda: 1, test_periods: [{ start: '2024-01-01T00:00', end: '2024-01-31T23:59' }] })).resolves.toBeTruthy();
    });

    // Real Rust deserialises `test_periods` as `Vec<TestPeriodArg>`: an item that is not a
    // struct (null, a string, a number) makes serde refuse the whole call. The fake used to let
    // a `null` item through as "no extra keys".
    it('guard: the fake REJECTS a list item that is not a period object (null / string / number / list), on all three commands', async () => {
        const rust = createFakeHealthRust({ datasets: { plant: data } });
        const good = { start: '2024-01-01T00:00', end: '2024-01-31T23:59' };
        await expect(rust.invoke('compute_health_preview', { request: { ...request(), test_periods: [null] } }))
            .rejects.toMatch(/compute_health_preview: test_periods\[0\] is null/);
        await expect(rust.invoke('export_model_files', { request: { ...buildModelFilesRequest({ model, fg: oldFg, headers: data.headers, workspaceId: 'ws-old', setPoints })!, test_periods: [good, null] } }))
            .rejects.toMatch(/export_model_files: test_periods\[1\] is null/);
        await expect(rust.invoke('preview_relationship_model', { predictors: ['TAG3'], target: 'TAG1', lambda: 1, test_periods: [good, '2024-03-01T00:00'] }))
            .rejects.toMatch(/preview_relationship_model: test_periods\[1\] is a string/);
        await expect(rust.invoke('compute_health_preview', { request: { ...request(), test_periods: [7] } }))
            .rejects.toMatch(/test_periods\[0\] is a number/);
        await expect(rust.invoke('compute_health_preview', { request: { ...request(), test_periods: [[good.start, good.end]] } }))
            .rejects.toMatch(/test_periods\[0\] is a list/);
        // `null` / absent as the LIST itself is still "no scoring periods", and open bounds are still fine
        await expect(rust.invoke('compute_health_preview', { request: { ...request(), test_periods: null } })).resolves.toBeTruthy();
        await expect(rust.invoke('compute_health_preview', { request: { ...request(), test_periods: [{ start: null, end: null }] } })).resolves.toBeTruthy();
    });
});
