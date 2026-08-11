import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DatasetUpload from '../components/upload/DatasetUpload';

describe('DatasetUpload', () => {
    it('clicking "Select CSV Files" calls onSelectFiles', () => {
        const onSelectFiles = vi.fn();
        render(<DatasetUpload selectedFiles={[]} isLoading={false} error={null} onSelectFiles={onSelectFiles} onRemoveFile={vi.fn()} onUpload={vi.fn()} />);
        fireEvent.click(screen.getByText('Select CSV Files'));
        expect(onSelectFiles).toHaveBeenCalled();
    });

    it('lists each selected file by its base filename', () => {
        render(
            <DatasetUpload
                selectedFiles={['C:/data/run1.csv', 'C:/data/run2.csv']}
                isLoading={false} error={null}
                onSelectFiles={vi.fn()} onRemoveFile={vi.fn()} onUpload={vi.fn()}
            />,
        );
        expect(screen.getByText('run1.csv')).toBeTruthy();
        expect(screen.getByText('run2.csv')).toBeTruthy();
    });

    it('removing a file calls onRemoveFile with its full path', () => {
        const onRemoveFile = vi.fn();
        render(
            <DatasetUpload
                selectedFiles={['C:/data/run1.csv']}
                isLoading={false} error={null}
                onSelectFiles={vi.fn()} onRemoveFile={onRemoveFile} onUpload={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByText('run1.csv').closest('div')!.parentElement!.querySelector('button')!);
        expect(onRemoveFile).toHaveBeenCalledWith('C:/data/run1.csv');
    });

    it('"Process Files" is disabled with no files selected, enabled once some are', () => {
        const { rerender } = render(
            <DatasetUpload selectedFiles={[]} isLoading={false} error={null} onSelectFiles={vi.fn()} onRemoveFile={vi.fn()} onUpload={vi.fn()} />,
        );
        expect((screen.getByText('Process Files') as HTMLButtonElement).disabled).toBe(true);

        rerender(
            <DatasetUpload selectedFiles={['a.csv']} isLoading={false} error={null} onSelectFiles={vi.fn()} onRemoveFile={vi.fn()} onUpload={vi.fn()} />,
        );
        expect((screen.getByText('Process Files') as HTMLButtonElement).disabled).toBe(false);
    });

    it('clicking "Process Files" calls onUpload', () => {
        const onUpload = vi.fn();
        render(
            <DatasetUpload selectedFiles={['a.csv']} isLoading={false} error={null} onSelectFiles={vi.fn()} onRemoveFile={vi.fn()} onUpload={onUpload} />,
        );
        fireEvent.click(screen.getByText('Process Files'));
        expect(onUpload).toHaveBeenCalled();
    });

    it('shows a loading state and disables both action buttons', () => {
        render(
            <DatasetUpload selectedFiles={['a.csv']} isLoading error={null} onSelectFiles={vi.fn()} onRemoveFile={vi.fn()} onUpload={vi.fn()} />,
        );
        expect(screen.getByText('Processing...')).toBeTruthy();
        expect((screen.getByText('Select CSV Files').closest('button') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByText('Processing...').closest('button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows an error message when present', () => {
        render(<DatasetUpload selectedFiles={[]} isLoading={false} error="Upload failed" onSelectFiles={vi.fn()} onRemoveFile={vi.fn()} onUpload={vi.fn()} />);
        expect(screen.getByText('Upload failed')).toBeTruthy();
    });
});
