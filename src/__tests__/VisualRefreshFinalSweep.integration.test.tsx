/**
 * Final cross-cutting QA sweep of the whole 2026-10-02 visual refresh
 * (Phase 0 b6eebf3 -> Phase 4 ed518ae, plus the a4b53a6/ab5d9a3 popover
 * QA/fix cycle). Every phase verified itself with tsc/vitest/vite build
 * only, and jsdom never applies App.css — so nothing so far checked that the
 * four surfaces that now supposedly share ONE token/class set (Dashboard
 * Sensor tab, Dashboard Failure Groups tab, Build Model Workbench, PM full
 * page) actually agree with each other in the stylesheet, or that what the
 * components render still exists in it. This file covers that seam:
 *
 *   1. CSS contract — the same semantic element (I/R/C kind colour, status
 *      dot colour, modal backdrop, popover surface) resolves to the same
 *      value on every surface, after resolving the Phase 0 `var(--…)`
 *      aliases back to their base tokens.
 *   2. Class contract — every class the refreshed components actually
 *      render (all dot states, legend, footer, edit panel, both portaled
 *      popovers) is defined in App.css, so a later rename can't silently
 *      leave an unstyled element (jsdom would never notice).
 *   3. Bugs found by this sweep (originally recorded as `it.fails`, per this
 *      repo's convention) — all 5 fixed 2026-10-02, tests now plain `it`:
 *        - the FG-tab legend showed a "Not trained" dot that no badge ever
 *          rendered (Phase 2 legend vs Phase C "no dot = never trained") —
 *          fixed by dropping the marker from the legend's "Not trained" entry;
 *        - (2026-10-03: the add-to-FG popover is now the docked Failure Group
 *          Assignment sheet — those cases were re-pointed at it, see below.)
 *        - SensorSelection's portaled popovers resurrected at a stale
 *          captured anchor after their row unmounted and remounted
 *          (collapse/expand, search filter-out/clear) — same class as fixed
 *          bug #6 (`colorPickerFor`), but in SensorSelection's own state —
 *          fixed by a shared visible-row-set effect;
 *        - a popover left open while the sensor search narrowed the list
 *          kept floating at its old coordinates (layout reflow, no scroll) —
 *          fixed by closing any open row popover on every search keystroke;
 *        - the Dashboard colour/pin-Y-axis popovers and the Highlights
 *          colour popover had the same stale-anchor bug via a chart-type
 *          round trip (Line -> Scatter -> Line / Line -> Pair Plot -> Line)
 *          — fixed by clearing their "…For" state when their popover can no
 *          longer legitimately be open;
 *        - the viewport clamp only ran once at mount, so a popover that
 *          GREW while open (creating a group from the add-to-FG menu) ran
 *          off the bottom of the window — fixed with a ResizeObserver on the
 *          popover element that re-runs the same clamp.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';
import FailureGroupsPanel from '../components/dashboard/FailureGroupsPanel';
import SensorSelection from '../components/dashboard/SensorSelection';
import HighlightsPanel from '../components/dashboard/HighlightsPanel';
import AnchoredPopover from '../components/AnchoredPopover';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import type { FailureGroup, FailureModel, FailureGroupStateSlice, SensorMetadata, TimeHighlight, ValueHighlight } from '../types';

// ── tiny App.css parser (jsdom does not load the stylesheet) ─────────────

type CssRule = { selectors: string[]; decls: Record<string, string>; inAtRule: boolean };

function parseCss(src: string): CssRule[] {
    const css = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules: CssRule[] = [];
    let depth = 0; // number of open @-blocks (@media / @container / @keyframes)
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
            rules.push({ selectors: h.split(',').map(s => s.trim().replace(/\s+/g, ' ')), decls, inAtRule: depth > 0 });
            i = end;
        } else if (ch === '}') {
            if (depth > 0) depth--;
            head = '';
        } else {
            head += ch;
        }
    }
    return rules;
}

const RULES = parseCss(readFileSync('src/App.css', 'utf-8'));
const DEFINED_CLASSES = new Set<string>();
for (const r of RULES) for (const s of r.selectors) for (const m of s.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) DEFINED_CLASSES.add(m[1]);

/** Merged base-level (not inside @media/@container) declarations for one exact selector, last wins. */
function declsFor(selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    let found = false;
    for (const r of RULES) {
        if (r.inAtRule || !r.selectors.includes(selector)) continue;
        found = true;
        Object.assign(out, r.decls);
    }
    if (!found) throw new Error(`no base-level CSS rule for ${selector}`);
    return out;
}
const ROOT = declsFor(':root');
/** Resolves `var(--x)` (recursively) against :root so a Phase 0 alias compares equal to its base token. */
function resolve(value: string | undefined, seen = 0): string | undefined {
    if (value === undefined || seen > 10) return value;
    const next = value.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g, (_, name: string, fallback?: string) => ROOT[name] ?? fallback ?? `<undefined ${name}>`);
    return next === value ? value : resolve(next, seen + 1);
}
const prop = (selector: string, p: string) => resolve(declsFor(selector)[p]);

