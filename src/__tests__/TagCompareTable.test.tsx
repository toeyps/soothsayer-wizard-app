import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import TagCompareTable, { TagTableSlot, tagCell, type TagCompareRow } from '../components/charts/TagCompareTable';

const info = (tag: string, description = '', unit = '') => ({ tag, description, unit, component: '' });
const items = [
    { id: 'a', badge: '①', color: '#f59e0b', label: '2026/04/23 15:05:00' },
    { id: 'b', badge: '②', color: '#10b981', label: '2026/05/19 03:40:00' },
];
const rows: TagCompareRow[] = [
    // cells hold the NUMBER only; the unit is printed once per row, beside the sensor's name
    { key: 'T1', info: info('T1', 'Bearing temp', 'DEGC'), color: '#3b82f6', cells: ['83.300', '79.100'] },
    { key: 'F1', info: info('F1'), cells: ['1.927', '—'] },
];

describe('TagCompareTable (the values of the tagged points, under the chart)', () => {
    it('renders nothing while no point is tagged', () => {
        const { container } = render(<TagCompareTable items={[]} rows={rows} onRemove={vi.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    it('one column per tag (colour dot + date over time + its ×, no number), one row per sensor with its unit ONCE, the values in tag order', () => {
        render(<TagCompareTable items={items} rows={rows} onRemove={vi.fn()} />);
        const table = screen.getByTestId('tag-table');
        const heads = within(within(table).getByRole('list', { name: 'Tagged points' })).getAllByRole('listitem');
        expect(heads.map(h => h.textContent)).toEqual(['2026/04/23 15:05:00', '2026/05/19 03:40:00']);
        expect(heads.map(h => (h.querySelector('.chart-tag-dot') as HTMLElement).style.background)).toEqual(['rgb(245, 158, 11)', 'rgb(16, 185, 129)']);
        // a point's head: the date and the time on two lines (one readable stamp as text), under a rule in its colour
        expect(heads.map(h => [h.querySelector('.chart-tag-date')!.textContent, h.querySelector('.chart-tag-time')!.textContent]))
            .toEqual([['2026/04/23', '15:05:00'], ['2026/05/19', '03:40:00']]);
        expect(heads.map(h => (h as HTMLElement).style.getPropertyValue('--tag-c'))).toEqual(['#f59e0b', '#10b981']);
        // the unit sits once, at the end of the name cell; a sensor without a unit has none
        const names = within(table).getAllByTestId('tag-table-name');
        expect(names.map(n => n.textContent)).toEqual(['Bearing tempT1DEGC', 'F1']);
        expect(within(names[0]).getByTestId('tag-table-unit').textContent).toBe('DEGC');
        expect(within(names[1]).queryByTestId('tag-table-unit')).toBeNull();
        const vals = within(table).getAllByTestId('tag-table-val');
        expect(vals.map(v => v.textContent)).toEqual(['83.300', '79.100', '1.927', '—']);
        // A value cell says which sensor, which point and the value with its unit (hover / assistive tech).
        expect(vals[1].getAttribute('title')).toBe('Bearing temp · 2026/05/19 03:40:00 · 79.100 DEGC');
        expect(vals[2].getAttribute('title')).toBe('F1 · 2026/04/23 15:05:00'); // no unit: nothing to add
        // a missing value is dimmed and says why
        expect(vals[3].className).toBe('tag-table-val tag-table-val--none');
        expect(vals[3].getAttribute('title')).toBe('F1 · 2026/05/19 03:40:00 · no value at this point');
        expect(vals[0].className).toBe('tag-table-val');
        // one element per row (so a hover lights the whole row), each ending in the filler cell
        const rowEls = table.querySelectorAll('.tag-table-row');
        expect(rowEls).toHaveLength(2);
        expect([...rowEls].every(r => r.lastElementChild!.className === 'tag-table-fill')).toBe(true);
        expect(table.querySelector('.tag-table-fill--head')).toBeTruthy();
        // docked under the chart there is no count footer (that is the tab's)
        expect(within(table).queryByTestId('tag-table-foot')).toBeNull();
        // The count next to the title.
        expect(within(table).getByRole('button', { name: /Tagged points/ }).textContent).toContain('2');
    });

    it('the grid: a name column, one capped column per tag and a last column that takes the spare width (the band crosses the whole tab)', () => {
        const eight = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, badge: String(i + 1), color: '#fff', label: `time ${i}` }));
        const wide: TagCompareRow[] = [{ key: 'T1', info: info('T1'), cells: eight.map((_, i) => String(i)) }];
        const { container } = render(<TagCompareTable items={eight} rows={wide} onRemove={vi.fn()} />);
        const grid = container.querySelector('.tag-table-grid') as HTMLElement;
        expect(grid.style.gridTemplateColumns).toBe('minmax(220px, 400px) repeat(8, minmax(124px, 152px)) minmax(0, 1fr)');
        // corner + 8 heads + 1 name + 8 values
        expect(screen.getAllByTestId('tag-table-val')).toHaveLength(8);
    });

    it('the × on a column head removes that tag; a missing cell reads "—"', () => {
        const onRemove = vi.fn();
        const short: TagCompareRow[] = [{ key: 'T1', info: info('T1'), cells: ['1'] }]; // one cell fewer than tags
        render(<TagCompareTable items={items} rows={short} onRemove={onRemove} />);
        expect(screen.getAllByTestId('tag-table-val').map(v => v.textContent)).toEqual(['1', '—']);
        fireEvent.click(screen.getByRole('button', { name: 'Remove tag ② 2026/05/19 03:40:00' }));
        expect(onRemove).toHaveBeenCalledWith('b');
    });

    it('folds down to the head row and opens again', () => {
        render(<TagCompareTable items={items} rows={rows} onRemove={vi.fn()} />);
        const toggle = screen.getByRole('button', { name: /Tagged points/ });
        fireEvent.click(toggle);
        expect(screen.queryAllByTestId('tag-table-name')).toHaveLength(0);
        expect(screen.getAllByRole('listitem')).toHaveLength(2); // the tags stay
        fireEvent.click(toggle);
        expect(screen.getAllByTestId('tag-table-name')).toHaveLength(2);
    });

    it('TagTableSlot: under the chart when no place is offered, nothing while the tab is closed, INTO the tab when it is open', () => {
        const props = { items, rows, onRemove: vi.fn() };
        const a = render(<TagTableSlot {...props} />);
        expect(a.container.querySelector('[data-testid="tag-table"]')!.className).toBe('tag-table');
        a.unmount();

        const b = render(<TagTableSlot {...props} host={null} />);
        expect(b.container.firstChild).toBeNull();
        b.unmount();

        const host = document.createElement('div');
        document.body.appendChild(host);
        const cRender = render(<TagTableSlot {...props} host={host} />);
        expect(cRender.container.firstChild).toBeNull();
        const table = host.querySelector('[data-testid="tag-table"]') as HTMLElement;
        expect(table.className).toBe('tag-table tag-table--panel');
        // In the tab there is no fold button: the corner is a plain column title and the rows always show.
        expect(within(table).queryByRole('button', { name: /Tagged points/ })).toBeNull();
        expect(within(table).getByText('Sensor')).toBeTruthy();
        expect(within(table).getAllByTestId('tag-table-name')).toHaveLength(2);
        cRender.unmount();
        expect(host.childNodes).toHaveLength(0);
        host.remove();
    });

    it('in the tab: a count footer "N of 8 points"; at the limit it says why another click adds nothing', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const three = render(<TagTableSlot items={items} rows={rows} onRemove={vi.fn()} host={host} />);
        const foot = within(host).getByTestId('tag-table-foot');
        expect(foot.textContent).toBe('2 of 8 points');
        three.unmount();
        const eight = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, badge: String(i + 1), color: '#fff', label: `Point ${i + 1}` }));
        const full = render(<TagTableSlot items={eight} rows={[{ key: 'T1', info: info('T1'), cells: eight.map(() => '1') }]} onRemove={vi.fn()} host={host} />);
        expect(within(host).getByTestId('tag-table-foot').textContent).toBe('8 of 8 points · the chart holds 8 at most — remove one to tag another');
        // a label that is not a date and time stays one line
        const head = within(host).getAllByRole('listitem')[2];
        expect(head.querySelector('.chart-tag-date')).toBeNull();
        expect(head.querySelector('.chart-tag-time')!.textContent).toBe('Point 3');
        full.unmount();
        host.remove();
    });

    it('tagCell: the number text alone, or "—" when there is no value (the unit is the row\'s, not the cell\'s)', () => {
        expect(tagCell('1.927')).toBe('1.927');
        expect(tagCell('52.000')).toBe('52.000');
        expect(tagCell(null)).toBe('—');
    });
});
