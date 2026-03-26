import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMappingData } from '../hooks/useMappingData';
import type { MappingData, MappingResult } from '../types/dataUpload';

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

const sampleMappingData: MappingData = {
  headers: ['tag', 'name', 'unit'],
  rows: [
    ['SENS_A', 'Temperature', 'degC'],
    ['SENS_B', 'Pressure', 'bar'],
  ],
};

const sampleMappingResult: MappingResult = {
  matched: ['SENS_A', 'SENS_B'],
  not_in_dataset: [],
  not_in_mapping: ['SENS_C'],
};

// ============================================================
// Tests
// ============================================================

describe('useMappingData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct initial state', () => {
    const { result } = renderHook(() => useMappingData());

    expect(result.current.mappingData).toBeNull();
    expect(result.current.mappingFilePath).toBeNull();
    expect(result.current.keyColumn).toBeNull();
    expect(result.current.mappingResult).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('selectMappingFile loads mapping data on file selection', async () => {
    mockOpen.mockResolvedValue('/path/to/mapping.csv');
    mockInvoke.mockResolvedValue(sampleMappingData);

    const { result } = renderHook(() => useMappingData());

    await act(async () => {
      await result.current.selectMappingFile();
    });

    expect(mockOpen).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    expect(mockInvoke).toHaveBeenCalledWith('load_mapping_csv', {
      path: '/path/to/mapping.csv',
    });
    expect(result.current.mappingFilePath).toBe('/path/to/mapping.csv');
    expect(result.current.mappingData).toEqual(sampleMappingData);
    expect(result.current.isLoading).toBe(false);
  });

  it('selectMappingFile resets keyColumn and result', async () => {
    mockOpen.mockResolvedValue('/path/to/mapping.csv');
    mockInvoke.mockResolvedValue(sampleMappingData);

    const { result } = renderHook(() => useMappingData());

    // Set key column first
    act(() => {
      result.current.setKeyColumn('old_key');
    });

    await act(async () => {
      await result.current.selectMappingFile();
    });

    // Should be reset
    expect(result.current.keyColumn).toBeNull();
    expect(result.current.mappingResult).toBeNull();
  });

  it('selectMappingFile does nothing when dialog is cancelled', async () => {
    mockOpen.mockResolvedValue(null);

    const { result } = renderHook(() => useMappingData());

    await act(async () => {
      await result.current.selectMappingFile();
    });

    expect(result.current.mappingFilePath).toBeNull();
    expect(result.current.mappingData).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('selectMappingFile sets error when invoke fails', async () => {
    mockOpen.mockResolvedValue('/path/to/bad.csv');
    mockInvoke.mockRejectedValue(new Error('Parse error'));

    const { result } = renderHook(() => useMappingData());

    await act(async () => {
      await result.current.selectMappingFile();
    });

    expect(result.current.error).toBe('Parse error');
    expect(result.current.mappingData).toBeNull();
    expect(result.current.mappingFilePath).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('selectMappingFile sets error when dialog throws', async () => {
    mockOpen.mockRejectedValue(new Error('Dialog crashed'));

    const { result } = renderHook(() => useMappingData());

    await act(async () => {
      await result.current.selectMappingFile();
    });

    expect(result.current.error).toBe('Dialog crashed');
  });

  it('setKeyColumn updates keyColumn state', () => {
    const { result } = renderHook(() => useMappingData());

    act(() => {
      result.current.setKeyColumn('tag');
    });

    expect(result.current.keyColumn).toBe('tag');
  });

  it('applyMapping calls invoke with correct args and sets result', async () => {
    mockOpen.mockResolvedValue('/mapping.csv');
    mockInvoke
      .mockResolvedValueOnce(sampleMappingData) // load_mapping_csv
      .mockResolvedValueOnce(sampleMappingResult); // apply_sensor_mapping

    const { result } = renderHook(() => useMappingData());

    // Load mapping file
    await act(async () => {
      await result.current.selectMappingFile();
    });

    // Set key column
    act(() => {
      result.current.setKeyColumn('tag');
    });

    // Apply mapping
    const datasetHeaders = ['timestamp', 'SENS_A', 'SENS_B', 'SENS_C'];
    await act(async () => {
      await result.current.applyMapping(datasetHeaders);
    });

    expect(mockInvoke).toHaveBeenCalledWith('apply_sensor_mapping', {
      keyColumn: 'tag',
      mappingData: sampleMappingData,
      datasetHeaders: datasetHeaders,
    });
    expect(result.current.mappingResult).toEqual(sampleMappingResult);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('applyMapping sets error when key column is not selected', async () => {
    const { result } = renderHook(() => useMappingData());

    await act(async () => {
      await result.current.applyMapping(['timestamp', 'SENS_A']);
    });

    expect(result.current.error).toBe(
      'Key column and mapping data are required'
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('applyMapping sets error when invoke fails', async () => {
    mockOpen.mockResolvedValue('/mapping.csv');
    mockInvoke
      .mockResolvedValueOnce(sampleMappingData) // load_mapping_csv
      .mockRejectedValueOnce('Mapping error: column not found'); // apply_sensor_mapping

    const { result } = renderHook(() => useMappingData());

    await act(async () => {
      await result.current.selectMappingFile();
    });

    act(() => {
      result.current.setKeyColumn('tag');
    });

    await act(async () => {
      await result.current.applyMapping(['timestamp', 'SENS_A']);
    });

    expect(result.current.error).toBe('Mapping error: column not found');
    expect(result.current.mappingResult).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('clearMapping resets all state', async () => {
    mockOpen.mockResolvedValue('/mapping.csv');
    mockInvoke.mockResolvedValue(sampleMappingData);

    const { result } = renderHook(() => useMappingData());

    await act(async () => {
      await result.current.selectMappingFile();
    });

    act(() => {
      result.current.setKeyColumn('tag');
    });

    // Verify state is populated
    expect(result.current.mappingData).not.toBeNull();
    expect(result.current.mappingFilePath).not.toBeNull();

    act(() => {
      result.current.clearMapping();
    });

    expect(result.current.mappingData).toBeNull();
    expect(result.current.mappingFilePath).toBeNull();
    expect(result.current.keyColumn).toBeNull();
    expect(result.current.mappingResult).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});
