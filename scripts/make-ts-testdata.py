# Generates the timestamp-format test files used by IMP-89..IMP-99 and workflow WFI in docs/testing/MANUAL_TEST_PLAN.md.
# Usage: python scripts/make-ts-testdata.py C:\WizardTestData\TS   (standard library only; scripts/make-all-testdata.py runs it for you)
#
# formats/  one file per timestamp shape, each covering its OWN day (288 rows, every 5 minutes) so all of
#           them can be imported into ONE project together; EXPECTED.txt lists what each file must give.
# merge/    files for merging checks (two shapes on the same instants, shared sensor columns, a column twice).
# scenario/ six months of one machine in three files / three shapes, for workflow WFI.
import calendar, csv, math, os, sys
from datetime import datetime, timedelta

out = sys.argv[1] if len(sys.argv) > 1 else '.'
FMT, MRG = os.path.join(out, 'formats'), os.path.join(out, 'merge')
os.makedirs(FMT, exist_ok=True); os.makedirs(MRG, exist_ok=True)
STEP = timedelta(minutes=5)
TH_ABBR = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']
TH_FULL = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม']
TH_DIGITS = str.maketrans('0123456789', '๐๑๒๓๔๕๖๗๘๙')

def times(start, n=288):
    return [start + STEP * i for i in range(n)]

def values(t):
    h = t.hour + t.minute / 60
    return [round(60 + 8 * math.sin(2 * math.pi * h / 24), 2), round(3 + 0.4 * math.cos(2 * math.pi * h / 24), 3)]

def write(folder, name, head, rows, bom=False):
    with open(os.path.join(folder, name), 'w', newline='', encoding='utf-8-sig' if bom else 'utf-8') as f:
        c = csv.writer(f); c.writerow(head); c.writerows(rows)

def ampm(t, fmt_date):
    h = t.hour % 12 or 12
    return f"{fmt_date(t)} {h}:{t.minute:02d} {'AM' if t.hour < 12 else 'PM'}"

def excel_serial(t):
    return f"{(t - datetime(1899, 12, 30)).total_seconds() / 86400:.10f}"

