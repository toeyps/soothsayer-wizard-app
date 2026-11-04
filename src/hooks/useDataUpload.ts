import { useState, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { CsvLoadReport } from '../types/dataUpload';

export interface UseDataUploadReturn {
  selectedFiles: string[];
  loadReport: CsvLoadReport | null;
  isLoading: boolean;
  /** True when a successful parse exists but selectedFiles has since changed
   *  (file added / removed / reordered). Consumers should re-parse before
   *  trusting loadReport. Stays false while loadReport is null. */
  isStale: boolean;
  error: string | null;
  selectFiles: () => Promise<void>;
  removeFile: (path: string) => void;
  uploadDataset: () => Promise<void>;
  clearDataset: () => void;
  /** A project is about to replace the Rust dataset: forget the parse (running or
   *  finished), so it cannot touch this screen. The file list stays. */
  abandonParse: () => void;
}

export function useDataUpload(): UseDataUploadReturn {
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [loadReport, setLoadReport] = useState<CsvLoadReport | null>(null);
  // Snapshot of selectedFiles at the time loadReport was produced. Used to
  // derive `isStale` so the UI can re-prompt for parse when the selection
  // diverges from what was actually loaded.
  const [parsedFiles, setParsedFiles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest parse may touch the screen.
  const parseSeqRef = useRef(0);

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

    const seq = ++parseSeqRef.current;
    setIsLoading(true);
    setError(null);

    // Snapshot before await — selectedFiles can mutate mid-flight via the
    // file-picker, and we want isStale to reflect what was actually parsed.
    const snapshot = [...selectedFiles];

    try {
      const report = await invoke<CsvLoadReport>('load_csv', {
        paths: snapshot,
      });
      if (seq !== parseSeqRef.current) return;
      setLoadReport(report);
      setParsedFiles(snapshot);
    } catch (err) {
      if (seq !== parseSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoadReport(null);
      setParsedFiles([]);
    } finally {
      if (seq === parseSeqRef.current) setIsLoading(false);
    }
  }, [selectedFiles]);

  const abandonParse = useCallback(() => {
    parseSeqRef.current += 1;
    setLoadReport(null);
    setParsedFiles([]);
    setError(null);
    setIsLoading(false);
  }, []);

  const clearDataset = useCallback(() => {
    parseSeqRef.current += 1;
    setSelectedFiles([]);
    setLoadReport(null);
    setParsedFiles([]);
    setError(null);
    setIsLoading(false);
  }, []);

  const isStale = useMemo(() => {
    if (!loadReport) return false;
    if (selectedFiles.length !== parsedFiles.length) return true;
    return selectedFiles.some((f, i) => f !== parsedFiles[i]);
  }, [loadReport, selectedFiles, parsedFiles]);

  return {
    selectedFiles,
    loadReport,
    isLoading,
    isStale,
    error,
    selectFiles,
    removeFile,
    uploadDataset,
    clearDataset,
    abandonParse,
  };
}
