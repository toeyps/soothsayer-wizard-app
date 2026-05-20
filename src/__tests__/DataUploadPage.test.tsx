import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import DataUploadPage from '../components/upload/DataUploadPage';
import type {
  CsvMetadata,
  SensorMetadata,
  WorkspaceMetadata,
  WorkspaceState,
} from '../types';
import type { CsvLoadReport, MappingData, MappingResult } from '../types/dataUpload';
import type { UseDataUploadReturn } from '../hooks/useDataUpload';
import type { UseMappingDataReturn } from '../hooks/useMappingData';

// ─────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────

const mockInvoke = vi.fn();
const mockAsk = vi.fn();
const mockListen = vi.fn();
const mockEmit = vi.fn();
const mockGetByLabel = vi.fn();
const mockGetCurrentWindow = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: (...args: unknown[]) => mockAsk(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
  emit: (...args: unknown[]) => mockEmit(...args),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    constructor() {}
    static getByLabel = (...args: unknown[]) => mockGetByLabel(...args);
    once = vi.fn();
  },
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: (...args: unknown[]) => mockGetCurrentWindow(...args),
}));

// workspaceManager — all 4 functions used by DataUploadPage
const mockGetRecent = vi.fn();
const mockLoadWorkspace = vi.fn();
const mockSaveWorkspace = vi.fn();
const mockDeleteWorkspace = vi.fn();

vi.mock('../workspaceManager', () => ({
  getRecentWorkspaces: (...args: unknown[]) => mockGetRecent(...args),
  loadWorkspaceData: (...args: unknown[]) => mockLoadWorkspace(...args),
  saveWorkspaceData: (...args: unknown[]) => mockSaveWorkspace(...args),
  deleteWorkspace: (...args: unknown[]) => mockDeleteWorkspace(...args),
}));

// Stub both hooks so we drive page state via mock return values. The hooks
// themselves are unit-tested separately in useDataUpload.test.ts /
// useMappingData.test.ts — here we only care about how the page reacts.
const useDataUploadMock = vi.fn();
const useMappingDataMock = vi.fn();
const buildSensorMetadataMock = vi.fn();

vi.mock('../hooks/useDataUpload', () => ({
  useDataUpload: () => useDataUploadMock(),
}));

vi.mock('../hooks/useMappingData', () => ({
  useMappingData: () => useMappingDataMock(),
  buildSensorMetadataFromMapping: (...args: unknown[]) => buildSensorMetadataMock(...args),
}));

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const FAKE_REPORT: CsvLoadReport = {
  headers: ['timestamp', 'sensor_a', 'sensor_b'],
  total_rows: 1234,
  columns: [
    { name: 'timestamp', dtype: 'datetime', null_count: 0, valid_count: 1234 },
    { name: 'sensor_a', dtype: 'numeric', null_count: 0, valid_count: 1234 },
    { name: 'sensor_b', dtype: 'numeric', null_count: 0, valid_count: 1234 },
  ],
  warnings: [],
};

const FAKE_MAPPING_DATA: MappingData = {
  headers: ['tag', 'description'],
  rows: [
    ['sensor_a', 'Pressure A'],
    ['sensor_b', 'Pressure B'],
    ['sensor_c', 'Pressure C'],
  ],
};

const FAKE_MAPPING_RESULT: MappingResult = {
  matched: ['sensor_a', 'sensor_b'],
  not_in_dataset: ['sensor_c'],
  not_in_mapping: [],
};

const FAKE_WORKSPACES: WorkspaceMetadata[] = [
  { id: 'ws_1', name: 'Engine pressure run', lastModified: 1_700_000_000_000, filePath: '/ws/ws_1.json' },
  { id: 'ws_2', name: 'Compressor health', lastModified: 1_700_100_000_000, filePath: '/ws/ws_2.json' },
];

const makeDataUpload = (overrides: Partial<UseDataUploadReturn> = {}): UseDataUploadReturn => ({
  selectedFiles: [],
  loadReport: null,
  isLoading: false,
  isStale: false,
  error: null,
  selectFiles: vi.fn(),
  removeFile: vi.fn(),
  uploadDataset: vi.fn(),
  clearDataset: vi.fn(),
  ...overrides,
});

