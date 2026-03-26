import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDataUpload } from '../hooks/useDataUpload';
import type { CsvLoadReport } from '../types/dataUpload';

// ============================================================
// Mocks
// ============================================================

const mockInvoke = vi.fn();
const mockOpen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));

// ============================================================
// Test data
// ============================================================

const sampleReport: CsvLoadReport = {
  headers: ['timestamp', 'sensor_a', 'sensor_b'],
  total_rows: 100,
  columns: [
    { name: 'timestamp', dtype: 'datetime', null_count: 0, valid_count: 100 },
    { name: 'sensor_a', dtype: 'numeric', null_count: 5, valid_count: 95 },
    { name: 'sensor_b', dtype: 'numeric', null_count: 2, valid_count: 98 },
  ],
  warnings: [],
};

// ============================================================
// Tests
// ============================================================

describe('useDataUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct initial state', () => {
    const { result } = renderHook(() => useDataUpload());

    expect(result.current.selectedFiles).toEqual([]);
    expect(result.current.loadReport).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('selectFiles updates selectedFiles when dialog returns paths', async () => {
    mockOpen.mockResolvedValue(['/path/to/file1.csv', '/path/to/file2.csv']);

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });

    expect(result.current.selectedFiles).toEqual([
      '/path/to/file1.csv',
      '/path/to/file2.csv',
    ]);
    expect(result.current.error).toBeNull();
  });

  it('selectFiles does not add duplicate paths', async () => {
    mockOpen.mockResolvedValueOnce(['/path/to/file1.csv']);

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });

    // Try adding same file again plus a new one
    mockOpen.mockResolvedValueOnce(['/path/to/file1.csv', '/path/to/file3.csv']);

    await act(async () => {
      await result.current.selectFiles();
    });

    expect(result.current.selectedFiles).toEqual([
      '/path/to/file1.csv',
      '/path/to/file3.csv',
    ]);
  });

  it('selectFiles does nothing when dialog is cancelled (null result)', async () => {
    mockOpen.mockResolvedValue(null);

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });

    expect(result.current.selectedFiles).toEqual([]);
  });

  it('selectFiles sets error when dialog throws', async () => {
    mockOpen.mockRejectedValue(new Error('Dialog failed'));

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });

    expect(result.current.error).toBe('Dialog failed');
  });

  it('removeFile removes the specified file', async () => {
    mockOpen.mockResolvedValue(['/a.csv', '/b.csv', '/c.csv']);

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });

    act(() => {
      result.current.removeFile('/b.csv');
    });

    expect(result.current.selectedFiles).toEqual(['/a.csv', '/c.csv']);
  });

  it('removeFile with non-existent path does nothing', async () => {
    mockOpen.mockResolvedValue(['/a.csv']);

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });

    act(() => {
      result.current.removeFile('/nonexistent.csv');
    });

    expect(result.current.selectedFiles).toEqual(['/a.csv']);
  });

  it('uploadDataset calls invoke with selected files and sets loadReport', async () => {
    mockOpen.mockResolvedValue(['/data.csv']);
    mockInvoke.mockResolvedValue(sampleReport);

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });

    await act(async () => {
      await result.current.uploadDataset();
    });

    expect(mockInvoke).toHaveBeenCalledWith('load_csv', {
      paths: ['/data.csv'],
    });
    expect(result.current.loadReport).toEqual(sampleReport);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('uploadDataset sets error when no files selected', async () => {
    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.uploadDataset();
    });

    expect(result.current.error).toBe('No files selected');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('uploadDataset sets error when invoke fails', async () => {
    mockOpen.mockResolvedValue(['/data.csv']);
    mockInvoke.mockRejectedValue('CSV parse error: invalid column');

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });

    await act(async () => {
      await result.current.uploadDataset();
    });

    expect(result.current.error).toBe('CSV parse error: invalid column');
    expect(result.current.loadReport).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('uploadDataset sets error message from Error object', async () => {
    mockOpen.mockResolvedValue(['/data.csv']);
    mockInvoke.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });

    await act(async () => {
      await result.current.uploadDataset();
    });

    expect(result.current.error).toBe('Network error');
  });

  it('clearDataset resets all state', async () => {
    mockOpen.mockResolvedValue(['/data.csv']);
    mockInvoke.mockResolvedValue(sampleReport);

    const { result } = renderHook(() => useDataUpload());

    await act(async () => {
      await result.current.selectFiles();
    });
    await act(async () => {
      await result.current.uploadDataset();
    });

    // Verify state is populated
    expect(result.current.selectedFiles.length).toBeGreaterThan(0);
    expect(result.current.loadReport).not.toBeNull();

    act(() => {
      result.current.clearDataset();
    });

    expect(result.current.selectedFiles).toEqual([]);
    expect(result.current.loadReport).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});
