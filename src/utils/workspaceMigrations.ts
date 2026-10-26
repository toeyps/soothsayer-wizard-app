import type { FailureGroupStateSlice, FailureModel, RunningConditionConversion, TimePeriod, WorkspaceSensorFilter, WorkspaceState } from '../types';
import { withFailureGroupState } from './failureGroupState';
import { ensureHealthSetPoints } from './healthSetPoints';
import { normalizeSensorCategories } from './modelGrouping';
import { isCompleteCondition, isWorkspaceRunningConditionConfigured } from './runningCondition';

/*
 * Workspace migrations (`migrateHealthSetPoints` and `migrateSingleRunningCondition` are run by
 * `workspaceManager.ts` on EVERY workspace read). Each step is a PURE,
 * independently idempotent function gated on its OWN marker being `undefined`
 * (`null` and any value both mean "already handled"). Every step spreads the
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

/** (c) Flags a legacy workspace (has models, workspace running condition not
 *  configured) as `rcLegacyNotice: 'pending'`; otherwise `null`. Header-blind. */
export function flagLegacyGate(state: WorkspaceState): WorkspaceState {
    const fg = state.failureGroupState;
    if (!fg || fg.rcLegacyNotice !== undefined) return state;
    const pending = fg.models.length > 0 && !isWorkspaceRunningConditionConfigured(fg);
    return withFailureGroupState(state, { rcLegacyNotice: pending ? 'pending' : null });
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
 * "Machine is running when …" line) is converted once:
 *   - keep the FIRST complete "sensor > value" condition; else
 *   - the export's saved running status (workspace only); else
 *   - nothing: the running condition must be set again (Train is blocked).
 * Complete models whose training rows change go back to Incomplete in the same
 * result (set points, results and fingerprint are kept, so they show "Needs
 * re-train"; a saved `healthVerdict` / `testsChangedAt` is dropped, as
 * `applyIncompleteRule` does for a training-input change). Custom models: the
 * same on their own condition (no saved-status fallback). The old export line
 * (`runningStatus`) is cleared.
 *
 * Runs on EVERY workspace read (`workspaceManager.ts`), so every window —
 * including the Dashboard's autosave, which adopts the on-disk slice — sees
 * the converted shape and nothing writes the old set back; the first write of
 * any window persists it. Gated on its own marker
 * (`runningConditionConversion === undefined`); idempotent and deterministic
 * (re-reading the same unconverted file gives the same result).
 */
type SavedStatus = { sensor: string; stopAtOrBelow: string } | null | undefined;
const finiteText = (t: string | undefined): string | null => {
    const x = (t ?? '').trim();
    return x !== '' && Number.isFinite(Number(x)) ? x : null;
};
const isAbove = (f: WorkspaceSensorFilter): boolean =>
    f.operation === 'greater_than' && !!f.sensor?.trim() && finiteText(f.value1) !== null;
const isOneAbove = (filters: WorkspaceSensorFilter[]): boolean => filters.length === 1 && isAbove(filters[0]);

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
    if (!none && isOneAbove(filters)) return { filters, changed: false, rowsChanged: false, kept: null };
    if (!none && filters.length === 0 && !savedOk) return { filters, changed: false, rowsChanged: false, kept: null };
    const first = none ? undefined : filters.find(isAbove);
    if (first) {
        // The rows stay the same only when that was the ONLY applied condition
        // (blank / half-filled rows never filtered anything).
        const applied = filters.filter(f => isCompleteCondition(f));
        const rowsChanged = !(applied.length === 1 && applied[0] === first);
        return { filters: [{ ...first, value1: first.value1.trim(), value2: '' }], changed: true, rowsChanged, kept: 'first-above' };
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
    if (!fg || !Array.isArray(fg.models) || fg.runningConditionConversion !== undefined) return state;
    const ws = toSingle(fg.runningConditionFilters ?? [], !!fg.runningConditionNoneConfirmed, fg.runningStatus);
    const incomplete: string[] = [];
    const customModels: RunningConditionConversion['customModels'] = [];
    const models = fg.models.map((m): FailureModel => {
        if (m.runningConditionMode === 'custom') {
            const own = toSingle(m.customRunningConditionFilters ?? [], !!m.customRunningConditionNoneConfirmed, null);
            if (!own.changed) return m;
            customModels.push({ id: m.id, result: own.kept ? 'converted' : 'needs-set' });
            let next: FailureModel = {
                ...m,
                customRunningConditionFilters: own.filters,
                customRunningConditionCombine: own.rowsChanged ? 'and' : (m.customRunningConditionCombine ?? 'and'),
                customRunningConditionNoneConfirmed: false,
            };
            if (own.rowsChanged) {
                if (m.status) incomplete.push(m.id);
                next = demote(next);
            }
            return next;
        }
        if (!ws.rowsChanged) return m;
        if (m.status) incomplete.push(m.id);
        return demote(m);
    });
    if (!ws.changed && customModels.length === 0) {
        return withFailureGroupState(state, {
            runningConditionConversion: null,
            ...(fg.runningStatus != null ? { runningStatus: null } : {}),
        });
    }
    const current = ws.filters[0];
    const after = current && isAbove(current) ? { sensor: current.sensor, value: current.value1.trim() } : null;
    const conversion: RunningConditionConversion = {
        result: after ? 'converted' : 'needs-set',
        source: ws.kept,
        before: {
            filters: fg.runningConditionFilters ?? [],
            combine: fg.runningConditionCombine ?? 'and',
            allRows: !!fg.runningConditionNoneConfirmed,
            savedStatus: fg.runningStatus ?? null,
        },
        after,
        incompleteModelIds: incomplete,
        customModels,
    };
    const patch: Partial<FailureGroupStateSlice> = {
        runningStatus: null,
        models,
        runningConditionConversion: conversion,
        rcLegacyNotice: null,
    };
    if (ws.changed) {
        patch.runningConditionFilters = ws.filters;
        patch.runningConditionNoneConfirmed = false;
        if (ws.rowsChanged) patch.runningConditionCombine = 'and';
    }
    return withFailureGroupState(state, patch);
}
