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
import { getErrors, dismissAllErrors } from '../errorReporter';

// ─────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────

// 2026-10-04: deleting a project confirms IN THE ROW now, not through a Tauri
// `ask` dialog -- so no `ask` mock here (A6/A6b assert the in-row flow).
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
}));

const mockInvoke = vi.fn();
const mockListen = vi.fn();
const mockEmit = vi.fn();
const mockGetByLabel = vi.fn();
const mockGetCurrentWindow = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
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

// The app version shown in the step-0 footer.
const mockGetVersion = vi.fn();
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
}));

// The step-0 illustration runs a canvas animation (requestAnimationFrame + 2D
// context), which jsdom cannot do -- stand in a marker element.
vi.mock('../components/upload/MachineMorphCanvas', () => ({
  default: (props: { variant?: string; style?: React.CSSProperties }) => (
    <div data-testid="machine-canvas" data-variant={props.variant} style={props.style} />
  ),
}));

// workspaceManager — all 5 functions used by DataUploadPage
const mockGetRecent = vi.fn();
const mockLoadWorkspace = vi.fn();
const mockSaveWorkspace = vi.fn();
const mockDeleteWorkspace = vi.fn();
const mockRenameWorkspaceFile = vi.fn();

vi.mock('../workspaceManager', () => ({
  getRecentWorkspaces: (...args: unknown[]) => mockGetRecent(...args),
  loadWorkspaceData: (...args: unknown[]) => mockLoadWorkspace(...args),
  saveWorkspaceData: (...args: unknown[]) => mockSaveWorkspace(...args),
  deleteWorkspace: (...args: unknown[]) => mockDeleteWorkspace(...args),
  renameWorkspaceFile: (...args: unknown[]) => mockRenameWorkspaceFile(...args),
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
// dataset UI every group below asserts against lives on step 2 ("Add your sensor
// data"), reached via:
//   step 0 ──"New project"──▶ step 1 ──name + Continue──▶ step 2
// so the groups that only care about the upload/mapping surface walk the flow
// first and then assert exactly as before. The step 0 / step 1 screens have
// their own coverage in group J.
// ─────────────────────────────────────────────────────────────────────────

const NAME_PLACEHOLDER = /Compressor Line 3/;
const DESC_PLACEHOLDER = 'What is this workspace for?';
const PROJECT_NAME = 'Test project';

const renderPage = () => render(<DataUploadPage onDataReady={onDataReady} />);

const newProjectButton = () => screen.getByRole('button', { name: /New project/ });

/** Step 1's primary button. */
const continueButton = () =>
  screen.getByText('Continue').closest('button') as HTMLButtonElement;

/** Step 2's primary button (was "Continue" before the 2026-10-04 redesign). */
const openDashboardButton = () =>
  screen.getByText('Open Dashboard').closest('button') as HTMLButtonElement;

/** Render and advance to step 1 ("Name your project"). */
function renderAtStep1() {
  const utils = renderPage();
  fireEvent.click(newProjectButton());
  return utils;
}

/** Render and advance to step 2 ("Add your sensor data"), naming the project
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
  mockGetRecent.mockResolvedValue([]);
  mockGetVersion.mockResolvedValue('9.8.7');
  mockDeleteWorkspace.mockResolvedValue(undefined);
  mockRenameWorkspaceFile.mockResolvedValue(undefined);
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
// A. Recent projects (step 0 cards; the old step 1-2 sidebar no longer exists)
// ═════════════════════════════════════════════════════════════════════════

describe('A. Recent projects', () => {
  it('A1. fetches and renders recent workspaces on mount', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);

    render(<DataUploadPage onDataReady={onDataReady} />);

    expect(mockGetRecent).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('Engine pressure run')).toBeTruthy();
      expect(screen.getByText('Compressor health')).toBeTruthy();
    });
  });

  it('A2. steps 1 and 2 have no "Find workspace" sidebar / Recent list any more (the setup rail replaced it)', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    renderAtStep1();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByPlaceholderText('Find workspace…')).toBeNull();
    expect(screen.queryByText('Recent')).toBeNull();
    expect(screen.queryByText('Engine pressure run')).toBeNull();
    expect(screen.queryByText('No workspaces yet')).toBeNull();
    expect(screen.getByTestId('setup-rail')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value: 'x' } });
    fireEvent.click(continueButton());
    expect(screen.queryByPlaceholderText('Find workspace…')).toBeNull();
    expect(screen.getByTestId('setup-rail')).toBeTruthy();
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

  it('A6. delete confirms IN THE ROW (no dialog): the trash button only opens the prompt; [Delete] removes the workspace and refreshes the list', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));

    fireEvent.click(screen.getByLabelText('Delete project Engine pressure run'));

    // Prompt shown, nothing deleted yet.
    const prompt = screen.getByRole('alertdialog', { name: 'Delete Engine pressure run?' });
    expect(within(prompt).getByText('Delete this project?')).toBeTruthy();
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();

    fireEvent.click(within(prompt).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDeleteWorkspace).toHaveBeenCalledWith('ws_1');
    });
    expect(mockDeleteWorkspace).toHaveBeenCalledTimes(1);
    // refreshWorkspaces() runs after delete → second getRecent call
    await waitFor(() => expect(mockGetRecent).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('A6b. [Cancel] (and Esc) in the delete prompt leave the workspace and its files alone', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);

    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText('Engine pressure run'));

    fireEvent.click(screen.getByLabelText('Delete project Engine pressure run'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByLabelText('Delete project Engine pressure run'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await act(async () => { await Promise.resolve(); });
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
    expect(mockGetRecent).toHaveBeenCalledTimes(1);
    // The delete prompt never opens the project either.
    expect(mockLoadWorkspace).not.toHaveBeenCalled();
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

    expect(screen.getByText('Ready · 1,234 rows · no tag names')).toBeTruthy();
  });

  it('C17. non-fatal load-report warnings (e.g. a Buddhist-Era year correction) render inside the dataset card', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: ['/x.csv'],
        loadReport: {
          ...FAKE_REPORT,
          warnings: [
            '288 timestamp(s) used a Buddhist-Era year (พ.ศ.) — converted to Gregorian (ค.ศ.) for display and calculations',
          ],
        },
      })
    );

    renderAtStep2();

    expect(screen.getByText(/Buddhist-Era year/)).toBeTruthy();
    // 2026-10-04: the box is headed "Fixed while reading"
    expect(screen.getByText('Fixed while reading')).toBeTruthy();
  });

  it('C18. no warnings banner when the load report has none', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT })
    );

    renderAtStep2();

    expect(screen.queryByText(/Buddhist-Era year/)).toBeNull();
    expect(screen.queryByText('Fixed while reading')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D. Mapping card
// ═════════════════════════════════════════════════════════════════════════

describe('D. Tag names panel', () => {
  it('D17. Tag names is locked with an explanation when the dataset is not parsed', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload());

    renderAtStep2();

    expect(screen.getByTestId('tag-names-locked')).toBeTruthy();
    expect(screen.getByText('Add sensor data first')).toBeTruthy();
    expect(screen.queryByText('Select tag-name CSV')).toBeNull();
  });

  // The Tag names panel opens only when isReady — which now requires hasFiles too,
  // not just a loadReport. Every "ready" fixture sets both.
  const readyUpload = () =>
    makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT });

  it('D18. clicking "Select tag-name CSV" calls selectMappingFile', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    const m = makeMapping();
    useMappingDataMock.mockReturnValue(m);

    renderAtStep2();

    fireEvent.click(screen.getByText('Select tag-name CSV').closest('button')!);
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
// E. Open Dashboard
// ═════════════════════════════════════════════════════════════════════════

describe('E. Open Dashboard button', () => {
  it('E24. Open Dashboard is disabled until dataset is ready', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: ['/x.csv'] }));

    renderAtStep2();

    const btn = openDashboardButton();
    expect(btn.disabled).toBe(true);
    // the old step-2 label is gone
    expect(screen.queryByText('Continue')).toBeNull();
  });

  it('E25. clicking Open Dashboard saves a WorkspaceState with dashboard route', async () => {
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
    fireEvent.click(openDashboardButton());

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
    fireEvent.click(openDashboardButton());

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

  describe('special sensor recipe replay (2026-09-01: rebuilds "Add Special Sensor" columns in the Rust backend\'s in-memory session right after load_csv — see WorkspaceState.specialSensorRecipes)', () => {
    beforeEach(() => {
      dismissAllErrors();
    });

    it("F32. replays a formula recipe via evaluate_formula, forcing customName to the recipe's own tag, before onDataReady fires", async () => {
      mockLoadWorkspace.mockResolvedValue({
        ...baseLoadedWs,
        specialSensorRecipes: [{ kind: 'formula', tag: 'CALC1', formula: '$sensor_a * 2' }],
      });
      const invokeOrder: string[] = [];
      mockInvoke.mockImplementation((cmd: string) => {
        invokeOrder.push(cmd);
        if (cmd === 'load_csv') return Promise.resolve({ headers: ['timestamp', 'sensor_a'], total_rows: 100 });
        if (cmd === 'evaluate_formula') return Promise.resolve('CALC1');
        return Promise.resolve(null);
      });

      render(<DataUploadPage onDataReady={onDataReady} />);
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByText('Engine pressure run'));

      await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
      expect(mockInvoke).toHaveBeenCalledWith('evaluate_formula',
        // `replace: true` since 2026-09-07: recomputing a recipe has to
        // overwrite the column of that name rather than append a second,
        // unreachable one. On a fresh load there is nothing to replace.
        { formula: '$sensor_a * 2', customName: 'CALC1', replace: true });
      // Replayed right after load_csv, before Dashboard ever sees the data.
      expect(invokeOrder.indexOf('load_csv')).toBeLessThan(invokeOrder.indexOf('evaluate_formula'));
      expect(getErrors()).toHaveLength(0); // it succeeded — no toast
    });

    it('F33. replays an operation recipe via calculate_new_sensor with sourceSensors + operationConfig, customName forced', async () => {
      mockLoadWorkspace.mockResolvedValue({
        ...baseLoadedWs,
        specialSensorRecipes: [{
          kind: 'operation', tag: 'CALC2', sourceSensors: ['sensor_a'],
          operationConfig: { mode: 'single', singleOp: { type: 'add', value: 5 } },
        }],
      });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'load_csv') return Promise.resolve({ headers: ['timestamp', 'sensor_a'], total_rows: 100 });
        if (cmd === 'calculate_new_sensor') return Promise.resolve('CALC2');
        return Promise.resolve(null);
      });

      render(<DataUploadPage onDataReady={onDataReady} />);
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByText('Engine pressure run'));

      await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
      expect(mockInvoke).toHaveBeenCalledWith('calculate_new_sensor', {
        sensors: ['sensor_a'],
        config: { mode: 'single', singleOp: { type: 'add', value: 5 }, customName: 'CALC2' },
        replace: true,
      });
    });

    it('F34. replays multiple recipes in array order, and one that throws does not block the rest or the workspace from opening — reported as one combined toast instead', async () => {
      mockLoadWorkspace.mockResolvedValue({
        ...baseLoadedWs,
        specialSensorRecipes: [
          { kind: 'formula', tag: 'BROKEN1', formula: '$deleted_sensor + 1' },
          { kind: 'formula', tag: 'CALC1', formula: '$sensor_a * 2' },
        ],
      });
      mockInvoke.mockImplementation((cmd: string, args?: any) => {
        if (cmd === 'load_csv') return Promise.resolve({ headers: ['timestamp', 'sensor_a'], total_rows: 100 });
        if (cmd === 'evaluate_formula') {
          if (args?.customName === 'BROKEN1') return Promise.reject(new Error('Sensor not found: deleted_sensor'));
          return Promise.resolve('CALC1');
        }
        return Promise.resolve(null);
      });

      render(<DataUploadPage onDataReady={onDataReady} />);
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByText('Engine pressure run'));

      // The workspace still opens — one failing recipe isn't fatal.
      await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
      // The second (valid) recipe still got replayed.
      expect(mockInvoke).toHaveBeenCalledWith('evaluate_formula',
        // `replace: true` since 2026-09-07: recomputing a recipe has to
        // overwrite the column of that name rather than append a second,
        // unreachable one. On a fresh load there is nothing to replace.
        { formula: '$sensor_a * 2', customName: 'CALC1', replace: true });
      // One toast naming the sensor that failed, not one per attempt.
      const errors = getErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].source).toBe('special-sensor-restore');
      expect(errors[0].message).toContain('BROKEN1');
    });

    // 2026-10-03: a recipe that can't be rebuilt used to leave a ghost -- still
    // plotted, no data -- and everything built on it failed one by one (or,
    // worse, read some other column of the same name).
    it('F35. a recipe built ON a failed one is skipped (never sent to the backend), reported in the same single toast, and every no-data sensor is dropped from the plotted selection while its recipe is kept', async () => {
      mockLoadWorkspace.mockResolvedValue({
        ...baseLoadedWs,
        selectedSensors: ['sensor_a', 'BROKEN1', 'DEP1', 'CALC1'],
        visibleSensors: ['sensor_a', 'BROKEN1', 'DEP1', 'CALC1'],
        specialSensorRecipes: [
          { kind: 'formula', tag: 'BROKEN1', formula: '$deleted_sensor + 1' },
          { kind: 'formula', tag: 'DEP1', formula: '${BROKEN1} * 2' },
          { kind: 'formula', tag: 'CALC1', formula: '$sensor_a * 2' },
        ],
      });
      const refs: Record<string, string[]> = {
        '$deleted_sensor + 1': ['deleted_sensor'], '${BROKEN1} * 2': ['BROKEN1'], '$sensor_a * 2': ['sensor_a'],
      };
      mockInvoke.mockImplementation((cmd: string, args?: any) => {
        if (cmd === 'load_csv') return Promise.resolve({ headers: ['timestamp', 'sensor_a'], total_rows: 100 });
        if (cmd === 'extract_formula_refs') return Promise.resolve((args.formulas as string[]).map(f => refs[f] ?? []));
        if (cmd === 'evaluate_formula') {
          if (args?.customName === 'BROKEN1') return Promise.reject(new Error('Sensor not found: deleted_sensor'));
          return Promise.resolve(args.customName);
        }
        return Promise.resolve(null);
      });

      render(<DataUploadPage onDataReady={onDataReady} />);
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByText('Engine pressure run'));
      await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));

      const built = mockInvoke.mock.calls.filter(c => c[0] === 'evaluate_formula').map(c => c[1].customName);
      expect(built).toEqual(['BROKEN1', 'CALC1']); // DEP1 was never attempted

      const errors = getErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("couldn't be restored: BROKEN1");
      expect(errors[0].message).toMatch(/Skipped.*DEP1/);

      const stateArg = onDataReady.mock.calls[0][1];
      expect(stateArg.selectedSensors).toEqual(['sensor_a', 'CALC1']);
      expect(stateArg.visibleSensors).toEqual(['sensor_a', 'CALC1']);
      // Recipes stay, so the sensor can still be fixed in Manage.
      expect(stateArg.specialSensorRecipes.map((r: any) => r.tag)).toEqual(['BROKEN1', 'DEP1', 'CALC1']);
    });

    it('F36. recipes are replayed in dependency order, not just array order (an old edit could leave a sensor stored before the one it reads)', async () => {
      mockLoadWorkspace.mockResolvedValue({
        ...baseLoadedWs,
        specialSensorRecipes: [
          { kind: 'formula', tag: 'A', formula: '$C * 2' },
          { kind: 'formula', tag: 'C', formula: '$sensor_a + 1' },
        ],
      });
      const refs: Record<string, string[]> = { '$C * 2': ['C'], '$sensor_a + 1': ['sensor_a'] };
      mockInvoke.mockImplementation((cmd: string, args?: any) => {
        if (cmd === 'load_csv') return Promise.resolve({ headers: ['timestamp', 'sensor_a'], total_rows: 100 });
        if (cmd === 'extract_formula_refs') return Promise.resolve((args.formulas as string[]).map(f => refs[f] ?? []));
        if (cmd === 'evaluate_formula') return Promise.resolve(args.customName);
        return Promise.resolve(null);
      });

      render(<DataUploadPage onDataReady={onDataReady} />);
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByText('Engine pressure run'));
      await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));

      expect(mockInvoke.mock.calls.filter(c => c[0] === 'evaluate_formula').map(c => c[1].customName)).toEqual(['C', 'A']);
      expect(getErrors()).toHaveLength(0);
      // Nothing failed -> the loaded state is handed over untouched.
      expect(onDataReady.mock.calls[0][1].selectedSensors).toEqual(baseLoadedWs.selectedSensors);
    });
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
    expect(screen.getByText('Ready · 1,234 rows · no tag names')).toBeTruthy();
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

  it('I38. stale report → Open Dashboard is disabled', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: ['/a.csv'],
        loadReport: FAKE_REPORT,
        isStale: true,
      })
    );

    renderAtStep2();

    const btn = openDashboardButton();
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

  it('I41. stale → Tag names relocks with the "Add sensor data first" explanation', () => {
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

    expect(screen.getByText('Add sensor data first')).toBeTruthy();
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

  it('I42. removing all files after parse → Open Dashboard disabled, no Parse button (nothing to parse)', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: [],                  // user removed everything
        loadReport: FAKE_REPORT,            // but old report still in hook state
        isStale: true,
      })
    );

    renderAtStep2();

    const continueBtn = openDashboardButton();
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
//   cover the two screens the helpers walk through (steps 1-2 share the setup
//   rail -- see groups M-Q for their own detail).
// ═════════════════════════════════════════════════════════════════════════

describe('J. Onboarding flow', () => {
  it('J45. boots into step 0 (Get started) with the hero, New project and no dataset UI', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);

    renderPage();

    expect(screen.getByTestId('home-step')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('See the failure before it happens.');
    expect(newProjectButton()).toBeTruthy();
    // Step 2's surface must not be mounted yet…
    expect(screen.queryByText('Sensor data')).toBeNull();
    expect(screen.queryByText('browse')).toBeNull();
    expect(screen.queryByText('Continue')).toBeNull();
    expect(screen.queryByText('Open Dashboard')).toBeNull();
    // …nor the step 1-2 chrome (setup rail, action bar).
    expect(screen.queryByTestId('setup-rail')).toBeNull();
    expect(screen.queryByPlaceholderText('Find workspace…')).toBeNull();

    await waitFor(() => expect(screen.getByText('Engine pressure run')).toBeTruthy());
    expect(screen.getByText('Recent projects')).toBeTruthy();
  });

  it('J46. step 0 with no saved workspaces shows the "No projects yet" card and the 3 first steps', async () => {
    mockGetRecent.mockResolvedValue([]);

    renderPage();

    await waitFor(() => expect(screen.getByText('No projects yet')).toBeTruthy());
    expect(screen.getByText('Name the project')).toBeTruthy();
    expect(screen.getByText('Add data')).toBeTruthy();
    expect(screen.getByText('Explore in Dashboard')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Find project')).toBeNull();
    // The sidebar's differently-worded empty state belongs to step 1+
    expect(screen.queryByText('No workspaces yet')).toBeNull();
  });

  it('J47. step 0 lists EVERY recent project as a card (no "Show all" cut-off any more)', async () => {
    const many: WorkspaceMetadata[] = [1, 2, 3, 4, 5].map((n) => ({
      id: `ws_${n}`,
      name: `Project ${n}`,
      lastModified: 1_700_000_000_000 + n,
      filePath: `/ws/ws_${n}.json`,
    }));
    mockGetRecent.mockResolvedValue(many);

    renderPage();

    await waitFor(() => expect(screen.getByText('Project 1')).toBeTruthy());
    expect(screen.getAllByTestId('project-card')).toHaveLength(5);
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it('J48. "New project" advances to step 1 and shows the setup rail', () => {
    renderPage();

    fireEvent.click(newProjectButton());

    expect(screen.getByText('Name your project')).toBeTruthy();
    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER)).toBeTruthy();
    expect(screen.getByPlaceholderText(DESC_PLACEHOLDER)).toBeTruthy();
    // The rail lists all three steps from step 1 onwards
    const rail = within(screen.getByTestId('setup-rail'));
    expect(rail.getByText('Name the project')).toBeTruthy();
    expect(rail.getByText('Add sensor data')).toBeTruthy();
    expect(rail.getByText('Explore in Dashboard')).toBeTruthy();
    expect(rail.getByRole('button', { name: 'All projects' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('Find workspace…')).toBeNull();
    expect(screen.queryByTestId('home-step')).toBeNull();
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

    expect(screen.getByText('Name your project')).toBeTruthy();
    expect(screen.queryByText('Add your sensor data')).toBeNull();
  });

  it('J51. a named project + Continue advances to step 2', () => {
    renderAtStep1();

    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), {
      target: { value: 'Line 3 baseline' },
    });
    fireEvent.click(continueButton());

    expect(screen.getByText('Add your sensor data')).toBeTruthy();
    expect(screen.getByText('Sensor data')).toBeTruthy();
    expect(screen.getByText('Tag names')).toBeTruthy();
    expect(screen.getByText('browse')).toBeTruthy();
  });

  it('J52. Back walks step 2 → 1 → 0, preserving what was typed', () => {
    renderAtStep2({ name: 'Line 3 baseline', description: 'Q3 compressor run' });

    fireEvent.click(screen.getByText('‹ Back'));

    expect(screen.getByText('Name your project')).toBeTruthy();
    expect((screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement).value)
      .toBe('Line 3 baseline');
    expect((screen.getByPlaceholderText(DESC_PLACEHOLDER) as HTMLTextAreaElement).value)
      .toBe('Q3 compressor run');

    fireEvent.click(screen.getByText('‹ Back'));

    expect(screen.getByTestId('home-step')).toBeTruthy();
    expect(newProjectButton()).toBeTruthy();
    expect(screen.queryByText('Continue')).toBeNull();
  });

  it('J53. the rail steps navigate backward only', () => {
    renderAtStep2();

    // step 2 → 1 by clicking the completed "Name the project" step
    fireEvent.click(screen.getByText('Name the project'));
    expect(screen.getByText('Name your project')).toBeTruthy();

    // …but the "Add sensor data" step is not a shortcut forward; that path has
    // to go through Continue so the project-name validation always runs.
    fireEvent.click(screen.getByText('Add sensor data'));
    expect(screen.getByText('Name your project')).toBeTruthy();
    expect(screen.queryByText('Add your sensor data')).toBeNull();
  });
});


// ═════════════════════════════════════════════════════════════════════════
// K. 2026-10-03 -- dataset generation + "latest click wins"
//   `load_csv` returns the generation of the Rust session it installed; the
//   page hands it to the Dashboard (inside the metadata), pins every recipe
//   replay command to it, and -- because the Rust session is ONE shared object
//   -- never lets an older, slower load hand over or mix its dataset with a
//   newer one's.
// ═════════════════════════════════════════════════════════════════════════

describe('K. dataset generation and latest-click-wins', () => {
  const STALE = 'STALE_SESSION: the dataset changed since this window was opened';
  const wsOf = (id: string, path: string, recipes: WorkspaceState['specialSensorRecipes'] = []): WorkspaceState => ({
    ...baseLoadedWs,
    id,
    name: id === 'ws_1' ? 'Engine pressure run' : 'Compressor health',
    dataFilePaths: [path],
    specialSensorRecipes: recipes,
  });
  const R = (tag: string) => ({ kind: 'formula' as const, tag, formula: '$sensor_a * 2' });

  /** A tiny stand-in for the Rust session: `load_csv` installs a new generation
   *  (when its deferred, if any, is released) and the replay commands refuse a
   *  pinned generation that is not the session's. */
  function session() {
    let gen = 0;
    const loads: Array<{ path: string; generation: number | null }> = [];
    const gates = new Map<string, () => void>();
    const hold = new Set<string>();
    const evaluated: Array<{ expected: unknown; ok: boolean }> = [];
    const impl = (cmd: string, args?: any) => {
      if (cmd === 'load_csv') {
        const path = String(args.paths[0]);
        const land = () => {
          gen += 1;
          loads.push({ path, generation: gen });
          return { headers: ['timestamp', 'sensor_a'], total_rows: 3, generation: gen };
        };
        if (hold.has(path)) {
          hold.delete(path);
          loads.push({ path, generation: null });
          return new Promise(resolve => { gates.set(path, () => resolve(land())); });
        }
        return Promise.resolve(land());
      }
      if (cmd === 'get_session_generation') return Promise.resolve(gen === 0 ? null : gen);
      if (cmd === 'evaluate_formula') {
        const ok = args.expectedGeneration === undefined || args.expectedGeneration === gen;
        evaluated.push({ expected: args.expectedGeneration, ok });
        return ok ? Promise.resolve(args.customName) : Promise.reject(STALE);
      }
      return Promise.resolve(null);
    };
    return {
      impl, loads, evaluated, hold: (p: string) => hold.add(p),
      release: (p: string) => gates.get(p)?.(),
      bump: () => { gen += 1; },
    };
  }

  const open = async (name: string) => {
    render(<DataUploadPage onDataReady={onDataReady} />);
    await waitFor(() => screen.getByText(name));
  };

  beforeEach(() => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    dismissAllErrors();
  });

  it('K1. the generation load_csv returned reaches onDataReady (inside the metadata) and pins every replay command', async () => {
    mockLoadWorkspace.mockResolvedValue(wsOf('ws_1', '/data/a.csv', [R('CALC1')]));
    const s = session();
    s.bump(); s.bump(); // the app has loaded other things before: generation 2 -> this load is 3
    mockInvoke.mockImplementation(s.impl);
    await open('Engine pressure run');
    fireEvent.click(screen.getByText('Engine pressure run'));
    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
    expect((onDataReady.mock.calls[0][0] as CsvMetadata).generation).toBe(3);
    expect(s.evaluated).toEqual([{ expected: 3, ok: true }]);
    expect(getErrors()).toHaveLength(0);
  });

  it('K2. Open Dashboard hands the Dashboard the generation of the Parse that produced the dataset', async () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/a.csv'], loadReport: { ...FAKE_REPORT, generation: 21 } })
    );
    mockSaveWorkspace.mockResolvedValue(undefined);
    renderAtStep2();
    fireEvent.click(openDashboardButton());
    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect((onDataReady.mock.calls[0][0] as CsvMetadata).generation).toBe(21);
  });

  it('K3. a replay refused as STALE_SESSION (another load replaced the session) reloads and rebuilds -- no "couldn\'t be restored" toast, onDataReady once, with the NEW generation', async () => {
    mockLoadWorkspace.mockResolvedValue(wsOf('ws_1', '/data/a.csv', [R('CALC1')]));
    const s = session();
    let first = true;
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'evaluate_formula' && first) { first = false; s.bump(); } // something replaced the session mid-replay
      return s.impl(cmd, args);
    });
    await open('Engine pressure run');
    fireEvent.click(screen.getByText('Engine pressure run'));
    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
    expect(s.loads.map(l => l.path)).toEqual(['/data/a.csv', '/data/a.csv']);
    const generation = (onDataReady.mock.calls[0][0] as CsvMetadata).generation;
    expect(generation).toBe(3); // 1 = first load, 2 = the intruder, 3 = the reload
    expect(s.evaluated.map(e => e.ok)).toEqual([false, true]);
    expect(getErrors()).toHaveLength(0);
  });

  it('K4. a dataset that keeps changing under the load ends in an error on the import page (not a Dashboard on mixed data)', async () => {
    mockLoadWorkspace.mockResolvedValue(wsOf('ws_1', '/data/a.csv', [R('CALC1')]));
    const s = session();
    mockInvoke.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'evaluate_formula') s.bump();
      return s.impl(cmd, args);
    });
    await open('Engine pressure run');
    fireEvent.click(screen.getByText('Engine pressure run'));
    await waitFor(() => expect(screen.getByText(/kept changing/)).toBeTruthy());
    expect(onDataReady).not.toHaveBeenCalled();
    expect(screen.queryByText('Loading workspace…')).toBeNull();
  });

  it('K5. latest click wins: Alpha\'s slow load_csv lands AFTER Beta\'s -- only Beta hands over, and Beta reloads so the session is Beta\'s', async () => {
    mockLoadWorkspace.mockImplementation(async (id: string) =>
      id === 'ws_1' ? wsOf('ws_1', '/data/a.csv', [R('CALC1')]) : wsOf('ws_2', '/data/b.csv', [R('CALC2')]));
    const s = session();
    s.hold('/data/a.csv');
    mockInvoke.mockImplementation(s.impl);
    await open('Engine pressure run');
    fireEvent.click(screen.getByText('Engine pressure run'));
    await waitFor(() => expect(s.loads.some(l => l.path === '/data/a.csv')).toBe(true)); // A's load_csv is running
    fireEvent.click(screen.getByText('Compressor health'));
    await waitFor(() => expect(s.loads.filter(l => l.path === '/data/b.csv').length).toBe(1));
    expect(onDataReady).not.toHaveBeenCalled(); // Beta is waiting for Alpha's load to land

    await act(async () => { s.release('/data/a.csv'); });
    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));

    const [meta, state] = onDataReady.mock.calls[0] as [CsvMetadata, WorkspaceState];
    expect(state.id).toBe('ws_2');
    // A landed last (generation 2); Beta reloaded (3) and replayed pinned to 3.
    expect(s.loads.map(l => [l.path, l.generation])).toEqual([
      ['/data/a.csv', null], ['/data/b.csv', 1], ['/data/a.csv', 2], ['/data/b.csv', 3],
    ]);
    expect(meta.generation).toBe(3);
    expect(s.evaluated).toEqual([{ expected: 3, ok: true }]);
    expect(getErrors()).toHaveLength(0);
  });

  it('K6. an older load that is still reading its workspace file when a newer click happens never touches the backend', async () => {
    let releaseA!: (ws: WorkspaceState) => void;
    mockLoadWorkspace.mockImplementation((id: string) =>
      id === 'ws_1' ? new Promise<WorkspaceState>(r => { releaseA = r; }) : Promise.resolve(wsOf('ws_2', '/data/b.csv')));
    const s = session();
    mockInvoke.mockImplementation(s.impl);
    await open('Engine pressure run');
    fireEvent.click(screen.getByText('Engine pressure run'));
    fireEvent.click(screen.getByText('Compressor health'));
    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
    await act(async () => { releaseA(wsOf('ws_1', '/data/a.csv')); });
    await new Promise(r => setTimeout(r, 20));
    expect(s.loads.map(l => l.path)).toEqual(['/data/b.csv']);
    expect(onDataReady).toHaveBeenCalledTimes(1);
    expect((onDataReady.mock.calls[0][1] as WorkspaceState).id).toBe('ws_2');
  });

  it('K7. an older load that FAILS after a newer click shows no error (the newer load owns the page)', async () => {
    let rejectA!: (e: Error) => void;
    mockLoadWorkspace.mockImplementation((id: string) =>
      id === 'ws_1' ? new Promise<WorkspaceState>((_, rej) => { rejectA = rej; }) : Promise.resolve(wsOf('ws_2', '/data/b.csv')));
    mockInvoke.mockImplementation(session().impl);
    await open('Engine pressure run');
    fireEvent.click(screen.getByText('Engine pressure run'));
    fireEvent.click(screen.getByText('Compressor health'));
    await waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
    await act(async () => { rejectA(new Error('old failure')); });
    expect(screen.queryByText(/old failure/)).toBeNull();
  });

  it('K8. focus fallback: a window focus >2 s into a load that is really talking to the backend does NOT clear the loading overlay (a second workspace could be clicked mid-load)', async () => {
    vi.useFakeTimers();
    try {
      mockLoadWorkspace.mockResolvedValue(wsOf('ws_1', '/data/a.csv'));
      const s = session();
      s.hold('/data/a.csv');
      mockInvoke.mockImplementation(s.impl);
      render(<DataUploadPage onDataReady={onDataReady} />);
      await vi.waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByText('Engine pressure run'));
      await vi.waitFor(() => expect(s.loads.some(l => l.path === '/data/a.csv')).toBe(true));
      await act(async () => { vi.advanceTimersByTime(2500); });
      expect(lastFocusHandler).not.toBeNull();
      await act(async () => { lastFocusHandler!({ payload: true }); });
      expect(screen.getByText('Loading workspace…')).toBeTruthy(); // still loading: overlay stays
      await act(async () => { s.release('/data/a.csv'); });
      await vi.waitFor(() => expect(onDataReady).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// L. 2026-10-04 -- the "Get started" page (step 0): hero, recent-project
//    cards (rename / delete in the row), search, empty state, Ctrl+N.
// ═════════════════════════════════════════════════════════════════════════

describe('L. Get started page (step 0)', () => {
  const HOUR_MS = 3_600_000;
  const NOW = Date.now();
  const WS: WorkspaceMetadata[] = [
    { id: 'ws_1', name: 'Engine pressure run', description: 'Bearing temperature drift', lastModified: NOW - 2 * HOUR_MS, filePath: '/ws/ws_1.json' },
    { id: 'ws_2', name: 'Compressor health', lastModified: NOW - 3 * 24 * HOUR_MS, filePath: '/ws/ws_2.json' },
  ];
  const cardOf = (name: string) =>
    screen.getAllByTestId('project-card').find((c) => within(c).queryByText(name)) as HTMLElement;
  const ctrlN = (target: Window | Element = window, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(target, { key: 'n', ctrlKey: true, ...init });

  describe('hero + footer', () => {
    it('L1. shows brand, eyebrow, description, the shortcut hint and the hero illustration (variant "hero")', async () => {
      renderPage();
      expect(screen.getByText('Wizard')).toBeTruthy();
      expect(screen.getByText('Predictive maintenance studio')).toBeTruthy();
      expect(screen.getByText(/Sensor data → failure models/)).toBeTruthy();
      expect(screen.getByText(/Import plant sensor CSVs/)).toBeTruthy();
      expect(screen.getByText('Ctrl+N')).toBeTruthy();
      expect(screen.getByTestId('machine-canvas').getAttribute('data-variant')).toBe('hero');
      await act(async () => { await Promise.resolve(); });
    });

    it('L2. footer shows the app version and the privacy line', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByText('v9.8.7')).toBeTruthy());
      expect(screen.getByText('Data stays on this machine')).toBeTruthy();
    });

    it('L3. when the version cannot be read the number is omitted but the privacy line stays', async () => {
      mockGetVersion.mockRejectedValue(new Error('not in tauri'));
      renderPage();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(screen.queryByText(/^v\d/)).toBeNull();
      expect(screen.getByText('Data stays on this machine')).toBeTruthy();
    });
  });

  describe('recent project cards', () => {
    it('L4. a card shows name, description (only when present), relative time and an initial', async () => {
      mockGetRecent.mockResolvedValue(WS);
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));

      const a = cardOf('Engine pressure run');
      expect(within(a).getByText('Bearing temperature drift')).toBeTruthy();
      expect(within(a).getByText('2 h ago')).toBeTruthy();
      expect(within(a).getByText('EP')).toBeTruthy();

      const b = cardOf('Compressor health');
      expect(within(b).getByText('3 d ago')).toBeTruthy();
      // Missing description: nothing invented -- initials + name + time only.
      expect(b.textContent).toBe('CHCompressor health3 d ago');
    });

    it('L5. clicking a card (or its "Open …" button) opens the project via loadWorkspaceData', async () => {
      mockGetRecent.mockResolvedValue(WS);
      mockLoadWorkspace.mockReturnValue(new Promise(() => {}));
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));

      fireEvent.click(screen.getByLabelText('Open Compressor health'));
      expect(mockLoadWorkspace).toHaveBeenCalledWith('ws_2');
      await waitFor(() => expect(screen.getByText('Loading workspace…')).toBeTruthy());
    });

    it('L6. Rename and Delete are reachable by keyboard focus (always in the DOM, not hover-only)', async () => {
      mockGetRecent.mockResolvedValue(WS);
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));
      const rename = screen.getByLabelText('Rename project Engine pressure run') as HTMLButtonElement;
      const del = screen.getByLabelText('Delete project Engine pressure run') as HTMLButtonElement;
      rename.focus();
      expect(document.activeElement).toBe(rename);
      del.focus();
      expect(document.activeElement).toBe(del);
    });

    it('L7. the home page does not render the old "Open recent project" / "Show all" chooser', async () => {
      mockGetRecent.mockResolvedValue(WS);
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));
      expect(screen.queryByText('Open recent project')).toBeNull();
      expect(screen.queryByText('Create new project')).toBeNull();
      expect(screen.queryByText('Pick an option above to get started')).toBeNull();
    });
  });

  describe('rename in the row', () => {
    const startRename = async (name = 'Engine pressure run') => {
      mockGetRecent.mockResolvedValue(WS);
      renderPage();
      await waitFor(() => screen.getByText(name));
      fireEvent.click(screen.getByLabelText(`Rename project ${name}`));
      return screen.getByLabelText('Project name') as HTMLInputElement;
    };

    it('L8. Rename opens a prefilled input without opening the project; Enter saves via renameWorkspaceFile and refreshes the list', async () => {
      const input = await startRename();
      expect(input.value).toBe('Engine pressure run');
      expect(mockLoadWorkspace).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: '  Engine run v2  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => expect(mockRenameWorkspaceFile).toHaveBeenCalledWith('ws_1', 'Engine run v2'));
      expect(mockRenameWorkspaceFile).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(mockGetRecent).toHaveBeenCalledTimes(2));
      expect(screen.queryByLabelText('Project name')).toBeNull();
    });

    it('L9. Esc cancels: nothing is renamed and the old name is back', async () => {
      const input = await startRename();
      fireEvent.change(input, { target: { value: 'Something else' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(screen.queryByLabelText('Project name')).toBeNull();
      expect(screen.getByText('Engine pressure run')).toBeTruthy();
      await act(async () => { await Promise.resolve(); });
      expect(mockRenameWorkspaceFile).not.toHaveBeenCalled();
    });

    it('L10. unchanged and empty/blank names are no-ops (no file rewrite, no list refresh)', async () => {
      let input = await startRename();
      fireEvent.keyDown(input, { key: 'Enter' }); // unchanged
      await act(async () => { await Promise.resolve(); });

      fireEvent.click(screen.getByLabelText('Rename project Engine pressure run'));
      input = screen.getByLabelText('Project name') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' }); // blank
      await act(async () => { await Promise.resolve(); });

      expect(mockRenameWorkspaceFile).not.toHaveBeenCalled();
      expect(mockGetRecent).toHaveBeenCalledTimes(1);
    });

    it('L11. the save button commits, the cancel button discards', async () => {
      let input = await startRename();
      fireEvent.change(input, { target: { value: 'Saved by button' } });
      fireEvent.click(screen.getByLabelText('Save name'));
      await waitFor(() => expect(mockRenameWorkspaceFile).toHaveBeenCalledWith('ws_1', 'Saved by button'));

      fireEvent.click(screen.getByLabelText('Rename project Engine pressure run'));
      input = screen.getByLabelText('Project name') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Discarded' } });
      fireEvent.click(screen.getByLabelText('Cancel rename'));
      await act(async () => { await Promise.resolve(); });
      expect(mockRenameWorkspaceFile).toHaveBeenCalledTimes(1);
    });

    it('L12. a failing rename surfaces the error banner instead of an unhandled rejection', async () => {
      mockRenameWorkspaceFile.mockRejectedValue(new Error('disk full'));
      const input = await startRename();
      fireEvent.change(input, { target: { value: 'New name' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk full'));
    });
  });

  describe('delete in the row', () => {
    it('L13. while the prompt is open the card does not open the project and Rename/Delete are hidden; the prompt names the consequence', async () => {
      mockGetRecent.mockResolvedValue(WS);
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByLabelText('Delete project Compressor health'));

      const card = cardOf('Compressor health');
      expect(within(card).getByText(/exported model files/)).toBeTruthy();
      expect(within(card).queryByLabelText('Rename project Compressor health')).toBeNull();
      // Clicking the card body while confirming is not "open".
      fireEvent.click(within(card).getByText('Compressor health'));
      expect(mockLoadWorkspace).not.toHaveBeenCalled();
      // The other card is untouched.
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    });

    it('L14. a failing delete shows the error banner and still refreshes the list', async () => {
      mockGetRecent.mockResolvedValue(WS);
      mockDeleteWorkspace.mockRejectedValue(new Error('locked'));
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByLabelText('Delete project Engine pressure run'));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('locked'));
      await waitFor(() => expect(mockGetRecent).toHaveBeenCalledTimes(2));
    });
  });

  describe('search + empty states', () => {
    it('L15. search filters by name AND description, case-insensitively, and "No matches" appears when nothing fits', async () => {
      mockGetRecent.mockResolvedValue(WS);
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));
      const q = screen.getByLabelText('Search projects');

      fireEvent.change(q, { target: { value: 'COMPRESSOR' } });
      expect(screen.queryByText('Engine pressure run')).toBeNull();
      expect(screen.getByText('Compressor health')).toBeTruthy();

      fireEvent.change(q, { target: { value: 'bearing' } }); // description match
      expect(screen.getByText('Engine pressure run')).toBeTruthy();
      expect(screen.queryByText('Compressor health')).toBeNull();

      fireEvent.change(q, { target: { value: 'zzz-no-such-thing' } });
      expect(screen.getByText('No matches')).toBeTruthy();
      expect(screen.queryByText('No projects yet')).toBeNull();
      expect(screen.queryAllByTestId('project-card')).toHaveLength(0);
    });

    it('L16. the first-run "No projects yet" guide does not flash before the recent list has loaded', async () => {
      let resolve!: (v: WorkspaceMetadata[]) => void;
      mockGetRecent.mockReturnValue(new Promise<WorkspaceMetadata[]>((r) => { resolve = r; }));
      renderPage();
      expect(screen.queryByText('No projects yet')).toBeNull();

      await act(async () => { resolve(WS); });
      expect(screen.queryByText('No projects yet')).toBeNull();
      expect(screen.getByText('Engine pressure run')).toBeTruthy();
    });

    it('L17. a failed recent-list fetch settles into the empty state (no endless blank)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGetRecent.mockRejectedValue(new Error('no store'));
      renderPage();
      await waitFor(() => expect(screen.getByText('No projects yet')).toBeTruthy());
      errSpy.mockRestore();
    });

    it('L18. a workspace load error is shown on the home page and the cards stay usable', async () => {
      mockGetRecent.mockResolvedValue(WS);
      mockLoadWorkspace.mockResolvedValue(null);
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByLabelText('Open Engine pressure run'));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Workspace not found'));
      expect(screen.getAllByTestId('project-card')).toHaveLength(2);
    });
  });

  describe('Ctrl+N', () => {
    it('L19. Ctrl+N (and Cmd+N) on step 0 starts a new project', () => {
      renderPage();
      ctrlN();
      expect(screen.getByText('Name your project')).toBeTruthy();
      cleanup();

      renderPage();
      fireEvent.keyDown(window, { key: 'N', metaKey: true });
      expect(screen.getByText('Name your project')).toBeTruthy();
    });

    it('L20. other key combos do nothing (plain N, Ctrl+Shift+N, Ctrl+Alt+N, Ctrl+M)', () => {
      renderPage();
      fireEvent.keyDown(window, { key: 'n' });
      ctrlN(window, { shiftKey: true });
      ctrlN(window, { altKey: true });
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
      expect(screen.getByTestId('home-step')).toBeTruthy();
      expect(screen.queryByText('Name your project')).toBeNull();
    });

    it('L21. Ctrl+N is ignored while typing in the search box or renaming a project', async () => {
      mockGetRecent.mockResolvedValue(WS);
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));

      ctrlN(screen.getByLabelText('Search projects'));
      expect(screen.getByTestId('home-step')).toBeTruthy();

      fireEvent.click(screen.getByLabelText('Rename project Engine pressure run'));
      ctrlN(screen.getByLabelText('Project name'));
      expect(screen.getByTestId('home-step')).toBeTruthy();
    });

    it('L22. Ctrl+N is ignored while a project is loading (overlay up)', async () => {
      mockGetRecent.mockResolvedValue(WS);
      mockLoadWorkspace.mockReturnValue(new Promise(() => {}));
      renderPage();
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByLabelText('Open Engine pressure run'));
      await waitFor(() => screen.getByText('Loading workspace…'));

      ctrlN();
      expect(screen.getByTestId('home-step')).toBeTruthy();
    });

    it('L23. on step 1 the shortcut is a no-op -- it never resets what the user typed', () => {
      renderAtStep1();
      fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value: 'Keep me' } });
      ctrlN();
      expect((screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement).value).toBe('Keep me');
    });

    it('L24. the shortcut listener is removed when step 0 unmounts (no stray handler on later steps)', () => {
      const added = vi.spyOn(window, 'addEventListener');
      const removed = vi.spyOn(window, 'removeEventListener');
      renderPage();
      const keydownAdds = added.mock.calls.filter(([type]) => type === 'keydown').length;
      expect(keydownAdds).toBeGreaterThan(0);
      fireEvent.click(newProjectButton());
      expect(removed.mock.calls.filter(([type]) => type === 'keydown').length).toBeGreaterThanOrEqual(keydownAdds);
      added.mockRestore();
      removed.mockRestore();
    });
  });

  describe('native menu (File > New Workspace) via newProjectSignal', () => {
    it('L25. a bumped signal on step 0 starts a new project; the key handler and the signal together are idempotent', () => {
      const { rerender } = render(<DataUploadPage onDataReady={onDataReady} newProjectSignal={0} />);
      rerender(<DataUploadPage onDataReady={onDataReady} newProjectSignal={1} />);
      expect(screen.getByText('Name your project')).toBeTruthy();
      // The key event of the same press arriving afterwards finds step 1: nothing changes.
      ctrlN();
      expect(screen.getByText('Name your project')).toBeTruthy();
    });

    it('L26. keydown first, then the menu signal: still exactly one transition, and typed text survives', () => {
      const { rerender } = render(<DataUploadPage onDataReady={onDataReady} newProjectSignal={0} />);
      ctrlN();
      fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value: 'Typed' } });
      rerender(<DataUploadPage onDataReady={onDataReady} newProjectSignal={1} />);
      expect((screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement).value).toBe('Typed');
    });

    it('L27. a signal while on step 1/2 is ignored, and so is one that arrives while a project is loading', async () => {
      const { rerender } = render(<DataUploadPage onDataReady={onDataReady} newProjectSignal={0} />);
      ctrlN();
      fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value: 'Typed' } });
      rerender(<DataUploadPage onDataReady={onDataReady} newProjectSignal={2} />);
      expect((screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement).value).toBe('Typed');
      cleanup();

      mockGetRecent.mockResolvedValue(WS);
      mockLoadWorkspace.mockReturnValue(new Promise(() => {}));
      const r2 = render(<DataUploadPage onDataReady={onDataReady} newProjectSignal={0} />);
      await waitFor(() => screen.getByText('Engine pressure run'));
      fireEvent.click(screen.getByLabelText('Open Engine pressure run'));
      await waitFor(() => screen.getByText('Loading workspace…'));
      r2.rerender(<DataUploadPage onDataReady={onDataReady} newProjectSignal={1} />);
      expect(screen.getByTestId('home-step')).toBeTruthy();
    });

    it('L28. mounting with a non-zero signal (App already bumped it before this page existed) does not start a project', () => {
      render(<DataUploadPage onDataReady={onDataReady} newProjectSignal={5} />);
      expect(screen.getByTestId('home-step')).toBeTruthy();
    });
  });
});


