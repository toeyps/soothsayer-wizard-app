import { describe, it, expect } from 'vitest';
import type { CsvFileInfo, CsvLoadProgress, CsvLoadReport } from '../types/dataUpload';
import {
  PROJECT_NAME_MAX,
  alarmLimits,
  baseName,
  computeCoverage,
  countComponents,
  fileReadState,
  findFileInfo,
  formatCount,
  formatFileSize,
  formatInterval,
  formatMissingPercent,
  formatSpan,
  isCsvLoadProgress,
  isDuplicateProjectName,
  matchedFraction,
  progressRank,
  progressStageLabel,
  summarizeReport,
} from '../components/upload/setupHelpers';

const DAY = 86_400_000_000;
const T0 = Date.UTC(2025, 0, 1) * 1000; // 2025-01-01 as epoch micros

const file = (over: Partial<CsvFileInfo> = {}): CsvFileInfo => ({
  name: 'a.csv', size_bytes: 1000, rows: 10,
  start: '2025-01-01 00:00:00', end: '2025-01-11 00:00:00',
  start_micros: T0, end_micros: T0 + 10 * DAY,
  ...over,
});

const prog = (over: Partial<CsvLoadProgress> = {}): CsvLoadProgress => ({
  file_index: 0, file_count: 2, file_name: 'a.csv', stage: 'reading', files_done: 0, ...over,
});

const baseReport: CsvLoadReport = {
  headers: ['timestamp', 's1', 's2'],
  total_rows: 1234,
  columns: [
    { name: 'timestamp', dtype: 'datetime', null_count: 0, valid_count: 1234 },
    { name: 's1', dtype: 'numeric', null_count: 0, valid_count: 1234 },
    { name: 's2', dtype: 'numeric', null_count: 0, valid_count: 1234 },
  ],
  warnings: [],
};

describe('formatFileSize', () => {
  it('uses B / KB / MB / GB with one decimal (1024-based)', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(84.2 * 1024 * 1024)).toBe('84.2 MB');
    expect(formatFileSize(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatFileSize(2 * 1024 ** 3)).toBe('2.0 GB');
  });

  it('carries a value that would round to 1024.0 into the next unit', () => {
    expect(formatFileSize(1024 * 1024 - 1)).toBe('1.0 MB');
  });

  it('returns null for missing / negative / non-finite sizes (nothing invented)', () => {
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(undefined)).toBeNull();
    expect(formatFileSize(-1)).toBeNull();
    expect(formatFileSize(Number.NaN)).toBeNull();
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatInterval', () => {
  it('formats whole minutes, hours and days', () => {
    expect(formatInterval(300)).toBe('5 min');
    expect(formatInterval(60)).toBe('1 min');
    expect(formatInterval(3600)).toBe('1 h');
    expect(formatInterval(7200)).toBe('2 h');
    expect(formatInterval(86400)).toBe('1 d');
  });

  it('keeps sub-minute intervals in seconds', () => {
    expect(formatInterval(30)).toBe('30 s');
    expect(formatInterval(1)).toBe('1 s');
    expect(formatInterval(0.5)).toBe('0.5 s');
    expect(formatInterval(59.99)).toBe('59.99 s');
  });

  it('does not hide an uneven value inside a bigger unit', () => {
    expect(formatInterval(90)).toBe('90 s');
    expect(formatInterval(5400)).toBe('90 min');
    expect(formatInterval(3601)).toBe('1 h');
    expect(formatInterval(100.4)).toBe('100.4 s');
  });

  it('returns null for missing, zero, negative and non-finite intervals', () => {
    for (const v of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatInterval(v as number | null | undefined)).toBeNull();
    }
  });
});

