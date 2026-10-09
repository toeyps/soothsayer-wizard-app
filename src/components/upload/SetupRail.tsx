import { Check, ChevronLeft } from 'lucide-react';
import { mono, type Tokens } from './uploadTheme';
import MachineMorphCanvas from './MachineMorphCanvas';

/** 1 = Name the project, 2 = Add sensor data, 3 = Failure groups,
 *  4 = Explore in Dashboard (current only while the Dashboard opens). */
export type SetupRailStep = 1 | 2 | 3 | 4;

interface SetupRailProps {
  T: Tokens;
  /** Current setup step. */
  step: SetupRailStep;
  /** The project name typed on step 1 (shown under that step once it is done). */
  projectName: string;
  /** Summary of the data read on step 2 ("2 files · 159,264 rows · 132 tags"); null until the files have been read. May wrap to two lines. */
  dataSummary: string | null;
  /** Value under step 3 once it is current or done ("2 groups", "Skipped · 0 groups"). */
  groupsSummary?: string | null;
  /** Step 3 was skipped: a dashed hollow "–" marker and a dashed connector, never a ✓. */
  groupsSkipped?: boolean;
  /** Clicking a COMPLETED step goes back to it; later steps are not shortcuts. */
  onStepClick: (s: 1 | 2 | 3) => void;
  /** Back to the Get-started page (step 0). */
  onAllProjects: () => void;
}

interface RailStep {
  n: SetupRailStep;
  title: string;
  sub: string;
}

const STEPS: RailStep[] = [
  { n: 1, title: 'Name the project', sub: 'What this workspace is about' },
  { n: 2, title: 'Add sensor data', sub: 'CSV files + optional tag names' },
  { n: 3, title: 'Failure groups', sub: 'The failures you want to find' },
  { n: 4, title: 'Explore in Dashboard', sub: 'Charts, assign sensors, build models' },
];

/**
 * Left rail of setup steps 1-3 (replaces the old "Find workspace / Recent"
 * sidebar): the four steps vertically, a summary of what was entered under the
 * completed ones, a faint non-interactive machine illustration, and an
 * "All projects" button back to the Get-started page.
 *
 * Step 4 is never clickable: it becomes current only for the moment the
 * Dashboard opens after step 3 (Open Dashboard / Skip), and nothing in the rail
 * is clickable then. The page renders the rail AFTER the step in DOM order, so
 * Tab reaches the step's own controls first (customer batch 2026-10, item 5).
 */
