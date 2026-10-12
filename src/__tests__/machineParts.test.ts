import { describe, it, expect, vi } from 'vitest';
import {
  CRANK_RPS,
  MACHINE_NAMES,
  MAX_PARTS,
  PART_STEP,
  PART_STRIDE,
  PLUNGER_AMP,
  PLUNGER_PHASES,
  POINT_STRIDE,
  SPIN_PER_SECOND,
  TAU,
  buildShapes,
  getShapes,
  makeCamera,
  mulberry32,
  poseParts,
  type PartDef,
} from '../components/upload/machineShapes';
import { DotRenderer } from '../components/upload/machineDots';

/*
 * Welcome machine art — every machine's rotor train turns (SPEC
 * docs/design/handoff/welcome-machine-rotation/README.md, approved 2026-10-12).
 *
 * A point's `group` = colour (`group & 3`) + PART_STEP × part (`group >> 2`): part 0 is
 * fixed, part k ≥ 1 moves with `shape.parts[k − 1]`. The renderer poses every part once
 * per frame (`poseParts`) and applies that matrix to the part's points before the A→B blend.
 */

const partOf = (g: number) => g >> 2;
const colourOf = (g: number) => g & 3;

/** Apply slot `k` of a pose buffer to a point. */
function applyPose(m: Float32Array, k: number, p: [number, number, number]): [number, number, number] {
  const o = k * PART_STRIDE;
  return [
    m[o] * p[0] + m[o + 1] * p[1] + m[o + 2] * p[2] + m[o + 3],
    m[o + 4] * p[0] + m[o + 5] * p[1] + m[o + 6] * p[2] + m[o + 7],
    m[o + 8] * p[0] + m[o + 9] * p[1] + m[o + 10] * p[2] + m[o + 11],
  ];
}

describe('poseParts', () => {
  const turn = (axis: 'x' | 'y' | 'z', c: [number, number, number], rps = 0.3): PartDef => ({ name: 't', kind: 'turn', axis, c, rps, phase: 0, amp: 0 });
  const slide = (phase: number): PartDef => ({ name: 's', kind: 'slide', axis: 'x', c: [0, 0, 0], rps: CRANK_RPS, phase, amp: PLUNGER_AMP });

  it('a turn at 0 s is the identity, whatever its axis and centre', () => {
    const out = new Float32Array((MAX_PARTS + 1) * PART_STRIDE);
    poseParts([turn('x', [0.2, -0.3, 0.4]), turn('y', [1, 2, 3]), turn('z', [-1, 0.5, 0])], 0, out);
    for (const k of [1, 2, 3]) {
      const p = applyPose(out, k, [0.7, -1.1, 0.35]);
      expect(p[0]).toBeCloseTo(0.7, 6);
      expect(p[1]).toBeCloseTo(-1.1, 6);
      expect(p[2]).toBeCloseTo(0.35, 6);
    }
  });

  it('a turn keeps every point on its circle: the distance to the shaft axis and the position along it do not change', () => {
    const out = new Float32Array((MAX_PARTS + 1) * PART_STRIDE);
    const cases: ['x' | 'y' | 'z', [number, number, number]][] = [['x', [0.1, -0.31, 0.02]], ['y', [-0.13, 0.1, 0]], ['z', [-1.08, -0.31, -0.22]]];
    for (const [axis, c] of cases) {
      const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const radial = (p: number[]) => Math.hypot(...[0, 1, 2].filter(i => i !== ai).map(i => p[i] - c[i]));
      const p0: [number, number, number] = [0.6, 0.45, -0.8];
      for (const sec of [0.37, 1.9, 12.25]) {
        poseParts([turn(axis, c)], sec, out);
        const p = applyPose(out, 1, p0);
        expect(radial(p)).toBeCloseTo(radial(p0), 5);
        expect(p[ai]).toBeCloseTo(p0[ai], 6);
      }
      // ... and it really turns: a quarter of a revolution moves the point
      poseParts([turn(axis, c, 0.25)], 1, out);
      const q = applyPose(out, 1, p0);
      expect(Math.hypot(q[0] - p0[0], q[1] - p0[1], q[2] - p0[2])).toBeGreaterThan(0.1);
    }
  });

  it('a slide is the shipped plunger stroke: amp × sin(spin × 0.55 + phase) along its axis, nothing else', () => {
    const out = new Float32Array((MAX_PARTS + 1) * PART_STRIDE);
    expect(CRANK_RPS).toBeCloseTo((0.55 * SPIN_PER_SECOND) / TAU, 12);
    for (const spin of [0, 1.3, 7.75, 40]) {
      poseParts(PLUNGER_PHASES.map(slide), spin / SPIN_PER_SECOND, out);
      PLUNGER_PHASES.forEach((phase, i) => {
        const p = applyPose(out, i + 1, [0.5, 0.2, -0.1]);
        expect(p[0] - 0.5).toBeCloseTo(PLUNGER_AMP * Math.sin(spin * 0.55 + phase), 5);
        expect(p[1]).toBeCloseTo(0.2, 6);
        expect(p[2]).toBeCloseTo(-0.1, 6);
      });
    }
  });

  it('writes one 3×4 matrix per part from slot 1: slot 0 and the slots past the last part are not touched', () => {
    const out = new Float32Array((MAX_PARTS + 1) * PART_STRIDE).fill(7);
    poseParts([turn('x', [0, 0, 0]), slide(0)], 2.5, out);
    expect([...out.subarray(0, PART_STRIDE)]).toEqual(new Array(PART_STRIDE).fill(7));
    expect([...out.subarray(3 * PART_STRIDE)]).toEqual(new Array((MAX_PARTS - 2) * PART_STRIDE).fill(7));
    expect([...out.subarray(PART_STRIDE, 3 * PART_STRIDE)].some(v => v !== 7)).toBe(true);
  });
});

