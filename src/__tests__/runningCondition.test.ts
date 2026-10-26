import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../types';
import {
    effectiveRunningCondition, isCompleteCondition, isRunningConditionConfigured,
    isWorkspaceRunningConditionConfigured, getBuildBlockReason,
    markCompleteBlockReason, runningConditionApplyBlock, seedCustomFromWorkspace,
    NO_TRAIN_PERIOD_REASON, NO_TRAIN_PERIOD_REASON_CUSTOM, NO_TEST_PERIOD_REASON, NO_TEST_PERIOD_REASON_CUSTOM,
    ADD_TRAIN_PERIOD_HINT, NO_RUNNING_CONDITION_REASON, CATEGORY_BLOCK_REASON,
    getBuildBlock, customBlockText, customSummaryText, NO_TRAIN_PERIOD_EMPTY_TEXT, noScoringPeriodNote, CUSTOM_PANEL_FOOTNOTE,
} from '../utils/runningCondition';
import { mk } from './helpers/failureModelFixture';
import { LEGACY_TESTS } from './helpers/trainTestFixture';

const f = (over: Partial<WorkspaceSensorFilter> = {}): WorkspaceSensorFilter => ({
    id: 'f', sensor: 'S1', operation: 'greater_than', value1: '10', value2: '', ...over,
});
const fg = (over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({ groups: [], models: [], ...over });
const TRAIN: TimePeriod[] = [{ id: 'tr', start: '2025-01-01T00:00', end: '2025-03-31T23:59' }];
/** A scoring period: start → end only. */
const tp = (over: Partial<TestPeriod> = {}): TestPeriod => ({ id: 't', start: '2025-04-01T00:00', end: '2025-04-30T23:59', ...over });

describe('isCompleteCondition', () => {
    it('needs a sensor and value1', () => {
        expect(isCompleteCondition(f())).toBe(true);
        expect(isCompleteCondition(f({ sensor: '' }))).toBe(false);
        expect(isCompleteCondition(f({ sensor: '  ' }))).toBe(false);
        expect(isCompleteCondition(f({ value1: '' }))).toBe(false);
        expect(isCompleteCondition(f({ value1: '  ' }))).toBe(false);
    });
    it('between also needs value2', () => {
        expect(isCompleteCondition(f({ operation: 'between', value2: '' }))).toBe(false);
        expect(isCompleteCondition(f({ operation: 'between', value2: '20' }))).toBe(true);
    });
    it('when headers are given the sensor must exist (case-insensitive); without headers no check', () => {
        expect(isCompleteCondition(f({ sensor: 'gone' }), ['S1', 'S2'])).toBe(false);
        expect(isCompleteCondition(f({ sensor: 's1' }), ['S1'])).toBe(true);
        expect(isCompleteCondition(f({ sensor: 'gone' }))).toBe(true);
    });
});

describe('effectiveRunningCondition', () => {
    it('workspace mode reads the workspace slice with defaults', () => {
        const e = effectiveRunningCondition(mk({ id: 'a' }), fg());
        expect(e).toEqual({ mode: 'workspace', filters: [], combine: 'and', noneConfirmed: false, periods: [], testPeriods: [] });
        expect(effectiveRunningCondition(mk({ id: 'a' }), null).mode).toBe('workspace');
    });
    it('custom mode ignores the workspace entirely', () => {
        const m = mk({ id: 'a', runningConditionMode: 'custom', customRunningConditionFilters: [f({ id: 'c' })], customRunningConditionCombine: 'or', customRunningConditionNoneConfirmed: true, filterTimePeriods: [{ id: 'p', start: '', end: '' }] });
        const e = effectiveRunningCondition(m, fg({ runningConditionFilters: [f({ id: 'w' })], runningConditionCombine: 'and', runningConditionTimePeriods: [] }));
        expect(e.filters[0].id).toBe('c');
        expect(e.combine).toBe('or');
        expect(e.noneConfirmed).toBe(true);
        expect(e.periods).toHaveLength(1);
    });
    it('scoring periods: workspace list in workspace mode, the model own customTestPeriods in custom mode; missing lists read as []', () => {
        const ws = [tp({ id: 'w' })];
        const own = [tp({ id: 'c', start: '2025-06-01T00:00', end: '2025-06-30T23:59' })];
        expect(effectiveRunningCondition(mk({ id: 'a', customTestPeriods: own }), fg({ runningConditionTestPeriods: ws })).testPeriods).toEqual(ws);
        expect(effectiveRunningCondition(mk({ id: 'a', runningConditionMode: 'custom', customTestPeriods: own }), fg({ runningConditionTestPeriods: ws })).testPeriods).toEqual(own);
        // Old workspaces / models without the fields load unchanged and read as "no scoring period".
        expect(effectiveRunningCondition(mk({ id: 'a' }), fg()).testPeriods).toEqual([]);
        expect(effectiveRunningCondition(mk({ id: 'a', runningConditionMode: 'custom' }), fg({ runningConditionTestPeriods: ws })).testPeriods).toEqual([]);
    });
    it('reads the workspace periods in workspace mode and the model own periods in custom mode; a missing list reads as []', () => {
        const ws = [{ id: 'w', start: '2025-01-01T00:00', end: '2025-01-31T23:59' }];
        const own = [{ id: 'c', start: '2025-03-01T00:00', end: '2025-03-31T23:59' }];
        expect(effectiveRunningCondition(mk({ id: 'a', filterTimePeriods: own }), fg({ runningConditionTimePeriods: ws })).periods).toEqual(ws);
        expect(effectiveRunningCondition(mk({ id: 'a', runningConditionMode: 'custom', filterTimePeriods: own }), fg({ runningConditionTimePeriods: ws })).periods).toEqual(own);
        expect(effectiveRunningCondition(mk({ id: 'a' }), fg()).periods).toEqual([]);
    });
});

describe('configured rules', () => {
    it('unconfigured by default; a complete row configures; an incomplete row does not', () => {
        expect(isWorkspaceRunningConditionConfigured(fg())).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(null)).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionFilters: [f({ value1: '' })] }))).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionFilters: [f()] }))).toBe(true);
    });
    it('ONE "sensor > value" row is required (2026-10-26): an old "Use all rows" (noneConfirmed) no longer configures, nor does a non-"above" row', () => {
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionNoneConfirmed: true }))).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionFilters: [f({ operation: 'less_than' })] }))).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionFilters: [f({ operation: 'between', value2: '20' })] }))).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionFilters: [f({ operation: 'equals' })] }))).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionNoneConfirmed: true, runningConditionFilters: [f()] }))).toBe(true);
    });
    it('time periods alone never count', () => {
        const s = fg({ runningConditionTimePeriods: [{ id: 'p', start: '2025-01-01T00:00', end: '2025-02-01T00:00' }] });
        expect(isWorkspaceRunningConditionConfigured(s)).toBe(false);
        expect(isRunningConditionConfigured(mk({ id: 'a' }), s)).toBe(false);
    });
    it('a row on a sensor missing from headers does not count when headers are passed', () => {
        const s = fg({ runningConditionFilters: [f({ sensor: 'deleted' })] });
        expect(isRunningConditionConfigured(mk({ id: 'a' }), s, ['S1'])).toBe(false);
        expect(isRunningConditionConfigured(mk({ id: 'a' }), s)).toBe(true);
    });
    it('Custom is judged by its own condition, independent of the workspace', () => {
        const custom = mk({ id: 'a', runningConditionMode: 'custom' });
        expect(isRunningConditionConfigured(custom, fg({ runningConditionFilters: [f()] }))).toBe(false);
        expect(isRunningConditionConfigured({ ...custom, customRunningConditionNoneConfirmed: true }, fg())).toBe(false);
        expect(isRunningConditionConfigured({ ...custom, customRunningConditionFilters: [f()] }, fg())).toBe(true);
        expect(isRunningConditionConfigured({ ...custom, customRunningConditionFilters: [f({ operation: 'less_than' })] }, fg())).toBe(false);
    });
});