export default function SetupRail({
  T, step, projectName, dataSummary, groupsSummary = null, groupsSkipped = false, onStepClick, onAllProjects,
}: SetupRailProps) {
  return (
    <aside
      data-testid="setup-rail"
      style={{
        position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        padding: '20px 16px', minHeight: 0,
        borderRight: `1px solid ${T.border}`, background: T.surface,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative', zIndex: 1 }}>
        <span
          aria-hidden="true"
          style={{
            width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', flexShrink: 0,
            background: `radial-gradient(circle at 30% 25%, ${T.accentHi}, ${T.accent})`,
            boxShadow: '0 0 0 1px rgba(255,255,255,0.12) inset',
          }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={T.bg} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 15c2-6 4-9 5-9s2 7 4 7 2-9 4-9 3 5 5 11" />
            <circle cx="12" cy="13" r="1.4" fill={T.bg} />
          </svg>
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.01em', color: T.text }}>Wizard</span>
      </div>

      <ol style={{ listStyle: 'none', margin: '30px 0 0', padding: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        {STEPS.map((s, i) => {
          const skipped = s.n === 3 && groupsSkipped && step > 3;
          const done = s.n < step && !skipped;
          const now = s.n === step;
          // Back-navigation only while setting up; never to step 4, never while
          // the Dashboard is opening.
          const clickable = done && s.n !== 4 && step !== 4;
          const value =
            s.n === 1 && done ? (projectName.trim() || null)
            : s.n === 2 && (done || now) ? dataSummary
            : s.n === 3 && (done || now || skipped) ? groupsSummary
            : null;
          // The step-2 summary may wrap to a second line; the others ellipsise.
          const wraps = s.n === 2;
          const last = i === STEPS.length - 1;
          const content = (
            <>
              <span
                aria-hidden="true"
                data-testid={`rail-marker-${s.n}`}
                data-state={skipped ? 'skipped' : done ? 'done' : now ? 'now' : 'todo'}
                style={{
                  width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
                  fontFamily: mono, fontSize: 12, fontWeight: 600, position: 'relative', zIndex: 1,
                  boxSizing: 'border-box',
                  background: skipped ? T.bg : done ? T.ok : now ? T.accent : T.surfaceHi,
                  color: skipped ? T.textMuted : done ? T.bg : now ? '#fff' : T.textFaint,
                  border: skipped ? `1.5px dashed ${T.textFaint}` : `1px solid ${done || now ? 'transparent' : T.borderStrong}`,
                  boxShadow: now ? `0 0 0 5px ${T.accentMuted}` : 'none',
                }}
              >
                {done ? <Check size={13} strokeWidth={3} /> : skipped ? '–' : s.n}
              </span>
              <span style={{ minWidth: 0, textAlign: 'left' }}>
                <span style={{ display: 'block', marginTop: 4, fontSize: 13, fontWeight: 600, color: done || now || skipped ? T.text : T.textFaint }}>
                  {s.title}
                  {skipped && <span className="sr-only"> (skipped)</span>}
                </span>
                <span style={{ display: 'block', marginTop: 2, fontSize: 11.5, lineHeight: 1.4, color: T.textFaint }}>
                  {s.sub}
                </span>
                {value ? (
                  <span
                    data-testid={`rail-value-${s.n}`}
                    style={{
                      marginTop: 5, fontFamily: mono, fontSize: 11, lineHeight: 1.4, color: T.textMuted, overflow: 'hidden',
                      ...(wraps
                        ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }
                        : { display: 'block', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }),
                    }}
                  >
                    {value}
                  </span>
                ) : null}
              </span>
            </>
          );
          const rowStyle = {
            display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', gap: 10, position: 'relative' as const,
            border: 0, background: 'none', padding: 0,
          };
          return (
            <li key={s.n} style={{ position: 'relative', paddingBottom: last ? 0 : 22 }}>
              {!last && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute', left: 13, top: 28, bottom: 2, width: 2, borderRadius: 2,
                    background: skipped
                      ? `repeating-linear-gradient(180deg, ${T.borderStrong} 0 4px, transparent 4px 7px)`
                      : done ? T.ok : T.borderStrong,
                  }}
                />
              )}
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onStepClick(s.n as 1 | 2 | 3)}
                  aria-label={`Go back to ${s.title}`}
                  style={{ ...rowStyle, width: '100%', cursor: 'pointer', fontFamily: 'inherit', color: 'inherit' }}
                >
                  {content}
                </button>
              ) : (
                <div aria-current={now ? 'step' : undefined} style={rowStyle}>
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* Faint, decorative, never interactive. */}
      <MachineMorphCanvas
        variant="mini"
        style={{
          position: 'absolute', left: -10, right: -10, bottom: 56, height: 200,
          opacity: 0.45, pointerEvents: 'none',
        }}
      />

      <div style={{ marginTop: 'auto', position: 'relative', zIndex: 1, paddingTop: 16 }}>
        <button
          type="button"
          onClick={onAllProjects}
          style={{
            width: '100%', height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
            fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', color: T.textMuted,
            background: T.surfaceHi, border: `1px solid ${T.borderStrong}`, borderRadius: 9,
          }}
        >
          <ChevronLeft size={13} />
          All projects
        </button>
      </div>
    </aside>
  );
}
