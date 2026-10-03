import type { FailureModel } from '../types';
import { getBuildBlockReason, type RunningConditionFg } from './runningCondition';
import { computeTrainFingerprint, isModelTrainedFresh } from './trainFingerprint';

/**
 * The ONE definition of a model's status, shared by the Build Model window, the
 * Dashboard's Failure Groups panel and anything else that draws a status dot,
 * a Complete count or a "re-train" hint (health score phase 3a, 2026-10-03).
 *
 * `FailureModel.status` is only the PERSISTED half ("the user marked it
 * complete"). A model also has a train record (`lastTrainedAt` +
 * `trainedFingerprint`), and a Complete model whose inputs have changed since
 * that record is no longer complete — the write side already flips `status`
 * to false the moment such an input changes (`applyIncompleteRule`), and this
 * is the read side of the same rule, so data written before the rule existed
 * (or by a writer that bypassed it) still reads correctly.
 */

/** Text shown (and the reason Mark complete blocks on) when the gate passes
 *  but the model has not been Trained-and-fresh. One string everywhere. */
export const NOT_TRAINED_BLOCK_REASON = 'Train the model, then check the result before marking it complete.';

/**
 * Was trained at some point, but its inputs (or its effective running
 * condition) changed since — "Settings changed — re-train".
 *
 * Independent of `status`: a Complete model is stale too. A model with no train
 * record at all (`lastTrainedAt` unset — never trained, or marked complete
 * before train records existed) is NOT stale: there is no result to be out of
 * date, and demoting every such legacy model on read would erase work nobody
 * can redo from a record.
 */
export function isModelStale(model: FailureModel, fg: RunningConditionFg): boolean {
    return !!model.lastTrainedAt && model.trainedFingerprint !== computeTrainFingerprint(model, fg);
}

/** Complete AND not out of date. This — not `model.status` — is what any
 *  display of "complete" (green dot, "N of M complete", the Complete pill)
 *  should read. */
export function isModelComplete(model: FailureModel, fg: RunningConditionFg): boolean {
    return model.status && !isModelStale(model, fg);
}

/** What a status dot / pill shows for a model.
 *   - `complete` — marked complete and still up to date (green)
 *   - `stale`    — was trained, inputs changed since (incl. a Complete model
 *                  that fell back to Incomplete): needs a re-train (yellow)
 *   - `blocked`  — the gate stops it (no category / running condition / bad
 *                  period): needs fixing (red)
 *   - `trained`  — trained and fresh, waiting for the user to mark it complete
 *   - `none`     — never trained, nothing wrong yet
 *  `blocked` and `stale` are separate so a UI can colour them differently;
 *  today's dots map everything but `complete` / `trained` to "no dot". */
export type ModelDotState = 'complete' | 'trained' | 'stale' | 'blocked' | 'none';

export function modelDotState(
    model: FailureModel,
    fg: RunningConditionFg,
    headers?: string[] | null,
): ModelDotState {
    if (isModelComplete(model, fg)) return 'complete';
    if (model.status) {
        // Complete on disk but out of date (checked above): incomplete again.
        return 'stale';
    }
    if (getBuildBlockReason(model, fg, headers) !== null) return 'blocked';
    if (isModelTrainedFresh(model, fg)) return 'trained';
    return model.lastTrainedAt ? 'stale' : 'none';
}

/**
 * What the saved set points of a TRAINED model say (QA fix, 2026-10-04) — the
 * ONE place every surface (Dashboard Failure Groups dot, Build Model list dot,
 * the kind tab pill) reads the persisted validation verdict:
 *   - `fix`    — Rust rejected a saved set point ("Fix set point", red)
 *   - `needed` — only empty points left ("Set points needed", yellow)
 *   - `null`   — nothing to flag (valid, never judged, or the model is not in
 *                the `trained` state at all: a Complete / stale / blocked /
 *                never-trained model has its own status and ignores the verdict).
 * A caller that overrides the dot state (a failed run of this session) passes
 * the state it actually shows via `state`.
 */
export type SetPointFlag = 'fix' | 'needed' | null;

export function modelSetPointFlag(
    model: FailureModel,
    fg: RunningConditionFg,
    headers?: string[] | null,
    state: ModelDotState = modelDotState(model, fg, headers),
): SetPointFlag {
    if (state !== 'trained') return null;
    if (model.healthVerdict === 'invalid') return 'fix';
    if (model.healthVerdict === 'incomplete') return 'needed';
    return null;
}
