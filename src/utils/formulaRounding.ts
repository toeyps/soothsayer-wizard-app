import { isFormulaAtom, tokenizeFormula } from './formulaTokens';

/** Rounding text of OLD recipes (the editor no longer offers rounding): `round(X * 100) / 100`, `round(X)` for 0 decimals. Used to show legacy operations as formulas and to describe saved formulas. */

/** `X` rounded to `decimals` places in engine form (`X` bracketed unless one operand). For decimals > 0 the result has a top-level `/`, so callers bracket it in a larger formula. */
export function roundExpression(expr: string, decimals: number): string {
    const x = expr.trim();
    if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError(`decimals must be a whole number >= 0 (got ${decimals})`);
    if (decimals === 0) return `round(${x})`;
    const scale = 10 ** decimals;
    const xs = isFormulaAtom(x) ? x : `(${x})`;
    return `round(${xs} * ${scale}) / ${scale}`;
}

/** Does the text have a bracket with no partner (`$A) + ($B`, `(($A`)? */
export function hasUnpairedBracket(text: string): boolean {
    return tokenizeFormula(text).some(t => (t.kind === 'open' || t.kind === 'close') && (t.pair ?? -1) < 0);
}

/** `body` rounded to `decimals` places (null = as is), as old recipes stored it. A body with an unpaired bracket is not wrapped (the added brackets could pair with the stray ones). */
export function withRoundResult(body: string, decimals: number | null): string {
    const trimmed = body.trim();
    if (decimals === null || !trimmed || hasUnpairedBracket(trimmed)) return trimmed;
    return roundExpression(trimmed, decimals);
}

/** Splits a stored formula into editor text + setting: an outer `round(X * 10^n) / 10^n` (n 1..15) or `round(X)`. Only when re-applying gives back EXACTLY the stored text, so opening/saving never rewrites an untouched formula. */
export function splitRoundResult(formula: string): { body: string; decimals: number | null } {
    const f = formula.trim();
    const none = { body: formula, decimals: null };
    const toks = tokenizeFormula(f);
    if (toks.length < 4 || toks[0].kind !== 'word' || toks[0].text !== 'round' || toks[1].kind !== 'open' || toks[1].text !== '(') return none;
    const close = toks[1].pair ?? -1;
    if (close < 0) return none;
    let candidate: { body: string; decimals: number } | null = null;
    if (close === toks.length - 1) {
        candidate = { body: f.slice(toks[1].end, toks[close].start).trim(), decimals: 0 };
    } else if (close === toks.length - 3) {
        const slash = toks[close + 1];
        const scaleTok = toks[close + 2];
        const star = toks[close - 2];
        const inner = toks[close - 1];
        const n = placesOfScale(scaleTok.text);
        if (slash.text === '/' && n !== null && star?.text === '*' && inner?.text === scaleTok.text && close - 2 > 1) {
            let body = f.slice(toks[1].end, star.start).trim();
            // `round((A + B) * 100) / 100`: the bracket was added by the setting.
            const bt = tokenizeFormula(body);
            if (bt.length > 2 && bt[0].kind === 'open' && bt[0].text === '(' && bt[0].pair === bt.length - 1) {
                const unwrapped = body.slice(bt[0].end, bt[bt.length - 1].start).trim();
                if (!isFormulaAtom(unwrapped)) body = unwrapped;
            }
            candidate = { body, decimals: n };
        }
    }
    if (!candidate || !candidate.body || hasTopLevelComma(candidate.body)) return none; // `round(0.01, $A)` is a step round
    return withRoundResult(candidate.body, candidate.decimals) === f ? candidate : none;
}

function hasTopLevelComma(text: string): boolean {
    let depth = 0;
    for (const t of tokenizeFormula(text)) {
        if (t.kind === 'open') depth++;
        else if (t.kind === 'close') depth--;
        else if (t.kind === 'comma' && depth === 0) return true;
    }
    return false;
}

/** `100` -> 2; anything that is not 10^n with n in 1..15 -> null. */
function placesOfScale(text: string): number | null {
    const m = /^1(0{1,15})$/.exec(text);
    return m ? m[1].length : null;
}
