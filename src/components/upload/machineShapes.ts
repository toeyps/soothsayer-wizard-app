/**
 * Pure helpers for `MachineMorphCanvas` (the animated machine illustration on
 * the Import "Get started" page). No DOM here so everything is unit-testable.
 *
 * Ported from the approved "C6" mockup (`docs/design/handoff/welcome-c6-orbit/`,
 * `buildShapesC`). Each machine is a cloud of points sampled from simple solids
 * (rings, seams, shells, discs, boxes, bolt circles, bodies of revolution,
 * spiral casings). Dot placement is edge-weighted: rims, seams, box edges and
 * bolt rings get most of the dots, surfaces stay sparse. All six clouds are
 * resampled to the SAME particle count so particle `i` can travel from machine
 * A's point `i` to machine B's point `i` while the cloud dissolves and re-forms.
 *
 * Point layout is a flat Float32Array, stride 8 (`POINT_STRIDE`):
 *   x, y, z, group, edge, nx, ny, nz
 *   group 0   = base metal (blue)
 *   group 1   = second body colour (violet)
 *   group 2   = hot section / volute (orange — an accepted, user-approved
 *               exception to "warn hue only for state")
 *   group 10+ = reciprocating-pump plunger k = group - 10 (moves back and forth)
 *   edge      = 1 for rim / seam / edge / bolt dots (drawn brighter), else 0
 *   n         = surface normal (0,0,0 for edge dots); gives the rim light
 */

export type Rng = () => number;
export type Vec3 = [number, number, number];

export const MACHINE_NAMES = [
  'Gas turbine generator',
  'Gas turbine compressor',
  'Motor',
  'Reciprocating pump',
  'Can pump',
  'Turbo expander',
] as const;
export type MachineName = (typeof MACHINE_NAMES)[number];

/** Seconds a machine stays fully formed. */
export const HOLD_SECONDS = 4.6;
/** Seconds the cloud takes to dissolve and re-form into the next machine. */
export const TRANSITION_SECONDS = 1.8;

export const HERO_PARTICLES = 6000;
export const MINI_PARTICLES = 2400;

/** Floats per particle: x y z group edge nx ny nz. */
export const POINT_STRIDE = 8;

/** Dots per unit length on edges (before resampling). */
export const DE = 150;
/** Dots per unit area on surfaces (before resampling). */
export const DS = 46;

export const TAU = Math.PI * 2;

/** mulberry32 plus a read-out of its internal state (`mulberry32(state())` continues the same sequence). */
function mulberry32WithState(seed: number): { next: Rng; state: () => number } {
  let a = seed | 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, state: () => a };
}

/** Small deterministic PRNG (the mockup's seed source), values in [0, 1). */
export function mulberry32(seed: number): Rng {
  return mulberry32WithState(seed).next;
}

/** A simulated sensor pinned to a spot on a machine. */
export interface SensorDef {
  /** Position in the normalised machine space (after fitting to ±2). */
  p: Vec3;
  name: string;
  unit: string;
  /** Nominal reading. */
  v: number;
  /** Noise scale. */
  s: number;
  /** True for the sensor that drifts upward until it shows "● ABNORMAL". */
  trend?: boolean;
}

export interface MachineShape {
  name: MachineName;
  /** Number of particles (pts.length / POINT_STRIDE). */
  count: number;
  /** Flat stride-8 particle data (see the file header). */
  pts: Float32Array;
  /** Points the machine was sampled with before resampling to `count`. */
  rawCount: number;
  /** Share of the raw points that are edge dots (0..1). */
  edgeRatio: number;
  sensors: SensorDef[];
}

/* ------------------------------------------------------------------ */
/* Point sampler (C6)                                                  */
/* ------------------------------------------------------------------ */

export type Axis = 'x' | 'y' | 'z';

export interface CylOpts {
  /** Surface (skin) density factor. */
  k?: number;
  /** Edge (rim/band/seam) density factor. */
  ek?: number;
  /** Rings along the length. */
  bands?: number;
  /** Seam lines along the length. */
  lines?: number;
  /** End-cap disc density factor (0 = open). */
  caps?: number;
}

export interface BoxOpts {
  k?: number;
  ek?: number;
}

export interface Sampler {
  /** Flat stride-8 raw points. */
  pts: number[];
  add(x: number, y: number, z: number, g: number, e: number, nx: number, ny: number, nz: number): void;
  ring(ax: Axis, c: Vec3, r: number, g?: number, k?: number, t?: number): void;
  seg(p: Vec3, q: Vec3, g?: number, k?: number): void;
  shell(ax: Axis, c: Vec3, r: number, len: number, g?: number, k?: number): void;
  disc(ax: Axis, c: Vec3, r0: number, r1: number, g?: number, k?: number, edge?: number): void;
  cyl(ax: Axis, c: Vec3, r: number, len: number, g?: number, o?: CylOpts): void;
  box(c: Vec3, sz: Vec3, g?: number, o?: BoxOpts): void;
  bolts(ax: Axis, c: Vec3, R: number, cnt: number, br: number, g?: number, a0?: number): void;
  flange(ax: Axis, c: Vec3, r0: number, r1: number, cnt: number, g?: number, k?: number): void;
  rev(prof: ReadonlyArray<readonly [number, number]>, gOf: (x: number) => number, k?: number, bandXs?: number[], ek?: number, seams?: number): void;
  vol(c: Vec3, R0: number, R1: number, t0: number, t1: number, g?: number, k?: number): void;
}

/** Number of dots `ring` places for radius `r` and density factor `k`. */
export const ringCount = (r: number, k = 1) => Math.max(8, Math.round(TAU * r * DE * k));
/** Number of dots `seg` places for a segment of length `L`. */
export const segCount = (L: number, k = 1) => Math.max(4, Math.round(L * DE * k));