// ── shared fixtures ───────────────────────────────────────────────────────

function makeModel(o: Partial<FailureModel> = {}): FailureModel {
    return {
        id: 'm1', groupNos: [1], name: '', kind: 'individual', category: 'performance', notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimePeriods: [],
        runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
        ...o,
    };
}
const notInGroup: FailureGroup = { no: 0, name: 'Not in Group' };
const groupA: FailureGroup = { no: 1, name: 'Group A' };
const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump', alarmH: 90, alarmL: 10 },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
    { tag: 'TAG3', description: 'Fan Speed', unit: 'rpm', component: 'Fan' },
];

/** FG panel props with one sensor per dot state: TAG1 untrained (I), TAG2 trained (R), TAG3 complete (C). */
function fgPanelProps(overrides: Partial<React.ComponentProps<typeof FailureGroupsPanel>> = {}) {
    const runningConditionFg: Partial<FailureGroupStateSlice> = { runningConditionNoneConfirmed: true };
    const untrained = makeModel({ id: 'u', targetSensor: 'TAG1' });
    const toTrain = makeModel({ id: 't', kind: 'relationship', targetSensor: 'TAG2', predictorSensors: ['TAG1'] });
    const fg = { ...runningConditionFg, models: [untrained, toTrain] };
    const trained = { ...toTrain, lastTrainedAt: '2026-10-02T00:00:00.000Z', trainedFingerprint: computeTrainFingerprint(toTrain, fg) };
    const complete = makeModel({ id: 'c', kind: 'clustering', xSensor: 'TAG3', ySensor: 'TAG1', targetSensor: '', status: true });
    return {
        fgGroups: [notInGroup, groupA],
        fgModels: [untrained, trained, complete],
        sensorMetadata,
        runningConditionFg,
        datasetHeaders: null,
        getGroupColor: () => 'blue',
        onUpdateGroupDetails: vi.fn(),
        onDeleteGroup: vi.fn(),
        onCreateEmptyGroup: vi.fn(),
        onDeleteModel: vi.fn(),
        onOpenBuildModel: vi.fn(),
        ...overrides,
    };
}

function sensorProps(overrides: Partial<React.ComponentProps<typeof SensorSelection>> = {}) {
    return {
        sensors: ['TAG1', 'TAG2'],
        selectedSensors: [] as string[],
        onSensorChange: vi.fn(),
        sensorMetadata,
        fgGroups: [notInGroup, groupA],
        fgModels: [makeModel({ id: 'm1', targetSensor: 'TAG1' })],
        getGroupColor: () => 'blue',
        onToggleSensorGroupKind: vi.fn(),
        onCreateGroupForSensor: vi.fn(),
        onRenameGroup: vi.fn(),
        onDeleteGroup: vi.fn(),
        alarmLinesEnabled: {} as Record<string, any>,
        onToggleAlarmLine: vi.fn(),
        ...overrides,
    };
}
function renderSensorSelection(overrides: Partial<React.ComponentProps<typeof SensorSelection>> = {}) {
    const props = sensorProps(overrides);
    const utils = render(<SensorSelection {...props} />);
    fireEvent.click(screen.getByText('Pump')); // expand the component group
    return { ...utils, props };
}