# (file, start, formatter, expected warning in the Import page's yellow box)
FILES = [
    ('F01_us_month_day.csv', datetime(2026,3,4,12,0), lambda t: f"{t.month}/{t.day}/{t.year} {t.hour}:{t.minute:02d}",
     'Dates in F01_us_month_day.csv read as month/day/year (…)'),
    ('F02_day_month.csv', datetime(2026,3,13), lambda t: t.strftime('%d/%m/%Y %H:%M'),
     'Dates in F02_day_month.csv read as day/month/year (…)'),
    ('F03_day_month_dots.csv', datetime(2026,3,20), lambda t: f"{t.day}.{t.month}.{t.year} {t:%H:%M:%S}",
     'Dates in F03_day_month_dots.csv read as day/month/year (…)'),
    ('F04_day_month_dash.csv', datetime(2026,3,25), lambda t: f"{t.day}-{t.month}-{t.year} {t:%H:%M}",
     'Dates in F04_day_month_dash.csv read as day/month/year (…)'),
    ('F05_year_slash.csv', datetime(2026,4,1), lambda t: t.strftime('%Y/%m/%d %H:%M:%S'),
     'Dates in F05_year_slash.csv read as year-month-day (…)'),
    ('F06_am_pm.csv', datetime(2026,4,2,12,0), lambda t: ampm(t, lambda d: f"{d.month}/{d.day}/{d.year}"),
     'Dates in F06_am_pm.csv read as month/day/year (…)'),
    ('F07_historian_bom.csv', datetime(2026,4,5), lambda t: ampm(t, lambda d: d.strftime('%d-%b-%y')),
     'Dates in F07_historian_bom.csv read as day-month-year with month names (… 2-digit year read as 20YY)'),
    ('F08_month_name_first.csv', datetime(2026,4,7), lambda t: t.strftime('%b %d, %Y %H:%M'),
     'Dates in F08_month_name_first.csv read as month-day-year with month names (…)'),
    ('F09_weekday_timezone.csv', datetime(2026,4,9), lambda t: t.strftime('%a, %d %b %Y %H:%M:%S +0700'),
     'Dates in F09_weekday_timezone.csv read as day-month-year with month names (…)'),
    ('F10_compact_digits.csv', datetime(2026,4,11), lambda t: t.strftime('%Y%m%d%H%M%S'),
     'Dates in F10_compact_digits.csv read as compact year-month-day digits (…)'),
    ('F11_year_dots.csv', datetime(2026,4,13), lambda t: t.strftime('%Y.%m.%d %H:%M:%S'),
     'Dates in F11_year_dots.csv read as year-month-day (…)'),
    ('F12_iso_compact_time.csv', datetime(2026,4,15), lambda t: t.strftime('%Y-%m-%dT%H%M%S'),
     'Dates in F12_iso_compact_time.csv read as year-month-day (…)'),
    ('F13_iso_z.csv', datetime(2026,4,17), lambda t: t.strftime('%Y-%m-%dT%H:%M:%SZ'),
     '(no line — plain ISO is read as is)'),
    ('F14_thai_short_month.csv', datetime(2026,4,19), lambda t: f"{t.day} {TH_ABBR[t.month-1]} {t.year+543} {t:%H:%M} น.",
     'Dates in F14_thai_short_month.csv read as day-month-year with Thai month names (…) + the Buddhist-era line'),
    ('F15_thai_digits_full_month.csv', datetime(2026,4,21),
     lambda t: f"{t.day} {TH_FULL[t.month-1]} {t.year+543} {t:%H:%M}".translate(TH_DIGITS),
     'Dates in F15_thai_digits_full_month.csv read as day-month-year with Thai month names (…) + the Buddhist-era line'),
    ('F16_excel_serial.csv', datetime(2026,4,23), excel_serial,
     'Times in F16_excel_serial.csv read as Excel serial dates (…)'),
    ('F17_epoch_seconds.csv', datetime(2026,4,25), lambda t: str(calendar.timegm(t.timetuple())),
     'Times in F17_epoch_seconds.csv read as Unix epoch seconds (UTC) (…)'),
    ('F18_epoch_millis.csv', datetime(2026,4,27), lambda t: str(calendar.timegm(t.timetuple()) * 1000),
     'Times in F18_epoch_millis.csv read as Unix epoch milliseconds (UTC) (…)'),
    ('F19_buddhist_leap_day.csv', datetime(2024,2,29), lambda t: f"{t.day}/{t.month}/{t.year+543} {t:%H:%M}",
     'Dates in F19_buddhist_leap_day.csv read as day/month/year (…) + the Buddhist-era note'),
]
expected = ['Timestamp test files — what each must give after Import (step 2 → Parse files → Dashboard)', '',
            'file | first row in the app | last row | rows | yellow-box line', '-' * 100]
for name, start, fmt, warn in FILES:
    ts = times(start)
    head = ['TimeStamp' if 'bom' in name else 'Timestamp', 'TS_TEMP', 'TS_PRESS']
    write(FMT, name, head, [[fmt(t)] + values(t) for t in ts], bom='bom' in name)
    expected.append(f"{name} | {ts[0]:%Y/%m/%d %H:%M:%S} | {ts[-1]:%Y/%m/%d %H:%M:%S} | {len(ts)} | {warn}")

