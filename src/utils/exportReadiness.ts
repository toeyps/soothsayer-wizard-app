import type {
    FailureGroup, FailureGroupStateSlice, FailureModel, MachineDetails, ModelCategory, ModelKind, SensorMetadata,
    SpecialSensorRecipe, WorkspaceSensorFilter, WorkspaceState,
} from '../types';
import type {
    ExportClusterRange, ExportDerivedSensor, ExportModelSpec, ExportSensorMeta, WorkspaceExportRequest,
} from '../types/export';
import { normalizeSensorTag } from '../hooks/useSensorMetaMap';
import { healthSetPointsToWire, relationshipLambda } from './healthRequest';
import { modelSensorKey, sensorCategory } from './modelGrouping';
import { findWorkspaceNameTwin, kindModelName, modelTagOf } from './modelNames';
import { isModelComplete, isModelStale } from './modelStatus';
import { machineOf, missingMachineFields, pcOffsetMin } from './projectDetails';
import { effectiveRunningCondition, getBuildBlockReason, isCompleteCondition, type RunningConditionFg } from './runningCondition';
import { resolveRunningStatus, runningStatusToWire, type ResolvedRunningStatus } from './runningStatus';
import { howToBuild, rawSourceTags, recipeOf } from './specialSensorHowToBuild';
import { trainingScopeFilter } from './trainingScope';

/*
 * Export results — what the export needs, checked BEFORE anything is sent to
 * Rust (`exportReadiness`), and the request it sends
 * (`buildWorkspaceExportRequest`). Pure: the caller reads the workspace from
 * disk and passes it in. Rust re-checks everything in `plan_workspace_export`;
 * this is what the Workbench bar and the Export dialog show while nothing has
 * been asked yet.
 */

const KIND_ORDER: readonly ModelKind[] = ['individual', 'relationship', 'clustering'];
const nonEmpty = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';

// ---------------------------------------------------------------------------
// Order and the sensors a model uses
// ---------------------------------------------------------------------------

/**
 * The Workbench run order: sensors in first-seen order (workspace-wide,
 * `modelSensorKey`), and per sensor Individual → Relation model → Clustering.
 * Unique by id. With `order` (model ids) that order is used instead; ids not
 * in it follow in run order, unknown ids are ignored.
 */
export function exportRunOrder(models: readonly FailureModel[], order?: readonly string[]): FailureModel[] {
    const byKey = new Map<string, FailureModel[]>();
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const m of models) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const key = modelSensorKey(m);
        if (!byKey.has(key)) { byKey.set(key, []); keys.push(key); }
        byKey.get(key)!.push(m);
    }
    const runOrder = keys.flatMap(k => KIND_ORDER.flatMap(kind => byKey.get(k)!.filter(m => m.kind === kind)));
    if (!order) return runOrder;
    const byId = new Map(runOrder.map(m => [m.id, m]));
    const out: FailureModel[] = [];
    const used = new Set<string>();
    for (const id of order) {
        const m = byId.get(id);
        if (m && !used.has(id)) { out.push(m); used.add(id); }
    }
    for (const m of runOrder) if (!used.has(m.id)) out.push(m);
    return out;
}

/** Number of clusters as the Workbench trains with it (missing = 3). */
const clustersOf = (m: FailureModel): number => m.numClusters ?? 3;

/** The criteria sensor a Clustering model splits by, or null (1 cluster / none chosen). */
function criteriaOf(m: FailureModel): string | null {
    return m.kind === 'clustering' && clustersOf(m) > 1 && nonEmpty(m.criteriaSensor) ? m.criteriaSensor : null;
}

/** The sensors a model reads, as its CSV columns: R inputs then output, I its
 *  sensor, C x, y and the criteria sensor when it is a different one. Empty
 *  tags are left out. */
export function modelExportTags(m: FailureModel): string[] {
    let tags: string[];
    if (m.kind === 'relationship') tags = [...(m.predictorSensors ?? []), m.targetSensor];
    else if (m.kind === 'individual') tags = [m.targetSensor];
    else {
        const c = criteriaOf(m);
        tags = [m.xSensor, m.ySensor, ...(c ? [c] : [])];
    }
    const out: string[] = [];
    for (const t of tags) if (nonEmpty(t) && !out.some(o => normalizeSensorTag(o) === normalizeSensorTag(t))) out.push(t);
    return out;
}

