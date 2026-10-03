import { SpecialSensorRecipe } from '../types';

/** How a recipe reads in a list — the formula as typed, or the operation
 *  spelled out as `sum(a, b)` / `a + 10`. */
export function describeRecipe(recipe: SpecialSensorRecipe): string {
    if (recipe.kind === 'formula') return recipe.formula;
    const sources = recipe.sourceSensors.join(', ');
    const config = recipe.operationConfig;
    if (config.mode === 'multi') return `${config.multiOp?.type ?? 'sum'}(${sources})`;
    const op = config.singleOp;
    if (!op) return sources;
    switch (op.type) {
        case 'add': return `${sources} + ${op.value}`;
        case 'subtract': return `${sources} - ${op.value}`;
        case 'multiply': return `${sources} × ${op.value}`;
        case 'divide': return `${sources} ÷ ${op.value}`;
        case 'power': return `${sources} ^ ${op.value}`;
        default: return `${op.type}(${sources})`;
    }
}
