/* Free, on-device plate reading with Tesseract.js (Thai model).
   Nothing leaves the browser. Exposes window.LocalOCR.readPlates(file, onProgress)
   returning the same shape as the server /api/ocr endpoint. */
(function () {
  'use strict';

  const BASE = '/vendor/tesseract';
  let workerPromise = null;
  let scriptLoaded = false;

  // Tunables (exposed for experiments via LocalOCR.configure({...})).
  const OPTS = {
    lang: 'tha',            // 'tha' (fast) or 'tha_best' (int8 "best" model)
    whitelist: '',          // e.g. Thai consonants + digits; '' = off
    cropWidth: 1000,        // upscaled crop width in px
    cropMarginX: 0.07, cropMarginY: 0.10,
    psms: ['6', '4'],       // page segmentation modes for the plain pass
    variants: true,         // try normalised / binarised variants when the plain read is weak
    goodConf: 0.8,          // stop trying variants once a plate reaches this confidence with a province
    detectWidth: 480, closeRadius: 1, satChroma: 40, satLum: 100,
    provStripHeight: 260, provRotations: [0, -5, 5, -10, 10],
    workerParams: {},       // extra Tesseract parameters
    // --- in-crop strategy: deskew, split into text lines, read each line with PSM 7 ---
    deskew: true, deskewRange: 12, deskewMin: 0.6, deskewWidth: 320,
    deshear: true, shearRange: 0.3, shearMin: 0.05,
    bands: true, bandWidth: 400, bandSolid: 0.5, bandMinDensity: 0.025, bandRelDensity: 0.15, bandGap: 0.035, bandMinHeight: 0.06,
    numberBandRatio: 0.75,  // bands at least this tall relative to the tallest are number lines
    stripPadY: 0.45, stripPadX: 0.6, provPadY: 0.7, borderMaxWidth: 0.06, borderInset: 0.012,
    lineHeight: 120,        // number-line glyph height in px for the strip
    provHeight: 80,         // province-line glyph height
    lineDpi: '300',
    // number line: [image variant, page-seg mode, whitelist on]; every read is one vote
    lineReads: [['plain', '13', true], ['plain', '7', true], ['plain', '13', false], ['plain', '7', false], ['bin', '13', true]],
    numberWhitelist: 'กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ0123456789',
    provReads: [['plain', '7'], ['plain', '13']],
    wholeCropFallback: true, // run the old PSM 6/4 whole-crop passes when the lines give no plate
    fallbackPenalty: 0.8,   // confidence factor for plates found only by those passes
    grayDetectFallback: true, // no bright regions: detect again on the contrast-stretched grey image
    splitSideBySide: true, splitValley: 0.4, // crop read nothing: try it as two plates side by side
    threeLetterPrior: 0.5,  // vote weight of a >=3-letter reading on a wide (car) plate
    trailingDigitPrior: 0.5, // vote weight of a reading that had a fifth digit dropped
    wideAspect: 1.6,        // region aspect from which a plate counts as a car plate
  };
  function configure(o) { Object.assign(OPTS, o || {}); if (o && (o.lang || o.workerParams || o.whitelist !== undefined)) workerPromise = null; return { ...OPTS }; }

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
      const worker = await Tesseract.createWorker(OPTS.lang, 1, {
        workerPath: `${BASE}/worker.min.js`,
        corePath: BASE,
        langPath: `${BASE}/lang`,
        gzip: true,
        legacyCore: false,
        legacyLang: false,
        cacheMethod: 'none',
        logger: (m) => { if (onProgress) onProgress(m); },
      });
      const params = { preserve_interword_spaces: '1', user_defined_dpi: '300', ...OPTS.workerParams };
      if (OPTS.whitelist) params.tessedit_char_whitelist = OPTS.whitelist;
      await worker.setParameters(params);
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

  function otsuThreshold(hist, total) {
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
    return thr;
  }

  // Otsu global threshold -> clean black-on-white, which the LSTM likes.
  function binarize(src) {
    const w = src.width, h = src.height;
    const ctx = src.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h); const p = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < p.length; i += 4) hist[p[i]]++;
    const thr = otsuThreshold(hist, w * h);
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const octx = out.getContext('2d'); const od = octx.createImageData(w, h); const q = od.data;
    for (let i = 0; i < p.length; i += 4) { const c = p[i] > thr ? 255 : 0; q[i] = q[i + 1] = q[i + 2] = c; q[i + 3] = 255; }
    octx.putImageData(od, 0, 0);
    return out;
  }

  // ---------- crop geometry: ink mask, deskew, deshear, text bands ----------
  // Grey values of a canvas scaled down to at most W px wide (crops are grey already).
  function grayScaled(canvas, W) {
    const sc = Math.min(1, W / canvas.width);
    const w = Math.max(1, Math.round(canvas.width * sc)), h = Math.max(1, Math.round(canvas.height * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    const p = ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) g[j] = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000;
    return { g, w, h, sc };
  }

  // Ink = darker than the local neighbourhood. The window is wide but short
  // (a few rows): glyph strokes are darker than the rest of their row, while
  // a vertical colour gradient (auction plates), a shadow or the grey ground
  // around the plate barely changes within a few rows and so is not "ink". A
  // floor of `k` grey levels keeps flat, noisy areas clean.
  function inkMask(g, w, h, winX, winY, k = 14) {
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
    const rx = Math.max(2, winX >> 1), ry = Math.max(1, winY >> 1);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - ry), y1 = Math.min(h, y + ry + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - rx), x1 = Math.min(w, x + rx + 1);
        const n = (y1 - y0) * (x1 - x0);
        const sum = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
        const sum2 = I2[y1 * W + x1] - I2[y0 * W + x1] - I2[y1 * W + x0] + I2[y0 * W + x0];
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        mask[y * w + x] = g[y * w + x] < mean - Math.max(k, 0.8 * sd) ? 1 : 0;
      }
    }
    return mask;
  }

  // Rotation of the text lines: sweep angles, rotate the ink pixels, and keep
  // the angle whose horizontal projection is sharpest (sum of squared row
  // counts). Plate borders and both text lines all peak at the true angle.
  // Returns the canvas rotation (degrees, clockwise positive) that levels them.
  function estimateSkew(canvas) {
    const { g, w, h } = grayScaled(canvas, OPTS.deskewWidth);
    const mask = inkMask(g, w, h, Math.round(w / 4), Math.max(3, Math.round(h / 40)));
    const xs = [], ys = [];
    const cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { xs.push(x - cx); ys.push(y - cy); }
    if (xs.length < 40) return 0;
    const diag = Math.ceil(Math.hypot(w, h));
    const hist = new Float64Array(2 * diag + 2);
    const score = (deg) => {
      const s = Math.sin((deg * Math.PI) / 180), c = Math.cos((deg * Math.PI) / 180);
      hist.fill(0);
      for (let i = 0; i < xs.length; i++) hist[Math.round(xs[i] * s + ys[i] * c) + diag]++; // same convention as ctx.rotate
      let sum = 0;
      for (let i = 0; i < hist.length; i++) sum += hist[i] * hist[i];
      return sum;
    };
    let best = 0, bestScore = -1;
    for (let deg = -OPTS.deskewRange; deg <= OPTS.deskewRange; deg += 1) {
      const sc = score(deg); if (sc > bestScore) { bestScore = sc; best = deg; }
    }
    for (let deg = best - 0.75; deg <= best + 0.75; deg += 0.25) {
      const sc = score(deg); if (sc > bestScore) { bestScore = sc; best = deg; }
    }
    return best;
  }

  // Slant of the vertical strokes left after levelling (a plate photographed
  // from the side is sheared, not just rotated): sweep horizontal shear
  // factors and keep the one with the sharpest column projection.
  function estimateShear(canvas) {
    const { g, w, h } = grayScaled(canvas, OPTS.deskewWidth);
    const mask = inkMask(g, w, h, Math.round(w / 4), Math.max(3, Math.round(h / 40)));
    const xs = [], ys = [];
    const cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { xs.push(x - cx); ys.push(y - cy); }
    if (xs.length < 40) return 0;
    const span = Math.ceil(w + h);
    const hist = new Float64Array(2 * span + 2);
    const score = (k) => {
      hist.fill(0);
      for (let i = 0; i < xs.length; i++) hist[Math.round(xs[i] + k * ys[i]) + span]++;
      let sum = 0;
      for (let i = 0; i < hist.length; i++) sum += hist[i] * hist[i];
      return sum;
    };
    let best = 0, bestScore = -1;
    for (let k = -OPTS.shearRange; k <= OPTS.shearRange + 1e-9; k += 0.02) {
      const sc = score(k); if (sc > bestScore) { bestScore = sc; best = k; }
    }
    return Math.round(best * 100) / 100;
  }

  function shearCanvas(canvas, k, fill = '#fff') {
    const w = canvas.width, h = canvas.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h);
    // x' = x + k*(y - h/2): straightens strokes that lean by k
    ctx.transform(1, 0, k, 1, -k * h / 2, 0);
    ctx.drawImage(canvas, 0, 0);
    return c;
  }

  function rotateCanvas(canvas, deg, fill = '#fff') {
    const w = canvas.width, h = canvas.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2); ctx.rotate((deg * Math.PI) / 180); ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(canvas, 0, 0);
    return c;
  }

  // Horizontal runs of ink rows inside the crop: the number line, the province
  // line (and on motorcycle plates a third line). Returned in crop pixels,
  // top to bottom. Solid rows (border stroke, background beyond the plate's
  // edge) are ignored, small gaps (vowel marks) are bridged.
  function textBands(canvas) {
    const { g, w, h, sc } = grayScaled(canvas, OPTS.bandWidth);
    const mask = inkMask(g, w, h, Math.round(w / 4), Math.max(3, Math.round(h / 40)));
    const x0 = Math.round(w * 0.1), x1 = Math.round(w * 0.9), n = x1 - x0;
    const prof = new Float32Array(h);
    for (let y = 0; y < h; y++) { let s = 0; for (let x = x0; x < x1; x++) s += mask[y * w + x]; prof[y] = s / n; }
    const sm = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let s = 0, c = 0;
      for (let d = -1; d <= 1; d++) { const yy = y + d; if (yy >= 0 && yy < h) { s += prof[yy] > OPTS.bandSolid ? 0 : prof[yy]; c++; } }
      sm[y] = s / c;
    }
    let peak = 0; for (let y = 0; y < h; y++) if (sm[y] > peak) peak = sm[y];
    if (peak <= 0) return [];
    const thr = Math.max(OPTS.bandMinDensity, OPTS.bandRelDensity * peak);
    const runs = [];
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && sm[y] > thr;
      if (on && start < 0) start = y;
      if (!on && start >= 0) { runs.push({ y0: start, y1: y }); start = -1; }
    }
    // bridge small gaps (vowels above / below consonants), drop slivers
    const gap = Math.max(2, h * OPTS.bandGap);
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r.y0 - last.y1 <= gap) last.y1 = r.y1; else merged.push({ ...r });
    }
    // vertical plate border / frame: thin runs of solid columns near the sides
    const colSolid = new Uint8Array(w);
    for (let x = 0; x < w; x++) { let s = 0; for (let y = 0; y < h; y++) s += mask[y * w + x]; colSolid[x] = s / h > 0.6 ? 1 : 0; }
    let left = 0, right = w;
    for (let x = 0; x < w; ) {
      if (!colSolid[x]) { x++; continue; }
      let e = x; while (e < w && colSolid[e]) e++;
      if (e - x <= Math.max(2, w * OPTS.borderMaxWidth)) { if (x < w * 0.25) left = e; else if (e > w * 0.75 && right === w) right = x; }
      x = e;
    }
    // the border's anti-aliased fringe reads as a digit: look for text inside it
    const inset = Math.max(2, Math.round(w * OPTS.borderInset));
    const leftIn = left > 0 ? Math.min(w, left + inset) : 0, rightIn = right < w ? Math.max(leftIn, right - inset) : w;
    const out = merged.filter((r) => r.y1 - r.y0 >= h * OPTS.bandMinHeight).map((r) => {
      let dens = 0; for (let y = r.y0; y < r.y1; y++) dens += prof[y];
      dens /= r.y1 - r.y0;
      // horizontal ink extent of this band inside the borders
      let cx0 = w, cx1 = 0;
      for (let x = leftIn; x < rightIn; x++) {
        let s = 0; for (let y = r.y0; y < r.y1; y++) s += mask[y * w + x];
        if (s / (r.y1 - r.y0) > 0.02) { if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; }
      }
      if (cx1 <= cx0) { cx0 = leftIn; cx1 = rightIn - 1; }
      // nearest solid rows above and below: the plate's top/bottom border
      let top = 0, bottom = h;
      for (let y = r.y0 - 1; y >= 0; y--) if (prof[y] > OPTS.bandSolid) { top = y + 1; break; }
      for (let y = r.y1; y < h; y++) if (prof[y] > OPTS.bandSolid) { bottom = y; break; }
      // text that runs right up to the fringe: leave that side untouched (a
      // half-erased border confuses the recogniser more than a whole one)
      const bl = cx0 <= leftIn ? 0 : leftIn, br = cx1 >= rightIn - 1 ? w : rightIn;
      return { y0: r.y0 / sc, y1: r.y1 / sc, x0: cx0 / sc, x1: (cx1 + 1) / sc, density: dens, left: bl / sc, right: br / sc, top: top / sc, bottom: bottom / sc };
    });
    return out;
  }

  // A single text line cut out of the crop, padded and scaled to a glyph
  // height Tesseract's line recogniser is comfortable with.
  function bandStrip(canvas, band, targetH, padYRatio = OPTS.stripPadY) {
    const bh = band.y1 - band.y0;
    const padY = bh * padYRatio, padX = bh * OPTS.stripPadX;
    const sy0 = band.y0 - padY, sy1 = band.y1 + padY;
    const sx0 = band.x0 - padX, sx1 = band.x1 + padX;
    const sc = targetH / bh;
    const c = document.createElement('canvas');
    c.width = Math.max(8, Math.round((sx1 - sx0) * sc)); c.height = Math.max(8, Math.round((sy1 - sy0) * sc));
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    // Everything outside the plate's borders (the border stroke itself, the
    // frame, the ground) is painted in the plate's own background tone: a
    // border stroke reads as "1" or "|", and a white margin next to a grey
    // plate becomes an edge that the binarised variant turns into a stroke.
    const bg = backgroundTone(canvas, sx0, sy0, sx1 - sx0, sy1 - sy0);
    ctx.fillStyle = `rgb(${bg},${bg},${bg})`; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, 0, 0, c.width, c.height);
    const toX = (x) => (x - sx0) * sc, toY = (y) => (y - sy0) * sc;
    if (band.left > 0) ctx.fillRect(0, 0, toX(band.left), c.height);
    if (band.right < canvas.width) ctx.fillRect(toX(band.right), 0, c.width, c.height);
    if (band.top > 0) ctx.fillRect(0, 0, c.width, toY(band.top));
    if (band.bottom < canvas.height) ctx.fillRect(0, toY(band.bottom), c.width, c.height);
    return c;
  }

  // Typical background grey of a rectangle: the brighter half's median on a
  // coarse sample (glyph ink is the minority, background the majority).
  function backgroundTone(canvas, x, y, w, h) {
    const n = 24;
    const s = document.createElement('canvas'); s.width = n; s.height = 6;
    const ctx = s.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, Math.max(0, x), Math.max(0, y), Math.max(1, w), Math.max(1, h), 0, 0, n, 6);
    const p = ctx.getImageData(0, 0, n, 6).data;
    const v = []; for (let i = 0; i < p.length; i += 4) v.push(p[i]);
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length * 0.75)];
  }

  // ---------- text parsing ----------
  const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
  const norm = (t) => (t || '')
    .normalize('NFC')
    .replace(/[๐-๙]/g, (ch) => String(THAI_DIGITS.indexOf(ch)))
    // a bold "1" in front of the letters is read as a bar or the vowel ไ/ใ; plate
    // letters are consonants only, so a lone one of these before them is the digit
    .replace(/(^|\s)[|ไใ](?=[ก-ฮ])/g, '$11')
    .replace(/[|่้๊๋์ํ็ั]/g, '') // plates never carry tone marks; OCR often hallucinates them
    .replace(/\s+/g, ' ')
    .trim();

  // 1กข 1234 | กข 1234 | กขค 123. Digits never exceed four: a fifth one is a
  // border stroke or noise glued to the end of the number, so it is matched
  // and dropped. Tesseract often emits a space between every Thai glyph, so
  // the pattern is applied to the de-spaced text.
  const PLATE_AT = /^(\d)?([ก-ฮ]{1,4})[-.:_]?(\d{1,4})(\d*)/;
  // The plate pattern can match at several places in a noisy read ("ข6มย88"
  // gives "ข 6" before "6มย 88"). Prefer the most plate-like match: more
  // letters (up to the usual two or three), more digits, a series digit,
  // nothing trailing.
  function bestPlateMatch(compact) {
    let best = null, bestScore = -1;
    for (let i = 0; i < compact.length; i++) {
      const m = compact.slice(i).match(PLATE_AT);
      if (!m) continue;
      const score = Math.min(3, m[2].length) + m[3].length + (m[1] ? 1 : 0) - (m[4] ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = m; best.index = i; }
    }
    return best;
  }

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

  function parseLines(lines, provinces, dedupe = true) {
    const plates = [];
    const provLines = [];
    for (const ln of lines) {
      const text = norm(ln.text);
      if (!text) continue;
      const compact = text.replace(/\s+/g, '');
      // lines read from a located strip already know what they are
      const m = ln.role === 'prov' ? null : bestPlateMatch(compact);
      const prov = ln.role === 'number' ? null : bestProvince(compact, provinces);
      // "กรุงเทพมหานคร 230" is a province line with noise, not plate "นคร 230"
      const provLine = prov && prov.score >= 0.75 && (!m || prov.province.includes(m[2]) && m.index >= compact.indexOf(prov.province.slice(0, 3)));
      if (m && !provLine) {
        const digits = m[3];
        const letters = m[2];
        plates.push({
          plate: `${m[1] || ''}${letters} ${digits}`.trim(),
          letters, trailing: !!m[4],
          bbox: ln.bbox, conf: ln.confidence,
          province: prov && m.index !== 0 ? prov.province : '',
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
        bbox: p.bbox, rawConf: conf, trailing: p.trailing,
        plate: p.plate,
        province: p.province,
        vehicleType: 'car',
        confidence: Math.round(combined * 100) / 100,
        note: p.province ? '' : 'อ่านชื่อจังหวัดไม่ได้ กรุณาเลือกเอง',
        plausible: true,
      };
    });
    // provinces we saw but could not pair with a number: still useful as a row to complete
    for (const pl of provLines) {
      if (!pl.used) out.push({ plate: '', province: pl.province, vehicleType: 'car', confidence: Math.round(pl.score * 60) / 100, note: 'อ่านเลขทะเบียนไม่ได้ กรุณากรอกเอง', plausible: false });
    }
    // de-duplicate identical plates (not when the rows go on to vote(): there
    // every agreeing read is evidence)
    if (!dedupe) return out;
    const seen = new Set();
    return out.filter((r) => { const k = r.plate + '|' + r.province; if (r.plate && seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
  }

  // ---------- plate region detection ----------
  // Plates are bright rectangles with dark glyphs. Find bright connected
  // components on a small grayscale copy and keep the plate-shaped ones.
  function findPlateRegions(color) {
    const W = OPTS.detectWidth;
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
      sat[j] = Math.max(r, gg, b) - Math.min(r, gg, b) > OPTS.satChroma && l > OPTS.satLum ? 1 : 0; // muddy brown ground stays below this
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
      const R = OPTS.closeRadius;
      for (let dy = -R; dy <= R && !on; dy++) for (let dx = -R; dx <= R; dx++) {
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
    const mx = (r.x1 - r.x0) * OPTS.cropMarginX, my = (r.y1 - r.y0) * OPTS.cropMarginY; // room for tilted corners
    const x = Math.max(0, r.x0 - mx), y = Math.max(0, r.y0 - my);
    const w = Math.min(canvas.width - x, r.x1 - r.x0 + 2 * mx), h = Math.min(canvas.height - y, r.y1 - r.y0 + 2 * my);
    const target = OPTS.cropWidth, sc = target / w;
    const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }

  function vote(rows, ctx = {}) {
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
      // count-dominant: every read is one vote, its raw line confidence only
      // breaks ties. Plate-format priors: a wide car plate never carries three
      // or more letters (that is a motorcycle series), so such readings are
      // most likely a stray glyph; a read that had a fifth digit dropped is
      // suspect too.
      for (const r of withPlate) {
        const letters = (r.plate.match(/[ก-ฮ]+/) || [''])[0].length;
        let prior = ctx.wide && letters >= 3 ? OPTS.threeLetterPrior : 1;
        if (r.trailing) prior *= OPTS.trailingDigitPrior;
        tally.set(r.plate, (tally.get(r.plate) || 0) + (1 + (r.rawConf ?? r.confidence)) * prior);
      }
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
    // the line analysis knows how many plates are stacked in the crop
    return filtered.sort((a, b) => b.confidence - a.confidence).slice(0, ctx.max || (strong.length ? 2 : 3));
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
      await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '300', tessedit_char_whitelist: OPTS.whitelist || '' });
      const { data } = await worker.recognize(img, {}, { blocks: true, text: true });
      lines.push(...linesOf(data));
    }
    return lines;
  }

  // Staged reading: the plain crop first; enhanced variants only when the
  // plain read is weak. Enhancement helps stained plates but adds noise on
  // clean ones, so it is a fallback, not a default.
  async function ocrCanvas(worker, canvas, provinces, variants = true) {
    let lines = await ocrPass(worker, canvas, OPTS.psms);
    const good = (ls) => vote(parseLines(ls, provinces)).some((r) => r.plate && r.confidence >= OPTS.goodConf && r.province);
    if (variants && OPTS.variants && !good(lines)) {
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
    const target = OPTS.provStripHeight, sc = target / h;
    let best = null;
    // photos are rarely level: retry the strip at small rotations
    for (const deg of OPTS.provRotations) {
      const c = document.createElement('canvas'); c.width = Math.round(crop.width * sc); c.height = Math.round(h * sc);
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.translate(c.width / 2, c.height / 2); ctx.rotate((deg * Math.PI) / 180); ctx.translate(-c.width / 2, -c.height / 2);
      ctx.drawImage(crop, 0, y, crop.width, h, 0, 0, c.width, c.height);
      for (const img of [c, localNormalize(c, 40)]) {
        for (const psm of ['7', '6']) {
          await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '300', tessedit_char_whitelist: OPTS.whitelist || '' });
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

  // One recognition of a strip image as a single text line; returns the
  // lines Tesseract produced with their bbox mapped back onto the crop.
  async function ocrStrip(worker, strip, band, psm, whitelist) {
    await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: OPTS.lineDpi, tessedit_char_whitelist: whitelist || '' });
    const { data } = await worker.recognize(strip, {}, { blocks: true, text: true });
    const ls = linesOf(data).filter((l) => l.text && l.text.trim());
    if (!ls.length) return [];
    // PSM 7 normally yields one line; if it split, join the pieces
    const text = ls.map((l) => l.text.trim()).join(' ');
    // a whitelist zeroes the confidence of any word where it forced a choice:
    // fall back to the mean symbol confidence, which stays informative
    const confOf = (l) => {
      if (l.confidence > 0) return l.confidence;
      const syms = []; (l.words || []).forEach((w) => (w.symbols || []).forEach((s) => syms.push(s.confidence || 0)));
      return syms.length ? syms.reduce((a, b) => a + b, 0) / syms.length : 0;
    };
    const confidence = ls.reduce((s, l) => s + confOf(l), 0) / ls.length;
    return [{ text, confidence, bbox: { x0: band.x0, y0: band.y0, x1: band.x1, y1: band.y1 } }];
  }

  function stripVariant(strip, kind) {
    if (kind === 'norm') return localNormalize(strip, Math.max(24, Math.round(strip.height / 3)));
    if (kind === 'bin') return binarize(localNormalize(strip, Math.max(24, Math.round(strip.height / 3))));
    if (kind === 'otsu') return binarize(strip);
    return strip;
  }

  // Line-by-line reading of a (deskewed) crop: locate the text bands, read the
  // tall ones as the registration number with a consonant+digit whitelist and
  // the short one under them as the province. Each variant contributes a line
  // so vote() can settle disagreements.
  async function ocrBands(worker, crop, provinces, depth = 0) {
    const bands = textBands(crop);
    if (!bands.length) return { lines: [], bands, units: 0 };
    const hMax = Math.max(...bands.map((b) => b.y1 - b.y0));
    const dMax = Math.max(...bands.map((b) => b.density));
    // Group the bands into plate units: one or two tall, dense number lines
    // followed by the short province line. A touching stack of plates gives
    // several units in one crop.
    const units = [];
    let cur = null;
    for (const b of bands) {
      const h = b.y1 - b.y0;
      const open = cur && !cur.prov;
      const isNumber = h >= OPTS.numberBandRatio * hMax || (h >= 0.4 * hMax && b.density >= 0.6 * dMax && !open);
      if (isNumber) {
        if (!open) { cur = { numbers: [], prov: null }; units.push(cur); }
        cur.numbers.push(b);
      } else if (open) {
        const last = cur.numbers[cur.numbers.length - 1];
        if (b.y0 >= last.y1 - hMax * 0.2 && b.y0 - last.y1 < hMax * 1.5) cur.prov = b;
      }
    }
    if (!units.length) return { lines: [], bands, units: 0 };
    const lines = [];
    if (units.length > 1 && depth === 0) {
      // stacked plates rarely share one tilt: level and read each unit on its own
      for (const u of units) {
        const nh = u.numbers[0].y1 - u.numbers[0].y0;
        const top = Math.max(0, u.numbers[0].y0 - nh * 0.5);
        // no province band seen (a tilted line smears out): leave room for one
        const bottom = Math.min(crop.height, u.prov ? u.prov.y1 + nh * 0.5 : u.numbers[u.numbers.length - 1].y1 + nh * 1.6);
        const sub = document.createElement('canvas'); sub.width = crop.width; sub.height = Math.round(bottom - top);
        sub.getContext('2d').drawImage(crop, 0, top, crop.width, bottom - top, 0, 0, sub.width, sub.height);
        let img = sub;
        if (OPTS.deskew) { const a = estimateSkew(sub); if (Math.abs(a) >= OPTS.deskewMin) img = rotateCanvas(sub, a); }
        const r = await ocrBands(worker, img, provinces, 1);
        for (const l of r.lines) { l.bbox = { ...l.bbox, y0: l.bbox.y0 + top, y1: l.bbox.y1 + top }; lines.push(l); }
      }
      return { lines, bands, units: units.length };
    }
    const unit = units[0];
    const numberBands = unit.numbers;
    for (const b of numberBands) {
      const strip = bandStrip(crop, b, OPTS.lineHeight);
      const imgs = {};
      for (const [v, psm, wl] of OPTS.lineReads) {
        imgs[v] = imgs[v] || stripVariant(strip, v);
        const ls = await ocrStrip(worker, imgs[v], b, psm, wl ? OPTS.numberWhitelist : '');
        ls.forEach((l) => { l.variant = `${v}/${psm}${wl ? 'w' : ''}`; l.role = 'number'; });
        lines.push(...ls);
      }
    }
    // stacked number lines (motorcycle plates: letters over digits) are one plate
    for (let i = 0; i + 1 < numberBands.length; i++) {
      const a = numberBands[i], b = numberBands[i + 1];
      if (b.y0 - a.y1 > (a.y1 - a.y0) * 0.8) continue;
      const la = lines.filter((l) => l.bbox.y0 === a.y0), lb = lines.filter((l) => l.bbox.y0 === b.y0);
      for (const x of la) for (const y of lb) if (x.variant === y.variant) {
        lines.push({ text: `${x.text} ${y.text}`, confidence: Math.min(x.confidence, y.confidence), joined: true, role: 'number',
          bbox: { x0: Math.min(a.x0, b.x0), y0: a.y0, x1: Math.max(a.x1, b.x1), y1: b.y1 } });
      }
    }
    // the province sits right under the last number line
    for (const b of unit.prov ? [unit.prov] : []) {
      // Thai vowel and tone marks sit above/below the consonants and are too
      // thin to register in the band: pad generously so they come along
      const strip = bandStrip(crop, b, OPTS.provHeight, OPTS.provPadY);
      const imgs = {};
      for (const [v, psm] of OPTS.provReads) {
        imgs[v] = imgs[v] || stripVariant(strip, v);
        const ls = await ocrStrip(worker, imgs[v], b, psm, '');
        ls.forEach((l) => { l.variant = `prov:${v}/${psm}`; l.role = 'prov'; });
        lines.push(...ls);
      }
    }
    return { lines, bands, units: 1 };
  }

  // One plate crop: level it, read it line by line, fall back to the
  // whole-crop passes when the lines give no plate.
  async function readCrop(worker, raw, provinces, wide, depth = 0) {
    let crop = raw, angle = 0, shear = 0;
    if (OPTS.deskew) {
      angle = estimateSkew(crop);
      if (Math.abs(angle) >= OPTS.deskewMin) crop = rotateCanvas(crop, angle);
    }
    if (OPTS.deshear) {
      shear = estimateShear(crop);
      if (Math.abs(shear) >= OPTS.shearMin) crop = shearCanvas(crop, shear);
    }
    let lines = [], found = [], bands = [], units = 0;
    if (OPTS.bands) {
      const r = await ocrBands(worker, crop, provinces);
      lines = r.lines; bands = r.bands; units = r.units;
      found = vote(parseLines(lines, provinces, false), { wide, max: units });
    }
    if (depth === 0 && OPTS.splitSideBySide && !found.some((f) => f.plate)) {
      // two plates side by side in one blob, each with its own tilt: the
      // column valley between them also exists between letters and digits of
      // a single plate, so this is only tried once the lines gave nothing
      const x = splitColumn(raw);
      if (x > 0) {
        const halves = [[0, x], [x, raw.width]].map(([a, b]) => {
          const c = document.createElement('canvas'); c.width = Math.round(b - a); c.height = raw.height;
          c.getContext('2d').drawImage(raw, a, 0, b - a, raw.height, 0, 0, c.width, c.height);
          return { canvas: c, x: a };
        });
        const merged = [];
        for (const h of halves) {
          const r = await readCrop(worker, h.canvas, provinces, h.canvas.width / h.canvas.height >= OPTS.wideAspect, 1);
          lines = lines.concat(r.lines);
          for (const f of r.found) { if (f.plate) { f._crop = r.crop; merged.push(f); } }
        }
        if (merged.length) return { crop, angle, lines, bands, found: merged, split: x };
      }
    }
    if (OPTS.wholeCropFallback && !found.some((f) => f.plate)) {
      lines = lines.concat(await ocrCanvas(worker, crop, provinces));
      found = vote(parseLines(lines, provinces, false), { wide, max: units });
      // no located text line backs these reads: they are worth less
      for (const f of found) if (f.plate) f.confidence = Math.round(f.confidence * OPTS.fallbackPenalty * 100) / 100;
    }
    return { crop, angle, shear, lines, bands, found };
  }

  // Two plates side by side: the ink across the columns has a clear valley
  // between them. Returns the column to split at, or -1.
  function splitColumn(canvas) {
    const { g, w, h, sc } = grayScaled(canvas, OPTS.bandWidth);
    const mask = inkMask(g, w, h, Math.round(w / 4), Math.max(3, Math.round(h / 40)));
    const col = new Float32Array(w);
    for (let x = 0; x < w; x++) { let s = 0; for (let y = 0; y < h; y++) s += mask[y * w + x]; col[x] = s / h; }
    const sm = new Float32Array(w);
    for (let x = 0; x < w; x++) { let s = 0, c = 0; for (let d = -4; d <= 4; d++) { const xx = x + d; if (xx >= 0 && xx < w) { s += col[xx]; c++; } } sm[x] = s / c; }
    let best = -1, bestV = Infinity;
    for (let x = Math.round(w * 0.3); x <= Math.round(w * 0.7); x++) if (sm[x] < bestV) { bestV = sm[x]; best = x; }
    let maxL = 0, maxR = 0;
    for (let x = Math.round(w * 0.05); x < best; x++) if (sm[x] > maxL) maxL = sm[x];
    for (let x = best + 1; x < w * 0.95; x++) if (sm[x] > maxR) maxR = sm[x];
    return bestV < OPTS.splitValley * Math.min(maxL, maxR) ? best / sc : -1;
  }

  async function readPlates(file, provinces, onProgress) {
    const worker = await getWorker(onProgress);
    const { gray, color } = await toCanvas(file);
    let regions = findPlateRegions(color);
    // dim photos: nothing reaches the brightness thresholds, but after the
    // global contrast stretch the plates are the brightest things again
    if (!regions.length && OPTS.grayDetectFallback) regions = findPlateRegions(gray);
    window.LocalOCR._lastRegions = regions;
    window.LocalOCR._lastLines = [];
    window.LocalOCR._lastGeom = [];
    const out = [];
    const report = (i, n) => onProgress && onProgress({ status: 'recognizing text', progress: n ? i / n : 0 });

    for (let i = 0; i < regions.length; i++) {
      report(i, regions.length + 1);
      const r = await readCrop(worker, cropRegion(gray, regions[i]), provinces, regions[i].aspect >= OPTS.wideAspect);
      const { crop, found } = r;
      window.LocalOCR._lastGeom.push({ angle: r.angle, shear: r.shear, bands: r.bands });
      window.LocalOCR._lastLines.push(r.lines.map((l) => [l.text.trim(), Math.round(l.confidence), l.bbox]));
      const platesHere = found.filter((f) => f.plate);
      for (const f of found) {
        if (f.plate) {
          // one plate in the crop: its shape tells car vs motorcycle; several plates
          // (touching each other) share one blob, so fall back to the letter pattern
          f.vehicleType = platesHere.length === 1 ? (regions[i].aspect < 1.6 ? 'motorcycle' : 'car') : f.vehicleType;
          f.partial = regions[i].edge;
        }
        if (f.plate && !f.province && f.bbox) {
          const prov = await readProvinceBelow(worker, f._crop || crop, f.bbox, provinces);
          if (prov) { f.province = prov.province; f.note = ''; f.confidence = Math.round(Math.min(f.confidence / 0.7, 0.4 + 0.6 * prov.score) * 100) / 100; }
        }
        delete f.bbox; delete f.rawConf; delete f.trailing; delete f._crop;
        out.push(f);
      }
    }
    if (!out.some((r) => r.plate)) {
      // no plate-shaped region read: try the whole photo
      report(regions.length, regions.length + 1);
      const lines = await ocrCanvas(worker, gray, provinces, false);
      out.push(...vote(parseLines(lines, provinces)).map((f) => { delete f.bbox; delete f.rawConf; delete f.trailing; return f; }));
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

  window.LocalOCR = { readPlates, parseLines, norm, configure, findPlateRegions, toCanvas, localNormalize, binarize,
    cropRegion, estimateSkew, rotateCanvas, textBands, bandStrip, ocrBands, getWorker, vote, readCrop, splitColumn, estimateShear, shearCanvas, opts: () => ({ ...OPTS }) };
})();
