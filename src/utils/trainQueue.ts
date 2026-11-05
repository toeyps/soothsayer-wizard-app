/** Pure rules of the train queue (state lives in `useTrainQueue`), so the preflight modal, Train buttons, run strip and hook read one rule set. Plans use `buildBlockReason(m)` + `missingItems(m)` for 'can't train' and `modelDotState` for 'up to date' (a failed run this session overrides `trained`). */

import type { ModelDotState } from './modelStatus';
import { isStaleSessionText } from './staleSession';
import { WORKSPACE_DUPLICATE_NAME_REASON } from './modelNames';
import {
    CATEGORY_BLOCK_REASON,
    NO_RUNNING_CONDITION_REASON,
    NO_TRAIN_PERIOD_REASON,
    NO_TRAIN_PERIOD_REASON_CUSTOM,
    NO_TRAIN_DATA_SHORT,
    NO_TRAIN_ROWS_FOOTER,
    noTrainDataKindOf,
} from './runningCondition';
import type { ModelKind } from '../types';
import type {
    TrainCandidate,
    TrainFixTarget,
    TrainPlan,
    TrainQueueItem,
    TrainRun,
    TrainRunCounts,
    TrainRunSummary,
} from '../types/trainQueue';


/** `modelBlockReason`'s generic text; only valid right under the Model settings form, where 'above' is true. Elsewhere name the missing setting. */
export const REQUIRED_FIELDS_BLOCK_REASON = 'Fill in the required fields above first';

/** STALE_SESSION wording of the Build Model window, reused by the run strip, sidebar line and Train-sensor reason. */
export const TRAIN_STALE_MESSAGE =
    'The data in this window is out of date. Close it and open Build Model again from the Dashboard.';

/** Why both Train buttons are disabled when the workspace running condition is not set. */
export const TRAIN_NEEDS_RUNNING_CONDITION = 'Set the running condition first.';

/** Why both Train buttons are disabled when no model is ready. */
export const TRAIN_NOTHING_READY = 'Nothing is ready to train.';

/** The up-to-date reasons (grey "Skipped — …"). */
export const UP_TO_DATE_REASON = 'up to date';
export const COMPLETE_UP_TO_DATE_REASON = 'Complete, up to date';

/** `missingItems(m)`'s "Pick a category" as a reason that stands alone. */
const NO_CATEGORY_REASON = 'No category (Performance or Condition) on the sensor';

