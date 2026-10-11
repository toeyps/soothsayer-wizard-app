import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';

/** Render count of the legend's ColourPicker swatches — the legend's only
 *  children that render on every legend render, so "the legend did not
 *  re-render" = this count did not move. */
let colourPickerRenders = 0;
vi.mock('../components/sensor/ColourPicker', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../components/sensor/ColourPicker')>();
    const { createElement } = await import('react');
    return {
        ...actual,
        default: (props: Parameters<typeof actual.default>[0]) => {
            colourPickerRenders++;
            return createElement(actual.default, props);
        },
    };
});

const cellCalls: any[] = [];
// memo'd like the real PairPlotCell, so "does this re-render the WebGL cells?" is observable.
vi.mock('../components/charts/PairPlotCell', async () => {
  const React = await import('react');
  // Mirrors the real cell's zoom contract: reports under its own per-instance
  // useId, and a bumped resetTick reports "not zoomed" under that same id.
  return {
    default: React.memo((props: any) => {
        cellCalls.push(props);
        const id = React.useId();
        const lastTick = React.useRef(props.resetTick);
        React.useEffect(() => {
            if (props.resetTick > lastTick.current) {
                lastTick.current = props.resetTick;
                props.onZoomChange?.(id, false);
            }
        }, [props.resetTick]);
        React.useEffect(() => () => props.onZoomChange?.(id, false), []);
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
                <button onClick={() => props.onZoomChange?.(id, true)}>{`zoom-${key}`}</button>
                <button onClick={() => props.onZoomChange?.(id, false)}>{`unzoom-${key}`}</button>
            </div>
        );
    }),
  };
});

class MockResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
}

import PairPlotChart from '../components/charts/PairPlotChart';
import ClusterLegend from '../components/charts/ClusterLegend';
import { hexToRgba } from '../components/charts/pairPlotColors';

