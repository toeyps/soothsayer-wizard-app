import { vi } from 'vitest';
import type { UseMappingDataReturn } from '../../hooks/useMappingData';

/**
 * A tag-name file that already matches the data, for tests that walk through
 * Import step 2 on their way to something else (a new project now needs one):
 *
 *   vi.mock('../hooks/useMappingData', async (original) => ({
 *     ...(await original<typeof import('../hooks/useMappingData')>()),
 *     useMappingData: (await import('./helpers/matchingTagFile')).useMatchingTagFile,
 *     buildSensorMetadataFromMapping: () => null, // reopening the project reads no real file
 *   }));
 *
 * The check itself is covered in DataUploadPage.test.tsx (R10a-R10f).
 * Stable identities: the page re-applies the mapping when these change.
 */
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