describe('formatMissingPercent', () => {
  it('rounds to one decimal', () => {
    expect(formatMissingPercent(0)).toBe('0.0%');
    expect(formatMissingPercent(0.84)).toBe('0.8%');
    expect(formatMissingPercent(12.345)).toBe('12.3%');
    expect(formatMissingPercent(100)).toBe('100.0%');
  });
  it('shows a tiny positive share as "<0.1%" instead of a misleading 0.0%', () => {
    expect(formatMissingPercent(0.01)).toBe('<0.1%');
  });
  it('clamps out-of-range values and returns null when unknown', () => {
    expect(formatMissingPercent(150)).toBe('100.0%');
    expect(formatMissingPercent(-3)).toBe('0.0%');
    expect(formatMissingPercent(null)).toBeNull();
    expect(formatMissingPercent(undefined)).toBeNull();
    expect(formatMissingPercent(Number.NaN)).toBeNull();
  });
});

describe('formatSpan', () => {
  it('picks a readable unit', () => {
    expect(formatSpan(T0, T0 + 30 * 60_000_000)).toBe('30 min');
    expect(formatSpan(T0, T0 + 6 * 3_600_000_000)).toBe('6 h');
    expect(formatSpan(T0, T0 + 12 * DAY)).toBe('12 d');
    expect(formatSpan(T0, T0 + 548 * DAY)).toBe('18 mo');
    expect(formatSpan(T0, T0 + 1000 * DAY)).toBe('2.7 y');
  });
  it('is null when either end is unknown or the range is reversed', () => {
    expect(formatSpan(null, T0)).toBeNull();
    expect(formatSpan(T0, undefined)).toBeNull();
    expect(formatSpan(T0 + DAY, T0)).toBeNull();
    expect(formatSpan(Number.NaN, T0)).toBeNull();
  });
});

describe('formatCount / baseName', () => {
  it('formats counts and rejects non-numbers', () => {
    expect(formatCount(159264)).toBe((159264).toLocaleString());
    expect(formatCount(null)).toBeNull();
    expect(formatCount(undefined)).toBeNull();
    expect(formatCount(Number.NaN)).toBeNull();
  });
  it('baseName handles both separators', () => {
    expect(baseName('C:\\data\\a.csv')).toBe('a.csv');
    expect(baseName('/x/y/b.csv')).toBe('b.csv');
    expect(baseName('c.csv')).toBe('c.csv');
  });
});

describe('isDuplicateProjectName', () => {
  const existing = [{ name: 'GEG-4 Bearing study' }, { name: '  Cooling water  ' }];
  it('matches case-insensitively and ignores surrounding spaces on both sides', () => {
    expect(isDuplicateProjectName('geg-4 bearing STUDY', existing)).toBe(true);
    expect(isDuplicateProjectName('  GEG-4 Bearing study ', existing)).toBe(true);
    expect(isDuplicateProjectName('cooling water', existing)).toBe(true);
  });
  it('is false for a different name, a partial match and a blank name', () => {
    expect(isDuplicateProjectName('GEG-4', existing)).toBe(false);
    expect(isDuplicateProjectName('Something else', existing)).toBe(false);
    expect(isDuplicateProjectName('   ', existing)).toBe(false);
    expect(isDuplicateProjectName('', [{ name: '' }])).toBe(false);
    expect(isDuplicateProjectName('x', [])).toBe(false);
  });
  it('the name limit is 80', () => {
    expect(PROJECT_NAME_MAX).toBe(80);
  });
});

