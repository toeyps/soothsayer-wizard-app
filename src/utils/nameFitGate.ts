/**
 * The measured gates behind long sensor names (DESIGN_SYSTEM §4): pure state machines, plus the DOM helpers
 * that read and adjust a rendered name. The React side is `hooks/useNameFit.ts`.
 *
 * THE RULE THAT PREVENTS THE CRASH: a form picked by measuring can change the very sizes it was measured with,
 * so "needs the short form" and "would fit back" can both be true (React error 185 in the mock). A gate therefore
 * only goes back when its ROOM or TEXT changed. It remembers the room it decided in AND the room its own change
 * produced (`settling`), because in a shrink-to-fit parent the change itself moves the room.
 *
 * Markup contract (data attributes, so this file does not depend on CSS class names):
 *  - `data-name-run` / `data-name-full`: on a name label of a set: the set id and its unshortened text.
 *  - `data-name-part="pre" | "head" | "tail"`: direct children of a split name.
 *  - `data-name-part="line1"` + `data-name-form="two-line"`: the two-line form (`pre`/`head` inside `line1`).
 *  - `data-short`: set here on a split whose visible head is under ~8 characters; the CSS then hides the head.
 *  - `data-short-pre`: the same for a kept start (`pre`) that is cut under ~8 characters.
 *  - `data-name-summary` / `data-name-ref`: a recipe summary and one sensor reference in it (never shrinks below
 *    "…" + its tail).
 */
import { fontOf, textWidth, type MeasureText } from './textMeasure';

/** Rooms a decision stands for; `settling`: the next measurement's room is the result of our own change. */
interface RoomPin {
    rooms: readonly string[];
    settling: boolean;
}

function settled<T extends RoomPin>(s: T, room: string): T {
    if (!s.settling) return s;
    return { ...s, rooms: s.rooms.includes(room) ? s.rooms : [...s.rooms, room], settling: false };
}

/** Two sizes as one room key (the element's parent and its row). */
export const roomKey = (parentPx: number, rowPx: number): string => `${parentPx}|${rowPx}`;

// ---- two lines ----

export interface TwoLineState extends RoomPin {
    two: boolean;
}
export const TWO_LINE_INITIAL: TwoLineState = { two: false, rooms: [], settling: false };

export interface TwoLineMeasurement {
    room: string;
    /** The row has room for the whole name on one line. */
    fullFitsRow: boolean;
    /** The one-line form does not fit. */
    overflows: boolean;
    /** The one-line form would fit again. */
    fitsBack: boolean;
}

/** A row with room for the whole name never stacks; a row on two lines stays there until its room changes. */
export function decideTwoLine(prev: TwoLineState, m: TwoLineMeasurement): TwoLineState {
    const s = settled(prev, m.room);
    if (!s.two) {
        if (m.fullFitsRow || !m.overflows) return s;
        return { two: true, rooms: [m.room], settling: true };
    }
    if (s.rooms.includes(m.room)) return s;
    if (m.fullFitsRow || m.fitsBack) return { two: false, rooms: [], settling: false };
    return { ...s, rooms: [m.room] };
}

// ---- a plain line with a richer cut form ----

export interface LineCutState extends RoomPin {
    cut: boolean;
    /** The width the plain text needs. */
    need: number;
}
export const LINE_CUT_INITIAL: LineCutState = { cut: false, need: 0, rooms: [], settling: false };

export function decideLineCut(prev: LineCutState, m: { room: string; clientWidth: number; scrollWidth: number }): LineCutState {
    const s = settled(prev, m.room);
    if (!s.cut) {
        if (m.scrollWidth <= m.clientWidth + 0.5) return s;
        return { cut: true, need: m.scrollWidth, rooms: [m.room], settling: true };
    }
    if (s.rooms.includes(m.room)) return s;
    if (m.clientWidth >= s.need) return { ...LINE_CUT_INITIAL };
    return { ...s, rooms: [m.room] };
}

// ---- the tail grows back ----

export interface WideTailState extends RoomPin {
    k: number;
}
export const WIDE_TAIL_INITIAL: WideTailState = { k: 0, rooms: [], settling: false };

/** `best`: how many extra words fit now. The tail grows freely; it shrinks only when the room changed. */
export function decideWideTail(prev: WideTailState, m: { room: string; best: number }): WideTailState {
    const s = settled(prev, m.room);
    if (m.best === s.k) return s.rooms.includes(m.room) ? s : { ...s, rooms: [m.room] };
    if (m.best > s.k) return { k: m.best, rooms: s.rooms.includes(m.room) ? s.rooms : [...s.rooms, m.room], settling: true };
    if (s.rooms.includes(m.room)) return s;
    return { k: m.best, rooms: [], settling: true };
}

