import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import {
    NORMAL_AMBER_PCT,
    SlowScoringNotice,
    TestResultsCard,
    TestedPill,
    TestsChangedBanner,
    TrainDaysNotice,
    TrainTestCard,
    resultTone,
} from '../components/windows/workbench/ValidationCards';
import { RECOMMENDED_TRAIN_DAYS, SLOW_TEST_SCORING_TEXT, TEST_SCORING_FAILED_TEXT } from '../utils/trainTestValidation';
import { makeHealthPreview } from './helpers/healthPreviewFixture';
import { makeTestResult, makeValidation } from './helpers/validationFixture';
import type { HealthPreview, TestPeriodResult } from '../types/health';

afterEach(cleanup);

/*
 * Train/Test validation (SPEC FINAL 2026-10-07): the "Train vs test" card of the
 * Model fit page and the "Test results" tiles of the Health score page, exactly
 * per the SPEC "Metrics" section and rule 10 (green / amber only, never red).
 */

const withV = (kind: 'individual' | 'relationship' | 'clustering', v: Partial<ReturnType<typeof makeValidation>> = {}): HealthPreview =>
    ({ ...makeHealthPreview({ kind }), test_validation: makeValidation(v) });

describe('TestedPill', () => {
    it('reads "Tested · N", neutral grey', () => {
        render(<TestedPill n={2} />);
        const p = screen.getByTestId('tested-pill');
        expect(p.textContent).toBe('Tested · 2');
        expect(p.className).toContain('f4-pill--grey');
    });
});

describe('TrainTestCard (Model fit page)', () => {
    it('nothing at all without test_validation (no test periods were sent)', () => {
        render(<TrainTestCard data={makeHealthPreview({ kind: 'individual' })} unit="bar" />);
        expect(screen.queryByTestId('train-test-card')).toBeNull();
    });

    it('no test period: a dashed note saying where to add one (Workspace vs Custom)', () => {
        render(<TrainTestCard data={withV('individual', { tests: [] })} unit="bar" />);
        expect(screen.getByTestId('train-test-empty').textContent).toContain('Running condition → Edit');
        cleanup();
        render(<TrainTestCard data={withV('individual', { tests: [] })} unit="bar" custom />);
        expect(screen.getByTestId('train-test-empty').textContent).toContain('Model settings → Training data (Custom)');
    });

    it('Relation model: R², RMSE, residual mean · SD and the test/train RMSE ratio for Train and each Normal test', () => {
        render(<TrainTestCard data={withV('relationship', { tests: [makeTestResult({ r2: 0.8, rmse: 3, residual_mean: 0.5, residual_sd: 2.9 })] })} unit="bar" />);
        const head = screen.getByTestId('train-test-card').querySelectorAll('th');
        expect([...head].map(h => h.textContent)).toEqual(['Scope', 'R²', 'RMSE', 'Residual mean · SD', 'RMSE test / train']);
        const train = screen.getByTestId('train-test-row-train');
        expect(train.textContent).toContain('Train');
        expect(train.textContent).toContain('40.2 d · 1,200 rows');
        expect(train.textContent).toContain('0.910');
        expect(train.textContent).toContain('2.00 bar');
        const t1 = screen.getByTestId('train-test-row-1');
        expect(t1.textContent).toContain('T1 Normal');
        expect(within(t1).getByTestId('vt-rmse-ratio').textContent).toBe('1.50');
    });

    it('Relation model, Known problem: only the residual shift and "× train RMSE"', () => {
        render(<TrainTestCard data={withV('relationship', { tests: [makeTestResult({ label: 'problem', r2: 0.1, rmse: 9, residual_mean: -5 })] })} unit="bar" />);
        const t1 = screen.getByTestId('train-test-row-1');
        expect(t1.textContent).toContain('T1 Known problem');
        expect(within(t1).getByTestId('vt-shift').textContent).toBe('shift -5.00 bar');
        expect(within(t1).getByTestId('vt-shift-ratio').textContent).toBe('2.5× train RMSE');
        expect(t1.textContent).not.toContain('0.100'); // no R² for a Known problem
    });

    it('Individual: % within ±3SD and the mean shift in SD', () => {
        render(<TrainTestCard data={withV('individual', { tests: [makeTestResult({ within_3sd_pct: 97.25, mean_shift_sd: 0.4 })] })} unit="bar" side />);
        expect(screen.getByTestId('train-test-row-train').textContent).toContain('99.6%');
        const t1 = screen.getByTestId('train-test-row-1');
        expect(t1.textContent).toContain('97.3%'); // one decimal
        expect(t1.textContent).toContain('+0.400 SD');
        // side column: not capped full-width
        expect(screen.getByTestId('train-test-card').className).not.toContain('wb2-full');
    });

    it('Clustering: % inside the 3× SD ring', () => {
        render(<TrainTestCard data={withV('clustering', { tests: [makeTestResult({ inside_3sd_ring_pct: 64 })] })} unit="" side />);
        expect(screen.getByTestId('train-test-card').querySelectorAll('th')[1].textContent).toBe('Rows inside the 3× SD ring');
        expect(screen.getByTestId('train-test-row-1').textContent).toContain('64.0%');
    });

    it('a test that includes train rows carries the neutral note with Rust\'s running days; none otherwise', () => {
        render(<TrainTestCard data={withV('individual', { tests: [makeTestResult({ train_rows: 40, train_days: 3.5 }), makeTestResult()] })} unit="" />);
        expect(screen.getByTestId('train-test-overlap-1').textContent)
            .toBe('T1 includes 3.5 d of train running time — results include rows the model was trained on.');
        expect(screen.queryByTestId('train-test-overlap-2')).toBeNull();
    });

    it('a test period with no running rows says so instead of numbers', () => {
        render(<TrainTestCard data={withV('individual', { tests: [makeTestResult({ rows: 0 })] })} unit="" />);
        expect(screen.getByTestId('train-test-row-1').textContent).toContain('No running rows in this period');
    });

    it('without the sent T-numbers (testNumbers), T numbers follow the result position, whatever index the backend sends', () => {
        render(<TrainTestCard data={withV('individual', { tests: [makeTestResult({ index: 5 }), makeTestResult({ index: 9, label: 'problem' })] })} unit="" />);
        expect(screen.getByTestId('train-test-row-1').textContent).toContain('T1 Normal');
        expect(screen.getByTestId('train-test-row-2').textContent).toContain('T2 Known problem');
    });
});

