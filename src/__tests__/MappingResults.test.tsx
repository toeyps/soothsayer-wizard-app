import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MappingResults from '../components/upload/MappingResults';

describe('MappingResults', () => {
    it('shows the matched-count banner, singular vs plural', () => {
        const { rerender } = render(
            <MappingResults result={{ matched: ['A'], not_in_dataset: [], not_in_mapping: [] }} />,
        );
        expect(screen.getByText('1 column matched')).toBeTruthy();

        rerender(<MappingResults result={{ matched: ['A', 'B'], not_in_dataset: [], not_in_mapping: [] }} />);
        expect(screen.getByText('2 columns matched')).toBeTruthy();
    });

    it('omits the matched banner when nothing matched', () => {
        render(<MappingResults result={{ matched: [], not_in_dataset: [], not_in_mapping: [] }} />);
        expect(screen.queryByText(/matched/)).toBeNull();
    });

    it('lists keys present in the mapping but missing from the dataset', () => {
        render(<MappingResults result={{ matched: [], not_in_dataset: ['TAG1', 'TAG2'], not_in_mapping: [] }} />);
        expect(screen.getByText('2 keys in mapping but not in dataset')).toBeTruthy();
        expect(screen.getByText('TAG1')).toBeTruthy();
        expect(screen.getByText('TAG2')).toBeTruthy();
    });

    it('lists dataset columns missing from the mapping', () => {
        render(<MappingResults result={{ matched: [], not_in_dataset: [], not_in_mapping: ['COLX'] }} />);
        expect(screen.getByText('1 dataset column not found in mapping')).toBeTruthy();
        expect(screen.getByText('COLX')).toBeTruthy();
    });

    it('renders nothing beyond the heading when every list is empty', () => {
        render(<MappingResults result={{ matched: [], not_in_dataset: [], not_in_mapping: [] }} />);
        expect(screen.getByText('Mapping Results')).toBeTruthy();
        expect(screen.queryByText(/keys in mapping/)).toBeNull();
        expect(screen.queryByText(/not found in mapping/)).toBeNull();
    });
});
