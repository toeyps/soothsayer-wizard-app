# ไฟล์ทดสอบ — ข้อไหนใช้ไฟล์ไหน

> **เริ่มที่นี่:** ลำดับการทดสอบทีละรอบ (รอบละตัวติดตั้งเดียว + ชุดข้อมูลเดียว) อยู่ใน `TEST_ROUNDS.md`


**ก่อนเริ่มทดสอบ รันคำสั่งนี้ครั้งเดียว:** เปิด Command Prompt ที่โฟลเดอร์โปรเจกต์โปรแกรม แล้วพิมพ์ `python scripts/make-all-testdata.py` → ได้ไฟล์ทดสอบทุกชุดในโฟลเดอร์ `C:\WizardTestData` (ใช้เวลาไม่กี่วินาที ประมาณ 35 MB)

- ต้องมี Python ในเครื่อง — ถ้าไม่มี ขอโฟลเดอร์ `C:\WizardTestData` ที่สร้างไว้แล้วจากทีม dev
- **ไฟล์ใหญ่** (หลายร้อย MB ถึงเกิน 2 GB และข้อมูล 2 ปีของ WFG) ไม่ได้สร้างให้ตอนแรก เพราะกินที่มาก — ถ้าจะทดสอบหมวดที่ต้องใช้ ให้รัน `python scripts/make-all-testdata.py --big` (ต้องมีที่ว่างในไดรฟ์ C ประมาณ **8.5 GB** ใช้เวลาประมาณ **3–10 นาที** บน SSD)
- ทุกโฟลเดอร์มีไฟล์ `EXPECTED.txt` (เปิดด้วย Notepad) บอก **ตัวเลขจริงของแต่ละไฟล์**: จำนวนแถว, ช่วงเวลาแรก → สุดท้าย, ระยะห่างระหว่างแถว, จำนวนช่องว่าง / ช่องที่เป็นข้อความ และผลที่ต้องเห็น — ใช้เทียบกับหน้าจอได้เลย ไม่ต้องนับเอง
- รันคำสั่งซ้ำได้ทุกเมื่อ ได้ไฟล์เหมือนเดิมทุกตัวอักษร (เช่น หลังเผลอแก้หรือลบไฟล์)
- แบบฟอร์ม `manual-test-plan.html` แสดงบรรทัด "ไฟล์ที่ใช้" ในแต่ละข้อ (อ่านจากกล่องในข้อ 6 ของหน้านี้) — หน้านี้คือฉบับเต็ม

---

## 1. โฟลเดอร์ทั้งหมด

| โฟลเดอร์ | สร้างด้วย (`make-all-testdata.py` ทำให้ครบทุกตัว) | ข้างในมีอะไร |
|---|---|---|
| `C:\WizardTestData\WF` | `python scripts/make-wf-testdata.py C:\WizardTestData\WF` | ข้อมูลเครื่องสูบน้ำ P-101 6 เดือน (3 ไฟล์ + ไฟล์ปี พ.ศ.) + Tag names — ใช้กับ workflow WFA–WFD, WFH และหมวดทดสอบทีละฟังก์ชันส่วนใหญ่ |
| `C:\WizardTestData\TS` | `python scripts/make-ts-testdata.py C:\WizardTestData\TS` | ไฟล์ที่เขียนวันเวลาหลายรูปแบบ (`formats`), ไฟล์สำหรับรวม (`merge`), ข้อมูล 6 เดือน 3 แหล่ง (`scenario`) |
| `C:\WizardTestData\EXP` | `python scripts/make-export-testdata.py C:\WizardTestData\EXP` | ข้อมูลสำหรับ Export results: ชื่อ sensor แปลก ๆ, ตัวเลขยาก ๆ, เครื่องใหญ่ 37 sensor |
| `C:\WizardTestData\IMP` | `python scripts/make-prep-testdata.py C:\WizardTestData\IMP` (ไฟล์ใหญ่: เติม `--big`) | ชุดไฟล์ของ PREP-6 (ปกติ / หลายไฟล์ / Tag names / ปี พ.ศ. / ข้อมูลแปลก / ไฟล์เสีย / รูปแบบเวลา) + เครื่อง GEG-3, GEG-4, CMP-1 สำหรับ PREP-5, MULTI, WFE, WFF + ไฟล์ใหญ่ (`--big`) |

---

## 2. ไฟล์ในแต่ละโฟลเดอร์ และข้อที่ใช้

### `C:\WizardTestData\WF` — เครื่องสูบน้ำ P-101 (ม.ค.–มิ.ย. 2025 ทุก 5 นาที)

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `WF-A-process.csv` | flow, ความดัน, กำลังมอเตอร์, กระแส, น้ำหล่อเย็นขาเข้า | WFA-1, WFA-3 แล้วต่อเนื่องทั้ง WFA–WFD, WFH |
| `WF-B-bearing.csv` | อุณหภูมิ bearing DE / NDE, การสั่น | WFA-1, WFA-3 (และต่อเนื่อง) |
| `WF-C-cooling-BE.csv` | น้ำหล่อเย็นขาออก + อุณหภูมิอากาศ — **เวลาเป็นปี พ.ศ.** | WFA-1, WFA-3 |
| `WF-C-cooling-CE.csv` | เหมือนไฟล์บนแต่เป็นปี ค.ศ. (ใช้แทนเมื่อ WFA-3 ไม่ผ่าน) | WFA-3 |
| `WF-tags.csv` | Tag names ของทั้ง 11 sensor | WFA-4 |

