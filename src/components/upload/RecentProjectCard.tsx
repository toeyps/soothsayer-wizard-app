import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Pencil, Trash2, TriangleAlert, X } from 'lucide-react';
import type { WorkspaceMetadata } from '../../types';
import { mono, type Tokens } from './uploadTheme';
import { formatRelativeTime, projectColor, projectInitials } from './homeHelpers';

interface RecentProjectCardProps {
  T: Tokens;
  project: Pick<WorkspaceMetadata, 'id' | 'name' | 'description' | 'lastModified'>;
  /**
   * Static, non-interactive rendering of the SAME card ("Shows in recent
   * projects as" on the Name step): no open / rename / delete, "just now" for the
   * time, a muted placeholder for an empty name and "No description" for an empty
   * description. `onOpen` / `onRename` / `onDelete` are not used.
   */
  preview?: boolean;
  /** True while this project is the one being opened (loading overlay is up). */
  active?: boolean;
  onOpen?: () => void;
  /** Called with the edited name; the caller owns the "empty / unchanged = no-op" rules. */
  onRename?: (newName: string) => void;
  /** Called once the user confirmed the in-row "Delete this project?" prompt. */
  onDelete?: () => void;
}

/**
 * One row of the "Recent projects" list on the Get-started page: coloured
 * initial, name, description (only when there is one), relative time. Hovering
 * (or focusing anything inside) reveals Rename / Delete. Rename edits in place
 * (Enter saves, Esc cancels); Delete asks for confirmation inside the row.
 */
export default function RecentProjectCard({ T, project, preview = false, active = false, onOpen, onRename, onDelete }: RecentProjectCardProps) {
  if (preview) return <ProjectCardPreview T={T} project={project} />;
  return <InteractiveProjectCard T={T} project={project} active={active} onOpen={onOpen ?? noop} onRename={onRename ?? noop} onDelete={onDelete ?? noop} />;
}

const noop = () => {};

