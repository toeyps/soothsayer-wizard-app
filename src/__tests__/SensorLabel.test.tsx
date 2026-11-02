import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import {
    SensorInline, SensorLabel, SensorMetaProvider, SensorSearchContext, SensorSetExtraContext, SensorSetProvider, SetPrefixLine,
} from '../components/sensor/SensorLabel';
import {
    axisRowHtml, buildSensorLookup, fmtNum, fmtNumExact, fmtNumText, plainRowHtml, plainSensorLookup, sameNameLoosely,
    sensorHaystack, sensorInlineHtml, sensorPlainLabel, sensorTitle, sharedPrefixHtml, ttRowClass, useSensorLookup,
} from '../components/sensor/sensorInfo';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';
import type { SensorMetadata } from '../types';

afterEach(cleanup);

/** jsdom never loads App.css, so the tooltip layout rules are checked as text. */
const appCss = (readFileSync('src/App.css', 'utf8') as string).replace(/\r\n/g, '\n');

const meta = (tag: string, description = '', unit = '', component = ''): SensorMetadata => ({ tag, description, unit, component });
const META = [
    meta('TT101.PV', 'Bearing temperature DE', 'DEGC', 'Gas turbine'),
    meta('PT200', '', 'BAR', 'Compressor'),
    meta('SAME', 'same'), // description only repeats the tag
];

describe('sensor lookup', () => {
    it('resolves description, unit and component by tag, case-insensitively and trimmed', () => {
        const look = buildSensorLookup(null, META);
        expect(look(' tt101.pv ')).toEqual({ tag: ' tt101.pv ', description: 'Bearing temperature DE', unit: 'DEGC', component: 'Gas turbine', special: undefined });
    });

    it('has no description when the file has none, or when it only repeats the tag (never the tag twice)', () => {
        const look = buildSensorLookup(null, META);
        expect(look('PT200').description).toBeUndefined();
        expect(look('SAME').description).toBeUndefined();
    });

    it('a tag missing from the metadata is just the tag', () => {
        expect(buildSensorLookup(null, META)('NOPE')).toEqual({ tag: 'NOPE' });
        expect(plainSensorLookup('X')).toEqual({ tag: 'X' });
    });

    it('caches: the same tag returns the same object (cheap in render loops)', () => {
        const look = buildSensorLookup(null, META);
        expect(look('TT101.PV')).toBe(look('TT101.PV'));
    });

    it('layers on a parent: own metadata wins per tag, special-sensor badges are inherited', () => {
        const parent = buildSensorLookup(null, [meta('A', 'Parent A'), meta('B', 'Parent B')], [{ tag: 'A', kind: 'formula' }, { tag: 'B', kind: 'operation' }]);
        const child = buildSensorLookup(parent, [meta('A', 'Child A')]);
        expect(child('A')).toMatchObject({ description: 'Child A', special: 'f' });
        expect(child('B')).toMatchObject({ description: 'Parent B', special: 's' });
    });

    it('title / search text / plain label follow the standard order', () => {
        const i = buildSensorLookup(null, META)('TT101.PV');
        expect(sensorTitle(i)).toBe('Bearing temperature DE · TT101.PV · DEGC · Gas turbine');
        expect(sensorHaystack(i)).toContain('bearing temperature de');
        expect(sensorHaystack(i)).toContain('degc');
        expect(sensorHaystack(i)).toContain('gas turbine');
        expect(sensorPlainLabel(i)).toBe('Bearing temperature DE · TT101.PV');
        expect(sensorPlainLabel({ tag: 'PT200' })).toBe('PT200');
    });
});

