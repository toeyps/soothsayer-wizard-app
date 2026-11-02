import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import { PairSub } from '../components/windows/workbench/PairSub';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { longName, restoreNames, stubNamesCut, stubNamesFit } from './helpers/nameGeometry';
import { captureResizeObservers } from './helpers/windowedLines';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';

afterEach(() => { restoreNames(); cleanup(); vi.unstubAllGlobals(); });

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

    it('long names measured as fitting print whole too (the fit branch, not "not rendered")', () => {
        stubNamesFit();
        show([{ tag: 'A', description: longName(1) }, { tag: 'B', description: longName(2) }]);
        const sub = screen.getByTestId('pair-sub');
        expect(sub.querySelectorAll('[data-name-run]')).toHaveLength(2);
        expect(sub.querySelector('.wb2-pair-prefix')).toBeNull();
        expect(sub.querySelector('[data-name-part]')).toBeNull();
        expect(sub.textContent).toContain(longName(1));
    });

    it.each([[' - ', '-'], [' · ', '·'], [' / ', '/']])('the shared start ends in the names\' own separator ("%s")', (sep, mark) => {
        stubNamesCut();
        const name = (n: number) => ['Crosshead (P-P Trend)', 'Vibration crosshead slide 11A', `SegmentNo ${n}`, 'avg'].join(sep);
        show([{ tag: 'A', description: name(1) }, { tag: 'B', description: name(2) }]);
        const prefix = screen.getByTestId('pair-sub').querySelector('.wb2-pair-prefix')!;
        expect(prefix.textContent).toBe(`${['Crosshead (P-P Trend)', 'Vibration crosshead slide 11A'].join(sep)} ${mark}`);
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

describe('PairSub in a card header: widening brings the whole names back', () => {
    /** The subtitle shrinks with its content: only the card's header line (`.wb2-card-h`) reports the real room. */
    function stubRoom(room: () => number, fits: () => boolean) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get(this: HTMLElement) { return this.classList.contains('wb2-card-h') ? room() : 100; },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
            configurable: true,
            get() { return fits() ? 50 : 500; },
        });
    }

    it('the set is judged by the header line: shortened while narrow, whole again once there is room for the whole name', async () => {
        const observers = captureResizeObservers();
        let room = 400;
        stubRoom(() => room, () => room >= 1000);
        const metadata = [{ tag: 'A', description: longName(1) }, { tag: 'B', description: longName(2) }]
            .map(m => ({ unit: '', component: '', ...m }));
        render(
            <SensorMetaProvider metadata={metadata}>
                <div className="wb2-card-h"><span className="wb2-card-s"><PairSub x="A" y="B" /></span></div>
            </SensorMetaProvider>,
        );
        const sub = screen.getByTestId('pair-sub');
        expect(sub.querySelector('.wb2-pair-prefix')).toBeTruthy();
        expect(observers.watching(sub.closest('.wb2-card-h')!)).toBe(true);
        const settle = () => act(async () => { observers.fire(); await new Promise(r => requestAnimationFrame(r)); });

        // A little wider, still short of what the whole name needs: stays shortened.
        room = 600;
        await settle();
        expect(sub.querySelector('.wb2-pair-prefix')).toBeTruthy();

        room = 1000;
        await settle();
        expect(sub.querySelector('.wb2-pair-prefix')).toBeNull();
        expect(sub.textContent).toContain(longName(1));
        expect(sub.textContent).toContain(longName(2));
    });

    it('outside a card header the set falls back to its own width and still shortens', () => {
        stubNamesCut();
        show([{ tag: 'A', description: longName(1) }, { tag: 'B', description: longName(2) }]);
        expect(screen.getByTestId('pair-sub').querySelector('.wb2-pair-prefix')).toBeTruthy();
    });
});

describe('the stylesheet behind a shortened name', () => {
    it('a search mark adds no width, so a name that barely fits does not get cut while searching', () => {
        const css = readFileSync('src/App.css', 'utf8') as string;
        const rule = /\.sl-hit \{([^}]*)\}/.exec(css)?.[1] ?? '';
        expect(rule).toContain('background');
        expect(rule).not.toMatch(/padding|margin|border:/);
    });

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
