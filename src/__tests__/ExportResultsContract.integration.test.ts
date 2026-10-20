import { describe, it, expect } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, SensorMetadata, SpecialSensorRecipe, WorkspaceState } from '../types';
import { buildWorkspaceExportRequest, exportReadiness } from '../utils/exportReadiness';
import { buildPreviewFilterPayload } from '../utils/trainingScope';
import { effectiveRunningCondition } from '../utils/runningCondition';
import { buildHealthPreviewRequest } from '../utils/healthRequest';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { applyIncompleteRule } from '../utils/incompleteRule';
import { withFailureGroupState } from '../utils/failureGroupState';

/*
 * QA cross-zone test (Export results, 2026-10-20).
 *
 * The TS half of the export request contract: the request the Build Model
 * window sends (`buildWorkspaceExportRequest`, fe-logic) for a realistic
 * project is pinned in `src-tauri/tests/fixtures/export_request_contract.json`.
 * The Rust half (`src-tauri/tests/internal/qa_workspace_export_internal.rs`)
 * deserializes THE SAME file, loads a CSV through the real loader, exports it
 * through `workspace_export::write_export` and checks every spec §7 item on
 * disk. So a field renamed on either side, or a TS request Rust would refuse,
 * fails one of the two tests.
 *
 * Regenerate the fixture after a deliberate wire change (a vitest file
 * snapshot):
 *   npx vitest run src/__tests__/ExportResultsContract.integration.test.ts -u
 * then re-run `cargo test qa_workspace_export` in src-tauri.
 */

const FIXTURE = '../../src-tauri/tests/fixtures/export_request_contract.json';

/** Columns of the CSV the Rust half writes (after `timestamp`). */
const HEADERS = ['SPEED', 'T1', 'P1', 'V', 'I', 'POWER', 'X', 'Y', 'C'];
const META: SensorMetadata[] = [
    { tag: 'SPEED', description: 'Speed', unit: 'rpm', component: 'Engine' },
    { tag: 'T1', description: 'Bearing temp', unit: 'DegC', component: 'Engine' },
    { tag: 'P1', description: 'Load', unit: '%', component: 'Generator' },
    { tag: 'V', description: 'Volt', unit: 'V', component: 'Electrical' },
    { tag: 'I', description: 'Amp', unit: 'A', component: 'Electrical' },
    { tag: 'X', description: 'Flow', unit: 'm3/h', component: 'Pump' },
    { tag: 'Y', description: 'Head', unit: 'm', component: 'Pump' },
    { tag: 'C', description: 'Valve', unit: '%', component: 'Pump' },
];
const RECIPES: SpecialSensorRecipe[] = [{ kind: 'formula', tag: 'POWER', formula: '$V * $I' }];