const rectAt = (top: number, left = 300): DOMRect =>
    ({ top, bottom: top + 26, left, right: left + 26, width: 26, height: 26, x: left, y: top, toJSON() {} }) as DOMRect;
const folderButtons = () => screen.getAllByTitle('Add to failure group');
const openPopovers = () => Array.from(document.querySelectorAll<HTMLElement>('#wizard-portal-root .sensor-popover'));

const origRect = HTMLElement.prototype.getBoundingClientRect;
afterEach(() => {
    cleanup();
    HTMLElement.prototype.getBoundingClientRect = origRect;
    document.getElementById('wizard-portal-root')?.remove();
});

// ── 1. CSS contract across the four surfaces ─────────────────────────────

describe('CSS contract: the same semantic element renders the same on every refreshed surface', () => {
    const KINDS = ['individual', 'relationship', 'clustering'] as const;

    it('I/R/C kind badge colours agree across FG tab (.kind-badge--*), Build Model Workbench + Sensor tab chips (.model-kind-icon--*)', () => {
        for (const k of KINDS) {
            expect(prop(`.kind-badge--${k}`, 'color'), `${k} text colour`).toBe(prop(`.model-kind-icon--${k}`, 'color'));
            expect(prop(`.kind-badge--${k}`, 'background'), `${k} background`).toBe(prop(`.model-kind-icon--${k}`, 'background'));
            expect(prop(`.kind-badge--${k}`, 'color')).not.toMatch(/undefined/);
        }
    });

    it('status dot colours agree between the FG tab dot, the Build Model dot (same .f4-kb-dot class), the FG legend and the Phase 0 .kind-badge-dot', () => {
        for (const state of ['trained', 'complete'] as const) {
            const dot = prop(`.f4-kb-dot--${state}`, 'background');
            expect(dot).toBeTruthy();
            expect(prop(`.fg-legend-dot--${state}`, 'background'), `legend ${state}`).toBe(dot);
            expect(prop(`.kind-badge-dot--${state}`, 'background'), `.kind-badge-dot ${state}`).toBe(dot);
        }
        // The legend's neutral dot and the Phase 0 neutral dot share one fill.
        expect(prop('.fg-legend-dot', 'background')).toBe(prop('.kind-badge-dot', 'background'));
    });

    it('the FG tab keeps .f4-kb-dot inside a .kind-badge shell — both shells are positioned, so the absolute corner dot stays on its badge (not the .sensor-autocomplete-icon escape bug)', () => {
        expect(declsFor('.f4-kb-dot').position).toBe('absolute');
        expect(declsFor('.f4-kb').position).toBe('relative');
        expect(declsFor('.kind-badge').position).toBe('relative');
    });

    it('every modal backdrop on Dashboard and Build Model uses the one glass scrim (rgba(0,0,0,.55) + blur(2px)) after Phases 3/4', () => {
        const backdrops = [
            '.bmw-modal-backdrop',          // Build Model: Running Condition modal (Phase 3)
            '.pm-chart-modal-backdrop',     // Build Model: expand-chart modal (Phase 4)
            '.pm-preview-modal-backdrop',   // Build Model: Sub-models modal (Phase 4)
            '.predictor-picker-backdrop',   // SensorPickerModal, both windows (Phase 4)
            '.pair-regl-modal-backdrop',    // Dashboard: Pair Plot table modal (pre-existing)
            '.pair-regl-expand-backdrop',   // Dashboard: Pair Plot expanded cell (pre-existing)
        ];
        for (const sel of backdrops) {
            const d = declsFor(sel);
            expect(d.background, sel).toBe('rgba(0, 0, 0, 0.55)');
            expect(d['backdrop-filter'], sel).toBe('blur(2px)');
        }
    });

    it('both floating editor surfaces on the Dashboard use the --pop popover token', () => {
        expect(declsFor('.popover-surface').background).toBe('var(--pop)');
        expect(declsFor('.scatter-regl-axis-editor').background).toBe('var(--pop)');
        expect(ROOT['--pop']).toBeTruthy();
    });

    it('every Phase 0 alias token resolves to a real base token (no dangling var())', () => {
        for (const t of ['--pop', '--ki', '--kr', '--kc', '--ki-m', '--kr-m', '--kc-m', '--ok-m', '--dot-empty']) {
            const v = resolve(`var(${t})`)!;
            expect(v, t).not.toMatch(/undefined|var\(/);
        }
    });
});

describe('chart palette across surfaces (ECharts/WebGL literals — canvas cannot read CSS tokens)', () => {
    const src = (p: string): string => readFileSync(p, 'utf-8');
    const root = (name: string) => ROOT[name];

    it('Dashboard LineChart + ScatterChart literals equal the tokens their comments claim (Phase 1)', () => {
        const line = src('src/components/charts/LineChart.tsx');
        expect(line).toContain(`const txtPrimary  = '${root('--text-primary')}'`);
        expect(line).toContain(`const txtSecondary = '${root('--text-secondary')}'`);
        expect(root('--card-bg')).toBe('#101012');
        // CANVAS_BG = (16, 16, 18) / 255 = --card-bg #101012
        expect(src('src/components/charts/ScatterChart.tsx')).toContain('[0.0627, 0.0627, 0.0706, 1.0]');
    });

    // FIXED (2026-10-02). Phase 1 recoloured the Dashboard LineChart's
    // axis/grid/tooltip literals away from the pre-refresh Tailwind slate
    // palette (#94a3b8 / #334155 / navy tooltip rgba(30,41,59,…)), calling
    // it "visibly off-palette". Phases 3/4 were CSS-only by brief (zero
    // JSX/TS changes), so the SAME palette was left hardcoded in the ECharts
    // option builders of BuildModelWindow.tsx (Relationship/Clustering
    // result charts) and PredictiveModelBuild.tsx (three preview-chart
    // builders, plus the Individual result's `meanColor` markLine). Net
    // effect in the real app before this fix: inside ONE Workbench window,
    // the Individual result (LineChart) showed the new neutral
    // tooltip/grid while the Relationship/Clustering result showed the old
    // navy one; same on the PM full page. Fixed by copying the exact
    // literal values LineChart.tsx's Phase 1 fix already established
    // (txtPrimary '#ededef', txtSecondary '#8c8c94', gridLine '#2a2a30',
    // tooltipBg 'rgba(23, 23, 28, 0.92)', tooltipBorder
    // 'rgba(255, 255, 255, 0.12)') into every offending constant in both
    // files — a pure color-literal swap, no option-building logic touched.
    it('no chart option builder on Build Model still uses the pre-refresh slate palette Phase 1 removed from LineChart', () => {
        const offenders: string[] = [];
        for (const f of ['src/components/windows/BuildModelWindow.tsx', 'src/components/windows/SubModelsModal.tsx', 'src/components/windows/workbench/healthCharts.ts', 'src/components/windows/workbench/healthPageCharts.ts', 'src/components/windows/workbench/chartTheme.ts', 'src/components/charts/LineChart.tsx']) {
            const code = src(f).split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
            const hits = code.match(/'#(94a3b8|334155|f1f5f9)'|rgba\(30,\s*41,\s*59/g) ?? [];
            if (hits.length) offenders.push(`${f}: ${hits.length}`);
        }
        expect(offenders).toEqual([]); // (before the fix: BuildModelWindow.tsx had 9 hits, the now-deleted PredictiveModelBuild.tsx 16)
    });
});

// ── 2. class contract: what the refreshed components render exists in App.css ──

// Classes rendered as pure hooks (no styling ever intended) or Tailwind
// utilities — pre-existing before the refresh, checked against the
// pre-Phase-0 App.css (b6eebf3~1): none of these were ever defined there.
const NOT_EXPECTED_IN_APP_CSS = new Set([
    'fg-panel-widget',
    'h-full', 'flex', 'flex-col', 'flex-shrink-0', 'flex-1', 'min-h-0', 'overflow-y-auto',
]);
function undefinedClasses(roots: Element[]): string[] {
    const missing = new Set<string>();
    for (const root of roots) {
        for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
            for (const c of Array.from(el.classList)) {
                if (c.startsWith('lucide')) continue; // lucide-react's own icon classes
                if (!DEFINED_CLASSES.has(c) && !NOT_EXPECTED_IN_APP_CSS.has(c)) missing.add(c);
            }
        }
    }
    return [...missing].sort();
}

describe('class contract: every class the refreshed components render is defined in App.css', () => {
    it('FailureGroupsPanel — all three dot states, legend, search, summary chip, group row, Edit details, footer + new-group input', () => {
        const { container } = render(<FailureGroupsPanel {...fgPanelProps()} />);
        document.querySelectorAll('[aria-expanded="false"]').forEach(b => fireEvent.click(b));
        fireEvent.click(screen.getByText('Edit details'));
        const roots: Element[] = [container];
        // Dot states actually present (so the check isn't vacuous):
        expect(container.querySelector('.f4-kb-dot--trained')).not.toBeNull();
        expect(container.querySelector('.f4-kb-dot--complete')).not.toBeNull();
        expect(container.querySelector('.fg-edit-saved')).not.toBeNull();
        expect(undefinedClasses(roots)).toEqual([]);
        fireEvent.click(screen.getByText('Add failure group'));
        expect(undefinedClasses(roots)).toEqual([]);
    });

    it('SensorSelection — rows, unit badge, the portaled assignment sheet (matrix, row menu, delete confirm, create error) and the alarm popover', () => {
        const { container } = renderSensorSelection();
        fireEvent.click(folderButtons()[0]);
        expect(screen.getByTestId('fg-sheet')).toBeTruthy();
        const roots = () => [container, document.getElementById('wizard-portal-root')!];
        expect(undefinedClasses(roots())).toEqual([]);
        // Every state of the sheet: a row menu, an inline delete confirm, a create error.
        fireEvent.click(screen.getByRole('button', { name: 'Group actions: Group A' }));
        expect(undefinedClasses(roots())).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: /Delete…/ }));
        expect(screen.getByRole('alertdialog')).toBeTruthy();
        expect(undefinedClasses(roots())).toEqual([]);
        fireEvent.change(screen.getByLabelText('New failure group name'), { target: { value: 'group a' } });
        fireEvent.click(screen.getByRole('button', { name: /Create/ }));
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(undefinedClasses(roots())).toEqual([]);
        // The alarm popover (opening it closes the sheet).
        fireEvent.click(screen.getByTitle('Alarm setpoints'));
        expect(screen.getByText('High (90)')).toBeTruthy();
        expect(undefinedClasses(roots())).toEqual([]);
    });

    it('the Undo toast classes are defined too', () => {
        // Rendered by UndoToastStack; Dashboard tests mock the sheet's neighbours, so check the contract here.
        expect(DEFINED_CLASSES.has('fg-undo-stack')).toBe(true);
        expect(DEFINED_CLASSES.has('fg-undo-toast')).toBe(true);
        expect(DEFINED_CLASSES.has('fg-undo-toast-btn')).toBe(true);
        expect(DEFINED_CLASSES.has('sensor-list-row--fg-target')).toBe(true);
    });
});

