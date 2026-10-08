import { describe, it, expect } from 'vitest';
import {
  BUF_CAP,
  BUF_STEPS,
  FRICTION,
  GLIDE_STOP,
  HOLD_STILL_MS,
  PITCH_HOME,
  PITCH_MAX,
  PITCH_MIN,
  RESUME_MS,
  V_MAX,
  YAW_HOME,
  YAW_PER_PX,
  beginDrag,
  bufferPixels,
  clampPitch,
  createOrbitView,
  dragMove,
  endDrag,
  glideDecay,
  homeYaw,
  isInteracting,
  isSettling,
  nearestEquivalentYaw,
  pickBufferScale,
  resetView,
  stepHeldClock,
  stepOrbit,
} from '../components/upload/machineOrbit';
import { HOLD_SECONDS, TAU, TRANSITION_SECONDS } from '../components/upload/machineShapes';

const DEG = Math.PI / 180;

describe('tilt clamp', () => {
  it('limits the tilt to -10°..+80° so the view never flips', () => {
    expect(PITCH_MIN).toBeCloseTo(-10 * DEG, 10);
    expect(PITCH_MAX).toBeCloseTo(80 * DEG, 10);
    expect(clampPitch(-1)).toBe(PITCH_MIN);
    expect(clampPitch(2)).toBe(PITCH_MAX);
    expect(clampPitch(0.5)).toBe(0.5);
  });

  it('default tilt is ~18° (today’s camera) and the turn is unlimited', () => {
    expect(PITCH_HOME / DEG).toBeGreaterThan(17.5);
    expect(PITCH_HOME / DEG).toBeLessThan(18.5);
    const v = createOrbitView();
    const d = beginDrag(v, 0, 0, 0);
    for (let i = 1; i <= 100; i++) dragMove(v, d, i * 50, 0, i * 16);
    expect(v.tYaw - YAW_HOME).toBeCloseTo(5000 * YAW_PER_PX, 6); // several full turns, no limit
    expect(v.tYaw - YAW_HOME).toBeGreaterThan(TAU * 6);
  });

  it('dragging up/down clamps the tilt target', () => {
    const v = createOrbitView();
    const d = beginDrag(v, 0, 0, 0);
    dragMove(v, d, 0, 5000, 16);
    expect(v.tPitch).toBe(PITCH_MAX);
    dragMove(v, d, 0, -5000, 32);
    expect(v.tPitch).toBe(PITCH_MIN);
  });
});

describe('hold rule (the morph clock while the user holds the machine)', () => {
  it('stops just before the callouts would fade', () => {
    const c = { idx: 0, t: 1 };
    for (let i = 0; i < 300; i++) stepHeldClock(c, 1 / 60, true, 6);
    expect(c.idx).toBe(0);
    expect(c.t).toBeCloseTo(HOLD_SECONDS - 0.6, 6);
  });

  it('lets a dissolve that already started finish', () => {
    const c = { idx: 2, t: HOLD_SECONDS + 0.1 };
    for (let i = 0; i < 200; i++) stepHeldClock(c, 1 / 60, true, 6);
    expect(c.idx).toBe(3); // reached the next machine...
    expect(c.t).toBeLessThanOrEqual(HOLD_SECONDS - 0.6 + 1e-9); // ...and holds it
  });

  it('does not move a clock already inside the fade window', () => {
    const c = { idx: 0, t: HOLD_SECONDS - 0.5 };
    stepHeldClock(c, 0.1, true, 6);
    expect(c.t).toBe(HOLD_SECONDS - 0.5);
  });

  it('runs normally when the user is not interacting', () => {
    const c = { idx: 0, t: HOLD_SECONDS + TRANSITION_SECONDS - 0.01 };
    stepHeldClock(c, 0.05, false, 6);
    expect(c.idx).toBe(1);
  });

  it('interaction lasts while held, while gliding and 1.5 s after', () => {
    const v = createOrbitView();
    expect(isInteracting(v, 0)).toBe(false);
    v.dragging = true;
    expect(isInteracting(v, 0)).toBe(true);
    v.dragging = false;
    v.gliding = true;
    expect(isInteracting(v, 0)).toBe(true);
    v.gliding = false;
    v.lastInteract = 1000;
    expect(isInteracting(v, 1000 + RESUME_MS - 1)).toBe(true);
    expect(isInteracting(v, 1000 + RESUME_MS)).toBe(false);
  });
});