export function makeSampler(rr: Rng): Sampler {
  const pts: number[] = [];
  const add = (x: number, y: number, z: number, g: number, e: number, nx: number, ny: number, nz: number) => {
    pts.push(x, y, z, g, e, nx, ny, nz);
  };
  // local (t along axis, u, v) -> world for axis ax
  const put = (ax: Axis, c: Vec3, t: number, u: number, v: number, g: number, e: number, nt: number, nu: number, nv: number) => {
    if (ax === 'x') add(c[0] + t, c[1] + u, c[2] + v, g, e, nt, nu, nv);
    else if (ax === 'y') add(c[0] + u, c[1] + t, c[2] + v, g, e, nu, nt, nv);
    else add(c[0] + u, c[1] + v, c[2] + t, g, e, nu, nv, nt);
  };
  const s: Sampler = {
    pts,
    add,
    ring(ax, c, r, g = 0, k = 1, t = 0) {
      const n = ringCount(r, k);
      for (let i = 0; i < n; i++) {
        const a = ((i + rr()) / n) * TAU;
        put(ax, c, t, Math.cos(a) * r, Math.sin(a) * r, g, 1, 0, 0, 0);
      }
    },
    seg(p, q, g = 0, k = 1) {
      const L = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      const n = segCount(L, k);
      for (let i = 0; i < n; i++) {
        const t = (i + rr()) / n;
        add(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, g, 1, 0, 0, 0);
      }
    },
    shell(ax, c, r, len, g = 0, k = 1) {
      const n = Math.round(TAU * r * len * DS * k);
      for (let i = 0; i < n; i++) {
        const a = rr() * TAU;
        const t = (rr() - 0.5) * len;
        const cu = Math.cos(a);
        const sv = Math.sin(a);
        put(ax, c, t, cu * r, sv * r, g, 0, 0, cu, sv);
      }
    },
    disc(ax, c, r0, r1, g = 0, k = 1, edge = 1) {
      const n = Math.round(Math.PI * (r1 * r1 - r0 * r0) * DS * k);
      for (let i = 0; i < n; i++) {
        const r = Math.sqrt(r0 * r0 + rr() * (r1 * r1 - r0 * r0));
        const a = rr() * TAU;
        put(ax, c, 0, Math.cos(a) * r, Math.sin(a) * r, g, 0, 1, 0, 0);
      }
      if (edge) {
        s.ring(ax, c, r1, g, edge);
        if (r0 > 0.05) s.ring(ax, c, r0, g, edge * 0.8);
      }
    },
    // cylinder: sparse skin, bright rims, optional bands (rings along) and seam lines
    cyl(ax, c, r, len, g = 0, o = {}) {
      const { k = 1, ek = 1, bands = 0, lines = 0, caps = 0 } = o;
      s.shell(ax, c, r, len, g, k);
      s.ring(ax, c, r, g, ek, -len / 2);
      s.ring(ax, c, r, g, ek, len / 2);
      for (let b = 1; b <= bands; b++) s.ring(ax, c, r * 1.01, g, ek * 0.7, -len / 2 + (len * b) / (bands + 1));
      for (let l = 0; l < lines; l++) {
        const a = (l / lines) * TAU + 0.2;
        const m = Math.max(4, Math.round(len * DE * ek * 0.6));
        for (let i = 0; i < m; i++) put(ax, c, ((i + rr()) / m - 0.5) * len, Math.cos(a) * r, Math.sin(a) * r, g, 1, 0, 0, 0);
      }
      if (caps) {
        const off: Vec3 = ax === 'x' ? [len / 2, 0, 0] : ax === 'y' ? [0, len / 2, 0] : [0, 0, len / 2];
        s.disc(ax, [c[0] + off[0], c[1] + off[1], c[2] + off[2]], 0, r, g, caps, 0);
        s.disc(ax, [c[0] - off[0], c[1] - off[1], c[2] - off[2]], 0, r, g, caps, 0);
      }
    },
    // box: 12 bright edges + sparse faces
    box(c, sz, g = 0, o = {}) {
      const { k = 1, ek = 1 } = o;
      const h = [sz[0] / 2, sz[1] / 2, sz[2] / 2];
      for (let ax = 0; ax < 3; ax++) {
        const a1 = (ax + 1) % 3;
        const a2 = (ax + 2) % 3;
        for (const s1 of [-1, 1]) {
          for (const s2 of [-1, 1]) {
            const p: Vec3 = [0, 0, 0];
            const q: Vec3 = [0, 0, 0];
            p[ax] = c[ax] - h[ax];
            q[ax] = c[ax] + h[ax];
            p[a1] = q[a1] = c[a1] + s1 * h[a1];
            p[a2] = q[a2] = c[a2] + s2 * h[a2];
            s.seg(p, q, g, ek);
          }
        }
      }
      for (let ax = 0; ax < 3; ax++) {
        const a1 = (ax + 1) % 3;
        const a2 = (ax + 2) % 3;
        const m = Math.round(sz[a1] * sz[a2] * DS * k);
        for (const sg of [-1, 1]) {
          for (let i = 0; i < m; i++) {
            const p: Vec3 = [0, 0, 0];
            const nn: Vec3 = [0, 0, 0];
            p[ax] = c[ax] + sg * h[ax];
            p[a1] = c[a1] + (rr() - 0.5) * sz[a1];
            p[a2] = c[a2] + (rr() - 0.5) * sz[a2];
            nn[ax] = sg;
            add(p[0], p[1], p[2], g, 0, nn[0], nn[1], nn[2]);
          }
        }
      }
    },
    // bolt circle on a face perpendicular to ax
    bolts(ax, c, R, cnt, br, g = 0, a0 = 0) {
      for (let b = 0; b < cnt; b++) {
        const a = a0 + (b / cnt) * TAU;
        const cu = Math.cos(a) * R;
        const cv = Math.sin(a) * R;
        const m = Math.max(7, Math.round(TAU * br * DE * 1.6));
        for (let i = 0; i < m; i++) {
          const q = ((i + rr()) / m) * TAU;
          put(ax, c, 0, cu + Math.cos(q) * br, cv + Math.sin(q) * br, g, 1, 0, 0, 0);
        }
      }
    },
    flange(ax, c, r0, r1, cnt, g = 0, k = 0.8) {
      s.disc(ax, c, r0, r1, g, k);
      s.bolts(ax, c, (r0 + r1) / 2, cnt, Math.min(0.05, (r1 - r0) * 0.18), g);
    },
    // body of revolution from a profile table [[x, r], ...] along x
    rev(prof, gOf, k = 1, bandXs = [], ek = 1, seams = 0) {
      const x0 = prof[0][0];
      const x1 = prof[prof.length - 1][0];
      const R = (x: number) => {
        for (let i = 1; i < prof.length; i++) {
          if (x <= prof[i][0]) {
            const a = prof[i - 1];
            const b = prof[i];
            return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
          }
        }
        return prof[prof.length - 1][1];
      };
      let area = 0;
      for (let i = 1; i < prof.length; i++) area += ((TAU * (prof[i][1] + prof[i - 1][1])) / 2) * (prof[i][0] - prof[i - 1][0]);
      const n = Math.round(area * DS * k);
      for (let i = 0; i < n; i++) {
        const x = x0 + rr() * (x1 - x0);
        const a = rr() * TAU;
        const r = R(x);
        add(x, Math.cos(a) * r, Math.sin(a) * r, gOf(x), 0, 0, Math.cos(a), Math.sin(a));
      }
      for (const p of prof) s.ring('x', [p[0], 0, 0], p[1], gOf(p[0]), ek);
      for (const bx of bandXs) s.ring('x', [bx, 0, 0], R(bx) * 1.01, gOf(bx), ek * 0.65);
      for (let l = 0; l < seams; l++) {
        const a = (l / seams) * TAU;
        const m = Math.round((x1 - x0) * DE * 0.8);
        for (let i = 0; i < m; i++) {
          const x = x0 + ((i + rr()) / m) * (x1 - x0);
          const r = R(x) * 1.01;
          add(x, Math.cos(a) * r, Math.sin(a) * r, gOf(x), 1, 0, 0, 0);
        }
      }
    },
    // spiral casing around x
    vol(c, R0, R1, t0, t1, g = 0, k = 1) {
      const area = ((TAU * (R0 + R1)) / 2) * ((TAU * (t0 + t1)) / 2) * 0.93;
      const n = Math.round(area * DS * k);
      for (let i = 0; i < n; i++) {
        const th = rr() * TAU * 0.93;
        const R = R0 + ((R1 - R0) * th) / TAU;
        const tr = t0 + ((t1 - t0) * th) / TAU;
        const a = rr() * TAU;
        add(
          c[0] + Math.sin(a) * tr,
          c[1] + Math.cos(th) * (R + Math.cos(a) * tr),
          c[2] + Math.sin(th) * (R + Math.cos(a) * tr),
          g, 0,
          Math.sin(a), Math.cos(th) * Math.cos(a), Math.sin(th) * Math.cos(a),
        );
      }
      // parting lines (outer + both sides) + cross-section rings
      for (const a of [0, Math.PI / 2, -Math.PI / 2]) {
        const m = Math.round(TAU * R1 * DE * 0.8);
        for (let i = 0; i < m; i++) {
          const th = ((i + rr()) / m) * TAU * 0.93;
          const R = R0 + ((R1 - R0) * th) / TAU;
          const tr = t0 + ((t1 - t0) * th) / TAU;
          add(c[0] + Math.sin(a) * tr, c[1] + Math.cos(th) * (R + Math.cos(a) * tr), c[2] + Math.sin(th) * (R + Math.cos(a) * tr), g, 1, 0, 0, 0);
        }
      }
      for (let q = 1; q <= 5; q++) {
        const th = (q / 6) * TAU * 0.93;
        const R = R0 + ((R1 - R0) * th) / TAU;
        const tr = t0 + ((t1 - t0) * th) / TAU;
        const m = Math.round(TAU * tr * DE * 0.9);
        for (let i = 0; i < m; i++) {
          const a = ((i + rr()) / m) * TAU;
          add(c[0] + Math.sin(a) * tr, c[1] + Math.cos(th) * (R + Math.cos(a) * tr), c[2] + Math.sin(th) * (R + Math.cos(a) * tr), g, 1, 0, 0, 0);
        }
      }
    },
  };
  return s;
}