// ── 3. known bugs ──────────────────────────────────────────────────────

describe('FG tab legend vs the badges it explains', () => {
    // FIXED (2026-10-02). Phase 2 added a legend copied from the approved
    // prototype: "• Not trained  • Trained  • Complete", where the "Not
    // trained" marker was a neutral grey ringed dot (`.fg-legend-dot`,
    // --dot-empty + inset ring). In the prototype that matches `.kb b`,
    // which is ALWAYS rendered (neutral when untrained). In the app, Phase C
    // chose "no dot = never trained" (`dot !== 'none' && …` in
    // FailureGroupsPanel.tsx's renderSensorRow, and Build Model's own left
    // list does the same) — so the legend was explaining a grey dot that no
    // badge on screen ever shows. Fixed by dropping the marker from the
    // legend's "Not trained" entry (the smaller, lower-risk of the two
    // sanctioned fixes — it doesn't touch any badge render path, just the
    // legend that documents them).
    it('the legend\'s "Not trained" marker matches what an untrained badge actually renders', () => {
        const { container } = render(<FailureGroupsPanel {...fgPanelProps()} />);
        const legendNotTrained = screen.getByText('Not trained').querySelector('.fg-legend-dot');
        const untrainedBadge = container.querySelector('[data-testid="fg-sensor-row-1:tag1"] .kind-badge--individual')!;
        expect(untrainedBadge).not.toBeNull();
        const badgeDot = untrainedBadge.querySelector('.f4-kb-dot, .kind-badge-dot');
        expect(!!badgeDot).toBe(!!legendNotTrained);
    });
});

