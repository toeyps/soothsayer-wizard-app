import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';
import { act, render, screen, fireEvent } from '@testing-library/react';
import SensorExplorer from '../components/windows/SensorExplorer';
import type { SensorMetadata } from '../types';
import { longName, restoreNames, stubNamesCut, stubNamesCutWhere, stubNamesFit } from './helpers/nameGeometry';
import { captureResizeObservers, setLineHeight } from './helpers/windowedLines';

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof SensorExplorer>> = {}) {
    return {
        sensors: ['TAG1', 'TAG2', 'TAG3'],
        sensorMetadata,
        selectedSensors: [] as string[],
        onToggleSensor: vi.fn(),
        searchTerm: '',
        onSearchChange: vi.fn(),
        ...overrides,
    };
}

describe('SensorExplorer', () => {
    it('groups mapped sensors by component and lists unmapped sensors separately', () => {
        render(<SensorExplorer {...makeProps()} />);
        expect(screen.getByText('Pump')).toBeTruthy();
        expect(screen.getByText('2')).toBeTruthy(); // Pump group count
        // TAG3 has no metadata -> rendered directly under root, shown by its raw tag.
        expect(screen.getByText('TAG3')).toBeTruthy();
    });

    it('component groups start collapsed until clicked open', () => {
        render(<SensorExplorer {...makeProps()} />);
        expect(screen.queryByText('Pump Pressure')).toBeNull();
        fireEvent.click(screen.getByText('Pump'));
        expect(screen.getByText('Pump Pressure')).toBeTruthy();
        expect(screen.getByText('Pump Temp')).toBeTruthy();
    });

    it('re-clicking an opened component group collapses it again, without affecting ungrouped sensors', () => {
        render(<SensorExplorer {...makeProps()} />);
        fireEvent.click(screen.getByText('Pump')); // open
        fireEvent.click(screen.getByText('Pump')); // close
        expect(screen.queryByText('Pump Pressure')).toBeNull();
        expect(screen.getByText('TAG3')).toBeTruthy(); // ungrouped sensor unaffected
    });

    it('clicking a sensor row calls onToggleSensor with its tag', () => {
        const onToggleSensor = vi.fn();
        render(<SensorExplorer {...makeProps({ onToggleSensor })} />);
        fireEvent.click(screen.getByText('Pump'));
        fireEvent.click(screen.getByText('Pump Pressure'));
        expect(onToggleSensor).toHaveBeenCalledWith('TAG1');
    });

    // A click PICKS the row for Quick build — a "Picked" pill
    // (was "Added" while rows were sources), a + icon otherwise; the group header counts picks.
    it('shows a "Picked" pill for a picked sensor and a + icon for one that is not; the group counts the picks', () => {
        render(<SensorExplorer {...makeProps({ selectedSensors: ['TAG1'] })} />);
        fireEvent.click(screen.getByText('Pump'));
        const tag1Row = screen.getByText('Pump Pressure').closest('.special-sensor-row')!;
        expect(tag1Row.querySelector('.special-sensor-added-pill')?.textContent).toContain('Picked');
        expect(tag1Row.classList.contains('is-picked')).toBe(true);
        expect(tag1Row.querySelector('.special-sensor-add-icon')).toBeNull();

        const tag2Row = screen.getByText('Pump Temp').closest('.special-sensor-row')!;
        expect(tag2Row.querySelector('.special-sensor-added-pill')).toBeNull();
        expect(tag2Row.querySelector('.special-sensor-add-icon')).toBeTruthy();
        expect(screen.getByText('Pump').parentElement!.textContent).toContain('1 / 2');
    });

    it('the `$` button inserts the sensor at the caret instead of picking the row', () => {
        const onToggleSensor = vi.fn();
        const onInsertSensor = vi.fn();
        render(<SensorExplorer {...makeProps({ onToggleSensor, onInsertSensor })} />);
        fireEvent.click(screen.getByLabelText('Insert TAG3 in the formula'));
        expect(onInsertSensor).toHaveBeenCalledWith('TAG3');
        expect(onToggleSensor).not.toHaveBeenCalled();
    });

    it('without an insert handler there is no `$` button', () => {
        render(<SensorExplorer {...makeProps()} />);
        expect(screen.queryByLabelText('Insert TAG3 in the formula')).toBeNull();
    });

    it('falls back to the raw tag for a sensor with no metadata', () => {
        render(<SensorExplorer {...makeProps()} />);
        expect(screen.getByText('TAG3')).toBeTruthy();
        expect(screen.queryByText('undefined')).toBeNull();
    });

    // Explorer rows are the stacked SensorLabel.
    it('rows are the stacked SensorLabel (description + unit chip, tag on line 2); a tag with no description stands alone', () => {
        render(<SensorExplorer {...makeProps()} />);
        fireEvent.click(screen.getByText('Pump'));
        const label = screen.getByText('Pump Pressure').closest('.sl') as HTMLElement;
        expect(label.querySelector('.sl-unit')?.textContent).toBe('bar');
        expect(label.querySelector('.sl-tag')?.textContent).toBe('TAG1');
        expect(label.getAttribute('title')).toBe('Pump Pressure · TAG1 · bar · Pump');
        const bare = screen.getByText('TAG3').closest('.sl') as HTMLElement;
        expect(bare.textContent).toBe('TAG3');
        expect(screen.getByPlaceholderText('Search description, tag, unit or component…')).toBeTruthy();
    });

    it('typing in the search box calls onSearchChange', () => {
        const onSearchChange = vi.fn();
        render(<SensorExplorer {...makeProps({ onSearchChange })} />);
        fireEvent.change(screen.getByPlaceholderText('Search description, tag, unit or component…'), { target: { value: 'pump' } });
        expect(onSearchChange).toHaveBeenCalledWith('pump');
    });

    it('reflects the controlled searchTerm value in the input', () => {
        render(<SensorExplorer {...makeProps({ searchTerm: 'abc' })} />);
        expect((screen.getByPlaceholderText('Search description, tag, unit or component…') as HTMLInputElement).value).toBe('abc');
    });
});

