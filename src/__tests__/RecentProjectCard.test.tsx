/**
 * RecentProjectCard -- the Rename / Delete actions must never fall through to
 * "open the project".
 *
 * In the real app (Tauri / WebView2) clicking the pencil or the red
 * trash on a recent-project card must not load the workspace. A plain
 * `fireEvent.click(renameButton)` always passes, because jsdom does no hit
 * testing. The hazard (seen in Chromium with real clicks): while the
 * actions were shown, the time label (opacity 0 -> its own stacking context)
 * painted ABOVE the buttons (opacity 1, no stacking context), so the click hit
 * the invisible "2 h ago" and bubbled to the card. Further fall-through paths:
 *   1. the actions were hit-testable ONLY while React's hover/focus state was
 *      true (`pointer-events: none` otherwise) -- a lost hover state (a
 *      spurious mouseleave, a touch tap) let the press land on the time label
 *      / full-card "Open" button underneath, whose click opens the project;
 *   2. a press that starts on Rename/Delete and is released on another element
 *      makes the browser dispatch `click` to the common ancestor -- the card,
 *      whose onClick opens the project.
 * These tests drive those paths directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RecentProjectCard from '../components/upload/RecentProjectCard';
import { DARK } from '../components/upload/uploadTheme';

const PROJECT = { id: 'ws_1', name: 'test', description: '', lastModified: Date.now() - 3_600_000, failureGroupCount: 3, failureGroupNos: [1, 2, 3] };

function setup() {
    const onOpen = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(<RecentProjectCard T={DARK} project={PROJECT} onOpen={onOpen} onRename={onRename} onDelete={onDelete} />);
    return {
        onOpen, onRename, onDelete,
        card: screen.getByTestId('project-card'),
        actions: screen.getByTestId('project-card-actions'),
        rename: screen.getByLabelText('Rename project test'),
        del: screen.getByLabelText('Delete project test'),
    };
}

/** True when the element (or an ancestor up to the card) has pointer-events:none,
 *  i.e. a real browser would hit-test THROUGH it. */
function hitTestsThrough(el: HTMLElement): boolean {
    for (let n: HTMLElement | null = el; n && n.dataset.testid !== 'project-card'; n = n.parentElement) {
        if (n.style.pointerEvents === 'none') return true;
    }
    return false;
}