describe('summarizeReport (null-safe)', () => {
  it('a bare report (none of the Phase R fields) only has rows and sensors', () => {
    const s = summarizeReport(baseReport);
    expect(s.rows).toBe((1234).toLocaleString());
    expect(s.sensors).toBe('2');
    expect(s.periodStart).toBeNull();
    expect(s.periodEnd).toBeNull();
    expect(s.periodSpan).toBeNull();
    expect(s.interval).toBeNull();
    expect(s.missing).toBeNull();
  });

  it('a full report fills every field', () => {
    const s = summarizeReport({
      ...baseReport,
      period_start: '2025-01-01 05:00:00', period_end: '2026-07-08 00:00:00',
      period_start_micros: T0, period_end_micros: T0 + 548 * DAY,
      interval_seconds: 300, missing_percent: 0.84,
    });
    expect(s).toMatchObject({
      periodStart: '2025-01-01 05:00:00', periodEnd: '2026-07-08 00:00:00', periodSpan: '18 mo',
      interval: '5 min', missing: '0.8%',
    });
  });

  it('explicit nulls behave like absent fields; a half-known period shows neither end', () => {
    const s = summarizeReport({
      ...baseReport, period_start: '2025-01-01 05:00:00', period_end: null,
      interval_seconds: null, missing_percent: null,
    });
    expect(s.periodStart).toBeNull();
    expect(s.periodEnd).toBeNull();
    expect(s.interval).toBeNull();
    expect(s.missing).toBeNull();
  });

  it('period without microseconds keeps the dates but has no duration', () => {
    const s = summarizeReport({ ...baseReport, period_start: 'a', period_end: 'b' });
    expect(s.periodStart).toBe('a');
    expect(s.periodSpan).toBeNull();
  });

  it('no output is ever the text "NaN" / "undefined" / "null"', () => {
    const outs = [
      summarizeReport(null), summarizeReport(undefined), summarizeReport(baseReport),
      summarizeReport({ ...baseReport, total_rows: Number.NaN, columns: [], headers: [], interval_seconds: Number.NaN, missing_percent: Number.NaN }),
    ].flatMap((s) => Object.values(s));
    for (const v of outs) {
      if (v === null) continue;
      expect(v).not.toMatch(/NaN|undefined|null/);
    }
  });

  it('falls back to header count when column info is missing', () => {
    expect(summarizeReport({ ...baseReport, columns: [] }).sensors).toBe('2');
    expect(summarizeReport({ ...baseReport, columns: [], headers: [] }).sensors).toBeNull();
  });

  it('null / undefined report is all null', () => {
    expect(Object.values(summarizeReport(null)).every((v) => v === null)).toBe(true);
  });
});

describe('findFileInfo', () => {
  const report: CsvLoadReport = {
    ...baseReport,
    files: [file({ name: 'a.csv', rows: 1 }), file({ name: 'b.csv', rows: 2 })],
  };
  it('matches by position + name, then by name alone', () => {
    expect(findFileInfo(report, '/x/a.csv', 0)?.rows).toBe(1);
    expect(findFileInfo(report, '/x/b.csv', 1)?.rows).toBe(2);
    // selection reordered since the parse
    expect(findFileInfo(report, '/x/b.csv', 0)?.rows).toBe(2);
  });
  it('is undefined for an unknown file or a report without files', () => {
    expect(findFileInfo(report, '/x/c.csv', 0)).toBeUndefined();
    expect(findFileInfo(baseReport, '/x/a.csv', 0)).toBeUndefined();
    expect(findFileInfo(null, '/x/a.csv', 0)).toBeUndefined();
  });
});

