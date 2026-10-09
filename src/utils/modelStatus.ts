import type { FailureModel, SpecialSensorRecipe } from '../types';
import { getBuildBlockReason, type RunningConditionFg } from './runningCondition';
import { computeTrainFingerprint, isModelTrainedFresh } from './trainFingerprint';
import { trainedFormulasChanged } from './specialSensorSignature';

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

/** The workspace's special-sensor recipes, for the "a special sensor this
 *  model was trained on changed its formula" half of staleness (customer batch
 *  2026-10, item 6). Omitted / null = that half is not judged here; the write
 *  side (`applyIncompleteRule` -> `demoteModelsForRecipeChange`) still demotes
 *  such a model on disk, so a caller without the recipes is never wrong for
 *  long. Pass them wherever they are at hand. */
export type StatusRecipes = SpecialSensorRecipe[] | null | undefined;

/**
 * Was trained at some point, but its inputs (or its effective running
 * condition) changed since — "Settings changed — re-train". Also stale: a
 * special sensor it was trained on has a different recipe now
 * (`model.trainedFormulas` vs `recipes`; a model trained before that snapshot
 * existed has none and is not judged by it — backward compatible).
 *
 * Independent of `status`: a Complete model is stale too. A model with no train
 * record at all (`lastTrainedAt` unset — never trained, or marked complete
 * before train records existed) is NOT stale: there is no result to be out of
 * date, and demoting every such legacy model on read would erase work nobody
 * can redo from a record.
 */
export function isModelStale(model: FailureModel, fg: RunningConditionFg, recipes?: StatusRecipes): boolean {
    if (!model.lastTrainedAt) return false;
    if (model.trainedFingerprint !== computeTrainFingerprint(model, fg)) return true;
    return !!recipes && trainedFormulasChanged(model, recipes);
}

/** Complete AND not out of date. This — not `model.status` — is what any
 *  display of "complete" (green dot, "N of M complete", the Complete pill)
 *  should read. */
export function isModelComplete(model: FailureModel, fg: RunningConditionFg, recipes?: StatusRecipes): boolean {
    return model.status && !isModelStale(model, fg, recipes);
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
    recipes?: StatusRecipes,
): ModelDotState {
    if (isModelComplete(model, fg, recipes)) return 'complete';
    if (model.status) {
        // Complete on disk but out of date (checked above): incomplete again.
        return 'stale';
    }
    if (getBuildBlockReason(model, fg, headers) !== null) return 'blocked';
    if (isModelTrainedFresh(model, fg, recipes)) return 'trained';
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
    state?: ModelDotState,
    recipes?: StatusRecipes,
): SetPointFlag {
    if ((state ?? modelDotState(model, fg, headers, recipes)) !== 'trained') return null;
    if (model.healthVerdict === 'invalid') return 'fix';
    if (model.healthVerdict === 'incomplete') return 'needed';
    return null;
}
