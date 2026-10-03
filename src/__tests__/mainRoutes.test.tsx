import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';

// `main.tsx` renders at import time and picks its root component from the `?window=`
// URL param. Each window route is mounted here for real (stand-ins for the three
// components), including the lazy chunks of the two sub-window routes.
vi.mock('../App', () => ({ default: () => <div data-testid="route-main" /> }));
vi.mock('../components/windows/AddSensorWindow', () => ({ default: () => <div data-testid="route-add-sensor" /> }));
vi.mock('../components/windows/BuildModelWindow', () => ({ default: () => <div data-testid="route-build-model" /> }));
vi.mock('../App.css', () => ({}));

async function mountRoute(search: string): Promise<void> {
    window.history.pushState({}, '', `/${search}`);
    vi.resetModules();
    await act(async () => {
        await import('../main');
    });
    // Let the lazy chunk resolve and Suspense swap the fallback for the route.
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
}

const present = (id: string): boolean => document.querySelector(`[data-testid="${id}"]`) !== null;

describe('main.tsx window routes (?window= param)', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="root"></div>';
    });
    afterEach(() => {
        document.body.innerHTML = '';
        window.history.pushState({}, '', '/');
    });

    it('no param -> the main App', async () => {
        await mountRoute('');
        expect(present('route-main')).toBe(true);
        expect(present('route-build-model')).toBe(false);
        expect(present('route-add-sensor')).toBe(false);
    });

    it('?window=build-model -> BuildModelWindow (lazy)', async () => {
        await mountRoute('?window=build-model');
        expect(present('route-build-model')).toBe(true);
        expect(present('route-main')).toBe(false);
    });

    it('?window=add-sensor -> AddSensorWindow (lazy)', async () => {
        await mountRoute('?window=add-sensor');
        expect(present('route-add-sensor')).toBe(true);
        expect(present('route-main')).toBe(false);
    });

    it('an unknown window label falls back to the main App', async () => {
        await mountRoute('?window=nope');
        expect(present('route-main')).toBe(true);
    });
});
