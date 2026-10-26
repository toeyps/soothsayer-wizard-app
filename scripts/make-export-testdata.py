# Generates the Export results test data used by BMW-355.. and workflow WFJ in docs/testing/MANUAL_TEST_PLAN.md.
# Usage: python scripts/make-export-testdata.py C:\WizardTestData\EXP   (standard library only; scripts/make-all-testdata.py runs it for you)
#
# EXP-data.csv  30 days of one pump set, every 10 minutes (2026-01-01 00:00 -> 2026-01-30 23:50), with
#               - tags that a file name cannot hold as is: "FLOW A" (space), "TEMP/1" (slash), "CON" (Windows
#                 device name), "อุณหภูมิ1" (Thai), "VIB.X" (dot — allowed);
#               - a stop 2026-01-10 00:00 -> 2026-01-11 23:50 (KW = 0, SPEED = 0);
#               - 3 timestamps written twice (2026-01-15 10:00 / 10:10 / 10:20) — the SECOND copy has VIB.X = 9.99;
#               - 2 rows with an empty timestamp at the end.
# EXP-tags.csv  tag names: CON has NO component; a description with a comma and quotes; a Thai description.
# EXPECTED.txt  model keys, file names and values each check needs.
#
# Added 2026-10-26 for workflow WFK (the files above are unchanged):
# EXP-numbers.csv / EXP-numbers-tags.csv  10 days (2026-02-01 00:00 -> 2026-02-10 23:50, every 10 minutes) of
#               numbers that are easy to break: long decimals, negatives, very small (0.0000123 and 0.0000015),
#               very large (12345678.9), integers, trailing zeros ("1.50"), values written as 1.5E-05 in the source,
#               a column with empty cells (GAPPY) and a running sensor RUN that is exactly 50 / 49.999 / 50.001 /
#               0 / empty in known windows. EXPECTED.txt gets the exact rows, counts, mean and SD per model.
# EXP-fleet.csv / EXP-fleet-tags.csv  14 days of a bigger machine: 37 sensors in 6 components for a 37-model
#               project (several Failure groups, sensors shared by several models and groups).
import csv, math, os, random, sys
from datetime import datetime, timedelta

out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)
random.seed(11)
STEP = timedelta(minutes=10)
STOP = (datetime(2026, 1, 10), datetime(2026, 1, 12))
DUPS = [datetime(2026, 1, 15, 10, 0), datetime(2026, 1, 15, 10, 10), datetime(2026, 1, 15, 10, 20)]
HEAD = ['TimeStamp', 'KW', 'SPEED', 'FLOW A', 'TEMP/1', 'CON', 'VIB.X', 'อุณหภูมิ1']

def row(t, vib=None):
    h = t.hour + t.minute / 60
    stop = STOP[0] <= t < STOP[1]
    kw = 0.0 if stop else 180 + 25 * math.sin(2 * math.pi * (h - 6) / 24) + random.gauss(0, 3)
    speed = 0.0 if stop else 2950 + random.gauss(0, 5)
    flow = 0.0 if stop else 300 + 0.8 * kw + random.gauss(0, 6)
    temp = 31 + random.gauss(0, 0.6) if stop else 20 + 0.12 * kw + random.gauss(0, 0.5)
    valve = 0.0 if stop else min(100, max(0, 40 + 0.25 * (kw - 180) + random.gauss(0, 8)))
    vx = vib if vib is not None else (0.2 if stop else 2.1 + random.gauss(0, 0.2))
    amb = 30 + 3 * math.sin(2 * math.pi * (h - 9) / 24) + random.gauss(0, 0.5)
    return [t.strftime('%Y-%m-%d %H:%M:%S'), round(kw, 2), round(speed, 1), round(flow, 2), round(temp, 2),
            round(valve, 1), round(vx, 3), round(amb, 2)]

