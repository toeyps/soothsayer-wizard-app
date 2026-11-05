/** Orbit camera for the hero machine illustration; pure state + helpers, no DOM. Turn unlimited; tilt -10° to +80° (home ≈ 18°); no zoom. Held: no sway, morph clock waits. Release: glide capped at `V_MAX`, stops in ~0.5 s (none if still > 80 ms); 1.5 s later sway resumes and tilt eases home (~2 s). */
import { HOLD_SECONDS, TAU, advanceMorph, type MorphClock } from './machineShapes';

const DEG = Math.PI / 180;

export const PITCH_MIN = -10 * DEG;
export const PITCH_MAX = 80 * DEG;
/** Home tilt: 0.32 rad ≈ 18.3°. */
export const PITCH_HOME = 0.32;
/** Home turn before the gentle sway is added. */
export const YAW_HOME = -0.7;
/** Amplitude (rad) and speed (rad/s of the sway phase) of the idle sway. */
export const SWAY_AMP = 0.45;
export const SWAY_SPEED = 0.22;

/** Radians per CSS pixel of drag. */
export const YAW_PER_PX = 0.0085;
export const PITCH_PER_PX = 0.0065;
/** 1/s — how fast the view chases the pointer. */
export const SMOOTH = 22;
/** 1/s — glide decay after release (~0.5 s to stop). */
export const FRICTION = 6;
/** Below this speed (rad/s) a glide is over. */
export const GLIDE_STOP = 0.03;
/** Release speed cap (rad/s); a glide travels at most V_MAX / FRICTION = 2 rad, 95 % of it within 0.5 s. */
export const V_MAX = 12;
/** A pointer held still this long (ms) before release does not glide. */
export const HOLD_STILL_MS = 80;
/** Pause (ms) after the glide before the sway and machine cycle resume. */
export const RESUME_MS = 1500;
/** Time constant (s) of the tilt easing home (≈ 2 s to settle). */
export const PITCH_RETURN_TAU = 0.7;
/** While held, the clock stops this many seconds before the hold ends (callouts start fading 0.4 s before). */
export const HOLD_STOP_BEFORE = 0.6;

export interface OrbitView {
  yaw: number;
  pitch: number;
  /** Targets the smoothed view chases. */
  tYaw: number;
  tPitch: number;
  /** Release velocity (rad/s). */
  vY: number;
  vP: number;
  dragging: boolean;
  gliding: boolean;
  /** performance.now() of the last release / glide end / reset. */
  lastInteract: number;
  /** Phase of the idle sway. */
  swayPhase: number;
}

export function createOrbitView(): OrbitView {
  return {
    yaw: YAW_HOME,
    pitch: PITCH_HOME,
    tYaw: YAW_HOME,
    tPitch: PITCH_HOME,
    vY: 0,
    vP: 0,
    dragging: false,
    gliding: false,
    lastInteract: -1e9,
    swayPhase: 0,
  };
}

export const clampPitch = (p: number): number => (p < PITCH_MIN ? PITCH_MIN : p > PITCH_MAX ? PITCH_MAX : p);

/** True while the user is holding, gliding, or within the resume pause. */
export function isInteracting(view: OrbitView, now: number): boolean {
  return view.dragging || view.gliding || now - view.lastInteract < RESUME_MS;
}

/** Velocity left after `dt` seconds of glide friction. */
export function glideDecay(v: number, dt: number): number {
  return v * Math.exp(-FRICTION * dt);
}

/** Advance the morph clock: while interacting, a dissolve under way finishes, else the clock stops just before the callouts would fade. */
export function stepHeldClock(clock: MorphClock, dt: number, interacting: boolean, count: number): void {
  if (!interacting) {
    advanceMorph(clock, dt, count);
    return;
  }
  if (clock.t >= HOLD_SECONDS) advanceMorph(clock, dt, count);
  else if (clock.t < HOLD_SECONDS - HOLD_STOP_BEFORE) clock.t = Math.min(HOLD_SECONDS - HOLD_STOP_BEFORE, clock.t + dt);
}

/** `target` shifted by whole turns so it is the closest equivalent to `current`. */
export function nearestEquivalentYaw(current: number, target: number): number {
  return target + TAU * Math.round((current - target) / TAU);
}

