import type {
    FailureModel,
    HealthSetPoints,
    IndividualHealthSetPoints,
    ModelKind,
    SensorMetadata,
} from '../types';
import { sameTag } from './specialSensorNaming';

/*
 * Health score set points -- phase 1 (data model only, 2026-10-03).
 *
 * Everything here is PURE (no Tauri, no React) so Dashboard, BuildModelWindow,
 * the migration and tests can all share it. See `HealthSetPoints` in
 * `types.ts` for the field shapes and the `undefined` vs `null` meaning of the
 * Individual master snapshot.
 */

export type SetPointSide = 'lower' | 'upper';

/** Where an Individual set point's CURRENT value came from. Derived, never stored. */
export type SetPointSource = 'master' | 'model' | 'not-in-master';

/** The right EMPTY shape for a model kind. Individual's snapshot is left
 *  `undefined` ("not taken yet"); use `seedHealthSetPoints` at creation. */
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

/** Master-data L/H of a sensor, as the snapshot pair. A missing entry (special
 *  sensor, sensor absent from the mapping CSV) and a missing level both give
 *  `null` -- "master has none". */
export function masterSnapshotOf(
    meta: Pick<SensorMetadata, 'alarmL' | 'alarmH'> | null | undefined,
): { masterLower: number | null; masterUpper: number | null } {
    return { masterLower: finiteOrNull(meta?.alarmL), masterUpper: finiteOrNull(meta?.alarmH) };
}

/**
 * Set points for a model that is being CREATED now.
 *
 * Individual: takes the master snapshot and prefills `lower`/`upper` from it
 * (each possibly null -- a one-sided master leaves the other side for the user).
 * `meta === null` means "looked it up, the sensor has no master entry" (special
 * sensor) and still takes the snapshot (null/null); `meta === undefined` means
 * "metadata not available" and leaves the snapshot untaken so
 * `ensureHealthSetPoints` can fill it later.
 * Relationship / Clustering: always empty.
 */
export function seedHealthSetPoints(
    kind: ModelKind,
    meta?: Pick<SensorMetadata, 'alarmL' | 'alarmH'> | null,
): HealthSetPoints {
    if (kind !== 'individual' || meta === undefined) return emptyHealthSetPoints(kind);
    const { masterLower, masterUpper } = masterSnapshotOf(meta);
    return { kind: 'individual', lower: masterLower, upper: masterUpper, masterLower, masterUpper };
}

/** `'master'` = the value equals the master snapshot; `'not-in-master'` = no
 *  value and master has none; `'model'` = anything else (entered/changed on this
 *  model, or cleared although master has one). An untaken snapshot
 *  (`undefined`) counts as "master has none". */
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

/** Puts the value back to the master snapshot -- one side, or both when `side`
 *  is omitted. A side whose snapshot was never taken is left alone. Returns
 *  the SAME object when nothing changes. The snapshot itself is never altered. */
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

/**
 * Brings one model's `healthSetPoints` up to date. Returns the SAME model
 * object when nothing changes (idempotent), otherwise a copy -- every other
 * field is kept.
 *
 *  - Missing (or of the wrong kind) -> the empty shape for the model's kind.
 *  - Individual with an untaken snapshot side AND `sensorMetadata` supplied ->
 *    that side is snapshotted from the target sensor's master data (not found ->
 *    null), and a still-null `lower`/`upper` on that side is prefilled from it.
 *    A value the user entered is never overwritten and a snapshot that exists
 *    is never touched.
 *  - `sensorMetadata` omitted (`undefined`) means "not loaded yet": no snapshot
 *    is taken. Pass the full list only once it is really loaded -- an empty
 *    list means "no sensor has alarms".
 */
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

/** Replaces ONE model's set points inside a models array (everything else, incl.
 *  every other model, is carried by reference). For a writer that runs against
 *  the models read fresh from disk, so a set-point edit can never revert
 *  another window's change to some other field. Unknown id -> same array. */
export function patchModelHealthSetPoints(
    models: FailureModel[],
    modelId: string,
    next: HealthSetPoints,
): FailureModel[] {
    if (!models.some(m => m.id === modelId)) return models;
    return models.map(m => (m.id === modelId ? { ...m, healthSetPoints: next } : m));
}
