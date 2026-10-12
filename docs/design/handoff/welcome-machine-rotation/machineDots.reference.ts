/**
 * The C6 dot renderer for `MachineMorphCanvas`: every dot adds light into ONE
 * pixel buffer (an ImageData covering the machine's bounding box, clipped to
 * the canvas), then the frame is handed to the browser as one `putImageData`
 * into an offscreen canvas + one `drawImage` with 'lighter' compositing.
 * Light adds up, so there is no depth sort and no angle shows a wrong overlap.
 *
 * Constants are ported from the approved mockup — don't re-derive them:
 * `docs/design/handoff/welcome-c6-orbit/machine-art-c6-orbit-reference.html`.
 *
 * Per-frame work allocates nothing once the buffers have grown to the largest
 * box seen: positions/keys live in typed arrays sized at construction, the
 * accumulation buffer and ImageData only ever grow, and the dot stamps are
 * cached per buffer scale.
 */
import {
  MAX_PARTS,
  PART_STEP,
  PART_STRIDE,
  POINT_STRIDE,
  SPIN_PER_SECOND,
  poseParts,
  type Camera,
  type MachineShape,
} from './machineShapes';
import { pickBufferScale } from './machineOrbit';

/** Dot tones: 0..2 = surface facing → grazing (rim light), 3 = edge dot (with halo). */
export const TONE: ReadonlyArray<{ r: number; a: number; halo?: boolean }> = [
  { r: 0.62, a: 0.34 },
  { r: 0.72, a: 0.48 },
  { r: 0.86, a: 0.62 },
  { r: 0.98, a: 0.6, halo: true },
];
/** Depth levels (near → far). */
export const DEPTH_LEVELS = 5;
/** Colours (`group & 3`): base metal, second body, hot section / volute (orange, accepted exception), plunger. */
export const GROUP_ARR: ReadonlyArray<readonly [number, number, number]> = [
  [110, 175, 255],
  [180, 150, 255],
  [255, 150, 80],
  [235, 240, 255],
];
/** Tone 3 (edges) lifts this far toward white. */
export const EDGE_LIFT = 0.12;
/** Mini variant: tone alphas × 0.6 (on top of the wrapper's opacity 0.45), dots × 0.75. */
export const MINI_ALPHA = 0.6;
export const MINI_SIZE = 0.75;
/** Plunger stroke and phases now live with the other moving parts in `machineShapes.ts`. */
export { PLUNGER_AMP, PLUNGER_PHASES } from './machineShapes';

export interface DotKernels {
  /** One stamp per (tone, depth, sub-pixel x, sub-pixel y): flat (dx, dy, weight) triples. */
  kern: Float32Array[];
  /** Largest stamp radius in buffer px. */
  kR: number;
  /** RGB per (group colour × tone), flat. */
  cols: Float32Array;
}

/** Index of a stamp in `DotKernels.kern`. */
export const kernelIndex = (tone: number, lv: number, px: number, py: number) => ((tone * DEPTH_LEVELS + lv) * 2 + px) * 2 + py;

/** Build the soft round dot stamps for buffer scale `d`: 4 tones × 5 depths × 2×2 sub-pixel phases. */
export function buildDotKernels(d: number, mini: boolean): DotKernels {
  const kern: Float32Array[] = [];
  let kR = 0;
  const am0 = mini ? MINI_ALPHA : 1;
  const sm0 = mini ? MINI_SIZE : 1;
  for (let tone = 0; tone < TONE.length; tone++) {
    for (let lv = 0; lv < DEPTH_LEVELS; lv++) {
      for (let px = 0; px < 2; px++) {
        for (let py = 0; py < 2; py++) {
          const T = TONE[tone];
          const sm = (1.22 - lv * 0.13) * sm0;
          const am = (1 - lv * 0.15) * am0;
          const rad = Math.max(0.55, T.r * sm * d);
          const a = T.a * am;
          const ext = T.halo ? rad * 2 : rad + 1;
          const R = Math.ceil(ext) + 1;
          const taps: number[] = [];
          const ox = px * 0.5;
          const oy = py * 0.5;
          for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
              const dist = Math.hypot(dx - ox, dy - oy);
              let w = dist <= rad - 0.5 ? 1 : dist < rad + 0.5 ? rad + 0.5 - dist : 0;
              w *= a;
              if (T.halo) {
                const u = dist / (rad * 1.3);
                w += a * 0.22 * Math.exp(-u * u);
              }
              if (w > 0.03) taps.push(dx, dy, w);
            }
          }
          kern[kernelIndex(tone, lv, px, py)] = new Float32Array(taps);
          if (R > kR) kR = R;
        }
      }
    }
  }
  const cols = new Float32Array(GROUP_ARR.length * TONE.length * 3);
  let o = 0;
  for (let col = 0; col < GROUP_ARR.length; col++) {
    for (let tone = 0; tone < TONE.length; tone++) {
      let [R, G, B] = GROUP_ARR[col];
      if (tone === 3) {
        R += (255 - R) * EDGE_LIFT;
        G += (255 - G) * EDGE_LIFT;
        B += (255 - B) * EDGE_LIFT;
      }
      cols[o++] = R;
      cols[o++] = G;
      cols[o++] = B;
    }
  }
  return { kern, kR, cols };
}

