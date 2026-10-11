/**
 * Train queue ("Train sensor" / "Train all").
 *
 * Shared shapes for `useTrainQueue` (`src/hooks/useTrainQueue.ts`) and its pure
 * helpers (`src/utils/trainQueue.ts`). No Tauri command is involved: the queue
 * drives the Build Model window's per-model train (`executeTrain`),
 * which is injected as a plain function, one model at a time.
 */

import type { ModelKind } from '../types';

// ---------------------------------------------------------------------------
// Before a run: what each model would do
// ---------------------------------------------------------------------------

/** Where a "Fix →" link for a model that can't train should take the user. */
export type TrainFixTarget =
    /** The model's own "Model settings" section (fields, Custom training data). */
    | 'settings'
    /** The sensor header's Performance / Condition switch. */
    | 'category'
    /** The workspace Running condition (the line / card under the title → Edit). */
    | 'runningCondition';

/** A model's train plan, classified BEFORE a run (never during one). */
export type TrainPlan =
    /** Needs training (never trained, settings changed, or a failed run this session). */
    | { kind: 'ready' }
    /** Trained-and-fresh or Complete: skipped unless re-training is asked for (grey). */
    | { kind: 'upToDate'; reason: string; complete: boolean }
    /** A setting is missing or the gate blocks it: always skipped (amber). */
    | { kind: 'missing'; reason: string; fix: TrainFixTarget };

/** One model offered to the queue, in the order it should run. */
export interface TrainCandidate {
    id: string;
    kind: ModelKind;
    plan: TrainPlan;
}

/** What started the run (only used for copy, e.g. which modal "Details" opens). */
export type TrainRunSource = 'sensor' | 'sensor-all' | 'subset' | 'all' | 'retry';

// ---------------------------------------------------------------------------
// The injected per-model train
// ---------------------------------------------------------------------------

/**
 * What the injected `train(modelId)` resolves to. It may also reject: a
 * rejection is a failure with the error's text (and STALE_SESSION if the text
 * starts with it).
 */
export type TrainOutcome =
    | { ok: true }
    /** Training failed. `stale` (or an error starting with `STALE_SESSION`)
     *  stops the whole run: the dataset is not this window's any more. */
    | { ok: false; error: string; stale?: boolean }
    /** The model could not be trained when its turn came (its settings or the
     *  gate changed since the run started): recorded as skipped, not failed. */
    | { ok: false; skip: string }
    /** The window was re-pointed at another workspace mid-train: the run is
     *  dropped silently (same as `reset()`). */
    | { ok: false; abandoned: true };

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

export type TrainItemState =
    | 'queued'
    | 'running'
    | 'trained'
    | 'failed'
    /** Classified as not to train before the run (or `skip` at its turn). */
    | 'skipped'
    /** "Remove from run" while queued: the model's status is untouched. */
    | 'removed'
    /** Still queued when the run was stopped (Cancel / close / STALE_SESSION). */
    | 'notStarted';

export interface TrainQueueItem {
    id: string;
    kind: ModelKind;
    state: TrainItemState;
    /** `failed` only. */
    error?: string;
    /** `skipped` only: grey (`upToDate`) or amber (`missing`), with the reason.
     *  `atTurn` = it was queued but could not train when its turn came
     *  (`{ ok: false, skip }`), as opposed to a preflight skip. */
    skip?: { kind: 'upToDate' | 'missing'; reason: string; atTurn?: boolean };
    /** `trained` / `failed`: how long the train call took. */
    durationMs?: number;
}

export type TrainRunPhase =
    | 'running'
    /** Every queued model was tried. */
    | 'done'
    /** Stopped after a model by Cancel or a close. */
    | 'stopped'
    /** A train returned STALE_SESSION: stopped at once. */
    | 'stale';

/** Why a stop was asked for — the strip says "Stopping…" or "Closing…". */
export type TrainStopReason = 'cancel' | 'close';

export interface TrainRun {
    /** Increases with every run of this hook instance. */
    runId: number;
    source: TrainRunSource;
    phase: TrainRunPhase;
    /** Every candidate, in run order — skipped ones keep their place. */
    items: TrainQueueItem[];
    /** Id of the model training right now, else null. */
    currentId: string | null;
    /** Set by `stopAfterCurrent()`; the run ends after the current model. */
    stopRequested: TrainStopReason | null;
    /** The STALE_SESSION error text, when `phase === 'stale'`. */
    staleError?: string;
    startedAt: number;
    finishedAt?: number;
}

export type TrainRunOutcome = 'running' | 'done' | 'partial' | 'failed' | 'stopped' | 'stale';
/** Strip colour: `danger` only when nothing trained (or STALE_SESSION). */
export type TrainRunTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface TrainRunCounts {
    /** Models the run set out to train: queued at start (removed ones excluded). */
    planned: number;
    queued: number;
    running: number;
    trained: number;
    failed: number;
    skipped: number;
    skippedUpToDate: number;
    skippedMissing: number;
    removed: number;
    notStarted: number;
}

export interface TrainRunSummary {
    counts: TrainRunCounts;
    outcome: TrainRunOutcome;
    tone: TrainRunTone;
    /** "Training 3 of 8" / "Done · 6 trained · 1 failed · 2 skipped" /
     *  "Stopped · 2 trained · 3 not started". */
    text: string;
    /** "Training i of n" while running (i = 1-based), else null. */
    position: { index: number; of: number } | null;
    trainedIds: string[];
    failedIds: string[];
    notStartedIds: string[];
}
