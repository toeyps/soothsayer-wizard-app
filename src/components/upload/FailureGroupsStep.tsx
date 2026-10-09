import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { mono, type Tokens } from './uploadTheme';
// Only the small toast module and pure helpers come from the Dashboard folder:
// this page is in the start-up bundle, the Dashboard is loaded lazily.
import UndoToastStack, { UNDO_SECONDS } from '../dashboard/UndoToastStack';
import { NOT_IN_GROUP, type FailureGroupDraft } from '../dashboard/failureGroupOps';
import { getFgGroupColor } from '../../utils/failureGroupColor';

/** One failure group typed on setup step 3 — not saved yet. "Open Dashboard"
 *  turns the list into the workspace's groups through the same helpers the
 *  Dashboard's Failure Groups tab uses (`buildInitialFailureGroups`). */
export interface DraftGroup extends FailureGroupDraft {
  /** Local key only (React key, undo); never saved. */
  id: number;
}

interface FailureGroupsStepProps {
  T: Tokens;
  projectName: string;
  groups: DraftGroup[];
  onChange: (groups: DraftGroup[]) => void;
  /** True while a card shows a name it could not save (a duplicate). The page
   *  disables Open Dashboard meanwhile, so the old name is never saved
   *  silently in its place. */
  onInvalidChange?: (invalid: boolean) => void;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** "Not in Group" is the permanent built-in group: no draft may take its name. */
const isReserved = (name: string) => sameName(name, NOT_IN_GROUP.name);
const duplicateMessage = (name: string) => `A failure group named "${name.trim()}" already exists`;

interface RemovedEntry {
  id: string;
  message: string;
  group: DraftGroup;
  index: number;
}

/**
 * Step 3 of the Import page, "Which failures should Wizard look for?"
 * (customer batch 2026-10, item 5; DESIGN_SYSTEM §4.1 "Failure groups come
 * first"). Names the failure modes only — sensors are assigned later in the
 * Dashboard, where the data can be seen.
 *
 *  - Quick-add field: Enter adds a group and keeps focus, so several can be
 *    typed in a row; a duplicate name turns the field red and says why.
 *  - One card per group: Name (inline; Enter / blur saves, Esc puts the old
 *    name back, a duplicate stays red), Description, Recommendation.
 *  - ✕ removes a group with a 7 s Undo toast (the app's shared undo toast).
 *
 * The footer (Back · Skip for now · Open Dashboard) belongs to the page.
 */
export default function FailureGroupsStep({ T, projectName, groups, onChange, onInvalidChange }: FailureGroupsStepProps) {
  const [quick, setQuick] = useState('');
  const [live, setLive] = useState('');
  const [newestId, setNewestId] = useState<number | null>(null);
  const [removed, setRemoved] = useState<RemovedEntry[]>([]);
  const quickRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const removeSeq = useRef(0);
  // Draft ids come from a counter that only goes up, never from the list: a
  // removed group waiting for Undo keeps its id, so a group added meanwhile
  // must not get the same one (duplicate React keys, patch/remove hitting both).
  const idSeq = useRef(Math.max(0, ...groups.map(g => g.id)));
  // Cards showing a name they could not save.
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<number>>(() => new Set());
  const setCardInvalid = useCallback((id: number, invalid: boolean) => {
    setInvalidIds(prev => {
      if (prev.has(id) === invalid) return prev;
      const next = new Set(prev);
      if (invalid) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const onInvalidChangeRef = useRef(onInvalidChange);
  onInvalidChangeRef.current = onInvalidChange;
  useEffect(() => { onInvalidChangeRef.current?.(invalidIds.size > 0); }, [invalidIds]);
  // Leaving the step (Back) drops the unsaved text with the cards.
  useEffect(() => () => { onInvalidChangeRef.current?.(false); }, []);
  // Latest list for the undo handler (the toast outlives the render that made it).
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const duplicate = quick.trim() !== '' && (isReserved(quick) || groups.some(g => sameName(g.name, quick)));
  const canAdd = quick.trim() !== '' && !duplicate;

  // Arriving on the step puts the cursor in the quick-add field, so typing starts at once.
  useEffect(() => { quickRef.current?.focus(); }, []);

  const add = () => {
    if (!canAdd) return;
    const name = quick.trim();
    const id = ++idSeq.current;
    onChange([...groups, { id, name, description: '', recommendation: '' }]);
    setNewestId(id);
    setQuick('');
    setLive(`Added ${name}. ${groups.length + 1} group${groups.length + 1 === 1 ? '' : 's'}.`);
    quickRef.current?.focus();
  };

  const remove = (id: number) => {
    const index = groups.findIndex(g => g.id === id);
    if (index < 0) return;
    const group = groups[index];
    onChange(groups.filter(g => g.id !== id));
    setCardInvalid(id, false);
    setRemoved(prev => [...prev, { id: `fgs-undo-${++removeSeq.current}`, message: `Removed ${group.name}`, group, index }]);
    setLive(`Removed ${group.name}.`);
    // Focus the next card's name, else the previous one, else the quick-add field.
    requestAnimationFrame(() => {
      const names = listRef.current?.querySelectorAll<HTMLInputElement>('[data-fg-step-name]');
      const target = names?.[index] ?? names?.[index - 1];
      (target ?? quickRef.current)?.focus();
    });
  };

  const dismissRemoved = useCallback((toastId: string) => {
    setRemoved(prev => prev.filter(r => r.id !== toastId));
  }, []);

  const undoRemove = useCallback((toastId: string) => {
    const entry = removed.find(r => r.id === toastId);
    dismissRemoved(toastId);
    if (!entry) return;
    const current = groupsRef.current;
    // A group with the same name was typed again meanwhile: nothing to restore.
    if (current.some(g => sameName(g.name, entry.group.name))) return;
    const next = current.slice();
    next.splice(Math.min(entry.index, next.length), 0, entry.group);
    onChange(next);
    setLive(`Restored ${entry.group.name}.`);
  }, [removed, dismissRemoved, onChange]);

  const patch = (id: number, p: Partial<FailureGroupDraft>) =>
    onChange(groups.map(g => (g.id === id ? { ...g, ...p } : g)));

  return (
    <div data-testid="failure-groups-step">
      <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.textFaint }}>
        Step 3 of 3 · {projectName.trim()}
      </div>
      <h2 style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 700, letterSpacing: '-0.025em', color: T.text }}>
        Which failures should Wizard look for?
      </h2>
      <p style={{ margin: '8px 0 20px', maxWidth: '62ch', fontSize: 13.5, lineHeight: 1.5, color: T.textMuted }}>
        A failure group is one way this machine can fail. Name each one now; you will pick the sensors that show it in the Dashboard, where you can see the data.
      </p>

      <div className="fg-step-quick">
        <input
          ref={quickRef}
          className={`fg-step-input${duplicate ? ' is-bad' : ''}`}
          value={quick}
          placeholder="Failure group name, e.g. Bearing overheating (NDE)"
          aria-label="New failure group name"
          aria-invalid={duplicate || undefined}
          aria-describedby="fg-step-quick-hint"
          autoComplete="off"
          onChange={e => setQuick(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
            else if (e.key === 'Escape') setQuick('');
          }}
        />
        <button
          type="button"
          className="fg-step-btn"
          disabled={!canAdd}
          onClick={add}
        >
          + Add group
        </button>
      </div>
      {duplicate ? (
        <div id="fg-step-quick-hint" className="fg-step-hint is-bad" role="alert">{duplicateMessage(quick)}.</div>
      ) : (
        <div id="fg-step-quick-hint" className="fg-step-hint">
          <span className="fg-step-kbd">Enter</span> adds the group and keeps the cursor here, so you can type the next one straight away.
        </div>
      )}

      {groups.length === 0 ? (
        <div className="fg-step-empty" data-testid="fg-step-empty">
          <b>No failure groups yet</b>
          <p>Type the first failure mode above. Description and recommended action can be added on each group afterwards.</p>
          <p className="fg-step-example">Bearing overheating · Lube oil pressure low · Cooling water loss</p>
        </div>
      ) : (
        <div className="fg-step-list" ref={listRef} aria-label="Failure groups">
          {groups.map((g, i) => (
            <GroupCard
              key={g.id}
              group={g}
              index={i}
              isNew={g.id === newestId}
              isDuplicateName={(v) => isReserved(v) || groups.some(o => o.id !== g.id && sameName(o.name, v))}
              onInvalidChange={(invalid) => setCardInvalid(g.id, invalid)}
              onPatch={(p) => patch(g.id, p)}
              onRemove={() => remove(g.id)}
            />
          ))}
        </div>
      )}
      <div className="sr-only" aria-live="polite" data-testid="fg-step-live">{live}</div>
      <UndoToastStack
        toasts={removed}
        onUndo={undoRemove}
        onExpire={dismissRemoved}
        durationMs={UNDO_SECONDS * 1000}
      />
    </div>
  );
}

/** Grows a one-line textarea to fit its text (notes may run to several lines). */
function grow(t: HTMLTextAreaElement | null) {
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = `${Math.max(30, t.scrollHeight)}px`;
}

function GroupCard({ group, index, isNew, isDuplicateName, onInvalidChange, onPatch, onRemove }: {
  group: DraftGroup;
  index: number;
  isNew: boolean;
  isDuplicateName: (name: string) => boolean;
  onInvalidChange: (invalid: boolean) => void;
  onPatch: (p: Partial<FailureGroupDraft>) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [error, setError] = useState('');
  // A name restored by Undo (or changed by the parent) shows up here too.
  useEffect(() => { setName(group.name); }, [group.name]);
  // The step disables Open Dashboard while this card holds an unsaved name.
  const onInvalidChangeRef = useRef(onInvalidChange);
  onInvalidChangeRef.current = onInvalidChange;
  useEffect(() => { onInvalidChangeRef.current(error !== ''); }, [error]);

  const commit = () => {
    const v = name.trim();
    if (!v) { setName(group.name); setError(''); return; }
    if (isDuplicateName(v)) { setError(duplicateMessage(v)); return; }
    setError('');
    if (v !== group.name) onPatch({ name: v });
  };
  // Numbered by position: this is the FG-n the group gets when the Dashboard opens.
  const label = `FG-${index + 1}`;
  const errorId = `fgstep-err${group.id}`;
  return (
    <div className={`fg-step-card fg-group-color-${getFgGroupColor(index + 1)}${isNew ? ' is-new' : ''}`} data-testid="fg-step-card">
      <span className="fg-group-dot fg-step-dot" aria-hidden="true" />
      <div style={{ minWidth: 0 }}>
        <div className="fg-step-nm">
          <span className="fg-step-no">{label}</span>
          <input
            data-fg-step-name=""
            className={`fg-step-name${error ? ' is-bad' : ''}`}
            value={name}
            aria-label={`Name of ${label}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={e => { setName(e.target.value); setError(''); }}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              else if (e.key === 'Escape') { e.preventDefault(); setName(group.name); setError(''); }
            }}
          />
        </div>
        {error && <div id={errorId} className="fg-step-hint is-bad fg-step-hint--card" role="alert">{error}</div>}
        <div className="fg-step-fields">
          <div className="fg-step-field">
            <label htmlFor={`fg-step-d${group.id}`}>Description</label>
            <textarea
              id={`fg-step-d${group.id}`}
              ref={grow}
              className="fg-step-ta"
              rows={1}
              value={group.description}
              placeholder="What failure mode does this group track?"
              onChange={e => { grow(e.target); onPatch({ description: e.target.value }); }}
            />
          </div>
          <div className="fg-step-field">
            <label htmlFor={`fg-step-r${group.id}`}>Recommendation</label>
            <textarea
              id={`fg-step-r${group.id}`}
              ref={grow}
              className="fg-step-ta"
              rows={1}
              value={group.recommendation}
              placeholder="Recommended action when this failure is found"
              onChange={e => { grow(e.target); onPatch({ recommendation: e.target.value }); }}
            />
          </div>
        </div>
      </div>
      <button type="button" className="fg-step-remove" title="Remove group" aria-label={`Remove ${group.name}`} onClick={onRemove}>
        <X size={14} />
      </button>
    </div>
  );
}