function project(): WorkspaceState {
    const fg: FailureGroupStateSlice = {
        groups: [
            { no: 0, name: 'Not in group' },
            { no: 1, name: 'Overheat', description: 'Bearing runs hot.', recommendation: 'Check the lube oil.' },
            { no: 2, name: 'Pump wear', description: 'Pump curve drifts.', recommendation: 'Inspect the impeller.' },
            { no: 3, name: 'Unused', description: '', recommendation: '' },
        ],
        models: [],
        runningConditionFilters: [{ id: 'f1', sensor: 'SPEED', operation: 'greater_than', value1: '100', value2: '' }],
        runningConditionCombine: 'and',
        runningConditionTimePeriods: [{ id: 'p1', start: '2024-01-09T22:00', end: '2024-01-10T23:59' }],
        runningConditionTestPeriods: [{ id: 't1', start: '2024-01-10T00:00', end: '2024-01-10T23:59' }],
        runningConditionNoneConfirmed: false,
        rcLegacyNotice: null,
    } as FailureGroupStateSlice;
    const raw: FailureModel[] = [
        mk({ id: 'i1', name: 'Bearing band', kind: 'individual', targetSensor: 'T1', category: 'condition', groupNos: [1],
            healthSetPoints: { kind: 'individual', lower: 20, upper: 35 } as FailureModel['healthSetPoints'] }),
        mk({ id: 'r1', name: 'Bearing vs load', kind: 'relationship', targetSensor: 'T1', predictorSensors: ['P1', 'POWER'],
            relStiffness: 100000, category: 'condition', groupNos: [1, 2],
            runningConditionMode: 'custom', customRunningConditionCombine: 'or', customRunningConditionNoneConfirmed: false,
            customRunningConditionFilters: [
                { id: 'q1', sensor: 'P1', operation: 'less_than', value1: '50', value2: '' },
                { id: 'q2', sensor: 'SPEED', operation: 'greater_than', value1: '1000', value2: '' },
            ],
            filterTimePeriods: [{ id: 'cp', start: '2024-01-09T22:30', end: '' }],
            healthSetPoints: { kind: 'relationship', residualAt80Lower: -4, residualAt80Upper: 4, residualAt0Lower: -8, residualAt0Upper: 8 } as FailureModel['healthSetPoints'] }),
        mk({ id: 'c1', name: 'Pump pattern', kind: 'clustering', xSensor: 'X', ySensor: 'Y', numClusters: 2, criteriaSensor: 'C',
            // Open outer edges: the Rust export refuses finite outer edges
            // (`regimes_not_contiguous`) although the Workbench's auto-divide
            // writes the criteria's data min / max there — reported as an app
            // bug by QA 2026-10-20; see the ignored Rust test
            // `qa_workspace_export_auto_divided_ranges_export`.
            clusterRanges: [{ min: null, max: 2 }, { min: 2, max: null }], category: 'performance', groupNos: [2],
            healthSetPoints: { kind: 'clustering', outerSd: 5 } as FailureModel['healthSetPoints'] }),
        mk({ id: 'i2', name: 'Power band', kind: 'individual', targetSensor: 'POWER', category: 'performance', groupNos: [0],
            healthSetPoints: { kind: 'individual', lower: 100, upper: 900 } as FailureModel['healthSetPoints'] }),
    ];
    fg.models = raw.map(m => ({ ...m, status: true, lastTrainedAt: '2026-10-20T01:00:00Z', trainedFingerprint: computeTrainFingerprint(m, fg) }));
    return {
        id: 'ws-contract', name: 'Yadana · MP Train', description: 'U-2010 · Gas turbine',
        machine: { plant: 'Yadana', name: 'MP Train', tag: 'U-2010', notes: 'Gas turbine' },
        dataUtcOffsetMin: 420,
        failureGroupState: fg,
        specialSensorRecipes: RECIPES,
        extraSensorMetadata: [{ tag: 'POWER', description: 'Power', unit: 'W', component: 'Electrical' }],
    } as unknown as WorkspaceState;
}

/** What Tauri's IPC transmits: JSON (undefined keys vanish). */
const wire = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));