describe('SensorSelection assignment sheet — never left open or resurrected over a row that is gone (same class as fixed bug #6)', () => {
    // 2026-10-03: the add-to-FG AnchoredPopover (whose stale captured rect these
    // tests used to pin) became the docked Failure Group Assignment sheet. The
    // failure mode is the same — a panel for a sensor whose row left the list,
    // popping back unasked — so the same three triggers are kept, now asserting
    // the sheet is closed and stays closed. (Its arrow is re-measured from the
    // live row on every scroll/resize, so it can no longer sit at a stale rect.)
    const sheet = () => screen.queryByTestId('fg-sheet');

    it('collapsing then re-expanding the component does not resurrect the sheet', () => {
        renderSensorSelection();
        fireEvent.click(folderButtons()[0]);
        expect(sheet()).not.toBeNull();
        fireEvent.click(screen.getByText('Pump')); // collapse
        expect(sheet()).toBeNull();
        fireEvent.click(screen.getByText('Pump')); // expand — nothing else clicked
        expect(sheet()).toBeNull();
        expect(folderButtons()[0].classList.contains('on')).toBe(false);
    });

    it('filtering the open row out with the search box and clearing it again does not resurrect the sheet', () => {
        renderSensorSelection();
        fireEvent.click(folderButtons()[0]); // TAG1
        expect(sheet()).not.toBeNull();
        const search = screen.getByPlaceholderText('Search sensors...');
        fireEvent.change(search, { target: { value: 'Temp' } }); // TAG1 filtered out
        expect(sheet()).toBeNull();
        fireEvent.change(search, { target: { value: '' } });
        expect(sheet()).toBeNull();
    });

    it('narrowing the sensor search while the sheet is open (the edited row merely moves up) closes it rather than leaving it pointing at the wrong row', () => {
        renderSensorSelection();
        fireEvent.click(folderButtons()[1]); // TAG2
        expect(sheet()).not.toBeNull();
        fireEvent.change(screen.getByPlaceholderText('Search sensors...'), { target: { value: 'Temp' } });
        expect(sheet()).toBeNull();
    });

    it('the ‹ › buttons CAN reach a collapsed component\'s sensor without tripping that "row is gone" closing (they expand it in the same update)', () => {
        // Display order: Fan (TAG3, collapsed here), then Pump (TAG1, TAG2 — expanded by the helper).
        renderSensorSelection({ sensors: ['TAG1', 'TAG2', 'TAG3'] });
        fireEvent.click(folderButtons()[0]); // TAG1 — the first sensor of Pump; the previous one is in the collapsed "Fan"
        fireEvent.click(within(screen.getByTestId('fg-sheet')).getByRole('button', { name: 'Previous sensor' }));
        expect(sheet()).not.toBeNull();
        expect(screen.getByTestId('fg-sheet').getAttribute('aria-label')).toBe('Failure groups for Fan Speed');
        expect(document.querySelector('.sensor-list-row--fg-target')?.textContent).toContain('Fan Speed');
    });
});