### `C:\WizardTestData\TS` — รูปแบบวันเวลา

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `EXPECTED.txt` | แถวแรก / แถวสุดท้าย / จำนวนแถว / ข้อความกล่องเหลืองของทุกไฟล์ | IMP-89 ถึง IMP-99 |
| `formats\F01` … `F22` | ไฟล์ละ 1 รูปแบบวันเวลา (วันของใครของมัน นำเข้าพร้อมกันได้) | IMP-89, IMP-90, IMP-91, IMP-92, IMP-93, IMP-94, IMP-95, IMP-96, IMP-97 · F09 / F10 / F14 / F16 ใช้กับบรรทัด "รูปแบบอื่น" ของ IMP-88 |
| `formats\TS-tags.csv` | Tag names ที่มีอักขระซ่อนต้นไฟล์ | IMP-99 |
| `merge\M1_iso.csv` + `M1_us_ampm.csv` | เวลาเดียวกันเขียนสองแบบ | IMP-98 (โปรเจกต์ 1) |
| `merge\M2_part1.csv` + `M2_part2.csv` | ไฟล์ที่มีคอลัมน์ร่วมกัน | IMP-98 (โปรเจกต์ 2) |
| `merge\M3_column_twice.csv` | คอลัมน์ชื่อซ้ำ | IMP-98 (โปรเจกต์ 3) |
| `scenario\I-1_…`, `I-2_…`, `I-3_…`, `I-tags.csv` | เครื่องเดียวกัน 6 เดือน จาก 3 แหล่ง 3 รูปแบบ | WFI-1 ถึง WFI-4 |

### `C:\WizardTestData\EXP` — ข้อมูลสำหรับ Export results

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `EXP-data.csv` + `EXP-tags.csv` | 30 วัน ชื่อ sensor ที่มีช่องว่าง `/` ภาษาไทย ชื่อต้องห้ามของ Windows, เวลาซ้ำ 3 จุด, แถวไม่มีเวลา 2 แถว | BMW-355 ถึง BMW-403 (หมวด Export ใน BMW), WFJ ทั้งหมด, WFK-5 |
| `EXP-numbers.csv` + `EXP-numbers-tags.csv` | ตัวเลขที่ปัดพลาดง่าย (ทศนิยมยาว, ติดลบ, เล็กมาก, ใหญ่มาก, `1.5E-05`) + sensor เดินเครื่อง RUN | WFK-1 ถึง WFK-10 |
| `EXP-fleet.csv` + `EXP-fleet-tags.csv` | เครื่องใหญ่ 37 sensor 6 component | WFK-11, WFK-12 |
| `EXPECTED.txt` | ชื่อไฟล์ที่ต้องได้ จำนวนแถว ค่าเฉลี่ย / SD ของทุกโมเดล | BMW-402, BMW-403, WFJ, WFK |

### `C:\WizardTestData\IMP` — ชุดไฟล์ PREP-6 และเครื่องสำหรับ MULTI / WFE / WFF

