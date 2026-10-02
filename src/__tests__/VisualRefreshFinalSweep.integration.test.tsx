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
 *   3. Known bugs (recorded as `it.fails`, per this repo's convention — app
 *      code is NOT changed by this sweep):
 *        - the FG-tab legend shows a "Not trained" dot that no badge ever
 *          renders (Phase 2 legend vs Phase C "no dot = never trained");
 *        - SensorSelection's portaled popovers resurrect at a stale captured
 *          anchor after their row unmounts and remounts (collapse/expand,
 *          search filter-out/clear) — same class as fixed bug #6
 *          (`colorPickerFor`), but in SensorSelection's own state;
 *        - a popover left open while the sensor search narrows the list
 *          keeps floating at its old coordinates (layout reflow, no scroll);
 *        - the viewport clamp only runs once at mount, so a popover that
 *          GROWS while open (creating a group from the add-to-FG menu)
 *          runs off the bottom of the window.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

    it('every modal backdrop on Dashboard, Build Model and the PM page uses the one glass scrim (rgba(0,0,0,.55) + blur(2px)) after Phases 3/4', () => {
        const backdrops = [
            '.bmw-modal-backdrop',          // Build Model: Running Condition modal (Phase 3)
            '.pm-chart-modal-backdrop',     // PM page + Build Model: expand-chart modal (Phase 4)
            '.pm-preview-modal-backdrop',   // PM page: Sub-models modal (Phase 4)
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

    // KNOWN GAP (LOW, cosmetic) — not a documented exception. Phase 1
    // recoloured the Dashboard LineChart's axis/grid/tooltip literals away
    // from the pre-refresh Tailwind slate palette (#94a3b8 / #334155 /
    // navy tooltip rgba(30,41,59,…)), calling it "visibly off-palette".
    // Phases 3/4 were CSS-only by brief (zero JSX/TS changes), so the SAME
    // palette is still hardcoded in the ECharts option builders of
    // BuildModelWindow.tsx (Relationship/Clustering result charts) and
    // PredictiveModelBuild.tsx (three preview-chart builders). Net effect in
    // the real app: inside ONE Workbench window, the Individual result
    // (LineChart) shows the new neutral tooltip/grid while the
    // Relationship/Clustering result shows the old navy one; same on the PM
    // full page. Phase 4's note only says ResponsiveECharts has no
    // className to restyle — it never mentions these option literals.
    it.fails('no chart option builder on Build Model / PM page still uses the pre-refresh slate palette Phase 1 removed from LineChart', () => {
        const offenders: string[] = [];
        for (const f of ['src/components/windows/BuildModelWindow.tsx', 'src/components/windows/PredictiveModelBuild.tsx', 'src/components/charts/LineChart.tsx']) {
            const code = src(f).split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
            const hits = code.match(/'#(94a3b8|334155|f1f5f9)'|rgba\(30,\s*41,\s*59/g) ?? [];
            if (hits.length) offenders.push(`${f}: ${hits.length}`);
        }
        expect(offenders).toEqual([]); // actual: BuildModelWindow.tsx: 9, PredictiveModelBuild.tsx: 16
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

    it('SensorSelection — rows, unit badge, both portaled popovers', () => {
        const { container } = renderSensorSelection();
        fireEvent.click(folderButtons()[0]);
        expect(openPopovers()).toHaveLength(1);
        expect(undefinedClasses([container, document.getElementById('wizard-portal-root')!])).toEqual([]);
        fireEvent.click(screen.getByTitle('Alarm setpoints'));
        expect(screen.getByText('High (90)')).toBeTruthy();
        expect(undefinedClasses([container, document.getElementById('wizard-portal-root')!])).toEqual([]);
    });
});

// ── 3. known bugs ──────────────────────────────────────────────────────

describe('FG tab legend vs the badges it explains', () => {
    // KNOWN BUG (LOW, cosmetic) — Phase 2 added a legend copied from the
    // approved prototype: "• Not trained  • Trained  • Complete", where the
    // "Not trained" marker is a neutral grey ringed dot (`.fg-legend-dot`,
    // --dot-empty + inset ring). In the prototype that matches `.kb b`,
    // which is ALWAYS rendered (neutral when untrained). In the app, Phase C
    // chose "no dot = never trained" (`dot !== 'none' && …` in
    // FailureGroupsPanel.tsx's renderSensorRow, and Build Model's own left
    // list does the same) — so the legend explains a grey dot that no badge
    // on screen ever shows. Either fix makes this pass: render a neutral dot
    // for untrained (`.f4-kb-dot` with no modifier would need a neutral fill
    // — today it has NO background at all) or drop the marker from the
    // legend's "Not trained" entry.
    it.fails('the legend\'s "Not trained" marker matches what an untrained badge actually renders', () => {
        const { container } = render(<FailureGroupsPanel {...fgPanelProps()} />);
        const legendNotTrained = screen.getByText('Not trained').querySelector('.fg-legend-dot');
        const untrainedBadge = container.querySelector('[data-testid="fg-sensor-row-1:tag1"] .kind-badge--individual')!;
        expect(untrainedBadge).not.toBeNull();
        const badgeDot = untrainedBadge.querySelector('.f4-kb-dot, .kind-badge-dot');
        expect(!!badgeDot).toBe(!!legendNotTrained);
    });
});

describe('SensorSelection portaled popovers — stale anchor after the row unmounts/moves (same class as fixed bug #6)', () => {
    // A popover reopened without a click must either stay closed or sit
    // under its CURRENT trigger button — never at coordinates captured from
    // a button element that no longer exists.
    const reanchoredOrClosed = () => {
        const pops = openPopovers();
        if (pops.length === 0) return true;
        const fresh = folderButtons()[0].getBoundingClientRect();
        return pops[0].style.top === `${fresh.bottom + 6}px`;
    };

    // KNOWN BUG (LOW-MEDIUM). `groupMenuFor`/`groupMenuAnchor` (and the
    // alarm pair) live in SensorSelection's state, but the popover is
    // rendered as a child of the sensor row. Collapsing the component
    // unmounts the row (the popover disappears — covered by
    // PortaledPopovers' "collapsing … unmounts" test), but the state stays
    // set; expanding again re-mounts the popover at the anchor rect captured
    // BEFORE the collapse. Before Phase 1 the menu was inline and simply
    // reappeared inside its row; now it reappears at a fixed screen position
    // (the list may have scrolled, or the window resized, while it was
    // collapsed — no listener is attached while unmounted). Fix idea: clear
    // the open-popover state when the component is collapsed / the row
    // unmounts (same remedy as Dashboard's colorPickerFor prune).
    it.fails('collapsing then re-expanding the component does not resurrect the add-to-FG popover at its old screen position', () => {
        renderSensorSelection();
        folderButtons()[0].getBoundingClientRect = () => rectAt(100);
        fireEvent.click(folderButtons()[0]);
        expect(openPopovers()[0].style.top).toBe('132px');
        fireEvent.click(screen.getByText('Pump')); // collapse
        expect(openPopovers()).toHaveLength(0);
        fireEvent.click(screen.getByText('Pump')); // expand — nothing else clicked
        expect(reanchoredOrClosed()).toBe(true); // actual: reappears at 132px, new button is at 0
    });

    // KNOWN BUG (LOW-MEDIUM) — same mechanism via the search box: filter the
    // open row out (popover unmounts), clear the search (it re-mounts at
    // the stale rect).
    it.fails('filtering the open row out with the search box and clearing it again does not resurrect the popover at its old position', () => {
        renderSensorSelection();
        folderButtons()[0].getBoundingClientRect = () => rectAt(100); // TAG1
        fireEvent.click(folderButtons()[0]);
        expect(openPopovers()).toHaveLength(1);
        const search = screen.getByPlaceholderText('Search sensors...');
        fireEvent.change(search, { target: { value: 'Temp' } }); // TAG1 filtered out
        expect(openPopovers()).toHaveLength(0);
        fireEvent.change(search, { target: { value: '' } });
        expect(reanchoredOrClosed()).toBe(true); // actual: reappears at 132px
    });

    // KNOWN BUG (LOW). Narrowing the list while a popover is open (the
    // anchored row stays mounted but moves up) fires no scroll/resize, so
    // AnchoredPopover's "close when the anchor may have moved" rule never
    // triggers — the popover keeps floating where the row USED to be,
    // detached from it. Inline (pre-Phase 1) the menu moved with its row.
    it.fails('narrowing the sensor search while a row popover is open does not leave it floating at the row\'s old position', () => {
        renderSensorSelection();
        const tag2Btn = folderButtons()[1];
        tag2Btn.getBoundingClientRect = () => rectAt(200);
        fireEvent.click(tag2Btn);
        expect(openPopovers()[0].style.top).toBe('232px');
        fireEvent.change(screen.getByPlaceholderText('Search sensors...'), { target: { value: 'Temp' } });
        // TAG1's row is gone, so TAG2's (same element, still mounted) moved up.
        expect(folderButtons()).toHaveLength(1);
        expect(folderButtons()[0]).toBe(tag2Btn);
        tag2Btn.getBoundingClientRect = () => rectAt(100);
        const pops = openPopovers();
        expect(pops.length === 0 || pops[0].style.top === '132px').toBe(true); // actual: still 232px
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

    // KNOWN BUG (LOW) — the third component with the same pattern as the
    // Dashboard colour/pin popovers (see Dashboard.test.tsx's
    // "Line -> Scatter -> Line" it.fails): the popover's render is gated on
    // `highlightApplies` (false on Pair Plot) but `highlightColorFor` /
    // `highlightColorAnchor` are not cleared when it turns false, so
    // Line -> Pair Plot -> Line re-mounts the picker unasked at the old
    // captured screen position (the panel's layout changed in between: the
    // "Not shown on Pair Plot" banner appears above the list on Pair Plot).
    it.fails('Line -> Pair Plot -> Line does not resurrect the time-highlight colour popover unasked', () => {
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

describe('AnchoredPopover viewport clamp vs content that grows while open', () => {
    /** Popover height = 40px + 30px per group row inside it (jsdom has no layout). */
    function mockPopoverLayout() {
        HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
            if (this.classList.contains('sensor-popover')) {
                const rows = this.querySelectorAll('[class*="fg-group-color-"]').length;
                const height = 40 + 30 * rows;
                const top = parseFloat(this.style.top) || 0;
                const left = parseFloat(this.style.left) || 0;
                return { top, bottom: top + height, left, right: left + 290, width: 290, height, x: left, y: top, toJSON() {} } as DOMRect;
            }
            return origRect.call(this);
        };
    }

    it('control: a popover that fits below its anchor at open time is placed fully on screen', () => {
        mockPopoverLayout();
        renderSensorSelection();
        const btn = folderButtons()[0];
        btn.getBoundingClientRect = () => rectAt(614); // bottom 640 of a 768px window
        fireEvent.click(btn);
        const pop = openPopovers()[0];
        const r = pop.getBoundingClientRect();
        expect(r.height).toBe(100); // Group A + Not in Group rows
        expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
    });

    // KNOWN BUG (LOW). AnchoredPopover clamps once — in its callback ref,
    // when the node is first inserted (plus a layout effect keyed on
    // anchorRect/width only). The add-to-FG menu stays open after "Create"
    // (commitCreateGroup only clears the draft), and the parent adds the
    // new group as one more row, so the menu grows downward from a `top`
    // that was computed for the smaller size. Opened from the lower part of
    // the window, the bottom of the menu — the "New group name" input and
    // its error line — slides off screen, and since `.sensor-popover` only
    // scrolls internally once it hits max-height, there is no way to reach
    // it short of closing and reopening. Fix idea: re-run applyClamp from a
    // ResizeObserver on the popover element (or after every render).
    it.fails('creating a group from the add-to-FG menu (menu grows by one row) keeps the whole menu on screen', () => {
        mockPopoverLayout();
        const { props, rerender } = renderSensorSelection();
        const btn = folderButtons()[0];
        btn.getBoundingClientRect = () => rectAt(614);
        fireEvent.click(btn);
        const input = screen.getByPlaceholderText('New group name');
        fireEvent.change(input, { target: { value: 'Seal leak' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(props.onCreateGroupForSensor).toHaveBeenCalledWith('TAG1', 'Seal leak');
        // The parent (Dashboard) adds the group -> the still-open menu grows.
        rerender(<SensorSelection {...props} fgGroups={[...props.fgGroups, { no: 2, name: 'Seal leak' }]} />);
        expect(openPopovers()).toHaveLength(1);
        const r = openPopovers()[0].getBoundingClientRect();
        expect(r.height).toBe(130);
        expect(r.bottom).toBeLessThanOrEqual(window.innerHeight); // actual: 776 > 768
    });

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
