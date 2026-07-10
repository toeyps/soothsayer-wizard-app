import { CsvRecord } from '../../types';

interface DataTableProps {
    headers: string[];
    /** The current page's rows only — paging happens in the Rust backend. */
    rows: CsvRecord[];
    /** Total rows across all pages (post-filter / post-aggregation). */
    totalRows: number;
    page: number;
    pageSize: number;
    onPageChange: (page: number) => void;
}

/**
 * Controlled, server-paged table. The parent fetches one page at a time via
 * `get_table_page`, so the WebView holds `pageSize` rows instead of the
 * whole dataset (which used to be sliced client-side from a full copy).
 */
export default function DataTable({ headers, rows, totalRows, page, pageSize, onPageChange }: DataTableProps) {
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

    return (
        <div className="table-wrapper-compact">
            <div className="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Timestamp</th>
                            {headers.map(h => <th key={h}>{h}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, i) => (
                            <tr key={i}>
                                <td>{row.timestamp}</td>
                                {headers.map((h, index) => (
                                    <td key={h}>{row.values[index] !== null ? row.values[index] : ''}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="pagination">
                <button disabled={page === 0} onClick={() => onPageChange(page - 1)}>Prev</button>
                <span>Page {page + 1} of {totalPages}</span>
                <button disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}>Next</button>
            </div>
        </div>
    );
}
