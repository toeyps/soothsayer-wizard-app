import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { createRef } from 'react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import SpecialSensorFormulaEditor, {
    QuickBuild, SensorFieldsCard, type FormulaEditorHandle, type FormulaEditorReport,
} from '../components/windows/SpecialSensorFormulaEditor';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { __resetPreviewFormulaModule, PREVIEW_DEBOUNCE_MS } from '../hooks/usePreviewFormula';
import { editorStateFormula, editorStateToRecipe } from '../utils/quickBuild';
import type { SensorMetadata, SpecialSensorRecipe } from '../types';
import type { FormulaPreviewResult } from '../types/formula';
import { findPickerRow, pickMulti } from './helpers/sensorPicker';

/**
 * The special-sensor Formula editor + Quick build against the
 * REAL logic (tokenizer, front-end check, fixes, Quick build generators, usePreviewFormula) with
 * only `invoke` mocked: the painted mirror, autocomplete keys, fix buttons, wrap / unwrap,
 * Quick build per pick count, block vs formula, "Round the result", and the Locked / Repair states.
 */

const SENSORS = ['A', 'B', 'C', 'Flow (m3/h)', 'อุณหภูมิ'];
const META: SensorMetadata[] = [
    { tag: 'A', description: 'Inlet temp', unit: 'DEGC', component: 'Pump' },
    { tag: 'B', description: 'Outlet temp', unit: 'DEGC', component: 'Pump' },
    { tag: 'C', description: 'Speed', unit: 'RPM', component: 'Motor' },
    { tag: 'Flow (m3/h)', description: 'Flow', unit: 'm3/h', component: 'Pump' },
];
const FUNCTIONS = ['abs', 'sqrt', 'pow', 'exp', 'ln', 'log', 'log10', 'round', 'min', 'max', 'ceil', 'floor', 'pi', 'e'];

const ok = (over: Partial<FormulaPreviewResult> = {}): FormulaPreviewResult => ({
    ok: true, issues: [], stats: { min: 1, max: 9, mean: 4.5, rows: 1234, missing: 12 },
    timestamps: ['2024-01-01 00:00:00', '2024-01-02 00:00:00'], values: [1, null, 9],
    period: ['2024-01-01 00:00:00', '2024-03-01 00:00:00'],
    functions: FUNCTIONS, limits: { max_len: 4096, max_depth: 64 }, converted_formula: null, ...over,
});
const refused = (code: string, message: string, range?: [number, number], over: Partial<FormulaPreviewResult> = {}): FormulaPreviewResult => ok({
    ok: false, issues: [{ code, message, ...(range ? { range } : {}) }], stats: null, values: [], timestamps: [], period: null, ...over,
});

let reply: (args: Record<string, unknown>) => FormulaPreviewResult = () => ok();

beforeEach(() => {
    __resetPreviewFormulaModule();
    reply = () => ok();
    mockInvoke.mockReset().mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'preview_formula') return reply(args);
        return undefined;
    });
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

const flush = async (ms = PREVIEW_DEBOUNCE_MS + 5) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

type Props = Partial<React.ComponentProps<typeof SpecialSensorFormulaEditor>>;

function ui(props: Props, onReport: (r: FormulaEditorReport) => void, ref?: React.Ref<FormulaEditorHandle>) {
    return (
        <SensorMetaProvider metadata={META}>
            <SpecialSensorFormulaEditor
                ref={ref}
                sensors={SENSORS}
                knownSensors={SENSORS}
                initialRecipe={null}
                locked={null}
                repair={null}
                quickSelected={[]}
                onQuickClear={() => {}}
                unit="DEGC"
                onReport={onReport}
                {...props}
            />
        </SensorMetaProvider>
    );
}