/** The category of a model's sensor (its own, else the sensor-wide one). */
function categoryOf(m: FailureModel, models: FailureModel[]): ModelCategory | null {
    return m.category ?? sensorCategory(models, modelSensorKey(m));
}

const OP_TEXT: Record<WorkspaceSensorFilter['operation'], string> = { greater_than: '>', less_than: '<', equals: '=', between: 'between' };
const conditionText = (f: WorkspaceSensorFilter): string =>
    (f.operation === 'between' ? `${f.sensor} between ${f.value1} and ${f.value2}` : `${f.sensor} ${OP_TEXT[f.operation] ?? f.operation} ${f.value1}`);
const stamp = (s: string, open: string): string => (s.trim() === '' ? open : s.replace('T', ' '));

/**
 * The free-text note written next to a model's training data: which rows it
 * was trained on (its EFFECTIVE running condition), its train periods,
 * whether it uses its own condition, and that rows with a missing value were
 * removed.
 */
export function trainingNote(model: FailureModel, fg: RunningConditionFg, headers: string[] | null = null): string {
    const eff = effectiveRunningCondition(model, fg);
    const conds = eff.noneConfirmed ? [] : eff.filters.filter(f => isCompleteCondition(f, headers));
    const parts = [
        conds.length
            ? `Running only: ${conds.map(conditionText).join(eff.combine === 'or' ? ' OR ' : ' AND ')}`
            : 'All rows (no running condition)',
        eff.periods.length
            ? `train periods ${eff.periods.map(p => `${stamp(p.start, 'start of data')} to ${stamp(p.end, 'end of data')}`).join(', ')}`
            : '',
        eff.mode === 'custom' ? 'own condition of this model' : '',
        'rows with a missing value removed',
    ];
    return parts.filter(Boolean).join('; ');
}

// ---------------------------------------------------------------------------
// Sensor metadata
// ---------------------------------------------------------------------------

/** One lookup over the mapping metadata and the workspace's special-sensor
 *  metadata (the mapping wins), by normalised tag. */
function metaLookup(metadata: readonly SensorMetadata[] | null | undefined, ws: Pick<WorkspaceState, 'extraSensorMetadata'>) {
    const map = new Map<string, SensorMetadata>();
    for (const m of ws.extraSensorMetadata ?? []) map.set(normalizeSensorTag(m.tag), m);
    for (const m of metadata ?? []) map.set(normalizeSensorTag(m.tag), m);
    return (tag: string): SensorMetadata | undefined => map.get(normalizeSensorTag(tag));
}

const addUnique = (list: string[], tag: string) => {
    if (nonEmpty(tag) && !list.some(t => normalizeSensorTag(t) === normalizeSensorTag(tag))) list.push(tag);
};

/** Every sensor the export touches, split the way the request needs them. */
interface ExportSensors {
    /** Tags the models use directly + the running-status sensor, in first-use order. */
    used: string[];
    /** The used tags that are special sensors (have a recipe). */
    special: string[];
    /** Raw tags: used ones that are not special + the raw sources of the special ones. */
    raw: string[];
    /** `used` ∪ `raw` — every tag that needs a name, unit and component. */
    all: string[];
}

function exportSensors(models: FailureModel[], running: ResolvedRunningStatus | null, recipes: readonly SpecialSensorRecipe[] | null | undefined): ExportSensors {
    const used: string[] = [];
    for (const m of models) for (const t of modelExportTags(m)) addUnique(used, t);
    if (running) addUnique(used, running.sensor);
    const special = used.filter(t => recipeOf(recipes, t) !== undefined);
    const raw: string[] = [];
    for (const t of used) {
        if (recipeOf(recipes, t)) for (const s of rawSourceTags(recipes, t)) addUnique(raw, s);
        else addUnique(raw, t);
    }
    const all = [...used];
    for (const t of raw) addUnique(all, t);
    return { used, special, raw, all };
}

