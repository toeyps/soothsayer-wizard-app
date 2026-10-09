/**
 * Pure rules of the train queue (customer batch 2026-10, items 8 + 9). The
 * stateful part is `useTrainQueue` (`src/hooks/useTrainQueue.ts`); everything
 * here is plain functions so the preflight modal, the Train buttons, the run
 * strip and the hook all read ONE set of rules.
 *
 * Nothing here invents a new train rule: a model's plan is built from the two
 * rules the Build Model window already has —
 *   - `buildBlockReason(m)` (= `modelBlockReason` ?? `getBuildBlockReason`) for
 *     "can't train", with `missingItems(m)` for the specifics, and
 *   - `modelDotState` (`utils/modelStatus.ts`) for "up to date"
 *     (`trained` / `complete`; a failed run this session overrides `trained`).
 */

import type { ModelDotState } from './modelStatus';
import { isStaleSessionText } from './staleSession';
import {
    CATEGORY_BLOCK_REASON,
    NO_RUNNING_CONDITION_REASON,
    NO_TRAIN_PERIOD_REASON,
    NO_TRAIN_PERIOD_REASON_CUSTOM,
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

// ---------------------------------------------------------------------------
// Copy shared with the Build Model window
// ---------------------------------------------------------------------------

/** `modelBlockReason`'s generic text in the Build Model window (Save / footer).
 *  It reads wrong inside the preflight list ("above" is not above there), so
 *  `preflightReason` replaces it with the specific missing settings. */
export const REQUIRED_FIELDS_BLOCK_REASON = 'Fill in the required fields above first';

/** `DUPLICATE_NAME_BLOCK_REASON` in the Build Model window. */
export const DUPLICATE_NAME_BLOCK_REASON = 'Model name is already used by another model of this sensor';

/** The shipped STALE_SESSION wording of the Build Model window (Mark complete),
 *  reused by the run strip, the sidebar line and the Train-sensor reason. */
export const TRAIN_STALE_MESSAGE =
    'The data in this window is out of date. Close it and open Build Model again from the Dashboard.';

/** Why both Train buttons are disabled when the workspace running condition is not set. */
export const TRAIN_NEEDS_RUNNING_CONDITION = 'Set the running condition first (Step 1).';

/** Why both Train buttons are disabled when no model is ready. */
export const TRAIN_NOTHING_READY = 'Nothing is ready to train.';

/** The up-to-date reasons (grey "Skipped — …"). */
export const UP_TO_DATE_REASON = 'up to date';
export const COMPLETE_UP_TO_DATE_REASON = 'Complete, up to date';

/** `missingItems(m)` text (Build Model window) → the short phrase the
 *  preflight row shows after "Can't train — ". */
const MISSING_ITEM_PHRASES: Record<string, string> = {
    'Pick a category': 'no category (Performance or Condition) on the sensor',
    'Model name is required': 'no model name',
    'Add at least 1 predictor': 'no predictor sensor',
    'Pick a Y sensor': 'no Y sensor',
    'Fill in the cluster ranges': 'cluster ranges not filled in',
    'Fix the duplicate model name': 'model name already used by another model of this sensor',
};

/** A sentence → a phrase that reads after "Can't train — ": no trailing full
 *  stop, first letter lower-cased unless it starts an identifier ("T1", "Y"). */
function toPhrase(text: string): string {
    let t = text.trim().replace(/\.+$/, '');
    t = t.replace(/^Period (\d+)\b/, 'Train period $1');
    t = t.replace(/^(T\d+)\b/, 'Test period $1');
    if (/^[A-Z][a-z]/.test(t)) t = t[0].toLowerCase() + t.slice(1);
    return t;
}

/**
 * The reason a model can't train, rewritten for the preflight list / run
 * results / the Train-sensor line (they read "Can't train — {text}" and
 * "Skipped — {text}"), plus where "Fix →" should go.
 *
 * `blockReason` is the window's `buildBlockReason(m)`; `missing` its
 * `missingItems(m)`; `customMode` whether the model's DRAFT uses Custom
 * training data (its running condition / periods live in its own settings).
 */
export function preflightReason(
    blockReason: string,
    opts: { missing?: string[]; customMode?: boolean } = {},
): { text: string; fix: TrainFixTarget } {
    const custom = !!opts.customMode;
    const rcFix: TrainFixTarget = custom ? 'settings' : 'runningCondition';
    if (blockReason === CATEGORY_BLOCK_REASON) {
        return { text: MISSING_ITEM_PHRASES['Pick a category'], fix: 'category' };
    }
    if (blockReason === REQUIRED_FIELDS_BLOCK_REASON) {
        const phrases = (opts.missing ?? [])
            .filter(item => item !== 'Pick a category') // its own reason, handled above
            .map(item => MISSING_ITEM_PHRASES[item] ?? toPhrase(item));
        return { text: phrases.length ? phrases.join(', ') : 'required settings are missing', fix: 'settings' };
    }
    if (blockReason === DUPLICATE_NAME_BLOCK_REASON) {
        return { text: MISSING_ITEM_PHRASES['Fix the duplicate model name'], fix: 'settings' };
    }
    if (blockReason === NO_RUNNING_CONDITION_REASON) {
        return { text: custom ? 'no running condition in its own training data' : 'no running condition', fix: rcFix };
    }
    if (blockReason === NO_TRAIN_PERIOD_REASON) return { text: 'no train period', fix: 'runningCondition' };
    if (blockReason === NO_TRAIN_PERIOD_REASON_CUSTOM) return { text: 'no train period in its own training data', fix: 'settings' };
    // Invalid train periods ("Period 2 ends before it starts.") come from the gate;
    // invalid Custom test periods ("T1 needs a start date.") from Save's own check.
    if (/^Period \d+\b/.test(blockReason)) return { text: toPhrase(blockReason), fix: rcFix };
    return { text: toPhrase(blockReason), fix: 'settings' };
}

/**
 * Classify one model for a run, BEFORE it starts.
 *   - a block reason            → `missing` (amber, always skipped, "Fix →")
 *   - `complete`                → `upToDate` (grey; re-train makes it Incomplete)
 *   - `trained`, no failed run  → `upToDate` (grey)
 *   - anything else             → `ready` (never trained / settings changed /
 *                                 a failed run this session)
 */
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

/**
 * The run's items, in candidate order: `ready` (and `upToDate` when
 * `includeUpToDate`) are queued, everything else is skipped with its reason.
 * The preflight modal can call this for its "N will train" line — it is
 * exactly what `start()` will queue.
 *
 *   Train sensor             → the sensor's models,  includeUpToDate: false
 *   ▾ Re-train all           → the sensor's models,  includeUpToDate: true
 *   ▾ Train only the X model → [that model],         includeUpToDate: true
 *   Train all                → every model,          includeUpToDate: the checkbox
 *   Try again / not started  → those models,         includeUpToDate: true
 */
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

// ---------------------------------------------------------------------------
// During / after a run
// ---------------------------------------------------------------------------

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

/**
 * Everything the strip, the Details modal and the close dialog print.
 *   running  → "Training 3 of 8"                       (neutral)
 *   done     → "Done · 6 trained · 1 failed · 2 skipped"
 *              success when nothing failed; warning (amber) when some failed
 *              and some trained; danger (red) only when nothing trained
 *   stopped  → "Stopped · 2 trained · 3 not started"    (neutral; amber with failures)
 *   stale    → "Stopped · 2 trained · 3 not started"    (danger; + TRAIN_STALE_MESSAGE)
 */
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

/**
 * Time left, in ms: the average duration of the models already finished
 * (per kind when that kind has finished once — a Relation model takes ~15 s,
 * Individual/Clustering ~1–2 s — else over every kind) × the models still to
 * go (the running one included). Null until one model has finished, or when
 * the run is not running.
 */
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

/** Rough per-kind time BEFORE anything ran (preflight "≈ 1 min", the queued
 *  card): Relation model ≈ 15 s (Python sidecar), Clustering ≈ 2 s, Individual ≈ 1 s. */
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

/**
 * Why BOTH Train buttons (Train sensor / Train all) are disabled, as text, or
 * null. Order: STALE_SESSION → no running condition → a run is active → nothing
 * ready. While a run is active the buttons show "Training…" — the reason text
 * is null then (the strip says it all).
 */
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