/* ------------------------------------------------------------------ */
/* The six machines                                                    */
/* ------------------------------------------------------------------ */

interface RawShape {
  name: MachineName;
  pts: number[];
  sens: SensorDef[];
}

function sens(p: Vec3, name: string, unit: string, v: number, s: number, trend = false): SensorDef {
  return { p, name, unit, v, s, trend };
}

/** The raw (un-fitted, un-resampled) C6 point clouds, in `MACHINE_NAMES` order. */
export function buildRawShapes(rr: Rng): RawShape[] {
  const raw: RawShape[] = [];

  // ---------------- Gas turbine generator ----------------
  {
    const s = makeSampler(rr);
    const GT: Array<[number, number]> = [[-3.6, 1.3], [-3.3, 1.0], [-1.3, 0.9], [-1.05, 1.05], [0.15, 1.05], [0.35, 1.16], [0.5, 1.16]];
    s.rev(GT, (x) => (x > -1.05 && x < 0.4 ? 2 : 0), 0.8, [-2.9, -2.5, -2.1, -1.7], 1, 2);
    s.disc('x', [-3.6, 0, 0], 0.3, 1.3, 0, 0.25); // bellmouth face
    s.cyl('x', [-3.75, 0, 0], 0.3, 0.3, 0, { k: 0.5 }); // inlet hub
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + 0.2;
      s.cyl('x', [-0.62, Math.cos(a) * 1.2, Math.sin(a) * 1.2], 0.12, 0.62, 2, { k: 0.6, ek: 0.8 }); // combustor cans
    }
    s.box([0.85, 0, 0], [0.7, 2.6, 2.4], 0, { k: 0.25 }); // exhaust collector
    s.cyl('y', [0.85, 1.9, 0], 0.52, 1.3, 0, { k: 0.5, lines: 6 }); // exhaust stack
    s.ring('y', [0.85, 2.55, 0], 0.58, 0, 0.8);
    s.cyl('x', [1.45, 0, 0], 0.15, 0.5, 0, { k: 0.6 }); // shaft
    s.cyl('x', [1.45, 0, 0], 0.36, 0.42, 0, { k: 0.25, ek: 0.6 }); // coupling guard
    s.cyl('x', [2.6, 0, 0], 1.0, 1.9, 1, { k: 0.45, bands: 3, lines: 4 }); // generator
    s.flange('x', [1.65, 0, 0], 0.25, 1.02, 12, 1, 0.35);
    s.flange('x', [3.55, 0, 0], 0.25, 1.02, 12, 1, 0.35);
    s.box([2.6, 1.3, 0], [1.5, 0.32, 1.1], 1, { k: 0.4 }); // air cooler on top
    for (let k = 0; k < 6; k++) s.seg([1.95 + k * 0.26, 1.47, -0.55], [1.95 + k * 0.26, 1.47, 0.55], 1, 0.6);
    s.box([3.2, 0.1, 1.05], [0.45, 0.5, 0.18], 1, { k: 0.5 }); // terminal box
    s.cyl('x', [3.75, 0, 0], 0.12, 0.4, 0, { k: 0.6 }); // shaft NDE
    s.box([1.45, -0.75, 0], [0.35, 0.7, 0.6], 0, { k: 0.4 }); // bearing pedestals
    s.box([3.75, -0.75, 0], [0.35, 0.7, 0.6], 0, { k: 0.4 });
    s.box([0.1, -1.2, 0], [7.9, 0.12, 2.7], 0, { k: 0.12, ek: 0.55 }); // skid
    raw.push({
      name: 'Gas turbine generator',
      pts: s.pts,
      sens: [
        sens([0.85, 1.3, 0.6], 'Exhaust gas temperature', '°C', 548, 2, true),
        sens([2.6, 1.46, 0], 'Active power', 'MW', 7.9, 0.03),
      ],
    });
  }

  // ---------------- Gas turbine compressor ----------------
  {
    const s = makeSampler(rr);
    const GT: Array<[number, number]> = [[-3.4, 1.2], [-3.1, 0.95], [-1.5, 0.87], [-1.25, 1.0], [-0.2, 1.0], [0, 1.1], [0.15, 1.1]];
    s.rev(GT, (x) => (x > -1.25 && x < 0 ? 2 : 0), 0.8, [-2.7, -2.3, -1.9], 1, 2);
    s.disc('x', [-3.4, 0, 0], 0.28, 1.2, 0, 0.25);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.3;
      s.cyl('x', [-0.75, Math.cos(a) * 1.12, Math.sin(a) * 1.12], 0.11, 0.55, 2, { k: 0.6, ek: 0.8 }); // combustor cans
    }
    s.box([0.45, 0, 0], [0.6, 2.3, 2.2], 0, { k: 0.25 }); // exhaust collector
    s.cyl('z', [0.45, 0.35, 1.45], 0.42, 0.6, 0, { k: 0.4 }); // side exhaust duct
    s.cyl('x', [1.1, 0, 0], 0.15, 0.7, 0, { k: 0.6 });
    s.cyl('x', [1.1, 0, 0], 0.32, 0.45, 0, { k: 0.25, ek: 0.6 }); // coupling guard
    s.cyl('x', [2.4, 0, 0], 0.85, 1.6, 1, { k: 0.5, bands: 2, lines: 2 }); // barrel
    s.flange('x', [1.6, 0, 0], 0.25, 0.98, 16, 1, 0.4);
    s.flange('x', [3.2, 0, 0], 0.25, 0.98, 16, 1, 0.4);
    s.cyl('x', [1.45, 0, 0], 0.3, 0.2, 1, { k: 0.5 }); // bearing housings
    s.cyl('x', [3.38, 0, 0], 0.3, 0.25, 1, { k: 0.5 });
    s.cyl('y', [1.95, 1.15, 0], 0.28, 0.7, 1, { k: 0.5 }); // suction nozzle
    s.flange('y', [1.95, 1.5, 0], 0.28, 0.46, 8, 1);
    s.cyl('y', [2.85, 1.1, 0], 0.24, 0.6, 1, { k: 0.5 }); // discharge nozzle
    s.flange('y', [2.85, 1.4, 0], 0.24, 0.4, 8, 1);
    s.cyl('z', [2.4, -0.55, -0.95], 0.07, 0.9, 1, { k: 0.6 }); // seal gas line
    s.box([0.2, -1.2, 0], [7.3, 0.12, 2.4], 0, { k: 0.12, ek: 0.55 }); // skid
    raw.push({
      name: 'Gas turbine compressor',
      pts: s.pts,
      sens: [
        sens([2.85, 1.42, 0], 'Compressor discharge pressure', 'bar', 48.2, 0.15),
        sens([3.38, 0.3, 0], 'Axial displacement', 'µm', 210, 1.5, true),
      ],
    });
  }

  // ---------------- Motor (TEFC) ----------------
  {
    const s = makeSampler(rr);
    s.cyl('x', [0, 0, 0], 0.9, 2.5, 0, { k: 0.5, ek: 0.8 });
    for (let k = 0; k < 26; k++) {
      const a = (k / 26) * TAU;
      if (Math.sin(a) < -0.55) continue;
      const cu = Math.cos(a);
      const sv = Math.sin(a);
      // cooling fins
      s.seg([-1.2, cu * 1.06, sv * 1.06], [1.15, cu * 1.06, sv * 1.06], 0, 0.42);
      s.seg([-1.2, cu * 1.06, sv * 1.06], [-1.2, cu * 0.9, sv * 0.9], 0, 1);
      s.seg([1.15, cu * 1.06, sv * 1.06], [1.15, cu * 0.9, sv * 0.9], 0, 1);
    }
    s.disc('x', [-1.28, 0, 0], 0.12, 0.95, 0, 0.4); // end bells
    s.disc('x', [1.28, 0, 0], 0.12, 0.95, 0, 0.4);
    s.cyl('x', [1.38, 0, 0], 0.3, 0.18, 0, { k: 0.6 }); // DE bearing cap
    s.bolts('x', [1.47, 0, 0], 0.22, 6, 0.03, 0);
    s.cyl('x', [-1.62, 0, 0], 0.98, 0.5, 0, { k: 0.3, ek: 0.9 }); // fan cowl
    for (let r = 0.22; r < 0.95; r += 0.15) s.ring('x', [-1.87, 0, 0], r, 0, 0.55); // cowl grille
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      s.seg([-1.87, Math.cos(a) * 0.15, Math.sin(a) * 0.15], [-1.87, Math.cos(a) * 0.96, Math.sin(a) * 0.96], 0, 0.6);
    }
    s.cyl('x', [1.78, 0, 0], 0.13, 0.62, 0, { k: 0.7 }); // shaft + keyway
    s.seg([1.5, 0.13, 0], [2.05, 0.13, 0], 0, 0.8);
    s.cyl('x', [2.2, 0, 0], 0.32, 0.3, 1, { k: 0.6 }); // coupling half
    s.bolts('x', [2.35, 0, 0], 0.22, 6, 0.035, 1);
    s.box([0, 1.2, 0.1], [0.62, 0.32, 0.55], 0, { k: 0.5 }); // terminal box + gland
    s.cyl('z', [0, 1.15, 0.47], 0.06, 0.16, 0, { k: 0.6 });
    s.ring('z', [-0.75, 1.15, 0], 0.09, 0, 1.2); // lifting eye
    s.box([-0.8, -0.98, 0], [0.42, 0.24, 1.75], 0, { k: 0.4 }); // feet
    s.box([0.8, -0.98, 0], [0.42, 0.24, 1.75], 0, { k: 0.4 });
    for (const x of [-0.8, 0.8]) for (const z of [-0.66, 0.66]) s.ring('y', [x, -0.86, z], 0.05, 0, 1.4);
    s.box([0.15, -1.16, 0.75], [3.5, 0.1, 0.2], 0, { k: 0.3 }); // base rails (skid)
    s.box([0.15, -1.16, -0.75], [3.5, 0.1, 0.2], 0, { k: 0.3 });
    raw.push({
      name: 'Motor',
      pts: s.pts,
      sens: [
        sens([0, 1.0, -0.5], 'Winding temperature', '°C', 84, 0.4),
        sens([1.38, 0.3, 0], 'Shaft vibration', 'mm/s', 1.6, 0.04, true),
      ],
    });
  }

  // ---------------- Reciprocating pump ----------------
  {
    const s = makeSampler(rr);
    s.box([-1, 0.05, 0], [1.4, 1.3, 2.1], 0, { k: 0.45 }); // power end
    for (let k = 0; k < 6; k++) s.seg([-1.6, 0.72, -0.85 + k * 0.34], [-0.4, 0.72, -0.85 + k * 0.34], 0, 0.7); // top ribs
    s.box([-1.71, 0.05, 0], [0.03, 0.7, 1.2], 0, { k: 0.2 }); // inspection cover
    s.bolts('x', [-1.73, 0.05, 0], 0.48, 10, 0.03, 0);
    s.cyl('z', [-1.15, 0, 1.35], 0.12, 0.6, 0, { k: 0.6 });
    s.disc('z', [-1.15, 0, 1.7], 0.1, 0.95, 0, 0.25); // sheave
    for (let k = 0; k < 5; k++) s.ring('z', [-1.15, 0, 1.6 + k * 0.05], 0.95, 0, 0.75); // belt grooves
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      s.seg([-1.15 + Math.cos(a) * 0.12, Math.sin(a) * 0.12, 1.7], [-1.15 + Math.cos(a) * 0.85, Math.sin(a) * 0.85, 1.7], 0, 0.8); // spokes
    }
    for (let k = -1; k <= 1; k++) {
      const z = k * 0.62;
      s.cyl('x', [0, 0.1, z], 0.24, 0.6, 0, { k: 0.5 });
      s.flange('x', [0.3, 0.1, z], 0.1, 0.26, 4, 0);
      s.cyl('x', [0.62, 0.1, z], 0.09, 0.62, 10 + k + 1, { k: 1, ek: 1.2 }); // plungers (move)
    }
    s.box([1.3, 0.1, 0], [0.75, 1.05, 2.1], 1, { k: 0.45 }); // fluid end
    for (let k = -1; k <= 1; k++) {
      // valve covers
      s.flange('y', [1.3, 0.66, k * 0.62], 0, 0.2, 4, 1);
      s.cyl('y', [1.3, 0.7, k * 0.62], 0.2, 0.08, 1, { k: 0.6 });
      s.flange('x', [1.69, 0.1, k * 0.62], 0, 0.2, 4, 1);
    }
    s.cyl('z', [1.3, -0.75, 0], 0.26, 2.7, 1, { k: 0.4 }); // suction manifold
    s.flange('z', [1.3, -0.75, 1.35], 0.26, 0.44, 8, 1);
    s.flange('z', [1.3, -0.75, -1.35], 0.26, 0.44, 8, 1);
    s.cyl('z', [1.3, 1, 0], 0.15, 2.4, 1, { k: 0.45 }); // discharge manifold
    s.flange('z', [1.3, 1, 1.2], 0.15, 0.3, 6, 1);
    for (let k = -1; k <= 1; k++) s.cyl('y', [1.3, 0.85, k * 0.62], 0.1, 0.3, 1, { k: 0.6 });
    {
      // dampener
      const n = Math.round(4 * Math.PI * 0.38 * 0.38 * DS * 1.2);
      for (let i = 0; i < n; i++) {
        const u = rr() * 2 - 1;
        const a = rr() * TAU;
        const q = Math.sqrt(1 - u * u);
        s.add(1.3 + Math.cos(a) * q * 0.38, 1.45 + u * 0.38, -0.75 + Math.sin(a) * q * 0.38, 1, 0, Math.cos(a) * q, u, Math.sin(a) * q);
      }
      s.ring('y', [1.3, 1.45, -0.75], 0.385, 1, 1);
      s.flange('y', [1.3, 1.85, -0.75], 0, 0.12, 4, 1);
    }
    s.box([0.2, -1.15, 0], [3.7, 0.1, 2.5], 0, { k: 0.12, ek: 0.55 }); // skid
    raw.push({
      name: 'Reciprocating pump',
      pts: s.pts,
      sens: [
        sens([-1, 0.7, 0], 'Crankcase vibration', 'mm/s', 3.4, 0.06, true),
        sens([1.3, 1.85, -0.75], 'Discharge pressure', 'bar', 182, 1.2),
      ],
    });
  }

  // ---------------- Can pump ----------------
  {
    const s = makeSampler(rr);
    s.cyl('y', [0, 1.75, 0], 0.55, 1.1, 1, { k: 0.45 });
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * TAU;
      const cu = Math.cos(a);
      const sv = Math.sin(a);
      s.seg([cu * 0.66, 1.22, sv * 0.66], [cu * 0.66, 2.25, sv * 0.66], 1, 0.55);
    }
    s.disc('y', [0, 2.3, 0], 0, 0.58, 1, 0.35); // fan cowl
    s.cyl('y', [0, 2.42, 0], 0.5, 0.24, 1, { k: 0.3 });
    for (let r = 0.12; r < 0.5; r += 0.12) s.ring('y', [0, 2.54, 0], r, 1, 0.5);
    s.box([0.62, 1.9, 0], [0.18, 0.36, 0.4], 1, { k: 0.5 }); // terminal box
    s.flange('y', [0, 1.18, 0], 0.4, 0.66, 8, 1); // motor flange
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + Math.PI / 4;
      s.seg([Math.cos(a) * 0.45, 0.72, Math.sin(a) * 0.45], [Math.cos(a) * 0.45, 1.16, Math.sin(a) * 0.45], 0, 1.2); // lantern legs
    }
    s.ring('y', [0, 0.72, 0], 0.45, 0, 1); // coupling
    s.cyl('y', [0, 0.95, 0], 0.12, 0.44, 0, { k: 0.7 });
    s.box([0, 0.45, 0], [1.3, 0.5, 1.3], 0, { k: 0.4 }); // discharge head
    s.cyl('x', [0.95, 0.45, 0], 0.24, 0.7, 0, { k: 0.5 }); // discharge nozzle
    s.flange('x', [1.3, 0.45, 0], 0.24, 0.42, 8, 0);
    s.disc('y', [0, 0.2, 0], 0.2, 0.95, 0, 0.3); // mounting plate
    s.bolts('y', [0, 0.2, 0], 0.84, 8, 0.04, 0);
    s.cyl('y', [0, -1.3, 0], 0.62, 3, 0, { k: 0.9, bands: 4, ek: 0.7, lines: 6 }); // can (stiffener rings)
    s.disc('y', [0, -2.8, 0], 0, 0.62, 0, 0.6);
    s.cyl('y', [0, -1.3, 0], 0.3, 2.4, 0, { k: 0, ek: 0.5 }); // inner column hint (rims only)
    raw.push({
      name: 'Can pump',
      pts: s.pts,
      sens: [
        sens([0, 2.3, 0], 'Motor NDE bearing temp', '°C', 68, 0.3, true),
        sens([1.3, 0.45, 0], 'Discharge flow', 'm³/h', 420, 2),
      ],
    });
  }

  // ---------------- Turbo expander ----------------
  {
    const s = makeSampler(rr);
    s.cyl('x', [0, 0, 0], 0.38, 1.3, 0, { k: 0.6, bands: 2 }); // bearing housing
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + Math.PI / 4;
      s.seg([-0.5, Math.cos(a) * 0.38, Math.sin(a) * 0.38], [0.5, Math.cos(a) * 0.38, Math.sin(a) * 0.38], 0, 0.7);
    }
    s.box([0, -0.58, 0], [1.1, 0.3, 1], 0, { k: 0.4 });
    s.vol([-1.05, 0, 0], 0.55, 0.95, 0.16, 0.32, 2, 0.9);
    s.disc('x', [-1.05, 0, 0], 0, 0.5, 2, 0.35);
    s.ring('x', [-1.38, 0, 0], 0.66, 2, 0.9); // IGV ring
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * TAU;
      s.seg([-1.38, Math.cos(a) * 0.66, Math.sin(a) * 0.66], [-1.25, Math.cos(a) * 0.52, Math.sin(a) * 0.52], 2, 1);
    }
    s.cyl('x', [-1.6, 0, 0], 0.3, 0.5, 2, { k: 0.5 }); // expander outlet
    s.flange('x', [-1.85, 0, 0], 0.3, 0.46, 8, 2);
    s.cyl('y', [-1.05, 1.1, 0], 0.22, 0.9, 2, { k: 0.5 }); // expander inlet
    s.flange('y', [-1.05, 1.55, 0], 0.22, 0.38, 8, 2);
    s.vol([1.05, 0, 0], 0.5, 0.85, 0.14, 0.28, 1, 0.9);
    s.disc('x', [1.05, 0, 0], 0, 0.45, 1, 0.35);
    s.cyl('x', [1.75, 0, 0], 0.26, 1.1, 1, { k: 0.5 }); // compressor inlet
    s.flange('x', [2.3, 0, 0], 0.26, 0.42, 8, 1);
    s.cyl('y', [1.05, -0.95, 0], 0.2, 0.6, 1, { k: 0.5 });
    s.flange('y', [1.05, -1.25, 0], 0.2, 0.34, 6, 1);
    s.box([0.2, -1.32, 0], [4.4, 0.1, 1.8], 0, { k: 0.12, ek: 0.55 }); // skid
    raw.push({
      name: 'Turbo expander',
      pts: s.pts,
      sens: [
        sens([-1.05, 1.55, 0], 'Expander inlet temperature', '°C', -38.4, 0.2),
        sens([0, 0.38, 0], 'Radial vibration', 'µm', 18, 0.3, true),
      ],
    });
  }

  raw.sort((a, b) => MACHINE_NAMES.indexOf(a.name) - MACHINE_NAMES.indexOf(b.name));
  return raw;
}

