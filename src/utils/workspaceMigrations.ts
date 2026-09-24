import type { FailureGroupStateSlice, FailureModel, TimePeriod, WorkspaceState } from '../types';
import { withFailureGroupState } from './failureGroupState';
import { normalizeSensorCategories } from './modelGrouping';
import { isWorkspaceRunningConditionConfigured } from './runningCondition';

/*
 * Feature 4 migrations. Each step is a PURE, independently idempotent function
 * gated on its OWN marker being `undefined` (`null` and any value both mean
 * "already handled"). Nothing here is wired into `loadWorkspaceData` yet — each
 * UI phase switches its own step on. Every step spreads the existing slice
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

export interface MigrationSteps {
    periods?: boolean;
    categories?: boolean;
    gate?: boolean;
    /** Only with `periods`: also delete the old start/end keys. */
    dropLegacyKeys?: boolean;
}

/** Runs the chosen steps in order: periods -> categories -> gate. */
export function migrateToLatest(state: WorkspaceState, steps: MigrationSteps = {}): WorkspaceState {
    let s = state;
    if (steps.periods) s = migratePeriods(s, { dropLegacyKeys: steps.dropLegacyKeys });
    if (steps.categories) s = normalizeCategories(s);
    if (steps.gate) s = flagLegacyGate(s);
    return s;
}
