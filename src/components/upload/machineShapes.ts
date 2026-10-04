/**
 * Pure helpers for `MachineMorphCanvas` (the animated machine illustration on
 * the Import "Get started" page). No DOM here so everything is unit-testable.
 *
 * Ported from the approved mockup (`buildShapes` / `startMorph`). Each machine
 * is a cloud of points sampled from simple solids (cylinders, discs, boxes,
 * spheres). All six clouds are resampled to the SAME particle count so particle
 * `i` can travel from machine A's point `i` to machine B's point `i` while the
 * cloud dissolves and re-forms.
 *
 * Point layout is a flat Float32Array: x, y, z, group per particle.
 *   group 0   = base metal (blue)
 *   group 1   = second body colour (violet)
 *   group 2   = hot section (orange)
 *   group 10+ = reciprocating-pump plunger k = group - 10 (moves back and forth)
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

export const HERO_PARTICLES = 11000;
export const MINI_PARTICLES = 2400;

export const TAU = Math.PI * 2;

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
  /** True for the sensor that drifts upward until it shows "WATCH". */
  trend?: boolean;
}

export interface MachineShape {
  name: MachineName;
  /** Number of particles (pts.length / 4). */
  count: number;
  /** Flat x,y,z,group quadruples. */
  pts: Float32Array;
  sensors: SensorDef[];
}

/* ------------------------------------------------------------------ */
/* Point sampler                                                       */
/* ------------------------------------------------------------------ */

interface Sampler {
  pts: number[];
  add(x: number, y: number, z: number, g?: number): void;
  cyl(n: number, ax: 'x' | 'y' | 'z', c: Vec3, r: number, len: number, g?: number): void;
  disc(n: number, ax: 'x' | 'y' | 'z', c: Vec3, r0: number, r1: number, g?: number): void;
  box(n: number, c: Vec3, s: Vec3, g?: number): void;
}

