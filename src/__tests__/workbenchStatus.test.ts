// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
    noticeEl, noticeSentence, openTabStatus, openTabWords, primaryAction, statusFromTabWords, type WorkbenchStatus,
} from './helpers/workbenchStatus';
import { FIT_GONE_WORDS } from '../components/windows/workbench/WorkbenchShellParts';
import { NO_MODEL_DATA_WORDS, NO_TRAIN_DATA_SHORT } from '../utils/runningCondition';

/*
 * `helpers/workbenchStatus.ts` is what ~180 assertions of the Workbench integration
 * tests read a model's status through, since "Workbench detail pages v2" removed the
 * footer pill ("Complete" / "Trained" / "Incomplete") and put the status in WORDS on the
 * kind tab (`BuildModelWindow.tabDotOf`). The helper had no test of its own: if it read
 * one of the tab's strings as a better status than the words say, every test that asks
 * "is this model Complete?" would pass on a model that is not.
 *
 * This file pins the helper against EVERY string `tabDotOf` can put on a tab — each base
 * word, with each suffix and every combination of suffixes — and the DOM readers against
 * the markup the window renders (`role="tab"` + `tab-words-<id>`, `wb-notice`, `wb-actions`).
 */

// ── every status word the kind tab can show (BuildModelWindow: TAB_WORDS, the set-point
//    flag, the failed-run words, the fit-gone words, the gate badges) ─────────────────────
const COMPLETE_WORDS = [
    'Complete',
    `Complete · ${FIT_GONE_WORDS}`,
    "Complete · Couldn't load the model",
    'Complete · Training failed',
];
const TRAINED_WORDS = ['Trained', 'Set points needed', 'Fix set point'];
const INCOMPLETE_WORDS = [
    'Not trained yet',
    'Re-train needed',
    'Needs fixing',
    'Training failed',
    FIT_GONE_WORDS,
    // gate badges
    'Needs condition',
    'Needs category',
    'Needs train period',
    'Fix periods',
    NO_TRAIN_DATA_SHORT,
    'No rows to train on',
];

// ── the suffixes `tabDotOf` appends, in the order it appends them ───────────────────────
const NO_DATA = ` · ${NO_MODEL_DATA_WORDS}`;
const OUT_OF_DATE = ' · files out of date';
const UNSAVED = ' · unsaved changes';
/** Every combination of the three suffixes, kept in the app's order (2^3 = 8, '' included). */
const SUFFIXES = [0, 1, 2, 3, 4, 5, 6, 7].map(bits => `${bits & 1 ? NO_DATA : ''}${bits & 2 ? OUT_OF_DATE : ''}${bits & 4 ? UNSAVED : ''}`);

const RANK: Record<WorkbenchStatus, number> = { Incomplete: 0, Trained: 1, Complete: 2 };

describe('statusFromTabWords — the three states the footer pill used to name, read from the kind-tab words', () => {
    it('the suffix list is the app\'s: "no data in the loaded file", "files out of date", "unsaved changes"', () => {
        expect(NO_MODEL_DATA_WORDS).toBe('no data in the loaded file');
        expect(FIT_GONE_WORDS).toBe('Fit no longer in memory');
        expect(new Set(SUFFIXES).size).toBe(8);
        expect(SUFFIXES).toContain(' · no data in the loaded file · files out of date · unsaved changes');
    });

    it.each(COMPLETE_WORDS)('"%s" (alone and with every suffix combination) is Complete', words => {
        for (const s of SUFFIXES) expect(statusFromTabWords(words + s), words + s).toBe('Complete');
    });

    it.each(TRAINED_WORDS)('"%s" (alone and with every suffix combination) is Trained — trained and up to date, not Complete', words => {
        for (const s of SUFFIXES) expect(statusFromTabWords(words + s), words + s).toBe('Trained');
    });

    it.each(INCOMPLETE_WORDS)('"%s" (alone and with every suffix combination) is Incomplete', words => {
        for (const s of SUFFIXES) expect(statusFromTabWords(words + s), words + s).toBe('Incomplete');
    });

    it('a suffix never changes the status: it is the status of the base words, for every word and every combination', () => {
        for (const words of [...COMPLETE_WORDS, ...TRAINED_WORDS, ...INCOMPLETE_WORDS]) {
            const base = statusFromTabWords(words);
            for (const s of SUFFIXES) expect(statusFromTabWords(words + s), words + s).toBe(base);
        }
    });

    it('nothing reports a BETTER status than the words say: only a string that STARTS with the word, as a whole word, counts', () => {
        // "Complete" / "Trained" somewhere else in the words is not the status
        const notBetter: [string, WorkbenchStatus][] = [
            ['Not trained yet', 'Incomplete'],                       // lower-case "trained" inside
            ['Re-train needed', 'Incomplete'],
            ['Training failed', 'Incomplete'],                       // starts with "Train", not "Trained"
            ['Training failed · Complete', 'Incomplete'],            // a later "Complete" does not count
            ['Needs condition · Trained', 'Incomplete'],
            ['Fit no longer in memory · Complete', 'Incomplete'],
            ['Incomplete', 'Incomplete'],                            // contains "complete"
            ['Completed', 'Incomplete'],                             // not the whole word
            ['Complete-ish', 'Incomplete'],
            ['Trained!', 'Incomplete'],
            ['Trainedness', 'Incomplete'],
            ['Set points needed soon', 'Incomplete'],
            ['Fix set points', 'Incomplete'],
            [' Complete', 'Incomplete'],                             // not at the start
            ['complete', 'Incomplete'],                              // the app writes "Complete"
            ['trained', 'Incomplete'],
            ['', 'Incomplete'],
            ['Legacy · all data', 'Incomplete'],                     // the legacy badge never reads as Complete
        ];
        for (const [words, want] of notBetter) expect(statusFromTabWords(words), JSON.stringify(words)).toBe(want);
    });

    it('a status is never upgraded by what follows it: "Trained · …" can not become Complete, "Complete · …" stays Complete', () => {
        for (const tail of ['Complete', 'files out of date', 'Fit no longer in memory', 'unsaved changes']) {
            expect(RANK[statusFromTabWords(`Trained · ${tail}`)], `Trained · ${tail}`).toBe(RANK.Trained);
            expect(RANK[statusFromTabWords(`Set points needed · ${tail}`)]).toBe(RANK.Trained);
            expect(RANK[statusFromTabWords(`Fix set point · ${tail}`)]).toBe(RANK.Trained);
            expect(RANK[statusFromTabWords(`Not trained yet · ${tail}`)]).toBe(RANK.Incomplete);
            expect(RANK[statusFromTabWords(`Complete · ${tail}`)]).toBe(RANK.Complete);
        }
    });

    it('"Fix set point" and "Set points needed" are the SAME status as "Trained" (the model is trained; only its set points wait)', () => {
        expect(new Set(TRAINED_WORDS.map(statusFromTabWords))).toEqual(new Set(['Trained']));
    });
});

