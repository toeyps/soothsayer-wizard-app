import { describe, it, expect } from 'vitest';
import { applyCompletion, autocompleteContext, functionSuggestions, issueWhileTyping } from '../utils/formulaAutocomplete';
import { checkFormula, sensorResolver } from '../utils/formulaCheck';
import { tokenizeFormula } from '../utils/formulaTokens';

describe('autocompleteContext', () => {
    it('opens at once on $ (bare or braced) and extends over the rest of the name', () => {
        expect(autocompleteContext('$A + $', 6)).toEqual({ kind: 'sensor', query: '', start: 5, end: 6 });
        expect(autocompleteContext('$A + $Fl', 8)).toEqual({ kind: 'sensor', query: 'Fl', start: 5, end: 8 });
        expect(autocompleteContext('$TEMP.PV + 1', 3)).toEqual({ kind: 'sensor', query: 'TE', start: 0, end: 8 });
        expect(autocompleteContext('${Flow (m', 9)).toEqual({ kind: 'sensor', query: 'Flow (m', start: 0, end: 9 });
        expect(autocompleteContext('${Flow} * 2', 4)).toEqual({ kind: 'sensor', query: 'Fl', start: 0, end: 7 });
        expect(autocompleteContext('$อุณ', 4)).toEqual({ kind: 'sensor', query: 'อุณ', start: 0, end: 4 });
    });

    it('a name of 2+ letters opens sensors + functions; 1 letter only with Ctrl+Space', () => {
        expect(autocompleteContext('$A * sq', 7)).toEqual({ kind: 'word', query: 'sq', start: 5, end: 7 });
        expect(autocompleteContext('$A * s', 6)).toBeNull();
        expect(autocompleteContext('$A * s', 6, { force: true })).toEqual({ kind: 'word', query: 's', start: 5, end: 6 });
        expect(autocompleteContext('abs(x', 3)).toEqual({ kind: 'word', query: 'abs', start: 0, end: 3 });
    });

    it('not after a closed reference, inside a number suffix, or on a space (unless forced)', () => {
        expect(autocompleteContext('${Flow}', 7)).toBeNull();
        expect(autocompleteContext('2min', 4)).toBeNull();
        expect(autocompleteContext('$A + ', 5)).toBeNull();
        expect(autocompleteContext('$A + ', 5, { force: true })).toEqual({ kind: 'any', query: '', start: 5, end: 5 });
    });
});

describe('applyCompletion', () => {
    it('writes a sensor with the shared brace rule over the whole typed name', () => {
        const ctx = autocompleteContext('$A + $Fl * 2', 8)!;
        expect(applyCompletion('$A + $Fl * 2', ctx, { kind: 'sensor', tag: 'Flow (m3/h)' })).toEqual({ text: '$A + ${Flow (m3/h)} * 2', selection: [19, 19] });
        const braced = autocompleteContext('${Fl}', 3)!;
        expect(applyCompletion('${Fl}', braced, { kind: 'sensor', tag: 'FLOW' }).text).toBe('$FLOW');
    });

    it('writes fn() with the caret inside; pi() / e() with the caret after; keeps an existing bracket', () => {
        const ctx = autocompleteContext('$A * sq', 7)!;
        expect(applyCompletion('$A * sq', ctx, { kind: 'function', name: 'sqrt' })).toEqual({ text: '$A * sqrt()', selection: [10, 10] });
        expect(applyCompletion('$A * pi', autocompleteContext('$A * pi', 7)!, { kind: 'function', name: 'pi' }).selection).toEqual([9, 9]);
        const withBracket = autocompleteContext('sq($A)', 2)!;
        expect(applyCompletion('sq($A)', withBracket, { kind: 'function', name: 'sqrt' })).toEqual({ text: 'sqrt($A)', selection: [4, 4] });
    });
});

describe('functionSuggestions', () => {
    const fns = ['abs', 'sqrt', 'sign', 'sin', 'asin', 'pi'];
    it('prefix matches first, then contains; none for a $ context', () => {
        expect(functionSuggestions({ kind: 'word', query: 'si', start: 0, end: 2 }, fns)).toEqual(['sign', 'sin', 'asin']);
        expect(functionSuggestions({ kind: 'sensor', query: 'si', start: 0, end: 3 }, fns)).toEqual([]);
        expect(functionSuggestions({ kind: 'any', query: '', start: 0, end: 0 }, fns, 2)).toEqual(['abs', 'sqrt']);
    });
});

describe('issueWhileTyping: no red flash for the word being typed', () => {
    const isKnownSensor = sensorResolver(['FLOW', 'A']);
    const run = (f: string, caret: number) => {
        const issue = checkFormula(f, tokenizeFormula(f), { isKnownSensor, functions: ['abs', 'sqrt'] });
        return { issue, shown: issueWhileTyping(issue, autocompleteContext(f, caret)) };
    };
    it('hides an issue inside the typed word, keeps any other', () => {
        expect(run('$A + $FL', 8)).toMatchObject({ issue: { code: 'unknown_sensor' }, shown: null });
        expect(run('$A + ${FL', 9).shown).toBeNull(); // bad_char on the unfinished ${
        expect(run('$A * sq', 7).shown).toBeNull();
        expect(run('$Nope + $FL', 11).shown).toMatchObject({ code: 'unknown_sensor', range: [0, 5] });
        expect(issueWhileTyping({ code: 'constant_only', message: 'm' }, { kind: 'word', query: 'ab', start: 0, end: 2 })).toMatchObject({ code: 'constant_only' });
        expect(issueWhileTyping(null, null)).toBeNull();
    });
});
