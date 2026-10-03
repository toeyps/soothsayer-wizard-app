import { SpecialSensorRecipe } from '../types';
import { isSessionLostError } from './staleSession';

/**
 * Re-running a special sensor's recipe against the loaded data.
 *
 * This is the same pair of commands the workspace-reopen replay uses
 * (`DataUploadPage`), with one difference: `replace: true`. On reopen the
 * columns do not exist yet and get appended; after an edit the column is
 * already there and has to be overwritten in place, or the recomputed values
 * end up in a second column of the same name that nothing ever reads (see
 * `put_sensor_column` in `lib.rs`).
 *
 * The recipe's own `tag` is forced back as the custom name so a recomputation
 * can never rename the sensor — every formula, model and chart entry that
 * points at it keeps pointing at it.
 */

/** Injected so this is testable without a Tauri runtime. */
export type Invoker = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** The command and arguments that rebuild one recipe's column, in place. */
export function recomputeCall(recipe: SpecialSensorRecipe): { cmd: string; args: Record<string, unknown> } {
    if (recipe.kind === 'formula') {
        return {
            cmd: 'evaluate_formula',
            args: { formula: recipe.formula, customName: recipe.tag, replace: true },
        };
    }
    return {
        cmd: 'calculate_new_sensor',
        args: {
            sensors: recipe.sourceSensors,
            config: { ...recipe.operationConfig, customName: recipe.tag },
            replace: true,
        },
    };
}

/**
 * Recompute recipes one after another, in the order given.
 *
 * Sequential on purpose: a later recipe may read the column an earlier one
 * writes, so running them concurrently would let it read the stale values.
 *
 * Rejects on the first failure, naming the recipe that failed. Recipes before
 * it have already been written — there is no transaction here — so the caller
 * should treat a rejection as "the data is now part-way through an edit". Use
 * `onRecomputed` to learn which ones, and roll them back (`specialSensorEdit`).
 */
export async function recomputeSpecialSensors(
    recipes: SpecialSensorRecipe[],
    invoker: Invoker,
    /** Called after each recipe's column has been written, so a caller that
     *  gets a rejection later knows exactly which columns were already changed
     *  (the edit flow rolls those back -- see `specialSensorEdit.ts`). */
    onRecomputed?: (recipe: SpecialSensorRecipe) => void,
): Promise<void> {
    for (const recipe of recipes) {
        const { cmd, args } = recomputeCall(recipe);
        try {
            await invoker(cmd, args);
            onRecomputed?.(recipe);
        } catch (err) {
            // The dataset is not ours any more (stale generation / window
            // re-pointed): pass it through unwrapped so the caller can stop
            // WITHOUT rolling back.
            if (isSessionLostError(err)) throw err;
            const failure = new Error(`Could not recompute "${recipe.tag}": ${String(err)}`);
            // Set rather than passed to the constructor: the project's TS lib
            // target predates `ErrorOptions`.
            (failure as Error & { cause?: unknown }).cause = err;
            throw failure;
        }
    }
}