**`normal\` — ไฟล์ปกติ**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `IMP-normal.csv` | 30 วัน (1–30 ม.ค. 2024) ทุก 5 นาที 7 sensor 3 component · ช่องว่าง 24 ช่อง (% empty "<0.1%") · เครื่องหยุด 10–11 ม.ค. | PREP-6, IMP-34, IMP-36, IMP-38, IMP-46, IMP-60, IMP-61, IMP-62, IMP-70 (ไฟล์ที่ถูก), IMP-81 (ไฟล์ A), IMP-14 · ใช้เป็นโปรเจกต์ทั่วไปของ SEN / SEL / FIL / HL / TIME / LINE / SCAT / PAIR / SPC / MNG / EDT / FG ได้ |
| `IMP-normal-tags.csv` | Tag names: ช่อง alarm บางช่องว่าง บางช่องเป็น `-`, tag ที่ไม่มีในข้อมูล 3 ตัว, VI-501 ไม่มีชื่อ, TT-601 ไม่มี component | IMP-38, IMP-76, IMP-14, IMP-81, IMP-82, SEN-1, SEN-2, SEN-4, SEL-9, FG-26 |
| `IMP-normal_saved-as-CSV-UTF-8.csv` | ข้อมูลเดียวกัน บันทึกแบบที่ Excel ทำเมื่อเลือก "CSV UTF-8" | WFF-1 |
| `IMP-normal_this_is_a_very_long_file_name_…csv` | ข้อมูลเดียวกัน ชื่อไฟล์ยาวมาก | IMP-45 |

**`multi-file\` — หลายไฟล์**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `MF-overlap-1.csv`, `-2.csv`, `-3.csv` | 3 ไฟล์ ช่วงเวลาซ้อนกันบางส่วน (รวมแล้ว 6,912 แถว) | PREP-6, IMP-35, IMP-36, IMP-86, PERF-8 (ฉบับเล็ก) |
| `MF-adjacent-1.csv`, `-2.csv` | 2 ไฟล์ช่วงเวลาต่อกันพอดี ไม่ซ้อน | PREP-6, IMP-36, IMP-86 |
| `MF-samecol-1.csv`, `-2.csv` | คู่ไฟล์ที่มีคอลัมน์ TI-101 ซ้ำกันข้ามไฟล์ | PREP-6, IMP-36 |
| `MF-extra-columns-B.csv` | ไฟล์ B ที่มีคอลัมน์เพิ่ม (2 ตัวมีชื่อใน Tag names, 1 ตัวไม่มี) | IMP-81 |
| `MF-set-1.csv`, `MF-set-2-BROKEN.csv`, `MF-set-3.csv` | 3 ไฟล์ ไฟล์ที่ 2 เสีย | IMP-73 |

**`tags\` — ไฟล์ Tag names แบบต่าง ๆ** (ใช้คู่กับ `normal\IMP-normal.csv`)

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `T01-other-header-names.csv` | หัวคอลัมน์ชื่ออื่น (`Name`, `UOM`, `System`, `LoLo`, `Low`, `High`, `HiHi`) + ช่อง alarm เป็น `-`, `n/a`, `low` | PREP-6, IMP-77 |
| `T02-description-and-name.csv` | มีทั้งคอลัมน์ name และ description | IMP-77 |
| `T03-duplicate-tag-TI-101.csv` | TI-101 ซ้ำ 2 แถว (ชื่อ / component / alarm ต่างกัน) | PREP-6, IMP-80 |
| `T04-broken-short-row.csv` | แถวหนึ่งจำนวนช่องไม่ครบ | PREP-6, IMP-79 |
| `T05-empty-0-byte.csv` | ไฟล์ว่าง 0 byte | PREP-6, IMP-79 |

**`buddhist\` — ปี พ.ศ.**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `BE-2567-leap-day.csv` | `2567-02-28 …` ถึง `2567-03-01 …` มีวันที่ 29 ก.พ. 2567 ครบ 288 จุด | PREP-6, IMP-20, IMP-74 |

**`odd\` — ข้อมูลแปลก**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `ODD-text-and-empty-cells.csv` | ช่องตัวเลขเป็น `abc`, `#N/A`, `1,234` และช่องว่าง (จำนวนต่อคอลัมน์อยู่ใน EXPECTED.txt) | PREP-6, IMP-63, IMP-74 |
| `ODD-empty-and-repeated-time.csv` | แถวที่ช่องเวลาว่าง 3 แถว + เวลาซ้ำ 2 คู่ (ค่าคนละค่า บางช่องว่าง) | PREP-6, IMP-67 |
| `ODD-same-column-twice.csv` | คอลัมน์ `TI-101` 2 คอลัมน์ในไฟล์เดียว | PREP-6, IMP-68 |
| `ODD-same-column-twice-case.csv` | `TI-101` กับ `ti-101` | IMP-68 |
| `ODD-time-header-Timestamp.csv`, `ODD-time-header-TIME.csv` | คอลัมน์เวลาชื่อ `Timestamp` / `TIME` | PREP-6, IMP-64 |
| `ODD-time-in-column-3.csv` | คอลัมน์ `timestamp` อยู่คอลัมน์ที่ 3 | PREP-6, IMP-64 |

