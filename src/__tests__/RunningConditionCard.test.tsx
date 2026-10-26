import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { CARD_NO_ROWS_TEXT, CARD_NO_TRAIN_TEXT, RunningConditionCard } from '../components/windows/RunningConditionCard';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import type { TestPeriod, WorkspaceSensorFilter } from '../types';

afterEach(cleanup);

const p = (id: string, start: string, end: string) => ({ id, start, end });
const f = (id: string, sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string, value2 = ''): WorkspaceSensorFilter =>
    ({ id, sensor, operation, value1, value2 });
const DESC: Record<string, string> = { POWER: 'GENERATOR ACTIVE POWER', SPEED: 'TURBINE SPEED' };
const UNIT: Record<string, string> = { POWER: 'kW', SPEED: 'RPM' };
// The window's SensorMetaProvider (BuildModelWindow) supplies the chip labels.
const META = Object.keys(DESC).map(tag => ({ tag, description: DESC[tag], unit: UNIT[tag], component: 'Generator' }));

function card(over: Partial<React.ComponentProps<typeof RunningConditionCard>> = {}) {
    const onOpen = vi.fn();
    render(
        <SensorMetaProvider metadata={META}>
        <RunningConditionCard
            state="set"
            periods={[p('a', '2026-01-01T00:00', '2026-03-31T23:59'), p('b', '2026-04-15T00:00', '')]}
            filters={[f('f1', 'POWER', 'greater_than', '4000')]}
            headers={['POWER', 'SPEED']}
            getDesc={t => DESC[t] ?? ''}
            getUnit={t => UNIT[t] ?? ''}
            onOpen={onOpen}
            {...over}
        />
        </SensorMetaProvider>,
    );
    return onOpen;
}
/** Once SET the card is one line; "Details" unfolds the full card (chips, strip). */
const openDetails = () => fireEvent.click(screen.getByTestId('rc-card-details'));
function detailsCard(over: Partial<React.ComponentProps<typeof RunningConditionCard>> = {}) {
    const onOpen = card(over);
    openDetails();
    return onOpen;
}

/**
 * User decision 2026-10-14: the Build Model window never says how many data rows
 * are used. The card shows NO count — no "N rows · x%", no "Counting rows…", no
 * "— rows", no share meter — in the one line and in the Details view alike.
 */
function expectNoRowCount() {
    const c = screen.getByTestId('rc-card');
    for (const id of ['rc-card-rows', 'rc-card-pct', 'rc-card-rows-loading', 'rc-card-rows-error']) {
        expect(within(c).queryByTestId(id)).toBeNull();
    }
    expect(c.querySelector('.rcc-meter')).toBeNull();
    expect(within(c).queryByRole('img', { name: 'Share of rows used' })).toBeNull();
    expect(c.textContent).not.toMatch(/\d[\d,]*\s*rows?\b/i);
    expect(c.textContent).not.toMatch(/Counting rows|— rows|rows ·|%/);
}

