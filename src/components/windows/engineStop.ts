import { invoke } from '@tauri-apps/api/core';

/** What Rust answers the caller of a stopped engine run (`ENGINE_STOPPED_ERROR`). Not a failure. */
export const ENGINE_STOPPED_MESSAGE =
    'This run was stopped before it finished. Your data and settings did not cause this.';

/** The most a closing window waits for the stop to reach Rust. */
const STOP_REQUEST_WAIT_MS = 1_000;

/** Stops the engine run holding the turn. Safe when idle, never rejects. */
export async function stopRunningEngine(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<void>(resolve => { timer = setTimeout(resolve, STOP_REQUEST_WAIT_MS); });
    try {
        await Promise.race([invoke<void>('stop_running_engine'), gaveUp]);
    } catch (e) {
        console.warn('Could not stop the engine run:', e);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
