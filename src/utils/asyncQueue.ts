/**
 * A tiny serial async queue (a mutex with a line): tasks run ONE AT A TIME, in
 * the order they were submitted, each against whatever state the previous one
 * left behind.
 *
 * Used by the Add Special Sensor window to serialize every special-sensor
 * mutation (create, edit/rename, delete-commit). Each of those is a multi-step
 * sequence of backend calls that reads the session, writes a column, and then
 * tells another window -- run two at once and one reads (or overwrites) what
 * the other is half-way through writing (a create reading an edit's old values,
 * a rename overwriting a freshly created column, a delete dropping a column an
 * in-flight edit is about to re-create).
 *
 * Guarantees:
 *  - FIFO: a task never starts before every earlier task has settled.
 *  - A failing (rejecting or throwing) task never wedges the queue; its
 *    rejection goes to ITS caller only, the next task still runs.
 *  - When the queue is idle a task starts synchronously (no extra microtask
 *    hop), so an uncontended call behaves exactly like calling it directly.
 *  - Do NOT call `run()` from inside a running task and await it: the inner
 *    task could only start after the outer one finishes, which is awaiting it
 *    (a deadlock). Tasks should call plain functions, not re-enter the queue.
 */
export interface SerialQueue {
    /** Queue `task`; resolves/rejects with the task's own outcome. */
    run<T>(task: () => Promise<T>): Promise<T>;
    /** Resolves once everything queued so far (and anything those tasks queue
     *  meanwhile) has settled. */
    idle(): Promise<void>;
    /** Tasks queued or running right now. */
    readonly size: number;
    /** Called with the new size every time it changes. Returns an unsubscribe. */
    subscribe(listener: (size: number) => void): () => void;
}

export function createSerialQueue(): SerialQueue {
    let tail: Promise<void> = Promise.resolve();
    let size = 0;
    const listeners = new Set<(size: number) => void>();
    const notify = () => { for (const l of [...listeners]) l(size); };

    const run = <T,>(task: () => Promise<T>): Promise<T> => {
        const startNow = size === 0;
        size += 1;
        notify();
        const exec = (): Promise<T> => {
            try {
                return Promise.resolve(task());
            } catch (err) {
                return Promise.reject(err);
            }
        };
        const result = startNow ? exec() : tail.then(exec);
        tail = result.then(() => undefined, () => undefined).then(() => {
            size -= 1;
            notify();
        });
        return result;
    };

    return {
        run,
        async idle() {
            let seen: Promise<void>;
            do {
                seen = tail;
                await seen;
            } while (seen !== tail);
        },
        get size() { return size; },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