// ═════════════════════════════════════════════════════════════════════════
// M-Q. 2026-10-04 -- Import page redesign, phase C: the setup rail and steps
//      1-2 ("Name your project" / "Add your sensor data"). Behaviour of
//      loading / mapping / replay is covered by the groups above; these
//      cover the presentation: rail, name step, read progress, summary cards,
//      time coverage, "Fixed while reading", Tag names.
// ═════════════════════════════════════════════════════════════════════════

const DAY_US = 86_400_000_000;
const T0_US = Date.UTC(2025, 0, 1) * 1000;

/** A report carrying every field the Rust side now sends (phase R). */
const FULL_REPORT: CsvLoadReport = {
  ...FAKE_REPORT,
  total_rows: 159264,
  files: [
    { name: 'run-01.csv', size_bytes: 84.2 * 1024 * 1024, rows: 120000, start: '2025-01-01 00:00:00', end: '2025-12-31 00:00:00', start_micros: T0_US, end_micros: T0_US + 364 * DAY_US },
    { name: 'run-02.csv', size_bytes: 12.6 * 1024 * 1024, rows: 39264, start: '2025-09-01 00:00:00', end: '2026-07-08 00:00:00', start_micros: T0_US + 243 * DAY_US, end_micros: T0_US + 553 * DAY_US },
  ],
  period_start: '2025-01-01 00:00:00',
  period_end: '2026-07-08 00:00:00',
  period_start_micros: T0_US,
  period_end_micros: T0_US + 553 * DAY_US,
  interval_seconds: 300,
  missing_percent: 0.84,
};