# A single row: both orders fit equally → month/day, flagged as a guess.
write(FMT, 'F20_single_row_guess.csv', ['Timestamp', 'TS_TEMP', 'TS_PRESS'], [['3/4/2026 0:00', 61.0, 3.1]])
expected.append('F20_single_row_guess.csv | 2026/03/04 00:00:00 | same | 1 | Dates in F20_single_row_guess.csv read as month/day/year (…) — could not be told apart from the values; check the dates')
# Day/month AND month/day evidence in one file → every year-last row unreadable.
conflict = [[f"13/5/2026 {h:02d}:00", 60, 3] for h in range(10)] + [[f"5/14/2026 {h:02d}:00", 60, 3] for h in range(10)]
write(FMT, 'F21_conflict.csv', ['Timestamp', 'TS_TEMP', 'TS_PRESS'], conflict)
expected.append('F21_conflict.csv | (no readable date) | - | 20 rows, 0 with a date | Dates in F21_conflict.csv mix day/month/year (13/5/2026) and month/day/year (5/14/2026) — the order cannot be decided, so 20 row(s) with a year-last date could not be read')
# ISO file with 3 rows that are not dates.
bad = [[f"{t:%Y-%m-%d %H:%M:%S}"] + values(t) for t in times(datetime(2026,5,1))]
for i, junk in ((10, 'n/a'), (100, 'error'), (200, '--')):
    bad[i][0] = junk
write(FMT, 'F22_three_bad_rows.csv', ['Timestamp', 'TS_TEMP', 'TS_PRESS'], bad)
expected.append('F22_three_bad_rows.csv | 2026/05/01 00:00:00 | 2026/05/01 23:55:00 | 288 rows, 285 with a date | 3 timestamp(s) in F22_three_bad_rows.csv could not be read as a date and time')
write(FMT, 'TS-tags.csv', ['TAG','DESCRIPTION','UNIT','COMPONENT','ALARM_LL','ALARM_L','ALARM_H','ALARM_HH'],
      [['TS_TEMP','Test temperature','°C','Test rig','','50','70',''], ['TS_PRESS','Test pressure','bar','Test rig','','2.5','3.5','']], bom=True)
expected += ['', 'All F01..F22 imported together: 5,781 rows (5,758 with a readable date + 23 without), first 2024/02/29 00:00:00, last 2026/05/01 23:55:00;',
             '22 file lines + one Buddhist-era line (864 timestamps) in the yellow box.',
             'No "Duplicate column" line (TS_TEMP / TS_PRESS are in every file). TS-tags.csv starts with a BOM: tags must still match.',
             'F09: +0700 is ignored, wall time kept (00:00 stays 00:00). F17/F18: epoch is UTC (00:00 UTC shows as 00:00).']

# merge/: same 2026-06-01 day written two ways, different sensors → one row per instant.
day = times(datetime(2026,6,1))
write(MRG, 'M1_iso.csv', ['Timestamp', 'FLOW_A'], [[f"{t:%Y-%m-%d %H:%M:%S}", values(t)[0]] for t in day])
write(MRG, 'M1_us_ampm.csv', ['Timestamp', 'FLOW_B'], [[ampm(t, lambda d: f"{d.month}/{d.day}/{d.year}"), values(t)[1]] for t in day])
# Same sensors, next two days, split over two files (normal "one file per period").
write(MRG, 'M2_part1.csv', ['Timestamp', 'FLOW_A', 'FLOW_B'], [[f"{t:%Y-%m-%d %H:%M:%S}"] + values(t) for t in times(datetime(2026,6,2))])
write(MRG, 'M2_part2.csv', ['Timestamp', 'FLOW_A', 'FLOW_B'], [[f"{t:%d/%m/%Y %H:%M}"] + values(t) for t in times(datetime(2026,6,3))])
# One column written twice inside a single file.
write(MRG, 'M3_column_twice.csv', ['Timestamp', 'FLOW_A', 'FLOW_A'], [[f"{t:%Y-%m-%d %H:%M:%S}"] + values(t) for t in times(datetime(2026,6,4))])
expected += ['', 'merge/', 'M1_iso + M1_us_ampm: 288 rows (not 576), FLOW_A and FLOW_B both filled on every row; lines: M1_us_ampm read as month/day/year … check the dates, and 288 duplicate timestamp(s) found across files.',
             'M2_part1 + M2_part2: 576 rows, no "Duplicate column" line. CORRECT = 2026/06/02 → 2026/06/03 23:55. KNOWN 2026-10-19: M2_part2 (every row 03/06/2026 = 3 June) is read as 6 March with a "check the dates" line.',
             "M3_column_twice: CORRECT = a Duplicate column 'flow_a' line. KNOWN 2026-10-19: no line when it is the only file, and two FLOW_A columns are kept."]
