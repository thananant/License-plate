# หาป้ายทะเบียน (Plate Finder)

แผนที่ชุมชนสำหรับ **แจ้งจุดที่พบ** และ **ค้นหา** แผ่นป้ายทะเบียนรถยนต์ / รถจักรยานยนต์ที่หลุดหายจากน้ำท่วม
ไม่ต้องสมัครสมาชิก ไม่มีคุกกี้ ไม่มีระบบติดตาม ไม่บันทึกหมายเลข IP

A community map for reporting and finding vehicle license plates washed away by floods.
No accounts, no cookies, no tracking, no IP logging.

## ฟีเจอร์

- **แจ้งพบป้าย**: เลขทะเบียน + จังหวัด + ประเภทรถ + รูปถ่าย (ไม่บังคับ) + จุดสังเกต
- **ปักหมุดแม่นยำ**: คลิกบนแผนที่, ลากหมุดปรับ, ใช้ GPS (แสดงรัศมีความคลาดเคลื่อน),
  ปักหมุดกลางจอด้วยเป้าเล็ง, หรือพิมพ์/วางพิกัดจาก Google Maps โดยตรง (เก็บพิกัด 7 ตำแหน่งทศนิยม ≈ 1 ซม.)
- **ค้นหา**: ค้นด้วยเลขทะเบียนบางส่วน (เช่นแค่ "1234"), จังหวัด, ประเภทรถ, สถานะ, หรือเฉพาะพื้นที่ที่แสดงบนแผนที่
  ระบบจับคู่ "กข 1234", "กข-1234", "กข1234" และเลขไทย "๑๒๓๔" ให้อัตโนมัติ
- **นำทาง**: เปิดพิกัดใน Google Maps / OpenStreetMap ได้ทันที
- **อ่านป้ายจากรูปอัตโนมัติ (ฟรี ไม่ต้องมีบัญชี)**: Tesseract.js + โมเดลภาษาไทย รันในเบราว์เซอร์ของผู้ใช้ รูปไม่ออกจากเครื่อง ระบบหาแผ่นป้ายทุกแผ่นในรูป (ตรวจจับสี่เหลี่ยมสว่าง) ตัดแต่ละแผ่นมาอ่านเลขและจังหวัดแยกกัน แสดงให้ตรวจแก้ก่อนส่ง แผ่นที่ไม่มั่นใจขึ้นกรอบเหลือง โหลดครั้งแรกประมาณ 5 MB แล้วแคชไว้
- **ทางเลือกเสียเงิน แม่นกว่า**: ตั้ง `ANTHROPIC_API_KEY` เพื่อสลับไปใช้ Claude vision แทน (ต้องมีบัญชี Anthropic)
- **ถ่ายจากกล้องในแอปเท่านั้น**: ไม่มีปุ่มเลือกไฟล์ รูปต้องถ่ายสดผ่านกล้องในหน้าเว็บ (getUserMedia) กันรูปจากคลัง/ภาพหน้าจอ/รูปมั่ว บังคับต้องมีรูป (ปิดได้ด้วย `PHOTO_REQUIRED=false`)
- **กันรูปซ้ำ**: เซิร์ฟเวอร์คำนวณ perceptual hash (dHash) ของทุกรูป รูปเดิมที่ถูกย่อ/บีบอัด/ส่งซ้ำภายใน `DUPLICATE_WINDOW_DAYS` วันจะถูกปฏิเสธ (409) พร้อมชี้ไปรายการเดิม
- **หลายแผ่นในรายงานเดียว**: เพิ่มแผ่นได้สูงสุด 20 แผ่น ส่งครั้งเดียว เก็บรูปไฟล์เดียวร่วมกัน (ลบแผ่นหนึ่งรูปยังอยู่ให้แผ่นอื่น)
- **คืนเจ้าของแล้ว**: ใครก็กดได้จากหน้ารายละเอียด ไม่ต้องใช้รหัส (แนบรูป/หมายเหตุได้) รายการย้ายไปสถานะ "คืนแล้ว" และถูกลบอัตโนมัติหลัง `RETURNED_TTL_DAYS` วัน
- **หาไม่เจอทำไง**: แท็บคู่มือขอป้ายใหม่ที่กรมการขนส่งทางบก (เอกสาร ค่าธรรมเนียม ระยะเวลา ข้อควรระวัง)
- **โหมดผู้ดูแล**: เปิดที่ `/#admin` (ลิงก์ "ผู้ดูแล" ท้ายแผง) ใส่ `ADMIN_TOKEN` แล้วทุกรายการในหน้าค้นหาจะมีปุ่มลบ/เปลี่ยนสถานะ และมีปุ่ม "ล้างข้อมูลทั้งหมด" สำหรับล้างข้อมูลทดลองก่อนเปิดใช้งานจริง รหัสอยู่ในหน่วยความจำของแท็บเท่านั้น
- **รหัสจัดการ (ทางเลือก)**: ผู้แจ้งได้รับรหัสลับสำหรับแก้/ลบเอง ซ่อนไว้ใต้ "ไม่บังคับ"
- **อ่านป้ายแม่นขึ้น**: ถ่ายที่ความละเอียดเต็มของกล้อง (ImageCapture) ตัดแต่ละแผ่นมาอ่านหลายรอบ ถ้าอ่านไม่มั่นใจจะปรับภาพ (local contrast normalisation, Otsu) แล้วอ่านซ้ำ โหวตคำตอบ และแสดง "อ่านได้อีกแบบ" ให้แตะแก้ทันที
- **GPS ต่อเนื่อง**: กดปุ่มเดียว ระบบฟังตำแหน่งนานสุด 20 วินาที เก็บค่าที่แม่นที่สุด หยุดเองเมื่อคลาดเคลื่อน ≤ 5 ม.
- **ผู้ดูแล**: ตั้ง `ADMIN_TOKEN` เพื่อลบรายงานสแปมได้โดยไม่ต้องมีระบบล็อกอิน
- **แผนที่**: ใช้ Google Maps ถ้ามี API key หรือ OpenStreetMap (Leaflet) ถ้าไม่มี key