// ---- cut sets ----

export interface CutRunState extends RoomPin {
    /** The room at which the whole name fits again. */
    need: number;
}

/** A set was just shortened in `room`, with `deficit` px missing from its worst name. */
export function cutRunState(room: number, deficit: number): CutRunState {
    return { need: room + deficit + 2, rooms: [String(room)], settling: true };
}

/** The set after a measurement of its room; null: it goes back to the whole names. A room not rendered (0) says
 *  nothing. The room the cut itself produced (a scrollbar gone, say) never brings it back. */
export function decideCutRun(prev: CutRunState, room: number): CutRunState | null {
    if (!room) return prev;
    const key = String(room);
    const s = settled(prev, key);
    return s.rooms.includes(key) || room < s.need ? s : null;
}

/** How many px a name label's full text is wider than its room (≤ 0: it fits). 0 when it is not rendered. */
export function nameDeficit(el: HTMLElement, measure: MeasureText = textWidth): number {
    const w = el.clientWidth;
    if (!w) return 0;
    const cs = getComputedStyle(el);
    if (cs.whiteSpace === 'normal') {
        const lines = el.getBoundingClientRect().height / (parseFloat(cs.fontSize) * 1.25);
        if (lines < 1.6) return 0;
        return Math.max(2, measure(el.dataset.nameFull ?? el.textContent ?? '', fontOf(el)) - w);
    }
    let d = el.scrollWidth - w;
    el.querySelectorAll<HTMLElement>(':scope > [data-name-part="head"], :scope > [data-name-part="tail"]').forEach(c => {
        d += Math.max(0, c.scrollWidth - c.clientWidth);
    });
    if (el.hasAttribute('data-short')) d = Math.max(d, 8);
    return d;
}

// ---- whole-word heads, short heads, chips ----

const MIN_HEAD_CH = 8;

/** The px width at which `text` + "…" ends at its last whole word within `room`; -1 when not even the first
 *  word fits (only then a mid-word cut is allowed). */
export function wholeWordWidth(text: string, room: number, font: string, measure: MeasureText = textWidth): number {
    const ell = measure('…', font);
    let best = -1;
    for (const m of text.matchAll(/\S(?=\s|$)/g)) {
        const end = (m.index ?? 0) + 1;
        const w = measure(text.slice(0, end), font) * 1.01 + ell;
        if (w > room) break;
        best = w;
    }
    return best;
}

function wholeWordCut(el: HTMLElement, measure: MeasureText) {
    el.style.maxWidth = '';
    if (el.children.length || !(el.scrollWidth > el.clientWidth + 0.5)) return;
    const best = wholeWordWidth(el.textContent ?? '', el.clientWidth, fontOf(el), measure);
    if (best > 0) el.style.maxWidth = `${Math.ceil(best + 1)}px`;
}

const isCut = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 0.5;
/** Cut, and what is left of it is under ~8 characters. Read from the rendered width. */
const underMinHead = (el: HTMLElement) => isCut(el) && el.clientWidth < parseFloat(getComputedStyle(el).fontSize) * 0.55 * MIN_HEAD_CH;

const part = (split: HTMLElement, name: string) => split.querySelector<HTMLElement>(`:scope > [data-name-part="${name}"]`);

/** The minimums a split has set outside itself. The chip and its wrappers outlive the split (a name back to plain
 *  text is a new element), and a minimum worked out for the cut form can be wider than the plain name. */
const heldBySplit = new WeakMap<HTMLElement, Map<HTMLElement, string>>();

function hold(split: HTMLElement, el: HTMLElement, minWidth: string) {
    el.style.minWidth = minWidth;
    let held = heldBySplit.get(split);
    if (!held) {
        held = new Map();
        heldBySplit.set(split, held);
    }
    held.set(el, el.style.minWidth);
}

/** Takes back what `hold` set, unless another split in the same chip has written over it since. */
function releaseHolds(split: HTMLElement) {
    heldBySplit.get(split)?.forEach((minWidth, el) => {
        if (el.style.minWidth === minWidth) el.style.minWidth = '';
    });
    heldBySplit.delete(split);
}

