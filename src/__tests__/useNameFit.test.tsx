import { act, render } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCutRuns, useLineCut, useNameFit, useTwoLine, useWideTail } from '../hooks/useNameFit';
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
    watchNameFit,
    wholeWordWidth,
} from '../utils/nameFitGate';

/** jsdom has no layout: each test says what an element measures. */
type Geometry = { clientWidth?: number; scrollWidth?: number; clientHeight?: number; scrollHeight?: number };
let geometry: (el: Element) => Geometry;
let rafQueue: Map<number, FrameRequestCallback>;
let observers: { cb: ResizeObserverCallback; targets: Set<Element>; disconnected: boolean }[];

function flushFrames(times = 5) {
    for (let i = 0; i < times; i++) {
        act(() => {
            const q = [...rafQueue.values()];
            rafQueue.clear();
            q.forEach(cb => cb(0));
        });
    }
}
function fireResize() {
    act(() => { observers.filter(o => !o.disconnected).forEach(o => o.cb([], {} as ResizeObserver)); });
    flushFrames();
}

beforeEach(() => {
    geometry = () => ({});
    rafQueue = new Map();
    observers = [];
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.set(++id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (n: number) => { rafQueue.delete(n); });
    vi.stubGlobal('ResizeObserver', class {
        rec: (typeof observers)[number];
        constructor(cb: ResizeObserverCallback) { this.rec = { cb, targets: new Set(), disconnected: false }; observers.push(this.rec); }
        observe(t: Element) { this.rec.targets.add(t); }
        unobserve(t: Element) { this.rec.targets.delete(t); }
        disconnect() { this.rec.disconnected = true; this.rec.targets.clear(); }
    });
    for (const key of ['clientWidth', 'scrollWidth', 'clientHeight', 'scrollHeight'] as const) {
        vi.spyOn(Element.prototype, key, 'get').mockImplementation(function (this: Element) { return geometry(this)[key] ?? 0; });
    }
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('decideTwoLine', () => {
    const m = (room: string, o: Partial<{ fullFitsRow: boolean; overflows: boolean; fitsBack: boolean }> = {}) =>
        ({ room, fullFitsRow: false, overflows: false, fitsBack: false, ...o });
    it('stays on one line when it fits or the row has room for the whole name', () => {
        expect(decideTwoLine(TWO_LINE_INITIAL, m('a')).two).toBe(false);
        expect(decideTwoLine(TWO_LINE_INITIAL, m('a', { overflows: true, fullFitsRow: true })).two).toBe(false);
    });
    it('holds two lines at the same room even when it would fit back', () => {
        const s = decideTwoLine(TWO_LINE_INITIAL, m('a', { overflows: true }));
        expect(s.two).toBe(true);
        expect(decideTwoLine(s, m('a', { fitsBack: true, fullFitsRow: true })).two).toBe(true);
    });
    it('a room moved by its own change is pinned too (shrink-to-fit parent)', () => {
        let s = decideTwoLine(TWO_LINE_INITIAL, m('a', { overflows: true }));
        s = decideTwoLine(s, m('b', { fitsBack: true }));
        expect(s.two).toBe(true);
        s = decideTwoLine(s, m('b', { fitsBack: true }));
        expect(s.two).toBe(true);
        s = decideTwoLine(s, m('a', { fitsBack: true }));
        expect(s.two).toBe(true);
    });
    it('goes back when the room really changes and the name fits', () => {
        let s = decideTwoLine(TWO_LINE_INITIAL, m('a', { overflows: true }));
        s = decideTwoLine(s, m('a'));
        expect(decideTwoLine(s, m('c', { fitsBack: true })).two).toBe(false);
        expect(decideTwoLine(s, m('c', { fullFitsRow: true })).two).toBe(false);
        expect(decideTwoLine(s, m('c')).two).toBe(true);
    });
});

describe('decideLineCut / decideWideTail', () => {
    it('line cut: holds until the room changes and the text fits', () => {
        const room = 'r';
        let s = decideLineCut(LINE_CUT_INITIAL, { room, clientWidth: 100, scrollWidth: 100 });
        expect(s.cut).toBe(false);
        s = decideLineCut(s, { room, clientWidth: 100, scrollWidth: 150 });
        expect(s.cut).toBe(true);
        s = decideLineCut(s, { room, clientWidth: 200, scrollWidth: 200 });
        expect(s.cut).toBe(true);
        expect(decideLineCut(s, { room: 'wider', clientWidth: 149, scrollWidth: 149 }).cut).toBe(true);
        expect(decideLineCut(s, { room: 'wider', clientWidth: 150, scrollWidth: 150 }).cut).toBe(false);
    });
    it('wide tail: grows freely, shrinks only when the room changed', () => {
        let s = decideWideTail(WIDE_TAIL_INITIAL, { room: 'a', best: 2 });
        expect(s.k).toBe(2);
        s = decideWideTail(s, { room: 'b', best: 1 });
        expect(s.k).toBe(2);
        s = decideWideTail(s, { room: 'a', best: 1 });
        expect(s.k).toBe(2);
        expect(decideWideTail(s, { room: 'c', best: 1 }).k).toBe(1);
    });
    it('wide tail: a room moved by its own change is pinned too (shrink-to-fit parent)', () => {
        let s = decideWideTail(WIDE_TAIL_INITIAL, { room: 'a', best: 2 });
        // More words narrow the parent: the words no longer "fit", at a room we caused.
        s = decideWideTail(s, { room: 'b', best: 0 });
        expect(s.k).toBe(2);
        s = decideWideTail(s, { room: 'b', best: 0 });
        expect(s.k).toBe(2);
        s = decideWideTail(s, { room: 'a', best: 0 });
        expect(s.k).toBe(2);
        // A room we did not cause does take it back.
        expect(decideWideTail(s, { room: 'c', best: 0 }).k).toBe(0);
    });
});

describe('decideCutRun', () => {
    it('holds below the room it needs, goes back at it', () => {
        let s = decideCutRun(cutRunState(300, 60), 300)!;
        expect(s.need).toBe(362);
        s = decideCutRun(s, 361)!;
        expect(s).not.toBeNull();
        expect(decideCutRun(s, 362)).toBeNull();
    });
    it('the room the cut itself produced is pinned, however wide', () => {
        let s = decideCutRun(cutRunState(300, 6), 308)!;
        expect(s).not.toBeNull();
        s = decideCutRun(s, 308)!;
        expect(s).not.toBeNull();
        expect(decideCutRun(s, 309)).toBeNull();
    });
    it('a room not rendered says nothing and leaves the pin for the real measurement', () => {
        const start = cutRunState(300, 6);
        expect(decideCutRun(start, 0)).toBe(start);
        expect(decideCutRun(start, 308)).not.toBeNull();
    });
});

describe('useTwoLine', () => {
    const COMPACT = 'compact';
    const FULL = 'the whole name';
    const widths: Record<string, number> = { [COMPACT]: 300, [FULL]: 600 };
    const measure = (t: string) => widths[t] ?? 0;
    let renders = 0;
    function Row({ compact = COMPACT, full = FULL, enabled = true, wrap = false }) {
        renders++;
        const [ref, two] = useTwoLine(compact, full, enabled, wrap, { measure, rowOf: el => el.parentElement });
        return <div data-testid="parent"><span ref={ref} data-testid="el" data-two={two ? '1' : '0'} /></div>;
    }
    const isTwo = (c: HTMLElement) => c.querySelector('[data-testid="el"]')!.getAttribute('data-two') === '1';
    const kind = (el: Element) => el.getAttribute('data-testid');
    beforeEach(() => { renders = 0; });

    it('does nothing for a name that fits', () => {
        geometry = el => (kind(el) === 'el' ? { clientWidth: 400 } : { clientWidth: 500 });
        const { container } = render(<Row />);
        flushFrames();
        expect(isTwo(container)).toBe(false);
        expect(renders).toBe(1);
    });

    it('does nothing for an element that is not rendered (width 0)', () => {
        const { container } = render(<Row />);
        flushFrames();
        expect(isTwo(container)).toBe(false);
        expect(renders).toBe(1);
    });

    it('trap (a): a row that fits back once stacked must not flip-flop (React #185)', () => {
        // One line: too narrow. Two lines: its box widens, so "would fit back" is true. Same room.
        geometry = el => {
            if (kind(el) === 'el') return { clientWidth: el.getAttribute('data-two') === '1' ? 320 : 200 };
            return { clientWidth: 500 };
        };
        const { container } = render(<Row />);
        expect(isTwo(container)).toBe(true);
        const settled = renders;
        flushFrames();
        fireResize();
        expect(isTwo(container)).toBe(true);
        expect(renders).toBe(settled);
        expect(renders).toBeLessThanOrEqual(3);
    });

    it('trap (a) in a shrink-to-fit parent: the flip moves the room and still settles', () => {
        geometry = el => {
            const two = el.querySelector('[data-two="1"]') !== null || el.getAttribute('data-two') === '1';
            if (kind(el) === 'el') return { clientWidth: two ? 320 : 200 };
            return { clientWidth: two ? 460 : 500 };
        };
        const { container } = render(<StrictMode><Row /></StrictMode>);
        expect(isTwo(container)).toBe(true);
        const settled = renders;
        flushFrames();
        fireResize();
        expect(isTwo(container)).toBe(true);
        expect(renders).toBe(settled);
    });

    it('trap (b): a row with room for the whole name must not stack, even when its own box is narrow', () => {
        // A shrink-to-fit label measures its own narrow box; the row has the room.
        geometry = el => (kind(el) === 'el' ? { clientWidth: 100 } : { clientWidth: 800 });
        const { container } = render(<Row />);
        flushFrames();
        expect(isTwo(container)).toBe(false);
    });

    it('trap (b): a stacked row goes back once the row has room', () => {
        let parent = 500;
        geometry = el => (kind(el) === 'el' ? { clientWidth: 100 } : { clientWidth: parent });
        const { container } = render(<Row />);
        expect(isTwo(container)).toBe(true);
        parent = 900;
        fireResize();
        expect(isTwo(container)).toBe(false);
        parent = 500;
        fireResize();
        expect(isTwo(container)).toBe(true);
    });

    it('starts over when the text changes', () => {
        geometry = el => (kind(el) === 'el' ? { clientWidth: 200 } : { clientWidth: 500 });
        const { container, rerender } = render(<Row />);
        expect(isTwo(container)).toBe(true);
        widths.short = 50;
        widths.shortFull = 60;
        rerender(<Row compact="short" full="shortFull" />);
        flushFrames();
        expect(isTwo(container)).toBe(false);
    });

    it('wrap mode: two lines only while the whole name needs more than two', () => {
        geometry = el => (kind(el) === 'el' ? { clientWidth: 200, clientHeight: 30, scrollHeight: 60 } : { clientWidth: 500 });
        const { container } = render(<Row wrap />);
        expect(isTwo(container)).toBe(true);
        geometry = el => (kind(el) === 'el' ? { clientWidth: 200, clientHeight: 60, scrollHeight: 60 } : { clientWidth: 500 });
        const second = render(<Row wrap />);
        expect(isTwo(second.container)).toBe(false);
    });

    it('disabled: never measures, never stacks, no observer', () => {
        geometry = el => (kind(el) === 'el' ? { clientWidth: 100 } : { clientWidth: 500 });
        const { container } = render(<Row enabled={false} />);
        flushFrames();
        expect(isTwo(container)).toBe(false);
        expect(observers).toHaveLength(0);
    });

    it('stops observing on unmount', () => {
        geometry = el => (kind(el) === 'el' ? { clientWidth: 400 } : { clientWidth: 500 });
        const { unmount } = render(<Row />);
        expect(observers.some(o => !o.disconnected)).toBe(true);
        unmount();
        expect(observers.every(o => o.disconnected)).toBe(true);
        expect(rafQueue.size).toBe(0);
    });

    it('an inline ref that re-attaches on each render keeps one observer', () => {
        geometry = el => (kind(el) === 'el' ? { clientWidth: 400 } : { clientWidth: 500 });
        function Inline({ n }: { n: number }) {
            const [ref] = useTwoLine(COMPACT, FULL, true, false, { measure, rowOf: el => el.parentElement });
            return <div data-testid="parent" data-n={n}><span ref={el => { ref(el); }} data-testid="el" /></div>;
        }
        const { rerender } = render(<Inline n={1} />);
        rerender(<Inline n={2} />);
        rerender(<Inline n={3} />);
        expect(observers).toHaveLength(1);
    });
});

describe('useCutRuns', () => {
    function List({ names = 'k', onCut, enabled = true }: { names?: string; onCut: (s: ReadonlySet<string>) => void; enabled?: boolean }) {
        const root = useRef<HTMLDivElement>(null);
        const cut = useCutRuns(() => root.current, names, enabled);
        onCut(cut);
        return (
            <div ref={root} data-testid="root">
                <span data-name-run="set1" data-name-full="full" data-testid="row" style={{ whiteSpace: 'nowrap' }} />
            </div>
        );
    }
    it('is empty while every name fits', () => {
        geometry = el => (el.getAttribute('data-testid') === 'row' ? { clientWidth: 200, scrollWidth: 200 } : { clientWidth: 300 });
        let cut: ReadonlySet<string> = new Set();
        render(<List onCut={c => { cut = c; }} />);
        flushFrames();
        expect(cut.size).toBe(0);
    });
    it('marks a set with a cut row, holds at the same width, goes back only with enough extra room', () => {
        let rootW = 300;
        let rowScroll = 260;
        geometry = el => (el.getAttribute('data-testid') === 'row' ? { clientWidth: 200, scrollWidth: rowScroll } : { clientWidth: rootW });
        let cut: ReadonlySet<string> = new Set();
        render(<List onCut={c => { cut = c; }} />);
        expect([...cut]).toEqual(['set1']);
        // Shortened now, so the row fits: that must not bring the long form back at the same width.
        rowScroll = 200;
        fireResize();
        expect([...cut]).toEqual(['set1']);
        rootW = 361; // needs 300 + 60 + 2
        fireResize();
        expect([...cut]).toEqual(['set1']);
        rootW = 362;
        fireResize();
        expect(cut.size).toBe(0);
    });
    it('starts over when the names change', () => {
        let rowScroll = 260;
        geometry = el => (el.getAttribute('data-testid') === 'row' ? { clientWidth: 200, scrollWidth: rowScroll } : { clientWidth: 300 });
        let cut: ReadonlySet<string> = new Set();
        const onCut = (c: ReadonlySet<string>) => { cut = c; };
        const { rerender } = render(<List onCut={onCut} />);
        expect(cut.size).toBe(1);
        rowScroll = 200;
        rerender(<List names="other" onCut={onCut} />);
        expect(cut.size).toBe(0);
    });
    it('disabled: always empty', () => {
        geometry = el => (el.getAttribute('data-testid') === 'row' ? { clientWidth: 200, scrollWidth: 260 } : { clientWidth: 300 });
        let cut: ReadonlySet<string> = new Set();
        render(<List enabled={false} onCut={c => { cut = c; }} />);
        flushFrames();
        expect(cut.size).toBe(0);
    });

    describe('a root that changes with the cut', () => {
        let renders = 0;
        function Tracked({ roomOf }: { roomOf?: (root: HTMLElement) => HTMLElement | null | undefined }) {
            renders++;
            const root = useRef<HTMLDivElement>(null);
            const cut = useCutRuns(() => root.current, 'k', true, { roomOf });
            return (
                <div data-testid="room">
                    <div ref={root} data-testid="root" data-cut={cut.size ? '1' : '0'}>
                        <span data-name-run="set1" data-name-full="full" data-testid="row" style={{ whiteSpace: 'nowrap' }} />
                    </div>
                </div>
            );
        }
        const id = (el: Element) => el.getAttribute('data-testid');
        const isCut = (c: HTMLElement) => c.querySelector('[data-testid="root"]')!.getAttribute('data-cut') === '1';
        const cutNow = (el: Element) => el.closest('[data-cut="1"]') !== null || el.querySelector('[data-cut="1"]') !== null;
        const toRoom = (root: HTMLElement) => root.parentElement;
        beforeEach(() => { renders = 0; });

        it('shrink-to-fit root: goes back when the room grows, though the root itself never does', () => {
            let room = 400;
            geometry = el => {
                if (id(el) === 'room') return { clientWidth: room };
                if (id(el) === 'root') return { clientWidth: cutNow(el) ? 240 : Math.min(460, room) };
                if (cutNow(el)) return { clientWidth: 180, scrollWidth: 180 };
                // Uncut, the row takes what the room gives, up to the 260 px the whole name needs.
                const own = Math.min(260, room - 200);
                return { clientWidth: own, scrollWidth: 260 };
            };
            const { container } = render(<Tracked roomOf={toRoom} />);
            expect(isCut(container)).toBe(true);
            room = 461; // needs 400 + 60 + 2
            fireResize();
            expect(isCut(container)).toBe(true);
            room = 462;
            fireResize();
            expect(isCut(container)).toBe(false);
            flushFrames();
            expect(isCut(container)).toBe(false);
        });

        it('shrink-to-fit root without a room getter stays cut: why the getter exists', () => {
            let room = 400;
            geometry = el => {
                if (id(el) === 'room') return { clientWidth: room };
                if (id(el) === 'root') return { clientWidth: cutNow(el) ? 240 : 400 };
                return cutNow(el) ? { clientWidth: 180, scrollWidth: 180 } : { clientWidth: 200, scrollWidth: 260 };
            };
            const { container } = render(<Tracked />);
            expect(isCut(container)).toBe(true);
            room = 900;
            fireResize();
            expect(isCut(container)).toBe(true);
        });

        it('watches the room as well as the root, and only those', () => {
            geometry = () => ({ clientWidth: 300 });
            const { getByTestId } = render(<Tracked roomOf={toRoom} />);
            const live = observers.filter(o => !o.disconnected);
            expect(live).toHaveLength(1);
            expect([...live[0].targets]).toEqual([getByTestId('root'), getByTestId('room')]);
        });

        it('a room getter that finds nothing falls back to the root', () => {
            let rootW = 300;
            geometry = el => {
                if (id(el) === 'root') return { clientWidth: rootW };
                return id(el) === 'row' && !cutNow(el) ? { clientWidth: 200, scrollWidth: 260 } : { clientWidth: 200, scrollWidth: 200 };
            };
            const { container } = render(<Tracked roomOf={() => null} />);
            expect(isCut(container)).toBe(true);
            rootW = 362;
            geometry = el => {
                if (id(el) === 'root') return { clientWidth: rootW };
                return { clientWidth: 260, scrollWidth: 260 };
            };
            fireResize();
            expect(isCut(container)).toBe(false);
        });

        it('cutting removes the scrollbar, which widens the root past "wide enough": settles instead of looping', () => {
            // Whole names need a scrollbar (root 300), short ones do not (root 308). Without the pin: 308 >= 300 + 6 + 2,
            // back to whole, the scrollbar returns, cut again, forever (React #185).
            let extra = 0;
            geometry = el => {
                if (id(el) === 'root') return { clientWidth: (cutNow(el) ? 308 : 300) + extra };
                if (cutNow(el)) return { clientWidth: 200, scrollWidth: 200 };
                return { clientWidth: 200 + extra, scrollWidth: 206 };
            };
            const { container } = render(<StrictMode><Tracked /></StrictMode>);
            expect(isCut(container)).toBe(true);
            const settled = renders;
            flushFrames();
            fireResize();
            expect(isCut(container)).toBe(true);
            expect(renders).toBe(settled);
            // The window really widens: whole names fit even with the scrollbar back.
            extra = 12;
            fireResize();
            expect(isCut(container)).toBe(false);
            flushFrames();
            expect(isCut(container)).toBe(false);
        });
    });
});

describe('useLineCut', () => {
    function Line({ text = 'text' }) {
        const [ref, cut] = useLineCut(text);
        return <div data-testid="parent"><span ref={ref} data-testid="el" data-cut={cut ? '1' : '0'} /></div>;
    }
    const isCut = (c: HTMLElement) => c.querySelector('[data-testid="el"]')!.getAttribute('data-cut') === '1';
    it('stays plain while the text fits', () => {
        geometry = el => (el.getAttribute('data-testid') === 'el' ? { clientWidth: 200, scrollWidth: 200 } : { clientWidth: 300 });
        const { container } = render(<Line />);
        flushFrames();
        expect(isCut(container)).toBe(false);
    });
    it('holds the rich form at the same room, even if it measures as fitting', () => {
        geometry = el => {
            if (el.getAttribute('data-testid') !== 'el') return { clientWidth: 300 };
            return el.getAttribute('data-cut') === '1' ? { clientWidth: 400, scrollWidth: 400 } : { clientWidth: 200, scrollWidth: 350 };
        };
        const { container } = render(<Line />);
        expect(isCut(container)).toBe(true);
        flushFrames();
        expect(isCut(container)).toBe(true);
    });
    it('goes back when the room has grown and starts over on new text', () => {
        let parent = 300;
        let own = { clientWidth: 200, scrollWidth: 350 };
        geometry = el => (el.getAttribute('data-testid') === 'el' ? own : { clientWidth: parent });
        const { container, rerender } = render(<Line />);
        expect(isCut(container)).toBe(true);
        parent = 600;
        own = { clientWidth: 500, scrollWidth: 500 };
        fireResize();
        expect(isCut(container)).toBe(false);
        own = { clientWidth: 200, scrollWidth: 350 };
        fireResize();
        expect(isCut(container)).toBe(true);
        own = { clientWidth: 200, scrollWidth: 100 };
        rerender(<Line text="short" />);
        expect(isCut(container)).toBe(false);
    });
});

describe('useWideTail', () => {
    const FORMS = ['… a', '… bb a', '… ccc bb a'];
    const measure = (t: string) => t.length * 10;
    function Label({ forms = FORMS, enabled = true }: { forms?: string[]; enabled?: boolean }) {
        const [ref, k] = useWideTail(forms, enabled, measure);
        return (
            <div data-testid="parent">
                <span ref={ref} data-testid="el" data-k={k}><span data-testid="head" /></span>
            </div>
        );
    }
    const kOf = (c: HTMLElement) => Number(c.querySelector('[data-testid="el"]')!.getAttribute('data-k'));
    it('stays at 0 for a label that is not cut', () => {
        geometry = el => (el.getAttribute('data-testid') === 'el' ? { clientWidth: 500 } : { clientWidth: 100, scrollWidth: 100 });
        const { container } = render(<Label />);
        flushFrames();
        expect(kOf(container)).toBe(0);
    });
    it('takes as many extra words as fit', () => {
        geometry = el => {
            const id = el.getAttribute('data-testid');
            if (id === 'el') return { clientWidth: 70 };
            return id === 'head' ? { clientWidth: 10, scrollWidth: 90 } : { clientWidth: 300 };
        };
        const { container } = render(<Label />);
        expect(kOf(container)).toBe(1);
    });
    it('does not oscillate when more words shrink its own box', () => {
        geometry = el => {
            const id = el.getAttribute('data-testid');
            if (id === 'el') return { clientWidth: Number(el.getAttribute('data-k')) === 0 ? 120 : 40 };
            return id === 'head' ? { clientWidth: 10, scrollWidth: 90 } : { clientWidth: 300 };
        };
        const { container } = render(<Label />);
        expect(kOf(container)).toBe(2);
        flushFrames();
        expect(kOf(container)).toBe(2);
    });
    it('in a shrink-to-fit parent: more words move the room too, and it still settles', () => {
        let renders = 0;
        function Counted() {
            renders++;
            return <Label />;
        }
        geometry = el => {
            const id = el.getAttribute('data-testid');
            const k = Number((id === 'el' ? el : el.querySelector('[data-testid="el"]') ?? el.closest('[data-testid="el"]'))?.getAttribute('data-k') ?? 0);
            if (id === 'el') return { clientWidth: k === 0 ? 120 : 40 };
            if (id === 'head') return { clientWidth: 10, scrollWidth: 90 };
            return { clientWidth: k === 0 ? 300 : 260 };
        };
        const { container } = render(<StrictMode><Counted /></StrictMode>);
        expect(kOf(container)).toBe(2);
        const settled = renders;
        flushFrames();
        fireResize();
        expect(kOf(container)).toBe(2);
        expect(renders).toBe(settled);
    });
    it('disabled: always 0', () => {
        geometry = () => ({ clientWidth: 500, scrollWidth: 900 });
        const { container } = render(<Label enabled={false} />);
        expect(kOf(container)).toBe(0);
    });
});

describe('applyNameFit / watchNameFit / useNameFit', () => {
    function makeSplit(headText: string) {
        const split = document.createElement('span');
        const head = document.createElement('span');
        head.dataset.namePart = 'head';
        head.style.fontSize = '10px';
        head.textContent = headText;
        const tail = document.createElement('span');
        tail.dataset.namePart = 'tail';
        split.append(head, tail);
        document.body.append(split);
        return { split, head };
    }
    afterEach(() => { document.body.replaceChildren(); });
    const measure = (t: string) => t.length * 5;

    it('leaves a head that fits alone', () => {
        const { split, head } = makeSplit('Vibration crosshead');
        geometry = () => ({ clientWidth: 200, scrollWidth: 200 });
        applyNameFit(split, measure);
        expect(split.hasAttribute('data-short')).toBe(false);
        expect(head.style.maxWidth).toBe('');
    });
    it('ends a cut head at its last whole word', () => {
        const { split, head } = makeSplit('Vibration crosshead slide');
        geometry = el => (el === head ? { clientWidth: 110, scrollWidth: 125 } : {});
        applyNameFit(split, measure);
        // "Vibration crosshead" = 95 px × 1.01 + "…" 5 px.
        expect(head.style.maxWidth).toBe(`${Math.ceil(19 * 5 * 1.01 + 5 + 1)}px`);
    });
    it('drops a head showing under 8 characters, and brings it back with room', () => {
        const { split, head } = makeSplit('Vibration crosshead slide');
        geometry = el => (el === head ? { clientWidth: 30, scrollWidth: 125 } : {});
        applyNameFit(split, measure);
        expect(split.hasAttribute('data-short')).toBe(true);
        geometry = () => ({ clientWidth: 200, scrollWidth: 125 });
        applyNameFit(split, measure);
        expect(split.hasAttribute('data-short')).toBe(false);
    });
    it('a head that passes the check and is then squeezed by the row is dropped too: the rendered width decides', () => {
        const { split, head } = makeSplit('Vibration crosshead slide');
        geometry = el => (el === head ? { clientWidth: head.style.maxWidth ? 25 : 110, scrollWidth: 125 } : {});
        applyNameFit(split, measure);
        expect(split.hasAttribute('data-short')).toBe(true);
    });
    it('a kept start cut under 8 characters goes as well, and comes back with room', () => {
        const { split, head } = makeSplit('crosshead slide');
        const pre = document.createElement('span');
        pre.dataset.namePart = 'pre';
        pre.style.fontSize = '10px';
        pre.textContent = 'Crosshead ';
        split.prepend(pre);
        geometry = el => (el === pre ? { clientWidth: 15, scrollWidth: 50 } : el === head ? { clientWidth: 0, scrollWidth: 75 } : {});
        applyNameFit(split, measure);
        expect(split.hasAttribute('data-short')).toBe(true);
        expect(split.hasAttribute('data-short-pre')).toBe(true);
        geometry = () => ({ clientWidth: 200, scrollWidth: 100 });
        applyNameFit(split, measure);
        expect(split.hasAttribute('data-short')).toBe(false);
        expect(split.hasAttribute('data-short-pre')).toBe(false);
    });
    it('a kept start that is whole stays when only the head is dropped', () => {
        const { split, head } = makeSplit('crosshead slide');
        const pre = document.createElement('span');
        pre.dataset.namePart = 'pre';
        pre.style.fontSize = '10px';
        pre.textContent = 'Crosshead ';
        split.prepend(pre);
        geometry = el => (el === pre ? { clientWidth: 50, scrollWidth: 50 } : el === head ? { clientWidth: 20, scrollWidth: 75 } : {});
        applyNameFit(split, measure);
        expect(split.hasAttribute('data-short')).toBe(true);
        expect(split.hasAttribute('data-short-pre')).toBe(false);
    });
    it('watches the head as well as the row, and stops watching both', () => {
        const row = document.createElement('div');
        const { split, head } = makeSplit('Vibration crosshead slide');
        row.append(split);
        document.body.append(row);
        geometry = () => ({ clientWidth: 200, scrollWidth: 100 });
        const stop = watchNameFit(split);
        const watching = () => observers.filter(o => !o.disconnected).flatMap(o => [...o.targets]);
        expect(watching()).toEqual(expect.arrayContaining([row, head]));
        stop();
        expect(watching()).not.toContain(head);
        expect(watching()).not.toContain(row);
    });
    describe('chips', () => {
        function inChip(chipClass: string, withRef = false) {
            const { split } = makeSplit('Vibration crosshead slide');
            const tail = split.querySelector<HTMLElement>('[data-name-part="tail"]')!;
            tail.style.fontSize = '10px';
            const wrap = document.createElement('span');
            const chip = document.createElement('span');
            if (withRef) chip.setAttribute('data-name-ref', '');
            else chip.className = chipClass;
            wrap.append(split);
            chip.append(wrap);
            document.body.append(chip);
            geometry = el => (el === tail ? { clientWidth: 60, scrollWidth: 60 } : {});
            return { split, wrap, chip };
        }
        // tail 60 + 0.9 × 10 px font.
        const MIN = '69px';

        it.each(['pk-chip', 'fx-chip', 'fx-chip unk'])('%s never shrinks below start + "…" + end', cls => {
            const { split, wrap, chip } = inChip(cls);
            applyNameFit(split, measure);
            expect(split.style.minWidth).toBe(MIN);
            expect(wrap.style.minWidth).toBe(MIN);
            expect(chip.style.minWidth).toBe('min(100%, 71px)');
        });
        it('a split outside any chip holds nothing', () => {
            const { split, wrap, chip } = inChip('other');
            applyNameFit(split, measure);
            expect(split.style.minWidth).toBe('');
            expect(wrap.style.minWidth).toBe('');
            expect(chip.style.minWidth).toBe('');
        });
        it('the wrappers do not keep the cut form\'s minimum once the name has gone back to plain', () => {
            const { split, wrap } = inChip('fx-chip');
            const stop = watchNameFit(split);
            applyNameFit(split, measure);
            expect(wrap.style.minWidth).toBe(MIN);
            stop();
            expect(wrap.style.minWidth).toBe('');
        });
        it('the chip itself gives its minimum back too', () => {
            const { split, chip } = inChip('pk-chip');
            const stop = watchNameFit(split);
            applyNameFit(split, measure);
            expect(chip.style.minWidth).not.toBe('');
            stop();
            expect(chip.style.minWidth).toBe('');
        });
        it('a second split that wrote over a shared wrapper keeps its minimum when the first one stops', () => {
            const { split, wrap } = inChip('pk-chip');
            const stop = watchNameFit(split);
            applyNameFit(split, measure);
            wrap.style.minWidth = '99px';
            stop();
            expect(wrap.style.minWidth).toBe('99px');
        });
        it('a summary reference gives its minimum back', () => {
            const { split, chip: ref } = inChip('', true);
            const summary = document.createElement('span');
            summary.setAttribute('data-name-summary', '');
            summary.append(ref);
            document.body.append(summary);
            const stop = watchNameFit(split);
            applyNameFit(split, measure);
            expect(split.style.minWidth).toBe(MIN);
            stop();
            expect(ref.style.minWidth).toBe('');
        });
        it('useNameFit: a name going back to plain clears the chip wrappers before paint', () => {
            function Name({ cut }: { cut: boolean }) {
                const ref = useNameFit('text', cut);
                return (
                    <span className="fx-chip">
                        <span data-testid="wrap">
                            {cut
                                ? <span key="split" ref={ref}><span data-name-part="head" style={{ fontSize: '10px' }}>head</span><span data-name-part="tail" data-testid="tail" style={{ fontSize: '10px' }} /></span>
                                : <span key="plain" ref={ref}>the whole name</span>}
                        </span>
                    </span>
                );
            }
            geometry = el => (el.getAttribute('data-testid') === 'tail' ? { clientWidth: 60, scrollWidth: 60 } : {});
            const { getByTestId, rerender } = render(<Name cut />);
            expect(getByTestId('wrap').style.minWidth).toBe(MIN);
            rerender(<Name cut={false} />);
            expect(getByTestId('wrap').style.minWidth).toBe('');
        });
    });
    it('wholeWordWidth: -1 when not even the first word fits', () => {
        expect(wholeWordWidth('Supercalifragilistic word', 20, 'f', measure)).toBe(-1);
    });
    it('watchNameFit cancels its work on cleanup and accepts null', () => {
        const { split } = makeSplit('Vibration crosshead');
        const stop = watchNameFit(split);
        expect(rafQueue.size).toBe(1);
        stop();
        expect(rafQueue.size).toBe(0);
        expect(() => watchNameFit(null)()).not.toThrow();
    });
    it('useNameFit re-applies when the text changes and stops on unmount', () => {
        function Name({ text }: { text: string }) {
            const ref = useNameFit(text);
            return (
                <span ref={ref} data-testid="split">
                    <span data-name-part="head" style={{ fontSize: '10px' }}>{text}</span>
                    <span data-name-part="tail" />
                </span>
            );
        }
        geometry = el => (el.getAttribute('data-name-part') === 'head' ? { clientWidth: 30, scrollWidth: 125 } : {});
        const { getByTestId, rerender, unmount } = render(<Name text="Vibration crosshead" />);
        expect(getByTestId('split').hasAttribute('data-short')).toBe(true);
        geometry = el => (el.getAttribute('data-name-part') === 'head' ? { clientWidth: 200, scrollWidth: 125 } : {});
        rerender(<Name text="Another name" />);
        expect(getByTestId('split').hasAttribute('data-short')).toBe(false);
        unmount();
        expect(rafQueue.size).toBe(0);
    });
});
