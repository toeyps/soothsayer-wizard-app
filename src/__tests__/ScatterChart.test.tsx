import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

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
        const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
        expect(selects[0].value).toBe('A');
        expect(selects[1].value).toBe('B');
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
        const [xSelect] = screen.getAllByRole('combobox');
        fireEvent.change(xSelect, { target: { value: 'B' } });
        expect((xSelect as HTMLSelectElement).value).toBe('B');
    });

    it('creates the WebGL instance sized to the inner plot area, themed dark by default', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1);
        const opts = mockCreateScatterplot.mock.calls[0][0];
        const expectedWidth = 800 - 60 - 20; // AXIS_PADDING.left/right
        const expectedHeight = 600 - 50 - 50; // AXIS_PADDING.top/bottom
        expect(opts.width).toBe(expectedWidth);
        expect(opts.height).toBe(expectedHeight);
        // Regression: regl-scatterplot defaults aspectRatio to 1 (assumes a
        // square data domain) and letterboxes a non-square canvas — our x/y
        // domains are both normalized to [-1,1] with nothing physical to
        // preserve, so this must match the canvas's own ratio to fill the
        // whole chart area instead of showing black bars on the sides.
        expect(opts.aspectRatio).toBe(expectedWidth / expectedHeight);
        expect(opts.backgroundColor).toEqual([0.058, 0.094, 0.165, 1.0]);
        // pointOutlineWidth only affects lasso-selected points (unused
        // here) — kept at 0 as a documented no-op.
        expect(opts.pointOutlineWidth).toBe(0);
        // Regression: the SDF-antialiased circle edge read as a visible dark
        // ring around every point at high density on light theme's white
        // canvas.
        expect(opts.antiAliasing).toBe(0);
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

    describe('point colouring (criteria-sensor "By value" colouring was removed — Scatter only ever renders a flat colour on its own canvas)', () => {
        const headers3 = ['A', 'B', 'C'];
        const data3 = [
            { timestamp: 't0', values: [1, 10, 100] },
            { timestamp: 't1', values: [2, 20, 200] },
        ] as any;

        it('no criteria control exists in this chart\'s own toolbar (only X/Y pickers)', () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            expect(screen.getAllByRole('combobox')).toHaveLength(2); // X, Y only
            expect(screen.queryByText('Colour by…')).toBeNull();
            expect(screen.queryByPlaceholderText('min')).toBeNull();
            expect(screen.queryByText('+ Add')).toBeNull();
        });

        it('always colours points flat (colorBy off), never a category palette', () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBeNull();
            expect(lastSetCall![0].pointColor).toEqual([0.39, 0.58, 0.98, 0.55]);
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
            expect(haloOpts.pointOutlineWidth).toBe(0);
            expect(haloOpts.antiAliasing).toBe(0);
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

    it('the WebGL-unavailable overlay uses theme-aware colors, not a hardcoded dark navy card (regression: the canvas goes white in light theme but this overlay stayed hardcoded dark, floating as a jarring dark island)', () => {
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
        expect(tooltip.textContent).toContain('1.00'); // x value for row 0
        expect(tooltip.textContent).toContain('10.00'); // y value for row 0
        expect(tooltip.textContent).toContain('t0');
    });

    it('clears the tooltip on pointout', () => {
        const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        act(() => { lastInstance!.__subs['pointover'](0); });
        expect(container.querySelector('.scatter-regl-tooltip')).toBeTruthy();

        act(() => { lastInstance!.__subs['pointout'](); });
        expect(container.querySelector('.scatter-regl-tooltip')).toBeNull();
    });

    describe('axis-title hover tooltip for sensor description', () => {
        const sensorMetadata = [
            { tag: 'A', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
            { tag: 'B', description: '', unit: '', component: '' }, // known tag, blank description
        ];

        it('marks the X-axis title hoverable and renders its tooltip content when a description is known', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
            const xLabelWrap = Array.from(container.querySelectorAll('.pair-regl-axis-label'))
                .find((el) => el.querySelector('span')?.textContent === 'A');
            expect(xLabelWrap!.className).toContain('hoverable');
            const tooltip = xLabelWrap!.querySelector('.pair-regl-axis-tooltip')!;
            expect(tooltip.querySelector('.pair-regl-axis-tooltip-tag')!.textContent).toBe('A');
            expect(tooltip.querySelector('.pair-regl-axis-tooltip-desc')!.textContent).toBe('Pump Pressure');
        });

        it('does not mark the Y-axis title hoverable when its description is blank', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
            const yLabelWrap = Array.from(container.querySelectorAll('.pair-regl-axis-label'))
                .find((el) => el.querySelector('span')?.textContent === 'B');
            expect(yLabelWrap!.className).not.toContain('hoverable');
            expect(yLabelWrap!.querySelector('.pair-regl-axis-tooltip')).toBeNull();
        });

        it('no label is hoverable when sensorMetadata is not provided at all', () => {
            const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
            expect(container.querySelectorAll('.pair-regl-axis-label.hoverable').length).toBe(0);
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
            expect(container.querySelector('.scatter-tag-badge')!.textContent).toBe('①');
            const callout = container.querySelector('.scatter-tag-callout')!;
            expect(callout.textContent).toContain('t0');
            expect(callout.textContent).toContain('1.00'); // A's value for row 0
            expect(callout.textContent).toContain('10.00'); // B's value for row 0
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

            const callouts = container.querySelectorAll('.scatter-tag-callout');
            expect(callouts).toHaveLength(2);
            expect(callouts[1].textContent).not.toContain('Δ');
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

            const [, ySelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(ySelect, { target: { value: 'C' } }); // Y: B -> C
            expect(container.querySelector('.scatter-tag-ring')).toBeNull();
        });
    });
});
