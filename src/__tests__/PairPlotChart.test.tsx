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
    it('diagonal histogram and scatter cells derive their default colour from the same hex (regression: used to be two hardcoded near-duplicate blues)', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);

        // Diagonal histogram bars are real SVG rendered by PairPlotChart itself.
        const bar = document.querySelector('.pair-regl-cell-slot rect[fill="#6366f1"]');
        expect(bar).toBeTruthy();

        // Histogram cell background must be pure black, not --bg-primary
        // (regression: these used to be two different shades of near-black).
        const histCell = document.querySelector('.pair-regl-cell') as HTMLElement;
        expect(histCell.style.background).toBe('rgb(0, 0, 0)');

        // PairPlotCell is mocked above, so we can inspect the exact pointColor
        // prop it was given — should be #6366f1 converted to 0..1 RGBA, alpha 0.55.
        expect(cellCalls.length).toBeGreaterThan(0);
        const [r, g, b, a] = cellCalls[0].pointColor;
        expect(r).toBeCloseTo(0x63 / 255, 3);
        expect(g).toBeCloseTo(0x66 / 255, 3);
        expect(b).toBeCloseTo(0xf1 / 255, 3);
        expect(a).toBe(0.55);
    });

    describe('sensor-name labeling — outer frame only (top row + left column), not every cell', () => {
        it('scatter/time cells never render their own showXLabel/showYLabel — column headers are now a separate AxisLabel overlay PairPlotChart controls itself', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            expect(cellCalls.length).toBeGreaterThan(0);
            expect(cellCalls.every((c) => c.showXLabel === false)).toBe(true);
            expect(cellCalls.every((c) => c.showYLabel === false)).toBe(true);
        });

        it('the AxisLabel column header for sensor B shows exactly once, over the row-0 scatter cell', () => {
            const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            // Not-rotated (top orientation) spans only — the rotated (left/row
            // header) span for the same sensor is a separate, expected label,
            // covered by its own test below.
            const topLabelsForB = Array.from(container.querySelectorAll('.pair-regl-axis-label > span'))
                .filter((el) => el.textContent === 'B' && !(el as HTMLElement).style.transform);
            expect(topLabelsForB.length).toBe(1);
        });

        it('only the first row\'s diagonal shows its own sensor name — later rows rely on the row-0 column header instead', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            // Row 0's diagonal (sensor A) is the only diagonal cell that ever labels itself.
            expect(screen.getAllByText('A').length).toBeGreaterThanOrEqual(1);
            // Sensor B's diagonal is row 1 — no label there; B only appears via
            // the correlation cell's row header (asserted separately below).
        });

        it('the left-most correlation cell in a row shows the row header (sensorY only, never sensorX)', () => {
            const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            const rNode = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === '+1.00');
            // AxisLabel renders as a sibling of .pair-regl-cell (not nested
            // inside it) so its hover tooltip isn't clipped by .pair-regl-cell's
            // overflow:hidden — .pair-regl-cell-slot is their shared ancestor.
            const slot = rNode!.closest('.pair-regl-cell-slot') as HTMLElement;
            expect(slot.textContent).toContain('B'); // row header for row 1
            expect(slot.textContent).not.toContain('A'); // no column label on a correlation cell
        });

        describe('hover tooltip for sensor description (no legend strip — zero footprint until hovered)', () => {
            const sensorMetadata = [
                { tag: 'A', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
                { tag: 'B', description: '', unit: '', component: '' }, // known tag, blank description
            ];

            it('marks the top (column) label hoverable and renders its tooltip content when a description is known', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
                const topLabelWrap = Array.from(container.querySelectorAll('.pair-regl-axis-label'))
                    .find((el) => !!(el.querySelector('span') as HTMLElement | null)?.textContent && el.querySelector('span')!.textContent === 'A');
                expect(topLabelWrap!.className).toContain('hoverable');
                const tooltip = topLabelWrap!.querySelector('.pair-regl-axis-tooltip')!;
                expect(tooltip.querySelector('.pair-regl-axis-tooltip-tag')!.textContent).toBe('A');
                expect(tooltip.querySelector('.pair-regl-axis-tooltip-desc')!.textContent).toBe('Pump Pressure');
            });

            it('marks the left (row) label hoverable too, matched case-insensitively via normalizeSensorTag', () => {
                const mixedCaseMeta = [{ tag: 'a', description: 'Pump Pressure', unit: '', component: '' }];
                const { container } = render(<PairPlotChart data={data} sensors={['B', 'A']} headers={headers} sensorMetadata={mixedCaseMeta} />);
                // With sensors=['B','A'], row 1 (sensorY='A') is a correlation
                // cell's left header — its lookup must match the lowercase 'a'
                // in sensorMetadata against the uppercase 'A' sensor tag.
                const rotatedSpans = Array.from(container.querySelectorAll('.pair-regl-axis-label > span'))
                    .filter((el) => (el as HTMLElement).style.transform && el.textContent === 'A');
                expect(rotatedSpans.length).toBe(1);
                const wrap = rotatedSpans[0].closest('.pair-regl-axis-label')!;
                expect(wrap.className).toContain('hoverable');
            });

            it('does not mark a label hoverable when no description is known (blank description, or sensor missing from sensorMetadata entirely)', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
                // B has a metadata entry but an empty description string.
                const topLabelForB = Array.from(container.querySelectorAll('.pair-regl-axis-label'))
                    .find((el) => el.querySelector('span')?.textContent === 'B');
                expect(topLabelForB!.className).not.toContain('hoverable');
                expect(topLabelForB!.querySelector('.pair-regl-axis-tooltip')).toBeNull();
            });

            it('no label is hoverable when sensorMetadata is not provided at all', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                expect(container.querySelectorAll('.pair-regl-axis-label.hoverable').length).toBe(0);
                expect(container.querySelectorAll('.pair-regl-axis-tooltip').length).toBe(0);
            });

            it('the "Time" column header never gets a tooltip — it is not a real sensor tag', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
                const timeLabel = Array.from(container.querySelectorAll('.pair-regl-axis-label'))
                    .find((el) => el.querySelector('span')?.textContent === 'Time');
                expect(timeLabel).toBeTruthy();
                expect(timeLabel!.className).not.toContain('hoverable');
            });

            it('the tooltip bubble for both label orientations sits outside .pair-regl-cell (regression: .pair-regl-cell carries overflow:hidden for the chart canvas, and a tooltip nested inside it gets clipped/cut off for a long description)', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
                const tooltips = Array.from(container.querySelectorAll('.pair-regl-axis-tooltip'));
                expect(tooltips.length).toBeGreaterThan(0);
                for (const tooltip of tooltips) {
                    expect(tooltip.closest('.pair-regl-cell')).toBeNull();
                }
            });
        });

        it('the row header is not truncated for a long sensor tag (regression: was clipped to ~4 chars, e.g. "11TE1602.PV" rendered as "11TE1...")', () => {
            const longHeaders = ['11MOV1603.PV', '11TE1602.PV'];
            const longData = [
                { timestamp: 't0', values: [1, 10] },
                { timestamp: 't1', values: [2, 20] },
            ] as any;
            const { container } = render(<PairPlotChart data={longData} sensors={longHeaders} headers={longHeaders} />);
            // Two spans render this text: the (correctly-ellipsis-able) top/column
            // header on the row-0 scatter cell, and the rotated row-header span on
            // the correlation cell — only the rotated one must never truncate.
            const labelSpan = Array.from(container.querySelectorAll('span'))
                .find((el) => el.textContent === '11TE1602.PV' && !!(el as HTMLElement).style.transform);
            expect(labelSpan).toBeTruthy();
            // The old bug came from clipping the label's own box before rotation
            // (overflow:hidden + textOverflow:ellipsis on a 36px-wide container).
            expect(labelSpan!.style.overflow).not.toBe('hidden');
            expect(labelSpan!.style.textOverflow).not.toBe('ellipsis');
        });

        it('a correlation cell that is NOT the left-most in its row shows no label at all', () => {
            const headers3 = ['A', 'B', 'C'];
            const data3 = [
                { timestamp: 't0', values: [1, 10, 5] },
                { timestamp: 't1', values: [2, 20, 3] },
                { timestamp: 't2', values: [3, 30, 8] },
            ] as any;
            const { container } = render(<PairPlotChart data={data3} sensors={headers3} headers={headers3} />);

            // Row 2 (sensor C, gridRow 3) has two correlation cells:
            // gridColumn 1 (pair C-A, left-most → shows the row header "C")
            // gridColumn 2 (pair C-B, interior → must show no label at all).
            const slots = Array.from(container.querySelectorAll<HTMLElement>('.pair-regl-cell-slot'));
            const leftMost = slots.find((el) => el.style.gridRow === '3' && el.style.gridColumn === '1')!;
            const interior = slots.find((el) => el.style.gridRow === '3' && el.style.gridColumn === '2')!;

            expect(leftMost.textContent).toContain('C');
            // Interior cell shows only the r-value (e.g. "+0.87"), no sensor name.
            expect(interior.textContent).not.toContain('A');
            expect(interior.textContent).not.toContain('B');
            expect(interior.textContent).not.toContain('C');
        });
    });

    describe('lower-triangle correlation heatmap', () => {
        it('renders the Pearson r for the mirrored sensor pair (A/B here is a perfect +1 relationship)', () => {
            const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            // A = [1,2,3], B = [10,20,30] in the fixture above → r = +1.
            expect(container.textContent).toContain('+1.00');
        });

        it('shows "n/a" when a sensor pair has no defined correlation (constant series)', () => {
            const constData = [
                { timestamp: 't0', values: [5, 10] },
                { timestamp: 't1', values: [5, 20] },
                { timestamp: 't2', values: [5, 30] },
            ] as any;
            const { container } = render(<PairPlotChart data={constData} sensors={['A', 'B']} headers={headers} />);
            expect(container.textContent).toContain('n/a');
        });
    });

    describe('lasso / pan-zoom tool toggle', () => {
        it('defaults to lasso and propagates tool="lasso" to every child cell', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            const lassoBtn = screen.getByTitle('Lasso select — drag to draw a polygon, rows inside light up across every cell');
            expect(lassoBtn.getAttribute('aria-pressed')).toBe('true');
            expect(cellCalls.every((c) => c.tool === 'lasso')).toBe(true);
        });

        it('clicking the Pan/zoom button switches every child cell to tool="pan"', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            const panBtn = screen.getByTitle('Pan / zoom — drag to pan, scroll to zoom, without brushing a cluster');

            cellCalls.length = 0; // isolate calls made by the re-render this click triggers
            fireEvent.click(panBtn);

            expect(panBtn.getAttribute('aria-pressed')).toBe('true');
            expect(
                screen.getByTitle('Lasso select — drag to draw a polygon, rows inside light up across every cell').getAttribute('aria-pressed'),
            ).toBe('false');
            expect(cellCalls.length).toBeGreaterThan(0);
            expect(cellCalls.every((c) => c.tool === 'pan')).toBe(true);
        });

        it('switching back to lasso restores tool="lasso" on every child cell', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByTitle('Pan / zoom — drag to pan, scroll to zoom, without brushing a cluster'));

            cellCalls.length = 0;
            fireEvent.click(screen.getByTitle('Lasso select — drag to draw a polygon, rows inside light up across every cell'));

            expect(cellCalls.length).toBeGreaterThan(0);
            expect(cellCalls.every((c) => c.tool === 'lasso')).toBe(true);
        });
    });

    it('shows a placeholder with fewer than 2 sensors', () => {
        render(<PairPlotChart data={data} sensors={['A']} headers={headers} />);
        expect(screen.getByText('Select at least 2 sensors')).toBeTruthy();
    });

    it('shows a placeholder instead of rendering when the selection exceeds MAX_PAIR_PLOT_SENSORS (defense-in-depth against Dashboard\'s cap being bypassed)', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B', 'C', 'D', 'E']} headers={['A', 'B', 'C', 'D', 'E']} />);
        expect(screen.getByText(/Pair Plot supports at most 4 sensors/)).toBeTruthy();
        expect(screen.getByText(/5 selected/)).toBeTruthy();
        expect(cellCalls.length).toBe(0); // never mounted a single WebGL cell
    });

    it('renders normally at exactly the cap (4 sensors)', () => {
        const data4 = [
            { timestamp: 't0', values: [1, 10, 100, 1000] },
            { timestamp: 't1', values: [2, 20, 200, 2000] },
        ] as any;
        render(<PairPlotChart data={data4} sensors={['A', 'B', 'C', 'D']} headers={['A', 'B', 'C', 'D']} />);
        expect(screen.queryByText(/supports at most/)).toBeNull();
        expect(cellCalls.length).toBeGreaterThan(0);
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

    it('shows a hover tooltip with a plain formatted value for a non-time cell (regression: row id used to be shown too but is not user-meaningful, so it was dropped)', () => {
        const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('hover-A-B'));
        expect(container.querySelector('.scatter-regl-tooltip-title')).toBeNull();
        expect(screen.queryByText(/^Row /)).toBeNull();
        expect(screen.getByText('1.2346')).toBeTruthy();
        expect(screen.getByText('9.8765')).toBeTruthy();
    });

    it('shows a hover tooltip with a formatted date/time for a time-axis cell', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('hover-B-time'));
        expect(screen.queryByText(/^Row /)).toBeNull();
        // formatDateTime output for 2026-01-01T00:00:00Z will vary with local
        // TZ, so just check the date portion is present and no timestamp
        // duplicate row is shown for the time axis.
        expect(screen.getByText(/2026\/01\/01/)).toBeTruthy();
    });

    it('the hover tooltip clears z-index above the enlarged-view dialog (regression: tooltip used z-index 50, .pair-regl-expand-backdrop uses 150, so hovering inside the magnifier dialog reported data but rendered invisibly behind the modal)', () => {
        const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);

        // Open the magnifier and pick the A-B scatter cell to open the enlarged dialog.
        fireEvent.click(screen.getByTitle('Magnifier — click a cell to open an enlarged view'));
        const overlay = container.querySelector('.pair-regl-inspect-overlay') as HTMLElement;
        expect(overlay).toBeTruthy();
        fireEvent.click(overlay);
        expect(container.querySelector('.pair-regl-expand-modal')).toBeTruthy();

        // Hover inside the dialog's own (mocked) PairPlotCell — it shares the
        // same onHover={setHover} as the matrix, so this is the last
        // hover-A-B button rendered (the dialog's cell mounts after the matrix's).
        const hoverButtons = screen.getAllByText('hover-A-B');
        fireEvent.click(hoverButtons[hoverButtons.length - 1]);

        const tooltip = container.querySelector('.scatter-regl-tooltip') as HTMLElement;
        expect(tooltip).toBeTruthy();
        expect(Number(tooltip.style.zIndex)).toBeGreaterThan(150);
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
