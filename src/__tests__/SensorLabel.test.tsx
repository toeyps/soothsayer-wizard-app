import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SensorInline, SensorLabel, SensorMetaProvider } from '../components/sensor/SensorLabel';
import {
    buildSensorLookup, fmtNum, fmtNumExact, fmtNumText, plainSensorLookup, sensorHaystack, sensorInlineHtml,
    sensorPlainLabel, sensorTitle, useSensorLookup,
} from '../components/sensor/sensorInfo';
import type { SensorMetadata } from '../types';

// Customer item 3 (SPEC FINAL 2026-10-09 §1, DESIGN_SYSTEM §4 "Sensor label — ONE standard").

afterEach(cleanup);

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
