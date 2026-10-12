// @vitest-environment node
/**
 * CSS class coverage guard.
 *
 * jsdom never loads `src/App.css`, so no component test can notice that a
 * class the UI still renders has lost its CSS rule. This
 * file is the static guard that keeps a deletion of "unreferenced" rules (or a typo in a new
 * className) from silently un-styling something.
 *
 * What it checks, all statically over the non-test source in `src/`:
 *  1. Every class token with one of the project's styled prefixes that appears
 *     in a string literal (className strings, template-literal static parts,
 *     ternary branches, helpers in .ts files) has at least one rule in App.css
 *     — except an explicit allow-list of known unstyled hook classes.
 *  2. Every dynamically composed class (`prefix-${x}`) has a CSS family
 *     (some defined class starts with that prefix), and for the finite enums
 *     the code composes from, every member is styled.
 *  3. The classes on the deleted list are referenced nowhere in source.
 *  4. Every `animation` in App.css names a defined @keyframes, and every
 *     `var(--x)` without a fallback names a defined custom property.
 *
 * Keep it fast: plain string scanning, no TS parser.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync, readdirSync } from 'node:fs';
// @ts-expect-error - same
import { join, relative } from 'node:path';

// Typed wrappers (the node imports above are untyped without @types/node).
const readText = (p: string): string => readFileSync(p, 'utf8');
const listDir = (p: string): { name: string; isDirectory: () => boolean }[] => readdirSync(p, { withFileTypes: true });
const joinPath = (...a: string[]): string => join(...a);
const relPath = (from: string, to: string): string => relative(from, to);

/** vitest runs with the repo root as cwd (the same assumption BuildModelWindow.test.tsx makes). */
const ROOT = '.';
const SRC = joinPath(ROOT, 'src');
const RAW_CSS = readText(joinPath(SRC, 'App.css'));
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Prefixes whose classes are hand-written in App.css (not tailwind utilities). */
const STYLED_PREFIXES = [
    'bmw', 'wb2', 'wb3', 'hs', 'rcc', 'rcm', 'rcs', 'rcx', 'fg', 'pm', 'f4',
    'sensor-picker', 'predictor-picker', 'sensor-autocomplete',
    'kind-badge', 'model-kind-icon', 'model-status-pill', 'pair-regl', 'scatter-regl',
    'special-sensor', 'highlights', 'timebar', 'line-chart',
    'tpe', 'vt',                       // Train/Test validation (TestPeriodsEditor, ValidationCards)
    'sl', 'pk', 'cp', 'tt',            // shared SensorLabel / SensorPicker / ColourPicker / tooltip rows
];

/**
 * Known class tokens that are rendered but intentionally have no rule of their
 * own (structural hooks / default look of a modifier family). Adding to this
 * list should be a conscious decision — say why.
 */
const ALLOW_UNSTYLED = new Set<string>([
    'fg-panel-widget',                 // FailureGroupsPanel root; layout is inline style, never had a rule
    'scatter-regl-axes',               // inline-styled SVG overlay (ScatterChart)
    'scatter-regl-canvas-wrap',        // inline-styled wrapper (ScatterChart)
    'wb2-card--normal',                // default ChartCard size = the base `.wb2-card` look
]);

