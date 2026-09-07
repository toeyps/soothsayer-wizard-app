# Changelog

บันทึกการเปลี่ยนแปลงของแอป Soothsayer Wizard ทุกครั้งที่ build เป็น .exe/installer — เรียงจากเวอร์ชันล่าสุดไปเก่าสุด

> **กติกา**: ทุกครั้งที่ build app ต้องเพิ่ม section ใหม่ในไฟล์นี้ก่อนหรือพร้อมกับการ build เสมอ ห้ามข้าม — version bump ใช้กฎ semver ตาม category ที่รุนแรงที่สุด (Breaking/Feature → MINOR, Bug fix/Perf/Tests/Docs/Removed อย่างเดียว → PATCH) ดู [CLAUDE.md § Release checklist](../CLAUDE.md) ประกอบ

---

## [0.4.1] — 2026-09-07

Patch release. 0.4.0 shipped a Content-Security-Policy that breaks the Scatter
and Pair Plot charts; this reverts it. Nothing else changed.

### 🐛 Bug fixes

- **Scatter และ Pair Plot ใช้ไม่ได้ใน build ที่ติดตั้งจริงของ 0.4.0** — 0.4.0 ถอด
  `'unsafe-eval'` ออกจาก CSP ของ production ด้วยความเข้าใจว่าไม่มีอะไรต้องใช้แล้ว
  แต่ **`regl-scatterplot` ต้องใช้จริง**: regl สร้างโค้ด draw command เป็น string
  แล้วคอมไพล์ตอน runtime ด้วย Function constructor (`regl.js:6015`,
  `Function.apply(null, …)`) ซึ่งเป็นกลไกหลักของมัน ไม่ใช่ทางเลือกเสริม —
  พอ CSP บล็อก การสร้างกราฟจะโยน `EvalError` ทิ้งไปเงียบ ๆ กราฟจึงว่างเปล่า
  **ใส่ `'unsafe-eval'` กลับเข้า CSP แล้ว** กราฟ Scatter/Pair Plot กลับมาทำงานปกติ

  อาการนี้โผล่เฉพาะใน build ที่ติดตั้งจริงเท่านั้น — dev mode ใช้ `devCsp`
  คนละตัวซึ่งยังอนุญาต `'unsafe-eval'` อยู่ ทำให้ `tauri dev` ไม่มีทางเจอ

**หมายเหตุสำหรับผู้ใช้ 0.4.0**: ถ้าติดตั้ง 0.4.0 ไปแล้วและกราฟ Scatter หรือ
Pair Plot ขึ้นเป็นพื้นที่ว่าง นั่นคือบั๊กตัวนี้ — อัปเดตเป็น 0.4.1 แล้วหายทันที
ส่วนกราฟ Line, การนำเข้าข้อมูล, Failure Group และการเทรนโมเดลไม่ได้รับผลกระทบ

---

## [0.4.0] — 2026-09-03

รวมงานสะสมตั้งแต่ `12e51ec` (จุดที่ bump 0.3.0, 2026-08-24) — 46 commit — installer build จริงครั้งที่ 3 ของโปรเจกต์

**MINOR bump** เพราะมีทั้งฟีเจอร์ใหม่และการ redesign ใหญ่ — **workspace เก่าเปิดได้ตามปกติ ไม่ต้องทำอะไรเพิ่ม** (มี migration แปลง `groupNo` เดี่ยวเป็น `groupNos[]` ให้อัตโนมัติตอนเปิดไฟล์)

### ⚠️ พฤติกรรมที่เปลี่ยนไป — ควรอ่านก่อนอัปเดต