describe('Test results tiles (Health score page, rule 10)', () => {
    const tile = (t: Partial<TestPeriodResult>, scoreReady = true) => {
        render(<TestResultsCard data={withV('individual', { tests: [makeTestResult(t)] })} scoreReady={scoreReady} />);
        return screen.getByTestId('test-result-1');
    };

    it(`Normal: green below ${NORMAL_AMBER_PCT}% of running time under 80, amber at ${NORMAL_AMBER_PCT}% or more`, () => {
        const ok = tile({ pct_below_80: 4.9 });
        expect(ok.getAttribute('data-tone')).toBe('ok');
        expect(ok.className).toContain('vt-tile--ok');
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('4.9% of running time below 80');
        cleanup();
        const warn = tile({ pct_below_80: 5 });
        expect(warn.getAttribute('data-tone')).toBe('warn');
        expect(warn.className).toContain('vt-tile--warn');
    });

    it('Known problem detected before the event: green with the lead time', () => {
        const t = tile({ label: 'problem', first_below_80: '2026-01-01 02:10:00', event_time: '2026-01-04T00:00', lead_days: 2.6 });
        expect(t.getAttribute('data-tone')).toBe('ok');
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('2.6 days before the event');
    });

    it('Known problem detected only after the event: amber "Detected only N days after the event"', () => {
        const t = tile({ label: 'problem', first_below_80: '2026-01-05 00:00:00', event_time: '2026-01-04T00:00', lead_days: -1 });
        expect(t.getAttribute('data-tone')).toBe('warn');
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('Detected only 1.0 days after the event');
    });

    it('Known problem never detected: amber "Not detected"', () => {
        const t = tile({ label: 'problem', first_below_80: null, lead_days: null, event_time: '2026-01-04T00:00' });
        expect(t.getAttribute('data-tone')).toBe('warn');
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('Not detected');
    });

    it('Known problem detected without an event time: green "Detected", asks for the event time', () => {
        const t = tile({ label: 'problem', first_below_80: '2026-01-01 02:10:00', lead_days: null });
        expect(t.getAttribute('data-tone')).toBe('ok');
        expect(t.textContent).toContain('Add the event time');
    });

    it('never red: no tile uses a danger tone in any state', () => {
        const cases: Partial<TestPeriodResult>[] = [
            { pct_below_80: 90 },
            { label: 'problem', first_below_80: null },
            { label: 'problem', first_below_80: 'x', lead_days: -30 },
        ];
        for (const c of cases) expect(['ok', 'warn']).toContain(resultTone(makeTestResult(c), true));
    });

    it('not scored yet (set points not valid) and no running rows are neutral, never coloured', () => {
        expect(tile({}, false).getAttribute('data-tone')).toBe('none');
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('Not scored yet');
        cleanup();
        expect(tile({ rows: 0 }).getAttribute('data-tone')).toBe('none');
        expect(screen.getByTestId('test-result-1-big').textContent).toBe('No running rows');
    });

    it('a tile that includes train time carries the neutral note', () => {
        tile({ train_rows: 10, train_days: 1.2 });
        expect(screen.getByTestId('test-result-overlap-1').textContent).toContain('T1 includes 1.2 d of train running time');
    });

    it('no test period: a note pointing to where it is added; nothing without test_validation', () => {
        render(<TestResultsCard data={withV('individual', { tests: [] })} scoreReady custom />);
        expect(screen.getByTestId('test-results-empty').textContent).toContain('Model settings → Training data (Custom)');
        cleanup();
        render(<TestResultsCard data={makeHealthPreview({ kind: 'individual' })} scoreReady />);
        expect(screen.queryByTestId('test-results')).toBeNull();
    });

    it('says it is information only and explains the 1 h rule', () => {
        tile({});
        const card = screen.getByTestId('test-results');
        expect(card.textContent).toContain('information only — never blocks Mark complete');
        expect(card.textContent).toContain('at least 1 hour of running time');
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
        expect(screen.getByTestId('tests-changed-banner').textContent).toContain('Test periods changed');
        cleanup();
        render(<TestsChangedBanner state="removed" />);
        expect(screen.getByTestId('tests-changed-banner').textContent).toContain('Test periods removed');
        cleanup();
        render(<TestsChangedBanner state={null} />);
        expect(screen.queryByTestId('tests-changed-banner')).toBeNull();
    });
});

