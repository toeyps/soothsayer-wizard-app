# ภาพรวมโปรเจกต์ฉบับเก่า (เก็บไว้เป็นประวัติ)

> ⚠️ **ล้าสมัย — อย่าใช้เป็นข้อมูลปัจจุบัน.** ส่วนนี้คือหัวไฟล์ `docs/PROJECT_HANDOVER.md` เดิม (§1–§10 + บันทึกการ push)
> ที่เขียนช่วง ก.ค.–ส.ค. 2026 ย้ายมาไว้ที่นี่ตอนแยก handover เป็นรายเดือนเมื่อ 2026-10-09 โดยไม่แก้เนื้อหา.
> ข้อมูลปัจจุบันอยู่ที่ [`../PROJECT_OVERVIEW.md`](../PROJECT_OVERVIEW.md) · บันทึกรายงานอยู่ที่ [`../handover/`](../handover/README.md)

---

# Wizard (Soothsayer-Wizard) — Project Handover Summary

> อัปเดตล่าสุด: 2026-08-11 — §1-§9 ด้านล่างคือ**ภาพรวม/reference ที่ sync กับสภาพโค้ดปัจจุบันแล้ว** (ตรวจสอบซ้ำและแก้ให้ตรงความจริงในรอบนี้) ส่วน §6.1 เป็นต้นไปคือ**บันทึกประวัติงานแบบเรียงตามเวลา** (แต่ละหัวข้อ 🆕 คือสิ่งที่เกิดขึ้น ณ วันที่นั้นๆ ไม่ใช่สถานะปัจจุบันเสมอไป — ถ้าเรื่องไหนถูกแก้/revert ต่อในภายหลัง จะมีหัวข้อใหม่ต่อท้ายบอกไว้)
>
> ⚠️ **โปรเจกต์ย้าย path แล้ว**: จากเดิม `C:\00_DATA\OneDrive - P-DICTOR\repo\Soothsayer-wizard-app` (อยู่ใน OneDrive sync) ➜ ปัจจุบันอยู่ที่ **`C:\00_DATA\Soothsayer-wizard-app`** (โฟลเดอร์ปกติ นอก OneDrive) — ดูเหตุผลใน §9
>
> 📌 **เอกสารนี้อัปเดตอัตโนมัติทุกครั้งที่ทำงานเสร็จ 1 อย่าง** (ผู้ใช้ทำงานสลับ 2 เครื่อง และ Claude Code ไม่มี session history sync ข้ามเครื่อง — เอกสารนี้คือตัวแทนความต่อเนื่องแทน chat history) — **กฎ push (ตั้งแต่ 2026-08-18): commit local ทันทีที่งานเสร็จเหมือนเดิม (unasked) แต่ `git push personal` ต้องรอผู้ใช้ยืนยันว่าทดสอบแอปจริง (`npm run tauri dev`) ผ่านแล้วก่อนเสมอ** (เหตุผล: บั๊ก Tauri capability config ที่ผ่าน `tsc`/`vitest` หมดแต่จอดำจริงในแอป) — **push ไปที่ `personal` remote เท่านั้นเสมอ ห้าม push เข้า `origin` (Alpha-Com-Thailand) โดยเด็ดขาดแม้จะมีสิทธิ์ก็ตาม เป็นการตัดสินใจของผู้ใช้** — ดู §7
>
> ✅ **2026-08-24: push แล้ว** — ผู้ใช้ยืนยันทดสอบแอปจริงผ่าน commit `cac7a53` ถูก push ไปที่ `personal` (toeyps/soothsayer-wizard-app) สำเร็จ เป็น fast-forward สะอาด (`b89741f` → `cac7a53`) รวมงานสะสมทั้งหมดตั้งแต่ 2026-08-21 (Not in Group ครบ 3 จุด, ยุบ Predictive Model เป็น in-window page ของ Build Model, ล็อก plot mode ตาม model kind, สี Model kind picker, ปิด Build Model window อัตโนมัติตอนสลับ workspace, เอา "Highlight by value" กลับมาในแท็บ Highlights) — **commit ที่ push แล้วล่าสุดที่ `personal` คือ `cac7a53`**
>
> ✅ **2026-09-15: push แล้ว** — ผู้ใช้ยืนยันทดสอบแอปจริงผ่าน (Component select fix) commit `26fef29` ถูก push ไปที่ `personal` สำเร็จ เป็น fast-forward สะอาด (`3ee86bd` → `26fef29`, 23 commits) รวมงานสะสมทั้งหมดตั้งแต่ครั้งก่อน (ชุด intern guide/manual test plan วันที่ 2026-09-08 ถึง 2026-09-14 ทั้งหมด บวก Component select fix วันนี้) — **commit ที่ push แล้วล่าสุดที่ `personal` คือ `26fef29`**
>
> ✅ **2026-09-16: push แล้ว** — ผู้ใช้ยืนยันทดสอบแอปจริงผ่าน (Line chart time-axis fix ครบทุกจุด: ระยะห่างแกน, tooltip, Tag Point, highlight band) commit `78b7021` ถูก push ไปที่ `personal` สำเร็จ เป็น fast-forward สะอาด (`772dad1` → `78b7021`, 8 commits) รวมงานสะสมทั้งหมดตั้งแต่ครั้งก่อน (Running Condition Filter งานใหญ่, Sensor-value filter pool fix, intern guide expand, Line chart category→time axis fix + tooltip fix + Tag Point fix) — **commit ที่ push แล้วล่าสุดที่ `personal` คือ `78b7021`**
>
> ✅ **2026-09-18: push แล้ว** — ผู้ใช้ยืนยันทดสอบแอปจริงผ่าน ("ผมทดสอบ app แล้วววว") commit `d239c65` ถูก push ไปที่ `personal` สำเร็จ เป็น fast-forward สะอาด (`6387675` → `d239c65`, 17 commits) รวมงานสะสมทั้งหมดตั้งแต่ครั้งก่อน — ปุ่ม calendar icon สีขาว, เอาปุ่ม Report/Save Model/Preview ออกจากหน้า PM ทั้งหมด (รวม train_*_model backend ที่เก็บไว้เฉยๆ), เพิ่มปุ่ม Finish, **แก้บั๊ก data-loss ใหญ่ 2 รอบ** (workspaceManager.ts same-window write queue + Dashboard's cross-window stale-mirror autosave), แก้บั๊ก predictor sensors หายหลังกด Build Model →, เปลี่ยน "Predict this sensor" → "Target sensor", เพิ่ม group-by-component + search ให้ predictor picker — **commit ที่ push แล้วล่าสุดที่ `personal` คือ `d239c65`**
>
> ✅ **2026-09-20: push แล้ว** — ผู้ใช้ทดสอบแอปจริงผ่าน (ไล่หน้าจอทั้งชุดตาม checklist) commit `6a93b8c` ถูก push ไปที่ repo `toeyps/soothsayer-wizard-app` สำเร็จ เป็น fast-forward สะอาด (`b912f93` → `6a93b8c`, 5 commits) รวม: dedupe CSS selector ซ้ำ (BACKLOG #13), ลบ dependency ค้าง 2 ตัว, ลบไฟล์ตาย 20 ไฟล์ + Rust `get_table_page` (ข้อ 2), ลบ CSS ตาย 6,981 → 3,782 บรรทัด (BACKLOG #22) — หมายเหตุ: เครื่องนี้มี remote ชื่อ `origin` ตัวเดียวและ URL ชี้ไปที่ repo ส่วนตัว (`toeyps`) ไม่ใช่ `Alpha-Com-Thailand` จึงตรงกับกฎ "push ไป personal เท่านั้น" — **commit ที่ push แล้วล่าสุดคือ `6a93b8c`**

---

## 1. ภาพรวมโปรเจกต์

**Wizard** เป็น desktop app (Tauri v2) สำหรับ:
1. Import CSV ข้อมูลเซนเซอร์
2. สำรวจข้อมูล (dashboard: table / line chart / scatter / pair-plot / alarm setpoint lines)
3. จัดกลุ่ม Failure Group (**2026-08-06: ย้ายเข้ามาอยู่ใน Dashboard แล้ว** — เป็นแท็บ "Failure Groups" ในแผง Sensor ฝั่งขวา ไม่ใช่หน้าต่างแยกอีกต่อไป ดู §3/§5 และ entry `🆕 2026-08-06 — ⚡ งานใหญ่` ด้านล่าง)
4. เทรน Predictive Model (3 แบบ: Individual, Clustering, Relationship) — เปิดจากปุ่ม Build Model ในแท็บ Failure Groups โดยตรง

สถาปัตยกรรมแบ่งเป็น 3 tier: **React frontend** ↔ **Rust core (Tauri)** ↔ **Python sidecar** (เฉพาะโมเดล Relationship)

---

## 2. Stack ที่ใช้จริง (ตรวจสอบจาก `package.json` / `Cargo.toml`)

### Frontend (`src/`)
| หมวด | Library | หมายเหตุ |
|---|---|---|
| Framework | React 19.1 + TypeScript 5.8 | strict, ไม่มี React Router — เปลี่ยนหน้าด้วย local state |
| Build | Vite 5, dev port `1420` | |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`) | |
| Line chart | `echarts` 6 + `echarts-for-react` + `echarts-gl` | |
| Scatter / pair-plot | `regl-scatterplot` (WebGL) | มี context-loss guard ในตัว |
| Layout | `split.js` (resizable panes) | |
| Icons | `lucide-react` | |
| PDF/PNG export | ~~`@react-pdf/renderer`~~ / ~~`html-to-image` + ECharts canvas compositing~~ | ถอดออกหมดแล้ว — ดู entry 🆕 2026-09-17 |
| Formula UI | `d3-scale` | ใช้ร่วมกับ formula engine ฝั่ง Rust |
| Test | Vitest 4 + jsdom + @testing-library/react | `src/__tests__/` — coverage ครอบคลุมทุกไฟล์แล้ว (586 เทสต์/45 ไฟล์ ณ 2026-08-10, ดู entry ท้ายเอกสาร) |

### Rust core (`src-tauri/src/`, Tauri v2)
| Crate | ใช้ทำอะไร |
|---|---|
| `csv` + `rayon` | parse CSV แบบ parallel |
| `chrono` | timestamp parsing |
| `nalgebra` | GMM ellipse fit (clustering) |
| `fasteval` | formula engine (calculated sensors) |
| `tauri-plugin-{dialog,fs,store,shell,opener}` | native dialogs, scoped FS, persisted settings, sidecar spawn |
| dev-dep `tempfile` | Rust unit/integration tests |

`Cargo.toml` ตั้ง `opt-level = 1` สำหรับ crate เราเองใน dev profile (เจตนา — เพื่อให้ `chart_query.rs` เร็วพอตอน dev บนข้อมูลหลายล้านแถว) และ `opt-level = 2` สำหรับ dependency ทั้งหมด

### Python sidecar (`src-tauri/python/backend.py`, 486 บรรทัด)
- Compile ด้วย **Nuitka `--onefile`** เป็น native binary — ห้าม ship เป็น `.py` ตรงๆ
- สื่อสารกับ Rust ผ่าน stdin/stdout เป็น JSON เท่านั้น
- ใช้ LinearGAM fit ความสัมพันธ์ระหว่างเซนเซอร์ — **ชื่ออัลกอริทึมนี้ห้ามโผล่ใน UI** (ดู §8)
- ทดสอบแล้วว่า compile ได้ด้วย **Python 3.14** (numpy 2.5.1 / scipy 1.16.3 / pygam 0.12.0 / nuitka 4.1.3) แม้ Nuitka จะเตือนว่า 3.14 ยัง "experimental" — ใช้งานได้จริง สอบผ่าน smoke test ของ `build_sidecar.sh`

---

## 3. โครงสร้างโปรเจกต์ (ย่อ)

```
Soothsayer-wizard-app/
├─ src/                        # React frontend
│  ├─ main.tsx                 # entry — เลือก root component ตาม ?window= query param
│  ├─ App.tsx                  # entry ของหน้าต่างหลัก (main window)
│  ├─ components/
│  │  ├─ upload/                DataUploadPage (ตอนนี้เป็น 3-step wizard — ดู §6) + ลูกๆ
│  │  ├─ dashboard/              Dashboard, DataTable, FilterPanel, SensorSelection, **FailureGroupsPanel** (ใหม่ 2026-08-06)
│  │  ├─ charts/                 LineChart, ScatterChart, PairPlotCell/Chart, ResponsiveECharts
│  │  ├─ windows/                **3 sub-window** (ลดจาก 4 เมื่อ 2026-08-06 — `FailureGroupCreation.tsx` ถูกลบทิ้ง): AddSensor / PredictiveModelBuild / SaveAs (SaveAs ตอนนี้ทำหน้าที่แค่ "Rename Workspace" เท่านั้น โหมด duplicate-workspace เดิมถูกลบออกด้วย)
│  │  └─ reports/                PM PDF report template (react-pdf)
│  ├─ hooks/                    useDataUpload, useMappingData, useChartData, useScatterSample,
│  │                             useTablePage, useCalculationEngine, useFormulaEditor,
│  │                             useAppMenu, useSubWindowMenu, usePMReport, useCoalescedDraw
│  ├─ types/commands.ts         # ⭐ single source of truth ของทุก Tauri command signature
│  ├─ workspaceManager.ts       # save/load/list/delete/duplicate/rename workspace
│  └─ errorReporter.ts          # window.onerror / unhandledrejection → log ไฟล์ผ่าน Rust
│
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs (2647 บรรทัด)   # entry จริง — invoke_handler รวม 22 command, window management
│  │  ├─ csv_processor.rs (1098) # parse/merge CSV → ColumnarData (in-RAM store)
│  │  ├─ chart_query.rs (1001)  # bounded pipeline: filter → transform → aggregate → downsample
│  │  ├─ clustering.rs (166)     # GMM ellipse fit
│  │  ├─ operation_registry.rs  # calculated-sensor operation catalog
│  │  ├─ metrics.rs (295)        # สถิติต่อเซนเซอร์
│  │  └─ main.rs (6)             # เรียก tauri_app_lib::run()
│  ├─ python/backend.py          # LinearGAM sidecar source
│  ├─ bin/backend-x86_64-pc-windows-msvc.exe  # compiled sidecar (gitignored, ต้อง build เองทุกเครื่อง)
│  ├─ tests/predictive_model_tests.rs
│  ├─ capabilities/{default,add-sensor}.json
│  └─ tauri.conf.json            # CSP, window config, externalBin, bundle targets
│
├─ docs/                        # requirements, task breakdown (zone ของ pm-agent), เอกสารนี้
├─ scripts/                     # installer build script ต่อแพลตฟอร์ม
├─ .github/workflows/release.yml # CI: build ทั้ง sidecar + Tauri bundle, publish GitHub Release
└─ .claude/agents/               # นิยาม sub-agent 5 ตัว + zone การเขียนไฟล์ (ดู CLAUDE.md)
```

---

## 4. วิธีรันโปรแกรม (บนเครื่องที่ตั้งค่าไว้แล้ว)

```bash
cd C:\00_DATA\Soothsayer-wizard-app   # path ใหม่ — ไม่ใช่ OneDrive แล้ว
npm install

npm run tauri dev        # รันแอปเต็ม (compile Rust + เปิดหน้าต่าง) — sidecar ต้องมีอยู่แล้วที่ src-tauri/bin/
npm run dev               # frontend อย่างเดียว (Vite, port 1420) — ไม่มี Tauri backend
npm run build              # tsc type-check + vite build (รันก่อน handoff เสมอ)
npm run tauri:build        # release bundle (ต้องมี sidecar binary พร้อมแล้ว)

npx vitest run                                          # frontend test ทั้งหมด (586 เทสต์/45 ไฟล์ ณ 2026-08-10)
npx vitest run src/__tests__/useScatterSample.test.ts    # ไฟล์เดียว
cd src-tauri && cargo test                               # Rust unit + integration test
cd src-tauri && cargo test --test predictive_model_tests # integration เท่านั้น
```

**CI** (`.github/workflows/release.yml`): push tag `v*` → build sidecar (Nuitka) + Tauri bundle บน macOS arm64 และ Windows x64 → สร้าง draft GitHub Release พร้อม `.dmg` / `.exe` (NSIS) / `.msi`

### ตั้งเครื่อง dev ใหม่จากศูนย์ (checklist)
ถ้าเป็นเครื่องใหม่ที่ยังไม่เคย build เลย ให้ทำตามลำดับนี้ — ดูรายละเอียด/สาเหตุปัญหาที่เจอจริงใน §9:
1. ติดตั้ง Rust (`rustup`) + Visual Studio Build Tools (C++ workload)
2. ติดตั้ง Python 3.11+ (หรือ 3.13/3.14 ก็ใช้ได้ — ทดสอบแล้ว)
3. **ถ้าเครื่องมี Kaspersky**: เพิ่ม exclusion ให้ Intrusion Prevention ครอบคลุมโฟลเดอร์โปรเจกต์ทั้งหมด + `%USERPROFILE%\.cargo` + `%USERPROFILE%\.rustup` (ไม่งั้น build จะพังด้วย error "Application Control policy has blocked this file")
4. **อย่า clone/วางโปรเจกต์ไว้ใน path ที่ OneDrive sync อยู่** — ทำให้ cargo build ล้มด้วย "output path is not a writable directory" แบบสุ่มๆ (ดู §9)
5. compile Python sidecar: `cd src-tauri/python && python -m venv .venv && .venv\Scripts\pip install -r requirements.txt && bash build_sidecar.sh` (ต้องมี Git Bash) แล้ว copy ผลลัพธ์ไปที่ `src-tauri/bin/backend-<target-triple>.exe`
6. `npm install && npm run tauri dev`

---

## 5. Entry point

- **Rust**: `src-tauri/src/main.rs` → `tauri_app_lib::run()` ใน `lib.rs` — ตั้งค่า plugin, register 22 command ผ่าน `invoke_handler`, และ handle window-lifecycle (ปิดแอปเมื่อไม่มีหน้าต่าง *visible* เหลือ — มี logic เฉพาะกันเคส race ตอนสลับไป sub-window)
- **Frontend**: `src/main.tsx` อ่าน query param `?window=` เพื่อเลือก root component:
  - ไม่มี param → `App.tsx` (main window: upload → dashboard → **Failure Groups tab ก็อยู่ในนี้ด้วยแล้ว 2026-08-06**)
  - `add-sensor` → `AddSensorWindow`
  - `predictive-model` → `PredictiveModelBuild`
  - `save-as` → `SaveAsWindow` (**2026-08-06: เหลือแค่โหมด `?mode=rename` เท่านั้นที่ยังถูกเรียกจริง** — โหมด `save-as`/duplicate-workspace ถูกลบทุก entry point แล้ว โค้ดในไฟล์ยังมี branch เดิมค้างไว้เป็น dead code โดยตั้งใจ ไม่เสี่ยงแก้เพราะกลัวพัง rename)
  - ~~`failure-group` → `FailureGroupCreation`~~ — **ลบออกแล้ว 2026-08-06** (ทั้ง route นี้และไฟล์ component ถูกลบ — ดู entry `🆕 2026-08-06 — ⚡ งานใหญ่` ด้านล่างสำหรับรายละเอียดเต็ม)

  แต่ละ sub-window คือ Tauri window แยก คนละ capability file (`default.json` เต็ม, `add-sensor.json` แคบกว่า)

---

## 6. Data flow หลัก (หัวใจของแอป)

1. **Load**: `load_csv` (Rust) parse หลายไฟล์แบบ parallel ด้วย rayon (cap **2 GB/ไฟล์**), merge ตาม timestamp (ค่าใหม่ non-null ชนะเมื่อ timestamp ซ้ำ; โหลดไฟล์เดียวจะข้าม merge) → เก็บใน Tauri managed state
2. **In-RAM store = `ColumnarData`** (`csv_processor.rs`): column-major โดยเจตนา — แต่ละเซนเซอร์เป็น `Vec<f64>` ต่อเนื่อง, **NaN = missing**; `ts_parsed` เก็บ epoch-microseconds ที่ parse ครั้งเดียวตอน load (`TS_MISSING` ถ้าไม่มี); `headers[0]` คือ timestamp column เสมอ
3. **Frontend ไม่เคยได้ dataset เต็ม** (ตั้งแต่ v0.2.1) — query แสดงผลทำฝั่ง Rust ใน `chart_query.rs`: filter → operation transform → hourly aggregation (ถ้ามี) → min/max downsample → ส่งกลับแค่ O(max_points) แถว
   - `get_chart_data` (ceiling 100k จุด) ผ่าน `useChartData` — line chart
   - `get_table_page` (page ≤ 1000) ผ่าน `useTablePage` — data table
   - `get_scatter_sample` (reservoir sampling) ผ่าน `useScatterSample` — scatter + pair-plot
   - `export_chart_csv` เขียนไฟล์ลง disk ตรงจาก Rust (ไม่ผ่าน JS)
4. **GPU guard ชั้นสุดท้าย**: `ScatterChart` / `PairPlotCell` จับ WebGL context-loss (retry overlay) + จำกัด stride สูงสุด (500k / 100k จุด)

**Predictive model 3 แบบ**:
- Individual → Rust คำนวณสถิติ/ขอบเขตต่อเซนเซอร์ → `INDV_INFO_*.json`
- Clustering → Rust GMM ellipse fit (nalgebra) → `CLUS_INFO_*.json`
- Relationship → Rust preprocess/project ข้อมูล → ส่ง array เล็กๆ ผ่าน stdin ไปยัง Python sidecar (LinearGAM) → sidecar เขียน `.pkl` และคืน JSON → Rust เขียน `REL_INFO_*.json`

**Report export** (`usePMReport`): PNG ผ่าน html-to-image + ECharts canvas compositing, PDF ผ่าน `@react-pdf/renderer` (คอมไพล์ WASM runtime — ต้อง test บน installed build จริงเวลาแก้ CSP/report)

### 6.1 การเปลี่ยนแปลง UI รอบล่าสุด (ยังไม่ commit — ดู §8)

**หน้า Data Upload** (`DataUploadPage.tsx`) เปลี่ยนจากหน้าเดียวเป็น **3 step**:
- **Step 0** (`StartChoiceStep`) — จุดตัดสินใจแรกสุด: การ์ด "Create new project" กับการ์ด "Open recent project" (โชว์ preview 3 workspace ล่าสุด, "Show all" ถ้ามีมากกว่านั้น) — sidebar รายชื่อ workspace เดิมถูก**ซ่อนไว้เฉพาะ step นี้**เพื่อไม่ให้ list ซ้ำกับการ์ด (เคยมีบั๊ก "Found multiple elements" จาก test เพราะ list โผล่ 2 ที่พร้อมกัน)
- **Step 1** (`CreateProjectStep`) — ตั้งชื่อ + คำอธิบาย project (มี "‹ Back" กลับไป step 0)
- **Step 2** — เนื้อหาเดิม (upload CSV + mapping) sidebar โผล่กลับมา

**Dashboard** (`Dashboard.tsx` + ลูกๆ):
- **`SensorSelection.tsx`** (แผง "Sensor" ทางขวา) — ปรับใหม่ทั้งหมด: sensor **group by component** อัตโนมัติ ปิดไว้ทั้งหมดโดย default (ต้องกดขยายทีละ component) มีช่องค้นหาที่ auto-expand กลุ่มที่มีผลลัพธ์ตรง ไม่มี filter panel/component-multiselect แบบเดิมแล้ว
- **Data Insight panel** (`renderDataContent` ใน Dashboard.tsx) — ตอนนี้เป็น **2 tab**: **"Selected Sensor"** (default) แสดง sensor ที่ plot อยู่ทุกตัว พร้อม checkbox hide/unhide บนกราฟ, ไอคอน pipette เปลี่ยนสีเส้น, ไอคอน line-chart เปิดช่อง pin Y-axis scale (min/max คงที่), ปุ่มลบออกจาก plot — กับ **"Data Insight"** (ตารางข้อมูลเดิม)
- **Legend ของกราฟ** (`LineChart.tsx`) ยังอยู่เหมือนเดิม (เคยลองเอาออกแล้วเอากลับมา) แต่ **เอาชื่อ sensor ที่เคยโผล่ซ้ำเหนือแกน Y ออกแล้ว** (ซ้ำกับ legend)
- **TIME RANGE** เพิ่มปุ่ม quick-select แบบ relative (`Y`/`M`/`W`/`D`/`H` + เลขที่กรอก + ✓) นอกเหนือจาก date picker เดิม
- **สี/Y-axis scale ต่อ sensor เป็น session state เท่านั้น** (`sensorColors`, `sensorAxisRange` ใน Dashboard.tsx) — **ยังไม่ persist ลง `WorkspaceState`** ปิดแอปแล้วค่าหาย ถ้าต้องการ persist ต้องเพิ่มเข้า `WorkspaceState` + `buildWorkspaceState` เอง
- โฟลเดอร์ "collapsed panels" sidebar (ไอคอน DATA/FILTER ตอนซ่อน panel) — label "Data" เปลี่ยนเป็น **"Pickup Sensor"** แล้ว, ตำแหน่งแก้ไม่ให้ทับ Y-axis ของกราฟแล้ว (เพิ่ม `padding-left` แบบมีเงื่อนไขใน `App.css`)
- **`FilterPanel.tsx`** — dropdown เลือก sensor สำหรับ value filter ตอนนี้โชว์ `description (tag)` แทน tag ดิบๆ (ต้องมี `sensorMetadata` prop ส่งเข้าไป)

**🆕 Selected Sensor tab แยกตาม chart type แล้ว** (`Dashboard.tsx`, `renderDataContent`) — เดิม checkbox/pipette/pin-Y-axis โชว์เหมือนกันทุก chart type แต่จริงๆ มีผลแค่ Line Plot เท่านั้น (`sensorColors`/`sensorAxisRange` ส่งให้ `LineChart` อย่างเดียว, Scatter/Pair ใช้ `selectedSensors` เต็มชุดเสมอไม่สนใจ `visibleSensors`) ตอนนี้แก้เป็น:
- **Line**: เหมือนเดิมทุกอย่าง (checkbox hide/unhide, pipette สี, pin Y-axis, ลบ)
- **Scatter/Pair Plot**: เหลือแค่ปุ่มลบ + กล่องคำอธิบายสั้นๆ ชี้ไปที่ controls จริงของ chart แต่ละแบบ (Scatter มี X/Y dropdown + toolbox ในตัวกราฟเอง, Pair Plot มี lasso-cluster coloring ในตัวกราฟเอง) — สีตัวหนังสือ fallback เป็น `var(--text-primary)` แทนสีต่อเซนเซอร์

**🆕 "Clear all" ปุ่มใหม่ใน Selected Sensor tab** (`Dashboard.tsx`) — เดิมลบ sensor ออกจากกราฟได้ทีละตัวผ่านไอคอนถังขยะต่อแถวเท่านั้น ตอนนี้เพิ่มปุ่ม "Clear all" (ไอคอน X) ที่ header ของ panel โผล่เฉพาะตอน tab เป็น "Selected Sensor" และมี sensor เลือกอยู่อย่างน้อย 1 ตัว — เรียก `clearAllSensors()` (เพิ่มใหม่คู่กับ `removeSensor` เดิม, แค่ `setSelectedSensors([])`) `visibleSensors` จะตามไปว่างเองผ่าน sync effect ที่มีอยู่แล้ว — ยึดตามดีไซน์อ้างอิงจาก platform เดิม (ปุ่ม X ข้าง "ALL PICKED") ที่ผู้ใช้ส่ง screenshot มา — `tsc --noEmit` ผ่านแล้ว **ยังไม่ได้ทดสอบบนหน้าต่างแอปจริงเพราะ browser preview ใช้ไม่ได้กับแอปนี้ (ดูด้านล่าง) — ต้องรอผู้ใช้ยืนยันผ่าน `npm run tauri dev`**

**🆕 Color picker: สร้าง `ColorPlatePicker.tsx` เอง (ไม่พึ่ง library) แทน native `<input type="color">` แล้ว — รอบที่ 3, สำเร็จ** (`src/components/dashboard/ColorPlatePicker.tsx` ใหม่ + `Dashboard.tsx`) — สรุปเส้นทางที่ลองมา: รอบ 1 custom popover แบบ preset-swatch + hex input ล้วนๆ (ไม่มีจานสีลาก) → ผู้ใช้ไม่ชอบ revert; รอบ 2 ลอง `npm install react-colorful` แต่ Vite error `Missing "./dist/color-picker.css" specifier` (เวอร์ชันที่ดึงมา export path ไม่ตรง) → uninstall + revert กลับ native ทั้งหมด; **รอบ 3 (ปัจจุบัน)** เขียน HSV picker เองล้วนๆ ไม่มี dependency ใหม่เลย กันปัญหา import path ซ้ำ — ประกอบด้วยแค่ **saturation/value square (ลากได้) + hue slider** เท่านั้น ตามที่ผู้ใช้ขอชัดเจนว่า "เหลือแค่ plate สีด้านบนพอ" (ไม่มี RGB number field, ไม่มี hex input, ไม่มี preset swatch — ตัดออกหมดจากรอบ 1 เพราะไม่ได้ขอ) hue คงที่ระหว่างลากบน square (กันปัญหา hue หายตอนลากเข้าโซน grayscale) ไฟล์มี helper hex↔rgb↔hsv ในตัวเอง (`hexToRgb`, `rgbToHex`, `rgbToHsv`, `hsvToRgb`) ลาก/คลิกผ่าน Pointer Events (`setPointerCapture`) ไม่ใช้ global mousemove listener — toggle เปิด/ปิดทีละ sensor แบบเดียวกับ Y-axis pin editor (state `colorPickerFor` ใน `Dashboard.tsx`) — `tsc --noEmit` ผ่าน **ยังไม่ได้ทดสอบบนแอปจริง รอ `npm run tauri dev`** (ไม่ต้อง reinstall/restart พิเศษรอบนี้เพราะไม่มี dependency ใหม่ hot-reload ควรพอ) — ยังไม่มีการเทสต์ pointer-drag ทั้ง 2 แกน (square) และ 1 แกน (hue) ด้วยตาจริงเลย ควรลองลากดูให้ทั่วก่อน commit

**🆕 แก้บั๊ก: เข้า Failure Group แล้วกลับ Dashboard ไม่ได้เลย (dead-end)** — Dashboard set `lastRoute: 'failure-group'` ค้างไว้ตอนเปิด FG ([Dashboard.tsx:1509](src/components/dashboard/Dashboard.tsx:1509)) และไม่มีจุดไหนเคย reset กลับเป็น `'dashboard'` เลย ("Back to Upload" ก็ตั้งใจไม่ auto-resume อยู่แล้วตาม design เดิม — [useSubWindowMenu.ts:24](src/hooks/useSubWindowMenu.ts:24)) ผลคือ workspace ไหนที่เคยเปิด FG จะ**เข้า Dashboard/analyze ไม่ได้อีกเลย**ไม่ว่าจะลองทางไหน (ผู้ใช้เจอเองแล้วรายงาน) แก้โดยเพิ่มปุ่ม **"Back to Dashboard"** ใหม่แยกจาก "Back to Upload" เดิม (คงไว้ทั้งคู่ เจตนาต่างกัน): `handleBackToDashboard` ใน [FailureGroupCreation.tsx](src/components/windows/FailureGroupCreation.tsx) patch `lastRoute` กลับเป็น `dashboard` ก่อน reopen/focus main window ผ่าน URL param `?resume=<id>` (fresh spawn) หรือ event `resume-workspace` (reuse) — ฝั่งรับใน [DataUploadPage.tsx](src/components/upload/DataUploadPage.tsx) เพิ่ม effect เรียก `handleLoadWorkspace()` เดิมที่มีอยู่แล้วให้ auto-resume ตรงเข้า Dashboard — `tsc --noEmit` ผ่าน **ยังไม่ได้ทดสอบบนแอปจริง** (flow: Dashboard → Create Failure Group → กด "Back to Dashboard" ใหม่ → ควรกลับเข้า Dashboard เดิมพร้อม sensor ที่เลือกไว้ครบ ไม่ใช่หน้า Import) — 🆕 ผู้ใช้ให้ลบปุ่ม "Back to Upload" เดิมออกจาก FG toolbar ทั้งหมดแล้ว (รู้สึกว่าข้าม sequence ที่วางไว้) เหลือแค่ "Back to Dashboard" ปุ่มเดียว — ลบ `handleBackToUpload` + `ask` import ที่ไม่ใช้แล้วออกด้วย (`useSubWindowMenu.ts`'s File-menu "New Workspace"/"Close Workspace" ยังคงพฤติกรรมเดิม ไม่ auto-resume — จงใจไม่แตะ เพราะเจตนาต่างจากปุ่ม toolbar)

🆕 **แก้บั๊กรอบ 2**: ผู้ใช้ทดสอบแล้ว "Back to Dashboard" ไม่ได้พาเข้า Dashboard ตรงๆ — พาไปหน้า Import เฉยๆ ต้องกด recent-workspace card เองอีกทีถึงจะเข้า Dashboard (auto-resume ไม่ทำงาน) สาเหตุที่คาดคือ logic เดิม "เช็คว่ามี window 'main' เดิมไหม ถ้ามีก็ reuse" ไปเจอ window ค้าง (stale, hidden แต่ไม่ถูก destroy จริง) จากการทดสอบหลายรอบในเซสชันเดียวกัน ซึ่งมี React state เก่าไม่รู้จัก resume logic เลย แก้โดยเปลี่ยนเป็น **destroy ของเก่าทิ้งเสมอแล้ว spawn ใหม่เสมอ** (ไม่มี branch "reuse" อีกต่อไป) ใน `handleBackToDashboard` ([FailureGroupCreation.tsx](src/components/windows/FailureGroupCreation.tsx)) — ลบ `resume-workspace` event listener ที่ไม่จำเป็นแล้วออกจาก [DataUploadPage.tsx](src/components/upload/DataUploadPage.tsx) เหลือแค่อ่าน `?resume=<id>` จาก URL ตอน mount ทางเดียว เช็ค exit-guard ใน [lib.rs:2592](src-tauri/src/lib.rs:2592) แล้วว่าลำดับ destroy-then-create ปลอดภัย (FG ยังเปิด/visible อยู่ตลอดจนกว่าจะปิดตัวเองท้ายสุด ไม่มีจังหวะ "0 visible windows" หลอกให้แอปปิด) — `tsc --noEmit` ผ่าน

🆕 **แก้บั๊กรอบ 3 (ร้ายแรงกว่าเดิม — ปิดทั้งแอป)**: ทดสอบแล้ว "Back to Dashboard" ทำ**แอปทั้งตัวปิดตัวเอง**กลางคัน! สาเหตุคือ race condition กับ Rust exit-guard ([lib.rs:2592](src-tauri/src/lib.rs:2592)): โค้ดรอบ 2 สร้าง `main` ใหม่แบบไม่รอ event ยืนยันว่าสร้างเสร็จ แล้วรีบปิด FG ทันที — ถ้า FG ปิดเสร็จเร็วกว่า `main` ใหม่จะถูกนับเป็น "visible" (เพราะ native window creation เป็น async ฝั่ง Rust) exit-guard จะเห็น "remaining visible windows: []" ชั่วขณะแล้วสั่ง `app_handle.exit(0)` ฆ่าทั้งแอปทันที ตัดตอน `handleLoadWorkspace` ที่กำลังโหลดอยู่กลางทาง (เห็นจาก log "Total read_csv took: 307ms" ที่ทำเสร็จแต่ไปไม่ถึง Dashboard) — แก้โดยเพิ่ม `await new Promise(...)` รอ event `tauri://created` ของ `main` ใหม่ก่อน แล้วค่อยปิด FG (เลียนแบบ pattern เดียวกับที่ Dashboard→FG ใช้อยู่แล้วสำเร็จ ซึ่งพลาดไม่ได้ใส่ไว้ตอนแก้รอบ 2) — ทดสอบแล้วยัง**ปิดแอปตัวเองเหมือนเดิม** ผู้ใช้ให้ **revert ทิ้งทั้งหมด** ใช้ "Back to Upload" แบบเดิมไปก่อน — revert แล้ว: `FailureGroupCreation.tsx` กลับไปมี `handleBackToUpload` + ปุ่ม + import `ask` เหมือนก่อนเริ่มทำ feature นี้ 100%, `DataUploadPage.tsx` ลบ auto-resume effect (`?resume=` param) ออกหมด — grep ยืนยันไม่มีเศษโค้ด `handleBackToDashboard`/`resume-workspace`/`?resume=` เหลือเลย `tsc --noEmit` ผ่าน — **ถ้าจะลองทำ "กลับไป Dashboard ตรงๆ" อีกในอนาคต ต้องระวัง Rust exit-guard ([lib.rs:2592](src-tauri/src/lib.rs:2592)) ให้ดี**: การ destroy/create window หลายตัวพร้อมกันเสี่ยงชนกับ "0 visible windows → exit" มาก แม้จะรอ `tauri://created` แล้วก็ยังพังในการทดสอบจริง (อาจต้องรอ event ที่บ่งบอกว่า window "visible" จริงๆ ไม่ใช่แค่ "created" หรือต้อง debug ฝั่ง Rust โดยตรงว่า `is_visible()` คืนค่าถูกจังหวะไหน) — ยังไม่มีวิธีแก้ที่ยืนยันว่าใช้ได้จริง

**🆕 Label "SAMPLING (1 HR)" เปลี่ยนเป็น "AGGREGATION (1 HR)"** ([Dashboard.tsx:1025](src/components/dashboard/Dashboard.tsx:1025)) — ผู้ใช้เข้าใจผิดว่า dropdown นี้ (Raw/Avg/Max/Min/First/Last) ซ้ำซ้อนกับ automatic min/max decimation ที่มีอยู่แล้ว เกือบขอให้ลบทิ้ง หลังอธิบายว่าเป็นคนละกลไก (aggregation ทำงาน**ก่อน** decimation เสมอ ดู [chart_query.rs:548-565](src-tauri/src/chart_query.rs:548) — ไม่ใช่หลังตามที่เข้าใจ) จึงตกลงแค่เปลี่ยนชื่อ label ให้สื่อความหมายชัดขึ้นแทนการลบฟีเจอร์ — แก้แค่ text ที่โชว์ผู้ใช้ ไม่แตะชื่อตัวแปร/type ภายใน (`samplingMethod`, `ChartSamplingMethod` ยังคงชื่อเดิม) `tsc --noEmit` ผ่าน

**🆕 แก้ "Save & Continue รู้สึกเหมือนเปิด window ใหม่"** — ไม่ใช่ปัญหา transition/CSS อย่างที่คิดตอนแรก แต่เป็นเพราะ `handleContinue` ([DataUploadPage.tsx:262](src/components/upload/DataUploadPage.tsx:262), flow "สร้างโปรเจกต์ใหม่ → Prepare dataset → Save & Continue") ไม่เคยเรียก `setLoadingWorkspace(true)` เลย ต่างจาก `handleLoadWorkspace` (flow "เปิด recent workspace" ที่รู้สึกลื่น) ที่เปิด full-screen loading overlay (blur backdrop + spinner "Loading workspace...") คั่นไว้เสมอ — เพิ่ม `setLoadingWorkspace(true)` + `try/catch` (reset `false` + โชว์ error ถ้า `saveWorkspaceData` fail) ให้ `handleContinue` แบบเดียวกัน — **ทดสอบแล้วยังไม่รู้สึกต่าง** เพราะ `saveWorkspaceData` เร็วมาก (<50ms) overlay กระพริบผ่านจนไม่ทันสังเกต

🆕 **แก้รอบ 2**: เพิ่ม CSS fade-in (`app-page-transition` class, `App.tsx`/`App.css`, ใช้ keyframe `fadeIn` ที่มีอยู่แล้ว) ครอบการสลับ Import↔Dashboard ทั้งสองทิศทาง — **ทดสอบแล้วผู้ใช้บอกยังรู้สึกเหมือนเดิม** (ส่ง screenshot 3 ภาพเทียบ Prepare-dataset / Dashboard / Failure-Group ให้ดู) 0.2s fade เบาเกินไปจนไม่รู้สึก

🆕 **แก้รอบ 3**: เพิ่ม `MIN_TRANSITION_MS = 500` ใน `handleContinue` ([DataUploadPage.tsx:262](src/components/upload/DataUploadPage.tsx:262)) — ใช้ `Promise.all([saveWorkspaceData(state), delay(500ms)])` บังคับ overlay "Loading workspace..." ให้อยู่อย่างน้อย 500ms เสมอ เลียนแบบ flow "เปิด recent workspace" ที่รู้สึกลื่นอยู่แล้วเพราะ re-parse CSV กินเวลาจริงหลักร้อย ms (ของ fade CSS รอบ 2 ยังเก็บไว้ ทำงานร่วมกันได้) — `tsc --noEmit` ผ่าน **ยังไม่ได้ทดสอบรอบนี้**

**🆕🆕 ใหญ่: "Failure Group" ตอนนี้เป็น panel ที่ 5 ในตัว Dashboard เอง (ไม่ใช่แค่ window แยกอีกต่อไป)** — ผู้ใช้ประกาศแผน **redesign รอบใหญ่** (จะทยอยบอก requirement เพิ่มทีละส่วน) จุดแรกคือย้าย "Create Failure Group" เข้ามาเป็นส่วนหนึ่งของ Dashboard แบบถาวร ไม่ต้องเปิด window แยกอีก — **เฉพาะส่วน "สร้าง/จัดการ failure group" เท่านั้น ยังไม่รวม "Build Model"** (ผู้ใช้บอกจะแจ้ง requirement นั้นแยกทีหลัง) วางแผนผ่าน EnterPlanMode ก่อนเริ่ม (แผนอยู่ที่ `C:\Users\toey_\.claude\plans\vast-bubbling-phoenix.md` ถ้าต้องอ้างอิง) ผู้ใช้เลือกให้เป็น **quadrant จริงในกริด ขนาดเท่าๆ กับ Sensors panel** (ไม่ใช่ overlay/modal ลอยทับ) รายละเอียดที่แก้:

- `types.ts`: `DashboardSlot` เพิ่ม `'right-mid'`, `DashboardPanel` เพิ่ม `'failure-group'`, `DashboardLayoutSizes.rightRows` ขยายจาก 2-tuple เป็น 3-tuple (`[sensors%, failure-group%, filter%]`, default `[34,33,33]`)
- `Dashboard.tsx`: ขวาคอลัมน์ขยายจาก 2 แถวเป็น 3 แถว (Sensors / Failure Group / Filter) — `PANELS`/`SLOT_LAYOUT`/`RIGHT_SLOTS` เพิ่ม entry ใหม่, เพิ่ม `slotRMRef`/`rmCollapsed`, **split.js effect ของขวาคอลัมน์เขียนใหม่ให้ generic รองรับ 0/1/2+ collapsed** (0 collapsed → 3-way split, 1 collapsed → 2-way split เฉพาะคู่ที่ยัง visible โดย renormalize % ให้รวม ~100, 2+ collapsed → ไม่ split เลยปล่อยให้ CSS flex:1 ทำงาน) — collapsed-tabs sidebar (ปุ่มลอยฝั่งซ้ายที่โชว์ FILTER/PICKUP SENSOR ตอน panel ถูกซ่อน) **ไม่ต้องแก้อะไรเลยเพราะ generic รองรับ N panels อยู่แล้ว**
- state ใหม่: `failureGroups`/`failureRows` (init จาก `initialState?.failureGroupState`, default `[{no:0,name:"Not in Group",...}]`) ผูกเข้า `buildWorkspaceState`/autosave effect ที่มีอยู่แล้ว (ผ่าน `failureGroupState` field ใน `WorkspaceState` ที่มีอยู่แล้วตั้งแต่เดิม ไม่ต้องแก้ schema)
- **ไฟล์ใหม่ [`src/components/dashboard/FailureGroupPanel.tsx`](src/components/dashboard/FailureGroupPanel.tsx)** — พอร์ตมาจาก `FailureGroupCreation.tsx` (window เดิม, 1165 บรรทัด) เฉพาะส่วน group/row CRUD + CSV upload/download/save (ตัด Build Model, PM window-spawn, window-lifecycle handlers ทิ้งหมด) เป็น controlled component (`groups`/`rows`/`onGroupsChange`/`onRowsChange`/`allSensors`/`sensorMetadata` props) — Inspector panel (แก้ Concept Sensor/Model Type/Notes/Mapped Sensor Tag) ทำเป็น**แถบเลื่อนลงมาด้านล่าง** แทนการ split 70:30 แนวนอนแบบ window เดิม เพราะพื้นที่แคบเกินไป — ปุ่ม "Build Model" **ไม่มีในนี้เลย**
- `App.css`: เพิ่ม `.fg-panel-embedded`/`.fg-inspector-embedded` (wrapper ใหม่สำหรับบริบทแคบ) ส่วน class อื่นๆ (`.fg-group-card`, `.fg-sensor-chip`, `.fg-inspector-field` ฯลฯ) **reuse ของเดิมทั้งหมด** เพราะเป็น top-level selector ไม่ได้ scope ผูกกับ window เดิม

**สถานะ**: ปุ่ม "Create Failure Group" เดิมบน Dashboard ที่เปิด window แยก **ยังอยู่เหมือนเดิม ไม่ได้ลบ** (คนละเรื่องกับ panel ใหม่นี้ — ยังไม่ได้ตัดสินใจว่าจะเอาออกไหม รอผู้ใช้บอก) `tsc --noEmit` ผ่านสะอาดทุกไฟล์ **ยังไม่ได้ทดสอบบนแอปจริงเลย** — ต้องเช็ค: panel โผล่ขนาดเท่า Sensors จริงไหม, สร้าง/ลบ/rename group ได้ไหม, เพิ่ม/ลบ sensor row ได้ไหม, collapse panel แล้วโผล่ใน sidebar ซ้าย + restore ได้ไหม, ลาก gutter ทั้ง 3 เส้นในคอลัมน์ขวาแล้ว persist ข้าม reload ไหม, CSV upload/download/save round-trip ถูกไหม

**🔙 REVERTED**: ผู้ใช้ลองแล้วไม่ถูกใจ ("มันไม่ถูกใจผมเท่าไหร่") ก่อนจะได้ทดสอบบนแอปจริงด้วยซ้ำ — บอกจะลอง design ใหม่เองแล้วค่อยแจ้ง requirement มาอีกที **revert กลับสู่สภาพก่อนเริ่ม feature นี้ 100%**: `types.ts` (`DashboardSlot`/`DashboardPanel`/`DashboardLayoutSizes.rightRows` กลับเป็น 4 slot/2-tuple เดิม), `Dashboard.tsx` (คอลัมน์ขวากลับเป็น 2 แถวเดิม, split.js effect กลับเป็นเวอร์ชัน 2-panel เดิม, ลบ state/import/render function ที่เกี่ยวข้องหมด), ลบไฟล์ `FailureGroupPanel.tsx` ทิ้ง, ลบ CSS block `.fg-panel-embedded`/`.fg-inspector-embedded` ออกจาก `App.css` — grep ยืนยันไม่มีเศษโค้ด (`FailureGroupPanel`/`failureGroups`/`failureRows`/`right-mid`/`rmCollapsed`) เหลือเลยสักจุด `tsc --noEmit` ผ่านสะอาด — **แผน redesign เดิมยังบันทึกไว้ที่ `C:\Users\toey_\.claude\plans\vast-bubbling-phoenix.md` เผื่ออยากเอากลับมาดูเป็น reference ตอนออกแบบใหม่** — รอ requirement ใหม่จากผู้ใช้ก่อนเริ่มงานต่อ

**🆕 แก้สีกราฟซ้ำ/ใกล้เคียงกันเวลาเลือกหลาย sensor** — `defaultSensorColor` เดิม ([LineChart.tsx:23](src/components/charts/LineChart.tsx:23)) hash ชื่อ sensor tag เพื่อสุ่มสีจาก palette 6 สี ทำให้ (1) sensor หลายตัวชน hash กันได้สีซ้ำเป๊ะ และ (2) แม้ไม่ชน ก็มีโอกาสได้สีโทนน้ำเงิน-ม่วง 3 สีที่ใกล้เคียงกันมาก (`#3b82f6`/`#6366f1`/`#8b5cf6`) แยกด้วยตาบนเส้นกราฟบางๆ ยาก — ผู้ใช้ส่ง screenshot มาชี้ปัญหานี้ตรงๆ (เลือก 4 sensor เห็นแค่ 2 สีในกราฟ) แก้โดยเพิ่ม `resolvedSensorColors` (`useMemo`) ใน `Dashboard.tsx` — คำนวณ default color จาก **ตำแหน่งใน `selectedSensors`** (ลำดับนิ่ง ไม่สลับตอน hide/show) แทน hash ชื่อ รวมกับสีที่ user override ผ่าน pipette แล้วส่ง map สำเร็จรูปเดียวกันให้ทั้ง `<Chart>` และ Selected Sensor tab ใช้ตรงกัน — การันตีไม่มีสีซ้ำกันจนกว่าจะเลือกเกิน 6 sensor พร้อมกัน (ข้อจำกัดตาม palette ขนาด 6 สี) `defaultSensorColor` ยังเก็บไว้เป็น fallback สุดท้ายเผื่อกรณี edge case `tsc --noEmit` ผ่าน

**🆕 ลบปุ่ม "Clear selection" ที่ซ้ำซ้อนออกจาก `SensorSelection.tsx` แล้ว** — ปุ่มนี้ (อยู่บน Sensor panel ฝั่งขวา เหนือ component tree) เรียก `onSensorChange([])` ซึ่งเคลียร์ `selectedSensors` ตัวเดียวกับปุ่ม "Clear all" ใน Selected Sensor tab (`Dashboard.tsx`) ที่เพิ่มไปก่อนหน้านี้แล้ว — ผู้ใช้สังเกตเห็นว่าซ้ำกัน เลยลบปุ่ม + handler `handleClearSelection` + import ไอคอน `X` ที่ไม่ใช้แล้วออก เหลือแค่ข้อความ "N sensors selected" แสดงจำนวนเฉยๆ ไม่มีปุ่ม — `tsc --noEmit` ผ่าน

**🆕 ตำแหน่ง popup ของทั้ง color picker และ Y-axis fix-scale editor ย้ายไปชิดขวาแล้ว** (`Dashboard.tsx`) — เดิมทั้งคู่ชิดซ้าย (`padding-left: 42px` ใต้ checkbox) ไม่ตรงกับตำแหน่งไอคอนที่กดเปิด (pipette/line-chart อยู่ขวาสุดของแถว) ผู้ใช้ขอให้ทั้งสอง popup ลอยไปทางขวาใต้กลุ่มไอคอนแทน แก้ด้วย wrapper `display:flex; justifyContent:'flex-end'` ทั้งสองจุด (เดิม axis editor เคยลองสลับเป็นขวาอย่างเดียวก่อนแล้วโดนขอให้กลับซ้ายรอบนึง แต่สุดท้ายสรุปว่าให้ทั้งคู่ขวาเหมือนกัน — ผู้ใช้ยอมรับว่า diagram/ลูกศรที่ส่งมารอบแรกทำให้เข้าใจผิด) — `tsc --noEmit` ผ่าน ยังไม่ได้เทสต์บนแอปจริง

**🆕 Scatter Plot มี axis-scale pin เป็นของตัวเอง** (`ScatterChart.tsx`) — ปุ่ม Ruler ในกล่อง toolbox เปิดแผงตั้ง min/max ของแกน X และ Y แยกกัน (ใส่แค่ด้านเดียวได้ ฝั่งที่ไม่ใส่ auto-fit ต่อ) เป็น state **ของ ScatterChart เอง** ไม่ยุ่งกับ `sensorColors`/`sensorAxisRange` ของ Line เลย pin ผูกกับ "เซนเซอร์ที่กำลังอยู่บนแกนนั้น" (ไม่ใช่ตำแหน่งแกนเฉยๆ) ถ้าสลับ dropdown X/Y เป็นเซนเซอร์อื่น pin จะไม่ตามไปทับผิดตัว — ผ่านการรีวิว 2 รอบ (agent คู่ขนาน + ตรวจเอง) เจอและแก้บั๊กจริง 5 จุด: flicker ตอนสลับเซนเซอร์, `Infinity` หลุดผ่านการ validate, ช่องกรอกไม่ sync ตอนสลับเซนเซอร์ระหว่างเปิดแผงค้าง, แกนกลับด้านเมื่อ pin ข้างเดียวเกินขอบเขตจริง, กล้อง zoom/pan ไม่ sync กับสเกลใหม่ (แก้ด้วย `sc.reset()` ทุกครั้งที่วาดใหม่ — แก้ปัญหานี้ให้ตอนสลับเซนเซอร์ธรรมดาด้วย)

**⚠️ Browser preview ใช้ตรวจ UI ของแอปนี้ไม่ได้เลย** — เคยลองเปิด `http://localhost:1420` (Vite dev server) ผ่าน browser tab ธรรมดา แต่แอป crash ตั้งแต่ root เพราะ `TitleBar.tsx` เรียก Tauri's `getCurrentWindow()` ทันทีที่ mount โดยไม่มี Tauri IPC bridge ให้ (ไม่ใช่แค่บางฟีเจอร์ที่พังนะ — **ทั้งแอปไม่ขึ้นเลย**) ต้องทดสอบผ่านหน้าต่าง `npm run tauri dev` จริงเท่านั้น

---

## 7. สถานะ Git (แก้ใหม่ทั้งหมด 2026-08-06 — ของเดิมผิดไปแล้ว)

**✅ Commit + push แล้ว** เมื่อ 2026-08-06 — เดิม section นี้เขียนไว้ว่า "ยังไม่มีอะไร push หรือ commit เลย" ซึ่งจริงตอนเขียนครั้งแรก (16 ก.ค.) แต่ผิดไปแล้วตอนนี้ **อย่าเชื่อบรรทัดนี้เกิน 1 วันโดยไม่เช็ค `git log`/`git status` เองก่อน**:

- Commit เดียวรวมทุกอย่าง: `6dfb269` — "Fold Failure Group Creation into Dashboard; fix several UI bugs; git hygiene" (50 ไฟล์, รวมงานสะสมของหลาย session ตั้งแต่ก่อน 16 ก.ค. จนถึงงาน Failure Groups migration + ลบปุ่ม Save As วันนี้)
- Push ไปที่ remote **`personal`** (`https://github.com/toeyps/soothsayer-wizard-app.git`) branch `main` — เป็น branch ใหม่บน repo ว่างเปล่า (ยังไม่เคย push มาก่อน)
- Repo นี้มี **2 remotes**: `origin` (`https://github.com/Alpha-Com-Thailand/Soothsayer-wizard-app.git` — org repo, local `main` ยัง track อยู่กับตัวนี้โดย default) กับ `personal` (ของผู้ใช้เอง toeyps) — **`git push` เฉยๆ (ไม่ระบุ remote) จะไปที่ `origin` ไม่ใช่ `personal`** ถ้าต้องการ push ไป personal ต้องพิมพ์ `git push personal main` ให้ครบทุกครั้ง (หรือถามผู้ใช้ว่าต้องการตั้ง tracking ใหม่ไหม)
- ก่อน commit ต้องตั้ง git identity ก่อน (เครื่องนี้ไม่เคยตั้งมาก่อนเลย ต้องให้ผู้ใช้รัน `git config --global user.name/user.email` เอง — ห้าม Claude ไปแก้ git config เองเด็ดขาดตาม Git Safety Protocol)
- ไฟล์แปลกปลอมที่เคยพูดถึงใน §8 ข้อ 3 เดิม (`src-tauri/2`, `check_output.txt`, `nuitka-crash-report.xml`, `.claude/settings.local.json`, `.claude/worktrees/*`) **ถูกลบออกจาก git แล้วใน commit นี้** (ยังอยู่ในเครื่อง local แต่ gitignore ไว้แล้ว ไม่ track อีกต่อไป)

---

## 8. จุดที่ควรระวังตอน handover (พบจากการตรวจโค้ดจริง — อัปเดตสถานะแล้ว)

1. ~~**`README.md` ล้าสมัย**~~ → **✅ แก้แล้ว 2026-08-06** — เขียนใหม่ทั้งไฟล์ให้ตรงสภาพปัจจุบัน (features, sub-window list ที่ถูกต้อง, setup/run/test commands ที่ตรวจกับ `package.json` จริง) commit ไปพร้อมกับ README fix รอบนี้ (ดู entry ท้ายสุดของเอกสารนี้)

2. **ข้อขัดแย้งเรื่อง auto-resume ยังไม่ได้แก้**: `CLAUDE.md` เขียนว่า auto-resume เป็น hard requirement แต่คอมเมนต์จริงใน `src/App.tsx` บอกว่า "No auto-resume" — ผู้ใช้ต้องเลือกเองจาก **step 0 "Open recent project"** (จุดใหม่ที่แทนที่ sidebar เดิมในหน้าแรก) ยังไม่ได้ยืนยันกับทีมว่าอันไหนคือพฤติกรรมที่ตั้งใจ

3. ~~**ไฟล์แปลกปลอมที่ commit เข้า git ยังอยู่**~~ → **✅ แก้แล้ว** — `src-tauri/2`, `src-tauri/check_output.txt`, `src-tauri/nuitka-crash-report.xml` ลบออกจาก git แล้ว (commit `6dfb269`) และเพิ่มเข้า `.gitignore` กันไม่ให้กลับมาอีก

4. **Sidecar binary compile แล้วบนเครื่องนี้** — `src-tauri/bin/backend-x86_64-pc-windows-msvc.exe` มีอยู่แล้ว (ไม่ track ใน git ตามปกติ) แต่**เครื่องอื่นต้อง build เองใหม่** ตามขั้นตอนใน §4

5. **CSP กับ PDF export**: production CSP มี `'unsafe-eval'` ใน `script-src` เพราะ react-pdf's yoga-layout compile WASM runtime — ถ้าจะ tighten CSP ในอนาคต ต้องเทสต์ export บน **installed build จริง** เพราะ dev mode ใช้ `devCsp` ที่หลวมกว่าและจะไม่เจอบั๊กนี้

6. **ห้ามขยาย CSP หรือ fs scope โดยไม่ขออนุมัติ** — fs plugin scope เฉพาะ `$APPDATA`; เขียนไฟล์ path ที่ผู้ใช้เลือกเอง (CSV/PDF/PNG export) ต้องผ่าน Rust command `write_user_file` เท่านั้น

7. **"LinearGAM" ห้ามโผล่ในข้อความที่ผู้ใช้เห็น** — UI ต้องเรียกว่า "Relation model" เสมอ (ชื่ออัลกอริทึมเป็นความลับทางธุรกิจ) — คอมเมนต์โค้ดพูดได้

8. **IPC arg-key casing เป็นจุดพังเงียบอันดับ 1**: TS ส่ง key แบบ snake_case (`max_points`) แต่ Tauri v2 macro default เป็น camelCase → command ใหม่ที่มี multi-word parameter **ต้องมี** `#[tauri::command(rename_all = "snake_case")]` ไม่งั้น invoke จะ reject แบบเงียบๆ

9. **Agent zone ownership** — sub-agent (`fe-ui-agent`, `fe-logic-agent`, `rust-agent`, `qa-agent`, `pm-agent`) นิยามไว้ใน `.claude/agents/` แต่**ใช้ไม่ได้ในเซสชันปัจจุบัน**เพราะ path ของโปรเจกต์เปลี่ยนกลางเซสชัน (harness ผูก registry กับ path ตอนเริ่ม) — ต้องเปิด session ใหม่จาก path `C:\00_DATA\Soothsayer-wizard-app` ถึงจะ scan `.claude/agents/` ใหม่และเรียกใช้ได้

10. ~~**หนี้ test ค้างจำนวนมาก**~~ → **✅ แก้แล้ว 2026-08-10** — เดิมยังไม่มีเทสต์เลยสำหรับ `SensorSelection.tsx`, `FilterPanel.tsx`, Dashboard's Selected Sensor tab — ตอนนี้เขียนเทสต์ครบทั้งโปรเจกต์แล้ว (frontend 97→**586 เทสต์/45 ไฟล์**, Rust unit 98→**139 เทสต์**) รวมไฟล์ที่เคยไม่มีเทสต์เลยทุกไฟล์ ดูรายละเอียดที่ entry ท้ายเอกสาร — ข้อยกเว้นเดียวที่ยังทำไม่ได้คือ command ที่ใช้ `State<AppState>` โดยตรง (ติด Windows Application Control policy บนเครื่องนี้ ไม่ใช่หนี้ที่เลี่ยงได้ง่ายๆ)

11. ~~**สี/Y-axis scale ต่อ sensor ไม่ persist**~~ → **✅ แก้แล้ว 2026-08-06** — เป็น Class B point ที่ 1-2 ใน `docs/PERSISTENCE_PLAN.md`, แก้พร้อมกับ Scatter axis pin และค่า shortcut Y/M/W/D/H ในรอบเดียวกัน (ดู entry "แก้ Class B ทั้ง 4 จุด" ด้านล่าง) — จุดนี้เคยลืมตัดออกจากลิสต์นี้ตอนแก้เสร็จ แก้ไขให้ตรงแล้วรอบนี้

12. **Repo มีเอกสารเก่าอื่นๆ ที่ควรอ่านคู่กัน**: `docs/requirements.md`, `docs/requirements-failure-group.md`, `docs/requirements-rust-port-hybrid.md`, `docs/task.md` (task breakdown — Feature 1 Data Upload Page Phase 1-2 เสร็จ, Phase 3 testing ยัง pending — **ไม่รวมงาน step-flow/Dashboard รอบล่าสุดที่ทำในเซสชันนี้ เพราะไม่ได้ผ่าน pm-agent**), `docs/contracts/*.md`, และ `multi_agent_orchestration_design.md` ที่ root

---

## 9. บันทึกปัญหาเครื่อง dev + วิธีแก้ (เจอจริงตอนตั้งเครื่องนี้ครั้งแรก)

เครื่องนี้ไม่เคย build Rust ได้เลยจนกว่าจะไล่แก้ปัญหาต่อไปนี้ทีละอัน — เก็บไว้กันคนต่อไปเจอซ้ำ:

1. **`cargo`/`cargo check` fail ด้วย `"An Application Control policy has blocked this file. (os error 4551)"`**
   สาเหตุ: **Kaspersky Plus's Intrusion Prevention** จัดไฟล์ .exe ที่เพิ่ง compile ใหม่ (ไม่มีลายเซ็นดิจิทัล) เข้ากลุ่ม "Low Restricted" แล้วบล็อกการรัน
   วิธีแก้: Kaspersky Plus → Security settings → Advanced protection → Intrusion Prevention → Manage resources → แท็บ **Exclusions** → เพิ่มโฟลเดอร์โปรเจกต์ทั้งหมด + `%USERPROFILE%\.cargo` + `%USERPROFILE%\.rustup` → **Save**
   ข้อควรรู้: การเพิ่ม exclusion แบบนี้แก้ปัญหา "เขียนไฟล์ไม่ได้" ระหว่าง build ได้ แต่**ไม่ครอบคลุมการรัน .exe ที่ build เสร็จแล้ว** — ไฟล์ที่เคยโดนบล็อกไปแล้วยังต้องลบทิ้งให้ compile ใหม่ (fresh file ถึงจะผ่าน exclusion) ส่วนการ "รัน" ไฟล์ที่ build เสร็จ (เช่น `tauri-app.exe`) ต้องไปที่ **Manage applications** แทน ไม่ใช่ Manage resources

2. **`cargo build` fail ด้วย `"output path is not a writable directory"`** (error จาก `autocfg` เวลา compile `indexmap`)
   สาเหตุ: โปรเจกต์อยู่ใน **OneDrive-synced folder** — OneDrive ล็อกไฟล์ที่ cargo สร้าง/ลบรัวๆ ระหว่าง build
   วิธีแก้ที่ใช้ตอนนั้น (ไม่จำเป็นแล้วหลังย้าย path): redirect `target-dir` ออกไปนอก OneDrive ผ่าน `.cargo/config.toml` (gitignored, machine-local)
   **วิธีแก้ถาวรที่ใช้จริงตอนนี้**: ย้ายทั้งโปรเจกต์ออกจาก OneDrive ไปที่ `C:\00_DATA\Soothsayer-wizard-app` แทน — เลิกใช้ workaround ทั้งหมดแล้ว (ลบ `.cargo/config.toml` ออกแล้ว, target-dir กลับไปเป็น default `src-tauri/target`)

3. **PowerShell (Windows PowerShell 5.1 ตัวเดิมของเครื่อง) รัน `npm run tauri dev` ไม่ได้**: `"running scripts is disabled on this system"`
   สาเหตุ: PowerShell execution policy default (`Restricted`) บล็อก `.ps1` script ทุกตัวรวมถึง `npm.ps1`
   วิธีแก้: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` (รันครั้งเดียวต่อ user account)

4. **Python จริงอยู่คนละที่กับที่ `python` บน PATH ชี้ไป** — `python`/`py` บน PATH เป็นแค่ Windows Store alias (ใช้งานไม่ได้จริง) ส่วน Python ตัวจริง (ติดตั้งผ่าน Python install manager ใหม่) อยู่ที่ `%LOCALAPPDATA%\Python\bin\python.exe` — ต้องเรียก path เต็มตรงๆ หรือผ่าน `py` launcher (`py -3.14` เป็นต้น)

**สรุปโครงสร้าง exclusion ของ Kaspersky ที่ตั้งไว้ตอนนี้** (Intrusion Prevention → Manage resources → Exclusions): `C:\00_DATA\Soothsayer-wizard-app`, `%USERPROFILE%\.cargo`, `%USERPROFILE%\.rustup` — path เก่าที่เคย exclude ไว้ตอนอยู่ใน OneDrive (`C:\rust-builds`, OneDrive path เดิม) ไม่จำเป็นแล้ว ปล่อยทิ้งไว้ได้ไม่มีผลเสีย

---

## 10. สถานะ repo ล่าสุด (อ้างอิงจาก git log + git status ณ 2026-07-16)

- `main` @ v0.2.1 (`6ed6559`…`cb6d105`) คือ branch หลัก — มีงาน RAM optimization ครบ 2 ขั้น: columnar store (PR #1) + bounded chart pipeline/error reporting (`3620eb6`)
- Step 3 (disk-backed store เช่น DuckDB/mmap Arrow) วางแผนไว้เฉพาะถ้า RAM ยังไม่พอหลัง step 2 — ยังไม่เริ่ม
- Branch `feat/columnar-ram-opt` และ `claude/gifted-kepler-*` ถูก merge/superseded แล้ว — ไม่ควร base งานใหม่จากตรงนั้น
- **🆕 มีงาน UI/UX รอบใหญ่ที่ทำในเซสชันนี้ยังไม่ commit เลย** (13 ไฟล์แก้ + `docs/PROJECT_HANDOVER.md` + `src/hooks/useSensorMetaMap.ts` ใหม่) ครอบคลุม: DataUploadPage 3-step flow, SensorSelection group-by-component, Dashboard Selected Sensor tab (hide/color/pin-scale/remove + ตอนนี้แยกตาม chart type แล้ว), relative time-range picker, FilterPanel sensor labels, collapsed-sidebar positioning fix, Scatter Plot axis-scale pin (`ScatterChart.tsx`) — **ควร commit เป็นชุดๆ ตามฟีเจอร์ก่อนเริ่มงานถัดไป** เพื่อไม่ให้ diff ใหญ่เกินจน review ยาก
- **🆕 ผู้ใช้ทำงานสลับ 2 เครื่อง** — Claude Code ไม่มี session history sync ข้ามเครื่อง (เก็บ local ที่ `~/.claude/projects/...` ต่อเครื่อง) เอกสารนี้เลยถูกอัปเดตอัตโนมัติทุกครั้งที่ทำงานเสร็จแทน chat history — **ต้อง commit+push ไฟล์นี้เองด้วยถ้าอยากให้เครื่องที่ 2 เห็น** (ยังเป็น untracked file อยู่ตอนนี้)
