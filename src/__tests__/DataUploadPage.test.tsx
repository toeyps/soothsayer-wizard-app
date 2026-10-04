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
  default: (props: { variant?: string }) => <div data-testid="machine-canvas" data-variant={props.variant} />,
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
// dataset UI every group below asserts against lives on step 2, reached via:
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

const continueButton = () =>
  screen.getByText('Continue').closest('button') as HTMLButtonElement;

/** Render and advance to step 1 ("Create your project"). */
function renderAtStep1() {
  const utils = renderPage();
  fireEvent.click(newProjectButton());
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

  it('A6c. the step-1/2 sidebar row confirms in the row too (no dialog)', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);
    renderAtStep1();
    await waitFor(() => screen.getByText('Engine pressure run'));

    fireEvent.click(screen.getAllByTitle('Delete workspace')[0]);
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
    const prompt = screen.getByRole('alertdialog');
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTitle('Delete workspace')[0]);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockDeleteWorkspace).toHaveBeenCalledWith('ws_1'));
    await waitFor(() => expect(mockGetRecent).toHaveBeenCalledTimes(2));
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
  });

  it('C18. no warnings banner when the load report has none', () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/x.csv'], loadReport: FAKE_REPORT })
    );

    renderAtStep2();

    expect(screen.queryByText(/Buddhist-Era year/)).toBeNull();
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
  it('J45. boots into step 0 (Get started) with the hero, New project and no dataset UI', async () => {
    mockGetRecent.mockResolvedValue(FAKE_WORKSPACES);

    renderPage();

    expect(screen.getByTestId('home-step')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('See the failure before it happens.');
    expect(newProjectButton()).toBeTruthy();
    // Step 2's surface must not be mounted yet…
    expect(screen.queryByText('Dataset files')).toBeNull();
    expect(screen.queryByText('browse')).toBeNull();
    expect(screen.queryByText('Continue')).toBeNull();
    // …nor the step 1-2 chrome (sidebar search, step indicator, action bar).
    expect(screen.queryByPlaceholderText('Find workspace…')).toBeNull();
    expect(screen.queryByText('Create project')).toBeNull();

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

  it('J48. "New project" advances to step 1 and reveals the sidebar', () => {
    renderPage();

    fireEvent.click(newProjectButton());

    expect(screen.getByText('Create your project')).toBeTruthy();
    expect(screen.getByPlaceholderText(NAME_PLACEHOLDER)).toBeTruthy();
    expect(screen.getByPlaceholderText(DESC_PLACEHOLDER)).toBeTruthy();
    // Step indicator only exists from step 1 onwards
    expect(screen.getByText('Create project')).toBeTruthy();
    expect(screen.getByText('Prepare dataset')).toBeTruthy();
    // Sidebar comes back so the user can still switch workspaces mid-flow
    expect(screen.getByPlaceholderText('Find workspace…')).toBeTruthy();
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

    expect(screen.getByTestId('home-step')).toBeTruthy();
    expect(newProjectButton()).toBeTruthy();
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

  it('K2. Create-project Continue hands the Dashboard the generation of the Parse that produced the dataset', async () => {
    useDataUploadMock.mockReturnValue(
      makeDataUpload({ selectedFiles: ['/a.csv'], loadReport: { ...FAKE_REPORT, generation: 21 } })
    );
    mockSaveWorkspace.mockResolvedValue(undefined);
    renderAtStep2();
    fireEvent.click(continueButton());
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
      expect(screen.getByText('Create your project')).toBeTruthy();
      cleanup();

      renderPage();
      fireEvent.keyDown(window, { key: 'N', metaKey: true });
      expect(screen.getByText('Create your project')).toBeTruthy();
    });

    it('L20. other key combos do nothing (plain N, Ctrl+Shift+N, Ctrl+Alt+N, Ctrl+M)', () => {
      renderPage();
      fireEvent.keyDown(window, { key: 'n' });
      ctrlN(window, { shiftKey: true });
      ctrlN(window, { altKey: true });
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
      expect(screen.getByTestId('home-step')).toBeTruthy();
      expect(screen.queryByText('Create your project')).toBeNull();
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
      expect(screen.getByText('Create your project')).toBeTruthy();
      // The key event of the same press arriving afterwards finds step 1: nothing changes.
      ctrlN();
      expect(screen.getByText('Create your project')).toBeTruthy();
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