describe('getBuildBlockReason', () => {
    const okFg = fg({ runningConditionFilters: [f()], runningConditionTimePeriods: TRAIN });
    it('null when category, condition and train periods are all fine', () => {
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), okFg)).toBeNull();
    });
    it('Train/Test SPEC rule 1: no train period blocks Train (the old "no period = whole dataset" default is gone)', () => {
        const noTrain = fg({ runningConditionFilters: [f()] });
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), noTrain)).toBe(NO_TRAIN_PERIOD_REASON);
        expect(NO_TRAIN_PERIOD_REASON).toMatch(/Add a train period/);
        expect(NO_TRAIN_PERIOD_REASON).toMatch(/Running condition/);
    });
    it('Custom mode: its OWN train periods count, and the reason points to Model settings', () => {
        const custom = mk({ id: 'a', targetSensor: 'T', category: 'condition', runningConditionMode: 'custom', customRunningConditionFilters: [f()] });
        // Workspace train periods do not rescue a Custom model.
        expect(getBuildBlockReason(custom, okFg)).toBe(NO_TRAIN_PERIOD_REASON_CUSTOM);
        expect(NO_TRAIN_PERIOD_REASON_CUSTOM).toMatch(/Model settings/);
        expect(getBuildBlockReason({ ...custom, filterTimePeriods: TRAIN }, fg())).toBeNull();
    });
    it('a period open at both ends is an explicit train period (counts)', () => {
        const open = fg({ runningConditionFilters: [f()], runningConditionTimePeriods: [{ id: 'o', start: '', end: '' }] });
        expect(getBuildBlockReason(mk({ id: 'a', category: 'condition' }), open)).toBeNull();
    });
    it('Train does NOT need a scoring period', () => {
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), { ...okFg, runningConditionTestPeriods: [] })).toBeNull();
    });
    it('category comes first (precedence category -> condition -> period)', () => {
        const badPeriods = fg({ runningConditionTimePeriods: [{ id: 'p', start: '2025-02-01T00:00', end: '2025-01-01T00:00' }] });
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T' }), badPeriods)).toMatch(/category/i);
    });
    it('a model inherits category from a sibling of the same sensor in fg.models', () => {
        const sibling = mk({ id: 'i', targetSensor: 'T', category: 'condition' });
        const m = mk({ id: 'r', kind: 'relationship', targetSensor: 'T' });
        expect(getBuildBlockReason(m, { ...okFg, models: [sibling, m] })).toBeNull();
    });
    it('running condition second', () => {
        const badPeriods = fg({ runningConditionTimePeriods: [{ id: 'p', start: '2025-02-01T00:00', end: '2025-01-01T00:00' }] });
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), badPeriods)).toMatch(/running condition/i);
    });
    it('invalid period last, reporting its own reason', () => {
        const s = fg({ runningConditionFilters: [f()], runningConditionTimePeriods: [{ id: 'p', start: '2025-02-01T00:00', end: '2025-01-01T00:00' }] });
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), s)).toBe('P1 ends before it starts.');
    });
    it('gate copy: the running-condition reason names the one sensor + value and never says "Step 1"', () => {
        expect(NO_RUNNING_CONDITION_REASON).toBe('Set the running condition first — the sensor that shows the machine is running, and the value above which it runs');
        expect(NO_RUNNING_CONDITION_REASON).not.toMatch(/Use all rows/);
        expect(getBuildBlockReason(mk({ id: 'a', category: 'condition' }), fg())).toBe(NO_RUNNING_CONDITION_REASON);
        for (const t of [NO_RUNNING_CONDITION_REASON, NO_TRAIN_PERIOD_REASON, NO_TRAIN_PERIOD_REASON_CUSTOM, CATEGORY_BLOCK_REASON]) expect(t).not.toMatch(/Step\s*1/i);
    });
    it('null / undefined fg is handled', () => {
        expect(getBuildBlockReason(mk({ id: 'a', category: 'condition' }), null)).toMatch(/running condition/i);
        expect(getBuildBlockReason(mk({ id: 'a' }), undefined)).toMatch(/category/i);
    });
});

