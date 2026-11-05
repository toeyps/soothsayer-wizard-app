import { vi } from 'vitest';
import type { UseMappingDataReturn } from '../../hooks/useMappingData';

/** A tag-name file that already matches the data, for tests walking Import step 2 (a new project needs one). Mock `useMappingData` with `useMatchingTagFile`. Identities are stable: the page re-applies the mapping when they change. */
const MATCHING_TAG_FILE: UseMappingDataReturn = {
  mappingFilePath: '/lookup/tags.csv',
  mappingData: { headers: ['tag'], rows: [] },
  keyColumn: 'tag',
  mappingResult: { matched: [], not_in_dataset: [], not_in_mapping: [] },
  sensorMetadata: null,
  isLoading: false,
  error: null,
  selectMappingFile: vi.fn(),
  setKeyColumn: vi.fn(),
  applyMapping: vi.fn(),
  clearMapping: vi.fn(),
};

export const useMatchingTagFile = () => MATCHING_TAG_FILE;
