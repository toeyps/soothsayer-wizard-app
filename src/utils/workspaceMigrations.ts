import type { FailureGroupStateSlice, FailureModel, RunningConditionConversion, TimePeriod, WorkspaceSensorFilter, WorkspaceState } from '../types';
import { withFailureGroupState } from './failureGroupState';
import { ensureHealthSetPoints } from './healthSetPoints';
import { normalizeSensorCategories } from './modelGrouping';
import { isCompleteCondition } from './runningCondition';

/*
 * Workspace migrations (`migrateHealthSetPoints` and `migrateSingleRunningCondition` are run by
 * `workspaceManager.ts` on EVERY workspace read). Each step is a PURE,
 * independently idempotent function gated on its OWN marker being `undefined`
 * (`null` and any value both mean "already handled") -- except
 * `migrateSingleRunningCondition`, whose shape check runs whatever the marker
 * says (the marker only decides its notice). Every step spreads the
 * existing slice
 * (via `withFailureGroupState`), so no field is ever dropped. A step that has
 * nothing to do returns the SAME state object.
 */

/** Pre-periods shape: the type no longer declares these keys, but old files carry them. */
type LegacyModelTime = { filterTimeStart?: string; filterTimeEnd?: string };
type LegacyFgTime = { runningConditionTimeStart?: string; runningConditionTimeEnd?: string };

function legacyPeriods(start: string | undefined, end: string | undefined): TimePeriod[] {
    return start || end ? [{ id: 'legacy-1', start: start ?? '', end: end ?? '' }] : [];
}

/**
 * (a) Old single time ranges -> period lists (workspace + per model) and seeds
 * `customRunningConditionNoneConfirmed: false`. Old keys are kept unless
 * `dropLegacyKeys` (then they are deleted, even if periods already existed).
 */
export function migratePeriods(state: WorkspaceState, opts: { dropLegacyKeys?: boolean } = {}): WorkspaceState {
    const fg = state.failureGroupState;
    if (!fg) return state;
    const drop = opts.dropLegacyKeys === true;
    let changed = false;

    const models = fg.models.map((m) => {
        const patch: Partial<FailureModel> = {};
        const old = m as FailureModel & LegacyModelTime;
        if (m.filterTimePeriods === undefined) patch.filterTimePeriods = legacyPeriods(old.filterTimeStart, old.filterTimeEnd);
        if (m.customRunningConditionNoneConfirmed === undefined) patch.customRunningConditionNoneConfirmed = false;
        let next: FailureModel = Object.keys(patch).length ? { ...m, ...patch } : m;
        if (drop && ('filterTimeStart' in next || 'filterTimeEnd' in next)) {
            const { filterTimeStart: _s, filterTimeEnd: _e, ...rest } = next as FailureModel & LegacyModelTime;
            next = rest as FailureModel;
        }
        if (next !== m) changed = true;
        return next;
    });

    const patch: Partial<FailureGroupStateSlice> = {};
    if (fg.runningConditionTimePeriods === undefined) {
        const oldFg = fg as FailureGroupStateSlice & LegacyFgTime;
        patch.runningConditionTimePeriods = legacyPeriods(oldFg.runningConditionTimeStart, oldFg.runningConditionTimeEnd);
    }
    if (changed) patch.models = models;

    let out = state;
    if (Object.keys(patch).length) out = withFailureGroupState(state, patch);

    if (drop && ('runningConditionTimeStart' in fg || 'runningConditionTimeEnd' in fg)) {
        const { runningConditionTimeStart: _s, runningConditionTimeEnd: _e, ...rest } = out.failureGroupState as FailureGroupStateSlice & LegacyFgTime;
        out = { ...out, failureGroupState: rest };
    }
    return out;
}

/** (b) One-time per-sensor category normalisation. Sets the notice only when
 *  `categoryNormalisationNotice === undefined`: the changes if any, else `null`
 *  (so it never re-fires). */
export function normalizeCategories(state: WorkspaceState): WorkspaceState {
    const fg = state.failureGroupState;
    if (!fg || fg.categoryNormalisationNotice !== undefined) return state;
    const { models, changes } = normalizeSensorCategories(fg.models);
    return withFailureGroupState(state, {
        models,
        categoryNormalisationNotice: changes.length ? changes : null,
    });
}