describe('getBuildBlock - the gate as data (which blocker, which period)', () => {
    const TR = { id: 'ok', start: '2025-01-01T00:00', end: '2025-01-31T23:59' };
    const BAD = { id: 'bad', start: '2025-05-11T00:00', end: '2025-05-01T00:00' };
    const ws = mk({ id: 'a', targetSensor: 'T', category: 'condition' });
    const custom = mk({ id: 'c', targetSensor: 'T', category: 'condition', runningConditionMode: 'custom', customRunningConditionFilters: [f()] });

    it('null when nothing blocks; its reason is always what getBuildBlockReason returns', () => {
        const ok = fg({ runningConditionFilters: [f()], runningConditionTimePeriods: TRAIN });
        expect(getBuildBlock(ws, ok)).toBeNull();
        for (const [m, s] of [[mk({ id: 'x' }), fg()], [ws, fg()], [ws, fg({ runningConditionFilters: [f()] })], [custom, fg()]] as const) {
            expect(getBuildBlock(m, s)?.reason ?? null).toBe(getBuildBlockReason(m, s));
        }
    });
    it('each blocker has its own kind, in gate order, with the model mode', () => {
        expect(getBuildBlock(mk({ id: 'x' }), fg())).toEqual({ kind: 'category', mode: 'workspace', reason: CATEGORY_BLOCK_REASON });
        expect(getBuildBlock(ws, fg())).toEqual({ kind: 'no-condition', mode: 'workspace', reason: NO_RUNNING_CONDITION_REASON });
        expect(getBuildBlock(ws, fg({ runningConditionFilters: [f()] }))).toEqual({ kind: 'no-train', mode: 'workspace', reason: NO_TRAIN_PERIOD_REASON });
        expect(getBuildBlock(custom, fg())).toEqual({ kind: 'no-train', mode: 'custom', reason: NO_TRAIN_PERIOD_REASON_CUSTOM });
    });
    it('an invalid train period says WHICH one (its P-number), what is wrong and the row line', () => {
        expect(getBuildBlock(ws, fg({ runningConditionFilters: [f()], runningConditionTimePeriods: [TR, BAD] }))).toEqual({
            kind: 'invalid-train', mode: 'workspace', reason: 'P2 ends before it starts.', periodNumber: 2, fault: 'ends-before-start',
            rowReason: 'P2 ends before it starts — pick an end after 2025/05/11 00:00',
        });
        expect(getBuildBlock({ ...custom, filterTimePeriods: [BAD] }, fg())).toMatchObject({ kind: 'invalid-train', mode: 'custom', periodNumber: 1 });
    });
});