describe('computeCoverage (shared time axis geometry)', () => {
  it('is null with no files or no readable time range', () => {
    expect(computeCoverage(null)).toBeNull();
    expect(computeCoverage(undefined)).toBeNull();
    expect(computeCoverage([])).toBeNull();
    expect(computeCoverage([file({ start_micros: null, end_micros: null })])).toBeNull();
    expect(computeCoverage([file({ start_micros: T0, end_micros: null })])).toBeNull();
    expect(computeCoverage([file({ start_micros: T0 + DAY, end_micros: T0 })])).toBeNull(); // reversed
  });

  it('a single file fills the whole axis, with no overlap', () => {
    const c = computeCoverage([file()])!;
    expect(c.lanes).toHaveLength(1);
    expect(c.lanes[0]).toMatchObject({ index: 0, name: 'a.csv', leftPct: 0, widthPct: 100 });
    expect(c.overlaps).toBe(false);
    expect(c.hiddenCount).toBe(0);
    expect(c.minMicros).toBe(T0);
    expect(c.maxMicros).toBe(T0 + 10 * DAY);
  });

  it('places several files on ONE axis and detects overlap', () => {
    const c = computeCoverage([
      file({ name: 'a.csv', start_micros: T0, end_micros: T0 + 100 * DAY }),
      file({ name: 'b.csv', start_micros: T0 + 60 * DAY, end_micros: T0 + 80 * DAY }),
    ])!;
    expect(c.lanes[0]).toMatchObject({ leftPct: 0, widthPct: 100 });
    expect(c.lanes[1].leftPct).toBeCloseTo(60, 5);
    expect(c.lanes[1].widthPct).toBeCloseTo(20, 5);
    expect(c.overlaps).toBe(true);
  });

  it('files that follow each other (or just touch) do not overlap', () => {
    const apart = computeCoverage([
      file({ name: 'a.csv', start_micros: T0, end_micros: T0 + 10 * DAY }),
      file({ name: 'b.csv', start_micros: T0 + 20 * DAY, end_micros: T0 + 30 * DAY }),
    ])!;
    expect(apart.overlaps).toBe(false);
    expect(apart.lanes[1].leftPct).toBeCloseTo((20 / 30) * 100, 5);

    const touching = computeCoverage([
      file({ name: 'a.csv', start_micros: T0, end_micros: T0 + 10 * DAY }),
      file({ name: 'b.csv', start_micros: T0 + 10 * DAY, end_micros: T0 + 20 * DAY }),
    ])!;
    expect(touching.overlaps).toBe(false);
  });

  it('overlap does not depend on the order the files were given', () => {
    const c = computeCoverage([
      file({ name: 'late.csv', start_micros: T0 + 50 * DAY, end_micros: T0 + 90 * DAY }),
      file({ name: 'early.csv', start_micros: T0, end_micros: T0 + 60 * DAY }),
    ])!;
    expect(c.overlaps).toBe(true);
    expect(c.lanes.map((l) => l.name)).toEqual(['late.csv', 'early.csv']); // given order is kept
  });

  it('a tiny file keeps a minimum visible width and stays inside the axis', () => {
    const c = computeCoverage([
      file({ name: 'big.csv', start_micros: T0, end_micros: T0 + 1000 * DAY }),
      file({ name: 'tiny.csv', start_micros: T0 + 1000 * DAY, end_micros: T0 + 1000 * DAY }),
    ])!;
    const tiny = c.lanes[1];
    expect(tiny.widthPct).toBeGreaterThan(0.5);
    expect(tiny.leftPct + tiny.widthPct).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('a single-instant range (all files at one moment) is a full-width bar', () => {
    const c = computeCoverage([file({ start_micros: T0, end_micros: T0 })])!;
    expect(c.lanes[0]).toMatchObject({ leftPct: 0, widthPct: 100 });
    expect(c.ticks).toHaveLength(1);
  });

  it('files without a readable range are left off and counted', () => {
    const c = computeCoverage([file(), file({ name: 'x.csv', start_micros: null, end_micros: null })])!;
    expect(c.lanes).toHaveLength(1);
    expect(c.hiddenCount).toBe(1);
    expect(c.lanes[0].index).toBe(0);
  });

  it('axis labels are dates (and include the time for a range under three days)', () => {
    const wide = computeCoverage([file()])!;
    expect(wide.ticks).toHaveLength(4);
    expect(wide.ticks[0].label).toBe('2025-01-01');
    expect(wide.ticks[3].label).toBe('2025-01-11');
    const narrow = computeCoverage([file({ end_micros: T0 + 2 * 3_600_000_000 })])!;
    expect(narrow.ticks[0].label).toBe('2025-01-01 00:00');
    expect(narrow.ticks[3].label).toBe('2025-01-01 02:00');
  });
});

describe('read progress', () => {
  it('fileReadState follows files_done and the file being read', () => {
    expect(fileReadState(0, null)).toBe('waiting');
    expect(fileReadState(0, prog({ files_done: 0 }))).toBe('reading');
    expect(fileReadState(1, prog({ files_done: 0 }))).toBe('waiting');
    expect(fileReadState(0, prog({ file_index: 1, files_done: 1, file_name: 'b.csv' }))).toBe('done');
    expect(fileReadState(1, prog({ file_index: 1, files_done: 1, file_name: 'b.csv' }))).toBe('reading');
    // finished event for the last file: nothing is "reading" any more
    expect(fileReadState(1, prog({ file_index: 1, files_done: 2 }))).toBe('done');
  });

  it('merging / done mark every file done', () => {
    const merging = prog({ file_index: 2, files_done: 2, stage: 'merging', file_name: '' });
    expect(fileReadState(0, merging)).toBe('done');
    expect(fileReadState(1, merging)).toBe('done');
  });

  it('stage labels', () => {
    expect(progressStageLabel(null)).toBeNull();
    expect(progressStageLabel(prog())).toBe('Reading…');
    expect(progressStageLabel(prog({ stage: 'merging' }))).toBe('Merging…');
    expect(progressStageLabel(prog({ stage: 'done' }))).toBe('Done');
  });

  it('progressRank only goes up as the load advances', () => {
    const a = progressRank(prog({ files_done: 0 }));
    const b = progressRank(prog({ files_done: 1 }));
    const c = progressRank(prog({ files_done: 2, stage: 'merging' }));
    const d = progressRank(prog({ files_done: 2, stage: 'done' }));
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(d);
  });

  it('isCsvLoadProgress rejects malformed payloads', () => {
    expect(isCsvLoadProgress(prog())).toBe(true);
    expect(isCsvLoadProgress(null)).toBe(false);
    expect(isCsvLoadProgress('x')).toBe(false);
    expect(isCsvLoadProgress({ ...prog(), stage: 'weird' })).toBe(false);
    expect(isCsvLoadProgress({ ...prog(), files_done: 'one' })).toBe(false);
    expect(isCsvLoadProgress({ stage: 'reading' })).toBe(false);
  });
});

describe('tag-name helpers', () => {
  it('countComponents: biggest first, blanks as "Uncategorized" only when named components exist', () => {
    const m = (component: string) => ({ tag: component + Math.random(), description: '', unit: '', component });
    expect(countComponents(null)).toEqual([]);
    expect(countComponents([])).toEqual([]);
    expect(countComponents([m(''), m('')])).toEqual([]);
    expect(countComponents([m('Pump'), m('Motor'), m('Pump'), m('')])).toEqual([
      { name: 'Pump', count: 2 },
      { name: 'Motor', count: 1 },
      { name: 'Uncategorized', count: 1 },
    ]);
  });

  it('alarmLimits lists only limits that exist, in LL / L / H / HH order, keeping a real 0', () => {
    expect(alarmLimits({ tag: 't', description: '', unit: '', component: '' })).toEqual([]);
    expect(alarmLimits({ tag: 't', description: '', unit: '', component: '', alarmHH: 90, alarmLL: 0, alarmH: 80 })).toEqual([
      { label: 'LL', value: 0 }, { label: 'H', value: 80 }, { label: 'HH', value: 90 },
    ]);
  });

  it('matchedFraction is a 0-1 share, null with no sensor columns', () => {
    expect(matchedFraction(1, 4)).toBe(0.25);
    expect(matchedFraction(4, 4)).toBe(1);
    expect(matchedFraction(5, 4)).toBe(1);
    expect(matchedFraction(0, 0)).toBeNull();
    expect(matchedFraction(Number.NaN, 4)).toBeNull();
  });
});
