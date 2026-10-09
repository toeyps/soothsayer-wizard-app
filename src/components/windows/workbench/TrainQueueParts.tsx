import { memo, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { ChevronDown, Loader2, Lock, X } from 'lucide-react';
import { SensorInline } from '../../sensor/SensorLabel';
import { sensorPlainLabel, useSensorLookup } from '../../sensor/sensorInfo';
import type { ModelKind } from '../../../types';
import { parseHealthError } from '../../../utils/completeModel';
import type {
    TrainFixTarget,
    TrainPlan,
    TrainQueueItem,
    TrainRun,
    TrainRunSummary,
} from '../../../types/trainQueue';
import {
    formatTrainSeconds,
    planTrainRun,
    roughTrainSeconds,
    TRAIN_STALE_MESSAGE,
} from '../../../utils/trainQueue';

/*
 * Train sensor / Train all with a queue (customer batch 2026-10, items 8 + 9;
 * DESIGN_SYSTEM §4.1 "Train sensor / Train all"). Presentational parts only:
 * the queue itself is `useTrainQueue` (src/hooks), owned by BuildModelWindow,
 * which trains through the window's own per-model train, one model at a time.
 *
 * Every part here reads the run it is given; none of them owns a timer, so a
 * run's progress re-renders only these parts and the list badges — never the
 * Model fit charts (they are memoised, see ModelFitPage).
 */

/** Kind names as the Workbench tabs show them (never the algorithm's name). */
export const TRAIN_KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};
const KIND_LETTER: Record<ModelKind, string> = { individual: 'I', relationship: 'R', clustering: 'C' };

/** One model as the train parts show it. */
export interface TrainRowModel {
    id: string;
    kind: ModelKind;
    /** The sensor the model belongs to (Target / X tag). */
    tag: string;
    /** Failure groups it belongs to; 0 = Not in Group. */
    groupNos: number[];
    /** Its plan right now (`classifyTrainPlan`). */
    plan: TrainPlan;
}

export interface TrainGroupInfo {
    no: number;
    name: string;
    color: string;
}

export type TrainReasonTone = 'neutral' | 'warn' | 'danger';

/** Items that belong on the segment bar: what the run set out to train. */
function plannedItems(run: TrainRun): TrainQueueItem[] {
    return run.items.filter(it => it.state !== 'removed' && !(it.state === 'skipped' && !it.skip?.atTurn));
}

/** Seconds a run still needs: the measured estimate once a model finished, else the rough per-kind time. */
function secondsLeft(run: TrainRun, timeLeftMs: number | null): number {
    if (timeLeftMs !== null) return timeLeftMs / 1000;
    return roughTrainSeconds(run.items.filter(it => it.state === 'queued' || it.state === 'running').map(it => it.kind));
}

const ITEM_WORD: Record<TrainQueueItem['state'], string> = {
    queued: 'queued',
    running: 'training now',
    trained: 'trained',
    failed: 'failed',
    skipped: 'skipped',
    removed: 'removed from run',
    notStarted: 'not started',
};

/** The run's segment bar — one segment per planned model, each with a `title`. */
function Segments({ run, rows }: { run: TrainRun; rows: ReadonlyMap<string, TrainRowModel> }) {
    const lookup = useSensorLookup();
    return (
        <div className="tq-seg" aria-hidden="true" data-testid="train-run-segments">
            {plannedItems(run).map((it, k) => {
                const m = rows.get(it.id);
                const who = m ? `${sensorPlainLabel(lookup(m.tag))} · ${TRAIN_KIND_LABEL[m.kind]}` : TRAIN_KIND_LABEL[it.kind];
                return <i key={it.id} title={`${k + 1}. ${who} — ${ITEM_WORD[it.state]}`} data-state={it.state} className={`tq-seg-i tq-seg-i--${it.state}`} />;
            })}
        </div>
    );
}

function Who({ m }: { m: TrainRowModel | undefined }) {
    if (!m) return null;
    return <span className="tq-who"><SensorInline tag={m.tag} size="sm" /> · {TRAIN_KIND_LABEL[m.kind]}</span>;
}

// ---------------------------------------------------------------------------
// Train all (above the sensor list)
// ---------------------------------------------------------------------------

