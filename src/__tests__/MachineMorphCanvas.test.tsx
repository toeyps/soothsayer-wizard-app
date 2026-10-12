import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import MachineMorphCanvas from '../components/upload/MachineMorphCanvas';
import {
  ABNORMAL_LABEL,
  DE,
  DS,
  HERO_PARTICLES,
  HOLD_SECONDS,
  LABEL_H,
  LABEL_PAD_R,
  LABEL_W,
  MACHINE_NAMES,
  MINI_PARTICLES,
  POINT_STRIDE,
  SPARK_W,
  SPARK_X,
  TAU,
  TRANSITION_SECONDS,
  advanceMorph,
  buildShapes,
  calloutFits,
  clearShapeCache,
  formatReading,
  getShapes,
  initialHistory,
  isAbnormal,
  labelVisibility,
  makeCamera,
  makeSampler,
  morphPhase,
  mulberry32,
  nextReading,
  placeLabels,
  projectPoint,
  rawShapeBuildCount,
  ringCount,
  segCount,
  setCamera,
  stillHistory,
  type SensorDef,
  type Vec3,
} from '../components/upload/machineShapes';
import { HOLD_STOP_BEFORE, RESUME_MS } from '../components/upload/machineOrbit';

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe('C6 sampler primitives', () => {
  const S = POINT_STRIDE;
  const pointsOf = (fill: (s: ReturnType<typeof makeSampler>) => void) => {
    const s = makeSampler(mulberry32(3));
    fill(s);
    return s.pts;
  };
  const count = (pts: number[]) => pts.length / S;
  const edges = (pts: number[]) => {
    let e = 0;
    for (let i = 4; i < pts.length; i += S) if (pts[i] === 1) e++;
    return e;
  };

  it('writes stride-8 points: x y z group edge nx ny nz', () => {
    expect(POINT_STRIDE).toBe(8);
    const pts = pointsOf((s) => s.ring('x', [0, 0, 0], 0.5, 2));
    expect(pts.length % 8).toBe(0);
    for (let i = 0; i < pts.length; i += S) {
      expect(pts[i + 3]).toBe(2); // group
      expect(pts[i + 4]).toBe(1); // edge dot
      expect([pts[i + 5], pts[i + 6], pts[i + 7]]).toEqual([0, 0, 0]); // edges carry no normal
      expect(Math.hypot(pts[i + 1], pts[i + 2])).toBeCloseTo(0.5, 5); // on the rim, around x
    }
  });

  it('ring and seg place DE dots per unit length (with a floor)', () => {
    expect(DE).toBe(150);
    expect(DS).toBe(46);
    expect(count(pointsOf((s) => s.ring('y', [0, 0, 0], 1)))).toBe(ringCount(1));
    expect(ringCount(1)).toBe(Math.round(TAU * 150));
    expect(ringCount(0.001)).toBe(8);
    expect(count(pointsOf((s) => s.seg([0, 0, 0], [2, 0, 0])))).toBe(segCount(2));
    expect(segCount(2)).toBe(300);
    expect(segCount(0.001)).toBe(4);
  });

  it('shell dots are sparse surface dots with unit normals perpendicular to the axis', () => {
    const pts = pointsOf((s) => s.shell('z', [0, 0, 0], 1, 2, 1));
    expect(count(pts)).toBe(Math.round(TAU * 1 * 2 * DS));
    expect(edges(pts)).toBe(0);
    for (let i = 0; i < pts.length; i += S) {
      expect(Math.hypot(pts[i + 5], pts[i + 6], pts[i + 7])).toBeCloseTo(1, 5);
      expect(pts[i + 7]).toBe(0); // no component along the z axis
    }
  });

  it('box = 12 bright edges + 6 sparse faces', () => {
    const sz: Vec3 = [1, 2, 3];
    const pts = pointsOf((s) => s.box([0, 0, 0], sz, 0, { k: 1, ek: 1 }));
    const edgeDots = 4 * (segCount(1) + segCount(2) + segCount(3));
    const faceDots = 2 * (Math.round(2 * 3 * DS) + Math.round(3 * 1 * DS) + Math.round(1 * 2 * DS));
    expect(edges(pts)).toBe(edgeDots);
    expect(count(pts)).toBe(edgeDots + faceDots);
  });

  it('bolt circles and flanges: one small ring per bolt, all edge dots', () => {
    const bolts = pointsOf((s) => s.bolts('x', [0, 0, 0], 0.5, 12, 0.05));
    expect(count(bolts)).toBe(12 * Math.max(7, Math.round(TAU * 0.05 * DE * 1.6)));
    expect(edges(bolts)).toBe(count(bolts));
    const flange = pointsOf((s) => s.flange('x', [0, 0, 0], 0.25, 1.02, 12));
    expect(count(flange)).toBeGreaterThan(count(bolts)); // disc + rims + bolts
  });

  it('cylinders: open by default, bands and seam lines add edge dots', () => {
    const plain = pointsOf((s) => s.cyl('x', [0, 0, 0], 0.5, 1));
    const rich = pointsOf((s) => s.cyl('x', [0, 0, 0], 0.5, 1, 0, { bands: 3, lines: 4 }));
    expect(edges(rich)).toBeGreaterThan(edges(plain));
    expect(count(plain)).toBe(Math.round(TAU * 0.5 * 1 * DS) + 2 * ringCount(0.5));
  });
});