/** Dynamic suffix families: prefix -> every value the code can produce. */
const DYNAMIC_ENUMS: Record<string, readonly string[]> = {
    'fg-group-color-': ['slate', 'amber', 'violet', 'green', 'blue'],          // Dashboard getFgGroupColor
    'fg-sheet-cell--': ['individual', 'relationship', 'clustering'],
    'kind-badge--': ['individual', 'relationship', 'clustering'],
    'model-kind-icon--': ['individual', 'relationship', 'clustering'],
    'model-status-pill--': ['complete', 'trained', 'incomplete'],               // BuildModelWindow pillState
    'f4-kb-dot--': ['trained', 'complete', 'need', 'bad'],                       // dotStatusFor + DOT_CLASS
    'rc-impact--': ['amber', 'grey'],                                             // BuildModelWindow: the impact line next to Apply (tone)
    'wb2-card--': ['tall', 'xtall', 'stack', 'stackxy'],                         // ChartCardSize minus 'normal'
    'wb3-kpi--': ['ok', 'warn', 'bad'],                                          // Kpi tone (a score value's band colour)
    'hs-chk--': ['ok', 'need', 'bad'],
    'wb3-tab-words--': ['complete', 'need', 'bad'],                              // BuildModelWindow tabDotOf: the tone of a kind tab's status words
    'wb3-ruler--': ['individual', 'relationship', 'clustering'],                 // ScoreRuler: the model kind
    'wb3-ruler-sc--': ['ok', 'warn', 'bad', 'off'],                              // ScoreRuler: a tick's score colour (off = no score yet)
    'gutter-': ['horizontal', 'vertical'],                                       // split.js
};

/** Deleted in 4622c84 — must not come back as references. */
const DELETED_IN_PHASE4 = [
    'predictive-container', 'predictive-body', 'config-input', 'plot-placeholder-sub',
    'pm-commandbar', 'pm-breadcrumb', 'pm-crumb-sep', 'pm-crumb-muted', 'pm-crumb-current', 'pm-flex-spacer',
    'pm-grid', 'pm-grid--no-right', 'pm-col-left', 'pm-col-right', 'pm-col-center',
    'pm-section', 'pm-section-header', 'pm-eyebrow', 'pm-section-title', 'pm-section-hint',
    'pm-target-card', 'pm-target-card-top', 'pm-target-icon', 'pm-target-tag', 'pm-target-desc', 'pm-target-meta',
    'pm-mode-row', 'pm-segmented', 'pm-segmented-btn', 'pm-axis-info', 'pm-axis-faint',
    'pm-chart-card', 'pm-chart-header', 'pm-chart-legend', 'pm-legend-dot', 'pm-legend-line',
    'pm-legend-accent', 'pm-legend-warn', 'pm-legend-danger', 'pm-legend-dashed', 'pm-chart-zoom-note',
    'pm-chart-body', 'pm-chart-expand-btn', 'pm-fields-clustering', 'pm-field-grid-2', 'pm-config-error',
    'pm-stat-pills', 'pm-stat-pill', 'pm-stat-pill-label', 'pm-stat-pill-value',
    'pm-stepper', 'pm-stepper-btn', 'pm-stepper-value',
    'pm-progress', 'pm-progress-track', 'pm-progress-bar', 'pm-progress-bar--indeterminate', 'pm-progress-label',
    'pm-scatter-x-selector', 'pm-stats-strip', 'pm-stats-eyebrow', 'pm-stats-item', 'pm-stats-label',
    'pm-stats-value', 'pm-stats-warn', 'pm-selected-list', 'pm-selected-chip', 'pm-selected-dot',
    'pm-selected-dot-1', 'pm-selected-dot-2', 'pm-selected-dot-3', 'pm-selected-dot-4', 'pm-selected-text',
    'pm-selected-tag', 'pm-selected-desc', 'pm-selected-remove', 'pm-empty-dashed', 'pm-chart-stack',
    'pm-chart-empty', 'pm-config-block', 'pm-config-dim', 'pm-fields',
    'f4-seg--two', 'f4-wsw', 'f4-wsw-t', 'f4-wsw-s', 'f4-reason--bad', 'f4-formula', 'f4-formula--compact',
    'f4-rolist', 'f4-roline', 'f4-roline--sans', 'f4-roline-d', 'f4-dot--faint', 'bmw-result-stats',
] as const;

// ── helpers ──────────────────────────────────────────────────────────────
function definedClasses(css: string): Set<string> {
    const out = new Set<string>();
    for (const block of css.split('}')) {
        const parts = block.split('{');
        if (parts.length < 2) continue;
        const sel = parts[parts.length - 2];
        for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
    }
    return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const e of listDir(dir)) {
        const p = joinPath(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== '__tests__') sourceFiles(p, out);
        } else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
            out.push(p);
        }
    }
    return out;
}

