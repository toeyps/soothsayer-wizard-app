import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Kpi, KpiStrip } from '../components/windows/workbench/Kpi';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';

afterEach(cleanup);

// The KPI tiles of the Build Model Workbench ("Workbench detail pages v2", SPEC §5–§7).
describe('Kpi — one tile', () => {
    it('prints the label, the value, the unit after the value and the caption under it, in that order', () => {
        render(<Kpi label="Mean" value="61.2" unit="°C" sub="learned normal" testId="t" />);
        const el = screen.getByTestId('t');
        expect(el.className).toBe('wb3-kpi');
        expect([...el.children].map(c => c.className)).toEqual(['wb3-kpi-l', 'wb3-kpi-v', 'wb3-kpi-s']);
        expect(el.querySelector('.wb3-kpi-l')!.textContent).toBe('Mean');
        // the unit is a part of the value line, after the number
        const value = el.querySelector('.wb3-kpi-v')!;
        expect(value.firstChild!.textContent).toBe('61.2');
        expect(value.lastElementChild!.className).toBe('wb3-kpi-u');
        expect(value.lastElementChild!.textContent).toBe('°C');
        expect(el.querySelector('.wb3-kpi-s')!.textContent).toBe('learned normal');
    });

    it('with no unit and no caption it prints neither (no empty element left behind)', () => {
        render(<Kpi label="R²" value="0.912" testId="t" />);
        const el = screen.getByTestId('t');
        expect([...el.children].map(c => c.className)).toEqual(['wb3-kpi-l', 'wb3-kpi-v']);
        expect(el.querySelector('.wb3-kpi-u')).toBeNull();
        expect(el.querySelector('.wb3-kpi-v')!.textContent).toBe('0.912');
        // an empty unit string is "no unit" too
        cleanup();
        render(<Kpi label="Mean" value="5" unit="" testId="t" />);
        expect(screen.getByTestId('t').querySelector('.wb3-kpi-u')).toBeNull();
    });

    it('a tile is plain by default — it never judges; `tone` (a score value only) adds the band class', () => {
        render(<Kpi label="R²" value="0.1" testId="plain" />);
        expect(screen.getByTestId('plain').className).toBe('wb3-kpi');
        for (const tone of ['ok', 'warn', 'bad'] as const) {
            render(<Kpi label="Lowest score" value="34" tone={tone} testId={`tone-${tone}`} />);
            expect(screen.getByTestId(`tone-${tone}`).className).toBe(`wb3-kpi wb3-kpi--${tone}`);
        }
    });

    it('`small` is for a date, a word or a graphic instead of a number: the value line takes the small variant', () => {
        render(<Kpi label="When" value="2026/01/05 13:00" small testId="t" />);
        expect(screen.getByTestId('t').querySelector('.wb3-kpi-v')!.className).toBe('wb3-kpi-v wb3-kpi-v--sm');
    });

    it('label, value and caption may be nodes; children sit between the value and the caption', () => {
        render(
            <Kpi label={<span data-testid="lbl">Share</span>} value={<i data-testid="val">bar</i>} sub={<b data-testid="cap">key</b>} testId="t">
                <div data-testid="extra">extra</div>
            </Kpi>,
        );
        const el = screen.getByTestId('t');
        expect(el.querySelector('.wb3-kpi-l')!.contains(screen.getByTestId('lbl'))).toBe(true);
        expect(el.querySelector('.wb3-kpi-v')!.contains(screen.getByTestId('val'))).toBe(true);
        expect(el.querySelector('.wb3-kpi-s')!.contains(screen.getByTestId('cap'))).toBe(true);
        expect([...el.children].map(c => c.getAttribute('data-testid') ?? c.className)).toEqual(['wb3-kpi-l', 'wb3-kpi-v', 'extra', 'wb3-kpi-s']);
    });

    it('a number value is printed as it is (a count needs no formatting by the caller); zero is still printed', () => {
        render(<Kpi label="Clusters" value={0} testId="t" />);
        expect(screen.getByTestId('t').querySelector('.wb3-kpi-v')!.textContent).toBe('0');
    });

    it('`title` becomes the tile\'s tooltip; absent = no title attribute', () => {
        render(<Kpi label="Outside ±3SD" value="0.27%" title="Estimated from the distribution bins" testId="a" />);
        render(<Kpi label="Mean" value="5" testId="b" />);
        expect(screen.getByTestId('a').getAttribute('title')).toBe('Estimated from the distribution bins');
        expect(screen.getByTestId('b').hasAttribute('title')).toBe(false);
    });
});

