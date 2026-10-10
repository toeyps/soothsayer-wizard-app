# Multi-Agent Orchestration — วิธีที่ใช้จริงในโปรเจกต์นี้

> **เขียนใหม่ 2026-10-05** ให้ตรงกับการทำงานจริง (รุ่น 2026-08-17 อิงไฟล์
> `docs/planning/*` ซึ่งตอนนี้ย้ายไป `docs/archive/planning/` แล้ว — ดู §ประวัติ)
> นิยามเต็มของ agent แต่ละตัวอยู่ที่ `.claude/agents/*.md` (source of truth ที่
> Claude Code โหลดจริง) และตาราง zone อยู่ใน `CLAUDE.md` § Agent Roles —
> เอกสารนี้อธิบายภาพรวม เหตุผล และเกณฑ์ว่าเมื่อไหร่ใช้อะไร

## หลักใหญ่

1. **งานเข้ามาทาง prompt เท่านั้น** — ผู้ใช้สั่งในแชทกับ main session
2. **ความจริงของโปรเจกต์อยู่ 2 ที่**: โค้ด และ `docs/handover/`
   (SPEC FINAL / แผน / ประวัติงานทุกชิ้น) ไม่มีไฟล์ requirement/task ที่ต้องอัปเดตแยก
3. **Main session เป็นหัวหน้า** — รับงาน แจกงาน ตรวจซ้ำ ปิดงาน agent ทุกตัวส่ง
   `HANDOFF` กลับมาที่ main session
4. Worker แก้ได้แค่ zone ตัวเอง + เทสต์ของโค้ดตัวเอง และ **ไม่ commit / push /
   แตะ Notion** — main session ทำ

## ลำดับชั้น

```
ผู้ใช้
 └─ Main session ── รับงาน → แจกงาน → ตรวจซ้ำ → ปิดงาน
     ├─ ทีมออกแบบ:   ui-design-lead (Fable) → ui-design-agent (Opus) ↻ → ui-design-reviewer (Opus)
     ├─ ทีมเขียนโค้ด: (pm-agent) → fe-logic ∥ rust → fe-ui → code-reviewer → qa
     ├─ release-agent (ตอนออกเวอร์ชัน)
     └─ notion-sync-agent (main session เรียกท้ายทุกงาน)
```

| Agent | Model | เขียนได้ | หน้าที่ |
|---|---|---|---|
| `pm-agent` | Opus | — (คืนแผนในรายงาน) | วางแผน feature ที่ brief ยังไม่ชัด, ประสาน worker, final verification |
| `fe-logic-agent` | Opus | `src/hooks/`, `src/types/`, `src/utils/`, `src/config/`, `workspaceManager.ts` | hooks, types, business-rule helpers |
| `rust-agent` | Opus | `src-tauri/src/`, `Cargo.toml`, `python/backend.py`, `capabilities/`, `tauri*.conf.json`, `src-tauri/tests/` | Tauri commands, sidecar source, window capabilities (ห้ามขยาย CSP/สิทธิ์โดยไม่ถาม) |
| `fe-ui-agent` | Opus | `src/components/`, `App.tsx`, `App.css` | หน้าจอตาม mockup + `DESIGN_SYSTEM.md` |
| `qa-agent` | Opus | `src/__tests__/`, `src-tauri/tests/`, `MANUAL_TEST_PLAN.md` | เทสต์ข้าม zone, full suite, manual test plan + รายการ "ลองในแอปจริง" ให้ผู้ใช้ |
| `code-reviewer` | Opus | — | รีวิว diff ตามกับดักของโปรเจกต์ (IPC, failureGroupState, ข้ามหน้าต่าง, CSP/ความปลอดภัย, เทสต์) ก่อน commit |
| `release-agent` | Sonnet | version 3 ไฟล์, `CHANGELOG.md` | ออกเวอร์ชัน: เตรียม (bump + changelog) → ผู้ใช้อนุมัติ → build installer |
| `ui-design-lead` | Fable | `docs/design/` | ทิศทาง + 1–2 จออ้างอิง |
| `ui-design-agent` | Opus | scratchpad | จอที่เหลือ + วน feedback |
| `ui-design-reviewer` | Opus | — | รีวิวเข้มรอบสุดท้าย |
| `notion-sync-agent` | Sonnet | Notion | sync tracker, ไม่ตั้ง Done เอง |

## งานโค้ด — 3 ระดับ

1. **Main session ทำเอง** (ส่วนใหญ่) — bug fix, UI tweak, งานที่ต้องโชว์ผู้ใช้
   ก่อนแก้, งานที่แก้ข้ามหลายโซนในไฟล์เดียว
