import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ABNORMAL_LABEL,
  HERO_PARTICLES,
  LABEL_PAD_L,
  LABEL_PAD_R,
  MACHINE_NAMES,
  MINI_PARTICLES,
  SPARK_W,
  SPARK_X,
  advanceMorph,
  formatReading,
  getShapes,
  initialHistory,
  isAbnormal,
  labelVisibility,
  makeCamera,
  morphPhase,
  mulberry32,
  nextReading,
  placeLabels,
  projectPoint,
  setCamera,
  stillHistory,
  type Camera,
  type MorphClock,
  type Vec3,
} from './machineShapes';
import {
  beginDrag,
  createOrbitView,
  dragMove,
  endDrag,
  isInteracting,
  isSettling,
  resetView,
  stepHeldClock,
  stepOrbit,
  type DragState,
} from './machineOrbit';
import { DotRenderer } from './machineDots';

/**
 * Animated machine illustration for the Import "Get started" page (hero) and
 * the setup rail (mini). A cloud of 6,000 edge-weighted dots (mini: 2,400)
 * re-forms into six different machines, drawn through one pixel buffer per
 * frame (`machineDots.ts`); hero also shows two simulated sensor read-outs per
 * machine, and can be turned like a 3D model (drag to orbit, double-click to
 * reset — `machineOrbit.ts`). Canvas 2D only, no dependencies.
 *
 * Reduced motion: no auto-spin, no machine cycle, no glide — one still frame
 * (the trending sensor already "● ABNORMAL"), redrawn only while the user drags
 * or when the canvas is resized / moved to a screen with another pixel ratio.
 * The loop pauses while the document is hidden. The mini variant never takes
 * pointer input.
 */

export interface MachineMorphCanvasProps {
  /** `hero` = full panel with labels + bottom bar + orbit drag (default); `mini` = small, faint, no text, no drag. */
  variant?: 'hero' | 'mini';
  className?: string;
  style?: CSSProperties;
}

// Colours match the dark tokens in uploadTheme.ts (DARK).
const INK = '#ededef';
const INK_MUTED = '#8c8c94';
const LABEL_BG = 'rgba(16,16,18,0.86)';
const WARN_RGB = '255,190,80';
const NORMAL_RGB = '140,200,255';
const ACCENT_HI = 'oklch(0.74 0.17 245)';
const FONT_SANS = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

// Double-click reset is left out on purpose: a screen-reader user cannot act on it.
const HERO_LABEL = 'Animated illustration of industrial machines built from particles. Drag to turn the view.';
const MINI_LABEL = 'Animated illustration of industrial machines built from particles';

