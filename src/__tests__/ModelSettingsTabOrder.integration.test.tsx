import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';

/*
 * Spec: docs/design/handoff/model-settings-layout/README.md — "Tab walks the form as it
 * reads": Model name → the kind's own setting → Training data → the sensors.
 *
 * `BuildModelWindow.test.tsx` ("Model settings layout") already pins the LABELS of the form
 * in DOM order for the three kinds, and the grid rules of App.css. Two things decide whether
 * the keyboard really follows what the eye reads, and neither is pinned there:
 *
 *   1. the CONTROLS a Tab stops on (not the labels) come in that order — in the real window,
 *      with the real pickers, not the mocked ones of that file; and nothing in the form takes
 *      itself out of the natural order with a positive `tabindex`;
 *   2. the CSS never moves a field away from its DOM position: the first SPEC draft placed the
 *      fields with `grid-area`, which made the visual order independent of the DOM (the dev
 *      pass dropped it and moved the JSX instead). If `grid-area` / `order` / an explicit
 *      row or column ever comes back on a field, the labels test still passes while Tab jumps
 *      around the form.
 *
 * This file checks both across the component (BuildModelWindow) and the stylesheet (App.css).
 */

vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/healthEnv')).eventModule());
vi.mock('@tauri-apps/plugin-fs', async () => (await import('./helpers/healthEnv')).fsModule());
vi.mock('@tauri-apps/plugin-store', async () => (await import('./helpers/healthEnv')).storeModule());
vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/healthEnv')).coreModule());
vi.mock('@tauri-apps/api/window', async () => (await import('./helpers/healthEnv')).windowModule());
vi.mock('../components/charts/ResponsiveECharts', async () => (await import('./helpers/healthEnv')).chartModule());
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class { static getByLabel = vi.fn().mockResolvedValue(null); once = vi.fn(); },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../errorReporter', () => ({ reportError: vi.fn() }));

import { resetEnv } from './helpers/healthEnv';
import { bmw, model, mountWindows, newBackend, openSettings, selectKindTab, selectSensor, settle, writeDisk, wsState } from './helpers/healthWorkbench';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// jsdom does not load App.css (cwd is the repo root, as in BuildModelWindow.test.tsx).
const APP_CSS: string = readFileSync('src/App.css', 'utf-8');

/** What the keyboard can stop on, in the order the browser visits it (DOM order — the form
 *  must not contain a positive tabindex, which is asserted separately). */
const TABBABLE = 'button, input, select, textarea, a[href], [tabindex]';
const tabStops = (form: HTMLElement) => Array.from(form.querySelectorAll<HTMLElement>(TABBABLE))
    .filter(el => !(el as HTMLButtonElement).disabled && el.getAttribute('tabindex') !== '-1' && el.getAttribute('type') !== 'hidden');

/** The label of the field a control belongs to ("Model name", "Stiffness", …). */
const fieldOf = (el: HTMLElement): string => {
    const fld = el.closest('.f4-fld');
    const label = fld?.querySelector(':scope > label, :scope > .f4-lbl');
    // the label's own text, without the inline hint ("· requires …") and the count chip
    return (label?.childNodes[0]?.textContent ?? label?.textContent ?? '(outside a field)').trim();
};

/** The fields Tab walks through, each named once, in the order it reaches them. */
function tabWalk(form: HTMLElement): string[] {
    const out: string[] = [];
    for (const el of tabStops(form)) {
        const f = fieldOf(el);
        if (out[out.length - 1] !== f) out.push(f);
    }
    return out;
}

const IND = model({ id: 'i1', kind: 'individual' });
const REL = model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3', 'TAG4'] });
const CLU = model({
    id: 'c1', kind: 'clustering', xSensor: 'TAG3', ySensor: 'TAG5', criteriaSensor: 'TAG4', numClusters: 2,
    clusterRanges: [{ min: 0, max: 50 }, { min: 50, max: 100 }],
});

async function openForm(key: string, tab: 'Individual' | 'Relation model' | 'Clustering'): Promise<HTMLElement> {
    selectSensor(key);
    await settle(50);
    selectKindTab(tab);
    await settle(50);
    openSettings();
    await settle(50);
    return bmw().getByTestId('add-model-form');
}

