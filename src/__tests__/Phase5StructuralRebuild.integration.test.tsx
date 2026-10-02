/**
 * QA cross-cutting sweep of the 2026-10-02 visual-refresh **Phase 5**
 * structural rebuild (real JSX rewrites, not CSS-value-only): the Dashboard
 * `.timebar`, the rewritten FilterPanel / HighlightsPanel, the Add-to-FG
 * popover widened to 380px, and the rewritten Add Special Sensor window
 * (AddSensorWindow + SensorExplorer + SensorTooling).
 *
 * Every worker test for those files mocks the neighbours away (Dashboard.test
 * stubs FilterPanel/HighlightsPanel/SensorSelection; AddSensorWindow.test stubs
 * SensorExplorer/SensorTooling). This file mounts the REAL pieces together and
 * probes the bug class this session kept hitting: popovers/layout state that
 * goes stale when the thing around them changes.
 *
 *   1. Add-to-FG popover at 380px vs AnchoredPopover's viewport clamp/flip.
 *   2. AddSensorWindow's fixed 320px | minmax(0,1fr) grid at small sizes
 *      (CSS contract + a real explorer -> tooling -> footer click-through).
 *   3. HighlightsPanel 2-column dim state + colour popovers through rapid
 *      chart-type switching inside the real Dashboard.
 *   4. FilterPanel's segmented operator -> the exact `value_filters` wire
 *      payload Rust's `ResolvedFilter::keeps` matches on.
 *   5. `.timebar` "Reset period" (now after Aggregation) vs Aggregation and
 *      the Filter tab, judged on the actual chart query, not labels.
 *
 * Anything found broken is recorded as `it.fails` (this repo's convention) so
 * a later fix pass flips it to `it`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';
import contract from '../../src-tauri/tests/fixtures/filter_contract.json';
import type { CsvMetadata, FailureGroup, SensorMetadata, TimeHighlight, ValueHighlight, WorkspaceState } from '../types';

// ── Mocks: only infra + chart rendering + data hooks. FilterPanel,
//    HighlightsPanel, SensorSelection, ColorPlatePicker, AnchoredPopover,
//    Portal, SensorExplorer, SensorTooling are all REAL. ────────────────────

const chartProps: any[] = [];
vi.mock('../components/charts', () => ({
    Chart: (props: any) => { chartProps.push(props); return <div data-testid="chart-mock" />; },
    defaultSensorColor: (tag: string) => `default-${tag}`,
    LINE_CHART_COLORS: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
    MAX_PAIR_PLOT_SENSORS: 4,
    RANGE_PALETTE: [
        [0.99, 0.75, 0.18, 1.0], [0.20, 0.83, 0.60, 1.0], [0.86, 0.40, 0.97, 1.0], [0.99, 0.45, 0.45, 1.0],
        [0.40, 0.85, 0.99, 1.0], [0.99, 0.55, 0.27, 1.0], [0.65, 0.85, 0.40, 1.0], [0.78, 0.66, 0.99, 1.0],
    ],
}));

// Not under test here and has its own heavy wiring.
vi.mock('../components/dashboard/FailureGroupsPanel', () => ({ default: () => <div data-testid="fg-panel" /> }));

const mockUseChartData = vi.fn((_q?: unknown) => ({ view: null, loading: false, error: null } as any));
vi.mock('../hooks/useChartData', () => ({ useChartData: (q: unknown) => mockUseChartData(q) }));
const mockUseScatterSample = vi.fn((_f?: unknown, _m?: unknown, _a?: unknown, _r?: unknown) =>
    ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null } as any));
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: (f: unknown, m: unknown, a: unknown, r: unknown) => mockUseScatterSample(f, m, a, r),
}));
const mockUseDatasetTimeBounds = vi.fn(() => ({ bounds: null, loading: false, error: null } as any));
vi.mock('../hooks/useDatasetTimeBounds', () => ({ useDatasetTimeBounds: () => mockUseDatasetTimeBounds() }));

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args) }));

let listenCallbacks: Record<string, Array<(e: any) => void>> = {};
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: (e: any) => void) => {
        (listenCallbacks[event] ??= []).push(cb);
        return Promise.resolve(() => { listenCallbacks[event] = (listenCallbacks[event] ?? []).filter(c => c !== cb); });
    },
    emit: (event: string, payload?: unknown) => mockEmit(event, payload),
}));
const mockEmit = vi.fn().mockResolvedValue(undefined);

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        onCloseRequested: () => Promise.resolve(() => {}),
        close: () => Promise.resolve(),
    }),
}));

const { webviewWindowCalls } = vi.hoisted(() => ({ webviewWindowCalls: [] as Array<{ label: string; opts: any }> }));
vi.mock('@tauri-apps/api/webviewWindow', () => {
    class MockWebviewWindow {
        constructor(label: string, opts: any) { webviewWindowCalls.push({ label, opts }); }
        once = vi.fn().mockResolvedValue(undefined);
        static getByLabel = () => Promise.resolve(null);
    }
    return { WebviewWindow: MockWebviewWindow };
});
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn().mockResolvedValue(undefined) }));
vi.mock('split.js', () => ({ default: () => ({ destroy: vi.fn() }) }));

const mockSaveWorkspaceData = vi.fn().mockResolvedValue(undefined);
vi.mock('../workspaceManager', () => ({
    saveWorkspaceData: (s: unknown) => mockSaveWorkspaceData(s),
    updateWorkspaceData: async (id: string, patch: (s: any) => any) => patch({ id }),
    loadWorkspaceData: () => Promise.resolve(null),
}));
vi.mock('../errorReporter', () => ({ reportError: vi.fn() }));

import Dashboard from '../components/dashboard/Dashboard';
import SensorSelection from '../components/dashboard/SensorSelection';
import AddSensorWindow from '../components/windows/AddSensorWindow';

// ── App.css contract helpers (jsdom never applies the stylesheet) ─────────

const CSS_SRC: string = readFileSync('src/App.css', 'utf-8');
type CssRule = { selectors: string[]; decls: Record<string, string>; inAtRule: boolean };
const RULES: CssRule[] = (() => {
    const css = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: CssRule[] = [];
    let depth = 0;
    let head = '';
    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === '{') {
            const h = head.trim();
            head = '';
            if (h.startsWith('@')) { depth++; continue; }
            const end = css.indexOf('}', i);
            const decls: Record<string, string> = {};
            for (const d of css.slice(i + 1, end).split(';')) {
                const k = d.indexOf(':');
                if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim().replace(/\s+/g, ' ');
            }
            out.push({ selectors: h.split(',').map(s => s.trim().replace(/\s+/g, ' ')), decls, inAtRule: depth > 0 });
            i = end;
        } else if (ch === '}') {
            if (depth > 0) depth--;
            head = '';
        } else {
            head += ch;
        }
    }
    return out;
})();
/** Merged base-level declarations for one exact selector (last wins). */
function css(selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of RULES) if (!r.inAtRule && r.selectors.includes(selector)) Object.assign(out, r.decls);
    return out;
}
/** Every rule (any nesting) whose selector list mentions this class. */
const rulesMentioning = (cls: string) => RULES.filter(r => r.selectors.some(s => new RegExp(`\\.${cls}(?![\\w-])`).test(s)));