- **ปุ่มลบทุกปุ่มทำงานทันที ไม่มีกล่องยืนยันอีกแล้ว** — ลบ Failure Group, ลบโมเดล, เอา sensor ออกจากกลุ่ม ทั้งหมดลบทันทีที่กด (เดิมมี dialog ถามยืนยันก่อน) เป็นการตัดสินใจของผู้ใช้เอง ให้สอดคล้องกับส่วนอื่นของแอปที่ "กดแล้วเกิดขึ้นเลย"
- **เอา sensor ออกจาก Failure Group กลุ่มสุดท้าย = โมเดลนั้นถูกลบทิ้งจริง** — เดิมจะถูกย้ายไปกองไว้ที่ "Not in Group" แทน ตอนนี้หายไปเลยพร้อม config ที่เคยตั้งไว้ (predictor sensors, category, notes) ถ้าอยากเก็บโมเดลไว้แต่ไม่ผูกกับกลุ่มไหน ให้ติ๊กมันเข้า "Not in Group" เอง
- **ชนิดของโมเดล (Individual / Relationship / Clustering) ล็อกตั้งแต่ตอนสร้าง เปลี่ยนทีหลังไม่ได้** — ถ้าต้องการชนิดอื่นให้สร้างโมเดลใหม่ (sensor ตัวเดียวถือได้หลายชนิดพร้อมกันอยู่แล้ว)

### ✨ ฟีเจอร์ใหม่ / ปรับปรุงใหญ่

- **หน้า Predictive Model ยุบเข้ามาอยู่ในหน้าต่าง Build Model** — เดิมเป็นหน้าต่าง OS แยกอีกบานที่เปิดได้ทีละอัน ตอนนี้เป็นหน้าถัดไปในหน้าต่าง Build Model เดียวกัน กด Back กลับมาได้ และโหมดกราฟถูกล็อกให้ตรงกับชนิดของโมเดลที่กำลังดูอยู่โดยอัตโนมัติ
- **1 โมเดลอยู่ได้หลาย Failure Group พร้อมกัน และ 1 sensor มีได้หลายชนิดโมเดลพร้อมกัน** — เดิมโมเดลผูกกับกลุ่มเดียวแบบตายตัว ถ้าอยากให้โผล่ในอีกกลุ่มต้องสร้างสำเนาแยกที่แก้แล้วไม่ตามกัน ตอนนี้เป็นความสัมพันธ์แบบ many-to-many จริง และ sensor ตัวเดียวถือ Individual + Relationship + Clustering พร้อมกันได้
- **การสร้าง/ลบโมเดลย้ายมาอยู่ที่ Dashboard ทั้งหมด** — ติ๊กปุ่ม I / R / C ที่ sensor ในแผงขวาได้เลย ปุ่มเดียวทำทั้งเพิ่มและเอาออก ไม่ต้องเปิดหน้าต่าง Build Model ก่อน (หน้าต่าง Build Model เหลือหน้าที่แก้ไข/เทรนโมเดลที่มีอยู่แล้วอย่างเดียว)
- **"Not in Group" ใช้งานได้จริงแล้ว** — กองสำหรับโมเดลที่ยังไม่ผูกกับ failure mode ไหน ตอนนี้มองเห็น เพิ่มโมเดลเข้าไปได้ และเอาออกได้จริง (เดิมมีอยู่ในโครงสร้างข้อมูลแต่ใช้งานไม่ได้)
- **"Colour by value" ของกราฟ Scatter กลับมาแล้ว** — ย้ายไปอยู่ในแท็บ Highlights ระบายสีจุดตามค่าของ sensor ที่เลือก
- **แก้ชื่อ/คำอธิบาย/คำแนะนำของ Failure Group ได้จาก Dashboard โดยตรง** — ไม่ต้องเปิดหน้าต่าง Build Model เหมือนเดิม
- **Highlight แถวกลุ่มที่ sensor เป็นสมาชิกอยู่** ในเมนูเพิ่มเข้า Failure Group — พอมีกลุ่มเยอะ (10+) จะเห็นทันทีว่าตัวไหนติ๊กอยู่ ไม่ต้องไล่หา
- **Auto-fill Target sensor** ตอนเพิ่มโมเดล ถ้ากลุ่มนั้นมี sensor ที่เข้าเงื่อนไขอยู่ตัวเดียว
- **กันงานหายตอนปิดแอป** — ถ้าปิดโปรแกรมภายในเสี้ยววินาทีหลังแก้อะไรบางอย่าง ตอนนี้แอปจะรอเซฟให้เสร็จก่อนปิดจริง (เดิมการแก้ครั้งสุดท้ายอาจหายไปเงียบๆ)

### 🐛 Bug fixes

