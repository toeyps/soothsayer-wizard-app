# แผนแก้ปัญหา "ปิดโปรแกรมแล้วข้อมูลหาย" (Persistence Audit + Options)

> เขียน 2026-08-06 — จากการไล่โค้ดจริงทั้งโปรเจกต์ (ไม่ได้เดา) + ค้นหาแนวทางเพิ่มเติมจากภายนอก
> **สถานะ: ยังไม่ได้ implement อะไรเลย — เอกสารนี้ไว้ให้ผู้ใช้เลือกแนวทางก่อนลงมือ**
>
> ต่อยอดจาก `docs/BACKLOG.md` ข้อ 7 (ซึ่งบันทึกไว้แค่ special sensor + 2 แนวทาง) — รอบนี้ขยายเป็น
> audit ทั้งโปรเจกต์ + เพิ่มแนวทางที่ 3-5 ที่ยังไม่เคยคุยกัน

---

## 1. Audit: มีอะไรบ้างที่หายตอนปิดโปรแกรม

ไล่ทั้งโปรเจกต์แล้วพบว่าปัญหาแบ่งเป็น **2 ประเภทที่ต่างกันโดยสิ้นเชิง** — ต้องแยกให้ออกก่อน
เพราะวิธีแก้คนละเรื่องกัน:

### Class A — ข้อมูลจริงหายจาก RAM (ร้ายแรง, แก้ยาก)

| # | สิ่งที่หาย | ที่มา | หลักฐานในโค้ด |
|---|---|---|---|
| A1 | **Special sensor (คอลัมน์ที่คำนวณเอง)** | สร้างผ่าน Add Special Sensor | `lib.rs:1761-1762`, `lib.rs:2113-2114` push คอลัมน์ใหม่เข้า RAM; `lib.rs:226` แทนที่ทั้ง `SessionData` ใหม่ทุกครั้งที่ resume |

**✅ ยืนยันแล้วว่า Class A มีแค่รายการเดียว** — grep หา `columns.push`/`headers.push`/`state_lock = Some`
ทั่ว `lib.rs` แล้วพบจุดที่แก้ไข `ColumnarData` ตอน runtime แค่ 2 จุด (`calculate_new_sensor` กับ
`evaluate_formula`) ซึ่งทั้งคู่คือการสร้าง special sensor ทั้งหมด — **ไม่มีฟีเจอร์อื่นในแอปที่เขียน
ข้อมูลลง RAM store แล้วไม่ได้ลงดิสก์อีกเลย** (ข่าวดี: ขอบเขตปัญหาจำกัดชัดเจน)

**อาการที่ผู้ใช้เห็น**: ชื่อ sensor ยังอยู่ (เพราะ `selectedSensors` + `extraSensorMetadata`
persist อยู่ใน workspace JSON) แต่ข้อมูลจริงหาย → หายจาก Sensor tree, กราฟว่าง

---

### Class B — ค่า config/UI หาย (ไม่ร้ายแรง, แก้ง่ายมาก)

state ที่อยู่ใน React แต่ไม่เคยถูกเขียนลง `WorkspaceState` เลย:

