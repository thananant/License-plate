/* Plate finder front-end. No cookies, no storage, no tracking. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const TYPE_LABEL = { car: 'รถยนต์', motorcycle: 'มอเตอร์ไซค์', other: 'อื่น ๆ' };
  const fmt7 = (n) => Number(n).toFixed(7);

  let cfg = null;
  let map = null;
  let reports = [];
  let draft = null; // {lat,lng}
  let draftAccuracy = null;
  let activeTab = 'search';

  // ---------- tabs ----------
  function setTab(name) {
    activeTab = name;
    $$('.tab').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    $$('.tabpane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    $('#crosshair').hidden = name !== 'report';
    if (map) map.setDraft(name === 'report' ? draft : null, onDraftMove);
    if (name !== 'report' && map) map.setAccuracyCircle(null);
    if (name === 'report' && map && draft) map.setAccuracyCircle(draft, draftAccuracy);
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ---------- api ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, { cache: 'no-store', ...opts });
    let body = null;
    try { body = await res.json(); } catch { /* 204 */ }
    if (!res.ok) {
      const err = new Error(body?.error || 'http_' + res.status);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // ---------- search ----------
  function searchParams() {
    const p = new URLSearchParams();
    const plate = $('#s-plate').value.trim();
    const prov = $('#s-province').value;
    const type = $('#s-type').value;
    const status = $('#s-status').value;
    if (plate) p.set('plate', plate);
    if (prov) p.set('province', prov);
    if (type) p.set('type', type);
    p.set('status', status);
    if ($('#s-inview').checked && map) {
      const b = map.getBounds();
      if (b) p.set('bbox', [b.south, b.west, b.north, b.east].map((n) => n.toFixed(6)).join(','));
    }
    return p;
  }

  async function runSearch({ fit = false } = {}) {
    $('#results-count').textContent = 'กำลังค้นหา…';
    try {
      const data = await api('/api/reports?' + searchParams().toString());
      reports = data.reports;
      renderResults();
      if (map) {
        map.setMarkers(reports, openDetail);
        if (fit && reports.length) map.fitBounds(boundsOf(reports));
      }
    } catch (e) {
      $('#results-count').textContent = 'ค้นหาไม่สำเร็จ ลองใหม่อีกครั้ง';
    }
  }

  function boundsOf(rows) {
    let south = 90, north = -90, west = 180, east = -180;
    rows.forEach((r) => { south = Math.min(south, r.lat); north = Math.max(north, r.lat); west = Math.min(west, r.lng); east = Math.max(east, r.lng); });
    if (rows.length === 1) { south -= 0.002; north += 0.002; west -= 0.002; east += 0.002; }
    return { south, west, north, east };
  }

  function renderResults() {
    const ul = $('#results');
    ul.innerHTML = '';
    $('#results-count').textContent = reports.length ? `พบ ${reports.length} รายการ` : 'ไม่พบรายการ';
    if (!reports.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'ยังไม่มีรายงานที่ตรงกับเงื่อนไข ลองค้นหาแค่ตัวเลข หรือเลือก "ทุกจังหวัด"';
      ul.appendChild(li);
      return;
    }
    reports.forEach((r) => {
      const li = document.createElement('li');
      li.tabIndex = 0;
      const plate = el('div', 'plate', r.plate_display);
      const prov = el('div', 'prov', r.province);
      const sub = el('div', 'sub');
      sub.appendChild(badge(r));
      sub.appendChild(document.createTextNode(timeAgo(r.created_at) + (r.place_note ? ' · ' + r.place_note : '')));
      li.append(plate, prov, sub);
      if (r.photo) {
        const img = document.createElement('img');
        img.className = 'thumb'; img.loading = 'lazy'; img.alt = ''; img.src = '/uploads/' + encodeURIComponent(r.photo);
        li.appendChild(img);
      }
      const open = () => { if (map) map.panTo({ lat: r.lat, lng: r.lng }, Math.max(map.getZoom(), 17)); openDetail(r); };
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      ul.appendChild(li);
    });
  }

  function badge(r) {
    const span = document.createElement('span');
    if (r.status === 'returned') { span.className = 'badge returned'; span.textContent = 'คืนแล้ว'; }
    else { span.className = 'badge' + (r.vehicle_type === 'motorcycle' ? ' moto' : ''); span.textContent = TYPE_LABEL[r.vehicle_type] || r.vehicle_type; }
    return span;
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function timeAgo(ts) {
    const d = Date.now() - ts, m = Math.floor(d / 60000), h = Math.floor(m / 60), day = Math.floor(h / 24);
    if (m < 1) return 'เมื่อสักครู่';
    if (m < 60) return `${m} นาทีที่แล้ว`;
    if (h < 24) return `${h} ชม.ที่แล้ว`;
    if (day < 30) return `${day} วันที่แล้ว`;
    return new Date(ts).toLocaleDateString('th-TH');
  }

  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch({ fit: true }); });
  $('#s-reset').addEventListener('click', () => { $('#search-form').reset(); runSearch(); });
  $('#s-inview').addEventListener('change', () => runSearch());

  // ---------- detail ----------
  function openDetail(r) {
    $('#d-plate').textContent = `${r.plate_display} · ${r.province}`;
    $('#d-meta').textContent = `${TYPE_LABEL[r.vehicle_type] || ''} · ${r.status === 'returned' ? 'คืนเจ้าของแล้ว' : 'ยังไม่มีคนมารับ'} · แจ้งเมื่อ ${new Date(r.created_at).toLocaleString('th-TH')}`;
    const ph = $('#d-photo'); ph.innerHTML = '';
    if (r.photo) { const img = document.createElement('img'); img.src = '/uploads/' + encodeURIComponent(r.photo); img.alt = 'รูปป้ายทะเบียน'; ph.appendChild(img); }
    $('#d-place').textContent = r.place_note ? '📌 ' + r.place_note : '';
    $('#d-note').textContent = r.note ? '💬 ' + r.note : '';
    const coords = `${fmt7(r.lat)}, ${fmt7(r.lng)}`;
    $('#d-coords').textContent = coords + (r.accuracy_m ? ` (±${Math.round(r.accuracy_m)} ม.)` : '');
    $('#d-copy').onclick = () => copy(coords, $('#d-copy'));
    $('#d-gmaps').href = `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`;
    $('#d-osm').href = `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=19/${r.lat}/${r.lng}`;
    $('#d-id').textContent = r.id;
    $('#detail').showModal();
  }
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); if (btn) { const t = btn.textContent; btn.textContent = 'คัดลอกแล้ว ✓'; setTimeout(() => (btn.textContent = t), 1500); } }
    catch { window.prompt('คัดลอกข้อความนี้', text); }
  }

  // ---------- report: location ----------
  function setDraft(p, { accuracy = null, pan = false, fromInput = false } = {}) {
    draft = { lat: +p.lat, lng: +p.lng };
    draftAccuracy = accuracy;
    if (!fromInput) { $('#r-lat').value = fmt7(draft.lat); $('#r-lng').value = fmt7(draft.lng); }
    $('#r-accuracy').value = accuracy != null ? Math.round(accuracy) : '';
    const st = $('#r-locstatus');
    st.textContent = accuracy != null ? `ปักหมุดแล้ว (GPS ±${Math.round(accuracy)} ม.)` : 'ปักหมุดแล้ว';
    st.className = 'ok';
    if (map) {
      map.setDraft(draft, onDraftMove);
      map.setAccuracyCircle(accuracy ? draft : null, accuracy);
      if (pan) map.panTo(draft, Math.max(map.getZoom(), 18));
    }
  }
  function onDraftMove(p) { if (gpsWatchId != null) stopGps(); setDraft(p, { accuracy: null }); }

  ['#r-lat', '#r-lng'].forEach((sel) => $(sel).addEventListener('change', onCoordInput));
  $('#r-lat').addEventListener('paste', (e) => {
    // Allow pasting "13.7563, 100.5018" straight from Google Maps into the lat box.
    const text = (e.clipboardData || window.clipboardData).getData('text');
    const m = text.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
    if (m) { e.preventDefault(); $('#r-lat').value = m[1]; $('#r-lng').value = m[2]; onCoordInput(); }
  });
  function onCoordInput() {
    const lat = parseFloat($('#r-lat').value), lng = parseFloat($('#r-lng').value);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) setDraft({ lat, lng }, { pan: true, fromInput: true });
  }

  $('#r-center').addEventListener('click', () => { if (map) setDraft(map.getCenter()); });
  $('#r-geoloc').addEventListener('click', () => locate(true));
  $('#map-me').addEventListener('click', () => locate(false));

  // Continuous GPS: watch for up to GPS_WATCH_MS, keep the most accurate fix,
  // stop early once accuracy is good enough. Single reads are often 30-100 m off
  // for the first few seconds while the phone is still acquiring satellites.
  const GPS_WATCH_MS = 20000;
  const GPS_GOOD_ENOUGH_M = 5;
  let gpsWatchId = null;
  let gpsTimer = null;

  function stopGps(label) {
    if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
    if (gpsTimer) clearTimeout(gpsTimer);
    gpsWatchId = null; gpsTimer = null;
    const btn = $('#r-geoloc'); btn.disabled = false; btn.textContent = label || '📡 ใช้ตำแหน่งปัจจุบัน';
  }

  function locate(asDraft) {
    if (!navigator.geolocation) return alert('เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง');
    if (!asDraft) {
      navigator.geolocation.getCurrentPosition(
        (pos) => { if (map) map.panTo({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 17); },
        () => alert('หาตำแหน่งไม่สำเร็จ'),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
      );
      return;
    }
    if (gpsWatchId != null) { stopGps(); return; } // second press = stop early
    const btn = $('#r-geoloc'); btn.disabled = false; btn.textContent = '⏳ กำลังหาตำแหน่ง… (กดอีกครั้งเพื่อหยุด)';
    let best = null;
    const started = Date.now();
    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        if (!best || c.accuracy < best.accuracy) {
          best = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };
          setDraft(best, { accuracy: best.accuracy, pan: true });
        }
        const secs = Math.round((Date.now() - started) / 1000);
        $('#r-locstatus').textContent = `GPS ±${Math.round(best.accuracy)} ม. (กำลังปรับ ${secs}s)`;
        if (best.accuracy <= GPS_GOOD_ENOUGH_M) finish();
      },
      (err) => {
        stopGps();
        if (!best) alert(err.code === 1 ? 'ไม่ได้รับอนุญาตให้เข้าถึงตำแหน่ง กรุณาคลิกบนแผนที่แทน' : 'หาตำแหน่งไม่สำเร็จ กรุณาคลิกบนแผนที่แทน');
      },
      { enableHighAccuracy: true, timeout: GPS_WATCH_MS, maximumAge: 0 },
    );
    gpsTimer = setTimeout(finish, GPS_WATCH_MS);
    function finish() {
      stopGps();
      if (best) {
        setDraft(best, { accuracy: best.accuracy });
        $('#r-locstatus').textContent = `ปักหมุดแล้ว (GPS ±${Math.round(best.accuracy)} ม.) ลากหมุดปรับให้ตรงจุดได้`;
      } else {
        alert('ยังหาตำแหน่งไม่ได้ ลองออกไปกลางแจ้งหรือคลิกบนแผนที่แทน');
      }
    }
  }

  // ---------- report: photo preview ----------
  $('#r-photo').addEventListener('change', () => {
    const f = $('#r-photo').files[0];
    const box = $('#r-preview'); box.innerHTML = ''; box.hidden = true;
    if (!f) return;
    if (f.size > cfg.limits.maxPhotoBytes) { showError('รูปใหญ่เกิน 8 MB'); $('#r-photo').value = ''; return; }
    const img = document.createElement('img'); img.src = URL.createObjectURL(f); img.alt = 'ตัวอย่างรูป';
    img.onload = () => URL.revokeObjectURL(img.src);
    box.appendChild(img); box.hidden = false;
  });

  // ---------- report: submit ----------
  function showError(msg) { const e = $('#r-error'); e.textContent = msg; e.hidden = !msg; }
  const ERR = {
    validation: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง',
    photo_too_large: 'รูปใหญ่เกิน 8 MB',
    unsupported_image: 'รองรับเฉพาะไฟล์รูปภาพ (JPG, PNG, WEBP, HEIC)',
    bad_image: 'อ่านไฟล์รูปไม่ได้ ลองถ่ายใหม่หรือเลือกรูปอื่น',
    http_429: 'ส่งบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  };
  $('#report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    if (!draft) { showError('กรุณาปักหมุดจุดที่พบบนแผนที่ก่อน'); setTab('report'); return; }
    const fd = new FormData($('#report-form'));
    fd.set('lat', fmt7(draft.lat)); fd.set('lng', fmt7(draft.lng));
    const btn = $('#r-submit'); btn.disabled = true; btn.textContent = 'กำลังส่ง…';
    try {
      const out = await api('/api/reports', { method: 'POST', body: fd });
      $('#ok-id').textContent = out.report.id;
      $('#ok-token').textContent = out.token;
      $('#ok-copy').onclick = () => copy(`รหัสรายงาน: ${out.report.id}\nรหัสจัดการ: ${out.token}`, $('#ok-copy'));
      $('#report-form').hidden = true; $('#r-success').hidden = false;
      draft = null; draftAccuracy = null; map?.setDraft(null); map?.setAccuracyCircle(null);
      runSearch();
    } catch (err) {
      let msg = ERR[err.message] || 'ส่งไม่สำเร็จ กรุณาลองใหม่';
      if (err.body?.fields) {
        const f = err.body.fields;
        if (f.plate) msg = 'เลขทะเบียนไม่ถูกต้อง (ต้องมีตัวเลขอย่างน้อย 1 ตัว)';
        else if (f.province) msg = 'กรุณาเลือกจังหวัด';
        else if (f.location) msg = 'พิกัดไม่ถูกต้อง กรุณาปักหมุดใหม่';
      }
      showError(msg);
    } finally {
      btn.disabled = false; btn.textContent = 'ส่งรายงาน';
    }
  });
  $('#ok-another').addEventListener('click', () => {
    $('#report-form').reset(); $('#r-preview').hidden = true; $('#r-preview').innerHTML = '';
    $('#r-locstatus').textContent = 'ยังไม่ได้ปักหมุด'; $('#r-locstatus').className = 'muted';
    $('#report-form').hidden = false; $('#r-success').hidden = true;
  });

  // ---------- manage ----------
  $('#manage-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = e.submitter?.dataset.action;
    const id = $('#m-id').value.trim(), token = $('#m-token').value.trim();
    const msg = $('#m-msg'); msg.className = 'msg'; msg.textContent = '';
    if (!id || !token) return;
    if (action === 'delete' && !confirm('ลบรายงานนี้ถาวร?')) return;
    try {
      if (action === 'delete') {
        await api('/api/reports/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        msg.textContent = 'ลบรายงานแล้ว';
      } else {
        await api('/api/reports/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, status: action }) });
        msg.textContent = action === 'returned' ? 'อัปเดตเป็น "คืนเจ้าของแล้ว"' : 'อัปเดตเป็น "ยังไม่มีคนมารับ"';
      }
      msg.classList.add('ok');
      runSearch();
    } catch (err) {
      msg.classList.add('err');
      msg.textContent = err.status === 403 ? 'รหัสไม่ถูกต้อง' : err.status === 429 ? 'ลองบ่อยเกินไป กรุณารอสักครู่' : 'ทำรายการไม่สำเร็จ';
    }
  });

  // ---------- init ----------
  function fillProvinces() {
    for (const sel of ['#s-province', '#r-province']) {
      const s = $(sel);
      cfg.provinces.forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = p; s.appendChild(o); });
    }
  }

  async function init() {
    try {
      cfg = await api('/api/config');
    } catch {
      $('#results-count').textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';
      return;
    }
    fillProvinces();
    try {
      map = await window.PlateMap.createMap($('#map'), cfg);
      map.onClick((p) => { if (activeTab === 'report') setDraft(p); });
      map.onMoveEnd(() => { if ($('#s-inview').checked) runSearch(); });
      $('#map-sat').addEventListener('click', () => {
        const on = map.toggleSatellite();
        $('#map-sat').textContent = on ? '🗺️ แผนที่' : '🛰️ ดาวเทียม';
      });
    } catch (e) {
      $('#map-fallback').hidden = false;
    }
    await runSearch({ fit: true });
  }
  init();
})();