describe('customBlockText - a model blocked by its OWN running condition (workbench redesign §5)', () => {
    const custom = mk({ id: 'c', targetSensor: 'T', category: 'condition', runningConditionMode: 'custom', customRunningConditionFilters: [f()] });
    const block = (over: Partial<Parameters<typeof mk>[0]> = {}, s = fg()) => getBuildBlock({ ...custom, ...over }, s)!;
    const REV = { id: 'p', start: '2025-05-11T00:00', end: '2025-05-01T00:00' };

    it('settings closed: "Own running condition: P1 ends before it starts. Fix it in Model settings"', () => {
        expect(customBlockText(block({ filterTimePeriods: [REV] }), { settingsOpen: false })).toBe('Own running condition: P1 ends before it starts. Fix it in Model settings');
    });
    it('settings open: "Fix P1\'s end above" — the side follows what is wrong', () => {
        expect(customBlockText(block({ filterTimePeriods: [REV] }), { settingsOpen: true })).toBe("Fix P1's end above");
        const two = [{ id: 'a', start: '2025-01-01T00:00', end: '2025-01-31T23:59' }, { id: 'b', start: '', end: '2025-03-01T00:00' }];
        expect(customBlockText(block({ filterTimePeriods: two }), { settingsOpen: true })).toBe("Fix P2's start above");
        expect(customBlockText(block({ filterTimePeriods: [{ id: 'a', start: '2025-01-01T00:00', end: 'nope' }] }), { settingsOpen: true })).toBe("Fix P1's end above");
    });
    it('no train period / no condition of its own follow the same pattern', () => {
        expect(customBlockText(block(), { settingsOpen: false })).toBe('Own running condition: no train period. Fix it in Model settings');
        expect(customBlockText(block(), { settingsOpen: true })).toBe('Add a train period above');
        const unset = block({ customRunningConditionFilters: [] });
        expect(unset.kind).toBe('no-condition');
        expect(customBlockText(unset, { settingsOpen: false })).toBe('Own running condition: not set. Fix it in Model settings');
        expect(customBlockText(unset, { settingsOpen: true })).toBe('Pick the sensor and the value under “When the machine is running” above');
    });
    it('not about the model own condition -> the plain reason: a missing category, and every block of a Workspace-mode model', () => {
        const noCat = getBuildBlock({ ...custom, category: null }, fg())!;
        expect(customBlockText(noCat, { settingsOpen: true })).toBe(CATEGORY_BLOCK_REASON);
        const wsBlock = getBuildBlock(mk({ id: 'w', category: 'condition' }), fg({ runningConditionFilters: [f()], runningConditionTimePeriods: [REV] }))!;
        expect(customBlockText(wsBlock, { settingsOpen: false })).toBe('P1 ends before it starts.');
        expect(customBlockText(wsBlock, { settingsOpen: true })).toBe('P1 ends before it starts.');
    });
});