const TWO_FILES = ['/d/run-01.csv', '/d/run-02.csv'];

const readyTwoFiles = (report: CsvLoadReport = FULL_REPORT) =>
  makeDataUpload({ selectedFiles: TWO_FILES, loadReport: report });

describe('M. Setup rail (steps 1-2)', () => {
  it('M1. step 1: step 1 is current, 2 and 3 are upcoming, nothing is summarised yet, and the mini illustration is a faint decoration', () => {
    renderAtStep1();
    const rail = within(screen.getByTestId('setup-rail'));
    expect(rail.getByText('Name the project').closest('[aria-current="step"]')).toBeTruthy();
    expect(rail.getByText('Add sensor data').closest('[aria-current="step"]')).toBeNull();
    expect(screen.queryByTestId('rail-value-1')).toBeNull();
    expect(screen.queryByTestId('rail-value-2')).toBeNull();

    const canvas = within(screen.getByTestId('setup-rail')).getByTestId('machine-canvas');
    expect(canvas.getAttribute('data-variant')).toBe('mini');
    // decorative: faint + not interactive
    expect(canvas.style.pointerEvents).toBe('none');
    expect(Number(canvas.style.opacity)).toBeLessThan(0.7);
    expect(canvas.style.position).toBe('absolute');
  });

  it('M2. step 2: the project name is summarised under the completed step and that step is a back button', () => {
    renderAtStep2({ name: 'Line 3 baseline' });
    expect(screen.getByTestId('rail-value-1').textContent).toBe('Line 3 baseline');
    const rail = within(screen.getByTestId('setup-rail'));
    expect(rail.getByText('Add sensor data').closest('[aria-current="step"]')).toBeTruthy();
    expect(rail.getByRole('button', { name: 'Go back to Name the project' })).toBeTruthy();
    // the current / upcoming steps are not buttons
    expect(rail.queryByRole('button', { name: /Go back to Add sensor data/ })).toBeNull();
    expect(rail.queryByRole('button', { name: /Explore in Dashboard/ })).toBeNull();
  });

  it('M3. once the files are read the rail summarises them ("N files · rows"); nothing before that', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: TWO_FILES }));
    const { unmount } = renderAtStep2();
    expect(screen.queryByTestId('rail-value-2')).toBeNull();
    unmount();
    cleanup();

    useDataUploadMock.mockReturnValue(readyTwoFiles());
    renderAtStep2();
    expect(screen.getByTestId('rail-value-2').textContent).toBe(`2 files · ${(159264).toLocaleString()} rows`);
  });

  it('M4. the rail summary pluralises ("1 file") and drops a row count that is not a number', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/d/a.csv'], loadReport: { ...FAKE_REPORT, total_rows: Number.NaN } }),
    );
    renderAtStep2();
    expect(screen.getByTestId('rail-value-2').textContent).toBe('1 file');
  });

  it('M5. clicking the completed "Name the project" step goes back and keeps what was typed', () => {
    renderAtStep2({ name: 'Keep me', description: 'and me' });
    fireEvent.click(screen.getByRole('button', { name: 'Go back to Name the project' }));
    expect(screen.getByText('Name your project')).toBeTruthy();
    expect((screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement).value).toBe('Keep me');
    expect((screen.getByPlaceholderText(DESC_PLACEHOLDER) as HTMLTextAreaElement).value).toBe('and me');
  });

  it('M6. "All projects" returns to the Get-started page from step 1 and from step 2', () => {
    renderAtStep1();
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(screen.getByTestId('home-step')).toBeTruthy();
    expect(screen.queryByTestId('setup-rail')).toBeNull();
    cleanup();

    renderAtStep2();
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(screen.getByTestId('home-step')).toBeTruthy();
  });
});

