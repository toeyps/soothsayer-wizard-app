import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));
const mockOpenDialog = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: (opts: unknown) => mockOpenDialog(opts),
}));

import { ExportBar, ExportModal, fmtBytes, type ExportModalProps } from '../components/windows/workbench/ExportParts';
import type { UseWorkspaceExport } from '../hooks/useWorkspaceExport';
import type { ExportReadiness, ExportReadinessItem, ExportReadinessRow, NoComponentSensor } from '../utils/exportReadiness';
import type { WorkspaceExportPlan } from '../types/export';
import { FIRST_ABOVE_NOTE } from '../utils/runningStatus';
import { SensorMetaContext } from '../components/sensor/sensorInfo';

const META: Record<string, { description?: string; unit?: string }> = {
    TAG1: { description: 'Pump Pressure', unit: 'bar' },
    TAG2: { description: 'Pump Temp', unit: 'C' },
    RUN: { description: 'Generator power', unit: 'kW' },
};
const lookup = (tag: string) => ({ tag, description: META[tag]?.description, unit: META[tag]?.unit });

const counts = (o: Partial<ExportReadiness['counts']> = {}): ExportReadiness['counts'] =>
    ({ total: 3, ready: 3, notReady: 0, toFix: 0, allReady: true, ...o });

function row(o: Partial<ExportReadinessRow> = {}): ExportReadinessRow {
    return { id: 'm1', kind: 'individual', tag: 'TAG1', groupNos: [1], ready: true, reason: 'complete', words: 'Complete', tone: 'complete', ...o };
}

function items(o: { machineMissing?: string[]; running?: ExportReadinessItem | null; noComponent?: number } = {}): ExportReadinessItem[] {
    const missing = o.machineMissing ?? [];
    const base = (ok: boolean, info = false) => ({ ok, info, blocking: !ok && !info });
    return [
        { id: 'machine', ...base(missing.length === 0), machine: { plant: 'Plant A', name: 'GT-1', tag: 'GT01', notes: '' }, missing, legacy: missing.length > 0 },
        { id: 'tz', ...base(true), offsetMin: 420, isPcOffset: true, saved: true },
        o.running ?? { id: 'running', ...base(true), status: { sensor: 'RUN', value: 1000, source: 'single-above' } },
        { id: 'sensors', ...base(true, (o.noComponent ?? 0) > 0), rawCount: 2, specialCount: 0, noComponentCount: o.noComponent ?? 0 },
        { id: 'fg', ...base(true), usedCount: 1, missing: [] },
    ];
}

function readiness(o: { rows?: ExportReadinessRow[]; items?: ExportReadinessItem[]; noComponent?: NoComponentSensor[] } = {}): ExportReadiness {
    const rows = o.rows ?? [row(), row({ id: 'm2', kind: 'relationship', tag: 'TAG2' })];
    const its = o.items ?? items();
    const ready = rows.filter(r => r.ready).length;
    const toFix = its.filter(i => i.blocking).length;
    return {
        rows, items: its, noComponent: o.noComponent ?? [],
        counts: { total: rows.length, ready, notReady: rows.length - ready, toFix, allReady: rows.length > 0 && ready === rows.length && toFix === 0 },
    };
}

function plan(o: Partial<WorkspaceExportPlan> = {}): WorkspaceExportPlan {
    return {
        ok: true, issues: [],
        machine_info: { schema_version: '1.0', exported_at: null, plant: 'Plant A' },
        models: [
            { id: 'm1', key: 'TAG1-I1', json: { model_key: 'TAG1-I1', kind: 'individual' }, csv_columns: ['TimeStamp', 'TAG1'], rows: 1200, bytes: 34_000, peek: [['TimeStamp', 'TAG1'], ['2026-02-09T00:00:00+07:00', '1.5'], ['2026-02-09T00:05:00+07:00', '1.6']] },
            { id: 'm2', key: 'TAG2-R1', json: { model_key: 'TAG2-R1', kind: 'relationship' }, csv_columns: ['TimeStamp', 'TAG1', 'TAG2'], rows: 900, bytes: 30_000, peek: [['TimeStamp', 'TAG1', 'TAG2']] },
        ],
        total_rows: 2100, total_bytes: 66_000, files: 5,
        rows_without_timestamp: 0, duplicate_instants_dropped: 0, uncategorized_tags: [],
        ...o,
    };
}

