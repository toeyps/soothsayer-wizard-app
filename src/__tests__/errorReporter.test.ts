import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Module-level mutable state (nextId/installed/errors) means every test
// needs a clean module instance — resetModules + a fresh dynamic import
// gives each test its own errors=[]/nextId=1/installed=false.
async function freshModule() {
    vi.resetModules();
    return await import('../errorReporter');
}

beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue('ok');
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('errorReporter', () => {
    it('starts with no errors', async () => {
        const { getErrors } = await freshModule();
        expect(getErrors()).toEqual([]);
    });

    it('reportError adds an entry and notifies subscribers', async () => {
        const { reportError, getErrors, subscribeErrors } = await freshModule();
        const listener = vi.fn();
        subscribeErrors(listener);

        reportError('chart', new Error('boom'));

        expect(listener).toHaveBeenCalledTimes(1);
        const [entry] = getErrors();
        expect(entry).toMatchObject({ source: 'chart', message: 'boom', count: 1 });
        expect(entry.detail).toContain('Error: boom'); // stack trace
    });

    it('subscribeErrors returns an unsubscribe function', async () => {
        const { reportError, subscribeErrors } = await freshModule();
        const listener = vi.fn();
        const unsubscribe = subscribeErrors(listener);
        unsubscribe();

        reportError('chart', 'oops');
        expect(listener).not.toHaveBeenCalled();
    });

    it('dismissError removes only the matching id', async () => {
        const { reportError, getErrors, dismissError } = await freshModule();
        reportError('a', 'first');
        reportError('b', 'second');
        const [second, first] = getErrors(); // newest-first
        dismissError(first.id);
        expect(getErrors().map(e => e.id)).toEqual([second.id]);
    });

    it('dismissAllErrors clears the list', async () => {
        const { reportError, getErrors, dismissAllErrors } = await freshModule();
        reportError('a', 'first');
        reportError('b', 'second');
        dismissAllErrors();
        expect(getErrors()).toEqual([]);
    });

    it('caps the visible list at 4, keeping the most recent first', async () => {
        const { reportError, getErrors } = await freshModule();
        for (let i = 0; i < 5; i++) reportError('src', `err-${i}`);
        const messages = getErrors().map(e => e.message);
        expect(messages).toEqual(['err-4', 'err-3', 'err-2', 'err-1']);
    });

    it('coalesces a repeat of the same source+message within the dedupe window', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { reportError, getErrors } = await freshModule();

        reportError('chart', 'same error');
        vi.setSystemTime(1000);
        reportError('chart', 'same error');

        const all = getErrors();
        expect(all).toHaveLength(1);
        expect(all[0].count).toBe(2);
    });

    it('creates a new entry once the dedupe window has elapsed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { reportError, getErrors } = await freshModule();

        reportError('chart', 'same error');
        vi.setSystemTime(5001); // just past DEDUPE_WINDOW_MS
        reportError('chart', 'same error');

        expect(getErrors()).toHaveLength(2);
    });

    it('does not coalesce errors with different sources or messages', async () => {
        const { reportError, getErrors } = await freshModule();
        reportError('chart', 'boom');
        reportError('table', 'boom');
        reportError('chart', 'different');
        expect(getErrors()).toHaveLength(3);
    });

    it.each([
        ['a plain string', 'plain message', { message: 'plain message', detail: null }],
        ['a JSON-serializable object', { code: 42 }, { message: '{"code":42}', detail: null }],
    ])('normalizes %s into message/detail', async (_label, input, expected) => {
        const { reportError, getErrors } = await freshModule();
        reportError('src', input);
        expect(getErrors()[0]).toMatchObject(expected);
    });

    it('falls back to String(err) when an object cannot be JSON-stringified', async () => {
        const { reportError, getErrors } = await freshModule();
        const circular: any = {};
        circular.self = circular;
        reportError('src', circular);
        expect(getErrors()[0].message).toBe(String(circular));
        expect(getErrors()[0].detail).toBeNull();
    });

    it('appends extraDetail to the error stack, separated by a newline', async () => {
        const { reportError, getErrors } = await freshModule();
        reportError('src', new Error('boom'), 'extra context');
        expect(getErrors()[0].detail).toMatch(/boom[\s\S]*\nextra context$/);
    });

    it('fire-and-forgets log_frontend_error with the formatted message', async () => {
        const { reportError } = await freshModule();
        reportError('chart', 'boom');
        expect(mockInvoke).toHaveBeenCalledWith('log_frontend_error', {
            message: '[chart] boom',
            detail: null,
        });
    });

    it('swallows a rejected log_frontend_error call without throwing', async () => {
        mockInvoke.mockRejectedValue(new Error('disk full'));
        const { reportError } = await freshModule();
        expect(() => reportError('chart', 'boom')).not.toThrow();
        await Promise.resolve(); // flush the rejected .catch()
    });

    it('getErrorLogPath delegates to get_error_log_path', async () => {
        mockInvoke.mockResolvedValue('/logs/frontend-errors.log');
        const { getErrorLogPath } = await freshModule();
        await expect(getErrorLogPath()).resolves.toBe('/logs/frontend-errors.log');
        expect(mockInvoke).toHaveBeenCalledWith('get_error_log_path', {});
    });

    describe('initErrorReporter', () => {
        it('registers window error and unhandledrejection listeners exactly once', async () => {
            const addSpy = vi.spyOn(window, 'addEventListener');
            const { initErrorReporter } = await freshModule();

            initErrorReporter();
            initErrorReporter(); // idempotent — second call is a no-op

            const registeredTypes = addSpy.mock.calls
                .filter(([, , opts]) => opts === undefined || true) // keep all
                .map(([type]) => type)
                .filter(t => t === 'error' || t === 'unhandledrejection');
            expect(registeredTypes).toEqual(['error', 'unhandledrejection']);
        });

        it('routes a real uncaught ErrorEvent into the error list as source "uncaught"', async () => {
            const { initErrorReporter, getErrors } = await freshModule();
            initErrorReporter();

            window.dispatchEvent(new ErrorEvent('error', { error: new Error('script crashed') }));

            expect(getErrors()[0]).toMatchObject({ source: 'uncaught', message: 'script crashed' });
        });

        it('ignores resource-load error events with no ErrorEvent payload', async () => {
            const { initErrorReporter, getErrors } = await freshModule();
            initErrorReporter();

            window.dispatchEvent(new Event('error'));

            expect(getErrors()).toEqual([]);
        });

        it('routes an unhandled promise rejection into the error list as source "unhandled-promise"', async () => {
            const { initErrorReporter, getErrors } = await freshModule();
            initErrorReporter();

            const event = new Event('unhandledrejection') as any;
            event.reason = 'promise blew up';
            window.dispatchEvent(event);

            expect(getErrors()[0]).toMatchObject({ source: 'unhandled-promise', message: 'promise blew up' });
        });
    });
});