describe('Export request: TS builder <-> Rust contract fixture', () => {
    it('the project is ready to export (every model Complete, every checklist item filled)', () => {
        const r = exportReadiness({ workspace: project(), metadata: META, headers: HEADERS });
        expect(r.rows.map(x => [x.id, x.reason])).toEqual([['i1', 'complete'], ['r1', 'complete'], ['c1', 'complete'], ['i2', 'complete']]);
        expect(r.counts.allReady).toBe(true);
        expect(r.noComponent).toEqual([]);
    });

    it('the request equals the fixture the Rust integration test exports (regenerate with -u)', async () => {
        const req = wire(buildWorkspaceExportRequest({ workspace: project(), metadata: META, headers: HEADERS, expectedGeneration: 1 }));
        await expect(JSON.stringify(req, null, 2) + '\n').toMatchFileSnapshot(FIXTURE);
    });

    it('per model, the request carries EXACTLY the scope and inputs Train sends (executeTrain) and Mark complete checks', () => {
        const ws = project();
        const fg = ws.failureGroupState!;
        const req = buildWorkspaceExportRequest({ workspace: ws, metadata: META, headers: HEADERS });
        expect(req.models.map(m => m.id)).toEqual(['i1', 'r1', 'c1', 'i2']);
        for (const spec of req.models) {
            const m = fg.models.find(x => x.id === spec.id)!;
            // BuildModelWindow.executeTrain: buildPreviewFilterPayload(effectiveRunningCondition(merged, gateFg), gateHeaders)
            const trainFilter = buildPreviewFilterPayload(effectiveRunningCondition(m, fg), HEADERS);
            expect(wire(spec.filter)).toEqual(wire(trainFilter));
            // Mark complete's check (compute_health_preview) scores the same rows.
            const check = buildHealthPreviewRequest({ model: m, fg, headers: HEADERS, setPoints: m.healthSetPoints });
            expect(wire(spec.filter)).toEqual(wire(check!.filter));
            expect(wire(spec.set_points)).toEqual(wire(check!.set_points));
            if (m.kind === 'relationship') {
                // executeTrain sends `lambda: merged.relStiffness`, `predictors`, `target`.
                expect(spec.rel_stiffness).toBe(m.relStiffness);
                expect(spec.predictors).toEqual(m.predictorSensors);
                expect(spec.target).toBe(m.targetSensor);
            }
            if (m.kind === 'clustering') {
                // executeTrain: n_clusters, criteria_sensor, cluster_ranges.slice(0, n)
                const n = m.numClusters ?? 3;
                expect(spec.n_clusters).toBe(n);
                expect(spec.criteria_sensor).toBe(m.criteriaSensor);
                expect(spec.cluster_ranges).toEqual((m.clusterRanges ?? []).slice(0, n));
                expect([spec.x_sensor, spec.y_sensor]).toEqual([m.xSensor, m.ySensor]);
            }
        }
        // The Custom model really has its own scope (OR + its own period).
        const r1 = req.models.find(m => m.id === 'r1')!;
        expect(r1.filter).toMatchObject({ combine: 'or', timestamp_ranges: [{ start: '2024-01-09T22:30', end: null }] });
        expect(req.models.find(m => m.id === 'i1')!.filter).toMatchObject({ combine: 'and', value_filters: [{ sensor: 'SPEED', operation: 'greater_than', value1: 100 }] });
    });
});

describe('Set-point edit on a Complete model -> Incomplete -> the export is not ready', () => {
    it('the write that changes the set points (applyIncompleteRule, as updateWorkspaceData runs it) drops Complete; readiness says "Mark complete is next"', () => {
        const before = project();
        expect(exportReadiness({ workspace: before, metadata: META, headers: HEADERS }).counts.allReady).toBe(true);
        const edited = withFailureGroupState(before, {
            models: before.failureGroupState!.models.map(m => (m.id === 'i1'
                ? { ...m, healthSetPoints: { kind: 'individual', lower: 21, upper: 35 } as FailureModel['healthSetPoints'] }
                : m)),
        });
        const after = applyIncompleteRule(before, edited);
        const i1 = after.failureGroupState!.models.find(m => m.id === 'i1')!;
        expect(i1.status).toBe(false);
        // still trained: no re-train needed, only Mark complete again
        expect(i1.trainedFingerprint).toBe(before.failureGroupState!.models[0].trainedFingerprint);
        // the other models keep their status
        expect(after.failureGroupState!.models.filter(m => m.id !== 'i1').every(m => m.status)).toBe(true);
        const r = exportReadiness({ workspace: after, metadata: META, headers: HEADERS });
        expect(r.counts).toMatchObject({ allReady: false, ready: 3, notReady: 1 });
        expect(r.rows.find(x => x.id === 'i1')).toMatchObject({ ready: false, reason: 'trained', words: 'Trained · Mark complete is next' });
    });

    it('editing the export running status or a name never demotes a model', () => {
        const before = project();
        const next = withFailureGroupState(before, {
            runningStatus: { sensor: 'T1', stopAtOrBelow: '3' },
            models: before.failureGroupState!.models.map(m => (m.id === 'c1' ? { ...m, name: 'Pump pattern 2' } : m)),
        });
        const after = applyIncompleteRule(before, next);
        expect(after.failureGroupState!.models.every(m => m.status)).toBe(true);
        expect(exportReadiness({ workspace: after, metadata: META, headers: HEADERS }).counts.allReady).toBe(true);
    });
});