describe('N. Step 1 "Name your project"', () => {
  it('N1. shows the step heading, a name counter that starts at 0/80 and follows typing', () => {
    renderAtStep1();
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    expect(screen.getByTestId('name-counter').textContent).toBe('0/80');
    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value: 'Pump A' } });
    expect(screen.getByTestId('name-counter').textContent).toBe('6/80');
  });

  it('N2. the name input enforces the 80-character limit', () => {
    renderAtStep1();
    expect((screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement).maxLength).toBe(80);
  });

  it('N3. an existing project name (case-insensitive, trimmed) shows a NON-blocking warning', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    renderAtStep1();
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/already exists/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value: '  engine PRESSURE run ' } });
    expect(screen.getByText(/A project with this name already exists/)).toBeTruthy();
    // non-blocking: Continue still works and the flow goes on
    expect(continueButton().disabled).toBe(false);
    fireEvent.click(continueButton());
    expect(screen.getByText('Add your sensor data')).toBeTruthy();
  });

  it('N4. a different or partial name shows no warning (the tip is shown instead)', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    renderAtStep1();
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value: 'Engine pressure' } });
    expect(screen.queryByText(/already exists/)).toBeNull();
    expect(screen.getByText(/Tip: unit \+ topic/)).toBeTruthy();
  });

  it('N5. "Shows in recent projects as" previews the card live: placeholder, then name + description + initials', () => {
    renderAtStep1();
    expect(screen.getByText('Shows in recent projects as')).toBeTruthy();
    const card = screen.getByTestId('project-card-preview');
    expect(within(card).getByText('Project name')).toBeTruthy();
    expect(within(card).getByText('No description')).toBeTruthy();
    expect(within(card).getByText('just now')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value: 'GEG-4 Bearing study' } });
    fireEvent.change(screen.getByPlaceholderText(DESC_PLACEHOLDER), { target: { value: 'Drift Jan-Mar' } });
    expect(within(card).getByText('GEG-4 Bearing study')).toBeTruthy();
    expect(within(card).getByText('Drift Jan-Mar')).toBeTruthy();
    expect(within(card).getByText('GB')).toBeTruthy();
    expect(within(card).queryByText('No description')).toBeNull();
  });

  it('N6. the preview card is not interactive: no open / rename / delete controls, and it is not counted as a recent project', () => {
    renderAtStep1();
    const card = screen.getByTestId('project-card-preview');
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByTestId('project-card')).toHaveLength(0);
  });

  it('N7. the "Next" card describes step 2', () => {
    renderAtStep1();
    expect(screen.getByText('Next')).toBeTruthy();
    expect(screen.getByText('Add sensor CSVs')).toBeTruthy();
    expect(screen.getByText('Tag-name file')).toBeTruthy();
    expect(screen.getByText('Open the Dashboard')).toBeTruthy();
  });

  it('N8. the footer keeps Back + Continue (enabled only with a name)', () => {
    renderAtStep1();
    expect(screen.getByText('‹ Back')).toBeTruthy();
    expect(continueButton().disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), { target: { value: 'X' } });
    expect(continueButton().disabled).toBe(false);
  });
});