/** Where the idle sway would put the turn right now. */
export function homeYaw(view: OrbitView): number {
  return YAW_HOME + Math.sin(view.swayPhase) * SWAY_AMP;
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */

export interface DragState {
  x: number;
  y: number;
  /** performance.now() of the last move (or the press). */
  lastMove: number;
}

export function beginDrag(view: OrbitView, x: number, y: number, now: number): DragState {
  view.dragging = true;
  view.gliding = false;
  view.vY = 0;
  view.vP = 0;
  return { x, y, lastMove: now };
}

/** Apply one pointer move: turn/tilt the targets and track a lightly filtered release speed. */
export function dragMove(view: OrbitView, drag: DragState, x: number, y: number, now: number): void {
  const dx = x - drag.x;
  const dy = y - drag.y;
  drag.x = x;
  drag.y = y;
  view.tYaw += dx * YAW_PER_PX;
  view.tPitch = clampPitch(view.tPitch + dy * PITCH_PER_PX);
  const dts = Math.max(0.004, (now - drag.lastMove) / 1000);
  drag.lastMove = now;
  view.vY = view.vY * 0.6 + ((dx * YAW_PER_PX) / dts) * 0.4;
  view.vP = view.vP * 0.6 + ((dy * PITCH_PER_PX) / dts) * 0.4;
}

const clampV = (v: number): number => (v > V_MAX ? V_MAX : v < -V_MAX ? -V_MAX : v);

/** Release: glide only if the pointer was still moving, capped at `V_MAX`. `noGlide` (reduced motion, or a lost release) ends without one. */
export function endDrag(view: OrbitView, drag: DragState, now: number, noGlide: boolean): void {
  view.dragging = false;
  if (noGlide || now - drag.lastMove > HOLD_STILL_MS) {
    view.vY = 0;
    view.vP = 0;
  }
  view.vY = clampV(view.vY);
  view.vP = clampV(view.vP);
  view.gliding = Math.abs(view.vY) > GLIDE_STOP || Math.abs(view.vP) > GLIDE_STOP;
  view.lastInteract = now;
}

/** Double-click: back to the home view by the nearest route; resumes ~0.4 s later. */
export function resetView(view: OrbitView, now: number): void {
  view.tYaw = nearestEquivalentYaw(view.yaw, homeYaw(view));
  view.tPitch = PITCH_HOME;
  view.vY = 0;
  view.vP = 0;
  view.gliding = false;
  view.dragging = false;
  view.lastInteract = now - RESUME_MS + 400;
}

/** Advance the camera by `dt` s. Drag: pointer sets targets. Glide: speed decays. Idle: gentle sway, tilt eases home. Reduced motion: no glide, sway or smoothing. */
export function stepOrbit(view: OrbitView, now: number, dt: number, reduced: boolean): void {
  if (view.dragging) {
    /* targets set by the pointer */
  } else if (view.gliding && !reduced) {
    view.tYaw += view.vY * dt;
    view.tPitch = clampPitch(view.tPitch + view.vP * dt);
    view.vY = glideDecay(view.vY, dt);
    view.vP = glideDecay(view.vP, dt);
    if (Math.abs(view.vY) < GLIDE_STOP && Math.abs(view.vP) < GLIDE_STOP) {
      view.gliding = false;
      view.lastInteract = now;
    }
  } else if (!reduced && !isInteracting(view, now)) {
    const prev = Math.sin(view.swayPhase) * SWAY_AMP;
    view.swayPhase += dt * SWAY_SPEED;
    view.tYaw += Math.sin(view.swayPhase) * SWAY_AMP - prev;
    view.tPitch += (PITCH_HOME - view.tPitch) * (1 - Math.exp(-dt / PITCH_RETURN_TAU));
  }
  const k = reduced ? 1 : 1 - Math.exp(-SMOOTH * dt);
  view.yaw += (view.tYaw - view.yaw) * k;
  view.pitch += (view.tPitch - view.pitch) * k;
}

/** True while the smoothed view has not caught up with its targets. */
export function isSettling(view: OrbitView): boolean {
  return Math.abs(view.tYaw - view.yaw) + Math.abs(view.tPitch - view.pitch) > 1e-4;
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */

/** Max pixels in the dot buffer; above it the buffer drops a resolution step. */
export const BUF_CAP = 260000;
/** Buffer pixels per CSS pixel, best first. */
export const BUF_STEPS = [1.25, 1, 0.8, 0.65] as const;
/** Highest buffer pixel ratio, whatever the display's. */
export const BUF_MAX_RATIO = 1.25;

/** Upper bound of the dot buffer's pixels for a `wCss`×`hCss` box at scale `s`, with `pad` stamp padding and 1 px rounding per side. */
export function bufferPixels(wCss: number, hCss: number, s: number, pad: number): number {
  return (wCss * s + 2 * pad + 2) * (hCss * s + 2 * pad + 2);
}

/** Pick the dot-buffer scale: the sharpest step <= min(devicePixelRatio, 1.25) whose padded buffer fits `BUF_CAP`; the smallest step if none does. */
export function pickBufferScale(wCss: number, hCss: number, dpr: number, padFor: (s: number) => number = () => 0): number {
  const dMax = Math.min(dpr || 1, BUF_MAX_RATIO);
  for (const s of BUF_STEPS) {
    if (s <= dMax + 1e-6 && bufferPixels(wCss, hCss, s, padFor(s)) <= BUF_CAP) return s;
  }
  return BUF_STEPS[BUF_STEPS.length - 1];
}
