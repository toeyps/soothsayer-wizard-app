import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as ValidationCards from '../components/windows/workbench/ValidationCards';
import {
    SlowScoringNotice,
    TestResultsCard,
    TestScoringFailedNotice,
    TestsChangedBanner,
    TrainDaysNotice,
    stamp,
} from '../components/windows/workbench/ValidationCards';
import { RECOMMENDED_TRAIN_DAYS, SLOW_TEST_SCORING_TEXT, TEST_SCORING_FAILED_TEXT, TEST_SCORING_OUTDATED_TEXT } from '../utils/trainTestValidation';
import { makeHealthPreview } from './helpers/healthPreviewFixture';
import { makeTestResult, makeValidation } from './helpers/validationFixture';
import type { HealthPreview, TestPeriodResult } from '../types/health';

afterEach(cleanup);

/*
 * Scoring periods — "just score it" (SPEC
 * docs/design/handoff/workbench-redesign/README.md §2):
 * the "Scoring results" tiles of the Health score page and the notices both
 * Workbench pages share. A scoring period is only start → end, so nothing here
 * labels a period (Normal / Known problem), shows an event or lead time, or
 * judges a result (no green / amber verdict).
 *
 * The Model fit page's "Train and scoring periods" table (`TrainTestCard`) was
 * removed on 2026-10-11 (user decision: information the user does not need) —
 * `ModelFitPage.test.tsx` asserts that page renders none of it.
 */

const withV = (kind: 'individual' | 'relationship' | 'clustering', v: Partial<ReturnType<typeof makeValidation>> = {}): HealthPreview =>
    ({ ...makeHealthPreview({ kind }), test_validation: makeValidation(v) });

/** Words that only existed for the removed label / event / verdict features. */
const REMOVED_WORDS = /Known problem|Normal\b|event|lead time|false alarm|detected|before the event|after the event/i;

describe('removed pieces', () => {
    it('the "Scored · N" pill is gone from the module (the footer sentence says "scored on N periods")', () => {
        expect(Object.keys(ValidationCards)).not.toContain('ScoredPill');
    });

    it('the verdict helpers of the old test results are gone from the module', () => {
        const exported = Object.keys(ValidationCards);
        for (const gone of ['resultTone', 'NORMAL_AMBER_PCT', 'TestedPill']) expect(exported).not.toContain(gone);
    });

    it('the Model fit page\'s "Train and scoring periods" table (TrainTestCard) is gone from the module; what the Health score page uses stays', () => {
        const exported = Object.keys(ValidationCards);
        expect(exported).not.toContain('TrainTestCard');
        for (const kept of ['TestResultsCard', 'TrainDaysNotice', 'SlowScoringNotice', 'TestsChangedBanner', 'TestScoringFailedNotice', 'testPeriodsWhere', 'stamp']) {
            expect(exported).toContain(kept);
        }
    });
});