/**
 * Tone-map one accumulated pixel to a packed little-endian RGBA word (as
 * written through a Uint32Array view of ImageData). Hue-preserving clamp: when
 * the brightest channel `m` passes 255, every channel is scaled by
 * `255/m × (1 + (m−255)/(m×2.2))` so bright spots keep their hue and lean only
 * slightly to white. Alpha = the brightest channel (capped at 255).
 */
export function toneMapPixel(r: number, g: number, b: number): number {
  const m = r > g ? (r > b ? r : b) : g > b ? g : b;
  if (m <= 0) return 0;
  let a = m;
  let s = 255 / m;
  if (m > 255) {
    a = 255;
    s = (255 / m) * (1 + (m - 255) / (m * 2.2));
  }
  r *= s;
  g *= s;
  b *= s;
  if (r > 255) r = 255;
  if (g > 255) g = 255;
  if (b > 255) b = 255;
  return (((a | 0) << 24) | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0)) >>> 0;
}

/** Below this summed light a buffer pixel stays transparent. */
const DARK_CUTOFF = 1.5;

export class DotRenderer {
  readonly n: number;
  readonly mini: boolean;
  /** Pixels in the last frame's buffer (0 = dot pass skipped). */
  lastBuf = 0;
  /** Buffer scale used for the last frame. */
  lastScale = 0;
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private readonly keys: Uint8Array;
  private acc: Float32Array | null = null;
  private img: ImageData | null = null;
  private d32: Uint32Array | null = null;
  private off: HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | null = null;
  private readonly kernCache = new Map<number, DotKernels>();
  /** This frame's part poses for machine A and machine B (3×4 per part, slot 0 unused). */
  private readonly poseA = new Float32Array((MAX_PARTS + 1) * PART_STRIDE);
  private readonly poseB = new Float32Array((MAX_PARTS + 1) * PART_STRIDE);

  constructor(n: number, mini: boolean) {
    this.n = n;
    this.mini = mini;
    this.xs = new Float32Array(n);
    this.ys = new Float32Array(n);
    this.keys = new Uint8Array(n);
  }

  kernels(d: number): DotKernels {
    let k = this.kernCache.get(d);
    if (!k) {
      k = buildDotKernels(d, this.mini);
      this.kernCache.set(d, k);
    }
    return k;
  }

  /** Make sure the ImageData / offscreen canvas can hold bw×bh. False when the platform can't (jsdom). */
  private ensureImage(ctx: CanvasRenderingContext2D, bw: number, bh: number): boolean {
    if (this.img && this.offCtx && this.img.width >= bw && this.img.height >= bh) return true;
    if (typeof ctx.createImageData !== 'function' || typeof document === 'undefined') return false;
    const iw = Math.max(bw, this.img ? this.img.width : 0);
    const ih = Math.max(bh, this.img ? this.img.height : 0);
    const img = ctx.createImageData(iw, ih);
    if (!img || !img.data || !img.data.buffer) return false;
    if (!this.off) this.off = document.createElement('canvas');
    this.off.width = iw;
    this.off.height = ih;
    this.offCtx = this.off.getContext('2d');
    if (!this.offCtx) return false;
    this.img = img;
    this.d32 = new Uint32Array(img.data.buffer);
    return true;
  }

