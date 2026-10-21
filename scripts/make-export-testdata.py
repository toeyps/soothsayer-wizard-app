# Generates the Export results test data used by BMW-355.. and workflow WFJ in docs/testing/MANUAL_TEST_PLAN.md.
# Usage: python scripts/make-export-testdata.py C:\EXPdata   (standard library only)
#
# EXP-data.csv  30 days of one pump set, every 10 minutes (2026-01-01 00:00 -> 2026-01-30 23:50), with
#               - tags that a file name cannot hold as is: "FLOW A" (space), "TEMP/1" (slash), "CON" (Windows
#                 device name), "อุณหภูมิ1" (Thai), "VIB.X" (dot — allowed);
#               - a stop 2026-01-10 00:00 -> 2026-01-11 23:50 (KW = 0, SPEED = 0);
#               - 3 timestamps written twice (2026-01-15 10:00 / 10:10 / 10:20) — the SECOND copy has VIB.X = 9.99;
#               - 2 rows with an empty timestamp at the end.
# EXP-tags.csv  tag names: CON has NO component; a description with a comma and quotes; a Thai description.
# EXPECTED.txt  model keys, file names and values each check needs.
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
for tag, kind in [('FLOW A', 'R'), ('TEMP/1', 'I'), ('CON', 'I'), ('VIB.X', 'I'), ('อุณหภูมิ1', 'I'), ('KW', 'C'), ('TEMP/1', 'R')]:
    exp.append(f'  {tag!r:14} {kind} → {key_tag(tag)}-{kind}1   (a 2nd model of the same tag and kind gets …-{kind}2)')
exp += ['', 'Sensor names in machine_info.json: name = the DESCRIPTION column; "FLOW A" name = Pump flow, "main" line (JSON escapes the quotes).',
        'CON has no component → the confirm step lists it; it is written under component "Uncategorized".']
with open(os.path.join(out, 'EXPECTED.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(exp) + '\n')
print(f'wrote EXP-data.csv ({len(rows)} rows), EXP-tags.csv and EXPECTED.txt to {out}')
