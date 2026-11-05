import type { FailureModel, SpecialSensorRecipe } from '../types';
import { getBuildBlockReason, type RunningConditionFg } from './runningCondition';
import { computeTrainFingerprint, isModelTrainedFresh } from './trainFingerprint';
import { trainedFormulasChanged } from './specialSensorSignature';

/** The one definition of a model's status. `FailureModel.status` is only the persisted 'marked complete' half; a Complete model whose inputs changed since its train record is not complete. This is the read side of `applyIncompleteRule`, so data from older or bypassing writers still reads correctly. */

/** Reason shown (and Mark complete blocks on) when the gate passes but the model isn't Trained-and-fresh. */
export const NOT_TRAINED_BLOCK_REASON = 'Train the model, then check the result before marking it complete.';

/** Special-sensor recipes for the 'trained sensor changed its formula' half of staleness; omitted/null = not judged here. */
export type StatusRecipes = SpecialSensorRecipe[] | null | undefined;

/** Trained before, but its inputs or effective running condition changed since, or a special sensor it trained on has a different recipe (`trainedFormulas` vs `recipes`; no snapshot = not judged). Independent of `status`. No train record (`lastTrainedAt` unset) is NOT stale: there is no result to be out of date. */
export function isModelStale(model: FailureModel, fg: RunningConditionFg, recipes?: StatusRecipes): boolean {
    if (!model.lastTrainedAt) return false;
    if (model.trainedFingerprint !== computeTrainFingerprint(model, fg)) return true;
    return !!recipes && trainedFormulasChanged(model, recipes);
}

/** Complete AND not stale; displays of 'complete' read this, not `model.status`. */
export function isModelComplete(model: FailureModel, fg: RunningConditionFg, recipes?: StatusRecipes): boolean {
    return model.status && !isModelStale(model, fg, recipes);
}

/** What a dot/pill shows: `complete`, `stale` (trained, inputs changed since), `blocked` (the gate stops it), `trained` (fresh, awaiting Mark complete), `none`. `blocked` and `stale` are separate so a UI can colour them differently. */
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

/** What the saved set points of a TRAINED model say; the one place every surface reads the persisted verdict: `fix` (Rust rejected a point), `needed` (only empty points left), `null` (nothing to flag, or the model isn't `trained`). A caller overriding the dot state passes the state it shows via `state`. */
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