const makeMapping = (overrides: Partial<UseMappingDataReturn> = {}): UseMappingDataReturn => ({
  mappingData: null,
  mappingFilePath: null,
  keyColumn: null,
  mappingResult: null,
  sensorMetadata: null,
  isLoading: false,
  error: null,
  selectMappingFile: vi.fn(),
  setKeyColumn: vi.fn(),
  applyMapping: vi.fn(),
  clearMapping: vi.fn(),
  ...overrides,
});

const onDataReady = vi.fn();

/** Walk up the DOM from a text node until we find an ancestor that has a
 *  button child — useful for "find the row that contains this filename and
 *  click its remove button". */
function rowFor(text: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(text);
  while (el && !el.querySelector('button')) {
    el = el.parentElement;
  }
  if (!el) throw new Error(`No row with button found for text: ${text}`);
  return el;
}

// ─────────────────────────────────────────────────────────────────────────
// Default setup — each test overrides only what it needs
// ─────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.setAttribute('data-theme', 'dark');
  mockGetRecent.mockResolvedValue([]);
  useDataUploadMock.mockReturnValue(makeDataUpload());
  useMappingDataMock.mockReturnValue(makeMapping());
});

afterEach(() => {
  cleanup();
});

// ═════════════════════════════════════════════════════════════════════════
// A. Workspace sidebar
// ═════════════════════════════════════════════════════════════════════════

describe('A. Workspace sidebar', () => {
  it('A1. fetches and renders recent workspaces on mount', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(mockGetRecent).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('Engine pressure run')).toBeTruthy();
      expect(screen.getByText('Compressor health')).toBeTruthy();
    });
  });

  it('A2. shows "No workspaces yet" when list is empty', async () => {
    mockGetRecent.mockResolvedValue([]);
    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => {
      expect(screen.getByText('No workspaces yet')).toBeTruthy();
    });
  });

  it('A3. search filters workspaces case-insensitively', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));

    const input = screen.getByPlaceholderText('Find workspace…');
    fireEvent.change(input, { target: { value: 'COMPRESSOR' } });

    expect(screen.queryByText('Engine pressure run')).toBeNull();
    expect(screen.getByText('Compressor health')).toBeTruthy();
  });

  it('A4. shows "No matches" when search has no hits', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));

    fireEvent.change(screen.getByPlaceholderText('Find workspace…'), {
      target: { value: 'zzz-no-such-thing' },
    });

    expect(screen.getByText('No matches')).toBeTruthy();
    expect(screen.queryByText('No workspaces yet')).toBeNull();
  });

  it('A5. clicking a workspace row triggers loading state', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    // Keep loadWorkspace pending forever so we can observe "Loading…"
    mockLoadWorkspace.mockReturnValue(new Promise(() => {}));

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));

    fireEvent.click(screen.getByText('Engine pressure run'));

    expect(mockLoadWorkspace).toHaveBeenCalledWith('ws_1');
    await waitFor(() => {
      expect(screen.getByText('Loading workspace…')).toBeTruthy();
    });
  });

  it('A6. clicking delete on a row opens the confirm dialog', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    mockAsk.mockResolvedValue(false);

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));

    const allDeleteBtns = screen.getAllByTitle('Delete workspace');
    fireEvent.click(allDeleteBtns[0]);

    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockAsk.mock.calls[0][1]).toMatchObject({ title: 'Delete Workspace' });
  });

  it('A7. confirming delete calls deleteWorkspace and refreshes list', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    mockAsk.mockResolvedValue(true);
    mockDeleteWorkspace.mockResolvedValue(undefined);

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));

    fireEvent.click(screen.getAllByTitle('Delete workspace')[0]);

    await waitFor(() => {
      expect(mockDeleteWorkspace).toHaveBeenCalledWith('ws_1');
    });
    // refreshWorkspaces() runs after delete → second getRecent call
    expect(mockGetRecent).toHaveBeenCalledTimes(2);
  });

  it('A8. cancelling delete does NOT call deleteWorkspace', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    mockAsk.mockResolvedValue(false);

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));

    fireEvent.click(screen.getAllByTitle('Delete workspace')[0]);

    // wait one microtask for the ask() promise to settle
    await Promise.resolve();
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// B. File selection
// ═════════════════════════════════════════════════════════════════════════

