import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { FolderOpen, Plus, Search, TriangleAlert } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import type { WorkspaceMetadata } from '../../types';
import { mono, type Tokens } from './uploadTheme';
import MachineMorphCanvas from './MachineMorphCanvas';
import RecentProjectCard from './RecentProjectCard';
import {
  filterProjects,
  isNewProjectShortcut,
  isTypingTarget,
  newProjectShortcutLabel,
} from './homeHelpers';

interface HomeStepProps {
  T: Tokens;
  workspaces: WorkspaceMetadata[];
  /** False until the first recent-projects fetch settled -- avoids flashing the
   *  first-run "No projects yet" guide at returning users. */
  loaded: boolean;
  activeWorkspaceId: string | null;
  /** A project is being opened: ignore the Ctrl+N shortcut. */
  busy: boolean;
  error: string | null;
  onNewProject: () => void;
  onOpenWorkspace: (id: string) => void;
  onRenameWorkspace: (id: string, newName: string, currentName: string) => void;
  onDeleteWorkspace: (id: string) => void;
}

const FIRST_STEPS = [
  { n: '01', label: 'Name the project' },
  { n: '02', label: 'Add data' },
  { n: '03', label: 'Explore in Dashboard' },
] as const;

/** Step 0 of the Import page ("Get started"): brand + hero copy + New project +
 *  Recent projects on the left, the machine illustration on the right. */