/** A reason on its own line: no trailing full stop; 'P2'/'S1' prefixes become 'Train period P2'/'Scoring period S1'. */
function toReason(text: string): string {
    let t = text.trim().replace(/\.+$/, '');
    t = t.replace(/^(P\d+)\b/, 'Train period $1');
    t = t.replace(/^(S\d+)\b/, 'Scoring period $1');
    return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/** Reason a model can't train, for the preflight list, run results and Train menu: a short sentence naming the FIRST missing setting ('(+N more)'), plus where 'Fix →' goes. The generic 'above' text is never shown here. `customMode` = the draft uses Custom training data. */
export function preflightReason(
    blockReason: string,
    opts: { missing?: string[]; customMode?: boolean } = {},
): { text: string; fix: TrainFixTarget } {
    const custom = !!opts.customMode;
    const rcFix: TrainFixTarget = custom ? 'settings' : 'runningCondition';
    if (blockReason === CATEGORY_BLOCK_REASON) {
        return { text: NO_CATEGORY_REASON, fix: 'category' };
    }
    if (blockReason === REQUIRED_FIELDS_BLOCK_REASON) {
        return { text: missingSettingsText(opts.missing ?? []), fix: 'settings' };
    }
    if (blockReason === WORKSPACE_DUPLICATE_NAME_REASON) {
        return { text: 'Model name already used by another model in this project', fix: 'settings' };
    }
    if (blockReason === NO_RUNNING_CONDITION_REASON) {
        return { text: custom ? 'No running condition in its own training data' : 'No running condition', fix: rcFix };
    }
    if (blockReason === NO_TRAIN_PERIOD_REASON) return { text: 'No train period', fix: 'runningCondition' };
    if (blockReason === NO_TRAIN_PERIOD_REASON_CUSTOM) return { text: 'No train period in its own training data', fix: 'settings' };
    // Truly nothing to train on: no train period in the loaded data, or the counted train periods hold no running row.
    const noData = noTrainDataKindOf(blockReason);
    if (noData) {
        const words = noData.cause === 'outside-data' ? NO_TRAIN_DATA_SHORT : NO_TRAIN_ROWS_FOOTER;
        return noData.mode === 'custom'
            ? { text: `${words} in its own training data`, fix: 'settings' }
            : { text: words, fix: 'runningCondition' };
    }
    // Invalid train periods come from the gate / Save's check; invalid Custom scoring periods from Save's own check.
    if (/^P\d+\b/.test(blockReason)) return { text: toReason(blockReason), fix: rcFix };
    return { text: toReason(blockReason), fix: 'settings' };
}

/** A train that failed because there was nothing to train on, in the app's words; null for any other failure. Rust sends no code, so match its text: Individual 'No valid numeric values for sensor ...'; Relation/Clustering 'No rows remain after dropping nulls.'; `NO_DATA: ... no rows ...` from the health preview. */
export function noRowsTrainError(message: string, customMode: boolean): string | null {
    const m = message.trim();
    const hit = /^No rows remain after dropping nulls\.?$/i.test(m)
        || /^No valid numeric values for sensor\b/i.test(m)
        || /^NO_DATA:.*\bno rows\b/i.test(m);
    if (!hit) return null;
    return `${NO_TRAIN_ROWS_FOOTER} — no row inside the train periods passes the running condition with values for this model. Widen a train period or relax the condition ${customMode ? 'in Model settings → Training data (Custom)' : '(Running condition → Edit)'}.`;
}

/** `missingItems(m)` as one short reason: the first missing setting, then '(+N more)'; the category is its own reason and not counted. */
export function missingSettingsText(missing: readonly string[]): string {
    const items = missing.filter(item => item !== 'Pick a category').map(toReason);
    if (items.length === 0) return 'Model settings are incomplete';
    return `${items[0]}${items.length > 1 ? ` (+${items.length - 1} more)` : ''}`;
}

/** Classify a model before a run: a block reason = `missing`; `complete`, or `trained` with no failed run = `upToDate`; else `ready`. */
export function classifyTrainPlan(input: {
    blockReason: string | null;
    dotState: ModelDotState;
    /** A train of this model failed in this window's session (`trainError[id]`). */
    hasSessionError?: boolean;
    missing?: string[];
    customMode?: boolean;
}): TrainPlan {
    if (input.blockReason !== null) {
        const r = preflightReason(input.blockReason, { missing: input.missing, customMode: input.customMode });
        return { kind: 'missing', reason: r.text, fix: r.fix };
    }
    if (input.dotState === 'complete') return { kind: 'upToDate', reason: COMPLETE_UP_TO_DATE_REASON, complete: true };
    if (input.dotState === 'trained' && !input.hasSessionError) {
        return { kind: 'upToDate', reason: UP_TO_DATE_REASON, complete: false };
    }
    return { kind: 'ready' };
}

/** "9 ready · 0 up to date · 1 can't train" (Train all's count line). */
export function countTrainPlans(candidates: readonly TrainCandidate[]): { ready: number; upToDate: number; missing: number; completeUpToDate: number } {
    let ready = 0, upToDate = 0, missing = 0, completeUpToDate = 0;
    for (const c of candidates) {
        if (c.plan.kind === 'ready') ready++;
        else if (c.plan.kind === 'upToDate') {
            upToDate++;
            if (c.plan.complete) completeUpToDate++;
        } else missing++;
    }
    return { ready, upToDate, missing, completeUpToDate };
}

/** Run items in candidate order: `ready` (and `upToDate` if `includeUpToDate`) are queued, the rest skipped with a reason. */
export function planTrainRun(candidates: readonly TrainCandidate[], includeUpToDate: boolean): TrainQueueItem[] {
    const seen = new Set<string>();
    const items: TrainQueueItem[] = [];
    for (const c of candidates) {
        if (seen.has(c.id)) continue; // a sensor in two FGs lists the same model twice
        seen.add(c.id);
        const p = c.plan;
        if (p.kind === 'ready' || (p.kind === 'upToDate' && includeUpToDate)) {
            items.push({ id: c.id, kind: c.kind, state: 'queued' });
        } else if (p.kind === 'upToDate') {
            items.push({ id: c.id, kind: c.kind, state: 'skipped', skip: { kind: 'upToDate', reason: p.reason } });
        } else {
            items.push({ id: c.id, kind: c.kind, state: 'skipped', skip: { kind: 'missing', reason: p.reason } });
        }
    }
    return items;
}


/** True for a train error that means "this window's data is not current". */
export function isStaleTrainError(text: string): boolean {
    return isStaleSessionText(text);
}

export function countTrainRun(run: TrainRun): TrainRunCounts {
    const c: TrainRunCounts = {
        planned: 0, queued: 0, running: 0, trained: 0, failed: 0,
        skipped: 0, skippedUpToDate: 0, skippedMissing: 0, removed: 0, notStarted: 0,
    };
    for (const it of run.items) {
        switch (it.state) {
            case 'queued': c.queued++; break;
            case 'running': c.running++; break;
            case 'trained': c.trained++; break;
            case 'failed': c.failed++; break;
            case 'removed': c.removed++; break;
            case 'notStarted': c.notStarted++; break;
            case 'skipped':
                c.skipped++;
                if (it.skip?.kind === 'upToDate') c.skippedUpToDate++;
                else c.skippedMissing++;
                break;
        }
    }
    // Skipped-at-its-turn models were planned too; preflight skips were not.
    const skippedAtTurn = run.items.filter(it => it.state === 'skipped' && it.skip?.atTurn).length;
    c.planned = c.queued + c.running + c.trained + c.failed + c.notStarted + skippedAtTurn;
    return c;
}

/** Text for the strip, Details modal and close dialog; a stale run shows TRAIN_STALE_MESSAGE. */
export function summarizeTrainRun(run: TrainRun): TrainRunSummary {
    const counts = countTrainRun(run);
    const trainedIds = run.items.filter(it => it.state === 'trained').map(it => it.id);
    const failedIds = run.items.filter(it => it.state === 'failed').map(it => it.id);
    const notStartedIds = run.items.filter(it => it.state === 'notStarted').map(it => it.id);
    const tail = [
        counts.failed ? `${counts.failed} failed` : '',
        counts.skipped ? `${counts.skipped} skipped` : '',
        counts.removed ? `${counts.removed} removed` : '',
    ].filter(Boolean);

    if (run.phase === 'running') {
        const finished = counts.planned - counts.queued - counts.running;
        const index = Math.min(finished + 1, Math.max(counts.planned, 1));
        return {
            counts, outcome: 'running', tone: 'neutral',
            text: `Training ${index} of ${counts.planned}`,
            position: { index, of: counts.planned },
            trainedIds, failedIds, notStartedIds,
        };
    }
    if (run.phase === 'stopped' || run.phase === 'stale') {
        const parts = ['Stopped', `${counts.trained} trained`];
        if (counts.failed) parts.push(`${counts.failed} failed`);
        parts.push(`${counts.notStarted} not started`);
        return {
            counts,
            outcome: run.phase,
            tone: run.phase === 'stale' ? 'danger' : counts.failed ? 'warning' : 'neutral',
            text: parts.join(' · '),
            position: null, trainedIds, failedIds, notStartedIds,
        };
    }
    const outcome = counts.failed === 0 ? 'done' : counts.trained === 0 ? 'failed' : 'partial';
    const tone = outcome === 'failed' ? 'danger' : outcome === 'partial' ? 'warning' : counts.trained ? 'success' : 'neutral';
    return {
        counts, outcome, tone,
        text: ['Done', `${counts.trained} trained`, ...tail].join(' · '),
        position: null, trainedIds, failedIds, notStartedIds,
    };
}

/** 1-based place among the models still waiting ("Queued · next" = 1), else 0. */
export function queuePosition(run: TrainRun | null, id: string): number {
    if (!run || run.phase !== 'running') return 0;
    let n = 0;
    for (const it of run.items) {
        if (it.state !== 'queued') continue;
        n++;
        if (it.id === id) return n;
    }
    return 0;
}

/** Time left in ms: mean duration of finished models (per kind once that kind has one, else all) × models still to go. Null until one finishes or when not running. */
export function estimateTimeLeftMs(run: TrainRun | null): number | null {
    if (!run || run.phase !== 'running') return null;
    const done = run.items.filter(it => (it.state === 'trained' || it.state === 'failed') && typeof it.durationMs === 'number');
    if (done.length === 0) return null;
    const all = done.reduce((a, it) => a + (it.durationMs as number), 0) / done.length;
    const perKind = new Map<ModelKind, number>();
    for (const k of ['individual', 'relationship', 'clustering'] as ModelKind[]) {
        const ks = done.filter(it => it.kind === k);
        if (ks.length) perKind.set(k, ks.reduce((a, it) => a + (it.durationMs as number), 0) / ks.length);
    }
    let left = 0;
    for (const it of run.items) {
        if (it.state === 'queued' || it.state === 'running') left += perKind.get(it.kind) ?? all;
    }
    return Math.round(left);
}

/** Rough seconds per kind before anything ran: Relation model ~15 (Python sidecar), Clustering ~2, Individual ~1. */
export const ROUGH_TRAIN_SECONDS: Record<ModelKind, number> = { individual: 1, relationship: 15, clustering: 2 };

export function roughTrainSeconds(kinds: readonly ModelKind[]): number {
    return kinds.reduce((a, k) => a + ROUGH_TRAIN_SECONDS[k], 0);
}

/** "45 s", "2 min", "2 min 10 s" (rounded up to whole seconds; "1 s" minimum). */
export function formatTrainSeconds(seconds: number): string {
    const s = Math.max(1, Math.ceil(seconds));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
}

/** Why both Train buttons are disabled, or null. Order: STALE_SESSION, no running condition, a run active (null: the strip says it), nothing ready. */
export function trainButtonsBlockedReason(input: {
    stale: boolean;
    runningConditionSet: boolean;
    running: boolean;
    readyCount: number;
}): string | null {
    if (input.stale) return TRAIN_STALE_MESSAGE;
    if (!input.runningConditionSet) return TRAIN_NEEDS_RUNNING_CONDITION;
    if (input.running) return null;
    if (input.readyCount === 0) return TRAIN_NOTHING_READY;
    return null;
}
