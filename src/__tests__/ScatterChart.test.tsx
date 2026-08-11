import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';

function makeMockInstance() {
    const subs: Record<string, (...args: any[]) => void> = {};
    return {
        subscribe: vi.fn((event: string, cb: (...args: any[]) => void) => { subs[event] = cb; }),
        set: vi.fn(),
        reset: vi.fn(),
        deselect: vi.fn(),
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

class MockResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
}

import ScatterChart from '../components/charts/ScatterChart';

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
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('URL', {
        createObjectURL: vi.fn(() => 'blob:mock'),
        revokeObjectURL: vi.fn(),
    });

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

    it('subscribes to select/deselect/pointover/pointout/view', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        const events = Object.keys(lastInstance!.__subs);
        expect(events).toEqual(expect.arrayContaining(['select', 'deselect', 'pointover', 'pointout', 'view']));
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

    it('shows the selection panel when the lasso "select" event fires, and Clear dismisses it', () => {
        const { container } = render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        act(() => { lastInstance!.__subs['select']({ points: [0, 1] }); });
        expect(screen.getByText('2')).toBeTruthy();
        expect(screen.getByText(/points selected/)).toBeTruthy();

        const panel = container.querySelector<HTMLElement>('.scatter-regl-panel')!;
        fireEvent.click(within(panel).getByTitle('Clear selection'));
        expect(lastInstance!.deselect).toHaveBeenCalledTimes(1);
        expect(screen.queryByText(/points selected/)).toBeNull();
    });

    it('Reset view calls sc.reset()', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByTitle('Reset view'));
        expect(lastInstance!.reset).toHaveBeenCalledTimes(1);
    });

    it('toggling the lasso/pan tool sets mouseMode on the instance', () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        lastInstance!.set.mockClear();

        fireEvent.click(screen.getByTitle(/Lasso select/));
        expect(lastInstance!.set).toHaveBeenLastCalledWith({ mouseMode: 'lasso' });

        fireEvent.click(screen.getByTitle(/Pan \/ Zoom/));
        expect(lastInstance!.set).toHaveBeenLastCalledWith({ mouseMode: 'panZoom' });
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

    it('exports the selected rows as CSV', async () => {
        render(<ScatterChart data={data} sensors={['A', 'B']} headers={headers} />);
        act(() => { lastInstance!.__subs['select']({ points: [0, 1] }); });

        fireEvent.click(screen.getByTitle('Export selection to CSV'));

        const createObjectURL = (URL as any).createObjectURL as ReturnType<typeof vi.fn>;
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        const blob = createObjectURL.mock.calls[0][0] as Blob;
        const text = await blob.text();
        const lines = text.trim().split('\n');
        expect(lines[0]).toBe('rowIndex,timestamp,A,B');
        expect(lines[1]).toBe('0,t0,1,10');
        expect(lines[2]).toBe('1,t1,2,20');
    });
});