- **Special sensor ที่สร้างเองหายหมดหลังปิด-เปิดแอป** (บั๊กซ้อนกัน 3 ชั้น) — ฟีเจอร์นี้ไม่เคยรอดการปิดแอปเลย: ตัวคำนวณเก็บผลไว้แค่ใน memory ของโปรเซส, ตัวสูตรที่ใช้สร้างไม่เคยถูกบันทึกลงไฟล์, และต่อให้บันทึกแล้วชื่อ sensor ก็ยังไม่โผล่ในลิสต์อยู่ดี ตอนนี้เก็บ "สูตร" ลง workspace แล้วคำนวณซ้ำให้อัตโนมัติทุกครั้งที่เปิดไฟล์ รวมถึงกรณีที่ sensor พิเศษตัวหนึ่งสร้างต่อยอดจากอีกตัว
- **ปิดโปรแกรมไม่ได้เลย** — เกิดขึ้นหลังเพิ่มการรอเซฟก่อนปิด เพราะขาด permission ที่ Tauri ต้องใช้ตอนปิดหน้าต่างจริง
- **กราฟกระพริบเปลี่ยนสีตอนติ๊ก sensor ออกจากแผงขวา** — สีเส้นเคยผูกกับ "ลำดับที่" ของ sensor ในรายการที่เลือก พอเอาตัวหนึ่งออก ตัวที่เหลือเลื่อนตำแหน่งแล้วเปลี่ยนสีตาม ส่วนเส้นที่กำลังจะหายก็เปลี่ยนเป็นอีกสีก่อนหายไป ตอนนี้สีผูกกับตัว sensor เอง เลือกตัวเดิมกลับมาก็ได้สีเดิม
- **กด "Delete group" / "Remove model" แล้วลบไปก่อนที่ผู้ใช้จะกดยืนยัน**
- **แท็บ Failure Groups ไม่แสดง sensor tag** ต่างจากหน้าต่าง Build Model ที่แสดงให้
- **เอา sensor ออกจาก "Not in Group" ไม่ได้** — กดปุ่มแล้วไม่มีอะไรเกิดขึ้น
- **"Not in Group" ไม่มีทางเพิ่มโมเดลเข้าไปได้เลย** และตอนแก้รอบแรกก็ไปจำกัดสิทธิ์ผิดจนใช้ไม่ได้อีกแบบหนึ่ง
- **หน้าต่าง Build Model ไม่รู้ตัวว่าผู้ใช้สลับ workspace ไปแล้ว** — ค้างแสดงข้อมูลของ workspace เดิม (ตอนนี้ปิดตัวเองอัตโนมัติ)
- **ตอนเพิ่มโมเดล เลือก Target/X/Y sensor ได้ทุกตัวในระบบ** แทนที่จะจำกัดเฉพาะ sensor ที่อยู่ในกลุ่มนั้น และมี checkbox "Failure groups" ซ้ำซ้อนกับสิ่งที่เลือกไปแล้ว
- **ชนิดของโมเดล (I/R/C) มองไม่ออกว่าอันไหนเป็นอันไหน** — เพิ่ม badge สีประจำชนิดในแท็บ Sensor และแท็บ Failure Groups

### 🔒 ความปลอดภัย

- **อัปเดต ECharts เป็น 6.1.0 ปิดช่องโหว่ XSS** (GHSA-fgmj-fm8m-jvvx) — สำคัญเป็นพิเศษกับแอปเดสก์ท็อป เพราะข้อความที่กราฟเอาไปแสดง (ชื่อ/คำอธิบาย sensor) มาจากไฟล์ CSV ที่ผู้ใช้นำเข้าเอง และหน้าต่างแอปเข้าถึงคำสั่งอ่าน/เขียนไฟล์ได้
- ~~**ถอด `'unsafe-eval'` ออกจาก CSP ของ production build**~~ — **ถูก revert ใน 0.4.1** เพราะทำให้กราฟ Scatter และ Pair Plot ใช้ไม่ได้ (`regl-scatterplot` ต้องใช้ eval จริง) ดูรายละเอียดใน 0.4.1 ด้านบน

### ⚡ Performance

