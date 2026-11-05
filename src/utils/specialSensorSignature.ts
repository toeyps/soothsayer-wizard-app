import type { FailureModel, SensorOperationConfig, SpecialSensorRecipe, WorkspaceState } from '../types';
import { tokenizeFormula } from './formulaTokens';
import type { RunningConditionFg } from './runningCondition';
import { demoteModelsTrainedOnSensors, trainingSensorsOf, type SensorRepairDemotion } from './specialSensorRepair';

/** Special-sensor formulas in the train record: `computeTrainFingerprint` names sensors, not recipes, so a changed recipe needs this to mark models stale. Signatures are deep and rename-proof; a model with no snapshot is never judged by it. */

const key = (tag: string) => tag.trim().toLowerCase();

/** cyrb53 -- a fast, well-mixed 53-bit string hash (not cryptographic; only
 *  "did this recipe change"). */
function hash53(str: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** JSON with sorted keys and no `undefined` (configs built in any order compare equal). */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort()
            .map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

const cache = new WeakMap<SpecialSensorRecipe[], Map<string, string>>();

/** Signature of every special sensor, keyed by trimmed lower-cased tag; memoised per recipes array. */
export function recipeSignatures(recipes: SpecialSensorRecipe[] | null | undefined): Map<string, string> {
    if (!Array.isArray(recipes) || recipes.length === 0) return new Map();
    const hit = cache.get(recipes);
    if (hit) return hit;
    const byKey = new Map<string, SpecialSensorRecipe>();
    for (const r of recipes) if (r && typeof r.tag === 'string' && !byKey.has(key(r.tag))) byKey.set(key(r.tag), r);
    const out = new Map<string, string>();
    const visiting = new Set<string>();

    const operand = (name: string, self: string): string => {
        const k = key(name);
        if (k === self || !byKey.has(k)) return `$${k}`; // raw column (or a self reference Rust refuses)
        return `<${sig(k)}>`;
    };
    const sig = (k: string): string => {
        const done = out.get(k);
        if (done) return done;
        if (visiting.has(k)) return 'cycle';
        visiting.add(k);
        const r = byKey.get(k)!;
        let canonical: string;
        if (r.kind === 'formula') {
            const text = typeof r.formula === 'string' ? r.formula : '';
            // Tokens joined by one space: whitespace never changes the values.
            canonical = 'f:' + tokenizeFormula(text)
                .map(t => (t.kind === 'sensor' ? operand(t.name!, k) : t.text))
                .join(' ');
        } else {
            const { customName: _ignored, ...config } = (r.operationConfig ?? {}) as Partial<SensorOperationConfig>;
            void _ignored;
            const sources = (r.sourceSensors ?? []).map(s => operand(s, k));
            canonical = `o:${canonicalJson(config)}:${sources.join(',')}`;
        }
        visiting.delete(k);
        const s = hash53(canonical);
        out.set(k, s);
        return s;
    };
    for (const k of byKey.keys()) sig(k);
    cache.set(recipes, out);
    return out;
}

/** Keys of the special sensors `model` trains on (target, predictors, X/Y/criteria, effective running condition sensors). */
export function specialSensorsTrainedOn(model: FailureModel, fg: RunningConditionFg, recipes: SpecialSensorRecipe[] | null | undefined): string[] {
    const sigs = recipeSignatures(recipes);
    if (sigs.size === 0) return [];
    const out: string[] = [];
    for (const s of trainingSensorsOf(model, fg)) {
        const k = key(s);
        if (sigs.has(k) && !out.includes(k)) out.push(k);
    }
    return out;
}

/** The `trainedFormulas` snapshot for `model` trained NOW against `recipes`:
 *  `undefined` when it trains on no special sensor. */
export function snapshotTrainedFormulas(
    model: FailureModel,
    recipes: SpecialSensorRecipe[] | null | undefined,
    fg: RunningConditionFg,
): Record<string, string> | undefined {
    const used = specialSensorsTrainedOn(model, fg, recipes);
    if (used.length === 0) return undefined;
    const sigs = recipeSignatures(recipes);
    const snap: Record<string, string> = {};
    for (const k of used) snap[k] = sigs.get(k)!;
    return snap;
}

/** True if a special sensor this model trained on changed its recipe. False without a snapshot or for a sensor that no longer exists. */
export function trainedFormulasChanged(model: FailureModel, recipes: SpecialSensorRecipe[] | null | undefined): boolean {
    const snap = model.trainedFormulas;
    if (!snap || typeof snap !== 'object') return false;
    const entries = Object.entries(snap);
    if (entries.length === 0) return false;
    const sigs = recipeSignatures(recipes);
    return entries.some(([k, s]) => {
        const now = sigs.get(k);
        return now !== undefined && now !== s;
    });
}

function sameSnapshot(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
    if (!a || !b) return a === b;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k]);
}