describe('O. Step 2 "Sensor data" panel', () => {
  it('O1. empty: a large dropzone with the three conditions as chips and the step eyebrow with the project name', () => {
    renderAtStep2({ name: 'Line 3 baseline' });
    expect(screen.getByText('Step 2 of 2 · Line 3 baseline')).toBeTruthy();
    expect(screen.getByText('Drop CSV files here')).toBeTruthy();
    expect(screen.getByText('First column is date/time')).toBeTruthy();
    expect(screen.getByText('Unique column names')).toBeTruthy();
    expect(screen.getByText('Up to 2 GB per file')).toBeTruthy();
    // nothing about a dataset that does not exist yet
    expect(screen.queryByTestId('summary-grid')).toBeNull();
    expect(screen.queryByTestId('time-coverage')).toBeNull();
  });

  it('O2. with files the big dropzone becomes an "Add more files" button that calls selectFiles (disabled while parsing)', () => {
    const hook = makeDataUpload({ selectedFiles: ['/d/a.csv'] });
    useDataUploadMock.mockReturnValue(hook);
    const { unmount } = renderAtStep2();
    expect(screen.queryByText('Drop CSV files here')).toBeNull();
    fireEvent.click(screen.getByText('Add more files').closest('button')!);
    expect(hook.selectFiles).toHaveBeenCalledTimes(1);
    unmount();
    cleanup();

    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: ['/d/a.csv'], isLoading: true }));
    renderAtStep2();
    expect((screen.getByText('Add more files').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('O3. after reading: each file shows rows and size from the report (columns only when it is the single file)', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles());
    renderAtStep2();
    const rows = screen.getAllByTestId('file-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('run-01.csv')).toBeTruthy();
    expect(within(rows[0]).getByText(`${(120000).toLocaleString()} rows`)).toBeTruthy();
    expect(within(rows[0]).getByText('84.2 MB')).toBeTruthy();
    expect(within(rows[1]).getByText(`${(39264).toLocaleString()} rows`)).toBeTruthy();
    expect(within(rows[1]).getByText('12.6 MB')).toBeTruthy();
    // merged column count is not one file's column count
    expect(within(rows[0]).queryByText(/columns/)).toBeNull();
  });

  it('O4. a single file also shows its column count', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/d/run-01.csv'], loadReport: { ...FULL_REPORT, files: [FULL_REPORT.files![0]] } }),
    );
    renderAtStep2();
    expect(within(screen.getByTestId('file-row')).getByText(/120,000 rows · 3 columns|120000 rows · 3 columns/)).toBeTruthy();
  });

  it('O5. summary cards: Rows, Sensors, Period (duration + dates), Interval and % empty', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles());
    renderAtStep2();
    const grid = within(screen.getByTestId('summary-grid'));
    expect(grid.getByText('Rows')).toBeTruthy();
    expect(grid.getByText((159264).toLocaleString())).toBeTruthy();
    expect(grid.getByText('after merge')).toBeTruthy();
    expect(grid.getByText('Sensors')).toBeTruthy();
    expect(grid.getByText('2')).toBeTruthy();
    expect(grid.getByText('Period')).toBeTruthy();
    expect(grid.getByText('18.2 mo')).toBeTruthy();
    expect(grid.getByText('2025-01-01 00:00:00 → 2026-07-08 00:00:00')).toBeTruthy();
    expect(grid.getByText('Interval')).toBeTruthy();
    expect(grid.getByText('5 min')).toBeTruthy();
    expect(grid.getByText('% empty')).toBeTruthy();
    expect(grid.getByText('0.8%')).toBeTruthy();
  });

  it('O6. a report with every new field null shows ONLY Rows and Sensors -- no Period / Interval / % empty / coverage, and never "NaN" or "undefined"', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({
        selectedFiles: ['/d/a.csv'],
        loadReport: {
          ...FAKE_REPORT,
          files: [{ name: 'a.csv', size_bytes: 10, rows: 5, start: null, end: null, start_micros: null, end_micros: null }],
          period_start: null, period_end: null, period_start_micros: null, period_end_micros: null,
          interval_seconds: null, missing_percent: null,
        },
      }),
    );
    const { container } = renderAtStep2();
    const grid = within(screen.getByTestId('summary-grid'));
    expect(grid.getByText('Rows')).toBeTruthy();
    expect(grid.getByText('Sensors')).toBeTruthy();
    expect(grid.queryByText('Period')).toBeNull();
    expect(grid.queryByText('Interval')).toBeNull();
    expect(grid.queryByText('% empty')).toBeNull();
    expect(screen.queryByTestId('time-coverage')).toBeNull();
    expect(container.textContent).not.toMatch(/NaN|undefined|null/);
  });

  it('O7. an old-style report (no new fields at all, e.g. a saved fixture) renders the same way -- no crash, no made-up numbers', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT }));
    const { container } = renderAtStep2();
    expect(screen.queryByText('Period')).toBeNull();
    expect(screen.queryByText('Interval')).toBeNull();
    expect(screen.queryByText('% empty')).toBeNull();
    expect(screen.queryByTestId('time-coverage')).toBeNull();
    expect(container.textContent).not.toMatch(/NaN|undefined|null/);
    // the file row has no size / rows to show -- just name and path
    expect(within(screen.getByTestId('file-row')).queryByText(/rows|MB|KB|GB/)).toBeNull();
  });

  it('O8. summary cards only appear when the dataset is ready (not for a stale report)', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: ['/d/run-01.csv'], loadReport: FULL_REPORT, isStale: true }));
    renderAtStep2();
    expect(screen.queryByTestId('summary-grid')).toBeNull();
    expect(screen.queryByTestId('time-coverage')).toBeNull();
  });

  it('O9. a "% empty" below 0.05 reads "<0.1%" rather than 0.0%', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles({ ...FULL_REPORT, missing_percent: 0.001 }));
    renderAtStep2();
    expect(within(screen.getByTestId('summary-grid')).getByText('<0.1%')).toBeTruthy();
  });

  it('O10. Period without microseconds shows the dates alone (no duration invented)', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles({ ...FULL_REPORT, period_start_micros: null, period_end_micros: null }));
    renderAtStep2();
    const grid = within(screen.getByTestId('summary-grid'));
    expect(grid.getByText('2025-01-01 00:00:00 → 2026-07-08 00:00:00')).toBeTruthy();
    expect(grid.queryByText(/ mo$/)).toBeNull();
  });

  it('O11. the header pill counts the files that are ready', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles());
    renderAtStep2();
    expect(screen.getByText(/2 files ready/)).toBeTruthy();
  });

  it('O12. footer: "Ready · rows · no tag names" with no mapping; "N names mapped" with one', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles());
    const { unmount } = renderAtStep2();
    expect(screen.getByText(`Ready · ${(159264).toLocaleString()} rows · no tag names`)).toBeTruthy();
    unmount();
    cleanup();

    useMappingDataMock.mockReturnValue(
      makeMapping({
        mappingFilePath: '/lookup/sensors.csv', mappingData: FAKE_MAPPING_DATA, keyColumn: 'tag',
        mappingResult: FAKE_MAPPING_RESULT,
      }),
    );
    renderAtStep2();
    expect(screen.getByText(`Ready · ${(159264).toLocaleString()} rows · 2 names mapped`)).toBeTruthy();
  });

  it('O13. footer while parsing says "Reading files…"', () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: ['/d/a.csv'], isLoading: true }));
    renderAtStep2();
    expect(screen.getByText('Reading files…')).toBeTruthy();
  });

  it('O14. "Fixed while reading": every warning is listed in the amber box (and none for a clean report)', () => {
    useDataUploadMock.mockReturnValue(
      readyTwoFiles({ ...FULL_REPORT, warnings: ['212 duplicate timestamps merged', 'Duplicate column "TAG1" found in file 1, file 2'] }),
    );
    renderAtStep2();
    const box = within(screen.getByTestId('fixed-while-reading'));
    expect(box.getByText('Fixed while reading')).toBeTruthy();
    expect(box.getByText('212 duplicate timestamps merged')).toBeTruthy();
    expect(box.getByText(/Duplicate column "TAG1"/)).toBeTruthy();
    expect(box.getAllByRole('listitem')).toHaveLength(2);
  });

  it('O15. the Parse button still validates (calls uploadDataset) and an error from the parse is shown', () => {
    const hook = makeDataUpload({ selectedFiles: ['/d/a.csv'], error: 'Cannot read' });
    useDataUploadMock.mockReturnValue(hook);
    renderAtStep2();
    expect(screen.getByText('Cannot read')).toBeTruthy();
    fireEvent.click(screen.getByText('Parse files'));
    expect(hook.uploadDataset).toHaveBeenCalledTimes(1);
  });
});

