import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react';
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
// Onboarding navigation helpers
//
// The page boots into step 0 ("Get started" — new project vs. recent). The
// dataset UI every group below asserts against lives on step 2, reached via:
//   step 0 ──"Create new project"──▶ step 1 ──name + Continue──▶ step 2
// so the groups that only care about the upload/mapping surface walk the flow
// first and then assert exactly as before. The step 0 / step 1 screens have
// their own coverage in group J.
// ─────────────────────────────────────────────────────────────────────────

const NAME_PLACEHOLDER = /Compressor Line 3/;
const DESC_PLACEHOLDER = 'What is this workspace for?';
const PROJECT_NAME = 'Test project';

const renderPage = () => render(<DataUploadPage onDataReady={onDataReady} />);

const continueButton = () =>
  screen.getByText('Continue').closest('button') as HTMLButtonElement;

/** Render and advance to step 1 ("Create your project"). */
function renderAtStep1() {
  const utils = renderPage();
  fireEvent.click(screen.getByText('Create new project'));
  return utils;
}

/** Render and advance to step 2 ("Prepare your dataset"), naming the project
 *  on the way through since step 1's Continue is gated on a non-empty name. */
function renderAtStep2({
  name = PROJECT_NAME,
  description,
}: { name?: string; description?: string } = {}) {
  const utils = renderAtStep1();
  fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), {
    target: { value: name },
  });
  if (description !== undefined) {
    fireEvent.change(screen.getByPlaceholderText(DESC_PLACEHOLDER), {
      target: { value: description },
    });
  }
  fireEvent.click(continueButton());
  return utils;
}

// ─────────────────────────────────────────────────────────────────────────
// Default setup — each test overrides only what it needs
// ─────────────────────────────────────────────────────────────────────────

