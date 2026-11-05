import type {
    FailureModel,
    HealthSetPoints,
    IndividualHealthSetPoints,
    ModelKind,
    SensorMetadata,
} from '../types';
import { sameTag } from './specialSensorNaming';

/* Pure (no Tauri, no React) set-point helpers shared by Dashboard, BuildModelWindow, the migration and tests. */

export type SetPointSide = 'lower' | 'upper';

/** Where an Individual set point's CURRENT value came from. Derived, never stored. */
export type SetPointSource = 'master' | 'model' | 'not-in-master';

/** Empty shape for a kind; Individual's master snapshot stays `undefined` (not taken), so use `seedHealthSetPoints` at creation. */
export function emptyHealthSetPoints(kind: ModelKind): HealthSetPoints {
    switch (kind) {
        case 'individual':
            return { kind: 'individual', lower: null, upper: null };
        case 'relationship':
            return {
                kind: 'relationship',
                residualAt80Lower: null,
                residualAt80Upper: null,
                residualAt0Lower: null,
                residualAt0Upper: null,
            };
        case 'clustering':
            return { kind: 'clustering', outerSd: null };
    }
}

const finiteOrNull = (v: number | undefined | null): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Master L/H of a sensor as the snapshot pair; a missing entry or level gives `null` (master has none). */
export function masterSnapshotOf(
    meta: Pick<SensorMetadata, 'alarmL' | 'alarmH'> | null | undefined,
): { masterLower: number | null; masterUpper: number | null } {
    return { masterLower: finiteOrNull(meta?.alarmL), masterUpper: finiteOrNull(meta?.alarmH) };
}

/** Individual takes the master snapshot and prefills lower/upper; `meta === null` = no master entry (null/null), `undefined` = not loaded (snapshot left untaken). Relationship / Clustering: always empty. */
export function seedHealthSetPoints(
    kind: ModelKind,
    meta?: Pick<SensorMetadata, 'alarmL' | 'alarmH'> | null,
): HealthSetPoints {
    if (kind !== 'individual' || meta === undefined) return emptyHealthSetPoints(kind);
    const { masterLower, masterUpper } = masterSnapshotOf(meta);
    return { kind: 'individual', lower: masterLower, upper: masterUpper, masterLower, masterUpper };
}

/** `'master'` = equals the master snapshot; `'not-in-master'` = no value and master has none; else `'model'`. An untaken snapshot counts as no master value. */
export function setPointSource(sp: IndividualHealthSetPoints, side: SetPointSide): SetPointSource {
    const value = side === 'lower' ? sp.lower : sp.upper;
    const master = (side === 'lower' ? sp.masterLower : sp.masterUpper) ?? null;
    if (value === null) return master === null ? 'not-in-master' : 'model';
    return master !== null && value === master ? 'master' : 'model';
}

/** True when "reset to master" would change something on `side` (a snapshot
 *  exists for it and the value differs). */
export function canResetToMaster(sp: IndividualHealthSetPoints, side: SetPointSide): boolean {
    const master = side === 'lower' ? sp.masterLower : sp.masterUpper;
    if (master === undefined) return false;
    return (side === 'lower' ? sp.lower : sp.upper) !== master;
}

/** Resets one side (or both) to the master snapshot; a side with no snapshot is left alone. Same object if nothing changes. */
export function resetToMaster(sp: IndividualHealthSetPoints, side?: SetPointSide): IndividualHealthSetPoints {
    let next = sp;
    if ((side === undefined || side === 'lower') && canResetToMaster(sp, 'lower')) {
        next = { ...next, lower: sp.masterLower ?? null };
    }
    if ((side === undefined || side === 'upper') && canResetToMaster(sp, 'upper')) {
        next = { ...next, upper: sp.masterUpper ?? null };
    }
    return next;
}

/** Brings one model's `healthSetPoints` up to date (same object if unchanged): missing or wrong kind -> empty shape; an untaken Individual side is snapshotted from master and prefilled. Entered values and existing snapshots are never touched. `sensorMetadata` undefined = not loaded (no snapshot); an empty list means no sensor has alarms. */
export function ensureHealthSetPoints(
    model: FailureModel,
    sensorMetadata?: readonly SensorMetadata[] | null,
): FailureModel {
    let sp = model.healthSetPoints;
    let changed = false;
    if (!sp || sp.kind !== model.kind) {
        sp = emptyHealthSetPoints(model.kind);
        changed = true;
    }
    if (sp.kind === 'individual' && sensorMetadata && (sp.masterLower === undefined || sp.masterUpper === undefined)) {
        const meta = sensorMetadata.find(m => sameTag(m.tag, model.targetSensor));
        const snap = masterSnapshotOf(meta);
        let next: IndividualHealthSetPoints = sp;
        if (sp.masterLower === undefined) {
            next = { ...next, masterLower: snap.masterLower, lower: sp.lower ?? snap.masterLower };
        }
        if (sp.masterUpper === undefined) {
            next = { ...next, masterUpper: snap.masterUpper, upper: sp.upper ?? snap.masterUpper };
        }
        sp = next;
        changed = true;
    }
    return changed ? { ...model, healthSetPoints: sp } : model;
}

/** Replaces one model's set points, carrying the rest by reference; for writers on models read fresh from disk, so it can't revert another window's change. Unknown id -> same array. */
export function patchModelHealthSetPoints(
    models: FailureModel[],
    modelId: string,
    next: HealthSetPoints,
): FailureModel[] {
    if (!models.some(m => m.id === modelId)) return models;
    return models.map(m => (m.id === modelId ? { ...m, healthSetPoints: next } : m));
}


/** The numbers a set-point value carries (master snapshots excluded: they are
 *  bookkeeping, not part of what the files contain). */
function setPointNumbers(sp: HealthSetPoints): (number | null)[] | null {
    switch (sp.kind) {
        case 'individual': return [finiteOrNull(sp.lower), finiteOrNull(sp.upper)];
        case 'relationship': return [finiteOrNull(sp.residualAt80Lower), finiteOrNull(sp.residualAt80Upper), finiteOrNull(sp.residualAt0Lower), finiteOrNull(sp.residualAt0Upper)];
        case 'clustering': return [finiteOrNull(sp.outerSd)];
        default: return null;
    }
}

/** Same kind and same entered numbers (master snapshots ignored); `healthChecks.ts` `sameSetPoints` re-exports this. */
export function sameHealthSetPoints(a: HealthSetPoints | null | undefined, b: HealthSetPoints | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    if (a.kind !== b.kind) return false;
    const x = setPointNumbers(a);
    const y = setPointNumbers(b);
    return !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]);
}
