/** Serial async queue: tasks run FIFO, one at a time. Serialises Add Special Sensor mutations (create, edit/rename, delete), which corrupt each other if interleaved. A failing task never wedges the queue; an idle queue starts a task synchronously. Never await run() from inside a running task: deadlock. */
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
