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

// Thai plate formats as issued by the DLT:
//   กข 1234   -> 1-2 Thai letters + 1-4 digits
//   1กข 1234  -> 1 leading digit + 2 Thai letters + 1-4 digits
// Never three letters, never more than four digits. Special/diplomatic plates
// with Latin letters are accepted loosely (1-3 letters + 1-4 digits).
export const THAI_PLATE_RE = /^(\d)?([ก-ฮ]{1,2})(\d{1,4})$/;
const LATIN_PLATE_RE = /^[A-Z]{1,3}\d{1,4}$/;

export function isPlausiblePlate(normalized) {
  if (typeof normalized !== 'string') return false;
  return THAI_PLATE_RE.test(normalized) || LATIN_PLATE_RE.test(normalized);
}