function makeSampler(rr: Rng): Sampler {
  const pts: number[] = [];
  const add = (x: number, y: number, z: number, g = 0) => {
    pts.push(x, y, z, g);
  };
  return {
    pts,
    add,
    cyl(n, ax, c, r, len, g = 0) {
      const nr = Math.max(2, Math.round(len / 0.22));
      const nl = Math.max(10, Math.round(r * 18));
      for (let i = 0; i < n; i++) {
        let t: number;
        let a: number;
        if (rr() < 0.62) {
          t = (Math.floor(rr() * (nr + 1)) / nr - 0.5) * len;
          a = rr() * TAU;
        } else {
          t = (rr() - 0.5) * len;
          a = (Math.floor(rr() * nl) / nl) * TAU;
        }
        const u = Math.cos(a) * r;
        const v = Math.sin(a) * r;
        if (ax === 'x') add(c[0] + t, c[1] + u, c[2] + v, g);
        else if (ax === 'y') add(c[0] + u, c[1] + t, c[2] + v, g);
        else add(c[0] + u, c[1] + v, c[2] + t, g);
      }
    },
    disc(n, ax, c, r0, r1, g = 0) {
      const nk = Math.max(1, Math.round((r1 - r0) / 0.16));
      for (let i = 0; i < n; i++) {
        const r = r0 + (r1 - r0) * (nk ? Math.floor(rr() * (nk + 1)) / nk : 1);
        const a = rr() * TAU;
        const u = Math.cos(a) * r;
        const v = Math.sin(a) * r;
        if (ax === 'x') add(c[0], c[1] + u, c[2] + v, g);
        else if (ax === 'y') add(c[0] + u, c[1], c[2] + v, g);
        else add(c[0] + u, c[1] + v, c[2], g);
      }
    },
    box(n, c, s, g = 0) {
      for (let i = 0; i < n; i++) {
        const p: Vec3 = [(rr() - 0.5) * s[0], (rr() - 0.5) * s[1], (rr() - 0.5) * s[2]];
        if (rr() < 0.55) {
          const k = Math.floor(rr() * 3);
          for (const j of [0, 1, 2]) if (j !== k) p[j] = (rr() < 0.5 ? 0.5 : -0.5) * s[j];
        } else {
          const ax = Math.floor(rr() * 3);
          p[ax] = (rr() < 0.5 ? 0.5 : -0.5) * s[ax];
          const o = [0, 1, 2].filter((x) => x !== ax);
          const j = o[Math.floor(rr() * 2)];
          p[j] = (Math.round((p[j] / s[j]) * 6) / 6) * s[j];
        }
        add(c[0] + p[0], c[1] + p[1], c[2] + p[2], g);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* The six machines                                                    */
/* ------------------------------------------------------------------ */

interface RawShape {
  name: MachineName;
  pts: number[];
  sens: SensorDef[];
}

function sens(
  p: Vec3,
  name: string,
  unit: string,
  v: number,
  s: number,
  trend = false,
): SensorDef {
  return { p, name, unit, v, s, trend };
}

/**
 * Build the six machine clouds with exactly `n` particles each. Pass a seeded
 * `rng` (values in [0, 1)) for deterministic output; defaults to Math.random.
 */
export function buildShapes(n: number, rng: Rng = Math.random): MachineShape[] {
  const rr = rng;
  const raw: RawShape[] = [];

  // Electric motor
  {
    const s = makeSampler(rr);
    s.cyl(1500, 'x', [0, 0, 0], 0.95, 2.6);
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * TAU;
      for (let j = 0; j < 40; j++) s.add(-1.25 + rr() * 2.5, Math.cos(a) * 1.05, Math.sin(a) * 1.05);
    }
    s.disc(350, 'x', [-1.3, 0, 0], 0, 0.95);
    s.disc(350, 'x', [1.3, 0, 0], 0, 0.95);
    s.cyl(140, 'x', [1.75, 0, 0], 0.14, 0.9);
    s.box(300, [0, 1.2, 0.2], [0.7, 0.3, 0.6]);
    s.box(200, [-0.8, -1.05, 0], [0.4, 0.2, 1.6]);
    s.box(200, [0.8, -1.05, 0], [0.4, 0.2, 1.6]);
    for (let i = 0; i < 120; i++) {
      const a = rr() * TAU;
      s.add(-1.55, Math.cos(a) * rr() * 0.7, Math.sin(a) * rr() * 0.7);
    }
    raw.push({
      name: 'Motor',
      pts: s.pts,
      sens: [
        sens([0, 1.05, -0.5], 'Winding temperature', '°C', 84, 0.4),
        sens([1.75, 0, 0], 'Shaft vibration', 'mm/s', 1.6, 0.04, true),
      ],
    });
  }

  // Gas turbine + generator
  {
    const s = makeSampler(rr);
    const prof = (x: number) =>
      x < -2.4
        ? 1.25 - (x + 3) * 0.4
        : x < -0.7
          ? 1.02 - (x + 2.4) * 0.07
          : x < 0.6
            ? 1.12
            : x < 1.7
              ? 1.02 + (x - 0.6) * 0.22
              : 1.25;
    for (let i = 0; i < 1500; i++) {
      const x = -3 + rr() * 5.2;
      const a = rr() * TAU;
      const r = prof(x);
      s.add(x - 0.6, Math.cos(a) * r, Math.sin(a) * r, x > -0.7 && x < 1.7 ? 2 : 0);
    }
    s.cyl(700, 'x', [2.4, 0, 0], 1.0, 1.9, 1);
    s.disc(150, 'x', [1.45, 0, 0], 0, 1, 1);
    s.disc(150, 'x', [3.35, 0, 0], 0, 1, 1);
    s.cyl(80, 'x', [1.75, 0, 0], 0.2, 0.6);
    raw.push({
      name: 'Gas turbine generator',
      pts: s.pts,
      sens: [
        sens([0.7, 1.15, 0], 'Exhaust gas temperature', '°C', 548, 2, true),
        sens([2.4, 1.0, 0], 'Active power', 'MW', 7.9, 0.03),
      ],
    });
  }

  // Volute (spiral casing) helper used by the turbo expander
  const vol = (
    s: Sampler,
    count: number,
    c: Vec3,
    R0: number,
    R1: number,
    t0: number,
    t1: number,
    g = 0,
  ) => {
    for (let i = 0; i < count; i++) {
      const th = rr() * TAU * 0.93;
      const R = R0 + ((R1 - R0) * th) / TAU;
      const tr = t0 + ((t1 - t0) * th) / TAU;
      const a = rr() * TAU;
      s.add(
        c[0] + Math.sin(a) * tr,
        c[1] + Math.cos(th) * (R + Math.cos(a) * tr),
        c[2] + Math.sin(th) * (R + Math.cos(a) * tr),
        g,
      );
    }
  };

  // Gas turbine driving a barrel compressor
  {
    const s = makeSampler(rr);
    const prof = (x: number) =>
      x < -2.4
        ? 1.15 - (x + 3) * 0.35
        : x < -0.9
          ? 0.95 - (x + 2.4) * 0.06
          : x < 0.2
            ? 1.05
            : x < 1
              ? 0.95 + (x - 0.2) * 0.2
              : 1.12;
    for (let i = 0; i < 1300; i++) {
      const x = -3 + rr() * 4.2;
      const a = rr() * TAU;
      const r = prof(x);
      s.add(x - 0.4, Math.cos(a) * r, Math.sin(a) * r, x > -0.9 && x < 1 ? 2 : 0);
    }
    s.cyl(80, 'x', [1.1, 0, 0], 0.18, 0.7);
    s.cyl(900, 'x', [2.4, 0, 0], 0.85, 1.9, 1);
    s.disc(160, 'x', [1.45, 0, 0], 0, 0.85, 1);
    s.disc(160, 'x', [3.35, 0, 0], 0, 0.85, 1);
    s.cyl(200, 'y', [1.9, 1.2, 0], 0.28, 0.8, 1);
    s.disc(80, 'y', [1.9, 1.6, 0], 0.28, 0.45, 1);
    s.cyl(200, 'y', [2.95, 1.15, 0], 0.24, 0.7, 1);
    s.disc(80, 'y', [2.95, 1.5, 0], 0.24, 0.4, 1);
    s.box(300, [0.6, -1.25, 0], [6.8, 0.12, 2]);
    raw.push({
      name: 'Gas turbine compressor',
      pts: s.pts,
      sens: [
        sens([1.9, 1.6, 0], 'Compressor discharge pressure', 'bar', 48.2, 0.15),
        sens([2.4, 0.85, 0], 'Axial displacement', 'µm', 210, 1.5, true),
      ],
    });
  }

  // Reciprocating (triplex plunger) pump: power end + belt sheave, 3 crossheads,
  // moving plungers, fluid end, manifolds, dampener.
  {
    const s = makeSampler(rr);
    s.box(1500, [-1.0, 0.05, 0], [1.4, 1.3, 2.1]);
    for (let k = 0; k < 6; k++) s.box(50, [-1.0, 0.72, -0.85 + k * 0.34], [1.2, 0.04, 0.04]);
    s.cyl(140, 'z', [-1.15, 0, 1.35], 0.12, 0.6);
    s.disc(420, 'z', [-1.15, 0, 1.7], 0.1, 0.95);
    s.cyl(260, 'z', [-1.15, 0, 1.7], 0.95, 0.22);
    for (let k = 0; k < 4; k++) s.cyl(40, 'z', [-1.15, 0, 1.62 + k * 0.05], 0.95, 0.01);
    for (let k = -1; k <= 1; k++) {
      const z = k * 0.62;
      s.cyl(260, 'x', [0, 0.1, z], 0.24, 0.6);
      s.disc(60, 'x', [0.3, 0.1, z], 0.12, 0.24);
      s.cyl(170, 'x', [0.62, 0.1, z], 0.09, 0.62, 10 + k + 1);
    }
    s.box(1300, [1.3, 0.1, 0], [0.75, 1.05, 2.1], 1);
    for (let k = -1; k <= 1; k++) {
      s.disc(90, 'y', [1.3, 0.66, k * 0.62], 0, 0.2, 1);
      s.cyl(60, 'y', [1.3, 0.68, k * 0.62], 0.2, 0.08, 1);
      s.disc(70, 'x', [1.69, 0.1, k * 0.62], 0, 0.2, 1);
    }
    s.cyl(420, 'z', [1.3, -0.75, 0], 0.26, 2.7, 1);
    s.disc(80, 'z', [1.3, -0.75, 1.35], 0.26, 0.42, 1);
    s.disc(80, 'z', [1.3, -0.75, -1.35], 0.26, 0.42, 1);
    s.cyl(280, 'z', [1.3, 1.0, 0], 0.15, 2.4, 1);
    s.disc(60, 'z', [1.3, 1.0, 1.2], 0.15, 0.28, 1);
    for (let k = -1; k <= 1; k++) s.cyl(50, 'y', [1.3, 0.85, k * 0.62], 0.1, 0.3, 1);
    for (let i2 = 0; i2 < 380; i2++) {
      const u = rr() * 2 - 1;
      const a = rr() * TAU;
      const r = 0.38;
      const q = Math.sqrt(1 - u * u);
      s.add(1.3 + Math.cos(a) * q * r, 1.45 + u * r, -0.75 + Math.sin(a) * q * r, 1);
    }
    s.box(420, [0.2, -1.15, 0], [3.6, 0.1, 2.4]);
    raw.push({
      name: 'Reciprocating pump',
      pts: s.pts,
      sens: [
        sens([-1.0, 0.7, 0], 'Crankcase vibration', 'mm/s', 3.4, 0.06, true),
        sens([1.3, 1.83, -0.75], 'Discharge pressure', 'bar', 182, 1.2),
      ],
    });
  }

  // Vertical can pump
  {
    const s = makeSampler(rr);
    s.cyl(700, 'y', [0, 1.75, 0], 0.55, 1.1, 1);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      for (let j = 0; j < 22; j++) s.add(Math.cos(a) * 0.6, 1.2 + rr() * 1.1, Math.sin(a) * 0.6, 1);
    }
    s.disc(120, 'y', [0, 2.3, 0], 0, 0.55, 1);
    s.cyl(260, 'y', [0, 0.95, 0], 0.45, 0.5);
    s.box(420, [0, 0.45, 0], [1.3, 0.5, 1.3]);
    s.cyl(240, 'x', [0.95, 0.45, 0], 0.24, 0.7);
    s.disc(80, 'x', [1.3, 0.45, 0], 0.24, 0.4);
    s.disc(200, 'y', [0, 0.2, 0], 0.2, 0.9);
    s.cyl(1000, 'y', [0, -1.3, 0], 0.62, 3);
    s.disc(140, 'y', [0, -2.8, 0], 0, 0.62);
    for (let k = 0; k < 4; k++) s.cyl(70, 'y', [0, -1.8 + k * 0.3, 0], 0.45, 0.04);
    raw.push({
      name: 'Can pump',
      pts: s.pts,
      sens: [
        sens([0, 2.3, 0], 'Motor NDE bearing temp', '°C', 68, 0.3, true),
        sens([1.3, 0.45, 0], 'Discharge flow', 'm³/h', 420, 2),
      ],
    });
  }

  // Turbo expander–compressor
  {
    const s = makeSampler(rr);
    s.cyl(420, 'x', [0, 0, 0], 0.38, 1.3);
    s.box(200, [0, -0.55, 0], [1, 0.3, 0.9]);
    vol(s, 1000, [-1.05, 0, 0], 0.55, 0.95, 0.16, 0.32, 2);
    s.disc(260, 'x', [-1.05, 0, 0], 0, 0.5, 2);
    s.cyl(220, 'y', [-1.05, 1.1, 0], 0.22, 0.9, 2);
    s.disc(70, 'y', [-1.05, 1.55, 0], 0.22, 0.36, 2);
    vol(s, 1000, [1.05, 0, 0], 0.5, 0.85, 0.14, 0.28, 1);
    s.disc(260, 'x', [1.05, 0, 0], 0, 0.45, 1);
    s.cyl(220, 'x', [1.75, 0, 0], 0.26, 1.1, 1);
    s.disc(70, 'x', [2.3, 0, 0], 0.26, 0.4, 1);
    s.cyl(160, 'y', [1.05, -0.95, 0], 0.2, 0.6, 1);
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

  return raw.map((sh) => {
    // Fit to a ±2 box centred on the origin.
    const mn: Vec3 = [Infinity, Infinity, Infinity];
    const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < sh.pts.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const v = sh.pts[i + k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    const c: Vec3 = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    const f = 2.0 / Math.max((mx[0] - mn[0]) / 2, (mx[1] - mn[1]) / 2, (mx[2] - mn[2]) / 2);

    // Resample to exactly n particles (random picks keep the density even).
    const src = sh.pts.length / 4;
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const o = Math.floor(rr() * src) * 4;
      out[i * 4] = (sh.pts[o] - c[0]) * f;
      out[i * 4 + 1] = (sh.pts[o + 1] - c[1]) * f;
      out[i * 4 + 2] = (sh.pts[o + 2] - c[2]) * f;
      out[i * 4 + 3] = sh.pts[o + 3];
    }
    return {
      name: sh.name,
      count: n,
      pts: out,
      sensors: sh.sens.map((x) => ({
        ...x,
        p: [(x.p[0] - c[0]) * f, (x.p[1] - c[1]) * f, (x.p[2] - c[2]) * f] as Vec3,
      })),
    };
  });
}

const shapeCache = new Map<number, MachineShape[]>();

/** Cached `buildShapes` for the component (shapes are immutable after build). */
export function getShapes(n: number): MachineShape[] {
  let s = shapeCache.get(n);
  if (!s) {
    s = buildShapes(n);
    shapeCache.set(n, s);
  }
  return s;
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

/** True once a trending sensor has drifted > 12 % above nominal. */
export function isWatch(s: SensorDef, current: number): boolean {
  return !!s.trend && Math.abs(current) > Math.abs(s.v) * 1.12;
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

export const LABEL_W = 188;
export const LABEL_H = 62;

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
