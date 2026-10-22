# เอกสารของโปรเจกต์ Wizard — เริ่มอ่านที่นี่

## อ่านตามลำดับนี้

| # | อ่าน | เมื่อไร |
|---|---|---|
| 1 | [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) | **ทุกครั้งที่กลับมาทำงาน** — แอปคืออะไร, สถานะตอนนี้, อะไรรอทดสอบ/รอ push, วิธีรัน (อ่านจบใน 5 นาที, เขียนทับให้เป็นปัจจุบันเสมอ) |
| 2 | [`release/CHANGELOG.md`](release/CHANGELOG.md) | อยากรู้ว่าแต่ละเวอร์ชันเปลี่ยนอะไร (เขียนให้ผู้ใช้อ่าน) |
| 3 | [`BACKLOG.md`](BACKLOG.md) | งานค้าง / ปัญหาที่รู้แล้วแต่ยังไม่ได้แก้ |
| 4 | [`handover/`](handover/README.md) | ประวัติละเอียดรายงาน แยกไฟล์ละเดือน — เปิดเมื่ออยากรู้ว่างานไหนทำอย่างไรและทำไม |

## แผนที่โฟลเดอร์

| โฟลเดอร์ / ไฟล์ | มีอะไร | ใครดูแล |
|---|---|---|
| [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) | สถานะปัจจุบัน (เขียนทับ) | ทุก session แก้เมื่อสถานะเปลี่ยน |
| [`handover/`](handover/README.md) | บันทึกงานรายเดือน `YYYY-MM.md` (ต่อท้ายอย่างเดียว) | ทุก session — 1 งาน 1 บันทึก |
| [`BACKLOG.md`](BACKLOG.md) | งานค้างที่ยืนยันแล้ว | ทุก session |
| [`release/`](release/) | `CHANGELOG.md` — section ใหม่ทุกครั้งที่ build installer · `Wizard_Release_Versions.txt` — สรุปทุกเวอร์ชันแบบเปิดด้วย Notepad (tag / commit / installer) | `release-agent` |
| [`testing/`](testing/) | `MANUAL_TEST_PLAN.md` (ต้นฉบับ) → `manual-test-plan.html` (สร้างจาก .md ด้วย `scripts/build-manual-test-html.py`, เปิดในเบราว์เซอร์ได้เลย), `WRITING_GUIDE.md` (กติกาเขียนข้อทดสอบให้ BA อ่าน), `ID_HISTORY.md` (ประวัติเลขข้อ), `AUDIT_2026-10-14.md` (ผลตรวจแผนเทียบโค้ด + บั๊กที่สงสัย — แผนมี 2 ส่วน: ทีละฟังก์ชัน + workflow ผู้ใช้ WFA–WFJ ซึ่งใช้ข้อมูลจาก `scripts/make-wf-testdata.py`, `scripts/make-ts-testdata.py` และ `scripts/make-export-testdata.py`) | `qa-agent` / ผู้ทดสอบ |
| [`design/`](design/) | `DESIGN_SYSTEM.md`, `APP_MAP.md` และ `handoff/` (สเปกที่ส่งจากทีมออกแบบให้ทีม dev ทีละงาน) | `ui-design-lead` |
| [`reference/`](reference/) | `tech-stack.html` (สรุป stack หน้าเดียว) | — |
| [`onboarding/`](onboarding/) | คู่มือ + ตัวอย่างงานสำหรับน้องฝึกงาน BA/SA | — |
| [`archive/`](archive/) | ประวัติที่ไม่ใช้แล้ว: `planning/` (requirements / task / contracts ของ Feature 1–4), `handover-overview-2026-08.md` (ภาพรวมฉบับเก่า) | ห้ามแก้ |
| [`PROJECT_HANDOVER.md`](PROJECT_HANDOVER.md) | ป้ายบอกว่าย้ายไปที่ไหน (ไฟล์เดิมแยกเป็นรายเดือนเมื่อ 2026-10-09) | — |

กติกาการทำงานทั้งหมด (agent, การ push, release, เทสต์) อยู่ที่ [`../CLAUDE.md`](../CLAUDE.md)