const realGroups = (groups: readonly FailureGroup[] | undefined): FailureGroup[] => (groups ?? []).filter(g => g.no !== 0);

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/** Why a model is (not) ready to export. */
export type ExportModelReason =
    | 'complete'
    | 'name-twin'
    | 'complete-no-category'
    | 'load-failed'
    | 'no-data'
    | 'category-missing'
    | 'blocked'
    | 'stale'
    | 'trained'
    | 'not-trained';

export type ExportRowTone = 'complete' | 'need' | 'bad' | 'none';

export interface ExportReadinessRow {
    id: string;
    kind: ModelKind;
    /** The sensor the model belongs to (target; X sensor for Clustering). */
    tag: string;
    /** Its failure groups; `[0]` = not in a group. */
    groupNos: number[];
    ready: boolean;
    reason: ExportModelReason;
    /** What the row says. */
    words: string;
    tone: ExportRowTone;
    /** The other model that has the same name (`reason: 'name-twin'`). */
    twinId?: string;
}

interface ItemBase {
    /** Nothing to do. */
    ok: boolean;
    /** Information only — never blocks, even when not `ok`. */
    info: boolean;
    /** `!ok && !info`: counted in "items to fill in". */
    blocking: boolean;
}

export type ExportReadinessItem =
    | (ItemBase & { id: 'machine'; machine: MachineDetails; missing: string[]; /** a project made before machine details existed */ legacy: boolean })
    | (ItemBase & { id: 'tz'; offsetMin: number; /** the offset is this PC's */ isPcOffset: boolean; /** saved on the project (else the PC's is assumed) */ saved: boolean })
    | (ItemBase & { id: 'running'; status: ResolvedRunningStatus | null })
    | (ItemBase & { id: 'sensors'; rawCount: number; specialCount: number; noComponentCount: number })
    | (ItemBase & { id: 'derived'; sensors: { tag: string; howToBuild: string; sourceTags: string[] }[] })
    | (ItemBase & { id: 'fg'; usedCount: number; missing: { no: number; name: string; description: boolean; recommendation: boolean }[] });

export interface NoComponentSensor {
    tag: string;
    /** A special (calculated) sensor — its component is set in Special Sensors › Manage. */
    special: boolean;
    /** Models that read it (directly, or through a special sensor built on it). */
    modelIds: string[];
    /** It is the running-status sensor. With no `modelIds` the UI says
     *  "Used as the running-status sensor". */
    runningStatus: boolean;
}

export interface ExportReadiness {
    rows: ExportReadinessRow[];
    items: ExportReadinessItem[];
    noComponent: NoComponentSensor[];
    counts: { total: number; ready: number; notReady: number; toFix: number; allReady: boolean };
}

export interface ExportReadinessInput {
    /** The workspace AS ON DISK. */
    workspace: WorkspaceState;
    /** Mapping metadata (the workspace's special-sensor metadata is added here). */
    metadata: readonly SensorMetadata[] | null | undefined;
    headers: string[] | null;
    /** Special-sensor recipes; default `workspace.specialSensorRecipes`. */
    recipes?: readonly SpecialSensorRecipe[] | null;
    /** Model ids whose training scope has no row in the loaded file. */
    noData?: ReadonlySet<string> | readonly string[];
    /** Model ids whose results could not be loaded. */
    loadFailed?: ReadonlySet<string> | readonly string[];
    /** Model ids in the order to show (default: Workbench run order). */
    order?: readonly string[];
    /** Sensor label for sentences; default "DESCRIPTION · TAG" (the tag alone without one). */
    labelOf?: (tag: string) => string;
}

