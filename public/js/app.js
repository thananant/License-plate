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

  // ---------- mobile map collapse ----------
  const isMobile = () => window.matchMedia('(max-width: 800px)').matches;
  let userCollapsed = false; // the visitor's own choice on map tabs
  function setMapCollapsed(on) {
    document.body.classList.toggle('map-collapsed', on);
    const b = $('#map-toggle');
    b.textContent = on ? '🗺️ แสดงแผนที่' : '🗺️ ซ่อนแผนที่';
    b.setAttribute('aria-pressed', String(on));
    if (!on && map) setTimeout(() => map.resize && map.resize(), 50);
  }
  $('#map-toggle').addEventListener('click', () => {
    userCollapsed = !document.body.classList.contains('map-collapsed');
    setMapCollapsed(userCollapsed);
  });
  function showMapIfNeeded() { if (isMobile() && document.body.classList.contains('map-collapsed')) { userCollapsed = false; setMapCollapsed(false); } }

  // ---------- tabs ----------
  function setTab(name) {
    activeTab = name;
    // text-only tabs get the whole screen on phones; map tabs follow the visitor's choice
    const textTab = name === 'stats' || name === 'help' || name === 'feedback' || name === 'manage';
    $('#map-toggle').hidden = textTab;
    if (isMobile()) setMapCollapsed(textTab ? true : userCollapsed);
    $$('.tab').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    $$('.tabpane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    if (name === 'stats') loadStats();
    $('#crosshair').hidden = name !== 'report';
    if (map) map.setDraft(name === 'report' ? draft : null, onDraftMove);
    if (name !== 'report' && map) map.setAccuracyCircle(null);
    if (name === 'report' && map && draft) map.setAccuracyCircle(draft, draftAccuracy);
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  // The moderator pane has no tab; the server marks the page when it is served
  // from the secret ADMIN_PATH, and only then is the pane opened.
  const isAdminPage = document.documentElement.dataset.admin === '1';
  const feedbackLink = $('#feedback-link');
  if (feedbackLink) feedbackLink.addEventListener('click', (e) => { e.preventDefault(); setTab('feedback'); $('#panel').scrollTo({ top: 0 }); });

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
      const latest = r.update_kind === 'moved' && r.claim_note ? ' · 📍 ' + r.claim_note : (r.place_note ? ' · ' + r.place_note : '');
      sub.appendChild(document.createTextNode(timeAgo(r.created_at) + latest));
      li.append(plate, prov, sub);
      if (r.photo) {
        const img = document.createElement('img');
        img.className = 'thumb'; img.loading = 'lazy'; img.alt = ''; img.src = '/uploads/' + encodeURIComponent(r.photo);
        li.appendChild(img);
      }
      if (adminToken) {
        const row = document.createElement('div'); row.className = 'admin-row';
        const del = document.createElement('button'); del.type = 'button'; del.className = 'btn small danger'; del.textContent = '🗑️ ลบ';
        del.addEventListener('click', (ev) => { ev.stopPropagation(); adminDelete(r); });
        const st = document.createElement('button'); st.type = 'button'; st.className = 'btn small';
        st.textContent = r.status === 'returned' ? '↩️ กลับเป็นยังไม่มีคนรับ' : '✅ คืนแล้ว';
        st.addEventListener('click', (ev) => { ev.stopPropagation(); adminStatus(r, r.status === 'returned' ? 'found' : 'returned'); });
        row.append(del, st); li.appendChild(row);
      }
      const open = () => { if (map) map.panTo({ lat: r.lat, lng: r.lng }, Math.max(map.getZoom(), 17)); openDetail(r); };
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      ul.appendChild(li);
    });
  }

  function badge(r) {
    const span = document.createElement('span');
    if (r.status === 'returned') { span.className = 'badge returned'; span.textContent = 'แจ้งว่าคืนแล้ว'; }
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
    $('#d-meta').textContent = `${TYPE_LABEL[r.vehicle_type] || ''} · ${r.status === 'returned' ? 'มีคนแจ้งว่าคืนแล้ว' : 'ยังไม่มีคนมารับ'} · แจ้งเมื่อ ${new Date(r.created_at).toLocaleString('th-TH')}`;
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
    renderClaim(r);
    $('#detail').showModal();
  }

  let detailReport = null;
  function renderClaim(r) {
    detailReport = r;
    const form = $('#claim-form'); form.reset(); form.hidden = true; $('#c-msg').textContent = ''; $('#c-msg').className = 'msg';
    $('#d-claim-buttons').hidden = false;
    const info = $('#d-returned');
    info.hidden = true; info.innerHTML = ''; info.classList.remove('moved');
    if (r.update_kind || r.status === 'returned') {
      info.hidden = false;
      const when = r.claimed_at ? ' เมื่อ ' + new Date(r.claimed_at).toLocaleString('th-TH') : '';
      if (r.status === 'returned') info.append('✅ มีคนแจ้งว่าเจ้าของรับไปแล้ว' + when);
      else { info.classList.add('moved'); info.append('📍 อัปเดตล่าสุด' + when); }
      if (r.claim_note) { const m = document.createElement('span'); m.className = 'muted'; m.textContent = r.claim_note; info.appendChild(m); }
      if (r.claim_photo) { const img = document.createElement('img'); img.src = '/uploads/' + encodeURIComponent(r.claim_photo); img.alt = 'รูปอัปเดต'; info.appendChild(img); }
      if (r.status === 'returned') { const m = document.createElement('span'); m.className = 'muted'; m.textContent = 'ถ้าป้ายยังอยู่จริง กด "แจ้งว่าป้ายอยู่ที่ไหนตอนนี้" เพื่อแก้ไข'; info.appendChild(m); }
    }
    $('#d-claim-open').hidden = r.status === 'returned';
  }
  function openClaimForm(kind) {
    $('#c-kind').value = kind;
    $('#c-intro').textContent = kind === 'returned'
      ? 'เจ้าของมารับแล้วใช่ไหม? รายการจะติดป้าย "รับไปแล้ว" แต่ยังค้นหาเจอ เพื่อให้คนอื่นรู้ว่าไม่ต้องตามหาซ้ำ'
      : 'ป้ายยังอยู่ หรือถูกย้ายไปที่ไหน? บอกจุดที่อยู่ล่าสุดเพื่อให้เจ้าของตามไปรับได้';
    $('#c-note-label').textContent = kind === 'returned' ? 'หมายเหตุ (ไม่บังคับ)' : 'ป้ายอยู่ที่ไหนตอนนี้ *';
    $('#c-note').placeholder = kind === 'returned' ? 'เช่น เจ้าของมารับเมื่อบ่ายนี้' : 'เช่น ย้ายไปฝากไว้ที่ป้อมยามหมู่บ้าน / ยังอยู่ที่เดิม';
    $('#c-note').required = kind !== 'returned';
    $('#c-submit').textContent = kind === 'returned' ? 'ยืนยันรับไปแล้ว' : 'บันทึกที่อยู่ล่าสุด';
    $('#claim-form').hidden = false; $('#d-claim-buttons').hidden = true;
    $('#c-note').focus();
  }
  $('#d-claim-open').addEventListener('click', () => openClaimForm('returned'));
  $('#d-moved-open').addEventListener('click', () => openClaimForm('moved'));
  $('#c-cancel').addEventListener('click', () => { $('#claim-form').hidden = true; $('#d-claim-buttons').hidden = false; });
  $('#claim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!detailReport) return;
    const btn = $('#c-submit'); const msg = $('#c-msg');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'กำลังบันทึก…'; msg.className = 'msg'; msg.textContent = '';
    try {
      const fd = new FormData($('#claim-form'));
      const updated = await api('/api/reports/' + encodeURIComponent(detailReport.id) + '/claim', { method: 'POST', body: fd });
      renderClaim(updated);
      $('#d-meta').textContent = $('#d-meta').textContent.replace(/(ยังไม่มีคนมารับ|มีคนแจ้งว่าคืนแล้ว)/, updated.status === 'returned' ? 'มีคนแจ้งว่าคืนแล้ว' : 'ยังไม่มีคนมารับ');
      runSearch();
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = err.status === 429 ? 'ทำรายการบ่อยเกินไป กรุณารอสักครู่' : ERR[err.message] || 'บันทึกไม่สำเร็จ กรุณาลองใหม่';
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });

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
      if (pan) showMapIfNeeded();
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

  $('#r-center').addEventListener('click', () => { showMapIfNeeded(); if (map) setDraft(map.getCenter()); });
  $('#r-geoloc').addEventListener('click', () => { showMapIfNeeded(); locate(true); });
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

  // ---------- report: photo (in-app camera only) ----------
  let capturedPhoto = null; // File taken with the in-app camera
  const CAM_ERR = {
    camera_unsupported: 'เบราว์เซอร์นี้ไม่รองรับกล้อง กรุณาใช้ Chrome หรือ Safari บนมือถือ',
    camera_insecure: 'ต้องเปิดผ่าน https จึงจะใช้กล้องได้',
    camera_denied: 'ไม่ได้รับอนุญาตให้ใช้กล้อง กรุณาอนุญาตในตั้งค่าเบราว์เซอร์แล้วลองใหม่',
    camera_failed: 'เปิดกล้องไม่สำเร็จ ลองปิดแอปอื่นที่ใช้กล้องอยู่แล้วลองใหม่',
  };
  function setPhoto(file) {
    capturedPhoto = file;
    const box = $('#r-preview'); const img = $('#r-preview-img');
    $('#ai-box').hidden = true; $('#ai-status').textContent = '';
    if (!file) { box.hidden = true; img.removeAttribute('src'); $('#r-shoot').hidden = false; return; }
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    box.hidden = false; $('#r-shoot').hidden = true; $('#ai-box').hidden = false;
  }
  async function takePhoto() {
    const msg = $('#cam-msg'); msg.hidden = true;
    try {
      const file = await window.AppCamera.open();
      if (file) setPhoto(file);
    } catch (e) {
      msg.textContent = CAM_ERR[e.message] || CAM_ERR.camera_failed; msg.hidden = false;
    }
  }
  $('#r-shoot').addEventListener('click', takePhoto);
  window.PlateApp = { setPhoto }; // used by automated tests to inject a captured photo
  $('#r-retake').addEventListener('click', takePhoto);

  const AI_ERR = {
    ocr_disabled: 'ระบบอ่านอัตโนมัติยังไม่เปิดใช้งาน กรุณากรอกเอง',
    ocr_load_failed: 'โหลดตัวอ่านป้ายไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่ หรือกรอกเอง',
    ocr_budget: 'วันนี้ใช้ AI ครบโควตาแล้ว กรุณากรอกเอง',
    http_429: 'ใช้ AI บ่อยเกินไป รอสักครู่หรือกรอกเอง',
    ai_declined: 'AI ไม่สามารถอ่านรูปนี้ได้ กรุณากรอกเอง',
    bad_image: 'อ่านไฟล์รูปไม่ได้ ลองถ่ายใหม่',
  };
  $('#r-ai').addEventListener('click', async () => {
    const f = capturedPhoto;
    if (!f) return;
    const btn = $('#r-ai'); const st = $('#ai-status');
    btn.disabled = true; st.className = 'small spin'; st.style.color = '';
    st.textContent = cfg.ocrEnabled ? 'AI กำลังอ่านป้าย… ประมาณ 5-15 วินาที' : 'กำลังเตรียมตัวอ่านป้าย…';
    try {
      let out;
      if (cfg.ocrEnabled) {
        const fd = new FormData(); fd.set('photo', f);
        out = await api('/api/ocr', { method: 'POST', body: fd });
      } else {
        // Free path: Tesseract runs in this browser, the photo never leaves the device.
        out = await window.LocalOCR.readPlates(f, cfg.provinces, (m) => {
          if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') st.textContent = 'กำลังโหลดตัวอ่านป้าย (ครั้งแรกประมาณ 4 MB)…';
          else if (m.status === 'loading language traineddata') st.textContent = `กำลังโหลดโมเดลภาษาไทย… ${Math.round((m.progress || 0) * 100)}%`;
          else if (m.status === 'recognizing text') st.textContent = `กำลังอ่านป้าย… ${Math.round((m.progress || 0) * 100)}%`;
        });
      }
      st.className = 'muted small';
      if (!out.plates.length) { st.textContent = 'ไม่พบป้ายทะเบียนในรูป ลองถ่ายใหม่ให้ชัด ตรง และใกล้ขึ้น หรือกรอกเอง'; return; }
      $$('.plate-row').forEach((r) => { if (!r.querySelector('.p-plate').value.trim()) r.remove(); });
      out.plates.forEach((p) => addPlateRow(p));
      renumberRows();
      const low = out.plates.filter((p) => p.confidence < 0.7 || !p.plausible || !p.province).length;
      st.textContent = `พบ ${out.plates.length} แผ่น` + (low ? ` · ${low} แผ่นควรตรวจสอบเป็นพิเศษ (กรอบสีเหลือง)` : ' · โปรดตรวจสอบก่อนส่ง');
      $('#plate-rows').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.warn('ocr failed', err);
      st.className = 'small'; st.style.color = 'var(--danger)';
      st.textContent = AI_ERR[err.message] || 'อ่านไม่สำเร็จ กรุณากรอกเอง';
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- report: plate rows ----------
  function addPlateRow(data = {}) {
    const node = $('#plate-row-tpl').content.firstElementChild.cloneNode(true);
    const sel = node.querySelector('.p-province');
    cfg.provinces.forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o); });
    node.querySelector('.p-plate').value = data.plate || '';
    sel.value = data.province || '';
    const type = ['car', 'motorcycle', 'other'].includes(data.vehicleType) ? data.vehicleType : 'car';
    node.querySelectorAll('.seg input').forEach((r) => { r.checked = r.value === type; });
    const conf = node.querySelector('.conf');
    if (typeof data.confidence === 'number') {
      const pct = Math.round(data.confidence * 100);
      const low = data.confidence < 0.7 || data.plausible === false || !data.province;
      conf.textContent = low ? `ตรวจสอบ · AI มั่นใจ ${pct}%` : `AI มั่นใจ ${pct}%`;
      conf.className = 'conf ' + (low ? 'lo' : 'hi');
      if (low) node.classList.add('low');
    } else {
      conf.remove();
    }
    const note = node.querySelector('.ai-note');
    if (data.note) { note.textContent = '💡 ' + data.note; note.hidden = false; }
    const alts = node.querySelector('.alts');
    if (Array.isArray(data.alternatives) && data.alternatives.length) {
      data.alternatives.forEach((alt) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = alt;
        b.addEventListener('click', () => { node.querySelector('.p-plate').value = alt; node.classList.remove('low'); });
        alts.appendChild(b);
      });
      alts.hidden = false;
    }
    node.querySelector('.remove-plate').addEventListener('click', () => {
      if ($$('.plate-row').length === 1) { node.querySelector('.p-plate').value = ''; sel.value = ''; node.classList.remove('low'); note.hidden = true; conf.remove(); return; }
      node.remove(); renumberRows();
    });
    node.querySelector('.p-plate').addEventListener('input', () => node.classList.remove('low'));
    $('#plate-rows').appendChild(node);
    renumberRows();
    return node;
  }
  function renumberRows() {
    const rows = $$('.plate-row');
    rows.forEach((r, i) => { r.querySelector('.plate-row-idx').textContent = `แผ่นที่ ${i + 1}`; });
    $('#plate-count').textContent = rows.length > 1 ? `${rows.length} แผ่น` : '';
    // Radio groups must have unique names per row.
    rows.forEach((r, i) => r.querySelectorAll('.seg input').forEach((inp) => (inp.name = 'vt' + i)));
  }
  function readPlateRows() {
    return $$('.plate-row').map((r) => ({
      plate: r.querySelector('.p-plate').value.trim(),
      province: r.querySelector('.p-province').value,
      vehicleType: r.querySelector('.seg input:checked')?.value || 'car',
      el: r,
    }));
  }
  $('#add-plate').addEventListener('click', () => { const n = addPlateRow(); n.querySelector('.p-plate').focus(); });

  // ---------- report: submit ----------
  function showError(msg) { const e = $('#r-error'); e.textContent = msg; e.hidden = !msg; }
  const ERR = {
    validation: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง',
    photo_too_large: 'รูปใหญ่เกิน 8 MB',
    duplicate_photo: 'รูปนี้เคยถูกแจ้งไว้แล้ว',
    unsupported_image: 'รองรับเฉพาะไฟล์รูปภาพ (JPG, PNG, WEBP, HEIC)',
    bad_image: 'อ่านไฟล์รูปไม่ได้ ลองถ่ายใหม่หรือเลือกรูปอื่น',
    http_429: 'ส่งบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  };
  $('#report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    if (!draft) { showError('กรุณาปักหมุดจุดที่พบบนแผนที่ก่อน (ขั้นที่ 3)'); $('#r-locstatus').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    const rows = readPlateRows();
    const bad = rows.find((r) => !r.plate || !r.province);
    if (bad) { showError('กรุณากรอกเลขทะเบียนและจังหวัดให้ครบทุกแผ่น'); bad.el.querySelector(!bad.plate ? '.p-plate' : '.p-province').focus(); return; }
    if (rows.some((r) => r.plate.includes('?'))) { showError('มีเลขทะเบียนที่ยังมีเครื่องหมาย ? กรุณาแก้เป็นตัวอักษรที่ถูกต้อง'); return; }

    if (cfg.photoRequired && !capturedPhoto) { showError('กรุณาถ่ายรูปป้ายก่อน (ขั้นที่ 1) รับเฉพาะรูปที่ถ่ายจากกล้องในแอป'); $('#r-shoot').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }

    await submitReport(rows, false);
  });

  async function submitReport(rows, allowDuplicate) {
    const form = $('#report-form');
    const btn = $('#r-submit'); btn.disabled = true; btn.textContent = rows.length > 1 ? `กำลังส่ง ${rows.length} แผ่น…` : 'กำลังส่ง…';
    try {
      const fd = new FormData();
      if (allowDuplicate) fd.set('allowDuplicate', '1');
      fd.set('plates', JSON.stringify(rows.map((r) => ({ plate: r.plate, province: r.province, vehicleType: r.vehicleType }))));
      fd.set('lat', fmt7(draft.lat)); fd.set('lng', fmt7(draft.lng));
      fd.set('accuracy', $('#r-accuracy').value); fd.set('placeNote', $('#r-place').value); fd.set('note', $('#r-note').value);
      fd.set('website', form.elements.website.value);
      if (capturedPhoto) fd.set('photo', capturedPhoto, capturedPhoto.name);
      const out = await api('/api/reports', { method: 'POST', body: fd });
      showSuccess(out.reports);
      draft = null; draftAccuracy = null; map?.setDraft(null); map?.setAccuracyCircle(null);
      runSearch();
    } catch (err) {
      let msg = ERR[err.message] || 'ส่งไม่สำเร็จ กรุณาลองใหม่';
      if (err.message === 'duplicate_plate') {
        const ex = err.body?.existing || [];
        const lines = ex.map((e) => `• ${e.plate_display} ${e.province} · แจ้งไว้ ${timeAgo(e.created_at)} · ห่างจากจุดนี้ ${e.distance_m < 1000 ? e.distance_m + ' ม.' : (e.distance_m / 1000).toFixed(1) + ' กม.'}`).join('\n');
        const again = window.confirm(`มีป้ายเลขนี้แจ้งไว้แล้วในระบบ:\n${lines}\n\nถ้าเป็นแผ่นเดียวกัน ไม่ต้องแจ้งซ้ำ กด "ยกเลิก"\nถ้าเป็นอีกแผ่นของรถคันเดียวกัน (ป้ายหน้า/หลัง) กด "ตกลง" เพื่อแจ้งเพิ่ม`);
        btn.disabled = false; btn.textContent = 'ส่งรายงาน';
        if (again) return submitReport(rows, true);
        showError('ไม่ได้ส่ง: ป้ายนี้มีในระบบแล้ว');
        if (ex[0]) { const a = document.createElement('a'); a.href = '#'; a.textContent = ' ดูรายการเดิม'; a.onclick = (ev) => { ev.preventDefault(); api('/api/reports/' + encodeURIComponent(ex[0].id)).then(openDetail).catch(() => {}); }; $('#r-error').appendChild(a); }
        return;
      }
      if (err.message === 'duplicate_photo') {
        const ex = err.body?.existing || [];
        msg = 'รูปนี้เคยถูกแจ้งไว้แล้ว' + (ex.length ? ` (${ex.map((e) => e.plate_display + ' ' + e.province).join(', ')})` : '') + ' ถ้าเป็นป้ายคนละแผ่น กรุณาถ่ายรูปใหม่';
        showError(msg);
        if (ex[0]) { const a = document.createElement('a'); a.href = '#'; a.textContent = ' ดูรายการเดิม'; a.onclick = (ev) => { ev.preventDefault(); api('/api/reports/' + encodeURIComponent(ex[0].id)).then(openDetail).catch(() => {}); }; $('#r-error').appendChild(a); }
        return;
      }
      if (err.body?.fields) {
        const f = err.body.fields;
        if (f.photo) msg = 'กรุณาถ่ายรูปป้ายก่อนส่ง';
        else if (f.plate === 'duplicate') msg = 'มีเลขทะเบียนซ้ำกันในรายการ กรุณาลบแผ่นที่ซ้ำ';
        else if (f.plate) msg = 'เลขทะเบียนไม่ถูกต้อง (ต้องมีตัวเลขอย่างน้อย 1 ตัว และไม่มี ?)';
        else if (f.province) msg = 'กรุณาเลือกจังหวัดให้ครบทุกแผ่น';
        else if (f.location) msg = 'พิกัดไม่ถูกต้อง กรุณาปักหมุดใหม่';
      }
      showError(msg);
    } finally {
      btn.disabled = false; btn.textContent = 'ส่งรายงาน';
    }
  }

  function showSuccess(created) {
    const list = $('#ok-list'); list.innerHTML = '';
    created.forEach((c) => {
      const d = document.createElement('div'); d.className = 'rep';
      const b = document.createElement('b'); b.textContent = `${c.report.plate_display} · ${c.report.province}`;
      const id = document.createElement('div'); id.innerHTML = '<span>รหัสรายงาน</span> '; const c1 = document.createElement('code'); c1.textContent = c.report.id; id.appendChild(c1);
      const tk = document.createElement('div'); tk.innerHTML = '<span>รหัสจัดการ</span> '; const c2 = document.createElement('code'); c2.textContent = c.token; tk.appendChild(c2);
      d.append(b, id, tk); list.appendChild(d);
    });
    const text = created.map((c) => `${c.report.plate_display} ${c.report.province}\nรหัสรายงาน: ${c.report.id}\nรหัสจัดการ: ${c.token}`).join('\n\n');
    $('#ok-copy').onclick = () => copy(text, $('#ok-copy'));
    $('#report-form').hidden = true; $('#r-success').hidden = false;
    $('#r-success').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#ok-another').addEventListener('click', () => {
    $('#report-form').reset(); setPhoto(null);
    $('#plate-rows').innerHTML = ''; addPlateRow();
    $('#r-locstatus').textContent = 'ยังไม่ได้ปักหมุด'; $('#r-locstatus').className = 'muted';
    $('#report-form').hidden = false; $('#r-success').hidden = true;
  });

  // ---------- stats ----------
  const fmtN = (n) => Number(n || 0).toLocaleString('th-TH');
  async function loadStats() {
    let st;
    try { st = await api('/api/stats'); } catch { $('#st-updated').textContent = 'โหลดสถิติไม่สำเร็จ'; return; }
    $('#st-total').textContent = fmtN(st.total);
    $('#st-found').textContent = fmtN(st.found);
    $('#st-returned').textContent = fmtN(st.returned);
    $('#st-24h').textContent = fmtN(st.last24h);
    const wrap = $('#st-progress');
    if (st.total > 0) {
      const rate = Math.round((st.returned / st.total) * 100);
      wrap.hidden = false; $('#st-rate').textContent = rate + '%'; $('#st-rate-bar').style.width = rate + '%';
    } else wrap.hidden = true;

    const barRows = (el, rows) => {
      el.innerHTML = '';
      if (!rows.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'ยังไม่มีข้อมูล'; el.appendChild(e); return; }
      const max = Math.max(...rows.map((r) => r.total)) || 1;
      rows.forEach((r) => {
        const row = document.createElement('div'); row.className = 'bar-row';
        row.title = `${r.name}: รอเจ้าของ ${fmtN(r.found)} · คืนแล้ว ${fmtN(r.returned)}`;
        const name = el2('span', 'name', r.name);
        const track = el2('div', 'track');
        const w = (r.total / max) * 100;
        if (r.found) { const a = el2('div', 'seg wait'); a.style.width = (w * r.found / r.total) + '%'; track.appendChild(a); }
        if (r.returned) { const b = el2('div', 'seg done'); b.style.width = (w * r.returned / r.total) + '%'; track.appendChild(b); }
        row.append(name, track, el2('span', 'val', fmtN(r.total)));
        el.appendChild(row);
      });
    };
    barRows($('#st-type'), [
      { name: 'รถยนต์', total: st.car, found: 0, returned: 0 },
      { name: 'มอเตอร์ไซค์', total: st.motorcycle, found: 0, returned: 0 },
      { name: 'อื่น ๆ', total: st.other, found: 0, returned: 0 },
    ].filter((r) => r.total > 0).map((r) => ({ ...r, found: r.total })));
    barRows($('#st-province'), st.byProvince.map((p) => ({ name: p.province, total: p.total, found: p.found, returned: p.returned })));

    // 14-day columns: reports per day (red) and returns per day (green)
    const daily = $('#st-daily'); daily.innerHTML = '';
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() + 7 * 3600_000 - i * 86_400_000); // Thai calendar day
      days.push(d.toISOString().slice(0, 10));
    }
    const found = Object.fromEntries(st.daily.map((r) => [r.day, r.count]));
    const done = Object.fromEntries(st.returnedDaily.map((r) => [r.day, r.count]));
    const max = Math.max(1, ...days.map((d) => (found[d] || 0) + (done[d] || 0)));
    days.forEach((d) => {
      const col = el2('div', 'day');
      const f = found[d] || 0, r = done[d] || 0;
      col.dataset.tip = `${d.slice(8)}/${d.slice(5, 7)}: แจ้ง ${f} · คืน ${r}`;
      if (r) { const b = el2('div', 'b done'); b.style.height = (r / max) * 100 + '%'; col.appendChild(b); }
      if (f) { const b = el2('div', 'b wait'); b.style.height = (f / max) * 100 + '%'; col.appendChild(b); }
      daily.appendChild(col);
    });
    let labels = daily.nextElementSibling;
    if (!labels || !labels.classList.contains('daily-labels')) { labels = el2('div', 'daily-labels'); daily.after(labels); }
    labels.innerHTML = '';
    days.forEach((d, i) => { const l = el2('span', '', i % 3 === 0 ? `${+d.slice(8)}/${+d.slice(5, 7)}` : ''); labels.appendChild(l); });
    $('#st-updated').textContent = 'อัปเดต ' + new Date().toLocaleTimeString('th-TH') + ' · สถิติจากรายการทั้งหมดในระบบ';
  }
  function el2(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // ---------- feedback ----------
  const feedbackForm = $('#feedback-form');
  if (feedbackForm) feedbackForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#fb-msg'); const btn = $('#fb-submit');
    const text = $('#fb-message').value.trim();
    if (text.length < 3) { msg.className = 'msg err'; msg.textContent = 'พิมพ์ข้อความสักหน่อยนะครับ'; return; }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = '';
    try {
      await api('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: feedbackForm.elements.kind.value, message: text, website: feedbackForm.elements.website.value }) });
      feedbackForm.reset();
      msg.className = 'msg ok'; msg.textContent = 'ส่งแล้ว ขอบคุณมากครับ 🙏';
    } catch (err) {
      msg.className = 'msg err'; msg.textContent = err.status === 429 ? 'ส่งบ่อยเกินไป กรุณารอสักครู่' : 'ส่งไม่สำเร็จ กรุณาลองใหม่';
    } finally { btn.disabled = false; }
  });

  const KIND_LABEL = { suggestion: '💡 ข้อเสนอแนะ', praise: '💖 ให้กำลังใจ', problem: '🐞 แจ้งปัญหา' };
  async function loadFeedback() {
    const list = $('#fb-list'); if (!list || !adminToken) return;
    list.innerHTML = '';
    try {
      const out = await api('/api/admin/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken }) });
      $('#fb-count').textContent = out.count ? `(${out.count})` : '(ยังไม่มี)';
      out.items.forEach((f) => {
        const d = el2('div', 'fb-item');
        const head = el2('div', 'fb-head');
        head.append(el2('span', '', KIND_LABEL[f.kind] || f.kind), el2('span', '', new Date(f.created_at).toLocaleString('th-TH')));
        const del = el2('button', 'btn small ghost', '🗑️'); del.type = 'button'; del.title = 'ลบข้อความ';
        del.addEventListener('click', async () => {
          if (!confirm('ลบข้อความนี้?')) return;
          try { await api('/api/admin/feedback/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken, id: f.id }) }); loadFeedback(); } catch { alert('ลบไม่สำเร็จ'); }
        });
        head.appendChild(del);
        d.append(head, el2('p', '', f.message));
        list.appendChild(d);
      });
    } catch { $('#fb-count').textContent = '(โหลดไม่สำเร็จ)'; }
  }

  // ---------- admin mode (token kept in memory only) ----------
  let adminToken = null;
  function setAdmin(token) {
    adminToken = token;
    $('#admin-tools').hidden = !token;
    $('#a-logout').hidden = !token;
    $('#a-login').hidden = !!token;
    $('#a-token').disabled = !!token;
    let badge = $('#admin-badge');
    if (token && !badge) { badge = document.createElement('div'); badge.id = 'admin-badge'; badge.className = 'admin-badge'; badge.textContent = '🔓 โหมดผู้ดูแล'; document.body.appendChild(badge); }
    if (!token && badge) badge.remove();
    runSearch();
    if (token) loadFeedback();
  }
  $('#admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('#a-token').value.trim(); const msg = $('#a-msg'); msg.className = 'msg'; msg.textContent = '';
    try {
      const out = await api('/api/admin/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      setAdmin(token);
      msg.className = 'msg ok'; msg.textContent = `เข้าสู่โหมดผู้ดูแลแล้ว (รายงาน ${out.total} รายการ · ข้อเสนอแนะ ${out.feedback || 0} ข้อความ) ไปที่แท็บค้นหาเพื่อลบรายการ`;
    } catch (err) {
      msg.className = 'msg err'; msg.textContent = err.status === 403 ? 'รหัสผู้ดูแลไม่ถูกต้อง' : err.status === 429 ? 'ลองบ่อยเกินไป กรุณารอสักครู่' : 'เชื่อมต่อไม่สำเร็จ';
    }
  });
  $('#a-logout').addEventListener('click', () => { setAdmin(null); $('#a-token').value = ''; $('#a-msg').textContent = ''; });
  $('#a-wipe').addEventListener('click', async () => {
    if (!adminToken) return;
    const typed = window.prompt('การล้างข้อมูลลบทุกรายงานและทุกรูปถาวร กู้คืนไม่ได้\nพิมพ์คำว่า  ลบทั้งหมด  เพื่อยืนยัน');
    if (typed !== 'ลบทั้งหมด') return;
    try {
      const out = await api('/api/admin/wipe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken, confirm: 'WIPE' }) });
      alert(`ล้างข้อมูลแล้ว (ลบรูป ${out.deleted} ไฟล์)`);
      runSearch();
    } catch { alert('ล้างข้อมูลไม่สำเร็จ'); }
  });
  async function adminDelete(r) {
    if (!confirm(`ลบรายงาน ${r.plate_display} ${r.province} ถาวร?`)) return;
    try {
      await api('/api/reports/' + encodeURIComponent(r.id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken }) });
      runSearch();
    } catch { alert('ลบไม่สำเร็จ'); }
  }
  async function adminStatus(r, status) {
    try {
      await api('/api/reports/' + encodeURIComponent(r.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken, status }) });
      runSearch();
    } catch { alert('อัปเดตไม่สำเร็จ'); }
  }

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
    for (const sel of ['#s-province']) {
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
    addPlateRow();
    if (!cfg.photoRequired) { $('#s1-req').hidden = true; $('#s1-hint').textContent = 'ไม่บังคับ • ถ่ายจากกล้องเท่านั้น'; }
    if (cfg.ocrEnabled) $('#s1-note').textContent = 'ถ่ายให้เห็นทุกแผ่นชัด ๆ ในรูปเดียวได้ AI จะแยกให้ทีละแผ่น • ระบบลบ EXIF/GPS ในรูปและย่อขนาดอัตโนมัติ';
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
    if (isAdminPage) setTab('manage');
  }
  init();
})();