| # | สิ่งที่หาย | ไฟล์:บรรทัด | ความสำคัญ | หมายเหตุ |
|---|---|---|---|---|
| B1 | ~~**สีเส้นต่อ sensor**~~ (`sensorColors`) | `Dashboard.tsx:368` | 🔴 สูง | **✅ แก้แล้ว 2026-08-06** — persist ผ่าน `WorkspaceState.sensorColors` แล้ว |
| B2 | ~~**Y-axis pin ต่อ sensor**~~ (`sensorAxisRange`) | `Dashboard.tsx:371` | 🔴 สูง | **✅ แก้แล้ว 2026-08-06** — persist ผ่าน `WorkspaceState.sensorAxisRange` แล้ว |
| B3 | ~~**ค่า min/max ที่ล็อกสเกลแกนของ Scatter**~~ (`xPin`/`yPin` — ปุ่มไม้บรรทัด 📏 ใน toolbox) | `ScatterChart.tsx:116-117` | 🟠 กลาง | **✅ แก้แล้ว 2026-08-06** — lift state ขึ้นไป `Dashboard.tsx` (`scatterAxisPins`) แบบเดียวกับ `scatterAxes` แล้ว persist ผ่าน `WorkspaceState.scatterAxisPins` (type ใหม่ `ScatterAxisPins`) — คนละตัวกับ `scatterAxes` ที่แก้ไปก่อนหน้า (อันนั้นคือ "sensor ไหนขึ้นแกน" อันนี้คือ "แกนนั้นสเกลเท่าไหร่") |
| B4 | **Pair Plot clusters** (lasso) | `PairPlotChart.tsx:167` | 🟠 กลาง | ผู้ใช้ลากเลือกเอง ตั้งชื่อ/สีได้ = งานจริงที่เสียไป หายตอนสลับ chart type ด้วย — **ยังไม่ทำ ตามที่ผู้ใช้สั่งไว้** |
| B5 | แท็บที่เปิดค้างไว้ (`activeSensorTab`, `activeDataTab`) | `Dashboard.tsx:305, 1428` | 🟡 ต่ำ | `activeSensorTab` มี workaround ผ่าน `lastRoute` อยู่แล้วบางส่วน — **ยังไม่ทำ** (ผู้ใช้ไม่ได้พูดถึงจุดนี้ตอนสั่ง "ทำ B5" — สิ่งที่ผู้ใช้อธิบายจริงตรงกับ B6 ด้านล่าง ไม่ใช่ตัวนี้ ดูหมายเหตุใน entry ของ `PROJECT_HANDOVER.md` วันที่ 2026-08-06) |
| B6 | ~~ปุ่ม Y/M/W/D/H ที่เลือกไว้~~ (`relativeAmount`/`relativeUnit`) | `Dashboard.tsx:1167-1168` | 🟡 ต่ำ | **✅ แก้แล้ว 2026-08-06** — persist ผ่าน `WorkspaceState.relativeTimeRange` — ช่วงเวลาที่ใช้งานจริงก็ persist อยู่แล้วผ่าน `filters` เหมือนเดิม อันนี้แก้แค่ "ปุ่มไหนถูกไฮไลต์/เลขในกล่องคืออะไร" ให้จำด้วย |
| B7 | ผลลัพธ์ที่ fit แล้วใน PM (`relPreview`/`subModels`/`clusteringPreview`) | `PredictiveModelBuild.tsx:343-384` | ⚪️ ตั้งใจ | **ไม่ใช่บั๊ก** — คอมเมนต์ที่ `:641-644` บอกชัดว่าจงใจไม่ persist เพื่อไม่ให้ workspace JSON บวม ต้องกด Apply ใหม่ |

**สิ่งที่ persist ถูกต้องอยู่แล้ว** (ตรวจแล้ว ไม่ต้องแตะ): `selectedSensors`, `visibleSensors`,
`filters`, `chartType`, `samplingMethod`, `collapsedPanels`, `layoutSizes`, `failureGroupState`,
`alarmLinesEnabled`, `scatterAxes`, `extraSensorMetadata`, `outputDir`, `predictiveModelState`
(ทั้ง 14 field ของ config)

---

## 2. แนวทางแก้ Class A (special sensor) — 5 ทางเลือก

### ทางเลือก 1: เขียนกลับลงไฟล์ CSV ต้นฉบับ

เพิ่มคอลัมน์ที่คำนวณแล้วลงไฟล์ CSV ของผู้ใช้โดยตรง

| ข้อดี | ข้อเสีย |
|---|---|
| resume แล้วได้ข้อมูลทันที ไม่ต้องคำนวณใหม่ | ⛔ **ไฟล์ผู้ใช้อาจใหญ่ถึง 2 GB** — rewrite เสี่ยงมาก |
| | ⛔ ไฟดับ/crash กลางคัน = ข้อมูลต้นฉบับ (ที่มักหามาใหม่ไม่ได้) พัง |
| | ⛔ ถ้า workspace merge หลายไฟล์ ไม่รู้จะเขียนลงไฟล์ไหน |
| | ⛔ **ขัดกฎของแอปเอง** — `CLAUDE.md` ระบุว่าเขียนไฟล์ได้เฉพาะผ่าน `write_user_file` ไป `$APPDATA` หรือ path ที่ผู้ใช้เลือก export เท่านั้น ห้ามแตะไฟล์ input |