describe('Custom panel copy (workbench redesign §5)', () => {
    it('summary line: "Custom · own running condition · 1 train · 0 scoring"', () => {
        expect(customSummaryText({ noneConfirmed: false, conditions: 1, trainPeriods: 1, scoringPeriods: 0 })).toBe('Custom · own running condition · 1 train · 0 scoring');
        expect(customSummaryText({ noneConfirmed: false, conditions: 0, trainPeriods: 0, scoringPeriods: 0 })).toBe('Custom · running condition not set · 0 train · 0 scoring');
        // An old "Use all rows" flag is ignored: it no longer counts as a condition.
        expect(customSummaryText({ noneConfirmed: true, conditions: 0, trainPeriods: 1, scoringPeriods: 1 })).toBe('Custom · running condition not set · 1 train · 1 scoring');
    });
    it('empty states and the panel footnote', () => {
        expect(NO_TRAIN_PERIOD_EMPTY_TEXT).toBe('No train period yet — add at least one');
        expect(noScoringPeriodNote()).toBe('No scoring period yet — you can train and apply now; Mark complete needs at least one.');
        expect(noScoringPeriodNote('save')).toBe('No scoring period yet — you can train and save now; Mark complete needs at least one.');
        expect(CUSTOM_PANEL_FOOTNOTE).toBe('Only this model · the workspace default is untouched · saved with Save changes');
    });
});

