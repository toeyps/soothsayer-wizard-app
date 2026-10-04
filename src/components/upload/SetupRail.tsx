import { Check, ChevronLeft } from 'lucide-react';
import { mono, type Tokens } from './uploadTheme';
import MachineMorphCanvas from './MachineMorphCanvas';

interface SetupRailProps {
  T: Tokens;
  /** Current setup step: 1 = Name the project, 2 = Add sensor data. */
  step: 1 | 2;
  /** The project name typed on step 1 (shown under that step once it is done). */
  projectName: string;
  /** One-line summary of the data read on step 2 ("2 files · 159,264 rows"); null until the files have been read. */
  dataSummary: string | null;
  /** Clicking a COMPLETED step goes back to it; later steps are not shortcuts. */
  onStepClick: (s: 1 | 2) => void;
  /** Back to the Get-started page (step 0). */
  onAllProjects: () => void;
}

interface RailStep {
  n: 1 | 2 | 3;
  title: string;
  sub: string;
}

const STEPS: RailStep[] = [
  { n: 1, title: 'Name the project', sub: 'What this workspace is about' },
  { n: 2, title: 'Add sensor data', sub: 'CSV files + optional tag names' },
  { n: 3, title: 'Explore in Dashboard', sub: 'Charts, filters, failure groups' },
];

/**
 * Left rail of setup steps 1-2 (replaces the old "Find workspace / Recent"
 * sidebar): the three steps vertically, a summary of what was entered under the
 * completed ones, a faint non-interactive machine illustration, and an
 * "All projects" button back to the Get-started page.
 */
export default function SetupRail({ T, step, projectName, dataSummary, onStepClick, onAllProjects }: SetupRailProps) {
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
          const done = s.n < step;
          const now = s.n === step;
          const clickable = done && s.n !== 3;
          const value =
            s.n === 1 && done ? (projectName.trim() || null)
            : s.n === 2 && done ? dataSummary
            : s.n === 2 && now ? dataSummary
            : null;
          const last = i === STEPS.length - 1;
          const content = (
            <>
              <span
                aria-hidden="true"
                style={{
                  width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
                  fontFamily: mono, fontSize: 12, fontWeight: 600, position: 'relative', zIndex: 1,
                  background: done ? T.ok : now ? T.accent : T.surfaceHi,
                  color: done ? T.bg : now ? '#fff' : T.textFaint,
                  border: `1px solid ${done || now ? 'transparent' : T.borderStrong}`,
                  boxShadow: now ? `0 0 0 5px ${T.accentMuted}` : 'none',
                }}
              >
                {done ? <Check size={13} strokeWidth={3} /> : s.n}
              </span>
              <span style={{ minWidth: 0, textAlign: 'left' }}>
                <span style={{ display: 'block', marginTop: 4, fontSize: 13, fontWeight: 600, color: done || now ? T.text : T.textFaint }}>
                  {s.title}
                </span>
                <span style={{ display: 'block', marginTop: 2, fontSize: 11.5, lineHeight: 1.4, color: T.textFaint }}>
                  {s.sub}
                </span>
                {value ? (
                  <span
                    data-testid={`rail-value-${s.n}`}
                    style={{
                      display: 'block', marginTop: 5, fontFamily: mono, fontSize: 11, color: T.textMuted,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
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
                    background: done ? T.ok : T.borderStrong,
                  }}
                />
              )}
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onStepClick(s.n as 1 | 2)}
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
