import { SpecialSensorRecipe } from '../types';
import { referencedSensors, tokenizeFormula } from './formulaTokens';
import { splitRoundResult } from './formulaRounding';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How a recipe reads in a list — the formula as typed, or the operation
 *  spelled out as `sum(a, b)` / `a + 10`. A rounded block (customer batch
 *  2026-10, item 6: `multiOp.decimals`) says how many decimals it keeps. */
export function describeRecipe(recipe: SpecialSensorRecipe): string {
    if (recipe.kind === 'formula') return recipe.formula;
    const sources = recipe.sourceSensors.join(', ');
    const config = recipe.operationConfig;
    if (config.mode === 'multi') {
        const d = config.multiOp?.decimals;
        const base = `${config.multiOp?.type ?? 'sum'}(${sources})`;
        return d === undefined || d === null ? base : `${base} to ${plural(d, 'decimal')}`;
    }
    const op = config.singleOp;
    if (!op) return sources;
    switch (op.type) {
        case 'add': return `${sources} + ${op.value}`;
        case 'subtract': return `${sources} - ${op.value}`;
        case 'multiply': return `${sources} × ${op.value}`;
        case 'divide': return `${sources} ÷ ${op.value}`;
        case 'power': return `${sources} ^ ${op.value}`;
        // The decimal count is part of what the sensor IS ("round to 0" and
        // "round to 3" are different sensors), and the locked editor shows
        // only this text.
        case 'round': return `round(${sources}) to ${op.value} decimal${op.value === 1 ? '' : 's'}`;
        default: return `${op.type}(${sources})`;
    }
}

/** What kind of special sensor a recipe builds. */
export type SpecialSensorKind = 'formula' | 'average' | 'median' | 'sum' | 'operation';

export interface SpecialSensorDescription {
    kind: SpecialSensorKind;
    /** "Formula" | "Average block" | "Median block" | "Sum" | "Operation". */
    kindLabel: string;
    /**
     * One human line for the Manage list / an Inline label's secondary text:
     *   formula   -> its text without the rounding, then "· rounded to 2 decimals";
     *   average   -> "Average of A, B, C · missing values skipped";
     *   sum       -> "Sum of A, B, C";
     *   operation -> "A + 10", "sqrt(A)", "A rounded to 2 decimals".
     * Sensors in a block / operation read through `label` (default: the tag);
     * a formula keeps its own `$TAG` text (the stored form, as typed).
     */
    summary: string;
    /** The recipe as stored / spelled out (`describeRecipe`). */
    expression: string;
    /** Sensors it reads, in order of first use (for Inline labels). */
    sources: string[];
    /** Decimals it rounds to (the formula's "Round the result" or the block's
     *  `multiOp.decimals`); null = not rounded. */
    decimals: number | null;
}

export interface DescribeOptions {
    /** How a sensor is named in the summary (e.g. its description); default the tag. */
    label?: (tag: string) => string;
}

const rounded = (d: number | null) => (d === null ? '' : ` · rounded to ${plural(d, 'decimal')}`);

/** A human description of a special sensor's recipe (customer batch 2026-10, item 6). */
export function describeSpecialSensor(recipe: SpecialSensorRecipe, opts: DescribeOptions = {}): SpecialSensorDescription {
    const label = opts.label ?? ((t: string) => t);
    const expression = describeRecipe(recipe);
    if (recipe.kind === 'formula') {
        const { body, decimals } = splitRoundResult(recipe.formula);
        const sources = referencedSensors(tokenizeFormula(recipe.formula)).map(r => r.name);
        return { kind: 'formula', kindLabel: 'Formula', summary: `${body.trim()}${rounded(decimals)}`, expression, sources, decimals };
    }
    const sources = [...(recipe.sourceSensors ?? [])];
    const names = sources.map(label).join(', ');
    const cfg = recipe.operationConfig;
    if (cfg.mode === 'multi') {
        const type = cfg.multiOp?.type ?? 'sum';
        const decimals = cfg.multiOp?.decimals ?? null;
        if (type === 'mean' || type === 'median') {
            const name = type === 'mean' ? 'Average' : 'Median';
            return {
                kind: type === 'mean' ? 'average' : 'median', kindLabel: `${name} block`,
                summary: `${name} of ${names} · missing values skipped${rounded(decimals)}`,
                expression, sources, decimals,
            };
        }
        return { kind: 'sum', kindLabel: 'Sum', summary: `Sum of ${names}${rounded(decimals)}`, expression, sources, decimals };
    }
    const op = cfg.singleOp;
    const a = sources.length > 0 ? label(sources[0]) : '';
    let summary: string;
    let decimals: number | null = null;
    switch (op?.type) {
        case undefined: summary = a; break;
        case 'add': summary = `${a} + ${op.value}`; break;
        case 'subtract': summary = `${a} − ${op.value}`; break;
        case 'multiply': summary = `${a} × ${op.value}`; break;
        case 'divide': summary = `${a} ÷ ${op.value}`; break;
        case 'power': summary = `${a} ^ ${op.value}`; break;
        case 'round':
            decimals = op.value;
            summary = `${a} rounded to ${plural(op.value, 'decimal')}`;
            break;
        default: summary = `${op?.type}(${a})`;
    }
    return { kind: 'operation', kindLabel: 'Operation', summary, expression, sources, decimals };
}