describe('RunningConditionCard — Not set', () => {
    it('big yellow card marked "!" (no step number, no "Step 1"), "Set the running condition", the one-sentence reason, its own primary "Set running condition →" button', () => {
        const onOpen = card({ state: 'unset', periods: [], filters: [] });
        const c = screen.getByTestId('rc-card');
        expect(c.getAttribute('data-state')).toBe('unset');
        expect(c.className).toContain('rcc-card--req');
        expect(c.querySelector('.rcc-num')!.textContent).toBe('!');
        expect(c.querySelector('.rcc-kicker')!.textContent).toBe('Running condition · required before training Not set');
        expect(c.textContent).not.toMatch(/Step\s*1/i);
        // a card, never the one line; no Details to unfold
        expect(c.className).not.toContain('rcc-line');
        expect(screen.queryByTestId('rc-card-details')).toBeNull();
        // An amber "Not set" pill (both Train buttons are disabled until it is set).
        expect(screen.getByTestId('rc-card-pill').textContent).toBe('Not set');
        expect(screen.getByTestId('rc-card-pill').className).toContain('f4-pill--warn');
        expect(within(c).getByRole('heading', { name: 'Set the running condition' })).toBeTruthy();
        expect(c.textContent).toContain('Tell Wizard which healthy time to learn from (train periods) and the sensor that shows the machine is running — Machine is running when … is above … — so models learn from normal operation');
        expect(screen.queryByTestId('rc-card-why')).toBeNull();
        const btn = screen.getByTestId('rc-card-open');
        expect(btn.textContent).toBe('Set running condition →');
        expect(btn.className).toContain('rcx-btn--pri');
        fireEvent.click(btn);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('an old project that must set it again: the pill says "Set it again" and the card says why (the `why` text replaces the usual sentence)', () => {
        card({ state: 'unset', periods: [], filters: [], why: <>This project used <b>Use all rows</b>, which is gone.</> });
        const c = screen.getByTestId('rc-card');
        expect(screen.getByTestId('rc-card-pill').textContent).toBe('Set it again');
        expect(screen.getByTestId('rc-card-pill').className).toContain('f4-pill--warn');
        expect(screen.getByTestId('rc-card-why').textContent).toBe('This project used Use all rows, which is gone.');
        expect(c.textContent).not.toContain('Tell Wizard which healthy time');
        expect(screen.getByTestId('rc-card-open').textContent).toBe('Set running condition →');
    });

    it('shows neither the chips nor the warning slot', () => {
        card({ state: 'unset', periods: [], filters: [] });
        expect(screen.queryByTestId('rc-card-time')).toBeNull();
        expect(screen.queryByTestId('rc-card-use')).toBeNull();
    });
});

describe('RunningConditionCard — Invalid period', () => {
    const bad = [p('a', '2026-01-01T00:00', '2026-03-31T23:59'), p('x', '2026-05-30T00:00', '2026-04-10T23:59')];

    it('red card: "P N needs fixing", the validatePeriods reason, the period chips (broken one flagged) and a "Fix period" button', () => {
        const onOpen = card({ state: 'invalid', periods: bad });
        const c = screen.getByTestId('rc-card');
        expect(c.getAttribute('data-state')).toBe('invalid');
        expect(c.className).toContain('rcc-card--bad');
        // marked "!" — no step number, no "Step 1"; a card with its own button, never the one line
        expect(c.querySelector('.rcc-num')!.textContent).toBe('!');
        expect(c.querySelector('.rcc-kicker')!.textContent).toBe('Running condition');
        expect(c.textContent).not.toMatch(/Step\s*1/i);
        expect(c.className).not.toContain('rcc-line');
        expect(screen.queryByTestId('rc-card-details')).toBeNull();
        expect(screen.getByTestId('rc-card-title').textContent).toBe('P2 needs fixing');
        expect(screen.getByTestId('rc-card-reason').textContent).toBe("P2 ends before it starts. Models can't be trained until it's fixed.");
        const chips = screen.getAllByTestId('rc-card-period-chip');
        expect(chips.map(x => x.textContent)).toEqual(['P1 · 2026/01/01 00:00 → 2026/03/31 23:59', '⚠ P2 · 2026/05/30 00:00 → 2026/04/10 23:59']);
        expect(chips[1].className).toContain('rcc-chip--bad');
        expect(chips[0].className).not.toContain('rcc-chip--bad');
        const btn = screen.getByTestId('rc-card-open');
        expect(btn.textContent).toBe('Fix period');
        expect(btn.className).toContain('rcx-btn--danger');
        fireEvent.click(btn);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('names the FIRST broken period', () => {
        card({ state: 'invalid', periods: [p('a', '2026-01-01T00:00', ''), p('b', '2026-05-01T00:00', '2026-06-01T23:59')] });
        expect(screen.getByTestId('rc-card-title').textContent).toBe('P1 needs fixing');
        expect(screen.getByTestId('rc-card-reason').textContent).toContain('P1 needs an end date.');
    });
});

describe('RunningConditionCard — Set: ONE line (workbench redesign §1)', () => {
    const B = { min: '2025-01-01 00:00:00', max: '2026-07-31 23:50:00' };
    const S = (id: string, start: string, end: string): TestPeriod => ({ id, start, end });

    it('✓ · Train n periods + span · Scoring n periods · Running when <sensor> is above <value> · Details · Edit — no row count, no period strip on the line', () => {
        const onOpen = card({
            bounds: B,
            periods: [p('a', '2026-01-01T00:00', '2026-03-31T23:59'), p('b', '2026-04-15T00:00', '2026-06-30T23:59')],
            testPeriods: [S('s1', '2026-07-01T00:00', '2026-07-10T23:59'), S('s2', '2026-07-11T00:00', '2026-07-20T23:59')],
            filters: [f('f1', 'POWER', 'greater_than', '4000')],
        });
        const c = screen.getByTestId('rc-card');
        expect(c.getAttribute('data-state')).toBe('set');
        expect(c.getAttribute('data-details')).toBe('closed');
        expect(c.className).toContain('rcc-line');
        expect(c.querySelector('.rcc-num--ok svg')).not.toBeNull(); // the tick
        expect(c.textContent).not.toMatch(/Step\s*1/i);
        expect(screen.getByTestId('rc-card-time').textContent).toBe('Train 2 periods 2026/01/01 00:00 → 2026/06/30 23:59');
        // the span is first start → last end, in the app's one date format (date + time on both sides), mono
        expect(screen.getByTestId('rc-card-span').className).toContain('wbx-dt');
        expect(screen.getByTestId('rc-card-test').textContent).toBe('Scoring 2 periods');
        expect(screen.getByTestId('rc-card-cond').textContent).toBe('Running when GENERATOR ACTIVE POWERPOWER is above 4,000 kW');
        expect(screen.getByTestId('rc-card-cond').querySelector('.sl-desc')!.textContent).toBe('GENERATOR ACTIVE POWER');
        // No count of rows (2026-10-14): the slot that holds the two warnings is empty, so the
        // line ends with the conditions (an empty `.rcc-line-item` is hidden by the stylesheet).
        expectNoRowCount();
        expect(screen.getByTestId('rc-card-use').textContent).toBe('');
        expect(screen.getByTestId('rc-card-use').childNodes).toHaveLength(0);
        expect(screen.getByTestId('rc-card-use').className).toBe('rcc-line-item');
        expect(c.querySelector('.rcc-line-main')!.textContent).toBe('Running conditionTrain 2 periods 2026/01/01 00:00 → 2026/06/30 23:59Scoring 2 periodsRunning when GENERATOR ACTIVE POWERPOWER is above 4,000 kW');
        // No period strip on the line (user decision 2026-10-11) — it is in the Details view.
        expect(within(c).queryByTestId('period-coverage')).toBeNull();
        expect(c.querySelector('.rcc-line-strip')).toBeNull();
        // the full chips are NOT on the line
        expect(screen.queryByTestId('rc-card-period-chip')).toBeNull();
        expect(screen.queryByTestId('rc-card-test-chip')).toBeNull();
        expect(screen.queryByTestId('rc-card-cond-chip')).toBeNull();
        expect(screen.queryByTestId('rc-card-pill')).toBeNull();
        // Details + Edit, both quiet (no filled button on the line)
        const details = screen.getByTestId('rc-card-details');
        expect(details.textContent).toBe('Details ');
        expect(details.getAttribute('aria-expanded')).toBe('false');
        const edit = screen.getByTestId('rc-card-open');
        expect(edit.textContent).toBe('Edit');
        for (const b of [details, edit]) expect(b.className).not.toMatch(/rcx-btn--pri|rcx-btn--danger/);
        fireEvent.click(edit);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('singular / plural and the span of one period; an open end reads "End"', () => {
        card({ periods: [p('a', '2026-01-01T00:00', '2026-03-31T23:59')], testPeriods: [S('s1', '2026-07-01T00:00', '2026-07-10T23:59')],
            filters: [f('f1', 'POWER', 'greater_than', '4000')] });
        expect(screen.getByTestId('rc-card-time').textContent).toBe('Train 1 period 2026/01/01 00:00 → 2026/03/31 23:59');
        expect(screen.getByTestId('rc-card-test').textContent).toBe('Scoring 1 period');
        cleanup();
        card(); // P1 2026/01/01 – 03/31, P2 2026/04/15 → open end
        expect(screen.getByTestId('rc-card-time').textContent).toBe('Train 2 periods 2026/01/01 00:00 → End');
        cleanup();
        // a period that is not on whole-day edges reads the same way: date + time
        card({ periods: [p('a', '2026-02-09T06:30', '2026-02-09T23:50')] });
        expect(screen.getByTestId('rc-card-span').textContent).toBe('2026/02/09 06:30 → 2026/02/09 23:50');
    });

    it('shows only the line the build applies (a complete "sensor > value"); none = amber "Machine running: not set"', () => {
        card({ filters: [f('f2', 'SPEED', 'greater_than', ''), f('f3', 'GONE', 'greater_than', '1'), f('f1', 'POWER', 'greater_than', '4000')] });
        expect(screen.getByTestId('rc-card-cond').textContent).toBe('Running when GENERATOR ACTIVE POWERPOWER is above 4,000 kW');
        cleanup();
        card({ filters: [] });
        expect(screen.getByTestId('rc-card-cond').textContent).toBe('Machine running: not set');
        expect(screen.getByTestId('rc-card-cond').querySelector('.rcc-line-warn')).not.toBeNull();
    });

    it('nothing to train on / to score on is said in amber on the line; a broken scoring period in red', () => {
        card({ periods: [] });
        expect(screen.getByTestId('rc-card-time').textContent).toBe('No train period');
        expect(screen.getByTestId('rc-card-time').querySelector('.rcc-line-warn')).not.toBeNull();
        // The warning stays, in words only — no "0 rows".
        expect(screen.getByTestId('rc-card-no-train').textContent).toBe('Add a train period');
        expect(screen.getByTestId('rc-card-no-train').className).toBe('rcc-line-warn');
        expect(screen.getByTestId('rc-card-use').textContent).toBe(CARD_NO_TRAIN_TEXT);
        expectNoRowCount();
        expect(screen.getByTestId('rc-card-test').textContent).toBe('No scoring period');
        expect(screen.getByTestId('rc-card-test').querySelector('.rcc-line-warn')!.getAttribute('title')).toBe('Needed before Mark complete');
        expect(screen.queryByTestId('rc-card-test-bad')).toBeNull();
        cleanup();
        card({ testPeriods: [S('s1', '2026-05-31T00:00', '2026-05-01T00:00'), S('s2', '2026-06-01T00:00', '2026-06-30T23:59')] });
        expect(screen.getByTestId('rc-card-test').textContent).toBe('Scoring 2 periods · ⚠ 1 to fix');
        expect(screen.getByTestId('rc-card-test-bad').className).toContain('rcc-line-bad');
    });

    it('"Details" unfolds the full card in place and "Hide details" folds it back; Edit works in both', () => {
        const onOpen = card({ bounds: B });
        expect(screen.queryByTestId('rc-card-period-chip')).toBeNull();
        openDetails();
        const c = screen.getByTestId('rc-card');
        expect(c.getAttribute('data-details')).toBe('open');
        expect(c.className).not.toContain('rcc-line');
        expect(screen.getAllByTestId('rc-card-period-chip')).toHaveLength(2);
        expect(screen.getByTestId('rc-card-cond-chip')).toBeTruthy();
        expectNoRowCount();
        const hide = screen.getByTestId('rc-card-details');
        expect(hide.textContent).toBe('Hide details ');
        expect(hide.getAttribute('aria-expanded')).toBe('true');
        // Same button, same group, same order as on the line: [Details / Hide details][Edit].
        const group = (el: HTMLElement) => [...el.closest('.rcc-acts')!.children].map(b => `${b.getAttribute('data-testid')}:${b.className}`);
        const openGroup = group(hide);
        expect(openGroup).toEqual(['rc-card-details:rcx-btn rcx-btn--sm rcc-line-more', 'rc-card-open:rcx-btn rcx-btn--sm']);
        expect(c.lastElementChild).toBe(hide.closest('.rcc-acts')); // the group ends the card, as it ends the line
        expect(c.querySelector('.rcc-kicker')!.contains(hide)).toBe(false); // not a text link in the heading any more
        fireEvent.click(screen.getByTestId('rc-card-open'));
        expect(onOpen).toHaveBeenCalledTimes(1);
        fireEvent.click(hide);
        expect(screen.getByTestId('rc-card').className).toContain('rcc-line');
        expect(group(screen.getByTestId('rc-card-details'))).toEqual(openGroup);
        expect(screen.getByTestId('rc-card').lastElementChild).toBe(screen.getByTestId('rc-card-details').closest('.rcc-acts'));
        expect(screen.queryByTestId('rc-card-period-chip')).toBeNull();
        expectNoRowCount();
    });

    // "Details" / "Hide details" are two elements in two
    // trees, so the focus used to drop to <body> on every toggle.
    it('"Details" is ONE control to the keyboard: after each toggle the focus is on it, with aria-expanded flipped', () => {
        card({ bounds: B });
        const details = screen.getByTestId('rc-card-details') as HTMLButtonElement;
        details.focus();
        fireEvent.click(details);
        const hide = screen.getByTestId('rc-card-details');
        expect(hide.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(hide);
        expect(document.activeElement).not.toBe(document.body);
        fireEvent.click(hide);
        const again = screen.getByTestId('rc-card-details');
        expect(again.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(again);
        expect(screen.getAllByTestId('rc-card-details')).toHaveLength(1);
    });

    it('opening the card does not steal the focus by itself (only a toggle moves it)', () => {
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        outside.focus();
        card({ bounds: B });
        expect(document.activeElement).toBe(outside);
        outside.remove();
    });

    it('the tick of the one-line view has words for a screen reader (not tooltip-only)', () => {
        card();
        const tick = screen.getByTestId('rc-card-tick');
        expect(tick.getAttribute('role')).toBe('img');
        expect(tick.getAttribute('aria-label')).toBe('Set · applies to every model');
        expect(screen.getByRole('img', { name: 'Set · applies to every model' })).toBe(tick);
        expect(tick.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    });
});

describe('RunningConditionCard — Set', () => {
    it('Details open: the full card — green left bar + tick, "Running condition · Set · applies to every model" (no "Step 1") and "Hide details"', () => {
        detailsCard();
        const c = screen.getByTestId('rc-card');
        expect(c.getAttribute('data-state')).toBe('set');
        expect(c.className).toContain('rcc-card--ok');
        expect(c.querySelector('.rcc-num--ok svg')).not.toBeNull();
        expect(c.querySelector('.rcc-kicker')!.textContent).toBe('Running condition Setapplies to every model');
        expect(c.textContent).not.toMatch(/Step\s*1/i);
        expect(screen.getByTestId('rc-card-pill').textContent).toBe('Set');
        expect(c.getAttribute('data-details')).toBe('open');
        expect(c.className).not.toContain('rcc-line');
    });

    it('"Train" shows readable date-range chips (P1, P2 … when there are several) with open ends as Start / End', () => {
        detailsCard();
        expect(within(screen.getByTestId('rc-card-time')).getByText('Train')).toBeTruthy();
        expect(screen.getAllByTestId('rc-card-period-chip').map(x => x.textContent)).toEqual(['P1 · 2026/01/01 00:00 → 2026/03/31 23:59', 'P2 · 2026/04/15 00:00 → End']);
        expect(screen.getAllByTestId('rc-card-period-chip')[0].querySelector('.tpe-sw--tr')).not.toBeNull();
        cleanup();
        detailsCard({ periods: [p('a', '', '2026-03-31T23:59')] });
        expect(screen.getByTestId('rc-card-period-chip').textContent).toBe('Start → 2026/03/31 23:59');
    });

    it('no train period = an AMBER "No train period — add one" chip and an amber "Add a train period" — no "0 rows" (never "Whole dataset"; red is only for invalid input)', () => {
        detailsCard({ periods: [] });
        const chip = screen.getByTestId('rc-card-period-chip');
        expect(chip.textContent).toBe('No train period — add one');
        expect(chip.className).toContain('rcc-chip--warn');
        expect(chip.className).not.toContain('rcc-chip--bad');
        expect(screen.getByTestId('rc-card-no-train').textContent).toBe('Add a train period');
        expect(screen.getByTestId('rc-card-no-train').className).toBe('rcc-use-note rcc-line-warn');
        expect(screen.getByTestId('rc-card-no-train').getAttribute('role')).toBeNull(); // a step to do, not an alert
        expect(screen.queryByTestId('rc-card-no-rows')).toBeNull();
        expectNoRowCount();
        expect(screen.getByTestId('rc-card').textContent).not.toContain('Whole dataset');
    });

    it('"Running when": ONE chip "<sensor> is above <value unit>" and the note that it is also the export\'s running status', () => {
        detailsCard();
        const chips = screen.getAllByTestId('rc-card-cond-chip');
        // Inline label (description then tag) + "is above" + the value in mono, with
        // thousands separators; the whole sentence in the title.
        expect(chips.map(x => x.textContent)).toEqual(['GENERATOR ACTIVE POWERPOWER is above 4,000 kW']);
        expect(chips[0].querySelector('.sl-desc')!.textContent).toBe('GENERATOR ACTIVE POWER');
        expect(chips[0].querySelector('.sl-tag')!.textContent).toBe('POWER');
        expect(chips[0].querySelector('.rcc-above')!.textContent).toBe('is above');
        expect(chips[0].querySelector('.rcc-rest')!.textContent).toBe('4,000 kW');
        expect(chips[0].getAttribute('title')).toBe('Machine is running when GENERATOR ACTIVE POWER · POWER · kW · Generator is above 4,000 kW');
        const cond = screen.getByTestId('rc-card-cond');
        expect(within(cond).getByText('Running when')).toBeTruthy();
        expect(within(cond).getByText('also the export’s running status')).toBeTruthy();
        expect(within(cond).queryByText('AND')).toBeNull();
        expect(within(cond).queryByText('OR')).toBeNull();
    });

    it('a small typed threshold keeps its decimals on the chip (never rounded to 0)', () => {
        detailsCard({ filters: [f('f1', 'POWER', 'greater_than', '0.0005')] });
        const rests = screen.getAllByTestId('rc-card-cond-chip').map(x => x.querySelector('.rcc-rest')!.textContent);
        expect(rests).toEqual(['0.0005 kW']);
    });

    it('a sensor without a description shows its tag; one without a unit shows no unit', () => {
        detailsCard({ filters: [f('f1', 'MYSTERY', 'greater_than', '7')], headers: ['MYSTERY'] });
        expect(screen.getByTestId('rc-card-cond-chip').textContent).toBe('MYSTERY is above 7');
    });

    it('conditions the build would not apply (incomplete, sensor not in the dataset, not "above") are not shown; only the first one is', () => {
        detailsCard({ filters: [f('f2', 'SPEED', 'greater_than', ''), f('f3', 'GONE', 'greater_than', '1'), f('f4', 'SPEED', 'less_than', '3'), f('f1', 'POWER', 'greater_than', '4000'), f('f5', 'SPEED', 'greater_than', '9')] });
        expect(screen.getAllByTestId('rc-card-cond-chip').map(x => x.textContent)).toEqual(['GENERATOR ACTIVE POWERPOWER is above 4,000 kW']);
    });

    it('right side: NO rows used, no "rows · %", no share bar — only the period strip; the Edit button opens the settings', () => {
        const onOpen = detailsCard({ bounds: { min: '2025-01-01 00:00:00', max: '2026-07-31 23:50:00' } });
        expectNoRowCount();
        const use = screen.getByTestId('rc-card-use');
        expect([...use.children].map(x => x.getAttribute('data-testid'))).toEqual(['period-coverage']);
        expect(screen.queryByTestId('rc-card-no-train')).toBeNull();
        expect(screen.queryByTestId('rc-card-no-rows')).toBeNull();
        const edit = screen.getByTestId('rc-card-open');
        expect(edit.textContent).toBe('Edit');
        fireEvent.click(edit);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    describe('period strip (restored 2026-10-03)', () => {
        // 2025-01-01 -> 2026-07-31 23:50 = 577 days
        const B = { min: '2025-01-01 00:00:00', max: '2026-07-31 23:50:00' };
        const cov = () => within(screen.getByTestId('rc-card')).getByTestId('period-coverage');

        it('draws one block per PERSISTED period, with start/end year-month and a short day count (days — never rows)', () => {
            detailsCard({ bounds: B });
            expect(cov().querySelectorAll('.f4-strip i')).toHaveLength(2);
            expect(cov().className).toContain('f4-cov--mini');
            // the two ends of the strip: year/month (the short form of the one date format)
            expect(cov().textContent).toContain('2025/01');
            expect(cov().textContent).toContain('2026/07');
            expect(cov().textContent).not.toMatch(/Jan|Jul/);
            expect(within(cov()).getByTestId('period-coverage-days').textContent).toBe('198 d train · 0 d scoring'); // Jan1-Mar31 2026 (90 d) + Apr15 2026-end of data (108 d)
            expect(screen.getByTestId('rc-card-use').contains(cov())).toBe(true);
            // the strip is the column's only content: the rows-used count, % and bar are gone
            expect(screen.getByTestId('rc-card-use').firstElementChild).toBe(cov());
            expect(screen.getByTestId('rc-card-use').childElementCount).toBe(1);
            expect(screen.queryByTestId('rc-card-rows')).toBeNull();
            expect(screen.getByTestId('rc-card').querySelector('.rcc-meter')).toBeNull();
        });

        it('reads the periods prop only: re-rendering with the same persisted periods does not change it', () => {
            const { rerender } = render(
                <RunningConditionCard state="set" periods={[p('a', '2025-01-01T00:00', '2025-01-31T23:59')]} filters={[]} headers={[]}
                    getDesc={() => ''} getUnit={() => ''} bounds={B} onOpen={vi.fn()} />,
            );
            openDetails(); // the strip lives in the Details view only
            const first = within(cov()).getByTestId('period-coverage-days').textContent;
            expect(first).toBe('31 d train · 0 d scoring');
            rerender(
                <RunningConditionCard state="set" periods={[p('a', '2025-01-01T00:00', '2025-01-31T23:59')]} filters={[]} headers={[]}
                    getDesc={() => ''} getUnit={() => ''} noRows={false} bounds={B} onOpen={vi.fn()} />,
            );
            expect(within(cov()).getByTestId('period-coverage-days').textContent).toBe(first);
        });

        it('no train period = an EMPTY train lane ("0 d train"), not a full strip', () => {
            detailsCard({ periods: [], bounds: B });
            expect(within(cov()).getByTestId('period-coverage-days').textContent).toBe('0 d train · 0 d scoring');
            expect(cov().querySelectorAll('.f4-strip i')).toHaveLength(0);
        });

        it('two lanes: train on top, scoring below (every scoring block the same, none hatched); caption "N d train · M d scoring"', () => {
            detailsCard({ bounds: B, periods: [p('a', '2026-01-01T00:00', '2026-03-31T23:59')], testPeriods: [
                { id: 't1', start: '2026-01-01T00:00', end: '2026-06-30T23:59' },
                // a period saved before still carries a label: drawn like the other one
                { id: 't2', start: '2026-07-01T00:00', end: '2026-07-10T00:00', label: 'problem' },
            ] });
            expect(cov().querySelector('.f4-strip--tt')).not.toBeNull();
            expect(Array.from(cov().querySelectorAll('.f4-strip i.te')).map(x => x.className)).toEqual(['te', 'te']);
            expect(within(cov()).getByTestId('period-coverage-days').textContent).toBe('90 d train · 190 d scoring');
        });

        it('open ends reach the edge of the strip', () => {
            detailsCard({ periods: [p('a', '2026-07-01T00:00', '')], bounds: B });
            const b = cov().querySelector('.f4-strip i') as HTMLElement;
            expect(Math.round(parseFloat(b.style.left) + parseFloat(b.style.width))).toBe(100);
        });

        it('hidden while the dataset bounds are unknown: the right column is then EMPTY (the stylesheet hides it — no blank 230 px gap)', () => {
            detailsCard({ bounds: null });
            expect(screen.queryByTestId('period-coverage')).toBeNull();
            const use = screen.getByTestId('rc-card-use');
            expect(use.className).toBe('rcc-use');
            expect(use.childNodes).toHaveLength(0); // `:empty` matches: `.rcc-use:empty { display: none }`
            cleanup();
            detailsCard({ bounds: { min: null, max: null } });
            expect(screen.queryByTestId('period-coverage')).toBeNull();
        });

        it('is not drawn on the unset / invalid cards', () => {
            card({ state: 'unset', bounds: B });
            expect(screen.queryByTestId('period-coverage')).toBeNull();
        });
    });

    // The gate's verdict (`countedNoTrainRows`, passed as `noRows`) is all the card gets of
    // the count: while it is not "nothing to train on" the card says nothing about rows —
    // counting, counted, failed or not asked all look the same.
    it('says nothing about rows while there is something to train on, in both views', () => {
        card({ noRows: false });
        expectNoRowCount();
        expect(screen.getByTestId('rc-card-use').textContent).toBe('');
        openDetails();
        expectNoRowCount();
        expect(screen.getByTestId('rc-card-use').textContent).toBe('');
        expect(screen.getByTestId('rc-card').className).toContain('rcc-card--ok');
    });

    it('the settled "no running row" verdict is still a red alert — in words, "Nothing to train on", with no "0" in front', () => {
        card({ noRows: true });
        let c = screen.getByTestId('rc-card');
        expect(c.className).toContain('rcc-card--bad');
        expect(c.getAttribute('data-norows')).toBe('true');
        let alert = screen.getByTestId('rc-card-no-rows');
        expect(alert.textContent).toBe('Nothing to train on');
        expect(alert.textContent).toBe(CARD_NO_ROWS_TEXT);
        expect(alert.getAttribute('role')).toBe('alert');
        expect(alert.className).toBe('rcc-line-bad');
        expect(alert.getAttribute('title')).toBe('No rows match the running condition inside the train periods — widen a train period or relax the condition');
        expect(screen.getByTestId('rc-card-use').textContent).toBe('Nothing to train on'); // no leading "0"
        expect(screen.getByTestId('rc-card-tick').textContent).toBe('!');
        expectNoRowCount();
        openDetails();
        c = screen.getByTestId('rc-card');
        expect(c.className).toContain('rcc-card--bad');
        expect(c.getAttribute('data-norows')).toBe('true');
        alert = screen.getByTestId('rc-card-no-rows');
        expect(alert.textContent).toBe('Nothing to train on');
        expect(alert.getAttribute('role')).toBe('alert');
        expect(alert.className).toBe('rcc-use-note rcc-line-bad');
        expect(alert.getAttribute('title')).toBe('No rows match the running condition inside the train periods — widen a train period or relax the condition');
        expect(screen.getByTestId('rc-card-use').firstElementChild).toBe(alert);
        expect(screen.getByTestId('rc-card-pill').textContent).toBe('Nothing to train on');
        expectNoRowCount();
    });

    it('no train period wins over the verdict: "Add a train period", never the red alert', () => {
        card({ periods: [], noRows: false });
        expect(screen.getByTestId('rc-card-no-train').textContent).toBe(CARD_NO_TRAIN_TEXT);
        expect(screen.queryByTestId('rc-card-no-rows')).toBeNull();
        expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
    });
});

describe('RunningConditionCard — Scoring chips ("just score it", 2026-10-10)', () => {
    const T = (over: Partial<TestPeriod> = {}): TestPeriod => ({ id: 't', start: '2026-05-01T00:00', end: '2026-05-31T23:59', ...over });

    it('no scoring period: an amber chip "needed before Mark complete" (Train does not need one)', () => {
        detailsCard();
        const row = screen.getByTestId('rc-card-test');
        expect(within(row).getByText('Scoring')).toBeTruthy();
        expect(within(row).queryByText('Test')).toBeNull();
        const chip = screen.getByTestId('rc-card-test-chip');
        expect(chip.textContent).toBe('No scoring period — needed before Mark complete');
        expect(chip.className).toContain('rcc-chip--warn');
    });

    it('one chip per scoring period: "S1 · dates" — start → end and nothing else', () => {
        detailsCard({ testPeriods: [
            T({ id: 'a' }),
            T({ id: 'b', start: '2026-06-01T00:00', end: '2026-06-30T23:59' }),
        ] });
        const chips = screen.getAllByTestId('rc-card-test-chip');
        expect(chips.map(c => c.textContent)).toEqual([
            'S1 · 2026/05/01 00:00 → 2026/05/31 23:59',
            'S2 · 2026/06/01 00:00 → 2026/06/30 23:59',
        ]);
        for (const c of chips) {
            expect(c.className).toBe('rcc-chip rcc-chip--test');
            expect(c.querySelector('.tpe-sw--te')).not.toBeNull();
            expect(c.hasAttribute('data-label')).toBe(false);
        }
    });

    it('a workspace saved before 2026-10-10: a "Known problem" period with an event time is the same plain "S#" chip', () => {
        detailsCard({ testPeriods: [
            T({ id: 'a', label: 'normal' }),
            T({ id: 'b', start: '2026-06-01T00:00', end: '2026-06-30T23:59', label: 'problem', eventTime: '2026-06-20T14:30', fromHighlight: 'Bearing trip' }),
        ] });
        const chips = screen.getAllByTestId('rc-card-test-chip');
        expect(chips.map(c => c.textContent)).toEqual([
            'S1 · 2026/05/01 00:00 → 2026/05/31 23:59',
            'S2 · 2026/06/01 00:00 → 2026/06/30 23:59',
        ]);
        expect(chips[1].className).toBe('rcc-chip rcc-chip--test');
        expect(chips[1].querySelector('.tpe-sw--pb')).toBeNull();
        expect(screen.queryByTestId('rc-card-test-event')).toBeNull();
        expect(screen.getByTestId('rc-card').textContent).not.toMatch(/Known problem|Normal|event|Bearing trip/);
    });

    it('a scoring period that includes train time is only a hover note on its chip, never an error', () => {
        detailsCard({ testPeriods: [T({ start: '2026-03-01T00:00', end: '2026-03-31T23:59' })] });
        const chip = screen.getByTestId('rc-card-test-chip');
        expect(chip.getAttribute('title')).toBe('Includes train time (P1) — information only');
        expect(chip.className).not.toContain('rcc-chip--bad');
    });

    it('a broken scoring period (end before start, or a missing date) is flagged red on the card', () => {
        detailsCard({ testPeriods: [T({ start: '2026-05-31T00:00', end: '2026-05-01T00:00' }), T({ id: 'u', end: '' })] });
        const chips = screen.getAllByTestId('rc-card-test-chip');
        for (const chip of chips) {
            expect(chip.className).toContain('rcc-chip--bad');
            expect(chip.textContent!.startsWith('⚠ S')).toBe(true);
        }
    });

    it('a legacy event time outside its period is NOT an error any more (the event time is ignored)', () => {
        detailsCard({ testPeriods: [T({ label: 'problem', eventTime: '2027-01-01T00:00' })] });
        const chip = screen.getByTestId('rc-card-test-chip');
        expect(chip.className).not.toContain('rcc-chip--bad');
        expect(chip.textContent).toBe('S1 · 2026/05/01 00:00 → 2026/05/31 23:59');
    });
});
