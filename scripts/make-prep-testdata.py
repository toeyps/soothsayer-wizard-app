# Generates the PREP-6 test kit (and the files of PREP-5 / MULTI, WFE, WFF, WFG, PERF) used by
# docs/testing/MANUAL_TEST_PLAN.md. Which item uses which file: docs/testing/TEST_DATA_GUIDE.md.
#
# Usage (standard library only):
#   python scripts/make-all-testdata.py                    # the usual way: every test-data folder under C:\WizardTestData
#   python scripts/make-prep-testdata.py C:\WizardTestData\IMP                          # this kit alone, small files (~25 MB)
#   python scripts/make-prep-testdata.py C:\WizardTestData\IMP --expdata C:\WizardTestData\EXP
#                                                          # + copies of EXP-data.csv with a column added / removed
#   python scripts/make-prep-testdata.py C:\WizardTestData\IMP --big                    # + the big files (about 8.5 GB
#                                                          #   of free disk, roughly 3-10 minutes on an SSD; see EXPECTED.txt)
#
# Folders written (every file is listed with its real numbers in <out>\EXPECTED.txt):
#   normal/      a normal 30-day file + its tag names, a long-file-name copy, an Excel "CSV UTF-8" copy
#   multi-file/  overlapping / adjacent / same-column pairs, a file B with extra columns, a 3-file set with a bad file
#   tags/        tag-name files: other header names, description+name, a tag twice, a broken row, 0 byte, wide
#   buddhist/    Buddhist-year file 2567-02-28 -> 2567-03-01 (has 29 Feb 2567)
#   odd/         text in number cells, empty cells, empty / repeated time, a column twice, Timestamp / TIME / column 3
#   broken/      Date / DateTime header, 0 byte, header only, extra comma on line 50, semicolons, a real .xlsx renamed
#   time-shapes/ one file per time shape (IMP-66), Excel-style dates (IMP-87), historian look-alike 2025/2026 (IMP-88)
#   intervals/   10 s / 90 s / 90 min / 1 h / 1 d files (IMP-36 Interval card)
#   wide/        220 sensors + tag names with 215 names (IMP-78)
#   variants/    copies of the normal file with a column removed / a day added / 10 days only, and changed tag names
#   projects/    GEG-3 / GEG-4 gas engines + tag names (English, Thai UTF-8, Thai saved as plain "CSV"), CMP-1 compressor
#   exp-variants/  (only with --expdata) EXP-data.csv with columns "A B" + "A/B", without KW, without FLOW A
#   big/         (only with --big) 300 MB, 1.9 GB, 2.1 GB (over the 2 GB cap), the 2.1 GB file split in two, 3 overlapping
#   wfg/         (only with --big) GEG5_2024.csv + GEG5_2025.csv (2 years, every minute, 120 sensors) + tag names
import csv, io, math, os, random, statistics, sys, time, zipfile
from datetime import datetime, timedelta

args = sys.argv[1:]
BIG = '--big' in args
EXP = None
if '--expdata' in args:
    EXP = args[args.index('--expdata') + 1]
SCALE = 1.0                      # developer-only: --big-scale 0.01 makes tiny "big" files to test the code path
if '--big-scale' in args:
    SCALE = float(args[args.index('--big-scale') + 1])
pos = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] not in ('--expdata', '--big-scale'))]
OUT = pos[0] if pos else '.'
os.makedirs(OUT, exist_ok=True)

MIN5 = timedelta(minutes=5)
REPORT = []          # (folder, file, [item ids], [lines])
GIB = 1024 ** 3


def fmt(t):
    return t.strftime('%Y/%m/%d %H:%M:%S')