**สรุป: ❌ ไม่แนะนำสำหรับ time-series CSV** (แต่สำหรับ *mapping CSV* ซึ่งเป็นไฟล์เล็ก
เก็บแค่ master data — ยอมรับได้ ดู "ทางเลือกเสริม" ด้านล่าง)

---

### ทางเลือก 2: เก็บ "สูตร" ไว้ แล้ว replay ใหม่ทุกครั้งที่ resume ⭐

เก็บแค่ recipe (formula string หรือ `SensorOperationConfig` + sensor ต้นทาง) ลง workspace JSON
พอ resume เสร็จ (`load_csv` เรียบร้อย) ก็สั่งคำนวณใหม่ตามลำดับที่สร้าง

| ข้อดี | ข้อเสีย |
|---|---|
| ✅ ไม่แตะไฟล์ผู้ใช้เลย | ต้องคำนวณใหม่ทุกครั้งที่เปิด (ดู "ประเมินต้นทุน" ด้านล่าง) |
| ✅ workspace JSON เล็กมาก (เก็บแค่ string) | ต้อง replay ตามลำดับ ถ้า sensor A สร้างจาก sensor B |
| ✅ ถ้าไฟล์ CSV ต้นฉบับอัปเดต ค่าที่ได้จะ**ตรงกับข้อมูลใหม่อัตโนมัติ** | ถ้า sensor ต้นทางหายจาก CSV → replay fail ต้องมี graceful degradation |
| ✅ ใช้โค้ดที่มีอยู่แล้ว 100% (`calculate_new_sensor`/`evaluate_formula` ไม่ต้องแก้ core logic) | |

**หมายเหตุจากการค้นคว้า**: แนวทางนี้ตรงกับ "non-persisted / virtual computed column" ของฐานข้อมูล
ซึ่งเอกสารของ SQL Server ระบุว่าเหมาะเมื่อ *"the formula is light"* — และ**เงื่อนไขสำคัญคือสูตรต้อง
deterministic** (ให้ผลเหมือนเดิมทุกครั้งกับ input ชุดเดิม) ซึ่ง operation ทั้งหมดในแอปนี้
(บวก/ลบ/คูณ/หาร, abs/sqrt/log, sum/mean/median, spread, efficiency) **เป็น deterministic หมด**
→ replay ปลอดภัยในเชิงทฤษฎี

---

### ทางเลือก 3: snapshot ทั้ง dataset (หลังคำนวณแล้ว) เป็นไฟล์ binary ใน `$APPDATA` 🆕

หลังโหลด+คำนวณเสร็จ เขียน `ColumnarData` ทั้งก้อน (รวมคอลัมน์ที่คำนวณแล้ว) เป็นไฟล์
**Arrow IPC / Feather V2** หรือ **Parquet** ใน `$APPDATA` ผูกกับ workspace id — พอ resume
ก็โหลดไฟล์นี้แทนการ re-parse CSV

| ข้อดี | ข้อเสีย |
|---|---|
| ✅ **resume เร็วขึ้นมหาศาล** — ไม่ต้อง re-parse CSV เลย (ตอนนี้ใช้เวลาหลักร้อย ms ถึงวินาที) | ⛔ กินดิสก์เพิ่มเท่าตัว (dataset ใหญ่ = ไฟล์ cache ใหญ่ตาม อาจเป็น GB) |
| ✅ ไม่แตะไฟล์ต้นฉบับ | ต้องมี cache invalidation — ถ้าผู้ใช้แก้ CSV ต้นฉบับ ต้องรู้ว่า cache เก่าแล้ว (เช็ค mtime/size/hash) |
| ✅ Arrow IPC **memory-map ได้** → เปิดไฟล์ใหญ่กว่า RAM ได้ (ตรงกับทิศทาง "step 3: disk-backed store" ที่ `CLAUDE.md` วางไว้อยู่แล้ว) | ต้องเพิ่ม dependency ใหม่ฝั่ง Rust (`arrow`/`parquet` crate) = build time + binary size เพิ่ม |
| | เป็นงานใหญ่กว่าทางเลือก 2 มาก |

