import { evenTimeTicks, tickPitchPx } from '../../utils/timeAxisTicks';

/** True when the option's (first) X axis is a time axis. */
export function hasTimeXAxis(option: any): boolean {
    const x = Array.isArray(option?.xAxis) ? option.xAxis[0] : option?.xAxis;
    return x?.type === 'time';
}

/**
 * Keep a chart's time axis on evenly spaced ticks (`utils/timeAxisTicks.ts`).
 *
 * The step follows what is VISIBLE — the zoom window and the plot's width — so
 * it is recomputed after every render and zoom; the option is only patched
 * (`axisTick.customValues` / `axisLabel.customValues`) when the step changes or
 * the view leaves the range the last patch covered (one window either side), so
 * hovering and panning inside it cost nothing. Returns the detach function.
 */
export function attachEvenTimeTicks(inst: any): () => void {
    if (!inst?.on || !inst?.getModel) return () => {};
    let lastKey = '';
    let covered: [number, number] | null = null;
    let frame: ReturnType<typeof setTimeout> | null = null;
    let detached = false;

    const apply = () => {
        frame = null;
        if (detached || inst.isDisposed?.()) return;
        const axis = inst.getModel?.()?.getComponent?.('xAxis', 0)?.axis;
        if (!axis || axis.type !== 'time') return;
        const [v0, v1] = axis.scale.getExtent() as [number, number];
        const [p0, p1] = axis.getExtent() as [number, number];
        const px = Math.abs(p1 - p0);
        const span = v1 - v0;
        if (!(px > 0) || !(span > 0)) return;
        const fontSize = Number(axis.model?.get?.(['axisLabel', 'fontSize'])) || 12;
        const from = v0 - span;
        const to = v1 + span;
        let ticks = evenTimeTicks(v0, v1, px / tickPitchPx('d', fontSize), from, to);
        // Below a day the labels carry the time and are wider: choose the step again for them.
        if (ticks.key.startsWith('s')) ticks = evenTimeTicks(v0, v1, px / tickPitchPx('s', fontSize), from, to);
        const applied = (axis.model?.get?.(['axisLabel', 'customValues']) as unknown[] | undefined)?.length;
        if (applied && ticks.key === lastKey && covered && covered[0] <= v0 && covered[1] >= v1) return;
        lastKey = ticks.key;
        covered = [from, to];
        inst.setOption(
            { xAxis: { axisTick: { customValues: ticks.values }, axisLabel: { customValues: ticks.values } } },
            { lazyUpdate: true },
        );
    };
    // Never patch from inside the chart's own update: wait for it to finish.
    const schedule = () => { if (frame === null && !detached) frame = setTimeout(apply, 0); };

    inst.on('finished', schedule);
    inst.on('datazoom', schedule);
    schedule();
    return () => {
        detached = true;
        if (frame !== null) clearTimeout(frame);
        inst.off?.('finished', schedule);
        inst.off?.('datazoom', schedule);
    };
}
