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
- **จัดการรายงาน**: ผู้แจ้งได้รับรหัสลับ 1 ชุดสำหรับทำเครื่องหมาย "คืนเจ้าของแล้ว" หรือลบรายงาน ไม่ต้องมีบัญชี
- **แผนที่**: ใช้ Google Maps ถ้ามี API key หรือ OpenStreetMap (Leaflet) ถ้าไม่มี key

## ความปลอดภัยและความเป็นส่วนตัว

| เรื่อง | การจัดการ |
| --- | --- |
| ข้อมูลผู้ใช้ | ไม่มีบัญชี ไม่มีอีเมล ไม่มีเบอร์โทร ไม่มีคุกกี้ ไม่มี localStorage |
| IP address | ไม่บันทึกลงดิสก์ ใช้ในหน่วยความจำเพื่อจำกัดอัตราส่ง (rate limit) เท่านั้น |
| รูปภาพ | แปลงใหม่ทั้งหมดด้วย sharp → ลบ EXIF/GPS/metadata ทิ้ง, ย่อขนาด, ตั้งชื่อไฟล์แบบสุ่ม |
| การแก้ไข/ลบ | ใช้ token สุ่ม 192 บิต เก็บเฉพาะ SHA‑256 hash เปรียบเทียบแบบ timing-safe |
| Headers | Helmet: CSP เข้มงวด, `Referrer-Policy: no-referrer`, ไม่มี `X-Powered-By`, `frame-ancestors 'none'` |
| Input | ตรวจสอบทุกฟิลด์ฝั่งเซิร์ฟเวอร์, จำกัดความยาว, จังหวัดต้องอยู่ในรายชื่อ 77 จังหวัด, honeypot กันบอท |
| Rate limit | อ่าน 120 ครั้ง/นาที, เขียน 20 ครั้ง/ชั่วโมง ต่อ IP |
| Third‑party | Leaflet ถูก vendor ไว้ในโปรเจกต์ ไม่โหลดจาก CDN; ติดต่อภายนอกเฉพาะ tile server / Google Maps |
| Docker | read‑only filesystem, non‑root user, `logging: none` |

### ทำอย่างไรให้ "ตามหาผู้สร้างระบบไม่ได้"

โค้ดนี้ไม่มีชื่อผู้เขียน, ไม่มี analytics, ไม่มี tracking, และปล่อยเป็น public domain (Unlicense)
แต่ **การซ่อนตัวตนขึ้นกับวิธี deploy มากกว่าโค้ด** ควรพิจารณา:

1. **อย่าใช้ Google Maps API key ถ้าต้องการนิรนามสูงสุด** — key ผูกกับบัญชี Google Cloud ซึ่งต้องมีบัตรเครดิต
   ปล่อย `GOOGLE_MAPS_API_KEY` ว่างไว้ ระบบจะใช้ OpenStreetMap แทนโดยอัตโนมัติ (ไม่ต้องสมัครอะไรเลย)
   ถ้าใช้ Google Maps ให้จำกัด key ด้วย HTTP referrer และเปิดเฉพาะ Maps JavaScript API
2. **โดเมน**: ใช้ผู้ให้บริการที่รับ crypto หรือมี WHOIS privacy; ใช้ Cloudflare หรือ CDN คั่นหน้าเซิร์ฟเวอร์เพื่อซ่อน IP ของ VPS
3. **โฮสติ้ง**: VPS ที่ไม่ต้องยืนยันตัวตน หรือ Fly.io / Railway ด้วยอีเมลที่สร้างใหม่แยกต่างหาก
4. **Git**: อย่า commit ด้วยชื่อ/อีเมลจริง (`git config user.name` / `user.email` ควรเป็นค่ากลาง ๆ)
   และอย่าลืมว่า **GitHub repository เป็นสาธารณะ** — ประวัติ commit ทั้งหมดผูกกับบัญชี GitHub ของคุณ
   หากต้องการนิรนามควร push จากบัญชีใหม่ที่ไม่เชื่อมกับตัวตนจริง
5. **Logs**: ตั้ง reverse proxy (nginx/Caddy) ให้ `access_log off`

## การติดตั้ง

### รันบนเครื่อง

```bash
npm install
cp .env.example .env   # แก้ไขค่าตามต้องการ (ปล่อย GOOGLE_MAPS_API_KEY ว่างได้)
npm start              # http://localhost:3000
```

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
| `POST` | `/api/reports` | สร้างรายงาน (multipart: `plate`, `province`, `vehicleType`, `lat`, `lng`, `accuracy?`, `placeNote?`, `note?`, `photo?`) → คืน `{ report, token }` |
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
src/plate.js      normalise เลขทะเบียนสำหรับค้นหา
src/provinces.js  77 จังหวัด
public/           หน้าเว็บ (vanilla JS, ไม่มี build step)
public/js/map.js  ตัวกลางแผนที่ Google Maps / Leaflet
public/vendor/    Leaflet 1.9.4 (BSD-2)
test/             API tests (node:test)
```

## License

Public domain (Unlicense) — ดู `LICENSE`