// ── Geometry helpers: jsdom has no layout, so rects are scripted ──────────

type Rect = { top: number; left: number; width: number; height: number };
const mkRect = ({ top, left, width, height }: Rect): DOMRect => ({
    top, left, width, height, x: left, y: top, right: left + width, bottom: top + height,
    toJSON() { return this; },
} as DOMRect);

const origGBCR = Element.prototype.getBoundingClientRect;
let rectFor: ((el: Element) => DOMRect | null) | null = null;
const origInnerWidth = window.innerWidth;
const origInnerHeight = window.innerHeight;
function setViewport(w: number, h: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: h });
}
let origSetPointerCapture: any;

beforeEach(() => {
    chartProps.length = 0;
    webviewWindowCalls.length = 0;
    listenCallbacks = {};
    mockUseChartData.mockClear().mockReturnValue({ view: null, loading: false, error: null });
    mockUseScatterSample.mockClear().mockReturnValue({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null });
    mockUseDatasetTimeBounds.mockClear().mockReturnValue({ bounds: null, loading: false, error: null });
    mockInvoke.mockReset().mockResolvedValue(undefined);
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockSaveWorkspaceData.mockClear();
    rectFor = null;
    Element.prototype.getBoundingClientRect = function (this: Element) {
        return rectFor?.(this) ?? origGBCR.call(this);
    };
    origSetPointerCapture = (Element.prototype as any).setPointerCapture;
    (Element.prototype as any).setPointerCapture = vi.fn();
});
afterEach(() => {
    cleanup();
    Element.prototype.getBoundingClientRect = origGBCR;
    (Element.prototype as any).setPointerCapture = origSetPointerCapture;
    setViewport(origInnerWidth, origInnerHeight);
    document.getElementById('wizard-portal-root')?.remove();
    vi.restoreAllMocks();
});

const openPopovers = () => Array.from(document.querySelectorAll<HTMLElement>('#wizard-portal-root .sensor-popover'));
function last<T>(arr: T[]): T { return arr[arr.length - 1]; }
const lastChartQuery = () => last(mockUseChartData.mock.calls)![0] as any;

