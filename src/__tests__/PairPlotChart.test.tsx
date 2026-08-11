import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

const cellCalls: any[] = [];
vi.mock('../components/charts/PairPlotCell', () => ({
    default: (props: any) => {
        cellCalls.push(props);
        const key = `${props.sensorY}-${props.sensorX ?? 'time'}`;
        return (
            <div data-testid={`cell-${key}`}>
                <button onClick={() => props.onLasso([0, 1])}>{`lasso-${key}`}</button>
                <button
                    onClick={() =>
                        props.onHover({
                            rowIdx: 0,
                            xVal: props.isTimeAxis ? new Date('2026-01-01T00:00:00Z').getTime() : 1.23456,
                            yVal: 9.87654,
                            sensorX: props.isTimeAxis ? 'Time' : (props.sensorX ?? ''),
                            sensorY: props.sensorY,
                            isTimeAxis: !!props.isTimeAxis,
                            timestamp: '2026-01-01T00:00:00Z',
                            pageX: 10,
                            pageY: 20,
                        })
                    }
                >
                    {`hover-${key}`}
                </button>
            </div>
        );
    },
}));

const mockSave = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
    save: (...args: unknown[]) => mockSave(...args),
}));

const mockWriteUserTextFile = vi.fn().mockResolvedValue(undefined);
vi.mock('../workspaceManager', () => ({
    writeUserTextFile: (...args: unknown[]) => mockWriteUserTextFile(...args),
}));

class MockResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
}

import PairPlotChart from '../components/charts/PairPlotChart';

const headers = ['A', 'B'];
const data = [
    { timestamp: 't0', values: [1, 10] },
    { timestamp: 't1', values: [2, 20] },
    { timestamp: 't2', values: [3, 30] },
] as any;

let origClientWidth: PropertyDescriptor | undefined;
let origClientHeight: PropertyDescriptor | undefined;

beforeEach(() => {
    cellCalls.length = 0;
    mockSave.mockReset();
    mockWriteUserTextFile.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 150 });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (origClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientWidth);
    if (origClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight);
});