describe('release and glide', () => {
  const flick = (stillMs: number, reduced = false) => {
    const v = createOrbitView();
    const d = beginDrag(v, 0, 0, 0);
    for (let i = 1; i <= 5; i++) dragMove(v, d, i * 20, 0, i * 16);
    endDrag(v, d, 5 * 16 + stillMs, reduced);
    return v;
  };

  it('keeps its speed when released while moving', () => {
    const v = flick(10);
    expect(v.dragging).toBe(false);
    expect(v.gliding).toBe(true);
    expect(v.vY).toBeGreaterThan(0);
  });

  it(`no glide if the pointer was still for more than ${HOLD_STILL_MS} ms`, () => {
    const v = flick(HOLD_STILL_MS + 20);
    expect(v.gliding).toBe(false);
    expect(v.vY).toBe(0);
  });

  it('reduced motion (or a lost release) never glides', () => {
    const v = flick(5, true);
    expect(v.gliding).toBe(false);
    expect(v.vY).toBe(0);
  });

  it(`caps the release speed at ±${V_MAX} rad/s, so a hard flick travels at most V_MAX / FRICTION`, () => {
    expect(V_MAX).toBe(12);
    const v = createOrbitView();
    const d = beginDrag(v, 0, 0, 0);
    // 200 px per 8 ms ≈ 212 rad/s of turn, and as fast a downward tilt
    for (let i = 1; i <= 5; i++) dragMove(v, d, i * 200, -i * 200, i * 8);
    expect(v.vY).toBeGreaterThan(V_MAX); // measured, before the cap
    endDrag(v, d, 40, false);
    expect(v.gliding).toBe(true);
    expect(v.vY).toBe(V_MAX);
    expect(v.vP).toBe(-V_MAX);

    const start = v.tYaw;
    let now = 40;
    let at500 = NaN;
    while (v.gliding && now < 5000) {
      now += 16;
      stepOrbit(v, now, 0.016, false);
      if (Number.isNaN(at500) && now - 40 >= 500) at500 = v.tYaw - start;
    }
    const travel = v.tYaw - start;
    // ≈ 2 rad (V_MAX / FRICTION; per-frame stepping adds ~5 % at 60 fps) — never a spin-off
    expect(travel).toBeLessThan((V_MAX / FRICTION) * 1.06);
    expect(at500 / travel).toBeGreaterThan(0.94); // ~95 % of the glide is over within 0.5 s
    expect(now - 40).toBeLessThan(1100); // and it has fully stopped by ~1 s
  });

  it('glide decay: exponential, ~5 % left after 0.5 s', () => {
    expect(glideDecay(1, 0)).toBe(1);
    expect(glideDecay(1, 0.5)).toBeCloseTo(Math.exp(-FRICTION * 0.5), 10);
    expect(glideDecay(1, 0.5)).toBeLessThan(0.06);
    expect(glideDecay(-2, 0.1)).toBeCloseTo(-2 * Math.exp(-FRICTION * 0.1), 10);
  });

  it('a 1 rad/s glide comes to a stop in about half a second, then the resume timer starts', () => {
    const v = createOrbitView();
    v.gliding = true;
    v.vY = 1;
    let now = 0;
    while (v.gliding && now < 3000) {
      now += 16;
      stepOrbit(v, now, 0.016, false);
    }
    expect(now).toBeGreaterThan(400);
    expect(now).toBeLessThan(800);
    expect(Math.abs(v.vY)).toBeLessThan(GLIDE_STOP);
    expect(v.lastInteract).toBe(now);
  });

  it('after the resume pause the tilt eases home (~2 s) and the turn angle is kept', () => {
    const v = createOrbitView();
    v.tPitch = v.pitch = PITCH_MAX;
    v.tYaw = v.yaw = 2.5;
    v.lastInteract = 0;
    let now = 0;
    // during the pause: nothing moves
    for (; now < RESUME_MS - 20; now += 16) stepOrbit(v, now, 0.016, false);
    expect(v.pitch).toBeCloseTo(PITCH_MAX, 6);
    expect(v.yaw).toBeCloseTo(2.5, 6);
    for (let t = 0; t < 2000; t += 16) stepOrbit(v, (now += 16), 0.016, false);
    expect(Math.abs(v.pitch - PITCH_HOME)).toBeLessThan(0.1 * (PITCH_MAX - PITCH_HOME));
    // only the gentle sway moved the turn (amplitude 0.45), it did not snap back to -0.7
    expect(Math.abs(v.yaw - 2.5)).toBeLessThan(0.5);
  });

  it('reduced motion: the view follows the targets immediately, no sway', () => {
    const v = createOrbitView();
    v.tYaw = 1.2;
    v.tPitch = 0.9;
    stepOrbit(v, 10_000, 0.016, true);
    expect(v.yaw).toBeCloseTo(1.2, 12);
    expect(v.pitch).toBeCloseTo(0.9, 12);
    expect(isSettling(v)).toBe(false);
    stepOrbit(v, 20_000, 0.5, true);
    expect(v.yaw).toBeCloseTo(1.2, 12); // no auto-spin
  });
});