function fakeExp(o: Partial<UseWorkspaceExport> = {}): UseWorkspaceExport {
    return {
        phase: 'ready', exportPlan: plan(), request: null, result: null, error: null, progress: null,
        showProgress: false, hidden: false, lastDir: 'C:\\exports',
        plan: vi.fn().mockResolvedValue(null), start: vi.fn().mockResolvedValue(null), cancel: vi.fn().mockResolvedValue(undefined),
        hide: vi.fn(), show: vi.fn(), reset: vi.fn(),
        ...o,
    };
}

const GROUPS = [{ no: 1, name: 'Bearing', color: '#f00' }, { no: 0, name: '', color: '#888' }];

function renderModal(over: Partial<ExportModalProps> = {}) {
    const props: ExportModalProps = {
        readiness: readiness(),
        groups: GROUPS,
        projectName: 'Plant A · GT-1',
        machineTag: 'GT01',
        exp: fakeExp(),
        stacked: false,
        unitOf: tag => META[tag]?.unit ?? '',
        onClose: vi.fn(),
        onOpenModel: vi.fn(),
        onOpenProjectDetails: vi.fn(),
        onOpenRunningCondition: vi.fn(),
        ...over,
    };
    const utils = render(
        <SensorMetaContext.Provider value={lookup}>
            <ExportModal {...props} />
        </SensorMetaContext.Provider>,
    );
    return { props, ...utils };
}

beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue(null);
    mockOpenDialog.mockReset();
});
afterEach(() => cleanup());

describe('ExportBar (the Build Model window\'s workspace status bar)', () => {
    const bar = (o: Partial<Parameters<typeof ExportBar>[0]> = {}) => {
        const props = {
            counts: counts(), phase: 'idle' as const, progress: null, exported: null, filled: true, blockedWhy: null,
            onExport: vi.fn(), onShowWhich: vi.fn(), onShowRun: vi.fn(), onOpenFolder: vi.fn(),
            ...o,
        };
        render(<ExportBar {...props} />);
        return props;
    };
    const btn = () => screen.getByTestId('export-results') as HTMLButtonElement;

    it('incomplete: says what stops the export, "Show which", and Export results is disabled with the reason', () => {
        const p = bar({ counts: counts({ ready: 1, notReady: 2, toFix: 1, allReady: false }) });
        expect(screen.getByTestId('export-bar').textContent).toContain('2 models not Complete yet · 1 item to fill in');
        expect(btn().disabled).toBe(true);
        expect(btn().title).toBe('Every model must be Complete first · 2 left');
        fireEvent.click(screen.getByText('Show which'));
        expect(p.onShowWhich).toHaveBeenCalled();
    });

    it('every model Complete but an item missing: the reason points at "Show which"', () => {
        bar({ counts: counts({ toFix: 2, allReady: false }) });
        expect(screen.getByTestId('export-bar').textContent).toContain('All 3 models Complete · 2 items to fill in');
        expect(btn().title).toBe('Fill in the items in “Show which” first');
    });

    it('ready: one green sentence and a filled, enabled Export results', () => {
        const p = bar();
        expect(screen.getByTestId('export-bar').textContent).toContain('All 3 models Complete · ready to export');
        expect(btn().disabled).toBe(false);
        expect(btn().className).toContain('rcx-btn--pri');
        fireEvent.click(btn());
        expect(p.onExport).toHaveBeenCalled();
    });

    it('ready but not the next step: Export results stays a ghost', () => {
        bar({ filled: false });
        expect(btn().className).not.toContain('rcx-btn--pri');
    });

    it('a training run blocks it, with the reason beside the state', () => {
        bar({ blockedWhy: 'Wait for the training run to finish' });
        expect(btn().disabled).toBe(true);
        expect(screen.getByTestId('export-bar').textContent).toContain('· Wait for the training run to finish');
    });

    it('running: "Writing model n of N" from the progress, a bar, Show; the button waits', () => {
        const p = bar({ phase: 'running', progress: { written: 1, total: 3, modelKey: 'TAG1-I1' } });
        expect(screen.getByTestId('export-bar').textContent).toContain('Writing model 2 of 3');
        expect(btn().disabled).toBe(true);
        expect(btn().title).toBe('An export is running');
        fireEvent.click(screen.getByText('Show'));
        expect(p.onShowRun).toHaveBeenCalled();
    });

    it('done: "N models exported <date> · <folder>" with Open folder', () => {
        const p = bar({ exported: { models: 3, folder: 'C:\\out\\Plant_A_2026-10-20_1140', at: new Date(2026, 9, 20, 11, 40) } });
        const t = screen.getByTestId('export-bar-exported').textContent ?? '';
        expect(t).toContain('3 models exported 2026/10/20 11:40');
        expect(t).toContain('C:\\out\\Plant_A_2026-10-20_1140');
        fireEvent.click(screen.getByText('Open folder'));
        expect(p.onOpenFolder).toHaveBeenCalled();
        // The exported line is not a call to export again.
        expect(btn().className).not.toContain('rcx-btn--pri');
    });

    it('failed: red "Export failed · nothing was written" with Show', () => {
        const p = bar({ phase: 'failed' });
        expect(screen.getByTestId('export-bar').textContent).toContain('Export failed · nothing was written');
        fireEvent.click(screen.getByText('Show'));
        expect(p.onShowRun).toHaveBeenCalled();
    });

    it('no models: says so and cannot export', () => {
        bar({ counts: counts({ total: 0, ready: 0, allReady: false }) });
        expect(screen.getByTestId('export-bar').textContent).toContain('No models yet');
        expect(btn().disabled).toBe(true);
    });
});

