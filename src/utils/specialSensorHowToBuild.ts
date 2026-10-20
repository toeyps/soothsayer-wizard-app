import type { SpecialSensorRecipe } from '../types';
import { normalizeSensorTag } from '../hooks/useSensorMetaMap';
import { describeSpecialSensor } from './specialSensorDescribe';
import { formulaRefNames } from './formulaRefs';
import { splitRoundResult } from './formulaRounding';

/*
 * How a special (calculated) sensor is built, in plain words for the export's
 * `derived_sensors[].how_to_build`, and the RAW sensors it is built from.
 */

const places = (n: number): string => `${n} decimal place${n === 1 ? '' : 's'}`;

/** The recipe of `tag` (trimmed, case-insensitive), or undefined. */
export function recipeOf(recipes: readonly SpecialSensorRecipe[] | null | undefined, tag: string): SpecialSensorRecipe | undefined {
    const key = normalizeSensorTag(tag);
    return (recipes ?? []).find(r => normalizeSensorTag(r.tag) === key);
}

/** A formula with its `${Name}` / `$Name` references written as plain names
 *  and ` * ` as ` × `. */
function plainFormula(text: string): string {
    return text
        .replace(/\$\{([^}]+)\}/g, '$1')
        .replace(/\$([\p{Alphabetic}\p{N}_][\p{Alphabetic}\p{N}_.]*)/gu, '$1')
        .replace(/ \* /g, ' × ')
        .trim();
}

/** Plain-text "how to build" of one recipe. */
export function recipeHowToBuild(recipe: SpecialSensorRecipe): string {
    if (recipe.kind === 'formula') {
        const { body, decimals } = splitRoundResult(recipe.formula);
        const plain = plainFormula(body);
        // An older spreadsheet-style step round: `round(0.01, X)`.
        const step = decimals === null ? /^round\(\s*0\.(0*)1\s*,\s*([\s\S]*)\)$/.exec(plain) : null;
        if (step) return `Calculated as ${step[2].trim()}, rounded to ${places(step[1].length + 1)}`;
        return decimals === null ? `Calculated as ${plain}` : `Calculated as ${plain}, rounded to ${places(decimals)}`;
    }
    const cfg = recipe.operationConfig;
    const sources = (recipe.sourceSensors ?? []).join(', ');
    if (cfg?.mode === 'multi') {
        const type = cfg.multiOp?.type ?? 'sum';
        const d = cfg.multiOp?.decimals;
        const round = d === undefined || d === null ? '' : `, rounded to ${places(d)}`;
        if (type === 'mean' || type === 'median') {
            const word = type === 'mean' ? 'Average' : 'Median';
            return `${word} of ${sources} (rows where a source is missing use the others)${round}`;
        }
        return `Sum of ${sources}${round}`;
    }
    return `Calculated as ${describeSpecialSensor(recipe).summary}`;
}

/** Plain-text "how to build" of the special sensor `tag`; `''` when it has no recipe. */
export function howToBuild(recipes: readonly SpecialSensorRecipe[] | null | undefined, tag: string): string {
    const r = recipeOf(recipes, tag);
    return r ? recipeHowToBuild(r) : '';
}

/** The sensors one recipe reads directly. */
function directSources(recipe: SpecialSensorRecipe): string[] {
    return recipe.kind === 'formula' ? formulaRefNames(recipe.formula) : [...(recipe.sourceSensors ?? [])];
}

/**
 * The RAW sensors the special sensor `tag` is built from: nested special
 * sensors are expanded to their own raw sources. Unique, in order of first
 * use; `[]` for a tag with no recipe. A dependency cycle never loops.
 */
export function rawSourceTags(recipes: readonly SpecialSensorRecipe[] | null | undefined, tag: string): string[] {
    const out: string[] = [];
    const seenOut = new Set<string>();
    const visiting = new Set<string>();
    const walk = (t: string) => {
        const key = normalizeSensorTag(t);
        const r = recipeOf(recipes, t);
        if (!r) {
            if (!seenOut.has(key)) { seenOut.add(key); out.push(t); }
            return;
        }
        if (visiting.has(key)) return;
        visiting.add(key);
        for (const s of directSources(r)) walk(s);
    };
    const root = recipeOf(recipes, tag);
    if (!root) return [];
    visiting.add(normalizeSensorTag(tag));
    for (const s of directSources(root)) walk(s);
    return out;
}