describe('Scoring results (Health score page) — neutral tiles only', () => {
    const tile = (t: Partial<TestPeriodResult>) => {
        render(<TestResultsCard data={withV('individual', { tests: [makeTestResult(t)] })} scoreReady />);
        return screen.getByTestId('test-result-1');
    };

    it('a tile shows the two facts: % of running time below 80, and the lowest score held for 1 h with its date', () => {
        const t = tile({ pct_below_80: 4.9, lowest: 61.4, lowest_at: '2026-01-01 02:30:00' });
        expect(t.querySelector('.vt-th b')!.textContent).toBe('S1');
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('4.9% of running time below 80');
        expect(screen.getByTestId('test-result-1-lowest').textContent).toBe(`Lowest 61 (held 1 h) on ${stamp('2026-01-01 02:30:00')}.`);
        expect(stamp('2026-01-01 02:30:00')).toBe('1 Jan 2026 02:30');
        // the row's own wall clock: an explicit offset never shifts it (any PC time zone)
        expect(stamp('2026-01-01T02:30:00+07:00')).toBe('1 Jan 2026 02:30');
        expect(stamp('2026-01-01T02:30:00Z')).toBe('1 Jan 2026 02:30');
        expect(stamp(null)).toBe('—');
    });

    it.each([0, 1.2, 4.9, 5, 37.5, 100])('%s%% below 80 is never judged: same plain tile, no tone, no verdict text', pct => {
        const t = tile({ pct_below_80: pct, lowest: pct > 50 ? 12 : 90 });
        expect(t.className).toBe('vt-tile');
        expect(t.hasAttribute('data-tone')).toBe(false);
        expect(screen.getByTestId('test-result-1-big').className).toBe('vt-big');
        expect(screen.getByTestId('test-result-1-big').textContent).toBe(`${pct.toFixed(1)}% of running time below 80`);
        expect(t.textContent).not.toMatch(REMOVED_WORDS);
        expect(t.textContent).not.toMatch(/widen|check that|another model/i);
    });

    it('no lowest level (no 1 h stretch of scored rows): says so plainly, still no verdict', () => {
        const t = tile({ pct_below_80: 0, lowest: null, lowest_at: null });
        expect(screen.getByTestId('test-result-1-lowest').textContent)
            .toBe('No 1 h stretch of scored running time in this period, so there is no lowest score to show.');
        expect(t.className).toBe('vt-tile');
    });

    it('a lowest score without a date leaves the date out', () => {
        tile({ lowest: 72, lowest_at: null });
        expect(screen.getByTestId('test-result-1-lowest').textContent).toBe('Lowest 72 (held 1 h).');
    });

    it('no running rows / no scored rows are dimmed facts, not verdicts', () => {
        tile({ rows: 0 });
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('No running rows');
        expect(screen.getByTestId('test-result-1-big').className).toContain('vt-big--dim');
        cleanup();
        tile({ scored: 0, pct_below_80: null, lowest: null, lowest_at: null });
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('No scored rows');
        expect(screen.getByTestId('test-result-1-big').className).toContain('vt-big--dim');
    });

    it('until the set points are valid the card is ONE quiet line — no tiles, no "Not scored yet" tiles', () => {
        render(<TestResultsCard data={withV('individual', { tests: [makeTestResult(), makeTestResult({ index: 2 })] })} scoreReady={false} />);
        const card = screen.getByTestId('test-results');
        const line = screen.getByTestId('test-results-pending');
        expect(line.textContent).toBe('Scored once the set points are valid');
        expect(line.className).toBe('vt-quiet');
        expect(card.querySelector('.vt-tile')).toBeNull();
        expect(card.querySelector('.vt-note')).toBeNull();
        expect(card.textContent).not.toContain('Not scored yet');
    });

    it('while the health score failed to load, the quiet line says that instead of pointing at the set points', () => {
        render(<TestResultsCard data={withV('individual')} scoreReady={false} unavailable />);
        expect(screen.getByTestId('test-results-pending').textContent).toBe('Not available until the health score loads');
        expect(screen.queryByTestId('test-result-1')).toBeNull();
    });

    it('a tile that includes train time carries the quiet note with Rust\'s running days; a tile that does not has none', () => {
        tile({ train_rows: 10, train_days: 1.2 });
        expect(screen.getByTestId('test-result-overlap-1').textContent).toBe('S1 includes 1.2 d of train running time — results include rows the model was trained on.');
        cleanup();
        render(<TestResultsCard data={withV('individual', { tests: [makeTestResult({ train_rows: 40, train_days: 3.5 }), makeTestResult({ index: 2 })] })} scoreReady />);
        expect(screen.getByTestId('test-result-overlap-1').textContent).toContain('S1 includes 3.5 d of train running time');
        expect(screen.queryByTestId('test-result-overlap-2')).toBeNull();
    });

    it.each(['individual', 'relationship', 'clustering'] as const)('%s: every period gets the plain scoring swatch, and the card neither labels nor judges a period', kind => {
        render(<TestResultsCard data={withV(kind, { tests: [makeTestResult(), makeTestResult({ index: 2 })] })} scoreReady />);
        const card = screen.getByTestId('test-results');
        expect(card.textContent).not.toMatch(REMOVED_WORDS);
        expect(card.textContent).not.toMatch(/should/i);
        // the plain scoring swatch — never the train swatch, and the hatched Known-problem swatch is gone
        expect(card.querySelectorAll('.tpe-sw--te')).toHaveLength(2);
        expect(card.querySelector('.tpe-sw--tr')).toBeNull();
        expect(card.querySelector('.tpe-sw--pb')).toBeNull();
        // the model's per-period fit numbers of the removed Model fit table are not shown here either
        expect(card.querySelector('table')).toBeNull();
        expect(card.textContent).not.toMatch(/R²|RMSE|Mean shift|±3SD|3× SD ring/);
    });

    it('without the sent S-numbers (testNumbers), S numbers follow the result position, whatever index the backend sends', () => {
        render(<TestResultsCard data={withV('individual', { tests: [makeTestResult({ index: 5 }), makeTestResult({ index: 9 })] })} scoreReady />);
        expect(screen.getByTestId('test-result-1').querySelector('.vt-th b')!.textContent).toBe('S1');
        expect(screen.getByTestId('test-result-2').querySelector('.vt-th b')!.textContent).toBe('S2');
    });

    it('no scoring period: a note pointing to where it is added; nothing without test_validation', () => {
        render(<TestResultsCard data={withV('individual', { tests: [] })} scoreReady custom />);
        const empty = screen.getByTestId('test-results-empty');
        expect(empty.textContent).toContain('No scoring period.');
        expect(empty.textContent).toContain('Model settings → Training data (Custom)');
        expect(empty.textContent).toContain('Mark complete needs at least one');
        cleanup();
        render(<TestResultsCard data={makeHealthPreview({ kind: 'individual' })} scoreReady />);
        expect(screen.queryByTestId('test-results')).toBeNull();
    });

    it('the card is titled "Scoring results", says it is for reading only, and explains the two numbers', () => {
        tile({});
        const card = screen.getByTestId('test-results');
        expect(card.querySelector('.wb2-card-h b')!.textContent).toBe('Scoring results');
        expect(card.querySelector('.wb2-card-s')!.textContent).toBe('for reading only — never blocks Mark complete');
        expect(card.querySelector('.vt-note')!.textContent).toContain('lowest score held for 1 hour of running time');
        expect(card.querySelector('.vt-note')!.textContent).toContain('Rows outside the train and scoring periods get no score.');
        expect(card.textContent).not.toMatch(/Test results|test period/i);
    });
});

