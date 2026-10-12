import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as ValidationCards from '../components/windows/workbench/ValidationCards';
import {
    SlowScoringNotice,
    TestScoringFailedNotice,
    TestsChangedBanner,
    TrainDaysNotice,
} from '../components/windows/workbench/ValidationCards';
import { RECOMMENDED_TRAIN_DAYS, SLOW_TEST_SCORING_TEXT, TEST_SCORING_FAILED_TEXT, TEST_SCORING_OUTDATED_TEXT } from '../utils/trainTestValidation';

afterEach(cleanup);

/*
 * The notices both Workbench pages share (train running time, scoring periods
 * changed, slow scoring, "the health score could not be calculated").
 *
 * The Health score page's "Scoring results" card (`TestResultsCard` — one tile
 * per scoring period) was removed on 2026-10-12 (user decision: not used), after
 * the Model fit page's "Train and scoring periods" table (`TrainTestCard`,
 * 2026-10-11). `HealthScorePage.test.tsx` asserts the page renders neither.
 */

describe('removed pieces', () => {
    it('the "Scored · N" pill is gone from the module (the footer sentence says "scored on N periods")', () => {
        expect(Object.keys(ValidationCards)).not.toContain('ScoredPill');
    });

    it('the verdict helpers of the old test results are gone from the module', () => {
        const exported = Object.keys(ValidationCards);
        for (const gone of ['resultTone', 'NORMAL_AMBER_PCT', 'TestedPill']) expect(exported).not.toContain(gone);
    });

    it('the "held for 1 h" window is gone: every point already is a 1-hour average (no DROP_SUSTAIN_HOURS)', () => {
        expect(Object.keys(ValidationCards)).not.toContain('DROP_SUSTAIN_HOURS');
    });

    it('the Model fit page\'s "Train and scoring periods" table (TrainTestCard) is gone from the module; what the Health score page uses stays', () => {
        const exported = Object.keys(ValidationCards);
        expect(exported).not.toContain('TrainTestCard');
        for (const kept of ['TrainDaysNotice', 'SlowScoringNotice', 'TestsChangedBanner', 'TestScoringFailedNotice']) {
            expect(exported).toContain(kept);
        }
    });

    it('the Health score page\'s "Scoring results" card (TestResultsCard) and its helpers are gone from the module (user decision 2026-10-12: not used)', () => {
        const exported = Object.keys(ValidationCards);
        for (const gone of ['TestResultsCard', 'testPeriodsWhere', 'stamp']) expect(exported).not.toContain(gone);
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

describe('scoring failed, slow-scoring hint', () => {
    const failedIssue = { code: 'test_scoring_failed', severity: 'warning' as const, field: 'test_periods', message: 'The Relation model engine did not answer.' };

    it('test_scoring_failed: one amber "The health score could not be calculated — try again" notice (with Retry)', () => {
        let retried = 0;
        render(<TestScoringFailedNotice issue={failedIssue} onRetry={() => { retried += 1; }} />);
        const n = screen.getByTestId('test-scoring-failed');
        expect(n.className).toBe('vt-fail');
        expect(n.textContent).toContain(TEST_SCORING_FAILED_TEXT);
        expect(TEST_SCORING_FAILED_TEXT).toBe('The health score could not be calculated — try again');
        expect(n.querySelector('b')!.textContent).toBe('The health score could not be calculated — try again');
        expect(n.textContent).not.toMatch(/could not be scored/);
        expect(n.textContent).toContain('The Relation model engine did not answer.');
        screen.getByTestId('test-scoring-retry').click();
        expect(retried).toBe(1);
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

    it('test_scoring_outdated: the same amber notice, but NO "Try again" (retrying cannot fix an out-of-date engine)', () => {
        const outdated = { code: 'test_scoring_outdated', severity: 'warning' as const, field: 'test_periods', message: 'The Relation model engine in this build is out of date - reinstall or update the app.' };
        render(<TestScoringFailedNotice issue={outdated} onRetry={() => {}} />);
        const n = screen.getByTestId('test-scoring-failed');
        expect(n.textContent).toContain(TEST_SCORING_OUTDATED_TEXT);
        expect(n.querySelector('b')!.textContent).toBe('The health score could not be calculated');
        expect(n.textContent).not.toContain('try again');
        expect(n.textContent).toContain('out of date');
        expect(screen.queryByTestId('test-scoring-retry')).toBeNull();
    });

    it('test_scoring_too_large: Rust\'s reason (too many rows) under a headline WITHOUT "try again", and no Try again button (retrying the same rows fails the same way)', () => {
        const tooLarge = { code: 'test_scoring_too_large', severity: 'warning' as const, field: 'test_periods', message: 'These scoring periods have too many rows to score in memory - shorten them or remove one.' };
        render(<TestScoringFailedNotice issue={tooLarge} onRetry={() => {}} />);
        const n = screen.getByTestId('test-scoring-failed');
        expect(n.textContent).toContain('too many rows to score in memory');
        expect(n.textContent).toContain(TEST_SCORING_OUTDATED_TEXT);
        expect(n.textContent).not.toContain('— try again');
        expect(screen.queryByTestId('test-scoring-retry')).toBeNull();
    });

    it('SlowScoringNotice: the "up to ~15 s" hint only when asked for', () => {
        render(<SlowScoringNotice show />);
        expect(screen.getByTestId('slow-test-scoring').textContent).toBe(SLOW_TEST_SCORING_TEXT);
        expect(screen.getByTestId('slow-test-scoring').textContent).toBe('Calculating the health score with the Relation model — this can take up to ~15 s.');
        cleanup();
        render(<SlowScoringNotice show={false} />);
        expect(screen.queryByTestId('slow-test-scoring')).toBeNull();
    });
});