- **คำสั่งที่แค่อ่านข้อมูลทำงานขนานกันได้แล้ว** — เดิมทุกคำสั่งต่อคิวกันหมดไม่ว่าจะอ่านหรือเขียน ทำให้ตอนเปลี่ยน filter แล้วกราฟกับตารางดึงข้อมูลพร้อมกัน ตัวที่มาทีหลังต้องรอตัวที่หนักที่สุดเสร็จก่อน
- **แผง Sensor ไม่คำนวณสมาชิก Failure Group ซ้ำทุกแถวทุกครั้งที่ re-render** — เดิมพิมพ์ค้นหาแค่ 1 ตัวอักษรก็จ่ายค่าคำนวณใหม่ทั้งหมด
- **เลิกเขียนไฟล์ workspace ซ้ำรอบที่สอง** — การติ๊ก Failure Group 1 ครั้งเคยเขียนไฟล์ 2 รอบด้วยเนื้อหาเดียวกัน
- ลบโค้ดตายและ dependency ที่ไม่มีใครใช้ออกทั้งฝั่ง frontend และ Rust

### 🗑️ ที่ถูกลบออก

- **กล่องยืนยันก่อนลบทั้งหมด** (ดูหัวข้อ "พฤติกรรมที่เปลี่ยนไป" ด้านบน)
- **ปุ่ม "+ Add Model" ในหน้าต่าง Build Model** และแผง quick-add บน Dashboard — การสร้างโมเดลเหลือทางเดียวคือติ๊ก I/R/C ที่ sensor
- **ตัวเลือกเปลี่ยนชนิดโมเดล (Model kind picker)** — ชนิดล็อกตั้งแต่ตอนสร้าง
- **ป้าย "N Rows" ข้างแท็บ Selected Sensor** — ซ้ำกับตัวเลขบนกราฟที่บอกจำนวนจุดอยู่แล้ว

### 🧪 เทสต์ / เครื่องมือพัฒนา

- **ติดตั้ง ESLint ครั้งแรกของโปรเจกต์** — ก่อนหน้านี้มีคอมเมนต์ปิด ESLint อยู่ 11 จุดทั้งที่ไม่เคยติดตั้งตัวจริง กฎที่จับบั๊ก React hooks จึงไม่เคยทำงานเลย
- **เพิ่ม CI ที่รันเทสต์อัตโนมัติทุกครั้งที่ push** — เดิมมีแค่ workflow build installer ตอน tag ไม่มีอะไรรัน type-check / เทสต์ / clippy ให้เลย
- เพิ่มคำสั่งลัด `npm test`, `npm run lint`, `npm run typecheck`
- เทสต์ฝั่ง frontend เพิ่มเป็น **862 เทสต์ (49 ไฟล์)** และฝั่ง Rust 137 เทสต์
- แก้ `cargo clippy --all-targets` ที่คอมไพล์ไม่ผ่านมานานโดยไม่มีใครรู้ (เพราะไม่มี CI รันให้)
- เลิกพิมพ์ log ทิ้งไว้ 17 จุดใน production (มี 5 จุดอยู่บนเส้นทางเซฟไฟล์ที่ทำงานทุก 250 มิลลิวินาที)

### 📄 เอกสาร

- แก้เอกสารภายในที่ล้าสมัย 8 จุด ซึ่งสั่งให้ AI agent ทำงานกับ type ที่ถูกลบไปแล้ว และยังอธิบายฟีเจอร์ export PDF ที่ถอดออกไปตั้งแต่ 0.3.0 (คำอธิบายนั้นเองคือสิ่งที่ทำให้ `'unsafe-eval'` ค้างอยู่ใน CSP)
- `docs/BACKLOG.md` ตรวจสอบใหม่ทั้งหมดเทียบกับสภาพโค้ดจริง

---

## [0.3.0] — 2026-08-20

รวมงานสะสมตั้งแต่ tag `v0.2.1` (2026-08-11) — 62 commit — installer build จริงครั้งที่ 2 ของโปรเจกต์ (ครั้งแรกคือ 0.2.1)

### ✨ ฟีเจอร์ใหม่ / ปรับปรุงใหญ่

