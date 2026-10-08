import { describe, it, expect, vi } from 'vitest';
import {
  DEPTH_LEVELS,
  DotRenderer,
  EDGE_LIFT,
  GROUP_ARR,
  MINI_ALPHA,
  PLUNGER_PHASES,
  TONE,
  buildDotKernels,
  kernelIndex,
  toneMapPixel,
} from '../components/upload/machineDots';
import { BUF_CAP } from '../components/upload/machineOrbit';
import { buildShapes, makeCamera, mulberry32 } from '../components/upload/machineShapes';

const unpack = (w: number) => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255];

describe('ported constants', () => {
  it('tones, depth levels, group colours and plunger phases match the mockup', () => {
    expect(TONE.map((t) => [t.r, t.a, !!t.halo])).toEqual([
      [0.62, 0.34, false],
      [0.72, 0.48, false],
      [0.86, 0.62, false],
      [0.98, 0.6, true],
    ]);
    expect(DEPTH_LEVELS).toBe(5);
    expect(GROUP_ARR).toEqual([
      [110, 175, 255],
      [180, 150, 255],
      [255, 150, 80],
      [235, 240, 255],
    ]);
    expect(EDGE_LIFT).toBe(0.12);
    expect([...PLUNGER_PHASES]).toEqual([0, 2.094, 4.188]);
    expect(MINI_ALPHA).toBe(0.6);
  });
});

describe('dot stamps', () => {
  it('4 tones × 5 depths × 2×2 sub-pixel phases, all finite weights', () => {
    const k = buildDotKernels(1, false);
    expect(k.kern).toHaveLength(80);
    for (const K of k.kern) {
      expect(K.length % 3).toBe(0);
      expect(K.length).toBeGreaterThan(0);
      for (let t = 0; t < K.length; t += 3) {
        expect(Math.abs(K[t])).toBeLessThanOrEqual(k.kR);
        expect(Math.abs(K[t + 1])).toBeLessThanOrEqual(k.kR);
        expect(K[t + 2]).toBeGreaterThan(0.03);
        expect(Number.isFinite(K[t + 2])).toBe(true);
      }
    }
  });

  it('near dots are bigger and brighter than far ones; edge dots carry a halo', () => {
    const k = buildDotKernels(1.25, false);
    const sum = (K: Float32Array) => {
      let s = 0;
      for (let t = 2; t < K.length; t += 3) s += K[t];
      return s;
    };
    expect(sum(k.kern[kernelIndex(1, 0, 0, 0)])).toBeGreaterThan(sum(k.kern[kernelIndex(1, 4, 0, 0)]));
    expect(k.kern[kernelIndex(3, 0, 0, 0)].length).toBeGreaterThan(k.kern[kernelIndex(2, 0, 0, 0)].length);
  });

  it('mini stamps are fainter (alpha × 0.6)', () => {
    const hero = buildDotKernels(1, false);
    const mini = buildDotKernels(1, true);
    const peak = (K: Float32Array) => Math.max(...Array.from(K).filter((_, i) => i % 3 === 2));
    expect(peak(mini.kern[kernelIndex(0, 0, 0, 0)])).toBeLessThan(peak(hero.kern[kernelIndex(0, 0, 0, 0)]));
  });

  it('edge tone lifts 12 % toward white; the plunger colour is group 3', () => {
    const { cols } = buildDotKernels(1, false);
    const rgb = (col: number, tone: number) => Array.from(cols.slice((col * 4 + tone) * 3, (col * 4 + tone) * 3 + 3));
    expect(rgb(0, 0)).toEqual([110, 175, 255]);
    expect(rgb(0, 3)[0]).toBeCloseTo(110 + (255 - 110) * 0.12, 4);
    expect(rgb(3, 0)).toEqual([235, 240, 255]);
  });
});

describe('toneMapPixel (hue-preserving clamp)', () => {
  it('below 255: alpha = brightest channel, colour normalised to full brightness', () => {
    const [r, g, b, a] = unpack(toneMapPixel(55, 87.5, 127.5));
    expect(a).toBe(127);
    expect(b).toBe(255);
    expect(r / b).toBeCloseTo(55 / 127.5, 1);
    expect(g / b).toBeCloseTo(87.5 / 127.5, 1);
  });

  it('above 255: opaque, keeps the hue, leans slightly to white', () => {
    const m = 600;
    const [r, g, b, a] = unpack(toneMapPixel(300, 450, m));
    expect(a).toBe(255);
    expect(b).toBe(255);
    const s = (255 / m) * (1 + (m - 255) / (m * 2.2));
    expect(r).toBe(Math.floor(Math.min(255, 300 * s)));
    expect(g).toBe(Math.floor(Math.min(255, 450 * s)));
    expect(r).toBeLessThan(g); // ordering (hue) preserved
  });

  it('black stays transparent', () => {
    expect(toneMapPixel(0, 0, 0)).toBe(0);
  });
});