rows = []
t = datetime(2026, 1, 1)
while t <= datetime(2026, 1, 30, 23, 50):
    rows.append(row(t))
    if t in DUPS:
        rows.append(row(t, vib=9.99))   # second copy of the same instant — the export keeps this one
    t += STEP
rows.append([''] + rows[100][1:])
rows.append([''] + rows[200][1:])
with open(os.path.join(out, 'EXP-data.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(HEAD); w.writerows(rows)

TAGS = [
    ['KW', 'Motor power', 'kW', 'Motor M-1', '', '', '250', ''],
    ['SPEED', 'Motor speed', 'rpm', 'Motor M-1', '', '', '', ''],
    ['FLOW A', 'Pump flow, "main" line', 'm3/h', 'Pump P-1', '', '300', '600', ''],
    ['TEMP/1', 'Bearing temperature DE', '°C', 'Pump P-1', '', '20', '70', ''],
    ['CON', 'Valve position', '%', '', '', '', '', ''],
    ['VIB.X', 'Vibration X', 'mm/s', 'Pump P-1', '', '', '4.5', '7.1'],
    ['อุณหภูมิ1', 'อุณหภูมิห้อง', '°C', 'Site', '', '', '40', ''],
]
with open(os.path.join(out, 'EXP-tags.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(['TAG', 'DESCRIPTION', 'UNIT', 'COMPONENT', 'ALARM_LL', 'ALARM_L', 'ALARM_H', 'ALARM_HH']); w.writerows(TAGS)

DEVICES = {'CON', 'PRN', 'AUX', 'NUL'} | {f'COM{i}' for i in range(1, 10)} | {f'LPT{i}' for i in range(1, 10)}
def key_tag(tag):   # same rule as workspace_export.rs sanitize_key_tag
    s = ''.join(c if (c.isascii() and c.isalnum()) or c in '._-' else '_' for c in tag)
    return '_' + s if s.split('.')[0].upper() in DEVICES else s

n = len(rows) - 2
exp = [
    'Export test data — what the checks expect', '',
    f'EXP-data.csv: {len(rows)} lines of data = {n} rows with a timestamp (4,320 instants + 3 written twice) + 2 rows without one.',
    f'Import shows Rows = {len(rows):,} (one file: the repeated instants are NOT merged at import, and the 2 rows without a timestamp stay as rows).',
    'Stop: 2026/01/10 00:00 → 2026/01/11 23:50 (KW = 0, SPEED = 0). Running condition for the tests: KW > 50.',
    'Repeated instants 2026-01-15 10:00 / 10:10 / 10:20: the export keeps the LAST copy → VIB.X = 9.99 on those rows in every CSV that has VIB.X.',
    '', 'Model keys (file names in models/):',
]
# Clustering KW × TEMP/1 is keyed by its Y sensor (spec §2.1), so 'TEMP/1' C.
for tag, kind in [('FLOW A', 'R'), ('TEMP/1', 'I'), ('CON', 'I'), ('VIB.X', 'I'), ('อุณหภูมิ1', 'I'), ('TEMP/1', 'C'), ('TEMP/1', 'R')]:
    exp.append(f'  {tag!r:14} {kind} → {key_tag(tag)}-{kind}1   (a 2nd model of the same tag and kind gets …-{kind}2)')
exp += ['', 'Sensor names in machine_info.json: name = the DESCRIPTION column; "FLOW A" name = Pump flow, "main" line (JSON escapes the quotes).',
        'CON has no component → the confirm step lists it; it is written under component "Uncategorized".']
# ---------------------------------------------------------------------------
# WFK: EXP-numbers.csv — numbers that must come out of the export digit for digit
# ---------------------------------------------------------------------------
from decimal import Decimal
import statistics

def csv_text(x):
    """How the export writes a number: the shortest form that reads back as the same
    number, plain decimals (never 1e-05), no trailing zeros, no thousands separators."""
    s = format(Decimal(repr(float(x))), 'f')
    return s.rstrip('0').rstrip('.') if '.' in s else s

def num(s):
    s = s.strip()
    return float(s) if s else math.nan

N0 = datetime(2026, 2, 1)
NUM_END = datetime(2026, 2, 10, 23, 50)
TRAIN = (datetime(2026, 2, 1), datetime(2026, 2, 6, 23, 50))
SCORE = (datetime(2026, 2, 7), datetime(2026, 2, 10, 23, 50))
CUSTOM = (datetime(2026, 2, 2), datetime(2026, 2, 3, 23, 50))   # INT's own train period, RUN > 90
RUN_AT = [  # (from, to inclusive, RUN text) — the running condition for the tests is RUN > 50
    (datetime(2026, 2, 3, 12, 0), datetime(2026, 2, 3, 13, 50), '50'),       # exactly the value → left out
    (datetime(2026, 2, 3, 14, 0), datetime(2026, 2, 3, 14, 50), '50.001'),   # just above → kept
    (datetime(2026, 2, 4, 0, 0), datetime(2026, 2, 4, 5, 50), '0'),          # stopped → left out
    (datetime(2026, 2, 5, 8, 0), datetime(2026, 2, 5, 8, 50), '49.999'),     # just below → left out
    (datetime(2026, 2, 5, 12, 0), datetime(2026, 2, 5, 12, 50), ''),         # no value → left out
]
GAP = (datetime(2026, 2, 2, 6, 0), datetime(2026, 2, 2, 7, 50))             # GAPPY empty
NUM_HEAD = ['TimeStamp', 'RUN', 'LONGDEC', 'NEG', 'TINY', 'MICRO', 'BIG', 'INT', 'TRAILZ', 'SCI', 'GAPPY']
TRAILZ_CYCLE = ['1.50', '2.00', '3.10', '0.50', '10.0', '7.25']
SCI_CYCLE = ['1.5E-05', '2.5e-5', '3E+02', '4.75E+03']

nrows, i, t = [], 0, N0
while t <= NUM_END:
    run = f'{60 + 40 * (0.5 + 0.5 * math.sin(2 * math.pi * i / 144)):.1f}'
    for a, b, v in RUN_AT:
        if a <= t <= b:
            run = v
    longdec = f'{10 + i % 7}.{(3456789012 + i * 1117) % 10**12:012d}{1 + i % 9}'
    n = 27315 + (i * 13) % 400
    neg = f'-{n // 100}.{n % 100:02d}'
    tiny = f'0.000000{(i // 10) % 9 + 1}' if i % 10 == 0 else f'0.0000{123 + i % 50}'
    micro = f'0.00000{10 + (i * 7) % 10}'
    big = f'{12345600 + (i * 7) % 150}.{(i * 3) % 10}'
    intv = '0' if i % 50 == 0 else ('-7' if i % 77 == 0 else str(1000 + (i * 37) % 200 - 100))
    trail = TRAILZ_CYCLE[i % len(TRAILZ_CYCLE)]
    sci = SCI_CYCLE[i % len(SCI_CYCLE)]
    gappy = '' if GAP[0] <= t <= GAP[1] else f'{20 + (i % 37) * 0.25:.2f}'
    nrows.append([t.strftime('%Y-%m-%d %H:%M:%S'), run, longdec, neg, tiny, micro, big, intv, trail, sci, gappy])
    i += 1
    t += STEP
with open(os.path.join(out, 'EXP-numbers.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(NUM_HEAD); w.writerows(nrows)

COL = {h: k for k, h in enumerate(NUM_HEAD)}
def val(r, tag):
    if tag == 'SPX':   # special sensor: $INT * 2 + $NEG
        return num(r[COL['INT']]) * 2 + num(r[COL['NEG']])
    return num(r[COL[tag]])
def when(r):
    return datetime.strptime(r[0], '%Y-%m-%d %H:%M:%S')

def rows_of(cols, period=TRAIN, above=50.0):
    """The export's row rule: inside the train period, RUN > above, every model column has a value."""
    return [r for r in nrows
            if period[0] <= when(r) <= period[1]
            and val(r, 'RUN') > above            # NaN > 50 is False: no RUN value = left out
            and all(not math.isnan(val(r, c)) for c in cols)]

def nice_limits(vals):
    m, s = statistics.mean(vals), statistics.stdev(vals)
    lo, hi = m - 8 * s, m + 8 * s
    step = Decimal(1).scaleb(math.floor(math.log10(s)))           # a round step near one SD
    lo_d = (Decimal(repr(lo)) / step).to_integral_value(rounding='ROUND_FLOOR') * step
    hi_d = (Decimal(repr(hi)) / step).to_integral_value(rounding='ROUND_CEILING') * step
    return csv_text(lo_d), csv_text(hi_d)

IND = ['LONGDEC', 'NEG', 'TINY', 'MICRO', 'BIG', 'TRAILZ', 'SCI', 'SPX']
limits = {tag: nice_limits([val(r, tag) for r in rows_of([tag])]) for tag in IND + ['INT']}
NUM_TAGS = [
    ['RUN', 'Run indicator', '%', 'Test rig'],
    ['LONGDEC', 'Long decimals', 'bar', 'Test rig'],
    ['NEG', 'Cold box temperature', '°C', 'Test rig'],
    ['TINY', 'Leak rate', 'm3/s', 'Test rig'],
    ['MICRO', 'Micro strain', 'mm', 'Test rig'],
    ['BIG', 'Energy counter', 'kWh', 'Test rig'],
    ['INT', 'Pulse count', 'pcs', 'Test rig'],
    ['TRAILZ', 'Trailing zeros', 'mm/s', 'Test rig'],
    ['SCI', 'Written as 1.5E-05', 'A', 'Test rig'],
    ['GAPPY', 'Flow with gaps', 'm3/h', 'Test rig'],
]
with open(os.path.join(out, 'EXP-numbers-tags.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(['TAG', 'DESCRIPTION', 'UNIT', 'COMPONENT', 'ALARM_LL', 'ALARM_L', 'ALARM_H', 'ALARM_HH'])
    for tag, desc, unit, comp in NUM_TAGS:
        lo, hi = limits.get(tag, ('', ''))
        w.writerow([tag, desc, unit, comp, '', lo, hi, ''])

def sig(x, n=10):
    """n significant digits as plain decimals (never 1e-05)."""
    return csv_text(float(f'{x:.{n}g}'))

def stats_line(tag, rs):
    v = [val(r, tag) for r in rs]
    return (f'  {tag:8} rows {len(rs):>4} · first {rs[0][0]} · last {rs[-1][0]} · '
            f'AVERAGE {sig(statistics.mean(v))} · STDEV.S {sig(statistics.stdev(v))} (the app) · '
            f'STDEV.P {sig(statistics.pstdev(v))} (not the app) · set points L {limits[tag][0]} H {limits[tag][1]}')

train_all = [r for r in nrows if TRAIN[0] <= when(r) <= TRAIN[1]]
score_all = [r for r in nrows if SCORE[0] <= when(r) <= SCORE[1]]
base = rows_of([])
exp += ['', '=' * 100, 'WFK — EXP-numbers.csv (numbers project)', '=' * 100,
        f'EXP-numbers.csv: {len(nrows):,} rows, 2026-02-01 00:00 → 2026-02-10 23:50, every 10 minutes, no repeated or empty timestamps.',
        'Running condition: Machine is running when RUN is above 50.',
        'Train period (workspace): 2026-02-01 00:00 → 2026-02-06 23:50 · Scoring period: 2026-02-07 00:00 → 2026-02-10 23:50.',
        f'Rows in the train period: {len(train_all)} · in the scoring period: {len(score_all)} (none of these may appear in any CSV).',
        'RUN windows inside the train period (rows):']
for a, b, v in RUN_AT:
    k = sum(1 for r in train_all if a <= when(r) <= b)
    exp.append(f'  {a:%Y-%m-%d %H:%M} → {b:%H:%M}  RUN = {v or "(empty)":8} {k:>3} rows → '
               + ('KEPT (above 50)' if v and float(v) > 50 else 'LEFT OUT'))
exp += [f'GAPPY is empty {GAP[0]:%Y-%m-%d %H:%M} → {GAP[1]:%H:%M} ({sum(1 for r in train_all if GAP[0] <= when(r) <= GAP[1])} rows): left out only from models that use GAPPY.',
        f'Running rows of the train period: {len(base)} (= {len(train_all)} − the left-out RUN rows). Smallest RUN kept: '
        f'{csv_text(min(val(r, "RUN") for r in base))}.',
        '', 'Model keys and expected CSV rows (Excel: AVERAGE / STDEV.S of the value column must match the Model fit cards to 3 decimals):']
for tag in IND:
    exp.append(f'  {tag}-I1'.ljust(14) + stats_line(tag, rows_of([tag])).strip())
custom = rows_of(['INT'], CUSTOM, 90.0)
exp.append('  INT-I1'.ljust(14) + stats_line('INT', custom).strip()
           + '   ← Custom: own condition RUN > 90, own train period 2026-02-02 00:00 → 2026-02-03 23:50')
rel = rows_of(['RUN', 'GAPPY', 'LONGDEC'])
exp.append(f'  LONGDEC-R1    rows {len(rel)} · columns TimeStamp,RUN,GAPPY,LONGDEC · smallest RUN {csv_text(min(val(r, "RUN") for r in rel))} · no empty GAPPY cell')
clu = rows_of(['RUN', 'NEG', 'INT'])
low = sum(1 for r in clu if val(r, 'INT') <= 1000)
exp.append(f'  NEG-C1        rows {len(clu)} · columns TimeStamp,RUN,NEG,INT · X = RUN, Y = NEG, criteria INT split at 1000: '
           f'{low} rows with INT <= 1000 (cluster 1) + {len(clu) - low} rows above (cluster 2) · in 0.13.1 and older this file was RUN-C1')
exp += ['', 'Number text: raw text in EXP-numbers.csv → text in the exported CSV (the same number; only trailing zeros and the 1E-05 form go away):']
for c in ['RUN', 'LONGDEC', 'NEG', 'TINY', 'MICRO', 'BIG', 'INT', 'TRAILZ', 'SCI']:
    changed, same = [], []
    for r in base:
        raw = r[COL[c]]
        bucket = changed if raw != csv_text(num(raw)) else same
        if raw not in [x[1] for x in bucket]:
            bucket.append((r[0], raw))
    for when_, raw in changed[:2] + same[:2 - min(len(changed), 1)]:
        exp.append(f'  {c:8} {when_}   {raw:>20} → {csv_text(num(raw))}')
exp += ['', 'Special sensor SPX = $INT * 2 + $NEG (exact values the CSV of SPX-I1 must hold):']
for r in [x for x in base if x[COL['INT']] not in ('0', '-7')][0:300:100]:
    exp.append(f'  {r[0]}   INT {r[COL["INT"]]:>5}  NEG {r[COL["NEG"]]:>8}  →  SPX {csv_text(val(r, "SPX"))}')
noisy = next((r[0], csv_text(val(r, 'SPX')), r) for r in base if len(csv_text(val(r, 'SPX')).replace('-', '').replace('.', '')) > 15)
exp += ['', 'Set points to type: Individual = L / H above (prefilled from EXP-numbers-tags.csv) · LONGDEC-R1: 80 at -6 and 6, 0 at -12 and 12 · NEG-C1: N = 5.',
        f'Excel note: Excel shows at most 15 digits, so SPX {noisy[1]} ({noisy[0]}) reads {sig(val(noisy[2], "SPX"), 15)} in Excel — the same number; Notepad shows every digit.']
exp += ['', 'Set points that land in the model JSON (health.limits low/high): the CSV above uses plain decimals;',
        f'MICRO has L {limits["MICRO"][0]} / H {limits["MICRO"][1]} and TINY L {limits["TINY"][0]} / H {limits["TINY"][1]} — the JSON must keep these digits.']

two = [r for r in rows_of(['NEG']) if val(r, 'GAPPY') > 21]
exp += ['', f'0.12.0 only (WFK-16 part B): running condition RUN > 50 AND GAPPY > 21 → NEG-I1 has {len(two)} rows; '
        f'after the upgrade to 0.13.x the condition becomes RUN is above 50 → {len(rows_of(["NEG"]))} rows.']
vtr = [r for r in rows if r[0] and datetime(2026, 1, 1) <= datetime.strptime(r[0], '%Y-%m-%d %H:%M:%S') <= datetime(2026, 1, 20, 23, 50) and r[1] > 50]
vlast = {}
for r in vtr:
    vlast[r[0]] = r[6]
vt, ve = [r[6] for r in vtr], list(vlast.values())
exp += ['', 'EXP-data.csv, VIB.X Individual (WFK-5): KW > 50, train period 2026-01-01 00:00 → 2026-01-20 23:50:',
        f'  rows Train counts (both copies of the 3 repeated instants): {len(vt)} · mean {sig(statistics.mean(vt))} · SD (STDEV.S) {sig(statistics.stdev(vt))}',
        f'  rows in VIB.X-I1.csv (last copy only): {len(ve)} · AVERAGE {sig(statistics.mean(ve))} · STDEV.S {sig(statistics.stdev(ve))}']

# ---------------------------------------------------------------------------
# WFK: EXP-fleet.csv — a bigger machine for a 37-model project
# ---------------------------------------------------------------------------
rf = random.Random(26)
COMPS = [('MTR', 'Motor M-1', 'Motor'), ('PMP', 'Pump P-1', 'Pump'), ('GBX', 'Gearbox G-1', 'Gearbox'),
         ('BDE', 'Bearing DE', 'Bearing DE'), ('BND', 'Bearing NDE', 'Bearing NDE'), ('CLG', 'Cooling', 'Cooling')]
FL_START, FL_END = datetime(2026, 3, 1), datetime(2026, 3, 14, 23, 50)
FL_STOP = (datetime(2026, 3, 7), datetime(2026, 3, 7, 11, 50))
ftags = ['MAIN_KW'] + [f'{c}_{k:02d}' for c, _, _ in COMPS for k in range(1, 7)]
coef = {tg: (20 + 7 * j, 0.02 + 0.01 * (j % 5), 0.3 + 0.1 * (j % 4)) for j, tg in enumerate(ftags[1:])}
frows, t = [], FL_START
while t <= FL_END:
    stop = FL_STOP[0] <= t <= FL_STOP[1]
    h = t.hour + t.minute / 60
    kw = 0.0 if stop else 300 + 50 * math.sin(2 * math.pi * (h - 6) / 24) + rf.gauss(0, 5)
    line = [t.strftime('%Y-%m-%d %H:%M:%S'), round(kw, 2)]
    for tg in ftags[1:]:
        b, c, s = coef[tg]
        line.append(round((b * 0.6 if stop else b + c * kw) + rf.gauss(0, s), 2))
    frows.append(line)
    t += STEP
with open(os.path.join(out, 'EXP-fleet.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(['TimeStamp'] + ftags); w.writerows(frows)
frun = [r for r in frows if r[1] > 50]
with open(os.path.join(out, 'EXP-fleet-tags.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(['TAG', 'DESCRIPTION', 'UNIT', 'COMPONENT', 'ALARM_LL', 'ALARM_L', 'ALARM_H', 'ALARM_HH'])
    w.writerow(['MAIN_KW', 'Main motor power', 'kW', 'Motor M-1', '', '', '', ''])
    for j, tg in enumerate(ftags[1:]):
        code, comp, word = next(c for c in COMPS if c[0] == tg[:3])
        v = [r[1 + 1 + j] for r in frun]
        m, s = statistics.mean(v), statistics.stdev(v)
        # 'Pump P-1 ' (trailing space) on one row: the export must still list ONE "Pump P-1".
        w.writerow([tg, f'{word} sensor {tg[-2:]}', '°C' if code in ('BDE', 'BND', 'CLG') else 'mm/s',
                    comp + (' ' if tg == 'PMP_06' else ''), '', math.floor(m - 10 * s), math.ceil(m + 10 * s), ''])
ind = [tg for tg in ftags[1:] if tg not in ('CLG_04', 'CLG_05', 'CLG_06')]
exp += ['', '=' * 100, 'WFK — EXP-fleet.csv (37-model project)', '=' * 100,
        f'EXP-fleet.csv: {len(frows):,} rows, 2026-03-01 00:00 → 2026-03-14 23:50, 37 sensors (MAIN_KW + 6 components × 6).',
        f'Stop 2026-03-07 00:00 → 11:50 (MAIN_KW = 0). Running condition MAIN_KW > 50, train period = the whole file → {len(frun)} rows in every CSV.',
        'Models (37):',
        f'  Individual ({len(ind)}): every sensor except MAIN_KW, CLG_04, CLG_05, CLG_06 → <TAG>-I1',
        '  Relation model (2): MTR_03 from MAIN_KW → MTR_03-R1 · PMP_02 from MAIN_KW + MTR_01 → PMP_02-R1',
        '  Clustering (2, one per X sensor): on MAIN_KW, Y GBX_02, 1 cluster → GBX_02-C1 · on BDE_01, Y BND_01, criteria MAIN_KW split at 300 (2 clusters) → BND_01-C1',
        'Failure groups (6): Motor = MTR_01..06 I + MTR_03-R1 (7) · Pump = PMP_01..06 I + PMP_02-R1 (7) · Gearbox = GBX_01..06 I + GBX_02-C1 (7)',
        '  · Bearings = BDE_01..06 I + BND_01..06 I + BND_01-C1 (13) · Cooling = CLG_01..03 I (3) · Overall health = MTR_01-I1, PMP_01-I1, BDE_01-I1 (3, the same models as above)',
        '→ 37 model files pairs (74 files in models\\), "37 models exported", 40 names across failure_groups[].models.',
        '→ machine_info sensors: 34 tags, each once (MAIN_KW once although 4 models + the running status use it; CLG_04..06 NOT listed).',
        '→ BND_01-C1.json: component "Bearing DE" (the X sensor BDE_01), x_sensor BDE_01, y_sensor BND_01, criteria_sensor MAIN_KW.',
        'Set points to type: MTR_03-R1 and PMP_02-R1: 80 at -2 and 2, 0 at -4 and 4 · GBX_02-C1 and BND_01-C1: N = 5 · Individual: prefilled from EXP-fleet-tags.csv.',
        '→ components: 6, each once, in A–Z order: Bearing DE, Bearing NDE, Cooling, Gearbox G-1, Motor M-1, Pump P-1 (PMP_06 is written "Pump P-1 " with a space in the tag file).']
with open(os.path.join(out, 'EXPECTED.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(exp) + '\n')
print(f'wrote EXP-data.csv ({len(rows)} rows), EXP-tags.csv, EXP-numbers.csv ({len(nrows)} rows), EXP-numbers-tags.csv, '
      f'EXP-fleet.csv ({len(frows)} rows), EXP-fleet-tags.csv and EXPECTED.txt to {out}')
