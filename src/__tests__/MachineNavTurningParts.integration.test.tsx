import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import MachineMorphCanvas from '../components/upload/MachineMorphCanvas';
import { DotRenderer } from '../components/upload/machineDots';
import {
  HERO_PARTICLES,
  HOLD_SECONDS,
  MACHINE_NAMES,
  MINI_PARTICLES,
  PART_STEP,
  POINT_STRIDE,
  TRANSITION_SECONDS,
  buildShapes,
  getShapes,
  makeCamera,
  mulberry32,
  type MachineShape,
} from '../components/upload/machineShapes';

/*
 * Two features of the Welcome machine art landed one after the other and are tested apart:
 *
 *   - the ‹ › buttons and the dots that pick a machine (`MachineMorphCanvas.test.tsx`
 *     "‹ › buttons and dots") — every one of those tests SKIPS the dot pass and reads the
 *     name chip, the progress dots and the callout texts;
 *   - every machine's rotor train turns (`machineParts.test.ts`, SPEC
 *     docs/design/handoff/welcome-machine-rotation) — its renderer tests draw ONE machine
 *     against itself (`render(ctx, shape, shape, …)`), never a dissolve between two.
 *
 * The seam between them is the dissolve a button starts: the canvas hands the renderer TWO
 * machines (the one on screen, the one asked for) and the renderer must pose each with ITS
 * OWN parts table before blending. Nothing checks that
 *   (a) after ‹ › / a dot, the cloud that is drawn is the machine the name chip says — the
 *       shape object that carries that machine's moving parts — at every frame on the way;
 *   (b) the parts keep turning THROUGH a navigation (the spin clock is never reset or frozen
 *       by it), and stay at rest under reduced motion whichever machine is picked;
 *   (c) a dissolve between two DIFFERENT machines starts as exactly the first and ends as
 *       exactly the second, each with its own parts in motion (a parts table applied to the
 *       other machine's points would show here and nowhere else).
 */

/* ------------------------------------------------------------------ */
/* (a) + (b): the canvas → the renderer, through the buttons           */
/* ------------------------------------------------------------------ */

type RenderArgs = { A: MachineShape; B: MachineShape; e: number; burst: number; spin: number };

