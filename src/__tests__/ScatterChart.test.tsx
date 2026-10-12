import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';

function makeMockInstance() {
    const subs: Record<string, (...args: any[]) => void> = {};
    return {
        subscribe: vi.fn((event: string, cb: (...args: any[]) => void) => { subs[event] = cb; }),
        set: vi.fn(),
        reset: vi.fn(),
        destroy: vi.fn(),
        draw: vi.fn(),
        getScreenPosition: vi.fn(() => [50, 50]),
        __subs: subs,
    };
}

let lastInstance: ReturnType<typeof makeMockInstance> | null = null;
/** Every instance created this test, in creation order — main canvas first
 *  (its creation effect is declared before the halo layer's), halo second
 *  when one gets created. Used by the halo-layer tests below to tell the
 *  two WebGL instances apart. */
let instances: ReturnType<typeof makeMockInstance>[] = [];
const mockCreateScatterplot = vi.fn((_opts: any) => {
    lastInstance = makeMockInstance();
    instances.push(lastInstance);
    return lastInstance;
});
vi.mock('regl-scatterplot', () => ({
    default: (opts: any) => mockCreateScatterplot(opts),
}));

const mockReportError = vi.fn();
vi.mock('../errorReporter', () => ({
    reportError: (...args: unknown[]) => mockReportError(...args),
}));

let lastResizeCallback: (() => void) | null = null;
class MockResizeObserver {
    constructor(cb: () => void) { lastResizeCallback = cb; }
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
}

import ScatterChart from '../components/charts/ScatterChart';
import { findPickerRow, openPickerSurface, pickSingle, rowTag } from './helpers/sensorPicker';

// X / Y are the shared compact single pickers (not native selects).
const axisTriggers = () => [screen.getByRole('button', { name: 'X sensor' }), screen.getByRole('button', { name: 'Y sensor' })];

function last<T>(arr: T[]): T {
    return arr[arr.length - 1];
}

const headers = ['A', 'B'];
const data = [
    { timestamp: 't0', values: [1, 10] },
    { timestamp: 't1', values: [2, 20] },
    { timestamp: 't2', values: [3, 30] },
] as any;

let origClientWidth: PropertyDescriptor | undefined;
let origClientHeight: PropertyDescriptor | undefined;

beforeEach(() => {
    mockCreateScatterplot.mockClear();
    mockReportError.mockClear();
    lastInstance = null;
    instances = [];
    lastResizeCallback = null;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    // jsdom has no layout engine — clientWidth/clientHeight are always 0,
    // which would make ScatterChart's size guard (`innerDims.width === 0`)
    // skip creating the WebGL instance entirely. Force a stable, non-zero
    // box for every element so the component behaves as it would in a real
    // window.
    origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (origClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientWidth);
    if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight);
});