describe('P. Time coverage', () => {
  it('P1. one bar per file on a shared axis; the overlap is noted, overlapping bars really overlap', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles());
    renderAtStep2();
    const cov = within(screen.getByTestId('time-coverage'));
    expect(cov.getByText('Time coverage')).toBeTruthy();
    expect(cov.getByText(/files overlap/)).toBeTruthy();
    const bars = cov.getAllByTestId('coverage-bar') as HTMLElement[];
    expect(bars).toHaveLength(2);
    const span = (b: HTMLElement) => [parseFloat(b.style.left), parseFloat(b.style.left) + parseFloat(b.style.width)];
    const [a0, a1] = span(bars[0]);
    const [b0, b1] = span(bars[1]);
    expect(a0).toBe(0);
    expect(b1).toBeCloseTo(100, 4);
    expect(b0).toBeLessThan(a1); // run-02 starts before run-01 ends
    expect(b0).toBeGreaterThan(a0);
    expect(cov.getAllByTestId('coverage-lane')).toHaveLength(2);
  });

  it('P2. files that do not overlap are said not to', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles({
      ...FULL_REPORT,
      files: [
        { ...FULL_REPORT.files![0], end_micros: T0_US + 100 * DAY_US },
        { ...FULL_REPORT.files![1], start_micros: T0_US + 200 * DAY_US },
      ],
    }));
    renderAtStep2();
    expect(within(screen.getByTestId('time-coverage')).getByText('files do not overlap')).toBeTruthy();
  });

  it('P3. a single file is one full-width bar', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/d/run-01.csv'], loadReport: { ...FULL_REPORT, files: [FULL_REPORT.files![0]] } }),
    );
    renderAtStep2();
    const bar = screen.getByTestId('coverage-bar') as HTMLElement;
    expect(bar.style.left).toBe('0%');
    expect(bar.style.width).toBe('100%');
    expect(screen.getByText('one file')).toBeTruthy();
  });

  it('P4. the axis shows dates; files without a readable range are mentioned, not drawn', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles({
      ...FULL_REPORT,
      files: [FULL_REPORT.files![0], { ...FULL_REPORT.files![1], start_micros: null, end_micros: null }],
    }));
    renderAtStep2();
    const cov = within(screen.getByTestId('time-coverage'));
    expect(cov.getAllByTestId('coverage-bar')).toHaveLength(1);
    expect(cov.getByText('2025-01-01')).toBeTruthy();
    expect(cov.getByText(/1 file without a readable time range is not shown/)).toBeTruthy();
  });

  it('P5. hidden entirely when no file has a time range', () => {
    useDataUploadMock.mockReturnValue(readyTwoFiles({
      ...FULL_REPORT,
      files: FULL_REPORT.files!.map((f) => ({ ...f, start_micros: null, end_micros: null, start: null, end: null })),
    }));
    renderAtStep2();
    expect(screen.queryByTestId('time-coverage')).toBeNull();
  });
});

