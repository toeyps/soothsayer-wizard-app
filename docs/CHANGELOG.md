# Changelog

บันทึกการเปลี่ยนแปลงของแอป Soothsayer Wizard ทุกครั้งที่ build เป็น .exe/installer — เรียงจากเวอร์ชันล่าสุดไปเก่าสุด

> **กติกา**: ทุกครั้งที่ build app ต้องเพิ่ม section ใหม่ในไฟล์นี้ก่อนหรือพร้อมกับการ build เสมอ ห้ามข้าม — version bump ใช้กฎ semver ตาม category ที่รุนแรงที่สุด (Breaking/Feature → MINOR, Bug fix/Perf/Tests/Docs/Removed อย่างเดียว → PATCH) ดู [CLAUDE.md § Release checklist](../CLAUDE.md) ประกอบ

---

## [0.2.1] — 2026-08-11

เวอร์ชันก่อนหน้าที่เคย build เป็น installer จริงคือ **0.1.6** — เวอร์ชันนี้จึงรวมงานสะสมทั้งหมดตั้งแต่นั้นมา (0.2.1 เคยถูกตั้งไว้ในโค้ดมาสักพักแต่ไม่เคย build/แจกจริงมาก่อน) รวมทั้งหมด 10 commit

### ⚠️ Breaking change

- **ลบ operation "Product", "Subtract", "Divide" ออกจากเครื่องมือคำนวณ special sensor** — ตัดออกทั้งจาก calculation engine, หน้าจอ Add Special Sensor, และ chart-display pipeline ฝั่ง Rust เหตุผล: subtract/divide ต้องเลือก "base sensor" ซึ่งใช้งานสับสนและมักถูกใช้ผิด ส่วน product ไม่มี use case เหลือแล้วหลังตัดสองตัวนั้นออก **workspace เก่าที่เคยสร้าง special sensor ด้วย 3 operation นี้จะคำนวณค่าไม่ได้อีกต่อไป** — เหลือแค่ Sum / Average / Median สำหรับรวมหลาย sensor

### ✨ ฟีเจอร์ใหม่ / ปรับปรุงใหญ่

- **ออกแบบหน้าจอ "Add Special Sensor" ใหม่ทั้งหมด** — จากเดิมที่ต้องเลือกโหมด Simple/Advanced + Single/Multi Calc ก่อนถึงจะเห็น operation จริง เปลี่ยนเป็นพาเนลเดียวที่ปรับตัวเองตามจำนวน sensor ที่เลือก พร้อม "Combine with operators" (คลิกเปลี่ยนเครื่องหมายระหว่าง sensor แทนการพิมพ์), สูตรลัดใหม่ (Absolute difference, Spread, Efficiency %), และขั้นตอน "Then apply to the result" สำหรับประมวลผลต่อ
- **Special sensor มีชื่อ/หน่วย/component จริงแล้ว** — เพิ่มช่อง Name/Description/Unit/Component ตอนสร้าง ทำให้ sensor ที่คำนวณขึ้นมาไปอยู่ในกลุ่ม Sensor tab ที่ถูกต้อง แทนที่จะเป็นสตริงสูตรอ่านไม่ออกใน "Uncategorized" — ค่าพวกนี้ persist ข้าม save/reload workspace แล้ว
- **ยุบหน้าต่าง "Failure Group Creation" แยกต่างหากเข้า Dashboard** — จัดการ failure group (สร้าง/เปลี่ยนชื่อ/ลบกลุ่ม, มอบหมาย sensor, แก้ concept/model type/notes) ทำได้ในแท็บ "Failure Groups" ของ Sensor panel บน Dashboard เลย ไม่ต้องเปิดหน้าต่างแยก และกดปุ่ม "Build Model" เปิดหน้าต่าง Predictive Model ได้ตรงจาก Dashboard ทันที (ไม่ต้องผ่านหน้าจอ Failure Group ก่อนเหมือนเดิม)
- **เพิ่มเส้น Alarm setpoint บนกราฟ** — ดึงค่า ALARM_L/LL/H/HH จาก mapping CSV มาแสดงเป็นเส้นอ้างอิงบนกราฟ เปิด/ปิดได้ต่อ sensor จากแท็บ Sensor
- **แสดง error ที่เกิดขึ้นให้เห็นแทนที่จะเงียบหาย** — มีหน้าจอ crash (ErrorBoundary), toast แจ้ง error ที่ปิดได้, ดักจับ error ที่ไม่มีใครจับ (window.onerror/unhandledrejection) และบันทึกลง log file ถาวรที่เครื่อง

### 🐛 Bug fixes

