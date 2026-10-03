import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => <div data-testid="echarts-mock" data-series={props.option?.series?.length ?? 0} />,
}));

import WorkbenchStepBar, { workbenchStepLooks, STEP_ORDER, type StepInput, type StepKey, type StepLook } from '../components/windows/workbench/WorkbenchStepBar';
import { PageSwitch, StaleBanner } from '../components/windows/workbench/WorkbenchShellParts';
import ChartCard, { LegendItem } from '../components/windows/workbench/ChartCard';

afterEach(cleanup);

const input = (over: Partial<StepInput> = {}): StepInput => ({
    rcState: 'set', hasModel: true, settingsReady: true, trained: false, stale: false, complete: false, healthValid: null, ...over,
});
const looks = (over: Partial<StepInput> = {}) => STEP_ORDER.map(s => workbenchStepLooks(input(over))[s.key]);

describe('workbenchStepLooks (the mockup\'s rules)', () => {
    it('Running condition not set -> step 1 is next, everything else waits; invalid period -> step 1 is red', () => {
        expect(looks({ rcState: 'unset' })).toEqual(['now', 'todo', 'todo', 'todo', 'todo']);
        expect(looks({ rcState: 'invalid' })).toEqual(['bad', 'todo', 'todo', 'todo', 'todo']);
    });

    it('no model selected -> only the workspace step can be done', () => {
        expect(looks({ hasModel: false })).toEqual(['done', 'todo', 'todo', 'todo', 'todo']);
    });

    it('settings still to fix -> Model settings is the step to do, Train waits', () => {
        expect(looks({ settingsReady: false })).toEqual(['done', 'now', 'todo', 'todo', 'todo']);
    });

    it('never trained -> Train is next', () => {
        expect(looks()).toEqual(['done', 'done', 'now', 'todo', 'todo']);
    });

    it('stale -> Train is next again and the health steps wait (set points are kept, not erased)', () => {
        expect(looks({ trained: true, stale: true })).toEqual(['done', 'done', 'now', 'todo', 'todo']);
    });

    it('trained and fresh -> Health set points is next; known verdicts move it to done / red', () => {
        expect(looks({ trained: true })).toEqual(['done', 'done', 'done', 'now', 'todo']);
        expect(looks({ trained: true, healthValid: true })).toEqual(['done', 'done', 'done', 'done', 'todo']);
        expect(looks({ trained: true, healthValid: false })).toEqual(['done', 'done', 'done', 'bad', 'todo']);
    });

    it('complete -> everything done, whatever the verdict says', () => {
        expect(looks({ trained: true, complete: true, healthValid: false })).toEqual(['done', 'done', 'done', 'done', 'done']);
    });

    it('a model stale AND complete on disk is not Complete (the Complete step needs a fresh fit)', () => {
        expect(looks({ trained: true, stale: true, complete: true })[4]).toBe('todo');
    });
});