**หมายเหตุ**: ถ้าดิสก์/IO ช้า Parquet จะเล็กกว่า Arrow IPC มาก (บีบอัดดีกว่า) แต่ Arrow IPC
อ่าน/เขียนเร็วกว่า — เลือกตามว่าจะ optimize ขนาดหรือความเร็ว

---

### ทางเลือก 4: เก็บ *เฉพาะคอลัมน์ที่คำนวณ* เป็นไฟล์ sidecar ใน `$APPDATA` 🆕

ลูกผสมของ 1 กับ 3 — ไม่ snapshot ทั้ง dataset แต่เก็บแค่คอลัมน์ที่คำนวณเอง (ซึ่งมีไม่กี่คอลัมน์)
เป็นไฟล์เล็กๆ ใน `$APPDATA` พอ resume ก็โหลด CSV ตามปกติแล้ว "แปะ" คอลัมน์จาก sidecar กลับเข้าไป

| ข้อดี | ข้อเสีย |
|---|---|
| ✅ ไฟล์เล็กกว่าทางเลือก 3 มาก (เก็บแค่ N คอลัมน์ ไม่ใช่ทั้ง dataset) | ⛔ **ต้องมั่นใจว่าแถวตรงกัน** — ถ้า CSV ต้นฉบับเปลี่ยน (เพิ่ม/ลบแถว) คอลัมน์ที่แปะกลับจะ**เลื่อนผิดแถวแบบเงียบๆ** = ข้อมูลผิดโดยไม่มี error |
| ✅ ไม่ต้องคำนวณใหม่ (เร็วกว่าทางเลือก 2) | ต้องเก็บ key (timestamp) คู่กับค่าเพื่อ validate → ไฟล์ใหญ่ขึ้น + ต้องเขียน merge logic ใหม่ |
| ✅ ไม่แตะไฟล์ต้นฉบับ | ซับซ้อนกว่าทางเลือก 2 แต่ได้ประโยชน์ไม่ต่างกันมาก |

**ความเสี่ยงข้อ "แถวเลื่อน" คือจุดตายของแนวทางนี้** — เป็น failure mode ที่ผู้ใช้จับไม่ได้ด้วยตา

---

### ทางเลือก 5: เปลี่ยน store เป็น DuckDB / SQLite 🆕

เปลี่ยนสถาปัตยกรรมจาก in-RAM `ColumnarData` เป็นฐานข้อมูลจริงบนดิสก์ — special sensor
กลายเป็น **VIEW** (คำนวณสด) หรือ **materialized table** (เก็บผลไว้) แล้วแต่จะเลือก

| ข้อดี | ข้อเสีย |
|---|---|
| ✅ แก้ปัญหานี้ "ฟรี" ในตัวสถาปัตยกรรม (persist โดยธรรมชาติ) | ⛔ **rewrite ครั้งใหญ่มาก** — `csv_processor.rs` + `chart_query.rs` (2,100 บรรทัดรวมกัน) ต้องเขียนใหม่แทบทั้งหมด |
| ✅ ได้ SQL มาใช้ query ด้วย | ⛔ เสี่ยงพัง feature ที่ทำงานดีอยู่แล้วทั้งหมด |
| ✅ ตรงกับ "step 3" ที่ `CLAUDE.md` วางแผนไว้แล้ว | ⛔ overkill สำหรับปัญหาแค่นี้ |

**สรุป: ❌ ไม่คุ้มถ้าทำเพื่อแก้ปัญหานี้อย่างเดียว** — เก็บไว้พิจารณาตอนที่ RAM ไม่พอจริงๆ
(ซึ่ง `CLAUDE.md` บอกว่ายังไม่ถึงจุดนั้น)

