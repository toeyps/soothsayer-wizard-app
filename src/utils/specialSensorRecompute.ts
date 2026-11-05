import { SpecialSensorRecipe } from '../types';
import { isSessionLostError } from './staleSession';
import type { SensorLabelOf } from './specialSensorDeps';

/** Re-runs a recipe like the reopen replay, but `replace: true` overwrites the existing column instead of duplicating it. The recipe's `tag` is forced as custom name so a recompute never renames the sensor. */

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

/** Sequential on purpose: a later recipe may read a column an earlier one writes. Rejects on the first failure; earlier recipes stay written (no transaction), so use `onRecomputed` to roll back. */
export async function recomputeSpecialSensors(
    recipes: SpecialSensorRecipe[],
    invoker: Invoker,
    /** Called after each column is written, so a caller knows which to roll back (`specialSensorEdit.ts`). */
    onRecomputed?: (recipe: SpecialSensorRecipe) => void,
    /** How the error names the sensor. Default: the tag. */
    labelOf: SensorLabelOf = tag => tag,
): Promise<void> {
    for (const recipe of recipes) {
        const { cmd, args } = recomputeCall(recipe);
        try {
            await invoker(cmd, args);
            onRecomputed?.(recipe);
        } catch (err) {
            // Dataset no longer ours (stale generation or re-pointed window): rethrow as is; the caller stops without rolling back.
            if (isSessionLostError(err)) throw err;
            const failure = new Error(`Could not recompute "${labelOf(recipe.tag)}": ${String(err)}`);
            // Set rather than passed to the constructor: the project's TS lib
            // target predates `ErrorOptions`.
            (failure as Error & { cause?: unknown }).cause = err;
            throw failure;
        }
    }
}