describe('ExportModal — the checklist', () => {
    it('says what is written and that nothing fitted is included', () => {
        renderModal();
        expect(screen.getByText(/Nothing fitted is included — no model, statistics or scores\./)).toBeTruthy();
    });

    it('when everything is there it is one green line (with the sensors without a component counted); Show unfolds it', () => {
        renderModal({ readiness: readiness({ noComponent: [{ tag: 'TAG2', special: false, modelIds: ['m2'], runningStatus: false }], items: items({ noComponent: 1 }) }) });
        const line = screen.getByTestId('export-ready-line').textContent ?? '';
        expect(line).toContain('Everything the export needs is here · 2 models · 4 items checked · 1 sensor without a component');
        fireEvent.click(screen.getByText('Show'));
        expect(screen.getByTestId('ready-machine')).toBeTruthy();
    });

    it('missing machine: "Fill in →" opens Project details; time zone "Change" too; running status "Open running condition"', () => {
        const { props } = renderModal({ readiness: readiness({ items: items({ machineMissing: ['Machine name', 'Machine tag'] }) }) });
        expect(screen.getByTestId('ready-machine').textContent).toContain('Machine name, Machine tag not filled in');
        expect(screen.getByTestId('ready-machine').textContent).toContain('This project was made before the plant, machine and tag were asked for');
        fireEvent.click(screen.getByText('Fill in →'));
        expect(props.onOpenProjectDetails).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByText('Change'));
        expect(props.onOpenProjectDetails).toHaveBeenCalledTimes(2);
        fireEvent.click(screen.getByText('Open running condition'));
        expect(props.onOpenRunningCondition).toHaveBeenCalled();
        expect(screen.getByTestId('export-summary').textContent).toContain('1 item to fill in');
    });

    it('a filled machine says its values and offers Edit', () => {
        renderModal({ readiness: readiness({ items: items() }) });
        fireEvent.click(screen.getByText('Show'));
        expect(screen.getByTestId('ready-machine').textContent).toContain('Plant A · GT-1 · GT01');
        expect(screen.getByTestId('ready-machine-fix').textContent).toBe('Edit');
        expect(screen.getByTestId('ready-tz').textContent).toContain('UTC+07:00 (this PC)');
    });

    it('running status in the editor\'s words, with the sensor label (description first) and its unit', () => {
        renderModal({ readiness: readiness({ rows: [row({ ready: false, reason: 'trained', words: 'Trained · Mark complete is next', tone: 'need' })] }) });
        const t = screen.getByTestId('ready-running').textContent ?? '';
        expect(t).toContain('Machine is running when');
        expect(t).toContain('Generator power');
        expect(t).toContain('is above 1000 kW');
        expect(t).toContain('From the running condition — its one “above” condition.');
    });

    it('a running status taken from the first "above" condition says to check it', () => {
        const running: ExportReadinessItem = { id: 'running', ok: true, info: false, blocking: false, status: { sensor: 'RUN', value: 5, source: 'first-above' } };
        renderModal({ readiness: readiness({ rows: [row({ ready: false, words: 'Not trained yet', tone: 'none' })], items: items({ running }) }) });
        expect(screen.getByTestId('ready-running').textContent).toContain(FIRST_ABOVE_NOTE);
    });

    it('a missing running status is a fact to fill in, not an error', () => {
        const running: ExportReadinessItem = { id: 'running', ok: false, info: false, blocking: true, status: null };
        renderModal({ readiness: readiness({ items: items({ running }) }) });
        const r = screen.getByTestId('ready-running');
        expect(r.textContent).toContain('not set — say which sensor tells that the machine is running');
        expect(r.getAttribute('data-state')).toBe('bad');
    });

    it('lists the not-Complete models by failure group with their reason and Open →', () => {
        const rows = [
            row(),
            row({ id: 'm2', tag: 'TAG2', kind: 'relationship', ready: false, reason: 'name-twin', words: 'Name also used by the Individual model of Pump Pressure · TAG1 — rename one', tone: 'need' }),
        ];
        const { props } = renderModal({ readiness: readiness({ rows }) });
        expect(screen.getByTestId('ready-models').textContent).toContain('1 of 2 not Complete yet');
        expect(screen.getByTestId('ready-models').textContent).toContain('Each model is exported as its settings and its exact training rows.');
        const r = screen.getByTestId('export-row-m2');
        expect(r.textContent).toContain('Name also used by the Individual model');
        expect(r.textContent).toContain('Relation model');
        expect(screen.queryByTestId('export-row-m1')).toBeNull();
        fireEvent.click(within(r).getByText('Open →'));
        expect(props.onOpenModel).toHaveBeenCalledWith('m2');
        expect((screen.getByTestId('export-start') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('export-why').textContent).toBe('1 model not Complete yet');
    });

    it('grey notes for rows left out without a timestamp and repeated instants', () => {
        renderModal({ exp: fakeExp({ exportPlan: plan({ rows_without_timestamp: 288, duplicate_instants_dropped: 1 }) }) });
        const t = screen.getByTestId('export-notes').textContent ?? '';
        expect(t).toContain('288 rows without a timestamp are left out.');
        expect(t).toContain('1 repeated timestamp — the last row of each is kept.');
    });

    it('a problem the dry run found blocks Export even when the checklist is complete', () => {
        renderModal({ exp: fakeExp({ exportPlan: plan({ ok: false, issues: [{ code: 'no_training_rows', severity: 'error', model_id: 'm1', message: 'No training rows for TAG1-I1' }] }) }) });
        expect(screen.getByTestId('export-why').textContent).toBe('1 problem found by the export check');
        fireEvent.click(screen.getByText('Show'));
        expect(screen.getByTestId('ready-plan').textContent).toContain('No training rows for TAG1-I1');
    });
});