---

## 3. ข้อเสนอแนะ

### สำหรับ Class A: **ทางเลือก 2 (recipe replay)** เป็นคำตอบหลัก

เหตุผล — เทียบกันตรงๆ แล้ว:
- **ทางเลือก 1** ผิดกฎความปลอดภัยของแอปเอง → ตัดทิ้ง
- **ทางเลือก 5** rewrite ใหญ่เกินเหตุ → ตัดทิ้ง
- **ทางเลือก 4** มี failure mode ที่ข้อมูลผิดแบบเงียบๆ (แถวเลื่อน) ซึ่งอันตรายกว่าปัญหาเดิม → ตัดทิ้ง
- เหลือ **2 vs 3** — ทางเลือก 3 เร็วกว่าตอน resume แต่งานใหญ่กว่าหลายเท่า + เปลือง
  ดิสก์ + ต้องจัดการ cache invalidation

**ต้นทุนที่แท้จริงของทางเลือก 2 (ประเด็นชี้ขาด)**: การคำนวณ special sensor เป็น
**row-wise operation ฝั่ง Rust** — วนแถวเดียวจบ ไม่มี join/sort ตัวอย่างจาก `evaluate_formula`
คือ pre-compile สูตรครั้งเดียวแล้ววน `for r in 0..n` เท่านั้น สำหรับข้อมูลระดับล้านแถว
คาดว่าใช้เวลาหลัก **สิบ ms ต่อ sensor** ซึ่ง**เทียบไม่ติดกับเวลา re-parse CSV ที่ทำอยู่แล้วทุกครั้ง**
(หลักร้อย ms ถึงวินาที) → ผู้ใช้จะไม่รู้สึกถึงส่วนที่เพิ่มมาเลย

> ⚠️ **ตัวเลขนี้เป็นการประเมินจากการอ่านโค้ด ยังไม่ได้วัดจริง** — ถ้าจะทำจริงควรวัด
> ก่อนด้วย dataset ใหญ่สุดที่ผู้ใช้มี ถ้าช้ากว่าที่คิดมาก ค่อยพิจารณาทางเลือก 3 แทน

**ทางเลือกเสริม (ทำคู่กันได้)**: master data (tag/description/unit/component) ของ special sensor
ตอนนี้ persist อยู่แล้วผ่าน `extraSensorMetadata` ใน workspace JSON — **ไม่ต้องเขียนกลับลง
mapping CSV ก็ได้** ต่างจากตอนที่คุยกันไว้ใน BACKLOG ข้อ 7 (ตอนนั้น `extraSensorMetadata`
ยังไม่มี เพิ่งมาทีหลัง) → **ตัดงานส่วนนี้ออกได้เลย เหลือแค่ replay ค่าจริงอย่างเดียว**

### สำหรับ Class B: แก้แยกต่างหาก งานเล็กมาก

B1-B4 แค่เพิ่ม field ลง `WorkspaceState` + ต่อเข้า `buildWorkspaceState()` — pattern เดียวกับที่
เพิ่งทำกับ `scatterAxes`/`alarmLinesEnabled` มาแล้ว 2 รอบ ใช้เวลาน้อยและความเสี่ยงต่ำ
**ทำได้เลยโดยไม่ต้องรอตัดสินใจเรื่อง Class A**

---

## 4. แผนการทำงาน (ถ้าเลือกทางเลือก 2)

### Phase 0 — วัดต้นทุนจริงก่อน (กันพลาด)
1. เปิด workspace ที่มีข้อมูลเยอะสุดเท่าที่มี
2. สร้าง special sensor 3-5 ตัว
3. จับเวลา `calculate_new_sensor`/`evaluate_formula` แต่ละครั้ง (มี log อยู่แล้วหรือเพิ่มชั่วคราว)
4. **ถ้ารวมกันเกิน ~1 วินาที → หยุด กลับมาพิจารณาทางเลือก 3 ใหม่**