function setup(props: Props = {}) {
    const onReport = vi.fn<(r: FormulaEditorReport) => void>();
    const ref = createRef<FormulaEditorHandle>();
    const view = render(ui(props, onReport, ref));
    return {
        ...view,
        ref,
        onReport,
        rerenderWith: (p: Props) => view.rerender(ui({ ...props, ...p }, onReport, ref)),
        last: () => onReport.mock.calls[onReport.mock.calls.length - 1]?.[0],
    };
}

const field = () => screen.getByLabelText('Formula') as HTMLTextAreaElement;
const mirror = () => screen.getByTestId('formula-mirror');
const check = () => screen.getByTestId('formula-check');

/** Type `value` (caret at the end, or at `caret`) the way the browser would report it. */
function type(value: string, caret = value.length) {
    const ta = field();
    fireEvent.change(ta, { target: { value } });
    ta.setSelectionRange(caret, caret);
    fireEvent.select(ta);
}
function select(a: number, b: number) {
    const ta = field();
    ta.focus();
    ta.setSelectionRange(a, b);
    fireEvent.select(ta);
}

describe('painted mirror', () => {
    it('paints sensor chips, functions, depth-coloured brackets and matches the text character for character', () => {
        setup();
        const text = 'abs(($A + ${Flow (m3/h)}) * 2) + $อุณหภูมิ';
        type(text);
        const m = mirror();
        expect(m.textContent).toBe(`${text}​`);
        const sensors = [...m.querySelectorAll('.fx-sensor')].map(e => e.textContent);
        expect(sensors).toEqual(['$A', '${Flow (m3/h)}', '$อุณหภูมิ']);
        expect(m.querySelector('.fx-word')?.textContent).toBe('abs');
        const brackets = [...m.querySelectorAll('.fx-open, .fx-close')].map(e => `${e.textContent}${[...e.classList].find(c => /^fx-d\d$/.test(c))}`);
        expect(brackets).toEqual(['(fx-d0', '(fx-d1', ')fx-d1', ')fx-d0']);
        // Hover text for a reference: DESCRIPTION · TAG · UNIT · Component.
        expect(m.querySelector('.fx-sensor')?.getAttribute('data-tip')).toBe('Inlet temp · A · DEGC · Pump');
    });

    it('an unknown sensor is red and dashed; a lone bracket is red', () => {
        setup();
        type('$Gone + $A)');
        const m = mirror();
        expect(m.querySelector('.fx-sensor.unk')?.textContent).toBe('$Gone');
        expect(m.querySelector('.fx-lone')?.textContent).toBe(')');
    });

    it('highlights the matching bracket pair while the caret touches one', () => {
        setup();
        type('($A + $B) * 2');
        select(0, 0);
        const mates = [...mirror().querySelectorAll('.fx-mate')].map(e => e.textContent);
        expect(mates).toEqual(['(', ')']);
        select(13, 13);
        expect(mirror().querySelectorAll('.fx-mate')).toHaveLength(0);
    });

    it('underlines the error range and offers the fix; clicking the message selects the range', () => {
        setup();
        type('$A $B');
        expect(check().textContent).toContain('Two values side by side');
        const errs = [...mirror().querySelectorAll('.err')].map(e => e.textContent);
        expect(errs).toEqual(['$A', '$B']);
        fireEvent.click(within(check()).getByRole('button', { name: /Two values side by side/ }));
        expect([field().selectionStart, field().selectionEnd]).toEqual([0, 5]);
        fireEvent.click(within(check()).getByRole('button', { name: 'Insert ×' }));
        expect(field().value).toBe('$A * $B');
    });
});

