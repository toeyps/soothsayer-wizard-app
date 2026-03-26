import { useState } from 'react';
import { CsvRecord } from '../../types';

interface DataTableProps {
    headers: string[];
    data: CsvRecord[];
}

export default function DataTable({ headers, data }: DataTableProps) {
    const [page, setPage] = useState(0);
    const pageSize = 50;
    const totalPages = Math.ceil(data.length / pageSize);

    const paginatedData = data.slice(page * pageSize, (page + 1) * pageSize);

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
                        {paginatedData.map((row, i) => (
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
                <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
                <span>Page {page + 1} of {totalPages}</span>
                <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
        </div>
    );
}
