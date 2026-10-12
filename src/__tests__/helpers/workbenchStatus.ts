/**
 * Reading a model's status and the notice line of the Build Model Workbench in tests.
 *
 * Workbench detail pages v2 (phase 4b) removed the footer bar and its status pill
 * ("Complete" / "Trained" / "Incomplete"). The status is said in words on the kind
 * tab (`tab-words-<modelId>`), and ONE notice line (`wb-notice`) appears at the bottom
 * of the pane only while there is something to fix or wait for.
 *
 * `openTabStatus` reads the OPEN kind tab's words and names the same three states the
 * pill used to, so a test that asked "is this model Complete / Trained / Incomplete?"
 * still asks exactly that — of the words the user now sees.
 */

export type WorkbenchStatus = 'Complete' | 'Trained' | 'Incomplete';

/** "Complete …" -> Complete · "Trained …", "Set points needed …", "Fix set point …" (a
 *  trained, up-to-date model that is not Complete yet) -> Trained · anything else
 *  ("Not trained yet", "Re-train needed", "Training failed", "Fit no longer in memory",
 *  a gate badge such as "Needs condition") -> Incomplete. */
export const statusFromTabWords = (words: string): WorkbenchStatus =>
    /^Complete( ·|$)/.test(words) ? 'Complete'
        : /^(Trained|Set points needed|Fix set point)( ·|$)/.test(words) ? 'Trained'
        : 'Incomplete';

/** The status words on the kind tab that is open, exactly as shown. */
export const openTabWords = (root: ParentNode = document): string => {
    const tab = root.querySelector('[role="tab"][aria-selected="true"]');
    const words = tab?.querySelector('[data-testid^="tab-words-"]')?.textContent;
    if (words === null || words === undefined) throw new Error('no open kind tab with status words');
    return words;
};

/** The status of the model whose kind tab is open (see `statusFromTabWords`). */
export const openTabStatus = (root: ParentNode = document): WorkbenchStatus => statusFromTabWords(openTabWords(root));

/** The notice line's element, or null when there is none (nothing to fix or wait for). */
export const noticeEl = (root: ParentNode = document): HTMLElement | null => root.querySelector<HTMLElement>('[data-testid="wb-notice"]');

/** The notice line's sentence, or null when there is no notice line. */
export const noticeSentence = (root: ParentNode = document): string | null =>
    noticeEl(root)?.querySelector('.wbx-reason')?.textContent ?? null;

/** Which button of the detail pane is the filled one ("save" | "train" | "next" | "mark" | "none"). */
export const primaryAction = (root: ParentNode = document): string | null =>
    root.querySelector('[data-testid="wb-actions"]')?.getAttribute('data-primary') ?? null;
