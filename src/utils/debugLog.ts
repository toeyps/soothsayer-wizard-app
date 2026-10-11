/**
 * `console.log` that stays silent in production builds.
 *
 * Bare `console.log` calls in shipped code paths (e.g. the save path that runs
 * on every 250 ms autosave) help no user, leak workspace ids and payload
 * shapes into anyone's devtools, and bury the `console.error` calls that do
 * matter.
 *
 * **What this does and does not do.** The `import.meta.env.DEV` check lives
 * inside this function, so a production build still *calls* `debugLog` and
 * still *evaluates its arguments* — it just prints nothing. The call sites and
 * their message strings remain in the bundle; this is a silencing mechanism,
 * not dead-code elimination. Practical consequence: never put expensive work
 * in a `debugLog` argument (`debugLog('x', rows.map(expensive))` pays for the
 * map in production too). Keep arguments to values you already have.
 *
 * Development and tests are unaffected — `import.meta.env.DEV` is `true` under
 * both `vite dev` and Vitest.
 *
 * Real problems should still be loud in a shipped app: keep using
 * `console.warn` / `console.error` (or `reportError` in `errorReporter.ts`)
 * for those. The `no-console` ESLint rule enforces exactly that split.
 */
export function debugLog(...args: unknown[]): void {
    if (import.meta.env.DEV) {
        // The one sanctioned console.log in the app — everything else routes here.
        // eslint-disable-next-line no-console
        console.log(...args);
    }
}