### Phase 1 — เก็บ recipe (ยังไม่ replay)
1. `types.ts`: เพิ่ม type ใหม่
   ```ts
   export type CalculatedSensorRecipe =
     | { kind: 'formula'; tag: string; formula: string; customName?: string }
     | { kind: 'operation'; tag: string; sensors: string[]; config: SensorOperationConfig };
   ```
   แล้วเพิ่ม `calculatedSensors?: CalculatedSensorRecipe[]` ใน `WorkspaceState`
2. `AddSensorWindow.tsx`: ตอน `computeCurrentRound()` สำเร็จ ให้ส่ง recipe แนบไปกับ event
   `add-sensor-selection` (ข้างๆ `newMetadata` ที่ส่งอยู่แล้ว)
3. `Dashboard.tsx`: รับ recipe เก็บเป็น state `calculatedSensors` (**เรียงตามลำดับที่สร้าง** —
   สำคัญมากสำหรับ sensor ที่สร้างซ้อนกัน) + ต่อเข้า `buildWorkspaceState()`
4. ยังไม่มีอะไรเปลี่ยนในพฤติกรรม — แค่เริ่มเก็บข้อมูลไว้

### Phase 2 — replay ตอน resume
1. `DataUploadPage.tsx` (`handleLoadWorkspace`, บรรทัด ~311): หลัง `load_csv` เสร็จ
   ให้วนเรียก recipe ตามลำดับ:
   ```ts
   for (const r of state.calculatedSensors ?? []) {
     try {
       if (r.kind === 'formula') await invoke('evaluate_formula', {...});
       else await invoke('calculate_new_sensor', {...});
     } catch (e) { /* เก็บ error ไว้ ไม่ throw — sensor ตัวเดียวพังต้องไม่ทำให้เปิด workspace ไม่ได้ */ }
   }
   ```
2. **จุดที่ต้องระวังเป็นพิเศษ**: `AddSensorWindow.tsx:98` ก็เรียก `load_csv` ซ้ำอีกจุดหนึ่ง
   (retry path ตอนหน้าต่างเปิดมาแล้วไม่มีข้อมูล) — จุดนั้นก็ล้าง special sensor ทิ้งเหมือนกัน
   ต้อง replay ตรงนั้นด้วย ไม่งั้นจะเจอบั๊ก "เปิดหน้า Add Special Sensor แล้ว sensor ที่เพิ่งสร้างหาย"
3. UX ตอน replay fail: ถ้า sensor ต้นทางหายไปจาก CSV → ขึ้น toast บอกชื่อ sensor ที่สร้างไม่สำเร็จ
   แล้วเอา recipe นั้นออกจาก workspace (ไม่ให้ค้างพยายามใหม่ทุกครั้ง)

### Phase 3 — ทำความสะอาด
1. ลบ special sensor แล้วต้องลบ recipe ด้วย (ตอนนี้ยังไม่มี UI ลบ special sensor — เช็คก่อน)
2. อัปเดต `docs/BACKLOG.md` ข้อ 7 → mark resolved
3. อัปเดต `CLAUDE.md` ถ้าจำเป็น (เพิ่มกฎ "special sensor ต้องเก็บ recipe เสมอ")

### Verify ทุก phase
`npx tsc --noEmit` + `npx vitest run` (97/97) + `cargo test` (58/58) + **manual test**:
สร้าง special sensor → ปิดแอป → เปิด workspace เดิม → ข้อมูลต้องกลับมาครบ กราฟ plot ได้

---

## 5. คำถามที่ต้องการคำตอบก่อนเริ่ม

1. **เอาทางเลือก 2 (recipe replay) ตามที่แนะนำไหม** หรืออยากดูทางเลือก 3 (snapshot ไฟล์) เพิ่ม?
2. **จะทำ Class B (สีเส้น/axis pin/cluster หาย) ไปพร้อมกันเลยไหม** หรือแยกทำทีหลัง?
   (งานเล็กกว่ามาก ทำแยกได้ ไม่กระทบกัน)
3. ถ้าทำ Class B — เอาทั้ง B1-B4 หรือเลือกเฉพาะ B1/B2 (สีเส้น + Y-axis pin) ที่ผู้ใช้เจอบ่อยสุด?