describe('ExportModal — folder, files, first focus', () => {
    it('first focus: "Export N models" when ready and a folder is known', () => {
        renderModal();
        expect(document.activeElement).toBe(screen.getByTestId('export-start'));
        expect(screen.getByTestId('export-start').textContent).toContain('Export 2 models');
    });

    it('first focus: "Choose folder…" without a folder; the picker starts at the last folder and its answer is used', async () => {
        const exp = fakeExp({ lastDir: null });
        renderModal({ exp });
        const choose = screen.getByText('Choose folder…');
        expect(document.activeElement).toBe(choose);
        expect(screen.getByTestId('export-why').textContent).toBe('Choose a folder first');
        mockOpenDialog.mockResolvedValue('D:\\results');
        await act(async () => { fireEvent.click(choose); });
        expect(mockOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
        expect(screen.getByTestId('export-dest').textContent).toContain('D:\\results');
        fireEvent.click(screen.getByTestId('export-start'));
        expect(exp.start).toHaveBeenCalledWith('D:\\results', expect.any(Date));
    });

    it('the picker opens at the remembered folder', async () => {
        renderModal();
        mockOpenDialog.mockResolvedValue(null);
        await act(async () => { fireEvent.click(screen.getByText('Change…')); });
        expect(mockOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: 'C:\\exports' }));
        expect(screen.getByTestId('export-dest').textContent).toContain('C:\\exports');
    });

    it('What is written comes from the dry run; the file tree and Peek show the real JSON / CSV / machine_info', () => {
        renderModal();
        const w = screen.getByTestId('export-written').textContent ?? '';
        expect(w).toContain('2 models');
        expect(w).toContain('5 files');
        expect(w).toContain('2,100 training rows');
        expect(w).toContain(`≈ ${fmtBytes(66_000)}`);
        expect(w).toContain('timestamps written as UTC+07:00');
        fireEvent.click(screen.getByText('Show the files'));
        const tree = screen.getByTestId('export-tree');
        expect(tree.textContent).toContain('TAG1-I1.json');
        expect(tree.textContent).toContain('TAG2-R1.csv');
        expect(tree.textContent).toContain('1,200 training rows');
        fireEvent.click(within(tree).getByText('machine_info.json'));
        expect(screen.getByTestId('export-peek').textContent).toContain('"plant": "Plant A"');
        fireEvent.click(within(tree).getByText('TAG1-I1.csv'));
        const peek = screen.getByTestId('export-peek').textContent ?? '';
        expect(peek).toContain('TimeStamp,TAG1');
        expect(peek).toContain('2026-02-09T00:00:00+07:00,1.5');
        expect(peek).toContain('First 2 of 1,200 rows');
        fireEvent.click(within(tree).getByText('TAG2-R1.json'));
        expect(screen.getByTestId('export-peek').textContent).toContain('"model_key": "TAG2-R1"');
    });

    it('while the dry run is still working, Export waits', () => {
        renderModal({ exp: fakeExp({ phase: 'planning', exportPlan: null }) });
        expect(screen.getByTestId('export-planning')).toBeTruthy();
        expect((screen.getByTestId('export-start') as HTMLButtonElement).disabled).toBe(true);
    });

    it('the folder name follows the project name, with the time', () => {
        renderModal();
        expect(screen.getByText(/^Plant_A_GT-1_\d{4}-\d{2}-\d{2}_\d{4}$/)).toBeTruthy();
    });
});