describe('the check line and the report', () => {
    it('reports the formula state and the blocking issue; an empty editor reports nothing to save', () => {
        const { last } = setup();
        expect(last()).toEqual({ state: null, issue: null, edited: false });
        type('abs($A');
        expect(last().state).toMatchObject({ mode: 'formula', text: 'abs($A', roundDecimals: null });
        expect(last().issue).toMatchObject({ code: 'unclosed_bracket' });
        fireEvent.click(within(check()).getByRole('button', { name: 'Add )' }));
        expect(field().value).toBe('abs($A)');
        expect(last().issue).toBeNull();
        type('');
        expect(last()).toEqual({ state: null, issue: null, edited: false });
    });

    it('always sends the text to Rust (even when the cheap check fails); Rust has the last word', async () => {
        reply = () => refused('round_excel', 'Formula error: round($A, 2) does not round to 2 decimal places.', [0, 12], {
            converted_formula: 'round($A * 100) / 100',
        });
        const { last } = setup();
        type('round($A, 2)');
        await flush();
        expect(mockInvoke).toHaveBeenCalledWith('preview_formula', expect.objectContaining({ formula: 'round($A, 2)', maxPoints: 600, replace: false }));
        expect(check().textContent).toContain('does not round to 2 decimal places');
        // The fix uses Rust's own conversion: the engine form, never round(0.01, …).
        const fix = within(check()).getByRole('button', { name: 'Use round(… * 100) / 100' });
        fireEvent.click(fix);
        expect(field().value).toBe('round($A * 100) / 100');
        reply = () => ok();
        await flush();
        expect(last().issue).toBeNull();
        expect(check().textContent).toMatch(/✓ Valid · uses 1 sensor · computed on 1,234 rows/);
    });

    it('a valid formula shows the preview stats with the amber missing-row count', async () => {
        setup();
        type('$A + $B');
        await flush();
        const stats = screen.getByTestId('preview-stats');
        expect(stats.textContent).toContain('Min 1 DEGC');
        expect(stats.textContent).toContain('Rows 1,234');
        expect(stats.querySelector('.w')?.textContent).toContain('12 rows have no result');
        expect(screen.getByRole('img', { name: 'Preview of the result' })).toBeTruthy();
    });

    it('an unknown function gets the closest engine function as its fix (once Rust sent the list)', async () => {
        setup();
        type('$A + 1');
        await flush(); // the function list arrives with the first preview
        type('sqr($A)');
        expect(check().textContent).toContain("Unknown function 'sqr'");
        fireEvent.click(within(check()).getByRole('button', { name: 'Use sqrt' }));
        expect(field().value).toBe('sqrt($A)');
    });
});

describe('autocomplete', () => {
    it('opens on $, moves with ↑↓, inserts with Enter, closes with Esc', () => {
        setup();
        type('$');
        const list = screen.getByRole('listbox', { name: 'Suggestions' });
        expect(within(list).getAllByRole('option').length).toBeGreaterThan(1);
        fireEvent.keyDown(field(), { key: 'ArrowDown' });
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(field().value).toBe('$B');
        expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull();
        type('$B + $');
        expect(screen.getByRole('listbox', { name: 'Suggestions' })).toBeTruthy();
        fireEvent.keyDown(field(), { key: 'Escape' });
        expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull();
    });

    it('matches sensors on description and writes spaced names braced, Thai names bare', () => {
        setup();
        type('$flow');
        fireEvent.keyDown(field(), { key: 'Tab' });
        expect(field().value).toBe('${Flow (m3/h)}');
        type('$อุณ');
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(field().value).toBe('$อุณหภูมิ');
    });

    it('2+ letters suggest functions too (with their meaning); a pick leaves the caret inside the bracket', async () => {
        setup();
        type('$A');
        await flush();
        type('sq');
        const opt = screen.getAllByRole('option').find(o => o.textContent?.startsWith('sqrt('));
        expect(opt?.textContent).toContain('square root');
        fireEvent.mouseDown(opt!);
        expect(field().value).toBe('sqrt()');
        expect(field().selectionStart).toBe(5);
    });

    it('Ctrl+Space opens it anywhere; while a name is typed there is no red flash for it', () => {
        const { last } = setup();
        type('$A + ');
        fireEvent.keyDown(field(), { key: ' ', ctrlKey: true });
        expect(screen.getByRole('listbox', { name: 'Suggestions' })).toBeTruthy();
        type('$A + $Zz');
        // The check stays quiet about the word being typed, but Add stays blocked.
        expect(check().textContent).not.toContain('✕');
        expect(last().issue).toMatchObject({ code: 'unknown_sensor' });
    });
});