**`broken\` — ไฟล์เสีย**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `BRK-date-header.csv` | คอลัมน์เวลาชื่อ `Date` | PREP-6, IMP-65 |
| `BRK-datetime-header.csv` | คอลัมน์เวลาชื่อ `DateTime` | IMP-65, WFF-1 |
| `BRK-semicolon.csv` | คั่นด้วย `;` | WFF-1 |
| `BRK-empty-0-byte.csv` | ไฟล์ 0 byte | PREP-6, IMP-69 |
| `BRK-header-only.csv` | มีแต่หัวคอลัมน์ | PREP-6, IMP-69 |
| `BRK-extra-comma-line-50.csv` | บรรทัดที่ 50 มีลูกน้ำเกิน 1 ตัว | PREP-6, IMP-70, IMP-74 |
| `BRK-excel-file-renamed.csv` | ไฟล์ Excel (.xlsx) จริงที่เปลี่ยนนามสกุลเป็น .csv | PREP-6, IMP-71, IMP-73 |
| `BRK-not-a-csv.xlsx` | ไฟล์ Excel ธรรมดา (ไม่ใช่ .csv) สำหรับลากมาวาง | IMP-62 |

**`time-shapes\` — รูปแบบเวลา**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `IMP66-1` … `IMP66-5` | 5 รูปแบบที่ต้องอ่านได้: `2024-01-01 00:05:00`, `… 00:05`, `…T00:05:00`, `… 00:05:00.250`, `… 00:05:00+07:00` | PREP-6, IMP-66 · `IMP66-5` ใช้กับ BMW-212 ด้วย |
| `IMP66-5b_offset-minus0500.csv` | เวลาที่ต่อท้าย `-05:00` (เขตเวลาที่ไม่ใช่ของเครื่อง) | BMW-212 |
| `IMP66-6` … `IMP66-8` | `2025/01/01 00:05:00`, `13/05/2023 01:00`, `2026-02-09T23:50:00Z` | PREP-6, IMP-66 |
| `IMP87-A` … `IMP87-D` | ไฟล์ A / B / C / D ของข้อ IMP-87 (เดือน/วัน, วัน/เดือน, AM/PM, วัน/เดือน/ปี พ.ศ.) | IMP-87 |
| `IMP88\2025.csv` + `IMP88\2026.csv` | ไฟล์เลียนแบบระบบ historian (`01-Jan-25 12:00 AM`, หัว `TimeStamp`, อักขระซ่อนต้นไฟล์) ตัวเลขตรงกับข้อ IMP-88 (187,947 แถว) | IMP-88 |

**`intervals\` — ระยะห่างระหว่างแถว**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `INT-10s.csv`, `INT-90s.csv`, `INT-90min.csv`, `INT-1h.csv`, `INT-1d.csv` | การ์ด Interval ต้องขึ้น "10 s", "90 s", "90 min", "1 h", "1 d" (5 min ใช้ `normal\IMP-normal.csv`) | IMP-36 · `INT-10s` / `INT-1h` ใช้กับ BMW-212 |

**`wide\` — คอลัมน์เยอะ**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `IMP-wide-220-sensors.csv` + `IMP-wide-tags.csv` | 220 sensor, จับคู่ชื่อได้ 215 ตัว (เกิน 200), 10 ตัวไม่มี component, tag ที่ไม่มีในข้อมูล 25 ตัว | IMP-78 |

**`variants\` — ไฟล์ปกติที่ถูกแก้แล้ว** (วิธีใช้: ปิดโปรแกรม → เก็บสำเนาไฟล์เดิมไว้ → คัดลอกไฟล์ใน `variants\` ไปทับไฟล์เดิม **แล้วเปลี่ยนชื่อให้เหมือนชื่อเดิม** → เปิดโปรแกรม → จบข้อแล้วคืนไฟล์เดิม)

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `IMP-normal_without-TI-101.csv` | ไม่มีคอลัมน์ TI-101 (ใช้เป็น `TAG1`) | PER-15, BMW-396 |
| `IMP-normal_without-KW-401.csv` | ไม่มีคอลัมน์ sensor ของ Running condition | BMW-396 |
| `IMP-normal_plus-1-day.csv` | ต่อท้ายอีก 1 วัน (31 ม.ค.) | PER-19 |
| `IMP-normal_first-10-days.csv` | ช่วงสั้นกว่าเดิม (1–10 ม.ค.) | BMW-201, BMW-358 (ข้อ 6) |
| `IMP-normal-tags_changed.csv` | Tag names ที่แก้ชื่อ / component / alarm H แล้ว | PER-19 |

**`projects\` — เครื่องสำหรับ PREP-5, MULTI, WFE, WFF**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `GEG-3.csv` | เครื่องยนต์ก๊าซ GEG-3 ม.ค.–มิ.ย. 2025 ทุก 5 นาที (`TT_BRG_DE`, `TT_BRG_NDE`, `TT_LO_IN`, `PWR_KW` …) | PREP-5 (โปรเจกต์ A), MULTI ทั้งหมด, MULTI-15 (C และ D), WFE, WFF (โปรเจกต์ "Trial-F"), WFH-3 |
| `GEG-4.csv` | tag ชุดเดียวกับ GEG-3 แต่ช่วง มี.ค.–ส.ค. 2025 | WFE |
| `GEG-tags.csv` | Tag names ภาษาอังกฤษ (`TT_BRG_DE` = "Bearing DE temp", Generator, ALARM_H 95) | PREP-5, MULTI-15 (โปรเจกต์ C), WFE, WFF |
| `GEG-tags-D-thai.csv` | Tag names ภาษาไทย UTF-8 (`TT_BRG_DE` = "ลูกปืนหน้าเครื่อง", Engine, ALARM_H 90) | MULTI-15 (โปรเจกต์ D), WFF-4 (แบบ CSV UTF-8) |
| `GEG-tags-thai-saved-as-plain-CSV.csv` | ภาษาไทยที่บันทึกจาก Excel แบบ "CSV (Comma delimited)" (ไม่ใช่ UTF-8) | WFF-4 (แบบแรก) |
| `GEG-tags_changed.csv` | Tag names ที่แก้ชื่อ / component / ALARM_H แล้ว | WFF-5 |
| `CMP-1.csv` + `CMP-1-tags.csv` | เครื่องอัดก๊าซ — tag และ component คนละชุดกับ GEG-3 ทั้งหมด | PREP-5 (โปรเจกต์ B), MULTI |

**`exp-variants\` — สำเนา EXP-data.csv ที่ถูกแก้** (วิธีใช้แบบเดียวกับ `variants\` — ไฟล์ต้นทางคือ `C:\WizardTestData\EXP\EXP-data.csv`)

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `EXP-data_with-A-B-columns.csv` | เพิ่มคอลัมน์ `A B` และ `A/B` (Import เป็นไฟล์ใหม่ได้เลย ไม่ต้องทับ) | BMW-381 |
| `EXP-data_without-FLOW-A.csv` | ไม่มีคอลัมน์ `FLOW A` (sensor ของโมเดล) | BMW-396 รอบแรก |
| `EXP-data_without-KW.csv` | ไม่มีคอลัมน์ `KW` (sensor ของ Running condition) | BMW-396 รอบที่สอง |

**`big\` และ `wfg\` — ไฟล์ใหญ่ (มีเฉพาะเมื่อรันพร้อม `--big`)**

| ไฟล์ | คืออะไร | ใช้ในข้อ |
|---|---|---|
| `big\BIG-300MB.csv` | ประมาณ 300 MB, 100 sensor ทุก 1 นาที | PREP-6, IMP-16, IMP-35, IMP-75, PERF-2 ถึง PERF-7, SPC-92, EDT-66, MULTI-10 |
| `big\BIG-1_9GB.csv` | ประมาณ 1.9 GB (ต่ำกว่าเพดาน 2 GB, หลายล้านแถว) | PREP-6, PERF-1, WFG-13, SPC-92 |
| `big\BIG-2_1GB-over-limit.csv` | ประมาณ 2.1 GB (เกิน 2,147,483,648 bytes) | PREP-6, IMP-72, WFF-2, WFG-13 |
| `big\BIG-2_1GB-part1.csv` + `part2.csv` | ไฟล์ 2.1 GB แบ่งเป็น 2 ไฟล์ตามเวลา ซ้อนกัน 1 วัน | WFF-2 |
| `big\BIG-overlap-1.csv` … `-3.csv` | 3 ไฟล์ใหญ่ ช่วงเวลาซ้อนกัน | PERF-8 |
| `big\BIG-tags.csv` | Tag names ของ S001–S100 | IMP-16, PERF |
| `wfg\GEG5_2024.csv` + `GEG5_2025.csv` + `GEG5-tags.csv` | 2 ปี ทุก 1 นาที 120 sensor ตามที่ WFG-1 บรรยาย (มีช่องว่าง, "Bad" / "I/O Timeout", เครื่องหยุดเดือนละวัน, ช่วงผิดปกติ ส.ค. 2025) — **ใช้แทนการเขียนสคริปต์ pandas ใน WFG-1 ได้เลย** | WFG ทั้งหมด, PERF-10 |

---

## 3. แต่ละหมวดของแผน ใช้ไฟล์อะไร

| หมวด | ใช้ไฟล์ / โปรเจกต์อะไร |
|---|---|
| **PREP** | PREP-6: ทั้งโฟลเดอร์ `IMP` (ดูข้อ 2) · PREP-5: โปรเจกต์ A = `IMP\projects\GEG-3.csv` + `GEG-tags.csv`, โปรเจกต์ B = `IMP\projects\CMP-1.csv` + `CMP-1-tags.csv` · PREP-1/2/3/7 ไม่ใช้ไฟล์ข้อมูล |
| **APP** | ไฟล์อะไรก็ได้ (เช่น `IMP\normal\IMP-normal.csv`) |
| **IMP** | ตามตาราง `IMP\…` ในข้อ 2 · IMP-89 ถึง IMP-99: `TS\` · IMP-2, IMP-27–29, IMP-56–59, IMP-100–113: โปรเจกต์อะไรก็ได้ (สร้างจาก `IMP\normal\` หรือ `WF\`) |
| **LAY, SEN, SEL, FIL, HL, TIME, LINE, SCAT, PAIR** | โปรเจกต์จาก `WF\` (ทำตาม WFA-1 ถึง WFA-4) หรือ `IMP\normal\IMP-normal.csv` + `IMP-normal-tags.csv` — ข้อที่ต้องการ sensor ไม่มี component / ไม่มีชื่อ ใช้ชุด `IMP\normal\` |
| **SPC, MNG, EDT** | `IMP\normal\IMP-normal.csv` + `IMP-normal-tags.csv` (มี 3 component และมีช่องว่าง ตามที่หมวด SPC ต้องการ — TAG1 / TAG2 / TAG3 ใช้ TI-101 / TI-102 / PI-201) · SPC-92, EDT-66: `IMP\big\BIG-300MB.csv` หรือ `BIG-1_9GB.csv` (`--big`) |
| **FG** | โปรเจกต์จาก `WF\` หรือ `IMP\normal\` · FG-26 ใช้ `IMP\normal\` (มี sensor ที่มี alarm L/H ครบ / ด้านเดียว) |
| **BMW** | ข้อทั่วไป: โปรเจกต์จาก `WF\` · BMW-355 ขึ้นไป (Export results): `EXP\EXP-data.csv` + `EXP-tags.csv` · BMW-381 / BMW-396: `IMP\exp-variants\` · BMW-201 / BMW-358: `IMP\variants\IMP-normal_first-10-days.csv` · BMW-212: `IMP\intervals\INT-10s.csv`, `INT-1h.csv`, `IMP\time-shapes\IMP66-5…` / `IMP66-5b…` |
| **MULTI** | โปรเจกต์ A / B จาก PREP-5 · MULTI-8: B สร้างจาก `GEG-3.csv` อีกครั้ง · MULTI-10: ไฟล์ใหญ่ `IMP\big\BIG-300MB.csv` · MULTI-15: C = `GEG-3.csv` + `GEG-tags.csv`, D = `GEG-3.csv` + `GEG-tags-D-thai.csv` |
| **PER** | โปรเจกต์อะไรก็ได้ · PER-15: `IMP\variants\IMP-normal_without-TI-101.csv` · PER-19: `IMP\variants\IMP-normal_plus-1-day.csv` + `IMP-normal-tags_changed.csv` |
| **ERR** | โปรเจกต์อะไรก็ได้ (ข้อเหล่านี้แก้ไฟล์โปรเจกต์ `ws_….json` ด้วยมือ ดูข้อ 4) |
| **PERF** | `IMP\big\` (`--big`) · PERF-8: `IMP\big\BIG-overlap-1..3.csv` · PERF-10: `IMP\wfg\` (ประมาณ 1 ล้านแถว) |
| **VIS** | โปรเจกต์อะไรก็ได้ · VIS-3: `IMP\normal\IMP-normal.csv` + `IMP-normal-tags.csv` |
| **WFA, WFB, WFC, WFD** | `WF\` ทั้งโฟลเดอร์ (WFB–WFD ใช้โปรเจกต์ที่ได้จาก WFA ต่อ) |
| **WFE** | `IMP\projects\GEG-3.csv`, `GEG-4.csv` + `GEG-tags.csv` (ตั้งชื่อโปรเจกต์ "GEG-3 Bearing" / "GEG-4 Bearing") |
| **WFF** | "Trial-F" = `IMP\projects\GEG-3.csv` + `GEG-tags.csv` · WFF-1: `IMP\broken\BRK-semicolon.csv`, `BRK-datetime-header.csv`, `IMP\normal\IMP-normal_saved-as-CSV-UTF-8.csv` · WFF-2: `IMP\big\BIG-2_1GB-…` (`--big`) · WFF-4: `GEG-tags-thai-saved-as-plain-CSV.csv` แล้ว `GEG-tags-D-thai.csv` · WFF-5: `GEG-tags_changed.csv` |
| **WFG** | `IMP\wfg\` (`--big`) · WFG-13: `IMP\big\BIG-1_9GB.csv` และ `BIG-2_1GB-over-limit.csv` |
| **WFH** | โปรเจกต์ที่ทำไว้จาก WFA, WFE, WFJ (ต้องมี 6 โปรเจกต์ขึ้นไป) · WFH-3: ใช้ CSV + Tag names ชุดเดิมของโปรเจกต์ต้นฉบับ |
| **WFI** | `TS\scenario\` |
| **WFJ** | `EXP\EXP-data.csv` + `EXP-tags.csv` |
| **WFK** | `EXP\EXP-numbers.csv` + `EXP-numbers-tags.csv` (WFK-1 ถึง WFK-10), `EXP\EXP-fleet.csv` + `EXP-fleet-tags.csv` (WFK-11, WFK-12), โปรเจกต์จาก WFJ (WFK-5) |

---

## 4. สิ่งที่ยังต้องทำเองด้วยมือ (สคริปต์ทำให้ไม่ได้) และเหตุผล

| ข้อ | ต้องทำอะไรเอง | ทำไมสร้างไว้ให้ไม่ได้ |
|---|---|---|
| EDT-31, EDT-51, ERR-2, ERR-8, ERR-9 | แก้ไฟล์โปรเจกต์ `ws_….json` ด้วย Notepad (หรือขอไฟล์ที่เตรียมไว้จากทีม dev) | ไฟล์โปรเจกต์เกิดจากโปรแกรมในเครื่องของผู้ทดสอบ ชื่อและเนื้อหาไม่เหมือนกันทุกเครื่อง |
| BMW-378, BMW-384, BMW-389 ถึง BMW-392, IMP-106, PER-18, WFH (อัปเกรด), WFK-16 | ใช้โปรเจกต์ที่สร้างด้วยโปรแกรมเวอร์ชันเก่า / ตัวติดตั้งเวอร์ชันเก่า | ต้องสร้างจากโปรแกรมเวอร์ชันเก่าจริง ไฟล์ CSV ทำแทนไม่ได้ |
| WFF-1 (ไฟล์ที่เปิดค้างใน Excel), WFF-5, IMP-58, IMP-82, PER-19 | เปิดไฟล์ค้างใน Excel / ย้ายไฟล์ / ทับไฟล์ที่ตำแหน่งเดิม | เป็นการกระทำที่ข้อนั้นต้องการทดสอบเอง (ใช้ไฟล์ใน `variants\` ช่วยได้ ไม่ต้องพิมพ์แก้เอง) |
| IMP-88 (ไฟล์จริงของลูกค้า) | ถ้ามีไฟล์ `2025.csv` / `2026.csv` ตัวจริงจากระบบ historian ให้ใช้ตัวจริง | `IMP\time-shapes\IMP88\` เป็นไฟล์เลียนแบบที่ตัวเลขตรงกับข้อ แต่ไม่ใช่ข้อมูลจริง |
| WFG (ถ้ามีข้อมูลจริง 2 ปี) | WFG-1 ให้ใช้ข้อมูลจริงก่อน ถ้ามี | ไฟล์ใน `IMP\wfg\` เป็นข้อมูลจำลอง — หมายเหตุ: 2024 เป็นปีอธิกสุรทิน จึงได้ 1,052,640 แถว (WFG-2 เขียนไว้ "≈ 1,051,200") |

---

## 5. ข้อควรรู้

- **อย่าย้ายหรือลบไฟล์ใน `C:\WizardTestData` หลังสร้างโปรเจกต์แล้ว** — โปรเจกต์จำแค่ที่อยู่ของไฟล์ ไม่ได้เก็บสำเนาข้อมูล (ยกเว้นข้อที่ตั้งใจให้ย้าย เช่น IMP-58, IMP-82)
- รัน `make-all-testdata.py` ซ้ำ = ไฟล์ทุกตัวถูกเขียนทับด้วยข้อมูลเดิม — ถ้าเคยทับไฟล์ด้วย `variants\` แล้วลืมคืน รันซ้ำก็ได้ของเดิมกลับมา
- ตัวเลขที่ต้องเห็นบนหน้าจอของแต่ละไฟล์ อยู่ใน `EXPECTED.txt` ของโฟลเดอร์นั้น — ถ้าตัวเลขบนจอไม่ตรง ให้จดทั้งสองค่าในช่องหมายเหตุของข้อนั้น

---

## 6. บรรทัด "ไฟล์ที่ใช้" ในแบบฟอร์ม HTML (แบบฟอร์มอ่านจากกล่องนี้ — อย่าลบ)

`scripts/build-manual-test-html.py` อ่านกล่องข้างล่าง แล้วใส่บรรทัด "ไฟล์ที่ใช้: …" ให้แต่ละข้อในแบบฟอร์ม — **เมื่อแก้ตารางในข้อ 2–3 ให้แก้กล่องนี้ด้วย** (`--check` ไม่ผ่านถ้ากล่องอ้างถึงข้อหรือหมวดที่ไม่มีอยู่จริง)
**เขียนแค่ชื่อไฟล์ ห้ามใส่ที่อยู่หรือไดรฟ์** (`C:\…`, `IMP\…`) — ทีมทดสอบได้ไฟล์ไปเก็บไว้คนละที่ (`--check` ไม่ผ่านถ้าเจอ `\` หรือ `/`) · ชื่อชุดข้อมูล (WF, IMP, TS, EXP) ใช้เป็นคำเรียกได้
กติกา: `รายการ => ข้อความ` · รายการเป็น id (`IMP-36`), ช่วง (`IMP-89..97` = ทุกข้อที่มีอยู่ในช่วง), ชื่อหมวด (`SPC`) หรือหมวดเฉพาะรอบ (`BMW@5` = ข้อของ BMW ที่อยู่รอบ 5 ใน `TEST_ROUNDS.md`) · ข้อหนึ่งได้ข้อความจากบรรทัดรายข้อทุกบรรทัดที่ระบุมัน (ต่อกันด้วย ·) ถ้าไม่มี ใช้ของ "หมวด@รอบ" ถ้าไม่มีอีก ใช้ของหมวด · บรรทัดที่ขึ้นต้นด้วย `+ ` = ข้อความเสริม ต่อท้ายสิ่งที่ข้อนั้นได้อยู่แล้วเสมอ · ข้อที่ไม่อยู่ในกล่องเลย = ไม่มีบรรทัดไฟล์ (ไม่ต้องใช้ไฟล์เฉพาะ)

```files
# ---- ค่าเริ่มต้นของหมวด (จากตารางข้อ 3)
APP => ไฟล์อะไรก็ได้ เช่น IMP-normal.csv
LAY SEN SEL FIL HL TIME LINE SCAT PAIR FG => โปรเจกต์จากชุด WF (ทำตาม WFA-1 ถึง WFA-4) หรือ IMP-normal.csv, IMP-normal-tags.csv
SPC MNG EDT => IMP-normal.csv, IMP-normal-tags.csv (TAG1 / TAG2 / TAG3 = TI-101 / TI-102 / PI-201)
BMW => โปรเจกต์จากชุด WF
BMW@5 => EXP-data.csv, EXP-tags.csv
MULTI => โปรเจกต์ A = GEG-3.csv, GEG-tags.csv · โปรเจกต์ B = CMP-1.csv, CMP-1-tags.csv (จาก PREP-5)
PERF => ไฟล์ใหญ่ในชุด IMP (BIG-…)
WFA WFB WFC WFD => ทุกไฟล์ในชุด WF (WFB–WFD ใช้โปรเจกต์ที่ได้จาก WFA ต่อ)
WFE => GEG-3.csv, GEG-4.csv, GEG-tags.csv
WFF => โปรเจกต์ "Trial-F" = GEG-3.csv, GEG-tags.csv
WFG => GEG5_2024.csv, GEG5_2025.csv, GEG5-tags.csv (ไฟล์ใหญ่)
WFI => I-1_…, I-2_…, I-3_…, I-tags.csv
WFJ => EXP-data.csv, EXP-tags.csv
# ---- รายข้อ (จากตารางข้อ 2–3)
PREP-6 => ทุกไฟล์ทุกชุด (WF, IMP, TS, EXP)
PREP-5 => โปรเจกต์ A = GEG-3.csv, GEG-tags.csv · โปรเจกต์ B = CMP-1.csv, CMP-1-tags.csv
IMP-2 IMP-27..29 IMP-56..59 IMP-100..105 IMP-107..113 => โปรเจกต์อะไรก็ได้ (สร้างจาก IMP-normal.csv หรือชุด WF)
IMP-34 IMP-36 IMP-38 IMP-46 IMP-60 IMP-61 IMP-62 IMP-70 IMP-81 IMP-14 => IMP-normal.csv
IMP-38 IMP-76 IMP-14 IMP-81 IMP-82 SEN-1 SEN-2 SEN-4 SEL-9 FG-26 VIS-3 => IMP-normal-tags.csv
FG-26 VIS-3 => IMP-normal.csv
IMP-45 => IMP-normal_this_is_a_very_long_file_name_…csv
IMP-35 IMP-36 IMP-86 PERF-8 => MF-overlap-1.csv, MF-overlap-2.csv, MF-overlap-3.csv
IMP-36 IMP-86 => MF-adjacent-1.csv, MF-adjacent-2.csv
IMP-36 => MF-samecol-1.csv, MF-samecol-2.csv
IMP-81 => MF-extra-columns-B.csv
IMP-73 => MF-set-1.csv, MF-set-2-BROKEN.csv, MF-set-3.csv
IMP-77 => T01-other-header-names.csv, T02-description-and-name.csv
IMP-80 => T03-duplicate-tag-TI-101.csv
IMP-79 => T04-broken-short-row.csv, T05-empty-0-byte.csv
IMP-20 IMP-74 => BE-2567-leap-day.csv
IMP-63 IMP-74 => ODD-text-and-empty-cells.csv
IMP-67 => ODD-empty-and-repeated-time.csv
IMP-68 => ODD-same-column-twice.csv, ODD-same-column-twice-case.csv
IMP-64 => ODD-time-header-Timestamp.csv, ODD-time-header-TIME.csv, ODD-time-in-column-3.csv
IMP-65 => BRK-date-header.csv, BRK-datetime-header.csv
IMP-69 => BRK-empty-0-byte.csv, BRK-header-only.csv
IMP-70 IMP-74 => BRK-extra-comma-line-50.csv
IMP-71 IMP-73 => BRK-excel-file-renamed.csv
IMP-62 => BRK-not-a-csv.xlsx
IMP-66 => IMP66-1 … IMP66-8
IMP-87 => IMP87-A … IMP87-D
IMP-88 => 2025.csv, 2026.csv (ชุด IMP — ถ้ามีไฟล์จริงจากระบบ historian ใช้ตัวจริง)
IMP-88 => F09, F10, F14, F16 (ชุด TS — บรรทัด "รูปแบบอื่น")
IMP-36 => INT-10s.csv, INT-90s.csv, INT-90min.csv, INT-1h.csv, INT-1d.csv
IMP-78 => IMP-wide-220-sensors.csv, IMP-wide-tags.csv
IMP-16 IMP-35 IMP-75 => BIG-300MB.csv (ไฟล์ใหญ่)
IMP-16 => BIG-tags.csv
IMP-72 => BIG-2_1GB-over-limit.csv (ไฟล์ใหญ่)
IMP-89..97 => F01 … F22 (ชุด TS)
IMP-98 => M1_iso.csv, M1_us_ampm.csv (โปรเจกต์ 1) · M2_part1.csv, M2_part2.csv (โปรเจกต์ 2) · M3_column_twice.csv (โปรเจกต์ 3)
IMP-99 => TS-tags.csv
+ IMP-89..99 => ตัวเลขที่ต้องได้: EXPECTED.txt ของชุด TS
SPC-92 EDT-66 => BIG-300MB.csv หรือ BIG-1_9GB.csv (ไฟล์ใหญ่)
BMW-201 => IMP-normal_first-10-days.csv
BMW-212 => INT-10s.csv, INT-1h.csv, IMP66-5…, IMP66-5b_offset-minus0500.csv
BMW-358 => EXP-data.csv, EXP-tags.csv · ข้อ 6: IMP-normal_first-10-days.csv
BMW-381 => EXP-data_with-A-B-columns.csv
BMW-396 => EXP-data_without-FLOW-A.csv (รอบแรก) แล้ว EXP-data_without-KW.csv (รอบที่สอง) · หรือ IMP-normal_without-TI-101.csv / IMP-normal_without-KW-401.csv
BMW-402 BMW-403 => EXP-data.csv, EXP-tags.csv · ตัวเลขที่ต้องได้: EXPECTED.txt ของชุด EXP
MULTI-8 => B สร้างจาก GEG-3.csv อีกครั้ง
MULTI-10 => BIG-300MB.csv (ไฟล์ใหญ่)
MULTI-15 => C = GEG-3.csv, GEG-tags.csv · D = GEG-3.csv, GEG-tags-D-thai.csv
PER-15 => IMP-normal_without-TI-101.csv
PER-19 => IMP-normal_plus-1-day.csv, IMP-normal-tags_changed.csv
PERF-1 => BIG-1_9GB.csv
PERF-2..7 => BIG-300MB.csv, BIG-tags.csv
PERF-8 => BIG-overlap-1.csv, BIG-overlap-2.csv, BIG-overlap-3.csv
PERF-10 => GEG5_2024.csv, GEG5_2025.csv, GEG5-tags.csv (ประมาณ 1 ล้านแถว)
WFA-1 WFA-3 => WF-A-process.csv, WF-B-bearing.csv, WF-C-cooling-BE.csv
WFA-3 => ถ้าไม่ผ่าน ใช้ WF-C-cooling-CE.csv แทน
WFA-4 => WF-tags.csv
WFF-1 => BRK-semicolon.csv, BRK-datetime-header.csv, IMP-normal_saved-as-CSV-UTF-8.csv
WFF-2 => BIG-2_1GB-over-limit.csv · BIG-2_1GB-part1.csv, BIG-2_1GB-part2.csv (ไฟล์ใหญ่)
WFF-4 => GEG-tags-thai-saved-as-plain-CSV.csv แล้ว GEG-tags-D-thai.csv
WFF-5 => GEG-tags_changed.csv
WFG-13 => BIG-1_9GB.csv และ BIG-2_1GB-over-limit.csv
WFH-3 => CSV + Tag names ชุดเดิมของโปรเจกต์ต้นฉบับ (เช่น GEG-3.csv, GEG-tags.csv)
+ WFJ-1..13 => ตัวเลขที่ต้องได้: EXPECTED.txt ของชุด EXP
WFK-1..10 => EXP-numbers.csv, EXP-numbers-tags.csv
WFK-11 WFK-12 => EXP-fleet.csv, EXP-fleet-tags.csv
WFK-5 => โปรเจกต์จาก WFJ (EXP-data.csv, EXP-tags.csv)
+ WFK-1..15 => ตัวเลขที่ต้องได้: EXPECTED.txt ของชุด EXP
```
