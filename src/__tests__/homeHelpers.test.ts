import { describe, it, expect } from 'vitest';
import type { WorkspaceMetadata } from '../types';
import {
  filterProjects,
  formatRelativeTime,
  isNewProjectShortcut,
  isTypingTarget,
  newProjectShortcutLabel,
  projectColor,
  projectInitials,
} from '../components/upload/homeHelpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-04T12:00:00Z').getTime();

describe('formatRelativeTime', () => {
  it('under a minute (and slightly in the future) reads "just now"', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW + 5 * MIN, NOW)).toBe('just now');
  });

  it('minutes, hours, days', () => {
    expect(formatRelativeTime(NOW - MIN, NOW)).toBe('1 min ago');
    expect(formatRelativeTime(NOW - 59 * MIN, NOW)).toBe('59 min ago');
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe('1 h ago');
    expect(formatRelativeTime(NOW - 2 * HOUR - 30 * MIN, NOW)).toBe('2 h ago');
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe('23 h ago');
    expect(formatRelativeTime(NOW - DAY, NOW)).toBe('1 d ago');
    expect(formatRelativeTime(NOW - 3 * DAY, NOW)).toBe('3 d ago');
    expect(formatRelativeTime(NOW - 30 * DAY, NOW)).toBe('30 d ago');
  });

  it('older than 30 days falls back to a calendar date', () => {
    const ts = NOW - 31 * DAY;
    expect(formatRelativeTime(ts, NOW)).toBe(
      new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    );
    expect(formatRelativeTime(ts, NOW)).toMatch(/\d{4}$/);
  });

  it('a missing or invalid timestamp yields an empty label (nothing invented)', () => {
    expect(formatRelativeTime(undefined, NOW)).toBe('');
    expect(formatRelativeTime(null, NOW)).toBe('');
    expect(formatRelativeTime(0, NOW)).toBe('');
    expect(formatRelativeTime(Number.NaN, NOW)).toBe('');
  });

  it('defaults "now" to the current time', () => {
    expect(formatRelativeTime(Date.now() - 2 * HOUR - 1000)).toBe('2 h ago');
  });
});

describe('projectInitials', () => {
  it('takes up to two initials, upper-cased', () => {
    expect(projectInitials('GEG-4 Bearing study')).toBe('GB');
    expect(projectInitials('compressor')).toBe('C');
    expect(projectInitials('a b c d')).toBe('AB');
  });
  it('falls back to "P" when there is nothing usable', () => {
    expect(projectInitials('')).toBe('P');
    expect(projectInitials('--- ///')).toBe('P');
  });
  it('handles non-latin names', () => {
    expect(projectInitials('เครื่องอัด 3')).toBe('เ3');
  });
});

describe('projectColor', () => {
  it('is deterministic per seed and an oklch colour', () => {
    expect(projectColor('ws_1')).toBe(projectColor('ws_1'));
    expect(projectColor('ws_1')).toMatch(/^oklch\(0\.55 0\.12 \d+\)$/);
  });
  it('spreads different seeds over more than one hue', () => {
    const hues = new Set(Array.from({ length: 40 }, (_, i) => projectColor(`ws_${i}`)));
    expect(hues.size).toBeGreaterThan(2);
  });
});

describe('filterProjects', () => {
  const list: WorkspaceMetadata[] = [
    { id: '1', name: 'Engine run', description: 'Bearing drift', lastModified: 1, filePath: 'a' },
    { id: '2', name: 'Compressor', lastModified: 2, filePath: 'b' },
  ];
  it('blank / whitespace query returns the same list', () => {
    expect(filterProjects(list, '')).toBe(list);
    expect(filterProjects(list, '   ')).toBe(list);
  });
  it('matches name and description, case-insensitively', () => {
    expect(filterProjects(list, 'COMPR').map((w) => w.id)).toEqual(['2']);
    expect(filterProjects(list, 'bearing').map((w) => w.id)).toEqual(['1']);
    expect(filterProjects(list, ' engine ').map((w) => w.id)).toEqual(['1']);
    expect(filterProjects(list, 'nope')).toEqual([]);
  });
  it('a project without a description is not matched on the word "undefined"', () => {
    expect(filterProjects(list, 'undefined')).toEqual([]);
  });
});

describe('isNewProjectShortcut', () => {
  const k = (o: Partial<KeyboardEvent>) => ({ key: 'n', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  it('accepts Ctrl+N and Cmd+N in either case', () => {
    expect(isNewProjectShortcut(k({ ctrlKey: true }))).toBe(true);
    expect(isNewProjectShortcut(k({ metaKey: true, key: 'N' }))).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isNewProjectShortcut(k({}))).toBe(false);
    expect(isNewProjectShortcut(k({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isNewProjectShortcut(k({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isNewProjectShortcut(k({ ctrlKey: true, key: 'm' }))).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('is true for input / textarea / select / contenteditable', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTypingTarget(div)).toBe(true);
  });
  it('is false for buttons, plain elements, window and null', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('newProjectShortcutLabel', () => {
  it('shows the command key on macOS and Ctrl+N elsewhere', () => {
    expect(newProjectShortcutLabel('MacIntel')).toBe('⌘N');
    expect(newProjectShortcutLabel('Win32')).toBe('Ctrl+N');
    expect(newProjectShortcutLabel(undefined)).toBe('Ctrl+N');
  });
});