describe('structural edits', () => {
    it('( over a selection wraps it and keeps the inside selected; Wrap / Unwrap in the palette', () => {
        setup();
        type('$A + $B * 2');
        select(0, 7);
        fireEvent.keyDown(field(), { key: '(' });
        expect(field().value).toBe('($A + $B) * 2');
        expect([field().selectionStart, field().selectionEnd]).toEqual([1, 8]);
        // Unwrap at the caret on the bracket.
        select(0, 0);
        fireEvent.click(screen.getByRole('button', { name: 'Unwrap' }));
        expect(field().value).toBe('$A + $B * 2');
        select(5, 11);
        fireEvent.click(screen.getByRole('button', { name: '( ) Wrap' }));
        expect(field().value).toBe('$A + ($B * 2)');
    });

    it('Unwrap of a function call removes the name with its brackets', () => {
        setup();
        type('abs($A - $B)');
        select(3, 3);
        fireEvent.click(screen.getByRole('button', { name: 'Unwrap' }));
        expect(field().value).toBe('$A - $B');
    });

    it('palette operators insert with spacing; a function pill wraps the selection', () => {
        setup();
        type('$A');
        fireEvent.click(screen.getByRole('button', { name: 'Insert multiply' }));
        expect(field().value).toBe('$A *');
        type('$A + $B');
        select(0, 7);
        fireEvent.click(screen.getByRole('button', { name: 'Insert sqrt' }));
        expect(field().value).toBe('sqrt($A + $B)');
    });

    it('Enter never inserts a newline; a pasted newline becomes a space', () => {
        setup();
        type('$A +\n$B');
        expect(field().value).toBe('$A + $B');
        const ev = fireEvent.keyDown(field(), { key: 'Enter' });
        expect(ev).toBe(false); // default prevented
    });

    it('programmatic edits are NATIVE insertions (undoable with Ctrl+Z) when the browser supports them', () => {
        const spy = vi.fn((cmd: string, _ui: boolean, value: string) => {
            const ta = document.activeElement as HTMLTextAreaElement;
            const { selectionStart: s, selectionEnd: e } = ta;
            const next = ta.value.slice(0, s) + value + ta.value.slice(e);
            // What the browser does: replace the selection and fire an input event.
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            setter.call(ta, next);
            ta.setSelectionRange(s + value.length, s + value.length);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            return cmd === 'insertText';
        });
        const original = document.execCommand;
        Object.defineProperty(document, 'execCommand', { value: spy, configurable: true, writable: true });
        try {
            setup();
            type('$A $B');
            fireEvent.click(within(check()).getByRole('button', { name: 'Insert ×' }));
            expect(spy).toHaveBeenCalledWith('insertText', false, expect.any(String));
            expect(field().value).toBe('$A * $B');
        } finally {
            Object.defineProperty(document, 'execCommand', { value: original, configurable: true, writable: true });
        }
    });

    it('the Sensors row lists every referenced sensor; clicking one selects its first occurrence', () => {
        setup();
        type('$B - $A + $B');
        const row = screen.getByTestId('formula-sensors');
        const chips = within(row).getAllByRole('button');
        expect(chips.map(c => c.querySelector('.sl-tag')?.textContent)).toEqual(['B', 'A']);
        fireEvent.click(chips[1]);
        expect([field().selectionStart, field().selectionEnd]).toEqual([5, 7]);
    });

    it('an unknown sensor offers Replace…, which replaces every occurrence', () => {
        setup();
        type('$Gone * 2 + $Gone');
        expect(check().textContent).toContain('Sensor not found: Gone');
        fireEvent.click(within(check()).getByRole('button', { name: 'Replace…' }));
        fireEvent.click(findPickerRow('C'));
        expect(field().value).toBe('$C * 2 + $C');
    });

    it('the `$` handle inserts a sensor at the caret', () => {
        const { ref } = setup();
        type('$A + ', 5);
        act(() => ref.current!.insertSensor('Flow (m3/h)'));
        expect(field().value).toBe('$A + ${Flow (m3/h)}');
    });
});