/** Recording 2D context with a working createImageData. */
function fakeCtx(withImageData = true) {
  const calls: Record<string, unknown[][]> = {};
  const rec = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const ctx = {
    save: rec('save'),
    restore: rec('restore'),
    setTransform: rec('setTransform'),
    drawImage: rec('drawImage'),
    putImageData: rec('putImageData'),
    globalCompositeOperation: 'source-over',
    createImageData: withImageData
      ? vi.fn((w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }))
      : undefined,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('DotRenderer', () => {
  const N = 6000;
  const shapes = buildShapes(N, mulberry32(7));
  const jit = new Float32Array(N * 3);
  const cam = makeCamera(-0.7, 0.32, 600, 280, Math.min(1200 * 0.17, 600 * 0.165));

  const withOffscreen = <T,>(ctx: CanvasRenderingContext2D, fn: () => T): T => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
    try {
      return fn();
    } finally {
      spy.mockRestore();
    }
  };

  it('draws a frame as one putImageData + one lighter drawImage, within the pixel budget', () => {
    const { ctx, calls } = fakeCtx();
    const r = new DotRenderer(N, false);
    const ok = withOffscreen(ctx, () => r.render(ctx, shapes[0], shapes[1], 0, 0, cam, 0, jit, 1200, 600, 1));
    expect(ok).toBe(true);
    expect(calls.putImageData).toHaveLength(1);
    expect(calls.drawImage).toHaveLength(1);
    expect(r.lastBuf).toBeGreaterThan(0);
    expect(r.lastBuf).toBeLessThanOrEqual(BUF_CAP);
    expect(r.lastScale).toBe(1);
  });

  it('reuses its buffers frame to frame (no per-frame ImageData allocation)', () => {
    const { ctx } = fakeCtx();
    const r = new DotRenderer(N, false);
    withOffscreen(ctx, () => {
      for (let f = 0; f < 5; f++) r.render(ctx, shapes[2], shapes[3], 0, 0, cam, f * 0.05, jit, 1200, 600, 1);
    });
    expect(ctx.createImageData).toHaveBeenCalledTimes(1);
  });

  it('caps the buffer pixel ratio at 1.25 on a HiDPI screen', () => {
    const { ctx } = fakeCtx();
    const r = new DotRenderer(N, false);
    const small = makeCamera(-0.7, 0.32, 300, 200, 60);
    withOffscreen(ctx, () => r.render(ctx, shapes[2], shapes[2], 0, 0, small, 0, jit, 600, 400, 2));
    expect(r.lastScale).toBe(1.25);
  });

  it('puts a non-empty, opaque-ish image into the buffer', () => {
    const { ctx } = fakeCtx();
    const r = new DotRenderer(N, false);
    withOffscreen(ctx, () => r.render(ctx, shapes[0], shapes[0], 0, 0, cam, 0, jit, 1200, 600, 1));
    const img = (ctx.createImageData as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as ImageData;
    let lit = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) lit++;
    expect(lit).toBeGreaterThan(1000);
  });

  it('stays within the pixel budget, padding included, at every size and pixel ratio where a step fits', () => {
    const { ctx } = fakeCtx();
    withOffscreen(ctx, () => {
      for (const sc of [60, 120, 160, 204, 240]) {
        for (const dpr of [1, 1.25, 1.5, 2]) {
          const r = new DotRenderer(N, false);
          r.render(ctx, shapes[0], shapes[0], 0, 0, makeCamera(-0.7, 0.32, 600, 300, sc), 0, jit, 1200, 600, dpr);
          if (r.lastScale > 0.65) expect(r.lastBuf, `sc ${sc} dpr ${dpr}`).toBeLessThanOrEqual(BUF_CAP);
        }
      }
    });
  });

  it('skips a particle with a NaN position instead of indexing the buffer with it', () => {
    const { ctx } = fakeCtx();
    const bad = new Float32Array(jit);
    bad[0] = NaN; // particle 0's x becomes NaN
    const r = new DotRenderer(N, false);
    const ok = withOffscreen(ctx, () => r.render(ctx, shapes[0], shapes[0], 0, 0, cam, 0, bad, 1200, 600, 1));
    expect(ok).toBe(true);
    expect(r.lastBuf).toBeGreaterThan(0); // the other 5,999 dots still drew
    const img = (ctx.createImageData as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as ImageData;
    let lit = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) lit++;
    expect(lit).toBeGreaterThan(1000);
  });

  it('skips the dot pass when createImageData is unavailable (jsdom)', () => {
    const { ctx, calls } = fakeCtx(false);
    const r = new DotRenderer(N, false);
    const ok = r.render(ctx, shapes[0], shapes[1], 0, 0, cam, 0, jit, 1200, 600, 1);
    expect(ok).toBe(false);
    expect(calls.putImageData).toBeUndefined();
    expect(calls.drawImage).toBeUndefined();
    expect(r.lastBuf).toBe(0);
  });
});
