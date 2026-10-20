import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Pencil, Trash2, TriangleAlert } from 'lucide-react';
import type { WorkspaceMetadata } from '../../types';
import { mono, type Tokens } from './uploadTheme';
import { formatRelativeTime, projectColor, projectInitials } from './homeHelpers';
import { recentProjectFgChip } from '../../utils/failureGroupSummary';
import { getFgGroupColor } from '../../utils/failureGroupColor';

interface RecentProjectCardProps {
  T: Tokens;
  /** `failureGroupCount` / `failureGroupNos` drive the failure-group chip;
   *  left undefined (a project saved before they existed) = no chip. */
  project: Pick<WorkspaceMetadata, 'id' | 'name' | 'description' | 'lastModified'>
    & Partial<Pick<WorkspaceMetadata, 'failureGroupCount' | 'failureGroupNos'>>;
  /**
   * Static, non-interactive rendering of the SAME card ("Shows in recent
   * projects as" on the Name step): no open / rename / delete, "just now" for the
   * time, a muted "Plant · Machine" placeholder for an empty name and "Machine tag ·
   * notes" for an empty description. `onOpen` / `onEditDetails` / `onDelete` are not used.
   */
  preview?: boolean;
  /** True while this project is the one being opened (loading overlay is up). */
  active?: boolean;
  onOpen?: () => void;
  /** Rename opens Project details (the name is "Plant · Machine"; Project details'
   *  save is the only writer of the name). No Rename button without it. */
  onEditDetails?: () => void;
  /** Called once the user confirmed the in-row "Delete this project?" prompt. */
  onDelete?: () => void;
}

/**
 * One row of the "Recent projects" list on the Get-started page: coloured
 * initial, name, description (only when there is one), relative time. Hovering
 * (or focusing anything inside) reveals Rename / Delete. Rename opens Project
 * details; Delete asks for confirmation inside the row.
 */
export default function RecentProjectCard({ T, project, preview = false, active = false, onOpen, onEditDetails, onDelete }: RecentProjectCardProps) {
  if (preview) return <ProjectCardPreview T={T} project={project} />;
  return <InteractiveProjectCard T={T} project={project} active={active} onOpen={onOpen ?? noop} onEditDetails={onEditDetails} onDelete={onDelete ?? noop} />;
}

const noop = () => {};

interface PressRecord { inActions: boolean; touch: boolean; actionsShown: boolean }
const NO_PRESS: PressRecord = { inActions: false, touch: false, actionsShown: false };

/**
 * "n failure groups" with a colour square per group (up to three, the
 * Dashboard's own group colours), or a neutral dashed "No failure groups" —
 * never amber, having none is not a warning.
 * Nothing at all for a project saved before the count was recorded; it
 * appears after that project's next save.
 */
function FailureGroupChip({ project }: { project: RecentProjectCardProps['project'] }) {
  const chip = recentProjectFgChip(project);
  if (!chip) return null;
  return (
    <span className={`fg-count-chip${chip.count === 0 ? ' fg-count-chip--zero' : ''}`} data-testid="project-fg-chip">
      {chip.nos.length > 0 && (
        <span className="fg-count-chip-sw" aria-hidden="true">
          {chip.nos.map(no => <i key={no} className={`fg-group-color-${getFgGroupColor(no)}`} />)}
        </span>
      )}
      {chip.label}
    </span>
  );
}

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
          {name || 'Plant · Machine'}
        </div>
        <div style={{
          marginTop: 1, fontSize: 12, color: T.textFaint, opacity: description ? 1 : 0.7,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {description || 'Machine tag · notes'}
        </div>
      </div>
      <span style={{ fontFamily: mono, fontSize: 11, color: T.textFaint, whiteSpace: 'nowrap' }}>just now</span>
    </div>
  );
}

