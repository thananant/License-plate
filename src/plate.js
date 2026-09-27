// Plate normalisation so that "กข 1234", "กข-1234" and "กข1234" all match.

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

/**
 * Normalise a plate string for storage/search:
 *  - trim, collapse whitespace
 *  - convert Thai numerals to Arabic numerals
 *  - remove spaces, dashes, dots
 *  - keep only Thai letters, Latin letters (upper-cased) and digits
 */
export function normalizePlate(input) {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFC').trim();
  s = s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
  s = s.toUpperCase();
  // Strip everything except Thai block, A-Z, 0-9
  s = s.replace(/[^฀-๿A-Z0-9]/g, '');
  return s;
}

/**
 * Display-friendly cleanup: trims and collapses internal whitespace but keeps
 * the user's spacing so "1กข 1234" stays readable.
 */
export function cleanPlateDisplay(input) {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  s = s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
  return s;
}

export function isPlausiblePlate(normalized) {
  // Thai plates: 1-3 Thai letters (optionally preceded by a digit) + 1-4 digits.
  // Also accept diplomatic / other formats loosely: 2-12 chars, must contain a digit.
  if (normalized.length < 2 || normalized.length > 12) return false;
  return /[0-9]/.test(normalized);
}