describe('WorkbenchStepBar', () => {
    const allDone = Object.fromEntries(STEP_ORDER.map(s => [s.key, 'done'])) as Record<StepKey, StepLook>;

    it('renders the five steps in order, each a button, numbered unless done (tick) or bad (!)', () => {
        const l = { ...allDone, train: 'now', 'health-set-points': 'bad', complete: 'todo' } as Record<StepKey, StepLook>;
        render(<WorkbenchStepBar looks={l} current={[]} onStep={() => {}} />);
        const buttons = within(screen.getByTestId('wb-steps')).getAllByRole('button');
        expect(buttons.map(b => b.textContent)).toEqual(['Running condition', 'Model settings', '3Train', '!Health set points', '5Complete']);
        expect(screen.getByTestId('wb-step-running-condition').querySelector('.wb2-sn svg')).not.toBeNull();
    });

    it('every step reports its key when clicked', () => {
        const onStep = vi.fn();
        render(<WorkbenchStepBar looks={allDone} current={[]} onStep={onStep} />);
        for (const { key } of STEP_ORDER) fireEvent.click(screen.getByTestId(`wb-step-${key}`));
        expect(onStep.mock.calls.map(c => c[0])).toEqual(STEP_ORDER.map(s => s.key));
    });

    it('a disabled step cannot be clicked and explains why; the current steps are highlighted', () => {
        const onStep = vi.fn();
        render(
            <WorkbenchStepBar
                looks={allDone}
                current={['model-settings', 'train']}
                disabled={{ 'health-set-points': true }}
                disabledTitle={{ 'health-set-points': 'Re-train first' }}
                onStep={onStep}
            />,
        );
        const h = screen.getByTestId('wb-step-health-set-points') as HTMLButtonElement;
        expect(h.disabled).toBe(true);
        expect(h.title).toBe('Re-train first');
        fireEvent.click(h);
        expect(onStep).not.toHaveBeenCalled();
        expect(screen.getByTestId('wb-step-model-settings').getAttribute('aria-current')).toBe('step');
        expect(screen.getByTestId('wb-step-train').className).toContain('wb2-stp--cur');
        expect(screen.getByTestId('wb-step-complete').getAttribute('aria-current')).toBeNull();
    });
});

describe('PageSwitch', () => {
    const base = { page: 'model' as const, modelFitDone: false, healthDone: false, healthDisabled: false, onPage: () => {} };

    it('marks the page on screen and shows numbers until a page is done (tick)', () => {
        const { rerender } = render(<PageSwitch {...base} />);
        expect(screen.getByTestId('page-model').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('page-health').getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByTestId('page-model').textContent).toBe('1Model fit');
        expect(screen.getByTestId('page-health').textContent).toBe('2Health score');
        rerender(<PageSwitch {...base} modelFitDone healthDone />);
        expect(screen.getByTestId('page-model').textContent).toBe('Model fit');
        expect(screen.getByTestId('page-model-done')).toBeTruthy();
        expect(screen.getByTestId('page-health-done')).toBeTruthy();
    });

    it('the second page can be disabled with a reason, and the buttons report the page', () => {
        const onPage = vi.fn();
        const { rerender } = render(<PageSwitch {...base} onPage={onPage} healthDisabled healthDisabledTitle="Re-train first" />);
        const health = screen.getByTestId('page-health') as HTMLButtonElement;
        expect(health.disabled).toBe(true);
        expect(health.title).toBe('Re-train first');
        fireEvent.click(health);
        expect(onPage).not.toHaveBeenCalled();
        rerender(<PageSwitch {...base} onPage={onPage} />);
        fireEvent.click(screen.getByTestId('page-health'));
        fireEvent.click(screen.getByTestId('page-model'));
        expect(onPage.mock.calls.map(c => c[0])).toEqual(['health', 'model']);
    });
});