describe('markCompleteBlockReason (SPEC rule 2)', () => {
    const m = mk({ id: 'a', category: 'condition' });
    it('needs at least one scoring period - workspace text vs Custom text', () => {
        expect(markCompleteBlockReason(m, fg())).toBe(NO_TEST_PERIOD_REASON);
        expect(markCompleteBlockReason({ ...m, runningConditionMode: 'custom' }, fg({ runningConditionTestPeriods: [tp()] }))).toBe(NO_TEST_PERIOD_REASON_CUSTOM);
        expect(NO_TEST_PERIOD_REASON).toBe('Add a scoring period before marking complete (Running condition → Edit).');
        expect(NO_TEST_PERIOD_REASON_CUSTOM).toBe('Add a scoring period in Model settings → Training data (Custom) before marking complete.');
    });
    it('null with a valid scoring period (Workspace and Custom)', () => {
        expect(markCompleteBlockReason(m, fg({ runningConditionTestPeriods: [tp()] }))).toBeNull();
        expect(markCompleteBlockReason({ ...m, runningConditionMode: 'custom', customTestPeriods: [tp()] }, fg())).toBeNull();
    });
    it('an invalid scoring period blocks it, named S<n>, with where to fix it', () => {
        expect(markCompleteBlockReason(m, fg({ runningConditionTestPeriods: [tp({ end: '' })] }))).toBe('S1 needs an end date. Fix it in Running condition → Edit.');
        expect(markCompleteBlockReason({ ...m, runningConditionMode: 'custom', customTestPeriods: [tp(), tp({ start: '2025-05-02T00:00', end: '2025-05-01T00:00' })] }, fg()))
            .toBe('S2 ends before it starts. Fix it in Model settings → Training data (Custom).');
    });
    it('an old workspace: periods still carrying label / event time are valid — even an event time that used to block (outside the period)', () => {
        expect(markCompleteBlockReason(m, fg({ runningConditionTestPeriods: LEGACY_TESTS }))).toBeNull();
        expect(markCompleteBlockReason(m, fg({ runningConditionTestPeriods: [tp({ label: 'problem', eventTime: '2026-01-01T00:00' })] }))).toBeNull();
        expect(markCompleteBlockReason({ ...m, runningConditionMode: 'custom', customTestPeriods: LEGACY_TESTS }, fg())).toBeNull();
    });
});

describe('runningConditionApplyBlock (Apply of the Running-condition settings)', () => {
    it('no train period blocks Apply with the hint "Add a train period"', () => {
        expect(runningConditionApplyBlock([], [tp()])).toEqual({ kind: 'no-train', reason: ADD_TRAIN_PERIOD_HINT, footer: 'Add a train period' });
        expect(ADD_TRAIN_PERIOD_HINT).toBe('Add a train period');
    });
    it('an invalid train period comes first — kind "invalid-train", with the footer line "Fix P<n> before applying"', () => {
        expect(runningConditionApplyBlock([{ id: 'p', start: '2025-02-01T00:00', end: '2025-01-01T00:00' }]))
            .toEqual({ kind: 'invalid-train', reason: 'P1 ends before it starts.', footer: 'Fix P1 before applying', periodNumber: 1 });
        // the SECOND period is the bad one, and a bad scoring period does not hide it
        const bad2 = runningConditionApplyBlock([TRAIN[0], { id: 'q', start: '2025-06-01T00:00', end: '2025-05-01T00:00' }], [tp({ end: '' })]);
        expect(bad2).toEqual({ kind: 'invalid-train', reason: 'P2 ends before it starts.', footer: 'Fix P2 before applying', periodNumber: 2 });
    });
    it('the footer of a model own (Custom) lists says "saving"', () => {
        expect(runningConditionApplyBlock([{ id: 'p', start: '2025-02-01T00:00', end: '2025-01-01T00:00' }], [], 'saving')?.footer).toBe('Fix P1 before saving');
        expect(runningConditionApplyBlock(TRAIN, [tp(), tp({ end: '' })], 'saving')?.footer).toBe('Fix S2 before saving');
    });
    it('an invalid scoring period blocks; overlap with train does not; no scoring period does not; a legacy event time does not', () => {
        expect(runningConditionApplyBlock(TRAIN, [tp({ start: 'garbage' })]))
            .toEqual({ kind: 'invalid-test', reason: 'S1 has an invalid start date.', footer: 'Fix S1 before applying', periodNumber: 1 });
        // An old workspace's event time outside its period used to block Apply; it is ignored now.
        expect(runningConditionApplyBlock(TRAIN, [tp({ label: 'problem', eventTime: '2024-12-01T00:00' })])).toBeNull();
        expect(runningConditionApplyBlock(TRAIN, LEGACY_TESTS)).toBeNull();
        // Scoring inside train time (may overlap) - fine.
        expect(runningConditionApplyBlock(TRAIN, [tp({ start: '2025-01-01T00:00', end: '2025-12-31T23:59' })])).toBeNull();
        expect(runningConditionApplyBlock(TRAIN, [])).toBeNull();
        expect(runningConditionApplyBlock(TRAIN)).toBeNull();
    });
});