describe('fmtNum — the one display number formatter', () => {
    it('en-US, thousands separators, up to 3 decimals; fixed3 always 3', () => {
        expect(fmtNum(12345.6789)).toBe('12,345.679');
        expect(fmtNum(4000)).toBe('4,000');
        expect(fmtNum(0.5, true)).toBe('0.500');
        expect(fmtNum(-1234.5, true)).toBe('-1,234.500');
    });
    it('missing / non-finite values read as an en dash', () => {
        expect(fmtNum(null)).toBe('–');
        expect(fmtNum(undefined)).toBe('–');
        expect(fmtNum(NaN)).toBe('–');
        expect(fmtNum(Infinity)).toBe('–');
    });
    it('fmtNumText formats numeric text and leaves anything else alone', () => {
        expect(fmtNumText('4000')).toBe('4,000');
        expect(fmtNumText('')).toBe('');
        expect(fmtNumText('abc')).toBe('abc');
        expect(fmtNumText('0x10')).toBe('0x10');
    });
    it('a computed value 0 < |v| < 0.001 never reads as 0: 3 significant digits', () => {
        expect(fmtNum(0.00012)).toBe('0.00012');
        expect(fmtNum(0.00012)).not.toBe('0');
        expect(fmtNum(-0.0004)).toBe('-0.0004');
        expect(fmtNum(0.000123456)).toBe('0.000123');
        expect(fmtNum(1.2e-7)).toBe('1.2e-7');
        expect(fmtNum(0.00012, true)).toBe('0.000120');
        // 0 itself and values ≥ 0.001 keep the usual rule.
        expect(fmtNum(0)).toBe('0');
        expect(fmtNum(0, true)).toBe('0.000');
        expect(fmtNum(0.0015)).toBe('0.002');
    });
    it('very large computed values: whole numbers from 1e9, scientific from 1e15', () => {
        expect(fmtNum(999_999_999.4567)).toBe('999,999,999.457');
        expect(fmtNum(12_345_678_901.234)).toBe('12,345,678,901');
        expect(fmtNum(12_345_678_901.234, true)).toBe('12,345,678,901');
        expect(fmtNum(-2e9)).toBe('-2,000,000,000');
        expect(fmtNum(1_234_567_890_123_456)).toBe('1.235e+15');
    });
    it('fmtNumText (a value the user TYPED) keeps every decimal typed — separators only, never rounded', () => {
        expect(fmtNumText('0.0005')).toBe('0.0005');
        expect(fmtNumText('0.0001')).toBe('0.0001');
        expect(fmtNumText('12345.6789')).toBe('12,345.6789');
        expect(fmtNumText('1.50')).toBe('1.50');
        expect(fmtNumText(' 4000.25 ')).toBe('4,000.25');
        expect(fmtNumText('-0.12345678')).toBe('-0.12345678');
        expect(fmtNumText('1e-4')).toBe('0.0001');
        expect(fmtNumText('.5')).toBe('0.5');
        // Can't be shown exactly → as typed.
        expect(fmtNumText('12345678901234567890')).toBe('12345678901234567890');
    });
    it('fmtNumExact (a typed value already parsed) keeps every decimal of its shortest form', () => {
        expect(fmtNumExact(0.0004)).toBe('0.0004');
        expect(fmtNumExact(12345.5)).toBe('12,345.5');
        expect(fmtNumExact(1e-7)).toBe('0.0000001');
        expect(fmtNumExact(1500)).toBe('1,500');
        expect(fmtNumExact(NaN)).toBe('–');
    });
});

describe('sensorInlineHtml (ECharts tooltip rows)', () => {
    it('description then tag, value in the series colour, everything escaped', () => {
        const html = sensorInlineHtml({ tag: 'T<1>', description: 'A & "B"', unit: 'C' }, '#3b82f6', '1,000 C');
        expect(html).toContain('<span class="tt-desc">A &amp; &quot;B&quot;</span><span class="tt-tag">T&lt;1&gt;</span>');
        expect(html).toContain('style="color:#3b82f6"');
        expect(html).toContain('>1,000 C</span>');
        expect(html.indexOf('tt-desc')).toBeLessThan(html.indexOf('tt-tag'));
    });
    it('no description → the tag alone in mono; an unsafe colour is dropped', () => {
        const html = sensorInlineHtml({ tag: 'PT200' }, 'red;background:url(x)', '5');
        expect(html).toContain('<span class="tt-desc tt-mono">PT200</span>');
        expect(html).not.toContain('tt-tag');
        expect(html).not.toContain('url(');
    });
});