/** A recording 2D context without ImageData (the dot pass itself is replaced by a spy). */
function makeCtx(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {};
  const fns: Record<string, unknown> = {};
  return new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'createImageData') return undefined;
      if (!fns[prop]) {
        fns[prop] = prop === 'measureText' ? () => ({ width: 24 })
          : prop === 'createRadialGradient' ? () => ({ addColorStop() {} })
          : () => undefined;
      }
      return fns[prop];
    },
    set(target, prop: string, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

describe('‹ › / dots × turning parts: the cloud that is drawn is the machine on the name chip, with its own parts, still turning', () => {
  let frames: RenderArgs[];
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextId: number;
  let clockMs: number;
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

  const setReducedMotion = (matches: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true, writable: true,
      value: vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  };

  beforeEach(() => {
    frames = [];
    const ctx = makeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    // What the canvas asks the renderer to draw, frame by frame (the dot pass itself is not run).
    vi.spyOn(DotRenderer.prototype, 'render').mockImplementation(function (this: DotRenderer, _ctx, A, B, e, burst, _cam, spin) {
      frames.push({ A, B, e, burst, spin });
      return false;
    });
    rafCallbacks = new Map();
    nextId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => { nextId += 1; rafCallbacks.set(nextId, cb); return nextId; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => { rafCallbacks.delete(id); });
    clockMs = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    setReducedMotion(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  const HERO = () => getShapes(HERO_PARTICLES);
  const nameShown = () => screen.getByTestId('machine-name').textContent;
  const activeDot = () => screen.getAllByTestId('machine-dot').findIndex((d) => d.getAttribute('data-active') === 'true');
  const last = () => frames[frames.length - 1];

  /** Advance the clock one step, run the pending frame, and check what EVERY frame must hold:
   *  the name chip names the nearer end of the dissolve the renderer was just given. */
  const tick = (ms: number) => {
    clockMs += ms;
    const entry = [...rafCallbacks.entries()].pop();
    if (!entry) return;
    rafCallbacks.delete(entry[0]);
    act(() => entry[1](clockMs));
    const f = last();
    const onScreen = f.e < 0.5 ? f.A : f.B;
    expect(nameShown(), `name chip vs cloud at e=${f.e.toFixed(3)}`).toBe(onScreen.name);
    expect(activeDot()).toBe(MACHINE_NAMES.indexOf(onScreen.name));
  };
  const tickFor = (totalMs: number, step = 50) => { for (let t = 0; t < totalMs; t += step) tick(step); };
  const LAND_MS = TRANSITION_SECONDS * 1000 + 300;

  /** Since frame `from`: the spin clock went up on every frame — never reset, never frozen. */
  const expectSpinKeptRunning = (from = 0) => {
    for (let i = Math.max(1, from); i < frames.length; i++) {
      expect(frames[i].spin, `spin at frame ${i}`).toBeGreaterThan(frames[i - 1].spin);
    }
  };

  it('the hero starts on machine 0 — the very shape object that carries its moving parts', () => {
    render(<MachineMorphCanvas />);
    tickFor(500);
    expect(last().A).toBe(HERO()[0]);
    expect(last().e).toBe(0);
    expect(last().A.parts.length).toBeGreaterThan(0);
    // every machine the buttons can reach has parts of its own (nothing to "land on" without them)
    for (const s of HERO()) expect(s.parts.length, s.name).toBeGreaterThan(0);
    expectSpinKeptRunning();
  });

  it('a dot (0 → 3, not the next in line): the dissolve is drawn between machine 0 and machine 3, lands on machine 3 with ITS parts, and the parts never stop turning', () => {
    render(<MachineMorphCanvas />);
    tickFor(500);
    const before = frames.length;
    fireEvent.click(screen.getAllByTestId('machine-dot')[3]);
    tickFor(LAND_MS);
    const during = frames.slice(before).filter((f) => f.e > 0 && f.e < 1);
    expect(during.length).toBeGreaterThan(10);
    // every frame of the dissolve blends exactly those two machines — never the one "next in line"
    for (const f of during) {
      expect(f.A).toBe(HERO()[0]);
      expect(f.B).toBe(HERO()[3]);
    }
    // it gets all the way across, in order
    expect(during[0].e).toBeLessThan(0.1);
    expect(during[during.length - 1].e).toBeGreaterThan(0.9);
    for (let i = 1; i < during.length; i++) expect(during[i].e).toBeGreaterThanOrEqual(during[i - 1].e);
    // landed: the held shape IS machine 3 (its own parts table), fully formed
    expect(last().A).toBe(HERO()[3]);
    expect(last().e).toBe(0);
    expect(last().A.parts).toBe(HERO()[3].parts);
    expect(nameShown()).toBe(MACHINE_NAMES[3]);
    // ...and it is the only machine with sliding parts (the plungers): the right table came along
    expect(last().A.parts.some((p) => p.kind === 'slide')).toBe(true);
    expect(HERO()[0].parts.some((p) => p.kind === 'slide')).toBe(false);
    expectSpinKeptRunning();
    // well into the hold it is still machine 3, still turning
    const held = frames.length;
    tickFor(2000);
    expect(last().A).toBe(HERO()[3]);
    expectSpinKeptRunning(held);
  });

  it('Previous from the first machine wraps to the LAST one: drawn 0 → 5, landed on 5 with its parts', () => {
    render(<MachineMorphCanvas />);
    tickFor(500);
    const before = frames.length;
    fireEvent.click(screen.getByRole('button', { name: 'Previous machine' }));
    tickFor(LAND_MS);
    const n = MACHINE_NAMES.length - 1;
    for (const f of frames.slice(before).filter((f) => f.e > 0 && f.e < 1)) {
      expect(f.A).toBe(HERO()[0]);
      expect(f.B).toBe(HERO()[n]);
    }
    expect(last().A).toBe(HERO()[n]);
    expect(last().A.parts).toBe(HERO()[n].parts);
    expect(last().e).toBe(0);
    expectSpinKeptRunning();
  });

  it('two quick Next clicks: the second dissolve is re-aimed at machine 2 and lands there; the parts turn through both', () => {
    render(<MachineMorphCanvas />);
    tickFor(500);
    const next = screen.getByRole('button', { name: 'Next machine' });
    fireEvent.click(next);
    tickFor(200);
    expect(last().B).toBe(HERO()[1]);
    fireEvent.click(next);
    tickFor(LAND_MS);
    expect(last().A).toBe(HERO()[2]);
    expect(last().A.parts).toBe(HERO()[2].parts);
    expect(last().e).toBe(0);
    expect(nameShown()).toBe(MACHINE_NAMES[2]);
    expectSpinKeptRunning();
  });

  it('Next during an automatic dissolve, and a button while the machine is held by the pointer: the cloud and the chip never disagree, spin never stops', () => {
    render(<MachineMorphCanvas />);
    // into the automatic dissolve 0 → 1 (past its middle: the chip already says machine 1)
    tickFor((HOLD_SECONDS + TRANSITION_SECONDS * 0.7) * 1000);
    expect(nameShown()).toBe(MACHINE_NAMES[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Next machine' }));
    tickFor(LAND_MS + (TRANSITION_SECONDS * 1000));
    expect(last().A).toBe(HERO()[2]);
    // hold the machine with the pointer (the automatic cycle pauses), then pick machine 5
    const canvas = screen.getByRole('img') as HTMLCanvasElement;
    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 300, clientY: 300 });
    const held = frames.length;
    tickFor(1000);
    fireEvent.click(screen.getAllByTestId('machine-dot')[5]);
    tickFor(LAND_MS);
    expect(last().A).toBe(HERO()[5]);
    expect(last().A.parts).toBe(HERO()[5].parts);
    // the rotor keeps turning while the machine is held and while it dissolves
    expectSpinKeptRunning(held);
    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 300, clientY: 300 });
  });

  it('reduced motion: every pick draws ONE still frame of the picked machine with spin 0 — its parts are at rest', () => {
    setReducedMotion(true);
    render(<MachineMorphCanvas />);
    expect(rafCallbacks.size).toBe(0);
    expect(last().A).toBe(HERO()[0]);
    expect(last().spin).toBe(0);
    const picks: [() => void, number][] = [
      [() => fireEvent.click(screen.getByRole('button', { name: 'Next machine' })), 1],
      [() => fireEvent.click(screen.getAllByTestId('machine-dot')[4]), 4],
      [() => fireEvent.click(screen.getByRole('button', { name: 'Previous machine' })), 3],
      [() => fireEvent.click(screen.getAllByTestId('machine-dot')[0]), 0],
      [() => fireEvent.click(screen.getByRole('button', { name: 'Previous machine' })), MACHINE_NAMES.length - 1],
    ];
    for (const [pick, want] of picks) {
      const before = frames.length;
      act(() => pick());
      expect(frames.length, 'one still frame per pick').toBe(before + 1);
      expect(last().A).toBe(HERO()[want]);
      expect(last().e).toBe(0);
      expect(last().burst).toBe(0);
      expect(last().spin, 'parts at rest').toBe(0);
      expect(nameShown()).toBe(MACHINE_NAMES[want]);
      expect(rafCallbacks.size, 'no animation loop').toBe(0);
    }
  });

  it('the mini canvas (no buttons) is handed the 2,400-dot machines — the same parts — and they turn too', () => {
    render(<MachineMorphCanvas variant="mini" />);
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        clockMs += 50;
        const entry = [...rafCallbacks.entries()].pop()!;
        rafCallbacks.delete(entry[0]);
        act(() => entry[1](clockMs));
      }
    };
    run(500);
    const mini = getShapes(MINI_PARTICLES);
    expect(last().A).toBe(mini[0]);
    expect(last().A.pts.length).toBe(MINI_PARTICLES * POINT_STRIDE);
    expect(last().A.parts).toEqual(HERO()[0].parts.map((p) => expect.objectContaining({ name: p.name, kind: p.kind, axis: p.axis, rps: p.rps, phase: p.phase, amp: p.amp })));
    expect(screen.queryByRole('button', { name: 'Next machine' })).toBeNull();
    expectSpinKeptRunning();
  });
});

