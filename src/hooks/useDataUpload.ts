import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { CsvLoadReport } from '../types/dataUpload';

export interface UseDataUploadReturn {
  selectedFiles: string[];
  loadReport: CsvLoadReport | null;
  isLoading: boolean;
  error: string | null;
  selectFiles: () => Promise<void>;
  removeFile: (path: string) => void;
  uploadDataset: () => Promise<void>;
  clearDataset: () => void;
}

export function useDataUpload(): UseDataUploadReturn {
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [loadReport, setLoadReport] = useState<CsvLoadReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectFiles = useCallback(async () => {
    try {
      const result = await open({
        multiple: true,
        filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      });

      if (result && Array.isArray(result) && result.length > 0) {
        setSelectedFiles((prev) => {
          const existing = new Set(prev);
          const newPaths = result.filter((p) => !existing.has(p));
          return [...prev, ...newPaths];
        });
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open file dialog');
    }
  }, []);

  const removeFile = useCallback((path: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f !== path));
  }, []);

  const uploadDataset = useCallback(async () => {
    if (selectedFiles.length === 0) {
      setError('No files selected');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const report = await invoke<CsvLoadReport>('load_csv', {
        paths: selectedFiles,
      });
      setLoadReport(report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoadReport(null);
    } finally {
      setIsLoading(false);
    }
  }, [selectedFiles]);

  const clearDataset = useCallback(() => {
    setSelectedFiles([]);
    setLoadReport(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return {
    selectedFiles,
    loadReport,
    isLoading,
    error,
    selectFiles,
    removeFile,
    uploadDataset,
    clearDataset,
  };
}