describe('machine shapes: moving parts', () => {
  const shapes = buildShapes(6000);

  it('every machine has at least one moving part and at most MAX_PARTS; every point belongs to a part that exists', () => {
    expect(PART_STEP).toBe(4);
    expect(PART_STRIDE).toBe(12);
    for (const sh of shapes) {
      expect(sh.parts.length, sh.name).toBeGreaterThanOrEqual(1);
      expect(sh.parts.length, sh.name).toBeLessThanOrEqual(MAX_PARTS);
      const used = new Set<number>();
      for (let i = 3; i < sh.pts.length; i += POINT_STRIDE) {
        const g = sh.pts[i];
        expect(Number.isInteger(g)).toBe(true);
        expect(colourOf(g)).toBeGreaterThanOrEqual(0);
        expect(colourOf(g)).toBeLessThanOrEqual(3);
        expect(partOf(g)).toBeLessThanOrEqual(sh.parts.length);
        used.add(partOf(g));
      }
      // every declared part really has dots, and most of the machine stays fixed
      for (let k = 0; k <= sh.parts.length; k++) expect(used.has(k), `${sh.name} part ${k}`).toBe(true);
    }
  });

  it('the turning parts of each machine are the approved ones (kind, axis, speed)', () => {
    const table = shapes.map(sh => [sh.name, sh.parts.map(p => `${p.name}:${p.kind} ${p.axis} ${p.rps.toFixed(2)}`)]);
    expect(table).toEqual([
      ['Gas turbine generator', ['rotor:turn x 0.30']],
      ['Gas turbine compressor', ['gas generator rotor:turn x 0.42', 'power turbine shaft:turn x 0.26']],
      ['Motor', ['rotor:turn x 0.36']],
      ['Reciprocating pump', ['crankshaft sheave:turn z 0.26', 'plunger 1:slide x 0.26', 'plunger 2:slide x 0.26', 'plunger 3:slide x 0.26']],
      ['Can pump', ['rotor:turn y 0.30']],
      ['Turbo expander', ['rotor:turn x 0.50']],
    ]);
    expect(shapes.map(s => s.name)).toEqual([...MACHINE_NAMES]);
  });

  it('only the Reciprocating pump slides — its three plungers, with the shipped stroke and phases, in bright metal', () => {
    for (const sh of shapes) {
      const slides = sh.parts.map((p, i) => ({ p, k: i + 1 })).filter(x => x.p.kind === 'slide');
      if (sh.name !== 'Reciprocating pump') { expect(slides, sh.name).toHaveLength(0); continue; }
      expect(slides.map(x => x.p.phase)).toEqual([...PLUNGER_PHASES]);
      expect(slides.every(x => x.p.amp === PLUNGER_AMP && x.p.axis === 'x' && x.p.rps === CRANK_RPS)).toBe(true);
      // the sheave turns once per stroke
      expect(sh.parts[0].rps).toBe(CRANK_RPS);
      for (const { k } of slides) {
        const colours = new Set<number>();
        for (let i = 3; i < sh.pts.length; i += POINT_STRIDE) if (partOf(sh.pts[i]) === k) colours.add(colourOf(sh.pts[i]));
        expect([...colours]).toEqual([3]);
      }
      expect(sh.parts.filter(p => p.kind === 'turn').every(p => p.amp === 0)).toBe(true);
    }
  });

  it('a modest share of the dots moves: 5–13 % per machine, about 20 % on the Reciprocating pump', () => {
    for (const sh of shapes) {
      let moving = 0;
      for (let i = 3; i < sh.pts.length; i += POINT_STRIDE) if (sh.pts[i] >= PART_STEP) moving++;
      const share = moving / sh.count;
      if (sh.name === 'Reciprocating pump') { expect(share).toBeGreaterThan(0.15); expect(share).toBeLessThan(0.25); }
      else { expect(share, sh.name).toBeGreaterThan(0.05); expect(share, sh.name).toBeLessThan(0.13); }
    }
  });

  it('part centres follow the fit: every turning part\'s own dots stay on circles around its (fitted) axis', () => {
    // If a centre were left in raw space, the dots of the part would not sit around it:
    // the mean of a rotor's dots, off its axis, must be far smaller than the rotor's radius.
    for (const sh of shapes) {
      sh.parts.forEach((p, idx) => {
        if (p.kind !== 'turn') return;
        const ai = p.axis === 'x' ? 0 : p.axis === 'y' ? 1 : 2;
        const [u, v] = [0, 1, 2].filter(i => i !== ai);
        let n = 0, su = 0, sv = 0, maxR = 0;
        for (let i = 0; i < sh.pts.length; i += POINT_STRIDE) {
          if (partOf(sh.pts[i + 3]) !== idx + 1) continue;
          const du = sh.pts[i + u] - p.c[u];
          const dv = sh.pts[i + v] - p.c[v];
          su += du; sv += dv; n++;
          maxR = Math.max(maxR, Math.hypot(du, dv));
        }
        expect(n, `${sh.name} ${p.name}`).toBeGreaterThan(20);
        expect(Math.hypot(su / n, sv / n), `${sh.name} ${p.name}`).toBeLessThan(maxR * 0.25);
        expect(p.c.every(Number.isFinite)).toBe(true);
      });
    }
  });

  it('the sensor callouts did not move: every anchor equals the shipped one (0.9.0) within 1e-5', () => {
    const SHIPPED = [
      [[0.389937, 0.341647, 0.301887], [1.27044, 0.42215, 0]],
      [[1.452055, 0.712329, -0.09589], [1.742466, 0.09863, -0.09589]],
      [[-0.227488, 0.876777, -0.508186], [1.080569, 0.21327, -0.034252]],
      [[-0.939759, 0.361446, -0.216867], [1.277108, 1.46988, -0.939759]],
      [[-0.131086, 1.820225, 0], [0.842696, 0.434457, 0]],
      [[-1.136364, 1.327273, 0.106133], [-0.181818, 0.263636, 0.106133]],
    ];
    shapes.forEach((sh, i) => {
      expect(sh.sensors).toHaveLength(2); // more callouts were tried and rejected by the user
      sh.sensors.forEach((s, k) => s.p.forEach((val, j) => expect(Math.abs(val - SHIPPED[i][k][j]), `${sh.name} sensor ${k}`).toBeLessThan(1e-5)));
    });
  });

  it('the mini canvas gets the same parts (same data at 2,400 dots)', () => {
    const mini = getShapes(2400);
    const hero = getShapes(6000);
    mini.forEach((sh, i) => {
      expect(sh.parts.map(p => p.name)).toEqual(hero[i].parts.map(p => p.name));
      let moving = 0;
      for (let k = 3; k < sh.pts.length; k += POINT_STRIDE) if (sh.pts[k] >= PART_STEP) moving++;
      expect(moving, sh.name).toBeGreaterThan(0);
    });
  });
});

