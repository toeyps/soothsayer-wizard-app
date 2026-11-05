/** Measured gates for long sensor names: fit is measured in the rendered font with hysteresis; decisions live in `utils/nameFitGate.ts`. */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
    LINE_CUT_INITIAL,
    TWO_LINE_INITIAL,
    WIDE_TAIL_INITIAL,
    applyNameFit,
    cutRunState,
    decideCutRun,
    decideLineCut,
    decideTwoLine,
    decideWideTail,
    nameDeficit,
    roomKey,
    watchNameFit,
    type CutRunState,
} from '../utils/nameFitGate';
import { fontOf, textWidth, type MeasureText } from '../utils/textMeasure';

type ElementRef = (el: HTMLElement | null) => void;

/** Runs `check` one frame after every commit and on resize; `check` must set state only when something changed. */
function useResizeCheck(getTargets: () => Element[], check: () => void, enabled: boolean) {
    const latest = useRef(check);
    const watch = useRef<{ targets: Element[]; ro: ResizeObserver; raf: number } | null>(null);
    const stop = useCallback(() => {
        if (!watch.current) return;
        watch.current.ro.disconnect();
        cancelAnimationFrame(watch.current.raf);
        watch.current = null;
    }, []);
    useLayoutEffect(() => {
        latest.current = check;
        if (!enabled) { stop(); return; }
        const targets = getTargets();
        const old = watch.current?.targets;
        if (!old || old.length !== targets.length || old.some((t, i) => t !== targets[i])) {
            stop();
            if (typeof ResizeObserver !== 'undefined' && targets.length) {
                const w: { targets: Element[]; ro: ResizeObserver; raf: number } = {
                    targets,
                    raf: 0,
                    ro: new ResizeObserver(() => {
                        cancelAnimationFrame(w.raf);
                        w.raf = requestAnimationFrame(() => latest.current());
                    }),
                };
                targets.forEach(t => w.ro.observe(t));
                watch.current = w;
            }
        }
        check();
        const r = requestAnimationFrame(() => latest.current());
        return () => cancelAnimationFrame(r);
    });
    useLayoutEffect(() => stop, [stop]);
}

const NONE: ReadonlySet<string> = new Set();

export interface CutRunsOptions {
    measure?: MeasureText;
    /** The element whose width decides 'wide enough to go back'; default the root. Required when the root shrinks with the cut: return the nearest ancestor that does not. */
    roomOf?: (root: HTMLElement) => HTMLElement | null | undefined;
}

/** Rule 2 gate: set ids (`data-name-run`) with at least one name that does not fit. A shortened set is judged by its room's width. A new `key` starts over. */
export function useCutRuns(
    getRoot: () => HTMLElement | null,
    key: string,
    enabled: boolean,
    options: CutRunsOptions = {},
): ReadonlySet<string> {
    const { measure = textWidth, roomOf } = options;
    const [state, setState] = useState<{ key: string; cut: ReadonlySet<string> }>({ key, cut: NONE });
    const cut = state.key === key ? state.cut : NONE;
    const memo = useRef({ key, runs: new Map<string, CutRunState>() });
    useResizeCheck(() => {
        const r = getRoot();
        if (!r) return [];
        const room = roomOf?.(r);
        return room && room !== r ? [r, room] : [r];
    }, () => {
        const root = getRoot();
        if (!root) return;
        if (memo.current.key !== key) memo.current = { key, runs: new Map() };
        const runs = memo.current.runs;
        const w = (roomOf?.(root) ?? root).clientWidth;
        const next = new Set(cut);
        let changed = false;
        for (const id of cut) {
            const run = runs.get(id);
            if (!run) continue;
            const s = decideCutRun(run, w);
            if (s) runs.set(id, s);
            else { next.delete(id); runs.delete(id); changed = true; }
        }
        const worst = new Map<string, number>();
        root.querySelectorAll<HTMLElement>('[data-name-run]').forEach(el => {
            const id = el.dataset.nameRun!;
            if (cut.has(id)) return;
            const d = nameDeficit(el, measure);
            if (d > 0.5) worst.set(id, Math.max(worst.get(id) ?? 0, d));
        });
        for (const [id, d] of worst) { next.add(id); runs.set(id, cutRunState(w, d)); changed = true; }
        if (changed) setState({ key, cut: next });
    }, enabled);
    return enabled ? cut : NONE;
}

/** One plain-text line with a richer cut form; `cut` is true only while the plain text is really cut. Ref goes on the line's element. */
export function useLineCut(text: string): [ElementRef, boolean] {
    const [state, setState] = useState({ key: text, cut: false });
    const cut = state.key === text && state.cut;
    const elRef = useRef<HTMLElement | null>(null);
    const gate = useRef({ key: text, s: LINE_CUT_INITIAL });
    const ref = useCallback<ElementRef>(el => { elRef.current = el; }, []);
    useResizeCheck(() => targetsOf(elRef.current), () => {
        const el = elRef.current;
        if (!el || !el.isConnected || !el.clientWidth) return;
        if (gate.current.key !== text) gate.current = { key: text, s: LINE_CUT_INITIAL };
        const s = decideLineCut(gate.current.s, {
            room: roomKey(el.parentElement?.clientWidth ?? 0, 0),
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
        });
        gate.current.s = s;
        if (s.cut !== cut) setState({ key: text, cut: s.cut });
    }, true);
    return [ref, cut];
}