describe('HighlightsPanel colour popover — same stale-anchor resurrection via a chart-type round trip', () => {
    const h1: TimeHighlight = { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true };
    const hlProps = (chartType: 'line' | 'scatter' | 'pair') => ({
        timeHighlights: [h1],
        onAddTimeHighlight: vi.fn(), onToggleTimeHighlight: vi.fn(), onRemoveTimeHighlight: vi.fn(),
        onRecolorTimeHighlight: vi.fn(), onRenameTimeHighlight: vi.fn(),
        lineDisplay: 'band' as const, onSetLineDisplay: vi.fn(),
        valueHighlight: { sensor: '', ranges: [] } as ValueHighlight,
        valueHighlightSensors: ['TAG1'],
        onSetValueHighlightSensor: vi.fn(), onAddValueHighlightRange: vi.fn(), onToggleValueHighlightRange: vi.fn(),
        onRemoveValueHighlightRange: vi.fn(), onRecolorValueHighlightRange: vi.fn(),
        chartType,
    });

    // FIXED (2026-10-02) — the third component with the same pattern as the
    // Dashboard colour/pin popovers (see Dashboard.test.tsx's
    // "Line -> Scatter -> Line" tests): the popover's render is gated on
    // `highlightApplies` (false on Pair Plot) but `highlightColorFor` /
    // `highlightColorAnchor` weren't cleared when it turned false, so
    // Line -> Pair Plot -> Line re-mounted the picker unasked at the old
    // captured screen position (the panel's layout changed in between: the
    // "Not shown on Pair Plot" banner appears above the list on Pair Plot).
    // Fixed by an effect in HighlightsPanel.tsx keyed on
    // `highlightApplies`/`valueHighlightApplies` that clears both colour
    // popovers' "…For"/anchor state the moment either turns false.
    it('Line -> Pair Plot -> Line does not resurrect the time-highlight colour popover unasked', () => {
        const { rerender } = render(<HighlightsPanel {...hlProps('line')} />);
        const swatch = screen.getByTitle('Change colour');
        swatch.getBoundingClientRect = () => rectAt(100);
        fireEvent.click(swatch);
        expect(openPopovers()).toHaveLength(1);
        rerender(<HighlightsPanel {...hlProps('pair')} />);
        expect(openPopovers()).toHaveLength(0);
        rerender(<HighlightsPanel {...hlProps('line')} />);
        expect(openPopovers()).toHaveLength(0); // actual: 1, at the pre-switch top (132px)
    });
});