2. **Main-session-as-orchestrator** (ใช้บ่อยสุดสำหรับงานใหญ่ ตั้งแต่ Feature 4) —
   spec เขียนเสร็จแล้ว (SPEC FINAL หรือ prompt ผู้ใช้) → main session spawn worker
   ทีละ phase เอง, รัน `tsc`/`vitest`/`cargo test` เองหลังทุก phase
3. **ผ่าน `pm-agent`** — feature ใหญ่ที่ brief ยังไม่ชัด ต้องตั้งคำถาม/แตก phase/
   กำหนด contract ก่อน pm-agent คืน `## PLAN` ในรายงาน → main session บันทึกลง
   handover → spawn worker เอง (ถ้า pm-agent spawn ไม่ได้ — เคยเกิดจริงตอน
   Feature 3 — มันจะคืน brief พร้อมส่งต่อให้แทน)

ลำดับ phase เหมือนกันทั้งข้อ 2–3: **contract ก่อน** (command · snake_case args ·
result · error prefixes) → `fe-logic` ∥ `rust` ทำสองฝั่งพร้อมกัน → `fe-ui` (รอ
fe-logic) → `code-reviewer` (แก้ must-fix) → `qa` ทดสอบรอบเดียว → main session ตรวจซ้ำ + commit

**ทำขนานได้เมื่อไฟล์ไม่ทับกัน** เช่น fe-ui 2 ตัวคนละ component → แต่ละตัวใช้ `isolation: "worktree"`
แล้ว main session รวม branch เอง ถ้าไม่แน่ใจว่าทับไหม ให้ทำทีละตัว

**session ต่อบทบาท ล้างต่อ feature**: ใช้ session ประจำบทบาทเดิม (dev, design, …) ไม่เปิดใหม่ทุก feature;
เปลี่ยนงานย่อย → `/compact`; feature เสร็จ + handover + commit แล้ว → `/clear` ก่อนเริ่ม feature ถัดไป

**ออกเวอร์ชัน**: `release-agent` รอบเตรียม → ผู้ใช้ดูเลขเวอร์ชัน + changelog →
รอบ build → main session commit + tag + push

**คุยหลักการ (concept)**: session แยกที่ผู้ใช้คุยเรื่อง concept ของโปรแกรม (model +
การใช้งาน) ไม่ต้องมี agent — ข้อสรุปบันทึกเป็น entry "📐 concept" ใน handover
แล้ว agent ทุกตัวอ่านจากที่นั่น

**Rule of thumb**: ถ้าลังเลว่าจะ spawn pm-agent ดีไหม แปลว่าไม่ควร

## งานออกแบบ

lead (Fable) วางทิศทาง + จอหลัก → agent (Opus) ทำจอที่เหลือ วนแก้กับผู้ใช้ →
reviewer (Opus) รีวิว (must-fix ส่งกลับ agent) → **กลับมาที่ main session** แก้จอเดิม
เล็กๆ เริ่มที่ `ui-design-agent` ได้เลย Fable ช้ากว่า/แพงกว่า ~2.5× จึงใช้เฉพาะงาน
ตัดสินคุณภาพ ทุกงานออกแบบต้องผ่าน design agent — main session ไม่ทำ mockup เอง

**ส่งต่อเป็นโค้ด (main session เลือกทาง ไม่ส่งตรงจาก reviewer ไป worker)** —
บันทึก SPEC FINAL ใน handover แล้วดูจากรายงานของ `ui-design-agent` ว่าต้องแตะอะไร:
- ก. **UI ล้วน** (layout/สี/ข้อความ ไม่มีข้อมูลหรือ command ใหม่) → `fe-ui-agent` เลย
- ข. **มีข้อมูล/command ใหม่** → กำหนด contract → `fe-logic` ∥ `rust` → `fe-ui`
- ค. **ใหญ่หรือยังไม่ชัด** → `pm-agent` คืนแผนก่อน แล้วเข้าทาง ข.
ทุกทางจบที่ `qa-agent` + main session ตรวจซ้ำ ไม่ส่งผ่าน pm-agent ทุกงาน เพราะ
mockup ที่ผ่าน reviewer แล้วคือสเปกที่ชัดอยู่แล้ว

## ปิดงาน (main session ทุกครั้ง)

handover entry → `notion-sync-agent` → commit ในเครื่อง → push `personal`
หลังผู้ใช้ทดสอบแอปจริง → ถามผู้ใช้ว่าให้เปลี่ยน Notion เป็น Done ไหม

## บทเรียนที่ฝังอยู่ในกฎ

