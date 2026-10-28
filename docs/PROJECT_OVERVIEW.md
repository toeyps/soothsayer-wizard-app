# Wizard — ภาพรวมโปรเจกต์ (สถานะปัจจุบัน)

> **อ่านไฟล์นี้ก่อน.** ไฟล์นี้ **เขียนทับให้เป็นปัจจุบันเสมอ** (ไม่ต่อท้าย) — ประวัติละเอียดว่าแต่ละงานทำอย่างไรและทำไม
> อยู่ที่ [`handover/`](handover/README.md) (ไฟล์รายเดือน) · สิ่งที่เปลี่ยนในแต่ละเวอร์ชันแบบอ่านง่ายอยู่ที่ [`release/CHANGELOG.md`](release/CHANGELOG.md)
>
> อัปเดตล่าสุด: **2026-10-11**

---

## 1. แอปนี้คืออะไร

**Wizard** (repo: `Soothsayer-wizard-app`) เป็นแอป desktop (Windows `.exe`) สำหรับวิศวกรที่ดูแลเครื่องจักร:
นำเข้าไฟล์ CSV ข้อมูลเซนเซอร์ย้อนหลัง → สำรวจข้อมูลด้วยกราฟ → จัดเซนเซอร์เป็นกลุ่มอาการเสีย (Failure Group) →
สร้างโมเดลจากช่วงที่เครื่องทำงานปกติ → ให้ **Health score 0–100** เพื่อหาพฤติกรรมผิดปกติ
ทำงานบนเครื่องผู้ใช้ทั้งหมด (offline) ไม่ได้ทำนายว่าเครื่องจะเสียเมื่อไร แต่บอกว่าช่วงไหน "ผิดไปจากปกติ"

## 2. การใช้งานในแอป (ตามลำดับหน้าจอ)

1. **Welcome** — โปรเจกต์ล่าสุด, ปุ่ม New project (Ctrl+N), ภาพเครื่องจักรแบบจุดที่ลากหมุนได้
2. **Name your project** — ชื่อ (≤ 80 ตัวอักษร) + คำอธิบาย
3. **Add your sensor data** — เลือก CSV ได้หลายไฟล์ (≤ 2 GB/ไฟล์, รวมตามเวลา, แปลง พ.ศ. → ค.ศ. อัตโนมัติ) + ไฟล์ Tag names (ชื่อ/หน่วย/Component/ค่า alarm ของแต่ละ tag)
4. **Failure groups** — ขั้นที่ 3 ของการ Import (ใหม่ 2026-10-09 ยังไม่ทดสอบในแอปจริง)
5. **Dashboard** — กราฟ Line / Scatter / Pair Plot, แท็บ Sensors / Failure Groups, Filter, Highlights, Tag Point,
   หน้าต่าง **Add Special Sensor** (สร้างเซนเซอร์จากสูตร — formula editor + Quick build)
6. **Build Model** (หน้าต่างแยก, เรียกว่า Workbench)
   - Step 1 **Running condition**: ช่วงเวลาที่ใช้ Train/Test + เงื่อนไข "เครื่องกำลังเดิน" (ค่า default ของ workspace หรือ Custom ต่อโมเดล)
   - ซ้าย: รายการเซนเซอร์ + ความคืบหน้า · ขวา: แท็บโมเดล **I** Individual / **R** Relation model / **C** Clustering
   - แต่ละโมเดลมี 2 หน้า: **Model fit** (ตั้งค่า, Train, กราฟ) และ **Health score** (set points 100/80/0, Checks, กราฟคะแนน, ผล Train/Test) — คะแนนคำนวณจาก**ค่าเฉลี่ยราย 1 ชั่วโมง**ของแถวที่เครื่องเดิน (ตั้งแต่ 2026-10-11; train และหน้า Model fit ยังใช้ข้อมูลดิบทุกแถว)
   - **Train sensor / Train all** เทรนเป็นคิวทีละโมเดล
   - **Mark complete** = ทางเดียวที่ทำให้โมเดลเป็น Complete และเขียนไฟล์โมเดล (`INDV_INFO` / `REL_INFO` + `.pkl` / `CLUS_INFO`)

## 3. สถานะตอนนี้