# scenario/ (workflow WFI): six months of one machine, exported by three different tools.
#   Jan–Feb from a historian (`01-Jan-25 12:00 AM`, BOM header), Mar–Apr re-saved by a US Excel
#   (`3/1/2025 1:05 PM`), May–Jun from a system writing ISO. Motor stopped 2025-03-10..12 (KW = 0).
import random
random.seed(7)
SCN = os.path.join(out, 'scenario'); os.makedirs(SCN, exist_ok=True)
parts = {'I-1_jan-feb_historian.csv': [], 'I-2_mar-apr_excel.csv': [], 'I-3_may-jun_iso.csv': []}
t = datetime(2025, 1, 1)
while t <= datetime(2025, 6, 30, 23, 55):
    h = t.hour + t.minute / 60
    stop = datetime(2025, 3, 10) <= t < datetime(2025, 3, 13)
    kw = 0.0 if stop else 180 + 20 * math.sin(2 * math.pi * (h - 6) / 24) + random.gauss(0, 3)
    flow = 0.0 if stop else 450 + 0.5 * (kw - 180) + random.gauss(0, 8)
    brg = 34 + random.gauss(0, 1) if stop else 20 + 0.15 * kw + random.gauss(0, 0.8)
    row = [round(kw, 2), round(flow, 2), round(brg, 2)]
    if t.month <= 2:
        parts['I-1_jan-feb_historian.csv'].append([ampm(t, lambda d: d.strftime('%d-%b-%y'))] + row)
    elif t.month <= 4:
        parts['I-2_mar-apr_excel.csv'].append([ampm(t, lambda d: f"{d.month}/{d.day}/{d.year}")] + row)
    else:
        parts['I-3_may-jun_iso.csv'].append([f"{t:%Y-%m-%d %H:%M:%S}"] + row)
    t += STEP
for name, rows in parts.items():
    bom = 'historian' in name
    write(SCN, name, ['TimeStamp' if bom else 'Timestamp', 'M1_KW', 'P1_FLOW', 'BRG_TEMP'], rows, bom=bom)
write(SCN, 'I-tags.csv', ['TAG','DESCRIPTION','UNIT','COMPONENT','ALARM_LL','ALARM_L','ALARM_H','ALARM_HH'], [
    ['M1_KW', 'Motor M-1 power', 'kW', 'Motor M-1', '', '', '250', ''],
    ['P1_FLOW', 'Pump P-1 flow', 'm3/h', 'Pump P-1', '', '300', '600', ''],
    ['BRG_TEMP', 'Pump P-1 bearing temperature', '°C', 'Pump P-1', '', '20', '60', '70']], bom=True)
expected += ['', 'scenario/ (WFI): I-1 + I-2 + I-3 together = 52,128 rows, 2025/01/01 00:00:00 → 2025/06/30 23:55:00, no gap or overlap at',
             '2025/02/28 23:55 → 03/01 00:00 and 2025/04/30 23:55 → 05/01 00:00. Motor stopped 2025/03/10 00:00 → 03/12 23:55.']

with open(os.path.join(out, 'EXPECTED.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(expected) + '\n')
print(f'wrote {len(FILES) + 4} files to {FMT}, 5 files to {MRG}, 4 files to {SCN}, and EXPECTED.txt')