- **Worker เขียนเทสต์ของตัวเอง** — Feature 1: signature ของ `apply_mapping`
  เปลี่ยน ทำให้ `csv_tests.rs` พังค้าง เพราะเดิมเทสต์ทั้งหมดเป็นของ qa-agent คนเดียว
  ไม่มีใครเห็นทั้งสองฝั่ง → ตอนนี้ worker แก้เทสต์ที่ตัวเองทำพัง, qa ทำแค่ข้าม zone
- **Main session/pm ตรวจซ้ำเองเสมอ** — HANDOFF ว่า "tests pass" ครอบคลุมแค่ zone ตัวเอง
- **Notion sync เป็น agent แยก** — เพราะเคยถูกลืมซ้ำหลายรอบตอนเป็นแค่บรรทัดในเช็กลิสต์
- **ไม่มีไฟล์ task/requirement กลาง** — `task.md` ถูกเขียนครั้งสุดท้าย 2026-09-24
  แล้วงานจริงก็ทำต่างจากแผน; งานใหญ่หลังจากนั้นทั้งหมดอยู่ใน prompt + handover
  ไฟล์เลยกลายเป็นแหล่งข้อมูลเก่าที่หลอก agent

## ประวัติ

- ~2026-03: ออกแบบให้ pm-agent อ่าน `requirements.md` → เขียน `task.md` →
  spawn worker ทุกตัว ใช้จริงกับ Feature 1–3
- 2026-08-17: แก้กลไกให้ตรง harness (Agent tool, ไม่ใช่ CLI `--profile`), ให้
  worker เขียนเทสต์เอง
- 2026-09-24 / 09-29: Feature 4 ใช้แบบ main-session-as-orchestrator, เพิ่ม
  `ui-design-agent`, `notion-sync-agent`
- 2026-10-04: เพิ่ม `ui-design-lead` / `ui-design-reviewer` (Fable); รีวิว agent
  ทั้งหมด — ปิดช่องว่าง zone, ลบคำสั่งล้าสมัย, ห้าม worker commit
- 2026-10-05: ย้าย `docs/planning/` → `docs/archive/planning/`, pm-agent คืนแผน
  ในรายงานแทนการเขียนไฟล์ (ผู้ใช้ยืนยันว่าไม่ได้ใช้ไฟล์เหล่านั้นแล้ว)

## กฎเพิ่ม 2026-10-09 (จากข้อมูลการทำงานจริง 10 วัน)
- **agent ที่จบโดยไม่มีบล็อกรายงาน = ยังไม่ผ่าน** (HANDOFF / CODE REVIEW / DESIGN HANDOFF / DESIGN REVIEW / PLAN) → main session สั่งทำต่อด้วย SendMessage หรือรันใหม่ ห้ามข้ามไปขั้นถัดไป
- **แบ่งงานให้เล็ก**: งานออกแบบ 1 ครั้ง = 2–3 หน้าจอ หรือ feedback 1 รอบ; worker 1 ครั้ง = 1 phase; agent ต้องปิด server ที่เปิดเองก่อนรายงาน
- 2026-10-10: `ui-design-reviewer` เปลี่ยนจาก Fable เป็น Opus (ผู้ใช้เห็นว่า Fable ช้าเกินสำหรับงานตรวจตามเกณฑ์) — Fable เหลือเฉพาะ `ui-design-lead`
- 2026-10-10: `release-agent` เปลี่ยนจาก Opus เป็น Sonnet (ผู้ใช้สั่ง; งานหลักคืออ่าน handover + เขียน changelog)
- 2026-10-10: เพิ่ม `bug-investigator` (Opus, อ่านอย่างเดียว) — ผู้ใช้เจอบั๊กในแอปจริง → ตัวนี้หาสาเหตุที่แท้จริงก่อน → worker เจ้าของไฟล์แก้ + เพิ่ม regression test → main ตรวจซ้ำ; ลด context ของ main session ที่เคยไล่อ่านโค้ดเอง
- 2026-10-10: **แบ่งขนาดงานก่อนทำ** (วัดแล้วเวลาต่อคำสั่งใน session dev ขึ้นจาก 1–4 นาที เป็น 7–59 นาที เพราะงานเล็กถูกส่งผ่าน agent ~3 ตัว): เล็ก (1–2 ไฟล์ สาเหตุชัด) → main session แก้เอง ไม่ใช้ agent; กลาง → agent ตัวเดียว, reviewer เฉพาะส่วนเสี่ยง; ใหญ่ → ครบทุกขั้น · `notion-sync-agent` รันเบื้องหลังเสมอ
