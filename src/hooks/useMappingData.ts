import { useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { MappingData, MappingResult } from '../types/dataUpload';
import type { SensorMetadata } from '../types';

export interface UseMappingDataReturn {
  mappingData: MappingData | null;
  mappingFilePath: string | null;
  keyColumn: string | null;
  mappingResult: MappingResult | null;
  sensorMetadata: SensorMetadata[] | null;
  isLoading: boolean;
  error: string | null;
  selectMappingFile: () => Promise<void>;
  setKeyColumn: (col: string) => void;
  applyMapping: (datasetHeaders: string[]) => Promise<void>;
  clearMapping: () => void;
}

/** Auto-detect column index by common names */
function findColumnIndex(headers: string[], candidates: string[]): number | null {
  const lower = headers.map(h => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx !== -1) return idx;
  }
  return null;
}

/** Parses a mapping-CSV cell as an alarm setpoint. Empty/whitespace-only
 *  cells and anything that doesn't parse as a finite number come back as
 *  `undefined` — "no value", not 0 — so the Dashboard's "only show what
 *  exists" checkbox list has something real to check for. */
function parseAlarmValue(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Build SensorMetadata[] from mapping data + result. Exported for reuse by the
 *  Recent Workspace click flow in `DataUploadPage.handleLoadWorkspace`. */
export function buildSensorMetadataFromMapping(
  mappingData: MappingData,
  mappingResult: MappingResult,
  keyColumn: string,
): SensorMetadata[] | null {
  const headers = mappingData.headers;
  const keyIdx = headers.findIndex(h => h === keyColumn);
  if (keyIdx === -1) return null;

  const descIdx = findColumnIndex(headers, ['description', 'desc', 'name', 'sensor_name', 'sensor name']);
  const unitIdx = findColumnIndex(headers, ['unit', 'units', 'uom', 'eng_unit', 'eng unit']);
  const compIdx = findColumnIndex(headers, ['component', 'comp', 'group', 'category', 'system']);
  const alarmLIdx = findColumnIndex(headers, ['alarm_l', 'alarm l', 'low', 'lo']);
  const alarmLLIdx = findColumnIndex(headers, ['alarm_ll', 'alarm ll', 'lowlow', 'low low', 'lolo', 'lo lo']);
  const alarmHIdx = findColumnIndex(headers, ['alarm_h', 'alarm h', 'high', 'hi']);
  const alarmHHIdx = findColumnIndex(headers, ['alarm_hh', 'alarm hh', 'highhigh', 'high high', 'hihi', 'hi hi']);

  const matchedSet = new Set(mappingResult.matched);
  const result: SensorMetadata[] = [];
  for (const row of mappingData.rows) {
    const tag = row[keyIdx]?.trim() ?? '';
    if (!tag || !matchedSet.has(tag)) continue;
    result.push({
      tag,
      description: descIdx !== null ? (row[descIdx]?.trim() ?? '') : '',
      unit: unitIdx !== null ? (row[unitIdx]?.trim() ?? '') : '',
      component: compIdx !== null ? (row[compIdx]?.trim() ?? '') : '',
      alarmL: alarmLIdx !== null ? parseAlarmValue(row[alarmLIdx]) : undefined,
      alarmLL: alarmLLIdx !== null ? parseAlarmValue(row[alarmLLIdx]) : undefined,
      alarmH: alarmHIdx !== null ? parseAlarmValue(row[alarmHIdx]) : undefined,
      alarmHH: alarmHHIdx !== null ? parseAlarmValue(row[alarmHHIdx]) : undefined,
    });
  }
  return result.length > 0 ? result : null;
}

export function useMappingData(): UseMappingDataReturn {
  const [mappingData, setMappingData] = useState<MappingData | null>(null);
  const [mappingFilePath, setMappingFilePath] = useState<string | null>(null);
  const [keyColumn, setKeyColumn] = useState<string | null>(null);
  const [mappingResult, setMappingResult] = useState<MappingResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectMappingFile = useCallback(async () => {
    try {
      const result = await open({
        multiple: false,
        filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      });

      if (result && typeof result === 'string') {
        setMappingFilePath(result);
        setIsLoading(true);
        setError(null);
        setKeyColumn(null);
        setMappingResult(null);

        try {
          const data = await invoke<MappingData>('load_mapping_csv', {
            path: result,
          });
          setMappingData(data);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setMappingData(null);
          setMappingFilePath(null);
        } finally {
          setIsLoading(false);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open file dialog');
    }
  }, []);

  const applyMapping = useCallback(
    async (datasetHeaders: string[]) => {
      if (!keyColumn || !mappingData) {
        setError('Key column and mapping data are required');
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const result = await invoke<MappingResult>('apply_sensor_mapping', {
          keyColumn: keyColumn,
          mappingData: mappingData,
          datasetHeaders: datasetHeaders,
        });
        setMappingResult(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setMappingResult(null);
      } finally {
        setIsLoading(false);
      }
    },
    [keyColumn, mappingData]
  );

  const clearMapping = useCallback(() => {
    setMappingData(null);
    setMappingFilePath(null);
    setKeyColumn(null);
    setMappingResult(null);
    setError(null);
    setIsLoading(false);
  }, []);

  /** Build SensorMetadata[] from mapping CSV for matched keys */
  const sensorMetadata = useMemo<SensorMetadata[] | null>(() => {
    if (!mappingData || !mappingResult || !keyColumn) return null;
    return buildSensorMetadataFromMapping(mappingData, mappingResult, keyColumn);
  }, [mappingData, mappingResult, keyColumn]);

  return {
    mappingData,
    mappingFilePath,
    keyColumn,
    mappingResult,
    sensorMetadata,
    isLoading,
    error,
    selectMappingFile,
    setKeyColumn,
    applyMapping,
    clearMapping,
  };
}
