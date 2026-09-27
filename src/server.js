import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, toPublic } from './db.js';
import { PROVINCES, PROVINCE_SET, VEHICLE_TYPES } from './provinces.js';
import { normalizePlate, cleanPlateDisplay, isPlausiblePlate } from './plate.js';
import { readPlates, ocrEnabled, OCR_MODEL } from './ocr.js';
import { dhash, hamming } from './phash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ROOT = path.resolve(__dirname, '..');

// ---------- config ----------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const GOOGLE_MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
const MAP_CENTER = {
  lat: Number(process.env.MAP_CENTER_LAT || 13.7563),
  lng: Number(process.env.MAP_CENTER_LNG || 100.5018),
  zoom: Number(process.env.MAP_ZOOM || 6),
};
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'false') === 'true';
// Optional moderator secret. When set, it is accepted in place of a report's own
// token so spam/abusive reports can be removed. Never stored, never sent to clients.
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const ADMIN_TOKEN_HASH = ADMIN_TOKEN.length >= 24 ? sha256(ADMIN_TOKEN) : null;

const RETURNED_TTL_DAYS = Number(process.env.RETURNED_TTL_DAYS || 30);
// Unclaimed reports are dropped after this long (0 = keep forever).
const FOUND_TTL_DAYS = Number(process.env.FOUND_TTL_DAYS || 180);
// A report must carry a photo taken in-app (set "false" to allow text-only reports).
const PHOTO_REQUIRED = String(process.env.PHOTO_REQUIRED ?? 'true') !== 'false';
// Same/near-same photo re-submitted within this window is rejected as a duplicate.
const DUPLICATE_WINDOW_DAYS = Number(process.env.DUPLICATE_WINDOW_DAYS || 90);
const DUPLICATE_MAX_DISTANCE = 6; // hamming bits out of 64
const MAX_PLATES_PER_REPORT = 20;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTO_EDGE = 1280; // ~100-200 KB per photo after re-encoding
const MAX_NOTE = 500;
const MAX_PLACE_NOTE = 200;

await fs.mkdir(UPLOAD_DIR, { recursive: true });
const store = openDatabase(DATA_DIR);

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.set('etag', false);
if (TRUST_PROXY) app.set('trust proxy', 1);

// Strict security headers. The CSP allows Google Maps and Leaflet/OSM only.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': [
          "'self'",
          "'wasm-unsafe-eval'", // Tesseract.js (on-device OCR) runs WebAssembly
          'https://maps.googleapis.com',
          'https://maps.gstatic.com',
        ],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': [
          "'self'",
          'data:',
          'blob:',
          'https://maps.googleapis.com',
          'https://maps.gstatic.com',
          'https://*.googleapis.com',
          'https://*.gstatic.com',
          'https://*.ggpht.com',
          'https://tile.openstreetmap.org',
          'https://*.tile.openstreetmap.fr',
        ],
        'connect-src': ["'self'", 'https://maps.googleapis.com', 'https://*.googleapis.com'],
        'worker-src': ["'self'", 'blob:'],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  }),
);
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(), payment=()');
  next();
});

// Rate limits (kept in memory only; nothing is written to disk or logs).
const readLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_READ_PER_MIN || 120), standardHeaders: 'draft-7', legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 60_000, limit: Number(process.env.RATE_WRITE_PER_HOUR || 20), standardHeaders: 'draft-7', legacyHeaders: false });
// AI reads cost money: tighter per-IP limit plus a global daily cap.
const ocrLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });
const OCR_DAILY_LIMIT = Number(process.env.OCR_DAILY_LIMIT || 500);
let ocrDay = new Date().toISOString().slice(0, 10);
let ocrCount = 0;
function ocrBudgetOk() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== ocrDay) { ocrDay = today; ocrCount = 0; }
  if (ocrCount >= OCR_DAILY_LIMIT) return false;
  ocrCount += 1;
  return true;
}

app.use(express.json({ limit: '32kb' }));

// ---------- helpers ----------
const newId = () => crypto.randomBytes(9).toString('base64url'); // 12 chars, URL safe
const newToken = () => crypto.randomBytes(24).toString('base64url'); // 32 chars

function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!s) return null;
  return s.slice(0, max);
}

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function parseCoord(v, min, max) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 1e7) / 1e7; // ~1 cm precision
}