def p(*parts):
    path = os.path.join(OUT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def write(rel, head, rows, enc='utf-8', bom=False, delim=',', crlf=False):
    path = p(*rel.split('/'))
    with open(path, 'w', newline='', encoding=('utf-8-sig' if bom and enc == 'utf-8' else enc)) as f:
        w = csv.writer(f, delimiter=delim, lineterminator='\r\n' if crlf else '\n')
        if head is not None:
            w.writerow(head)
        w.writerows(rows)
    return path


def is_text(v):
    if v == '':
        return False
    try:
        float(v)
        return False
    except ValueError:
        return True


def interval_label(sec):
    if sec % 86400 == 0:
        return f'{sec // 86400} d'
    if sec % 3600 == 0:
        return f'{sec // 3600} h'
    if sec % 60 == 0:
        return f'{sec // 60} min'
    return f'{sec} s'


def pct_empty(bad, cells):
    if cells == 0:
        return '-'
    v = 100 * bad / cells
    if bad == 0:
        return '0.0%'
    return '<0.1%' if v < 0.05 else f'{v:.1f}%'


def stats_lines(times, head, rows, time_col=0):
    """Real numbers of a file: data rows, period, interval, empty / text cells per sensor column."""
    out = [f'แถวข้อมูลในไฟล์ (ไม่นับหัวคอลัมน์): {len(rows):,}']
    real = sorted(set(t for t in times if t is not None))
    if real:
        span = real[-1] - real[0]
        out.append(f'ช่วงเวลา (Period): {fmt(real[0])} → {fmt(real[-1])}  (ยาว {span.days} วัน {span.seconds // 3600} ชม.)')
        gaps = [int((b - a).total_seconds()) for a, b in zip(real, real[1:])]
        if gaps:
            out.append(f'ระยะห่าง (Interval, median gap): {interval_label(int(statistics.median(gaps)))}')
        n_empty_t = sum(1 for t in times if t is None)
        n_dup = len([t for t in times if t is not None]) - len(real)
        if n_empty_t or n_dup:
            out.append(f'เวลาไม่ซ้ำกัน {len(real):,} จุด · แถวที่ช่องเวลาว่าง {n_empty_t} · แถวที่เวลาซ้ำกับแถวก่อนหน้า {n_dup}')
    sensors = [i for i in range(len(head)) if i != time_col]
    out.append(f'Sensors (คอลัมน์ตัวเลข ไม่นับคอลัมน์เวลา): {len(sensors)}')
    empty = {head[i]: 0 for i in sensors}
    text = {head[i]: 0 for i in sensors}
    for r in rows:
        for i in sensors:
            v = r[i] if i < len(r) else ''
            v = '' if v is None else str(v)
            if v == '':
                empty[head[i]] += 1
            elif is_text(v):
                text[head[i]] += 1
    tot_e, tot_t = sum(empty.values()), sum(text.values())
    if tot_e:
        out.append('ช่องว่าง: ' + ', '.join(f'{k} {v}' for k, v in empty.items() if v))
    else:
        out.append('ช่องว่าง: ไม่มี')
    if tot_t:
        out.append('ช่องที่เป็นข้อความ (ต้องมีบรรทัด "Column \'…\': N non-numeric value(s) replaced with NaN"): '
                   + ', '.join(f'{k} {v}' for k, v in text.items() if v))
    else:
        out.append('ช่องที่เป็นข้อความ: ไม่มี (ไม่ควรมีบรรทัด non-numeric)')
    out.append(f'% empty (ช่องว่าง + ช่องข้อความ ÷ ทุกช่อง): {pct_empty(tot_e + tot_t, len(rows) * len(sensors))}')
    return out


def note(rel, uses, lines):
    folder, _, name = rel.rpartition('/')
    REPORT.append((folder, name, uses, lines))


def series(start, n, step=MIN5):
    return [start + step * i for i in range(n)]


def ts(t):
    return t.strftime('%Y-%m-%d %H:%M:%S')


# ─────────────────────────────── normal/ ───────────────────────────────
NORM_HEAD = ['timestamp', 'TI-101', 'TI-102', 'PI-201', 'FI-301', 'KW-401', 'VI-501', 'TT-601']
NORM_STOP = (datetime(2024, 1, 10, 8, 0), datetime(2024, 1, 11, 7, 55))


def norm_vals(t, rnd):
    h = t.hour + t.minute / 60
    stop = NORM_STOP[0] <= t <= NORM_STOP[1]
    kw = 0.0 if stop else 180 + 20 * math.sin(2 * math.pi * (h - 6) / 24) + rnd.gauss(0, 3)
    amb = 30 + 3 * math.sin(2 * math.pi * (h - 9) / 24) + rnd.gauss(0, 0.4)
    ti101 = 34 + rnd.gauss(0, 0.8) if stop else 22 + 0.15 * kw + 0.3 * amb + rnd.gauss(0, 0.6)
    ti102 = 36 + rnd.gauss(0, 0.8) if stop else 40 + 0.25 * kw + rnd.gauss(0, 1)
    pi201 = 0.1 + abs(rnd.gauss(0, 0.02)) if stop else 3.2 + 0.004 * (kw - 180) + rnd.gauss(0, 0.05)
    fi301 = 0.0 if stop else 450 + 0.5 * (kw - 180) + rnd.gauss(0, 8)
    vi501 = 0.2 + abs(rnd.gauss(0, 0.05)) if stop else 2.0 + rnd.gauss(0, 0.2)
    return [round(ti101, 2), round(ti102, 2), round(pi201, 3), round(fi301, 2), round(kw, 2), round(vi501, 3), round(amb, 2)]


def make_normal(days=30, start=datetime(2024, 1, 1), seed=1, drop=None):
    rnd = random.Random(seed)
    times = series(start, days * 288)
    rows = [[ts(t)] + norm_vals(t, rnd) for t in times]
    # known empty cells: TI-101 at 12 rows, FI-301 at 12 rows (only inside the first 30 days) -> 24 of 60,480 cells
    # = 0.04 %, which the Import page must show as "<0.1%" (below 0.05 %)
    for k in range(12):
        i = 500 + k * 613
        if i < len(rows):
            rows[i][1] = ''
    for k in range(12):
        i = 250 + k * 677
        if i < len(rows):
            rows[i][4] = ''
    head = list(NORM_HEAD)
    if drop:
        j = head.index(drop)
        head = head[:j] + head[j + 1:]
        rows = [r[:j] + r[j + 1:] for r in rows]
    return times, head, rows


times, head, rows = make_normal()
write('normal/IMP-normal.csv', head, rows)
note('normal/IMP-normal.csv', ['PREP-6', 'IMP-34', 'IMP-36', 'IMP-38', 'IMP-14', 'IMP-46', 'IMP-60', 'IMP-61', 'IMP-62',
                               'IMP-70', 'IMP-81', 'SEN', 'SPC', 'FIL', 'HL', 'TIME', 'LINE', 'SCAT', 'PAIR', 'PER-15', 'PER-19'],
     stats_lines(times, head, rows) + [
         'เครื่องหยุด: 2024/01/10 08:00 → 2024/01/11 07:55 (KW-401 = 0, FI-301 = 0) — ใช้ตั้ง Running condition "KW-401 is above 50"',
         'VI-501 ไม่มีในไฟล์ Tag names → อยู่ในแท็บ "No name" · TT-601 มีชื่อแต่ไม่มี component → "Uncategorized"'])
write('normal/IMP-normal_saved-as-CSV-UTF-8.csv', head, rows, bom=True, crlf=True)
note('normal/IMP-normal_saved-as-CSV-UTF-8.csv', ['WFF-1'],
     ['ข้อมูลเหมือน IMP-normal.csv ทุกแถว แต่บันทึกแบบที่ Excel ทำเมื่อเลือก "CSV UTF-8 (Comma delimited)" '
      '(มีอักขระซ่อนต้นไฟล์ + ขึ้นบรรทัดแบบ Windows) — ต้องอ่านได้ผลเหมือน IMP-normal.csv'])
LONG = 'IMP-normal_this_is_a_very_long_file_name_to_check_how_the_import_page_wraps_long_names_2024-01.csv'
write('normal/' + LONG, head, rows)
note('normal/' + LONG, ['IMP-45'], ['ข้อมูลเหมือน IMP-normal.csv — ใช้ดูว่าชื่อไฟล์ยาวถูกตัด/ขึ้นบรรทัดสวยไหม'])

NORM_TAGS_HEAD = ['tag', 'description', 'unit', 'component', 'alarm_ll', 'alarm_l', 'alarm_h', 'alarm_hh']
NORM_TAGS = [
    ['TI-101', 'Pump bearing temperature', '°C', 'Pump P-1', '10', '20', '80', '90'],
    ['TI-102', 'Motor winding temperature', '°C', 'Motor M-1', '', '', '120', ''],
    ['PI-201', 'Pump discharge pressure', 'bar', 'Pump P-1', '', '2', '-', ''],
    ['FI-301', 'Pump flow', 'm3/h', 'Pump P-1', '', '', '600', ''],
    ['KW-401', 'Motor power', 'kW', 'Motor M-1', '', '', '250', '280'],
    ['TT-601', 'Ambient temperature', '°C', '', '', '', '', ''],
    ['TI-103', 'Pump casing temperature', '°C', 'Pump P-1', '', '', '85', ''],
    ['PI-202', 'Pump suction pressure', 'bar', 'Pump P-1', '', '0.5', '', ''],
    ['XX-999', 'Spare tag not in the data', '-', 'Spare', '', '', '', ''],
]
write('normal/IMP-normal-tags.csv', NORM_TAGS_HEAD, NORM_TAGS)
note('normal/IMP-normal-tags.csv', ['IMP-38', 'IMP-76', 'IMP-14', 'IMP-81', 'IMP-82', 'SEN-2', 'SEN-4', 'SEL-9', 'FG-26'],
     ['9 แถว · กับ IMP-normal.csv อย่างเดียว: จับคู่ได้ 6 / 7 คอลัมน์ (VI-501 ไม่มีชื่อ)',
      'tag ที่ไม่มีในข้อมูล 3 ตัว (TI-103, PI-202, XX-999) → บรรทัดเหลือง "3 tags in the tag-name file are not in the dataset"',
      'alarm: TI-101 LL 10 / L 20 / H 80 / HH 90 · TI-102 H 120 อย่างเดียว · PI-201 L 2 และ H เป็น "-" (ไม่มีค่า) · '
      'FI-301 H 600 · KW-401 H 250 / HH 280 · TT-601 ไม่มี alarm และไม่มี component'])

# ─────────────────────────────── multi-file/ ───────────────────────────────
def two_col(t):
    h = t.hour + t.minute / 60
    d = (t - datetime(2024, 1, 1)).days
    return [round(60 + 8 * math.sin(2 * math.pi * h / 24) + 0.05 * d, 2), round(3 + 0.4 * math.cos(2 * math.pi * h / 24), 3)]


MF = []
for k, (a, b) in enumerate([(datetime(2024, 1, 1), datetime(2024, 1, 10, 23, 55)),
                            (datetime(2024, 1, 8), datetime(2024, 1, 17, 23, 55)),
                            (datetime(2024, 1, 15), datetime(2024, 1, 24, 23, 55))], 1):
    tt = series(a, int((b - a) / MIN5) + 1)
    rr = [[ts(t)] + two_col(t) for t in tt]
    write(f'multi-file/MF-overlap-{k}.csv', ['timestamp', 'TI-101', 'PI-201'], rr)
    MF.append(tt)
    note(f'multi-file/MF-overlap-{k}.csv', ['IMP-35', 'IMP-36', 'IMP-86', 'PERF-8'], stats_lines(tt, ['timestamp', 'TI-101', 'PI-201'], rr))
uniq = sorted(set(MF[0] + MF[1] + MF[2]))
note('multi-file/(MF-overlap-1 + 2 + 3 พร้อมกัน)', ['IMP-36', 'PERF-8'],
     [f'รวม 3 ไฟล์: Rows (after merge) = {len(uniq):,} · Period {fmt(uniq[0])} → {fmt(uniq[-1])} · Interval 5 min · Sensors 2',
      f'ช่วงที่ซ้อนกัน: 08–10 ม.ค. (ไฟล์ 1+2) และ 15–17 ม.ค. (ไฟล์ 2+3) = เวลาซ้ำ {len(MF[0]) + len(MF[1]) + len(MF[2]) - len(uniq):,} จุด '
      '→ ควรมีบรรทัด "… duplicate timestamp(s) found across files" · ค่าในช่วงซ้อนเหมือนกันทุกไฟล์ จึงไม่มีจุดกระโดด',
      'ชื่อคอลัมน์เหมือนกันทุกไฟล์ → อาจขึ้น "Duplicate column …" ทุกคอลัมน์ (ทราบแล้ว ดู WFF-2)'])

ADJ = []
for k, (a, b) in enumerate([(datetime(2024, 2, 1), datetime(2024, 2, 14, 23, 55)),
                            (datetime(2024, 2, 15), datetime(2024, 2, 28, 23, 55))], 1):
    tt = series(a, int((b - a) / MIN5) + 1)
    rr = [[ts(t)] + two_col(t) for t in tt]
    write(f'multi-file/MF-adjacent-{k}.csv', ['timestamp', 'TI-101', 'PI-201'], rr)
    ADJ += tt
    note(f'multi-file/MF-adjacent-{k}.csv', ['IMP-36', 'IMP-86'], stats_lines(tt, ['timestamp', 'TI-101', 'PI-201'], rr))
note('multi-file/(MF-adjacent-1 + 2 พร้อมกัน)', ['IMP-36'],
     [f'รวม 2 ไฟล์: Rows = {len(ADJ):,} (ต่อกันพอดี ไม่มีเวลาซ้ำ) · Period {fmt(ADJ[0])} → {fmt(ADJ[-1])} · '
      'Time coverage สองแถบต่อกันพอดี ไม่มีช่องว่าง ไม่ซ้อน'])

tt = series(datetime(2024, 3, 1), 7 * 288)
r1 = [[ts(t)] + two_col(t) for t in tt]
r2 = [[ts(t), round(two_col(t)[0] + 5, 2), round(450 + 20 * math.sin(i / 50), 2)] for i, t in enumerate(tt)]
write('multi-file/MF-samecol-1.csv', ['timestamp', 'TI-101', 'PI-201'], r1)
write('multi-file/MF-samecol-2.csv', ['timestamp', 'TI-101', 'FI-301'], r2)
note('multi-file/MF-samecol-1.csv + MF-samecol-2.csv', ['PREP-6', 'IMP-36'],
     [f'แต่ละไฟล์ {len(tt):,} แถว ช่วงเดียวกัน {fmt(tt[0])} → {fmt(tt[-1])}',
      'คอลัมน์ TI-101 อยู่ทั้ง 2 ไฟล์ (ค่าในไฟล์ 2 สูงกว่า 5) → ต้องมี "Duplicate column \'TI-101\' found in file 1, file 2"',
      f'รวมกัน: Rows {len(tt):,} · Sensors 3 (TI-101, PI-201, FI-301) · ค่า TI-101 เป็นของไฟล์ 2 (ไฟล์หลังทับไฟล์แรก)',
      f'เวลาซ้ำข้ามไฟล์ {len(tt):,} จุด'])

times_b = series(datetime(2024, 1, 1), 30 * 288)
rnd = random.Random(7)
rows_b = [[ts(t), round(55 + rnd.gauss(0, 1), 2), round(0.8 + rnd.gauss(0, 0.03), 3), round(40 + rnd.gauss(0, 5), 1)] for t in times_b]
write('multi-file/MF-extra-columns-B.csv', ['timestamp', 'TI-103', 'PI-202', 'XV-701'], rows_b)
note('multi-file/MF-extra-columns-B.csv', ['IMP-81'],
     stats_lines(times_b, ['timestamp', 'TI-103', 'PI-202', 'XV-701'], rows_b) + [
         'ใช้คู่กับ normal/IMP-normal.csv (ช่วงเวลาเดียวกัน) + normal/IMP-normal-tags.csv',
         'ก่อนเพิ่มไฟล์ B: วงแหวน 6 / 7 · หลังเพิ่ม B แล้ว Parse files ใหม่: วงแหวน 8 / 10 (TI-103, PI-202 มีชื่อ · XV-701 ไม่มีชื่อ) '
         'และบรรทัดเหลืองเหลือ "1 tag … not in the dataset" (XX-999)'])

tt = series(datetime(2024, 4, 1), 288)
for k in (1, 2, 3):
    t0 = datetime(2024, 4, k)
    tk = series(t0, 288)
    rk = [[ts(t)] + two_col(t) + [round(1 + k / 10, 2)] for t in tk]
    name = f'multi-file/MF-set-{k}' + ('-BROKEN.csv' if k == 2 else '.csv')
    if k == 2:
        rk[48] = rk[48] + ['9.9']      # data row 49 = line 50 of the file has one comma too many
    write(name, ['timestamp', 'TI-101', 'PI-201', 'FI-301'], rk)
note('multi-file/MF-set-1.csv + MF-set-2-BROKEN.csv + MF-set-3.csv', ['IMP-73'],
     ['3 ไฟล์ วันละไฟล์ (1, 2, 3 เม.ย. 2024) · ไฟล์ที่ 2 บรรทัดที่ 50 มี 5 ช่อง แต่หัวคอลัมน์มี 4 ช่อง',
      'ต้องไม่โหลดทั้งชุด และข้อความแดงควรบอกชื่อไฟล์ MF-set-2-BROKEN.csv'])

# ─────────────────────────────── tags/ ───────────────────────────────
write('tags/T01-other-header-names.csv', ['Name', 'UOM', 'System', 'LoLo', 'Low', 'High', 'HiHi', 'TAG'],
      [['Pump bearing temperature', 'degC', 'Pump P-1', '-', '20', '80', 'n/a', 'TI-101'],
       ['Motor winding temperature', 'degC', 'Motor M-1', '', '', '120', '', 'TI-102'],
       ['Pump discharge pressure', 'bar', 'Pump P-1', '', 'low', '5', '', 'PI-201'],
       ['Pump flow', 'm3/h', 'Pump P-1', '', '300', '-', '', 'FI-301'],
       ['Motor power', 'kW', 'Motor M-1', '', '', '250', '280', 'KW-401']])
note('tags/T01-other-header-names.csv', ['IMP-77'],
     ['หัวคอลัมน์ Name / UOM / System / LoLo / Low / High / HiHi และคอลัมน์ tag อยู่ท้ายสุดชื่อ TAG — ใช้กับ normal/IMP-normal.csv',
      'ต้องจับคู่ได้ 5 ตัว · ชื่อจาก Name, หน่วยจาก UOM, component จาก System',
      'alarm ที่ไม่ใช่ตัวเลข ("-", "n/a", "low") = ไม่มีค่า: TI-101 มีแค่ L 20 / H 80 · PI-201 มีแค่ H 5 · FI-301 มีแค่ L 300'])
write('tags/T02-description-and-name.csv', ['tag', 'name', 'description', 'units', 'group'],
      [['TI-101', 'NAME COLUMN - must not be used', 'Pump bearing temperature (from description)', '°C', 'Pump P-1'],
       ['KW-401', 'NAME COLUMN - must not be used', 'Motor power (from description)', 'kW', 'Motor M-1']])
note('tags/T02-description-and-name.csv', ['IMP-77'],
     ['มีทั้งคอลัมน์ name และ description → ชื่อที่แสดงต้องเป็นของ description ("… (from description)")',
      'หน่วยจาก units, component จาก group'])
write('tags/T03-duplicate-tag-TI-101.csv', NORM_TAGS_HEAD,
      [NORM_TAGS[0], ['TI-101', 'Bearing temp (second row)', '°C', 'Motor M-1', '', '', '75', '']] + NORM_TAGS[1:6])
note('tags/T03-duplicate-tag-TI-101.csv', ['IMP-80', 'PREP-6'],
     ['TI-101 มี 2 แถว: "Pump bearing temperature" / Pump P-1 / H 80 และ "Bearing temp (second row)" / Motor M-1 / H 75',
      'แถวทั้งหมด 7 แถว แต่เป็น tag ไม่ซ้ำ 6 ตัว → วงแหวน / ตาราง / ป้าย component ควรนับ TI-101 ครั้งเดียว (6 / 7)'])
path = p('tags', 'T04-broken-short-row.csv')
with open(path, 'w', newline='', encoding='utf-8') as f:
    f.write(','.join(NORM_TAGS_HEAD) + '\n')
    f.write(','.join(NORM_TAGS[0]) + '\n')
    f.write('TI-102,Motor winding temperature,°C\n')
    for r in NORM_TAGS[2:6]:
        f.write(','.join(r) + '\n')
note('tags/T04-broken-short-row.csv', ['IMP-79'], ['บรรทัดที่ 3 (TI-102) มี 3 ช่อง แต่หัวคอลัมน์มี 8 ช่อง → ข้อความแดงในการ์ด Tag names'])
open(p('tags', 'T05-empty-0-byte.csv'), 'wb').close()
note('tags/T05-empty-0-byte.csv', ['IMP-79'], ['ขนาด 0 byte'])

# ─────────────────────────────── buddhist/ ───────────────────────────────
tt = series(datetime(2024, 2, 28), 3 * 288)
rnd = random.Random(3)
rr = [[str(t.year + 543) + ts(t)[4:], round(60 + 8 * math.sin(2 * math.pi * (t.hour + t.minute / 60) / 24) + rnd.gauss(0, 0.3), 2),
       round(3 + rnd.gauss(0, 0.05), 3)] for t in tt]
write('buddhist/BE-2567-leap-day.csv', ['timestamp', 'TI-101', 'PI-201'], rr)
note('buddhist/BE-2567-leap-day.csv', ['PREP-6', 'IMP-20', 'IMP-74'],
     stats_lines(tt, ['timestamp', 'TI-101', 'PI-201'], rr) + [
         'ในไฟล์เขียน 2567-02-28 00:00:00 → 2567-03-01 23:55:00 (ปี พ.ศ.) — ในโปรแกรมต้องเป็นปี 2024 ทั้งหมด',
         'ต้องมีบรรทัด "864 timestamp(s) used a Buddhist-Era year (พ.ศ.) — converted to Gregorian (ค.ศ.) …"',
         'วันที่ 29 ก.พ. 2024 ต้องมีครบ 288 จุด (00:00 → 23:55)'])

# ─────────────────────────────── odd/ ───────────────────────────────
tt = series(datetime(2024, 5, 1), 2 * 288)
rr = [[ts(t)] + two_col(t) + [round(450 + 10 * math.sin(i / 40), 2)] for i, t in enumerate(tt)]
for i in (10, 60, 110, 160, 210):
    rr[i][1] = 'abc'
for i in (260, 310, 360):
    rr[i][1] = '#N/A'
for i in (20, 120, 220, 320):
    rr[i][1] = ''
for i in (30, 330):
    rr[i][2] = '1,234'
for i in (40, 90, 140, 190, 240, 290):
    rr[i][2] = ''
H = ['timestamp', 'TI-101', 'PI-201', 'FI-301']
write('odd/ODD-text-and-empty-cells.csv', H, rr)
note('odd/ODD-text-and-empty-cells.csv', ['PREP-6', 'IMP-63', 'IMP-74'], stats_lines(tt, H, rr) + [
    'TI-101: ข้อความ "abc" 5 ช่อง + "#N/A" 3 ช่อง = 8 · PI-201: "1,234" 2 ช่อง (ตัวเลขมีลูกน้ำคั่นหลักพันนับเป็นข้อความ) · FI-301 ไม่มีปัญหา',
    'ต้องมี "Column \'TI-101\': 8 non-numeric value(s) replaced with NaN" และ "Column \'PI-201\': 2 …" · ไม่มีบรรทัดของ FI-301',
    'แถวแรกที่เป็น abc: 2024/05/01 00:50:00 (TI-101) — บนกราฟต้องเป็นช่องขาด ไม่ใช่ 0'])

base = series(datetime(2024, 5, 3), 2 * 288)
rows_o, times_o = [], []
for i, t in enumerate(base):
    rows_o.append([ts(t)] + two_col(t)); times_o.append(t)
    if i == 100:
        rows_o.append([ts(t), 99.9, '']); times_o.append(t)        # same time again: TI-101 99.9, PI-201 empty
    if i == 400:
        rows_o.append([ts(t), '', 7.777]); times_o.append(t)       # same time again: TI-101 empty, PI-201 7.777
    if i in (50, 250, 450):
        rows_o.append(['', 11.1, 1.11]); times_o.append(None)
H = ['timestamp', 'TI-101', 'PI-201']
write('odd/ODD-empty-and-repeated-time.csv', H, rows_o)
v100, v400 = two_col(base[100]), two_col(base[400])
note('odd/ODD-empty-and-repeated-time.csv', ['PREP-6', 'IMP-67'], stats_lines(times_o, H, rows_o) + [
    f'แถวข้อมูล {len(rows_o)} = เวลาไม่ซ้ำ 576 + แถวเวลาว่าง 3 (ค่า 11.1 / 1.11) + แถวเวลาซ้ำ 2',
    f'เวลาซ้ำ 1: {fmt(base[100])} แถวแรก TI-101 {v100[0]} PI-201 {v100[1]} · แถวหลัง TI-101 99.9 PI-201 ว่าง '
    f'→ ถ้ารวมแบบ "แถวหลังชนะ ยกเว้นช่องว่าง" = TI-101 99.9, PI-201 {v100[1]}',
    f'เวลาซ้ำ 2: {fmt(base[400])} แถวแรก TI-101 {v400[0]} PI-201 {v400[1]} · แถวหลัง TI-101 ว่าง PI-201 7.777 '
    f'→ ถ้ารวม = TI-101 {v400[0]}, PI-201 7.777',
    'ข้อ IMP-67 คาดหวัง Rows = 576 (= แถวในไฟล์ − 5) · ถ้าเห็น 581 แปลว่าไฟล์เดียวไม่ตัดแถวเวลาว่าง/ไม่รวมเวลาซ้ำ '
    '(เป็นไปตามคำเตือน ⚠ ในข้อนั้น ให้บันทึกผลตามจริง)'])

tt = series(datetime(2024, 5, 5), 288)
rr = [[ts(t)] + two_col(t) + [round(two_col(t)[0] + 20, 2)] for t in tt]
write('odd/ODD-same-column-twice.csv', ['timestamp', 'TI-101', 'PI-201', 'TI-101'], rr)
write('odd/ODD-same-column-twice-case.csv', ['timestamp', 'TI-101', 'PI-201', 'ti-101'], rr)
note('odd/ODD-same-column-twice.csv', ['IMP-68'], [
    '288 แถว (2024/05/05 00:00:00 → 23:55:00) · คอลัมน์ TI-101 มี 2 คอลัมน์ (คอลัมน์ที่สองสูงกว่าคอลัมน์แรก 20)',
    'ควรมีคำเตือนชื่อคอลัมน์ซ้ำ และ Dashboard ไม่มี TI-101 สองตัวที่ตัวหนึ่งว่าง'])
note('odd/ODD-same-column-twice-case.csv', ['IMP-68'], ['เหมือนไฟล์บน แต่คอลัมน์ที่สองชื่อ ti-101 (ตัวพิมพ์เล็ก)'])
for name, header in [('ODD-time-header-Timestamp.csv', ['Timestamp', 'TI-101', 'PI-201']),
                     ('ODD-time-header-TIME.csv', ['TIME', 'TI-101', 'PI-201'])]:
    write('odd/' + name, header, [[ts(t)] + two_col(t) for t in tt])
    note('odd/' + name, ['PREP-6', 'IMP-64'], [f'288 แถว 2024/05/05 00:00:00 → 23:55:00 · คอลัมน์เวลาชื่อ {header[0]} · Sensors = 2'])
write('odd/ODD-time-in-column-3.csv', ['TI-101', 'PI-201', 'timestamp', 'FI-301'],
      [two_col(t) + [ts(t), round(450 + i % 7, 1)] for i, t in enumerate(tt)])
note('odd/ODD-time-in-column-3.csv', ['PREP-6', 'IMP-64'],
     ['288 แถว 2024/05/05 00:00:00 → 23:55:00 · คอลัมน์ timestamp อยู่คอลัมน์ที่ 3 · Sensors = 3 (TI-101, PI-201, FI-301)'])

# ─────────────────────────────── broken/ ───────────────────────────────
tt = series(datetime(2024, 6, 1), 288)
write('broken/BRK-date-header.csv', ['Date', 'TI-101', 'PI-201'], [[ts(t)] + two_col(t) for t in tt])
note('broken/BRK-date-header.csv', ['PREP-6', 'IMP-65'], [
    '288 แถว วันเวลาถูกต้อง (2024-06-01 00:00:00 → 23:55:00) แต่หัวคอลัมน์ชื่อ Date',
    'ควรขึ้นข้อความแดงว่าหาคอลัมน์เวลาไม่เจอ (⚠ อาจได้ "Ready · 0 rows" + "Column \'Date\': 288 non-numeric …" แทน)'])
write('broken/BRK-datetime-header.csv', ['DateTime', 'TI-101', 'PI-201'], [[ts(t)] + two_col(t) for t in tt])
note('broken/BRK-datetime-header.csv', ['IMP-65', 'WFF-1'], ['เหมือนไฟล์บน แต่หัวคอลัมน์ชื่อ DateTime'])
write('broken/BRK-semicolon.csv', ['timestamp', 'TI-101', 'PI-201'], [[ts(t)] + two_col(t) for t in tt], delim=';')
note('broken/BRK-semicolon.csv', ['WFF-1'], ['288 แถว คั่นด้วย ; แทน , (แบบที่ Excel ภาษายุโรปบันทึก) — ทั้งบรรทัดจะกลายเป็นคอลัมน์เดียว'])
open(p('broken', 'BRK-empty-0-byte.csv'), 'wb').close()
note('broken/BRK-empty-0-byte.csv', ['PREP-6', 'IMP-69'], ['ขนาด 0 byte'])
write('broken/BRK-header-only.csv', ['timestamp', 'TI-101', 'PI-201'], [])
note('broken/BRK-header-only.csv', ['PREP-6', 'IMP-69'], ['มีแค่บรรทัดหัวคอลัมน์ ไม่มีข้อมูล'])
rr = [[ts(t)] + two_col(t) + [round(450 + i % 9, 1), round(2 + i % 5 / 10, 2)] for i, t in enumerate(tt)]
rr[48] = rr[48] + ['7.7']     # data row 49 = line 50 of the file: 6 fields, the header has 5
write('broken/BRK-extra-comma-line-50.csv', ['timestamp', 'TI-101', 'PI-201', 'FI-301', 'KW-401'], rr)
note('broken/BRK-extra-comma-line-50.csv', ['PREP-6', 'IMP-70', 'IMP-74'], [
    'หัวคอลัมน์ 5 ช่อง · บรรทัดที่ 50 ของไฟล์มี 6 ช่อง (ลูกน้ำเกิน 1 ตัว)',
    'ต้องขึ้นกล่องแดง "CSV error: … (line: 50, …): found record with 6 fields, but the previous record has 5 fields"'])


def xlsx_bytes():
    def cell(ref, v):
        if isinstance(v, str):
            return f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>'
        return f'<c r="{ref}"><v>{v}</v></c>'
    rows_x = [['timestamp', 'TI-101', 'PI-201']] + [[ts(t)] + two_col(t) for t in tt[:24]]
    sheet = ''.join(f'<row r="{i + 1}">' + ''.join(cell(f'{"ABC"[j]}{i + 1}', v) for j, v in enumerate(r)) + '</row>'
                    for i, r in enumerate(rows_x))
    files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '</Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>',
        'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '</Relationships>',
        'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheet + '</sheetData></worksheet>',
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, body in files.items():
            z.writestr(name, body)
    return buf.getvalue()


xb = xlsx_bytes()
for name in ('BRK-excel-file-renamed.csv', 'BRK-not-a-csv.xlsx'):
    with open(p('broken', name), 'wb') as f:
        f.write(xb)
note('broken/BRK-excel-file-renamed.csv', ['PREP-6', 'IMP-71', 'IMP-73'],
     ['ไฟล์ Excel (.xlsx) จริง 24 แถว ที่เปลี่ยนนามสกุลเป็น .csv — ข้างในเป็นไฟล์บีบอัด ไม่ใช่ข้อความ → ต้องขึ้นกล่องแดง ไม่ใช่อ่านสำเร็จด้วยหัวคอลัมน์ขยะ'])
note('broken/BRK-not-a-csv.xlsx', ['IMP-62'], ['ไฟล์เดียวกับข้างบนแต่นามสกุล .xlsx — ใช้ลากมาวางเพื่อดูว่าไฟล์ที่ไม่ใช่ .csv ถูกปฏิเสธ (เปิดใน Excel ได้)'])

# ─────────────────────────────── time-shapes/ ───────────────────────────────
SHAPES = [
    ('IMP66-1_dash-seconds.csv', datetime(2024, 1, 1), lambda t: t.strftime('%Y-%m-%d %H:%M:%S'), 'อ่านได้'),
    ('IMP66-2_dash-minutes.csv', datetime(2024, 1, 2), lambda t: t.strftime('%Y-%m-%d %H:%M'), 'อ่านได้'),
    ('IMP66-3_T-separator.csv', datetime(2024, 1, 3), lambda t: t.strftime('%Y-%m-%dT%H:%M:%S'), 'อ่านได้'),
    ('IMP66-4_milliseconds.csv', datetime(2024, 1, 4), lambda t: t.strftime('%Y-%m-%d %H:%M:%S') + '.250', 'อ่านได้'),
    ('IMP66-5_offset-plus0700.csv', datetime(2024, 1, 5), lambda t: t.strftime('%Y-%m-%d %H:%M:%S') + '+07:00',
     'อ่านได้ เวลาตามที่เขียน (ไม่เลื่อนเขตเวลา)'),
    ('IMP66-5b_offset-minus0500.csv', datetime(2024, 1, 6), lambda t: t.strftime('%Y-%m-%dT%H:%M:%S') + '-05:00',
     'ใช้กับ BMW-212 (เขตเวลาที่ไม่ใช่ของเครื่อง)'),
    ('IMP66-6_year-slash.csv', datetime(2025, 1, 1), lambda t: t.strftime('%Y/%m/%d %H:%M:%S'), 'แผนเดิมคาดว่าอาจอ่านไม่ได้ (⚠)'),
    ('IMP66-7_day-month-year.csv', datetime(2023, 5, 13), lambda t: t.strftime('%d/%m/%Y %H:%M'), 'แผนเดิมคาดว่าอาจอ่านไม่ได้ (⚠)'),
    ('IMP66-8_iso-Z.csv', datetime(2026, 2, 9), lambda t: t.strftime('%Y-%m-%dT%H:%M:%SZ'), 'Z = เวลา UTC (ดูส่วน "ของที่รู้อยู่แล้ว")'),
]
for name, start, f_, hint in SHAPES:
    tk = series(start, 288)
    write('time-shapes/' + name, ['timestamp', 'TS_TEMP', 'TS_PRESS'], [[f_(t)] + two_col(t) for t in tk])
    note('time-shapes/' + name, ['PREP-6', 'IMP-66'] + (['BMW-212'] if '0700' in name or '0500' in name else []),
         [f'288 แถว ทุก 5 นาที · ในไฟล์เขียนแบบ "{f_(tk[0])}" · ถ้าอ่านได้: {fmt(tk[0])} → {fmt(tk[-1])} · {hint}'])

span14 = series(datetime(2026, 1, 1), 14 * 288)
EXCEL = [
    ('IMP87-A_month-day-year.csv', lambda t: f'{t.month}/{t.day}/{t.year} {t.hour}:{t.minute:02d}',
     'เดือน/วัน/ปี — 1/1/2026 23:55 ตามด้วย 1/2/2026 0:00 (= 2 ม.ค.) · ต้องมี "Dates in … read as month/day/year (…)"'),
    ('IMP87-C_am-pm.csv', lambda t: f'{t.month}/{t.day}/{t.year} {t.hour % 12 or 12}:{t.minute:02d} {"AM" if t.hour < 12 else "PM"}',
     'เดือน/วัน/ปี + AM/PM — 1/2/2026 1:05 PM = 2026/01/02 13:05 · 12:05 AM = 00:05'),
    ('IMP87-D_day-month-buddhist.csv', lambda t: f'{t.day}/{t.month}/{t.year + 543} {t.hour}:{t.minute:02d}',
     'วัน/เดือน/ปี พ.ศ. — 2/1/2569 0:05 = 2026/01/02 00:05 · ต้องมีบรรทัดเรื่องปี พ.ศ. (4,032 แถว)'),
]
for name, f_, hint in EXCEL:
    write('time-shapes/' + name, ['timestamp', 'TS_TEMP', 'TS_PRESS'], [[f_(t)] + two_col(t) for t in span14])
    note('time-shapes/' + name, ['IMP-87'], [f'{len(span14):,} แถว ทุก 5 นาที · ในไฟล์ แถวแรก "{f_(span14[0])}" '
                                             f'· ต้องได้ {fmt(span14[0])} → {fmt(span14[-1])}', hint])
tb = series(datetime(2026, 1, 13), 2 * 288)
write('time-shapes/IMP87-B_day-month-year.csv', ['timestamp', 'TS_TEMP', 'TS_PRESS'],
      [[t.strftime('%d/%m/%Y %H:%M')] + two_col(t) for t in tb])
note('time-shapes/IMP87-B_day-month-year.csv', ['IMP-87'],
     [f'576 แถว · แถวแรก "13/01/2026 00:00" (วันที่เกิน 12) · ต้องได้ {fmt(tb[0])} → {fmt(tb[-1])} (13–14 ม.ค.)'])

# IMP-88 look-alike historian export: "01-Jan-25 12:00 AM", header TimeStamp, BOM, a 1-day outage so the totals match the plan
GAP = (datetime(2025, 7, 14), datetime(2025, 7, 14, 23, 55))


def hist(t):
    return f'{t:%d-%b-%y} {t.hour % 12 or 12}:{t.minute:02d} {"AM" if t.hour < 12 else "PM"}'


allt = [t for t in series(datetime(2025, 1, 1), int((datetime(2026, 10, 16, 14, 10) - datetime(2025, 1, 1)) / MIN5) + 1)
        if not (GAP[0] <= t <= GAP[1])]
rnd = random.Random(88)
for yr in (2025, 2026):
    part = [t for t in allt if t.year == yr]
    rr = [[hist(t), round(180 + 20 * math.sin(2 * math.pi * t.hour / 24) + rnd.gauss(0, 3), 2),
           round(55 + rnd.gauss(0, 1.5), 2), round(2 + rnd.gauss(0, 0.2), 3)] for t in part]
    write(f'time-shapes/IMP88/{yr}.csv', ['TimeStamp', 'H_KW', 'H_BRG_TEMP', 'H_VIB'], rr, bom=True, crlf=True)
    note(f'time-shapes/IMP88/{yr}.csv', ['IMP-88'], [f'{len(part):,} แถว · {fmt(part[0])} → {fmt(part[-1])} · '
                                                    f'เขียนแบบ "{hist(part[0])}" · มีอักขระซ่อนต้นไฟล์ (BOM) · หัวคอลัมน์ TimeStamp'])
note('time-shapes/IMP88/(2025.csv + 2026.csv พร้อมกัน)', ['IMP-88'],
     [f'ไฟล์เลียนแบบไฟล์จากระบบ historian ตัวเลขตรงกับข้อ IMP-88: Rows {len(allt):,} · {fmt(allt[0])} → {fmt(allt[-1])}',
      'มีช่องว่างข้อมูล 1 วัน (2025/07/14 ทั้งวัน) ตั้งใจใส่ไว้ให้จำนวนแถวตรงกับข้อ IMP-88',
      'รูปแบบอื่นในข้อเดียวกัน (Fri, 31 Jan 2025 …, 20250131130500, 31 ม.ค. 2568, 45688.54…) ใช้ C:\\WizardTestData\\TS\\formats F09 / F10 / F14 / F16'])

# ─────────────────────────────── intervals/ ───────────────────────────────
for name, step, n in [('INT-10s.csv', 10, 8640), ('INT-90s.csv', 90, 1920), ('INT-90min.csv', 5400, 480),
                      ('INT-1h.csv', 3600, 1440), ('INT-1d.csv', 86400, 365)]:
    tk = series(datetime(2024, 7, 1), n, timedelta(seconds=step))
    rr = [[ts(t)] + two_col(t) for t in tk]
    write('intervals/' + name, ['timestamp', 'TI-101', 'PI-201'], rr)
    note('intervals/' + name, ['IMP-36'] + (['BMW-212'] if step in (10, 3600) else []), stats_lines(tk, ['timestamp', 'TI-101', 'PI-201'], rr))

# ─────────────────────────────── wide/ ───────────────────────────────
WH = ['timestamp'] + [f'W{i:03d}' for i in range(1, 221)]
tk = series(datetime(2024, 8, 1), 288)
rnd = random.Random(220)
rr = [[ts(t)] + [round(50 + j + rnd.gauss(0, 1), 2) for j in range(220)] for t in tk]
write('wide/IMP-wide-220-sensors.csv', WH, rr)
comps = ['Pump P-1', 'Motor M-1', 'Gearbox G-1', 'Fan F-1', 'Compressor K-1', 'Cooler E-1']
wt = []
for i in range(1, 216):
    wt.append([f'W{i:03d}', f'Wide sensor number {i}', 'u', '' if i > 205 else comps[(i * 7) % 6], '', '', '', ''])
for i in range(1, 26):
    wt.append([f'GONE{i:02d}', f'Tag that is not in the data {i}', '', 'Spare', '', '', '', ''])
write('wide/IMP-wide-tags.csv', NORM_TAGS_HEAD, wt)
note('wide/IMP-wide-220-sensors.csv + IMP-wide-tags.csv', ['IMP-78'],
     ['288 แถว 220 sensors (W001–W220) · ไฟล์ tag 240 แถว: W001–W215 มีชื่อ (W206–W215 ไม่มี component) + GONE01–GONE25 ไม่มีในข้อมูล',
      'ต้องได้: จับคู่ 215 / 220 · "Showing the first 200 of 215 — use search to find the rest." · แท็บ No name 5 ตัว (W216–W220)',
      'บรรทัดเหลือง "25 tags … not in the dataset" · ชี้เมาส์แล้วเห็นรายชื่อสูงสุด 20 ตัว · ป้าย component มี "Uncategorized" (10 ตัว)'])

# ─────────────────────────────── variants/ ───────────────────────────────
t_, h_, r_ = make_normal(drop='TI-101')
write('variants/IMP-normal_without-TI-101.csv', h_, r_)
note('variants/IMP-normal_without-TI-101.csv', ['PER-15', 'BMW-396'],
     ['เหมือน normal/IMP-normal.csv แต่ไม่มีคอลัมน์ TI-101 (6 sensors) · วิธีใช้: ปิดโปรแกรม → เก็บสำเนา IMP-normal.csv ไว้ → '
      'คัดลอกไฟล์นี้ไปทับ แล้วเปลี่ยนชื่อเป็น IMP-normal.csv'])
t_, h_, r_ = make_normal(drop='KW-401')
write('variants/IMP-normal_without-KW-401.csv', h_, r_)
note('variants/IMP-normal_without-KW-401.csv', ['BMW-396'], ['เหมือนกันแต่ไม่มี KW-401 (sensor ของ Running condition "KW-401 is above 50") · วิธีใช้แบบเดียวกัน'])
t_, h_, r_ = make_normal(days=31)
write('variants/IMP-normal_plus-1-day.csv', h_, r_)
note('variants/IMP-normal_plus-1-day.csv', ['PER-19'], stats_lines(t_, h_, r_) + ['30 วันแรกเหมือน IMP-normal.csv ทุกค่า + วันที่ 2024/01/31 ต่อท้าย · วิธีใช้แบบเดียวกัน'])
t_, h_, r_ = make_normal(days=10)
write('variants/IMP-normal_first-10-days.csv', h_, r_)
note('variants/IMP-normal_first-10-days.csv', ['BMW-201', 'BMW-358'], stats_lines(t_, h_, r_) + [
    'ช่วงสั้นกว่าเดิม (สิ้นสุด 2024/01/10 23:55) — ตั้ง Train / Scoring period หลังวันที่ 11 ม.ค. ด้วยไฟล์เต็มก่อน แล้วค่อยเปลี่ยนเป็นไฟล์นี้'])
chg = [list(r) for r in NORM_TAGS]
chg[0][1] = 'Pump bearing temperature (CHANGED)'
chg[3][3] = 'Pump P-2'
chg[0][6] = '75'
write('variants/IMP-normal-tags_changed.csv', NORM_TAGS_HEAD, chg)
note('variants/IMP-normal-tags_changed.csv', ['PER-19', 'WFF-5'],
     ['เหมือน IMP-normal-tags.csv แต่: TI-101 description "Pump bearing temperature (CHANGED)" และ alarm H 75 (เดิม 80) · '
      'FI-301 component "Pump P-2" (เดิม Pump P-1) · วิธีใช้: คัดลอกไปทับ IMP-normal-tags.csv แล้วเปลี่ยนชื่อเป็นชื่อเดิม'])

# ─────────────────────────────── projects/ ───────────────────────────────
GEG_HEAD = ['timestamp', 'PWR_KW', 'SPEED_RPM', 'TT_BRG_DE', 'TT_BRG_NDE', 'TT_LO_IN', 'TT_EXH_A', 'VIB_GEN']


def geg(name, start, end, seed, stop, incident=None):
    rnd = random.Random(seed)
    tk = series(start, int((end - start) / MIN5) + 1)
    rr = []
    for t in tk:
        h = t.hour + t.minute / 60
        off = stop[0] <= t <= stop[1]
        kw = 0.0 if off else 1450 + 250 * math.sin(2 * math.pi * (h - 7) / 24) + rnd.gauss(0, 25)
        rpm = 0.0 if off else 1500 + rnd.gauss(0, 2)
        lo = 40 + rnd.gauss(0, 0.5) if off else 62 + 0.004 * kw + rnd.gauss(0, 0.6)
        de = 42 + rnd.gauss(0, 0.6) if off else 18 + 0.025 * kw + 0.4 * lo + rnd.gauss(0, 0.7)
        nde = 40 + rnd.gauss(0, 0.6) if off else 15 + 0.022 * kw + 0.4 * lo + rnd.gauss(0, 0.7)
        exh = 60 + rnd.gauss(0, 2) if off else 380 + 0.08 * kw + rnd.gauss(0, 5)
        vib = 0.3 + abs(rnd.gauss(0, 0.05)) if off else 2.4 + rnd.gauss(0, 0.2)
        if incident and incident[0] <= t <= incident[1]:
            f = (t - incident[0]) / (incident[1] - incident[0])
            de += 15 * f
            vib += 2.5 * f
        rr.append([ts(t), round(kw, 1), round(rpm, 1), round(de, 2), round(nde, 2), round(lo, 2), round(exh, 1), round(vib, 3)])
    write('projects/' + name, GEG_HEAD, rr)
    return tk, rr


g3t, g3r = geg('GEG-3.csv', datetime(2025, 1, 1), datetime(2025, 6, 30, 23, 55), 33,
               (datetime(2025, 2, 10), datetime(2025, 2, 11, 23, 55)), (datetime(2025, 5, 18), datetime(2025, 5, 20, 12, 0)))
note('projects/GEG-3.csv', ['PREP-5', 'MULTI', 'MULTI-15', 'WFE', 'WFF', 'WFH'], stats_lines(g3t, GEG_HEAD, g3r) + [
    'เครื่องหยุด 2025/02/10 00:00 → 2025/02/11 23:55 (PWR_KW = 0) · Running condition แนะนำ "PWR_KW is above 500"',
    'อาการ bearing DE ร้อนขึ้นเรื่อย ๆ 2025/05/18 00:00 → 2025/05/20 12:00 (TT_BRG_DE +15 °C, VIB_GEN +2.5)',
    'Relation model ที่มีความหมาย: TT_BRG_DE จาก PWR_KW + TT_LO_IN · special sensor ของ WFE/WFF: DT_BRG = $TT_BRG_DE - $TT_LO_IN'])
g4t, g4r = geg('GEG-4.csv', datetime(2025, 3, 1), datetime(2025, 8, 31, 23, 55), 44,
               (datetime(2025, 5, 5), datetime(2025, 5, 6, 23, 55)), (datetime(2025, 7, 20), datetime(2025, 7, 23)))
note('projects/GEG-4.csv', ['WFE'], stats_lines(g4t, GEG_HEAD, g4r) + [
    'tag ชุดเดียวกับ GEG-3 แต่ช่วงเวลา มี.ค.–ส.ค. 2025 · เครื่องหยุด 2025/05/05 – 2025/05/06 · อาการ bearing 2025/07/20 → 2025/07/23'])
GEG_TAGS_HEAD = ['TAG', 'DESCRIPTION', 'UNIT', 'COMPONENT', 'ALARM_LL', 'ALARM_L', 'ALARM_H', 'ALARM_HH']
GEG_EN = [
    ['PWR_KW', 'Generator power', 'kW', 'Generator', '', '', '2000', ''],
    ['SPEED_RPM', 'Engine speed', 'rpm', 'Engine', '', '1450', '1550', ''],
    ['TT_BRG_DE', 'Bearing DE temp', '°C', 'Generator', '', '', '95', '105'],
    ['TT_BRG_NDE', 'Bearing NDE temp', '°C', 'Generator', '', '', '95', '105'],
    ['TT_LO_IN', 'Lube oil inlet temp', '°C', 'Lube oil', '', '50', '75', ''],
    ['TT_EXH_A', 'Exhaust temp bank A', '°C', 'Engine', '', '', '550', ''],
    ['VIB_GEN', 'Generator vibration', 'mm/s', 'Generator', '', '', '4.5', '7.1'],
]
write('projects/GEG-tags.csv', GEG_TAGS_HEAD, GEG_EN)
note('projects/GEG-tags.csv', ['PREP-5', 'MULTI-15 (โปรเจกต์ C)', 'WFE', 'WFF'],
     ['7 tag ภาษาอังกฤษ · TT_BRG_DE = "Bearing DE temp" · Component "Generator" · ALARM_H 95 · มี Component "Engine" ให้เลือกใน WFE-2'])
GEG_TH = [
    ['PWR_KW', 'กำลังไฟฟ้าเครื่องกำเนิด', 'kW', 'Engine', '', '', '2000', ''],
    ['SPEED_RPM', 'ความเร็วรอบเครื่องยนต์', 'rpm', 'Engine', '', '1450', '1550', ''],
    ['TT_BRG_DE', 'ลูกปืนหน้าเครื่อง', '°C', 'Engine', '', '', '90', '100'],
    ['TT_BRG_NDE', 'ลูกปืนหลังเครื่อง', '°C', 'Engine', '', '', '90', '100'],
    ['TT_LO_IN', 'อุณหภูมิน้ำมันหล่อลื่นขาเข้า', '°C', 'ระบบน้ำมันหล่อลื่น', '', '50', '75', ''],
    ['TT_EXH_A', 'อุณหภูมิไอเสียฝั่ง A', '°C', 'Engine', '', '', '550', ''],
    ['VIB_GEN', 'การสั่นสะเทือนเครื่องกำเนิด', 'mm/s', 'Engine', '', '', '4.5', '7.1'],
]
write('projects/GEG-tags-D-thai.csv', GEG_TAGS_HEAD, GEG_TH)
note('projects/GEG-tags-D-thai.csv', ['MULTI-15 (โปรเจกต์ D)', 'WFF-4 (แบบ CSV UTF-8)'],
     ['tag เดียวกับ GEG-tags.csv แต่ภาษาไทย บันทึกแบบ UTF-8 · TT_BRG_DE = "ลูกปืนหน้าเครื่อง" · Component "Engine" · ALARM_H 90'])
write('projects/GEG-tags-thai-saved-as-plain-CSV.csv', GEG_TAGS_HEAD,   # cp874 has no "°": Excel writes "?" there
      [[c.replace('°', '?') for c in r] for r in GEG_TH], enc='cp874', crlf=True)
note('projects/GEG-tags-thai-saved-as-plain-CSV.csv', ['WFF-4 (แบบแรก)'],
     ['เนื้อหาเหมือน GEG-tags-D-thai.csv แต่บันทึกแบบที่ Excel ภาษาไทยทำเมื่อเลือก "CSV (Comma delimited)" (ไม่ใช่ UTF-8)',
      'เปิดใน Notepad จะเห็นภาษาไทยถูก แต่โปรแกรมควรบอกว่าอ่านไม่ได้และให้บันทึกเป็น CSV UTF-8 (อาจเห็นคำว่า "invalid utf-8")'])
chg = [list(r) for r in GEG_EN]
chg[2][1] = 'Bearing DE temp (CHANGED)'
chg[4][3] = 'Engine'
chg[2][6] = '92'
write('projects/GEG-tags_changed.csv', GEG_TAGS_HEAD, chg)
note('projects/GEG-tags_changed.csv', ['WFF-5'],
     ['เหมือน GEG-tags.csv แต่: TT_BRG_DE description "(CHANGED)" + ALARM_H 92 (เดิม 95) · TT_LO_IN component "Engine" (เดิม Lube oil)',
      'วิธีใช้: ปิดโปรแกรม → คัดลอกไปทับ GEG-tags.csv แล้วเปลี่ยนชื่อเป็นชื่อเดิม (WFF-5 ให้แก้ไฟล์เดิมที่ตำแหน่งเดิม)'])

CMP_HEAD = ['timestamp', 'PT_SUC', 'PT_DIS', 'TT_DIS', 'FT_GAS', 'KW_CMP', 'VIB_CMP']
rnd = random.Random(55)
ct = series(datetime(2025, 1, 1), 90 * 144, timedelta(minutes=10))
cr = []
for t in ct:
    off = datetime(2025, 2, 3) <= t < datetime(2025, 2, 4)
    kw = 0.0 if off else 800 + 60 * math.sin(2 * math.pi * t.hour / 24) + rnd.gauss(0, 10)
    cr.append([ts(t), round(1.2 + rnd.gauss(0, 0.03), 3), round(1.2 if off else 8.5 + 0.002 * kw + rnd.gauss(0, 0.08), 3),
               round(35 if off else 110 + 0.02 * kw + rnd.gauss(0, 1), 2), round(0 if off else 3200 + 2 * kw + rnd.gauss(0, 40), 1),
               round(kw, 1), round(0.3 if off else 3.1 + rnd.gauss(0, 0.25), 3)])
write('projects/CMP-1.csv', CMP_HEAD, cr)
write('projects/CMP-1-tags.csv', GEG_TAGS_HEAD, [
    ['PT_SUC', 'Suction pressure', 'barg', 'Compressor K-1', '', '0.8', '', ''],
    ['PT_DIS', 'Discharge pressure', 'barg', 'Compressor K-1', '', '', '10.5', '11'],
    ['TT_DIS', 'Discharge gas temperature', '°C', 'Gas cooler E-1', '', '', '135', ''],
    ['FT_GAS', 'Gas flow', 'Nm3/h', 'Compressor K-1', '', '2000', '', ''],
    ['KW_CMP', 'Compressor motor power', 'kW', 'Motor M-2', '', '', '1000', ''],
    ['VIB_CMP', 'Compressor vibration', 'mm/s', 'Compressor K-1', '', '', '7.1', '11']])
note('projects/CMP-1.csv + CMP-1-tags.csv', ['PREP-5 (โปรเจกต์ B)', 'MULTI'], stats_lines(ct, CMP_HEAD, cr) + [
    'เครื่องอัดก๊าซ — tag / component คนละชุดกับ GEG-3 ทั้งหมด (Compressor K-1, Gas cooler E-1, Motor M-2)',
    'เครื่องหยุด 2025/02/03 00:00 → 23:50 · Running condition แนะนำ "KW_CMP is above 100"'])

# ─────────────────────────────── exp-variants/ (optional) ───────────────────────────────
if EXP:
    src = os.path.join(EXP, 'EXP-data.csv')
    if not os.path.exists(src):
        print(f'--expdata: {src} not found — skipped exp-variants/ (run make-export-testdata.py first)')
    else:
        with open(src, newline='', encoding='utf-8') as f:
            data = list(csv.reader(f))
        h0, body = data[0], data[1:]
        rnd = random.Random(381)
        write('exp-variants/EXP-data_with-A-B-columns.csv', h0 + ['A B', 'A/B'],
              [r + [round(10 + rnd.gauss(0, 1), 2), round(20 + rnd.gauss(0, 1), 2)] for r in body])
        note('exp-variants/EXP-data_with-A-B-columns.csv', ['BMW-381'],
             [f'EXP-data.csv ({len(body):,} แถว) + คอลัมน์ "A B" (ประมาณ 10) และ "A/B" (ประมาณ 20) ครบทุกแถว — ใช้คู่กับ EXP-tags.csv',
              'Export แล้วต้องได้ A_B-I1 และ A_B-I2 (ไม่เขียนทับกัน)'])
        for col, rel, why in [('KW', 'exp-variants/EXP-data_without-KW.csv', 'sensor ของ Running condition "KW is above 50" (รอบที่ 2)'),
                              ('FLOW A', 'exp-variants/EXP-data_without-FLOW-A.csv', 'sensor ของโมเดล FLOW_A-R1 (รอบที่ 1)')]:
            j = h0.index(col)
            write(rel, h0[:j] + h0[j + 1:], [r[:j] + r[j + 1:] for r in body])
            note(rel, ['BMW-396'], [f'EXP-data.csv ที่ไม่มีคอลัมน์ {col} — {why}',
                                    'วิธีใช้: ปิดโปรแกรม → เก็บสำเนา EXP-data.csv → คัดลอกไฟล์นี้ไปทับ แล้วเปลี่ยนชื่อเป็น EXP-data.csv → คืนไฟล์เดิมเมื่อจบ'])

# ─────────────────────────────── big/ and wfg/ (--big) ───────────────────────────────
HM = [f'{m // 60:02d}:{m % 60:02d}:00' for m in range(1440)]


def pool_rows(n_sensors, size, seed, empty_p=0.005, texts=None, text_p=0.0):
    rnd = random.Random(seed)
    base = [rnd.uniform(5, 500) for _ in range(n_sensors)]
    amp = [b * rnd.uniform(0.02, 0.1) for b in base]
    pool, text_idx = [], []
    for j in range(size):
        vals, tix = [], []
        for s in range(n_sensors):
            r = rnd.random()
            if r < empty_p:
                vals.append('')
            elif texts and r < empty_p + text_p:
                vals.append(rnd.choice(texts)); tix.append(s)
            else:
                vals.append(f'{base[s] + amp[s] * math.sin(2 * math.pi * j / size * (1 + s % 5)) + rnd.gauss(0, amp[s] / 5):.2f}')
        pool.append(','.join(vals))
        text_idx.append(tix)
    return pool, text_idx


def big_write(rel, n_sensors, pool, start, first_idx, n_rows=None, target=None):
    """Rows i = first_idx .. : time = start + i minutes, values = pool[i % len(pool)]. Stops at n_rows or at target bytes."""
    path = p(*rel.split('/'))
    head = 'timestamp,' + ','.join(f'S{s:03d}' for s in range(1, n_sensors + 1)) + '\n'
    size, i, written = len(head), first_idx, 0
    P = len(pool)
    with open(path, 'w', newline='', encoding='utf-8', buffering=8 * 1024 * 1024) as f:
        f.write(head)
        while True:
            day = start + timedelta(minutes=i)
            d0 = day.replace(hour=0, minute=0)
            ds = d0.strftime('%Y-%m-%d ')
            m0 = day.hour * 60 + day.minute
            chunk = []
            for m in range(m0, 1440):
                line = ds + HM[m] + ',' + pool[i % P] + '\n'
                chunk.append(line)
                size += len(line)
                i += 1; written += 1
                if (n_rows is not None and written >= n_rows) or (target is not None and size >= target):
                    break
            f.write(''.join(chunk))
            if (n_rows is not None and written >= n_rows) or (target is not None and size >= target):
                break
    return path, written, start + timedelta(minutes=first_idx), start + timedelta(minutes=i - 1), os.path.getsize(path)


if BIG:
    t_start = time.time()
    NS = 100
    pool, _ = pool_rows(NS, 9973, 2024)
    S0 = datetime(2020, 1, 1)

    def big_note(rel, uses, res, extra=()):
        _, n, a, b, sz = res
        note(rel, uses, [f'ขนาด {sz:,} bytes ({sz / GIB:.2f} GB ตาม Windows) · {n:,} แถว · {NS} sensors (S001–S{NS:03d}) · ทุก 1 นาที',
                         f'ช่วงเวลา {fmt(a)} → {fmt(b)} · ช่องว่างประมาณ 0.5% · ไม่มีช่องข้อความ'] + list(extra))

    r = big_write('big/BIG-300MB.csv', NS, pool, S0, 0, target=int(300 * 1024 ** 2 * SCALE))
    big_note('big/BIG-300MB.csv', ['PREP-6', 'IMP-16', 'IMP-35', 'IMP-75', 'PERF-2..7', 'SPC-92', 'EDT-66', 'MULTI-10'], r)
    r = big_write('big/BIG-1_9GB.csv', NS, pool, S0, 0, target=int(1.9 * GIB * SCALE))
    big_note('big/BIG-1_9GB.csv', ['PREP-6', 'PERF-1', 'WFG-13', 'SPC-92'], r, ['ต่ำกว่าเพดาน 2 GB → ต้องอ่านได้'])
    r = big_write('big/BIG-2_1GB-over-limit.csv', NS, pool, S0, 0, target=int(2.1 * GIB * SCALE))
    N21 = r[1]
    big_note('big/BIG-2_1GB-over-limit.csv', ['PREP-6', 'IMP-72', 'WFF-2', 'WFG-13'], r,
             ['เกิน 2,147,483,648 bytes → ต้องถูกปฏิเสธทันทีด้วย "CSV file too large: 2.1 GB (max 2 GB). Pre-process or split the file."'])
    mid = N21 // 2
    r1 = big_write('big/BIG-2_1GB-part1.csv', NS, pool, S0, 0, n_rows=mid + 1440)
    r2 = big_write('big/BIG-2_1GB-part2.csv', NS, pool, S0, mid, n_rows=N21 - mid)
    big_note('big/BIG-2_1GB-part1.csv', ['WFF-2'], r1)
    big_note('big/BIG-2_1GB-part2.csv', ['WFF-2'], r2,
             [f'part1 + part2 = ไฟล์ 2.1 GB แบ่งตามเวลา ซ้อนกัน 1 วัน (1,440 แถว ค่าเหมือนกัน) → รวมแล้ว Rows = {N21:,} เท่าไฟล์เดิม',
              '"Fixed while reading" ต้องมี "1440 duplicate timestamp(s) found across files" (และอาจมี Duplicate column ทุกคอลัมน์ — ทราบแล้ว)'])
    L = int(200 * 1024 ** 2 * SCALE) // (len(pool[0]) + 21)
    for k in range(3):
        r = big_write(f'big/BIG-overlap-{k + 1}.csv', NS, pool, S0, k * (L - 3 * 1440), n_rows=L)
        big_note(f'big/BIG-overlap-{k + 1}.csv', ['PERF-8'], r, ['3 ไฟล์ ช่วงเวลาซ้อนกันไฟล์ละ 3 วัน (4,320 แถว ค่าเหมือนกัน)'] if k == 2 else [])
    note('big/(BIG-overlap-1 + 2 + 3 พร้อมกัน)', ['PERF-8'], [f'รวมแล้ว Rows = {3 * L - 2 * 4320:,} · เวลาซ้ำข้ามไฟล์ 8,640 จุด'])
    # big tag names
    write('big/BIG-tags.csv', NORM_TAGS_HEAD,
          [[f'S{s:03d}', f'Big sensor {s}', 'u', ['Engine', 'Generator', 'Lube oil', 'Cooling', 'Exhaust'][s % 5], '', '', '', '']
           for s in range(1, NS + 1)])
    note('big/BIG-tags.csv', ['IMP-16', 'PERF'], ['100 แถว S001–S100 · 5 component'])

    # WFG: 2 years every minute, 120 sensors; T001–T010 related, T011–T120 from a pool
    TEXTS = ['Bad', 'I/O Timeout']
    wpool, wtext = pool_rows(110, 10007, 2025, empty_p=0.01, texts=TEXTS, text_p=0.0003)
    rnd = random.Random(5)
    wfg_text = [0] * 120
    wfg_empty = [0] * 120
    headw = 'timestamp,' + ','.join(f'GEG5_T{s:03d}' for s in range(1, 121)) + '\n'
    AN = (datetime(2025, 8, 10), datetime(2025, 8, 12, 23, 59))
    gi = 0
    for yr in (2024, 2025):
        rel = f'wfg/GEG5_{yr}.csv'
        path = p(*rel.split('/'))
        t = datetime(yr, 1, 1)
        end = datetime(yr, 12, 31, 23, 59)
        if SCALE < 1:
            end = t + timedelta(days=max(2, int(365 * SCALE)))
        n = 0
        with open(path, 'w', newline='', encoding='utf-8', buffering=8 * 1024 * 1024) as f:
            f.write(headw)
            chunk = []
            while t <= end:
                h = t.hour + t.minute / 60
                stop = t.day == 15
                t1 = 0.0 if stop else 60 + 20 * math.sin(2 * math.pi * (h - 7) / 24) + rnd.gauss(0, 2)
                t2 = 0.8 * t1 + rnd.gauss(0, 1)
                if AN[0] <= t <= AN[1]:
                    t2 *= 1.15
                vals = [t1, t2, 25 + 0.3 * t1 + rnd.gauss(0, 0.5), 10 + 0.5 * t1 + rnd.gauss(0, 0.8),
                        30 + 3 * math.sin(2 * math.pi * (h - 9) / 24) + rnd.gauss(0, 0.4), 0.6 * t1 + 0.2 * t2 + rnd.gauss(0, 0.7),
                        40 + 0.1 * t1 + rnd.gauss(0, 0.3), 2 + 0.01 * t1 + rnd.gauss(0, 0.05), 100 - 0.2 * t1 + rnd.gauss(0, 0.6),
                        5 + 0.05 * t2 + rnd.gauss(0, 0.1)]
                cells = []
                for s, v in enumerate(vals):
                    r = rnd.random()
                    if r < 0.01:
                        cells.append(''); wfg_empty[s] += 1
                    elif r < 0.0103:
                        cells.append(TEXTS[int(r * 1e6) % 2]); wfg_text[s] += 1
                    else:
                        cells.append(f'{v:.2f}')
                pi_ = gi % len(wpool)
                for s in wtext[pi_]:
                    wfg_text[10 + s] += 1
                chunk.append(t.strftime('%Y-%m-%d %H:%M:00,') + ','.join(cells) + ',' + wpool[pi_] + '\n')
                gi += 1; n += 1
                if len(chunk) >= 20000:
                    f.write(''.join(chunk)); chunk = []
                t += timedelta(minutes=1)
            f.write(''.join(chunk))
        sz = os.path.getsize(path)
        note(rel, ['WFG-1', 'WFG-2', 'PERF-10'], [f'ขนาด {sz:,} bytes ({sz / GIB:.2f} GB) · {n:,} แถว · {yr}/01/01 00:00:00 → {fmt(end)} · ทุก 1 นาที · 120 sensors'])
    # empty counts for the pool columns
    usage = [gi // len(wpool) + (1 if j < gi % len(wpool) else 0) for j in range(len(wpool))]
    for j, row in enumerate(wpool):
        if usage[j]:
            for s, v in enumerate(row.split(',')):
                if v == '':
                    wfg_empty[10 + s] += usage[j]
    note('wfg/(GEG5_2024.csv + GEG5_2025.csv พร้อมกัน)', ['WFG-2'], [
        f'Rows = {gi:,} (2024 เป็นปีอธิกสุรทิน: 527,040 + 525,600 = 1,052,640 — แผน WFG-2 เขียน "≈ 1,051,200") · Sensors 120 · Interval 1 min',
        'เครื่องหยุดทุกวันที่ 15 ของเดือนทั้งวัน (GEG5_T001 = 0) · ช่วงผิดปกติ 2025/08/10 00:00 → 2025/08/12 23:59 (GEG5_T002 สูงกว่าปกติ 15%)',
        'GEG5_T002 ≈ 0.8 × T001 · T004 ≈ 10 + 0.5 × T001 · T006 ≈ 0.6 × T001 + 0.2 × T002 → Relation model ของ WFG-8 มีความหมาย',
        'ช่องข้อความ "Bad" / "I/O Timeout" (ต้องมีบรรทัด non-numeric ต่อคอลัมน์): '
        + ', '.join(f'GEG5_T{s + 1:03d} {c}' for s, c in enumerate(wfg_text) if c),
        f'ช่องว่างรวม {sum(wfg_empty):,} ช่อง (ประมาณ 1%)'])
    comp6 = ['Engine', 'Generator', 'Lube oil', 'Cooling water', 'Exhaust', 'Auxiliary']
    names10 = ['Generator load', 'Generator output', 'Lube oil temperature', 'Jacket water temperature', 'Ambient temperature',
               'Exhaust temperature', 'Bearing DE temperature', 'Vibration DE', 'Fuel valve position', 'Charge air pressure']
    write('wfg/GEG5-tags.csv', ['tag', 'description', 'unit', 'component', 'alarm_l', 'alarm_h'],
          [[f'GEG5_T{s:03d}', names10[s - 1] if s <= 10 else f'GEG-5 sensor {s}', 'u', comp6[(s - 1) // 20],
            '' if s % 3 else '5', '' if s % 2 else '500'] for s in range(1, 121)])
    note('wfg/GEG5-tags.csv', ['WFG-1', 'WFG-3'], ['120 แถว · 6 component (Engine, Generator, Lube oil, Cooling water, Exhaust, Auxiliary) กลุ่มละ 20 ตัว'])
    print(f'big files: {time.time() - t_start:.0f} s')

# ─────────────────────────────── EXPECTED.txt ───────────────────────────────
with open(os.path.join(OUT, 'EXPECTED.txt'), 'w', encoding='utf-8', newline='\r\n') as f:
    f.write('ชุดไฟล์ทดสอบ PREP-6 (make-prep-testdata.py) — ตัวเลขจริงของทุกไฟล์\n')
    f.write('ตารางว่าข้อไหนใช้ไฟล์ไหน: docs/testing/TEST_DATA_GUIDE.md · เวลาเขียนแบบที่โปรแกรมแสดง (YYYY/MM/DD HH:MM:SS)\n')
    if not BIG:
        f.write('ไฟล์ใหญ่ (big/, wfg/) ยังไม่ได้สร้าง — รันซ้ำพร้อม --big (ใช้ที่ว่างประมาณ 8.5 GB): python scripts/make-all-testdata.py --big\n')
    last = None
    for folder, name, uses, lines in REPORT:
        if folder != last:
            f.write('\n' + '=' * 100 + f'\n{folder}/\n' + '=' * 100 + '\n')
            last = folder
        f.write(f'\n{name}   [ใช้ใน: {", ".join(uses)}]\n')
        for ln in lines:
            f.write(f'  - {ln}\n')

count = sum(len(fs) for _, _, fs in os.walk(OUT))
print(f'wrote {count} files under {OUT} (EXPECTED.txt lists every file)')