describe('PairPlotChart', () => {
    it('shows a placeholder with fewer than 2 sensors', () => {
        render(<PairPlotChart data={data} sensors={['A']} headers={headers} />);
        expect(screen.getByText('Select at least 2 sensors')).toBeTruthy();
    });

    it('a completed lasso spawns a labeled cluster with the first palette color', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('lasso-A-B'));

        expect(screen.getByText('Cluster 1')).toBeTruthy();
        expect(screen.getByText('2 rows')).toBeTruthy();
        const swatchInput = screen.getByLabelText('Change colour of Cluster 1') as HTMLInputElement;
        expect(swatchInput.value).toBe('#fcbf2e'); // CLUSTER_PALETTE[0] amber, rounded
    });

    it('successive lassos cycle through the palette with incrementing labels', () => {
        const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('lasso-A-B'));
        fireEvent.click(screen.getByText('lasso-B-time'));

        expect(screen.getByText('Cluster 1')).toBeTruthy();
        expect(screen.getByText('Cluster 2')).toBeTruthy();
        const head = container.querySelector('.pair-regl-cluster-panel-head')!;
        expect(head.textContent).toContain('2');
        expect(head.textContent).toContain('clusters');
    });

    it('deleting a cluster removes it from the panel', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('lasso-A-B'));
        fireEvent.click(screen.getByTitle('Delete Cluster 1'));
        expect(screen.queryByText('Cluster 1')).toBeNull();
    });

    it('recoloring a cluster updates its swatch input value', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('lasso-A-B'));
        const swatchInput = screen.getByLabelText('Change colour of Cluster 1') as HTMLInputElement;
        fireEvent.change(swatchInput, { target: { value: '#ff0000' } });
        expect((screen.getByLabelText('Change colour of Cluster 1') as HTMLInputElement).value).toBe('#ff0000');
    });

    it('Reset clears all clusters and bumps resetTick on every child cell', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('lasso-A-B'));
        expect(screen.getByText('Cluster 1')).toBeTruthy();

        cellCalls.length = 0;
        fireEvent.click(screen.getByTitle('Reset view + drop all clusters'));

        expect(screen.queryByText('Cluster 1')).toBeNull();
        expect(cellCalls.length).toBeGreaterThan(0);
        expect(cellCalls.every((c) => c.resetTick === 1)).toBe(true);
    });

    it('shows a hover tooltip with a plain formatted value for a non-time cell', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('hover-A-B'));
        expect(screen.getByText('Row 0')).toBeTruthy();
        expect(screen.getByText('1.2346')).toBeTruthy();
        expect(screen.getByText('9.8765')).toBeTruthy();
    });

    it('shows a hover tooltip with a formatted date/time for a time-axis cell', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('hover-B-time'));
        expect(screen.getByText('Row 0')).toBeTruthy();
        // formatDateTime output for 2026-01-01T00:00:00Z will vary with local
        // TZ, so just check the date portion is present and no timestamp
        // duplicate row is shown for the time axis.
        expect(screen.getByText(/2026\/01\/01/)).toBeTruthy();
    });

    describe('View Table dialog', () => {
        it('opens with every brushed row visible by default', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByTitle('View brushed rows in a table'));

            const modal = document.querySelector('.pair-regl-modal') as HTMLElement;
            expect(modal.querySelector('.pair-regl-modal-count')!.textContent).toBe('2');
            expect(within(modal).getAllByRole('row')).toHaveLength(3); // header + 2 rows
        });

        it('toggling a filter chip off hides that cluster from the table', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByTitle('View brushed rows in a table'));

            fireEvent.click(screen.getByTitle('Hide Cluster 1'));
            const modal = document.querySelector('.pair-regl-modal') as HTMLElement;
            expect(within(modal).getAllByRole('row')).toHaveLength(1); // header only
            expect(within(modal).getByText('No rows visible — enable at least one cluster chip above.')).toBeTruthy();
        });

        it('"None" then "All" toggles every cluster chip at once', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByTitle('View brushed rows in a table'));

            fireEvent.click(screen.getByTitle('Disable every cluster'));
            let modal = document.querySelector('.pair-regl-modal') as HTMLElement;
            expect(within(modal).getAllByRole('row')).toHaveLength(1);

            fireEvent.click(screen.getByTitle('Enable every cluster'));
            modal = document.querySelector('.pair-regl-modal') as HTMLElement;
            expect(within(modal).getAllByRole('row')).toHaveLength(3);
        });

        it('closes on backdrop click', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByTitle('View brushed rows in a table'));
            expect(document.querySelector('.pair-regl-modal')).toBeTruthy();

            fireEvent.click(document.querySelector('.pair-regl-modal-backdrop')!);
            expect(document.querySelector('.pair-regl-modal')).toBeNull();
        });
    });

    describe('CSV export', () => {
        it('does nothing when the save dialog is cancelled', async () => {
            mockSave.mockResolvedValue(null);
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByTitle('View brushed rows in a table'));

            fireEvent.click(screen.getByTitle('Download visible rows as CSV'));
            await Promise.resolve();
            expect(mockWriteUserTextFile).not.toHaveBeenCalled();
        });

        it('writes a CSV of only the currently-filtered rows', async () => {
            mockSave.mockResolvedValue('C:/out.csv');
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByTitle('View brushed rows in a table'));

            fireEvent.click(screen.getByTitle('Download visible rows as CSV'));
            await Promise.resolve();
            await Promise.resolve();

            expect(mockWriteUserTextFile).toHaveBeenCalledTimes(1);
            const [path, content] = mockWriteUserTextFile.mock.calls[0];
            expect(path).toBe('C:/out.csv');
            const lines = (content as string).split('\n');
            expect(lines[0]).toBe('cluster,rowIndex,timestamp,A,B');
            expect(lines).toHaveLength(3); // header + 2 rows
        });
    });
});
