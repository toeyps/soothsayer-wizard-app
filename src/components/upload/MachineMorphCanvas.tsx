import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  HERO_PARTICLES,
  MACHINE_NAMES,
  MINI_PARTICLES,
  advanceMorph,
  formatReading,
  getShapes,
  initialHistory,
  isWatch,
  labelVisibility,
  makeCamera,
  morphPhase,
  nextReading,
  placeLabels,
  projectPoint,
  type MorphClock,
  type Vec3,
} from './machineShapes';

/**
 * Animated machine illustration for the Import "Get started" page (hero) and
 * the setup rail (mini). A cloud of particles re-forms into six different
 * machines; hero also shows two simulated sensor read-outs per machine.
 * Canvas 2D only, no dependencies. Respects prefers-reduced-motion (one static
 * frame of the first machine) and pauses while the document is hidden.
 */

export interface MachineMorphCanvasProps {
  /** `hero` = full panel with labels + bottom bar (default); `mini` = small, faint, no text. */
  variant?: 'hero' | 'mini';
  className?: string;
  style?: CSSProperties;
}

// Colours match the dark tokens in DataUploadPage.tsx (DARK).
const INK = '#ededef';
const INK_MUTED = '#8c8c94';
const LABEL_BG = 'rgba(16,16,18,0.86)';
const WARN_RGB = '255,190,80';
const NORMAL_RGB = '140,200,255';
const ACCENT_HI = 'oklch(0.74 0.17 245)';
const FONT_SANS = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const FONT_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const GROUP_RGB = ['110,175,255', '180,150,255', '255,150,80'];
const PLUNGER_RGB = '235,240,255';
const BUCKETS = 55; // (group 0..10) * 5 depth levels

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

    const N = mini ? MINI_PARTICLES : HERO_PARTICLES;
    const shapes = getShapes(N);
    const count = shapes.length;
    const jit = new Float32Array(N * 3);
    for (let i = 0; i < jit.length; i++) jit[i] = Math.random() - 0.5;
    const hist = shapes.map((sh) => sh.sensors.map((s) => initialHistory(s)));
    const clock: MorphClock = { idx: 0, t: 0 };
    const buckets: number[][] = Array.from({ length: BUCKETS }, () => []);
    const pr: Vec3 = [0, 0, 0];

    let W = 0;
    let H = 0;
    let rafId = 0;
    let last = performance.now();
    let yaw0 = 0;
    let spin = 0;
    let shownIdx = 0;
    let lastTickBucket = -1;
    let histIdx = -1;
    setActiveIdx(0);

    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const d = window.devicePixelRatio || 1;
      W = r.width;
      H = r.height;
      canvas.width = Math.max(1, Math.round(W * d));
      canvas.height = Math.max(1, Math.round(H * d));
      ctx.setTransform(d, 0, 0, d, 0, 0);
    };
    fit();

    const roundRect = (x: number, y: number, w: number, h: number, rad: number) => {
      if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, rad);
      else ctx.rect(x, y, w, h);
    };

    const drawLabels = (idx: number, now: number, vis: number, tickNow: boolean, cam: ReturnType<typeof makeCamera>) => {
      const A = shapes[idx];
      const hs = hist[idx];
      if (histIdx !== idx) {
        // Fresh baseline each time a machine forms, so a previous cycle's
        // drifted value does not flash a stale WATCH.
        histIdx = idx;
        A.sensors.forEach((s, k) => {
          hs[k] = initialHistory(s);
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
        const side = k === 0 ? -1 : 1;
        const lx = a.x + side * 70;
        const ly = a.y + (k === 0 ? -90 : -110);
        const cur = h[h.length - 1];
        const alert = isWatch(s, cur);
        const col = alert ? WARN_RGB : NORMAL_RGB;
        ctx.globalAlpha = vis;
        // pulsing ring + dot on the machine
        const pulse = ((now / 1000) * 1.2 + k * 0.5) % 1;
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
        ctx.fillText(s.name, b.x + 11, b.y + 19);
        if (alert) {
          ctx.fillStyle = `rgb(${WARN_RGB})`;
          ctx.font = `600 9.5px ${FONT_MONO}`;
          ctx.textAlign = 'right';
          ctx.fillText('● WATCH', b.x + b.w - 10, b.y + 19);
          ctx.textAlign = 'left';
        }
        ctx.fillStyle = alert ? 'rgb(255,200,100)' : INK;
        ctx.font = `600 18px ${FONT_MONO}`;
        const vs = formatReading(cur, s.v);
        ctx.fillText(vs, b.x + 11, b.y + 47);
        const vw = ctx.measureText(vs).width;
        ctx.fillStyle = INK_MUTED;
        ctx.font = `500 11px ${FONT_SANS}`;
        ctx.fillText(s.unit, b.x + 15 + vw, b.y + 47);
        // sparkline
        const sx = b.x + 98;
        const sw = 80;
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
          const X = sx + (i / (h.length - 1)) * sw;
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
      const yaw = -0.7 + Math.sin(yaw0) * 0.45;
      const cam = makeCamera(yaw, 0.32, cx, cy, sc);

      if (!mini) {
        const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, W * 0.45);
        g.addColorStop(0, 'rgba(70,120,230,0.14)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.lineWidth = 1;
        for (let i = -7; i <= 7; i++) {
          projectPoint(cam, i * 0.7, -1.6, -4.5, pr);
          const ax = pr[0];
          const ay = pr[1];
          projectPoint(cam, i * 0.7, -1.6, 4.5, pr);
          ctx.strokeStyle = `rgba(120,150,210,${0.06 * (1 - Math.abs(i) / 8)})`;
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
          ctx.strokeStyle = `rgba(120,150,210,${0.05 * (1 - Math.abs(j) / 7)})`;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(pr[0], pr[1]);
          ctx.stroke();
        }
      }

      ctx.globalCompositeOperation = 'lighter';
      for (const b of buckets) b.length = 0;
      const pa = A.pts;
      const pb = B.pts;
      const phaseA = spin * 0.55;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const ga = pa[o + 3];
        const gb = pb[o + 3];
        const xa = pa[o] + (ga >= 10 ? 0.09 * Math.sin(phaseA + (ga - 10) * 2.094) : 0);
        const xb = pb[o] + (gb >= 10 ? 0.09 * Math.sin(phaseA + (gb - 10) * 2.094) : 0);
        const x = xa + (xb - xa) * e + jit[i * 3] * burst * 1.7;
        const y = pa[o + 1] + (pb[o + 1] - pa[o + 1]) * e + jit[i * 3 + 1] * burst * 1.7;
        const z = pa[o + 2] + (pb[o + 2] - pa[o + 2]) * e + jit[i * 3 + 2] * burst * 1.7;
        projectPoint(cam, x, y, z, pr);
        const lv = Math.max(0, Math.min(4, Math.floor(((pr[2] + 2.5) / 5) * 5)));
        const g = e < 0.5 ? ga : gb;
        buckets[Math.min(g, 10) * 5 + lv].push(pr[0], pr[1]);
      }
      const baseAlpha = mini ? 0.5 : 0.82;
      for (let key = 0; key < BUCKETS; key++) {
        const arr = buckets[key];
        if (!arr.length) continue;
        const g = Math.floor(key / 5);
        const dep = (key % 5) / 4;
        const col = g >= 10 ? PLUNGER_RGB : GROUP_RGB[g] ?? GROUP_RGB[0];
        ctx.fillStyle = `rgba(${col},${baseAlpha * (1 - dep * 0.6)})`;
        const sz = (mini ? 0.9 : 1.45) * (1.2 - dep * 0.55);
        for (let k = 0; k < arr.length; k += 2) ctx.fillRect(arr[k] - sz / 2, arr[k + 1] - sz / 2, sz, sz);
      }
      ctx.globalCompositeOperation = 'source-over';

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
          const tickNow = !still && bucket !== lastTickBucket;
          lastTickBucket = bucket;
          drawLabels(clock.idx, now, vis, tickNow && dt > 0, cam);
        }
      }
    };

    const reduce = reduced;
    const onResize = () => {
      fit();
      if (reduce) draw(0, 0, true);
    };

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => onResize());
      ro.observe(canvas);
    }

    const frame = (now: number) => {
      rafId = 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      advanceMorph(clock, dt, count);
      yaw0 += dt * 0.22;
      spin += dt * 3;
      const r = canvas.getBoundingClientRect();
      if (r.width !== W || r.height !== H) fit();
      draw(now, dt, false);
      if (!document.hidden) rafId = window.requestAnimationFrame(frame);
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else if (!rafId && !reduce) {
        last = performance.now();
        rafId = window.requestAnimationFrame(frame);
      }
    };

    if (reduce) {
      // One static frame of the first machine; no loop.
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
    };
  }, [mini, reduced]);

  const wrapStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    ...style,
  };

  return (
    <div className={className} style={wrapStyle}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Animated illustration of industrial machines built from particles"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }}
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
          <span style={{ marginLeft: 'auto', font: `10.5px ${FONT_MONO}` }}>Illustration · simulated readings</span>
        </div>
      )}
    </div>
  );
}