describe('double-click reset', () => {
  it('nearestEquivalentYaw shifts the target by whole turns toward the current angle', () => {
    expect(nearestEquivalentYaw(0.1, 0)).toBe(0);
    expect(nearestEquivalentYaw(7, 0)).toBeCloseTo(TAU, 10);
    expect(nearestEquivalentYaw(-7, 0)).toBeCloseTo(-TAU, 10);
    expect(nearestEquivalentYaw(TAU * 3 + 0.4, -0.7)).toBeCloseTo(TAU * 3 - 0.7, 10);
  });

  it('resets to the home view by the nearest route and resumes soon after', () => {
    const v = createOrbitView();
    v.yaw = v.tYaw = TAU * 2 + 1;
    v.pitch = v.tPitch = 1.2;
    v.gliding = true;
    v.vY = 3;
    resetView(v, 10_000);
    expect(v.tYaw).toBeCloseTo(TAU * 2 + homeYaw(v), 10);
    expect(Math.abs(v.tYaw - v.yaw)).toBeLessThanOrEqual(Math.PI);
    expect(v.tPitch).toBe(PITCH_HOME);
    expect(v.gliding).toBe(false);
    expect(v.vY).toBe(0);
    expect(isInteracting(v, 10_000)).toBe(true);
    expect(isInteracting(v, 10_000 + 400)).toBe(false);
  });
});

describe('dot-buffer scale picker', () => {
  it('bufferPixels bounds the padded buffer (box × scale + padding + 1 px rounding per side)', () => {
    expect(bufferPixels(400, 250, 1, 0)).toBe(402 * 252);
    expect(bufferPixels(400, 250, 1.25, 6)).toBe((500 + 14) * (312.5 + 14));
  });

  it('steps 1.25 → 1 → 0.8 → 0.65 under a 260k-pixel budget, capped at pixel ratio 1.25', () => {
    expect(BUF_CAP).toBe(260000);
    expect([...BUF_STEPS]).toEqual([1.25, 1, 0.8, 0.65]);
    expect(pickBufferScale(400, 250, 1)).toBe(1); // dpr 1 never upsamples
    expect(pickBufferScale(400, 250, 2)).toBe(1.25); // capped at 1.25 on HiDPI
    expect(pickBufferScale(400, 250, 1.5)).toBe(1.25); // 150 % Windows scaling
    expect(pickBufferScale(400, 250, 1.25)).toBe(1.25);
    expect(pickBufferScale(500, 400, 2)).toBe(1); // 627 × 502 > 260k at 1.25
    expect(pickBufferScale(600, 500, 1)).toBe(0.8);
    expect(pickBufferScale(1000, 500, 1)).toBe(0.65);
    expect(pickBufferScale(4000, 1250, 1)).toBe(0.65); // smallest step when nothing fits
  });

  it('counts the stamp padding: a box that fits bare drops a step once padded', () => {
    expect(pickBufferScale(400, 400, 2)).toBe(1.25); // 502² ≤ 260k
    expect(pickBufferScale(400, 400, 2, () => 6)).toBe(1); // 514² > 260k
  });

  it('never exceeds the budget when a step fits', () => {
    const pad = (s: number) => Math.ceil(s * 3) + 3;
    for (const w of [30, 220, 400, 520, 700, 900]) {
      for (const h of [30, 250, 400, 520, 700]) {
        for (const dpr of [1, 1.25, 1.5, 2]) {
          const s = pickBufferScale(w, h, dpr, pad);
          if (bufferPixels(w, h, 0.65, pad(0.65)) <= BUF_CAP) expect(bufferPixels(w, h, s, pad(s))).toBeLessThanOrEqual(BUF_CAP);
          expect(s).toBeLessThanOrEqual(1.25);
        }
      }
    }
  });
});