/** Comments blanked (newlines kept so line numbers survive). */
function stripTsComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`\\])\/\/.*$/gm, (m, a: string) => a + ' '.repeat(m.length - a.length));
}

/** String literal contexts that are never class names. */
const NON_CLASS_CONTEXT = /(data-[\w-]+|testid|testId|key|id|htmlFor|name|aria-[\w-]+|role|type|label|title|placeholder)\s*[=:]\s*\{?\s*$|(getByTestId|queryByTestId|emit|emitTo|listen|once|subscribe|invoke|reportError|logToFile)\s*(<[^()]*>)?\(\s*$/;

interface Lit { file: string; line: number; text: string; template: boolean }

const DEFINED = definedClasses(CSS);
const FILES = sourceFiles(SRC).map(f => ({ rel: relPath(ROOT, f).replace(/\\/g, '/'), code: stripTsComments(readText(f)) }));

function literals(): Lit[] {
    const out: Lit[] = [];
    const litRe = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    for (const { rel, code } of FILES) {
        for (const m of code.matchAll(litRe)) {
            const before = code.slice(Math.max(0, m.index! - 40), m.index);
            if (NON_CLASS_CONTEXT.test(before)) continue;
            out.push({ file: rel, line: code.slice(0, m.index).split('\n').length, text: m[2], template: m[1] === '`' });
        }
    }
    return out;
}
const LITS = literals();
const prefixRe = new RegExp(`^(?:${STYLED_PREFIXES.map(p => p.replace(/-/g, '\\-')).join('|')})-[\\w-]*\\w$`);

