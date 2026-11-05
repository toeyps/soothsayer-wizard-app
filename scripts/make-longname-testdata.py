# Generates the "long sensor names" test data (LN section; file-to-item map: docs/testing/TEST_DATA_GUIDE.md).
#
# Usage (standard library only):
#   python scripts/make-all-testdata.py                        # the usual way: every test-data folder
#   python scripts/make-longname-testdata.py C:\WizardTestData\LN   # this set alone (about 15 MB, a few seconds)
#
# Each data file gets a tag-name file listing exactly its sensors (required on step 2); this script checks the pair.
#
#   LN-long.csv + LN-long-tags.csv            names of 60-150+ characters that share a start and differ at the end
#   LN-long-tags-no-descriptions.csv          the same tags, every description blank: a project whose sensors show
#                                             their tag alone (the only way to get one now that the file is required)
#   LN-medium.csv + LN-medium-tags.csv        37-60 character names, A/B and DE/NDE differ in the middle
#   LN-short.csv + LN-short-tags.csv          short names: must look exactly as before
#   LN-wide-4748.csv + LN-wide-4748-tags.csv  4,748 sensors: a very long Sensor panel and picker
import csv, math, os, random, sys
from datetime import datetime, timedelta

args = [a for a in sys.argv[1:] if not a.startswith('--')]
OUT = args[0] if args else '.'
os.makedirs(OUT, exist_ok=True)

TAG_HEAD = ['tag', 'description', 'unit', 'component']
RUN_TAG = 'KW-9001'
REPORT = []


def path(name):
    return os.path.join(OUT, name)


