import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { FolderOpen, Plus, Search, TriangleAlert } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import type { WorkspaceMetadata } from '../../types';
import { mono, type Tokens } from './uploadTheme';
import MachineMorphCanvas from './MachineMorphCanvas';
import wizardLogo from '../../assets/wizard-2A.svg';
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
  /** False until the first recent-projects fetch settled; avoids flashing the first-run guide at returning users. */
  loaded: boolean;
  activeWorkspaceId: string | null;
  /** A project is being opened: ignore the Ctrl+N shortcut. */
  busy: boolean;
  error: string | null;
  onNewProject: () => void;
  onOpenWorkspace: (id: string) => void;
  /** Rename on a card opens Project details (the name is "Plant · Machine"). */
  onEditWorkspace?: (id: string) => void;
  onDeleteWorkspace: (id: string) => void;
}

const FACTS: [string, string][] = [
  ['Import the CSVs you already have', 'and explore every tag.'],
  ['Group failure modes', 'and learn what normal looks like.'],
  ['See which periods went abnormal', 'with a 0–100 health score, offline on this computer.'],
];

const FIRST_STEPS = [
  { n: '01', label: 'Which machine' },
  { n: '02', label: 'Add data' },
  { n: '03', label: 'Explore in Dashboard' },
] as const;

export default function HomeStep({
  T, workspaces, loaded, activeWorkspaceId, busy, error,
  onNewProject, onOpenWorkspace, onEditWorkspace, onDeleteWorkspace,
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

  // Ctrl/Cmd+N starts a new project; ignored while typing or loading. Idempotent with File > New Workspace.
  const onNewRef = useRef(onNewProject);
  onNewRef.current = onNewProject;
  const mountedAtRef = useRef(typeof performance !== 'undefined' ? performance.now() : 0);
  useEffect(() => {
    // Ignore a keydown that began before this screen existed; jsdom timestamps are epoch ms, so tests are unaffected.
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
        gridTemplateColumns: 'minmax(500px, 44%) minmax(0, 1fr)', background: T.bg,
      }}
    >
      {/* The bottom strip holds the version, so scrolled content can never run under it. */}
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, paddingBottom: 56 }}>
      {/* `safe center`: a short window scrolls from the top instead of cutting the logo off. */}
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'safe center', flex: 1, minHeight: 0, padding: '40px 36px 0 56px', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 40, flexShrink: 0 }}>
          <span style={{ position: 'relative', display: 'block', width: 40, height: 40, flexShrink: 0 }}>
            <span
              aria-hidden="true"
              style={{ position: 'absolute', inset: -30, borderRadius: '50%', background: 'radial-gradient(circle, oklch(0.55 0.14 245 / 0.22), transparent 70%)', pointerEvents: 'none' }}
            />
            <img
              src={wizardLogo}
              alt=""
              width={40}
              height={40}
              data-testid="home-logo"
              style={{ position: 'relative', display: 'block', borderRadius: 10, boxShadow: '0 0 0 1px rgba(255,255,255,0.05), 0 12px 36px oklch(0.45 0.13 245 / 0.45)' }}
            />
          </span>
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', color: T.text }}>Wizard</span>
          <span aria-hidden="true" style={{ width: 1, height: 16, margin: '0 2px', background: T.borderStrong }} />
          <span style={{ fontSize: 13.5, color: T.textMuted }}>Machine health studio</span>
        </div>

        <div style={{ flexShrink: 0 }}>
          <h1 style={{ margin: 0, fontSize: 'clamp(32px, 2.65vw, 48px)', lineHeight: 1.06, fontWeight: 700, letterSpacing: '-0.035em', color: T.text }}>
            <span style={{ display: 'block' }}>Find abnormal behaviour</span>{' '}
            <span style={{
              display: 'block',
              background: `linear-gradient(90deg, ${T.accentHi}, ${T.s1} 45%, ${T.s3})`,
              WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
            }}>
              in your machine&rsquo;s data.
            </span>
          </h1>
          <ul style={{ listStyle: 'none', margin: '22px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 9, maxWidth: '54ch' }}>
            {FACTS.map(([lead, rest]) => (
              <li key={lead} style={{ display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 14.5, lineHeight: 1.45, color: T.textMuted }}>
                <i aria-hidden="true" style={{ flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: T.accentHi, transform: 'translateY(-3px)' }} />
                <span><b style={{ fontWeight: 500, color: T.text }}>{lead}</b> {rest}</span>
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 30 }}>
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
            <span style={{ fontSize: 12.5, color: T.textFaint }}>
              or press <b style={{ fontFamily: mono, fontWeight: 500, color: T.textMuted }}>{shortcut}</b>
            </span>
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

        {/* A long project list shrinks and scrolls inside itself; the "no projects" panel keeps its height. */}
        <section
          aria-label="Recent projects"
          style={{
            marginTop: 40, display: 'flex', flexDirection: 'column',
            flex: workspaces.length > 0 ? '0 1 auto' : '0 0 auto', minHeight: workspaces.length > 0 ? 140 : 0,
          }}
        >
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
                <b style={{ fontSize: 13.5, fontWeight: 600, color: T.text }}>Recent projects</b>
                <span style={{ fontSize: 12.5, color: T.textFaint }}>{workspaces.length}</span>
                <div style={{ flex: 1 }} />
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 7, height: 30, width: 200, padding: '0 9px',
                  border: `1px solid ${T.borderStrong}`, borderRadius: 9, background: T.chipBg, color: T.textFaint,
                }}>
                  <Search size={12} style={{ flexShrink: 0 }} />
                  <input
                    aria-label="Search projects"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find a project"
                    style={{ width: '100%', background: 'none', border: 'none', outline: 'none', fontSize: 12, fontFamily: 'inherit', color: T.text }}
                  />
                </label>
              </div>
              {/* `.fg-recent-list` is the size container the cards' failure-group chip reads. */}
              <div className="fg-recent-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: 4 }}>
                {shown.map((w) => (
                  <RecentProjectCard
                    key={w.id}
                    T={T}
                    project={w}
                    active={w.id === activeWorkspaceId}
                    onOpen={() => onOpenWorkspace(w.id)}
                    onEditDetails={onEditWorkspace ? () => onEditWorkspace(w.id) : undefined}
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
      </div>
      {version && (
        <div style={{ position: 'absolute', left: 56, bottom: 18, fontSize: 12, color: T.textFaint }}>Wizard {version}</div>
      )}
      </div>

      <div
        style={{
          position: 'relative', minWidth: 0, minHeight: 0, padding: '28px 28px 0 0',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `radial-gradient(ellipse at 50% 42%, ${T.accentMuted}, transparent 66%)`,
        }}
      >
        <div style={{ width: '100%', height: '100%', maxWidth: 940, minHeight: 360, position: 'relative' }}>
          <MachineMorphCanvas variant="hero" />
        </div>
      </div>
    </div>
  );
}
