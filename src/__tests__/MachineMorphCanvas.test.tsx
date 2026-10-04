import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import MachineMorphCanvas from '../components/upload/MachineMorphCanvas';
import {
  HOLD_SECONDS,
  LABEL_H,
  LABEL_W,
  MACHINE_NAMES,
  TRANSITION_SECONDS,
  advanceMorph,
  buildShapes,
  formatReading,
  initialHistory,
  isWatch,
  labelVisibility,
  makeCamera,
  morphPhase,
  nextReading,
  placeLabels,
  projectPoint,
  type SensorDef,
  type Vec3,
} from '../components/upload/machineShapes';

/** Small deterministic PRNG so shape tests are repeatable. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe('buildShapes', () => {
  const N = 300;
  const shapes = buildShapes(N, mulberry32(7));

  it('returns exactly the six machines, in order', () => {
    expect(shapes.map((s) => s.name)).toEqual([
      'Gas turbine generator',
      'Gas turbine compressor',
      'Motor',
      'Reciprocating pump',
      'Can pump',
      'Turbo expander',
    ]);
    expect([...MACHINE_NAMES]).toEqual(shapes.map((s) => s.name));
  });

  it('gives every machine the requested particle count with finite coordinates', () => {
    for (const sh of shapes) {
      expect(sh.count).toBe(N);
      expect(sh.pts.length).toBe(N * 4);
      for (let i = 0; i < sh.pts.length; i++) expect(Number.isFinite(sh.pts[i])).toBe(true);
    }
  });

  it('fits every machine into a +-2 box', () => {
    for (const sh of shapes) {
      for (let i = 0; i < sh.pts.length; i += 4) {
        for (let k = 0; k < 3; k++) expect(Math.abs(sh.pts[i + k])).toBeLessThanOrEqual(2.0001);
      }
    }
  });

  it('gives two sensors per machine, exactly one of them trending, with finite positions', () => {
    for (const sh of shapes) {
      expect(sh.sensors).toHaveLength(2);
      expect(sh.sensors.filter((s) => s.trend)).toHaveLength(1);
      for (const s of sh.sensors) {
        expect(s.p.every((v) => Number.isFinite(v))).toBe(true);
        expect(s.name.length).toBeGreaterThan(0);
      }
    }
  });

  it('only the reciprocating pump has moving plunger particles (group >= 10)', () => {
    for (const sh of shapes) {
      let moving = 0;
      for (let i = 3; i < sh.pts.length; i += 4) if (sh.pts[i] >= 10) moving++;
      if (sh.name === 'Reciprocating pump') expect(moving).toBeGreaterThan(0);
      else expect(moving).toBe(0);
    }
  });
});

describe('morph clock and phases', () => {
  it('holds, then dissolves, then rolls over to the next machine', () => {
    expect(morphPhase(1).m).toBe(0);
    expect(morphPhase(1).burst).toBe(0);
    const mid = morphPhase(HOLD_SECONDS + TRANSITION_SECONDS / 2);
    expect(mid.e).toBeCloseTo(0.5, 5);
    expect(mid.burst).toBeCloseTo(1, 5);
    expect(morphPhase(HOLD_SECONDS + TRANSITION_SECONDS).e).toBeCloseTo(1, 5);

    const clock = { idx: 5, t: HOLD_SECONDS + TRANSITION_SECONDS - 0.01 };
    advanceMorph(clock, 0.05, 6);
    expect(clock.idx).toBe(0); // wraps after the last machine
    expect(clock.t).toBeCloseTo(0.04, 5);
  });

  it('fades labels in after forming and out before dissolving', () => {
    expect(labelVisibility(0)).toBe(0);
    expect(labelVisibility(1)).toBe(1);
    expect(labelVisibility(HOLD_SECONDS - 0.1)).toBeLessThan(1);
    expect(labelVisibility(HOLD_SECONDS + 0.5)).toBe(0);
  });
});

describe('camera projection', () => {
  it('maps the origin to the camera centre', () => {
    const cam = makeCamera(-0.7, 0.32, 100, 50, 40);
    const out: Vec3 = [0, 0, 0];
    projectPoint(cam, 0, 0, 0, out);
    expect(out[0]).toBeCloseTo(100, 5);
    expect(out[1]).toBeCloseTo(50, 5);
  });
});

describe('simulated sensors', () => {
  const steady: SensorDef = { p: [0, 0, 0], name: 'T', unit: '°C', v: 80, s: 0.4 };
  const trending: SensorDef = { ...steady, trend: true };

  it('trending sensors drift up past the WATCH threshold, steady ones never do', () => {
    const rng = () => 0.5; // zero noise
    expect(isWatch(trending, nextReading(trending, 0, rng))).toBe(false);
    expect(isWatch(trending, nextReading(trending, 4.5, rng))).toBe(true);
    expect(isWatch(steady, nextReading(steady, 4.5, rng))).toBe(false);
  });

  it('history has a fixed length', () => {
    expect(initialHistory(steady)).toHaveLength(40);
  });

  it('formats readings by magnitude', () => {
    expect(formatReading(548.4, 548)).toBe('548');
    expect(formatReading(84.26, 84)).toBe('84.3');
    expect(formatReading(1.634, 1.6)).toBe('1.63');
  });
});

describe('placeLabels', () => {
  it('never lets two labels overlap, even when anchors coincide', () => {
    for (const anchors of [
      [{ x: 400, y: 300 }, { x: 400, y: 300 }],
      [{ x: 400, y: 300 }, { x: 430, y: 280 }],
      [{ x: 100, y: 120 }, { x: 110, y: 130 }],
    ]) {
      const [a, b] = placeLabels(anchors, 800, 700);
      const overlapX = a.x < b.x + LABEL_W && b.x < a.x + LABEL_W;
      const overlapY = a.y < b.y + LABEL_H && b.y < a.y + LABEL_H;
      expect(overlapX && overlapY).toBe(false);
    }
  });

  it('keeps labels inside the canvas', () => {
    for (const b of placeLabels([{ x: 5, y: 5 }, { x: 790, y: 690 }], 800, 700)) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(800);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(700);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

type Recorder = Record<string, ReturnType<typeof vi.fn>>;

/** Minimal recording 2D context: every method is a vi.fn, properties are plain assignments. */
function makeCtx(): { ctx: CanvasRenderingContext2D; rec: Recorder } {
  const rec: Recorder = {};
  const store: Record<string, unknown> = {};
  const ctx = new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (!rec[prop]) {
        rec[prop] =
          prop === 'measureText'
            ? vi.fn(() => ({ width: 24 }))
            : prop === 'createRadialGradient'
              ? vi.fn(() => ({ addColorStop: vi.fn() }))
              : vi.fn();
      }
      return rec[prop];
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, rec };
}