describe('Round the result', () => {
    it('is set in one place, shows the stored form and previews the stored text', async () => {
        const { last } = setup();
        type('$A + $B');
        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Round the result' })).getByRole('radio', { name: '2' }));
        expect(screen.getByTestId('round-hint').textContent).toContain('stored as round(… * 100) / 100');
        const s = last().state!;
        expect(s.mode === 'formula' && editorStateFormula(s)).toBe('round(($A + $B) * 100) / 100');
        await flush();
        expect(mockInvoke).toHaveBeenLastCalledWith('preview_formula', expect.objectContaining({ formula: 'round(($A + $B) * 100) / 100' }));
    });

    it('Rust ranges on the stored text map back into the field', async () => {
        reply = () => refused('unknown_sensor', 'Sensor not found: Zed', [12, 16]);
        setup();
        type('$A + $Zed');
        fireEvent.blur(field()); // the word is finished: the suggestions close
        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Round the result' })).getByRole('radio', { name: '2' }));
        await flush();
        // `round(($A + $Zed) * 100) / 100`: [12, 16) is `$Zed`, at [5, 9) in the field.
        expect([...mirror().querySelectorAll('.err')].map(e => e.textContent)).toEqual(['$Zed']);
    });

    it('never wraps a body with an unpaired bracket: the broken text is checked and saved as typed', async () => {
        const { last } = setup();
        type('$A) + ($B');
        fireEvent.blur(field());
        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Round the result' })).getByRole('radio', { name: '2' }));
        await flush();
        const s = last().state!;
        expect(s.mode === 'formula' && editorStateFormula(s)).toBe('$A) + ($B');
        const sent = mockInvoke.mock.calls.filter(c => c[0] === 'preview_formula').map(c => (c[1] as { formula: string }).formula);
        expect(sent.some(f => f.startsWith('round('))).toBe(false);
    });
});