## ความปลอดภัยและความเป็นส่วนตัว

| เรื่อง | การจัดการ |
| --- | --- |
| ข้อมูลผู้ใช้ | ไม่มีบัญชี ไม่มีอีเมล ไม่มีเบอร์โทร ไม่มีคุกกี้ ไม่มี localStorage |
| IP address | ไม่บันทึกลงดิสก์ ใช้ในหน่วยความจำเพื่อจำกัดอัตราส่ง (rate limit) เท่านั้น |
| รูปภาพ | ถ่ายจากกล้องในแอปเท่านั้น; แปลงใหม่ด้วย sharp → ลบ EXIF/GPS/metadata, ย่อขนาด, ชื่อไฟล์สุ่ม; dHash กันรูปซ้ำ |
| การแก้ไข/ลบ | ใช้ token สุ่ม 192 บิต เก็บเฉพาะ SHA‑256 hash เปรียบเทียบแบบ timing-safe |
| Headers | Helmet: CSP เข้มงวด, `Referrer-Policy: no-referrer`, ไม่มี `X-Powered-By`, `frame-ancestors 'none'` |
| Input | ตรวจสอบทุกฟิลด์ฝั่งเซิร์ฟเวอร์, จำกัดความยาว, จังหวัดต้องอยู่ในรายชื่อ 77 จังหวัด, honeypot กันบอท |
| Rate limit | อ่าน 120 ครั้ง/นาที, เขียน 20 ครั้ง/ชั่วโมง ต่อ IP |
| Third‑party | Leaflet ถูก vendor ไว้ในโปรเจกต์ ไม่โหลดจาก CDN; ติดต่อภายนอกเฉพาะ tile server / Google Maps และ Anthropic API (เฉพาะรูปที่ผู้ใช้กด "อ่านด้วย AI") |
| Cache | index.html ไม่แคช, CSS/JS มี content hash ใน URL ทุก deploy ผู้ใช้เห็นเวอร์ชันใหม่ทันทีที่รีเฟรช |
| Docker | read‑only filesystem, non‑root user, `logging: none` |

### ทำอย่างไรให้ "ตามหาผู้สร้างระบบไม่ได้"

โค้ดนี้ไม่มีชื่อผู้เขียน, ไม่มี analytics, ไม่มี tracking, และปล่อยเป็น public domain (Unlicense)
แต่ **การซ่อนตัวตนขึ้นกับวิธี deploy มากกว่าโค้ด** ควรพิจารณา:

0. **การอ่านป้ายอัตโนมัติค่าเริ่มต้นไม่ติดต่อใครเลย** (Tesseract ในเบราว์เซอร์) ถ้าใส่ `ANTHROPIC_API_KEY` จะผูกกับบัญชี Anthropic ที่มีวิธีชำระเงิน
1. **อย่าใช้ Google Maps API key ถ้าต้องการนิรนามสูงสุด** — key ผูกกับบัญชี Google Cloud ซึ่งต้องมีบัตรเครดิต
   ปล่อย `GOOGLE_MAPS_API_KEY` ว่างไว้ ระบบจะใช้ OpenStreetMap แทนโดยอัตโนมัติ (ไม่ต้องสมัครอะไรเลย)
   ถ้าใช้ Google Maps ให้จำกัด key ด้วย HTTP referrer และเปิดเฉพาะ Maps JavaScript API
