import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MappingUpload from '../components/upload/MappingUpload';

describe('MappingUpload', () => {
    it('says "Select Mapping CSV" with no file chosen, "Replace" once one is', () => {
        const { rerender } = render(
            <MappingUpload mappingData={null} mappingFilePath={null} isLoading={false} error={null} onSelectFile={vi.fn()} />,
        );
        expect(screen.getByText('Select Mapping CSV')).toBeTruthy();

        rerender(
            <MappingUpload mappingData={null} mappingFilePath="C:/data/map.csv" isLoading={false} error={null} onSelectFile={vi.fn()} />,
        );
        expect(screen.getByText('Replace Mapping CSV')).toBeTruthy();
    });

    it('shows just the filename, not the full path', () => {
        render(
            <MappingUpload mappingData={null} mappingFilePath="C:/data/sub/map.csv" isLoading={false} error={null} onSelectFile={vi.fn()} />,
        );
        expect(screen.getByText('map.csv')).toBeTruthy();
        expect(screen.queryByText('C:/data/sub/map.csv')).toBeNull();
    });

    it('clicking the button calls onSelectFile', () => {
        const onSelectFile = vi.fn();
        render(<MappingUpload mappingData={null} mappingFilePath={null} isLoading={false} error={null} onSelectFile={onSelectFile} />);
        fireEvent.click(screen.getByText('Select Mapping CSV'));
        expect(onSelectFile).toHaveBeenCalled();
    });

    it('disables the button and shows a loading indicator while loading', () => {
        render(<MappingUpload mappingData={null} mappingFilePath={null} isLoading error={null} onSelectFile={vi.fn()} />);
        expect(screen.getByText('Loading mapping data...')).toBeTruthy();
        expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows an error message when present', () => {
        render(<MappingUpload mappingData={null} mappingFilePath={null} isLoading={false} error="Bad CSV" onSelectFile={vi.fn()} />);
        expect(screen.getByText('Bad CSV')).toBeTruthy();
    });

    it('renders a preview table capped at 50 rows with a "showing" footnote', () => {
        const rows = Array.from({ length: 60 }, (_, i) => [`r${i}`, 'x']);
        render(
            <MappingUpload
                mappingData={{ headers: ['Tag', 'Value'], rows }}
                mappingFilePath="map.csv"
                isLoading={false}
                error={null}
                onSelectFile={vi.fn()}
            />,
        );
        expect(screen.getByText('Tag')).toBeTruthy();
        expect(screen.getByText('r0')).toBeTruthy();
        expect(screen.queryByText('r50')).toBeNull(); // beyond the 50-row cap
        expect(screen.getByText('Showing 50 of 60 rows')).toBeTruthy();
    });

    it('omits the "showing" footnote when there are 50 or fewer rows', () => {
        const rows = Array.from({ length: 10 }, (_, i) => [`r${i}`]);
        render(
            <MappingUpload
                mappingData={{ headers: ['Tag'], rows }}
                mappingFilePath="map.csv"
                isLoading={false}
                error={null}
                onSelectFile={vi.fn()}
            />,
        );
        expect(screen.queryByText(/Showing 50 of/)).toBeNull();
    });
});
