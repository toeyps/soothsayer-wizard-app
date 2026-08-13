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
const mockCreateScatterplot = vi.fn((_opts: any) => {
    lastInstance = makeMockInstance();
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

    describe('criteria-sensor colouring (value-range "load bands", multi-select)', () => {
        const headers3 = ['A', 'B', 'C'];
        const data3 = [
            { timestamp: 't0', values: [1, 10, 100] },  // C=100 → range 1
            { timestamp: 't1', values: [2, 20, 200] },  // C=200 → range 2
            { timestamp: 't2', values: [3, 30, 150] },  // C=150 → between ranges, unmatched
            { timestamp: 't3', values: [4, 40, null] }, // missing C — must still plot, unmatched
        ] as any;

        function addRange(min: string, max: string) {
            fireEvent.change(screen.getByPlaceholderText('min'), { target: { value: min } });
            fireEvent.change(screen.getByPlaceholderText('max'), { target: { value: max } });
            fireEvent.click(screen.getByText('+ Add'));
        }

        it('defaults to flat colouring (colorBy off) with no criteria sensor selected', () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBeNull();
        });

        it('picking a criteria sensor alone does not turn on colouring — a range must be added first', () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect, { target: { value: 'C' } });

            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBeNull();
            expect(lastSetCall![0].pointColor).toEqual([0.39, 0.58, 0.98, 0.55]);
        });

        it('adding a range turns on category colouring (colorBy: valueA) and categorizes each point', async () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect, { target: { value: 'C' } });

            // requestDraw defers sc.draw() to a microtask (see useCoalescedDraw) —
            // sc.set() runs synchronously, but draw() needs a flush before its
            // mock calls are visible.
            await act(async () => {
                addRange('50', '100');
                await Promise.resolve();
                await Promise.resolve();
            });

            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBe('valueA');
            expect(lastSetCall![0].pointColor).toHaveLength(2); // [unmatched, range1]

            const lastDrawCall = last(lastInstance!.draw.mock.calls);
            const valueA = lastDrawCall[0].valueA as Float32Array;
            expect(valueA[0]).toBe(1); // C=100 → inside [50,100]
            expect(valueA[1]).toBe(0); // C=200 → outside
            expect(valueA[2]).toBe(0); // C=150 → outside
            expect(valueA[3]).toBe(0); // C missing → unmatched
        });

        it('supports multiple enabled ranges at once, each its own category', async () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect, { target: { value: 'C' } });
            addRange('50', '100');
            await act(async () => {
                addRange('180', '220');
                await Promise.resolve();
                await Promise.resolve();
            });

            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].pointColor).toHaveLength(3); // [unmatched, range1, range2]

            const lastDrawCall = last(lastInstance!.draw.mock.calls);
            const valueA = lastDrawCall[0].valueA as Float32Array;
            expect(valueA[0]).toBe(1); // C=100 → range 1
            expect(valueA[1]).toBe(2); // C=200 → range 2
            expect(valueA[2]).toBe(0); // C=150 → matches neither
        });

        it('unchecking a range excludes it from colouring without deleting it', async () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect, { target: { value: 'C' } });
            addRange('50', '100');

            await act(async () => {
                fireEvent.click(screen.getByRole('checkbox'));
                await Promise.resolve();
                await Promise.resolve();
            });

            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBeNull(); // no enabled ranges left
            // The chip itself must still exist (unchecked, not removed).
            expect(screen.getByText('50.00–100.00')).toBeTruthy();
        });

        it('removing a range via its × button deletes it entirely', () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect, { target: { value: 'C' } });
            addRange('50', '100');
            expect(screen.getByText('50.00–100.00')).toBeTruthy();

            fireEvent.click(screen.getByTitle('Remove this range'));
            expect(screen.queryByText('50.00–100.00')).toBeNull();
        });

        it('rejects an invalid range (min >= max) with an inline error, without adding a chip', () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect, { target: { value: 'C' } });
            addRange('100', '50');

            expect(screen.getByText('Min must be less than max')).toBeTruthy();
            expect(screen.queryByText('100.00–50.00')).toBeNull();
        });

        it('shows the real min/max of the criteria sensor as a hint, and hides the whole panel when turned off', () => {
            const { container } = render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            expect(container.querySelector('.scatter-regl-criteria-legend')).toBeNull();

            const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect, { target: { value: 'C' } });
            const legend = container.querySelector('.scatter-regl-criteria-legend')!;
            expect(legend).toBeTruthy();
            expect(legend.textContent).toContain('C');
            expect(legend.textContent).toContain('100.00');
            expect(legend.textContent).toContain('200.00');

            fireEvent.change(criteriaSelect, { target: { value: '' } });
            expect(container.querySelector('.scatter-regl-criteria-legend')).toBeNull();
        });

        it('reverts to the flat base colour when the criteria sensor is cleared while a range was active', async () => {
            render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect, { target: { value: 'C' } });
            await act(async () => {
                addRange('50', '100');
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]))![0].colorBy).toBe('valueA');

            fireEvent.change(criteriaSelect, { target: { value: '' } });
            const lastSetCall = last(lastInstance!.set.mock.calls.filter((c) => 'colorBy' in c[0]));
            expect(lastSetCall![0].colorBy).toBeNull();
            expect(lastSetCall![0].pointColor).toEqual([0.39, 0.58, 0.98, 0.55]);
        });

        it('drops the criteria selection (and its ranges) if that sensor is deselected from the sensor list', () => {
            const { rerender, container } = render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect, { target: { value: 'C' } });
            addRange('50', '100');
            expect(container.querySelector('.scatter-regl-criteria-legend')).toBeTruthy();

            rerender(<ScatterChart data={data3} sensors={['A', 'B']} headers={headers3} />);
            expect(container.querySelector('.scatter-regl-criteria-legend')).toBeNull();

            // Re-selecting C (now back in the sensor list) must start with a
            // clean slate, not a resurrected stale range.
            rerender(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} />);
            const [, , criteriaSelect2] = screen.getAllByRole('combobox') as HTMLSelectElement[];
            fireEvent.change(criteriaSelect2, { target: { value: 'C' } });
            expect(screen.queryByText('50.00–100.00')).toBeNull();
        });

        describe('persistence (regression: used to be plain local state, so switching to Line/Pair Plot and back to Scatter silently dropped the sensor + every range)', () => {
            it('seeds the sensor and its ranges from the scatterCriteria prop on mount, unmount-surviving via Dashboard', () => {
                const scatterCriteria = { sensor: 'C', ranges: [{ id: 'r1', min: 50, max: 100, enabled: true }] };
                render(<ScatterChart data={data3} sensors={['A', 'B', 'C']} headers={headers3} scatterCriteria={scatterCriteria} />);

                const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
                expect(criteriaSelect.value).toBe('C');
                expect(screen.getByText('50.00–100.00')).toBeTruthy();
            });

            it('fires onScatterCriteriaChange whenever the sensor or ranges change, so the parent can persist them', () => {
                const onScatterCriteriaChange = vi.fn();
                render(
                    <ScatterChart
                        data={data3} sensors={['A', 'B', 'C']} headers={headers3}
                        onScatterCriteriaChange={onScatterCriteriaChange}
                    />,
                );
                const [, , criteriaSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
                fireEvent.change(criteriaSelect, { target: { value: 'C' } });
                expect(onScatterCriteriaChange).toHaveBeenLastCalledWith({ sensor: 'C', ranges: [] });

                addRange('50', '100');
                expect(onScatterCriteriaChange).toHaveBeenLastCalledWith({
                    sensor: 'C',
                    ranges: [expect.objectContaining({ min: 50, max: 100, enabled: true })],
                });
            });
        });
    });

    it('shows a retry overlay and reports the error when instance creation throws', () => {
        mockCreateScatterplot.mockImplementationOnce(() => { throw new Error('WebGL context creation failed'); });
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(screen.getByText(/WebGL unavailable/)).toBeTruthy();
        expect(screen.getByText('WebGL context creation failed')).toBeTruthy();
        expect(mockReportError).toHaveBeenCalledWith('scatter-init', expect.any(Error));
    });

    it('Retry after an init failure re-attempts instance creation', () => {
        mockCreateScatterplot.mockImplementationOnce(() => { throw new Error('boom'); });
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByText('Retry'));
        expect(mockCreateScatterplot).toHaveBeenCalledTimes(2);
    });

    it('shows a context-lost overlay on webglcontextlost and hides it on restore', () => {
        const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        const canvas = container.querySelector('canvas')!;

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
});
