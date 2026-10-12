# Wizard — Manual Test Plan

> 424 ข้อ · **อัปเดต 2026-10-11 รอบ 3 (Health score คิดจากค่าเฉลี่ยราย 1 ชั่วโมง)** — คะแนนสุขภาพของทั้ง 3 ชนิดโมเดลเป็น **1 จุดต่อชั่วโมง = ค่าเฉลี่ยของแถวที่เครื่องเดินในชั่วโมงนั้น** (ชั่วโมงที่เครื่องหยุดทั้งชั่วโมงไม่มีจุด; ไม่มีคะแนน = ช่องว่าง ไม่ใช่ 0) ส่วนการ Train ตัวเลขของโมเดล และหน้า Model fit ยังใช้แถวดิบ · **id ใหม่ (ความหมายเปลี่ยน): BMW-74 → BMW-210** (หัวกราฟ Health score นับเป็น "scored hours" + "· 1-hour averages of the running rows"; บรรทัดอ่านค่า "<ต้นชั่วโมง> · 1 h avg … · score …"; ไม่มีคะแนน = "no score"), **BMW-143 → BMW-211** (tile ของ Scoring results: "N.N% of running hours below 80", "Lowest NN (1 h average) on <ต้นชั่วโมง>", หมายเหตุใหม่, "No scored hours" — ไม่มี "held 1 h" / "of running time below 80"), **BMW-163 → BMW-212** (เวลาบนหน้า Health score เป็นต้นชั่วโมง ไม่มีวินาที; หน้า Model fit ยังเป็นเวลาของแต่ละแถว) · **ข้อใหม่ 8 ข้อ:** BMW-213 (ข้อมูล 5 นาที = 1 จุดต่อชั่วโมง ทั้ง 3 ชนิด), BMW-214 (ชั่วโมงที่เดินไม่ครบ / หยุดทั้งชั่วโมง), BMW-215 (ข้อมูลราย 1 ชั่วโมงอยู่แล้ว), BMW-216 (หน้า Model fit ยังเป็นข้อมูลดิบ; กราฟเวลาของ Relation model จบที่ช่วง Train), BMW-217 (โมเดลที่ Complete ก่อนอัปเดต: ข้อความเตือนที่ footer + "Mark complete again" แล้วหาย), BMW-218 (Clustering: ชั่วโมงที่เครื่องเปลี่ยน cluster ไม่มีคะแนน "no score" และ "Lowest" ไม่ไปตกที่ชั่วโมงนั้น), BMW-219 (Relation model ที่ไม่มี Scoring period ยังได้ health score + "Calculating the health score…" + กล่องเหลืองแทนการ์ด Health score), BMW-220 (ส่วน `validation` ของไฟล์ INFO: `scoring_interval_seconds`, `scoring_aggregation`, ตัวเลขรายชั่วโมง) · **ปรับข้อความ (id เดิม):** BMW-149 / BMW-154 / BMW-155 / BMW-156 (กราฟ set point เป็นค่าเฉลี่ยราย 1 ชั่วโมง หัวรองลงท้าย "· 1 h average" / "· 1 h averages · coloured by score"), BMW-158 (ไฟล์ INFO มี `scoring_interval_seconds` / `scoring_aggregation`), BMW-140 (ข้อความเตือนของโมเดลที่ Complete ก่อนอัปเดต), BMW-94 / BMW-95 (Train คำนวณจุดรายชั่วโมงไปด้วย; ข้อความใหม่ "Calculating the health score…" และ "The health score could not be calculated…"; เอาการอ้างถึงการ์ด "Train and scoring periods" ที่ถูกถอดแล้วออก), BMW-144 ("(1 h average)"), BMW-186 ("…results include hours the model was trained on"), BMW-205 / BMW-152 / BMW-164 (หน้า Model fit ของ Relation model: กราฟเวลาจบที่ช่วง Train ไม่มีแถบ S ของช่วงที่อยู่นอก Train), BMW-128 (ชี้ไป BMW-211) · สารบัญหมวด BMW นับใหม่เป็น 107 ข้อ · เพิ่มข้อที่รู้อยู่แล้ว 2 ข้อท้ายเอกสาร (ช่วงที่เริ่มกลางชั่วโมง: จุดแรกไม่ถูกวาด; เวลาที่ลงท้ายด้วย `Z`) · ก่อนหน้านี้: **อัปเดต 2026-10-11 รอบ 2 (แก้สถานะ "โมเดลมีผลอยู่แล้วแต่ไฟล์ข้อมูลไม่มีแถวของมัน")** — **BMW-200 → BMW-201**: กรณี C เปลี่ยนความคาดหวัง — โมเดลที่ Trained / Complete อยู่แล้ว**ไม่ขึ้น**กล่อง "Couldn't load the … model" / "Training failed" อีกแล้ว แต่ขึ้นกล่องเดียว **"No data for this model in the loaded file"** พร้อมสาเหตุและลิงก์เดียวไปที่ที่แก้ได้ (Running condition ↑ / Model settings) ทั้งหน้า Model fit และ Health score; ป้ายยังเป็น "Complete" / "Trained" จุดสีเดิม; หน้า Health score เปิดได้; Mark complete / Mark complete again กดไม่ได้พร้อมเหตุผล · **เอาข้อที่รู้อยู่แล้ว** เรื่องลิงก์ "Train sensor ▾" / "Train sensor ↑" ที่กดแล้วไม่เกิดอะไรออกจากท้ายเอกสาร (แก้แล้ว) · **อัปเดต 2026-10-11 (QA ปิดงาน Workbench redesign — ทดสอบสองหน้าต่างกับไฟล์ workspace จริง)** — **BMW-198 → BMW-200**: กรณี C แก้ให้ตรงกับแอปจริง — เมื่อ "ไม่มีข้อมูลให้ train จริง ๆ" โมเดลที่ Trained / Complete อยู่แล้ว**ยังเก็บสถานะที่บันทึกไว้และจุดที่ Dashboard ครบ** แต่**กราฟวาดไม่ได้** (ไฟล์ข้อมูลไม่มีแถวให้คำนวณ) จึงขึ้นกล่อง "Couldn't load the … model" / "Training failed" พร้อมเหตุผลเป็นคำของแอป — เดิมเขียนว่ากราฟ ป้าย จุด และหน้า Health score "เหมือนเดิมทุกอย่าง" ซึ่งเป็นจริงเฉพาะกรณี A · BMW-196 / BMW-199 / BMW-200 เพิ่มหมายเหตุ: ช่วงของข้อมูลในข้อความมีเวลาต่อท้ายเมื่อข้อมูลไม่ได้จบ 23:59 พอดี (id เดิม) · สารบัญหมวด BMW นับใหม่เป็น 95 ข้อ (เดิมเขียน 91) · รายการ id ที่เลิกใช้ด้านล่าง: ตัวชี้ "ตอนนี้คือ …" ที่ชี้ไปยัง id ซึ่งถูกเลิกใช้ซ้ำอีกรอบ ต่อท้ายด้วย "→ id ปัจจุบัน" · เพิ่มข้อที่รู้อยู่แล้ว 1 ข้อท้ายเอกสาร (ลิงก์ในกล่อง "Couldn't load…" / "Training failed" ที่กดแล้วไม่เกิดอะไรตอน Train ถูกกัน) · **อัปเดต 2026-10-10 (ปรับกติกา "ไม่มีข้อมูลให้ train" หลังรีวิว: กันเฉพาะการกระทำ ไม่เอาผลที่มีอยู่ออก)** — ช่วงเวลาที่**บันทึกไว้อยู่แล้ว**และอยู่นอกข้อมูลเป็นแค่คำเตือนสีเหลือง (ไม่กัน Apply / Save changes / Mark complete และไม่ทำให้กราฟหรือสถานะของโมเดลหาย); ช่วงที่**เพิ่งเลือก/เพิ่งแก้**แล้วอยู่นอกข้อมูลยังกัน Apply / Save changes ทันที; ปุ่ม Train ถูกกันเฉพาะเมื่อ "ไม่มีข้อมูลให้ train จริง ๆ" · ความหมายของข้อเปลี่ยนจึงตั้ง id ใหม่: **BMW-190 → BMW-196**, **BMW-191 → BMW-197**, **BMW-192 → BMW-198** · ข้อใหม่ **BMW-199** (หน้าต่าง Build Model ที่เปิดค้างแล้วสลับโปรเจกต์: ใช้ช่วงข้อมูลของโปรเจกต์ใหม่) · เพิ่มประโยคใน BMW-194 (โมเดล Custom ที่ไม่มีทั้งเงื่อนไขและ Train period: footer กับจุดบอกเรื่องเดียวกันตามลำดับ) · ก่อนหน้านี้: **อัปเดต 2026-10-10 (เรียกชนิดโมเดลว่า "Relation model" ทั้งแอป)** — ทุกข้อที่เคยเขียนชื่อชนิดว่า Relationship เปลี่ยนเป็น "Relation model" (เปลี่ยนเฉพาะคำที่เรียก ความหมายของข้อไม่เปลี่ยน จึงไม่เปลี่ยน id) · ข้อใหม่: **SEN-23** (นอกหน้าต่าง Build Model: หัวคอลัมน์และ tooltip ของแผง Failure groups, ป้ายในแท็บ Failure Groups, แถบ Undo "Relation model of … deleted", ข้อความล็อกของ special sensor "(Relation model)"), **BMW-195** (workspace เก่ายังเก็บชื่อโมเดล "X (Relationship)" ตามเดิม สถานะไม่เปลี่ยน; ชื่อที่เสนอให้โมเดลใหม่เป็น "X (Relation model)") · แก้ข้อความใน BMW-189 (ตัดหมายเหตุว่า Dashboard ยังใช้คำเดิม) และ BMW-27 (ปุ่มเสนอชื่อเป็น "Use 'ชื่อ (Relation model)'") · ก่อนหน้านี้: **อัปเดต 2026-10-10 (กันกรณี "ไม่มีข้อมูลให้ train" ตั้งแต่ที่หน้าจอ + แก้ตามผลรีวิวหน้าสถานะของ Workbench)** — เพิ่ม **BMW-190** (ช่วงเวลาที่เลือกอยู่นอกช่วงของข้อมูล: แถวแดง + Apply / Save changes กดไม่ได้; เลยขอบบางส่วน = หมายเหตุสีเหลือง), **BMW-191** (นับแล้วไม่มีแถวให้ train เลย: บรรทัดแดง + "No rows to train on"), **BMW-192** (ค่าที่บันทึกไว้แล้วอยู่นอกข้อมูล / ไม่มีแถว: การ์ดบอกเหตุผล และ Train ถูกกันไว้พร้อมเหตุผล โดยไม่เขียนอะไร), **BMW-193** (แถบ "Incomplete again" ไม่มีลิงก์ที่กดแล้วไม่เกิดอะไร, โมเดล "Marked complete" ที่ train ไม่ผ่าน, "Load it again" ตอนกดไม่ได้) · ตั้ง id ใหม่เพราะความหมายเปลี่ยน: **BMW-194** (แผง Custom: ช่วงของโมเดลเองที่ผิด — Train ด้วย ไม่ใช่แค่ Scoring — กัน "Save changes" เหมือนที่กัน Apply; แทน BMW-187) · **รอบก่อนหน้า (แก้ตามผลรีวิว popup Running condition — พิมพ์วันที่แล้วค่าเข้าแบบร่างทันที)** — ตั้ง id ใหม่เพราะความหมายเปลี่ยน: **BMW-183** (timeline / จำนวนวัน / บรรทัดสรุปตามวันที่ที่พิมพ์ทันทีโดยไม่ต้องคลิกออก, ยังไม่ตั้งเงื่อนไข = "set the condition to count the rows"; แทน BMW-171), **BMW-184** (บรรทัดผลกระทบขึ้นก่อนกด Apply เสมอ แม้แก้แค่วันที่, วันที่พิมพ์ไม่ครบ = บรรทัดเทา "Finish the date in P1 to see what this changes"; แทน BMW-173), **BMW-185** (Train periods: ลบวันที่บางส่วนแล้วคลิกออก = วันเดิมกลับมา ไม่กลายเป็น "Start of data", แถวไม่สลับระหว่างพิมพ์; แทน BMW-175), **BMW-186** (Scoring periods: ลบวันที่ด้วยการพิมพ์แล้ววันเดิมกลับมา; แทน BMW-176), **BMW-187** (แผง Custom: วันที่เข้าแบบร่างของโมเดลทันที, footer "Fix S1 before saving"; แทน BMW-177 — ตอนนี้คือ BMW-194), **BMW-188** (บรรทัด Running condition: จำนวนแถว + % เป็นตัวเลขชุดเดียวกับใน popup; แทน BMW-130) · ข้อใหม่: **BMW-189** (เรียกชนิดโมเดลว่า "Relation model" ทุกที่ในหน้าต่าง Build Model) · ก่อนหน้านี้: **อัปเดต 2026-10-10 (Phase D ของ Workbench redesign — ข้อความ Train sensor / Train all + สถานะของหน้า)** — ตั้ง id ใหม่เพราะความหมายเปลี่ยน: **BMW-178** (แถบเหลืองตอนค่าเปลี่ยน ไม่มีปุ่ม Re-train แล้ว มีแค่ลิงก์ "Train sensor ↑"; แทน BMW-59), **BMW-179** (เมนู ▾ ของ Train sensor: บรรทัดสถานะใต้ทุกแถว, sensor ที่มีโมเดลเดียวไม่มีแถว "Train all 1 model", ปุ่มจางเขียน "▶ Train sensor" เฉย ๆ, เหตุผลบอกชื่อค่าที่ขาด; แทน BMW-142), **BMW-180** (pre-flight ของ Train all: "Skipped" + เหตุผลบรรทัดที่สอง, ไม่แสดงจำนวนที่เป็น 0; แทน BMW-105), **BMW-181** (กล่องถามตอนปิดระหว่าง train: Tab วนอยู่ในกล่อง; แทน BMW-108) · ข้อใหม่: **BMW-182** (โมเดล Complete ที่โหลดผลไม่สำเร็จ: "Load it again" แทน "Train sensor ↑" ที่กดไม่ได้) · แก้ข้อความให้ตรงหน้าจอใหม่ (id เดิม): BMW-153, BMW-134, BMW-135, BMW-166, BMW-161 · ก่อนหน้านี้: **อัปเดต 2026-10-10 (Phase C ของ Workbench redesign — popup Running condition ออกแบบใหม่ + แผง Custom)** — ตั้ง id ใหม่เพราะความหมายเปลี่ยน: **BMW-170** (โครงคอลัมน์เดียว + timeline + แถวเงื่อนไขบรรทัดเดียว; แทน BMW-52), **BMW-171** (บรรทัดสรุปใต้ timeline + "d running" ต่อช่วง; แทน BMW-54 — คอลัมน์ขวา "Data used for training" ถูกถอดออก), **BMW-172** (แบบร่าง + Apply + "Fix P2 before applying"; แทน BMW-50), **BMW-175** (Train periods; แทน BMW-86 — กล่องคำอธิบายสีฟ้าถูกถอดออก), **BMW-176** (Scoring periods; แทน BMW-121), **BMW-177** (แผง Custom หน้าตาเดียวกับ popup; แทน BMW-123) · ข้อใหม่: **BMW-173** (คำเตือนผลกระทบก่อน/หลัง Apply), **BMW-174** (คีย์บอร์ด: โฟกัสช่องแรก + Tab วนใน popup) · แก้ข้อความใน BMW-127 และ PER-14 ให้ตรงหน้าจอใหม่ (id เดิม) · ก่อนหน้านี้: **อัปเดต 2026-10-10 (QA ปิด Phase B ของ Workbench redesign)** — ข้อใหม่ **BMW-169** (ปิด Animation effects ของ Windows แล้วไอคอนหมุนต้องหยุดหมุน); **BMW-135** เพิ่มขั้นตรวจ 2 สถานะ (ระหว่าง train, โมเดล Custom ตอน workspace ยังไม่ตั้ง Running condition); แก้ข้อความที่ยังพูดถึงของที่ถอดไปแล้ว: บทนำหมวด BMW (เดิมยังเขียนว่า "ยังไม่มีปุ่ม Train / กราฟ / จุดสถานะ"), FG-14 ("ป้ายเหลือง" บนแท็บ → จุดเหลือง), BMW-134 (ประโยค footer ตอน fit หาย + อ้างอิง BMW-159 → BMW-167), อ้างอิง EDT-35 → EDT-57 และ BMW-75 → BMW-158; สารบัญหมวด BMW นับใหม่เป็น 85 ข้อ (เดิมเขียน 82 แต่มีจริง 84) · **อัปเดต 2026-10-10 (แก้หน้า Health score ตามผลรีวิว + จำนวน cluster สูงสุด 5)** — กล่อง "Fit no longer in memory" ของทั้งสองหน้ามีลิงก์ **"Load it again"** (โหลด fit เดิมกลับมาโดยไม่ train ใหม่ ไม่เขียนอะไรลงดิสก์ โมเดล Complete ยัง Complete) — ข้อใหม่ **BMW-166**; หน้า Health score ตอนโหลดคะแนนไม่สำเร็จ: พิมพ์ set point ใต้การ์ดแดงแล้วช่องไม่หาย, ข้อมูลถูกโหลดใหม่ = footer บอกให้ปิดแล้วเปิด Build Model ใหม่ (ไม่ชี้ไปที่ Retry ที่ไม่มี) — **BMW-167 แทน BMW-159**; จำนวน cluster ตั้งได้สูงสุด 5 (โมเดลเก่าที่มีมากกว่า 5 เปิดได้เหมือนเดิม) — ข้อใหม่ **BMW-165**; ตัวเลขที่โปรแกรมคำนวณในคอลัมน์ของตาราง (Train and scoring periods, แถว automatic ของ Health set points) มีทศนิยม 3 ตำแหน่งเท่ากันทุกแถว — ข้อใหม่ **BMW-168** · **อัปเดต 2026-10-10 (แก้กราฟ Workbench ตามผลรีวิว — ตำแหน่งป้ายบนกราฟ)** — Target vs predicted: มีแถวสีกำกับ "Actual / Predicted" ใต้กราฟ (ไม่เขียนชื่อที่ปลายเส้นแล้ว เพราะชื่อไม่ตามเส้นตอนซูม — BMW-164 แทน BMW-147); ชื่อวงของ Clustering ไม่ทับกันเมื่อ cluster เอียง (BMW-148, BMW-156); ตัวเลขแกนเว้นระยะเท่ากันทุกแกน (BMW-145, BMW-146); ชื่อ ±1SD / ±3SD ซ้อนเป็นสองบรรทัดเมื่อ L / H อยู่ไกลจากข้อมูล และค่าติดลบใช้เครื่องหมายลบจริง (BMW-149); แถบชื่อช่วงเขียน "TRAIN" ครั้งเดียวและไม่ทับกันเมื่อมีหลายช่วง (BMW-152); "< 0.1%" ที่หัวกราฟคะแนนด้วย (BMW-74); แกนเวลาใช้เวลาตามที่เขียนในไฟล์ (BMW-163); ตัวเลขที่โปรแกรมคำนวณใช้ตัวจัดรูปแบบเดียวกับทั้งแอป (ไม่เติมศูนย์ท้าย, ค่าที่ไม่ใช่ศูนย์ไม่แสดงเป็น 0) · **อัปเดต 2026-10-10 (Workbench redesign ส่วน set point ของหน้า Health score — SPEC workbench-redesign §4)** — การ์ด "Health set points" เป็นตารางเล็ก Score · Band · Lower · Upper (ค่าที่โปรแกรมคำนวณเป็นข้อความ ไม่ใช่ช่องกรอก); Individual: หมายเหตุ master data อยู่ในการ์ด + ลิงก์ "Use master H 4.5" เฉพาะด้านที่ต่าง; Relation model: 4 ช่องเริ่มว่าง placeholder "−" / "+"; Clustering: แถว 1× / 3× เป็นข้อความ, N มีปุ่ม − / + และ 4×–7×; Checks อยู่ในการ์ดเดียวกัน; โหลดคะแนนไม่สำเร็จ = การ์ดแดง + Retry และ Mark complete กดไม่ได้พร้อมเหตุผลที่ footer; ระหว่างบันทึกบอกที่ footer อย่างเดียว; fit ของ Relation model หายจากหน่วยความจำ = ไม่มีปุ่ม Re-train ในหน้า ชี้ไป "Train sensor ↑"; แถบหลัง run เป็นบรรทัดเดียว; ค่าที่ผู้ใช้พิมพ์แสดงตามที่พิมพ์ทุกที่ (ไม่มี "-2.000"); เวลาตอนชี้กราฟมีวินาทีเมื่อข้อมูลถี่กว่านาที · ข้อใหม่ BMW-153 (แทน BMW-136), BMW-154 (แทน BMW-70), BMW-155 (แทน BMW-150), BMW-156 (แทน BMW-151), BMW-157 (แทน BMW-138), BMW-158 (แทน BMW-139), BMW-159 (แทน BMW-82), BMW-160 (แทน BMW-110), BMW-161 (แทน BMW-112), BMW-162 (ใหม่), BMW-163 (ใหม่) · ปรับข้อความ + เพิ่มขั้นตรวจ (id เดิม): BMW-134, BMW-140 · ก่อนหน้านี้: **อัปเดต 2026-10-10 (Workbench redesign ส่วนกราฟ — SPEC workbench-redesign §3)** — ชื่อช่วง Train / Scoring ย้ายไปอยู่ในแถบเหนือกราฟ (ไม่มีป้ายในกราฟ); ชื่อเส้นอ้างอิงอยู่ขอบขวานอกกราฟ; ระบายสีเฉพาะแถบคะแนน 100, ±3SD เป็นเส้นประ; เส้น set point ของผู้ใช้เด่นสุดและเขียนค่าตามที่พิมพ์; "Actual" / "Predicted" เขียนที่ปลายเส้น; ไม่มีแถว legend ใต้กราฟที่มีชื่อบนเส้นแล้ว; แกน Distribution เป็นเลขกลม; Clustering: ชื่อวงครั้งเดียวต่อระดับ, วง N เส้นทึบแดง, สี cluster ไม่ใช้เขียว/เหลือง/แดง, แกนเห็นวงครบ, ชื่อแกนเป็น description + หน่วย, ช่วงตามที่พิมพ์ · ข้อใหม่ BMW-145 (แทน BMW-63), BMW-146 (แทน BMW-64), BMW-147 (แทน BMW-65), BMW-148 (แทน BMW-67), BMW-149 (ใหม่), BMW-150 (แทน BMW-71), BMW-151 (แทน BMW-72), BMW-152 (แทน BMW-124) · ปรับข้อความ + เพิ่มขั้นตรวจ (id เดิม): BMW-68, BMW-74, BMW-118 · ก่อนหน้านี้: **อัปเดต 2026-10-10 (Workbench redesign ส่วนโครงหน้า — SPEC workbench-redesign §1)** — หัวหน้าต่าง "Build Model" ไม่มี "Step 1"; Running condition เป็นบรรทัดเดียว + Details; หัว detail มีกลุ่มปุ่มเดียว (Performance/Condition · Model fit | Health score · Train sensor); แท็บ Individual / Relation model / Clustering มีจุดสถานะ ไม่มีป้ายข้อความ; footer = ป้ายเดียว + ประโยคเดียว; ปุ่มทึบได้ปุ่มเดียว; ผลบันทึกบอกที่ footer (ไม่มีแถบ "Files saved to"); วันเวลารูปแบบเดียว; สลับหน้า/แท็บเลื่อนขึ้นบนสุด · ข้อใหม่ BMW-129 (แทน BMW-114), BMW-130 (แทน BMW-122), BMW-131 (แทน BMW-28), BMW-132 (แทน BMW-60), BMW-133 (แทน BMW-115), BMW-134 (แทน BMW-103), BMW-135 (ใหม่), BMW-136 (แทน BMW-62), BMW-137 (แทน BMW-69), BMW-138 (แทน BMW-73), BMW-139 (แทน BMW-75), BMW-140 (แทน BMW-76), BMW-141 (แทน BMW-102), BMW-142 (แทน BMW-120), BMW-143 (แทน BMW-126), BMW-144 (ใหม่) · ปรับข้อความ (id เดิม): ทุกข้อที่เคยเรียก "การ์ด Step 1" / "1 Model fit" / "2 Health score", BMW-81, BMW-107, BMW-111, BMW-127 · ก่อนหน้านี้: **อัปเดต 2026-10-10 (Scoring periods — "just score it": Test periods เปลี่ยนชื่อเป็น Scoring periods, เหลือแค่วันเริ่ม → วันสิ้นสุด)** — เอาออกจากแอป: ปุ่ม Normal / Known problem, ช่อง Event time + lead time, ผลตัดสินสีเขียว/เหลือง, แถบลายเฉียงและเส้น EVENT บนกราฟ, จำนวน "n Normal · n Known problem", และ "From Highlights" ของ Scoring periods (คำเตือน Train period ทับ highlight + "Remove the overlap" ยังอยู่) · ข้อใหม่ BMW-121 (แทน BMW-87), BMW-122 (แทน BMW-88), BMW-123 (แทน BMW-89), BMW-124 (แทน BMW-90), BMW-125 (แทน BMW-91), BMW-126 (แทน BMW-92), BMW-127 (แทน BMW-93), BMW-128 (workspace เก่าที่มี label / event time) · BMW-86 / BMW-94 / BMW-95 / BMW-40 / BMW-75 ปรับข้อความ (id เดิม) · **อัปเดต 2026-10-10 (Build Model: ข้อความเมนู ▾ ของ Train sensor · จำนวน set point ที่ว่างใน footer · แกน Score เป็นเลขจำนวนเต็ม · หน้าต่างที่ถูกดึงไปโปรเจกต์ที่ Duplicate มา)** — ข้อใหม่ BMW-120 (แทน BMW-104), MULTI-14 · BMW-62 / BMW-73 / BMW-84 / BMW-118 ปรับข้อความ + เพิ่มขั้นตรวจ (id เดิม) · **อัปเดต 2026-10-09 (โมเดล Clustering ใหม่เริ่มที่ 1 cluster แทน 3)** — ข้อใหม่ BMW-119 · BMW-117 ปรับข้อความ + เพิ่มขั้นตรวจการเปลี่ยน criteria sensor A → B (id เดิม) · **อัปเดต 2026-10-09 (แก้บั๊กจากการทดสอบแอปจริง: Rename/Delete บนการ์ดเปิดโปรเจกต์แทน · ปฏิทินในแถบช่วงเวลา · ปุ่ม ↺ ของ Pair Plot)** — ข้อใหม่ IMP-52, TIME-9 (แทน TIME-1), PAIR-18 · IMP-29 ปรับข้อความ (id เดิม) · **อัปเดต 2026-10-09 (ทดสอบแอปจริง: Build Model)** — ถอดแถบขั้นตอนที่หัวหน้าต่าง: ข้อใหม่ BMW-114 (แทน BMW-57), BMW-115 (แทน BMW-85) · Criteria sensor ล้างค่าได้: BMW-116 (แทน BMW-98) · พิมพ์ค่าเส้นแบ่ง cluster: BMW-117 (แทน BMW-48) · ตัวเลขแกนกราฟไม่มีทศนิยมเพี้ยน: BMW-118 · BMW-103 / BMW-99 ปรับข้อความ (id เดิม) · **อัปเดต 2026-10-09 (customer batch phase 5: Formula editor + Quick build แทนปุ่มคำนวณเดิม)** — ข้อใหม่ MNG-29, SPC-33 (แทน SPC-2), SPC-34 (แทน SPC-3), SPC-35 (แทน SPC-4), SPC-36 (แทน SPC-5), SPC-37 (แทน SPC-11 + SPC-26), SPC-38 (แทน SPC-13), SPC-39 (แทน SPC-15), SPC-40 (แทน SPC-16), SPC-41 (แทน SPC-22), SPC-42 (แทน SPC-25), SPC-43 (แทน SPC-30), SPC-44 (แทน SPC-27), SPC-45 (แทน SPC-28), SPC-46 (แทน SPC-29), SPC-47 (แทน SPC-32), SPC-48 – SPC-54, MNG-27 (แทน MNG-2), MNG-28, EDT-54 (แทน EDT-1), EDT-55 (แทน EDT-52, EDT-53, EDT-7, EDT-43), EDT-56 (แทน EDT-6), EDT-57 (แทน EDT-35), EDT-59 (แทน EDT-45), EDT-60 (แทน EDT-49), EDT-61 (แทน EDT-50), EDT-62 · ตัด SPC-14 · SPC-6 / SPC-20 / SPC-24 / MNG-8 / EDT-17 / EDT-20 / EDT-37 / EDT-48 ปรับข้อความ (id เดิม) · **อัปเดต 2026-10-09 (customer batch phase 4: Train sensor / Train all พร้อมคิว)** — ปุ่ม "▶ Train model" ที่ footer ถูกเอาออก: ข้อใหม่ BMW-102 (แทน BMW-33), BMW-103 (แทน BMW-83), BMW-104 – BMW-113 · BMW-59 / BMW-62 / BMW-84 / BMW-107 ปรับข้อความ (id เดิม) · **อัปเดต 2026-10-09 (customer batch phase 3: Failure groups เป็น step 3 ของหน้า Import)** — ข้อใหม่ IMP-45 (แทน IMP-33), IMP-46 (แทน IMP-39), IMP-48, IMP-49, IMP-50, IMP-51, FG-16 (แทน FG-5), FG-17, FG-18 · ตัด IMP-17 (กด Open Dashboard ที่ step 2 — ย้ายไป step 3, ดู IMP-49) · IMP-19 / IMP-30 / IMP-32 / FG-9 ปรับข้อความ (id เดิม) · **อัปเดต 2026-10-09 (customer batch phase 2: แถบ cluster ของ Pair Plot + เปลี่ยนชื่อ cluster)** — PAIR-4 เขียนใหม่ (id เดิม), PAIR-11 / PAIR-9 ได้ id ใหม่ (PAIR-13 / PAIR-14), ตัด PAIR-6 / PAIR-7 (View Table + CSV ถูกเอาออก), ข้อใหม่ PAIR-15, PAIR-16, PAIR-17 · **อัปเดต 2026-10-09 รอบแก้ตาม code review** — EDT-5 ได้ id ใหม่ (EDT-53), EDT-43 ปรับข้อความ (id เดิม), ข้อใหม่ HL-12, FIL-8, BMW-101, VIS-16 · id ซ้ำ: เดิมมี **SPC-30 สองข้อ** — ข้อหลัง (ชิป Referenced sensors) เปลี่ยนเป็น **SPC-32** (ไม่นับเป็นข้อที่ตัดออก เพราะไม่ได้เปลี่ยนความหมาย; ผล SPC-30 ที่เคยกรอกไว้อาจเป็นของข้อไหนก็ได้ ให้ตรวจทั้ง SPC-30 และ SPC-32 ใหม่) · EDT-4 / LINE-3 ไม่ได้ซ้ำ (EDT-4b / LINE-3b เป็นคนละ id) · **อัปเดต 2026-10-09 (customer items 3+4: ชื่อ sensor / ตัวเลือก sensor / ตัวเลือกสีแบบเดียวทั้งแอป)** — SEL-1/4, FIL-5, HL-1/5/6, LINE-2, SCAT-3, PAIR-5, BMW-9/13/14 ได้ id ใหม่ และข้อใหม่ FIL-7, LINE-11, SCAT-11, PAIR-12, SEN-22, FG-15, BMW-99/100, SPC-31, MNG-26, EDT-52, VIS-15 · เขียนไว้ 2026-09-07 หลังทำ Manage Special Sensors (ลบ + แก้ไข) เสร็จ · อัปเดต 2026-09-09 (rename special sensor, บังคับกรอกครบ 4 ช่อง, Group by Model Type, ย้ายปุ่ม Build Model) · **อัปเดต 2026-09-21 ให้ตรงกับ v0.5.0** — เพิ่มหมวด MULTI (หลายโปรเจกต์) และ VIS (กวาดหน้าตาหลังล้าง CSS), เปลี่ยนเมนู Zoom, Running Condition Filter, ปุ่ม Finish, ช่อง predictor แบบค้นหา/จัดกลุ่ม, Component เป็น dropdown, และ**ตัดข้อของฟีเจอร์ที่ถูกเอาออก** (Preview / Save Model / Confirm Save / Report PNG / Saving overlay / แถบเลื่อน dataZoom) · **อัปเดต 2026-09-23** — Running Condition Filter เพิ่ม AND/OR (BMW-11) และ per-model Workspace/Custom override (PM-21 ใหม่) · **อัปเดต 2026-09-24 (Feature 4 Phase 2)** — Build Model / Failure Groups จัดเป็น**หนึ่งแถวต่อ sensor** และ Category ตั้งที่หัว sensor ครั้งเดียว (BMW-3 → BMW-15, BMW-12 → BMW-16, BMW-7 → BMW-17, FG-3 → FG-8 และข้อใหม่ BMW-19/20/21/22, FG-9) · **อัปเดต 2026-09-24 (Feature 4 Phase 3)** — Running Condition บังคับตั้งก่อน Build/Finish (BMW-11 → BMW-18, PM-14 → PM-22, ขยาย BMW-17 และข้อใหม่ BMW-23/24, PM-23) · **อัปเดต 2026-09-24 (Feature 4 Phase 4)** — Training time เป็น**หลายช่วงเวลา (periods)** แทน Time start/end ช่วงเดียว (PM-8 → PM-26, PM-21 → PM-27, ข้อใหม่ BMW-25, PER-10; BMW-18/PM-18/PER-9 ปรับข้อความ) · **อัปเดต 2026-09-24 (แก้บั๊ก QA)** — เพิ่ม FG-10, BMW-26, PM-28/29/30 · **อัปเดต 2026-09-24 (ปรับหน้าตาให้ตรงมอคอัปที่อนุมัติ)** — แผง Running Condition / Training periods / แถว sensor / แท็บ / แบนเนอร์ / ป้าย ปรับข้อความและหน้าตาในข้อ BMW-15/16/18/19/20/21/23/24/25 และ PM-23/26/27/29 (ไม่เพิ่ม id ใหม่ — ความหมายของข้อไม่เปลี่ยน) · **อัปเดต 2026-09-29 (แก้บั๊ก PER)** — เพิ่ม PER-11 (แก้บั๊กค่าที่แก้ใน Running Condition Filter หายเมื่อปิดหน้าต่าง Build Model/PM ทันที) · **อัปเดต 2026-09-29 (Build Model Workbench, Phase A)** — เขียนหมวด BMW ใหม่ทั้งหมดให้ตรงกับ layout ใหม่ (ลิสต์ sensor ซ้าย + detail pane ขวา แทน accordion เดิม): **ตัด BMW-6** (Group by Model Type — ฟีเจอร์นี้ถูกลบออกจากแอปแล้ว), เปลี่ยนความหมาย/ตั้ง id ใหม่ให้ BMW-15→BMW-28, BMW-16→BMW-30, BMW-17→รวมเข้า BMW-42, BMW-18→BMW-34, BMW-19→BMW-31, BMW-20→BMW-32, BMW-23→BMW-33, เพิ่มข้อใหม่ BMW-36/37/38/40/41/42 (ลิสต์ซ้าย ค้นหา/filter/group-by, sidebar toggle, Model settings พับได้, ผลลัพธ์ placeholder, footer ใหม่) — ข้ออื่น (BMW-1/2/4/5/8/9/10/13/14/21/22/24/25/26/27) เนื้อหาเดิม ปรับแค่คำอธิบายตำแหน่ง/ปุ่มให้ตรง UI ใหม่ · **อัปเดต 2026-09-29 (Build Model Workbench, Phase B — Train in place)** — พื้นที่ผลลัพธ์ไม่ใช่ placeholder แล้ว: BMW-41 → BMW-43 (กราฟ+ตัวเลขจริงหลัง Train, ลิสต์ "N items to fix"), BMW-42 → BMW-44 (ป้ายสถานะ 3 แบบ Incomplete/Trained/Complete + ปุ่ม Train/Re-train + Mark complete ต้อง Trained ก่อน), เพิ่มข้อใหม่ BMW-45 (auto-recompute ตอนเปิดโมเดลที่เคย Train ซ้ำ) และ BMW-46 (จุดสถานะที่ป้าย I/R/C ในลิสต์ซ้าย) · **อัปเดต 2026-09-30 (Build Model Workbench, Phase C — จุดสถานะในแท็บ Failure Groups)** — เพิ่มข้อใหม่ FG-13 (จุดสถานะที่มุมป้าย I/R/C ในแท็บ Failure Groups ของ Dashboard — ไม่มีสี/ฟ้า/เขียว ตรงกับหน้า Build Model เป๊ะ รวมถึงกรณี gate บล็อกด้วย) — ปิด Feature 4 (Build Model Workbench) ทั้ง Phase A/B/C ครบตาม SPEC FINAL · **อัปเดต 2026-09-30 (แก้บั๊กจากทดสอบแอปจริงรอบแรก, 4 ข้อ)** — เพิ่ม **PER-12** (ค่าที่แก้ใน Training periods หายเมื่อปิดแค่ popup "Edit…" โดยไม่ blur ก่อน — บั๊กเดิมที่ PER-11 ไม่ครอบ, รายงานซ้ำเป็นครั้งที่ 2) — BMW-28/BMW-40 (Model settings row) ปรับข้อความให้ตรงกับ CSS ที่จัดใหม่ (Model name กว้างขึ้นไม่ตัดคำ, Training data กว้างคงที่ทุกชนิด, ฟิลด์เฉพาะชนิดรวมกลุ่มแยกบรรทัด) ไม่เพิ่ม id ใหม่ · **อัปเดต 2026-09-30 (พอร์ตฟีเจอร์จากหน้า PM เต็มเข้า Workbench รอบสอง)** — เพิ่มข้อใหม่ **BMW-47** (Custom running-condition editor แก้ได้ในหน้า Workbench เอง ผ่านสวิตช์ Training data — เดิมทำไม่ได้ต้องไปหน้า PM เต็ม), **BMW-48** (Cluster ranges เป็นแถบเลื่อนลากได้ตามช่วงค่าจริง แสดงตลอดเวลาแทนที่จะซ่อนจนกว่าจะเลือก criteria sensor), **BMW-49** (แกน X ของกราฟผลลัพธ์ Relation model เลือกได้ทันทีไม่ต้อง Save) — แก้ข้อความ BMW-40 ที่เคยบอกว่า Custom "ยังไม่มีที่แก้ที่นี่" (ไม่จริงแล้ว ดู BMW-47) · **อัปเดต 2026-10-03 (ปุ่ม Apply ใน popup Running Condition Filter)** — popup แก้เป็น "แบบร่าง + กด Apply": แก้อะไรก็ตามในนั้นยังไม่มีผลจนกว่าจะกด **Apply** (ปิดโดยไม่ Apply = ทิ้งแบบร่าง) · เพิ่ม **BMW-50** (Apply / Cancel / ข้อความ "Changes not applied yet" / ถามก่อนทิ้งแบบร่างเมื่อกด X) · PER-11 → **PER-13** และ PER-12 → **PER-14** (ความหมายเปลี่ยน: ต้อง Apply ก่อนค่าจึงถูกบันทึก — id เก่าถูกลบเพื่อไม่ให้ผล pass/fail ที่เคยบันทึกไว้ทำให้เข้าใจผิด) · BMW-25/BMW-34 ปรับขั้นตอนให้ใส่การกด Apply (ไม่เพิ่ม id) · **อัปเดต 2026-10-03 (แผง Failure Group Assignment)** — ตัวเลือก Failure Group ที่เปิดจากปุ่ม 📁 ในแท็บ Sensor เปลี่ยนจาก popup เล็กเป็นแผงสูงเต็มความสูงติดขอบซ้ายของแผง Sensor (ตาราง กลุ่ม × ชนิดโมเดล) และเอาโมเดลออกจากกลุ่มสุดท้ายแล้วมี Undo 7 วินาที: **ตัด SEN-5 ถึง SEN-10** (อธิบาย popup เดิมที่ไม่มีแล้ว) แล้วเพิ่ม **SEN-12 ถึง SEN-21** (เปิดแผง, ตาราง, ติ๊กหลายชนิด, แถวไม่กระโดด/All|Assigned/ค้นหา, สลับ sensor + ‹ ›, สิ่งที่ปิดแผงได้, ลบโมเดลแล้ว Undo — SEN-8 เดิมมาเป็น SEN-18, Undo ข้ามหน้าต่าง Build Model, สร้างกลุ่ม, เปลี่ยนชื่อ/ลบกลุ่ม) — id เดิมที่ความหมายเปลี่ยนจึงไม่ถูกนำกลับมาใช้ · **อัปเดต 2026-10-03 (Running condition ใหม่)** — แถบ "Running condition" บรรทัดเดียวใน Build Model เปลี่ยนเป็นการ์ด "Step 1" 3 สถานะ + แถบขั้นตอนที่หัวหน้าต่าง และ popup Edit… ถูกออกแบบใหม่เป็น 2 คอลัมน์ (ช่วงเวลาเป็นการ์ด P1..Pn, การ์ดเลือก "Only when running" / "Use all rows", ปุ่ม operator, ปุ่ม AND/OR คั่นระหว่างแถว, จำนวนแถวที่ใช้ train แบบสด, ปิดด้วย Esc): **ตัด BMW-34 และ BMW-25** (อธิบายแถบ/หน้าตาเดิมที่ไม่มีแล้ว) แล้วเพิ่ม **BMW-51 ถึง BMW-55** — BMW-50 (ต้องกด Apply), BMW-33, BMW-24, BMW-26 และ PER-9/10/13/14 แก้แค่ชื่อปุ่ม/หัวข้อให้ตรงหน้าตาใหม่ (ความหมายเดิม จึงไม่เปลี่ยน id) · **อัปเดต 2026-10-03 (แก้บั๊ก Add Special Sensor — ค่าไม่ตรง / กราฟปักเกิน)** — คอลัมน์ของ special sensor ที่ลบหรือถูกเปลี่ยนชื่อ ถูกทิ้งจากหน่วยความจำจริงแล้ว (สร้างชื่อเดิมใหม่ไม่ได้ค่าเก่าอีกต่อไป), สร้างแล้ว**ปักเฉพาะตัวใหม่** และไม่ทับสิ่งที่เลือกใน Dashboard, ตรวจชื่อซ้ำที่ช่อง Name, กันกดซ้ำ, ชื่อมีอักขระพิเศษ/ภาษาไทยใช้ในสูตรได้, Sum ว่างเมื่อ source หาย, กู้ workspace ที่มี recipe พังได้อย่างปลอดภัย: **ตัด SPC-8 และ SPC-12** (ความหมายเปลี่ยน — SPC-12 เดิมคือ "ชื่อซ้ำให้จดพฤติกรรม" ตอนนี้ถูกบล็อกแล้ว, SPC-8 เดิมบอกว่ากราฟอัปเดตโดยไม่ระบุว่าปักอะไร) แล้วเพิ่ม **SPC-15 ถึง SPC-21, MNG-16 ถึง MNG-18, EDT-27 ถึง EDT-29, PER-15** (SPC-4 เพิ่มแค่ลิงก์ไป SPC-15) · **อัปเดต 2026-10-03 (Special sensor รอบสอง — แก้ 14 ข้อที่ QA เจอ)** — ฟอร์ม Create ว่างทั้งหมดหลัง Add (SPC-22), ป้าย on chart ตามที่ Dashboard ปักจริง (SPC-23), sensor ที่กำลัง Undo ไม่ถูกเสนอเป็น source (SPC-24), สร้าง/แก้/ลบเป็นคิวทีละงาน (SPC-25, MNG-24), ลบถูกตรวจซ้ำตอนยืนยันจริงรวม Running condition (MNG-19/20/21/22), ลบแล้วเงื่อนไขในแท็บ Filter ของ Dashboard หายตาม (MNG-23), rename ตามไปถึงแท็บ Filter + Running condition (EDT-30), แก้ไม่สำเร็จย้อนกลับ (EDT-31), ลำดับคำนวณตามการพึ่งพา (EDT-32), ตรวจวงกลมสดใหม่ (EDT-33) — **ตัด MNG-10** (ช่อง "PM filter" ถูกยกเลิกไปแล้ว) แทนด้วย **MNG-25** · **อัปเดต 2026-10-03 (ล็อก special sensor ที่โมเดลใช้อยู่)** — sensor ที่โมเดล (ทุกช่อง รวม Custom running condition) หรือ Running condition ของ workspace ใช้อยู่ — รวมถึงโดยอ้อมผ่าน sensor ที่สร้างต่อ — **เปลี่ยนชื่อ / แก้สูตร / แก้ source ไม่ได้ และลบไม่ได้** (แก้ได้แค่ Description / Unit / Component): **ตัด EDT-16, EDT-18, EDT-24, EDT-30** (ความหมายเปลี่ยน — เดิมบอกว่า sensor ที่ถูกใช้ยังแก้ได้ และ rename ตามไปถึงโมเดล / Running condition) แล้วเพิ่ม **EDT-35 ถึง EDT-41** (EDT-2/25 แก้แค่ข้อความอ้างอิง) · **อัปเดต 2026-10-03 (ผูกหน้าต่าง Add Special Sensor กับ dataset + latest-click-wins)** — special sensor ของ A ไม่โผล่/ไม่โดนแตะตอนทำงานใน B แม้หน้าต่างลูกของ A ค้าง (ทุกคำสั่งที่เขียนคอลัมน์ผูกกับ generation ของ dataset, ถูกปฏิเสธเมื่อ dataset เปลี่ยน), หน้าต่างที่ถูกดึงไปโปรเจกต์ใหม่ล้างฟอร์ม/ตัวแก้ไข/งานค้างทั้งหมด, คลิกเปิดโปรเจกต์ซ้อนกัน "คลิกหลังสุดชนะ", ออกจาก Dashboard แล้วบันทึกอัตโนมัติที่ค้างอยู่ทันที — เพิ่ม **MULTI-8 ถึง MULTI-13** (ไม่ตัด id ใดเลย) · **อัปเดต 2026-10-03 (Visual refresh)** — เพิ่ม **VIS-4 ถึง VIS-14** (popover ไม่ปิดเอง/ไม่ล้นจอ/ไม่ลอยค้าง, แถบ Time range แถวเดียว, แท็บ Filter/Highlights/Sensor/Failure Groups หน้าตาใหม่, สีกราฟ Build Model/PM โทนเดียวกับ Dashboard, หน้าต่าง Add Special Sensor หน้าตาใหม่) — ไม่ตัด id ใดเลย · **อัปเดต 2026-10-04 (Health score 3b-1 — Workbench 2 หน้า ต่อ model: Model fit + Health score)** — หัวหน้าต่างเป็นแถบขั้นตอน 5 ขั้นที่กดได้ (Running condition → Model settings → Train → Health set points → Complete), มีสวิตช์ "Model fit | Health score" ที่หัว detail pane (หน้า Health score ยังเป็นกรอบว่างไว้ก่อน — มาในเฟสถัดไป), แถบเตือน stale + ฟิล์ม "Out of date" บนกราฟ, จุดสถานะ 3 สี (เหลือง/แดง/เขียว) + legend, กราฟของหน้า Model fit เป็นกราฟใหม่ทั้งหมดที่ดึงจากข้อมูลย่อของ Rust (Individual: ค่าตามเวลา + Distribution ใหม่ + การ์ดสถิติ; Relation model: แถบสถิติ + Fit + Target vs predicted + Residual เต็มกว้าง ไม่มี distribution ของ residual; Clustering: scatter + วง SD ทุก cluster + การ์ดสรุป), ทุกกราฟมีปุ่มขยาย, "Compare predictors" เปิด Sub-models เป็น modal, โมเดล Complete เห็นกราฟเมื่อเปิดซ้ำ, และแก้บั๊ก detail pane หดหายเมื่อซ่อนลิสต์ซ้าย: **ตัด BMW-38, BMW-43, BMW-45, BMW-46, BMW-49, BMW-51** (ความหมายเปลี่ยน) แล้วเพิ่ม **BMW-56 ถึง BMW-68** — BMW-56 คือบรรทัด Running condition เดิม (BMW-51) ที่ตัดส่วนแถบขั้นตอนออก · **อัปเดต 2026-10-04 (Health score 3b-2)** — หน้า "Health score" เป็นหน้าจริงแล้ว: **ตัด BMW-58 และ BMW-44** (หน้า placeholder / Mark complete ที่ footer หน้า Model fit — ความหมายเปลี่ยน) แล้วเพิ่ม **BMW-69 ถึง BMW-79** (สวิตช์ 2 หน้า, set point ของ Individual/Relation model/Clustering, Checks, กราฟคะแนน + ซิงก์เมาส์, Mark complete เขียนไฟล์จริง, Mark incomplete + "Changed after saving", การบันทึก set point/ปิดหน้าต่าง, ป้าย "Set points needed"/"Fix set point", Finish ของหน้า PM) และแก้ข้อความ FG-13, BMW-4, BMW-30, BMW-33, BMW-56 ที่อ้างปุ่ม Mark complete เดิม · **อัปเดต 2026-10-04 (Health score เฟส 4 — ตัดหน้าเต็ม)** — ถอดหน้า Predictive Model (ปุ่ม "Open full view ↗", ปุ่ม Finish, Back, Sub-models บนหน้านั้น) ออกจากแอปทั้งหมด: **ตัดทั้งหมวด PM (22 ข้อ), BMW-8, BMW-10, BMW-79, VIS-12** แล้วเพิ่ม **BMW-83** (ไม่มีทางเปิดหน้า full view แล้ว) กับ **BMW-84** (ทุกโมเดลเข้าถึงและ Complete ได้จากสองหน้าของ Workbench เท่านั้น) และแก้ข้อความของ BMW-27, BMW-30, BMW-33, BMW-40, BMW-47, BMW-50, BMW-53, BMW-54, BMW-56, BMW-57, BMW-66, BMW-69, PER-9, PER-10, PER-13, VIS-1 ที่อ้างปุ่ม/หน้านั้น — Sub-models เหลือเป็น modal ใน Workbench เท่านั้น (BMW-66) · **อัปเดต 2026-10-04 (เก็บกวาด id หลัง QA)** — FG-13 → **FG-14** และ BMW-80 → **BMW-85** (ความหมายเปลี่ยนแต่เคยใช้ id เดิมซ้ำ — id เก่าถูกเพิ่มเข้ารายการที่ตัดแล้ว), ย้ายป้าย 🆕 ของ FG-14/BMW-85/BMW-81/BMW-82 ออกมาหลัง `**` ให้ตัวสร้าง HTML อ่านป้ายได้, และเติม id ที่เคยถูกตัดแต่ตกหล่นจากรายการ (BMW-3/7/12/78, FG-3/11, MNG-10, PER-11/12, SPC-8/12, EDT-16/18/24/30) · **อัปเดต 2026-10-04 (หน้าแรก "Get started" ใหม่ — Import เฟส B)** — step 0 ของหน้า Import เปลี่ยนเป็น 2 คอลัมน์: ซ้ายคือแบรนด์ + headline + ปุ่ม **New project** (Ctrl+N) + ช่องค้นหา + การ์ด Recent projects (hover/โฟกัสแล้วมี Rename / Delete, ลบยืนยัน**ในแถว**แทนหน้าต่าง dialog), ขวาคือภาพเครื่องจักรจากกลุ่มจุดที่เปลี่ยนรูปไปเรื่อย ๆ, ท้ายหน้ามีเวอร์ชันแอป + "Data stays on this machine": **ตัด IMP-1 และ IMP-21** (ความหมายเปลี่ยน) แล้วเพิ่ม **IMP-22 ถึง IMP-29** (IMP-22 คือ IMP-21 เดิมที่ปรับเป็นยืนยันในแถว) — IMP-2/IMP-18 แก้แค่คำอธิบายตำแหน่ง/วิธีกด (ความหมายเดิม จึงไม่เปลี่ยน id) · step 1–2 ยังเป็นหน้าเดิม (sidebar เดิม) จนกว่าเฟสถัดไป · **อัปเดต 2026-10-04 (Import เฟส C — step 1–2 ใหม่)** — sidebar "Find workspace / Recent" ของ step 1–2 ถูกแทนด้วยแถบขั้นตอนทางซ้าย (rail) · Step 1 "Name your project" (ตัวนับ /80, เตือนชื่อซ้ำแบบไม่บล็อก, การ์ดตัวอย่าง, การ์ด Next) · Step 2 "Add your sensor data" (ซ้าย "Sensor data": dropzone + ชิปเงื่อนไข, แถบความคืบหน้าตอนอ่าน, การ์ดสรุป Rows/Sensors/Period/Interval/% empty, Time coverage, กล่อง "Fixed while reading" · ขวา "Tag names" ที่เดิมชื่อ Sensor mapping) · ปุ่ม Continue ของ step 2 เปลี่ยนเป็น "Open Dashboard": **ตัด IMP-6, IMP-7, IMP-8, IMP-9, IMP-10, IMP-11, IMP-12** (ความหมายเปลี่ยน) แล้วเพิ่ม **IMP-30 ถึง IMP-39** — IMP-14/16/17/18/19/22 และ VIS-1/VIS-3 แก้แค่ชื่อปุ่ม/หัวข้อให้ตรง UI ใหม่ (ความหมายเดิม จึงไม่เปลี่ยน id) · **อัปเดต 2026-10-07 (Train/Test model validation)** — ช่วงเวลาแบ่งเป็น **Train periods** (บังคับต้องมีอย่างน้อย 1 ช่วง ไม่มีช่วง = ไม่ใช่ "ทั้งชุดข้อมูล" อีกต่อไป) กับ **Test periods** (Normal / Known problem + event time, ต้องมีอย่างน้อย 1 ช่วงก่อน Mark complete) · ผลทดสอบเป็นข้อมูลเท่านั้น (เขียว/เหลือง ไม่บล็อก): **ตัด BMW-47, BMW-53, BMW-56** (ความหมายเปลี่ยน) แล้วเพิ่ม **BMW-86 ถึง BMW-92** · **อัปเดต 2026-10-07 (แก้ตาม code review)** — เพิ่ม **BMW-93** (Custom: Test period ผิด = Save ไม่ได้, Mark complete ตอนมีค่าที่ยังไม่ Save บันทึกให้ก่อน, เตือน Train < 30 วันของ Custom) และ **BMW-94** (Relation model: Train คำนวณ Test ไปด้วย, ข้อความรอ ~15 วินาที, ให้คะแนน Test ไม่ได้ = กล่องเหลือง) · **อัปเดต 2026-10-07 (code review รอบ 3)** — เพิ่ม **BMW-95** (จำความล้มเหลว, Try again, engine เก่าไม่มีปุ่ม Try again, ช่วงใหญ่เกิน) · BMW-94 ย้ายกรณี engine เก่าไปที่ BMW-95 (ข้อใหม่วันเดียวกัน ยังไม่มีผลทดสอบ จึงไม่เปลี่ยน id) · BMW-88 ชิป "No train period" เปลี่ยนจากแดงเป็นเหลือง และ BMW-139 ข้อความเวลาของ Relation model (แก้ข้อความในข้อเดิม ความหมายไม่เปลี่ยน จึงไม่เปลี่ยน id) · **อัปเดต 2026-10-08 (คำขอลูกค้า)** — เอาสวิตช์ Band / Line colour ในแท็บ Highlights ออก (highlight แบบ By time บนกราฟ Line เป็นแถบเสมอ): **ตัด HL-4** แล้วเพิ่ม **HL-8** (ไม่มีสวิตช์แล้ว + workspace เก่าที่เคยตั้ง Line colour เปิดแล้วเป็นแถบ) · ลบ tag ทีละอันได้: เพิ่ม **LINE-9** และ **SCAT-9** (รายการ tag ใต้แถบเครื่องมือ มีปุ่ม × ต่ออัน) · VIS-8 ตัดประโยคเรื่องสวิตช์ Band / Line colour ออก (ความหมายของข้อไม่เปลี่ยน จึงไม่เปลี่ยน id) · **อัปเดต 2026-10-08 (แก้บั๊ก special sensor จาก QA)** — สูตรที่ไม่ผ่านการตรวจขึ้นสีแดงใต้ช่องสูตรและกด Add/Save ไม่ได้ (SPC-26, EDT-13 → EDT-42), เปลี่ยน source แล้ว Average/Sum/Median ไม่กลายเป็นผลบวก (SPC-29, EDT-43), Formula Syntax Help (SPC-27), ปัดทศนิยมแบบ "Then apply" (SPC-28), ชิป Referenced sensors (SPC-30), Rust ปฏิเสธฟังก์ชันที่ไม่รู้จัก (EDT-44), รายการ Manage บอกจำนวนทศนิยม (EDT-45), เปิด workspace เก่าที่มีสูตรซึ่งตอนนี้ไม่ผ่าน (EDT-46)
>
> **ต้องทดสอบบน installer ที่ติดตั้งแล้ว ไม่ใช่ `npm run tauri dev`** — CSP และ path ของ Python sidecar เป็นคนละกลไกกันระหว่าง dev กับ build จริง บั๊กหลายตัวที่เจอมาเห็นเฉพาะในตัวติดตั้ง
>
> ผลที่กรอกไว้ในไฟล์ HTML เก็บตาม id ของแต่ละข้อ — ข้อที่ **เปลี่ยนความหมายมากจึงตั้ง id ใหม่ / ตัดออก** (ตัดทั้งหมวด PM: PM-1, PM-3, PM-4, PM-5, PM-6, PM-7, PM-26, PM-18, PM-11b, PM-12, PM-13, PM-22, PM-23, PM-15, PM-16, PM-17, PM-19, PM-20, PM-27, PM-28, PM-29, PM-30, BMW-8, BMW-10, BMW-79, VIS-12 — เฟส 4 ถอดหน้า Predictive Model + Open full view + Finish ออก · PM-2, PM-9, PM-10, PM-10b, PM-11, PM-11c, BMW-11, PM-14, PM-8, PM-21, BMW-6, BMW-15, BMW-16, BMW-17, BMW-18, BMW-19, BMW-20, BMW-23, BMW-41, BMW-42, BMW-25, BMW-34, BMW-38, BMW-43, BMW-45, BMW-46, BMW-49, BMW-51, BMW-58, BMW-44, SEN-5, SEN-6, SEN-7, SEN-8, SEN-9, SEN-10, BMW-3, BMW-7, BMW-12, BMW-78, BMW-80 (ความหมายเปลี่ยน — ตอนนี้คือ BMW-85 → BMW-133), FG-3, FG-11, FG-13 (ความหมายเปลี่ยน — ตอนนี้คือ FG-14), IMP-13 (ตัดออก: ไม่เคยมี UI จับคู่ tag ด้วยมือ), IMP-3 (ความหมายเปลี่ยน — ตอนนี้คือ IMP-22: ลบโปรเจกต์ต้องกดยืนยันในแถวก่อน), IMP-1 (ความหมายเปลี่ยน — ตอนนี้คือ IMP-23: หน้าแรกแบบใหม่), IMP-21 (ความหมายเปลี่ยน — ตอนนี้คือ IMP-22: เดิมเป็นหน้าต่าง dialog ยืนยัน ตอนนี้ยืนยันในแถว), IMP-6 (ตอนนี้คือ IMP-30: Step 1 "Name your project"), IMP-7 (ตอนนี้คือ IMP-31: เตือนชื่อซ้ำแบบไม่บล็อก), IMP-8 (ตอนนี้คือ IMP-33 → IMP-45: แถบขั้นตอนทางซ้าย), IMP-9 (ตอนนี้คือ IMP-34: step 2 ใหม่), IMP-10 (ตอนนี้คือ IMP-37: merge หลายไฟล์ + Time coverage), IMP-11 (ตอนนี้คือ IMP-36: การ์ดสรุป), IMP-12 (ตอนนี้คือ IMP-38: Tag names), MNG-10, PER-11, PER-12, SPC-8, SPC-12, EDT-16, EDT-18, EDT-24, EDT-30, BMW-47 (ตอนนี้คือ BMW-89 → BMW-194: Custom มีช่วง Train/Test ของตัวเอง + ข้อความ Copied ใหม่), BMW-53 (ตอนนี้คือ BMW-86 → BMW-185: ไม่มีช่วงเวลา = ไม่ใช่ "ทั้งชุดข้อมูล" อีกต่อไป ต้องมี train period), BMW-56 (ตอนนี้คือ BMW-88 → BMW-188: บรรทัด Running condition มีแถว Train/Test และแถบ 2 ชั้น), SEL-1, SEL-4, FIL-5, HL-1, HL-5, HL-6, LINE-2, SCAT-3, PAIR-5, BMW-9, BMW-13, BMW-14 (2026-10-09 customer items 3+4: ชื่อ sensor / ตัวเลือก sensor / ตัวเลือกสีแบบเดียวทั้งแอป — ตอนนี้คือ SEL-9, SEL-10, FIL-6, HL-9, HL-10, HL-11, LINE-10, SCAT-10, PAIR-11 → PAIR-13, BMW-96, BMW-97, BMW-98 → BMW-116), EDT-5 (ตอนนี้คือ EDT-53 → EDT-55: เลือก source sensor ผ่านหน้าต่างเลือก sensor แทน dropdown), PAIR-6, PAIR-7 (ตัดออก 2026-10-09 customer batch phase 2: View Table / ตาราง brushed rows / CSV ของ Pair Plot ถูกเอาออก), PAIR-11, PAIR-9 (2026-10-09 customer batch phase 2 — ตอนนี้คือ PAIR-13: ลบ/เปลี่ยนสีจากชิปเหนือตาราง ไม่มีแผงและตัวเลขแถวแล้ว, PAIR-14: ปุ่ม ↺ แค่รีเซ็ตมุมมอง cluster ยังอยู่), BMW-57 (ตอนนี้คือ BMW-114 → BMW-129: แถบขั้นตอน 5 ขั้นที่หัวหน้าต่าง Build Model ถูกถอดออก 2026-10-09), BMW-85 (ตอนนี้คือ BMW-115 → BMW-133: ไม่มีขั้น "Health set points" ให้ดูแล้ว), BMW-98 (ตอนนี้คือ BMW-116: Criteria sensor ล้างค่าได้ + ปุ่ม × และล้างแล้วเหลือ 1 cluster), BMW-48 (ตอนนี้คือ BMW-117: พิมพ์ค่าเส้นแบ่ง cluster ได้), BMW-87, BMW-88, BMW-89, BMW-90, BMW-91, BMW-92, BMW-93 (2026-10-10 Scoring periods "just score it" — ไม่มี Normal / Known problem, event time, ผลตัดสินเขียว/เหลือง, From Highlights แล้ว: ตอนนี้คือ BMW-121 → BMW-186, BMW-122 → BMW-188, BMW-123 → BMW-194, BMW-124 → BMW-152, BMW-125, BMW-126 → BMW-143 → BMW-211, BMW-127), BMW-63, BMW-64, BMW-65, BMW-67, BMW-71, BMW-72, BMW-124 (2026-10-10 Workbench redesign ส่วนกราฟ — ชื่อช่วงเหนือกราฟ ชื่อเส้นที่ขอบขวา ไม่มี legend: ตอนนี้คือ BMW-145, BMW-146, BMW-147 → BMW-164, BMW-148, BMW-150 → BMW-155, BMW-151 → BMW-156, BMW-152), BMW-147 (2026-10-10 แก้ตามผลรีวิวกราฟ — Target vs predicted ใช้แถวสีกำกับใต้กราฟแทนชื่อที่ปลายเส้น: ตอนนี้คือ BMW-164), BMW-171, BMW-173, BMW-175, BMW-176, BMW-177, BMW-130 (2026-10-10 แก้ตามผลรีวิว popup Running condition — วันที่ที่พิมพ์เข้าแบบร่างทันที ไม่ต้องคลิกออก และบรรทัด Running condition นับแถวแบบเดียวกับ popup: ตอนนี้คือ BMW-183, BMW-184, BMW-185, BMW-186, BMW-187 → BMW-194, BMW-188 · BMW-187 → BMW-194 เมื่อ 2026-10-10: ช่วง Train ของโมเดลเองที่ผิดก็กัน Save changes แล้ว · BMW-190 → BMW-196, BMW-191 → BMW-197, BMW-192 → BMW-198 เมื่อ 2026-10-10: ช่วงที่บันทึกไว้อยู่นอกข้อมูลเป็นแค่คำเตือน ไม่กันและไม่เอาผลของโมเดลออก)) ถ้าเคยกรอกผลรอบก่อนไว้ให้กด "ล้างผลทั้งหมด" ก่อนเริ่มรอบนี้, BMW-198 (ตอนนี้คือ BMW-200 → BMW-201: กรณี C — โมเดลที่มีผลอยู่แล้วแต่ไฟล์ข้อมูลไม่มีแถวให้คำนวณ กราฟวาดไม่ได้ สถานะที่บันทึกไว้ไม่เปลี่ยน), BMW-200 (ตอนนี้คือ BMW-201 เมื่อ 2026-10-11: กรณี C ขึ้นกล่อง "No data for this model in the loaded file" แทน "Couldn't load…" / "Training failed" ป้ายยังเป็น Complete / Trained และหน้า Health score เปิดได้), BMW-74 (ตอนนี้คือ BMW-210 เมื่อ 2026-10-11: หัวกราฟ Health score นับเป็นชั่วโมง และบรรทัดอ่านค่าเป็น "1 h avg"), BMW-143 (ตอนนี้คือ BMW-211: Scoring results นับเป็น "running hours" / "(1 h average)"), BMW-163 (ตอนนี้คือ BMW-212: เวลาบนหน้า Health score เป็นต้นชั่วโมง ไม่มีวินาที)
>
> เครื่องหมาย: 🆕 = ของที่เพิ่งทำ ยังไม่เคยมีคนกดจริง · 👀 = บั๊กที่เพิ่งแก้ หรือรายงานที่ยังไม่เคยตามไปดู · 🐍 = path เดียวที่เรียก Python sidecar

## สารบัญ

- [PREP — เตรียมก่อนเริ่ม](#prep) (5 ข้อ)
- [APP — เปิดโปรแกรม & โครงหน้าต่าง](#app) (6 ข้อ)
- [IMP — หน้า Import (3 ขั้น + Failure groups)](#imp) (37 ข้อ)
- [LAY — โครง Dashboard](#lay) (5 ข้อ)
- [SEN — แผง Sensor](#sen) (17 ข้อ)
- [SEL — แท็บ Selected Sensor](#sel) (8 ข้อ)
- [FIL — แท็บ Filter](#fil) (7 ข้อ)
- [HL — แท็บ Highlights](#hl) (8 ข้อ)
- [TIME — ช่วงเวลา & Aggregation](#time) (8 ข้อ)
- [LINE — Line chart](#line) (14 ข้อ)
- [SCAT — Scatter plot](#scat) (10 ข้อ)
- [PAIR — Pair Plot](#pair) (14 ข้อ)
- [SPC — Add Special Sensor — แท็บ Create](#spc) (35 ข้อ)
- [MNG — Manage — ลบ special sensor](#mng) (27 ข้อ)
- [EDT — Manage — แก้ไข special sensor](#edt) (44 ข้อ)
- [FG — แท็บ Failure Groups](#fg) (14 ข้อ)
- [BMW — หน้าต่าง Build Model](#bmw) (108 ข้อ)
- [MULTI — เปิดมากกว่า 1 โปรเจกต์ (ข้อมูลต้องไม่ปนกัน)](#multi) (14 ข้อ)
- [PER — ปิดเปิดโปรแกรม & การบันทึก](#per) (14 ข้อ)
- [ERR — ความผิดพลาด & ขอบ](#err) (6 ข้อ)
- [PERF — ประสิทธิภาพ](#perf) (6 ข้อ)
- [VIS — กวาดหน้าตา (หลังล้าง CSS ที่ไม่ได้ใช้ และลบโค้ดตาย)](#vis) (15 ข้อ)

---

## PREP

### เตรียมก่อนเริ่ม

_ทำให้ครบก่อน ไม่งั้นข้อหลัง ๆ จะทดสอบไม่ได้จริง_

- [ ] **PREP-1 — Build installer จาก commit ล่าสุด**
  - `npm run installer:win`
  - ดูว่าไฟล์ที่ได้ชื่อ `Wizard_0.5.0_x64-setup.exe` (หรือเวอร์ชันที่ bump ใหม่) ที่ `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`
  - **คาดหวัง:** build ผ่านไม่มี error — ถ้าจะ bump version ต้องแก้ให้ตรงกัน 4 ที่ (package.json / package-lock.json / Cargo.toml / tauri.conf.json) และเขียน section ใหม่ใน `docs/release/CHANGELOG.md` ก่อน build ทุกครั้ง แล้วติด tag `vX.Y.Z` หลัง build สำเร็จ

- [ ] **PREP-2 — ถอนตัวเก่าออกก่อนแล้วติดตั้งใหม่**
  - ถอนการติดตั้ง Wizard ตัวเดิมออกจาก Windows
  - ติดตั้งตัวใหม่
  - เปิดโปรแกรม
  - **คาดหวัง:** เปิดขึ้นมาได้ ไม่มีจอดำ ไม่มี error dialog — **ต้องทดสอบบน installer ไม่ใช่ `npm run tauri dev`** เพราะ CSP กับ path ของ Python sidecar ต่างกันคนละกลไก

- [ ] **PREP-3 — workspace เดิมยังอยู่ครบหลังติดตั้งทับ**
  - ดูรายการ Recent projects ที่หน้าแรก
  - **คาดหวัง:** workspace เก่าอยู่ครบ — identifier `com.prompt-solution.tauri-app` ใน tauri.conf.json คือสิ่งที่กำหนด path ของ $APPDATA ถ้าหายแปลว่ามีคนไปแก้

- [ ] **PREP-4 — เตรียมไฟล์ทดสอบให้ครบ 5 แบบ**
  - CSV ข้อมูลขนาดปกติ (ไม่กี่ MB)
  - CSV ข้อมูลขนาดใหญ่จริง (หลายร้อย MB ขึ้นไป)
  - CSV หลายไฟล์ที่ต้อง merge กัน
  - CSV mapping ที่มีคอลัมน์ ALARM_L / ALARM_LL / ALARM_H / ALARM_HH
  - ไฟล์เสีย: ไม่มีคอลัมน์ timestamp / timestamp format แปลก / ไฟล์ว่าง
  - **คาดหวัง:** มีครบทั้ง 5 แบบวางไว้ที่เดียวกัน

- [ ] **PREP-5 — เตรียม workspace 2 โปรเจกต์ที่ข้อมูลต่างกันชัดเจน (สำหรับหมวด MULTI)** 🆕
  - สร้างโปรเจกต์ A และ B จาก CSV คนละชุด ให้ชื่อ sensor / component ของสองโปรเจกต์ต่างกันให้เห็นชัด (ถ้าใช้ mapping ก็ให้ description ต่างกัน)
  - ใน A สร้าง special sensor อย่างน้อย 1 ตัว (ตั้ง Component และ Description เฉพาะตัว) และสร้าง Failure Group + โมเดลอย่างน้อย 2 ตัว
  - ใน B สร้าง Failure Group + โมเดลคนละชุด (ชื่อกลุ่มไม่ซ้ำกับ A)
  - **คาดหวัง:** มี 2 โปรเจกต์ที่แยกออกได้ทันทีด้วยตาว่าอันไหนเป็นของโปรเจกต์ไหน — **เคยพลาดเพราะทดสอบด้วยโปรเจกต์เดียวมาตลอด บั๊กข้อมูลปนกันจึงไม่เคยโผล่**

---

## APP

### เปิดโปรแกรม & โครงหน้าต่าง

- [ ] **APP-1 — เปิดโปรแกรมแล้วเข้าหน้า Import เสมอ**
  - เปิดโปรแกรม
  - **คาดหวัง:** เข้าหน้า Import ทุกครั้ง ไม่ auto-resume workspace ล่าสุด (เป็นพฤติกรรมที่ตั้งใจ)

- [ ] **APP-2 — Title bar — ปุ่มหน้าต่าง**
  - กด minimize / maximize / close
  - ลากแถบบนย้ายหน้าต่าง
  - double-click แถบบน
  - **คาดหวัง:** ครบทุกปุ่มทำงาน, ลากย้ายได้, double-click = maximize/restore (หน้าต่างนี้ decorations ปิด ใช้ title bar ที่เขียนเอง)

- [ ] **APP-3 — เมนู File**
  - File → New Workspace (หรือ Ctrl+N)
  - File → Close Workspace
  - File → Rename Workspace
  - File → Quit
  - **คาดหวัง:** New/Close พากลับหน้า Import, Rename เปิดช่องแก้ชื่อที่ title bar, Quit ปิดโปรแกรม — Rename/Close ควรใช้ไม่ได้ตอนยังไม่เปิด workspace

- [ ] **APP-4 — Help → About Wizard**
  - เปิด About
  - **คาดหวัง:** เลขเวอร์ชันตรงกับ installer ที่เพิ่งติดตั้ง (อ่านจาก `getVersion()` ตอน runtime ไม่ได้ hardcode)

- [ ] **APP-5 — เมนู Edit ใช้ได้ในช่องกรอกข้อความ**
  - คลิกช่องกรอกชื่อโปรเจกต์
  - Ctrl+C / Ctrl+V / Ctrl+A / undo
  - **คาดหวัง:** copy-paste ทำงานปกติ

- [ ] **APP-6 — ย่อ/ขยายหน้าต่างแล้ว layout ไม่พัง**
  - ย่อหน้าต่างให้เล็กสุด
  - ขยายเต็มจอ
  - ลากปรับขนาดช้า ๆ
  - **คาดหวัง:** กราฟ resize ตาม ไม่มีแถบเลื่อนแนวนอนโผล่ ไม่มีแผงซ้อนทับกัน

---

## IMP

### หน้า Import (3 ขั้น)

_Step 0 = หน้าแรก "Get started" (สร้างโปรเจกต์ใหม่หรือเปิดของเดิม) · Step 1 = "Name your project" · Step 2 = "Add your sensor data" (ซ้าย "Sensor data" · ขวา "Tag names") · **Step 3 = "Which failures should Wizard look for?" (ตั้งชื่อ Failure groups, ข้ามได้ — customer batch 2026-10 item 5)** · step 1–3 มีแถบขั้นตอน (rail) 4 ขั้นทางซ้ายแทน sidebar "Find workspace / Recent" เดิม_

- [ ] **IMP-2 — รายการ Recent projects**
  - ดูชื่อ / เวลาที่แก้ล่าสุด (เช่น "2 h ago", "3 d ago", ถ้าเกิน 30 วันเป็นวันที่) / ลำดับ
  - **คาดหวัง:** เรียงตัวที่แก้ล่าสุดขึ้นก่อน ชื่อและเวลาตรงกับที่เพิ่งทำจริง — โปรเจกต์ที่ไม่มี description ต้องไม่มีบรรทัดว่างหรือคำว่า undefined

- [ ] **IMP-22 — ลบโปรเจกต์: ยืนยันในแถว (ไม่มีหน้าต่าง dialog) และลบไฟล์ model ที่ export ไว้ด้วย (2026-10-04)** 🆕
  - เอาเมาส์ชี้การ์ดของโปรเจกต์ที่ไม่ใช้แล้ว (ถ้าอยากเช็กไฟล์ ให้เป็นโปรเจกต์ที่เคย Mark complete model ไว้ แล้วดูโฟลเดอร์ `workspaces/<id>/output` ใน app data ก่อน) → กดไอคอนถังขยะ
  - **คาดหวัง (1):** ในแถวนั้นขึ้น "Delete this project?" พร้อมปุ่ม **Delete** และ **Cancel** (ไม่มีหน้าต่างแยกเด้งขึ้นมา) · ปุ่ม Rename/ถังขยะหายระหว่างถามอยู่ · กดที่ตัวการ์ดตอนกำลังถามอยู่ต้อง**ไม่**เปิดโปรเจกต์
  - กด **Cancel** (ลองอีกรอบแล้วกด **Esc** แทน)
  - **คาดหวัง (2):** ไม่มีอะไรเปลี่ยน โปรเจกต์ยังอยู่ ไฟล์ยังอยู่
  - กดถังขยะอีกครั้ง → กด **Delete**
  - **คาดหวัง:** หายจากรายการทันที, ไม่ลบตัวอื่นพลาด, และโฟลเดอร์ `workspaces/<id>/output` ของโปรเจกต์นั้นหายไปด้วย (ตัวอื่นยังอยู่)

- [ ] **IMP-23 — หน้าแรก (step 0) หน้าตาใหม่** 🆕
  - เปิดโปรแกรมใหม่ ๆ ดูหน้าแรก
  - **คาดหวัง:** 2 คอลัมน์ — ซ้าย: "Wizard · Machine health studio", "OFFLINE SENSOR DATA → MACHINE BEHAVIOUR", หัวข้อ "Abnormal behaviour, found in your history." (ครึ่งหลังเป็นสีไล่ระดับ, หน้าต่างกว้าง ~1,220 px หรือแคบกว่ายังขึ้น 2 บรรทัด), คำอธิบาย "Import the CSVs you already have, … all on this computer.", ไม่มีคำว่า predict / "before it happens" ที่ไหนเลย, ปุ่มใหญ่ **New project** พร้อมป้าย Ctrl+N, ช่อง Find project, การ์ด Recent projects · ขวา: ภาพเครื่องจักร · ท้ายหน้า: เลขเวอร์ชันแอป (ตรงกับเวอร์ชันที่ติดตั้ง) + "Data stays on this machine" · ไม่มี sidebar รายการ workspace ซ้ำอีกชุด และไม่มีแถบ "Pick an option above…" · กด **New project** แล้วไป step 1 (ตั้งชื่อโปรเจกต์) · ย่อ/ขยายหน้าต่างแล้วเลย์เอาต์ไม่พัง (รายการ Recent เลื่อนได้ในตัวเอง)

- [ ] **IMP-24 — ภาพเครื่องจักรที่หน้าแรก (ตรวจด้วยตา)** 🆕
  - ดูภาพฝั่งขวาประมาณ 30–40 วินาที (ไม่ต้องลาก)
  - ไปที่ step 1 แล้วกลับมา step 0 (กด Back)
  - **คาดหวัง:** กลุ่มจุดก่อตัวเป็นเครื่องจักร 6 แบบตามลำดับ (Gas turbine generator → Gas turbine compressor → Motor → Reciprocating pump → Can pump → Turbo expander) ค้างแต่ละแบบสักครู่แล้วสลายแล้วก่อตัวใหม่, กล้องแกว่งช้า ๆ · เครื่องดูละเอียดขึ้น: ขอบ/ตะเข็บ/วงน็อตหน้าแปลนสว่างกว่าผิว, มีครีบมอเตอร์, ท่อไอเสีย, ห้องเผาไหม้รอบ gas turbine, ฐาน skid ใต้ทุกเครื่อง, ล้อสายพานมีซี่ + ลูกสูบ 3 ตัวขยับใน Reciprocating pump · มีป้ายค่า sensor 2 ตัวต่อเครื่อง ตัวหนึ่งค่อย ๆ ขึ้นจนขึ้น **"● ABNORMAL"** สีเหลืองอำพัน (ไม่ใช่ "WATCH") และชื่อ sensor ยาว ๆ เช่น "Exhaust gas temperature" / "Motor NDE bearing temp" **ไม่ทับ** กับป้าย ● ABNORMAL · เส้นโยงจาก sensor ไปจบที่ขอบการ์ดที่ใกล้ที่สุด · แถบล่างมีชื่อเครื่อง + จุดบอกลำดับ + "Illustration · simulated readings" (อ่านออก ไม่จางเกิน) · ภาพลื่นไม่กระตุก · กลับมาที่ step 0 ภาพเริ่มเล่นใหม่ได้ปกติ · ภาพเล็กจาง ๆ ในแถบ step 1–2 ทางซ้ายก็เป็นจุดแบบใหม่ และ **ลากไม่ได้** (ไม่มีเคอร์เซอร์มือ)

- [ ] **IMP-40 — หมุนภาพเครื่องจักรด้วยเมาส์ (ลาก / ปล่อย / ดับเบิลคลิก)** 🆕
  - ชี้เมาส์บนภาพเครื่องจักรที่หน้าแรก → กดค้างแล้วลากซ้าย-ขวา แล้วลากขึ้น-ลง
  - ลากเร็ว ๆ แล้วปล่อยกลางทาง · อีกครั้ง: ลากแล้วหยุดนิ่งสักครู่ก่อนปล่อย
  - ดับเบิลคลิกบนภาพ · หมุนล้อเมาส์บนภาพ
  - **คาดหวัง:** เคอร์เซอร์เป็นรูปมือ (กำมือขณะลาก) · ซ้าย-ขวาหมุนได้รอบตัวไม่มีขีดจำกัด · ขึ้น-ลงเอียงได้ตั้งแต่เกือบมองจากบนลงล่างจนถึงต่ำกว่าแนวพื้นนิดเดียว และไม่พลิกกลับหัว · ระหว่างกดค้าง เครื่องไม่เปลี่ยนเป็นเครื่องถัดไปและการ์ด sensor ยังแสดงอยู่ตามตำแหน่ง sensor ที่หมุนไป · ปล่อยตอนกำลังลากเร็ว → หมุนต่อแล้วค่อย ๆ หยุดในราว ครึ่งวินาที · หยุดนิ่งก่อนปล่อย → ไม่ไหลต่อ · ประมาณ 1.5 วินาทีหลังหยุด ภาพกลับมาแกว่งเองและเปลี่ยนเครื่องต่อ มุมเอียงค่อย ๆ กลับมาที่เดิมในราว 2 วินาที (มุมหมุนซ้าย-ขวาคงไว้) · ดับเบิลคลิก → กลับมุมเริ่มต้นทางที่ใกล้ที่สุด · ล้อเมาส์ **ไม่ซูม** (เลื่อนหน้าตามปกติ) · ปุ่ม New project / รายการ Recent ยังคลิกได้ตามปกติ

- [ ] **IMP-41 — หมุนภาพเครื่องจักรด้วยนิ้ว (จอสัมผัส / ปากกา)** 🆕
  - ใช้เครื่องที่มีจอสัมผัส (ถ้าไม่มีให้ข้าม) ใช้นิ้วเดียวลากบนภาพ แล้วลองใช้ 2 นิ้ว
  - ปัดขึ้น-ลงโดยเริ่มบนภาพ และเริ่มนอกภาพ (ฝั่งรายการ Recent)
  - **คาดหวัง:** นิ้วเดียวหมุน/เอียงเครื่องได้เหมือนเมาส์ · นิ้วที่สองไม่ทำให้ภาพกระโดดหรือซูม · ปัดที่เริ่มบนภาพจะเอียงเครื่องแทนการเลื่อนหน้า (ตั้งใจไว้แบบนี้) · ปัดที่เริ่มนอกภาพเลื่อนหน้าได้ปกติ

- [ ] **IMP-42 — หน้าแรกบนจอ Windows ขยาย 125 % / 150 % และบนโน้ตบุ๊กสำนักงาน** 🆕
  - Settings → System → Display → Scale ตั้ง 125 % แล้ว 150 % เปิดหน้าแรกทั้งสองแบบ (ลองย้ายหน้าต่างข้ามจอที่ scale ต่างกันถ้ามี 2 จอ)
  - บนโน้ตบุ๊กสำนักงานสเปกทั่วไป: เปิด Task Manager แท็บ Processes ดู CPU ของ Wizard (WebView2) ตอนดูหน้าแรกเฉย ๆ 30 วินาที และตอนลากหมุนต่อเนื่อง 10 วินาที
  - **คาดหวัง:** จุดคมพอ ไม่เบลอเป็นก้อน ไม่มีขอบสี่เหลี่ยมโผล่รอบเครื่อง · ป้าย sensor ไม่ล้นการ์ด · หัวข้อยังเป็น 2 บรรทัด · ภาพลื่น (ไม่กระตุกชัดเจน) ทั้งตอนเฉย ๆ และตอนลาก · CPU ไม่สูงกว่าเวอร์ชันก่อน (จดตัวเลขไว้เทียบ ถ้าจำของเดิมได้)

- [ ] **IMP-43 — โหมดลดการเคลื่อนไหว (Reduced motion) กับภาพเครื่องจักร** 🆕
  - Settings → Accessibility → Visual effects → Animation effects **ปิด** แล้วเปิดแอปใหม่ ไปหน้าแรก
  - ลากหมุนภาพ แล้วปล่อย · ดับเบิลคลิก
  - **คาดหวัง:** เป็นภาพนิ่งของเครื่องแรก (Gas turbine generator) ไม่แกว่ง ไม่เปลี่ยนเครื่อง · การ์ด sensor ตัวที่ drift ขึ้น **"● ABNORMAL"** สีอำพันอยู่แล้วในภาพนิ่ง · ลากแล้วภาพหมุนตามมือทันที ปล่อยแล้วหยุดนิ่งทันที (ไม่ไหลต่อ ไม่กลับมาแกว่งเอง) · ดับเบิลคลิกกลับมุมเริ่มต้น · เปิด Animation effects กลับแล้วเปิดแอปใหม่ ภาพกลับมาเคลื่อนไหวปกติ

- [ ] **IMP-44 — ลากภาพเครื่องจักรแล้วการลากถูกขัดกลางทาง (Alt+Tab ขณะกดเมาส์ค้าง)** 🆕
  - หน้าแรก: กดเมาส์ค้างบนภาพเครื่องจักรแล้วลาก ระหว่างที่ยังกดอยู่ให้กด Alt+Tab ไปหน้าต่างอื่น ปล่อยเมาส์ที่หน้าต่างอื่น แล้วกลับมาที่ Wizard
  - เลื่อนเมาส์ผ่านภาพโดยไม่กด แล้วลองลากใหม่ (ถ้ามีจอสัมผัส/ปากกา ทำซ้ำด้วยนิ้ว/ปากกา)
  - **คาดหวัง:** เลื่อนเมาส์ผ่านเฉย ๆ **ภาพไม่หมุนตาม** · ภาพเครื่องจักรกลับมาเปลี่ยนรูปตามรอบปกติ · ลากใหม่ได้ทันที (นิ้ว/ปากกาก็ลากได้ ไม่ค้าง) · ปัดแรง ๆ แล้วปล่อย ภาพหมุนต่อนิดหน่อยแล้วหยุดภายในราว 1 วินาที ไม่หมุนหลายรอบ

- [ ] **IMP-53 — ปุ่ม ‹ › และจุด เลือกดูเครื่องจักรที่หน้าแรก** 🆕
  - หน้าแรก: ที่แถบล่างของภาพเครื่องจักร กดปุ่ม **›** (Next machine) ข้างชื่อเครื่อง · กด **‹** (Previous machine) · กด › เร็ว ๆ 2–3 ครั้งติดกัน
  - กดจุดเล็ก ๆ จุดใดจุดหนึ่ง (เช่น จุดที่ 5) · กดจุดของเครื่องที่แสดงอยู่แล้ว
  - ลากหมุนภาพค้างไว้/เพิ่งปล่อย แล้วกด › · ลากหมุนภาพโดยเริ่มลากจากบริเวณแถบล่าง (ตรงที่ว่าง ไม่ใช่บนปุ่ม)
  - ใช้คีย์บอร์ด: Tab ไปที่ปุ่ม ‹ › และจุด แล้วกด Enter
  - **คาดหวัง:** กด › / ‹ แล้วภาพ**สลายแล้วก่อตัวเป็นเครื่องถัดไป / ก่อนหน้าทันที** ไม่ต้องรอรอบอัตโนมัติ และชื่อในป้าย + จุดที่สว่างเปลี่ยนตาม · จากเครื่องแรกกด ‹ ไปเครื่องสุดท้าย (Turbo expander) และจากเครื่องสุดท้ายกด › กลับเครื่องแรก · กดเร็ว ๆ N ครั้ง = ไป N เครื่อง · กดจุด = ไปเครื่องนั้นตรง ๆ, กดจุดของเครื่องที่แสดงอยู่ไม่มีอะไรเปลี่ยน · การ์ด sensor ที่ขึ้นเป็นของเครื่องที่เลือก · หลังเลือกแล้วรอบอัตโนมัติเดินต่อจากเครื่องนั้น · **ปุ่ม › ไม่ขยับ**เมื่อชื่อเครื่องสั้น/ยาวต่างกัน (ป้ายชื่อกว้างคงที่ ชื่ออยู่กลาง) · hover ปุ่มแล้วสว่างขึ้น, โฟกัสด้วยคีย์บอร์ดเห็นกรอบสีฟ้า · การลากหมุนภาพยังทำได้ตามเดิมแม้เริ่มลากจากที่ว่างของแถบล่าง · โหมดลดการเคลื่อนไหว (ดู IMP-43): กดแล้ว**เปลี่ยนเป็นภาพนิ่งของเครื่องนั้นทันที** ไม่มีการสลาย · ภาพเล็กในแถบ setup (step 1–3) ไม่มีปุ่ม

- [ ] **IMP-25 — Rename / Delete บนการ์ด: hover และคีย์บอร์ด** 🆕
  - เอาเมาส์ชี้การ์ด → ดูว่ามีปุ่ม Rename (ดินสอ) กับ Delete (ถังขยะ) โผล่แทนเวลา
  - เอาเมาส์ออก แล้วกด Tab เดินไปทีละปุ่ม
  - กด Rename → พิมพ์ชื่อใหม่ → กด Enter
  - กด Rename อีกครั้ง → พิมพ์อะไรสักอย่าง → กด Esc
  - กด Rename → ลบชื่อให้ว่างทั้งหมด หรือไม่แก้อะไรเลย → กด Enter
  - **คาดหวัง:** ปุ่มโผล่ตอน hover และตอนที่โฟกัสด้วย Tab (ไม่ใช่เมาส์อย่างเดียว) · Enter = ชื่อใหม่ขึ้นในรายการทันที (เปิดโปรเจกต์ดูแล้วชื่อบน title bar ตรง) · Esc = ชื่อเดิมกลับมา ไม่มีอะไรถูกบันทึก · ว่าง/ไม่เปลี่ยน = ไม่มีอะไรเกิดขึ้น (ไม่ขึ้น error) · การกด Rename ไม่เปิดโปรเจกต์

- [ ] **IMP-52 — กด Rename (ดินสอ) / Delete (ถังขยะ) บนการ์ดแล้วต้องไม่เปิดโปรเจกต์ (แก้แล้ว 2026-10-09)** 👀
  - ที่หน้าแรก เอาเมาส์ชี้ดินสอบนการ์ดค้างไว้จน tooltip "Rename project" ขึ้น แล้วคลิก (ทำกับการ์ดที่มีชิป failure groups และการ์ดที่ไม่มีด้วย)
  - ชี้ถังขยะค้างไว้จน tooltip "Delete project" ขึ้น แล้วคลิก → กด Cancel
  - กดเมาส์ค้างที่ดินสอ ลากออกไปปล่อยที่ชื่อการ์ด
  - คลิกที่ชื่อการ์ด (โปรเจกต์เปิด) → กลับหน้าแรก แล้วคลิกถังขยะของการ์ดเดิมทันที (เคสที่เจอบั๊กบ่อยที่สุด)
  - คลิกตรงข้อความเวลา (เช่น "2 h ago") ตอนที่เมาส์ยังไม่ได้ชี้การ์ดมาก่อน (เลื่อนเมาส์เข้าไปเร็ว ๆ แล้วคลิกทันที)
  - ถ้ามีจอสัมผัส: แตะตรงเวลาบนการ์ดที่ยังไม่โชว์ปุ่ม แล้วแตะถังขยะอีกครั้ง
  - ขยายหน้าต่างให้กว้างเต็มจอแล้วทำข้อแรกซ้ำ
  - **คาดหวัง:** คลิกดินสอ = ช่องแก้ชื่อขึ้นในการ์ด · คลิกถังขยะ = แถว "Delete this project?" ขึ้นในการ์ด · **ทุกกรณีต้องไม่ขึ้น "Loading workspace…" และไม่เข้า Dashboard** · กดค้างแล้วลากออก = ไม่มีอะไรเกิดขึ้น · คลิกที่ข้อความเวลา/มุมขวาของการ์ด = **ไม่เปิดโปรเจกต์** แต่ถ้าตรงกับตำแหน่งปุ่ม (ปุ่มอยู่ตรงนั้นเสมอแม้ยังมองไม่เห็น) อาจเริ่มแก้ชื่อหรือขึ้นแถวยืนยันลบได้ — กด Esc / Cancel ได้ · แตะครั้งแรกบนจอสัมผัส = แค่โชว์ปุ่ม แตะครั้งที่สองถึงจะถามลบ · คลิกที่ชื่อ/ที่ว่างอื่นของการ์ดยังเปิดโปรเจกต์ได้ตามปกติ (IMP-29)

- [ ] **IMP-26 — ปุ่มลัด Ctrl+N** 🆕
  - อยู่ step 0 กด **Ctrl+N** (ลองทั้งโฟกัสอยู่ที่หน้าว่าง ๆ และหลังคลิกที่การ์ด)
  - กลับ step 0 → คลิกช่อง Find project พิมพ์ข้อความ แล้วกด Ctrl+N
  - กลับ step 0 → เมนู File → New Workspace
  - อยู่ step 1 หรือ 2 กด Ctrl+N
  - เปิดโปรเจกต์เข้า Dashboard แล้วกด Ctrl+N
  - **คาดหวัง:** step 0 = ไป step 1 ครั้งเดียว (ไม่กระโดดข้ามไปไกลกว่านั้น, ไม่มีหน้าต่างใหม่ของ WebView เด้ง) · ตอนพิมพ์อยู่ในช่องค้นหา/ช่อง rename = **ไม่**เริ่มโปรเจกต์ใหม่ (ถ้าใน installer จริงเมนู File → New Workspace ยังเริ่มให้ตอนอยู่ในช่องพิมพ์ ให้บันทึกไว้ — เป็นปุ่มลัดของเมนูเนทีฟ) · เมนู File → New Workspace ทำงานเหมือนปุ่ม New project · step 1–2 = ไม่มีอะไรเกิดขึ้น ข้อความที่พิมพ์ไว้ไม่หาย · อยู่ Dashboard = กลับหน้า Import เฉย ๆ (ขึ้น step 0 ไม่ใช่ step 1)

- [ ] **IMP-27 — ค้นหาโปรเจกต์ที่หน้าแรก** 🆕
  - พิมพ์บางส่วนของชื่อ (ลองตัวพิมพ์ใหญ่/เล็ก) → ลองพิมพ์คำที่มีเฉพาะใน description → พิมพ์สิ่งที่ไม่มีอยู่จริง → ลบช่องให้ว่าง
  - **คาดหวัง:** กรองตามชื่อ + description ทันที · ไม่เจอเลยขึ้น "No matches" (ไม่ใช่การ์ด "No projects yet") · ล้างช่องแล้วรายการกลับครบ · ตัวเลขจำนวนโปรเจกต์ข้างหัวข้อไม่เปลี่ยนตามการค้นหา

- [ ] **IMP-28 — หน้าแรกตอนยังไม่มีโปรเจกต์เลย** 🆕
  - ติดตั้งใหม่ (หรือลบโปรเจกต์ทั้งหมดออก) แล้วเปิดแอป
  - เปิดแอปตอนที่มีโปรเจกต์อยู่แล้ว สังเกตช่วงแรกที่หน้าโหลด
  - **คาดหวัง:** ไม่มีโปรเจกต์ = การ์ด "No projects yet" + 3 ขั้น (Name the project → Add data → Explore in Dashboard) และไม่มีช่องค้นหา · มีโปรเจกต์อยู่ = ต้องไม่เห็นการ์ด "No projects yet" วาบขึ้นมาก่อนรายการโหลดเสร็จ

- [ ] **IMP-29 — เปิดโปรเจกต์จากการ์ด + ข้อความ error บนหน้าแรก** 🆕
  - กดที่การ์ด (ทั้งที่ชื่อ และที่ว่างข้างการ์ด — ยกเว้นมุมขวาที่เป็นเวลา/ปุ่ม Rename-Delete ซึ่งไม่เปิดโปรเจกต์ ดู IMP-52) → เปิดโปรเจกต์ (ดู IMP-4)
  - ทำให้เปิดไม่ได้ (ย้ายไฟล์ CSV ต้นทางออก ตาม IMP-5)
  - **คาดหวัง:** ขึ้นหน้าจอ "Loading workspace…" ครอบทั้งหน้าระหว่างโหลด · เปิดไม่ได้ = ขึ้นกล่องข้อความสีแดงบนหน้าแรก (ใต้ปุ่ม New project) การ์ดยังกดซ้ำได้ ไม่ค้างเป็น loading

- [ ] **IMP-4 — เปิด workspace เดิมแล้วเข้าหน้าที่ค้างไว้**
  - เปิด workspace ที่ปิดค้างไว้ตอนอยู่หน้า Dashboard
  - ทำซ้ำกับตัวที่ปิดค้างตอนอยู่แท็บ Failure Groups
  - **คาดหวัง:** เข้าหน้าเดิมที่ค้างไว้ (`lastRoute`) ไม่ใช่เด้งกลับหน้าแรกเสมอ

- [ ] **IMP-5 — workspace ที่ไฟล์ CSV ต้นทางถูกย้าย/ลบไปแล้ว**
  - ย้ายไฟล์ CSV ต้นทางออกจากที่เดิม
  - เปิด workspace นั้น
  - **คาดหวัง:** ขึ้นข้อความบอกว่าหาไฟล์ไม่เจอแบบอ่านรู้เรื่อง ไม่ crash ไม่จอขาว

- [ ] **IMP-30 — Step 1 "Name your project": ชื่อ + ตัวนับ + ปุ่ม Continue/Back (2026-10-04)** 🆕
  - กด New project → ปล่อยชื่อว่างไว้แล้วดูปุ่ม Continue
  - พิมพ์ชื่อ (ลองพิมพ์เว้นวรรคอย่างเดียวด้วย) แล้วดูตัวนับมุมขวาของช่อง
  - พิมพ์หรือวางข้อความยาวเกิน 80 ตัวอักษร
  - พิมพ์ description → กด Back → กด New project อีกครั้ง
  - **คาดหวัง:** หัวข้อ "Name your project" (ป้าย Step 1 of 3), ช่องชื่อตัวใหญ่ที่ถูกโฟกัสอยู่แล้ว · ชื่อว่างหรือเป็นช่องว่างล้วน = Continue กดไม่ได้ + ข้อความ "Enter a project name to continue" · มีชื่อ = "Ready to continue" และกดได้ · ตัวนับ "n/80" ตามจำนวนตัวอักษรที่พิมพ์ และพิมพ์เกิน 80 ไม่ได้ (วางยาวกว่านั้นถูกตัดที่ 80) · Back กลับ step 0

- [ ] **IMP-31 — ตั้งชื่อซ้ำกับโปรเจกต์ที่มีอยู่: เตือนแต่ไม่บล็อก (2026-10-04)** 🆕
  - ตั้งชื่อให้ตรงกับโปรเจกต์เดิม (ลองเปลี่ยนตัวพิมพ์ใหญ่/เล็ก และเว้นวรรคหน้า-หลัง)
  - พิมพ์ชื่อที่แค่คล้าย (ไม่ตรงทั้งชื่อ)
  - กด Continue ทั้งที่ชื่อซ้ำ แล้วทำต่อจนเข้า Dashboard
  - **คาดหวัง:** ชื่อซ้ำ (ไม่สนตัวพิมพ์ ไม่สนช่องว่างหน้า-หลัง) = ขึ้นข้อความสีเหลือง "A project with this name already exists — you can still use it." ใต้ช่อง · ชื่อที่แค่คล้ายไม่เตือน · ปุ่ม Continue ยังกดได้และสร้างโปรเจกต์ที่สองชื่อเดียวกันได้ (ดูในรายการ Recent ว่าเป็นสองตัว)

- [ ] **IMP-32 — การ์ดตัวอย่าง "Shows in recent projects as" และการ์ด "Next" (2026-10-04)** 🆕
  - พิมพ์ชื่อและ description ทีละตัวอักษร ดูการ์ดทางขวา
  - ลบ description ให้ว่าง ลบชื่อให้ว่าง
  - เอาเมาส์ชี้การ์ดตัวอย่างและลองกดที่มัน
  - **คาดหวัง:** การ์ดตัวอย่างหน้าตาเหมือนการ์ดในหน้าแรก (ไอคอนอักษรย่อสี + ชื่อ + description + "just now") และเปลี่ยนตามที่พิมพ์ทันที · ชื่อว่าง = ข้อความจาง "Project name" · description ว่าง = "No description" · การ์ดตัวอย่างกดไม่ได้ ไม่มีปุ่ม Rename/Delete · การ์ด "Next" ข้างใต้อธิบายขั้นถัดไป (02 Add sensor CSVs / + Tag-name file / 03 Name the failure groups (optional) / 04 Open the Dashboard and assign sensors to each group)


- [ ] **IMP-34 — Step 2 "Add your sensor data": เพิ่ม CSV 1 ไฟล์ (2026-10-04)** 🆕
  - เข้า step 2 ใหม่ ๆ ดูฝั่ง "Sensor data"
  - กด browse เลือก CSV ขนาดปกติ → กด Parse files
  - **คาดหวัง:** ก่อนเลือกไฟล์ = กรอบ dropzone ใหญ่ "Drop CSV files here … browse" พร้อมชิปเงื่อนไข 3 อัน (First column is date/time · Unique column names · Up to 2 GB per file) · เลือกไฟล์แล้ว dropzone ใหญ่เปลี่ยนเป็นแถวไฟล์ + ปุ่ม "Add more files" เล็ก · อ่านเสร็จแถวไฟล์แสดง "จำนวนแถว · จำนวนคอลัมน์" และขนาดไฟล์ (KB/MB/GB) ที่ตรงกับไฟล์จริง · ป้าย "1 file ready" มุมขวาบนของการ์ด

- [ ] **IMP-35 — แถบความคืบหน้าตอนอ่านไฟล์ (หลายไฟล์ / ไฟล์ใหญ่) (2026-10-04)** 🆕
  - เลือก CSV หลายไฟล์ (ถ้าได้ ให้มีไฟล์ใหญ่หลายร้อย MB ปนด้วย) → กด Parse files แล้วดูตลอดจนจบ
  - ระหว่างอ่าน ลองกด Remove / Add more files
  - อ่านเสร็จแล้วกด Parse files ใหม่อีกรอบ (เช่น เพิ่มไฟล์แล้ว parse)
  - เปิดโปรเจกต์เก่าจากหน้าแรกในจังหวะอื่น แล้วกลับมา step 2 (ถ้าทำได้)
  - **คาดหวัง:** ระหว่าง parse มีข้อความ "Reading…" แล้วเป็น "Merging…" และ "Done" พร้อม "n of m files" และแถบรวม · แต่ละแถวไฟล์: ไฟล์ที่อ่านแล้วขึ้น "Read" แถบเต็ม, ไฟล์ที่กำลังอ่านขึ้น "Reading…" แถบกะพริบ, ไฟล์ที่รอขึ้น "Waiting" แถบว่าง — **ไม่มีเลขเปอร์เซ็นต์ที่ไม่จริง** · แถบไม่ถอยหลัง · จบแล้วแถบหายและแถวไฟล์เปลี่ยนเป็นจำนวนแถว/ขนาด · parse รอบใหม่เริ่มจากศูนย์ ไม่ค้างค่าจากรอบก่อน · แถบไม่ขยับเมื่อมีการโหลดอย่างอื่นที่ไม่ใช่ Parse files ของหน้านี้

- [ ] **IMP-36 — การ์ดสรุปหลังอ่านข้อมูล: Rows / Sensors / Period / Interval / % empty (2026-10-04)** 🆕
  - ใช้ไฟล์ที่รู้ตัวเลขจริง (นับแถวและช่วงเวลาไว้ล่วงหน้า) → Parse files
  - เทียบการ์ดแต่ละใบกับไฟล์: Rows = จำนวนแถวหลัง merge, Sensors = จำนวนคอลัมน์ตัวเลข (ไม่นับ timestamp), Period = ช่วงเวลาเริ่ม → สิ้นสุด พร้อมความยาว (เช่น "18.2 mo"), Interval = ระยะห่างข้อมูล (300 วินาที = "5 min", 3600 = "1 h", ต่ำกว่า 1 นาทีเป็นวินาที), % empty = สัดส่วนช่องว่าง 1 ตำแหน่งทศนิยม
  - ลองไฟล์ที่ timestamp อ่านไม่ได้เลย (ถ้ามี) หรือไฟล์ที่ไม่มีช่องว่างเลย
  - **คาดหวัง:** ตัวเลขทุกใบตรงกับไฟล์จริง · ใบไหนที่ระบบไม่รู้ค่า = **ไม่แสดงใบนั้นเลย** (ไม่มี NaN / undefined / ค่าแต่งขึ้นมา) · ช่องว่างน้อยมากแต่ไม่ใช่ศูนย์ขึ้น "<0.1%" ไม่ใช่ "0.0%" · แก้รายการไฟล์หลัง parse (เพิ่ม/ลบ) = การ์ดสรุปหายและต้อง Parse files ใหม่

- [ ] **IMP-37 — หลายไฟล์: merge + แถบ "Time coverage" เห็นช่วงที่ซ้อนกัน (2026-10-04)** 🆕
  - เลือก CSV 2–3 ไฟล์ที่มีช่วงเวลา**ซ้อนกันบางส่วน** → Parse files
  - ทำอีกรอบกับไฟล์ที่ช่วงเวลา**ไม่ซ้อนกัน** (ไฟล์ต่อกัน)
  - ทำอีกรอบกับไฟล์เดียว
  - **คาดหวัง:** Rows = ผลรวมหลังรวมตาม timestamp (timestamp ซ้ำถูกรวมเป็นแถวเดียว ดูได้จากกล่อง "Fixed while reading") · แถบ Time coverage มีแถบต่อไฟล์บนแกนเวลาเดียวกัน แถบที่ซ้อนกันเห็นว่าซ้อนจริง พร้อมข้อความ "files overlap — merged on their timestamps" · ไฟล์ที่ไม่ซ้อน = "files do not overlap" · ไฟล์เดียว = แถบเต็มความกว้างและ "one file" · วันที่บนแกนตรงกับช่วงเวลาของไฟล์ · "Add more files" เพิ่มไฟล์ได้ (ต้อง Parse files ใหม่)

- [ ] **IMP-38 — "Tag names" (เดิมชื่อ Sensor mapping): ล็อกก่อนอ่านข้อมูล → ปลดล็อก → ผลการจับคู่ (2026-10-04)** 🆕
  - เข้า step 2 ใหม่ ๆ ดูการ์ดขวา "Tag names"
  - อ่านข้อมูลให้เสร็จ (Parse files) → ดูการ์ดอีกครั้ง
  - เลือกไฟล์ tag names (CSV ที่มีคอลัมน์ tag + description/unit/component/alarm) → ถ้าถามให้เลือกคอลัมน์ tag ให้เลือก
  - ดูวงแหวน ชิป component แท็บ Matched / No name กล่องค้นหา และตาราง · กดคอลัมน์ alarm ดู tooltip
  - เปลี่ยนไฟล์ข้อมูล (เพิ่ม/ลบไฟล์) หลัง parse แล้วดูการ์ดอีกที
  - **คาดหวัง:** ก่อนอ่านข้อมูล = การ์ดจาง ๆ พร้อมคำอธิบาย "Add sensor data first" และกดเลือกไฟล์ไม่ได้ · หลังอ่านเสร็จ = ปลดล็อก มีคำอธิบายคอลัมน์ที่ต้องมี + ปุ่ม "Select tag-name CSV" และบอกว่าไม่ใส่ก็ได้ · หลังจับคู่: วงแหวน "matched / ทั้งหมด" (เช่น 130 / 132 และ "2 columns have no name yet") · ชิป component พร้อมจำนวน · แท็บ Matched แสดง tag · ชื่อ · unit · จุด alarm LL/L/H/HH (จุดติดเฉพาะค่าที่มีจริง tooltip บอกค่า) · แท็บ "No name" (โผล่เฉพาะเมื่อมีคอลัมน์ที่ไม่มีชื่อ) แสดง tag ที่ไม่มีชื่อ · ค้นหาตาม tag/ชื่อได้ · คอลัมน์ที่ mapping ไม่มี (unit/alarm) จะไม่ถูกแสดงเป็นคอลัมน์ว่าง · ไม่มีคำว่า "Sensor mapping" ที่ใดในหน้านี้ · เปลี่ยนไฟล์ข้อมูลหลัง parse = การ์ดล็อกอีกครั้งจนกว่าจะ Parse files ใหม่


- [ ] **IMP-45 — แถบขั้นตอนทางซ้าย (setup rail) 4 ขั้น + ลำดับปุ่ม Tab (แทน IMP-33, customer batch 2026-10 item 5)** 🆕
  - อยู่ step 1 ดูแถบซ้าย → ไป step 2 อ่านไฟล์ให้เสร็จ → กด Continue ไป step 3 → ใส่กลุ่ม 2 กลุ่ม
  - ที่ step 2 และ step 3 กดขั้นที่เสร็จแล้วในแถบ (Name the project / Add sensor data) · ลองกดขั้นที่ยังไม่ถึง (Failure groups ตอนอยู่ step 2, Explore in Dashboard)
  - ทุก step: คลิกที่ว่างในหน้า แล้วกด **Tab** ไล่ไปเรื่อย ๆ
  - ใช้โปรเจกต์ที่มีไฟล์ชื่อยาว/หลายไฟล์ และหน้าต่างแคบ ดูข้อความใต้ "Add sensor data"
  - **คาดหวัง:** แถบมี 4 ขั้น (Name the project → Add sensor data → **Failure groups** "The failures you want to find" → Explore in Dashboard "Charts, assign sensors, build models") · ใต้ "Add sensor data" เป็น "N file(s) · จำนวนแถว · จำนวน tags" และ**ขึ้นบรรทัดที่สองได้** (ไม่ตัดด้วย … ในบรรทัดเดียว, ไม่เกิน 2 บรรทัด) · ใต้ "Failure groups" ตอนอยู่ step 3 เป็น "0 groups" → "2 groups" ตามที่ใส่ · กดขั้นที่เสร็จแล้วย้อนกลับได้ ข้อความ/กลุ่มที่พิมพ์ไว้ไม่หาย · ขั้นที่ยังไม่ถึงกดไม่ได้ · **Tab ไปถึงช่อง/ปุ่มของหน้านั้น (รวมปุ่มล่าง Back / Continue) ก่อน แล้วค่อยไปที่แถบซ้ายและ All projects** ทุก step · All projects กลับหน้าแรก

- [ ] **IMP-46 — Step 2: ปุ่ม "Continue" และแถบสถานะด้านล่าง (แทน IMP-39 — ปุ่มนี้เคยชื่อ Open Dashboard)** 🆕
  - ที่ step 2 ก่อนมีไฟล์ / มีไฟล์แต่ยังไม่ parse / parse แล้วแก้รายการไฟล์ / parse สำเร็จ → ดูปุ่มขวาล่างและข้อความซ้ายล่าง
  - parse สำเร็จทั้งแบบไม่ใส่ tag names และแบบใส่ → กด Continue
  - **คาดหวัง:** ป้ายบนหัวข้อเป็น "Step 2 of 3 · ชื่อโปรเจกต์" · ปุ่มชื่อ **Continue →** (ไม่มี Open Dashboard ที่ step นี้แล้ว) กดได้เฉพาะเมื่อ parse สำเร็จและรายการไฟล์ยังตรงกับที่ parse · ข้อความล่าง: "Awaiting data" → "Reading files…" → "Selection changed · re-parse required" → "Ready · จำนวนแถว · no tag names" หรือ "Ready · จำนวนแถว · N names mapped" · Continue ไป step 3 (Failure groups) · Back กลับ step 1

- [ ] **IMP-48 — Step 3 "Which failures should Wizard look for?": ตั้งชื่อ Failure groups** 🆕
  - ไปถึง step 3 (อย่าคลิกอะไร) แล้วพิมพ์ชื่อกลุ่มทันที → กด **Enter** → พิมพ์ชื่อถัดไป → Enter (ทำ 3 กลุ่ม)
  - พิมพ์ชื่อซ้ำกับกลุ่มที่มี (ลองตัวพิมพ์ใหญ่/เล็กต่างกัน) แล้วกด Enter · กด Esc ในช่องนี้
  - ในการ์ดกลุ่ม: แก้ชื่อเป็นชื่อซ้ำแล้วกด Enter → กด Esc · แก้เป็นชื่อใหม่แล้ว Enter · พิมพ์ Description และ Recommendation ยาวหลายบรรทัด
  - กด ✕ ที่กลุ่มกลาง → กด **Undo** ที่ป้ายมุมขวาล่าง · ลบอีกกลุ่มแล้วรอ 7 วินาที
  - ดูปุ่ม/ข้อความด้านล่างตอนมี 0 กลุ่ม และตอนมีกลุ่ม
  - **คาดหวัง:** ป้าย "Step 3 of 3 · ชื่อโปรเจกต์" · เคอร์เซอร์อยู่ในช่องเพิ่มกลุ่มตั้งแต่เข้ามา · Enter = เพิ่มการ์ด FG-1, FG-2 … (จุดสีตามสีกลุ่มของ Dashboard: เหลืองอำพัน ม่วง เขียว ฟ้า) ช่องว่างลงและเคอร์เซอร์ยังอยู่ที่เดิม · ชื่อซ้ำ = ช่องเป็นสีแดง + ข้อความ "A failure group named "…" already exists." และไม่เพิ่ม · Esc ล้างช่อง · ในการ์ด ชื่อซ้ำ = แดงพร้อมข้อความ และ**ปุ่ม Open Dashboard กดไม่ได้** พร้อมข้อความล่างสีแดง "Fix the duplicate group name (or press Esc on it) to open the Dashboard" จนกว่าจะแก้ชื่อ / กด Esc (เอาชื่อเดิมกลับ) / ลบการ์ดนั้น (Skip ยังกดได้) · พิมพ์ "Not in Group" ในช่องเพิ่มกลุ่ม = แดง ไม่เพิ่ม · ลบกลุ่มสุดท้าย → เพิ่มกลุ่มใหม่ → Undo = ได้ 3 การ์ดแยกกัน แก้การ์ดหนึ่งแล้วอีกการ์ดไม่เปลี่ยนตาม · Description/Recommendation ขยายความสูงตามข้อความ · ✕ ลบทันที + ป้าย "Removed …" พร้อม Undo (หายเองใน 7 วินาที) · Undo เอากลับมาที่ตำแหน่งเดิม · ไม่มีกลุ่ม = กรอบเส้นประ "No failure groups yet", ข้อความล่าง "Add at least one failure group, or skip for now" (สีเทา ไม่ใช่สีเขียว), **Open Dashboard กดไม่ได้** · มีกลุ่ม = "N failure groups · sensors are assigned in the Dashboard" (สีเทา) · มีปุ่มหลักสีฟ้าปุ่มเดียวคือ **Open Dashboard**, "Skip for now" เป็นลิงก์ข้อความ, "+ Add group" เป็นปุ่มรอง

- [ ] **IMP-49 — Step 3 → Open Dashboard: กลุ่มที่ตั้งไว้เข้า Dashboard ครบ** 🆕
  - ใส่ 2–3 กลุ่ม (ใส่ Description/Recommendation ให้บางกลุ่ม) → กด **Open Dashboard**
  - ดูแถบซ้ายช่วงที่กำลังเปิด แล้วดู Dashboard
  - ที่แท็บ Failure Groups กด **Edit details** ของกลุ่มที่ใส่ Description ไว้
  - กลับหน้าแรก (Back to Import) ดูการ์ดโปรเจกต์นี้ แล้วปิดโปรแกรมเปิดใหม่ เปิดโปรเจกต์นี้อีกครั้ง
  - **คาดหวัง:** ระหว่างเปิด แถบซ้ายขั้น "Failure groups" มีเครื่องหมายถูก + "N groups" และขั้น "Explore in Dashboard" เป็นขั้นปัจจุบัน หน้ากลางขึ้น "Opening the Dashboard…" (ไม่ช้ากว่าเดิม) · Dashboard เปิดที่**แท็บ Failure Groups** มีกลุ่ม FG-1, FG-2 … ตามลำดับที่ใส่ ชื่อ/Description/Recommendation ตรงกับที่พิมพ์ (ดูใน Edit details) · การ์ดบนหน้าแรกขึ้นชิป "N failure groups" พร้อมสี่เหลี่ยมสีกลุ่ม · เปิดใหม่แล้วกลุ่มยังอยู่ครบ

- [ ] **IMP-50 — Step 3 → Skip for now** 🆕
  - พิมพ์กลุ่มไว้ 1 กลุ่มแล้วกด **Skip for now** (ลองกด Enter และ Space ที่ลิงก์ด้วยคีย์บอร์ดในอีกรอบ)
  - ดูแถบซ้ายช่วงที่กำลังเปิด แล้วดู Dashboard และการ์ดบนหน้าแรก
  - **คาดหวัง:** ขั้น "Failure groups" เป็นวงกลม**เส้นประมีขีด "–"** และข้อความ "Skipped · 0 groups" — **ไม่มีเครื่องหมายถูก** · เส้นเชื่อมใต้ขั้นนั้นเป็นเส้นประ · กลุ่มที่พิมพ์ไว้**ไม่ถูกบันทึก** · Dashboard เปิดที่แท็บ Failure Groups พร้อมกล่องฟ้า "No failure groups yet. Failure groups come first…" · การ์ดบนหน้าแรกขึ้นชิปเส้นประสีเทา "No failure groups" (ไม่ใช่สีเหลือง/แดง)

- [ ] **IMP-51 — ชิปจำนวน Failure groups บนการ์ด Recent projects** 🆕
  - ดูการ์ดของ: โปรเจกต์ที่มี 1 กลุ่ม / 4 กลุ่มขึ้นไป / ไม่มีกลุ่ม / โปรเจกต์ที่บันทึกก่อนเวอร์ชันนี้ (ยังไม่เคยเปิดหลังอัปเดต)
  - เปิดโปรเจกต์ใดก็ได้ เพิ่มหรือลบกลุ่ม (จากแท็บ Failure Groups หรือจาก sheet ของปุ่ม Failure groups บนแถว sensor) แล้ว Back to Import
  - เปิดโปรเจกต์เก่าที่ไม่มีชิป ทำอะไรก็ได้แล้วกลับหน้าแรก
  - ทำให้หน้าต่างแคบลงจนการ์ดแคบ
  - **คาดหวัง:** "1 failure group" / "N failure groups" พร้อมสี่เหลี่ยมสีกลุ่มไม่เกิน 3 อัน (สีเดียวกับใน Dashboard) · ไม่มีกลุ่ม = ชิปเส้นประสีเทา "No failure groups" · โปรเจกต์เก่าที่ยังไม่ถูกบันทึกใหม่ = **ไม่มีชิป** (ไม่ใช่ "No failure groups") และหลังเปิดแล้วกลับมาก็มีชิปตามจริง · ชิปอัปเดตตามที่เพิ่ง/ลบกลุ่ม · การ์ดแคบ = ชิปย้ายไปอยู่ใต้ description ไม่ทับเวลา/ปุ่ม · กดที่ชิปก็เปิดโปรเจกต์เหมือนกดการ์ด

- [ ] **IMP-14 — Alarm setpoint เข้ามาจาก mapping**
  - ใช้ไฟล์ tag names ที่มี ALARM_L / ALARM_LL / ALARM_H / ALARM_HH (ที่ step 2 จุด alarm ในตารางของ "Tag names" ต้องติดตรงกับค่าที่ใส่)
  - เข้า Dashboard แล้วเปิด alarm ของ sensor นั้น
  - **คาดหวัง:** เส้น alarm ขึ้นตรงค่าที่อยู่ใน mapping — sensor ที่ไม่มีค่าในคอลัมน์นั้นต้อง**ไม่ขึ้นเส้นที่ 0**

- [ ] **IMP-15 — ไฟล์ผิดรูปแบบ**
  - ลองไฟล์ที่ไม่มีคอลัมน์ timestamp
  - ลองไฟล์ว่าง
  - ลองไฟล์ที่ไม่ใช่ CSV
  - **คาดหวัง:** ทุกกรณีขึ้นข้อความบอกสาเหตุ ไม่ crash และยังกดทำอย่างอื่นต่อได้

- [ ] **IMP-16 — ไฟล์ใหญ่จริง**
  - อัปโหลด CSV ขนาดหลายร้อย MB
  - **คาดหวัง:** ระหว่าง Parse files เห็นแถบความคืบหน้า "Reading… / Merging… / Done" (ไม่ค้างแบบเงียบ, ดู IMP-35), จบแล้วเข้า Dashboard ได้, จับเวลาไว้ด้วยว่านานเท่าไร


- [ ] **IMP-18 — เปลี่ยนชื่อ workspace ในรายการ Recent (inline)** 🆕
  - ที่การ์ดบนหน้าแรก เปลี่ยนชื่อโปรเจกต์ตัวหนึ่ง (รายละเอียดปุ่ม/คีย์ดู IMP-25)
  - เปิด workspace นั้นเข้าไป
  - **คาดหวัง:** ชื่อใหม่ขึ้นในรายการทันที และตรงกับที่แสดงบน title bar ตอนเปิด (หน้าต่าง "Save As / Rename" แยกถูกลบไปแล้ว — เปลี่ยนชื่อทำได้ที่นี่ที่เดียวนอกเหนือจาก File → Rename Workspace)

- [ ] **IMP-19 — แถบเตือนสีเหลืองหลัง parse (ก่อนหน้านี้ backend ส่งมาแต่ไม่เคยแสดงเลย, แก้แล้ว 2026-09-22)** 🆕
  - อัปโหลด CSV ที่มีคอลัมน์ชื่อซ้ำกันข้ามไฟล์ (2 ไฟล์ขึ้นไป) หรือ timestamp ซ้ำข้ามไฟล์ แล้ว Parse files
  - **คาดหวัง:** ในการ์ด "Sensor data" ขึ้นกล่องข้อความสีเหลือง (ไม่ใช่สีแดงแบบ error) หัวข้อ **"Fixed while reading"** แล้วไล่รายการ เช่น "Duplicate column '...' found in file 1, file 2" — parse ยังสำเร็จ กด Continue ต่อได้ปกติ

- [ ] **IMP-20 — ไฟล์ที่ใช้ปี พ.ศ. ถูกแปลงเป็น ค.ศ. อัตโนมัติ + 29 ก.พ. ที่เคยหายกลับมา (แก้แล้ว 2026-09-22)** 🆕
  - อัปโหลดไฟล์ที่คอลัมน์ timestamp เป็นปี พ.ศ. (เช่น `2566-05-13 01:00:00...`, มีข้อมูลคาบเกี่ยว 29 กุมภาพันธ์ของปีอธิกสุรทิน พ.ศ. เช่น 2567)
  - ดูแถบเตือนหลัง parse แล้วเข้า Dashboard ดูกราฟ ทั้งโหมด Raw และ Aggregate
  - **คาดหวัง:** แถบเตือนบอกจำนวนแถวที่แปลงปี พ.ศ.→ค.ศ. — ในกราฟ **ปีที่แสดงต้องเป็น ค.ศ.ทั้งหมด** (เช่น 2566 → 2023) และต้อง**ตรงกันทั้ง Raw กับ Aggregate** (เดิมถ้าแก้ไม่ครบจะเห็นปีไม่ตรงกันระหว่างสองโหมด) — แถวของวันที่ 29 กุมภาพันธ์ต้องมีข้อมูลอยู่ ไม่หายไป (เดิมหายทั้งวันเพราะปีที่อ่านเป็น ค.ศ. ตรงๆ ไม่ใช่ปีอธิกสุรทิน)

---

## LAY

### โครง Dashboard

- [ ] **LAY-1 — มีครบ 3 แผง**
  - ดูหน้า Dashboard
  - **คาดหวัง:** แผงกราฟ (Sensor Readings), แผงข้อมูลด้านล่าง (Selected Sensor / Filter / Highlights), แผง Sensor ด้านขวา (Sensor / Failure Groups)

- [ ] **LAY-2 — ซ่อน/แสดงแผง**
  - กดไอคอนตาขีดฆ่าของแต่ละแผง
  - เอากลับมา
  - **คาดหวัง:** ซ่อนได้ทั้ง 3 แผง และเอากลับมาได้ครบ

- [ ] **LAY-3 — ลากปรับขนาดแผง**
  - ลากเส้นแบ่งระหว่างแผง
  - ปิดโปรแกรมแล้วเปิดใหม่
  - **คาดหวัง:** ขนาดที่ลากไว้ยังอยู่หลังเปิดใหม่

- [ ] **LAY-4 — ปุ่มลูกศรกลับหน้า Import**
  - กดลูกศรซ้ายมุมบนของแผงกราฟ
  - **คาดหวัง:** กลับหน้า Import และงานที่ทำไว้ถูกบันทึกแล้ว (เปิดกลับเข้ามาต้องครบ)

- [ ] **LAY-5 — badge จำนวนจุด**
  - ดู badge บนหัวแผงกราฟตอน Line
  - ดูตอน Scatter
  - **คาดหวัง:** Line แสดง `X / Y pts (downsampled)` หรือ `N Points`; Scatter แสดง `X / Y pts (sampled)` — ตัวเลขต้องขยับตามช่วงเวลาที่กรอง

---

## SEN

### แผง Sensor

- [ ] **SEN-1 — ค้นหา sensor**
  - พิมพ์ tag
  - พิมพ์คำใน description
  - พิมพ์ชื่อ component
  - พิมพ์หน่วย
  - **คาดหวัง:** ค้นเจอทั้ง 4 แบบ

- [ ] **SEN-2 — จัดกลุ่มตาม component**
  - พับ/กางกลุ่ม
  - **คาดหวัง:** พับกางได้ sensor ที่ไม่มี component อยู่ใต้ Uncategorized

- [ ] **SEN-3 — ติ๊กเลือก sensor**
  - ติ๊กทีละตัว 3-4 ตัว
  - ติ๊กออก
  - **คาดหวัง:** กราฟกับแท็บ Selected Sensor อัปเดตตาม และตัวเลขในหัวแท็บ `Sensor (N)` ตรง

- [ ] **SEN-4 — ปุ่ม Alarm setpoints**
  - กดไอคอน alarm ของ sensor ที่มีค่า setpoint
  - กดปิด
  - **คาดหวัง:** เส้น LL/L/H/HH ขึ้น/หายบนกราฟ พร้อม label

- [ ] **SEN-12 — กด 📁 แล้วแผง Failure Group Assignment เปิดที่ขอบซ้ายของแผง Sensor** 🆕
  - กางกลุ่ม component แล้วกดไอคอน 📁 ของ sensor หนึ่งตัว
  - **คาดหวัง:** แผงสูงเต็มความสูงของแผง Sensor โผล่ที่ขอบซ้ายของแผง Sensor (ทับส่วนขวาของกราฟระหว่างเปิด) หัวแผงมีชื่อ sensor + tag + หน่วย, มีลูกศรเล็กที่ขอบขวาของแผงชี้ไปที่แถว sensor นั้น และแถวนั้นถูกไฮไลต์ — ไม่ใช่ popup เล็กลอยใต้ปุ่มแบบเดิมอีกแล้ว

- [ ] **SEN-13 — ตารางกลุ่ม × ชนิดโมเดล (ช่องว่าง / ช่องที่เลือก / หัวคอลัมน์ / Not in Group)** 🆕
  - ดูตารางในแผง: แถวละหนึ่ง Failure Group, คอลัมน์ Individual / Relation model / Clustering
  - เอาเมาส์วางบนช่องว่าง แล้วกดเลือก
  - ดูหัวคอลัมน์ (บรรทัดเล็กใต้ชื่อชนิด)
  - ถ้ามีกลุ่มเยอะ เลื่อนลิสต์ในแผงลงสุด
  - **คาดหวัง:** ช่องว่างเป็นกล่องเปล่า พอวางเมาส์เห็นเครื่องหมาย + และขอบสีของชนิดนั้น; ช่องที่เลือกถูกเติมสีของชนิด (ฟ้า/เหลือง/เขียวน้ำเงิน) พร้อม ✓; หัวคอลัมน์บอกจำนวนกลุ่มที่ sensor อยู่ในชนิดนั้น ("2 groups" / "1 group" / "none") และเปลี่ยนตามที่ติ๊กทันที; หัวคอลัมน์ค้างอยู่ด้านบนตอนเลื่อน; แถว "Not in Group" ปักอยู่ล่างสุดเสมอ ใช้ติ๊กได้เหมือนกลุ่มจริง

- [ ] **SEN-14 — ติ๊กได้หลายชนิดและหลายกลุ่ม แล้วป้ายที่แถว sensor เปลี่ยนสดๆ** 🆕
  - ติ๊ก Individual และ Relation model ในกลุ่มเดียวกัน
  - ติ๊กอีกกลุ่ม
  - ดูแถว sensor ที่ถูกไฮไลต์ในแผงด้านขวาไปพร้อมกัน (ป้ายสีกลุ่มใต้ชื่อ sensor)
  - **คาดหวัง:** ติ๊กได้หลายชนิดในกลุ่มเดียว และ sensor หนึ่งอยู่ได้หลายกลุ่มพร้อมกัน; ป้าย (ตัวย่อชนิด + ชื่อกลุ่ม) ที่แถวขวาเพิ่ม/หายตามทันทีโดยไม่ต้องปิดเปิดแผง; เปิดแท็บ Failure Groups แล้ว sensor อยู่ครบตามที่ติ๊ก

- [ ] **SEN-23 — ชนิดโมเดลเรียกว่า "Relation model" ทุกที่นอกหน้าต่าง Build Model (แผง Failure groups ของ sensor, ป้ายที่แถว sensor, แท็บ Failure Groups, แถบ Undo, ข้อความล็อกของ special sensor)** 🆕
  - เปิดแผง Failure groups ของ sensor (ปุ่ม 📁 ที่แถว sensor) อ่านหัวคอลัมน์ทั้ง 3 แล้วชี้เมาส์ที่ช่องของคอลัมน์ R ทั้งช่องว่างและช่องที่ติ๊กแล้ว (ลองทั้งตอนแผงกว้างสุดและแคบสุด)
  - ติ๊ก R ให้ sensor ในกลุ่มหนึ่ง แล้วชี้เมาส์ที่ปุ่ม × ของป้าย R ใต้ชื่อ sensor ในแผง Sensor
  - เอา R ออกจากกลุ่มสุดท้ายของมัน (โมเดลถูกลบ) อ่านแถบ Undo ที่ขึ้นมา — ทำซ้ำกับ I และ C
  - เปิดแท็บ Failure Groups ชี้เมาส์ที่ป้ายตัวอักษร R ของ sensor แล้วกางแถวออก ชี้ที่ป้าย R ของแถวโมเดล
  - สร้าง special sensor แล้วใช้เป็น predictor ของ Relation model ตัวหนึ่ง จากนั้นเปิด Add Special Sensor → Manage อ่านข้อความล็อกของ special sensor ตัวนั้น (และลองแก้ชื่อมัน อ่านข้อความที่ปฏิเสธ)
  - **คาดหวัง:** หัวคอลัมน์เขียน **Individual / Relation model / Clustering** (ตัวอักษรบนป้ายยังเป็น I / R / C) — คำว่า "Relation model" ไม่ทับชื่อคอลัมน์ข้างเคียง ไม่ถูกตัด และช่องติ๊กยังอยู่ตรงกลางใต้หัวคอลัมน์ · tooltip ของช่อง: "Add Relation model to <กลุ่ม>" / "Remove Relation model from <กลุ่ม>" และช่องที่เป็นกลุ่มสุดท้าย "… — this deletes the sensor's Relation model (you can undo for 7 seconds)" · tooltip ของ × บนป้าย: "Remove Relation model from <กลุ่ม>" · แถบ Undo: **"Relation model of <sensor> deleted"** (ไม่ใช่ "Relation model model of …"; ชนิดอื่นยังเป็น "Individual model of …" / "Clustering model of …") · tooltip ของป้าย R ในแท็บ Failure Groups: "Relation model" · ข้อความล็อก: "Used by 1 model: <ชื่อโมเดล> (Relation model). …" · **ไม่มีคำว่า "Relationship" ที่ใดบนจอ** ยกเว้นชื่อโมเดลที่บันทึกไว้เองจากเวอร์ชันก่อน (ดู BMW-195) · ไม่มีชื่ออัลกอริทึม คำว่า "sidecar" หรือ "Python" บนจอ

- [ ] **SEN-15 — แถวไม่กระโดดตอนติ๊ก + สวิตช์ All | Assigned + ค้นหากลุ่ม** 🆕
  - เปิดแผงของ sensor ที่อยู่ในบางกลุ่ม (หมวด "Assigned" อยู่บน, "Other groups" อยู่ล่าง)
  - ติ๊กเพิ่มในกลุ่มที่อยู่ใต้ "Other groups" และติ๊กออกจากกลุ่มใต้ "Assigned"
  - กดสวิตช์ "Assigned" แล้วกลับ "All"
  - พิมพ์ค้นหาชื่อกลุ่มในช่อง Search
  - **คาดหวัง:** แถวที่ติ๊กไม่ย้ายที่ — เปลี่ยนแค่สี (แถบสีกลุ่มด้านซ้าย + ชื่อตัวหนา) เพราะหมวด Assigned คำนวณตอนเปิดแผงหรือสลับ sensor เท่านั้น; ตัวเลขข้างปุ่ม "All N | Assigned N" ตรงกับจำนวนจริง (Assigned นับตามที่ติ๊กอยู่ตอนนี้); มุมมอง Assigned ซ่อนกลุ่มที่ sensor ไม่ได้อยู่; ค้นหาแล้วเหลือเฉพาะกลุ่มที่ชื่อตรง แต่ "Not in Group" ยังอยู่ล่างสุด; ค้นหาไม่เจอขึ้น "No groups match"

- [ ] **SEN-16 — สลับ sensor โดยไม่ปิดแผง (กด 📁 ตัวอื่น และปุ่ม ‹ ›)** 🆕
  - ตอนแผงเปิดอยู่ กดไอคอน 📁 ของ sensor ตัวอื่น
  - กดปุ่ม › ไปเรื่อยๆ จนข้าม component (ให้มี component ที่พับอยู่ปนกัน)
  - กดปุ่ม ‹ กลับ
  - ไปที่ sensor ตัวแรกสุด/ตัวสุดท้ายสุดของลิสต์
  - **คาดหวัง:** กด 📁 ของ sensor อื่น = แผงสลับไปเป็นของตัวนั้นเลย (ไม่ปิดแล้วเปิดใหม่) ลูกศรและไฮไลต์ย้ายตาม; ‹ › ไป sensor ก่อน/ถัดไปข้ามทุก component — ถ้า component นั้นพับอยู่จะกางให้เอง ลิสต์เลื่อนไปให้เห็นแถว และถ้ากำลังค้นหาอยู่ช่องค้นหาจะถูกล้าง; ที่ sensor แรก ‹ กดไม่ได้ ที่ตัวสุดท้าย › กดไม่ได้; เลื่อนลิสต์ sensor ขณะแผงเปิด ลูกศรเลื่อนตามแถว และหายไปถ้าแถวเลื่อนพ้นลิสต์ (แผงไม่ปิด)

- [ ] **SEN-17 — อะไรปิดแผงได้ / อะไรต้องไม่ปิด** 🆕
  - เปิดแผง แล้วกดที่กราฟ
  - เปิดใหม่ กด Esc
  - เปิดใหม่ กดปุ่ม ✕ และปุ่ม Done
  - เปิดใหม่ พิมพ์ในช่อง Search sensors ด้านขวา
  - เปิดใหม่ พับ component ที่ sensor นั้นอยู่
  - เปิดใหม่ แล้วกดไอคอนกระดิ่ง (alarm) ของ sensor ที่มี setpoint
  - เปิดใหม่ ลองกดในแผง Sensor: ติ๊กเลือก sensor, กาง/พับ component, เลื่อนลิสต์, กดสลับแท็บ Sensor/Failure Groups; แล้วลองสลับชนิดกราฟ (Line / Scatter / Pair Plot)
  - ลองย่อหน้าต่างให้แคบ (ประมาณ 800px) แล้วเปิดแผง
  - **คาดหวัง:** กดที่กราฟ / Esc / ✕ / Done / พิมพ์ค้นหา sensor / พับ component ของ sensor นั้น / เปิดกระดิ่ง = ปิดแผง (กระดิ่งกับแผงเปิดพร้อมกันไม่ได้); การติ๊กเลือก sensor, กางพับ component และเลื่อนลิสต์ = ไม่ปิด; สลับแท็บเป็น Failure Groups = ปิดตามธรรมชาติเพราะแท็บ Sensor หายไป; สลับชนิดกราฟแล้วแผงต้องไม่ค้างอยู่เหนือกราฟแบบไม่มีที่มา (ปิดเมื่อคลิกปุ่มชนิดกราฟ); ที่หน้าต่างแคบแผงหดลงแต่ยังเห็นชื่อกลุ่มและกดช่องได้ ไม่หลุดขอบซ้ายของหน้าต่าง

- [ ] **SEN-18 — เอา sensor ออกจากกลุ่มสุดท้ายแล้วโมเดลหายทันที แต่มี Undo 7 วินาที** 👀
  - ให้ sensor อยู่กลุ่มเดียว ชนิดเดียว (ใช้โมเดลที่เคยตั้งค่า/ติ๊ก Mark complete ไว้ก็ได้ เพื่อเช็กว่าค่าตั้งกลับมาจริง)
  - วางเมาส์บนช่องที่เลือกนั้น (ยังไม่กด)
  - กดติ๊กออก (หรือกด ✕ บนป้ายกลุ่มที่แถว sensor)
  - ดูมุมล่างขวา แล้วกด Undo ภายใน 7 วินาที
  - ทำซ้ำอีกรอบแต่ไม่กด Undo รอ 8 วินาที
  - ลองเอาออกหลายโมเดลติดกัน
  - **คาดหวัง:** tooltip ของช่องนั้นเตือนก่อนกดว่านี่จะลบโมเดลของ sensor (และบอกว่า undo ได้ 7 วินาที); กดแล้วโมเดลหายทันที **ไม่ไปโผล่ใต้ Not in Group**; มี toast "<ชนิด> model of <ชื่อ sensor> deleted" พร้อมปุ่ม Undo; กด Undo = โมเดลกลับมาเป็นใบเดิมทั้งก้อน (ชื่อ/ค่าตั้ง/สถานะที่เคยตั้ง เปิดใน Build Model ดูได้) และอยู่กลุ่มเดิม; ไม่กด = toast หายเองประมาณ 7 วินาทีและโมเดลยังถูกลบ; หลาย toast ซ้อนกันได้สูงสุด 3 อัน แต่ละอันนับเวลาของตัวเอง; การกด Undo ไม่ทำให้แผงที่เปิดอยู่ปิด

- [ ] **SEN-19 — Undo ต้องไปถึงหน้าต่าง Build Model ด้วย** 🆕
  - เปิดหน้าต่าง Build Model ค้างไว้ข้างๆ
  - กลับมา Dashboard ลบโมเดลด้วยการเอา sensor ออกจากกลุ่มสุดท้าย (ดู SEN-18)
  - ดูรายการ sensor ในหน้าต่าง Build Model
  - กด Undo ที่ Dashboard
  - **คาดหวัง:** หน้าต่าง Build Model เห็นโมเดลหายทันทีโดยไม่ต้องปิดเปิด และเห็นโมเดลกลับมาหลังกด Undo; ปิดโปรแกรมแล้วเปิด workspace ใหม่ โมเดลที่ Undo แล้วยังอยู่ (ไม่หายตอนปิดเปิด)

- [ ] **SEN-20 — สร้างกลุ่มใหม่จากช่องล่างสุดของแผง** 🆕
  - พิมพ์ชื่อในช่อง "New failure group name" แล้วกด Create (หรือ Enter)
  - ลองพิมพ์ชื่อซ้ำกับกลุ่มเดิม (พิมพ์เล็ก/ใหญ่ต่างกัน)
  - **คาดหวัง:** กลุ่มใหม่ถูกสร้าง และ sensor ตัวนั้นได้ Individual ในกลุ่มนั้นให้เลย (ช่อง Individual เป็น ✓); แถวใหม่โผล่ในหมวด Assigned พร้อมกะพริบสีเขียวสั้นๆ และเลื่อนมาให้เห็น; ชื่อซ้ำ (ไม่สนตัวพิมพ์) ถูกกัน มีข้อความแดงใต้ช่องและไม่สร้าง

- [ ] **SEN-21 — เปลี่ยนชื่อ / ลบกลุ่มจากในแผง (ปุ่ม ⋯)** 🆕
  - วางเมาส์บนแถวกลุ่ม แล้วกด ⋯ ท้ายแถว
  - กด Rename → พิมพ์ชื่อใหม่ → Enter (ลองอีกรอบ → Esc, และรอบที่พิมพ์ชื่อซ้ำกลุ่มอื่น)
  - กด ⋯ → Delete… แล้วกด Cancel (ลองกด Esc ด้วย)
  - กด ⋯ → Delete… → Delete กับกลุ่มที่มีสมาชิก
  - ดูแถว "Not in Group"
  - **คาดหวัง:** กด ⋯ แล้ว 3 ช่อง I/R/C ของแถวนั้นถูกแทนด้วยปุ่ม Rename / Delete… (กันกดพลาด) พร้อมปุ่มย้อนกลับ; Rename: Enter บันทึก (ชื่อเปลี่ยนทุกที่ที่อ้างถึง รวมแท็บ Failure Groups และหน้าต่าง Build Model), Esc ยกเลิก (แผงไม่ปิด), ชื่อซ้ำถูกกันมีข้อความแดง; Delete…: ถามยืนยันในแถวและบอกจำนวนโมเดลที่จะหลุดกลุ่ม ("N models lose this group"), Cancel/Esc ไม่ลบ, Delete แล้วกลุ่มหายและโมเดลที่มีแค่กลุ่มนี้ย้ายไป Not in Group (ไม่ถูกลบ) ส่วนโมเดลที่อยู่กลุ่มอื่นด้วยไม่โดนแตะ; "Not in Group" ไม่มี ⋯ (เปลี่ยนชื่อ/ลบไม่ได้)

- [ ] **SEN-22 — แถว sensor ใช้ชื่อแบบมาตรฐาน (description ก่อน tag) + ช่องค้นหาบอกว่าค้นอะไรได้** 🆕
  - กางกลุ่ม component แล้วดูแถว รวมถึง sensor ที่ไม่มี description และ special sensor (ƒ / Σ)
  - ชี้ชื่อที่ยาวจนถูกตัด
  - เปิดแผง Failure groups ของแถว (ปุ่ม 📁) ดูหัวแผง
  - **คาดหวัง:** บรรทัดแรก description + ป้ายหน่วย, บรรทัดสอง tag สีเทา · ตัวที่ไม่มี description แสดง tag บรรทัดเดียวตัว mono (ไม่มี "no description", ไม่มี tag ซ้ำ) · special sensor มีป้าย ƒ / Σ หน้าชื่อ · ชี้แล้วขึ้นชื่อเต็ม · หัวแผง Failure groups เป็นชื่อแบบเดียวกับแถว · ช่องค้นหาเขียน "Search description, tag, unit or component…"

- [ ] **SEN-11 — ปุ่ม Add Special Sensor เปิดหน้าต่างลูก**
  - กดปุ่มล่างสุดของแผง Sensor
  - **คาดหวัง:** หน้าต่างใหม่เปิดมากลางจอ กดปุ่ม X ปิดได้

---

## SEL

### แท็บ Selected Sensor

- [ ] **SEL-9 — แถวในแท็บ Selected Sensor: ช่องสี (swatch) + ชื่อแบบมาตรฐาน สีตัวหนังสือเป็นกลาง (แทน SEL-1)** 🆕
  - เลือก sensor 3-4 ตัวบนกราฟ Line แล้วดูแต่ละแถว
  - เอาเมาส์ชี้ชื่อที่ยาวจนถูกตัด
  - ดู sensor ที่ไม่มี description ในไฟล์ Tag names
  - **คาดหวัง:** หน้าชื่อมี**ช่องสีสี่เหลี่ยมเล็ก**สีเดียวกับเส้นบนกราฟ (ไม่มีไอคอนหลอดดูดสีแล้ว) · บรรทัดแรก = description + ป้ายหน่วย, บรรทัดสอง = tag (ตัว mono สีเทา) · **ตัวหนังสือเป็นสีปกติ ไม่ใช่สีของเส้นอีกต่อไป** · ชื่อยาวถูกตัดด้วย … และชี้แล้วขึ้นชื่อเต็ม "DESCRIPTION · TAG · UNIT · Component" · ตัวที่ไม่มี description แสดง tag บรรทัดเดียว ไม่มีคำว่า "no description" และไม่มี tag ซ้ำ 2 ครั้ง · ปุ่มตรึงแกน Y ตอนตรึงอยู่เป็นสีฟ้า (ไม่ใช่สีของเส้น)

- [ ] **SEL-2 — ซ่อน/แสดงเส้นด้วย checkbox**
  - ติ๊ก checkbox ออก
  - ติ๊กกลับ
  - **คาดหวัง:** เส้นหาย/กลับมา และแถวจางลงตอนถูกซ่อน

- [ ] **SEL-3 — เปิด/ปิดเส้นแล้วกราฟต้องไม่กระพริบเปลี่ยนสี** 👀
  - เลือก sensor ไว้หลายตัว
  - ติ๊กเปิด-ปิดสลับไปมาเร็ว ๆ หลายรอบ
  - จ้องดูตอนเส้นกำลังหาย
  - **คาดหวัง:** **เส้นที่เหลือต้องคงสีเดิม ห้ามมีจังหวะที่เส้นเปลี่ยนเป็นอีกสีก่อนหาย** (บั๊กที่เพิ่งแก้ — เดิมสีมาจากลำดับ พอเอาตัวหนึ่งออกตัวหลังเลื่อน slot)

- [ ] **SEL-11 — เปลี่ยนสีเส้นด้วยตัวเลือกสี (palette 12 สี + Custom, ไม่มีรหัสสี) (แทน SEL-10)** 🆕
  - กดช่องสีหน้าชื่อ sensor
  - เลือก sensor ที่ชื่อ (description) ยาว แล้วดูว่าช่องสีทั้ง 12 ช่องอยู่ในกรอบ popover ขนาดเท่ากัน ชื่อบนหัวที่ยาวถูกย่อเป็น "…"
  - ดูพาเลท 12 สี: สีปัจจุบันมีวงขาว + เครื่องหมายถูก · สีที่ sensor ตัวอื่นบนกราฟใช้อยู่มีจุดเล็กที่มุม + คำอธิบาย "In use on this chart"
  - กดสีอื่นในพาเลท (popover ยังเปิดอยู่) แล้วกด Esc
  - เปิดอีกครั้ง กด "Custom colour" ลากในสี่เหลี่ยมสี/แถบ hue · เอาเมาส์ชี้ช่องสีในพาเลท
  - ใช้คีย์บอร์ด: Tab ไปที่ช่องสี → Enter เปิด → ลูกศรเลื่อนในพาเลท → Enter เลือก → Tab ไปจนพ้นตัวสุดท้าย
  - ปิดเปิดโปรแกรม
  - **คาดหวัง:** สีเปลี่ยนทันทีทั้งกราฟและช่องสี และยังอยู่หลังเปิดใหม่ · ไม่มีหน้าต่างเลือกสีของ Windows โผล่มา · ไม่มีรหัสสี (เช่น #3b82f6) แสดงที่ใดเลย: ไม่มีบนหัว popover ไม่มีช่องพิมพ์รหัส และ tooltip ของช่องสีเป็นชื่อสี (เช่น "Blue") · ช่องสีไม่ล้นกรอบแม้ชื่อ sensor ยาว · Esc ปิดแล้วโฟกัสกลับมาที่ช่องสี · Tab พ้นตัวสุดท้ายแล้ว popover ปิด · เปิดตัวเลือกสีแล้วกดปุ่มตรึงแกน Y = ตัวเลือกสีปิด (ไม่ซ้อนกัน 2 อัน)

- [ ] **SEL-5 — ตรึงช่วงแกน Y ต่อ sensor**
  - ตั้ง min/max ของ sensor หนึ่ง
  - ล้างค่าออก
  - **คาดหวัง:** แกนของเส้นนั้นถูกตรึงตามที่ตั้ง และล้างแล้วกลับไป auto

- [ ] **SEL-6 — เอา sensor ออกจากกราฟทีละตัว**
  - กดปุ่ม Remove from plot
  - **คาดหวัง:** หายจากกราฟและจากรายการ, ในแผง Sensor ติ๊กหลุดตาม

- [ ] **SEL-7 — Clear all**
  - กด Clear all
  - **คาดหวัง:** เอาออกหมด กราฟว่าง ขึ้นข้อความ "No sensors plotted yet"

- [ ] **SEL-8 — สลับไป Scatter / Pair Plot แล้ว control เปลี่ยน**
  - สลับ chart type
  - **คาดหวัง:** ปุ่มซ่อน/สี/แกน หายไป (เพราะใช้ไม่ได้กับ 2 โหมดนี้) และขึ้นกล่องน้ำเงินอธิบายวิธีใช้แทน

---

## FIL

### แท็บ Filter

_แผงนี้ใช้ draft state — แก้/เพิ่ม/ลบแถว filter ยังไม่มีผลกับกราฟจนกว่าจะกด **Apply Filter** เป็นการตั้งใจออกแบบ (กันไม่ให้ยิง query รัวทุกครั้งที่พิมพ์) ไม่ใช่บั๊ก — อย่าลืมกดปุ่มนี้ก่อนเช็คผลทุกข้อในหมวดนี้_

- [ ] **FIL-1 — เพิ่ม filter ทีละแบบ**
  - less than
  - greater than
  - between (min/max)
  - equals
  - กด Apply Filter
  - **คาดหวัง:** ทั้ง 4 แบบกรองได้จริงหลังกด Apply จำนวนจุดบน badge ลดลงตาม

- [ ] **FIL-2 — หลาย filter พร้อมกัน**
  - ใส่ filter 2-3 ตัวคนละ sensor
  - กด Apply Filter
  - **คาดหวัง:** รวมกันแบบ AND (ต้องผ่านทุกเงื่อนไข)

- [ ] **FIL-3 — ลบ filter**
  - กดปุ่มลบของแถว filter
  - กด Apply Filter
  - **คาดหวัง:** ข้อมูลกลับมา — **ต้องกด Apply Filter ก่อนถึงจะมีผล การลบแถวเฉย ๆ ยังไม่คืนค่าให้ทันที (เป็น draft state ที่ตั้งใจออกแบบไว้)**

- [ ] **FIL-4 — filter มีผลกับทุกโหมดกราฟ**
  - ตั้ง filter ไว้
  - สลับ Line → Scatter → Pair Plot
  - **คาดหวัง:** ทุกโหมดเห็นข้อมูลที่ถูกกรองชุดเดียวกัน

- [ ] **FIL-6 — filter บน sensor ที่ถูกเอาออกจากกราฟ: ยังอยู่และยังกรองอยู่ + มีคำเตือนสีเหลือง (แทน FIL-5)** 🆕
  - ตั้ง filter บน sensor A แล้วกด Apply filter
  - เอา A ออกจากกราฟ (Remove from plot หรือเอาติ๊กออกในแผง Sensor)
  - ดูแถว filter นั้นในแท็บ Filter แล้วกด "Show on chart"
  - เอา A ออกอีกครั้ง แล้วกด "Remove" ในข้อความใต้แถว แล้วกด Apply filter
  - **คาดหวัง:** แถว filter **ไม่หายไปเอง** และยังกรองข้อมูลอยู่ (จำนวนจุดบนกราฟเท่าเดิม) · หน้าแถวมีไอคอน ⚠ และกรอบช่อง sensor เป็น**เส้นทึบสีเหลือง** (ไม่ใช่เส้นประ) · ใต้แถวมีข้อความ "<description> <tag> is not on the chart. The filter still applies." พร้อมปุ่ม Show on chart / Remove · Show on chart เอา A กลับขึ้นกราฟ (คำเตือนหายไป) · Remove ลบแถวนั้นออก

- [ ] **FIL-8 — "Show on chart" บน Pair Plot ที่มี sensor ครบ 4 ตัวแล้ว: กดไม่ได้และบอกเหตุผล** 🆕
  - บน Line เลือก sensor A, B, C, D ตั้ง filter บน A แล้วกด Apply filter
  - เอา A ออกจากกราฟ แล้วเลือก E เพิ่ม (บนกราฟเหลือ B, C, D, E = 4 ตัว) แล้วสลับเป็น Pair Plot
  - ชี้เมาส์ที่ปุ่ม "Show on chart" ในข้อความใต้แถว แล้วสลับกลับเป็น Line
  - **คาดหวัง:** บน Pair Plot ปุ่ม "Show on chart" **จางลงกดไม่ได้** ชี้แล้วขึ้น "Pair Plot shows at most 4 sensors" (ไม่ใช่กดแล้วเงียบ) · บน Line กดได้ตามปกติ · ปุ่ม Remove ยังใช้ได้ตลอด

- [ ] **FIL-7 — เลือก sensor ของ filter ด้วยตัวเลือกแบบ popover + หน่วยท้ายช่องค่า** 🆕
  - กด Add condition แล้วกดช่อง sensor ของแถว
  - ดูบรรทัด "Sensors on the chart · N" ใต้ช่องค้นหา แล้วพิมพ์ค้นด้วย description, tag, หน่วย และชื่อ component
  - กด ↓ / ↑ แล้ว Enter เพื่อเลือก, เปิดใหม่แล้วกด Esc
  - เลือกตัวดำเนินการ between แล้วดูช่องค่า min / max
  - ลองเปิดตัวเลือกในแถวที่อยู่ล่างสุดของหน้าจอ (หน้าต่างเตี้ย)
  - **คาดหวัง:** เปิดเป็น popover ใต้ช่อง (ไม่ใช่ dropdown ของ Windows) — กดครั้งเดียวเลือกแล้วปิด ไม่มีปุ่ม OK · รายการมีแค่ sensor ที่อยู่บนกราฟ · ค้นได้ทั้ง 4 แบบ และกลุ่ม component ที่มีผลลัพธ์กางออกเอง · ชื่อในช่องเป็น description ตามด้วย tag (ไม่มีวงเล็บ) · ช่องค่ามีหน่วยต่อท้ายจางๆ (เช่น `BAR`) · Esc ปิดแล้วโฟกัสกลับที่ช่อง · แถวล่างสุดเปิด popover ขึ้นด้านบนแทน ไม่ตกขอบจอ · หน้าต่างแคบ แถว between ยังอ่านออก (ช่อง sensor ขึ้นบรรทัดของตัวเอง)

---

## HL

### แท็บ Highlights

_By time ใช้กับ Line/Scatter · By value ใช้กับ Scatter เท่านั้น · Pair Plot ไม่อ่านแท็บนี้เลย (ตั้งใจ)_

- [ ] **HL-9 — By time — เพิ่มช่วงเวลา + เปลี่ยนสีด้วยตัวเลือกสีแบบใหม่ (แทน HL-1)** 🆕
  - เพิ่มช่วง
  - ใส่ label
  - กดช่องสีหน้าชิปแล้วเลือกสีจากพาเลท
  - **คาดหวัง:** แถบสีขึ้นบนกราฟตรงช่วงที่กำหนด · ตัวเลือกสีเป็นแบบเดียวกับแท็บ Selected Sensor (พาเลท 12 สี + จุดบอกสีที่ highlight อื่นใช้อยู่ + Custom) · สีบนกราฟเปลี่ยนทันที

- [ ] **HL-2 — By time — toggle / rename / ลบ**
  - ปิด-เปิดช่วง
  - เปลี่ยนชื่อ
  - ลบ
  - **คาดหวัง:** ทำได้ครบและกราฟตามทันที

- [ ] **HL-3 — เพิ่มหลายช่วงพร้อมกัน**
  - เพิ่ม 3 ช่วงคนละสี
  - **คาดหวัง:** ขึ้นครบทุกช่วง ไม่ทับกันมั่ว

- [ ] **HL-10 — By value (Scatter): "Colour by…" เป็นตัวเลือก sensor แบบ popover + หน่วยและตัวคั่นหลักพัน (แทน HL-5)** 🆕
  - สลับไป Scatter แล้วกด "Colour by…"
  - เลือก sensor (รายการมีบรรทัด "Sensors on the chart · N")
  - เพิ่มช่วง min/max เช่น 1500 – 12345.5 แล้วดูชิป และดูช่อง min/max
  - สลับไป Line และ Pair Plot แล้วดูช่อง "Colour by…"
  - **คาดหวัง:** จุดในช่วงเปลี่ยนสีตาม · ชิปเขียน `1,500 – 12,345.5 <หน่วย>` · ช่อง min/max มีหน่วยต่อท้ายจางๆ · บน Line ช่อง "Colour by…" กดไม่ได้จริง (จาง) และเขียนเหตุผล "Colour by… (Scatter only)" — บน Pair Plot "Colour by… (not on Pair Plot)" — ถ้าเลือก sensor ไว้แล้ว ยังเห็นชื่อ sensor ในช่องที่จางอยู่

- [ ] **HL-12 — By value: "Colour by…" ล้างกลับเป็นไม่เลือกได้ (None) + ช่วงค่าเล็ก ๆ ไม่ถูกปัดเป็น 0** 🆕
  - บน Scatter เลือก sensor ใน "Colour by…" แล้วเปิดตัวเลือกอีกครั้ง กดแถวบนสุด **None**
  - เลือก sensor ใหม่ แล้วเพิ่มช่วง min/max เป็น `0.0001` – `0.0004`
  - **คาดหวัง:** กด None แล้วช่องกลับเป็น "Colour by…" และสีตามช่วงหายจาก Scatter · ชิปช่วงเขียน `0.0001 – 0.0004` (ทศนิยมครบตามที่พิมพ์ ไม่ใช่ `0 – 0`)

- [ ] **HL-11 — By value — toggle / ลบ / เปลี่ยนสี (ตัวเลือกสีแบบใหม่) (แทน HL-6)** 🆕
  - ปิด-เปิดช่วง
  - กดช่องสีของช่วงแล้วเลือกสี (ดูจุดบอกสีที่ช่วงอื่นใช้อยู่)
  - เปิดตัวเลือกสีค้างไว้แล้วสลับกราฟเป็น Line แล้วกลับ Scatter
  - ลบ
  - **คาดหวัง:** ทำได้ครบ · ตัวเลือกสีปิดเองเมื่อสลับกราฟ และไม่โผล่กลับมาเองตอนสลับกลับ

- [ ] **HL-7 — Pair Plot ไม่ถูก highlight กระทบ**
  - ตั้ง highlight ไว้
  - สลับไป Pair Plot
  - **คาดหวัง:** Pair Plot ไม่เปลี่ยนสีตาม (ตั้งใจให้ใช้ lasso cluster ของตัวเองแทน)

- [ ] **HL-8 — By time เป็นแถบเสมอ ไม่มีสวิตช์ Band / Line colour แล้ว** 🆕
  - เปิดแท็บ Highlights ที่กราฟ Line, Scatter และ Pair Plot ตามลำดับ
  - ตั้ง highlight แบบ By time 1-2 ช่วงแล้วดูกราฟ Line
  - เปิด workspace เก่าที่เคยเลือก "Line colour" ไว้ก่อนอัปเดตนี้ (ถ้ามี)
  - **คาดหวัง:** หัวคอลัมน์ By time **ไม่มีปุ่ม Band / Line colour** และบน Scatter ไม่มีข้อความ "Not adjustable here…" อีก · บนกราฟ Line ทุกช่วงขึ้นเป็น**แถบสีโปร่งพื้นหลัง** (เส้นข้อมูลไม่ถูกเปลี่ยนสี/ไม่หนาขึ้น) · Scatter ยังขึ้นเป็นวงแหวนรอบจุดเหมือนเดิม · workspace เก่าที่เคยตั้ง Line colour เปิดได้ปกติ ไม่ error และ highlight ของมันขึ้นเป็นแถบ · ข้อความใต้คอลัมน์บอกว่า Line เป็นแถบ ไม่มีคำว่า "recolours itself"

---

## TIME

### ช่วงเวลา & Aggregation

- [ ] **TIME-9 — เลือกช่วงเวลาด้วย Start / End: ปฏิทินคนละปุ่มทั้งสองฝั่ง (แทน TIME-1, แก้แล้ว 2026-10-09)** 👀
  - ที่แถบช่วงเวลาใต้กราฟ ดูว่ามีไอคอนปฏิทินกี่อันและอยู่ตรงไหน
  - กดไอคอนปฏิทินข้างวันเริ่ม เลือกวัน → กดไอคอนปฏิทินข้างวันจบ เลือกวัน
  - คลิกที่ตัวเลขวันที่ของวันเริ่มแล้วพิมพ์ตัวเลขทับ (เช่น เปลี่ยนชั่วโมง) โดยไม่ใช้ปฏิทิน
  - ลองกับ Scatter / Line / Pair Plot
  - **คาดหวัง:** มีไอคอนปฏิทิน **2 อัน — ต่อท้ายช่องวันเริ่ม 1 อัน และต่อท้ายช่องวันจบ 1 อัน** · กดอันไหนก็เปิดตัวเลือกวันที่ของ**ฝั่งนั้น** (เดิมมีอันเดียวหน้าวันเริ่ม และกดแล้วไม่มีอะไรเกิดขึ้น) · คลิกที่ตัวเลขวันที่ = พิมพ์แก้ได้เลย ตัวเลือกวันที่ไม่เด้งขึ้นมาบัง · กราฟตัดเหลือเฉพาะช่วงนั้น จำนวนจุดลดลง

- [ ] **TIME-2 — Relative range ยึดจากวันสุดท้ายของข้อมูล ไม่ใช่วันนี้ (แก้แล้ว 2026-09-22)** 🆕
  - ใช้ข้อมูลย้อนหลัง (ปีล่าสุดของข้อมูลไม่ใช่ปีนี้) ใส่จำนวน + เลือกหน่วย (Y/M/W/D/H)
  - กดปุ่ม ✓ Apply
  - **คาดหวัง:** ต้องกด Apply ก่อนถึงมีผล — ก่อนกด tooltip ควรบอกว่า "Selected — click ✓ Apply" — และช่วงที่ได้ต้องนับถอยหลังจาก**วันสุดท้ายของข้อมูล** (ดู label "Data: ..." ที่ TIME-8) **ไม่ใช่วันที่ปัจจุบันของเครื่อง** — เดิมนับจากวันนี้ ทำให้ข้อมูลย้อนหลังกด 1M/6M/1Y แล้วได้ 0 จุดเสมอถ้าปีข้อมูลไม่ตรงปีปัจจุบัน

- [ ] **TIME-3 — Reset Period**
  - กด Reset Period
  - **คาดหวัง:** ช่วงเวลากลับไปเต็มช่วงข้อมูล (ตรงกับ label "Data: ...") แต่ **Aggregation ต้องไม่ถูกรีเซ็ตไปด้วย**

- [ ] **TIME-4 — Aggregation ครบ 6 แบบ**
  - สลับ Raw / Avg / Max / Min / First / Last
  - **คาดหวัง:** เส้นเปลี่ยนรูปตามวิธี aggregate และ badge บนหัวกราฟเปลี่ยนตาม (เช่น `AVG (1h)`)

- [ ] **TIME-5 — ระยะห่างบนแกนเวลาต้องสัมพันธ์กับเวลาจริง (แก้แล้ว 2026-09-16)** 🆕
  - ตั้งช่วงกว้าง 10 นาที ดูระยะห่างระหว่างจุด
  - ตั้งช่วงกว้าง 10 ชั่วโมง ดูอีกครั้ง
  - ใช้ข้อมูลที่มีช่วงว่าง (เครื่องหยุด) คั่นกลาง
  - **คาดหวัง:** **ระยะห่างต้องไม่เท่ากัน** และช่วงที่ไม่มีข้อมูลต้องเห็นเป็นช่องว่างจริงบนแกน — แกน x ถูกเปลี่ยนจาก category เป็น time axis แล้ว (เดิมทุกจุดห่างเท่ากันไม่ว่าเวลาจะห่างแค่ไหน) ⚠ ข้อแลกเปลี่ยนที่รู้แล้ว: กราฟอาจรู้สึกช้ากว่าเดิมเล็กน้อย (ดู PERF-6)

- [ ] **TIME-6 — สร้าง project ใหม่ ครั้งแรกที่เข้า Dashboard ต้องเห็นข้อมูล 6 เดือนล่าสุดของ dataset เป็นค่าเริ่มต้น (แก้แล้ว 2026-09-22)** 🆕
  - Import CSV ใหม่ (project ที่ไม่เคยเปิดมาก่อน) เข้า Dashboard ครั้งแรก
  - ดูช่อง Start/End และปุ่มหน่วยที่ไฮไลต์
  - **คาดหวัง:** ช่วงเวลาตั้งต้นเป็น **6 เดือนล่าสุดของข้อมูลจริง** (ไม่ใช่ข้อมูลทั้งหมด และไม่ใช่ 6 เดือนล่าสุดจากวันนี้) ปุ่ม **M** ไฮไลต์แบบ "กำลังใช้งาน" (พื้นสีทึบ) ช่อง amount แสดง `6` — เดิม (ก่อนแก้) กราฟแสดงข้อมูลทั้งหมดของ dataset เป็นค่าเริ่มต้นเสมอ

- [ ] **TIME-7 — Label "Data: ..." บอกช่วงข้อมูลทั้งหมดเสมอ** 🆕
  - เปิด workspace ที่มีข้อมูล ดูข้อความ "Data: ..." ข้าง Reset Period
  - ลองตั้ง time filter แคบๆ ดูว่า label เปลี่ยนไหม
  - **คาดหวัง:** label แสดง timestamp แรก-สุดท้ายของ**ทั้ง dataset** ตรงกับไฟล์ต้นฉบับ และ**ไม่เปลี่ยนตาม filter ที่ตั้งไว้** (ต่างจากตัวเลข "N Points" ที่เปลี่ยนตาม filter)

- [ ] **TIME-8 — ค่าเริ่มต้น 6 เดือนไม่บังคับทับ workspace ที่เคยตั้ง/ล้างช่วงเวลาไว้แล้ว** 🆕
  - เปิด workspace ที่เคยกด Reset Period ไว้ (เคยดูข้อมูลทั้งหมด) ปิดโปรแกรมแล้วเปิดใหม่ กลับมาที่ workspace เดิม
  - **คาดหวัง:** ยังคงแสดงข้อมูลทั้งหมดเหมือนตอนปิด **ไม่ถูกดึงกลับไปเป็น 6 เดือนล่าสุด** — ค่าเริ่มต้น 6 เดือนใช้แค่ครั้งแรกสุดที่ project ยังไม่เคยตั้งช่วงเวลาอะไรเลยเท่านั้น

---

## LINE

### Line chart

- [ ] **LINE-1 — เส้นขึ้นครบและสีตรงกับ swatch**
  - เลือก 5-6 sensor
  - **คาดหวัง:** ครบทุกเส้น สีตรงกับที่แสดงในแท็บ Selected Sensor

- [ ] **LINE-10 — Tooltip: ชื่อแบบมาตรฐาน + ค่า + หน่วย ตัวคั่นหลักพัน (แทน LINE-2)** 🆕
  - เลือก sensor ที่มีค่าเกิน 1,000 และตัวที่ไม่มี description แล้วเอาเมาส์ชี้บนกราฟ
  - **คาดหวัง:** หัว tooltip เป็นเวลา · แต่ละแถวมีสี่เหลี่ยมสีของเส้น + description ตามด้วย tag (ตัวเล็กสีเทา ไม่มีวงเล็บ) ชิดซ้าย และ**ค่า + หน่วยชิดขวาเป็นสีของเส้น** เช่น `6,425.308 KW` (3 ตำแหน่ง มีตัวคั่นหลักพัน) · ตัวที่ไม่มี description แสดง tag อย่างเดียว · ไม่มีเลข timestamp ดิบโผล่ · description ยาวถูกตัดด้วย …

- [ ] **LINE-15 — วันที่บนแกนเวลาของทุกกราฟ: ระยะห่างเท่ากันทุกช่อง ไม่ทับกัน (แทน LINE-14)** 🆕
  - Dashboard กราฟ Line: เลือกช่วงประมาณ 3 เดือน (เช่น Last 3 M) แล้วดูวันที่ใต้กราฟ โดยเฉพาะรอบสิ้นเดือน / ต้นเดือน
  - ย่อ/ขยายความกว้างของหน้าต่าง และลองช่วง 1 เดือน, 6 เดือน, 1 ปี
  - ซูมเข้าไปจนเหลือ 2–3 วัน และจนเหลือไม่ถึง 1 วัน แล้วลากไปมา
  - ทำซ้ำกับกราฟเวลาในหน้า Model fit และ Health score ของ Workbench
  - **คาดหวัง:** ป้ายวันที่**ห่างเท่ากันทุกช่อง** (เช่น ทุก 7 วัน หรือทุก 10 วัน ต่อเนื่องข้ามสิ้นเดือน — ไม่มีช่องที่กว้างกว่าช่องอื่นตรงรอยต่อเดือนเหมือนเดิม) และไม่มีป้ายพิมพ์ทับกัน · จำนวนป้ายปรับตามความกว้าง: หน้าต่างแคบป้ายห่างขึ้น หน้าต่างกว้างป้ายถี่ขึ้น · ช่วงยาวเป็นปีใช้ป้ายต้นเดือน (ทุก 1–3 เดือน) · ซูมถึงระดับวันเดียว ป้ายเป็นวันที่ + เวลา (เช่น `2026/05/19 12:00`) ห่างเท่ากัน · ลากกราฟแล้วป้ายอยู่วันเดิม ไม่เลื่อนไปมา · รูปแบบวันที่เป็น `YYYY/MM/DD` · การชี้เมาส์และการซูมไม่ช้าลง

- [ ] **LINE-13 — Tooltip แสดงครบทุก sensor ที่เปิดอยู่** 🆕
  - เลือกช่วงเวลาที่มีข้อมูลมากกว่า 2,000 จุด เปิด sensor 3 ตัวขึ้นไป แล้วเลื่อนเมาส์ไปหลายตำแหน่งบนกราฟ
  - ซ่อน sensor 1 ตัวด้วยช่องติ๊กในแท็บ Selected Sensor แล้วชี้อีกครั้ง
  - ถ้ามี sensor ที่ข้อมูลขาดบางช่วง ให้ชี้ตรงช่วงที่ขาด
  - **คาดหวัง:** tooltip มีแถวครบทุก sensor ที่แสดงอยู่ทุกตำแหน่ง (ไม่ใช่ 1–2 แถว) เรียงตามลำดับที่เลือก สีตรงกับเส้น · sensor ที่ซ่อนไม่มีแถว · sensor ที่ไม่มีค่าตรงเวลานั้นยังมีแถว แสดงเป็น "—" ไม่มีหน่วย · เปิดเกิน 10 sensor แสดง 10 แถวแรก · tooltip ยังตามเมาส์ทัน

- [ ] **LINE-12 — Tooltip ตามเมาส์ทันแม้มี sensor ที่เส้นแกว่งถี่** 🆕
  - เลือกช่วงเวลาที่มีข้อมูลมากกว่า 2,000 จุด แล้วเปิด sensor 3 ตัว โดยให้ตัวหนึ่งเป็น sensor ที่สัญญาณแกว่งถี่จนเส้นเป็นแถบทึบ (เช่น BOILER FEED WATER FLOW METER)
  - เลื่อนเมาส์ไปมาบนกราฟเร็ว ๆ
  - ลองซ้ำกับช่วงเวลาสั้น ๆ ที่มีข้อมูลไม่ถึง 2,000 จุด
  - **คาดหวัง:** เส้นประแนวตั้งและกล่อง tooltip ตามเมาส์ทันที ไม่หน่วง ไม่กระตุก · ค่าใน tooltip ยังถูกต้อง · ไม่มีจุดเน้นบนเส้นตรงตำแหน่งที่ชี้ ไม่ว่าข้อมูลมากหรือน้อย · Tag point, Horizontal zoom, เส้น alarm และแถบ highlight ยังทำงานเหมือนเดิม

- [ ] **LINE-3 — Zoom — เมนู "Horizontal zoom / Zoom out" (แทนแถบเลื่อนเดิม)** 🆕
  - ดูใต้กราฟ: **ต้องไม่มีแถบเลื่อน (slider) แล้ว**
  - กดไอคอนแว่นขยายที่มุมบนขวาของกราฟ (ข้างไอคอน Tag) ให้เมนูเปิด
  - เลือก "Horizontal zoom" แล้วลากคลุมช่วงเวลาบนกราฟ ปล่อยเมาส์
  - ทำซ้ำเพื่อซูมลึกขึ้นอีกชั้น
  - เลือก "Zoom out"
  - **คาดหวัง:** เมนู**ไม่ถูกตัดขอบ**อ่านครบทั้งสองข้อความ, ขณะลากมีกรอบสีฟ้าโชว์ช่วงที่เลือก, **ปล่อยแล้วกราฟซูมเข้าช่วงนั้นจริง** (เคยลากได้แต่ปล่อยแล้วไม่ซูม), Zoom out ถอยกลับทีละขั้น ลื่นไหล ข้อมูลไม่เพี้ยน

- [ ] **LINE-3b — ขยาย Time Range หลังซูมไว้ กราฟต้องไม่ค้างช่วงเก่า** 🆕
  - ซูมเข้าไปช่วงแคบ ๆ
  - ขยายช่วงเวลาที่ Time Range ให้กว้างขึ้นมาก (เช่น 1 เดือน → 4 เดือน)
  - **คาดหวัง:** กราฟกลับมาแสดงเต็มช่วงใหม่ทั้งช่วง ไม่ค้างที่ช่วงที่ซูมไว้จนเห็นแค่ส่วนเดียว (เคยเป็นบั๊ก: แถบเลื่อนสั้นกว่าที่ควร ทำให้ดูเหมือนข้อมูลขาดหาย)

- [ ] **LINE-4 — ไม่มี legend บนตัวกราฟ — ซ่อน/แสดงเส้นทำที่แท็บ Selected Sensor เท่านั้น**
  - ดูใต้/รอบกราฟ Line ว่ามี legend ของ ECharts ให้กดหรือไม่
  - ไปที่แท็บ Selected Sensor แล้วติ๊ก checkbox ออก (ดู SEL-2)
  - **คาดหวัง:** **ยืนยันแล้วในโค้ด — ไม่มี ECharts legend อยู่บนกราฟเลย** (เอาออกไปแล้ว เพราะชื่อ sensor อยู่ในแท็บ Selected Sensor อยู่แล้ว) การซ่อน/แสดงเส้นทำได้ทางเดียวคือ checkbox ในแท็บนั้น — ถ้าเห็น legend โผล่มาบนกราฟจริง ๆ ถือเป็นเรื่องแปลกให้รายงาน

- [ ] **LINE-5 — เส้น alarm setpoint**
  - เปิด alarm ของ 2-3 sensor
  - **คาดหวัง:** เส้นขึ้นพร้อม label LL / L / H / HH และไม่บังเส้นข้อมูลจนอ่านไม่ออก

- [ ] **LINE-6 — Tagged points**
  - กดไอคอน Tag ที่มุมกราฟก่อน (ต้องเปิดโหมดนี้ก่อน คลิกกราฟเฉย ๆ โดยไม่เปิดโหมดจะไม่ทำอะไรเลย)
  - คลิกจุดบนเส้นเพื่อปัก tag
  - ปักหลายจุด
  - คลิกจุดที่ปักไว้แล้วซ้ำอีกที
  - กด Clear all tags
  - **คาดหวัง:** เปิดโหมดแล้วคลิกถึงปักได้ (ทดสอบซ้ำหลังเปลี่ยนเป็นแกนเวลา — เคยคลิกไม่ติดเลย แก้แล้ว), คลิกจุดที่ปักไว้ซ้ำ = เอาออก, Clear all ล้างหมดทีเดียว — tag พวกนี้ตั้งใจไม่ให้อยู่ข้ามการปิดโปรแกรม

- [ ] **LINE-16 — ค่าของ Tag point อยู่ในแท็บ "Tagged points" ของ panel ล่าง ไม่มีกล่อง / ไม่มีเลขบนกราฟ (แทน LINE-11)** 🆕
  - เปิด sensor 5 ตัว (มีทั้ง description ยาวและตัวที่ไม่มี description) เปิดแท็บ Filter ของ panel ล่างค้างไว้ แล้วเปิดโหมด Tag ปัก **2 จุดที่อยู่ใกล้กันมาก** จากนั้นปักเพิ่มจนครบ 8 จุด
  - ดูบนกราฟ และดู panel ล่าง · เลื่อนตารางไปทางขวา / ลงล่าง · เอาเมาส์ชี้ช่องค่า
  - กดไปแท็บ Highlights แล้วกลับมาแท็บ Tagged points · ซ่อน panel ล่าง (ปุ่มรูปตา) แล้วเปิดกลับ
  - เปลี่ยน Aggregation หรือช่วงเวลา ขณะที่ยังมี tag อยู่ · สลับไป Scatter แล้วกลับมา Line · กด Clear all tags
  - **คาดหวัง:** **บนกราฟไม่มีกล่องค่าและไม่มีตัวเลข / สัญลักษณ์ในจุด** — แต่ละ tag เป็นจุดกลม**สีล้วน**บนเส้นของ sensor ตัวแรก + เส้นประแนวตั้งสีเดียวกัน · tag ที่อยู่ชิดกันไม่มีอะไรทับกัน และ tooltip ตอนชี้เมาส์ไม่ถูกบัง · **ใต้กราฟไม่มีตาราง** กราฟสูงเท่าเดิมไม่ว่าจะมี tag หรือไม่ · พอปัก tag แรก panel ล่าง**สลับไปแท็บ "Tagged points (N)" เอง** (ตัวเลขในชื่อแท็บ = จำนวน tag) และตารางเต็มพื้นที่แท็บ: คอลัมน์ซ้าย "Sensor" (จุดสีของเส้น + description + tag สีเทา; ไม่มี description แสดง tag อย่างเดียว) คอลัมน์ถัดไป tag ละคอลัมน์ หัวคอลัมน์ = **จุดสีเดียวกับจุดบนกราฟ** (ไม่มีเลข) + เวลา `2026/04/23 15:05:00` + ปุ่ม × · ค่า + หน่วยชิดขวาตรงกันทุกแถว · sensor ที่ไม่มีค่า ณ เวลานั้นแสดง "—" · แถว / คอลัมน์เกินพื้นที่เลื่อนได้ หัวตารางและคอลัมน์ชื่อ sensor ค้างอยู่ · ไปแท็บอื่นแล้วกลับมา ตารางและ tag อยู่ครบ; ซ่อน panel แล้ว tag บนกราฟยังอยู่ เปิดกลับตารางกลับมา · เปลี่ยน Aggregation แล้วเวลาในหัวคอลัมน์ ตำแหน่งจุด และค่า ขยับไปจุดที่ใกล้ที่สุดพร้อมกัน · สลับไป Scatter ชื่อแท็บกลับเป็น "Tagged points" (Scatter มี tag ของตัวเอง) กลับมา Line tag เดิมกลับมาพร้อมตัวเลขในชื่อแท็บ **โดยไม่ดึงให้สลับแท็บเอง** · Clear all แล้วแท็บขึ้นข้อความ "No tagged points yet — turn on the Tag tool…" · ที่ Pair Plot แท็บขึ้น "Pair Plot has no tagged points…"

- [ ] **LINE-7 — Time highlight บนเส้น**
  - ตั้ง highlight by time ไว้
  - **คาดหวัง:** แถบขึ้นตรงช่วงเวลาที่ถูกต้อง ไม่เลื่อนเวลาผิด timezone

- [ ] **LINE-8 — Downsample badge**
  - ดูข้อมูลเต็มช่วง
  - ย่อช่วงเวลาให้แคบลงเรื่อย ๆ
  - **คาดหวัง:** พอจุดน้อยกว่าเพดานแล้ว badge ต้องเลิกบอกว่า downsampled

- [ ] **LINE-17 — ลบ tag ทีละอัน (ปุ่ม × ที่หัวคอลัมน์ในแท็บ Tagged points) (แทน LINE-9)** 🆕
  - เปิดโหมด Tag แล้วปัก 3 จุดบนกราฟ Line
  - ดูหัวคอลัมน์ของตารางในแท็บ Tagged points: จุดสีเดียวกับ marker · เวลา · ปุ่ม ×
  - กด × ของ tag ตรงกลาง
  - ปิดโหมด Tag แล้วกด × ของอีกอัน, ลองกด Tab ไปที่ปุ่ม × แล้วกด Enter ต่อกันจนลบหมด
  - ปัก tag ใหม่อีกอัน แล้ว**เปิดเมนู Zoom (แว่นขยาย) ตอนที่ยังมี tag อยู่**
  - **คาดหวัง:** หายไปเฉพาะ tag ที่กด (ทั้งจุดบนกราฟ เส้นประ และคอลัมน์ของมัน) ตัวอื่นอยู่ครบและ**สีเดิม** · ตัวเลขในชื่อแท็บลดลงตาม · ลบได้แม้ปิดโหมด Tag อยู่ · ใช้คีย์บอร์ดได้ และหลังกด Enter ที่ × แล้ว**โฟกัสย้ายไปที่ × ของคอลัมน์ถัดไป** (ถ้าเป็นคอลัมน์สุดท้ายย้ายไปคอลัมน์ก่อนหน้า, ลบอันสุดท้ายแล้วโฟกัสไปอยู่ที่ปุ่ม Tag ในแถบเครื่องมือของกราฟ) — กด Enter ซ้ำลบต่อได้เลยไม่ต้องกด Tab ใหม่ · tag ใหม่ได้สีที่ว่าง ไม่ซ้ำกับสีที่ยังอยู่บนกราฟ · ลบอันสุดท้ายแล้วตารางหายเป็นข้อความ "No tagged points yet…" และปุ่ม Clear all หาย · เมนู Zoom เปิดได้ปกติ (มุมขวาบนของกราฟไม่มีรายการ tag ลอยอยู่แล้ว)

---

## SCAT

### Scatter plot

_โหมดนี้คือตัวที่เคยพังทั้งหมดใน 0.4.0 เพราะ CSP — ให้ดูละเอียด_

- [ ] **SCAT-1 — ปุ่ม Scatter กดไม่ได้ตอนเลือก sensor ไม่ถึง 2 ตัว**
  - เลือก sensor แค่ 1 ตัว
  - **คาดหวัง:** ปุ่มถูก disable และ tooltip บอกว่า "Select at least 2 sensors"

- [ ] **SCAT-2 — จุดขึ้นจริงบนกราฟ** 👀
  - เลือก 2+ sensor แล้วกด Scatter
  - **คาดหวัง:** **เห็นจุดจริง ไม่ใช่พื้นที่ว่าง** — ถ้าว่างเปล่าคือ CSP `unsafe-eval` หายไปอีกแล้ว (regl คอมไพล์ draw command ตอน runtime)

- [ ] **SCAT-10 — เลือกแกน X / Y ด้วยตัวเลือกแบบ popover ขนาดเล็ก (แทน SCAT-3 — dropdown ของ Windows ถูกเลิกใช้)** 🆕
  - ดูช่อง X และ Y เหนือกราฟ (ป้าย "X"/"Y" เล็กๆ อยู่ข้างนอก)
  - กดช่อง X: ดูบรรทัด "Sensors on the chart · N" แล้วค้นหาและเลือก
  - กดช่อง Y ซึ่งอยู่ชิดขวา
  - ใช้คีย์บอร์ด: Tab ไปที่ช่อง → Space หรือ ↓ เปิด → ↑↓ → Enter
  - ปิดเปิดโปรแกรม
  - **คาดหวัง:** ช่องเตี้ย (ราว 24 px) เขียน description ตามด้วย tag (ช่องแคบมากแล้ว tag ซ่อน แต่ชี้ค้างยังเห็นชื่อเต็ม) · เปิดเป็น popover ไม่ใช่ dropdown ของ Windows · popover ของ Y เปิดชิดขวาไม่หลุดขอบกราฟ · เลือกแล้วกราฟเปลี่ยนทันที และค่าที่เลือกยังอยู่หลังเปิดใหม่

- [ ] **SCAT-12 — ชื่อแกนของ Scatter เป็น 2 บรรทัด + tooltip เป็นชื่อแบบมาตรฐาน (ทดสอบบนตัวติดตั้ง — WebView2) (แทน SCAT-11)** 🆕
  - ดูชื่อแกน X ใต้กราฟและแกน Y แนวตั้งทางซ้าย โดยเลือก sensor ที่ description ยาวมากเป็นแกน Y (เช่น GENERATOR STATOR WINDING TEMPERATURE PHASE S)
  - เลือก sensor ที่ค่าเป็นหลักพันขึ้นไปเป็นแกน Y แล้วดูตัวเลขบนแกนเทียบกับชื่อแกน
  - เลือก sensor ที่ไม่มี description และ sensor ที่ไม่มีหน่วยเป็นแกน Y
  - ย่อหน้าต่างให้เตี้ยจนกราฟสั้นกว่าชื่อ
  - เอาเมาส์ชี้ชื่อแกน, ชี้จุด และปัก Tag point 1 จุด
  - **คาดหวัง:** ชื่อแกนทั้ง X และ Y เป็น 2 บรรทัด: บรรทัดแรกเป็น description บรรทัดที่สองเป็น tag + หน่วย · แกน Y อ่านจากล่างขึ้นบน บรรทัด description อยู่ด้านนอก บรรทัด tag + หน่วยอยู่ติดตัวเลขแกน · description ที่ยาวแสดงครบเมื่อกราฟสูงพอ และถูกตัดด้วย … เฉพาะบรรทัด description เมื่อกราฟเตี้ยกว่าชื่อ (tag + หน่วยยังครบ ไม่ล้นออกนอกกราฟ) · ตัวเลขบนแกน Y ไม่ทับชื่อแกนแม้เป็นเลข 4 หลัก · ตัวเลขใต้แกน X ไม่ทับชื่อแกน X · แถบเลือก X/Y มุมซ้ายบนไม่ทับตัวเลขบนสุดของแกน Y · ไม่มี description = บรรทัดเดียว (tag + หน่วย) และกราฟไม่ขยับตอนสลับ sensor · ชี้ชื่อแกนแล้วเห็นชื่อเต็ม · tooltip และกล่อง Tag point แต่ละแถวเป็นชื่อซ้าย ค่า + หน่วยขวา (ตัวคั่นหลักพัน)

- [ ] **SCAT-4 — ตรึงสเกลแกน (ไอคอนไม้บรรทัด)**
  - ใส่ min/max ของแกน X
  - ใส่ของแกน Y
  - ล้างออก
  - **คาดหวัง:** สเกลถูกตรึงตามที่ใส่ และค่ายังอยู่หลังปิดเปิด

- [ ] **SCAT-5 — Reset view**
  - zoom/pan ไปไกล ๆ แล้วกด Reset view
  - **คาดหวัง:** กลับมามุมมองเริ่มต้น

- [ ] **SCAT-6 — Tagged points — แก้ให้ตรงกับของจริงแล้ว (ข้อเดิมพูดถึง "ลบ row id" ที่ไม่มีอยู่จริงในโค้ด)**
  - กดไอคอน Tag ที่มุมกราฟก่อน (ต้องเปิดโหมดนี้ก่อน)
  - คลิกจุดบนกราฟเพื่อปัก tag ให้ครบจำนวนสีในพาเลท (ลองปักเกินจำนวนสีที่มีดูด้วย)
  - คลิกจุดที่ปักไว้แล้วซ้ำอีกที
  - กด Clear all tags
  - **คาดหวัง:** เปิดโหมดแล้วคลิกถึงปักได้, คลิกจุดที่ปักไว้ซ้ำ = เอาออก, Clear all ล้างหมดทีเดียว — **ปักเกินจำนวนสีในพาเลทแล้วต้องไม่ปักเพิ่ม (เงียบ ๆ ไม่มี error) ไม่ใช่ปักทับสีซ้ำหรือ error** — ไม่มีช่องกรอก "row id" ให้ลบแบบข้อความ ทุกอย่างทำผ่านการคลิกจุดบนกราฟเท่านั้น

- [ ] **SCAT-7 — Highlight by value ระบายสีจุด**
  - ตั้งช่วงค่าใน Highlights → By value
  - **คาดหวัง:** จุดในช่วงเปลี่ยนสีถูกต้อง

- [ ] **SCAT-8 — สลับไป-กลับ Line ↔ Scatter หลายรอบ**
  - สลับสลับ 10 รอบ
  - **คาดหวัง:** ไม่มีจอดำ ไม่มี error ใน toast — ScatterChart ถูก unmount ทุกครั้งที่สลับ

- [ ] **SCAT-13 — Tag point บน Scatter: ค่าอยู่ในแท็บ Tagged points + ลบทีละอันด้วย × ที่หัวคอลัมน์ (แทน SCAT-9)** 🆕
  - เปิดโหมด Tag แล้วปัก 3 จุด (ให้มี 2 จุดอยู่ใกล้กัน)
  - ดูบนกราฟ และดูแท็บ Tagged points ของ panel ล่าง
  - กด × ของ tag ตรงกลาง แล้วปักจุดใหม่ · เปลี่ยน sensor แกน X หรือ Y · ซูม / เลื่อนกราฟ
  - **คาดหวัง:** บนกราฟแต่ละ tag เป็น**วงแหวนสีล้วน ไม่มีป้ายเลขและไม่มีกล่องค่า** จุดที่อยู่ใกล้กันไม่บังกัน · ใต้กราฟไม่มีตาราง · ปัก tag แรกแล้ว panel ล่างสลับไปแท็บ "Tagged points (N)" เอง · ตารางมี 2 แถว: แถว **X** (ชื่อ sensor แกน X) และแถว **Y** คอลัมน์ละ tag หัวคอลัมน์ = จุดสีเดียวกับวงแหวน + เวลาของแถวข้อมูลนั้น + ปุ่ม × · ข้อความ "Click a point to tag it — its values are listed in the Tagged points tab" ขึ้นใต้แถบเครื่องมือเมื่อเปิดโหมด Tag · กด × แล้วหายเฉพาะ tag นั้น (วงแหวน + คอลัมน์) ตัวอื่นอยู่ครบสีเดิม · tag ใหม่ได้สีที่ว่าง ไม่ซ้ำ · ลบได้แม้ปิดโหมด Tag · ลบด้วยคีย์บอร์ด (Tab ไปที่ × แล้ว Enter) แล้วโฟกัสย้ายไปที่ × ของคอลัมน์ถัดไป/ก่อนหน้า หรือปุ่ม Tag เมื่อลบหมด · ซูม / เลื่อนแล้ววงแหวนตามจุดเดิม · เปลี่ยน sensor แกนแล้ว tag ถูกล้าง (ของเดิม) และแท็บกลับเป็นข้อความว่าง · เปิดตัวแก้สเกลแกน (ไม้บรรทัด) ยังใช้งานได้ · Clear all ยังใช้ได้

---

## PAIR

### Pair Plot

- [ ] **PAIR-1 — เพดานจำนวน sensor**
  - เลือก sensor เกินเพดานแล้วกด Pair Plot
  - **คาดหวัง:** ขึ้น dialog อธิบายว่ารองรับได้กี่ตัวและตอนนี้เลือกไว้กี่ตัว ไม่ใช่เงียบ ๆ

- [ ] **PAIR-2 — ทุก cell วาดครบ** 👀
  - เลือก 4 sensor แล้วเปิด Pair Plot
  - **คาดหวัง:** **ทุกช่องในตารางมีจุดจริง ไม่มีช่องว่างเปล่า** (CSP อีกจุด)

- [ ] **PAIR-3 — Lasso select**
  - เลือกโหมด lasso
  - ลากล้อมจุดในช่องหนึ่ง
  - **คาดหวัง:** จุดที่ล้อมกลายเป็น cluster สีเดียวกันทุกช่อง

- [ ] **PAIR-4 — สร้างหลาย cluster**
  - lasso อีก 2 ครั้ง (รวมเป็น 3 cluster)
  - **คาดหวัง:** ได้ 3 cluster คนละสี ชื่อ Cluster 1, 2, 3 · แต่ละ cluster เป็นชิป (ช่องสี + ชื่อ + ×) เรียงในแถบเหนือตาราง ทางซ้ายของกล่องเครื่องมือ — **ไม่มีกล่องลอยทับจุดข้อมูล** และไม่มีตัวเลขจำนวนแถว · ชิปที่สองขึ้นไปทำให้ปุ่ม "Clear" โผล่

- [ ] **PAIR-13 — ลบ cluster ทีละอัน + เปลี่ยนสี cluster จากชิปเหนือตาราง (แทน PAIR-11)** 🆕
  - สร้าง cluster ไว้ 3 อัน
  - กดช่องสีของชิปหนึ่ง ดูว่าสีปัจจุบันมีเครื่องหมายถูกอยู่ในพาเลท (ไม่เด้งไปที่ Custom colour) เลือกสีอื่นจากพาเลท (ดูจุดบอกสีที่ cluster อื่นใช้อยู่) แล้วลอง Custom colour
  - กด × ที่ชิปทีละอันจนเหลืออันเดียว แล้วกด × อันสุดท้าย
  - **คาดหวัง:** ช่องสีเปิดตัวเลือกสีแบบเดียวกับแท็บ Selected Sensor · สีของ cluster เปลี่ยนทุกช่องในตาราง · × ลบเฉพาะ cluster นั้น · เหลืออันเดียวแล้ว "Clear" หายไป · ลบหมดแล้วแถบชิปหายไปทั้งแถบ

- [ ] **PAIR-12 — ชื่อ sensor ที่หัวช่อง/ซ้ายแถว: tag เปล่าๆ ชี้แล้วขึ้นการ์ดชื่อเต็ม** 🆕
  - เปิด Pair Plot 3-4 sensor แล้วเอาเมาส์ชี้ชื่อ tag ที่หัวคอลัมน์และซ้ายแถว (มีเส้นประใต้)
  - กด Tab จนโฟกัสไปที่ชื่อแกน
  - เอาเมาส์ชี้จุดในช่อง scatter
  - **คาดหวัง:** ปกติเห็นแค่ tag ตัว mono · ชี้หรือโฟกัสแล้วขึ้นการ์ดที่มี description + ป้ายหน่วย + tag + ชิป component · ช่อง Time ไม่มีการ์ด · tooltip ของจุดเป็นชื่อซ้าย ค่า + หน่วยขวา

- [ ] **PAIR-8 — Pan / zoom mode**
  - สลับไปโหมด pan/zoom แล้วลาก
  - **คาดหวัง:** เลื่อน/ซูมได้ ไม่ไปสร้าง cluster แทน

- [ ] **PAIR-14 — ↺ รีเซ็ตแค่มุมมอง cluster ยังอยู่ · Clear ลบทั้งหมด (แทน PAIR-9)** 🆕
  - สร้าง cluster 2 อัน แล้วซูม/เลื่อนในหลายช่อง (โหมด pan/zoom)
  - กดปุ่ม ↺ ในกล่องเครื่องมือ
  - กด "Clear" ในแถบชิป
  - **คาดหวัง:** ↺ ทำให้ทุกช่องกลับมามุมมองเต็ม **โดย cluster ยังอยู่ครบ** (ชิปและสีในตารางไม่หาย) · "Clear" ลบ cluster ทั้งหมดและแถบชิปหายไป

- [ ] **PAIR-18 — ปุ่ม ↺ (Reset zoom and pan): บอกเมื่อไม่มีอะไรให้รีเซ็ต และกดแล้วภาพกลับทันที (แก้แล้ว 2026-10-09)** 👀
  - เปิด Pair Plot ใหม่ ยังไม่ซูมอะไร (lasso หรือไม่ก็ได้) เอาเมาส์ชี้ปุ่ม ↺ ในกล่องเครื่องมือ แล้วกด
  - เลื่อนลูกกลิ้งเมาส์บนช่อง scatter ช่องหนึ่งให้ซูมเข้า (โหมดไหนก็ได้) แล้วชี้ปุ่ม ↺ อีกครั้ง แล้วกด
  - สลับเป็นโหมด Pan / zoom ลากเลื่อนช่องหนึ่ง แล้วกด ↺
  - ซูมช่องหนึ่งไว้ แล้วเปลี่ยน sensor ที่เลือก (สลับลำดับ/เพิ่ม/ลด) จากนั้นกด ↺
  - เปิด enlarged view (แว่นขยาย) ซูมในนั้น แล้วกด ↺ ที่หัวหน้าต่าง
  - **คาดหวัง:** ยังไม่ซูม = ปุ่มเป็นสีจาง tooltip "Nothing to reset — zoom (scroll) or pan a cell first" กดแล้วไม่มีอะไรเกิดขึ้น (เดิมปุ่มดูเหมือนกดได้แต่ไม่มีอะไรให้รีเซ็ต — และ ↺ ไม่ลบ cluster ตั้งแต่ PAIR-14) · ซูม/เลื่อนแล้ว = ปุ่มสีปกติ tooltip "Reset zoom and pan — every cell back to its full data range (clusters stay)" · กดแล้วจุดในทุกช่องกลับมาเต็มช่วงพร้อมตัวเลขบนแกน และปุ่มกลับเป็นสีจาง · หลังเปลี่ยน sensor แล้วกด ↺ ปุ่มต้องกลับเป็นสีจาง ไม่ค้างเป็นสีปกติ · cluster ยังอยู่ครบ

- [ ] **PAIR-15 — เปลี่ยนชื่อ cluster ในชิป** 🆕
  - คลิกชื่อ "Cluster 1" ในชิป → กลายเป็นช่องพิมพ์ที่เลือกข้อความไว้แล้ว พิมพ์ชื่อใหม่แล้วกด Enter
  - คลิกชื่ออีกครั้ง พิมพ์อะไรก็ได้แล้วกด Esc
  - คลิกชื่อ ลบข้อความจนว่าง (หรือมีแต่ช่องว่าง) แล้วกด Enter
  - คลิกชื่อ พิมพ์ชื่อใหม่แล้วคลิกที่อื่น
  - ใช้ Tab ไปที่ชื่อแล้วกด F2 (หรือ Enter) แก้ชื่อด้วยคีย์บอร์ดล้วน
  - ตั้งชื่อยาวมาก (เกิน 40 ตัว) และตั้งชื่อซ้ำกับอีก cluster
  - **คาดหวัง:** Enter / คลิกที่อื่น = บันทึก · Esc = ยกเลิก ชื่อเดิมอยู่ · ว่าง = กลับเป็นชื่อเดิม · หลัง Enter/Esc โฟกัสกลับมาที่ชื่อ · พิมพ์ได้ไม่เกิน 40 ตัว ชื่อยาวในชิปตัดเป็น … และชี้แล้วเห็นชื่อเต็ม · ชื่อซ้ำได้ · ชื่อใหม่ขึ้นทั้งที่ชิปและใน tooltip ของปุ่มสี / × · **ไม่มีการกระตุก/โหลดตารางใหม่ตอนเปลี่ยนชื่อ** · ปิด-เปิด workspace แล้ว cluster หายตามเดิม (cluster ไม่ถูกบันทึก)

- [ ] **PAIR-16 — cluster ใหม่ได้เลขและสีที่ว่างอยู่** 🆕
  - สร้าง Cluster 1, 2, 3 แล้ว × ลบ Cluster 1 จากนั้น lasso ใหม่
  - เปลี่ยนชื่อ Cluster 2 เป็นชื่ออื่น แล้ว lasso ใหม่อีกครั้ง
  - **คาดหวัง:** lasso หลังลบได้ "Cluster 1" กลับมา พร้อมสีส้มอำพัน (สีแรกที่ว่าง) — ไม่ใช่ "Cluster 4" · หลังเปลี่ยนชื่อ Cluster 2 ไป lasso ถัดไปได้ "Cluster 2" และสีที่ยังไม่มีใครใช้

- [ ] **PAIR-17 — ชิปใน enlarged view + ชิปล้นแถบ** 🆕
  - กดแว่นขยายแล้วคลิกช่อง scatter ให้เปิด enlarged view ยังไม่มี cluster ดูข้อความที่ footer
  - lasso ใน enlarged view แล้วเปลี่ยนชื่อ/สี/ลบจากชิปที่ footer ปิดหน้าต่างแล้วดูแถบเหนือตาราง
  - ย่อหน้าต่างให้แคบแล้วสร้าง cluster จนชิปล้นแถบ ลองเลื่อนด้วยลูกกลิ้งเมาส์บนแถบชิป
  - **คาดหวัง:** ไม่มี cluster → footer เป็นข้อความแนะนำ · มี cluster → footer เป็นชิปชุดเดียวกัน แก้ที่ไหนก็ตรงกันทั้งสองที่ · ไม่มีปุ่มตาราง/CSV ใน enlarged view · ชิปล้น → แถบเลื่อนด้านข้างได้ ขอบขวาจางลง และปุ่ม Clear กับกล่องเครื่องมือยังมองเห็นอยู่เสมอ ไม่ถูกบัง

- [ ] **PAIR-10 — เลือก sensor เยอะสุดที่เพดานอนุญาต**
  - เลือกให้เต็มเพดานแล้วเปิด Pair Plot
  - สลับไป-กลับหลายรอบ
  - **คาดหวัง:** ไม่มี error "(regl) context lost" ท่วมจอ

- [ ] **PAIR-19 — Pair Plot ไม่ช้ากับข้อมูลเยอะ (สุ่มแสดงไม่เกิน 10,000 จุด)** 🆕
  - เลือกช่วงเวลาที่มีข้อมูลมากกว่า 10,000 แถว เลือก sensor 4 ตัว แล้วเปิด Pair Plot
  - ดู badge จำนวนจุดข้างชื่อกราฟ
  - ซูม/ลากในช่องหนึ่ง, ลาก lasso สร้าง cluster, เปลี่ยน sensor 1 ตัว, สลับ Scatter ↔ Pair Plot
  - **คาดหวัง:** badge เขียน `10,000 / <จำนวนแถวทั้งหมด> pts (sampled)` · ทุกช่องวาดเสร็จเร็ว ไม่ค้าง · ซูม/ลาก/lasso ลื่น · รูปทรงกลุ่มจุดยังอ่านออกเหมือนเดิม · Scatter (กราฟเดียว) ยังแสดงได้ถึง 200,000 จุดเหมือนเดิม

---

## SPC

### Add Special Sensor — แท็บ Create

- [ ] **SPC-1 — หน้าต่างเปิดและมี 2 แท็บ**
  - เปิดหน้าต่าง
  - **คาดหวัง:** หัวหน้าต่างเขียน "Special Sensors" และมีแท็บ Create กับ Manage

- [ ] **SPC-33 — Explorer ฝั่งซ้าย: คลิกแถว = "Pick" ให้ Quick build (แทน SPC-2)** 🆕
  - ค้นหา sensor ในช่องค้นหา
  - คลิกแถว sensor 1 ตัว แล้วคลิกอีกตัว แล้วคลิกตัวแรกซ้ำ
  - ชี้เมาส์ที่แถว แล้วดูปุ่ม `$` เล็ก ๆ ท้ายแถว
  - **คาดหวัง:** แถวที่คลิกขึ้นป้าย **"Picked"** และหัวกลุ่ม component นับ `x / y` · คลิกซ้ำแล้วหายจากการ pick · การ pick **ไม่ได้สร้างอะไร** แค่เปลี่ยนตัวเลือกในการ์ด Quick build ด้านขวา · บรรทัดใต้รายการเขียน "Click a sensor to pick it for Quick build · $ inserts it at the cursor." · ไม่มีเส้นแบ่งให้ลากแล้ว (คอลัมน์ซ้ายกว้างคงที่)

- [ ] **SPC-31 — Explorer ฝั่งซ้าย: แถวเป็นชื่อแบบมาตรฐาน (description + หน่วย / tag)** 🆕
  - เปิด Add Special Sensor → Create กางกลุ่ม component
  - ค้นหาด้วยหน่วย และด้วยชื่อ component
  - **คาดหวัง:** แต่ละแถว 2 บรรทัด description + ป้ายหน่วย / tag · ตัวไม่มี description แสดง tag บรรทัดเดียว · special sensor ที่สร้างไว้มีป้าย ƒ / Σ · ช่องค้นหาเขียน "Search description, tag, unit or component…" และค้นเจอทั้ง 4 แบบ

- [ ] **SPC-34 — Quick build เมื่อ pick 1 ตัว: Combine with a number / Transform (แทน SPC-3)** 🆕
  - pick sensor 1 ตัว ดูการ์ด Quick build เหนือช่องสูตร
  - กด `+` (ยังไม่พิมพ์ตัวเลข) ดูบรรทัด Formula ท้ายการ์ด แล้วพิมพ์ `5`
  - ลอง `−` `×` `÷` `^` และ Transform `abs` `√` `log₁₀` `exp` `ceil` `floor` `round` (round ลองเปลี่ยน decimals เป็น 1 และ 0)
  - กด **Use this formula** แล้วสร้าง sensor เทียบค่าสัก 2-3 จุดกับที่คิดเอง
  - **คาดหวัง:** ไม่เลือกอะไร = "As-is" (`$TAG`) · กด `+` แล้วบรรทัด Formula จาง มีข้อความ "Enter the number." ปุ่มกดไม่ได้จนกว่าจะพิมพ์ตัวเลข · round 2 ตำแหน่งเขียนเป็น **`round($TAG * 100) / 100`** (1 ตำแหน่ง `round($TAG * 10) / 10`, 0 ตำแหน่ง `round($TAG)`) — ไม่ใช่ `round(0.01, …)` และไม่ใช่ `round($TAG, 2)` · Use แล้วข้อความเข้าไปอยู่ในช่องสูตรให้แก้ต่อได้ · ค่าถูกทุกแบบ

- [ ] **SPC-35 — Quick build เมื่อ pick 2 ตัวขึ้นไป: Chain / Combine all / Compare one against the rest / Then wrap (แทน SPC-4)** 🆕
  - pick 2 ตัว ดู Chain (มีปุ่ม `+` คั่น) กดปุ่มเครื่องหมายแล้วเลือก `−` `×` `÷` `^`
  - ลอง Combine all: **Sum**, **Spread**, **|A − B|** และ Compare: **Efficiency %** (ต้องเลือก "input = …" ก่อน)
  - ลอง Then wrap ทับผลลัพธ์ (เช่น `abs` หรือ `round` 2 ตำแหน่ง)
  - pick ตัวที่ 3 เพิ่ม ดูว่า |A − B| / Efficiency % ยังอยู่ไหม
  - สร้างจริง 2-3 แบบ เทียบค่ากับที่คิดเอง
  - **คาดหวัง:** Sum เขียนเป็นข้อความ `$A + $B` (แถวที่ source ตัวไหนว่าง ผลว่าง), Spread = `max($A, $B) - min($A, $B)`, |A − B| = `abs($A - $B)`, Efficiency % = `($B / $A) * 100` (A = input) — Efficiency จางจนกว่าจะเลือก input · พอเลือก Combine all ปุ่มเครื่องหมายใน Chain จางกดไม่ได้ · |A − B| และ Efficiency % มีเฉพาะตอน pick 2 ตัวพอดี · บรรทัด Formula ท้ายการ์ดแสดงข้อความที่จะเขียนเสมอก่อนกดอะไร

- [ ] **SPC-36 — ช่องสูตรแบบพิมพ์อิสระ + autocomplete (แทน SPC-5)** 🆕
  - คลิกช่อง Formula พิมพ์ `$` แล้วดูรายการที่ขึ้นใต้เคอร์เซอร์ ใช้ ↑↓ แล้ว Enter
  - พิมพ์ชื่อฟังก์ชัน 2 ตัวอักษร (เช่น `sq`) แล้วเลือก `sqrt(` ด้วย Tab
  - กด Ctrl+Space ที่ตำแหน่งว่าง แล้วกด Esc
  - พิมพ์ชื่อที่มีช่องว่าง/วงเล็บ เช่น `${Flow (m3/h)}` และชื่อไทย
  - **คาดหวัง:** รายการเสนอ sensor (description + tag + หน่วย) ก่อน แล้วตามด้วยฟังก์ชันพร้อมความหมายสั้น ๆ · Enter/Tab ใส่ให้ (ชื่อมีช่องว่าง/สัญลักษณ์ใส่เป็น `${…}`, ชื่อไทยล้วนใส่เป็น `$ชื่อ` ไม่มีปีกกา) ฟังก์ชันใส่ `sqrt()` แล้วเคอร์เซอร์อยู่ในวงเล็บ · Esc ปิดรายการ · Enter ตอนไม่มีรายการ**ไม่ขึ้นบรรทัดใหม่** · ค้นเจอทั้ง description / tag / หน่วย / component

- [ ] **SPC-6 — บังคับกรอกครบ 4 ช่องก่อนกด Add sensor ได้** 🆕
  - ใส่สูตรในช่อง Formula (หรือใช้ Quick build) ช่อง Name/Description/Unit/Component อยู่ในการ์ด "New sensor" ด้านล่างเสมอ
  - กรอกแค่บางช่อง เว้นที่เหลือว่างไว้ทีละช่อง แล้วดูปุ่ม Add sensor
  - กรอกครบทั้ง 4 ช่อง
  - **คาดหวัง:** ปุ่ม **Add sensor จางลงกดไม่ได้** ตราบใดที่ยังขาดช่องใดช่องหนึ่งจาก Name/Description/Unit/Component ข้อความท้ายหน้าต่างบอกชัดว่าขาดช่องไหนบ้าง (เช่น "Fill in a description, a unit, a component before adding.") และอัปเดตสดตามที่กรอก — พอครบทั้ง 4 ปุ่มถึงจะกดได้ · ถ้าช่องสูตรยังว่าง ท้ายหน้าต่างเขียน "Pick sensors on the left for Quick build, or type a formula." และกด Add ไม่ได้

- [ ] **SPC-7 — ใส่ description / unit / component (บังคับทั้ง 3 ช่อง) — Component เลือกจากรายการ**
  - ดูว่าทั้ง 4 label (Name/Description/Unit/Component) มีเครื่องหมาย * สีแดงกำกับ
  - เปิดช่อง Component
  - กรอกครบทั้ง 4 ช่องแล้วกด Add sensor
  - **คาดหวัง:** Component เป็น **dropdown เลือกจาก component ที่มีอยู่ใน workspace เท่านั้น** (พิมพ์เองไม่ได้ มีตัวเลือก "Uncategorized" ให้เลือกเอง) — สร้างสำเร็จ และค่าไปโผล่ในแท็บ Selected Sensor ของ Dashboard ครบทั้ง 3 ช่อง (Description/Unit/Component) และ sensor ใหม่ไปอยู่ใต้ component ที่เลือกจริงในแผง Sensor (ไม่หล่นไปอยู่ Uncategorized เงียบ ๆ)

- [ ] **SPC-9 — สร้างตัวที่ 2 ต่อยอดจากตัวแรก**
  - สร้าง A จาก sensor ดิบ
  - สร้าง B โดยใช้ A เป็น input
  - **คาดหวัง:** A ถูกเลือกเป็น input ได้ทันทีโดยไม่ต้องปิดเปิดหน้าต่าง

- [ ] **SPC-10 — sensor ใหม่โผล่ในแผง Sensor ของ Dashboard**
  - ปิดหน้าต่าง แล้วดูแผง Sensor
  - **คาดหวัง:** มีอยู่ในรายการและค้นหาเจอ

- [ ] **SPC-37 — สูตรผิด: บรรทัดตรวจ "✕ ข้อความ" + ปุ่มแก้ให้ทันที, Add กดไม่ได้และท้ายหน้าต่างพูดซ้ำข้อความเดียวกัน (แทน SPC-11, SPC-26)** 🆕
  - พิมพ์แต่ละอัน แล้วดูบรรทัดใต้ช่องสูตร: `$TAG1 $TAG2`, `abs($TAG1`, `$TAG1 )`, `sqr($TAG1)` (หลังจากเคยมีสูตรถูกสักครั้ง), `round($TAG1, 2)`, `pi`, `$NOPE + 1`, `42`
  - กดที่ข้อความ ✕ แล้วกดปุ่มแก้ที่อยู่ข้าง ๆ (ถ้ามี)
  - ซ้อนวงเล็บลึกมาก ๆ (65 ชั้น)
  - **คาดหวัง:** ส่วนที่ผิดในช่องมี**เส้นหยักแดง + พื้นแดงจาง** · กดข้อความ ✕ แล้วเลือกช่วงที่ผิดให้ · ปุ่มแก้: `Insert ×` → `$TAG1 * $TAG2`, `Add )` → `abs($TAG1)`, `Remove it` → ลบ `)` ที่เกิน, `Use sqrt`, `Use round(… * 100) / 100` → `round($TAG1 * 100) / 100`, `Add ( )` (สำหรับ `pi`), `Replace…` (sensor ที่ไม่มี) · `42` ขึ้นว่าไม่มี sensor อ้างอิง · Add sensor จางลง ท้ายหน้าต่าง**พูดซ้ำข้อความเดียวกับบรรทัดตรวจ** · ซ้อนลึกเกินขึ้นว่าเกิน 64 ชั้น · ไม่มีอะไร crash

- [ ] **SPC-38 — Quick build: เลือก Combine all แล้วเครื่องหมายใน Chain ต้องจางและกดไม่ได้ (แทน SPC-13)** 🆕
  - pick 2-3 ตัว กดเครื่องหมายใน Chain ให้เป็น `−` ก่อน
  - เลือก **Spread** (หรือ Sum/Average)
  - ลองกดเครื่องหมายใน Chain อีกที แล้วกด Spread ซ้ำเพื่อยกเลิก
  - **คาดหวัง:** ตอนเลือก Combine all แถว Chain จาง ปุ่มเครื่องหมายกดไม่ได้ (tooltip "Signs are off while a combination is chosen") บรรทัด Formula ท้ายการ์ดเป็นของ Spread — ยกเลิกแล้วกลับมาเป็น Chain พร้อมเครื่องหมาย `−` ที่เลือกไว้

- [ ] **SPC-39 — Sum (ข้อความ A + B) แถวที่ source หายผลว่าง ส่วน Average/Median (บล็อก) ข้ามค่าที่หาย (แทน SPC-15)** 🆕
  - ใช้ sensor 2 ตัวที่ **มีบางแถวที่ตัวใดตัวหนึ่งว่าง**
  - pick ทั้งสอง → Combine all **Sum** → Use this formula → สร้าง แล้วดูกราฟช่วงที่ตัวหนึ่งหาย
  - ทำซ้ำด้วย **Average** และ **Median** (Use this block)
  - **คาดหวัง:** Sum = `$A + $B` กราฟ**ขาดเป็นช่วงว่าง**ตรงแถวที่ source หาย · Average/Median เป็น **บล็อก** (การ์ดเขียน "Average block", บรรทัด "Average of 2 sensors · missing values skipped") กราฟใช้ค่าตัวที่เหลือคำนวณต่อ ไม่ขาด · Preview ใต้ช่องบอกจำนวนแถวที่ไม่มีผลเป็นสีส้ม

- [ ] **SPC-40 — ⭐ สร้างแล้วกราฟแสดง "เฉพาะ sensor ใหม่" และไม่ทับสิ่งที่เลือกไว้ใน Dashboard (แทน SPC-16 — ไม่มี "Add as-is" แล้ว)** 🆕
  - ที่ Dashboard ปัก sensor บางตัวไว้ (เช่น X, Y)
  - เปิด Add Special Sensor สร้าง sensor ใหม่จาก source 2 ตัว (A, B) ผ่าน Quick build
  - **ก่อนกด Add** สลับกลับมาที่หน้าต่างหลัก ติ๊กเพิ่ม sensor อีกตัว (Z) หรือเอา X ออก แล้วค่อยกลับไปกด Add sensor
  - **คาดหวัง:** บนกราฟ **มี sensor ใหม่เพิ่มเข้ามาตัวเดียว** — source (A, B) **ไม่ถูกปักตามมา** และสิ่งที่ปักไว้ก่อนหน้า (รวมที่เพิ่งติ๊กเพิ่ม/เอาออก) **อยู่ตามเดิม** — การ pick sensor ดิบเฉย ๆ แล้วกด Add **ทำไม่ได้แล้ว** (ปุ่มจาง) เพราะการปัก sensor ดิบทำที่ Dashboard

- [ ] **SPC-17 — Pair Plot เต็ม 4 ตัวแล้วสร้าง sensor ใหม่ → ต้องมีข้อความบอก ไม่ใช่เงียบ** 🆕
  - ที่ Dashboard เลือก Pair Plot และปัก sensor ครบ 4 ตัว
  - สร้าง sensor ใหม่ใน Add Special Sensor
  - **คาดหวัง:** sensor ถูกสร้างจริง (อยู่ในแผง Sensor และแท็บ Manage) แต่ **ไม่ถูกปักบน Pair Plot** และมี dialog ฝั่ง Dashboard บอกว่า Pair Plot รองรับไม่เกิน 4 sensor จึงไม่ได้ปักตัวใหม่ (ไม่ใช่หายเงียบ ๆ และ Pair Plot ไม่พังเป็น 5 ตัว) — ถ้าอยู่หน้า Line/Scatter ปักเพิ่มได้ปกติไม่มี dialog

- [ ] **SPC-18 — ⭐ ตั้งชื่อซ้ำ → ขึ้นข้อความแดงที่ช่อง Name ปุ่ม Add sensor กดไม่ได้ (แทน SPC-12 เดิม)** 🆕
  - ตั้งสูตรหรือ operation ไว้ แล้วพิมพ์ชื่อให้ตรงกับ: (ก) sensor ดิบใน CSV (ข) special sensor ที่สร้างไว้แล้ว (ค) เหมือน (ก)/(ข) แต่สลับตัวพิมพ์เล็กใหญ่หรือมี space หน้า-หลัง
  - ลองพิมพ์ชื่อที่มีเครื่องหมาย `}` และชื่อ `timestamp`
  - เปลี่ยนเป็นชื่อที่ไม่ซ้ำ
  - **คาดหวัง:** (ก)(ข)(ค) ขึ้นข้อความสีแดงใต้ช่อง Name ว่า sensor ชื่อนี้มีอยู่แล้ว (บอกชื่อที่มีอยู่จริง) ขอบช่องเป็นสีแดง ข้อความท้ายหน้าต่างเป็น "Fix the name before adding." และ **ปุ่ม Add sensor จางลงกดไม่ได้** — `}` ถูกปฏิเสธพร้อมคำอธิบาย (สูตรอ้างชื่อแบบนี้ไม่ได้) และ `timestamp` ถูกปฏิเสธว่าเป็นชื่อสงวนของคอลัมน์เวลา — พอเปลี่ยนเป็นชื่อใหม่ข้อความหายและปุ่มกลับมากดได้ — **คอลัมน์ดิบต้องไม่ถูกทับในทุกกรณี**

- [ ] **SPC-19 — กด Add sensor รัว ๆ ต้องสร้างครั้งเดียว** 🆕
  - เตรียมให้พร้อมกด Add sensor (ใช้สูตรที่ใช้เวลาคำนวณพอสมควร ถ้าทำได้)
  - ดับเบิลคลิก (หรือคลิกรัว) ที่ปุ่ม Add sensor
  - **คาดหวัง:** สร้าง sensor **ตัวเดียว** มี toast ✓ ครั้งเดียว ไม่มีข้อความ error "already exists" โผล่ตามหลัง ปุ่มจางลงระหว่างคำนวณ และ **รายการ sensor ฝั่งซ้ายไม่กะพริบเป็น "Loading..."** ระหว่างสร้าง

- [ ] **SPC-20 — ชื่อที่มีเครื่องหมายพิเศษและภาษาไทย ใช้ในสูตรได้ถูกต้อง** 🆕
  - สร้าง special sensor ชื่อ `Total-Power`, `A/B`, `Eff%`, `Flow (m3)` และชื่อภาษาไทย (เช่น `อุณหภูมิรวม`) — ตัวละตัว
  - สร้าง sensor ใหม่ที่ใช้ตัวพวกนี้เป็น source ผ่าน Quick build (pick แล้ว Use this formula) และผ่านการพิมพ์สูตรเอง (พิมพ์ `$` แล้วเลือกจาก autocomplete) และปุ่ม `$` ท้ายแถวใน Explorer
  - ดูสูตรที่ปรากฏในแท็บ Manage
  - **คาดหวัง:** คำนวณได้ค่าถูกต้องทุกชื่อ ไม่มี error ว่าหา sensor ไม่เจอ — ชื่อที่มีเครื่องหมาย/ช่องว่างเขียนเป็น `${Total-Power}` (มีปีกกา) ส่วนชื่อตัวอักษร/ตัวเลข/ขีดล่างล้วน (รวมชื่อไทยล้วน) เขียนเป็น `$Name` ตรง ๆ — autocomplete ใส่รูปแบบให้ถูกเอง และชื่อที่ขึ้นต้นด้วยตัวเลข (เช่น `11PT1214A`) กับชื่อที่เป็นส่วนหน้าของอีกชื่อ (`11PT1214A.PV`) ไม่ปนกัน

- [ ] **SPC-21 — Error จาก backend แสดงในหน้าต่าง ไม่ใช่ popup บล็อก** 🆕
  - ทำให้การสร้างล้มเหลว (เช่น สูตรอ้าง sensor ที่ถูกลบจากข้อมูลไปแล้ว หรือชื่อที่ชนกับคอลัมน์ที่หน้าต่างไม่รู้จัก)
  - กด Add sensor
  - **คาดหวัง:** **ไม่มี popup alert** — ข้อความผิดพลาดขึ้นเป็นบรรทัดสีแดงที่ท้ายหน้าต่าง (ถ้าเป็นเรื่องชื่อซ้ำจะไปแสดงที่ช่อง Name ด้วย) ปุ่ม Add sensor กลับมากดได้ และข้อความหายเองเมื่อแก้ฟอร์ม/เปลี่ยนตัวเลือก — ไม่มี sensor ใหม่โผล่ที่ Dashboard

- [ ] **SPC-41 — ⭐ กด Add sensor สำเร็จแล้ว ฟอร์มต้องว่างทั้งหมด (สูตร, picks, 4 ช่อง) พร้อมสร้างตัวต่อไป (แทน SPC-22)** 🆕
  - **แบบที่ 1 (พิมพ์สูตรเอง):** พิมพ์ `$TAG1 * 3` ตั้งชื่อ `Once` กรอก Description/Unit/Component ครบ → Add sensor
  - **แบบที่ 2 (Quick build):** pick 2 ตัว → Use this formula → ตั้งชื่อ `First` กรอกครบ → Add sensor แล้ว pick 2 ตัวนั้นซ้ำ
  - **แบบที่ 3:** Average → Use this block สร้างหนึ่งตัว
  - **คาดหวัง:** หลัง Add สำเร็จ **ช่องสูตร, picks (ไม่มีป้าย Picked), Name, Description, Unit, Component ว่างหมด** การ์ด Quick build กลับเป็นข้อความเริ่มต้น บล็อกไม่ค้าง — **ช่อง Name ต้องไม่ขึ้น "A sensor named ... already exists"** และข้อความท้ายหน้าต่างตรงกับสิ่งที่ช่องแสดง — ถ้า Add **ล้มเหลว** ฟอร์มต้องคงค่าที่กรอกไว้ทั้งหมด (รวม picks และสูตร)

- [ ] **SPC-23 — Pair Plot เต็ม 4 ตัว: ตัวใหม่ต้องไม่ขึ้นป้าย "on chart" ในแท็บ Manage** 🆕
  - ทำตาม SPC-17 (Pair Plot ปัก 4 ตัวแล้ว สร้าง sensor ใหม่)
  - เปิดแท็บ Manage ดูแถวของ sensor ใหม่
  - ไปที่ Dashboard เอา sensor ออกจาก Pair Plot 1 ตัว แล้วสร้าง sensor ตัวที่ 2 ที่ใหม่กว่า กลับมาดู Manage
  - **คาดหวัง:** ตัวที่ Pair Plot ไม่ได้ปัก **ไม่มีป้าย "on chart"** — ป้ายนี้บอกสิ่งที่ Dashboard ปักจริง ๆ (Dashboard ตอบกลับมาหลังรับ sensor ใหม่) ไม่ใช่ที่หน้าต่างนี้ขอ — ตัวที่ปักได้จริงมีป้าย

- [ ] **SPC-24 — sensor ที่เพิ่งกดลบ (ยังอยู่ในช่วง Undo) ต้องไม่ถูกเสนอให้เป็น source** 🆕
  - สร้าง `A` แล้วไปแท็บ Manage กดลบ `A` (อย่าเพิ่งรอ 8 วินาที)
  - กลับแท็บ Create ดูรายการ Explorer ด้านซ้าย และลองพิมพ์ `$A` ในช่องสูตรให้ autocomplete เสนอ
  - ลองพิมพ์ `${A} + $TAG1` ด้วยมือเองแล้วสร้างเป็นตัวใหม่
  - กลับไปกด Undo แล้วดูรายการอีกที
  - **คาดหวัง:** ระหว่าง Undo `A` **ไม่อยู่ใน Explorer และ autocomplete** และถ้า pick ไว้อยู่แล้วจะถูกถอดออก — การสร้างด้วยสูตรที่พิมพ์ `A` เอง **ถูกปฏิเสธ** ("A" is being deleted. Undo that first, or pick another sensor.) — กด Undo แล้ว `A` กลับมาเลือกได้

- [ ] **SPC-42 — ทำทีละงาน: ระหว่างที่การแก้ไขยังคำนวณอยู่ แท็บ Create คือหน้าแก้ไขนั้น สร้างใหม่ได้หลังมันเสร็จ (แทน SPC-25)** 🆕
  - ใช้ข้อมูลใหญ่ที่การคำนวณใช้เวลาหลายวินาที (ถ้าไม่มี ให้เทียบแบบเร็ว ๆ ดูเท่าที่เห็น)
  - ในแท็บ Manage แก้สูตร `A` (ที่มี `B` สร้างต่อ) แล้ว Save ค้างไว้ ระหว่างนั้นกดแท็บ Create
  - หลังเสร็จ สร้าง `C` = `${A} + 1`
  - อีกแบบ: กด Add sensor ชื่อ `N` (ใช้เวลาคำนวณ) แล้วรีบไปแท็บ Manage เปลี่ยนชื่อ `A` เป็น `N` แล้ว Save
  - **คาดหวัง:** ที่หัวหน้าต่างมี "Applying changes…" · ระหว่างแก้ไข แท็บ Create แสดงฟอร์ม "Edit sensor" (ไม่มีปุ่ม Add sensor) · `C` ได้ค่าจาก `A` **ที่แก้แล้ว** · กรณีชื่อ `N` ตัวที่กดก่อน (สร้าง) ชนะ การเปลี่ยนชื่อถูกปฏิเสธที่ฟอร์มว่าชื่อซ้ำ ไม่มีสอง sensor ชื่อเดียวกัน

- [ ] **SPC-43 — ผลตรวจสูตรเป็นของข้อความที่อยู่ในช่องตอนนี้ และไม่กะพริบแดงระหว่างพิมพ์ชื่อ (แทน SPC-30)** 🆕
  - พิมพ์ `$TAG1 * 2` รอจนบรรทัดตรวจเป็นสีเขียว "✓ Valid · uses 1 sensor · computed on N rows"
  - พิมพ์ต่อเป็น `$TAG1 * 2 + $TA` ช้า ๆ (ระหว่างที่รายการ autocomplete ยังเปิด)
  - พิมพ์ต่อเป็น `foo($TAG1)`
  - **คาดหวัง:** พอแก้ข้อความ บรรทัดเขียวของข้อความเก่าไม่ค้าง · ระหว่างพิมพ์ชื่อ `$TA` ที่ยังไม่จบ **ไม่ขึ้นแดง** (แต่ Add sensor ยังกดไม่ได้) · `foo(` ขึ้นแดงหลังพิมพ์จบ

- [ ] **SPC-44 — "All functions ▾" บอกทุกฟังก์ชันของ engine และกติกา round / log / ln / pi() / 5k / เครื่องหมายลบ (แทน SPC-27)** 🆕
  - ใส่สูตรถูกสักอันก่อน (เพื่อให้รายการฟังก์ชันโหลดจาก engine) แล้วกด **All functions ▾** ในแถบเครื่องมือใต้ช่องสูตร
  - กดฟังก์ชันหนึ่งในรายการ (ลองตอนเลือกข้อความบางส่วนไว้ด้วย)
  - ลองสร้าง sensor ด้วย `round($TAG1)`, `round($TAG1 * 100) / 100`, `ln($TAG1)`, `log($TAG1)`, `$TAG1 * pi()`, `$TAG1 * 5k`, `-$TAG1 ^ 2` เทียบค่า 2-3 จุด
  - **คาดหวัง:** รายการมีทุกฟังก์ชัน (abs, sqrt, pow, exp, ln, log, log10, round, min, max, ceil, floor, sin, cos, tan, …, pi, e) พร้อมความหมาย · บรรทัดล่างบอก log = ฐาน 10, ln = ธรรมชาติ, `round(x)` = จำนวนเต็ม / ทศนิยมใช้ `round(x * 100) / 100`, 5k = 5000, −A ^ 2 = (−A)² · กดฟังก์ชันแล้วครอบส่วนที่เลือกไว้ (หรือใส่ `fn()` ที่เคอร์เซอร์) · ค่าที่คำนวณตรงตามกติกา

- [ ] **SPC-45 — "Round the result" ตั้งที่เดียว แสดงรูปที่เก็บจริง และค่าเป็นทศนิยมเป๊ะ (แทน SPC-28)** 🆕
  - พิมพ์ `$A + $B` แล้วเลือก Round the result = **2**
  - ดูข้อความข้าง ๆ แล้วสร้าง sensor ชี้เมาส์ดูค่าบนกราฟ และ export CSV ของกราฟ
  - ไปแท็บ Manage ดูสูตร แล้วกดดินสอเปิดแก้
  - **คาดหวัง:** ข้างปุ่มเขียน "stored as round(… * 100) / 100" · ค่าเป็น `1.13` ไม่ใช่ `1.1300000000000001` · Manage เขียน `$A + $B · rounded to 2 decimals` (ชี้เมาส์เห็น `round(($A + $B) * 100) / 100`) · เปิดแก้แล้วช่องสูตรแสดง `$A + $B` และปุ่ม Round = 2 ถูกเลือกอยู่ (ไม่ใช่ข้อความ round ซ้อน)

- [ ] **SPC-46 — Quick build ล้างตัวเลือกเมื่อจำนวนที่ pick เปลี่ยนกลุ่ม (0 / 1 / 2+) (แทน SPC-29)** 🆕
  - pick 1 ตัว เลือก Transform `abs`
  - pick เพิ่มอีกตัว (เป็น 2) แล้วเลือก |A − B|
  - pick ตัวที่ 3 แล้วเอาออกจนเหลือ 1
  - **คาดหวัง:** ไป 2 ตัวแล้ว `abs` ไม่ค้าง (เริ่มที่ Chain `+`) · มี 3 ตัวแล้ว |A − B| หายไปเอง · กลับเหลือ 1 ตัว ตัวเลือกเริ่มใหม่เป็น As-is · "Clear picks" ล้าง pick ทั้งหมด

- [ ] **SPC-47 — แถว "Sensors" ใต้ช่องสูตรบอก sensor ถูกตัว (มีจุด / ภาษาไทย) และคลิกแล้วเลือกในสูตร (แทน SPC-32)** 🆕
  - ใช้ข้อมูลที่มี sensor ชื่อมีจุด (เช่น `11PT1214A.PV`) และชื่อภาษาไทย
  - พิมพ์ `$11PT1214A.PV - $อุณหภูมิ` (ใช้ชื่อจริงในข้อมูล) แล้วคลิกชิปในแถว Sensors
  - **คาดหวัง:** ชิปแสดง description + tag **`11PT1214A.PV`** (ไม่ใช่ `11PT1214A`) และชื่อภาษาไทย · คลิกชิปแล้วข้อความของ sensor นั้นในช่องสูตรถูกเลือก (ไฮไลต์)

- [ ] **SPC-48 — ช่องสูตร "ลงสี" ตามโครงสร้าง: sensor เป็นชิป, ฟังก์ชันสีเขียวอมฟ้า, วงเล็บตามชั้น, คู่วงเล็บไฮไลต์** 🆕
  - พิมพ์ `abs(($TAG1 + ${Flow (m3/h)}) * 2) + $NOPE`
  - เลื่อนเคอร์เซอร์ไปชิดวงเล็บแต่ละตัว และชี้เมาส์ที่ `$TAG1` / `abs`
  - ลองเลือกข้อความด้วยเมาส์, ตัด/วาง, ภาษาไทย
  - **คาดหวัง:** sensor เป็นชิปพื้นฟ้าอ่อน (ตัวอักษรไม่เลื่อน ตรงกับเคอร์เซอร์ทุกตัว), `abs` สีเขียวอมฟ้า, วงเล็บชั้นนอกขาว ชั้นในเขียวอมฟ้า (ชั้นต่อไปม่วง เขียว วนไป) · วางเคอร์เซอร์ชิดวงเล็บแล้ว**คู่ของมันถูกไฮไลต์ทั้งสองตัว** · `$NOPE` เป็นแดงขีดเส้นประ · ชี้เมาส์ที่ sensor เห็น "DESCRIPTION · TAG · UNIT · Component" ชี้ที่ฟังก์ชันเห็นความหมาย · การเลือก/ตัด/วาง/ภาษาไทยทำงานแบบช่องข้อความปกติ

- [ ] **SPC-49 — ครอบ / แกะวงเล็บ และ Ctrl+Z ย้อนได้ทุกอย่าง** 🆕
  - พิมพ์ `$A + $B * 2` เลือก `$A + $B` แล้วกดปุ่ม `(` บนคีย์บอร์ด
  - วางเคอร์เซอร์ชิดวงเล็บ กด **Unwrap**; เลือกข้อความแล้วกด **( ) Wrap**; ใส่ `abs` จากแถบเครื่องมือ
  - กดปุ่มแก้บนบรรทัดตรวจ (เช่น Insert ×) แล้วกด Ctrl+Z, Ctrl+Shift+Z
  - **คาดหวัง:** ข้อความที่เลือกถูกครอบเป็น `($A + $B) * 2` และข้างในยังถูกเลือกอยู่ · Unwrap เอาคู่วงเล็บออก (ถ้าเป็น `abs(…)` เอาชื่อฟังก์ชันออกด้วย) · ปุ่ม `+ − × ÷ ^` ใส่เว้นวรรคให้เอง · **Ctrl+Z ย้อนการครอบ/แกะ/ปุ่มแก้/autocomplete ได้เหมือนพิมพ์เอง** และ Ctrl+Shift+Z ทำซ้ำได้

- [ ] **SPC-50 — Average / Median เป็นบล็อก: แก้ source ด้วย "Add…", Round the result เก็บเป็นทศนิยมของบล็อกเอง** 🆕
  - pick 2 ตัว → Average → Use this block
  - กด **Add…** เพิ่ม source ตัวที่ 3 (หน้าต่างเลือกหลายตัว กด OK) และกด × ที่ชิปเพื่อเอาออก
  - เลือก Round the result = 1 แล้วสร้าง
  - ดูแท็บ Manage
  - **คาดหวัง:** การ์ดเขียน "Average block" มีบรรทัด "An Average block stands alone — it skips missing values…" · ข้าง Round เขียน "stored with the Average’s own decimals" · ค่าบนกราฟปัด 1 ตำแหน่ง · Manage เขียน "Average of … · missing values skipped · rounded to 1 decimal" และป้าย Σ · Clear กลับเป็นช่องสูตรว่าง

- [ ] **SPC-51 — Preview ใต้ช่องสูตร: เส้นทั้งชุดข้อมูล + Min/Max/Mean/Rows + จำนวนแถวที่ไม่มีผลเป็นสีส้ม** 🆕
  - พิมพ์สูตรที่ถูก (เช่น `$TAG1 / $TAG2`) รอครึ่งวินาที
  - เปลี่ยนสูตรเร็ว ๆ หลายครั้ง
  - **คาดหวัง:** การ์ด Preview วาดเส้นของผลลัพธ์ (ย่อจุด) ช่วงวันที่ "Downsampled · … → …" มี Min/Max/Mean (หน่วยตามช่อง Unit) และ Rows · ถ้ามีแถวที่คำนวณไม่ได้ (input ว่าง หรือ ÷ 0) ขึ้น "⚠ N rows have no result" สีส้ม · พิมพ์เร็ว ๆ แล้ว**หน้าต่างไม่หน่วง** และผลเป็นของข้อความล่าสุด

- [ ] **SPC-52 — sensor ที่ไม่มีในข้อมูล: ชิปแดง "Replace…" เปลี่ยนทุกจุดในสูตรในครั้งเดียว** 🆕
  - พิมพ์ `$GONE * 2 + $GONE`
  - กด **Replace…** (ที่ชิปแดงในแถว Sensors หรือปุ่มบนบรรทัดตรวจ) แล้วเลือก sensor จากรายการ
  - **คาดหวัง:** ชิปแดงเส้นประเขียน "GONE · not in this dataset · Replace…" · รายการเลือก sensor เปิดใต้ปุ่ม (ค้นหาได้ จัดกลุ่มตาม component) · เลือกแล้ว `$GONE` **ทั้งสองจุด**เปลี่ยนเป็นตัวใหม่

- [ ] **SPC-53 — หน้าต่างแคบ (~900 px): รายการซ้ายแคบลง แถบเครื่องมือขึ้นบรรทัดใหม่ ช่อง 4 ช่องเป็น 2 คอลัมน์** 🆕
  - ย่อหน้าต่าง Add Special Sensor ให้กว้างราว 900 px (และแคบกว่านั้นอีกนิด)
  - **คาดหวัง:** รายการ sensor ซ้ายกว้างราว 230 px · แถบปุ่ม `( ) Wrap · Unwrap | + − × ÷ ^ | abs √ …` ขึ้นบรรทัดใหม่ได้ไม่ล้น · การ์ด Name/Description/Unit/Component เป็น 2 คอลัมน์ · ไม่มี scroll แนวนอน ปุ่มท้ายหน้าต่างเห็นครบ

- [ ] **SPC-54 — ปุ่ม `$` ท้ายแถวใน Explorer ใส่ sensor ที่เคอร์เซอร์ (ไม่ pick)** 🆕
  - พิมพ์ `$TAG1 + ` ในช่องสูตร (เคอร์เซอร์ท้าย)
  - ชี้แถว sensor ในรายการซ้ายแล้วกดปุ่ม `$`
  - **คาดหวัง:** ได้ `$TAG1 + $TAG2` (ชื่อมีช่องว่างใส่เป็น `${…}`) · แถวนั้น**ไม่**ขึ้นป้าย Picked · ถ้าช่องเป็นบล็อก Average/Median sensor ถูกเพิ่มเป็น source ของบล็อกแทน

---

## MNG

### Manage — ลบ special sensor

_ของใหม่ทั้งหมด ยังไม่เคยมีคนกดจริง_

- [ ] **MNG-1 — แท็บ Manage แสดงรายการครบ** 🆕
  - สร้าง special sensor ไว้ 3-4 ตัว ทั้งแบบสูตรและ operation
  - เปิดแท็บ Manage
  - **คาดหวัง:** มีครบทุกตัว, หัวแท็บบอกจำนวน `Manage (N)`, badge ƒ = สูตร / Σ = operation

- [ ] **MNG-26 — แถวในแท็บ Manage: description ก่อน, ป้ายหน่วย, tag บรรทัดสอง, ป้ายล็อกสีเทา** 🆕
  - เปิดแท็บ Manage ที่มี special sensor ทั้งแบบมี description และไม่มี และตัวที่โมเดลใช้อยู่ (ล็อก)
  - **คาดหวัง:** บรรทัดแรก description + ป้ายหน่วย, บรรทัดสอง tag · ตัวที่ไม่มี description แสดง tag อย่างเดียว — **ไม่มีข้อความ "— no description —" แล้ว** · ป้าย "Used by …" (ไอคอนกุญแจ) เป็น**สีเทา** ไม่ใช่สีเหลือง · ป้าย "No data — fix formula" ของตัวที่กู้ไม่ได้ยังเป็นสีเหลืองเหมือนเดิม

- [ ] **MNG-28 — แถวของ sensor ที่กู้ไม่ได้: ป้ายส้ม + กล่องเหตุผลใต้แถว** 🆕
  - เปิด workspace ที่มี special sensor สูตรที่ engine ปฏิเสธตอนเปิด (เช่น `$TAG1 ($TAG2)` — แก้ไฟล์ workspace JSON เอง) ทั้งแบบมีโมเดลใช้และไม่มี
  - เปิดแท็บ Manage
  - **คาดหวัง:** แถวมีป้ายส้ม "No data — fix formula" และใต้แถวมีกล่องส้ม "No data this session. <เหตุผลจาก Rust>. Edit it to fix the formula" (ถ้ามีโมเดลใช้ ต่อท้าย "— the formula is unlocked for the fix; the name stays locked") · ปุ่มลบยังกดไม่ได้ถ้ามีโมเดลใช้

- [ ] **MNG-29 — sensor ที่กำลังเปิดแก้อยู่ ลบไม่ได้จนกว่าจะปิดการแก้** 🆕
  - แท็บ Manage → กดดินสอ (Edit) ที่ sensor ที่ไม่มีอะไรใช้ (หน้าต่างสลับไปแท็บ Create ที่เป็นหน้าแก้) → กดแท็บ **Manage** กลับมาดูแถวนั้นในรายการ
  - ชี้เมาส์ที่ปุ่มถังขยะของแถวนั้น แล้วลองกด · ดูปุ่มถังขยะของแถวอื่น
  - กลับไปแท็บ **Create** กด **Cancel edit** (อย่ากดปุ่ม Close ท้ายแท็บ Manage — ปุ่มนั้นปิดทั้งหน้าต่าง) แล้วดูปุ่มถังขยะของแถวเดิมอีกครั้ง
  - **คาดหวัง:** ระหว่างแก้ ปุ่มถังขยะของแถวที่เปิดแก้เป็นสีจาง กดไม่ได้ ชี้เมาส์ขึ้น "Close the edit first" · แถวอื่นที่ไม่มีอะไรใช้ยังลบได้ · ปิดการแก้แล้วแถวเดิมลบได้ตามปกติ

- [ ] **MNG-27 — สูตร/operation อ่านออกเป็นภาษาคน (แทน MNG-2)** 🆕
  - ดูคอลัมน์ขวาของแต่ละแถว และชี้เมาส์ค้าง
  - **คาดหวัง:** สูตรแสดงตามที่พิมพ์ (ถ้า Round the result ไว้ ต่อท้าย "· rounded to N decimals") · Sum เก่าเขียน "Sum of …" · บล็อกเขียน "Average of … · missing values skipped" (ชื่อ source เป็น description) · operation ตัวเดียวเขียนเช่น "TAG + 10" / "TAG rounded to 2 decimals" · ชี้เมาส์เห็นรูปที่เก็บจริง (เช่น `sum(a, b)`) · ป้าย ƒ/Σ ชี้เมาส์บอกชนิด (Formula / Average block / Sum / Operation)

- [ ] **MNG-3 — ช่องค้นหา** 🆕
  - พิมพ์ชื่อ
  - พิมพ์คำใน description
  - พิมพ์บางส่วนของสูตร
  - **คาดหวัง:** ค้นเจอทั้ง 3 แบบ และตัวเลข `x / y` มุมขวาถูกต้อง

- [ ] **MNG-4 — ลบตัวที่ไม่มีใครใช้** 🆕
  - หา special sensor ที่ไม่ได้ปักบนกราฟและไม่มีใครสร้างต่อ
  - กดถังขยะ
  - **คาดหวัง:** แถวหายทันทีโดยไม่ถาม และมีแถบ Undo โผล่ขึ้นมา

- [ ] **MNG-5 — กด Undo ภายใน 8 วินาที** 🆕
  - ลบแล้วรีบกด Undo
  - **คาดหวัง:** แถวกลับมาเหมือนเดิม และ**ฝั่ง Dashboard ต้องไม่เคยรู้เรื่องการลบเลย** (กราฟไม่กระพริบ)

- [ ] **MNG-6 — ปล่อยครบ 8 วินาที** 🆕
  - ลบแล้วนับ 1-10 ไม่ต้องแตะอะไร
  - ไปดูแผง Sensor ฝั่ง Dashboard
  - **คาดหวัง:** sensor หายจากแผง Sensor และจากกราฟ

- [ ] **MNG-7 — ลบตัวที่กำลังปักอยู่บนกราฟ** 🆕
  - ปัก special sensor ตัวหนึ่งบนกราฟ
  - ไปลบมันในแท็บ Manage
  - **คาดหวัง:** chip "on chart" ขึ้นที่แถว แต่ปุ่มลบยัง**กดได้** และพอลบจริงเส้นหายจากกราฟให้อัตโนมัติ

- [ ] **MNG-8 — ลบตัวที่มี special sensor อื่นสร้างต่อ → ต้องกดไม่ได้** 🆕
  - สร้าง A
  - สร้าง B โดยใช้ A
  - ไปลบ A (ชี้เมาส์ที่ถังขยะด้วย)
  - **คาดหวัง:** ปุ่มลบของ A ถูกปิด ชี้เมาส์เห็น **"Used by B — remove it there first"**, มี chip 🔒 "Used by 1 sensor" กดแล้วกางบอกว่า B ใช้อยู่ และบอกให้ลบ B ก่อน

- [ ] **MNG-9 — ลบตัวที่โมเดลใน Failure Group ใช้อยู่ → ต้องกดไม่ได้** 🆕
  - เอา special sensor ไปเป็น target ของโมเดลหนึ่ง
  - ไปลบมัน
  - **คาดหวัง:** ปุ่มลบถูกปิด, chip บอกจำนวนโมเดล, กางแล้วเห็นชื่อโมเดล + ช่องที่อ้าง (เช่น "— target sensor")

- [ ] **MNG-11 — ลบสายโซ่จากปลายเข้าหาต้น** 🆕
  - สร้าง A → B → C
  - ลบ C
  - ดูปุ่มของ B
  - ลบ B
  - ดูปุ่มของ A
  - **คาดหวัง:** ลบได้ทีละตัวจากปลาย และตัวก่อนหน้าปลดล็อกทันทีที่ตัวถัดไปถูกลบ (ไม่ต้องปิดเปิดหน้าต่าง)

- [ ] **MNG-12 — ชื่อที่เป็นส่วนหนึ่งของอีกชื่อ** 🆕
  - สร้าง special sensor ชื่อ `test`
  - สร้างอีกตัวชื่อ `test extend`
  - สร้างตัวที่ 3 ที่ใช้สูตร `${test extend} + 1`
  - ไปดูปุ่มลบของ `test`
  - **คาดหวัง:** **`test` ต้องลบได้** (ไม่มีใครอ้างมันจริง) ส่วน `test extend` ต้องลบไม่ได้ — นี่คือเหตุผลที่ต้องแยก parser ไปฝั่ง Rust แทนการเช็คแบบ substring

- [ ] **MNG-13 — ปิดหน้าต่างขณะยังมี Undo ค้าง** 🆕
  - ลบ 1 ตัว
  - รีบกด Close ทันที
  - **คาดหวัง:** ถือว่ายืนยันการลบ — sensor หายจริงฝั่ง Dashboard

- [ ] **MNG-14 — ลบแล้วปิดเปิดโปรแกรม** 🆕
  - ลบ special sensor 1 ตัวให้ครบกระบวนการ
  - ปิดโปรแกรม เปิดใหม่ เปิด workspace เดิม
  - **คาดหวัง:** **ไม่กลับมาอีก** — ตัว recipe ถูกลบออกจาก workspace แล้ว จึงไม่ถูก replay ตอนเปิด

- [ ] **MNG-15 — หน้าจอตอนยังไม่มี special sensor เลย** 🆕
  - เปิด workspace ที่ไม่เคยสร้าง special sensor
  - เปิดแท็บ Manage
  - **คาดหวัง:** ขึ้นข้อความ "No special sensors yet" พร้อมบอกให้ไปสร้างที่แท็บ Create

- [ ] **MNG-16 — ⭐ ลบแล้วสร้างชื่อเดิมใหม่ ค่าต้องเป็นของตัวใหม่ (บั๊กค่าไม่ตรงที่ผู้ใช้รายงาน)** 🆕
  - สร้าง special sensor ชื่อ `X` = `$TAG1 * 2` ปักบนกราฟ จดค่าสัก 2-3 จุด
  - ไปแท็บ Manage ลบ `X` รอครบ 8 วินาที
  - กลับแท็บ Create สร้าง `X` ใหม่ด้วยสูตรอื่น เช่น `$TAG1 * 100` แล้วดูกราฟ
  - **ไม่ต้องปิดเปิดโปรแกรม**
  - **คาดหวัง:** ชื่อ `X` สร้างได้ (ไม่ขึ้น "already exists") และ **ค่าบนกราฟเป็นของสูตรใหม่ (×100)** ไม่ใช่ค่าเก่าที่ลบไปแล้ว — มี `X` ตัวเดียวในแผง Sensor และใน Manage (เดิมคอลัมน์เก่าค้างในหน่วยความจำ ตัวใหม่เลยแสดงค่าของตัวเก่าจนกว่าจะปิดโปรแกรม)

- [ ] **MNG-17 — ลบแล้วสร้างชื่อเดิมทันทีโดยไม่รอครบ 8 วินาที** 🆕
  - ลบ special sensor ชื่อ `X` (ยังอยู่ในช่วง Undo)
  - ไปแท็บ Create ตั้งชื่อ `X` สำหรับ sensor ใหม่ แล้วกด Add sensor
  - **คาดหวัง:** ชื่อ `X` **ไม่ถูกขึ้นว่าซ้ำ** และสร้างได้เลย (ระบบยืนยันการลบตัวเก่าให้ก่อนแล้วค่อยสร้างตัวใหม่) ค่าเป็นของตัวใหม่ และ Undo ของตัวเก่าหายไป (ถือว่ายืนยันการลบแล้ว)

- [ ] **MNG-18 — โมเดลเพิ่งเอา special sensor ไปใช้ ระหว่างที่หน้าต่างนี้เปิดค้างอยู่ → ต้องลบไม่ได้ทันที** 🆕
  - เปิด Add Special Sensor แท็บ Manage ค้างไว้ (ปุ่มลบของ sensor ตัวหนึ่งกดได้)
  - ไปที่ Build Model ตั้ง sensor ตัวนั้นเป็น target ของโมเดล (หน้าต่าง Add Special Sensor ยังเปิดอยู่)
  - กลับมาที่แท็บ Manage
  - **คาดหวัง:** ปุ่มลบของ sensor นั้น**ถูกปิดทันที** และ chip บอกว่ามีโมเดลใช้อยู่ — ไม่ต้องปิดเปิดหน้าต่าง (เดิมรายการโมเดลถูกส่งมาครั้งเดียวตอนเปิดหน้าต่าง จึงยังลบได้ ซึ่งตอนนี้การลบ "ทิ้งคอลัมน์จริง" ทำให้โมเดลชี้ไปข้อมูลที่ไม่มีแล้ว)

- [ ] **MNG-19 — ⭐ ลบแล้วระหว่างช่วง Undo มีอะไรมาใช้ sensor นั้น → ต้องยกเลิกการลบ ไม่ทิ้งคอลัมน์** 🆕
  - สร้าง special sensor `A` แล้วกดลบในแท็บ Manage (อย่าเพิ่งรอ)
  - ภายใน 8 วินาที เปิดหน้าต่าง Build Model ตั้ง `A` เป็น target ของโมเดล (หรือเปิดหน้าตั้ง Running condition ให้มีเงื่อนไขที่ใช้ `A`)
  - รอครบ 8 วินาทีแล้วดูแท็บ Manage, แผง Sensor และโมเดลนั้น
  - **คาดหวัง:** การลบ **ถูกยกเลิก** — `A` กลับมาอยู่ในรายการ Manage/Explorer/แผง Sensor, **ค่ายังอยู่ ไม่ถูกทิ้งคอลัมน์** และมีข้อความแดงที่หน้าต่างบอกเหตุผล ("Didn't delete A: it is now used by <ชื่อโมเดล> (target sensor)" หรือ "... the workspace Running condition") — โมเดล/Running condition ยังชี้ sensor ที่มีข้อมูลอยู่ (เดิมตรวจแค่ตอนกดปุ่ม พอครบเวลา 8 วินาทีก็ลบไปทั้งที่เพิ่งมีคนใช้ ทำให้ Rust เมินเงื่อนไขนั้นเงียบ ๆ และโมเดลเทรนบนแถวชุดอื่นโดยไม่มี error)

- [ ] **MNG-20 — ⭐ special sensor ที่ Running condition ของ workspace ใช้อยู่ → ลบไม่ได้** 🆕
  - ใน Build Model → Running condition ตั้งเงื่อนไขที่ใช้ special sensor `A` (เช่น `A > 3`) แล้ว Apply
  - ไปแท็บ Manage (เปิดค้างไว้ก่อนก็ได้ ไม่ต้องปิดเปิดหน้าต่าง) ดูแถวของ `A`
  - ลบเงื่อนไขนั้นออกจาก Running condition แล้วกลับมาดูอีกที
  - **คาดหวัง:** ปุ่มลบของ `A` ถูกปิด มี chip 🔒 "Used by the running condition" กดแล้วกางบอกให้เอาเงื่อนไขออกก่อน — พอเอาเงื่อนไขออกปุ่มกลับมากดได้ (ไม่ต้องปิดเปิดหน้าต่าง)

- [ ] **MNG-21 — เงื่อนไข "Custom running condition" ของโมเดลก็บล็อกการลบ** 🆕
  - ในหน้าต่าง Build Model เลือกโมเดลหนึ่ง สลับ Training data เป็น Custom แล้วเพิ่มเงื่อนไขที่ใช้ special sensor `A`
  - ดูแถวของ `A` ในแท็บ Manage
  - **คาดหวัง:** ปุ่มลบปิด chip บอกว่ามีโมเดลใช้ และเมื่อกางเห็นชื่อโมเดล + "— custom running condition"

- [ ] **MNG-22 — เปลี่ยนชื่อแล้ว การป้องกันการลบยังอยู่ทันที (ไม่ต้องรอหน้าต่างอื่น)** 🆕
  - มีโมเดล (หรือ Running condition) ใช้ special sensor `A` อยู่
  - ในแท็บ Manage เปลี่ยนชื่อ `A` เป็น `A2` แล้ว Save
  - ดูปุ่มลบของ `A2` **ทันที**
  - **คาดหวัง:** ปุ่มลบของ `A2` ยังปิดอยู่ มี chip บอกว่ามีโมเดล/Running condition ใช้ (เดิมหน้าต่างนี้ไม่แก้รายการโมเดลของตัวเอง ปุ่มลบจึงโผล่กดได้ชั่วขณะหรือค้างตลอดถ้า broadcast ตกหล่น) — ถ้าหน้าต่างยังไม่รู้ว่ามีโมเดลอะไรบ้างเลย (หรืออ่านไฟล์ workspace ไม่ได้) ปุ่มลบทุกตัวต้องปิดและ tooltip บอก "Still checking what uses this sensor"

- [ ] **MNG-23 — ⭐ ลบ sensor ที่ใช้ในแท็บ Filter ของ Dashboard → เงื่อนไขนั้นต้องหายไปด้วย** 🆕
  - ที่ Dashboard แท็บ Filter เพิ่มเงื่อนไข `A > 4` แล้ว Apply filter (ดูว่ากราฟกรองจริง) แล้วเพิ่มเงื่อนไขที่สอง (กรอกค่าแต่ **ยังไม่กด Apply**) ที่ใช้ `A` เช่นกัน
  - ลบ `A` ในแท็บ Manage รอครบ 8 วินาที
  - กลับมาดูแท็บ Filter และกราฟ
  - **คาดหวัง:** เงื่อนไขที่อ้าง `A` **หายไปจากรายการทั้งที่ Apply แล้วและที่ยังไม่ Apply** ส่วนเงื่อนไขของ sensor อื่นอยู่ครบ (รวมค่าที่พิมพ์ค้างไว้ในเงื่อนไขอื่นไม่ถูกรีเซ็ต) — จะไม่มีสถานะ "ในแท็บยังเห็นเงื่อนไขอยู่ แต่กราฟแสดงทุกแถวเพราะคอลัมน์หายไปแล้ว"

- [ ] **MNG-24 — ปิดหน้าต่างขณะมีงานค้างและมี Undo ค้าง → ทำตามลำดับ แล้วค่อยปิด** 🆕
  - แก้สูตร sensor ตัวหนึ่ง Save (ให้ใช้เวลาคำนวณพอเห็น) แล้วรีบลบ sensor อีกตัว จากนั้นกด Close ทันที
  - **คาดหวัง:** หน้าต่างรอให้การแก้เสร็จก่อน แล้วยืนยันการลบ แล้วจึงปิด — ผลคือ sensor ที่แก้มีค่าใหม่ครบ ตัวที่ลบหายจริง ไม่มีคอลัมน์เหลือค้างแบบไม่มีเจ้าของ (เดิมการลบกับการแก้ทำพร้อมกัน คอลัมน์ที่เพิ่งลบถูกสร้างกลับมาเป็น "ผี" ที่บล็อกชื่อนั้นไปจนปิดโปรแกรม)

- [ ] **MNG-25 — เช็คให้ครบทุกช่องที่โมเดลอ้าง sensor ได้ (7 ช่อง) — แทน MNG-10 เดิม** 🆕
  - ทดลองเอา special sensor ไปใส่ทีละช่อง: target sensor, predictor, X sensor, Y sensor, criteria sensor, scatter X sensor, **และเงื่อนไขของ Custom running condition ของโมเดล** (ช่อง "PM filter" เดิมถูกยกเลิกไปแล้ว)
  - แต่ละครั้งไปดูว่าปุ่มลบถูกปิดไหม
  - **คาดหวัง:** **ทั้ง 7 ช่องต้องบล็อกการลบ** — ถ้าช่องไหนหลุด จะเกิดโมเดลที่ชี้ไป sensor ที่ไม่มีอยู่แบบเงียบ ๆ (ส่วน Running condition ของทั้ง workspace ดู MNG-20)

---

## EDT

### Manage — แก้ไข special sensor

_ของใหม่ทั้งหมด และเป็นส่วนที่ซับซ้อนที่สุดที่ทำไป_

- [ ] **EDT-54 — กดดินสอแล้วเปิด Formula editor ตัวเดียวกับ Create ในหัวการ์ด "Edit sensor" (แทน EDT-1)** 🆕
  - pick sensor ไว้ในแท็บ Create 1-2 ตัว แล้วไปแท็บ Manage กดดินสอที่แถวหนึ่ง
  - กด **Cancel edit**
  - กดดินสอแถวหนึ่งอีกครั้ง แก้อะไรสักอย่าง Save changes
  - **คาดหวัง:** สลับไปแท็บ Create แสดงช่องสูตรที่โหลด recipe ไว้ การ์ดล่างเขียน **"Edit sensor"** ท้ายหน้าต่างมี **Cancel edit / Save changes** (ไม่มี Add sensor) · picks ถูกล้างตอนเปิดแก้ · Cancel edit และ Save สำเร็จพากลับแท็บ Manage · แถวที่กำลังแก้ ปุ่มดินสอเป็นสีฟ้า

- [ ] **EDT-2 — เปลี่ยนชื่อ (rename) ได้แล้ว — กรณีพื้นฐานไม่มีอะไรอ้างถึง** 🆕
  - เปิดแก้ special sensor ที่ไม่มีตัวอื่นสร้างต่อและไม่มีโมเดลใช้อยู่
  - ลบชื่อในช่อง Name ออก พิมพ์ชื่อใหม่
  - Save changes
  - **คาดหวัง:** บันทึกสำเร็จ, แถวในรายการเปลี่ยนเป็นชื่อใหม่ทันที, ชื่อเดิมหายไปจากรายการ (ไม่ใช่มีทั้งชื่อเก่าและใหม่ค้างอยู่พร้อมกัน) — **เดิมช่องนี้ถูกล็อกแก้ไม่ได้เลย ตอนนี้เปิดให้แก้ได้แล้ว** (ดู EDT-19 ถึง EDT-26 ท้ายหมวดนี้สำหรับเคสที่ซับซ้อนกว่า; sensor ที่โมเดลใช้อยู่แก้ชื่อไม่ได้ — ดู EDT-57)

- [ ] **EDT-3 — แก้สูตรแล้วค่าบนกราฟเปลี่ยนทันที** 🆕
  - ปัก special sensor ตัวหนึ่งบนกราฟ จำรูปเส้นไว้
  - แก้สูตรจาก `* 2` เป็น `* 5`
  - กด Save changes
  - **ห้ามติ๊ก sensor ออก-เข้า**
  - **คาดหวัง:** **เส้นบนกราฟเปลี่ยนเองภายในไม่กี่วินาที** โดยไม่ต้องไปแตะอะไรอีก (นี่คือสิ่งที่ `dataRevision` ทำ)

- [ ] **EDT-4 — แก้ description / unit / component** 🆕
  - แก้ทั้ง 3 ช่องแล้ว Save
  - ไปดูแท็บ Selected Sensor
  - **คาดหวัง:** ข้อความใหม่ขึ้นทั้งในแท็บ Manage และในรายการ Selected Sensor

- [ ] **EDT-55 — แก้บล็อก Average / Median: เพิ่ม/ลบ source ด้วย "Add…" แล้วยังเป็นบล็อกเดิม (แทน EDT-52, EDT-53, EDT-7, EDT-43)** 🆕
  - สร้างบล็อก **Average** จาก 2 sensor จดค่า 2-3 จุด
  - เปิดแก้ กด **Add…** ติ๊กตัวที่ 3 กด OK แล้ว Save; เปิดอีกครั้ง กด × เอาออก 1 ตัว แล้ว Save (ลอง Cancel ในหน้าต่างเลือกด้วย)
  - ทำซ้ำกับ Median; ลองเอา source ออกจนเหลือ 1 ตัวแล้วดูปุ่ม Save
  - **คาดหวัง:** การ์ดยังเขียน "Average block" ค่าเป็น**ค่าเฉลี่ย**ของชุดใหม่ (ไม่ใช่ผลรวมที่ใหญ่ขึ้น) Manage เขียน "Average of … · missing values skipped" · รายการในหน้าต่างเลือกไม่มีตัวมันเองและตัวที่สร้างต่อจากมัน · Cancel ไม่เปลี่ยนอะไร · เหลือ 1 ตัวแล้ว Rust/บรรทัดตรวจบอกเหตุผลถ้าไม่รับ

- [ ] **EDT-56 — sensor แบบปุ่มเก่า (Sum / Add 10 / Round to decimals) เปิดเป็นสูตรพร้อมหมายเหตุ บันทึกโดยไม่แก้คณิตแล้วเก็บแบบเดิม (แทน EDT-6)** 🆕
  - เตรียม special sensor ที่สร้างด้วยเวอร์ชันเก่าแบบ Sum all, แบบ `TAG + 10` และแบบ Round to decimals
  - กดดินสอแต่ละตัว ดูช่องสูตร แล้วแก้แค่ Description กด Save
  - เปิด Sum อีกครั้ง แก้เป็น `$A + $B * 2` แล้ว Save
  - **คาดหวัง:** Sum เปิดเป็น `$A + $B + $C` มีหมายเหตุ "Opened from a Sum recipe as A + B + C. Saving keeps the same result…" · Add 10 เปิดเป็น `$TAG + 10` · Round เปิดเป็น `$TAG` กับปุ่ม Round = N · แก้แค่คำอธิบายแล้ว**ไม่มีการคำนวณใหม่** และใน Manage ยังเป็นแบบเดิม · แก้คณิตแล้วกลายเป็นสูตร (ƒ) ค่าถูก

- [ ] **EDT-4b — บังคับกรอกครบ 4 ช่องในฟอร์มแก้ไข (เหมือน Create) — Component เลือกจากรายการ** 🆕
  - เปิดแก้ special sensor ที่มีข้อมูลครบอยู่แล้ว
  - ลบ Name / Description / Unit ออกทีละช่องให้ว่าง
  - ดูช่อง Component
  - **คาดหวัง:** ปุ่ม **Save changes จางลงกดไม่ได้ทันที** พร้อมข้อความบอกว่าขาดช่องไหน — Component เป็น dropdown เลือกจากรายการที่มีอยู่ (รวม "Uncategorized") จึงเว้นว่างไม่ได้ ไม่มี fallback เงียบ ๆ อีกต่อไป

- [ ] **EDT-8 — ⭐ แก้ตัวต้นน้ำแล้วตัวปลายน้ำต้องเปลี่ยนตาม** 🆕
  - สร้าง A = `$TAG * 2`
  - สร้าง B = `${A} + 10`
  - สร้าง C = `${B} * 3`
  - ปักทั้ง A B C บนกราฟ จดค่าไว้
  - แก้ A เป็น `$TAG * 5`
  - Save
  - **คาดหวัง:** **ทั้ง B และ C ต้องเปลี่ยนค่าตามด้วย ไม่ใช่แค่ A** — toast ควรบอกว่า "recomputed 2 sensor(s) built on it". ถ้า B/C ไม่ขยับ = การ replay สายโซ่ไม่ทำงาน

- [ ] **EDT-9 — แก้ให้เกิดวงจร → ต้องถูกปฏิเสธ** 🆕
  - มี A → B → C อยู่แล้วจาก EDT-8
  - แก้ A ให้เป็น `${B} + 1`
  - Save
  - **คาดหวัง:** ขึ้น error สีแดงบอกว่าจะทำให้ขึ้นกับตัวเอง พร้อมบอกชื่อ B, ฟอร์มไม่ปิด, และ**ค่าของ A/B/C ต้องไม่ถูกแตะเลย**

- [ ] **EDT-10 — แก้ให้อ้างตัวเอง → ต้องถูกปฏิเสธ** 🆕
  - แก้ A ให้เป็น `${A} + 1`
  - Save
  - **คาดหวัง:** ถูกปฏิเสธเช่นกัน — ถ้าปล่อยผ่านค่าจะไต่ขึ้นทุกครั้งที่กด Save

- [ ] **EDT-11 — อ้างตัวที่อยู่ต้นน้ำได้ ไม่ใช่วงจร** 🆕
  - ในช่องสูตร (Formula) ของ C พิมพ์ทับข้อความเดิมด้วย `${A} + ${B}` โดยตรง (ไม่มีปุ่ม "รวม/combine" แยกต่างหาก — สูตรเป็นช่องข้อความที่พิมพ์ได้อิสระ)
  - Save
  - **คาดหวัง:** **ต้องผ่าน** — C อยู่ปลายน้ำอยู่แล้ว การอ้างขึ้นไปข้างบนไม่ใช่วงจร

- [ ] **EDT-12 — สูตรที่ไม่อ้าง sensor เลย** 🆕
  - แก้สูตรเป็น `42`
  - Save
  - **คาดหวัง:** ถูกปฏิเสธพร้อมบอกให้ใช้ `$Name` หรือ `${Name With Spaces}`

- [ ] **EDT-14 — ⭐ ปิดเปิดโปรแกรมแล้วต้องไม่มีคอลัมน์ซ้ำ** 🆕
  - แก้สูตรของ special sensor สัก 2 ตัว
  - ปิดโปรแกรมสนิท เปิดใหม่ เปิด workspace เดิม
  - ไปดูแผง Sensor ว่าชื่อนั้นมีกี่รายการ
  - ปักบนกราฟดูว่าค่าคือสูตรใหม่
  - **คาดหวัง:** **ต้องมีชื่อละ 1 รายการเท่านั้น และค่าคือสูตรใหม่** — นี่คือจุดที่ต้องแก้ Rust ให้ทับคอลัมน์แทนการต่อท้าย ถ้าเห็นชื่อซ้ำ 2 อัน แปลว่า `replace` ไม่ทำงาน

- [ ] **EDT-15 — แก้แล้ว Scatter / Pair Plot อัปเดตด้วย** 🆕
  - เปิด Scatter โดยใช้ special sensor เป็นแกนหนึ่ง
  - ไปแก้สูตรของมัน
  - กลับมาดู Scatter
  - **คาดหวัง:** จุดขยับตามสูตรใหม่โดยไม่ต้องสลับ chart type ไป-กลับ

- [ ] **EDT-17 — Cancel edit ไม่บันทึกอะไร** 🆕
  - แก้สูตรมั่ว ๆ แล้วกด Cancel edit
  - เปิดฟอร์มใหม่
  - **คาดหวัง:** ค่ากลับเป็นของเดิม ไม่มีอะไรถูกคำนวณใหม่

- [ ] **EDT-19 — ⭐ Rename ตัวที่มี special sensor อื่นสร้างต่อ (สายโซ่)** 🆕
  - สร้าง A = `$TAG * 2`
  - สร้าง B = `${A} + 10`
  - ปักทั้ง A และ B บนกราฟ จดค่าไว้
  - เปิดแก้ A เปลี่ยนชื่อเป็น `A2` เท่านั้น (ไม่แตะสูตร)
  - Save changes
  - **คาดหวัง:** บันทึกสำเร็จ, แถวของ A เปลี่ยนชื่อเป็น A2 ทันที, **ค่าของ B ต้องไม่เปลี่ยนเลย** (ข้อมูลเบื้องหลังไม่ได้เปลี่ยน แค่ชื่ออ้างอิงเปลี่ยน), เปิดดูสูตรของ B ต้องอ่านว่า `${A2} + 10` — **ไม่ใช่ `${A} + 10` ที่ค้างชี้ไปชื่อที่ไม่มีอยู่แล้ว**

- [ ] **EDT-20 — Rename ตัวที่เป็น operation (ไม่ใช่ formula) ที่มีตัวอื่นสร้างต่อ** 🆕
  - สร้าง A เป็นบล็อก Average ของ 2 sensor
  - สร้าง B เป็นบล็อก Average ที่มี A เป็นหนึ่งใน source
  - เปิดแก้ A เปลี่ยนชื่อเป็น `A2`
  - Save changes
  - **คาดหวัง:** เปิดแก้ B อีกที — ชิป source ที่เคยเป็น A เปลี่ยนเป็น A2 อัตโนมัติ

- [ ] **EDT-21 — Rename ชื่อซ้ำ → ต้องกดไม่ได้** 🆕
  - เปิดแก้ special sensor ตัวหนึ่ง
  - พิมพ์ชื่อให้ตรงกับ raw sensor ที่มาจาก CSV
  - ลองพิมพ์ชื่อให้ตรงกับ special sensor ตัวอื่นอีกที
  - ลองสลับตัวพิมพ์เล็กใหญ่ (เช่น `TAG1` → `tag1`)
  - **คาดหวัง:** ทุกกรณีขึ้นข้อความ "... is already in use by another sensor" สีแดง และปุ่ม **Save changes จางลงกดไม่ได้** — เช็คชื่อซ้ำแบบไม่สนตัวพิมพ์เล็กใหญ่ (เหมือนจุดอื่นในแอปทั้งหมด)

- [ ] **EDT-22 — Rename ชื่อว่าง → ต้องกดไม่ได้** 🆕
  - ลบชื่อในช่อง Name ออกให้ว่างเปล่า หรือมีแต่ space
  - **คาดหวัง:** ขึ้นข้อความ "Name is required" และปุ่ม Save changes กดไม่ได้

- [ ] **EDT-23 — ⭐ Rename แล้วของที่ผูกกับกราฟต้องตามไปครบ** 🆕
  - ปักบนกราฟ + ตั้งสีเส้นเอง + ตรึงแกน Y + เปิด alarm line (ถ้ามี setpoint) ของ special sensor ตัวหนึ่ง
  - ถ้าอยู่ใน Scatter ให้ตั้งเป็นแกน X หรือ Y ด้วย
  - ในแท็บ Highlights → By value ตั้งให้ไล่สีตาม sensor ตัวนี้
  - เปิดแก้แล้วเปลี่ยนชื่อ, Save
  - ไปเช็คทุกจุดที่ตั้งไว้ทีละจุด
  - **คาดหวัง:** **ทุกจุด (สีเส้น / แกน Y ที่ตรึง / alarm line / แกน scatter / highlight by value) ต้องยังผูกกับ sensor ตัวเดิมอยู่ครบ ภายใต้ชื่อใหม่** — ห้ามมีจุดไหนรีเซ็ตกลับ default หรือหายไปเงียบ ๆ

- [ ] **EDT-25 — Rename แล้วปิดเปิดโปรแกรม** 🆕
  - ทำ rename ให้ครบกระบวนการ (เปลี่ยนชื่อ + มีของผูกอยู่แบบ EDT-23)
  - ปิดโปรแกรมสนิท เปิดใหม่ เปิด workspace เดิม
  - **คาดหวัง:** ชื่อใหม่ยังอยู่ ไม่ย้อนกลับไปชื่อเดิม และทุกอย่างที่ผูกไว้ใน EDT-23 ยังอยู่ครบเหมือนก่อนปิดโปรแกรม

- [ ] **EDT-26 — บังคับกรอกครบ 4 ช่องในฟอร์มแก้ไข (เหมือน Create) — ดู EDT-4b ด้านบนด้วย** 🆕
  - เปิดแก้ special sensor ตัวหนึ่ง
  - ลบ Name หรือ Description หรือ Unit ออกทีละช่อง
  - **คาดหวัง:** ปุ่ม Save changes จางลงกดไม่ได้ทุกกรณีที่ขาดช่องใดช่องหนึ่งจาก 4 ช่อง (Name/Description/Unit/Component) — ไม่ใช่แค่ Component เท่านั้น

- [ ] **EDT-27 — ⭐ Rename แล้วชื่อเก่าต้องว่าง และค่าไม่ปนกัน** 🆕
  - สร้าง `A` = `$TAG1 * 2` แล้วเปลี่ยนชื่อเป็น `A2`, Save
  - สร้าง special sensor ใหม่ชื่อ `A` ด้วยสูตรอื่น (เช่น `$TAG1 * 100`)
  - ดูกราฟของ `A` และ `A2`
  - **คาดหวัง:** สร้างชื่อ `A` ได้ (ไม่ขึ้น "already exists") — `A` แสดงค่าของสูตรใหม่ (×100) ส่วน `A2` ยังเป็น ×2 ไม่ปนกัน (เดิม rename ทิ้งคอลัมน์ชื่อเก่าค้าง ตัวที่สร้างใหม่ด้วยชื่อเก่าเลยได้ค่าของตัวเก่า)

- [ ] **EDT-28 — Rename แค่เปลี่ยนตัวพิมพ์เล็ก/ใหญ่ (เช่น `a` → `A`) sensor ต้องไม่หาย** 🆕
  - สร้าง `special a` ปักบนกราฟ แล้วสร้างอีกตัวที่ใช้มันเป็น source
  - เปิดแก้เปลี่ยนชื่อเป็น `Special A` (เปลี่ยนแค่ตัวพิมพ์) Save
  - **คาดหวัง:** บันทึกสำเร็จ ชื่อบนกราฟ/แผง Sensor/ใน Manage เป็น `Special A`, **เส้นและค่ายังอยู่ครบ (ไม่ถูกลบ)**, ตัวที่สร้างต่อยังคำนวณได้ และปิดเปิดโปรแกรมแล้วยังอยู่

- [ ] **EDT-29 — แก้ sensor ตัวต้น ๆ ให้ไปอ้าง sensor ที่สร้างทีหลัง แล้วปิดเปิดโปรแกรม ต้องกลับมาครบ** 🆕
  - สร้าง `A` = `$TAG1 * 2` แล้วสร้าง `C` = `$TAG1 + 1` (C สร้างทีหลัง A)
  - เปิดแก้ `A` เปลี่ยนสูตรเป็น `${C} * 2` Save
  - ปิดโปรแกรมสนิท เปิดใหม่ เปิด workspace เดิม ปักทั้ง A และ C
  - **คาดหวัง:** ทั้งสองตัวมีข้อมูลจริง ไม่มี toast สีแดง "couldn't be restored" (เดิมลำดับที่เก็บไว้ทำให้ A ถูกสร้างก่อน C ซึ่งยังไม่มี จึงพังตอนเปิด)

- [ ] **EDT-31 — ⭐ แก้ไม่สำเร็จกลางทาง ต้องย้อนกลับ ไม่ทิ้งค่าครึ่ง ๆ กลาง ๆ** 🆕
  - มี `A` ที่มี `B` และ `C` สร้างต่อ ปัก `A`, `B`, `C` บนกราฟ จดค่า
  - แก้สูตรของ `A` ให้ล้มตอนคำนวณตัวหลัง ๆ (เช่น ทำให้ `C` อ้าง sensor ที่ไม่มีข้อมูล หรือใช้ข้อมูลที่ทำให้คำนวณไม่ได้)
  - กด Save แล้วดู error จากนั้นกด Cancel และดูกราฟ
  - ลองเปลี่ยนชื่อ + แก้สูตรพร้อมกันแล้วทำให้ล้มแบบเดียวกัน
  - **คาดหวัง:** ขึ้น error ระบุชื่อ sensor ที่คำนวณไม่ได้ ("Could not recompute ...") — **กราฟกลับเป็นค่าเดิมของทั้ง A, B, C** (ไม่ใช่ค่าของสูตรใหม่ที่ไม่มี recipe ไหนสร้างได้) กด Cancel แล้วสูตรเดิมยังอยู่ และถ้าเป็นการเปลี่ยนชื่อ ไม่มี sensor ชื่อใหม่ค้างเป็นคอลัมน์ผี (สร้างชื่อนั้นใหม่ได้) — ถ้าย้อนกลับไม่สำเร็จจริง ๆ จะมีข้อความบอกว่า sensor ตัวไหนอาจแสดงค่าผิดและให้เปิด workspace ใหม่

- [ ] **EDT-32 — แก้ sensor ต้นสายใน workspace ที่บันทึกลำดับ recipe ไว้ผิด → ตัวที่สร้างต่อต้องคำนวณตามลำดับที่ถูก** 🆕
  - (ต้องมี workspace ที่บันทึกก่อน 2026-10-03 ซึ่งตัวที่สร้างต่อถูกเก็บไว้ก่อนตัวต้นสาย เช่น `C = $B*10`, `B = ${A}+1`, `A = $TAG1*2` — ถ้าไม่มีให้ข้ามข้อนี้)
  - เปิด workspace นั้น ปัก `C` แล้วแก้สูตร `A` เป็น `$TAG1 * 3` กด Save
  - **คาดหวัง:** ค่า `C` สอดคล้องกับ `B` ที่คำนวณใหม่ (คำนวณ A → B → C ตามลำดับพึ่งพา ไม่ใช่ตามลำดับที่เก็บไว้) — เดิม C ถูกคำนวณก่อน B จึงได้ค่าจาก B ตัวเก่า

- [ ] **EDT-33 — แก้ 2 ตัวติดกัน ให้กลายเป็นวงกลม → ต้องปฏิเสธตัวที่สอง** 🆕
  - มี `A` = `$TAG1 * 2` และ `C` = `$TAG3 + 1` (ต่างคนต่างไม่พึ่งกัน)
  - แก้ `A` เป็น `$C * 2` กด Save แล้ว **รีบ** เปิดแก้ `C` เป็น `$A + 1` กด Save ทันที
  - **คาดหวัง:** การ Save ตัวที่สองถูกปฏิเสธว่าจะทำให้ sensor พึ่งตัวเอง ("... would make it depend on itself") ไม่มี recipe วนกันเข้า workspace — ระบบอ่านการอ้างอิงสดใหม่จาก backend ทุกครั้งก่อนตรวจ ไม่ใช้ค่าที่จำไว้

- [ ] **EDT-57 — ⭐ special sensor ที่โมเดลใช้อยู่ → ล็อก: ช่องสูตรเส้นประอ่านอย่างเดียว ป้ายกุญแจสีเทา ประโยคเดียว (แทน EDT-35)** 🆕
  - สร้าง special sensor `A` แล้วเอาไปเป็น target ของโมเดลหนึ่งใน Build Model (ลองซ้ำกับ predictor / X / Y / criteria / Custom running condition)
  - กลับมาที่ Manage กดดินสอที่ `A`
  - **คาดหวัง:** หัวการ์ดมีป้ายกุญแจสีเทา เช่น "Used by 1 model" · บรรทัดใต้ช่อง: "Name and formula are locked. Used by 1 model: … Remove it from those models first, then you can edit it. Description, unit and component below can still change…" (ขึ้นครั้งเดียว) · ช่องสูตรขอบเส้นประ พิมพ์ไม่ได้ · **ไม่มีการ์ด Quick build และแถบเครื่องมือ** · Name อ่านอย่างเดียว · รายการซ้ายจาง มีข้อความ "The formula is locked, so sensors cannot be added." · Description / Unit / Component แก้ได้ ท้ายหน้าต่างเขียน "Saves the description, unit and component." · ถังขยะของแถวยังกดไม่ได้

- [ ] **EDT-36 — sensor ที่ล็อกอยู่ แก้แค่ Description / Unit / Component ได้ และค่าไม่ถูกแตะ** 🆕
  - ใช้ `A` จาก EDT-57 (ปักบนกราฟและจดรูปเส้น/ค่าไว้)
  - แก้ Description และ Unit แล้วกด Save changes
  - ปิดโปรแกรมสนิท เปิดใหม่ เปิด workspace เดิม
  - **คาดหวัง:** บันทึกสำเร็จทันที (ไม่มีคำว่า "Recomputing…" ค้างนาน และไม่มี error) — กราฟและค่าของ `A` ไม่เปลี่ยน ชื่อเดิม สูตรเดิม; Description/Unit ใหม่ขึ้นในรายการ Manage และแผง Sensor; โมเดลยังชี้ `A` เหมือนเดิม; หลังปิดเปิดโปรแกรมค่าใหม่ยังอยู่

- [ ] **EDT-37 — Running condition ของ workspace ก็ล็อกด้วย ("Used by the running condition")** 🆕
  - ใน Build Model → Running condition ตั้งเงื่อนไขที่ใช้ special sensor `A` แล้ว Apply (ยังไม่มีโมเดลไหนใช้ `A` โดยตรงก็ได้)
  - เปิดดินสอที่ `A` ใน Manage
  - **คาดหวัง:** ป้ายและบรรทัดล็อกบอก "Used by the running condition." Name/Formula อ่านอย่างเดียว — เอาเงื่อนไขนั้นออกแล้ว Apply ล็อกหายและแก้ได้ตามปกติโดยไม่ต้องปิด-เปิดหน้าต่าง

- [ ] **EDT-38 — ล็อกส่งต่อไปยัง sensor ที่ถูกใช้สร้างต่อ (transitive)** 🆕
  - สร้าง `A` = `$TAG1 * 2`, `B` = `${A} + 10`, `C` = `$B * 10` และ `Z` = `$TAG3 + 1` (ไม่เกี่ยวกัน)
  - ให้โมเดลหนึ่งใช้ `C` เป็น target
  - เปิดดินสอที่ `A`, `B`, `C`, `Z` ทีละตัว
  - **คาดหวัง:** `A` และ `B` ล็อก แบนเนอร์ระบุว่า "Built on by "C", which is used by 1 model: …" (บอกว่าตัวไหนที่ถูกใช้) — `C` ล็อก (โมเดลใช้โดยตรง) — `Z` แก้ได้ปกติ; ถ้าให้โมเดลใช้แค่ `A` อย่างเดียว `A` ล็อกแต่ `B`/`C` (ที่สร้างต่อจาก A) **ไม่ล็อก**

- [ ] **EDT-39 — ⭐ เอา sensor ออกจากโมเดลแล้วปลดล็อก → แก้ได้ และค่าอัปเดตตามทั้งสายโซ่** 🆕
  - เปิดหน้าต่าง Add Special Sensor → Manage ค้างไว้ และเปิดฟอร์มแก้ `A` (ที่โมเดลใช้อยู่ — ล็อก)
  - ไปที่ Build Model เอา `A` ออกจากโมเดลนั้น (หรือลบโมเดล)
  - กลับมาที่หน้าต่าง Add Special Sensor (ไม่ต้องปิดเปิด)
  - **คาดหวัง:** แบนเนอร์หายและช่อง Name/Formula แก้ได้เอง (หน้าต่างอ่านสถานะโมเดลจากไฟล์ใหม่ทุกครั้งที่ Build Model บันทึก) — แก้สูตรของ `A` แล้ว Save: `A` และ sensor ที่สร้างต่อถูกคำนวณใหม่ กราฟเปลี่ยนตาม และเปลี่ยนชื่อได้ (ชื่อที่ผูกกับกราฟตามไปครบเหมือน EDT-23)

- [ ] **EDT-40 — ⭐ โมเดลเพิ่งเอา sensor ไปใช้หลังเปิดฟอร์มแก้แล้ว → Save ต้องถูกปฏิเสธ ไม่แก้อะไร** 🆕
  - เปิดฟอร์มแก้ `A` (ตอนนี้ยังไม่มีโมเดลใช้ จึงแก้ได้) พิมพ์ชื่อใหม่หรือสูตรใหม่ **แต่ยังไม่กด Save**
  - ไปที่ Build Model ตั้ง `A` เป็น target/predictor ของโมเดลหนึ่ง (หน้าต่าง Add Special Sensor ยังเปิดอยู่)
  - กลับมากด Save changes
  - **คาดหวัง:** ขึ้น error สีแดงในฟอร์ม เช่น "Can't rename "A". Used by 1 model: … (Individual). …" (หรือ "Can't change the formula, operation or sources of "A" …") — **ไม่มีอะไรถูกคำนวณ/เปลี่ยน**: กราฟและค่าของ `A` เหมือนเดิม ชื่อเดิม และไม่มี sensor ชื่อใหม่โผล่ (ถ้าเปิดฟอร์มค้างไว้ ฟอร์มจะล็อกตามเมื่อ Build Model บันทึก)

- [ ] **EDT-41 — Rename แล้วเงื่อนไขในแท็บ Filter ของ Dashboard ตามไปด้วย (แทนส่วนที่เหลือของ EDT-30 เดิม)** 🆕
  - ที่ Dashboard แท็บ Filter มีเงื่อนไข `A > 4` ที่ Apply แล้ว และเงื่อนไขที่พิมพ์ค้างไว้ยังไม่ Apply (ใช้ `A` เช่นกัน) — ให้ `A` **ไม่มี**โมเดลหรือ Running condition ใช้อยู่ (แท็บ Filter ไม่ทำให้ล็อก)
  - เปลี่ยนชื่อ `A` เป็น `A2` ใน Manage แล้ว Save; ปิดโปรแกรมสนิท เปิดใหม่ ตรวจอีกรอบ
  - **คาดหวัง:** เงื่อนไขทั้งสองเปลี่ยนเป็น `A2` (ค่าที่พิมพ์ค้างไม่หาย), **กราฟยังกรองอยู่เหมือนเดิม** (ไม่กลายเป็นแสดงทุกแถว) และยังอยู่หลังปิดเปิดโปรแกรม — ส่วนการ rename ที่ตามไปถึง Running condition / โมเดล **เกิดไม่ได้แล้ว** เพราะ sensor ที่ถูกใช้ที่นั่นจะถูกล็อก (EDT-57/37)


- [ ] **EDT-42 — แก้สูตรให้ผิด → ข้อความแดงใต้ช่องสูตรทันที และ Save changes กดไม่ได้ (แทน EDT-13 เดิม)** 🆕
  - เปิดแก้ special sensor ที่เป็นสูตร
  - แก้สูตรให้อ้างชื่อ sensor มั่ว ๆ (เช่น `$NOPE * 2`) รอครึ่งวินาที
  - แก้เป็นฟังก์ชันที่ไม่มี (เช่น `foo($TAG1)`)
  - แก้กลับให้ถูก
  - **คาดหวัง:** ใต้ช่องสูตรขึ้น**ข้อความสีแดง**บอกเหตุผล (เช่น "Sensor not found: NOPE") ขอบช่องเป็นสีแดง ปุ่ม **Save changes จางลงกดไม่ได้** — แก้กลับให้ถูกแล้วข้อความแดงหาย กด Save ได้ (เปิดฟอร์มเฉย ๆ โดยไม่แก้สูตร ต้องไม่ขึ้นข้อความแดง)

- [ ] **EDT-44 — Rust ปฏิเสธสูตรตอนคำนวณ → ข้อความแดงในฟอร์ม ไม่มี toast "Updated"** 🆕
  - เปิดแก้สูตร พิมพ์สูตรที่ใช้ฟังก์ชันที่ไม่มี (เช่น `foo($TAG1)`) แล้วรีบกด Save changes ทันทีก่อนข้อความแดงใต้ช่องสูตรจะขึ้น
  - **คาดหวัง:** ขึ้นข้อความสีแดงในฟอร์มบอกว่าคำนวณไม่ได้เพราะอะไร (ชื่อฟังก์ชันที่ไม่รู้จัก) ฟอร์มยังเปิดอยู่ **ไม่มี toast สีเขียว "Updated …"** และค่าเดิมของ sensor บนกราฟไม่ถูกแตะ

- [ ] **EDT-59 — รายการ Manage บอกจำนวนทศนิยมของ sensor ที่ปัด (แทน EDT-45)** 🆕
  - มี sensor แบบ Round to decimals = 0 และ = 3 (จากเวอร์ชันเก่า) และสูตรที่ตั้ง Round the result = 2
  - ดูแท็บ Manage
  - **คาดหวัง:** แสดงเป็น "TAG rounded to 0 decimals", "TAG rounded to 3 decimals" และ "… · rounded to 2 decimals" — แยกกันออกได้ชัด

- [ ] **EDT-46 — workspace เก่าที่มีสูตรซึ่งตอนนี้ไม่ผ่านแล้ว (เช่น `$A * pi`) เปิดได้ปกติ และบอกเหตุผล** 🆕
  - ใช้ workspace ที่บันทึกด้วยเวอร์ชันก่อน 2026-10-08 ซึ่งมี special sensor สูตร `$TAG1 * pi` (เดิมสร้างได้แต่ค่าว่างทั้งเส้น) — ถ้าไม่มี ให้แก้ไฟล์ workspace JSON ใส่ recipe นี้เอง
  - เปิด workspace จาก Recent Workspaces
  - เปิดหน้าต่าง Special Sensors แท็บ Manage
  - **คาดหวัง:** workspace **เปิดได้** มี toast เดียวบอกว่า sensor นั้น "couldn't be restored" **พร้อมเหตุผลจาก Rust** (เช่น "unknown name 'pi'. Write pi() for π.") และบอกวิธีแก้ ("To fix: on the Dashboard open Add Special Sensor > Manage and edit it (pencil) to correct the formula.") sensor นั้นไม่ถูกปักบนกราฟ แต่ยัง**อยู่ในแท็บ Manage ให้แก้สูตร**ได้ และ sensor อื่นคำนวณครบ

- [ ] **EDT-60 — ⭐ sensor ที่กู้ไม่ได้ตอนเปิด workspace และมีโมเดลใช้อยู่ → โหมดซ่อม: สูตรแก้ได้ ชื่อล็อก ปุ่มแก้อยู่ในข้อความ ท้ายหน้าต่างบอกจำนวนโมเดล (แทน EDT-49)** 🆕
  - เตรียม workspace ที่มี special sensor `A` สูตร `$TAG1 ($TAG2)` (ขาดเครื่องหมายคูณ — แก้ไฟล์ workspace JSON เอง) และโมเดลที่ใช้ `A` เป็น target ซึ่ง **Mark complete แล้ว** และโมเดลอีกตัวที่ไม่ใช้ `A` ซึ่ง Complete อยู่
  - เปิด workspace → Add Special Sensor → Manage → ดินสอที่ `A`
  - กดปุ่ม **Insert ×** บนบรรทัดตรวจ แล้ว Save changes
  - เปิดแท็บ Failure Groups และหน้าต่าง Build Model แล้วเปิดแก้ `A` อีกครั้ง
  - **คาดหวัง:** หัวการ์ดมีป้ายส้ม "No data — fix formula" และกล่องส้ม "This sensor has no data this session — its formula was refused when the project opened: <เหตุผล>. Fix the formula and save. The name stays locked; 1 model trained on it will need training again (set points are kept)." · ช่องสูตร**แก้ได้** (ไม่มีแถบล็อก) จุดที่ผิดขีดเส้นหยักแดง · ท้ายหน้าต่าง "Saving restores the data; 1 model goes back to Incomplete (set points kept)." · Save แล้ว toast "Restored A. 1 model(s) set back to Incomplete — train them again." · โมเดลที่ใช้ `A` ไม่เป็น Complete แล้ว (ทั้ง Failure Groups และ Build Model) set point ยังอยู่ · โมเดลที่ไม่ใช้ `A` ยัง Complete · เปิดแก้ `A` อีกครั้งกลับเป็นล็อกปกติ

- [ ] **EDT-48 — sensor ที่กู้ไม่ได้: แก้แค่ Description/Unit/Component แล้ว Save ได้ ไม่ขึ้น error** 🆕
  - ใช้ workspace แบบ EDT-60 (ยังไม่ต้องแก้สูตร) ทั้งกรณีที่มีโมเดลใช้ `A` และกรณีไม่มีโมเดลใช้
  - เปิดแก้ `A` แก้แค่ Description แล้ว Save changes
  - **คาดหวัง:** บันทึกได้ (ปุ่ม Save กดได้แม้บรรทัดตรวจยังแดงที่สูตรเดิม เพราะไม่ได้แก้คณิต) ไม่มีข้อความแดงที่ท้ายหน้าต่าง Description ใหม่ขึ้นในรายการ Manage และบน Dashboard; ป้าย "No data — fix formula" ยังอยู่; โมเดลที่ใช้ `A` ยัง Complete เหมือนเดิม

- [ ] **EDT-61 — sensor ที่กู้ไม่ได้สองตัวต่อกัน → แก้ตัวแรกแล้วบันทึกได้ ตัวหลังขึ้นว่าต้องแก้ต่อ (แทน EDT-50)** 🆕
  - เตรียม workspace (แก้ไฟล์ JSON) ที่มี `A` = `$TAG1 ($TAG2)` และ `B` = `${A} (2)` และมีโมเดลที่ใช้ `B` เป็น target (Complete)
  - เปิด workspace → ดู toast ตอนเปิด แล้วไป Add Special Sensor → Manage
  - แก้ `A` เป็น `$TAG1 * 3` แล้ว Save changes
  - **คาดหวัง:** ตอนแรกป้ายส้มที่ `A` เท่านั้น (`B` ถูกข้าม) · หลัง Save toast "Restored A. B still needs fixing: … 1 model(s) set back to Incomplete — train them again." ไม่มีข้อความแดง สูตรใหม่ของ `A` ถูกเก็บ ป้ายส้มย้ายไปที่ `B` แล้วแก้ `B` ได้ตามปกติ — ป้ายส้มหายหมด

- [ ] **EDT-51 — sensor แบบปุ่ม (operation เช่น Add / Sum) ที่กู้ไม่ได้: แก้แค่ Unit แล้ว Save ได้ ไม่ขึ้น error** 🆕
  - เตรียม workspace ที่มี special sensor แบบปุ่ม (เช่น `TAG1 + 10`) ซึ่ง source sensor ไม่มีใน CSV แล้ว (แก้ไฟล์ workspace JSON เปลี่ยน `sourceSensors` เป็นชื่อที่ไม่มี) และมีโมเดลใช้ sensor นี้
  - เปิด workspace → Add Special Sensor → Manage → เปิดแก้ sensor นั้น → แก้แค่ Unit แล้ว Save changes
  - **คาดหวัง:** ป้ายส้ม "No data — fix formula" ชี้เมาส์เห็น "Sensor not found: …"; Save แค่ Unit แล้ว**บันทึกได้ ไม่มีข้อความแดง** Unit ใหม่ขึ้นในรายการ; โมเดลที่ใช้ยัง Complete เหมือนเดิม; ป้ายส้มยังอยู่

- [ ] **EDT-62 — ⭐ workspace เก่าที่มี `round($TAG1, 2)` แปลงให้อัตโนมัติตอนเปิด และบอกว่าค่าเปลี่ยน + โมเดลกลับเป็น Incomplete** 🆕
  - เตรียม workspace (บันทึกด้วยเวอร์ชันก่อน 2026-10-09 หรือแก้ JSON) ที่มี `A` = `round($TAG1, 2)` (และ/หรือ `round(${A}, 1)` ในอีกตัว) และมีโมเดลที่ใช้ `A` ซึ่ง Complete อยู่ ปักค่าเดิมจดไว้ถ้าทำได้
  - เปิด workspace จาก Recent Workspaces
  - ดูกล่องข้อความที่เด้งขึ้น, แท็บ Manage, กราฟ, Failure Groups และ Build Model · ปิดโปรแกรมแล้วเปิด workspace เดิมอีกครั้ง
  - **คาดหวัง:** Dashboard เปิดขึ้นตามปกติ แล้วมี**หน้าต่างข้อความแบบแจ้งข้อมูล (ไม่ใช่ error สีแดง/toast) ชื่อ "Rounding updated"** หนึ่งหน้าต่างเขียนว่าแก้การปัดใน 1 special sensor (`A`) จาก `round(x, n)` เป็น `round(x * 10ⁿ) / 10ⁿ` · **บอกชัดว่าค่าต่างจากที่เคยเห็นเพราะรูปแบบเก่าคำนวณผิด** · บอกจำนวนโมเดลที่ถูกตั้งกลับเป็น Incomplete ให้ train ใหม่ · Manage เขียน `$TAG1 · rounded to 2 decimals` (ไม่มีป้ายส้ม "No data") · กราฟมีค่า (ปัด 2 ตำแหน่งจริง) · โมเดลที่ใช้ `A` ไม่เป็น Complete แล้ว · เปิดครั้งที่สอง**ไม่มี**กล่องข้อความนี้อีก (แปลงไปแล้ว)

---

## FG

### แท็บ Failure Groups

- [ ] **FG-1 — สร้างกลุ่มเปล่า**
  - กดสร้างกลุ่มใหม่
  - **คาดหวัง:** กลุ่มถูกสร้างและขึ้นในรายการทันที

- [ ] **FG-2 — แก้รายละเอียดกลุ่ม**
  - แก้ Name
  - แก้ Description
  - แก้ Recommendation
  - **คาดหวัง:** บันทึกครบทั้ง 3 ช่องและยังอยู่หลังปิดเปิด

- [ ] **FG-8 — ลบกลุ่ม / ลบโมเดล (ปุ่มลบโมเดลอยู่ข้างในแถว sensor ที่กางออก)** 🆕
  - กางแถว sensor ในการ์ดกลุ่มแล้วลบโมเดลออกทีละตัว (ปุ่มถังขยะอยู่ในรายการโมเดลข้างใน ไม่ได้อยู่ที่หัวแถว)
  - ลบทั้งกลุ่ม
  - **คาดหวัง:** ลบโมเดลตัวไหนหายเฉพาะตัวนั้น โมเดลอื่นของ sensor เดียวกันยังอยู่ (ชิป I/R/C ของชนิดที่ถูกลบหายไป) — ลบตัวสุดท้ายของ sensor แล้วทั้งแถว sensor หายไป — ลบทั้งกลุ่มได้ และแผง Sensor ฝั่งขวาเห็นการเปลี่ยนแปลงตาม

- [ ] **FG-4 — สีประจำกลุ่ม**
  - ดูสีของแต่ละกลุ่ม
  - **คาดหวัง:** แต่ละกลุ่มสีต่างกันและสีเดียวกันทุกที่ที่กลุ่มนั้นโผล่


- [ ] **FG-6 — ⚠️ กลับจากหน้า Failure Group มา Dashboard** 👀
  - เข้าแท็บ Failure Groups
  - กดปุ่มย้อนกลับ
  - **คาดหวัง:** ควรกลับมาที่ Dashboard — **มีรายงานค้างว่ามันเด้งกลับไปหน้าเริ่มโปรแกรม** ให้ยืนยันว่ายังเป็นอยู่ไหม

- [ ] **FG-7 — ปุ่ม Build Model**
  - กด Build Model จากแท็บ Failure Groups
  - กดซ้ำตอนหน้าต่างเปิดอยู่แล้ว
  - **คาดหวัง:** เปิดหน้าต่าง Build Model และเปิดได้ทีละหน้าต่างเท่านั้น (singleton) — กดซ้ำแล้วหน้าต่างเดิมถูกดึงขึ้นมาหน้าสุดและแสดงข้อมูลของ workspace ปัจจุบัน ไม่เปิดซ้อน

- [ ] **FG-9 — แท็บ Failure Groups จัดเป็นหนึ่งบรรทัดต่อ sensor (ไม่มีตัวเลือก Category)** 🆕
  - ให้ sensor ตัวเดียวมีโมเดลหลายชนิด (เช่น Individual + Relation model) ในกลุ่มเดียวกัน
  - ดูการ์ดของกลุ่มนั้น แล้วกดที่บรรทัด sensor เพื่อกาง/พับ
  - **คาดหวัง:** sensor เดียวขึ้นบรรทัดเดียวพร้อมชิป I / R / C เฉพาะชนิดที่มีจริง (Clustering จัดตาม X sensor) — กางออกเห็นโมเดลแต่ละตัวพร้อมปุ่มลบ — ข้อความยาวตัดด้วย … บรรทัดเดียว — **ไม่มีปุ่ม Category ที่แผงนี้** (ตั้งที่หัว sensor ในหน้าต่าง Build Model) — (ตัวเลขสรุปด้านบนตรวจที่ FG-16)

- [ ] **FG-10 — เปลี่ยนชื่อ / แก้รายละเอียด / สร้าง / ลบกลุ่มบน Dashboard ต้องไม่ทับ Category และช่วงเวลาที่ตั้งไว้ใน Build Model (แก้บั๊ก QA 2026-09-24)** 🆕
  - เปิด Build Model ตั้ง Category ที่หัว sensor และเพิ่ม Training periods ให้โมเดลแบบ Custom ไว้
  - กลับไป Dashboard แท็บ Failure Groups เปลี่ยนชื่อกลุ่ม → แก้คำอธิบาย → สร้างกลุ่มว่างใหม่ → ลบกลุ่มหนึ่ง
  - เปิด Build Model ซ้ำ (หรือปิดเปิด workspace)
  - **คาดหวัง:** Category และ Training periods ยังเป็นค่าที่ตั้งล่าสุด ไม่ย้อนกลับเป็นค่าเก่า และแบนเนอร์แจ้งเตือน category ไม่ขึ้นซ้ำ

- [ ] **FG-14 — จุดสถานะที่มุมป้าย I/R/C ในแท็บ Failure Groups: ไม่มีจุด / เหลือง (Set points needed) / แดง (Fix set point) / ฟ้า / เขียว (แทน FG-13 — ตอนนี้จุดอ่านผล validate ที่บันทึกไว้กับโมเดล)** 🆕
  - Train โมเดล Relation model หรือ Clustering ของ sensor หนึ่ง (set point ยังว่าง) โดยไม่ต้องเปิดหน้า "Health score" แล้วดูป้ายของมันในแท็บ Failure Groups ที่ Dashboard (ไม่ต้องกางบรรทัด sensor)
  - เปิดหน้า "Health score" กรอกค่าที่ไม่ผ่าน (เช่น N = 2 หรือ L ที่อยู่ในช่วง 3SD) แล้วกลับมาดูแท็บ Failure Groups
  - แก้ให้ผ่านแล้วดูอีกครั้ง จากนั้นกด "✓ Mark complete" (ดู BMW-158) แล้วดูอีกครั้ง
  - แก้ค่าที่ทำให้โมเดล stale (เช่นแก้ predictor หรือเงื่อนไข Running condition) แล้วดู จากนั้น Re-train
  - ปิดโปรแกรมแล้วเปิดใหม่ เลือก Recent Workspace เดิม ดูแท็บ Failure Groups ทันที (ก่อนเปิด Build Model)
  - **คาดหวัง:** ยังไม่เคย train = ไม่มีจุด · Train แล้ว set point ยังว่าง = จุดเหลือง (ตรงกับจุดเหลืองบนแท็บของ Build Model ที่ tooltip เขียน "Set points needed" และจุดเหลืองในลิสต์ซ้าย — บนแท็บไม่มีป้ายข้อความแล้ว) · ค่าที่ไม่ผ่าน = จุดแดง (ตรงกับ "Fix set point") — **ทั้งสองหน้าต้องเห็นตรงกัน** · ผ่านแล้วแต่ยังไม่ Complete = จุดฟ้า · Complete = เขียว (verdict ไม่มีผลกับโมเดล Complete) · stale = ไม่มีจุด และเมื่อ Re-train แล้วถูกตัดสินใหม่ (ค่าเก่าไม่ติดมา) · หลังเปิดโปรแกรมใหม่ จุดเหลือง/แดงยังอยู่ทันที ไม่ต้องเปิด Build Model (ผลถูกบันทึกกับโมเดล) · โมเดลที่ถูก Running Condition gate บล็อกอยู่ไม่ขึ้นจุดสีฟ้า/เหลือง/แดง

- [ ] **FG-15 — แถว sensor ในแท็บ Failure Groups หน้าตาเหมือนแถวในแท็บ Sensor** 🆕
  - เปิดแท็บ Failure Groups ดูแถว sensor ในแต่ละกลุ่ม
  - ค้นหาด้วยหน่วยหรือชื่อ component
  - **คาดหวัง:** ชื่อเป็น 2 บรรทัด (description + ป้ายหน่วย / tag) ขนาดและระยะเหมือนแท็บ Sensor · ไม่มีรูปแบบ "description (tag)" ที่แถว sensor อีก (แถวโมเดลที่กางออกยังเป็นชื่อโมเดลเหมือนเดิม) · ค้นด้วยหน่วย/component แล้วเจอ

- [ ] **FG-12 — สร้างโมเดล Individual ของ sensor ที่มี / ไม่มี alarm limit ยังทำงานปกติ (เตรียมโครง Health score — ยังไม่มีหน้าจอ set point)** 🆕
  - สร้างโมเดล Individual (ผ่านไอคอนโฟลเดอร์ที่แท็บ Sensor หรือสร้างกลุ่มใหม่จาก sensor) ให้ sensor 3 แบบ: (ก) sensor ที่ mapping มี alarm L และ H ครบ (ข) sensor ที่มีแค่ด้านเดียวหรือไม่มีเลย (ค) special sensor ที่สร้างเอง
  - สร้าง Relation model และ Clustering ให้ sensor ใดก็ได้
  - ลองสลับ sensor เข้า/ออกจาก Failure Group หลายกลุ่ม ลบโมเดลแล้วกด Undo
  - **คาดหวัง:** ทุกกรณีสร้างโมเดลได้ปกติ ชื่อ/กลุ่ม/สถานะเหมือนเดิมทุกอย่าง **ไม่มีอะไรใหม่ให้เห็นบนหน้าจอ** (เวอร์ชันนี้โปรแกรมแค่จด "ค่า alarm L/H จาก master data ณ ตอนสร้างโมเดล" ไว้เงียบ ๆ ในไฟล์ workspace สำหรับฟีเจอร์ Health score ที่ยังไม่ทำ — ไม่เปลี่ยนค่า alarm เดิม ไม่เปลี่ยนเส้น alarm บนกราฟ) · Undo แล้วโมเดลกลับมาครบ

- [ ] **FG-16 — Dashboard เปิดที่แท็บ Failure Groups + กล่องฟ้า + บรรทัดสรุป (แทน FG-5, customer batch 2026-10 item 5)** 🆕
  - เปิดโปรเจกต์ใหม่ผ่าน step 3 (ทั้งแบบใส่กลุ่มและแบบ Skip) · เปิดโปรเจกต์เดิมที่**ไม่มีกลุ่มเลย**จาก Recent · เปิดโปรเจกต์เดิมที่**มีกลุ่ม**จาก Recent
  - ดูบรรทัดสรุปบนแผง แล้วใส่ sensor เข้ากลุ่ม (I/R/C) ให้ครบทุกกลุ่ม · ลองให้ sensor ตัวเดียวอยู่หลายกลุ่ม/หลายชนิด
  - เลื่อนกราฟ/ชี้เมาส์บนกราฟไปมาแรง ๆ ตอนอยู่แท็บ Failure Groups
  - **คาดหวัง:** โปรเจกต์ใหม่ทุกแบบ และโปรเจกต์ที่ไม่มีกลุ่ม = เปิดที่**แท็บ Failure Groups** · โปรเจกต์ที่มีกลุ่ม = เปิดที่แท็บ Sensor เหมือนเดิม · ไม่มีกลุ่ม = กล่องฟ้า "**No failure groups yet.** Failure groups come first: create one below…" (ไม่มีข้อความ "No failure groups yet" ซ้ำอีกที่) · มีกลุ่มว่าง = กล่องฟ้า "**Your failure groups are ready.** Next, assign the sensors… use the Failure groups button [ไอคอนโฟลเดอร์] on a sensor row, or click Assign sensors on a group" (ไม่มีอีโมจิ 📁) และกลุ่มว่างแต่ละกลุ่มขึ้น "No sensors yet **Assign sensors →**" · ทุกกลุ่มมี sensor แล้ว = กล่องฟ้าหาย · บรรทัดสรุป "**N** groups · **M** sensors assigned · **x** of **y** models complete" — sensor ตัวเดียวในหลายกลุ่ม/หลายชนิดนับครั้งเดียว, sensor ที่อยู่แค่ "Not in Group" ไม่นับ · การ์ด "Not in Group" ยังเขียน "No models yet" · ไม่มีบรรทัด description ใต้ชื่อกลุ่มบนการ์ด (ดู/แก้ได้ใน Edit details) · เลื่อนกราฟแล้วแผงไม่หน่วง

- [ ] **FG-17 — "Assign sensors →": ใส่ sensor ให้กลุ่มจากแท็บ Sensor** 🆕
  - ที่กลุ่มว่าง กด **Assign sensors →**
  - ดูแถบบนแท็บ Sensor และตัวเลขที่หัว component · กางกลุ่ม component แล้วกดปุ่ม Failure groups (ไอคอนโฟลเดอร์) ของ sensor หนึ่ง
  - ใน sheet: ดูแถวบนสุด · ติ๊ก I ของกลุ่มนั้น · กด ‹ › ไป sensor ถัดไป · ดูบรรทัดใต้ช่อง "New failure group name" แล้วพิมพ์ชื่อกลุ่มใหม่กด Enter
  - ปิด sheet ด้วย **Esc** (แล้วเปิดใหม่ปิดด้วย ✕ และ Done) ดูว่าโฟกัสคีย์บอร์ดไปอยู่ที่ไหน · คลิกบนกราฟเพื่อปิด
  - เอา sensor ออกจากกลุ่มสุดท้ายของโมเดล (ช่องที่มี tooltip ว่าจะลบโมเดล)
  - กด **Done** บนแถบฟ้า · ทำอีกรอบแล้วกดแท็บ Failure Groups เองแทน
  - **คาดหวัง:** สลับไปแท็บ Sensor พร้อมแถบฟ้า "Assigning to **FG-n · ชื่อกลุ่ม**. Use the Failure groups button [ไอคอน] on a sensor row." + ปุ่ม Done (โฟกัสคีย์บอร์ดอยู่ที่ Done ทันที) · หัว component เป็น "จำนวนที่อยู่ในกลุ่มนี้ / ทั้งหมด" (0 ก็แสดง "0 / N") และเพิ่มขึ้นทันทีที่ติ๊ก · ใน sheet กลุ่มนั้นอยู่**บนสุด** พื้นฟ้า และมีป้าย "Assigning" แทน FG-n · บรรทัดใต้ช่องสร้างกลุ่มเขียน "Enter creates the group and adds this sensor's Individual model to it." และ Enter ทำแบบนั้นจริง (กลุ่มใหม่ + I ของ sensor นี้) · Esc / ✕ / Done แล้วโฟกัสกลับไปที่ปุ่ม Failure groups ของแถวนั้น (กด Enter/Space ต่อได้เลย) · คลิกกราฟปิด sheet โดยไม่ดึงโฟกัส · เอาออกจากกลุ่มสุดท้าย = โมเดลถูกลบพร้อมป้าย Undo 7 วินาที · Done = กลับแท็บ Failure Groups และแถบฟ้าหาย (กลับมาแท็บ Sensor ไม่มีแถบแล้ว) โฟกัสไปที่ลิงก์ "Assign sensors →" ของกลุ่มนั้น หรือที่แท็บ Failure Groups ถ้ากลุ่มมี sensor แล้ว · ลบกลุ่มที่กำลัง assign (⋯ → Delete… ใน sheet) = แถบฟ้าหายทันที และสร้างกลุ่มใหม่ต่อจากนั้นต้อง**ไม่**มีแถบ/ป้าย "Assigning" กลับมา · กดแท็บ Failure Groups เองก็จบโหมดนี้เหมือนกัน

- [ ] **FG-18 — ปุ่ม "Build Model →" ตอนยังไม่มีโมเดล** 🆕
  - โปรเจกต์ที่มีกลุ่มแต่ยังไม่มีโมเดลเลย (หรือ Skip step 3) → ดูปุ่ม Build Model → ท้ายแท็บ Failure Groups แล้วชี้เมาส์ค้าง
  - ใส่ sensor เข้ากลุ่ม 1 ตัวแล้วดูปุ่มอีกครั้ง
  - **คาดหวัง:** ไม่มีโมเดล = ปุ่มยังอยู่ที่เดิมแต่จาง กดไม่ได้ tooltip "No models yet — assign sensors to a failure group first" · มีโมเดลแล้ว = กดได้และเปิดหน้าต่าง Build Model (FG-7) · ไม่มีปุ่ม Build Model ที่หัว Dashboard (ที่นี่ที่เดียว)

---

## BMW

### หน้าต่าง Build Model — Workbench (Model fit + Health score)

> **หน้าตาปัจจุบัน (2026-10-10, Workbench redesign):** บนสุดเป็นบรรทัด Running condition บรรทัดเดียว (ยังไม่ตั้ง / ช่วงผิด = การ์ดใหญ่มีปุ่มของตัวเอง) · ซ้ายเป็นลิสต์ sensor (ค้นหา + filter chip + Group by Failure group / Component, ปุ่ม "▶ Train all" อยู่เหนือลิสต์) · ขวาเป็น detail pane ของ sensor ที่เลือก: หัว (ชื่อ sensor + กลุ่มปุ่มเดียว Performance/Condition · "▶ Train sensor"), แท็บชนิดโมเดลที่มี**จุดสถานะ** (ไม่มีป้ายข้อความ), "Model settings" พับได้, เนื้อหาของหน้า (กราฟจริง) และ footer ที่บอกสถานะเป็นคำ**ที่เดียว** · โมเดลเป็น Complete ได้จากปุ่ม "✓ Mark complete" ในหน้า Health score เท่านั้น · ไม่มีแถบขั้นตอน ไม่มี "Group by Model Type" ไม่มีหน้า Predictive Model / "Open full view" / "Finish" แล้ว

- [ ] **BMW-1 — เลือกกลุ่มได้หลายกลุ่ม**
  - ให้ sensor ตัวเดียวมีโมเดลอยู่ 2 Failure Group พร้อมกัน (ติ๊กที่ Dashboard แท็บ Sensor)
  - **คาดหวัง:** ทำได้ (many-to-many) ไม่สร้างโมเดลซ้ำอีกใบ — ในลิสต์ซ้ายเมื่อ Group by Failure Group จะเห็น sensor นี้**ขึ้นแถวเดียวกันซ้ำในทั้งสองกลุ่ม** แต่คลิกแถวไหนก็เปิด detail pane เดียวกัน (ทุกโมเดลของ sensor นั้น ไม่ใช่เฉพาะของกลุ่มที่คลิก)

- [ ] **BMW-2 — Not in Group**
  - เอาโมเดลออกจากทุกกลุ่มจริง
  - **คาดหวัง:** ตกไปอยู่หัวข้อ "Not in Group" ในลิสต์ซ้าย (Group by Failure Group) ซึ่งเป็นถังพิเศษหมายเลข 0 (ลบไม่ได้ และแสดงเสมอแม้ไม่มี sensor อยู่ในนั้น)

- [ ] **BMW-4 — sync สองทางกับ Dashboard (ทั้งสองทิศทาง)**
  - เปิดหน้าต่าง Build Model ค้างไว้
  - **ไปแก้กลุ่มที่ Dashboard** (เช่น ติ๊ก sensor เข้า/ออกจากกลุ่ม, สร้างกลุ่มใหม่, ลบโมเดล) โดยไม่ปิดหน้าต่าง Build Model
  - ดูหน้าต่าง Build Model
  - แล้วลองแก้บางอย่างที่ Build Model (เช่น แก้ชื่อโมเดลแล้วกด "Save changes" หรือกด "✓ Mark complete" ที่หน้า Health score) แล้วดูแผง Failure Groups ที่ Dashboard
  - **คาดหวัง:** ทั้งสองฝั่งอัปเดตทันทีโดยไม่ต้องปิดเปิดหน้าต่าง ไม่มีฝั่งไหนเขียนทับของอีกฝั่ง

- [ ] **BMW-5 — สลับ workspace ขณะหน้าต่างเปิดอยู่**
  - เปิด Build Model **และ Add Special Sensor** ค้างไว้
  - กลับหน้า Import แล้วเปิด workspace อื่น
  - **คาดหวัง:** ทั้งสองหน้าต่างปิดเองอัตโนมัติ ไม่ค้างชี้ข้อมูลของ workspace เก่า

- [ ] **BMW-226 — หัว detail pane: ข้อมูล sensor ทางซ้าย + กลุ่มปุ่มเดียวทางขวา (Performance/Condition · Train sensor — ไม่มีสวิตช์หน้าแล้ว), แท็บ Individual / Relation model / Clustering, "Model settings" พับได้ (แทน BMW-131)** 🆕
  - เลือก sensor ที่มีโมเดลมากกว่า 1 ชนิดและอยู่หลาย Failure Group จากลิสต์ซ้าย
  - ดูหัว detail pane: ชื่อ sensor + หน่วย, tag, ชิป Component, ชิป Failure Group — และกลุ่มปุ่มทางขวา
  - ย่อหน้าต่าง (หรือเปิดลิสต์ซ้ายไว้ให้ detail pane แคบกว่า ~1000 px) ดูกลุ่มปุ่มเดิม
  - กดสลับ Performance / Condition แล้วปิดเปิดโปรแกรม
  - ดูแถบแท็บใต้หัว · กด "Model settings" เพื่อพับ/กาง แล้วสลับแท็บไปมา แก้ค่าในแท็บหนึ่งแล้วสลับไปแท็บอื่นและสลับกลับ
  - โมเดลที่ตั้ง Training data เป็น Custom แต่ยังไม่ใส่เงื่อนไขของตัวเอง — เลือกแท็บนั้น
  - **คาดหวัง:** ชิป Failure Group เรียงต่อกันในแถวเดียว (ตัดบรรทัดเองเมื่อยาว) · ทางขวาเป็น**กลุ่มเดียว 2 อย่าง**: สวิตช์ Performance/Condition และปุ่ม "▶ Train sensor" พร้อมบรรทัดสั้น ๆ ใต้ปุ่ม **หนึ่งบรรทัด** — **ที่หัวไม่มีสวิตช์ "Model fit | Health score" แล้ว** (เปลี่ยนหน้าด้วยปุ่มที่ footer — BMW-227) · pane แคบ: ทั้ง 2 อย่างย้ายลงมาเป็น**แถวเดียว**ใต้ชื่อ (ไม่ใช่ทีละอันต่อบรรทัด) · **Performance/Condition ยังอยู่ ค่าที่เลือกถูกบันทึกทันทีและยังอยู่หลังปิดเปิด** (ใช้กับทุกโมเดลของ sensor นั้น — ดู BMW-32) · แท็บเขียน "Individual" / **"Relation model"** / "Clustering" (เฉพาะชนิดที่มีจริง) + ตัวอักษรชนิด + จุดสถานะ 1 จุด — **ไม่มีป้ายข้อความบนแท็บเลย** (ไม่มี "Trained", "Re-train", "edited", "Needs condition"; ดู BMW-132) · สลับแท็บไม่ทำให้ค่าที่พิมพ์ค้างในแท็บอื่นหาย — ค่าที่แก้ค้างไว้ยังไม่ Save บอกที่ footer "Unsaved changes to the … model" และมีปุ่ม "Save changes" (ดู BMW-134) · "Model settings" **กางเองเมื่อสิ่งที่ต้องแก้อยู่ข้างใน**: ตั้งค่าไม่ครบ (พร้อมป้าย "N to fix") หรือโมเดล Custom ที่ Running condition ของตัวเองยังไม่ครบ — และ**พับเองพร้อมสรุปบรรทัดเดียว**เมื่อครบ (ชื่อ · predictors/Y · stiffness/clusters · data scope) — กดพับ/กางเองได้เสมอ (ที่ผู้ใช้กดไว้ชนะ) — ชนิดโมเดลเปลี่ยนที่นี่ไม่ได้ ไม่มีช่อง Category ในฟอร์ม

- [ ] **BMW-40 — ฟิลด์ใหม่ใน Model settings: Stiffness (Relation model), จำนวน cluster (Clustering), และสวิตช์ Workspace/Custom (ทุกชนิด)** 🆕
  - กาง Model settings ของโมเดล Relation model — ดูตัวเลือก Stiffness 4 ระดับ (Very loose/Loose/Standard/Strict)
  - กาง Model settings ของโมเดล Clustering — ดูปุ่ม −/+ ปรับจำนวน cluster ข้าง Y sensor / Criteria sensor (ตั้งได้ 1–5 — ดู **BMW-165**)
  - กาง Model settings ของโมเดล Individual — ดูป้ายนิ่ง "1σ + 3σ · automatic" (ไม่มีปุ่มปรับ)
  - ทุกชนิด: ดูสวิตช์ "Training data: Workspace | Custom" ท้ายฟอร์ม แล้วสลับแล้วกด Save changes
  - **คาดหวัง:** เลือก Stiffness/จำนวน cluster ได้ ค่าอยู่หลัง Save — สวิตช์ Workspace/Custom เปลี่ยนโหมดได้ (ดู **BMW-194** สำหรับสิ่งที่โผล่มาเมื่อเลือก Custom — 2026-09-30: ตอนนี้แก้เงื่อนไข/ช่วงเวลาของ Custom ได้ตรงนี้เลย ไม่ต้องไปหน้าอื่นแล้ว) — **(2026-09-30)** ช่อง "Model name" กว้างพอ/ยืดหยุ่นพอที่จะไม่ตัดคำชื่อ sensor ยาวๆ ออกจอ (hover ดู tooltip ชื่อเต็มได้ด้วย), "Training data" อยู่ท้ายแถวเสมอและกว้างเท่ากันทั้ง 3 ชนิด, ฟิลด์เฉพาะชนิด (เช่น Clustering ที่มีถึง 5 ฟิลด์) ขึ้นบรรทัดแยกเป็นกลุ่มของตัวเองแทนที่จะอัดรวมแถวเดียวกับ Model name — ดู **BMW-117** สำหรับช่อง "Cluster ranges" ของ Clustering โดยเฉพาะ (เปลี่ยนจากช่องกรอกตัวเลขเป็นแถบเลื่อน) และ **BMW-164** สำหรับตัวเลือกแกน X ของกราฟ Fit ของ Relation model

- [ ] **BMW-165 — Clustering: จำนวน cluster ตั้งได้สูงสุด 5 — ปุ่ม "+" กดไม่ได้ที่ 5 พร้อม tooltip "At most 5 clusters"; โมเดลเก่าที่มีมากกว่า 5 เปิดได้เหมือนเดิม** 🆕
  - กาง Model settings ของโมเดล Clustering ที่เลือก criteria sensor แล้ว กด "+" ไปเรื่อย ๆ จนกดไม่ได้ แล้วชี้เมาส์ที่ปุ่ม "+" · กด "−" หนึ่งครั้งแล้วกด "+" อีกครั้ง
  - ดูแถบ "Cluster ranges" ตอนมี 5 cluster แล้วกด Save changes และ Train
  - (ถ้ามี workspace เก่าที่มีโมเดล Clustering 6–8 cluster — สร้างไว้ก่อนเวอร์ชันนี้) เปิดโมเดลนั้น ดูสถานะ จำนวน cluster กราฟ แล้วกด "+" และ "−"
  - **คาดหวัง:** จำนวน cluster ขึ้นได้ถึง **5** เท่านั้น — ที่ 5 ปุ่ม "+" จาง กดไม่ได้ tooltip **"At most 5 clusters"**; "−" ยังกดได้ และลดแล้ว "+" กลับมากดได้ · 5 cluster: แถบ Cluster ranges แบ่ง 5 ช่วง Save / Train ได้ตามปกติ · **โมเดลเก่าที่มีมากกว่า 5 cluster:** เปิดแล้ว**จำนวนเท่าเดิม** (เช่น 6) สถานะเดิม (Complete ยัง Complete, ไม่ขึ้น "Re-train needed", ไม่มีปุ่ม Save changes โผล่เอง) กราฟ/วงครบตามจำนวนเดิม — ปุ่ม "+" กดไม่ได้ (tooltip เดียวกัน) กดแล้วจำนวนไม่เปลี่ยน · กด "−" ลดเป็น 5 ได้ (ถือเป็นการแก้ค่า: มี Save changes และโมเดลจะเป็น Incomplete ตามกติกาเดิม) และหลังจากนั้นขึ้นเกิน 5 ไม่ได้อีก · N ของหน้า Health score (วงนอก × SD, ปุ่ม 4×–7×) **ไม่เกี่ยว** ยังตั้งได้เหมือนเดิม

- [ ] **BMW-129 — หัวหน้าต่างเขียน "Build Model" เฉย ๆ ไม่มีแถบขั้นตอน และไม่มีคำว่า "Step 1" ที่ใดในหน้าต่าง (แทน BMW-114)** 🆕
  - เปิด Build Model กับ workspace ที่ตั้ง Running condition แล้ว และอีกอันที่ยังไม่ตั้ง — ดูแถบบนสุด แถบ Running condition พื้นที่กราฟ และข้อความใต้ปุ่ม Train
  - ลากหน้าต่างจากแถบบนสุด
  - **คาดหวัง:** แถบบนมีแค่ "Build Model" ทางซ้ายและปุ่ม X ทางขวา (ไม่มี "— Overview", ไม่มีวงกลมขั้นตอน) · **ไม่มีข้อความ "Step 1" ที่ใดเลย** ทั้งบนการ์ด Running condition, ในพื้นที่กราฟที่ถูกล็อก, ใต้ปุ่ม "▶ Train sensor" / "▶ Train all" (เขียน "Set the running condition first.") · ลากหน้าต่างจากแถบบนได้ตามปกติ

- [ ] **BMW-178 — แก้ค่าที่กระทบการ Train: แถบเตือน "Settings or running condition changed" (ไม่มีปุ่มของตัวเอง — มีลิงก์ "Train sensor ↑"), กราฟ "Out of date", ข้อความ "changing it sets the model to Incomplete" (แทน BMW-59)** 🆕
  - เปิดโมเดล Relation model ที่ Train แล้ว (หรือ Complete แล้ว) กาง Model settings — ดูข้างหัวข้อ Training data / Predictor sensors / Stiffness
  - เปลี่ยน Stiffness (ยังไม่กด Save) — ดูทั้งหน้าทันที
  - กดลิงก์ "Train sensor ↑" ในแถบสีเหลือง (ดูว่าโฟกัสย้ายไปที่ปุ่ม "▶ Train sensor" ที่หัว detail pane) แล้วกดปุ่มนั้น รอจนเสร็จ
  - ทำซ้ำกับ Individual (Training data → Custom) และ Clustering (Y sensor / criteria / จำนวน cluster)
  - **คาดหวัง:** **ข้างช่องใน Model settings ไม่มีข้อความสีเหลือง "changing it sets the model to Incomplete" แล้ว** (เอาออก 2026-10-12 — อ่านแล้วเหมือนกรอกผิด) ทั้งโมเดลที่ยังไม่ train และโมเดลที่ Complete · พอแก้ค่า**ทันที** (ไม่ต้อง Save) ขึ้นแถบสีเหลืองใต้ Model settings "Settings or running condition changed — this model is Incomplete again. Train it again with Train sensor ↑ to update the charts. Your set points are kept." — **แถบนี้ไม่มีปุ่มของตัวเองแล้ว (ไม่มีปุ่ม Re-train)** มีแค่ลิงก์ข้อความ "Train sensor ↑" ซึ่งไม่ได้ train เอง แค่ย้ายโฟกัสไปที่ปุ่ม Train sensor (ที่เป็นปุ่มทึบปุ่มเดียวตอนนี้) · ระหว่างที่โมเดลนี้กำลัง train แถบเขียน "Training it again now…" (รอคิวอยู่ = "It is queued in the training run.") แทนลิงก์ · กราฟทุกใบในหน้ามีฟิล์มมืด "Out of date — Re-train to see the chart for the new settings" ทับ (กราฟเก่ายังอยู่ข้างหลัง) · ป้ายสถานะที่ footer เป็น Incomplete, ปุ่มสวิตช์ "Health score" และ "Next" กดไม่ได้ ("Re-train first") · Train เสร็จ แถบและฟิล์มหายพร้อมกราฟใหม่ · โมเดลที่เคย Complete ที่เปลี่ยนค่าแล้ว Save จะกลับเป็น Incomplete **ทันที** (ไม่ต้องรอ) — เปลี่ยนแค่ชื่อโมเดลไม่กระทบ · ค่า set point ที่เคยกรอกไม่หาย

- [ ] **BMW-132 — สถานะเป็น "จุดสี" ทั้งในลิสต์ซ้ายและบนแท็บ (คำอธิบายอยู่ใน tooltip) — ไม่มีป้ายข้อความบนแท็บ; โมเดลที่ Train ไม่ผ่านเป็นจุดแดงทั้งสองที่ (แทน BMW-60)** 🆕
  - ดูโมเดลที่ยังไม่เคย Train, ที่ Train แล้วแต่ยังไม่ Complete, ที่ Complete, ที่ต้อง Train ใหม่ (แก้ค่าหลัง Train), ที่ติด gate (ยังไม่ตั้ง Running condition / ยังไม่เลือก Category), และโมเดล Complete เก่าที่ไม่มีเงื่อนไข
  - ทำให้ Train ไม่ผ่านหนึ่งตัว (เช่น Relation model บนเครื่องที่ sidecar ใช้ไม่ได้ หรือข้อมูลถูกโหลดใหม่ระหว่างเปิดหน้าต่าง) แล้วดูแท็บ ลิสต์ซ้าย พื้นที่กราฟ และ footer
  - เอาเมาส์ชี้จุดบนแท็บ และชี้ป้าย I/R/C ในลิสต์ซ้าย · ดูแถบ legend ใต้ลิสต์
  - **คาดหวัง:** ยังไม่เคย Train = วงว่างบนแท็บ (ลิสต์ไม่มีจุด) tooltip "Not trained yet" · **เหลือง** = ต้องกรอก/Train ใหม่ ("Trained", "Set points needed", "Re-train needed") · **แดง** = ต้องแก้ ("Needs condition" / "Needs category" / "Needs train period" / "Fix periods" / "Fix set point") · **เขียว** = "Complete" (โมเดล Complete เก่าที่ไม่มีเงื่อนไข: เขียว tooltip "Legacy · all data") · **Train ไม่ผ่านในรอบนี้ = จุดแดงทั้งบนแท็บและในลิสต์ซ้าย** tooltip "Training failed" · tooltip ของแท็บ = "ชื่อชนิด · คำสถานะ" · สีของจุดบนแท็บตรงกับจุดในลิสต์เสมอ · **บนแท็บไม่มีป้ายข้อความ** — คำสถานะเต็มอยู่ที่ footer ที่เดียว · ใต้ลิสต์มี legend "Needs input / re-train · Fix · Complete" · จุดนี้ตรงกับแท็บ Failure Groups ของ Dashboard ในแง่สถานะจริง

- [ ] **BMW-61 — ซ่อน/แสดงลิสต์ซ้ายด้วยไอคอน ⇤/⇥ ที่หัว detail pane — detail pane ต้องขยายเต็มความกว้าง (แทน BMW-38 — แก้บั๊กที่ pane ถูกบีบจนมองไม่เห็น)** 🆕
  - กดไอคอน ⇤ มุมซ้ายบนของ detail pane
  - สลับแท็บ I/R/C และสลับหน้า Model fit / Health score (ปุ่มที่ footer) ขณะที่ลิสต์ซ้ายซ่อนอยู่
  - กดไอคอน ⇥ เพื่อแสดงกลับ
  - **คาดหวัง:** ลิสต์ซ้ายหายไปทั้งแถบ และ **detail pane ขยายเต็มความกว้างอ่านได้ปกติ** (ไม่หดเป็นแถบแคบ/หายไป) — กราฟกว้างขึ้นตาม — ลิสต์ยังซ่อนอยู่ตอนสลับโมเดล/หน้า — กดอีกครั้งกลับมาเหมือนเดิม โดย sensor ที่เลือกอยู่ไม่เปลี่ยน

- [ ] **BMW-153 — พื้นที่กราฟตอนยังไม่มีกราฟ: กล่องข้อความแบบเดียวกันทุกสถานะ (หัว + ประโยคเดียว + บรรทัด mono) และทางไปแก้เป็น "ลิงก์ข้อความ"; Train แล้วเห็นกราฟจริง / เปิดซ้ำยังเห็นทันที (แทน BMW-136)** 🆕
  - เลือกโมเดลที่ตั้งค่าครบ (ยังไม่เคย Train) — ดูพื้นที่กราฟ แล้วกดลิงก์ "Train sensor ↑" ในนั้น
  - กด "▶ Train sensor" (หรือ ▾ → แถวของชนิดนั้น) — ระหว่างรอดูพื้นที่กราฟ แล้วดูกราฟที่ขึ้นมา (รายละเอียดแต่ละชนิดดู BMW-145 / 147 / 148)
  - สลับ sensor ไปมา แล้วกลับมาที่โมเดลเดิม · ปิดหน้าต่าง Build Model (หรือโปรแกรม) เปิดใหม่ เลือกโมเดลเดิมอีกครั้ง — ทำทั้งกับโมเดลที่ Trained และที่ **Complete** — ดูข้อความระหว่างรอ
  - (Relation model) Train แล้วกลับไปหน้า Import → เปิดโปรเจกต์เดิมใหม่ (โหลดข้อมูลใหม่) แล้วเปิดโมเดล Relation model เดิม
  - ตั้งค่าโมเดลให้ไม่ครบ (เช่น ลบ predictor จนเหลือ 0) · workspace ที่ยังไม่ตั้ง Running condition · ทำให้ Train ไม่ผ่าน
  - สลับ "Training data" เป็น Custom โดยไม่ใส่เงื่อนไข ดูลิสต์ "N items to fix" แล้วกดลิงก์เหตุผลนั้น — ต้องพาไปเปิด Model settings ของโมเดลนี้เอง (ไม่ใช่ popup Running condition ของ workspace)
  - **คาดหวัง:** ทุกสถานะที่ไม่มีกราฟเป็นกล่องเส้นประ**หน้าตาเดียวกัน**: หัวข้อ + ประโยคเดียว + (บางสถานะ) บรรทัด mono — **ในกล่องไม่มีปุ่ม** มีแต่ลิงก์ข้อความไปยังที่เดียวที่ใช้แก้ · ยังไม่ Train: "Not trained yet" / "Train it with Train sensor ↑ — the charts of the trained model appear here." / "Individual · uses the workspace running condition · ≈ 1 s" (Custom เขียน "its own running condition (Custom)") — กด "Train sensor ↑" แล้วโฟกัสไปที่ปุ่มบนหัว · **กำลัง train ใน run: "Training the Individual model · about 1 s"** (Relation model: "Training the Relation model · about 15 s") พร้อมวงหมุน · **เปิดโมเดลที่ Train แล้วซ้ำ (คำนวณใหม่เงียบ ๆ): "Loading the Individual model…"** — ไม่มีคำว่า Training และไม่มีเวลาโดยประมาณ · Train ไม่ผ่าน: กล่องขอบแดง "Training failed" / "Fix the problem, then train again with Train sensor ↑. The model keeps its last state." / ข้อความ error เป็น mono · ยังไม่ตั้ง Running condition: "Set the running condition first" + "… — open Running condition ↑" (ลิงก์เปิด popup; ช่วงผิด = "Fix the running condition first") — **ไม่มีคำว่า "Step 1" และไม่มีปุ่ม "Fix period" ในกล่องนี้** · ตั้งค่าไม่ครบ: "N items to fix before training" + ลิงก์ทีละบรรทัดที่กดแล้วพาไปแก้ · โมเดล Complete เก่าที่ไม่เคยมีบันทึกการ Train: "Marked complete" / "To see its charts, train it from the Train sensor ▾ menu (“Individual only”). It then needs Mark complete again." — **ลิงก์ "Train sensor ▾" เปิดเมนูข้างปุ่ม Train sensor** (ปุ่ม Train sensor เองกดไม่ได้ในสถานะนี้ จึงไม่ชี้ไปที่มัน) และแถว "Individual only" ในเมนูกดได้ · โมเดล Complete ที่ตั้งค่าไม่ครบจน Train ไม่ได้: "Marked complete" / "It has no charts to show, and it can't be trained yet." + เหตุผลเป็น mono — ไม่มีลิงก์ · ค่าเปลี่ยนและยังไม่มีกราฟรอบนี้: "Out of date" / "Settings or running condition changed — train it again with Train sensor ↑ to see the charts." · โหลดกราฟของโมเดลที่ Train แล้วไม่สำเร็จ: "Couldn't load the charts" / "The trained model is kept — Try again." (ลิงก์ Try again ขอกราฟใหม่) + เหตุผลเป็น mono · กราฟ/ตัวเลขแสดงเฉพาะผลที่ตรงกับค่าปัจจุบัน · Train **ไม่เขียนไฟล์ใด ๆ** · **เปิดซ้ำยังเห็นกราฟทันที** ตราบใดที่ไม่ได้แก้ค่าหลัง Train ล่าสุด รวมโมเดลที่ Mark complete แล้ว · **Relation model ที่เปิดหลังโหลดข้อมูลใหม่:** ระบบ fit ใหม่เบื้องหลังให้เอง **หนึ่งครั้ง** (ถ้ามี run อยู่ จะรอจน run จบ) — ถ้าหายซ้ำอีกจึงขึ้นกล่อง **"Fit no longer in memory"** — ข้อความ ลิงก์ และทางกลับดู **BMW-166** · วงหมุนทุกตัวหยุดหมุนเมื่อเครื่องตั้ง "ลดการเคลื่อนไหว" (prefers-reduced-motion)

- [ ] **BMW-145 — หน้า Model fit ของ Individual: กราฟค่าตามเวลา — ชื่อเส้น ±1SD/±3SD อยู่ขอบขวานอกกราฟ, ระบายสีเฉพาะแถบ ±1SD, ±3SD เป็นเส้นประ, ไม่มีแถว legend + Distribution + การ์ดสถิติ (แทน BMW-63)** 🆕
  - Train โมเดล Individual (Dashboard-created) ที่ sensor มีข้อมูลหลายพันแถว แล้วดูหน้า Model fit
  - ดูกราฟบนสุด "Sensor value over time" — เส้นค่า (เทา), เส้นเขียว ±1SD, เส้นเหลือง ±3SD · ดูว่าชื่อเส้น "+1SD" "−1SD" "+3SD" "−3SD" อยู่ตรงไหน และมีพื้นระบายสีตรงไหนบ้าง · ดูหัวกราฟ และดูใต้กราฟว่ามีแถว legend หรือไม่
  - ลาก/เลื่อนล้อเมาส์ซูมกราฟ (ซูมดูได้อย่างเดียว ไม่ดึงข้อมูลใหม่)
  - ไล่อ่านตัวเลขบนแกน Y จากล่างขึ้นบน
  - ดูการ์ด "Statistics" ด้านล่างขวา (ลองกับ sensor ที่ SD เล็กมาก เช่นค่าระดับ 0.0001 ด้วย)
  - **คาดหวัง:** กราฟค่าตามเวลากว้างเต็มแถว สูง ~330px แกนเวลา/แกนค่าอ่านง่าย (ตัวเลขแกนกลม ๆ ไม่ใช่ทศนิยมยาว) · **ตัวเลขแกน Y ห่างเท่ากันทุกขั้น** (เช่น 1, 2, 3 … 9) — ไม่มีเลขแทรกชิดปลายแกน (เดิมเคยเป็น 1, 2, 4, 6, 8, 9) · **ชื่อเส้น +1SD / −1SD / +3SD / −3SD อยู่ชิดขอบขวา "นอก" พื้นที่กราฟ** ตรงระดับของเส้นนั้น ไม่ทับเส้นข้อมูล และตัวอักษรไม่ถูกขอบการ์ดตัด · **มีพื้นระบายสีที่เดียว คือแถบเขียวจางระหว่าง −1SD ถึง +1SD (ช่วงคะแนน 100)** — ระหว่าง ±1SD กับ ±3SD ไม่มีพื้นเหลืองแล้ว · ±1SD เป็นเส้นทึบสีเขียว, **±3SD เป็นเส้นประสีเหลือง** · **ใต้กราฟไม่มีแถว legend** (ไม่มี "Value / ±1SD / ±3SD") · หัวรองเขียน "<หน่วย> · running rows" (ถ้า workspace มี Scoring period เขียน "<หน่วย> · rows in the train and scoring periods") · เส้น ±1SD/±3SD ตรงกับตัวเลขในการ์ดสถิติ · การ์ด Statistics มี Rows, Mean, SD (พร้อมหน่วยของ sensor), ±1SD, ±3SD และ **"Rows outside ±3SD" เป็นค่าประมาณจากฮิสโทแกรม (ขึ้นต้นด้วย ≈)** · **ตัวเลขในการ์ดไม่เติมศูนย์ท้าย** (ทศนิยมไม่เกิน 3 ตำแหน่ง เช่น "5" ไม่ใช่ "5.00", "1,234.568") และ**ค่าที่ไม่ใช่ศูนย์ไม่แสดงเป็น 0** (SD 0.0002 เขียน "0.0002" ไม่ใช่ "0.000") · ตัวเลข Rows ตรงกับจำนวนแถวที่ใช้ train จริง (หลังกรอง Running condition) · กราฟไม่ส่งข้อมูลทั้งหมดมา (ลื่นแม้ข้อมูลเป็นล้านแถว)

- [ ] **BMW-146 — Distribution: ฮิสโทแกรม + เส้นโค้งปกติ + เส้น ±1SD/±3SD — แกนทั้งสองเริ่ม/จบที่เลขกลม, legend เหลือแค่ Rows / Normal curve (แทน BMW-64)** 🆕
  - ที่หน้า Model fit ของโมเดล Individual ดูการ์ด "Distribution" (ข้างการ์ดสถิติ)
  - เทียบตำแหน่งเส้นแนวตั้งเขียว (±1SD) และเหลือง (±3SD) กับกราฟค่าตามเวลาด้านบน และกับการ์ดสถิติ
  - ดูตัวเลขซ้ายสุด/ขวาสุดของแกน X และตัวเลขบนสุดของแกน Y · ดูแถว legend ใต้กราฟ
  - ลองกับ sensor ที่ค่าแทบไม่เปลี่ยน (ค่าเกือบคงที่) และกับ sensor ที่ข้อมูลเบ้
  - **คาดหวัง:** แท่ง = จำนวนแถวต่อช่วง, เส้นขาวโค้ง = การแจกแจงปกติจาก mean และ SD ซึ่งซ้อนทับบนแท่งด้วยสเกลเดียวกัน · เส้น ±1SD/±3SD อยู่ที่ค่าเดียวกับเส้นในกราฟค่าตามเวลาและการ์ดสถิติ มีชื่อกำกับที่ปลายบนของเส้น · **แกน X เริ่มและจบที่เลขกลม ๆ** (เช่น 36 … 42) ไม่ใช่ขอบช่วงดิบอย่าง 36.1987 และ**ตัวเลขบนแกนห่างเท่ากันทุกขั้น** (เช่น 0, 2, 4 … 16 — ไม่ใช่ 0, 3, 6, 9, 12, 15, 16 ที่มีเลขแทรกชิดปลายแกน) ทั้งแกน X และ Y และ**กว้างพอให้เห็นเส้น ±3SD ทั้งสองข้างเสมอ** แม้เส้นจะอยู่นอกแท่งสุดท้าย · แกน Y จบที่เลขกลม (เช่น 1,200) · **legend ใต้กราฟมีแค่ "Rows" และ "Normal curve"** (ไม่มี ±1SD / ±3SD — ชื่ออยู่ที่เส้นแล้ว) · หัวรองเขียน "<หน่วย> · rows per value" · ข้อมูลเบ้ = เห็นเส้นโค้งไม่ตรงกับแท่ง (เป็นเรื่องปกติ) · ถ้าไม่มีข้อมูลสำหรับฮิสโทแกรมขึ้นข้อความ "No distribution for this scope" แทนกราฟ

- [ ] **BMW-118 — ตัวเลขบนแกนของกราฟใน Workbench ไม่มีทศนิยมยาวเพี้ยน (เช่น "1,713.8000000000002" บนแกน Y ของ Distribution — แก้ 2026-10-09)** 👀
  - หน้า Model fit ของ Individual: ดูตัวเลขบนสุดของแกน Y ในการ์ด "Distribution" และตัวเลขแกน X — ลองกับ sensor หลายตัว (ค่าน้อยๆ ทศนิยม และค่าหลักพัน)
  - ดูแกนของกราฟอื่นใน Workbench ด้วย: Sensor value over time, Fit / Target vs predicted / Residual ของ Relation model, กราฟ cluster ของ Clustering, และกราฟในหน้า Health score (รวมกราฟ cluster ที่มีวง 1×/3×/N×)
  - หน้า Health score (ทั้ง Individual / Relation model / Clustering): ดูตัวเลขบนแกน Y ของกราฟ "Score" (คะแนน 0–100)
  - **คาดหวัง:** ตัวเลขบนแกนค่าทุกแกนอ่านง่าย มีจุลภาคหลักพัน ทศนิยมไม่เกิน 3 ตำแหน่ง (ค่าที่เล็กมากยังไม่กลายเป็น 0) · **แกน Score เป็นเลขจำนวนเต็ม 0, 20, 40, 60, 80, 100 เท่านั้น** (ไม่ใช่ "0.000" / "20.00") ส่วนแกนค่า sensor / residual ยังมีทศนิยมตามเดิม · ค่าบนสุดของแกน Y ใน Distribution เป็นเลขกลมๆ (เช่น 1,800) ไม่ใช่ค่าสูงสุด × 1.1 · แกนเวลายังแสดงวันที่/เวลาตามเดิม · แกน X ของ Distribution เริ่ม/จบที่เลขกลมด้วย (ดู BMW-146) · **เอาเมาส์ชี้กราฟ "Health score": กล่อง tooltip แสดงคะแนนเป็นเลขจำนวนเต็ม (85 ไม่ใช่ 85.00)**

- [ ] **BMW-164 — หน้า Model fit ของ Relation model: แถบสถิติ + Fit (เลือกแกน X ได้) + Target vs predicted (แถวสีกำกับ "Actual" / "Predicted" ใต้กราฟ — ไม่เขียนชื่อที่ปลายเส้น และยังถูกต้องหลังซูม) + Residual over time (ไม่มี distribution ของ residual) (แทน BMW-147)** 🆕
  - Train โมเดล Relation model ที่มี predictor ≥ 2 ตัว แล้วดูหน้า Model fit
  - ดูแถบตัวเลขบนสุด: R², RMSE, 2RMSE, Residual mean, Residual SD, Rows, Predictors
  - ดูการ์ด "Fit" (scatter ของ predictor กับ target — จุดน้ำเงิน Actual, จุดแดง Relation model) แล้วเปลี่ยนค่าในช่อง "X:" ที่หัวการ์ด
  - ดูการ์ด "Target vs predicted" — ดูปลายขวาของเส้นทั้งสอง และดูแถวใต้กราฟ · **ซูมกราฟ Target vs predicted ด้วยล้อเมาส์ แล้วลากเลื่อนไปช่วงที่เส้นสองเส้นตัดกัน/สลับบนล่าง** แล้วเทียบสีของเส้นกับแถวใต้กราฟอีกครั้ง · กดปุ่มขยายของการ์ดนี้ · ดู "Residual over time" (เต็มกว้าง ล่างสุด) — ดูชื่อเส้น ±2RMSE และพื้นระบายสี
  - ปิดเปิดโมเดล/โปรแกรมแล้วดูค่า X ที่เลือกไว้
  - **คาดหวัง:** แถบสถิติมีครบ 7 ค่า ตัวเลข R²/2RMSE ตรงกับที่ Train (ไม่ใช้คำว่า LinearGAM ที่ใดเลย — ใช้ "Relation model") · **ไม่มีกราฟ distribution ของ residual และไม่มี histogram ติดข้างกราฟ** · **Target vs predicted: ใต้กราฟมีแถวสีกำกับสองรายการ — ขีดสีฟ้า "Actual" และขีดสีแดง "Predicted" — และไม่มีชื่อเขียนที่ปลายเส้นในกราฟ** (กราฟใช้ความกว้างเต็มการ์ด ไม่เว้นช่องขวาไว้ให้ชื่อ) · **หลังซูม/ลากไปช่วงไหนก็ตาม แถวสีกำกับยังถูก: เส้นฟ้าคือ Actual เส้นแดงคือ Predicted เสมอ — ไม่มีชื่อค้างอยู่ข้างเส้นผิดเส้น** · หน้าต่างขยายของการ์ดนี้ก็มีแถวสีกำกับเดียวกัน · **ตัวเลขในแถบสถิติไม่เติมศูนย์ท้าย** (เช่น Residual SD "0.4" ไม่ใช่ "0.400") และค่าที่ไม่ใช่ศูนย์ไม่แสดงเป็น 0 (Residual mean 0.0002 เขียน "0.0002") · Residual over time: ชื่อ "+2RMSE" / "−2RMSE" อยู่ขอบขวานอกกราฟ, พื้นเขียวจางเฉพาะระหว่าง ±2RMSE, มีเส้นศูนย์, ไม่มีเส้น set point (อยู่หน้า Health score) และ**ไม่มีแถว legend** · การ์ด Fit ยังมี legend "Actual / Relation model" (เป็นสีของจุด) และ**ไม่มีเส้นพาดกลางกราฟที่ค่า 0** เมื่อข้อมูลคร่อมศูนย์ · เปลี่ยน X แล้วกราฟ Fit เปลี่ยนแกนทันที **โดยไม่ต้องกด Save** และไม่ทำให้โมเดลกลายเป็น stale/Incomplete (เป็นมุมมองกราฟ ไม่ใช่พารามิเตอร์โมเดล) · ตัวเลือก X มีแค่ predictor ที่ใช้ fit จริงตอน Train ล่าสุด · ปิดเปิดแล้วค่า X ที่เลือกยังจำอยู่ · ถ้า predictor ที่เคยเลือกถูกเอาออกแล้ว Train ใหม่ ช่อง X เด้งกลับเป็น predictor ตัวแรก · **กราฟเวลาทั้งสอง ("Target vs predicted", "Residual over time") มีเส้นเฉพาะแถวดิบของช่วง Train — ไม่ลากต่อเข้าไปในช่วง Scoring (BMW-216)**

- [ ] **BMW-101 — ค่าเงื่อนไข Running condition ที่เป็นทศนิยมเล็ก ๆ แสดงครบตามที่พิมพ์ + Esc ในช่องค้นหา sensor ปิดแค่ตัวเลือก** 🆕
  - ในหน้าต่าง Running condition ตั้งเงื่อนไข `> 0.0005` และอีกแถว between `0.0001` – `0.0004` แล้ว Apply
  - กด Details ที่บรรทัด Running condition แล้วดูชิปเงื่อนไข
  - เปิดหน้าต่าง Running condition อีกครั้ง กดช่อง sensor ของแถว (เคอร์เซอร์อยู่ในช่องค้นหา) แล้วกด Esc
  - **คาดหวัง:** ชิปเขียน `> 0.0005` และ `between 0.0001–0.0004` (ไม่ถูกปัดเป็น 0; ค่าหลักพันยังมีจุลภาค เช่น `4,000`) · Esc ครั้งแรกปิด**แค่ตัวเลือก sensor** หน้าต่าง Running condition ยังเปิดอยู่ ไม่ขึ้นคำถาม Discard

- [ ] **BMW-100 — ช่อง "X:" ของกราฟ Fit เป็นตัวเลือกแบบ popover ขนาดเล็ก; predictor ตัวเดียว = กดไม่ได้แต่ยังเห็นค่า** 🆕
  - Train โมเดล Relation model ที่มี predictor 2 ตัว แล้วกดช่อง "X:" ที่หัวการ์ด Fit
  - ดูบรรทัด "Predictors of this model · 2" แล้วเลือกอีกตัว
  - Train โมเดลที่มี predictor ตัวเดียว แล้วเอาเมาส์ชี้ช่อง X
  - **คาดหวัง:** popover เปิดชิดขวาของช่อง มีแค่ predictor ของโมเดลนี้ เลือกแล้วกราฟเปลี่ยนแกนทันที ไม่ทำให้โมเดล stale · ชื่อรองของการ์ด Fit เป็น "predictor vs <description tag>" สีจาง · predictor ตัวเดียว: ช่องจางกดไม่ได้ แต่ยังเขียนชื่อ predictor และชี้แล้วขึ้นเหตุผล "Only one predictor — nothing else to plot on X"

- [ ] **BMW-221 — "Compare predictors" เปิดมุมมองเปรียบเทียบ predictor เป็น modal — ไม่มีคำว่า "Sub-models" บนจอ (แทน BMW-66)** 🆕
  - ที่โมเดล Relation model ที่ Train แล้ว กดปุ่ม "Compare predictors" ที่หัวการ์ด Fit
  - รอจนเห็นการ์ดครบ แล้วดูตัวเลขของแต่ละการ์ด
  - กด Esc / กดพื้นหลังมืด / กดปุ่ม X เพื่อปิด แล้วเปิดใหม่อีกครั้ง
  - เปิด modal ค้างไว้แล้วสลับไปโมเดลอื่น · แก้รายการ predictor แล้วเปิด modal ใหม่
  - **คาดหวัง:** เปิดเป็น modal กลางจอ (ไม่ใช่หน้าเต็ม) มีหัว **"Compare predictors"** (ไม่มีคำว่า "Sub-models" ที่ใดในหน้าต่างนี้) บรรทัดรองบอกว่าเป็นการ fit โดยเพิ่ม predictor ทีละตัว และขั้นสุดท้ายคือโมเดลที่ train ไว้ · ขึ้น "Fitting step N of M…" ระหว่างรอ แล้วเห็นการ์ดหนึ่งใบต่อ predictor สะสม (Step 1 of M ... M of M) แต่ละใบมี R², RMSE, 2·RMSE, N และ scatter (แกน X เป็น predictor ตัวแรกเสมอเพื่อเทียบกันได้) · ใบสุดท้ายตรงกับโมเดลเต็ม · ปิดได้ด้วยทั้ง 3 วิธี · การเปิดซ้ำไม่ fit ใหม่ถ้าไม่มีอะไรเปลี่ยน · ถ้าแก้ predictor ภายหลังเห็นแถบ "Predictor selection changed since last fit … Refresh" · สลับโมเดลแล้ว modal ปิดเอง · เป็นแค่พรีวิว ไม่บันทึกอะไร · ไม่แตะผลที่ใช้คิด Health score

- [ ] **BMW-203 — หน้า Model fit ของ Clustering: scatter + วง 1×/3× SD เต็มความกว้าง (ไม่มีการ์ด "Clusters" ด้านขวา) — ชื่อวงเขียนครั้งเดียวต่อระดับ, สี cluster ไม่ใช้เขียว/เหลือง/แดง, วงไม่ถูกตัด, ชื่อแกนเป็น description + หน่วย (แทน BMW-148)** 🆕
  - Train โมเดล Clustering (ลองทั้งไม่มี criteria sensor / 1 cluster และมี criteria sensor + 2-3 cluster ที่พิมพ์เส้นแบ่งเป็นทศนิยม เช่น 33.6)
  - ดูกราฟ "Clusters" — สีของจุดแต่ละ cluster, วงเขียวทึบ (1× SD), วงเหลืองประ (3× SD), ป้าย "Cluster N" ที่จุดศูนย์กลาง, ชื่อวงที่ขอบขวา, ชื่อแกน X / Y, ขอบซ้าย-ขวา-บน-ล่างของกราฟ และดูใต้กราฟว่ามีแถว legend หรือไม่
  - ดูด้านขวาของกราฟ และลองทั้งหน้าต่างกว้างและแคบ
  - **cluster ที่เอียง:** ใช้คู่ sensor ที่สัมพันธ์กันทางบวก (X เพิ่ม Y เพิ่ม — วงรีเอียงขึ้นทางขวา ซึ่งเป็นรูปที่พบบ่อยที่สุด) แล้วดูชื่อวง "1× SD" / "3× SD" ที่ขอบขวา · ลองคู่ที่สัมพันธ์ทางลบ (เอียงลงทางขวา) · ซูมเข้าไปที่ปลายขวาของวง
  - ไล่อ่านตัวเลขบนแกน X และ Y · (ถ้ามี) ลองกับ sensor ที่ค่าคงที่ทั้งคู่
  - **คาดหวัง:** วงของแต่ละ cluster หมุนตามทิศของข้อมูลจริง (ไม่ใช่วงกลม/วงตั้งตรงเสมอ) · **ชื่อวงไม่พิมพ์ทับกันไม่ว่า cluster จะเอียงทางไหน: ชื่อของวงที่ปลายขวาอยู่สูงกว่าจะอยู่บนกว่า (cluster เอียงขึ้นทางขวา = "3× SD" อยู่บน "1× SD" อยู่ล่าง) ห่างกันอย่างน้อยหนึ่งบรรทัด และยังไม่ทับกันหลังซูม** · **ตัวเลขบนแกนทั้งสองห่างเท่ากันทุกขั้น** ไม่มีเลขแทรกชิดปลายแกน · ข้อมูลที่ทุกจุดมีค่าเดียวกัน: แกนยังมีช่วงรอบค่านั้น (ไม่ใช่แกนที่ค่าต่ำสุดเท่ากับค่าสูงสุด) · **ชื่อวงมีชุดเดียว: "1× SD" (เขียว) และ "3× SD" (เหลือง) เขียนที่ขอบขวาของวงที่ยื่นไปทางขวาสุดของแต่ละระดับ** — ไม่ซ้ำทุก cluster, อ่านได้ครบไม่ถูกขอบกราฟตัด และ**ใต้กราฟไม่มีแถว legend** · **สีจุดของ cluster เป็นโทนฟ้า / ม่วง / เทาอมฟ้าเท่านั้น — ไม่มีเขียว เหลือง/ส้ม หรือแดง** (สีพวกนั้นหมายถึงคะแนน 100 / 80 / 0) และเป็นสีเดียวกับแถบแบ่ง cluster ใน Model settings · ป้าย "Cluster N" เป็นสีของ cluster นั้นบนพื้นเข้ม อ่านออกแม้จุดหนาแน่น · **วงทุกวงของทุก cluster อยู่ในกรอบกราฟครบ ไม่ถูกขอบตัด** และตัวเลขปลายแกนเป็นเลขกลม · **ไม่มีเส้นแนวตั้งที่ x = 0 หรือแนวนอนที่ y = 0 พาดกลางกราฟ** (ลองกับ sensor ที่ค่าคร่อมศูนย์) · **ชื่อแกนเป็น description + หน่วย** (เช่น "GENERATOR ACTIVE POWER · MW"; sensor ที่ไม่มี description ใช้ tag) ส่วน tag อยู่ในหัวรองของการ์ด ("<description tag> vs <description tag>") · **ไม่มีการ์ด "Clusters" และไม่มีการ์ด "Train and scoring periods" ด้านขวา — กราฟ Clusters เป็นการ์ดเดียวของหน้า กว้างเต็มหน้า** · **หน้านี้ไม่มีกราฟตามเวลา** (ชื่อช่วง Train / Scoring ของ Clustering ดูที่กราฟ "Health score" — BMW-152)

- [ ] **BMW-68 — ทุกกราฟมีปุ่มขยาย (Expand): เปิดสำเนาใหญ่ของกราฟเดียวกัน** 🆕
  - ที่หน้า Model fit ของแต่ละชนิด กดไอคอนขยาย ⤢ มุมขวาบนของกราฟแต่ละใบ (ทุกใบ)
  - ในหน้าต่างขยาย ลองซูม/เลื่อน แล้วปิดด้วย Esc / กดพื้นหลัง / ปุ่ม X
  - ขยายกราฟค้างไว้ แล้วแก้ค่าที่ทำให้โมเดล stale (หรือดูตอนที่ stale อยู่แล้ว)
  - **คาดหวัง:** ทุกการ์ดกราฟมีปุ่ม (แต่การ์ดสถิติ/สรุป cluster ไม่มี) · หน้าต่างขยายเป็นกราฟเดียวกัน ข้อมูลเดียวกัน (ไม่โหลดใหม่) พร้อมหัวกราฟ (และ legend เฉพาะการ์ดที่มี คือ Distribution, Fit และ Target vs predicted) ใหญ่ขึ้นเต็มจอ — ชื่อเส้นที่ขอบขวา ชื่อช่วงในแถบเหนือกราฟ และชื่อวง ยังอ่านได้ครบไม่ถูกตัด · ปิดได้ 3 วิธี · ตอนโมเดล stale กราฟที่ขยายก็มีฟิล์ม "Out of date" ด้วย

- [ ] **BMW-227 — เปลี่ยนหน้า Model fit ↔ Health score ด้วยปุ่มที่ footer เท่านั้น (ไม่มีสวิตช์ที่หัว) (แทน BMW-137)** 🆕
  - เลือกโมเดลที่ยังไม่ Train — ดูหัว detail pane และปุ่ม "Next: Health score →" ที่ footer
  - Train โมเดลจนสำเร็จ — ระหว่างที่กราฟยังโหลดอยู่ดูปุ่ม Next · โหลดเสร็จแล้วกด "Next: Health score →" แล้วกด "← Model fit" ที่ footer
  - สลับไปแท็บโมเดลอื่นของ sensor เดียวกันแล้วกลับมา · ทำให้โมเดลนั้น Complete (ดู BMW-158) แล้วสลับหน้าอีกครั้ง
  - **คาดหวัง:** **ที่หัว detail pane ไม่มีสวิตช์ "Model fit | Health score"** (ผู้ใช้ให้เอาออก 2026-10-12 — footer มีปุ่มอยู่แล้ว) · หน้า Model fit: footer มี "Next: Health score →" ทางขวา · ยังไม่ Train = ปุ่มนี้กดไม่ได้ (tooltip "Train the model first"); โมเดล stale = กดไม่ได้ ("Re-train first"); ระหว่างที่ผลของโมเดลกำลังโหลด / กำลัง Train = กดไม่ได้ชั่วคราว; โหลดเสร็จแล้วกดได้ · หน้า Health score: footer มี "← Model fit" ทางซ้าย + ป้ายสถานะ + ประโยคเดียว + "✓ Mark complete" และ**ไม่มีปุ่ม Next** · หน้า Health score มีกราฟตั้งจุดบนซ้าย, การ์ด "Health set points" (รวม Checks) บนขวา, กราฟ "Health score" ล่างซ้าย กว้างเท่ากราฟบน, การ์ด "Share of scored hours" ล่างขวา (ดู BMW-228) · Model settings **ไม่ปรากฏ**ในหน้านี้ · **ไม่มี "✓ Mark complete" ที่ footer ของหน้า Model fit** · แต่ละโมเดลจำหน้าของตัวเอง


- [ ] **BMW-224 — วันที่ทั้งแอปเป็นรูปแบบเดียว `YYYY/MM/DD` (ตัวเลขล้วน ไม่มีชื่อเดือน) — Dashboard, Import, Workbench (แทน BMW-144)** 🆕
  - ไล่ดูวันที่ทุกจุดในหน้า Workbench: tooltip ของกราฟ, บรรทัดอ่านค่าใต้กราฟ Health score, "Lowest … on …", footer ("Trained …", "Files saved …"), ชิปช่วง Train / Scoring ในบรรทัด Running condition และใน Details, ปลายแถบช่วงเวลา, ขีดเดือนของ timeline ใน popup, ข้อความเหตุผลของช่วงที่ผิด, ป้ายแกนเวลาของกราฟ
  - ไล่ดูหน้า Dashboard: tooltip ของ Line / Scatter / Pair Plot, หัวคอลัมน์ของตารางในแท็บ Tagged points, ชิปช่วงเวลาใน Highlights, ป้ายแกนเวลา, บรรทัด "Data … → …"
  - ไล่ดูหน้า Import (การ์ด Period, Time coverage), หัว preview ของ Special sensor และการ์ดโปรเจกต์ในหน้าแรก (โปรเจกต์ที่เก่ากว่า 30 วัน)
  - สลับหน้า / สลับแท็บในหน้าต่าง Build Model แล้วดูว่าหน้าเลื่อนกลับขึ้นบน
  - **คาดหวัง:** วันที่ทุกที่เป็น `ปี/เดือน/วัน` ตัวเลขล้วนเติมศูนย์ เช่น `2026/02/09` — **ไม่มีชื่อเดือน (Jan, Feb …) ที่ใดเลย**, ไม่มี AM/PM, ไม่มี "2026-02-09" · **เวลาของแถวข้อมูล** (tooltip, บรรทัดอ่านค่า, Lowest … on …) = `2026/02/09 23:50:00` มีวินาทีเสมอ · **ขอบช่วงที่พิมพ์เอง** (ชิป Train / Scoring, ข้อความเหตุผล) = `2026/01/01 00:05 → 2026/03/31 23:59` แสดงเวลาทั้งสองด้านเสมอ ไม่มีวินาที · **เวลาที่แอปบันทึก** = `Trained 2026/02/09 23:50` · ที่แคบ (ปลายแถบช่วงเวลา, ขีดของ timeline) = `2026/02` · ป้ายแกนเวลาของทุกกราฟ = `2026/02/09` และเป็นวันที่ + เวลาเมื่อซูมในวันเดียว · วันเวลาใน Workbench ยังเป็นตัวอักษร mono · ชิปหรือบรรทัดที่ยาวขึ้นไม่ล้นกรอบ (ลองหน้าต่างกว้าง 1100–1300 px) · สลับหน้า / แท็บแล้วหน้าเลื่อนกลับขึ้นบน · **ยกเว้น:** ช่องกรอกวันที่ (แถบช่วงเวลาของ Dashboard, Highlights "By time", popup Running condition, แผง Custom) ยังแสดงตามการตั้งค่าของ Windows เช่น `01/01/2025 12:05 AM` — เป็นข้อที่รู้อยู่แล้ว

- [ ] **BMW-225 — ป้าย ±1SD / ±3SD ข้างกราฟ อยู่ติดเส้นของตัวเองเมื่อเส้นอยู่ชิดกัน** 🆕
  - เปิดโมเดล Individual ของ sensor ที่ค่าส่วนใหญ่นิ่งแต่มี spike สูงมากเป็นครั้งคราว (แกน Y กว้างกว่าแถบ ±3SD หลายเท่า เส้น ±1SD กับ ±3SD จึงห่างกันไม่กี่ pixel) ดูกราฟ "Sensor value over time" หน้า Model fit และกราฟค่า sensor หน้า Health score
  - เทียบกับ sensor ที่ข้อมูลกระจายปกติ (เส้น ±1SD กับ ±3SD ห่างกันชัดเจน)
  - **คาดหวัง:** ด้านขวาของกราฟ ชื่อ **"+1SD" (เขียว) อยู่ติดปลายเส้น +1SD สีเขียว** และ **"+3SD" (ส้ม) อยู่เหนือขึ้นไปหนึ่งบรรทัด ตรงระดับเส้นประ +3SD** · ด้านล่างกลับกัน: "−1SD" ติดใต้เส้น −1SD และ "−3SD" ถัดลงไปตรงระดับเส้นประ −3SD · **ไม่มีชื่อ "+1SD" ไปอยู่ข้างเส้นประ +3SD และไม่มีชื่อ "+3SD" ลอยอยู่เหนือที่ว่าง** · ชื่อไม่พิมพ์ทับกัน · sensor ที่เส้นห่างกันพอ ป้าย 4 อันอยู่แยกกันที่เส้นของตัวเองเหมือนเดิม

- [ ] **BMW-154 — Individual: การ์ด "Health set points" เป็นตาราง Score · Band · Lower · Upper — กรอกได้เฉพาะ L / H, หมายเหตุ master data อยู่ในการ์ด, ลิงก์ "Use master H …" เฉพาะด้านที่ต่าง (แทน BMW-70)** 🆕
  - Train โมเดล Individual ของ sensor ที่มี alarm L/H ใน mapping (master data) แล้วเปิด "Health score" **ครั้งแรก**
  - ดูการ์ด "Health set points": หัวตาราง Score · Band · Lower · Upper, แถว 100 "within ±1SD · automatic", แถว 80 "at ±3SD · automatic", แถว 0 "at L / H · you set them"
  - เปลี่ยนค่า H เป็นค่าอื่น ดูบรรทัดหมายเหตุใต้ตาราง แล้วกดลิงก์ "Use master H <ค่า master>" · ลองกับ master ที่เป็นทศนิยม (เช่น 4.5) และค่าลบ (เช่น -2)
  - เปลี่ยนทั้ง L และ H · ทำซ้ำกับ sensor ที่ master ไม่มี alarm เลย / มีแค่ด้านเดียว / special sensor ที่สร้างเอง
  - ปิดแล้วเปิดหน้านี้ซ้ำ (หรือปิดเปิดหน้าต่าง) หลังจากที่ master data ของ sensor นั้นเปลี่ยนไปแล้ว (ถ้าทำได้)
  - **คาดหวัง:** ค่าของแถว 100 และ 80 เป็น**ตัวเลขข้อความธรรมดา** (ไม่มีกรอบช่อง ไม่มีไอคอนกุญแจ พิมพ์ไม่ได้) — **ช่องกรอกมีแค่สองช่องคือ L และ H** พร้อมหน่วยของ sensor · ช่อง L/H ถูกเติมจาก master ให้เองครั้งแรก และหมายเหตุใต้ตาราง (อยู่**ในการ์ดเดียวกัน**) เขียน "L and H come from the master data alarm limits. Saved on this model only; the master data is not changed." — ไม่มีลิงก์ · พิมพ์ H ทับ → หมายเหตุเป็น "L comes from the master data · H is set on this model. …" และมีลิงก์ **"Use master H <ค่า>"** (เฉพาะด้าน H) กดแล้วค่ากลับและลิงก์หาย · เปลี่ยนทั้งสองด้าน = สองลิงก์ "Use master L … · Use master H …" · **ค่า master ในลิงก์เป็นตามที่เก็บ ไม่เติมศูนย์ ไม่ปัด: 4.5 → "Use master H 4.5" (ไม่ใช่ 4.50), -2 → "Use master L -2" (ไม่ใช่ -2.00 / -2.000)** · sensor ที่ master ไม่มีด้านนั้น = ช่องว่างขอบประเหลือง ตัวอักษรจางในช่องเป็น "L" / "H" (ไม่ใช่คำว่า "Required" — คำยาวไม่พอดีช่อง) และหมายเหตุเขียน "L is not in the master data · …" (ไม่มีลิงก์ของด้านนั้น) · ไม่มีทั้งสองด้าน/special sensor = "The master data has no alarm limits for this sensor — type L and H." · ไม่มีป้าย "master data" / "this model" / "not in master" ข้างช่องอีกแล้ว · master data ไม่ถูกเปลี่ยนจริง (ดูค่าของ sensor ที่ Dashboard/mapping เหมือนเดิม) · ค่าที่เติมตอนเปิดครั้งแรกเป็น snapshot — master เปลี่ยนทีหลังแล้วค่าของโมเดลนี้ไม่ขยับเอง · พิมพ์ "2.50" แล้วออกจากช่อง ข้อความในช่องยังเป็น "2.50" · **L / H ถูกเทียบกับค่าเฉลี่ยราย 1 ชั่วโมงของ sensor** (กราฟข้างการ์ดเป็น 1 จุดต่อชั่วโมง — BMW-149 / BMW-213) ไม่ใช่ค่าของแต่ละแถว

- [ ] **BMW-149 — Health score ของ Individual: เส้น L / H เป็นเส้นเด่นที่สุดบนกราฟ และเขียนค่าตามที่พิมพ์ ("H 4.6", "L 2.2") — ระบายสีเฉพาะแถบ ±1SD, ไม่มี legend** 🆕
  - เปิด "Health score" ของโมเดล Individual ที่ Train แล้ว ดูกราฟ "Sensor value over time" ซ้ายบน
  - พิมพ์ H เป็น `4.6` → `4.60` → `4.61234` (ใช้ค่าที่เหมาะกับ sensor จริง) · พิมพ์ L เป็นทศนิยม เช่น `2.2` · พิมพ์ค่าหลักพัน เช่น `12500.5` · ลบช่อง H ให้ว่าง
  - **L / H ที่อยู่ไกลจากข้อมูลมาก** (เช่นค่า alarm ของ master data): พิมพ์ L เป็นค่าติดลบไกล ๆ เช่น `-200` และ H ไกล ๆ เช่น `300` (ให้แถบ ±3SD เหลือสูงไม่กี่พิกเซล) แล้วดูชื่อ +1SD / +3SD / −1SD / −3SD ที่ขอบขวา และป้ายของ L
  - ดูใต้กราฟและหัวรองของการ์ด
  - **คาดหวัง:** เส้น H / L เป็น**เส้นทึบสีแดง หนากว่าเส้น ±1SD / ±3SD** · ป้ายอยู่ในกราฟที่ปลายขวา: "H <ค่า>" อยู่เหนือเส้น, "L <ค่า>" อยู่ใต้เส้น · **ค่าบนป้ายเป็นตามที่พิมพ์ — ไม่เติมศูนย์ ไม่ปัดทศนิยม:** พิมพ์ 4.6 หรือ 4.60 → "H 4.6" (ไม่ใช่ "H 4.60"; ในช่องกรอกยังเป็นข้อความที่พิมพ์), 4.61234 → "H 4.61234" (ไม่ใช่ 4.612), 12500.5 → "H 12,500.5" · **ค่าติดลบบนป้ายใช้เครื่องหมายลบจริง "−" แบบเดียวกับ "−1SD"** (เช่น "L −200" ไม่ใช่ขีดสั้น "L -200") และศูนย์ไม่เขียนเป็น "-0" · ลบช่องแล้วเส้นและป้ายของด้านนั้นหายทันที · **เมื่อ L / H อยู่ไกลจนเส้น ±1SD กับ ±3SD เกือบซ้อนกัน ชื่อไม่พิมพ์ทับกัน: ด้านบนเขียนซ้อนสองบรรทัด "+3SD" (เหลือง) เหนือ "+1SD" (เขียว) ด้านล่างเขียน "−1SD" เหนือ "−3SD" — ครบทั้งสี่ชื่อ อ่านได้ทุกชื่อ และไม่ถูกขอบการ์ดตัด** (ข้อมูลปกติ: แต่ละชื่ออยู่ที่เส้นของตัวเองเหมือนเดิม) · ชื่อ +1SD / −1SD / +3SD / −3SD อยู่ขอบขวานอกกราฟ, ±3SD เป็นเส้นประสีเหลือง, **พื้นระบายสีมีเฉพาะแถบเขียวจาง ±1SD** · เส้น L / H ที่อยู่ไกลจากข้อมูลยังอยู่ในกรอบกราฟ (แกน Y ขยายตาม) · หัวรองมีแค่หน่วยตามด้วย "· 1 h average" (เช่น "bar · 1 h average"; ไม่มี "type L and H on the right") · **เส้นค่าเป็นค่าเฉลี่ยราย 1 ชั่วโมง (1 จุดต่อชั่วโมง) ไม่ใช่ทุกแถว** จึงเรียบกว่ากราฟ "Sensor value over time" ของหน้า Model fit (BMW-213) · **ใต้กราฟไม่มีแถว legend**

- [ ] **BMW-155 — Relation model: ช่อง 80 / 0 ทั้ง Lower และ Upper เริ่มว่าง + กราฟ residual อย่างเดียว + เส้น set point เป็นเส้นทึบพร้อมค่าตามที่พิมพ์ ("80 · +5") + Checks รวมช่องว่างเป็นบรรทัดเดียว (แทน BMW-150)** 🆕
  - Train โมเดล Relation model แล้วเปิด "Health score"
  - ดูกราฟซ้ายบน และการ์ด "Health set points": หัวตาราง Score · Band · Lower · Upper, แถว 100 "within ±2RMSE · automatic", แถว 80 "residual at 80 · you set them", แถว 0 "residual at 0 · you set them" และบรรทัดหมายเหตุใต้ตาราง
  - ดู Checks (อยู่ใต้ตารางในการ์ดเดียวกัน) ตอนยังไม่กรอกอะไร แล้วกรอกทีละช่อง: Upper 80 = `5`, Lower 80 = `-2.5`, Upper 0 = `12.250`, Lower 0 = `-9.61234` — ดูเส้นและป้ายบนกราฟ และบรรทัดใน Checks
  - **คาดหวัง:** กราฟซ้ายเป็น **residual ตามเวลาเท่านั้น** (ไม่มีฮิสโทแกรม ไม่มี raw vs predicted) และ**เป็นราย 1 ชั่วโมง: 1 จุดต่อชั่วโมง = ค่าเฉลี่ยของ target ในชั่วโมงนั้น ลบด้วยค่าที่โมเดลทำนายจากค่าเฉลี่ยของ predictor ในชั่วโมงเดียวกัน** (BMW-213) มีเส้น ±2RMSE (ชื่ออยู่ขอบขวานอกกราฟ พื้นเขียวจางระหว่างสองเส้น) และเส้นศูนย์ · **แถว 100 เป็นข้อความ "−<2RMSE>" / "+<2RMSE>" (ไม่ใช่ช่องกรอก ไม่มีกุญแจ)** · ช่องกรอกมีแค่ 4 ช่อง ทั้งสี่ช่อง**ว่างตอนเริ่ม** (ไม่มีค่า default) ขอบประเหลือง ตัวอักษรจางในช่องเป็นเครื่องหมายของด้านนั้น: **"−" ฝั่ง Lower, "+" ฝั่ง Upper** (ไม่ใช่คำว่า "Required") · หมายเหตุใต้ตาราง: "Residual = actual − predicted: lower points are negative, upper points positive. 0 sits further from zero than 80." · Checks ขึ้น**บรรทัดเดียว** "Enter 4 empty points: lower 80, upper 80, lower 0, upper 0" แล้วลดลงเป็น "Enter 3 …", "Enter 2 …" ตามที่กรอก (เหลือช่องเดียวขึ้นข้อความเต็มของช่องนั้น) · พิมพ์แล้ว**เส้นทึบ** สีเหลือง (80) / สีแดง (0) **หนากว่าเส้น ±2RMSE** โผล่และขยับบนกราฟทันที (ประมาณ 0.25 วินาที) · **ป้ายของแต่ละเส้นอยู่ในกราฟที่ปลายขวา บอกคะแนนและค่าตามที่พิมพ์ พร้อมเครื่องหมาย: "80 · +5", "80 · −2.5", "0 · +12.25", "0 · −9.61234"** (ไม่เติมศูนย์ ไม่ปัดทศนิยม; ฝั่ง Upper ป้ายอยู่เหนือเส้น ฝั่ง Lower อยู่ใต้เส้น) · ค่าที่ยังไม่กรอกไม่มีเส้น · หัวรองเขียน "actual − predicted (<หน่วย>) · 1 h average" ไม่มีคำแนะนำ "type the 80 and 0 points on the right" · **ใต้กราฟไม่มีแถว legend**

- [ ] **BMW-156 — Clustering: วงนอก N× SD (ต้องมากกว่า 3) — ปุ่ม − / + และปุ่มลัด 4× 5× 6× 7× — วง N เป็นเส้นทึบสีแดง, ชื่อวง "1× · 100" / "3× · 80" / "N× · 0" ครั้งเดียวต่อระดับ (แทน BMW-151)** 🆕
  - Train โมเดล Clustering (2 cluster ขึ้นไป) แล้วเปิด "Health score"
  - ดูกราฟซ้ายบน (scatter) และการ์ด "Health set points": แถว 100 / 80 / 0 และบรรทัดควบคุม N ใต้ตาราง
  - กดปุ่มลัด 4× → 7×, กด + / − หลายครั้ง (เริ่มจากช่องว่าง), พิมพ์ `4.5` แล้ว `4.25`, พิมพ์ 3 และ 2 ลงในช่อง — ทุกครั้งดูวง ชื่อวง และขอบกราฟ
  - **cluster ที่เอียง:** ทำซ้ำกับคู่ sensor ที่สัมพันธ์กันทางบวก (วงรีเอียงขึ้นทางขวา) และทางลบ ตั้ง N = 5 แล้วดูชื่อวงทั้งสามที่ขอบขวา · ซูมเข้าไปที่ปลายขวาของวง
  - **คาดหวัง:** แถวคะแนน 100 และ 80 เป็น**ข้อความ** "inside the 1× SD ring · automatic" → "1× SD" และ "on the 3× SD ring · automatic" → "3× SD" (ไม่มีช่องกรอก ไม่มีกุญแจ) · แถว 0 "on the N× SD ring · you set N · more than 3" ท้ายแถวเขียน "N× SD" ตอนยังว่าง และ**เป็นค่าที่ตั้งตามที่พิมพ์**เมื่อมี N (5 → "5× SD", 4.25 → "4.25× SD") · ใต้ตารางมีช่อง N ช่องเดียว (ปุ่ม − / + และปุ่มลัด 4× 5× 6× 7×) ใช้กับ**ทุก cluster** พร้อมข้อความ "One N for every cluster: each cluster gets its own 1×, 3× and N× rings, sized by its own SD." · ช่องว่าง = ขอบประเหลือง ตัวอักษรจาง "N" · ปุ่มลัดตั้งค่าและบันทึกทันที ปุ่มที่ตรงกับค่าปัจจุบันถูกไฮไลต์ · "+" จากช่องว่างเริ่มที่ 4 แล้วขยับทีละ 0.5 ส่วน "−" ไม่ลงต่ำกว่า 3.5 · พิมพ์ 3 หรือต่ำกว่า = ช่องแดง และ Checks บอกว่าต้องมากกว่า 3× SD · กราฟมีวง 1× (เขียวทึบ) และ 3× (เหลืองประ) ของทุก cluster และ**วง N× เป็นเส้นทึบสีแดง หนาที่สุด** ของทุก cluster เมื่อมี N · **ชื่อวงมีแค่ระดับละหนึ่งอัน ที่ขอบขวาของวงที่ยื่นไปทางขวาสุด: "1× · 100", "3× · 80" และเมื่อมี N "<N>× · 0"** — N บนป้ายเป็นตามที่พิมพ์ (4.5 → "4.5× · 0", 4.25 → "4.25× · 0" ไม่ใช่ "4.50×") · **ชื่อวงทั้งสามไม่พิมพ์ทับกันไม่ว่า cluster จะเอียงทางไหน: cluster เอียงขึ้นทางขวา = "N× · 0" อยู่บนสุด "3× · 80" กลาง "1× · 100" ล่างสุด (เอียงลงทางขวา = กลับกัน) แต่ละชื่อห่างกันอย่างน้อยหนึ่งบรรทัด และยังไม่ทับกันหลังซูม** · **ใต้กราฟไม่มีแถว legend** · แกนกราฟขยายให้เห็นวงนอก**ครบทุกวงทุก cluster** (ไม่มีวงถูกขอบตัด) ตัวเลขปลายแกนเป็นเลขกลม ตัวเลขบนแกนห่างเท่ากันทุกขั้น และไม่มีเส้นพาดที่ x = 0 / y = 0 · ชื่อแกนเป็น description + หน่วย (tag อยู่ในหัวรอง) · หัวรองลงท้ายว่า "· 1 h averages · coloured by score once N is set" ตอนยังไม่มีคะแนน และ "· 1 h averages · coloured by score" เมื่อค่าครบ · **จุดบน scatter ของหน้านี้เป็น 1 จุดต่อชั่วโมง (ค่าเฉลี่ย x, y ของชั่วโมง)** น้อยกว่า scatter ของหน้า Model fit · จุดข้อมูลสีตาม cluster (โทนฟ้า/ม่วง — ไม่มีเขียว/เหลือง/แดง) และเปลี่ยนเป็นสีตามคะแนนเมื่อค่าครบ (ชั่วโมงที่ไม่มีคะแนนยังเป็นสีเทา — BMW-218)

- [ ] **BMW-157 — Checks อยู่ในการ์ด "Health set points" ใบเดียวกัน (ไม่มีการ์ด Checks แยก): ข้อความ validate มาจาก Rust และอ้างค่าที่พิมพ์ตามที่พิมพ์ + จุดสถานะที่หัวการ์ด + เหตุผลที่ footer (แทน BMW-138)** 🆕
  - Individual: กรอก L ให้อยู่ใน 3SD (สูงกว่าขอบล่าง 3SD), กรอก H ให้เท่ากับขอบบน 3SD พอดี, ล้างช่องหนึ่งให้ว่าง, แล้วแก้ให้ถูก — ดูมุมขวาของหัวการ์ด "Health set points" และเอาเมาส์ชี้จุดนั้น
  - Relation model: กรอก 80 ให้อยู่ใน ±2RMSE, กรอก 0 ให้เท่ากับหรือใกล้ศูนย์กว่า 80, กรอกฝั่ง Lower เป็นค่าบวก
  - Relation model: กรอก Upper 80 = `-2` (ผิดเครื่องหมาย) แล้วอ่านข้อความใน Checks · Individual: กรอก L = `4.61234` ให้อยู่ใน 3SD แล้วอ่านข้อความ
  - Clustering: กรอก N = 3 และ N = 2.5
  - Relation model ที่ยังไม่ได้กรอกสักช่อง (ว่างทั้ง 4 ช่อง): อ่านข้อความที่ footer แล้วกรอกทีละช่องดูตัวเลขลดลง
  - เปลี่ยน Training scope (Model settings → ช่วงเวลา/เงื่อนไข) แล้ว Train ใหม่ ดู Checks อีกครั้งกับค่าเดิมที่เคยผ่าน
  - **คาดหวัง:** **Checks อยู่ใต้ตาราง set point ในการ์ดเดียวกัน คั่นด้วยเส้นบาง ๆ — ไม่มีการ์ด "Checks" แยก และไม่มีหัวข้อที่สอง** · **ข้อความอ้างค่าที่พิมพ์ตามที่พิมพ์: "… must be positive (residual = actual − predicted); got -2." (ไม่ใช่ "-2.000"), "(L = 4.61234)" (ไม่ใช่ 4.612)** — ส่วนค่าที่โปรแกรมคำนวณ (ขอบ 3σ, 2RMSE) ยังปัดทศนิยมตามเดิม · แต่ละปัญหาเป็นหนึ่งบรรทัด ข้อความเป็นอังกฤษที่บอกว่าผิดอะไรและควรทำอย่างไร — ช่องว่างเป็นสีเหลือง ค่าที่ไม่ผ่านเป็นสีแดง และ**ช่องนั้นมีกรอบแดง** · **หัวการ์ด Health set points ไม่มีป้ายข้อความ** มีแค่จุดสีเดียว: เหลือง tooltip "Set points still empty" (มีแต่ช่องว่าง) / แดง "A set point is not valid" / เขียว "Set points valid" · ครบและผ่านขึ้นบรรทัดเขียว "Every set point passes the checks — the score is below." · เท่ากับขอบ (เช่น H = 3SD พอดี) **ไม่ผ่าน** พร้อมข้อความบอก · footer ขึ้นเหตุผลแรกที่ Mark complete ถูกบล็อก ("N set points still empty" / "N set point(s) not valid — fix before marking complete") และปุ่ม "✓ Mark complete" กดไม่ได้ · **N ของ "still empty" คือจำนวนช่องที่ยังว่างจริง:** Relation model ว่าง 4 ช่อง = "4 set points still empty" แล้วลดเป็น 3 / 2 และ "1 set point still empty" (เอกพจน์) เมื่อกรอกทีละช่อง · ค่าเดิมที่เคยผ่านอาจไม่ผ่านหลัง scope เปลี่ยน (σ / 2RMSE / วงรีเปลี่ยน) — ต้องถูกจับทุกครั้ง

- [ ] **BMW-228 — หน้า Health score: กราฟบน (ค่า sensor / residual) กับกราฟ Health score กว้างเท่ากัน แกนเวลาตรงกัน และซูมไปด้วยกัน; การ์ด "Share of scored hours" อยู่ด้านขวา (แทน BMW-210)** 🆕
  - ตอนยังกรอกไม่ครบ ดูกรอบล่าง แล้วกรอกให้ valid
  - ดูหัวกราฟคะแนน (ข้อความ "Lowest … on … · below 80 for …% of scored hours · 1-hour averages of the running rows") และการ์ด "Share of scored hours" ทางขวาของกราฟคะแนน (ใต้การ์ด Health set points)
  - **หา spike บนกราฟบน แล้วมองลงมาตรง ๆ ที่กราฟ Health score** · เลื่อนเมาส์ไปบนกราฟใดกราฟหนึ่ง
  - **หมุนล้อเมาส์ซูมบนกราฟบน** แล้วดูกราฟล่าง · ซูมบนกราฟล่างแล้วดูกราฟบน · ลากเลื่อนซ้ายขวา
  - **ขณะที่ซูมอยู่ แก้ค่า L หรือ H (หรือ set point อื่น) แล้วกด Enter** · ซูมออกจนสุด · ไปโมเดลอื่นแล้วกลับมา
  - Clustering: ชี้จุดบน scatter และชี้บนกราฟ Health score · กดปุ่มขยายของกราฟทั้งสองใบ
  - **คาดหวัง:** ยังไม่ valid = กรอบเส้นประ "Set the points above" (ไม่มีกราฟ ไม่มีเลขคะแนน) · valid แล้ว **กราฟ Health score อยู่ใต้กราฟบน กว้างเท่ากันพอดี ขอบซ้ายและขอบขวาของพื้นที่กราฟตรงกัน** — spike บนกราฟบนกับคะแนนที่ตกบนกราฟล่างอยู่**ตรงกันในแนวดิ่ง** ป้ายวันที่บนแกนนอนของสองกราฟอยู่ตำแหน่งเดียวกัน · การ์ด **"Share of scored hours"** (80–100 / 40–80 / 0–40 รวมได้ ~100% นับตามจำนวนชั่วโมง) เป็นการ์ดแยกทางขวาของกราฟคะแนน กว้างเท่าการ์ด Health set points · **การ์ด Health set points ยาวลงมาถึงขอบล่างของกราฟบนพอดี** (ไม่มีช่องว่างใต้การ์ด) เหมือนที่การ์ด Share of scored hours สูงเท่ากราฟคะแนน — สองแถวเป็นรูปเดียวกัน · **ซูม / เลื่อนกราฟหนึ่ง อีกกราฟแสดงช่วงเวลาเดียวกันทันที** · **แก้ set point ขณะซูมอยู่ สองกราฟยังอยู่ที่ช่วงที่ซูมไว้** (ไม่มีกราฟใดเด้งกลับไปแสดงทั้งช่วง ขณะที่อีกกราฟยังซูมอยู่) · ซูมออกสุดแล้วทั้งคู่แสดงทั้งช่วง · โมเดลอื่นเริ่มที่ทั้งช่วง · กราฟคะแนน 0–100 เส้นประที่ 80 เส้นสีเขียว (80–100) / เหลือง (40–80) / แดง (ต่ำกว่า 40) · **คะแนนเป็น 1 จุดต่อชั่วโมง** (BMW-213) ชั่วโมงที่ไม่มีคะแนนเป็น**ช่องว่างในเส้น ไม่ใช่ 0** และชั่วโมงที่เครื่องหยุดทั้งชั่วโมงไม่มีจุดเลย (BMW-214) · หัวกราฟบอกคะแนนต่ำสุดพร้อมเวลา**ต้นชั่วโมง** (เช่น "Lowest 64 on 2026/02/09 23:00:00") และ % ของ**ชั่วโมง**ที่มีคะแนนที่ต่ำกว่า 80 ("below 80 for 12.5% of scored hours") แล้วลงท้ายด้วย **"· 1-hour averages of the running rows"** — นับทุกชั่วโมงที่มีคะแนน (ช่วง Train และช่วง Scoring) · ไม่มีชั่วโมงไหนได้คะแนน = หัวกราฟเขียน "No scored hours" · เมื่อชี้เมาส์บนกราฟใดกราฟหนึ่ง **เส้นเวลา (เคอร์เซอร์) ขึ้นพร้อมกันทั้งสองกราฟที่ตำแหน่งเดียวกัน** และมีบรรทัดอ่านค่าที่หัวกราฟคะแนน: Individual **"<ต้นชั่วโมง> · 1 h avg <ค่า> <หน่วย> · score NN"**, Relation model "<ต้นชั่วโมง> · residual <ค่า> <หน่วย> · score NN", Clustering "<ต้นชั่วโมง> · score NN" (จุดที่ชี้ถูกไฮไลต์ที่ scatter) — เวลาเป็นต้นชั่วโมงเสมอ (BMW-212) · จุดที่ไม่มีคะแนนอ่านว่า **"<ต้นชั่วโมง> · no score"** · ย้ายเมาส์ออกแล้วบรรทัดอ่านค่าหาย · ทุกกราฟขยายได้ (Esc ปิด; กราฟที่ขยายเป็นกราฟอย่างเดียว ไม่มีการ์ดสัดส่วน และซูมในนั้นไม่กระทบกราฟข้างหลัง) · กรอกตัวเลขแล้วเส้น/คะแนน/Checks ขยับภายในประมาณ 0.25 วินาที โดยไม่กระตุก · **ใต้กราฟ Health score ไม่มีแถว legend และไม่มีประโยค "Hover to read the score…"** · ชื่อ "80" ของเส้นประอยู่ขอบขวานอกกราฟ · tooltip ตอนชี้แสดงคะแนนเป็นเลขจำนวนเต็ม · สัดส่วนที่ไม่ใช่ศูนย์แต่น้อยกว่า 0.1% เขียน "< 0.1%" (ไม่ใช่ "0.0%") **ทั้งในการ์ด "Share of scored hours" และในหัวกราฟ** · ค่าในบรรทัดอ่านค่าตอนชี้ไม่เติมศูนย์ท้าย ("1 h avg 6.2 bar" ไม่ใช่ "6.20") · ไม่มีคำว่า "scored rows" ที่ใดในหน้านี้ · หน้าต่างแคบ (ต่ำกว่า ~760 px): การ์ดเรียงเป็นคอลัมน์เดียว กราฟสองใบยังกว้างเท่ากัน

- [ ] **BMW-213 — ข้อมูลที่ถี่กว่า 1 ชั่วโมง (เช่นทุก 5 นาที): หน้า Health score มี 1 จุดต่อชั่วโมง = ค่าเฉลี่ยของชั่วโมงนั้น ทั้ง 3 ชนิดโมเดล** 🆕
  - ใช้ชุดข้อมูลที่บันทึกทุก 5 นาที (หรือถี่กว่า 1 ชั่วโมง) Train โมเดล Individual, Relation model และ Clustering แล้วเปิดหน้า Health score ของแต่ละโมเดล ตั้ง set point ให้ valid
  - ซูมกราฟ set point และกราฟ Health score เข้าไปให้เห็นช่วง 3–4 ชั่วโมง แล้วชี้เมาส์ไล่ทีละจุด
  - Individual: เทียบค่าของจุดหนึ่ง (เช่นจุด 10:00) กับค่าเฉลี่ยของแถว 10:00–10:55 ที่คำนวณเองจากไฟล์ CSV (เช่นใน Excel)
  - Individual: ตั้ง L / H ให้แคบจนค่าแกว่งสั้น ๆ ไม่กี่แถวเกินเส้น ±3SD แต่ค่าเฉลี่ยของชั่วโมงยังอยู่ใน ±1SD
  - **คาดหวัง:** ทั้งกราฟ set point และกราฟคะแนนมี**จุดห่างกัน 1 ชั่วโมง ที่ต้นชั่วโมง** (10:00, 11:00, …) — สองกราฟมีจุดชุดเดียวกัน เส้นประตอนชี้ตรงกัน · ค่าของจุด = ค่าเฉลี่ยของแถวในชั่วโมงนั้น ตรงกับที่คำนวณเอง · Relation model: residual ของจุด = ค่าเฉลี่ยของ target ลบด้วยค่าที่โมเดลทำนายจาก**ค่าเฉลี่ยของ predictor** ในชั่วโมงเดียวกัน · Clustering: scatter ของหน้านี้มี 1 จุดต่อชั่วโมง (น้อยกว่า scatter ของหน้า Model fit มาก) · หัวรองของกราฟ set point ลงท้าย "· 1 h average" (Clustering: "· 1 h averages · coloured by score") · คะแนนคิดจากค่าเฉลี่ยของชั่วโมง: **อาการที่สั้นกว่า 1 ชั่วโมงถูกเฉลี่ยจนเบาลง** — ชั่วโมงที่บางแถวแกว่งเกินเส้นแต่ค่าเฉลี่ยยังอยู่กลางได้คะแนน 100 · เส้นเรียบกว่าและคะแนนโดยรวมสูงกว่าก่อนอัปเดต (ตั้งใจ — ตามที่ตกลงไว้) · หัวกราฟและการ์ดสัดส่วนนับเป็น "hours" (BMW-228)

- [ ] **BMW-214 — ชั่วโมงที่เครื่องเดินไม่ครบชั่วโมง = เฉลี่ยเฉพาะแถวที่เดิน; ชั่วโมงที่เครื่องหยุดทั้งชั่วโมง = ไม่มีจุด ไม่มีคะแนน (ไม่ใช่ 0)** 🆕
  - ใช้ข้อมูลที่มีช่วงเครื่องหยุด (Running condition ตัดแถวออก) ทั้งแบบหยุด/เริ่มเดินกลางชั่วโมง และหยุดยาวหลายชั่วโมง เปิดหน้า Health score ของโมเดล Individual ที่ set point valid
  - ซูมไปที่ช่วงที่เครื่องหยุด ชี้เมาส์จุดก่อนและหลังช่วงหยุด และชี้ตรงกลางช่วงที่หยุด
  - เทียบค่าของจุดในชั่วโมงที่เดินไม่ครบกับค่าเฉลี่ยของ**เฉพาะแถวที่เครื่องเดิน**ในชั่วโมงนั้น (คำนวณเองจาก CSV)
  - **คาดหวัง:** ชั่วโมงที่เครื่องหยุดทั้งชั่วโมง**ไม่มีจุด** — ไม่มีจุดที่ค่า 0 และไม่มีคะแนน 0; ชี้เมาส์ตรงนั้นบรรทัดอ่านค่าไปอ่านจุดที่ใกล้ที่สุด และไม่เคยอ่านเวลาของชั่วโมงที่หยุด · ชั่วโมงที่เดินไม่ครบ**ยังมีจุด** ค่า = ค่าเฉลี่ยของแถวที่เดินเท่านั้น (ค่าที่อ่านได้ตอนเครื่องหยุดไม่ถูกนำมาเฉลี่ย) · ชั่วโมงที่มีแถวเดินเพียงแถวเดียวก็มีจุด และได้คะแนนจากแถวนั้น (ไม่มีเกณฑ์ขั้นต่ำ) · จำนวนชั่วโมงในหัวกราฟ / การ์ดสัดส่วน ไม่นับชั่วโมงที่หยุด

- [ ] **BMW-215 — ข้อมูลที่เป็นราย 1 ชั่วโมงอยู่แล้ว (หรือห่างกว่า): จุดและคะแนนเท่ากับก่อนอัปเดต** 🆕
  - ใช้ชุดข้อมูลรายชั่วโมง (และถ้ามี ราย 2 ชั่วโมง) Train โมเดล Individual แล้วเปิดหน้า Health score ตั้ง set point ให้ valid
  - เทียบจุดบนกราฟ set point กับกราฟ "Sensor value over time" ของหน้า Model fit
  - **คาดหวัง:** หน้า Health score มีจำนวนจุดและค่าเท่ากับหน้า Model fit (1 แถว = 1 จุด) คะแนนเป็นของแถวนั้นเอง · เวลาที่อ่านได้เป็นต้นชั่วโมงของแถว (แถว 10:00 → "10:00"; ไฟล์ที่บันทึกที่นาที :30 → จุดอ่านว่า "10:00") · ข้อมูลราย 2 ชั่วโมง: 1 จุดต่อแถว ไม่มีจุดเปล่าแทรกในชั่วโมงที่ไม่มีแถว · ตัวเลข "% below 80" นับเป็นชั่วโมง ซึ่งเท่ากับจำนวนแถว

- [ ] **BMW-216 — หน้า Model fit ยังใช้ข้อมูลดิบทุกแถว (ไม่เฉลี่ยรายชั่วโมง) และตัวเลขของโมเดลไม่เปลี่ยน; Relation model: กราฟเวลาของหน้า Model fit จบที่ช่วง Train** 🆕
  - ข้อมูลทุก 5 นาที: เปิดหน้า Model fit ของ Individual ซูมกราฟ "Sensor value over time" ทั้งในช่วง Train และช่วง Scoring · ดู Statistics (Rows, Mean, SD) และ Distribution
  - สลับไปหน้า Health score แล้วกลับมาหน้า Model fit
  - Relation model ใน workspace ที่มี Scoring period อยู่**หลัง**ช่วง Train: ดู "Target vs predicted" และ "Residual over time" และแถบสถิติ (R², RMSE, 2RMSE, Rows)
  - Clustering: ดู scatter และวงรี
  - **คาดหวัง:** Individual: จุดห่างกันตามไฟล์ (5 นาที) ไม่ใช่รายชั่วโมง ทั้งช่วง Train และช่วง Scoring; tooltip อ่านเวลาเป็นนาทีของแถว · Rows = จำนวนแถวดิบของช่วง Train ที่เครื่องเดิน; Mean / SD / ±1SD / ±3SD / ฮิสโทแกรม เท่ากับก่อนอัปเดต · Clustering: scatter เป็นแถวดิบของช่วง Train วงรีและจุดศูนย์กลางเท่าเดิม · **Relation model: "Target vs predicted" และ "Residual over time" มีเส้นเฉพาะแถวของช่วง Train — ไม่ลากต่อเข้าไปในช่วง Scoring ที่อยู่นอก Train** (คะแนนและ residual ของช่วง Scoring ดูที่หน้า Health score; ทุกกราฟระบายแถบสีเฉพาะช่วง Train — ดู BMW-222) · R² / RMSE / 2RMSE / Rows เท่ากับก่อนอัปเดต · ไม่มีกราฟหรือตัวเลข "Health score" และไม่มีคำว่า "1 h average" ในหน้า Model fit · สลับหน้าไปมาแล้วกราฟของแต่ละหน้ายังเป็นแบบของตัวเอง (ดิบ / รายชั่วโมง)

- [ ] **BMW-217 — โมเดลที่ Complete ไว้ก่อนอัปเดตนี้: ยัง Complete, footer หน้า Health score เตือน "Saved results use the earlier row-by-row scoring — Mark complete again to update the files" + ปุ่ม "✓ Mark complete again"; กดแล้วข้อความหาย และไม่กลับมาหลังปิดเปิดโปรแกรม** 🆕
  - เปิด workspace ที่มีโมเดล Complete จากเวอร์ชันก่อนหน้า (Mark complete ไว้ก่อนอัปเดต "คะแนนราย 1 ชั่วโมง") อย่างน้อย 2 โมเดล — ดูจุดในลิสต์ซ้ายและที่ Dashboard แผง Failure Groups
  - เปิดหน้า Health score ของโมเดลแรก ดู footer ป้ายสถานะ และปุ่ม
  - กด "✓ Mark complete again" รอจนเสร็จ แล้วเปิดไฟล์ INFO ของโมเดลนั้นในโฟลเดอร์ output
  - ปิดแล้วเปิดโปรแกรมใหม่ เปิดโมเดลที่กดแล้ว และโมเดล Complete เก่าอีกตัวที่ยังไม่ได้กด
  - **คาดหวัง:** เปิด workspace แล้วโมเดล**ยังเป็น Complete** จุดเขียวทั้งสองหน้าต่าง — ไม่ถูกเปลี่ยนเป็น Incomplete เอง และไม่มีแถบ "Scoring periods changed" · หน้า Health score: footer สีเหลือง **"Saved results use the earlier row-by-row scoring — Mark complete again to update the files"** พร้อมปุ่มทึบ "✓ Mark complete again" (ปุ่ม "Mark incomplete" ยังอยู่) ป้ายยังเขียน "Complete" · กราฟและตัวเลขบนหน้าเป็นแบบรายชั่วโมงแล้ว — เฉพาะไฟล์ที่บันทึกไว้เท่านั้นที่ยังเป็นผลแบบเดิม · กดแล้ว: ไฟล์ถูกเขียนใหม่ footer เป็น "Files saved <วันเวลาใหม่> · …" ข้อความเตือนและปุ่ม again หาย สถานะยัง Complete · ไฟล์ INFO ใหม่มี `"scoring_interval_seconds": 3600` ในส่วน `validation` (BMW-220) · หลังปิดเปิดโปรแกรม: โมเดลที่กดแล้ว**ไม่มี**ข้อความเตือนอีก; โมเดลเก่าที่ยังไม่ได้กด**ยังมี**ข้อความเตือน และยัง Complete · ถ้าโมเดลนั้นมีเรื่องอื่นต้องบอกก่อน (แก้ set point หลังบันทึก = "Files out of date — …", fit หาย, โหลดผลไม่สำเร็จ) ข้อความนั้นขึ้นแทน · โมเดลที่ Mark complete ด้วยเวอร์ชันนี้ และโมเดล Complete เก่ามากที่ไม่มีบันทึกการ export เลย ไม่ขึ้นข้อความเตือนนี้

- [ ] **BMW-218 — Clustering (2 cluster ขึ้นไป): ชั่วโมงที่เครื่องเปลี่ยน cluster กลางชั่วโมงไม่มีคะแนน (อ่านว่า "no score") และ "Lowest" ไม่ไปตกที่ชั่วโมงนั้น** 🆕
  - โมเดล Clustering ที่มี criteria sensor แบ่ง 2 cluster ขึ้นไป ใช้ข้อมูลถี่กว่า 1 ชั่วโมงที่ค่า criteria ข้ามเส้นแบ่งหลายครั้ง (เครื่องเปลี่ยนสภาวะ) เปิดหน้า Health score ตั้ง N ให้ valid
  - หาเวลาที่ criteria ข้ามเส้นแบ่ง (ดูจากกราฟที่ Dashboard) แล้วชี้จุดของชั่วโมงนั้นบน scatter และดูกราฟ Health score ที่เวลาเดียวกัน
  - ดู "Lowest … on …" ที่หัวกราฟ Health score
  - (ถ้าทำได้) หาชั่วโมงที่ criteria sensor ขาดค่าบางแถว หรือมีค่าที่ไม่อยู่ในช่วงของ cluster ใดเลย · ลองกับโมเดล 1 cluster (ไม่มี criteria)
  - **คาดหวัง:** ชั่วโมงที่แถว**ไม่ได้อยู่ cluster เดียวกันทุกแถว** ยังมีจุดบน scatter (ตำแหน่ง = ค่าเฉลี่ย x, y ของชั่วโมง มักอยู่ระหว่างสอง cluster) เป็น**สีเทา ไม่มีสีคะแนน** และบรรทัดอ่านค่าเขียน **"<ต้นชั่วโมง> · no score"** (ไม่ใช่ "not running" และไม่ใช่ "score 0") · บนกราฟ Health score ชั่วโมงนั้นเป็น**ช่องว่างในเส้น** ไม่ดิ่งลง 0 · "Lowest" ที่หัวกราฟ **ไม่ใช่ชั่วโมงที่เครื่องเปลี่ยนสภาวะ** (ก่อนแก้ ชั่วโมงแบบนี้ได้ 0) และชั่วโมงเหล่านี้ไม่ถูกนับใน "below 80 for …% of scored hours" · ชั่วโมงที่มีแถวซึ่ง criteria ขาดค่า หรืออยู่นอกช่วงของทุก cluster ปนอยู่แม้แถวเดียว ก็ไม่มีคะแนนเช่นกัน (แถวนั้นยังถูกนำมาเฉลี่ยตำแหน่งของจุด) · ชั่วโมงที่ทุกแถวอยู่ cluster เดียวกันได้คะแนนตามปกติ (จุดเฉลี่ยของชั่วโมงเทียบกับวงของ cluster นั้น — ไกลเกินวง N = 0 จริง) · โมเดล 1 cluster: ทุกชั่วโมงมีคะแนน · Mark complete ทำได้ตามปกติแม้มีชั่วโมงที่ไม่มีคะแนน

- [ ] **BMW-219 — Relation model ที่ไม่มี Scoring period: ยังได้ health score ของช่วง Train; ระหว่างรอขึ้น "Calculating the health score with the Relation model — this can take up to ~15 s."; คำนวณไม่ได้ = กล่องเหลืองแทนการ์ด "Health score" พร้อม "Try again"** 🐍
  - workspace ที่**ไม่มี** Scoring period: Train โมเดล Relation model แล้วเปิดหน้า Health score กรอก set point 4 ช่องให้ valid
  - ปิดเปิดโปรแกรม เปิดโมเดลเดิม (แอปโหลด fit ใหม่เอง) ดูข้อความระหว่างรอทั้งหน้า Model fit และหน้า Health score
  - (ถ้าทำได้) ทำให้ engine ตอบไม่ได้ (ปิด/ฆ่า process backend ระหว่างรอ) แล้วดูหน้า Health score · กด "Try again"
  - **คาดหวัง:** หลัง Train กราฟ residual รายชั่วโมงและกราฟ Health score ของช่วง Train ขึ้นเกือบทันที (Train คำนวณจุดรายชั่วโมงไปด้วยในรอบเดียว ไม่ต้องรอ ~15 วินาทีอีกรอบ) · Mark complete ยังกดไม่ได้เพราะไม่มี Scoring period (footer บอกเหตุผล) · ถ้าต้องรอนาน ขึ้นบรรทัด **"Calculating the health score with the Relation model — this can take up to ~15 s."** — ขึ้นได้แม้ไม่มี Scoring period และไม่ขึ้นแวบ ๆ ตอนพิมพ์ set point · engine ตอบไม่ได้: **ตรงที่การ์ด "Health score" เป็นกล่องเหลือง "The health score could not be calculated — try again"** + เหตุผล ("…the Relation model engine did not answer. The model fit is not affected…") + ปุ่ม "Try again" — ไม่มีกราฟคะแนนเปล่า และไม่มีกรอบ "Set the points above" · หน้า Model fit แถบสถิติ กราฟ set point และ Checks แสดงปกติ ข้อความนี้ไม่ขึ้นใน Checks และไม่ขึ้นในหน้า Model fit · "Try again" ลองใหม่จริง สำเร็จแล้วกราฟคะแนนขึ้น · ไม่มีคำว่า LinearGAM หรือ sidecar ในข้อความใดเลย

- [ ] **BMW-220 — ไฟล์ INFO ที่ Mark complete เขียน: ส่วน `validation` บอกว่าให้คะแนนแบบราย 1 ชั่วโมง (`scoring_interval_seconds`, `scoring_aggregation`) และตัวเลขของแต่ละช่วงเป็นรายชั่วโมง** 🆕
  - Mark complete โมเดลแต่ละชนิดใน workspace ที่มี Scoring period (ข้อมูลถี่กว่า 1 ชั่วโมง) แล้วเปิด `INDV_INFO_…json` / `REL_INFO_…json` / `CLUS_INFO_…json` ในโฟลเดอร์ output ด้วย text editor ดูส่วน `validation`
  - ดูตัวเลขของแต่ละช่วงใน `tests` (บนจอไม่มีกล่อง Scoring results ให้เทียบแล้ว — ตัวเลขรายช่วงอยู่ในไฟล์นี้ที่เดียว)
  - **คาดหวัง:** `validation` มี key เดิมครบ (`tested`, `validated_at`, `train`, `train_ranges`, `tests`) และเพิ่ม **`"scoring_interval_seconds": 3600`** กับ **`"scoring_aggregation": "mean"`** · แต่ละช่วงใน `tests` มี key เดิมครบ (`index`, `start`, `end`, `rows`, `days`, `scored`, `pct_below_80`, `lowest`, `lowest_at`, `train_rows`, `train_days` + ตัวเลขของชนิดโมเดล) และเพิ่ม `hours`, `train_hours` — ไม่มี key ใดถูกลบหรือเปลี่ยนชื่อ · `rows` / `days` ยังเป็นจำนวนแถวดิบและเวลาเดินจริง; `hours` = จำนวนจุดรายชั่วโมงของช่วง; **`scored` และ `pct_below_80` นับเป็นชั่วโมง**; `lowest` = คะแนนรายชั่วโมงต่ำสุด และ `lowest_at` = ต้นชั่วโมงนั้นในรูป `2026-02-09T23:00:00` · บล็อก `train` ยังเป็นตัวเลขของโมเดลจากแถวดิบ (`rows`, `days`, mean / sd หรือ r2 / rmse …) เพิ่มแค่ `hours` · Clustering: ช่วงที่ไม่มีชั่วโมงไหนมี cluster **ไม่มี key `inside_3sd_ring_pct`** (ไม่ใช่ null หรือ 0) โดย `scored` เป็น 0 และ `pct_below_80` / `lowest` / `lowest_at` เป็น null · ส่วนอื่นของไฟล์ (ค่าของโมเดล, set point, key `criteria_…` / `critera_…` ของ Clustering) และไฟล์ `REL_DATASET_…csv` / `.pkl` ไม่เปลี่ยน

- [ ] **BMW-158 — "✓ Mark complete" เขียนไฟล์โมเดลจริง แล้วถึงเป็น Complete: ผลสำเร็จบอกที่ footer "Files saved <วันเวลา> · <โฟลเดอร์>" (ไม่มีแถบเขียวเหนือกราฟ), ระหว่างบันทึกบอกที่ footer อย่างเดียว, บันทึกไม่สำเร็จ = การ์ดแดง + footer "Not saved …" ที่หายเมื่อแก้ค่า (แทน BMW-139)** 🆕
  - Train โมเดลแล้วกรอก set point ให้ valid บนหน้า Health score แล้วกด "✓ Mark complete" (ทดลองทั้ง Individual, Relation model, Clustering)
  - ระหว่างบันทึก ลองกดปุ่มซ้ำ ลองพิมพ์ในช่อง และกด "← Model fit"
  - อ่านประโยคที่ footer แล้วเอาเมาส์ชี้ path · เปิดโฟลเดอร์จริง (ใต้โฟลเดอร์ข้อมูลของโปรแกรม: workspaces/<id>/output/<ชื่อ sensor>/)
  - ดูแผง Failure Groups ที่ Dashboard และปิดเปิด Build Model
  - ลองกด Mark complete ตอนมีช่องว่าง / ค่าไม่ผ่าน / ยังไม่ Train / settings เปลี่ยนจนต้อง Train ใหม่
  - **คาดหวัง:** ปุ่มกดไม่ได้พร้อมเหตุผลเมื่อมีช่องว่าง/ค่าไม่ผ่าน/ต้อง Train ใหม่ — ไม่มีการเขียนไฟล์ในกรณีนั้น · ระหว่างบันทึก footer ขึ้น "Saving the model files…" ปุ่มเป็น "Saving…" กดซ้ำไม่ได้ (ไม่เขียนไฟล์ซ้อน) หน้ายังตอบสนอง · **ระหว่างบันทึกไม่มีการ์ด/แถบ "Saving…" ในเนื้อหน้า — บอกที่ footer อย่างเดียว** · เฉพาะเมื่อบันทึก**นานเกิน ~4 วินาที** (Relation model มักนานกว่า 15 วินาที โดยเฉพาะครั้งแรก) จึงมีบรรทัด "Still saving… The Relation model is fitted again for the saved files and its scoring periods are scored. This can take longer than 15 seconds, especially the first time." โผล่เหนือกราฟ และหายทันทีที่บันทึกเสร็จ · สำเร็จ: ป้ายเป็น Complete (เขียว) ปุ่มเป็น "Mark incomplete" และ **footer เขียน "Files saved 2026/02/09 23:50 · …\workspaces\<id>\output"** (วันเวลาเป็น mono, path ย่อ; ชี้เมาส์เห็น path เต็ม) — **ไม่มีแถบเขียว "Saved N files to …" / "Files saved to …" เหนือกราฟ และไม่มีแถว "Files"** · ในโฟลเดอร์จริงมีไฟล์ครบ (Individual: INDV_INFO_…json · Clustering: CLUS_INFO_…json · Relation model: REL_INFO_…json + REL_DATASET_…csv + REL_MODEL_….pkl) · ไฟล์ INFO มีค่า set point ที่กรอก และส่วน `validation` ที่มี `"scoring_interval_seconds": 3600` กับ `"scoring_aggregation": "mean"` (ตัวเลขของแต่ละช่วงเป็นรายชั่วโมง — BMW-220) · Dashboard แผง Failure Groups จุดเปลี่ยนเป็นเขียว · ปิดเปิดหน้าต่างแล้วยังเป็น Complete และ footer หน้า Health score ยังเขียน "Files saved <วันเวลา> · …" · ถ้าเขียนไฟล์ไม่สำเร็จ (ลอง: เปิดไฟล์ INFO ค้างไว้ในโปรแกรมอื่น หรือทำโฟลเดอร์ output ให้เขียนไม่ได้) ขึ้น**การ์ดแดง "The model was not saved. <เหตุผล พร้อมชื่อไฟล์/path ที่เขียนไม่ได้>"** และ footer แดง "Not saved · fix it, then Mark complete again" โมเดลยังเป็น Incomplete (ไม่มีไฟล์ครึ่งเดียวค้าง) ปุ่ม Mark complete กดซ้ำได้ · **แก้ set point ช่องใดก็ได้ → การ์ดแดงและ "Not saved" หายทันที** footer กลับไปบอกสถานะจริง — เช่น ลบค่าช่องหนึ่งแล้วต้องเห็น "1 set point still empty" (ไม่ค้าง "Not saved" ไปตลอด) · export ซ้ำทับไฟล์ชื่อเดิม (ชื่อไฟล์ Relation model ผูกกับ predictor — เปลี่ยน predictor แล้วไฟล์ชุดเก่าค้างอยู่ ไม่ถูกลบ)

- [ ] **BMW-140 — "Mark incomplete" + แก้ set point หลังบันทึก: footer เขียน "Files out of date — …" และมีปุ่ม "✓ Mark complete again" (ไม่มีแถบเหลืองในหน้า) (แทน BMW-76)** 🆕
  - ที่โมเดล Complete เปิดหน้า Health score แล้วกด "Mark incomplete"
  - ทำให้ Complete อีกครั้ง แล้วแก้ค่า set point หนึ่งช่อง (อย่า Mark incomplete) ดู footer — แล้วพิมพ์ค่าเดิมกลับ
  - แก้ค่าเป็นค่าที่**ไม่ผ่าน** (หรือลบช่องให้ว่าง) ดู footer และปุ่ม · แล้วแก้เป็นค่าที่ผ่าน กด "✓ Mark complete again"
  - **คาดหวัง:** "Mark incomplete" (ปุ่มข้อความ ไม่ใช่ปุ่มทึบ) เปลี่ยนแค่สถานะ (ป้ายกลับเป็น Trained, จุดเป็นเหลือง) — ไฟล์ที่เขียนไว้ยังอยู่ในโฟลเดอร์ ค่า set point ยังอยู่ · แก้ set point ตอนยัง Complete: **สถานะไม่เปลี่ยน** ป้ายยังเป็น Complete แต่ footer เปลี่ยนเป็นสีเหลือง **"Files out of date — set points changed after saving · Mark complete again to update them"** และมีปุ่ม "✓ Mark complete again" (ปุ่มทึบปุ่มเดียวของจอ) — **ไม่มีแถบ "Changed after saving" ในเนื้อหน้า** · **ค่าใหม่ไม่ผ่าน/ว่าง: footer เขียน "Files out of date · <เหตุผล>" (เช่น "Files out of date · 1 set point still empty") และปุ่ม "✓ Mark complete again" กดไม่ได้** ป้ายยังเป็น Complete · พิมพ์ค่าเดิมกลับ: ประโยคกลับเป็น "Files saved …" ปุ่ม again หาย · "Mark complete again" เขียนไฟล์ใหม่ด้วยค่าใหม่ แล้ว footer กลับเป็น "Files saved <วันเวลาใหม่> · …" สถานะยัง Complete · **โมเดลที่ Mark complete ไว้ก่อนอัปเดต "คะแนนราย 1 ชั่วโมง": footer ขึ้นอีกข้อความหนึ่งโดยไม่ต้องแก้ set point — "Saved results use the earlier row-by-row scoring — Mark complete again to update the files" พร้อมปุ่ม "✓ Mark complete again" (ดู BMW-217)**; ถ้าแก้ set point ของโมเดลนั้นด้วย ข้อความ "Files out of date — …" ขึ้นแทน · โมเดล Complete เก่าจากก่อนฟีเจอร์นี้ (ไม่มีบันทึกการ export) ไม่ขึ้นทั้งสองข้อความ

- [ ] **BMW-77 — ค่า set point บันทึกเมื่อไร: blur / Enter / ออกจากหน้า / เปลี่ยนโมเดล / ปิดหน้าต่าง — และไม่ทำให้โมเดล stale หรือเปลี่ยนสถานะ** 🆕
  - พิมพ์ค่า set point แล้วกด Tab หรือคลิกที่อื่น (blur) / กด Enter
  - พิมพ์ค่าแล้วกด "← Model fit" ทันที / สลับไป sensor อื่นทันที โดยไม่ blur
  - พิมพ์ค่าแล้ว **ปิดหน้าต่าง Build Model ทันที** (ปุ่ม X หรือ Alt+F4) แล้วเปิดใหม่
  - แก้ค่าแล้วดูป้ายสถานะ (Trained / Complete) และแผง Failure Groups ที่ Dashboard
  - เปิดสองหน้าต่าง (หรือแก้ชื่อโมเดลจาก Dashboard) ขณะกำลังพิมพ์ค่าอยู่
  - **คาดหวัง:** ค่าที่พิมพ์ไม่หายในทุกกรณี (รวมปิดหน้าต่างทันที — โปรแกรมรอให้บันทึกเสร็จก่อนปิด) · พิมพ์แล้วกราฟ/คะแนน/Checks เปลี่ยนทันทีโดยยังไม่ต้องบันทึก · แก้ set point ไม่ทำให้โมเดลเป็น stale ("Re-train") และไม่เปลี่ยนสถานะ Complete/Incomplete เอง · การเปลี่ยนจากหน้าต่างอื่นระหว่างที่พิมพ์ไม่เขียนทับสิ่งที่กำลังพิมพ์ · ค่า set point อยู่ต่อหลังปิดเปิดโปรแกรม

- [ ] **BMW-133 — set point ว่าง / ไม่ผ่าน: จุดเหลือง "Set points needed" / จุดแดง "Fix set point" บนแท็บ (tooltip) + จุดในลิสต์ซ้าย — ผลถูกบันทึกกับโมเดลและแท็บ Failure Groups เห็นเหมือนกัน (แทน BMW-115)** 🆕
  - Train โมเดล Relation model/Clustering (set point ยังว่าง) — เอาเมาส์ชี้จุดบนแท็บของโมเดลนั้น และดูจุดในลิสต์ซ้าย
  - กรอกค่าที่ไม่ผ่าน (เช่น N = 2) แล้วดูอีกครั้ง จากนั้นแก้ให้ผ่าน
  - สลับไปดูโมเดลอื่นของ sensor เดียวกันที่ยังไม่เคยเปิดดูในรอบนี้ และดูแท็บ Failure Groups ที่ Dashboard (ดู FG-14)
  - **คาดหวัง:** ว่าง = จุดเหลือง tooltip "Set points needed" · ค่าที่ไม่ผ่าน = จุดแดง tooltip "Fix set point" (ทั้งแท็บและลิสต์) · ผ่านแล้วจุดกลับเป็นเหลือง tooltip "Trained" · **ไม่มีป้ายข้อความบนแท็บ** · ระหว่างพิมพ์ จุดของโมเดลที่เปิดอยู่เปลี่ยนตามทันทีที่ Rust ตอบ ส่วนค่าที่บันทึกกับโมเดล (และจุดที่ Dashboard) ตามมาเมื่อค่าถูกบันทึก (blur/Enter) · โมเดลที่ไม่เคยถูกเปิดดูในรอบนี้ใช้ผลที่บันทึกไว้ครั้งล่าสุด (ถ้ามี) · Warning จาก Rust (เช่น ชื่อโมเดลมีอักขระที่ใช้เป็นชื่อไฟล์ไม่ได้) ไม่ทำให้จุดเป็นแดง/เหลืองและไม่บล็อก Mark complete — แสดงเป็นหมายเหตุสีเหลืองใน Checks

- [ ] **BMW-134 — footer ของทั้งสองหน้า: ป้ายสถานะ 1 อัน + ประโยคเดียว (สถานะถูกพูดเป็นคำ "ที่เดียว") — ไม่มี "full view" และไม่มีปุ่ม Train ที่ footer (แทน BMW-103)** 🆕
  - เปิดหน้าต่าง Build Model ของ workspace ที่มีโมเดลครบทั้ง 3 ชนิด — ดู footer ของหน้า Model fit ในแต่ละสถานะ: ยังไม่ Train, Train แล้ว, แก้ค่าหลัง Train, แก้ชื่อโมเดลค้างไว้ (ยังไม่ Save), Train ไม่ผ่าน, Complete
  - ดู footer ของหน้า Health score: set point ว่าง, ไม่ผ่าน, ผ่าน, ระหว่างบันทึก, Complete
  - **คาดหวัง:** footer มี**ป้ายสถานะอันเดียว** (Incomplete / Trained / Complete) + **ประโยคเดียว** — ไม่มีป้ายอื่น (ไม่มี "Scored · N") · หน้า Model fit: ยังไม่ Train = "Not trained yet · Train sensor ↑" · Train แล้ว = "Trained 2026/02/09 23:50 · scored on 2 periods · check the charts, then set the health set points" · ค่าเปลี่ยน = เหลือง "Settings or running condition changed · train again with Train sensor ↑" · แก้ค้างไว้ = "Unsaved changes to the Individual model" (Relation model เขียน "the Relation model") · Train ไม่ผ่าน = **แดง** "Training failed · fix the problem, then Train sensor ↑" · fit ของ Relation model หายจากหน่วยความจำ = เหลือง "Fit no longer in memory · load it again, or re-train with Train sensor ↑" และป้ายเป็น Incomplete (โมเดลที่ Complete แล้ว: "Fit no longer in memory · load it again" และป้าย**ยังเป็น Complete** — ดู BMW-166) · ติด gate/ตั้งค่าไม่ครบ = เหลือง + เหตุผล · Complete = "Trained <วันเวลา> · scored on N periods" · อยู่ในคิว = "Queued in the run · next" / "Training now · about 15 s" · หน้า Health score: เหลือง + เหตุผลแรกที่ Mark complete ถูกบล็อก ("N set points still empty" …) · ผ่าน = "Set points valid — check the score chart, then Mark complete" · ระหว่างบันทึก = "Saving the model files…" · บันทึกไม่สำเร็จ = แดง "Not saved · fix it, then Mark complete again" (หายเมื่อแก้ set point — ดู BMW-158) · โหลดคะแนนไม่สำเร็จ = "The health score did not load · Retry above, then Mark complete" (ดู BMW-167) · Complete = "Files saved <วันเวลา> · …\workspaces\…\output" (ดู BMW-158) · กด "Train sensor ↑" แล้วโฟกัสไปที่ปุ่มบนหัว · **"Save changes" มีเฉพาะตอนมีค่าที่แก้ค้างไว้** (ไม่มีค่าค้าง = ไม่มีปุ่ม) · ไม่มีปุ่มหรือลิงก์ "Open full view", "Finish", "▶ Train model", "↻ Re-train" ที่ footer · หน้า Health score มี "← Model fit" (ปุ่มข้อความ) และ Mark complete / Mark incomplete · ทุกอย่างของโมเดลจบในสองหน้าของ Workbench · ปุ่ม "Build Model →" ที่ Dashboard ยังเปิดหน้าต่างได้ตามปกติ

- [ ] **BMW-135 — บนจอมีปุ่ม "สีทึบ" ได้อย่างมากปุ่มเดียว และปุ่มนั้นเปลี่ยนตามสถานะ** 🆕
  - ไล่ดูสถานะเหล่านี้ทีละอย่างแล้วนับปุ่มสีทึบ (ฟ้า / เขียว / แดง) ทั้งหน้าต่าง (ไม่นับ popup): (1) ยังไม่ตั้ง Running condition (2) โมเดลยังไม่ Train (3) แก้ชื่อโมเดลค้างไว้ (4) Train แล้ว (5) sensor ที่โมเดลหนึ่ง Train แล้วแต่อีกชนิดยังไม่ Train (6) หน้า Health score ของโมเดลที่ Train แล้ว (7) โมเดล Complete ทั้งสองหน้า (8) Complete แล้วแก้ set point (9) แก้ค่าหลัง Train (แถบเหลือง "Settings or running condition changed") (10) ระหว่างที่โมเดลของ sensor นี้กำลัง train (11) workspace **ยังไม่ตั้ง** Running condition แต่เลือกโมเดลที่ตั้ง Training data เป็น Custom และมีเงื่อนไขของตัวเองครบ — ไล่ Train → Health score → Mark complete
  - **คาดหวัง:** (1) มีแค่ปุ่มบนการ์ด "Set running condition →" (ช่วงผิด = ปุ่มแดง "Fix period") — Train sensor / Next / Save เป็นปุ่มขอบจาง · (2) **"▶ Train sensor"** ทึบ (รวมครึ่ง ▾), "Next: Health score →" จาง · (3) **"Save changes"** ทึบ, Train sensor จางชั่วคราว (ยังกดได้) — กด Save แล้ว Train sensor กลับมาทึบ · (4) **"Next: Health score →"** ทึบ, Train sensor จาง · (5) **Train sensor** ทึบ, Next จาง (ยังกดได้) · (6) **"✓ Mark complete"** (เขียว) ปุ่มเดียว · (7) **ไม่มีปุ่มทึบเลย** — "Mark incomplete" เป็นปุ่มข้อความ · (8) **"✓ Mark complete again"** โผล่มาและเป็นปุ่มทึบปุ่มเดียว · (9) Train sensor ทึบ, แถบเหลืองไม่มีปุ่มของตัวเอง (มีแค่ลิงก์ข้อความ "Train sensor ↑") · (10) ปุ่ม Train sensor ยังเป็นปุ่มทึบปุ่มเดียว เขียน "Training…" และกดไม่ได้ — footer เขียน "Training now · about … s", "Next" กดไม่ได้ · (11) **ปุ่มทึบมีแค่ "Set running condition →" บนการ์ดตลอดทาง** — ของโมเดล Custom ทั้ง "▶ Train sensor", "Next: Health score →" และ "✓ Mark complete" เป็นปุ่มขอบจาง**แต่กดได้และทำงานจริง** (Train ได้, เปิด Health score ได้, Mark complete แล้วเป็น Complete) และ**บรรทัดเล็กใต้ปุ่ม Train sensor บอกว่าโมเดลนี้ไม่ถูกล็อก**: "Trains Individual · own running condition, not blocked" (หลัง Train แล้ว: "1 model up to date — nothing to train · own running condition, not blocked") — ไม่ขึ้น "Set the running condition first." กับโมเดล Custom · ส่วนโมเดล Workspace ของ sensor อื่นยังถูกล็อกเหมือนเดิม · การเป็นทึบ/จางเปลี่ยนแค่หน้าตา — ปุ่มที่เคยกดได้ยังกดได้เหมือนเดิม

- [ ] **BMW-84 — ทุกโมเดลเข้าถึงและทำให้ Complete ได้จากสองหน้าของ Workbench เท่านั้น (Individual / Relation model / Clustering)** 🐍
  - **Individual:** เลือก sensor → กาง Model settings แก้ชื่อโมเดล **โดยไม่กด Save changes** → กด "▶ Train sensor" (หรือ ▾ → "Individual only") → "Next: Health score →" → กรอก L / H ที่ผ่าน Checks → "✓ Mark complete"
  - **Relation model:** เลือก predictor อย่างน้อย 1 ตัวใน Model settings (ยังไม่ Save) → Train → ตั้ง Stiffness เป็น Strict แล้วดูว่ากลายเป็น stale ต้อง Re-train → "Compare predictors" เปิด Sub-models ได้ → Health score กรอกช่อง 80 / 0 ทั้ง 4 ช่อง → Mark complete
  - **Clustering:** เลือก X / Y sensor และจำนวน cluster → Train → Health score กรอกวงนอก N× SD → Mark complete
  - ปิดเปิดหน้าต่าง Build Model แล้วดูสถานะของทั้ง 3 โมเดล
  - **คาดหวัง:** ค่าที่แก้ใน Model settings โดยไม่กด Save ถูกบันทึกให้เองตอนกด Train (ผล Train ตรงกับค่าที่แก้ ไม่ใช่ค่าเก่า) · ทั้ง 3 ชนิดไปถึง Complete ได้ด้วยลำดับนี้เท่านั้น — ไม่มีเส้นทางอื่น (ไม่มี Finish) · Mark complete เขียนไฟล์ของโมเดลลงโฟลเดอร์ output ของ workspace (Relation model ใช้ ~15 วินาที และ**ต้องสำเร็จบนแอปที่ติดตั้งแล้ว** — เป็นเส้นทางเดียวที่เรียก Python sidecar) · ไม่มีคำว่า "LinearGAM" ที่ใดเลย ใช้ "Relation model" · หลังปิดเปิดหน้าต่าง ทั้ง 3 โมเดลยังเป็น Complete พร้อมกราฟ

- [ ] **BMW-81 — "Mark complete" ทนต่อการแก้ค่า / ปิดหน้าต่าง / ตั้งค่าเปลี่ยนระหว่างที่กำลังเขียนไฟล์ (Relation model ใช้ ~15 วินาที)** 🆕
  - (Relation model) กด "✓ Mark complete" แล้ว **ระหว่างที่ยัง Saving…** แก้ set point ช่องหนึ่งแล้วกด Tab (blur)
  - ทำซ้ำ แต่คราวนี้ระหว่างบันทึกกด "← Model fit" เปลี่ยน Stiffness → Save changes → Re-train
  - ทำซ้ำ แต่ระหว่างบันทึกกดปิดหน้าต่าง (ปุ่ม X ของโปรแกรม และ Alt+F4/ปุ่ม Close ของ OS)
  - ทำซ้ำ แต่ให้ Mark complete ถูกปฏิเสธหลังเขียนไฟล์ (เช่น เปลี่ยน Running condition จากอีกหน้าต่างระหว่างบันทึก) แล้วดูหน้า Model fit
  - **คาดหวัง:** ค่าที่แก้ระหว่างบันทึก **ไม่ถูกย้อนกลับ**; โมเดลเป็น Complete (ไฟล์ตรงกับค่าตอนกด) และfooter ขึ้น "Files out of date — set points changed after saving · Mark complete again to update them" ให้เขียนไฟล์ใหม่ · ถ้าตั้งค่าโมเดลเปลี่ยน + Train ใหม่ระหว่างบันทึก โมเดล **ไม่** เป็น Complete (ไฟล์เป็นของตั้งค่าเก่า) และบอกเหตุผล "settings changed while its files were being written" · ปิดหน้าต่างระหว่างบันทึก: หน้าต่างรอจนเขียนไฟล์และบันทึกสถานะเสร็จจึงปิด — ถ้านานเกินที่ควร (sidecar ค้าง) หน้าต่างยังไม่ปิดและขึ้นข้อความ "Still saving the model files…" ปิดซ้ำอีกครั้งจึงปิดจริง · เมื่อไฟล์ถูกเขียนแต่โมเดลไม่ถูกบันทึกเป็น Complete จะเห็นแถบ "The model was not marked complete. …" ที่หน้า Model fit ด้วย (กด Dismiss ได้) ไม่ใช่เห็นเฉพาะหน้า Health score
  - **หมายเหตุ Duplicate workspace:** ตอนนี้ยังไม่มีปุ่มใน UI ที่เรียกทำสำเนา workspace (ฟังก์ชันมีใน `workspaceManager.ts` แต่ไม่มีหน้าจอเรียก) — เมื่อมีปุ่ม: โมเดลในสำเนาต้องเป็น Incomplete (ไม่มี "Complete · files saved to …") โดยยังมี set point/ผล Train ครบ และต้องกด Mark complete ใหม่เพื่อเขียนไฟล์ให้สำเนา (โฟลเดอร์ output ของต้นฉบับไม่ถูกคัดลอก)

- [ ] **BMW-167 — หน้า Health score เมื่อโหลดคะแนนไม่สำเร็จ: การ์ดแดง + Retry, หน้าไม่หายตอนพิมพ์ต่อ, Mark complete กดไม่ได้พร้อมเหตุผลที่ footer; ข้อมูลถูกโหลดใหม่ = ไม่มี Retry และ footer บอกให้เปิด Build Model ใหม่ (แทน BMW-159)** 🆕
  - เปิดหน้า "Health score" แล้วจำลองให้ครั้งหนึ่งโหลดไม่สำเร็จ (เช่น ปิด/เปิดข้อมูลชั่วขณะ — ถ้าทำไม่ได้ให้ข้ามส่วนนี้) แล้วดูหน้า การ์ด set point และ footer · ทำกับโมเดล Complete ที่แก้ set point แล้วด้วย (มีปุ่ม "Mark complete again")
  - ขณะการ์ดแดงยังอยู่ คลิกในช่อง set point แล้ว**พิมพ์ต่อทีละตัว** (ไม่กด Retry) — ดูว่าช่องที่กำลังพิมพ์ยังอยู่และเคอร์เซอร์ไม่หลุด
  - ระหว่างหน้า Health score เปิดอยู่ ไปที่หน้าต่างหลักแล้วโหลดไฟล์ CSV อื่น (ข้อมูลเปลี่ยน) กลับมาแก้ set point หนึ่งช่อง — ดูการ์ดแดงและ footer
  - กรอก set point ของ sensor ที่ค่าเล็กมาก (เช่น 0.0000004) กด Tab แล้วปิดเปิด Build Model ดูค่าในช่อง
  - (Relation model) ใช้ screen reader หรือ Tab ไล่ช่อง 80/0 ทั้ง Lower และ Upper
  - **คาดหวัง:** โหลดไม่สำเร็จ = หน้ายังอยู่ (ช่อง กราฟล่าสุด) มี**การ์ดแดง "Couldn't load the health score. <เหตุผล> · the score and Checks are not available until it loads"** พร้อมปุ่ม **Retry** — ระหว่างนั้นไม่มีจุดสถานะที่หัวการ์ด, ส่วน Checks เขียน "Not available until the health score loads.", กรอบคะแนนเขียน "Score not available" · **ปุ่ม "✓ Mark complete" / "✓ Mark complete again" กดไม่ได้ และ footer บอกเหตุผล "The health score did not load · Retry above, then Mark complete"** (โมเดล Complete ที่แก้ค่า: "Files out of date · The health score did not load · …") · กด Retry แล้วโหลดได้ = การ์ดแดงหาย ปุ่มกลับมากดได้ · **พิมพ์ต่อใต้การ์ดแดง: หน้าไม่ถูกแทนด้วยกล่อง "Loading…" — ช่องที่พิมพ์ยังอยู่ เคอร์เซอร์ยังอยู่ในช่อง ตัวที่พิมพ์ครบ; การ์ดแดงเปลี่ยนเป็นบรรทัดเทา "Loading the health score again… the score and Checks are not available until it loads" ชั่วครู่ แล้วกลับเป็นหน้าปกติ (ถ้าโหลดได้) หรือการ์ดแดง (ถ้ายังไม่ได้)** · ครั้งแรกที่เปิดแล้วโหลดไม่สำเร็จเลย (ยังไม่มีผลเก่า) = การ์ดแดงแบบเดียวกัน · **ข้อมูลถูกโหลดใหม่ (dataset changed): การ์ดแดง**ไม่มีปุ่ม Retry** และ footer เขียน "The data in this window is out of date. Close it and open Build Model again from the Dashboard." — ไม่มีคำว่า "Retry above" (เพราะไม่มีปุ่มให้กด)** · ค่าเล็กๆ แสดงครบตามที่เก็บ (ไม่กลายเป็น 0 หรือถูกตัดทศนิยม) · หัวคอลัมน์ที่เห็นเป็น "Lower / Upper" แต่ชื่อสำหรับ screen reader ของ 4 ช่องเป็น "Lower residual at score 80" ฯลฯ ไม่ซ้ำกัน · fit ของ Relation model หายจากหน่วยความจำ ดู **BMW-166**

- [ ] **BMW-166 — Relation model ที่ fit หายจากหน่วยความจำ ("Fit no longer in memory"): ลิงก์ "Load it again" ทั้งหน้า Model fit และ Health score — โหลดกลับมาโดยไม่ train ใหม่ โมเดล Complete ยัง Complete** 🆕
  - ทำให้ fit ของ Relation model หายสองครั้งติด: วิธีที่เจอจริง = workspace ที่มี Relation model **9 ตัวขึ้นไป** เปิดดูทีละตัวจนครบ แล้วกลับมาเปิดตัวแรก ๆ ซ้ำเป็น**ครั้งที่สาม** (หน่วยความจำเก็บ fit ได้ 8 ตัว) — หรือแก้ special sensor ที่โมเดลใช้สองครั้ง
  - ทำกับโมเดลที่ **Mark complete แล้ว** (ป้าย Complete) และโมเดลที่แค่ Trained — ดูกล่องในหน้า Model fit, หน้า Health score, footer ของทั้งสองหน้า, จุดบนแท็บ และปุ่ม "▶ Train sensor"
  - กดลิงก์ **"Load it again"** (ในกล่อง หรือ "load it again" ที่ footer) รอ ~15 วินาที · ปิดเปิด Build Model แล้วดูสถานะและเวลา "Trained …" ของโมเดล
  - (โมเดลที่ไม่ Complete) กดลิงก์ "Train sensor ↑" แล้วกดปุ่ม "▶ Train sensor"
  - อีกรอบ: หน้า Health score ที่ยังเห็น set point ปกติ ทำให้ fit หาย (วิธีข้างบน โดยไม่สลับออกจากหน้านี้ ถ้าทำได้) แล้วกด "✓ Mark complete"
  - **คาดหวัง:** fit หายครั้งแรกระบบโหลดกลับเองเงียบ ๆ หนึ่งครั้ง (ไม่ต้องกดอะไร) — หายซ้ำจึงขึ้นกล่องเส้นประ **"Fit no longer in memory"** / "The fitted Relation model is no longer in memory (the data was reloaded, a special sensor changed, or many Relation models were opened). Nothing about the model changed — **Load it again**…" ต่อท้ายด้วย "The charts come back when it is loaded." (หน้า Model fit) หรือ "Your set points are kept and scored again when it is loaded." (หน้า Health score) — **ในกล่องไม่มีปุ่ม** มีแต่ลิงก์ข้อความ · **โมเดล Complete:** มีลิงก์ "Load it again" **อย่างเดียว** (ไม่มี "Train sensor ↑" เพราะปุ่ม Train sensor กดไม่ได้ — ปุ่มจางเขียน "▶ Train sensor" และบรรทัดใต้ปุ่ม "1 model up to date — nothing to train"), ป้ายที่ footer ยังเป็น **Complete**, footer เขียน "Fit no longer in memory · load it again", tooltip ของแท็บ "Complete · Fit no longer in memory" · **โมเดลที่ไม่ Complete:** กล่องมีทั้ง "Load it again" และ ", or re-train it with Train sensor ↑", ป้าย footer เป็น Incomplete (ไม่ใช่ Trained), footer เขียน "Fit no longer in memory · load it again, or re-train with Train sensor ↑", ปุ่ม "▶ Train sensor" เป็นปุ่มทึบและนับโมเดลนี้, ปุ่ม Mark complete เป็นปุ่มขอบจาง กดไม่ได้ (tooltip เดียวกับ footer) · **กด "Load it again": กล่องเปลี่ยนเป็น "Loading the Relation model…" (วงหมุน) แล้วกราฟ / set point / คะแนนกลับมาเหมือนเดิม — สถานะไม่เปลี่ยน (Complete ยัง Complete พร้อม "Files saved …" เดิม; Trained ยัง Trained), เวลา "Trained …" เท่าเดิม, ไม่ต้อง Mark complete ใหม่ และหลังปิดเปิดก็ยังเหมือนเดิม (ไม่มีอะไรถูกเขียนลงดิสก์)** · ถ้าโหลดไม่สำเร็จ: กลับมาที่กล่องเดิม ขอบแดง มีบรรทัด mono "The last attempt did not work: <เหตุผล>" และลิงก์ "Load it again" ยังกดซ้ำได้ · ระหว่างมี training run: ลิงก์ "Load it again" จาง กดไม่ได้ tooltip "Wait for the training run to finish" · (ไม่ Complete) Train sensor ก็ทำให้กลับมาได้เช่นกัน แต่โมเดลจะถูก train ใหม่ · **Mark complete ตอน fit หาย:** ขึ้นการ์ดแดง "The model was not saved. The fitted Relation model was no longer in memory, so its files were not written. Mark complete again once it is loaded." แล้วหน้าโหลด fit กลับเอง (หรือขึ้นกล่อง "Fit no longer in memory" ให้กด Load it again) — **กด Mark complete ซ้ำแล้วไม่วนล้มเหลวแบบเดิมทุกครั้ง** · ไม่มีคำว่า LinearGAM ที่ไหน

- [ ] **BMW-182 — โมเดล Complete ที่โหลดผลไม่สำเร็จตอนเปิด (ไม่ใช่ fit หาย): กล่อง "Couldn't load the …" มี "Load it again" — ไม่มี "Train sensor ↑" ที่กดไม่ได้** 🆕
  - *(ทำให้เกิดยาก — วิธีที่ง่ายสุด: โมเดล **Relation model ที่ Mark complete แล้ว** ปิด Build Model แล้วเปิดใหม่ เลือก sensor นั้น และระหว่างที่ขึ้น "Loading the Relation model…" ให้ปิด process `backend-…exe` ใน Task Manager — ถ้าทำไม่ได้ให้ข้ามข้อนี้)*
  - ดูกล่องในพื้นที่กราฟ, จุดบนแท็บ + ในลิสต์ซ้าย (ชี้ค้างอ่าน tooltip), ป้ายและประโยคที่ footer, ปุ่ม "▶ Train sensor"
  - กดลิงก์ "Train sensor ▾" ในกล่อง · ปิดเมนู แล้วกดลิงก์ **"Load it again"** (ในกล่อง หรือ "load it again" ที่ footer)
  - โหลดกลับมาได้แล้ว ปิดเปิด Build Model ดูสถานะของโมเดลอีกครั้ง
  - **คาดหวัง:** กล่องสีแดงหน้าตาเดียวกับกล่องอื่น (หัวข้อ + ประโยคเดียว + เหตุผลเป็น mono): **"Couldn't load the Relation model"** / "Nothing about the model changed and it stays Complete — Load it again, or train it from the Train sensor ▾ menu (it then needs Mark complete again). The charts come back when it is loaded." — **ไม่มีกล่อง "Training failed" และไม่มีลิงก์ "Train sensor ↑"** (ปุ่ม Train sensor เป็นปุ่มจาง กดไม่ได้ "1 model up to date — nothing to train" เพราะ Train sensor ไม่ train โมเดล Complete ที่ up to date) · ป้ายที่ footer ยังเป็น **Complete** ประโยคสีแดง "Couldn't load the model · load it again" · จุดบนแท็บและในลิสต์เป็นสีแดง tooltip "Complete · Couldn't load the model" · ลิงก์ "Train sensor ▾" เปิดเมนู ซึ่งแถวของโมเดลนั้นกดได้ ("Up to date · trains anyway · it becomes Incomplete") · **"Load it again"** = กล่องเปลี่ยนเป็น "Loading the Relation model…" แล้วกราฟกลับมา — **ไม่มี run เกิดขึ้น ไม่เขียนอะไรลงดิสก์ โมเดลยัง Complete** (ปิดเปิดใหม่ยัง Complete วันที่ Trained เดิม) · ถ้าโหลดไม่ผ่านอีก กลับมาที่กล่องเดิมพร้อมเหตุผล (ไม่ค้างที่ "Loading…") · คำว่า "Load it again" เขียนเหมือนกันกับกล่อง "Fit no longer in memory" (BMW-166) ทั้งสองหน้า · ใช้ได้กับ Individual และ Clustering ด้วย ("Couldn't load the Individual model" / "… Clustering model")

- [ ] **BMW-204 — ตัวเลขที่โปรแกรมคำนวณในคอลัมน์ของตาราง "Health set points" เรียงตรงจุดทศนิยม (ทศนิยม 3 ตำแหน่งเท่ากันทุกแถว); ค่าที่ผู้ใช้พิมพ์ยังแสดงตามที่พิมพ์ (แทน BMW-168)** 👀
  - หน้า Health score ของ Individual และ Relation model — ดูการ์ด "Health set points" คอลัมน์ Lower / Upper ของแถว automatic (100 / 80 ของ Individual, 100 ของ Relation model) เทียบกับค่าที่พิมพ์เองในแถวล่าง
  - **คาดหวัง:** ตัวเลขในคอลัมน์เดียวกันมี**ทศนิยม 3 ตำแหน่งเท่ากันทุกแถว** จึงเรียงตรงจุดทศนิยม · แถว automatic ของ set point เช่น "4.000" / "6.000", "−0.913" / "+0.913" · ค่าที่ไม่ใช่ศูนย์แต่เล็กมาก**ไม่แสดงเป็น 0.000** (เช่น "0.000120") · **ค่าที่ผู้ใช้พิมพ์เอง** (L / H, residual 80 / 0, N, ลิงก์ "Use master H 4.5") ยังแสดง**ตามที่พิมพ์** ไม่เติมศูนย์ ไม่ปัด · ตัวเลขนอกตาราง (แถบสถิติบนหน้า Model fit, tooltip ของกราฟ) ยังไม่เติมศูนย์ท้ายเหมือนเดิม

- [ ] **BMW-169 — ปิด "Animation effects" ของ Windows แล้วไอคอนหมุนใน Workbench ต้องหยุดหมุน (ข้อความยังอยู่ครบ)** 🆕
  - Windows Settings → Accessibility → Visual effects → ปิด **Animation effects** แล้วเปิดโปรแกรมใหม่ เปิดหน้าต่าง Build Model
  - กด "▶ Train sensor" ของ Relation model (ใช้ ~15 วินาที) — ดูปุ่มบนหัว, กล่อง "Training the Relation model · about 15 s", ป้ายในลิสต์ซ้าย, แถบ run และ footer
  - เปิดโมเดลที่ Train แล้วอีกตัว ดูกล่อง "Loading the … model…" · ที่หน้า Health score กด "✓ Mark complete" ของ Relation model แล้วดู footer "Saving the model files…"
  - เปิด Animation effects กลับ แล้วดูจุดเดิมอีกครั้ง
  - **คาดหวัง:** ตอนปิด Animation effects: ไอคอนวงกลมโหลด**อยู่นิ่ง ไม่หมุน**ทุกจุด (ปุ่ม "Training…", กล่อง Training / Loading, ป้าย "กำลัง train" ในลิสต์, footer "Training now …" / "Saving the model files…") และช่องที่กำลัง train ในแถบ run ไม่กะพริบ — **ข้อความบอกสถานะยังอยู่ครบ** จึงยังรู้ว่ากำลังทำงาน และทุกอย่างทำงานจบได้ตามปกติ · เปิด Animation effects กลับ: ไอคอนหมุนตามเดิม

- [ ] **BMW-117 — Clustering: "Cluster ranges" เป็นแถบเลื่อนลากได้ตามช่วงค่าจริงของ criteria sensor แสดงตลอดเวลา และพิมพ์ค่าเส้นแบ่งได้ตรงๆ (แทน BMW-48 — เพิ่มช่องพิมพ์ 2026-10-09)** 🆕
  - เลือกโมเดล Clustering ที่ยังไม่ได้เลือก criteria sensor แล้วกด + ให้ Clusters เป็น 2 ขึ้นไป (โมเดลใหม่เริ่มที่ 1 cluster — ดู **BMW-119**) — ดูข้อความ "Pick a criteria sensor above to define cluster ranges." และรายการ "to fix" ต้องมี "Pick a criteria sensor for 2+ clusters (or set Clusters to 1)" (ปุ่ม Train sensor กดไม่ได้จนกว่าจะเลือก criteria sensor หรือลด Clusters เหลือ 1)
  - **(ใหม่ 2026-10-09)** ใต้แถบสี pill แต่ละอัน "#1: … – [ช่อง]" — เส้นแบ่งด้านในเป็นช่องพิมพ์ได้ (ค่าต่ำสุดของ #1 และค่าสูงสุดของ cluster สุดท้ายเป็นช่วงของ sensor อ่านอย่างเดียว) พิมพ์ค่าเช่น 33.60 แล้วกด Enter — แถบสี หัวจับ และ pill ถัดไปต้องขยับตาม ตัวเลขยังเป็น "33.60" ตามที่พิมพ์ (ไม่ปัด) · ลองพิมพ์แล้วคลิกที่อื่น (blur) ก็บันทึกเหมือนกัน · ลองพิมพ์ค่าที่เกินเส้นแบ่งถัดไป ค่าเท่ากับเส้นข้างเคียง ค่าต่ำกว่าค่าต่ำสุดของ sensor และตัวหนังสือ (เช่น abc) — ต้องขึ้นข้อความแดงใต้ pill บอกช่วงที่ใส่ได้ ช่องเป็นกรอบแดง และไม่มีอะไรขยับ · พิมพ์ทศนิยมด้วยจุลภาค (เช่น 33,6) — ต้องขึ้น "Use . for decimals (e.g. 33.6)." และไม่ถูกอ่านเป็น 336 · ค่าที่มีจุลภาคหลักพัน (เช่น 1,234.5 กับ sensor ที่ค่าหลักพัน) ใช้ได้ · พิมพ์ค่าเดิมในรูปอื่น (เช่น 4 → 4.0) — ไม่ขึ้นปุ่ม "Save changes" ที่ footer (ไม่ถือเป็นค่าที่แก้ค้าง) และไม่มีอะไรต้อง Save · ระหว่างที่ช่องยังมีข้อความแดงค้าง คลิกเลือกโมเดลอื่นในลิสต์ซ้าย — โมเดลใหม่ต้องไม่มีข้อความแดง/ค่าค้างมา และกลับมาโมเดลเดิมค่าเป็นค่าเดิม · กด Esc ระหว่างพิมพ์ — ค่ากลับเป็นค่าเดิม ข้อความแดงหาย · กด Save changes แล้วปิดเปิดโปรแกรม เปิดโมเดลเดิม ค่าที่พิมพ์ยังอยู่ · โมเดลที่ Complete แล้วกลายเป็น Incomplete เมื่อบันทึกค่าใหม่
  - ลดจำนวน cluster เหลือ 1 (แม้เลือก criteria sensor แล้ว) — ดูข้อความ "One cluster — every row goes in. No ranges to set."
  - เลือก criteria sensor แล้วตั้งจำนวน cluster ≥ 2 — ดูข้อความ "Loading … range…" สั้นๆ ก่อนเปลี่ยนเป็นแถบสีต่อ cluster ยาวเต็มตามช่วง [ต่ำสุด, สูงสุด] จริงของ sensor นั้น (ตัวเลขหัว-ท้ายแถบ)
  - ลากหัวจับสีขาวระหว่างแถบสี ดูตัวเลข pill ใต้แถบเปลี่ยนตามทันที
  - ถ้ามี sensor ที่ค่าคงที่ตลอดทั้งชุดข้อมูล ลองเลือกเป็น criteria sensor — ดูข้อความ "… has a constant value (…) — cannot partition."
  - **(แก้บั๊ก 2026-09-30)** ที่โมเดล Clustering ที่สร้างจาก Dashboard ใหม่ (ยังไม่เคยเลือก criteria sensor) — เลือก criteria sensor ที่ค่าจริงไม่ได้อยู่แถว 0-100 (เช่น sensor ที่ค่าจริง 500-900) แล้วกด + ให้ Clusters เป็น 2-3 (โมเดลใหม่เริ่มที่ 1 cluster) — ต้องเห็นแถบแบ่งเท่าๆ กันเต็มช่วง 500-900 ทันทีที่โหลดเสร็จ (ไม่ใช่ค้างอยู่ที่ 0-100 เดิม) แล้วกด "Save changes" — เปิดโมเดลใหม่อีกครั้งดูว่าค่ายังอยู่ในช่วง 500-900 จริง
  - **(แก้บั๊ก 2026-10-09)** ที่โมเดลซึ่งมี criteria sensor A และ 2+ cluster อยู่แล้ว (แถบสีขึ้นตามช่วงของ A) — เปลี่ยน criteria เป็น sensor B ที่ช่วงค่าต่างจาก A มาก (เช่น A 0-10, B 500-900) — ต้องเห็น "Loading…" สั้นๆ แล้วแถบสีแบ่งเท่าๆ กันเต็มช่วงของ **B** (ไม่ใช่ตัวเลขช่วงของ A ค้างอยู่) แล้วกด Save changes เปิดโมเดลใหม่ ค่ายังอยู่ในช่วงของ B
  - **(แก้บั๊ก 2026-09-30)** กดปุ่ม +/− จำนวน cluster (เช่น 3 → 4) ที่โมเดลซึ่งมี criteria sensor แล้ว — ต้องเห็นแถบสีขึ้นเป็น 4 ช่วงทันที (ไม่ใช่ยังเป็น 3 ช่วงเดิม) ก่อนกด Train
  - **(แก้บั๊ก 2026-10-09)** ระหว่างที่ยังขึ้น "Loading … range…" หลังเปลี่ยน criteria sensor หรือกด +/− (จำนวน cluster 2 ขึ้นไป) — ลองกด "Save changes" และ "▶ Train sensor" ทันที — **คาดหวัง:** ทั้งสองปุ่มกดไม่ได้ (รายการ "to fix" ขึ้น "Fill in the cluster ranges") จนกว่าแถบสีจะขึ้น แล้วปุ่มกลับมากดได้เอง — กด Save แล้วเปิดโมเดลใหม่ ค่าอยู่ในช่วงจริงของ sensor (ไม่ใช่ 0-100) · โมเดล 1 cluster และโมเดลที่ไม่ได้เปลี่ยน criteria/จำนวน cluster ไม่ถูกล็อกระหว่างโหลด
  - สลับไปดูโมเดล Clustering อีกตัวระหว่างที่อีกตัวยังโหลด stats ไม่เสร็จ (เช่น สลับสลับไปมาเร็วๆ) — **คาดหวัง:** เห็น "Loading…" ของโมเดลที่เพิ่งเลือกเสมอ ไม่ใช่เห็นแถบของโมเดลก่อนหน้าค้างอยู่
  - **คาดหวัง:** ช่องนี้แสดงเสมอ (ไม่ซ่อนอีกต่อไป) — ลากหัวจับได้จริง ห้ามลากข้ามหัวจับข้างเคียง — ขอบเขต [ต่ำสุด, สูงสุด] คำนวณจาก training scope ของโมเดลนั้นจริง (Workspace หรือ Custom ของโมเดล — ช่วงเดียวกับตอนกด Train ไม่ใช่ทั้งชุดข้อมูลดิบ) — เลือก criteria sensor ใหม่หรือเปลี่ยนจำนวน cluster ต้องแบ่งช่วงใหม่ให้เท่ากันอัตโนมัติเสมอ (ไม่ค้างที่ค่าเดิม/ค่า 0-100) — สลับโมเดลระหว่างที่ stats ยังโหลดไม่เสร็จต้องไม่เห็นแถบของโมเดลอื่นค้างอยู่

- [ ] **BMW-119 — โมเดล Clustering ที่สร้างใหม่เริ่มที่ 1 cluster (ไม่ใช่ 3) จึงไม่มีรายการ "to fix" ตั้งแต่ยังไม่ได้แตะ** 👀
  - ที่ Dashboard ติ๊ก "C" (Clustering) ให้ sensor ที่ยังไม่มีโมเดล Clustering แล้วเปิด Build Model เลือก sensor นั้น กาง Model settings
  - ดูตัวเลข Clusters, ช่อง Cluster ranges, ป้าย "N to fix" และปุ่ม Train sensor (เลือก Y sensor ก่อนถ้ายังว่าง)
  - เลือก Criteria sensor ที่ค่าจริงไม่ได้อยู่แถว 0-100 (เช่น 500-900) **โดยยังไม่กด +** แล้วกด Save changes → ปิดเปิด Build Model ดูโมเดลเดิม แล้วกด Train sensor
  - กด + ให้ Clusters เป็น 2 และ 3
  - **คาดหวัง:** โมเดลใหม่เขียน Clusters = 1 และ Cluster ranges ขึ้น "One cluster — every row goes in. No ranges to set." · ไม่มีรายการ "Pick a criteria sensor for 2+ clusters (or set Clusters to 1)" และไม่มีป้าย "to fix" จากเรื่องนี้ (Train sensor กดได้เมื่อเลือก Y แล้ว) · เลือก criteria แล้วยังเป็น 1 cluster ได้ — Train แล้วจุดข้อมูลครอบคลุมช่วงจริงของ criteria sensor (ไม่ถูกตัดเหลือเฉพาะแถวที่ criteria อยู่ใน 0-100) · กด + แล้วแถบสีแบ่งเท่าๆ กันเต็มช่วงจริงของ criteria sensor (500-900 ไม่ใช่ 0-100) · โมเดล Clustering เดิมที่บันทึกไว้ก่อนหน้า (3 cluster) ไม่เปลี่ยนจำนวนเอง

- [ ] **BMW-96 — Predictor sensors: ชิป + ปุ่มเส้นประ "Add…" เปิดหน้าต่างเลือกหลายตัว (แทน BMW-9)** 🆕
  - เลือก sensor ที่มีโมเดล Relation model กาง Model settings
  - ดูช่อง Predictor sensors ตอนยังไม่มี predictor แล้วกดปุ่ม "Add predictors…"
  - ดูบรรทัด "All sensors except the target · N" ใต้ช่องค้นหา แล้วค้นด้วย tag / description / หน่วย / component
  - เลือก 2-3 ตัว กด OK แล้วกด × บนชิปเพื่อเอาออกทีละตัว
  - **คาดหวัง:** ตอนว่างปุ่ม "Add predictors…" เป็นสีเหลือง (required) · หน้าต่างกว้างราว 520 px จัดกลุ่มตาม Component · target ของโมเดลไม่อยู่ในรายการ และบรรทัด scope บอกเหตุผล · หลัง OK predictor ขึ้นเป็นชิป description + tag และปุ่มเปลี่ยนเป็น "Add…" · × เอาออกได้ทันที · Save/Train ยังกดไม่ได้จนกว่าจะมี predictor อย่างน้อย 1 ตัว

- [ ] **BMW-97 — หน้าต่างเลือก predictor: เลือกได้หลายตัวก่อน OK, พับ/กางกลุ่ม, คีย์บอร์ด, Cancel/Esc/คลิกนอกไม่บันทึก (แทน BMW-13)** 🆕
  - เปิด "Add…" ดูว่ากลุ่มที่มี predictor ที่เลือกไว้กางอยู่ ส่วนกลุ่มอื่นพับ (ถ้า sensor ทั้งหมดไม่เกิน 10 ตัวจะกางทุกกลุ่ม)
  - กดหัวกลุ่มเพื่อกาง/พับ, ใช้ ↓ ↑ เลื่อน → ← กาง/พับกลุ่ม Enter ติ๊ก
  - ติ๊กหลายตัว ดูตัวนับ "N selected" และตัวเลขที่หัวกลุ่ม (เช่น 1 / 5)
  - กด Cancel (หรือ Esc หรือคลิกพื้นหลังมืด) แล้วเปิดใหม่
  - **คาดหวัง:** ติ๊กสะสมได้หลายตัวก่อนกด OK · พิมพ์ค้นหาแล้วกลุ่มที่มีผลลัพธ์กางเอง · Tab วนอยู่ในหน้าต่าง · Cancel/Esc/คลิกพื้นหลัง **ไม่เปลี่ยน predictor ที่เลือกไว้เลย**

- [ ] **BMW-116 — Clustering: X เป็นแบบล็อก, Y และ Criteria เป็นตัวเลือกแบบ popover เลือกได้ตัวเดียว, Criteria ล้างค่าได้ด้วย None หรือปุ่ม × (แทน BMW-98 — ล้างค่าไม่ได้ แก้ 2026-10-09)** 👀
  - เลือก sensor ที่มีโมเดล Clustering กาง Model settings
  - ดูช่อง X sensor (ล็อก), "Y sensor (target)" ตอนว่าง และ "Criteria sensor (optional)"
  - กดช่อง Y เลือก 1 ตัว, กดช่อง Criteria แล้วเลือก sensor (ตั้ง Clusters เป็น 3)
  - กดปุ่ม × เล็กๆ ในช่อง Criteria (ข้างลูกศร ▾) — จากนั้นเลือก sensor อีกครั้ง แล้วล้างด้วยการเปิดรายการและเลือกแถว "None" แทน
  - กด Save changes แล้วปิดเปิดโปรแกรม เปิดโมเดลเดิม (ลองกับโมเดลที่ Train แล้ว/Complete แล้วด้วย)
  - ที่ Dashboard แท็บ Highlights ช่อง "Colour by…" (เลือก sensor ไว้) — ดูว่ามีปุ่ม × แบบเดียวกัน กดแล้วกลับเป็น "Colour by…"
  - **คาดหวัง:** ช่อง X แสดง description + tag พร้อมไอคอนกุญแจ · Y ตอนว่างกรอบเส้นประสีเหลือง · ทั้งสองเปิดเป็น popover ใต้ช่อง ค้นหา+จัดกลุ่มตาม Component — กดเลือกแล้วปิดทันที ไม่มีปุ่ม OK · Criteria มีแถว "None" (ตัวหนังสือเทาปกติ ไม่เอียง) · ปุ่ม × มีเฉพาะตอนช่อง Criteria มีค่า (Y ไม่มี × และไม่มีแถว None) · ล้างแล้ว (ทั้ง × และ None) ช่องเขียนว่า None สีเทา, Clusters ลดเหลือ 1 เองและ Cluster ranges ขึ้น "One cluster — every row goes in. No ranges to set." (ไม่มี criteria sensor แบ่งได้แค่ 1 cluster) · ส่วน Model settings ยังกางอยู่ ไม่หุบเอง · หลัง Save + ปิดเปิด ค่ายังเป็น None / 1 cluster · โมเดลที่ Train แล้วกลายเป็นต้อง Re-train (Incomplete) · ชื่อหัวช่องไม่มีคำต่อท้าย "· Relation model" / "· Clustering"

- [ ] **BMW-99 — ชื่อ sensor ใน Build Model เป็นแบบมาตรฐาน: ลิสต์ซ้าย, หัว detail, บรรทัด Running condition, แถวเงื่อนไข Running condition** 🆕
  - ดูแถวในลิสต์ซ้าย และหัว detail ของ sensor ที่เลือก
  - ค้นหาในลิสต์ซ้ายด้วยหน่วยหรือชื่อ component
  - กด Details ที่บรรทัด Running condition แล้วดูชิปเงื่อนไข (ลองค่า 4000)
  - เปิด popup Running condition ดูแถวเงื่อนไข แล้วย่อหน้าต่างให้แคบ
  - **คาดหวัง:** ลิสต์ซ้ายเป็น 2 บรรทัด (description + หน่วย / tag) · หัว detail ตัวใหญ่ มี tag และชิป component ต่อท้าย (ชิปกลุ่ม FG อยู่บรรทัดถัดไป) · ชิปเงื่อนไขเป็น description + tag แล้วตามด้วยเงื่อนไขตัว mono เช่น `> 4,000 kW` · แถวเงื่อนไขใน popup มีช่องเลือก sensor แบบ popover (ไม่มีชิป component ในแถวแล้ว — component เห็นในรายการของตัวเลือก; ดู BMW-170) · ค้นหาเจอด้วยหน่วย/component

- [ ] **BMW-170 — popup Running condition (ออกแบบใหม่): คอลัมน์เดียว กว้าง ~980 px — timeline บนสุด แล้ว 3 หัวข้อ (Train periods · Scoring periods · When the plant is running); แถวเงื่อนไขบรรทัดเดียว (แทน BMW-52)** 🆕
  - เปิด popup ด้วยปุ่ม "Edit" (หรือ "Set running condition →") ดูโครงทั้งหน้า: หัว popup, แถบ timeline, หัวข้อทั้ง 3
  - ที่หัวข้อ "When the plant is running" ดูตัวเลือก 2 อันในแถวเดียว "Only when running · keep rows that meet a condition" | "Use all rows · idle and shutdown time included" — คลิก "Use all rows" แล้วคลิกกลับ · ลองใช้ปุ่มลูกศรซ้าย/ขวาตอนโฟกัสอยู่ที่ตัวเลือก
  - กด "Add condition" 2 ครั้ง — ดูแถวเงื่อนไข: ช่อง sensor, ปุ่ม `>` `<` `↔` `=`, ช่องค่าพร้อมหน่วย, ปุ่ม ✕ — กดช่อง sensor เลือก sensor ที่ชื่อยาวมาก — กด `↔` ดูช่อง min / max
  - ดูระหว่างแถวที่ 1 กับ 2: ปุ่มเม็ดยา "AND" — กดแล้วเป็น "OR" และคำอธิบายเปลี่ยน — ลบแถวที่ 2 แล้วปุ่มหาย
  - ย่อหน้าต่าง Build Model ให้แคบลงแล้วดูแถวช่วงเวลาและแถวเงื่อนไข
  - **คาดหวัง:** หัว popup "Running condition" + "Default for every model · a model can use its own on its settings (Custom)" + ป้ายสถานะขวาบน (Required เหลือง / "N conditions" ฟ้า / "No condition" เทา / "Fix period" แดง) · **ไม่มีคอลัมน์ขวา "Data used for training" แล้ว** ไม่มีเลขขั้น 1/2 ไม่มีกล่องคำอธิบายสีฟ้า/เหลือง — แต่ละหัวข้อมีแค่**ชื่อ + ประโยคเดียว**ในบรรทัดเดียว · ตัวเลือก 2 อันเป็นแถวเดียว (อันที่เลือกมีพื้นฟ้า + จุดกลม) — "Use all rows" ซ่อนแถวเงื่อนไข ขึ้นบรรทัดเทาบอกว่าทุกแถวในช่วง Train ถูกใช้ และ**เงื่อนไขที่ตั้งไว้ไม่หาย** · แถวเงื่อนไขเป็น**บรรทัดเดียว** `[sensor] [> < ↔ =] [ค่า หน่วย] [✕]` **ไม่มีป้าย component ในแถว** ช่อง sensor กว้างไม่เกิน ~360 px (ชื่อยาวถูกตัดด้วย …) และช่องค่า**ไม่ถูกบีบจนอ่านไม่ได้** · ปุ่ม AND/OR มี "both must be true" / "either one is enough" และมีเฉพาะเมื่อ ≥ 2 แถว · ยังไม่ตั้งเงื่อนไข = บรรทัดเหลือง "Choose “Only when running” with a condition, or “Use all rows”, before training a model." · หน้าต่างแคบ: ไม่มีอะไรล้นกรอบหรือทับกัน · ทุกการแก้เป็นแบบร่างจนกด Apply (ดู BMW-172)

- [ ] **BMW-183 — timeline + บรรทัดสรุปใต้ timeline + "N d running" ของแต่ละช่วง — ตามค่าที่กำลังแก้ทันที รวมถึงวันที่ที่เพิ่งพิมพ์ (แทน BMW-171)** 🆕
  - เปิด popup ใน workspace ที่มี Train period 2 ช่วง + Scoring period 1–2 ช่วง + เงื่อนไข 1 แถว — ดูแถบ timeline: แกนเดือน, เลน **Train** (บล็อกฟ้า P1 P2), เลน **Score** (บล็อกชมพูเส้นประ S1 S2) และบรรทัดสรุปข้างใต้
  - ดูท้ายแต่ละแถวช่วงเวลา (เช่น "81 d · 69 d running")
  - แก้ค่าเงื่อนไขทีละตัวอักษร (เช่น 5 → 9) — ดูว่าตัวเลขเปลี่ยนเมื่อหยุดพิมพ์ครู่หนึ่ง และระหว่างรอ**ตัวเลขเดิมยังอยู่แต่จางลง** (ไม่กระพริบเป็นว่าง) — ดูบรรทัด Running condition ด้านหลัง popup
  - คลิกในช่องวันสิ้นสุดของ P1 แล้ว**พิมพ์วันใหม่ทีละตัวเลข โดยยังไม่คลิกออกจากช่อง** — ดู timeline, จำนวนวันท้ายแถว และบรรทัดสรุป · ทำซ้ำด้วยการ**เลือกวันจากปฏิทิน** (ปุ่มรูปปฏิทินในช่อง)
  - เลื่อนวันของ Train period ให้เหลือไม่กี่วัน · ตั้งช่วงหนึ่งให้วันสิ้นสุดก่อนวันเริ่ม · ทำ P1 ให้เป็นปลายเปิด "Start of data"
  - ลบ Train period จนหมด · เลือก "Use all rows"
  - เลือก "Only when running" แล้วเพิ่มเงื่อนไข 1 แถวโดย**ยังไม่กรอกค่า** (ป้ายขวาบนเป็น "Required") — อ่านบรรทัดสรุปและท้ายแถวช่วงเวลา แล้วกรอกค่าให้ครบ
  - ปิด popup แล้วเปิดใหม่ · ลองเปิด popup ตอนที่ workspace มีข้อมูลหลายแสนแถว ดูว่า popup เปิดทันทีไม่ค้าง
  - **คาดหวัง:** บล็อกใน timeline ตรงกับวันที่ของแต่ละแถว (ปลายเปิดยาวถึงขอบข้อมูล) — ช่วงที่ผิดเป็น**สีแดง** · บรรทัดสรุปบรรทัดเดียว เช่น `117 d train (about 100 d running time) · 59 d scoring · 14,391 of 25,880 rows (56%) used for training · ≥ 30 d recommended` · ไม่มี Train period = `no train period · no scoring time · add a train period to count the rows` · มีช่วงผิด = "fix the period to count the rows" · running time น้อยกว่า 30 วัน = "≥ 30 d recommended" เป็น**สีเหลือง** (ชี้เมาส์เห็นประโยคเต็ม) แต่**ไม่บล็อก Apply** · "N d running" ของแต่ละแถวคือเวลาที่เครื่องเดินจริงในช่วงนั้น (≤ จำนวนวันตามปฏิทิน; "Use all rows" = เท่ากับจำนวนวันที่มีข้อมูล) · ตัวเลขทั้งหมดสะท้อน**ค่าที่แก้อยู่** ส่วนบรรทัด Running condition ด้านหลังยังเป็นค่าที่บันทึกไว้จนกด Apply · ถ้านับไม่ได้ขึ้นบรรทัดเทา "Couldn't count the rows right now" แทนตัวเลข และ**ยังแก้ / กด Apply ได้** · **วันที่ที่พิมพ์หรือเลือกจากปฏิทิน: ทันทีที่วันที่ครบ บล็อกใน timeline และจำนวนวันท้ายแถวเปลี่ยนตาม โดยไม่ต้องคลิกออกจากช่อง** (จำนวนแถว / "d running" ตามมาหลังหยุดพิมพ์ครู่หนึ่ง ตัวเลขเดิมจางระหว่างรอ — ไม่นับใหม่ทุกตัวอักษร) · ระหว่างพิมพ์ปี (เช่น 2026 ทีละหลัก) แถว**ไม่กระพริบเป็นสีแดง** · **"Only when running" ที่ยังไม่มีเงื่อนไขครบสักแถว:** บรรทัดสรุปเขียน **"set the condition to count the rows"** (ไม่มี "N of N rows (100%)" และไม่มี "about N d running time") และท้ายแถวช่วงเวลาเหลือแค่จำนวนวันตามปฏิทิน — กรอกค่าครบแล้วตัวเลขจึงขึ้น · พิมพ์วันที่หรือค่าเงื่อนไขลื่นเหมือนเดิม ไม่หน่วง

- [ ] **BMW-55 — Esc ปิด popup Running condition ผ่านการถามก่อนทิ้งเหมือนปุ่ม X (และไม่ปิดซ้อนกับ popup เลือก sensor)** 🆕
  - เปิด popup โดยยังไม่แก้อะไร กด **Esc**
  - เปิดใหม่ แก้ค่าเงื่อนไข แล้วกด Esc — ดูท้าย popup — กด Esc อีกครั้ง — กด "Keep editing"
  - กดช่องเลือก sensor ของแถวหนึ่งให้ popup "Select sensor" เปิด แล้วกด Esc
  - กด Esc อีกครั้ง (ตอนที่ยังแก้ค้างอยู่)
  - **คาดหวัง:** ตอนยังไม่แก้ Esc ปิด popup ทันที · ตอนแก้ค้างอยู่ Esc ขึ้นแถวถาม "Discard your unapplied changes?" (popup ไม่ปิด และไม่มีอะไรถูกบันทึก) Esc ซ้ำไม่ทิ้งเงียบ ๆ — "Keep editing" กลับมาเห็นค่าที่แก้ · Esc ตอน popup "Select sensor" เปิดอยู่ปิดเฉพาะ popup เลือก sensor (popup Running condition ยังอยู่ ไม่มีข้อความถาม) ส่วน Esc ครั้งถัดไปจึงเป็นของ popup Running condition (ขึ้นแถวถามถ้ายังแก้ค้างอยู่) · ผลลัพธ์ต้องเหมือนกดปุ่ม X ทุกประการ

- [ ] **BMW-172 — popup Running condition: แก้เป็นแบบร่าง ต้องกด Apply ค่าจึงมีผล; ช่วงผิด / ไม่มี Train period = Apply กดไม่ได้พร้อมบรรทัดบอกเหตุผล (แทน BMW-50)** 🆕
  - เปิด workspace ที่ตั้ง Running condition ไว้แล้ว (2 เงื่อนไข + Train period 1 ช่วง) กด "Edit" — ดูท้าย popup: ปุ่ม **Apply** (จาง กดไม่ได้), ปุ่ม **Cancel**, ยังไม่มีข้อความใด ๆ
  - แก้ค่าเงื่อนไข (เช่น 5 → 9) — Apply ต้องกดได้ และทางขวามี**บรรทัดบอกผลกระทบ** (ดู BMW-173) — **บรรทัด Running condition ด้านหลังยังเป็นค่าเดิม**
  - แก้ค่ากลับเป็น 5 — Apply จางกลับ และบรรทัดทางขวาหาย
  - แก้เป็น 9 แล้วกด **Cancel** → เปิดใหม่ต้องเห็น 5 → ทำซ้ำแต่กดปุ่ม X: ต้องขึ้น "Discard your unapplied changes?" พร้อม **Discard** / **Keep editing** — คลิกพื้นหลังนอกกรอบตอนแก้ค้างอยู่ต้องถามแบบเดียวกัน
  - แก้เป็น 9 แล้วกด **Apply** → popup ปิดเอง บรรทัด Running condition เปลี่ยนเป็น 9 ทันที → ปิดเปิดโปรแกรม เปิด popup ต้องเห็น 9
  - ตั้ง Train period ที่ 2 ให้วันสิ้นสุด**ก่อน**วันเริ่ม — ดูแถวนั้นและท้าย popup · แก้ให้ถูก · จากนั้นลบ Train period จนหมด
  - **คาดหวัง:** ระหว่างแก้ไม่มีอะไรถูกบันทึกจนกด Apply — Apply บันทึกครั้งเดียวทั้งหมดแล้วปิด popup · ช่วงผิด: แถวมี**ขอบแดงบาง ๆ ทางซ้าย** ช่องวันที่ที่ผิดเป็นสีแดง และมีบรรทัดเหตุผล**บรรทัดเดียว** เช่น "P2 ends before it starts — pick an end after 2026/05/11 00:00" (เรียก **P2** เสมอ ไม่ใช่ "Period 2") · Apply กดไม่ได้ และข้าง Cancel ขึ้นบรรทัดแดง **"Fix P2 before applying"** (Scoring period ผิด = "Fix S1 before applying") · ไม่มี Train period: บรรทัดเหลือง "No train period yet — add at least one" ในหัวข้อ Train periods, Apply กดไม่ได้ ข้าง Cancel ขึ้น "Add a train period" · ไม่มีข้อความ "Changes not applied yet" แล้ว · แผง Custom ของโมเดลแต่ละตัวไม่เปลี่ยน (บันทึกด้วย Save changes ตามเดิม)

- [ ] **BMW-184 — คำเตือนผลกระทบ: ขึ้นก่อนกด Apply เสมอ (แม้แก้แค่วันที่โดยยังไม่คลิกออกจากช่อง) และหลัง Apply (บรรทัดใต้ Running condition) (แทน BMW-173)** 🆕
  - เตรียม workspace ที่มีโมเดล Workspace mode ที่ **Train แล้ว** 1 ตัว, **Complete** 1 ตัว, โมเดล **Custom** ที่ Complete 1 ตัว และโมเดลที่ยังไม่เคย Train 1 ตัว
  - เปิด popup แล้วแก้**ค่าเงื่อนไข** — อ่านบรรทัดข้างปุ่ม Apply
  - แก้กลับ แล้ว**พิมพ์วันสิ้นสุดใหม่ของ Train period P1 โดยไม่คลิกออกจากช่อง** — ดูปุ่ม Apply และบรรทัดข้างปุ่ม **ก่อน**กด แล้วจึงกด Apply ครั้งเดียว
  - เปิด popup ใหม่ คลิกส่วน "วัน" ของวันที่ช่องหนึ่งแล้วกด Backspace ให้ส่วนนั้นว่าง (ยังไม่คลิกออก) — อ่านบรรทัดข้างปุ่ม Apply และดูปุ่ม Apply — พิมพ์วันให้ครบ
  - แก้ค่าเงื่อนไขก่อน แล้วทำให้วันที่ช่องหนึ่งว่างบางส่วนแบบข้อก่อนหน้า — อ่านบรรทัดข้างปุ่ม Apply แล้วกด Apply
  - แก้กลับ แล้วเพิ่ม/แก้เฉพาะ **Scoring period** — อ่านบรรทัดเดิม
  - แก้ทั้งเงื่อนไขและ Scoring period พร้อมกัน
  - (workspace ที่ยังไม่มีโมเดลไหน Train) แก้เงื่อนไขแล้วอ่านบรรทัดเดิม
  - กลับไปกรณีแก้เงื่อนไข กด **Apply** — ดูใต้บรรทัด Running condition และจุดสีในลิสต์ซ้าย — กด Train sensor ของโมเดลตัวแรก แล้วตัวที่สอง — ปิดเปิดหน้าต่าง Build Model
  - แก้เฉพาะ Scoring period แล้ว Apply — ดูใต้บรรทัด Running condition
  - **คาดหวัง:** **Apply กดได้เมื่อไร บรรทัดผลกระทบต้องอยู่บนจอแล้วเสมอ** — พิมพ์วันที่ครบแล้ว (ยังไม่คลิกออก) บรรทัดผลกระทบ + timeline เปลี่ยนทันที แล้วการกด Apply ครั้งเดียวบันทึกตามที่บรรทัดบอก (ไม่มีกรณี "กด Apply แล้วโมเดล Complete กลับเป็น Incomplete โดยไม่เคยเห็นคำเตือน") · วันที่พิมพ์ไม่ครบ = บรรทัด**เทา** **"Finish the date in P1 to see what this changes"** (Scoring = "…in S1…") และ**ไม่ทำให้ Apply กดได้** — พิมพ์ครบแล้วบรรทัดเทาหาย บรรทัดผลกระทบขึ้นแทน · มีอย่างอื่นรอ Apply อยู่ด้วย = บรรทัดผลกระทบยังอยู่ และมีบรรทัดเทา "Finish the date in P1…" ต่อท้าย — กด Apply แล้วค่าที่บันทึกคือเงื่อนไขที่แก้ **วันที่ที่พิมพ์ไม่ครบไม่ถูกบันทึก** (วันเดิมยังอยู่) · แก้เงื่อนไข/Train period = บรรทัด**เหลือง** "Applying sets 2 models back to Incomplete — they need training again" (นับเฉพาะโมเดล Workspace mode ที่ Train แล้วหรือ Complete — **ไม่นับโมเดล Custom และโมเดลที่ยังไม่ Train**; 1 ตัว = "1 model … it needs") · แก้เฉพาะ Scoring = "1 complete model will need Mark complete again (re-score, no training)" · แก้ทั้งสองอย่าง = บรรทัดแรก + บรรทัดเทาเล็ก "The new scoring periods are scored when they are trained again" · ไม่มีใครกระทบ = บรรทัด**เทา** "No trained or complete model is affected by this change" · **Apply ยังกดได้ทุกกรณี** (เป็นคำเตือน ไม่ใช่การบล็อก) · หลัง Apply: ใต้บรรทัด Running condition ขึ้น "Running condition changed — 2 models need training again. Use Train all, or Train sensor on each one; the amber dots in the list show which." โมเดลเหล่านั้นกลับเป็น Incomplete จุดเหลือง (โมเดล Custom ยัง Complete) — Train ตัวแรกแล้วตัวเลขลดเป็น "1 model needs training again…" — Train ครบแล้ว**ข้อความหายเอง** · ข้อความนี้อยู่เฉพาะรอบที่เปิดหน้าต่าง (ปิดเปิดแล้วไม่มี แต่จุดเหลืองยังอยู่) · แก้เฉพาะ Scoring แล้ว Apply = "Scoring periods changed — N complete models need Mark complete again. They were re-scored with the same trained model, not re-trained." (ไม่มีประโยค "It was not re-trained." ซ้ำท้าย)

- [ ] **BMW-174 — popup Running condition ใช้คีย์บอร์ด: เปิดแล้วโฟกัสอยู่ช่องแรก, Tab วนอยู่ใน popup** 🆕
  - กด "Edit" เปิด popup แล้ว**ยังไม่คลิกอะไร** พิมพ์/กดลูกศรดูว่าโฟกัสอยู่ที่ไหน
  - กด Tab ไปเรื่อย ๆ จนผ่านปุ่มสุดท้ายท้าย popup · กด Shift+Tab ย้อนจากปุ่มแรก
  - กดช่องเลือก sensor ให้รายการเปิด แล้วกด Tab / พิมพ์ค้นหา
  - กด Esc ปิด popup (ตอนยังไม่แก้อะไร)
  - **คาดหวัง:** เปิดมาโฟกัสอยู่ที่**ช่องแรกของเนื้อหา** (วันเริ่มของ P1 หรือปุ่ม "Add train period" ถ้ายังไม่มีช่วง) ไม่ใช่ปุ่ม X · Tab จากปุ่มสุดท้ายวนกลับปุ่มแรกของ popup (ไม่หลุดไปที่ลิสต์ sensor หรือปุ่มด้านหลัง) Shift+Tab วนกลับทางเดียวกัน · ตอนรายการเลือก sensor เปิดอยู่ ช่องค้นหาและรายการใช้งานได้ปกติ · Esc ปิด popup (ถามก่อนถ้าแก้ค้าง — ดู BMW-55) แล้วโฟกัสกลับไปที่ปุ่ม "Edit" ที่ใช้เปิด

- [ ] **BMW-36 — ลิสต์ซ้าย: ช่องค้นหา + filter chip (All / Needs setup / Complete)** 🆕
  - พิมพ์ในช่องค้นหา ด้วยคำใน description และด้วย tag
  - กด chip "Needs setup" (sensor ที่มีโมเดลติด gate หรือฟิลด์ไม่ครบ) แล้วกด "Complete" (sensor ที่ทุกโมเดลเป็น Complete) แล้วกลับมา "All"
  - **คาดหวัง:** ค้นหากรองด้วยทั้ง description และ tag ได้ — แต่ละ chip มีตัวเลขนับกำกับ และกรองลิสต์ตามจริง — chip ที่กำลังเลือกอยู่เน้นสี — **ยังไม่มี chip "To train"/"Trained" ในเฟสนี้** (มากับ Phase B — อย่ารายงานว่าขาด)

- [ ] **BMW-37 — Group by: Failure group | Component (ตัด Model Type ออกแล้ว)** 🆕
  - สลับปุ่ม "Group by" ระหว่าง "Failure group" และ "Component" เหนือลิสต์ซ้าย
  - **คาดหวัง:** มีแค่ 2 ตัวเลือกนี้เท่านั้น — **ไม่มีตัวเลือก "Model Type" อีกต่อไป** — สลับไป Component แล้ว sensor ที่ไม่มี target sensor ต้องอยู่ใต้หัวข้อ "Uncategorized" — เลือก sensor จากมุมมองไหนก็ได้ detail pane เดียวกัน (ไม่ scope ตามมุมมอง)

- [ ] **BMW-30 — status pill เป็นข้อความอ่านอย่างเดียว การสลับ Complete/Incomplete ย้ายไปปุ่มใน footer** 🆕
  - ดูป้ายสถานะที่ footer ของแต่ละแท็บ (I/R/C)
  - ทำให้โมเดลหนึ่ง Complete ผ่านหน้า "Health score" (ดู BMW-158) แล้วสลับแท็บไปโมเดลอื่นของ sensor เดียวกัน
  - **คาดหวัง:** ป้ายสถานะไม่ใช่ปุ่มกดสลับได้เองแล้ว (ดู BMW-132) — สลับ Complete ⇄ Incomplete เฉพาะโมเดลของแท็บนั้น (ชนิดอื่นของ sensor เดียวกันไม่เปลี่ยน) และค่าอยู่ต่อหลังปิดเปิดโปรแกรม (การตั้งเป็น Complete ทำได้ทางเดียวคือ "✓ Mark complete" ที่หน้า Health score — ดู BMW-158 และ BMW-84)

- [ ] **BMW-31 — หนึ่งแถวต่อ sensor ต่อ Failure Group ในลิสต์ซ้าย (แทนการ์ด accordion เดิม)** 🆕
  - ให้ sensor ตัวเดียวมี Individual + Relation model + Clustering ในกลุ่มเดียวกัน
  - ดูลิสต์ซ้าย (Group by Failure Group)
  - เพิ่ม/ลบชนิดโมเดลที่ Dashboard แล้วดูแถวอีกครั้ง
  - ให้ sensor เดียวกันอยู่ 2 กลุ่ม โดยกลุ่มหนึ่งมีแค่ Individual
  - **คาดหวัง:** ขึ้นแถวเดียวต่อ sensor ต่อกลุ่ม ในหัวข้อกลุ่มของตัวเอง — แถวมีคำอธิบาย sensor บรรทัดเดียวตัดด้วย … tag ตัวอักษร mono ใต้ชื่อ และชิปตัวอักษรชนิด I/R/C **เฉพาะชนิดที่มีจริง** (จุดสีสถานะที่มุมชิป — ดู BMW-132) — คลิกแถวเพื่อเลือกเข้า detail pane — **Clustering จัดเข้าแถวตาม X sensor** (เปลี่ยน Y แล้วแถวไม่ย้าย) — การสร้าง/ลบโมเดลยังทำได้ที่ Dashboard เท่านั้น (ไม่มีปุ่ม Add model ที่นี่)

- [ ] **BMW-32 — Category ตั้งครั้งเดียวที่หัว detail pane: บันทึกทันที มีผลกับทุกโมเดลของ sensor นั้นทุกกลุ่ม + เตือนถ้ากระทบกลุ่มอื่น** 🆕
  - เลือก sensor จากลิสต์ซ้าย กด Performance หรือ Condition ที่มุมขวาของหัว detail pane
  - ให้ sensor นั้นอยู่หลายกลุ่ม แล้วกดเปลี่ยน Category
  - เลือก sensor เดียวกันจากแถวของอีกกลุ่ม (Group by Failure Group) หรือจากมุมมอง Component
  - **คาดหวัง:** บันทึกทันทีโดยไม่มีปุ่ม Save และโมเดลทุกชนิดของ sensor นั้นทุกกลุ่มเปลี่ยนตาม — sensor ที่อยู่หลายกลุ่มขึ้นข้อความเตือนว่า Category นี้ใช้กับทุกกลุ่มไหนบ้าง — **ไม่มีสถานะ "Mixed" ที่ใดเลย** — ยังไม่เลือก Category กรอบตัวเลือกเรืองสีเหลืองพร้อมป้าย "Set category" (Performance เป็นสีเขียว, Condition สีม่วงเมื่อเลือกแล้ว) — เลือก sensor เดียวกันจากมุมมอง/กลุ่มไหนก็เห็น Category เดียวกันเสมอที่หัว detail pane (ไม่มีชิปอ่านอย่างเดียวแยกอีกต่อไป เพราะหัว pane ควบคุมได้โดยตรงไม่ว่าจะมาจากมุมมองไหน)

- [ ] **BMW-21 — แจ้งเตือนครั้งเดียวเมื่อระบบปรับ Category ของ workspace เก่าให้ตรงกัน**
  - ใช้ workspace เก่าที่ sensor เดียวกันมีโมเดลคนละ Category เปิด Build Model
  - ดูแถบเหลืองเหนือลิสต์ซ้าย/detail pane
  - กด Dismiss แล้วปิดเปิดโปรแกรม เปิด Build Model ใหม่
  - **คาดหวัง:** ขึ้นแถบเหลือง "Category made consistent for N sensor(s)" ลิสต์ต่อ sensor บอกว่าใช้ Category ของโมเดลชนิดไหน และค่าใหม่ถูกบันทึกลงไฟล์ตั้งแต่เปิดครั้งแรก — กด Dismiss แล้วหายไม่กลับมาอีก — workspace ที่ Category ตรงกันอยู่แล้วไม่ขึ้นแถบนี้

- [ ] **BMW-22 — โมเดลใหม่ที่สร้างจาก Dashboard สืบทอด Category ของ sensor**
  - ตั้ง Category ให้ sensor ที่ Build Model
  - ที่ Dashboard แท็บ Sensor เพิ่มโมเดลชนิดอื่นให้ sensor เดียวกัน หรือเพิ่มเข้ากลุ่มอื่น
  - เปิด Build Model ดูแถวนั้น
  - **คาดหวัง:** โมเดลใหม่ใช้ Category เดียวกับ sensor ทันที (ไม่ต้องตั้งใหม่) — sensor ที่ยังไม่เคยตั้ง Category โมเดลใหม่ยังไม่มี Category

- [ ] **BMW-141 — ด่านบังคับ Running Condition: "▶ Train sensor" / "▶ Train all" / หน้า Health score (Mark complete) ถูกล็อกจนกว่าจะตั้ง — บอกที่การ์ด, จุดบนแท็บ และ footer (ไม่มีบรรทัด "N of M models can't be built yet" แล้ว) (แทน BMW-102)** 🆕
  - ใช้ workspace ที่ **ยังไม่ตั้ง** Running Condition และมีโมเดลอย่างน้อย 2 ตัวของ sensor เดียวกัน (Incomplete ทั้งคู่)
  - เลือก sensor นั้นจากลิสต์ซ้าย เอาเมาส์ชี้จุดบนแท็บของแต่ละโมเดล
  - ดูการ์ด Running condition, ปุ่ม "▶ Train sensor" ที่หัว detail pane, ปุ่ม "▶ Train all" เหนือลิสต์ และลองเปิดหน้า "Health score"
  - กดปุ่มบนการ์ดเพื่อเปิด popup ตั้งเงื่อนไขที่กรอกครบ 1 แถว (หรือเลือก "Use all rows") แล้วกด Apply แล้วกลับมาดูซ้ำ
  - **คาดหวัง:** **ไม่มี**บรรทัดเตือน "⚠ N of M models can't be built yet …" แล้ว · การ์ด Running condition เป็นสีเหลือง วงกลม "!" ป้าย **"Not set"** และปุ่มทึบของตัวเอง "Set running condition →" (ปุ่มทึบปุ่มเดียวของจอ) · จุดบนแท็บเป็นแดง tooltip **"Needs condition"** (โมเดล Complete เก่า: เขียว "Legacy · all data"; สาเหตุอื่น: "Needs category" / "Needs train period" / "Fix periods") — **ไม่มีป้ายข้อความบนแท็บ** · "▶ Train sensor" และ "▶ Train all" กดไม่ได้ทั้งคู่ ข้อความเหลืองใต้ปุ่ม **"Set the running condition first."** (ไม่มี "(Step 1)") · footer ของโมเดลบอกเหตุผล · พื้นที่กราฟขึ้น "Set the running condition first" + ลิงก์ "Running condition ↑" · สวิตช์ "Health score" กดไม่ได้ พร้อม tooltip เหตุผล · พอตั้งเงื่อนไขแล้วทุกอย่างปลดล็อก จุดแดงหาย · โมเดลที่ตั้ง Custom ต้องมีเงื่อนไขของตัวเอง (หรือกด No condition ในส่วน Training data: Custom ของโมเดล) ถึงจะผ่าน แม้ workspace จะตั้งแล้ว — Model settings ของโมเดลนั้นกางเองให้แก้

- [ ] **BMW-179 — "▶ Train sensor" ที่หัว detail pane: train ทุกโมเดลของ sensor ที่ต้อง train (I → R → C), เมนู ▾ ที่ทุกแถวมีบรรทัดสถานะ, ปุ่มทึบ "· n of m" เฉพาะตอนมีตัวต้อง train และบรรทัดสั้นใต้ปุ่ม (แทน BMW-142)** 🆕
  - เลือก sensor ที่มีโมเดล 2–3 ชนิดและ**ยังไม่เคย Train เลยสักตัว** → อ่านปุ่ม + บรรทัดใต้ปุ่ม → เปิดเมนู ▾ อ่านทุกแถวและบรรทัดเล็กใต้แต่ละแถว
  - กด "▶ Train sensor" ให้ train เสร็จบางตัว (เช่น ให้ Relation model ไม่มี predictor ไว้ จะได้ถูกข้าม) → เปิดเมนู ▾ อ่านอีกครั้ง
  - ตั้งค่าตัวที่เหลือให้ครบแล้ว Train จนทุกโมเดลของ sensor เคย Train แล้ว → อ่านปุ่ม → เปิดเมนู ▾ อ่านอีกครั้ง แล้วลองกดแต่ละแถว
  - แก้ค่าของโมเดลที่ Train แล้ว (เช่น Stiffness) แล้ว Save → เปิดเมนู ▾ อ่านบรรทัดของโมเดลนั้น
  - เลือก sensor ที่มี**โมเดลเดียว** → เปิดเมนู ▾ ทั้งตอนยังไม่เคย Train และตอน Train แล้ว
  - **คาดหวัง:** **ปุ่ม:** มีโมเดลต้อง train = ปุ่ม**ทึบ** "▶ Train sensor · 1 of 3" (n = จำนวนที่จะ train, m = โมเดลทั้งหมดของ sensor) · ไม่มีตัวไหนต้อง train = ปุ่ม**ขอบจาง** เขียน **"▶ Train sensor" เฉย ๆ ไม่มี "· 0 of m"** (ดู BMW-135) · **บรรทัดใต้ปุ่ม** สั้นบรรทัดเดียว ใช้ชื่อชนิดเต็ม: "Trains Individual + Relation model · ≈ 16 s", "Trains the Relation model · Individual up to date, skipped", "Trains Individual · Relation model can't train, skipped" (เหลือง), "2 models up to date — nothing to train" · train ไม่ได้ทั้งหมด: **"Can't train · see below"** เมื่อโมเดลที่ติดคือแท็บที่เปิดอยู่ (เหตุผลอยู่ในพื้นที่กราฟ / footer) หรือ "Relation model can't train · see its tab" เมื่ออยู่แท็บอื่น — เหตุผลเต็มอยู่ใน tooltip ของปุ่มและ**บอกชื่อค่าที่ขาด**: "Can't train: Relation model — Add at least 1 predictor" (ขาดหลายอย่าง = อย่างแรก + "(+1 more)") — **ไม่มีข้อความ "Fill in the required fields above first" ที่หัว / ในเมนู / ใน Train all** (ข้อความนั้นเหลือแค่ที่ footer ใต้ฟอร์ม Model settings) · กดแล้ว train **ทีละตัว** ตามลำดับ I → R → C ข้ามตัวที่ up to date และตัวที่ตั้งค่าไม่ครบ · **เมนู ▾ ตอนยังไม่เคย Train:** แถวบน "Train all N models" บรรทัดเล็กเป็นเวลารวม เช่น "≈ 16 s" (มีตัว train ไม่ได้ = ต่อท้าย "· 1 can't train, skipped") — **ไม่เขียน "Includes up-to-date ones" เพราะยังไม่มีตัวไหน up to date** · แถวของแต่ละชนิด "Individual only" / **"Relation model only"** / "Clustering only" (ไม่ใช้คำว่า "Relationship" ในเมนู) บรรทัดเล็ก **"Not trained yet · ≈ 1 s"** ("≈ 15 s" เฉพาะ Relation model, Clustering "≈ 2 s") — **ไม่มีคำว่า "Re-train" ที่ใดในเมนู** · **ตอนเคย Train บางตัว:** เฉพาะแถวของตัวที่เคย Train แล้วเปลี่ยนเป็น "Re-train Individual only" บรรทัดเล็ก **"Up to date · trains anyway"** (โมเดล Complete ต่อท้าย "· it becomes Incomplete") และแถวบนยังเป็น "Train all N models" บรรทัดเล็ก "Includes the 1 up to date" · **ตอนทุกตัวเคย Train แล้ว:** แถวบนเป็น "Re-train all N models" และทุกแถวเป็น "Re-train … only" · **บรรทัดเล็กตามสถานะ:** แก้ค่าหลัง Train = **"Settings changed since it was trained · ≈ 15 s"** · run ล่าสุดไม่ผ่าน = **"Failed last run · ≈ 15 s"** · fit ของ Relation model หลุดจากหน่วยความจำ = **"Fit no longer in memory · ≈ 15 s"** · train ไม่ได้ = เหตุผลตรง ๆ เช่น "Add at least 1 predictor" / "No running condition" (แถวนั้นจาง กดไม่ได้) · **sensor ที่มีโมเดลเดียว:** เมนูมี**แถวเดียว** — "Train the Individual model" (Train แล้ว = "Re-train the Individual model"; Relation model = "Train the Relation model") — **ไม่มีแถว "Train all 1 model"** · แถวบน train ทุกตัวรวมตัวที่ up to date (เตือนว่าโมเดลที่ Complete จะกลับเป็น Incomplete และต้อง Mark complete ใหม่) · แถวของแต่ละชนิด train เฉพาะตัวนั้น · หลัง (re-)train โมเดลเป็น Trained/Incomplete เสมอ ต้อง Mark complete ใหม่ · ไม่มีคำว่า LinearGAM

- [ ] **BMW-180 — "▶ Train all" เหนือลิสต์ซ้าย + หน้าต่าง pre-flight จัดกลุ่มตาม Failure group: "Ready" / "Skipped" + เหตุผลบรรทัดที่สอง / "Skipped — up to date" (แทน BMW-105)** 🆕
  - ใช้ workspace ที่มีหลาย sensor หลาย Failure group: มีตัวพร้อม train, ตัว up to date, ตัว Complete, ตัวตั้งค่าไม่ครบ และ sensor ที่อยู่ 2 กลุ่ม
  - ดูบรรทัดใต้ "▶ Train all" แล้วกดปุ่ม
  - ติ๊ก "Also re-train the N up-to-date models" แล้วเอาออก · กด "Fix →" ของตัวที่ train ไม่ได้ · เปิดใหม่แล้วกด "▶ Start · N"
  - **คาดหวัง:** ใต้ปุ่มเขียนจำนวน "N ready · N up to date · N can't train" · pre-flight แบ่งตาม FG-n (และ Not in Group) โมเดลที่อยู่ 2 กลุ่มขึ้นครั้งเดียว · สถานะของแต่ละแถว: **"Ready"** / **"Skipped — up to date"** สีเทา (โมเดล Complete: "Skipped — Complete, up to date") / **"Skipped"** สีเหลือง พร้อม "Fix →" และ**เหตุผลยาวอยู่บรรทัดที่สองใต้แถว** บอกชื่อค่าที่ขาด เช่น "Add at least 1 predictor", "Model name is required (+1 more)", "No running condition" (ไม่มี "Can't train — …" ต่อท้ายสถานะ และไม่มี "Fill in the required fields above first") · **บรรทัดสรุปบนสุดไม่แสดงจำนวนที่เป็น 0**: เช่น "4 will train · ≈ 19 s · 1 can't train — fix, then run again" (ไม่มี "0 up to date, skipped") · บรรทัดล่างซ้าย: "Trains 3 models; the 2 that can't train stay as they are" (ตัวเดียว = "the 1 that can't train stays as it is"; ไม่มีตัว train ไม่ได้ = "Trains 3 models") · "Fix →" พาไปเปิด Model settings ของโมเดลนั้น (หรือ popup Running condition / ตัวเลือก Category แล้วแต่เหตุผล) · ติ๊ก checkbox แล้วจำนวนบนปุ่ม Start เพิ่ม และมีข้อความเหลืองว่ากี่โมเดลที่ Complete จะกลับเป็น Incomplete · ตัวที่ train ไม่ได้ **ไม่ขวาง** การ run (แค่ถูกข้าม) · Start กดไม่ได้เฉพาะตอนไม่มีตัวไหนพร้อมเลย · กด Start แล้วหน้าต่างเปลี่ยนเป็นรายละเอียดของ run (กด Hide ได้ งานยังเดินต่อ)

- [ ] **BMW-106 — แถบ run ใต้บรรทัด Running condition + ป้ายในลิสต์ + Cancel หยุดหลังโมเดลที่กำลัง train** 🐍
  - เริ่ม Train all ที่มี Relation model อย่างน้อย 2 ตัว (ตัวละ ~15 วินาที)
  - ระหว่างรอดูแถบใต้บรรทัด Running condition และป้าย I/R/C ในลิสต์ซ้าย · เอาเมาส์ชี้แต่ละช่องของแถบ segment
  - กด Details · กด Cancel ระหว่างตัวที่ 2
  - ทำอีกรอบโดยให้ตัวหนึ่ง train ไม่ผ่าน (เช่น predictor ที่ข้อมูลว่าง) แล้วดูผล
  - **คาดหวัง:** แถบขึ้น "Training i of n", sensor + ชนิดที่กำลัง train, "≈ … left", แถบ segment (เขียว = เสร็จ, แดง = ไม่ผ่าน, ฟ้ากระพริบ = กำลังทำ) แต่ละช่องมี tooltip ชื่อโมเดล · ป้ายในลิสต์: **วงเส้นประ = รอคิว, หมุน = กำลัง train** · ทั้งสองปุ่ม Train กดไม่ได้ระหว่าง run ("▶ Train all" เป็น "Training…"; "▶ Train sensor" เป็น "Training…" เฉพาะ sensor ที่กำลัง train — sensor อื่นยังขึ้น "▶ Train sensor · n of m" แต่กดไม่ได้) · Cancel แล้วแถบเขียน "Stopping after this model…" — **ตัวที่กำลัง train ไม่ถูกตัดกลางทาง** ตัวที่เสร็จแล้วเก็บไว้ ผล "Stopped · n trained · k not started" พร้อมปุ่ม "▶ Train the k not started" · ตัวที่ไม่ผ่านไม่หยุดคิว ผลเป็น "Done · n trained · 1 failed · s skipped" สี**เหลือง** (แดงเฉพาะตอนไม่มีตัวไหนผ่านเลย) และในรายละเอียดมีข้อความ error + "Try again" · train ครบทุกตัวเป็นสีเขียว บอกให้ไปตั้ง set points แล้ว Mark complete · Dismiss ซ่อนแถบ

- [ ] **BMW-107 — โมเดลที่อยู่ในคิวถูกล็อก + "Remove from run"** 🆕
  - เริ่ม Train sensor ที่มี 2–3 โมเดล (มี Relation model) แล้วระหว่างตัวแรก train เปิดแท็บของตัวที่รอคิว
  - ลองกาง Model settings / กด Save changes / ไปหน้า Health score
  - กด "Remove from run" (ใน Model settings หรือในรายละเอียดของ run)
  - **คาดหวัง:** Model settings เป็นบรรทัดเดียว "Locked while this model is in the run · Remove from run" แก้ไม่ได้ · ปุ่ม Save changes (มีเฉพาะตอนมีค่าที่แก้ค้างไว้ก่อนเริ่ม run) กดไม่ได้ (tooltip "Settings are locked while this model is in the run") · พื้นที่กราฟขึ้นการ์ด "Queued · next / #n in line" พร้อมเวลาที่ต้องรอโดยประมาณ · footer ขึ้น "Queued in the run · next" (ตัวที่กำลัง train: "Training now · about 15 s") · Mark complete กดไม่ได้ ("Wait for the training run to finish" — ระหว่าง run เป็นแบบนี้ทุกโมเดล ดู BMW-161) · กด Remove from run แล้วตัวนั้นถูกข้าม **สถานะเดิมไม่เปลี่ยน** (ไม่ถูก train, ไม่กลายเป็น Incomplete) และกลับมาแก้ค่าได้ทันที

- [ ] **BMW-181 — ปิดหน้าต่าง Build Model ระหว่าง train (ปุ่ม X ของโปรแกรม และ Alt+F4 / ปุ่ม Close ของ OS): กล่องถาม โฟกัสที่ "Keep training", Esc = Keep training, Tab วนอยู่ในกล่อง (แทน BMW-108)** 🆕
  - เริ่ม Train all ที่มีหลายตัว แล้วกดปุ่ม X มุมขวาบนของหน้าต่าง
  - ตอนกล่องเปิดอยู่ กด Tab และ Shift+Tab หลาย ๆ ครั้งดูว่าโฟกัสไปไหน · กด "Keep training" (หรือ Esc) · กดปิดอีกครั้งด้วย Alt+F4 แล้วกด "Stop after this model and close"
  - อีกรอบ: เปิดคำถามค้างไว้จน run จบเอง
  - **คาดหวัง:** หน้าต่างไม่ปิดทันที ขึ้นกล่องในหน้าต่าง "Training is still running" ตัวเลข (Training i of n, ชื่อโมเดล, จำนวนที่ train แล้ว / ยังไม่เริ่ม) อัปเดตสด · ตอนเปิด ปุ่มที่โฟกัสไว้คือ **"Keep training"** (ไม่ใช่ปุ่มแรกของกล่อง) · **Tab / Shift+Tab วนอยู่แค่ 2 ปุ่มในกล่อง** ไม่หลุดไปที่ปุ่มของหน้าข้างหลัง · **Esc = Keep training** (กล่องปิด run เดินต่อ หน้าต่างไม่ปิด) — ปิดกล่องแล้วโฟกัสกลับไปที่เดิม · "Stop after this model and close" รอให้ตัวปัจจุบันเสร็จก่อน (แถบเขียน "Closing after this model…") แล้วหน้าต่างปิดเอง — ตัวที่ train เสร็จแล้วถูกบันทึก · ถ้า run จบระหว่างที่กล่องเปิดอยู่ กล่องเปลี่ยนเป็น "Run finished — close?" มีปุ่ม Close ปุ่มเดียว · การรอ Mark complete ที่กำลังบันทึก (BMW-81) ยังทำงานเหมือนเดิม

- [ ] **BMW-189 — ชนิดโมเดลเรียกว่า "Relation model" ทุกที่ในหน้าต่าง Build Model (ไม่มีคำว่า "Relationship" บนจอ)** 🆕
  - เปิด workspace ที่ sensor ตัวหนึ่งมีทั้ง Individual และ Relation model — ชี้เมาส์ที่ป้ายตัวอักษร (I / R) ของ sensor ในลิสต์ซ้าย
  - กด "▶ Train all" ดูบรรทัดเล็กใต้ชื่อโมเดลแต่ละแถวในหน้าต่าง pre-flight แล้วกด Start — ดูแถบ run ใต้บรรทัด Running condition (ชื่อโมเดลที่กำลัง train + ชี้เมาส์ที่แถบสีแต่ละช่อง) และกด "Details"
  - ระหว่าง run กดปุ่ม X ของหน้าต่าง อ่านกล่องถาม แล้วกด "Keep training"
  - ตั้งชื่อโมเดล Individual ให้ซ้ำกับชื่อ Relation model ของ sensor เดียวกัน (ใน Model settings) อ่านข้อความเตือนใต้ช่องชื่อ
  - **คาดหวัง:** ทุกจุดเขียน **"Relation model"** เหมือนบนแท็บและในเมนู ▾ ของ Train sensor: tooltip ของป้ายในลิสต์ ("Relation model · …") · บรรทัดเล็กใน pre-flight ("Relation model · ≈ 15 s") · แถบ run (ข้าง "Training i of n" เขียน "<sensor> · Relation model", tooltip ของช่อง "2. <sensor> · Relation model — training now") และการ์ดของโมเดลที่รอคิว ("Training now: <sensor> · Relation model") · กล่องถามตอนปิดระหว่าง run ("…: <sensor> · Relation model") · คำเตือนชื่อซ้ำ ("Same name as this sensor's Relation model — give it a different name…") · **ไม่มีคำว่า "Relationship" ที่ใดในหน้าต่าง Build Model** (นอกหน้าต่าง Build Model — แผง Failure groups, แท็บ Failure Groups, แถบ Undo, ข้อความล็อกของ special sensor — ดูข้อ SEN-23) และไม่มีชื่ออัลกอริทึมบนจอ

- [ ] **BMW-109 — ข้อมูลใน Dashboard เปลี่ยน (โหลด CSV ใหม่) ระหว่าง run: หยุดทันทีและบอกเป็นสีแดง** 🆕
  - เปิด Build Model เริ่ม Train all แล้วไปที่หน้าต่างหลักโหลดข้อมูลชุดใหม่ (หรือโปรเจกต์อื่น) โดยไม่ปิด Build Model
  - กลับมาดูหน้าต่าง Build Model
  - **คาดหวัง:** run หยุดที่ตัวถัดไปทันที แถบเป็นสีแดง "Run stopped: the data changed" พร้อมข้อความ "The data in this window is out of date. Close it and open Build Model again from the Dashboard." และปุ่ม "Close window" · บรรทัดใต้ "▶ Train all" และใต้ "▶ Train sensor" เป็นข้อความเดียวกันสีแดง · ทั้งสองปุ่ม Train กดไม่ได้ · ไม่มีโมเดลไหนถูกบันทึกผลจากข้อมูลชุดใหม่ (ถ้าหน้าต่างถูกเปลี่ยนไปโปรเจกต์อื่น run หายไปเฉย ๆ ไม่ค้าง)

- [ ] **BMW-160 — หลัง run: ชิป "Set points needed" + แถบบรรทัดเดียวที่หน้า Health score + ลิงก์ "Next needing set points ›" (แทน BMW-110)** 🆕
  - Train all ให้ได้อย่างน้อย 2 โมเดลที่ยังไม่มี set points
  - ดูชิปกรองในลิสต์ซ้าย แล้วกด "Set points needed"
  - เปิดรายละเอียดของ run กด "Open →" ของตัวที่ train แล้ว · กด "Next needing set points ›" ไล่ไปเรื่อย ๆ · Mark complete ไปทีละตัว
  - **คาดหวัง:** หลัง run มีชิป "Set points needed N" (ก่อน run ไม่มี) กดแล้วลิสต์เหลือแค่ sensor ที่ต้องตั้ง set points · หน้า Health score มีแถบฟ้า**บรรทัดเดียว**: **"✓ Trained in the run HH:MM · N need set points · this is k of N"** แล้วตามด้วยลิงก์ "Next needing set points ›" ชิดขวา (N = 1 เขียน "1 needs set points"; โมเดลที่เปิดอยู่ไม่ได้อยู่ในชุดนั้น = ไม่มี "· this is …") — **ไม่มี "(M in total)" และไม่มีประโยค "Set them here, then Mark complete."**; หน้าต่างแคบแล้วข้อความถูกตัดด้วย … ไม่ขึ้นบรรทัดที่สอง · "Next needing set points ›" เป็น**ลิงก์ข้อความ** (ไม่ใช่ปุ่มมีกรอบ) และจางลงกดไม่ได้เมื่อไม่มีตัวถัดไป · "Next needing set points ›" พาไปหน้า Health score ของตัวถัดไป · ปุ่ม Mark complete หน้าตาเหมือนเดิม · ตัวที่ Mark complete แล้วหายจากตัวเลข/ชิป

- [ ] **BMW-111 — ความลื่นระหว่าง run: กราฟไม่กระพริบ และไม่มีการ train สองตัวพร้อมกัน** 🆕
  - เปิดโมเดลที่มีกราฟ (Trained) ค้างไว้ในหน้า Model fit แล้วเริ่ม Train all ของ sensor อื่น ๆ
  - ระหว่าง run เลื่อน/ซูมกราฟ และสลับไปดู sensor ที่ Train แล้วแต่ยังไม่เคยเปิดในรอบนี้
  - **คาดหวัง:** กราฟที่เปิดอยู่ไม่วาดใหม่/กระพริบทุกครั้งที่คิวขยับ ซูมค้างไว้ไม่หลุด · Relation model ที่ Train แล้วที่เปิดระหว่าง run ขึ้น "Loading the Relation model…" จนกว่า run จะจบ แล้วกราฟจึงขึ้นมาเอง (ไม่เรียก Relation model สองตัวพร้อมกัน) · หน้าต่างไม่หน่วงกว่าตอนไม่มี run

- [ ] **BMW-161 — ระหว่าง run: Mark complete ทุกโมเดล, Compare predictors และ Train sensor กดไม่ได้ (ไม่มีปุ่ม Re-train ในหน้าแล้ว); โมเดลที่กำลัง Mark complete ถูกข้าม ("Its files are being saved") (แทน BMW-112)** 🐍
  - เปิดหน้า Health score ของโมเดลที่ตั้ง set point ครบแล้ว (ไม่อยู่ใน run) แล้วเริ่ม Train all / Train sensor ของ sensor อื่น
  - ระหว่าง run ดูปุ่ม Mark complete, ปุ่ม "Compare predictors" ของ Relation model ที่เปิดกราฟอยู่ และ (ถ้ามีโมเดล Relation model ที่ขึ้นกล่อง "Fit no longer in memory") ปุ่ม "▶ Train sensor" ของ sensor นั้น
  - อีกรอบ: กด Mark complete ของ Relation model (ใช้ ~15 วินาที) แล้วระหว่าง "Saving…" ดูปุ่ม Train sensor / หน้าต่าง Train all
  - **คาดหวัง:** ระหว่าง run ปุ่ม Mark complete ของ**ทุก**โมเดลกดไม่ได้ หน้าตาเหมือนเดิม และ footer บอก "Wait for the training run to finish" · "Compare predictors" กดไม่ได้ พร้อม tooltip เดียวกัน · กล่อง "Fit no longer in memory" **ไม่มีปุ่ม Re-train** — ลิงก์ "Load it again" จาง กดไม่ได้ระหว่าง run (tooltip "Wait for the training run to finish") และลิงก์ "Train sensor ↑" ชี้ไปที่ปุ่ม Train sensor ซึ่งกดไม่ได้ระหว่าง run พร้อม tooltip เดียวกัน (ดู **BMW-166**) · run จบแล้วกดได้ตามปกติ · โมเดลที่กำลัง Mark complete: Train sensor บอก "Can't train: … — Its files are being saved" (tooltip ของปุ่ม) และใน pre-flight เป็น "Skipped" สีเหลือง มีบรรทัดที่สอง "Its files are being saved" (ไม่ถูก train ซ้อนกับการเขียนไฟล์) — ไม่มีจังหวะที่ Relation model ถูกคำนวณสองตัวพร้อมกัน

- [ ] **BMW-162 — แป้นพิมพ์ / screen reader ใน Workbench: ชื่อแท็บบอกสถานะ, "Details" ไม่ทำโฟกัสหลุด, โฟกัสหลัง Save changes, "· unsaved changes" บนแท็บที่ไม่ได้เปิด** 🆕
  - sensor ที่มีโมเดล 2 ชนิดขึ้นไป: แก้ชื่อโมเดลของแท็บ Individual ค้างไว้ (ยังไม่ Save) แล้วสลับไปแท็บ Relation model — เอาเมาส์ชี้แท็บ Individual และจุดของมัน
  - ใช้ Tab ไปที่ปุ่ม "Details" ของบรรทัด Running condition กด Enter / Space หลายครั้ง
  - แก้ชื่อโมเดล ใช้ Tab ไปที่ "Save changes" แล้วกด Enter — ทำทั้งกับโมเดลที่ Train แล้ว และโมเดลที่ยังไม่ Train
  - (ถ้ามี screen reader เช่น Narrator / NVDA) ไล่อ่านแท็บชนิดโมเดล และเครื่องหมาย ✓ ของบรรทัด Running condition
  - **คาดหวัง:** แท็บที่มีค่าแก้ค้างไว้แต่ไม่ได้เปิดอยู่ tooltip ลงท้าย **"· unsaved changes"** (เช่น "Individual · Trained · unsaved changes") — กด Save แล้วคำนี้หาย · กด "Details" / "Hide details" ด้วยแป้นพิมพ์แล้ว**โฟกัสยังอยู่ที่ปุ่มเดิม** กดซ้ำได้เรื่อย ๆ โดยไม่ต้อง Tab หาใหม่ · หลังกด "Save changes" (ปุ่มหายไป) โฟกัสย้ายไปที่ **"Next: Health score →"** — ถ้าปุ่มนั้นกดไม่ได้ (ยังไม่ Train) โฟกัสไปอยู่ที่แถบ footer (ไม่หลุดไปต้นหน้า) · screen reader อ่านแท็บเป็น "Individual, Trained" / "Relation model, Set points needed" / "…, Training failed" (สถานะไม่ได้อยู่แค่ใน tooltip) และอ่าน ✓ ของบรรทัด Running condition ว่า "Set · applies to every model" · สำหรับผู้ใช้เมาส์ทุกอย่างหน้าตาเหมือนเดิม

- [ ] **BMW-212 — เวลาบนหน้า Health score เป็น "ต้นชั่วโมง" เสมอ (ไม่มีวินาที ไม่มีนาทีอื่นนอกจาก :00) ไม่ว่าข้อมูลจะถี่แค่ไหน และเวลาไม่เลื่อนตามเขตเวลาของเครื่อง; หน้า Model fit ยังเป็นเวลาของแต่ละแถว (แทน BMW-163)** 🆕
  - ใช้ชุดข้อมูลที่บันทึกถี่กว่า 1 ชั่วโมง (เช่นทุก 10 วินาที หรือทุก 5 นาที) Train แล้วเปิดหน้า Health score ตั้ง set point ให้ valid แล้วชี้เมาส์ไล่ไปตามกราฟคะแนนและกราฟ set point
  - กลับไปหน้า Model fit ชี้กราฟเวลา ดู tooltip และระยะห่างของจุด
  - ใช้ชุดข้อมูลรายชั่วโมง ชี้กราฟหน้า Health score เหมือนกัน
  - (ถ้าทำได้) ใช้ CSV ที่เวลามี offset ต่อท้าย เช่น `2026-02-09T23:50:00+07:00` แล้วเปลี่ยนเขตเวลาของ Windows เป็นเขตอื่น เปิดโปรแกรมใหม่ ดูเวลาที่หัวกราฟคะแนน ("Lowest … on …"), บรรทัดอ่านค่าตอนชี้ · **ดูตัวเลขเวลาบนแกนนอนของกราฟ Workbench ทุกใบ (Model fit และ Health score) และ tooltip ตอนชี้** — ถ้าเปลี่ยนเขตเวลาของ Windows ไม่ได้ ให้ใช้ CSV ที่ offset ไม่ใช่ของเครื่อง (เช่น `-05:00`) แทน (อย่าใช้เวลาที่ลงท้ายด้วย `Z` — ดู "ของที่รู้อยู่แล้ว")
  - **คาดหวัง:** หน้า Health score: บรรทัดอ่านค่าตอนชี้เขียนเวลาเป็น**ต้นชั่วโมง**เสมอ เช่น "2026/02/09 23:00:00 · 1 h avg … · score …" — **นาทีและวินาทีเป็น :00:00 เสมอ** แม้ข้อมูลจะถี่เป็นวินาที · ชี้ไล่ไปภายในชั่วโมงเดียวกันอ่านได้จุดเดียว (จุดที่ใกล้เมาส์ที่สุด) จุดถัดไปห่างกัน 1 ชั่วโมง · หัวกราฟ ("Lowest … on …") เป็นต้นชั่วโมงเช่นกัน · ชั่วโมงของจุดคือชั่วโมง**ตามนาฬิกาที่เขียนในไฟล์**: แถว 23:50 ในไฟล์อยู่ในจุด 23:00 ไม่ว่าเครื่องจะตั้งเขตเวลาใด และไม่ว่าแถวนั้นมี offset อะไรต่อท้าย · หน้า Model fit: กราฟเวลา**ยังวาดทุกแถวตามเวลาของแถวนั้น** (ข้อมูลทุก 10 วินาทีเห็นจุดห่างกัน 10 วินาที, 23:50 ในไฟล์ = 23:50 บนจอ) · **แกนเวลาของกราฟ และ tooltip ก็เป็นเวลาตามไฟล์** — จุดที่บรรทัดอ่านค่าบอกว่า 23:00 อยู่ที่ 23:00 บนแกน และแถบช่วง Train / Scoring ยังครอบจุดข้อมูลของช่วงนั้น · เวลาที่โปรแกรมบันทึกเอง ("Trained …", "Files saved …" ที่ footer) ยังเป็นเวลาท้องถิ่นของเครื่องตามเดิม

- [ ] **BMW-113 — ปิดระหว่าง run เมื่อ sidecar ค้าง / Dashboard ปิดโปรเจกต์ระหว่าง run** 🆕
  - (ทำยากบนแอปจริง — ใช้ Relation model ที่ train นานที่สุด) เริ่ม run แล้วกดปิด → "Stop after this model and close" แล้วรอนานเกิน ~90 วินาที (หรือจำลอง sidecar ค้าง)
  - กดปิดอีกครั้ง
  - อีกรอบ: เริ่ม run แล้วที่หน้าต่างหลักกด Back to Import (หรือเปิดโปรเจกต์อื่น) โดยไม่ปิด Build Model
  - **คาดหวัง:** ถ้ารอนานเกินกำหนด หน้าต่างยังไม่ปิด ขึ้นข้อความ "Still training a model — the window stays open … Close it again to leave without waiting." แล้วการปิดครั้งถัดไปปิดได้ทันที (ไม่ถามซ้ำ) · กดปุ่ม Stop ซ้ำหลายครั้งไม่ทำให้รอซ้อน · เมื่อ Dashboard ปิดโปรเจกต์ หน้าต่าง Build Model ปิดตามทันที **ไม่ถาม** และไม่ค้างอยู่กับโปรเจกต์เก่า (run ถูกยกเลิก — โมเดลที่ train เสร็จแล้วยังถูกบันทึก)

- [ ] **BMW-24 — Workspace เก่าที่มีโมเดลอยู่แล้วแต่ไม่เคยตั้ง Running Condition: แบนเนอร์ 3 ปุ่ม**
  - เปิด workspace เก่า (สร้างก่อนฟีเจอร์นี้) ที่มีโมเดลแล้วและไม่เคยตั้ง Running Condition
  - ดูแบนเนอร์สีน้ำเงิน "New: running condition is now required for every model." ใต้บรรทัด Running condition (บอกจำนวนโมเดลที่ Complete แล้วว่าเทรนด้วยข้อมูลทั้งหมด)
  - ลองปุ่ม "Remind me later" แล้วปิดโปรแกรม เปิดใหม่
  - ลองปุ่ม "Set a condition" (เปิด popup Running condition) แล้วตั้งเงื่อนไขที่กรอกครบ แล้วกด Apply
  - เปิด workspace เก่าอีกอันแล้วกด "Keep using all data"
  - **คาดหวัง:** แบนเนอร์มี 3 ปุ่ม — "Remind me later" ซ่อนแค่รอบที่เปิดอยู่ (ไม่บันทึก) — "Set a condition" เปิด popup Running Condition ให้ และแบนเนอร์หายเมื่อตั้งเงื่อนไขครบแล้ว **และไม่กลับมาอีก** — "Keep using all data" = ยืนยัน No condition แบนเนอร์หายถาวร — workspace ใหม่ที่ยังไม่มีโมเดลต้องไม่เห็นแบนเนอร์นี้

- [ ] **BMW-185 — หัวข้อ "Train periods": บังคับอย่างน้อย 1 ช่วง, แถวบรรทัดเดียว, พิมพ์วันที่แล้วแถวไม่สลับ / ลบบางส่วนแล้ววันเดิมกลับมา, ช่วงซ้อนกัน = บรรทัดเทา + "Merge into one", ทับ Highlight = บรรทัดเหลือง + "Remove the overlap" (แทน BMW-175)** 🆕
  - เปิด popup ดูหัวข้อ **Train periods** — บรรทัดหัวข้อ: ชื่อ + "only healthy, normal running time — the model learns what normal looks like from it. At least one." — ดูแถว `P1  วันเริ่ม → วันสิ้นสุด  81 d · 69 d running  🗑`
  - ลบ Train period จนหมด — ดูบรรทัดในหัวข้อ, timeline, บรรทัดสรุป แล้วลองกด **Apply**
  - กด "Add train period" แล้วแก้วันที่ให้ 2 ช่วงเหลื่อมกัน — ดูใต้แถวหลัง กด "Merge into one" · ลองปลายเปิด Start of data / End of data (ปุ่ม ✕ ในช่องวันที่ และ "Set date")
  - มี 2 ช่วง: คลิกในช่องวันเริ่มของ **P2** แล้วพิมพ์เดือน/ปีให้**ก่อน** P1 ทีละตัวเลข — ดูว่าแถวและเคอร์เซอร์อยู่ที่เดิมระหว่างพิมพ์ แล้วคลิกออกจากช่อง
  - คลิกส่วน "วัน" ของ**วันเริ่มของ P1** แล้วกด Backspace (ช่องเขียน "dd") แล้ว**คลิกออกจากช่อง** — ทำซ้ำกับวันสิ้นสุดของช่วงสุดท้าย — แล้วลองกด Apply ทันทีหลังลบ (ไม่คลิกที่อื่นก่อน) โดยมีการแก้อื่นค้างอยู่
  - ที่ Dashboard แท็บ Highlights สร้าง highlight ให้ทับช่วง Train P1 แล้วกลับมาเปิด popup — ดูใต้แถว Train แล้วกด **"Remove the overlap"**
  - **คาดหวัง:** **ระหว่างพิมพ์วันที่ แถวไม่สลับที่และเคอร์เซอร์ไม่กระโดด** (P2 ยังเป็น P2 จนคลิกออก — คลิกออกแล้วรายการจึงเรียงตามเวลา ช่วงที่แก้กลายเป็น P1) · **ลบส่วนหนึ่งของวันที่แล้วคลิกออก (หรือกด Apply): วันเดิมกลับมา — ไม่กลายเป็น "Start of data" / "End of data" และไม่ถูกบันทึกเป็นปลายเปิด** · ทำปลายเปิดได้ทางเดียวคือปุ่ม **✕** ในช่อง (และ "Set date" เพื่อใส่วันกลับ) · ไม่มีที่ไหนบอกว่า "ทั้งชุดข้อมูล / whole dataset / No limit" · **ไม่มีกล่องสีฟ้า "Pick only times…" แล้ว** และไม่มีแถบเวลาเล็กเหนือรายการ (timeline ด้านบนแทน) · ไม่มี Train period = บรรทัดเหลือง "No train period yet — add at least one", เลน Train ใน timeline เขียน "no train period yet", Apply กดไม่ได้ + "Add a train period" ข้าง Cancel · ช่วงซ้อน = **บรรทัดเทาเล็ก**ใต้แถวหลัง "P2 overlaps P1 by N d — rows in both are used once." + ลิงก์ "Merge into one" (ไม่บล็อก ไม่มีกรอบเหลือง) · ทับ highlight = **บรรทัดเหลืองบรรทัดเดียว** "Train P1 overlaps the highlight “…” — if something was wrong at that time, leave it out." + ลิงก์ "Remove the overlap" (ไม่ใช่กล่อง) — Apply ยังกดได้ · "Remove the overlap" ตัดเวลาของ highlight ออกจาก Train period ในแบบร่าง (แยกเป็น 2 ช่วง หรือหายไปถ้าอยู่ใน highlight ทั้งช่วง) ต้องกด Apply ถึงจะบันทึก · highlight ที่ปิดไว้ไม่เตือน

- [ ] **BMW-186 — หัวข้อ "Scoring periods": แถว S1, S2 … บรรทัดเดียว (วันเริ่ม → วันสิ้นสุด · วัน · running), วันที่ผิด = ขอบแดง บล็อก Apply, ลบวันที่ด้วยการพิมพ์ = วันเดิมกลับมา, ทับเวลา Train = บรรทัดเทา, ไม่มีเลย = บรรทัดเทา ไม่บล็อก (แทน BMW-176)** 🆕
  - ในหัวข้อ **Scoring periods** กด **"Add scoring period"** — ดูแถว S1 (วันเริ่ม → วันสิ้นสุด, "14 d · 12 d running", ถังขยะ) และบล็อก S1 ในเลน Score ของ timeline
  - ดูให้ทั่วหัวข้อ: ต้อง**ไม่มี**ปุ่ม Normal / Known problem, ช่อง "Event time" และปุ่ม "From Highlights ▾"
  - แก้วันสิ้นสุดของ S1 ให้อยู่**ก่อน**วันเริ่ม (ยังไม่ต้องคลิกออก) ดูแถวและท้าย popup จากนั้นแก้กลับ — คลิกส่วน "วัน" ของวันสิ้นสุดแล้วกด Backspace ให้ว่าง แล้วคลิกออกจากช่อง
  - ทำ Scoring period ให้ทับเวลาของ Train period แล้วดูใต้แถว
  - ลบ Scoring period จนหมด แล้วลองกด Apply
  - กด Apply แล้วปิดเปิดโปรแกรม เปิด popup ดูอีกครั้ง
  - **คาดหวัง:** บรรทัดหัวข้อ: "Scoring periods" + "the trained model gives a health score for this time — you read it on the score chart. Needed before Mark complete; may include train time." · Scoring period ใหม่เริ่มต่อจากช่วงล่าสุด 14 วัน (ไม่เกินท้ายข้อมูล) · แถวเรียง S1, S2 … ตามเวลา · วันสิ้นสุดก่อนวันเริ่ม = ขอบแดงซ้าย + ช่องวันสิ้นสุดแดง + บรรทัดเดียว "S1 ends before it starts — pick an end after <วันเริ่ม>" บล็อก S1 ใน timeline เป็นสีแดง และ Apply กดไม่ได้ ("Fix S1 before applying" ข้าง Cancel) — **ขึ้นทันทีที่วันที่ครบ ไม่ต้องคลิกออก** — แก้แล้วกดได้ · **ลบส่วนหนึ่งของวันที่ด้วยการพิมพ์: ระหว่างนั้นแถวไม่เป็นสีแดง (ข้างปุ่ม Apply ขึ้นบรรทัดเทา "Finish the date in S1 to see what this changes") และคลิกออกแล้ววันเดิมกลับมา** — "S1 needs an end date" เห็นได้เฉพาะ workspace เก่าที่ไฟล์มีวันที่ว่างอยู่แล้ว · Scoring ทับ Train = **บรรทัดเทาเล็ก**ใต้แถว "S1 includes N d of train running time — results include hours the model was trained on" **ไม่บล็อก** · ไม่มี Scoring period = บรรทัดเทา "No scoring period yet — you can train and apply now; Mark complete needs at least one." และ**ยัง Apply ได้** · ค่าอยู่ครบหลังเปิดโปรแกรมใหม่

- [ ] **BMW-202 — Running condition เป็น "บรรทัดเดียว" เมื่อตั้งแล้ว (จำนวนแถว + % ชุดเดียวกับใน popup, ไม่มีแถบเวลาเล็กบนบรรทัด) + Details กางการ์ดเต็ม; ยังไม่ตั้ง / ช่วงผิด เป็นการ์ดใหญ่มีเครื่องหมาย "!" และปุ่มของตัวเอง (แทน BMW-188)** 🆕
  - เปิด workspace ที่ยังไม่เคยตั้ง Running condition — ดูการ์ดเหลือง
  - ตั้งเงื่อนไข 1 ข้อ + Train period 2 ช่วง + Scoring period 2 ช่วง แล้ว Apply — ดูบรรทัดใต้หัวหน้าต่าง แล้วกด "Details" และ "Hide details"
  - ย่อหน้าต่างให้แคบ (ต่ำกว่า ~1100 px) ดูบรรทัดเดิม
  - จดจำนวนแถว + % บนบรรทัด แล้วกด "Edit" เทียบกับบรรทัดสรุปใต้ timeline ใน popup (ยังไม่แก้อะไร) — ลองกับไฟล์ที่ **sensor คอลัมน์แรกมีค่าว่างเยอะ**
  - เปิดไฟล์ workspace เก่าที่ไม่มี Train period / ไม่มี Scoring period · ทำให้ Scoring period หนึ่งช่วงผิด (วันสิ้นสุดก่อนวันเริ่ม ผ่านไฟล์) · ทำให้ Train period ผิด
  - Mark complete โมเดลหนึ่ง แล้วแก้**เฉพาะ** Scoring periods ใน popup แล้ว Apply
  - **คาดหวัง:** ตั้งแล้ว = **บรรทัดเดียว**: ✓ · "Running condition" · "Train 2 periods" + ช่วงวันที่ตั้งแต่ต้นช่วงแรกถึงปลายช่วงสุดท้าย (ตัวอักษร mono เช่น "2026/01/01 00:00 → 2026/06/30 23:59"; ปลายเปิด = "End") · "Scoring 2 periods" · "When running: 1 condition" (หรือ "All rows — no condition") · จำนวนแถว + "rows · NN%" · **ไม่มีแถบเวลาเล็กบนบรรทัด** (แถบเวลาอยู่ในการ์ดเต็มหลังกด Details) · ปุ่ม "Details ▾" · ปุ่ม "Edit" — **จำนวนแถวและ % ตรงกับ "N of M rows (NN%) used for training" ใน popup ของเงื่อนไขเดียวกันเสมอ** (N = แถวในช่วง Train ที่ผ่านเงื่อนไข, % เทียบกับแถวทั้งหมดของไฟล์ — ไม่ขึ้นกับว่า sensor คอลัมน์แรกมีค่าว่างหรือไม่) · นับครั้งเดียวตอนเปิดหน้าต่างและอีกครั้งหลังกด Apply ไม่หน่วงเพิ่ม · ไม่มีปุ่มสีทึบในบรรทัดนี้ · หน้าต่างแคบ: ช่วงวันที่ถูกซ่อน บรรทัดไม่ล้น · กด Details = การ์ดเต็มแบบเดิมกางตรงนั้น (แถว Train ชิป "P1 · …", แถว Scoring ชิป "S1 · …" หน้าตาเดียวกันทุกชิป, แถว When running ชิปเงื่อนไข, ป้าย "Set", จำนวนแถว + แถบ %, แถบเวลา "N d train · M d scoring") และมี "Hide details" พับกลับ · ไม่มี Train period = บรรทัดเขียนเหลือง "No train period" + "0 rows — add a train period" (ใน Details: ชิปเหลือง "No train period — add one") · ไม่มี Scoring period = เหลือง "No scoring period" (ใน Details: ชิป "No scoring period — needed before Mark complete") · Scoring period ผิด = "· ⚠ 1 to fix" สีแดงต่อท้าย · **ยังไม่ตั้ง** = การ์ดเหลืองใหญ่ วงกลมเขียน "!" (ไม่ใช่เลข 1) หัวเล็ก "Running condition · required before training" ป้าย "Not set" และปุ่มสีทึบของตัวเอง "Set running condition →" · **ช่วง Train ผิด** = การ์ดแดง วงกลม "!" "Period N needs fixing" + เหตุผล + ปุ่มแดง "Fix period" · หลังแก้เฉพาะ Scoring periods: ใต้บรรทัดขึ้นแถบเหลือง "Scoring periods changed — 1 complete model needs Mark complete again. It was not re-trained." โมเดลนั้นกลับเป็นไม่ Complete แต่**ยังเป็น Trained ไม่ต้อง Train ใหม่**

- [ ] **BMW-196 — เลือกช่วงเวลาเกินช่วงของข้อมูล (ใน popup / แผง Custom): ช่วงที่ "เพิ่งเลือกหรือเพิ่งแก้" แล้วอยู่นอกข้อมูลทั้งช่วง = แถวแดง + Apply / Save changes กดไม่ได้; เลยขอบบางส่วน = หมายเหตุสีเหลือง ไม่กัน (แทน BMW-190)** 🆕
  - ใช้ไฟล์ที่รู้ช่วงของข้อมูลแน่นอน (เช่น ข้อมูล 1 ม.ค. 2025 – 31 ธ.ค. 2025) เปิด popup Running condition (ปุ่ม Edit)
  - พิมพ์วันที่ของ **Train period P1** ให้อยู่**หลัง**ข้อมูลทั้งช่วง (เช่น 1 ก.พ. 2026 → 1 มี.ค. 2026) โดยยังไม่คลิกออก — ดูแถว P1, timeline, ป้ายที่หัว popup, ท้าย popup และปุ่ม Apply · ลองอีกแบบให้อยู่**ก่อน**ข้อมูลทั้งช่วง · ลองแบบ**ปลายเปิด** (เช่น "Start of data" → วันสิ้นสุดก่อนข้อมูลเริ่ม)
  - กด "Add train period" แล้วตั้งช่วงใหม่ให้อยู่นอกข้อมูล
  - แก้ให้ช่วง**คร่อมขอบ**ข้อมูล (เช่น 1 พ.ย. 2025 → 28 ก.พ. 2026) แล้วดูใต้แถวและปุ่ม Apply · ลองให้เริ่มก่อนข้อมูลด้วย
  - ทำแบบเดียวกันกับ **Scoring period S1** (นอกข้อมูลทั้งช่วง แล้วคร่อมขอบ)
  - ตั้งวันสิ้นสุดเป็น 23:59 ของ**วันสุดท้ายที่มีข้อมูล** (ข้อมูลจริงจบก่อนเที่ยงคืนเล็กน้อย) แล้วดูว่ามีหมายเหตุหรือไม่
  - ทำซ้ำในแผง **Custom** ของโมเดล (Model settings → Training data → Custom) ทั้ง Train และ Scoring — ดู footer และปุ่ม "Save changes"
  - **คาดหวัง:** ช่วงที่**เพิ่งเพิ่มหรือเพิ่งแก้ในรอบนี้**แล้ว**อยู่นอกข้อมูลทั้งช่วง**: แถวมีขอบซ้ายสีแดง, ช่องวันที่**ทั้งสองช่อง**เป็นสีแดง, มีเหตุผลบรรทัดเดียว **"P1 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59)"** (Scoring = "S1 is outside the data (…)"; วันที่เป็นรูปแบบเดียวกับทั้ง Workbench — ช่วงในวงเล็บแสดง**วันที่ + เวลาทั้งสองด้านเสมอ** เช่น "(2025/01/01 00:00 – 2025/12/31 23:50)") — ขึ้น**ทันทีที่พิมพ์วันที่ครบ** ไม่ต้องคลิกออกและไม่มีการโหลด · บน timeline ช่วงนั้นเป็น**ขีดแดงเล็ก ๆ ที่ขอบ**ด้านที่มันเลยออกไป (ช่วงปลายเปิดที่อยู่นอกข้อมูลก็เป็นขีดเดียวกัน ชี้ค้างเขียน "… — outside the data" ไม่ใช่ "not valid") · หัว popup มีป้าย "Fix period" · **Apply กดไม่ได้** ท้าย popup เขียนสีแดง **"Fix P1 before applying"** (Scoring = "Fix S1 before applying") · ในแผง Custom: **"Save changes" กดไม่ได้** และ footer เขียน **"Fix P1 before saving"** / "Fix S1 before saving" · ช่วงที่**เลยขอบข้อมูลแค่บางส่วน**: ไม่มีอะไรแดง มีหมายเหตุสีเหลืองเล็ก ๆ ใต้แถว **"Only the part inside the data is used (data ends 2025/12/31)"** (เริ่มก่อนข้อมูล = "(data starts 2025/01/01)"; เลยทั้งสองด้าน = "(data runs 2025/01/01 – 2025/12/31)") และ **Apply / Save changes ยังกดได้** · วันสิ้นสุดที่อยู่ในวันสุดท้ายของข้อมูล (เช่น 23:59 ทั้งที่ข้อมูลจบ 23:50) **ไม่มี**หมายเหตุ · ช่วงปลายเปิดทั้งสองด้าน (Start of data → End of data) นับถึงขอบข้อมูล จึงไม่ถูกเตือน · แก้วันที่กลับเข้ามาในข้อมูลแล้วสีแดง/หมายเหตุหายทันที · *(ช่วงที่**บันทึกไว้อยู่แล้ว**และไม่ได้แตะ จะเป็นแค่คำเตือนสีเหลือง ไม่กันอะไร — ดู BMW-201)*

- [ ] **BMW-197 — นับแล้ว "ไม่มีแถวให้ train เลย": บรรทัดแดงใต้ timeline + Apply / Save changes กดไม่ได้ ("No rows to train on") เมื่อรอบนี้แก้ช่วง Train หรือเงื่อนไข; ช่วงเดียวที่ไม่มีแถว = หมายเหตุสีเหลือง (แทน BMW-191)** 🆕
  - เปิด popup Running condition ที่มี Train period อยู่ในข้อมูล ตั้งเงื่อนไขที่**ไม่มีแถวไหนผ่านเลย** (เช่น Active power > ค่าที่สูงเกินจริงมาก) — ดูบรรทัดสรุปใต้ timeline ระหว่างที่ตัวเลขกำลังนับและหลังนับเสร็จ แล้วลองกด Apply
  - ผ่อนเงื่อนไขกลับ (หรือขยาย Train period) ให้มีแถว แล้วดูอีกครั้ง
  - เลือก **"Use all rows"** แล้วตั้ง Train period ในช่วงที่ไฟล์ไม่มีแถว (ช่องว่างของข้อมูล) — อ่านบรรทัดแดง
  - ตั้ง Train period 2 ช่วง ให้ช่วงหนึ่งอยู่ในเวลาที่เครื่องหยุด (ไม่มีแถวผ่านเงื่อนไข) อีกช่วงมีแถวปกติ — ดูใต้แถวของแต่ละช่วง
  - ตั้ง Scoring period ในเวลาที่ไม่มีแถวผ่านเงื่อนไข
  - ทำแบบเดียวกันในแผง **Custom** ของโมเดล แล้วดู footer / "Save changes"
  - **คาดหวัง:** เมื่อ**นับเสร็จแล้ว**และ Train period ทุกช่วงรวมกันได้ 0 แถว: บรรทัดสรุปเขียน "0 of N rows (0%) used for training" และมี**บรรทัดสีแดง**ใต้มัน **"No rows match — nothing to train on. Widen a train period or relax the condition."** — ถ้าเลือก **Use all rows** (ไม่มีเงื่อนไขให้ผ่อน) เขียนแค่ **"No rows match — nothing to train on. Widen a train period."** · **Apply กดไม่ได้** ท้าย popup เขียนสีแดง **"No rows to train on"** (ในแผง Custom: "Save changes" กดไม่ได้ และ footer เขียน "No rows to train on") — การกันนี้เกิดเมื่อ**รอบนี้แก้ช่วง Train หรือเงื่อนไข**; ถ้าค่าที่บันทึกไว้ได้ 0 แถวอยู่แล้วและรอบนี้แก้อย่างอื่น (เช่น Scoring period, ชื่อโมเดล) บรรทัดแดงยังขึ้นแต่ **Apply / Save changes กดได้** (ดู BMW-201) · **ระหว่างที่ตัวเลขกำลังนับ (ตัวเลขจาง) หรือนับไม่สำเร็จ ไม่มีการกัน** — บรรทัดแดงขึ้นเมื่อนับเสร็จเท่านั้น · ผ่อนเงื่อนไขแล้วบรรทัดแดงหายและ Apply กดได้อีก · **ช่วงเดียว**ที่ไม่มีแถวขณะที่ช่วงอื่นมี: หมายเหตุสีเหลืองใต้แถวนั้น **"no running rows in P2"** — ไม่กัน Apply · Scoring period ที่ไม่มีแถว: หมายเหตุสีเหลือง "no running rows in S1" เท่านั้น ไม่กัน (กติกาของ Mark complete เหมือนเดิม) · popup ไม่ช้าลง: ตัวเลขนับใหม่ครั้งเดียวต่อการแก้หนึ่งครั้งเหมือนเดิม

- [ ] **BMW-201 — ค่าที่บันทึกไว้แล้วไม่เข้ากับข้อมูลที่โหลดอยู่: ช่วงที่อยู่นอกข้อมูล = คำเตือนสีเหลืองเท่านั้น (ไม่กัน Apply / Save / Mark complete และผลที่มีอยู่ไม่หาย); "ไม่มีข้อมูลให้ train จริง ๆ" = กันเฉพาะปุ่ม Train พร้อมเหตุผล และสถานะที่บันทึกไว้ไม่เปลี่ยน — โมเดลที่มีผลอยู่แล้วบอกตามจริงว่า "ไม่มีข้อมูลของโมเดลนี้ในไฟล์ที่โหลด" (แทน BMW-200)** 🆕
  - *(ทำให้เกิด: ตั้ง Running condition กับไฟล์ข้อมูลช่วงหนึ่ง บันทึก แล้วเปิด workspace เดิมด้วยไฟล์ข้อมูลอีกช่วงเวลาหนึ่ง — หรือ workspace เก่าที่ Train / Scoring period ชี้ไปนอกข้อมูล)*
  - **กรณี A — Train period 2 ช่วง ช่วงหนึ่งอยู่ในข้อมูล อีกช่วงอยู่นอกข้อมูลทั้งช่วง** และมีโมเดลที่ **Trained** กับโมเดลที่ **Complete** อยู่แล้ว: เปิด Build Model ดูการ์ด Running condition, จุดในลิสต์ซ้าย/บนแท็บ, กราฟของโมเดล, ปุ่ม "Next: Health score →", หน้า Health score, ปุ่ม "Mark incomplete" และ (แก้ set point สักช่อง) "Mark complete again" · เปิด popup (Edit) ดูแถวของช่วงที่อยู่นอกข้อมูล แล้วแก้**ช่วงอื่น**หรือเงื่อนไข แล้วกด Apply
  - **กรณี B — Scoring period ที่บันทึกไว้อยู่นอกข้อมูล:** ดูการ์ดและแถว S1 ใน popup แล้วแก้อย่างอื่นและกด Apply · กับโมเดล **Custom** ที่ Scoring period ของตัวเองอยู่นอกข้อมูล: กาง Model settings **แก้แค่ชื่อโมเดล** แล้วดูป้ายที่ footer, กราฟ และปุ่ม "Save changes"
  - **กรณี C — Train period ทุกช่วงอยู่นอกข้อมูล** (หรือเงื่อนไขที่บันทึกไว้**ไม่มีแถวไหนผ่าน**): ดูการ์ด, โมเดลที่**ยังไม่เคย train**, โมเดลที่ **Trained / Complete** อยู่แล้ว, ปุ่ม "▶ Train sensor" (บรรทัดใต้ปุ่มและ tooltip) และเมนู ▾ · ที่โมเดล **Trained / Complete**: อ่านกล่องกลางหน้า, ป้ายและประโยคที่ footer, tooltip ของจุดบนแท็บ แล้ว**กดลิงก์ในกล่อง** จากนั้นเปิดหน้า **Health score** ดูกล่อง ปุ่ม "Mark incomplete" / "Mark complete" · กด "▶ Train all" ดูรายการ แล้วกด "Fix →" ของโมเดลที่ถูกข้าม
  - ดูโมเดลที่ใช้ Custom ซึ่งช่วงของมันเองอยู่ในข้อมูล · sensor ที่มีโมเดล Custom 2 ตัวใช้เงื่อนไขของตัวเองชุดเดียวกันที่ไม่มีแถวผ่าน: สลับแท็บไปมาแล้วอ่านบรรทัดใต้ปุ่ม Train sensor
  - ปิด Build Model แล้วเปิดใหม่ ดูสถานะของทุกโมเดล และจุดที่ Dashboard
  - **คาดหวัง:** **กรณี A:** การ์ดยังเป็นบรรทัดเดียวสีเขียว (ตั้งแล้ว) มีข้อความ**สีเหลือง** **"⚠ P2 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59) — it is not used"** และยังแสดงจำนวนแถวตามปกติ *(ช่วงของข้อมูลในวงเล็บแสดง**วันที่ + เวลาทั้งสองด้านเสมอ** เช่น "(2025/01/01 00:00 – 2025/12/31 23:50)" — ถูกต้อง ไม่ใช่บั๊ก)* (ใน Details ชิปของช่วงนั้นเป็นสีเหลือง ไม่แดง) · **ไม่มีอะไรของโมเดลเปลี่ยน:** โมเดล Trained ยังขึ้นกราฟ ป้าย "Trained" จุดเดิม "Next: Health score →" กดได้ และ **Mark complete ทำได้**; โมเดล Complete ยังขึ้นกราฟ (ไม่ใช่กล่อง "Marked complete — it has no charts") ป้าย "Complete" จุดเขียว tooltip "Complete" (ไม่ใช่ "Fix periods") ไม่ถูกนับในตัวกรอง "Needs setup" เปิดหน้า Health score ได้ **"Mark incomplete" และ "Mark complete again" ใช้ได้** · ปุ่ม Train ไม่ถูกกัน (ช่วงที่อยู่ในข้อมูลยังมีแถว) · ใน popup แถวของช่วงนั้นมีขอบ**สีเหลือง**และข้อความเดียวกัน ("… — it is not used") ช่องวันที่ไม่แดง ไม่มีป้าย "Fix period" บน timeline เป็นขีด**เหลือง**ที่ขอบ และ **Apply ของการแก้อย่างอื่นกดได้** — ถ้า**ย้าย**ช่วงนั้นไปที่อื่นที่ยังอยู่นอกข้อมูล จึงกลายเป็นแถวแดง + "Fix P2 before applying" (BMW-196) · **กรณี B:** การ์ดมีข้อความสีเหลือง **"⚠ S1 is outside the data — nothing is scored there"** แถว S1 ขอบเหลือง + ข้อความเดียวกัน, Apply ของการแก้อย่างอื่นกดได้ · โมเดล Custom: แก้ชื่อแล้วป้ายยังเป็น **"Trained"** กราฟยังอยู่ **"Save changes" กดได้**และบันทึกชื่อใหม่ · **กรณี C:** การ์ดเป็นขอบแดง มี "!" แทนเครื่องหมายถูก เขียน **"0 rows — nothing to train on"** (ปุ่มยังเป็น "Edit"; ใน Details ป้ายเป็นสีแดง "Nothing to train on" **ไม่ใช่ป้ายเขียว "Set"**) และไม่ขึ้นการ์ด "P1 needs fixing" · โมเดลที่**ยังไม่เคย train** (ใช้ Running condition ของ workspace): กล่อง "1 item to fix before training" + footer เขียนเหตุผล — ช่วงอยู่นอกข้อมูล: **"No train period is inside the data (2025/01/01 00:00 – 2025/12/31 23:59) — nothing to train on. Move a train period inside the data (Running condition → Edit)."** (tooltip จุด "No train period inside the data"); ไม่มีแถวผ่านเงื่อนไข: **"No rows match — nothing to train on. Widen a train period or relax the condition (Running condition → Edit)."** (tooltip จุด "No rows to train on") — จุดสีแดง ปุ่ม Train sensor กดไม่ได้ tooltip "Can't train: Individual — No train period inside the data" / "… — No rows to train on" · โมเดลที่ **Trained / Complete อยู่แล้ว: สิ่งที่บันทึกไว้ไม่เปลี่ยนเลย** (สถานะ Complete, เวลา "Trained …", set point, ไฟล์ที่ export) และ**จุดที่ Dashboard เหมือนเดิม** — การ train ซ้ำถูกกัน เหตุผลเขียนที่บรรทัดใต้ปุ่ม Train sensor: **"Can't train · No rows to train on"** (หรือ "… · No train period inside the data") · **แต่ในกรณี C กราฟของโมเดลเหล่านี้วาดไม่ได้** เพราะไฟล์ข้อมูลที่โหลดอยู่ไม่มีแถวในช่วง train ให้คำนวณ (ต่างจากกรณี A ที่กราฟยังอยู่ครบ) — แอป**บอกตามจริง ไม่ทำเหมือนโหลดหรือ train ล้มเหลว**: ทั้งหน้า Model fit และหน้า Health score ขึ้น**กล่องเดียว** หัวข้อ **"No data for this model in the loaded file"** ประโยคแรกบอกสาเหตุ — ช่วงอยู่นอกข้อมูล: **"None of its train periods is inside the data (2027/01/01 00:00 – 2027/12/31 23:59)."** (ช่วงในวงเล็บคือช่วงของไฟล์ที่โหลดอยู่); ไม่มีแถวผ่านเงื่อนไข: **"No row passes the running condition in its train periods."** — ตามด้วย **"Fix it in Running condition ↑ to see its charts."** โดย "Running condition ↑" เป็น**ลิงก์เดียวในกล่อง กดแล้วเปิด popup Running condition** (โมเดล **Custom**: ลิงก์คือ **"Model settings"** กดแล้วกาง Model settings ของโมเดลนั้น) บรรทัดเล็กด้านล่าง **"Complete · nothing about the model changed"** (โมเดล Trained: "Trained · nothing about the model changed") · **ไม่มี**กล่อง "Couldn't load the … model", **ไม่มี** "Load it again", **ไม่มี** "Training failed" และ**ไม่มีลิงก์ "Train sensor ▾" / "Train sensor ↑"** ที่กดแล้วไม่เกิดอะไร · **คำบอกสถานะของโมเดลเหมือนเดิม:** โมเดล Complete ป้าย footer **"Complete"** จุดเขียว (tooltip "Complete · no data in the loaded file"); โมเดล Trained ป้าย **"Trained"** จุดเหลืองเดิม (tooltip ลงท้าย "· no data in the loaded file") — **ไม่ใช่ "Incomplete" และไม่มีจุดแดง** ทั้งบนแท็บและในลิสต์ซ้าย · ประโยคที่ footer: **"Complete · no rows for it in the loaded file — fix the running condition to see its charts"** (โมเดล Trained ขึ้นต้น "Trained · …"; โมเดล Custom เขียน "… fix its own running condition in Model settings …") · สวิตช์ **"Health score" กดได้** และหน้านั้นเป็นกล่องเดียวกัน (ไม่มีช่อง set point): โมเดล Complete ยังกด **"Mark incomplete"** ได้; **"Mark complete" / "Mark complete again" กดไม่ได้** tooltip **"No data for this model in the loaded file — fix the running condition (Running condition → Edit) first"** · ปุ่ม "Next: Health score →" กดได้แต่ไม่เป็นปุ่มสีทึบ · ถ้าเปิดโมเดลทันทีตอนหน้าต่างเพิ่งขึ้น อาจเห็น "Loading the … model…" แวบหนึ่งก่อนเป็นกล่องนี้ — ปกติ · **ไม่มีข้อความ error ดิบจาก engine** · ใน Train all โมเดลนั้นเป็น **"Skipped"** พร้อมเหตุผลสั้นเดียวกันและ **"Fix →"** ที่เปิด popup · **ไม่มี error จากการ train** เพราะ train ไม่ถูกเริ่ม · โมเดล Custom ที่ช่วงของตัวเองอยู่ในข้อมูล**ไม่ถูกกัน**; โมเดล Custom ที่ไม่มีข้อมูลให้ train: เหตุผลลงท้ายด้วย "… in its own training data" และตอนแผง Custom เปิดอยู่ footer เขียน **"Above: move P1 inside the data range"** / "Above: widen a train period or relax the condition" · โมเดล Custom 2 ตัวที่ใช้เงื่อนไขชุดเดียวกัน: บรรทัดใต้ปุ่ม Train sensor บอกว่า train ไม่ได้**ทั้งสองตัว**ไม่ว่าเปิดแท็บไหนอยู่ · ถ้าโมเดลที่หน้าต่างยังไม่ได้นับ (โมเดล Custom ของ sensor อื่น) ไป train แล้วไม่มีแถว: แถวใน Train all และกล่องของโมเดลเขียน **"No rows to train on — no row inside the train periods passes the running condition with values for this model. Widen a train period or relax the condition in Model settings → Training data (Custom)."** ไม่ใช่ข้อความ error ดิบ · **ไม่มีอะไรถูกเขียนลง workspace:** โมเดลที่ Complete ยังเป็น Complete โมเดลที่ Trained ยังมีเวลา "Trained …" เดิม — ปิดเปิดแล้วเหมือนเดิม · **จุดที่ Dashboard แสดงสถานะของโมเดลเองเท่านั้น** (Dashboard ไม่รู้ช่วงของข้อมูลและจำนวนแถว จึงไม่เปลี่ยนเป็นแดงเพราะกรณีเหล่านี้) · แก้ช่วง/เงื่อนไขแล้ว Apply = Train ได้ตามปกติ

- [ ] **BMW-199 — หน้าต่าง Build Model ที่เปิดค้างไว้แล้วสลับไปอีกโปรเจกต์: ช่วงของข้อมูลที่ใช้ตัดสินเป็นของโปรเจกต์ใหม่เสมอ** 👀
  - เปิดโปรเจกต์ A (ข้อมูลช่วงหนึ่ง เช่น ปี 2025) เปิด Build Model **ค้างไว้** แล้วที่หน้าต่างหลักกลับไปหน้า Import เปิดโปรเจกต์ B ที่ข้อมูลเป็น**คนละช่วงเวลา** (เช่น ปี 2027) ซึ่งมี Train period อยู่ในข้อมูลของ B แล้วกด Build Model
  - ดูการ์ด Running condition, timeline ใน popup (Edit) และปุ่ม "▶ Train sensor" ของโมเดลในโปรเจกต์ B
  - ใน popup ลองพิมพ์วันที่ของปี 2025 (ช่วงของโปรเจกต์ A) ลงใน Train period
  - **คาดหวัง:** ทุกอย่างตัดสินจากช่วงข้อมูลของ**โปรเจกต์ B**: การ์ดไม่มีคำเตือน "is outside the data (2025/01/01 00:00 – 2025/12/31 23:59)" ของโปรเจกต์ A, timeline ใช้แกนเวลาปี 2027, ปุ่ม Train กดได้ตามปกติ · วันที่ปี 2025 ที่พิมพ์ใหม่จึงเป็นช่วงที่อยู่นอกข้อมูล: **"P1 is outside the data (2027/01/01 00:00 – 2027/12/31 23:59)"** (วันที่ + เวลาทั้งสองด้านเสมอ) · ระหว่างที่หน้าต่างเพิ่งสลับ (เสี้ยววินาที) ไม่มีการเตือนหรือกันอะไรผิด ๆ จากช่วงของโปรเจกต์เดิม

- [ ] **BMW-193 — หน้าสถานะของ Workbench ไม่มีลิงก์ที่กดแล้วไม่เกิดอะไร: แถบ "Incomplete again", โมเดล "Marked complete" ที่ train ไม่ผ่าน, "Load it again" ตอนกดไม่ได้** 👀
  - โมเดล **Relation model ที่ Train แล้ว**: เอา Predictor ออกจนหมดใน Model settings (ยังไม่ต้อง Save) — อ่านแถบสีเหลือง "Settings or running condition changed — this model is Incomplete again…"
  - sensor ที่มี 2 โมเดล: ทำให้โมเดลหนึ่ง out of date (แก้ setting แล้ว Save) แล้วใช้เมนู ▾ ของ Train sensor สั่ง train **อีกโมเดลหนึ่ง** (Relation model ~15 วินาที) — ระหว่างนั้นกลับมาอ่านแถบของโมเดลแรก แล้วอ่านอีกครั้งเมื่อ run จบ
  - *(ถ้าทำได้)* โมเดลที่ป้าย Complete แต่**ไม่เคยมีบันทึกการ train** (workspace เก่า — กล่อง "Marked complete") : ใช้เมนู ▾ → "… only" train มัน แล้วทำให้ล้มเหลว (เช่น ปิด process `backend-…exe` ระหว่าง train Relation model) — ดูกล่อง, footer, จุดบนแท็บ
  - โมเดล Complete ที่ขึ้นกล่อง "Couldn't load the …" (BMW-182): สั่ง train โมเดลอื่นของ sensor เดียวกันค้างไว้ แล้วดูลิงก์ "Load it again" (ในกล่องและที่ footer) และคำว่า "Train sensor ▾" ในกล่อง
  - โมเดลที่ Train แล้วซึ่งกราฟโหลดไม่ขึ้น (กล่อง "Couldn't load the charts") — อ่านประโยคที่ footer
  - **คาดหวัง:** แถบ "Incomplete again": ถ้า Train sensor **train โมเดลนี้ไม่ได้ตอนนี้** จะ**ไม่มีลิงก์ "Train sensor ↑"** — เขียนเหตุผลแทน: **"It can't be trained yet: Add at least 1 predictor."** (โมเดลขาด setting / ช่วงผิด), **"Train it again when the training run finishes."** (มี run ของโมเดลอื่นอยู่) หรือ "The data in this window is out of date. Close it and open Build Model again from the Dashboard." — ปิดท้ายด้วย "Your set points are kept." เสมอ และลิงก์กลับมาเมื่อ train ได้แล้ว · โมเดล "Marked complete" ที่ train ไม่ผ่าน: กล่อง **"Marked complete"** เป็นสีแดง เขียน "Training it did not work, so it still has no charts. Fix the problem, then train it again from the Train sensor ▾ menu (“… only”). It then needs Mark complete again." + บรรทัด mono **"Training failed: <เหตุผล>"** · footer: ป้ายยังเป็น Complete ประโยคสีแดง **"Training failed · train it again from the Train sensor ▾ menu"** · tooltip ของจุด: "Complete · Training failed" — **ไม่มี** "Couldn't load the model · load it again" (ไม่มีอะไรให้โหลด) · ระหว่างมี run: ลิงก์ "Load it again" ทั้งสองที่**จาง กดไม่ได้** (tooltip "Wait for the training run to finish") และ "Train sensor ▾" ในกล่องเป็นข้อความธรรมดาตามด้วย **"(when the training run finishes)"** — run จบแล้วกลับมาเป็นลิงก์ · หน้า Health score ของโมเดล Complete ที่โหลดไม่สำเร็จ: footer เขียน "Couldn't load the model · load it again" **ตรงกับจุดแดงบนแท็บเสมอ** แม้ผลเดิมยังค้างอยู่บนหน้า และ "Mark complete again" กดไม่ได้ระหว่างที่กำลังโหลดกลับ · กล่อง "Couldn't load the charts": footer เขียน "Trained … · the charts did not load — try again above" (ไม่เขียน "check the charts")

- [ ] **BMW-194 — Custom (Training data): Running condition ของโมเดลเองใช้หน้าตาเดียวกับ popup (timeline + แถว + สถานะ) ใน Model settings; วันที่ที่พิมพ์เข้าแบบร่างทันที; ข้อความ Copied; สรุปบรรทัดเดียว; ช่วงของโมเดลเองที่ผิด (Train หรือ Scoring) กัน "Save changes" พร้อมเหตุผล ("Fix P1 before saving" / "Fix S1 before saving" / "Add a train period") (แทน BMW-187)** 🆕
  - เลือกโมเดลที่เป็น Workspace mode กาง "Model settings" แล้วกด "Custom" ที่ "Training data"
  - ดูข้อความ "Copied …" แล้วปิด (X) สลับกลับ Workspace แล้วมา Custom อีกครั้ง
  - ดูแผง Custom: timeline + บรรทัดสรุป, หัวข้อ Train periods / Scoring periods / When the plant is running และบรรทัดสุดท้ายของแผง — แก้วันที่, เพิ่ม/ลบช่วง, เพิ่มเงื่อนไข, สลับ "Use all rows" — เทียบตัวเลข "d running" กับของ popup workspace (ต้องเป็นของโมเดลนี้เอง)
  - เปิด popup Running condition ของ workspace **ทับ**ตอนที่แผง Custom เปิดอยู่ แล้วปิด — ค่าของแผง Custom ต้องไม่เปลี่ยน
  - พิมพ์วันที่ใหม่ในแถว P1 ของแผง Custom โดยยังไม่คลิกออก — ดู timeline ของแผง, footer และปุ่ม "Save changes" · ลบส่วนหนึ่งของวันที่แล้วคลิกออก
  - ตั้ง Train period ของโมเดลให้วันสิ้นสุดก่อนวันเริ่ม — อ่านเหตุผลที่ footer และที่กล่องรายการที่ต้องแก้ — พับ "Model settings" แล้วอ่านอีกครั้ง — ลองลบ Train period ของโมเดลจนหมด และลองไม่ตั้งเงื่อนไข
  - ตั้ง **Scoring period** ของโมเดลให้วันสิ้นสุดก่อนวันเริ่ม — อ่าน footer และชี้เมาส์ที่ปุ่ม "Save changes"
  - โมเดล Custom ที่ Train แล้ว: กาง "Model settings" ค้างไว้ แล้วไปหน้า **Health score** แก้ set point สักช่อง แล้วกลับมาหน้า Model fit — หน้าต้องลื่นเหมือนโมเดล Workspace mode
  - ที่ Dashboard สร้าง highlight ทับ Train period ของโมเดลนี้ แล้วกลับมากาง "Model settings" (ไม่ต้องเปิด popup workspace)
  - พับ "Model settings" ดูสรุปบรรทัดเดียว · กด "Save changes" แล้ว Train แล้วไปหน้า Health score ตอนที่โมเดลนี้ไม่มี Scoring period
  - **คาดหวัง:** "Copied N train period(s), M scoring period(s) and K condition(s) from Workspace" ขึ้น**ครั้งเดียว** (คัดลอกเฉพาะรายการที่ยังว่าง) · แผง Custom **หน้าตาเดียวกับ popup**: timeline, แถวบรรทัดเดียว P1/S1 พร้อม "d running" ของโมเดลเอง, ตัวเลือก 2 อัน, แถวเงื่อนไขบรรทัดเดียว — ไม่มีรายการแบบพับได้ ไม่มีกล่อง "Required" ไม่มีเมนู operator แบบเลื่อนลง · บรรทัดสุดท้าย: **"Only this model · the workspace default is untouched · saved with Save changes"** · ไม่มี Scoring period = บรรทัดเทา "No scoring period yet — you can train and **save** now; Mark complete needs at least one." · ค่าที่แก้ยังไม่ถูกบันทึกจนกด Save changes และ Running condition ของ workspace ไม่ถูกแก้ · **วันที่ที่พิมพ์ครบแล้วเข้าแบบร่างของโมเดลทันที** (timeline ของแผงเปลี่ยน, footer เป็น "Unsaved changes…" และปุ่ม "Save changes" ขึ้น โดยไม่ต้องคลิกออก) · ลบส่วนหนึ่งของวันที่แล้วคลิกออก = วันเดิมกลับมา (ไม่กลายเป็นปลายเปิด) · **ช่วงของโมเดลเองผิด — Train หรือ Scoring ก็ตาม (กติกาเดียวกับ Apply ของ popup):** "Save changes" กดไม่ได้ (tooltip บอกเหตุผล เช่น "P1 ends before it starts." / "S1 ends before it starts.") และ footer เขียน **"Fix P1 before saving"** / **"Fix S1 before saving"** · ลบ Train period ของโมเดลจนหมดตอนมีการแก้ค้างอยู่ = "Save changes" กดไม่ได้ และ footer เขียน **"Add a train period"** · ถ้าโมเดล**ยังไม่ตั้งเงื่อนไขด้วย** (ไม่มีทั้งเงื่อนไขและ Train period): footer บอกเรื่องเงื่อนไขก่อน — **"Set a condition above, or choose Use all rows"** — ตรงกับ tooltip ของจุด ("Needs condition"); ตั้งเงื่อนไขแล้วทั้งสองที่เปลี่ยนเป็นเรื่อง Train period พร้อมกัน · บนหน้า Health score ไม่มีการนับแถวของแผง Custom เบื้องหลัง (แผงอยู่เฉพาะหน้า Model fit) — กลับมาหน้า Model fit แล้วตัวเลข "d running" ของแผงนับใหม่ครั้งเดียว · สรุปบรรทัดเดียวเป็น **"Custom · 1 condition · 1 train · 0 scoring"** ("Custom · all rows · …" เมื่อเลือก Use all rows) · เหตุผลของโมเดลที่**บันทึกไว้แล้ว** (ไม่มีการแก้ค้าง) ตอนแผงเปิดอยู่: "Fix P1's end above" / "Add a train period above" / "Set a condition above, or choose Use all rows" — ตอนพับ Model settings: "Own running condition: P1 ends before it starts. Fix it in Model settings" (ไม่มี Train period = "Own running condition: no train period. Fix it in Model settings"; ยังไม่ตั้งเงื่อนไข = "Own running condition: not set. Fix it in Model settings") · ไม่มี Scoring period = เหตุผลที่ Mark complete ไม่ได้คือ "Add a scoring period in Model settings → Training data (Custom) before marking complete." · highlight ที่เพิ่งสร้างขึ้นคำเตือน "Train P1 overlaps the highlight …" ในแผง Custom ทันทีที่กาง (ไม่ต้องเปิด popup workspace ก่อน) และ "Remove the overlap" ยังทำงาน

- [ ] **BMW-222 — กราฟเวลาทุกตัวใน Workbench: ระบายแถบสีเฉพาะช่วง Train (ชื่อ TRAIN / TRAIN P1, P2 … ในแถบบาง ๆ เหนือกราฟ) — ช่วง Scoring ไม่มีแถบ ไม่มีกรอบ ไม่มีชื่อ S1 / S2 บนกราฟ (แทน BMW-152)** 🆕
  - Train โมเดลแต่ละชนิดใน workspace ที่มี Train 2 ช่วง + Scoring 2 ช่วง ที่บางช่วงทับ Train (ลองอีก workspace ที่มี Train ช่วงเดียว)
  - ดูกราฟ Model fit: Individual "Sensor value over time", Relation model "Target vs predicted" (ครึ่งจอ) + "Residual over time" — และหน้า Health score: กราฟ set point + "Health score"
  - ลอง Expand กราฟ และซูมด้วยล้อเมาส์
  - **หลายช่วง:** ตั้ง Train หลายช่วงสั้น ๆ ติดกัน (8–20 ช่วง) แล้วดูแถบชื่อช่วงของทุกกราฟ รวมทั้งกราฟ set point ของหน้า Health score (แคบกว่า) — ลองย่อหน้าต่างให้แคบลงด้วย
  - **คาดหวัง:** **มีแถบสีฟ้าจาง + กรอบเส้นประ + ชื่อ เฉพาะช่วง Train** — Train ช่วงเดียวเขียน "TRAIN", หลายช่วงเขียน "TRAIN P1" แล้วตามด้วย "P2", "P3" … ในแถบเหนือพื้นที่กราฟ (ตัวหนังสือสีล้วน ไม่มีป้ายในพื้นที่กราฟ) · **ช่วง Scoring ไม่มีแถบสี ไม่มีกรอบ และไม่มีชื่อ S1 / S2 บนกราฟใดเลย ทั้งหน้า Model fit และ Health score** · **เส้นข้อมูลยังวิ่งผ่านช่วง Scoring ครบเหมือนเดิม** (ไม่ถูกตัด) และช่วงที่อยู่นอกทั้ง Train และ Scoring ยังเป็นช่องว่าง · เมื่อมีหลายช่วง Train จนชื่อจะชนกัน ชื่อบางอันถูกเว้นไว้ แต่ไม่มีชื่อพิมพ์ทับกัน และ "TRAIN P1" อยู่เสมอ · ชื่อเส้นอ้างอิง (±1SD, ±3SD, ±2RMSE, L / H, 80) ยังอยู่ขอบขวา · ชื่อ S1 / S2 ยังดูได้ที่บรรทัด Running condition

- [ ] **BMW-209 — กราฟที่ขยายเต็มจอ (Expand) ไม่มี tooltip ของกราฟด้านหลังโผล่ + tooltip เกาะเมาส์** 🆕
  - หน้า Health score: กดปุ่มขยายของกราฟ "Health score" แล้วเลื่อนเมาส์บนกราฟที่ขยาย · ทำซ้ำกับกราฟ set point
  - ในหน้าขยาย: ซูมด้วยลูกกลิ้งเมาส์ และลาก
  - ปิดหน้าขยาย แล้วเลื่อนเมาส์บนกราฟในหน้าปกติ
  - ทำซ้ำในหน้า Model fit (ขยายกราฟเวลา)
  - **คาดหวัง:** ในหน้าขยายมี tooltip กล่องเดียว ของกราฟที่ขยายเท่านั้น — **ไม่มี tooltip หรือเส้นประของกราฟด้านหลังโผล่ทับ** (เดิมเห็น tooltip 2–3 กล่อง) · กล่อง tooltip อยู่ที่ตำแหน่งเมาส์ทันที ไม่ไหลตามหลัง และหายทันทีเมื่อเมาส์ออก · บรรทัดอ่านค่าใต้กราฟ Health score ยังเปลี่ยนตามตำแหน่งที่ชี้ · ปิดหน้าขยายแล้ว สองกราฟในหน้าปกติยังมีเส้นประขึ้นพร้อมกันเหมือนเดิม

- [ ] **BMW-223 — tooltip ของกราฟเวลาใน Workbench แสดงวันที่และเวลา** 🆕
  - หน้า Model fit: ชี้กราฟเวลาตอนมองภาพรวมหลายเดือน (ยังไม่ซูม) แล้วซูมเข้าไปชี้อีกครั้ง
  - หน้า Health score: ชี้กราฟ set point และกราฟ Health score
  - **คาดหวัง:** หัว tooltip เป็นวันที่ **พร้อมเวลา** ในรูปแบบเดียวกับ Dashboard เช่น "2025/03/14 10:35:00" (เดิมขึ้นแค่ "2025-03-14") ทั้งตอนมองภาพรวมและตอนซูม · หน้า Health score แสดงต้นชั่วโมง เช่น "2025/03/14 10:00:00" และตรงกับบรรทัดอ่านค่าใต้กราฟคะแนน · แถวค่าใน tooltip เหมือนเดิม · เวลาไม่เลื่อนไปเขตเวลาอื่น (ตรงกับเวลาในไฟล์) · **ป้ายแกนเวลา**เป็น `2025/03/14` (ตัวเลขล้วน ไม่มีชื่อเดือน) และเมื่อซูมเข้าไปในวันเดียวจะเป็นวันที่ + เวลา เช่น `2025/03/14 06:00` ไม่ซ้ำกันทุกขีด

- [ ] **BMW-208 — กราฟเวลาในหน้า Model fit / Health score: เส้นประและ tooltip ตามเมาส์ทัน** 🆕
  - เปิดโมเดลที่ train แล้วของ sensor ที่สัญญาณแกว่งถี่ ไปที่หน้า Model fit แล้วเลื่อนเมาส์เร็ว ๆ บนกราฟเวลา (Individual: "Sensor value over time"; Relation model: "Target vs predicted" และ "Residual over time")
  - ไปที่หน้า Health score แล้วเลื่อนเมาส์บนกราฟ set point และกราฟ Health score (สองกราฟนี้เคอร์เซอร์เชื่อมกัน)
  - ซูม/ลากบนกราฟ แล้วชี้อีกครั้ง
  - **คาดหวัง:** เส้นประแนวตั้งและ tooltip ตามเมาส์ทันที ไม่หน่วง · บนหน้า Health score เส้นประยังขึ้นพร้อมกันทั้งสองกราฟที่เวลาเดียวกัน และ tooltip ยังแสดงค่าถูกต้อง · ไม่มีจุดเน้นบนเส้นตรงตำแหน่งที่ชี้ · แถบสี TRAIN, เส้นอ้างอิง (±1SD, ±3SD, ±2RMSE, L/H) และการซูมยังทำงานเหมือนเดิม

- [ ] **BMW-207 — ปุ่ม "Details" / "Hide details" ของ Running condition เป็นปุ่มแบบเดียวกัน อยู่ที่เดียวกัน** 🆕
  - ที่บรรทัด Running condition กด "Details" แล้วกด "Hide details" สลับไปมาหลายครั้งโดยไม่ขยับเมาส์
  - ดูปุ่ม "Edit" ในทั้งสองมุมมอง แล้วกด Edit จากทั้งสองมุมมอง
  - ใช้ Tab ไปที่ปุ่ม แล้วกด Enter / Space สลับไปมา
  - **คาดหวัง:** "Hide details" เป็น**ปุ่ม**หน้าตาเดียวกับ "Details" (ไม่ใช่ตัวหนังสือเปล่า) อยู่ซ้ายของปุ่ม "Edit" ทั้งสองมุมมอง · ปุ่มทั้งคู่อยู่**ตำแหน่งเดิม**บนจอ (มุมขวาบนของการ์ด) จึงกดสลับได้โดยไม่ต้องขยับเมาส์ · ปุ่ม "Edit" ขนาดเท่ากันทั้งสองมุมมอง · ในการ์ดเต็มไม่มีลิงก์ "Hide details" ที่หัวการ์ดแล้ว · โฟกัสคีย์บอร์ดยังอยู่ที่ปุ่มหลังสลับ

- [ ] **BMW-206 — ช่องวันที่ของ Scoring period มีปุ่มปฏิทิน เหมือน Train period** 🆕
  - เปิด Running condition → Edit แล้วดูแถว Scoring period (S1) เทียบกับแถว Train period (P1)
  - กดปุ่มปฏิทินของช่องเริ่ม แล้วเลือกวัน · กดปุ่มปฏิทินของช่องสิ้นสุด แล้วเลือกวัน
  - ทำซ้ำในแผง Custom ของโมเดล (Model settings → Training data → Custom)
  - **คาดหวัง:** ช่องวันที่ของ Scoring period ทั้งช่องเริ่มและช่องสิ้นสุดมีปุ่มปฏิทินด้านขวา · กดแล้วตัวเลือกวันที่เปิดของช่องนั้น (ไม่ใช่ช่องอื่น) · เลือกวันแล้วค่าเปลี่ยนและแถบ timeline ด้านบนขยับตาม · ยังพิมพ์วันที่เองได้เหมือนเดิม · Scoring period ไม่มีปุ่ม × แบบ Train period (ต้องมีทั้งวันเริ่มและวันสิ้นสุดเสมอ)

- [ ] **BMW-205 — หน้า Model fit ไม่มีการ์ด "Train and scoring periods" (ทุกชนิดโมเดล) + เตือนเหลืองเมื่อ Train น้อยกว่า 30 วัน (แทน BMW-125)** 🆕
  - Train โมเดล Individual / Relation model / Clustering ที่มี Scoring period 2 ช่วง แล้วดูหน้า Model fit ของแต่ละชนิดจนสุดหน้า
  - ลองกับ workspace ที่ไม่มี Scoring period เลย
  - ตั้ง Train ให้สั้นกว่า 30 วัน
  - **คาดหวัง:** ไม่มีการ์ด "Train and scoring periods" ในหน้า Model fit ของชนิดใดเลย (ไม่มีตาราง Scope / R² / RMSE / Mean shift / Rows within ±3SD, ไม่มีบรรทัด "S1 includes … of train running time", ไม่มีกล่อง "No scoring period yet", ไม่มีกล่อง "The health score could not be calculated — try again" ในหน้านี้) · Individual: การ์ด Statistics ยังอยู่ข้าง Distribution · Relation model: หน้าจบที่กราฟ "Residual over time" · กราฟตามเวลามีแถบสีและป้ายเฉพาะช่วง TRAIN — ไม่มีแถบหรือชื่อ S1 / S2 (BMW-222) (Relation model: สองกราฟเวลาของหน้านี้มีข้อมูลเฉพาะช่วง Train — BMW-216) · ไม่มี Scoring period: บรรทัด Running condition ยังเตือน "No scoring period" และหน้า Health score ยังบอกว่า Mark complete ต้องมีอย่างน้อย 1 ช่วง · Train < 30 วัน = แถบเหลือง "Only N d of train running time — at least 30 d is recommended…" ไม่บล็อก · ไม่มีคำว่า LinearGAM ที่ไหน (ใช้ "Relation model")

- [ ] **BMW-229 — หน้า Health score ไม่มีการ์ด "Scoring results" แล้ว (แทน BMW-211)** 🆕
  - เปิดหน้า Health score ของโมเดลที่มี Scoring period 1–2 ช่วง ทั้งตอน set point ยังไม่ครบ และตอน valid แล้ว
  - เปิดโมเดลที่ไม่มี Scoring period เลย · (ถ้าทำได้) ทำให้ engine ของ Relation model ตอบไม่ได้ระหว่างคำนวณคะแนน
  - **คาดหวัง:** **ใต้กราฟ Health score ไม่มีการ์ด "Scoring results"** — ไม่มีกล่อง S1 / S2 ("N.N% of running hours below 80", "Lowest NN (1 h average) on …"), ไม่มีบรรทัด "Scored once the set points are valid", ไม่มีกล่อง "No scoring period." (ผู้ใช้ให้เอาออก 2026-10-12 — ไม่ได้ใช้) · ตัวเลขรวมของทุกชั่วโมงที่มีคะแนนยังอยู่ที่หัวกราฟ Health score และการ์ด "Share of scored hours" · ไม่มี Scoring period: Mark complete ยังกดไม่ได้ และ **footer บอกเหตุผล** · คำนวณคะแนนไม่ได้ = การ์ด "Health score" สีเหลือง "The health score could not be calculated — try again" + เหตุผล + ปุ่ม "Try again" **อยู่เหนือกราฟคะแนน** (ถ้าไม่มีชั่วโมงไหนได้คะแนนเลย การ์ดนี้อยู่แทนกราฟ) และขึ้นเพียงครั้งเดียว · ตัวเลขรายช่วง (S1, S2 …) ยังถูกเขียนลงไฟล์ INFO ตอน Mark complete ตามเดิม (BMW-220)

- [ ] **BMW-127 — Custom: Scoring period ที่ผิดทำให้ Save changes ไม่ได้, Mark complete ตอนมีค่าที่ยังไม่ Save บันทึกให้ก่อน (สำเร็จในครั้งเดียว), เตือน Train < 30 วันของ Custom (แทน BMW-93)** 🆕
  - โมเดลที่เป็น Custom และ Train แล้ว (มี set point valid): กาง "Model settings" ที่แผง Scoring periods แก้วันสิ้นสุดของ S1 ให้อยู่**ก่อน**วันเริ่ม แล้วคลิกออก — ดูข้อความใต้แถว ปุ่ม "Save changes" และเหตุผลที่ footer
  - แก้วันสิ้นสุดให้ถูก (เป็นวันใหม่ที่ต่างจากเดิม) **ไม่ต้องกด Save** แล้วไปหน้า Health score กด "✓ Mark complete"
  - เปิดโฟลเดอร์ output ดูไฟล์ `*_INFO_*.json` ส่วน `validation` และปิดเปิด Build Model ดู Scoring periods ของโมเดล
  - โมเดล Custom อีกตัวที่ไม่มี Scoring period และตั้ง Train period ของตัวเองให้สั้นกว่า 30 วัน แล้ว Train — ดูหน้า Model fit
  - **คาดหวัง:** วันที่ผิด = แถวมีขอบแดงซ้าย ช่องวันสิ้นสุดแดง + บรรทัดเดียว "S1 ends before it starts — pick an end after <วันเริ่ม>" · "Save changes" และ Train กดไม่ได้ footer บอกเหตุผล ("S1 ends before it starts.") (เหมือน Apply ของ popup ที่บล็อกค่าผิด) · Mark complete ตอนมีค่าที่ยังไม่ Save: **สำเร็จในครั้งเดียว** footer ขึ้น "Files saved <วันเวลา> · …" (ไม่มี "The files were written, but the model was not marked complete") ไฟล์เขียนครั้งเดียว ส่วน `validation` ตรงกับวันที่ที่แก้ และค่าที่แก้ถูกบันทึกแล้ว (ปิดเปิดยังอยู่) · Custom ที่ Train < 30 วันและไม่มี Scoring period = แถบเหลือง "Only N d of train running time — at least 30 d is recommended…" (ไม่บล็อก)

- [ ] **BMW-128 — Workspace ที่บันทึกไว้ก่อนอัปเดตนี้ (Test periods ที่มี Normal / Known problem / event time): เปิดแล้วเป็น S1, S2 ธรรมดา โมเดลที่ Complete ยัง Complete และหลังแก้ 1 ช่วง ไฟล์เหลือแค่ id / start / end** 🆕
  - เปิด workspace ที่สร้างด้วยเวอร์ชันก่อนหน้า ซึ่งเคยตั้ง Test periods ไว้ (มี Known problem พร้อม event time และ/หรือช่วงที่สร้างจาก "From Highlights") และมีโมเดลที่ Complete แล้ว
  - เปิด Build Model ดูบรรทัด Running condition แล้วเปิด popup "Edit" ดูส่วน Scoring periods คลิกเข้า-ออกช่องวันที่โดยไม่แก้อะไร แล้วกด X / Cancel
  - ดูหน้า Model fit / Health score ของโมเดลที่ Complete
  - เปิด popup อีกครั้ง แก้วันสิ้นสุดของ S1 แล้ว Apply — เปิดไฟล์ workspace ใน `$APPDATA` ดู `runningConditionTestPeriods`
  - **คาดหวัง:** เปิดได้ปกติ ไม่มี error · ช่วงเดิมยังอยู่ครบ วันที่เดิม แสดงเป็น "S1 · …", "S2 · …" (ไม่มี Normal / Known problem / event / "From highlight …" และ event time ที่เคยอยู่นอกช่วงไม่ทำให้เป็นสีแดง) · แค่เปิดดูแล้วปิด: ปุ่ม Apply ไม่ติด ไม่มี "Changes not applied yet" และไม่ถามว่าจะทิ้งการแก้ไขไหม · โมเดลที่ Complete **ยัง Complete** (ไม่ขึ้น "Scoring periods changed" เอง) · กราฟเป็นแบบใหม่ตาม BMW-152 · หลังแก้ 1 ช่วงแล้ว Apply: ในไฟล์ ทุกช่วงเหลือแค่ `id`, `start`, `end` (ไม่มี `label`, `eventTime`, `fromHighlight`) และโมเดลที่ Complete ขึ้น "Scoring periods changed — … Mark complete again" ตามปกติ (เพราะวันที่เปลี่ยนจริง)

- [ ] **BMW-94 — Relation model: Train คำนวณจุดรายชั่วโมง (ช่วง Train และ Scoring periods) ไปด้วย, ข้อความ "Calculating the health score … up to ~15 s" ตอนรอ, เพิ่มช่วง Scoring = รอ 1 ครั้ง / ลบช่วง = ไม่ต้องรอ, คำนวณไม่ได้ = กล่องเหลือง "The health score could not be calculated — try again"** 🆕
  - workspace ที่มี Scoring period: Train โมเดล Relation model แล้วไปหน้า Health score — จับเวลาว่ากราฟคะแนนขึ้นเร็วแค่ไหน
  - เปิด popup Running condition แก้**เฉพาะ** Scoring periods ทีละอย่าง แล้ว Apply และกลับไปหน้า Health score ของโมเดลนั้นทุกครั้ง: (ก) เพิ่ม S2 ช่วงที่ไม่ทับ S1 (ข) ลบ S2 (ค) ย่อ S1 ให้จบตรงต้นชั่วโมง (ง) เพิ่ม S2 ช่วงเดิมกลับมา
  - (ถ้าทำได้) ทำให้ engine ตอบไม่ได้ระหว่างคำนวณ (เช่น ปิด/ฆ่า process backend ตอนที่ข้อความ "Calculating the health score…" ขึ้น) แล้วเปิดหน้า Health score
  - **คาดหวัง:** หลัง Train กราฟคะแนนรายชั่วโมงของ Relation model ขึ้นเกือบทันที (ไม่ต้องรอ ~15 วินาทีอีกรอบ) · **เพิ่มช่วง Scoring ใหม่ = รอ 1 ครั้ง** ระหว่างรอขึ้นบรรทัด "Calculating the health score with the Relation model — this can take up to ~15 s." (ไม่ขึ้นแวบ ๆ ตอนพิมพ์ set point) · **ลบช่วง, ย่อช่วงให้จบที่ต้นชั่วโมง หรือเพิ่มช่วงที่เคยคำนวณแล้วกลับมา = ผลขึ้นทันที ไม่ต้องรอ engine** (ขยับขอบช่วงไปอยู่กลางชั่วโมง = คำนวณใหม่เฉพาะชั่วโมงนั้น) · ทุกกรณี**ไม่มีการ Train ใหม่** ป้ายยังเป็น Trained (โมเดลที่ Complete ขึ้นแถบ "Scoring periods changed") · คำนวณไม่ได้ = กล่องเหลือง **"The health score could not be calculated — try again"** + เหตุผล + ปุ่ม "Try again" ในการ์ด "Health score" เหนือกราฟคะแนน — ชั่วโมงที่ engine ยังไม่ได้ตอบไม่มีคะแนน (ช่องว่างในกราฟ; ถ้าไม่มีชั่วโมงไหนได้คะแนนเลย หัวกราฟเขียน "No scored hours") · หน้า Model fit แถบสถิติ และ Checks แสดงปกติ — ข้อความนี้ไม่ขึ้นใน Checks และไม่ขึ้นในหน้า Model fit · ไม่มี Scoring period เลย: ดู BMW-219 · กรณี engine รุ่นเก่า ดู BMW-95

- [ ] **BMW-95 — Relation model: คำนวณ health score ไม่ได้แล้ว แอปจำไว้ (ไม่รอ ~15 วินาทีซ้ำ), "Try again" ลองใหม่จริง, แก้ช่วง Scoring แล้วลองใหม่เอง, engine เก่าไม่มีปุ่ม Try again, จำนวนชั่วโมงมากเกินมีข้อความของตัวเอง** 🆕
  - ทำให้คำนวณ health score ไม่ได้หนึ่งครั้ง (ตาม BMW-94) แล้วแก้ set point บนหน้า Health score หลาย ๆ ครั้ง
  - กด "Try again" ในกล่องเหลือง
  - แก้ช่วง Scoring (เพิ่ม S2 หรือขยาย S1) แล้ว Apply
  - (ถ้าทำได้) ใช้ installer ที่ Relation model engine เก่า / ตั้งช่วง Train + Scoring ยาวมากจนจำนวนชั่วโมงเกินหน่วยความจำ
  - **คาดหวัง:** หลังล้มครั้งแรก การแก้ set point ตอบ**ทันที**พร้อมกล่องเหลืองเดิม (ไม่ขึ้น "Calculating the health score…" และไม่รอ ~15 วินาที) · กด "Try again" = รอแล้วได้ผลหรือกล่องเหลืองอีกครั้ง (ลองใหม่จริง) · แก้ช่วง Scoring จนมีชั่วโมงใหม่ต้องคำนวณ แล้วแอปลองคำนวณใหม่เอง 1 ครั้ง · engine เก่า = หัวข้อ "The health score could not be calculated" + "…the Relation model engine in this build is out of date - reinstall or update the app. The model fit is not affected." และ**ไม่มีปุ่ม Try again** · ชั่วโมงที่ต้องให้คะแนนมากเกิน = หัวข้อ "The health score could not be calculated" + "…there are too many hours to score in memory - shorten the train or scoring periods. The model fit is not affected." และ**ไม่มีปุ่ม Try again** (ลองซ้ำช่วงเดิมก็ไม่ผ่าน ต้องย่อช่วงก่อน) · ไม่มีกรณีไหนขึ้นใน Checks หรือบล็อก Mark complete เพราะเหตุนี้ (ยกเว้น export ที่ต้องคำนวณคะแนนได้) · ถ้า engine ค้าง จะถูกหยุดเองภายใน 10 นาที

- [ ] **BMW-26 — Workspace ที่สร้างใหม่ต้องไม่ขึ้นแบนเนอร์ "legacy"**
  - สร้าง workspace ใหม่ นำเข้าข้อมูล สร้าง Failure Group และสร้างโมเดลจาก Dashboard แล้วเปิด Build Model
  - **คาดหวัง:** ไม่มีแบนเนอร์ legacy — ยังเห็นการ์ดเหลือง "Set the running condition" ตามปกติ

- [ ] **BMW-27 — ชื่อ model ห้ามซ้ำกับ model อื่นของ sensor เดียวกัน (ชื่อ default ยังเป็นชื่อ sensor)**
  - เลือก sensor ที่มีหลายชนิด (เช่น Individual + Relation model) กาง Model settings ของแท็บ Relation model ให้ช่อง Model name เป็นชื่อเดียวกับโมเดล Individual ของ sensor นั้น (พิมพ์เอง)
  - กดปุ่ม "Use '…'" แล้วลองพิมพ์ชื่อนั้นใน sensor อื่นด้วย
  - **คาดหวัง:** ชื่อ default ตอนสร้างโมเดลยังเป็นชื่อ sensor เหมือนเดิม · เมื่อชื่อซ้ำขึ้นข้อความสีเหลืองใต้ช่อง + ปุ่ม "Use 'ชื่อ (Relation model)'" · Save changes และ Train กดไม่ได้พร้อมเหตุผล · กดปุ่มแล้วชื่อเปลี่ยนตามที่เสนอ ข้อความหาย ปุ่มกลับมากดได้ · ชื่อเดียวกันใน sensor อื่นไม่ถูกเตือน · โมเดลเก่าที่ชื่อซ้ำอยู่แล้วและไม่ได้แก้ชื่อ ไม่ถูกบล็อกหรือเปลี่ยนชื่อ

- [ ] **BMW-195 — workspace ที่บันทึกไว้ก่อนเปลี่ยนคำ: ชื่อโมเดล "X (Relationship)" ยังอยู่เหมือนเดิม · ชื่อที่เสนอให้โมเดลใหม่เป็น "X (Relation model)"** 🆕
  - เปิด workspace ที่บันทึกไว้ด้วยเวอร์ชันก่อนหน้า ซึ่งมี Relation model ชื่อลงท้าย "(Relationship)" (เคยกดปุ่ม "Use '… (Relationship)'" ไว้) และมีโมเดลที่ Train / Mark complete แล้ว — ดูชื่อโมเดลในแท็บ Failure Groups ของ Dashboard และในช่อง Model name ของ Build Model แล้วดูสถานะของทุกโมเดล
  - ในช่อง Model name ของโมเดลนั้น: พิมพ์ชื่อให้ซ้ำกับโมเดลอีกตัวของ sensor เดียวกัน (เช่น "X") อ่านปุ่ม "Use '…'" แล้วพิมพ์กลับเป็น "X (Relationship)" ตามเดิม (ยังไม่ต้อง Save)
  - ที่ sensor อื่นที่มี Individual + Relation model: ตั้งชื่อ Relation model ให้ซ้ำกับ Individual แล้วกดปุ่ม "Use '…'" และ Save changes
  - กด "✓ Mark complete" ของโมเดลชื่อ "X (Relationship)" อีกครั้ง แล้วเปิดโฟลเดอร์ output ของ workspace
  - **คาดหวัง:** ชื่อ "X (Relationship)" แสดงตามที่บันทึกไว้ทุกที่ ไม่ถูกเปลี่ยนเป็น "X (Relation model)" เอง และไม่มีคำเตือนชื่อซ้ำขึ้นเองตอนเปิด · สถานะของทุกโมเดล (Complete / Trained / สีของจุด) เหมือนก่อนอัปเดต — ไม่มีโมเดลไหนกลายเป็น Incomplete หรือ "ต้อง train ใหม่" เพราะการเปลี่ยนคำ · ป้ายชนิด / แท็บ / tooltip ของโมเดลนั้นเขียน "Relation model" (เปลี่ยนเฉพาะป้าย ไม่ใช่ชื่อที่ผู้ใช้ตั้ง) · ปุ่มเสนอชื่อเขียน **"Use 'X (Relation model)'"** (คำใหม่) · พิมพ์กลับเป็น "X (Relationship)" แล้วคำเตือนหาย Save changes ไม่ถูกกันเพราะชื่อ · ที่ sensor อื่น: ชื่อที่บันทึกคือ "ชื่อ (Relation model)" · ไฟล์ที่ export ของโมเดลเก่ายังอยู่ใต้ชื่อเดิม ไม่มีไฟล์อีกชุดในชื่อใหม่โผล่มา

---

## MULTI

### เปิดมากกว่า 1 โปรเจกต์ (ข้อมูลต้องไม่ปนกัน)

_เพิ่มใน 0.5.0 หลังเจอบั๊กว่า special sensor โชว์ component/ชื่อของอีกโปรเจกต์ และ Failure Group ขึ้นบ้างไม่ขึ้นบ้าง/ไม่ตรง — เกิดจากหน้าต่างลูกที่ค้างจากโปรเจกต์เดิม ต้องใช้โปรเจกต์ A และ B จาก PREP-5 ทุกข้อ_

- [ ] **MULTI-1 — Add Special Sensor ที่ค้างอยู่ต้องถูกปิดตอนสลับโปรเจกต์** 🆕
  - เปิดโปรเจกต์ A แล้วเปิดหน้าต่าง Add Special Sensor ทิ้งไว้ (ยังไม่ต้องสร้างอะไร)
  - กลับหน้า Import แล้วเปิดโปรเจกต์ B
  - **คาดหวัง:** หน้าต่าง Add Special Sensor ของ A **ปิดไปเอง** ไม่ค้างอยู่หลังหน้าต่างหลัก (พร้อมกับ Build Model ถ้าเปิดอยู่)

- [ ] **MULTI-2 — special sensor ของ A ไม่โผล่ใน B (ทั้งชื่อ, component, description)** 🆕
  - จาก MULTI-1 เปิดโปรเจกต์ B แล้วกด Add Special Sensor
  - ดูรายการ sensor และแท็บ Manage
  - สร้าง special sensor ใหม่ใน B ตั้ง Component ต่างจากของ A
  - กลับไปเปิดโปรเจกต์ A
  - **คาดหวัง:** เห็นเฉพาะ sensor / recipe ของ B ใน B, sensor ที่สร้างใน B อยู่ใต้ component ที่เลือกจริง (ไม่ใช่ component ของ A), และ A ไม่มี sensor ของ B โผล่มา — recipe ของสองโปรเจกต์แยกกันเด็ดขาด

- [ ] **MULTI-3 — Build Model แสดง FG / ชื่อ / component ของโปรเจกต์ที่เปิดอยู่เท่านั้น** 🆕
  - เปิดโปรเจกต์ B กด Build Model
  - เทียบกลุ่ม ชื่อโมเดล และ component กับที่สร้างไว้ใน B
  - **คาดหวัง:** ตรงกับ B ทุกอย่าง ไม่มีชื่อกลุ่ม/โมเดลของ A ปน

- [ ] **MULTI-4 — สลับ A ⇄ B เร็ว ๆ หลายรอบ** 🆕
  - สลับ A → Import → B → Import → A → B อย่างน้อย 5 รอบเร็ว ๆ
  - ทุกรอบเปิด Build Model ทิ้งไว้ก่อนสลับรอบถัดไป และเปิด Add Special Sensor สลับกัน
  - **คาดหวัง:** ทุกรอบ Failure Group และ sensor ตรงกับโปรเจกต์ปัจจุบันเสมอ ไม่สุ่มขึ้นบ้างไม่ขึ้นบ้าง (บั๊กเดิมเกิดแบบสุ่มเพราะมีตัวตอบข้อมูลเก่าค้างหลายตัว จึงต้องลองซ้ำหลายรอบ)

- [ ] **MULTI-5 — กด Add Special Sensor ซ้ำตอนหน้าต่างเปิดอยู่ ต้องได้ข้อมูลของโปรเจกต์ปัจจุบัน** 🆕
  - เปิดหน้าต่าง Add Special Sensor ค้างไว้ใน B
  - ที่ Dashboard สร้าง Failure Group / ติ๊ก sensor เพิ่ม แล้วกด Add Special Sensor อีกครั้ง
  - **คาดหวัง:** หน้าต่างเดิมถูกดึงขึ้นมาหน้าสุด (ไม่เปิดซ้อน ไม่ขึ้น error) และรายการ sensor เป็นของ B ล่าสุด

- [ ] **MULTI-6 — แก้ FG ที่ Dashboard ระหว่างที่ Build Model เปิดอยู่ (หลายโปรเจกต์)** 🆕
  - เปิด B แล้ว Build Model ค้างไว้
  - ที่ Dashboard ของ B ติ๊ก sensor เข้ากลุ่มใหม่
  - **คาดหวัง:** Build Model ของ B เห็นทันที และไม่มีข้อมูลของ A โผล่มาแทรก

- [ ] **MULTI-7 — Failure Group ต้องไม่หาย (สร้างเยอะ / ปิดเปิด)** 🆕
  - สร้าง FG และโมเดลหลายอัน (10+) ในโปรเจกต์หนึ่ง กด Build Model รัว ๆ
  - ปิดโปรแกรมสนิทโดยไม่ทำอะไรต่อ เปิดใหม่ แล้วเปิดโปรเจกต์เดิม
  - **คาดหวัง:** FG และโมเดลครบทุกตัว — **บั๊กร้ายแรง 2 กลไกที่แก้แล้ว: (1) เขียนไฟล์แข่งกันเองตอนกดรัว ข้อมูลหายเกือบหมด (2) แค่ปิดแล้วเปิดใหม่ก็หายได้ เพราะ Dashboard เขียนทับข้อมูลของ Build Model ด้วยสำเนาเก่า** ⚠ เป็น race ข้ามหน้าต่าง ทดสอบรอบเดียวยืนยันไม่ได้แน่นอน ให้ใช้งานปกติต่อเนื่อง 2–3 วันแล้วเช็คซ้ำ

- [ ] **MULTI-8 — A มี special sensor แล้วกลับ Import ไปเปิด B (CSV เดียวกัน): B ต้องเห็นเฉพาะของตัวเอง** 🆕
  - เปิด A ที่มี special sensor อย่างน้อย 2 ตัว (ตัวที่ 2 สร้างจากตัวที่ 1) สร้างเพิ่มอีก 1 ตัวสด ๆ ในรอบนี้ แล้วแก้สูตรของอีกตัวหนึ่งด้วย
  - กด Back to Import แล้วเปิด B ที่สร้างจาก **CSV ไฟล์เดียวกันกับ A** (ใน B ยังไม่มี special sensor)
  - ดูรายการ sensor, กราฟ, และเปิด Add Special Sensor → แท็บ Manage
  - **คาดหวัง:** B ไม่มี special sensor ของ A เลย (ไม่อยู่ในรายการ, ไม่มี metadata/component ของ A, Manage ว่าง) · กลับไปเปิด A ใหม่: special sensor ครบทั้งหมดรวมตัวที่เพิ่งสร้าง/แก้ ค่าบนกราฟตรงกับสูตรล่าสุด · ไม่มีกล่อง error ขึ้น

- [ ] **MULTI-9 — เหมือน MULTI-8 แต่ B ใช้ CSV คนละไฟล์ และ B มี special sensor ชื่อเดียวกับของ A** 🆕
  - ใน A มี special sensor ชื่อ `S1` (สูตรหนึ่ง) · ใน B (CSV อีกชุด) สร้าง `S1` ชื่อเดียวกันแต่ **สูตรคนละอัน**
  - เปิด A → Back → เปิด B → Back → เปิด A → Back → เปิด B ซ้ำ ๆ แล้วเลือก `S1` ขึ้นกราฟทุกรอบ
  - **คาดหวัง:** ทุกรอบ `S1` ของโปรเจกต์ไหนก็แสดงค่าตามสูตร + ข้อมูลของโปรเจกต์นั้น ไม่ใช่ของอีกโปรเจกต์ · แก้สูตร `S1` ใน B แล้วกลับไปเปิด A ค่าไม่เปลี่ยน

- [ ] **MULTI-10 — งานที่ค้างอยู่ในหน้าต่าง Add Special Sensor ของ A ต้องไม่ไปโดน B** 🆕
  - ใน A: กด Delete special sensor ตัวหนึ่ง (อยู่ในช่วง Undo 8 วินาที) แล้ว Back → เปิด B (B มี sensor ชื่อเดียวกัน) ภายใน 8 วินาที
  - ลองอีกแบบ: ใน A กด Save แก้สูตรบน CSV ใหญ่ (กำลังคำนวณอยู่) แล้ว Back → เปิด B ทันที
  - **คาดหวัง:** sensor ชื่อเดียวกันใน B ยังอยู่ครบ ค่าบนกราฟของ B ไม่เปลี่ยน · กลับไปเปิด A: การลบที่ยังไม่ยืนยันถูกยกเลิก (sensor ยังอยู่ — ตั้งใจ ไม่ใช่บั๊ก) และการแก้ที่ค้างไม่ถูกเขียนลงไฟล์ของ B · ไม่มีหน้าต่างค้างหลัง Dashboard (ดู MULTI-1)

- [ ] **MULTI-11 — หน้าต่าง Add Special Sensor ที่ถูกดึงมาเป็นของโปรเจกต์ใหม่ ต้องเริ่มสะอาด** 🆕
  - (ถ้าหน้าต่างปิดไปเองตามปกติ ข้อนี้ข้ามได้ — ทำเมื่อเห็นหน้าต่างค้างจริง) ในหน้าต่างของ A: เลือก source 2 ตัว พิมพ์ชื่อ/description ค้างไว้ (ไม่กด Add) และเปิดตัวแก้ไขของ special sensor ตัวหนึ่งพร้อมพิมพ์สูตรค้าง
  - สลับไปโปรเจกต์ B แล้วกด **Add Special Sensor** (หน้าต่างเดิมถูกดึงมา)
  - **คาดหวัง:** ฟอร์ม Create ว่างทั้งหมด (source, ชื่อ, description, unit, component), ตัวแก้ไขปิดอยู่, อยู่แท็บ Create, ไม่มีข้อความ error เก่า · ถ้าหน้าต่างขึ้นแถบแดง "This project was closed or reloaded — reopen Add Special Sensor from the Dashboard." ให้กด Add Special Sensor ที่ Dashboard อีกครั้ง แถบต้องหายและใช้งานได้ปกติ

- [ ] **MULTI-12 — สร้าง special sensor แล้วกด Back เร็วมาก ต้องไม่หาย** 🆕
  - ใน A สร้าง special sensor ใหม่ แล้วกด **Back to Import ภายในไม่ถึง 1 วินาที** (กดทันทีที่กราฟขึ้น)
  - เปิด A ใหม่
  - **คาดหวัง:** special sensor ตัวนั้นยังอยู่ (recipe + Description/Component) — เดิมหายเพราะระบบบันทึกอัตโนมัติรอ 250 มิลลิวินาทีแล้วถูกยกเลิกตอนออกจากหน้า · เช็คแบบเดียวกันกับการเปลี่ยนอย่างอื่นก่อนกด Back (เลือก sensor เพิ่ม, ย้ายแผง) ก็ต้องค้างอยู่ตอนเปิดใหม่

- [ ] **MULTI-13 — คลิกเปิดโปรเจกต์ A แล้วรีบคลิก B ก่อนที่ A โหลดเสร็จ** 🆕
  - ใช้ CSV ใหญ่ที่โหลดนาน ๆ ใน A (มี special sensor) คลิก A แล้วถ้ายังหมุน Loading อยู่ ให้พยายามคลิก B ทันที (ระหว่างโหลดหน้าจอมีม่าน Loading ทับ — ถ้าคลิกไม่ได้แปลว่ากันไว้แล้ว ข้อนี้ผ่าน)
  - ถ้าคลิกได้ ให้รอจนจบ
  - **คาดหวัง:** ลงเอยที่ Dashboard ของโปรเจกต์ที่ **คลิกทีหลัง** เท่านั้น (ไม่เด้งไป A ทีหลัง ไม่ขึ้น Dashboard สองครั้ง), ข้อมูลและ special sensor เป็นของโปรเจกต์นั้นทั้งหมด (ไม่เห็นค่าที่ผิดปกติ/ว่างเปล่า), ไม่มีกล่อง "special sensor couldn't be restored"

- [ ] **MULTI-14 — หน้าต่าง Build Model ที่ถูกดึงไปเป็นของโปรเจกต์ที่ Duplicate มา ต้องไม่แบ่งช่วง cluster ที่บันทึกไว้ใหม่เอง** 👀
  - ในโปรเจกต์ A: โมเดล Clustering ที่มี criteria sensor และ 2 cluster — ลากเส้นแบ่งให้**ไม่เท่ากัน** (เช่น 20% / 80%) แล้ว Save changes
  - ที่หน้า Import กด Duplicate โปรเจกต์ A ได้ A′ (โมเดลใน A′ มี id เดียวกับของ A)
  - เปิด A → Build Model → เลือกโมเดล Clustering ตัวนั้น กด + ให้เป็น 3 cluster (ระบบแบ่งช่วงใหม่ให้เท่ากัน) **ไม่ต้อง Save** และ**อย่าปิดหน้าต่าง Build Model**
  - (ถ้าหน้าต่าง Build Model ปิดไปเองตอนออกจาก A ข้อนี้ข้ามได้ — ทำเมื่อหน้าต่างค้างและถูกดึงมาจริง) กลับหน้า Import เปิด A′ → กด Build Model → เลือกโมเดล Clustering ตัวเดียวกัน กาง Model settings
  - **คาดหวัง:** A′ แสดง 2 cluster ด้วยเส้นแบ่ง**ไม่เท่ากันตามที่บันทึกไว้** (ไม่ถูกแบ่งใหม่เป็น 50/50) · footer **ไม่มีปุ่ม "Save changes"** และไม่ขึ้น "Unsaved changes" · ช่วง min–max ของแถบเป็นของข้อมูลใน A′ · กลับไปเปิด A: โมเดลยังเป็น 2 cluster แบบที่ Save ไว้ (การกด + ที่ไม่ได้ Save ไม่ถูกเขียน)

---

## PER

### ปิดเปิดโปรแกรม & การบันทึก

_หมวดที่สำคัญที่สุด — ทุกอย่างข้างบนไม่มีความหมายถ้าเปิดกลับมาแล้วหาย_

- [ ] **PER-1 — ตั้งค่าทุกอย่างแล้วปิดเปิด**
  - ในหนึ่ง workspace: เลือก sensor หลายตัว, ซ่อนบางตัว, เปลี่ยนสี 2 ตัว, ตรึงแกน 1 ตัว, เปิด alarm 1 ตัว, ตั้ง filter, ตั้ง highlight by time, ตั้งช่วงเวลา, เปลี่ยน aggregation, ลากปรับขนาดแผง, ซ่อนแผงหนึ่ง, สลับไป Scatter แล้วตั้งแกน X/Y + ตรึงสเกล
  - ตั้ง Running Condition Filter 1 เงื่อนไขที่ Build Model และตั้งค่าโมเดลหนึ่งตัว (Training periods, Stiffness หรือ predictor)
  - ปิดโปรแกรมสนิท
  - เปิดใหม่แล้วเปิด workspace เดิม
  - **คาดหวัง:** **ทุกข้อข้างบนต้องกลับมาครบ** — ถ้าข้อไหนหาย ให้จดเฉพาะข้อนั้นไว้ (ไม่รวม tag ที่ปักบนกราฟ ซึ่งตั้งใจไม่บันทึก)

- [ ] **PER-2 — แก้อะไรแล้วปิดโปรแกรมทันที**
  - เปลี่ยนสีเส้น 1 เส้น
  - กดปิดโปรแกรมภายใน 1 วินาที
  - เปิดกลับมา
  - **คาดหวัง:** สีที่เพิ่งเปลี่ยนยังอยู่ (autosave มี debounce 250ms + flush ก่อนปิด)

- [ ] **PER-3 — special sensor กลับมาพร้อมข้อมูลจริง**
  - สร้าง special sensor แล้วปักบนกราฟ
  - ปิดโปรแกรม เปิดใหม่
  - **คาดหวัง:** **เส้นมีข้อมูลจริง ไม่ใช่มีแต่ชื่อแล้วกราฟว่าง** — recipe ถูก replay ใหม่ตอนเปิด

- [ ] **PER-4 — special sensor ที่ต่อกันหลายชั้นกลับมาถูกลำดับ**
  - สร้าง A → B → C
  - ปิดเปิดโปรแกรม
  - ปักทั้งสามบนกราฟ
  - **คาดหวัง:** ค่าของทั้งสามถูกต้อง (replay ต้องเรียงตามลำดับสร้าง ไม่งั้น B จะหา A ไม่เจอ)

- [ ] **PER-5 — สลับ workspace ไปมา**
  - เปิด workspace A ตั้งค่าอย่างหนึ่ง
  - กลับหน้า Import เปิด workspace B ตั้งอีกอย่าง
  - กลับไป A
  - **คาดหวัง:** ค่าไม่ปนกันเลย

- [ ] **PER-6 — Rename workspace**
  - File → Rename Workspace
  - ตั้งชื่อใหม่
  - กลับหน้า Import
  - **คาดหวัง:** ชื่อใหม่ขึ้นทั้งบน title bar และในรายการ Recent Workspaces

- [ ] **PER-7 — เปิด workspace ที่สร้างจากเวอร์ชันเก่า**
  - เปิด workspace เก่าที่สร้างไว้ก่อนหน้านี้นาน ๆ (เช่นสร้างด้วย 0.4.x)
  - **คาดหวัง:** เปิดได้ ไม่ crash และโมเดลที่เคยเก็บ `groupNo` เดี่ยว ๆ ถูกแปลงเป็น `groupNos` เป็น array ให้อัตโนมัติ — โมเดลที่เคยมี Sensor value filter ต่อโมเดลยังเปิดได้ปกติ (ค่านั้นไม่ถูกใช้แล้ว ใช้ Running Condition Filter ระดับ workspace แทน)

- [ ] **PER-8 — ไฟล์ workspace อยู่ที่ไหน**
  - เปิด `%APPDATA%` แล้วหาโฟลเดอร์ของ `com.prompt-solution.tauri-app`
  - **คาดหวัง:** เห็นไฟล์ของ workspace และเวลาแก้ล่าสุดขยับตามที่ทำจริง

- [ ] **PER-9 — ช่วงเวลา (Training periods) ของ workspace ต้องไม่หายเมื่อไปแก้อย่างอื่นที่ Dashboard (แก้บั๊ก 2026-09-23)** 🆕
  - ที่ Build Model → Overview กด "Edit" ที่บรรทัด Running condition เพิ่ม Training periods ของ workspace (2 ช่วง) แล้วกด Apply
  - กลับไปหน้า Dashboard ทำอะไรก็ได้ที่เป็นการแก้ค่า (เลื่อนกราฟ, ติ๊กเลือก sensor, สลับ sensor เข้า/ออก Failure Group)
  - รอ 1 วินาที แล้วปิดโปรแกรม เปิดใหม่ ไปเปิด popup Running condition เดิม
  - **คาดหวัง:** Training periods ที่ตั้งไว้ยังอยู่ครบ (เดิมหายไปหลังแก้อะไรที่ Dashboard ทั้งที่หน้าจอยังโชว์ค่าเดิมอยู่จนกว่าจะปิดเปิด) — โมเดลที่ยังเป็นโหมด Workspace ก็ Train ด้วยช่วงเวลานั้นเช่นกัน

- [ ] **PER-10 — Workspace จากเวอร์ชันก่อนหน้าที่ตั้ง Time start/end ช่วงเดียวไว้ ต้องเปิดได้เป็น 1 period และคีย์เก่าถูกลบ** 🆕
  - เตรียม workspace ที่สร้างด้วยเวอร์ชัน 0.6.x โดยตั้ง Time start/end ที่แผง Running Condition Filter (ของเวอร์ชันนั้น) และตั้ง Custom time ของโมเดลหนึ่งตัวไว้ (หรือใช้ไฟล์สำรองของ workspace นั้น)
  - เปิดโปรแกรมเวอร์ชันนี้ เปิด workspace นั้น เข้า Build Model → Overview กด "Edit" ที่บรรทัด Running condition เปิด popup Running condition
  - กาง Model settings ของโมเดลที่ตั้ง Custom time ไว้ (Training data: Custom)
  - ปิดเปิดโปรแกรม เปิด workspace เดิมอีกครั้ง
  - **คาดหวัง:** แผงแสดง Training periods **1 ช่วง** ตรงกับ Time start/end เดิม (ปลายที่เคยว่างเป็น "Start of data"/"End of data") · โมเดล Custom ก็แสดงเป็น 1 period ตรงกับช่วงเดิมของมัน · กราฟ/สถิติใช้ช่วงเดิมเหมือนก่อนอัปเกรด · ปิดเปิดแล้วค่ายังเหมือนเดิม ไม่ซ้ำ ไม่หาย (ระบบบันทึกกลับครั้งเดียว) · ข้อจำกัด: เปิดไฟล์ที่ผ่านการอัปเกรดแล้วด้วยเวอร์ชันเก่ากว่าจะไม่เห็นช่วงเวลา

- [ ] **PER-13 — แก้ Running Condition Filter แล้วกด Apply แล้วปิดหน้าต่าง Build Model ทันที ค่าที่ Apply ต้องไม่หาย (แทน PER-11 — ต้อง Apply ก่อนค่าจึงถูกบันทึก)** 🆕
  - เปิด Build Model → Overview กด "Edit" ที่บรรทัด Running condition แก้วันที่ของ Training period หนึ่งช่วง (หรือเพิ่ม/แก้เงื่อนไข value) แล้วกด **Apply** แล้ว**กดปิดหน้าต่าง Build Model ทันที** (ปุ่ม Close มุมขวาบน หรือปุ่ม X ของหน้าต่าง) โดยไม่รอ
  - เปิด Build Model ใหม่ ไปเปิด popup Running condition ด้วยปุ่ม "Edit"
  - **คาดหวัง:** ค่าที่เพิ่งแก้และ Apply ไว้ยังอยู่ครบ ไม่ย้อนกลับเป็นค่าก่อนแก้ (การเขียนดิสก์ที่ Apply เริ่มไว้ถูกรอให้เสร็จก่อนหน้าต่างปิดจริง)
  - ทำซ้ำกับโมเดลโหมด Custom (Model settings → Training data: Custom): แก้เงื่อนไข/ช่วงเวลาของโมเดลนั้น กด **Save changes** แล้วปิดหน้าต่างทันที — ค่าต้องไม่หายเช่นกัน
  - แก้ใน popup แล้ว**ไม่กด Apply** แล้วปิดหน้าต่าง Build Model ทั้งหน้าต่าง — ค่านั้นต้องไม่ถูกบันทึก (เปิดใหม่เห็นค่าเดิม) นี่คือพฤติกรรมที่ตั้งใจ

- [ ] **PER-14 — พิมพ์วันที่ค้างไว้ (ยังไม่ blur) แล้วกดปุ่ม Apply ตรง ๆ วันที่ต้องไม่หาย (แทน PER-12)** 🆕
  - เปิด Build Model → Overview กดปุ่ม "Edit" ที่บรรทัด Running condition · Running condition
  - ในหัวข้อ "Train periods" คลิกช่องวันที่ของช่วงใดช่วงหนึ่ง พิมพ์วันที่ใหม่ — **อย่ากด Tab หรือคลิกที่อื่นในแผงก่อน** คลิกปุ่ม **Apply** ทันที
  - กดปุ่ม "Edit" เปิด popup เดิมซ้ำอีกครั้ง
  - **คาดหวัง:** ปุ่ม Apply กดได้ตั้งแต่พิมพ์ค้าง (ไม่ต้องรอ blur) และวันที่ที่เพิ่งพิมพ์ถูกบันทึกครบ ไม่ย้อนกลับเป็นค่าก่อนแก้ (บั๊กเดิมของ popup: ช่องวันที่บันทึกตอน blur/Enter เท่านั้น — ปุ่ม Apply ต้องบังคับ blur ก่อนอ่านค่า)
  - ทำซ้ำแต่พิมพ์วันที่ค้างแล้วคลิกปุ่ม X (หรือพื้นหลัง) แทน Apply — ต้องขึ้นแถวถาม "Discard your unapplied changes?" (นับวันที่ที่พิมพ์ค้างเป็นการแก้ที่ยังไม่ Apply) ไม่ใช่ปิดเงียบ ๆ แล้วหายไป

- [ ] **PER-15 — special sensor ที่กู้คืนไม่ได้ตอนเปิด workspace: แจ้งครั้งเดียว ไม่ปักบนกราฟ ตัวที่สร้างต่อถูกข้ามและบอกชัด** 🆕
  - สร้าง `A` จาก sensor ดิบ `TAG1`, สร้าง `B` ที่ใช้ `A` ต่อ, และสร้าง `C` ที่ใช้เฉพาะ sensor อื่นที่ยังอยู่ — ปักทั้งสามบนกราฟ
  - ปิดโปรแกรม แล้วทำให้ `TAG1` หายไปจากไฟล์ CSV (หรือใช้ workspace ที่ CSV ถูกแก้คอลัมน์) แล้วเปิด workspace เดิม
  - **คาดหวัง:** workspace เปิดได้ — มี **toast เดียว** บอกว่า `A` กู้คืนไม่ได้ และ `B` **ถูกข้าม** (เพราะสร้างต่อจาก A ที่กู้คืนไม่ได้) — `C` กลับมามีข้อมูลปกติ — กราฟ **ไม่มีเส้นว่างของ A/B ค้างอยู่** (ถูกถอดออกจากที่ปักไว้) แต่ยังเห็น A/B ในแท็บ Manage เพื่อไปแก้ได้

- [ ] **PER-16 — Workspace เก่าเปิดได้ครบทุกโมเดล และหน้าตาไม่เปลี่ยนเลย (เตรียมโครงสำหรับ Health score — ยังไม่มีหน้าจอของ set point)** 🆕
  - เปิด workspace เก่าที่มีโมเดลหลายชนิด (Individual, Relation model, Clustering อย่างละตัวขึ้นไป) ซึ่งเคย train / Mark complete ไว้บางตัว
  - เข้าแท็บ Failure Groups ที่ Dashboard แล้วเปิด Build Model ดูทุกตัว กด Train โมเดลหนึ่งตัวซ้ำ
  - ปิดเปิดโปรแกรมแล้วเปิด workspace เดิมอีกครั้ง
  - **คาดหวัง:** โมเดลครบเท่าเดิม ชื่อ/Failure Group/Category/สถานะ Complete/วันที่ train ตรงกับก่อนอัปเกรด · **ไม่มีอะไรใหม่ให้เห็นบนหน้าจอ** (เวอร์ชันนี้ยังไม่มีช่องกรอก set point หรือคะแนน Health — ที่เพิ่มมาเป็นแค่ที่เก็บข้อมูลในไฟล์ workspace) · ไม่มี error/toast แปลก ๆ · โมเดลไม่ถูกตีเป็น "stale" เพราะการอัปเกรดนี้ (ที่ Train ไว้แล้วยังเป็น Trained/Complete ตามเดิม)
  - (ตัวเลือกสำหรับคนที่อ่านไฟล์ได้) เปิดไฟล์ workspace ใน `%APPDATA%\com.prompt-solution.tauri-app\workspaces\` หลังเปิดแล้วมีการแก้อะไรสักอย่างในโปรแกรม จะเห็นคีย์ `healthSetPoints` ในแต่ละโมเดล (ค่าว่างทั้งหมด `null`)

---

## ERR

### ความผิดพลาด & ขอบ

- [ ] **ERR-1 — Toast แจ้ง error**
  - ทำให้ backend fail (เช่น ย้ายไฟล์ CSV ออกระหว่างใช้งาน)
  - **คาดหวัง:** ขึ้น toast บอก ไม่ใช่เงียบ — ในตัวติดตั้งไม่มี console ให้ดู toast จึงเป็นทางเดียว

- [ ] **ERR-2 — ไม่มีจอขาว**
  - ลองทำอะไรแปลก ๆ ให้ component พัง
  - **คาดหวัง:** ErrorBoundary จับไว้และแสดงข้อความ ไม่ใช่จอขาวเปล่า

- [ ] **ERR-3 — ไฟล์ log ถูกเขียนจริง**
  - หลังเจอ error ไปหาไฟล์ log ใน `%APPDATA%` ของแอป
  - **คาดหวัง:** มีบรรทัดของ error ที่เพิ่งเจอ พร้อมรายละเอียด

- [ ] **ERR-4 — ปิดหน้าต่างลูกด้วยปุ่ม X**
  - เปิด Add Special Sensor แล้วกด X
  - เปิด Build Model แล้วกด X
  - **คาดหวัง:** ปิดได้ทั้งคู่ ไม่ค้าง (เคยมีบั๊ก capability `core:window:allow-destroy` ที่เห็นเฉพาะตอนติดตั้งจริง)

- [ ] **ERR-5 — เปิดหน้าต่างลูกซ้ำ**
  - กด Add Special Sensor ซ้ำ ๆ ตอนหน้าต่างเปิดอยู่แล้ว
  - กด Build Model ซ้ำ ๆ ตอนหน้าต่างเปิดอยู่แล้ว
  - **คาดหวัง:** ไม่เปิดซ้อนกันหลายบาน — หน้าต่างเดิมถูกดึงขึ้นมาหน้าสุด ไม่ขึ้น error และข้อมูลไม่เพี้ยน

- [ ] **ERR-6 — ไม่ได้เลือก sensor เลย**
  - Clear all แล้วสลับ chart type ไปมา
  - **คาดหวัง:** กราฟว่างพร้อมข้อความ ไม่มี error

---

## PERF

### ประสิทธิภาพ

_ทำกับไฟล์ใหญ่จริงเท่านั้น_

- [ ] **PERF-1 — เปิดไฟล์ใหญ่**
  - import CSV ใหญ่สุดที่มี
  - จับเวลา
  - **คาดหวัง:** เสร็จภายในเวลาที่รับได้ ไม่ค้างจนต้อง force close

- [ ] **PERF-2 — โหลดกราฟและข้อมูลพร้อมกัน**
  - เลือก sensor เยอะ ๆ พร้อมกันทีเดียว
  - สลับ chart type ระหว่างที่ยังโหลดอยู่
  - **คาดหวัง:** ไม่ค้างและไม่ deadlock (เพิ่งเปลี่ยนจาก Mutex เป็น RwLock ให้อ่านพร้อมกันได้)

- [ ] **PERF-3 — สลับ Raw ↔ Avg บนข้อมูลใหญ่**
  - สลับไปมา 5 รอบ
  - **คาดหวัง:** แต่ละครั้งใช้เวลาใกล้เคียงกัน ไม่ค่อย ๆ ช้าลง

- [ ] **PERF-4 — RAM ไม่พุ่ง**
  - เปิด Task Manager ดู memory ของ Wizard
  - ใช้งานหนัก ๆ 10 นาที (สลับกราฟ เปลี่ยน filter สร้าง special sensor)
  - **คาดหวัง:** memory ไม่ไต่ขึ้นเรื่อย ๆ ไม่ลง (leak)

- [ ] **PERF-5 — ซูมเข้า/ออกถี่ ๆ**
  - ใช้ Horizontal zoom ลากซูมเข้าหลายชั้นแล้ว Zoom out สลับกันเร็ว ๆ
  - **คาดหวัง:** ภาพไม่กระตุก ไม่ค้าง ไม่ยิง request ท่วม backend (มี debounce 250ms ที่การเปลี่ยนช่วงเวลา)

- [ ] **PERF-6 — กราฟแกนเวลาเทียบกับเวอร์ชันเดิม** 👀
  - เลือกหลาย sensor บนข้อมูลใหญ่ แล้วสลับ aggregation / เลื่อนช่วงเวลา / ซูม
  - ถ้ามีเครื่องที่ลง 0.4.1 ไว้ ลองเทียบความรู้สึกกัน
  - **คาดหวัง:** ใช้งานได้ไม่ค้าง — **ทราบแล้วว่าช้ากว่าแกน category เดิมพอสมควร** (ECharts time axis ต้องทำงานมากกว่า ลองแก้ 2 วิธีแล้ว revert ทั้งคู่ เก็บไว้ใน BACKLOG ข้อ 21) จดเฉพาะกรณีที่ช้าจนใช้ไม่ไหว พร้อมจำนวน sensor / ขนาดไฟล์

---

## VIS

### กวาดหน้าตา (หลังล้าง CSS ที่ไม่ได้ใช้ และลบโค้ดตาย)

_ใน 0.5.0 ลบ CSS ที่ไม่มีใครอ้างถึงออกราว 3,200 บรรทัด (~7,000 → ~3,800) และลบไฟล์ frontend ที่ไม่มีใครเรียก 20 ไฟล์ (ตารางข้อมูลเก่า, หน้าต่าง Save As, คอมโพเนนต์อัปโหลดเก่า) — ตรวจแล้วว่าไม่มีคำสั่งเรียกใช้ แต่ **jsdom ไม่โหลด stylesheet เทสต์อัตโนมัติจึงจับ style ที่หายไม่ได้** ต้องดูด้วยตา_

- [ ] **VIS-1 — กวาดทุกหน้า/แท็บ/หน้าต่าง หา style ที่หาย** 🆕
  - เปิดไล่ทีละหน้า: Import (ทั้ง 3 ขั้น + แถบขั้นตอนซ้ายของ step 1–2 + รายการ Recent ที่หน้าแรก), Dashboard (ทั้ง 3 แผง, แท็บ Sensor / Selected Sensor / Filter / Highlights / Failure Groups), กราฟทั้ง 3 แบบ, Add Special Sensor (Create + Manage + ฟอร์มแก้ไข), Build Model (Workbench หน้า Model fit + หน้า Health score + Sub-models + modal ขยายกราฟ)
  - **คาดหวัง:** ไม่มีปุ่มที่กลายเป็นตัวหนังสือเปล่า ๆ ไม่มีช่องกรอกที่ไม่มีขอบ ไม่มีการ์ด/แผงที่พื้นหลังโปร่งจนอ่านทับกันไม่ออก ไม่มี layout ซ้อน/เว้นว่างผิดปกติ ตัวอักษรและระยะห่างสม่ำเสมอ — ถ้าเจอให้จดหน้าที่เห็น + ภาพหน้าจอ

- [ ] **VIS-2 — สถานะ hover / focus / disabled / dropdown / tooltip** 🆕
  - เอาเมาส์ชี้ปุ่ม แท็บ แถวในรายการ
  - กด Tab เดินผ่านช่องกรอก
  - ดูปุ่มที่ควรจาง (Save changes / Build Model → / Add sensor ตอนกรอกไม่ครบ)
  - เปิด dropdown ทุกชนิด (Component, ค้นหา sensor, เมนู Zoom, เมนูปุ่มสามจุดของ workspace) และ tooltip บนกราฟ
  - **คาดหวัง:** hover เปลี่ยนสี, focus เห็นกรอบชัด, ปุ่ม disabled จางและชี้แล้วไม่ขึ้นมือ, dropdown/tooltip มีพื้นทึบอ่านได้ ไม่ถูกตัดขอบ ไม่ทับกับเนื้อหาข้างหลัง

- [ ] **VIS-3 — รอบเร็วผ่านหน้า Import หลังลบคอมโพเนนต์อัปโหลดเก่า** 🆕
  - สร้างโปรเจกต์ใหม่ทุกขั้น (IMP-30 ถึง IMP-50 แบบย่อ): ตั้งชื่อ → อัปโหลด CSV 1 ไฟล์ → tag names → Continue → ตั้งชื่อ Failure group 1 กลุ่ม → Open Dashboard
  - **คาดหวัง:** ผ่านตลอดสายเหมือนเดิม ไม่มีปุ่ม/ขั้นตอนที่หาย (ไฟล์ที่ถูกลบเป็นตัวที่ไม่ได้ถูกเรียกใช้อยู่แล้ว แต่ต้องยืนยันด้วยการใช้จริง)

### Visual refresh (2026-10-02/03) — หน้าตาใหม่ตามมอคอัปที่อนุมัติ

_รอบนี้ปรับหน้าตาทั้งแอปตาม prototype (Phase 0–5) และแก้บั๊ก popover ที่ QA เจอ — **ฟังก์ชันเดิมต้องทำงานเหมือนเดิมทุกอย่าง** เทสต์อัตโนมัติจับ style จริงไม่ได้ (jsdom ไม่โหลด CSS) จึงต้องดูด้วยตา_

- [ ] **VIS-4 — popover ของแท็บ Sensor / Selected Sensor ไม่ปิดเอง ไม่ล้นจอ ไม่ซ้อนกัน** 🆕
  - แท็บ Sensor: เปิด popover 🔔 Alarm setpoints ของ sensor หนึ่งตัว แล้วเลื่อนเมาส์/ลูกกลิ้งอยู่ใน popover
  - เปิด popover ของ sensor ที่อยู่ใกล้ขอบล่าง/ขอบขวาของหน้าต่าง
  - เปิด popover 🔔 ค้างไว้ แล้วเปิดอีกตัวในแถวเดียวกัน
  - แท็บ Selected Sensor: เปิด popover เปลี่ยนสีเส้น และ Pin Y-axis แล้วพิมพ์ตัวเลขยาวๆ ในช่อง min/max
  - เลื่อนลิสต์ sensor ขณะ popover เปิดอยู่
  - **คาดหวัง:** เลื่อนอยู่ใน popover ไม่ทำให้ popover ปิด; popover อยู่ในจอเสมอ (กลับด้านบนเมื่อใกล้ขอบล่าง); เปิดตัวใหม่ในแถวเดียวกันแล้วตัวเก่าปิด (ไม่ซ้อนกัน); พิมพ์ยาวๆ ไม่ทำให้ popover ปิดหรือค่าหาย; เลื่อนลิสต์ข้างนอก popover แล้ว popover ปิด (ไม่ลอยค้างผิดตำแหน่ง)

- [ ] **VIS-5 — popover ไม่กลับมาโผล่ที่ตำแหน่งเก่าหลังแถวหาย/สลับชนิดกราฟ** 🆕
  - เปิด popover ของ sensor แล้วยุบ component นั้น แล้วกางใหม่
  - เปิด popover แล้วพิมพ์ค้นหาจน sensor นั้นหายจากลิสต์ แล้วล้างช่องค้นหา
  - แท็บ Selected Sensor: เปิด popover สี/Pin Y-axis แล้วสลับ Line → Scatter → Line
  - แท็บ Highlights: เปิด popover สีของ highlight แล้วสลับ Line → Pair Plot → Line และ Line → Scatter
  - เปิดช่องเปลี่ยนชื่อ highlight ค้างไว้ (พิมพ์ครึ่งๆ) แล้วสลับ Line → Pair Plot → Line
  - **คาดหวัง:** ทุกกรณี popover ปิดไปเลย ไม่กลับมาโผล่ที่ตำแหน่งเดิม/ผิดที่; ช่อง rename ที่พิมพ์ค้างไว้ถูกล้าง ไม่โผล่มาพร้อมข้อความเก่า; ทั้งหมดต้องไม่ error

- [ ] **VIS-6 — แถบ Time range เป็นแถวเดียว ช่องวันที่เห็นเต็ม** 🆕
  - ดูแถบใต้กราฟ (Dashboard)
  - ลองพิมพ์/เลือกวันที่เริ่ม-จบ, กรอก "Last N" + กดปุ่ม Y/M/W/D/H แล้ว Apply
  - เปลี่ยน Aggregation แล้วกด Reset period
  - ย่อหน้าต่างให้แคบลง
  - **คาดหวัง:** ทุกอย่างอยู่แถวเดียว (ไม่มีป้าย "TIME RANGE" ตัวพิมพ์ใหญ่ ไม่มีบรรทัด "Date: … – …" ซ้ำ); ช่องวันที่แสดงเต็ม เช่น "01/08/2026 12:00 AM" ไม่ถูกไอคอนปฏิทินทับหรือตัดคำ และกดช่องแล้วเปิดตัวเลือกวันที่ของเบราว์เซอร์ได้; ลำดับ: ช่วงวันที่ → Last N → Y/M/W/D/H → Aggregation → Reset period → ขวาสุดบอกช่วงข้อมูลทั้งหมด "Data … → …"; Reset period คืนแค่ช่วงเวลา ไม่เปลี่ยน Aggregation; หน้าต่างแคบแล้วแถวขึ้นบรรทัดใหม่ ไม่ล้น

- [ ] **VIS-7 — แท็บ Filter: หนึ่งเงื่อนไขต่อหนึ่งแถว + ปุ่ม Apply** 🆕
  - เลือก sensor 2 ตัว เปิดแท็บ Filter กด Add condition
  - เปลี่ยน operator ด้วยปุ่ม > < = ↔ (ตัวหลังคือ between) และกรอกค่า
  - ตั้ง between 10–50 แล้วเปลี่ยนเป็น ">" แล้วกด Apply filter
  - พิมพ์เงื่อนไขค้างไว้ (ยังไม่ Apply) แล้วกด Reset period ที่แถบเวลา
  - **คาดหวัง:** แต่ละเงื่อนไขเป็นแถวเดียว (sensor · ปุ่ม operator 4 ปุ่ม · ค่า · ช่องค่าที่สองเฉพาะ between · ปุ่มลบ); ปุ่ม Apply filter กดได้เฉพาะเมื่อมีการเปลี่ยน และมีข้อความ "Changes not applied yet" สีเตือน; หลัง Apply ขึ้นจำนวนแถวที่ผ่าน; เปลี่ยนจาก between เป็น ">" แล้วค่า max เดิมไม่ถูกส่งไปกรอง; Reset period/แก้ช่วงเวลาไม่ล้างเงื่อนไขที่พิมพ์ค้างไว้

- [ ] **VIS-8 — แท็บ Highlights: สองคอลัมน์ By time | By value** 🆕
  - เปิดแท็บ Highlights ที่กราฟแบบ Line, Scatter และ Pair Plot ตามลำดับ
  - เพิ่ม/เปิดปิด/เปลี่ยนสี/เปลี่ยนชื่อ/ลบ highlight ทั้งแบบ By time และ By value
  - **คาดหวัง:** เห็นสองคอลัมน์พร้อมกัน คั่นด้วยเส้นแนวตั้ง; Pair Plot: คอลัมน์ By time จางและมีข้อความบอกว่า Pair Plot ใช้กลุ่ม lasso ของตัวเอง; ไม่ใช่ Scatter: คอลัมน์ By value จางและบอก "Only affects Scatter"; ฟังก์ชันทุกอย่างทำงานเหมือนเดิม

- [ ] **VIS-9 — แท็บ Sensor หน้าตาใหม่** 🆕
  - ดูแถว sensor และหัว component
  - ติ๊ก sensor หลายตัวใน component เดียว
  - **คาดหวัง:** ป้ายหน่วย (เช่น KW) อยู่ติดท้ายชื่อ sensor; ตัวนับที่หัว component เป็น "เลือก / ทั้งหมด" เช่น 2 / 8; ปุ่ม 🔔 และ 📁 เห็นตลอดในแถว; ช่องค้นหา/แถบ "N sensors selected" ตามมอคอัป; ปุ่ม/ช่องกรอกมีขอบและพื้นชัด ไม่เป็นตัวหนังสือเปล่า

- [ ] **VIS-10 — แท็บ Failure Groups หน้าตาใหม่ + legend ตรงกับจุดจริง** 🆕
  - เปิดแท็บ Failure Groups ที่มี model หลายสถานะ (ยังไม่ train / Trained / Complete)
  - **คาดหวัง:** โครงเดียวกับแท็บ Sensor (ค้นหา → ชิปสรุป → แถวกลุ่มพร้อมจำนวน done/total → แถว sensor + ป้าย I/R/C); legend "Not trained" **ไม่มีจุด** (ข้อความอย่างเดียว) ตรงกับป้ายจริงที่ยังไม่เคย train ไม่มีจุด; Trained = จุดฟ้า, Complete = จุดเขียว; มีข้อความ "Saved automatically" ตอนแก้รายละเอียดกลุ่ม; footer มีช่องสร้างกลุ่ม + ปุ่ม Build Model →

- [ ] **VIS-11 — Build Model Workbench: หน้าตาและสีกราฟโทนเดียวกับ Dashboard** 🆕
  - เปิด Build Model, เลือก model Relation model และ Clustering แล้ว Train ให้เห็นกราฟผลลัพธ์
  - เทียบสีกราฟกับกราฟเส้นบน Dashboard
  - **คาดหวัง:** พื้นหลังกราฟ เส้นกริด ตัวหนังสือแกน และ tooltip โทนเดียวกับ Dashboard (ไม่มีโทนน้ำเงินกรมท่าเก่าปนอยู่); แถบเลือก sensor ซ้าย/รายละเอียดขวา/ตัวกรองชิป/แถบความคืบหน้าดูเป็นชุดเดียวกัน; ปุ่มปิดข้างในหน้าต่างและพื้นหลัง modal มืด+เบลอเล็กน้อยสม่ำเสมอ

- [ ] **VIS-13 — หน้าต่าง Add Special Sensor: หน้าตาใหม่ + ขนาดขั้นต่ำ** 🆕
  - เปิดหน้าต่าง Add Special Sensor แล้วดูแท็บ Create และ Manage
  - ย่อหน้าต่างให้แคบที่สุดเท่าที่ทำได้
  - **คาดหวัง:** แท็บ Create/Manage อยู่ที่หัวข้างชื่อ "Special Sensors"; Create แบ่งสองฝั่ง ซ้ายเป็นรายการ sensor กว้างคงที่ (~320px) แถวที่เลือกแล้วมีป้าย "added" ที่ยังไม่เลือกมีไอคอน +; ขวามีกล่อง Source sensors, การ์ด operation, บรรทัดสูตรตัวอย่าง, ช่อง Name/Unit/Description/Component; footer: ข้อความบอกว่าขาดอะไร + Cancel + Add sensor; ย่อแคบสุดแล้วยังใช้งานได้ (ฝั่งขวาไม่แคบจนเหลือศูนย์) และ footer กับหัวไม่เลื่อนหาย; เปิดครั้งแรกไม่ขึ้นหน้าว่าง

- [ ] **VIS-14 — popup เลือก Failure Group เดิมถูกแทนที่แล้ว (ชื่อกลุ่มยาวต้องอ่านออก)** 🆕
  - สร้างกลุ่มที่ชื่อยาวมาก (เช่น "generator mechanical condition") แล้วกด 📁 ที่ sensor
  - **คาดหวัง:** ไม่มี popup เล็กใต้ปุ่มเหมือนเดิมแล้ว — ขึ้นเป็นแผงตามข้อ SEN-12 ถึง SEN-21 ที่แสดงชื่อกลุ่มยาวได้ ไม่ถูกตัดจนอ่านไม่ออก

- [ ] **VIS-16 — ตัวเลือก sensor ที่เปิดใกล้ขอบจอ: ไม่ซ่อนใต้แถบหัวหน้าต่าง และช่องค้นหาไม่ขยับ** 🆕
  - ย่อหน้าต่าง Dashboard ให้เตี้ย แล้วเปิดตัวเลือก sensor ในแถว filter ที่อยู่ล่างสุดของจอ (มันจะเปิด**ขึ้นข้างบน**)
  - พิมพ์ค้นหาทีละตัวอักษร และกดเปิด-ปิดกลุ่ม component
  - ลองเปิดตัวเลือก sensor / ตัวเลือกสี ที่อยู่ใกล้ขอบบนของหน้าต่าง
  - **คาดหวัง:** เมื่อเปิดขึ้นข้างบน ช่องค้นหาอยู่กับที่ ไม่กระโดดลงไปข้างล่างระหว่างพิมพ์ · ไม่มีส่วนไหนของตัวเลือกไปซ่อนใต้แถบหัวหน้าต่าง (title bar สูง 32 px) · ตัวเลือกไม่ปิดเองทันทีที่เปิด (เคอร์เซอร์อยู่ในช่องค้นหา)

- [ ] **VIS-15 — ชื่อ/ตัวเลือก sensor และตัวเลือกสีในหน้าต่างแคบและฟอนต์ของตัวติดตั้ง (Segoe UI / Consolas)** 🆕
  - บนตัวติดตั้ง ย่อหน้าต่าง Dashboard และ Build Model ให้แคบ (~900 px)
  - เปิดตัวเลือก sensor ในแท็บ Filter, Highlights, Scatter และในแถวเงื่อนไข Running condition
  - เปิดตัวเลือกสีในแท็บ Selected Sensor ใกล้ขอบล่างของจอ
  - **คาดหวัง:** ช่องเลือกที่แคบมาก (< ~150 px) ซ่อน tag เหลือแค่ description (ชี้แล้วเห็นชื่อเต็ม) · ในรายการที่แคบ (< ~320 px) ป้ายหน่วยหายแต่ยังค้นด้วยหน่วยได้ · popover กว้างไม่เกิน 420 px / 92% ของจอ และเปิดขึ้นด้านบนเมื่ออยู่ใกล้ขอบล่าง · ไม่มีข้อความทับกันหรือล้นกรอบ · โฟกัสคีย์บอร์ดเห็นกรอบสีฟ้าชัดเจนบนช่องสี (ไม่ถูกวงของสีปัจจุบันบัง)

---

## ของที่รู้อยู่แล้ว — ไม่ต้องรายงาน

- ชื่อไฟล์ exe ที่ติดตั้งคือ `tauri-app.exe` ไม่ใช่ `Wizard.exe` — รู้อยู่แล้ว (BACKLOG ข้อ 17)
- Moving Average / Rate of Change ถูกถอดออกจากรายการ operation แล้ว เพราะไม่เคยมีการคำนวณจริงอยู่เบื้องหลัง
- Line chart แสดงภาพย่อ (downsampled) เสมอแม้อยู่โหมด Raw — ยังไม่มีทางดูทุกแถวจริงนอกจากย่อช่วงเวลา (BACKLOG ข้อ 10 เลื่อนไว้)
- แท็บ "Data Insight" (ตารางข้อมูลดิบ) ถูกเอาออกไปตั้งแต่ 2026-08-16 — ไม่ใช่ของหาย
- **หน้า Build Model ไม่มีปุ่ม Report / Preview / Save Model — ตั้งใจ** (เอาออกตามที่สั่ง 2026-09-17) ไฟล์โมเดล (`INDV_INFO` / `REL_INFO` / `CLUS_INFO`) ถูกเขียนโดยปุ่ม **Mark complete** ในหน้า Health score เท่านั้น (BMW-158) — ไม่มีปุ่มเซฟแยกต่างหาก
- กราฟเส้นแกนเวลาช้ากว่าแกน category เดิมพอสมควร — ลองแก้แล้ว 2 วิธีแต่ revert ทั้งคู่ (BACKLOG ข้อ 21, Notion: "Line chart time-axis ช้ากว่า category axis เดิม")
- การกลับจากแท็บ Failure Groups ที่บางครั้งเด้งไปหน้าเริ่มโปรแกรม (FG-6) — ยังไม่ได้ทำ
- **ข้อจำกัดของการแก้บั๊กหลายโปรเจกต์ (0.5.0):** การเปลี่ยนชื่อ workspace ยังเป็น event แบบ global ไม่ระบุโปรเจกต์ และข้อมูลใน Rust มีชุดเดียวใช้ร่วมกันทุกหน้าต่าง — วิธีกันคือปิดหน้าต่างลูกทุกบานตอนสลับโปรเจกต์ (MULTI-1) และ (ตั้งแต่ 2026-10-03) คำสั่งสร้าง/แก้/ลบ special sensor ผูกกับ generation ของ dataset จึงถูกปฏิเสธเองถ้าหน้าต่างลูกค้างอยู่ (MULTI-8..11); คำสั่งอื่นของหน้าต่างที่ค้าง (เช่น Build Model) ยังไม่ผูก; และ race ตอนเขียนไฟล์ workspace ข้ามหน้าต่างยังเหลือโอกาสน้อยมากในทางทฤษฎี (MULTI-7)
- คำเตือน bundle ของ echarts เกิน 500kB ตอน build — ไม่กระทบการใช้งาน (BACKLOG ข้อ 9)
- **Health score ราย 1 ชั่วโมง — ช่วง Scoring / Train ที่ "เริ่มกลางชั่วโมง" (เช่น 04:30):** จุดของชั่วโมงแรกอยู่ที่ต้นชั่วโมง (04:00) และค่า "Lowest … on …" อาจอ่านเวลาได้เร็วกว่าเวลาเริ่มของช่วงไม่เกิน 1 ชั่วโมง — เป็นไปตามกติกา (จุดรายชั่วโมงวางที่ต้นชั่วโมง) บนหน้า Health score แถบสีของช่วงจึงเริ่มที่ต้นชั่วโมงนั้น (04:00) เพื่อให้จุดแรกถูกวาด ไม่ใช่ที่ 04:30
- **CSV ที่เวลาลงท้ายด้วย `Z`** (เช่น `2026-02-09T23:50:00Z`): โปรแกรมยังอ่านเวลารูปนี้ไม่ได้ แถวเหล่านั้นจึงไม่อยู่ในชั่วโมงใด — ไม่มีจุดบนหน้า Health score และไม่อยู่ในช่วง Train / Scoring ใด (เวลาที่มี offset เช่น `+07:00` และรูป `2025/01/01 00:05:00` ใช้ได้ปกติ) — รู้แล้ว ยังไม่ได้แก้