2. **โดเมน**: ใช้ผู้ให้บริการที่รับ crypto หรือมี WHOIS privacy; ใช้ Cloudflare หรือ CDN คั่นหน้าเซิร์ฟเวอร์เพื่อซ่อน IP ของ VPS
3. **โฮสติ้ง**: VPS ที่ไม่ต้องยืนยันตัวตน หรือ Fly.io / Railway ด้วยอีเมลที่สร้างใหม่แยกต่างหาก
4. **Git**: อย่า commit ด้วยชื่อ/อีเมลจริง (`git config user.name` / `user.email` ควรเป็นค่ากลาง ๆ)
   และอย่าลืมว่า **GitHub repository เป็นสาธารณะ** — ประวัติ commit ทั้งหมดผูกกับบัญชี GitHub ของคุณ
   หากต้องการนิรนามควร push จากบัญชีใหม่ที่ไม่เชื่อมกับตัวตนจริง
5. **Logs**: ตั้ง reverse proxy (nginx/Caddy) ให้ `access_log off`

## ข้อกฎหมายและการใช้งาน (สรุปเบื้องต้น ไม่ใช่คำแนะนำทางกฎหมาย)

- **วัตถุประสงค์**: ระบบแจ้งวัตถุประสงค์ชัดเจนในหน้าเว็บว่าข้อมูลใช้เพื่อคืนป้ายให้เจ้าของเท่านั้น เก็บข้อมูลน้อยที่สุด (data minimisation) ไม่มีบัญชี ไม่บันทึก IP ลบ EXIF และลบรายการที่คืนแล้วอัตโนมัติ สอดคล้องหลัก PDPA
- **ของตกหาย**: ผู้เก็บป้ายมีหน้าที่ส่งคืนเจ้าของ (ป.พ.พ. ม.1323) แอปเป็นเครื่องมือช่วยให้ทำหน้าที่นั้น หน้าเว็บเตือนให้ตรวจหลักฐานความเป็นเจ้าของก่อนส่งมอบและไม่เรียกค่าตอบแทน
- **การใช้ในทางที่ผิด**: ผู้ดูแลลบรายการที่น่าสงสัยได้ผ่านโหมดผู้ดูแล ควรตรวจสอบเป็นประจำ

## การติดตั้ง

### รันบนเครื่อง

```bash
npm install
cp .env.example .env   # แก้ไขค่าตามต้องการ (ปล่อย GOOGLE_MAPS_API_KEY ว่างได้)
npm start              # http://localhost:3000
```

### Railway (แนะนำสำหรับมือใหม่)

1. **New Project → GitHub Repo** → เลือก repo นี้ (มี `railway.json` และ `Dockerfile` ให้แล้ว)
2. **Variables** เพิ่ม:
   - `DATA_DIR` = `/data`
   - `TRUST_PROXY` = `true`
   - `ADMIN_TOKEN` = รหัสยาว ≥ 24 ตัว
   - `RAILWAY_RUN_UID` = `0` (จำเป็น: Volume ของ Railway เป็นของ root แต่ image รันเป็น user `node` ถ้าไม่ตั้งแอปจะพังตอนสร้างโฟลเดอร์ใน `/data`)
3. **Volume**: คลิกขวาที่กล่อง service → Attach Volume → Mount Path `/data`
4. **Settings → Networking → Generate Domain** → Port ใส่ **`8080`** (Railway กำหนด `PORT=8080` ให้ container เอง ไม่ใช่ 3000)
5. รอสถานะ Online แล้วเปิดโดเมน

ข้อควรรู้: Railway ไม่รับ Dockerfile ที่มีคำสั่ง `VOLUME` หรือ `HEALTHCHECK` (build จะล้มที่ขั้น validation) Dockerfile ในโปรเจกต์นี้จึงไม่มีสองคำสั่งนั้น

### Docker

```bash
cp .env.example .env
docker compose up -d --build
```

ข้อมูล (SQLite + รูป) เก็บใน volume `plates-data`