describe('AnchoredPopover viewport clamp (direct consumer)', () => {
    // 2026-10-03: this block used to also pin the clamp against the add-to-FG
    // menu GROWING while open (creating a group added a row; a ResizeObserver
    // re-ran the clamp). That menu is now the docked assignment sheet, which is
    // sized by the Sensors panel instead of clamped near an anchor, so those two
    // cases went with it. The ResizeObserver path itself is still covered by
    // AnchoredPopover.test.tsx; the direct clamp is re-confirmed here.
    it('the clamp itself still works for a direct AnchoredPopover consumer (re-confirms fix #2 after Phases 2-4)', () => {
        HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
            if (this.classList.contains('sensor-popover')) {
                const top = parseFloat(this.style.top) || 0;
                const left = parseFloat(this.style.left) || 0;
                return { top, bottom: top + 300, left, right: left + 200, width: 200, height: 300, x: left, y: top, toJSON() {} } as DOMRect;
            }
            return origRect.call(this);
        };
        const h = window.innerHeight;
        render(
            <AnchoredPopover anchorRect={{ top: h - 40, bottom: h - 14, left: 100, right: 126 }} onRequestClose={() => {}} width={200}>
                <div>content</div>
            </AnchoredPopover>,
        );
        const pop = openPopovers()[0];
        const top = parseFloat(pop.style.top);
        expect(top + 300).toBeLessThanOrEqual(h - 40); // flipped above the anchor
        expect(top).toBeGreaterThanOrEqual(8);
    });
});