describe('Model settings — Tab walks the form in the order it reads, for every kind (real window + App.css)', () => {
    it('Individual: Model name → Training data (Boundary is a read-out: seen between them, never a Tab stop)', async () => {
        writeDisk(wsState({ models: [IND, REL, CLU] }));
        await mountWindows({ dashboard: false });
        const form = await openForm('tag1', 'Individual');
        expect(tabWalk(form)).toEqual(['Model name', 'Training data']);
        // the read-out sits between the two in the DOM (= on screen), and holds nothing focusable
        const ro = bmw().getByTestId('boundary-readout');
        expect(ro.querySelector(TABBABLE)).toBeNull();
        const name = form.querySelector('.f4-fld--name')!;
        const train = form.querySelector('.f4-fld--traindata')!;
        expect(name.compareDocumentPosition(ro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(ro.compareDocumentPosition(train) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('Relation model: Model name → Stiffness (its four options, loosest first) → Training data → Predictor sensors', async () => {
        writeDisk(wsState({ models: [IND, REL, CLU] }));
        await mountWindows({ dashboard: false });
        const form = await openForm('tag1', 'Relation model');
        expect(tabWalk(form)).toEqual(['Model name', 'Stiffness', 'Training data', 'Predictor sensors (≥ 1)']);
        // inside Stiffness the options are visited left to right, as printed
        const stiff = tabStops(form).filter(el => fieldOf(el) === 'Stiffness').map(el => el.textContent);
        expect(stiff).toEqual(['Very loose', 'Loose', 'Standard', 'Strict']);
        // Training data: Workspace before Custom
        expect(tabStops(form).filter(el => fieldOf(el) === 'Training data').map(el => el.textContent)).toEqual(['Workspace', 'Custom']);
    });

    it('Clustering: Model name → Clusters (− then +) → Training data → Y sensor → Criteria sensor → Cluster ranges (X is locked: never a Tab stop)', async () => {
        writeDisk(wsState({ models: [IND, REL, CLU] }));
        await mountWindows({ dashboard: false });
        const form = await openForm('tag3', 'Clustering');
        const walk = tabWalk(form);
        expect(walk.slice(0, 5)).toEqual(['Model name', 'Clusters', 'Training data', 'Y sensor (target)', 'Criteria sensor (optional)']);
        // whatever follows belongs to the last field of the form, and nothing goes back up
        expect(new Set(walk.slice(5))).toEqual(new Set(['Cluster ranges']));
        expect(walk).not.toContain('X sensor');
        expect(tabStops(form).filter(el => fieldOf(el) === 'Clusters').map(el => el.getAttribute('aria-label'))).toEqual(['Fewer clusters', 'More clusters']);
    });

    it.each([
        ['tag1', 'Individual'], ['tag1', 'Relation model'], ['tag3', 'Clustering'],
    ] as const)('%s / %s: nothing in the form has a positive tabindex, and no field is visited twice', async (key, tab) => {
        writeDisk(wsState({ models: [IND, REL, CLU] }));
        await mountWindows({ dashboard: false });
        const form = await openForm(key, tab);
        for (const el of form.querySelectorAll<HTMLElement>('[tabindex]')) {
            expect(Number(el.getAttribute('tabindex')), el.outerHTML.slice(0, 80)).toBeLessThanOrEqual(0);
        }
        const walk = tabWalk(form);
        expect(new Set(walk).size, `Tab leaves a field and comes back to it: ${walk.join(' → ')}`).toBe(walk.length);
        expect(walk[0]).toBe('Model name');
        expect(walk).not.toContain('(outside a field)');
    });

    it('Custom training data: the model\'s own running-condition panel is the LAST thing Tab reaches', async () => {
        writeDisk(wsState({ models: [IND, REL, CLU] }));
        await mountWindows({ dashboard: false });
        const form = await openForm('tag1', 'Relation model');
        const custom = tabStops(form).find(el => fieldOf(el) === 'Training data' && el.textContent === 'Custom')!;
        custom.click();
        await settle(100);
        const panel = form.querySelector<HTMLElement>('.rc-custom');
        expect(panel, 'the Custom panel is part of the form').not.toBeNull();
        const stops = tabStops(form);
        const firstInPanel = stops.findIndex(el => panel!.contains(el));
        expect(firstInPanel).toBeGreaterThan(0);
        // every stop before the panel is a field of the grid; every stop from there on is inside the panel
        expect(stops.slice(0, firstInPanel).every(el => !panel!.contains(el))).toBe(true);
        expect(stops.slice(firstInPanel).every(el => panel!.contains(el))).toBe(true);
        expect(stops.slice(0, firstInPanel).map(fieldOf).filter((f, i, a) => a[i - 1] !== f))
            .toEqual(['Model name', 'Stiffness', 'Training data', 'Predictor sensors (≥ 1)']);
    });
});

describe('App.css never moves a Model-settings field away from its DOM position (so the eye and Tab agree)', () => {
    /** Every rule whose selector targets the form body or something inside it. */
    const rules = Array.from(APP_CSS.matchAll(/([^{}]*\.bmw-sets-(?:body|kind)[^{}]*)\{([^{}]*)\}/g)).map(m => ({ sel: m[1].trim(), body: m[2] }));

    it('finds the form\'s rules (the scan below is not empty)', () => {
        expect(rules.length).toBeGreaterThan(10);
        expect(rules.some(r => /\.bmw-sets-body\s*$/.test(r.sel) && /display:\s*grid/.test(r.body))).toBe(true);
    });

    it('no `order`, `grid-area`, `grid-row`, reversed direction or explicit column start on the form or its fields', () => {
        for (const { sel, body } of rules) {
            expect(body, sel).not.toMatch(/(^|[;\s])order\s*:/);
            expect(body, sel).not.toMatch(/grid-area\s*:/);
            expect(body, sel).not.toMatch(/grid-template-areas\s*:/);
            expect(body, sel).not.toMatch(/grid-row(-start|-end)?\s*:/);
            expect(body, sel).not.toMatch(/(row|column)-reverse/);
            expect(body, sel).not.toMatch(/direction\s*:\s*rtl/);
            expect(body, sel).not.toMatch(/grid-auto-flow\s*:\s*(column|dense)/);
            // a field may only SPAN the whole row; it is never pinned to a column
            for (const m of Array.from(body.matchAll(/grid-column(?:-start|-end)?\s*:\s*([^;]+)/g)) as RegExpMatchArray[]) {
                expect(m[1].trim(), `${sel} { grid-column }`).toBe('1 / -1');
            }
        }
    });

    it('`.bmw-sets-kind` is only a grouping (display: contents) — it cannot reorder its fields either', () => {
        const kind = rules.filter(r => /\.bmw-sets-kind\s*$/.test(r.sel));
        expect(kind.length).toBeGreaterThan(0);
        expect(kind.some(r => /display:\s*contents/.test(r.body))).toBe(true);
    });
});