describe('B. File selection', () => {
  it('B9. clicking "browse" calls selectFiles', () => {
    const hook = makeDataUpload();
    useDataUploadMock.mockReturnValue(hook);

    render(<DataUploadPage onDataReady={onDataReady} />);

    fireEvent.click(screen.getByText('browse').closest('button')!);
    expect(hook.selectFiles).toHaveBeenCalledTimes(1);
  });

  it('B10. selected files render in the list with filename only', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/path/to/run-01.csv', '/other/run-02.csv'] })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('run-01.csv')).toBeTruthy();
    expect(screen.getByText('run-02.csv')).toBeTruthy();
    // Full path also rendered as subtitle
    expect(screen.getByText('/path/to/run-01.csv')).toBeTruthy();
  });

  it('B11. clicking remove on a file row calls removeFile(path)', () => {
    const hook = makeDataUpload({ selectedFiles: ['/path/to/run-01.csv'] });
    useDataUploadMock.mockReturnValue(hook);

    render(<DataUploadPage onDataReady={onDataReady} />);

    const row = rowFor('run-01.csv');
    fireEvent.click(within(row).getByRole('button'));

    expect(hook.removeFile).toHaveBeenCalledWith('/path/to/run-01.csv');
  });

  it('B12. browse button is disabled while isLoading', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ isLoading: true }));

    render(<DataUploadPage onDataReady={onDataReady} />);

    const browseBtn = screen.getByText('browse').closest('button') as HTMLButtonElement;
    expect(browseBtn.disabled).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// C. Dataset parse
// ═════════════════════════════════════════════════════════════════════════