// ── the DOM readers, against the markup of the detail pane ──────────────────────────────

/** The kind tabs as `BuildModelWindow` renders them: a `role="tab"` button with the dot and
 *  the words (`tab-words-<modelId>`) inside. */
function pane(tabs: { id: string; words: string; open?: boolean }[], extra = ''): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = `
        <div role="tablist">
            ${tabs.map(t => `
                <button role="tab" aria-selected="${t.open ? 'true' : 'false'}">
                    <span class="f4-tab-l">Kind</span>
                    <span class="wb3-tab-state" aria-hidden="true">
                        <span data-testid="tab-status-${t.id}" title="${t.words}"></span>
                        <span data-testid="tab-words-${t.id}">${t.words}</span>
                    </span>
                </button>`).join('')}
        </div>
        ${extra}`;
    return el;
}

describe('openTabWords / openTabStatus — the OPEN kind tab only', () => {
    it('reads the words of the selected tab exactly as shown, never those of another tab', () => {
        const el = pane([
            { id: 'i1', words: 'Complete' },
            { id: 'r1', words: 'Fix set point · unsaved changes', open: true },
            { id: 'c1', words: 'Not trained yet' },
        ]);
        expect(openTabWords(el)).toBe('Fix set point · unsaved changes');
        expect(openTabStatus(el)).toBe('Trained');
    });

    it('follows the selection: the same pane with another tab open gives that tab\'s status', () => {
        const tabs = [{ id: 'i1', words: 'Complete · files out of date' }, { id: 'c1', words: 'Re-train needed' }];
        expect(openTabStatus(pane([{ ...tabs[0], open: true }, tabs[1]]))).toBe('Complete');
        expect(openTabStatus(pane([tabs[0], { ...tabs[1], open: true }]))).toBe('Incomplete');
    });

    it('throws when no kind tab is open, or the open tab has no status words — a missing status never reads as a status', () => {
        expect(() => openTabWords(pane([{ id: 'i1', words: 'Complete' }]))).toThrow(/no open kind tab/);
        const noWords = document.createElement('div');
        noWords.innerHTML = '<button role="tab" aria-selected="true"><span>Individual</span></button>';
        expect(() => openTabStatus(noWords)).toThrow(/no open kind tab/);
        expect(() => openTabStatus(document.createElement('div'))).toThrow(/no open kind tab/);
    });

    it('an open tab whose words are empty is Incomplete (never Trained or Complete)', () => {
        expect(openTabStatus(pane([{ id: 'i1', words: '', open: true }]))).toBe('Incomplete');
    });
});

describe('noticeEl / noticeSentence / primaryAction', () => {
    const notice = (tone: string, sentence: string) =>
        `<div data-testid="wb-notice" role="status" data-tone="${tone}"><span class="wbx-reason" data-tone="${tone}">${sentence}</span></div>`;

    it('no notice line = null for both (nothing to fix or wait for)', () => {
        const el = pane([{ id: 'i1', words: 'Trained', open: true }]);
        expect(noticeEl(el)).toBeNull();
        expect(noticeSentence(el)).toBeNull();
    });

    it('the sentence is the notice line\'s `.wbx-reason` text; the element carries the tone', () => {
        const el = pane([{ id: 'i1', words: 'Fix set point', open: true }], notice('bad', '1 set point not valid — fix before marking complete'));
        expect(noticeEl(el)!.getAttribute('data-tone')).toBe('bad');
        expect(noticeSentence(el)).toBe('1 set point not valid — fix before marking complete');
    });

    it('a notice line without a sentence gives null, not an empty string', () => {
        const el = pane([], '<div data-testid="wb-notice"></div>');
        expect(noticeEl(el)).not.toBeNull();
        expect(noticeSentence(el)).toBeNull();
    });

    it('primaryAction is `data-primary` of the header\'s state buttons, null when the pane has none', () => {
        expect(primaryAction(pane([], '<div data-testid="wb-actions" data-primary="mark"></div>'))).toBe('mark');
        expect(primaryAction(pane([], '<div data-testid="wb-actions" data-primary="none"></div>'))).toBe('none');
        expect(primaryAction(pane([]))).toBeNull();
    });
});
