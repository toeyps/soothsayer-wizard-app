import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DataValidationSummary from '../components/upload/DataValidationSummary';
import type { CsvLoadReport } from '../types/dataUpload';

const baseReport: CsvLoadReport = {
    headers: ['timestamp', 'A', 'B'],
    total_rows: 1234,
    warnings: [],
    columns: [
        { name: 'A', dtype: 'numeric', null_count: 0, valid_count: 999 },
        { name: 'B', dtype: 'numeric', null_count: 5, valid_count: 1229 },
    ],
};

describe('DataValidationSummary', () => {
    it('shows the column and row counts', () => {
        render(<DataValidationSummary report={baseReport} />);
        expect(screen.getByText('2')).toBeTruthy(); // columns.length
        expect(screen.getByText('1,234')).toBeTruthy(); // total_rows, locale-formatted
    });

    it('renders a row per column with dtype and null/valid counts', () => {
        render(<DataValidationSummary report={baseReport} />);
        expect(screen.getByText('A')).toBeTruthy();
        expect(screen.getByText('B')).toBeTruthy();
        expect(screen.getAllByText('numeric')).toHaveLength(2);
        expect(screen.getByText('5')).toBeTruthy(); // B's null_count
        expect(screen.getByText('1,229')).toBeTruthy(); // B's valid_count
    });

    it('shows "0" (not highlighted) for a column with no nulls', () => {
        render(<DataValidationSummary report={baseReport} />);
        expect(screen.getByText('0')).toBeTruthy();
    });

    it('renders a warning banner per warning message', () => {
        render(<DataValidationSummary report={{ ...baseReport, warnings: ['Missing values detected', 'Duplicate timestamps'] }} />);
        expect(screen.getByText('Missing values detected')).toBeTruthy();
        expect(screen.getByText('Duplicate timestamps')).toBeTruthy();
    });

    it('shows no warning banners when there are none', () => {
        render(<DataValidationSummary report={baseReport} />);
        expect(screen.queryByText(/detected|Duplicate/)).toBeNull();
    });
});