// Floor-grid stroke colours, built once (no per-frame string building).
const GRID_X = Array.from({ length: 15 }, (_, n) => `rgba(120,150,210,${0.06 * (1 - Math.abs(n - 7) / 8)})`);
const GRID_Z = Array.from({ length: 13 }, (_, n) => `rgba(120,150,210,${0.05 * (1 - Math.abs(n - 6) / 7)})`);

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export default function MachineMorphCanvas({ variant = 'hero', className, style }: MachineMorphCanvasProps) {
  const mini = variant === 'mini';
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [reduced, setReduced] = useState<boolean>(prefersReducedMotion);
  const [activeIdx, setActiveIdx] = useState(0);

  // Follow live changes of the OS setting.
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch {
      mq = null;
    }
    if (!mq || typeof mq.addEventListener !== 'function') return;
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / no 2D support: nothing to animate

    const reduce = reduced;
    const N = mini ? MINI_PARTICLES : HERO_PARTICLES;
    const shapes = getShapes(N);
    const count = shapes.length;
    const dots = new DotRenderer(N, mini);
    const jit = new Float32Array(N * 3);
    const jr = mulberry32(99);
    for (let i = 0; i < jit.length; i++) jit[i] = jr() - 0.5;
    const hist = shapes.map((sh) => sh.sensors.map((s) => initialHistory(s)));
    const clock: MorphClock = { idx: 0, t: 0 };
    const view = createOrbitView();
    const cam: Camera = makeCamera(view.yaw, view.pitch, 0, 0, 1);
    const pr: Vec3 = [0, 0, 0];

    let W = 0;
    let H = 0;
    let dpr = 1;
    let rafId = 0;
    let last = performance.now();
    let spin = 0;
    let shownIdx = 0;
    let lastTickBucket = -1;
    let histIdx = -1;
    let bg: CanvasGradient | null = null;
    let bgW = -1;
    let bgH = -1;
    setActiveIdx(0);

    const fit = () => {
      const r = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = r.width;
      H = r.height;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();

    const roundRect = (x: number, y: number, w: number, h: number, rad: number) => {
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, rad);
      else ctx.rect(x, y, w, h);
    };

    const drawBackground = (cx: number, cy: number) => {
      if (!bg || bgW !== W || bgH !== H) {
        bg = ctx.createRadialGradient(cx, cy, 10, cx, cy, W * 0.45);
        bg.addColorStop(0, 'rgba(70,120,230,0.14)');
        bg.addColorStop(1, 'rgba(0,0,0,0)');
        bgW = W;
        bgH = H;
      }
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.lineWidth = 1;
      for (let i = -7; i <= 7; i++) {
        projectPoint(cam, i * 0.7, -1.6, -4.5, pr);
        const ax = pr[0];
        const ay = pr[1];
        projectPoint(cam, i * 0.7, -1.6, 4.5, pr);
        ctx.strokeStyle = GRID_X[i + 7];
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(pr[0], pr[1]);
        ctx.stroke();
      }
      for (let j = -6; j <= 6; j++) {
        projectPoint(cam, -5, -1.6, j * 0.7, pr);
        const ax = pr[0];
        const ay = pr[1];
        projectPoint(cam, 5, -1.6, j * 0.7, pr);
        ctx.strokeStyle = GRID_Z[j + 6];
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(pr[0], pr[1]);
        ctx.stroke();
      }
    };

    const drawLabels = (idx: number, pulseTime: number, vis: number, tickNow: boolean, still: boolean) => {
      const A = shapes[idx];
      const hs = hist[idx];
      if (histIdx !== idx) {
        // Fresh baseline each time a machine forms, so a previous cycle's
        // drifted value does not flash a stale ABNORMAL. The reduced-motion
        // still frame instead shows the drift already happened.
        histIdx = idx;
        A.sensors.forEach((s, k) => {
          hs[k] = still ? stillHistory(s) : initialHistory(s);
        });
      }
      if (tickNow) {
        A.sensors.forEach((s, k) => {
          hs[k].push(nextReading(s, clock.t));
          hs[k].shift();
        });
      }
      const anchors = A.sensors.map((s) => {
        projectPoint(cam, s.p[0], s.p[1], s.p[2], pr);
        return { x: pr[0], y: pr[1] };
      });
      const boxes = placeLabels(anchors, W, H);
      A.sensors.forEach((s, k) => {
        const h = hs[k];
        const a = anchors[k];
        const b = boxes[k];
        const cur = h[h.length - 1];
        const alert = isAbnormal(s, cur);
        const col = alert ? WARN_RGB : NORMAL_RGB;
        // The leader ends on the card edge nearest the sensor, so it stays
        // attached wherever the turned view puts the card.
        const lx = Math.max(b.x, Math.min(b.x + b.w, a.x));
        const ly = Math.max(b.y, Math.min(b.y + b.h, a.y));
        ctx.globalAlpha = vis;
        // pulsing ring + dot on the machine
        const pulse = ((pulseTime / 1000) * 1.2 + k * 0.5) % 1;
        ctx.strokeStyle = `rgba(${col},${0.7 * (1 - pulse)})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 4 + pulse * 14, 0, 7);
        ctx.stroke();
        ctx.fillStyle = `rgb(${col})`;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 3, 0, 7);
        ctx.fill();
        ctx.strokeStyle = `rgba(${col},0.45)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(lx, ly);
        ctx.stroke();
        // card
        ctx.fillStyle = LABEL_BG;
        ctx.strokeStyle = alert ? 'rgba(255,190,80,0.6)' : 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        roundRect(b.x, b.y, b.w, b.h, 10);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = INK;
        ctx.font = `600 11px ${FONT_SANS}`;
        ctx.textAlign = 'left';
        ctx.fillText(s.name, b.x + LABEL_PAD_L, b.y + 19);
        if (alert) {
          ctx.fillStyle = `rgb(${WARN_RGB})`;
          ctx.font = `600 9.5px ${FONT_MONO}`;
          ctx.textAlign = 'right';
          ctx.fillText(ABNORMAL_LABEL, b.x + b.w - LABEL_PAD_R, b.y + 19);
          ctx.textAlign = 'left';
        }
        ctx.fillStyle = alert ? 'rgb(255,200,100)' : INK;
        ctx.font = `600 18px ${FONT_MONO}`;
        const vs = formatReading(cur, s.v);
        ctx.fillText(vs, b.x + LABEL_PAD_L, b.y + 47);
        const vw = ctx.measureText(vs).width;
        ctx.fillStyle = INK_MUTED;
        ctx.font = `500 11px ${FONT_SANS}`;
        ctx.fillText(s.unit, b.x + 15 + vw, b.y + 47);
        // sparkline
        const sx = b.x + SPARK_X;
        const sy = b.y + 28;
        const sh = 22;
        let mn = Infinity;
        let mx = -Infinity;
        for (const v of h) {
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        ctx.strokeStyle = `rgba(${col},0.9)`;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        h.forEach((v, i) => {
          const X = sx + (i / (h.length - 1)) * SPARK_W;
          const Y = sy + sh - ((v - mn) / (mx - mn || 1)) * sh;
          if (i) ctx.lineTo(X, Y);
          else ctx.moveTo(X, Y);
        });
        ctx.stroke();
        ctx.globalAlpha = 1;
      });
    };

    const draw = (now: number, dt: number, still: boolean) => {
      ctx.clearRect(0, 0, W, H);
      if (W <= 0 || H <= 0) return;
      const A = shapes[clock.idx];
      const B = shapes[(clock.idx + 1) % count];
      const { e, burst } = morphPhase(clock.t);
      const sc = mini ? W * 0.13 : Math.min(W * 0.17, H * 0.165);
      const cx = W * 0.5;
      const cy = mini ? H * 0.52 : H * 0.47;
      setCamera(cam, view.yaw, view.pitch, cx, cy, sc);

      if (!mini) drawBackground(cx, cy);
      // jsdom has no ImageData: the dot pass is skipped there (render returns false).
      dots.render(ctx, A, B, e, burst, cam, spin, jit, W, H, dpr);

      const cur = e < 0.5 ? clock.idx : (clock.idx + 1) % count;
      if (cur !== shownIdx) {
        shownIdx = cur;
        setActiveIdx(cur);
      }

      if (!mini) {
        const vis = still ? 1 : labelVisibility(clock.t);
        if (vis > 0) {
          // Sensor readings tick every 700 ms of wall time.
          const bucket = Math.floor(now / 700);
          const tickNow = !still && bucket !== lastTickBucket && dt > 0;
          lastTickBucket = bucket;
          drawLabels(clock.idx, still ? 0 : now, vis, tickNow, still);
        }
      }
    };

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        fit();
        if (reduce) draw(0, 0, true);
      });
      ro.observe(canvas);
    }

    const frame = (now: number) => {
      rafId = 0;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      stepOrbit(view, now, dt, reduce);
      if (!reduce) {
        if (mini) advanceMorph(clock, dt, count);
        else stepHeldClock(clock, dt, isInteracting(view, now), count);
        spin += dt * 3;
      }
      const r = canvas.getBoundingClientRect();
      if (r.width !== W || r.height !== H || (window.devicePixelRatio || 1) !== dpr) fit();
      draw(now, dt, reduce);
      if (document.hidden) return;
      // Reduced motion: redraw only while the user drags (or the view catches up).
      if (!reduce || view.dragging || isSettling(view)) rafId = window.requestAnimationFrame(frame);
    };

    const kick = () => {
      if (rafId || document.hidden) return;
      last = performance.now();
      rafId = window.requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else if (!reduce) {
        kick();
      }
    };

    /* ---------------- orbit drag (hero only) ---------------- */
    let drag: DragState | null = null;
    let dragPointer: number | null = null;
    /** True when `setPointerCapture` took: then losing capture means the drag is over. */
    let captured = false;
    const releaseCapture = (id: number) => {
      try {
        if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
      } catch {
        /* already released */
      }
    };
    /**
     * End the active drag (idempotent). `lost` = the release never reached us
     * (capture taken away, e.g. Alt+Tab with the button held): end without a
     * glide, since the pointer's last speed is stale.
     */
    const finishDrag = (lost: boolean) => {
      if (!drag || dragPointer === null) return;
      const id = dragPointer;
      endDrag(view, drag, performance.now(), reduce || lost);
      drag = null;
      dragPointer = null;
      captured = false;
      canvas.style.cursor = 'grab';
      releaseCapture(id);
      kick();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (drag && dragPointer !== null) {
        // A press from the pointer we think is still held, or while our capture
        // is gone, means its release was lost: drop that stale drag first.
        const stale = e.pointerId === dragPointer || (captured && !canvas.hasPointerCapture?.(dragPointer));
        if (!stale) return; // one pointer turns the view; no pinch / zoom
        finishDrag(true);
      }
      dragPointer = e.pointerId;
      captured = false;
      try {
        canvas.setPointerCapture?.(e.pointerId);
        captured = !!canvas.hasPointerCapture?.(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      drag = beginDrag(view, e.clientX, e.clientY, performance.now());
      canvas.style.cursor = 'grabbing';
      kick();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== dragPointer) return;
      // A mouse moving with no button down was released where we could not hear it.
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        finishDrag(true);
        return;
      }
      dragMove(view, drag, e.clientX, e.clientY, performance.now());
      kick();
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerId !== dragPointer) return;
      finishDrag(false);
    };
    const onLostCapture = (e: PointerEvent) => {
      // Also fires right after a normal release; finishDrag is then a no-op.
      if (e.pointerId !== dragPointer) return;
      finishDrag(true);
    };
    const onDoubleClick = () => {
      resetView(view, performance.now());
      kick();
    };
    if (!mini) {
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerEnd);
      canvas.addEventListener('pointercancel', onPointerEnd);
      canvas.addEventListener('lostpointercapture', onLostCapture);
      canvas.addEventListener('dblclick', onDoubleClick);
    }

    /* ------- reduced motion: refit the still frame on a pixel-ratio change ------- */
    // (The animated loop checks devicePixelRatio every frame; the still frame has
    // no loop, and a ResizeObserver does not fire when only the ratio changes.)
    let dprMq: MediaQueryList | null = null;
    const onDprChange = () => {
      watchDpr();
      fit();
      draw(0, 0, true);
    };
    const watchDpr = () => {
      dprMq?.removeEventListener('change', onDprChange);
      dprMq = null;
      try {
        const mq = typeof window.matchMedia === 'function' ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
        if (mq && typeof mq.addEventListener === 'function') {
          mq.addEventListener('change', onDprChange);
          dprMq = mq;
        }
      } catch {
        dprMq = null;
      }
    };
    if (reduce) watchDpr();

    if (reduce) {
      // One still frame of the first machine; redrawn only while dragged.
      draw(0, 0, true);
    } else {
      document.addEventListener('visibilitychange', onVisibility);
      if (!document.hidden) rafId = window.requestAnimationFrame(frame);
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = 0;
      document.removeEventListener('visibilitychange', onVisibility);
      ro?.disconnect();
      dprMq?.removeEventListener('change', onDprChange);
      dprMq = null;
      if (!mini) {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerEnd);
        canvas.removeEventListener('pointercancel', onPointerEnd);
        canvas.removeEventListener('lostpointercapture', onLostCapture);
        canvas.removeEventListener('dblclick', onDoubleClick);
        canvas.style.cursor = 'grab';
      }
    };
  }, [mini, reduced]);

  const wrapStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    ...style,
  };

  const canvasStyle: CSSProperties = mini
    ? { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }
    : {
        position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block',
        // A swipe that starts on the art turns the machine instead of scrolling.
        pointerEvents: 'auto', touchAction: 'none', cursor: 'grab', userSelect: 'none',
      };

  return (
    <div className={className} style={wrapStyle}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={mini ? MINI_LABEL : HERO_LABEL}
        data-testid={mini ? undefined : 'machine-hero-canvas'}
        style={canvasStyle}
      />
      {!mini && (
        <div
          style={{
            position: 'absolute',
            left: 22,
            right: 22,
            bottom: 18,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            fontSize: 12,
            color: '#5b5b63',
            fontFamily: FONT_SANS,
            pointerEvents: 'none',
          }}
        >
          <b style={{ fontWeight: 500, color: INK_MUTED, marginRight: 6 }}>Works with any machine that has sensors</b>
          <span
            style={{
              border: '1px solid oklch(0.7 0.15 235 / 0.6)',
              borderRadius: 99,
              padding: '3px 10px',
              background: 'oklch(0.6 0.13 235 / 0.18)',
              color: INK,
            }}
          >
            {MACHINE_NAMES[activeIdx]}
          </span>
          <span aria-hidden="true" style={{ display: 'inline-flex', gap: 5, paddingLeft: 4 }}>
            {MACHINE_NAMES.map((n, i) => (
              <i
                key={n}
                data-testid="machine-dot"
                data-active={i === activeIdx ? 'true' : 'false'}
                style={{
                  display: 'block',
                  height: 6,
                  width: i === activeIdx ? 16 : 6,
                  borderRadius: i === activeIdx ? 3 : '50%',
                  background: i === activeIdx ? ACCENT_HI : 'rgba(255,255,255,0.15)',
                  transition: 'all .3s',
                }}
              />
            ))}
          </span>
          {/* --text-secondary so the required "simulated" label is legible. */}
          <span style={{ marginLeft: 'auto', font: `10.5px ${FONT_MONO}`, color: INK_MUTED }}>Illustration · simulated readings</span>
        </div>
      )}
    </div>
  );
}