- **Build Model / Failure Group แปลงเป็น per-model records แยกกันจริง** — เดิม 1 Failure Group มี config Predictive Model ใช้ร่วมกันสล็อตเดียว สลับ target สลับ sensor แล้ว config เดิมโดนทับ ต้อง retrain ใหม่ทุกครั้ง ตอนนี้แต่ละโมเดล (Individual/Relationship/Clustering) มี config ของตัวเองแยกกันสมบูรณ์ — ย้ายมาแก้ไขในหน้าต่าง **"Build Model"** ใหม่ทั้งหมด (เปิดพร้อมกันได้หลายกลุ่ม ต่างจาก PM window เดิมที่เปิดได้ทีละหน้าต่าง) ส่วน Failure Groups tab บน Dashboard กลายเป็นหน้า preview อย่างเดียว เพิ่มฟิลด์ description/recommendation ของกลุ่ม, ModelKind/ModelCategory (Performance/Condition), และกันชื่อกลุ่มซ้ำ (เดิมสร้างซ้ำได้) **workspace เก่าย้ายข้อมูลให้อัตโนมัติตอนเปิด ไม่ต้องทำอะไรเพิ่ม**
- **Pair Plot ปรับปรุงใหญ่**: ครึ่งล่างของ matrix (เดิมว่างเปล่า) ตอนนี้แสดง **correlation heatmap** (ค่า Pearson r ต่อคู่ sensor ไล่สีแดง→เหลือง→เขียวตามขนาด |r|) เพิ่มเครื่องมือ **Pan/Zoom** ควบคู่กับ Lasso เดิม, ป้าย sensor ย้ายไปอยู่ "กรอบนอกเท่านั้น" (แถวบน/คอลัมน์ซ้าย) ไม่รกทุกช่องเหมือนเดิม, hover ป้ายชื่อ sensor เห็น description เป็น tooltip
- **เพิ่มแท็บ "Highlights"** — ตีกรอบช่วงเวลาที่สนใจ (ตั้งชื่อ+เลือกสี) แสดงเป็นแถบไฮไลต์บนกราฟ Line (โหมด band หรือ "Line-colour" ให้เส้นเปลี่ยนสีตามช่วง) และเป็นวงแหวนไฮไลต์จุดบน Scatter (Pair Plot ไม่รองรับ ใช้ lasso-cluster ของตัวเองแทน)
- **เพิ่มฟีเจอร์ Tag Point** — เทียบค่าจุดข้อมูล 2 จุดขึ้นไปแบบ side-by-side บนกราฟ Line และ Scatter กดไอคอน 🏷️ ในกล่องเครื่องมือแล้วคลิกจุดที่สนใจ ได้ badge เลข + การ์ดลอยโชว์ค่าทุก sensor ที่จุดนั้น คลิกจุดเดิมซ้ำเพื่อลบ tag ออก (ตั้งใจไม่ persist ลง workspace file — ปิดแอปแล้วเปิดใหม่ tag หายตามต้องการของผู้ใช้)

### 🐛 Bug fixes