const RESET_TITLE = 'Reset zoom and pan — every cell back to its full data range (clusters stay)';
const IDLE_TITLE = 'Nothing to reset — zoom (scroll) or pan a cell first';

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
    // Regression guard: Pair Plot deliberately does not read the Highlights
    // tab's timeHighlights at all (see ChartTypes.ts / Dashboard.tsx for
    // why) -- it never receives the prop from Chart.tsx and none of its
    // cells accept it.
    it('never forwards a timeHighlights prop to PairPlotCell', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(cellCalls.length).toBeGreaterThan(0);
        for (const call of cellCalls) {
            expect(call.timeHighlights).toBeUndefined();
        }
    });

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

            // At rest the tag alone (mono, dotted underline); the
            // hover / focus card is the stacked label (description, unit chip, tag) + a component chip.
            it('marks the top (column) label hoverable; its card is the stacked label + unit + component chip', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
                const topLabelWrap = Array.from(container.querySelectorAll('.pair-regl-axis-label'))
                    .find((el) => el.querySelector('.pair-regl-axis-tag')?.textContent === 'A') as HTMLElement;
                expect(topLabelWrap.className).toContain('hoverable');
                expect(topLabelWrap.tabIndex).toBe(0); // focus shows the card too
                // Focusable with an aria-label → it carries a role.
                expect(topLabelWrap.getAttribute('role')).toBe('group');
                expect(topLabelWrap.getAttribute('aria-label')).toBe('Pump Pressure · A · bar · Pump');
                const tooltip = topLabelWrap.querySelector('.pair-regl-axis-tooltip')!;
                expect(tooltip.querySelector('.sl-desc')!.textContent).toBe('Pump Pressure');
                expect(tooltip.querySelector('.sl-unit')!.textContent).toBe('bar');
                expect(tooltip.querySelector('.sl-tag')!.textContent).toBe('A');
                expect(tooltip.querySelector('.comp-chip')!.textContent).toBe('Pump');
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

            it('does not mark a label hoverable when nothing beyond the tag is known (blank description / unit / component, or sensor missing from sensorMetadata entirely)', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} sensorMetadata={sensorMetadata} />);
                // B has a metadata entry but an empty description string.
                const topLabelForB = Array.from(container.querySelectorAll('.pair-regl-axis-label'))
                    .find((el) => el.querySelector('span')?.textContent === 'B');
                expect(topLabelForB!.className).not.toContain('hoverable');
                expect(topLabelForB!.getAttribute('role')).toBeNull();
                expect(topLabelForB!.hasAttribute('tabindex')).toBe(false);
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

    describe('cluster legend (customer batch phase 2) — chips above the matrix', () => {
        const swatchBg = (name: string, i = 0) =>
            (screen.getAllByRole('button', { name: `Cluster colour: ${name}` })[i].querySelector('.cp-swatch') as HTMLElement).style.background;
        const nameBtn = (name: string) => screen.getByRole('button', { name: `${name}, rename` });
        const chipNames = (root: ParentNode = document) =>
            Array.from(root.querySelectorAll('.pp-legend-top .pp-chip-name')).map(el => el.textContent);

        it('renders nothing before the first lasso', () => {
            const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            expect(container.querySelector('.pp-legend')).toBeNull();
        });

        it('a completed lasso adds a chip in the strip above the matrix: ColourPicker swatch (first palette colour) + name + ×, no row count', () => {
            const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));

            const legend = container.querySelector('.pp-legend.pp-legend-top') as HTMLElement;
            expect(legend).toBeTruthy();
            expect(legend.closest('.pair-regl-grid')).toBeNull(); // never inside (over) the matrix
            expect(within(legend).getByRole('list', { name: 'Clusters' })).toBeTruthy();
            expect(chipNames()).toEqual(['Cluster 1']);
            // The default is the matching ColourPicker PALETTE swatch (amber #f59e0b).
            expect(swatchBg('Cluster 1')).toBe('rgb(245, 158, 11)');
            expect(within(legend).getByRole('button', { name: 'Remove Cluster 1' })).toBeTruthy();
            expect(document.querySelector('input[type="color"]')).toBeNull();
            expect(screen.queryByText(/rows/)).toBeNull(); // row counts are gone
        });

        it('the default colour is a palette swatch, so the picker opens with a check on it (not on "Custom colour")', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByRole('button', { name: 'Cluster colour: Cluster 1' }));
            const checked = document.querySelector('.cp-pop .cp-sw[aria-checked="true"]') as HTMLElement;
            expect(checked.getAttribute('data-colour')).toBe('#f59e0b');
            expect(document.querySelector('.cp-adv')).toBeNull(); // custom section stays folded
        });

        it('successive lassos take "Cluster 2" and the next unused palette colour (emerald)', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByText('lasso-B-time'));
            expect(chipNames()).toEqual(['Cluster 1', 'Cluster 2']);
            expect(swatchBg('Cluster 2')).toBe('rgb(16, 185, 129)');
        });

        it('"Clear" is hidden with one cluster and shown from two', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            expect(screen.queryByRole('button', { name: 'Clear all clusters' })).toBeNull();
            fireEvent.click(screen.getByText('lasso-B-time'));
            expect(screen.getByRole('button', { name: 'Clear all clusters' })).toBeTruthy();
        });

        it('× removes just that cluster; the next lasso reuses the freed name and colour', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByText('lasso-B-time'));
            fireEvent.click(screen.getByRole('button', { name: 'Remove Cluster 1' }));
            expect(chipNames()).toEqual(['Cluster 2']);

            fireEvent.click(screen.getByText('lasso-A-B'));
            expect(chipNames()).toEqual(['Cluster 2', 'Cluster 1']);
            expect(swatchBg('Cluster 1')).toBe('rgb(245, 158, 11)'); // amber is free again
        });

        it('Clear removes every cluster and the legend disappears', () => {
            const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByText('lasso-B-time'));
            cellCalls.length = 0;
            fireEvent.click(screen.getByRole('button', { name: 'Clear all clusters' }));
            expect(container.querySelector('.pp-legend')).toBeNull();
            expect(cellCalls.length).toBeGreaterThan(0);
            expect(cellCalls.every((c) => c.clusters.length === 0)).toBe(true);
        });

        it('toolbox ↺ resets the view only — clusters stay, every cell gets the bumped resetTick', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByText('zoom-A-B'));

            cellCalls.length = 0;
            fireEvent.click(screen.getByTitle(RESET_TITLE));

            expect(chipNames()).toEqual(['Cluster 1']);
            expect(cellCalls.length).toBeGreaterThan(0);
            expect(cellCalls.every((c) => c.resetTick === 1)).toBe(true);
            expect(cellCalls.every((c) => c.clusters.length === 1)).toBe(true);
        });

        it('recolouring from the ColourPicker palette updates the swatch and the cells; other clusters’ colours are marked in use', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByText('lasso-B-time'));
            fireEvent.click(screen.getByRole('button', { name: 'Cluster colour: Cluster 1' }));
            const sw = (hex: string) => document.querySelector(`.cp-pop .cp-sw[data-colour="${hex}"]`) as HTMLElement;
            expect(sw('#10b981').getAttribute('title')).toContain('in use on this chart'); // Cluster 2's emerald
            cellCalls.length = 0;
            fireEvent.click(sw('#f43f5e'));
            expect(swatchBg('Cluster 1')).toBe('rgb(244, 63, 94)');
            expect(cellCalls.length).toBeGreaterThan(0);
            const [r, g, b] = cellCalls[cellCalls.length - 1].clusters[0].color;
            expect([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]).toEqual([0xf4, 0x3f, 0x5e]);
        });

        it('picking the colour a cluster already has does not re-render the WebGL cells', () => {
            render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByRole('button', { name: 'Cluster colour: Cluster 1' }));
            cellCalls.length = 0;
            fireEvent.click(document.querySelector('.cp-pop .cp-sw[data-colour="#f59e0b"]') as HTMLElement);
            expect(cellCalls.length).toBe(0);
        });

        describe('rename in place', () => {
            const setup = () => {
                const utils = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByText('lasso-A-B'));
                return utils;
            };
            const field = () => screen.getByRole('textbox', { name: 'Rename Cluster 1' }) as HTMLInputElement;

            it('clicking the name turns it into a field with the whole text selected', () => {
                setup();
                fireEvent.click(nameBtn('Cluster 1'));
                const input = field();
                expect(document.activeElement).toBe(input);
                expect(input.value).toBe('Cluster 1');
                expect(input.selectionStart).toBe(0);
                expect(input.selectionEnd).toBe('Cluster 1'.length);
                expect(input.maxLength).toBe(40);
            });

            it('Enter saves the new name and focus returns to the name', () => {
                setup();
                fireEvent.click(nameBtn('Cluster 1'));
                fireEvent.change(field(), { target: { value: 'Pump trip' } });
                fireEvent.keyDown(field(), { key: 'Enter' });
                expect(chipNames()).toEqual(['Pump trip']);
                expect(document.activeElement).toBe(nameBtn('Pump trip'));
                // Every chip control follows the new name.
                expect(screen.getByRole('button', { name: 'Remove Pump trip' })).toBeTruthy();
                expect(screen.getByRole('button', { name: 'Cluster colour: Pump trip' })).toBeTruthy();
            });

            it('Esc cancels the edit and focus returns to the name', () => {
                setup();
                fireEvent.click(nameBtn('Cluster 1'));
                fireEvent.change(field(), { target: { value: 'Discarded' } });
                fireEvent.keyDown(field(), { key: 'Escape' });
                expect(chipNames()).toEqual(['Cluster 1']);
                expect(document.activeElement).toBe(nameBtn('Cluster 1'));
            });

            it('leaving the field (blur) saves', () => {
                setup();
                fireEvent.click(nameBtn('Cluster 1'));
                fireEvent.change(field(), { target: { value: 'Startup' } });
                fireEvent.blur(field());
                expect(chipNames()).toEqual(['Startup']);
            });

            it('an empty or whitespace-only name reverts to the old one', () => {
                setup();
                fireEvent.click(nameBtn('Cluster 1'));
                fireEvent.change(field(), { target: { value: '   ' } });
                fireEvent.keyDown(field(), { key: 'Enter' });
                expect(chipNames()).toEqual(['Cluster 1']);
            });

            it('trims the name and caps it at 40 characters', () => {
                setup();
                fireEvent.click(nameBtn('Cluster 1'));
                fireEvent.change(field(), { target: { value: `  ${'x'.repeat(50)}  ` } });
                fireEvent.keyDown(field(), { key: 'Enter' });
                expect(chipNames()).toEqual(['x'.repeat(40)]);
            });

            it('F2 or Enter on the focused name starts editing (keyboard path)', () => {
                setup();
                fireEvent.keyDown(nameBtn('Cluster 1'), { key: 'F2' });
                fireEvent.keyDown(field(), { key: 'Escape' });
                fireEvent.keyDown(nameBtn('Cluster 1'), { key: 'Enter' });
                expect(field()).toBeTruthy();
            });

            it('Enter/Esc inside the field do not bubble to listeners above (e.g. a dialog’s Esc)', () => {
                setup();
                const outer = vi.fn();
                document.addEventListener('keydown', outer);
                try {
                    fireEvent.click(nameBtn('Cluster 1'));
                    fireEvent.keyDown(field(), { key: 'Escape' });
                    expect(outer).not.toHaveBeenCalled();
                } finally {
                    document.removeEventListener('keydown', outer);
                }
            });

            it('renders a typed name as plain text (no HTML) and keeps the full name in title', () => {
                setup();
                const long = '<b>Cavitation</b> at low flow & high temp, pump B';
                fireEvent.click(nameBtn('Cluster 1'));
                fireEvent.change(field(), { target: { value: long } });
                fireEvent.keyDown(field(), { key: 'Enter' });
                const saved = long.slice(0, 40);
                const el = document.querySelector('.pp-legend-top .pp-chip-name') as HTMLElement;
                expect(el.textContent).toBe(saved);
                expect(el.querySelector('b')).toBeNull();
                expect(el.getAttribute('title')).toBe(`${saved} — click to rename`);
            });

            it('duplicate names are allowed', () => {
                render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByText('lasso-A-B'));
                fireEvent.click(screen.getByText('lasso-B-time'));
                fireEvent.click(nameBtn('Cluster 2'));
                const input = screen.getByRole('textbox', { name: 'Rename Cluster 2' });
                fireEvent.change(input, { target: { value: 'Cluster 1' } });
                fireEvent.keyDown(input, { key: 'Enter' });
                expect(chipNames()).toEqual(['Cluster 1', 'Cluster 1']);
            });

            it('a renamed cluster frees its number: the next lasso is "Cluster 1" with the first unused colour', () => {
                render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByText('lasso-A-B'));
                fireEvent.click(screen.getByText('lasso-B-time'));
                fireEvent.click(nameBtn('Cluster 1'));
                fireEvent.change(field(), { target: { value: 'Pump trip' } });
                fireEvent.keyDown(field(), { key: 'Enter' });

                fireEvent.click(screen.getByText('lasso-A-B'));
                expect(chipNames()).toEqual(['Pump trip', 'Cluster 2', 'Cluster 1']);
                expect(swatchBg('Cluster 1')).toBe('rgb(217, 70, 239)'); // amber + emerald in use → fuchsia
            });

            it('renaming does not re-render the WebGL cells (they never read the name)', () => {
                setup();
                cellCalls.length = 0;
                fireEvent.click(nameBtn('Cluster 1'));
                fireEvent.change(field(), { target: { value: 'Pump trip' } });
                fireEvent.keyDown(field(), { key: 'Enter' });
                expect(chipNames()).toEqual(['Pump trip']);
                expect(cellCalls.length).toBe(0);
            });
        });

        it('the chip row gets the right-edge fade class when it overflows', () => {
            const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
            Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, value: 900 });
            try {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByText('lasso-A-B'));
                expect(container.querySelector('.pp-legend-top .pp-legend-chips')!.className).toContain('is-overflow');
            } finally {
                if (orig) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', orig);
                else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
            }
        });

        it('no overflow fade when the chips fit', () => {
            const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            expect(container.querySelector('.pp-legend-top .pp-legend-chips')!.className).not.toContain('is-overflow');
        });

        describe('enlarged view', () => {
            const openEnlarged = (container: HTMLElement) => {
                fireEvent.click(screen.getByTitle('Magnifier — click a cell to open an enlarged view'));
                fireEvent.click(container.querySelector('.pair-regl-inspect-overlay') as HTMLElement);
                return container.querySelector('.pair-regl-expand-modal') as HTMLElement;
            };

            it('shows the hint text until there is a cluster, then the same chips in its footer, in sync with the strip', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                const modal = openEnlarged(container);
                const footer = modal.querySelector('.pair-regl-expand-footer') as HTMLElement;
                expect(footer.textContent).toContain('each lasso creates a new cluster');

                // Lasso inside the dialog's own cell (last rendered lasso-A-B).
                const lassos = screen.getAllByText('lasso-A-B');
                fireEvent.click(lassos[lassos.length - 1]);
                const footerNames = () => Array.from(footer.querySelectorAll('.pp-chip-name')).map(el => el.textContent);
                expect(footerNames()).toEqual(['Cluster 1']);
                expect(chipNames()).toEqual(['Cluster 1']);

                // Rename from the footer → the strip above the matrix follows.
                fireEvent.click(within(footer).getByRole('button', { name: 'Cluster 1, rename' }));
                const input = within(footer).getByRole('textbox', { name: 'Rename Cluster 1' });
                fireEvent.change(input, { target: { value: 'Surge' } });
                fireEvent.keyDown(input, { key: 'Enter' });
                expect(footerNames()).toEqual(['Surge']);
                expect(chipNames()).toEqual(['Surge']);

                // × in the footer removes it everywhere.
                fireEvent.click(within(footer).getByRole('button', { name: 'Remove Surge' }));
                expect(container.querySelector('.pp-legend')).toBeNull();
                expect(footer.textContent).toContain('each lasso creates a new cluster');
            });

            it('its ↺ also resets the view only', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByText('lasso-A-B'));
                const modal = openEnlarged(container);
                // A zoomed matrix cell (still mounted behind the dialog) arms the dialog's ↺ too.
                fireEvent.click(screen.getByText('zoom-A-B'));
                cellCalls.length = 0;
                fireEvent.click(within(modal).getByTitle(RESET_TITLE));
                expect(chipNames()).toEqual(['Cluster 1']);
                expect(cellCalls.some(c => c.resetTick === 1)).toBe(true);
            });
        });

        describe('review fixes', () => {
            it('Space on the focused name starts the rename (role=button) and is prevented, so the strip does not scroll', () => {
                render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByText('lasso-A-B'));
                const notPrevented = fireEvent.keyDown(nameBtn('Cluster 1'), { key: ' ' });
                expect(notPrevented).toBe(false);
                expect(screen.getByRole('textbox', { name: 'Rename Cluster 1' })).toBeTruthy();
            });

            it('Clear is announced as "Clear all clusters"', () => {
                render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByText('lasso-A-B'));
                fireEvent.click(screen.getByText('lasso-B-time'));
                const clear = screen.getByRole('button', { name: 'Clear all clusters' });
                expect(clear.textContent).toBe('Clear');
            });

            describe('save/cancel guards (legend on its own, with a spy)', () => {
                const one = [{ id: 'c-1', label: 'Cluster 1', color: hexToRgba('#f59e0b'), rowIndices: new Set([0]) }];
                const renderLegend = () => {
                    const onRename = vi.fn();
                    render(<ClusterLegend clusters={one} onRecolour={vi.fn()} onRename={onRename} onRemove={vi.fn()} onClear={vi.fn()} />);
                    fireEvent.click(screen.getByRole('button', { name: 'Cluster 1, rename' }));
                    const input = screen.getByRole('textbox', { name: 'Rename Cluster 1' });
                    fireEvent.change(input, { target: { value: 'Typed' } });
                    return { onRename, input };
                };

                // Both events in one act: the field is still mounted when the blur
                // arrives, as when a browser blurs the field it is removing.
                it('Esc then blur keeps the old name and saves nothing', () => {
                    const { onRename, input } = renderLegend();
                    act(() => {
                        fireEvent.keyDown(input, { key: 'Escape' });
                        fireEvent.blur(input);
                    });
                    expect(onRename).not.toHaveBeenCalled();
                    expect(screen.getByRole('button', { name: 'Cluster 1, rename' })).toBeTruthy();
                });

                it('Enter then blur saves exactly once', () => {
                    const { onRename, input } = renderLegend();
                    act(() => {
                        fireEvent.keyDown(input, { key: 'Enter' });
                        fireEvent.blur(input);
                    });
                    expect(onRename).toHaveBeenCalledTimes(1);
                    expect(onRename).toHaveBeenCalledWith('c-1', 'Typed');
                });
            });

            it('a hover move re-renders the chart but not the cluster legend (memoised)', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByText('lasso-A-B'));
                const before = colourPickerRenders;
                fireEvent.click(screen.getByText('hover-A-B'));
                expect(container.querySelector('.scatter-regl-tooltip')).toBeTruthy(); // the chart did re-render
                fireEvent.click(screen.getByText('hover-B-time'));
                expect(colourPickerRenders).toBe(before);
            });

            describe('focus after removing (never falls to <body>)', () => {
                const lassoTimes = (k: number) => {
                    for (let i = 0; i < k; i++) fireEvent.click(screen.getByText(i % 2 ? 'lasso-B-time' : 'lasso-A-B'));
                };
                const lassoTool = () => screen.getByTitle('Lasso select — drag to draw a polygon, rows inside light up across every cell');

                it('× on a middle chip → the next chip’s name', () => {
                    render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                    lassoTimes(3);
                    fireEvent.click(screen.getByRole('button', { name: 'Remove Cluster 2' }));
                    expect(document.activeElement).toBe(nameBtn('Cluster 3'));
                });

                it('× on the last chip → the previous chip’s name', () => {
                    render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                    lassoTimes(3);
                    fireEvent.click(screen.getByRole('button', { name: 'Remove Cluster 3' }));
                    expect(document.activeElement).toBe(nameBtn('Cluster 2'));
                });

                it('× on the only chip → the toolbox', () => {
                    render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                    lassoTimes(1);
                    fireEvent.click(screen.getByRole('button', { name: 'Remove Cluster 1' }));
                    expect(document.activeElement).toBe(lassoTool());
                });

                it('Clear → the toolbox', () => {
                    render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                    lassoTimes(2);
                    fireEvent.click(screen.getByRole('button', { name: 'Clear all clusters' }));
                    expect(document.activeElement).toBe(lassoTool());
                });

                it('in the enlarged view, × on the last footer chip and Clear in the footer → the enlarged view’s toolbox', () => {
                    const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                    lassoTimes(1);
                    fireEvent.click(screen.getByTitle('Magnifier — click a cell to open an enlarged view'));
                    fireEvent.click(container.querySelector('.pair-regl-inspect-overlay') as HTMLElement);
                    const modal = container.querySelector('.pair-regl-expand-modal') as HTMLElement;
                    const footer = modal.querySelector('.pair-regl-expand-footer') as HTMLElement;
                    // First control of the enlarged view's own toolbox (the first overlay is a
                    // diagonal cell, which has no lasso — its first tool is ↺).
                    const modalFirstTool = modal.querySelector('.pair-regl-expand-toolbox button') as HTMLElement;
                    expect(modalFirstTool).toBeTruthy();

                    fireEvent.click(within(footer).getByRole('button', { name: 'Remove Cluster 1' }));
                    expect(document.activeElement).toBe(modalFirstTool);
                    expect(footer.querySelector('.pp-legend')).toBeNull(); // footer legend gone, focus still inside the dialog

                    lassoTimes(2);
                    fireEvent.click(within(footer).getByRole('button', { name: 'Clear all clusters' }));
                    expect(document.activeElement).toBe(modalFirstTool);
                    expect(document.activeElement).not.toBe(document.body);
                });
            });

            it('the overflow fade is re-checked while the rename field is typed in', () => {
                const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
                fireEvent.click(screen.getByText('lasso-A-B'));
                const chips = () => container.querySelector('.pp-legend-top .pp-legend-chips')!;
                expect(chips().className).not.toContain('is-overflow');
                fireEvent.click(nameBtn('Cluster 1'));
                const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
                Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, value: 900 });
                try {
                    fireEvent.change(screen.getByRole('textbox', { name: 'Rename Cluster 1' }), { target: { value: 'A much longer name' } });
                    expect(chips().className).toContain('is-overflow');
                } finally {
                    if (orig) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', orig);
                    else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
                }
            });
        });

        it('View Table, the brushed-rows table and its CSV export are gone (SPEC §2 "Removed")', () => {
            const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
            fireEvent.click(screen.getByText('lasso-A-B'));
            fireEvent.click(screen.getByText('lasso-B-time'));
            expect(screen.queryByText('View Table')).toBeNull();
            expect(screen.queryByTitle(/View brushed rows/)).toBeNull();
            expect(screen.queryByTitle(/CSV/)).toBeNull();
            expect(screen.queryByTitle('Delete Cluster 1')).toBeNull(); // old trash button
            expect(container.querySelector('.pair-regl-cluster-panel, .pair-regl-modal, .pair-regl-modal-backdrop, table')).toBeNull();

            // Same inside the enlarged view.
            fireEvent.click(screen.getByTitle('Magnifier — click a cell to open an enlarged view'));
            fireEvent.click(container.querySelector('.pair-regl-inspect-overlay') as HTMLElement);
            expect(screen.queryByTitle(/View brushed rows/)).toBeNull();
            expect(container.querySelector('table')).toBeNull();
        });
    });

    it('shows a hover tooltip with a plain formatted value for a non-time cell (regression: row id used to be shown too but is not user-meaningful, so it was dropped)', () => {
        const { container } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('hover-A-B'));
        expect(container.querySelector('.scatter-regl-tooltip-title')).toBeNull();
        expect(screen.queryByText(/^Row /)).toBeNull();
        // Inline label + value (the one en-US formatter, up to 3 decimals).
        expect(screen.getByText('1.235')).toBeTruthy();
        expect(screen.getByText('9.877')).toBeTruthy();
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

});