describe('buildShapes (C6)', () => {
  const N = 600;
  const shapes = buildShapes(N, mulberry32(7));

  it('dot counts: 6,000 on the hero, 2,400 on the mini', () => {
    expect(HERO_PARTICLES).toBe(6000);
    expect(MINI_PARTICLES).toBe(2400);
  });

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

  it('gives every machine the requested particle count, stride 8, finite values', () => {
    for (const sh of shapes) {
      expect(sh.count).toBe(N);
      expect(sh.pts.length).toBe(N * 8);
      for (let i = 0; i < sh.pts.length; i++) expect(Number.isFinite(sh.pts[i])).toBe(true);
    }
  });

  it('richer geometry: every machine is sampled from far more raw dots than it shows', () => {
    for (const sh of shapes) expect(sh.rawCount).toBeGreaterThan(15000);
  });

  it('is edge-weighted: rims, seams, edges and bolt rings hold most of the dots', () => {
    for (const sh of shapes) {
      expect(sh.edgeRatio).toBeGreaterThan(0.8);
      let e = 0;
      for (let i = 4; i < sh.pts.length; i += 8) if (sh.pts[i] > 0.5) e++;
      expect(e / sh.count).toBeGreaterThan(0.75); // resampling keeps the weighting
    }
  });

  it('surface dots carry unit normals (rim light), edge dots carry none', () => {
    for (const sh of shapes) {
      for (let i = 0; i < sh.pts.length; i += 8) {
        const n = Math.hypot(sh.pts[i + 5], sh.pts[i + 6], sh.pts[i + 7]);
        if (sh.pts[i + 4] > 0.5) expect(n).toBe(0);
        else expect(n).toBeCloseTo(1, 4);
      }
    }
  });

  it('fits every machine into a +-2 box', () => {
    for (const sh of shapes) {
      for (let i = 0; i < sh.pts.length; i += 8) {
        for (let k = 0; k < 3; k++) expect(Math.abs(sh.pts[i + k])).toBeLessThanOrEqual(2.0001);
      }
    }
  });

  it('keeps every sensor anchor inside the +-2 box', () => {
    for (const sh of shapes) {
      for (const s of sh.sensors) for (const v of s.p) expect(Math.abs(v)).toBeLessThanOrEqual(2.0001);
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

  it('only the reciprocating pump has moving plunger particles (groups 10-12)', () => {
    for (const sh of shapes) {
      const groups = new Set<number>();
      for (let i = 3; i < sh.pts.length; i += 8) if (sh.pts[i] >= 10) groups.add(sh.pts[i]);
      if (sh.name === 'Reciprocating pump') expect([...groups].sort()).toEqual([10, 11, 12]);
      else expect(groups.size).toBe(0);
    }
  });

  it('is deterministic for the same seed (the app always shows the approved machines)', () => {
    const again = buildShapes(N, mulberry32(7));
    expect(Array.from(again[2].pts.slice(0, 64))).toEqual(Array.from(shapes[2].pts.slice(0, 64)));
  });
});

describe('getShapes cache', () => {
  it('builds the raw clouds once for the hero and mini sizes, and each matches buildShapes exactly', () => {
    clearShapeCache();
    const before = rawShapeBuildCount();
    const hero = getShapes(HERO_PARTICLES);
    const mini = getShapes(MINI_PARTICLES);
    expect(rawShapeBuildCount() - before).toBe(1); // the second size reused the raw clouds
    expect(getShapes(HERO_PARTICLES)).toBe(hero); // cached
    // Same PRNG sequence as an uncached build: the app still shows the approved machines.
    const heroRef = buildShapes(HERO_PARTICLES, mulberry32(7));
    const miniRef = buildShapes(MINI_PARTICLES, mulberry32(7));
    for (let m = 0; m < heroRef.length; m++) {
      expect(hero[m].pts).toEqual(heroRef[m].pts);
      expect(hero[m].sensors).toEqual(heroRef[m].sensors);
      expect(mini[m].pts).toEqual(miniRef[m].pts);
    }
  });

  it('releases the raw clouds once both sizes are cached (another size rebuilds them)', () => {
    clearShapeCache();
    getShapes(HERO_PARTICLES);
    getShapes(MINI_PARTICLES);
    const before = rawShapeBuildCount();
    getShapes(300);
    expect(rawShapeBuildCount() - before).toBe(1);
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
    expect(HOLD_SECONDS).toBe(4.6);
    expect(TRANSITION_SECONDS).toBe(1.8);

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

  it('setCamera re-aims in place and matches makeCamera', () => {
    const cam = makeCamera(0, 0, 0, 0, 1);
    const same = setCamera(cam, 1.1, 0.4, 10, 20, 30);
    expect(same).toBe(cam);
    expect(cam).toEqual(makeCamera(1.1, 0.4, 10, 20, 30));
  });
});

describe('simulated sensors', () => {
  const steady: SensorDef = { p: [0, 0, 0], name: 'T', unit: '°C', v: 80, s: 0.4 };
  const trending: SensorDef = { ...steady, trend: true };

  it('trending sensors drift up past the ABNORMAL threshold (> 12 %), steady ones never do', () => {
    const rng = () => 0.5; // zero noise
    expect(isAbnormal(trending, nextReading(trending, 0, rng))).toBe(false);
    expect(isAbnormal(trending, 80 * 1.12)).toBe(false);
    expect(isAbnormal(trending, 80 * 1.13)).toBe(true);
    expect(isAbnormal(trending, nextReading(trending, 4.5, rng))).toBe(true);
    expect(isAbnormal(steady, nextReading(steady, 4.5, rng))).toBe(false);
  });

  it('the reduced-motion still history ends ABNORMAL for the trending sensor only', () => {
    for (const sh of buildShapes(60, mulberry32(7))) {
      for (const s of sh.sensors) {
        const h = stillHistory(s);
        expect(h).toHaveLength(40);
        expect(isAbnormal(s, h[h.length - 1])).toBe(!!s.trend);
        expect(stillHistory(s)).toEqual(h); // deterministic still frame
      }
    }
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

describe('callout card fit', () => {
  // Measured in Chromium (canvas measureText), worst of the
  // loaded web font (Inter 600 11px) and the Windows fallback the installed
  // app uses under its CSP (Segoe UI 600 11px). Add a row when you add a
  // trending sensor — the test below fails until you do.
  const NAME_PX: Record<string, number> = {
    'Exhaust gas temperature': 132.8,
    'Axial displacement': 100.9,
    'Shaft vibration': 77.7,
    'Crankcase vibration': 106.6,
    'Motor NDE bearing temp': 130.7,
    'Radial vibration': 82.1,
  };
  // "● ABNORMAL" in JetBrains Mono 600 9.5px (57.0) vs the Consolas fallback (52.2).
  const TAG_PX = 57.0;

  it('every trending sensor: measureText(name) + 8 + measureText("● ABNORMAL") <= LABEL_W - 21', () => {
    expect(ABNORMAL_LABEL).toBe('● ABNORMAL');
    const trending = buildShapes(60, mulberry32(7)).flatMap((sh) => sh.sensors.filter((s) => s.trend));
    expect(trending).toHaveLength(6);
    for (const s of trending) {
      expect(NAME_PX[s.name], `measure "${s.name}" and add it to NAME_PX`).toBeTypeOf('number');
      expect(calloutFits(NAME_PX[s.name], TAG_PX), s.name).toBe(true);
      expect(NAME_PX[s.name] + 8 + TAG_PX).toBeLessThanOrEqual(LABEL_W - 21);
    }
  });

  it('the SPEC width 204 would still collide for the longest name (why LABEL_W is 224)', () => {
    expect(calloutFits(NAME_PX['Exhaust gas temperature'], TAG_PX, 204)).toBe(false);
    expect(LABEL_W).toBe(224);
  });

  it('keeps at least 5 px of headroom over the measured widths (text rendering differs between machines)', () => {
    for (const w of Object.values(NAME_PX)) expect(w + 8 + TAG_PX + 5).toBeLessThanOrEqual(LABEL_W - 21);
  });

  it('the sparkline keeps its 80 px width and sits 10 px from the right edge', () => {
    expect(SPARK_W).toBe(80);
    expect(SPARK_X + SPARK_W).toBe(LABEL_W - LABEL_PAD_R);
    expect(SPARK_X).toBe(134);
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

/**
 * Minimal recording 2D context: every method is a vi.fn, properties are plain
 * assignments. `imageData: false` leaves out createImageData, like jsdom.
 */
function makeCtx(imageData = true): { ctx: CanvasRenderingContext2D; rec: Recorder } {
  const rec: Recorder = {};
  const store: Record<string, unknown> = {};
  const ctx = new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'createImageData' && !imageData) return undefined;
      if (!rec[prop]) {
        rec[prop] =
          prop === 'measureText'
            ? vi.fn(() => ({ width: 24 }))
            : prop === 'createRadialGradient'
              ? vi.fn(() => ({ addColorStop: vi.fn() }))
              : prop === 'createImageData'
                ? vi.fn((w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }))
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

/** jsdom may not ship PointerEvent; a MouseEvent subclass carries clientX/Y + pointerId. */
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
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

  const useCtx = (imageData: boolean) => {
    const made = makeCtx(imageData);
    rec = made.rec;
    ctx = made.ctx;
  };

  beforeEach(() => {
    useCtx(true);
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
  const texts = () => (rec.fillText?.mock.calls ?? []).map((c) => c[0] as string);
  /** x/y of the solid sensor dots (radius 3) drawn in the last frame(s). */
  const sensorDots = () => (rec.arc?.mock.calls ?? []).filter((c) => c[2] === 3).map((c) => [c[0] as number, c[1] as number]);

  it('labels the canvas for assistive tech, including how to turn it (no double-click hint a screen-reader user cannot act on)', () => {
    render(<MachineMorphCanvas />);
    const canvas = screen.getByRole('img', {
      name: 'Animated illustration of industrial machines built from particles. Drag to turn the view.',
    });
    expect(canvas.getAttribute('aria-label')).not.toMatch(/double-click/i);
  });

  it('hero shows the machine name, the six progress dots and the simulated-readings note', () => {
    render(<MachineMorphCanvas />);
    expect(screen.getByText('Works with any machine that has sensors')).toBeTruthy();
    expect(screen.getByText('Gas turbine generator')).toBeTruthy();
    const note = screen.getByText('Illustration · simulated readings');
    expect(note.style.color).toBe('rgb(140, 140, 148)'); // --text-secondary, legible
    const dots = screen.getAllByTestId('machine-dot');
    expect(dots).toHaveLength(6);
    expect(dots.filter((d) => d.getAttribute('data-active') === 'true')).toHaveLength(1);
  });

  it('hero canvas takes pointer input (grab cursor, no touch scrolling); mini does not', () => {
    const { unmount } = render(<MachineMorphCanvas />);
    const hero = screen.getByRole('img') as HTMLCanvasElement;
    expect(hero.style.pointerEvents).toBe('auto');
    expect(hero.style.touchAction).toBe('none');
    expect(hero.style.cursor).toBe('grab');
    unmount();
    render(<MachineMorphCanvas variant="mini" />);
    const miniCanvas = screen.getByRole('img') as HTMLCanvasElement;
    expect(miniCanvas.style.pointerEvents).toBe('none');
    expect(miniCanvas.style.cursor).toBe('');
  });

  it('mini renders no labels or bottom bar and draws no text, but draws its dots', () => {
    render(<MachineMorphCanvas variant="mini" />);
    expect(screen.queryByText('Works with any machine that has sensors')).toBeNull();
    expect(screen.queryByText('Illustration · simulated readings')).toBeNull();
    expect(screen.queryByText('Gas turbine generator')).toBeNull();
    expect(screen.queryAllByTestId('machine-dot')).toHaveLength(0);
    runFrame(performance.now() + 100);
    expect(rec.putImageData).toHaveBeenCalledTimes(1); // the one pixel buffer
    expect(rec.drawImage).toHaveBeenCalledTimes(1);
    expect(rec.fillText).toBeUndefined(); // ...but no sensor callouts
    expect(rec.createRadialGradient).toBeUndefined(); // no background glow or grid
  });

  it('the mini variant registers no pointer listeners', () => {
    const add = vi.spyOn(HTMLCanvasElement.prototype, 'addEventListener');
    render(<MachineMorphCanvas variant="mini" />);
    const types = add.mock.calls.map((c) => c[0]);
    expect(types).not.toContain('pointerdown');
    expect(types).not.toContain('pointermove');
    expect(types).not.toContain('dblclick');
  });

  it('hero registers pointer listeners and removes them on unmount', () => {
    const add = vi.spyOn(HTMLCanvasElement.prototype, 'addEventListener');
    const remove = vi.spyOn(HTMLCanvasElement.prototype, 'removeEventListener');
    const { unmount } = render(<MachineMorphCanvas />);
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'dblclick']) {
      expect(add.mock.calls.map((c) => c[0])).toContain(t);
    }
    unmount();
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'dblclick']) {
      expect(remove.mock.calls.map((c) => c[0])).toContain(t);
    }
  });

  it('hero frame: one buffer upload + one lighter drawImage, and the sensor callouts', () => {
    render(<MachineMorphCanvas />);
    expect(rafSpy).toHaveBeenCalledTimes(1);
    runFrame(performance.now() + 100);
    expect(rec.createImageData).toHaveBeenCalledTimes(1);
    expect(rec.putImageData).toHaveBeenCalledTimes(1);
    expect(rec.drawImage).toHaveBeenCalledTimes(1);
    expect(rec.fillRect.mock.calls.length).toBeLessThan(5); // no per-dot squares any more
    expect(texts()).toContain('Exhaust gas temperature');
    expect(texts()).toContain('Active power');
    expect(rafSpy).toHaveBeenCalledTimes(2); // loop keeps running
    runFrame(performance.now() + 120);
    expect(rec.putImageData).toHaveBeenCalledTimes(2);
    expect(rec.createImageData).toHaveBeenCalledTimes(1); // buffer reused, not reallocated per frame
  });

  it('skips the dot pass (but still draws callouts) when createImageData is unavailable, as in jsdom', () => {
    useCtx(false);
    render(<MachineMorphCanvas />);
    expect(() => runFrame(performance.now() + 100)).not.toThrow();
    expect(rec.putImageData).toBeUndefined();
    expect(rec.drawImage).toBeUndefined();
    expect(texts()).toContain('Exhaust gas temperature');
  });

  it('prefers-reduced-motion draws a single still frame with the trending sensor already ABNORMAL', () => {
    setReducedMotion(true);
    render(<MachineMorphCanvas />);
    expect(rafSpy).not.toHaveBeenCalled();
    expect(rec.clearRect).toHaveBeenCalledTimes(1);
    expect(rec.putImageData).toHaveBeenCalledTimes(1);
    expect(texts()).toContain('Exhaust gas temperature');
    expect(texts()).toContain('● ABNORMAL');
    expect(texts()).not.toContain('● WATCH');
    expect(screen.getByText('Gas turbine generator')).toBeTruthy();
  });

  it('pointer down/move/up turns the view; double-click resets it (reduced motion: redraw only while dragging)', () => {
    setReducedMotion(true);
    render(<MachineMorphCanvas />);
    const canvas = screen.getByRole('img') as HTMLCanvasElement;
    const home = sensorDots();
    expect(home).toHaveLength(2);

    fireEvent.pointerDown(canvas, { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
    expect(canvas.style.cursor).toBe('grabbing');
    expect(rafSpy).toHaveBeenCalledTimes(1); // drag kicks a redraw
    fireEvent.pointerMove(canvas, { pointerId: 7, pointerType: 'mouse', buttons: 1, clientX: 420, clientY: 340 });
    rec.arc.mockClear();
    runFrame(performance.now() + 16);
    const turned = sensorDots();
    expect(turned).toHaveLength(2);
    expect(turned[0][0]).not.toBeCloseTo(home[0][0], 0);

    fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'mouse', clientX: 420, clientY: 340 });
    expect(canvas.style.cursor).toBe('grab');
    // Reduced motion: no glide, so the loop stops once the view has caught up.
    while (rafCallbacks.size) runFrame(performance.now() + 32);
    const calls = rafSpy.mock.calls.length;
    expect(calls).toBeLessThan(6);

    fireEvent.doubleClick(canvas);
    rec.arc.mockClear();
    while (rafCallbacks.size) runFrame(performance.now() + 48);
    const reset = sensorDots();
    expect(reset[0][0]).toBeCloseTo(home[0][0], 3);
    expect(reset[0][1]).toBeCloseTo(home[0][1], 3);
  });

  it('a second finger does not start another drag, and other mouse buttons are ignored', () => {
    setReducedMotion(true);
    render(<MachineMorphCanvas />);
    const canvas = screen.getByRole('img') as HTMLCanvasElement;
    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 10, clientY: 10 });
    expect(canvas.style.cursor).toBe('grab');
    expect(rafSpy).not.toHaveBeenCalled();
    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: 'touch', button: 0, clientX: 90, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: 'touch' });
    expect(canvas.style.cursor).toBe('grabbing'); // still held by the first finger
    fireEvent.pointerCancel(canvas, { pointerId: 1, pointerType: 'touch' });
    expect(canvas.style.cursor).toBe('grab');
  });

  /* ---------- pointer capture and lost releases ---------- */

  /** Stub pointer capture (jsdom has none); `held` is what the canvas currently captures. */
  const stubCapture = () => {
    const held = new Set<number>();
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    const set = vi.fn((id: number) => {
      held.add(id);
    });
    const release = vi.fn((id: number) => {
      held.delete(id);
    });
    const has = vi.fn((id: number) => held.has(id));
    proto.setPointerCapture = set;
    proto.releasePointerCapture = release;
    proto.hasPointerCapture = has;
    const restore = () => {
      delete proto.setPointerCapture;
      delete proto.releasePointerCapture;
      delete proto.hasPointerCapture;
    };
    return { held, set, release, has, restore };
  };
  /** Run pending frames until the loop stops (fails instead of hanging if it never does). */
  const drain = (max = 50) => {
    for (let i = 0; rafCallbacks.size; i++) {
      if (i >= max) throw new Error('animation loop did not stop');
      runFrame(performance.now() + 16);
    }
  };
  const lostCapture = (canvas: HTMLCanvasElement, pointerId: number, pointerType = 'touch') => {
    act(() => {
      canvas.dispatchEvent(new window.PointerEvent('lostpointercapture', { pointerId, pointerType }));
    });
  };

  it('captures the pointer on press and releases it on release', () => {
    const cap = stubCapture();
    try {
      setReducedMotion(true);
      render(<MachineMorphCanvas />);
      const canvas = screen.getByRole('img') as HTMLCanvasElement;
      fireEvent.pointerDown(canvas, { pointerId: 4, pointerType: 'mouse', button: 0, buttons: 1, clientX: 10, clientY: 10 });
      expect(cap.set).toHaveBeenCalledWith(4);
      expect(cap.held.has(4)).toBe(true);
      fireEvent.pointerUp(canvas, { pointerId: 4, pointerType: 'mouse', clientX: 10, clientY: 10 });
      expect(cap.release).toHaveBeenCalledWith(4);
      expect(cap.held.size).toBe(0);
      lostCapture(canvas, 4, 'mouse'); // the browser's follow-up event is harmless
      expect(canvas.style.cursor).toBe('grab');
    } finally {
      cap.restore();
    }
  });

  it('losing pointer capture mid-drag (no pointerup ever arrives) ends the drag, and a new pointer can drag again', () => {
    const cap = stubCapture();
    try {
      setReducedMotion(true);
      render(<MachineMorphCanvas />);
      const canvas = screen.getByRole('img') as HTMLCanvasElement;
      fireEvent.pointerDown(canvas, { pointerId: 5, pointerType: 'touch', button: 0, clientX: 100, clientY: 100 });
      expect(canvas.style.cursor).toBe('grabbing');
      cap.held.delete(5); // the OS takes capture away...
      lostCapture(canvas, 5); // ...and tells us, but no pointerup follows
      expect(canvas.style.cursor).toBe('grab');
      // Reduced motion: the redraw loop stops once the view has caught up.
      drain();
      expect(rafCallbacks.size).toBe(0);
      // Without the fix the single-pointer guard locked every later drag out.
      fireEvent.pointerDown(canvas, { pointerId: 6, pointerType: 'touch', button: 0, clientX: 100, clientY: 100 });
      expect(canvas.style.cursor).toBe('grabbing');
      expect(cap.set).toHaveBeenLastCalledWith(6);
      fireEvent.pointerUp(canvas, { pointerId: 6, pointerType: 'touch' });
      expect(canvas.style.cursor).toBe('grab');
    } finally {
      cap.restore();
    }
  });

  it('a press while the held pointer has silently lost capture replaces the stale drag', () => {
    const cap = stubCapture();
    try {
      setReducedMotion(true);
      render(<MachineMorphCanvas />);
      const canvas = screen.getByRole('img') as HTMLCanvasElement;
      fireEvent.pointerDown(canvas, { pointerId: 8, pointerType: 'pen', button: 0, clientX: 50, clientY: 50 });
      cap.held.delete(8); // capture gone, no event at all
      fireEvent.pointerDown(canvas, { pointerId: 9, pointerType: 'pen', button: 0, clientX: 60, clientY: 60 });
      expect(cap.set).toHaveBeenLastCalledWith(9);
      fireEvent.pointerUp(canvas, { pointerId: 9, pointerType: 'pen' });
      expect(canvas.style.cursor).toBe('grab');
      // ...while a second finger on a drag that still holds capture is still ignored.
      fireEvent.pointerDown(canvas, { pointerId: 10, pointerType: 'touch', button: 0, clientX: 50, clientY: 50 });
      fireEvent.pointerDown(canvas, { pointerId: 11, pointerType: 'touch', button: 0, clientX: 90, clientY: 50 });
      expect(cap.set).toHaveBeenLastCalledWith(10);
    } finally {
      cap.restore();
    }
  });

  it('a press from the same pointer that is supposedly still held restarts the drag where it pressed', () => {
    setReducedMotion(true);
    render(<MachineMorphCanvas />);
    const canvas = screen.getByRole('img') as HTMLCanvasElement;
    const home = sensorDots();
    fireEvent.pointerDown(canvas, { pointerId: 3, pointerType: 'touch', button: 0, clientX: 50, clientY: 50 });
    // its release was lost; the same finger id presses again somewhere else
    fireEvent.pointerDown(canvas, { pointerId: 3, pointerType: 'touch', button: 0, clientX: 400, clientY: 50 });
    expect(canvas.style.cursor).toBe('grabbing');
    fireEvent.pointerMove(canvas, { pointerId: 3, pointerType: 'touch', clientX: 400, clientY: 50 });
    rec.arc.mockClear();
    runFrame(performance.now() + 16); // still held, so the reduced-motion loop keeps going: one frame
    // No jump: the drag restarted at x=400, so "moving" to x=400 turned nothing.
    const now = sensorDots().slice(-2);
    expect(now[0][0]).toBeCloseTo(home[0][0], 3);
    fireEvent.pointerUp(canvas, { pointerId: 3, pointerType: 'touch' });
    expect(canvas.style.cursor).toBe('grab');
  });

  it('a mouse move with no button down ends a drag whose release was lost', () => {
    setReducedMotion(true);
    render(<MachineMorphCanvas />);
    const canvas = screen.getByRole('img') as HTMLCanvasElement;
    const home = sensorDots();
    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 340, clientY: 300 });
    expect(canvas.style.cursor).toBe('grabbing');
    // The button came up outside the window (Alt+Tab); the mouse comes back hovering.
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: 500, clientY: 300 });
    expect(canvas.style.cursor).toBe('grab');
    rec.arc.mockClear();
    drain();
    const settled = sensorDots().slice(-2);
    expect(settled[0][0]).not.toBeCloseTo(home[0][0], 0); // the 40 px that was dragged counts...
    // ...but plain hover no longer turns the machine, and the reduced-motion loop stays stopped.
    const frames = rafSpy.mock.calls.length;
    rec.arc.mockClear();
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: 700, clientY: 100 });
    expect(rafSpy.mock.calls.length).toBe(frames);
    expect(rec.arc).not.toHaveBeenCalled();
  });

  /* ---------- the animated loop under a controlled clock ---------- */

  let clockMs = 0;
  const useFakeClock = () => {
    clockMs = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
  };
  /** Advance the clock and run the pending frame. */
  const tick = (ms: number) => {
    clockMs += ms;
    runFrame(clockMs);
  };
  const tickFor = (totalMs: number, step = 50) => {
    for (let t = 0; t < totalMs; t += step) tick(step);
  };
  const activeDot = () => screen.getAllByTestId('machine-dot').findIndex((d) => d.getAttribute('data-active') === 'true');
  /** Sensor-dot positions drawn by the next 16 ms frame. */
  const nextFrameDots = () => {
    rec.arc?.mockClear();
    tick(16);
    return sensorDots();
  };

  it('holding the machine pauses the machine cycle; it resumes RESUME_MS after release', () => {
    useCtx(false); // skip the dot pass: this test runs ~400 frames
    useFakeClock();
    render(<MachineMorphCanvas />);
    const canvas = screen.getByRole('img') as HTMLCanvasElement;
    tickFor(3000); // 3 s into the first machine's hold
    expect(activeDot()).toBe(0);

    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 300, clientY: 300 });
    // Unheld, the next machine would show at t = HOLD + TRANSITION/2 = 5.5 s; held for 8 s it never does.
    tickFor(8000);
    expect(activeDot()).toBe(0);
    expect(screen.getByText(MACHINE_NAMES[0])).toBeTruthy();

    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 300, clientY: 300 });
    // Held, the clock stopped at HOLD − 0.6 s; after RESUME_MS it needs the rest of the way to mid-dissolve.
    const flipMs = RESUME_MS + (HOLD_SECONDS + TRANSITION_SECONDS / 2 - (HOLD_SECONDS - HOLD_STOP_BEFORE)) * 1000;
    tickFor(flipMs - 250);
    expect(activeDot()).toBe(0);
    tickFor(500);
    expect(activeDot()).toBe(1);
    expect(screen.getByText(MACHINE_NAMES[1])).toBeTruthy();
  });

  /* ---------- ‹ › buttons and dots: pick a machine ---------- */

  const nameShown = () => screen.getByTestId('machine-name').textContent;

  it('Next morphs to the next machine at once (no waiting for the hold), and the cycle goes on from there', () => {
    useCtx(false);
    useFakeClock();
    render(<MachineMorphCanvas />);
    tickFor(500);
    expect(activeDot()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Next machine' }));
    // The dissolve starts now: the name flips at its middle, far before the 4.6 s hold would end.
    tickFor((TRANSITION_SECONDS / 2) * 1000 + 100);
    expect(activeDot()).toBe(1);
    expect(nameShown()).toBe(MACHINE_NAMES[1]);
    // Landed: it holds on machine 1, then the usual cycle moves on to machine 2.
    tickFor((TRANSITION_SECONDS / 2) * 1000 + 2000);
    expect(activeDot()).toBe(1);
    tickFor((HOLD_SECONDS + TRANSITION_SECONDS / 2) * 1000);
    expect(activeDot()).toBe(2);
  });

  it('Previous goes back one machine (from the first to the last) and lands there, not on the next in line', () => {
    useCtx(false);
    useFakeClock();
    render(<MachineMorphCanvas />);
    tickFor(500);
    fireEvent.click(screen.getByRole('button', { name: 'Previous machine' }));
    tickFor(TRANSITION_SECONDS * 1000 + 300);
    expect(activeDot()).toBe(MACHINE_NAMES.length - 1);
    expect(nameShown()).toBe(MACHINE_NAMES[MACHINE_NAMES.length - 1]);
    // Still there well into its hold (a wrong landing would show machine 1).
    tickFor(2000);
    expect(activeDot()).toBe(MACHINE_NAMES.length - 1);
    // The callouts drawn are the last machine's own sensors.
    const last = getShapes(HERO_PARTICLES)[MACHINE_NAMES.length - 1];
    rec.fillText?.mockClear();
    tick(16);
    expect(texts()).toContain(last.sensors[0].name);
  });

  it('a dot jumps straight to its machine; the active dot is marked for assistive tech', () => {
    useCtx(false);
    useFakeClock();
    render(<MachineMorphCanvas />);
    tickFor(500);
    const dots = screen.getAllByTestId('machine-dot');
    expect(dots[3].getAttribute('aria-label')).toBe(`Show ${MACHINE_NAMES[3]}`);
    fireEvent.click(dots[3]);
    tickFor(TRANSITION_SECONDS * 1000 + 300);
    expect(activeDot()).toBe(3);
    expect(screen.getAllByTestId('machine-dot')[3].getAttribute('aria-current')).toBe('true');
    expect(screen.getAllByTestId('machine-dot')[0].getAttribute('aria-current')).toBeNull();
    // Clicking the machine already shown changes nothing.
    fireEvent.click(screen.getAllByTestId('machine-dot')[3]);
    tickFor(1000);
    expect(activeDot()).toBe(3);
  });

  it('two quick Next clicks step two machines', () => {
    useCtx(false);
    useFakeClock();
    render(<MachineMorphCanvas />);
    tickFor(500);
    const next = screen.getByRole('button', { name: 'Next machine' });
    fireEvent.click(next);
    tickFor(200); // the first dissolve has only begun
    fireEvent.click(next);
    tickFor(TRANSITION_SECONDS * 1000 + 300);
    expect(activeDot()).toBe(2);
    expect(nameShown()).toBe(MACHINE_NAMES[2]);
  });

  it('Next counts from the name on screen: early in an automatic dissolve it does not skip a machine', () => {
    useCtx(false);
    useFakeClock();
    render(<MachineMorphCanvas />);
    tickFor(HOLD_SECONDS * 1000 + 200); // the automatic dissolve 0 -> 1 has just begun; the name still says machine 0
    expect(activeDot()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Next machine' }));
    tickFor(TRANSITION_SECONDS * 1000 + 500);
    expect(activeDot()).toBe(1);
    // Previous from there (now holding on machine 1) goes back to machine 0.
    fireEvent.click(screen.getByRole('button', { name: 'Previous machine' }));
    tickFor(TRANSITION_SECONDS * 1000 + 300);
    expect(activeDot()).toBe(0);
  });

  it('Previous early in an automatic dissolve turns back to the machine before the one on screen', () => {
    useCtx(false);
    useFakeClock();
    render(<MachineMorphCanvas />);
    tickFor((HOLD_SECONDS + TRANSITION_SECONDS) * 1000 + 500); // holding on machine 1
    tickFor(HOLD_SECONDS * 1000 - 300); // its dissolve to machine 2 has just begun
    expect(activeDot()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Previous machine' }));
    tickFor(TRANSITION_SECONDS * 1000 + 300);
    expect(activeDot()).toBe(0);
  });

  it('Next works while the machine is being held (dragging pauses only the automatic cycle)', () => {
    useCtx(false);
    useFakeClock();
    render(<MachineMorphCanvas />);
    const canvas = screen.getByRole('img') as HTMLCanvasElement;
    tickFor(1000);
    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 300, clientY: 300 });
    fireEvent.click(screen.getByRole('button', { name: 'Next machine' }));
    tickFor(TRANSITION_SECONDS * 1000 + 300); // still inside RESUME_MS for part of it
    expect(activeDot()).toBe(1);
  });

  it('reduced motion: Next switches the still frame at once, with no animation loop', () => {
    setReducedMotion(true);
    render(<MachineMorphCanvas />);
    expect(rafSpy).not.toHaveBeenCalled();
    rec.fillText?.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Next machine' }));
    expect(nameShown()).toBe(MACHINE_NAMES[1]);
    expect(activeDot()).toBe(1);
    expect(rafSpy).not.toHaveBeenCalled();
    const second = getShapes(HERO_PARTICLES)[1];
    expect(texts()).toContain(second.sensors[0].name);
    expect(texts()).toContain(ABNORMAL_LABEL); // the still frame keeps its ABNORMAL read-out
    fireEvent.click(screen.getByRole('button', { name: 'Previous machine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous machine' }));
    expect(nameShown()).toBe(MACHINE_NAMES[MACHINE_NAMES.length - 1]);
  });

  it('the bar lets a drag through, its controls take the pointer; the mini variant has no controls', () => {
    const { unmount } = render(<MachineMorphCanvas />);
    const next = screen.getByRole('button', { name: 'Next machine' });
    expect((next.parentElement as HTMLElement).style.pointerEvents).toBe('auto');
    expect((next.parentElement!.parentElement as HTMLElement).style.pointerEvents).toBe('none');
    expect((screen.getAllByTestId('machine-dot')[0].parentElement as HTMLElement).style.pointerEvents).toBe('auto');
    unmount();
    render(<MachineMorphCanvas variant="mini" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('without a 2D canvas the name and dots still follow the buttons', () => {
    ctx = null;
    render(<MachineMorphCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'Previous machine' }));
    expect(nameShown()).toBe(MACHINE_NAMES[MACHINE_NAMES.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Next machine' }));
    expect(nameShown()).toBe(MACHINE_NAMES[0]);
    fireEvent.click(screen.getAllByTestId('machine-dot')[4]);
    expect(nameShown()).toBe(MACHINE_NAMES[4]);
  });

  it('a fast release glides (the view keeps turning); a release after holding still does not', () => {
    const run = (stillMs: number) => {
      useCtx(false);
      useFakeClock();
      const { unmount } = render(<MachineMorphCanvas />);
      const canvas = screen.getByRole('img') as HTMLCanvasElement;
      tickFor(1500); // callouts fully visible
      fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 300, clientY: 300 });
      for (let i = 1; i <= 5; i++) {
        fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 300 + i * 20, clientY: 300 });
        tick(16);
      }
      tickFor(stillMs, 16);
      fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 300 });
      tickFor(100, 16);
      const a = nextFrameDots();
      tickFor(150, 16);
      const b = nextFrameDots();
      unmount();
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(2);
      return Math.abs(b[0][0] - a[0][0]) + Math.abs(b[1][0] - a[1][0]);
    };
    expect(run(0)).toBeGreaterThan(5); // still gliding ~0.1–0.27 s after release
    expect(run(400)).toBeLessThan(0.05); // held still > 80 ms: no glide, and no sway during the resume pause
  });

  /* ---------- reduced motion: pixel-ratio changes ---------- */

  it('reduced motion: refits and redraws the still frame when the pixel ratio changes', () => {
    const listeners = new Map<string, Set<() => void>>();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((q: string) => ({
        matches: q === '(prefers-reduced-motion: reduce)',
        media: q,
        addEventListener: (_t: string, fn: () => void) => {
          if (!listeners.has(q)) listeners.set(q, new Set());
          listeners.get(q)!.add(fn);
        },
        removeEventListener: (_t: string, fn: () => void) => {
          listeners.get(q)?.delete(fn);
        },
      })),
    });
    const dprDesc = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    try {
      const { unmount } = render(<MachineMorphCanvas />);
      const canvas = screen.getByRole('img') as HTMLCanvasElement;
      expect(canvas.width).toBe(800);
      expect(listeners.get('(resolution: 1dppx)')?.size).toBe(1);
      const draws = rec.clearRect.mock.calls.length;

      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
      act(() => {
        for (const fn of [...listeners.get('(resolution: 1dppx)')!]) fn();
      });
      expect(canvas.width).toBe(1600); // refit to the new ratio
      expect(rec.clearRect.mock.calls.length).toBe(draws + 1); // and redrawn
      expect(rafSpy).not.toHaveBeenCalled(); // still no loop
      expect(listeners.get('(resolution: 1dppx)')?.size).toBe(0); // now watching the new ratio
      expect(listeners.get('(resolution: 2dppx)')?.size).toBe(1);

      unmount();
      expect(listeners.get('(resolution: 2dppx)')?.size).toBe(0);
    } finally {
      if (dprDesc) Object.defineProperty(window, 'devicePixelRatio', dprDesc);
      else delete (window as unknown as { devicePixelRatio?: number }).devicePixelRatio;
    }
  });

  it('the animated variant does not watch the pixel ratio (its loop checks it every frame)', () => {
    const queries: string[] = [];
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((q: string) => {
        queries.push(q);
        return { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      }),
    });
    render(<MachineMorphCanvas />);
    expect(queries.some((q) => q.startsWith('(resolution'))).toBe(false);
  });

  it('unmount cancels the pending animation frame', () => {
    const { unmount } = render(<MachineMorphCanvas />);
    runFrame(performance.now() + 50); // schedules a second frame
    const pending = [...rafCallbacks.keys()].pop()!;
    unmount();
    expect(cancelSpy).toHaveBeenCalledWith(pending);
    expect(rafCallbacks.size).toBe(0);
  });

  it('disconnects its ResizeObserver on unmount', () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(function RO() {
        return { observe, disconnect, unobserve: vi.fn() };
      }),
    );
    try {
      const { unmount } = render(<MachineMorphCanvas />);
      expect(observe).toHaveBeenCalled();
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
