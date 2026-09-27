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
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tmp, GOOGLE_MAPS_API_KEY: '', ADMIN_TOKEN: 'test-admin-token-with-enough-length-123', ANTHROPIC_API_KEY: '', PHOTO_REQUIRED: 'false', RATE_WRITE_PER_HOUR: '1000' },
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
  assert.deepEqual(Object.keys(j.fields).sort(), ['location', 'plate', 'plates', 'province', 'vehicleType']);

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

test('admin token can moderate any report', async () => {
  const fd = new FormData();
  fd.set('plate', 'ขค 999'); fd.set('province', 'ระยอง'); fd.set('vehicleType', 'car'); fd.set('lat', '12.68'); fd.set('lng', '101.28');
  let r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd });
  assert.equal(r.status, 201);
  const { report } = await r.json();

  r = await fetch(BASE + '/api/reports/' + report.id, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'wrong-admin-token-with-enough-length-1' }) });
  assert.equal(r.status, 403);
  r = await fetch(BASE + '/api/reports/' + report.id, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-admin-token-with-enough-length-123' }) });
  assert.equal(r.status, 204);
});

test('anyone can mark a report returned via claim; admin can revert', async () => {
  const fd = new FormData();
  fd.set('plate', 'งจ 55'); fd.set('province', 'ตราด'); fd.set('vehicleType', 'motorcycle'); fd.set('lat', '12.24'); fd.set('lng', '102.51');
  let r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd });
  const { report } = await r.json();

  const cf = new FormData(); cf.set('note', 'เจ้าของมารับแล้ว');
  r = await fetch(BASE + '/api/reports/' + report.id + '/claim', { method: 'POST', body: cf });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'returned');
  assert.equal(j.claim_note, 'เจ้าของมารับแล้ว');
  assert.ok(j.claimed_at > 0);

  // honeypot rejected
  const hp = new FormData(); hp.set('website', 'x');
  r = await fetch(BASE + '/api/reports/' + report.id + '/claim', { method: 'POST', body: hp });
  assert.equal(r.status, 400);

  // hidden from default search, visible with status=returned
  r = await fetch(BASE + '/api/reports?plate=55');
  assert.equal((await r.json()).count, 0);
  r = await fetch(BASE + '/api/reports?plate=55&status=returned');
  assert.equal((await r.json()).count, 1);

  // admin reverts
  r = await fetch(BASE + '/api/reports/' + report.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-admin-token-with-enough-length-123', status: 'found' }) });
  assert.equal((await r.json()).status, 'found');
});

test('ocr endpoint reports disabled without API key', async () => {
  const fd = new FormData(); fd.set('photo', new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), 'x.jpg');
  const r = await fetch(BASE + '/api/ocr', { method: 'POST', body: fd });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'ocr_disabled');
});

test('several plates in one photo share one file; the same photo is rejected later', async () => {
  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#8a8f96' } })
    .composite([{ input: { create: { width: 300, height: 120, channels: 3, background: '#fff' } }, left: 40, top: 60 }])
    .jpeg().toBuffer();
  const fd = new FormData();
  fd.set('plates', JSON.stringify([
    { plate: 'กก 1', province: 'ชลบุรี', vehicleType: 'car' },
    { plate: 'ขข 2', province: 'ระยอง', vehicleType: 'motorcycle' },
  ]));
  fd.set('lat', '13.1'); fd.set('lng', '100.9');
  fd.set('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');
  let r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd });
  assert.equal(r.status, 201);
  const { reports } = await r.json();
  assert.equal(reports.length, 2);
  assert.equal(reports[0].report.photo, reports[1].report.photo);
  assert.ok(reports[0].token !== reports[1].token);

  // re-encoded copy of the same photo -> duplicate
  const again = await sharp(jpeg).resize(500).jpeg({ quality: 60 }).toBuffer();
  const fd2 = new FormData();
  fd2.set('plate', 'คค 3'); fd2.set('province', 'ตราด'); fd2.set('vehicleType', 'car'); fd2.set('lat', '13.1'); fd2.set('lng', '100.9');
  fd2.set('photo', new Blob([again], { type: 'image/jpeg' }), 'p2.jpg');
  r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd2 });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.error, 'duplicate_photo');
  assert.equal(j.existing.length, 2);

  // deleting one plate keeps the shared photo for the other
  r = await fetch(BASE + '/api/reports/' + reports[0].report.id, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: reports[0].token }) });
  assert.equal(r.status, 204);
  r = await fetch(BASE + '/uploads/' + reports[1].report.photo);
  assert.equal(r.status, 200);
  r = await fetch(BASE + '/api/reports/' + reports[1].report.id, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: reports[1].token }) });
  assert.equal(r.status, 204);
  r = await fetch(BASE + '/uploads/' + reports[1].report.photo);
  assert.equal(r.status, 404);
});

test('duplicate plate inside one submission is rejected', async () => {
  const fd = new FormData();
  fd.set('plates', JSON.stringify([{ plate: 'งง 9', province: 'ตาก', vehicleType: 'car' }, { plate: 'ง ง-9', province: 'ตาก', vehicleType: 'car' }]));
  fd.set('lat', '16.8'); fd.set('lng', '99.1');
  const r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).fields.plate, 'duplicate');
});

test('admin verify and wipe', async () => {
  const fd = new FormData();
  fd.set('plate', 'ฉฉ 77'); fd.set('province', 'น่าน'); fd.set('vehicleType', 'car'); fd.set('lat', '18.7'); fd.set('lng', '100.7');
  let r = await fetch(BASE + '/api/reports', { method: 'POST', body: fd });
  assert.equal(r.status, 201);

  r = await fetch(BASE + '/api/admin/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope-nope-nope-nope-nope-nope' }) });
  assert.equal(r.status, 403);
  r = await fetch(BASE + '/api/admin/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-admin-token-with-enough-length-123' }) });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).total >= 1);

  r = await fetch(BASE + '/api/admin/wipe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-admin-token-with-enough-length-123' }) });
  assert.equal(r.status, 400); // confirm missing
  r = await fetch(BASE + '/api/admin/wipe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test-admin-token-with-enough-length-123', confirm: 'WIPE' }) });
  assert.equal(r.status, 200);
  r = await fetch(BASE + '/api/reports?status=all');
  assert.equal((await r.json()).count, 0);
});
