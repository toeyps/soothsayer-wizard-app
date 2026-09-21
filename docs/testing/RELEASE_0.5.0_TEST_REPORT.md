# Release 0.5.0 — รายงานทดสอบ

> วันที่ build: 2026-09-21 · commit `eda2504` · tag `v0.5.0` · ต่อจาก `v0.4.1` (2026-09-07)
> ไฟล์ติดตั้ง: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Wizard_0.5.0_x64-setup.exe`
> (57.5 MB · SHA-256 `2F1D26AA70C0A77C44B2D4C10FBC23D5E65F88D07CAE2ECF3FCAEFF38DD691DE`)

## สิ่งที่ตรวจแล้ว (อัตโนมัติ — ผ่านทั้งหมด)

| รายการ | ผล |
|---|---|
| `tsc --noEmit` | สะอาด |
| `eslint .` | 0 error (54 warning `no-explicit-any` เดิม) |
| `vitest run` (frontend) | **993 / 993** ผ่าน (44 ไฟล์) |
| `cargo test` (Rust) | **155** unit + **8** integration ผ่าน (1 ignored) |
| `npm run build` (tsc + vite) | ผ่าน |
| `tauri build` → NSIS installer | สำเร็จ; `FileVersion`/`ProductVersion` = **0.5.0** |
| Smoke test ไฟล์ `.exe` ที่ build | เปิดได้, ไม่ค้าง (Responding), หน้าต่างชื่อ "Wizard", WebView2 ขึ้น, ปิดได้ปกติ |

Version 0.4.1 → **0.5.0** (MINOR: มี feature ใหม่ + เอาปุ่ม Report/Preview/Save Model ออก) —
`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` ตรงกันหมด,
`docs/release/CHANGELOG.md` มี section `[0.5.0]`

## สิ่งที่ยังไม่ได้ตรวจ — ต้องมีคนกดจริงบน installer

**Claude ไม่สามารถคลิกใช้งานแอป Tauri ที่ติดตั้งแล้วได้** (ไม่มีเครื่องมือควบคุมหน้าต่าง desktop; ตัวเบราว์เซอร์ที่มีเปิดได้แค่หน้า Vite
ที่ไม่มี backend) smoke test ข้างบนยืนยันได้แค่ว่าโปรแกรมเปิดและไม่พัง — **ไม่ได้ยืนยันว่าฟีเจอร์ทำงานถูก**
ดังนั้นแผนทดสอบ 201 ข้อใน `MANUAL_TEST_PLAN.md` ยัง **ไม่ได้รันสักข้อ** และแผนนี้ต้องรันบน installer ไม่ใช่ `tauri dev`
(CSP / path ของ Python sidecar ต่างกัน — บั๊ก 0.4.0 เห็นเฉพาะใน build จริง)

### ข้อในแผนเดิมที่ล้าสมัย — ข้ามได้ (ฟีเจอร์ถูกเอาออกใน 0.5.0)

| ข้อ | เหตุผล |
|---|---|
| LINE-3, PERF-5 (ส่วนที่ใช้ dataZoom) | แถบเลื่อนใต้กราฟถูกแทนด้วยเมนู Horizontal Zoom |
| PM-8 (ขั้น Save Model / Confirm & Save) | ไม่มีปุ่ม Save Model แล้ว — ทดสอบแค่ว่า Time start/end เปลี่ยนกราฟตัวอย่างใน Standard Time Series |
| PM-9 (Preview modal), PM-10, PM-10b (Confirm Save), PM-11 (Export PNG / Report), PM-11c (Saving overlay) | ถูกลบทั้งหมด |

### ต้องทดสอบเพิ่ม — สิ่งที่ 0.5.0 เปลี่ยน (ไม่มีในแผนเดิม)

**A. เปิดมากกว่า 1 project (บั๊กที่เพิ่งแก้ — สำคัญที่สุด)**
1. เปิด project A → กด Add Special Sensor สร้าง sensor (ใส่ Component/Description) → กลับหน้า Import → เปิด project B
2. หน้าต่าง Add Special Sensor ของ A ต้องถูกปิดไปแล้ว; กด Add Special Sensor ใน B ต้องเห็นแต่ sensor ของ B
3. เปิด Build Model ใน B → FG / ชื่อ / component ต้องเป็นของ B
4. สลับ A↔B เร็วๆ หลายรอบ เปิด Build Model ทุกรอบ → FG ต้องตรง project เสมอ
5. เปิด Build Model ค้างไว้ แล้วแก้ FG ที่ Dashboard (ติ๊ก sensor เข้ากลุ่ม) → Build Model ต้องอัปเดตทันที

**B. Failure Group ไม่หาย**
6. สร้าง FG/model หลายอัน กด Build Model รัวๆ → ข้อมูลต้องครบ
7. ปิดโปรแกรมแล้วเปิดใหม่ (ไม่ทำอะไรระหว่างนั้น) → เปิด workspace เดิม FG ต้องอยู่ครบ (ใช้งานต่อเนื่องสัก 2–3 วันถึงจะมั่นใจ — เป็น race ข้ามหน้าต่าง)

**C. หน้า Build Model**
8. โมเดล Relationship: เลือก predictor ที่หน้า Overview → กด Build Model → หน้า PM ต้องมี predictor ครบ (ไม่ใช่ "No predictors selected")
9. ช่อง Add a predictor: พิมพ์ค้นหาได้ และรายการแบ่งกลุ่มตาม Component
10. ปุ่ม Finish (มุมขวาบน) → กลับ Overview และป้ายโมเดลเปลี่ยนเป็น Complete; กดซ้ำไม่เปลี่ยนกลับ
11. Toolbar เหลือแค่ Back + Finish (ไม่มี Report / Preview / Save Model); หัวข้อซ้ายบนเขียน "Target sensor"
12. Group by Model Type; ปุ่ม Build Model จางจนกรอกครบ
13. Running Condition Filter ที่ Overview → มีผลกับทุกโมเดล
14. ไอคอนปฏิทินช่อง Time start/end เห็นชัด (สีขาว ชิดขวา) และกดเปิดตัวเลือกวันที่ได้

**D. Line chart**
15. ข้อมูลห่าง 10 นาที vs 10 ชั่วโมง ระยะห่างจุดบนแกนต้องต่างกันจริง; tooltip โชว์ค่าปกติ; Tag Point คลิกติด
16. เมนู Zoom (ข้างปุ่ม Tag): Horizontal zoom ลากเลือกช่วงแล้วซูมเข้า, Zoom out กลับ; เมนูไม่ถูกตัดขอบ

**E. Special sensor**
17. เปลี่ยนชื่อ special sensor (Manage) → สูตร/กราฟ/สี/โมเดลที่อ้างชื่อเดิมตามชื่อใหม่
18. Add/Save กดไม่ได้จนกรอก Name + Description + Unit + Component ครบ; Component เลือกจากรายการ

**F. Regression ที่ควรกวาดเร็วๆ** — Scatter / Pair Plot ขึ้นภาพ (ตรวจ CSP `unsafe-eval`), เทรนโมเดล Relationship
(path เดียวที่เรียก Python sidecar — *ปัจจุบันไม่มีปุ่มเทรนใน UI แล้ว จึงยืนยันได้แค่ว่า sidecar อยู่ในตัวติดตั้ง:
`backend.exe` 53.5 MB อยู่ข้าง `tauri-app.exe`*)

## หมายเหตุเรื่อง build script

`scripts/build-installer-windows.ps1` **ล้มแบบไม่มีข้อความ** เมื่อรันโดย redirect output ลงไฟล์ (`*> log`):
`$ErrorActionPreference = "Stop"` ทำให้ `npm notice` / warning ของ vite ที่ออก stderr กลายเป็น error
(ครั้งแรกล้มที่ `npm ci` ตอน node_modules ถูกล็อก ทำให้ `node_modules` เหลือครึ่งเดียว ต้อง `npm ci` ใหม่)
รันตรงๆ `npx tauri build --target x86_64-pc-windows-msvc` แล้วสำเร็จ — รัน script ในเทอร์มินัลปกติ (ไม่ redirect) น่าจะไม่เจอปัญหานี้
