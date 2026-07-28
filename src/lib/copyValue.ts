import { EJSON, ObjectId, Long, Decimal128, Int32, Double } from 'bson';

// Text placed on the clipboard by the grid's "Copy value" action. ObjectId and
// Date (and the numeric BSON types) copy as their raw scalar — the hex string,
// an ISO-8601 date, a plain number — instead of the EJSON wrapper
// ({"$oid":…} / {"$date":{"$numberLong":…}}), so the value pastes cleanly into a
// query or document. Mirrors renderColoredCell so "copy" matches what's shown,
// and handles both real BSON instances (tree / JSON views) and the canonical
// plain shapes the backend sends (table view). Nested objects/arrays fall back
// to EJSON.
export function copyValueToText(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);

  // Real BSON instances (tree / JSON views parse documents into these).
  if (v instanceof ObjectId) return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Long || v instanceof Decimal128 || v instanceof Int32 || v instanceof Double) {
    return v.toString();
  }

  // Canonical extended-JSON shapes (table view uses the raw backend documents).
  if (typeof v.$oid === 'string') return v.$oid;
  if (v.$date !== undefined) {
    if (typeof v.$date === 'string') return v.$date;
    if (v.$date?.$numberLong) return new Date(Number(v.$date.$numberLong)).toISOString();
  }
  if (v.$numberLong !== undefined) return String(v.$numberLong);
  if (v.$numberDecimal !== undefined) return String(v.$numberDecimal);
  if (v.$numberInt !== undefined) return String(v.$numberInt);
  if (v.$numberDouble !== undefined) return String(v.$numberDouble);

  try {
    return EJSON.stringify(v);
  } catch {
    return JSON.stringify(v);
  }
}
