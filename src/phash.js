// Perceptual "difference hash" (dHash) so re-submitting the same photo, even
// re-encoded or resized, is detected. 64-bit hash as 16 hex chars.
import sharp from 'sharp';

export async function dhash(buffer) {
  const { data } = await sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += data[y * 9 + x] < data[y * 9 + x + 1] ? '1' : '0';
    }
  }
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}

export function hamming(aHex, bHex) {
  let x = BigInt('0x' + aHex) ^ BigInt('0x' + bHex);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