describe('Quick build', () => {
    const qb = () => screen.getByTestId('quick-build');
    const out = () => screen.getByTestId('quick-build-output');

    it('0 picked: a hint only', () => {
        setup();
        expect(qb().textContent).toContain('Pick sensors on the left to get started');
    });

    it('1 picked: a number stays dim until typed, then Use this formula writes it into the editor', () => {
        setup({ quickSelected: ['A'] });
        expect(out().textContent).toBe('$A');
        fireEvent.click(within(within(qb()).getByRole('group', { name: 'Combine with a number' })).getByRole('button', { name: '+' }));
        expect(out().className).toContain('dim');
        expect(qb().textContent).toContain('Enter the number.');
        expect((within(qb()).getByRole('button', { name: 'Use this formula' }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(within(qb()).getByLabelText('Value'), { target: { value: '5' } });
        expect(out().textContent).toBe('$A + 5');
        fireEvent.click(within(qb()).getByRole('button', { name: 'Use this formula' }));
        expect(field().value).toBe('$A + 5');
    });

    it('1 picked: round reveals decimals and writes the engine form; with text Insert brackets the piece', () => {
        setup({ quickSelected: ['A'] });
        fireEvent.click(within(within(qb()).getByRole('group', { name: 'Transform' })).getByRole('button', { name: 'round' }));
        expect(out().textContent).toBe('round($A * 100) / 100');
        fireEvent.change(within(qb()).getByLabelText('Decimals'), { target: { value: '1' } });
        expect(out().textContent).toBe('round($A * 10) / 10');
        type('2 * ', 4);
        fireEvent.click(within(qb()).getByRole('button', { name: 'Insert at cursor' }));
        expect(field().value).toBe('2 * (round($A * 10) / 10)');
        fireEvent.click(within(qb()).getByRole('button', { name: 'Replace formula' }));
        expect(field().value).toBe('round($A * 10) / 10');
    });

    it('2+ picked: a chain with + by default; a sign menu changes it; a combination dims the signs', () => {
        const { rerenderWith } = setup({ quickSelected: ['A', 'B'] });
        expect(out().textContent).toBe('$A + $B');
        fireEvent.click(within(qb()).getByRole('button', { name: 'Sign before B' }));
        fireEvent.click(screen.getByRole('menuitem', { name: /−/ }));
        expect(out().textContent).toBe('$A - $B');
        fireEvent.click(within(qb()).getByRole('button', { name: 'Spread' }));
        expect(out().textContent).toBe('max($A, $B) - min($A, $B)');
        expect((within(qb()).getByRole('button', { name: 'Sign before B' }) as HTMLButtonElement).disabled).toBe(true);
        // |A − B| and Efficiency % only with exactly 2.
        expect(within(qb()).getByRole('button', { name: '|A − B|' })).toBeTruthy();
        rerenderWith({ quickSelected: ['A', 'B', 'C'] });
        expect(within(qb()).queryByRole('button', { name: '|A − B|' })).toBeNull();
        expect(within(qb()).queryByRole('button', { name: 'Efficiency %' })).toBeNull();
    });

    it('Efficiency % stays dim until the input is chosen; Then wrap applies on top', () => {
        setup({ quickSelected: ['A', 'B'] });
        fireEvent.click(within(qb()).getByRole('button', { name: 'Efficiency %' }));
        expect(out().className).toContain('dim');
        fireEvent.click(within(qb()).getByLabelText('Input = A'));
        expect(out().textContent).toBe('($B / $A) * 100');
        fireEvent.click(within(within(qb()).getByRole('group', { name: 'Then wrap' })).getByRole('button', { name: 'abs' }));
        expect(out().textContent).toBe('abs(($B / $A) * 100)');
    });

    it('Average is a BLOCK: "missing values skipped", Use this block, and Then wrap is hidden', async () => {
        const { last } = setup({ quickSelected: ['A', 'B', 'C'] });
        fireEvent.click(within(qb()).getByRole('button', { name: 'Average' }));
        expect(out().textContent).toBe('Average of 3 sensors · missing values skipped');
        expect(within(qb()).queryByRole('group', { name: 'Then wrap' })).toBeNull();
        fireEvent.click(within(qb()).getByRole('button', { name: 'Use this block' }));
        expect(screen.getByTestId('formula-card').textContent).toContain('Average block');
        expect(screen.queryByLabelText('Formula')).toBeNull();
        expect(last().state).toEqual({ mode: 'block', type: 'mean', sources: ['A', 'B', 'C'], decimals: null, note: null });
        // Round the result on a block = the block's own decimals (multiOp.decimals), never a round() wrap.
        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Round the result' })).getByRole('radio', { name: '1' }));
        expect(last().state).toMatchObject({ mode: 'block', decimals: 1 });
        expect(editorStateToRecipe(last().state!, 'AVG')).toEqual({
            kind: 'operation', tag: 'AVG', sourceSensors: ['A', 'B', 'C'],
            operationConfig: { mode: 'multi', multiOp: { type: 'mean', decimals: 1 }, customName: 'AVG' },
        });
        await flush();
        expect(mockInvoke).toHaveBeenLastCalledWith('preview_formula', expect.objectContaining({
            aggregate: { type: 'mean', sources: ['A', 'B', 'C'], decimals: 1 }, formula: undefined,
        }));
    });

    it('a block offers only Replace formula for a formula (no Insert into a block)', () => {
        setup({ quickSelected: ['A', 'B'] });
        fireEvent.click(within(qb()).getByRole('button', { name: 'Median' }));
        fireEvent.click(within(qb()).getByRole('button', { name: 'Use this block' }));
        fireEvent.click(within(qb()).getByRole('button', { name: 'Median' })); // back to the chain
        expect(within(qb()).queryByRole('button', { name: 'Insert at cursor' })).toBeNull();
        fireEvent.click(within(qb()).getByRole('button', { name: 'Replace formula' }));
        expect(field().value).toBe('$A + $B');
    });

    it('the option sets reset when the pick count changes bucket (1 → 2+)', () => {
        const { rerenderWith } = setup({ quickSelected: ['A'] });
        fireEvent.click(within(within(qb()).getByRole('group', { name: 'Transform' })).getByRole('button', { name: 'abs' }));
        expect(out().textContent).toBe('abs($A)');
        rerenderWith({ quickSelected: ['A', 'B'] });
        expect(out().textContent).toBe('$A + $B');
        rerenderWith({ quickSelected: ['A'] });
        expect(out().textContent).toBe('$A');
    });

    it('Clear picks calls back', () => {
        const onQuickClear = vi.fn();
        setup({ quickSelected: ['A'], onQuickClear });
        fireEvent.click(within(qb()).getByRole('button', { name: 'Clear picks' }));
        expect(onQuickClear).toHaveBeenCalled();
    });

    it('QuickBuild alone: Use / Insert / Replace hand the generated piece back', () => {
        const onUse = vi.fn();
        const onInsert = vi.fn();
        render(<QuickBuild selected={['A', 'B']} editorEmpty={false} blockMode={false} onClear={() => {}} onUse={onUse} onInsert={onInsert} onBlock={() => {}} />);
        fireEvent.click(screen.getByRole('button', { name: 'Insert at cursor' }));
        expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({ formula: '$A + $B', hasTopLevelOperator: true }));
        fireEvent.click(screen.getByRole('button', { name: 'Replace formula' }));
        expect(onUse).toHaveBeenCalled();
    });
});

describe('Edit, Locked and Repair', () => {
    const F = (formula: string): SpecialSensorRecipe => ({ kind: 'formula', tag: 'S1', formula });

    it('Edit opens the stored formula with its rounding split out; edited flips once the maths change', async () => {
        const { last } = setup({ initialRecipe: F('round(($A + $B) * 100) / 100') });
        expect(field().value).toBe('$A + $B');
        expect(within(screen.getByRole('radiogroup', { name: 'Round the result' })).getByRole('radio', { name: '2' }).getAttribute('aria-checked')).toBe('true');
        expect(last()).toMatchObject({ edited: false });
        await flush();
        // Edit previews with `replace: true`, the same value Save sends.
        expect(mockInvoke).toHaveBeenCalledWith('preview_formula', expect.objectContaining({ replace: true }));
        type('$A - $B');
        expect(last()).toMatchObject({ edited: true });
    });

    it('a stored rounding outside the usual choices (4 places) shows as one more, selected, choice', () => {
        const { last } = setup({ initialRecipe: F('round($A * 10000) / 10000') });
        expect(field().value).toBe('$A');
        const group = within(screen.getByRole('radiogroup', { name: 'Round the result' }));
        expect(group.getAllByRole('radio').map(r => r.textContent)).toEqual(['Off', '0', '1', '2', '3', '4']);
        expect(group.getByRole('radio', { name: '4' }).getAttribute('aria-checked')).toBe('true');
        expect(last()).toMatchObject({ edited: false });
        // Picking a usual choice drops the extra one.
        fireEvent.click(group.getByRole('radio', { name: '2' }));
        expect(within(screen.getByRole('radiogroup', { name: 'Round the result' })).queryByRole('radio', { name: '4' })).toBeNull();
    });

    it('a block stored with 5 decimals shows 5 selected', () => {
        setup({
            initialRecipe: { kind: 'operation', tag: 'AVG', sourceSensors: ['A', 'B'], operationConfig: { mode: 'multi', multiOp: { type: 'mean', decimals: 5 }, customName: 'AVG' } },
        });
        expect(within(screen.getByRole('radiogroup', { name: 'Round the result' })).getByRole('radio', { name: '5' }).getAttribute('aria-checked')).toBe('true');
    });

    it('a legacy Sum operation opens expanded as A + B + C with a note', () => {
        const { last } = setup({
            initialRecipe: { kind: 'operation', tag: 'SUM', sourceSensors: ['A', 'B', 'C'], operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: 'SUM' } },
        });
        expect(field().value).toBe('$A + $B + $C');
        expect(screen.getByTestId('formula-note').textContent).toContain('Opened from a Sum recipe as A + B + C');
        expect(last()).toMatchObject({ edited: false });
    });

    it('an Average block opens as a block; adding a source keeps it an average', () => {
        const { last } = setup({
            initialRecipe: { kind: 'operation', tag: 'AVG', sourceSensors: ['A', 'B'], operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'AVG' } },
        });
        expect(screen.getByTestId('formula-card').textContent).toContain('Average block');
        pickMulti(screen.getByRole('button', { name: 'Add…' }), ['C']);
        expect(last().state).toMatchObject({ mode: 'block', type: 'mean', sources: ['A', 'B', 'C'] });
        expect(last().edited).toBe(true);
    });

    it('Locked: a read-only dashed field, one lock pill + sentence, no Quick build / palette, no preview', async () => {
        setup({
            initialRecipe: F('$A * 2'),
            locked: { short: 'Used by 1 model', detail: 'Used by Pump model (target).' },
            quickSelected: ['A'],
        });
        expect(field().readOnly).toBe(true);
        expect(screen.getByTestId('formula-lock-pill').textContent).toContain('Used by 1 model');
        expect(check().textContent).toContain('Name and formula are locked. Used by Pump model (target).');
        expect(screen.queryByTestId('quick-build')).toBeNull();
        expect(screen.queryByRole('toolbar', { name: 'Insert' })).toBeNull();
        for (const r of within(screen.getByRole('radiogroup', { name: 'Round the result' })).getAllByRole('radio')) {
            expect((r as HTMLButtonElement).disabled).toBe(true);
        }
        await flush();
        expect(mockInvoke).not.toHaveBeenCalledWith('preview_formula', expect.anything());
    });

    it('Repair: amber pill and note with Rust’s reason, the formula is editable, the error sits in the text', async () => {
        reply = () => refused('missing_operator', 'Two values side by side — put an operator such as * between them.', [0, 6]);
        setup({ initialRecipe: F('$A ($B)'), repair: { reason: 'Formula error: missing operator.', retrain: 2 } });
        expect(screen.getByText('No data — fix formula')).toBeTruthy();
        const note = screen.getByTestId('restore-note').textContent!;
        expect(note).toContain('Formula error: missing operator');
        expect(note).toContain('2 models trained on it will need training again (set points are kept)');
        expect(field().readOnly).toBe(false);
        // The front-end check places it at once; Rust's verdict replaces it when it lands.
        expect(check().textContent).toContain('$A is a sensor, not a function');
        await flush();
        expect(check().textContent).toContain('Two values side by side');
        fireEvent.click(within(check()).getByRole('button', { name: 'Insert ×' }));
        expect(field().value).toBe('$A * ($B)');
    });
});

describe('SensorFieldsCard', () => {
    it('shows the title, locks the name, and lists components without free typing', () => {
        const setName = vi.fn();
        render(
            <SensorFieldsCard
                title="Edit sensor" name="S1" setName={setName} nameLocked nameLockReason="Locked" nameError={null}
                description="" setDescription={() => {}} unit="" setUnit={() => {}} component="" setComponent={() => {}}
                components={['Pump']}
            />,
        );
        expect(screen.getByText('Edit sensor')).toBeTruthy();
        expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
        const opts = [...(screen.getByLabelText('Component') as HTMLSelectElement).options].map(o => o.value);
        expect(opts).toEqual(['', 'Pump', 'Uncategorized']);
    });
});