const asSet = (v: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> => (v instanceof Set ? v : new Set(v as readonly string[] | undefined ?? []));

function item<T extends { ok: boolean; info?: boolean }>(x: T): T & ItemBase {
    const info = !!x.info;
    return { ...x, info, blocking: !x.ok && !info };
}

/** Everything the export needs, model by model and item by item. */
export function exportReadiness(input: ExportReadinessInput): ExportReadiness {
    const ws = input.workspace;
    const fg: Partial<FailureGroupStateSlice> = ws.failureGroupState ?? {};
    const allModels = fg.models ?? [];
    const recipes: SpecialSensorRecipe[] = [...(input.recipes ?? ws.specialSensorRecipes ?? [])];
    const meta = metaLookup(input.metadata, ws);
    const labelOf = input.labelOf ?? ((t: string) => { const d = meta(t)?.description?.trim(); return d ? `${d} · ${t}` : t; });
    const noData = asSet(input.noData);
    const loadFailed = asSet(input.loadFailed);
    const models = exportRunOrder(allModels, input.order);

    const rows: ExportReadinessRow[] = models.map(m => {
        const base = { id: m.id, kind: m.kind, tag: modelTagOf(m), groupNos: m.groupNos?.length ? [...m.groupNos] : [0] };
        const done = isModelComplete(m, fg, recipes);
        const category = categoryOf(m, allModels);
        const twin = findWorkspaceNameTwin(allModels, m, m.name ?? '');
        const row = (reason: ExportModelReason, words: string, tone: ExportRowTone, extra: Partial<ExportReadinessRow> = {}): ExportReadinessRow =>
            ({ ...base, ready: reason === 'complete', reason, words, tone, ...extra });
        if (twin) return row('name-twin', `Name also used by the ${kindModelName(twin.kind)} of ${labelOf(modelTagOf(twin))} — rename one`, 'need', { twinId: twin.id });
        if (done && !category) return row('complete-no-category', 'Complete · category not set (Performance or Condition, in the sensor header)', 'need');
        if (loadFailed.has(m.id)) return row('load-failed', 'Results could not be loaded — open the model to load them again', 'bad');
        if (noData.has(m.id)) return row('no-data', 'No data for this model in the loaded file', 'bad');
        if (done) return row('complete', 'Complete', 'complete');
        if (!category) return row('category-missing', 'Category not set (Performance or Condition, in the sensor header)', 'bad');
        const block = getBuildBlockReason(m, fg, input.headers);
        if (block) return row('blocked', block, 'bad');
        if (isModelStale(m, fg, recipes)) return row('stale', 'Settings changed — re-train', 'need');
        if (m.lastTrainedAt) return row('trained', 'Trained · Mark complete is next', 'need');
        return row('not-trained', 'Not trained yet', 'none');
    });

    const running = resolveRunningStatus(fg, input.headers);
    const sensors = exportSensors(models, running, recipes);
    const noComponent: NoComponentSensor[] = sensors.all
        .filter(t => !nonEmpty(meta(t)?.component))
        .map(t => {
            const key = normalizeSensorTag(t);
            const reads = (m: FailureModel) => modelExportTags(m).some(u =>
                normalizeSensorTag(u) === key || rawSourceTags(recipes, u).some(s => normalizeSensorTag(s) === key));
            return {
                tag: t,
                special: recipeOf(recipes, t) !== undefined,
                modelIds: models.filter(reads).map(m => m.id),
                runningStatus: !!running && normalizeSensorTag(running.sensor) === key,
            };
        });

    const machine = machineOf(ws);
    const missing = missingMachineFields(ws.machine ?? machine);
    const offsetSaved = typeof ws.dataUtcOffsetMin === 'number';
    const offsetMin = offsetSaved ? ws.dataUtcOffsetMin! : pcOffsetMin();
    const usedGroups = realGroups(fg.groups).filter(g => models.some(m => (m.groupNos ?? []).includes(g.no)));
    const fgMissing = usedGroups
        .map(g => ({ no: g.no, name: g.name, description: !nonEmpty(g.description), recommendation: !nonEmpty(g.recommendation) }))
        .filter(g => g.description || g.recommendation);

    const items: ExportReadinessItem[] = [
        item({ id: 'machine' as const, ok: missing.length === 0, machine, missing, legacy: !ws.machine }),
        item({ id: 'tz' as const, ok: true, offsetMin, isPcOffset: offsetMin === pcOffsetMin(), saved: offsetSaved }),
        item({ id: 'running' as const, ok: running !== null, status: running }),
        item({
            id: 'sensors' as const, ok: true, info: noComponent.length > 0,
            rawCount: sensors.raw.length, specialCount: sensors.special.length, noComponentCount: noComponent.length,
        }),
        ...(sensors.special.length ? [item({
            id: 'derived' as const, ok: true, info: true,
            sensors: sensors.special.map(t => ({ tag: t, howToBuild: howToBuild(recipes, t), sourceTags: rawSourceTags(recipes, t) })),
        })] : []),
        item({ id: 'fg' as const, ok: fgMissing.length === 0, usedCount: usedGroups.length, missing: fgMissing }),
    ];

    const total = rows.length;
    const ready = rows.filter(r => r.ready).length;
    const toFix = items.filter(i => i.blocking).length;
    return {
        rows, items, noComponent,
        counts: { total, ready, notReady: total - ready, toFix, allReady: total > 0 && ready === total && toFix === 0 },
    };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface BuildExportRequestInput {
    /** The workspace AS ON DISK (read it fresh right before exporting). */
    workspace: WorkspaceState;
    metadata: readonly SensorMetadata[] | null | undefined;
    headers: string[] | null;
    recipes?: readonly SpecialSensorRecipe[] | null;
    /** Model ids in Workbench run order (default `exportRunOrder`). */
    order?: readonly string[];
    /** Rust session generation; a window left over from another dataset gets `STALE_SESSION`. */
    expectedGeneration?: number;
}

/** The `ExportModelSpec` of one model. */
export function exportModelSpec(m: FailureModel, fg: Partial<FailureGroupStateSlice>, headers: string[] | null): ExportModelSpec {
    const spec: ExportModelSpec = {
        id: m.id,
        kind: m.kind,
        display_name: m.name ?? '',
        category: categoryOf(m, fg.models ?? []),
        group_nos: (m.groupNos ?? []).filter(n => n !== 0),
        filter: trainingScopeFilter(m, fg, headers),
        set_points: healthSetPointsToWire(m.kind, m.healthSetPoints),
        training_note: trainingNote(m, fg, headers),
    };
    if (m.kind === 'relationship') {
        spec.target = m.targetSensor;
        spec.predictors = [...(m.predictorSensors ?? [])];
        spec.rel_stiffness = relationshipLambda(m);
    } else if (m.kind === 'individual') {
        spec.target = m.targetSensor;
    } else {
        const n = clustersOf(m);
        const criteria = criteriaOf(m);
        spec.x_sensor = m.xSensor;
        spec.y_sensor = m.ySensor;
        spec.n_clusters = n;
        spec.criteria_sensor = criteria;
        spec.cluster_ranges = criteria
            ? (m.clusterRanges ?? []).slice(0, n).map((r): ExportClusterRange => ({ min: r.min, max: r.max }))
            : null;
    }
    return spec;
}

/** The `WorkspaceExportRequest` for the whole workspace. */
export function buildWorkspaceExportRequest(input: BuildExportRequestInput): WorkspaceExportRequest {
    const ws = input.workspace;
    const fg: Partial<FailureGroupStateSlice> = ws.failureGroupState ?? {};
    const recipes = input.recipes ?? ws.specialSensorRecipes ?? [];
    const meta = metaLookup(input.metadata, ws);
    const models = exportRunOrder(fg.models ?? [], input.order);
    const running = resolveRunningStatus(fg, input.headers);
    const sensors = exportSensors(models, running, recipes);
    const machine = ws.machine ?? machineOf(ws);

    const sensorMeta: ExportSensorMeta[] = sensors.all.map(t => {
        const m = meta(t);
        return { tag: t, name: m?.description?.trim() ?? '', unit: m?.unit ?? '', component: m?.component?.trim() ?? '' };
    });
    const derived: ExportDerivedSensor[] = sensors.special.map(t => ({
        tag: t, how_to_build: howToBuild(recipes, t), source_tags: rawSourceTags(recipes, t),
    }));
    const req: WorkspaceExportRequest = {
        workspace_id: ws.id,
        data_utc_offset_min: typeof ws.dataUtcOffsetMin === 'number' ? ws.dataUtcOffsetMin : pcOffsetMin(),
        machine: { plant: machine.plant, name: machine.name, tag: machine.tag, notes: machine.notes },
        running_status: runningStatusToWire(running),
        sensor_meta: sensorMeta,
        derived_sensors: derived,
        failure_groups: realGroups(fg.groups).map(g => ({
            no: g.no, name: g.name ?? '', description: g.description ?? '', recommendation: g.recommendation ?? '',
        })),
        models: models.map(m => exportModelSpec(m, fg, input.headers)),
    };
    if (input.expectedGeneration !== undefined) req.expected_generation = input.expectedGeneration;
    return req;
}
