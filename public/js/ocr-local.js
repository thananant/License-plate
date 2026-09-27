/* Free, on-device plate reading with Tesseract.js (Thai model).
   Nothing leaves the browser. Exposes window.LocalOCR.readPlates(file, onProgress)
   returning the same shape as the server /api/ocr endpoint. */
(function () {
  'use strict';

  const BASE = '/vendor/tesseract';
  let workerPromise = null;
  let scriptLoaded = false;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('ocr_load_failed'));
      document.head.appendChild(s);
    });
  }

  async function getWorker(onProgress) {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      if (!scriptLoaded) { await loadScript(`${BASE}/tesseract.min.js`); scriptLoaded = true; }
      const worker = await Tesseract.createWorker('tha', 1, {
        workerPath: `${BASE}/worker.min.js`,
        corePath: BASE,
        langPath: `${BASE}/lang`,
        gzip: true,
        legacyCore: false,
        legacyLang: false,
        cacheMethod: 'none',
        logger: (m) => { if (onProgress) onProgress(m); },
      });
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
    return workerPromise;
  }

  // ---------- image preprocessing ----------
  async function toCanvas(file) {
    const bmp = await createImageBitmap(file).catch(() => null);
    let img = bmp;
    if (!img) {
      img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    }
    const maxEdge = 3200;
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const color = document.createElement('canvas'); color.width = w; color.height = h;
    const cctx = color.getContext('2d', { willReadFrequently: true });
    cctx.drawImage(img, 0, 0, w, h);
    // grayscale + contrast stretch copy for OCR (dirty/flood-stained plates)
    const gray = document.createElement('canvas'); gray.width = w; gray.height = h;
    const gctx = gray.getContext('2d', { willReadFrequently: true });
    const d = cctx.getImageData(0, 0, w, h); const p = d.data;
    const out = gctx.createImageData(w, h); const q = out.data;
    let min = 255, max = 0;
    const lum = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const g = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000;
      lum[j] = g; if (g < min) min = g; if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const v = ((lum[j] - min) / range) * 255;
      q[i] = q[i + 1] = q[i + 2] = v; q[i + 3] = 255;
    }
    gctx.putImageData(out, 0, 0);
    return { gray, color };
  }

  // ---------- crop enhancement ----------
  // Local contrast normalisation: (pixel - local mean) / local std. Flattens
  // shadows, mud stains and uneven lighting so glyphs keep a steady contrast.
  function localNormalize(src, win = 48) {
    const w = src.width, h = src.height;
    const ctx = src.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h); const p = img.data;
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) g[j] = p[i];
    // integral images for mean and mean of squares
    const W = w + 1;
    const I = new Float64Array(W * (h + 1)), I2 = new Float64Array(W * (h + 1));
    for (let y = 1; y <= h; y++) {
      let row = 0, row2 = 0;
      for (let x = 1; x <= w; x++) {
        const v = g[(y - 1) * w + (x - 1)];
        row += v; row2 += v * v;
        I[y * W + x] = I[(y - 1) * W + x] + row;
        I2[y * W + x] = I2[(y - 1) * W + x] + row2;
      }
    }
    const r = win >> 1;
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const octx = out.getContext('2d'); const od = octx.createImageData(w, h); const q = od.data;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const n = (y1 - y0) * (x1 - x0);
        const sum = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
        const sum2 = I2[y1 * W + x1] - I2[y0 * W + x1] - I2[y1 * W + x0] + I2[y0 * W + x0];
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(1, sum2 / n - mean * mean));
        const v = 128 + ((g[y * w + x] - mean) / sd) * 60;
        const c = v < 0 ? 0 : v > 255 ? 255 : v;
        const k = (y * w + x) * 4;
        q[k] = q[k + 1] = q[k + 2] = c; q[k + 3] = 255;
      }
    }
    octx.putImageData(od, 0, 0);
    return out;
  }

  // Otsu global threshold -> clean black-on-white, which the LSTM likes.
  function binarize(src) {
    const w = src.width, h = src.height;
    const ctx = src.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h); const p = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < p.length; i += 4) hist[p[i]]++;
    const total = w * h;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const octx = out.getContext('2d'); const od = octx.createImageData(w, h); const q = od.data;
    for (let i = 0; i < p.length; i += 4) { const c = p[i] > thr ? 255 : 0; q[i] = q[i + 1] = q[i + 2] = c; q[i + 3] = 255; }
    octx.putImageData(od, 0, 0);
    return out;
  }

  // ---------- text parsing ----------
  const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
  const norm = (t) => (t || '')
    .normalize('NFC')
    .replace(/[๐-๙]/g, (ch) => String(THAI_DIGITS.indexOf(ch)))
    .replace(/[|่้๊๋์ํ็ั]/g, '') // plates never carry tone marks; OCR often hallucinates them
    .replace(/\s+/g, ' ')
    .trim();

  // 1กข 1234 | กข 1234. Thai plates never carry three letters or more than four
  // digits; a third "letter" is usually a misread leading digit. Tesseract often
  // emits a space between every Thai glyph, so match on the de-spaced text.
  const PLATE_RE = /(\d)?([ก-ฮ]{1,3})[-.:_]?(\d{1,4})(?!\d)/;

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function bestProvince(text, provinces) {
    const t = text.replace(/[^ก-์]/g, '');
    if (t.length < 3) return null;
    let best = null, bestScore = 0;
    for (const p of provinces) {
      // compare against the province and against any window of the same length inside the line
      let score = 0;
      if (t.includes(p)) score = 1;
      else {
        const len = p.length;
        for (let i = 0; i + Math.min(len, t.length) <= t.length; i++) {
          const win = t.slice(i, i + len);
          const s = 1 - levenshtein(win, p) / Math.max(len, win.length);
          if (s > score) score = s;
          if (t.length <= len) break;
        }
      }
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return bestScore >= 0.6 ? { province: best, score: bestScore } : null;
  }

  function parseLines(lines, provinces) {
    const plates = [];
    const provLines = [];
    for (const ln of lines) {
      const text = norm(ln.text);
      if (!text) continue;
      const compact = text.replace(/\s+/g, '');
      const m = compact.match(PLATE_RE);
      const prov = bestProvince(compact, provinces);
      // "กรุงเทพมหานคร 230" is a province line with noise, not plate "นคร 230"
      const provLine = prov && prov.score >= 0.75 && (!m || prov.province.includes(m[2]) && compact.indexOf(m[0]) >= compact.indexOf(prov.province.slice(0, 3)));
      if (m && !provLine) {
        const digits = m[3];
        let letters = m[2];
        let suspect = '';
        if (letters.length === 3) { letters = letters.slice(1); suspect = 'ตัวหน้าอาจเป็นตัวเลข (เช่น 1) กรุณาตรวจสอบ'; }
        plates.push({
          plate: `${m[1] || ''}${letters} ${digits}`.trim(),
          letters,
          suspect,
          bbox: ln.bbox, conf: ln.confidence,
          province: prov && !compact.startsWith(m[0]) ? prov.province : '',
          provScore: prov ? prov.score : 0,
        });
      }
      if ((!m || provLine) && prov) {
        provLines.push({ province: prov.province, score: prov.score, bbox: ln.bbox, conf: ln.confidence, used: false });
      }
    }
    // attach the nearest province line below each plate line (same column)
    for (const p of plates) {
      if (p.province) continue;
      let best = null, bestDist = Infinity;
      for (const pl of provLines) {
        if (pl.used) continue;
        const dy = pl.bbox.y0 - p.bbox.y1;
        const overlap = Math.min(p.bbox.x1, pl.bbox.x1) - Math.max(p.bbox.x0, pl.bbox.x0);
        const h = p.bbox.y1 - p.bbox.y0;
        if (dy > -h * 0.5 && dy < h * 3 && overlap > 0 && dy < bestDist) { best = pl; bestDist = dy; }
      }
      if (best) { best.used = true; p.province = best.province; p.provScore = best.score; }
    }
    const out = plates.map((p) => {
      const conf = Math.max(0, Math.min(1, (p.conf || 0) / 100));
      const combined = p.province ? Math.min(conf, 0.4 + 0.6 * p.provScore) : conf * 0.7;
      return {
        bbox: p.bbox,
        plate: p.plate,
        province: p.province,
        vehicleType: 'car',
        confidence: Math.round((p.suspect ? combined * 0.7 : combined) * 100) / 100,
        note: [p.suspect, p.province ? '' : 'อ่านชื่อจังหวัดไม่ได้ กรุณาเลือกเอง'].filter(Boolean).join(' · '),
        plausible: !p.suspect,
      };
    });
    // provinces we saw but could not pair with a number: still useful as a row to complete
    for (const pl of provLines) {
      if (!pl.used) out.push({ plate: '', province: pl.province, vehicleType: 'car', confidence: Math.round(pl.score * 60) / 100, note: 'อ่านเลขทะเบียนไม่ได้ กรุณากรอกเอง', plausible: false });
    }
    // de-duplicate identical plates
    const seen = new Set();
    return out.filter((r) => { const k = r.plate + '|' + r.province; if (r.plate && seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
  }

  // ---------- plate region detection ----------
  // Plates are bright rectangles with dark glyphs. Find bright connected
  // components on a small grayscale copy and keep the plate-shaped ones.
  function findPlateRegions(color) {
    const W = 480;
    const sc = Math.min(1, W / color.width);
    const w = Math.max(1, Math.round(color.width * sc)), h = Math.max(1, Math.round(color.height * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(color, 0, 0, w, h);
    const p = ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h), sat = new Uint8Array(w * h);
    let sum = 0;
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const r = p[i], gg = p[i + 1], b = p[i + 2];
      const l = (r * 299 + gg * 587 + b * 114) / 1000;
      g[j] = l; sum += l;
      // coloured plates (yellow, auction gradients, green text plates) vs grey concrete/asphalt
      sat[j] = Math.max(r, gg, b) - Math.min(r, gg, b) > 40 && l > 100 ? 1 : 0; // muddy brown ground stays below this
    }
    const mean = sum / (w * h);
    const thresholds = [Math.max(150, Math.min(210, mean + 45)), 225];
    const all = [];
    for (const thr of thresholds) all.push(...components(g, sat, w, h, thr));
    // when a big blob (frame + several plates) contains smaller plate blobs, keep the small ones
    const contains = (a, b) => b.x0 >= a.x0 - 2 && b.y0 >= a.y0 - 2 && b.x1 <= a.x1 + 2 && b.y1 <= a.y1 + 2 && (b.area < a.area * 0.9);
    let keep = all.filter((a) => all.filter((b) => b !== a && contains(a, b)).length < 2);
    // drop duplicates (same box from both thresholds) and boxes nested in a kept box
    keep.sort((a, b) => b.area - a.area);
    const out = [];
    for (const b of keep) {
      const dup = out.some((k) => contains(k, b) || (Math.abs(k.x0 - b.x0) < 6 && Math.abs(k.y0 - b.y0) < 6 && Math.abs(k.x1 - b.x1) < 6 && Math.abs(k.y1 - b.y1) < 6));
      if (!dup) out.push(b);
      if (out.length >= 16) break;
    }
    out.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    return out.map((b) => ({ x0: b.x0 / sc, y0: b.y0 / sc, x1: (b.x1 + 1) / sc, y1: (b.y1 + 1) / sc, aspect: b.aspect, area: b.area, edge: b.edge }));
  }

  function components(g, sat, w, h, thr) {
    const mask = new Uint8Array(w * h);
    for (let j = 0; j < g.length; j++) mask[j] = g[j] >= thr || sat[j] ? 1 : 0;
    const dil = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) { dil[i] = 1; continue; }
      let on = 0;
      // 1-px closing only: a wider one would bridge the thin frame between stacked plates
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w && mask[yy * w + xx]) { on = 1; break; }
      }
      dil[i] = on;
    }
    const seen = new Uint8Array(w * h);
    const boxes = [];
    const stack = [];
    for (let s0 = 0; s0 < w * h; s0++) {
      if (!dil[s0] || seen[s0]) continue;
      let x0 = w, x1 = 0, y0 = h, y1 = 0, area = 0;
      stack.length = 0; stack.push(s0); seen[s0] = 1;
      while (stack.length) {
        const i = stack.pop(); area++;
        const x = i % w, y = (i - x) / w;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        const nb = [i - 1, i + 1, i - w, i + w];
        for (const n of nb) {
          if (n < 0 || n >= w * h || seen[n] || !dil[n]) continue;
          if ((n === i - 1 && x === 0) || (n === i + 1 && x === w - 1)) continue;
          seen[n] = 1; stack.push(n);
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const aspect = bw / bh, fill = area / (bw * bh);
      if (bw < w * 0.08 || bh < h * 0.04) continue;
      if (bw > w * 0.97 && bh > h * 0.97) continue;
      if (aspect < 0.6 || aspect > 5) continue;
      if (fill < 0.4) continue;
      const edge = x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2;
      boxes.push({ x0, y0, x1, y1, aspect, area: bw * bh, edge });
    }
    return boxes;
  }

  function cropRegion(canvas, r) {
    const mx = (r.x1 - r.x0) * 0.07, my = (r.y1 - r.y0) * 0.1; // room for tilted corners
    const x = Math.max(0, r.x0 - mx), y = Math.max(0, r.y0 - my);
    const w = Math.min(canvas.width - x, r.x1 - r.x0 + 2 * mx), h = Math.min(canvas.height - y, r.y1 - r.y0 + 2 * my);
    const target = 1000, sc = target / w;
    const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }

  function vote(rows) {
    // Group readings that sit on the same line of the crop (all variants share
    // the crop's pixel grid), so one physical plate yields one row.
    const groups = [];
    for (const r of rows) {
      let g = null;
      if (r.bbox) {
        for (const cand of groups) {
          const b = cand.bbox; if (!b) continue;
          const ov = Math.min(r.bbox.y1, b.y1) - Math.max(r.bbox.y0, b.y0);
          const hh = Math.min(r.bbox.y1 - r.bbox.y0, b.y1 - b.y0);
          if (ov > hh * 0.5) { g = cand; break; }
        }
      } else {
        g = groups.find((c) => !c.bbox && c.items[0].province === r.province) || null;
      }
      if (!g) { g = { bbox: r.bbox, items: [] }; groups.push(g); }
      g.items.push(r);
    }
    const out = [];
    for (const { items } of groups) {
      const withPlate = items.filter((r) => r.plate);
      if (!withPlate.length) { out.push(items[0]); continue; }
      const tally = new Map();
      for (const r of withPlate) tally.set(r.plate, (tally.get(r.plate) || 0) + 0.5 + r.confidence);
      const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
      const best = withPlate.filter((r) => r.plate === ranked[0]).sort((a, b) => b.confidence - a.confidence)[0];
      const prov = items.filter((r) => r.province).sort((a, b) => b.confidence - a.confidence)[0];
      if (prov && !best.province) best.province = prov.province;
      best.alternatives = ranked.slice(1, 4).filter((p) => p && p !== best.plate);
      const agree = withPlate.filter((r) => r.plate === best.plate).length / withPlate.length;
      best.confidence = Math.round(Math.min(1, best.confidence * (0.7 + 0.3 * agree)) * 100) / 100;
      out.push(best);
    }
    // junk control: a crop is one plate; weak extra readings next to a strong one are noise
    const strong = out.filter((r) => r.plate && r.confidence >= 0.6);
    const filtered = strong.length ? out.filter((r) => !r.plate || r.confidence >= 0.45) : out.filter((r) => !r.plate || r.confidence >= 0.3);
    return filtered.sort((a, b) => b.confidence - a.confidence).slice(0, strong.length ? 2 : 3);
  }

  function linesOf(data) {
    const lines = [];
    (data.blocks || []).forEach((b) => (b.paragraphs || []).forEach((pg) => (pg.lines || []).forEach((l) => lines.push(l))));
    return lines;
  }

  // Two passes with different segmentation settle most plates: PSM 6 (uniform
  // block) reads squarish motorcycle plates, PSM 4 at 300 dpi keeps the small
  // province line under a wide car plate.
  async function ocrPass(worker, img, psms) {
    const lines = [];
    for (const psm of psms) {
      await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '300' });
      const { data } = await worker.recognize(img, {}, { blocks: true, text: true });
      lines.push(...linesOf(data));
    }
    return lines;
  }

  // Staged reading: the plain crop first; enhanced variants only when the
  // plain read is weak. Enhancement helps stained plates but adds noise on
  // clean ones, so it is a fallback, not a default.
  async function ocrCanvas(worker, canvas, provinces, variants = true) {
    let lines = await ocrPass(worker, canvas, ['6', '4']);
    const good = (ls) => vote(parseLines(ls, provinces)).some((r) => r.plate && r.confidence >= 0.8 && r.province);
    if (variants && !good(lines)) {
      const normd = localNormalize(canvas);
      lines = lines.concat(await ocrPass(worker, normd, ['6']));
      if (!good(lines)) lines = lines.concat(await ocrPass(worker, binarize(normd), ['6']));
    }
    return lines;
  }

  // Several passes read the same plate slightly differently. Group by digits,
  // pick the reading that most passes agree on (weighted by confidence) and
  // keep the runners-up as one-tap alternatives for the user.
  // The province is printed small under a big number; Tesseract often drops it
  // when both are in one crop. Re-read just the strip below the number line.
  async function readProvinceBelow(worker, crop, bbox, provinces) {
    const y = Math.min(crop.height - 1, bbox.y1 - (bbox.y1 - bbox.y0) * 0.05);
    const h = crop.height - y;
    if (h < 20) return null;
    const target = 260, sc = target / h;
    let best = null;
    // photos are rarely level: retry the strip at small rotations
    for (const deg of [0, -5, 5, -10, 10]) {
      const c = document.createElement('canvas'); c.width = Math.round(crop.width * sc); c.height = Math.round(h * sc);
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.translate(c.width / 2, c.height / 2); ctx.rotate((deg * Math.PI) / 180); ctx.translate(-c.width / 2, -c.height / 2);
      ctx.drawImage(crop, 0, y, crop.width, h, 0, 0, c.width, c.height);
      for (const img of [c, localNormalize(c, 40)]) {
        for (const psm of ['7', '6']) {
          await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '300' });
          const { data } = await worker.recognize(img, {}, { blocks: true, text: true });
          for (const l of linesOf(data)) {
            const prov = bestProvince(norm(l.text).replace(/\s+/g, ''), provinces);
            if (prov && (!best || prov.score > best.score)) best = prov;
          }
          if (best && best.score >= 0.85) return best;
        }
      }
    }
    return best;
  }

  async function readPlates(file, provinces, onProgress) {
    const worker = await getWorker(onProgress);
    const { gray, color } = await toCanvas(file);
    const regions = findPlateRegions(color);
    window.LocalOCR._lastRegions = regions;
    window.LocalOCR._lastLines = [];
    const out = [];
    const report = (i, n) => onProgress && onProgress({ status: 'recognizing text', progress: n ? i / n : 0 });

    for (let i = 0; i < regions.length; i++) {
      report(i, regions.length + 1);
      const crop = cropRegion(gray, regions[i]);
      const lines = await ocrCanvas(worker, crop, provinces);
      window.LocalOCR._lastLines.push(lines.map((l) => [l.text.trim(), Math.round(l.confidence), l.bbox]));
      const found = vote(parseLines(lines, provinces));
      const platesHere = found.filter((f) => f.plate);
      for (const f of found) {
        if (f.plate) {
          // one plate in the crop: its shape tells car vs motorcycle; several plates
          // (touching each other) share one blob, so fall back to the letter pattern
          f.vehicleType = platesHere.length === 1 ? (regions[i].aspect < 1.6 ? 'motorcycle' : 'car') : f.vehicleType;
          f.partial = regions[i].edge;
        }
        if (f.plate && !f.province && f.bbox) {
          const prov = await readProvinceBelow(worker, crop, f.bbox, provinces);
          if (prov) { f.province = prov.province; f.note = ''; f.confidence = Math.round(Math.min(f.confidence / 0.7, 0.4 + 0.6 * prov.score) * 100) / 100; }
        }
        delete f.bbox;
        out.push(f);
      }
    }
    if (!out.some((r) => r.plate)) {
      // no plate-shaped region read: try the whole photo
      report(regions.length, regions.length + 1);
      const lines = await ocrCanvas(worker, gray, provinces, false);
      out.push(...vote(parseLines(lines, provinces)).map((f) => { delete f.bbox; return f; }));
    }
    const full = out.filter((r) => r.plate && r.plate.replace(/\D/g, '').length >= 2);
    let rows = out.filter((r) => {
      if (!r.plate) return full.length === 0; // province-only rows only when nothing better
      const digits = r.plate.replace(/\D/g, '').length;
      if (digits <= 1 && r.confidence < 0.6) return false; // "ร 4" from a cut-off plate
      if (r.partial && r.confidence < 0.5) return false;
      return true;
    });
    const seen = new Set();
    rows = rows.filter((r) => { const k = r.plate + '|' + r.province; if (seen.has(k)) return false; seen.add(k); return true; });
    rows.forEach((r) => { if (r.partial) r.note = r.note || 'ป้ายอยู่ที่ขอบรูป อาจอ่านได้ไม่ครบ'; delete r.partial; });
    return { plates: rows.slice(0, 20), model: 'tesseract-tha' };
  }

  window.LocalOCR = { readPlates, parseLines, norm };
})();