- **แก้บั๊กใหญ่: 7 จาก 12 operation แบบ single-sensor ใช้ไม่ได้จริง** (abs/sqrt/log10/exp/ceil/floor/round) — โดน whitelist ฝั่ง frontend บล็อกไว้เงียบๆ ทั้งที่ Rust รองรับอยู่แล้ว
- **แก้บั๊ก formula engine**: ฟังก์ชัน sqrt/exp/log10/pow ที่โฆษณาไว้ใน Formula Syntax Help ใช้งานจริงไม่ได้ (ไม่ได้ implement ไว้ใน eval namespace) — sensor ที่สร้างจากสูตรพวกนี้จะได้ค่า missing ทั้งคอลัมน์แบบไม่มี error เตือนเลย ตอนนี้แก้แล้ว
- **สีเส้น/ตำแหน่ง Y-axis pin ต่อ sensor ไม่ persist** — ตั้งค่าผ่าน pipette/ไอคอนกราฟใน Selected Sensor tab แล้วหายเมื่อปิดแอปหรือ reload workspace ตอนนี้เก็บลง workspace แล้ว
- **Scatter chart axis pin หายเวลาสลับ chart type ไปมา** — ปักหมุดแกนไว้แล้วพอสลับไป Line chart แล้วกลับมา Scatter ค่าหายหมด แก้แล้ว พร้อม persist ข้าม session ด้วย
- **ค่า shortcut ช่วงเวลา (Y/M/W/D/H) ไม่ persist** — พิมพ์ค่าที่ไม่ใช่ default ไว้แล้วหายตอน reload
- **Scatter chart ลืมคู่ sensor X/Y เมื่อสลับ chart type** — ยกขึ้นไปเก็บที่ Dashboard state + persist แล้ว
- **Hue slider ของ color picker กระตุกกลับไป 0 ที่ขอบ 360 องศา** — แก้ด้วยการเก็บ hue/saturation/value เป็น local state แทนการคำนวณย้อนกลับจากสี RGB ทุก render
- **scatter/pair plot จอดำในโปรดักชันบิลด์** — regl ใช้ `Function()` compile render loop ซึ่งโดน production CSP บล็อก แก้ CSP + เพิ่ม fallback แจ้งเตือนในกราฟแทนที่แอปจะพังทั้งหน้าต่างเมื่อ WebGL init ไม่สำเร็จ
- **`get_scatter_sample` reject ทุกครั้งแบบเงียบๆ** — arg key เป็น camelCase (`maxPoints`) ไม่ตรงกับที่ Rust ต้องการ (`max_points`) ทำให้ scatter sample ไม่เคยโหลดสำเร็จเลยตั้งแต่แรก
- แสดงวันที่เป็นรูปแบบ YYYY/MM/DD ให้ตรงกันทั้งแอป

### ⚡ Performance / เสถียรภาพ

- **โครงสร้างข้อมูลในหน่วยความจำเปลี่ยนเป็น column-major** (`ColumnarData`) — RAM สูงสุดลดลง ~52%, เวลาโหลดลดลง ~32% (ทดสอบกับไฟล์ 367 MB / 2 ล้านแถว)
- **Frontend ไม่รับข้อมูลดิบทั้งชุดอีกต่อไป** — คำสั่งใหม่ `get_chart_data`/`get_table_page`/`get_scatter_sample`/`export_chart_csv` ประมวลผล filter + aggregate + ลดจำนวนจุดฝั่ง Rust ก่อนส่งมา ทำให้กราฟ/ตารางไม่โหลดข้อมูลเป็นล้านแถวเข้า WebView โดยตรง
- **กราฟเส้นลื่นขึ้นเมื่อข้อมูลเยอะ**: โปรไฟล์ perf พิเศษเมื่อมีจุด >2000 (ปิด animation/smoothing, ใช้ LTTB decimation) และปรับ tooltip/resize ให้ไม่กระตุก
- **Pair plot ไม่โยน draw call ทิ้งเวลาซ้อนกัน** — เรียง draw call ให้รวมกันแทนที่จะ error "Ignoring draw call…"

### 🧪 Test coverage (ใหม่ทั้งหมดในรอบนี้)

- Frontend: จาก 97 เทสต์ (5 ไฟล์) → **586 เทสต์ (45 ไฟล์)** ครอบคลุมทุกไฟล์ที่เคยไม่มีเทสต์เลย
- Rust: +81 unit test — path validation (กัน path traversal/CSV formula injection), formula DoS guard, filter logic ที่ dashboard ใช้ร่วมกัน
- เพิ่มกฎบังคับใน `CLAUDE.md`: ทุกการแก้โค้ดต้องมาพร้อมเทสต์ในรอบเดียวกันเสมอ

### 📄 เอกสาร

- เขียน `README.md` ใหม่ทั้งหมดให้ตรงกับสภาพแอปปัจจุบัน (เดิมล้าสมัยตั้งแต่ 2026-07-02)
- เพิ่ม `docs/PROJECT_HANDOVER.md`, `docs/BACKLOG.md`, `docs/PERSISTENCE_PLAN.md` สำหรับความต่อเนื่องข้ามเครื่อง/เซสชัน

### 🗑️ ฟีเจอร์ที่ถูกลบ

- **"Save As" (duplicate workspace)** — ปุ่มและเมนูที่เกี่ยวข้องถูกลบทั้งหมด ("Rename Workspace" ยังใช้งานได้ปกติ คนละฟีเจอร์กัน)
- **Moving Average / Rate of Change** ออกจากรายการ operation — ไม่เคย implement ฝั่ง backend จริง กดแล้วไม่มีอะไรเกิดขึ้นมาตลอด

---

## [0.1.6] และก่อนหน้า

ดูรายละเอียดได้จาก git tag `0.1.0`–`0.1.6` และ commit history ก่อน `5d92378` — ไม่มีการบันทึกละเอียดแบบ per-version ก่อนหน้านี้ เอกสารนี้เริ่มบันทึกอย่างเป็นระบบตั้งแต่เวอร์ชัน 0.2.1 เป็นต้นไป
