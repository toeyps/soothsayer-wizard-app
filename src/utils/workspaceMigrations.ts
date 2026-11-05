import type { FailureGroupStateSlice, FailureModel, RunningConditionConversion, TimePeriod, WorkspaceSensorFilter, WorkspaceState } from '../types';
import { withFailureGroupState } from './failureGroupState';
import { ensureHealthSetPoints } from './healthSetPoints';
import { normalizeSensorCategories } from './modelGrouping';
import { isCompleteCondition } from './runningCondition';
import { normalizeSensorTag } from '../hooks/useSensorMetaMap';

/* Read-path migrations run by workspaceManager (migrateHealthSetPoints, migrateSingleRunningCondition): pure, idempotent, gated on their own marker being undefined (null or any value = handled); the single-condition shape check always runs. Each spreads the slice via withFailureGroupState; nothing to do returns the same state object. */

/** Pre-periods shape: the type no longer declares these keys, but old files carry them. */
type LegacyModelTime = { filterTimeStart?: string; filterTimeEnd?: string };
type LegacyFgTime = { runningConditionTimeStart?: string; runningConditionTimeEnd?: string };

function legacyPeriods(start: string | undefined, end: string | undefined): TimePeriod[] {
    return start || end ? [{ id: 'legacy-1', start: start ?? '', end: end ?? '' }] : [];
}

/** (a) Old single time ranges become period lists (workspace and per model) and seed customRunningConditionNoneConfirmed: false. Old keys stay unless `dropLegacyKeys`, which deletes them even if periods exist. */
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

/** (b) One-time per-sensor category normalisation; sets the notice (the changes, else null) only while categoryNormalisationNotice is undefined. */
export function normalizeCategories(state: WorkspaceState): WorkspaceState {
    const fg = state.failureGroupState;
    if (!fg || fg.categoryNormalisationNotice !== undefined) return state;
    const { models, changes } = normalizeSensorCategories(fg.models);
    return withFailureGroupState(state, {
        models,
        categoryNormalisationNotice: changes.length ? changes : null,
    });
}

/** (d) A model without healthSetPoints gets the empty shape for its kind, with no master snapshot (no sensor metadata here). */
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

/** (e) One running condition ('Machine is running when <sensor> is above <value>'). Others convert: keep the first complete 'sensor > value', else the saved export running status (workspace only), else unset (Train blocked). Shape is normalised on EVERY read whatever the marker says (an old build can bring the old shape back); the marker only decides the notice. Models whose training rows change go Incomplete; set points and fingerprint are kept. */
type SavedStatus = { sensor: string; stopAtOrBelow: string } | null | undefined;
const finiteText = (t: string | undefined): string | null => {
    const x = (t ?? '').trim();
    return x !== '' && Number.isFinite(Number(x)) ? x : null;
};
const isAbove = (f: WorkspaceSensorFilter): boolean =>
    f.operation === 'greater_than' && !!f.sensor?.trim() && finiteText(f.value1) !== null;
/** Already the one shape: a single '>' row, even if blank or half-typed (the gate blocks Train; converting would wipe the picked sensor). */
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

/** A model whose training rows changed: Incomplete if it was Complete, old healthVerdict/testsChangedAt dropped; set points, results and fingerprint kept. */
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
        const custom = m.runningConditionMode === 'custom';
        // A Workspace-mode model's own list is converted too (it returns on a switch to Custom), but it trains on the workspace's rows, so only those count.
        const own = toSingle(m.customRunningConditionFilters ?? [], !!m.customRunningConditionNoneConfirmed, null);
        let next = m;
        if (own.changed) {
            next = {
                ...m,
                customRunningConditionFilters: own.filters,
                customRunningConditionCombine: own.rowsChanged ? 'and' : (m.customRunningConditionCombine ?? 'and'),
                customRunningConditionNoneConfirmed: false,
            };
        }
        if (custom ? own.rowsChanged : ws.rowsChanged) {
            // Only a Custom model whose rows change needs its own line in the notice.
            if (custom) customModels.push({ id: m.id, result: own.kept ? 'converted' : 'needs-set' });
            if (m.status) incomplete.push(m.id);
            next = demote(next);
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

/** Rewrites running conditions to the exact header spelling for models trained while Rust ignored a differently spelled condition (all rows used); via applyIncompleteRule they read stale. Matches like Rust's resolve_sensor: exact, then the first trimmed case-insensitive header. Needs the session's headers, so it can't run on the read path. */
export function normalizeConditionSpelling(state: WorkspaceState, headers: readonly string[]): WorkspaceState {
    const fg = state.failureGroupState;
    if (!fg) return state;
    const exact = new Set(headers);
    const byKey = new Map<string, string>();
    for (const h of headers) {
        const k = normalizeSensorTag(h);
        if (!byKey.has(k)) byKey.set(k, h);
    }
    const respell = <T extends WorkspaceSensorFilter[] | undefined>(filters: T): T => {
        if (!Array.isArray(filters)) return filters;
        let changed = false;
        const out = filters.map((f) => {
            if (typeof f?.sensor !== 'string' || !f.sensor.trim() || exact.has(f.sensor)) return f;
            const header = byKey.get(normalizeSensorTag(f.sensor));
            if (header === undefined) return f;
            changed = true;
            return { ...f, sensor: header };
        });
        return (changed ? out : filters) as T;
    };

    const patch: Partial<FailureGroupStateSlice> = {};
    const workspace = respell(fg.runningConditionFilters);
    if (workspace !== fg.runningConditionFilters) patch.runningConditionFilters = workspace;
    if (Array.isArray(fg.models)) {
        let modelsChanged = false;
        const models = fg.models.map((m) => {
            const own = respell(m.customRunningConditionFilters);
            if (own === m.customRunningConditionFilters) return m;
            modelsChanged = true;
            return { ...m, customRunningConditionFilters: own };
        });
        if (modelsChanged) patch.models = models;
    }
    return Object.keys(patch).length ? withFailureGroupState(state, patch) : state;
}
