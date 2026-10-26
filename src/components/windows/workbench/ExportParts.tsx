import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Download, FileJson, FileSpreadsheet, Folder, Info, Loader2, TriangleAlert, X } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { SensorInline } from '../../sensor/SensorLabel';
import type { ModelKind } from '../../../types';
import type { ExportIssue, ExportModelSpec, ExportPlanModel } from '../../../types/export';
import type { UseWorkspaceExport, WorkspaceExportPhase, WorkspaceExportProgressState } from '../../../hooks/useWorkspaceExport';
import type { ExportReadiness, ExportReadinessItem, ExportReadinessRow, NoComponentSensor } from '../../../utils/exportReadiness';
import { exportFolderName, revealExportFolder } from '../../../utils/workspaceExport';
import { fmtOffset } from '../../../utils/projectDetails';
import { MODEL_KIND_LABEL } from '../../../utils/modelNames';
import { isPickerSurfaceOpen } from '../../sensor/SensorPicker';
import { focusableIn } from '../useModalFocus';

/*
 * Export results (design 2026-10-20, DESIGN_SYSTEM §4.2): the Build Model
 * window's bottom bar (`ExportBar`, variant C) and the Export dialog
 * (`ExportModal`): readiness checklist → Save to → What is written (Peek) →
 * confirm sensors without a component → writing → done / failed / cancelled.
 *
 * Everything shown comes from real data: the checklist from `exportReadiness`
 * (the window's view of the workspace), the files / rows / Peek from the Rust
 * dry run (`exportPlan`), and the run itself from `useWorkspaceExport`.
 */

