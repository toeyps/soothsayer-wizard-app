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
| [`PERSISTENCE_PLAN.md`](PERSISTENCE_PLAN.md) | แผนการบันทึก workspace (อยู่ที่ root เพราะ `BACKLOG.md` ลิงก์ถึงด้วย path นี้) | — |
| [`release/`](release/) | `CHANGELOG.md` — section ใหม่ทุกครั้งที่ build installer | `release-agent` |
| [`testing/`](testing/) | `MANUAL_TEST_PLAN.md` (ต้นฉบับ) → `manual-test-plan.html` (สร้างจาก .md ด้วย `scripts/build-manual-test-html.py`, เปิดในเบราว์เซอร์ได้เลย), `MANUAL_TEST_NEW_SINCE_2026-10-02.md` (รายการทดสอบเฉพาะของใหม่), `RELEASE_0.5.0_TEST_REPORT.md` | `qa-agent` / ผู้ทดสอบ |
| [`design/`](design/) | `DESIGN_SYSTEM.md`, `APP_MAP.md` และ `handoff/` (สเปกที่ส่งจากทีมออกแบบให้ทีม dev ทีละงาน) | `ui-design-lead` |
| [`reference/`](reference/) | `tech-stack.html` (สรุป stack หน้าเดียว), `figma/` (SVG mockup รุ่นเก่า **ไม่ได้อัปเดตตามโค้ด** — อย่าแก้) | — |
| [`onboarding/`](onboarding/) | คู่มือ + ตัวอย่างงานสำหรับน้องฝึกงาน BA/SA | — |
| [`archive/`](archive/) | ประวัติที่ไม่ใช้แล้ว: `planning/` (requirements / task / contracts ของ Feature 1–4), `handover-overview-2026-08.md` (ภาพรวมฉบับเก่า) | ห้ามแก้ |
| [`PROJECT_HANDOVER.md`](PROJECT_HANDOVER.md) | ป้ายบอกว่าย้ายไปที่ไหน (ไฟล์เดิมแยกเป็นรายเดือนเมื่อ 2026-10-09) | — |

กติกาการทำงานทั้งหมด (agent, การ push, release, เทสต์) อยู่ที่ [`../CLAUDE.md`](../CLAUDE.md)
