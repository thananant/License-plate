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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTO_EDGE = 1600;
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
const readLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

app.use(express.json({ limit: '32kb' }));

// ---------- helpers ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(9).toString('base64url'); // 12 chars, URL safe
const newToken = () => crypto.randomBytes(24).toString('base64url'); // 32 chars

function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!s) return null;
  return s.slice(0, max);
}

function parseCoord(v, min, max) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 1e7) / 1e7; // ~1 cm precision
}

function checkToken(row, token) {
  if (!row || typeof token !== 'string' || token.length < 16 || token.length > 128) return false;
  const a = Buffer.from(row.token_hash, 'hex');
  const b = Buffer.from(sha256(token), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(path.join(UPLOAD_DIR, name));
  return name;
}

async function removePhoto(name) {
  if (!name) return;
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

  const plateDisplay = cleanPlateDisplay(b.plate ?? '');
  const plateNorm = normalizePlate(plateDisplay);
  const province = String(b.province ?? '').trim();
  const vehicleType = String(b.vehicleType ?? '').trim();
  const lat = parseCoord(b.lat, -90, 90);
  const lng = parseCoord(b.lng, -180, 180);
  const accuracy = b.accuracy != null && b.accuracy !== '' ? parseCoord(b.accuracy, 0, 100000) : null;

  const errors = {};
  if (!isPlausiblePlate(plateNorm) || plateDisplay.length > 20) errors.plate = 'invalid';
  if (!PROVINCE_SET.has(province)) errors.province = 'invalid';
  if (!VEHICLE_TYPES.includes(vehicleType)) errors.vehicleType = 'invalid';
  if (lat == null || lng == null) errors.location = 'invalid';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'validation', fields: errors });

  let photo = null;
  if (req.file) {
    try {
      photo = await processPhoto(req.file.buffer);
    } catch {
      return res.status(400).json({ error: 'bad_image' });
    }
  }

  const id = newId();
  const token = newToken();
  const now = Date.now();
  const row = {
    id,
    plate_display: plateDisplay,
    plate_norm: plateNorm,
    province,
    vehicle_type: vehicleType,
    lat,
    lng,
    accuracy_m: accuracy,
    place_note: cleanText(b.placeNote, MAX_PLACE_NOTE),
    note: cleanText(b.note, MAX_NOTE),
    photo,
    token_hash: sha256(token),
    created_at: now,
    updated_at: now,
  };
  try {
    store.insert(row);
  } catch {
    await removePhoto(photo);
    return res.status(500).json({ error: 'server_error' });
  }
  res.status(201).json({ report: toPublic(store.byId(id)), token });
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
  res.status(204).end();
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// ---------- static ----------
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
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', dotfiles: 'deny', maxAge: '1h' }));

// Generic error handler: never leak stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  res.status(500).json({ error: 'server_error' });
});

const server = app.listen(PORT, () => {
  console.log(`plate-finder listening on :${PORT} (map: ${GOOGLE_MAPS_API_KEY ? 'google' : 'osm'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