describe('KpiStrip — the row of tiles', () => {
    it('holds its tiles in the order given', () => {
        render(
            <KpiStrip testId="strip">
                <Kpi label="A" value="1" testId="a" />
                <Kpi label="B" value="2" testId="b" />
            </KpiStrip>,
        );
        const strip = screen.getByTestId('strip');
        expect(strip.className).toBe('wb3-kpis');
        expect([...strip.children].map(c => c.getAttribute('data-testid'))).toEqual(['a', 'b']);
    });

    it('`fit` = the Model fit strip (three equal, capped tiles — the cap itself is CSS)', () => {
        render(<KpiStrip fit testId="strip"><Kpi label="A" value="1" /></KpiStrip>);
        expect(screen.getByTestId('strip').className).toBe('wb3-kpis wb3-kpis--fit');
    });

    it('`scroll` = the Health score strip (one row that scrolls sideways — CSS); `state` is printed as data-state', () => {
        render(<KpiStrip scroll state="locked" testId="strip"><Kpi label="A" value="1" /></KpiStrip>);
        const strip = screen.getByTestId('strip');
        expect(strip.className).toBe('wb3-kpis wb3-kpis--scroll');
        expect(strip.dataset.state).toBe('locked');
        cleanup();
        // without them: neither the class nor the attribute
        render(<KpiStrip testId="strip"><Kpi label="A" value="1" /></KpiStrip>);
        expect(screen.getByTestId('strip').className).toBe('wb3-kpis');
        expect(screen.getByTestId('strip').hasAttribute('data-state')).toBe(false);
    });
});

// jsdom never loads App.css: the layout rules the SPEC asks for are pinned on the stylesheet text.
describe('KPI tiles — the look the SPEC fixes (App.css)', () => {
    const css = (readFileSync('src/App.css', 'utf-8') as string).replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string): string => {
        const at = css.indexOf(`\n${selector} {`);
        expect(at, `a rule for "${selector}"`).toBeGreaterThan(-1);
        return css.slice(at, css.indexOf('}', at));
    };

    it('the Model fit strip is three equal tiles that share the whole board (real-app report 2026-10-16), like the Health score row', () => {
        expect(rule('.wb3-kpis')).toMatch(/grid-column: 1 \/ -1/);
        expect(rule('.wb3-kpis--fit')).toMatch(/grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
        // full width, like the Health score row: no cap, nothing pushed to the left
        expect(rule('.wb3-kpis--fit')).not.toMatch(/420px|justify-content/);
    });

    it('the number is mono 24; the caption and the unit use --text-secondary, never --text-faint', () => {
        expect(rule('.wb3-kpi-v')).toMatch(/font: 600 24px var\(--mono\)/);
        expect(rule('.wb3-kpi-s')).toMatch(/color: var\(--text-secondary\)/);
        expect(rule('.wb3-kpi-u')).toMatch(/color: var\(--text-secondary\)/);
        expect(rule('.wb3-kpi-l')).toMatch(/color: var\(--text-secondary\)/);
        for (const sel of ['.wb3-kpi', '.wb3-kpi-l', '.wb3-kpi-v', '.wb3-kpi-u', '.wb3-kpi-s']) expect(rule(sel)).not.toMatch(/--text-faint/);
    });

    it('a plain tile\'s value has the text colour; only the tone modifiers colour it (ok / warn / bad)', () => {
        expect(rule('.wb3-kpi-v')).toMatch(/color: var\(--text-primary\)/);
        expect(rule('.wb3-kpi--ok .wb3-kpi-v')).toMatch(/color: var\(--ok\)/);
        expect(rule('.wb3-kpi--warn .wb3-kpi-v')).toMatch(/color: var\(--warn\)/);
        expect(rule('.wb3-kpi--bad .wb3-kpi-v')).toMatch(/color: var\(--danger\)/);
    });

    it('Model fit, Individual: one column, and the value chart is taller (400 px) than a "tall" card elsewhere (330 px)', () => {
        expect(rule('.wb2-board--ind')).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
        expect(rule('.wb2-board--ind .wb2-card--tall .wb2-cv')).toMatch(/height: 400px/);
        expect(rule('.wb2-card--tall .wb2-cv')).toMatch(/height: 330px/);
    });
});