describe('RecentProjectCard -- Rename/Delete never open the project', () => {
    it('the invisible time label can never take the click, and the buttons are layered above it', () => {
        const { card, rename } = setup();
        fireEvent.mouseEnter(card);
        const time = screen.getByText('1 h ago');
        expect(time.style.opacity).toBe('0');
        expect(time.style.pointerEvents).toBe('none');
        const actions = rename.parentElement as HTMLElement;
        expect(actions.style.position).toBe('relative');
        expect(Number(actions.style.zIndex)).toBeGreaterThan(0);
    });

    it('the action buttons stay hit-testable when the card has lost its hover state (no fall-through to Open)', () => {
        const { card, rename, del } = setup();
        // Never hovered.
        expect(hitTestsThrough(rename)).toBe(false);
        expect(hitTestsThrough(del)).toBe(false);
        // Hovered, then a spurious mouseleave while the pointer is still there.
        fireEvent.mouseEnter(card);
        fireEvent.mouseLeave(card);
        expect(hitTestsThrough(rename)).toBe(false);
        expect(hitTestsThrough(del)).toBe(false);
    });

    it('a press on Rename whose click is retargeted to the card (released elsewhere) does not open', () => {
        const { onOpen, card, rename } = setup();
        fireEvent.mouseEnter(card);
        fireEvent.pointerDown(rename, { pointerType: 'mouse' });
        fireEvent.mouseDown(rename);
        // mouseup on another element -> the browser fires click on the common ancestor.
        fireEvent.click(card, { detail: 1 });
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('a press on Delete whose click is retargeted to the actions cell does not open', () => {
        const { onOpen, card, actions, del } = setup();
        fireEvent.mouseEnter(card);
        fireEvent.pointerDown(del, { pointerType: 'mouse' });
        fireEvent.click(actions, { detail: 1 });
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('a click on the time label (where the hidden actions sit) does not open', () => {
        const { onOpen } = setup();
        const time = screen.getByText('1 h ago');
        fireEvent.pointerDown(time, { pointerType: 'mouse' });
        fireEvent.click(time, { detail: 1 });
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('clicking Rename after a lost hover still starts the rename (and never opens)', () => {
        const { onOpen, card, rename } = setup();
        fireEvent.mouseEnter(card);
        fireEvent.mouseLeave(card);
        fireEvent.pointerDown(rename, { pointerType: 'mouse' });
        fireEvent.click(rename, { detail: 1 });
        expect(screen.getByLabelText('Project name')).toBeTruthy();
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('clicking Delete after a lost hover still asks for confirmation (and never opens)', () => {
        const { onOpen, onDelete, card, del } = setup();
        fireEvent.mouseEnter(card);
        fireEvent.mouseLeave(card);
        fireEvent.pointerDown(del, { pointerType: 'mouse' });
        fireEvent.click(del, { detail: 1 });
        expect(screen.getByRole('alertdialog')).toBeTruthy();
        expect(onOpen).not.toHaveBeenCalled();
        expect(onDelete).not.toHaveBeenCalled();
    });

    it('a finger tap on the still-invisible actions only reveals them -- no rename, no delete prompt, no open', () => {
        const { onOpen, rename, del } = setup();
        fireEvent.pointerDown(del, { pointerType: 'touch' });
        fireEvent.click(del, { detail: 1 });
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(onOpen).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(del);
        // Now visible: the next tap acts.
        expect((rename.parentElement as HTMLElement).style.opacity).toBe('1');
        fireEvent.pointerDown(del, { pointerType: 'touch' });
        fireEvent.click(del, { detail: 1 });
        expect(screen.getByRole('alertdialog')).toBeTruthy();
    });

    it('clicking the card body still opens it', () => {
        const { onOpen } = setup();
        const name = screen.getByText('test');
        fireEvent.pointerDown(name, { pointerType: 'mouse' });
        fireEvent.click(name, { detail: 1 });
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    // Code-review follow-up: a press record left behind must not swallow a
    // later click that has no pointerdown of its own.
    describe('a used-up or abandoned press in the actions cell is forgotten', () => {
        const clickBodyWithoutPress = () => fireEvent.click(screen.getByText('test'), { detail: 1 });

        it('released outside the card (abandoned drag)', () => {
            const { onOpen, rename } = setup();
            fireEvent.pointerDown(rename, { pointerType: 'mouse' });
            fireEvent.pointerUp(document.body, { pointerType: 'mouse' });
            clickBodyWithoutPress();
            expect(onOpen).toHaveBeenCalledTimes(1);
        });

        it('cancelled (touch scroll)', () => {
            const { onOpen, del } = setup();
            fireEvent.pointerDown(del, { pointerType: 'touch' });
            fireEvent.pointerCancel(del, { pointerType: 'touch' });
            clickBodyWithoutPress();
            expect(onOpen).toHaveBeenCalledTimes(1);
        });

        it('used up by Rename (its click never reaches the card)', () => {
            const { onOpen, rename } = setup();
            fireEvent.pointerDown(rename, { pointerType: 'mouse' });
            fireEvent.pointerUp(rename, { pointerType: 'mouse' });
            fireEvent.click(rename, { detail: 1 });
            fireEvent.keyDown(screen.getByLabelText('Project name'), { key: 'Escape' });
            clickBodyWithoutPress();
            expect(onOpen).toHaveBeenCalledTimes(1);
        });

        it('but a press released INSIDE the card still blocks the retargeted click', () => {
            const { onOpen, card, rename } = setup();
            fireEvent.pointerDown(rename, { pointerType: 'mouse' });
            fireEvent.pointerUp(screen.getByText('test'), { pointerType: 'mouse' });
            fireEvent.click(card, { detail: 1 });
            expect(onOpen).not.toHaveBeenCalled();
        });
    });

    it('keyboard Enter on "Open …" still opens, even right after a press on Rename', () => {
        const { onOpen, rename } = setup();
        fireEvent.pointerDown(rename, { pointerType: 'mouse' });
        // Keyboard-activated click: detail 0, no press of its own.
        fireEvent.click(screen.getByLabelText('Open test'), { detail: 0 });
        expect(onOpen).toHaveBeenCalledTimes(1);
    });
});

describe('RecentProjectCard -- Project details (Plant · Machine)', () => {
    const MACHINE_PROJECT = {
        id: 'ws_2', name: 'Bang Pakong · Gas Engine Generator 4', description: 'U-2010 · Rated 8 MW',
        lastModified: Date.now() - 3_600_000,
    };

    it('title is "Plant · Machine" (full name in the title tooltip); the second line is "tag · notes"', () => {
        render(<RecentProjectCard T={DARK} project={MACHINE_PROJECT} />);
        const title = screen.getByText('Bang Pakong · Gas Engine Generator 4');
        expect(title.getAttribute('title')).toBe('Bang Pakong · Gas Engine Generator 4');
        expect(screen.getByText('U-2010 · Rated 8 MW')).toBeTruthy();
    });

    it('with onEditDetails, Rename opens Project details instead of an in-place edit, and never opens the project', () => {
        const onOpen = vi.fn();
        const onRename = vi.fn();
        const onEditDetails = vi.fn();
        render(<RecentProjectCard T={DARK} project={MACHINE_PROJECT} onOpen={onOpen} onRename={onRename} onEditDetails={onEditDetails} />);
        const rename = screen.getByLabelText(`Rename project ${MACHINE_PROJECT.name}`);
        expect(rename.getAttribute('title')).toBe('Rename (opens Project details)');
        fireEvent.click(rename);
        expect(onEditDetails).toHaveBeenCalledTimes(1);
        expect(screen.queryByLabelText('Project name')).toBeNull();
        expect(onRename).not.toHaveBeenCalled();
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('the static preview shows "Plant · Machine" / "Machine tag · notes" placeholders while empty', () => {
        render(<RecentProjectCard T={DARK} preview project={{ id: '', name: '', description: '', lastModified: 0 }} />);
        expect(screen.getByText('Plant · Machine')).toBeTruthy();
        expect(screen.getByText('Machine tag · notes')).toBeTruthy();
    });
});
