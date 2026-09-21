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
ดังนั้นแผนทดสอบใน `MANUAL_TEST_PLAN.md` (ตอนนี้ 217 ข้อ) ยัง **ไม่ได้รันสักข้อ** และแผนนี้ต้องรันบน installer ไม่ใช่ `tauri dev`
(CSP / path ของ Python sidecar ต่างกัน — บั๊ก 0.4.0 เห็นเฉพาะใน build จริง)

### แผนทดสอบถูกอัปเดตให้ตรงกับ 0.5.0 แล้ว (2026-09-21)

`MANUAL_TEST_PLAN.md` และ `manual-test-plan.html` อัปเดตแล้ว — **201 → 217 ข้อ, 21 → 23 หมวด**
(ไฟล์ HTML สร้างจาก Markdown ด้วย `python scripts/build-manual-test-html.py` — แก้ที่ `.md` แล้วรันคำสั่งนี้ ห้ามแก้ HTML ตรง ๆ;
`--check` ใช้ตรวจว่าสองไฟล์ตรงกันหรือไม่)

| การเปลี่ยนแปลง | รายละเอียด |
|---|---|
| **ตัดออก 6 ข้อ** (ฟีเจอร์ถูกเอาออก) | PM-2 (Save), PM-9 (Preview), PM-10 / PM-10b (Confirm Save), PM-11 (Export PNG / Report), PM-11c (Saving overlay) |
| **เขียนใหม่** | PREP-1, TIME-1, TIME-5, LINE-2, LINE-3 (เมนู Zoom แทน dataZoom), LINE-6, SPC-7, EDT-4b, FG-7, BMW-3/4/5, PM-1/3/4/5/6/8/13, PER-1, PER-7, ERR-5, PERF-5 |
| **เพิ่มใหม่ 22 ข้อ** | PREP-5, IMP-18, LINE-3b, BMW-9 ถึง BMW-12, PM-14 ถึง PM-17, PERF-6, **หมวด MULTI (7 ข้อ)** — หลายโปรเจกต์ / FG ไม่หาย, **หมวด VIS (3 ข้อ)** — กวาดหน้าตาหลังล้าง CSS |
| **รายการ "ที่รู้อยู่แล้ว"** | เพิ่ม: ไม่มีปุ่มเซฟโมเดล (ตั้งใจ), กราฟแกนเวลาช้ากว่าเดิม, ข้อจำกัดของการแก้บั๊กหลายโปรเจกต์ |

ผลที่เคยกรอกไว้ในหน้า HTML ผูกกับ id ของแต่ละข้อ — ถ้าเคยกรอกรอบก่อนไว้ให้กด "ล้างผลทั้งหมด" ก่อนเริ่มรอบนี้

### ลำดับที่แนะนำให้ทำบน installer

1. **PREP-1 → PREP-5** ติดตั้งตัวใหม่ และเตรียมโปรเจกต์ A/B ที่ข้อมูลต่างกันชัด
2. **MULTI-1 ถึง MULTI-7** — สำคัญที่สุด (บั๊กที่เพิ่งแก้ 2 กลุ่ม: ข้อมูลปนกันข้ามโปรเจกต์ และ FG หาย)
3. **BMW-4 ถึง BMW-12, PM-1 ถึง PM-17** — หน้า Build Model ที่เปลี่ยนเยอะสุด (predictor, Running Condition Filter, Finish, toolbar ใหม่)
4. **LINE-2, LINE-3, LINE-3b, LINE-6, TIME-1, TIME-5** — กราฟแกนเวลา + เมนู Zoom
5. **SPC-7, EDT-4b** — Component เป็น dropdown
6. **VIS-1 ถึง VIS-3** — กวาดหน้าตาหลังลบ CSS ~3,200 บรรทัด (เทสต์อัตโนมัติจับ style ที่หายไม่ได้)
7. ที่เหลือ (IMP, SEN, SCAT, PAIR, MNG, EDT อื่น ๆ, PER, ERR, PERF) รันตามแผนปกติ เป็น regression

**หมายเหตุ PM-5 (🐍 sidecar):** ตอนนี้ไม่มีปุ่มเทรนแล้ว **Apply ของโมเดล Relationship เป็นทางเดียวที่แตะ `backend.exe`** —
ถ้า Apply ทำงานบนตัวติดตั้งได้ แปลว่า sidecar ถูก bundle มาถูกต้อง (`backend.exe` 53.5 MB อยู่ข้าง `tauri-app.exe` แล้ว)

## หมายเหตุเรื่อง build script

`scripts/build-installer-windows.ps1` **ล้มแบบไม่มีข้อความ** เมื่อรันโดย redirect output ลงไฟล์ (`*> log`):
`$ErrorActionPreference = "Stop"` ทำให้ `npm notice` / warning ของ vite ที่ออก stderr กลายเป็น error
(ครั้งแรกล้มที่ `npm ci` ตอน node_modules ถูกล็อก ทำให้ `node_modules` เหลือครึ่งเดียว ต้อง `npm ci` ใหม่)
รันตรงๆ `npx tauri build --target x86_64-pc-windows-msvc` แล้วสำเร็จ — รัน script ในเทอร์มินัลปกติ (ไม่ redirect) น่าจะไม่เจอปัญหานี้