describe('SensorExplorer: long sensor names', () => {
    afterEach(() => { restoreNames(); vi.unstubAllGlobals(); });
    const many = (n: number) => Array.from({ length: n }, (_, i) => `LONG_${i}`);

    it('a short list renders every row in the normal flow, with no window', () => {
        render(<SensorExplorer {...makeProps()} />);
        fireEvent.click(screen.getByText('Pump'));
        expect(screen.queryByTestId('explorer-window')).toBeNull();
        expect(document.querySelectorAll('.special-sensor-row')).toHaveLength(3);
    });

    it('a run of long names is a set: while cut, its start prints once and the rows print the rest', () => {
        stubNamesCut();
        const meta: SensorMetadata[] = [1, 2].map(n => ({ tag: `T${n}`, description: longName(n), unit: '', component: 'Crosshead' }));
        render(<SensorExplorer {...makeProps({ sensors: ['T1', 'T2'], sensorMetadata: meta })} />);
        fireEvent.click(screen.getByText('Crosshead'));
        expect(screen.getAllByTestId('explorer-run-prefix')).toHaveLength(1);
        expect(screen.getByTestId('explorer-run-prefix').getAttribute('title')).toContain('Crosshead (P-P Trend) - Vibration crosshead slide 11A');
        const names = [...document.querySelectorAll('.special-sensor-row .sl-desc')].map(e => e.textContent!.replace(/ /g, ' '));
        expect(names).toEqual(['SegmentNo 1 - avg', 'SegmentNo 2 - avg']);
        expect(screen.getByTestId('explorer-run-prefix').textContent).not.toContain('…');
    });

    it('tag-only sensors with no component are a set too', () => {
        stubNamesCut();
        render(<SensorExplorer {...makeProps({ sensors: [longName(1), longName(2)], sensorMetadata: null })} />);
        expect(screen.getByTestId('explorer-run-prefix').getAttribute('title')).toContain('Crosshead (P-P Trend)');
        expect(document.querySelector('.special-sensor-row .sl-desc')!.textContent!.replace(/ /g, ' ')).toBe('SegmentNo 1 - avg');
    });

    /** The reviewer's case: 320 px pane, a name has ~174 px. A row measures as cut only when its own text is too wide,
     *  so a row printing the short rest fits, unlike the everything-is-cut stub. */
    const stubPane320 = () => {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 174 });
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
            configurable: true,
            get(this: HTMLElement) { return (this.textContent ?? '').length * 6.2; },
        });
    };
    /** Scrolls the windowed list from end to end, collecting every row's printed name. */
    const scrollAll = () => {
        const list = document.querySelector('.special-sensor-explorer-list') as HTMLElement;
        const seen = new Map<string, string>();
        const read = () => document.querySelectorAll<HTMLElement>('.special-sensor-row').forEach(r => {
            seen.set(r.querySelector('[title]')!.getAttribute('title')!, r.querySelector('.sl-desc')!.textContent!);
        });
        const height = parseFloat(screen.getByTestId('explorer-window').style.height);
        for (let top = 0; top <= height; top += 1200) {
            Object.defineProperty(list, 'scrollTop', { configurable: true, value: top });
            fireEvent.scroll(list);
            read();
        }
        return seen;
    };
    const ends = ['avg', 'max', 'min'];

    it('594 rows that share a start, 320 px pane: rendered at a real width, every row reads differently and the start prints once', () => {
        stubPane320();
        const meta: SensorMetadata[] = Array.from({ length: 594 }, (_, i) => ({
            tag: `T${i}`, description: longName(Math.floor(i / 3) + 1, ends[i % 3]), unit: 'mm/s', component: 'Crosshead',
        }));
        render(<SensorExplorer {...makeProps({ sensors: meta.map(m => m.tag), sensorMetadata: meta })} />);
        fireEvent.click(screen.getByText('Crosshead'));
        // Not through a width of 0, where nothing is ever measured and every row reads whole.
        const firstName = document.querySelector('.special-sensor-row .sl-desc') as HTMLElement;
        expect(firstName.clientWidth).toBeGreaterThan(0);
        expect(screen.getByTestId('explorer-window')).toBeTruthy();
        expect(screen.getAllByTestId('explorer-run-prefix')).toHaveLength(1);
        const printed = [...scrollAll().values()];
        expect(printed).toHaveLength(594);
        expect(new Set(printed).size).toBe(594);
        for (const text of printed) {
            expect(text).not.toContain('Crosshead');
            // What the line clamp would keep: all of it, on one line of the pane.
            expect(text.length * 6.2).toBeLessThanOrEqual(174);
        }
    }, 30000);

    it('a group holding several families, so with no start of its own: each run still prints its start once', () => {
        stubPane320();
        const family = (slide: string, n: number) => `Crosshead (P-P Trend) - Vibration crosshead slide ${slide} - Segment No ${n} - avg`;
        const meta: SensorMetadata[] = [
            { tag: 'SP', description: 'Crosshead spread', unit: '', component: 'Crosshead' },
            { tag: 'FR', description: 'Frame (RMS Trend) - Vibration frame foot 16A - SegmentNo 9 - max', unit: '', component: 'Crosshead' },
            ...[1, 2, 3].map(n => ({ tag: `A${n}`, description: family('11A', n), unit: '', component: 'Crosshead' })),
            ...[1, 2, 3].map(n => ({ tag: `B${n}`, description: family('11B', n), unit: '', component: 'Crosshead' })),
        ];
        render(<SensorExplorer {...makeProps({ sensors: meta.map(m => m.tag), sensorMetadata: meta })} />);
        fireEvent.click(screen.getByText('Crosshead'));
        expect(screen.getAllByTestId('explorer-run-prefix').map(e => e.getAttribute('title'))).toEqual([
            expect.stringContaining('slide 11A'),
            expect.stringContaining('slide 11B'),
        ]);
        const names = [...document.querySelectorAll('.special-sensor-row .sl-desc')].map(e => e.textContent);
        expect(names.filter(n => n === 'Segment No 1 - avg')).toHaveLength(2);
        expect(names.filter(n => n?.includes('Crosshead (P-P'))).toHaveLength(0);
    });

    it('a name that still does not fit on one line wraps with its tag line under it, and the row stays one element', () => {
        stubNamesCut();
        const meta: SensorMetadata[] = [{ tag: 'U8-X', description: 'Condensate extraction pump B - Motor bearing NDE temperature', unit: 'DEGC', component: 'Pump' }];
        render(<SensorExplorer {...makeProps({ sensors: ['U8-X'], sensorMetadata: meta })} />);
        fireEvent.click(screen.getByText('Pump'));
        const label = document.querySelector('.special-sensor-row .sl')!;
        expect(label.querySelector('.sl-desc')!.className).toContain('sl-wrapname');
        expect(label.querySelector('.sl-tag')!.textContent).toBe('U8-X');
    });

    describe('the sticky line of a windowed list', () => {
        const scrollTo = (top: number) => {
            const list = document.querySelector('.special-sensor-explorer-list') as HTMLElement;
            Object.defineProperty(list, 'scrollTop', { configurable: true, value: top });
            fireEvent.scroll(list);
        };
        const rowsOf = (component: string, n: number): SensorMetadata[] =>
            Array.from({ length: n }, (_, i) => ({ tag: `${component}${i}`, description: longName(i), unit: '', component }));

        it('names the component (and the run, while it is cut) once its header has scrolled away', () => {
            stubNamesCut();
            const meta = rowsOf('Crosshead', 400);
            render(<SensorExplorer {...makeProps({ sensors: meta.map(m => m.tag), sensorMetadata: meta })} />);
            fireEvent.click(screen.getByText('Crosshead'));
            expect(screen.queryByTestId('explorer-sticky')).toBeNull();
            scrollTo(46 * 100);
            const sticky = screen.getByTestId('explorer-sticky');
            expect(sticky.querySelector('b')!.textContent).toBe('Crosshead');
            expect(sticky.textContent).toContain('slide 11A');
        });

        it('names the right component past the second group, and a run with no cut prints no start', () => {
            stubNamesFit();
            const meta = [...rowsOf('Crosshead', 200), ...rowsOf('Frame', 200)];
            render(<SensorExplorer {...makeProps({ sensors: meta.map(m => m.tag), sensorMetadata: meta })} />);
            fireEvent.click(screen.getByText('Frame'));
            fireEvent.click(screen.getByText('Crosshead'));
            scrollTo(46 * 300);
            const sticky = screen.getByTestId('explorer-sticky');
            expect(sticky.textContent).toBe('Frame');
        });

        it('a plain list has none', () => {
            render(<SensorExplorer {...makeProps()} />);
            fireEvent.click(screen.getByText('Pump'));
            expect(document.querySelector('.special-sensor-stick')).toBeNull();
        });

        it('is opaque, 30 px high, with a 1 px bottom border', () => {
            const rule = /\.special-sensor-sticky \{[^}]*\}/.exec(readFileSync('src/App.css', 'utf8') as string)![0];
            expect(rule).toMatch(/height: 30px/);
            expect(rule).toMatch(/background: var\(--card-bg\)/);
            expect(rule).toMatch(/border-bottom: 1px solid var\(--border\)/);
        });
    });

    it('over 150 lines only the lines in view are rendered, and scrolling moves them', () => {
        const sensors = many(4000);
        render(<SensorExplorer {...makeProps({ sensors, sensorMetadata: null })} />);
        expect(screen.getByTestId('explorer-window')).toBeTruthy();
        const first = document.querySelectorAll('.special-sensor-row');
        expect(first.length).toBeGreaterThan(0);
        expect(first.length).toBeLessThan(100);
        expect(screen.getByText('LONG_0')).toBeTruthy();
        const list = document.querySelector('.special-sensor-explorer-list') as HTMLElement;
        Object.defineProperty(list, 'scrollTop', { configurable: true, value: 46 * 2000 });
        fireEvent.scroll(list);
        expect(screen.queryByText('LONG_0')).toBeNull();
        expect(screen.getByText('LONG_2000')).toBeTruthy();
        expect(document.querySelectorAll('.special-sensor-row').length).toBeLessThan(100);
    });

    const group = (n: number, component = 'Crosshead'): SensorMetadata[] =>
        Array.from({ length: n }, (_, i) => ({ tag: `${component}${i}`, description: longName(i), unit: '', component }));
    const openAndRows = (meta: SensorMetadata[], component = 'Crosshead') => {
        render(<SensorExplorer {...makeProps({ sensors: meta.map(m => m.tag), sensorMetadata: meta })} />);
        fireEvent.click(screen.getByText(component));
        return [...document.querySelectorAll<HTMLElement>('.special-sensor-row')];
    };

    it.each([[100, 'a plain list'], [400, 'a windowed list']])('%i lines (%s): the run is one set, and ONE row that is cut marks every row of it', (n) => {
        // Only "SegmentNo 1 " measures as cut: without one shared run the other rows would print whole.
        stubNamesCutWhere(el => (el.dataset.nameFull ?? '').includes('SegmentNo 1 -'));
        const rows = openAndRows(group(n));
        const runs = rows.map(r => r.querySelector('[data-name-run]')!.getAttribute('data-name-run'));
        expect(new Set(runs).size).toBe(1);
        expect(runs[0]).toBeTruthy();
        expect(rows.length).toBeGreaterThan(1);
        expect(screen.getAllByTestId('explorer-run-prefix')).toHaveLength(1);
        for (const row of rows) {
            expect(row.querySelector('.sl-desc')!.textContent!.replace(/ /g, ' ')).toMatch(/^SegmentNo \d+ - avg$/);
        }
        // No provider per row: no measuring element per row.
        expect(document.querySelector('i[hidden]')).toBeNull();
        expect(!!screen.queryByTestId('explorer-window')).toBe(n > 150);
    });

    it('a cut in one group leaves another group whole', () => {
        stubNamesCutWhere(el => (el.dataset.nameFull ?? '').includes('slide 11A'));
        const other: SensorMetadata[] = [1, 2].map(n => ({ tag: `V${n}`, description: `Valve (Inlet Line) - Actuator position sensor unit - Channel ${n} - avg`, unit: '', component: 'Valve' }));
        const meta = [...group(3), ...other];
        render(<SensorExplorer {...makeProps({ sensors: meta.map(m => m.tag), sensorMetadata: meta })} />);
        fireEvent.click(screen.getByText('Crosshead'));
        fireEvent.click(screen.getByText('Valve'));
        expect(screen.getAllByTestId('explorer-run-prefix')).toHaveLength(1);
        expect(screen.getByText(other[0].description!)).toBeTruthy();
    });

    it('measured and fits: rows print whole, with no shared start, over 150 lines too', () => {
        stubNamesFit();
        const rows = openAndRows(group(400));
        expect(rows[0].querySelector('[data-name-run]')).toBeTruthy();
        expect(screen.queryByTestId('explorer-run-prefix')).toBeNull();
        expect(document.querySelector('[data-name-part]')).toBeNull();
        expect(screen.getByText(longName(0))).toBeTruthy();
    });

    it('a search that changes the names starts the set over: whole names until measured as cut again', () => {
        stubNamesCut();
        const meta = group(3);
        const { rerender } = render(<SensorExplorer {...makeProps({ sensors: meta.map(m => m.tag), sensorMetadata: meta, searchTerm: '' })} />);
        fireEvent.click(screen.getByText('Crosshead'));
        expect(screen.getAllByTestId('explorer-run-prefix')).toHaveLength(1);
        restoreNames();
        stubNamesFit();
        rerender(<SensorExplorer {...makeProps({ sensors: meta.slice(0, 2).map(m => m.tag), sensorMetadata: meta, searchTerm: 'a' })} />);
        expect(screen.queryByTestId('explorer-run-prefix')).toBeNull();
        expect(screen.getByText(longName(0))).toBeTruthy();
    });

    it('wheeling up after a scrollbar drag: a line above the view that gets its real height does not make the list jump', () => {
        const observers = captureResizeObservers();
        render(<SensorExplorer {...makeProps({ sensors: many(4000), sensorMetadata: null })} />);
        const list = document.querySelector('.special-sensor-explorer-list') as HTMLElement;
        list.scrollTop = 46 * 2000;
        fireEvent.scroll(list);
        const above = screen.getByText('LONG_1998').closest('.special-sensor-line') as HTMLElement;
        setLineHeight(above, 46 + 30);
        act(() => observers.fire());
        expect(list.scrollTop).toBe(46 * 2000 + 30);
        expect((screen.getByText('LONG_2000').closest('.special-sensor-line') as HTMLElement).style.top).toBe(`${46 * 2000 + 30}px`);
    });
});