const KIND_LETTER: Record<ModelKind, string> = { individual: 'I', relationship: 'R', clustering: 'C' };
const pad2 = (n: number) => String(n).padStart(2, '0');
/** The app's one date format: "2026/10/20 11:40". */
export const fmtExportDate = (d: Date): string =>
    `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "≈ 412 KB" / "≈ 1.4 MB". */
export function fmtBytes(n: number): string {
    if (n < 1000) return `${n} B`;
    if (n < 1_000_000) return `${Math.max(1, Math.round(n / 1000))} KB`;
    return `${(n / 1_000_000).toFixed(1)} MB`;
}
const fmtCount = (n: number) => n.toLocaleString('en-US');
/** "All 5 models Complete" / "1 model Complete". */
const allComplete = (n: number) => (n === 1 ? '1 model Complete' : `All ${n} models Complete`);
/** One CSV line of the Peek (cells with a comma or a quote are quoted, as the file does). */
const csvLine = (cells: readonly string[]) => cells.map(c => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');

/** The bar's "exported" line: lives for the window's life (the window clears it). */
export interface ExportedLine {
    models: number;
    folder: string;
    at: Date;
}

// ---------------------------------------------------------------------------
// The workspace status bar (variant C)
// ---------------------------------------------------------------------------

export function ExportBar({ counts, phase, progress, exported, filled, blockedWhy, onExport, onShowWhich, onShowRun, onOpenFolder }: {
    counts: ExportReadiness['counts'];
    phase: WorkspaceExportPhase;
    progress: WorkspaceExportProgressState | null;
    exported: ExportedLine | null;
    /** Export results is the next step and nothing else on screen is filled. */
    filled: boolean;
    /** Something outside the export stops it right now (a training run). */
    blockedWhy: string | null;
    onExport: () => void;
    onShowWhich: () => void;
    onShowRun: () => void;
    onOpenFolder: () => void;
}) {
    const { total, notReady, toFix, allReady } = counts;
    const running = phase === 'running';
    let state: ReactNode;
    let tone: 'plain' | 'warn' | 'ok' | 'now' | 'bad' = 'plain';
    if (running) {
        tone = 'now';
        const all = progress?.total || total;
        const written = progress?.written ?? 0;
        state = (
            <>
                <Loader2 size={12} className="pm-spin" aria-hidden="true" />
                <span className="exb-t"><b>Writing model {Math.min(written + 1, all)} of {all}</b></span>
                <span className="exb-bar" aria-hidden="true"><span style={{ width: `${all ? (written / all) * 100 : 0}%` }} /></span>
                <button type="button" className="tq-link" onClick={onShowRun}>Show</button>
            </>
        );
    } else if (phase === 'failed') {
        tone = 'bad';
        state = (
            <>
                <TriangleAlert size={12} aria-hidden="true" />
                <span className="exb-t"><b>Export failed</b> · nothing was written</span>
                <button type="button" className="tq-link" onClick={onShowRun}>Show</button>
            </>
        );
    } else if (exported) {
        tone = 'ok';
        state = (
            <>
                <Check size={12} aria-hidden="true" />
                <span className="exb-t" data-testid="export-bar-exported">
                    <b>{plural(exported.models, 'model')} exported</b> {fmtExportDate(exported.at)} · <span className="exb-path" title={exported.folder}>{exported.folder}</span>
                </span>
                <button type="button" className="tq-link" onClick={onOpenFolder}>Open folder</button>
            </>
        );
    } else if (total === 0) {
        state = <span className="exb-t">No models yet</span>;
    } else if (allReady) {
        tone = 'ok';
        state = (
            <>
                <Check size={12} aria-hidden="true" />
                <span className="exb-t"><b>{allComplete(total)}</b> · ready to export</span>
            </>
        );
    } else {
        tone = 'warn';
        const first = notReady > 0 ? `${plural(notReady, 'model')} not Complete yet` : allComplete(total);
        const second = toFix > 0 ? `${plural(toFix, 'item')} to fill in` : '';
        state = (
            <>
                <span className="exb-t"><b className="exb-n">{first}</b>{second ? ` · ${second}` : ''}</span>
                <button type="button" className="tq-link" onClick={onShowWhich}>Show which</button>
            </>
        );
    }
    const why = total === 0 ? 'No models to export yet'
        : running ? 'An export is running'
        : blockedWhy
        ?? (allReady ? null : notReady > 0 ? `Every model must be Complete first · ${notReady} left` : 'Fill in the items in “Show which” first');
    return (
        <div className={`exb exb--${tone}`} data-testid="export-bar">
            <div className="exb-state" role="status">
                {state}
                {blockedWhy && !running && <span className="exb-why">· {blockedWhy}</span>}
            </div>
            <button
                type="button"
                data-testid="export-results"
                className={`rcx-btn rcx-btn--sm${filled && !why && !exported ? ' rcx-btn--pri' : ''}`}
                disabled={!!why}
                title={why ?? 'Write every model of this project to a folder you pick'}
                onClick={onExport}
            >
                <Download size={12} aria-hidden="true" /> Export results
            </button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

export interface ExportGroupInfo {
    no: number;
    name: string;
    color: string;
}

function ByGroup({ rows, groups, render }: { rows: ExportReadinessRow[]; groups: readonly ExportGroupInfo[]; render: (r: ExportReadinessRow, also: string) => ReactNode }) {
    const seen = new Set<string>();
    const known = new Set(groups.map(g => g.no));
    // A row whose groups are all unknown still shows (under "Not in Group").
    const all: ExportGroupInfo[] = known.has(0) ? [...groups] : [...groups, { no: 0, name: '', color: 'var(--text-faint)' }];
    return (
        <>
            {all.map(g => {
                const rs = rows.filter(r => !seen.has(r.id) && (r.groupNos.includes(g.no) || (g.no === 0 && !r.groupNos.some(n => known.has(n)))));
                if (rs.length === 0) return null;
                for (const r of rs) seen.add(r.id);
                return (
                    <div key={g.no} className="tq-grp">
                        <div className="tq-grpt"><i style={{ background: g.color }} />{g.no === 0 ? 'Not in Group' : `FG-${g.no} · ${g.name}`}</div>
                        {rs.map(r => <div key={r.id}>{render(r, r.groupNos.filter(n => n !== g.no && n !== 0).map(n => `FG-${n}`).join(', '))}</div>)}
                    </div>
                );
            })}
        </>
    );
}

function ModelRow({ r, status, tone, act, also }: { r: ExportReadinessRow; status: ReactNode; tone: string; act?: ReactNode; also?: string }) {
    return (
        <div className="tq-qrow ex-row" data-testid={`export-row-${r.id}`}>
            <span className={`f4-kb model-kind-icon--${r.kind}`} aria-hidden="true">{KIND_LETTER[r.kind]}</span>
            <div className="tq-qrow-name">
                <div className="tq-nm"><SensorInline tag={r.tag} /></div>
                <div className="tq-sub">{MODEL_KIND_LABEL[r.kind]}{also ? ` · also in ${also}` : ''}</div>
            </div>
            <span className={`tq-st ex-st--${tone}`}>{status}</span>
            <span className="tq-act">{act}</span>
        </div>
    );
}

/** One line of the checklist. `fix` = a working link in THIS window; `where` =
 *  plain words for a place in another window (never a dead link). */
function ReadyLine({ id, ok, info, text, sub, fix, where }: {
    id: string; ok: boolean; info?: boolean; text: ReactNode; sub?: ReactNode;
    fix?: { label: string; run: () => void }; where?: string;
}) {
    const ico = info ? 'info' : ok ? 'ok' : 'bad';
    return (
        <div className={`rd-row${!ok && !info ? ' rd-row--bad' : ''}`} data-testid={`ready-${id}`} data-state={ico}>
            <span className={`rd-ico rd-ico--${ico}`} role="img" aria-label={info ? 'Note' : ok ? 'Ready' : 'Needed'}>
                {info ? <Info size={11} /> : ok ? <Check size={11} /> : <TriangleAlert size={11} />}
            </span>
            <div className="rd-t">
                <div>{text}</div>
                {sub && <div className="rd-sub">{sub}</div>}
            </div>
            <div className="rd-act">
                {fix && <button type="button" className="tq-link" data-testid={`ready-${id}-fix`} onClick={fix.run}>{fix.label}</button>}
                {!fix && where && <span className="rd-where">{where}</span>}
            </div>
        </div>
    );
}

type Peek = { kind: 'machine' } | { kind: 'json'; id: string } | { kind: 'csv'; id: string } | null;

export interface ExportModalProps {
    readiness: ExportReadiness;
    groups: readonly ExportGroupInfo[];
    /** "Plant · Machine" — the folder name is made from it. */
    projectName: string;
    machineTag: string;
    exp: UseWorkspaceExport;
    /** The last `exp.plan()` (the dry run) was refused. Not a failed export: the
     *  checklist stays, with one inline line; "Export failed · Nothing was
     *  written" is only for a failed write. The hook says `failed` for both, so
     *  the window (which knows which call it made) tells the dialog. */
    planFailed?: boolean;
    /** Another dialog (Project details) is open on top: this one leaves Esc and Tab alone. */
    stacked: boolean;
    unitOf: (tag: string) => string;
    onClose: () => void;
    onOpenModel: (id: string) => void;
    onOpenProjectDetails: () => void;
    onOpenRunningCondition: () => void;
}

export function ExportModal({ readiness, groups, projectName, machineTag, exp, planFailed = false, stacked, unitOf, onClose, onOpenModel, onOpenProjectDetails, onOpenRunningCondition }: ExportModalProps) {
    const ref = useRef<HTMLDivElement>(null);
    const { phase, exportPlan: plan, result, error, progress, showProgress, hidden } = exp;
    const [confirming, setConfirming] = useState(false);
    const [dest, setDest] = useState<string | null>(exp.lastDir);
    const [showFiles, setShowFiles] = useState(false);
    const [peek, setPeek] = useState<Peek>(null);
    const [startedAt, setStartedAt] = useState<Date | null>(null);
    const backRef = useRef<HTMLButtonElement | null>(null);
    const focusRef = useRef<HTMLButtonElement | null>(null);

    // The remembered folder arrives after the window opened.
    useEffect(() => { if (dest === null && exp.lastDir) setDest(exp.lastDir); }, [exp.lastDir, dest]);

    const { rows, items, noComponent, counts } = readiness;
    const notReady = rows.filter(r => !r.ready);
    const blocking = items.filter(i => i.blocking);
    const allReady = counts.allReady;
    const writeFailed = phase === 'failed' && !planFailed;
    const planErrors = plan?.issues.filter(i => i.severity === 'error') ?? [];
    const planned = plan !== null && phase !== 'planning' && !planFailed;
    // The checklist unfolds by itself while something is missing; once everything is
    // there it is one green line with "Show".
    const [showList, setShowList] = useState(!allReady);
    useEffect(() => { if (!allReady) setShowList(true); }, [allReady]);
    // The dry run only runs once everything is there: when the last item is filled
    // in while the dialog is open (Project details on top of it), it runs then.
    const prevReadyRef = useRef(allReady);
    useEffect(() => {
        const was = prevReadyRef.current;
        prevReadyRef.current = allReady;
        if (!allReady || was) return;
        if (phase === 'idle' || phase === 'ready' || phase === 'cancelled' || planFailed) void exp.plan();
        // Only on the not-ready -> ready step.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allReady]);

    // ---- keyboard: first focus, Tab kept inside, Esc closes only the top dialog ----
    const stackedRef = useRef(stacked);
    stackedRef.current = stacked;
    useEffect(() => {
        const root = ref.current;
        if (!root) return;
        const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const first = root.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ?? focusableIn(root)[0] ?? root;
        first.focus({ preventScroll: true });
        const onTab = (e: KeyboardEvent) => {
            if (e.key !== 'Tab' || stackedRef.current || isPickerSurfaceOpen() || root.offsetParent === null && root.style.display === 'none') return;
            const list = focusableIn(root);
            if (list.length === 0) { e.preventDefault(); return; }
            const head = list[0];
            const tail = list[list.length - 1];
            const active = document.activeElement;
            if (!(active instanceof HTMLElement) || !root.contains(active)) { e.preventDefault(); head.focus(); }
            else if (e.shiftKey && (active === head || active === root)) { e.preventDefault(); tail.focus(); }
            else if (!e.shiftKey && active === tail) { e.preventDefault(); head.focus(); }
        };
        document.addEventListener('keydown', onTab, true);
        return () => {
            document.removeEventListener('keydown', onTab, true);
            if (before && before.isConnected) before.focus({ preventScroll: true });
        };
        // Mount only: the opener is remembered once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const hiddenRef = useRef(hidden);
    hiddenRef.current = hidden;
    const escRef = useRef<() => void>(() => {});
    escRef.current = () => {
        if (confirming) { setConfirming(false); return; }
        if (phase === 'running') exp.hide();
        else onClose();
    };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented || stackedRef.current || isPickerSurfaceOpen()) return;
            if (hiddenRef.current) return;
            escRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    useEffect(() => { if (confirming) backRef.current?.focus(); }, [confirming]);
    useEffect(() => {
        if (hidden || stacked) return;
        if (phase === 'running' || phase === 'done' || writeFailed) focusRef.current?.focus();
    }, [phase, writeFailed, showProgress, hidden, stacked]);

    const planById = new Map<string, ExportPlanModel>((plan?.models ?? []).map(m => [m.id, m]));
    const rowById = new Map(rows.map(r => [r.id, r]));
    const specById = new Map<string, ExportModelSpec>((exp.request?.models ?? []).map(m => [m.id, m]));
    const folderName = exportFolderName(projectName, machineTag, startedAt ?? new Date());
    const tzItem = items.find((i): i is Extract<ExportReadinessItem, { id: 'tz' }> => i.id === 'tz');
    const offsetText = `UTC${fmtOffset(tzItem?.offsetMin ?? 0)}`;

    const pick = async (): Promise<boolean> => {
        try {
            const p = await openDialog({ directory: true, multiple: false, defaultPath: dest ?? exp.lastDir ?? undefined, title: 'Choose a folder for the export' });
            if (typeof p === 'string' && p) { setDest(p); return true; }
        } catch (e) {
            console.warn('Folder picker failed', e);
        }
        return false;
    };
    const run = () => {
        if (!dest) return;
        setConfirming(false);
        const at = new Date();
        setStartedAt(at);
        void exp.start(dest, at);
    };

    let head: ReactNode;
    let body: ReactNode;
    let foot: ReactNode;

    if (phase === 'running') {
        const total = progress?.total || plan?.models.length || rows.length;
        const written = progress?.written ?? 0;
        const order = plan?.models ?? [];
        const cur = order[written];
        const curRow = cur ? rowById.get(cur.id) : undefined;
        head = (
            <div>
                {showProgress ? `Writing model ${Math.min(written + 1, total)} of ${total}` : 'Exporting…'}
                <small>Into a new folder. Cancel removes it — nothing is left half-written.</small>
            </div>
        );
        body = showProgress ? (
            <>
                <div className="ex-bar" aria-hidden="true">{order.map((m, i) => <span key={m.id} className={i < written ? 'done' : i === written ? 'now' : ''} />)}</div>
                {cur && (
                    <div className="ex-line ex-line--now" data-testid="export-current">
                        <Loader2 size={12} className="pm-spin" aria-hidden="true" />
                        <span className="ex-mono">{cur.key}</span>
                        {curRow && <span className="ex-now-t"><SensorInline tag={curRow.tag} /></span>}
                    </div>
                )}
                <ByGroup
                    rows={order.map(m => rowById.get(m.id)).filter((r): r is ExportReadinessRow => !!r)}
                    groups={groups}
                    render={r => {
                        const i = order.findIndex(m => m.id === r.id);
                        return <ModelRow r={r} tone={i < written ? 'complete' : i === written ? 'now' : 'none'} status={i < written ? '✓ Written' : i === written ? 'Writing…' : 'Waiting'} />;
                    }}
                />
            </>
        ) : <div className="ex-line"><Loader2 size={12} className="pm-spin" aria-hidden="true" /> Starting…</div>;
        foot = (
            <>
                <span className="tq-reason">Started {startedAt ? fmtExportDate(startedAt) : ''} · {dest}</span>
                {showProgress && (
                    <button type="button" className="rcx-btn" ref={focusRef} title="Keep exporting; the bar at the bottom of the window shows the progress" onClick={exp.hide}>Hide</button>
                )}
                <button type="button" className="rcx-btn" ref={showProgress ? undefined : focusRef} data-testid="export-cancel" onClick={() => { void exp.cancel(); }}>Cancel export</button>
            </>
        );
    } else if (phase === 'done' && result) {
        head = <div>{plural(result.models, 'model')} exported<small>{startedAt ? fmtExportDate(startedAt) : ''}</small></div>;
        body = (
            <div className="ex-card ex-card--ok" data-testid="export-done">
                <span className="ex-card-ico"><Check size={16} aria-hidden="true" /></span>
                <div style={{ minWidth: 0 }}>
                    <div className="ex-path ex-path--wrap">{result.folder}</div>
                    <div className="ex-hint">machine_info.json + {plural(result.models, 'model file')} and their training rows. The next export goes into a new folder.</div>
                </div>
            </div>
        );
        foot = (
            <>
                <span className="tq-reason" />
                <button type="button" className="rcx-btn" onClick={onClose}>Close</button>
                <button
                    type="button"
                    className="rcx-btn rcx-btn--pri"
                    ref={focusRef}
                    onClick={() => { void revealExportFolder(result.folder).catch(e => console.warn('Open folder failed', e)); }}
                >
                    <Folder size={12} aria-hidden="true" /> Open folder
                </button>
            </>
        );
    } else if (writeFailed) {
        head = <div>Export failed</div>;
        body = (
            <div className="ex-card ex-card--bad" role="alert" data-testid="export-failed">
                <span className="ex-card-ico"><TriangleAlert size={16} aria-hidden="true" /></span>
                <div style={{ minWidth: 0 }}>
                    <div className="ex-card-t">Nothing was written</div>
                    <div className="ex-err" data-testid="export-error">{error?.message || 'The export did not finish.'}</div>
                    <div className="ex-hint">Choose another folder, or fix the cause and try again.</div>
                </div>
            </div>
        );
        foot = (
            <>
                <span className="tq-reason" />
                <button type="button" className="rcx-btn" onClick={() => { void pick().then(ok => { if (!ok) return; if (allReady) void exp.plan(); else exp.reset(); }); }}>Choose another folder…</button>
                <button type="button" className="rcx-btn" onClick={onClose}>Close</button>
                <button
                    type="button"
                    className="rcx-btn rcx-btn--pri"
                    ref={focusRef}
                    disabled={!dest}
                    // Not everything is there any more: back to the checklist (no dry run).
                    onClick={() => { if (allReady) run(); else exp.reset(); }}
                >
                    Try again
                </button>
            </>
        );
    } else if (confirming) {
        head = (
            <div>
                Export with sensors that have no component?
                <small>The export can go ahead — these are written under the component “Uncategorized”.</small>
            </div>
        );
        body = (
            <div className="ex-card ex-card--warn" data-testid="export-confirm">
                <span className="ex-card-ico"><TriangleAlert size={16} aria-hidden="true" /></span>
                <div style={{ minWidth: 0, display: 'grid', gap: 8 }}>
                    <div className="ex-card-t">{noComponent.length} sensor{noComponent.length === 1 ? ' has' : 's have'} no component</div>
                    <div className="ex-nc">
                        {noComponent.map(n => <NoComponentItem key={n.tag} n={n} rowById={rowById} planById={planById} />)}
                    </div>
                    <div className="ex-hint">A model keeps the component of its own sensor; only a model whose own sensor has none is written under “Uncategorized” too.</div>
                </div>
            </div>
        );
        foot = (
            <>
                <span className="tq-reason" />
                <button type="button" className="rcx-btn" ref={backRef} onClick={() => setConfirming(false)}>Back</button>
                <button type="button" className="rcx-btn rcx-btn--pri" data-testid="export-anyway" onClick={run}><Download size={12} aria-hidden="true" /> Export anyway</button>
            </>
        );
    } else {
        // idle / planning / ready / cancelled: the checklist, Save to, What is written.
        head = (
            <div>
                Export results
                <small>Writes the settings and the training rows of every model in this project to a folder you pick. Nothing fitted is included — no model, statistics or scores.</small>
            </div>
        );
        const nItems = items.filter(i => !i.info).length;
        const notes: string[] = [];
        if (plan && allReady && !planFailed && plan.rows_without_timestamp > 0) notes.push(`${plural(plan.rows_without_timestamp, 'row')} without a timestamp ${plan.rows_without_timestamp === 1 ? 'is' : 'are'} left out.`);
        if (plan && allReady && !planFailed && plan.duplicate_instants_dropped > 0) notes.push(`${plural(plan.duplicate_instants_dropped, 'repeated timestamp')} — the last row of each is kept.`);
        const peekPanel = plan && peek ? (() => {
            const m = peek.kind === 'machine' ? null : planById.get(peek.id);
            const title = peek.kind === 'machine' ? 'machine_info.json' : `models/${m?.key}.${peek.kind}`;
            const text = peek.kind === 'machine'
                ? JSON.stringify(plan.machine_info, null, 2)
                : !m ? '' : peek.kind === 'json' ? JSON.stringify(m.json, null, 2) : m.peek.slice(0, 7).map(csvLine).join('\n');
            return (
                <div className="ex-peek" role="region" aria-label={`Preview of ${title}`} data-testid="export-peek">
                    <div className="ex-peek-h"><span className="ex-mono">{title}</span><button type="button" className="tq-link" onClick={() => setPeek(null)}>Close preview</button></div>
                    <pre className="ex-manifest">{text}</pre>
                    {peek.kind === 'csv' && m && <div className="ex-cap">First {Math.min(6, Math.max(0, m.peek.length - 1))} of {fmtCount(m.rows)} rows</div>}
                    {peek.kind === 'machine' && <div className="ex-cap">Plant and machine from Project details; running status from the running condition; sensors, components and failure groups from this project. The export time is filled in when it runs.</div>}
                </div>
            );
        })() : null;
        const byKind = (['individual', 'relationship', 'clustering'] as ModelKind[])
            .map(k => [k, rows.filter(r => r.kind === k).length] as const).filter(([, n]) => n > 0);

        body = (
            <>
                {phase === 'cancelled' && (
                    <div className="ex-line ex-line--plain" data-testid="export-cancelled"><X size={12} aria-hidden="true" /> Export cancelled · nothing was written</div>
                )}

                <div className="ex-sec" data-testid="export-readiness">
                    <div className="ex-lbl">
                        Before export
                        {allReady && <button type="button" className="tq-link" aria-expanded={showList} onClick={() => setShowList(v => !v)}>{showList ? 'Hide' : 'Show'}</button>}
                    </div>
                    {allReady && !showList ? (
                        <div className="rd-all" data-testid="export-ready-line">
                            <span className="rd-ico rd-ico--ok"><Check size={11} /></span>
                            Everything the export needs is here · {plural(counts.total, 'model')} · {nItems} items checked
                            {noComponent.length ? ` · ${plural(noComponent.length, 'sensor')} without a component` : ''}
                        </div>
                    ) : (
                        <>
                            {!allReady && (
                                <div className="rd-sum" data-testid="export-summary">
                                    {notReady.length > 0 && <span><b className="rd-n">{notReady.length}</b> {notReady.length === 1 ? 'model' : 'models'} not Complete yet</span>}
                                    {blocking.length > 0 && <span>{notReady.length > 0 ? '· ' : ''}<b className="rd-n">{blocking.length}</b> {blocking.length === 1 ? 'item' : 'items'} to fill in</span>}
                                    <span>· <b>{counts.ready}</b> of {counts.total} ready</span>
                                </div>
                            )}
                            <div className="rd-list">
                                {items.map(it => (
                                    <ItemLine key={it.id} it={it} noComponent={noComponent} unitOf={unitOf} onOpenProjectDetails={onOpenProjectDetails} onOpenRunningCondition={onOpenRunningCondition} />
                                ))}
                                <ReadyLine
                                    id="models"
                                    ok={notReady.length === 0}
                                    text={<><b>Models</b> · {notReady.length ? `${notReady.length} of ${rows.length} not Complete yet` : `all ${rows.length} Complete`}</>}
                                    sub="Each model is exported as its settings and its exact training rows."
                                />
                                {notReady.length > 0 && (
                                    <div className="rd-models">
                                        <ByGroup rows={notReady} groups={groups} render={(r, also) => (
                                            <ModelRow r={r} tone={r.tone} status={r.words} also={also} act={<button type="button" className="tq-link" onClick={() => onOpenModel(r.id)}>Open →</button>} />
                                        )} />
                                    </div>
                                )}
                                {allReady && planned && planErrors.length > 0 && (
                                    <ReadyLine
                                        id="plan"
                                        ok={false}
                                        text={<><b>Export check</b> · {plural(planErrors.length, 'problem')} found</>}
                                        sub={<>{planErrors.map((p, i) => <ExportIssueLine key={i} issue={p} row={p.model_id ? rowById.get(p.model_id) : undefined} spec={p.model_id ? specById.get(p.model_id) : undefined} />)}</>}
                                    />
                                )}
                            </div>
                        </>
                    )}
                    {allReady && planFailed && (
                        <div className="ex-line ex-line--plain" role="status" data-testid="export-plan-error">
                            <TriangleAlert size={12} aria-hidden="true" />
                            <span>Couldn’t check the export: {error?.message || 'no reason was given.'}</span>
                            <button type="button" className="tq-link" onClick={() => { void exp.plan(); }}>Try again</button>
                        </div>
                    )}
                    {notes.length > 0 && (
                        <div className="rd-notes" data-testid="export-notes">{notes.map(n => <div key={n} className="ex-hint ex-hint--faint">{n}</div>)}</div>
                    )}
                </div>

                <div className="ex-sec">
                    <div className="ex-lbl">Save to</div>
                    {dest ? (
                        <div className="ex-dest" data-testid="export-dest">
                            <Folder size={14} aria-hidden="true" />
                            <span className="ex-path" title={dest}>{dest}</span>
                            <button type="button" className="rcx-btn rcx-btn--sm" {...(!allReady ? { 'data-autofocus': true } : {})} onClick={() => { void pick(); }}>Change…</button>
                        </div>
                    ) : (
                        <div className="ex-dest ex-dest--empty" data-testid="export-dest">
                            <Folder size={14} aria-hidden="true" />
                            <span>No folder chosen yet</span>
                            <button type="button" className="rcx-btn rcx-btn--sm" data-autofocus onClick={() => { void pick(); }}>Choose folder…</button>
                        </div>
                    )}
                    <div className="ex-hint">Every export goes into a <b>new folder</b> inside it, named with the time you press Export: <span className="ex-mono">{folderName}</span>. Nothing already there is changed.</div>
                </div>

                <div className="ex-sec">
                    <div className="ex-lbl">What is written</div>
                    {!allReady ? (
                        <div className="ex-hint" data-testid="export-written-later">Worked out once every model is Complete and every item above is filled in.</div>
                    ) : planFailed ? (
                        <div className="ex-hint" data-testid="export-written-later">Not known yet — the export check did not run.</div>
                    ) : !plan ? (
                        <div className="ex-line" data-testid="export-planning"><Loader2 size={12} className="pm-spin" aria-hidden="true" /> Working out the files…</div>
                    ) : (
                        <>
                            <div className="tq-sumrow" data-testid="export-written">
                                <span className="tq-big"><b>{plan.models.length}</b> models</span>
                                <span>· <b>{plan.files}</b> files</span>
                                <span>· <b>{fmtCount(plan.total_rows)}</b> training rows</span>
                                <span>· ≈ {fmtBytes(plan.total_bytes)}</span>
                                <span>· timestamps written as {offsetText}</span>
                            </div>
                            <div className="ex-kinds">
                                {byKind.map(([k, n]) => (
                                    <span key={k} className="ex-kind"><span className={`f4-kb model-kind-icon--${k}`} aria-hidden="true">{KIND_LETTER[k]}</span><b>{n}</b> {MODEL_KIND_LABEL[k]}</span>
                                ))}
                            </div>
                            <button type="button" className="ex-disc" aria-expanded={showFiles} onClick={() => setShowFiles(v => !v)}>
                                {showFiles ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />} {showFiles ? 'Hide the files' : 'Show the files'}
                            </button>
                            {showFiles && (
                                <div className="ex-tree" aria-label="Files the export writes" data-testid="export-tree">
                                    <div className="ex-t ex-t--root"><Folder size={13} aria-hidden="true" /><span className="ex-mono">{folderName}\</span></div>
                                    <button type="button" className={`ex-t ex-t--l1 ex-t--btn${peek?.kind === 'machine' ? ' ex-t--on' : ''}`} onClick={() => setPeek(p => (p?.kind === 'machine' ? null : { kind: 'machine' }))}>
                                        <FileJson size={12} aria-hidden="true" /><span className="ex-mono">machine_info.json</span>
                                        <span className="ex-t-note">plant · machine · running status · sensors · failure groups</span>
                                        <span className="ex-t-peek">Peek</span>
                                    </button>
                                    <div className="ex-t ex-t--l1"><Folder size={13} aria-hidden="true" /><span className="ex-mono">models\</span></div>
                                    {plan.models.map(m => {
                                        const r = rowById.get(m.id);
                                        return (
                                            <div key={m.id} className="ex-pair">
                                                <div className="ex-t ex-t--l2 ex-t--label">
                                                    {r && <span className={`f4-kb model-kind-icon--${r.kind} ex-kb-s`} aria-hidden="true">{KIND_LETTER[r.kind]}</span>}
                                                    {r && <span className="ex-t-sensor"><SensorInline tag={r.tag} /></span>}
                                                </div>
                                                <button type="button" className={`ex-t ex-t--l3 ex-t--btn${peek?.kind === 'json' && peek.id === m.id ? ' ex-t--on' : ''}`} onClick={() => setPeek(p => (p?.kind === 'json' && p.id === m.id ? null : { kind: 'json', id: m.id }))}>
                                                    <FileJson size={12} aria-hidden="true" /><span className="ex-mono ex-file">{m.key}.json</span><span className="ex-t-note">settings · health values</span><span className="ex-t-peek">Peek</span>
                                                </button>
                                                <button type="button" className={`ex-t ex-t--l3 ex-t--btn${peek?.kind === 'csv' && peek.id === m.id ? ' ex-t--on' : ''}`} onClick={() => setPeek(p => (p?.kind === 'csv' && p.id === m.id ? null : { kind: 'csv', id: m.id }))}>
                                                    <FileSpreadsheet size={12} aria-hidden="true" /><span className="ex-mono ex-file">{m.key}.csv</span><span className="ex-t-note">{fmtCount(m.rows)} training rows · {fmtBytes(m.bytes)}</span><span className="ex-t-peek">Peek</span>
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {peekPanel}
                        </>
                    )}
                </div>
            </>
        );
        const why = !allReady
            ? (notReady.length ? `${plural(notReady.length, 'model')} not Complete yet` : `${plural(blocking.length, 'item')} to fill in`)
            : planFailed ? 'Couldn’t check the export'
            : !planned ? 'Checking what the export writes…'
            : planErrors.length ? `${plural(planErrors.length, 'problem')} found by the export check`
            : !dest ? 'Choose a folder first'
            : null;
        foot = (
            <>
                <span className={`tq-reason${why ? ' tq-reason--warn' : ''}`} data-testid="export-why">{why ?? `Writes ${plural(rows.length, 'model')} into a new folder`}</span>
                <button type="button" className="rcx-btn" onClick={onClose}>{allReady ? 'Cancel' : 'Close'}</button>
                <button
                    type="button"
                    className="rcx-btn rcx-btn--pri"
                    data-testid="export-start"
                    disabled={!!why}
                    title={why ?? undefined}
                    {...(dest && allReady ? { 'data-autofocus': true } : {})}
                    onClick={() => (noComponent.length ? setConfirming(true) : run())}
                >
                    <Download size={12} aria-hidden="true" /> Export {plural(rows.length, 'model')}
                </button>
            </>
        );
    }

    return (
        <div
            className="bmw-modal-backdrop"
            role="presentation"
            style={hidden ? { display: 'none' } : undefined}
            onMouseDown={() => { if (phase !== 'running' && !stacked) onClose(); }}
        >
            <div ref={ref} tabIndex={-1} className="bmw-modal tq-modal ex-modal" role="dialog" aria-modal="true" aria-label="Export results" data-testid="export-dialog" onMouseDown={e => e.stopPropagation()}>
                <div className="tq-mh">
                    {head}
                    {phase !== 'running' && <button type="button" className="bmw-modal-x" aria-label="Close" onClick={onClose}><X size={16} /></button>}
                </div>
                <div className="tq-mb">{body}</div>
                <div className="tq-mf">{foot}</div>
            </div>
        </div>
    );
}

/** What each export-check code means, in the user's words (Rust's `message`
 *  carries raw tags, so it is shown only for a code this app does not know). */
export const EXPORT_ISSUE_WORDS: Record<string, string> = {
    machine_missing: 'Plant name, Machine name or Machine tag not filled in',
    running_status_missing: 'Running status not set',
    running_status_sensor_unknown: 'The running-status sensor is not in the loaded data',
    offset_out_of_range: 'The time zone of the data is out of range',
    no_models: 'No models to export',
    duplicate_model_id: 'Two models have the same id — close and reopen the project, then try again',
    unknown_sensor: 'Sensor not found in the loaded data',
    category_missing: 'No category — pick Performance or Condition on the sensor',
    display_name_duplicate: 'Model name is already used by another model in this project',
    set_points_invalid: 'The health set points need fixing',
    fit_profile_unknown: 'The stiffness setting is not known',
    regimes_not_contiguous: 'Cluster ranges must meet end to end',
    no_training_rows: 'No training rows in the loaded data',
    derived_recipe_missing: 'The formula of this special sensor was not found',
    fg_text_missing: 'No description or recommendation',
    model_incomplete: 'Not Complete yet',
    bad_training_scope: 'The training data settings need fixing',
    input_equals_output: 'A predictor is the same sensor as the target',
    x_equals_y: 'X and Y are the same sensor',
    fg_name_duplicate: 'Another failure group has the same name',
};

/** One export-check problem: the model it is about (its name, or its sensor and
 *  kind), the failure group, the sensor (`SensorInline`, never the raw tag), then
 *  the fixed wording of its code. */
export function ExportIssueLine({ issue, row, spec }: { issue: ExportIssue; row?: ExportReadinessRow; spec?: Pick<ExportModelSpec, 'display_name' | 'kind'> }) {
    const words = Object.prototype.hasOwnProperty.call(EXPORT_ISSUE_WORDS, issue.code) ? EXPORT_ISSUE_WORDS[issue.code] : undefined;
    const kind = spec?.kind ?? row?.kind;
    const name = spec?.display_name?.trim();
    const parts: ReactNode[] = [];
    if (issue.model_id) {
        if (name) parts.push(<b>{name}{kind ? ` (${MODEL_KIND_LABEL[kind]})` : ''}</b>);
        else if (row) parts.push(<><SensorInline tag={row.tag} />{` (${MODEL_KIND_LABEL[row.kind]})`}</>);
    }
    if (issue.group_no !== undefined && issue.group_no !== 0) parts.push(<>FG-{issue.group_no}</>);
    // The sensor the problem is about, unless it is already named as the model's own.
    if (issue.tag && !(row && !name && row.tag === issue.tag)) parts.push(<SensorInline tag={issue.tag} />);
    parts.push(<>{words ?? issue.message}</>);
    return (
        <div data-testid="export-issue" data-code={issue.code}>
            {parts.map((p, i) => <span key={i}>{i > 0 ? ' · ' : ''}{p}</span>)}
        </div>
    );
}

/** One checklist item, in the words the editors use. */
function ItemLine({ it, noComponent, unitOf, onOpenProjectDetails, onOpenRunningCondition }: {
    it: ExportReadinessItem;
    noComponent: readonly NoComponentSensor[];
    unitOf: (tag: string) => string;
    onOpenProjectDetails: () => void;
    onOpenRunningCondition: () => void;
}) {
    switch (it.id) {
        case 'machine': {
            const m = it.machine;
            return (
                <ReadyLine
                    id="machine"
                    ok={it.ok}
                    text={it.missing.length
                        ? <><b>Machine</b> · {it.missing.join(', ')} not filled in</>
                        : <><b>Machine</b> · {m.plant} · {m.name} · <span className="ex-mono">{m.tag}</span></>}
                    sub={it.missing.length
                        ? (it.legacy
                            ? 'This project was made before the plant, machine and tag were asked for — fill them in once; saving renames it to Plant · Machine.'
                            : 'The export writes the plant, the machine and its tag into machine_info.json.')
                        : (m.notes || undefined)}
                    // ONE button element whatever its label, so the focus can come back to it.
                    fix={{ label: it.missing.length ? 'Fill in →' : 'Edit', run: onOpenProjectDetails }}
                />
            );
        }
        case 'tz':
            return (
                <ReadyLine
                    id="tz"
                    ok={it.ok}
                    text={<><b>Time zone of the data</b> · UTC{fmtOffset(it.offsetMin)}{it.isPcOffset ? ' (this PC)' : ''}</>}
                    sub="The CSV carries no time zone; the export adds this offset to every timestamp."
                    fix={{ label: 'Change', run: onOpenProjectDetails }}
                />
            );
        case 'running': {
            const s = it.status;
            const unit = s ? unitOf(s.sensor) : '';
            return (
                <ReadyLine
                    id="running"
                    ok={it.ok}
                    text={s
                        ? <><b>Running status</b> · Machine is running when <SensorInline tag={s.sensor} /> is above <span className="ex-mono">{String(s.value)}{unit ? ` ${unit}` : ''}</span></>
                        : <><b>Running status</b> · not set — pick the sensor that shows the machine is running</>}
                    sub={!s ? 'The customer\'s monitoring system needs one sensor and the value at or below which the machine counts as stopped.'
                        : 'From the running condition — the same line used for training.'}
                    fix={{ label: 'Open running condition', run: onOpenRunningCondition }}
                />
            );
        }
        case 'sensors':
            return (
                <ReadyLine
                    id="sensors"
                    ok={it.ok}
                    info={it.info}
                    text={<><b>Sensors</b> · {it.rawCount} raw{it.specialCount ? ` + ${it.specialCount} special` : ''} used by the models{it.noComponentCount ? ` · ${it.noComponentCount} without a component` : ''}</>}
                    sub={it.noComponentCount
                        ? <>Written under the component “Uncategorized”: {noComponent.map((n, j) => <span key={n.tag}>{j > 0 ? ', ' : ''}<SensorInline tag={n.tag} /></span>)}. Components come from the tag-name file.</>
                        : 'Name, unit and component from the tag-name file; the running-status sensor is included.'}
                    where={it.noComponentCount ? 'Tag-name file (Import)' : undefined}
                />
            );
        case 'derived':
            return (
                <ReadyLine
                    id="derived"
                    ok={it.ok}
                    info
                    text={<><b>Special sensors</b> · how to build them is written from their formulas</>}
                    sub={<>{it.sensors.map(d => <span key={d.tag} className="rd-der"><SensorInline tag={d.tag} /> — {d.howToBuild}</span>)}</>}
                />
            );
        case 'fg':
            return (
                <ReadyLine
                    id="fg"
                    ok={it.ok}
                    text={it.missing.length
                        ? <><b>Failure groups</b> · {it.missing.length} of {it.usedCount} without a description or a recommendation</>
                        : <><b>Failure groups</b> · {it.usedCount} with a description and a recommendation</>}
                    sub={it.missing.length
                        ? <>{it.missing.map((g, j) => <span key={g.no}>{j > 0 ? ' · ' : ''}FG-{g.no} {g.name}</span>)} — both texts go to the customer with the models.</>
                        : undefined}
                    where={it.missing.length ? 'Dashboard › Failure Groups › Edit details' : undefined}
                />
            );
    }
}

/** One sensor of the confirm step: where it goes, who uses it, how to fix it. */
function NoComponentItem({ n, rowById, planById }: {
    n: NoComponentSensor;
    rowById: ReadonlyMap<string, ExportReadinessRow>;
    planById: ReadonlyMap<string, ExportPlanModel>;
}) {
    const users = n.modelIds.map(id => rowById.get(id)).filter((r): r is ExportReadinessRow => !!r);
    return (
        <div className="ex-nc-item" data-testid={`export-nc-${n.tag}`}>
            <div className="ex-nc-row">
                <span className="ex-nc-s"><SensorInline tag={n.tag} /></span>
                <span className="ex-nc-m">→ written under “Uncategorized”</span>
            </div>
            <div className="ex-nc-used">
                {users.length > 0 ? (
                    <>
                        Used by {users.map((r, i) => {
                            const key = planById.get(r.id)?.key;
                            return (
                                <span key={r.id}>
                                    {i > 0 ? '· ' : ''}<SensorInline tag={r.tag} /> · {MODEL_KIND_LABEL[r.kind]}{key && <span className="ex-mono ex-key">{key}</span>}
                                </span>
                            );
                        })}
                        {n.runningStatus && <span>· and as the running-status sensor</span>}
                    </>
                ) : n.runningStatus ? 'Used as the running-status sensor' : null}
            </div>
            <div className="ex-nc-fix">Give it a component in {n.special ? 'Special Sensors › Manage' : 'the tag-name file (Import)'}, then export again.</div>
        </div>
    );
}
