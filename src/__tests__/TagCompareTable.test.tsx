import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import TagCompareTable, { tagCell, type TagCompareRow } from '../components/charts/TagCompareTable';

const info = (tag: string, description = '', unit = '') => ({ tag, description, unit, component: '' });
const items = [
    { id: 'a', badge: '①', color: '#f59e0b', label: '2026/04/23 15:05:00' },
    { id: 'b', badge: '②', color: '#10b981', label: '2026/05/19 03:40:00' },
];
const rows: TagCompareRow[] = [
    { key: 'T1', info: info('T1', 'Bearing temp', 'DEGC'), color: '#3b82f6', cells: ['83.300 DEGC', '79.100 DEGC'] },
    { key: 'F1', info: info('F1'), cells: ['1.927', '—'] },
];

describe('TagCompareTable (the values of the tagged points, under the chart)', () => {
    it('renders nothing while no point is tagged', () => {
        const { container } = render(<TagCompareTable items={[]} rows={rows} onRemove={vi.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    it('one column per tag (badge + time + its ×), one row per sensor, the values in tag order', () => {
        render(<TagCompareTable items={items} rows={rows} onRemove={vi.fn()} />);
        const table = screen.getByTestId('tag-table');
        const heads = within(within(table).getByRole('list', { name: 'Tagged points' })).getAllByRole('listitem');
        expect(heads.map(h => h.textContent)).toEqual(['①2026/04/23 15:05:00', '②2026/05/19 03:40:00']);
        expect(within(table).getAllByTestId('tag-table-name').map(n => n.textContent)).toEqual(['Bearing tempT1', 'F1']);
        expect(within(table).getAllByTestId('tag-table-val').map(v => v.textContent)).toEqual(['83.300 DEGC', '79.100 DEGC', '1.927', '—']);
        // A value cell says which sensor and which tag it belongs to (hover / assistive tech).
        expect(within(table).getAllByTestId('tag-table-val')[1].getAttribute('title')).toBe('Bearing temp · ② 2026/05/19 03:40:00');
        // The count next to the title.
        expect(within(table).getByRole('button', { name: /Tagged points/ }).textContent).toContain('2');
    });

    it('the grid has one name column and one column per tag, so any number of tags never overlap (they scroll sideways)', () => {
        const eight = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, badge: String(i + 1), color: '#fff', label: `time ${i}` }));
        const wide: TagCompareRow[] = [{ key: 'T1', info: info('T1'), cells: eight.map((_, i) => String(i)) }];
        const { container } = render(<TagCompareTable items={eight} rows={wide} onRemove={vi.fn()} />);
        const grid = container.querySelector('.tag-table-grid') as HTMLElement;
        expect(grid.style.gridTemplateColumns).toBe('minmax(220px, 380px) repeat(8, minmax(168px, 210px))');
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

    it('tagCell: number text + unit, or "—" when there is no value', () => {
        expect(tagCell('1.927', 'TON/HR')).toBe('1.927 TON/HR');
        expect(tagCell('52.000')).toBe('52.000');
        expect(tagCell('52.000', '')).toBe('52.000');
        expect(tagCell(null, 'DEGC')).toBe('—');
    });
});
