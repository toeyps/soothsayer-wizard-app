import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { WorkspaceState } from '../types';

// The rules (required fields, duplicate pair, derived name) are the real ones;
// only the ONE writer is stubbed.
const mockSave = vi.fn();
vi.mock('../utils/projectDetails', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/projectDetails')>();
    return { ...actual, saveProjectDetails: (...a: unknown[]) => mockSave(...a) };
});

import { ProjectDetailsModal, isoExample } from '../components/windows/ProjectDetailsModal';

const PC = -new Date().getTimezoneOffset() || 0;
const fmt = (m: number) => `${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;

type Ws = Pick<WorkspaceState, 'id' | 'name' | 'machine' | 'dataUtcOffsetMin'>;
const NEW_WS: Ws = {
    id: 'ws_1',
    name: 'Bang Pakong · GEG 4',
    machine: { plant: 'Bang Pakong', name: 'GEG 4', tag: 'U-2010', notes: 'Rated 8 MW' },
    dataUtcOffsetMin: 420,
};
const OLD_WS: Ws = { id: 'ws_old', name: 'Compressor study' };

const plant = () => screen.getByPlaceholderText('e.g. Bang Pakong') as HTMLInputElement;
const machine = () => screen.getByPlaceholderText('e.g. Gas Engine Generator 4') as HTMLInputElement;
const tag = () => screen.getByPlaceholderText('e.g. U-2010') as HTMLInputElement;
const notes = () => screen.getByPlaceholderText(/What this project is about/) as HTMLTextAreaElement;
const saveBtn = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const reason = () => within(screen.getByRole('dialog')).getByRole('status').textContent;
const tzSelect = () => screen.getByRole('combobox', { name: 'Timestamps in the CSV are local time of' }) as HTMLSelectElement;

function renderModal(ws: Ws = NEW_WS, extra: Partial<Parameters<typeof ProjectDetailsModal>[0]> = {}) {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ProjectDetailsModal workspace={ws} existing={[]} onSaved={onSaved} onClose={onClose} {...extra} />);
    return { onSaved, onClose };
}

beforeEach(() => {
    mockSave.mockReset().mockImplementation(async (id: string, v: { machine: { plant: string; name: string } }) => ({
        workspaceId: id, name: `${v.machine.plant.trim()} · ${v.machine.name.trim()}`, description: '',
    }));
});
afterEach(() => cleanup());

describe('ProjectDetailsModal', () => {
    it('prefills the machine and the data time zone; Save is disabled until something changes', () => {
        renderModal();
        expect(screen.getByRole('dialog', { name: 'Project details' })).toBeTruthy();
        expect(plant().value).toBe('Bang Pakong');
        expect(machine().value).toBe('GEG 4');
        expect(tag().value).toBe('U-2010');
        expect(notes().value).toBe('Rated 8 MW');
        expect(tzSelect().value).toBe('420');
        expect(saveBtn().disabled).toBe(true);
        expect(screen.queryByTestId('pdm-old-project')).toBeNull();
        // Every required field is filled: first focus = Plant name.
        expect(document.activeElement).toBe(plant());
    });

    it('an old project (no machine yet): Plant = its old name, one explanatory line, focus on the first EMPTY required field, offset = this PC', () => {
        renderModal(OLD_WS);
        expect(plant().value).toBe('Compressor study');
        expect(machine().value).toBe('');
        expect(screen.getByTestId('pdm-old-project').textContent).toMatch(/made before plant and machine were asked for/);
        expect(document.activeElement).toBe(machine());
        expect(tzSelect().value).toBe(String(PC));
        expect(saveBtn().disabled).toBe(true);
        expect(reason()).toBe('Enter the machine name and machine tag to save');
        expect(saveBtn().title).toBe('Enter the machine name and machine tag to save');
    });

    it('a pair another project uses (not itself) blocks Save with a red reason; its own name never counts', () => {
        renderModal(NEW_WS, { existing: [{ id: 'ws_1', name: 'Bang Pakong · GEG 4' }, { id: 'ws_2', name: 'Map Ta Phut · GT 11' }] });
        // Its own current name is not a duplicate.
        fireEvent.change(notes(), { target: { value: 'changed' } });
        expect(saveBtn().disabled).toBe(false);

        fireEvent.change(plant(), { target: { value: 'map ta phut' } });
        fireEvent.change(machine(), { target: { value: ' GT 11 ' } });
        expect(saveBtn().disabled).toBe(true);
        expect(reason()).toBe('Another project already uses this plant and machine');
        expect(within(screen.getByRole('dialog')).getByRole('status').className).toContain('tq-reason--danger');
        expect(screen.getByRole('alert').textContent).toBe('Another project already uses this plant and machine — change one of them.');
    });

    it('footer says what the save does: "Saving renames the project to …" only when the name changes', () => {
        renderModal();
        fireEvent.change(notes(), { target: { value: 'New notes' } });
        expect(reason()).toBe('Not saved yet');
        fireEvent.change(machine(), { target: { value: 'GEG 5' } });
        expect(reason()).toBe('Saving renames the project to Bang Pakong · GEG 5');
    });

    it('saves ONLY through saveProjectDetails (machine + offset), then reports the payload and closes', async () => {
        const { onSaved, onClose } = renderModal();
        fireEvent.change(machine(), { target: { value: 'GEG 5' } });
        fireEvent.change(tzSelect(), { target: { value: '330' } });
        await act(async () => { fireEvent.click(saveBtn()); });

        expect(mockSave).toHaveBeenCalledTimes(1);
        expect(mockSave).toHaveBeenCalledWith('ws_1', {
            machine: { plant: 'Bang Pakong', name: 'GEG 5', tag: 'U-2010', notes: 'Rated 8 MW' },
            dataUtcOffsetMin: 330,
        });
        expect(onSaved).toHaveBeenCalledWith({ workspaceId: 'ws_1', name: 'Bang Pakong · GEG 5', description: '' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a save that could not read the project keeps the dialog open with an error', async () => {
        mockSave.mockResolvedValue(null);
        const { onSaved, onClose } = renderModal();
        fireEvent.change(notes(), { target: { value: 'x' } });
        await act(async () => { fireEvent.click(saveBtn()); });
        expect(onSaved).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(reason()).toMatch(/Could not save the project details/);
    });

    it('Esc closes ONLY this dialog: handled in the capture phase, so nothing underneath sees it', () => {
        const outer = vi.fn();
        window.addEventListener('keydown', outer);
        const { onClose } = renderModal();
        fireEvent.keyDown(plant(), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(outer).not.toHaveBeenCalled();
        window.removeEventListener('keydown', outer);
    });

    it('closing returns focus to the opener', async () => {
        function Host() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button onClick={() => setOpen(true)}>opener</button>
                    {open && <ProjectDetailsModal workspace={NEW_WS} onSaved={() => {}} onClose={() => setOpen(false)} />}
                </>
            );
        }
        render(<Host />);
        const opener = screen.getByText('opener');
        opener.focus();
        fireEvent.click(opener);
        expect(document.activeElement).toBe(plant());
        fireEvent.keyDown(plant(), { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.activeElement).toBe(opener);
    });

    it('shows how the export writes a timestamp with the chosen offset (no-wrap), using the data\'s first timestamp when known', () => {
        renderModal(NEW_WS, { firstTimestamp: '2025/03/01 06:30' });
        const ex = screen.getByTestId('pdm-iso-example');
        expect(ex.textContent).toContain('2025/03/01 06:30 as 2025-03-01T06:30:00+07:00');
        expect(ex.querySelectorAll('.pdm-nw')).toHaveLength(2);
        fireEvent.change(tzSelect(), { target: { value: '-210' } });
        expect(ex.textContent).toContain('2025-03-01T06:30:00-03:30');
    });

    it('without a known first timestamp the line says it is an example', () => {
        renderModal();
        expect(screen.getByTestId('pdm-iso-example').textContent).toMatch(/^For example, 2026\/02\/09 00:00 as 2026-02-09T00:00:00\+07:00/);
    });

    it('the time-zone picker marks this PC', () => {
        renderModal();
        const opt = Array.from(tzSelect().options).find(o => o.value === String(PC));
        expect(opt?.textContent).toBe(`UTC${fmt(PC)} · this PC`);
    });
});

describe('isoExample', () => {
    it('writes the Wizard display form and ISO-ish forms as ISO 8601 with the offset', () => {
        expect(isoExample('2026/02/09 00:00', 420)).toBe('2026-02-09T00:00:00+07:00');
        expect(isoExample('2026-02-09 13:05:07', -300)).toBe('2026-02-09T13:05:07-05:00');
        expect(isoExample('2026-02-09T13:05', 345)).toBe('2026-02-09T13:05:00+05:45');
    });
});