describe('MachineMorphCanvas', () => {
  let rec: Recorder;
  let ctx: CanvasRenderingContext2D | null;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextId: number;
  let rafSpy: ReturnType<typeof vi.spyOn>;
  let cancelSpy: ReturnType<typeof vi.spyOn>;
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

  const setReducedMotion = (matches: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  };

  beforeEach(() => {
    const made = makeCtx();
    rec = made.rec;
    ctx = made.ctx;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    rafCallbacks = new Map();
    nextId = 41;
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      nextId += 1;
      rafCallbacks.set(nextId, cb);
      return nextId;
    });
    cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id);
    });
    setReducedMotion(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  const runFrame = (ts: number) => {
    const [id, cb] = [...rafCallbacks.entries()].pop()!;
    rafCallbacks.delete(id);
    act(() => cb(ts));
  };

  it('labels the canvas for assistive tech', () => {
    render(<MachineMorphCanvas />);
    expect(
      screen.getByRole('img', { name: 'Animated illustration of industrial machines built from particles' }),
    ).toBeTruthy();
  });

  it('hero shows the machine name, the six progress dots and the simulated-readings note', () => {
    render(<MachineMorphCanvas />);
    expect(screen.getByText('Works with any machine that has sensors')).toBeTruthy();
    expect(screen.getByText('Gas turbine generator')).toBeTruthy();
    expect(screen.getByText('Illustration · simulated readings')).toBeTruthy();
    const dots = screen.getAllByTestId('machine-dot');
    expect(dots).toHaveLength(6);
    expect(dots.filter((d) => d.getAttribute('data-active') === 'true')).toHaveLength(1);
  });

  it('mini renders no labels or bottom bar and draws no text', () => {
    render(<MachineMorphCanvas variant="mini" />);
    expect(screen.queryByText('Works with any machine that has sensors')).toBeNull();
    expect(screen.queryByText('Illustration · simulated readings')).toBeNull();
    expect(screen.queryByText('Gas turbine generator')).toBeNull();
    expect(screen.queryAllByTestId('machine-dot')).toHaveLength(0);
    runFrame(performance.now() + 100);
    expect(rec.fillRect.mock.calls.length).toBeGreaterThan(0); // particles still drawn
    expect(rec.fillText).toBeUndefined(); // ...but no sensor callouts
  });

  it('hero animation draws particles and the sensor callouts on a frame', () => {
    render(<MachineMorphCanvas />);
    expect(rafSpy).toHaveBeenCalledTimes(1);
    runFrame(performance.now() + 100);
    expect(rec.fillRect.mock.calls.length).toBeGreaterThan(1000);
    const texts = rec.fillText.mock.calls.map((c) => c[0]);
    expect(texts).toContain('Exhaust gas temperature');
    expect(texts).toContain('Active power');
    expect(rafSpy).toHaveBeenCalledTimes(2); // loop keeps running
  });

  it('prefers-reduced-motion draws a single static frame and never schedules rAF', () => {
    setReducedMotion(true);
    render(<MachineMorphCanvas />);
    expect(rafSpy).not.toHaveBeenCalled();
    expect(rec.clearRect).toHaveBeenCalledTimes(1);
    expect(rec.fillRect.mock.calls.length).toBeGreaterThan(1000);
    // static frame still shows the first machine's sensor labels
    expect(rec.fillText.mock.calls.map((c) => c[0])).toContain('Exhaust gas temperature');
    expect(screen.getByText('Gas turbine generator')).toBeTruthy();
  });

  it('unmount cancels the pending animation frame', () => {
    const { unmount } = render(<MachineMorphCanvas />);
    runFrame(performance.now() + 50); // schedules a second frame
    const pending = [...rafCallbacks.keys()].pop()!;
    unmount();
    expect(cancelSpy).toHaveBeenCalledWith(pending);
    expect(rafCallbacks.size).toBe(0);
  });

  it('stops scheduling frames while the document is hidden and resumes when visible', () => {
    render(<MachineMorphCanvas />);
    expect(rafCallbacks.size).toBe(1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(rafCallbacks.size).toBe(0);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(rafCallbacks.size).toBe(1);
  });

  it('does not throw and animates nothing when the 2D context is unavailable', () => {
    ctx = null;
    expect(() => render(<MachineMorphCanvas />)).not.toThrow();
    expect(rafSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('survives matchMedia throwing (treated as motion allowed)', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('boom');
      },
    });
    expect(() => render(<MachineMorphCanvas />)).not.toThrow();
    expect(rafSpy).toHaveBeenCalled();
  });

  it('passes className and style through to the wrapper', () => {
    const { container } = render(<MachineMorphCanvas variant="mini" className="rail-art" style={{ opacity: 0.4 }} />);
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.className).toBe('rail-art');
    expect(wrap.style.opacity).toBe('0.4');
  });
});
