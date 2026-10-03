// @vitest-environment node
/**
 * CSS class coverage guard (qa-agent, 2026-10-04 final sweep).
 *
 * jsdom never loads `src/App.css`, so no component test can notice that a
 * class the UI still renders has lost its CSS rule. Health score phase 4
 * (commit 4622c84) deleted ~125 rules from App.css as "unreferenced"; this
 * file is the static guard that keeps a future deletion (or a typo in a new
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
 *  3. The classes deleted in 4622c84 are referenced nowhere in source.
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
    'bmw', 'wb2', 'hs', 'rcc', 'rcm', 'rcs', 'rcx', 'fg', 'pm', 'f4',
    'sensor-picker', 'predictor-picker', 'sensor-autocomplete',
    'kind-badge', 'model-kind-icon', 'model-status-pill', 'pair-regl', 'scatter-regl',
    'special-sensor', 'highlights', 'timebar', 'line-chart',
];

/**
 * Known class tokens that are rendered but intentionally have no rule of their
 * own (structural hooks / default look of a modifier family). Adding to this
 * list should be a conscious decision — say why.
 */
const ALLOW_UNSTYLED = new Set<string>([
    'fg-panel-widget',                 // FailureGroupsPanel root; layout is inline style, never had a rule
    'hs-share-l',                      // label cell of `.hs-share` (3-col grid styles it positionally)
    'sensor-autocomplete-item--none',  // "None" row reuses `.sensor-autocomplete-item` look
    'scatter-regl-axes',               // inline-styled SVG overlay (ScatterChart)
    'scatter-regl-canvas-wrap',        // inline-styled wrapper (ScatterChart)
    'wb2-card--normal',                // default ChartCard size = the base `.wb2-card` look
    'wb2-stp--todo',                   // default step look = the base `.wb2-stp` look
]);

/** Dynamic suffix families: prefix -> every value the code can produce. */
const DYNAMIC_ENUMS: Record<string, readonly string[]> = {
    'fg-group-color-': ['slate', 'amber', 'violet', 'green', 'blue'],          // Dashboard getFgGroupColor
    'fg-sheet-cell--': ['individual', 'relationship', 'clustering'],
    'kind-badge--': ['individual', 'relationship', 'clustering'],
    'model-kind-icon--': ['individual', 'relationship', 'clustering'],
    'model-status-pill--': ['complete', 'trained', 'incomplete'],               // BuildModelWindow pillState
    'f4-kb-dot--': ['trained', 'complete', 'need', 'bad'],                       // dotStatusFor + DOT_CLASS
    'f4-crow--': ['bad', 'ovl'],                                                 // TimePeriodsEditor rowClass
    'f4-cmsg--': ['bad', 'ovl'],                                                 // TimePeriodsEditor message(…, 'cmsg')
    'wb2-card--': ['tall', 'xtall', 'hs'],                                       // ChartCardSize minus 'normal'
    'wb2-stp--': ['done', 'now', 'bad', 'cur'],                                  // StepLook minus 'todo'
    'hs-chk--': ['ok', 'need', 'bad'],
    'hs-sc--': ['ok', 'warn', 'danger'],
    'gutter-': ['horizontal', 'vertical'],                                       // split.js
};

/** Deleted in 4622c84 (health score phase 4) — must not come back as references. */
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
const NON_CLASS_CONTEXT = /(data-[\w-]+|testid|testId|key|id|htmlFor|name|aria-[\w-]+|role|type|label|title|placeholder)\s*[=:]\s*\{?\s*$|(getByTestId|queryByTestId|emit|emitTo|listen|once|subscribe|invoke|reportError)\s*(<[^()]*>)?\(\s*$/;

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
        // gutter-* is produced by split.js; f4-cmsg--* is built as `f4-${cls}--bad` with cls = 'cmsg'
        const builtElsewhere = new Set(['gutter-', 'f4-cmsg--']);
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
});