describe('DotRenderer: the parts move with the clock', () => {
  const N = 6000;
  const shapes = buildShapes(N, mulberry32(7));
  const jit = new Float32Array(N * 3);
  const cam = makeCamera(-0.7, 0.32, 600, 280, Math.min(1200 * 0.17, 600 * 0.165));
  const ctxOf = () => ({
    save() {}, restore() {}, setTransform() {}, drawImage() {}, putImageData() {},
    globalCompositeOperation: 'source-over',
    createImageData: vi.fn((w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })),
  }) as unknown as CanvasRenderingContext2D;
  /** Screen position of every particle after one frame at `spin`. */
  const frame = (r: DotRenderer, ctx: CanvasRenderingContext2D, shape: (typeof shapes)[number], spin: number) => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
    try { r.render(ctx, shape, shape, 0, 0, cam, spin, jit, 1200, 600, 1); } finally { spy.mockRestore(); }
    const priv = r as unknown as { xs: Float32Array; ys: Float32Array };
    return { xs: Float32Array.from(priv.xs), ys: Float32Array.from(priv.ys) };
  };

  it('for every machine: dots of a moving part land elsewhere at another moment, fixed dots do not move at all', () => {
    for (const shape of shapes) {
      const r = new DotRenderer(N, false);
      const ctx = ctxOf();
      const a = frame(r, ctx, shape, 0.9);
      const b = frame(r, ctx, shape, 2.3);
      let movedMoving = 0, moving = 0, movedFixed = 0;
      for (let i = 0; i < N; i++) {
        const d = Math.hypot(a.xs[i] - b.xs[i], a.ys[i] - b.ys[i]);
        if (shape.pts[i * POINT_STRIDE + 3] >= PART_STEP) { moving++; if (d > 0.5) movedMoving++; }
        else if (d !== 0) movedFixed++;
      }
      expect(movedFixed, shape.name).toBe(0);
      expect(moving, shape.name).toBeGreaterThan(0);
      // dots on a shaft axis hardly move; most of a rotor's dots do
      expect(movedMoving / moving, shape.name).toBeGreaterThan(0.5);
    }
  });

  it('spin 0 is the rest pose (reduced motion never advances spin): every dot is where the raw shape puts it', () => {
    const shape = shapes[2];
    const still = { ...shape, parts: [] as PartDef[], pts: shape.pts.map((v, i) => (i % POINT_STRIDE === 3 ? v & 3 : v)) };
    const at0 = frame(new DotRenderer(N, false), ctxOf(), shape, 0);
    const none = frame(new DotRenderer(N, false), ctxOf(), still as never, 0);
    for (let i = 0; i < N; i++) {
      expect(at0.xs[i]).toBeCloseTo(none.xs[i], 3);
      expect(at0.ys[i]).toBeCloseTo(none.ys[i], 3);
    }
  });

  it('the pose buffers are made once and reused: no allocation per frame', () => {
    const r = new DotRenderer(N, false);
    const priv = r as unknown as { poseA: Float32Array; poseB: Float32Array };
    const [pa, pb] = [priv.poseA, priv.poseB];
    expect(pa.length).toBe((MAX_PARTS + 1) * PART_STRIDE);
    const ctx = ctxOf();
    for (let f = 0; f < 4; f++) frame(r, ctx, shapes[3], f * 0.4);
    expect(priv.poseA).toBe(pa);
    expect(priv.poseB).toBe(pb);
    expect(ctx.createImageData).toHaveBeenCalledTimes(1);
  });
});