function hashEquals(hexA, hexB) {
  const a = Buffer.from(hexA, 'hex');
  const b = Buffer.from(hexB, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAdminToken(token) {
  return ADMIN_TOKEN_HASH != null && typeof token === 'string' && token.length >= 24 && token.length <= 128 && hashEquals(ADMIN_TOKEN_HASH, sha256(token));
}

function checkToken(row, token) {
  if (!row || typeof token !== 'string' || token.length < 16 || token.length > 128) return false;
  const h = sha256(token);
  if (hashEquals(row.token_hash, h)) return true;
  return ADMIN_TOKEN_HASH != null && hashEquals(ADMIN_TOKEN_HASH, h);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 20 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|heic|heif|gif|avif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('unsupported_image'), ok);
  },
});

/** Re-encode the image: strips EXIF/GPS/metadata, caps size, always outputs JPEG. */
async function processPhoto(buffer) {
  const name = crypto.randomBytes(12).toString('hex') + '.jpg';
  await sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate() // apply EXIF orientation before metadata is dropped
    .resize({ width: MAX_PHOTO_EDGE, height: MAX_PHOTO_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toFile(path.join(UPLOAD_DIR, name));
  return name;
}

async function removePhoto(name) {
  if (!name) return;
  if (store.photoInUse(name)) return; // still referenced by another plate from the same photo
  try {
    await fs.unlink(path.join(UPLOAD_DIR, path.basename(name)));
  } catch {
    /* ignore */
  }
}

// ---------- API ----------
app.get('/api/config', readLimiter, (_req, res) => {
  res.json({
    mapProvider: GOOGLE_MAPS_API_KEY ? 'google' : 'osm',
    googleMapsApiKey: GOOGLE_MAPS_API_KEY || null,
    center: MAP_CENTER,
    provinces: PROVINCES,
    vehicleTypes: VEHICLE_TYPES,
    limits: { maxPhotoBytes: MAX_PHOTO_BYTES, maxNote: MAX_NOTE, maxPlaceNote: MAX_PLACE_NOTE },
    ocrEnabled,
    photoRequired: PHOTO_REQUIRED,
    maxPlates: MAX_PLATES_PER_REPORT,
    totalFound: store.countFound(),
  });
});

app.get('/api/reports', readLimiter, (req, res) => {
  const q = req.query;
  const plate = normalizePlate(String(q.plate ?? ''));
  const province = PROVINCE_SET.has(String(q.province ?? '')) ? String(q.province) : null;
  const vehicleType = VEHICLE_TYPES.includes(String(q.type ?? '')) ? String(q.type) : null;
  const status = ['found', 'returned'].includes(String(q.status ?? '')) ? String(q.status) : (q.status === 'all' ? null : 'found');

  let bbox = null;
  if (typeof q.bbox === 'string') {
    const p = q.bbox.split(',').map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) {
      const [south, west, north, east] = p;
      if (south <= north && west <= east) bbox = { south, west, north, east };
    }
  }
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);

  const rows = store.search({ plate: plate || null, province, vehicleType, status, bbox, limit });
  res.json({ count: rows.length, reports: rows });
});