describe('review fixes 2026-10-07: T-numbers of the ORIGINAL list, test scoring failed, slow-scoring hint', () => {
    // The user's list is [T1 invalid (not sent), T2 valid]: Rust only sees T2 and answers with wire index 1.
    const onlyT2 = (over: Partial<TestPeriodResult> = {}) =>
        withV('individual', { tests: [makeTestResult({ index: 1, train_rows: 40, train_days: 3, ...over })] });

    it('the "Train vs test" row and its overlap note say T2, not T1', () => {
        render(<TrainTestCard data={onlyT2()} unit="" testNumbers={[2]} />);
        expect(screen.queryByTestId('train-test-row-1')).toBeNull();
        expect(screen.getByTestId('train-test-row-2').textContent).toContain('T2 Normal');
        expect(screen.getByTestId('train-test-overlap-2').textContent).toBe('T2 includes 3 d of train running time — results include rows the model was trained on.');
    });

    it('the result tile and its overlap note say T2, not T1', () => {
        render(<TestResultsCard data={onlyT2()} scoreReady testNumbers={[2]} />);
        expect(screen.queryByTestId('test-result-1')).toBeNull();
        const t2 = screen.getByTestId('test-result-2');
        expect(t2.textContent).toContain('T2 Normal');
        expect(screen.getByTestId('test-result-overlap-2').textContent).toContain('T2 includes 3 d of train running time');
    });

    it('a mapping is looked up by the wire index (not the order the results arrive in)', () => {
        render(<TestResultsCard
            data={withV('individual', { tests: [makeTestResult({ index: 2, label: 'problem' }), makeTestResult({ index: 1 })] })}
            scoreReady
            testNumbers={[1, 3]}
        />);
        expect(screen.getByTestId('test-result-3').textContent).toContain('T3 Known problem');
        expect(screen.getByTestId('test-result-1').textContent).toContain('T1 Normal');
    });

    const failedIssue = { code: 'test_scoring_failed', severity: 'warning' as const, field: 'test_periods', message: 'The Relation model engine did not answer.' };
    const unscored = (): HealthPreview => ({
        ...withV('relationship', { tests: [makeTestResult({ scored: 0, pct_below_80: null, lowest: null, lowest_at: null })] }),
        validation: [failedIssue],
    });

    it('test_scoring_failed: the tiles are replaced by one amber "Couldn\'t score the test periods — try again" (with Retry), never "Not scored yet"', () => {
        let retried = 0;
        render(<TestResultsCard data={unscored()} scoreReady onRetry={() => { retried += 1; }} />);
        const n = screen.getByTestId('test-scoring-failed');
        expect(n.className).toBe('vt-fail');
        expect(n.textContent).toContain(TEST_SCORING_FAILED_TEXT);
        expect(n.textContent).toContain('The Relation model engine did not answer.');
        expect(screen.queryByTestId('test-result-1')).toBeNull();
        expect(screen.getByTestId('test-results').textContent).not.toContain('Not scored yet');
        screen.getByTestId('test-scoring-retry').click();
        expect(retried).toBe(1);
    });

    it('test_scoring_failed: the "Train vs test" card keeps the train row, marks each test "Not scored" and shows the amber notice', () => {
        render(<TrainTestCard data={unscored()} unit="bar" />);
        expect(screen.getByTestId('train-test-row-train').textContent).toContain('0.910');
        expect(screen.getByTestId('train-test-row-1').textContent).toContain('Not scored');
        expect(screen.getByTestId('test-scoring-failed').textContent).toContain(TEST_SCORING_FAILED_TEXT);
        // no Retry button without a handler
        expect(screen.queryByTestId('test-scoring-retry')).toBeNull();
    });

    it('test_scoring_outdated: same amber notice in place of the tiles, but NO "Try again" (retrying cannot fix an out-of-date engine)', () => {
        const outdated = { code: 'test_scoring_outdated', severity: 'warning' as const, field: 'test_periods', message: 'The Relation model engine in this build is out of date - reinstall or update the app.' };
        render(<TestResultsCard data={{ ...unscored(), validation: [outdated] }} scoreReady onRetry={() => {}} />);
        const n = screen.getByTestId('test-scoring-failed');
        expect(n.textContent).toContain("Couldn't score the test periods");
        expect(n.textContent).not.toContain('try again');
        expect(n.textContent).toContain('out of date');
        expect(screen.queryByTestId('test-scoring-retry')).toBeNull();
        expect(screen.queryByTestId('test-result-1')).toBeNull();
    });

    it('test_scoring_too_large: Rust\'s reason (too many rows) under a headline WITHOUT "try again", and no Try again button (retrying the same rows fails the same way)', () => {
        const tooLarge = { code: 'test_scoring_too_large', severity: 'warning' as const, field: 'test_periods', message: 'These test periods have too many rows to score in memory - shorten them or remove one.' };
        render(<TestResultsCard data={{ ...unscored(), validation: [tooLarge] }} scoreReady onRetry={() => {}} />);
        const n = screen.getByTestId('test-scoring-failed');
        expect(n.textContent).toContain('too many rows to score in memory');
        expect(n.textContent).toContain("Couldn't score the test periods");
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