- **Tag Point คลิกแล้วไม่ทำงานเลย** (2 บั๊กซ้อนกัน): `echarts-for-react` สร้าง chart instance รอบแรกแบบชั่วคราวแล้วสร้างใหม่ทับหลัง event `'finished'` — โค้ดเดิมผูก click handler กับ instance เก่าที่ถูกทำลายไปแล้ว, พอแก้จุดนี้แล้วยังคลิกไม่ติดอีกเพราะ `convertFromPixel({xAxisIndex:0}, ...)` คืนค่า `NaN` เสมอบน category axis ของ ECharts เวอร์ชันนี้ — เปลี่ยนไปใช้ `{seriesIndex:0}` แทนจึงใช้งานได้จริง
- **Pair Plot**: จุด scatter กับสี histogram ไม่ตรงกัน, พื้นหลัง cell ไม่ตรงกับพื้นแอป, เห็นแถบดำ ("letterbox") ในแต่ละ cell (regl-scatterplot สมมติ aspect ratio 1:1 โดย default), tooltip ไม่โผล่เลยเพราะ `sensorMetadata` ไม่ถูกส่งเข้า branch ที่สองของ `<Chart>`, tooltip ของหน้าต่างขยาย/แว่นขยายเรนเดอร์อยู่ *หลัง* backdrop ของตัวเอง (z-index ผิด)
- **แก้บั๊กสีเส้นกราฟใกล้เคียงกันเกินไป** (blue กับ indigo hue ห่างกันแค่ ~25°) — จัดลำดับ/ขยาย palette จาก 6 เป็น 12 สี
- **แก้บั๊กเลย์เอาต์ของหน้าต่าง Build Model หลายจุด**: ปุ่มท้ายฟอร์มโดนตัดที่ขอบล่าง (ขาด `min-height:0` บน flex container), footer ไม่ sticky, พื้นหลังหน้าต่างเข้มกว่า Dashboard, boundary/accent bar ของโมเดลที่เปิดอยู่ไม่ครอบถึงปุ่ม Remove/Save (เปลี่ยนจาก absolute-positioned bar เป็น border รอบการ์ดจริง)
- **แก้ ColorPlatePicker ของ Highlights เปิดผิดฝั่ง** (ปุ่มอยู่ซ้าย popup ไปโผล่ขวา)
- **แก้ปุ่ม "N sensors selected" และปุ่ม/dropdown ของ Scatter/Line/Pair Plot เป็นสีเข้มตายตัวไม่ตอบสนอง theme** — พบระหว่างพยายามรองรับ light theme (ภายหลังลบ light theme ออกทั้งหมด ดูหัวข้อ "ฟีเจอร์ที่ถูกลบ" — ผลลัพธ์สุดท้ายคือกลับไปใช้ dark theme ค่าคงที่)

### 🗑️ ฟีเจอร์ที่ถูกลบ

- **Light theme (และปุ่มสลับ dark/light ทั้งหมด)** — หลังไล่แก้บั๊กสีเฉพาะ light theme มาหลายรอบ (ปุ่ม/กราฟยังมีจุดสีเข้มตายตัวหลงเหลืออยู่เรื่อยๆ) ตัดสินใจลบออกทั้งหมด บังคับใช้ dark theme อย่างเดียว — ลบ `useThemeMode()` hook, theme state/localStorage, native menu "Toggle Theme", `[data-theme="light"]` CSS block ทั้งก้อน
- **"Export as PDF Report"** (หน้าต่าง Predictive Model) — ผู้ใช้ยืนยันไม่เคยใช้ ตัด `@react-pdf/renderer` ออก (dependency หนักที่สุดในแอป 1.46MB) ลดขนาด bundle ("Export as PNG" ยังอยู่ปกติ)
- **แท็บ "Data Insight"** — ไม่ได้ใช้งาน และพบว่ายิง query เปลืองแม้ไม่ได้เป็นแท็บที่เปิดอยู่ (ลบพร้อมได้ผลพลอยได้ด้าน performance) — ไฟล์ต้นฉบับยังอยู่ในโปรเจกต์เผื่อเอากลับมาใช้ทีหลัง
- **"Export dataset" (CSV export)** — ผู้ใช้ยืนยันไม่จำเป็น (มี raw data อยู่แล้วตั้งแต่ก่อนนำเข้าแอป) ลบทั้ง frontend และคำสั่ง Rust `export_chart_csv`
- **Tag Point: delta comparison ต่อจุด** — ฟีเจอร์ย่อยที่ไม่ได้ใช้ ตัดออก

### ⚡ Performance / เสถียรภาพ

- ลบ `@react-pdf/renderer` (และ dependency ลูกอีก 59 ตัว) — ลดขนาด JS bundle ลงมาก
- ลบ query สิ้นเปลืองของแท็บ Data Insight ที่ยิงอยู่เบื้องหลังแม้ไม่ได้เปิดดู
- **Windows installer build เหลือแค่ `.exe` (NSIS) ตัวเดียว** — เดิม build ทั้ง NSIS + MSI พร้อมกัน ตัด MSI ออกตามคำขอ (macOS build ไม่กระทบ ยังได้ `.dmg`/`.app` ตามเดิม)

### 📄 เอกสาร

- เพิ่ม `docs/tech-stack.html` — สรุป technical stack ของแอปแบบหน้าเดียว อ้างอิงตรงจาก `package.json`/`Cargo.toml`/`lib.rs`

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