describe('ExportModal — confirm step for sensors without a component', () => {
    const nc: NoComponentSensor[] = [
        { tag: 'TAG2', special: false, modelIds: ['m2'], runningStatus: false },
        { tag: 'RUN', special: false, modelIds: [], runningStatus: true },
        { tag: 'SP1', special: true, modelIds: ['m1'], runningStatus: false },
    ];

    it('Export first asks; each sensor says where it goes, who uses it and its one fix; Back is focused', () => {
        renderModal({ readiness: readiness({ noComponent: nc, items: items({ noComponent: 3 }) }) });
        fireEvent.click(screen.getByTestId('export-start'));
        expect(screen.getByText('Export with sensors that have no component?')).toBeTruthy();
        expect(document.activeElement?.textContent).toBe('Back');
        const tag2 = screen.getByTestId('export-nc-TAG2').textContent ?? '';
        expect(tag2).toContain('Pump Temp');
        expect(tag2).toContain('→ written under “Uncategorized”');
        expect(tag2).toContain('Used by');
        expect(tag2).toContain('Relation model');
        expect(tag2).toContain('TAG2-R1');
        expect(tag2).toContain('the tag-name file (Import)');
        const run = screen.getByTestId('export-nc-RUN').textContent ?? '';
        expect(run).toContain('Used as the running-status sensor');
        expect(screen.getByTestId('export-nc-SP1').textContent).toContain('Special Sensors › Manage');
    });

    it('Back returns to the checklist; Esc does too (the dialog stays open)', () => {
        const { props } = renderModal({ readiness: readiness({ noComponent: nc, items: items({ noComponent: 3 }) }) });
        fireEvent.click(screen.getByTestId('export-start'));
        fireEvent.click(screen.getByText('Back'));
        expect(screen.queryByTestId('export-confirm')).toBeNull();
        fireEvent.click(screen.getByTestId('export-start'));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('export-confirm')).toBeNull();
        expect(screen.getByTestId('export-readiness')).toBeTruthy();
        expect(props.onClose).not.toHaveBeenCalled();
    });

    it('Export anyway starts the export into the folder', () => {
        const exp = fakeExp();
        renderModal({ exp, readiness: readiness({ noComponent: nc, items: items({ noComponent: 3 }) }) });
        fireEvent.click(screen.getByTestId('export-start'));
        fireEvent.click(screen.getByTestId('export-anyway'));
        expect(exp.start).toHaveBeenCalledWith('C:\\exports', expect.any(Date));
    });
});

describe('ExportModal — keyboard', () => {
    it('Esc closes the dialog', () => {
        const { props } = renderModal();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).toHaveBeenCalled();
    });

    it('with Project details on top (stacked), Esc and Tab are left to it', () => {
        const { props } = renderModal({ stacked: true });
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).not.toHaveBeenCalled();
    });

    it('an Esc another dialog already handled (defaultPrevented) is ignored', () => {
        const { props } = renderModal();
        const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        e.preventDefault();
        act(() => { window.dispatchEvent(e); });
        expect(props.onClose).not.toHaveBeenCalled();
    });

    it('focus goes back to the opener when it closes', () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const { unmount } = renderModal();
        expect(document.activeElement).not.toBe(opener);
        unmount();
        expect(document.activeElement).toBe(opener);
        opener.remove();
    });
});

