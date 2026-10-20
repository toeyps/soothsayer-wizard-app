/*
 * "Project details" — the one place to edit, after a project exists, what
 * Step 1 captured (plant, machine, tag, notes) plus the time zone of the data
 * (Step 2). Opened from the title bar's project menu (Rename… / Project
 * details…, and the app menu's Rename Workspace) and from Rename on a recent
 * project card. The project's name is "Plant · Machine", so renaming happens
 * here too. Saving goes ONLY through `saveProjectDetails`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { MachineDetails, ProjectDetailsChangedPayload, WorkspaceState } from '../../types';
import {
    fmtOffset,
    isDuplicatePlantMachine,
    machineOf,
    missingMachineFields,
    pcOffsetMin,
    projectDisplayName,
    saveProjectDetails,
} from '../../utils/projectDetails';
import { DUPLICATE_PAIR_REASON, MachineFields, TimeZoneSelect, missingFieldsReason } from '../upload/MachineFields';
import { useModalFocus } from './useModalFocus';

/** A data timestamp as the Wizard shows it ("2026/02/09 00:00") written the
 *  way the export writes it ("2026-02-09T00:00:00+07:00"). */
export function isoExample(ts: string, offsetMin: number): string {
    const m = ts.trim().match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return `${ts}${fmtOffset(offsetMin)}`;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${fmtOffset(offsetMin)}`;
}

const SAMPLE_TIMESTAMP = '2026/02/09 00:00';

export function ProjectDetailsModal({ workspace, existing = [], firstTimestamp, onSaved, onClose }: {
    /** The project as it is on disk (read right before opening). */
    workspace: Pick<WorkspaceState, 'id' | 'name' | 'machine' | 'dataUtcOffsetMin'>;
    /** Other projects (the Plant · Machine pair must stay unique). */
    existing?: ReadonlyArray<{ id?: string; name?: string }>;
    /** The data's first timestamp as the Wizard shows it; a sample is used when unknown. */
    firstTimestamp?: string;
    /** Called once the save is durable and broadcast. */
    onSaved: (payload: ProjectDetailsChangedPayload) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref, true);
    const [initial] = useState(() => ({
        machine: machineOf(workspace),
        dataUtcOffsetMin: workspace.dataUtcOffsetMin ?? pcOffsetMin(),
    }));
    const [machine, setMachine] = useState<MachineDetails>(initial.machine);
    const [offset, setOffset] = useState<number>(initial.dataUtcOffsetMin);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const savingRef = useRef(false);

    // Esc closes ONLY this dialog, also when it sits on top of another one:
    // capture phase, and the event is marked handled so nothing under it acts.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.preventDefault();
            e.stopPropagation();
            if (!savingRef.current) onCloseRef.current();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    // First focus: the first empty required field, else Plant name.
    useEffect(() => {
        const root = ref.current;
        if (!root) return;
        const required = Array.from(root.querySelectorAll<HTMLInputElement>('input.mf-in')).slice(0, 3);
        (required.find(i => !i.value.trim()) ?? required[0])?.focus({ preventScroll: true });
    }, []);

    const oldProject = !workspace.machine;
    const changed = offset !== initial.dataUtcOffsetMin
        || (Object.keys(initial.machine) as (keyof MachineDetails)[]).some(k => machine[k] !== initial.machine[k]);
    const missing = missingMachineFields(machine);
    const duplicate = isDuplicatePlantMachine(machine, existing, workspace.id);
    const why = duplicate ? DUPLICATE_PAIR_REASON : missingFieldsReason(missing, 'save');
    const newName = projectDisplayName(machine);
    const renames = missing.length === 0 && newName !== (workspace.name ?? '').trim();

    const save = async () => {
        if (why || !changed || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        try {
            const payload = await saveProjectDetails(workspace.id, { machine, dataUtcOffsetMin: offset });
            if (!payload) {
                setError('Could not save the project details — the project file could not be read.');
                return;
            }
            onSaved(payload);
            onCloseRef.current();
        } catch (e) {
            setError(`Could not save the project details: ${String(e)}`);
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    const sample = firstTimestamp?.trim() || SAMPLE_TIMESTAMP;
    let reason: ReactNode = why ?? '';
    let reasonClass = 'tq-reason';
    if (error) { reason = error; reasonClass += ' tq-reason--danger'; }
    else if (duplicate) reasonClass += ' tq-reason--danger';
    else if (!why && changed) reason = renames ? <>Saving renames the project to <b>{newName}</b></> : 'Not saved yet';

    return (
        <div className="bmw-modal-backdrop" role="presentation" onMouseDown={() => { if (!savingRef.current) onClose(); }}>
            <div
                ref={ref}
                tabIndex={-1}
                className="bmw-modal tq-modal pdm"
                role="dialog"
                aria-modal="true"
                aria-label="Project details"
                onMouseDown={e => e.stopPropagation()}
            >
                <div className="tq-mh">
                    <div>
                        Project details
                        <small>{workspace.name || 'Unnamed project'} · saved with this project. The export writes them into <span className="pdm-mono">machine_info.json</span>.</small>
                    </div>
                    <button type="button" className="bmw-modal-x" aria-label="Close" onClick={onClose} disabled={saving}><X size={16} /></button>
                </div>
                <div className="tq-mb">
                    <div className="pdm-sec">
                        <div className="pdm-lbl">Machine</div>
                        {oldProject && (
                            <div className="pdm-old" data-testid="pdm-old-project">
                                This project was made before plant and machine were asked for, so <b>Plant name</b> holds its old name — change it if that is not the plant.
                            </div>
                        )}
                        <MachineFields value={machine} onChange={setMachine} showMissing={missing.length < 3} duplicate={duplicate} />
                    </div>
                    <div className="pdm-sec">
                        <div className="pdm-lbl">Time zone of the data</div>
                        <div className="mf-grid">
                            <label className="mf-f">
                                <span>Timestamps in the CSV are local time of</span>
                                <TimeZoneSelect value={offset} onChange={setOffset} label="Timestamps in the CSV are local time of" />
                            </label>
                            <div className="mf-f mf-f--note">
                                <span>So the export writes</span>
                                <div className="pdm-hint" data-testid="pdm-iso-example">
                                    {firstTimestamp ? null : 'For example, '}
                                    <span className="pdm-mono pdm-nw">{sample}</span> as <span className="pdm-mono pdm-nw">{isoExample(sample, offset)}</span>. The data itself carries no time zone, so the Wizard keeps the clock as written and adds this offset only in the export.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="tq-mf">
                    <span className={reasonClass} role="status">{reason}</span>
                    <button type="button" className="rcx-btn" onClick={onClose} disabled={saving}>Cancel</button>
                    <button
                        type="button"
                        className="rcx-btn rcx-btn--pri"
                        disabled={!changed || !!why || saving}
                        title={why ?? undefined}
                        onClick={() => { void save(); }}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}