export function TrainAllBar({ counts, running, reason, reasonTone, onOpen }: {
    counts: { ready: number; upToDate: number; missing: number };
    running: boolean;
    /** Why the button is disabled (`trainButtonsBlockedReason`), else null. */
    reason: string | null;
    reasonTone: TrainReasonTone;
    onOpen: () => void;
}) {
    return (
        <div className="tq-all" data-testid="train-all-bar">
            <button
                type="button"
                className="rcx-btn tq-all-btn"
                data-testid="train-all"
                disabled={running || reason !== null}
                title={reason ?? undefined}
                onClick={onOpen}
            >
                {running ? <><Loader2 size={12} className="pm-spin" aria-hidden="true" /> Training…</> : '▶ Train all'}
            </button>
            <div className="tq-all-sub" data-testid="train-all-counts">
                <span><b>{counts.ready}</b> ready</span>
                <span><b>{counts.upToDate}</b> up to date</span>
                <span><b>{counts.missing}</b> can't train</span>
            </div>
            {reason && <div className={`tq-why tq-why--${reasonTone}`} data-testid="train-all-reason" role={reasonTone === 'danger' ? 'alert' : undefined}>{reason}</div>}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Train sensor (detail header)
// ---------------------------------------------------------------------------

export interface TrainMenuItem {
    key: string;
    label: string;
    small: string;
    disabled?: boolean;
    onClick: () => void;
}

export function SensorTrainButton({ label, disabled, title, why, whyTone, onTrain, menu, buttonRef }: {
    label: ReactNode;
    disabled: boolean;
    title?: string;
    /** The line under the button (what it will do, or why it can't). */
    why: string;
    whyTone: TrainReasonTone;
    onTrain: () => void;
    /** The ▾ menu: "Re-train all models of this sensor", "Train only the … model". */
    menu: TrainMenuItem[];
    buttonRef?: Ref<HTMLButtonElement>;
}) {
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
        document.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey, true);
        };
    }, [open]);
    const menuDisabled = menu.every(m => m.disabled);
    return (
        <div className="tq-sensortrain" ref={wrap}>
            <div className="tq-split">
                <button
                    type="button"
                    ref={buttonRef}
                    className="rcx-btn rcx-btn--pri tq-split-main"
                    data-testid="train-sensor"
                    disabled={disabled}
                    title={title}
                    onClick={onTrain}
                >
                    {label}
                </button>
                <button
                    type="button"
                    className="rcx-btn rcx-btn--pri tq-split-caret"
                    data-testid="train-sensor-menu-toggle"
                    aria-label="More train options"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    disabled={menuDisabled}
                    onClick={() => setOpen(o => !o)}
                >
                    <ChevronDown size={13} aria-hidden="true" />
                </button>
                {open && (
                    <div className="tq-menu" role="menu" data-testid="train-sensor-menu">
                        {menu.map(m => (
                            <button
                                key={m.key}
                                type="button"
                                role="menuitem"
                                data-testid={`train-menu-${m.key}`}
                                disabled={m.disabled}
                                onClick={() => { setOpen(false); m.onClick(); }}
                            >
                                {m.label}
                                <small>{m.small}</small>
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div className={`tq-why tq-why--${whyTone}`} data-testid="train-sensor-why">{why}</div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Run strip (under the Step-1 card) — its own memoised component
// ---------------------------------------------------------------------------

interface RunStripProps {
    run: TrainRun;
    summary: TrainRunSummary;
    timeLeftMs: number | null;
    rows: ReadonlyMap<string, TrainRowModel>;
    onDetails: () => void;
    onCancel: () => void;
    onDismiss: () => void;
    onCloseWindow: () => void;
    onTrainNotStarted: () => void;
}

function RunStripImpl({ run, summary, timeLeftMs, rows, onDetails, onCancel, onDismiss, onCloseWindow, onTrainNotStarted }: RunStripProps) {
    const c = summary.counts;
    const details = <button type="button" className="rcx-btn rcx-btn--sm" data-testid="train-run-details" onClick={onDetails}>Details</button>;

    if (run.phase === 'running') {
        const current = run.currentId ? rows.get(run.currentId) : undefined;
        const head = run.stopRequested === 'close'
            ? 'Closing after this model…'
            : run.stopRequested === 'cancel' ? 'Stopping after this model…' : summary.text;
        return (
            <div className="tq-run" data-tone="neutral" data-phase="running" role="status" aria-live="polite" data-testid="train-run-strip">
                <Loader2 size={14} className="pm-spin tq-ico" aria-hidden="true" />
                <div className="tq-l1">
                    <b data-testid="train-run-text">{head}</b>
                    <Who m={current} />
                    <span className="tq-eta" data-testid="train-run-eta">≈ {formatTrainSeconds(secondsLeft(run, timeLeftMs))} left</span>
                </div>
                <Segments run={run} rows={rows} />
                <div className="tq-acts">
                    {details}
                    <button type="button" className="rcx-btn rcx-btn--sm tq-cancel" data-testid="train-run-cancel" disabled={run.stopRequested !== null} onClick={onCancel}>Cancel</button>
                </div>
            </div>
        );
    }

    if (run.phase === 'stale') {
        return (
            <div className="tq-run" data-tone="danger" data-phase="stale" role="alert" data-testid="train-run-strip">
                <span className="tq-ico" aria-hidden="true">■</span>
                <div className="tq-l1">
                    <b data-testid="train-run-text">Run stopped: the data changed</b>
                    <span className="tq-who tq-who--wrap" data-testid="train-run-stale">
                        {TRAIN_STALE_MESSAGE} The {c.trained} trained before the change {c.trained === 1 ? 'is' : 'are'} kept; {c.notStarted} not started.
                    </span>
                </div>
                <Segments run={run} rows={rows} />
                <div className="tq-acts">
                    {details}
                    <button type="button" className="rcx-btn rcx-btn--sm tq-cancel" data-testid="train-run-close-window" onClick={onCloseWindow}>Close window</button>
                </div>
            </div>
        );
    }

    const icon = summary.tone === 'success' ? '✓' : summary.tone === 'warning' ? '⚠' : summary.tone === 'danger' ? '✕' : '■';
    return (
        <div className="tq-run" data-tone={summary.tone} data-phase={run.phase} role="status" data-testid="train-run-strip">
            <span className="tq-ico" aria-hidden="true">{icon}</span>
            <div className="tq-l1">
                <b data-testid="train-run-text">{summary.text}</b>
                {c.trained > 0 && <span className="tq-who">Trained models still need their health set points, then Mark complete.</span>}
            </div>
            <Segments run={run} rows={rows} />
            <div className="tq-acts">
                {c.notStarted > 0 && (
                    <button type="button" className="rcx-btn rcx-btn--sm" data-testid="train-run-not-started" onClick={onTrainNotStarted}>
                        ▶ Train the {c.notStarted} not started
                    </button>
                )}
                {details}
                <button type="button" className="rcx-btn rcx-btn--sm" data-testid="train-run-dismiss" onClick={onDismiss}>Dismiss</button>
            </div>
        </div>
    );
}

/** Re-renders only when the run, its estimate or the rows change (not on every window render). */
export const RunStrip = memo(RunStripImpl);

// ---------------------------------------------------------------------------
// Locked settings / queued body / Health score banner
// ---------------------------------------------------------------------------

/** "Model settings" while the model is queued or training: read-only, with "Remove from run" when queued. */
export function LockedSettingsHeader({ summary, queued, onRemove }: { summary: string; queued: boolean; onRemove: () => void }) {
    return (
        <div className="bmw-sets tq-sets-lock" data-testid="settings-locked">
            <div className="bmw-sets-h tq-sets-h">
                <Lock size={12} aria-hidden="true" />
                <b>Model settings</b>
                <span className="bmw-sets-sum">{summary}</span>
                <span className="tq-lk">
                    Locked while this model is in the run
                    {queued && <> · <button type="button" data-testid="remove-from-run" onClick={onRemove}>Remove from run</button></>}
                </span>
            </div>
        </div>
    );
}

/** The Model fit body of a model still waiting in the run. */
export function QueuedCard({ kind, position, waitSeconds, current }: {
    kind: ModelKind;
    /** 1 = next. */
    position: number;
    waitSeconds: number;
    current?: TrainRowModel;
}) {
    return (
        <div className="bmw-stage">
            <div className="tq-qcard" data-testid="queued-card">
                <span className="tq-qring-big" aria-hidden="true">{KIND_LETTER[kind]}</span>
                <b>Queued · {position === 1 ? 'next' : `#${position} in line`}</b>
                <span className="tq-pos">≈ {formatTrainSeconds(waitSeconds)} until it starts</span>
                {current && <span className="tq-qnow">Training now: <SensorInline tag={current.tag} size="sm" /> · {TRAIN_KIND_LABEL[current.kind]}</span>}
                <span className="tq-qnote">Its settings are locked until it has trained. The charts appear here when it finishes.</span>
            </div>
        </div>
    );
}

/** Health score page, after a run: "N trained in this run need set points (M in total)". */
export function RunSetPointsBanner({ at, inRun, total, position, onNext, nextDisabled }: {
    at: number;
    inRun: number;
    total: number;
    /** 1-based place of the open model among them, or 0 when it is not one of them. */
    position: number;
    onNext: () => void;
    nextDisabled: boolean;
}) {
    const t = new Date(at);
    const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    return (
        <div className="tq-hbanner" role="status" data-testid="run-setpoints-banner">
            <span className="tq-ok" aria-hidden="true">✓</span>
            <span className="tq-hbanner-t">
                <b>Trained in the run at {hhmm}.</b>{' '}
                <span data-testid="run-setpoints-text">{inRun} trained in this run {inRun === 1 ? 'needs' : 'need'} set points ({total} in total)</span>
                {position > 0 ? `; this is ${position} of ${inRun}` : ''}. Set them here, then Mark complete.
            </span>
            <button type="button" className="rcx-btn rcx-btn--sm" data-testid="next-needing-set-points" disabled={nextDisabled} onClick={onNext}>
                Next needing set points ›
            </button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Train all modal: preflight, then the run's details
// ---------------------------------------------------------------------------

interface RowStatus {
    tone: 'ready' | 'up' | 'cant' | 'now' | 'done' | 'err';
    text: string;
}

/** A train error as the run's details show it: the app's own wording for a known
 *  code, first line only, capped — never a raw multi-line traceback. The full
 *  text stays in the tooltip. */
export function shortTrainError(raw: string): string {
    const line = parseHealthError(raw).message.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
    return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function QRow({ m, st, act, err }: { m: TrainRowModel; st: RowStatus; act?: ReactNode; err?: string }) {
    return (
        <div className={`tq-qrow tq-qrow--${st.tone}`} data-testid={`train-row-${m.id}`}>
            <span className={`f4-kb model-kind-icon--${m.kind}`} aria-hidden="true">{KIND_LETTER[m.kind]}</span>
            <div className="tq-qrow-name">
                <div className="tq-nm"><SensorInline tag={m.tag} /></div>
                <div className="tq-sub">{TRAIN_KIND_LABEL[m.kind]}{m.kind === 'relationship' ? ' · ≈ 15 s' : ''}</div>
            </div>
            <span className={`tq-st tq-st--${st.tone}`} data-testid={`train-row-status-${m.id}`}>{st.text}</span>
            <span className="tq-act">{act}</span>
            {err && <div className="tq-err" title={err}>{shortTrainError(err)}</div>}
        </div>
    );
}

/** Rows grouped by failure group; a model in several groups is listed once, in its first. */
function ByGroup({ rows, groups, render }: { rows: TrainRowModel[]; groups: TrainGroupInfo[]; render: (m: TrainRowModel) => ReactNode }) {
    const seen = new Set<string>();
    return (
        <>
            {groups.map(g => {
                const ms = rows.filter(m => m.groupNos.includes(g.no) && !seen.has(m.id));
                if (ms.length === 0) return null;
                for (const m of ms) seen.add(m.id);
                return (
                    <div key={g.no} className="tq-grp" data-testid={`train-group-${g.no}`}>
                        <div className="tq-grpt"><i style={{ background: g.color }} />{g.no === 0 ? 'Not in Group' : `FG-${g.no} · ${g.name}`}</div>
                        {ms.map(m => <div key={m.id}>{render(m)}</div>)}
                    </div>
                );
            })}
        </>
    );
}

const skipStatus = (it: TrainQueueItem): RowStatus =>
    it.skip?.kind === 'upToDate'
        ? { tone: 'up', text: `Skipped — ${it.skip.reason}` }
        : { tone: 'cant', text: `Skipped — ${it.skip?.reason ?? 'missing settings'}` };

export interface TrainAllModalProps {
    /** `preflight` before a run; `run` = the current / last run's details. */
    view: 'preflight' | 'run';
    run: TrainRun | null;
    summary: TrainRunSummary | null;
    rows: TrainRowModel[];
    groups: TrainGroupInfo[];
    includeUpToDate: boolean;
    onIncludeUpToDate: (v: boolean) => void;
    onClose: () => void;
    onStart: () => void;
    onCancelRun: () => void;
    onFix: (id: string, fix: TrainFixTarget) => void;
    onOpenModel: (id: string) => void;
    onRetry: (id: string) => void;
    onTrainNotStarted: () => void;
    onRemoveFromRun: (id: string) => void;
}

export function TrainAllModal(props: TrainAllModalProps) {
    const { view, run, summary, rows, groups, includeUpToDate, onClose } = props;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    let head: ReactNode;
    let body: ReactNode;
    let foot: ReactNode;
    const running = run?.phase === 'running';

    if (view === 'preflight' || !run || !summary) {
        const planned = planTrainRun(rows.map(r => ({ id: r.id, kind: r.kind, plan: r.plan })), includeUpToDate);
        const willRun = planned.filter(it => it.state === 'queued');
        const upToDate = rows.filter(r => r.plan.kind === 'upToDate');
        const completeUp = upToDate.filter(r => r.plan.kind === 'upToDate' && r.plan.complete).length;
        const cant = rows.filter(r => r.plan.kind === 'missing');
        const secs = roughTrainSeconds(willRun.map(it => it.kind));
        head = (
            <div>
                Train all models
                <small>Runs one model at a time, by sensor. You can keep working; models already trained are kept if you cancel.</small>
            </div>
        );
        body = (
            <>
                <div className="tq-sumrow" data-testid="train-all-summary">
                    <span className="tq-big"><b>{willRun.length}</b> will train</span>
                    {willRun.length > 0 && <span>· ≈ {formatTrainSeconds(secs)}</span>}
                    <span>· <b>{includeUpToDate ? 0 : upToDate.length}</b> up to date, skipped</span>
                    <span>· <b className="tq-amber">{cant.length}</b> can't train — fix, then run again</span>
                </div>
                <ByGroup rows={rows} groups={groups} render={m => {
                    const p = m.plan;
                    if (p.kind === 'missing') {
                        return <QRow m={m} st={{ tone: 'cant', text: `Can't train — ${p.reason}` }} act={<button type="button" className="tq-link" data-testid={`train-fix-${m.id}`} onClick={() => props.onFix(m.id, p.fix)}>Fix →</button>} />;
                    }
                    if (p.kind === 'upToDate') {
                        return <QRow m={m} st={includeUpToDate ? { tone: 'ready', text: 'Re-train' } : { tone: 'up', text: `Skipped — ${p.reason}` }} />;
                    }
                    return <QRow m={m} st={{ tone: 'ready', text: 'Ready' }} />;
                }} />
                {upToDate.length > 0 && (
                    <label className="tq-opt">
                        <input type="checkbox" data-testid="train-include-up-to-date" checked={includeUpToDate} onChange={e => props.onIncludeUpToDate(e.target.checked)} />
                        <span>
                            Also re-train the <b>{upToDate.length}</b> up-to-date model{upToDate.length === 1 ? '' : 's'}.
                            {includeUpToDate && completeUp > 0 && (
                                <span className="tq-amber" data-testid="train-complete-warning"> {completeUp} Complete model{completeUp === 1 ? '' : 's'} will become Incomplete and need Mark complete again.</span>
                            )}
                        </span>
                    </label>
                )}
            </>
        );
        foot = (
            <>
                <span className={`tq-reason${willRun.length ? '' : ' tq-reason--warn'}`} data-testid="train-all-foot">
                    {willRun.length
                        ? `Trains ${willRun.length} model${willRun.length === 1 ? '' : 's'}${cant.length ? `; the ${cant.length} with missing settings stay as they are` : ''}.`
                        : 'Nothing is ready to train — fix the settings listed above first.'}
                </span>
                <button type="button" className="rcx-btn" onClick={onClose}>Cancel</button>
                <button type="button" className="rcx-btn rcx-btn--pri" data-testid="train-all-start" disabled={willRun.length === 0} onClick={props.onStart}>
                    ▶ Start · {willRun.length}
                </button>
            </>
        );
    } else {
        const byId = new Map(run.items.map(it => [it.id, it]));
        const inRun = rows.filter(r => byId.has(r.id));
        const c = summary.counts;
        if (running) {
            head = (
                <div>
                    {summary.text}
                    <small>{run.stopRequested ? 'Stopping after the current model.' : 'One model at a time. Cancel stops after the current model; nothing already trained is lost.'}</small>
                </div>
            );
            body = <ByGroup rows={inRun} groups={groups} render={m => {
                const it = byId.get(m.id) as TrainQueueItem;
                if (it.state === 'skipped') return <QRow m={m} st={skipStatus(it)} />;
                const st: RowStatus = it.state === 'trained' ? { tone: 'done', text: '✓ Trained' }
                    : it.state === 'failed' ? { tone: 'err', text: '✕ Failed' }
                    : it.state === 'running' ? { tone: 'now', text: 'Training…' }
                    : it.state === 'removed' ? { tone: 'up', text: 'Removed from run' }
                    : it.state === 'notStarted' ? { tone: 'up', text: 'Not started' }
                    : { tone: 'up', text: 'Queued' };
                const act = it.state === 'queued' && !run.stopRequested
                    ? <button type="button" className="tq-link" data-testid={`train-remove-${m.id}`} onClick={() => props.onRemoveFromRun(m.id)}>Remove from run</button>
                    : undefined;
                return <QRow m={m} st={st} err={it.error} act={act} />;
            }} />;
            foot = (
                <>
                    <span className="tq-reason">Each model trains with its saved settings; a Complete model that is re-trained becomes Incomplete.</span>
                    <button type="button" className="rcx-btn tq-cancel" data-testid="train-all-cancel-run" disabled={run.stopRequested !== null} onClick={props.onCancelRun}>Cancel run</button>
                </>
            );
        } else {
            const stale = run.phase === 'stale';
            head = (
                <div>
                    {stale ? 'Run stopped: the data changed' : run.phase === 'stopped' ? 'Run stopped' : 'Run finished'}
                    <small>{summary.text}</small>
                </div>
            );
            body = <ByGroup rows={inRun} groups={groups} render={m => {
                const it = byId.get(m.id) as TrainQueueItem;
                if (it.state === 'skipped') {
                    const st = skipStatus(it);
                    const fix = m.plan.kind === 'missing' ? m.plan.fix : null;
                    return <QRow m={m} st={st} act={st.tone === 'cant' && fix ? <button type="button" className="tq-link" data-testid={`train-fix-${m.id}`} onClick={() => props.onFix(m.id, fix)}>Fix →</button> : undefined} />;
                }
                const st: RowStatus = it.state === 'trained' ? { tone: 'done', text: '✓ Trained · set points needed' }
                    : it.state === 'failed' ? { tone: 'err', text: '✕ Failed' }
                    : it.state === 'removed' ? { tone: 'up', text: 'Removed from run' }
                    : { tone: 'up', text: 'Not started' };
                const act = stale ? undefined
                    : it.state === 'failed' ? <button type="button" className="tq-link" data-testid={`train-retry-${m.id}`} onClick={() => props.onRetry(m.id)}>Try again</button>
                    : it.state === 'trained' ? <button type="button" className="tq-link" data-testid={`train-open-${m.id}`} onClick={() => props.onOpenModel(m.id)}>Open →</button>
                    : undefined;
                return <QRow m={m} st={st} act={act} err={it.error} />;
            }} />;
            foot = (
                <>
                    <span className={`tq-reason${stale ? ' tq-reason--danger' : ''}`}>
                        {stale ? TRAIN_STALE_MESSAGE : 'Trained models are not Complete yet: set the health set points on each one, then Mark complete.'}
                    </span>
                    {c.notStarted > 0 && !stale && (
                        <button type="button" className="rcx-btn" data-testid="train-all-not-started" onClick={props.onTrainNotStarted}>▶ Train the {c.notStarted} not started</button>
                    )}
                    <button type="button" className="rcx-btn" onClick={onClose}>Close</button>
                </>
            );
        }
    }

    return (
        <div className="bmw-modal-backdrop" role="presentation" onMouseDown={onClose}>
            <div
                className="bmw-modal tq-modal"
                role="dialog"
                aria-modal="true"
                aria-label={view === 'preflight' ? 'Train all models' : 'Training run'}
                data-testid="train-all-modal"
                data-view={view === 'preflight' || !run ? 'preflight' : running ? 'running' : 'done'}
                onMouseDown={e => e.stopPropagation()}
            >
                <div className="tq-mh">
                    {head}
                    <button type="button" className={running ? 'rcx-btn rcx-btn--sm' : 'bmw-modal-x'} data-testid="train-all-close" aria-label={running ? 'Hide' : 'Close'} onClick={onClose}>
                        {running ? 'Hide' : <X size={16} />}
                    </button>
                </div>
                <div className="tq-mb">{body}</div>
                <div className="tq-mf">{foot}</div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Close while a run is active
// ---------------------------------------------------------------------------

/** In-window alertdialog. Numbers are live; if the run ends while it is open it
 *  becomes "Run finished — close?" with one Close. "Keep training" is the default. */
export function CloseRunDialog({ run, summary, current, onKeep, onStopAndClose, onClose }: {
    run: TrainRun;
    summary: TrainRunSummary;
    current?: TrainRowModel;
    onKeep: () => void;
    onStopAndClose: () => void;
    onClose: () => void;
}) {
    const keepRef = useRef<HTMLButtonElement>(null);
    const finished = run.phase !== 'running';
    useEffect(() => { keepRef.current?.focus(); }, [finished]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onKeep(); } };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onKeep]);
    const c = summary.counts;
    return (
        <div className="bmw-modal-backdrop tq-close-back" role="presentation">
            <div className="tq-confirm" role="alertdialog" aria-modal="true" aria-labelledby="tq-close-title" aria-describedby="tq-close-body" data-testid="close-run-dialog" data-finished={finished}>
                {finished ? (
                    <>
                        <div className="tq-cb" id="tq-close-body">
                            <b className="tq-ct" id="tq-close-title">Run finished — close?</b>
                            <span data-testid="close-run-numbers">
                                <b>{c.trained}</b> trained{c.failed ? ` · ${c.failed} failed` : ''}{c.notStarted ? ` · ${c.notStarted} not started` : ''}. Trained models keep their results.
                            </span>
                        </div>
                        <div className="tq-cf">
                            <button type="button" ref={keepRef} className="rcx-btn rcx-btn--pri" data-testid="close-run-close" onClick={onClose}>Close</button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="tq-cb" id="tq-close-body">
                            <b className="tq-ct" id="tq-close-title">Training is still running</b>
                            <span data-testid="close-run-numbers">
                                {summary.text}
                                {current ? <>: <SensorInline tag={current.tag} size="sm" /> · {TRAIN_KIND_LABEL[current.kind]}</> : null}
                                {current?.kind === 'relationship' ? ' · up to about 15 s on this model' : ''}.
                                {' '}{c.trained} trained so far.
                            </span>
                            <span>
                                Closing stops the run <b>after this model</b> — a model in training is never cut off half-way. Trained models are kept; the {c.queued} not started stay as they are and can be trained next time.
                            </span>
                        </div>
                        <div className="tq-cf">
                            <button type="button" className="rcx-btn tq-cancel tq-cf-left" data-testid="close-run-stop" onClick={onStopAndClose}>Stop after this model and close</button>
                            <button type="button" ref={keepRef} className="rcx-btn rcx-btn--pri" data-testid="close-run-keep" onClick={onKeep}>Keep training</button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