| เรื่อง | สถานะ |
|---|---|
| เวอร์ชันล่าสุดที่ build เป็น installer | **0.11.1** (2026-10-19, `Wizard_0.11.1_x64-setup.exe` 58 MB, sidecar ไม่ได้ build ใหม่) — ก่อนหน้า 0.11.0 (2026-10-19), 0.10.1, 0.10.0 · ดู [`release/CHANGELOG.md`](release/CHANGELOG.md) · ผู้ใช้ยืนยันเรื่อง import วันเวลาในแอปจริงแล้ว; ส่วนอื่นตั้งแต่ 2026-10-12 บ่ายยังไม่ได้ยืนยัน |
| git tag | `v0.11.1` push ขึ้น `personal` แล้ว 2026-10-21 · `v0.10.0`, `v0.10.1`, `v0.11.0` push ขึ้น `personal` แล้ว 2026-10-19 · `v0.8.0`, `v0.9.0` push แล้ว 2026-10-11 (0.6.0/0.7.0 ไม่เคย build จึงไม่มี tag) |
| push ล่าสุด | 2026-10-21: `main` ขึ้น `personal` (`toeyps/soothsayer-wizard-app`) ถึง commit `ca82586` + tag `v0.11.1` — ผู้ใช้สั่ง "push เลย" (Export results ยังไม่ได้ยืนยันว่าทดสอบในแอปจริงแล้ว) |
| การ push | ดูแถว "push ล่าสุด" ด้านบน — ตั้งแต่ 2026-10-11 งานทั้งหมดอยู่บน remote `personal` แล้ว ([กติกา push](#5-กติกาสำคัญที่ต้องรู้)) |
| งานที่รอผู้ใช้ทดสอบในแอปจริง | **2026-10-20 Export results + ข้อมูลเครื่อง (Plant · Machine) — push แล้ว 2026-10-21 (`8603e35`…`ca82586`), ยังไม่ยืนยันว่าลองในแอปจริง:** ขั้น 1 Plant/Machine/tag, Project details, เมนูชื่อบน title bar, บรรทัด time zone, บรรทัด "Machine is running when …", ชื่อโมเดลไม่ซ้ำ, Mark complete ไม่เขียนไฟล์ ("Checking…"), แก้ set point → Incomplete, แถบ + dialog Export results (manual plan IMP-100–106, BMW-335–354, PER-21/22, MULTI-22, WFA-20–22, WFH-15–18, WFI-9/10) · ขอบนอก cluster เปิด (health score ของค่านอกช่วงเปลี่ยน) · **commit local ของ 2026-10-12 (บ่าย–ค่ำ) ยังไม่ push — รอทดสอบ:** (1) หน้าแรก: ปุ่ม ‹ › / จุด เลือกเครื่องจักร + **ชิ้นส่วนเครื่องจักรหมุน** (IMP-53, IMP-54) (2) Tag point: จุดสีล้วน + แท็บ "Tagged points" แบบตารางเต็มกว้าง (LINE-16, LINE-17, SCAT-13) (3) ป้าย ±1SD / ±3SD อยู่ติดเส้นของตัวเอง (BMW-225) (4) Model settings ฟอร์ม 3 คอลัมน์ (BMW-230) (5) **Workbench detail pages v2** — แท็บ 1 Model fit / 2 Health score + คำสถานะบนแท็บ, ปุ่มสถานะที่หัว + notice line (ไม่มี footer / pill), tile KPI ทั้งสองหน้า, score ruler, การ์ดกราฟซ้อน (BMW-231 ถึง BMW-255) — แทนที่งานบ่ายวันเดียวกัน 4 จุด แยก commit ต่อจุดเพื่อถอยกลับได้ (6) **2026-10-14:** คอลัมน์ตาราง tag เรียงตามเวลา (LINE-18), "Complete · files out of date" คำสีเหลือง (BMW-256), ประโยค Checks ใช้ชื่อของ ruler (BMW-257), tile "Inside 3× SD" ของ Clustering มีค่าเสมอ (BMW-258), Compare predictors แสดง description ทุก sensor (BMW-259) + การ์ดไม่ทับกันเมื่อมี 5–6 predictor (BMW-260), ปุ่ม Train sensor สองครึ่งสีเดียวกันตอนชี้ (BMW-261), Compare predictors: target อยู่หน้า + ไม่มีช่อง N (BMW-221, BMW-259), **หน้าต่าง Build Model ไม่แสดงจำนวนแถวข้อมูล** — การ์ด / หน้าต่างตั้ง Running condition และ tile หน้า Model fit (BMW-262, BMW-263, BMW-264), ไม่มีปุ่ม "Next: Health score →" แล้ว — แท็บ ② มีจุด + "set points needed" / "fix set point" (BMW-265 ถึง BMW-268), **Dashboard:** sensor ที่ซ่อนไว้ไม่กลับมาแสดงเมื่อเพิ่ม sensor ใหม่ (SEL-10) · **ยังเปิดจากรอบก่อน (ผู้ใช้ "ยังไม่ตัดสินใจ"):** ไฟล์ export ตอน Mark complete (BMW-220) และโมเดลที่ Complete ไว้ก่อน + "Mark complete again" (BMW-252) · ที่ผ่านแล้วเมื่อเช้า 2026-10-12: Customer batch, Workbench redesign, health score รายชั่วโมง, รูปแบบวันที่, ป้ายแกนเวลา — รายละเอียดและคำถามที่รอคำตอบอยู่ท้าย [`handover/2026-10.md`](handover/2026-10.md) |
| เรื่องที่รอผู้ใช้ตัดสินใจ | ลดสิทธิ์ `dialog:default` เหลือ open + message · การแสดงไฟล์/โฟลเดอร์ output หลัง Mark complete (ผู้ใช้เลื่อนไว้จนกว่า UI จะใช้ได้ครบ) · แยก `BuildModelWindow.tsx` เป็นไฟล์ย่อย (เสนอไว้) |
| งานค้างที่รู้อยู่ | [`BACKLOG.md`](BACKLOG.md) |

## 4. โครงสร้างโค้ด (ย่อ)

| ส่วน | ที่อยู่ | ทำอะไร |
|---|---|---|
| Frontend | `src/` (React 19 + TypeScript + Vite + Tailwind v4) | หน้าจอทั้งหมด — ECharts (กราฟเส้น), `regl-scatterplot` WebGL (Scatter/Pair Plot) |
| Rust core | `src-tauri/src/` (Tauri v2) | อ่าน/รวม CSV, เก็บข้อมูลใน RAM แบบ column, filter/สถิติ, Clustering, สูตร special sensor, Health score, Export results (`workspace_export.rs` — `machine_info.json` + `models/<key>.json/.csv` ตาม `docs/specs/WIZARD_OUTPUT_SPEC.md`; Mark complete ไม่เขียนไฟล์แล้ว) |
| Python sidecar | `src-tauri/python/backend.py` → build ด้วย Nuitka เป็น `src-tauri/bin/backend-<target-triple>.exe` | Relation model (fit/predict) — ต้อง build ใหม่ทุกครั้งที่แก้ `backend.py` |
| Workspace | ไฟล์ JSON ใต้ `$APPDATA` + `settings.json` (รายการโปรเจกต์ล่าสุด) | ไม่มี auto-resume: เปิดแอปเริ่มที่ Welcome เสมอ |

หน้าจอส่งข้อมูลไม่ครบทุกแถวไปที่ frontend — Rust ย่อข้อมูลก่อนเสมอ (กราฟสูงสุด 100k จุด)
รายละเอียดเชิงเทคนิคและกับดักที่เคยเจอ: [`../CLAUDE.md`](../CLAUDE.md) · stack: [`reference/tech-stack.html`](reference/tech-stack.html)

## 5. กติกาสำคัญที่ต้องรู้

- **push หลังผู้ใช้ทดสอบในแอปจริงแล้วเท่านั้น** และ push ไป remote **`personal`** (`toeyps/soothsayer-wizard-app`) **ไม่ใช่ `origin`**
- งานทุกชิ้นต้องมีบันทึกใน [`handover/`](handover/README.md) ของเดือนนั้น + อัปเดต Notion (ผ่าน `notion-sync-agent`) — สถานะ Done ใน Notion เปลี่ยนเมื่อผู้ใช้ยืนยันเท่านั้น
- ทุกครั้งที่ build installer ต้องมี section ใหม่ใน CHANGELOG + bump เวอร์ชันใน 3 ไฟล์ + tag (`release-agent`)
- งานออกแบบทุกอย่างผ่าน design agents (`ui-design-lead` / `ui-design-agent` / `ui-design-reviewer`)
- UI ต้องเรียกโมเดลแบบ R ว่า **"Relation model"** — ชื่ออัลกอริทึมจริงเป็นความลับ
- รายละเอียดทั้งหมด: [`../CLAUDE.md`](../CLAUDE.md)

## 6. วิธีรัน

```bash
cd C:\00_DATA\Soothsayer-wizard-app
npm install
npm run tauri dev        # แอปเต็ม (ต้องมี sidecar ใน src-tauri/bin/ ก่อน)
npm run dev              # frontend อย่างเดียว (port 1420, ไม่มี backend — หน้าจอส่วนใหญ่ใช้ไม่ได้)
npm run build            # type-check + build frontend
npx vitest run           # เทสต์ frontend
cd src-tauri && cargo test   # เทสต์ Rust
```

Build installer บน Windows: `scripts/build-installer-windows.ps1` (ได้ `.exe` แบบ NSIS อย่างเดียว)

### ตั้งเครื่อง dev ใหม่ (ปัญหาที่เคยเจอจริงบนเครื่องนี้)

1. ติดตั้ง Rust (`rustup`) + Visual Studio Build Tools (C++ workload), Python 3.11+ , Git Bash, Node.js
2. **อย่าวางโปรเจกต์ในโฟลเดอร์ที่ OneDrive sync** — cargo build จะล้มแบบสุ่ม ("output path is not a writable directory")
3. **ถ้ามี Kaspersky**: Intrusion Prevention → Manage resources → Exclusions ใส่โฟลเดอร์โปรเจกต์ + `%USERPROFILE%\.cargo` + `%USERPROFILE%\.rustup` (ไม่งั้นเจอ "An Application Control policy has blocked this file")
4. PowerShell รัน npm ไม่ได้ ("running scripts is disabled") → `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`
5. `python` บน PATH อาจเป็นแค่ alias ของ Microsoft Store — ใช้ `py` launcher หรือ path เต็มของ Python ตัวจริง
6. Build sidecar: `cd src-tauri/python && python -m venv .venv && .venv\Scripts\pip install -r requirements.txt` แล้วรัน `build_sidecar.sh` ใน Git Bash (ใส่ `src-tauri/python/.venv/Scripts` ไว้หน้าสุดของ PATH, `NUITKA_JOBS=1`)

## 7. เอกสารอื่นใน `docs/`

ดูแผนที่ทั้งหมดที่ [`README.md`](README.md)
