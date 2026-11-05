/** Dev-only `console.log` (silent in production). The DEV check is inside the function, so arguments are still evaluated in production: keep them cheap. Real problems use `console.warn`/`console.error` or `reportError`; the `no-console` ESLint rule enforces the split. */
export function debugLog(...args: unknown[]): void {
    if (import.meta.env.DEV) {
        // The one sanctioned console.log in the app — everything else routes here.
        // eslint-disable-next-line no-console
        console.log(...args);
    }
}