function targetsOf(el: Element | null, row?: Element | null): Element[] {
    if (!el) return [];
    const out: Element[] = [el];
    if (el.parentElement) out.push(el.parentElement);
    if (row && !out.includes(row)) out.push(row);
    return out;
}

export interface TwoLineOptions {
    measure?: MeasureText;
    /** The row whose width decides "has room for the whole name". Default: the parent of the stacked label. */
    rowOf?: (el: HTMLElement) => HTMLElement | null | undefined;
    /** What else shares the row (unit chip, badge). Default 72 px. */
    reservePx?: number;
}

const defaultRowOf = (el: HTMLElement) => el.closest('.sl')?.parentElement;

/** Rule 3 two-line form. `wrap` false: true while kept start + end (`compact`) do not fit on one line. `wrap` true: true while `full` needs more than two lines. */
export function useTwoLine(compact: string, full: string, enabled: boolean, wrap: boolean, options: TwoLineOptions = {}): [ElementRef, boolean] {
    const { measure = textWidth, rowOf = defaultRowOf, reservePx = 72 } = options;
    const key = `${wrap ? 'w' : 's'}\0${compact}\0${full}`;
    const [state, setState] = useState({ key, two: false });
    const two = state.key === key && state.two;
    const elRef = useRef<HTMLElement | null>(null);
    const gate = useRef({ key, s: TWO_LINE_INITIAL });
    const ref = useCallback<ElementRef>(el => { elRef.current = el; }, []);
    useResizeCheck(() => targetsOf(elRef.current, elRef.current ? rowOf(elRef.current) : null), () => {
        const el = elRef.current;
        if (!el || !el.isConnected || !el.clientWidth) return;
        if (gate.current.key !== key) gate.current = { key, s: TWO_LINE_INITIAL };
        const font = fontOf(el);
        const fullW = measure(full, font);
        const compactW = measure(compact, font);
        const rowW = rowOf(el)?.clientWidth ?? 0;
        const parts = () => [...el.querySelectorAll<HTMLElement>(':scope > [data-name-part="pre"], :scope > [data-name-part="tail"]')];
        const s = decideTwoLine(gate.current.s, {
            room: roomKey(el.parentElement?.clientWidth ?? 0, rowW),
            fullFitsRow: !wrap && fullW + reservePx <= rowW,
            overflows: wrap
                ? el.scrollHeight > el.clientHeight + 1 && fullW > el.clientWidth
                : compactW > el.clientWidth + 2 || parts().some(c => c.scrollWidth > c.clientWidth + 0.5),
            fitsBack: wrap ? fullW < el.clientWidth * 1.85 : compactW <= el.clientWidth - 2,
        });
        gate.current.s = s;
        if (s.two !== two) setState({ key, two: s.two });
    }, enabled);
    return [ref, enabled && two];
}

/** Rule 3 'tail grows back': how many extra words of `forms` fit for a label that is cut anyway; 0 if not cut. */
export function useWideTail(forms: readonly string[], enabled: boolean, measure: MeasureText = textWidth): [ElementRef, number] {
    const key = forms.join('\0');
    const [state, setState] = useState({ key, k: 0 });
    const k = state.key === key ? state.k : 0;
    const elRef = useRef<HTMLElement | null>(null);
    const gate = useRef({ key, s: WIDE_TAIL_INITIAL });
    const ref = useCallback<ElementRef>(el => { elRef.current = el; }, []);
    useResizeCheck(() => targetsOf(elRef.current), () => {
        const el = elRef.current;
        if (!el || !el.isConnected || !el.clientWidth) return;
        if (gate.current.key !== key) gate.current = { key, s: WIDE_TAIL_INITIAL };
        const isCut = k > 0 || el.hasAttribute('data-short')
            || [...el.children].some(c => (c as HTMLElement).scrollWidth > (c as HTMLElement).clientWidth + 0.5);
        if (!isCut) return;
        const font = fontOf(el);
        const room = el.clientWidth - 2;
        let best = 0;
        for (let i = 1; i < forms.length; i++) if (measure(forms[i], font) <= room) best = i;
        const s = decideWideTail(gate.current.s, { room: roomKey(el.parentElement?.clientWidth ?? 0, 0), best });
        gate.current.s = s;
        if (s.k !== k) setState({ key, k: s.k });
    }, enabled);
    return [ref, enabled ? k : 0];
}

/** Keeps a split name's head adjusted before paint and on resize. Ref goes on the element holding the `data-name-part` children. */
export function useNameFit(text: string, enabled = true): ElementRef {
    const elRef = useRef<HTMLElement | null>(null);
    const current = useRef<{ el: HTMLElement | null; text: string; stop?: () => void }>({ el: null, text: '' });
    const ref = useCallback<ElementRef>(el => { elRef.current = el; }, []);
    useLayoutEffect(() => {
        const el = enabled ? elRef.current : null;
        if (el === current.current.el && text === current.current.text) return;
        current.current.stop?.();
        if (el) applyNameFit(el);
        current.current = { el, text, stop: el ? watchNameFit(el) : undefined };
    });
    useLayoutEffect(() => () => {
        current.current.stop?.();
        current.current = { el: null, text: '' };
    }, []);
    return ref;
}