/** (d) Health score set points: a model without `healthSetPoints`
 *  gets the EMPTY shape for its kind. No master snapshot is taken here -- this
 *  step has no sensor metadata, so an Individual model's snapshot stays
 *  "not taken yet" (`undefined`) for `ensureHealthSetPoints` to fill the first
 *  time it is opened with metadata. Idempotent: models that already have the
 *  field are untouched, and nothing to do returns the SAME state object. */
export function migrateHealthSetPoints(state: WorkspaceState): WorkspaceState {
    const fg = state.failureGroupState;
    if (!fg || !Array.isArray(fg.models)) return state;
    let changed = false;
    const models = fg.models.map((m) => {
        const next = ensureHealthSetPoints(m);
        if (next !== m) changed = true;
        return next;
    });
    return changed ? withFailureGroupState(state, { models }) : state;
}

/**
 * (e) ONE running condition: "Machine is running when <sensor> is above <value>"
 * (user decision 2026-10-26). An old condition that is anything else (several
 * conditions, AND / OR, "<", "between", "=", Use all rows, the export's own
 * "Machine is running when …" line) is converted:
 *   - keep the FIRST complete "sensor > value" condition; else
 *   - the export's saved running status (workspace only); else
 *   - nothing: the running condition must be set again (Train is blocked).
 * Complete models whose training rows change go back to Incomplete in the same
 * result (set points, results and fingerprint are kept, so they show "Needs
 * re-train"; a saved `healthVerdict` / `testsChangedAt` is dropped, as
 * `applyIncompleteRule` does for a training-input change). Custom models: the
 * same on their own condition (no saved-status fallback). The old export line
 * (`runningStatus`) is cleared. When only blank / half-filled rows are dropped
 * next to the one ">" (the rows stay the same), the kept row is left
 * byte-for-byte, so no fingerprint moves and no model changes.
 *
 * The SHAPE is data-driven: it is normalised on every read whenever the
 * workspace (or a Custom model) is not one ">" row (or nothing), or still
 * carries an old "Use all rows", whatever the
 * marker says — a file saved by an older build can bring the old shape back
 * after the marker was set. The marker (`runningConditionConversion`) only
 * decides whether a notice record is written: `undefined` (first run) writes
 * one when some model's training rows change (else `null`); `null` or a record
 * (already handled) normalises silently and leaves the marker as it is.
 *
 * Runs on EVERY workspace read (`workspaceManager.ts`), so every window —
 * including the Dashboard's autosave, which adopts the on-disk slice — sees
 * the converted shape and nothing writes the old set back; the first write of
 * any window persists it. Idempotent and deterministic; nothing to do returns
 * the SAME state object.
 */
type SavedStatus = { sensor: string; stopAtOrBelow: string } | null | undefined;
const finiteText = (t: string | undefined): string | null => {
    const x = (t ?? '').trim();
    return x !== '' && Number.isFinite(Number(x)) ? x : null;
};
const isAbove = (f: WorkspaceSensorFilter): boolean =>
    f.operation === 'greater_than' && !!f.sensor?.trim() && finiteText(f.value1) !== null;
/** Already the one shape: a single ">" row. Its value may still be blank or
 *  being typed (a Custom draft is saved as it is) -- the gate blocks Train
 *  until it is complete, so it is never "converted" (that would wipe the
 *  sensor the user just picked). */
const isOneShape = (filters: WorkspaceSensorFilter[]): boolean => filters.length === 1 && filters[0].operation === 'greater_than';

interface SingleResult {
    filters: WorkspaceSensorFilter[];
    /** The stored condition list changes. */
    changed: boolean;
    /** The rows it keeps change (models trained on it must train again). */
    rowsChanged: boolean;
    kept: 'first-above' | 'saved-status' | null;
}

