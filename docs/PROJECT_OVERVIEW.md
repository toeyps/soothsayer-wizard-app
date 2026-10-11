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
| เวอร์ชันล่าสุดที่ build เป็น installer | **0.9.0** (2026-10-08) — ดู [`release/CHANGELOG.md`](release/CHANGELOG.md) |
| git tag | `v0.8.0`, `v0.9.0` — **push ขึ้น `personal` แล้ว 2026-10-11** พร้อม tag เก่าทั้งหมด (0.6.0/0.7.0 ไม่เคย build จึงไม่มี tag) |
| push ล่าสุด | 2026-10-11: `main` ขึ้น `personal` (`toeyps/soothsayer-wizard-app`) ถึง commit `e347309` — ผู้ใช้สั่ง push ทั้งหมดเพื่อสำรอง แม้ยังทดสอบแอปจริงไม่ครบ (เครื่องดับเอง) งานที่ยังรอทดสอบดูแถวถัดไป |
| การ push | ล่าสุดที่ remote `personal` คือ 2026-10-04 — งานหลังจากนั้นอยู่ในเครื่องเท่านั้น ([กติกา push](#5-กติกาสำคัญที่ต้องรู้)) |
| งานที่รอผู้ใช้ทดสอบในแอปจริง | (1) **Customer batch 2026-10** (5 phase) + รอบแก้จากการทดสอบแอปจริง 2026-10-09 (ปุ่มลบ/แก้ชื่อโปรเจกต์, ปฏิทินในแถบช่วงเวลา, ปุ่ม ↺ Pair Plot, Criteria sensor, พิมพ์ขอบเขต cluster, ไม่เกิน 5 cluster) · (2) **Workbench redesign 2026-10-10/11** (4 phase: scoring periods มีแค่เริ่ม–จบ, โครงหน้า Model fit / Health score ใหม่, กราฟ, ตาราง set point, หน้าต่าง Running condition ใหม่, ข้อความ Train, ตัวดัก "ไม่มีข้อมูลให้ train", คำว่า "Relation model" ทั้งแอป, ข้อความ "Relation model engine") · (3) **Health score คิดจากค่าเฉลี่ยราย 1 ชั่วโมง (2026-10-11)**: คะแนนของทั้ง 3 ชนิดโมเดล = 1 จุดต่อชั่วโมง (ค่าเฉลี่ยของแถวที่เครื่องเดิน), Relation model ส่งค่ารายชั่วโมงเข้าโมเดล (ต้องยืนยันกับ engine จริง), Clustering ชั่วโมงที่เปลี่ยน cluster ไม่มีคะแนน, โมเดล Complete เดิมคง Complete + ข้อความเตือนที่ footer, ไฟล์ INFO มี `scoring_interval_seconds` — ข้อทดสอบ BMW-210 ถึง BMW-220 · (4) **กราฟ Workbench (2026-10-11)**: tooltip ตามเมาส์ / หน้าขยายไม่มี tooltip ด้านหลัง — BMW-208, BMW-209 → push แล้วทั้งหมด (2026-10-11) แต่**ยังไม่ได้ยืนยันการทดสอบ**; ผ่านแล้วถามเปลี่ยน Notion เป็น Done — รายละเอียดและรายการทดสอบอยู่ท้าย [`handover/2026-10.md`](handover/2026-10.md) |
| เรื่องที่รอผู้ใช้ตัดสินใจ | ลบคำสั่ง Rust `write_user_file` ที่ไม่มีใครเรียกแล้ว หรือเก็บไว้ · ลดสิทธิ์ `dialog:default` เหลือ open + message · การแสดงไฟล์/โฟลเดอร์ output หลัง Mark complete (ผู้ใช้เลื่อนไว้จนกว่า UI จะใช้ได้ครบ) · แยก `BuildModelWindow.tsx` เป็นไฟล์ย่อย (เสนอไว้) |
| งานค้างที่รู้อยู่ | [`BACKLOG.md`](BACKLOG.md) |

## 4. โครงสร้างโค้ด (ย่อ)

| ส่วน | ที่อยู่ | ทำอะไร |
|---|---|---|
| Frontend | `src/` (React 19 + TypeScript + Vite + Tailwind v4) | หน้าจอทั้งหมด — ECharts (กราฟเส้น), `regl-scatterplot` WebGL (Scatter/Pair Plot) |
| Rust core | `src-tauri/src/` (Tauri v2) | อ่าน/รวม CSV, เก็บข้อมูลใน RAM แบบ column, filter/สถิติ, Clustering, สูตร special sensor, Health score, export ไฟล์โมเดล |
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