describe('C. Dataset parse', () => {
  it('C13. clicking "Parse files" calls uploadDataset', () => {
    const hook = makeDataUpload({ selectedFiles: ['/x.csv'] });
    useDataUploadMock.mockReturnValue(hook);

    render(<DataUploadPage onDataReady={onDataReady} />);

    fireEvent.click(screen.getByText('Parse files'));
    expect(hook.uploadDataset).toHaveBeenCalledTimes(1);
  });

  it('C14. while parsing, button shows "Parsing…" and is disabled', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], isLoading: true })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('Parsing…')).toBeTruthy();
    const parsingBtn = screen.getByText('Parsing…').closest('button') as HTMLButtonElement;
    expect(parsingBtn.disabled).toBe(true);
  });

  it('C15. dataUpload.error renders inside the dataset card', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], error: 'CSV parse failed at row 42' })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('CSV parse failed at row 42')).toBeTruthy();
  });

  it('C16. after successful parse, status bar shows formatted row count', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('Ready · 1,234 rows')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D. Mapping card
// ═════════════════════════════════════════════════════════════════════════

describe('D. Mapping card', () => {
  it('D17. mapping is locked with placeholder when dataset is not parsed', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload());

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('Parse dataset first')).toBeTruthy();
    expect(screen.queryByText('Select mapping CSV')).toBeNull();
  });

  // Mapping card opens only when isReady — which now requires hasFiles too,
  // not just a loadReport. Every "ready" fixture sets both.
  const readyUpload = () =>
    makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT });

  it('D18. clicking "Select mapping CSV" calls selectMappingFile', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    const m = makeMapping();
    useMappingDataMock.mockReturnValue(m);

    render(<DataUploadPage onDataReady={onDataReady} />);

    fireEvent.click(screen.getByText('Select mapping CSV').closest('button')!);
    expect(m.selectMappingFile).toHaveBeenCalledTimes(1);
  });

  it('D19. loaded mapping shows filename and row count', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(
      makeMapping({
        mappingFilePath: '/lookup/sensors.csv',
        mappingData: FAKE_MAPPING_DATA,
      })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('sensors.csv')).toBeTruthy();
    expect(screen.getByText('3 rows')).toBeTruthy();
  });

  it('D20. clicking clear-mapping button calls clearMapping', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    const m = makeMapping({
      mappingFilePath: '/lookup/sensors.csv',
      mappingData: FAKE_MAPPING_DATA,
      keyColumn: 'tag',
      mappingResult: FAKE_MAPPING_RESULT,
    });
    useMappingDataMock.mockReturnValue(m);

    render(<DataUploadPage onDataReady={onDataReady} />);

    const row = rowFor('sensors.csv');
    fireEvent.click(within(row).getByRole('button'));

    expect(m.clearMapping).toHaveBeenCalledTimes(1);
  });

  it('D21. clicking an auto-detect column button calls setKeyColumn(header)', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    const m = makeMapping({
      mappingFilePath: '/lookup/sensors.csv',
      mappingData: FAKE_MAPPING_DATA,
      keyColumn: null,
    });
    useMappingDataMock.mockReturnValue(m);

    render(<DataUploadPage onDataReady={onDataReady} />);

    fireEvent.click(screen.getByText('tag'));
    expect(m.setKeyColumn).toHaveBeenCalledWith('tag');
  });

  it('D22. auto-apply effect fires applyMapping(report.headers) when prereqs are met', async () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    const m = makeMapping({
      mappingFilePath: '/lookup/sensors.csv',
      mappingData: FAKE_MAPPING_DATA,
      keyColumn: 'tag',
      mappingResult: null,
      isLoading: false,
    });
    useMappingDataMock.mockReturnValue(m);

    render(<DataUploadPage onDataReady={onDataReady} />);

    await waitFor(() => {
      expect(m.applyMapping).toHaveBeenCalledWith(FAKE_REPORT.headers);
    });
  });

  it('D23. mapping.error renders the error block', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(
      makeMapping({
        mappingFilePath: '/lookup/sensors.csv',
        mappingData: FAKE_MAPPING_DATA,
        error: 'Mapping file missing key column',
      })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('Mapping file missing key column')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E. Continue → Dashboard
// ═════════════════════════════════════════════════════════════════════════

describe('E. Continue button', () => {
  it('E24. Continue is disabled until dataset is ready', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: ['/x.csv'] }));

    render(<DataUploadPage onDataReady={onDataReady} />);

    const btn = screen.getByText('Continue').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('E25. clicking Continue saves a WorkspaceState with dashboard route', async () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/a.csv', '/b.csv'], loadReport: FAKE_REPORT })
    );
    useMappingDataMock.mockReturnValue(
      makeMapping({ mappingFilePath: '/lookup/sensors.csv', keyColumn: 'tag' })
    );
    mockSaveWorkspace.mockResolvedValue(undefined);

    render(<DataUploadPage onDataReady={onDataReady} />);
    fireEvent.click(screen.getByText('Continue').closest('button')!);

    await waitFor(() => expect(mockSaveWorkspace).toHaveBeenCalledTimes(1));
    const saved = mockSaveWorkspace.mock.calls[0][0] as WorkspaceState;
    expect(saved).toMatchObject({
      lastRoute: 'dashboard',
      dataFilePaths: ['/a.csv', '/b.csv'],
      mappingFilePath: '/lookup/sensors.csv',
      mappingKeyColumn: 'tag',
      metadataFilePath: null,
      selectedSensors: [],
      visibleSensors: [],
      operationConfig: null,
    });
    expect(saved.id).toMatch(/^ws_\d+$/);
    expect(saved.name).toContain('Workspace');
  });

  it('E26. after save, onDataReady is called with metadata + state + sensorMetadata', async () => {
    const sm: SensorMetadata[] = [
      { tag: 'sensor_a', description: 'Pressure A', unit: 'psi', component: 'pump' },
    ];
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/a.csv'], loadReport: FAKE_REPORT })
    );
    useMappingDataMock.mockReturnValue(makeMapping({ sensorMetadata: sm }));
    mockSaveWorkspace.mockResolvedValue(undefined);

    render(<DataUploadPage onDataReady={onDataReady} />);
    fireEvent.click(screen.getByText('Continue').closest('button')!);

    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
    const [metaArg, stateArg, smArg] = onDataReady.mock.calls[0];
    expect(metaArg).toEqual<CsvMetadata>({
      headers: FAKE_REPORT.headers,
      total_rows: FAKE_REPORT.total_rows,
    });
    expect(stateArg.lastRoute).toBe('dashboard');
    expect(smArg).toBe(sm);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F. Load workspace flow
// ═════════════════════════════════════════════════════════════════════════

const baseLoadedWs: WorkspaceState = {
  id: 'ws_1',
  name: 'Engine pressure run',
  lastRoute: 'dashboard',
  dataFilePaths: ['/data/run-01.csv'],
  metadataFilePath: null,
  selectedSensors: [],
  visibleSensors: [],
  operationConfig: null,
  mappingFilePath: null,
  mappingKeyColumn: null,
};

describe('F. Load workspace flow', () => {
  beforeEach(() => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
  });

  it('F27. invokes load_csv with the workspace data paths', async () => {
    mockLoadWorkspace.mockResolvedValue(baseLoadedWs);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_csv') {
        return Promise.resolve({ headers: ['timestamp', 'sensor_a'], total_rows: 100 });
      }
      return Promise.resolve(null);
    });

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));
    fireEvent.click(screen.getByText('Engine pressure run'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('load_csv', { paths: ['/data/run-01.csv'] });
    });
  });

  it('F28. if workspace has mapping, invokes load_mapping_csv + apply_sensor_mapping', async () => {
    mockLoadWorkspace.mockResolvedValue({
      ...baseLoadedWs,
      mappingFilePath: '/lookup/sensors.csv',
      mappingKeyColumn: 'tag',
    });
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case 'load_csv':
          return Promise.resolve({ headers: ['timestamp', 'sensor_a'], total_rows: 100 });
        case 'load_mapping_csv':
          return Promise.resolve(FAKE_MAPPING_DATA);
        case 'apply_sensor_mapping':
          return Promise.resolve(FAKE_MAPPING_RESULT);
        default:
          return Promise.resolve(null);
      }
    });
    buildSensorMetadataMock.mockReturnValue([
      { tag: 'sensor_a', description: 'Pressure A', unit: '', component: '' },
    ]);

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));
    fireEvent.click(screen.getByText('Engine pressure run'));

    await waitFor(() => {
      const cmds = mockInvoke.mock.calls.map((c) => c[0]);
      expect(cmds).toContain('load_mapping_csv');
      expect(cmds).toContain('apply_sensor_mapping');
    });
  });

  it('F29. with only metadataFilePath, invokes load_metadata_command', async () => {
    mockLoadWorkspace.mockResolvedValue({
      ...baseLoadedWs,
      metadataFilePath: '/meta/sensors.json',
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_csv') return Promise.resolve({ headers: [], total_rows: 0 });
      if (cmd === 'load_metadata_command') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));
    fireEvent.click(screen.getByText('Engine pressure run'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('load_metadata_command', { path: '/meta/sensors.json' });
    });
  });

  it('F30. dashboard route falls through to onDataReady with loaded state', async () => {
    const loaded = { ...baseLoadedWs };
    mockLoadWorkspace.mockResolvedValue(loaded);
    const loadedMeta: CsvMetadata = { headers: ['timestamp', 'sensor_a'], total_rows: 99 };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'load_csv') return Promise.resolve(loadedMeta);
      return Promise.resolve(null);
    });

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));
    fireEvent.click(screen.getByText('Engine pressure run'));

    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
    const [metaArg, stateArg, smArg] = onDataReady.mock.calls[0];
    expect(metaArg).toEqual(loadedMeta);
    expect(stateArg).toEqual(loaded);
    expect(smArg).toBeNull();
  });

  it('F31. load failure renders workspaceError and clears active workspace', async () => {
    mockLoadWorkspace.mockRejectedValue(new Error('disk read failed'));

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));
    fireEvent.click(screen.getByText('Engine pressure run'));

    await waitFor(() => {
      expect(screen.getByText(/disk read failed/)).toBeTruthy();
    });
    // Spinner is gone (loadingWorkspace cleared)
    expect(screen.queryByText('Loading workspace…')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// G. Empty-state hint + status bar
// ═════════════════════════════════════════════════════════════════════════

describe('G. Empty-state hint + status bar', () => {
  it('G32. no files → "Add at least one CSV file to continue."', () => {
    render(<DataUploadPage onDataReady={onDataReady} />);
    expect(screen.getByText('Add at least one CSV file to continue.')).toBeTruthy();
    expect(screen.getByText('Awaiting data')).toBeTruthy();
  });

  it('G33. files present but unparsed → "Click Parse files to validate and continue."', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: ['/x.csv'] }));
    render(<DataUploadPage onDataReady={onDataReady} />);
    expect(screen.getByText('Click Parse files to validate and continue.')).toBeTruthy();
  });

  it('G34. parsed dataset hides the hint and shows Ready status', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.queryByText('Add at least one CSV file to continue.')).toBeNull();
    expect(screen.queryByText('Click Parse files to validate and continue.')).toBeNull();
    expect(screen.getByText('Ready · 1,234 rows')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// H. Theme observer
// ═════════════════════════════════════════════════════════════════════════

describe('H. Theme observer', () => {
  it('H35. respects the initial data-theme=light attribute', () => {
    document.documentElement.setAttribute('data-theme', 'light');

    const { container } = render(<DataUploadPage onDataReady={onDataReady} />);
    const root = container.firstChild as HTMLElement;

    // LIGHT.bg = "#f6f6f7"
    expect(root.style.background).toBe('rgb(246, 246, 247)');
  });

  it('H36. reacts to runtime data-theme changes via MutationObserver', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');

    const { container } = render(<DataUploadPage onDataReady={onDataReady} />);
    const root = container.firstChild as HTMLElement;
    // DARK.bg = "#0a0a0b"
    expect(root.style.background).toBe('rgb(10, 10, 11)');

    document.documentElement.setAttribute('data-theme', 'light');

    await waitFor(() => {
      expect(root.style.background).toBe('rgb(246, 246, 247)');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// I. Stale-report state (post-parse file edits)
//   Regression coverage for two reported bugs:
//     1. After parsing, editing the file list left no way to re-parse
//        (Parse button only appeared while !isReady).
//     2. Continue stayed enabled even when files had been removed after parse.
//   Both are now driven by the page-level `isReady = hasReport && !isStale &&
//   hasFiles` derivation.
// ═════════════════════════════════════════════════════════════════════════

describe('I. Stale-report state', () => {
  it('I37. stale report → Parse button visible again', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: ['/a.csv'],     // user removed /b.csv since parse
        loadReport: FAKE_REPORT,
        isStale: true,
      })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('Parse files')).toBeTruthy();
  });

  it('I38. stale report → Continue button is disabled', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: ['/a.csv'],
        loadReport: FAKE_REPORT,
        isStale: true,
      })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    const btn = screen.getByText('Continue').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('I39. stale + has files → "selection changed" hint replaces the default hint', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: ['/a.csv'],
        loadReport: FAKE_REPORT,
        isStale: true,
      })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(
      screen.getByText('File selection changed — click Parse files to re-validate.')
    ).toBeTruthy();
    // The non-stale variants must NOT also be on screen
    expect(screen.queryByText('Click Parse files to validate and continue.')).toBeNull();
    expect(screen.queryByText('Add at least one CSV file to continue.')).toBeNull();
  });

  it('I40. stale → status bar shows "Selection changed · re-parse required"', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: ['/a.csv'],
        loadReport: FAKE_REPORT,
        isStale: true,
      })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('Selection changed · re-parse required')).toBeTruthy();
    expect(screen.queryByText(/^Ready ·/)).toBeNull();
  });

  it('I41. stale → mapping card relocks with "Parse dataset first" placeholder', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: ['/a.csv'],
        loadReport: FAKE_REPORT,
        isStale: true,
      })
    );
    // Even if a previous mapping was loaded, the card relocks until re-parse.
    useMappingDataMock.mockReturnValue(
      makeMapping({
        mappingFilePath: '/lookup/sensors.csv',
        mappingData: FAKE_MAPPING_DATA,
        keyColumn: 'tag',
        mappingResult: FAKE_MAPPING_RESULT,
      })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(screen.getByText('Parse dataset first')).toBeTruthy();
    expect(screen.queryByText('sensors.csv')).toBeNull();
  });

  it('I42. removing all files after parse → Continue disabled, no Parse button (nothing to parse)', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: [],                  // user removed everything
        loadReport: FAKE_REPORT,            // but old report still in hook state
        isStale: true,
      })
    );

    render(<DataUploadPage onDataReady={onDataReady} />);

    const continueBtn = screen.getByText('Continue').closest('button') as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);
    // hasFiles=false → Parse button can't show even though stale
    expect(screen.queryByText('Parse files')).toBeNull();
    // Hint falls back to "Add at least one CSV file…" because !hasFiles
    expect(screen.getByText('Add at least one CSV file to continue.')).toBeTruthy();
  });
});
