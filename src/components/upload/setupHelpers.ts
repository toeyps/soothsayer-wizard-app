/** Pure helpers for Import steps 1 and 2. Missing or non-finite input gives `null` or an empty list, never made-up values or 'NaN'. */

import type { CsvFileInfo, CsvLoadProgress, CsvLoadReport, MappingResult } from '../../types/dataUpload';
import type { SensorMetadata } from '../../types';
import { formatRowTime, formatWallClock } from '../../utils/dateFormat';

/** Longest project name the Name step accepts (also the counter's denominator). */
export const PROJECT_NAME_MAX = 80;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** File name of a path with either separator. */
export function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}


/** 1024-based file size: "512 B", "84.2 KB", "84.2 MB", "1.5 GB". `null` for a missing / negative / non-finite size. */
export function formatFileSize(bytes: number | null | undefined): string | null {
  if (!isNum(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  // Rounding to 1 decimal can reach 1024.0 -- carry into the next unit instead of printing "1024.0 KB".
  while (unit < units.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Trims "5.0" to "5" and "1.50" to "1.5". */
function trimNumber(n: number, decimals: number): string {
  return String(Number(n.toFixed(decimals)));
}

/** Interval label: 300 -> '5 min', 3600 -> '1 h', 5400 -> '90 min'; null if missing, <= 0 or non-finite. */
export function formatInterval(seconds: number | null | undefined): string | null {
  if (!isNum(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${trimNumber(seconds, 2)} s`;
  const whole = Math.abs(seconds - Math.round(seconds)) < 1e-9;
  if (!whole) return `${trimNumber(seconds, 1)} s`;
  const s = Math.round(seconds);
  if (s % 86400 === 0) return `${s / 86400} d`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  if (s < 3600) return `${s} s`;
  return `${trimNumber(s / 3600, 1)} h`;
}

/** "x.x" of empty cells, one decimal. A positive value that would round to 0.0 reads "<0.1%". `null` when unknown. */
export function formatMissingPercent(p: number | null | undefined): string | null {
  if (!isNum(p)) return null;
  const clamped = Math.min(100, Math.max(0, p));
  if (clamped > 0 && clamped < 0.05) return '<0.1%';
  return `${clamped.toFixed(1)}%`;
}

const DAY_MICROS = 86_400_000_000;

/** Duration label ('6 h', '12 d', '18 mo', '2.5 y'); null if either is missing or end < start. */
export function formatSpan(startMicros: number | null | undefined, endMicros: number | null | undefined): string | null {
  if (!isNum(startMicros) || !isNum(endMicros) || endMicros < startMicros) return null;
  const days = (endMicros - startMicros) / DAY_MICROS;
  if (days < 1) {
    const hours = days * 24;
    if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min`;
    return `${trimNumber(hours, 1)} h`;
  }
  if (days < 60) return `${trimNumber(days, 1)} d`;
  if (days < 730) return `${trimNumber(days / 30.4375, 1)} mo`;
  return `${trimNumber(days / 365.25, 1)} y`;
}

/** Row / count with thousands separators; `null` when not a finite number. */
export function formatCount(n: number | null | undefined): string | null {
  return isNum(n) ? n.toLocaleString() : null;
}



/** Report row time '2024-01-01 00:00:00' shown as '2024/01/01 00:00:00' (no zone shift); other shapes unchanged. */
export function rowTimeText(text: string): string {
  return formatRowTime(text) ?? text;
}

export interface ReportSummary {
  /** Merged row count, formatted ("159,264"). */
  rows: string | null;
  /** Numeric sensor columns (everything except the timestamp). */
  sensors: string | null;
  /** First / last row time in the app's date format ("2024/01/01 00:00:00"). */
  periodStart: string | null;
  periodEnd: string | null;
  /** Duration label ("18 mo"); null when the instants in microseconds are unknown. */
  periodSpan: string | null;
  interval: string | null;
  missing: string | null;
}

/** Display-ready, null-safe summary of a `load_csv` report; any field may be absent. */
export function summarizeReport(report: CsvLoadReport | null | undefined): ReportSummary {
  const empty: ReportSummary = {
    rows: null, sensors: null, periodStart: null, periodEnd: null, periodSpan: null, interval: null, missing: null,
  };
  if (!report) return empty;

  let sensors: number | null = null;
  if (Array.isArray(report.columns) && report.columns.length > 0) {
    sensors = report.columns.filter((c) => c.dtype === 'numeric').length;
  } else if (Array.isArray(report.headers) && report.headers.length > 0) {
    sensors = Math.max(0, report.headers.length - 1);
  }

  const start = typeof report.period_start === 'string' && report.period_start ? report.period_start : null;
  const end = typeof report.period_end === 'string' && report.period_end ? report.period_end : null;
  const hasPeriod = start !== null && end !== null;

  return {
    rows: formatCount(report.total_rows),
    sensors: formatCount(sensors),
    periodStart: hasPeriod ? rowTimeText(start) : null,
    periodEnd: hasPeriod ? rowTimeText(end) : null,
    periodSpan: hasPeriod ? formatSpan(report.period_start_micros, report.period_end_micros) : null,
    interval: formatInterval(report.interval_seconds),
    missing: formatMissingPercent(report.missing_percent),
  };
}

/** Report entry for a path: same position and name first, then any entry with that name; undefined if none. */
export function findFileInfo(
  report: CsvLoadReport | null | undefined,
  path: string,
  index: number,
): CsvFileInfo | undefined {
  const files = report?.files;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const name = baseName(path);
  const atIndex = files[index];
  if (atIndex && atIndex.name === name) return atIndex;
  return files.find((f) => f.name === name);
}


export interface CoverageLane {
  /** Position of the file in the report's `files` array. */
  index: number;
  name: string;
  /** Left edge and width as percentages (0-100) of the shared time axis. */
  leftPct: number;
  widthPct: number;
  /** The file's first / last row time in the app's date format; '' when unknown. */
  start: string;
  end: string;
}

export interface Coverage {
  lanes: CoverageLane[];
  minMicros: number;
  maxMicros: number;
  ticks: { pct: number; label: string }[];
  /** Two or more files cover a common stretch of time. */
  overlaps: boolean;
  /** Files left off the chart because their time range is unknown. */
  hiddenCount: number;
}

const MIN_BAR_PCT = 1.2;

/** Axis tick text; naive timestamps are stored as UTC, so the wall clock is the UTC fields. */
function microsToText(micros: number, withTime: boolean): string {
  const d = new Date(Math.round(micros / 1000));
  if (Number.isNaN(d.getTime())) return '';
  return formatWallClock({
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  }, withTime ? 'minutes' : 'date');
}

/** Time coverage geometry on one shared axis; null if no file has start and end; a single instant gets a minimum-width bar. */
export function computeCoverage(files: CsvFileInfo[] | null | undefined): Coverage | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  const usable = files
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => isNum(f.start_micros) && isNum(f.end_micros) && (f.end_micros as number) >= (f.start_micros as number));
  if (usable.length === 0) return null;

  const minMicros = Math.min(...usable.map(({ f }) => f.start_micros as number));
  const maxMicros = Math.max(...usable.map(({ f }) => f.end_micros as number));
  const span = maxMicros - minMicros;

  const lanes: CoverageLane[] = usable.map(({ f, index }) => {
    const s = f.start_micros as number;
    const e = f.end_micros as number;
    if (span <= 0) {
      return { index, name: f.name, leftPct: 0, widthPct: 100, start: rowTimeText(f.start ?? ''), end: rowTimeText(f.end ?? '') };
    }
    const widthPct = Math.min(100, Math.max(MIN_BAR_PCT, ((e - s) / span) * 100));
    const leftPct = Math.min(100 - widthPct, Math.max(0, ((s - minMicros) / span) * 100));
    return { index, name: f.name, leftPct, widthPct, start: rowTimeText(f.start ?? ''), end: rowTimeText(f.end ?? '') };
  });

  let overlaps = false;
  const byStart = [...usable].sort((a, b) => (a.f.start_micros as number) - (b.f.start_micros as number));
  let reach = -Infinity;
  for (const { f } of byStart) {
    if ((f.start_micros as number) < reach) overlaps = true;
    reach = Math.max(reach, f.end_micros as number);
  }

  const withTime = span > 0 && span < 3 * DAY_MICROS;
  const ticks =
    span <= 0
      ? [{ pct: 0, label: microsToText(minMicros, true) }]
      : [0, 1 / 3, 2 / 3, 1].map((t) => ({ pct: t * 100, label: microsToText(minMicros + span * t, withTime) }));

  return { lanes, minMicros, maxMicros, ticks, overlaps, hiddenCount: files.length - usable.length };
}


export type FileReadState = 'done' | 'reading' | 'waiting';

/** State of the file at `index` (0-based, in the order the paths were sent) given the latest progress event. */
export function fileReadState(index: number, progress: CsvLoadProgress | null | undefined): FileReadState {
  if (!progress || !isNum(progress.files_done)) return 'waiting';
  if (index < progress.files_done) return 'done';
  if (progress.stage === 'reading' && index === progress.file_index) return 'reading';
  return 'waiting';
}

/** "Reading…" / "Merging…" / "Done" for the latest stage; `null` before the first event. */
export function progressStageLabel(progress: CsvLoadProgress | null | undefined): string | null {
  if (!progress) return null;
  switch (progress.stage) {
    case 'reading': return 'Reading…';
    case 'merging': return 'Merging…';
    case 'done': return 'Done';
    default: return null;
  }
}

/** Ordering used to ignore a late, out-of-order event that would move the bar backwards. */
export function progressRank(p: CsvLoadProgress): number {
  const stage = p.stage === 'done' ? 2 : p.stage === 'merging' ? 1 : 0;
  return p.files_done * 3 + stage;
}

/** Structural check of an event payload (a foreign / malformed emit is ignored, never rendered). */
export function isCsvLoadProgress(p: unknown): p is CsvLoadProgress {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    isNum(o.files_done) && isNum(o.file_count) && isNum(o.file_index) &&
    (o.stage === 'reading' || o.stage === 'merging' || o.stage === 'done')
  );
}


export interface ComponentCount {
  name: string;
  count: number;
}

/** Sensors per component, biggest first; 'Uncategorized' is counted only when named components exist too. */
export function countComponents(metadata: SensorMetadata[] | null | undefined): ComponentCount[] {
  if (!Array.isArray(metadata) || metadata.length === 0) return [];
  const counts = new Map<string, number>();
  let blank = 0;
  for (const m of metadata) {
    const c = (m.component ?? '').trim();
    if (!c) blank += 1;
    else counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const list = [...counts.entries()].map(([name, count]) => ({ name, count }));
  if (blank > 0) list.push({ name: 'Uncategorized', count: blank });
  return list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export const ALARM_KEYS = ['alarmLL', 'alarmL', 'alarmH', 'alarmHH'] as const;
export const ALARM_LABELS: Record<(typeof ALARM_KEYS)[number], string> = {
  alarmLL: 'LL', alarmL: 'L', alarmH: 'H', alarmHH: 'HH',
};

/** Alarm limits that exist on a sensor, in LL / L / H / HH order, as {label, value}. */
export function alarmLimits(m: SensorMetadata): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  for (const k of ALARM_KEYS) {
    const v = m[k];
    if (isNum(v)) out.push({ label: ALARM_LABELS[k], value: v });
  }
  return out;
}

/** Share of the dataset's sensor columns that found a name, as a 0-1 fraction; `null` when there are no sensor columns. */
export function matchedFraction(matched: number, total: number): number | null {
  if (!isNum(matched) || !isNum(total) || total <= 0) return null;
  return Math.min(1, Math.max(0, matched / total));
}


/** Why the tag-name file blocks Continue, or null: it must list exactly the data's sensors (same count and tags). */
export function tagFileBlockReason(
  filePath: string | null,
  keyColumn: string | null,
  result: MappingResult | null,
): string | null {
  if (!filePath) return 'Add the tag-name file to continue';
  if (!keyColumn) return 'Pick the tag column of the tag-name file';
  if (!result) return 'Checking the tag-name file…';
  const dataOnly = result.not_in_mapping.length;
  const fileOnly = result.not_in_dataset.length;
  if (dataOnly === 0 && fileOnly === 0) return null;
  const inData = result.matched.length + dataOnly;
  const inFile = result.matched.length + fileOnly;
  return inData === inFile
    ? `Sensors don't match: both have ${inData}, but ${dataOnly} tag${dataOnly === 1 ? ' differs' : 's differ'}`
    : `Sensors don't match: the data has ${inData}, the tag-name file has ${inFile}`;
}