describe('<SensorLabel> (Stacked)', () => {
    it('line 1 = description + unit chip, line 2 = tag; title carries every part', () => {
        const { container } = render(<SensorMetaProvider metadata={META}><SensorLabel tag="TT101.PV" /></SensorMetaProvider>);
        const sl = container.querySelector('.sl') as HTMLElement;
        expect(sl.querySelector('.sl-l1 .sl-desc')?.textContent).toBe('Bearing temperature DE');
        expect(sl.querySelector('.sl-l1 .unit-badge')?.textContent).toBe('DEGC');
        expect(sl.querySelector('.sl-l2 .sl-tag')?.textContent).toBe('TT101.PV');
        expect(sl.getAttribute('title')).toBe('Bearing temperature DE · TT101.PV · DEGC · Gas turbine');
    });

    it('no description: the tag takes line 1 in mono, there is no second line and no placeholder', () => {
        const { container } = render(<SensorMetaProvider metadata={META}><SensorLabel tag="PT200" /></SensorMetaProvider>);
        const sl = container.querySelector('.sl') as HTMLElement;
        expect(sl.classList.contains('sl--notag')).toBe(true);
        expect(sl.querySelector('.sl-desc')?.textContent).toBe('PT200');
        expect(sl.querySelector('.sl-l2')).toBeNull();
        expect(sl.textContent).toBe('PT200BAR');
        expect(sl.textContent).not.toMatch(/no description/i);
    });

    it('size / muted / unit=false / after', () => {
        const { container } = render(
            <SensorMetaProvider metadata={META}>
                <SensorLabel tag="TT101.PV" size="lg" muted unit={false} after={<span className="comp-chip">Gas turbine</span>} />
            </SensorMetaProvider>,
        );
        const sl = container.querySelector('.sl') as HTMLElement;
        expect(sl.classList.contains('sl--lg')).toBe(true);
        expect(sl.classList.contains('sl--muted')).toBe(true);
        expect(sl.querySelector('.unit-badge')).toBeNull();
        expect(sl.querySelector('.sl-l2 .comp-chip')?.textContent).toBe('Gas turbine');
    });

    it('an explicit info wins over the provider; the special-sensor badge shows before the description', () => {
        const { container } = render(
            <SensorMetaProvider metadata={META} special={[{ tag: 'TT101.PV', kind: 'formula' }]}>
                <SensorLabel tag="TT101.PV" />
                <SensorLabel tag="X" info={{ tag: 'X', description: 'Explicit', special: 's' }} />
            </SensorMetaProvider>,
        );
        const [a, b] = [...container.querySelectorAll('.sl')];
        expect(a.querySelector('.sl-fx')?.textContent).toBe('ƒ');
        expect(b.querySelector('.sl-fx')?.textContent).toBe('Σ');
        expect(b.querySelector('.sl-desc')?.textContent).toBe('Explicit');
    });

    it('without any provider it still renders the tag', () => {
        const { container } = render(<SensorLabel tag="LONE" />);
        expect(container.textContent).toBe('LONE');
    });
});