def write_csv(name, head, rows):
    with open(path(name), 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(head)
        w.writerows(rows)


def stamp(t):
    return t.strftime('%Y-%m-%d %H:%M:%S')


def make_data(name, sensors, days, step_min, seed):
    """`sensors`: (tag, description, unit, component). Values follow machine power; the machine stops on day 10."""
    rnd = random.Random(seed)
    start = datetime(2025, 1, 1)
    n = days * 24 * 60 // step_min
    tags = [s[0] for s in sensors]
    # One base level + one power slope per sensor, fixed for the whole file.
    params = [(rnd.uniform(20, 80), rnd.uniform(0.005, 0.03), rnd.uniform(0.2, 1.0)) for _ in tags]
    rows = []
    for i in range(n):
        t = start + timedelta(minutes=i * step_min)
        off = datetime(2025, 1, 10) <= t < datetime(2025, 1, 11)
        kw = 0.0 if off else 800 + 120 * math.sin(2 * math.pi * i * step_min / 1440) + 80 * math.sin(2 * math.pi * i * step_min / 10080) + rnd.gauss(0, 12)
        row = [stamp(t)]
        for tag, (base, slope, noise) in zip(tags, params):
            if tag == RUN_TAG:
                row.append(round(kw, 1))
            elif off:
                row.append(round(base * 0.4 + rnd.gauss(0, 0.1), 2))
            else:
                row.append(round(base + slope * kw + rnd.gauss(0, noise), 3))
        rows.append(row)
    write_csv(name, ['timestamp'] + tags, rows)
    return n


def check_pair(data_name, tag_name):
    """Step 2's tag-file rule, checked so a generated pair is never refused by the app."""
    with open(path(data_name), newline='', encoding='utf-8') as f:
        head = next(csv.reader(f))
    with open(path(tag_name), newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    data_tags, file_tags = head[1:], [r['tag'] for r in rows]
    if len(set(data_tags)) != len(data_tags):
        raise SystemExit(f'{data_name}: a column appears twice')
    if set(data_tags) != set(file_tags) or len(file_tags) != len(data_tags):
        raise SystemExit(f'{tag_name} does not match {data_name}')
    return len(data_tags)


CROSSHEAD = []
for slide in ('11A', '11B'):
    for seg in range(1, 5):
        for end in ('avg', 'max', 'min'):
            # The tag only re-spells the description ("SegmentNo" / "Segment No"): the tag line is not printed.
            CROSSHEAD.append((
                f'Crosshead (P-P Trend) - Vibration crosshead slide {slide} - SegmentNo {seg} - {end}',
                f'Crosshead (P-P Trend) - Vibration crosshead slide {slide} - Segment No {seg} - {end}',
                'mm/s', 'Crosshead'))
CYLINDER = [
    (f'CYL{c}-TE-10{i}', f'Cylinder {c} (Head End) - Discharge valve cover temperature - Channel {ch} - avg', 'DEGC', 'Cylinder')
    for c in (1, 2, 3) for i, ch in ((1, 'A'), (2, 'B'))
]
ANALYZER = [
    ('AI-5101', 'Flue gas oxygen concentration analyzer sample line downstream of air heater outlet channel A', '%', 'Analyzer'),
    ('AI-5102', 'Flue gas oxygen concentration analyzer sample line downstream of air heater outlet channel B', '%', 'Analyzer'),
    ('AI-5103', 'Flue gas carbon monoxide concentration analyzer sample line downstream of air heater outlet channel A', 'ppm', 'Analyzer'),
    ('AI-5104', 'Flue gas carbon monoxide concentration analyzer sample line downstream of air heater outlet channel B', 'ppm', 'Analyzer'),
]
ODD = [
    # No spaces at all: the end is cut, never the middle.
    ('TE-6101', 'GENERATOR_STATOR_WINDING_TEMPERATURE_PHASE_U_SLOT_12_RTD_A_MEASURED_AT_THE_TERMINAL_END', 'DEGC', 'Generator'),
    ('TE-6102', 'GENERATOR_STATOR_WINDING_TEMPERATURE_PHASE_V_SLOT_12_RTD_A_MEASURED_AT_THE_TERMINAL_END', 'DEGC', 'Generator'),
    # A short description with a long tag that really differs: in a tooltip the description gets the room first.
    ('Train-1-Stage-1-Suction-Scrubber-Inlet-Header-PT-8101-Redundant-Channel-A', 'Suction pressure', 'barg', 'Generator'),
    # 150+ characters.
    ('LT-7001', 'Main lube oil reservoir level - Primary transmitter on the north side of the tank near the duplex filter inlet with a very long note about its location - avg', '%', 'Lube oil'),
    # No description, in a project that has them for everything else: the tag is the name.
    ('Main lube oil header pressure transmitter downstream of duplex filter - PT-7101 - Channel A - avg', '', 'barg', 'Lube oil'),
    ('Main lube oil header pressure transmitter downstream of duplex filter - PT-7101 - Channel B - avg', '', 'barg', 'Lube oil'),
]
MACHINE = [(RUN_TAG, 'Main motor active power', 'kW', 'Machine'), ('II-9002', 'Main motor current', 'A', 'Machine')]
LONG = CROSSHEAD + CYLINDER + ANALYZER + ODD + MACHINE
n_long = make_data('LN-long.csv', LONG, 30, 5, 1)
write_csv('LN-long-tags.csv', TAG_HEAD, [list(s) for s in LONG])
write_csv('LN-long-tags-no-descriptions.csv', TAG_HEAD, [[s[0], '', s[2], s[3]] for s in LONG])

MEDIUM = []
for pump_name, short, comp in (('Boiler feed pump', 'BFP', 'Boiler feed pumps'), ('Condensate extraction pump', 'CEP', 'Condensate pumps')):
    for side in ('A', 'B'):
        for i, what in ((1, 'Motor bearing DE temperature'), (2, 'Motor bearing NDE temperature'), (3, 'Discharge pressure')):
            MEDIUM.append((f'U8-{short}{side}-T{i:02d}', f'{pump_name} {side} - {what}', 'barg' if i == 3 else 'DEGC', comp))
MEDIUM += [(RUN_TAG, 'Unit 8 gross load', 'kW', 'Unit')]
n_medium = make_data('LN-medium.csv', MEDIUM, 30, 5, 2)
write_csv('LN-medium-tags.csv', TAG_HEAD, [list(s) for s in MEDIUM])

SHORT = [
    ('TT_BRG_DE', 'Bearing DE temp', 'DEGC', 'Generator'),
    ('TT_BRG_NDE', 'Bearing NDE temp', 'DEGC', 'Generator'),
    ('FT_A', 'Pump A flow', 'm3/h', 'Pump'),
    ('FT_B', 'Pump B flow', 'm3/h', 'Pump'),
    ('PT_LO', 'Lube oil pressure', 'barg', 'Lube oil'),
    ('TT_LO', 'Lube oil temp', 'DEGC', 'Lube oil'),
    ('VIB_DE', 'Vibration DE', 'mm/s', 'Generator'),
    (RUN_TAG, 'Active power', 'kW', 'Machine'),
]
n_short = make_data('LN-short.csv', SHORT, 30, 5, 3)
write_csv('LN-short-tags.csv', TAG_HEAD, [list(s) for s in SHORT])

WIDE_COUNT = 4748
WIDE = [(RUN_TAG, 'Main motor active power', 'kW', 'Machine')]
FAMILIES = (('Crosshead (P-P Trend) - Vibration crosshead slide', 'Crosshead'),
            ('Piston rod (Peak Trend) - Rod drop proximity probe', 'Piston rod'),
            ('Packing case (Gas Trend) - Leakage temperature channel', 'Packing'),
            ('Valve cover (Temp Trend) - Discharge valve thermocouple', 'Valve cover'))
filled = False
for row_no in range(1, 100):
    for fam, comp in FAMILIES:
        for side in ('A', 'B'):
            for seg in range(1, 21):
                for end in ('avg', 'max', 'min'):
                    if len(WIDE) == WIDE_COUNT:
                        filled = True
                        break
                    WIDE.append((f'{fam} {row_no}{side} - SegmentNo {seg} - {end}', f'{fam} {row_no}{side} - Segment No {seg} - {end}', 'mm/s', comp))
                if filled:
                    break
            if filled:
                break
        if filled:
            break
    if filled:
        break
n_wide = make_data('LN-wide-4748.csv', WIDE, 14, 60, 4)
write_csv('LN-wide-4748-tags.csv', TAG_HEAD, [list(s) for s in WIDE])

# Same description, tags that differ only at the end: the shape of a real tag-name file.
SAME_DESC = []
for seg in (1, 2):
    desc = f'Crosshead (P-P Trend) - Vibration crosshead slide 11A - SegmentNo {seg}'
    for end in ('avg', 'max', 'min'):
        SAME_DESC.append((f'{desc} - {end}', desc, 'mm/s', 'Crosshead'))
n_same = make_data('LN-same-description.csv', SAME_DESC, 30, 5, 5)
write_csv('LN-same-description-tags.csv', TAG_HEAD, [list(s) for s in SAME_DESC])

count_same = check_pair('LN-same-description.csv', 'LN-same-description-tags.csv')
count_long = check_pair('LN-long.csv', 'LN-long-tags.csv')
check_pair('LN-long.csv', 'LN-long-tags-no-descriptions.csv')
count_medium = check_pair('LN-medium.csv', 'LN-medium-tags.csv')
count_short = check_pair('LN-short.csv', 'LN-short-tags.csv')
count_wide = check_pair('LN-wide-4748.csv', 'LN-wide-4748-tags.csv')
if count_wide != WIDE_COUNT:
    raise SystemExit(f'LN-wide-4748.csv has {count_wide} sensors')

lines = [
    'ชุดข้อมูล LN — ชื่อ sensor ยาว (ใช้กับหมวด LN ในแผนทดสอบ)',
    'ทุกไฟล์: ช่วงเวลาเริ่ม 2025/01/01 00:00:00 · เครื่องหยุด 2025/01/10 ทั้งวัน · Running condition แนะนำ: "Main motor active power" (KW-9001) is above 100',
    'ไฟล์ Tag names ทุกไฟล์ใช้คอลัมน์ tag ชื่อ tag',
    '',
    f'LN-long.csv + LN-long-tags.csv: {count_long} sensor, {n_long:,} แถว, ทุก 5 นาที, 30 วัน',
    f'  Crosshead {len(CROSSHEAD)} ตัว (ชื่อขึ้นต้นเหมือนกัน ต่างที่ท้าย, tag แค่สะกดต่างจากชื่อ: SegmentNo / Segment No) · Cylinder {len(CYLINDER)} ตัว (tag ต่างจากชื่อจริง)',
    f'  Analyzer {len(ANALYZER)} ตัว (ชื่อยาว ไม่มี " - ") · Generator 3 ตัว (ชื่อไม่มีช่องว่าง 2 ตัว, ชื่อสั้นแต่ tag ยาว 1 ตัว) · Lube oil 3 ตัว (ชื่อยาวเกิน 150 ตัวอักษร 1 ตัว, ไม่มี description 2 ตัว) · Machine 2 ตัว',
    f'LN-long-tags-no-descriptions.csv: tag ชุดเดียวกับ LN-long.csv ({count_long} ตัว) ทุกแถวไม่มี description → sensor ทุกตัวแสดง tag อย่างเดียว',
    f'LN-medium.csv + LN-medium-tags.csv: {count_medium} sensor, {n_medium:,} แถว · ชื่อเช่น "Boiler feed pump A - Motor bearing DE temperature" (ต่างกันตรงกลาง A / B และ DE / NDE)',
    f'LN-short.csv + LN-short-tags.csv: {count_short} sensor, {n_short:,} แถว · ชื่อสั้นทุกตัว',
    f'LN-same-description.csv + LN-same-description-tags.csv: {count_same} sensor, {n_same:,} แถว · description ซ้ำกัน tag ต่างกันแค่ท้าย avg / max / min',
    f'LN-wide-4748.csv + LN-wide-4748-tags.csv: {count_wide:,} sensor, {n_wide:,} แถว, ทุก 1 ชั่วโมง, 14 วัน · component 5 กลุ่ม (Crosshead, Piston rod, Packing, Valve cover, Machine)',
]
with open(path('EXPECTED.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')
print(f'Wrote the LN set to {OUT}: {count_long} long, {count_medium} medium, {count_short} short, {count_wide} wide sensors')