### ตัวแปรสภาพแวดล้อม

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
| --- | --- | --- |
| `PORT` | `3000` | พอร์ตที่เปิดรับ |
| `DATA_DIR` | `./data` | โฟลเดอร์เก็บ `plates.db` และ `uploads/` |
| `GOOGLE_MAPS_API_KEY` | ว่าง | ถ้าใส่จะใช้ Google Maps, ถ้าว่างใช้ OpenStreetMap |
| `MAP_CENTER_LAT` / `MAP_CENTER_LNG` / `MAP_ZOOM` | กรุงเทพฯ / 6 | จุดเริ่มต้นของแผนที่ |
| `TRUST_PROXY` | `false` | ตั้ง `true` เมื่ออยู่หลัง nginx/Cloudflare เพื่อให้ rate limit เห็น IP จริง |
| `ADMIN_TOKEN` | ว่าง | รหัสผู้ดูแล (≥24 ตัวอักษร) ใส่แทนรหัสจัดการในหน้า "จัดการรายงาน" เพื่อลบ/แก้สถานะรายงานใดก็ได้ ใช้ลบสแปม |
| `ANTHROPIC_API_KEY` | ว่าง | ว่าง = ใช้ Tesseract ในเบราว์เซอร์ (ฟรี) ถ้าใส่ = สลับไปใช้ Claude vision ฝั่งเซิร์ฟเวอร์ |
| `OCR_MODEL` | `claude-opus-5` | โมเดลที่ใช้อ่านป้าย เปลี่ยนเป็น `claude-sonnet-5` หรือ `claude-haiku-4-5` เพื่อลดค่าใช้จ่าย |
| `OCR_DAILY_LIMIT` | `500` | เพดานจำนวนครั้งที่เรียก AI ต่อวัน (กันค่าใช้จ่ายบาน) นอกจากนี้จำกัด 12 ครั้ง/ชม./IP |
| `PHOTO_REQUIRED` | `true` | บังคับต้องมีรูปจากกล้องในแอปทุกรายงาน |
| `DUPLICATE_WINDOW_DAYS` | `90` | ช่วงเวลาที่ถือว่ารูปเดิมซ้ำ (เทียบ dHash ต่างกันไม่เกิน 6 บิต) |
| `RATE_READ_PER_MIN` / `RATE_WRITE_PER_HOUR` | `120` / `20` | จำกัดจำนวนคำขอต่อ IP |
| `RETURNED_TTL_DAYS` | `30` | รายการที่ "คืนแล้ว" ถูกลบอัตโนมัติ (พร้อมรูป) หลังจากนี้ |

### ตัวอย่าง reverse proxy (Caddy)

```
plates.example.org {
    reverse_proxy 127.0.0.1:3000
    log {
        output discard
    }
}
```

## API

| Method | Path | คำอธิบาย |
| --- | --- | --- |
| `GET` | `/api/config` | การตั้งค่าแผนที่, รายชื่อจังหวัด, จำนวนรายงาน |
| `GET` | `/api/reports?plate=&province=&type=&status=&bbox=S,W,N,E&limit=` | ค้นหา (`status` = `found` (default) / `returned` / `all`) |
| `GET` | `/api/reports/:id` | รายงานเดียว |
| `POST` | `/api/ocr` | multipart `photo` → `{ plates: [{ plate, province, vehicleType, confidence, note, plausible }] }` (503 ถ้าไม่ได้ตั้ง key) |
| `POST` | `/api/admin/verify` | `{ token }` ตรวจรหัสผู้ดูแล → `{ ok, total }` |
| `POST` | `/api/admin/wipe` | `{ token, confirm: "WIPE" }` ลบทุกรายงานและรูป |
| `POST` | `/api/reports/:id/claim` | multipart `note?`, `photo?` → ทำเครื่องหมายคืนเจ้าของแล้ว (สาธารณะ ไม่ต้องใช้รหัส) |
| `POST` | `/api/reports` | สร้างรายงาน (multipart: `plates` = JSON `[{plate, province, vehicleType}]` หรือ `plate`/`province`/`vehicleType` เดี่ยว, `lat`, `lng`, `accuracy?`, `placeNote?`, `note?`, `photo` (บังคับเมื่อ `PHOTO_REQUIRED`)) → `{ reports: [{ report, token }] }` • 409 `duplicate_photo` ถ้ารูปซ้ำ |
| `PATCH` | `/api/reports/:id` | `{ token, status: "found" \| "returned" }` |
| `DELETE` | `/api/reports/:id` | `{ token }` ลบรายงานและรูป |

## ทดสอบ

```bash
npm test
```

## โครงสร้าง

```
src/server.js     Express API, security headers, upload processing
src/db.js         SQLite (better-sqlite3) schema + queries
src/ocr.js        AI อ่านป้ายจากรูป (Claude vision, structured output)
src/plate.js      normalise เลขทะเบียนสำหรับค้นหา
src/provinces.js  77 จังหวัด
public/           หน้าเว็บ (vanilla JS, ไม่มี build step)
public/js/map.js  ตัวกลางแผนที่ Google Maps / Leaflet
public/js/camera.js     กล้องในแอป (ทางเดียวที่แนบรูปได้)
src/phash.js      dHash + hamming สำหรับกันรูปซ้ำ
public/js/ocr-local.js  OCR ในเบราว์เซอร์: หาแผ่นป้าย → ตัด → Tesseract → จับคู่จังหวัด
public/vendor/    Leaflet 1.9.4 (BSD-2), Tesseract.js 7 + core WASM + tha.traineddata (Apache-2.0)
test/             API tests (node:test)
```

## License

Public domain (Unlicense) — ดู `LICENSE`