  /**
   * Draw machine A morphing into B (`e` = eased progress, `burst` = dust
   * scatter) into `ctx` (whose transform is CSS px × dpr). `jit` holds three
   * per-particle jitter values in [-0.5, 0.5). Returns false when the dot pass
   * was skipped (e.g. no ImageData support).
   */
  render(
    ctx: CanvasRenderingContext2D,
    A: MachineShape,
    B: MachineShape,
    e: number,
    burst: number,
    cam: Camera,
    spin: number,
    jit: Float32Array,
    W: number,
    H: number,
    dpr: number,
  ): boolean {
    const N = this.n;
    const S = POINT_STRIDE;
    const pa = A.pts;
    const pb = B.pts;
    const xs = this.xs;
    const ys = this.ys;
    const keys = this.keys;
    // Moving parts: one small matrix per part per frame (a few sin/cos), then
    // applied inside the loop below to that part's points only. `spin` does not
    // advance under reduced motion, so every part then stays in its rest pose.
    const MA = this.poseA;
    const MB = this.poseB;
    const sec = spin / SPIN_PER_SECOND;
    poseParts(A.parts, sec, MA);
    poseParts(B.parts, sec, MB);
    const { cyw, syw, cp, sp, cx, cy, sc } = cam;
    // View direction in model space, for the rim light.
    const vx = -syw * cp;
    const vy = sp;
    const vz = cyw * cp;
    const useB = e >= 0.5;
    const MQ = useB ? MB : MA;
    const bj = burst * 1.7;
    const dust = burst > 0.35;
    let mnx = 1e9;
    let mny = 1e9;
    let mxx = -1e9;
    let mxy = -1e9;

    // 1) project in CSS px; depth level, rim light and colour from the current camera
    for (let i = 0; i < N; i++) {
      const o = i * S;
      const ga = pa[o + 3];
      const gb = pb[o + 3];
      let xa = pa[o];
      let ya = pa[o + 1];
      let za = pa[o + 2];
      if (ga >= PART_STEP) {
        const m = (ga >> 2) * PART_STRIDE;
        const px = xa;
        const py = ya;
        xa = MA[m] * px + MA[m + 1] * py + MA[m + 2] * za + MA[m + 3];
        ya = MA[m + 4] * px + MA[m + 5] * py + MA[m + 6] * za + MA[m + 7];
        za = MA[m + 8] * px + MA[m + 9] * py + MA[m + 10] * za + MA[m + 11];
      }
      let xb = pb[o];
      let yb = pb[o + 1];
      let zb = pb[o + 2];
      if (gb >= PART_STEP) {
        const m = (gb >> 2) * PART_STRIDE;
        const px = xb;
        const py = yb;
        xb = MB[m] * px + MB[m + 1] * py + MB[m + 2] * zb + MB[m + 3];
        yb = MB[m + 4] * px + MB[m + 5] * py + MB[m + 6] * zb + MB[m + 7];
        zb = MB[m + 8] * px + MB[m + 9] * py + MB[m + 10] * zb + MB[m + 11];
      }
      const j = i * 3;
      const x = xa + (xb - xa) * e + jit[j] * bj;
      const y = ya + (yb - ya) * e + jit[j + 1] * bj;
      const z = za + (zb - za) * e + jit[j + 2] * bj;
      const x1 = x * cyw + z * syw;
      const z1 = -x * syw + z * cyw;
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      const k = (12 / (12 + z2)) * sc;
      const X = cx + x1 * k;
      const Y = cy - y2 * k;
      xs[i] = X;
      ys[i] = Y;
      if (X < mnx) mnx = X;
      if (X > mxx) mxx = X;
      if (Y < mny) mny = Y;
      if (Y > mxy) mxy = Y;
      const q = useB ? pb : pa;
      const g = q[o + 3];
      let tone: number;
      if (dust) tone = 1;
      else if (q[o + 4] > 0.5) tone = 3;
      else {
        let nx = q[o + 5];
        let ny = q[o + 6];
        let nz = q[o + 7];
        if (g >= PART_STEP) {
          // The normal turns with its part, so the rim light stays where the camera sees it.
          const m = (g >> 2) * PART_STRIDE;
          const ax = nx;
          const ay = ny;
          nx = MQ[m] * ax + MQ[m + 1] * ay + MQ[m + 2] * nz;
          ny = MQ[m + 4] * ax + MQ[m + 5] * ay + MQ[m + 6] * nz;
          nz = MQ[m + 8] * ax + MQ[m + 9] * ay + MQ[m + 10] * nz;
        }
        const f = 1 - Math.abs(nx * vx + ny * vy + nz * vz);
        tone = f > 0.8 ? 2 : f > 0.4 ? 1 : 0;
      }
      let lv = (z2 + 2.5) | 0;
      lv = lv < 0 ? 0 : lv > 4 ? 4 : lv;
      keys[i] = ((g & 3) * 4 + tone) * DEPTH_LEVELS + lv;
    }

    // 2) clip the box to the canvas, then pick the buffer scale
    mnx = Math.max(mnx, -4);
    mny = Math.max(mny, -4);
    mxx = Math.min(mxx, W + 4);
    mxy = Math.min(mxy, H + 4);
    if (mxx <= mnx || mxy <= mny) {
      this.lastBuf = 0;
      return true; // machine entirely off-canvas: nothing to draw
    }
    // The budget counts the stamp padding too, so the real buffer stays within BUF_CAP.
    const d = pickBufferScale(mxx - mnx, mxy - mny, dpr, (s) => this.kernels(s).kR + 2);
    const { kern, kR: R, cols } = this.kernels(d);
    const pad = R + 2;
    const bx = Math.floor(mnx * d) - pad;
    const by = Math.floor(mny * d) - pad;
    const bw = Math.ceil(mxx * d) + pad - bx;
    const bh = Math.ceil(mxy * d) + pad - by;
    if (bw <= 0 || bh <= 0) return true;
    if (!this.ensureImage(ctx, bw, bh)) {
      this.lastBuf = 0;
      return false;
    }
    const npx = bw * bh;
    this.lastBuf = npx;
    this.lastScale = d;
    if (!this.acc || this.acc.length < npx * 3) this.acc = new Float32Array(Math.ceil(npx * 3 * 1.3));
    const acc = this.acc;
    acc.fill(0, 0, npx * 3);

    // 3) add every dot's light into the buffer (order-free, so no depth sort)
    for (let i = 0; i < N; i++) {
      const X = xs[i] * d - bx - 0.5;
      const Y = ys[i] * d - by - 0.5;
      let ix = Math.floor(X);
      let iy = Math.floor(Y);
      const fx = X - ix;
      const fy = Y - iy;
      let px = 0;
      let py = 0;
      if (fx >= 0.75) ix++;
      else if (fx >= 0.25) px = 1;
      if (fy >= 0.75) iy++;
      else if (fy >= 0.25) py = 1;
      // Written so a NaN position (bad input) is skipped instead of indexing the buffer.
      if (!(ix >= R && iy >= R && ix < bw - R && iy < bh - R)) continue;
      const key = keys[i];
      const lv = key % DEPTH_LEVELS;
      const ct = (key / DEPTH_LEVELS) | 0;
      const tone = ct % 4;
      const K = kern[kernelIndex(tone, lv, px, py)];
      const c3 = ct * 3;
      const cr = cols[c3];
      const cg = cols[c3 + 1];
      const cb = cols[c3 + 2];
      for (let t = 0; t < K.length; t += 3) {
        const p = ((iy + K[t + 1]) * bw + ix + K[t]) * 3;
        const w = K[t + 2];
        acc[p] += cr * w;
        acc[p + 1] += cg * w;
        acc[p + 2] += cb * w;
      }
    }

    // 4) tone-map to RGBA and hand the browser one image
    const img = this.img as ImageData;
    const d32 = this.d32 as Uint32Array;
    const iw = img.width;
    for (let yy = 0; yy < bh; yy++) {
      let p = yy * bw * 3;
      let q = yy * iw;
      for (let xx = 0; xx < bw; xx++, p += 3, q++) {
        const r = acc[p];
        const g = acc[p + 1];
        const b = acc[p + 2];
        d32[q] = r + g + b < DARK_CUTOFF ? 0 : toneMapPixel(r, g, b);
      }
    }
    const offCtx = this.offCtx as CanvasRenderingContext2D;
    offCtx.putImageData(img, 0, 0, 0, 0, bw, bh);
    const up = dpr / d;
    ctx.save();
    ctx.setTransform(up, 0, 0, up, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.off as HTMLCanvasElement, 0, 0, bw, bh, bx, by, bw, bh);
    ctx.restore();
    return true;
  }
}