/* ------------------------------------------------------------------ */
/* (c): the renderer, between two DIFFERENT machines                    */
/* ------------------------------------------------------------------ */

describe('DotRenderer between two different machines (what a ‹ › dissolve draws): each end is posed with its OWN parts', () => {
  const N = 6000;
  const shapes = buildShapes(N, mulberry32(7));
  const jit = new Float32Array(N * 3).fill(0.37); // would show at once if `burst` leaked into a formed machine
  const cam = makeCamera(-0.7, 0.32, 600, 280, Math.min(1200 * 0.17, 600 * 0.165));
  const ctxOf = () => ({
    save() {}, restore() {}, setTransform() {}, drawImage() {}, putImageData() {},
    globalCompositeOperation: 'source-over',
    createImageData: vi.fn((w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })),
  }) as unknown as CanvasRenderingContext2D;
  /** Screen position of every particle after one frame of the A→B dissolve at progress `e`. */
  const frame = (A: MachineShape, B: MachineShape, e: number, spin: number) => {
    const r = new DotRenderer(N, false);
    const ctx = ctxOf();
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
    try { r.render(ctx, A, B, e, 0, cam, spin, jit, 1200, 600, 1); } finally { spy.mockRestore(); }
    const priv = r as unknown as { xs: Float32Array; ys: Float32Array };
    return { xs: Float32Array.from(priv.xs), ys: Float32Array.from(priv.ys) };
  };
  const maxDiff = (a: { xs: Float32Array; ys: Float32Array }, b: { xs: Float32Array; ys: Float32Array }) => {
    let d = 0;
    for (let i = 0; i < N; i++) d = Math.max(d, Math.abs(a.xs[i] - b.xs[i]), Math.abs(a.ys[i] - b.ys[i]));
    return d;
  };
  const isMoving = (s: MachineShape, i: number) => s.pts[i * POINT_STRIDE + 3] >= PART_STEP;

  // The dissolves the buttons start: Next (0 → 1), Previous with wrap (0 → 5), a dot jump
  // (0 → 3), into and out of the one machine with SLIDING parts (2 → 3, 3 → 4), back (4 → 2).
  const PAIRS: [number, number][] = [[0, 1], [0, 5], [0, 3], [2, 3], [3, 4], [4, 2], [5, 0]];
  const SPIN = 2.3;

  it.each(PAIRS)('%i → %i: at the start it is exactly machine A turning, at the end exactly machine B turning', (a, b) => {
    const A = shapes[a];
    const B = shapes[b];
    const onlyA = frame(A, A, 0, SPIN);
    const onlyB = frame(B, B, 0, SPIN);
    // e = 0: nothing of B (points OR parts) shows — B's parts table never touches A's points
    expect(maxDiff(frame(A, B, 0, SPIN), onlyA), `${A.name} at the start of ${A.name} → ${B.name}`).toBe(0);
    // e = 1: it is B, posed with B's own table (A's is not carried over)
    expect(maxDiff(frame(A, B, 1, SPIN), onlyB), `${B.name} at the end of ${A.name} → ${B.name}`).toBeLessThan(1e-2);
    // ...and the same frame the other way round (the buttons go both ways)
    expect(maxDiff(frame(B, A, 1, SPIN), onlyA)).toBeLessThan(1e-2);
  });

  it.each(PAIRS)('%i → %i: mid-dissolve both ends are STILL turning — a dot that belongs to a moving part at either end is elsewhere a moment later', (a, b) => {
    const A = shapes[a];
    const B = shapes[b];
    const now = frame(A, B, 0.5, 0.9);
    const later = frame(A, B, 0.5, 2.3);
    let movedOfMoving = 0, moving = 0, movedOfFixed = 0;
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(now.xs[i] - later.xs[i], now.ys[i] - later.ys[i]);
      if (isMoving(A, i) || isMoving(B, i)) { moving++; if (d > 0.25) movedOfMoving++; }
      else if (d !== 0) movedOfFixed++;
    }
    // a dot that is fixed in BOTH machines does not move with the clock at all
    expect(movedOfFixed, `${A.name} → ${B.name}`).toBe(0);
    expect(moving).toBeGreaterThan(0);
    expect(movedOfMoving / moving, `${A.name} → ${B.name}`).toBeGreaterThan(0.5);
  });

  it('spin 0 (reduced motion) between two machines: every TURNING part is exactly where the raw shape puts it; only the plungers sit off it, by their own phase', () => {
    const strip = (s: MachineShape): MachineShape => ({ ...s, parts: [], pts: s.pts.map((v, i) => (i % POINT_STRIDE === 3 ? v & 3 : v)) } as MachineShape);
    /** The dot belongs to a SLIDING part of this machine (a plunger: at 0 s it sits at amp × sin(phase)). */
    const slides = (s: MachineShape, i: number) => {
      const part = s.pts[i * POINT_STRIDE + 3] >> 2;
      return part > 0 && s.parts[part - 1].kind === 'slide';
    };
    let slidingSeen = 0;
    for (const [a, b] of PAIRS) {
      const A = shapes[a];
      const B = shapes[b];
      for (const e of [0, 0.5, 1]) {
        const real = frame(A, B, e, 0);
        const raw = frame(strip(A), strip(B), e, 0);
        let worstTurning = 0, worstSliding = 0;
        for (let i = 0; i < N; i++) {
          const d = Math.max(Math.abs(real.xs[i] - raw.xs[i]), Math.abs(real.ys[i] - raw.ys[i]));
          if (slides(A, i) || slides(B, i)) { slidingSeen++; worstSliding = Math.max(worstSliding, d); } else worstTurning = Math.max(worstTurning, d);
        }
        // fixed dots and every rotor / coupling / fan / impeller: the rest pose is the raw shape
        expect(worstTurning, `${a} → ${b} at e=${e}`).toBeLessThan(1e-3);
        // a plunger is never further from its raw place than its stroke (a small fraction of the machine)
        expect(worstSliding, `${a} → ${b} at e=${e}`).toBeLessThan(0.12 * cam.sc);
      }
    }
    // only the Reciprocating pump has them, and the pairs above go through it
    expect(slidingSeen).toBeGreaterThan(0);
    expect(shapes.filter((s) => s.parts.some((p) => p.kind === 'slide')).map((s) => s.name)).toEqual([MACHINE_NAMES[3]]);
  });
});