// ── Dashboard fixture ─────────────────────────────────────────────────────

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump', alarmH: 90 },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
];
const metadata: CsvMetadata = { headers: ['timestamp', 'TAG1', 'TAG2', 'TAG3'], total_rows: 100 };
const hl1: TimeHighlight = { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T06:00', label: 'Startup', color: '#ff0000', enabled: true };
const vh: ValueHighlight = { sensor: 'TAG1', ranges: [{ id: 'r1', min: 10, max: 20, color: '#00ff00', enabled: true }] };

function renderDashboard(overrides: Partial<WorkspaceState> = {}) {
    const initialState: WorkspaceState = {
        id: 'ws1', name: 'WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: ['TAG1', 'TAG2'], visibleSensors: ['TAG1', 'TAG2'], operationConfig: null,
        ...overrides,
    };
    return render(<Dashboard metadata={metadata} sensorMetadata={sensorMetadata} onBack={vi.fn()} initialState={initialState} />);
}

/** Chart-type buttons — their labels ("Scatter", "Pair Plot") also appear as
 *  <b> text inside HighlightsPanel's notes, so match on the class. */
function chartBtn(label: 'Line' | 'Scatter' | 'Pair Plot'): HTMLButtonElement {
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.chart-type-btn')).find(b => b.textContent?.trim() === label);
    if (!btn) throw new Error(`no chart-type button "${label}"`);
    return btn;
}

// =============================================================================
// 1. Add-to-FG popover (380px) vs AnchoredPopover's clamp
// =============================================================================

describe('1. Add-to-failure-group popover at 380px stays inside the viewport', () => {
    // Real group names from the user's workspace are what drove 290 -> 380.
    const longGroups: FailureGroup[] = [
        { no: 0, name: 'Not in Group' },
        { no: 1, name: 'generator mechanical condition' },
        { no: 2, name: 'generator electrical condition' },
        { no: 3, name: 'turbine lube oil system degradation' },
    ];
    const POP_HEIGHT = 420; // `.sensor-popover` max-height: min(70vh, 420px) — the worst case

    function openAddToFg(viewport: { w: number; h: number }, anchor: Rect) {
        setViewport(viewport.w, viewport.h);
        rectFor = (el) => {
            if (el instanceof HTMLElement && el.title === 'Add to failure group') return mkRect(anchor);
            if (el instanceof HTMLElement && el.classList.contains('sensor-popover')) {
                // The popover's real border-box: its inline width (Tailwind
                // preflight is border-box, so padding is inside it) and the
                // worst-case max-height.
                return mkRect({
                    top: parseFloat(el.style.top) || 0, left: parseFloat(el.style.left) || 0,
                    width: parseFloat(el.style.width) || 0, height: POP_HEIGHT,
                });
            }
            return null;
        };
        render(
            <SensorSelection
                sensors={['TAG1', 'TAG2']} selectedSensors={[]} onSensorChange={vi.fn()}
                sensorMetadata={sensorMetadata} fgGroups={longGroups} fgModels={[]}
                getGroupColor={() => 'blue'} onToggleSensorGroupKind={vi.fn()} onCreateGroupForSensor={vi.fn()}
                onRenameGroup={vi.fn()} onDeleteGroup={vi.fn()} alarmLinesEnabled={{}} onToggleAlarmLine={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByText('Pump')); // expand the component group
        fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
        const pops = openPopovers();
        expect(pops).toHaveLength(1);
        const pop = pops[0];
        return { pop, top: parseFloat(pop.style.top), left: parseFloat(pop.style.left), width: parseFloat(pop.style.width) };
    }

    it('renders at exactly 380px and no App.css rule on the popover classes overrides that width', () => {
        const { width } = openAddToFg({ w: 1366, h: 768 }, { top: 200, left: 270, width: 24, height: 24 });
        expect(width).toBe(380);
        for (const cls of ['sensor-popover', 'popover-surface']) {
            for (const r of rulesMentioning(cls)) {
                expect(Object.keys(r.decls).filter(k => /^(min-|max-)?width$/.test(k))).toEqual([]);
            }
        }
        // AnchoredPopover's clamp uses the `width` prop (380) as the box
        // width; that equals the rendered width only under border-box sizing,
        // which this app gets from Tailwind's preflight.
        expect(CSS_SRC).toMatch(/@import\s+["']tailwindcss["']/);
    });

    // Main window opens at 800x600 (tauri.conf.json) before maximizing, and
    // the sensor list can sit on either side of the dashboard.
    const cases: Array<[string, { w: number; h: number }, Rect]> = [
        ['800x600 window, anchor flush with the right edge', { w: 800, h: 600 }, { top: 150, left: 774, width: 24, height: 24 }],
        ['800x600 window, anchor at the right edge of a left-docked ~300px sensor list', { w: 800, h: 600 }, { top: 150, left: 266, width: 24, height: 24 }],
        ['1366x768, anchor near the right edge', { w: 1366, h: 768 }, { top: 300, left: 1338, width: 24, height: 24 }],
        ['1920x1080, anchor mid-screen', { w: 1920, h: 1080 }, { top: 300, left: 900, width: 24, height: 24 }],
        ['viewport exactly 380 + 2x8px gutter wide', { w: 396, h: 600 }, { top: 100, left: 360, width: 24, height: 24 }],
    ];
    for (const [name, vp, anchor] of cases) {
        it(`horizontal clamp keeps the whole 380px box on screen — ${name}`, () => {
            const { left, width } = openAddToFg(vp, anchor);
            expect(left).toBeGreaterThanOrEqual(8);
            expect(left + width).toBeLessThanOrEqual(vp.w - 8);
        });
    }

    it('right-aligns to the anchor when there is room (prototype placement preserved at the wider size)', () => {
        const { left, width } = openAddToFg({ w: 1366, h: 768 }, { top: 300, left: 900, width: 24, height: 24 });
        expect(left + width).toBe(924);
    });

    it('a viewport narrower than 396px cannot fit 380px: the clamp pins the LEFT edge at 8px (group names stay readable) instead of going negative', () => {
        const { left } = openAddToFg({ w: 360, h: 600 }, { top: 100, left: 330, width: 24, height: 24 });
        expect(left).toBe(8);
    });

    it('flips above the anchor near the bottom of an 800x600 window, without covering the anchor', () => {
        const anchor = { top: 540, left: 266, width: 24, height: 24 };
        const { top } = openAddToFg({ w: 800, h: 600 }, anchor);
        expect(top).toBeGreaterThanOrEqual(8);
        expect(top + POP_HEIGHT).toBeLessThanOrEqual(anchor.top);
    });
});

// =============================================================================
// 2. AddSensorWindow 320px | minmax(0,1fr) grid at small sizes
// =============================================================================

describe('2. Add Special Sensor window layout at small window sizes', () => {
    const tracks = () => css('.special-sensor-body')['grid-template-columns'];

    it('CSS contract: fixed 320px left track, right track can shrink to 0 instead of pushing past the overflow-hidden root (which would CLIP the Tooling pane unreachably)', () => {
        expect(tracks()).toBe('320px minmax(0, 1fr)');
        expect(css('.special-sensor-body')['min-height']).toBe('0');
    });

    it('CSS contract: every column scrolls inside itself, so content stays reachable at small heights', () => {
        expect(css('.special-sensor-right')['overflow-y']).toBe('auto');
        expect(css('.special-sensor-right')['min-height']).toBe('0');
        expect(css('.special-sensor-left')['min-height']).toBe('0');
        expect(css('.special-sensor-explorer-list')['overflow-y']).toBe('auto');
        expect(css('.special-sensor-explorer-list')['min-height']).toBe('0');
        // The footer (Cancel / Add sensor) must not be squeezed out by the body.
        expect(css('.special-sensor-footer')['flex-shrink']).toBe('0');
        expect(css('.special-sensor-footer-hint')['min-width']).toBe('0');
        // Long sensor names ellipsize instead of widening the fixed column.
        expect(css('.special-sensor-row-name')['overflow']).toBe('hidden');
        expect(css('.special-sensor-row-main')['min-width']).toBe('0');
    });

    it('opens at 1000px wide, leaving the Tooling pane 680px — well above what one op card needs (100px card + 2x16px pane padding + 2x16px SensorTooling padding)', async () => {
        renderDashboard();
        fireEvent.click(screen.getByText('Add Special Sensor'));
        await waitFor(() => expect(webviewWindowCalls.find(c => c.label === 'add-sensor')).toBeTruthy());
        const { opts } = webviewWindowCalls.find(c => c.label === 'add-sensor')!;
        expect(opts.width).toBe(1000);
        const left = parseFloat(tracks().split(' ')[0]);
        const opCardMin = parseFloat(/minmax\((\d+)px/.exec(css('.special-sensor-opgrid')['grid-template-columns'])![1]);
        expect(opts.width - left).toBeGreaterThanOrEqual(opCardMin + 32 + 32);
    });

    // LOW, regression of an old guarantee: Split.js used `minSize: [300, 150]`
    // so the right (Tooling) pane never went below 150px while the window was
    // wide enough. The new fixed grid gives the right track `minmax(0, 1fr)`,
    // and the add-sensor WebviewWindow sets no minWidth/minHeight (decorations:
    // false; nothing in this app sets a window min size), so shrinking the
    // window narrows ONLY the Tooling pane — to 0 at a 320px-wide window.
    // Fix by EITHER giving the window a minWidth (>= 320 + 150) OR a right-
    // track floor; this test accepts either.
    it('the Tooling pane keeps at least the 150px floor Split.js used to enforce at the smallest size the window can be resized to', async () => {
        renderDashboard();
        fireEvent.click(screen.getByText('Add Special Sensor'));
        await waitFor(() => expect(webviewWindowCalls.find(c => c.label === 'add-sensor')).toBeTruthy());
        const { opts } = webviewWindowCalls.find(c => c.label === 'add-sensor')!;
        const [leftTrack, ...rest] = tracks().split(' ');
        const rightFloor = parseFloat(/minmax\((\d+)/.exec(rest.join(' '))?.[1] ?? '0');
        const smallestWindow = opts.minWidth ?? 0;
        expect(Math.max(rightFloor, smallestWindow - parseFloat(leftTrack))).toBeGreaterThanOrEqual(150);
    });

    describe('real SensorExplorer -> SensorTooling -> footer click-through inside the new grid', () => {
        beforeEach(() => {
            mockInvoke.mockImplementation(async (cmd: string) => {
                switch (cmd) {
                    case 'get_all_sensors': return ['timestamp', 'TAG1', 'TAG2'];
                    case 'calculate_new_sensor': return 'RootTag';
                    case 'extract_formula_refs': return [];
                    default: return undefined;
                }
            });
        });

        it('header tabs + footer actions live OUTSIDE the scrolling grid body, so they cannot scroll out of reach', async () => {
            render(<AddSensorWindow />);
            await screen.findByText('TAG1');
            const body = document.querySelector('.special-sensor-body')!;
            expect(body.contains(screen.getByText('Add sensor'))).toBe(false);
            expect(body.contains(screen.getByText('Cancel'))).toBe(false);
            expect(body.contains(screen.getByRole('tab', { name: 'Create' }))).toBe(false);
            // Explorer is in the fixed left track, Tooling in the right one.
            expect(document.querySelector('.special-sensor-left .special-sensor-explorer')).toBeTruthy();
            expect(document.querySelector('.special-sensor-right .special-sensor-srcs')).toBeTruthy();
        });

        it('pick a sensor on the left, an op card on the right, fill master data -> footer gate opens -> Add emits to Dashboard', async () => {
            render(<AddSensorWindow />);
            fireEvent.click(await screen.findByText('TAG1'));
            // Chip lands in the right pane's Source sensors box; row shows "Added".
            expect(document.querySelector('.special-sensor-srcs')!.textContent).toContain('TAG1');
            expect(screen.getByText('Added')).toBeTruthy();

            fireEvent.click(screen.getByText('Square root'));
            expect(screen.getByText('Square root').closest('.special-sensor-op-card')!.className).toContain('is-on');
            expect(screen.getByText(/Fill in a name, a description, a unit, a component before adding\./)).toBeTruthy();
            const addBtn = screen.getByText('Add sensor').closest('button')!;
            expect(addBtn.disabled).toBe(true);

            fireEvent.change(screen.getByPlaceholderText('e.g. Total Power'), { target: { value: 'RootTag' } });
            fireEvent.change(screen.getByPlaceholderText('RootTag'), { target: { value: 'Root of pressure' } });
            fireEvent.change(screen.getByPlaceholderText('e.g. kW'), { target: { value: 'bar' } });
            fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
            expect(addBtn.disabled).toBe(false);
            expect(screen.getByText('Adds a computed sensor to this workspace.')).toBeTruthy();

            await act(async () => { fireEvent.click(addBtn); });
            await waitFor(() => expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({
                newMetadata: [expect.objectContaining({ tag: 'RootTag', description: 'Root of pressure', unit: 'bar' })],
            })));
            expect(mockInvoke).toHaveBeenCalledWith('calculate_new_sensor', expect.objectContaining({ sensors: ['TAG1'] }));
        });
    });
});

// =============================================================================
// 3. Highlights 2-column dim + popovers through rapid chart-type switching
// =============================================================================

describe('3. Highlights panel: dim state and colour popovers through rapid chart-type switching (real Dashboard + real HighlightsPanel)', () => {
    type ChartLabel = 'Line' | 'Scatter' | 'Pair Plot';
    const kindOf = (l: ChartLabel) => (l === 'Line' ? 'line' : l === 'Scatter' ? 'scatter' : 'pair');

    function mountOnHighlights() {
        renderDashboard({ timeHighlights: [hl1], valueHighlight: vh });
        fireEvent.click(screen.getByText('Highlights'));
        const cols = document.querySelectorAll<HTMLElement>('.highlights-col');
        expect(cols).toHaveLength(2);
        return { timeCol: cols[0], valueCol: cols[1] };
    }

    function expectColumnsMatch(chart: ChartLabel) {
        const k = kindOf(chart);
        const [timeCol, valueCol] = Array.from(document.querySelectorAll<HTMLElement>('.highlights-col'));
        const timeFs = timeCol.querySelector('fieldset')!;
        const valueFs = valueCol.querySelector('fieldset')!;
        expect(timeFs.disabled, `By time disabled on ${chart}`).toBe(k === 'pair');
        expect(timeFs.classList.contains('highlights-fieldset--dim'), `By time dim on ${chart}`).toBe(k === 'pair');
        expect(valueFs.disabled, `By value disabled on ${chart}`).toBe(k !== 'scatter');
        expect(valueFs.classList.contains('highlights-fieldset--dim'), `By value dim on ${chart}`).toBe(k !== 'scatter');
        // Banners: one per column, only when that column is inert.
        expect(!!timeCol.querySelector('.highlights-note')).toBe(k === 'pair');
        expect(!!valueCol.querySelector('.highlights-note')).toBe(k !== 'scatter');
        expect(!!timeCol.querySelector('.highlights-inline-note')).toBe(k === 'scatter');
        // Band / Line colour live in the column HEADER (outside the fieldset)
        // so they need their own disabled gate: Line only.
        const seg = Array.from(timeCol.querySelectorAll<HTMLButtonElement>('.highlights-seg button'));
        expect(seg).toHaveLength(2);
        for (const b of seg) expect(b.disabled, `${b.textContent} disabled on ${chart}`).toBe(k !== 'line');
        // Exactly one chart-type button is active — the one we expect.
        expect(chartBtn(chart).className).toContain('active');
    }

    it('dim/disabled state is correct after EVERY step of a rapid Line -> Scatter -> Pair -> Line -> Pair -> Scatter -> Line cycle', () => {
        mountOnHighlights();
        expectColumnsMatch('Line');
        const cycle: ChartLabel[] = ['Scatter', 'Pair Plot', 'Line', 'Pair Plot', 'Scatter', 'Line'];
        for (const step of cycle) {
            fireEvent.click(chartBtn(step));
            expectColumnsMatch(step);
        }
    });

    it('a burst of switches inside ONE act() (single commit) still lands on the final chart type\'s state, not an intermediate one', () => {
        mountOnHighlights();
        act(() => {
            chartBtn('Scatter').click();
            chartBtn('Pair Plot').click();
            chartBtn('Scatter').click();
        });
        expectColumnsMatch('Scatter');
    });

    it('the persisted line-display choice survives the cycle (dimming disables, never resets, the setting)', () => {
        mountOnHighlights();
        const lineColourBtn = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.highlights-seg button')).find(b => b.textContent === 'Line colour')!;
        fireEvent.click(lineColourBtn());
        expect(lineColourBtn().className).toContain('is-on');
        for (const step of ['Scatter', 'Pair Plot', 'Line'] as ChartLabel[]) fireEvent.click(chartBtn(step));
        expect(lineColourBtn().className).toContain('is-on');
    });

    // ── popovers ──

    const SWATCH_TOP = 200;
    /** Scripted swatch geometry that MOVES with the column's layout: the
     *  Scatter-only inline note and the inert-column banner both sit above
     *  the chip list in the same column, pushing the swatch down. */
    function layoutAwareSwatches() {
        rectFor = (el) => {
            if (!(el instanceof HTMLElement) || !el.classList.contains('highlights-chip-swatch')) return null;
            const col = el.closest('.highlights-col');
            const shift = (col?.querySelector('.highlights-inline-note') ? 40 : 0) + (col?.querySelector('.highlights-note') ? 30 : 0);
            return mkRect({ top: SWATCH_TOP + shift, left: 40, width: 16, height: 16 });
        };
    }
    const timeSwatch = () => document.querySelectorAll<HTMLElement>('.highlights-col')[0].querySelector<HTMLButtonElement>('.highlights-chip-swatch')!;
    const valueSwatch = () => document.querySelectorAll<HTMLElement>('.highlights-col')[1].querySelector<HTMLButtonElement>('.highlights-chip-swatch')!;
    /** Popover is either gone, or sits right under where its swatch is NOW. */
    function expectNoStaleAnchor(swatch: () => HTMLElement) {
        const pops = openPopovers();
        if (pops.length === 0) return;
        expect(pops).toHaveLength(1);
        expect(parseFloat(pops[0].style.top)).toBe(swatch().getBoundingClientRect().bottom + 6);
    }

    it('By time popover: Line -> Pair Plot closes it, and Pair -> Line does not resurrect it (earlier fix, re-verified in the 2-column layout)', () => {
        layoutAwareSwatches();
        mountOnHighlights();
        fireEvent.click(timeSwatch());
        expect(openPopovers()).toHaveLength(1);
        fireEvent.click(chartBtn('Pair Plot'));
        expect(openPopovers()).toHaveLength(0);
        fireEvent.click(chartBtn('Line'));
        expect(openPopovers()).toHaveLength(0);
    });

    it('By value popover: Scatter -> Line and Scatter -> Pair Plot both close it, and switching back does not resurrect it', () => {
        layoutAwareSwatches();
        mountOnHighlights();
        fireEvent.click(chartBtn('Scatter'));
        fireEvent.click(valueSwatch());
        expect(openPopovers()).toHaveLength(1);
        fireEvent.click(chartBtn('Line'));
        expect(openPopovers()).toHaveLength(0);
        fireEvent.click(chartBtn('Scatter'));
        expect(openPopovers()).toHaveLength(0);

        fireEvent.click(valueSwatch());
        expect(openPopovers()).toHaveLength(1);
        fireEvent.click(chartBtn('Pair Plot'));
        expect(openPopovers()).toHaveLength(0);
        fireEvent.click(chartBtn('Scatter'));
        expect(openPopovers()).toHaveLength(0);
    });

    it('rapid Line -> Scatter -> Pair -> Line with the By time popover open ends with no popover (Pair step clears it)', () => {
        layoutAwareSwatches();
        mountOnHighlights();
        fireEvent.click(timeSwatch());
        for (const step of ['Scatter', 'Pair Plot', 'Line'] as ChartLabel[]) fireEvent.click(chartBtn(step));
        expect(openPopovers()).toHaveLength(0);
    });

    // NEW GAP (not covered by the earlier fix, which only clears a popover
    // when its column becomes INERT). Line <-> Scatter keeps the By time
    // column live, so its colour popover stays open — but Scatter inserts the
    // "Not adjustable here — Scatter always renders highlights as a ring"
    // note ABOVE the chip list in the same column (and Scatter -> Line
    // removes it), so the swatch moves while the popover stays at the
    // position captured before the switch. AnchoredPopover only reacts to
    // scroll/resize; neither fires here. Pre-existing (the note sat above the
    // list in the stacked layout too), not introduced by the 2-column rewrite.
    // Severity LOW-MEDIUM: popover visibly detached from its chip by ~one
    // note's height. Fix: clear highlightColorFor/Anchor on any chartType
    // change (simplest), or re-measure the anchor.
    it('By time popover open on Line -> switch to Scatter: popover is closed or re-anchored, not left at the pre-switch position', () => {
        layoutAwareSwatches();
        mountOnHighlights();
        fireEvent.click(timeSwatch());
        expect(openPopovers()).toHaveLength(1);
        fireEvent.click(chartBtn('Scatter'));
        expectNoStaleAnchor(timeSwatch);
    });

    it('By time popover open on Scatter -> switch to Line: popover is closed or re-anchored, not left at the pre-switch position', () => {
        layoutAwareSwatches();
        mountOnHighlights();
        fireEvent.click(chartBtn('Scatter'));
        fireEvent.click(timeSwatch());
        expect(openPopovers()).toHaveLength(1);
        fireEvent.click(chartBtn('Line'));
        expectNoStaleAnchor(timeSwatch);
    });

    // Same "…For state not cleared when its column goes inert" class, for the
    // inline rename input: `editLabelFor` is gated on highlightApplies for
    // rendering but never cleared, so a rename left open across a Pair Plot
    // round trip re-mounts (autoFocus) with the old draft. Pre-existing; LOW.
    it('an in-progress highlight rename does not reappear after a Line -> Pair Plot -> Line round trip', () => {
        mountOnHighlights();
        fireEvent.click(screen.getByTitle('Rename'));
        fireEvent.change(document.querySelector('.highlights-rename-input')!, { target: { value: 'half-typed' } });
        fireEvent.click(chartBtn('Pair Plot'));
        expect(document.querySelector('.highlights-rename-input')).toBeNull();
        fireEvent.click(chartBtn('Line'));
        expect(document.querySelector('.highlights-rename-input')).toBeNull();
    });
});

// =============================================================================
// 4. FilterPanel segmented operator -> wire payload
// =============================================================================

describe('4. Filter tab segmented operator control -> chart/scatter query value_filters (real Dashboard + real FilterPanel)', () => {
    // What lib.rs `ResolvedFilter::keeps` matches on. Anything else falls into
    // `_ => true` and silently filters NOTHING — so the 4 buttons must emit
    // exactly these strings.
    const RUST_OPS = ['greater_than', 'less_than', 'equals', 'between'];
    const SEGMENTS: Array<[string, string, string]> = [
        ['Greater than', '>', 'greater_than'],
        ['Less than', '<', 'less_than'],
        ['Equals', '=', 'equals'],
        ['Between', '↔', 'between'],
    ];

    function openFilterWithCondition() {
        renderDashboard();
        fireEvent.click(screen.getByText('Filter'));
        fireEvent.click(screen.getByText('Add condition'));
        expect(document.querySelectorAll('.filter-row')).toHaveLength(1);
    }
    const valueInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('.filter-row .filter-row-value'));
    const seg = (title: string) => screen.getByTitle(title) as HTMLButtonElement;
    const apply = () => fireEvent.click(screen.getByText('Apply filter'));

    for (const [title, label, wireOp] of SEGMENTS) {
        it(`"${label}" (${title}) reaches the chart query as operation "${wireOp}" with exactly the contract's value-filter fields`, () => {
            openFilterWithCondition();
            fireEvent.click(seg(title));
            fireEvent.change(valueInputs()[0], { target: { value: '10' } });
            if (wireOp === 'between') fireEvent.change(valueInputs()[1], { target: { value: '50' } });
            apply();
            const vf = lastChartQuery().filter.value_filters;
            expect(vf).toHaveLength(1);
            expect(RUST_OPS).toContain(vf[0].operation);
            expect(vf[0]).toEqual({
                sensor: 'TAG1', operation: wireOp, value1: 10,
                value2: wireOp === 'between' ? 50 : null,
            });
            expect(Object.keys(vf[0]).sort()).toEqual([...contract.value_filter_fields].sort());
        });
    }

    it('the same payload reaches the Scatter sample query (shared wireValueFilters)', () => {
        renderDashboard({ chartType: 'scatter' });
        fireEvent.click(screen.getByText('Filter'));
        fireEvent.click(screen.getByText('Add condition'));
        fireEvent.click(seg('Less than'));
        fireEvent.change(valueInputs()[0], { target: { value: '3.5' } });
        apply();
        const scatterFilter = last(mockUseScatterSample.mock.calls)![0] as any;
        expect(scatterFilter.value_filters).toEqual([{ sensor: 'TAG1', operation: 'less_than', value1: 3.5, value2: null }]);
    });

    it('between <-> non-between shows/hides the max field; the row always keeps 5 grid cells to match `.filter-row`\'s 5 columns; exactly one segment is on', () => {
        openFilterWithCondition();
        const cols = css('.filter-row')['grid-template-columns'];
        expect(cols).toBeTruthy();
        const row = () => document.querySelector('.filter-row')!;
        const onCount = () => Array.from(document.querySelectorAll('.filter-op-seg button')).filter(b => b.className.includes('is-on')).length;

        expect(valueInputs()).toHaveLength(1);
        expect(valueInputs()[0].placeholder).toBe('value');
        for (const [title] of SEGMENTS) {
            fireEvent.click(seg(title));
            const isBetween = title === 'Between';
            expect(valueInputs()).toHaveLength(isBetween ? 2 : 1);
            expect(valueInputs()[0].placeholder).toBe(isBetween ? 'min' : 'value');
            expect(row().children).toHaveLength(5);
            expect(onCount()).toBe(1);
            expect(seg(title).className).toContain('is-on');
        }
    });

    it('switching operator before Apply is a draft-only change: the query keeps the last APPLIED operator until Apply', () => {
        openFilterWithCondition();
        fireEvent.change(valueInputs()[0], { target: { value: '10' } });
        apply();
        expect(lastChartQuery().filter.value_filters[0].operation).toBe('greater_than');
        fireEvent.click(seg('Equals'));
        expect(screen.getByText('Changes not applied yet')).toBeTruthy();
        expect(lastChartQuery().filter.value_filters[0].operation).toBe('greater_than');
        apply();
        expect(lastChartQuery().filter.value_filters[0].operation).toBe('equals');
    });

    // Stale state: the max typed for "between" survives a switch to a
    // non-between operator (field hidden, value kept in the draft) and is
    // sent on the wire alongside e.g. greater_than; switching back to
    // between resurrects the old max. Rust ignores value2 for non-between
    // today (lib.rs `ResolvedFilter::keeps`), so no wrong rows — but the
    // payload no longer reflects what's on screen. Pre-existing (the old
    // native-<select> row behaved the same); the segmented rewrite makes
    // quick toggling much more likely. LOW.
    it('after between(10..50) -> ">" and Apply, the hidden max is not carried on the wire', () => {
        openFilterWithCondition();
        fireEvent.click(seg('Between'));
        fireEvent.change(valueInputs()[0], { target: { value: '10' } });
        fireEvent.change(valueInputs()[1], { target: { value: '50' } });
        fireEvent.click(seg('Greater than'));
        apply();
        expect(lastChartQuery().filter.value_filters[0]).toEqual({ sensor: 'TAG1', operation: 'greater_than', value1: 10, value2: null });
    });
});

// =============================================================================
// 5. .timebar Reset period (now after Aggregation)
// =============================================================================

describe('5. Time range bar: "Reset period" resets ONLY the period (judged on the real chart query)', () => {
    beforeEach(() => {
        mockUseDatasetTimeBounds.mockReturnValue({
            bounds: { min: '2025-01-01T00:00:00Z', max: '2025-06-01T00:00:00Z' }, loading: false, error: null,
        });
    });
    const aggregation = () => document.querySelector<HTMLSelectElement>('.timebar-select')!;
    // An explicit saved (empty) filter set opts out of the first-open
    // 6-month default, so the test controls the period itself.
    const emptyFilters = { timestampStart: '', timestampEnd: '', sensorFilters: [] };

    it('Reset period clears timestamp_start/end but leaves the query\'s sampling (Aggregation) at the user\'s choice — and the timebar order is Aggregation then Reset', () => {
        renderDashboard({ filters: emptyFilters });
        fireEvent.click(screen.getByTitle('Apply relative range'));
        fireEvent.change(aggregation(), { target: { value: 'max' } });
        expect(lastChartQuery().sampling).toBe('max');
        expect(lastChartQuery().filter.timestamp_start).not.toBeNull();

        const reset = screen.getByText('Reset period').closest('button')!;
        expect(aggregation().compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        fireEvent.click(reset);

        const q = lastChartQuery();
        expect(q.filter.timestamp_start).toBeNull();
        expect(q.filter.timestamp_end).toBeNull();
        expect(q.sampling).toBe('max');
        expect(aggregation().value).toBe('max');
        // The button only exists while a period is set — it removes itself.
        expect(screen.queryByText('Reset period')).toBeNull();
    });

    it('the reverse also holds: changing Aggregation never touches the period', () => {
        renderDashboard({ filters: emptyFilters });
        fireEvent.click(screen.getByTitle('Apply relative range'));
        const { timestamp_start, timestamp_end } = lastChartQuery().filter;
        for (const v of ['avg', 'min', 'first', 'last', 'raw']) {
            fireEvent.change(aggregation(), { target: { value: v } });
            expect(lastChartQuery().sampling).toBe(v);
            expect(lastChartQuery().filter.timestamp_start).toBe(timestamp_start);
            expect(lastChartQuery().filter.timestamp_end).toBe(timestamp_end);
        }
    });

    it('Reset period keeps APPLIED sensor value filters from the Filter tab (it spreads the rest of FilterState)', () => {
        renderDashboard({ filters: emptyFilters });
        fireEvent.click(screen.getByTitle('Apply relative range'));
        fireEvent.click(screen.getByText('Filter'));
        fireEvent.click(screen.getByText('Add condition'));
        fireEvent.change(document.querySelector('.filter-row-value')!, { target: { value: '7' } });
        fireEvent.click(screen.getByText('Apply filter'));
        expect(lastChartQuery().filter.value_filters).toHaveLength(1);

        fireEvent.click(screen.getByText('Reset period'));
        expect(lastChartQuery().filter.timestamp_start).toBeNull();
        expect(lastChartQuery().filter.value_filters).toEqual([{ sensor: 'TAG1', operation: 'greater_than', value1: 7, value2: null }]);
        expect(document.querySelectorAll('.filter-row')).toHaveLength(1);
    });

    it('Reset period is persisted by autosave without disturbing samplingMethod', async () => {
        renderDashboard({ filters: emptyFilters });
        fireEvent.click(screen.getByTitle('Apply relative range'));
        fireEvent.change(aggregation(), { target: { value: 'last' } });
        fireEvent.click(screen.getByText('Reset period'));
        await waitFor(() => {
            const saved = last(mockSaveWorkspaceData.mock.calls)?.[0] as any;
            expect(saved?.filters?.timestampStart).toBe('');
            expect(saved?.samplingMethod).toBe('last');
        });
    });

    // Cross-zone seam (Dashboard timebar <-> FilterPanel draft): FilterPanel
    // re-syncs its WHOLE draft from the parent whenever the parent's
    // FilterState differs (its "Sync from parent when parent resets"
    // effect), and the time period lives in that same FilterState. So
    // clicking Reset period while the Filter tab has an UN-applied condition
    // (both are on screen at once) silently discards the drafted condition —
    // the same happens for Apply-relative-range or editing Start/End. Not
    // introduced by Phase 5 (the sync effect pre-dates it), but it is
    // exactly "Reset period touched something other than the period".
    // LOW-MEDIUM: user-typed work lost with no warning.
    it('an UN-applied Filter-tab condition survives a Reset period click', () => {
        renderDashboard({ filters: emptyFilters });
        fireEvent.click(screen.getByTitle('Apply relative range'));
        fireEvent.click(screen.getByText('Filter'));
        fireEvent.click(screen.getByText('Add condition'));
        fireEvent.change(document.querySelector('.filter-row-value')!, { target: { value: '7' } });
        expect(screen.getByText('Changes not applied yet')).toBeTruthy();

        fireEvent.click(screen.getByText('Reset period'));
        expect(document.querySelectorAll('.filter-row')).toHaveLength(1);
        expect((document.querySelector('.filter-row-value') as HTMLInputElement).value).toBe('7');
    });
});
