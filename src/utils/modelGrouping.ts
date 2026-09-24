import type { CategoryChange, FailureModel, ModelCategory, ModelKind } from '../types';
import { normalizeSensorTag } from '../hooks/useSensorMetaMap';

/** Individual → Relationship → Clustering: when one sensor's models disagree on
 *  category, the first non-null value in this order wins (then array order). */
const KIND_PRECEDENCE: Record<ModelKind, number> = { individual: 0, relationship: 1, clustering: 2 };

/**
 * The sensor a model is grouped under on the Overview / Failure Groups panel.
 * Clustering is keyed by its X sensor (NOT Y — changing Y must never move a
 * row); Individual/Relationship by their target. Normalised (trim + lowercase)
 * so `Temp_1` and ` temp_1` are one sensor. `''` = key sensor not chosen yet.
 */
export function modelSensorKey(m: Pick<FailureModel, 'kind' | 'targetSensor' | 'xSensor'>): string {
    return normalizeSensorTag((m.kind === 'clustering' ? m.xSensor : m.targetSensor) ?? '');
}

export interface SensorModelGroup {
    key: string;
    /** Models of this sensor inside the requested group, in original array order. */
    models: FailureModel[];
}

/** One entry per sensor for the models that belong to `groupNo`, in first-seen
 *  order. A model with an empty key sensor forms its own `''` group. */
export function groupModelsBySensor(models: FailureModel[], groupNo: number): SensorModelGroup[] {
    const out: SensorModelGroup[] = [];
    const byKey = new Map<string, SensorModelGroup>();
    for (const m of models) {
        if (!(m.groupNos ?? []).includes(groupNo)) continue;
        const key = modelSensorKey(m);
        let g = byKey.get(key);
        if (!g) {
            g = { key, models: [] };
            byKey.set(key, g);
            out.push(g);
        }
        g.models.push(m);
    }
    return out;
}

/** The category of a sensor across EVERY model of that key (workspace-wide, not
 *  one FG): first non-null by kind precedence, ties by array order. `null` if none set. */
export function sensorCategory(models: FailureModel[], key: string): ModelCategory | null {
    let best: FailureModel | null = null;
    for (const m of models) {
        if (m.category == null || modelSensorKey(m) !== key) continue;
        if (!best || KIND_PRECEDENCE[m.kind] < KIND_PRECEDENCE[best.kind]) best = m;
    }
    return best ? best.category : null;
}

/** Writes `cat` onto every model of `key`, in every FG. Other models keep their
 *  identity (same object). Returns the same array when nothing needs changing. */
export function setSensorCategory(models: FailureModel[], key: string, cat: ModelCategory | null): FailureModel[] {
    let changed = false;
    const next = models.map((m) => {
        if (modelSensorKey(m) !== key || m.category === cat) return m;
        changed = true;
        return { ...m, category: cat };
    });
    return changed ? next : models;
}

/**
 * One-time legacy cleanup: makes every sensor's models agree on a category.
 * The winner is `sensorCategory` (kind precedence); models that differ —
 * including ones that were `null` while a sibling had a value — are rewritten
 * and reported in `changes`. A sensor with no category anywhere is untouched.
 * Idempotent: a second run returns no changes.
 */
export function normalizeSensorCategories(models: FailureModel[]): { models: FailureModel[]; changes: CategoryChange[] } {
    const winner = new Map<string, ModelCategory | null>();
    for (const m of models) {
        const key = modelSensorKey(m);
        if (!winner.has(key)) winner.set(key, sensorCategory(models, key));
    }
    const changes: CategoryChange[] = [];
    const next = models.map((m) => {
        const key = modelSensorKey(m);
        const to = winner.get(key) ?? null;
        if (to == null || m.category === to) return m;
        changes.push({ modelId: m.id, kind: m.kind, sensorKey: key, from: m.category ?? null, to });
        return { ...m, category: to };
    });
    return { models: changes.length ? next : models, changes };
}