describe('Q. Read progress (csv-load-progress)', () => {
  /** The handler the page registered for the event (subscribe -> listen). */
  const progressHandler = () => {
    const calls = mockListen.mock.calls.filter((c) => c[0] === 'csv-load-progress');
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][1] as (e: { event: string; id: number; payload: unknown }) => void;
  };
  const emit = async (payload: unknown) => {
    const h = progressHandler();
    await act(async () => { h({ event: 'csv-load-progress', id: 1, payload }); });
  };
  const ev = (over: Record<string, unknown> = {}) => ({
    file_index: 0, file_count: 2, file_name: 'run-01.csv', stage: 'reading', files_done: 0, ...over,
  });
  const loadingUpload = () => makeDataUpload({ selectedFiles: TWO_FILES, isLoading: true });
  const stateOf = (name: string) =>
    screen.getByLabelText(`Reading ${name}`).getAttribute('data-state');

  it('Q1. subscribes through the safe subscribe() helper to the csv-load-progress event', () => {
    renderAtStep2();
    expect(mockListen.mock.calls.some((c) => c[0] === 'csv-load-progress')).toBe(true);
  });

  it('Q2. while THIS page parses, files_done drives the rows: finished files read "Read", the current one "Reading…", the rest "Waiting"', async () => {
    useDataUploadMock.mockReturnValue(loadingUpload());
    renderAtStep2();
    // before the first event nothing is claimed
    expect(screen.getByTestId('read-stage').textContent).toBe('Starting…');
    expect(stateOf('run-01.csv')).toBe('waiting');

    await emit(ev({ file_index: 0, files_done: 0 }));
    expect(screen.getByTestId('read-stage').textContent).toBe('Reading…');
    expect(stateOf('run-01.csv')).toBe('reading');
    expect(stateOf('run-02.csv')).toBe('waiting');

    await emit(ev({ file_index: 1, file_name: 'run-02.csv', files_done: 1 }));
    expect(stateOf('run-01.csv')).toBe('done');
    expect(stateOf('run-02.csv')).toBe('reading');
    expect(screen.getByText('1 of 2 files')).toBeTruthy();
    const overall = screen.getByLabelText('Reading files');
    expect(overall.getAttribute('aria-valuenow')).toBe('1');
    expect(overall.getAttribute('aria-valuemax')).toBe('2');
  });

  it('Q3. stage text: Merging… and Done (every file is "Read" while merging)', async () => {
    useDataUploadMock.mockReturnValue(loadingUpload());
    renderAtStep2();
    await emit(ev({ file_index: 2, file_name: '', stage: 'merging', files_done: 2 }));
    expect(screen.getByTestId('read-stage').textContent).toBe('Merging…');
    expect(stateOf('run-01.csv')).toBe('done');
    expect(stateOf('run-02.csv')).toBe('done');
    expect(screen.getByLabelText('Reading files').getAttribute('aria-valuenow')).toBe('2');

    await emit(ev({ file_index: 2, file_name: '', stage: 'done', files_done: 2 }));
    expect(screen.getByTestId('read-stage').textContent).toBe('Done');
  });

  it('Q4. events are IGNORED when this page is not parsing (a recent project being opened emits the same event)', async () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: TWO_FILES }));
    renderAtStep2();
    await emit(ev({ file_index: 1, files_done: 1 }));
    expect(screen.queryByTestId('read-status')).toBeNull();
    expect(screen.queryByLabelText('Reading run-01.csv')).toBeNull();
  });

  it('Q5. an event that arrived before the parse started never shows up in it, and the bar is gone when the parse ends', async () => {
    useDataUploadMock.mockReturnValue(makeDataUpload({ selectedFiles: TWO_FILES }));
    const utils = renderAtStep2();
    await emit(ev({ file_index: 1, files_done: 1 })); // ignored: not parsing

    useDataUploadMock.mockReturnValue(loadingUpload());
    utils.rerender(<DataUploadPage onDataReady={onDataReady} />);
    expect(screen.getByTestId('read-stage').textContent).toBe('Starting…');
    expect(stateOf('run-01.csv')).toBe('waiting');

    await emit(ev({ file_index: 0, files_done: 0 }));
    expect(stateOf('run-01.csv')).toBe('reading');

    // parse finished -> report arrives, progress UI is gone and the next parse starts clean
    useDataUploadMock.mockReturnValue(readyTwoFiles());
    utils.rerender(<DataUploadPage onDataReady={onDataReady} />);
    expect(screen.queryByTestId('read-status')).toBeNull();
    expect(screen.getAllByTestId('summary-card').length).toBeGreaterThan(0);

    useDataUploadMock.mockReturnValue(loadingUpload());
    utils.rerender(<DataUploadPage onDataReady={onDataReady} />);
    expect(screen.getByTestId('read-stage').textContent).toBe('Starting…');
  });

  it('Q6. a late, older event cannot move the bar backwards', async () => {
    useDataUploadMock.mockReturnValue(loadingUpload());
    renderAtStep2();
    await emit(ev({ file_index: 1, file_name: 'run-02.csv', files_done: 1 }));
    await emit(ev({ file_index: 0, files_done: 0 })); // older, arrives late
    expect(stateOf('run-01.csv')).toBe('done');
    expect(stateOf('run-02.csv')).toBe('reading');
  });

  it('Q7. a malformed payload is ignored instead of rendered', async () => {
    useDataUploadMock.mockReturnValue(loadingUpload());
    const { container } = renderAtStep2();
    await emit({ stage: 'reading' });
    await emit(null);
    await emit({ ...ev(), files_done: 'three' });
    expect(screen.getByTestId('read-stage').textContent).toBe('Starting…');
    expect(container.textContent).not.toMatch(/NaN|undefined/);
  });

  it('Q8. unmounting the page removes the listener (no leaked handler)', async () => {
    const unlisten = vi.fn();
    mockListen.mockImplementation(async () => unlisten);
    const { unmount } = renderAtStep2();
    await act(async () => { await Promise.resolve(); });
    unmount();
    expect(unlisten).toHaveBeenCalled();
  });
});

