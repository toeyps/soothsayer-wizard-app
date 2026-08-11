import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DataTable from '../components/dashboard/DataTable';

const headers = ['A', 'B'];
const rows = [
    { timestamp: 't0', values: [1, null] },
    { timestamp: 't1', values: [2, 20] },
] as any;

describe('DataTable', () => {
    it('renders a Timestamp column plus one column per header', () => {
        render(<DataTable headers={headers} rows={rows} totalRows={2} page={0} pageSize={50} onPageChange={vi.fn()} />);
        const headerRow = screen.getAllByRole('columnheader');
        expect(headerRow.map((h) => h.textContent)).toEqual(['Timestamp', 'A', 'B']);
    });

    it('renders one row per data row, with timestamp and values in header order', () => {
        render(<DataTable headers={headers} rows={rows} totalRows={2} page={0} pageSize={50} onPageChange={vi.fn()} />);
        const bodyRows = screen.getAllByRole('row').slice(1); // skip header row
        expect(within(bodyRows[0]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['t0', '1', '']);
        expect(within(bodyRows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['t1', '2', '20']);
    });

    it('renders an empty cell (not "null") for null values', () => {
        render(<DataTable headers={headers} rows={rows} totalRows={2} page={0} pageSize={50} onPageChange={vi.fn()} />);
        expect(screen.queryByText('null')).toBeNull();
    });

    it('computes total pages from totalRows/pageSize, minimum 1', () => {
        render(<DataTable headers={headers} rows={rows} totalRows={125} page={0} pageSize={50} onPageChange={vi.fn()} />);
        expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    });

    it('shows exactly 1 page when totalRows is 0', () => {
        render(<DataTable headers={headers} rows={[]} totalRows={0} page={0} pageSize={50} onPageChange={vi.fn()} />);
        expect(screen.getByText('Page 1 of 1')).toBeTruthy();
    });

    it('disables Prev on the first page and Next on the last page', () => {
        const { rerender } = render(
            <DataTable headers={headers} rows={rows} totalRows={100} page={0} pageSize={50} onPageChange={vi.fn()} />,
        );
        expect((screen.getByText('Prev') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(false);

        rerender(<DataTable headers={headers} rows={rows} totalRows={100} page={1} pageSize={50} onPageChange={vi.fn()} />);
        expect((screen.getByText('Prev') as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(true);
    });

    it('calls onPageChange with page-1/page+1 when Prev/Next are clicked', () => {
        const onPageChange = vi.fn();
        render(<DataTable headers={headers} rows={rows} totalRows={150} page={1} pageSize={50} onPageChange={onPageChange} />);

        fireEvent.click(screen.getByText('Next'));
        expect(onPageChange).toHaveBeenLastCalledWith(2);

        fireEvent.click(screen.getByText('Prev'));
        expect(onPageChange).toHaveBeenLastCalledWith(0);
    });
});