function InteractiveProjectCard({
  T, project, active, onOpen, onEditDetails, onDelete,
}: {
  T: Tokens; project: RecentProjectCardProps['project']; active: boolean;
  onOpen: () => void; onEditDetails?: () => void; onDelete: () => void;
}) {
  const { name, description } = project;
  const [hover, setHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  /** The time / Rename / Delete cell. Nothing that happens inside it may ever
   *  open the project. */
  const actionsCellRef = useRef<HTMLDivElement>(null);
  /** Where the current pointer press started, recorded in the capture phase
   *  before anything re-renders: a press that began inside the actions cell
   *  must not open the project even if the browser retargets its `click` to
   *  the card (mousedown and mouseup on different elements → the click goes
   *  to their common ancestor). */
  const pressRef = useRef<PressRecord>(NO_PRESS);
  const cardRef = useRef<HTMLDivElement>(null);
  /** Detaches the window listeners that forget an abandoned press. */
  const stopWatchingPressRef = useRef<(() => void) | null>(null);
  const clearPress = () => {
    pressRef.current = NO_PRESS;
    stopWatchingPressRef.current?.();
    stopWatchingPressRef.current = null;
  };
  useEffect(() => () => { stopWatchingPressRef.current?.(); }, []);

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

  const openDetails = () => {
    setConfirming(false);
    onEditDetails?.();
  };

  const showActions = !confirming && (hover || focusWithin);
  const hasFgChip = recentProjectFgChip(project) !== null;
  const highlighted = active || hover || focusWithin;

  const recordPress = (e: ReactPointerEvent<HTMLDivElement>) => {
    clearPress();
    if (e.button !== 0) return; // only a primary press is followed by a click
    const target = e.target;
    const inActions = !!actionsCellRef.current && target instanceof Node && actionsCellRef.current.contains(target);
    pressRef.current = { inActions, touch: e.pointerType === 'touch', actionsShown: showActions };
    if (!inActions) return;
    // A press in the actions cell that never turns into a click on this card
    // (released outside it, or cancelled by a touch scroll) must not linger
    // and swallow a later click.
    const onUp = (ev: PointerEvent) => {
      const card = cardRef.current;
      if (!card || !(ev.target instanceof Node) || !card.contains(ev.target)) clearPress();
      else stop();
    };
    const onCancel = () => clearPress();
    const stop = () => {
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
    };
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    stopWatchingPressRef.current = stop;
  };

  /** Card click = open, unless the click (or the press that produced it) is
   *  in the actions cell. Keyboard activation of the "Open …" button has
   *  `detail === 0` and no press, so it is never blocked by a stale record. */
  const handleCardClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    clearPress();
    if (confirming) return;
    if (e.target instanceof Node && actionsCellRef.current?.contains(e.target)) return;
    if (e.detail > 0 && press.inActions) return;
    onOpen();
  };

  /** Rename / Delete. A finger tap has no hover: when it lands on the still
   *  invisible actions it only reveals them (by focusing the button) instead
   *  of starting a rename or a delete the user could not see. */
  const runAction = (e: ReactMouseEvent<HTMLButtonElement>, action: () => void) => {
    e.stopPropagation();
    const press = pressRef.current;
    clearPress(); // the press is used up here; the card never sees this click
    if (e.detail > 0 && press.touch && press.inActions && !press.actionsShown) {
      e.currentTarget.focus();
      return;
    }
    action();
  };

  const iconBtn: CSSProperties = {
    width: 28, height: 28, border: 'none', background: 'none', borderRadius: 7,
    color: T.textFaint, cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0,
  };

  return (
    <div
      ref={cardRef}
      data-testid="project-card"
      data-project-id={project.id}
      // Grid columns live in App.css (`.fg-recent-card`), not inline, so the
      // narrow-list container query can drop the chip's column.
      className={`fg-recent-card${hasFgChip ? ' fg-recent-card--chip' : ''}`}
      onClick={handleCardClick}
      onPointerDownCapture={recordPress}
      onMouseEnter={() => setHover(true)}
      // Re-asserts hover after a spurious mouseleave (WebView2 can report one
      // while the pointer is still over the card); setState bails out when
      // nothing changes, so this costs nothing while hovering.
      onMouseMove={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      style={{
        position: 'relative',
        display: 'grid', gap: 12, alignItems: 'center',
        padding: '10px 12px', borderRadius: 12,
        border: `1px solid ${highlighted ? T.borderStrong : T.border}`,
        background: highlighted ? T.surfaceHi : T.surface,
        cursor: confirming ? 'default' : 'pointer',
        transition: 'border-color 120ms ease, background 120ms ease',
      }}
    >
      {/* Keyboard / screen-reader entry point; mouse clicks anywhere on the card
          reach it too and bubble to the card's own onClick. */}
      {!confirming && (
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

      <div style={{ minWidth: 0, position: 'relative', zIndex: 1, pointerEvents: 'none' }}>
        <div title={name} style={{
          fontSize: 13.5, fontWeight: 600, color: T.text, letterSpacing: '-0.005em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {name}
        </div>
        {description ? (
          <div title={description} style={{
            marginTop: 1, fontSize: 12, color: T.textFaint,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {description}
          </div>
        ) : null}
      </div>

      {/* Failure-group chip: its own cell between the text and the time; in a
          narrow list (App.css container query) it moves under the description. */}
      {hasFgChip && (
        <span className="fg-count-cell">
          <FailureGroupChip project={project} />
        </span>
      )}

      {/* Time and actions share one cell: actions take over on hover/focus,
          but stay in the DOM (and the tab order) the whole time.
          An element with opacity < 1 forms a stacking context and paints
          above a plain sibling at opacity 1, so the hidden time label would
          otherwise sit ON TOP of the Rename / Delete buttons and a click on
          them would bubble to the card ("open"). So: the label never takes
          clicks, the buttons sit on their own layer above it and are always
          hit-testable (only their visibility follows hover/focus), and the
          whole cell is a no-open zone (see handleCardClick). */}
      <div
        ref={actionsCellRef}
        data-testid="project-card-actions"
        style={{ display: 'grid', alignItems: 'center', justifyItems: 'end', position: 'relative', zIndex: 1, cursor: 'default' }}
      >
        {!confirming && (
          <span style={{
            gridArea: '1 / 1', fontFamily: mono, fontSize: 11, color: T.textFaint, whiteSpace: 'nowrap',
            opacity: showActions ? 0 : 1, transition: 'opacity 120ms ease',
            pointerEvents: 'none',
          }}>
            {formatRelativeTime(project.lastModified)}
          </span>
        )}
        {!confirming && (
          <span style={{
            gridArea: '1 / 1', display: 'flex', gap: 2,
            position: 'relative', zIndex: 1,
            opacity: showActions ? 1 : 0,
            transition: 'opacity 120ms ease',
          }}>
            {onEditDetails && (
              <button
                type="button" title="Rename (opens Project details)" aria-label={`Rename project ${name}`}
                onClick={(e) => runAction(e, openDetails)}
                style={iconBtn}
              >
                <Pencil size={14} />
              </button>
            )}
            <button
              type="button" title="Delete project" aria-label={`Delete project ${name}`}
              onClick={(e) => runAction(e, () => setConfirming(true))}
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
            Its saved data is removed. Folders you exported are kept.
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
