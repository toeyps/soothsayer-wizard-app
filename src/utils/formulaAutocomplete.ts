import type { FormulaIssue } from '../types/formula';
import { sensorRef } from './specialSensorNaming';
import type { FormulaEdit } from './formulaFixes';

/** Autocomplete context of the Formula editor: what the caret can complete and what a pick replaces. `$...` / `${...` complete sensors; a word of 2+ ASCII letters completes sensors then functions; Ctrl+Space (`force`) also works on shorter words. `[start, end)` runs over the rest of the same name after the caret, so `${Name}` keeps no stray `}`. */
export interface AutocompleteContext {
    kind: 'sensor' | 'word' | 'any';
    /** What has been typed of the name so far (no `$` / `${`). */
    query: string;
    start: number;
    end: number;
}

const BEFORE_BRACED = /\$\{([^}$]*)$/u;
const BEFORE_BARE = /\$([\p{Alphabetic}\p{N}_.]*)$/u;
const BEFORE_WORD = /[A-Za-z_][A-Za-z0-9_]*$/;

export function autocompleteContext(text: string, caret: number, opts: { force?: boolean } = {}): AutocompleteContext | null {
    const before = text.slice(0, caret);
    const after = text.slice(caret);

    const braced = BEFORE_BRACED.exec(before);
    if (braced) {
        const close = /^[^}$]*\}/u.exec(after);
        return { kind: 'sensor', query: braced[1], start: caret - braced[0].length, end: caret + (close ? close[0].length : 0) };
    }
    const bare = BEFORE_BARE.exec(before);
    if (bare) {
        const rest = /^[\p{Alphabetic}\p{N}_.]*/u.exec(after)?.[0] ?? '';
        return { kind: 'sensor', query: bare[1], start: caret - bare[0].length, end: caret + rest.length };
    }
    const word = BEFORE_WORD.exec(before);
    if (word) {
        const start = caret - word[0].length;
        const prev = start > 0 ? text[start - 1] : '';
        // `2min` (a number's suffix), `$A.b` handled above; `x1` after a digit is a number.
        const glued = prev !== '' && /[0-9.]/.test(prev);
        if (!glued && (opts.force || word[0].length >= 2)) {
            const rest = /^[A-Za-z0-9_]*/.exec(after)?.[0] ?? '';
            return { kind: 'word', query: word[0], start, end: caret + rest.length };
        }
    }
    if (opts.force) return { kind: 'any', query: '', start: caret, end: caret };
    return null;
}

/** A suggestion the list offers. */
export type CompletionItem = { kind: 'sensor'; tag: string } | { kind: 'function'; name: string };

/** Apply a picked suggestion: `$TAG` / `${TAG}` (shared brace rule), or
 *  `fn()` with the caret inside. */
export function applyCompletion(text: string, ctx: AutocompleteContext, item: CompletionItem): FormulaEdit {
    let piece: string;
    let caretIn: number;
    if (item.kind === 'sensor') {
        piece = sensorRef(item.tag);
        caretIn = piece.length;
    } else {
        // Keep an existing bracket right after the word: `abs|(` -> `abs(`.
        const hasBracket = /^\s*[([]/.test(text.slice(ctx.end));
        piece = hasBracket ? item.name : `${item.name}()`;
        caretIn = hasBracket ? piece.length : piece.length - 1;
    }
    const next = text.slice(0, ctx.start) + piece + text.slice(ctx.end);
    const caret = ctx.start + caretIn;
    return { text: next, selection: [caret, caret] };
}

/** Engine functions matching the typed text (prefix first, then contains); sensor contexts get none. */
export function functionSuggestions(ctx: AutocompleteContext, functions: readonly string[], limit = 6): string[] {
    if (ctx.kind === 'sensor') return [];
    const q = ctx.query.toLowerCase();
    const prefix = functions.filter(f => f.startsWith(q));
    const contains = q ? functions.filter(f => !f.startsWith(q) && f.includes(q)) : [];
    return [...prefix, ...contains].slice(0, limit);
}

/** Issue to show while autocomplete is open: null inside the word being typed (no red flash), else unchanged; a range-less issue is kept. */
export function issueWhileTyping(issue: FormulaIssue | null, ctx: AutocompleteContext | null): FormulaIssue | null {
    if (!issue || !ctx || !issue.range) return issue;
    const [a, b] = issue.range;
    return a >= ctx.start && b <= Math.max(ctx.end, ctx.start + 1) ? null : issue;
}