function toSingle(filters: WorkspaceSensorFilter[], none: boolean, saved: SavedStatus): SingleResult {
    const savedOk = !!saved && (saved.sensor ?? '').trim() !== '' && finiteText(saved.stopAtOrBelow) !== null;
    // Already the one shape, or nothing set at all: nothing to convert.
    if (!none && isOneShape(filters)) return { filters, changed: false, rowsChanged: false, kept: null };
    if (!none && filters.length === 0 && !savedOk) return { filters, changed: false, rowsChanged: false, kept: null };
    const first = none ? undefined : filters.find(isAbove);
    if (first) {
        // The rows stay the same only when that was the ONLY applied condition
        // (blank / half-filled rows never filtered anything).
        const applied = filters.filter(f => isCompleteCondition(f));
        const rowsChanged = !(applied.length === 1 && applied[0] === first);
        // Rows unchanged: keep the row byte-for-byte (its fingerprint must not move).
        const kept = rowsChanged ? { ...first, value1: first.value1.trim(), value2: '' } : first;
        return { filters: [kept], changed: true, rowsChanged, kept: 'first-above' };
    }
    if (savedOk && saved) {
        return {
            filters: [{ id: 'rc-converted', sensor: saved.sensor, operation: 'greater_than', value1: saved.stopAtOrBelow.trim(), value2: '' }],
            changed: true, rowsChanged: true, kept: 'saved-status',
        };
    }
    return { filters: [], changed: true, rowsChanged: true, kept: null };
}

/** A model whose training rows changed: Incomplete if it was Complete, and the
 *  verdict / scoring-change stamp of the old fit dropped (set points, results
 *  and fingerprint kept). */
function demote(m: FailureModel): FailureModel {
    if (!m.status && m.healthVerdict === undefined && m.testsChangedAt === undefined) return m;
    const { healthVerdict: _v, testsChangedAt: _t, ...rest } = m;
    void _v;
    void _t;
    return m.status ? { ...rest, status: false } : rest;
}

export function migrateSingleRunningCondition(state: WorkspaceState): WorkspaceState {
    const fg = state.failureGroupState;
    if (!fg || !Array.isArray(fg.models)) return state;
    const firstRun = fg.runningConditionConversion === undefined;
    const ws = toSingle(fg.runningConditionFilters ?? [], !!fg.runningConditionNoneConfirmed, fg.runningStatus);
    const incomplete: string[] = [];
    const customModels: RunningConditionConversion['customModels'] = [];
    let modelsChanged = false;
    const models = fg.models.map((m): FailureModel => {
        let next = m;
        if (m.runningConditionMode === 'custom') {
            const own = toSingle(m.customRunningConditionFilters ?? [], !!m.customRunningConditionNoneConfirmed, null);
            if (!own.changed) return m;
            next = {
                ...m,
                customRunningConditionFilters: own.filters,
                customRunningConditionCombine: own.rowsChanged ? 'and' : (m.customRunningConditionCombine ?? 'and'),
                customRunningConditionNoneConfirmed: false,
            };
            if (own.rowsChanged) {
                // Only a model whose rows change needs the user's attention.
                customModels.push({ id: m.id, result: own.kept ? 'converted' : 'needs-set' });
                if (m.status) incomplete.push(m.id);
                next = demote(next);
            }
        } else if (ws.rowsChanged) {
            if (m.status) incomplete.push(m.id);
            next = demote(m);
        }
        if (next !== m) modelsChanged = true;
        return next;
    });

    const patch: Partial<FailureGroupStateSlice> = {};
    if (fg.runningStatus != null) patch.runningStatus = null;
    if (fg.rcLegacyNotice === 'pending') patch.rcLegacyNotice = null;
    if (modelsChanged) patch.models = models;
    if (ws.changed) {
        patch.runningConditionFilters = ws.filters;
        patch.runningConditionNoneConfirmed = false;
        if (ws.rowsChanged) patch.runningConditionCombine = 'and';
    }
    if (firstRun) {
        if (!ws.rowsChanged && customModels.length === 0) {
            // Nothing the user must look at (pure cleanup, or nothing to do).
            patch.runningConditionConversion = null;
        } else {
            patch.runningStatus = null;
            const current = ws.filters[0];
            const after = current && isAbove(current) ? { sensor: current.sensor, value: current.value1.trim() } : null;
            patch.runningConditionConversion = {
                result: after ? 'converted' : 'needs-set',
                source: ws.kept,
                before: {
                    // Only rows that applied: a notice never shows blank rows.
                    filters: (fg.runningConditionFilters ?? []).filter(f => isCompleteCondition(f)),
                    combine: fg.runningConditionCombine ?? 'and',
                    allRows: !!fg.runningConditionNoneConfirmed,
                    savedStatus: fg.runningStatus ?? null,
                },
                after,
                incompleteModelIds: incomplete,
                customModels,
            };
        }
    }
    return Object.keys(patch).length ? withFailureGroupState(state, patch) : state;
}