describe('CSS class coverage (static — jsdom cannot see App.css)', () => {
    it('sanity: the scanner sees App.css rules and the source files', () => {
        expect(DEFINED.size).toBeGreaterThan(500);
        expect(DEFINED.has('wb2-card')).toBe(true);
        expect(FILES.length).toBeGreaterThan(50);
        expect(LITS.length).toBeGreaterThan(1000);
    });

    it('every styled-prefix class used in non-test source has a CSS rule (or is explicitly allow-listed)', () => {
        const missing: string[] = [];
        for (const lit of LITS) {
            const body = lit.template ? lit.text.replace(/\$\{[^}]*\}/g, ' \u0000 ') : lit.text;
            // a token glued to `${` is a dynamic prefix — checked by the next test
            for (const tok of body.split(/\s+/)) {
                if (!tok || tok.includes('\u0000') || !prefixRe.test(tok)) continue;
                if (DEFINED.has(tok) || ALLOW_UNSTYLED.has(tok)) continue;
                missing.push(`${tok}  (${lit.file}:${lit.line})`);
            }
        }
        expect([...new Set(missing)]).toEqual([]);
    });

    it('allow-listed unstyled classes are still in use (stale allow-list entries must be removed)', () => {
        const all = FILES.map(f => f.code).join('\n');
        const stale = [...ALLOW_UNSTYLED].filter(c => !all.includes(c) && !Object.keys(DYNAMIC_ENUMS).some(p => c.startsWith(p)));
        expect(stale).toEqual([]);
    });

    it('every dynamically composed class prefix (`prefix-${x}` in a class string) has a CSS family', () => {
        const orphanPrefixes: string[] = [];
        for (const lit of LITS) {
            if (!lit.template) continue;
            for (const m of lit.text.matchAll(/(?:^|\s)([a-z][\w-]*-)\$\{/g)) {
                const p = m[1];
                if (!prefixRe.test(p + 'x')) continue; // only styled families
                if (![...DEFINED].some(c => c.startsWith(p))) orphanPrefixes.push(`${p}\${…}  (${lit.file}:${lit.line})`);
            }
        }
        expect(orphanPrefixes).toEqual([]);
    });

    it('every value of the finite enums the UI composes classes from is styled', () => {
        const unstyled: string[] = [];
        for (const [prefix, values] of Object.entries(DYNAMIC_ENUMS)) {
            for (const v of values) if (!DEFINED.has(prefix + v)) unstyled.push(prefix + v);
        }
        expect(unstyled).toEqual([]);
        // and each enum prefix is really still composed somewhere (otherwise drop it from the map)
        const all = FILES.map(f => f.code).join('\n');
        // gutter-* is produced by split.js
        const builtElsewhere = new Set(['gutter-']);
        const unused = Object.keys(DYNAMIC_ENUMS).filter(p => !builtElsewhere.has(p) && !all.includes(`${p}\${`));
        expect(unused).toEqual([]);
    });

    it('classes deleted in health score phase 4 (4622c84) are referenced nowhere in source', () => {
        const hits: string[] = [];
        for (const c of DELETED_IN_PHASE4) {
            const re = new RegExp(`(?<![\\w-])${c.replace(/-/g, '\\-')}(?![\\w-])`);
            for (const { rel, code } of FILES) if (re.test(code)) hits.push(`${c} (${rel})`);
            if (DEFINED.has(c)) hits.push(`${c} (re-added to App.css — fine only if a component uses it again)`);
        }
        expect(hits).toEqual([]);
    });

    it('every CSS animation names a defined @keyframes (the phase-4 sweep removed pm-progress-indeterminate)', () => {
        const keyframes = new Set([...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]));
        const KEYWORDS = /^(ease|linear|infinite|forwards|backwards|both|alternate|alternate-reverse|none|ease-in|ease-out|ease-in-out|normal|reverse|paused|running|step-start|step-end|initial|inherit)$/;
        const missing: string[] = [];
        for (const m of CSS.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
            for (const t of m[1].split(/[\s,]+/)) {
                if (/^[a-zA-Z][\w-]*$/.test(t) && !KEYWORDS.test(t) && !keyframes.has(t)) missing.push(t);
            }
        }
        expect(missing).toEqual([]);
    });

    it('every var(--x) in App.css without a fallback names a defined custom property', () => {
        const defs = new Set([...CSS.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
        const missing = [...CSS.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map(m => m[1]).filter(v => !defs.has(v));
        expect([...new Set(missing)]).toEqual([]);
    });

    // Layout rules no component test can see (jsdom lays nothing out).
    it('Health score page: ONE column — every card (the ruler, both time charts) is as wide as the board', () => {
        expect(CSS).toMatch(/\.hs-board \{ grid-template-columns: minmax\(0, 1fr\); \}/);
        // the two-column layout and the set-point table are gone, rules and all
        expect(CSS).not.toMatch(/\.hs-spp|\.hs-setwrap|\.wb2-hs\b|\.hsx-/);
        const all = FILES.map(f => f.code).join('\n');
        expect(all).not.toMatch(/\bhsx-|\bhs-spp\b|\bhs-setwrap\b|\bwb2-hs\b/);
    });

    it('Health score chart card: ONE card of two stacked charts — 560 px, 700 px with the Clusters scatter on top; the old one-chart sizes and the lock box are gone', () => {
        expect(CSS).toMatch(/\.wb2-card--stack \.wb2-cv \{ height: 560px; \}/);
        expect(CSS).toMatch(/\.wb2-card--stackxy \.wb2-cv \{ height: 700px; \}/);
        for (const c of ['wb3-stack-in', 'wb3-stack-in--xy', 'wb3-stack-top', 'wb3-stack-bot', 'wb3-stack-bot--lock', 'wb3-stack-locktext']) expect(DEFINED.has(c), c).toBe(true);
        // the two halves share the card's height (the upper one gets more; more still for the scatter)
        expect(CSS).toMatch(/\.wb3-stack-top \{ flex: 1 1 58%; min-height: 0; \}/);
        expect(CSS).toMatch(/\.wb3-stack-bot \{[^}]*flex: 1 1 42%;[^}]*border-top: 1px dashed var\(--border-strong\);/);
        expect(CSS).toMatch(/\.wb3-stack-in--xy \.wb3-stack-top \{ flex-basis: 64%; \}/);
        expect(CSS).toMatch(/\.wb3-stack-in--xy \.wb3-stack-bot \{ flex-basis: 36%; \}/);
        expect(CSS).not.toMatch(/\.wb2-card--hs|\.hs-lockbig/);
        const all = FILES.map(f => f.code).join('\n');
        expect(all).not.toMatch(/\bhs-lockbig\b|size="hs"|narrowScopes|fmtNumCol/);
    });

    it('Health score KPI strip: one row that scrolls sideways; the share bar and its key are styled; the old shares card rules are gone', () => {
        for (const c of ['wb3-kpis--scroll', 'wb3-sharebar', 'wb3-sharekey']) expect(DEFINED.has(c), c).toBe(true);
        expect(CSS).toMatch(/\.wb3-kpis--scroll \{ display: flex; overflow-x: auto;/);
        expect(CSS).toMatch(/\.wb3-kpis--scroll \.wb3-kpi \{ flex: 1 0 176px; \}/);
        // each band grows by its share (inline flex-grow); a band that has hours never vanishes
        expect(CSS).toMatch(/\.wb3-sharebar i \{[^}]*flex: 0 0 0;[^}]*min-width: 2px;/);
        expect(CSS).not.toMatch(/\.hs-shares|\.hs-share\b|\.hs-share-bar|\.hs-share-v|\.hs-sharecard|\.hs-good|\.hs-bad\b/);
        const all = FILES.map(f => f.code).join('\n');
        expect(all).not.toMatch(/\bhs-shares?\b|\bhs-share-(l|bar|v)\b|\bhs-sharecard\b|\bhs-good\b|\bhs-bad\b/);
    });

    it('score ruler: every tick / name state the ruler can render is styled, the band is capped, and a ruler input keeps a focus outline in every state', () => {
        for (const c of [
            'wb3-ruler-tick--user', 'wb3-ruler-tick--bad', 'wb3-ruler-tick--req', 'wb3-ruler-tick--unk',
            'wb3-ruler-nm--user', 'wb3-ruler-nm--bad', 'wb3-ruler-nm--req', 'wb3-ruler-v--user', 'wb3-ruler-v--bad', 'wb3-ruler-v--req',
            'wb3-ruler-mark', 'wb3-ruler-mark--left', 'wb3-ruler-mark--right', 'wb3-ruler-stem', 'wb3-ruler-marks',
            'wb3-ruler-checks', 'wb3-ruler-note', 'wb3-rulercard', 'hs-num--big',
        ]) expect(DEFINED.has(c), c).toBe(true);
        // the band is capped at about 1,100 px
        expect(CSS).toMatch(/\.wb3-ruler \{[^}]*width: min\(100% - 156px, 1100px\)/);
        // rejected = red, empty = dashed amber, not checked = dashed grey (never a score colour)
        expect(CSS).toMatch(/\.wb3-ruler-tick--bad \{ background: var\(--danger\); \}/);
        expect(CSS).toMatch(/\.wb3-ruler-tick--req \{[^}]*border-left: 3px dashed var\(--warn\)/);
        expect(CSS).toMatch(/\.wb3-ruler-tick--unk \{[^}]*border-left: 3px dashed var\(--text-secondary\)/);
        // focus: an outline on the box itself, on top of whatever border its state gives it
        expect(CSS).toMatch(/\.hs-num--big:focus-within \{ outline: 2px solid var\(--accent-color\); outline-offset: 1px; \}/);
        // Relation model, narrow pane: the four inputs get their own labelled row under the band
        expect(CSS).toMatch(/@container \(max-width: 900px\) \{[\s\S]*?\.wb3-ruler--relationship \.wb3-ruler-values \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
        expect(CSS).toMatch(/\.wb3-ruler--relationship \.wb3-ruler-vl \{ display: block; \}/);
    });
});