function holdChipOpen(split: HTMLElement, chip: HTMLElement, tail: HTMLElement) {
    // A chip never shrinks below start + "…" + end: the chip row wraps instead.
    const min = Math.ceil((part(split, 'pre')?.scrollWidth ?? 0) + tail.scrollWidth + parseFloat(getComputedStyle(tail).fontSize) * 0.9);
    split.style.minWidth = `${min}px`;
    const others = [...chip.children].reduce((w, c) => (c.contains(split) ? w : w + (c as HTMLElement).offsetWidth), 0);
    const cs = getComputedStyle(chip);
    const chrome = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
        + (parseFloat(cs.columnGap) || 0) * (chip.children.length - 1) + 2;
    hold(split, chip, `min(100%, ${min + others + chrome}px)`);
    for (let a = split.parentElement; a && a !== chip; a = a.parentElement) hold(split, a, `${min}px`);
}

function holdSummaryRef(split: HTMLElement, tail: HTMLElement) {
    const min = `${Math.ceil(tail.scrollWidth + parseFloat(getComputedStyle(tail).fontSize) * 0.9)}px`;
    split.style.minWidth = min;
    const ref = split.closest<HTMLElement>('[data-name-ref]');
    if (!ref) return;
    const extra = [...ref.children].filter(c => c !== split).reduce((w, c) => w + (c as HTMLElement).scrollWidth, 0);
    hold(split, ref, `calc(${min} + ${extra}px)`);
}

/** Adjusts one rendered split name to its current room: a cut head ends at a whole word, a head under ~8
 *  characters is dropped (`data-short`), a chip or summary reference keeps its minimum. */
export function applyNameFit(split: HTMLElement, measure: MeasureText = textWidth): void {
    if (!split.isConnected) return;
    if (split.dataset.nameForm === 'two-line') {
        const line1 = part(split, 'line1');
        line1?.querySelectorAll<HTMLElement>(':scope > [data-name-part="pre"], :scope > [data-name-part="head"]').forEach(el => wholeWordCut(el, measure));
        return;
    }
    const head = part(split, 'head');
    if (!head) return;
    split.removeAttribute('data-short');
    split.removeAttribute('data-short-pre');
    head.style.maxWidth = '';
    const tail = part(split, 'tail');
    const chip = split.closest<HTMLElement>('.pk-chip, .fx-chip');
    if (tail && chip) holdChipOpen(split, chip, tail);
    if (tail && split.closest('[data-name-summary]')) holdSummaryRef(split, tail);
    const pre = part(split, 'pre');
    if (pre) wholeWordCut(pre, measure);
    if (underMinHead(head)) split.setAttribute('data-short', '');
    else if (isCut(head)) wholeWordCut(head, measure);
    // What the flex row left after the cuts above is what shows: a head cut to a whole word can still be squeezed.
    if (!split.hasAttribute('data-short') && underMinHead(head)) split.setAttribute('data-short', '');
    if (pre && underMinHead(pre)) split.setAttribute('data-short-pre', '');
}

let sharedObserver: ResizeObserver | null = null;
const splitsByTarget = new Map<Element, Set<HTMLElement>>();

/** Keeps `applyNameFit` current on a split as its row resizes. One shared observer serves every row of a long
 *  list. Returns the cleanup (usable as a React 19 ref cleanup), which also takes back the split's minimums. */
export function watchNameFit(split: HTMLElement | null): () => void {
    if (!split) return () => {};
    const raf = requestAnimationFrame(() => applyNameFit(split));
    const stopFrame = () => { cancelAnimationFrame(raf); releaseHolds(split); };
    if (typeof ResizeObserver === 'undefined') return stopFrame;
    const target = split.closest('.sl, .sl-inline-wrap, .tt-row')?.parentElement ?? split.parentElement;
    if (!target) return stopFrame;
    if (!sharedObserver) {
        sharedObserver = new ResizeObserver(entries => requestAnimationFrame(() => {
            for (const e of entries) splitsByTarget.get(e.target)?.forEach(s => applyNameFit(s));
        }));
    }
    // The row, and the head itself: the flex row can squeeze a head with the row's own size unchanged (the tail
    // growing back, a sibling chip). `applyNameFit` measures from the reset state, so its own change cannot loop.
    const head = part(split, 'head');
    const targets = head ? [target, head] : [target];
    for (const t of targets) {
        let set = splitsByTarget.get(t);
        if (!set) {
            set = new Set();
            splitsByTarget.set(t, set);
            sharedObserver.observe(t);
        }
        set.add(split);
    }
    return () => {
        stopFrame();
        for (const t of targets) {
            const s = splitsByTarget.get(t);
            if (!s) continue;
            s.delete(split);
            if (!s.size) {
                splitsByTarget.delete(t);
                sharedObserver?.unobserve(t);
            }
        }
    };
}