describe('<SensorInline>', () => {
    it('description then tag on one line, no brackets, no unit', () => {
        const { container } = render(<SensorMetaProvider metadata={META}><SensorInline tag="TT101.PV" /></SensorMetaProvider>);
        const wrap = container.querySelector('.sl-inline-wrap') as HTMLElement;
        expect(wrap.textContent).toBe('Bearing temperature DETT101.PV');
        expect(wrap.textContent).not.toMatch(/[()]/);
        expect(wrap.querySelector('.unit-badge')).toBeNull();
        const desc = wrap.querySelector('.sl-desc')!;
        const tag = wrap.querySelector('.sl-tag')!;
        expect(desc.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(wrap.getAttribute('title')).toBe('Bearing temperature DE · TT101.PV · DEGC · Gas turbine');
    });

    it('fit = the trigger / row context (the tag can hide under ~150 px via a container query)', () => {
        const { container } = render(<SensorInline tag="A" fit />);
        expect(container.querySelector('.sl-inline-wrap')?.classList.contains('sl-fit')).toBe(true);
    });

    it('no description: just the tag', () => {
        const { container } = render(<SensorMetaProvider metadata={META}><SensorInline tag="PT200" /></SensorMetaProvider>);
        expect(container.textContent).toBe('PT200');
        expect(container.querySelector('.sl-tag')).toBeNull();
    });
});

describe('useSensorLookup', () => {
    it('reads the nearest provider', () => {
        let seen = '';
        function Probe() { seen = useSensorLookup()('TT101.PV').description ?? ''; return null; }
        render(<SensorMetaProvider metadata={META}><Probe /></SensorMetaProvider>);
        expect(seen).toBe('Bearing temperature DE');
    });
});

describe('rule 3b: a tag that only re-spells the description', () => {
    it('sets tagHidden on a loose match, ignoring case, spaces and punctuation', () => {
        const look = buildSensorLookup(null, [meta('SegmentNo_1', 'Segment No 1'), meta('TT101', 'Bearing temperature')]);
        expect(look('SegmentNo_1').tagHidden).toBe(true);
        expect(look('TT101').tagHidden).toBeUndefined();
        expect(sameNameLoosely('SegmentNo 1', 'Segment No 1')).toBe(true);
    });

    it('is not printed on either label, and stays in the title and the search text', () => {
        const look = buildSensorLookup(null, [meta('SegmentNo_1', 'Segment No 1', 'mm')]);
        const { container, rerender } = render(<SensorLabel tag="SegmentNo_1" info={look('SegmentNo_1')} />);
        expect(container.querySelector('.sl-tag')).toBeNull();
        expect(container.querySelector('.sl-l2')).toBeNull();
        expect(container.querySelector('.sl')?.getAttribute('title')).toContain('SegmentNo_1');
        rerender(<SensorInline tag="SegmentNo_1" info={look('SegmentNo_1')} />);
        expect(container.querySelector('.sl-tag')).toBeNull();
        expect(sensorHaystack(look('SegmentNo_1'))).toContain('segmentno_1');
    });

    it('is not printed in a tooltip row either', () => {
        const html = sensorInlineHtml({ tag: 'SegmentNo_1', description: 'Segment No 1', tagHidden: true }, undefined, '5');
        expect(html).not.toContain('tt-tag');
        expect(html).toContain('title="Segment No 1 · SegmentNo_1"');
    });
});

describe('tooltip rows: the value can never overlap the name (user complaint no. 1)', () => {
    const CROSSHEAD = 'Crosshead (P-P Trend) - Vibration crosshead slide 11A - SegmentNo 1 - avg';
    const rule = (selector: string) => {
        const at = appCss.indexOf(`\n${selector} {`);
        expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
        return appCss.slice(at, appCss.indexOf('}', at));
    };

    it('CSS: an ECharts row is a grid with its own value column, the box stays within 440 px', () => {
        expect(rule('.tt-row')).toMatch(/display:\s*grid/);
        expect(rule('.tt-row')).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\)/);
        // Without this the value wraps to a second grid row under the swatch (seen in a real browser).
        expect(rule('.tt-row')).toMatch(/grid-auto-flow:\s*column/);
        expect(rule('.tt-row')).toMatch(/max-width:\s*418px/);
        expect(rule('.tt-val')).toMatch(/flex:\s*none/);
    });

    it('CSS: the root cause stays gone: the tag gives way first, the label clips, no fixed label width', () => {
        expect(rule('.tt-tag')).not.toMatch(/flex-shrink:\s*0/);
        expect(rule('.tt-tag')).toMatch(/flex:\s*0 1000 auto/);
        expect(rule('.tt-tag')).toMatch(/overflow:\s*hidden/);
        expect(rule('.tt-label')).toMatch(/overflow:\s*hidden/);
        expect(rule('.tt-label')).toMatch(/min-width:\s*0/);
        expect(rule('.tt-label')).not.toMatch(/max-width/);
    });

    it('CSS: React rows (scatter, pair plot) stay a flex row with a clipping label', () => {
        expect(appCss).toMatch(/\.scatter-regl-tooltip \.tt-row:not\(\.tt-row--wrap\) \{ display: flex; \}/);
        expect(appCss).toMatch(/\.tt-label \.sl-tag \{ flex: 0 1000 auto; min-width: 0; overflow: hidden;/);
    });

    it('markup: the value is a direct child of the row, never inside the label', () => {
        const box = document.createElement('div');
        box.innerHTML = sensorInlineHtml({ tag: 'ABC', description: CROSSHEAD }, '#3b82f6', '12.300 mm');
        const row = box.firstElementChild as HTMLElement;
        const val = row.querySelector('.tt-val') as HTMLElement;
        expect(val.parentElement).toBe(row);
        expect(row.querySelector('.tt-label .tt-val')).toBeNull();
        expect([...row.children].map(c => c.className)).toEqual(['tt-sw', 'tt-label', 'tt-val']);
    });

    it('a short row keeps the old markup exactly', () => {
        expect(sensorInlineHtml({ tag: 'TT101', description: 'Bearing temperature', unit: 'C' }, '#3b82f6', '1.000 C')).toBe(
            '<div class="tt-row" title="Bearing temperature · TT101 · C"><i class="tt-sw" style="background:#3b82f6"></i>'
            + '<span class="tt-label"><span class="tt-desc">Bearing temperature</span><span class="tt-tag">TT101</span></span>'
            + '<span class="tt-val" style="color:#3b82f6">1.000 C</span></div>',
        );
        expect(sensorInlineHtml({ tag: 'PT200' }, undefined, '5')).toBe(
            '<div class="tt-row" title="PT200"><span class="tt-label"><span class="tt-desc tt-mono">PT200</span></span><span class="tt-val">5</span></div>',
        );
    });

    it('a row past 418 px wraps its name, and a tag with no room left is dropped (the description wins)', () => {
        const html = sensorInlineHtml({ tag: 'Crosshead_11A_SegmentNo1_avg', description: CROSSHEAD }, undefined, '12.300 mm');
        expect(html).toContain('class="tt-row tt-row--wrap"');
        expect(html).toContain(`>${CROSSHEAD}</span>`);
        expect(html).not.toContain('tt-tag');
        expect(html).toContain(`title="${CROSSHEAD} · Crosshead_11A_SegmentNo1_avg"`);
    });

    it('a tag-only row (no master data) follows the same rules, in mono', () => {
        const html = sensorInlineHtml({ tag: CROSSHEAD }, undefined, '12.300 mm');
        expect(html).toContain('class="tt-row tt-row--wrap"');
        expect(html).toContain(`<span class="tt-desc tt-mono">${CROSSHEAD}</span>`);
    });

    it('under a shared start the row prints the rest, for a tag-only row too; the title keeps the full name', () => {
        const prefix = 'Crosshead (P-P Trend) - Vibration crosshead slide 11A';
        const html = sensorInlineHtml({ tag: CROSSHEAD }, undefined, '5', prefix);
        expect(html).toContain('>SegmentNo 1 - avg</span>');
        expect(html).toContain(`title="${CROSSHEAD}"`);
        expect(html).toContain('class="tt-row"');
    });

    it('sharedPrefixHtml prints the start once, escaped; nothing when there is none', () => {
        expect(sharedPrefixHtml('')).toBe('');
        expect(sharedPrefixHtml('A & B')).toContain('A &amp; B …');
        expect(sharedPrefixHtml('A')).toContain('class="tt-prefix"');
    });

    it('axisRowHtml puts the key in the swatch column; plainRowHtml lines up with it', () => {
        const box = document.createElement('div');
        box.innerHTML = axisRowHtml('X', { tag: 'TT101', description: 'Bearing' }, '5') + plainRowHtml('Health score', '90');
        const [axis, plain] = [...box.children];
        expect([...axis.children].map(c => c.className)).toEqual(['tt-key', 'tt-label', 'tt-val']);
        expect(axis.querySelector('.tt-key')?.textContent).toBe('X');
        expect([...plain.children].map(c => c.className)).toEqual(['tt-key', 'tt-label', 'tt-val']);
        expect(plain.querySelector('.tt-desc')?.textContent).toBe('Health score');
    });

    it('ttRowClass gives a React row the same answer', () => {
        expect(ttRowClass({ tag: 'A', description: 'Short' }, '1')).toBe('tt-row');
        expect(ttRowClass({ tag: 'A', description: CROSSHEAD }, '1')).toBe('tt-row tt-row--wrap');
    });
});

