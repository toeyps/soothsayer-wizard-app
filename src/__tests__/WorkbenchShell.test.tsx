import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => <div data-testid="echarts-mock" data-series={props.option?.series?.length ?? 0} />,
}));

import { PageSwitch, StaleBanner, StateBoard, TrainSensorLink, WorkbenchScroll } from '../components/windows/workbench/WorkbenchShellParts';
import ChartCard, { LegendItem } from '../components/windows/workbench/ChartCard';
import { SensorPickerSingle } from '../components/sensor/SensorPicker';

afterEach(cleanup);

// workbench-redesign SPEC §1: chart-less states use ONE board shape; their actions are text links.
describe('StateBoard + TrainSensorLink', () => {
    it('a title, one sentence and an optional mono line; never a button of its own', () => {
        render(<StateBoard testId="b" title="Not trained yet" text="Train it first." detail="Individual · ≈ 1 s" />);
        const b = screen.getByTestId('b');
        expect(b.className).toBe('bmw-stage-empty wbx-msg');
        expect(b.querySelector('.wbx-msg-t')!.textContent).toBe('Not trained yet');
        expect(b.querySelector('.wbx-msg-s')!.textContent).toBe('Train it first.');
        expect(b.querySelector('.wbx-msg-d')!.textContent).toBe('Individual · ≈ 1 s');
        expect(b.querySelector('button')).toBeNull();
        expect(b.querySelector('.pm-spin')).toBeNull();
    });

    it('tones: "bad" is red, "run" carries the spinner; the sentence and the mono line are optional; an extra class is kept', () => {
        const { rerender } = render(<StateBoard testId="b" tone="bad" title="Training failed" />);
        expect(screen.getByTestId('b').className).toBe('bmw-stage-empty wbx-msg wbx-msg--bad');
        expect(screen.getByTestId('b').querySelector('.wbx-msg-s')).toBeNull();
        expect(screen.getByTestId('b').querySelector('.wbx-msg-d')).toBeNull();
        rerender(<StateBoard testId="b" tone="run" title="Loading the Relation model…" className="hs-full" />);
        expect(screen.getByTestId('b').className).toBe('bmw-stage-empty wbx-msg wbx-msg--run hs-full');
        expect(screen.getByTestId('b').querySelector('.wbx-msg-t .pm-spin')).not.toBeNull();
    });

    it('"Train sensor ↑" is a text link that only asks to be taken there', () => {
        const go = vi.fn();
        render(<StateBoard testId="b" title="Fit no longer in memory" text={<>Re-train it with <TrainSensorLink testId="go" onClick={go} />.</>} />);
        const link = screen.getByTestId('go');
        expect(link.tagName).toBe('BUTTON');
        expect(link.getAttribute('type')).toBe('button');
        expect(link.className).toBe('tq-inline-link');
        expect(link.textContent).toBe('Train sensor ↑');
        expect(screen.getByTestId('b').querySelector('.wbx-msg-s')!.textContent).toBe('Re-train it with Train sensor ↑.');
        fireEvent.click(link);
        expect(go).toHaveBeenCalledTimes(1);
    });
});

describe('PageSwitch', () => {
    const base = { page: 'model' as const, healthDisabled: false, onPage: () => {} };

    // Workbench redesign §1: a plain segmented control — it says where you are, with
    // no step numbers and no ticks (a model's status is said once, in the footer).
    it('marks the page on screen; the two buttons carry their name only — no numbers, no ticks', () => {
        const { rerender } = render(<PageSwitch {...base} />);
        expect(screen.getByTestId('page-model').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('page-health').getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByTestId('page-model').className).toContain('wb2-pg--on');
        for (const page of ['model', 'health'] as const) {
            rerender(<PageSwitch {...base} page={page} />);
            expect(screen.getByTestId('page-model').textContent).toBe('Model fit');
            expect(screen.getByTestId('page-health').textContent).toBe('Health score');
            const sw = screen.getByTestId('page-switch');
            expect(sw.querySelector('svg')).toBeNull();
            expect(sw.querySelector('b')).toBeNull();
            expect(sw.textContent).not.toMatch(/[0-9✓]/);
            expect(screen.queryByTestId('page-model-done')).toBeNull();
            expect(screen.queryByTestId('page-health-done')).toBeNull();
        }
        expect(screen.getByTestId('page-health').getAttribute('aria-pressed')).toBe('true');
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

describe('WorkbenchScroll', () => {
    it('goes back to the top when the page or the kind tab changes (a new resetKey) — and only then; the children are not remounted', () => {
        let mounts = 0;
        const Child = () => { useEffect(() => { mounts += 1; }, []); return <div data-testid="child">charts</div>; };
        const { rerender } = render(<WorkbenchScroll resetKey="m1:model" page="model"><Child /></WorkbenchScroll>);
        const el = screen.getByTestId('wb-scroll');
        expect(el.className).toBe('wb2-scroll');
        expect(el.getAttribute('data-page')).toBe('model');
        el.scrollTop = 240;
        // an ordinary re-render (same model, same page) keeps the user's place
        rerender(<WorkbenchScroll resetKey="m1:model" page="model"><Child /></WorkbenchScroll>);
        expect(el.scrollTop).toBe(240);
        // the page changed
        rerender(<WorkbenchScroll resetKey="m1:health" page="health"><Child /></WorkbenchScroll>);
        expect(screen.getByTestId('wb-scroll')).toBe(el);
        expect(el.scrollTop).toBe(0);
        expect(el.getAttribute('data-page')).toBe('health');
        // the kind tab changed
        el.scrollTop = 90;
        rerender(<WorkbenchScroll resetKey="m2:health" page="health"><Child /></WorkbenchScroll>);
        expect(el.scrollTop).toBe(0);
        expect(mounts).toBe(1);
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
        // One filled button on screen: this one is a ghost (the header's Train sensor is the filled one).
        expect(screen.getByTestId('stale-retrain').className).not.toContain('rcx-btn--pri');
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

    it('while the model waits in a training run the button reads "Queued" and is disabled (customer items 8 + 9)', () => {
        const onRetrain = vi.fn();
        render(<StaleBanner queued onRetrain={onRetrain} />);
        const btn = screen.getByTestId('stale-retrain') as HTMLButtonElement;
        expect(btn.textContent).toBe('Queued');
        expect(btn.disabled).toBe(true);
        fireEvent.click(btn);
        expect(onRetrain).not.toHaveBeenCalled();
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

    it('an Esc that reaches the document while a sensor picker is open inside the expanded chart closes only the picker', () => {
        const render_ = (big: boolean) => (big ? <SensorPickerSingle sensors={['A', 'B']} value="A" onSelect={vi.fn()} ariaLabel="X sensor" /> : <div />);
        render(<ChartCard id="p" title="P" render={render_} />);
        fireEvent.click(screen.getByTestId('chart-expand-p'));
        fireEvent.click(screen.getByRole('button', { name: 'X sensor' }));
        expect(document.querySelector('.pk-pop')).not.toBeNull();
        fireEvent.keyDown(document.body, { key: 'Escape' }); // focus outside the picker's search box
        expect(document.querySelector('.pk-pop')).toBeNull();
        expect(screen.getByTestId('chart-overlay-p')).toBeTruthy();
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(screen.queryByTestId('chart-overlay-p')).toBeNull();
        document.getElementById('wizard-portal-root')?.remove();
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
