import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useWindowedLines } from '../hooks/useWindowedLines';
import { captureResizeObservers, setLineHeight, type ResizeObservers } from './helpers/windowedLines';

const ROW = 50;
const keyOf = (n: number) => `L${n}`;
const estimate = () => ROW;
const LINES = Array.from({ length: 1000 }, (_, i) => i);

function List({ lines = LINES, windowed = true, anchorList = lines }: { lines?: number[]; windowed?: boolean; anchorList?: unknown }) {
    const listRef = useRef<HTMLDivElement>(null);
    const { offsets, windowStart, windowEnd, readView, lineRef } = useWindowedLines({
        listRef, lines, keyOf, estimate, windowed, overscanPx: 100, fallbackHeightPx: 500, anchorList,
    });
    return (
        <div data-testid="list" ref={listRef} onScroll={readView}>
            <div data-testid="total" style={{ height: offsets[lines.length] }} />
            {lines.slice(windowStart, windowEnd).map((l, n) => (
                <div key={l} data-testid={keyOf(l)} ref={lineRef(keyOf(l))} style={{ top: offsets[windowStart + n] }} />
            ))}
        </div>
    );
}

const list = () => screen.getByTestId('list');
const scrollTo = (px: number) => { list().scrollTop = px; fireEvent.scroll(list()); };

let observers: ResizeObservers;
beforeEach(() => { observers = captureResizeObservers(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('useWindowedLines', () => {
    it('windowed false: a plain list, every line is rendered and nothing is measured', () => {
        const short = LINES.slice(0, 20);
        render(<List lines={short} windowed={false} />);
        expect(screen.getByTestId('L19')).toBeTruthy();
        setLineHeight(screen.getByTestId('L0'), 90);
        act(() => observers.fire());
        expect(screen.getByTestId('total').style.height).toBe(`${20 * ROW}px`);
    });

    it('renders the lines in view plus the overscan, and scrolling moves them', () => {
        render(<List />);
        expect(screen.getByTestId('L0')).toBeTruthy();
        expect(screen.queryByTestId('L20')).toBeNull();
        scrollTo(ROW * 500);
        expect(screen.queryByTestId('L0')).toBeNull();
        expect(screen.getByTestId('L500')).toBeTruthy();
        expect(screen.getByTestId('L498')).toBeTruthy();
    });

    it('a measured height replaces the estimate in every offset after it', () => {
        render(<List />);
        setLineHeight(screen.getByTestId('L1'), 80);
        act(() => observers.fire());
        expect(screen.getByTestId('L2').style.top).toBe(`${ROW + 80}px`);
        expect(screen.getByTestId('total').style.height).toBe(`${1000 * ROW + 30}px`);
    });

    it('a line above the view that grows keeps the first line in view where it was on screen', () => {
        render(<List />);
        scrollTo(ROW * 500);
        const line = screen.getByTestId('L498');
        setLineHeight(line, ROW + 70);
        act(() => observers.fire());
        expect(list().scrollTop).toBe(ROW * 500 + 70);
        expect(screen.getByTestId('L500').style.top).toBe(`${ROW * 500 + 70}px`);
    });

    it('a line above the view that shrinks moves the list back by as much', () => {
        render(<List />);
        scrollTo(ROW * 500);
        setLineHeight(screen.getByTestId('L498'), 20);
        act(() => observers.fire());
        expect(list().scrollTop).toBe(ROW * 500 - 30);
    });

    it('a late change with no commit at all (the web font arriving, a width change) is picked up by the observer', () => {
        render(<List />);
        scrollTo(ROW * 500);
        const before = observers.created();
        setLineHeight(screen.getByTestId('L498'), ROW + 10);
        // Nothing re-rendered: only the observer on the line can notice.
        expect(list().scrollTop).toBe(ROW * 500);
        act(() => observers.fire());
        expect(observers.created()).toBe(before);
        expect(list().scrollTop).toBe(ROW * 500 + 10);
    });

    it('a line in or below the view that grows leaves the scroll position alone', () => {
        render(<List />);
        scrollTo(ROW * 500);
        setLineHeight(screen.getByTestId('L501'), ROW + 70);
        act(() => observers.fire());
        expect(list().scrollTop).toBe(ROW * 500);
    });

    it('a new list starts over: the line that was in view is not chased to its new place', () => {
        const { rerender } = render(<List />);
        scrollTo(ROW * 500);
        const narrowed = LINES.slice(100);
        rerender(<List lines={narrowed} />);
        expect(list().scrollTop).toBe(ROW * 500);
    });

    it('the same list with fewer lines above (its anchor list unchanged) does chase the line in view', () => {
        const { rerender } = render(<List anchorList="same" />);
        scrollTo(ROW * 500);
        rerender(<List lines={LINES.slice(100)} anchorList="same" />);
        expect(list().scrollTop).toBe(ROW * 400);
    });

    it('lines that leave the window stop being observed, and unmounting disconnects', () => {
        const { unmount } = render(<List />);
        const line = screen.getByTestId('L0');
        expect(observers.watching(line)).toBe(true);
        scrollTo(ROW * 500);
        expect(observers.watching(line)).toBe(false);
        unmount();
        expect(observers.live()).toBe(0);
    });
});
