# Generates the "WF" test data set used by the workflow scenarios WFA-WFD in docs/testing/MANUAL_TEST_PLAN.md.
# Usage: python scripts/make-wf-testdata.py C:\WFdata   (standard library only)
import csv, math, random, sys, os
from datetime import datetime, timedelta
out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)
random.seed(42)
t, t1, step = datetime(2025,1,1), datetime(2025,6,30,23,55), timedelta(minutes=5)
inn = lambda t, a, b: a <= t <= b
STOP1 = (datetime(2025,3,10,0,0), datetime(2025,3,12,23,55))
STOP2 = (datetime(2025,5,20,18,0), datetime(2025,5,21,11,55))
GLITCH = (datetime(2025,2,20,8,0), datetime(2025,2,20,20,0))
INC = (datetime(2025,5,18,6,0), datetime(2025,5,20,17,55))
A, B, C, Cce = [], [], [], []
while t <= t1:
    stop = inn(t, *STOP1) or inn(t, *STOP2)
    h = t.hour + t.minute / 60; day = t.timetuple().tm_yday
    kw = 0.0 if stop else 180 + 20*math.sin(2*math.pi*(h-6)/24) + random.gauss(0, 3)
    amp = 0.0 if stop else kw*1.65 + random.gauss(0, 4)
    flow = 0.0 if stop else 450 + 0.5*(kw-180) + random.gauss(0, 8)
    dp = 0.0 if stop else 3.2 + 0.004*(kw-180) + random.gauss(0, 0.05)
    cw_in = 28 + 5*day/181 + random.gauss(0, 0.4)
    cw_out = cw_in + (1.0 if stop else 6.0) + random.gauss(0, 0.3)
    amb = 30 + 3*math.sin(2*math.pi*(h-9)/24) + random.gauss(0, 0.8)
    de = 35 + random.gauss(0, 1) if stop else 20 + 0.15*kw + 0.6*cw_in + random.gauss(0, 0.8)
    nde = 33 + random.gauss(0, 1) if stop else 55 + random.gauss(0, 1.5)
    vde = 0.2 + abs(random.gauss(0, .05)) if stop else 2.0 + random.gauss(0, .2)
    vnde = 0.2 + abs(random.gauss(0, .05)) if stop else 1.8 + random.gauss(0, .2)
    if inn(t, *GLITCH): de += 12
    if inn(t, *INC):
        f = (t-INC[0]) / (INC[1]-INC[0]); de += 26*f; vde = 2.0 + 4.5*f + random.gauss(0, .15)
    ts = t.strftime('%Y-%m-%d %H:%M:%S')
    A.append([ts, round(flow,2), round(dp,3), round(kw,2), round(amp,2), round(cw_in,2)])
    B.append([ts, round(de,2), round(nde,2), round(vde,3), round(vnde,3)])
    C.append([str(t.year+543)+ts[4:], round(cw_out,2), round(amb,2)])
    Cce.append([ts, round(cw_out,2), round(amb,2)])
    t += step
def w(name, head, rows):
    with open(os.path.join(out, name), 'w', newline='', encoding='utf-8') as f:
        c = csv.writer(f); c.writerow(head); c.writerows(rows)
w('WF-A-process.csv', ['timestamp','P101_FLOW','P101_DP','M101_KW','M101_AMP','CW_IN_TEMP'], A)
w('WF-B-bearing.csv', ['timestamp','BRG_DE_TEMP','BRG_NDE_TEMP','VIB_DE','VIB_NDE'], B)
w('WF-C-cooling-BE.csv', ['timestamp','CW_OUT_TEMP','AMB_TEMP'], C)
w('WF-C-cooling-CE.csv', ['timestamp','CW_OUT_TEMP','AMB_TEMP'], Cce)
w('WF-tags.csv', ['TAG','DESCRIPTION','UNIT','COMPONENT','ALARM_LL','ALARM_L','ALARM_H','ALARM_HH'], [
 ['P101_FLOW','Pump P-101 discharge flow','m3/h','Pump P-101','','300','600',''],
 ['P101_DP','Pump P-101 differential pressure','bar','Pump P-101','','2','5',''],
 ['M101_KW','Motor M-101 power','kW','Motor M-101','','','250','280'],
 ['M101_AMP','Motor M-101 current','A','Motor M-101','','','400',''],
 ['CW_IN_TEMP','Cooling water inlet temperature','°C','Cooling water','','','38',''],
 ['CW_OUT_TEMP','Cooling water outlet temperature','°C','Cooling water','','','45',''],
 ['BRG_DE_TEMP','Bearing DE temperature','°C','Pump P-101','10','20','80','90'],
 ['BRG_NDE_TEMP','Bearing NDE temperature','°C','Pump P-101','','20','80','90'],
 ['VIB_DE','Vibration DE','mm/s','Pump P-101','','','4.5','7.1'],
 ['VIB_NDE','Vibration NDE','mm/s','Pump P-101','','','4.5','7.1'],
 ['AMB_TEMP','Ambient temperature','°C','Site','','','',''],
])
