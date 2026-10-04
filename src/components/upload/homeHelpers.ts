/**
 * Pure helpers for the Import page's "Get started" (step 0) screen. Kept free of
 * React / Tauri so they can be unit-tested directly (homeHelpers.test.ts).
 */

import type { WorkspaceMetadata } from '../../types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Relative "last modified" label: "just now", "5 min ago", "2 h ago", "3 d ago";
 *  older than 30 days falls back to a calendar date ("5 Mar 2026"). A missing /
 *  non-finite timestamp yields "" (nothing is invented); a timestamp slightly in
 *  the future (clock skew) reads "just now". */
export function formatRelativeTime(timestamp: number | undefined | null, now: number = Date.now()): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '';
  const diff = now - timestamp;
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff <= 30 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return new Date(timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Up to two initials from the project name ("GEG-4 Bearing study" -> "GB"); "P" when the name has no letters/digits. */
export function projectInitials(name: string): string {
  const words = name.trim().split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0]).join('').toUpperCase();
  return letters || 'P';
}

/** Hues (oklch) for the project icons; picked deterministically per project so a
 *  card keeps its colour across sessions and re-renders. */
const ICON_HUES = [235, 300, 160, 60, 20, 200] as const;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic icon colour for a project, from its id (or name when no id). */
export function projectColor(seed: string): string {
  const hue = ICON_HUES[hashString(seed) % ICON_HUES.length];
  return `oklch(0.55 0.12 ${hue})`;
}

/** Case-insensitive match on name + description. A blank query returns everything. */
export function filterProjects(list: WorkspaceMetadata[], query: string): WorkspaceMetadata[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((w) => `${w.name} ${w.description ?? ''}`.toLowerCase().includes(q));
}

/** True for Ctrl+N / Cmd+N with no other modifier (the "New project" shortcut). */
export function isNewProjectShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && typeof e.key === 'string' && e.key.toLowerCase() === 'n';
}

/** True when the key event came from somewhere the user is typing text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/** Label for the shortcut hint next to "New project". */
export function newProjectShortcutLabel(platform: string | undefined = typeof navigator !== 'undefined' ? navigator.platform : undefined): string {
  return platform && /mac/i.test(platform) ? '⌘N' : 'Ctrl+N';
}
