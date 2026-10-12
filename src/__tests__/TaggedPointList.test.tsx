import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import TaggedPointList, { firstFreeColorIndex, splitStamp, type TaggedPointListItem } from '../components/charts/TaggedPointList';

const items = [
    { id: 'a', badge: '①', color: '#ff0000', label: '2026/01/01 00:01' },
    { id: 'b', badge: '②', color: '#00ff00', label: '2026/01/01 00:02' },
];

describe('TaggedPointList (per-tag remove, shared by Line and Scatter)', () => {
    it('renders nothing with no tags', () => {
        const { container } = render(<TaggedPointList items={[]} onRemove={vi.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders one row per tag: a dot in the tag colour (no number in it) and its label', () => {
        render(<TaggedPointList items={items} onRemove={vi.fn()} />);
        const rows = within(screen.getByRole('list', { name: 'Tagged points' })).getAllByRole('listitem');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toBe('2026/01/01 00:01'); // one readable stamp, shown as two lines
        expect(rows[0].querySelector('.chart-tag-date')!.textContent).toBe('2026/01/01');
        expect(rows[0].querySelector('.chart-tag-time')!.textContent).toBe('00:01');
        expect(rows[0].querySelector('.chart-tag-label')!.getAttribute('title')).toBe('2026/01/01 00:01');
        expect((rows[1] as HTMLElement).style.getPropertyValue('--tag-c')).toBe('#00ff00');
        expect(rows[0].querySelector('.chart-tag-dot')!.textContent).toBe('');
        expect((rows[1].querySelector('.chart-tag-dot') as HTMLElement).style.background).toBe('rgb(0, 255, 0)');
    });

    it('each row has a native remove button named after its tag, calling onRemove with that tag id only', () => {
        const onRemove = vi.fn();
        render(<TaggedPointList items={items} onRemove={onRemove} />);
        const btn = screen.getByRole('button', { name: 'Remove tag ② 2026/01/01 00:02' });
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.getAttribute('type')).toBe('button');
        btn.focus();
        expect(document.activeElement).toBe(btn); // focusable -> reachable with Tab
        fireEvent.click(btn);
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(onRemove).toHaveBeenCalledWith('b');
    });
});

/** Owns the list state like LineChart/ScatterChart do (the list itself is
 *  presentation only), plus a stand-in for the toolbox's Tag button. */
function Harness({ initial }: { initial: TaggedPointListItem[] }) {
    const [list, setList] = useState(initial);
    const tagButtonRef = useRef<HTMLButtonElement>(null);
    return (
        <>
            <button type="button" ref={tagButtonRef}>Tag point</button>
            <TaggedPointList
                items={list}
                onRemove={id => setList(prev => prev.filter(t => t.id !== id))}
                emptyFocusRef={tagButtonRef}
            />
        </>
    );
}

describe('TaggedPointList keyboard focus after a remove (the focused row unmounts)', () => {
    const three: TaggedPointListItem[] = [
        { id: 'a', badge: '①', color: '#f00', label: 'A' },
        { id: 'b', badge: '②', color: '#0f0', label: 'B' },
        { id: 'c', badge: '③', color: '#00f', label: 'C' },
    ];

    it('moves focus to the NEXT row’s × when a middle row is removed', () => {
        render(<Harness initial={three} />);
        const btn = screen.getByRole('button', { name: 'Remove tag ② B' });
        btn.focus();
        fireEvent.click(btn);
        expect(screen.queryByRole('button', { name: /B$/ })).toBeNull();
        // Row C survives the re-render (keyed by id), so it keeps focus. (This
        // harness doesn't renumber badges — the charts do that themselves.)
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove tag ③ C' }));
    });

    it('moves focus to the PREVIOUS row’s × when the last row is removed', () => {
        render(<Harness initial={three} />);
        const btn = screen.getByRole('button', { name: 'Remove tag ③ C' });
        btn.focus();
        fireEvent.click(btn);
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove tag ② B' }));
    });

    it('moves focus to emptyFocusRef (the toolbox Tag button) when the only tag is removed', () => {
        render(<Harness initial={[three[0]]} />);
        const btn = screen.getByRole('button', { name: 'Remove tag ① A' });
        btn.focus();
        fireEvent.click(btn);
        expect(screen.queryByRole('list', { name: 'Tagged points' })).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tag point' }));
    });

    it('pressing Enter repeatedly (keyboard click) removes tag after tag without re-tabbing', () => {
        render(<Harness initial={three} />);
        screen.getByRole('button', { name: 'Remove tag ① A' }).focus();
        for (let i = 0; i < 3; i++) fireEvent.click(document.activeElement as HTMLElement);
        expect(screen.queryByRole('list', { name: 'Tagged points' })).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tag point' }));
    });
});

describe('firstFreeColorIndex', () => {
    it('returns the lowest palette slot not in use', () => {
        expect(firstFreeColorIndex([], 8)).toBe(0);
        expect(firstFreeColorIndex([0, 1, 2], 8)).toBe(3);
        expect(firstFreeColorIndex([0, 2], 8)).toBe(1); // a removed middle tag frees its colour
    });

    it('ignores unknown (-1) slots and falls back to wrapping when every slot is taken', () => {
        expect(firstFreeColorIndex([-1, 0], 8)).toBe(1);
        expect(firstFreeColorIndex([0, 1], 2)).toBe(0);
    });
});

describe('splitStamp (the head of a point shows the date over the time)', () => {
    it('splits the one date-time format of the app, with or without seconds; anything else stays whole', () => {
        expect(splitStamp('2026/06/21 03:10:00')).toEqual(['2026/06/21', '03:10:00']);
        expect(splitStamp('2026/06/21 03:10')).toEqual(['2026/06/21', '03:10']);
        expect(splitStamp('Point 3')).toEqual(['Point 3']);
        expect(splitStamp('2026-06-21T03:10:00')).toEqual(['2026-06-21T03:10:00']);
        expect(splitStamp('')).toEqual(['']);
    });
});