describe('long names on labels (measured; a name that fits is untouched)', () => {
    const name = (n: string, seg = '1') => `Crosshead (P-P Trend) - Vibration crosshead slide ${n} - Segment No ${seg} - avg`;
    type Geometry = { clientWidth?: number; scrollWidth?: number };
    let geometry: (el: Element) => Geometry;

    beforeEach(() => {
        geometry = () => ({});
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        for (const key of ['clientWidth', 'scrollWidth'] as const) {
            vi.spyOn(Element.prototype, key, 'get').mockImplementation(function (this: Element) { return geometry(this)[key] ?? 0; });
        }
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });
    /** Every name too narrow for its text; its parent gives it the same room. */
    const narrow = (room: number) => {
        geometry = el => (el.matches('.sl-desc, .sl-tag')
            ? { clientWidth: room, scrollWidth: (el.textContent ?? '').length * 6 }
            : { clientWidth: room });
    };
    const parts = (root: ParentNode, part: string) => [...root.querySelectorAll(`[data-name-part="${part}"]`)].map(e => e.textContent);

    it('a short name, a long name that fits and a short tag all keep the old markup', () => {
        const { container, rerender } = render(<SensorInline tag="T" info={{ tag: 'T', description: 'Bearing temperature DE' }} />);
        expect(container.querySelector('.sl-inline')?.innerHTML).toBe('<span class="sl-desc">Bearing temperature DE</span><span class="sl-tag">T</span>');
        geometry = () => ({ clientWidth: 900, scrollWidth: 900 });
        rerender(<SensorInline tag="T" info={{ tag: 'T', description: name('11A') }} />);
        expect(container.querySelector('.sl-inline')?.innerHTML).toBe(`<span class="sl-desc">${name('11A')}</span><span class="sl-tag">T</span>`);
        rerender(<SensorLabel tag="T" info={{ tag: 'T', description: 'Bearing' }} />);
        expect(container.querySelector('.sl-l2')?.innerHTML).toBe('<span class="sl-tag">T</span>');
    });

    it('a name that does not fit is cut in the middle: the tail stays, the name reads the same', () => {
        narrow(200);
        const { container } = render(<SensorInline tag="T" info={{ tag: 'T', description: name('11A') }} />);
        const desc = container.querySelector('.sl-desc') as HTMLElement;
        expect(desc.className).toContain('sl-split');
        expect(parts(desc, 'tail')[0]?.trimStart()).toBe('Segment No 1 - avg');
        expect(desc.textContent).toBe(name('11A'));
    });

    it('with no separator it keeps whole trailing words; with no spaces at all it stays one text (end cut)', () => {
        narrow(100);
        const words = 'Very long name without any separator at all in this text';
        const { container, rerender } = render(<SensorInline tag="T" info={{ tag: 'T', description: words }} />);
        const tail = parts(container, 'tail')[0]?.trimStart() ?? '';
        expect(tail.length).toBeGreaterThan(0);
        expect(tail.length).toBeLessThanOrEqual(28);
        expect(words.endsWith(` ${tail}`)).toBe(true);
        const noSpaces = 'A_VERY_LONG_TAG_WITHOUT_ANY_SPACE_AT_ALL_IN_IT';
        rerender(<SensorInline tag={noSpaces} info={{ tag: noSpaces }} />);
        const desc = container.querySelector('.sl-desc') as HTMLElement;
        expect(desc.className).toBe('sl-desc');
        expect(desc.textContent).toBe(noSpaces);
    });

    it('rule 3: rows of a set stay distinct, and the set counts the card\'s own target', () => {
        narrow(200);
        const metas = [meta('A', name('11A')), meta('B', name('11B')), meta('Y', name('11C'))];
        const withTarget = (
            <SensorMetaProvider metadata={metas}>
                <SensorSetExtraContext.Provider value={['Y']}>
                    <SensorSetProvider tags={['A']} candidate="">
                        <SensorInline tag="A" />
                    </SensorSetProvider>
                </SensorSetExtraContext.Provider>
            </SensorMetaProvider>
        );
        const { container, unmount } = render(withTarget);
        expect(compactOf(container.querySelector('.sl-desc') as HTMLElement)).toContain('11A');
        unmount();
        const rows = render(
            <SensorMetaProvider metadata={metas}>
                <SensorSetProvider tags={['A', 'B']} candidate="">
                    <SensorInline tag="A" />
                    <SensorInline tag="B" />
                </SensorSetProvider>
            </SensorMetaProvider>,
        ).container;
        const visible = ([...rows.querySelectorAll('.sl-desc')] as HTMLElement[]).map(compactOf);
        expect(new Set(visible).size).toBe(2);
        expect(visible[0]).toContain('11A');
        expect(visible[1]).toContain('11B');
    });

    it('rule 2: no prefix line while nothing is cut; once a row is cut the start prints once and the rows drop it', () => {
        const metas = [meta('A', name('11A', '1')), meta('B', name('11A', '2'))];
        const ui = (
            <SensorMetaProvider metadata={metas}>
                <div>
                    <SensorSetProvider tags={['A', 'B']} drop>
                        <SetPrefixLine className="pk-chip-prefix" />
                        <SensorInline tag="A" />
                        <SensorInline tag="B" />
                    </SensorSetProvider>
                </div>
            </SensorMetaProvider>
        );
        geometry = () => ({ clientWidth: 900, scrollWidth: 900 });
        const first = render(ui);
        expect(screen.queryByTestId('set-prefix')).toBeNull();
        expect(first.container.querySelector('.sl-desc')?.textContent).toBe(name('11A', '1'));
        first.unmount();

        narrow(200);
        const { container } = render(ui);
        expect(screen.getAllByTestId('set-prefix')).toHaveLength(1);
        expect(screen.getByTestId('set-prefix').textContent).toContain('Crosshead (P-P Trend) - Vibration crosshead slide 11A');
        expect([...container.querySelectorAll('.sl-desc')].map(e => e.textContent)).toEqual(['Segment No 1 - avg', 'Segment No 2 - avg']);
    });

    it('rule 2 without drop: the shared start stays, muted, with the name\'s own separator', () => {
        narrow(200);
        const metas = [meta('A', name('11A', '1')), meta('B', name('11A', '2'))];
        const { container } = render(
            <SensorMetaProvider metadata={metas}>
                <div>
                    <SensorSetProvider tags={['A', 'B']}>
                        <SensorInline tag="A" />
                        <SensorInline tag="B" />
                    </SensorSetProvider>
                </div>
            </SensorMetaProvider>,
        );
        const desc = container.querySelector('.sl-desc') as HTMLElement;
        expect(desc.className).toContain('sl-split--shared');
        expect(parts(desc, 'head')[0]).toBe('Crosshead (P-P Trend) - Vibration crosshead slide 11A -');
        expect(desc.textContent).toBe(name('11A', '1'));
    });

    it('tag-only sensors (no master data) join sets like any other: their tags are their names', () => {
        narrow(200);
        const a = 'Crosshead Trend - Slide 11A - SegmentNo 1 - avg';
        const b = 'Crosshead Trend - Slide 11A - SegmentNo 2 - avg';
        const { container } = render(
            <div>
                <SensorSetProvider tags={[a, b]} drop>
                    <SetPrefixLine className="pk-chip-prefix" />
                    <SensorInline tag={a} />
                    <SensorInline tag={b} />
                </SensorSetProvider>
            </div>,
        );
        expect(screen.getByTestId('set-prefix').textContent).toContain('Crosshead Trend - Slide 11A');
        expect([...container.querySelectorAll('.sl-desc')].map(e => e.textContent)).toEqual(['SegmentNo 1 - avg', 'SegmentNo 2 - avg']);
        expect(container.querySelector('.sl-inline')?.className).toContain('sl--notag');
        expect(container.querySelector('.sl-tag')).toBeNull();
    });

    it('a cut name goes back to plain text once there is room again', () => {
        let room = 200;
        geometry = el => (el.matches('.sl-desc')
            ? { clientWidth: room, scrollWidth: 450 }
            : { clientWidth: room });
        const { container, rerender } = render(<SensorInline tag="T" info={{ tag: 'T', description: name('11A') }} />);
        expect(container.querySelector('.sl-split')).not.toBeNull();
        room = 500;
        rerender(<SensorInline tag="T" info={{ tag: 'T', description: name('11A') }} />);
        expect(container.querySelector('.sl-split')).toBeNull();
        expect(container.querySelector('.sl-desc')?.textContent).toBe(name('11A'));
    });

    it('a long tag beside a description may be cut; a short tag can never shrink', () => {
        const long = 'A_LONG_TAG_THAT_IS_MORE_THAN_28_CHARACTERS';
        const { container, rerender } = render(<SensorInline tag={long} info={{ tag: long, description: 'Bearing' }} />);
        expect(container.querySelector('.sl-tag')?.className).toBe('sl-tag sl-tag--long');
        rerender(<SensorInline tag="T1" info={{ tag: 'T1', description: 'Bearing' }} />);
        expect(container.querySelector('.sl-tag')?.className).toBe('sl-tag');
    });

    it('the search marks matches', () => {
        const { container } = render(
            <SensorSearchContext.Provider value="temp">
                <SensorInline tag="T" info={{ tag: 'T', description: 'Bearing temperature' }} />
            </SensorSearchContext.Provider>,
        );
        expect(container.querySelector('mark.sl-hit')?.textContent).toBe('temp');
    });
});

/** What a split row shows when its head is cut: pre + "…" + tail. */
function compactOf(el: HTMLElement): string {
    const pick = (p: string) => el.querySelector(`[data-name-part="${p}"]`)?.textContent ?? '';
    return `${pick('pre')} … ${pick('tail').trimStart()}`;
}
