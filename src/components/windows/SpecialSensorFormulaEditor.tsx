import {
    forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
    type ReactNode, type RefObject,
} from 'react';
import { AlertTriangle, ChevronDown, Lock } from 'lucide-react';
import AnchoredPopover, { type PopoverAnchorRect } from '../AnchoredPopover';
import { PickerList, SensorPickerMulti, pickerMaxHeight, usePopoverDismiss } from '../sensor/SensorPicker';
import { SensorInline } from '../sensor/SensorLabel';
import { fmtNum, sensorHaystack, sensorTitle, useSensorLookup } from '../sensor/sensorInfo';
import type { SpecialSensorRecipe } from '../../types';
import type { FormulaIssue } from '../../types/formula';
import { bracketPairAt, referencedSensors, tokenizeFormula, type FormulaToken } from '../../utils/formulaTokens';
import { checkAggregate, checkFormula, sensorResolver, ZERO_ARG_FUNCTIONS } from '../../utils/formulaCheck';
import {
    applyCompletion, autocompleteContext, functionSuggestions, issueWhileTyping,
    type AutocompleteContext, type CompletionItem,
} from '../../utils/formulaAutocomplete';
import {
    fixForIssue, insertFunction, insertOperator, insertSensorAt, replaceSensorEverywhere, unwrapAt, wrapSelection,
    type FormulaEdit,
} from '../../utils/formulaFixes';
import { rangeToBody, withRoundResult } from '../../utils/formulaRounding';
import {
    blockPreviewAggregate, editorStateFormula, insertQuickPiece, quickMulti, quickSingle, recipeToEditorState,
    QUICK_NUMBER_OPS, QUICK_TRANSFORMS,
    type FormulaEditorNote, type FormulaEditorState, type QuickBlock, type QuickCombine, type QuickFormula,
    type QuickNumberOp, type QuickResult, type QuickTransform,
} from '../../utils/quickBuild';
import { sensorRef } from '../../utils/specialSensorNaming';
import { resolveFormulaVerdict, usePreviewFormula } from '../../hooks/usePreviewFormula';

/**
 * The special-sensor Formula editor + Quick build (spec:
 * `docs/design/handoff/customer-batch-2026-10/README.md` §5, DESIGN_SYSTEM §4.1).
 *
 * ONE free-text field — the stored formula itself (`$Tag` / `${Tag with spaces}`) — with its
 * structure painted behind the text: a transparent `<textarea>` over a mirror in the same mono
 * font. The mirror is rendered from `tokenizeFormula` (one tokenize per text change, memoised),
 * so it re-renders only when the text, the bracket pair at the caret, the error range or the
 * autocomplete anchor change. Every programmatic edit (wrap, unwrap, palette, fix, autocomplete,
 * Quick build insert) goes through `applyEdit`, a NATIVE insertion over the changed range
 * (`execCommand('insertText')`), so Ctrl+Z / Ctrl+Shift+Z undo it like typing.
 *
 * Average / Median stay an aggregate BLOCK (`kind: 'operation'`, its own `multiOp.decimals`).
 * The live check is the cheap front-end pass (`checkFormula`) until Rust's
 * `preview_formula` answers for the current text (`resolveFormulaVerdict`); the function list is
 * Rust's (never retyped here). The window decides what Add / Save do with the reported state.
 */

/** What the editor tells the window after every change. */
export interface FormulaEditorReport {
    /** null = nothing to save (the editor is empty). */
    state: FormulaEditorState | null;
    /** The issue that blocks Add / Save (the footer repeats its message); null = none known. */
    issue: FormulaIssue | null;
    /** The calculation differs from the one the editor opened with (Edit / Repair). */
    edited: boolean;
}

export interface FormulaEditorHandle {
    /** The `$` button on a left-list row: `$TAG` at the caret (a block gains a source). */
    insertSensor: (tag: string) => void;
}

export interface FormulaEditorLock {
    /** The pill: "Used by 2 models". */
    short: string;
    /** The one lock sentence (`describeEditLock`). */
    detail: string;
}

export interface FormulaEditorRepair {
    /** Rust's reason the stored recipe was refused, or null. */
    reason: string | null;
    /** Models that go back to Incomplete when the fix is saved; null = not known. */
    retrain: number | null;
}

interface Props {
    /** Sensors the formula may use: autocomplete, Replace…, a block's "Add…" (excludes the sensor
     *  being edited and everything built on it). */
    sensors: string[];
    /** Every column in the dataset (an unknown one is painted red). */
    knownSensors: string[];
    /** Rust dataset generation the window is bound to (`expectedGeneration` of the preview). */
    generation?: number;
    /** Edit / Repair: the stored recipe, loaded ONCE (the window remounts the editor per session). */
    initialRecipe: SpecialSensorRecipe | null;
    /** Locked (a model / the running condition / another sensor uses it and it has data). */
    locked: FormulaEditorLock | null;
    /** Repair: the sensor has no data this session (unlocked even under a model lock). */
    repair: FormulaEditorRepair | null;
    /** Sensors picked in the left list — drive Quick build's option sets. */
    quickSelected: string[];
    onQuickClear: () => void;
    /** Unit of the sensor being built (the preview stats). */
    unit: string;
    onReport: (report: FormulaEditorReport) => void;
}

/** One line per engine function (hover / suggestions). The LIST comes from Rust; this is only
 *  the wording for the names we know (an unknown one shows without a meaning). */
const FN_HELP: Record<string, string> = {
    abs: 'size of a value, sign removed', sqrt: 'square root', pow: 'pow(x, n) = x ^ n', exp: 'e ^ x',
    ln: 'natural log', log: 'log base 10', log10: 'log base 10',
    round: 'round(x) to a whole number · for decimals round(x * 100) / 100',
    min: 'smallest of the values', max: 'largest of the values', ceil: 'round up', floor: 'round down',
    sin: 'sine (radians)', cos: 'cosine (radians)', tan: 'tangent (radians)', asin: 'arc sine', acos: 'arc cosine',
    atan: 'arc tangent', sinh: 'hyperbolic sine', cosh: 'hyperbolic cosine', tanh: 'hyperbolic tangent',
    asinh: 'inverse sinh', acosh: 'inverse cosh', atanh: 'inverse tanh', sign: '−1, 0 or 1',
    int: 'whole part, decimals cut', pi: 'π = 3.14159…', e: 'e = 2.71828…',
};
const PALETTE_FNS = ['abs', 'sqrt', 'ln', 'log10', 'exp', 'round', 'min', 'max', 'ceil', 'floor'];
const FN_LABEL: Record<string, string> = { sqrt: '√', log10: 'log₁₀' };
const OP_SYMBOL: Record<QuickNumberOp, string> = { '+': '+', '-': '−', '*': '×', '/': '÷', '^': '^' };
const OP_NAME: Record<QuickNumberOp, string> = { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '^': 'power' };
const BLOCK_NAME = { mean: 'Average', median: 'Median', sum: 'Sum' } as const;
const ROUND_CHOICES: Array<number | null> = [null, 0, 1, 2, 3];
const EMPTY_REPORT: FormulaEditorReport = { state: null, issue: null, edited: false };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

type BlockState = { type: 'mean' | 'median' | 'sum'; sources: string[]; decimals: number | null };

const rectOf = (el: Element): PopoverAnchorRect => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
};

