import type { CategoryChange, FailureModel, ModelCategory, ModelKind } from '../types';
import { normalizeSensorTag } from '../hooks/useSensorMetaMap';

/** When one sensor's models disagree on category, the first non-null in this order wins (then array order). */
const KIND_PRECEDENCE: Record<ModelKind, number> = { individual: 0, relationship: 1, clustering: 2 };

/** Sensor a model is grouped under: Clustering by its X sensor (not Y: changing Y must not move a row), others by target. Normalised; '' = key sensor not chosen yet. */
export function modelSensorKey(m: Pick<FailureModel, 'kind' | 'targetSensor' | 'xSensor'>): string {
    return normalizeSensorTag((m.kind === 'clustering' ? m.xSensor : m.targetSensor) ?? '');
}

export interface SensorModelGroup {
    key: string;
    /** Models of this sensor inside the requested group, in original array order. */
    models: FailureModel[];
}

/** One entry per sensor for the group's models, first-seen order; a model with an empty key sensor forms its own '' group. */
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

/** Category of a sensor across every model of that key (workspace-wide): first non-null by kind precedence, ties by array order; null if none. */
export function sensorCategory(models: FailureModel[], key: string): ModelCategory | null {
    let best: FailureModel | null = null;
    for (const m of models) {
        if (m.category == null || modelSensorKey(m) !== key) continue;
        if (!best || KIND_PRECEDENCE[m.kind] < KIND_PRECEDENCE[best.kind]) best = m;
    }
    return best ? best.category : null;
}

/** Writes `cat` onto every model of `key` in every FG; other models keep identity; returns the same array when nothing changes. */
export function setSensorCategory(models: FailureModel[], key: string, cat: ModelCategory | null): FailureModel[] {
    let changed = false;
    const next = models.map((m) => {
        if (modelSensorKey(m) !== key || m.category === cat) return m;
        changed = true;
        return { ...m, category: cat };
    });
    return changed ? next : models;
}

/** One-time cleanup: make every sensor's models agree on a category (winner = `sensorCategory`); rewritten ones are reported in `changes`. Idempotent. */
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

/** Models a Failure Group deletes with it: those in that group ONLY; a model also in another group just loses this one. */
export function modelsOnlyIn<T extends Pick<FailureModel, 'groupNos'>>(models: readonly T[], groupNo: number): T[] {
    return models.filter(m => m.groupNos.length > 0 && m.groupNos.every(n => n === groupNo));
}

/** What deleting a group does: models only in it are deleted, others lose it. Exported files are never deleted. */
export function groupDeleteCounts(models: readonly { groupNos: number[] }[], groupNo: number): { deleted: number; kept: number } {
    const inGroup = models.filter(m => m.groupNos.includes(groupNo));
    const deleted = modelsOnlyIn(inGroup, groupNo).length;
    return { deleted, kept: inGroup.length - deleted };
}
