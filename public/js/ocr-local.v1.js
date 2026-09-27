/* VERSION 1 of the on-device reader (first release, kept for comparison). Loaded when ?ocr=v1 or OCR_LOCAL_VERSION=v1. */
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
    const maxEdge = 2000;
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    // grayscale + contrast stretch helps the LSTM on dirty/flood-stained plates
    const d = ctx.getImageData(0, 0, w, h); const p = d.data;
    let min = 255, max = 0;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const g = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000;
      gray[j] = g; if (g < min) min = g; if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const v = ((gray[j] - min) / range) * 255;
      p[i] = p[i + 1] = p[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }

  // ---------- text parsing ----------
  const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
  const norm = (t) => (t || '')
    .normalize('NFC')
    .replace(/[๐-๙]/g, (ch) => String(THAI_DIGITS.indexOf(ch)))
    .replace(/[|่้๊๋์ํ็ั]/g, '') // plates never carry tone marks; OCR often hallucinates them
    .replace(/\s+/g, ' ')
    .trim();

  // 1กข 1234 | กข 1234 | กขค 123 (motorcycle). Tesseract often emits a space
  // between every Thai glyph, so match on the de-spaced text.
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
      // a line can be both when the plate is squarish and OCR merged rows; prefer plate
      if (m) {
        const digits = m[3];
        const letters = m[2];
        plates.push({
          plate: `${m[1] || ''}${letters} ${digits}`.trim(),
          letters,
          bbox: ln.bbox, conf: ln.confidence,
          province: prov && !compact.startsWith(m[0]) ? prov.province : '',
          provScore: prov ? prov.score : 0,
        });
      } else if (prov) {
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
        vehicleType: p.letters.length === 3 ? 'motorcycle' : 'car',
        confidence: Math.round(combined * 100) / 100,
        note: p.province ? '' : 'อ่านชื่อจังหวัดไม่ได้ กรุณาเลือกเอง',
        plausible: true,
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
  function findPlateRegions(canvas) {
    const W = 480;
    const sc = Math.min(1, W / canvas.width);
    const w = Math.max(1, Math.round(canvas.width * sc)), h = Math.max(1, Math.round(canvas.height * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const p = ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    let sum = 0;
    for (let i = 0, j = 0; i < p.length; i += 4, j++) { g[j] = p[i]; sum += p[i]; } // already grayscale
    const mean = sum / (w * h);
    const thr = Math.max(150, Math.min(210, mean + 45));
    const mask = new Uint8Array(w * h);
    for (let j = 0; j < g.length; j++) mask[j] = g[j] >= thr ? 1 : 0;
    // close small holes (text strokes) with a 1-px dilation so a plate is one blob
    const dil = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) { dil[i] = 1; continue; }
      let on = 0;
      for (let dy = -2; dy <= 2 && !on; dy++) for (let dx = -2; dx <= 2; dx++) {
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
      if (fill < 0.45) continue;
      boxes.push({ x0: x0 / sc, y0: y0 / sc, x1: (x1 + 1) / sc, y1: (y1 + 1) / sc, aspect, area: bw * bh });
    }
    // drop boxes contained in bigger ones, keep the largest 10, top-left first
    boxes.sort((a, b) => b.area - a.area);
    const keep = [];
    for (const b of boxes) {
      const inside = keep.some((k) => b.x0 >= k.x0 - 2 && b.y0 >= k.y0 - 2 && b.x1 <= k.x1 + 2 && b.y1 <= k.y1 + 2);
      if (!inside) keep.push(b);
      if (keep.length >= 10) break;
    }
    keep.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    return keep;
  }

  function cropRegion(canvas, r) {
    const mx = (r.x1 - r.x0) * 0.04, my = (r.y1 - r.y0) * 0.06;
    const x = Math.max(0, r.x0 - mx), y = Math.max(0, r.y0 - my);
    const w = Math.min(canvas.width - x, r.x1 - r.x0 + 2 * mx), h = Math.min(canvas.height - y, r.y1 - r.y0 + 2 * my);
    const target = 1000, sc = target / w;
    const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }

  // Two passes over one plate can disagree on the letters ("บ 999" vs "ฮบ 999").
  // Same digits in the same crop = same plate; keep the most complete reading.
  function dedupeByDigits(rows) {
    const byDigits = new Map();
    for (const r of rows) {
      const d = (r.plate.match(/\d+$/) || [''])[0];
      const key = r.plate ? d : 'prov:' + r.province;
      const cur = byDigits.get(key);
      if (!cur || r.plate.length > cur.plate.length || (r.plate.length === cur.plate.length && r.confidence > cur.confidence)) {
        if (cur && !r.province && cur.province) r.province = cur.province;
        byDigits.set(key, r);
      } else if (cur && !cur.province && r.province) cur.province = r.province;
    }
    return [...byDigits.values()];
  }

  function linesOf(data) {
    const lines = [];
    (data.blocks || []).forEach((b) => (b.paragraphs || []).forEach((pg) => (pg.lines || []).forEach((l) => lines.push(l))));
    return lines;
  }

  // Two passes with different segmentation settle most plates: PSM 6 (uniform
  // block) reads squarish motorcycle plates, PSM 4 at 300 dpi keeps the small
  // province line under a wide car plate.
  async function ocrCanvas(worker, canvas) {
    const lines = [];
    for (const [psm, dpi] of [['6', '300'], ['4', '300']]) {
      await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: dpi });
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
      lines.push(...linesOf(data));
    }
    return lines;
  }

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
      for (const psm of ['7', '6']) {
        await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '300' });
        const { data } = await worker.recognize(c, {}, { blocks: true, text: true });
        for (const l of linesOf(data)) {
          const prov = bestProvince(norm(l.text).replace(/\s+/g, ''), provinces);
          if (prov && (!best || prov.score > best.score)) best = prov;
        }
        if (best && best.score >= 0.85) return best;
      }
    }
    return best;
  }

  async function readPlates(file, provinces, onProgress) {
    const worker = await getWorker(onProgress);
    const canvas = await toCanvas(file);
    const regions = findPlateRegions(canvas);
    window.LocalOCR._lastRegions = regions;
    window.LocalOCR._lastLines = [];
    const out = [];
    const report = (i, n) => onProgress && onProgress({ status: 'recognizing text', progress: n ? i / n : 0 });

    for (let i = 0; i < regions.length; i++) {
      report(i, regions.length + 1);
      const crop = cropRegion(canvas, regions[i]);
      const lines = await ocrCanvas(worker, crop);
      window.LocalOCR._lastLines.push(lines.map((l) => [l.text.trim(), Math.round(l.confidence), l.bbox]));
      const found = dedupeByDigits(parseLines(lines, provinces));
      for (const f of found) {
        if (f.plate) f.vehicleType = regions[i].aspect < 1.6 ? 'motorcycle' : 'car';
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
      const lines = await ocrCanvas(worker, canvas);
      out.push(...parseLines(lines, provinces).map((f) => { delete f.bbox; return f; }));
    }
    const seen = new Set();
    const plates = out.filter((r) => { const k = r.plate + '|' + r.province; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
    return { plates, model: 'tesseract-tha' };
  }

  window.LocalOCR = { readPlates, parseLines, norm };
})();
