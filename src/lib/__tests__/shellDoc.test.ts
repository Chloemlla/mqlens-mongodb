import { describe, it, expect } from 'vitest';
import { ObjectId, Long, Decimal128, Int32 } from 'bson';
import { docToShell, shellToEjson, parseShellJson } from '../shellDoc';

describe('docToShell', () => {
  it('renders EJSON-shaped values as shell constructors', () => {
    const out = docToShell({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      seats: 3,
      createdAt: { $date: '2025-01-04T00:00:00.000Z' },
      big: { $numberLong: '9007199254740993' },
      price: { $numberDecimal: '12.50' },
      n: { $numberInt: '7' },
      name: 'Acme',
    });
    expect(out).toContain('"_id": ObjectId("507f1f77bcf86cd799439011")');
    expect(out).toContain('"createdAt": ISODate("2025-01-04T00:00:00.000Z")');
    expect(out).toContain('"big": NumberLong("9007199254740993")');
    expect(out).toContain('"price": NumberDecimal("12.50")');
    expect(out).toContain('"n": NumberInt(7)');
    expect(out).toContain('"name": "Acme"');
  });

  it('renders canonical $date ($numberLong) as ISODate', () => {
    expect(docToShell({ d: { $date: { $numberLong: '1735948800000' } } })).toContain('ISODate("2025-01-04T00:00:00.000Z")');
  });

  it('renders BSON instances', () => {
    expect(docToShell(new ObjectId('507f1f77bcf86cd799439011'))).toBe('ObjectId("507f1f77bcf86cd799439011")');
    expect(docToShell(Long.fromString('42'))).toBe('NumberLong("42")');
    expect(docToShell(Decimal128.fromString('1.5'))).toBe('NumberDecimal("1.5")');
    expect(docToShell(new Int32(9))).toBe('NumberInt(9)');
  });
});

describe('shellToEjson', () => {
  it('converts shell constructors back to Extended JSON', () => {
    const shell = '{\n  "_id": ObjectId("507f1f77bcf86cd799439011"),\n  "createdAt": ISODate("2025-01-04T00:00:00.000Z"),\n  "big": NumberLong("42"),\n  "price": NumberDecimal("12.50"),\n  "n": NumberInt(7)\n}';
    const parsed = JSON.parse(shellToEjson(shell));
    expect(parsed._id).toEqual({ $oid: '507f1f77bcf86cd799439011' });
    expect(parsed.createdAt).toEqual({ $date: '2025-01-04T00:00:00.000Z' });
    expect(parsed.big).toEqual({ $numberLong: '42' });
    expect(parsed.price).toEqual({ $numberDecimal: '12.50' });
    expect(parsed.n).toEqual({ $numberInt: '7' });
  });

  it('leaves plain JSON untouched', () => {
    expect(shellToEjson('{"name":"Ada"}')).toBe('{"name":"Ada"}');
  });

  it('does not mangle constructor-like text inside string values', () => {
    const parsed = JSON.parse(shellToEjson('{ "note": "run ISODate(now) please" }'));
    expect(parsed.note).toBe('run ISODate(now) please');
  });

  it('round-trips docToShell -> shellToEjson', () => {
    const doc = { _id: { $oid: '507f1f77bcf86cd799439011' }, when: { $date: '2025-01-04T00:00:00.000Z' }, tags: ['a', 'b'] };
    expect(JSON.parse(shellToEjson(docToShell(doc)))).toEqual(doc);
  });
});

describe('parseShellJson', () => {
  it('parses plain JSON', () => {
    expect(parseShellJson('{"a": 1}')).toEqual({ a: 1 });
  });
  it('parses shell constructors into EJSON shapes', () => {
    expect(parseShellJson('{"_id": ObjectId("507f1f77bcf86cd799439011")}'))
      .toEqual({ _id: { $oid: '507f1f77bcf86cd799439011' } });
    // EJSON.serialize normalizes the date string (same instant); .000 is dropped.
    expect(parseShellJson('{"when": {"$gte": ISODate("2025-01-04T00:00:00.000Z")}}'))
      .toEqual({ when: { $gte: { $date: '2025-01-04T00:00:00Z' } } });
  });
  it('leaves EJSON wrappers untouched', () => {
    expect(parseShellJson('{"_id": {"$oid": "507f1f77bcf86cd799439011"}}'))
      .toEqual({ _id: { $oid: '507f1f77bcf86cd799439011' } });
  });
  it('does not convert constructor-like text inside strings', () => {
    expect(parseShellJson('{"note": "ObjectId(fake)"}')).toEqual({ note: 'ObjectId(fake)' });
  });
  it('throws on invalid input', () => {
    expect(() => parseShellJson('{nope')).toThrow();
  });
});

describe('parseShellJson — relaxed shell-style input (#216)', () => {
  it('accepts unquoted keys', () => {
    expect(parseShellJson('{ createdAt: 1 }')).toEqual({ createdAt: 1 });
  });
  it('accepts single-quoted keys and string values', () => {
    expect(parseShellJson("{ 'name': 'Ada' }")).toEqual({ name: 'Ada' });
  });
  it('accepts a trailing comma', () => {
    expect(parseShellJson('{ status: "active", }')).toEqual({ status: 'active' });
  });
  it('accepts unquoted operator keys', () => {
    expect(parseShellJson('{ age: { $gte: 18 } }')).toEqual({ age: { $gte: 18 } });
  });
  it('combines unquoted keys with shell constructors', () => {
    expect(parseShellJson('{ _id: ObjectId("507f1f77bcf86cd799439011") }'))
      .toEqual({ _id: { $oid: '507f1f77bcf86cd799439011' } });
  });
  it('still supports quoted keys for dotted paths', () => {
    expect(parseShellJson('{ "user.age": { $gt: 21 } }')).toEqual({ 'user.age': { $gt: 21 } });
  });
  it('still throws on genuinely malformed input', () => {
    expect(() => parseShellJson('{ oops ')).toThrow();
  });
  it('accepts braceless field:value input (auto-wrapped)', () => {
    expect(parseShellJson('datacenterId: "METROPOLITAN_DC"')).toEqual({ datacenterId: 'METROPOLITAN_DC' });
  });
  it('accepts a braceless multi-field filter', () => {
    expect(parseShellJson('a: 1, b: 2')).toEqual({ a: 1, b: 2 });
  });
  it('evaluates safe arithmetic expressions (Compass loose mode)', () => {
    expect(parseShellJson('{ limit: 2 * 3 }')).toEqual({ limit: 6 });
  });
  it('throws on an incomplete query (parser returns its empty-string sentinel)', () => {
    // mongodb-query-parser returns '' for unparseable input instead of throwing;
    // parseShellJson must surface that as an error so validation/Run reject it.
    expect(() => parseShellJson('{ _id }')).toThrow();
    expect(() => parseShellJson('type: "DEV", _id')).toThrow();
    expect(() => parseShellJson('{ a: 1, b }')).toThrow();
  });
});