describe('seedCustomFromWorkspace (switch to Custom, SPEC rule 7)', () => {
    let n = 0;
    const ids = { period: () => `np-${++n}`, filter: () => `nf-${++n}` };
    // The workspace list as an OLD workspace holds it (label / event time / highlight caption still on it).
    const ws = { filters: [f({ id: 'w' })], combine: 'or' as const, periods: TRAIN, testPeriods: [tp({ id: 'wt', label: 'problem', eventTime: '2025-04-10T00:00', fromHighlight: 'Bearing' })] };
    it('copies every empty list once, with fresh ids, and says how many', () => {
        n = 0;
        const r = seedCustomFromWorkspace({ customFilters: [], customPeriods: [], customTestPeriods: [] }, ws, ids);
        expect(r.copied).toEqual({ conditions: 1, periods: 1, tests: 1 });
        expect(r.patch.customCombine).toBe('or');
        expect(r.patch.customFilters?.[0]).toMatchObject({ sensor: 'S1' });
        expect(r.patch.customFilters?.[0].id).not.toBe('w');
        expect(r.patch.customPeriods?.[0]).toMatchObject({ start: TRAIN[0].start, end: TRAIN[0].end });
        // The copy is start / end only: the legacy keys are never WRITTEN into the model's own list.
        expect(r.patch.customTestPeriods).toEqual([{ id: expect.stringMatching(/^np-/), start: '2025-04-01T00:00', end: '2025-04-30T23:59' }]);
        expect(Object.keys(r.patch.customTestPeriods![0]).sort()).toEqual(['end', 'id', 'start']);
        expect(r.patch.customTestPeriods?.[0].id).not.toBe('wt');
        // ...and the workspace's own list is not touched (pure).
        expect(ws.testPeriods[0]).toMatchObject({ id: 'wt', label: 'problem', eventTime: '2025-04-10T00:00' });
    });
    it('non-destructive: a list the model already has is never overwritten (switch back and forth)', () => {
        const own = [tp({ id: 'mine' })];
        const r = seedCustomFromWorkspace({ customFilters: [f({ id: 'mf' })], customPeriods: TRAIN, customTestPeriods: own }, ws, ids);
        expect(r.patch).toEqual({});
        expect(r.copied).toEqual({ conditions: 0, periods: 0, tests: 0 });
        // Only the test list empty -> only tests copied.
        const r2 = seedCustomFromWorkspace({ customFilters: [f({ id: 'mf' })], customPeriods: TRAIN, customTestPeriods: [] }, ws, ids);
        expect(Object.keys(r2.patch)).toEqual(['customTestPeriods']);
        expect(r2.copied.tests).toBe(1);
    });
    it('nothing in the workspace -> nothing copied', () => {
        const r = seedCustomFromWorkspace({ customFilters: [], customPeriods: [], customTestPeriods: [] }, { filters: [], combine: 'and', periods: [], testPeriods: [] });
        expect(r.patch).toEqual({});
    });
});