describe('R. Tag names panel (step 2, right)', () => {
  const readyUpload = () => makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT });

  const RICH_MAPPING_DATA: MappingData = {
    headers: ['tag', 'description', 'unit', 'component', 'alarm_h'],
    rows: [
      ['sensor_a', 'Pressure A', 'bar', 'Pump', '80'],
      ['sensor_b', 'Pressure B', 'bar', 'Pump', ''],
      ['sensor_d', 'Temp D', '°C', 'Motor', ''],
      ['sensor_z', 'Unused', '', '', ''],
    ],
  };
  const RICH_RESULT: MappingResult = {
    matched: ['sensor_a', 'sensor_b', 'sensor_d'],
    not_in_dataset: ['sensor_z'],
    not_in_mapping: ['sensor_x', 'sensor_y'],
  };
  const RICH_META: SensorMetadata[] = [
    { tag: 'sensor_a', description: 'Pressure A', unit: 'bar', component: 'Pump', alarmH: 80, alarmHH: 95 },
    { tag: 'sensor_b', description: 'Pressure B', unit: 'bar', component: 'Pump' },
    { tag: 'sensor_d', description: 'Temp D', unit: '°C', component: 'Motor' },
  ];
  const richMapping = (over: Partial<UseMappingDataReturn> = {}) =>
    makeMapping({
      mappingFilePath: '/lookup/tags.csv', mappingData: RICH_MAPPING_DATA, keyColumn: 'tag',
      mappingResult: RICH_RESULT, sensorMetadata: RICH_META, ...over,
    });

  it('R1. locked (greyed, with explanation) until the dataset has been read; the header is "Tag names" with no "Sensor mapping" anywhere', () => {
    renderAtStep2();
    expect(screen.getByText('Tag names')).toBeTruthy();
    expect(screen.queryByText(/Sensor mapping/i)).toBeNull();
    const locked = screen.getByTestId('tag-names-locked');
    expect(within(locked).getByText('Add sensor data first')).toBeTruthy();
    expect(within(locked).getByText(/available once the files have been read/)).toBeTruthy();
    // greyed out: the whole card is dimmed
    expect((locked.closest('[style*="opacity"]') as HTMLElement).style.opacity).toBe('0.6');
  });

  it('R2. unlocked once the dataset is read: the explanation, expected columns and a dropzone', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    renderAtStep2();
    expect(screen.queryByTestId('tag-names-locked')).toBeNull();
    expect(screen.getByText(/human-readable sensor names/)).toBeTruthy();
    expect(screen.getByText(/alarm_ll \/ alarm_l \/ alarm_h \/ alarm_hh/)).toBeTruthy();
    expect(screen.getByText('Select tag-name CSV')).toBeTruthy();
    expect(screen.getByText(/Optional/)).toBeTruthy();
  });

  it('R3. no result yet: no ring, chips or table', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(makeMapping({ mappingFilePath: '/lookup/tags.csv', mappingData: RICH_MAPPING_DATA, keyColumn: 'tag' }));
    renderAtStep2();
    expect(screen.queryByTestId('match-summary')).toBeNull();
    expect(screen.queryByTestId('tag-table')).toBeNull();
    expect(screen.getByText('4 rows')).toBeTruthy();
  });

  it('R4. after a mapping is applied: ring + matched/total, component chips with counts', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(richMapping());
    renderAtStep2();
    expect(screen.getByTestId('match-count').textContent).toBe('3 / 5');
    expect(screen.getByText('2 columns have no name yet')).toBeTruthy();
    expect(screen.getByTestId('match-ring')).toBeTruthy();
    const chips = within(screen.getByTestId('component-chips'));
    expect(chips.getByText('Pump').textContent).toBe('Pump2');
    expect(chips.getByText('Motor').textContent).toBe('Motor1');
    // the file row summarises matches
    expect(screen.getByText('4 rows · 3 matched')).toBeTruthy();
  });

  it('R5. every column named: "every column has a name" and no No-name tab', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(richMapping({ mappingResult: { matched: ['sensor_a'], not_in_dataset: [], not_in_mapping: [] } }));
    renderAtStep2();
    expect(screen.getByTestId('match-count').textContent).toBe('1 / 1');
    expect(screen.getByText('every column has a name')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /No name/ })).toBeNull();
    expect(screen.queryByTestId('not-in-dataset')).toBeNull();
  });

  it('R6. Matched tab: tag, name, unit and alarm limits (dots lit only for limits that exist, values in the tooltip)', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(richMapping());
    renderAtStep2();
    const tab = screen.getByRole('tab', { name: /Matched/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const table = within(screen.getByTestId('tag-table'));
    expect(table.getByText('sensor_a')).toBeTruthy();
    expect(table.getByText('Pressure A')).toBeTruthy();
    expect(table.getAllByText('bar')).toHaveLength(2);
    expect(table.getByText('°C')).toBeTruthy();
    const dots = screen.getByLabelText('H 80 · HH 95');
    expect(dots.querySelector('[data-alarm="H"]')!.getAttribute('data-on')).toBe('true');
    expect(dots.querySelector('[data-alarm="HH"]')!.getAttribute('data-on')).toBe('true');
    expect(dots.querySelector('[data-alarm="LL"]')!.getAttribute('data-on')).toBe('false');
    expect(dots.querySelector('[data-alarm="L"]')!.getAttribute('data-on')).toBe('false');
    expect(screen.getAllByLabelText('No alarm limits')).toHaveLength(2);
  });

  it('R7. columns that do not exist in the mapping are skipped (no unit / alarm column when nothing has them)', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(richMapping({
      sensorMetadata: [{ tag: 'sensor_a', description: 'Pressure A', unit: '', component: '' }],
      mappingResult: { matched: ['sensor_a'], not_in_dataset: [], not_in_mapping: [] },
    }));
    renderAtStep2();
    const row = screen.getByTestId('tag-table').querySelector('tr') as HTMLElement;
    expect(row.querySelectorAll('td')).toHaveLength(2); // tag + name only
    expect(screen.queryByTestId('component-chips')).toBeNull();
  });

  it('R8. No name tab lists the dataset columns that got no name', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(richMapping());
    renderAtStep2();
    fireEvent.click(screen.getByRole('tab', { name: /No name/ }));
    const table = within(screen.getByTestId('tag-table'));
    expect(table.getByText('sensor_x')).toBeTruthy();
    expect(table.getByText('sensor_y')).toBeTruthy();
    expect(table.queryByText('sensor_a')).toBeNull();
    expect(table.getAllByText('no name — tag code is shown')).toHaveLength(2);
  });

  it('R9. search filters the table by tag or name, on either tab, and says when nothing matches', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(richMapping());
    renderAtStep2();
    const find = screen.getByLabelText('Find tag');
    fireEvent.change(find, { target: { value: 'temp' } });
    expect(screen.queryByText('Pressure A')).toBeNull();
    expect(screen.getByText('Temp D')).toBeTruthy();

    fireEvent.change(find, { target: { value: 'zzz' } });
    expect(screen.getByText(/No tags match/)).toBeTruthy();

    fireEvent.change(find, { target: { value: 'SENSOR_X' } });
    fireEvent.click(screen.getByRole('tab', { name: /No name/ }));
    expect(screen.getByText('sensor_x')).toBeTruthy();
    expect(screen.queryByText('sensor_y')).toBeNull();
  });

  it('R10. tags in the mapping file that are not in the dataset are mentioned', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(richMapping());
    renderAtStep2();
    expect(screen.getByTestId('not-in-dataset').textContent).toMatch(/1 tag in the tag-name file is not in the dataset/);
  });

  it('R11. without sensor metadata the matched tab still lists the matched tags', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(richMapping({ sensorMetadata: null }));
    renderAtStep2();
    const table = within(screen.getByTestId('tag-table'));
    expect(table.getByText('sensor_a')).toBeTruthy();
    expect(table.getByText('sensor_d')).toBeTruthy();
  });

  it('R12. a very long list is capped with a hint to use search', () => {
    const matched = Array.from({ length: 250 }, (_, i) => `t${i}`);
    useDataUploadMock.mockReturnValue(readyUpload());
    useMappingDataMock.mockReturnValue(richMapping({
      sensorMetadata: matched.map((tag) => ({ tag, description: tag, unit: '', component: '' })),
      mappingResult: { matched, not_in_dataset: [], not_in_mapping: [] },
    }));
    renderAtStep2();
    expect(screen.getByTestId('tag-table').querySelectorAll('tr')).toHaveLength(200);
    expect(screen.getByText(/Showing the first 200 of 250/)).toBeTruthy();
  });

  it('R13. Open Dashboard stays enabled when no tag names were added (the panel is optional)', () => {
    useDataUploadMock.mockReturnValue(readyUpload());
    renderAtStep2();
    expect(openDashboardButton().disabled).toBe(false);
  });
});
