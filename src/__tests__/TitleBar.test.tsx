import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const mockMinimize = vi.fn();
const mockToggleMaximize = vi.fn();
const mockClose = vi.fn();
const mockGetCurrentWindow = vi.fn(() => ({
    minimize: mockMinimize, toggleMaximize: mockToggleMaximize, close: mockClose,
}));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => mockGetCurrentWindow(),
}));

let mockIsMacOS = false;
vi.mock('../hooks/useIsMacOS', () => ({
    useIsMacOS: () => mockIsMacOS,
}));

import TitleBar from '../components/TitleBar';

beforeEach(() => {
    mockIsMacOS = false;
    mockMinimize.mockClear();
    mockToggleMaximize.mockClear();
    mockClose.mockClear();
});

afterEach(() => {
    cleanup();
});

describe('TitleBar', () => {
    it('shows no workspace section when workspaceName is undefined', () => {
        render(<TitleBar />);
        expect(screen.queryByText('Project:')).toBeNull();
    });

    it('shows "Project:" and the name, falling back to "Unnamed project" when empty', () => {
        const { rerender } = render(<TitleBar workspaceName="My WS" />);
        expect(screen.getByText('Project:')).toBeTruthy();
        expect(screen.getByText('My WS')).toBeTruthy();

        rerender(<TitleBar workspaceName="" />);
        expect(screen.getByText('Unnamed project')).toBeTruthy();
    });

    describe('project menu (with onOpenDetails)', () => {
        const projectButton = () => screen.getByRole('button', { name: /Bang Pakong · GEG 4/ });

        it('the name is a menu button: Rename… and Project details… both open Project details; no in-place edit', () => {
            const onOpenDetails = vi.fn();
            render(<TitleBar workspaceName="Bang Pakong · GEG 4" onOpenDetails={onOpenDetails} />);
            expect(projectButton().getAttribute('aria-haspopup')).toBe('menu');
            expect(projectButton().getAttribute('aria-expanded')).toBe('false');

            fireEvent.click(projectButton());
            expect(projectButton().getAttribute('aria-expanded')).toBe('true');
            const items = screen.getAllByRole('menuitem');
            expect(items.map(i => i.textContent)).toEqual([
                'Rename…Plant · Machine',
                'Project details…Plant, machine, tag, notes, time zone',
            ]);
            fireEvent.click(items[0]);
            expect(onOpenDetails).toHaveBeenCalledTimes(1);
            expect(screen.queryByRole('menu')).toBeNull();
            expect(screen.queryByRole('textbox')).toBeNull();
            // Focus is back on the project button (the dialog returns it there).
            expect(document.activeElement).toBe(projectButton());

            fireEvent.click(projectButton());
            fireEvent.click(screen.getByRole('menuitem', { name: /Project details/ }));
            expect(onOpenDetails).toHaveBeenCalledTimes(2);
        });

        it('keyboard: opening focuses the first item, arrows move (wrapping), Esc closes and returns focus', () => {
            render(<TitleBar workspaceName="Bang Pakong · GEG 4" onOpenDetails={vi.fn()} />);
            fireEvent.click(projectButton());
            const [first, second] = screen.getAllByRole('menuitem');
            expect(document.activeElement).toBe(first);
            fireEvent.keyDown(first, { key: 'ArrowDown' });
            expect(document.activeElement).toBe(second);
            fireEvent.keyDown(second, { key: 'ArrowDown' });
            expect(document.activeElement).toBe(first);
            fireEvent.keyDown(first, { key: 'ArrowUp' });
            expect(document.activeElement).toBe(second);
            fireEvent.keyDown(second, { key: 'Escape' });
            expect(screen.queryByRole('menu')).toBeNull();
            expect(document.activeElement).toBe(projectButton());
        });

        it('a click outside closes the menu', () => {
            render(<TitleBar workspaceName="Bang Pakong · GEG 4" onOpenDetails={vi.fn()} />);
            fireEvent.click(projectButton());
            fireEvent.mouseDown(document.body);
            expect(screen.queryByRole('menu')).toBeNull();
        });

        it('app menu > Rename Workspace (renameTrigger) opens Project details once per bump, not again on a rename', () => {
            const onOpenDetails = vi.fn();
            const { rerender } = render(<TitleBar workspaceName="A" renameTrigger={0} onOpenDetails={onOpenDetails} />);
            expect(onOpenDetails).not.toHaveBeenCalled();
            rerender(<TitleBar workspaceName="A" renameTrigger={1} onOpenDetails={onOpenDetails} />);
            expect(onOpenDetails).toHaveBeenCalledTimes(1);
            expect(screen.queryByRole('textbox')).toBeNull();
            rerender(<TitleBar workspaceName="B" renameTrigger={1} onOpenDetails={onOpenDetails} />);
            expect(onOpenDetails).toHaveBeenCalledTimes(1);
        });
    });

    describe('without onOpenDetails', () => {
        it('the name is plain text: no inline edit, no menu (Project details is the only writer)', () => {
            const { rerender } = render(<TitleBar workspaceName="My WS" renameTrigger={0} />);
            fireEvent.click(screen.getByText('My WS'));
            expect(screen.queryByRole('textbox')).toBeNull();
            expect(screen.queryByRole('button', { name: /My WS/ })).toBeNull();
            rerender(<TitleBar workspaceName="My WS" renameTrigger={1} />);
            expect(screen.queryByRole('textbox')).toBeNull();
        });
    });

    describe('window controls', () => {
        it('are shown and wired on non-macOS', () => {
            mockIsMacOS = false;
            const { container } = render(<TitleBar />);
            const buttons = container.querySelectorAll('.titlebar-button');
            expect(buttons.length).toBe(3); // minimize + maximize + close

            fireEvent.click(container.querySelector('.titlebar-button:nth-child(1)')!); // minimize
            expect(mockMinimize).toHaveBeenCalled();

            fireEvent.click(container.querySelector('.titlebar-button:nth-child(2)')!); // maximize
            expect(mockToggleMaximize).toHaveBeenCalled();

            fireEvent.click(container.querySelector('.titlebar-button.close')!);
            expect(mockClose).toHaveBeenCalled();
        });

        it('are hidden on macOS (native traffic lights used instead)', () => {
            mockIsMacOS = true;
            const { container } = render(<TitleBar />);
            const buttons = container.querySelectorAll('.titlebar-button');
            expect(buttons.length).toBe(0);
        });
    });
});