export default function HomeStep({
  T, workspaces, loaded, activeWorkspaceId, busy, error,
  onNewProject, onOpenWorkspace, onRenameWorkspace, onDeleteWorkspace,
}: HomeStepProps) {
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState<string | null>(null);
  const shown = useMemo(() => filterProjects(workspaces, query), [workspaces, query]);
  const shortcut = useMemo(() => newProjectShortcutLabel(), []);

  // Version comes from tauri.conf.json at runtime; outside Tauri (plain browser,
  // tests) the number is simply omitted.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await getVersion();
        if (!cancelled && typeof v === 'string' && v) setVersion(v);
      } catch { /* not running inside Tauri -- omit the number */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Ctrl/Cmd+N starts a new project. This component only exists on step 0, so
  // the shortcut is automatically scoped to it; it is ignored while typing in a
  // field and while a project is loading. Idempotent with the native
  // File > New Workspace accelerator (see DataUploadPage's `newProjectSignal`).
  const onNewRef = useRef(onNewProject);
  onNewRef.current = onNewProject;
  const mountedAtRef = useRef(typeof performance !== 'undefined' ? performance.now() : 0);
  useEffect(() => {
    // A key press that began BEFORE this screen existed (File > New Workspace
    // from the Dashboard brings us here, and its own Ctrl+N keydown may be
    // delivered just after) must not also start a project. `timeStamp` is a
    // performance.now() value in browsers; jsdom reports epoch ms, which is
    // always larger, so tests are unaffected.
    const onKey = (e: KeyboardEvent) => {
      if (busy || !isNewProjectShortcut(e) || isTypingTarget(e.target)) return;
      if (e.timeStamp > 0 && e.timeStamp < mountedAtRef.current) return;
      e.preventDefault();
      onNewRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  const sectionLabel: CSSProperties = {
    fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.textFaint,
  };

  return (
    <div
      data-testid="home-step"
      style={{
        flex: 1, minHeight: 0, display: 'grid',
        gridTemplateColumns: 'minmax(460px, 42%) minmax(0, 1fr)', background: T.bg,
      }}
    >
      {/* ---------------- Left: copy + projects ---------------- */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, padding: '44px 36px 22px 56px', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span
            aria-hidden="true"
            style={{
              width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flexShrink: 0,
              background: `radial-gradient(circle at 30% 25%, ${T.accentHi}, ${T.accent})`,
              boxShadow: `0 0 0 1px rgba(255,255,255,0.12) inset, 0 8px 30px ${T.accentMuted}`,
            }}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke={T.bg} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 15c2-6 4-9 5-9s2 7 4 7 2-9 4-9 3 5 5 11" />
              <circle cx="12" cy="13" r="1.4" fill={T.bg} />
            </svg>
          </span>
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: T.text }}>Wizard</div>
            <div style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase', color: T.textFaint, marginTop: 1 }}>
              Predictive maintenance studio
            </div>
          </div>
        </div>

        <div style={{ marginTop: 48 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: mono, fontSize: 11, fontWeight: 500, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.accentHi }}>
            <i
              aria-hidden="true"
              className="motion-safe:animate-pulse"
              style={{ width: 6, height: 6, borderRadius: '50%', background: T.ok, boxShadow: `0 0 10px ${T.ok}` }}
            />
            Sensor data → failure models
          </div>
          <h1 style={{ margin: '14px 0 0', fontSize: 44, lineHeight: 1.05, fontWeight: 700, letterSpacing: '-0.035em', color: T.text, textWrap: 'balance' }}>
            See the failure{' '}
            <span style={{
              background: `linear-gradient(90deg, ${T.accentHi}, ${T.s1} 45%, ${T.s3})`,
              WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
            }}>
              before it happens.
            </span>
          </h1>
          <p style={{ margin: '16px 0 0', maxWidth: '44ch', fontSize: 14.5, lineHeight: 1.6, color: T.textMuted }}>
            Import plant sensor CSVs, explore every tag, group failure modes and build health-score models — all on this computer.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 28 }}>
            <button
              type="button"
              onClick={onNewProject}
              style={{
                height: 46, padding: '0 20px 0 16px', borderRadius: 12, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 10,
                fontSize: 14, fontWeight: 650, fontFamily: 'inherit', color: '#fff',
                background: `linear-gradient(180deg, ${T.accentHi}, ${T.accent})`,
                border: '1px solid transparent',
                boxShadow: `0 10px 30px ${T.accentMuted}, 0 0 0 1px rgba(255,255,255,0.18) inset`,
              }}
            >
              <Plus size={17} strokeWidth={2.4} />
              New project
            </button>
            <kbd
              title="Keyboard shortcut"
              style={{ fontFamily: mono, fontSize: 10.5, fontWeight: 500, color: T.textFaint, border: `1px solid ${T.borderStrong}`, borderRadius: 5, padding: '1px 6px' }}
            >
              {shortcut}
            </kbd>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            style={{
              marginTop: 18, padding: '10px 14px', borderRadius: 8,
              background: 'oklch(0.68 0.2 25 / 0.1)', border: '1px solid oklch(0.68 0.2 25 / 0.3)',
              display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: T.danger,
            }}
          >
            <TriangleAlert size={14} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        <section aria-label="Recent projects" style={{ marginTop: 40, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 200 }}>
          {loaded && workspaces.length === 0 ? (
            <>
              <div style={{ ...sectionLabel, marginBottom: 10 }}>Getting started</div>
              <div style={{
                display: 'flex', gap: 14, alignItems: 'flex-start', padding: 22, borderRadius: 14,
                border: `1px dashed ${T.borderStrong}`, background: T.surface,
              }}>
                <span style={{
                  width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center',
                  background: T.accentMuted, color: T.accentHi,
                }}>
                  <FolderOpen size={18} />
                </span>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: T.text }}>No projects yet</div>
                  <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 2 }}>
                    Your projects will appear here, so you can pick up exactly where you left off.
                  </div>
                </div>
              </div>
              <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {FIRST_STEPS.map((s) => (
                  <li key={s.n} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 10, background: T.surface }}>
                    <b style={{ display: 'block', fontFamily: mono, fontSize: 10.5, fontWeight: 600, color: T.accentHi }}>{s.n}</b>
                    <span style={{ fontSize: 12, color: T.textMuted }}>{s.label}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : loaded ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <b style={sectionLabel}>Recent projects</b>
                <span style={{ fontFamily: mono, fontSize: 11, color: T.textFaint }}>{workspaces.length}</span>
                <div style={{ flex: 1 }} />
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 7, height: 28, width: 170, padding: '0 9px',
                  border: `1px solid ${T.borderStrong}`, borderRadius: 8, background: T.chipBg, color: T.textFaint,
                }}>
                  <Search size={12} style={{ flexShrink: 0 }} />
                  <input
                    aria-label="Search projects"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find project"
                    style={{ width: '100%', background: 'none', border: 'none', outline: 'none', fontSize: 12, fontFamily: 'inherit', color: T.text }}
                  />
                </label>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: 4 }}>
                {shown.map((w) => (
                  <RecentProjectCard
                    key={w.id}
                    T={T}
                    project={w}
                    active={w.id === activeWorkspaceId}
                    onOpen={() => onOpenWorkspace(w.id)}
                    onRename={(newName) => onRenameWorkspace(w.id, newName, w.name)}
                    onDelete={() => onDeleteWorkspace(w.id)}
                  />
                ))}
                {shown.length === 0 && (
                  <div style={{ padding: 10, fontSize: 12.5, color: T.textFaint }}>No matches</div>
                )}
              </div>
            </>
          ) : null}
        </section>

        <div style={{ marginTop: 16, display: 'flex', gap: 14, fontFamily: mono, fontSize: 11, color: T.textFaint }}>
          {version && <span>v{version}</span>}
          <span>Data stays on this machine</span>
        </div>
      </div>

      {/* ---------------- Right: illustration ---------------- */}
      <div
        style={{
          position: 'relative', minWidth: 0, minHeight: 0, padding: '28px 28px 22px 0',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `radial-gradient(ellipse at 50% 42%, ${T.accentMuted}, transparent 66%)`,
        }}
      >
        <div style={{ width: '100%', height: '100%', maxWidth: 940, maxHeight: 780, minHeight: 360, position: 'relative' }}>
          <MachineMorphCanvas variant="hero" />
        </div>
      </div>
    </div>
  );
}