// "the ↺ button does nothing". Besides the
// cell-side redraw fix (PairPlotCell.test.tsx), the button now says when it
// has nothing to undo instead of silently doing nothing.
describe('PairPlotChart — toolbox ↺ (reset zoom and pan)', () => {
    const resetBtn = () => screen.getAllByRole('button', { name: 'Reset zoom and pan' })[0];

    it('is inert with a "Nothing to reset" tooltip while no cell is zoomed or panned', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        const btn = resetBtn();
        expect(btn.getAttribute('aria-disabled')).toBe('true');
        expect(btn.getAttribute('title')).toBe(IDLE_TITLE);
        cellCalls.length = 0;
        fireEvent.click(btn);
        expect(cellCalls.every(c => c.resetTick === 0)).toBe(true);
    });

    it('becomes active once any cell reports a zoom/pan, and says exactly what it resets', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('zoom-B-time'));
        const btn = resetBtn();
        expect(btn.getAttribute('aria-disabled')).toBe('false');
        expect(btn.getAttribute('title')).toBe(RESET_TITLE);
    });

    it('goes back to "Nothing to reset" when every zoomed cell reports it is back at full range', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('zoom-A-B'));
        fireEvent.click(screen.getByText('zoom-B-time'));
        fireEvent.click(screen.getByText('unzoom-A-B'));
        expect(resetBtn().getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(screen.getByText('unzoom-B-time'));
        expect(resetBtn().getAttribute('aria-disabled')).toBe('true');
    });

    it('every cell gets the shared onZoomChange', () => {
        render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        expect(cellCalls.length).toBeGreaterThan(0);
        expect(cellCalls.every(c => typeof c.onZoomChange === 'function')).toBe(true);
    });

    it('does not get stuck enabled when a zoomed cell switches sensors (cells are keyed by index): zoom, swap sensors, reset -> "Nothing to reset"', () => {
        const { rerender } = render(<PairPlotChart data={data} sensors={['A', 'B']} headers={headers} />);
        fireEvent.click(screen.getByText('zoom-A-B'));
        expect(resetBtn().getAttribute('aria-disabled')).toBe('false');
        rerender(<PairPlotChart data={data} sensors={['B', 'A']} headers={headers} />);
        expect(resetBtn().getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(resetBtn());
        expect(resetBtn().getAttribute('aria-disabled')).toBe('true');
    });
});