describe('TrainDaysNotice / TestsChangedBanner', () => {
    it(`amber below ${RECOMMENDED_TRAIN_DAYS} d of train running time, nothing at or above it or when unknown`, () => {
        render(<TrainDaysNotice days={12.4} />);
        expect(screen.getByTestId('train-days-warning').textContent).toContain('Only 12 d of train running time');
        cleanup();
        render(<TrainDaysNotice days={RECOMMENDED_TRAIN_DAYS} />);
        expect(screen.queryByTestId('train-days-warning')).toBeNull();
        cleanup();
        render(<TrainDaysNotice days={null} />);
        expect(screen.queryByTestId('train-days-warning')).toBeNull();
    });

    it('banner text for "changed" and "removed"; nothing for null', () => {
        render(<TestsChangedBanner state="changed" />);
        expect(screen.getByTestId('tests-changed-banner').textContent).toContain('Scoring periods changed');
        cleanup();
        render(<TestsChangedBanner state="removed" />);
        expect(screen.getByTestId('tests-changed-banner').textContent).toContain('Scoring periods removed');
        cleanup();
        render(<TestsChangedBanner state={null} />);
        expect(screen.queryByTestId('tests-changed-banner')).toBeNull();
    });
});

describe('S-numbers of the ORIGINAL list, scoring failed, slow-scoring hint', () => {
    // The user's list is [S1 invalid (not sent), S2 valid]: Rust only sees S2 and answers with wire index 1.
    const onlyS2 = (over: Partial<TestPeriodResult> = {}) =>
        withV('individual', { tests: [makeTestResult({ index: 1, train_rows: 40, train_days: 3, ...over })] });

    it('the result tile and its overlap note say S2, not S1', () => {
        render(<TestResultsCard data={onlyS2()} scoreReady testNumbers={[2]} />);
        expect(screen.queryByTestId('test-result-1')).toBeNull();
        const s2 = screen.getByTestId('test-result-2');
        expect(s2.querySelector('.vt-th b')!.textContent).toBe('S2');
        expect(screen.getByTestId('test-result-overlap-2').textContent).toContain('S2 includes 3 d of train running time');
    });

    it('a mapping is looked up by the wire index (not the order the results arrive in)', () => {
        render(<TestResultsCard
            data={withV('individual', { tests: [makeTestResult({ index: 2, pct_below_80: 30 }), makeTestResult({ index: 1, pct_below_80: 2 })] })}
            scoreReady
            testNumbers={[1, 3]}
        />);
        expect(screen.getByTestId('test-result-3').querySelector('.vt-th b')!.textContent).toBe('S3');
        expect(screen.getByTestId('test-result-3-big').textContent).toBe('30.0% of running time below 80');
        expect(screen.getByTestId('test-result-1').querySelector('.vt-th b')!.textContent).toBe('S1');
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('2.0% of running time below 80');
    });

    const failedIssue = { code: 'test_scoring_failed', severity: 'warning' as const, field: 'test_periods', message: 'The Relation model engine did not answer.' };
    const unscored = (): HealthPreview => ({
        ...withV('relationship', { tests: [makeTestResult({ scored: 0, pct_below_80: null, lowest: null, lowest_at: null })] }),
        validation: [failedIssue],
    });

    it('test_scoring_failed: the tiles are replaced by one amber "could not be scored — try again" notice (with Retry)', () => {
        let retried = 0;
        render(<TestResultsCard data={unscored()} scoreReady onRetry={() => { retried += 1; }} />);
        const n = screen.getByTestId('test-scoring-failed');
        expect(n.className).toBe('vt-fail');
        expect(n.textContent).toContain(TEST_SCORING_FAILED_TEXT);
        expect(TEST_SCORING_FAILED_TEXT).toBe('The scoring periods could not be scored — try again');
        expect(n.textContent).toContain('The Relation model engine did not answer.');
        expect(screen.queryByTestId('test-result-1')).toBeNull();
        expect(screen.queryByTestId('test-results-pending')).toBeNull();
        screen.getByTestId('test-scoring-retry').click();
        expect(retried).toBe(1);
    });

    it('test_scoring_failed wins over "set points not valid yet": the failure notice, not the quiet line', () => {
        render(<TestResultsCard data={unscored()} scoreReady={false} />);
        expect(screen.getByTestId('test-scoring-failed')).toBeTruthy();
        expect(screen.queryByTestId('test-results-pending')).toBeNull();
    });

    it('TestScoringFailedNotice on its own: no "Try again" button without a handler; with one, the button calls it', () => {
        render(<TestScoringFailedNotice issue={failedIssue} />);
        expect(screen.getByTestId('test-scoring-failed').textContent).toContain(TEST_SCORING_FAILED_TEXT);
        expect(screen.queryByTestId('test-scoring-retry')).toBeNull();
        cleanup();
        let retried = 0;
        render(<TestScoringFailedNotice issue={failedIssue} onRetry={() => { retried += 1; }} />);
        screen.getByTestId('test-scoring-retry').click();
        expect(retried).toBe(1);
    });

    it('test_scoring_outdated: same amber notice in place of the tiles, but NO "Try again" (retrying cannot fix an out-of-date engine)', () => {
        const outdated = { code: 'test_scoring_outdated', severity: 'warning' as const, field: 'test_periods', message: 'The Relation model engine in this build is out of date - reinstall or update the app.' };
        render(<TestResultsCard data={{ ...unscored(), validation: [outdated] }} scoreReady onRetry={() => {}} />);
        const n = screen.getByTestId('test-scoring-failed');
        expect(n.textContent).toContain(TEST_SCORING_OUTDATED_TEXT);
        expect(n.textContent).not.toContain('try again');
        expect(n.textContent).toContain('out of date');
        expect(screen.queryByTestId('test-scoring-retry')).toBeNull();
        expect(screen.queryByTestId('test-result-1')).toBeNull();
    });

    it('test_scoring_too_large: Rust\'s reason (too many rows) under a headline WITHOUT "try again", and no Try again button (retrying the same rows fails the same way)', () => {
        const tooLarge = { code: 'test_scoring_too_large', severity: 'warning' as const, field: 'test_periods', message: 'These scoring periods have too many rows to score in memory - shorten them or remove one.' };
        render(<TestResultsCard data={{ ...unscored(), validation: [tooLarge] }} scoreReady onRetry={() => {}} />);
        const n = screen.getByTestId('test-scoring-failed');
        expect(n.textContent).toContain('too many rows to score in memory');
        expect(n.textContent).toContain(TEST_SCORING_OUTDATED_TEXT);
        expect(n.textContent).not.toContain('— try again');
        expect(screen.queryByTestId('test-scoring-retry')).toBeNull();
    });

    it('SlowScoringNotice: the "up to ~15 s" hint only when asked for', () => {
        render(<SlowScoringNotice show />);
        expect(screen.getByTestId('slow-test-scoring').textContent).toBe(SLOW_TEST_SCORING_TEXT);
        cleanup();
        render(<SlowScoringNotice show={false} />);
        expect(screen.queryByTestId('slow-test-scoring')).toBeNull();
    });
});