describe('StaleBanner', () => {
    it('says the model is Incomplete again, that set points are kept, and has a Re-train button', () => {
        const onRetrain = vi.fn();
        render(<StaleBanner onRetrain={onRetrain} />);
        const b = screen.getByTestId('stale-banner');
        expect(b.getAttribute('role')).toBe('status');
        expect(b.textContent).toMatch(/Settings changed — this model is Incomplete again/);
        expect(b.textContent).toMatch(/Your set points are kept/);
        fireEvent.click(screen.getByTestId('stale-retrain'));
        expect(onRetrain).toHaveBeenCalledTimes(1);
    });

    it('while training the button reads "Training…" and is disabled; when blocked it explains why', () => {
        const { rerender } = render(<StaleBanner training onRetrain={() => {}} />);
        expect((screen.getByTestId('stale-retrain') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('stale-retrain').textContent).toBe('Training…');
        rerender(<StaleBanner disabled disabledTitle="Needs condition" onRetrain={() => {}} />);
        expect((screen.getByTestId('stale-retrain') as HTMLButtonElement).title).toBe('Needs condition');
    });
});

describe('ChartCard', () => {
    it('shows title, subtitle, extra controls, the chart and the legend', () => {
        render(
            <ChartCard
                id="a" title="Sensor value over time" sub="°C · running rows" option={{ series: [{}, {}] }}
                extra={<button>extra</button>} legend={<LegendItem color="#10b981" label="±1SD" />}
            />,
        );
        const card = screen.getByTestId('chart-card-a');
        expect(card.textContent).toMatch(/Sensor value over time/);
        expect(card.textContent).toMatch(/°C · running rows/);
        expect(within(card).getByText('extra')).toBeTruthy();
        expect(within(card).getByTestId('echarts-mock').getAttribute('data-series')).toBe('2');
        expect(within(card).getByText('±1SD')).toBeTruthy();
    });

    it('size and full-width variants are class names', () => {
        render(<ChartCard id="b" title="B" size="tall" full option={{}} />);
        expect(screen.getByTestId('chart-card-b').className).toMatch(/wb2-card--tall/);
        expect(screen.getByTestId('chart-card-b').className).toMatch(/wb2-full/);
    });

    it('without an option it shows the empty text instead of a chart', () => {
        render(<ChartCard id="c" title="C" empty="No distribution for this scope" />);
        expect(screen.queryByTestId('echarts-mock')).toBeNull();
        expect(screen.getByText('No distribution for this scope')).toBeTruthy();
    });

    it('a custom render() is called with expanded=false in the card and expanded=true in the overlay', () => {
        const render_ = vi.fn((big: boolean) => <div data-testid="custom">{big ? 'big' : 'small'}</div>);
        render(<ChartCard id="d" title="D" render={render_} />);
        expect(screen.getByTestId('custom').textContent).toBe('small');
        fireEvent.click(screen.getByTestId('chart-expand-d'));
        expect(within(screen.getByTestId('chart-overlay-d')).getByTestId('custom').textContent).toBe('big');
    });

    it('Expand opens a large copy of the same chart; Esc, the backdrop and X close it; clicking the card does not', () => {
        render(<ChartCard id="e" title="E" sub="sub" option={{ series: [{}] }} legend={<span>legend</span>} />);
        expect(screen.queryByTestId('chart-overlay-e')).toBeNull();
        fireEvent.click(screen.getByTestId('chart-expand-e'));
        const ov = screen.getByTestId('chart-overlay-e');
        expect(within(ov).getByTestId('echarts-mock').getAttribute('data-series')).toBe('1');
        expect(within(ov).getByText('legend')).toBeTruthy();
        fireEvent.click(within(ov).getByText('E')); // inside the card: stays open
        expect(screen.getByTestId('chart-overlay-e')).toBeTruthy();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('chart-overlay-e')).toBeNull();
        fireEvent.click(screen.getByTestId('chart-expand-e'));
        fireEvent.click(screen.getByTestId('chart-overlay-e')); // backdrop
        expect(screen.queryByTestId('chart-overlay-e')).toBeNull();
        fireEvent.click(screen.getByTestId('chart-expand-e'));
        fireEvent.click(screen.getByLabelText('Close'));
        expect(screen.queryByTestId('chart-overlay-e')).toBeNull();
    });

    it('stale: both the card and the expanded copy are covered by "Out of date"', () => {
        render(<ChartCard id="f" title="F" option={{}} stale />);
        expect(within(screen.getByTestId('chart-card-f')).getByTestId('chart-outdated').textContent).toMatch(/Out of date/);
        fireEvent.click(screen.getByTestId('chart-expand-f'));
        expect(within(screen.getByTestId('chart-overlay-f')).getByText('Out of date')).toBeTruthy();
    });

    it('not stale: no overlay', () => {
        render(<ChartCard id="g" title="G" option={{}} />);
        expect(screen.queryByTestId('chart-outdated')).toBeNull();
    });
});
