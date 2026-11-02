import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PairSub } from '../components/windows/workbench/PairSub';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { longName, restoreNames, stubNamesCut } from './helpers/nameGeometry';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';

afterEach(() => { restoreNames(); cleanup(); });

const show = (metadata: { tag: string; description?: string }[], note?: string) => render(
    <SensorMetaProvider metadata={metadata.map(m => ({ unit: '', component: '', description: '', ...m }))}>
        <PairSub x={metadata[0].tag} y={metadata[1].tag} note={note} />
    </SensorMetaProvider>,
);

describe('PairSub: the "X vs Y" subtitle of a Clusters card', () => {
    it('two short names print as they always did: label, vs, label, nothing else', () => {
        show([{ tag: 'TE1', description: 'Bearing temperature' }, { tag: 'PT2', description: 'Oil pressure' }], '· 1-hour averages');
        const sub = screen.getByTestId('pair-sub');
        expect(sub.className).toBe('wb2-sub-sl');
        expect(sub.textContent).toBe('Bearing temperatureTE1 vs Oil pressurePT2 · 1-hour averages');
        expect(sub.querySelector('.wb2-pair-prefix')).toBeNull();
        expect(sub.querySelector('[data-name-part]')).toBeNull();
    });

    it('long names that fit print whole, with no shared line', () => {
        show([{ tag: 'A', description: longName(1) }, { tag: 'B', description: longName(2) }]);
        const sub = screen.getByTestId('pair-sub');
        expect(sub.querySelector('.wb2-pair-prefix')).toBeNull();
        expect(sub.textContent).toContain(longName(1));
        expect(sub.textContent).toContain(longName(2));
    });

    it('cut: the start they share once, muted, and each name keeps the part that tells it from the other', () => {
        stubNamesCut();
        show([{ tag: 'A', description: longName(1) }, { tag: 'B', description: longName(2) }]);
        const sub = screen.getByTestId('pair-sub');
        expect(sub.querySelectorAll('.wb2-pair-prefix')).toHaveLength(1);
        expect(sub.querySelector('.wb2-pair-prefix')!.textContent).toBe('Crosshead (P-P Trend) - Vibration crosshead slide 11A -');
        const names = [...sub.querySelectorAll('.sl-desc')].map(e => e.textContent);
        expect(names[0]).toBe('SegmentNo 1 - avg');
        expect(names[1]).toBe('SegmentNo 2 - avg');
    });

    it('tag-only sensors follow the same rule', () => {
        stubNamesCut();
        show([{ tag: longName(1) }, { tag: longName(2) }]);
        const sub = screen.getByTestId('pair-sub');
        expect(sub.querySelector('.wb2-pair-prefix')).toBeTruthy();
        expect([...sub.querySelectorAll('.sl-desc')].map(e => e.textContent)).toEqual(['SegmentNo 1 - avg', 'SegmentNo 2 - avg']);
    });
});

describe('the stylesheet behind a shortened name', () => {
    it('a head dropped from a name stays in the flow, so a name in a shrink-to-fit row cannot change its own room and flip between forms', () => {
        const css = readFileSync('src/App.css', 'utf8') as string;
        const rule = /\.sl-split\[data-short\] > \[data-name-part="head"\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
        expect(rule).toContain('visibility: hidden');
        expect(rule).toContain('order: 1');
        expect(rule).not.toContain('display: none');
    });

    it('a chip clips what sticks out, so a tag can never run over the next chip or "Add…"', () => {
        const css = readFileSync('src/App.css', 'utf8') as string;
        expect(css).toMatch(/\.pk-chip \.sl-inline-wrap \{[^}]*overflow: hidden/);
        expect(css).toMatch(/\.fx-chip \.sl-inline-wrap \{[^}]*overflow: hidden/);
    });
});
