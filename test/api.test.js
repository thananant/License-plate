import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { normalizePlate, isPlausiblePlate } from '../src/plate.js';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plates-'));
  proc = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, GOOGLE_MAPS_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => proc.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); }));
});
after(() => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('plate normalisation', () => {
  assert.equal(normalizePlate('กข 1234'), 'กข1234');
  assert.equal(normalizePlate('กข-1234'), 'กข1234');
  assert.equal(normalizePlate('1กข ๑๒๓๔'), '1กข1234');
  assert.equal(normalizePlate('ab 12'), 'AB12');
  assert.ok(isPlausiblePlate('กข1234'));
  assert.ok(!isPlausiblePlate('กขคง'));
  assert.ok(!isPlausiblePlate('1'));
});

test('config exposes provinces and no key', async () => {
  const r = await fetch(BASE + '/api/config');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.mapProvider, 'osm');
  assert.equal(j.googleMapsApiKey, null);
  assert.equal(j.provinces.length, 77);
});

test('security headers present', async () => {
  const r = await fetch(BASE + '/');
  assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('create, search, photo metadata stripped, manage, delete', async () => {
  // JPEG with EXIF (GPS-ish comment) to ensure metadata gets dropped
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } })
    .jpeg().withMetadata({ exif: { IFD0: { ImageDescription: 'SECRET-EXIF' } } }).toBuffer();

  const fd = new FormData();
  fd.set('plate', 'กข 1234');
  fd.set('province', 'นนทบุรี');
  fd.set('vehicleType', 'motorcycle');
  fd.set('lat', '13.85123456789');
  fd.set('lng', '100.52123456789');
  fd.set('accuracy', '4.2');
  fd.set('placeNote', 'หน้าร้านกาแฟ');
  fd.set('note', 'รับได้ที่ป้อมยาม');
  fd.set('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');

  let r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd });
  assert.equal(r.status, 201);
  const { report, token } = await r.json();
  assert.equal(report.plate_display, 'กข 1234');
  assert.equal(report.lat, 13.8512346); // rounded to 7 dp
  assert.equal(report.token_hash, undefined);
  assert.ok(report.photo.endsWith('.jpg'));

  // photo served and stripped of metadata
  r = await fetch(BASE + '/uploads/' + report.photo);
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(!buf.includes('SECRET-EXIF'));
  const meta = await sharp(buf).metadata();
  assert.equal(meta.exif, undefined);

  // search by digits only + province
  r = await fetch(BASE + '/api/reports?plate=1234&province=' + encodeURIComponent('นนทบุรี'));
  let j = await r.json();
  assert.equal(j.count, 1);
  assert.equal(j.reports[0].id, report.id);

  // search with formatting differences
  r = await fetch(BASE + '/api/reports?plate=' + encodeURIComponent('กข-1234'));
  j = await r.json();
  assert.equal(j.count, 1);

  // bbox excludes
  r = await fetch(BASE + '/api/reports?bbox=0,0,1,1');
  j = await r.json();
  assert.equal(j.count, 0);

  // wrong token
  r = await fetch(BASE + '/api/reports/' + report.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(32), status: 'returned' }) });
  assert.equal(r.status, 403);

  // right token
  r = await fetch(BASE + '/api/reports/' + report.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, status: 'returned' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'returned');

  // default search hides returned
  r = await fetch(BASE + '/api/reports?plate=1234');
  assert.equal((await r.json()).count, 0);
  r = await fetch(BASE + '/api/reports?plate=1234&status=all');
  assert.equal((await r.json()).count, 1);

  // delete
  r = await fetch(BASE + '/api/reports/' + report.id, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(r.status, 204);
  r = await fetch(BASE + '/api/reports/' + report.id);
  assert.equal(r.status, 404);
  r = await fetch(BASE + '/uploads/' + report.photo);
  assert.equal(r.status, 404);
});

test('validation and honeypot', async () => {
  let fd = new FormData();
  fd.set('plate', 'กขคง'); fd.set('province', 'ไม่มีจริง'); fd.set('vehicleType', 'boat'); fd.set('lat', '999'); fd.set('lng', '1');
  let r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.deepEqual(Object.keys(j.fields).sort(), ['location', 'plate', 'province', 'vehicleType']);

  fd = new FormData();
  fd.set('plate', 'กข 1'); fd.set('province', 'ภูเก็ต'); fd.set('vehicleType', 'car'); fd.set('lat', '7.9'); fd.set('lng', '98.3'); fd.set('website', 'spam');
  r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd });
  assert.equal(r.status, 400);

  // non-image upload rejected
  fd = new FormData();
  fd.set('plate', 'กข 1'); fd.set('province', 'ภูเก็ต'); fd.set('vehicleType', 'car'); fd.set('lat', '7.9'); fd.set('lng', '98.3');
  fd.set('photo', new Blob(['hello'], { type: 'text/plain' }), 'x.txt');
  r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'unsupported_image');
});
