// AI plate reading on the server. Two providers:
//   - Gemini (Google AI Studio, has a free tier without a card): GEMINI_API_KEY
//   - Claude (Anthropic, paid): ANTHROPIC_API_KEY
// If both keys are set, Claude is used. With neither, the browser falls back to
// on-device Tesseract and this module reports ocrEnabled = false.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import sharp from 'sharp';
import { PROVINCES, PROVINCE_SET } from './provinces.js';
import { cleanPlateDisplay, normalizePlate, isPlausiblePlate } from './plate.js';

const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
export const OCR_PROVIDER = ANTHROPIC_KEY ? 'anthropic' : GEMINI_KEY ? 'gemini' : null;
// For Gemini the model name is resolved against the live model list on first
// use (Google renames/retires models often); GEMINI_MODEL is a preference.
export const OCR_MODEL = OCR_PROVIDER === 'anthropic'
  ? (process.env.OCR_MODEL || 'claude-opus-5').trim()
  : (process.env.GEMINI_MODEL || 'auto').trim(); // 'auto' = newest flash model the key can use
let geminiModel = null; // resolved name, e.g. 'gemini-3.8-flash'
const geminiRetired = new Set(); // models that answered 404 ("no longer available")
export const ocrEnabled = OCR_PROVIDER != null;

const client = OCR_PROVIDER === 'anthropic' ? new Anthropic({ apiKey: ANTHROPIC_KEY, maxRetries: 1, timeout: 60_000 }) : null;

const PlateSchema = z.object({
  plates: z.array(
    z.object({
      plate: z.string().describe('ตัวอักษรและตัวเลขบนป้ายตามที่พิมพ์ เช่น "1กข 1234" ใช้เลขอารบิก ถ้าอ่านไม่ออกบางตัวให้ใส่ ? แทน'),
      province: z.string().describe('ชื่อจังหวัดที่พิมพ์บนป้าย สะกดเต็มแบบทางการ หรือ "" ถ้าไม่เห็น'),
      vehicle_type: z.enum(['car', 'motorcycle', 'other']).describe('car = ป้ายรถยนต์ (แนวยาว บรรทัดเดียว), motorcycle = ป้ายรถจักรยานยนต์ (ทรงเกือบสี่เหลี่ยมจัตุรัส สองบรรทัด)'),
      confidence: z.number().min(0).max(1).describe('ความมั่นใจในการอ่าน 0-1'),
      note: z.string().describe('หมายเหตุสั้น ๆ ถ้ามีตัวที่อ่านยาก เช่น "เลข 8 อาจเป็น 3" หรือ ""'),
    }),
  ),
});

// Same shape for Gemini's responseSchema (OpenAPI subset).
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    plates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          plate: { type: 'STRING', description: 'ตัวอักษรและตัวเลขบนป้ายตามที่พิมพ์ เช่น "1กข 1234" ใช้เลขอารบิก ถ้าอ่านไม่ออกบางตัวให้ใส่ ?' },
          province: { type: 'STRING', description: 'ชื่อจังหวัดที่พิมพ์บนป้าย สะกดเต็มแบบทางการ หรือ "" ถ้าไม่เห็น' },
          vehicle_type: { type: 'STRING', enum: ['car', 'motorcycle', 'other'] },
          confidence: { type: 'NUMBER', description: 'ความมั่นใจ 0-1' },
          note: { type: 'STRING', description: 'หมายเหตุสั้น ๆ หรือ ""' },
        },
        required: ['plate', 'province', 'vehicle_type', 'confidence', 'note'],
      },
    },
  },
  required: ['plates'],
};

const SYSTEM = `คุณเป็นระบบอ่านแผ่นป้ายทะเบียนรถของประเทศไทยจากรูปถ่าย เพื่อช่วยคืนป้ายที่หลุดหายจากน้ำท่วมให้เจ้าของ

รายงานทุกแผ่นป้ายที่เห็นในรูป (อาจมีหลายแผ่นวางซ้อนหรือเรียงกัน) หนึ่งรายการต่อหนึ่งแผ่น
- ป้ายไทยมักเป็น: [เลข 1 ตัว (ไม่บังคับ)][พยัญชนะไทย 1-4 ตัว] [ตัวเลข 1-4 หลัก] และชื่อจังหวัดด้านล่าง
- ถอดข้อความตามที่เห็นจริง ห้ามเดาเติมตัวอักษรที่มองไม่เห็น ใช้ ? แทนตัวที่อ่านไม่ออก
- ระวังตัวอักษรที่คล้ายกัน: ฎ/ฏ, ฌ/ญ/ณ, พ/ฟ/ผ, ข/ช/ซ, ค/ต, บ/ป, ด/ต, ภ/ก, ฐ/ฮ ให้ดูรายละเอียดหางและหัวของตัวอักษร
- แปลงเลขไทย (๑๒๓) เป็นเลขอารบิก
- จังหวัดต้องเป็นชื่อเต็มทางการหนึ่งใน: ${PROVINCES.join(', ')}
- ป้ายที่ถูกตัดขอบรูปจนอ่านไม่ครบ ให้ใส่ ? ในตำแหน่งที่ขาด
- ถ้าไม่มีป้ายทะเบียนในรูปเลย ให้คืน plates เป็น []`;

async function prepare(buffer) {
  const jpeg = await sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return jpeg.toString('base64');
}

function err(code, extra = {}) { return Object.assign(new Error(code), { code, ...extra }); }

