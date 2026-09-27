// AI plate reading. Sends a downscaled copy of the photo to Claude and asks for
// every license plate visible, as structured JSON. Disabled unless
// ANTHROPIC_API_KEY is set; the frontend hides the feature in that case.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import sharp from 'sharp';
import { PROVINCES, PROVINCE_SET } from './provinces.js';
import { cleanPlateDisplay, normalizePlate, isPlausiblePlate } from './plate.js';

const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
export const OCR_MODEL = (process.env.OCR_MODEL || 'claude-opus-5').trim();
export const ocrEnabled = API_KEY.length > 0;

const client = ocrEnabled ? new Anthropic({ apiKey: API_KEY, maxRetries: 1, timeout: 60_000 }) : null;

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

const SYSTEM = `คุณเป็นระบบอ่านแผ่นป้ายทะเบียนรถของประเทศไทยจากรูปถ่าย เพื่อช่วยคืนป้ายที่หลุดหายจากน้ำท่วมให้เจ้าของ

รายงานทุกแผ่นป้ายที่เห็นในรูป (อาจมีหลายแผ่นวางซ้อนหรือเรียงกัน) หนึ่งรายการต่อหนึ่งแผ่น
- ป้ายไทยมักเป็น: [เลข 1 ตัว (ไม่บังคับ)][พยัญชนะไทย 2 ตัว] [ตัวเลข 1-4 หลัก] และชื่อจังหวัดด้านล่าง
- ถอดข้อความตามที่เห็นจริง ห้ามเดาเติมตัวอักษรที่มองไม่เห็น ใช้ ? แทนตัวที่อ่านไม่ออก
- แปลงเลขไทย (๑๒๓) เป็นเลขอารบิก
- จังหวัดต้องเป็นชื่อเต็มทางการหนึ่งใน: ${PROVINCES.join(', ')}
- ถ้าไม่มีป้ายทะเบียนในรูปเลย ให้คืน plates เป็น [] `;

/**
 * @param {Buffer} buffer original upload
 * @returns {Promise<{plates: Array, model: string}>}
 */
export async function readPlates(buffer) {
  if (!client) throw Object.assign(new Error('ocr_disabled'), { code: 'ocr_disabled' });

  const jpeg = await sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  const response = await client.messages.parse({
    model: OCR_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(PlateSchema), effort: 'medium' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: 'อ่านป้ายทะเบียนทุกแผ่นในรูปนี้' },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw Object.assign(new Error('ai_declined'), { code: 'ai_declined' });
  const parsed = response.parsed_output;
  if (!parsed) throw Object.assign(new Error('ocr_failed'), { code: 'ocr_failed' });

  const plates = parsed.plates.slice(0, 20).map((p) => {
    const display = cleanPlateDisplay(p.plate).slice(0, 20);
    const province = PROVINCE_SET.has(p.province.trim()) ? p.province.trim() : '';
    return {
      plate: display,
      province,
      vehicleType: p.vehicle_type,
      confidence: Math.round(p.confidence * 100) / 100,
      note: p.note.slice(0, 120),
      plausible: isPlausiblePlate(normalizePlate(display)) && !display.includes('?'),
    };
  });
  return { plates, model: OCR_MODEL };
}
