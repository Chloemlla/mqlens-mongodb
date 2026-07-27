import { describe, it, expect } from 'vitest';
import { ObjectId, Long, Decimal128 } from 'bson';
import { copyValueToText } from '../copyValue';

describe('copyValueToText', () => {
  it('copies an ObjectId as its hex string', () => {
    expect(copyValueToText(new ObjectId('507f1f77bcf86cd799439011'))).toBe('507f1f77bcf86cd799439011');
    expect(copyValueToText({ $oid: '507f1f77bcf86cd799439011' })).toBe('507f1f77bcf86cd799439011');
  });

  it('copies a Date as an ISO-8601 string', () => {
    expect(copyValueToText(new Date('2026-06-02T03:45:55.902Z'))).toBe('2026-06-02T03:45:55.902Z');
    expect(copyValueToText({ $date: '2026-06-02T03:45:55.902Z' })).toBe('2026-06-02T03:45:55.902Z');
    expect(copyValueToText({ $date: { $numberLong: '1780371955902' } })).toBe('2026-06-02T03:45:55.902Z');
  });

  it('copies numeric BSON wrappers as their plain number', () => {
    expect(copyValueToText(Long.fromString('9007199254740993'))).toBe('9007199254740993');
    expect(copyValueToText({ $numberLong: '9007199254740993' })).toBe('9007199254740993');
    expect(copyValueToText(Decimal128.fromString('12.50'))).toBe('12.50');
    expect(copyValueToText({ $numberDecimal: '12.50' })).toBe('12.50');
  });

  it('passes plain scalars through as strings', () => {
    expect(copyValueToText('Alice')).toBe('Alice');
    expect(copyValueToText(42)).toBe('42');
    expect(copyValueToText(true)).toBe('true');
    expect(copyValueToText(null)).toBe('');
    expect(copyValueToText(undefined)).toBe('');
  });

  it('falls back to EJSON for nested objects/arrays', () => {
    expect(copyValueToText({ a: 1, b: [1, 2] })).toContain('"a"');
    expect(copyValueToText([1, 2, 3])).toBe('[1,2,3]');
  });
});
