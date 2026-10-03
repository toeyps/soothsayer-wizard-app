import { describe, it, expect } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, HealthSetPoints } from '../types';
import {
    HEALTH_DEFAULT_MAX_POINTS,
    buildHealthPreviewRequest,
    buildModelFilesRequest,
    healthInputsMissing,
    healthRequestKey,
    healthSetPointsToWire,
    relationshipCacheKey,
    relationshipLambda,
} from '../utils/healthRequest';
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