app.get('/api/reports/:id', readLimiter, (req, res) => {
  const row = store.byId(String(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(toPublic(row));
});

app.post('/api/reports', writeLimiter, (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'photo_too_large' : err.message === 'unsupported_image' ? 'unsupported_image' : 'bad_upload';
      return res.status(400).json({ error: code });
    }
    next();
  });
}, async (req, res) => {
  const b = req.body || {};

  // Honeypot: real users never fill this hidden field.
  if (b.website) return res.status(400).json({ error: 'rejected' });

  // Accept either a single plate (plate/province/vehicleType) or `plates`:
  // a JSON array of {plate, province, vehicleType} sharing one photo/location.
  let items;
  if (typeof b.plates === 'string') {
    try { items = JSON.parse(b.plates); } catch { return res.status(400).json({ error: 'bad_json' }); }
    if (!Array.isArray(items)) return res.status(400).json({ error: 'validation' });
  } else {
    items = [{ plate: b.plate, province: b.province, vehicleType: b.vehicleType }];
  }
  if (items.length < 1 || items.length > MAX_PLATES_PER_REPORT) return res.status(400).json({ error: 'validation', fields: { plates: 'count' } });

  const lat = parseCoord(b.lat, -90, 90);
  const lng = parseCoord(b.lng, -180, 180);
  const accuracy = b.accuracy != null && b.accuracy !== '' ? parseCoord(b.accuracy, 0, 100000) : null;

  const errors = {};
  if (lat == null || lng == null) errors.location = 'invalid';
  if (PHOTO_REQUIRED && !req.file) errors.photo = 'required';
  const parsed = items.map((it, i) => {
    const plateDisplay = cleanPlateDisplay(it?.plate ?? '');
    const plateNorm = normalizePlate(plateDisplay);
    const province = String(it?.province ?? '').trim();
    const vehicleType = String(it?.vehicleType ?? '').trim();
    const e = {};
    if (!isPlausiblePlate(plateNorm) || plateDisplay.length > 20 || plateDisplay.includes('?')) e.plate = 'invalid';
    if (!PROVINCE_SET.has(province)) e.province = 'invalid';
    if (!VEHICLE_TYPES.includes(vehicleType)) e.vehicleType = 'invalid';
    if (Object.keys(e).length) { errors.plates = errors.plates || {}; errors.plates[i] = e; Object.assign(errors, e); }
    return { plateDisplay, plateNorm, province, vehicleType };
  });
  // the same plate twice in one submission is a mistake, not two plates
  const keys = new Set();
  for (const p of parsed) { const k = p.plateNorm + '|' + p.province; if (keys.has(k)) errors.plate = 'duplicate'; keys.add(k); }
  if (Object.keys(errors).length) return res.status(400).json({ error: 'validation', fields: errors });

  // Same plate already listed and not yet returned: usually a duplicate
  // report of the same physical plate. The client can override (a car has a
  // front and a back plate) by sending allowDuplicate=1.
  if (b.allowDuplicate !== '1') {
    const existing = [];
    for (const p of parsed) {
      for (const r of store.activeByPlate(p.plateNorm, p.province)) {
        existing.push({ id: r.id, plate_display: r.plate_display, province: r.province, created_at: r.created_at, distance_m: Math.round(distanceM(lat, lng, r.lat, r.lng)) });
      }
    }
    if (existing.length) return res.status(409).json({ error: 'duplicate_plate', existing: existing.slice(0, 5) });
  }

  let photo = null;
  let photoHash = null;
  if (req.file) {
    try {
      photoHash = await dhash(req.file.buffer);
    } catch {
      return res.status(400).json({ error: 'bad_image' });
    }
    const dup = store.recentHashes(DUPLICATE_WINDOW_DAYS * 86_400_000)
      .filter((r) => hamming(r.photo_hash, photoHash) <= DUPLICATE_MAX_DISTANCE);
    if (dup.length) {
      return res.status(409).json({
        error: 'duplicate_photo',
        existing: dup.slice(0, 5).map((r) => ({ id: r.id, plate_display: r.plate_display, province: r.province })),
      });
    }
    try {
      photo = await processPhoto(req.file.buffer);
    } catch {
      return res.status(400).json({ error: 'bad_image' });
    }
  }

  const now = Date.now();
  const rows = parsed.map((p) => {
    const token = newToken();
    return {
      token,
      row: {
        id: newId(),
        plate_display: p.plateDisplay,
        plate_norm: p.plateNorm,
        province: p.province,
        vehicle_type: p.vehicleType,
        lat,
        lng,
        accuracy_m: accuracy,
        place_note: cleanText(b.placeNote, MAX_PLACE_NOTE),
        note: cleanText(b.note, MAX_NOTE),
        photo,
        photo_hash: photoHash,
        token_hash: sha256(token),
        created_at: now,
        updated_at: now,
      },
    };
  });
  try {
    store.insertMany(rows.map((r) => r.row));
  } catch {
    await removePhoto(photo);
    return res.status(500).json({ error: 'server_error' });
  }
  const reports = rows.map((r) => ({ report: toPublic(store.byId(r.row.id)), token: r.token }));
  res.status(201).json({ reports, report: reports[0].report, token: reports[0].token });
});

// AI: read every plate in a photo. Returns suggestions for the user to review.
app.post('/api/ocr', ocrLimiter, (req, res, next) => {
  if (!ocrEnabled) return res.status(503).json({ error: 'ocr_disabled' });
  upload.single('photo')(req, res, (err) => {
    if (err) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'photo_too_large' : err.message === 'unsupported_image' ? 'unsupported_image' : 'bad_upload';
      return res.status(400).json({ error: code });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_photo' });
  if (!ocrBudgetOk()) return res.status(429).json({ error: 'ocr_budget' });
  try {
    const out = await readPlates(req.file.buffer);
    res.json(out);
  } catch (e) {
    const code = e?.code || 'ocr_failed';
    const status = code === 'ai_declined' ? 422 : code === 'ocr_disabled' ? 503 : 502;
    res.status(status).json({ error: code });
  }
});

// Anyone can mark a plate as returned to its owner (no code needed). It is not
// deleted: it moves to the "returned" list and is purged after RETURNED_TTL_DAYS.
// Moderators can revert with the admin token if this is abused.
app.post('/api/reports/:id/claim', writeLimiter, (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'photo_too_large' : err.message === 'unsupported_image' ? 'unsupported_image' : 'bad_upload';
      return res.status(400).json({ error: code });
    }
    next();
  });
}, async (req, res) => {
  if (req.body?.website) return res.status(400).json({ error: 'rejected' });
  const row = store.byId(String(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.status === 'returned') return res.json(toPublic(row));
  let photo = null;
  if (req.file) {
    try { photo = await processPhoto(req.file.buffer); } catch { return res.status(400).json({ error: 'bad_image' }); }
  }
  store.claim(row.id, { note: cleanText(req.body?.note, MAX_PLACE_NOTE), photo });
  res.json(toPublic(store.byId(row.id)));
});