describe('ScatterChart', () => {
    it('shows a placeholder and never creates a WebGL instance with fewer than 2 sensors', () => {
        render(<ScatterChart data={data} sensors={['A']} headers={headers} />);
        expect(screen.getByText('Select at least 2 sensors')).toBeTruthy();
        expect(mockCreateScatterplot).not.toHaveBeenCalled();
    });

    it('defaults X/Y to the first two distinct sensors', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(axisTriggers().map(t => rowTag(t))).toEqual(['A', 'B']);
    });

    it('notifies the parent of the settled X/Y pair via onScatterAxesChange', () => {
        const onScatterAxesChange = vi.fn();
        render(
            <ScatterChart data={data} sensors={['A', 'B']} headers={headers} onScatterAxesChange={onScatterAxesChange} />,
        );
        expect(onScatterAxesChange).toHaveBeenCalledWith('A', 'B');
    });

    it('changing the X dropdown updates the plotted X sensor', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        pickSingle(axisTriggers()[0], 'B');
        expect(rowTag(axisTriggers()[0])).toBe('B');
    });

    it('creates the WebGL instance sized to the inner plot area, themed dark by default', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1);
        const opts = mockCreateScatterplot.mock.calls[0][0];
        const expectedWidth = 800 - 88 - 20; // AXIS_PADDING.left/right
        const expectedHeight = 600 - 50 - 56; // AXIS_PADDING.top/bottom
        expect(opts.width).toBe(expectedWidth);
        expect(opts.height).toBe(expectedHeight);
        // Regression: regl-scatterplot defaults aspectRatio to 1 (assumes a
        // square data domain) and letterboxes a non-square canvas — our x/y
        // domains are both normalized to [-1,1] with nothing physical to
        // preserve, so this must match the canvas's own ratio to fill the
        // whole chart area instead of showing black bars on the sides.
        expect(opts.aspectRatio).toBe(expectedWidth / expectedHeight);
        // Visual refresh: recoloured from a leftover navy
        // slate-900 to match the app's own `--card-bg` — see ScatterChart.tsx's
        // matching comment.
        expect(opts.backgroundColor).toEqual([0.0627, 0.0627, 0.0706, 1.0]);
    });

    it('debounces resize-driven WebGL recreation (regression: a split-pane drag used to destroy+recreate the context on every single ResizeObserver tick)', () => {
        vi.useFakeTimers();
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1); // initial mount — immediate, no debounce

        // Simulate a rapid drag: several resize ticks in quick succession.
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 900 });
        act(() => { lastResizeCallback!(); });
        act(() => { vi.advanceTimersByTime(50); });
        act(() => { lastResizeCallback!(); });
        act(() => { vi.advanceTimersByTime(50); });
        act(() => { lastResizeCallback!(); });
        // Still within the 150ms debounce window of the LAST tick — no new
        // instance yet, even though 3 resize events already fired.
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1);

        // Let the debounce settle past the last tick.
        act(() => { vi.advanceTimersByTime(150); });
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(2); // exactly one recreation, not three
    });

    it('subscribes to pointover/pointout/view (no lasso select/deselect — that feature was removed)', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        const events = Object.keys(lastInstance!.__subs);
        expect(events).toEqual(expect.arrayContaining(['pointover', 'pointout', 'view']));
        expect(events).not.toEqual(expect.arrayContaining(['select', 'deselect']));
    });

    describe('point colouring ("by value" highlighting — the range editor itself lives in Dashboard\'s Highlights tab, not this chart\'s own toolbar)', () => {
        const headers3 = ['A', 'B', 'C'];
        const data3 = [
            { timestamp: 't0', values: [1, 10, 100] },
            { timestamp: 't1', values: [2, 20, 200] },
            { timestamp: 't2', values: [3, 30, 300] },
        ] as any;

        it('no criteria control exists in this chart\'s own toolbar (only X/Y pickers)', () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            expect(document.querySelectorAll('.pk-trigger')).toHaveLength(2); // X, Y only
            expect(screen.queryByText('Colour by…')).toBeNull();
            expect(screen.queryByPlaceholderText('min')).toBeNull();
            expect(screen.queryByText('+ Add')).toBeNull();
        });

        it('colours points flat when no valueHighlight prop is passed at all', () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBeNull();
            expect(lastSetCall![0].pointColor).toEqual([0.39, 0.58, 0.98, 0.55]);
        });

        it('colours points flat when a sensor is picked but has no enabled ranges yet', () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} valueHighlight={{ sensor: 'C', ranges: [] }} />);
            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBeNull();
        });

        it('colours points by value once a range is enabled, using each range\'s own colour + a fixed unmatched colour at index 0', async () => {
            const valueHighlight = {
                sensor: 'C',
                ranges: [{ id: 'r1', min: 150, max: 250, color: '#ff0000', enabled: true }],
            };
            await act(async () => {
                render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} valueHighlight={valueHighlight} />);
                await Promise.resolve();
                await Promise.resolve();
            });
            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBe('valueA');
            expect(lastSetCall![0].pointColor).toEqual([
                [0.55, 0.6, 0.68, 0.12], // VALUE_UNMATCHED_COLOR
                [1, 0, 0, 1], // #ff0000
            ]);
            // Row t0 (C=100) and t2 (C=300) fall outside [150,250] -> category 0;
            // row t1 (C=200) falls inside -> category 1 (first, and only, range).
            const drawCall = last(lastInstance!.draw.mock.calls);
            expect(Array.from(drawCall[0].valueA as Float32Array)).toEqual([0, 1, 0]);
        });

        it('a disabled range is excluded from colouring (its points fall back to unmatched)', () => {
            const valueHighlight = {
                sensor: 'C',
                ranges: [{ id: 'r1', min: 150, max: 250, color: '#ff0000', enabled: false }],
            };
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} valueHighlight={valueHighlight} />);
            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBeNull(); // no enabled ranges at all -> flat, same as "no ranges"
        });

        it('the first matching range wins when ranges overlap', async () => {
            const valueHighlight = {
                sensor: 'C',
                ranges: [
                    { id: 'r1', min: 50, max: 350, color: '#ff0000', enabled: true },
                    { id: 'r2', min: 150, max: 250, color: '#00ff00', enabled: true },
                ],
            };
            await act(async () => {
                render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} valueHighlight={valueHighlight} />);
                await Promise.resolve();
                await Promise.resolve();
            });
            const drawCall = last(lastInstance!.draw.mock.calls);
            // Every row falls in range 1 (wider) first, even the ones that
            // also fall in range 2 -> all category 1, never 2.
            expect(Array.from(drawCall[0].valueA as Float32Array)).toEqual([1, 1, 1]);
        });
    });

    describe('time-highlight halo layer (2nd WebGL instance, colour ring around matching points)', () => {
        const dataT = [
            { timestamp: '2026-01-01T00:00:00', values: [1, 10] },
            { timestamp: '2026-01-01T01:00:00', values: [2, 20] },
            { timestamp: '2026-01-01T02:00:00', values: [3, 30] },
        ] as any;
        const highlight1 = { id: 'h1', start: '2026-01-01T00:00:00', end: '2026-01-01T01:00:00', label: 'Startup', color: '#ff0000', enabled: true };

        it('does not create a halo instance when timeHighlights is absent or empty', () => {
            render(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[]} />);
            expect(mockCreateScatterplot).toHaveBeenCalledTimes(1); // main only
        });

        it('does not create a halo instance when every highlight is disabled', () => {
            render(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[{ ...highlight1, enabled: false }]} />);
            expect(mockCreateScatterplot).toHaveBeenCalledTimes(1);
        });

        it('creates a second, transparent-background WebGL instance once a highlight is enabled', () => {
            render(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[highlight1]} />);
            expect(mockCreateScatterplot).toHaveBeenCalledTimes(2);
            const haloOpts = mockCreateScatterplot.mock.calls[1][0];
            expect(haloOpts.backgroundColor).toEqual([0, 0, 0, 0]);
        });

        it('draws only points whose timestamp falls inside the enabled highlight, categorised on the halo layer', async () => {
            await act(async () => {
                render(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[highlight1]} />);
                await Promise.resolve();
                await Promise.resolve();
            });
            const haloInstance = instances[1];
            const haloDraw = last(haloInstance.draw.mock.calls);
            const valueA = haloDraw[0].valueA as Float32Array;
            expect(valueA[0]).toBe(1); // 00:00 — inside [00:00, 01:00]
            expect(valueA[1]).toBe(1); // 01:00 — inside (inclusive end)
            expect(valueA[2]).toBe(0); // 02:00 — outside

            const haloSet = last(haloInstance.set.mock.calls.filter((c: any) => 'colorBy' in c[0]));
            expect(haloSet[0].colorBy).toBe('valueA');
            expect(haloSet[0].pointColor[0]).toEqual([0, 0, 0, 0]); // unmatched → fully transparent
            expect(haloSet[0].pointColor[1]).toEqual([1, 0, 0, 0.85]); // highlight1's own colour
        });

        it('never touches the main canvas\'s flat fill colour — the two channels stay independent', async () => {
            await act(async () => {
                render(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[highlight1]} />);
                await Promise.resolve();
                await Promise.resolve();
            });
            const mainSet = last(instances[0].set.mock.calls.filter((c: any) => 'colorBy' in c[0]));
            expect(mainSet[0].colorBy).toBeNull();
            expect(mainSet[0].pointColor).toEqual([0.39, 0.58, 0.98, 0.55]); // still the flat base colour, untouched by the highlight
        });

        it('relays pan/zoom from the main instance to the halo layer via cameraView', () => {
            render(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[highlight1]} />);
            const fakeScale = { domain: () => [0, 1] };
            const fakeView = new Float32Array([1, 0, 0, 0]);
            act(() => { instances[0].__subs['view']({ xScale: fakeScale, yScale: fakeScale, view: fakeView }); });
            expect(instances[1].set).toHaveBeenCalledWith(expect.objectContaining({ cameraView: fakeView }));
        });

        it('tears down the halo instance once every highlight becomes disabled', () => {
            const { rerender } = render(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[highlight1]} />);
            expect(mockCreateScatterplot).toHaveBeenCalledTimes(2);
            const haloInstance = instances[1];

            rerender(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[{ ...highlight1, enabled: false }]} />);
            expect(haloInstance.destroy).toHaveBeenCalledTimes(1);
        });

        it('stops relaying view events to the halo instance once it is torn down (no "already destroyed" call)', () => {
            const { rerender } = render(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[highlight1]} />);
            const haloInstance = instances[1];

            rerender(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[{ ...highlight1, enabled: false }]} />);
            expect(haloInstance.destroy).toHaveBeenCalledTimes(1);
            const setCallsAtTeardown = haloInstance.set.mock.calls.length;

            // Simulate a pan/zoom landing right after teardown — the main
            // instance's `view` subscriber must not call `.set()` on the
            // now-destroyed halo instance (that's what regl-scatterplot
            // throws "The instance was already destroyed" for).
            const fakeScale = { domain: () => [0, 1] };
            act(() => { instances[0].__subs['view']({ xScale: fakeScale, yScale: fakeScale, view: new Float32Array([1, 0, 0, 0]) }); });
            expect(haloInstance.set.mock.calls.length).toBe(setCallsAtTeardown);
        });

        it('clears the halo canvas pixel buffer on teardown, not just the WebGL context', () => {
            const { rerender } = render(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[highlight1]} />);
            const haloCanvas = screen.getByTestId('scatter-halo-canvas') as HTMLCanvasElement;
            const widthSetter = vi.fn();
            Object.defineProperty(haloCanvas, 'width', { configurable: true, get: () => 300, set: widthSetter });

            rerender(<ScatterChart data={dataT} sensors={['A', 'B']} headers={headers} timeHighlights={[{ ...highlight1, enabled: false }]} />);

            // destroy() only tears down the WebGL context — it leaves the canvas's
            // last-rendered frame on screen. Re-assigning `width` is what actually
            // forces the browser to clear the backing bitmap, so this must fire too.
            expect(widthSetter).toHaveBeenCalledWith(300);
        });
    });

    it('shows a retry overlay and reports the error when instance creation throws', () => {
        mockCreateScatterplot.mockImplementationOnce(() => { throw new Error('WebGL context creation failed'); });
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(screen.getByText(/WebGL unavailable/)).toBeTruthy();
        expect(screen.getByText('WebGL context creation failed')).toBeTruthy();
        expect(mockReportError).toHaveBeenCalledWith('scatter-init', expect.any(Error));
    });

    it('the WebGL-unavailable overlay uses the design-token CSS variables, not hardcoded colors', () => {
        mockCreateScatterplot.mockImplementationOnce(() => { throw new Error('boom'); });
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        const overlay = screen.getByText(/WebGL unavailable/).parentElement as HTMLElement;
        expect(overlay.style.background).toBe('var(--card-bg)');
        expect(overlay.style.color).toBe('var(--text-primary)');
        expect(overlay.style.background).not.toMatch(/#[0-9a-f]{3,6}|rgba\(/i);
    });

    it('Retry after an init failure re-attempts instance creation', () => {
        mockCreateScatterplot.mockImplementationOnce(() => { throw new Error('boom'); });
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByText('Retry'));
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(2);
    });

    it('shows a context-lost overlay on webglcontextlost and hides it on restore', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        // Must target the MAIN canvas specifically -- the halo canvas (see
        // the halo-layer describe block below) is always present in the DOM
        // ahead of it, even when unused, and never gets the context-loss
        // listeners since no WebGL context is ever created on it in that case.
        const canvas = screen.getByTestId('scatter-main-canvas');

        act(() => { canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); });
        expect(screen.getByText(/GPU dropped the canvas/)).toBeTruthy();

        act(() => { canvas.dispatchEvent(new Event('webglcontextrestored')); });
        expect(screen.queryByText(/GPU dropped the canvas/)).toBeNull();
    });

    it('Reset view calls sc.reset()', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByTitle('Reset view'));
        expect(lastInstance!.reset).toHaveBeenCalledTimes(1);
    });

    describe('axis-scale editor', () => {
        it('opens via the Ruler button and shows an error when min >= max', () => {
            render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByTitle(/Pin the X\/Y axis/));

            const inputs = screen.getAllByPlaceholderText('min');
            const [xMin] = inputs;
            const xMaxInputs = screen.getAllByPlaceholderText('max');
            fireEvent.change(xMin, { target: { value: '10' } });
            fireEvent.change(xMaxInputs[0], { target: { value: '5' } });
            fireEvent.click(screen.getByText('Apply'));

            expect(screen.getByText('X min must be less than X max')).toBeTruthy();
        });

        it('shows an error when nothing is entered', () => {
            render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByTitle(/Pin the X\/Y axis/));
            fireEvent.click(screen.getByText('Apply'));
            expect(screen.getByText('Enter at least one bound')).toBeTruthy();
        });

        it('applies a valid pin, closes the editor, and notifies the parent', () => {
            const onScatterAxisPinsChange = vi.fn();
            render(
                <ScatterChart
                    data={data} sensors={['A', 'B']} headers={headers}
                    onScatterAxisPinsChange={onScatterAxisPinsChange}
                />,
            );
            fireEvent.click(screen.getByTitle(/Pin the X\/Y axis/));
            const [xMin] = screen.getAllByPlaceholderText('min');
            const [xMax] = screen.getAllByPlaceholderText('max');
            fireEvent.change(xMin, { target: { value: '0' } });
            fireEvent.change(xMax, { target: { value: '10' } });
            fireEvent.click(screen.getByText('Apply'));

            expect(screen.queryByText('Apply')).toBeNull(); // editor closed
            expect(onScatterAxisPinsChange).toHaveBeenLastCalledWith({
                x: { sensor: 'A', min: 0, max: 10 },
                y: undefined,
            });
        });

        it('Unpin clears an active pin', () => {
            const onScatterAxisPinsChange = vi.fn();
            render(
                <ScatterChart
                    data={data} sensors={['A', 'B']} headers={headers}
                    onScatterAxisPinsChange={onScatterAxisPinsChange}
                />,
            );
            fireEvent.click(screen.getByTitle(/Pin the X\/Y axis/));
            const [xMin] = screen.getAllByPlaceholderText('min');
            const [xMax] = screen.getAllByPlaceholderText('max');
            fireEvent.change(xMin, { target: { value: '0' } });
            fireEvent.change(xMax, { target: { value: '10' } });
            fireEvent.click(screen.getByText('Apply'));

            fireEvent.click(screen.getByTitle(/Axis scale pinned/));
            fireEvent.click(screen.getByText('Unpin'));
            expect(onScatterAxisPinsChange).toHaveBeenLastCalledWith({ x: undefined, y: undefined });
        });
    });

    it('shows a hover tooltip with the formatted values for the hovered point (regression: row id used to be shown too but is not user-meaningful, so it was dropped)', () => {
        const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        act(() => { lastInstance!.__subs['pointover'](0); });

        const tooltip = container.querySelector('.scatter-regl-tooltip')!;
        expect(tooltip).toBeTruthy();
        expect(tooltip.querySelector('.scatter-regl-tooltip-title')).toBeNull();
        expect(tooltip.textContent).not.toContain('Row');
        // Inline label + value (the one en-US formatter) per row.
        const vals = [...tooltip.querySelectorAll('.tt-row')].map(r => [rowTag(r), r.querySelector('.tt-val')?.textContent]);
        expect(vals).toEqual([['A', '1'], ['B', '10']]);
        expect(tooltip.textContent).toContain('t0');
    });

    // One date format in the whole app (2026-10-12): the Scatter printed the CSV text as it was
    // ("2025-03-14 21:25:00") while the Line chart's tooltip read "2025/03/14 21:25:00".
    it('the row time is in the one date format wherever it is printed (tooltip, the tag table\'s column head) — from the row\'s own clock', () => {
        const rows = [
            { timestamp: '2025-03-14 21:25:00', values: [1, 10] },
            { timestamp: '2025-03-14T21:30:00+07:00', values: [2, 20] }, // an offset never moves it
        ] as any;
        const { container } = render(<ScatterChart data={rows} sensors={['A', 'B']} headers={headers} />);
        act(() => { lastInstance!.__subs['pointover'](0); });
        expect(container.querySelector('.scatter-regl-tooltip-ts')!.textContent).toBe('2025/03/14 21:25:00');
        act(() => { lastInstance!.__subs['pointover'](1); });
        expect(container.querySelector('.scatter-regl-tooltip-ts')!.textContent).toBe('2025/03/14 21:30:00');
        // tag that point: its column head in the table under the chart reads the same
        fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
        fireEvent.click(container.querySelector('[data-testid="scatter-main-canvas"]')!);
        expect(container.querySelector('.scatter-tag-callout')).toBeNull(); // no value box on the plot
        expect(container.querySelector('.chart-tag-label')!.textContent).toBe('2025/03/14 21:30:00');
        expect(container.textContent).not.toContain('2025-03-14');
    });

    it('a tiny non-zero value in the tooltip keeps 3 significant digits instead of reading as 0', () => {
        const tiny = [{ timestamp: 't0', values: [0.00012, 12345678901.5] }] as any;
        const { container } = render(<ScatterChart data={tiny} sensors={['A', 'B']} headers={headers} />);
        act(() => { lastInstance!.__subs['pointover'](0); });
        const vals = [...container.querySelectorAll('.scatter-regl-tooltip .tt-row')].map(r => r.querySelector('.tt-val')?.textContent);
        expect(vals).toEqual(['0.00012', '12,345,678,902']);
        expect(vals[0]).not.toBe('0');
    });

    it('clears the tooltip on pointout', () => {
        const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        act(() => { lastInstance!.__subs['pointover'](0); });
        expect(container.querySelector('.scatter-regl-tooltip')).toBeTruthy();

        act(() => { lastInstance!.__subs['pointout'](); });
        expect(container.querySelector('.scatter-regl-tooltip')).toBeNull();
    });

    // Scatter's axis titles have room — they are the
    // Inline label (description then tag) + the unit, with the full name in `title`.
    describe('axis titles: Inline label + unit', () => {
        const sensorMetadata = [
            { tag: 'A', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
            { tag: 'B', description: '', unit: '', component: '' }, // known tag, blank description
        ];

        // User decision 2026-10-11 ("เอาเป็น 2 บรรทัด"): the description has its own line, so a
        // long name is no longer cut by the tag + unit sharing it.
        it('X title is two lines: description, then tag + unit; the title attribute carries every part', () => {
            render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
            const x = screen.getByTestId('scatter-axis-title-x');
            expect([...x.children].map(el => el.className)).toEqual(['sat-l1', 'sat-l2']);
            expect(x.querySelector('.sat-l1')?.textContent).toBe('Pump Pressure');
            expect(x.querySelector('.sat-l2 .sat-tag')?.textContent).toBe('A');
            expect(x.querySelector('.sat-l2 .scatter-axis-unit')?.textContent).toBe('bar');
            expect(x.getAttribute('title')).toBe('Pump Pressure · A · bar · Pump');
        });

        it('Y title is the vertical form of the same two lines', () => {
            render(<ScatterChart data={data} sensors={['B', 'A']} headers={headers} sensorMetadata={sensorMetadata} />);
            const y = screen.getByTestId('scatter-axis-title-y');
            expect(y.classList.contains('scatter-axis-title--y')).toBe(true);
            expect([...y.children].map(el => el.className)).toEqual(['sat-l1', 'sat-l2']);
            expect(y.querySelector('.sat-desc')?.textContent).toBe('Pump Pressure');
            expect(y.querySelector('.sat-l2')?.textContent).toBe('Abar');
        });

        it('a blank description shows the tag line alone — one line, the tag never twice, no unit when none', () => {
            render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
            const y = screen.getByTestId('scatter-axis-title-y');
            expect([...y.children].map(el => el.className)).toEqual(['sat-l2']);
            expect(y.textContent).toBe('B');
            expect(y.querySelector('.scatter-axis-unit')).toBeNull();
        });

        it('the Y title column and the wider gutter leave room for both lines beside the tick labels', () => {
            render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
            const y = screen.getByTestId('scatter-axis-title-y');
            expect(y.style.left).toBe('2px');
            expect(y.style.width).toBe('30px');
            // 600 px tall wrapper: the 28 px X title sits 3 px above the bottom edge, under the ticks.
            const x = screen.getByTestId('scatter-axis-title-x');
            expect(x.style.height).toBe('28px');
            expect(x.style.top).toBe(`${600 - 28 - 3}px`);
            expect(x.style.left).toBe('88px');
        });
    });

    // The native X / Y selects of are retired — the
    // compact single picker shows the Inline label and opens an anchored popover scoped to the
    // sensors on the chart; Y opens right-aligned so it stays inside the chart.
    describe('X/Y sensor pickers', () => {
        const sensorMetadata = [
            { tag: 'A', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
            { tag: 'B', description: '', unit: '', component: '' },
        ];

        it('compact triggers show the Inline label (description then tag, bare tag when none)', () => {
            render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
            const [x, y] = axisTriggers();
            expect(x.classList.contains('pk-trigger--sm')).toBe(true);
            expect(x.textContent).toBe('Pump PressureA');
            expect(y.textContent).toBe('B');
        });

        it('the popover is scoped to the sensors on the chart and says so', () => {
            render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
            fireEvent.click(axisTriggers()[1]);
            expect(openPickerSurface().querySelector('.pk-scope')?.textContent).toBe('Sensors on the chart · 2');
            expect(findPickerRow('A').textContent).toContain('Pump Pressure');
        });

        it('renders "X" and "Y" as their own badge next to each picker', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
            const badges = Array.from(container.querySelectorAll('.scatter-regl-axis-badge')).map(b => b.textContent);
            expect(badges).toEqual(['X', 'Y']);
            expect(container.querySelector('select')).toBeNull();
        });
    });

    describe('Tag Point (click a point to compare it with others — local/ephemeral, not persisted; see LineTaggedPoint\'s docstring for why)', () => {
        function getCanvas(container: HTMLElement): HTMLElement {
            return container.querySelector('[data-testid="scatter-main-canvas"]')!;
        }

        it('renders the toolbox with Reset View, Ruler, and Tag — Tag off by default', () => {
            render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            expect(screen.getByTitle(/compare 2\+ points/i)).toBeTruthy();
        });

        it('does nothing on canvas click while tag mode is off, even while hovering a point', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            act(() => { lastInstance!.__subs['pointover'](0); });
            fireEvent.click(getCanvas(container));
            expect(container.querySelector('.scatter-tag-ring')).toBeNull();
        });

        it('does nothing on canvas click while tag mode is on but nothing is hovered', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
            fireEvent.click(getCanvas(container));
            expect(container.querySelector('.scatter-tag-ring')).toBeNull();
        });

        it('tags the hovered point on click while tag mode is on', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
            act(() => { lastInstance!.__subs['pointover'](0); });
            fireEvent.click(getCanvas(container));

            expect(container.querySelector('.scatter-tag-ring')).toBeTruthy();
            expect(container.querySelector('.scatter-tag-badge')).toBeNull(); // no number: the ring's colour is the tag
            // No value box on the plot: the values are in the table under the chart —
            // one row per axis (X then Y), one column per tag.
            expect(container.querySelector('.scatter-tag-callout')).toBeNull();
            const table = screen.getByTestId('tag-table');
            expect(within(table).getAllByRole('listitem').map(h => h.textContent)).toEqual(['t0']);
            // The column head's dot is the colour of the ring on the plot.
            const ring = container.querySelector('.scatter-tag-ring') as HTMLElement;
            expect((table.querySelector('.chart-tag-dot') as HTMLElement).style.background).toBe(ring.style.borderColor);
            const names = within(table).getAllByTestId('tag-table-name').map(n => n.textContent);
            expect(names).toEqual(['XA', 'YB']);
            expect(within(table).getAllByTestId('tag-table-val').map(v => v.textContent)).toEqual(['1', '10']);
            // Stacked under the plot, not laid over it.
            expect(container.querySelector('.scatter-regl-wrap')!.contains(table)).toBe(false);
        });

        it('with a place offered by the Dashboard the table goes INTO it, and the tag count is reported', () => {
            const host = document.createElement('div');
            document.body.appendChild(host);
            const onCount = vi.fn();
            const { container, unmount } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} tagTableHost={host} onTagCountChange={onCount} />);
            expect(onCount).toHaveBeenLastCalledWith(0, false);
            fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
            expect(container.textContent).toContain('its values are listed in the Tagged points tab');
            act(() => { lastInstance!.__subs['pointover'](0); });
            fireEvent.click(getCanvas(container));
            expect(onCount).toHaveBeenLastCalledWith(1, true);
            expect(container.querySelector('[data-testid="tag-table"]')).toBeNull();
            const table = host.querySelector('[data-testid="tag-table"]') as HTMLElement;
            expect(within(table).getAllByTestId('tag-table-val').map(v => v.textContent)).toEqual(['1', '10']);
            unmount();
            expect(onCount).toHaveBeenLastCalledWith(0, false);
            host.remove();
        });

        it('clicking an already-tagged point again removes it (toggle)', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
            act(() => { lastInstance!.__subs['pointover'](0); });
            fireEvent.click(getCanvas(container)); // tag
            fireEvent.click(getCanvas(container)); // untag (still hovering the same point)
            expect(container.querySelector('.scatter-tag-ring')).toBeNull();
        });

        it('does not show a delta comparison line for a second tagged point (removed per user feedback -- not used)', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
            act(() => { lastInstance!.__subs['pointover'](0); });
            fireEvent.click(getCanvas(container));
            act(() => { lastInstance!.__subs['pointover'](1); });
            fireEvent.click(getCanvas(container));

            const table = screen.getByTestId('tag-table');
            // Two tags = two value columns per row, and nothing else (no Δ column or text).
            expect(within(table).getAllByTestId('tag-table-val').map(v => v.textContent)).toEqual(['1', '2', '10', '20']);
            expect(table.textContent).not.toContain('Δ');
        });

        it('"Clear all" only appears once a tag exists, and clears every tag', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            expect(screen.queryByTitle('Clear all tags')).toBeNull();

            fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
            act(() => { lastInstance!.__subs['pointover'](0); });
            fireEvent.click(getCanvas(container));
            expect(screen.getByTitle('Clear all tags')).toBeTruthy();

            fireEvent.click(screen.getByTitle('Clear all tags'));
            expect(container.querySelector('.scatter-tag-ring')).toBeNull();
            expect(screen.queryByTitle('Clear all tags')).toBeNull();
        });

        describe('removing ONE tag from the tag list (customer request 2026-10-08: tags could only be cleared all at once)', () => {
            function tagThree(container: HTMLElement) {
                fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
                for (const idx of [0, 1, 2]) {
                    act(() => { lastInstance!.__subs['pointover'](idx); });
                    fireEvent.click(getCanvas(container));
                }
            }

            it('lists every tag with its badge, timestamp and its own remove button', () => {
                const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
                expect(screen.queryByRole('list', { name: 'Tagged points' })).toBeNull(); // nothing tagged yet
                tagThree(container);
                const list = screen.getByRole('list', { name: 'Tagged points' });
                const rows = within(list).getAllByRole('listitem');
                expect(rows.map(r => r.textContent)).toEqual(['t0', 't1', 't2']);
                expect(within(list).getAllByRole('button', { name: /^Remove tag/ })).toHaveLength(3);
            });

            it('the × removes exactly that tag and keeps the others (and their colours)', () => {
                const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
                tagThree(container);
                const ringColours = () => Array.from(container.querySelectorAll<HTMLElement>('.scatter-tag-ring')).map(r => r.style.borderColor);
                const [c0, , c2] = ringColours();

                fireEvent.click(screen.getByRole('button', { name: 'Remove tag ② t1' }));

                expect(container.querySelectorAll('.scatter-tag-ring')).toHaveLength(2);
                expect(ringColours()).toEqual([c0, c2]);
                // The removed tag's column goes with it: the X row keeps the values of t0 and t2.
                expect(screen.getAllByTestId('tag-table-val').slice(0, 2).map(v => v.textContent)).toEqual(['1', '3']);
                // Badges renumber by position, the list matches the markers.
                const rows = within(screen.getByRole('list', { name: 'Tagged points' })).getAllByRole('listitem');
                expect(rows.map(r => r.textContent)).toEqual(['t0', 't2']);
                // Clear all is still there for the rest.
                expect(screen.getByTitle('Clear all tags')).toBeTruthy();
            });

            it('works with tag mode switched off (the list is not a tag-mode-only control)', () => {
                const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
                tagThree(container);
                fireEvent.click(screen.getByTitle(/click a point to pin it/i)); // tag mode off
                fireEvent.click(screen.getByRole('button', { name: 'Remove tag ① t0' }));
                expect(container.querySelectorAll('.scatter-tag-ring')).toHaveLength(2);
            });

            it('a tag added after removing a middle one takes the freed colour, never a colour still on the chart', () => {
                const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
                tagThree(container);
                const ringColours = () => Array.from(container.querySelectorAll<HTMLElement>('.scatter-tag-ring')).map(r => r.style.borderColor);
                const [, c1] = ringColours();
                fireEvent.click(screen.getByRole('button', { name: 'Remove tag ② t1' }));
                act(() => { lastInstance!.__subs['pointover'](1); });
                fireEvent.click(getCanvas(container)); // re-tag point 1
                const after = ringColours();
                expect(after).toHaveLength(3);
                expect(new Set(after).size).toBe(3); // all distinct
                expect(after[2]).toBe(c1);
            });

            it('removing the last remaining tag hides the list and the Clear all button', () => {
                const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
                act(() => { lastInstance!.__subs['pointover'](0); });
                fireEvent.click(getCanvas(container));
                fireEvent.click(screen.getByRole('button', { name: 'Remove tag ① t0' }));
                expect(screen.queryByRole('list', { name: 'Tagged points' })).toBeNull();
                expect(screen.queryByTitle('Clear all tags')).toBeNull();
                expect(container.querySelector('.scatter-tag-ring')).toBeNull();
            });

            it('keyboard focus moves to the previous row\'s × after removing the last row, then to the toolbox Tag button once none remain', () => {
                const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
                tagThree(container);
                const tagButton = screen.getByTitle(/click a point to pin it/i);
                const last = screen.getByRole('button', { name: 'Remove tag ③ t2' });
                last.focus();
                fireEvent.click(last);
                expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove tag ② t1' }));
                fireEvent.click(document.activeElement as HTMLElement);
                expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove tag ① t0' }));
                fireEvent.click(document.activeElement as HTMLElement);
                expect(screen.queryByRole('list', { name: 'Tagged points' })).toBeNull();
                expect(document.activeElement).toBe(tagButton);
            });
        });

        it('clears every tag when the underlying data changes (sampled points have no stable identity across a refetch)', () => {
            const { container, rerender } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
            act(() => { lastInstance!.__subs['pointover'](0); });
            fireEvent.click(getCanvas(container));
            expect(container.querySelector('.scatter-tag-ring')).toBeTruthy();

            const newData = [{ timestamp: 't9', values: [9, 90] }] as any;
            rerender(<ScatterChart data={newData} sensors={['A', 'B']} headers={headers} />);
            expect(container.querySelector('.scatter-tag-ring')).toBeNull();
        });

        it('clears every tag when the X/Y sensor pair changes', () => {
            const threeSensors = ['A', 'B', 'C'];
            const threeHeaders = ['A', 'B', 'C'];
            const threeData = [
                { timestamp: 't0', values: [1, 10, 100] },
                { timestamp: 't1', values: [2, 20, 200] },
            ] as any;
            const { container } = render(<ScatterChart data={threeData} sensors={threeSensors} headers={threeHeaders} />);
            fireEvent.click(screen.getByTitle(/compare 2\+ points/i));
            act(() => { lastInstance!.__subs['pointover'](0); });
            fireEvent.click(getCanvas(container));
            expect(container.querySelector('.scatter-tag-ring')).toBeTruthy();

            pickSingle(axisTriggers()[1], 'C'); // Y: B -> C
            expect(container.querySelector('.scatter-tag-ring')).toBeNull();
        });
    });
});