/** Normalise whatever the model returned into the API shape. */
export function normalisePlates(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((p) => {
    const display = cleanPlateDisplay(String(p?.plate ?? '')).slice(0, 20);
    const provRaw = String(p?.province ?? '').trim();
    const province = PROVINCE_SET.has(provRaw) ? provRaw : '';
    const conf = Number(p?.confidence);
    const vt = ['car', 'motorcycle', 'other'].includes(p?.vehicle_type) ? p.vehicle_type : 'car';
    return {
      plate: display,
      province,
      vehicleType: vt,
      confidence: Number.isFinite(conf) ? Math.round(Math.min(1, Math.max(0, conf)) * 100) / 100 : 0.5,
      note: String(p?.note ?? '').slice(0, 120),
      plausible: isPlausiblePlate(normalizePlate(display)) && !display.includes('?'),
    };
  }).filter((p) => p.plate || p.province);
}

async function readWithAnthropic(b64) {
  const response = await client.messages.parse({
    model: OCR_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(PlateSchema), effort: 'medium' },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
      { type: 'text', text: 'อ่านป้ายทะเบียนทุกแผ่นในรูปนี้' },
    ] }],
  });
  if (response.stop_reason === 'refusal') throw err('ai_declined');
  if (!response.parsed_output) throw err('ocr_failed');
  return response.parsed_output.plates;
}

/** Extract the JSON text from a Gemini generateContent response. */
export function parseGeminiResponse(json) {
  const cand = json?.candidates?.[0];
  if (!cand) {
    if (json?.promptFeedback?.blockReason) throw err('ai_declined');
    throw err('ocr_failed');
  }
  if (cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) throw err('ai_declined');
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw err('ocr_failed'); }
  return parsed?.plates ?? [];
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Pick a usable Gemini model from the API's model list. Preference: the
 * configured name, then newer "flash" models, then anything that can
 * generateContent. Exported for tests.
 */
export function chooseGeminiModel(models, preferred, exclude = new Set()) {
  const usable = (models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((n) => n && !exclude.has(n) && !/embedding|imagen|veo|tts|audio|image-generation|live|thinking-exp|-exp-/i.test(n));
  if (!usable.length) return null;
  if (preferred && preferred !== 'auto' && usable.includes(preferred)) return preferred;
  const score = (n) => {
    const ver = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    let s = ver * 100;
    if (/flash/.test(n)) s += 30; else if (/pro/.test(n)) s += 10;
    if (/lite/.test(n)) s -= 5;
    if (/preview|exp/.test(n)) s -= 8;
    if (/latest/.test(n)) s += 1;
    if (/-\d{3,}$/.test(n)) s -= 2; // dated snapshots after their alias
    return s;
  };
  return usable.sort((a, b) => score(b) - score(a))[0];
}

async function resolveGeminiModel(force = false) {
  if (geminiModel && !force) return geminiModel;
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': GEMINI_KEY } });
  } catch (e) {
    throw err('ocr_failed', { detail: 'models list: ' + e?.message });
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) throw err('ocr_config', { detail: 'models list http_' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200) });
  if (!res.ok) throw err('ocr_failed', { detail: 'models list http_' + res.status });
  const json = await res.json();
  const chosen = chooseGeminiModel(json.models, OCR_MODEL, geminiRetired);
  if (!chosen) throw err('ocr_config', { detail: 'no Gemini model supports generateContent for this key' });
  const names = (json.models || []).map((m) => String(m.name).replace(/^models\//, '')).filter((n) => /gemini/.test(n));
  console.log(`gemini: using ${chosen}${OCR_MODEL !== 'auto' && chosen !== OCR_MODEL ? ` ("${OCR_MODEL}" not usable)` : ''} (available: ${names.slice(0, 20).join(', ')})`);
  geminiModel = chosen;
  return chosen;
}

async function readWithGemini(b64, retry = true) {
  const model = await resolveGeminiModel();
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'image/jpeg', data: b64 } },
      { text: 'อ่านป้ายทะเบียนทุกแผ่นในรูปนี้' },
    ] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, temperature: 0.1 },
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY }, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw err('ocr_failed', { detail: e?.message });
  } finally {
    clearTimeout(t);
  }
  if (res.status === 429) throw err('ocr_quota');
  if (res.status === 404 && retry) {
    // Retired model. Google's message usually names the replacement
    // ("Please update your code to use models/gemini-3.8-flash"): take it.
    const text = await res.text().catch(() => '');
    geminiRetired.add(model);
    const hinted = (text.match(/use models\/([\w.-]+)/) || [])[1];
    if (hinted && !geminiRetired.has(hinted)) {
      console.warn(`gemini: ${model} retired, switching to suggested ${hinted}`);
      geminiModel = hinted;
    } else {
      console.warn(`gemini: ${model} returned 404, re-resolving model list`);
      await resolveGeminiModel(true);
    }
    return readWithGemini(b64, false);
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) throw err('ocr_config', { detail: (await res.text().catch(() => '')).slice(0, 300) });
  if (!res.ok) throw err('ocr_failed', { detail: `http_${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}` });
  return parseGeminiResponse(await res.json());
}

/**
 * @param {Buffer} buffer original upload
 * @returns {Promise<{plates: Array, model: string, provider: string}>}
 */
export async function readPlates(buffer) {
  if (!ocrEnabled) throw err('ocr_disabled');
  const b64 = await prepare(buffer);
  const raw = OCR_PROVIDER === 'anthropic' ? await readWithAnthropic(b64) : await readWithGemini(b64);
  return { plates: normalisePlates(raw), model: OCR_PROVIDER === 'gemini' ? geminiModel : OCR_MODEL, provider: OCR_PROVIDER };
}