app.patch('/api/reports/:id', writeLimiter, (req, res) => {
  const row = store.byId(String(req.params.id));
  if (!checkToken(row, req.body?.token)) return res.status(403).json({ error: 'forbidden' });
  const status = String(req.body?.status ?? '');
  if (!['found', 'returned'].includes(status)) return res.status(400).json({ error: 'validation' });
  store.setStatus(row.id, status);
  res.json(toPublic(store.byId(row.id)));
});

app.delete('/api/reports/:id', writeLimiter, async (req, res) => {
  const row = store.byId(String(req.params.id));
  if (!checkToken(row, req.body?.token)) return res.status(403).json({ error: 'forbidden' });
  store.delete(row.id);
  await removePhoto(row.photo);
  await removePhoto(row.claim_photo);
  res.status(204).end();
});

// ---------- admin ----------
app.post('/api/admin/verify', writeLimiter, (req, res) => {
  if (!isAdminToken(req.body?.token)) return res.status(403).json({ error: 'forbidden' });
  res.json({ ok: true, total: store.search({ status: null, limit: 500 }).length });
});

// Remove every report and photo (e.g. test data before launch). Admin only.
app.post('/api/admin/wipe', writeLimiter, async (req, res) => {
  if (!isAdminToken(req.body?.token)) return res.status(403).json({ error: 'forbidden' });
  if (req.body?.confirm !== 'WIPE') return res.status(400).json({ error: 'confirm_required' });
  const files = store.wipe();
  for (const f of files) {
    try { await fs.unlink(path.join(UPLOAD_DIR, path.basename(f))); } catch { /* ignore */ }
  }
  res.json({ ok: true, deleted: files.length });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// ---------- static ----------
// Cache busting: index.html is never cached; CSS/JS URLs carry a content hash
// so every deploy is picked up on the next refresh.
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSET_FILES = ['css/app.css', 'js/app.js', 'js/map.js', 'js/ocr-local.js', 'js/camera.js'];
const assetHash = crypto.createHash('sha256');
for (const f of ASSET_FILES) assetHash.update(await fs.readFile(path.join(PUBLIC_DIR, f)));
const ASSET_VERSION = assetHash.digest('hex').slice(0, 10);
const INDEX_HTML = (await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8'))
  .replace(/(href|src)="\/(css|js)\/([^"?]+)"/g, `$1="/$2/$3?v=${ASSET_VERSION}"`);

function sendIndex(_req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
}
app.get(['/', '/index.html'], sendIndex);

app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    index: false,
    dotfiles: 'deny',
    maxAge: '7d',
    immutable: true,
    setHeaders: (res) => {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }),
);
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
      // Versioned assets can be cached for a long time; the ?v= changes on deploy.
      const versioned = /\.(css|js)$/.test(filePath) && !filePath.includes('vendor');
      res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400');
    },
  }),
);

// Generic error handler: never leak stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  res.status(500).json({ error: 'server_error' });
});

// Housekeeping: drop returned reports (and their photos) after the TTL.
async function purge() {
  try {
    const rows = store.purgeReturned(RETURNED_TTL_DAYS * 86_400_000);
    if (FOUND_TTL_DAYS > 0) rows.push(...store.purgeStale(FOUND_TTL_DAYS * 86_400_000));
    for (const r of rows) { await removePhoto(r.photo); await removePhoto(r.claim_photo); }
  } catch { /* ignore */ }
}
purge();
const purgeTimer = setInterval(purge, 6 * 60 * 60_000);
purgeTimer.unref();

const server = app.listen(PORT, () => {
  console.log(`plate-finder listening on :${PORT} (map: ${GOOGLE_MAPS_API_KEY ? 'google' : 'osm'}, admin: ${ADMIN_TOKEN_HASH ? 'on' : 'off'}, ai: ${ocrEnabled ? OCR_MODEL : 'off'})`);
  if (ADMIN_TOKEN && !ADMIN_TOKEN_HASH) console.warn('ADMIN_TOKEN ignored: must be at least 24 characters');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