/** The look of a card without any behaviour -- see `preview` above. */
function ProjectCardPreview({ T, project }: { T: Tokens; project: RecentProjectCardProps['project'] }) {
  const name = project.name.trim();
  const description = (project.description ?? '').trim();
  return (
    <div
      data-testid="project-card-preview"
      style={{
        display: 'grid', gridTemplateColumns: '38px minmax(0, 1fr) auto', gap: 12, alignItems: 'center',
        padding: '10px 12px', borderRadius: 12, border: `1px solid ${T.border}`, background: T.surfaceHi,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center',
          fontFamily: mono, fontWeight: 600, fontSize: 13, color: T.text,
          border: '1px solid rgba(255,255,255,0.08)', background: projectColor(project.id || name || 'preview'),
        }}
      >
        {projectInitials(name)}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.005em', color: name ? T.text : T.textFaint,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {name || 'Project name'}
        </div>
        <div style={{
          marginTop: 1, fontSize: 12, color: T.textFaint, opacity: description ? 1 : 0.7,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {description || 'No description'}
        </div>
      </div>
      <span style={{ fontFamily: mono, fontSize: 11, color: T.textFaint, whiteSpace: 'nowrap' }}>just now</span>
    </div>
  );
}

function InteractiveProjectCard({
  T, project, active, onOpen, onRename, onDelete,
}: {
  T: Tokens; project: RecentProjectCardProps['project']; active: boolean;
  onOpen: () => void; onRename: (newName: string) => void; onDelete: () => void;
}) {
  const { name, description } = project;
  const [hover, setHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  // Enter/Esc/blur/save-button can all end an edit; only the first one counts
  // (unmounting the focused input may fire a blur that would otherwise commit
  // the text the user just cancelled).
  const editDoneRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Esc cancels the delete prompt; Cancel is focused first so Enter / Space
  // never confirms a destructive action by accident.
  useEffect(() => {
    if (!confirming) return;
    cancelBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirming(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirming]);

  const startEdit = () => {
    editDoneRef.current = false;
    setDraft(name);
    setConfirming(false);
    setEditing(true);
  };
  const commitEdit = () => {
    if (editDoneRef.current) return;
    editDoneRef.current = true;
    setEditing(false);
    onRename(draft);
  };
  const cancelEdit = () => {
    if (editDoneRef.current) return;
    editDoneRef.current = true;
    setEditing(false);
    setDraft(name);
  };

  const showActions = !editing && !confirming && (hover || focusWithin);
  const highlighted = active || hover || focusWithin;

  const iconBtn: CSSProperties = {
    width: 28, height: 28, border: 'none', background: 'none', borderRadius: 7,
    color: T.textFaint, cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0,
  };

  return (
    <div
      data-testid="project-card"
      data-project-id={project.id}
      onClick={() => { if (!editing && !confirming) onOpen(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      style={{
        position: 'relative',
        display: 'grid', gridTemplateColumns: '38px minmax(0, 1fr) auto', gap: 12, alignItems: 'center',
        padding: '10px 12px', borderRadius: 12,
        border: `1px solid ${highlighted ? T.borderStrong : T.border}`,
        background: highlighted ? T.surfaceHi : T.surface,
        cursor: editing || confirming ? 'default' : 'pointer',
        transition: 'border-color 120ms ease, background 120ms ease',
      }}
    >
      {/* Keyboard / screen-reader entry point; mouse clicks anywhere on the card
          reach it too and bubble to the card's own onClick. */}
      {!editing && !confirming && (
        <button
          type="button"
          aria-label={`Open ${name}`}
          style={{ position: 'absolute', inset: 0, border: 'none', background: 'none', borderRadius: 12, cursor: 'pointer', padding: 0 }}
        />
      )}

      <span
        aria-hidden="true"
        style={{
          width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center',
          fontFamily: mono, fontWeight: 600, fontSize: 13, color: T.text,
          border: '1px solid rgba(255,255,255,0.08)', background: projectColor(project.id || name),
        }}
      >
        {projectInitials(name)}
      </span>

      <div style={{ minWidth: 0, position: 'relative', zIndex: 1, pointerEvents: editing ? 'auto' : 'none' }}>
        {editing ? (
          <input
            ref={inputRef}
            aria-label="Project name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
            }}
            style={{
              width: '100%', boxSizing: 'border-box', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              color: T.text, background: T.surface, border: `1px solid ${T.accent}`,
              borderRadius: 6, padding: '2px 6px', outline: 'none',
            }}
          />
        ) : (
          <div style={{
            fontSize: 13.5, fontWeight: 600, color: T.text, letterSpacing: '-0.005em',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {name}
          </div>
        )}
        {description ? (
          <div style={{
            marginTop: 1, fontSize: 12, color: T.textFaint,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {description}
          </div>
        ) : null}
      </div>

      {/* Time and actions share one cell: actions take over on hover/focus,
          but stay in the DOM (and the tab order) the whole time. */}
      <div style={{ display: 'grid', alignItems: 'center', justifyItems: 'end', position: 'relative', zIndex: 1 }}>
        {!confirming && !editing && (
          <span style={{
            gridArea: '1 / 1', fontFamily: mono, fontSize: 11, color: T.textFaint, whiteSpace: 'nowrap',
            opacity: showActions ? 0 : 1, transition: 'opacity 120ms ease',
          }}>
            {formatRelativeTime(project.lastModified)}
          </span>
        )}
        {editing && (
          <span style={{ gridArea: '1 / 1', display: 'flex', gap: 2 }}>
            <button
              type="button" title="Save (Enter)" aria-label="Save name"
              onMouseDown={(e) => e.preventDefault() /* keep the input focused */}
              onClick={(e) => { e.stopPropagation(); commitEdit(); }}
              style={{ ...iconBtn, color: T.accentHi }}
            >
              <Check size={14} />
            </button>
            <button
              type="button" title="Cancel (Esc)" aria-label="Cancel rename"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
              style={iconBtn}
            >
              <X size={14} />
            </button>
          </span>
        )}
        {!editing && !confirming && (
          <span style={{
            gridArea: '1 / 1', display: 'flex', gap: 2,
            opacity: showActions ? 1 : 0, pointerEvents: showActions ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}>
            <button
              type="button" title="Rename project" aria-label={`Rename project ${name}`}
              onClick={(e) => { e.stopPropagation(); startEdit(); }}
              style={iconBtn}
            >
              <Pencil size={14} />
            </button>
            <button
              type="button" title="Delete project" aria-label={`Delete project ${name}`}
              onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
              style={{ ...iconBtn, color: showActions ? T.danger : T.textFaint }}
            >
              <Trash2 size={14} />
            </button>
          </span>
        )}
      </div>

      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Delete ${name}?`}
          onClick={(e) => e.stopPropagation()}
          style={{
            gridColumn: '1 / -1', position: 'relative', zIndex: 1,
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            marginTop: 2, paddingTop: 8, borderTop: `1px solid ${T.border}`,
            fontSize: 12, color: T.textMuted,
          }}
        >
          <TriangleAlert size={14} style={{ color: T.danger, flexShrink: 0 }} />
          <span style={{ color: T.text, fontWeight: 600 }}>Delete this project?</span>
          <span style={{ flex: 1, minWidth: 160, color: T.textFaint }}>
            Its saved data and exported model files are removed. This can&rsquo;t be undone.
          </span>
          <button
            type="button"
            onClick={() => { setConfirming(false); onDelete(); }}
            style={{
              height: 28, padding: '0 12px', borderRadius: 7, border: '1px solid transparent',
              background: T.danger, color: '#fff', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Delete
          </button>
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={() => setConfirming(false)}
            style={{
              height: 28, padding: '0 12px', borderRadius: 7, border: `1px solid ${T.borderStrong}`,
              background: 'none', color: T.textMuted, fontSize: 12, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