/** Same calculation? (Quick build "As-is" may rebuild the same text.) */
function sameState(a: FormulaEditorState | null, b: FormulaEditorState | null): boolean {
    if (!a || !b) return a === b;
    if (a.mode === 'formula' && b.mode === 'formula') return editorStateFormula(a) === editorStateFormula(b);
    if (a.mode === 'block' && b.mode === 'block') {
        return a.type === b.type && a.decimals === b.decimals
            && a.sources.length === b.sources.length && a.sources.every((s, i) => s === b.sources[i]);
    }
    return false;
}

const issueKey = (i: FormulaIssue | null) => (i ? `${i.code}|${i.message}|${i.range?.join(',') ?? ''}` : '');

const NOTE_TEXT: Record<FormulaEditorNote, string> = {
    'legacy-sum': 'Opened from a Sum recipe as A + B + C. Saving keeps the same result (a row is missing when any source is missing) and stores it as a formula.',
    'legacy-operation': 'Opened from a one-sensor operation as its formula. Saving without changing the maths keeps the stored recipe as it is.',
};

const SpecialSensorFormulaEditor = forwardRef<FormulaEditorHandle, Props>(function SpecialSensorFormulaEditor(props, ref) {
    const { sensors, knownSensors, generation, initialRecipe, locked, repair, quickSelected, onQuickClear, unit, onReport } = props;
    const lookup = useSensorLookup();
    const editing = initialRecipe !== null;

    // ---- What the editor holds (seeded once from the recipe) ----------------------------------
    const initial = useMemo(() => (initialRecipe ? recipeToEditorState(initialRecipe) : null), []); // eslint-disable-line react-hooks/exhaustive-deps
    const [text, setText] = useState(initial?.mode === 'formula' ? initial.text : '');
    const [roundDecimals, setRoundDecimals] = useState<number | null>(initial?.mode === 'formula' ? initial.roundDecimals : null);
    const [block, setBlock] = useState<BlockState | null>(
        initial?.mode === 'block' ? { type: initial.type, sources: [...initial.sources], decimals: initial.decimals } : null,
    );
    const [note, setNote] = useState<FormulaEditorNote | null>(initial?.note ?? null);

    const state = useMemo<FormulaEditorState | null>(() => {
        if (block) return { mode: 'block', ...block, note };
        if (!text.trim()) return null;
        return { mode: 'formula', text, roundDecimals, note };
    }, [block, text, roundDecimals, note]);

    // ---- Caret / selection, focus, autocomplete ------------------------------------------------
    const taRef = useRef<HTMLTextAreaElement>(null);
    const mirrorRef = useRef<HTMLDivElement>(null);
    const [sel, setSel] = useState<[number, number]>(() => {
        const n = initial?.mode === 'formula' ? initial.text.length : 0;
        return [n, n];
    });
    const [focused, setFocused] = useState(false);
    const [ac, setAc] = useState<{ ctx: AutocompleteContext; idx: number } | null>(null);
    const [acRect, setAcRect] = useState<PopoverAnchorRect | null>(null);
    const pendingSel = useRef<[number, number] | null>(null);
    const suppressAc = useRef(false);

    const tokens = useMemo(() => tokenizeFormula(text), [text]);
    const isKnown = useMemo(() => sensorResolver(knownSensors), [knownSensors]);

    // ---- Live check + preview ------------------------------------------------------------------
    const rounded = useMemo(() => withRoundResult(text, roundDecimals), [text, roundDecimals]);
    const previewInput = useMemo(() => {
        if (locked) return null; // preview is off while the formula is locked
        if (block) return { aggregate: blockPreviewAggregate(block) };
        return rounded.formula ? { formula: rounded.formula } : null;
    }, [locked, block, rounded]);
    const preview = usePreviewFormula({ input: previewInput, generation, replace: editing });
    const functions = preview.functions;
    const mode = editing ? 'edit' : 'create';
    const cheap = useMemo(() => {
        if (locked) return null;
        if (block) return checkAggregate(blockPreviewAggregate(block), { isKnownSensor: isKnown, mode });
        return checkFormula(text, tokens, {
            isKnownSensor: isKnown, functions, mode,
            maxLength: preview.limits?.max_len, maxDepth: preview.limits?.max_depth,
        });
    }, [locked, block, text, tokens, isKnown, functions, mode, preview.limits]);
    // Rust checked the STORED text (with the round wrapper): its ranges map back into the field.
    const rustIssues = useMemo(
        () => (block ? preview.issues : preview.issues.map(i => ({ ...i, range: rangeToBody(i.range, rounded) }))),
        [block, preview.issues, rounded],
    );
    const verdict = useMemo(
        () => resolveFormulaVerdict(cheap, { isCurrent: preview.isCurrent, ok: preview.ok, issues: rustIssues }),
        [cheap, preview.isCurrent, preview.ok, rustIssues],
    );
    const blocking = locked || !state ? null : verdict.issue;
    // No red flash for the word still being typed.
    const shown = useMemo(() => issueWhileTyping(blocking, ac?.ctx ?? null), [blocking, ac]);

    // ---- Report to the window (only when something it reads changed) ----------------------------
    const edited = !sameState(state, initial);
    const reportRef = useRef<string>('');
    const blockingKey = issueKey(blocking);
    useEffect(() => {
        const key = JSON.stringify([state, blockingKey, edited]);
        if (key === reportRef.current) return;
        reportRef.current = key;
        onReport(state ? { state, issue: blocking, edited } : { ...EMPTY_REPORT, edited });
        // `blocking` is read through its key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state, blockingKey, edited, onReport]);

    // ---- Editing primitives --------------------------------------------------------------------
    const currentSel = (): [number, number] => {
        const ta = taRef.current;
        return ta ? [ta.selectionStart, ta.selectionEnd] : sel;
    };

    /** Apply an edit as a native insertion over the changed range (undoable), else as a state write. */
    const applyEdit = useCallback((edit: FormulaEdit) => {
        setAc(null);
        setNote(null);
        const ta = taRef.current;
        if (ta) {
            const old = ta.value;
            const next = edit.text;
            if (old === next) {
                ta.focus();
                ta.setSelectionRange(edit.selection[0], edit.selection[1]);
                setSel(edit.selection);
                return;
            }
            let p = 0;
            while (p < old.length && p < next.length && old[p] === next[p]) p++;
            let q = 0;
            while (q < old.length - p && q < next.length - p && old[old.length - 1 - q] === next[next.length - 1 - q]) q++;
            ta.focus();
            ta.setSelectionRange(p, old.length - q);
            suppressAc.current = true;
            let ok: boolean;
            try {
                ok = typeof document.execCommand === 'function'
                    && document.execCommand('insertText', false, next.slice(p, next.length - q));
            } catch {
                ok = false;
            }
            suppressAc.current = false;
            if (ok && ta.value === next) {
                ta.setSelectionRange(edit.selection[0], edit.selection[1]);
                setSel(edit.selection);
                return;
            }
        }
        // Fallback (the browser refused the native insertion): a plain write.
        setText(edit.text);
        pendingSel.current = edit.selection;
    }, []);

    useLayoutEffect(() => {
        const p = pendingSel.current;
        const ta = taRef.current;
        if (!p || !ta) return;
        pendingSel.current = null;
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(p[0], p[1]);
        setSel(p);
    }, [text, block]);

    // Repair opens on the error: focus the field.
    useEffect(() => {
        if (repair && !block) taRef.current?.focus({ preventScroll: true });
        // Mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const insertSensor = useCallback((tag: string) => {
        if (locked) return;
        if (block) {
            setBlock(b => (b && !b.sources.includes(tag) ? { ...b, sources: [...b.sources, tag] } : b));
            return;
        }
        const ta = taRef.current;
        const [s, e] = ta ? [ta.selectionStart, ta.selectionEnd] : [text.length, text.length];
        applyEdit(insertSensorAt(ta ? ta.value : text, s, e, tag));
    }, [locked, block, text, applyEdit]);
    useImperativeHandle(ref, () => ({ insertSensor }), [insertSensor]);

    const pair = useMemo(() => bracketPairAt(tokens, sel[0], sel[1]), [tokens, sel]);
    const wrap = () => {
        const [s, e] = currentSel();
        const edit = wrapSelection(text, s, e);
        if (edit) applyEdit(edit);
    };
    const unwrap = () => {
        const [s, e] = currentSel();
        const edit = unwrapAt(text, s, e, tokens);
        if (edit) applyEdit(edit);
    };
    const insertOp = (op: QuickNumberOp) => { const [s, e] = currentSel(); applyEdit(insertOperator(text, s, e, op)); };
    const insertFn = (name: string) => { const [s, e] = currentSel(); applyEdit(insertFunction(text, s, e, name)); };
    const selectRange = (r: [number, number]) => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(r[0], r[1]);
        setSel(r);
    };

    // ---- Autocomplete ---------------------------------------------------------------------------
    const openAc = (value: string, caret: number, force = false) => {
        const ctx = autocompleteContext(value, caret, { force });
        setAc(prev => (ctx ? { ctx, idx: prev && prev.ctx.start === ctx.start ? prev.idx : 0 } : null));
    };
    const acItems = useMemo<CompletionItem[]>(() => {
        if (!ac) return [];
        const q = ac.ctx.query.trim().toLowerCase();
        const sensorHits: CompletionItem[] = [];
        for (const t of sensors) {
            if (q && !sensorHaystack(lookup(t)).includes(q)) continue;
            sensorHits.push({ kind: 'sensor', tag: t });
            if (sensorHits.length >= 7) break;
        }
        const fnHits = functionSuggestions(ac.ctx, functions ?? [], 4).map(name => ({ kind: 'function' as const, name }));
        return [...sensorHits, ...fnHits];
    }, [ac, sensors, lookup, functions]);
    const acIndex = ac ? Math.min(ac.idx, Math.max(0, acItems.length - 1)) : 0;
    const pickAc = (item: CompletionItem) => {
        if (!ac) return;
        applyEdit(applyCompletion(text, ac.ctx, item));
    };
    const acAnchor = ac ? ac.ctx.start : -1;
    useLayoutEffect(() => {
        if (acAnchor < 0) { setAcRect(null); return; }
        const el = mirrorRef.current?.querySelector('[data-caret]');
        if (el) setAcRect(rectOf(el));
    }, [acAnchor, text]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (locked) return;
        const ta = e.currentTarget;
        const s = ta.selectionStart;
        const en = ta.selectionEnd;
        if (ac && acItems.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAc({ ...ac, idx: (acIndex + 1) % acItems.length }); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setAc({ ...ac, idx: (acIndex - 1 + acItems.length) % acItems.length }); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAc(acItems[acIndex]); return; }
        }
        if (e.key === 'Escape') {
            if (ac) { e.preventDefault(); e.stopPropagation(); setAc(null); }
            return;
        }
        if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); openAc(ta.value, s, true); return; }
        // One-line formula: Enter never inserts a newline.
        if (e.key === 'Enter') { e.preventDefault(); return; }
        // `(` over a selection wraps it (the inside stays selected).
        if (e.key === '(' && s !== en) {
            e.preventDefault();
            const edit = wrapSelection(ta.value, s, en);
            if (edit) applyEdit(edit);
        }
    };
    const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const v = e.target.value.replace(/[\r\n]+/g, ' ');
        setText(v);
        setNote(null);
        const caret = e.target.selectionStart ?? v.length;
        setSel([caret, e.target.selectionEnd ?? caret]);
        if (suppressAc.current) setAc(null);
        else openAc(v, caret);
    };
    const readSel = () => {
        const ta = taRef.current;
        if (!ta) return;
        const next: [number, number] = [ta.selectionStart, ta.selectionEnd];
        setSel(prev => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
        // The caret left the word being completed.
        if (ac && (next[0] !== next[1] || next[0] < ac.ctx.start || next[0] > ac.ctx.end)) setAc(null);
    };

    // Hover a reference / function: its description on the field (the mirror sits under the textarea).
    const hoverFrame = useRef(0);
    const onMouseMove = (e: React.MouseEvent<HTMLTextAreaElement>) => {
        const { clientX, clientY } = e;
        const ta = e.currentTarget;
        cancelAnimationFrame(hoverFrame.current);
        hoverFrame.current = requestAnimationFrame(() => {
            let tip = '';
            for (const el of mirrorRef.current?.querySelectorAll<HTMLElement>('[data-tip]') ?? []) {
                for (const r of el.getClientRects()) {
                    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) { tip = el.dataset.tip ?? ''; break; }
                }
                if (tip) break;
            }
            if (ta.title !== tip) ta.title = tip;
        });
    };
    useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);

    // ---- Replace… (unknown sensor) and the "All functions" menu --------------------------------
    const [replace, setReplace] = useState<{ name: string; rect: PopoverAnchorRect } | null>(null);
    const replaceTrigger = useRef<HTMLElement | null>(null);
    const closeReplace = useCallback(() => setReplace(null), []);
    usePopoverDismiss(!!replace, replaceTrigger as RefObject<HTMLElement | null>, 'pk-pop', closeReplace);
    const openReplace = (name: string, el: HTMLElement) => { replaceTrigger.current = el; setReplace({ name, rect: rectOf(el) }); };
    const [fnMenu, setFnMenu] = useState<PopoverAnchorRect | null>(null);
    const fnTrigger = useRef<HTMLButtonElement>(null);
    const closeFnMenu = useCallback(() => setFnMenu(null), []);
    usePopoverDismiss(!!fnMenu, fnTrigger, 'fx-fnmenu', closeFnMenu);

    // ---- Quick build → editor --------------------------------------------------------------------
    const applyQuickFormula = (f: QuickFormula) => {
        if (locked) return;
        setBlock(null);
        setRoundDecimals(null);
        if (taRef.current && !block) applyEdit({ text: f.formula, selection: [f.formula.length, f.formula.length] });
        else { setText(f.formula); setNote(null); pendingSel.current = [f.formula.length, f.formula.length]; }
    };
    const insertQuick = (f: QuickFormula) => {
        if (locked || block) return;
        const [s, e] = currentSel();
        applyEdit(insertQuickPiece(text, s, e, f));
    };
    const applyQuickBlock = (b: QuickBlock) => {
        if (locked) return;
        setText('');
        setRoundDecimals(null);
        setNote(null);
        setAc(null);
        setBlock({ type: b.type, sources: [...b.sources], decimals: b.decimals });
    };
    const clearAll = () => {
        setBlock(null);
        setRoundDecimals(null);
        setNote(null);
        setAc(null);
        if (taRef.current && text) applyEdit({ text: '', selection: [0, 0] });
        else setText('');
        taRef.current?.focus();
    };

    // ---- Derived display --------------------------------------------------------------------------
    const typingName = ac?.ctx.kind === 'sensor' ? ac.ctx : null;
    const used = useMemo(
        () => referencedSensors(tokens).filter(r => !(typingName && r.start >= typingName.start && r.start < Math.max(typingName.end, typingName.start + 1))),
        [tokens, typingName],
    );
    const nSensors = block ? block.sources.length : used.length;
    const errRange = !locked && shown?.range ? shown.range : null;
    const fix = useMemo(() => {
        if (locked || block || !shown) return null;
        return fixForIssue(text, shown, { functions, convertedFormula: roundDecimals === null ? preview.converted_formula : null });
    }, [locked, block, shown, text, functions, roundDecimals, preview.converted_formula]);
    const placeholder = useMemo(() => {
        const [a, b] = sensors;
        return a && b ? `e.g. (${sensorRef(a)} - ${sensorRef(b)}) * 100` : 'e.g. ($A - $B) * 100';
    }, [sensors]);

    const mirror = useMemo(
        () => renderMirror(text, tokens, {
            errStart: errRange?.[0] ?? -1, errEnd: errRange?.[1] ?? -1,
            pair: focused ? pair : null, isKnown, caret: acAnchor, lookup, locked: !!locked,
        }),
        // Keyed on the values that change what is painted, not on object identities.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [text, tokens, errRange?.[0], errRange?.[1], focused ? pair?.[0] : -1, focused ? pair?.[1] : -1, isKnown, acAnchor, lookup, locked],
    );

    const maxLen = preview.limits?.max_len ?? 4096;
    const checkClass = locked ? 'lock' : !state ? 'idle' : shown ? 'bad' : verdict.valid ? 'ok' : 'idle';
    const rows = preview.isCurrent ? preview.stats?.rows ?? 0 : 0;

    return (
        <>
            {!locked && (
                <QuickBuild
                    selected={quickSelected}
                    editorEmpty={!state}
                    blockMode={!!block}
                    onClear={onQuickClear}
                    onUse={applyQuickFormula}
                    onInsert={insertQuick}
                    onBlock={applyQuickBlock}
                />
            )}

            <div className={`fx-card${repair ? ' repair' : ''}`} data-testid="formula-card">
                <div className="fx-ct">
                    {block ? `${BLOCK_NAME[block.type]} block` : 'Formula'}
                    {repair && <span className="fx-pill warn"><AlertTriangle size={11} /> No data — fix formula</span>}
                    {locked && <span className="fx-pill" data-testid="formula-lock-pill"><Lock size={11} /> {locked.short}</span>}
                    <span className="fx-r">
                        {block
                            ? `${plural(nSensors, 'sensor')} · missing values skipped`
                            : text ? `${plural(nSensors, 'sensor')} · ${text.length.toLocaleString('en-US')} / ${maxLen.toLocaleString('en-US')}` : ''}
                        {!locked && (text || block) && <button type="button" className="fx-link" onClick={clearAll}>Clear</button>}
                    </span>
                </div>

                {repair && (
                    <div className="fx-repair" role="note" data-testid="restore-note">
                        <b>This sensor has no data this session</b> — its formula was refused when the project opened
                        {repair.reason ? <>: <span className="fx-mono">{repair.reason.replace(/[.\s]+$/, '')}</span>.</> : '.'}
                        {' '}Fix the formula and save. The name stays locked
                        {repair.retrain === null
                            ? '; models trained on it will need training again (set points are kept)'
                            : repair.retrain > 0 ? `; ${plural(repair.retrain, 'model')} trained on it will need training again (set points are kept)` : ''}.
                    </div>
                )}

                {block ? (
                    <div className="fx-aggbox">
                        <span className="fx-an">{BLOCK_NAME[block.type]} of</span>
                        <SensorPickerMulti
                            sensors={sensors}
                            selected={block.sources}
                            noun="source sensors"
                            lockedReason={locked ? 'Locked' : undefined}
                            onConfirm={tags => setBlock(b => (b ? { ...b, sources: tags } : b))}
                            scope={<>All sensors except this one and the ones built on it · {sensors.length}</>}
                        />
                    </div>
                ) : (
                    <div
                        className={`fx-edwrap${locked ? ' ro' : ''}${focused ? ' focus' : ''}${shown && text ? ' bad' : ''}`}
                        onClick={() => taRef.current?.focus()}
                    >
                        <div className="fx-ed">
                            <div className="fx-mirror" ref={mirrorRef} aria-hidden="true" data-testid="formula-mirror">
                                {text ? mirror : <span className="fx-ph">{locked ? '' : placeholder}</span>}
                            </div>
                            <textarea
                                ref={taRef}
                                className="fx-ta"
                                aria-label="Formula"
                                aria-invalid={shown ? true : undefined}
                                aria-autocomplete="list"
                                spellCheck={false}
                                autoCorrect="off"
                                autoCapitalize="off"
                                readOnly={!!locked}
                                aria-readonly={locked ? true : undefined}
                                value={text}
                                rows={1}
                                onChange={onChange}
                                onKeyDown={onKeyDown}
                                onKeyUp={readSel}
                                onSelect={readSel}
                                onClick={() => { readSel(); setAc(null); }}
                                onFocus={() => setFocused(true)}
                                onBlur={() => { setFocused(false); setAc(null); }}
                                onMouseMove={onMouseMove}
                            />
                        </div>
                    </div>
                )}

                {!locked && !block && (
                    <div className="fx-tools" role="toolbar" aria-label="Insert">
                        <span className="fx-grp">
                            <button type="button" className="fx-k" disabled={sel[0] === sel[1]} onMouseDown={e => e.preventDefault()} onClick={wrap} title="Wrap the selected part in brackets — or press ( with a selection">( ) Wrap</button>
                            <button type="button" className="fx-k" disabled={!pair} onMouseDown={e => e.preventDefault()} onClick={unwrap} title="Remove the bracket pair the cursor is on">Unwrap</button>
                        </span>
                        <span className="fx-grp">
                            {QUICK_NUMBER_OPS.map(o => (
                                <button key={o} type="button" className="fx-k op" onMouseDown={e => e.preventDefault()} onClick={() => insertOp(o)} aria-label={`Insert ${OP_NAME[o]}`} title={OP_NAME[o]}>{OP_SYMBOL[o]}</button>
                            ))}
                        </span>
                        <span className="fx-grp">
                            {PALETTE_FNS.map(f => (
                                <button key={f} type="button" className="fx-k fn" onMouseDown={e => e.preventDefault()} onClick={() => insertFn(f)} aria-label={`Insert ${f}`} title={FN_HELP[f]}>{FN_LABEL[f] ?? f}</button>
                            ))}
                            <button
                                ref={fnTrigger}
                                type="button"
                                className="fx-k more"
                                aria-haspopup="menu"
                                aria-expanded={!!fnMenu}
                                onClick={e => setFnMenu(fnMenu ? null : rectOf(e.currentTarget))}
                            >
                                All functions <ChevronDown size={11} />
                            </button>
                        </span>
                    </div>
                )}
                {!locked && block && (
                    <div className="fx-hint pad" style={{ paddingTop: 8 }}>
                        An {BLOCK_NAME[block.type]} block stands alone — it skips missing values, which a formula cannot. To combine it with other maths, create it first, then use it as a source in a new sensor. Clear starts over.
                    </div>
                )}

                {!block && used.length > 0 && (
                    <div className="fx-used" data-testid="formula-sensors">
                        <span className="fx-cap">Sensors</span>
                        {used.map(r => (isKnown(r.name) ? (
                            <button
                                key={r.name}
                                type="button"
                                className="fx-chip"
                                title={`${sensorTitle(lookup(r.name))} — click to select it in the formula`}
                                onClick={() => selectRange([r.start, r.end])}
                            >
                                <SensorInline tag={r.name} size="sm" />
                            </button>
                        ) : (
                            <button
                                key={r.name}
                                type="button"
                                className="fx-chip unk"
                                title={`${r.name} is not in this dataset — click to replace it`}
                                disabled={!!locked}
                                onClick={e => openReplace(r.name, e.currentTarget)}
                            >
                                <AlertTriangle size={11} /> {r.name} · not in this dataset · Replace…
                            </button>
                        )))}
                    </div>
                )}

                <div className={`fx-check ${checkClass}`} role="status" data-testid="formula-check">
                    {locked ? (
                        <>
                            <Lock size={12} style={{ marginTop: 2, flexShrink: 0 }} />
                            <span data-testid="edit-lock-banner">Name and formula are locked. {locked.detail} Description, unit and component below can still change; to change the maths, create a new sensor.</span>
                        </>
                    ) : !state ? (
                        <span>Type the formula, or pick sensors on the left to start.</span>
                    ) : shown ? (
                        <>
                            <button
                                type="button"
                                className="fx-errjump"
                                title="Select the problem in the formula"
                                onClick={() => { if (shown.range) selectRange(shown.range); else taRef.current?.focus(); }}
                            >
                                ✕ {shown.message}
                            </button>
                            {fix?.kind === 'edit' && <button type="button" className="fx-fix" onClick={() => applyEdit(fix.edit)}>{fix.label}</button>}
                            {fix?.kind === 'replace-sensor' && (
                                <button type="button" className="fx-fix" onClick={e => openReplace(fix.sensor, e.currentTarget)}>{fix.label}</button>
                            )}
                        </>
                    ) : verdict.valid ? (
                        <span>
                            ✓ Valid · uses {plural(nSensors, 'sensor')}{rows ? ` · computed on ${rows.toLocaleString('en-US')} rows` : ''};{' '}
                            {block ? 'missing values are skipped; a row is missing only when every source is.' : 'rows where any input is missing stay missing.'}
                        </span>
                    ) : (
                        <span>
                            {preview.stale ? 'This window’s data was replaced — reopen it from the Dashboard to check the formula.'
                                : preview.error ? `Couldn't check the formula: ${preview.error}`
                                    : preview.loading ? 'Checking…' : 'The formula is checked again when it is saved.'}
                        </span>
                    )}
                    {note && !locked && <span className="fx-info" data-testid="formula-note">{NOTE_TEXT[note]}</span>}
                </div>

                <div className="fx-rrow">
                    <span>Round the result</span>
                    <span className="fx-seg" role="radiogroup" aria-label="Round the result">
                        {(() => {
                            // A stored value outside the usual choices (an older recipe rounded to,
                            // say, 4 places) is shown as one more, selected, choice -- never as no
                            // selection at all.
                            const current = block ? block.decimals : roundDecimals;
                            return current !== null && current !== undefined && !ROUND_CHOICES.includes(current)
                                ? [...ROUND_CHOICES, current] : ROUND_CHOICES;
                        })().map(v => {
                            const current = block ? block.decimals : roundDecimals;
                            const on = v === current;
                            return (
                                <button
                                    key={String(v)}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    className={on ? 'on' : ''}
                                    disabled={!!locked}
                                    onClick={() => (block ? setBlock({ ...block, decimals: v }) : setRoundDecimals(v))}
                                >
                                    {v === null ? 'Off' : v}
                                </button>
                            );
                        })}
                    </span>
                    <span className="fx-hint" data-testid="round-hint">
                        <RoundHint block={block} roundDecimals={roundDecimals} stored={rounded.formula} />
                    </span>
                </div>
                {!locked && !block && (
                    <div className="fx-hint pad kbd">
                        Type freely · <kbd>$</kbd> or a name suggests sensors, a letter suggests functions (<kbd>Ctrl</kbd>+<kbd>Space</kbd> anytime) · select a part and press <kbd>(</kbd> to wrap it · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes
                    </div>
                )}
            </div>

            <div className="fx-card">
                <div className="fx-ct">
                    Preview
                    <span className="fx-r">
                        {preview.isCurrent && preview.ok && preview.period
                            ? `Downsampled · ${preview.period[0].slice(0, 10)} → ${preview.period[1].slice(0, 10)}`
                            : 'Updates when the formula is valid'}
                    </span>
                </div>
                <div className="fx-prev">
                    <PreviewPlot
                        values={preview.ok && preview.values.length > 0 ? preview.values : null}
                        empty={locked ? 'Preview is off while the formula is locked.'
                            : repair ? 'No data yet — the preview draws as soon as the formula is valid.'
                                : 'The preview draws the result over the whole dataset once the formula is valid.'}
                    />
                    {preview.ok && preview.stats && (
                        <div className="fx-stats" data-testid="preview-stats">
                            <span>Min <b>{fmtNum(preview.stats.min)}</b> {unit}</span>
                            <span>Max <b>{fmtNum(preview.stats.max)}</b> {unit}</span>
                            <span>Mean <b>{fmtNum(preview.stats.mean)}</b> {unit}</span>
                            <span>Rows <b>{preview.stats.rows.toLocaleString('en-US')}</b></span>
                            {preview.stats.missing > 0 && (
                                <span className="w">⚠ <b>{preview.stats.missing.toLocaleString('en-US')}</b> rows have no result (missing input, ÷ 0 or invalid maths) — they stay missing</span>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {ac && acRect && acItems.length > 0 && !locked && (
                <AnchoredPopover anchorRect={{ ...acRect, bottom: acRect.bottom + 2 }} onRequestClose={() => setAc(null)} style={{ width: 400, padding: 4, maxHeight: 'none', overflow: 'visible' }}>
                    <div className="fx-ac" role="listbox" aria-label="Suggestions">
                        {acItems.map((it, i) => (
                            <div
                                key={it.kind === 'sensor' ? `s:${it.tag}` : `f:${it.name}`}
                                role="option"
                                aria-selected={i === acIndex}
                                className={`fx-acrow${i === acIndex ? ' on' : ''}`}
                                onMouseDown={e => { e.preventDefault(); pickAc(it); }}
                                onMouseEnter={() => setAc(a => (a ? { ...a, idx: i } : a))}
                            >
                                {it.kind === 'sensor' ? (
                                    <>
                                        <SensorInline tag={it.tag} size="sm" />
                                        {lookup(it.tag).unit && <span className="unit-badge" style={{ marginLeft: 'auto' }}>{lookup(it.tag).unit}</span>}
                                    </>
                                ) : (
                                    <>
                                        <span className="fx-mono fn">{it.name}(</span>
                                        <span className="fx-achelp">{FN_HELP[it.name] ?? ''}</span>
                                    </>
                                )}
                            </div>
                        ))}
                        <div className="fx-acfoot">↑↓ choose · Enter inserts · Esc closes</div>
                    </div>
                </AnchoredPopover>
            )}

            {fnMenu && (
                <AnchoredPopover anchorRect={fnMenu} onRequestClose={closeFnMenu} style={{ width: 380, padding: 4, maxHeight: 'none', overflow: 'visible' }}>
                    <div className="fx-menu fx-fnmenu" role="menu" aria-label="All functions" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeFnMenu(); } }}>
                        <div className="fx-mhead">Every function the engine evaluates · click to insert</div>
                        {functions && functions.length > 0 ? (
                            <div className="fx-fngrid">
                                {functions.map(f => (
                                    <button key={f} type="button" role="menuitem" className="fx-mitem" onClick={() => { closeFnMenu(); insertFn(f); }}>
                                        <span className="fx-mono">{f}{ZERO_ARG_FUNCTIONS.has(f) ? '()' : '( )'}</span>
                                        <small>{FN_HELP[f] ?? ''}</small>
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div className="fx-hint pad" style={{ paddingTop: 6 }}>The list comes from the engine with the first check — type a formula first.</div>
                        )}
                        <div className="fx-mfoot">log = log base 10 · ln = natural log · round(x) = whole number; for decimals round(x * 100) / 100 · 5k = 5000 · −A ^ 2 = (−A)²</div>
                    </div>
                </AnchoredPopover>
            )}

            {replace && (
                <AnchoredPopover
                    anchorRect={replace.rect}
                    onRequestClose={closeReplace}
                    reserveHeight={pickerMaxHeight()}
                    style={{ width: Math.min(420, Math.round(window.innerWidth * 0.92)), padding: 0, maxHeight: 'none', overflow: 'visible' }}
                >
                    <ReplacePanel
                        sensors={sensors}
                        old={replace.name}
                        onPick={tag => { closeReplace(); applyEdit(replaceSensorEverywhere(text, replace.name, tag)); }}
                        onClose={closeReplace}
                    />
                </AnchoredPopover>
            )}
        </>
    );
});
export default SpecialSensorFormulaEditor;

/** The stored form of the "Round the result" setting, shown where it is set (one place). */
function RoundHint({ block, roundDecimals, stored }: { block: BlockState | null; roundDecimals: number | null; stored: string }) {
    if (block) {
        return block.decimals === null
            ? <>Keeps the full value.</>
            : <>Rounds to {plural(block.decimals, 'decimal')}; stored with the {BLOCK_NAME[block.type]}’s own decimals.</>;
    }
    if (roundDecimals === null) return <>Keeps the full value.</>;
    const scale = 10 ** roundDecimals;
    const form = roundDecimals === 0 ? 'round(…)' : `round(… * ${scale}) / ${scale}`;
    return (
        <>
            Rounds to {plural(roundDecimals, 'decimal')} · stored as <span className="fx-mono" title={stored}>{form}</span>
        </>
    );
}

/** The painted mirror: the same text, split into token spans. A zero-width marker sits at the
 *  autocomplete anchor so the suggestion popover can be placed under it. */
function renderMirror(
    text: string,
    tokens: FormulaToken[],
    o: {
        errStart: number; errEnd: number; pair: [number, number] | null; isKnown: (n: string) => boolean;
        caret: number; lookup: ReturnType<typeof useSensorLookup>; locked: boolean;
    },
): ReactNode[] {
    const out: ReactNode[] = [];
    let marked = false;
    const mark = (k: string) => { if (!marked) { marked = true; out.push(<span key={`c${k}`} data-caret="" />); } };
    let pos = 0;
    const plain = (a: number, b: number, k: string) => {
        if (o.caret > a && o.caret < b) {
            out.push(<span key={`p${k}a`}>{text.slice(a, o.caret)}</span>);
            mark(k);
            out.push(<span key={`p${k}b`}>{text.slice(o.caret, b)}</span>);
        } else {
            if (o.caret === a) mark(k);
            out.push(<span key={`p${k}`}>{text.slice(a, b)}</span>);
        }
    };
    tokens.forEach((t, i) => {
        if (t.start > pos) plain(pos, t.start, `g${i}`);
        if (o.caret === t.start) mark(`t${i}`);
        const cls = ['fx-t', `fx-${t.kind}`];
        let tip: string | undefined;
        if (t.kind === 'sensor') {
            if (!o.isKnown(t.name ?? '')) cls.push('unk');
            tip = o.isKnown(t.name ?? '') ? sensorTitle(o.lookup(t.name ?? '')) : `${t.name} — not in this dataset`;
        } else if (t.kind === 'open' || t.kind === 'close') {
            if ((t.pair ?? -1) < 0) cls.push('fx-lone');
            else cls.push(`fx-d${Math.max(0, t.depth ?? 0) % 4}`);
            if (o.pair && (o.pair[0] === i || o.pair[1] === i)) cls.push('fx-mate');
        } else if (t.kind === 'word') {
            tip = FN_HELP[t.text];
        }
        if (!o.locked && o.errStart >= 0 && t.start >= o.errStart && t.end <= o.errEnd) cls.push('err');
        if (o.caret > t.start && o.caret < t.end) {
            out.push(<span key={`t${i}a`} className={cls.join(' ')} data-tip={tip}>{text.slice(t.start, o.caret)}</span>);
            mark(`t${i}`);
            out.push(<span key={`t${i}b`} className={cls.join(' ')} data-tip={tip}>{text.slice(o.caret, t.end)}</span>);
        } else {
            out.push(<span key={`t${i}`} className={cls.join(' ')} data-tip={tip} data-kind={t.kind}>{t.text}</span>);
        }
        pos = t.end;
    });
    if (text.length > pos) plain(pos, text.length, 'end');
    if (o.caret >= text.length) mark('end');
    out.push(<span key="tail">{'​'}</span>);
    return out;
}

function ReplacePanel({ sensors, old, onPick, onClose }: { sensors: string[]; old: string; onPick: (tag: string) => void; onClose: () => void }) {
    const [q, setQ] = useState('');
    const isOn = useCallback(() => false, []);
    return (
        <div className="pk-pop" role="dialog" aria-label={`Replace ${old}`}>
            <PickerList
                sensors={sensors}
                query={q}
                setQuery={setQ}
                isOn={isOn}
                onPick={t => { if (t) onPick(t); }}
                onEscape={onClose}
                scope={<>Replace <span className="fx-mono">{old}</span> everywhere in the formula with…</>}
            />
        </div>
    );
}

/** A bounded (≤ 600 points) downsampled line, drawn as one SVG path. Gaps (missing rows) break it. */
const PreviewPlot = memo(function PreviewPlot({ values, empty }: { values: (number | null)[] | null; empty: string }) {
    const plot = useMemo(() => {
        if (!values || values.length === 0) return null;
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of values) if (v !== null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!Number.isFinite(lo)) return null;
        const pad = (hi - lo || Math.abs(hi) || 1) * 0.1;
        const min = lo - pad;
        const max = hi + pad;
        const W = 1000;
        const H = 150;
        const n = values.length;
        let d = '';
        let pen = false;
        values.forEach((v, i) => {
            if (v === null || !Number.isFinite(v)) { pen = false; return; }
            const x = n === 1 ? W / 2 : (W * i) / (n - 1);
            const y = H * (1 - (v - min) / (max - min));
            d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
            pen = true;
        });
        return { d, ticks: [max, (max + min) / 2, min] };
    }, [values]);
    return (
        <div className="fx-plot">
            {plot ? (
                <>
                    <svg viewBox="0 0 1000 150" preserveAspectRatio="none" width="100%" height="100%" aria-label="Preview of the result" role="img">
                        {[0, 0.5, 1].map(f => (
                            <line key={f} x1="0" x2="1000" y1={150 * f} y2={150 * f} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                        ))}
                        <path d={plot.d} fill="none" stroke="var(--accent-hi)" strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
                    </svg>
                    <div style={{ position: 'absolute', inset: '4px auto 4px 6px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pointerEvents: 'none' }}>
                        {plot.ticks.map((t, i) => (
                            <span key={i} className="fx-mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{fmtNum(t)}</span>
                        ))}
                    </div>
                </>
            ) : (
                <div className="fx-empty">{empty}</div>
            )}
        </div>
    );
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Quick build — the selection-aware option sets of the old ButtonBuilder, the friendly way to
 * START a formula: what is offered depends only on how many sensors are picked on the left. It
 * never commits anything hidden: the generated text is shown, then written into the editor
 * (Use / Insert / Replace), where it is edited freely. Generators: `utils/quickBuild.ts`.
 * ───────────────────────────────────────────────────────────────────────────── */

const TRANSFORM_LABEL: Record<QuickTransform, string> = { abs: 'abs', sqrt: '√', log10: 'log₁₀', exp: 'exp', ceil: 'ceil', floor: 'floor', round: 'round' };
type OneChoice = null | { kind: 'number'; op: QuickNumberOp } | { kind: 'transform'; fn: QuickTransform };

export function QuickBuild({ selected, editorEmpty, blockMode, onClear, onUse, onInsert, onBlock }: {
    selected: string[];
    editorEmpty: boolean;
    /** The editor holds a block: a formula can only REPLACE it. */
    blockMode: boolean;
    onClear: () => void;
    onUse: (f: QuickFormula) => void;
    onInsert: (f: QuickFormula) => void;
    onBlock: (b: QuickBlock) => void;
}) {
    const n = selected.length;
    const [one, setOne] = useState<OneChoice>(null);
    const [value, setValue] = useState('');
    const [dec, setDec] = useState(2);
    const [signs, setSigns] = useState<QuickNumberOp[]>([]);
    const [combine, setCombine] = useState<QuickCombine>(null);
    const [inputTag, setInputTag] = useState<string | null>(null);
    const [wrap, setWrap] = useState<QuickTransform | null>(null);
    const [wrapDec, setWrapDec] = useState(2);
    const [signMenu, setSignMenu] = useState<{ i: number; rect: PopoverAnchorRect } | null>(null);
    const signTrigger = useRef<HTMLElement | null>(null);
    const closeSignMenu = useCallback(() => setSignMenu(null), []);
    usePopoverDismiss(!!signMenu, signTrigger as RefObject<HTMLElement | null>, 'fx-signmenu', closeSignMenu);

    // The option sets reset when the pick count changes bucket (0 / 1 / 2+).
    const bucket = n === 0 ? 0 : n === 1 ? 1 : 2;
    const lastBucket = useRef(bucket);
    useEffect(() => {
        if (lastBucket.current === bucket) return;
        lastBucket.current = bucket;
        setOne(null); setValue(''); setCombine(null); setInputTag(null); setWrap(null); setSignMenu(null); setSigns([]);
    }, [bucket]);
    useEffect(() => {
        if (inputTag && !selected.includes(inputTag)) setInputTag(null);
        if (n !== 2 && (combine === 'absdiff' || combine === 'efficiency')) setCombine(null);
    }, [selected, n, combine, inputTag]);

    const result = useMemo<QuickResult | null>(() => {
        if (n === 0) return null;
        if (n === 1) {
            return quickSingle(selected[0], one === null ? null
                : one.kind === 'number' ? { kind: 'number', op: one.op, value }
                    : { kind: 'transform', transform: { fn: one.fn, ...(one.fn === 'round' ? { decimals: dec } : {}) } });
        }
        return quickMulti(selected, {
            combine,
            signs,
            inputTag,
            wrap: wrap ? { fn: wrap, ...(wrap === 'round' ? { decimals: wrapDec } : {}) } : null,
            blockDecimals: null,
        });
    }, [n, selected, one, value, dec, combine, signs, inputTag, wrap, wrapDec]);

    if (n === 0 || !result) {
        return (
            <div className="fx-card" data-testid="quick-build">
                <div className="fx-ct">Quick build<span className="fx-r">0 picked</span></div>
                <div className="fx-qbidle">
                    Pick sensors on the left to get started — one sensor offers a number or a transform, two or more a chain and combinations. Or type straight into the formula below.
                </div>
            </div>
        );
    }

    const pill = (on: boolean, label: ReactNode, onClick: () => void, title: string, cls = '', key?: string) => (
        <button key={key ?? String(label)} type="button" className={`fx-k ${cls}${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick} title={title}>{label}</button>
    );
    const toggleCombine = (c: Exclude<QuickCombine, null>) => setCombine(combine === c ? null : c);
    const decimalsInput = (v: number, set: (d: number) => void) => (
        <label className="fx-qbdec">
            decimals
            <input
                className="fx-qbin sm"
                type="number"
                min={0}
                max={15}
                aria-label="Decimals"
                value={v}
                onChange={e => set(Math.max(0, Math.min(15, Math.trunc(Number(e.target.value) || 0))))}
            />
        </label>
    );

    return (
        <div className="fx-card" data-testid="quick-build">
            <div className="fx-ct">
                Quick build
                <span className="fx-qbsel">{n === 1 ? <SensorInline tag={selected[0]} size="sm" /> : `${n} sensors picked`}</span>
                <span className="fx-r"><button type="button" className="fx-link" onClick={onClear}>Clear picks</button></span>
            </div>
            {n === 1 ? (
                <div className="fx-qbbody">
                    <div className="fx-qbrow" role="group" aria-label="Combine with a number">
                        <span className="fx-cap">Combine with a number</span>
                        {QUICK_NUMBER_OPS.map(op => pill(
                            one?.kind === 'number' && one.op === op, OP_SYMBOL[op],
                            () => setOne(one?.kind === 'number' && one.op === op ? null : { kind: 'number', op }),
                            OP_NAME[op], 'op', `n${op}`,
                        ))}
                        {one?.kind === 'number' && (
                            <input className="fx-qbin" aria-label="Value" placeholder="value" autoFocus value={value} onChange={e => setValue(e.target.value)} />
                        )}
                    </div>
                    <div className="fx-qbrow" role="group" aria-label="Transform">
                        <span className="fx-cap">Transform</span>
                        {QUICK_TRANSFORMS.map(f => pill(
                            one?.kind === 'transform' && one.fn === f, TRANSFORM_LABEL[f],
                            () => setOne(one?.kind === 'transform' && one.fn === f ? null : { kind: 'transform', fn: f }),
                            FN_HELP[f] ?? f, 'fn', `t${f}`,
                        ))}
                        {one?.kind === 'transform' && one.fn === 'round' && decimalsInput(dec, setDec)}
                    </div>
                </div>
            ) : (
                <div className="fx-qbbody">
                    <div className="fx-qbrow chain" role="group" aria-label="Chain">
                        <span className="fx-cap">Chain</span>
                        <span className={`fx-chain${combine ? ' off' : ''}`}>
                            {selected.map((t, i) => (
                                <span key={t} className="fx-chainitem">
                                    {i > 0 && (
                                        <button
                                            type="button"
                                            className="fx-sign"
                                            disabled={!!combine}
                                            title={combine ? 'Signs are off while a combination is chosen' : 'Change the sign'}
                                            aria-label={`Sign before ${t}`}
                                            onClick={e => { signTrigger.current = e.currentTarget; setSignMenu({ i: i - 1, rect: rectOf(e.currentTarget) }); }}
                                        >
                                            {OP_SYMBOL[signs[i - 1] ?? '+']}
                                        </button>
                                    )}
                                    <SensorInline tag={t} size="sm" />
                                </span>
                            ))}
                        </span>
                        {!combine && <span className="fx-hint">+ by default — click a sign to change it</span>}
                    </div>
                    <div className="fx-qbrow" role="group" aria-label="Combine all">
                        <span className="fx-cap">Combine all</span>
                        {pill(combine === 'sum', 'Sum', () => toggleCombine('sum'), 'A + B + C — a row is missing if any source is missing')}
                        {pill(combine === 'mean', 'Average', () => toggleCombine('mean'), 'Average block — missing values are skipped')}
                        {pill(combine === 'median', 'Median', () => toggleCombine('median'), 'Median block — missing values are skipped')}
                        {pill(combine === 'spread', 'Spread', () => toggleCombine('spread'), 'max(…) − min(…)')}
                        {n === 2 && pill(combine === 'absdiff', '|A − B|', () => toggleCombine('absdiff'), 'abs(A − B)')}
                    </div>
                    {n === 2 && (
                        <div className="fx-qbrow" role="group" aria-label="Compare one against the rest">
                            <span className="fx-cap">Compare one against the rest</span>
                            {pill(combine === 'efficiency', 'Efficiency %', () => toggleCombine('efficiency'), '(output ÷ input) × 100')}
                            {combine === 'efficiency' && selected.map(t => (
                                <label key={t} className="fx-qbradio">
                                    <input type="radio" name="fx-qb-input" checked={inputTag === t} onChange={() => setInputTag(t)} aria-label={`Input = ${t}`} />
                                    input = <SensorInline tag={t} size="sm" />
                                </label>
                            ))}
                        </div>
                    )}
                    {result.kind === 'formula' && (
                        <div className="fx-qbrow" role="group" aria-label="Then wrap">
                            <span className="fx-cap">Then wrap</span>
                            {QUICK_TRANSFORMS.map(f => pill(wrap === f, TRANSFORM_LABEL[f], () => setWrap(wrap === f ? null : f), FN_HELP[f] ?? f, 'fn', `w${f}`))}
                            {wrap === 'round' && decimalsInput(wrapDec, setWrapDec)}
                        </div>
                    )}
                </div>
            )}
            <div className="fx-qbout">
                <span className="fx-cap">{result.kind === 'block' ? 'Block' : 'Formula'}</span>
                <code className={`fx-qbformula${result.ready ? '' : ' dim'}`} data-testid="quick-build-output">
                    {result.kind === 'block' ? result.label : result.formula}
                </code>
                <span className="fx-qbact">
                    {result.kind === 'block' ? (
                        <button type="button" className="fx-btn pri" disabled={!result.ready} onClick={() => onBlock(result)}>
                            {editorEmpty ? 'Use this block' : 'Replace with this block'}
                        </button>
                    ) : editorEmpty ? (
                        <button type="button" className="fx-btn pri" disabled={!result.ready} onClick={() => onUse(result)}>Use this formula</button>
                    ) : (
                        <>
                            {!blockMode && (
                                <button type="button" className="fx-btn" disabled={!result.ready} onClick={() => onInsert(result)}>Insert at cursor</button>
                            )}
                            <button type="button" className="fx-btn pri" disabled={!result.ready} onClick={() => onUse(result)}>Replace formula</button>
                        </>
                    )}
                </span>
                {result.hint && <span className={`fx-hint full${result.ready ? '' : ' warn'}`}>{result.hint}</span>}
            </div>
            {signMenu && (
                <AnchoredPopover anchorRect={signMenu.rect} onRequestClose={closeSignMenu} style={{ width: 160, padding: 4, maxHeight: 'none', overflow: 'visible' }}>
                    <div className="fx-menu fx-signmenu" role="menu" aria-label="Sign" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeSignMenu(); } }}>
                        {QUICK_NUMBER_OPS.map(op => (
                            <button
                                key={op}
                                type="button"
                                role="menuitem"
                                className="fx-mitem"
                                onClick={() => {
                                    const at = signMenu.i;
                                    setSigns(s => { const next = s.slice(); next[at] = op; return next; });
                                    closeSignMenu();
                                }}
                            >
                                <span className="fx-mono">{OP_SYMBOL[op]}</span><small>{OP_NAME[op]}</small>
                            </button>
                        ))}
                    </div>
                </AnchoredPopover>
            )}
        </div>
    );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The sensor's own fields: Name / Description / Unit / Component.
 * ───────────────────────────────────────────────────────────────────────────── */

export function SensorFieldsCard({
    title, name, setName, nameLocked, nameLockReason, nameError, description, setDescription, unit, setUnit,
    component, setComponent, components,
}: {
    title: string;
    name: string; setName: (v: string) => void;
    nameLocked: boolean;
    nameLockReason?: string;
    nameError: string | null;
    description: string; setDescription: (v: string) => void;
    unit: string; setUnit: (v: string) => void;
    component: string; setComponent: (v: string) => void;
    components: string[];
}) {
    return (
        <div className="fx-card" data-testid="sensor-fields">
            <div className="fx-ct">{title}</div>
            <div className="fx-fields">
                <div className="fx-f">
                    <label htmlFor="fx-name">Name <i>*</i>{nameLocked && <Lock size={9} style={{ marginLeft: 5, verticalAlign: -1 }} />}</label>
                    <input
                        id="fx-name"
                        aria-label="Name"
                        className={`fx-in mono${nameError ? ' bad' : ''}`}
                        readOnly={nameLocked}
                        aria-readonly={nameLocked || undefined}
                        aria-invalid={nameError ? true : undefined}
                        title={nameLocked ? nameLockReason : nameError ?? undefined}
                        value={name}
                        onChange={e => { if (!nameLocked) setName(e.target.value); }}
                        placeholder="e.g. TEMP_RISE"
                    />
                </div>
                <div className="fx-f">
                    <label htmlFor="fx-desc">Description <i>*</i></label>
                    <input id="fx-desc" aria-label="Description" className="fx-in" value={description} onChange={e => setDescription(e.target.value)} placeholder={name.trim() || 'e.g. Bearing temperature rise'} />
                </div>
                <div className="fx-f">
                    <label htmlFor="fx-unit">Unit <i>*</i></label>
                    <input id="fx-unit" aria-label="Unit" className="fx-in mono" value={unit} onChange={e => setUnit(e.target.value)} placeholder="e.g. DEGC" />
                </div>
                <div className="fx-f">
                    <label htmlFor="fx-comp">Component <i>*</i></label>
                    <ComponentSelect id="fx-comp" value={component} onChange={setComponent} options={components} className="fx-in" />
                </div>
            </div>
            {nameError && <div className="fx-namerr" role="alert">{nameError}</div>}
        </div>
    );
}

/**
 * A select limited to components that already exist on some sensor — deliberately NOT free
 * typing: a typo would silently fork a new component ("Pump" vs "pump"), so the Sensor tab's
 * grouping fills with near-duplicates. "Uncategorized" is always offered.
 */
export function ComponentSelect({ value, onChange, options, className, id }: {
    value: string; onChange: (value: string) => void; options: string[]; className?: string; id?: string;
}) {
    const all = useMemo(
        () => Array.from(new Set([...options, 'Uncategorized', ...(value ? [value] : [])])).sort(),
        [options, value],
    );
    return (
        <select id={id} aria-label="Component" value={value} onChange={e => onChange(e.target.value)} className={className}>
            <option value="" disabled>Select a component…</option>
            {all.map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
    );
}
