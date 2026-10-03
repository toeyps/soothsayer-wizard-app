import { describe, it, expect, vi } from 'vitest';
import { createSerialQueue } from '../utils/asyncQueue';

/** A promise whose resolution the test controls. */
function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

describe('createSerialQueue', () => {
    it('runs tasks one at a time, in the order they were queued, each after the previous one has settled', async () => {
        const q = createSerialQueue();
        const log: string[] = [];
        const gateA = deferred();
        const gateB = deferred();
        const a = q.run(async () => { log.push('a:start'); await gateA.promise; log.push('a:end'); return 'A'; });
        const b = q.run(async () => { log.push('b:start'); await gateB.promise; log.push('b:end'); return 'B'; });
        const c = q.run(async () => { log.push('c:start'); log.push('c:end'); return 'C'; });
        await tick();
        expect(log).toEqual(['a:start']); // b and c wait
        gateB.resolve(); // releasing a LATER task's gate does not let it jump the line
        await tick();
        expect(log).toEqual(['a:start']);
        gateA.resolve();
        expect(await Promise.all([a, b, c])).toEqual(['A', 'B', 'C']);
        expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    });

    it('starts a task SYNCHRONOUSLY when the queue is idle (an uncontended call behaves like a direct call)', () => {
        const q = createSerialQueue();
        const started = vi.fn();
        void q.run(async () => { started(); });
        expect(started).toHaveBeenCalledTimes(1);
    });

    it('a rejecting task does not wedge the queue: its caller gets the rejection, the next task still runs', async () => {
        const q = createSerialQueue();
        const bad = q.run(async () => { throw new Error('boom'); });
        const next = q.run(async () => 'still runs');
        await expect(bad).rejects.toThrow('boom');
        await expect(next).resolves.toBe('still runs');
        // ...and it is usable afterwards, too.
        await expect(q.run(async () => 42)).resolves.toBe(42);
        expect(q.size).toBe(0);
    });

    it('a task that throws synchronously (not returning a rejected promise) does not wedge it either', async () => {
        const q = createSerialQueue();
        const bad = q.run((() => { throw new Error('sync boom'); }) as unknown as () => Promise<void>);
        const next = q.run(async () => 'ok');
        await expect(bad).rejects.toThrow('sync boom');
        await expect(next).resolves.toBe('ok');
    });

    it('a failure in the middle does not skip or reorder what is queued behind it', async () => {
        const q = createSerialQueue();
        const log: number[] = [];
        const results = await Promise.allSettled([
            q.run(async () => { log.push(1); }),
            q.run(async () => { log.push(2); throw new Error('two'); }),
            q.run(async () => { log.push(3); }),
        ]);
        expect(log).toEqual([1, 2, 3]);
        expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });

    it('size counts queued + running tasks, and subscribers hear every change (so a UI can show a busy state)', async () => {
        const q = createSerialQueue();
        const sizes: number[] = [];
        const off = q.subscribe(n => sizes.push(n));
        const gate = deferred();
        const a = q.run(async () => { await gate.promise; });
        const b = q.run(async () => {});
        expect(q.size).toBe(2);
        gate.resolve();
        await Promise.all([a, b]);
        await tick();
        expect(q.size).toBe(0);
        expect(sizes).toEqual([1, 2, 1, 0]);
        off();
        await q.run(async () => {});
        expect(sizes).toEqual([1, 2, 1, 0]); // unsubscribed
    });

    it('idle() resolves only after everything queued so far -- including tasks queued while waiting -- has settled', async () => {
        const q = createSerialQueue();
        const gate = deferred();
        const done: string[] = [];
        void q.run(async () => { await gate.promise; done.push('first'); });
        const idle = q.idle();
        void q.run(async () => { done.push('second'); });
        let idleResolved = false;
        void idle.then(() => { idleResolved = true; });
        await tick();
        expect(idleResolved).toBe(false);
        gate.resolve();
        await idle;
        expect(done).toEqual(['first', 'second']);
    });

    it('idle() on an empty queue resolves at once', async () => {
        await expect(createSerialQueue().idle()).resolves.toBeUndefined();
    });

    it('the close-flush shape: queue the pending commit, then idle() -- the window closes only after both an in-flight edit and the commit', async () => {
        const q = createSerialQueue();
        const order: string[] = [];
        const edit = deferred();
        void q.run(async () => { await edit.promise; order.push('edit'); });
        void q.run(async () => { order.push('commit'); });
        const closing = q.idle().then(() => order.push('close'));
        edit.resolve();
        await closing;
        expect(order).toEqual(['edit', 'commit', 'close']);
    });
});