// Capture the most recent focus-change handler so tests can simulate
// `tauri://focus` events without going through the IPC layer.
let lastFocusHandler: ((e: { payload: boolean }) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.setAttribute('data-theme', 'dark');
  mockGetRecent.mockResolvedValue([]);
  // `listen` must return a Promise<unlisten>; the page chains `.then()` on it
  // (e.g. the `upload-page-resumed` subscription). Default to a no-op.
  mockListen.mockResolvedValue(() => {});
  // `getCurrentWindow()` is called for: (a) onFocusChanged subscription,
  // (b) destroy() in handleLoadWorkspace's FG-route branch, (c) hide() in the
  // same branch. Return a stub covering all three. The focus handler is
  // captured so I43 can fire it manually.
  lastFocusHandler = null;
  mockGetCurrentWindow.mockReturnValue({
    onFocusChanged: vi.fn(async (handler: (e: { payload: boolean }) => void) => {
      lastFocusHandler = handler;
      return () => {};
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined),
  });
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

  // The sidebar is suppressed on step 0 (the choice screen lists recents
  // itself); it reappears from step 1 onwards, so its own tests start there.
  it('A2. shows "No workspaces yet" when list is empty', async () => {
    mockGetRecent.mockResolvedValue([]);
    renderAtStep1();
    await waitFor(() => {
      expect(screen.getByText('No workspaces yet')).toBeTruthy();
    });
  });

  it('A3. search filters workspaces case-insensitively', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    renderAtStep1();
    await waitFor(() => screen.getByText('Engine pressure run'));

    const input = screen.getByPlaceholderText('Find workspace…');
    fireEvent.change(input, { target: { value: 'COMPRESSOR' } });

    expect(screen.queryByText('Engine pressure run')).toBeNull();
    expect(screen.getByText('Compressor health')).toBeTruthy();
  });

  it('A4. shows "No matches" when search has no hits', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    renderAtStep1();
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

    renderAtStep2();

    fireEvent.click(screen.getByText('browse').closest('button')!);
    expect(hook.selectFiles).toHaveBeenCalledTimes(1);
  });

  it('B10. selected files render in the list with filename only', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/path/to/run-01.csv', '/other/run-02.csv'] })
    );

    renderAtStep2();

    expect(screen.getByText('run-01.csv')).toBeTruthy();
    expect(screen.getByText('run-02.csv')).toBeTruthy();
    // Full path also rendered as subtitle
    expect(screen.getByText('/path/to/run-01.csv')).toBeTruthy();
  });

  it('B11. clicking remove on a file row calls removeFile(path)', () => {
    const hook = makeDataUpload({ selectedFiles: ['/path/to/run-01.csv'] });
    useDataUploadMock.mockReturnValue(hook);

    renderAtStep2();

    const row = rowFor('run-01.csv');
    fireEvent.click(within(row).getByRole('button'));

    expect(hook.removeFile).toHaveBeenCalledWith('/path/to/run-01.csv');
  });

  it('B12. browse button is disabled while isLoading', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ isLoading: true }));

    renderAtStep2();

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

    renderAtStep2();

    fireEvent.click(screen.getByText('Parse files'));
    expect(hook.uploadDataset).toHaveBeenCalledTimes(1);
  });

  it('C14. while parsing, button shows "Parsing…" and is disabled', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], isLoading: true })
    );

    renderAtStep2();

    expect(screen.getByText('Parsing…')).toBeTruthy();
    const parsingBtn = screen.getByText('Parsing…').closest('button') as HTMLButtonElement;
    expect(parsingBtn.disabled).toBe(true);
  });

  it('C15. dataUpload.error renders inside the dataset card', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], error: 'CSV parse failed at row 42' })
    );

    renderAtStep2();

    expect(screen.getByText('CSV parse failed at row 42')).toBeTruthy();
  });

  it('C16. after successful parse, status bar shows formatted row count', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT })
    );

    renderAtStep2();

    expect(screen.getByText('Ready · 1,234 rows')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D. Mapping card
// ═════════════════════════════════════════════════════════════════════════

describe('D. Mapping card', () => {
  it('D17. mapping is locked with placeholder when dataset is not parsed', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload());

    renderAtStep2();

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

    renderAtStep2();

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

    renderAtStep2();

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

    renderAtStep2();

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

    renderAtStep2();

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

    renderAtStep2();

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

    renderAtStep2();

    expect(screen.getByText('Mapping file missing key column')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E. Continue → Dashboard
// ═════════════════════════════════════════════════════════════════════════

describe('E. Continue button', () => {
  it('E24. Continue is disabled until dataset is ready', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: ['/x.csv'] }));

    renderAtStep2();

    const btn = continueButton();
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

    // Name + description come from step 1 and are persisted by step 2's
    // Continue — this is the only place they get written to disk.
    renderAtStep2({ name: 'Line 3 baseline', description: 'Q3 compressor run' });
    fireEvent.click(continueButton());

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
      name: 'Line 3 baseline',
      description: 'Q3 compressor run',
    });
    expect(saved.id).toMatch(/^ws_\d+$/);

    // Drain the rest of handleContinue before finishing. Its 500 ms
    // MIN_TRANSITION_MS floor outlives the save, so bailing out here would
    // fire onDataReady during the NEXT test (after beforeEach cleared the
    // mocks) and be miscounted as that test's own call.
    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1), { timeout: 3000 });
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

    renderAtStep2();
    fireEvent.click(continueButton());

    // handleContinue holds a 500 ms MIN_TRANSITION_MS floor before handing off.
    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1), { timeout: 3000 });
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
    renderAtStep2();
    expect(screen.getByText('Add at least one CSV file to continue.')).toBeTruthy();
    expect(screen.getByText('Awaiting data')).toBeTruthy();
  });

  it('G33. files present but unparsed → "Click Parse files to validate and continue."', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: ['/x.csv'] }));
    renderAtStep2();
    expect(screen.getByText('Click Parse files to validate and continue.')).toBeTruthy();
  });

  it('G34. parsed dataset hides the hint and shows Ready status', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT })
    );

    renderAtStep2();

    expect(screen.queryByText('Add at least one CSV file to continue.')).toBeNull();
    expect(screen.queryByText('Click Parse files to validate and continue.')).toBeNull();
    expect(screen.getByText('Ready · 1,234 rows')).toBeTruthy();
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

    renderAtStep2();

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

    renderAtStep2();

    const btn = continueButton();
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

    renderAtStep2();

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

    renderAtStep2();

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

    renderAtStep2();

    expect(screen.getByText('Parse dataset first')).toBeTruthy();
    expect(screen.queryByText('sensors.csv')).toBeNull();
  });

  it('I43. firing `upload-page-resumed` clears stuck loadingWorkspace state', async () => {
    // Regression: sub-window (FG / PM) "Back to Upload" reuses the existing
    // main webview via WebviewWindow.getByLabel('main') → show()+setFocus().
    // React state survives, so `loadingWorkspace=true` (set when the user
    // originally clicked the Recent Workspace row) was getting stuck — the
    // navigation that was supposed to flip it off already happened in the
    // sub-window's lifetime. The sub-window now emits `upload-page-resumed`
    // before closing; this test verifies the page's listener clears the flag.
    mockGetRecent.mockResolvedValue([
      { id: 'ws_1', name: 'Stuck workspace', lastModified: Date.now(), filePath: '/ws/ws_1.json' },
    ] satisfies WorkspaceMetadata[]);
    // Make loadWorkspaceData hang so loadingWorkspace stays true.
    mockLoadWorkspace.mockReturnValue(new Promise(() => { /* never resolves */ }));

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => expect(screen.getByText('Stuck workspace')).toBeTruthy());

    fireEvent.click(screen.getByText('Stuck workspace'));
    await waitFor(() => expect(screen.getByText('Loading workspace…')).toBeTruthy());

    // Locate the `upload-page-resumed` listener specifically — `mockListen`
    // may have other registrations too, so find() disambiguates by event name.
    const resumeCall = mockListen.mock.calls.find((c) => c[0] === 'upload-page-resumed');
    expect(resumeCall).toBeDefined();
    const handler = resumeCall![1] as (e: { event: string; payload: undefined; id: number }) => void;

    await act(async () => {
      handler({ event: 'upload-page-resumed', payload: undefined, id: 0 });
    });

    await waitFor(() => {
      expect(screen.queryByText('Loading workspace…')).toBeNull();
    });
  });

  it('I44. fallback: window regaining focus >2s into a stuck load also clears the spinner', async () => {
    // Defense-in-depth for the same regression as I43. If the explicit
    // `upload-page-resumed` event is dropped (IPC swallowed, sub-window
    // force-quit, etc.), the `tauri://focus` event still fires when main
    // becomes the active window again — we use that as a secondary signal.
    vi.useFakeTimers();
    try {
      mockGetRecent.mockResolvedValue([
        { id: 'ws_1', name: 'Stuck workspace', lastModified: Date.now(), filePath: '/ws/ws_1.json' },
      ] satisfies WorkspaceMetadata[]);
      mockLoadWorkspace.mockReturnValue(new Promise(() => { /* never resolves */ }));

      render(<DataUploadPage onDataReady={onDataReady} />);
      await vi.waitFor(() => expect(screen.getByText('Stuck workspace')).toBeTruthy());

      fireEvent.click(screen.getByText('Stuck workspace'));
      await vi.waitFor(() => expect(screen.getByText('Loading workspace…')).toBeTruthy());

      // Simulate enough wall-clock to exceed the 2 s freshness window the
      // focus handler uses to decide stale.
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });

      // The focus handler is registered during the page's mount effect.
      // `lastFocusHandler` captures it (see beforeEach).
      expect(lastFocusHandler).not.toBeNull();
      await act(async () => {
        lastFocusHandler!({ payload: true });
      });

      await vi.waitFor(() => {
        expect(screen.queryByText('Loading workspace…')).toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('I42. removing all files after parse → Continue disabled, no Parse button (nothing to parse)', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: [],                  // user removed everything
        loadReport: FAKE_REPORT,            // but old report still in hook state
        isStale: true,
      })
    );

    renderAtStep2();

    const continueBtn = continueButton();
    expect(continueBtn.disabled).toBe(true);
    // hasFiles=false → Parse button can't show even though stale
    expect(screen.queryByText('Parse files')).toBeNull();
    // Hint falls back to "Add at least one CSV file…" because !hasFiles
    expect(screen.getByText('Add at least one CSV file to continue.')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// J. Onboarding flow (step 0 → 1 → 2)
//   The page no longer boots straight into the upload UI. Step 0 is the
//   new-project-vs-recent branch point, step 1 names the project, step 2 is
//   the dataset surface every other group above asserts against. These tests
//   cover the two screens the helpers walk through.
// ═════════════════════════════════════════════════════════════════════════

describe('J. Onboarding flow', () => {
  it('J45. boots into step 0 with both start choices and no dataset UI', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);

    renderPage();

    expect(screen.getByText('Get started')).toBeTruthy();
    expect(screen.getByText('Create new project')).toBeTruthy();
    expect(screen.getByText('Open recent project')).toBeTruthy();
    expect(screen.getByText('Pick an option above to get started')).toBeTruthy();
    // Step 2's surface must not be mounted yet…
    expect(screen.queryByText('Dataset files')).toBeNull();
    expect(screen.queryByText('browse')).toBeNull();
    expect(screen.queryByText('Continue')).toBeNull();
    // …nor the sidebar, which would duplicate the recents list on this step.
    expect(screen.queryByPlaceholderText('Find workspace…')).toBeNull();

    await waitFor(() => expect(screen.getByText('Engine pressure run')).toBeTruthy());
  });

  it('J46. step 0 with no saved workspaces shows the empty-recents copy', async () => {
    mockGetRecent.mockResolvedValue([]);

    renderPage();

    await waitFor(() => expect(screen.getByText('No saved projects yet')).toBeTruthy());
    // The sidebar's differently-worded empty state belongs to step 1+
    expect(screen.queryByText('No workspaces yet')).toBeNull();
  });

  it('J47. step 0 previews 3 recents and expands the rest via "Show all"', async () => {
    const many: WorkspaceMetadata[] = [1, 2, 3, 4, 5].map((n) => ({
      id: `ws_${n}`,
      name: `Project ${n}`,
      lastModified: 1_700_000_000_000 + n,
      filePath: `/ws/ws_${n}.json`,
    }));
    mockGetRecent.mockResolvedValue(many);

    renderPage();

    await waitFor(() => expect(screen.getByText('Project 1')).toBeTruthy());
    expect(screen.getByText('Project 3')).toBeTruthy();
    expect(screen.queryByText('Project 4')).toBeNull();

    fireEvent.click(screen.getByText('Show all 5 projects…'));

    expect(screen.getByText('Project 4')).toBeTruthy();
    expect(screen.getByText('Project 5')).toBeTruthy();
  });

  it('J48. "Create new project" advances to step 1 and reveals the sidebar', () => {
    renderPage();

    fireEvent.click(screen.getByText('Create new project'));

    expect(screen.getByText('Create your project')).toBeTruthy();
    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER)).toBeTruthy();
    expect(screen.getByPlaceholderText(DESC_PLACEHOLDER)).toBeTruthy();
    // Step indicator only exists from step 1 onwards
    expect(screen.getByText('Create project')).toBeTruthy();
    expect(screen.getByText('Prepare dataset')).toBeTruthy();
    // Sidebar comes back so the user can still switch workspaces mid-flow
    expect(screen.getByPlaceholderText('Find workspace…')).toBeTruthy();
  });

  it('J49. step 1 Continue stays disabled until a non-blank project name is entered', () => {
    renderAtStep1();

    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText('Enter a project name to continue')).toBeTruthy();

    // Whitespace-only is still "empty" — canCreateProject trims.
    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), {
      target: { value: '   ' },
    });
    expect(continueButton().disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), {
      target: { value: 'Line 3 baseline' },
    });
    expect(continueButton().disabled).toBe(false);
    expect(screen.getByText('Ready to continue')).toBeTruthy();
  });

  it('J50. clicking the disabled Continue on step 1 does not advance', () => {
    renderAtStep1();

    fireEvent.click(continueButton());

    expect(screen.getByText('Create your project')).toBeTruthy();
    expect(screen.queryByText('Prepare your dataset')).toBeNull();
  });

  it('J51. a named project + Continue advances to step 2', () => {
    renderAtStep1();

    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), {
      target: { value: 'Line 3 baseline' },
    });
    fireEvent.click(continueButton());

    expect(screen.getByText('Prepare your dataset')).toBeTruthy();
    expect(screen.getByText('Dataset files')).toBeTruthy();
    expect(screen.getByText('browse')).toBeTruthy();
  });

  it('J52. Back walks step 2 → 1 → 0, preserving what was typed', () => {
    renderAtStep2({ name: 'Line 3 baseline', description: 'Q3 compressor run' });

    fireEvent.click(screen.getByText('‹ Back'));

    expect(screen.getByText('Create your project')).toBeTruthy();
    expect((screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement).value)
      .toBe('Line 3 baseline');
    expect((screen.getByPlaceholderText(DESC_PLACEHOLDER) as HTMLTextAreaElement).value)
      .toBe('Q3 compressor run');

    fireEvent.click(screen.getByText('‹ Back'));

    expect(screen.getByText('Get started')).toBeTruthy();
    expect(screen.getByText('Create new project')).toBeTruthy();
    expect(screen.queryByText('Continue')).toBeNull();
  });

  it('J53. step-indicator bubbles navigate backward only', () => {
    renderAtStep2();

    // step 2 → 1 by clicking the completed "Create project" bubble
    fireEvent.click(screen.getByText('Create project'));
    expect(screen.getByText('Create your project')).toBeTruthy();

    // …but the step-2 bubble is not a shortcut forward; that path has to go
    // through Continue so the project-name validation always runs.
    fireEvent.click(screen.getByText('Prepare dataset'));
    expect(screen.getByText('Create your project')).toBeTruthy();
    expect(screen.queryByText('Prepare your dataset')).toBeNull();
  });
});