describe('ExportModal — writing, done, failed, cancelled', () => {
    it('writing: "Exporting…" first; after the delay, "Writing model n of N", Hide and Cancel export; Esc hides', () => {
        const exp = fakeExp({ phase: 'running', progress: { written: 1, total: 2, modelKey: 'TAG1-I1' }, showProgress: true });
        renderModal({ exp });
        expect(screen.getByText('Writing model 2 of 2')).toBeTruthy();
        expect(screen.getByTestId('export-current').textContent).toContain('TAG2-R1');
        expect(screen.getByTestId('export-current').textContent).toContain('Pump Temp');
        expect(screen.getByTestId('export-row-m1').textContent).toContain('✓ Written');
        expect(screen.getByTestId('export-row-m2').textContent).toContain('Writing…');
        expect(document.activeElement?.textContent).toBe('Hide');
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(exp.hide).toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('export-cancel'));
        expect(exp.cancel).toHaveBeenCalled();
        // No X while it writes.
        expect(screen.queryByLabelText('Close')).toBeNull();
    });

    it('a quick export shows no progress (only "Exporting…")', () => {
        renderModal({ exp: fakeExp({ phase: 'running', showProgress: false }) });
        expect(screen.getByText('Exporting…')).toBeTruthy();
        expect(screen.queryByText('Hide')).toBeNull();
    });

    it('hidden: the dialog stays mounted but out of sight', () => {
        renderModal({ exp: fakeExp({ phase: 'running', hidden: true }) });
        const backdrop = screen.getByTestId('export-dialog').parentElement as HTMLElement;
        expect(backdrop.style.display).toBe('none');
    });

    it('done: the folder and Open folder (reveal_export_folder)', async () => {
        const exp = fakeExp({ phase: 'done', result: { folder: 'C:\\exports\\Plant_A_GT-1_2026-10-20_1140', files: 5, models: 2, rows: 2100, bytes: 66000, exported_at: '2026-10-20T11:40:00+07:00', warnings: [] } });
        renderModal({ exp });
        expect(screen.getByText('2 models exported')).toBeTruthy();
        expect(screen.getByTestId('export-done').textContent).toContain('C:\\exports\\Plant_A_GT-1_2026-10-20_1140');
        expect(document.activeElement?.textContent).toContain('Open folder');
        await act(async () => { fireEvent.click(screen.getByText('Open folder')); });
        expect(mockInvoke).toHaveBeenCalledWith('reveal_export_folder', { path: 'C:\\exports\\Plant_A_GT-1_2026-10-20_1140' });
    });

    it('failed: "Nothing was written" with the reason; Choose another folder… stays put when the picker is cancelled', async () => {
        const exp = fakeExp({ phase: 'failed', error: { code: 'WRITE_FAILED', message: 'models/TAG1-I1.csv (Access is denied.)' } });
        renderModal({ exp });
        expect(screen.getByTestId('export-failed').textContent).toContain('Nothing was written');
        expect(screen.getByTestId('export-error').textContent).toBe('models/TAG1-I1.csv (Access is denied.)');
        mockOpenDialog.mockResolvedValue(null);
        await act(async () => { fireEvent.click(screen.getByText('Choose another folder…')); });
        expect(exp.plan).not.toHaveBeenCalled();
        expect(screen.getByTestId('export-failed')).toBeTruthy();
        mockOpenDialog.mockResolvedValue('E:\\other');
        await act(async () => { fireEvent.click(screen.getByText('Choose another folder…')); });
        expect(exp.plan).toHaveBeenCalled();
    });

    it('failed: Try again writes again into the folder', () => {
        const exp = fakeExp({ phase: 'failed', error: { code: null, message: 'boom' } });
        renderModal({ exp });
        fireEvent.click(screen.getByText('Try again'));
        expect(exp.start).toHaveBeenCalledWith('C:\\exports', expect.any(Date));
    });

    it('cancelled: back to the checklist with "Export cancelled · nothing was written"', () => {
        renderModal({ exp: fakeExp({ phase: 'cancelled' }) });
        expect(screen.getByTestId('export-cancelled').textContent).toContain('Export cancelled · nothing was written');
        expect(screen.getByTestId('export-readiness')).toBeTruthy();
    });

    it('never names the algorithm', () => {
        const { container } = renderModal();
        expect(container.textContent ?? '').not.toMatch(/gam/i);
    });
});