/** Fit a raw stride-8 cloud into a ±2 box centred on the origin and resample it to `n` points. */
function fitResample(sh: RawShape, n: number, rr: Rng): MachineShape {
  const P = sh.pts;
  const S = POINT_STRIDE;
  const mn: Vec3 = [Infinity, Infinity, Infinity];
  const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  let edges = 0;
  for (let i = 0; i < P.length; i += S) {
    for (let k = 0; k < 3; k++) {
      const v = P[i + k];
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
    if (P[i + 4] > 0.5) edges++;
  }
  const c: Vec3 = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const f = 2.0 / Math.max((mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, (mx[2] - mn[2]) / 2);
  const src = P.length / S;
  const out = new Float32Array(n * S);
  for (let i = 0; i < n; i++) {
    // Random picks keep the density (and therefore the edge weighting) even.
    const o = Math.floor(rr() * src) * S;
    out[i * S] = (P[o] - c[0]) * f;
    out[i * S + 1] = (P[o + 1] - c[1]) * f;
    out[i * S + 2] = (P[o + 2] - c[2]) * f;
    for (let k = 3; k < S; k++) out[i * S + k] = P[o + k]; // group, edge, normal (uniform scale keeps normals)
  }
  return {
    name: sh.name,
    count: n,
    pts: out,
    rawCount: src,
    edgeRatio: src ? edges / src : 0,
    sensors: sh.sens.map((x) => ({
      ...x,
      p: [(x.p[0] - c[0]) * f, (x.p[1] - c[1]) * f, (x.p[2] - c[2]) * f] as Vec3,
    })),
  };
}

/** The app's seed (the mockup's), used by `buildShapes`' default and `getShapes`. */
const SHAPE_SEED = 7;

/**
 * Build the six machine clouds with exactly `n` particles each. Pass a seeded
 * `rng` (values in [0, 1)) for deterministic output; defaults to the mockup's
 * seed so the app shows exactly the approved machines.
 */
export function buildShapes(n: number, rng: Rng = mulberry32(SHAPE_SEED)): MachineShape[] {
  return buildRawShapes(rng).map((sh) => fitResample(sh, n, rng));
}

const shapeCache = new Map<number, MachineShape[]>();
/**
 * The raw clouds (~1.3 M numbers) plus the PRNG state right after building
 * them, so a second particle count resamples without re-sampling the geometry
 * and still gets exactly `buildShapes(n)`. Released once both sizes the
 * component uses (hero + mini) are cached.
 */
let rawCache: { raw: RawShape[]; state: number } | null = null;
let rawBuilds = 0;

/** Cached `buildShapes(n)` for the component (shapes are immutable after build). */
export function getShapes(n: number): MachineShape[] {
  let s = shapeCache.get(n);
  if (!s) {
    if (!rawCache) {
      const g = mulberry32WithState(SHAPE_SEED);
      rawCache = { raw: buildRawShapes(g.next), state: g.state() };
      rawBuilds++;
    }
    const rr = mulberry32(rawCache.state);
    s = rawCache.raw.map((sh) => fitResample(sh, n, rr));
    shapeCache.set(n, s);
    if (shapeCache.has(HERO_PARTICLES) && shapeCache.has(MINI_PARTICLES)) rawCache = null;
  }
  return s;
}

/** Test hooks: how many times the raw clouds were built, and a cache reset. */
export function rawShapeBuildCount(): number {
  return rawBuilds;
}
export function clearShapeCache(): void {
  shapeCache.clear();
  rawCache = null;
}


/* ------------------------------------------------------------------ */
/* Clock, easing, camera                                               */
/* ------------------------------------------------------------------ */

export interface MorphClock {
  /** Index of the machine currently being shown / dissolving away from. */
  idx: number;
  /** Seconds into the current hold + transition cycle. */
  t: number;
}

/** Advance the clock by `dt` seconds, rolling over to the next machine. */
export function advanceMorph(clock: MorphClock, dt: number, count: number): void {
  clock.t += dt;
  const cycle = HOLD_SECONDS + TRANSITION_SECONDS;
  while (clock.t > cycle) {
    clock.t -= cycle;
    clock.idx = (clock.idx + 1) % count;
  }
}

export interface MorphPhase {
  /** 0..1 progress through the dissolve (0 while holding). */
  m: number;
  /** Eased progress (ease-in-out cubic). */
  e: number;
  /** 0..1 burst amount (peaks mid-transition) used to scatter the dust. */
  burst: number;
}

export function morphPhase(t: number): MorphPhase {
  const m = t < HOLD_SECONDS ? 0 : (t - HOLD_SECONDS) / TRANSITION_SECONDS;
  const e = m < 0.5 ? 4 * m * m * m : 1 - Math.pow(-2 * m + 2, 3) / 2;
  return { m, e, burst: Math.sin(Math.PI * m) };
}

/** How visible the sensor callouts are (fade in after forming, out before dissolve). */
export function labelVisibility(t: number): number {
  if (t >= HOLD_SECONDS) return 0;
  return Math.max(0, Math.min(1, t / 0.5, (HOLD_SECONDS - t) / 0.4));
}

export interface Camera {
  cyw: number;
  syw: number;
  cp: number;
  sp: number;
  cx: number;
  cy: number;
  sc: number;
}

export function makeCamera(yaw: number, pitch: number, cx: number, cy: number, sc: number): Camera {
  return { cyw: Math.cos(yaw), syw: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch), cx, cy, sc };
}

/** Re-aim an existing camera in place (no per-frame allocation). */
export function setCamera(cam: Camera, yaw: number, pitch: number, cx: number, cy: number, sc: number): Camera {
  cam.cyw = Math.cos(yaw);
  cam.syw = Math.sin(yaw);
  cam.cp = Math.cos(pitch);
  cam.sp = Math.sin(pitch);
  cam.cx = cx;
  cam.cy = cy;
  cam.sc = sc;
  return cam;
}

/** Project a 3-D point; writes [screenX, screenY, depth] into `out`. */
export function projectPoint(cam: Camera, x: number, y: number, z: number, out: Vec3): Vec3 {
  const x1 = x * cam.cyw + z * cam.syw;
  const z1 = -x * cam.syw + z * cam.cyw;
  const y2 = y * cam.cp - z1 * cam.sp;
  const z2 = y * cam.sp + z1 * cam.cp;
  const k = 12 / (12 + z2);
  out[0] = cam.cx + x1 * k * cam.sc;
  out[1] = cam.cy - y2 * k * cam.sc;
  out[2] = z2;
  return out;
}

/* ------------------------------------------------------------------ */
/* Simulated sensors                                                   */
/* ------------------------------------------------------------------ */

export const HISTORY_LENGTH = 40;

export function initialHistory(s: SensorDef, rng: Rng = Math.random): number[] {
  const h: number[] = [];
  for (let i = 0; i < HISTORY_LENGTH; i++) h.push(s.v + (rng() - 0.5) * s.s * 6);
  return h;
}

/** Next simulated reading `t` seconds into a machine's hold phase. */
export function nextReading(s: SensorDef, t: number, rng: Rng = Math.random): number {
  if (s.trend) return s.v + Math.max(0, t - 1.5) * Math.abs(s.v) * 0.06 + (rng() - 0.5) * s.s * 4;
  return s.v + (rng() - 0.5) * s.s * 6;
}

/** Drift above nominal at which a trending sensor's callout turns "● ABNORMAL". */
export const ABNORMAL_DRIFT = 0.12;

/** True once a trending sensor has drifted > 12 % above nominal. */
export function isAbnormal(s: SensorDef, current: number): boolean {
  return !!s.trend && Math.abs(current) > Math.abs(s.v) * (1 + ABNORMAL_DRIFT);
}

/**
 * History for the reduced-motion still frame: deterministic, and a trending
 * sensor has already drifted to +20 % so the still image shows the callout in
 * the "● ABNORMAL" (amber) state — the product's story in one frame.
 */
export function stillHistory(s: SensorDef): number[] {
  const rng = mulberry32(Math.round(Math.abs(s.v) * 100) + s.name.length);
  const h: number[] = [];
  for (let i = 0; i < HISTORY_LENGTH; i++) {
    const noise = (rng() - 0.5) * s.s * 4;
    if (!s.trend) {
      h.push(s.v + noise * 1.5);
      continue;
    }
    // Flat for the first third, then a steady climb to +20 %.
    const ramp = Math.max(0, (i - HISTORY_LENGTH / 3) / (HISTORY_LENGTH - 1 - HISTORY_LENGTH / 3));
    h.push(s.v + Math.sign(s.v || 1) * Math.abs(s.v) * 0.2 * ramp + (i === HISTORY_LENGTH - 1 ? 0 : noise));
  }
  return h;
}

export function formatReading(v: number, nominal: number): string {
  const av = Math.abs(nominal);
  return av >= 100 ? v.toFixed(0) : v.toFixed(av >= 10 ? 1 : 2);
}

/* ------------------------------------------------------------------ */
/* Sensor label layout                                                 */
/* ------------------------------------------------------------------ */

export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Callout card width. 224 keeps ~5 px of headroom so "● ABNORMAL" (JetBrains
 * Mono 600 9.5px) never collides with the longest trending name ("Exhaust gas
 * temperature", Inter 600 11px) — also with the Segoe UI / Consolas fallback
 * the installed app gets, and with text-rendering differences between
 * machines (hinting, font versions, display scaling).
 */
export const LABEL_W = 224;
export const LABEL_H = 62;
/** Text inset inside the card: name starts at +11, the tag ends at w − 10. */
export const LABEL_PAD_L = 11;
export const LABEL_PAD_R = 10;
/** Minimum gap between the sensor name and the "● ABNORMAL" tag. */
export const LABEL_TAG_GAP = 8;
export const ABNORMAL_LABEL = '● ABNORMAL';
/** Sparkline box inside the card (right-aligned, 10 px from the edge). */
export const SPARK_W = 80;
export const SPARK_X = LABEL_W - LABEL_PAD_R - SPARK_W;

/**
 * True when a callout's name and its "● ABNORMAL" tag fit side by side:
 * `name + 8 + tag ≤ LABEL_W − 21` (widths in px, e.g. from `measureText`).
 */
export function calloutFits(nameWidth: number, tagWidth: number, w = LABEL_W): boolean {
  return nameWidth + LABEL_TAG_GAP + tagWidth <= w - LABEL_PAD_L - LABEL_PAD_R;
}

/**
 * Place one label box per anchor point (screen px). The first sits up-left of
 * its anchor, later ones up-right; if a box would collide with the previous one
 * it is pushed down below it (or, when that runs off the bottom, the previous
 * box moves up instead) so two labels never overlap.
 */
export function placeLabels(
  anchors: ReadonlyArray<{ x: number; y: number }>,
  W: number,
  H: number,
  opts: { minX?: number; margin?: number; top?: number; bottom?: number } = {},
): LabelBox[] {
  const { minX = 16, margin = 16, top = 46, bottom = 90 } = opts;
  const out: LabelBox[] = [];
  const maxY = Math.max(top, H - LABEL_H - bottom);
  anchors.forEach((a, k) => {
    const side = k === 0 ? -1 : 1;
    const lx = a.x + side * 70;
    const ly = a.y + (k === 0 ? -90 : -110);
    const maxX = Math.max(minX, W - LABEL_W - margin);
    const x = Math.max(minX, Math.min(maxX, side < 0 ? lx - LABEL_W : lx));
    let y = Math.max(top, Math.min(maxY, ly - LABEL_H / 2));
    const prev = out[k - 1];
    if (
      prev &&
      x < prev.x + LABEL_W + 8 &&
      x + LABEL_W + 8 > prev.x &&
      Math.abs(y - prev.y) < LABEL_H + 10
    ) {
      y = prev.y + LABEL_H + 12;
      if (y > maxY) {
        y = maxY;
        prev.y = Math.max(top, y - LABEL_H - 12);
      }
    }
    out.push({ x, y, w: LABEL_W, h: LABEL_H });
  });
  return out;
}