/** `next` with `trainedFormulas` restamped on models whose train record changed, from `next`'s own recipes; returns `next` itself if nothing changes. */
export function stampTrainedFormulas(prev: WorkspaceState, next: WorkspaceState): WorkspaceState {
    const fg = next.failureGroupState;
    if (!fg || !Array.isArray(fg.models) || fg.models.length === 0) return next;
    const before = new Map((prev.failureGroupState?.models ?? []).map(m => [m.id, m]));
    let changed = false;
    const models = fg.models.map(m => {
        if (!m.lastTrainedAt) return m;
        const old = before.get(m.id);
        const retrained = !old || old.lastTrainedAt !== m.lastTrainedAt || old.trainedFingerprint !== m.trainedFingerprint;
        if (!retrained || m.trainedFingerprint === undefined) return m;
        const snap = snapshotTrainedFormulas(m, next.specialSensorRecipes, fg);
        if (sameSnapshot(snap, m.trainedFormulas)) return m;
        changed = true;
        if (snap) return { ...m, trainedFormulas: snap };
        const { trainedFormulas: _drop, ...rest } = m;
        void _drop;
        return rest;
    });
    return changed ? { ...next, failureGroupState: { ...fg, models } } : next;
}

/** Keys of special sensors in both lists whose deep signature differs (added/removed is not a change). */
export function changedRecipeKeys(
    prevRecipes: SpecialSensorRecipe[] | null | undefined,
    nextRecipes: SpecialSensorRecipe[] | null | undefined,
): string[] {
    if (prevRecipes === nextRecipes) return [];
    const a = recipeSignatures(prevRecipes);
    const b = recipeSignatures(nextRecipes);
    const out: string[] = [];
    for (const [k, s] of b) {
        const old = a.get(k);
        if (old !== undefined && old !== s) out.push(k);
    }
    return out;
}

/** Sends models back to Incomplete and out of date in the SAME write: those trained on a sensor whose signature changed, or whose `trainedFormulas` no longer matches `nextRecipes`. Set points and `lastTrainedAt` are kept. Pure and idempotent. */
export function demoteModelsForRecipeChange(
    models: FailureModel[],
    fg: RunningConditionFg,
    prevRecipes: SpecialSensorRecipe[] | null | undefined,
    nextRecipes: SpecialSensorRecipe[] | null | undefined,
): SensorRepairDemotion {
    if (!Array.isArray(models) || models.length === 0) return { models, retrain: [] };
    const changedKeys = changedRecipeKeys(prevRecipes, nextRecipes);
    const bySnapshot = models.filter(m => (m.status || m.trainedFingerprint !== undefined) && trainedFormulasChanged(m, nextRecipes));
    if (changedKeys.length === 0 && bySnapshot.length === 0) return { models, retrain: [] };
    const first = demoteModelsTrainedOnSensors(models, fg, changedKeys);
    if (bySnapshot.length === 0) return first;
    // Snapshot mismatches: the same demotion, one model at a time.
    const ids = new Set(bySnapshot.map(m => m.id));
    const retrain = new Set(first.retrain);
    let changed = first.models !== models;
    const out = first.models.map(m => {
        if (!ids.has(m.id)) return m;
        if (m.status || m.lastTrainedAt) retrain.add(m.id);
        if (!(m.status || m.trainedFingerprint !== undefined || m.healthVerdict !== undefined || m.testsChangedAt !== undefined)) return m;
        changed = true;
        const { trainedFingerprint: _fp, healthVerdict: _v, testsChangedAt: _t, ...rest } = m;
        void _fp;
        void _v;
        void _t;
        return { ...rest, status: false };
    });
    return { models: changed ? out : models, retrain: [...retrain] };
}
